/**
 * ═══════════ SỬA CA ĐÃ CHỐT "CỨU ĐƯỢC / KHÔNG CỨU ĐƯỢC" MÀ KẾT CỤC CÓ TRƯỚC LÚC MỞ CA ═══════════
 *
 * ─── LỖI ───
 *
 * `chotKetQua` từng không hỏi kết cục ĐVVC xảy ra TRƯỚC hay SAU lúc mở đợt. Ca mở trên thông tin cũ
 * (thường là mở tay trên kiện đã giao) nhận luôn kết cục của kiện — "Cứu được" cho một kiện đã tới
 * tay khách khi chưa có ca nào để cứu. Đó là gán công ngược thời gian (luật 56). Bản vá 23/09/2026
 * (#191) chặn ở đường chốt cho MỌI ca từ nay; script này sửa những ca ĐÃ TRÓT chốt trước đó.
 * Đo production 23/09/2026: 1 đợt.
 *
 * ─── VIỆC SCRIPT LÀM, VÀ KHÔNG LÀM ───
 *
 * LÀM: đợt chốt với `outcome_at < opened_at` được đưa về đúng chỗ bản vá đưa ca mới về —
 * `resolution = NOT_CARE_CONDITION`, `care_outcome = NULL`, không quy kết cho ai — kèm một mốc
 * `SYSTEM_CORRECTION` trong nhật ký GHI LẠI giá trị cũ (kết cục, mốc, người được quy kết), để
 * lịch sử truy lại được nguyên vẹn.
 *
 * KHÔNG LÀM: không xoá dòng nào, không đụng `care_status` / `done_at` người đã chọn, không đụng
 * `care_actions` (việc người đã làm vẫn là thật, luật 60).
 *
 * MẶC ĐỊNH CHẠY THỬ. `--apply` mới ghi. Idempotent: đợt đã sửa không còn khớp điều kiện.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/care-outcome-before-open-repair.ts [--apply]
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/lib/sql-rows";

const apply = process.argv.slice(2).includes("--apply");

/**
 * KÊNH TÓM TẮT CỦA THAO TÁC OPS. Qua workflow "Vận hành ERP trên VPS", kết quả của script này được
 * MÃ HOÁ (từng đợt kèm TÊN nhân viên được quy công cứu / không cứu được); chỉ dòng mang tiền tố dưới
 * đây được in ra log công khai — tức CHỈ con số đếm, không bao giờ một cái tên.
 */
const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

type Dot = {
  id: string;
  shipment_id: string;
  tracking: string | null;
  episode_no: number;
  care_outcome: string;
  care_status: string;
  opened_at: string;
  outcome_at: string;
  owner_at_resolution: string | null;
  owner_name: string | null;
};

async function main() {
  const db = await getDb();
  const ds = rowsOf<Dot>(
    await db.execute(sql`
      select c.id, c.shipment_id, coalesce(s.vtp_order_number, c.tracking_number) as tracking, c.episode_no,
             c.care_outcome, c.care_status, c.opened_at, c.outcome_at, c.owner_at_resolution, u.name as owner_name
        from shipment_care c
        join shipments s on s.id = c.shipment_id
        left join users u on u.id = c.owner_at_resolution
       where c.care_outcome in ('RESCUED_DIRECT', 'RESCUED_EXCHANGE', 'RESCUE_FAILED')
         and c.outcome_at is not null and c.opened_at is not null
         and c.outcome_at < c.opened_at
       order by c.outcome_at
    `),
  );

  tomTat(`═══ CA CHỐT NGƯỢC THỜI GIAN ${apply ? "(CHẾ ĐỘ GHI)" : "(CHẠY THỬ — thêm --apply để ghi)"} ═══`);
  tomTat(`số đợt: ${ds.length}`);
  for (const r of ds) {
    console.log(
      `  · ${r.tracking ?? r.shipment_id} đợt#${r.episode_no} ${r.care_outcome} (quy về ${r.owner_name ?? "—"})` +
        ` · ĐVVC kết thúc ${String(r.outcome_at).slice(0, 19)} < mở ca ${String(r.opened_at).slice(0, 19)}`,
    );
  }
  if (!apply || !ds.length) {
    tomTat(apply ? "Không có đợt nào để sửa." : "Chưa ghi gì. Thêm --apply để sửa.");
    process.exit(0);
  }

  let daSua = 0;
  for (const r of ds) {
    // Điều kiện nằm ngay trong lệnh ghi: chạy lại, hoặc hai lượt song song, không sửa hai lần.
    const ghi = await db.execute(sql`
      update shipment_care
         set care_outcome = null,
             resolution = 'NOT_CARE_CONDITION',
             owner_at_resolution = null,
             final_logistics_outcome = null,
             outcome_at = null,
             updated_by = 'SYSTEM_CORRECTION',
             updated_at = now()
       where id = ${r.id}
         and care_outcome in ('RESCUED_DIRECT', 'RESCUED_EXCHANGE', 'RESCUE_FAILED')
         and outcome_at < opened_at
      returning id
    `);
    if (!rowsOf<{ id: string }>(ghi).length) continue;
    daSua += 1;
    await db.insert(schema.careCaseEvents).values({
      shipmentId: r.shipment_id,
      source: "SYSTEM",
      action: "CANCEL",
      note:
        `SYSTEM_CORRECTION: ĐVVC đã kết thúc lúc ${String(r.outcome_at).slice(0, 19)}, TRƯỚC khi đợt #${r.episode_no} được mở ` +
        `(${String(r.opened_at).slice(0, 19)}) — kiện đã kết thúc khi chưa có ca nào để cứu. Kết cục cũ "${r.care_outcome}" ` +
        `(quy về ${r.owner_name ?? "không ai"}) không tính vào tỷ lệ cứu đơn.`,
      previousStatus: r.care_status,
      nextStatus: r.care_status,
      payload: {
        correction: "OUTCOME_BEFORE_OPEN",
        careId: r.id,
        previousOutcome: r.care_outcome,
        previousOutcomeAt: r.outcome_at,
        previousOwnerAtResolution: r.owner_at_resolution,
        openedAt: r.opened_at,
      },
    });
  }
  tomTat(`Đã sửa ${daSua}/${ds.length} đợt, mỗi đợt kèm một mốc SYSTEM_CORRECTION ghi lại giá trị cũ.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
