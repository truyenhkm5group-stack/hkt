import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { DOMAIN_ACTOR_KIND_LABEL, DOMAIN_EVENT_BY_NAME, domainEventLabel, type DomainActorKind } from "@/lib/constants/domain-events";
import {
  isModelState,
  MODEL_STATE_LABELS,
  MODEL_STATE_UNDECLARED_LABEL,
  MODEL_STATES,
  type ModelEvidence,
  type ModelState,
  type ModelTimelineDimension,
} from "@/lib/constants/model-lifecycle";
import { PROVISIONAL_CODE_PG_REGEX } from "@/lib/constants/provisional-model";
import { loadRegistryInputs, planModelRegistry, type RegistryAmbiguous } from "@/lib/models/service";
import { spendMappedFor, spendMappedProductIds } from "@/lib/queries/model-ads";
import { erpStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import type { ListParams } from "@/lib/search-params";

/**
 * ═══════════ TRUY VẤN SỔ MẪU (Company OS · Agent A) ═══════════
 *
 * Chỉ ĐỌC. Mọi con số về mẫu đọc từ truy vấn / biểu thức có sẵn của miền chủ (sổ kho `lib/queries/stock.ts`,
 * `ad_spends`, `production_orders`, `design_concepts`) — tệp này không có công thức riêng cho một con số
 * đã có ở chỗ khác.
 */

const pm = schema.productModels;
const p = schema.products;
const dc = schema.designConcepts;
const u = schema.users;

/** Giá trị facet cho "chưa khai" — `lifecycle_state IS NULL`. */
export const MODEL_STATE_NONE = "NONE";

export const MODEL_SORTABLE = ["code", "name", "state", "stateChangedAt", "createdAt"];

export type ModelListRow = {
  id: string;
  code: string;
  name: string;
  image: string | null;
  state: ModelState | null;
  stateChangedAt: Date | null;
  registeredBy: "SYNC" | "USER";
  productId: string | null;
  productName: string | null;
  productRemoved: boolean | null;
  designConceptId: string | null;
  designCode: string | null;
  designStatus: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  createdAt: Date;
};

/** Mẫu đang mang mã tạm — bản SQL của `isProvisionalModel`. */
export function provisionalModelCond(): SQL {
  return sql`${pm.registeredBy} = 'USER' and ${pm.productId} is null and ${pm.designConceptId} is null and ${pm.code} ~ ${PROVISIONAL_CODE_PG_REGEX}`;
}

function listWhere(params: ListParams): SQL | undefined {
  const conds: SQL[] = [];
  if (params.q) {
    const q = `%${params.q.trim()}%`;
    conds.push(or(ilike(pm.code, q), ilike(pm.name, q), ilike(p.name, q))!);
  }
  const trangThai = params.filters.state ?? [];
  if (trangThai.length) {
    const khai = trangThai.filter(isModelState);
    const parts: SQL[] = [];
    if (khai.length) parts.push(inArray(pm.lifecycleState, khai));
    if (trangThai.includes(MODEL_STATE_NONE)) parts.push(isNull(pm.lifecycleState));
    if (parts.length) conds.push(or(...parts)!);
  }
  const noi = params.filters.link ?? [];
  if (noi.length) {
    const parts: SQL[] = [];
    if (noi.includes("product")) parts.push(sql`${pm.productId} is not null`);
    if (noi.includes("design")) parts.push(sql`${pm.designConceptId} is not null`);
    if (noi.includes("none")) parts.push(sql`${pm.productId} is null and ${pm.designConceptId} is null`);
    // Cùng ba vế với `isProvisionalModel` (lib/constants/provisional-model.ts) — mẫu mới test chưa lên mã.
    if (noi.includes("provisional")) parts.push(provisionalModelCond());
    if (parts.length) conds.push(or(...parts)!);
  }
  return conds.length ? and(...conds) : undefined;
}

/** Danh sách mẫu — trạng thái in là trạng thái KHAI; `null` là "Chưa khai", không phải "Đang bán". */
export async function listModels(params: ListParams): Promise<{ rows: ModelListRow[]; total: number; pageCount: number }> {
  const db = await getDb();
  const where = listWhere(params);
  const huong = params.dir === "asc" ? asc : desc;
  const sortMap: Record<string, SQL> = {
    code: sql`${pm.code}`,
    name: sql`coalesce(nullif(${pm.name}, ''), ${p.name}, '')`,
    // Thứ tự theo vòng đời, chưa khai đứng cuối khi tăng dần.
    state: sql`array_position(array[${sql.raw(MODEL_STATES.map((s) => `'${s}'`).join(","))}]::text[], ${pm.lifecycleState})`,
    stateChangedAt: sql`${pm.stateChangedAt}`,
    createdAt: sql`${pm.createdAt}`,
  };
  const sortExpr = sortMap[params.sort] ?? sortMap.code;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: pm.id,
        code: pm.code,
        name: pm.name,
        image: p.image,
        state: pm.lifecycleState,
        stateChangedAt: pm.stateChangedAt,
        registeredBy: pm.registeredBy,
        productId: pm.productId,
        productName: p.name,
        productRemoved: p.isRemoved,
        designConceptId: pm.designConceptId,
        designCode: dc.code,
        designStatus: dc.status,
        ownerUserId: pm.ownerUserId,
        ownerName: u.name,
        createdAt: pm.createdAt,
      })
      .from(pm)
      .leftJoin(p, eq(p.id, pm.productId))
      .leftJoin(dc, eq(dc.id, pm.designConceptId))
      .leftJoin(u, eq(u.id, pm.ownerUserId))
      .where(where)
      .orderBy(sql`${huong(sortExpr)} nulls last`, asc(pm.code))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize),
    db.select({ total: count() }).from(pm).leftJoin(p, eq(p.id, pm.productId)).where(where),
  ]);

  return {
    rows: rows.map((r) => ({
      ...r,
      state: isModelState(r.state) ? r.state : null,
      registeredBy: r.registeredBy === "USER" ? "USER" : "SYNC",
    })),
    total: Number(total),
    pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)),
  };
}

