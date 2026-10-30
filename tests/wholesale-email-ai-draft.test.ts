/**
 * AI SOẠN EMAIL CHÀO HÀNG (P2b · 0265 · lib/wholesale/email-ai-draft.ts + email-ai-draft-guard.ts). AI GIẢ — không gọi mạng.
 *
 *  1. THUẦN: hàng rào chặn số tiền lệch bảng giá, tiền tệ khác VND, chứng nhận / xuất khẩu / tồn / thời gian giao không có nguồn,
 *     % không có trong dữ kiện, link / SĐT bịa, sai ngôn ngữ. Thư đúng dữ kiện thì qua. Ngôn ngữ theo nước của lead. Đo tỷ lệ sửa.
 *  2. TỔ CHỨC THẬT: mặc định TẮT; chỉ `wholesale:config` bật và phải khai trần. Nháp đúng ⇒ DRAFT, nháp bịa ⇒ BLOCKED và không vào
 *     hộp thư đi. Sổ dùng AI có dòng feature `b2b_email_draft`. Người duyệt đưa vào hộp thư đi ⇒ thư DRAFT của E1 kèm tỷ lệ sửa,
 *     và bản cuối vi phạm thì bị từ chối. Có trần nháp / ngày. AI lỗi ⇒ không lưu. Chưa áp 0265 ⇒ không gọi AI.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { savePriceListCore } from "@/lib/records/trade";
import { AI_DRAFT_TABLE_MISSING, aiDraftEmailCore, discardAiDraftCore, parseDraftOutput, promoteAiDraftCore, saveEmailAiSettingsCore } from "@/lib/wholesale/email-ai-draft";
import { draftLanguageFor, draftViolations, editRatio, type DraftGuardFacts } from "@/lib/wholesale/email-ai-draft-guard";

const ORG = "em-ai";
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

function testPure() {
  const facts: DraftGuardFacts = {
    language: "vi",
    allowedAmounts: new Set([250_000, 230_000]),
    factsText: "Tên doanh nghiệp: Nhà hàng Biển Đông\nBảng giá sỉ:\n- Chả cá thu (1kg): từ 10: 250.000 ₫; từ 50: 230.000 ₫\nEmail người gửi: sales@hslc.vn",
    deliveryNote: "",
  };
  const good = "Kính gửi Quý anh/chị Nhà hàng Biển Đông, bên em là Hải Sản Làng Chài. Chả cá thu gói 1kg có giá sỉ 250.000 ₫ khi lấy từ 10 gói, và 230.000 ₫ từ 50 gói. Anh/chị trả lời email này để nhận báo giá chi tiết ạ. Liên hệ: sales@hslc.vn";
  assert.deepEqual(draftViolations("Bảng giá sỉ chả cá", good, facts), [], "thư đúng dữ kiện thì qua");
  assert.deepEqual(codes(draftViolations("Báo giá", good.replace("230.000 ₫", "199.000 ₫"), facts)), ["AMOUNT_UNVERIFIED"], "số tiền lệch bảng giá ⇒ chặn");
  assert.deepEqual(codes(draftViolations("Báo giá", `${good} Giá chỉ 10 USD/kg.`, facts)), ["FOREIGN_CURRENCY"], "tiền tệ khác VND ⇒ chặn");
  assert.deepEqual(codes(draftViolations("Báo giá", `${good} Sản phẩm đạt chứng nhận HACCP.`, facts)), ["CERTIFICATION_CLAIM"]);
  assert.deepEqual(codes(draftViolations("Báo giá", `${good} Bên em nhận xuất khẩu đi mọi nước.`, facts)), ["EXPORT_CLAIM"]);
  assert.deepEqual(codes(draftViolations("Báo giá", `${good} Hàng luôn có sẵn hàng số lượng lớn.`, facts)), ["STOCK_CLAIM"]);
  assert.deepEqual(codes(draftViolations("Báo giá", `${good} Giao hàng trong 2 ngày.`, facts)), ["DELIVERY_TIME_CLAIM"], "shop chưa khai giao hàng ⇒ không được nói thời gian giao");
  assert.deepEqual(codes(draftViolations("Báo giá", `${good} Giao hàng trong 2 ngày.`, { ...facts, deliveryNote: "Giao nội thành Đà Nẵng trong 2 ngày" })), [], "đúng lời khai của shop thì qua");
  assert.deepEqual(codes(draftViolations("Báo giá", `${good} Giao hàng trong 1 ngày.`, { ...facts, deliveryNote: "Giao nội thành Đà Nẵng trong 2 ngày" })), ["DELIVERY_TIME_CLAIM"], "khác lời khai ⇒ chặn");
  assert.deepEqual(codes(draftViolations("Báo giá", `${good} Đơn đầu giảm 10%.`, facts)), ["DISCOUNT_UNVERIFIED"]);
  assert.deepEqual(codes(draftViolations("Báo giá", `${good} Gọi 0905 123 456 hoặc xem https://hslc.example.com`, facts)), ["CONTACT_INVENTED"]);
  assert.deepEqual(codes(draftViolations("Price list", "Dear Sir, we are a Vietnamese seafood supplier. Our fish cake 1kg is 250.000 VND from 10 packs. Please reply for a detailed quotation.", facts)), ["WRONG_LANGUAGE"], "lead trong nước mà thư tiếng Anh ⇒ chặn");
  assert.deepEqual(draftViolations("Price list", "Dear Sir, we are a Vietnamese seafood supplier. Our fish cake 1kg is 250.000 VND from 10 packs and 230.000 VND from 50 packs. Please reply for a detailed quotation.", { ...facts, language: "en" }), [], "tiếng Anh, giá VND đúng ⇒ qua");
  assert.deepEqual(codes(draftViolations("x", "", facts)), ["EMPTY"]);
  assert.equal(draftLanguageFor({ phoneCountryCode: "84", websiteDomain: "quan.vn" }), "vi");
  assert.equal(draftLanguageFor({ phoneCountryCode: null, websiteDomain: null }), "vi", "không dấu hiệu nước ngoài ⇒ trong nước");
  assert.equal(draftLanguageFor({ phoneCountryCode: "1", websiteDomain: "shop.com" }), "en");
  assert.equal(draftLanguageFor({ phoneCountryCode: null, websiteDomain: "fisch.de" }), "en");
  assert.equal(draftLanguageFor({ phoneCountryCode: "1", websiteDomain: null, diaspora: true }), "vi", "Việt Kiều ⇒ tiếng Việt");
  assert.deepEqual(parseDraftOutput("SUBJECT: Chào anh chị\n---\nNội dung", "mặc định"), { subject: "Chào anh chị", body: "Nội dung" });
  assert.deepEqual(parseDraftOutput("Không đúng định dạng", "mặc định"), { subject: "mặc định", body: "Không đúng định dạng" });
  assert.equal(editRatio("a b c d", "a b c d"), 0);
  assert.equal(editRatio("a b c d", "a x c d"), 0.25);
  console.log("  ✓ thuần: chặn số tiền lệch · ngoại tệ · chứng nhận · xuất khẩu · tồn · thời gian giao · % · liên hệ bịa · sai ngôn ngữ; ngôn ngữ theo nước; tỷ lệ sửa");
}

class FakeAi implements AiProvider {
  readonly name = "fake";
  readonly model = "gemini-2.5-flash";
  readonly schemaDialect = "openai" as const;
  calls = 0;
  lastSystem = "";
  constructor(public reply: string | Error) {}
  async complete(req: AiRequest): Promise<AiResponse> {
    this.lastSystem = req.system;
    this.calls += 1;
    if (this.reply instanceof Error) throw this.reply;
    return { content: [{ type: "text", text: this.reply }], stopReason: "end_turn", usage: { inputTokens: 800, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.model, latencyMs: 5 };
  }
}

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

const errOf = (r: object) => ("error" in r ? String((r as { error: string }).error) : "");

async function testOrg() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản email AI", plan: "standard", modules: ["customers", "products", "orders", "inventory", "wholesale_leads"], admin: { email: `admin@${ORG}.local`, name: "QT email", password: "EmailAi@12345" }, source: "TEST", actor: null });
  try {
    const modules = [...(await getEnabledModules(ORG))];
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const base = { departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản email AI", isHome: false }, modules };
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", ...base };
      const [sl] = await db.insert(schema.users).values({ email: `sale@${ORG}.local`, name: "Sale", passwordHash: "x", role: "CS" }).returning();
      const sale: SessionUser = { id: sl.id, email: sl.email, name: sl.name, role: "CS", permissions: ["wholesale:view", "wholesale:work"], scope: "ALL", ...base };

      await db.insert(schema.products).values({ id: "ea-prod", name: "Chả cá thu", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "ea-va", productId: "ea-prod", sku: "CCT-1K", size: "1kg", retailPrice: 300_000 });
      const list = await savePriceListCore(admin, null, { name: "Sỉ chung", isDefault: true, tiers: [{ variantId: "ea-va", minQuantity: 10, unitPrice: 250_000 }, { variantId: "ea-va", minQuantity: 50, unitPrice: 230_000 }] });
      assert.ok(list.ok);
      const [vn] = await db.insert(schema.wholesaleLeads).values({ source: "STAFF", businessName: "Nhà hàng Biển Đông", email: "mua@biendong.vn", phoneCountryCode: "84", enrichmentStatus: "READY", contactStatus: "QUALIFIED" }).returning({ id: schema.wholesaleLeads.id });
      const [us] = await db.insert(schema.wholesaleLeads).values({ source: "STAFF", businessName: "Pacific Seafood Market", email: "buyer@pacificseafood.com", phoneCountryCode: "1", websiteDomain: "pacificseafood.com", enrichmentStatus: "READY", contactStatus: "QUALIFIED" }).returning({ id: schema.wholesaleLeads.id });

      const goodVi = "SUBJECT: Bảng giá sỉ chả cá thu\n---\nKính gửi Quý anh/chị Nhà hàng Biển Đông, bên em chuyên hải sản đóng gói. Chả cá thu gói 1kg có giá sỉ 250.000 ₫ khi lấy từ 10 gói và 230.000 ₫ từ 50 gói. Anh/chị vui lòng trả lời email này để nhận báo giá chi tiết ạ.";
      const fake = new FakeAi(goodVi);
      const deps = { ai: { provider: fake, source: "BYOK" as const } };

      // ── Mặc định TẮT; chỉ wholesale:config bật, phải khai trần + lý do.
      assert.match(errOf(await aiDraftEmailCore(admin, vn.id, new Date(), deps)), /TẮT/);
      assert.equal(fake.calls, 0, "tắt ⇒ không gọi AI");
      assert.match(errOf(await saveEmailAiSettingsCore(sale, { enabled: true, dailyMaxDrafts: 5, dailyCostCapUsd: 1, reason: "thí điểm" })), /wholesale:config/);
      assert.match(errOf(await saveEmailAiSettingsCore(admin, { enabled: true, reason: "thí điểm" })), /trần/);
      assert.ok("ok" in (await saveEmailAiSettingsCore(admin, { enabled: true, dailyMaxDrafts: 6, dailyCostCapUsd: 1, reason: "Thí điểm HSLC 30/10" })));

      // ── Nháp đúng ⇒ DRAFT, đúng ngôn ngữ, có chi phí, sổ dùng AI có dòng.
      const d1 = await aiDraftEmailCore(sale, vn.id, new Date(), deps);
      assert.ok("ok" in d1, errOf(d1));
      assert.deepEqual([d1.status, d1.language, d1.violations.length], ["DRAFT", "vi", 0]);
      const [row1] = await db.select().from(schema.wholesaleEmailAiDrafts).where(eq(schema.wholesaleEmailAiDrafts.id, d1.id));
      assert.equal(row1.model, "gemini-2.5-flash");
      assert.ok(row1.costUsd !== null && row1.costUsd > 0, "chi phí ước tính từ bảng giá model");
      assert.equal(row1.requestedByUserId, sl.id);
      const pdb = await getPlatformDb();
      const usage = await pdb.select().from(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, ORG), eq(schema.platformAiUsage.feature, "b2b_email_draft")));
      assert.ok(usage.some((x) => x.status === "OK" && x.workload === "lead_hunter"), "sổ dùng AI ghi theo tổ chức + tính năng mới");
      assert.equal((await db.select().from(schema.wholesaleEmailOutbox)).length, 0, "nháp AI KHÔNG tự vào hộp thư đi");

      // ── Nháp bịa ⇒ BLOCKED, không đưa được.
      fake.reply = goodVi.replace("230.000 ₫", "199.000 ₫");
      const d2 = await aiDraftEmailCore(sale, vn.id, new Date(), deps);
      assert.ok("ok" in d2 && d2.status === "BLOCKED" && codes(d2.violations).includes("AMOUNT_UNVERIFIED"));
      fake.reply = `${goodVi} Sản phẩm đạt chứng nhận HACCP.`;
      const d3 = await aiDraftEmailCore(sale, vn.id, new Date(), deps);
      assert.ok("ok" in d3 && d3.status === "BLOCKED" && codes(d3.violations).includes("CERTIFICATION_CLAIM"));
      assert.match(errOf(await promoteAiDraftCore(admin, d3.id, { subject: "Bảng giá", body: goodVi.split("---\n")[1] })), /chặn/);
      assert.ok("ok" in (await discardAiDraftCore(admin, d3.id, "Câu chứng nhận bịa")));

      // ── Lead nước ngoài ⇒ tiếng Anh; AI viết tiếng Việt ⇒ chặn.
      fake.reply = goodVi;
      const e1 = await aiDraftEmailCore(sale, us.id, new Date(), deps);
      assert.ok("ok" in e1 && e1.language === "en" && codes(e1.violations).includes("WRONG_LANGUAGE"));
      fake.reply = "SUBJECT: Wholesale fish cake price list\n---\nDear Pacific Seafood Market team, we are a Vietnamese seafood supplier. Our frozen fish cake 1kg is 250.000 VND per pack from 10 packs and 230.000 VND from 50 packs. Please reply to this email for a detailed quotation.";
      const e2 = await aiDraftEmailCore(sale, us.id, new Date(), deps);
      assert.ok("ok" in e2 && e2.status === "DRAFT" && e2.language === "en", errOf(e2));
      assert.match(fake.lastSystem, /^You write/, "lead nước ngoài ⇒ lời nhắc tiếng Anh");

      // ── Người duyệt: bản cuối vi phạm ⇒ từ chối; hợp lệ ⇒ thư DRAFT của E1 + tỷ lệ sửa + người duyệt.
      const body = goodVi.split("---\n")[1];
      assert.match(errOf(await promoteAiDraftCore(admin, d1.id, { subject: "Bảng giá sỉ chả cá thu", body: `${body} Giảm thêm 15% cho đơn đầu.` })), /vi phạm/);
      const p1 = await promoteAiDraftCore(admin, d1.id, { subject: "Bảng giá sỉ chả cá thu", body: body.replace("bên em chuyên hải sản đóng gói", "Hải Sản Làng Chài chuyên hải sản đóng gói") });
      assert.ok("ok" in p1, errOf(p1));
      assert.ok(p1.editRatio > 0 && p1.editRatio < 0.5);
      const [mail] = await db.select().from(schema.wholesaleEmailOutbox).where(eq(schema.wholesaleEmailOutbox.id, p1.outboxId));
      assert.deepEqual([mail.status, mail.preparedBy, mail.aiModel, mail.toEmail, mail.language, mail.approvedByUserId], ["DRAFT", "AI", "gemini-2.5-flash", "mua@biendong.vn", "vi", null], "vào hộp thư đi ở trạng thái CHỜ DUYỆT GỬI");
      const [row1b] = await db.select().from(schema.wholesaleEmailAiDrafts).where(eq(schema.wholesaleEmailAiDrafts.id, d1.id));
      assert.deepEqual([row1b.status, row1b.reviewedByUserId, row1b.outboxId], ["PROMOTED", u.id, p1.outboxId]);
      const again = await promoteAiDraftCore(admin, d1.id, { subject: "x x x", body });
      assert.ok("ok" in again && again.outboxId === p1.outboxId, "bấm hai lần không tạo hai thư");

      // ── Trần nháp / ngày (6): đã soạn 6 lượt ⇒ lượt thứ 7 bị chặn, không gọi AI.
      const before = fake.calls;
      fake.reply = goodVi;
      await aiDraftEmailCore(sale, vn.id, new Date(), deps);
      assert.match(errOf(await aiDraftEmailCore(sale, vn.id, new Date(), deps)), /trần 6 nháp/);
      assert.equal(fake.calls, before + 1, "chạm trần ⇒ không gọi AI");

      // ── AI lỗi ⇒ không lưu nháp, sổ ghi ERROR.
      await saveEmailAiSettingsCore(admin, { enabled: true, dailyMaxDrafts: 50, dailyCostCapUsd: 1, reason: "nâng trần thử" });
      const n0 = (await db.select().from(schema.wholesaleEmailAiDrafts)).length;
      const broken = new FakeAi(new Error("hết hạn mức"));
      assert.match(errOf(await aiDraftEmailCore(sale, vn.id, new Date(), { ai: { provider: broken, source: "BYOK" } })), /AI lỗi/);
      assert.equal((await db.select().from(schema.wholesaleEmailAiDrafts)).length, n0);

      // ── Chưa áp 0265 ⇒ câu lỗi, KHÔNG gọi AI.
      await db.execute(sql`drop table wholesale_email_ai_drafts`);
      const spy = new FakeAi(goodVi);
      assert.equal(errOf(await aiDraftEmailCore(sale, vn.id, new Date(), { ai: { provider: spy, source: "BYOK" } })), AI_DRAFT_TABLE_MISSING);
      assert.equal(spy.calls, 0);
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ tổ chức thật: mặc định TẮT · chỉ wholesale:config bật kèm trần · nháp đúng ⇒ DRAFT + sổ dùng AI · bịa ⇒ BLOCKED, không vào hộp thư đi · tiếng Anh cho lead nước ngoài · người duyệt + tỷ lệ sửa · trần / ngày · AI lỗi · chưa áp 0265");
}

export async function testWholesaleEmailAiDraft() {
  console.log("\n— AI soạn email chào hàng sỉ (P2b · 0265)");
  testPure();
  await testOrg();
}
