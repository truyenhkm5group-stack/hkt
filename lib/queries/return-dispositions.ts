import { asc, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import type { CostBasis } from "@/lib/constants/inspection-truth";
import {
  foldDispositions,
  isReturnDisposition,
  NON_RESTOCK_ITEM_CONDITIONS,
  PARCEL_CONDITIONS_WITHOUT_GOODS,
  TERMINAL_DISPOSITIONS,
  type DispositionEntry,
  type DispositionGrain,
  type FoldedDisposition,
  type ReturnDisposition,
} from "@/lib/constants/return-disposition";
import { LAST_RECEIPT_COST_BY_VARIANT } from "@/lib/queries/cost-basis";
import { returnProductContext, type ReturnProductContext } from "@/lib/returns/product-context";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ ĐỌC: HÀNG HOÀN KHÔNG TÁI NHẬP VÀ KẾT CỤC CỦA NÓ (Company OS · Agent E) ═══════════
 *
 * MỘT định nghĩa "đối tượng cần kết cục" (`subjectsQuery`) cho MỌI nơi đọc: hàng đợi ở trạm kiểm,
 * nguồn việc `RETURN_DISPOSITION` trên `/work`, bản tóm tắt theo mẫu cho trang 360, và chính lõi ghi
 * (`lib/returns/disposition.ts`) khi kiểm một yêu cầu. Bốn nơi tự viết bốn điều kiện thì hàng đợi nói
 * 12 món, `/work` nói 11, và không ai biết bên nào đúng.
 *
 * Tình trạng từng đối tượng gập bằng hàm THUẦN `foldDispositions` từ sổ ghi thêm. SQL chỉ lọc
 * "còn mở" bằng một tổng đơn giản (số món − tổng kết cục cuối) để cắt trang — không tự gập lần hai.
 */

type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DispositionSubject = {
  subjectKey: string;
  grain: DispositionGrain;
  inspectionId: string;
  itemId: string | null;
  shipmentId: string;
  code: string | null;
  orderId: string | null;
  orderCode: string | null;
  /** Kết luận lúc kiểm (từng món hoặc cả kiện). */
  condition: string;
  inspectNote: string;
  inspectedAt: Date | null;
  /** Số món cần kết cục: `actual_qty` của dòng món, hoặc `unsellable_qty` của kiện. */
  qty: number;
  /** Mẫu mã THỰC NHẬN. `null` với đối tượng cả kiện — không biết món nào. */
  variantId: string | null;
  productId: string | null;
  productName: string;
  sku: string;
  color: string;
  size: string;
  /** Đơn giá vốn ƯỚC TÍNH (bậc thang của `LINE_UNIT_COST`, bậc cuối CHƯA BIẾT). */
  unitCost: number | null;
  costBasis: CostBasis;
};

type SubjectRow = {
  subject_key: string;
  grain: string;
  inspection_id: string;
  item_id: string | null;
  shipment_id: string;
  code: string | null;
  tracking_code: string | null;
  order_id: string | null;
  order_code: string | null;
  condition: string | null;
  inspect_note: string | null;
  inspected_at: string | Date | null;
  qty: number | string;
  variant_id: string | null;
  product_id: string | null;
  product_name: string | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  receipt_cost: number | string | null;
  order_cost: number | string | null;
  variant_cost: number | string | null;
};

const inList = (xs: readonly string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

/**
 * ĐỐI TƯỢNG CẦN KẾT CỤC — định nghĩa DUY NHẤT (xem `DISPOSITION_GRAINS`).
 *
 * Chỉ đọc kiện ĐÃ KIỂM: kiện `RECEIVED` (chờ đếm) là việc của nguồn `RETURN_INSPECTION` và không
 * bao giờ có mặt ở đây — hai nguồn việc không chiếu cùng một kiện (luật 19).
 *
 * Giá vốn: phiếu NHẬP gần nhất (một lần quét — `LAST_RECEIPT_COST_BY_VARIANT`, không truy vấn con
 * tương quan) → giá vốn trên dòng đơn của chính đơn ấy → giá nhập mẫu mã → CHƯA BIẾT.
 */
export function subjectsQuery(where: SQL, opts: { openOnly: boolean; limit?: number } = { openOnly: false }) {
  return sql`
    with gia as ${LAST_RECEIPT_COST_BY_VARIANT},
    subj as (
      select 'item:' || ii.id as subject_key, 'ITEM'::text as grain, ii.inspection_id, ii.id as item_id,
             ii.shipment_id, coalesce(ii.actual_variant_id, ii.expected_variant_id) as variant_id,
             ii.condition::text as condition, ii.note as inspect_note, ii.inspected_at, ii.actual_qty as qty,
             coalesce(nullif(ii.actual_sku, ''), ii.expected_sku) as sku_snapshot, ii.expected_name as name_snapshot
      from return_inspection_items ii
      where ii.condition in (${inList(NON_RESTOCK_ITEM_CONDITIONS)}) and ii.actual_qty > 0
      union all
      select 'parcel:' || i0.id, 'PARCEL'::text, i0.id, null, i0.shipment_id, null,
             i0.condition::text, i0.note, i0.inspected_at, i0.unsellable_qty, '', ''
      from return_inspections i0
      where i0.status = 'INSPECTED' and i0.unsellable_qty > 0
        and coalesce(i0.condition, '') not in (${inList(PARCEL_CONDITIONS_WITHOUT_GOODS)})
        and not exists (select 1 from return_inspection_items ii2 where ii2.inspection_id = i0.id)
    ),
    xong as (
      select rd.subject_key, coalesce(sum(rd.qty) filter (where rd.disposition in (${inList(TERMINAL_DISPOSITIONS)})), 0)::int as done_qty
      from return_dispositions rd
      group by rd.subject_key
    )
    select subj.subject_key, subj.grain, subj.inspection_id, subj.item_id, subj.shipment_id,
           s.vtp_order_number as code, s.tracking_code, i.order_id,
           (select coalesce(nullif(o.custom_id, ''), o.system_id::text) from orders o where o.id = i.order_id) as order_code,
           subj.condition, subj.inspect_note, subj.inspected_at, subj.qty, subj.variant_id,
           pv.product_id, coalesce(p.name, nullif(subj.name_snapshot, ''), '') as product_name,
           coalesce(nullif(pv.sku, ''), subj.sku_snapshot, '') as sku, coalesce(pv.color, '') as color, coalesce(pv.size, '') as size,
           gia.unit_cost as receipt_cost,
           (select nullif(max(oi.unit_cost), 0) from order_items oi where oi.order_id = i.order_id and oi.variant_id = subj.variant_id) as order_cost,
           nullif(pv.last_imported_price, 0) as variant_cost
    from subj
    join return_inspections i on i.id = subj.inspection_id
    left join shipments s on s.id = subj.shipment_id
    left join product_variants pv on pv.id = subj.variant_id
    left join products p on p.id = pv.product_id
    left join gia on gia.variant_id = subj.variant_id
    left join xong on xong.subject_key = subj.subject_key
    where ${where} ${opts.openOnly ? sql`and subj.qty - coalesce(xong.done_qty, 0) > 0` : sql``}
    order by subj.inspected_at asc nulls last, subj.subject_key
    ${opts.limit ? sql`limit ${opts.limit}` : sql``}
  `;
}

const num = (v: number | string | null | undefined): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

/** Bậc giá vốn — CÙNG thứ tự với `LINE_UNIT_COST`, bậc cuối CHƯA BIẾT (không phải 0). */
export function pickUnitCost(r: { receipt_cost: number | string | null; order_cost: number | string | null; variant_cost: number | string | null }): { unitCost: number | null; basis: CostBasis } {
  const receipt = num(r.receipt_cost);
  if (receipt !== null && receipt > 0) return { unitCost: receipt, basis: "RECEIPT" };
  const order = num(r.order_cost);
  if (order !== null && order > 0) return { unitCost: order, basis: "ORDER_SNAPSHOT" };
  const variant = num(r.variant_cost);
  if (variant !== null && variant > 0) return { unitCost: variant, basis: "VARIANT_DEFAULT" };
  return { unitCost: null, basis: "UNKNOWN" };
}

function toSubject(r: SubjectRow): DispositionSubject {
  const cost = pickUnitCost(r);
  return {
    subjectKey: String(r.subject_key),
    grain: r.grain === "PARCEL" ? "PARCEL" : "ITEM",
    inspectionId: String(r.inspection_id),
    itemId: r.item_id ? String(r.item_id) : null,
    shipmentId: String(r.shipment_id),
    code: r.code ?? r.tracking_code ?? null,
    orderId: r.order_id ?? null,
    orderCode: r.order_code ?? null,
    condition: r.condition ?? "",
    inspectNote: r.inspect_note ?? "",
    inspectedAt: r.inspected_at ? new Date(r.inspected_at) : null,
    qty: Number(r.qty ?? 0),
    variantId: r.variant_id ?? null,
    productId: r.product_id ?? null,
    productName: r.product_name ?? "",
    sku: r.sku ?? "",
    color: r.color ?? "",
    size: r.size ?? "",
    unitCost: cost.unitCost,
    costBasis: cost.basis,
  };
}

export async function loadSubjects(db: DbLike, where: SQL, opts: { openOnly: boolean; limit?: number } = { openOnly: false }): Promise<DispositionSubject[]> {
  return rowsOf<SubjectRow>(await db.execute(subjectsQuery(where, opts))).map(toSubject);
}

export async function loadSubjectByKey(db: DbLike, subjectKey: string): Promise<DispositionSubject | null> {
  const [r] = await loadSubjects(db, sql`subj.subject_key = ${subjectKey}`);
  return r ?? null;
}

export type DispositionHistoryRow = {
  id: string;
  subjectKey: string;
  disposition: ReturnDisposition;
  qty: number;
  variantId: string | null;
  stockReceiptId: string | null;
  unitCostEstimate: number | null;
  costBasis: string | null;
  valueEstimate: number | null;
  note: string;
  actorUserId: string;
  actorName: string;
  createdAt: Date;
};

export async function loadEntries(db: DbLike, subjectKeys: string[]): Promise<Map<string, DispositionHistoryRow[]>> {
  const out = new Map<string, DispositionHistoryRow[]>();
  if (!subjectKeys.length) return out;
  const rd = schema.returnDispositions;
  const rows = await db.select().from(rd).where(inArray(rd.subjectKey, subjectKeys)).orderBy(asc(rd.createdAt), asc(rd.id));
  for (const r of rows) {
    if (!isReturnDisposition(r.disposition)) continue;
    const list = out.get(r.subjectKey) ?? [];
    list.push({
      id: r.id,
      subjectKey: r.subjectKey,
      disposition: r.disposition,
      qty: r.qty,
      variantId: r.variantId,
      stockReceiptId: r.stockReceiptId,
      unitCostEstimate: r.unitCostEstimate,
      costBasis: r.costBasis,
      valueEstimate: r.valueEstimate,
      note: r.note,
      actorUserId: r.actorUserId,
      actorName: r.actorName,
      createdAt: r.createdAt,
    });
    out.set(r.subjectKey, list);
  }
  return out;
}

export function foldOf(subject: Pick<DispositionSubject, "qty">, history: readonly DispositionEntry[] | undefined): FoldedDisposition {
  return foldDispositions(subject.qty, history ?? []);
}

/** Mẫu mã KỲ VỌNG của một kiện kiểm cả kiện — danh sách để người kho CHỌN khi nhập lại (không đoán hộ). */
export type ExpectedVariant = { variantId: string; sku: string; name: string; color: string; size: string; quantity: number };

export type DispositionQueueRow = DispositionSubject & {
  folded: FoldedDisposition;
  history: DispositionHistoryRow[];
  /** Chỉ với đối tượng CẢ KIỆN; rỗng khi kiện chưa ghép được đơn / mã gốc mơ hồ. */
  expectedVariants: ExpectedVariant[];
  /** Giá trị ƯỚC TÍNH của phần còn mở. `null` = CHƯA BIẾT giá vốn. */
  openValueEstimate: number | null;
};

export type DispositionQueue = {
  rows: DispositionQueueRow[];
  /** Tổng số đối tượng CÒN MỞ (không bị cắt bởi trần tải). */
  totalOpen: number;
  truncated: boolean;
  summary: {
    openQty: number;
    pendingQty: number;
    reworkQty: number;
    /** Giá trị ước tính của phần còn mở có giá vốn. */
    openValueKnown: number;
    /** Số món còn mở CHƯA BIẾT giá vốn — không cộng vào tổng trên. */
    openValueUnknownQty: number;
    /** Kiện kết luận "Thiếu hàng" cả kiện: không vào hàng đợi (xem `PARCEL_CONDITIONS_WITHOUT_GOODS`). */
    excludedMissingParcels: number;
  };
};

/** Trần tải hàng đợi. Vượt trần thì màn hình NÓI RA (không cắt im lặng). */
export const DISPOSITION_QUEUE_CAP = 1000;

export async function listDispositionQueue(opts: { limit?: number } = {}): Promise<DispositionQueue> {
  const db = await getDb();
  const limit = Math.min(DISPOSITION_QUEUE_CAP, Math.max(1, Math.trunc(opts.limit ?? DISPOSITION_QUEUE_CAP)));
  const [subjects, [dem], [thieu]] = await Promise.all([
    loadSubjects(db, sql`true`, { openOnly: true, limit }),
    db.execute(sql`select count(*)::int as n from (${subjectsQuery(sql`true`, { openOnly: true })}) q`).then((r) => rowsOf<{ n: number | string }>(r)),
    db
      .execute(sql`
        select count(*)::int as n from return_inspections i0
        where i0.status = 'INSPECTED' and i0.unsellable_qty > 0 and coalesce(i0.condition, '') in (${inList(PARCEL_CONDITIONS_WITHOUT_GOODS)})
          and not exists (select 1 from return_inspection_items ii2 where ii2.inspection_id = i0.id)
      `)
      .then((r) => rowsOf<{ n: number | string }>(r)),
  ]);
  const kienCa = subjects.filter((s) => s.grain === "PARCEL").map((s) => s.shipmentId);
  const [entries, ctx] = await Promise.all([loadEntries(db, subjects.map((s) => s.subjectKey)), kienCa.length ? returnProductContext(kienCa) : Promise.resolve(new Map<string, ReturnProductContext>())]);
  const rows: DispositionQueueRow[] = subjects.map((s) => {
    const history = entries.get(s.subjectKey) ?? [];
    const folded = foldOf(s, history);
    const c = s.grain === "PARCEL" ? ctx.get(s.shipmentId) : undefined;
    const expectedVariants: ExpectedVariant[] =
      c && c.basis !== "UNRESOLVED" && c.basis !== "AMBIGUOUS"
        ? c.items.flatMap((i) => (i.variantId ? [{ variantId: i.variantId, sku: i.sku, name: i.name, color: i.color, size: i.size, quantity: i.quantity }] : []))
        : [];
    return { ...s, folded, history, expectedVariants, openValueEstimate: s.unitCost === null ? null : s.unitCost * folded.remaining };
  });
  const summary = { openQty: 0, pendingQty: 0, reworkQty: 0, openValueKnown: 0, openValueUnknownQty: 0, excludedMissingParcels: Number(thieu?.n ?? 0) };
  for (const r of rows) {
    summary.openQty += r.folded.remaining;
    if (r.folded.state === "REWORK") summary.reworkQty += r.folded.remaining;
    else summary.pendingQty += r.folded.remaining;
    if (r.openValueEstimate === null) summary.openValueUnknownQty += r.folded.remaining;
    else summary.openValueKnown += r.openValueEstimate;
  }
  const totalOpen = Number(dem?.n ?? 0);
  return { rows, totalOpen, truncated: totalOpen > rows.length, summary };
}

export type RecentDisposition = DispositionHistoryRow & { code: string | null; sku: string; productName: string };

/** Lịch sử gần nhất — để người kho thấy việc mình vừa làm, và để quản lý đọc "ai huỷ gì". */
export async function listRecentDispositions(limit = 30): Promise<RecentDisposition[]> {
  const db = await getDb();
  const rd = schema.returnDispositions;
  const rows = await db.select().from(rd).orderBy(sql`${rd.createdAt} desc, ${rd.id} desc`).limit(Math.min(200, Math.max(1, limit)));
  if (!rows.length) return [];
  const subjects = await loadSubjects(db, sql`subj.subject_key in (${inList([...new Set(rows.map((r) => r.subjectKey))])})`);
  const bySubject = new Map(subjects.map((s) => [s.subjectKey, s]));
  return rows
    .filter((r) => isReturnDisposition(r.disposition))
    .map((r) => {
      const s = bySubject.get(r.subjectKey);
      return {
        id: r.id,
        subjectKey: r.subjectKey,
        disposition: r.disposition as ReturnDisposition,
        qty: r.qty,
        variantId: r.variantId,
        stockReceiptId: r.stockReceiptId,
        unitCostEstimate: r.unitCostEstimate,
        costBasis: r.costBasis,
        valueEstimate: r.valueEstimate,
        note: r.note,
        actorUserId: r.actorUserId,
        actorName: r.actorName,
        createdAt: r.createdAt,
        code: s?.code ?? null,
        sku: s?.sku ?? "",
        productName: s?.productName ?? "",
      };
    });
}
