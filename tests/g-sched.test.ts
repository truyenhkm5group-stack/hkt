/**
 * ═══════════ G-SCHED — LUẬT TỰ ĐỘNG CỦA TỔ CHỨC KHÁCH TỰ CHẠY, CÔ LẬP, CÓ GIỚI HẠN; LỊCH VNX GIỮ NGUYÊN ═══════════
 *
 * Quyết định của chủ nền tảng 29/09/2026: «Cho automation của tenant khách chạy mỗi 10 phút mặc định, tenant-isolated
 * + rate limit; lịch VNX giữ nguyên. Sau này cho phép cấu hình cadence theo plan.»
 *
 *  1. Nhịp: mặc định 10, đọc được từ gói, < 5 bị từ chối; lượt gõ 5 phút ra đúng số lượt chạy theo ô nhịp.
 *  2. Bộ lập lịch: `workflows` CHỈ fan-out (không lượt của nhà); tầng tự động hoá chỉ gồm job an toàn; tầng toàn bộ
 *     vẫn tắt; lượt của nhà giữ nguyên URL; `alerts` giữ nguyên lịch.
 *  3. Cô lập: tuần tự (không bao giờ hai tổ chức cùng lúc), tổ chức lỗi không chặn tổ chức sau, lượt gõ chồng bị bỏ.
 *  4. Tổ chức THẬT (`gs-a` · `gs-b` gói nhịp 15 · `gs-c` tạm dừng luật · `gs-d` đình chỉ): một lượt fan-out qua ĐÚNG
 *     tuyến `/api/sync/workflows?wait=1&org=…` gọi mỗi tổ chức ACTIVE đúng một lần, bỏ qua SUSPENDED / paused, không
 *     chạm CSDL nhà; chưa tới kỳ ⇒ không ghi sổ; trần thời gian dừng trước sự kiện chưa xét.
 *  5. Nhà: luật vẫn chạy ké `alerts`; job `workflows` gọi cho nhà ⇒ bỏ qua, không ghi sổ.
 *  6. Triển khai: công tắc tầng tự động hoá thật sự tới container scheduler (compose), tầng toàn bộ không.
 *
 * Chạy riêng: xem tests/sync-fixtures.test.ts (cần CSDL PGlite đã migrate).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDbFor, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { POST as syncRoute } from "@/app/api/sync/[job]/route";
import { evaluateAlerts } from "@/lib/alerts/rules";
import type { SessionUser } from "@/lib/auth/session";
import {
  alertsCarriesWorkflows,
  parseWorkflowCadence,
  WORKFLOW_CADENCE_DEFAULT_MINUTES,
  WORKFLOW_CADENCE_MIN_MINUTES,
  workflowRunDue,
  workflowScheduleSentence,
} from "@/lib/constants/workflow-cadence";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { currentOrganization, withOrganization } from "@/lib/platform/context";
import { setOrganizationSuspended, setWorkflowsPaused } from "@/lib/platform/kill-switches";
import { invalidateOrgFlags } from "@/lib/platform/org-flags";
import { fanOutOrganizationCodes, getHomeOrganization, invalidateOrganizations, listOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { HOME_CREDENTIAL_JOBS, runJob } from "@/lib/sync/jobs";
import { runWorkflows } from "@/lib/workflow/engine";
import { runScheduledWorkflows, workflowCadenceOf, WORKFLOWS_JOB } from "@/lib/workflow/scheduled";

const goc = path.resolve(__dirname, "..");
const doc = (f: string) => readFileSync(path.join(goc, f), "utf8").replace(/\r\n/g, "\n");

const A = "gs-a";
const B = "gs-b";
const C = "gs-c";
const D = "gs-d";
const ORGS = [A, B, C, D] as const;
const PLAN_CHAM = "gs-cham";

type FanOut = {
  FANOUT_JOBS: readonly string[];
  AUTOMATION_FANOUT_JOBS: readonly string[];
  FANOUT_ONLY_JOBS: readonly string[];
  WORKFLOW_FANOUT_TICK_MINUTES: number;
  callsHome: (job: string) => boolean;
  fanOutPlan: (i: { job: string; all: boolean; automation: boolean }) => "AUTOMATION" | "ALL" | "OFF";
  fanOutUrls: (i: { base: string; job: string; query?: string; organizations: unknown[]; enabled: boolean; wait?: boolean }) => string[];
  runSequential: <T, R>(items: T[], runOne: (item: T) => Promise<R>) => Promise<{ item: T; ok: boolean; value?: R; error?: string }[]>;
  createSerialQueue: () => { run: <R>(key: string, fn: () => Promise<R>) => Promise<R | { skipped: "BUSY"; key: string }>; busy: (key: string) => boolean };
};

async function napFanOut(): Promise<FanOut> {
  return (await import(pathToFileURL(path.join(goc, "scripts/scheduler-fanout.mjs")).href)) as FanOut;
}

const cho = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ═════════════ 1 · NHỊP ═════════════ */
function kiemNhip() {
  assert.equal(WORKFLOW_CADENCE_DEFAULT_MINUTES, 10, "G-SCHED: mặc định 10 phút");
  assert.deepEqual(parseWorkflowCadence(undefined), { minutes: 10, source: "DEFAULT" });
  assert.deepEqual(parseWorkflowCadence({ users: 3 }), { minutes: 10, source: "DEFAULT" }, "gói không khai nhịp ⇒ mặc định");
  assert.deepEqual(parseWorkflowCadence({ workflowCadenceMinutes: null }), { minutes: 10, source: "DEFAULT" });
  assert.deepEqual(parseWorkflowCadence({ workflowCadenceMinutes: 15 }), { minutes: 15, source: "PLAN" }, "đọc được từ gói");
  assert.deepEqual(parseWorkflowCadence({ workflowCadenceMinutes: 5 }), { minutes: 5, source: "PLAN" }, "5 phút là nhỏ nhất được nhận");
  for (const sai of [4, 1, 0, -10, 4.5, "10", 1441, Number.NaN]) {
    const r = parseWorkflowCadence({ workflowCadenceMinutes: sai });
    assert.equal(r.minutes, 10, `nhịp ${String(sai)} bị từ chối ⇒ dùng mặc định, không kẹp`);
    assert.equal(r.source, "DEFAULT");
    assert.ok(r.rejected && r.rejected.reason.length > 5, `nhịp ${String(sai)} phải mang lý do từ chối`);
  }

  // Ô nhịp: lượt gõ 5 phút (lệch 2,5 phút, rung ±400 ms) trong 2 giờ ⇒ đúng số lượt chạy của từng nhịp.
  const dem = (nhip: number) => {
    let last: number | null = null;
    let n = 0;
    const goc0 = Date.UTC(2026, 8, 29, 0, 0, 0);
    for (let k = 0; k < 24; k += 1) {
      const now = goc0 + (k * 5 + 2.5) * 60_000 + (k % 2 ? 400 : -400);
      if (workflowRunDue({ now, lastStartedAt: last, cadenceMinutes: nhip })) {
        n += 1;
        last = now + 30; // mốc bắt đầu lượt ghi sau lúc gõ vài chục mili-giây
      }
    }
    return n;
  };
  assert.equal(dem(10), 12, "nhịp 10 ⇒ 12 lượt / 2 giờ");
  assert.equal(dem(15), 8, "nhịp 15 ⇒ 8 lượt / 2 giờ");
  assert.equal(dem(5), 24, "nhịp 5 ⇒ mọi lượt gõ");
  assert.equal(workflowRunDue({ now: 1, lastStartedAt: null, cadenceMinutes: 10 }), true, "chưa chạy lần nào ⇒ chạy");

  assert.equal(alertsCarriesWorkflows({ isHome: true }), true, "luật của NHÀ chạy ké job cảnh báo");
  assert.equal(alertsCarriesWorkflows({ isHome: false }), false, "luật của KHÁCH không chạy ké job cảnh báo");
  assert.match(workflowScheduleSentence({ isHome: false }, { minutes: 10 }), /mỗi 10 phút \/ lượt/, "câu trên màn hình khách in đúng nhịp");
  assert.match(workflowScheduleSentence({ isHome: false }, { minutes: 15 }), /mỗi 15 phút \/ lượt/);
  assert.match(workflowScheduleSentence({ isHome: true }, { minutes: 10 }), /job cảnh báo/);
}

