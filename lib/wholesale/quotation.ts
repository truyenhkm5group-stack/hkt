import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { chayKhongJit, getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { liveLineUnitCost } from "@/lib/constants/live-cogs";
import type { PriceListBook } from "@/lib/constants/price-lists";
import { vnDateKey } from "@/lib/format";
import { VARIANT_CURRENT_MARKETER_COST } from "@/lib/queries/current-marketer-cost";
import { priceBooksFor } from "@/lib/queries/price-lists";
import { availableStockExpr, LAST_RECEIPT_COST, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { getSettingJson } from "@/lib/settings";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import {
  computeQuotation,
  effectiveQuotationStatus,
  INCOTERMS,
  parseQuotationPolicy,
  QUOTATION_LIMITS,
  QUOTATION_SETTING_KEY,
  QUOTATION_STATUS_LABEL,
  REVISABLE_STATUSES,
  type EngineVariant,
  type QuotationPolicy,
  type QuotationResult,
} from "@/lib/wholesale/quotation-engine";

/**
 * ═══════════ BÁO GIÁ SỈ — LÕI GHI (CHỈ MÁY CHỦ) — docs/tech/hslc-b2b-sales-agent.md · P1b ═══════════
 *
 * Mỗi lối vào: quyền (`wholesale:work` lập / sửa / gửi / ghi kết quả; `wholesale:config` duyệt — không thêm khoá quyền mới) →
 * phạm vi dữ liệu (cùng mệnh đề với danh sách lead: báo giá của lead ngoài phạm vi thì không chạm được; báo giá chỉ gắn khách
 * thì người phạm vi hẹp chỉ chạm bản mình lập) → zod → bộ tính THUẦN `computeQuotation` → ghi → `audit`.
 *
 *  · Tiền tính MỘT LẦN lúc lập phiên bản, lưu cùng `snapshot` (đầu vào + kết quả). Không đường nào tính lại một bản đã ghi —
 *    trigger CSDL chặn cả lượt UPDATE lỡ tay. Sửa = phiên bản mới; bản trước thành «Đã có bản mới».
 *  · Bấm hai lần không đẻ hai bản: `request_key` (do form cấp một lần) là khoá duy nhất; mỗi bản có tối đa MỘT bản kế (chỉ mục
 *    duy nhất `parent_quotation_id`) — hai người cùng sửa một bản thì người sau nhận lỗi, không có hai nhánh.
 *  · Người lập KHÔNG tự duyệt (kiểm ở đây + CHECK ở CSDL). Hết hạn tính lúc đọc, không ghi đè lịch sử.
 *  · CHƯA gửi email ở bước này: «đã gửi» là lời khai của người, kèm link trang in.
 */

export const QUOTATION_TABLES_MISSING = "CSDL của tổ chức chưa áp migration 0263 (báo giá sỉ) — chờ lượt cập nhật lược đồ rồi thử lại.";

/** Bảng chưa có (CSDL chưa áp 0263) — MIGRATION_SERVE_COMPAT. */
export function isMissingQuotationTable(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "42P01";
}

const FORBIDDEN_WORK = "Bạn không có quyền lập báo giá sỉ (wholesale:work).";
const FORBIDDEN_APPROVE = "Bạn không có quyền duyệt báo giá sỉ (wholesale:config).";

// ─────────────────────────── Đầu vào ───────────────────────────

const amountZ = z.number({ error: "Nhập số tiền" }).int("Số tiền là số nguyên (đồng)").min(0, "Số tiền không âm").max(QUOTATION_LIMITS.maxAmount);

export const quotationInputSchema = z
  .object({
    leadId: z.string().trim().max(64).nullable().default(null),
    customerId: z.string().trim().max(64).nullable().default(null),
    lines: z
      .array(
        z
          .object({
            variantId: z.string().trim().min(1, "Chọn mẫu mã").max(200),
            quantity: z.number({ error: "Nhập số lượng" }).int("Số lượng là số nguyên").min(1, "Số lượng từ 1").max(QUOTATION_LIMITS.maxQuantity),
            lineDiscount: amountZ.default(0),
          })
          .strict(),
      )
      .min(1, "Thêm ít nhất một dòng hàng")
      .max(QUOTATION_LIMITS.maxLines),
    quoteDiscount: amountZ.default(0),
    shippingAmount: amountZ.nullable().default(null),
    shippingSource: z.string().trim().max(QUOTATION_LIMITS.sourceMax).default(""),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày hiệu lực dạng YYYY-MM-DD"),
    incoterm: z.enum(INCOTERMS).nullable().default(null),
    notes: z.string().trim().max(QUOTATION_LIMITS.notesMax).default(""),
    requestKey: z.string().trim().min(8).max(100),
  })
  .strict()
  .refine((v) => Boolean(v.leadId || v.customerId), { message: "Chọn lead hoặc khách hàng nhận báo giá.", path: ["leadId"] })
  .refine((v) => v.shippingAmount === null || v.shippingSource.length > 0, { message: "Phí vận chuyển phải kèm căn cứ (vd báo giá cước của đơn vị vận chuyển).", path: ["shippingSource"] });

export type QuotationInput = z.input<typeof quotationInputSchema>;
type ParsedInput = z.output<typeof quotationInputSchema>;

/** Bên nhận báo giá — chỉ dữ kiện CỦA TỔ CHỨC (cột lead do nhân viên / khách xác nhận, hồ sơ khách), không chép dữ liệu Google vào ảnh chụp. */
export type QuotationParty = { leadId: string | null; customerId: string | null; name: string; phone: string; address: string };

type Row = typeof schema.wholesaleQuotations.$inferSelect;

// ─────────────────────────── Phạm vi ───────────────────────────

async function scopeDecision(user: SessionUser): Promise<ScopeDecision> {
  return decideScope("WHOLESALE_LEADS", user);
}

/** Một báo giá có nằm trong phạm vi của người này không — cùng luật với danh sách (`lib/queries/wholesale-quotations.ts`). */
async function quotationInScope(decision: ScopeDecision, user: SessionUser, row: Pick<Row, "leadId" | "createdByUserId">): Promise<boolean> {
  if (decision.allow === "ALL") return true;
  if (decision.allow === "NONE") return false;
  if (row.leadId) return rowInScope(decision, "wholesale_leads", "id", row.leadId);
  return row.createdByUserId === user.id;
}

async function resolveParty(user: SessionUser, leadId: string | null, customerId: string | null): Promise<{ party: QuotationParty } | { error: string }> {
  const db = await getDb();
  let party: QuotationParty = { leadId: null, customerId: null, name: "", phone: "", address: "" };
  if (leadId) {
    const decision = await scopeDecision(user);
    if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
    if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) return { error: "Lead này nằm ngoài phạm vi dữ liệu của bạn." };
    const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId) });
    if (!lead) return { error: "Không tìm thấy lead." };
    if (lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ — không lập báo giá." };
    if (customerId && lead.customerId && lead.customerId !== customerId) return { error: "Lead đã nối với một khách hàng khác — chọn đúng khách của lead." };
    party = { leadId, customerId: customerId ?? lead.customerId ?? null, name: lead.businessName ?? "", phone: lead.normalizedPhone ?? "", address: lead.address ?? "" };
  } else if (customerId) {
    party = { ...party, customerId };
  }
  if (party.customerId) {
    const [c] = await db.select({ name: schema.customers.name, phone: schema.customers.phone, address: schema.customers.address }).from(schema.customers).where(eq(schema.customers.id, party.customerId)).limit(1);
    if (!c) return { error: "Không tìm thấy khách hàng." };
    party = { ...party, name: c.name || party.name, phone: c.phone || party.phone, address: c.address || party.address };
  }
  return { party };
}

