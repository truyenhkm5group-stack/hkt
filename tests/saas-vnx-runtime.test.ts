/**
 * ═══════════ PHASE 8b — WORKSPACE NHÀ CÓ THỂ CHẠY RUNTIME CHỐT ĐƠN, NHƯNG CHỈ KHI CHỦ SHOP BẬT ═══════════
 *
 * docs/saas/OWNERSHIP.md §4 liệt kê bốn chặn kỹ thuật giữ runtime bán hàng của VNX ở container `chatbot/`. PR này gỡ ba
 * (webhook · lịch job · nguồn trả tiền AI); chặn 1 (ghi đơn vào Pancake POS — `PancakePosSink`) là PR riêng. Mỗi chặn ba
 * ca, cùng một công tắc là module `ai_sales` của NHÀ:
 *
 *   · nhà TẮT `ai_sales` (trạng thái production hôm nay, 0180) ⇒ hành vi y như trước;
 *   · nhà BẬT ⇒ hành vi mới;
 *   · tổ chức KHÁCH ⇒ không đổi ở cả hai trạng thái của nhà.
 *
 * Không đặt / đọc biến môi trường của máy chạy (luật 65): khoá bí mật webhook dựng bằng `secretsKeyState(readEnv giả)`,
 * provider AI là provider giả. Dòng module của nhà được chụp trước và trả lại NGUYÊN TRẠNG trong `finally` — mọi bài phía
 * sau giả định nhà tắt `ai_sales`.
 *
 * Chạy riêng: xem tests/sync-fixtures.test.ts (cần CSDL PGlite đã migrate).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { setAiProviderForTests, type AiProvider } from "@/lib/ai/provider";
import { secretsKeyState } from "@/lib/connectors/secrets";
import { canUseModule, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { homeSalesRuntimeDeclared, homeSalesRuntimeEnabled } from "@/lib/platform/home-sales-runtime";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { HOME_SALES_URL_SECRET_PROVIDERS, resolveUrlSecretOrganization, WEBHOOK_BINDINGS, webhookUrlToken, type WebhookProvider } from "@/lib/platform/webhooks";
import { salesBotBillingSource } from "@/lib/sales-chatbot/config";
import { salesChatProvider, setSalesChatProviderForTests } from "@/lib/sales-chatbot/engine";
import { JOB_DEFINITIONS, runJob } from "@/lib/sync/jobs";

const goc = path.resolve(__dirname, "..");
const KHACH = "vr-khach";
const KEY = secretsKeyState((n) => (n === "PLATFORM_SECRETS_KEY" ? "khoa-kiem-thu-phase-8b-0123456789abcdefghijklmnopqrstuvwxyz" : undefined));

type FanOut = { callsHome: (job: string) => boolean; fanOutPlan: (i: { job: string; all: boolean; automation: boolean }) => string };

function gia(name: string): AiProvider {
  return {
    name,
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete() {
      throw new Error("provider giả không được gọi trong bài này");
    },
  };
}

/* ═════════════ HÀM THUẦN ═════════════ */
function kiemHamThuan() {
  const row = (enabled: boolean) => ({ moduleKey: "ai_sales", enabled, features: {} });
  assert.equal(homeSalesRuntimeDeclared([]), false, "không dòng nào ⇒ KHÔNG coi là bật (module_default ENABLED của nhà không đủ)");
  assert.equal(homeSalesRuntimeDeclared([row(false)]), false);
  assert.equal(homeSalesRuntimeDeclared([row(true)]), true);
  assert.equal(homeSalesRuntimeDeclared([row(true), row(false)]), false, "hai dòng mâu thuẫn ⇒ một dòng tắt là đủ để tắt");
  assert.equal(homeSalesRuntimeDeclared([{ moduleKey: "orders", enabled: true, features: {} }]), false);

  // Chặn 4 — nguồn trả tiền: `platform` ở nhà = HOME, ở khách = PLATFORM; khoá riêng luôn BYOK; thiếu cờ ⇒ PLATFORM (phía khách).
  assert.equal(salesBotBillingSource("platform"), "PLATFORM", "gọi kiểu cũ không đổi nghĩa");
  assert.equal(salesBotBillingSource("platform", { home: false }), "PLATFORM");
  assert.equal(salesBotBillingSource("platform", { home: true }), "HOME");
  for (const k of ["anthropic-byok", "openai-byok", "gemini-byok"] as const) {
    assert.equal(salesBotBillingSource(k, { home: true }), "BYOK", `${k} ở nhà vẫn là khoá riêng`);
    assert.equal(salesBotBillingSource(k), "BYOK");
  }

  // Danh sách kênh nhà được nhận theo token: chỉ hai kênh tin nhắn của bot, và đều là URL_SECRET.
  assert.deepEqual([...HOME_SALES_URL_SECRET_PROVIDERS].sort(), ["PANCAKE_FANPAGE", "ZALO_OA"]);
  for (const p of HOME_SALES_URL_SECRET_PROVIDERS) assert.equal(WEBHOOK_BINDINGS[p].mode, "URL_SECRET");
}