/* ═════════════ 2 · BỘ LẬP LỊCH ═════════════ */
async function kiemLich(fan: FanOut) {
  assert.equal(fan.WORKFLOW_FANOUT_TICK_MINUTES, WORKFLOW_CADENCE_MIN_MINUTES, "nhịp gõ của bộ lập lịch = nhịp nhỏ nhất được phép — gói nhịp 5 phút cũng được phục vụ");
  assert.ok(fan.FANOUT_JOBS.includes(WORKFLOWS_JOB));
  // `ads-spend-org` thêm 03/10/2026: chủ nền tảng yêu cầu chi tiêu quảng cáo Facebook của tổ chức khách ĐỒNG BỘ TỰ ĐỘNG,
  // bằng kết nối «meta-ads-org» của chính tổ chức (không cần credential của nhà — khẳng định ngay dưới vẫn kiểm điều đó).
  assert.deepEqual([...fan.AUTOMATION_FANOUT_JOBS].sort(), ["ads-spend-org", "messaging-retry", "sales-followup", "work-recurrence", "workflows"], "tầng tự động hoá: luật + việc định kỳ + follow-up chatbot + gửi lại tin nhóm + chi tiêu quảng cáo của tổ chức");
  for (const j of fan.AUTOMATION_FANOUT_JOBS) {
    assert.ok(fan.FANOUT_JOBS.includes(j), `${j} phải khai fanOut`);
    assert.ok(!HOME_CREDENTIAL_JOBS[j], `${j} không được cần credential của nhà`);
  }
  // `ads-spend-org` CHỈ fan-out: chi tiêu quảng cáo của nhà đi qua `facebook-ads` (biến môi trường), không qua job này.
  assert.deepEqual([...fan.FANOUT_ONLY_JOBS], [WORKFLOWS_JOB, "sales-followup", "ads-spend-org"]);

  const lich = doc("scripts/scheduler.mjs");
  const jobsLich = [...new Set([...lich.matchAll(/\{\s*job:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]))];
  assert.ok(jobsLich.length > 15, "đọc hụt lịch");
  for (const j of jobsLich) assert.equal(fan.callsHome(j), !fan.FANOUT_ONLY_JOBS.includes(j), `${j}: ${fan.FANOUT_ONLY_JOBS.includes(j) ? "KHÔNG" : ""} có lượt của nhà`);

  // Ma trận đường fan-out: tắt ⇒ không gì; tự động hoá ⇒ đúng hai job; toàn bộ ⇒ đường cũ cho phần còn lại.
  for (const j of [...jobsLich, ...fan.FANOUT_JOBS]) assert.equal(fan.fanOutPlan({ job: j, all: false, automation: false }), "OFF", `${j}: hai công tắc tắt ⇒ không fan-out`);
  for (const j of jobsLich) {
    const k = fan.fanOutPlan({ job: j, all: false, automation: true });
    assert.equal(k, fan.AUTOMATION_FANOUT_JOBS.includes(j) ? "AUTOMATION" : "OFF", `${j}: CHỈ job tự động hoá chạy thêm cho khách khi bật G-SCHED`);
  }
  for (const j of ["dashboard-warm", "outcome-materialize", "work-snapshot", "data-check"]) {
    assert.equal(fan.fanOutPlan({ job: j, all: false, automation: true }), "OFF", `${j} KHÔNG chạy cho khách khi chỉ bật G-SCHED`);
    assert.equal(fan.fanOutPlan({ job: j, all: true, automation: false }), "ALL", `${j}: tầng toàn bộ giữ đường cũ`);
  }
  assert.equal(fan.fanOutPlan({ job: WORKFLOWS_JOB, all: true, automation: false }), "AUTOMATION", "job tự động hoá không bao giờ đi đường wait=0");
  for (const j of ["alerts", "pancake-orders", "landing-sheet"]) assert.equal(fan.fanOutPlan({ job: j, all: true, automation: true }), "OFF", `${j} không bao giờ fan-out`);

  assert.deepEqual(
    fan.fanOutUrls({ base: "http://erp.test", job: WORKFLOWS_JOB, organizations: ["gs-a", "../x", "gs-b"], enabled: true, wait: true }),
    ["http://erp.test/api/sync/workflows?wait=1&org=gs-a", "http://erp.test/api/sync/workflows?wait=1&org=gs-b"],
    "tầng tự động hoá gọi wait=1 (tuần tự thật), mỗi tổ chức một URL",
  );

  // Nguồn bộ lập lịch: công tắc, lượt nhà, đường tự động hoá; `alerts` giữ NGUYÊN lịch.
  assert.match(lich, /const AUTOMATION_FANOUT = fanOutEnabled\(process\.env\.SCHEDULER_AUTOMATION_FANOUT\);/);
  assert.match(lich, /const FANOUT = fanOutEnabled\(process\.env\.SCHEDULER_FANOUT\);/);
  assert.ok(lich.includes("if (callsHome(job)) await call(job, `${BASE}/api/sync/${job}?wait=0${query ? `&${query}` : \"\"}`);"), "lượt của nhà: cùng URL như trước, trừ job chỉ fan-out");
  assert.ok(lich.includes('{ job: "alerts", every: minutes("ALERTS_EVERY_MINUTES", 10), offset: 3 }'), "lịch cảnh báo của nhà (chở luật của VNX) giữ nguyên");
  assert.ok(lich.includes('{ job: "workflows", every: WORKFLOW_FANOUT_TICK_MINUTES, offset: 2.5 }'), "workflows gõ theo hằng số, không đọc biến môi trường");
  const iAuto = lich.indexOf('if (plan === "AUTOMATION")');
  const khoiAuto = lich.slice(iAuto, lich.indexOf("return;", iAuto));
  assert.ok(iAuto > 0 && /automationQueue\.run\(job,/.test(khoiAuto) && /runSequential\(urls,/.test(khoiAuto) && /wait: true/.test(khoiAuto) && /timeoutMs: AUTOMATION_CALL_TIMEOUT_MS/.test(khoiAuto), "đường tự động hoá: hàng đợi chung + tuần tự + chờ kết quả + trần thời gian");

  // Job cảnh báo: luật chỉ chạy ké cho NHÀ.
  const rules = doc("lib/alerts/rules.ts");
  assert.match(rules, /alertsCarriesWorkflows\(await currentOrganization\(\)\)\s*\n\s*\? await runWorkflows\(\)/, "evaluateAlerts: runWorkflows chỉ khi tổ chức là nhà");
}

/* ═════════════ 3 · TUẦN TỰ, CÔ LẬP, KHÔNG DỒN ═════════════ */
async function kiemTuanTu(fan: FanOut) {
  let dang = 0;
  let max = 0;
  const thu = async (x: string) => {
    dang += 1;
    max = Math.max(max, dang);
    await cho(15);
    dang -= 1;
    if (x === "loi") throw new Error("tổ chức này hỏng");
    return x.toUpperCase();
  };
  const r = await fan.runSequential(["loi", "b", "c"], thu);
  assert.equal(max, 1, "runSequential: không bao giờ hai tổ chức cùng lúc");
  assert.deepEqual(r.map((x) => x.ok), [false, true, true], "tổ chức đầu hỏng không chặn tổ chức sau");
  assert.deepEqual(r.map((x) => x.value ?? x.error), ["tổ chức này hỏng", "B", "C"]);

  const q = fan.createSerialQueue();
  dang = 0;
  max = 0;
  const viec = (x: string) => async () => thu(x);
  const p1 = q.run("workflows", viec("w"));
  const p2 = q.run("work-recurrence", viec("r"));
  const p3 = await q.run("workflows", viec("w2"));
  assert.deepEqual(p3, { skipped: "BUSY", key: "workflows" }, "lượt gõ chồng của cùng job bị BỎ, không dồn");
  assert.deepEqual(await Promise.all([p1, p2]), ["W", "R"]);
  assert.equal(max, 1, "hai job tự động hoá gõ cùng lúc vẫn chạy nối nhau");
  assert.equal(q.busy("workflows"), false);
  assert.equal(await q.run("workflows", viec("w3")), "W3", "lượt trước xong ⇒ lượt gõ sau chạy");
  const hong = q.run("workflows", async () => {
    throw new Error("hỏng");
  });
  await assert.rejects(hong);
  assert.equal(await q.run("work-recurrence", viec("r2")), "R2", "một việc hỏng không làm kẹt hàng đợi");
}

/* ═════════════ 6 · TRIỂN KHAI ═════════════ */
function kiemTrienKhai() {
  const compose = doc("docker-compose.prod.yml");
  const i = compose.indexOf("\n  scheduler:\n");
  assert.ok(i > 0, "không thấy service scheduler");
  const j = compose.indexOf("\n  chatbot:\n", i);
  const khoi = compose.slice(i, j > i ? j : undefined);
  const dong = khoi.split("\n").filter((d) => !/^\s*#/.test(d));
  assert.ok(dong.some((d) => d.trim() === "SCHEDULER_AUTOMATION_FANOUT: ${SCHEDULER_AUTOMATION_FANOUT:-1}"), "container scheduler phải nhận SCHEDULER_AUTOMATION_FANOUT, mặc định 1 (tắt bằng .env)");
  assert.ok(dong.some((d) => d.trim() === 'command: ["node", "scripts/scheduler.mjs"]'), "container scheduler chạy đúng bộ lập lịch");
  assert.ok(dong.some((d) => d.trim() === "env_file: .env"), "scheduler vẫn nạp .env");
  // Tầng TOÀN BỘ không được bật ở đâu trong đường triển khai.
  for (const tep of ["docker-compose.prod.yml", "scripts/install-vps.sh", ".github/workflows/deploy-vps.yml"]) {
    const pham = doc(tep)
      .split("\n")
      .filter((d) => !/^\s*#/.test(d) && /\bSCHEDULER_FANOUT\b/.test(d));
    assert.deepEqual(pham, [], `${tep}: SCHEDULER_FANOUT (tầng toàn bộ) phải vẫn TẮT — G-SCHED chỉ duyệt tự động hoá`);
  }
  // install-vps.sh không ghi dòng rỗng đè giá trị tắt của người vận hành.
  assert.ok(!/upsert_env\s+SCHEDULER_AUTOMATION_FANOUT/.test(doc("scripts/install-vps.sh")), "install-vps.sh không đụng công tắc — người vận hành tắt bằng .env thì deploy sau không bật lại");
}

/* ═════════════ 4 + 5 · TỔ CHỨC THẬT ═════════════ */
function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "gs-op", email: "op@gs.local", name: "GS", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

async function donDep() {
  const pdb = await getPlatformDb();
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  await pdb.delete(schema.platformPlans).where(eq(schema.platformPlans.key, PLAN_CHAM));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateOrgFlags();
}

async function soLuotWorkflows(org: { code: string; isHome: boolean }) {
  const db = await getDbFor(org);
  return db.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.source, "ERP"), eq(schema.syncRuns.job, WORKFLOWS_JOB)));
}

async function kiemToChucThat(fan: FanOut) {
  const home = await getHomeOrganization();
  const op = sessionUser({ organization: { code: home.code, name: home.name, isHome: true } });
  const pdb = await getPlatformDb();
  await pdb.insert(schema.platformPlans).values({ key: PLAN_CHAM, name: "Gói nhịp chậm (thử)", limits: { workflowCadenceMinutes: 15 }, position: 99 });
  for (const code of ORGS) {
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    await provisionOrganization({ code, name: `G-SCHED ${code}`, modules: [], source: "TEST", actor: null });
  }
  await pdb.update(schema.platformOrganizations).set({ plan: PLAN_CHAM }).where(eq(schema.platformOrganizations.code, B));
  invalidateOrganizations();
  assert.ok("ok" in (await setWorkflowsPaused(op, { orgCode: C, paused: true, reason: "Thử tạm dừng luật của khách" })), "tạm dừng luật gs-c");
  assert.ok("ok" in (await setOrganizationSuspended(op, { orgCode: D, suspend: true, reason: "Thử đình chỉ tổ chức khách" })), "đình chỉ gs-d");

  assert.deepEqual(await workflowCadenceOf(A), { minutes: 10, source: "DEFAULT" }, "gói không khai nhịp ⇒ 10");
  assert.deepEqual(await workflowCadenceOf(B), { minutes: 15, source: "PLAN" }, "gói khai 15 ⇒ 15");

  // Danh sách mà bộ lập lịch nhận (tuyến /api/sync/organizations trả đúng hàm này).
  const orgs = fanOutOrganizationCodes(await listOrganizations());
  assert.ok(!orgs.includes(home.code), "tổ chức NHÀ không bao giờ trong fan-out");
  assert.ok(!orgs.includes(D), "tổ chức ĐÌNH CHỈ không trong fan-out");
  const khach = orgs.filter((c) => c.startsWith("gs-"));
  assert.deepEqual(khach, [A, B, C], "mọi tổ chức khách ACTIVE, xếp theo mã");

  const nhaTruoc = (await soLuotWorkflows(home)).length;
  const cu = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "gs-cron-bi-mat-thu-32-ky-tu-00000000";
  let dang = 0;
  let max = 0;
  const goi: string[] = [];
  const hong = new Set<string>();
  const goiTuyen = async (url: string) => {
    const org = new URL(url).searchParams.get("org") ?? "";
    goi.push(org);
    dang += 1;
    max = Math.max(max, dang);
    try {
      if (hong.has(org)) throw new Error(`mạng tới ${org} hỏng`);
      const job = new URL(url).pathname.split("/").pop() ?? "";
      const res = await syncRoute(new NextRequest(url, { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" } }), { params: Promise.resolve({ job }) });
      assert.equal(res.status, 200, `${org}: tuyến trả 200`);
      return ((await res.json()) as { result: Record<string, unknown> }).result;
    } finally {
      dang -= 1;
    }
  };
  try {
    // ── Lượt 1: mỗi tổ chức khách ACTIVE đúng MỘT lượt gọi ──
    const urls = fan.fanOutUrls({ base: "http://erp.test", job: WORKFLOWS_JOB, organizations: khach, enabled: true, wait: true });
    const r1 = await fan.runSequential(urls, goiTuyen);
    assert.deepEqual(goi, [A, B, C], "đúng một lượt gọi cho mỗi tổ chức khách ACTIVE");
    assert.ok(r1.every((x) => x.ok), JSON.stringify(r1));
    const kq = (i: number) => r1[i].value as { skipped?: string; run?: { status: string }; summary?: { detail: string } };
    assert.equal(kq(0).run?.status, "SUCCESS", "gs-a chạy một lượt");
    assert.match(kq(0).summary?.detail ?? "", /nhịp 10 phút \(mặc định\)/);
    assert.equal(kq(1).run?.status, "SUCCESS", "gs-b chạy một lượt");
    assert.match(kq(1).summary?.detail ?? "", /nhịp 15 phút \(theo gói\)/);
    assert.equal(kq(2).skipped, "WORKFLOWS_PAUSED", "gs-c đang tạm dừng luật ⇒ bỏ qua");
    assert.equal((await soLuotWorkflows({ code: A, isHome: false })).length, 1, "sync_runs của gs-a: một dòng, trong CSDL của nó");
    assert.equal((await soLuotWorkflows({ code: B, isHome: false })).length, 1);
    assert.equal((await soLuotWorkflows({ code: C, isHome: false })).length, 0, "tạm dừng ⇒ không ghi sổ");
    assert.equal((await soLuotWorkflows(home)).length, nhaTruoc, "CSDL nhà không có lượt workflows nào");

    // Gọi thẳng tổ chức đình chỉ (danh sách đệm cũ tới 5 phút): tuyến trả 409, không chạy.
    const treo = await syncRoute(new NextRequest(`http://erp.test/api/sync/workflows?wait=1&org=${D}`, { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET } }), { params: Promise.resolve({ job: WORKFLOWS_JOB }) });
    assert.equal(treo.status, 409, "tổ chức đình chỉ ⇒ 409, không chạy");

    // ── Chưa tới kỳ ⇒ bỏ qua, không ghi sổ (mốc tất định, không phụ thuộc đồng hồ thật — AGENTS.md mục 50) ──
    const [dongA] = await soLuotWorkflows({ code: A, isHome: false });
    const cungO = await withOrganization(A, () => runScheduledWorkflows({ trigger: "CRON", actor: "gs-test", now: dongA.startedAt.getTime() }));
    assert.equal((cungO as { skipped?: string }).skipped, "NOT_DUE", "cùng ô nhịp ⇒ NOT_DUE");
    assert.equal((await soLuotWorkflows({ code: A, isHome: false })).length, 1, "NOT_DUE không ghi sổ");
    const o10 = 10 * 60_000;
    const oSau = (Math.floor(dongA.startedAt.getTime() / o10) + 1) * o10 + 150_000;
    const toiKy = await withOrganization(A, () => runScheduledWorkflows({ trigger: "CRON", actor: "gs-test", now: oSau }));
    assert.equal((toiKy as { run?: { status: string } }).run?.status, "SUCCESS", "ô nhịp kế tiếp ⇒ chạy");
    assert.equal((await soLuotWorkflows({ code: A, isHome: false })).length, 2);

    // ── Lượt 3: tổ chức đầu HỎNG (mạng) ⇒ tổ chức sau vẫn chạy ──
    const dbB = await getDbFor({ code: B, isHome: false });
    await dbB.delete(schema.syncRuns).where(eq(schema.syncRuns.job, WORKFLOWS_JOB));
    hong.add(A);
    goi.length = 0;
    const r3 = await fan.runSequential(urls, goiTuyen);
    assert.deepEqual(goi, [A, B, C]);
    assert.equal(r3[0].ok, false, "gs-a hỏng");
    assert.equal(r3[1].ok, true, "gs-b vẫn được gọi sau khi gs-a hỏng");
    assert.equal((r3[1].value as { run?: { status: string } }).run?.status, "SUCCESS");
    assert.equal((await soLuotWorkflows({ code: B, isHome: false })).length, 1, "gs-b ghi đúng một lượt");
    assert.equal(max, 1, "không bao giờ hai tổ chức chạy cùng lúc");
  } finally {
    if (cu === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = cu;
  }

  // ── Trần thời gian: quá mốc ⇒ dừng TRƯỚC sự kiện chưa xét, con trỏ không nhảy qua ──
  await withOrganization(A, async () => {
    const db = await getDbFor({ code: A, isHome: false });
    await db.insert(schema.domainEvents).values({ name: "gs.thu", subjectType: "gs", subjectId: "1", actorKind: "SYSTEM", source: "TEST", occurredAt: new Date() });
    const het = await runWorkflows({ deadline: Date.now() - 1 });
    assert.equal(het.events, 0, "hết trần ⇒ không xét sự kiện nào");
    assert.equal(het.timeBudgetHit, true, "kết quả nói ra vì sao dừng");
    const tiep = await runWorkflows();
    assert.equal(tiep.events, 1, "lượt sau xét tiếp đúng sự kiện chưa xét");
    assert.equal(tiep.timeBudgetHit, undefined);
  });

  // ── NHÀ: luật vẫn chạy ké cảnh báo; job workflows cho nhà bỏ qua, không ghi sổ ──
  assert.equal(alertsCarriesWorkflows(await currentOrganization()), true, "ngữ cảnh mặc định (bộ lập lịch gọi lượt nhà) là nhà ⇒ luật chạy ké cảnh báo");
  const nha = (await runJob(WORKFLOWS_JOB, { trigger: "CRON", actor: "gs-test", org: home.code })) as { skipped?: string };
  assert.equal(nha.skipped, "HOME_USES_ALERTS", "job workflows cho nhà ⇒ bỏ qua có lý do");
  assert.equal((await soLuotWorkflows(home)).length, nhaTruoc, "nhà: không dòng sync_runs workflows nào");

  // ── KHÁCH: lượt cảnh báo (bấm tay) KHÔNG còn chở luật ──
  const canhBao = await withOrganization(A, () => evaluateAlerts());
  assert.equal(canhBao.workflows.separateJob, true, "cảnh báo của khách không chạy luật — luật đi job workflows");
  assert.equal(canhBao.workflows.events, 0);
}

export async function testGSched() {
  kiemNhip();
  const fan = await napFanOut();
  await kiemLich(fan);
  await kiemTuanTu(fan);
  kiemTrienKhai();
  await donDep();
  try {
    await kiemToChucThat(fan);
  } finally {
    await donDep();
    for (const code of ORGS) {
      try {
        rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
      } catch {
        // Windows giữ tệp của PGlite đang mở — lượt chạy sau xoá thư mục ở đầu bài.
      }
    }
  }
  console.log("✓ G-SCHED: luật của tổ chức khách tự chạy — nhịp 10 mặc định / theo gói / < 5 bị từ chối; fan-out tuần tự, một lượt mỗi tổ chức ACTIVE, bỏ SUSPENDED + tạm dừng, lỗi một tổ chức không chặn tổ chức sau; trần thời gian; nhà giữ nguyên; compose bật tầng tự động hoá, tầng toàn bộ vẫn tắt");
}