// ─────────────────────────── Ngữ cảnh tính ───────────────────────────

export type QuotationContext = {
  books: { customerList: PriceListBook | null; defaultList: PriceListBook | null };
  variants: Map<string, EngineVariant>;
  policy: QuotationPolicy;
};

/**
 * Đọc MỌI dữ kiện bộ tính cần, qua hàm có sẵn của miền sở hữu nó: bảng giá = `priceBooksFor` (khách đã nối ⇒ bảng riêng → mặc
 * định; lead chưa là khách ⇒ chỉ bảng mặc định, D6); tồn = sổ kho (`stockKnownExpr` / `availableStockExpr`, luật 10); giá vốn =
 * bậc thang luật 3.13 (`liveLineUnitCost`: giá báo MKT → phiếu nhập gần nhất → giá nhập mẫu mã, 0 = chưa biết).
 */
export async function loadQuotationContext(customerId: string | null, variantIds: readonly string[]): Promise<QuotationContext> {
  const db = await getDb();
  const ids = [...new Set(variantIds)].filter(Boolean);
  const pv = schema.productVariants;
  const p = schema.products;
  const [books, rawPolicy, rows, stock] = await Promise.all([
    priceBooksFor(customerId, db),
    getSettingJson<Record<string, unknown>>(QUOTATION_SETTING_KEY, {}),
    ids.length
      ? db
          .select({
            id: pv.id,
            sku: pv.sku,
            detail: pv.detail,
            color: pv.color,
            size: pv.size,
            name: p.name,
            retail: pv.retailPrice,
            weight: pv.weight,
            removed: pv.isRemoved,
            productRemoved: p.isRemoved,
            marketer: VARIANT_CURRENT_MARKETER_COST,
            receipt: LAST_RECEIPT_COST,
            variantDefault: pv.lastImportedPrice,
          })
          .from(pv)
          .innerJoin(p, eq(p.id, pv.productId))
          .where(inArray(pv.id, ids))
      : Promise.resolve([]),
    ids.length
      ? chayKhongJit(db, async (tx) => {
          const sales = variantSalesSubquery(tx, ids);
          const receipts = variantReceiptsSubquery(tx, ids);
          return await tx
            .select({ variantId: pv.id, stockKnown: stockKnownExpr(receipts), available: availableStockExpr(sales, receipts) })
            .from(pv)
            .leftJoin(sales, eq(sales.variantId, pv.id))
            .leftJoin(receipts, eq(receipts.variantId, pv.id))
            .where(inArray(pv.id, ids));
        })
      : Promise.resolve([]),
  ]);
  const stockBy = new Map(stock.map((s) => [s.variantId, s]));
  const variants = new Map<string, EngineVariant>();
  for (const r of rows) {
    const st = stockBy.get(r.id);
    const stockKnown = Boolean(st?.stockKnown);
    const cost = liveLineUnitCost({ marketer: r.marketer, receipt: r.receipt, orderSnapshot: null, variantDefault: r.variantDefault });
    const label = r.detail.trim() || [r.color, r.size].filter((x) => x.trim()).join(" · ");
    variants.set(r.id, {
      variantId: r.id,
      name: label ? `${r.name} (${label})` : r.name,
      sku: r.sku,
      exists: !r.removed && !r.productRemoved,
      retailPrice: r.retail !== null && r.retail > 0 ? r.retail : null,
      stockKnown,
      // Chưa có phiếu nhập ⇒ KHÔNG đưa số ra (luật 42): biểu thức vẫn trả «0 − đã xuất», con số đó là bịa.
      available: stockKnown && st ? Number(st.available) : null,
      unitCost: cost.unitCost === null ? null : Math.round(cost.unitCost),
      costSource: cost.source,
      weightGrams: r.weight !== null && r.weight > 0 ? r.weight : null,
    });
  }
  return { books, variants, policy: parseQuotationPolicy(rawPolicy) };
}