/* ═════════════ DỌN ═════════════ */
async function donDep() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, KHACH) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [KHACH]));
  invalidateOrganizations();
  invalidateCapabilities();
}

/** Ghi thẳng dòng `ai_sales` của nhà (không qua action: không cần nhật ký cho một lượt thử, và trả lại được nguyên trạng). */
async function datAiSalesNha(homeId: string, enabled: boolean | null) {
  const pdb = await getPlatformDb();
  const where = and(eq(schema.platformOrganizationModules.organizationId, homeId), eq(schema.platformOrganizationModules.moduleKey, "ai_sales"));
  if (enabled === null) await pdb.delete(schema.platformOrganizationModules).where(where);
  else {
    await pdb
      .insert(schema.platformOrganizationModules)
      .values({ organizationId: homeId, moduleKey: "ai_sales", enabled, updatedBy: "system:test" })
      .onConflictDoUpdate({ target: [schema.platformOrganizationModules.organizationId, schema.platformOrganizationModules.moduleKey], set: { enabled, updatedBy: "system:test" } });
  }
  invalidateCapabilities();
}

/* ═════════════ BA CHẶN, BA CA ═════════════ */
async function kiemBaChan(fan: FanOut) {
  const home = await getHomeOrganization();
  rmSync(organizationDatabaseUrl({ code: KHACH, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await provisionOrganization({ code: KHACH, name: "Phase 8b — khách", modules: ["customers", "products", "orders", "inventory", "ai_sales"], source: "TEST", actor: null });
  invalidateOrganizations();

  const pdb = await getPlatformDb();
  const [goc0] = await pdb
    .select({ enabled: schema.platformOrganizationModules.enabled })
    .from(schema.platformOrganizationModules)
    .where(and(eq(schema.platformOrganizationModules.organizationId, home.id), eq(schema.platformOrganizationModules.moduleKey, "ai_sales")));
  const nguyenTrang = goc0 ? goc0.enabled : null;

  const tokenNha = (p: WebhookProvider) => webhookUrlToken(p, home.code, KEY)!;
  const tokenKhach = (p: WebhookProvider) => webhookUrlToken(p, KHACH, KEY)!;
  const URL_SECRET = (Object.keys(WEBHOOK_BINDINGS) as WebhookProvider[]).filter((p) => WEBHOOK_BINDINGS[p].mode === "URL_SECRET");
  const fakeHome = gia("nha-env");

  const kiemKhachKhongDoi = async (nhan: string) => {
    for (const p of URL_SECRET) assert.equal(await resolveUrlSecretOrganization(p, tokenKhach(p), KEY), KHACH, `${nhan}: token ${p} của khách vẫn ra khách`);
    // Chặn 4 ở khách: khoá `.env` của nhà KHÔNG BAO GIỜ là lựa chọn — kể cả khi bộ chọn của nhà đang trả một provider.
    setSalesChatProviderForTests(null);
    setAiProviderForTests(fakeHome);
    try {
      const r = await withOrganization(KHACH, () => salesChatProvider());
      assert.ok(!(r.ok && r.provider === fakeHome), `${nhan}: chatbot của khách không được dùng khoá .env của nhà`);
      assert.ok(!r.ok || r.source === "PLATFORM", `${nhan}: «AI dùng chung» của khách ghi PLATFORM`);
    } finally {
      setAiProviderForTests(undefined);
    }
    setSalesChatProviderForTests(() => gia("thu"));
    try {
      const r = await withOrganization(KHACH, () => salesChatProvider());
      assert.ok(r.ok && r.source === "PLATFORM", `${nhan}: nguồn trả tiền của khách vẫn PLATFORM — ${JSON.stringify(r.ok ? r.source : r)}`);
    } finally {
      setSalesChatProviderForTests(null);
    }
  };

  try {
    /* ── Ca 1 · nhà TẮT ai_sales (production hôm nay) ⇒ như cũ ── */
    await datAiSalesNha(home.id, false);
    assert.equal(await canUseModule("ai_sales", home.code), false);
    assert.equal(await homeSalesRuntimeEnabled(home), false);
    for (const p of URL_SECRET) assert.equal(await resolveUrlSecretOrganization(p, tokenNha(p), KEY), null, `nhà tắt: token ${p} của nhà ⇒ 401 như trước`);
    for (const job of ["sales-followup", "sales-health"]) {
      assert.equal(JOB_DEFINITIONS[job].module, "ai_sales", `${job} gác bằng module ai_sales — công tắc của lượt nhà`);
      assert.equal(fan.callsHome(job), true, `${job}: bộ lập lịch gõ lượt nhà; runJob bỏ qua MODULE_DISABLED (g-sched kiểm phần không ghi sổ)`);
      assert.equal(fan.fanOutPlan({ job, all: false, automation: true }), "AUTOMATION", `${job}: khách vẫn qua tầng tự động hoá`);
    }
    // Không dòng cấu hình nào (bảng thiếu dòng ⇒ module_default ENABLED của nhà) ⇒ cửa webhook VẪN đóng.
    await datAiSalesNha(home.id, null);
    assert.equal(await homeSalesRuntimeEnabled(home), false, "nhà không có dòng ai_sales tường minh ⇒ không mở webhook");
    for (const p of HOME_SALES_URL_SECRET_PROVIDERS) assert.equal(await resolveUrlSecretOrganization(p, tokenNha(p), KEY), null, `không dòng tường minh: ${p} của nhà vẫn 401`);
    // Job runtime ở nhà đi CÙNG cổng với webhook: canUseModule nói "bật" (module_default ENABLED) nhưng chưa có dòng tường minh
    // ⇒ runJob vẫn bỏ qua MODULE_DISABLED, trước khi chạm bất kỳ thứ gì.
    assert.equal(await canUseModule("ai_sales", home.code), true, "đối chứng: thiếu dòng thì canUseModule của nhà nói bật");
    for (const job of ["sales-followup", "sales-health"]) {
      const r = (await runJob(job, { trigger: "CRON", actor: "vr-test", org: home.code })) as { skipped?: string; detail?: string };
      assert.equal(r.skipped, "MODULE_DISABLED", `${job}: nhà chưa bật tường minh ⇒ bỏ qua`);
      assert.match(r.detail ?? "", /chưa bật tường minh/);
    }
    await datAiSalesNha(home.id, false);
    await kiemKhachKhongDoi("nhà tắt");

    /* ── Ca 2 · nhà BẬT ai_sales ⇒ hành vi mới ── */
    await datAiSalesNha(home.id, true);
    assert.equal(await canUseModule("ai_sales", home.code), true, "bật ⇒ runJob của sales-followup / sales-health cho nhà không còn MODULE_DISABLED");
    assert.equal(await homeSalesRuntimeEnabled(home), true);
    // Chặn 2: đúng hai kênh tin nhắn phân giải về nhà; mọi URL_SECRET khác vẫn 401 cho nhà.
    for (const p of URL_SECRET) {
      const want = HOME_SALES_URL_SECRET_PROVIDERS.includes(p) ? home.code : null;
      assert.equal(await resolveUrlSecretOrganization(p, tokenNha(p), KEY), want, `nhà bật: token ${p} của nhà ⇒ ${want ?? "401"}`);
    }
    const sai = tokenNha("PANCAKE_FANPAGE");
    assert.equal(await resolveUrlSecretOrganization("PANCAKE_FANPAGE", `${sai.slice(0, -1)}${sai.endsWith("A") ? "B" : "A"}`, KEY), null, "nhà bật vẫn phải đúng chữ ký");
    assert.equal(await resolveUrlSecretOrganization("PANCAKE_FANPAGE", `${home.code}.${tokenNha("ZALO_OA").split(".")[1]}`, KEY), null, "chữ ký của kênh Zalo không mở kênh fanpage");
    // Chặn 4: «AI không phải khoá riêng» ở nhà = ĐÚNG bộ chọn `.env` của nhà, sổ AI ghi HOME.
    setSalesChatProviderForTests(null);
    setAiProviderForTests(fakeHome);
    try {
      const r = await withOrganization(home.code, () => salesChatProvider());
      assert.ok(r.ok && r.provider === fakeHome && r.source === "HOME", `nhà: provider .env của nhà, nguồn HOME — ${JSON.stringify(r.ok ? { p: r.provider.name, s: r.source } : r)}`);
      setAiProviderForTests(null);
      const khong = await withOrganization(home.code, () => salesChatProvider());
      assert.ok(!khong.ok && /Tổ chức nhà chưa cấu hình AI/.test(khong.error), "nhà chưa có khoá .env ⇒ câu lỗi rõ, không rơi sang AI nền tảng");
    } finally {
      setAiProviderForTests(undefined);
    }
    await kiemKhachKhongDoi("nhà bật");
  } finally {
    await datAiSalesNha(home.id, nguyenTrang);
  }
  assert.equal(await canUseModule("ai_sales", home.code), nguyenTrang === true, "dòng ai_sales của nhà đã trả lại nguyên trạng");

  // Không mã nào ngoài phạm vi này được hỏi «nhà có chạy runtime Chốt Đơn không» theo lối riêng.
  const wh = readFileSync(path.join(goc, "lib/platform/webhooks.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(wh, /if \(org\.isHome\) return HOME_SALES_URL_SECRET_PROVIDERS\.includes\(provider\) && \(await homeSalesRuntimeEnabled\(org\)\) \? org\.code : null;/, "webhook hỏi đúng một hàm cho nhà");
}

export async function testSaasVnxRuntime() {
  kiemHamThuan();
  const fan = (await import(pathToFileURL(path.join(goc, "scripts/scheduler-fanout.mjs")).href)) as FanOut;
  await donDep();
  try {
    await kiemBaChan(fan);
  } finally {
    setSalesChatProviderForTests(null);
    setAiProviderForTests(undefined);
    await donDep();
    try {
      rmSync(organizationDatabaseUrl({ code: KHACH, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    } catch {
      // Windows giữ tệp của PGlite đang mở — lượt chạy sau xoá thư mục ở đầu bài.
    }
  }
  console.log("✓ Phase 8b: nhà TẮT ai_sales ⇒ webhook / lịch / nguồn AI như cũ; nhà BẬT ⇒ fanpage + Zalo theo token về nhà, job runtime chạy cho nhà, «AI dùng chung» = khoá .env của nhà (HOME); tổ chức khách không đổi ở cả hai trạng thái");
}

if (/saas-vnx-runtime\.test\.ts$/.test(process.argv[1] ?? "")) testSaasVnxRuntime().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
