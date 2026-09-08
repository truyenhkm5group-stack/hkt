/**
 * ───────────────────── BỘ MÁY ĐỐI SOÁT DỮ LIỆU VẬN ĐƠN / COD ─────────────────────
 *
 * QUÉT TRƯỚC, SỬA SAU — và chỉ sửa những gì XÁC ĐỊNH.
 *
 * Bản cũ của tệp này vi phạm trực tiếp `docs/business-rules/ORDER_OUTCOME.md`:
 *  · thấy "COD đã về ngân hàng / đã đối soát" là ghi thẳng vận đơn thành `stage = 'DELIVERED'` —
 *    tức SUY TRẠNG THÁI GIAO HÀNG TỪ TIỀN, điều đặc tả cấm ở mục 10, đồng thời phá bất biến
 *    "trạng thái vận đơn là hàm của lịch sử sự kiện";
 *  · hạ `cod_status` của đơn hoàn/huỷ về `NOT_APPLICABLE`, xoá sạch dấu vết thu hộ nên không còn
 *    đòi được tiền Viettel Post — mâu thuẫn với chính `lib/constants/cod.ts`;
 *  · lấy `updated_at` của ERP làm mốc giao hàng khi thiếu mốc — bịa chứng từ.
 * (Chi tiết: F1/F2 trong `docs/erp-data-truth-audit.md`.)
 *
 * Nay:
 *  · `scanReconciliation()` — CHỈ ĐỌC. Chạy được mọi lúc, không đụng vào dữ liệu.
 *  · `repairReconciliation()` — chỉ sửa hai luật có `autoRepair` trong
 *    `lib/constants/reconciliation.ts`, và cả hai đều sửa THEO NGUỒN SỰ THẬT CỦA CHÍNH CHIỀU ĐÓ:
 *      - ảnh chụp vận đơn ← dựng lại từ lịch sử sự kiện;
 *      - "không thu hộ" sai ← chính số tiền thu hộ trên vận đơn.
 *    Mọi lệch GIỮA HAI CHIỀU đều chỉ báo cáo: máy không biết bên nào đúng.
 *  · Mỗi lần sửa đều ghi `audit_logs` để truy nguyên được.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { codStatusForAmount } from "@/lib/constants/cod";
import { COD_OVERDUE_DAYS } from "@/lib/constants/cod";
import { CARRIER_DOCUMENT_SOURCES, sqlSourceList } from "@/lib/constants/truth";
import { RECONCILIATION_RULES, type IssueSeverity, type ReconciliationRuleKey } from "@/lib/constants/reconciliation";
import { materializeShipmentState } from "@/lib/integrations/viettelpost/state";

const s = schema.shipments;
const o = schema.orders;
const DOC_SOURCES = sqlSourceList(CARRIER_DOCUMENT_SOURCES);

export type ReconciliationIssue = {
  rule: ReconciliationRuleKey;
  severity: IssueSeverity;
  label: string;
  count: number;
  /** Vài ví dụ để mở ra xem ngay, không phải cả danh sách. */
  sample: string[];
  /** Luật này có được ERP tự sửa không. */
  autoRepairable: boolean;
  suggestedAction: string;
};

export type ReconciliationScan = {
  scannedAt: Date;
  /** Chỉ quét dữ liệu thay đổi gần đây (null = quét toàn bộ). */
  sinceDays: number | null;
  issues: ReconciliationIssue[];
  totals: Record<IssueSeverity, number>;
};

/** Đóng gói một luật thành issue; count = 0 thì bỏ khỏi kết quả ở lớp trên. */
function issueOf(rule: ReconciliationRuleKey, count: number, sample: string[]): ReconciliationIssue {
  const meta = RECONCILIATION_RULES[rule];
  return {
    rule,
    severity: meta.severity,
    label: meta.label,
    count,
    sample: sample.slice(0, 10),
    autoRepairable: meta.autoRepair !== false,
    suggestedAction: meta.suggestedAction,
  };
}

