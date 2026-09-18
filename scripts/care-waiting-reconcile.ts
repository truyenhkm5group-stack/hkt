/**
 * ĐỐI CHIẾU CÁC CA CHĂM SÓC "ĐANG CHỜ" MÀ KHÔNG CÓ MỐC XEM LẠI.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/care-waiting-reconcile.ts           # CHẠY THỬ
 *   npx tsx --tsconfig tsconfig.json scripts/care-waiting-reconcile.ts --apply   # ghi thật
 *
 * ─── VÌ SAO CÓ TỆP NÀY ───
 *
 * Trước bản vá, màn hình cho phép đẩy một ca sang `WAITING_*` mà KHÔNG chọn giờ xem lại. Đo
 * production 16/09/2026: 9 ca đang mở ở trạng thái chờ với `follow_up_at` NULL, tất cả do người
 * bấm trong hai ngày 12–13/09 và không ai động lại từ đó. Đo lại 18/09/2026 03:39Z: còn 8 ca (một
 * ca đã tự chốt, xem dưới) và KHÔNG có ca mới nào — 6 đợt chờ sinh ra trong hai ngày đó đều có mốc
 * xem lại. Bản vá ở bản đang chạy (594f9d7) đang giữ đúng phần của nó; 8 ca này là lịch sử.
 *
 * ─── MÁY CHỐT ĐƯỢC TỚI ĐÂU, VÀ VÌ SAO KHÔNG TỚI ĐƯỢC 8 CA NÀY ───
 *
 * Máy KHÔNG bỏ sót vĩnh viễn: khi một SỰ KIỆN KẾT THÚC tới (kiện sang `RETURNED`/`DELIVERED`),
 * `applyCarrierEventToCare` chốt kết quả lên đúng đợt đó dù đợt đã đóng. Đó là chuyện đã xảy ra
 * thật với PKE1517089434 — 16/09 07:54 `SYSTEM` chốt `RESCUE_FAILED` khi kiện sang `RETURNED`, nên
 * ca ấy KHÔNG có trong kế hoạch dưới đây.
 *
 * Nhưng trong lúc kiện còn ở chặng `RETURNING` (đang trên đường về, chưa về tới), không lượt đối
 * chiếu nào chạm tới chúng: `reconcileCareCoverage` bước (b)/(c) chỉ xét đợt `care_outcome =
 * 'PENDING'`, mà cả 8 đợt này mang `NULL` (đợt lịch sử trước 0075, cố ý không suy ngược); nó còn
 * bỏ qua thẳng `stage = 'RETURNING'` và mọi đợt người đã chạm vào. Nên chúng nằm ở trạng thái
 * "chờ khách" trong khi không còn khách nào để chờ, và sẽ nằm như vậy tới khi kiện về tới kho.
 * Nhãn sai nhiều ngày trên hàng đợi là thứ tệp này sửa — bằng nghiệp vụ, không bằng `UPDATE`.
 *
 * ─── HAI ĐIỀU TỆP NÀY KHÔNG LÀM ───
 *
 *  · KHÔNG `UPDATE` thẳng bảng. Mọi thay đổi đi qua `setCareStatus()` của chính miền nghiệp vụ, nên
 *    mỗi ca có một dòng `care_case_events` (ai · lúc nào · từ trạng thái nào sang trạng thái nào ·
 *    ảnh chụp SLA) và một dòng nhật ký `audit`.
 *  · KHÔNG gửi lệnh nào sang Viettel Post. Duyệt hoàn / phát lại là quyết định tiền của chủ shop —
 *    tệp này chỉ đưa ca về đúng hàng đợi kèm hạn và việc phải làm, để NGƯỜI bấm.
 *
 * ─── AN TOÀN KHI CHẠY LẠI ───
 *
 * Mỗi mục khai bối cảnh mà quyết định dựa vào (`fromStatus`, `stages`). Trước khi ghi, tệp đọc lại
 * dòng thật: lệch một điều kiện là BỎ QUA và nói rõ vì sao. Chạy lần hai không ghi gì, vì
 * `follow_up_at` không còn NULL.
 */
import "dotenv/config";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { setCareStatus, type CareActor } from "@/lib/care/service";
import { CARE_WAITING_STATUSES, type CareStatus } from "@/lib/constants/care";

/** MÁY làm, không phải người — `id: null` có nghĩa rõ ràng (luật 34), khác hẳn "chưa biết ai". */
const ACTOR: CareActor = { id: null, email: "ops:care-waiting-reconcile", source: "SYSTEM" };

