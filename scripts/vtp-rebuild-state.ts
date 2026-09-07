/**
 * Dựng lại trạng thái vận đơn từ lịch sử sự kiện Viettel Post.
 *
 * Vì sao cần: trước đây `shipments.stage` là ô nhớ mà nhiều luồng cùng ghi, luồng nào chạy sau
 * thì thắng kể cả khi mang sự kiện cũ hơn. Đo trên production: 30/228 vận đơn có webhook mới hơn
 * trạng thái đang lưu. Job này tính lại trạng thái theo mốc thời gian của ĐVVC.
 *
 * An toàn:
 *  · mặc định CHẠY THỬ, chỉ ghi khi có --apply;
 *  · chỉ đụng các trường trạng thái, không đụng tiền / người nhận / mốc kho nhận hàng hoàn;
 *  · không xoá, không sửa lịch sử sự kiện — chỉ điền `normalized_stage` còn trống;
 *  · idempotent: chạy lại cho cùng kết quả và báo 0 thay đổi.
 *
 * Dùng: npx tsx scripts/vtp-rebuild-state.ts [--apply] [--limit=N]
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CARRIER_EVENT_SOURCES, deriveShipmentState, materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { eventStatusCode, resolveVtpStatus } from "@/lib/integrations/viettelpost/status";

const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;

async function main() {
  const db = await getDb();
  const e = schema.shipmentEvents;
  const s = schema.shipments;

  // ── Bước 1: điền `normalized_stage` còn trống bằng bộ dịch dùng chung ──
  // Chỉ chuẩn hoá sự kiện ĐẾN THẲNG TỪ ĐVVC. Bản sao hành trình của Pancake không được quyền kết
  // luận trạng thái, nên gắn nhãn chuẩn hoá cho chúng chỉ làm chỉ số "lệch trạng thái" nhiễu.
  const blank = await db
    .select({ id: e.id, status: e.status, statusName: e.statusName })
    .from(e)
    .where(and(isNull(e.normalizedStage), isNotNull(e.occurredAt), inArray(e.source, CARRIER_EVENT_SOURCES)));
  let filled = 0;
  let unknownEvents = 0;
  for (const row of blank) {
    const resolved = resolveVtpStatus({ code: eventStatusCode(row.status), text: row.statusName || row.status });
    if (resolved.stage === "UNKNOWN") {
      unknownEvents += 1;
      continue;
    }
    if (apply) await db.update(e).set({ normalizedStage: resolved.stage }).where(eq(e.id, row.id));
    filled += 1;
  }

  // ── Bước 2: tính lại trạng thái từng vận đơn ──
  const rows = await db
    .select({ id: s.id, stage: s.stage, vtpStatusDate: s.vtpStatusDate, vtpOrderNumber: s.vtpOrderNumber })
    .from(s)
    .orderBy(asc(s.createdAt));
  const targets = limit > 0 ? rows.slice(0, limit) : rows;

  let unchanged = 0;
  let wouldChange = 0;
  let noEvents = 0;
  let missingTimestamp = 0;
  const transitions = new Map<string, number>();
  const samples: string[] = [];

  for (const row of targets) {
    const derived = await deriveShipmentState(db, row.id);
    if (!derived) {
      noEvents += 1;
      continue;
    }
    if (!Number.isFinite(derived.vtpStatusDate.getTime())) {
      missingTimestamp += 1;
      continue;
    }
    const same = row.stage === derived.stage && row.vtpStatusDate?.getTime() === derived.vtpStatusDate.getTime();
    if (same) {
      unchanged += 1;
      continue;
    }
    wouldChange += 1;
    const key = `${row.stage} -> ${derived.stage}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    if (samples.length < 10 && row.stage !== derived.stage) {
      samples.push(`${row.vtpOrderNumber ?? row.id}: ${key} (theo ${derived.decidedBy.source} lúc ${derived.decidedBy.occurredAt.toISOString()})`);
    }
    if (apply) await materializeShipmentState(db, row.id);
  }

  // ── Bước 3: số vận đơn có webhook mới hơn trạng thái đang lưu (chỉ số đã phát hiện lỗi) ──
  const [{ n: newerWebhook }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(s)
    .where(
      sql`exists (select 1 from shipment_events ev where ev.shipment_id = ${s.id} and ev.source = 'VTP_WEBHOOK'
        and (${s.vtpStatusDate} is null or ev.occurred_at > ${s.vtpStatusDate}))`,
    );

  console.log(JSON.stringify({
    che_do: apply ? "GHI THAT" : "CHAY THU",
    su_kien_thieu_trang_thai_chuan_hoa: blank.length,
    su_kien_dien_duoc: filled,
    su_kien_khong_ro_trang_thai: unknownEvents,
    van_don_kiem_tra: targets.length,
    van_don_khong_doi: unchanged,
    van_don_se_doi: wouldChange,
    van_don_khong_co_su_kien: noEvents,
    van_don_thieu_moc_thoi_gian: missingTimestamp,
    van_don_co_webhook_moi_hon: Number(newerWebhook),
    chuyen_trang_thai: Object.fromEntries([...transitions.entries()].sort((a, b) => b[1] - a[1])),
    vi_du: samples,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