/** Đếm theo trạng thái khai (kể cả chưa khai) cho bộ lọc. */
export async function modelStateFacets(): Promise<{ value: string; label: string; count: number }[]> {
  const db = await getDb();
  const rows = await db.select({ state: pm.lifecycleState, n: count() }).from(pm).groupBy(pm.lifecycleState);
  const dem = new Map(rows.map((r) => [r.state ?? MODEL_STATE_NONE, Number(r.n)]));
  return [
    { value: MODEL_STATE_NONE, label: MODEL_STATE_UNDECLARED_LABEL, count: dem.get(MODEL_STATE_NONE) ?? 0 },
    ...MODEL_STATES.filter((s) => dem.has(s)).map((s) => ({ value: s, label: MODEL_STATE_LABELS[s], count: dem.get(s) ?? 0 })),
  ];
}

/** Tổng quan sổ: có mẫu nào chưa (để phân biệt "chưa đồng bộ" với "lọc không ra"). */
export async function modelRegistrySummary(): Promise<{ total: number; undeclared: number; lastSync: { at: Date; status: string; detail: string } | null }> {
  const db = await getDb();
  const [[dem], [chay]] = await Promise.all([
    db.select({ total: count(), undeclared: sql<number>`count(*) filter (where ${pm.lifecycleState} is null)` }).from(pm),
    db
      .select({ at: schema.syncRuns.startedAt, status: schema.syncRuns.status, detail: schema.syncRuns.detail })
      .from(schema.syncRuns)
      .where(eq(schema.syncRuns.job, "model-registry"))
      .orderBy(desc(schema.syncRuns.startedAt))
      .limit(1),
  ]);
  return { total: Number(dem?.total ?? 0), undeclared: Number(dem?.undeclared ?? 0), lastSync: chay ? { at: chay.at, status: chay.status, detail: chay.detail ?? "" } : null };
}

/**
 * XEM TRƯỚC lượt đồng bộ sổ — chạy đúng `planModelRegistry` của đường ghi trên dữ liệu hiện tại, KHÔNG ghi.
 * Mã mơ hồ không được lưu ở đâu (chúng không vào sổ), nên danh sách hiện trên trang luôn là phép tính
 * lúc đọc: người sửa `custom_id` trên Pancake xong thì dòng tự rời danh sách.
 */
export async function previewModelRegistry(): Promise<{ pendingInsert: number; pendingLink: number; ambiguous: RegistryAmbiguous[] }> {
  const db = await getDb();
  const plan = planModelRegistry(await loadRegistryInputs(db));
  return { pendingInsert: plan.toInsert.length, pendingLink: plan.toLink.length, ambiguous: plan.ambiguous };
}

export type ModelDetail = {
  id: string;
  code: string;
  name: string;
  state: ModelState | null;
  stateChangedAt: Date | null;
  registeredBy: "SYNC" | "USER";
  ownerUserId: string | null;
  ownerName: string | null;
  createdAt: Date;
  product: { id: string; name: string; image: string | null; customId: string | null; isRemoved: boolean; isHidden: boolean } | null;
  design: { id: string; code: string; status: string; createdAt: Date; productionAt: Date | null } | null;
};