const GIO = 3_600_000;

type Nhom = "C_CHO_DVVC" | "E_HET_VIEC_CHAM_SOC";

type KeHoach = {
  tracking: string;
  nhom: Nhom;
  /** Trạng thái ca PHẢI đang ở — căn cứ mà quyết định dưới đây dựa vào. */
  fromStatus: CareStatus;
  /** Chặng ĐVVC hợp lệ tại thời điểm dựng kế hoạch. Kiện đã đi tiếp ⇒ bỏ qua, người xem lại. */
  stages: string[];
  /** Đích: `RESOLVED` (rời hàng đợi) hoặc một trạng thái chờ kèm hạn. */
  toStatus: CareStatus;
  /** Số giờ tới hạn xem lại. Bỏ trống với ca đóng. */
  hetHanSauGio?: number;
  /** Mức ưu tiên mong muốn — hàng đợi /work TỰ TÍNH điểm, đây là ghi chú cho người đọc nhật ký. */
  uuTien: "P0" | "P1" | "P2" | "-";
  /** Việc phải làm tiếp, ghi vào note của ca. Chứng cứ đi kèm để người sau không phải tra lại. */
  note: string;
};

/**
 * TÁM CA, ĐỌC LẠI `shipment_events` NGÀY 18/09/2026 03:40Z.
 *
 * Bản phân loại đầu (16/09) có bốn nhóm: 4 ca "ĐVVC đã mang hàng về", 3 ca "khách từ chối, hàng
 * còn tồn ở bưu cục — ứng viên duyệt hoàn", 1 ca "giục bưu cục", 1 ca "còn cứu được". Hai ngày sau,
 * BẢY ca đã có sự kiện `502` chiều `RETURN` rồi "Đóng bảng kê đi": ĐVVC tự chuyển hoàn hết. Ba ca
 * "ứng viên duyệt hoàn" không còn gì để duyệt, và ca "giục bưu cục" đã tự đi. Ghi lại ở đây vì đó
 * là một số đo chứ không phải một nhận xét: chậm hai ngày ở nhóm đó là mất hai ngày cơ hội can
 * thiệp, và kết cục do ĐVVC quyết chứ không do shop.
 *
 * Bảy ca cùng đích `RESOLVED` vẫn là bảy lời gọi riêng với bảy câu chứng cứ riêng — không có lối
 * "đóng cả mẻ".
 */