function runEngine(party: QuotationParty, v: ParsedInput, ctx: QuotationContext): QuotationResult {
  return computeQuotation({
    party: { leadId: party.leadId, customerId: party.customerId },
    books: ctx.books,
    lines: v.lines,
    variants: ctx.variants,
    quoteDiscount: v.quoteDiscount,
    shipping: v.shippingAmount === null ? null : { amount: v.shippingAmount, source: v.shippingSource },
    policy: ctx.policy,
  });
}

/** Chỉ các bậc của mẫu mã có mặt — ảnh chụp đủ để truy lại vì sao ra đơn giá đó, không chép cả bảng. */
function bookExcerpt(b: PriceListBook | null, ids: ReadonlySet<string>) {
  return b ? { id: b.id, name: b.name, isDefault: b.isDefault, tiers: b.tiers.filter((t) => ids.has(t.variantId)) } : null;
}

export type QuotationSnapshot = {
  engine: "quotation-engine/v1";
  computedAt: string;
  seller: { organization: string; preparedBy: string };
  party: QuotationParty;
  input: { lines: ParsedInput["lines"]; quoteDiscount: number; shipping: { amount: number; source: string } | null; validUntil: string; incoterm: string | null; notes: string; currency: "VND" };
  policy: QuotationPolicy;
  books: { customerList: ReturnType<typeof bookExcerpt>; defaultList: ReturnType<typeof bookExcerpt> };
  variants: EngineVariant[];
  result: QuotationResult;
};

function snapshotOf(user: SessionUser, party: QuotationParty, v: ParsedInput, ctx: QuotationContext, result: QuotationResult, now: Date): QuotationSnapshot {
  const ids = new Set(v.lines.map((l) => l.variantId));
  return {
    engine: "quotation-engine/v1",
    computedAt: now.toISOString(),
    seller: { organization: user.organization?.name ?? "", preparedBy: user.name },
    party,
    input: { lines: v.lines, quoteDiscount: v.quoteDiscount, shipping: v.shippingAmount === null ? null : { amount: v.shippingAmount, source: v.shippingSource }, validUntil: v.validUntil, incoterm: v.incoterm, notes: v.notes, currency: "VND" },
    policy: ctx.policy,
    books: { customerList: bookExcerpt(ctx.books.customerList, ids), defaultList: bookExcerpt(ctx.books.defaultList, ids) },
    variants: [...ids].map((id) => ctx.variants.get(id)).filter((x): x is EngineVariant => Boolean(x)),
    result,
  };
}

function parse(raw: unknown): { v: ParsedInput } | { error: string } {
  const parsed = quotationInputSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  return { v: parsed.data };
}

function validityError(v: ParsedInput, now: Date): string | null {
  return v.validUntil < vnDateKey(now) ? "Ngày hiệu lực đã qua — chọn từ hôm nay trở đi." : null;
}