export async function getModel(id: string): Promise<ModelDetail | null> {
  const db = await getDb();
  const [r] = await db
    .select({
      id: pm.id,
      code: pm.code,
      name: pm.name,
      state: pm.lifecycleState,
      stateChangedAt: pm.stateChangedAt,
      registeredBy: pm.registeredBy,
      ownerUserId: pm.ownerUserId,
      ownerName: u.name,
      createdAt: pm.createdAt,
      productId: p.id,
      productName: p.name,
      productImage: p.image,
      productCustomId: p.customId,
      productRemoved: p.isRemoved,
      productHidden: p.isHidden,
      designId: dc.id,
      designCode: dc.code,
      designStatus: dc.status,
      designCreatedAt: dc.createdAt,
      designProductionAt: dc.productionAt,
    })
    .from(pm)
    .leftJoin(p, eq(p.id, pm.productId))
    .leftJoin(dc, eq(dc.id, pm.designConceptId))
    .leftJoin(u, eq(u.id, pm.ownerUserId))
    .where(eq(pm.id, id))
    .limit(1);
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    state: isModelState(r.state) ? r.state : null,
    stateChangedAt: r.stateChangedAt,
    registeredBy: r.registeredBy === "USER" ? "USER" : "SYNC",
    ownerUserId: r.ownerUserId,
    ownerName: r.ownerName,
    createdAt: r.createdAt,
    product: r.productId ? { id: r.productId, name: r.productName ?? "", image: r.productImage, customId: r.productCustomId, isRemoved: !!r.productRemoved, isHidden: !!r.productHidden } : null,
    design: r.designId ? { id: r.designId, code: r.designCode ?? "", status: r.designStatus ?? "", createdAt: r.designCreatedAt!, productionAt: r.designProductionAt } : null,
  };
}

/** Mẫu của một sản phẩm (để trang sản phẩm hiện liên kết "Vòng đời mẫu"). */
export async function getModelByProductId(productId: string): Promise<{ id: string; code: string; state: ModelState | null } | null> {
  const db = await getDb();
  const [r] = await db.select({ id: pm.id, code: pm.code, state: pm.lifecycleState }).from(pm).where(eq(pm.productId, productId)).limit(1);
  return r ? { id: r.id, code: r.code, state: isModelState(r.state) ? r.state : null } : null;
}

export type ModelHistoryRow = {
  id: string;
  from: ModelState | null;
  to: ModelState;
  actorKind: DomainActorKind;
  actorName: string;
  reason: string;
  source: string;
  occurredAt: Date;
};

export async function getModelStateHistory(modelId: string): Promise<ModelHistoryRow[]> {
  const db = await getDb();
  const h = schema.productModelStateHistory;
  const rows = await db
    .select({ id: h.id, from: h.fromState, to: h.toState, actorKind: h.actorKind, actorName: h.actorName, reason: h.reason, source: h.source, occurredAt: h.occurredAt })
    .from(h)
    .where(eq(h.modelId, modelId))
    .orderBy(desc(h.occurredAt))
    .limit(100);
  return rows
    .filter((r) => isModelState(r.to))
    .map((r) => ({ ...r, from: isModelState(r.from) ? r.from : null, to: r.to as ModelState, actorKind: r.actorKind as DomainActorKind }));
}

/** Người dùng có thể nhận phụ trách mẫu — tài khoản đang hoạt động. */
export async function listModelOwnerOptions(): Promise<{ id: string; name: string }[]> {
  const db = await getDb();
  const rows = await db.select({ id: u.id, name: u.name, email: u.email }).from(u).where(eq(u.active, true)).orderBy(asc(u.name));
  return rows.map((r) => ({ id: r.id, name: r.name || r.email }));
}

/**
 * CHỨNG CỨ cho `observeModelStage` — chỉ đọc ở trang chi tiết (một mẫu), không đọc ở danh sách.
 *
 * Mọi ô là `null` khi mẫu không có nguồn tương ứng (chưa có sản phẩm ⇒ không có đơn để đếm). Đơn đếm là
 * ĐƠN LÊN (không kể huỷ / xoá), KHÔNG phải kết quả giao — kết quả giao chỉ có một công thức
 * (`ORDER_OUTCOME`) và giai đoạn quan sát không cần tới nó.
 */
/** Cửa sổ "30 ngày" của chứng cứ — một hằng cho cả đường một mẫu lẫn đường theo lô. */
export const MODEL_EVIDENCE_WINDOW_DAYS = 30;

/** Mốc đầu cửa sổ chứng cứ, tính từ `now` (mặc định: bây giờ). Bài kiểm truyền mốc CỐ ĐỊNH (luật 50, 65). */
function evidenceSince(now: Date | undefined): Date {
  return new Date((now ?? new Date()).getTime() - MODEL_EVIDENCE_WINDOW_DAYS * 86_400_000);
}