const KE_HOACH: KeHoach[] = [
  /* ── E · ĐVVC ĐANG MANG HÀNG VỀ SHOP: không còn khách nào để chăm ─────────────────────────── */
  {
    tracking: "PKE1515084738",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_CUSTOMER",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 18/09: khách từ chối ba lần (13/09, 15/09, 16/09), rồi 17/09 04:10 VTP 502 chiều " +
      "RETURN 'Khách từ chối nhận' và 17/09 10:45 đã đóng bảng kê đi. Hàng đang về shop — hết việc " +
      "chăm sóc, đóng ca. ĐÓNG = RỜI HÀNG ĐỢI, không phải kết luận cứu đơn: kết quả vẫn chờ chứng " +
      "từ ĐVVC chốt lên đúng đợt này.",
  },
  {
    tracking: "PKE1517089550",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_CUSTOMER",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 18/09: khách hẹn phát lại hai lần (12/09, 13/09) rồi đổi ý, 17/09 08:02 VTP 502 " +
      "chiều RETURN 'Không có nhu cầu nhận hàng' kèm ghi chú 'Khách từ chối nhận - Sai thông tin " +
      "đơn', 17/09 10:24 đóng bảng kê đi. Hàng đang về shop — hết việc chăm sóc. Kết quả cứu đơn " +
      "để chứng từ ĐVVC chốt.",
  },
  {
    tracking: "PKE1515019044",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 18/09: 15/09 02:04 VTP 505 'Khách từ chối nhận - Không hài lòng về sản phẩm' rồi " +
      "502 chiều RETURN; 17/09 09:22–09:23 nhận bảng kê đến và đóng bảng kê đi — kiện đang chạy " +
      "trên chiều hoàn. Hết việc chăm sóc. Kết quả cứu đơn để chứng từ ĐVVC chốt.",
  },
  {
    tracking: "PKE1515065610",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 18/09: shop yêu cầu chuyển hoàn từ 13/09, kiện tồn ở bưu cục Vĩnh Long tới 16/09 " +
      "('Không liên lạc được khách hàng nhận'), rồi 17/09 01:09 VTP 502 chiều RETURN và 17/09 09:37 " +
      "đóng bảng kê đi. Việc giục bưu cục đã hết ý nghĩa — hàng đang về. Đóng ca; kết quả cứu đơn " +
      "để chứng từ ĐVVC chốt.",
  },
  {
    tracking: "PKE1517664544",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 18/09: 14/09 khách yêu cầu hoàn về, bưu cục duyệt hoàn, 15/09 00:16 chuyển hoàn " +
      "bưu cục gốc, 17/09 07:37 đóng bảng kê đi. Khách chủ động yêu cầu hoàn và hàng đang về — hết " +
      "việc chăm sóc. Kết quả cứu đơn để chứng từ ĐVVC chốt.",
  },
  {
    tracking: "PKE1517808316",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 18/09: sau lần hẹn phát lại 13/09 và một lượt sửa địa chỉ chuyển tiếp, 16/09 01:53 " +
      "VTP 502 chiều RETURN 'Người gửi yêu cầu chuyển hoàn', 16/09 12:32 đóng bảng kê đi. Chính shop " +
      "đã yêu cầu hoàn và hàng đang về — hết việc chăm sóc. Kết quả cứu đơn để chứng từ ĐVVC chốt.",
  },
  {
    tracking: "PKE1517808418",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 18/09: nhãn 'Chờ phát lại' đã sai từ 15/09 (shop yêu cầu chuyển hoàn), 16/09 11:13 " +
      "VTP 502 chiều RETURN 'Khách từ chối nhận - Không có nhu cầu nhận hàng', 17/09 03:13 đóng bảng " +
      "kê đi. Không ai đang chờ một lượt phát lại nào — hàng đang về shop. Đóng ca; kết quả cứu đơn " +
      "để chứng từ ĐVVC chốt.",
  },

  /* ── C · KIỆN IM LẶNG BỐN NGÀY: phải đi hỏi ĐVVC nó đang ở đâu ───────────────────────────── */
  {
    tracking: "PKE1517808393",
    nhom: "C_CHO_DVVC",
    fromStatus: "WAITING_CUSTOMER",
    stages: ["PENDING", "DELIVERY_FAILED", "IN_TRANSIT", "OUT_FOR_DELIVERY"],
    toStatus: "WAITING_CARRIER",
    hetHanSauGio: 4,
    uuTien: "P0",
    note:
      "P0 · HỎI BƯU CỤC HÔM NAY RỒI GỌI KHÁCH. 11/09 VTP 507 'Khách hàng đến bưu cục nhận' — khách TỰ hẹn ra " +
      "lấy, CHƯA từ chối lần nào. 14/09 17:00 VTP 505 'Quá thời gian hẹn nhận' tại bưu cục Giảng Võ (HNI/GLM), " +
      "rồi im lặng 3,4 ngày trong khi bảy kiện cùng nhóm đã hoàn xong — ERP KHÔNG BIẾT kiện đang ở đâu, " +
      "và im lặng không phải bằng chứng 'vẫn ổn'. Việc: gọi bưu cục xác minh kiện còn ở đó; còn thì " +
      "gọi khách chốt nhận và xin phát lại. Kiện DUY NHẤT trong tám ca còn cơ hội giao (499K)."
  },
];

const NHAN_NHOM: Record<Nhom, string> = {
  C_CHO_DVVC: "C · kiện im lặng, phải hỏi bưu cục — còn cơ hội giao",
  E_HET_VIEC_CHAM_SOC: "E · ĐVVC đang mang hàng về — hết việc chăm sóc, đóng ca",
};