/** Ghi được không: tổng / dòng âm là dữ liệu sai, không phải một báo giá — không lưu (CHECK ở CSDL cũng chặn). */
function saveBlocker(result: QuotationResult): string | null {
  const neg = result.blockers.find((b) => b.code === "NEGATIVE_TOTAL" || b.code === "BAD_AMOUNT" || b.code === "NO_PARTY");
  return neg ? neg.message : null;
}

// ─────────────────────────── Xem trước (không ghi) ───────────────────────────

/** Xem trước cho form: CÙNG bộ tính, CÙNG ngữ cảnh với lượt ghi — không ghi gì. */
export async function previewQuotationCore(user: SessionUser, raw: unknown): Promise<CoreResult<{ result: QuotationResult; party: QuotationParty }>> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN_WORK };
  const p = parse(raw);
  if ("error" in p) return p;
  const r = await resolveParty(user, p.v.leadId, p.v.customerId);
  if ("error" in r) return r;
  const ctx = await loadQuotationContext(r.party.customerId, p.v.lines.map((l) => l.variantId));
  return { ok: true, result: runEngine(r.party, p.v, ctx), party: r.party };
}

// ─────────────────────────── Lập / sửa ───────────────────────────

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode(now: Date): string {
  const day = vnDateKey(now).replace(/-/g, "").slice(2);
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `BG-${day}-${[...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
}

function rowValues(user: SessionUser, party: QuotationParty, v: ParsedInput, result: QuotationResult, snapshot: QuotationSnapshot, extra: { id: string; code: string; version: number; parentQuotationId: string | null }) {
  const t = result.totals;
  return {
    ...extra,
    requestKey: v.requestKey,
    leadId: party.leadId,
    customerId: party.customerId,
    status: "DRAFT",
    currency: "VND",
    priceListId: result.priceListId,
    priceVersion: result.priceVersion,
    subtotal: t.subtotal,
    discount: t.discount,
    shipping: t.shipping,
    shippingSource: t.shipping === null ? "" : v.shippingSource,
    tax: t.tax,
    taxSource: t.tax === null ? "" : (result.taxSource ?? ""),
    total: t.total,
    validUntil: v.validUntil,
    incoterm: v.incoterm,
    notes: v.notes,
    requiresApproval: result.requiresApproval,
    blockerCount: result.blockers.length,
    snapshot,
    createdByUserId: user.id,
    createdByName: user.name,
  };
}

function lineValues(quotationId: string, result: QuotationResult) {
  return result.lines.map((l) => ({
    quotationId,
    lineNo: l.lineNo,
    variantId: l.variantId,
    productName: l.name,
    sku: l.sku,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    priceSource: l.priceSource,
    priceListId: l.priceListId,
    tierMinQty: l.tierMinQty,
    lineDiscount: l.lineDiscount,
    lineTotal: l.lineTotal,
    stockAvailableAtQuote: l.stockAvailable,
    warnings: l.warnings,
  }));
}

const isUniqueViolation = (e: unknown) => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return (x?.code ?? x?.cause?.code) === "23505";
};

async function byRequestKey(requestKey: string): Promise<Row | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.requestKey, requestKey)).limit(1);
  return row ?? null;
}

export type SaveResult = { id: string; code: string; version: number; replayed: boolean; blockers: number; requiresApproval: boolean };

/** Lập báo giá NHÁP (phiên bản 1) từ một lead hoặc một khách. Báo giá còn chặn vẫn lưu được ở dạng nháp — không gửi / duyệt được. */
export async function createQuotationCore(user: SessionUser, raw: unknown, now = new Date()): Promise<CoreResult<SaveResult>> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN_WORK };
  const p = parse(raw);
  if ("error" in p) return p;
  const v = p.v;
  try {
    const prior = await byRequestKey(v.requestKey);
    if (prior) return prior.parentQuotationId === null ? { ok: true, id: prior.id, code: prior.code, version: prior.version, replayed: true, blockers: prior.blockerCount, requiresApproval: prior.requiresApproval } : { error: "Mã yêu cầu đã dùng cho một lượt sửa khác — tải lại trang." };
    const bad = validityError(v, now);
    if (bad) return { error: bad };
    const r = await resolveParty(user, v.leadId, v.customerId);
    if ("error" in r) return r;
    const ctx = await loadQuotationContext(r.party.customerId, v.lines.map((l) => l.variantId));
    const result = runEngine(r.party, v, ctx);
    const stop = saveBlocker(result);
    if (stop) return { error: stop };
    const snapshot = snapshotOf(user, r.party, v, ctx, result, now);
    const db = await getDb();
    const id = crypto.randomUUID();
    let code = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      code = newCode(now);
      try {
        await db.transaction(async (tx) => {
          await tx.insert(schema.wholesaleQuotations).values(rowValues(user, r.party, v, result, snapshot, { id, code, version: 1, parentQuotationId: null }));
          await tx.insert(schema.wholesaleQuotationLines).values(lineValues(id, result));
        });
        break;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // Bấm hai lần đua nhau ⇒ lượt sau gặp khoá `request_key` ⇒ trả đúng bản của lượt trước.
        const raced = await byRequestKey(v.requestKey);
        if (raced) return { ok: true, id: raced.id, code: raced.code, version: raced.version, replayed: true, blockers: raced.blockerCount, requiresApproval: raced.requiresApproval };
        if (attempt === 3) throw e; // trùng mã đọc được 4 lần liền — không xảy ra trên thực tế; ném cho người thấy.
      }
    }
    await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_QUOTATION_CREATE", entity: "WHOLESALE_QUOTATION", entityId: id, before: null, after: { code, version: 1, leadId: r.party.leadId, customerId: r.party.customerId, total: result.totals.total, blockers: result.blockers.length, requiresApproval: result.requiresApproval }, reason: "Lập báo giá sỉ — số do bộ tính tất định tính" });
    return { ok: true, id, code, version: 1, replayed: false, blockers: result.blockers.length, requiresApproval: result.requiresApproval };
  } catch (e) {
    if (isMissingQuotationTable(e)) return { error: QUOTATION_TABLES_MISSING };
    throw e;
  }
}

/**
 * NHÁP báo giá do MÁY lập từ một thư khách HỎI GIÁ (E3 · lib/wholesale/email-reply.ts). CÙNG bộ tính, CÙNG ngữ cảnh (bảng giá
 * sỉ đang bật, sổ kho, giá vốn sống) và CÙNG hình dạng ghi với `createQuotationCore` — chỉ khác người lập: không có tài khoản nào
 * bấm, nên `created_by_user_id = NULL` và tên là «Máy (thư hỏi giá)» (luật 34: `null` = máy làm, khác «chưa biết ai»). Luôn ở
 * trạng thái DRAFT: không gửi, không duyệt — người phụ trách mở ra sửa / gửi. Lead KHÔNG LIÊN HỆ ⇒ không lập.
 */
export async function createQuotationDraftByMachine(raw: unknown, orgName: string, now = new Date()): Promise<CoreResult<SaveResult>> {
  const p = parse(raw);
  if ("error" in p) return p;
  const v = p.v;
  if (!v.leadId) return { error: "Nháp máy chỉ lập cho lead." };
  try {
    const prior = await byRequestKey(v.requestKey);
    if (prior) return { ok: true, id: prior.id, code: prior.code, version: prior.version, replayed: true, blockers: prior.blockerCount, requiresApproval: prior.requiresApproval };
    const bad = validityError(v, now);
    if (bad) return { error: bad };
    const db = await getDb();
    const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, v.leadId) });
    if (!lead) return { error: "Không tìm thấy lead." };
    if (lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ — không lập báo giá." };
    const party: QuotationParty = { leadId: lead.id, customerId: lead.customerId ?? null, name: lead.businessName ?? "", phone: lead.normalizedPhone ?? "", address: lead.address ?? "" };
    const ctx = await loadQuotationContext(party.customerId, v.lines.map((l) => l.variantId));
    const result = runEngine(party, v, ctx);
    const stop = saveBlocker(result);
    if (stop) return { error: stop };
    const machine = { id: "", email: "job:wholesale-email-inbound", name: "Máy (thư hỏi giá)", organization: { code: "", name: orgName, isHome: false } } as unknown as SessionUser;
    const snapshot = snapshotOf(machine, party, v, ctx, result, now);
    const id = crypto.randomUUID();
    let code = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      code = newCode(now);
      try {
        await db.transaction(async (tx) => {
          await tx.insert(schema.wholesaleQuotations).values({ ...rowValues(machine, party, v, result, snapshot, { id, code, version: 1, parentQuotationId: null }), createdByUserId: null });
          await tx.insert(schema.wholesaleQuotationLines).values(lineValues(id, result));
        });
        break;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        const raced = await byRequestKey(v.requestKey);
        if (raced) return { ok: true, id: raced.id, code: raced.code, version: raced.version, replayed: true, blockers: raced.blockerCount, requiresApproval: raced.requiresApproval };
        if (attempt === 3) throw e;
      }
    }
    await audit({ userId: null, userEmail: "job:wholesale-email-inbound", action: "WHOLESALE_QUOTATION_CREATE", entity: "WHOLESALE_QUOTATION", entityId: id, before: null, after: { code, version: 1, leadId: party.leadId, total: result.totals.total, blockers: result.blockers.length, requiresApproval: result.requiresApproval, by: "MACHINE" }, reason: "Máy lập NHÁP báo giá từ thư khách hỏi giá — số do bộ tính tất định tính, người phụ trách duyệt / gửi" });
    return { ok: true, id, code, version: 1, replayed: false, blockers: result.blockers.length, requiresApproval: result.requiresApproval };
  } catch (e) {
    if (isMissingQuotationTable(e)) return { error: QUOTATION_TABLES_MISSING };
    throw e;
  }
}

async function gate(user: SessionUser, id: string, permission: "wholesale:work" | "wholesale:config"): Promise<{ row: Row; decision: ScopeDecision } | { error: string }> {
  if (!can(user, permission)) return { error: permission === "wholesale:work" ? FORBIDDEN_WORK : FORBIDDEN_APPROVE };
  const decision = await scopeDecision(user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  const db = await getDb();
  const [row] = await db.select().from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, id)).limit(1);
  if (!row || !(await quotationInScope(decision, user, row))) return { error: "Không tìm thấy báo giá (hoặc nằm ngoài phạm vi dữ liệu của bạn)." };
  return { row, decision };
}

/**
 * Sửa = PHIÊN BẢN MỚI (cùng mã, version + 1); bản đang sửa thành «Đã có bản mới», nội dung của nó không đổi. Bên nhận giữ nguyên
 * theo bản trước. Tính lại bằng bảng giá / tồn / giá vốn HÔM NAY — bản cũ vẫn giữ số của lúc nó được lập.
 */
export async function reviseQuotationCore(user: SessionUser, id: string, raw: unknown, now = new Date()): Promise<CoreResult<SaveResult>> {
  try {
    const g = await gate(user, id, "wholesale:work");
    if ("error" in g) return g;
    const p = parse({ ...((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>), leadId: g.row.leadId, customerId: g.row.customerId });
    if ("error" in p) return p;
    const v = p.v;
    const prior = await byRequestKey(v.requestKey);
    if (prior) return prior.parentQuotationId === id ? { ok: true, id: prior.id, code: prior.code, version: prior.version, replayed: true, blockers: prior.blockerCount, requiresApproval: prior.requiresApproval } : { error: "Mã yêu cầu đã dùng cho một lượt khác — tải lại trang." };
    const status = effectiveQuotationStatus(g.row.status, g.row.validUntil, vnDateKey(now));
    if (!REVISABLE_STATUSES.includes(status)) return { error: `Báo giá đang «${QUOTATION_STATUS_LABEL[status]}» — không sửa được.` };
    const bad = validityError(v, now);
    if (bad) return { error: bad };
    const r = await resolveParty(user, g.row.leadId, g.row.customerId);
    if ("error" in r) return r;
    const ctx = await loadQuotationContext(r.party.customerId, v.lines.map((l) => l.variantId));
    const result = runEngine(r.party, v, ctx);
    const stop = saveBlocker(result);
    if (stop) return { error: stop };
    const snapshot = snapshotOf(user, r.party, v, ctx, result, now);
    const db = await getDb();
    const childId = crypto.randomUUID();
    const version = g.row.version + 1;
    let out: { error: string } | null = null;
    try {
      out = await db.transaction(async (tx) => {
        const [locked] = await tx.select({ status: schema.wholesaleQuotations.status }).from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, id)).for("update");
        if (!locked || locked.status === "SUPERSEDED") return { error: "Báo giá vừa có phiên bản mới hơn — mở bản mới nhất rồi sửa." };
        if (locked.status === "ACCEPTED") return { error: "Khách vừa chấp nhận báo giá này — không sửa được." };
        await tx.insert(schema.wholesaleQuotations).values(rowValues(user, r.party, v, result, snapshot, { id: childId, code: g.row.code, version, parentQuotationId: id }));
        await tx.insert(schema.wholesaleQuotationLines).values(lineValues(childId, result));
        await tx.update(schema.wholesaleQuotations).set({ status: "SUPERSEDED", supersededAt: now, updatedAt: now }).where(eq(schema.wholesaleQuotations.id, id));
        return null;
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const raced = await byRequestKey(v.requestKey);
      if (raced && raced.parentQuotationId === id) return { ok: true, id: raced.id, code: raced.code, version: raced.version, replayed: true, blockers: raced.blockerCount, requiresApproval: raced.requiresApproval };
      return { error: "Có người vừa tạo phiên bản mới cho báo giá này — mở bản mới nhất rồi sửa." };
    }
    if (out) return out;
    await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_QUOTATION_REVISE", entity: "WHOLESALE_QUOTATION", entityId: childId, before: { id, version: g.row.version, total: g.row.total, status: g.row.status }, after: { code: g.row.code, version, total: result.totals.total, blockers: result.blockers.length, requiresApproval: result.requiresApproval }, reason: "Sửa báo giá sỉ — phiên bản mới, bản cũ giữ nguyên" });
    return { ok: true, id: childId, code: g.row.code, version, replayed: false, blockers: result.blockers.length, requiresApproval: result.requiresApproval };
  } catch (e) {
    if (isMissingQuotationTable(e)) return { error: QUOTATION_TABLES_MISSING };
    throw e;
  }
}

// ─────────────────────────── Vòng đời ───────────────────────────

type Transition = CoreResult<{ status: string; replayed: boolean }>;

async function guarded(fn: () => Promise<Transition>): Promise<Transition> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingQuotationTable(e)) return { error: QUOTATION_TABLES_MISSING };
    throw e;
  }
}

/**
 * Đổi trạng thái có điều kiện: chỉ ghi khi dòng còn ở `from`. Không ghi được mà dòng đã ở `to` ⇒ lượt bấm lặp (trả lại, không ghi
 * gì thêm); ở trạng thái khác ⇒ có người vừa đổi.
 */
async function transition(id: string, from: readonly string[], to: string, patch: Partial<typeof schema.wholesaleQuotations.$inferInsert>): Promise<"OK" | "REPLAY" | "CONFLICT"> {
  const db = await getDb();
  const done = await db
    .update(schema.wholesaleQuotations)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(schema.wholesaleQuotations.id, id), inArray(schema.wholesaleQuotations.status, [...from])))
    .returning({ id: schema.wholesaleQuotations.id });
  if (done.length) return "OK";
  const [now] = await db.select({ status: schema.wholesaleQuotations.status }).from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, id)).limit(1);
  return now?.status === to ? "REPLAY" : "CONFLICT";
}

const CONFLICT = "Báo giá vừa đổi trạng thái — tải lại trang.";

function liveStatus(row: Row, now: Date) {
  return effectiveQuotationStatus(row.status, row.validUntil, vnDateKey(now));
}

/** Gửi duyệt — chỉ khi bộ tính nói CẦN duyệt (chiết khấu ngoài chính sách đã chứng minh) và không còn chặn. */
export async function submitQuotationCore(user: SessionUser, id: string, now = new Date()): Promise<Transition> {
  return guarded(async () => {
    const g = await gate(user, id, "wholesale:work");
    if ("error" in g) return g;
    const s = liveStatus(g.row, now);
    if (s === "PENDING_APPROVAL") return { ok: true, status: s, replayed: true };
    if (s !== "DRAFT") return { error: `Báo giá đang «${QUOTATION_STATUS_LABEL[s]}» — chỉ gửi duyệt bản nháp.` };
    if (g.row.blockerCount > 0) return { error: "Báo giá còn chặn — sửa (tạo phiên bản mới) trước khi gửi duyệt." };
    if (!g.row.requiresApproval) return { error: "Báo giá này không cần duyệt — đánh dấu đã gửi khách được ngay." };
    const t = await transition(id, ["DRAFT"], "PENDING_APPROVAL", {});
    if (t === "CONFLICT") return { error: CONFLICT };
    if (t === "OK") await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_QUOTATION_SUBMIT", entity: "WHOLESALE_QUOTATION", entityId: id, before: { status: "DRAFT" }, after: { status: "PENDING_APPROVAL" }, reason: "Gửi duyệt báo giá sỉ (chiết khấu ngoài chính sách đã chứng minh)" });
    return { ok: true, status: "PENDING_APPROVAL", replayed: t === "REPLAY" };
  });
}

/** Duyệt — `wholesale:config`, NGƯỜI LẬP KHÔNG TỰ DUYỆT (kiểm ở đây + CHECK ở CSDL). */
export async function approveQuotationCore(user: SessionUser, id: string, now = new Date()): Promise<Transition> {
  return guarded(async () => {
    const g = await gate(user, id, "wholesale:config");
    if ("error" in g) return g;
    if (g.row.createdByUserId === user.id) return { error: "Người lập báo giá không tự duyệt — nhờ một người khác có quyền duyệt." };
    const s = liveStatus(g.row, now);
    if (s === "APPROVED") return { ok: true, status: s, replayed: true };
    if (s !== "PENDING_APPROVAL") return { error: `Báo giá đang «${QUOTATION_STATUS_LABEL[s]}» — chỉ duyệt bản đang chờ duyệt.` };
    if (g.row.blockerCount > 0) return { error: "Báo giá còn chặn — không duyệt được." };
    const t = await transition(id, ["PENDING_APPROVAL"], "APPROVED", { approvedByUserId: user.id, approvedAt: now });
    if (t === "CONFLICT") return { error: CONFLICT };
    if (t === "OK") await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_QUOTATION_APPROVE", entity: "WHOLESALE_QUOTATION", entityId: id, before: { status: "PENDING_APPROVAL" }, after: { status: "APPROVED", approvedBy: user.id }, reason: "Duyệt báo giá sỉ" });
    return { ok: true, status: "APPROVED", replayed: t === "REPLAY" };
  });
}

const reasonZ = z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự).").max(QUOTATION_LIMITS.reasonMax);

/** Trả lại bản đang chờ duyệt về nháp, có lý do. Người lập sửa bằng một phiên bản mới. */
export async function returnQuotationCore(user: SessionUser, id: string, reason: unknown, now = new Date()): Promise<Transition> {
  return guarded(async () => {
    const g = await gate(user, id, "wholesale:config");
    if ("error" in g) return g;
    const why = reasonZ.safeParse(reason);
    if (!why.success) return { error: why.error.issues[0]?.message ?? "Ghi lý do." };
    const s = liveStatus(g.row, now);
    if (s !== "PENDING_APPROVAL") return { error: `Báo giá đang «${QUOTATION_STATUS_LABEL[s]}» — chỉ trả lại bản đang chờ duyệt.` };
    const t = await transition(id, ["PENDING_APPROVAL"], "DRAFT", {});
    if (t !== "OK") return { error: CONFLICT };
    await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_QUOTATION_RETURN", entity: "WHOLESALE_QUOTATION", entityId: id, before: { status: "PENDING_APPROVAL" }, after: { status: "DRAFT" }, reason: why.data });
    return { ok: true, status: "DRAFT", replayed: false };
  });
}

/**
 * Đánh dấu ĐÃ GỬI KHÁCH (người gửi qua kênh của mình, kèm link trang in) — CHƯA gửi email ở bước này. Được khi: đã duyệt, hoặc
 * là nháp KHÔNG cần duyệt; không còn chặn; chưa hết hạn.
 */
export async function markQuotationSentCore(user: SessionUser, id: string, now = new Date()): Promise<Transition> {
  return guarded(async () => {
    const g = await gate(user, id, "wholesale:work");
    if ("error" in g) return g;
    const s = liveStatus(g.row, now);
    if (s === "SENT") return { ok: true, status: s, replayed: true };
    if (g.row.blockerCount > 0) return { error: "Báo giá còn chặn — không gửi khách được." };
    const allowed = s === "APPROVED" || (s === "DRAFT" && !g.row.requiresApproval);
    if (!allowed) return { error: s === "DRAFT" ? "Báo giá cần duyệt trước khi gửi khách." : `Báo giá đang «${QUOTATION_STATUS_LABEL[s]}» — không gửi được.` };
    const t = await transition(id, [g.row.status === "APPROVED" ? "APPROVED" : "DRAFT"], "SENT", { sentByUserId: user.id, sentAt: now });
    if (t === "CONFLICT") return { error: CONFLICT };
    if (t === "OK") await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_QUOTATION_SENT", entity: "WHOLESALE_QUOTATION", entityId: id, before: { status: g.row.status }, after: { status: "SENT" }, reason: "Đánh dấu đã gửi báo giá cho khách (người gửi, chưa qua email)" });
    return { ok: true, status: "SENT", replayed: t === "REPLAY" };
  });
}

const decisionZ = z.object({ decision: z.enum(["ACCEPTED", "REJECTED"]), reason: reasonZ }).strict();

/** Kết quả từ khách (ghi tay, có lý do / kênh). Chỉ bản đã gửi, chưa hết hạn — quá hạn thì lập phiên bản mới. */
export async function recordQuotationDecisionCore(user: SessionUser, id: string, raw: unknown, now = new Date()): Promise<Transition> {
  return guarded(async () => {
    const g = await gate(user, id, "wholesale:work");
    if ("error" in g) return g;
    const parsed = decisionZ.safeParse(raw);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const { decision, reason } = parsed.data;
    const s = liveStatus(g.row, now);
    if (s === decision) return { ok: true, status: s, replayed: true };
    if (s === "EXPIRED") return { error: "Báo giá đã hết hạn — lập phiên bản mới trước khi ghi khách chấp nhận / từ chối." };
    if (s !== "SENT") return { error: `Báo giá đang «${QUOTATION_STATUS_LABEL[s]}» — chỉ ghi kết quả cho bản đã gửi khách.` };
    const patch = decision === "ACCEPTED" ? { acceptedAt: now } : { rejectedAt: now };
    const t = await transition(id, ["SENT"], decision, { ...patch, decidedByUserId: user.id, decisionNote: reason });
    if (t === "CONFLICT") return { error: CONFLICT };
    if (t === "OK") await audit({ userId: user.id, userEmail: user.email, action: decision === "ACCEPTED" ? "WHOLESALE_QUOTATION_ACCEPTED" : "WHOLESALE_QUOTATION_REJECTED", entity: "WHOLESALE_QUOTATION", entityId: id, before: { status: "SENT" }, after: { status: decision }, reason });
    return { ok: true, status: decision, replayed: t === "REPLAY" };
  });
}