const code = sql<string>`coalesce(${s.vtpOrderNumber}, ${s.trackingCode}, ${s.id})`;

/**
 * TRẠNG THÁI DỰNG TỪ LỊCH SỬ khác với ảnh chụp đang lưu.
 * Chỉ xét sự kiện đến thẳng từ ĐVVC và có trạng thái chuẩn hoá; sự kiện mới nhất theo mốc ĐVVC.
 */
const STATE_DRIFT = sql`exists (
  select 1 from shipment_events ev
  where ev.shipment_id = ${s.id}
    and ev.source in (${sql.raw(DOC_SOURCES)})
    and ev.normalized_stage is not null and ev.normalized_stage <> 'UNKNOWN'
    and ev.occurred_at = (
      select max(e2.occurred_at) from shipment_events e2
      where e2.shipment_id = ${s.id} and e2.source in (${sql.raw(DOC_SOURCES)})
        and e2.normalized_stage is not null and e2.normalized_stage <> 'UNKNOWN'
    )
    and ev.normalized_stage <> ${s.stage}
    and ev.leg_type is distinct from 'RETURN'
)`;

/** Phạm vi quét gia tăng: chỉ vận đơn có thay đổi trong N ngày gần đây. */
function recentOnly(sinceDays: number | null) {
  if (!sinceDays) return undefined;
  const from = new Date(Date.now() - sinceDays * 86_400_000);
  return sql`coalesce(${s.vtpStatusDate}, ${s.updatedAt}) >= ${from.toISOString()}::timestamptz`;
}

export type ScanOptions = {
  /** Chỉ quét dữ liệu N ngày gần đây (quét gia tăng). Bỏ trống = quét toàn bộ. */
  sinceDays?: number;
  /** Ngưỡng "treo lâu" cho vận đơn chưa kết thúc. */
  staleDays?: number;
};

/**
 * QUÉT CHỈ ĐỌC. Không sửa gì, chạy được cả trên giờ cao điểm.
 */