/** MỆNH ĐỀ LỖI — một chỗ khai, dùng cho cả ảnh chụp trước lẫn ảnh chụp sau. */
function khongCoMocXemLai(c: { careStatus: string; followUpAt: Date | null }): boolean {
  return CARE_WAITING_STATUSES.includes(c.careStatus as CareStatus) && c.followUpAt === null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();
  const now = new Date();

  console.log(`\n═══ ĐỐI CHIẾU CA CHĂM SÓC "ĐANG CHỜ" KHÔNG CÓ MỐC XEM LẠI ═══`);
  console.log(`${apply ? "GHI THẬT" : "CHẠY THỬ (thêm --apply để ghi)"} · ${now.toISOString()}\n`);

  /* Ảnh chụp TRƯỚC: đếm bằng đúng mệnh đề mà báo cáo sẽ kiểm lại sau khi chạy. */
  const dangMoTruoc = await db.query.shipmentCare.findMany({ where: eq(schema.shipmentCare.active, true) });
  const loiTruoc = dangMoTruoc.filter(khongCoMocXemLai);
  console.log(`Ca đang mở: ${dangMoTruoc.length} · trong đó CHỜ mà không có mốc xem lại: ${loiTruoc.length}\n`);

  let daGhi = 0;
  let boQua = 0;

  for (const kh of KE_HOACH) {
    const [s] = await db
      .select({ id: schema.shipments.id, stage: schema.shipments.stage })
      .from(schema.shipments)
      .where(eq(schema.shipments.vtpOrderNumber, kh.tracking))
      .limit(1);
    const nhan = `${kh.tracking} [${kh.nhom}]`;
    if (!s) {
      console.log(`  BỎ QUA  ${nhan} — không tìm thấy vận đơn`);
      boQua += 1;
      continue;
    }
    const ca = await db.query.shipmentCare.findFirst({
      where: eq(schema.shipmentCare.shipmentId, s.id),
      orderBy: [desc(schema.shipmentCare.episodeNo)],
    });

    /* BA CỬA KIỂM — lệch một cái là thực tế đã đi khác lúc dựng kế hoạch, người phải xem lại. */
    if (!ca || !ca.active) {
      console.log(`  BỎ QUA  ${nhan} — không còn đợt nào đang mở`);
      boQua += 1;
      continue;
    }
    if (ca.careStatus !== kh.fromStatus || ca.followUpAt !== null) {
      console.log(`  BỎ QUA  ${nhan} — ca đã đổi: ${ca.careStatus}, hẹn ${ca.followUpAt?.toISOString() ?? "NULL"} (kế hoạch dựng cho ${kh.fromStatus} + hẹn NULL)`);
      boQua += 1;
      continue;
    }
    if (!kh.stages.includes(s.stage)) {
      console.log(`  BỎ QUA  ${nhan} — chặng ĐVVC nay là ${s.stage}, ngoài ${kh.stages.join("/")} mà quyết định dựa vào`);
      boQua += 1;
      continue;
    }

    const followUpAt = kh.hetHanSauGio === undefined ? undefined : new Date(now.getTime() + kh.hetHanSauGio * GIO);
    const dich = `${kh.fromStatus} → ${kh.toStatus}${followUpAt ? ` · hẹn ${followUpAt.toISOString()}` : ""}`;
    if (!apply) {
      console.log(`  SẼ GHI  ${nhan} ${dich} · ${kh.uuTien}`);
      daGhi += 1;
      continue;
    }
    const kq = await setCareStatus(ACTOR, { shipmentIds: [s.id], status: kh.toStatus, note: kh.note, followUpAt });
    if ("error" in kq) {
      console.log(`  LỖI     ${nhan} — ${kq.error}`);
      boQua += 1;
      continue;
    }
    if (kq.data.skipped.length) {
      console.log(`  BỎ QUA  ${nhan} — ${kq.data.skipped[0]?.reason}`);
      boQua += 1;
      continue;
    }
    console.log(`  ĐÃ GHI  ${nhan} ${dich} · ${kh.uuTien}`);
    daGhi += 1;
  }

  /* Ảnh chụp SAU: cùng mệnh đề với ảnh chụp trước, không phải một câu hỏi khác. */
  const loiSau = (await db.query.shipmentCare.findMany({ where: eq(schema.shipmentCare.active, true) })).filter(khongCoMocXemLai);

  console.log(`\n═══ TỔNG HỢP ═══`);
  for (const n of Object.keys(NHAN_NHOM) as Nhom[]) {
    const ds = KE_HOACH.filter((k) => k.nhom === n);
    if (ds.length) console.log(`  ${String(ds.length).padStart(2)}  ${NHAN_NHOM[n]}`);
  }
  console.log(`  ${apply ? "Đã ghi" : "Sẽ ghi"}: ${daGhi} · bỏ qua: ${boQua}`);
  console.log(`  CHỜ mà không có mốc xem lại: ${loiTruoc.length} → ${loiSau.length}`);
  if (loiSau.length) {
    for (const c of loiSau) console.log(`    còn lại: ${c.id} · ${c.careStatus}`);
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
