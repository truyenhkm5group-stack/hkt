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
 * bấm trong hai ngày 12–13/09 và không ai động lại từ đó. Bản vá chặn đường sinh ra ca mới; 9 ca
 * lịch sử này phải được xử lý bằng NGHIỆP VỤ, không bằng một câu `UPDATE`.
 *
 * Máy KHÔNG tự đóng được chúng: `reconcileCareCoverage` chỉ chạm ca `care_outcome = 'PENDING'`,
 * còn cả 9 ca này mang `NULL` (ca lịch sử trước 0075, cố ý không suy ngược), và nó cũng bỏ qua mọi
 * ca người đã chạm vào lẫn mọi kiện đang ở chặng `RETURNING`.
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

type Nhom = "A_CUU_DUOC" | "C_CHO_DVVC" | "D_KHACH_TU_CHOI" | "E_HET_VIEC_CHAM_SOC";

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
 * CHÍN CA, MỖI CA MỘT QUYẾT ĐỊNH RIÊNG dựng từ lịch sử `shipment_events` đọc ngày 16/09/2026.
 * Bốn ca cùng đích `RESOLVED` vẫn là bốn lời gọi riêng với bốn câu lý do riêng — không có lối
 * "đóng cả mẻ".
 */
const KE_HOACH: KeHoach[] = [
  /* ── E · ĐVVC ĐANG MANG HÀNG VỀ SHOP: không còn khách nào để chăm ─────────────────────────── */
  {
    tracking: "PKE1517089434",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_CUSTOMER",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 16/09: VTP 505 ngày 14/09 'Không hài lòng về sản phẩm', tới 15/09 23:48 chuyển 'Đang chuyển hoàn'. " +
      "Hàng đã trên chiều hoàn về shop nên không còn khách để gọi — đóng ca chăm sóc. ĐÓNG = RỜI HÀNG ĐỢI, " +
      "không phải kết luận cứu đơn: kết quả vẫn chờ chứng từ ĐVVC chốt.",
  },
  {
    tracking: "PKE1515019044",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 16/09: 15/09 02:04 VTP 505 'Khách từ chối nhận - Không hài lòng về sản phẩm', cùng lúc 502 chiều " +
      "RETURN 'Chuyển hoàn bưu cục gốc', 15/09 04:37 đã đóng bảng kê đi chiều hoàn. Khách đã từ chối và hàng đang " +
      "về shop — hết việc chăm sóc. Kết quả cứu đơn để chứng từ ĐVVC chốt.",
  },
  {
    tracking: "PKE1517664544",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 16/09: 14/09 10:01 VTP 505 'Không hài lòng về sản phẩm', 14/09 11:36 bưu cục phát duyệt hoàn " +
      "'KHÁCH HÀNG YÊU CẦU HOÀN VỀ', 15/09 00:16 502 chiều RETURN. Khách chủ động yêu cầu hoàn, ĐVVC đã duyệt — " +
      "hết việc chăm sóc. Kết quả cứu đơn để chứng từ ĐVVC chốt.",
  },
  {
    tracking: "PKE1517808316",
    nhom: "E_HET_VIEC_CHAM_SOC",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["RETURNING"],
    toStatus: "RESOLVED",
    uuTien: "-",
    note:
      "Đối chiếu 16/09: sau lần hẹn phát lại 13/09 và một lượt sửa địa chỉ chuyển tiếp, 16/09 01:53 VTP 502 chiều " +
      "RETURN 'Người gửi yêu cầu chuyển hoàn' → Đang chuyển hoàn. Chính shop đã yêu cầu hoàn và hàng đang về — " +
      "hết việc chăm sóc. Kết quả cứu đơn để chứng từ ĐVVC chốt.",
  },

  /* ── A · CÒN CỨU ĐƯỢC: hàng còn nằm ở bưu cục đích, khách chưa hề từ chối ─────────────────── */
  {
    tracking: "PKE1517808393",
    nhom: "A_CUU_DUOC",
    fromStatus: "WAITING_CUSTOMER",
    stages: ["PENDING", "DELIVERY_FAILED", "IN_TRANSIT", "OUT_FOR_DELIVERY"],
    toStatus: "WAITING_CUSTOMER",
    hetHanSauGio: 3,
    uuTien: "P0",
    note:
      "P0 · GỌI KHÁCH HÔM NAY. 11/09 VTP 507 'Khách hàng đến bưu cục nhận' (khách TỰ hẹn ra lấy), nhưng 14/09 17:00 " +
      "VTP 505 'Quá thời gian hẹn nhận' — bưu cục Giảng Võ đã thông báo chuyển hoàn. Khách CHƯA từ chối lần nào, " +
      "hàng vẫn ở bưu cục đích. Việc: gọi xác nhận còn nhận không; còn thì xin bưu cục giữ hàng và phát lại / hẹn " +
      "khách ra lấy. Không gọi trong hôm nay là mất đơn 499.000đ.",
  },

  /* ── D · KHÁCH TỪ CHỐI, HÀNG CÒN TỒN Ở BƯU CỤC: cần NGƯỜI chốt duyệt hoàn ─────────────────── */
  {
    tracking: "PKE1515084738",
    nhom: "D_KHACH_TU_CHOI",
    fromStatus: "WAITING_CUSTOMER",
    stages: ["PENDING", "DELIVERY_FAILED", "IN_TRANSIT", "OUT_FOR_DELIVERY"],
    toStatus: "WAITING_CUSTOMER",
    hetHanSauGio: 8,
    uuTien: "P1",
    note:
      "P1 · CHỐT TRONG NGÀY. Khách từ chối BA lần: 13/09 'Không có nhu cầu nhận hàng', 15/09 'Không hài lòng về sản " +
      "phẩm', 16/09 03:27 'Khách từ chối nhận - Không có nhu cầu nhận hàng'. Hàng còn tồn ở bưu cục Quảng Ngãi, " +
      "chưa vào chiều hoàn. Việc: gọi chốt lần cuối, không cứu được thì DUYỆT HOÀN trên màn hình vận đơn để hàng " +
      "về sớm. Script này KHÔNG tự duyệt hoàn — đó là quyết định tiền, người bấm.",
  },
  {
    tracking: "PKE1517089550",
    nhom: "D_KHACH_TU_CHOI",
    fromStatus: "WAITING_CUSTOMER",
    stages: ["PENDING", "DELIVERY_FAILED", "IN_TRANSIT", "OUT_FOR_DELIVERY"],
    toStatus: "WAITING_CUSTOMER",
    hetHanSauGio: 8,
    uuTien: "P1",
    note:
      "P1 · CHỐT TRONG NGÀY. Khách hẹn phát lại hai lần (12/09, 13/09) rồi đổi ý: 15/09 04:52 VTP 505 'Không có nhu " +
      "cầu nhận hàng'. Hàng còn tồn ở bưu cục Quảng Trị, chưa vào chiều hoàn. Việc: gọi chốt lần cuối, không cứu " +
      "được thì DUYỆT HOÀN. Script này KHÔNG tự duyệt hoàn.",
  },
  {
    tracking: "PKE1517808418",
    nhom: "D_KHACH_TU_CHOI",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["PENDING", "DELIVERY_FAILED", "IN_TRANSIT", "OUT_FOR_DELIVERY"],
    toStatus: "WAITING_CUSTOMER",
    hetHanSauGio: 8,
    uuTien: "P1",
    note:
      "P1 · CHỐT TRONG NGÀY. Nhãn 'Chờ phát lại' đã sai từ 15/09: 15/09 07:00 VTP 505 'Người gửi yêu cầu chuyển " +
      "hoàn', 16/09 02:58 'Khách từ chối nhận - Không có nhu cầu nhận hàng'. Không ai đang chờ một lượt phát lại " +
      "nào cả. Hàng còn tồn ở bưu cục Tuyên Quang. Việc: gọi chốt lần cuối, không cứu được thì DUYỆT HOÀN.",
  },

  /* ── C · CHỜ ĐVVC: shop đã yêu cầu hoàn, kiện ba ngày không nhúc nhích ───────────────────── */
  {
    tracking: "PKE1515065610",
    nhom: "C_CHO_DVVC",
    fromStatus: "WAITING_REDELIVERY",
    stages: ["PENDING", "DELIVERY_FAILED", "IN_TRANSIT", "OUT_FOR_DELIVERY"],
    toStatus: "WAITING_CARRIER",
    hetHanSauGio: 24,
    uuTien: "P2",
    note:
      "P2 · GIỤC BƯU CỤC. 13/09 05:59 VTP 505 'Người gửi yêu cầu chuyển hoàn', nhưng tới 16/09 00:18 kiện vẫn tồn ở " +
      "bưu cục Vĩnh Long với 505 'Không liên lạc được khách hàng nhận' — ba ngày không vào được chiều hoàn. Đổi " +
      "nhãn 'Chờ phát lại' sang 'Chờ ĐVVC' vì việc đang nằm ở bưu cục, không ở khách. Việc: gọi bưu cục VLG/HBVLMT " +
      "hỏi vì sao chưa chuyển hoàn; quá 24 giờ nữa chưa chuyển thì escalate.",
  },
];

const NHAN_NHOM: Record<Nhom, string> = {
  A_CUU_DUOC: "A · khách vẫn có thể nhận — cần gọi khách / phát lại",
  C_CHO_DVVC: "C · chờ bưu tá / bưu cục — cần giục ĐVVC",
  D_KHACH_TU_CHOI: "D · khách từ chối — ứng viên duyệt hoàn (NGƯỜI quyết)",
  E_HET_VIEC_CHAM_SOC: "E · ĐVVC đã mang hàng về — hết việc chăm sóc, đóng ca",
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
