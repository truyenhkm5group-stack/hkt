/**
 * ═══════════ SỬA CÁC CA BỊ DỰNG LẠI VÔ CỚ ═══════════
 *
 * ─── LỖI ───
 *
 * Cả hai đường mở ca chỉ hỏi "kiện này có đợt nào ĐANG MỞ không?". Người vừa bấm hoàn tất làm
 * `active = false`, nên câu trả lời là "không" và một đợt MỚI được mở cho ĐÚNG tình trạng ĐVVC cũ.
 * Bộ đối chiếu chạy 10 phút/lần nên ca quay lại gần như ngay lập tức, trắng trơn: trạng thái về
 * "Chưa xử lý", note của đợt cũ không hiện nữa (nó vẫn nằm nguyên trong CSDL).
 *
 * Luật thay thế nằm ở `lib/care/reopen-guard.ts`; script này dọn phần đã trót sinh ra.
 *
 * ─── NHẬN DIỆN ───
 *
 * Một đợt là DỰNG LẠI VÔ CỚ khi mốc kích hoạt của nó (`opened_at`, mốc ĐVVC) KHÔNG MỚI HƠN mốc
 * đóng của đợt liền trước trên cùng kiện. Không có sự việc mới nào xảy ra giữa hai đợt.
 *
 * ─── VIỆC SCRIPT LÀM, VÀ KHÔNG LÀM ───
 *
 * LÀM: đóng đợt thừa (`active = false`, `resolution = NOT_CARE_CONDITION`, `care_outcome = NULL`)
 * để nó rời hàng đợi và KHÔNG vào bất kỳ tỷ lệ nào, kèm một mốc `SYSTEM_CORRECTION` trong nhật ký.
 *
 * KHÔNG LÀM: không xoá một dòng nào, không đụng đợt gốc, không chép note từ đợt này sang đợt kia
 * (chép là bịa ra một hành động chưa từng xảy ra trên đợt đó), và không đụng đợt thừa mà ĐÃ CÓ
 * NGƯỜI làm việc trên nó — nếu ai đó đã gọi khách trên đợt thừa thì công đó là thật, và đợt ấy phải
 * đi tiếp đường bình thường. Những đợt đó chỉ được LIỆT KÊ để người đọc tự quyết.
 *
 * MẶC ĐỊNH CHẠY THỬ. `--apply` mới ghi. Chạy lại nhiều lần cho cùng kết quả (idempotent): đợt đã
 * đóng không còn khớp điều kiện.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/care-false-reopen-repair.ts [--apply]
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/lib/sql-rows";

const apply = process.argv.slice(2).includes("--apply");

/**
 * KÊNH TÓM TẮT CỦA THAO TÁC OPS. Qua workflow "Vận hành ERP trên VPS", kết quả của script này được
 * MÃ HOÁ (danh sách từng đợt kèm note tự do nhân viên đã viết); chỉ dòng mang tiền tố dưới đây được
 * in ra log công khai — tức CHỈ con số đếm, không bao giờ một note.
 */
const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

type Dot = {
  id: string;
  shipment_id: string;
  tracking: string | null;
  episode_no: number;
  entry: string | null;
  opened_at: string | null;
  created_at: string;
  care_status: string;
  co_nguoi_lam: boolean;
  truoc_id: string;
  truoc_dong: string;
  truoc_note: string;
};

