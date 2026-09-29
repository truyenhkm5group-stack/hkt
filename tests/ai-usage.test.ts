/**
 * SỔ DÙNG AI + HẠN MỨC AI + CÔNG TẮC AI — `lib/ai-usage/*`, docs/platform/ai-usage.md.
 *
 * Provider GIẢ (không mạng thật, luật 65 — môi trường của nhánh nền tảng đưa vào qua `env` giả, không đọc / đặt
 * `process.env`). Hai tổ chức THẬT `au-a` / `au-b` (+ tổ chức nhà), tự cấp và tự dọn:
 *  · mỗi lượt AI Builder ghi ĐÚNG một dòng `platform_ai_usage` với nguồn đúng (BYOK · PLATFORM · HOME), khoá người bấm;
 *  · A vượt trần cứng ⇒ dòng `BLOCKED_QUOTA`, model KHÔNG được gọi, không nháp; vượt ngưỡng cảnh báo ⇒ cho qua + MỘT
 *    thông báo / ngày; ghi đè theo tổ chức thắng gói;
 *  · hạn mức của A không trừ vào B; BYOK của A không bao giờ tính vào PLATFORM;
 *  · không cấu hình nền tảng ⇒ nhánh PLATFORM không bao giờ chạy và KHÔNG rơi về khoá nhà; khoá nền tảng trùng khoá nhà
 *    ⇒ từ chối; khoá nền tảng đi đúng tới api.anthropic.com, không bao giờ mang khoá nhà;
 *  · công tắc toàn nền tảng + theo tổ chức chặn TRƯỚC khi gọi model; người không vận hành không đổi được; đệm ≤ 30 s;
 *  · chi phí chưa biết giữ NULL (không phải 0).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { FakeProvider, setAiProviderForTests, type AiProvider, type AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { getBuilderAi, setBuilderAiForTests } from "@/lib/ai-builder/provider";
import { ANTHROPIC_BASE_URL } from "@/lib/ai-builder/providers";
import { createDraft } from "@/lib/ai-builder/service";
import { AI_CONTROL_CACHE_MS, invalidateAiControl, PLATFORM_AI_SWITCH_KEY, readPlatformAiSwitch, setOrgAiControl, setPlatformAiEnabled } from "@/lib/ai-usage/control";
import { recordAiUsage, sourceUsage } from "@/lib/ai-usage/ledger";
import { platformAiConfig } from "@/lib/ai-usage/platform-ai";
import { checkAiQuota, softWarningKey } from "@/lib/ai-usage/quota";
import { AI_DISABLED_BY_OPERATOR, evaluateAiQuota, parseAiLimits, type AiLimits } from "@/lib/ai-usage/types";
import { loadOperatorOrgAi, loadOrgAiUsage, loadPlatformAiSummary } from "@/lib/ai-usage/view";

const A = "au-a";
const B = "au-b";
const PLAN_A = "au-tight";
const PLAN_B = "au-credit";
const HOME_KEY = "sk-ant-api03-khoa-BIA-cua-nha-khong-duoc-dung-0042";
const PLAT_KEY = "sk-ant-api03-khoa-BIA-cua-nen-tang-0099";
const PROMPT = "Công ty bán buôn cần CRM, đơn hàng và kho — BI-MAT-PROMPT-7731.";

/** Provider giả có GIÁ: model `claude-opus-5`, 100k vào + 20k ra = đúng 1,00 USD mỗi lời gọi. */
class PricedFake implements AiProvider {
  readonly name = "fake-priced";
  readonly model = "claude-opus-5";
  readonly schemaDialect = "anthropic" as const;
  calls = 0;
  async complete(): Promise<AiResponse> {
    this.calls += 1;
    return { content: [{ type: "text", text: "(giả) không nộp gói" }], stopReason: "end_turn", usage: { inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.model, latencyMs: 0 };
  }
}

class ThrowingFake implements AiProvider {
  readonly name = "fake-throw";
  readonly model = "claude-opus-5";
  readonly schemaDialect = "anthropic" as const;
  async complete(): Promise<AiResponse> {
    throw new Error("503 quá tải (giả)");
  }
}

const envOf =
  (vars: Record<string, string>) =>
  (name: string): string | undefined =>
    vars[name];

// ═══════════ 1 · THUẦN ═══════════

function testPure() {
  const lim = (over: Partial<AiLimits> = {}): AiLimits => ({ requestsPerDay: 5, requestsPerMonth: 50, costUsdPerMonth: { soft: 1, hard: 3 }, platformCreditUsdPerMonth: 0, ...over });
  const u = (costUsdMonth: number, requestsToday = 0, requestsMonth = requestsToday) => ({ requestsToday, requestsMonth, costUsdMonth, unknownCostMonth: 0 });
  assert.ok(evaluateAiQuota("BYOK", lim(), u(0)).ok);
  const soft = evaluateAiQuota("BYOK", lim(), u(1));
  assert.ok(soft.ok && soft.softExceeded && soft.warning, "tới ngưỡng cảnh báo ⇒ cho qua + cảnh báo");
  const hard = evaluateAiQuota("BYOK", lim(), u(3));
  assert.ok(!hard.ok && hard.reason === "COST_HARD", "tới trần cứng ⇒ chặn");
  const day = evaluateAiQuota("BYOK", lim(), u(0, 5));
  assert.ok(!day.ok && day.reason === "REQUESTS_DAY", "hết lượt ngày ⇒ chặn");
  const month = evaluateAiQuota("BYOK", lim(), u(0, 0, 50));
  assert.ok(!month.ok && month.reason === "REQUESTS_MONTH", "hết lượt tháng ⇒ chặn");
  const noCredit = evaluateAiQuota("PLATFORM", lim(), u(0));
  assert.ok(!noCredit.ok && noCredit.reason === "NO_PLATFORM_CREDIT", "PLATFORM không có credit ⇒ không bao giờ chạy");
  const credit = lim({ costUsdPerMonth: { soft: null, hard: null }, platformCreditUsdPerMonth: 2 });
  assert.ok(evaluateAiQuota("PLATFORM", credit, u(1.99)).ok);
  const used = evaluateAiQuota("PLATFORM", credit, u(2));
  assert.ok(!used.ok && used.reason === "PLATFORM_CREDIT_USED", "hết credit ⇒ chặn");
  const unlimited = lim({ requestsPerDay: null, requestsPerMonth: null, costUsdPerMonth: { soft: null, hard: null } });
  assert.ok(evaluateAiQuota("BYOK", unlimited, u(1e6, 1e6, 1e6)).ok, "null = không giới hạn");

  const undeclared = parseAiLimits({ users: 3 });
  assert.ok(undeclared.undeclared && undeclared.limits.platformCreditUsdPerMonth === 0, "gói chưa khai ai ⇒ không credit nền tảng");
  assert.equal(parseAiLimits({ ai: { platformCreditUsdPerMonth: null } }).limits.platformCreditUsdPerMonth, 0, "credit null ⇒ 0 (hẹp), không phải không giới hạn");
  assert.equal(parseAiLimits({ ai: { platformCreditUsdPerMonth: "9" } }).limits.platformCreditUsdPerMonth, 0, "credit sai kiểu ⇒ 0");

  // Cấu hình nền tảng: thiếu cờ / thiếu khoá / trùng khoá nhà / model không giá ⇒ KHÔNG sẵn sàng.
  assert.ok(!platformAiConfig(envOf({})).ready, "không cấu hình ⇒ tắt");
  assert.ok(!platformAiConfig(envOf({ PLATFORM_AI_API_KEY: PLAT_KEY })).ready, "có khoá mà không bật ⇒ tắt");
  assert.ok(!platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1" })).ready, "bật mà thiếu khoá ⇒ tắt");
  assert.ok(!platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: HOME_KEY, ANTHROPIC_API_KEY: HOME_KEY })).ready, "khoá nền tảng TRÙNG khoá nhà ⇒ từ chối");
  assert.ok(!platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: PLAT_KEY, PLATFORM_AI_MODEL: "model-chua-co-gia" })).ready, "model không có giá ⇒ không trừ được credit ⇒ tắt");
  const ok = platformAiConfig(envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: PLAT_KEY, ANTHROPIC_API_KEY: HOME_KEY }));
  assert.ok(ok.ready && ok.apiKey === PLAT_KEY, "đủ điều kiện ⇒ dùng ĐÚNG khoá nền tảng");
  assert.ok(AI_CONTROL_CACHE_MS <= 30_000, "công tắc / ghi đè đọc qua đệm ≤ 30 giây");
}