const DESIGN_EVIDENCE_STATUSES = ["DRAFT", "TESTING", "WIN", "LOSE", "PRODUCTION"] as const;

/** `design_concepts.status` → ô chứng cứ; trạng thái lạ / không có thiết kế ⇒ `null`. */
function designEvidence(status: string | null | undefined): ModelEvidence["designStatus"] {
  return status && (DESIGN_EVIDENCE_STATUSES as readonly string[]).includes(status) ? (status as ModelEvidence["designStatus"]) : null;
}

/** Chứng cứ khi CHƯA đọc nguồn nào: mọi ô đếm là `null` (CHƯA BIẾT), không phải 0. */
function evidenceBase(productRemoved: boolean | null, designStatus: string | null | undefined): ModelEvidence {
  return {
    designStatus: designEvidence(designStatus),
    productRemoved,
    adSpend30d: null,
    orders30d: null,
    ordersTotal: null,
    draftProductionOrders: null,
    sentProductionOrders: null,
    stockKnown: null,
    stockOnHand: null,
  };
}

/** Đơn đếm làm chứng cứ: không kể huỷ / xoá. MỘT điều kiện cho cả hai đường. */
function orderCountedCond(): SQL {
  return notInArray(schema.orders.stage, ["CANCELLED", "DELETED"]);
}

export async function getModelEvidence(model: Pick<ModelDetail, "product" | "design">, opts: { now?: Date } = {}): Promise<ModelEvidence> {
  const base = evidenceBase(model.product ? model.product.isRemoved : null, model.design?.status);
  if (!model.product) return base;
  const productId = model.product.id;
  const db = await getDb();
  const since = evidenceSince(opts.now);
  const variants = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.productId, productId));
  const variantIds = variants.map((v) => v.id);
  const o = schema.orders;
  const oi = schema.orderItems;
  const khongHuy = orderCountedCond();

  const [[qc], [don], [lenh], ton, daGhepChi] = await Promise.all([
    db
      .select({ spend: sql<number>`coalesce(sum(${schema.adSpends.spend}), 0)` })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.productId, productId), eq(schema.adSpends.excluded, false), gte(schema.adSpends.spendDate, since))),
    variantIds.length
      ? db
          .select({
            total: sql<number>`count(distinct ${o.id})`,
            recent: sql<number>`count(distinct ${o.id}) filter (where ${o.insertedAt} >= ${since})`,
          })
          .from(oi)
          .innerJoin(o, eq(o.id, oi.orderId))
          .where(and(inArray(oi.variantId, variantIds), khongHuy))
      : Promise.resolve([{ total: 0, recent: 0 }]),
    db
      .select({
        draft: sql<number>`count(*) filter (where ${schema.productionOrders.status} = 'DRAFT')`,
        sent: sql<number>`count(*) filter (where ${schema.productionOrders.status} = 'SENT')`,
      })
      .from(schema.productionOrders)
      .where(eq(schema.productionOrders.productId, productId)),
    variantIds.length ? stockOfVariants(variantIds) : Promise.resolve({ known: false, onHand: null }),
    // Chưa từng ghép chiến dịch nào với mã ⇒ tổng 0 ở trên là "chưa ghép", KHÔNG phải "không tiêu"
    // (luật 42, 67). Cùng cờ với tóm tắt quảng cáo của B — một nguồn.
    spendMappedFor(db, productId),
  ]);

  return {
    ...base,
    adSpend30d: daGhepChi ? Number(qc?.spend ?? 0) : null,
    orders30d: Number(don?.recent ?? 0),
    ordersTotal: Number(don?.total ?? 0),
    draftProductionOrders: Number(lenh?.draft ?? 0),
    sentProductionOrders: Number(lenh?.sent ?? 0),
    stockKnown: ton.known,
    stockOnHand: ton.onHand,
  };
}

/**
 * Tồn thực tế theo SỔ KHO cho các mẫu mã của một sản phẩm — dùng ĐÚNG `erpStockExpr` / `stockKnownExpr`
 * (AGENTS.md mục 10). Chỉ cộng mẫu mã đã có phiếu nhập; không mẫu mã nào có ⇒ `onHand = null` (CHƯA BIẾT).
 */
