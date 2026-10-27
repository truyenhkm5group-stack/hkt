/**
 * BÁO GIÁ SỈ TẤT ĐỊNH (0263 · docs/tech/hslc-b2b-sales-agent.md P1b · lib/wholesale/quotation-engine.ts + quotation.ts).
 *
 *  1. THUẦN — chọn bậc theo số lượng (đúng `quoteUnitPrice`), dưới MOQ chặn, không có giá sỉ chặn (giá lẻ không phải giá sỉ),
 *     tồn đã biết < SL chặn / tồn chưa biết chỉ cảnh báo (không coi là 0), chiết khấu khi chưa khai trần ⇒ cần duyệt, vượt trần
 *     ⇒ chặn, biên lợi nhuận chưa biết / dưới sàn ⇒ cần duyệt, tiền là số nguyên VND, ship / thuế chưa khai ⇒ trống + cảnh báo,
 *     dấu phiên bản giá đổi khi một bậc đổi, hết hạn tính lúc đọc.
 *  2. TỔ CHỨC THẬT (PGlite riêng): lập nháp từ lead, bấm hai lần không đẻ hai bản, người lập không tự duyệt (lõi + CHECK CSDL),
 *     sửa ⇒ phiên bản mới và bản cũ bất biến (trigger), ảnh chụp không đổi khi bảng giá đổi sau đó, hết hạn chặn gửi / ghi kết
 *     quả, phạm vi dữ liệu, cách ly tổ chức, và CSDL chưa áp 0263 ⇒ câu lỗi / «unavailable» thay vì sập (MIGRATION_SERVE_COMPAT).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import type { PriceListBook } from "@/lib/constants/price-lists";
import { addDays, vnDateKey } from "@/lib/format";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { getQuotation, listQuotations } from "@/lib/queries/wholesale-quotations";
import { savePriceListCore } from "@/lib/records/trade";
import { parseListParams } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";
import {
  approveQuotationCore,
  createQuotationCore,
  isMissingQuotationTable,
  markQuotationSentCore,
  previewQuotationCore,
  QUOTATION_TABLES_MISSING,
  recordQuotationDecisionCore,
  returnQuotationCore,
  reviseQuotationCore,
  submitQuotationCore,
  type QuotationSnapshot,
} from "@/lib/wholesale/quotation";
import { computeQuotation, effectiveQuotationStatus, parseQuotationPolicy, priceVersionOf, QUOTATION_SETTING_KEY, type EngineVariant, type QuotationEngineInput } from "@/lib/wholesale/quotation-engine";

const ORG = "bg-si";

// ─────────────────────────── 1. THUẦN ───────────────────────────

const variant = (id: string, over: Partial<EngineVariant> = {}): EngineVariant => ({ variantId: id, name: `Mẫu ${id}`, sku: id.toUpperCase(), exists: true, retailPrice: 150_000, stockKnown: true, available: 1000, unitCost: 60_000, costSource: "RECEIPT", weightGrams: 500, ...over });
const DEF: PriceListBook = {
  id: "def",
  name: "Sỉ chung",
  isDefault: true,
  tiers: [
    { variantId: "a", minQuantity: 10, unitPrice: 100_000 },
    { variantId: "a", minQuantity: 50, unitPrice: 90_000 },
    { variantId: "c", minQuantity: 1, unitPrice: 33_333 },
  ],
};
const OWN: PriceListBook = { id: "own", name: "Đại lý A", isDefault: false, tiers: [{ variantId: "a", minQuantity: 20, unitPrice: 85_000 }] };
const NO_POLICY = parseQuotationPolicy(undefined);

function input(over: Partial<QuotationEngineInput> = {}): QuotationEngineInput {
  return {
    party: { leadId: "lead-1", customerId: null },
    books: { customerList: null, defaultList: DEF },
    lines: [{ variantId: "a", quantity: 10 }],
    variants: new Map(["a", "b", "c"].map((id) => [id, variant(id)])),
    quoteDiscount: 0,
    shipping: null,
    policy: NO_POLICY,
    ...over,
  };
}

const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

function testPure() {
  // Bậc theo số lượng — đúng luật `quoteUnitPrice`: bậc «mua từ» lớn nhất ≤ SL; bảng riêng của khách trước, mặc định sau.
  const r10 = computeQuotation(input());
  assert.deepEqual([r10.lines[0].unitPrice, r10.lines[0].tierMinQty, r10.lines[0].priceSource, r10.lines[0].moq], [100_000, 10, "DEFAULT_LIST", 10], "SL 10 ⇒ bậc 10");
  assert.equal(computeQuotation(input({ lines: [{ variantId: "a", quantity: 49 }] })).lines[0].unitPrice, 100_000, "49 vẫn bậc 10");
  assert.equal(computeQuotation(input({ lines: [{ variantId: "a", quantity: 50 }] })).lines[0].unitPrice, 90_000, "đúng bằng bậc 50 thì khớp");
  const own = { customerList: OWN, defaultList: DEF };
  assert.deepEqual([computeQuotation(input({ books: own, lines: [{ variantId: "a", quantity: 25 }] })).lines[0].priceSource, computeQuotation(input({ books: own, lines: [{ variantId: "a", quantity: 25 }] })).lines[0].unitPrice], ["CUSTOMER_LIST", 85_000]);
  assert.deepEqual([computeQuotation(input({ books: own, lines: [{ variantId: "a", quantity: 12 }] })).lines[0].priceSource, computeQuotation(input({ books: own, lines: [{ variantId: "a", quantity: 12 }] })).lines[0].unitPrice], ["DEFAULT_LIST", 100_000], "chưa tới bậc của bảng riêng ⇒ bảng mặc định");
  assert.deepEqual(codes(r10.blockers), [], "đủ dữ kiện ⇒ không chặn");
  assert.equal(r10.requiresApproval, false, "không chiết khấu ⇒ không cần duyệt");

  // Dưới MOQ chặn; không có giá sỉ chặn kể cả khi có giá lẻ.
  const low = computeQuotation(input({ lines: [{ variantId: "a", quantity: 5 }] }));
  assert.deepEqual(codes(low.blockers), ["BELOW_MOQ"]);
  assert.equal(low.lines[0].unitPrice, null, "dưới MOQ không lấy giá lẻ thay");
  assert.match(low.blockers[0].message, /MOQ 10/);
  const nob = computeQuotation(input({ lines: [{ variantId: "b", quantity: 100 }] }));
  assert.deepEqual(codes(nob.blockers), ["NO_WHOLESALE_PRICE"], "giá lẻ 150.000 ₫ không phải giá sỉ");
  assert.equal(nob.totals.subtotal, 0);
  assert.deepEqual(codes(computeQuotation(input({ lines: [{ variantId: "zz", quantity: 1 }] })).blockers), ["UNKNOWN_VARIANT"]);
  assert.deepEqual(codes(computeQuotation(input({ lines: [{ variantId: "a", quantity: 10 }, { variantId: "a", quantity: 10 }] })).blockers), ["DUPLICATE_LINE"]);
  assert.deepEqual(codes(computeQuotation(input({ party: { leadId: null, customerId: null } })).blockers), ["NO_PARTY"]);

  // Tồn: đã biết < SL ⇒ chặn; CHƯA BIẾT ⇒ cảnh báo, không chặn, không thành 0.
  const short = computeQuotation(input({ variants: new Map([["a", variant("a", { available: 9 })]]) }));
  assert.deepEqual(codes(short.blockers), ["STOCK_SHORT"]);
  const unknown = computeQuotation(input({ variants: new Map([["a", variant("a", { stockKnown: false, available: -40 })]]) }));
  assert.deepEqual(codes(unknown.blockers), [], "tồn chưa biết KHÔNG chặn");
  assert.ok(codes(unknown.warnings).includes("STOCK_UNVERIFIED"));
  assert.equal(unknown.lines[0].stockAvailable, null, "tồn chưa biết là null, không phải 0 / số âm bịa");
  assert.equal(computeQuotation(input({ variants: new Map([["a", variant("a", { available: 10 })]]) })).blockers.length, 0, "tồn đúng bằng SL vẫn qua");

  // Chiết khấu: chưa khai trần / sàn ⇒ CẦN DUYỆT (không có số mặc định gõ cứng).
  const disc = computeQuotation(input({ quoteDiscount: 10_000 }));
  assert.equal(disc.requiresApproval, true);
  assert.deepEqual(codes(disc.reasons), ["DISCOUNT_CAP_UNDECLARED", "MARGIN_FLOOR_UNDECLARED"]);
  assert.deepEqual(codes(disc.blockers), []);
  const policy = parseQuotationPolicy({ maxDiscountPercent: 5, minMarginPercent: 30 });
  assert.deepEqual(codes(computeQuotation(input({ quoteDiscount: 100_000, policy })).blockers), ["DISCOUNT_OVER_CAP"], "10% > trần 5% ⇒ chặn");
  const within = computeQuotation(input({ quoteDiscount: 50_000, policy }));
  assert.deepEqual([within.discountPercent, within.marginPercent, within.requiresApproval], [5, 36.84, false], "5% = trần, biên 36,84% ≥ sàn 30% ⇒ không cần duyệt");
  const floor = computeQuotation(input({ quoteDiscount: 50_000, policy: parseQuotationPolicy({ maxDiscountPercent: 5, minMarginPercent: 40 }) }));
  assert.deepEqual(codes(floor.reasons), ["MARGIN_BELOW_FLOOR"]);
  const noCost = computeQuotation(input({ quoteDiscount: 10_000, policy, variants: new Map([["a", variant("a", { unitCost: null })]]) }));
  assert.deepEqual(codes(noCost.reasons), ["MARGIN_UNKNOWN"], "giá vốn chưa biết ⇒ chiết khấu bắt buộc duyệt");
  assert.equal(noCost.marginPercent, null, "biên chưa biết là null, không phải 0%");
  assert.ok(codes(noCost.warnings).includes("COST_UNKNOWN"));

  // Tiền là số nguyên VND — thuế làm tròn về đồng; số lẻ / âm bị chặn.
  const taxed = computeQuotation(input({ lines: [{ variantId: "c", quantity: 3 }], policy: parseQuotationPolicy({ taxRatePercent: 8, taxSource: "Hoá đơn GTGT 8% (NĐ 72/2024)" }) }));
  assert.deepEqual([taxed.totals.subtotal, taxed.totals.tax, taxed.totals.total], [99_999, 8000, 107_999]);
  for (const n of Object.values(taxed.totals)) assert.ok(n === null || Number.isSafeInteger(n), "mọi số tiền là số nguyên");
  assert.equal(parseQuotationPolicy({ taxRatePercent: 8 }).taxRatePercent, null, "thuế suất không có căn cứ ⇒ coi như chưa khai");
  assert.deepEqual(codes(computeQuotation(input({ quoteDiscount: 1.5 })).blockers), ["BAD_AMOUNT"]);
  assert.deepEqual(codes(computeQuotation(input({ lines: [{ variantId: "a", quantity: 10, lineDiscount: 2_000_000 }] })).blockers), ["NEGATIVE_TOTAL", "NEGATIVE_TOTAL"]);

  // Ship / thuế chưa khai ⇒ trống + cảnh báo, không bịa; ship có số phải có căn cứ.
  assert.deepEqual([r10.totals.shipping, r10.totals.tax, r10.totals.total], [null, null, 1_000_000]);
  assert.ok(codes(r10.warnings).includes("SHIPPING_MISSING") && codes(r10.warnings).includes("TAX_MISSING"));
  assert.deepEqual(codes(computeQuotation(input({ shipping: { amount: 30_000, source: " " } })).blockers), ["SHIPPING_NO_SOURCE"]);
  assert.equal(computeQuotation(input({ shipping: { amount: 30_000, source: "Báo giá cước GHN" } })).totals.total, 1_030_000);

  // Dấu phiên bản giá: không phụ thuộc thứ tự, đổi khi một bậc đổi.
  const v1 = priceVersionOf({ customerList: null, defaultList: DEF }, ["a", "c"]);
  assert.equal(v1, priceVersionOf({ customerList: null, defaultList: { ...DEF, tiers: [...DEF.tiers].reverse() } }, ["c", "a"]));
  assert.notEqual(v1, priceVersionOf({ customerList: null, defaultList: { ...DEF, tiers: DEF.tiers.map((t) => (t.minQuantity === 50 ? { ...t, unitPrice: 89_000 } : t)) } }, ["a", "c"]));

  // Hết hạn tính lúc đọc: ngày hiệu lực là NGÀY CUỐI còn hiệu lực.
  assert.equal(effectiveQuotationStatus("SENT", "2026-10-27", "2026-10-27"), "SENT");
  assert.equal(effectiveQuotationStatus("SENT", "2026-10-26", "2026-10-27"), "EXPIRED");
  assert.equal(effectiveQuotationStatus("ACCEPTED", "2026-10-01", "2026-10-27"), "ACCEPTED", "đã chấp nhận thì không «hết hạn»");
  assert.equal(effectiveQuotationStatus("SUPERSEDED", "2026-10-01", "2026-10-27"), "SUPERSEDED");

  // Bộ tính là hàm thuần, chọn giá bằng ĐÚNG quoteUnitPrice, không đọc CSDL.
  const src = readFileSync("lib/wholesale/quotation-engine.ts", "utf8");
  assert.ok(src.includes("quoteUnitPrice({"), "chọn giá bằng quoteUnitPrice — không bộ tính giá thứ hai");
  assert.ok(!/from "@\/db"|getDb\(|getSettingJson|new Date\(/.test(src), "bộ tính không đọc CSDL / cấu hình / đồng hồ");
  console.log("  ✓ thuần: bậc theo SL · MOQ · không giá sỉ · tồn biết/chưa biết · chiết khấu cần duyệt/vượt trần · biên chưa biết · tiền nguyên · ship/thuế chưa khai · dấu phiên bản · hết hạn");
}

// ─────────────────────────── 2. TỔ CHỨC THẬT ───────────────────────────

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

function sessionOf(u: { id: string; email: string; name: string }, over: Partial<SessionUser>, modules: string[]): SessionUser {
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản sỉ báo giá", isHome: false }, modules, ...over };
}

const ok = <T extends object>(r: ({ ok: true } & T) | { error: string }): { ok: true } & T => {
  if ("error" in r) assert.fail(r.error);
  return r;
};
const okTrade = (r: { ok: true; id: string } | { ok: false; errors: { message: string }[] }): { ok: true; id: string } => {
  if (!r.ok) assert.fail(r.errors.map((e) => e.message).join(" "));
  return r;
};
const err = (r: object) => ("error" in r ? (r as { error: string }).error : "");
let seq = 0;
const key = () => `test-key-${Date.now()}-${++seq}`;

async function testOrg() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản sỉ báo giá", plan: "standard", modules: ["customers", "products", "orders", "inventory", "wholesale_leads"], admin: { email: `admin@${ORG}.local`, name: "QT báo giá", password: "BaoGia@12345" }, source: "TEST", actor: null });
  let idInOrg = "";
  let codeInOrg = "";
  let leadInOrg = "";
  try {
    const modules = [...(await getEnabledModules(ORG))];
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = sessionOf(u, {}, modules);
      const [ap] = await db.insert(schema.users).values({ email: `duyet@${ORG}.local`, name: "Trưởng nhóm duyệt", passwordHash: "x", role: "LEADER" }).returning();
      const approver = sessionOf(ap, { role: "LEADER", permissions: ["wholesale:view", "wholesale:work", "wholesale:config"] }, modules);
      const [sl] = await db.insert(schema.users).values({ email: `sale@${ORG}.local`, name: "Sale hẹp", passwordHash: "x", role: "CS" }).returning();
      const sale = sessionOf(sl, { role: "CS", permissions: ["wholesale:view", "wholesale:work"], scope: "ASSIGNED" }, modules);

      await db.insert(schema.products).values({ id: "bg-prod", name: "Chả cá thu", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values([
        { id: "bg-va", productId: "bg-prod", sku: "CCT-1K", size: "1kg", retailPrice: 300_000, weight: 1000, lastImportedPrice: 150_000 },
        { id: "bg-vb", productId: "bg-prod", sku: "CCT-500", size: "500g", retailPrice: 160_000 },
        { id: "bg-vc", productId: "bg-prod", sku: "CCT-2K", size: "2kg", retailPrice: 560_000, weight: 2000 },
        { id: "bg-vd", productId: "bg-prod", sku: "CCT-3K", size: "3kg", retailPrice: 800_000, weight: 3000 },
      ]);
      const [rc] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: new Date(), reference: "Nhập đầu kỳ", totalQuantity: 1003, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values([
        { receiptId: rc.id, variantId: "bg-va", quantity: 1000, unitCost: 150_000 },
        { receiptId: rc.id, variantId: "bg-vc", quantity: 3, unitCost: 280_000 },
      ]);
      const list = okTrade(await savePriceListCore(admin, null, { name: "Sỉ chung", isDefault: true, tiers: [{ variantId: "bg-va", minQuantity: 10, unitPrice: 250_000 }, { variantId: "bg-va", minQuantity: 50, unitPrice: 230_000 }, { variantId: "bg-vc", minQuantity: 1, unitPrice: 480_000 }, { variantId: "bg-vd", minQuantity: 1, unitPrice: 700_000 }] }));
      const [lead] = await db.insert(schema.wholesaleLeads).values({ source: "STAFF", businessName: "Nhà hàng Biển Đông", normalizedPhone: "+84905111222", address: "12 Bạch Đằng, Đà Nẵng", enrichmentStatus: "READY", contactStatus: "QUALIFIED" }).returning({ id: schema.wholesaleLeads.id });
      leadInOrg = lead.id;
      const [cust] = await db.insert(schema.customers).values({ name: "Đại lý Sơn Trà", phone: "0905333444" }).returning({ id: schema.customers.id });

      const now = new Date();
      const today = vnDateKey(now);
      const base = { leadId: lead.id, validUntil: addDays(today, 7) };

      // ── Lập nháp: đúng bậc, không chặn, không cần duyệt; ship / thuế chưa khai ⇒ NULL.
      const k1 = key();
      const c1 = ok(await createQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], requestKey: k1 }, now));
      assert.deepEqual([c1.version, c1.blockers, c1.requiresApproval, c1.replayed], [1, 0, false, false]);
      assert.match(c1.code, /^BG-\d{6}-[A-Z2-9]{4}$/);
      const [row1] = await db.select().from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, c1.id));
      assert.deepEqual([row1.status, row1.subtotal, row1.total, row1.shipping, row1.tax, row1.priceListId, row1.currency], ["DRAFT", 5_000_000, 5_000_000, null, null, list.id, "VND"]);
      const snap1 = row1.snapshot as QuotationSnapshot;
      assert.equal(snap1.result.totals.total, row1.total, "cột và ảnh chụp cùng một số");
      assert.equal(snap1.party.name, "Nhà hàng Biển Đông");
      const [line1] = await db.select().from(schema.wholesaleQuotationLines).where(eq(schema.wholesaleQuotationLines.quotationId, c1.id));
      assert.deepEqual([line1.unitPrice, line1.tierMinQty, line1.stockAvailableAtQuote, line1.priceSource], [250_000, 10, 1000, "DEFAULT_LIST"]);

      // ── Bấm hai lần (cùng request_key) ⇒ MỘT bản.
      const again = ok(await createQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], requestKey: k1 }, now));
      assert.deepEqual([again.id, again.replayed], [c1.id, true]);
      assert.equal((await db.select({ n: sql<number>`count(*)::int` }).from(schema.wholesaleQuotations))[0].n, 1);

      // ── Chặn vẫn lưu được ở dạng nháp, nhưng không gửi / không gửi duyệt được.
      const blocked = ok(await createQuotationCore(admin, { ...base, lines: [{ variantId: "bg-vb", quantity: 100 }, { variantId: "bg-va", quantity: 5 }, { variantId: "bg-vc", quantity: 5 }, { variantId: "bg-vd", quantity: 2 }], requestKey: key() }, now));
      const bSnap = ((await db.select().from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, blocked.id)))[0].snapshot as QuotationSnapshot).result;
      assert.deepEqual(codes(bSnap.blockers), ["NO_WHOLESALE_PRICE", "BELOW_MOQ", "STOCK_SHORT"], "không giá sỉ · dưới MOQ · tồn biết 3 < 5");
      assert.ok(codes(bSnap.warnings).includes("STOCK_UNVERIFIED"), "bg-vd chưa có phiếu nhập ⇒ cảnh báo, không chặn");
      assert.match(err(await markQuotationSentCore(admin, blocked.id, now)), /còn chặn/);
      assert.match(err(await submitQuotationCore(admin, blocked.id, now)), /còn chặn/);

      // ── Chiết khấu khi chủ shop CHƯA khai chính sách ⇒ cần duyệt; người lập không tự duyệt.
      const d = ok(await createQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], quoteDiscount: 100_000, requestKey: key() }, now));
      assert.equal(d.requiresApproval, true);
      assert.match(err(await markQuotationSentCore(admin, d.id, now)), /cần duyệt/);
      assert.equal(ok(await submitQuotationCore(admin, d.id, now)).status, "PENDING_APPROVAL");
      assert.equal(ok(await submitQuotationCore(admin, d.id, now)).replayed, true, "gửi duyệt hai lần không ghi thêm");
      assert.match(err(await approveQuotationCore(admin, d.id, now)), /không tự duyệt/);
      assert.match(err(await approveQuotationCore(sale, d.id, now)), /wholesale:config/);
      await assert.rejects(db.execute(sql`update wholesale_quotations set status = 'APPROVED', approved_at = now(), approved_by_user_id = created_by_user_id where id = ${d.id}`), "CHECK CSDL chặn tự duyệt kể cả khi lách lõi");
      assert.equal(ok(await approveQuotationCore(approver, d.id, now)).status, "APPROVED");
      assert.equal(ok(await approveQuotationCore(approver, d.id, now)).replayed, true);
      assert.equal(ok(await markQuotationSentCore(admin, d.id, now)).status, "SENT");
      assert.match(err(await recordQuotationDecisionCore(admin, d.id, { decision: "ACCEPTED", reason: "" }, now)), /lý do/);
      assert.equal(ok(await recordQuotationDecisionCore(admin, d.id, { decision: "ACCEPTED", reason: "Khách xác nhận qua Zalo" }, now)).status, "ACCEPTED");
      const [dRow] = await db.select().from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, d.id));
      assert.deepEqual([dRow.approvedByUserId, dRow.sentByUserId, dRow.decidedByUserId], [ap.id, u.id, u.id], "quy kết bằng khoá tài khoản (luật 34)");
      assert.match(err(await reviseQuotationCore(admin, d.id, { lines: [{ variantId: "bg-va", quantity: 30 }], validUntil: addDays(today, 7), requestKey: key() }, now)), /không sửa được/);

      // Trả lại về nháp cần lý do.
      const d2 = ok(await createQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], quoteDiscount: 50_000, requestKey: key() }, now));
      ok(await submitQuotationCore(admin, d2.id, now));
      assert.match(err(await returnQuotationCore(approver, d2.id, "x", now)), /lý do/);
      assert.equal(ok(await returnQuotationCore(approver, d2.id, "Chiết khấu cao quá", now)).status, "DRAFT");

      // ── Bản cũ BẤT BIẾN ở CSDL (trigger).
      await assert.rejects(db.execute(sql`update wholesale_quotations set subtotal = 1 where id = ${c1.id}`), "đổi tiền của một phiên bản bị trigger chặn");
      await assert.rejects(db.execute(sql`update wholesale_quotation_lines set unit_price = 1 where quotation_id = ${c1.id}`), "dòng báo giá không UPDATE được");

      // ── Sửa ⇒ phiên bản mới; bản cũ «Đã có bản mới», số không đổi; sửa lại bản cũ bị từ chối; lặp lượt sửa không đẻ thêm.
      const kRev = key();
      const v2 = ok(await reviseQuotationCore(admin, c1.id, { lines: [{ variantId: "bg-va", quantity: 60 }], shippingAmount: 120_000, shippingSource: "Báo giá cước nhà xe 27/10", validUntil: addDays(today, 10), requestKey: kRev }, now));
      assert.deepEqual([v2.code, v2.version, v2.replayed], [c1.code, 2, false]);
      const [old] = await db.select().from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, c1.id));
      assert.deepEqual([old.status, old.subtotal, old.total], ["SUPERSEDED", 5_000_000, 5_000_000], "bản cũ giữ nguyên số");
      assert.equal(ok(await reviseQuotationCore(admin, c1.id, { lines: [{ variantId: "bg-va", quantity: 60 }], validUntil: addDays(today, 10), requestKey: kRev }, now)).id, v2.id, "lặp đúng lượt sửa ⇒ trả đúng bản đã tạo");
      assert.match(err(await reviseQuotationCore(admin, c1.id, { lines: [{ variantId: "bg-va", quantity: 70 }], validUntil: addDays(today, 10), requestKey: key() }, now)), /không sửa được|phiên bản mới/);
      const [new2] = await db.select().from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, v2.id));
      assert.deepEqual([new2.subtotal, new2.shipping, new2.total, new2.parentQuotationId], [13_800_000, 120_000, 13_920_000, c1.id], "60 × 230.000 + ship có căn cứ");

      // ── Ảnh chụp KHÔNG đổi khi bảng giá đổi sau đó; xem trước thì theo giá mới.
      okTrade(await savePriceListCore(admin, list.id, { name: "Sỉ chung", isDefault: true, tiers: [{ variantId: "bg-va", minQuantity: 10, unitPrice: 260_000 }, { variantId: "bg-va", minQuantity: 50, unitPrice: 240_000 }] }));
      const det = await getQuotation(admin, v2.id, now);
      assert.ok(det && !("unavailable" in det));
      assert.deepEqual([det.row.total, det.snapshot.result.totals.subtotal, det.snapshot.result.lines[0].unitPrice], [13_920_000, 13_800_000, 230_000]);
      assert.deepEqual(det.versions.map((v) => [v.version, v.status]), [[2, "DRAFT"], [1, "SUPERSEDED"]]);
      const pv = ok(await previewQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 60 }], requestKey: key() }));
      assert.equal(pv.result.lines[0].unitPrice, 240_000, "báo giá mới đọc bảng giá mới");
      assert.notEqual(pv.result.priceVersion, det.row.priceVersion, "đổi bậc ⇒ đổi dấu phiên bản giá");

      // ── Khách đã nối bảng riêng: lập từ khách dùng bảng riêng → mặc định.
      const own = okTrade(await savePriceListCore(admin, null, { name: "Đại lý riêng", tiers: [{ variantId: "bg-va", minQuantity: 100, unitPrice: 200_000 }] }));
      await db.insert(schema.customerTradeTerms).values({ customerId: cust.id, priceListId: own.id });
      const cq = ok(await previewQuotationCore(admin, { customerId: cust.id, lines: [{ variantId: "bg-va", quantity: 100 }], validUntil: addDays(today, 3), requestKey: key() }));
      assert.deepEqual([cq.result.lines[0].unitPrice, cq.result.lines[0].priceSource, cq.result.priceListId], [200_000, "CUSTOMER_LIST", own.id]);

      // ── Chính sách đã khai ⇒ vượt trần bị chặn, trong trần + biên đủ ⇒ không cần duyệt (đọc settings thật).
      await setSettingJson(QUOTATION_SETTING_KEY, { maxDiscountPercent: 3, minMarginPercent: 20 });
      const over = ok(await previewQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], quoteDiscount: 200_000, requestKey: key() }));
      assert.deepEqual(codes(over.result.blockers), ["DISCOUNT_OVER_CAP"]);
      const fine = ok(await previewQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], quoteDiscount: 100_000, requestKey: key() }));
      assert.deepEqual([fine.result.requiresApproval, fine.result.marginPercent], [false, 41.18], "giá vốn sống = phiếu nhập 150.000 ₫ (luật 3.13); 20 × 260.000 − 100.000");

      // ── Hết hạn: tính lúc đọc, chặn gửi / ghi kết quả, không ghi đè cột.
      const ex = ok(await createQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], validUntil: today, requestKey: key() }, now));
      const tomorrow = new Date(now.getTime() + 36 * 3600_000);
      assert.match(err(await markQuotationSentCore(admin, ex.id, tomorrow)), /Hết hạn/);
      const exList = await listQuotations(admin, parseListParams({ status: "EXPIRED" }, { filterKeys: ["status"] }), tomorrow);
      assert.ok(!("unavailable" in exList) && exList.rows.some((r) => r.id === ex.id && r.status === "EXPIRED"), "SQL và TS cùng kết luận hết hạn");
      assert.equal((await db.select({ s: schema.wholesaleQuotations.status }).from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.id, ex.id)))[0].s, "DRAFT", "không ghi đè lịch sử");
      assert.match(err(await createQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], validUntil: addDays(today, -1), requestKey: key() }, now)), /đã qua/);

      // ── Phạm vi: sale «Được giao» không chạm lead không giao cho mình, không thấy báo giá của lead đó.
      assert.match(err(await createQuotationCore(sale, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], requestKey: key() }, now)), /phạm vi/);
      const saleList = await listQuotations(sale, parseListParams({}, {}), now);
      assert.ok(!("unavailable" in saleList) && saleList.total === 0, "không thấy báo giá ngoài phạm vi");
      assert.equal(await getQuotation(sale, c1.id, now), null);
      assert.match(err(await markQuotationSentCore(sale, v2.id, now)), /phạm vi|Không tìm thấy/);

      idInOrg = v2.id;
      codeInOrg = v2.code;

      // ── CSDL chưa áp 0263 (MIGRATION_SERVE_COMPAT): đọc ⇒ unavailable, ghi ⇒ câu lỗi; không sập.
      assert.ok(isMissingQuotationTable({ code: "42P01" }) && isMissingQuotationTable({ cause: { code: "42P01" } }) && !isMissingQuotationTable({ code: "23505" }));
      await db.execute(sql`drop table wholesale_quotation_lines`);
      await db.execute(sql`drop table wholesale_quotations`);
      assert.deepEqual(await listQuotations(admin, parseListParams({}, {}), now), { unavailable: true });
      assert.equal(err(await createQuotationCore(admin, { ...base, lines: [{ variantId: "bg-va", quantity: 20 }], requestKey: key() }, now)), QUOTATION_TABLES_MISSING);
      assert.equal(err(await approveQuotationCore(approver, v2.id, now)), QUOTATION_TABLES_MISSING);
    });

    // ── Cách ly tổ chức: CSDL nhà không thấy báo giá / lead của tổ chức khách.
    const homeAdmin: SessionUser = { id: "home-admin", email: "home@local", name: "Nhà", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null };
    const h = await getQuotation(homeAdmin, idInOrg);
    assert.ok(h === null, "id của tổ chức khác không đọc được ở CSDL nhà");
    const hl = await listQuotations(homeAdmin, parseListParams({ q: codeInOrg }, {}));
    assert.ok(!("unavailable" in hl) && hl.rows.every((r) => r.code !== codeInOrg));
    assert.match(err(await createQuotationCore(homeAdmin, { leadId: leadInOrg, lines: [{ variantId: "bg-va", quantity: 20 }], validUntil: addDays(vnDateKey(new Date()), 3), requestKey: key() })), /Không tìm thấy lead/);
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ tổ chức thật: nháp từ lead · bấm hai lần một bản · không tự duyệt (lõi + CHECK) · bất biến (trigger) · phiên bản mới · ảnh chụp không đổi khi bảng giá đổi · bảng riêng của khách · chính sách đã khai · hết hạn lúc đọc · phạm vi · chưa áp 0263 · cách ly tổ chức");
}

export async function testWholesaleQuotation() {
  console.log("\n— Báo giá sỉ tất định (P1b · 0263)");
  testPure();
  await testOrg();
}
