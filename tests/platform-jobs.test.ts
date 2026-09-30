/**
 * ═══════════ NỀN TẢNG 1.x — JOB THEO TỔ CHỨC, CLIENT THEO TỔ CHỨC, LỊCH FAN-OUT ═══════════
 *
 * Hợp đồng: docs/platform/shared-contracts.md mục 8 · target-architecture P12/P13 · risk-register
 * R-04, R-17.
 *
 *  A. Sổ job: mọi job khai `module` có thật; job cần credential môi trường khai module connector;
 *     job `fanOut` thuần CSDL; bản sao danh sách trong bộ lập lịch khớp sổ.
 *  B. `runJob` hỏi module: module tắt ⇒ `SKIPPED` rõ lý do, không ghi `sync_runs`; bật module là
 *     job chạy ngay (không deploy). Tổ chức nhà: tắt đúng một module là đúng job của nó dừng, bật
 *     lại là chạy như cũ.
 *  C. Client tích hợp chia ngăn theo tổ chức (R-04): tổ chức khác không cầm instance / token của nhà.
 *  D. Getter đồng bộ "đã cấu hình chưa" nói KHÔNG cho tổ chức khác.
 *  E. Tuyến danh sách tổ chức cho bộ lập lịch: chỉ `CRON_SECRET`, chỉ mã, không có nhà.
 *  F. Webhook: mọi nhà cung cấp `HOME_ONLY`; nhà cung cấp lạ ⇒ NÉM, không rơi về nhà.
 *  G. R-17 (lỗi cũ, CHƯA sửa): ghim hiện trạng lá chắn "job đang chạy".
 *
 * Tổ chức thứ hai là CSDL PGlite THẬT (mã `ph-…`), tự cấp và tự dọn. Mọi thứ đổi trên tổ chức nhà
 * (một module tắt, biến môi trường, fetch giả) được khôi phục trong `finally`.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDbFor, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { GET as danhSachToChuc } from "@/app/api/sync/organizations/route";
import { JOB_RUN_KEYS } from "@/lib/constants/sync";
import { MODULE_KEYS, moduleDef, type ModuleKey } from "@/lib/constants/platform-modules";
import { integrationStatus } from "@/lib/env";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { __setAgentGithubFetchForTests, agentRemoteUrl, forgetAgentToken } from "@/lib/integrations/github/agent-identity";
import { getPancakeClient } from "@/lib/integrations/pancake/client";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { currentClientSlot, HOME_CLIENT_SLOT, isConnectorUnavailable, perOrganizationClients } from "@/lib/platform/credentials";
import { setOrganizationModule } from "@/lib/platform/module-config";
import { fanOutOrganizationCodes, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { peekExplicitNonHomeCode } from "@/lib/platform/peek";
import type { Organization } from "@/lib/platform/types";
import { resolveWebhookOrganization, WEBHOOK_BINDINGS, WebhookAuthError, type WebhookProvider } from "@/lib/platform/webhooks";
import { HOME_CREDENTIAL_EXEMPT, HOME_CREDENTIAL_JOBS, JOB_DEFINITIONS, jobModules, runJob, type JobSkipped } from "@/lib/sync/jobs";
import { isJobRunning, jobLockKey, runSyncJob, syncRouteShieldKey } from "@/lib/sync/runner";

const B = "ph-jobs";
const goc = path.resolve(__dirname, "..");

type FanOutModule = {
  FANOUT_JOBS: readonly string[];
  fanOutEnabled: (value: unknown) => boolean;
  fanOutUrls: (input: { base: string; job: string; query?: string; organizations: unknown[]; enabled: boolean }) => string[];
};

/** Nạp ĐÚNG tệp mà bộ lập lịch import — đường dẫn động để TypeScript không đòi khai kiểu cho .mjs. */
async function napFanOut(): Promise<FanOutModule> {
  return (await import(pathToFileURL(path.join(goc, "scripts/scheduler-fanout.mjs")).href)) as FanOutModule;
}

/** Connector mà một job cần (theo `HOME_CREDENTIAL_JOBS`) ⇒ module phải khai. `openai` chỉ đòi module cần credential. */
const MODULE_CUA_CONNECTOR: Record<string, ModuleKey> = {
  pancake: "connector_pancake",
  "pancake-pages": "connector_pancake",
  viettelpost: "connector_viettelpost",
  facebook: "connector_meta",
  sepay: "connector_bank",
  lark: "connector_messaging",
  github: "tech",
  ai: "tech",
};

