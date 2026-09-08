import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { sqlIsTestTracking } from "@/lib/constants/truth";
import { COD_OVERDUE_DAYS } from "@/lib/constants/cod";
import { RECONCILIATION_RULES, RECONCILIATION_RULE_ORDER, SEVERITY_ORDER, type IssueEntity, type IssueSeverity, type ReconciliationRuleKey } from "@/lib/constants/reconciliation";
import { CARRIER_DOCUMENT_SOURCES, sqlSourceList } from "@/lib/constants/truth";

/**
 * ───────────── TRUNG TÂM ĐIỀU KHIỂN CHẤT LƯỢNG DỮ LIỆU ─────────────
 *
 * Một bộ luật, một chỗ định nghĩa CÂU TRUY VẤN của từng luật, dùng lại cho cả ba việc:
 *  · đếm số vi phạm;
 *  · lấy vài ví dụ để nhìn nhanh;
 *  · mở danh sách đầy đủ (drill-down) có phân trang.
 *
 * Nhờ vậy con số trên thẻ và danh sách mở ra KHÔNG THỂ lệch nhau — lỗi kinh điển của mọi trang
 * "cảnh báo dữ liệu" viết hai truy vấn cho cùng một luật.
 *
 * KHÔNG luật nào ở đây tự sửa dữ liệu. Việc sửa nằm ở `lib/sync/consistency.ts` và chỉ đụng tới
 * ba luật xác định; ca nhập nhằng thì báo cáo, không đoán.
 */

const DOC_SOURCES = sqlSourceList(CARRIER_DOCUMENT_SOURCES);

export type IssueRow = {
  /** Mã để người vận hành nhận ra (mã vận đơn / mã đơn / mã trạng thái). */
  code: string;
  /** Bằng chứng: con số hay mốc thời gian khiến luật này bật. */
  evidence: string;
  /** Mốc thời gian gần nhất liên quan, để biết vấn đề cũ hay mới. */
  at: Date | null;
  /** Id để mở trang chi tiết. */
  entityId: string | null;
};

export type ControlTowerIssue = {
  rule: ReconciliationRuleKey;
  severity: IssueSeverity;
  entity: IssueEntity;
  label: string;
  reason: string;
  suggestedAction: string;
  autoRepairable: boolean;
  count: number;
  detectedAt: Date;
  sample: IssueRow[];
  /** Trang mở ra khi bấm vào — dùng lại drill-down sẵn có nếu có. */
  href: string | null;
};

export type ControlTower = {
  scannedAt: Date;
  issues: ControlTowerIssue[];
  totals: Record<IssueSeverity, number>;
  /** Số luật đang có vi phạm / tổng số luật ERP biết kiểm tra. */
  firing: number;
  ruleCount: number;
};

/**
 * Câu truy vấn của từng luật. Trả về dạng chung `{ code, evidence, at, entityId }` để lớp trên
 * đếm, lấy mẫu và phân trang bằng CÙNG một định nghĩa.
 */