async function stockOfVariants(variantIds: string[]): Promise<{ known: boolean; onHand: number | null }> {
  const db = await getDb();
  const sales = variantSalesSubquery(db, variantIds);
  const receipts = variantReceiptsSubquery(db, variantIds);
  const pv = schema.productVariants;
  const known = stockKnownExpr(receipts);
  const [r] = await db
    .select({
      knownVariants: sql<number>`count(*) filter (where ${known})`,
      onHand: sql<number>`coalesce(sum(${erpStockExpr(sales, receipts)}) filter (where ${known}), 0)`,
    })
    .from(pv)
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .where(inArray(pv.id, variantIds));
  const knownVariants = Number(r?.knownVariants ?? 0);
  return knownVariants > 0 ? { known: true, onHand: Number(r?.onHand ?? 0) } : { known: false, onHand: null };
}

type StockCell = { known: boolean; onHand: number | null };

/**
 * CHỨNG CỨ THEO LÔ (Company OS · Agent Q) — cùng câu trả lời của `getModelEvidence` cho từng mẫu, nhưng
 * mỗi nguồn đọc ĐÚNG MỘT LẦN cho cả lô rồi cắt theo sản phẩm:
 *
 *  · chi QC 30 ngày: `sum(ad_spends.spend)` theo `product_id` (cùng `excluded = false`, cùng cửa sổ);
 *    đã-từng-ghép theo `spendMappedProductIds` (cùng điều kiện `spendMappedFor`) — chưa ghép ⇒ `null`;
 *  · đơn lên: `count(distinct orders.id)` theo `product_variants.product_id` (cùng `orderCountedCond`);
 *  · lệnh SX nháp / đã gửi: theo `production_orders.product_id`;
 *  · tồn: CÙNG `variantSalesSubquery` / `variantReceiptsSubquery` / `stockKnownExpr` / `erpStockExpr`,
 *    gộp theo sản phẩm thay vì một sản phẩm một lượt.
 *
 * Mẫu không tồn tại ⇒ không có trong kết quả. Không đệm: lô dùng cho một thao tác KHAI, đọc phải mới.
 * `tests/company-os-bulk-declare.test.ts` so từng ô với `getModelEvidence` trên mọi mẫu của CSDL kiểm thử.
 */
export async function getModelsEvidenceBatch(modelIds: readonly string[], opts: { now?: Date } = {}): Promise<Map<string, ModelEvidence>> {
  const out = new Map<string, ModelEvidence>();
  const ids = [...new Set(modelIds)];
  if (!ids.length) return out;
  const db = await getDb();
  const models = await db
    .select({ id: pm.id, productId: p.id, productRemoved: p.isRemoved, designStatus: dc.status })
    .from(pm)
    .leftJoin(p, eq(p.id, pm.productId))
    .leftJoin(dc, eq(dc.id, pm.designConceptId))
    .where(inArray(pm.id, ids));
  const productIds = [...new Set(models.map((m) => m.productId).filter((x): x is string => !!x))];

  const since = evidenceSince(opts.now);
  const pv = schema.productVariants;
  const o = schema.orders;
  const oi = schema.orderItems;
  const po = schema.productionOrders;
  const ads = schema.adSpends;

  const variantIds = productIds.length ? (await db.select({ id: pv.id }).from(pv).where(inArray(pv.productId, productIds))).map((v) => v.id) : [];

  const chiTheoSp = new Map<string, number>();
  const donTheoSp = new Map<string, { total: number; recent: number }>();
  const lenhTheoSp = new Map<string, { draft: number; sent: number }>();
  let daGhep = new Set<string>();
  let ton = new Map<string, StockCell>();
  if (productIds.length) {
    const [chi, ghep, don, lenh, tonKho] = await Promise.all([
      db
        .select({ productId: ads.productId, spend: sql<number>`coalesce(sum(${ads.spend}), 0)` })
        .from(ads)
        .where(and(inArray(ads.productId, productIds), eq(ads.excluded, false), gte(ads.spendDate, since)))
        .groupBy(ads.productId),
      // Chưa từng ghép ⇒ chi CHƯA BIẾT (luật 42, 67) — cùng điều kiện với `spendMappedFor` của đường một mẫu.
      spendMappedProductIds(db),
      variantIds.length
        ? db
            .select({
              productId: pv.productId,
              total: sql<number>`count(distinct ${o.id})`,
              recent: sql<number>`count(distinct ${o.id}) filter (where ${o.insertedAt} >= ${since})`,
            })
            .from(oi)
            .innerJoin(o, eq(o.id, oi.orderId))
            .innerJoin(pv, eq(pv.id, oi.variantId))
            .where(and(inArray(pv.productId, productIds), orderCountedCond()))
            .groupBy(pv.productId)
        : Promise.resolve([] as { productId: string; total: number; recent: number }[]),
      db
        .select({
          productId: po.productId,
          draft: sql<number>`count(*) filter (where ${po.status} = 'DRAFT')`,
          sent: sql<number>`count(*) filter (where ${po.status} = 'SENT')`,
        })
        .from(po)
        .where(inArray(po.productId, productIds))
        .groupBy(po.productId),
      variantIds.length ? stockOfProducts(variantIds) : Promise.resolve(new Map<string, StockCell>()),
    ]);
    for (const r of chi) chiTheoSp.set(String(r.productId), Number(r.spend ?? 0));
    for (const r of don) donTheoSp.set(String(r.productId), { total: Number(r.total ?? 0), recent: Number(r.recent ?? 0) });
    for (const r of lenh) lenhTheoSp.set(String(r.productId), { draft: Number(r.draft ?? 0), sent: Number(r.sent ?? 0) });
    daGhep = ghep;
    ton = tonKho;
  }

  for (const m of models) {
    const base = evidenceBase(m.productId ? !!m.productRemoved : null, m.designStatus);
    if (!m.productId) {
      out.set(m.id, base);
      continue;
    }
    const d = donTheoSp.get(m.productId);
    const l = lenhTheoSp.get(m.productId);
    const t = ton.get(m.productId) ?? { known: false, onHand: null };
    out.set(m.id, {
      ...base,
      adSpend30d: daGhep.has(m.productId) ? (chiTheoSp.get(m.productId) ?? 0) : null,
      orders30d: d?.recent ?? 0,
      ordersTotal: d?.total ?? 0,
      draftProductionOrders: l?.draft ?? 0,
      sentProductionOrders: l?.sent ?? 0,
      stockKnown: t.known,
      stockOnHand: t.onHand,
    });
  }
  return out;
}

