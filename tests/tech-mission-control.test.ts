import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  MISSION_CONTROL_STATES,
  REGISTRY_MISSION_STATES,
  REGISTRY_OWNER_ESCALATIONS,
  REGISTRY_STALE_HOURS,
  TECH_REGISTRY_BRANCH,
  classifyDoneEvidence,
  ciFromMergedDetail,
  deliveryLevel,
  manualMissionControlState,
  missionControlState,
  parseMergeSha,
  registryLiveness,
  registryNotifyKey,
  registryNotifyKind,
  registryProject,
  type RegistryEntry,
} from "@/lib/constants/tech-registry";
import { __setGithubFetchForTests } from "@/lib/integrations/github/client";
import { listMissionControl, registryDecisionQueue } from "@/lib/queries/tech-registry";
import { parseListParams } from "@/lib/search-params";
import { gitBlobSha, missionIdFromPath, parseRegistryEvents, parseRegistryMission, parseRegistryMissionText } from "@/lib/tech/registry-parse";
import { REGISTRY_SYNC_STATE_KEY, syncTechRegistry } from "@/lib/tech/registry-sync";
import { DEFAULT_CONFIG, MISSION_STATES, OWNER_ESCALATIONS } from "../scripts/ai-tech";

/**
 * ═══════════ MISSION CONTROL — SỔ TECH ROOM CHIẾU VÀO /tech ═══════════
 *
 * Fixture JSON nằm NGAY TRONG tệp (hình dạng chép từ sổ thật `ai-control/registry` 10/10/2026), không gọi mạng: GitHub
 * được giả bằng `__setGithubFetchForTests`. Mốc thời gian dựng TỪ CHÍNH DỮ LIỆU (AGENTS.md luật 50): "bây giờ" của mọi
 * phép STALE / báo Lark là `last_heartbeat` của fixture cộng một khoảng, không phải đồng hồ máy.
 */

const BASE = Date.parse("2026-10-10T14:32:07.175Z");
const iso = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

function mission(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    mission_id: id,
    title: `Sứ mệnh ${id}`,
    business_goal: "",
    status: "RUNNING",
    priority: "P2",
    risk: "MEDIUM",
    owner: "DESKTOP-56TH98Y:wt-tech-lead-v2",
    worker: null,
    worktree: null,
    branch: `feat/${id}`,
    base_sha: "33f3b13bd9614601e92658e3e5f1cbc5cf6204dc",
    domains: [],
    owned_paths: ["lib/x.ts"],
    dependencies: [],
    blocked_by: [],
    related_prs: [],
    migration_reservations: [],
    created_at: iso(0),
    updated_at: iso(0),
    last_heartbeat: iso(0),
    definition_of_done: [],
    ...over,
  };
}

const MERGE_SHA = "bc5dacbff629688c7b510aba855a916144fd306b";
const PROD_SHA = "8232c50e7d43be6e16ad64c8de5ad6b5b54722ff";

/* ═════════════════ 1 · HÀM THUẦN ═════════════════ */