export async function scanReconciliation(options: ScanOptions = {}): Promise<ReconciliationScan> {
  const db = await getDb();
  const staleDays = options.staleDays ?? 10;
  const sinceDays = options.sinceDays ?? null;
  const scope = recentOnly(sinceDays);
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - staleDays * 86_400_000);
  const codOverdueCutoff = new Date(now.getTime() - COD_OVERDUE_DAYS * 86_400_000);
  const withScope = (cond: ReturnType<typeof sql>) => (scope ? and(cond, scope) : cond);

  const sampleOf = (rows: { code: string }[]) => rows.map((r) => r.code);

  const [drift, codNotApplicable, paymentConflict, codConflict, orderNoShipment, shipmentNoOrder, duplicateTracking, stale, unknownStatus, invalidOrder, deliveredNoDate, orderShipmentConflict, inventoryConflict, failedEvents, codOverdue] =
    await Promise.all([
      db.select({ code }).from(s).where(withScope(STATE_DRIFT)).limit(500),
      db.select({ code }).from(s).where(withScope(sql`${s.codStatus} = 'NOT_APPLICABLE' and coalesce(${s.codAmount}, 0) > 0`)).limit(500),
      // TIỀN ĐÃ VỀ MÀ CHƯA CÓ CHỨNG TỪ GIAO HÀNG — chỉ báo cáo, không bao giờ tự sửa.
      db
        .select({ code })
        .from(s)
        .where(
          withScope(
            sql`${s.codStatus} in ('PAID_TO_BANK','RECONCILED')
              and not exists (
                select 1 from shipment_events ev
                where ev.shipment_id = ${s.id} and ev.source in (${sql.raw(DOC_SOURCES)})
                  and ev.normalized_stage = 'DELIVERED'
              )`,
          ),
        )
        .limit(500),
      db
        .select({ code })
        .from(s)
        .where(
          withScope(
            sql`(coalesce(${s.codCollected}, 0) > 0 and ${s.codStatus} = 'NOT_APPLICABLE')
              or (${s.codStatus} = 'PAID_TO_BANK' and ${s.stage} in ('RETURNED','CANCELLED') and coalesce(${s.codCollected}, 0) = 0)`,
          ),
        )
        .limit(500),
      db
        .select({ code: sql<string>`coalesce(${o.customId}, ${o.id})` })
        .from(o)
        .leftJoin(s, eq(s.orderId, o.id))
        .where(and(isNull(s.id), inArray(o.stage, ["SHIPPED", "DELIVERED", "PAID", "RETURNING", "PARTIAL_RETURN", "RETURNED"])))
        .limit(500),
      db.select({ code }).from(s).where(isNull(s.orderId)).limit(500),
      db
        .select({ code: sql<string>`${s.trackingCode}` })
        .from(s)
        .where(isNotNull(s.trackingCode))
        .groupBy(s.trackingCode)
        .having(sql`count(*) > 1`)
        .limit(500),
      db
        .select({ code })
        .from(s)
        .where(and(inArray(s.stage, ["PENDING", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERY_FAILED", "RETURNING"]), lt(sql`coalesce(${s.vtpStatusDate}, ${s.updatedAt})`, staleCutoff)))
        .limit(500),
      db
        .select({ code: schema.shipmentEvents.status, n: sql<number>`count(*)` })
        .from(schema.shipmentEvents)
        .where(sql`${schema.shipmentEvents.source} in (${sql.raw(DOC_SOURCES)}) and (${schema.shipmentEvents.normalizedStage} is null or ${schema.shipmentEvents.normalizedStage} = 'UNKNOWN')`)
        .groupBy(schema.shipmentEvents.status)
        .limit(100),
      db
        .select({ code })
        .from(s)
        .where(
          withScope(
            sql`(${s.deliveredAt} is not null and ${s.pickedUpAt} is not null and ${s.deliveredAt} < ${s.pickedUpAt})
              or (${s.returnedAt} is not null and ${s.pickedUpAt} is not null and ${s.returnedAt} < ${s.pickedUpAt})`,
          ),
        )
        .limit(500),
      db.select({ code }).from(s).where(withScope(sql`${s.stage} = 'DELIVERED' and ${s.deliveredAt} is null`)).limit(500),
      db
        .select({ code })
        .from(s)
        .innerJoin(o, eq(o.id, s.orderId))
        .where(
          sql`(${o.stage} in ('DELIVERED','PAID') and ${s.stage} in ('RETURNING','RETURNED'))
            or (${o.stage} in ('RETURNING','PARTIAL_RETURN','RETURNED') and ${s.stage} = 'DELIVERED')
            or (${o.stage} in ('CANCELLED','DELETED') and ${s.stage} in ('DELIVERED','OUT_FOR_DELIVERY','IN_TRANSIT'))`,
        )
        .limit(500),
      db
        .select({ code })
        .from(s)
        .where(and(isNotNull(s.returnReceivedAt), sql`${s.stage} not in ('RETURNING','RETURNED','DELIVERED','CANCELLED','DELIVERY_FAILED')`))
        .limit(500),
      db
        .select({ code: sql<string>`coalesce(${schema.webhookEvents.externalId}, ${schema.webhookEvents.id})` })
        .from(schema.webhookEvents)
        .where(sql`(${schema.webhookEvents.status} = 'FAILED' or (${schema.webhookEvents.status} = 'IGNORED' and ${schema.webhookEvents.error} ilike '%không tìm thấy%'))`)
        .limit(500),
      db
        .select({ code })
        .from(s)
        .where(
          and(
            eq(s.stage, "DELIVERED"),
            gt(sql`coalesce(${s.codAmount}, 0)`, 0),
            sql`coalesce(${s.codCollected}, 0) = 0`,
            lt(sql`coalesce(${s.deliveredAt}, ${s.vtpStatusDate}, ${s.updatedAt})`, codOverdueCutoff),
          ),
        )
        .limit(500),
    ]);

  const all: ReconciliationIssue[] = [
    issueOf("SHIPMENT_STATE_DRIFT", drift.length, sampleOf(drift)),
    issueOf("COD_NOT_APPLICABLE_WITH_AMOUNT", codNotApplicable.length, sampleOf(codNotApplicable)),
    issueOf("PAYMENT_DELIVERED_CONFLICT", paymentConflict.length, sampleOf(paymentConflict)),
    issueOf("COD_STATE_CONFLICT", codConflict.length, sampleOf(codConflict)),
    issueOf("ORDER_WITH_TRACKING_NO_SHIPMENT", orderNoShipment.length, sampleOf(orderNoShipment)),
    issueOf("SHIPMENT_WITHOUT_ORDER", shipmentNoOrder.length, sampleOf(shipmentNoOrder)),
    issueOf("DUPLICATE_TRACKING", duplicateTracking.length, sampleOf(duplicateTracking)),
    issueOf("STALE_SHIPMENT", stale.length, sampleOf(stale)),
    issueOf("UNKNOWN_VTP_STATUS", unknownStatus.length, unknownStatus.map((r) => `${r.code} (${Number(r.n)} sự kiện)`)),
    issueOf("INVALID_EVENT_ORDER", invalidOrder.length, sampleOf(invalidOrder)),
    issueOf("DELIVERED_WITHOUT_DATE", deliveredNoDate.length, sampleOf(deliveredNoDate)),
    issueOf("ORDER_SHIPMENT_CONFLICT", orderShipmentConflict.length, sampleOf(orderShipmentConflict)),
    issueOf("INVENTORY_RETURN_CONFLICT", inventoryConflict.length, sampleOf(inventoryConflict)),
    issueOf("FAILED_EVENT_PROCESSING", failedEvents.length, sampleOf(failedEvents)),
    issueOf("COD_OVERDUE_UNPAID", codOverdue.length, sampleOf(codOverdue)),
  ];

  const issues = all.filter((i) => i.count > 0);
  const totals: Record<IssueSeverity, number> = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const i of issues) totals[i.severity] += i.count;
  return { scannedAt: now, sinceDays, issues, totals };
}

export type RepairResult = {
  /** Đã thật sự ghi hay chỉ chạy thử. */
  applied: boolean;
  /** Dựng lại ảnh chụp vận đơn từ lịch sử. */
  stateRebuilt: { candidates: number; changed: number };
  /** Sửa nhãn "không thu hộ" sai theo chính số tiền thu hộ. */
  codLabelFixed: { candidates: number; changed: number };
  /** Những gì CỐ Ý không sửa, kèm lý do — để người đọc báo cáo không tưởng là bỏ sót. */
  reportedOnly: { rule: ReconciliationRuleKey; count: number; why: string }[];
};

/**
 * SỬA những gì XÁC ĐỊNH. `apply = false` (mặc định) là chạy thử: đếm ra sẽ sửa bao nhiêu, không ghi gì.
 *
 * Hai luật duy nhất được sửa, và cả hai đều lấy nguồn sự thật CỦA CHÍNH CHIỀU ĐÓ:
 *  1. ảnh chụp vận đơn lệch lịch sử → dựng lại từ `shipment_events`;
 *  2. `cod_status = NOT_APPLICABLE` nhưng vận đơn có tiền thu hộ → đưa về `PENDING` (CHƯA BIẾT).
 *
 * Mọi lệch giữa hai chiều (tiền ↔ giao hàng) chỉ được BÁO CÁO.
 */
export async function repairReconciliation(options: ScanOptions & { apply?: boolean; actor?: string } = {}): Promise<RepairResult> {
  const db = await getDb();
  const apply = Boolean(options.apply);
  const actor = options.actor || "job:data-check";
  const scope = recentOnly(options.sinceDays ?? null);
  const withScope = (cond: ReturnType<typeof sql>) => (scope ? and(cond, scope) : cond);

  const driftRows = await db.select({ id: s.id, code }).from(s).where(withScope(STATE_DRIFT)).limit(5000);
  // Thiếu mốc giao cũng chữa được bằng cùng một cách: dựng lại từ lịch sử. Nếu lịch sử không có
  // mốc nào thì để trống — KHÔNG lấy updated_at của ERP thay vào.
  const noDateRows = await db
    .select({ id: s.id, code })
    .from(s)
    .where(withScope(sql`${s.stage} = 'DELIVERED' and ${s.deliveredAt} is null`))
    .limit(5000);
  const rebuildIds = [...new Map([...driftRows, ...noDateRows].map((r) => [r.id, r])).values()];

  const codRows = await db
    .select({ id: s.id, code, codAmount: s.codAmount, codStatus: s.codStatus })
    .from(s)
    .where(withScope(sql`${s.codStatus} = 'NOT_APPLICABLE' and coalesce(${s.codAmount}, 0) > 0`))
    .limit(5000);

  let stateChanged = 0;
  let codChanged = 0;
  if (apply) {
    for (const row of rebuildIds) {
      const result = await materializeShipmentState(db, row.id);
      if (result.changed) stateChanged += 1;
    }
    for (const row of codRows) {
      const next = codStatusForAmount(row.codAmount ?? 0, row.codStatus);
      if (next === row.codStatus) continue;
      await db.update(s).set({ codStatus: next, updatedAt: new Date() }).where(eq(s.id, row.id));
      codChanged += 1;
    }
    if (stateChanged || codChanged) {
      await audit({
        userEmail: actor,
        action: "reconcile.repair",
        entity: "shipment",
        detail: {
          stateRebuilt: stateChanged,
          codLabelFixed: codChanged,
          note: "Chỉ sửa theo nguồn sự thật của chính chiều đó; lệch giữa tiền và giao hàng chỉ báo cáo.",
        },
      });
    }
  }

  return {
    applied: apply,
    stateRebuilt: { candidates: rebuildIds.length, changed: stateChanged },
    codLabelFixed: { candidates: codRows.length, changed: codChanged },
    reportedOnly: [
      { rule: "PAYMENT_DELIVERED_CONFLICT", count: 0, why: "Không được lấy tiền để kết luận đã giao (ORDER_OUTCOME.md mục 10)." },
      { rule: "COD_STATE_CONFLICT", count: 0, why: "Máy không biết chứng từ nào đúng; sửa bừa là bịa số." },
      { rule: "ORDER_SHIPMENT_CONFLICT", count: 0, why: "ERP không ghi ngược lại Pancake." },
      { rule: "INVENTORY_RETURN_CONFLICT", count: 0, why: "Chỉ kho đếm thực tế mới quyết được tồn." },
    ],
  };
}

/**
 * Điểm vào của job `data-check`.
 * Luôn QUÉT trước; chỉ khi `fix = true` mới chạy phần sửa xác định.
 */
export async function checkShipmentConsistency(options: { fix?: boolean; staleDays?: number; sinceDays?: number; actor?: string } = {}) {
  const scan = await scanReconciliation({ staleDays: options.staleDays, sinceDays: options.sinceDays });
  const repair = await repairReconciliation({ apply: Boolean(options.fix), sinceDays: options.sinceDays, actor: options.actor });
  const counts = Object.fromEntries(scan.issues.map((i) => [i.rule, i.count]));
  return {
    fix: Boolean(options.fix),
    scannedAt: scan.scannedAt,
    totals: scan.totals,
    issues: scan.issues,
    repair: {
      ...repair,
      reportedOnly: repair.reportedOnly.map((r) => ({ ...r, count: counts[r.rule] ?? 0 })),
    },
  };
}
