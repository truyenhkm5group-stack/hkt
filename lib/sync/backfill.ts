/**
 * ───────────── DỰNG LẠI CHÂN LÝ LỊCH SỬ: CHẠY THỬ TRƯỚC, GHI SAU ─────────────
 *
 * Dựng lại các giá trị SUY RA (trạng thái vận đơn, các mốc thời gian, và qua đó là kết quả đơn)
 * từ lịch sử sự kiện. KHÔNG bao giờ đụng tới dữ liệu GỐC:
 *  · `shipment_events` — không sửa, không xoá (chỉ điền `normalized_stage` còn trống, và chỉ khi
 *    bộ dịch dùng chung đọc được; đọc không ra thì để trống chứ không đoán);
 *  · `orders.raw`, `shipments.raw`, `webhook_events.payload` — không đụng;
 *  · tiền (`cod_collected`, `cod_status`), người nhận, mốc kho thực nhận hàng hoàn — KHÔNG đụng.
 *    Đó là dữ liệu của những chiều khác, không suy ra từ hành trình được.
 *
 * Vì sao an toàn: trạng thái vận đơn là HÀM XÁC ĐỊNH của tập sự kiện. Chạy lại trên cùng tập sự
 * kiện cho cùng kết quả và báo 0 thay đổi (idempotent). "Quay lui" ở đây không cần bản sao lưu:
 * lịch sử không bị đụng tới, nên dựng lại lần nữa là quay về đúng trạng thái tính được.
 *
 * Chạy thử cho ra đủ các con số mà chủ shop cần nhìn TRƯỚC khi cho ghi: bao nhiêu đơn đổi từ
 * "giao thành công" sang "không thành công" và ngược lại — nếu con số đó bất thường thì DỪNG,
 * đi điều tra, không ghi.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { CARRIER_EVENT_SOURCES } from "@/lib/constants/truth";
import type { OrderOutcome } from "@/lib/constants/returns";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { deriveShipmentState, materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { eventStatusCode, resolveVtpStatus } from "@/lib/integrations/viettelpost/status";
import { getSyncState, setSyncState } from "@/lib/sync/runner";

const s = schema.shipments;
const e = schema.shipmentEvents;
const o = schema.orders;

/** Khoá ghi tiến độ để chạy lại tiếp được chỗ dở dang (resumable). */
export const BACKFILL_CURSOR_KEY = "backfill:canonical-state";

export type OutcomeCounts = Record<OrderOutcome, number>;

export type BackfillReport = {
  applied: boolean;
  /** Tổng vận đơn nằm trong phạm vi lần chạy này. */
  total: number;
  /** Trạng thái dựng lại trùng với ảnh chụp đang lưu. */
  unchanged: number;
  /** Trạng thái dựng lại khác ảnh chụp. */
  changed: number;
  /** Không có sự kiện nào đủ căn cứ — giữ nguyên, KHÔNG đoán. */
  noEvidence: number;
  /** Sự kiện có nhưng mốc thời gian hỏng. */
  badTimestamp: number;
  /** Sự kiện của ĐVVC mà bộ dịch chung đọc không ra — phải bổ sung bảng mã, không được đoán. */
  unknownEvents: number;
  /** Sự kiện thiếu `normalized_stage` và điền được bằng bộ dịch chung. */
  normalizedFilled: number;
  /** Ma trận chuyển trạng thái vận đơn: "TRƯỚC -> SAU" → số lượng. */
  stageTransitions: Record<string, number>;
  /** Phân bố KẾT QUẢ ĐƠN trước và sau — con số chủ shop thực sự quan tâm. */
  outcomeBefore: OutcomeCounts;
  outcomeAfter: OutcomeCounts;
  /** Đơn chuyển từ GIAO THÀNH CÔNG sang không thành công (doanh thu giảm). */
  deliveredToNotDelivered: number;
  /** Đơn chuyển từ không thành công sang GIAO THÀNH CÔNG (doanh thu tăng). */
  notDeliveredToDelivered: number;
  /** Thay đổi trong nhóm hoàn. */
  returnedChanged: number;
  /**
   * Ca nhập nhằng: ảnh chụp nói đã giao nhưng lịch sử không hề có sự kiện giao nào.
   * KHÔNG tự ghi đè — nêu ra để người vận hành xem.
   */
  conflicts: number;
  /** Vận đơn không có bất kỳ chứng từ nào từ ĐVVC. */
  missingEvidence: number;
  samples: string[];
  /** Vị trí dừng để lần chạy sau tiếp tục; null = đã quét hết. */
  cursor: string | null;
};