function canCredential(m: ModuleKey): boolean {
  return moduleDef(m)?.requiresHomeCredentials === true;
}

/* ═════════════ A · SỔ JOB ═════════════ */
async function kiemSoJob() {
  const hopLe = new Set<string>(MODULE_KEYS);
  const loi: string[] = [];
  for (const [ten, d] of Object.entries(JOB_DEFINITIONS)) {
    for (const m of jobModules(d)) if (!hopLe.has(m)) loi.push(`${ten}: module "${m}" không có trong sổ module`);
    if (new Set(jobModules(d)).size !== jobModules(d).length) loi.push(`${ten}: khai trùng module`);
    const connector = HOME_CREDENTIAL_JOBS[ten];
    if (connector) {
      if (!canCredential(d.module)) loi.push(`${ten}: cần credential "${connector}" nhưng khai module "${d.module}" không phải connector cần credential của nhà`);
      const mongDoi = MODULE_CUA_CONNECTOR[connector];
      if (mongDoi && d.module !== mongDoi) loi.push(`${ten}: connector "${connector}" ⇒ module phải là "${mongDoi}", thấy "${d.module}"`);
    } else if (!HOME_CREDENTIAL_EXEMPT[ten] && jobModules(d).some(canCredential)) {
      loi.push(`${ten}: khai module cần credential của nhà mà không có trong HOME_CREDENTIAL_JOBS — tổ chức khác sẽ không được bỏ qua sớm`);
    }
    if (d.fanOut) {
      if (connector) loi.push(`${ten}: fanOut nhưng cần credential "${connector}"`);
      if (jobModules(d).some(canCredential)) loi.push(`${ten}: fanOut nhưng thuộc module cần credential của nhà`);
      if (d.source !== "ALL") loi.push(`${ten}: fanOut nhưng nguồn là nhà cung cấp ngoài ${d.source}`);
    }
  }
  assert.deepEqual(loi, [], "sổ job: mọi job khai module có thật; job cần credential khai connector; job fanOut thuần CSDL");
  assert.ok(!("organizations" in JOB_DEFINITIONS), "không job nào được tên `organizations` — tuyến tĩnh /api/sync/organizations che mất nó");

  // Bản sao trong bộ lập lịch BẰNG sổ, và mỗi job fan-out thật sự có lịch (không thì fan-out vô nghĩa).
  const fan = await napFanOut();
  const soJob = Object.entries(JOB_DEFINITIONS).filter(([, d]) => d.fanOut).map(([k]) => k).sort();
  assert.deepEqual([...fan.FANOUT_JOBS].sort(), soJob, "scripts/scheduler-fanout.mjs FANOUT_JOBS phải BẰNG tập job `fanOut: true` của lib/sync/jobs.ts");
  const lich = readFileSync(path.join(goc, "scripts/scheduler.mjs"), "utf8");
  const coLich = new Set([...lich.matchAll(/\{\s*job:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]));
  assert.deepEqual(soJob.filter((j) => !coLich.has(j)), [], "job fanOut phải có lịch của tổ chức nhà — fan-out đi kèm lượt của nhà");

  // Công tắc: chỉ đúng "1".
  for (const v of [undefined, "", "0", "true", "yes", "on", "1 ", 1]) assert.equal(fan.fanOutEnabled(v), false, `SCHEDULER_FANOUT=${JSON.stringify(v)} KHÔNG được bật fan-out`);
  assert.equal(fan.fanOutEnabled("1"), true);
  // Bộ lập lịch đọc công tắc bằng đúng hàm này, và lượt của nhà giữ nguyên URL cũ.
  assert.match(lich, /const FANOUT = fanOutEnabled\(process\.env\.SCHEDULER_FANOUT\);/, "bộ lập lịch phải đọc công tắc qua fanOutEnabled");
  assert.ok(lich.includes("await call(job, `${BASE}/api/sync/${job}?wait=0${query ? `&${query}` : \"\"}`);"), "lượt của tổ chức nhà: cùng URL như trước fan-out");
  assert.ok(lich.indexOf("await call(job,") < lich.indexOf("fanOutUrls("), "lượt của nhà gọi TRƯỚC, fan-out đi sau");

  // URL: tắt ⇒ rỗng; job không fan-out ⇒ rỗng; mã lạ bị bỏ; tham số giữ nguyên.
  const base = "http://erp.test";
  const job = fan.FANOUT_JOBS[0];
  assert.deepEqual(fan.fanOutUrls({ base, job, organizations: ["b-shop"], enabled: false }), [], "công tắc tắt ⇒ không URL nào");
  assert.deepEqual(fan.fanOutUrls({ base, job: "pancake-orders", organizations: ["b-shop"], enabled: true }), [], "job không fan-out ⇒ không URL nào");
  assert.deepEqual(
    fan.fanOutUrls({ base, job, query: "days=2", organizations: ["b-shop", "B-HOA", "../x", "", null, "c1"], enabled: true }),
    [`${base}/api/sync/${job}?wait=0&days=2&org=b-shop`, `${base}/api/sync/${job}?wait=0&days=2&org=c1`],
    "chỉ mã hợp lệ; tham số nghiệp vụ giữ nguyên; mỗi URL mang ?org",
  );
}

/* ═════════════ B · runJob HỎI MODULE ═════════════ */
async function kiemModuleCuaJob(home: Organization, bDbRuns: () => Promise<string[]>) {
  // Tổ chức B cấp với `modules: []` ⇒ chỉ lõi. `outcome-materialize` thuộc Đơn hàng ⇒ bỏ qua.
  const bo = (await runJob("outcome-materialize", { trigger: "CRON", actor: "ph-test", org: B })) as JobSkipped;
  assert.equal(bo.skipped, "MODULE_DISABLED", "module tắt ⇒ SKIPPED MODULE_DISABLED");
  assert.equal(bo.org, B);
  if (bo.skipped === "MODULE_DISABLED") assert.equal(bo.module, "orders");
  assert.match(bo.detail, /module "orders" đang tắt/);
  const bo2 = (await runJob("data-check", { trigger: "CRON", actor: "ph-test", org: B })) as JobSkipped;
  assert.equal(bo2.skipped, "MODULE_DISABLED");
  assert.deepEqual((await bDbRuns()).filter((j) => j === "outcome-materialize"), [], "job bị bỏ qua không ghi sync_runs");

  // Job cần credential: lý do connector đứng TRƯỚC lý do module (chính xác hơn cho người đọc).
  const boCred = (await runJob("pancake-orders", { trigger: "CRON", actor: "ph-test", org: B })) as JobSkipped;
  assert.equal(boCred.skipped, "CONNECTOR_NOT_CONFIGURED");

  // Job của module lõi chạy được cho B (và ghi vào CSDL của B).
  await runJob("work-recurrence", { trigger: "CRON", actor: "ph-test", org: B });
  assert.ok((await bDbRuns()).includes("work-recurrence"), "job module lõi chạy cho B, ghi sync_runs vào CSDL của B");

  // Bật Đơn hàng (cần Khách hàng + Sản phẩm) ⇒ chạy NGAY, không deploy.
  for (const moduleKey of ["customers", "products", "orders"]) {
    const r = await setOrganizationModule({ orgCode: B, moduleKey, enabled: true, actor: null, source: "TEST" });
    assert.ok(r.ok, `bật ${moduleKey} cho B: ${r.ok ? "" : r.message}`);
  }
  const chay = (await runJob("outcome-materialize", { trigger: "CRON", actor: "ph-test", org: B })) as { run?: { status: string }; skipped?: string };
  assert.equal(chay.skipped, undefined, "bật module ⇒ job không còn bị bỏ qua");
  assert.ok((await bDbRuns()).includes("outcome-materialize"), "lượt chạy sau khi bật ghi sync_runs của B");

  // Tổ chức NHÀ: tắt Lương ⇒ ĐÚNG job lương tự động dừng (qua `alsoRequires`), job khác chạy như cũ.
  const homeDb = await getDbFor(home);
  const truocNha = await homeDb.select({ id: schema.syncRuns.id }).from(schema.syncRuns).where(eq(schema.syncRuns.job, "payroll-autopilot"));
  const tat = await setOrganizationModule({ orgCode: home.code, moduleKey: "payroll", enabled: false, actor: null, source: "TEST" });
  assert.ok(tat.ok, `tắt Lương cho nhà (thử): ${tat.ok ? "" : tat.message}`);
  try {
    const boNha = (await runJob("payroll-autopilot", { trigger: "CRON", actor: "ph-test" })) as JobSkipped;
    assert.equal(boNha.skipped, "MODULE_DISABLED", "module đi kèm (alsoRequires) tắt ⇒ job dừng, kể cả ở tổ chức nhà");
    if (boNha.skipped === "MODULE_DISABLED") assert.equal(boNha.module, "payroll");
    const sauNha = await homeDb.select({ id: schema.syncRuns.id }).from(schema.syncRuns).where(eq(schema.syncRuns.job, "payroll-autopilot"));
    assert.equal(sauNha.length, truocNha.length, "job bị bỏ qua không ghi sync_runs của nhà");
  } finally {
    const pdb = await getPlatformDb();
    await pdb.delete(schema.platformOrganizationModules).where(and(eq(schema.platformOrganizationModules.organizationId, home.id), eq(schema.platformOrganizationModules.moduleKey, "payroll")));
    invalidateCapabilities();
  }
  // Khôi phục xong: tổ chức nhà chạy job như trước (không bị bỏ qua).
  const nhaChay = (await runJob("work-recurrence", { trigger: "CRON", actor: "ph-test" })) as { skipped?: string };
  assert.equal(nhaChay.skipped, undefined, "tổ chức nhà: mọi module bật ⇒ job chạy như trước nền tảng");
}

/* ═════════════ C + D · CLIENT VÀ GETTER ĐỒNG BỘ ═════════════ */
async function kiemClientTheoToChuc(home: Organization) {
  // Ngăn nhà: ngữ cảnh tường minh của nhà và "không ngữ cảnh" dùng CHUNG một instance — nhà không
  // đăng nhập Viettel Post thêm lần nào.
  const vtpNha = getViettelPostClient();
  assert.equal(await withOrganization(home.code, async () => getViettelPostClient()), vtpNha, "nhà: một instance Viettel Post dù có hay không có ngữ cảnh tường minh");
  const pagesNha = getPancakePagesClient();
  assert.equal(currentClientSlot().key, HOME_CLIENT_SLOT);

  await withOrganization(B, async () => {
    assert.equal(currentClientSlot().key, B, "ngăn của tổ chức khác khoá bằng MÃ tổ chức");
    const vtpB = getViettelPostClient();
    assert.notEqual(vtpB, vtpNha, "tổ chức khác KHÔNG cầm instance Viettel Post (mang token đăng nhập) của nhà");
    assert.equal(getViettelPostClient(), vtpB, "trong cùng tổ chức: dùng lại một instance");
    assert.equal(vtpB.configured, false, "Viettel Post: tổ chức khác thấy CHƯA cấu hình");
    const pagesB = getPancakePagesClient();
    assert.notEqual(pagesB, pagesNha, "tổ chức khác KHÔNG cầm instance Pancake Pages (bảng token trang) của nhà");
    assert.equal((pagesB as unknown as { accessToken: string }).accessToken, "", "instance của tổ chức khác không mang token môi trường của nhà");
    assert.throws(() => getPancakeClient(), (e: unknown) => isConnectorUnavailable(e), "Pancake POS: getter ném CONNECTOR_NOT_CONFIGURED, không dựng client từ khoá của nhà");
    assert.throws(() => getFacebookAdsClient(), (e: unknown) => isConnectorUnavailable(e), "Facebook: getter ném CONNECTOR_NOT_CONFIGURED, không dựng client từ token của nhà");

    assert.equal(peekExplicitNonHomeCode(), B);
  });

  // D · getter đồng bộ: đặt TẠM credential môi trường giả để đối chứng có nghĩa (bộ kiểm thử không
  // có credential thật — không đặt thì "mọi ô false" đúng cả khi lời chặn bị gỡ).
  const ENV_KET_NOI = { PANCAKE_API_KEY: "khoa-gia", PANCAKE_SHOP_ID: "shop-gia", FACEBOOK_ACCESS_TOKEN: "tok-gia", VIETTELPOST_API_KEY: "vtp-gia" } as const;
  const cuKetNoi = Object.fromEntries(Object.keys(ENV_KET_NOI).map((k) => [k, process.env[k]])) as Record<string, string | undefined>;
  try {
    Object.assign(process.env, ENV_KET_NOI);
    const nha = integrationStatus();
    assert.ok(nha.pancake && nha.facebook && nha.viettelPost, "đối chứng: tổ chức nhà thấy kết nối đã cấu hình");
    assert.deepEqual(await withOrganization(home.code, async () => integrationStatus()), nha, "ngữ cảnh tường minh của nhà: như không ngữ cảnh");
    const st = await withOrganization(B, async () => integrationStatus());
    assert.deepEqual(Object.entries(st).filter(([, v]) => v !== false).map(([k]) => k), [], "integrationStatus(): tổ chức khác thấy MỌI kết nối là chưa cấu hình, dù môi trường có khoá của nhà");
    assert.equal(await withOrganization(B, async () => getViettelPostClient().configured), false, "Viettel Post configured: tổ chức khác thấy chưa cấu hình dù môi trường có khoá");
  } finally {
    for (const [k, v] of Object.entries(cuKetNoi)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(peekExplicitNonHomeCode(), null, "ra khỏi ngữ cảnh tường minh ⇒ không còn là tổ chức khác");
  assert.equal(await withOrganization(home.code, async () => peekExplicitNonHomeCode()), null, "ngữ cảnh tường minh của nhà không phải 'tổ chức khác'");
  assert.equal(getViettelPostClient(), vtpNha, "ngăn nhà giữ nguyên sau khi tổ chức khác dùng ngăn của nó");

  // Bộ chia ngăn thuần: hàm dựng của tổ chức khác nhận đúng mã, và nhà không bao giờ gọi nó.
  const dung: string[] = [];
  const ngan = perOrganizationClients<{ ai: string }>({ home: () => ({ ai: "nha" }), other: (m) => (dung.push(m), { ai: m }) });
  assert.equal(ngan.get().ai, "nha");
  assert.equal((await withOrganization(B, async () => ngan.get())).ai, B);
  assert.equal((await withOrganization(home.code, async () => ngan.get())).ai, "nha");
  assert.deepEqual(dung, [B]);
  assert.deepEqual(ngan.slotKeys().sort(), [HOME_CLIENT_SLOT, B].sort());

  // GitHub App: token ĐANG ĐỆM của người vận hành không được trả cho tổ chức khác (nhánh trúng đệm
  // trước đây không đi qua lời chặn nào).
  const ENV = ["ERP_AGENT_GITHUB_APP_ID", "ERP_AGENT_GITHUB_INSTALLATION_ID", "ERP_AGENT_GITHUB_PRIVATE_KEY", "ERP_AGENT_GITHUB_REPO"] as const;
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.ERP_AGENT_GITHUB_APP_ID = "123456";
    process.env.ERP_AGENT_GITHUB_INSTALLATION_ID = "98765";
    process.env.ERP_AGENT_GITHUB_REPO = "vi-du/kho-thu";
    process.env.ERP_AGENT_GITHUB_PRIVATE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    forgetAgentToken();
    let xin = 0;
    __setAgentGithubFetchForTests((async (url: string | URL | Request) => {
      if (String(url).endsWith("/access_tokens")) {
        xin += 1;
        return new Response(JSON.stringify({ token: "ghs_cua_nha", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch);
    assert.match(await agentRemoteUrl(), /ghs_cua_nha/, "nhà vẫn lấy được token (đối chứng)");
    assert.equal(xin, 1);
    await assert.rejects(
      withOrganization(B, () => agentRemoteUrl()),
      (e: unknown) => isConnectorUnavailable(e),
      "tổ chức khác gọi agentRemoteUrl() khi token của nhà ĐANG ĐỆM ⇒ CONNECTOR_NOT_CONFIGURED, không nhận token",
    );
    assert.equal(xin, 1, "không lượt xin token nào cho tổ chức khác");
  } finally {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    forgetAgentToken();
    __setAgentGithubFetchForTests(null);
  }
}

/* ═════════════ E · TUYẾN DANH SÁCH TỔ CHỨC CHO BỘ LẬP LỊCH ═════════════ */
async function kiemTuyenToChuc(home: Organization) {
  const t = (code: string, over: Partial<Organization> = {}): Organization => ({ id: code, code, name: code, status: "ACTIVE", isHome: false, moduleDefault: "DISABLED", plan: null, templateKey: null, ...over });
  assert.deepEqual(
    fanOutOrganizationCodes([t("vnx", { isHome: true }), t("zeta"), t("alpha"), t("treo", { status: "SUSPENDED" }), t("luu", { status: "ARCHIVED" })]),
    ["alpha", "zeta"],
    "chỉ tổ chức ĐANG HOẠT ĐỘNG, KHÔNG phải nhà, xếp theo mã",
  );

  const cu = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "ph-cron-bi-mat-thu-32-ky-tu-000000";
  try {
    const goi = (headers: Record<string, string>) => danhSachToChuc(new NextRequest("https://erp.test/api/sync/organizations", { headers }));
    assert.equal((await goi({})).status, 401, "không bí mật ⇒ 401");
    assert.equal((await goi({ "x-cron-secret": "sai" })).status, 401, "bí mật sai ⇒ 401");
    const ok = await goi({ "x-cron-secret": process.env.CRON_SECRET });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { organizations: string[] };
    assert.deepEqual(Object.keys(body), ["organizations"], "chỉ trả MÃ — không tên, không trạng thái");
    assert.ok(body.organizations.includes(B), "tổ chức khác đang hoạt động có trong danh sách");
    assert.ok(!body.organizations.includes(home.code), "tổ chức nhà KHÔNG có trong danh sách — lịch của nhà đi đường cũ");
    const bearer = await goi({ authorization: `Bearer ${process.env.CRON_SECRET}` });
    assert.equal(bearer.status, 200, "nhận cả Authorization: Bearer như /api/sync/<job>");
  } finally {
    if (cu === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = cu;
  }
  const src = readFileSync(path.join(goc, "app/api/sync/organizations/route.ts"), "utf8");
  assert.ok(!/getCurrentUser|lib\/auth\/session/.test(src), "tuyến danh sách tổ chức KHÔNG nhận phiên người dùng — chỉ CRON_SECRET");
  assert.ok(!/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\b/.test(src), "chỉ GET");
}

/* ═════════════ F · WEBHOOK ═════════════ */
async function kiemWebhook(home: Organization) {
  const nhaCungCap = Object.keys(WEBHOOK_BINDINGS) as WebhookProvider[];
  assert.ok(nhaCungCap.length >= 4, "đọc hụt WEBHOOK_BINDINGS");
  // Danh sách ĐÓNG các webhook phân giải theo token trong đường dẫn (0182). Mọi webhook khác vẫn HOME_ONLY — thêm một
  // webhook theo tổ chức là phải thêm TƯỜNG MINH vào đây, không lặng lẽ đổi chế độ của webhook của nhà.
  const URL_SECRET_PROVIDERS: readonly WebhookProvider[] = ["PANCAKE_FANPAGE"];
  for (const p of nhaCungCap) {
    assert.ok(WEBHOOK_BINDINGS[p].reason.length >= 20, `webhook ${p} phải kèm lý do`);
    if (URL_SECRET_PROVIDERS.includes(p)) {
      assert.equal(WEBHOOK_BINDINGS[p].mode, "URL_SECRET", `webhook ${p} phân giải theo token của tổ chức`);
      await assert.rejects(resolveWebhookOrganization(p), WebhookAuthError, `webhook ${p} không token ⇒ NÉM, không rơi về nhà`);
      continue;
    }
    assert.equal(WEBHOOK_BINDINGS[p].mode, "HOME_ONLY", `Phase 1.x: webhook ${p} vẫn HOME_ONLY — bí mật là một giá trị môi trường của nhà`);
    assert.equal(await resolveWebhookOrganization(p), home.code);
  }
  for (const la of ["KHONG_CO", "toString", "constructor", ""]) {
    await assert.rejects(resolveWebhookOrganization(la as WebhookProvider), /chưa khai|chưa được hỗ trợ/, `nhà cung cấp "${la}" không có trong bảng ⇒ NÉM, không rơi về nhà`);
    await assert.rejects(withOrganization(B, () => resolveWebhookOrganization(la as WebhookProvider)), /chưa khai|chưa được hỗ trợ/, `"${la}" trong ngữ cảnh tổ chức khác cũng NÉM`);
  }
}

/* ═════════════ G · R-17 — HIỆN TRẠNG LÁ CHẮN "JOB ĐANG CHẠY" (CHƯA SỬA) ═════════════ */
async function kiemLaChanR17(home: Organization) {
  const nha = { code: home.code, isHome: true };
  // Với MỌI job có khoá runner đã biết, lá chắn hỏi một khoá KHÔNG nằm trong số khoá runner giữ.
  for (const [slug, khoaRunner] of Object.entries(JOB_RUN_KEYS)) {
    const d = JOB_DEFINITIONS[slug];
    assert.ok(d, `JOB_RUN_KEYS khai job không tồn tại: ${slug}`);
    const khien = syncRouteShieldKey(nha, d.source, slug);
    assert.ok(khien === null || !khoaRunner.includes(khien), `R-17 ĐÃ ĐỔI: lá chắn của ${slug} nay khớp khoá runner (${khien}). Nếu cố ý sửa, cập nhật risk-register R-17 và bài kiểm này.`);
  }
  // Job nguồn ALL không có lá chắn.
  assert.equal(syncRouteShieldKey(nha, "ALL", "alerts"), null);
  // Tổ chức khác: cùng dạng khoá có tiền tố, không đè khoá của nhà.
  assert.equal(syncRouteShieldKey({ code: B, isHome: false }, "PANCAKE", "pancake-orders"), jobLockKey({ code: B, isHome: false }, "PANCAKE", "pancake-orders"));

  // vtp-tracking: lượt tra cứu ĐANG CHẠY mà lá chắn vẫn cho qua ⇒ lượt mới vẫn chạy đối chiếu care
  // + ghép lại bảng kê. Đây là hành vi của tổ chức nhà hôm nay — sửa R-17 là đổi nó.
  let mo!: () => void;
  const cong = new Promise<void>((r) => (mo = r));
  const dangChay = runSyncJob({ source: "VIETTELPOST", job: "tracking_poll", trigger: "CRON", actor: "ph-test", observeOnly: true }, async () => {
    await cong;
    return null;
  });
  try {
    for (let i = 0; i < 200 && !isJobRunning("VIETTELPOST:tracking_poll"); i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(isJobRunning("VIETTELPOST:tracking_poll"), "runner khoá theo tên nội bộ");
    const khien = syncRouteShieldKey(nha, JOB_DEFINITIONS["vtp-tracking"].source, "vtp-tracking");
    assert.equal(khien, "VIETTELPOST:vtp-tracking");
    assert.equal(isJobRunning(khien!), false, "R-17 hiện trạng: lá chắn KHÔNG thấy lượt tra cứu đang chạy ⇒ route cho qua, đối chiếu care vẫn chạy");
  } finally {
    mo();
    await dangChay;
    const db = await getDbFor(home);
    await db.delete(schema.syncRuns).where(and(eq(schema.syncRuns.source, "VIETTELPOST"), eq(schema.syncRuns.actor, "ph-test")));
  }
}

export async function testPlatformJobs() {
  const dir = organizationDatabaseUrl({ code: B, isHome: false }).replace(/^pglite:\/\//, "");
  rmSync(dir, { recursive: true, force: true });
  const home = await getHomeOrganization();
  try {
    await kiemSoJob();
    const prov = await provisionOrganization({ code: B, name: "Job theo tổ chức (thử)", modules: [], source: "TEST", actor: null });
    const bDb = await getDbFor(prov.organization);
    const bDbRuns = async () => (await bDb.select({ job: schema.syncRuns.job }).from(schema.syncRuns)).map((r) => r.job);
    await kiemModuleCuaJob(home, bDbRuns);
    await kiemClientTheoToChuc(home);
    await kiemTuyenToChuc(home);
    await kiemWebhook(home);
    await kiemLaChanR17(home);
  } finally {
    const pdb = await getPlatformDb();
    const dong = await pdb.select({ id: schema.platformOrganizations.id }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, B));
    for (const d of dong) await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, d.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, B));
    invalidateOrganizations();
    invalidateCapabilities();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows giữ tệp của PGlite đang mở — lượt chạy sau xoá thư mục ở đầu bài.
    }
  }
  console.log("✓ Nền tảng · job theo tổ chức: module mỗi job, SKIPPED khi module tắt, client chia ngăn theo tổ chức, fan-out mặc định tắt, tuyến danh sách tổ chức, webhook HOME_ONLY, R-17 ghim hiện trạng");
}
