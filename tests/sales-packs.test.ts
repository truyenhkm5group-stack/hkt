/**
 * GÓI NGÀNH CỦA LỜI NHẮC CHATBOT (lib/sales-chatbot/packs.ts · docs/productization/MIGRATION_PLAN.md M5).
 *
 *  · Gói `food` = chữ cũ (Hải Sản Làng Chài nhận lời nhắc giống hệt): lời nhắc mặc định = lời nhắc gói `food`, và mọi câu
 *    ví dụ cũ còn nguyên văn.
 *  · Gói `generic` / `fashion` không lọt chữ hải sản / đơn vị cân.
 *  · Mẫu ngành ⇒ gói: không mẫu ⇒ `food` (không đổi tổ chức nào đang chạy); thời trang ⇒ `fashion`; mẫu khác ⇒ `generic`.
 *  · Tổ chức THẬT mẫu thời trang `sp-packs`: lời nhắc GỬI TỚI AI trong một lượt hội thoại không có «chả cá thu».
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_SALES_CHATBOT_CONFIG, parseSalesChatbotConfig, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, openConversation, setSalesChatProviderForTests, systemPrompt } from "@/lib/sales-chatbot/engine";
import { FASHION_PACK, FOOD_PACK, GENERIC_PACK, SALES_PACKS, salesPackFor } from "@/lib/sales-chatbot/packs";
import { setSettingJson } from "@/lib/settings";

const ORG = "sp-packs";
const SEAFOOD_WORDS = /chả cá|\bkg\b|\d+kg|«1 ký»|«1 cân»|nửa ký|kí»/i;

function testPure() {
  const cfg = parseSalesChatbotConfig(null);
  const now = new Date("2026-10-04T07:00:00Z");
  // Mặc định = gói food (mọi lời gọi cũ không truyền gói giữ nguyên chữ).
  for (const c of [cfg, { ...cfg, wholesalePricing: true }]) {
    assert.equal(systemPrompt(c, "Shop", "", "FANPAGE", "", [], "", "", now), systemPrompt(c, "Shop", "", "FANPAGE", "", [], "", "", now, FOOD_PACK));
  }
  const food = systemPrompt(cfg, "Shop", "", "FANPAGE");
  for (const old of ["(vd 1kg hay 2kg)", "«1kí», «1 ký», «1 cân», «1kg» đều là 1kg", "(vd «chả cá thu»)", "(vd shop hỏi «lấy bao nhiêu kg», khách đáp «lấy lần 20-30 kg»)", "(vd «Dạ mình lấy 1kg ăn thử trước nhé, em lên đơn luôn ạ?»)", "số lượng lớn (từ 10kg):", "«lấy thêm 1kg»"]) {
    assert.ok(food.includes(old), `gói food phải giữ nguyên văn: ${old}`);
  }
  for (const pack of [GENERIC_PACK, FASHION_PACK]) {
    for (const wholesale of [false, true]) {
      const p = systemPrompt({ ...cfg, wholesalePricing: wholesale }, "Shop", "", "FANPAGE", "", [], "", "", now, pack);
      const hit = p.match(SEAFOOD_WORDS);
      assert.equal(hit, null, `gói ${pack.key} lọt chữ ngành thực phẩm: ${hit?.[0]}`);
      // Luật chung vẫn nguyên: giá chỉ từ công cụ, chốt khi khách đồng ý.
      assert.ok(p.includes("GIÁ và TỒN chỉ lấy từ kết quả công cụ") && p.includes("CHỈ gọi confirm_order"));
    }
  }
  assert.ok(systemPrompt(cfg, "Shop", "", "WEB", "", [], "", "", null, GENERIC_PACK).includes("số lượng lớn: ERP chỉ có giá LẺ"), "không ngưỡng sỉ ⇒ không chữ thừa / dấu cách thừa");
  // Mọi gói đủ trường; dòng mô tả là một gạch đầu dòng của khối HIỂU KHÁCH.
  for (const p of Object.values(SALES_PACKS)) {
    for (const k of ["specExample", "describeLine", "answeredExample", "nudgeExample"] as const) assert.ok(p[k].trim().length > 5, `${p.key}.${k}`);
    assert.ok(p.describeLine.startsWith("  · "), p.key);
  }
  // Mẫu ngành ⇒ gói.
  assert.equal(salesPackFor(null).key, "food", "không mẫu ⇒ giữ lời nhắc cũ");
  assert.equal(salesPackFor("food-commerce").key, "food");
  assert.equal(salesPackFor("seafood-commerce").key, "food");
  assert.equal(salesPackFor("fashion-commerce").key, "fashion");
  assert.equal(salesPackFor("spa-beauty").key, "generic");
  assert.equal(salesPackFor("mau-la").key, "generic");
  for (const spec of Object.values(BUSINESS_TYPE_SPEC)) assert.ok(SALES_PACKS[salesPackFor(spec.templateKey).key], `mẫu ${spec.templateKey} không có gói`);
  console.log("✓ Gói ngành chatbot · thuần: mặc định = gói food (chữ cũ nguyên văn) · generic / fashion không lọt chữ hải sản, luật chung nguyên · không mẫu ⇒ food, thời trang ⇒ fashion, mẫu khác ⇒ generic");
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testRealOrg() {
  const seen: string[] = [];
  const provider: AiProvider = {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      seen.push(req.system);
      return { content: [{ type: "text", text: "Dạ shop chào bạn ạ." }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
  await withOrganization(ORG, async () => {
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true });
    setSalesChatProviderForTests(() => provider);
    try {
      const t = await openConversation("TEST", { createdBy: "chu@sp-packs.local" });
      assert.ok((await chatTurn(t.id, "áo này còn size M không", { channel: "TEST" })).ok);
    } finally {
      setSalesChatProviderForTests(null);
    }
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].match(SEAFOOD_WORDS), null, "tổ chức mẫu thời trang: lời nhắc gửi AI không có chữ hải sản");
  assert.ok(seen[0].includes(FASHION_PACK.specExample), "lời nhắc gửi AI dùng gói thời trang");
  console.log("✓ Gói ngành chatbot · tổ chức thật mẫu thời trang: lời nhắc GỬI TỚI AI dùng gói fashion, không có chữ hải sản");
}

export async function testSalesPacks() {
  testPure();
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: "Shop thời trang thử", plan: "trial", templateKey: "fashion-commerce", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: "chu@sp-packs.local", name: "Chủ shop", password: "GoiNganh@2026!" }, source: "TEST", actor: null });
  try {
    await testRealOrg();
  } finally {
    await cleanupOrg(ORG);
  }
}
