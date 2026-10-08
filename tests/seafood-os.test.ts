/**
 * SEAFOOD OS · S4 — mẫu ngành «Hải sản — bán lẻ + bán sỉ» + chatbot báo giá theo bảng giá sỉ (docs/verticals/seafood-os.md).
 *
 *  1. THUẦN — mẫu qua bộ kiểm blueprint; đủ module của Seafood OS, không bật module dựng trên connector chỉ-nhà; vai trò
 *     không cầm quyền của module mẫu không bật; không chu kỳ / hạn mức / giá mặc định nào; loại hình «Hải sản» ở /start.
 *  2. TỔ CHỨC THẬT (PGlite riêng): cài mẫu ⇒ đúng bộ module; chatbot TẮT báo giá sỉ ⇒ giá lẻ như trước (kể cả có bảng
 *     giá); BẬT ⇒ đơn giá = `quoteUnitPrice` (bảng mặc định cho khách chưa nhận ra, bảng riêng cho khách đã gán), kèm bậc
 *     «mua từ», và giỏ hàng tính bằng cùng đơn giá; lời nhắc của bot đổi theo công tắc.
 */
import { manualVariantSchema } from "@/lib/validation/products";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { SEAFOOD_COMMERCE_BLUEPRINT } from "@/lib/blueprints/templates/seafood-commerce";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { moduleDef, moduleOfPermission } from "@/lib/constants/platform-modules";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { savePriceListCore, setCustomerTermsCore } from "@/lib/records/trade";
import { parseSalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { systemPrompt } from "@/lib/sales-chatbot/engine";
import { executeTool, type ChatState, onlyAddOns } from "@/lib/sales-chatbot/tools";

const ORG = "sf-si";

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

function testPure() {
  const bp = SEAFOOD_COMMERCE_BLUEPRINT;
  const v = validateBlueprint(bp);
  assert.ok(v.ok, JSON.stringify(v.errors));
  for (const m of ["customers", "products", "orders", "inventory", "purchasing", "ai_sales"] as const) assert.ok(bp.modules.includes(m), `thiếu module ${m}`);
  for (const m of bp.modules) assert.ok(!moduleDef(m)?.requiresHomeCredentials, `«${m}» cần credential nhà`);
  for (const m of ["logistics", "customer_care"] as const) assert.ok(!bp.modules.includes(m), `mẫu hải sản không bật ${m} (dựng trên connector chỉ-nhà)`);
  for (const r of bp.roles ?? []) for (const p of r.permissions) {
    const mod = moduleOfPermission(p);
    assert.ok(!mod || bp.modules.includes(mod), `vai trò ${r.key} cầm «${p}» của module ${mod} mà mẫu không bật`);
  }
  assert.ok(bp.fields?.some((f) => f.objectKey === "customer" && f.key === "loai_khach"));
  const text = JSON.stringify(bp);
  assert.ok(!/defaultCycleDays|credit_?limit|crm\.reorder|HSLC|Làng Chài/i.test(text), "mẫu không khai chu kỳ / hạn mức / tên khách nào (luật 38)");
  assert.equal(BUSINESS_TYPE_SPEC.seafood.templateKey, "seafood-commerce");
  assert.equal(parseSalesChatbotConfig(null).wholesalePricing, false, "báo giá sỉ của bot mặc định TẮT");
  assert.equal(parseSalesChatbotConfig({ enabled: true }).wholesalePricing, false, "cấu hình lưu từ trước 0188 ⇒ TẮT");
}

export async function testSeafoodOs() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản thử", plan: "standard", modules: [], admin: { email: `admin@${ORG}.local`, name: "QT hải sản", password: "HaiSan@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const sessionOf = async (): Promise<SessionUser> => ({ id: u.id, email: u.email, name: "QT hải sản", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản thử", isHome: false }, modules: [...(await getEnabledModules(ORG))] });

      // ── Cài mẫu ⇒ đúng bộ module.
      let admin = await sessionOf();
      const plan = await planForOrg(SEAFOOD_COMMERCE_BLUEPRINT, admin);
      assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
      const done = await installBlueprint(SEAFOOD_COMMERCE_BLUEPRINT, admin, { expectedPlanHash: plan.planHash });
      assert.ok(done.ok, JSON.stringify(done));
      assert.deepEqual([...(await getEnabledModules(ORG))].sort(), [...SEAFOOD_COMMERCE_BLUEPRINT.modules].sort());
      admin = await sessionOf();

      // ── Dữ liệu: một mẫu mã giá lẻ 200k; bảng mặc định (từ 10: 170k); bảng riêng «Đại lý» (từ 1: 160k · từ 20: 150k).
      await db.insert(schema.products).values({ id: "erp-sf-prod", name: "Mực ống loại 1", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-sf-v", productId: "erp-sf-prod", sku: "MO-1", size: "1kg", retailPrice: 200_000 });
      const dflt = await savePriceListCore(admin, null, { name: "Sỉ chung", isDefault: true, tiers: [{ variantId: "erp-sf-v", minQuantity: 10, unitPrice: 170_000 }] });
      const dl = await savePriceListCore(admin, null, { name: "Đại lý", tiers: [{ variantId: "erp-sf-v", minQuantity: 1, unitPrice: 160_000 }, { variantId: "erp-sf-v", minQuantity: 20, unitPrice: 150_000 }] });
      assert.ok(dflt.ok && dl.ok);
      const [agent] = await db.insert(schema.customers).values({ name: "Đại lý Cửa Biển", phone: "0912000111" }).returning({ id: schema.customers.id });
      assert.ok((await setCustomerTermsCore(admin, agent.id, { priceListId: dl.id })).ok);

      const ctx = (wholesalePricing: boolean, state: ChatState) => ({ conversationId: "sf", channel: "TEST" as const, config: { ...parseSalesChatbotConfig(null), wholesalePricing }, state, lastUserText: "", agent: { name: "bot", source: "test" } });
      const priceOf = async (wholesale: boolean, state: ChatState, quantity?: number) => {
        const r = await executeTool("get_current_price", { variant_id: "erp-sf-v", ...(quantity ? { quantity } : {}) }, ctx(wholesale, state));
        assert.ok(!r.isError, r.content);
        return JSON.parse(r.content) as { price: number | null; price_source?: string | null; tiers?: { min_quantity: number; unit_price: number }[]; wholesale?: { available: boolean; from_quantity: number | null; note: string } };
      };
      // Bảng giá RIÊNG chỉ khi danh tính đã XÁC MINH (mã Facebook / hội thoại từng có đơn của hồ sơ) — review bảo mật 08/10/2026:
      // ai gõ SĐT của đại lý cũng nhận ra hồ sơ đại lý, nên hồ sơ khớp qua SĐT gõ tay chỉ được bảng MẶC ĐỊNH.
      const known: ChatState = { customer: { id: agent.id, name: "Đại lý Cửa Biển", phone: "0912000111", address: "", province: "", simulated: false, verifiedIdentity: true } };
      const typedOnly: ChatState = { customer: { ...known.customer!, verifiedIdentity: undefined } };

      // TẮT ⇒ giá lẻ, kể cả khách có bảng riêng và số lượng lớn.
      assert.equal((await priceOf(false, known, 50)).price, 200_000);
      // BẬT, khách chưa nhận ra ⇒ bảng mặc định theo bậc.
      const duoiBac = await priceOf(true, {}, 5);
      assert.equal(duoiBac.price, 200_000, "chưa tới bậc thấp nhất của bảng mặc định ⇒ giá lẻ");
      // Chủ shop HSLC 08/10/2026: hỏi giá sỉ thì trả lời bằng BẢNG GIÁ SỈ, không lấy giá lẻ — `price` lùi về giá lẻ phải đi kèm
      // nguồn giá + câu nói thẳng, để AI không báo 200k như «giá sỉ».
      assert.equal(duoiBac.price_source, "RETAIL");
      assert.deepEqual(duoiBac.wholesale && [duoiBac.wholesale.available, duoiBac.wholesale.from_quantity], [true, 10]);
      assert.match(duoiBac.wholesale?.note ?? "", /GIÁ LẺ/);
      assert.match(duoiBac.wholesale?.note ?? "", /KHÔNG báo giá lẻ như giá sỉ/);
      const anon = await priceOf(true, {}, 12);
      assert.equal(anon.price, 170_000);
      assert.equal(anon.price_source, "DEFAULT_LIST");
      assert.match(anon.wholesale?.note ?? "", /giá theo bảng giá sỉ/);
      assert.deepEqual(anon.tiers?.map((t) => [t.min_quantity, t.unit_price]), [[10, 170_000]]);
      // Mẫu mã KHÔNG có trong bảng nào ⇒ không có giá sỉ để báo: công cụ nói thẳng, không để AI lấy giá lẻ thay.
      await db.insert(schema.productVariants).values({ id: "erp-sf-v0", productId: "erp-sf-prod", sku: "MO-2", size: "0,5kg", retailPrice: 110_000 });
      const khongBac = await executeTool("get_current_price", { variant_id: "erp-sf-v0", quantity: 30 }, ctx(true, {}));
      assert.ok(!khongBac.isError, khongBac.content);
      const kb = JSON.parse(khongBac.content) as { price: number | null; price_source: string | null; tiers: unknown[]; wholesale: { available: boolean; note: string } };
      assert.equal(kb.price, 110_000, "tiền đơn vẫn là giá lẻ — luật tính tiền không đổi");
      assert.equal(kb.price_source, "RETAIL");
      assert.deepEqual([kb.tiers.length, kb.wholesale.available], [0, false]);
      assert.match(kb.wholesale.note, /CHƯA CÓ trong bảng giá sỉ/);
      assert.match(kb.wholesale.note, /handoff_to_human/);
      assert.ok(khongBac.summary.includes("chưa có giá sỉ"), khongBac.summary);
      // BẬT, khách đã gán bảng ⇒ bảng riêng.
      const mine = await priceOf(true, known, 25);
      assert.equal(mine.price, 150_000);
      assert.deepEqual(mine.tiers?.map((t) => [t.min_quantity, t.unit_price]), [[1, 160_000], [20, 150_000]]);
      const spoof = await priceOf(true, typedOnly, 25);
      assert.equal(spoof.price, 170_000, "khớp hồ sơ đại lý qua SĐT gõ tay ⇒ bảng mặc định, KHÔNG giá riêng của đại lý");
      assert.deepEqual(spoof.tiers?.map((t) => [t.min_quantity, t.unit_price]), [[10, 170_000]], "không lộ bậc giá riêng");
      // Giỏ hàng tính bằng CÙNG đơn giá.
      const cart = await executeTool("calculate_cart", { items: [{ variant_id: "erp-sf-v", quantity: 25 }] }, ctx(true, known));
      assert.ok(!cart.isError, cart.content);
      assert.equal((JSON.parse(cart.content) as { lines: { unit_price: number; line_total: number }[] }).lines[0].line_total, 25 * 150_000);
      const cartOff = await executeTool("calculate_cart", { items: [{ variant_id: "erp-sf-v", quantity: 25 }] }, ctx(false, known));
      assert.equal((JSON.parse(cartOff.content) as { lines: { unit_price: number }[] }).lines[0].unit_price, 200_000);

      // ── MẪU MÃ CHỈ BÁN KÈM (0237 · chủ shop HSLC 09/10/2026): 0,5kg không báo giá riêng, không bán riêng ──
      await db.insert(schema.productVariants).values({ id: "erp-sf-v05", productId: "erp-sf-prod", sku: "MO-05", size: "0,5kg", retailPrice: 105_000, addOnOnly: true });
      const tim = await executeTool("search_products", { query: "mực ống" }, ctx(false, {}));
      const kq = JSON.parse(tim.content) as { results: { variant_id: string; add_on_only?: boolean; note?: string }[] };
      const v05 = kq.results.find((r) => r.variant_id === "erp-sf-v05");
      assert.ok(v05?.add_on_only === true && /CHỈ BÁN KÈM/.test(v05.note ?? ""), `mẫu mã bán kèm mang cờ + lời dặn: ${tim.content}`);
      assert.ok(kq.results.findIndex((r) => r.variant_id === "erp-sf-v05") > kq.results.findIndex((r) => r.variant_id === "erp-sf-v"), "mẫu mã chính đứng trước mẫu mã bán kèm");
      assert.ok(!("add_on_only" in (kq.results.find((r) => r.variant_id === "erp-sf-v") ?? {})), "mẫu mã chính không mang cờ");
      const chiKem = await executeTool("calculate_cart", { items: [{ variant_id: "erp-sf-v05", quantity: 1 }] }, ctx(false, {}));
      assert.ok(chiKem.isError && /CHỈ BÁN KÈM/.test(chiKem.content), `giỏ chỉ có 0,5kg ⇒ từ chối: ${chiKem.content}`);
      const ghep = await executeTool("calculate_cart", { items: [{ variant_id: "erp-sf-v", quantity: 1 }, { variant_id: "erp-sf-v05", quantity: 1 }] }, ctx(false, {}));
      assert.ok(!ghep.isError, ghep.content);
      assert.equal((JSON.parse(ghep.content) as { subtotal: number }).subtotal, 305_000, "1kg + 0,5kg bán kèm ⇒ tổng đúng");
      const khach: ChatState = { customer: { id: null, name: "Khách thử", phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm", province: "Hà Nội", simulated: true } };
      const nhap = await executeTool("create_draft_order", { items: [{ variant_id: "erp-sf-v05", quantity: 2 }] }, ctx(false, khach));
      assert.ok(nhap.isError && /CHỈ BÁN KÈM/.test(nhap.content), `đơn nháp chỉ có món bán kèm ⇒ máy chủ chặn: ${nhap.content}`);
      const nhap2 = await executeTool("create_draft_order", { items: [{ variant_id: "erp-sf-v", quantity: 1 }, { variant_id: "erp-sf-v05", quantity: 1 }] }, ctx(false, khach));
      assert.ok(!nhap2.isError, nhap2.content);
      const doiMon = await executeTool("update_draft_order", { items: [{ variant_id: "erp-sf-v05", quantity: 1 }] }, ctx(false, nhap2.state));
      assert.ok(doiMon.isError && /CHỈ BÁN KÈM/.test(doiMon.content), "sửa đơn bỏ hết món chính ⇒ chặn");
      assert.equal(onlyAddOns([{ variantId: "a" }, { variantId: "b" }], new Map([["a", { addOnOnly: true }], ["b", {}]])), false);
      assert.equal(onlyAddOns([{ variantId: "a" }], new Map([["a", { addOnOnly: true }]])), true);
      assert.equal(onlyAddOns([], new Map()), false, "giỏ rỗng không phải «chỉ bán kèm»");
      assert.equal(manualVariantSchema.parse({ sku: "X-1" }).addOnOnly, false, "mặc định KHÔNG bán kèm — mẫu mã cũ giữ nguyên hành vi");

      // Lời nhắc của bot đổi theo công tắc.
      const on = systemPrompt({ ...parseSalesChatbotConfig(null), wholesalePricing: true }, "Shop", "", "TEST");
      const off = systemPrompt(parseSalesChatbotConfig(null), "Shop", "", "TEST");
      assert.ok(on.includes("ĐÃ BẬT báo giá theo bảng giá") && !on.includes("ERP chỉ có giá LẺ"));
      assert.ok(on.includes("KHÔNG BAO GIỜ đưa giá lẻ ra như giá sỉ") && on.includes("`wholesale.available` = false"), "lời nhắc BẬT: giá lẻ không bao giờ là giá sỉ; không bậc ⇒ chuyển người");
      assert.ok(off.includes("ERP chỉ có giá LẺ") && !off.includes("ĐÃ BẬT báo giá"));
      assert.ok(off.includes("MẪU MÃ CHỈ BÁN KÈM") && off.includes("MỤC TIÊU") && off.includes("ĐƠN SÁT NGƯỠNG MIỄN SHIP"), "lời nhắc nói mục tiêu đơn / AOV, luật bán kèm và gợi ý ngưỡng miễn ship");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("✓ Seafood OS · mẫu hải sản: qua bộ kiểm, đủ module (mua hàng, chatbot), không module connector chỉ-nhà, không số mặc định; cài đúng bộ module; chatbot TẮT ⇒ giá lẻ, BẬT ⇒ bảng mặc định / bảng riêng theo bậc kèm «mua từ» + nguồn giá + khối giá sỉ (không bậc ⇒ chuyển người, dưới bậc ⇒ nói bậc, không báo giá lẻ như giá sỉ), giỏ hàng cùng đơn giá, lời nhắc đổi theo công tắc");
}