function ruleSql(rule: ReconciliationRuleKey): SQL {
  const overdueDays = COD_OVERDUE_DAYS;
  switch (rule) {
    case "SHIPMENT_STATE_DRIFT":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'ảnh chụp ' || s.stage::text || ' · lịch sử ' || ev.normalized_stage::text as evidence,
          ev.occurred_at as at, s.id as entity_id
        from shipments s
        join lateral (
          select e.normalized_stage, e.occurred_at from shipment_events e
          where e.shipment_id = s.id and e.source in (${sql.raw(DOC_SOURCES)})
            and e.normalized_stage is not null and e.normalized_stage <> 'UNKNOWN'
            and e.leg_type is distinct from 'RETURN'
          order by e.occurred_at desc limit 1
        ) ev on true
        where ev.normalized_stage <> s.stage`;
    case "DELIVERED_WITHOUT_LOGISTICS_EVIDENCE":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'ảnh chụp ĐÃ GIAO, không có sự kiện phát thành công nào của ĐVVC' as evidence,
          coalesce(s.delivered_at, s.vtp_status_date, s.updated_at) as at, s.id as entity_id
        from shipments s
        where s.stage = 'DELIVERED'
          and not exists (select 1 from shipment_events e where e.shipment_id = s.id
            and e.source in (${sql.raw(DOC_SOURCES)}) and e.normalized_stage = 'DELIVERED')`;
    case "PAYMENT_DELIVERED_CONFLICT":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'tiền ' || s.cod_status::text || ' · vận đơn ' || s.stage::text as evidence,
          coalesce(s.cod_paid_to_bank_at, s.cod_reconciled_at, s.updated_at) as at, s.id as entity_id
        from shipments s
        where s.cod_status in ('PAID_TO_BANK','RECONCILED')
          and not exists (select 1 from shipment_events e where e.shipment_id = s.id
            and e.source in (${sql.raw(DOC_SOURCES)}) and e.normalized_stage = 'DELIVERED')`;
    case "COD_STATE_CONFLICT":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'thực thu ' || coalesce(s.cod_collected, 0)::text || 'đ · trạng thái ' || s.cod_status::text || ' · vận đơn ' || s.stage::text as evidence,
          s.updated_at as at, s.id as entity_id
        from shipments s
        where (coalesce(s.cod_collected, 0) > 0 and s.cod_status = 'NOT_APPLICABLE')
           or (s.cod_status = 'PAID_TO_BANK' and s.stage in ('RETURNED','CANCELLED') and coalesce(s.cod_collected, 0) = 0)`;
    case "COD_NOT_APPLICABLE_WITH_AMOUNT":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'ghi không thu hộ nhưng COD khai báo ' || coalesce(s.cod_amount, 0)::text || 'đ' as evidence,
          s.updated_at as at, s.id as entity_id
        from shipments s where s.cod_status = 'NOT_APPLICABLE' and coalesce(s.cod_amount, 0) > 0`;
    case "ORDER_WITH_TRACKING_NO_SHIPMENT":
      return sql`select coalesce(nullif(o.custom_id, ''), o.id) as code,
          'Pancake ghi ' || o.stage::text || ' nhưng ERP không có vận đơn' as evidence,
          o.inserted_at as at, o.id as entity_id
        from orders o left join shipments s on s.order_id = o.id
        where s.id is null and o.stage in ('SHIPPED','DELIVERED','PAID','RETURNING','PARTIAL_RETURN','RETURNED')`;
    case "SHIPMENT_WITHOUT_ORDER":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'người nhận ' || coalesce(nullif(s.receiver_name, ''), '(trống)') || ' · ' || coalesce(nullif(s.receiver_phone, ''), '(không SĐT)') as evidence,
          s.updated_at as at, s.id as entity_id
        from shipments s
        where s.order_id is null
          -- Vận đơn CHIỀU HOÀN là dòng riêng không có đơn — đúng quy ước, không phải sự cố.
          and not (s.order_reference is not null and exists (select 1 from shipments g where g.vtp_order_number = s.order_reference))
          and not (${sql.raw(sqlIsTestTracking("s.vtp_order_number"))})`;
    case "DUPLICATE_TRACKING":
      return sql`select s.tracking_code as code,
          count(*)::text || ' dòng cùng một mã vận đơn' as evidence,
          max(s.updated_at) as at, min(s.id) as entity_id
        from shipments s where s.tracking_code is not null and s.tracking_code <> ''
        group by s.tracking_code having count(*) > 1`;
    case "STALE_SHIPMENT":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          s.stage::text || ' · không có tin mới từ ' || to_char(coalesce(s.vtp_status_date, s.updated_at) at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') as evidence,
          coalesce(s.vtp_status_date, s.updated_at) as at, s.id as entity_id
        from shipments s
        where s.stage in ('PENDING','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED','RETURNING')
          and coalesce(s.vtp_status_date, s.updated_at) < now() - interval '10 days'`;
    case "UNKNOWN_VTP_STATUS":
      return sql`select e.status as code,
          count(*)::text || ' sự kiện mang mã này' as evidence,
          max(e.occurred_at) as at, min(e.shipment_id) as entity_id
        from shipment_events e
        where e.source in (${sql.raw(DOC_SOURCES)}) and (e.normalized_stage is null or e.normalized_stage = 'UNKNOWN')
        group by e.status`;
    case "INVALID_EVENT_ORDER":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'lấy hàng ' || to_char(s.picked_up_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI')
            || ' · kết thúc ' || to_char(coalesce(s.delivered_at, s.returned_at) at time zone 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') as evidence,
          coalesce(s.delivered_at, s.returned_at) as at, s.id as entity_id
        from shipments s
        where s.picked_up_at is not null
          and ((s.delivered_at is not null and s.delivered_at < s.picked_up_at)
            or (s.returned_at is not null and s.returned_at < s.picked_up_at))`;
    case "DELIVERED_WITHOUT_DATE":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'đã giao nhưng không có mốc giao' as evidence, s.updated_at as at, s.id as entity_id
        from shipments s where s.stage = 'DELIVERED' and s.delivered_at is null`;
    case "ORDER_SHIPMENT_CONFLICT":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'Pancake ' || o.stage::text || ' · Viettel Post ' || s.stage::text as evidence,
          s.updated_at as at, s.id as entity_id
        from shipments s join orders o on o.id = s.order_id
        where (o.stage in ('DELIVERED','PAID') and s.stage in ('RETURNING','RETURNED'))
           or (o.stage in ('RETURNING','PARTIAL_RETURN','RETURNED') and s.stage = 'DELIVERED')
           or (o.stage in ('CANCELLED','DELETED') and s.stage in ('DELIVERED','OUT_FOR_DELIVERY','IN_TRANSIT'))`;
    case "AMBIGUOUS_ORDER_SHIPMENT_MAPPING":
      // Cùng SĐT, nhiều vận đơn chưa có mã ⇒ bằng chứng của ĐVVC không phân biệt được đơn nào ứng
      // với vận đơn nào. Nêu ra để người xem lại, không để máy đoán.
      return sql`select coalesce(o.custom_id, o.id) as code,
          'SĐT ' || nhom.sdt || ' có ' || nhom.so_don || ' đơn chưa gắn được mã vận đơn · thu hộ ' || coalesce(s.cod_amount, 0)::text as evidence,
          s.updated_at as at, s.id as entity_id
        from shipments s
        join orders o on o.id = s.order_id
        join (
          select right(regexp_replace(coalesce(nullif(sh.receiver_phone, ''), nullif(od.ship_phone, ''), od.bill_phone, ''), '[^0-9]', '', 'g'), 9) as sdt,
                 count(*) as so_don
          from shipments sh left join orders od on od.id = sh.order_id
          where coalesce(nullif(sh.vtp_order_number, ''), nullif(sh.tracking_code, '')) is null and sh.order_id is not null
          group by 1 having count(*) > 1 and max(right(regexp_replace(coalesce(nullif(sh.receiver_phone, ''), nullif(od.ship_phone, ''), od.bill_phone, ''), '[^0-9]', '', 'g'), 9)) <> ''
        ) nhom on nhom.sdt = right(regexp_replace(coalesce(nullif(s.receiver_phone, ''), nullif(o.ship_phone, ''), o.bill_phone, ''), '[^0-9]', '', 'g'), 9)
        where coalesce(nullif(s.vtp_order_number, ''), nullif(s.tracking_code, '')) is null`;
    case "INVENTORY_RETURN_CONFLICT":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'kho nhận hàng hoàn ' || to_char(s.return_received_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') || ' nhưng vận đơn đang ' || s.stage::text as evidence,
          s.return_received_at as at, s.id as entity_id
        from shipments s
        where s.return_received_at is not null
          and s.stage not in ('RETURNING','RETURNED','DELIVERED','CANCELLED','DELIVERY_FAILED')`;
    case "FAILED_EVENT_PROCESSING":
      return sql`select coalesce(w.external_id, w.id) as code,
          w.status || coalesce(' · ' || w.error, '') as evidence,
          w.received_at as at, w.id as entity_id
        from webhook_events w
        where w.status = 'FAILED' or (w.status = 'IGNORED' and w.error ilike '%không tìm thấy%')`;
    case "COD_OVERDUE_UNPAID":
      return sql`select coalesce(s.vtp_order_number, s.tracking_code, s.id) as code,
          'thu hộ ' || coalesce(s.cod_amount, 0)::text || 'đ · giao ' || to_char(coalesce(s.delivered_at, s.vtp_status_date, s.updated_at) at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') as evidence,
          coalesce(s.delivered_at, s.vtp_status_date, s.updated_at) as at, s.id as entity_id
        from shipments s
        where s.stage = 'DELIVERED' and coalesce(s.cod_amount, 0) > 0 and coalesce(s.cod_collected, 0) = 0
          and coalesce(s.delivered_at, s.vtp_status_date, s.updated_at) < now() - (${overdueDays} * interval '1 day')`;
    case "MISSING_PRODUCT_MAPPING":
      return sql`select coalesce(nullif(i.sku, ''), i.product_name, i.id) as code,
          'đơn ' || coalesce(nullif(o.custom_id, ''), o.id) || ' · ' || coalesce(nullif(i.product_name, ''), '(không tên)') as evidence,
          o.inserted_at as at, o.id as entity_id
        from order_items i join orders o on o.id = i.order_id
        where i.variant_id is null and o.stage <> 'NEW' and o.stage not in ('CANCELLED','DELETED')`;
    case "ZERO_TOTAL_WITH_ITEMS":
      return sql`select coalesce(nullif(o.custom_id, ''), o.id) as code,
          o.items_count::text || ' dòng hàng nhưng tổng tiền 0đ' as evidence,
          o.inserted_at as at, o.id as entity_id
        from orders o
        where o.items_count > 0 and coalesce(o.total_price_after_discount, 0) = 0
          and o.stage not in ('NEW','CANCELLED','DELETED')`;
  }
}

/** Trang mở ra khi bấm vào một luật — dùng lại drill-down sẵn có nếu có. */
const RULE_HREF: Partial<Record<ReconciliationRuleKey, string>> = {
  SHIPMENT_WITHOUT_ORDER: "/data-quality?issue=unlinked-shipment",
  ORDER_SHIPMENT_CONFLICT: "/data-quality?issue=status-conflict",
  INVENTORY_RETURN_CONFLICT: "/data-quality?issue=return-not-received",
  FAILED_EVENT_PROCESSING: "/integrations",
  UNKNOWN_VTP_STATUS: "/integrations",
  COD_OVERDUE_UNPAID: "/cod",
  STALE_SHIPMENT: "/shipments",
};

type RawRow = { code: string | null; evidence: string | null; at: Date | string | null; entity_id: string | null };

function toRows(rows: RawRow[]): IssueRow[] {
  return rows.map((r) => ({
    code: r.code ?? "(không mã)",
    evidence: r.evidence ?? "",
    at: r.at ? new Date(r.at) : null,
    entityId: r.entity_id ?? null,
  }));
}

async function runRule(rule: ReconciliationRuleKey, limit: number, offset = 0) {
  const db = await getDb();
  const base = ruleSql(rule);
  const rows = await db.execute<RawRow>(sql`select * from (${base}) q order by q.at desc nulls last limit ${limit} offset ${offset}`);
  const list = Array.isArray(rows) ? (rows as RawRow[]) : ((rows as { rows: RawRow[] }).rows ?? []);
  return toRows(list);
}

async function countRule(rule: ReconciliationRuleKey): Promise<number> {
  const db = await getDb();
  const res = await db.execute<{ n: number | string }>(sql`select count(*)::int as n from (${ruleSql(rule)}) q`);
  const list = Array.isArray(res) ? (res as { n: number | string }[]) : ((res as { rows: { n: number | string }[] }).rows ?? []);
  return Number(list[0]?.n ?? 0);
}

async function controlTowerUncached(): Promise<ControlTower> {
  const scannedAt = new Date();
  // 18 luật, mỗi luật một truy vấn đếm — chúng độc lập nên chạy cùng lúc. Chạy nối tiếp thì thời
  // gian mở trang là TỔNG của 18 lần chờ, và nó tăng tuyến tính mỗi khi thêm một luật mới.
  const counts = await Promise.all(RECONCILIATION_RULE_ORDER.map(async (rule) => [rule, await countRule(rule)] as const));
  const firingRules = counts.filter(([, count]) => count > 0);
  const samples = await Promise.all(firingRules.map(([rule]) => runRule(rule, 5)));
  const issues: ControlTowerIssue[] = firingRules.map(([rule, count], index) => {
    const meta = RECONCILIATION_RULES[rule];
    return {
      rule,
      severity: meta.severity,
      entity: meta.entity,
      label: meta.label,
      reason: meta.reason,
      suggestedAction: meta.suggestedAction,
      autoRepairable: meta.autoRepair !== false,
      count,
      detectedAt: scannedAt,
      sample: samples[index],
      href: RULE_HREF[rule] ?? null,
    };
  });
  issues.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.count - a.count);
  const totals: Record<IssueSeverity, number> = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const i of issues) totals[i.severity] += i.count;
  return { scannedAt, issues, totals, firing: issues.length, ruleCount: RECONCILIATION_RULE_ORDER.length };
}

/** Tổng hợp toàn bộ bộ luật. Cache ngắn vì đây là màn hình theo dõi, không phải báo cáo chốt sổ. */
export async function getControlTower(): Promise<ControlTower> {
  return memo("controlTower", 60_000, controlTowerUncached);
}

/** Danh sách đầy đủ của MỘT luật — dùng CHÍNH câu truy vấn đã đếm nên không thể lệch con số. */
export async function controlTowerDrill(rule: ReconciliationRuleKey, page: number, pageSize: number) {
  const [rows, total] = await Promise.all([runRule(rule, pageSize, (page - 1) * pageSize), countRule(rule)]);
  return { rows, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