/** Bản theo lô của `stockOfVariants`: cùng biểu thức sổ kho, gộp theo sản phẩm. */
async function stockOfProducts(variantIds: string[]): Promise<Map<string, StockCell>> {
  const db = await getDb();
  const sales = variantSalesSubquery(db, variantIds);
  const receipts = variantReceiptsSubquery(db, variantIds);
  const pv = schema.productVariants;
  const known = stockKnownExpr(receipts);
  const rows = await db
    .select({
      productId: pv.productId,
      knownVariants: sql<number>`count(*) filter (where ${known})`,
      onHand: sql<number>`coalesce(sum(${erpStockExpr(sales, receipts)}) filter (where ${known}), 0)`,
    })
    .from(pv)
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .where(inArray(pv.id, variantIds))
    .groupBy(pv.productId);
  return new Map(rows.map((r) => [String(r.productId), Number(r.knownVariants ?? 0) > 0 ? { known: true, onHand: Number(r.onHand ?? 0) } : { known: false, onHand: null }]));
}

// ─────────────────────────── DÒNG THỜI GIAN MẪU ───────────────────────────

export type ModelTimelineEntry = {
  id: string;
  at: Date;
  dimension: ModelTimelineDimension;
  title: string;
  detail: string;
  /** Nguồn của mốc — `Sổ mẫu` (ghi ở đây) hay tên nhật ký được CHIẾU (Lệnh SX, Phiếu kho, Pancake…). */
  source: string;
  /** `RECORDED` = sự kiện của sổ mẫu; `PROJECTED` = đọc từ nhật ký có sẵn của miền khác, không chép. */
  basis: "RECORDED" | "PROJECTED";
};

const PO_STATUS_LABEL: Record<string, string> = { DRAFT: "nháp", SENT: "đã gửi xưởng", RECEIVED: "đã nhận hàng", CANCELLED: "đã huỷ" };

/**
 * Dòng thời gian của một mẫu = `domain_events` (+ lịch sử vòng đời) ∪ PHÉP CHIẾU các nhật ký có sẵn của
 * sản phẩm (lệnh sản xuất tạo / gửi / nhận, phiếu NHẬP HÀNG cho mẫu mã, đơn đầu tiên, thiết kế). Không
 * dòng nào của miền khác bị chép vào `domain_events` (target-architecture.md Q5). Mới nhất lên trước.
 */
/**
 * Chiều của một sự kiện miền trên dòng thời gian — theo `subjectType` đã khai trong sổ sự kiện, không theo
 * tên. Company OS · QA: trước bản này MỌI sự kiện (kể cả "Chốt giá thành", "Mẫu được duyệt", "Kết cục
 * hàng hoàn") mang nhãn "Vòng đời", nên mốc sản xuất / kho của Agent C, E không bao giờ đứng đúng chiều
 * "Sản xuất" / "Kho" trên trang 360. Subject lạ ⇒ "Vòng đời" như cũ.
 */
