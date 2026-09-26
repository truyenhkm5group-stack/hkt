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
  /** Phiếu kiểm của kiện CÓ mã. `null` ⇔ món hàng hoàn KHÔNG NHÃN (`unidentifiedId`). */
  inspectionId: string | null;
  itemId: string | null;
  /** Company OS · Agent R: món không nhãn (`return_unidentified.id`); `null` với kiện có mã. */
  unidentifiedId: string | null;
  /** Trạng thái xác định nguồn của món không nhãn — quyết QUYỀN nhập lại (`checkUnidentifiedRestock`). */
  unidentifiedStatus: string | null;
  /** Vận đơn của kiện; với món không nhãn là vận đơn ĐÃ NỐI (có thể `null` — chưa nối được). */
  shipmentId: string | null;
  /** Mã vận đơn; với món không nhãn là mã nội bộ `UR-…`. */
  code: string | null;
  orderId: string | null;
  orderCode: string | null;
  /** Kết luận lúc kiểm (từng món hoặc cả kiện). */
  condition: string;
  inspectNote: string;
  inspectedAt: Date | null;
  /** Số món cần kết cục: `actual_qty` của dòng món, hoặc `unsellable_qty` của kiện. */
  qty: number;
  /** Mẫu mã THỰC NHẬN (món không nhãn: mẫu KHO nhận diện được). `null` với đối tượng cả kiện / món chưa nhận diện. */
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
  inspection_id: string | null;
  item_id: string | null;
  unidentified_id: string | null;
  unidentified_status: string | null;
  shipment_id: string | null;
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
 * Chỉ đọc kiện ĐÃ KIỂM: kiện chờ đếm là việc của nguồn `RETURN_INSPECTION` và không bao giờ có mặt ở
 * đây — hai nguồn việc không chiếu cùng một kiện (luật 19).
 *
 * Nhánh thứ ba (Company OS · Agent R): món hàng hoàn KHÔNG NHÃN chưa vào tồn (`stock_receipt_id IS
 * NULL`) mang kết luận KHÔNG cộng tồn. Món đã vào tồn nguyên món ở bàn không nhãn thì không bao giờ ở
 * đây; món đang có dòng sổ thì bàn không nhãn KHÔNG cho đổi kết luận / tái nhập nguyên món nữa
 * (`unidentifiedLedgerRows`) — một món không đi được hai đường vào tồn.
 *
 * Giá vốn: phiếu NHẬP gần nhất (một lần quét — `LAST_RECEIPT_COST_BY_VARIANT`, không truy vấn con
 * tương quan) → giá vốn trên dòng đơn của chính đơn ấy (món không nhãn: đơn ĐÃ NỐI) → giá nhập mẫu mã →
 * CHƯA BIẾT.
 */
