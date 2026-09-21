/**
 * ═══════════ VÁ CHẶNG ĐÃ LƯU CỦA CÁC DÒNG TỆP MANG CỜ "TRẢ HÀNG" ═══════════
 *
 * SỰ CỐ 21/09/2026: chủ shop mở PKE1521276709 / PKE1522238009 — viettelpost.vn ghi "Đã duyệt
 * hoàn", ERP ghi "Chờ xử lý", tức lùi về điểm xuất phát.
 *
 * Nguyên nhân: cột "Trạng thái" của tệp Danh sách vận đơn dùng chữ "Chờ xử lý" cho CHỜ XỬ LÝ HOÀN,
 * còn ERP dịch nó thành `PENDING` (chưa lấy hàng). Dòng tệp mang mốc mới hơn webhook 505 chừng
 * 60–70 giây nên nó thắng trong `deriveShipmentState()`.
 *
 * Bộ dịch đã được sửa (`mapVtpStatusText` nay đọc cờ Trả hàng), nhưng CHẶNG ĐÃ LƯU thì không tự
 * đổi: `shipment_events.normalized_stage` được ghi một lần lúc nhập, và `deriveShipmentState()`
 * ưu tiên nó hơn bản dịch lại. Nên bản sửa chỉ đúng cho lần nhập SAU; 295 dòng đã nằm trong CSDL
 * vẫn nói sai, và 20 vận đơn (10.222.000 ₫ COD) vẫn kẹt.
 *
 * Script này DỊCH LẠI đúng những dòng ấy bằng chính bộ dịch của đường ghi — không có luật thứ hai
 * viết riêng cho việc vá — rồi dựng lại ảnh chụp vận đơn từ lịch sử và đẩy vòng đời care đi tiếp.
 *
 * PHẠM VI HẸP CÓ CHỦ Ý: chỉ dòng `VTP_IMPORT` mang cờ `Trả hàng = x` trong `raw.snapshot`, và chỉ
 * khi bản dịch lại KHÁC chặng đang lưu. Không đụng một dòng lịch sử nào khác. Không xoá gì.
 *
 * Dùng:
 *   npx tsx scripts/vtp-return-status-repair.ts            # CHẠY THỬ — chỉ đếm và in mẫu
 *   npx tsx scripts/vtp-return-status-repair.ts --apply    # ghi thật
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { afterShipmentStateChange } from "@/lib/care/lifecycle";
import { materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { eventStatusCode, resolveVtpStatus } from "@/lib/integrations/viettelpost/status";
import { rowsOf } from "@/lib/sql-rows";

const APPLY = process.argv.includes("--apply");

type Dong = {
  id: string;
  shipment_id: string;
  vtp_order_number: string | null;
  status: string;
  status_name: string;
  normalized_stage: string | null;
  occurred_at: string;
};

async function main() {
  const db = await getDb();

  /*
    Dòng ỨNG VIÊN: nhập từ tệp, mang cờ Trả hàng. Phép dịch lại làm ở TypeScript chứ không viết
    lại bằng SQL — hai bản luật sẽ trôi xa nhau, và bản SQL sẽ là bản không ai chạy kiểm thử.
  */
  const ungVien = rowsOf<Dong>(
    await db.execute(sql`
      select e.id, e.shipment_id, s.vtp_order_number, e.status, e.status_name,
             e.normalized_stage::text as normalized_stage, e.occurred_at
        from shipment_events e
        join shipments s on s.id = e.shipment_id
       where e.source = 'VTP_IMPORT'
         and (e.raw -> 'snapshot' ->> 'returnFlag') = 'true'
       order by e.occurred_at
    `),
  );

  const canSua = ungVien
    .map((d) => {
      const dungPhai = resolveVtpStatus({ code: eventStatusCode(d.status), text: d.status_name || d.status, returnFlag: true }).stage;
      return { ...d, dungPhai };
    })
    // `UNKNOWN` không bao giờ được GHI ĐÈ lên một chặng đã có: nó nghĩa là "không đủ căn cứ", và
    // thay một câu đã biết bằng một câu không biết là mất thông tin, không phải sửa sai.
    .filter((d) => d.dungPhai !== "UNKNOWN" && d.dungPhai !== d.normalized_stage);

  const theoChuyen = new Map<string, number>();
  for (const d of canSua) {
    const k = `${d.normalized_stage} → ${d.dungPhai}`;
    theoChuyen.set(k, (theoChuyen.get(k) ?? 0) + 1);
  }
  const kien = [...new Set(canSua.map((d) => d.shipment_id))];

  const truoc = rowsOf<{ stage: string; so: number; cod: number }>(
    await db.execute(sql`
      select stage::text as stage, count(*)::int as so, coalesce(sum(cod_amount),0)::bigint as cod
        from shipments where id in ${kien.length ? kien : [""]}
       group by 1 order by 2 desc
    `),
  );

  console.log(
    JSON.stringify(
      {
        che_do: APPLY ? "GHI THẬT" : "CHẠY THỬ (thêm --apply để ghi)",
        dong_ung_vien: ungVien.length,
        dong_can_sua: canSua.length,
        theo_chuyen_doi: Object.fromEntries(theoChuyen),
        van_don_anh_huong: kien.length,
        trang_thai_truoc: truoc,
        mau_10_dong: canSua.slice(0, 10).map((d) => ({ vd: d.vtp_order_number, chu: d.status_name, dang_luu: d.normalized_stage, dung_phai: d.dungPhai, moc: d.occurred_at })),
      },
      null,
      2,
    ),
  );

  if (!APPLY || !canSua.length) return;

  for (const d of canSua) {
    await db.execute(sql`update shipment_events set normalized_stage = ${d.dungPhai}::shipment_stage where id = ${d.id}`);
  }

  /*
    Dựng lại ảnh chụp SAU khi đã vá xong toàn bộ chặng — dựng giữa chừng thì một vận đơn có hai
    dòng hỏng sẽ được tính trên nửa lịch sử đã sửa, ra một trạng thái trung gian không có thật.
    Vòng đời care đi sau cùng, và lỗi của nó không được làm hỏng lượt vá (cùng lẽ với đường webhook).
  */
  let doi = 0;
  for (const id of kien) {
    const r = await materializeShipmentState(db, id);
    if (!r.changed) continue;
    doi += 1;
    await afterShipmentStateChange(db, id, { source: "VTP_RETURN_STATUS_REPAIR" }).catch(() => undefined);
  }

  const sau = rowsOf(
    await db.execute(sql`
      select stage::text as stage, count(*)::int as so, coalesce(sum(cod_amount),0)::bigint as cod
        from shipments where id in ${kien}
       group by 1 order by 2 desc
    `),
  );
  console.log(JSON.stringify({ da_sua_dong: canSua.length, van_don_doi_trang_thai: doi, trang_thai_sau: sau }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