export const EVENT_DIMENSION_BY_SUBJECT: Readonly<Record<string, ModelTimelineDimension>> = {
  /*
    Quyết định của chủ shop trên cockpit về MỘT mẫu (chấp nhận / bỏ qua / hẹn nhắc một đề xuất) —
    lớp quyết định đứng cạnh vòng đời, không thuộc miền sản xuất hay kho. Khai TƯỜNG MINH: một loại
    chủ thể mới không được lặng lẽ rơi về chiều mặc định (tests/company-os-e2e-lifecycle.test.ts).
  */
  recommendation: "LIFECYCLE",
  production_topic: "PRODUCTION",
  cost_sheet: "PRODUCTION",
  sample: "PRODUCTION",
  design_version: "PRODUCTION",
  production_order: "PRODUCTION",
  stock_receipt: "INVENTORY",
  return_inspection: "INVENTORY",
  /*
    Agent K: lời duyệt hai bước đã được thực hiện. Sự kiện mang `model_id = NULL` nên không hiện trên dòng
    thời gian mẫu nào — khai tường minh để một loại chủ thể mới không lặng lẽ rơi về chiều mặc định.
  */
  approval_request: "LIFECYCLE",
  /*
    0180: đơn tạo tay / do chatbot lên được chốt / sửa / huỷ — `model_id = NULL` nên không hiện trên dòng thời gian mẫu nào;
    khai tường minh cùng lý do với `approval_request` (đơn là miền bán hàng, không phải sản xuất hay kho).
  */
  order: "LIFECYCLE",
  /*
    Phase 3: trạng thái nghiệp vụ tự khai (field custom kiểu status) đổi giá trị. `model_id = NULL` nên không
    hiện trên dòng thời gian mẫu nào — khai tường minh cùng lý do với `approval_request`.
  */
  custom_record: "LIFECYCLE",
};

export function domainEventDimension(name: string): ModelTimelineDimension {
  const subject = DOMAIN_EVENT_BY_NAME[name]?.subjectType;
  return (subject && EVENT_DIMENSION_BY_SUBJECT[subject]) || "LIFECYCLE";
}