async function outcomeDistribution(db: Db): Promise<OutcomeCounts> {
  const [row] = await db
    .select({
      NOT_SHIPPED: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'NOT_SHIPPED')`,
      IN_TRANSIT: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      DELIVERED: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      RETURNED: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'RETURNED')`,
      RETURNED_BY_RULE: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'RETURNED_BY_RULE')`,
      CANCELLED: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
    })
    .from(o)
    .leftJoin(s, eq(s.orderId, o.id))
    .where(sql`${o.stage} <> 'NEW'`);
  return {
    NOT_SHIPPED: Number(row?.NOT_SHIPPED ?? 0),
    IN_TRANSIT: Number(row?.IN_TRANSIT ?? 0),
    DELIVERED: Number(row?.DELIVERED ?? 0),
    RETURNED: Number(row?.RETURNED ?? 0),
    RETURNED_BY_RULE: Number(row?.RETURNED_BY_RULE ?? 0),
    CANCELLED: Number(row?.CANCELLED ?? 0),
  };
}

/** Kết quả đơn hiện tại của những đơn gắn với danh sách vận đơn đưa vào. */
async function outcomeByShipment(db: Db, shipmentIds: string[]): Promise<Map<string, OrderOutcome>> {
  if (!shipmentIds.length) return new Map();
  const rows = await db
    .select({ shipmentId: s.id, outcome: ORDER_OUTCOME })
    .from(o)
    .innerJoin(s, eq(s.orderId, o.id))
    .where(inArray(s.id, shipmentIds));
  return new Map(rows.map((r) => [r.shipmentId, r.outcome as OrderOutcome]));
}

export type BackfillOptions = {
  /** `false` (mặc định) = chạy thử, không ghi gì. */
  apply?: boolean;
  /** Số vận đơn xử lý trong một lượt; 0 = không giới hạn. */
  batchSize?: number;
  /** Chạy tiếp từ vị trí đã ghi của lần trước. */
  resume?: boolean;
  actor?: string;
};

/**
 * Chạy thử hoặc dựng lại. Idempotent, resumable, và ghi nhật ký khi có ghi thật.
 */
export async function runCanonicalBackfill(options: BackfillOptions = {}): Promise<BackfillReport> {
  const db = await getDb();
  const apply = Boolean(options.apply);
  const batchSize = options.batchSize ?? 0;
  const actor = options.actor || "job:canonical-backfill";

  // ── Bước 1: điền `normalized_stage` còn trống, CHỈ cho sự kiện đến thẳng từ ĐVVC ──
  const blank = await db
    .select({ id: e.id, status: e.status, statusName: e.statusName })
    .from(e)
    .where(and(isNull(e.normalizedStage), isNotNull(e.occurredAt), inArray(e.source, [...CARRIER_EVENT_SOURCES])));
  let normalizedFilled = 0;
  let unknownEvents = 0;
  for (const row of blank) {
    const resolved = resolveVtpStatus({ code: eventStatusCode(row.status), text: row.statusName || row.status });
    if (resolved.stage === "UNKNOWN") {
      unknownEvents += 1;
      continue;
    }
    if (apply) await db.update(e).set({ normalizedStage: resolved.stage }).where(eq(e.id, row.id));
    normalizedFilled += 1;
  }

  // ── Bước 2: quét vận đơn theo id tăng dần để chạy lại tiếp được ──
  // `sync_state.value` là jsonb NOT NULL nên tiến độ được lưu dạng { lastId }, `null` nghĩa là
  // đã quét hết vòng và lần sau bắt đầu lại từ đầu.
  const cursorState = options.resume ? await getSyncState<{ lastId: string | null }>(BACKFILL_CURSOR_KEY) : null;
  const startAfter = cursorState?.lastId ?? null;

  const rows = await db
    .select({ id: s.id, stage: s.stage, vtpStatusDate: s.vtpStatusDate, vtpOrderNumber: s.vtpOrderNumber })
    .from(s)
    .where(startAfter ? gt(s.id, startAfter) : undefined)
    .orderBy(asc(s.id))
    .limit(batchSize > 0 ? batchSize : 100_000);

  const outcomeBefore = await outcomeDistribution(db);
  const beforeByShipment = await outcomeByShipment(db, rows.map((r) => r.id));

  let unchanged = 0;
  let changed = 0;
  let noEvidence = 0;
  let badTimestamp = 0;
  let conflicts = 0;
  const stageTransitions: Record<string, number> = {};
  const samples: string[] = [];
  const willChange: string[] = [];

  for (const row of rows) {
    const derived = await deriveShipmentState(db, row.id);
    if (!derived) {
      noEvidence += 1;
      // Ảnh chụp nói ĐÃ GIAO nhưng lịch sử không có chứng từ nào — ca nhập nhằng, không tự sửa.
      if (row.stage === "DELIVERED") conflicts += 1;
      continue;
    }
    if (!Number.isFinite(derived.vtpStatusDate.getTime())) {
      badTimestamp += 1;
      continue;
    }
    const same = row.stage === derived.stage && row.vtpStatusDate?.getTime() === derived.vtpStatusDate.getTime();
    if (same) {
      unchanged += 1;
      continue;
    }
    changed += 1;
    willChange.push(row.id);
    if (row.stage !== derived.stage) {
      const key = `${row.stage} -> ${derived.stage}`;
      stageTransitions[key] = (stageTransitions[key] ?? 0) + 1;
      if (samples.length < 15) {
        samples.push(`${row.vtpOrderNumber ?? row.id}: ${key} (theo ${derived.decidedBy.source} lúc ${derived.decidedBy.occurredAt.toISOString()})`);
      }
    }
    if (apply) await materializeShipmentState(db, row.id);
  }

  // ── Bước 3: kết quả đơn thay đổi thế nào ──
  // Chạy thử thì con số "sau" chỉ khác "trước" khi thật sự ghi; ta vẫn báo cả hai để so được.
  const outcomeAfter = apply ? await outcomeDistribution(db) : outcomeBefore;
  const afterByShipment = apply ? await outcomeByShipment(db, willChange) : new Map<string, OrderOutcome>();
  let deliveredToNotDelivered = 0;
  let notDeliveredToDelivered = 0;
  let returnedChanged = 0;
  for (const id of willChange) {
    const before = beforeByShipment.get(id);
    const after = afterByShipment.get(id);
    if (!before || !after || before === after) continue;
    if (before === "DELIVERED") deliveredToNotDelivered += 1;
    if (after === "DELIVERED") notDeliveredToDelivered += 1;
    const wasReturned = before === "RETURNED" || before === "RETURNED_BY_RULE";
    const isReturned = after === "RETURNED" || after === "RETURNED_BY_RULE";
    if (wasReturned !== isReturned) returnedChanged += 1;
  }

  const [{ n: missingEvidence }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(s)
    .where(sql`not exists (select 1 from shipment_events ev where ev.shipment_id = ${s.id} and ev.normalized_stage is not null)`);

  const cursor = batchSize > 0 && rows.length === batchSize ? rows[rows.length - 1].id : null;
  if (apply) {
    await setSyncState(BACKFILL_CURSOR_KEY, { lastId: cursor });
    await audit({
      userEmail: actor,
      action: "backfill.canonical-state",
      entity: "shipment",
      detail: {
        total: rows.length,
        changed,
        normalizedFilled,
        deliveredToNotDelivered,
        notDeliveredToDelivered,
        stageTransitions,
        note: "Chỉ dựng lại giá trị suy ra từ lịch sử sự kiện; không đụng dữ liệu gốc, tiền hay mốc kho nhận hàng hoàn.",
      },
    });
  }

  return {
    applied: apply,
    total: rows.length,
    unchanged,
    changed,
    noEvidence,
    badTimestamp,
    unknownEvents,
    normalizedFilled,
    stageTransitions,
    outcomeBefore,
    outcomeAfter,
    deliveredToNotDelivered,
    notDeliveredToDelivered,
    returnedChanged,
    conflicts,
    missingEvidence: Number(missingEvidence),
    samples,
    cursor,
  };
}

/**
 * Ngưỡng "bất thường" để dừng tay: nếu chạy thử cho thấy hơn 20% vận đơn sẽ đổi trạng thái, hoặc
 * có đơn đang giao thành công sẽ bị lật, thì phải ĐIỀU TRA trước khi ghi.
 * Trả về danh sách lý do; rỗng nghĩa là chạy thử trông bình thường.
 */
export function backfillWarnings(report: BackfillReport): string[] {
  const warnings: string[] = [];
  if (report.total > 0 && report.changed / report.total > 0.2) {
    warnings.push(`${report.changed}/${report.total} vận đơn sẽ đổi trạng thái (>20%) — kiểm tra lại bộ dịch trạng thái trước khi ghi.`);
  }
  if (report.deliveredToNotDelivered > 0) {
    warnings.push(`${report.deliveredToNotDelivered} đơn đang GIAO THÀNH CÔNG sẽ bị lật — doanh thu đã chốt sẽ giảm, cần chủ shop duyệt.`);
  }
  if (report.conflicts > 0) {
    warnings.push(`${report.conflicts} vận đơn ghi 'đã giao' nhưng lịch sử không có chứng từ giao nào — không tự sửa, phải đối chiếu tay.`);
  }
  if (report.unknownEvents > 0) {
    warnings.push(`${report.unknownEvents} sự kiện có trạng thái ERP chưa hiểu — bổ sung bảng mã trước, đừng dựng lại khi còn thiếu mã.`);
  }
  return warnings;
}
