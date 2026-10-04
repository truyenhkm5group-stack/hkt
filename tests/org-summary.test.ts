/**
 * ═══════════ ops `org-summary` — tóm tắt MỘT tổ chức khách, CHỈ ĐỌC (scripts/org-summary.ts) ═══════════
 *
 *  · Thuần: `null` ⇒ `—`, 0 thật ⇒ `0`; mục không đọc được in `—` KÈM lý do (luật 42), không bao giờ 0; dòng ≤ 300 ký tự,
 *    cả lượt ≤ 60 dòng (trần của kênh tóm tắt).
 *  · Mã nguồn: không một câu ghi; không đọc cột mang dữ liệu NGƯỜI (tên / SĐT / địa chỉ / ghi chú / nội dung tin); chỉ
 *    import `lib/` đã có; ops-vps khai thao tác (mã hoá, đọc nặng, nhánh case).
 *  · CSDL (PGlite, tổ chức thật `os-sum`): gieo đơn / quảng cáo / kết nối / cấu hình mang chuỗi bí mật ⇒ các dòng có
 *    đúng số đếm, KHÔNG dòng nào lộ chuỗi bí mật, SĐT hay token.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getDbForInspection, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { collectOrgSummary, dem, orgSummaryLines, SUMMARY_MAX_CHARS, SUMMARY_MAX_LINES, type OrgSummary } from "@/scripts/org-summary";

const ORG = "os-sum";
const BI_MAT = "BI-MAT-ORG-SUM";
const SDT = "0987654321";
const TOKEN = "EAAtokenbimat0123456789abcdefghijklmnop";

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

export function testOrgSummaryPure() {
  assert.deepEqual([dem(null), dem(undefined), dem(Number.NaN), dem(0), dem(1234)], ["—", "—", "—", "0", "1.234"]);
  const hong = { ok: false as const, reason: 'relation "ad_spends" does not exist' };
  const s: OrgSummary = { org: { code: "x", name: "X", status: "ACTIVE", isHome: false }, modules: hong, settings: hong, connections: hong, ordersByStage: hong, ordersBySource: hong, outcomes: hong, delivery: hong, ads: hong, syncRuns: hong, costs: hong, expenses: hong, chat: hong };
  const lines = orgSummaryLines(s);
  assert.ok(lines.length <= SUMMARY_MAX_LINES && lines.every((l) => l.length <= SUMMARY_MAX_CHARS));
  assert.ok(lines.slice(1).every((l) => l.includes("— (không đọc được: relation")), "mục hỏng in — KÈM lý do, không in 0");
  const long = orgSummaryLines({ ...s, modules: { ok: true, value: Array.from({ length: 200 }, (_, i) => `module_${i}`) } });
  assert.ok(long.every((l) => l.length <= SUMMARY_MAX_CHARS), "dòng dài bị cắt ở trần");

  const src = readFileSync("scripts/org-summary.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\b(insert|update|delete|truncate|alter|drop|create)\b\s/i.test(code.replace(/default_transaction_read_only|updatedAt|lastUpdateStatusAt/g, "")), "script không có câu ghi nào");
  for (const col of ["bill_full_name", "billFullName", "ship_phone", "shipPhone", "ship_address", "shipAddress", "customer_name", "customerName", "secrets_enc", "secretsEnc", "secret_hints", "secretHints", "last_test_message", "lastTestMessage", ".note", "s.text", "t.text"]) {
    assert.ok(!code.includes(col), `script không đọc cột mang dữ liệu người / bí mật: ${col}`);
  }
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- org-summary\s+#/, "ops-vps khai lựa chọn org-summary");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\borg-summary\b/, "kết quả org-summary MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\borg-summary\b/, "org-summary là thao tác ĐỌC");
  assert.match(ops, /\n\s+org-summary\)\n[\s\S]*?scripts\/org-summary\.ts/, "nhánh case chạy đúng script");
}

export async function testOrgSummaryDb() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Tóm tắt thử", plan: "standard", modules: ["customers", "products", "orders", "inventory", "finance", "marketing"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "TomTat@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      await db.insert(schema.settings).values([
        { key: "ai.salesChatbot", value: JSON.stringify({ enabled: false }) },
        { key: "ai.salesOrderSync", value: JSON.stringify({ enabled: true, enabledAt: "2026-10-03T10:00:00.000Z" }) },
        { key: "orders.manualDeliveryFee", value: "40000" },
      ]);
      await db.insert(schema.orgConnections).values({ orgCode: ORG, connectorKey: "meta-ads-org", status: "ACTIVE", settings: { adAccountIds: "act_111, act_222" }, secretHints: { accessToken: `••••${TOKEN.slice(-4)}` }, lastTestOk: true, lastTestAt: new Date(), lastTestMessage: `Đọc được 2/2 tài khoản ${BI_MAT} ${TOKEN}` });
      const now = new Date();
      await db.insert(schema.orders).values([
        { id: "erp-os-sum-1", stage: "DELIVERED", status: 3, billFullName: `${BI_MAT} khách`, billPhone: SDT, shipPhone: SDT, shipAddress: `${BI_MAT} 12 Hàng Bạc`, note: BI_MAT, source: "Fanpage (nhân viên chốt)", totalPriceAfterDiscount: 280_000, partnerFee: 40_000, insertedAt: now, raw: { origin: "ERP_MANUAL", orderDiscount: 0, createdBy: null } },
        { id: "erp-os-sum-2", stage: "RETURNED", status: 5, billFullName: `${BI_MAT} khách 2`, billPhone: SDT, source: "Chatbot fanpage", totalPriceAfterDiscount: 560_000, insertedAt: now, raw: { origin: "ERP_MANUAL", orderDiscount: 0, createdBy: null } },
      ]);
      await db.insert(schema.orderDeliveryNotes).values({ orderId: "erp-os-sum-1", signedAt: now, receiverName: `${BI_MAT} người nhận` });
      await db.insert(schema.adSpends).values({ platform: "facebook", campaign: `${BI_MAT} chiến dịch`, spend: 150_000, spendDate: now, accountId: "111", externalKey: "fb:111:x" });

      const view = await getDbForInspection({ code: ORG, isHome: false });
      const lines = orgSummaryLines(await collectOrgSummary({ code: ORG, name: "Tóm tắt thử", status: "ACTIVE", isHome: false }, view, now));
      const all = lines.join("\n");
      assert.ok(!all.includes(BI_MAT) && !all.includes(SDT) && !all.includes(TOKEN) && !all.includes(TOKEN.slice(-4)), `không dòng nào lộ chuỗi bí mật / SĐT / token:\n${all}`);
      const line = (p: string) => lines.find((l) => l.startsWith(p)) ?? "";
      assert.match(line("Module cần cho báo cáo"), /finance BẬT · marketing BẬT · returns TẮT/);
      assert.match(line("Cấu hình"), /chatbot TẮT · ghi đơn từ hội thoại BẬT từ 2026-10-03 10:00 · phí giao 40\.000 ₫/);
      assert.match(line("Kết nối"), /meta-ads-org ACTIVE ✓kiểm .* · 2 TKQC/);
      assert.match(line("Đơn 30 ngày theo trạng thái"), /DELIVERED 1 · 280\.000 ₫/);
      assert.match(line("Kết quả đơn 30 ngày"), /DELIVERED 1/);
      assert.match(line("Kết quả đơn 30 ngày"), /RETURNED 1/);
      assert.match(line("Giao hàng"), /phiếu giao còn hiệu lực 1 · có phí giao 1 \(Σ 40\.000 ₫\) · đơn tay giao không thành công 1/);
      assert.match(line("Quảng cáo 30 ngày"), /1 dòng \(1 tự động\) · 1 TKQC · chi 150\.000 ₫/);
      assert.match(line("Đơn 30 ngày theo kênh"), /Fanpage \(nhân viên chốt\) 1/);
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ ops org-summary: chỉ đọc, mục hỏng in — kèm lý do, đúng số đếm của một tổ chức khách, không lộ tên / SĐT / token");
}
