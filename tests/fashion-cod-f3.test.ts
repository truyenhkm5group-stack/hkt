/**
 * ═══════════ FASHION COD · F3 — BỎ DẤU VẾT CỦA VNX Ở TỔ CHỨC KHÁCH (docs/verticals/fashion-cod.md) ═══════════
 *
 *  1. Trợ lý AI: tổ chức nhà giữ NGUYÊN lời nhắc (đệm không rỗng); tổ chức khách tự giới thiệu bằng tên CỦA HỌ, không còn
 *     «VNXcommerce», phần luật phía sau giữ nguyên.
 *  2. Gợi ý kết nối của mẫu: nhận module connector của nhà HOẶC kết nối theo tổ chức; khoá lạ / connector HOME_ONLY trong sổ ⇒
 *     không phải gợi ý hợp lệ. Mẫu «Thời trang» chỉ gợi ý kết nối shop khách TỰ KHAI được.
 *  3. Giả định lợi nhuận: tổ chức khách chưa khai ⇒ `settingDeclared` = false và tab Lợi nhuận danh nghĩa in cảnh báo «số
 *     mẫu»; khai rồi ⇒ true. Không đổi con số mặc định nào.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { COPILOT_SYSTEM_PROMPT, copilotSystemPrompt } from "@/lib/ai/prompt";
import { integrationApplies, integrationTarget } from "@/lib/blueprints/integrations";
import { FASHION_COMMERCE_BLUEPRINT } from "@/lib/blueprints/templates/fashion-commerce";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { PROFIT_ASSUMPTIONS_KEY } from "@/lib/constants/profit";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { setSettingJson, settingDeclared } from "@/lib/settings";

const ORG = "f3-shop";

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
  // 1. Lời nhắc trợ lý.
  assert.equal(copilotSystemPrompt({ name: "VNX", isHome: true }), COPILOT_SYSTEM_PROMPT, "nhà giữ nguyên văn bản (đệm prompt)");
  assert.equal(copilotSystemPrompt(null), COPILOT_SYSTEM_PROMPT);
  const khach = copilotSystemPrompt({ name: "Shop Mây «xinh»\nđẹp", isHome: false });
  assert.ok(khach.startsWith("Bạn là trợ lý vận hành ERP của «Shop Mây  xinh  đẹp»."), khach.slice(0, 80));
  assert.ok(!khach.includes("VNXcommerce") && !khach.includes("shop bán quần áo, giao qua Viettel Post"), "tổ chức khách không mang danh tính VNX");
  assert.ok(khach.endsWith(COPILOT_SYSTEM_PROMPT.slice(COPILOT_SYSTEM_PROMPT.indexOf("Bạn trả lời bằng tiếng Việt"))), "phần luật giữ nguyên");

  // 2. Gợi ý kết nối.
  assert.deepEqual(integrationTarget("connector_meta")?.kind, "HOME_MODULE");
  const pos = integrationTarget("pancake-pos-org");
  assert.ok(pos && pos.kind === "ORG_CONNECTION" && pos.dependsOn.includes("orders"));
  assert.equal(integrationTarget("pancake-pos"), null, "connector HOME_ONLY trong sổ không phải gợi ý cho mẫu");
  assert.equal(integrationTarget("khong-co"), null);
  assert.equal(integrationApplies("viettelpost-org", new Set(["orders"])), false, "chưa bật Giao vận ⇒ gợi ý Viettel Post bị bỏ");
  assert.equal(integrationApplies("viettelpost-org", new Set(["orders", "logistics"])), true);
  const v = validateBlueprint(FASHION_COMMERCE_BLUEPRINT);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const goiY = FASHION_COMMERCE_BLUEPRINT.integrations ?? [];
  assert.ok(goiY.length >= 2 && goiY.every((i) => integrationTarget(i.connectorKey)?.kind === "ORG_CONNECTION"), "mẫu Thời trang chỉ gợi ý kết nối shop khách tự khai được");
  assert.ok(goiY.every((i) => integrationApplies(i.connectorKey, new Set(FASHION_COMMERCE_BLUEPRINT.modules))), "mọi gợi ý dùng được với chính bộ module của mẫu");

  // 3. Cảnh báo số mẫu nằm ở đầu tab, chỉ cho tổ chức khách chưa khai.
  const tab = readFileSync("app/(dashboard)/reports/nominal-tab.tsx", "utf8");
  assert.ok(tab.includes("const sampleAssumptions = !org.isHome && assumptionsDeclared === false;") && tab.includes("data-sample-assumptions"));
}

export async function testFashionCodF3() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Shop F3", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "ThoiTrang@123" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      assert.equal(await settingDeclared(PROFIT_ASSUMPTIONS_KEY), false, "tổ chức mới ⇒ chưa khai giả định");
      await setSettingJson(PROFIT_ASSUMPTIONS_KEY, { defaultReturnRate: 30 });
      assert.equal(await settingDeclared(PROFIT_ASSUMPTIONS_KEY), true);
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ Fashion COD F3: trợ lý AI của shop khách mang tên shop (nhà giữ nguyên lời nhắc); mẫu Thời trang gợi ý kết nối theo tổ chức; giả định lợi nhuận chưa khai ⇒ cảnh báo số mẫu, không đổi con số");
}