async function main() {
  const db = await getDb();

  /*
    `co_nguoi_lam` gom MỌI dấu vết của người: có chủ, đã phản hồi, có ghi chú, có hành động chăm
    sóc, hoặc có một sự kiện ca không phải của máy. Thà bỏ sót một đợt thừa còn hơn đóng nhầm một
    đợt mà ai đó đã thật sự làm việc trên nó.
  */
  const ungVien = rowsOf<Dot>(
    await db.execute(sql`
      with cap as (
        select c.id, c.shipment_id, c.tracking_number as tracking, c.episode_no, c.entry_carrier_state as entry,
               coalesce(c.opened_at, c.created_at) as opened_at, c.created_at, c.care_status, c.active,
               c.owner_id, c.first_response_at, c.last_note, c.resolution,
               lag(c.id)                                        over w as truoc_id,
               lag(coalesce(c.done_at, c.outcome_at))           over w as truoc_dong,
               lag(coalesce(c.last_note, ''))                   over w as truoc_note
          from shipment_care c
        window w as (partition by c.shipment_id order by c.episode_no)
      )
      select cap.id, cap.shipment_id, cap.tracking, cap.episode_no, cap.entry,
             cap.opened_at, cap.created_at, cap.care_status,
             (cap.owner_id is not null
              or cap.first_response_at is not null
              or coalesce(cap.last_note, '') <> ''
              or exists (select 1 from care_actions a where a.shipment_id = cap.shipment_id and a.created_at >= cap.created_at)
              or exists (select 1 from care_case_events e where e.shipment_id = cap.shipment_id and e.source <> 'SYSTEM' and e.created_at >= cap.created_at)
             ) as co_nguoi_lam,
             cap.truoc_id, cap.truoc_dong, cap.truoc_note
        from cap
       where cap.truoc_id is not null
         and cap.truoc_dong is not null
         -- Mốc kích hoạt KHÔNG mới hơn lúc đóng ⇒ không có sự việc mới nào giữa hai đợt.
         and cap.opened_at <= cap.truoc_dong
         -- Chỉ đợt còn đang treo mới cần dọn; đợt đã chốt để nguyên (không sửa lịch sử).
         and cap.active = true
       order by cap.shipment_id, cap.episode_no
    `),
  );

  const dongDuoc = ungVien.filter((r) => !r.co_nguoi_lam);
  const phaiHoi = ungVien.filter((r) => r.co_nguoi_lam);

  tomTat(`═══ CA BỊ DỰNG LẠI VÔ CỚ ${apply ? "(CHẾ ĐỘ GHI)" : "(CHẠY THỬ — thêm --apply để ghi)"} ═══`);
  tomTat(`ứng viên            : ${ungVien.length}`);
  tomTat(`đóng được (máy mở, chưa ai làm gì): ${dongDuoc.length}`);
  tomTat(`phải để người quyết (đã có người làm): ${phaiHoi.length}`);

  for (const r of ungVien) {
    console.log(
      `  ${r.co_nguoi_lam ? "!" : "·"} ${r.tracking ?? r.shipment_id} đợt#${r.episode_no} ${r.care_status}` +
        ` · kích hoạt ${String(r.opened_at).slice(0, 19)} ≤ đóng ${String(r.truoc_dong).slice(0, 19)}` +
        ` · lý do vào ${r.entry ?? "—"}${r.truoc_note ? ` · đợt trước có note "${r.truoc_note.slice(0, 40)}"` : ""}`,
    );
  }

  if (!apply || !dongDuoc.length) {
    tomTat(apply ? "Không có đợt nào để đóng." : "Chưa ghi gì. Thêm --apply để đóng các đợt thừa.");
    process.exit(0);
  }

  let daDong = 0;
  for (const r of dongDuoc) {
    /*
      Điều kiện `active = true` nằm trong chính mệnh đề `where` của lệnh ghi: hai lượt chạy song
      song thì chỉ một lượt thắng, và chạy lại lần hai không đóng lại thứ đã đóng.
    */
    const ghi = await db.execute(sql`
      update shipment_care
         set active = false,
             care_status = 'CANCELLED',
             resolution = 'NOT_CARE_CONDITION',
             care_outcome = null,
             follow_up_at = null,
             updated_by = 'SYSTEM_CORRECTION',
             updated_at = now()
       where id = ${r.id} and active = true
      returning id
    `);
    if (!rowsOf<{ id: string }>(ghi).length) continue;
    daDong += 1;
    // KHÔNG XOÁ LỊCH SỬ: thêm một mốc nói rõ vì sao đợt này bị đóng và nó thuộc về đợt nào.
    await db.insert(schema.careCaseEvents).values({
      shipmentId: r.shipment_id,
      source: "SYSTEM",
      action: "CANCEL",
      note:
        `SYSTEM_CORRECTION: đợt này được dựng lại vô cớ — mốc kích hoạt (${String(r.opened_at).slice(0, 19)}) ` +
        `không mới hơn lúc đóng đợt trước (${String(r.truoc_dong).slice(0, 19)}). Không có sự việc mới nào ở ĐVVC. ` +
        `Việc đã xử lý nằm ở đợt #${r.episode_no - 1}.`,
      previousStatus: r.care_status,
      nextStatus: "CANCELLED",
      payload: { correction: "FALSE_REOPEN", previousEpisodeId: r.truoc_id, openedAt: r.opened_at, previousClosedAt: r.truoc_dong },
    });
  }

  tomTat(`Đã đóng ${daDong}/${dongDuoc.length} đợt thừa, mỗi đợt kèm một mốc SYSTEM_CORRECTION.`);
  if (phaiHoi.length) tomTat(`${phaiHoi.length} đợt có người đã làm việc trên đó — KHÔNG đụng tới, xem danh sách "!" trong bản mã.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