export function testTechMissionControlPure() {
  // ── 1.1 Từ vựng KHỚP CLI — một nguồn khai, hai nơi đọc ──
  assert.deepEqual([...REGISTRY_MISSION_STATES], [...MISSION_STATES], "trạng thái sổ phải khớp scripts/ai-tech.ts MISSION_STATES");
  assert.deepEqual([...REGISTRY_OWNER_ESCALATIONS], [...OWNER_ESCALATIONS], "lý do gọi chủ shop phải khớp CLI");
  assert.equal(DEFAULT_CONFIG.controlBranch, TECH_REGISTRY_BRANCH, "nhánh sổ phải khớp controlBranch mặc định của CLI");

  // ── 1.2 Đọc dòng sổ ──
  assert.equal(missionIdFromPath("mission.inbox-read-v3.json"), "inbox-read-v3");
  assert.equal(missionIdFromPath("lease.integration-lead.json"), null);
  assert.equal(missionIdFromPath("review.778.json"), null);
  const ok = parseRegistryMission(mission("sec-caddy-ghn-ghtk", { status: "DONE", related_prs: [774, 774], needs_owner: { category: "APPROVAL_REQUIRED", action: "Duyệt xoay token" } }));
  assert.ok(ok.entry, ok.errors.join("; "));
  assert.deepEqual(ok.entry.relatedPrs, [774], "PR trùng gộp một");
  assert.equal(ok.entry.needsOwner?.category, "APPROVAL_REQUIRED");
  assert.equal(parseRegistryMission(mission("x", { status: "DOING" })).entry, null, "trạng thái lạ ⇒ không chiếu, không đoán");
  assert.equal(parseRegistryMission(mission("x", { updated_at: "hôm qua" })).entry, null, "mốc sai dạng ⇒ không chiếu");
  assert.equal(parseRegistryMissionText("{hỏng").entry, null);
  assert.equal(parseRegistryMission(mission("y", { priority: "P9", risk: "??" })).entry?.priority, "P2", "trường phụ lạ ⇒ mặc định, không làm hỏng dòng");

  // ── 1.3 Sự kiện: khoá ổn định, dòng trùng hệt vẫn là hai sự kiện, dòng hỏng bị đếm ──
  const line = JSON.stringify({ at: iso(1), actor: "a", kind: "CLAIM", mission: "m1", detail: "RUNNING" });
  const text = `${line}\n${line}\n{hỏng\n${JSON.stringify({ at: iso(2), actor: "a", kind: "LEASE_ACQUIRED", detail: "x" })}\n`;
  const p1 = parseRegistryEvents(text);
  const p2 = parseRegistryEvents(text);
  assert.equal(p1.events.length, 3);
  assert.equal(p1.invalid, 1);
  assert.notEqual(p1.events[0].lineKey, p1.events[1].lineKey, "hai dòng giống hệt là hai lần xảy ra");
  assert.deepEqual(p1.events.map((e) => e.lineKey), p2.events.map((e) => e.lineKey), "đọc lại ra cùng khoá ⇒ ghi idempotent");
  assert.equal(p1.events[2].missionId, "", "sự kiện không gắn sứ mệnh ⇒ ''");

  // ── 1.4 SHA blob đúng cách git tính (`printf 'hello\n' | git hash-object --stdin`) ──
  assert.equal(gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");

  // ── 1.5 PHÂN LOẠI BẰNG CHỨNG — bảo thủ: không chắc ⇒ KHÔNG phải PRODUCT_VERIFIED ──
  const verified = [
    "production 7af2bca4 · HSLC: Chưa đọc 179→2.433 (AI trả lời không xoá chưa đọc)",
    "production 6487e652 · HSLC /ai/sales-chatbot: ô «Đang chạy» + một nút «Mở hộp thư»",
    "saas-acceptance --apply --prep --e2e --e2e-ops PASS 8/8 trên production 6487e652 (run 38035198098)",
    "production c71833950519 · verify ĐẠT; nghiệm thu production saas-acceptance --apply PASS 4/4",
    "ops-signals-check chạy trên production PASS 9 tổ chức × 8 tín hiệu",
    "ops inbox-read-audit PASS 0 hội thoại lệch",
    "production 6487e652 · /ai/sales-chatbot ở 390 px: scrollWidth 382 (trước 622)",
    "production e21f0ec35b25 · deploy xanh · mở HSLC hộp thư đơn #EAE49464: panel đủ SKU",
  ];
  for (const t of verified) assert.equal(classifyDoneEvidence(t).kind, "PRODUCT_VERIFIED", t);
  const deployOnly = [
    "production 863aa76aa318 · deploy 37980394777 xanh · verify ĐẠT",
    "PR #613 gộp a656a820; deploy 37493421549 thành công; verify ĐẠT",
    "fbef46ca lên production 07/10 17:06Z (run 37654798771), hậu kiểm ĐẠT: health · migration 233 · /login 200",
    // verify --record chỉ chứng minh health / phiên bản — chủ shop chốt 10/10: tối đa DEPLOYED.
    "gộp vào main; deploy 37735795033 (36b7791b) success; verify PASS 36b7791b",
    // Có PASS nhưng tự nói còn phần CHƯA ĐO ĐƯỢC ⇒ không phải đã kiểm.
    "production 50293da6ee8a · verify ĐẠT; saas-acceptance --apply --drills PASS 5/5: ĐÃ DIỄN TẬP O1,O6 · CHƯA ĐO ĐƯỢC O2,O3",
    // Nói tới HSLC nhưng không phải số đo trên trang.
    "production c71833950519 · verify ĐẠT; HSLC đã chuyển khoá nền tảng (credit 300 USD)",
    // Ops GHI dữ liệu, không phải ops KIỂM.
    "production 2fe12901 · verify ĐẠT; ops ban-hang-reply-upgrade chạy thử 37943324849 rồi --apply 37943578053: thêm ai_sales:reply cho 2 tổ chức",
  ];
  for (const t of deployOnly) assert.equal(classifyDoneEvidence(t).kind, "DEPLOY_ONLY", t);
  assert.equal(classifyDoneEvidence("không đổi mã chạy · #773 gộp 7935fbd4").kind, "NO_RUNTIME");
  assert.equal(classifyDoneEvidence("").kind, "MISSING");
  assert.equal(classifyDoneEvidence(undefined).kind, "MISSING");
  assert.equal(classifyDoneEvidence("Hướng dẫn Meta App Review cho chủ shop").kind, "UNRECOGNIZED");

  // ── 1.6 TRẠNG THÁI CHỦ SHOP ──
  const st = (over: Record<string, unknown>) => missionControlState(parseRegistryMission(mission("m", over)).entry as RegistryEntry);
  const expected: Record<string, string> = {
    BACKLOG: "QUEUED",
    PLANNING: "QUEUED",
    READY: "QUEUED",
    RUNNING: "RUNNING",
    BLOCKED: "BLOCKED",
    PR_READY: "RUNNING",
    INTEGRATING: "RUNNING",
    DEPLOYING: "RUNNING",
    VERIFYING: "RUNNING",
    DONE: "DONE_UNVERIFIED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
  };
  for (const s of REGISTRY_MISSION_STATES) assert.equal(st({ status: s }).state, expected[s], `sổ ${s}`);
  assert.equal(st({ status: "INTEGRATING" }).phase, "INTEGRATING", "RUNNING mang pha con");
  assert.equal(st({ status: "DONE" }).evidence?.kind, "MISSING", "DONE không bằng chứng ⇒ «Thiếu bằng chứng», KHÔNG xong");
  assert.equal(st({ status: "DONE", evidence: { merged: `#774 → ${MERGE_SHA}`, verify: `PASS ${PROD_SHA} ${iso(5)}` } }).state, "DONE_UNVERIFIED", "verify PASS chỉ là DEPLOYED");
  assert.equal(st({ status: "DONE", evidence: { done: verified[0] } }).state, "COMPLETED");
  assert.equal(st({ status: "BLOCKED", title: "QUYẾT ĐỊNH CHỦ SHOP: chọn nhà cung cấp email" }).state, "WAITING_APPROVAL");
  assert.equal(st({ status: "BLOCKED", branch: "decision/owner-x" }).state, "WAITING_APPROVAL");
  assert.equal(st({ status: "RUNNING", needs_owner: { category: "CREDENTIAL_REQUIRED", action: "Cấp khoá API" } }).state, "WAITING_APPROVAL", "needs_owner thắng trạng thái sổ");
  assert.equal(st({ status: "DONE", needs_owner: { category: "APPROVAL_REQUIRED", action: "x" } }).state, "DONE_UNVERIFIED", "đã khép thì không còn chờ");
  assert.equal(st({ status: "BLOCKED", title: "Chờ PR khác gộp" }).state, "BLOCKED", "bị chặn thường KHÔNG phải việc của chủ shop");
  assert.ok(MISSION_CONTROL_STATES.includes("DONE_UNVERIFIED"));
  assert.equal(manualMissionControlState("DONE", "COMPLETE", "đóng sứ mệnh vì xong"), "DONE_UNVERIFIED", "sứ mệnh tay cũng qua cùng luật bằng chứng");
  assert.equal(manualMissionControlState("ACTIVE", "NEEDS_OWNER", ""), "WAITING_APPROVAL");

  // ── 1.7 MỨC GIAO HÀNG ──
  assert.equal(deliveryLevel({ evidence: null }), "NONE");
  assert.equal(deliveryLevel({ evidence: { merged: `#774 → ${MERGE_SHA}` } }), "CODE_DONE");
  assert.equal(deliveryLevel({ evidence: null, mergedEventSeen: true }), "CODE_DONE");
  assert.equal(deliveryLevel({ evidence: { merged: "x", verify: `PASS ${PROD_SHA}` } }), "DEPLOYED");
  assert.equal(deliveryLevel({ evidence: { merged: "x" }, deployCheck: "CONTAINED" }), "DEPLOYED");
  assert.equal(deliveryLevel({ evidence: { merged: "x" }, deployCheck: "NOT_CONTAINED" }), "CODE_DONE");
  assert.equal(deliveryLevel({ evidence: { verify: "FAIL x" } }), "NONE", "verify FAIL không phải đã lên");
  assert.equal(deliveryLevel({ evidence: { done: verified[2] } }), "PRODUCT_VERIFIED");
  assert.equal(parseMergeSha(`#774 → ${MERGE_SHA}`), MERGE_SHA);
  assert.equal(parseMergeSha("#773 @ 8a407bec06df → 7935fbd4e4b3"), null, "SHA ngắn không đủ để hỏi GitHub chắc chắn");
  assert.equal(ciFromMergedDetail("#773 @ 8a407bec06df → 7935fbd4e4b3 (MERGE_NOW · LOW · gates success)"), "SUCCESS");
  assert.equal(ciFromMergedDetail("#1 gộp"), "", "không có chữ gates ⇒ CHƯA BIẾT");

  // ── 1.8 STALE — đồng hồ dựng từ dữ liệu ──
  const hb = new Date(iso(0));
  const sau = (h: number) => new Date(hb.getTime() + h * 3_600_000);
  assert.equal(registryLiveness("RUNNING", hb, sau(REGISTRY_STALE_HOURS - 0.1)), "FRESH");
  assert.equal(registryLiveness("RUNNING", hb, sau(REGISTRY_STALE_HOURS + 0.1)), "STALE");
  assert.equal(registryLiveness("RUNNING", null, sau(1)), "UNKNOWN", "không có nhịp ⇒ UNKNOWN, không phải đứng im hay đang làm");
  assert.equal(registryLiveness("QUEUED", hb, sau(100)), null, "STALE chỉ có nghĩa với đang chạy");

  // ── 1.9 Ai đáng một tin Lark ──
  assert.equal(registryNotifyKind("COMPLETED", "P1", "LOW"), "COMPLETED");
  assert.equal(registryNotifyKind("COMPLETED", "P2", "HIGH"), "COMPLETED");
  assert.equal(registryNotifyKind("COMPLETED", "P2", "MEDIUM"), null);
  assert.equal(registryNotifyKind("DONE_UNVERIFIED", "P0", "CRITICAL"), null, "báo «xong» cho thứ chưa kiểm production là nói dối");
  assert.equal(registryNotifyKind("WAITING_APPROVAL", "P3", "LOW"), "WAITING_APPROVAL");
  assert.notEqual(registryNotifyKey("WAITING_APPROVAL", sau(1)), registryNotifyKey("WAITING_APPROVAL", sau(2)), "vào lại trạng thái là một lần chuyển mới");

  // ── 1.10 Dự án suy từ tiền tố ──
  assert.equal(registryProject("saas-l3-inbox"), "saas");
  assert.equal(registryProject("inbox-read-v3"), "chotdon");
  assert.equal(registryProject("owner-email-provider", "QUYẾT ĐỊNH CHỦ SHOP: chọn email"), "owner");
  assert.equal(registryProject("owner-requirements-ledger", "Sổ yêu cầu chủ shop"), "tech");
  assert.equal(registryProject("vtp-edit-cod-prefill"), "erp");
}

/* ═════════════════ 2 · QUÉT MÃ NGUỒN — ERP KHÔNG GHI VÀO SỔ ═════════════════ */

export function testTechMissionControlSourceGuards() {
  const goc = path.resolve(__dirname, "..");
  const boChuThich = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const files = ["lib/tech/registry-sync.ts", "lib/tech/registry-parse.ts", "lib/queries/tech-registry.ts", "lib/constants/tech-registry.ts"];
  const walk = (d: string): string[] =>
    readdirSync(path.join(goc, d)).flatMap((f) => {
      const rel = `${d}/${f}`;
      return statSync(path.join(goc, rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(f) ? [rel] : [];
    });
  files.push(...walk("app/(dashboard)/tech/missions"));
  for (const f of files) {
    const src = boChuThich(readFileSync(path.join(goc, f), "utf8"));
    for (const cam of ['method: "POST"', 'method: "PUT"', 'method: "PATCH"', 'method: "DELETE"', "git push", "child_process", "execFile", "spawn(", "scripts/ai-tech", "readRegistryWrite"]) {
      assert.ok(!src.includes(cam), `${f}: phép chiếu sổ CHỈ ĐỌC — tìm thấy \`${cam}\``);
    }
  }
  // Đường đọc GitHub của sổ chỉ là GET (cả tệp client đã bị `tech-phase2a` khoá; đây khoá riêng ba hàm mới).
  const client = boChuThich(readFileSync(path.join(goc, "lib/integrations/github/client.ts"), "utf8"));
  for (const fn of ["readBranchHead", "readTreeAt", "readRawFile"]) assert.ok(client.includes(`export async function ${fn}`), `thiếu ${fn}`);
  assert.ok(!/ai-control\/registry[^\n]*method/.test(client));
}

/* ═════════════════ 3 · CSDL — PHÉP CHIẾU IDEMPOTENT · INBOX · LARK ═════════════════ */

type FakeRepo = { commit: string; files: Record<string, string>; contained: Set<string> };

function fakeRegistry(repo: FakeRepo) {
  const calls = { head: 0, head304: 0, tree: 0, raw: 0, compare: 0 };
  __setGithubFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(init?.method ?? "GET", "GET", "phép chiếu sổ chỉ được GET");
    if (u.includes("/commits/ai-control/registry")) {
      calls.head += 1;
      const etag = `"${repo.commit}"`;
      if (headers["If-None-Match"] === etag) {
        calls.head304 += 1;
        return new Response(null, { status: 304 });
      }
      return new Response(repo.commit, { status: 200, headers: { etag } });
    }
    const tree = /\/git\/trees\/([0-9a-f]{40})$/.exec(u);
    if (tree) {
      calls.tree += 1;
      assert.equal(tree[1], repo.commit);
      return new Response(JSON.stringify({ sha: repo.commit, truncated: false, tree: Object.entries(repo.files).map(([p, c]) => ({ path: p, type: "blob", sha: gitBlobSha(c), size: c.length })) }), { status: 200 });
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/owner\/repo\/([0-9a-f]{40})\/(.+)$/.exec(u);
    if (raw) {
      calls.raw += 1;
      assert.equal(raw[1], repo.commit, "tải tệp theo SHA COMMIT, không theo tên nhánh");
      const c = repo.files[raw[2]];
      return c === undefined ? new Response("404", { status: 404 }) : new Response(c, { status: 200 });
    }
    const cmp = /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(u);
    if (cmp) {
      calls.compare += 1;
      return new Response(JSON.stringify({ status: repo.contained.has(cmp[1]) ? "ahead" : "behind" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  return calls;
}

const files = (missions: Record<string, unknown>[], events: Record<string, unknown>[]) => {
  const out: Record<string, string> = { "README.md": "# sổ\n", "lease.integration-lead.json": "{}\n", "review.778.json": "{}\n" };
  for (const m of missions) out[`mission.${String(m.mission_id)}.json`] = `${JSON.stringify(m, null, 2)}\n`;
  out["events.ndjson"] = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return out;
};
const commit = (n: number) => n.toString(16).padStart(40, "a");

export async function testTechMissionControlDb() {
  const db = await getDb();
  const m = schema.techRegistryMissions;
  const env0 = { repo: process.env.ERP_GITHUB_REPO, commit: process.env.ERP_COMMIT };
  const clean = async () => {
    await db.delete(schema.techRegistryMissions);
    await db.delete(schema.techRegistryEvents);
    await db.delete(schema.syncState).where(eq(schema.syncState.key, REGISTRY_SYNC_STATE_KEY));
  };
  await clean();
  process.env.ERP_GITHUB_REPO = "owner/repo";
  delete process.env.ERP_COMMIT;

  const sent: { title: string; lines: { text: string; href?: string }[][] }[] = [];
  let sendOk = true;
  const lark = {
    target: async () => ({ url: "https://lark.invalid/hook", secret: "" }),
    appUrl: "https://erp.test",
    send: async (_u: string, _s: string, title: string, lines: { text: string; href?: string }[][]) => {
      if (!sendOk) return { ok: false, error: "Lark từ chối https://lark.invalid/hook?token=bi-mat" };
      sent.push({ title, lines });
      return { ok: true };
    },
  };

  const evs = [
    { at: iso(0), actor: "lead", kind: "CLAIM", mission: "mc-running", detail: "RUNNING · 1 mẫu phạm vi · MEDIUM" },
    { at: iso(1), actor: "lead", kind: "MERGED", mission: "mc-done-p0", detail: `#701 @ abc → def (MERGE_NOW · LOW · gates success)` },
    { at: iso(2), actor: "lead", kind: "LEASE_ACQUIRED", detail: "integration-lead" },
  ];
  const v1 = [
    mission("mc-running", { last_heartbeat: iso(0) }),
    mission("mc-done-p0", { status: "DONE", priority: "P0", risk: "HIGH", related_prs: [701], evidence: { merged: `#701 → ${MERGE_SHA}`, done: "production x · HSLC: Chưa đọc 179→2.433" } }),
    mission("owner-email-provider", { status: "BLOCKED", title: "QUYẾT ĐỊNH CHỦ SHOP: chọn nhà cung cấp email", branch: "decision/owner-email-provider" }),
    mission("mc-deploy-only", { status: "DONE", priority: "P1", evidence: { merged: `#702 → ${"c".repeat(40)}`, verify: `PASS ${PROD_SHA} ${iso(3)}`, done: "production 8232c50e · deploy xanh · verify ĐẠT" } }),
    mission("mc-blocked", { status: "BLOCKED", title: "Chờ #706 gộp" }),
  ];
  const repo: FakeRepo = { commit: commit(1), files: files(v1, evs), contained: new Set([MERGE_SHA]) };
  const calls = fakeRegistry(repo);
  const t0 = new Date(BASE + 10 * 60_000);

  try {
    // ── 3.1 Lần đọc ĐẦU: chiếu đủ, KHÔNG báo Lark hàng loạt ──
    const r1 = await syncTechRegistry({ now: t0, lark, deployBudget: 5 });
    assert.equal(r1.skippedReason, null, String(r1.skippedReason));
    assert.equal(r1.initial, true);
    assert.equal(r1.missionFiles, 5);
    assert.equal(r1.inserted, 5);
    assert.equal(r1.eventsInserted, 3);
    assert.equal(sent.length, 0, "lần đọc đầu KHÔNG gửi tin");
    assert.ok(r1.notify.baselined >= 2, "lần đọc đầu chỉ ghi mốc cho mục đáng báo (owner decision + P0 xong)");
    const rows1 = await db.select().from(m);
    assert.equal(rows1.length, 5);
    const byId = new Map(rows1.map((r) => [r.registryId, r]));
    assert.equal(byId.get("mc-done-p0")?.controlState, "COMPLETED");
    assert.equal(byId.get("mc-deploy-only")?.controlState, "DONE_UNVERIFIED", "verify PASS + deploy xanh ⇒ DONE (chưa kiểm production)");
    assert.equal(byId.get("owner-email-provider")?.controlState, "WAITING_APPROVAL");
    assert.equal(byId.get("mc-blocked")?.controlState, "BLOCKED");
    // Không biết commit production ⇒ không hỏi GitHub, không đoán.
    assert.equal(calls.compare, 0);
    assert.equal(byId.get("mc-done-p0")?.deployCheck, "");

    // ── 3.2 Đọc lại khi sổ KHÔNG đổi: một lượt 304, không tải gì, không nhân đôi ──
    const rawTruoc = calls.raw;
    const r2 = await syncTechRegistry({ now: new Date(t0.getTime() + 60_000), lark, deployBudget: 5 });
    assert.equal(r2.unchanged, true);
    assert.equal(calls.head304, 1, "sổ không đổi ⇒ hỏi bằng ETag, nhận 304");
    assert.equal(calls.raw, rawTruoc, "không tải lại tệp nào");
    assert.equal((await db.select().from(m)).length, 5);
    assert.equal((await db.select().from(schema.techRegistryEvents)).length, 3, "sự kiện không nhân đôi");

    // ── 3.3 Sổ đổi: một sứ mệnh xong (P1) đã kiểm production, một quyết định mới, một sứ mệnh biến mất ──
    const v2 = [
      mission("mc-running", { status: "DONE", priority: "P1", updated_at: iso(30), evidence: { merged: `#703 → ${"d".repeat(40)}`, done: "saas-acceptance --apply PASS 4/4 trên production" } }),
      v1[1],
      v1[2],
      v1[3],
      mission("owner-rotate-ghn-ghtk", { status: "BLOCKED", title: "QUYẾT ĐỊNH CHỦ SHOP: duyệt xoay token webhook GHN/GHTK", created_at: iso(31), updated_at: iso(31), last_heartbeat: iso(31) }),
      mission("mc-needs-owner", { status: "RUNNING", needs_owner: { category: "CREDENTIAL_REQUIRED", action: "Cấp khoá Zalo ZNS ở /platform" } }),
      mission("mc-stale", { status: "INTEGRATING", last_heartbeat: iso(0), updated_at: iso(0) }),
    ];
    repo.commit = commit(2);
    repo.files = files(v2, [...evs, { at: iso(30), actor: "lead", kind: "DONE", mission: "mc-running", detail: "xong" }]);
    process.env.ERP_COMMIT = PROD_SHA;
    const t3 = new Date(BASE + 40 * 60_000);
    const r3 = await syncTechRegistry({ now: t3, lark, deployBudget: 5 });
    assert.equal(r3.initial, false);
    assert.equal(r3.inserted, 3);
    assert.equal(r3.updated, 1, "chỉ tải lại tệp đổi SHA");
    assert.equal(r3.removed, 1, "mc-blocked biến khỏi sổ ⇒ đánh dấu");
    assert.equal(r3.eventsInserted, 1, "chỉ dòng sự kiện mới được thêm");
    const gone = await db.query.techRegistryMissions.findFirst({ where: eq(m.registryId, "mc-blocked") });
    assert.ok(gone && !gone.inRegistry && gone.removedAt, "không xoá lịch sử, chỉ đánh dấu");
    assert.equal(sent.length, 1, "MỘT tin cho cả lượt");
    const text = JSON.stringify(sent[0].lines);
    assert.ok(text.includes("mc-running"), "P1 vừa xong đã kiểm production ⇒ báo");
    assert.ok(text.includes("duyệt xoay token"), "quyết định mới ⇒ báo");
    assert.ok(text.includes("Cấp khoá Zalo ZNS"), "needs_owner ⇒ báo");
    assert.ok(!text.includes("mc-deploy-only") && !text.includes("mc-done-p0"), "không báo lại thứ đã có từ lần đầu");
    assert.equal(r3.notify.sent, 3);
    // Deploy: commit gộp đủ 40 ký tự ⇒ ERP hỏi GitHub; chứa ⇒ CONTAINED.
    const p0 = await db.query.techRegistryMissions.findFirst({ where: eq(m.registryId, "mc-done-p0") });
    assert.equal(p0?.deployCheck, "CONTAINED");
    assert.equal(p0?.deployCheckedCommit, PROD_SHA);
    const dOnly = await db.query.techRegistryMissions.findFirst({ where: eq(m.registryId, "mc-deploy-only") });
    assert.equal(dOnly?.deployCheck, "NOT_CONTAINED");

    // ── 3.4 Đọc lại (kể cả bỏ ETag): KHÔNG báo lại, KHÔNG hỏi lại deploy đã chứa ──
    const cmpTruoc = calls.compare;
    const r4 = await syncTechRegistry({ now: new Date(t3.getTime() + 60_000), lark, force: true, deployBudget: 5 });
    assert.equal(r4.notify.sent, 0);
    assert.equal(sent.length, 1, "mỗi lần chuyển trạng thái đúng MỘT tin");
    assert.equal(calls.compare, cmpTruoc, "đã hỏi với cùng commit production ⇒ không hỏi lại");

    // ── 3.5 Gửi HỎNG ⇒ trả khoá, lượt sau gửi lại; câu lỗi đã che URL ──
    repo.commit = commit(3);
    repo.files = files([...v2, mission("owner-backup-drive-full", { status: "BLOCKED", title: "QUYẾT ĐỊNH CHỦ SHOP: Google Drive sao lưu đầy" })], evs);
    sendOk = false;
    const r5 = await syncTechRegistry({ now: new Date(t3.getTime() + 120_000), lark, deployBudget: 0 });
    assert.ok(r5.notify.error && !r5.notify.error.includes("bi-mat") && r5.notify.error.includes("[url]"), "câu lỗi không mang URL / token");
    const chua = await db.query.techRegistryMissions.findFirst({ where: eq(m.registryId, "owner-backup-drive-full") });
    assert.equal(chua?.notifiedKey, "", "gửi hỏng không được ghi «đã báo»");
    sendOk = true;
    const r6 = await syncTechRegistry({ now: new Date(t3.getTime() + 180_000), lark, deployBudget: 0 });
    assert.equal(r6.notify.sent, 1, "lượt sau gửi lại đúng mục đó");
    assert.equal(sent.length, 2);

    // ── 3.6 Thay đổi HÀNG LOẠT (> trần) ⇒ chỉ ghi mốc, không một tràng tin ──
    const many = Array.from({ length: 11 }, (_, i) => mission(`owner-bulk-${i}`, { status: "BLOCKED", title: `QUYẾT ĐỊNH CHỦ SHOP: mục ${i}` }));
    repo.commit = commit(4);
    repo.files = files([...v2, ...many], evs);
    const r7 = await syncTechRegistry({ now: new Date(t3.getTime() + 240_000), lark, deployBudget: 0 });
    assert.equal(r7.notify.sent, 0);
    assert.ok(r7.notify.skipped?.includes("hàng loạt"), String(r7.notify.skipped));
    assert.equal(sent.length, 2);

    // ── 3.7 DECISION INBOX gom đúng: quyết định khai báo + needs_owner; KHÔNG gồm BLOCKED thường / DONE ──
    const inbox = await registryDecisionQueue();
    const ids = inbox.map((d) => d.registryId);
    for (const id of ["owner-email-provider", "owner-rotate-ghn-ghtk", "mc-needs-owner"]) assert.ok(ids.includes(id), `inbox thiếu ${id}`);
    assert.ok(!ids.includes("mc-blocked") && !ids.includes("mc-done-p0"));
    const email = inbox.find((d) => d.registryId === "owner-email-provider");
    assert.equal(email?.question, "chọn nhà cung cấp email", "câu hỏi bỏ tiền tố, đứng đầu thẻ");
    assert.equal(inbox.find((d) => d.registryId === "mc-needs-owner")?.question, "Cấp khoá Zalo ZNS ở /platform");

    // ── 3.8 Danh sách Mission Control: lọc trạng thái + STALE theo đồng hồ dựng từ dữ liệu ──
    const params = (q: Record<string, string>) => parseListParams(q, { defaultSort: "updatedAt", filterKeys: ["state", "project", "owner", "priority", "source"], sortable: ["updatedAt", "priority", "code", "state"] });
    const waiting = await listMissionControl(params({ state: "WAITING_APPROVAL" }), t3);
    assert.ok(waiting.rows.every((r) => r.state === "WAITING_APPROVAL") && waiting.total >= 3);
    const done = await listMissionControl(params({ state: "COMPLETED", source: "REGISTRY" }), t3);
    assert.deepEqual(done.rows.map((r) => r.code).sort(), ["mc-done-p0", "mc-running"], "chỉ DONE có bằng chứng sản phẩm mới là xong");
    // «Bây giờ» = nhịp tim cuối của chính fixture + (ngưỡng ± 1 giờ) — không đọc đồng hồ máy.
    const hbStale = new Date(iso(0));
    const truoc = await listMissionControl(params({ state: "STALE" }), new Date(hbStale.getTime() + (REGISTRY_STALE_HOURS - 1) * 3_600_000));
    assert.equal(truoc.total, 0, "chưa quá ngưỡng ⇒ không đứng im");
    const sauNguong = await listMissionControl(params({ state: "STALE" }), new Date(hbStale.getTime() + (REGISTRY_STALE_HOURS + 1) * 3_600_000));
    assert.deepEqual(sauNguong.rows.map((r) => r.code), ["mc-stale"], "chỉ sứ mệnh ĐANG CHẠY quá ngưỡng mới đứng im — mục chờ chủ shop thì không");
    assert.equal(sauNguong.rows[0].phase, "INTEGRATING", "đang chạy kèm pha con");
    const p0row = (await listMissionControl(params({ q: "mc-done-p0" }), t3)).rows[0];
    assert.equal(p0row.ci, "SUCCESS", "CI đọc từ sự kiện MERGED khi chưa có phép chiếu PR");
    assert.equal(p0row.delivery, "PRODUCT_VERIFIED");
  } finally {
    __setGithubFetchForTests(null);
    if (env0.repo === undefined) delete process.env.ERP_GITHUB_REPO;
    else process.env.ERP_GITHUB_REPO = env0.repo;
    if (env0.commit === undefined) delete process.env.ERP_COMMIT;
    else process.env.ERP_COMMIT = env0.commit;
    await clean();
  }
}