// ═══════════ 2 · MÃ NGUỒN ═══════════

function src(f: string): string {
  return readFileSync(path.join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function testSourceScan() {
  // MỘT đường ghi: chỉ ledger.ts chèn vào sổ.
  const writers: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /insert\(\s*schema\.platformAiUsage\b/.test(src(p))) writers.push(p);
    }
  };
  walk("lib");
  walk("app");
  assert.deepEqual(writers, ["lib/ai-usage/ledger.ts"], "chỉ recordAiUsage() ghi sổ AI");
  const copilot = src("lib/ai/copilot.ts");
  assert.ok(/recordAiUsage\(\{[\s\S]*?feature: "copilot",[\s\S]*?source: "HOME"/.test(copilot), "Copilot ghi sổ với nguồn HOME");
  const svc = src("lib/ai-builder/service.ts");
  assert.ok(svc.indexOf("checkAiQuota(") > 0 && svc.indexOf("checkAiQuota(") < svc.indexOf("draftBlueprint("), "hạn mức kiểm TRƯỚC khi gọi model");
  const prov = src("lib/ai-builder/provider.ts");
  assert.ok(prov.indexOf("aiKillSwitchDenial(") < prov.indexOf("if (override !== undefined)"), "công tắc chặn TRƯỚC cả provider ép của kiểm thử");
  const plat = src("lib/ai-usage/platform-ai.ts");
  assert.ok(!/readEnv\(\s*["']ANTHROPIC_API_KEY/.test(plat) && !/process\.env\.ANTHROPIC/.test(plat), "nhánh nền tảng không bao giờ ĐỌC khoá của nhà để dùng");
}

// ═══════════ 3 · TỔ CHỨC THẬT ═══════════

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
}

async function provision(code: string, plan: string) {
  await cleanupOrg(code);
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await provisionOrganization({ code, name: `Tổ chức thử sổ AI ${code}`, plan, modules: [], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Au@123456" }, source: "TEST", actor: null });
}

async function adminOf(code: string): Promise<SessionUser> {
  return withOrganization(code, async () => {
    const db = await getDb();
    const row = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${code}.local`) });
    assert.ok(row, `thiếu quản trị của ${code}`);
    return { id: row.id, email: row.email, name: row.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: code, isHome: false }, modules: [...(await getEnabledModules(code))] };
  });
}

async function rows(code: string) {
  const pdb = await getPlatformDb();
  return pdb.select().from(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code)).orderBy(schema.platformAiUsage.at);
}

async function draftCount(code: string): Promise<number> {
  return withOrganization(code, async () => (await (await getDb()).select().from(schema.aiBlueprintDrafts)).length);
}

async function softNotices(code: string): Promise<number> {
  return withOrganization(code, async () => (await (await getDb()).select().from(schema.notifications).where(like(schema.notifications.dedupeKey, "ai-quota-soft:%"))).length);
}

async function testQuotaAndLedger(adminA: SessionUser, adminB: SessionUser) {
  const priced = new PricedFake();
  setBuilderAiForTests({ provider: priced, source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
  const create = (u: SessionUser, code: string) => withOrganization(code, () => createDraft(u, { mode: "new", prompt: PROMPT }));

  // #1 — dưới ngưỡng: một dòng BYOK, đúng người, đúng tiền.
  const r1 = await create(adminA, A);
  assert.ok(r1.ok && !r1.value.quotaWarning, JSON.stringify(r1));
  let ra = await rows(A);
  assert.equal(ra.length, 1, "một lượt AI Builder = ĐÚNG một dòng sổ");
  assert.deepEqual([ra[0].feature, ra[0].billingSource, ra[0].status, ra[0].requests, ra[0].actorId, ra[0].ref], ["ai_builder", "BYOK", "OK", 1, adminA.id, r1.ok ? r1.value.id : ""]);
  assert.equal(ra[0].costUsd, 1, "100k vào + 20k ra trên claude-opus-5 = 1,00 USD");
  assert.ok(!JSON.stringify(ra).includes("BI-MAT-PROMPT"), "sổ không mang prompt");

  // #2, #3 — đã tới ngưỡng cảnh báo (1 USD): cho qua, cảnh báo, và chỉ MỘT thông báo trong ngày.
  const r2 = await create(adminA, A);
  assert.ok(r2.ok && r2.value.quotaWarning && /ngưỡng cảnh báo/.test(r2.value.quotaWarning), "vượt soft ⇒ cho qua + câu cảnh báo");
  const r3 = await create(adminA, A);
  assert.ok(r3.ok && r3.value.quotaWarning);
  assert.equal(await softNotices(A), 1, "cảnh báo ngưỡng báo quản trị MỘT lần / ngày");
  assert.equal(priced.calls, 3);

  // #4 — tiền tháng 3 USD = trần cứng: CHẶN, model không được gọi, không nháp, một dòng BLOCKED_QUOTA.
  const drafts = await draftCount(A);
  const r4 = await create(adminA, A);
  assert.ok(!r4.ok && /trần/.test(r4.error), JSON.stringify(r4));
  assert.equal(priced.calls, 3, "vượt hard ⇒ model KHÔNG được gọi");
  assert.equal(await draftCount(A), drafts, "vượt hard ⇒ không tạo nháp");
  ra = await rows(A);
  assert.equal(ra.length, 4);
  assert.deepEqual([ra[3].status, ra[3].requests, ra[3].costUsd], ["BLOCKED_QUOTA", 0, 0], "dòng bị chặn: 0 lời gọi, 0 tiền THẬT");
  const usageA = await sourceUsage(A, "BYOK");
  assert.deepEqual([usageA.requestsToday, usageA.costUsdMonth], [3, 3], "lượt bị chặn không tính là lượt dùng");

  // B không bị trừ bởi A: B vẫn chạy, sổ của B chỉ có dòng của B.
  const rb = await create(adminB, B);
  assert.ok(rb.ok && !rb.value.quotaWarning, "hạn mức của A không trừ vào B");
  const usageB = await sourceUsage(B, "BYOK");
  assert.deepEqual([usageB.requestsToday, usageB.costUsdMonth], [1, 1], "B chỉ đếm dòng của B");
  // BYOK của A (và của B) không bao giờ tính vào PLATFORM.
  assert.deepEqual(await sourceUsage(A, "PLATFORM"), { requestsToday: 0, requestsMonth: 0, costUsdMonth: 0, unknownCostMonth: 0 });
  assert.equal((await sourceUsage(B, "PLATFORM")).costUsdMonth, 0, "BYOK của B không trừ credit nền tảng của B");
  const qa = await checkAiQuota(A, "PLATFORM", { notify: false });
  assert.ok(!qa.ok && qa.reason === "NO_PLATFORM_CREDIT", "gói A không có credit ⇒ PLATFORM không bao giờ chạy cho A");

  // Chi phí CHƯA BIẾT giữ NULL: model không có trong bảng giá, và lượt hỏng giữa chừng.
  const fakeB = new FakeProvider([() => ({ content: [{ type: "text", text: "x" }], stopReason: "end_turn" })]);
  setBuilderAiForTests({ provider: fakeB, source: "ORG_CONNECTION", connectorKey: "openai-byok" });
  assert.ok((await create(adminB, B)).ok);
  setBuilderAiForTests({ provider: new ThrowingFake(), source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
  assert.ok((await create(adminB, B)).ok, "lượt hỏng vẫn lưu nháp kèm lỗi");
  const rbRows = await rows(B);
  const unknown = rbRows.find((r) => r.model === "fake-model");
  assert.ok(unknown && unknown.costUsd === null && unknown.inputTokens === 1200 && unknown.status === "OK", "model chưa có giá ⇒ cost NULL, không phải 0");
  const errored = rbRows.find((r) => r.status === "ERROR");
  assert.ok(errored && errored.costUsd === null && errored.inputTokens === null && errored.outputTokens === null, "lượt hỏng ⇒ token / tiền CHƯA BIẾT (NULL)");
  const ub = await sourceUsage(B, "BYOK");
  assert.deepEqual([ub.costUsdMonth, ub.unknownCostMonth], [1, 2], "tổng tiền chỉ cộng lượt đã định giá, lượt chưa định giá đếm riêng");
  const viewB = await loadOrgAiUsage(B);
  const monthB = viewB.month.find((m) => m.source === "BYOK");
  assert.ok(monthB && monthB.costUsd === 1 && monthB.unknownCost === 2 && monthB.turns === 3);
}

async function testOverrideAndSwitches(operator: SessionUser, adminA: SessionUser, adminB: SessionUser) {
  const pdb = await getPlatformDb();
  const priced = new PricedFake();
  setBuilderAiForTests({ provider: priced, source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
  const create = (u: SessionUser, code: string) => withOrganization(code, () => createDraft(u, { mode: "new", prompt: PROMPT }));

  // Ghi đè theo tổ chức (người vận hành): nâng trần tiền của A ⇒ A chạy lại; hạ lượt / ngày ⇒ chặn theo lượt.
  assert.ok("error" in (await setOrgAiControl(adminA, { orgCode: A, limits: { costUsdHard: 100 }, reason: "tự nâng trần cho mình" })), "quản trị tổ chức KHÔNG tự nâng trần được");
  assert.ok("ok" in (await setOrgAiControl(operator, { orgCode: A, limits: { costUsdHard: 100 }, reason: "khách xin nâng trần thử" })));
  const up = await create(adminA, A);
  assert.ok(up.ok, "ghi đè thắng gói");
  assert.ok("ok" in (await setOrgAiControl(operator, { orgCode: A, limits: { costUsdHard: 100, requestsPerDay: 4 }, reason: "giới hạn lượt ngày" })));
  const capped = await create(adminA, A);
  assert.ok(!capped.ok && /lượt AI hôm nay/.test(capped.error), "hết lượt / ngày theo ghi đè ⇒ chặn");
  assert.equal(priced.calls, 1);

  // Công tắc THEO TỔ CHỨC: tắt A ⇒ A bị chặn trước khi gọi model; B không ảnh hưởng.
  assert.ok("ok" in (await setOrgAiControl(operator, { orgCode: A, disabled: true, limits: {}, reason: "tạm dừng AI của A" })));
  const before = (await rows(A)).length;
  const offA = await create(adminA, A);
  assert.ok(!offA.ok && offA.error.startsWith(AI_DISABLED_BY_OPERATOR), JSON.stringify(offA));
  assert.equal(priced.calls, 1, "tắt ⇒ model KHÔNG được gọi");
  assert.equal((await rows(A)).length, before, "tắt ⇒ không có lượt nào để ghi");
  const onB = await create(adminB, B);
  assert.ok(onB.ok, "tắt A không tắt B");
  assert.ok("error" in (await setOrgAiControl(adminA, { orgCode: A, disabled: false, reason: "tự bật lại cho mình" })), "quản trị tổ chức không tự bật lại được");
  const audits = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, A), eq(schema.platformAuditLog.action, "AI_ORG_CONTROL_SET")));
  assert.equal(audits.length, 3, "mỗi lượt đổi của người vận hành một dòng nhật ký nền tảng");
  assert.ok(audits.every((a) => a.actorUserId === operator.id && a.reason), "nhật ký mang người + lý do");
  assert.ok("ok" in (await setOrgAiControl(operator, { orgCode: A, disabled: false, reason: "mở lại AI của A" })));

  // Công tắc TOÀN NỀN TẢNG: chặn mọi tổ chức (kể cả B) trước khi gọi model.
  const saved = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PLATFORM_AI_SWITCH_KEY) });
  try {
    assert.ok("error" in (await setPlatformAiEnabled(adminB, { enabled: false, reason: "quản trị B tắt thử" })), "người không vận hành không đổi được công tắc");
    assert.equal(await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PLATFORM_AI_SWITCH_KEY) }).then((r) => r?.value ?? null), saved?.value ?? null, "lượt bị từ chối không để lại dòng");
    assert.ok("ok" in (await setPlatformAiEnabled(operator, { enabled: false, reason: "chi phí AI tăng bất thường" })));
    const calls = priced.calls;
    const offB = await create(adminB, B);
    assert.ok(!offB.ok && offB.error.startsWith(AI_DISABLED_BY_OPERATOR), "tắt toàn nền tảng ⇒ B bị chặn");
    assert.equal(priced.calls, calls, "tắt toàn nền tảng ⇒ model KHÔNG được gọi");
    const resolved = await withOrganization(B, () => getBuilderAi());
    assert.ok(!resolved.ok && resolved.reason.startsWith(AI_DISABLED_BY_OPERATOR), "màn AI Builder nói đúng câu");
    // Tiến trình KHÁC ghi thẳng vào bảng: qua hạn đệm (≤ 30 s) thì thấy.
    await pdb.update(schema.platformSettings).set({ value: true }).where(eq(schema.platformSettings.key, PLATFORM_AI_SWITCH_KEY));
    assert.equal((await readPlatformAiSwitch()).enabled, false, "trong hạn đệm vẫn là giá trị cũ");
    assert.equal((await readPlatformAiSwitch({ now: Date.now() + AI_CONTROL_CACHE_MS + 1 })).enabled, true, "qua hạn đệm thì thấy lượt ghi của tiến trình khác");
  } finally {
    if (saved) await pdb.update(schema.platformSettings).set({ value: saved.value }).where(eq(schema.platformSettings.key, PLATFORM_AI_SWITCH_KEY));
    else await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, PLATFORM_AI_SWITCH_KEY));
    await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.action, "AI_SWITCH_SET"));
    invalidateAiControl();
  }

  // Màn hình người vận hành: chỉ người vận hành; không lộ prompt / khoá.
  assert.ok(!(await loadOperatorOrgAi(adminA, A)).ok && !(await loadPlatformAiSummary(adminA)).ok, "người không vận hành không đọc được sổ AI của nền tảng");
  const op = await loadOperatorOrgAi(operator, A);
  assert.ok(op.ok && op.value.daily.some((d) => d.blocked > 0), "bảng theo ngày có lượt bị chặn");
  const sum = await loadPlatformAiSummary(operator);
  assert.ok(sum.ok && sum.value.top.some((t) => t.orgCode === A), "trang /platform có top tổ chức theo chi phí");
  for (const s of ["BI-MAT-PROMPT", HOME_KEY, PLAT_KEY]) assert.ok(!JSON.stringify([op, sum]).includes(s), `màn hình lộ «${s.slice(0, 12)}…»`);
}

async function testPlatformBranch(operator: SessionUser, adminB: SessionUser) {
  const homeFake = new FakeProvider([() => ({ content: [{ type: "text", text: "nhà" }], stopReason: "end_turn" })]);
  setAiProviderForTests(homeFake);
  setBuilderAiForTests(undefined);
  const ready = envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: PLAT_KEY, ANTHROPIC_API_KEY: HOME_KEY, ANTHROPIC_AUTH_TOKEN: HOME_KEY });
  try {
    // Không cấu hình nền tảng ⇒ B (có credit, không kết nối) KHÔNG có AI, và không rơi về khoá nhà.
    await withOrganization(B, async () => {
      for (const env of [envOf({}), envOf({ ANTHROPIC_API_KEY: HOME_KEY }), envOf({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: HOME_KEY, ANTHROPIC_API_KEY: HOME_KEY })]) {
        const r = await getBuilderAi({ env });
        assert.ok(!r.ok, "nền tảng chưa cấu hình / khoá trùng nhà ⇒ không có nhánh PLATFORM");
      }
    });
    assert.equal(homeFake.calls.length, 0, "không rơi về AI của nhà");

    // A (gói không credit) với nền tảng SẴN SÀNG ⇒ vẫn không có PLATFORM.
    await withOrganization(A, async () => assert.ok(!(await getBuilderAi({ env: ready })).ok, "gói không credit ⇒ không PLATFORM"));

    // B + nền tảng sẵn sàng ⇒ PLATFORM; khoá đi đúng tới api.anthropic.com, là khoá NỀN TẢNG, không kèm khoá nhà.
    const calls: { url: string; headers: Headers }[] = [];
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, headers: new Headers(init?.headers) });
      const msg = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } };
      return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
    }) as unknown as typeof fetch;
    await withOrganization(B, async () => {
      const r = await getBuilderAi({ env: ready, fetch: fetchFake });
      assert.ok(r.ok && r.ai.source === "PLATFORM" && r.ai.provider.name === "anthropic-platform", JSON.stringify(r.ok ? r.ai.source : r));
      await r.ai.provider.complete({ system: "ping", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [], maxTokens: 16 });
      assert.equal(calls.length, 1);
      const u = new URL(calls[0].url);
      assert.equal(`${u.protocol}//${u.host}`, ANTHROPIC_BASE_URL);
      assert.equal(calls[0].headers.get("x-api-key"), PLAT_KEY, "dùng khoá của NỀN TẢNG");
      assert.ok(![...calls[0].headers.values()].some((v) => v.includes(HOME_KEY)), "không header nào mang khoá của nhà");

      // Lượt AI Builder tính tiền vào PLATFORM ghi đúng nguồn.
      const priced = new PricedFake();
      setBuilderAiForTests({ provider: priced, source: "PLATFORM", connectorKey: null });
      const d = await createDraft(adminB, { mode: "new", prompt: PROMPT });
      assert.ok(d.ok);
      setBuilderAiForTests(undefined);
    });
    const last = (await rows(B)).at(-1);
    assert.ok(last && last.billingSource === "PLATFORM" && last.costUsd === 1, "lượt PLATFORM ghi nguồn PLATFORM");
    assert.equal((await sourceUsage(B, "PLATFORM")).costUsdMonth, 1, "credit nền tảng chỉ trừ lượt PLATFORM");

    // Hết credit (5 USD) ⇒ nhánh PLATFORM đóng, không rơi về đâu cả.
    await recordAiUsage({ orgCode: B, feature: "ai_builder", source: "PLATFORM", provider: "anthropic-platform", model: "claude-opus-5", requests: 1, inputTokens: 1, outputTokens: 1, costUsd: 4, status: "OK", actorId: null });
    await withOrganization(B, async () => {
      const r = await getBuilderAi({ env: ready, fetch: fetchFake });
      assert.ok(!r.ok && /credit/.test(r.reason), "hết credit ⇒ không có AI");
    });
    assert.equal(homeFake.calls.length, 0, "không lần nào gọi AI của nhà cho tổ chức khác");

    // Tổ chức NHÀ với nền tảng sẵn sàng vẫn đi đường nhà — lượt ghi nguồn HOME.
    const home = await getHomeOrganization();
    const r = await getBuilderAi({ env: ready });
    assert.ok(r.ok && r.ai.source === "HOME", "nhà không bao giờ dùng credit nền tảng");
    // Tài khoản THẬT trong CSDL nhà (nhật ký mang khoá tài khoản — luật 34); tự dọn cuối bài.
    const hdb = await getDb();
    const [homeRow] = await hdb.insert(schema.users).values({ email: "au-home@nha.local", name: "QT nhà thử sổ AI", passwordHash: "x", role: "ADMIN" }).onConflictDoNothing().returning();
    const homeUser = homeRow ?? (await hdb.query.users.findFirst({ where: eq(schema.users.email, "au-home@nha.local") }));
    assert.ok(homeUser);
    const homeAdmin: SessionUser = { ...operator, id: homeUser.id, email: homeUser.email };
    setBuilderAiForTests({ provider: new PricedFake(), source: "HOME", connectorKey: null });
    const hd = await createDraft(homeAdmin, { mode: "new", prompt: PROMPT });
    assert.ok(hd.ok, JSON.stringify(hd));
    const pdb = await getPlatformDb();
    const hr = await pdb.select().from(schema.platformAiUsage).where(eq(schema.platformAiUsage.ref, hd.ok ? hd.value.id : ""));
    assert.ok(hr.length === 1 && hr[0].billingSource === "HOME" && hr[0].orgCode === home.code, "lượt của nhà ghi nguồn HOME");
    await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.ref, hr[0].ref ?? ""));
    const db = await getDb();
    await db.delete(schema.aiBlueprintDrafts).where(eq(schema.aiBlueprintDrafts.id, hd.ok ? hd.value.id : ""));
    await db.delete(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "ai_blueprint_draft"), eq(schema.auditLogs.entityId, hd.ok ? hd.value.id : "")));
    await db.delete(schema.users).where(eq(schema.users.id, homeUser.id));
  } finally {
    setBuilderAiForTests(undefined);
    setAiProviderForTests(undefined);
  }
}

export async function testAiUsage() {
  testPure();
  testSourceScan();
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformPlans).where(inArray(schema.platformPlans.key, [PLAN_A, PLAN_B]));
  await pdb.insert(schema.platformPlans).values([
    { key: PLAN_A, name: "Siết AI", limits: { users: null, pages: null, objects: null, records: null, workflows: null, aiDraftsPerDay: null, storageMb: null, ai: { requestsPerDay: 10, requestsPerMonth: 100, costUsdPerMonth: { soft: 1, hard: 3 }, platformCreditUsdPerMonth: 0 } }, position: 97 },
    { key: PLAN_B, name: "Có credit AI", limits: { users: null, pages: null, objects: null, records: null, workflows: null, aiDraftsPerDay: null, storageMb: null, ai: { requestsPerDay: 50, requestsPerMonth: 500, costUsdPerMonth: { soft: null, hard: null }, platformCreditUsdPerMonth: 5 } }, position: 98 },
  ]);
  await provision(A, PLAN_A);
  await provision(B, PLAN_B);
  invalidateAiControl();
  const home = await getHomeOrganization();
  const operator: SessionUser = { id: "au-op", email: "op@nha.local", name: "Vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
  try {
    const adminA = await adminOf(A);
    const adminB = await adminOf(B);
    await testQuotaAndLedger(adminA, adminB);
    await testOverrideAndSwitches(operator, adminA, adminB);
    await testPlatformBranch(operator, adminB);
    // Thông báo ngưỡng mang đúng khoá ngày (giờ VN) — một lần / ngày / nguồn.
    assert.match(softWarningKey("BYOK", new Date("2026-09-29T20:00:00Z")), /^ai-quota-soft:BYOK:2026-09-30$/);
  } finally {
    setBuilderAiForTests(undefined);
    setAiProviderForTests(undefined);
    await cleanupOrg(A);
    await cleanupOrg(B);
    await pdb.delete(schema.platformPlans).where(inArray(schema.platformPlans.key, [PLAN_A, PLAN_B]));
    invalidateAiControl();
  }
  console.log(
    "✓ Sổ dùng AI: mỗi lượt AI Builder một dòng đúng nguồn (BYOK · PLATFORM · HOME), không prompt; vượt hard ⇒ BLOCKED_QUOTA, model không được gọi; soft ⇒ cho qua + một thông báo / ngày; ghi đè theo tổ chức thắng gói; A không trừ vào B; BYOK không trừ credit nền tảng; nền tảng chưa cấu hình / khoá trùng nhà ⇒ không PLATFORM, không rơi về khoá nhà; khoá nền tảng chỉ tới api.anthropic.com; công tắc toàn nền tảng + theo tổ chức chặn trước model, người không vận hành không đổi được, đệm ≤ 30 s; chi phí chưa biết giữ NULL",
  );
}

if (process.argv[1] && /ai-usage\.test\.ts$/.test(process.argv[1])) {
  import("@/db/migrate").then(({ ensureMigrated }) => ensureMigrated()).then(testAiUsage).then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