export async function getModelTimeline(modelId: string): Promise<ModelTimelineEntry[]> {
  const model = await getModel(modelId);
  if (!model) return [];
  const db = await getDb();
  const de = schema.domainEvents;
  const entries: ModelTimelineEntry[] = [];
  const productId = model.product?.id ?? null;

  const variantIds = productId ? (await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.productId, productId))).map((v) => v.id) : [];

  const [events, history, orders, receipts, firstOrder] = await Promise.all([
    db
      .select({ id: de.id, name: de.name, payload: de.payload, actorKind: de.actorKind, actorName: u.name, source: de.source, at: de.occurredAt })
      .from(de)
      .leftJoin(u, eq(u.id, de.actorId))
      .where(eq(de.modelId, modelId))
      .orderBy(desc(de.occurredAt))
      .limit(100),
    getModelStateHistory(modelId),
    productId
      ? db
          .select({ id: schema.productionOrders.id, code: schema.productionOrders.code, status: schema.productionOrders.status, qty: schema.productionOrders.totalQty, createdAt: schema.productionOrders.createdAt, sentAt: schema.productionOrders.sentAt, receivedAt: schema.productionOrders.receivedAt, createdBy: schema.productionOrders.createdBy, receivedBy: schema.productionOrders.receivedBy })
          .from(schema.productionOrders)
          .where(eq(schema.productionOrders.productId, productId))
          .orderBy(desc(schema.productionOrders.createdAt))
          .limit(30)
      : Promise.resolve([]),
    variantIds.length
      ? db
          .select({ id: schema.stockReceipts.id, at: schema.stockReceipts.receivedAt, reference: schema.stockReceipts.reference, supplier: schema.stockReceipts.supplier, qty: sql<number>`sum(${schema.stockReceiptItems.quantity})` })
          .from(schema.stockReceiptItems)
          .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
          .where(and(inArray(schema.stockReceiptItems.variantId, variantIds), eq(schema.stockReceipts.kind, "RECEIPT")))
          .groupBy(schema.stockReceipts.id, schema.stockReceipts.receivedAt, schema.stockReceipts.reference, schema.stockReceipts.supplier)
          .orderBy(desc(schema.stockReceipts.receivedAt))
          .limit(30)
      : Promise.resolve([]),
    variantIds.length
      ? db
          .select({ id: schema.orders.id, systemId: schema.orders.systemId, at: schema.orders.insertedAt })
          .from(schema.orderItems)
          .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
          .where(and(inArray(schema.orderItems.variantId, variantIds), notInArray(schema.orders.stage, ["CANCELLED", "DELETED"])))
          .orderBy(asc(schema.orders.insertedAt))
          .limit(1)
      : Promise.resolve([]),
  ]);

  // ── 1. SỔ MẪU: sự kiện của chính nó ──
  const lichSuTheoId = new Map(history.map((h) => [h.id, h]));
  for (const e of events) {
    const pl = (e.payload ?? {}) as Record<string, unknown>;
    let detail = "";
    if (e.name === "model.state_changed") {
      const h = typeof pl.historyId === "string" ? lichSuTheoId.get(pl.historyId) : undefined;
      const from = isModelState(pl.from) ? MODEL_STATE_LABELS[pl.from] : MODEL_STATE_UNDECLARED_LABEL;
      const to = isModelState(pl.to) ? MODEL_STATE_LABELS[pl.to] : String(pl.to ?? "—");
      detail = `${from} → ${to}${h?.reason ? ` · ${h.reason}` : ""}`;
    } else if (e.name === "model.linked") detail = pl.kind === "product" ? "Nối sản phẩm Pancake cùng mã" : "Nối thiết kế cùng mã";
    else if (e.name === "model.registered") detail = pl.registeredBy === "USER" ? "Người gõ mã mẫu mới" : "Máy đăng ký từ sản phẩm / thiết kế đang có";
    else if (e.name === "model.owner_changed") detail = pl.to ? "Có người phụ trách mới" : "Gỡ người phụ trách";
    const ai = e.actorKind === "USER" ? e.actorName || "người dùng" : DOMAIN_ACTOR_KIND_LABEL[e.actorKind as DomainActorKind] ?? e.actorKind;
    entries.push({ id: `event-${e.id}`, at: e.at, dimension: domainEventDimension(e.name), title: domainEventLabel(e.name), detail: `${detail}${detail ? " · " : ""}${ai}`, source: "Sổ mẫu", basis: "RECORDED" });
  }

  // ── 2. THIẾT KẾ (chiếu `design_concepts`) ──
  if (model.design) {
    entries.push({ id: `design-${model.design.id}`, at: model.design.createdAt, dimension: "DESIGN", title: `Thiết kế ${model.design.code} được tạo`, detail: "Vòng creative sinh thiết kế mới", source: "Thiết kế", basis: "PROJECTED" });
    if (model.design.productionAt) entries.push({ id: `design-prod-${model.design.id}`, at: model.design.productionAt, dimension: "DESIGN", title: "Thiết kế được đánh dấu đưa vào sản xuất", detail: "Người bấm trên tab Thiết kế mới", source: "Thiết kế", basis: "PROJECTED" });
  }

  // ── 3. LỆNH SẢN XUẤT (chiếu `production_orders`) ──
  for (const po of orders) {
    entries.push({ id: `po-${po.id}`, at: po.createdAt, dimension: "PRODUCTION", title: `Lệnh sản xuất ${po.code} được lập`, detail: `${po.qty.toLocaleString("vi-VN")} sản phẩm · hiện ${PO_STATUS_LABEL[po.status] ?? po.status}${po.createdBy ? ` · ${po.createdBy}` : ""}`, source: "Lệnh SX", basis: "PROJECTED" });
    if (po.sentAt) entries.push({ id: `po-sent-${po.id}`, at: po.sentAt, dimension: "PRODUCTION", title: `Lệnh ${po.code} gửi xưởng`, detail: "", source: "Lệnh SX", basis: "PROJECTED" });
    if (po.receivedAt) entries.push({ id: `po-recv-${po.id}`, at: po.receivedAt, dimension: "PRODUCTION", title: `Lệnh ${po.code} nhận hàng`, detail: po.receivedBy ? `Kho đếm xong · ${po.receivedBy}` : "Kho đếm xong", source: "Lệnh SX", basis: "PROJECTED" });
  }

  // ── 4. PHIẾU NHẬP HÀNG (chiếu `stock_receipts`, chỉ loại RECEIPT) ──
  for (const r of receipts) {
    entries.push({ id: `receipt-${r.id}`, at: r.at, dimension: "INVENTORY", title: "Phiếu nhập hàng", detail: [`${Number(r.qty).toLocaleString("vi-VN")} sản phẩm của mẫu này`, r.supplier, r.reference].filter(Boolean).join(" · "), source: "Phiếu kho", basis: "PROJECTED" });
  }

  // ── 5. ĐƠN ĐẦU TIÊN (chiếu `orders`) — đơn LÊN, không phải kết quả giao ──
  for (const o of firstOrder) {
    entries.push({ id: `first-order-${o.id}`, at: o.at, dimension: "ORDER", title: "Đơn đầu tiên của mẫu", detail: `Đơn #${o.systemId ?? o.id} (đơn lên, chưa kể kết quả giao)`, source: "Pancake", basis: "PROJECTED" });
  }

  return entries.sort((a, b) => b.at.getTime() - a.at.getTime());
}