export function subjectsQuery(where: SQL, opts: { openOnly: boolean; limit?: number } = { openOnly: false }) {
  return sql`
    with gia as ${LAST_RECEIPT_COST_BY_VARIANT},
    subj as (
      select 'item:' || ii.id as subject_key, 'ITEM'::text as grain, ii.inspection_id, ii.id as item_id,
             null::text as unidentified_id, null::text as unidentified_status, null::text as unidentified_code, null::text as linked_order_id,
             ii.shipment_id, coalesce(ii.actual_variant_id, ii.expected_variant_id) as variant_id,
             ii.condition::text as condition, ii.note as inspect_note, ii.inspected_at, ii.actual_qty as qty,
             coalesce(nullif(ii.actual_sku, ''), ii.expected_sku) as sku_snapshot, ii.expected_name as name_snapshot
      from return_inspection_items ii
      where ii.condition in (${inList(NON_RESTOCK_ITEM_CONDITIONS)}) and ii.actual_qty > 0
      union all
      select 'parcel:' || i0.id, 'PARCEL'::text, i0.id, null, null, null, null, null, i0.shipment_id, null,
             i0.condition::text, i0.note, i0.inspected_at, i0.unsellable_qty, '', ''
      from return_inspections i0
      where i0.status = 'INSPECTED' and i0.unsellable_qty > 0
        and coalesce(i0.condition, '') not in (${inList(PARCEL_CONDITIONS_WITHOUT_GOODS)})
        and not exists (select 1 from return_inspection_items ii2 where ii2.inspection_id = i0.id)
      union all
      select 'unidentified:' || u0.id, 'UNIDENTIFIED'::text, null, null, u0.id, u0.status, u0.code, u0.linked_order_id,
             u0.linked_shipment_id, u0.variant_id,
             u0.condition, u0.note, u0.received_at, u0.quantity, u0.sku, u0.product_name
      from return_unidentified u0
      where u0.stock_receipt_id is null and u0.condition in (${inList(NON_RESTOCK_ITEM_CONDITIONS)}) and u0.quantity > 0
    ),
    xong as (
      select rd.subject_key, coalesce(sum(rd.qty) filter (where rd.disposition in (${inList(TERMINAL_DISPOSITIONS)})), 0)::int as done_qty
      from return_dispositions rd
      group by rd.subject_key
    )
    select subj.subject_key, subj.grain, subj.inspection_id, subj.item_id, subj.unidentified_id, subj.unidentified_status, subj.shipment_id,
           -- Tra ĐÚNG kiện của đối tượng (truy vấn con theo khoá), không nối đơn → vận đơn: không có grain nào để nhân.
           -- Món không nhãn: mã nội bộ UR-… là thứ người kho viết trên kiện — đứng trước mã vận đơn đã nối.
           coalesce(subj.unidentified_code, (select sv.vtp_order_number from shipments sv where sv.id = subj.shipment_id)) as code,
           (select sv.tracking_code from shipments sv where sv.id = subj.shipment_id) as tracking_code,
           coalesce(i.order_id, subj.linked_order_id) as order_id,
           (select coalesce(nullif(o.custom_id, ''), o.system_id::text) from orders o where o.id = coalesce(i.order_id, subj.linked_order_id)) as order_code,
           subj.condition, subj.inspect_note, subj.inspected_at, subj.qty, subj.variant_id,
           pv.product_id, coalesce(p.name, nullif(subj.name_snapshot, ''), '') as product_name,
           coalesce(nullif(pv.sku, ''), subj.sku_snapshot, '') as sku, coalesce(pv.color, '') as color, coalesce(pv.size, '') as size,
           gia.unit_cost as receipt_cost,
           (select nullif(max(oi.unit_cost), 0) from order_items oi where oi.order_id = coalesce(i.order_id, subj.linked_order_id) and oi.variant_id = subj.variant_id) as order_cost,
           nullif(pv.last_imported_price, 0) as variant_cost
    from subj
    left join return_inspections i on i.id = subj.inspection_id
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
    grain: r.grain === "PARCEL" ? "PARCEL" : r.grain === "UNIDENTIFIED" ? "UNIDENTIFIED" : "ITEM",
    inspectionId: r.inspection_id ? String(r.inspection_id) : null,
    itemId: r.item_id ? String(r.item_id) : null,
    unidentifiedId: r.unidentified_id ? String(r.unidentified_id) : null,
    unidentifiedStatus: r.unidentified_status ?? null,
    shipmentId: r.shipment_id ? String(r.shipment_id) : null,
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

// ───────────────────────── MÓN KHÔNG NHÃN: CẦU NỐI VỚI BÀN HÀNG KHÔNG NHÃN (Agent R) ─────────────────────────

/**
 * Số dòng sổ kết cục của một món không nhãn. Bàn hàng không nhãn (`lib/returns/unidentified.ts`) hỏi
 * câu này TRƯỚC khi cho đổi kết luận / tái nhập nguyên món: món đã vào sổ thì sổ là chủ của nó — đổi
 * kết luận sang "Đủ" rồi tái nhập nguyên món là đường vào tồn THỨ HAI cho cùng số món (và làm mồ côi
 * mọi dòng sổ đã ghi). Đọc ở đây để mọi câu SQL chạm `return_dispositions` nằm trong đúng các tệp của sổ.
 */
export async function unidentifiedLedgerRows(db: DbLike, unidentifiedId: string): Promise<number> {
  const [r] = rowsOf<{ n: number | string }>(await db.execute(sql`select count(*)::int as n from return_dispositions rd where rd.unidentified_id = ${unidentifiedId}`));
  return Number(r?.n ?? 0);
}

/**
 * Số món ĐÃ CÓ KẾT CỤC CUỐI của một món không nhãn — biểu thức SQL tương quan theo cột id đưa vào.
 * Bàn không nhãn trừ nó khỏi "đang giữ tạm": món đã nhập lại sau sửa nằm trong TỒN, món đã huỷ / trả
 * xưởng không còn trên kệ — đếm chúng là "giữ tạm" là đếm một món hai lần (tồn + giữ tạm) hoặc đếm hàng
 * không còn tồn tại.
 */
export function unidentifiedTerminalQtySql(idColumn: SQL): SQL {
  return sql`(select coalesce(sum(rd.qty), 0)::int from return_dispositions rd where rd.unidentified_id = ${idColumn} and rd.disposition in (${inList(TERMINAL_DISPOSITIONS)}))`;
}

/**
 * Số dòng `RESTOCK_AFTER_REWORK` của một món không nhãn — biểu thức SQL tương quan (Company OS · Agent U).
 * Có ít nhất một dòng ⇒ đã có hàng của món này vào tồn dưới mẫu mã đang gán, nên đổi mẫu mã phải đi phiếu
 * điều chỉnh (`checkVariantIdentify`). Một biểu thức cho cả danh sách bàn không nhãn lẫn lõi ghi.
 */
export function unidentifiedReworkRestockRowsSql(idColumn: SQL): SQL {
  return sql`(select count(*)::int from return_dispositions rd where rd.unidentified_id = ${idColumn} and rd.disposition = 'RESTOCK_AFTER_REWORK')`;
}

export async function unidentifiedReworkRestockRows(db: DbLike, unidentifiedId: string): Promise<number> {
  const [r] = rowsOf<{ n: number | string }>(await db.execute(sql`select ${unidentifiedReworkRestockRowsSql(sql`${unidentifiedId}`)} as n`));
  return Number(r?.n ?? 0);
}

/** Món không nhãn nào (trong danh sách) đã có dòng sổ — bàn không nhãn ẩn nút đổi kết luận / tái nhập nguyên món. */
export async function unidentifiedIdsInLedger(db: DbLike, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = rowsOf<{ id: string }>(await db.execute(sql`select distinct rd.unidentified_id as id from return_dispositions rd where rd.unidentified_id in (${inList(ids)})`));
  return new Set(rows.map((r) => String(r.id)));
}

/**
 * Tổng món không nhãn đã NHẬP LẠI SAU SỬA, và phần KHÔNG có chứng từ đơn — đọc thẳng cột căn cứ ghi trên
 * dòng sổ lúc nhập (`restock_authority`), không suy lại từ trạng thái HIỆN TẠI của món (món có thể được
 * nối đơn SAU khi đã nhập — lượt nhập lúc ấy vẫn là không chứng từ).
 */
export async function unidentifiedReworkRestockTotals(db: DbLike): Promise<{ units: number; overrideUnits: number }> {
  const [r] = rowsOf<{ units: number | string; override_units: number | string }>(
    await db.execute(sql`
      select coalesce(sum(rd.qty), 0)::int as units,
             coalesce(sum(rd.qty) filter (where rd.restock_authority = 'MANAGER_OVERRIDE'), 0)::int as override_units
      from return_dispositions rd
      where rd.unidentified_id is not null and rd.disposition = 'RESTOCK_AFTER_REWORK'
    `),
  );
  return { units: Number(r?.units ?? 0), overrideUnits: Number(r?.override_units ?? 0) };
}

/**
 * MÓN KHÔNG NHÃN CHƯA GÁN MẪU — con số cấp SHOP, không cấp mẫu.
 *
 * Món không nhãn mà kho CHƯA nhận diện được mẫu mã (`variant_id IS NULL`) không được quy về mẫu nào
 * (luật 35 — không đoán). Nó cũng không được biến mất: tóm tắt theo mẫu (`getModelReturnDispositions`)
 * bỏ nó ra, nên nó đứng riêng ở đây và hiện trên `/inventory/returns`.
 */
export type UnassignedUnidentified = {
  subjects: number;
  openQty: number;
  writtenOffQty: number;
  returnedToSupplierQty: number;
};

export async function unassignedUnidentifiedDispositions(db: DbLike): Promise<UnassignedUnidentified> {
  const subjects = await loadSubjects(db, sql`subj.grain = 'UNIDENTIFIED' and subj.variant_id is null`);
  const entries = await loadEntries(db, subjects.map((x) => x.subjectKey));
  const out: UnassignedUnidentified = { subjects: subjects.length, openQty: 0, writtenOffQty: 0, returnedToSupplierQty: 0 };
  for (const x of subjects) {
    const f = foldOf(x, entries.get(x.subjectKey));
    out.openQty += f.remaining;
    out.writtenOffQty += f.writtenOff;
    out.returnedToSupplierQty += f.returnedToSupplier;
  }
  return out;
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
    /** Món hàng hoàn KHÔNG NHÃN còn mở trong hàng đợi (Agent R) — một phần của `openQty`, không cộng thêm. */
    unidentifiedOpenQty: number;
  };
  /** Món không nhãn chưa gán mẫu mã — con số cấp shop (không nằm ở mẫu nào). */
  unidentifiedUnassigned: UnassignedUnidentified;
};

/** Trần tải hàng đợi. Vượt trần thì màn hình NÓI RA (không cắt im lặng). */
export const DISPOSITION_QUEUE_CAP = 1000;

export async function listDispositionQueue(opts: { limit?: number } = {}): Promise<DispositionQueue> {
  const db = await getDb();
  const limit = Math.min(DISPOSITION_QUEUE_CAP, Math.max(1, Math.trunc(opts.limit ?? DISPOSITION_QUEUE_CAP)));
  const [subjects, [dem], [thieu], chuaGan] = await Promise.all([
    loadSubjects(db, sql`true`, { openOnly: true, limit }),
    db.execute(sql`select count(*)::int as n from (${subjectsQuery(sql`true`, { openOnly: true })}) q`).then((r) => rowsOf<{ n: number | string }>(r)),
    db
      .execute(sql`
        select count(*)::int as n from return_inspections i0
        where i0.status = 'INSPECTED' and i0.unsellable_qty > 0 and coalesce(i0.condition, '') in (${inList(PARCEL_CONDITIONS_WITHOUT_GOODS)})
          and not exists (select 1 from return_inspection_items ii2 where ii2.inspection_id = i0.id)
      `)
      .then((r) => rowsOf<{ n: number | string }>(r)),
    unassignedUnidentifiedDispositions(db),
  ]);
  const kienCa = subjects.flatMap((s) => (s.grain === "PARCEL" && s.shipmentId ? [s.shipmentId] : []));
  const [entries, ctx] = await Promise.all([loadEntries(db, subjects.map((s) => s.subjectKey)), kienCa.length ? returnProductContext(kienCa) : Promise.resolve(new Map<string, ReturnProductContext>())]);
  const rows: DispositionQueueRow[] = subjects.map((s) => {
    const history = entries.get(s.subjectKey) ?? [];
    const folded = foldOf(s, history);
    const c = s.grain === "PARCEL" && s.shipmentId ? ctx.get(s.shipmentId) : undefined;
    const expectedVariants: ExpectedVariant[] =
      c && c.basis !== "UNRESOLVED" && c.basis !== "AMBIGUOUS"
        ? c.items.flatMap((i) => (i.variantId ? [{ variantId: i.variantId, sku: i.sku, name: i.name, color: i.color, size: i.size, quantity: i.quantity }] : []))
        : [];
    return { ...s, folded, history, expectedVariants, openValueEstimate: s.unitCost === null ? null : s.unitCost * folded.remaining };
  });
  const summary = { openQty: 0, pendingQty: 0, reworkQty: 0, openValueKnown: 0, openValueUnknownQty: 0, excludedMissingParcels: Number(thieu?.n ?? 0), unidentifiedOpenQty: 0 };
  for (const r of rows) {
    summary.openQty += r.folded.remaining;
    if (r.grain === "UNIDENTIFIED") summary.unidentifiedOpenQty += r.folded.remaining;
    if (r.folded.state === "REWORK") summary.reworkQty += r.folded.remaining;
    else summary.pendingQty += r.folded.remaining;
    if (r.openValueEstimate === null) summary.openValueUnknownQty += r.folded.remaining;
    else summary.openValueKnown += r.openValueEstimate;
  }
  const totalOpen = Number(dem?.n ?? 0);
  return { rows, totalOpen, truncated: totalOpen > rows.length, summary, unidentifiedUnassigned: chuaGan };
}

export type RecentDisposition = DispositionHistoryRow & { code: string | null; sku: string; productName: string; grain: DispositionGrain | null };

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
        grain: s?.grain ?? null,
      };
    });
}
