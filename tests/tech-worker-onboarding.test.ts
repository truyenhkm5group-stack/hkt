import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, like, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb, schema } from "@/db";
import { POST as enrollPOST } from "@/app/api/tech/worker/enroll/route";
import { TECH_CAPABILITIES } from "@/lib/constants/tech-capabilities";
import {
  DIAGNOSTICS_MAX_BYTES,
  DOGFOOD_WORKER_DEFAULTS,
  ENROLLMENT_CODE_PATTERN,
  ENROLLMENT_TTL_MINUTES,
  TECH_REPAIR_COMMANDS,
  WORKER_EXIT,
  enrollmentUsable,
  isTechRepairCommand,
  onboardingProgress,
  PUSH_TOKENS_PER_RUN,
  parseClaudeAuthStatus,
  redactSecrets,
  sanitizeWorkerDiagnostics,
  workerReadiness,
  workerStartupBlockers,
  type OnboardingInput,
  type WorkerDiagnostics,
} from "@/lib/constants/tech-worker-onboarding";
import { API_BILLING_ENV, TECH_LEASE, buildChildEnv, claimablePolicyLevels, workerPolicyCeiling } from "@/lib/constants/tech-worker";
import { __setAgentGithubFetchForTests } from "@/lib/integrations/github/agent-identity";
import { createTechTask, setTechTaskStatus, type TechActor } from "@/lib/tech/service";
import { INSTALLER_PS_MARKER, buildWorkerInstaller, buildWorkerLauncher, buildWorkerUninstaller, validateInstallerInput } from "@/lib/tech/worker-installer";
import {
  createWorkerEnrollment,
  issueWorkerPushToken,
  recordWorkerDiagnostics,
  redeemWorkerEnrollment,
  removeTechWorker,
  requestWorkerRepair,
  rotateWorkerSecret,
  takeWorkerRepair,
} from "@/lib/tech/worker-onboarding";
import { authenticateTechWorker, claimNextTechTask, registerTechWorker, setTechWorkerEnabled } from "@/lib/tech/worker-service";
import { PUSH_URL_PATTERN, buildPushArgs, parseWorktreeList, pruneCandidates, pruneWorkerWorktrees, pushConfigViolations, pushEnv, pushSandbox, safePush } from "../scripts/tech-worker/git-safety";

/**
 * ═══════════ CÀI WORKER MỘT NÚT (docs/tech-control-plane/README.md mục 15) ═══════════
 *
 * Khoá năm điều:
 *  1. Mã ghi danh dùng MỘT lần, hết hạn ⇒ từ chối, mã của worker này không đụng worker kia, mã chỉ đọc từ THÂN request.
 *  2. Đổi mã ⇒ khoá worker XOAY: khoá cũ (kể cả khoá đã lộ) chết ngay; tạo lại token / gỡ worker cũng vậy.
 *  3. Bộ cài sinh ra KHÔNG chứa khoá worker, không chứa ANTHROPIC_API_KEY, không ghi `.env`; cất khoá bằng DPAPI.
 *  4. Worker gói thuê bao từ chối chạy khi có ANTHROPIC_API_KEY; báo cáo chẩn đoán có trần và che chuỗi giống secret;
 *     lệnh sửa chỉ từ danh sách đóng.
 *  5. Migration 0231 thu hồi khoá `dogfood-1` đúng điều kiện và chạy lại không đổi gì.
 * Không phụ thuộc máy Windows / biến môi trường thật (AGENTS.md mục 65): PowerShell kiểm bằng phân tích tĩnh trên chuỗi
 * do hàm thuần sinh ra; biến môi trường của danh tính bot được đặt rồi TRẢ LẠI nguyên trạng. Đồng hồ: `now` thật (mục 50).
 */

const goc = path.resolve(__dirname, "..");
const src = (f: string) => readFileSync(path.join(goc, f), "utf8");
/** Bỏ chú thích để quét MÃ, không quét lời hứa trong chú thích. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CODE_MAU = `twe_${"Ab9_-".repeat(9)}`;
const MAU_INSTALLER = {
  origin: "https://erp.vnxcommerce.com",
  workerKey: "dogfood-1",
  provider: "SUBSCRIPTION_CLAUDE_CODE" as const,
  enrollmentCode: CODE_MAU,
  repoUrl: "https://github.com/truyenhkm5group-stack/hkt.git",
  expiresAt: new Date(),
};

function diagMau(over: Partial<WorkerDiagnostics> = {}): WorkerDiagnostics {
  return {
    checkedAt: new Date().toISOString(),
    workerVersion: "tech-worker/1",
    platform: "win32-10",
    nodeVersion: "v22.0.0",
    gitVersion: "git version 2.45",
    claudeVersion: "2.1.278",
    claudeAuth: "LOGGED_IN_SUBSCRIPTION",
    repo: { ok: true, head: "a".repeat(40), detail: "origin/main" },
    adapter: { ok: true, detail: "" },
    apiKeyAbsent: true,
    pushMode: "SERVER_TOKEN",
    installMode: true,
    lastError: "",
    ...over,
  };
}

/* ═════════════════════ 1. HÀM THUẦN ═════════════════════ */

export function testTechWorkerOnboardingPure() {
  const now = new Date();

  // 1.1 Mã ghi danh: hình dạng đóng, dùng một lần, có hạn.
  assert.match(CODE_MAU, ENROLLMENT_CODE_PATTERN);
  assert.doesNotMatch("twe_ngan", ENROLLMENT_CODE_PATTERN);
  assert.doesNotMatch(`tw_abcdefgh.${"x".repeat(32)}`, ENROLLMENT_CODE_PATTERN, "khoá worker không phải mã ghi danh");
  const conHan = new Date(now.getTime() + 60_000);
  assert.equal(enrollmentUsable({ usedAt: null, revokedAt: null, expiresAt: conHan }, now), true);
  assert.equal(enrollmentUsable({ usedAt: now, revokedAt: null, expiresAt: conHan }, now), false, "đã dùng ⇒ hết");
  assert.equal(enrollmentUsable({ usedAt: null, revokedAt: now, expiresAt: conHan }, now), false, "đã thu hồi ⇒ hết");
  assert.equal(enrollmentUsable({ usedAt: null, revokedAt: null, expiresAt: now }, now), false, "đúng mốc hết hạn là hết");
  assert.ok(ENROLLMENT_TTL_MINUTES > 0 && ENROLLMENT_TTL_MINUTES <= 60, "mã ghi danh phải sống NGẮN");

  // 1.2 Ranh giới thanh toán lúc khởi động: gói thuê bao + ANTHROPIC_API_KEY ⇒ từ chối chạy.
  assert.equal(workerStartupBlockers("SUBSCRIPTION_CLAUDE_CODE", {}).length, 0);
  for (const k of API_BILLING_ENV) {
    assert.equal(workerStartupBlockers("SUBSCRIPTION_CLAUDE_CODE", { [k]: "gia-tri-bat-ky" }).length, 1, `${k} có mặt ⇒ worker gói thuê bao từ chối chạy`);
  }
  assert.equal(workerStartupBlockers("SUBSCRIPTION_CLAUDE_CODE", { ANTHROPIC_API_KEY: "" }).length, 0, "biến rỗng không tính tiền được");
  assert.equal(workerStartupBlockers("ANTHROPIC_API", { ANTHROPIC_API_KEY: "x" }).length, 0, "đường API dùng khoá riêng — không phải việc của lá chắn này");
  assert.ok(!("ANTHROPIC_API_KEY" in buildChildEnv("SUBSCRIPTION_CLAUDE_CODE", { ANTHROPIC_API_KEY: "x", PATH: "/bin" }, null)), "tiến trình con gói thuê bao không bao giờ thấy khoá API");

  // 1.3 Trạng thái đăng nhập Claude — chỉ loggedIn + authMethod; Console = tiền API.
  assert.equal(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c" })), "LOGGED_IN_SUBSCRIPTION");
  assert.equal(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "console" })), "LOGGED_IN_API");
  assert.equal(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false })), "NOT_LOGGED_IN");
  assert.equal(parseClaudeAuthStatus("không phải json"), "UNKNOWN");
  assert.equal(parseClaudeAuthStatus("{}"), "UNKNOWN");

  // 1.4 Sẵn sàng xin việc: gói thuê bao đăng nhập Console / chưa rõ / có biến API ⇒ KHÔNG xin việc.
  assert.equal(workerReadiness("SUBSCRIPTION_CLAUDE_CODE", diagMau()).ready, true);
  for (const auth of ["LOGGED_IN_API", "NOT_LOGGED_IN", "UNKNOWN"] as const) {
    assert.equal(workerReadiness("SUBSCRIPTION_CLAUDE_CODE", diagMau({ claudeAuth: auth })).ready, false, `${auth} ⇒ gói thuê bao không xin việc`);
  }
  assert.equal(workerReadiness("SUBSCRIPTION_CLAUDE_CODE", diagMau({ apiKeyAbsent: false })).ready, false);
  assert.equal(workerReadiness("ANTHROPIC_API", diagMau({ claudeAuth: "UNKNOWN" })).ready, true, "đường API không cần đăng nhập Claude");
  assert.equal(workerReadiness("ANTHROPIC_API", diagMau({ repo: { ok: false, head: "", detail: "x" } })).ready, false);

  // 1.5 Báo cáo chẩn đoán: chỉ trường đã khai, che chuỗi giống secret, có trần.
  assert.equal(sanitizeWorkerDiagnostics(null), null);
  assert.equal(sanitizeWorkerDiagnostics([1, 2]), null);
  const bi = [
    `tw_${"a1b2c3d4"}.${"s".repeat(32)}`,
    CODE_MAU,
    "sk-ant-api03-abcdefghijklmnop",
    "ghs_abcdefghijklmnopqrstuvwx1234",
    "github_pat_11ABCDEFGHIJKLMNOPQRSTUV",
    "Bearer eyJhbGciOiJSUzI1NiJ9",
    "ANTHROPIC_API_KEY=xyz-123",
    "https://x-access-token:ghs_secret@github.com/a/b.git",
  ];
  const d = sanitizeWorkerDiagnostics({ ...diagMau(), lastError: bi.join(" | "), adapter: { ok: false, detail: bi[0] }, email: "chu@shop.vn", token: "tw_x.y", repo: { ok: true, head: "khong-phai-sha", detail: "" } })!;
  for (const b of bi) assert.ok(!JSON.stringify(d).includes(b), `chuỗi giống secret phải bị che: ${b.slice(0, 12)}…`);
  assert.ok(!("email" in d) && !("token" in d), "trường lạ bị bỏ");
  assert.equal(d.repo.head, "", "head không phải sha ⇒ bỏ");
  assert.equal(redactSecrets("bình thường không có gì"), "bình thường không có gì");
  const to = sanitizeWorkerDiagnostics({ ...diagMau(), lastError: "lỗi ".repeat(5000), adapter: { ok: false, detail: "dài ".repeat(5000) }, repo: { ok: false, head: "", detail: "x".repeat(5000) }, workerVersion: "v".repeat(5000) })!;
  assert.ok(new TextEncoder().encode(JSON.stringify(to)).length <= DIAGNOSTICS_MAX_BYTES, "báo cáo phải nằm dưới trần");
  assert.equal(sanitizeWorkerDiagnostics({ claudeAuth: "LOGGED_IN_ROOT", pushMode: "PAT" })!.claudeAuth, "UNKNOWN", "giá trị ngoài danh sách ⇒ UNKNOWN, không tin");

  // 1.6 Lệnh sửa: danh sách ĐÓNG, khớp CHECK ở CSDL (schema + migration) — không hai danh sách lệch nhau.
  assert.ok(!isTechRepairCommand("rm -rf /") && !isTechRepairCommand("RUN_SHELL") && !isTechRepairCommand(""));
  for (const c of TECH_REPAIR_COMMANDS) assert.ok(isTechRepairCommand(c));
  const mig = src("drizzle/0231_tech_worker_onboarding.sql");
  const checkMig = /"repair_command" IN \(([^)]*)\)/.exec(mig)?.[1] ?? "";
  const checkSchema = /repairCommand\} IN \(([^)]*)\)/.exec(src("db/schema.ts"))?.[1] ?? "";
  for (const ds of [checkMig, checkSchema]) {
    const tap = ds.split(",").map((x) => x.trim().replace(/'/g, "")).filter(Boolean);
    assert.deepEqual([...tap].sort(), [...TECH_REPAIR_COMMANDS].sort(), "CHECK ở CSDL phải đúng bằng danh sách lệnh sửa");
  }

  // 1.7 Đẩy nhánh (review bảo mật PR #631): hook trỏ thư mục rỗng, helper chung bị xoá, helper CHỈ gắn github.com, không
  // proxy, TLS bật, chỉ https, URL + refspec tường minh, token chỉ ở biến môi trường.
  const args = buildPushArgs({ branch: "ai/worker/TECH-12-a2", url: "https://github.com/a/b.git", hooksDir: "/tmp/rong" });
  const cfgs = args.filter((_, i) => args[i - 1] === "-c");
  assert.ok(cfgs.includes("core.hooksPath=/tmp/rong"), "hook của kho KHÔNG được chạy — trỏ thư mục rỗng của worker");
  assert.ok(cfgs.indexOf("credential.helper=") >= 0 && cfgs.indexOf("credential.helper=") < cfgs.findIndex((c) => c.startsWith("credential.https://github.com.helper=")), "xoá helper chung TRƯỚC khi khai helper gắn host");
  assert.ok(!cfgs.some((c) => /^credential\.helper=./.test(c)), "không helper nào không gắn host — không trao token cho mọi URL");
  for (const c of ["http.proxy=", "https.proxy=", "http.sslVerify=true", "protocol.allow=never", "protocol.https.allow=always", "core.askPass="]) assert.ok(cfgs.includes(c), `thiếu -c ${c}`);
  assert.ok(!cfgs.includes("protocol.file.allow=always"), "đường thật không mở giao thức file");
  assert.ok(args.includes("--no-verify"));
  assert.deepEqual(args.slice(-2), ["https://github.com/a/b.git", "HEAD:refs/heads/ai/worker/TECH-12-a2"], "URL + refspec tường minh, không qua remote đã cấu hình");
  assert.ok(!args.includes("origin"));
  assert.ok(!args.some((x) => /ghs_|github_pat_|x-access-token:[^@\s]*@/.test(x)), "không tham số nào mang token");
  for (const xau of ["main", "claude/x", "ai/worker/../main", "ai/worker/TECH-1"]) assert.throws(() => buildPushArgs({ branch: xau, url: "https://github.com/a/b.git", hooksDir: "/x" }), /ai\/worker/);
  assert.ok(PUSH_URL_PATTERN.test("https://github.com/truyenhkm5group-stack/hkt.git"));
  for (const u of ["https://u:p@github.com/a/b.git", "https://evil.example/a/b.git", "http://github.com/a/b.git", "/tmp/repo.git"]) assert.ok(!PUSH_URL_PATTERN.test(u), u);
  const env = pushEnv({ PATH: "/bin", GIT_ASKPASS: "/x", GIT_SSH_COMMAND: "y" }, "/tmp/rong.gitconfig", "ghs_x");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/tmp/rong.gitconfig");
  assert.ok(!("GIT_ASKPASS" in env) && !("GIT_SSH_COMMAND" in env));
  // Cấu hình cục bộ nguy hiểm ⇒ từ chối; cấu hình bình thường của một kho ⇒ cho qua.
  const binhThuong = "core.repositoryformatversion=0\ncore.filemode=false\ncore.bare=false\nremote.origin.url=https://github.com/a/b.git\nremote.origin.fetch=+refs/heads/*:refs/remotes/origin/*\nbranch.main.remote=origin\nuser.name=x";
  assert.deepEqual(pushConfigViolations(binhThuong), []);
  for (const xau of ["core.hookspath=/evil", "remote.origin.pushurl=https://evil/x.git", "url.https://evil/.insteadof=https://github.com/", "url.x.pushinsteadof=y", "http.proxy=http://evil:8080", "http.https://github.com/.extraheader=AUTHORIZATION: x", "credential.helper=store", "include.path=/tmp/x", "includeif.gitdir:/x.path=/y", "core.sshcommand=x", "protocol.ext.allow=always", "https.proxy=x"]) {
    assert.equal(pushConfigViolations(`${binhThuong}\n${xau}`).length, 1, `phải từ chối: ${xau}`);
  }
  assert.ok(!pushConfigViolations("http.proxy=http://user:pw@evil:8080").join("").includes("pw@"), "chỉ in tên khoá, không in giá trị");
  // Dọn cây: chỉ cây của worker dưới TECH_WORKER_ROOT, nhánh ai/worker/*; cây của người cạnh kho không bao giờ là ứng viên.
  const goc = path.resolve("/may/vnx/work");
  const ds = parseWorktreeList(
    [
      `worktree ${path.resolve("/may/vnx/repo")}`, "HEAD abc", "branch refs/heads/main", "",
      `worktree ${path.resolve("/may/vnx/wt-tech-cp-workers")}`, "HEAD abc", "branch refs/heads/claude/cp-workers", "",
      `worktree ${path.resolve("/may/vnx/wt-tech-tech-9-a1")}`, "HEAD abc", "branch refs/heads/ai/worker/TECH-9-a1", "",
      `worktree ${path.join(goc, "wt-tech-lead-v2")}`, "HEAD abc", "branch refs/heads/claude/lead-v2", "",
      `worktree ${path.join(goc, "wt-tech-tech-1-a1")}`, "HEAD abc", "branch refs/heads/ai/worker/TECH-1-a1", "",
      `worktree ${path.join(goc, "wt-tech-tech-2-a1")}`, "HEAD abc", "branch refs/heads/ai/worker/TECH-2-a1", "",
      `worktree ${path.join(goc, "khac")}`, "HEAD abc", "branch refs/heads/ai/worker/TECH-3-a1", "",
      `worktree ${path.join(goc, "wt-tech-tach")}`, "HEAD abc", "detached", "",
    ].join("\n"),
  );
  assert.equal(ds.length, 8);
  assert.deepEqual(pruneCandidates(ds, { root: goc, activeDirs: [path.join(goc, "wt-tech-tech-2-a1")] }).map((e) => path.basename(e.path)), ["wt-tech-tech-1-a1"], "chỉ cây worker, dưới gốc, nhánh ai/worker/*, không đang chạy");
  assert.deepEqual(pruneCandidates(ds, { root: "", activeDirs: [] }), [], "không có TECH_WORKER_ROOT ⇒ không dọn gì");

  // 1.8 Bốn bước: hàm của các cột + đồng hồ.
  const base: OnboardingInput = { provider: "SUBSCRIPTION_CLAUDE_CODE", enabled: true, removedAt: null, secretRevokedAt: null, enrolledAt: null, lastHeartbeatAt: null, pendingEnrollment: false, diagnostics: null };
  const s = (i: OnboardingInput) => onboardingProgress(i, now).steps.map((x) => x.state);
  assert.deepEqual(s(base), ["DONE", "CURRENT", "TODO", "TODO"], "mới tạo ⇒ đang ở bước 2");
  assert.deepEqual(s({ ...base, enabled: false, secretRevokedAt: now }), ["DONE", "PROBLEM", "TODO", "TODO"], "khoá bị thu hồi (dogfood-1) ⇒ bước 2 có vấn đề");
  assert.match(onboardingProgress({ ...base, secretRevokedAt: now }, now).next, /Tải bộ cài/);
  assert.deepEqual(s({ ...base, pendingEnrollment: true }), ["DONE", "CURRENT", "TODO", "TODO"]);
  assert.deepEqual(s({ ...base, enrolledAt: now, diagnostics: diagMau({ claudeAuth: "NOT_LOGGED_IN" }), lastHeartbeatAt: now }), ["DONE", "DONE", "PROBLEM", "TODO"], "chưa đăng nhập Claude ⇒ bước 3");
  assert.deepEqual(s({ ...base, enrolledAt: now, diagnostics: diagMau({ claudeAuth: "LOGGED_IN_API" }), lastHeartbeatAt: now }), ["DONE", "DONE", "PROBLEM", "TODO"], "đăng nhập Console ⇒ bước 3 có vấn đề");
  assert.deepEqual(s({ ...base, enrolledAt: now, diagnostics: diagMau(), lastHeartbeatAt: now }), ["DONE", "DONE", "DONE", "DONE"], "nhịp tim mới ⇒ ONLINE");
  assert.deepEqual(s({ ...base, enrolledAt: now, diagnostics: diagMau(), lastHeartbeatAt: new Date(now.getTime() - (TECH_LEASE.staleAfterSeconds + 30) * 1000) }), ["DONE", "DONE", "DONE", "PROBLEM"], "im lặng ⇒ không còn ONLINE");
  assert.deepEqual(s({ ...base, provider: "ANTHROPIC_API", enrolledAt: now, lastHeartbeatAt: now }), ["DONE", "DONE", "DONE", "DONE"], "đường API không có bước đăng nhập Claude");
  assert.deepEqual(s({ ...base, lastHeartbeatAt: now, diagnostics: diagMau() }), ["DONE", "DONE", "DONE", "DONE"], "worker chạy tay từ trước bộ cài vẫn là đã có khoá");
  assert.deepEqual(s({ ...base, lastHeartbeatAt: now, secretRevokedAt: now }), ["DONE", "PROBLEM", "TODO", "TODO"], "khoá bị thu hồi thắng nhịp tim cũ");

  // 1.9 Chính sách in trên trang là SỰ THẬT của mã: deploy không giao được, trần mặc định R0, R4 không bao giờ nhận được.
  assert.equal(TECH_CAPABILITIES.find((c) => c.key === "deploy-production")?.autonomous, false);
  assert.equal(workerPolicyCeiling(undefined), "R0");
  assert.ok(!claimablePolicyLevels("R1").includes("R4") && !claimablePolicyLevels("R0").includes("R2"));
  assert.deepEqual(DOGFOOD_WORKER_DEFAULTS.capabilities, ["write-docs"]);
  assert.equal(DOGFOOD_WORKER_DEFAULTS.maxConcurrency, 1);
  assert.equal(DOGFOOD_WORKER_DEFAULTS.provider, "SUBSCRIPTION_CLAUDE_CODE");

  testInstallerStatic();
  testSourceGuards();
}

/** Bộ cài: phân tích tĩnh đúng chuỗi chủ shop sẽ tải về. */
function testInstallerStatic() {
  const f = buildWorkerInstaller(MAU_INSTALLER);
  const ps = f.slice(f.lastIndexOf(INSTALLER_PS_MARKER));
  const batch = f.slice(0, f.lastIndexOf(INSTALLER_PS_MARKER));

  // Hình dạng tệp: vỏ batch ASCII, CRLF, dấu mốc đúng hai lần (lệnh đọc + đầu phần PowerShell).
  assert.ok(/^@echo off\r\n/.test(f), "dòng đầu là @echo off — không BOM");
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(batch), "phần batch chỉ ASCII (cmd đọc theo trang mã OEM)");
  assert.ok(!/(^|[^\r])\n/.test(f), "toàn tệp CRLF");
  assert.equal(f.split(INSTALLER_PS_MARKER).length - 1, 2);
  assert.match(batch, /-ExecutionPolicy Bypass/, "bỏ qua chính sách thực thi CHO tiến trình này");
  for (const cam of [/Set-ExecutionPolicy/i, /-Verb\s+RunAs/i, /Start-Process[^\n]*RunAs/i]) assert.doesNotMatch(f, cam, "không đổi chính sách máy, không đòi quyền quản trị");

  // Bí mật: chỉ có MÃ GHI DANH, đúng một lần. Không khoá worker, không khoá API, không token GitHub.
  assert.equal(f.split(CODE_MAU).length - 1, 1, "mã ghi danh xuất hiện đúng một lần");
  assert.doesNotMatch(f, /tw_[A-Za-z0-9-]{8,}\.[A-Za-z0-9_-]{16,}/, "bộ cài KHÔNG BAO GIỜ mang khoá worker");
  assert.doesNotMatch(f, /sk-ant-|ghs_|ghp_|github_pat_/, "không token / khoá nào");
  assert.doesNotMatch(f, /\$env:ANTHROPIC_API_KEY\s*=|ANTHROPIC_API_KEY=/, "không đặt ANTHROPIC_API_KEY ở đâu cả");
  assert.doesNotMatch(f, /(^|[\s'"\\/])\.env(['"\s]|$)/m, "không ghi tệp .env");
  // Mã đi trong THÂN request tới đúng cửa ghi danh; URL không mang tham số.
  assert.match(ps, /-Method Post -Uri \(\$Origin \+ '\/api\/tech\/worker\/enroll'\)/);
  assert.doesNotMatch(ps, /enroll\?|\?code=/, "mã không bao giờ vào URL");
  assert.match(ps, /code = \$EnrollCode/);
  // Khoá chỉ đi vào DPAPI; không dòng in ra nào chạm tới khoá.
  for (const dong of ps.split("\r\n")) {
    if (/resp\.token/.test(dong)) assert.match(dong, /ConvertTo-SecureString|StartsWith\('tw_'\)/, `khoá chỉ được đi vào DPAPI: ${dong.trim()}`);
    if (/^\s*(Say|Write-Host)\b/.test(dong)) assert.doesNotMatch(dong, /\$resp|\$EnrollCode|\$sec\b|token\)/i, `không in bí mật: ${dong.trim()}`);
  }
  assert.match(ps, /ConvertFrom-SecureString -SecureString \$sec\)/, "cất khoá bằng DPAPI");
  assert.doesNotMatch(ps, /ConvertFrom-SecureString[^\n]*-Key/, "DPAPI theo NGƯỜI DÙNG — không khoá đối xứng nhúng trong tệp");
  assert.match(ps, /\$env:LOCALAPPDATA/, "thư mục cô lập theo người dùng, không cần quyền quản trị");
  assert.match(ps, /claude auth login --claudeai|'auth', 'login', '--claudeai'/, "đăng nhập bằng GÓI THUÊ BAO, không phải Console");

  // Trình khởi động: gỡ MỌI biến tính tiền API khỏi tiến trình worker gói thuê bao; mã thoát khớp worker.
  const l = buildWorkerLauncher();
  assert.ok(ps.split("\r\n").join("\n").includes(l.trimEnd()), "bộ cài ghi đúng trình khởi động này");
  assert.match(l, /if \(\[string\]\$cfg\.provider -eq 'SUBSCRIPTION_CLAUDE_CODE'\) \{\n\s*foreach \(\$k in @\(/);
  for (const k of API_BILLING_ENV) assert.ok(l.includes(`'${k}'`), `trình khởi động phải gỡ ${k}`);
  assert.match(l, /Remove-Item -Path \('Env:' \+ \$k\)/);
  assert.ok(l.includes(`-eq ${WORKER_EXIT.RESTART}`) && l.includes(`-eq ${WORKER_EXIT.REFRESH_AND_RESTART}`), "mã thoát khởi động lại khớp WORKER_EXIT");
  assert.doesNotMatch(l, /tw_|twe_/, "trình khởi động không mang bí mật");
  assert.doesNotMatch(l, /^'@/m, "trình khởi động không được kết thúc sớm here-string");

  // Dừng tiến trình theo PID chỉ khi dòng lệnh chứa thư mục của chính worker — PID có thể đã được cấp lại.
  for (const t of [f, buildWorkerUninstaller({ workerKey: "dogfood-1" })]) {
    const stops = t.split("Stop-Process").length - 1;
    assert.equal(stops, 1, "đúng một chỗ Stop-Process, bên trong Stop-WorkerPid");
    assert.match(t, /CommandLine\.ToLower\(\)\.Contains\(\$Root\.ToLower\(\)\)\) \{ Stop-Process/);
  }

  // Tệp gỡ: xoá tác vụ tự chạy + thư mục (gồm khoá DPAPI), không bí mật.
  const g = buildWorkerUninstaller({ workerKey: "dogfood-1" });
  assert.match(g, /Unregister-ScheduledTask/);
  assert.match(g, /Remove-Item -Recurse -Force -Path \$Root/);
  assert.doesNotMatch(g, /tw_|twe_|sk-ant-/);

  // Đầu vào nào cũng phải có hình dạng đóng — không chuỗi lạ nào lọt vào PowerShell.
  assert.ok(validateInstallerInput({ ...MAU_INSTALLER, origin: "https://erp.vn'; Remove-Item C:\\" }));
  assert.ok(validateInstallerInput({ ...MAU_INSTALLER, repoUrl: "https://user:ghp_x@github.com/a/b.git" }), "URL kho kèm credential bị từ chối");
  assert.ok(validateInstallerInput({ ...MAU_INSTALLER, enrollmentCode: "tw_abc.def" }));
  assert.ok(validateInstallerInput({ ...MAU_INSTALLER, origin: "http://erp.vnxcommerce.com" }), "http thường (không phải localhost) bị từ chối");
  assert.equal(validateInstallerInput(MAU_INSTALLER), null);
  assert.throws(() => buildWorkerInstaller({ ...MAU_INSTALLER, workerKey: "Dog Food" }));
}

/** Quét mã nguồn: cửa ghi danh chỉ đọc thân; worker từ chối khoá API; đẩy nhánh không mượn credential máy ngầm; action có quyền + audit. */
function testSourceGuards() {
  const enroll = code(src("app/api/tech/worker/enroll/route.ts"));
  assert.doesNotMatch(enroll, /searchParams|nextUrl|req\.url/, "cửa ghi danh KHÔNG đọc URL — mã chỉ từ thân request");
  assert.doesNotMatch(enroll, /console\.(log|info|warn|error)\([^)]*(code|token|body)/, "không in mã / khoá / thân gói");

  const w = code(src("scripts/tech-worker.ts"));
  const iBlock = w.indexOf("workerStartupBlockers(provider, process.env)");
  assert.ok(iBlock > 0 && iBlock < w.indexOf('api<{ task: Claimed | null; reason?: string }>("claim")'), "worker kiểm ranh giới thanh toán TRƯỚC khi xin việc");
  assert.match(w.slice(iBlock, iBlock + 400), /process\.exit\(WORKER_EXIT\.BILLING_BOUNDARY\)/, "có khoá API ⇒ thoát, không chạy tiếp");
  assert.match(w, /safePush\(\{ dir, branch: t\.branch, url: `https:\/\/github\.com\/\$\{r\.data\.repo\}\.git`/, "đẩy qua safePush tới URL máy chủ cấp");
  const iPush = w.indexOf("async function pushBranch(");
  const pb = w.slice(iPush, w.indexOf("\n}\n", iPush));
  assert.match(pb, /finally \{[\s\S]*revokeInstallationToken\(token\)/, "token bị thu hồi trong finally — kể cả khi đẩy hỏng");
  assert.match(pb, /r\.data\.branch !== t\.branch/, "nhánh máy chủ cấp phải khớp nhánh của lượt");
  const dayMay = [...w.matchAll(/"push", "--no-verify", "-q", "origin"/g)];
  assert.equal(dayMay.length, 1, "chỉ MỘT chỗ đẩy bằng credential của máy");
  const truocDayMay = w.slice(Math.max(0, dayMay[0]!.index! - 600), dayMay[0]!.index!);
  assert.match(truocDayMay, /cfg\.allowMachineGit/, "đẩy bằng credential máy chỉ khi bật TƯỜNG MINH");
  assert.match(truocDayMay, /pushConfigViolations\(/, "đường credential máy vẫn kiểm cấu hình cục bộ");
  assert.doesNotMatch(w, /"push", "-q", "origin"/, "không còn lượt đẩy nào đi qua remote mà không tắt hook");
  assert.match(w, /pruneWorkerWorktrees\(\{ repo: cfg\.repo, root: cfg\.root,/, "dọn cây dùng ĐÚNG TECH_WORKER_ROOT, không gốc mặc định");
  const gs = code(src("scripts/tech-worker/git-safety.ts"));
  assert.doesNotMatch(gs, /rmSync|"--force"/, "bộ dọn cây không bao giờ xoá đệ quy / ép gỡ");

  const a = src("lib/actions/tech-worker-onboarding.ts");
  const fns = a.split("export async function ").slice(1);
  assert.ok(fns.length >= 5);
  for (const fn of fns) {
    const ten = fn.slice(0, fn.indexOf("("));
    assert.match(fn, /await nguoiQuanTri\(\)/, `${ten}: phải đòi quyền tech:manage`);
    assert.match(fn, /await audit\(/, `${ten}: phải ghi audit`);
    assert.doesNotMatch(fn.slice(fn.indexOf("audit(")), /code:|token:|enrollmentCode/, `${ten}: audit không được ghi mã / khoá`);
  }
  assert.match(a, /can\(user, "tech:manage"\)/);
  assert.doesNotMatch(src("lib/actions/tech-control-plane.ts"), /registerTechWorkerAction/, "đường cũ hiện khoá ra màn hình đã gỡ");
}

/* ═════════════════════ 2. CSDL ═════════════════════ */

const PREFIX = "two-t";

export async function testTechWorkerOnboardingDb() {
  const db = await getDb();
  await db.insert(schema.users).values({ id: `${PREFIX}-user`, email: "two-t@shop.vn", name: "Chủ shop (kiểm thử cài worker)", passwordHash: "x", role: "ADMIN" }).onConflictDoNothing();
  const chuShop: TechActor = { kind: "HUMAN", id: `${PREFIX}-user`, name: "Chủ shop (kiểm thử cài worker)" };
  const may: TechActor = { kind: "SYSTEM", name: "job" };
  const envGoc = Object.fromEntries(["ERP_AGENT_GITHUB_APP_ID", "ERP_AGENT_GITHUB_INSTALLATION_ID", "ERP_AGENT_GITHUB_PRIVATE_KEY", "ERP_AGENT_GITHUB_REPO"].map((k) => [k, process.env[k]]));
  try {
    const ra = (await registerTechWorker({ key: `${PREFIX}-a`, name: "A", provider: "SUBSCRIPTION_CLAUDE_CODE", capabilities: ["write-docs"] }, chuShop)) as { id: string; token: string };
    const rb = (await registerTechWorker({ key: `${PREFIX}-b`, name: "B", provider: "SUBSCRIPTION_CLAUDE_CODE", capabilities: ["write-docs"] }, chuShop)) as { id: string; token: string };
    assert.ok(ra.id && rb.id);

    // 2.1 Chỉ người tạo bộ cài; mã trả về đúng hình dạng; CSDL chỉ giữ băm.
    assert.ok("error" in (await createWorkerEnrollment(ra.id, may)));
    const e1 = await createWorkerEnrollment(ra.id, chuShop);
    assert.ok("ok" in e1);
    const E1 = e1 as { code: string; expiresAt: Date };
    assert.match(E1.code, ENROLLMENT_CODE_PATTERN);
    const hang = await db.select().from(schema.techWorkerEnrollments).where(eq(schema.techWorkerEnrollments.workerId, ra.id));
    assert.ok(!JSON.stringify(hang).includes(E1.code.slice(4)), "CSDL không giữ mã thô");

    // 2.2 Mã sai / hết hạn ⇒ INVALID, không đổi gì.
    assert.deepEqual(await redeemWorkerEnrollment(`twe_${"Z".repeat(43)}`, {}), { error: "INVALID" });
    assert.deepEqual(await redeemWorkerEnrollment("không phải mã", {}), { error: "INVALID" });
    const qua = new Date(Date.now() - (ENROLLMENT_TTL_MINUTES + 5) * 60_000);
    const eHet = (await createWorkerEnrollment(rb.id, chuShop, qua)) as { code: string };
    assert.deepEqual(await redeemWorkerEnrollment(eHet.code, {}), { error: "INVALID" }, "mã hết hạn ⇒ từ chối");
    assert.ok(await authenticateTechWorker(`Bearer ${ra.token}`), "trước khi đổi mã, khoá cũ còn chạy");

    // 2.3 Đổi mã ⇒ xoay khoá: khoá cũ chết NGAY, khoá mới chạy; mã dùng lại ⇒ INVALID.
    const r1 = await redeemWorkerEnrollment(E1.code, { host: "MAY-VAN-PHONG" });
    assert.ok("ok" in r1, JSON.stringify(r1));
    const tok1 = (r1 as { data: { token: string } }).data.token;
    assert.notEqual(tok1, ra.token);
    assert.equal(await authenticateTechWorker(`Bearer ${ra.token}`), null, "khoá cũ (có thể đã lộ) phải chết ngay");
    assert.equal((await authenticateTechWorker(`Bearer ${tok1}`))?.id, ra.id);
    assert.deepEqual(await redeemWorkerEnrollment(E1.code, {}), { error: "INVALID" }, "mã chỉ dùng MỘT lần");
    const wa = (await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, ra.id) }))!;
    assert.ok(wa.enrolledAt && wa.enabled && !wa.secretRevokedAt && wa.host === "MAY-VAN-PHONG");
    // `secret_revoked_at` chặn xác thực KỂ CẢ khi băm vẫn khớp; `removed_at` cũng vậy.
    await db.update(schema.techWorkers).set({ secretRevokedAt: new Date() }).where(eq(schema.techWorkers.id, ra.id));
    assert.equal(await authenticateTechWorker(`Bearer ${tok1}`), null, "khoá đã thu hồi ⇒ từ chối dù băm khớp");
    await db.update(schema.techWorkers).set({ secretRevokedAt: null, removedAt: new Date() }).where(eq(schema.techWorkers.id, ra.id));
    assert.equal(await authenticateTechWorker(`Bearer ${tok1}`), null, "worker đã gỡ ⇒ từ chối dù băm khớp");
    await db.update(schema.techWorkers).set({ removedAt: null }).where(eq(schema.techWorkers.id, ra.id));
    assert.ok(!JSON.stringify(wa).includes(tok1.split(".")[1]!), "CSDL không giữ khoá thô");

    // 2.4 Sai worker: mã mới của A làm chết mã chưa dùng CŨ của A, không đụng mã của B; mã của B cho khoá của B.
    const eA2 = (await createWorkerEnrollment(ra.id, chuShop)) as { code: string };
    const eB = (await createWorkerEnrollment(rb.id, chuShop)) as { code: string };
    const eA3 = (await createWorkerEnrollment(ra.id, chuShop)) as { code: string };
    assert.deepEqual(await redeemWorkerEnrollment(eA2.code, {}), { error: "INVALID" }, "chỉ bộ cài MỚI NHẤT của một worker chạy được");
    const rB = (await redeemWorkerEnrollment(eB.code, {})) as { ok: true; data: { token: string; worker: { id: string } } };
    assert.equal(rB.data.worker.id, rb.id, "mã gắn với ĐÚNG một worker");
    assert.equal((await authenticateTechWorker(`Bearer ${tok1}`))?.id, ra.id, "ghi danh B không đụng khoá A");
    // Hai bộ cài chạy cùng lúc với cùng mã ⇒ đúng một cái thắng.
    const dua = await Promise.all([redeemWorkerEnrollment(eA3.code, {}), redeemWorkerEnrollment(eA3.code, {})]);
    assert.equal(dua.filter((x) => "ok" in x).length, 1, "đổi mã đồng thời: đúng một lượt thắng");
    const tokA = (dua.find((x) => "ok" in x) as { data: { token: string } }).data.token;

    // 2.4b Tắt worker ⇒ bộ cài đang chờ chết theo (đổi mã sẽ bật lại worker).
    const eTat = (await createWorkerEnrollment(rb.id, chuShop)) as { code: string };
    await setTechWorkerEnabled({ workerId: rb.id, enabled: false, reason: "kiểm thử" }, chuShop);
    assert.deepEqual(await redeemWorkerEnrollment(eTat.code, {}), { error: "INVALID" }, "tắt worker ⇒ mã ghi danh còn hạn bị huỷ");
    assert.equal((await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, rb.id) }))!.enabled, false, "mã chết thì worker vẫn tắt");
    await setTechWorkerEnabled({ workerId: rb.id, enabled: true }, chuShop);

    // 2.5 Cửa ghi danh: mã trong URL bị lờ (401), mã trong thân ⇒ 200 + no-store; dùng lại ⇒ 401.
    const eR = (await createWorkerEnrollment(rb.id, chuShop)) as { code: string };
    const quaUrl = await enrollPOST(new NextRequest(`http://localhost/api/tech/worker/enroll?code=${eR.code}`, { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } }));
    assert.equal(quaUrl.status, 401, "mã trong URL KHÔNG được chấp nhận");
    const quaThan = await enrollPOST(new NextRequest("http://localhost/api/tech/worker/enroll", { method: "POST", body: JSON.stringify({ code: eR.code, host: "MAY-B" }), headers: { "content-type": "application/json" } }));
    assert.equal(quaThan.status, 200);
    assert.equal(quaThan.headers.get("cache-control"), "no-store");
    const jt = (await quaThan.json()) as { token: string };
    assert.match(jt.token, /^tw_/);
    const lai = await enrollPOST(new NextRequest("http://localhost/api/tech/worker/enroll", { method: "POST", body: JSON.stringify({ code: eR.code }), headers: { "content-type": "application/json" } }));
    assert.equal(lai.status, 401);
    assert.deepEqual(await lai.json(), { error: "invalid" }, "một câu cho mọi thất bại");

    // 2.6 Chẩn đoán: lưu bản ĐÃ CHE; lệnh sửa chỉ danh sách đóng, lấy MỘT lần.
    await recordWorkerDiagnostics(ra.id, { ...diagMau(), lastError: `lỗi kèm ${tokA}` });
    const wd = (await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, ra.id) }))!;
    assert.ok(wd.diagnosticsAt && !JSON.stringify(wd.diagnostics).includes(tokA.split(".")[1]!), "báo cáo lưu ở CSDL đã che khoá");
    assert.ok("error" in (await requestWorkerRepair({ workerId: ra.id, command: "RERUN_SELF_CHECK" }, may)), "chỉ người yêu cầu sửa");
    assert.ok("error" in (await requestWorkerRepair({ workerId: ra.id, command: "rm -rf /" }, chuShop)), "lệnh ngoài danh sách bị từ chối");
    await assert.rejects(db.execute(sql`update tech_workers set repair_command = 'powershell -c x' where id = ${ra.id}`), "CHECK ở CSDL chặn lệnh tuỳ ý");
    assert.ok("ok" in (await requestWorkerRepair({ workerId: ra.id, command: "PRUNE_WORKTREES" }, chuShop)));
    assert.equal(await takeWorkerRepair(ra.id), "PRUNE_WORKTREES");
    assert.equal(await takeWorkerRepair(ra.id), null, "lệnh giao đúng một lần");

    // 2.7 Token đẩy nhánh: chỉ cho lượt đang giữ lease; máy chủ chưa có danh tính bot ⇒ NOT_CONFIGURED.
    const t = (await createTechTask({ title: `${PREFIX} viết tài liệu cài worker`, taskType: "DOCS", module: "TECH", priority: "P0", source: "OWNER" }, chuShop)) as { id: string };
    for (const to of ["TRIAGED", "SPEC_READY"] as const) await setTechTaskStatus({ taskId: t.id, to }, chuShop);
    const wA = (await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, ra.id) }))!;
    const nhan = await claimNextTechTask(wA);
    assert.equal(nhan.task?.taskId, t.id, `worker A phải nhận được việc kiểm thử: ${nhan.reason ?? ""}`);
    const fence = { runId: nhan.task!.runId, leaseGeneration: nhan.task!.leaseGeneration };
    for (const k of Object.keys(envGoc)) delete process.env[k];
    const chua = await issueWorkerPushToken(wA, fence);
    assert.ok("error" in chua && chua.error === "NOT_CONFIGURED", "chưa có danh tính bot ⇒ nói rõ, không rơi sang credential nào");
    assert.ok("error" in (await issueWorkerPushToken(wA, { ...fence, leaseGeneration: fence.leaseGeneration + 1 })), "sai generation ⇒ không cấp");
    const wB = (await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, rb.id) }))!;
    assert.ok("error" in (await issueWorkerPushToken(wB, fence)), "worker khác không xin được token cho lượt của A");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.ERP_AGENT_GITHUB_APP_ID = "123456";
    process.env.ERP_AGENT_GITHUB_INSTALLATION_ID = "98765";
    process.env.ERP_AGENT_GITHUB_REPO = "truyenhkm5group-stack/hkt";
    process.env.ERP_AGENT_GITHUB_PRIVATE_KEY = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    const xin: unknown[] = [];
    __setAgentGithubFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/access_tokens")) {
        xin.push(init?.body ? JSON.parse(String(init.body)) : null);
        return new Response(JSON.stringify({ token: "ghs_day_ngan_han_1", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch);
    const cap = await issueWorkerPushToken(wA, fence);
    assert.ok("ok" in cap && cap.token === "ghs_day_ngan_han_1");
    assert.equal(cap.repo, "truyenhkm5group-stack/hkt", "máy chủ cấp URL kho tường minh");
    assert.equal(cap.branch, nhan.task!.branch, "máy chủ cấp đúng nhánh của lượt");
    for (let i = 1; i < PUSH_TOKENS_PER_RUN; i++) assert.ok("ok" in (await issueWorkerPushToken(wA, fence)));
    const quaTran = await issueWorkerPushToken(wA, fence);
    assert.ok("error" in quaTran && quaTran.error === "PUSH_TOKEN_LIMIT", `quá ${PUSH_TOKENS_PER_RUN} token mỗi lượt ⇒ từ chối`);
    assert.deepEqual(xin[0], { repositories: ["hkt"], permissions: { contents: "write" } }, "token đẩy: đúng một kho, CHỈ contents:write");
    const ev = await db.select().from(schema.techEvents).where(eq(schema.techEvents.name, "worker.push_token_issued"));
    assert.ok(ev.length >= 1 && !JSON.stringify(ev).includes("ghs_day_ngan_han_1"), "sự kiện không mang token");

    // 2.8 Tạo lại token: khoá hiện tại chết NGAY, mã mới đổi được.
    const rot = await rotateWorkerSecret(rb.id, chuShop);
    assert.ok("ok" in rot);
    assert.equal(await authenticateTechWorker(`Bearer ${jt.token}`), null, "tạo lại token ⇒ khoá cũ chết ngay");
    const rRot = (await redeemWorkerEnrollment((rot as { code: string }).code, {})) as { ok: true; data: { token: string } };
    assert.ok(await authenticateTechWorker(`Bearer ${rRot.data.token}`));

    // 2.9 Gỡ worker: khoá chết, lease thu hồi (việc về hàng đợi), mã chưa dùng chết.
    const eTruocGo = (await createWorkerEnrollment(ra.id, chuShop)) as { code: string };
    const go = await removeTechWorker(ra.id, chuShop);
    assert.ok("ok" in go && go.released === 1, JSON.stringify(go));
    assert.equal(await authenticateTechWorker(`Bearer ${tokA}`), null, "gỡ ⇒ khoá chết");
    const tg = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t.id) }))!;
    assert.equal(tg.leaseWorkerId, null, "lease được thu hồi");
    assert.equal(tg.status, "SPEC_READY", "việc về hàng đợi");
    const run = (await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, fence.runId) }))!;
    assert.equal(run.status, "FAILED", "lượt đang chạy được đóng");
    assert.deepEqual(await redeemWorkerEnrollment(eTruocGo.code, {}), { error: "INVALID" }, "gỡ ⇒ bộ cài đang chờ cũng chết");
    assert.ok("error" in (await requestWorkerRepair({ workerId: ra.id, command: "RESTART_LOOP" }, chuShop)), "worker đã gỡ không nhận lệnh sửa");
  } finally {
    __setAgentGithubFetchForTests(null);
    for (const [k, v] of Object.entries(envGoc)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await db.delete(schema.techEvents).where(sql`${schema.techEvents.subjectId} in (select id from tech_workers where key like ${`${PREFIX}%`}) or ${schema.techEvents.taskId} in (select id from tech_tasks where title like ${`${PREFIX}%`})`);
    await db.delete(schema.techAgentRuns).where(sql`${schema.techAgentRuns.taskId} in (select id from tech_tasks where title like ${`${PREFIX}%`})`);
    await db.delete(schema.techTaskEvents).where(sql`${schema.techTaskEvents.taskId} in (select id from tech_tasks where title like ${`${PREFIX}%`})`);
    await db.delete(schema.techTasks).where(like(schema.techTasks.title, `${PREFIX}%`));
    await db.delete(schema.techWorkers).where(like(schema.techWorkers.key, `${PREFIX}%`));
    await db.delete(schema.users).where(eq(schema.users.id, `${PREFIX}-user`));
  }
  await testDogfoodRevocation();
  testWorkerGitSafetyReal();
}

/**
 * Git THẬT trên kho tạm (git là công cụ của chính kho này — CI và máy dev đều có): hook do mã trong cổng cài vào kho
 * KHÔNG thấy token; cấu hình cục bộ nguy hiểm ⇒ từ chối đẩy; dọn cây không đụng cây của người / cây bẩn / chưa đẩy.
 */
function testWorkerGitSafetyReal() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "two-git-"));
  const baseEnv = buildChildEnv("SUBSCRIPTION_CLAUDE_CODE", process.env, null);
  const sachEnv = pushEnv(baseEnv, pushSandbox(tmp).globalConfig, null);
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=kiem-thu", "-c", "user.email=kiem-thu@example.com", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...a], { cwd, env: sachEnv as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const bare = path.join(tmp, "remote.git");
    const repo = path.join(tmp, "repo");
    const root = path.join(tmp, "work");
    mkdirSync(repo);
    mkdirSync(root);
    g(tmp, "init", "-q", "--bare", bare);
    g(repo, "init", "-q");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    g(repo, "add", "a.txt");
    g(repo, "commit", "-q", "-m", "goc");
    g(repo, "remote", "add", "origin", bare);
    const nhanh = "ai/worker/TECH-1-a1";
    const wt = path.join(root, "wt-tech-tech-1-a1");
    g(repo, "worktree", "add", "-q", "-b", nhanh, wt);
    writeFileSync(path.join(wt, "b.txt"), "b\n");
    g(wt, "add", "b.txt");
    g(wt, "commit", "-q", "-m", "viec");
    // Hook pre-push do "mã trong cổng" cài vào kho: ghi ra token nếu thấy.
    const thay = path.join(tmp, "hook-saw.txt");
    const hook = path.join(repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\necho "HOOK SAW TOKEN=$VNX_PUSH_TOKEN" > "${thay.split(path.sep).join("/")}"\nexit 0\n`);
    chmodSync(hook, 0o755);
    const TOKEN = "ghs_FAKE_TOKEN_kiem_thu_0000";

    // (a) Chỉ riêng core.hooksPath (bỏ --no-verify) đã chặn hook — lớp thứ nhất tự đứng được.
    const sb = pushSandbox(root);
    const chiHooksPath = buildPushArgs({ branch: nhanh, url: bare, hooksDir: sb.hooksDir, allowFileProtocol: true }).filter((x) => x !== "--no-verify");
    execFileSync("git", chiHooksPath, { cwd: wt, env: pushEnv(baseEnv, sb.globalConfig, TOKEN) as NodeJS.ProcessEnv, stdio: "ignore" });
    assert.ok(!existsSync(thay), "hook của kho KHÔNG được chạy trong lượt đẩy (core.hooksPath → thư mục rỗng)");

    // (b) Đường đầy đủ: đẩy được, hook không thấy token.
    writeFileSync(path.join(wt, "c.txt"), "c\n");
    g(wt, "add", "c.txt");
    g(wt, "commit", "-q", "-m", "viec 2");
    const r = safePush({ dir: wt, branch: nhanh, url: bare, token: TOKEN, root, baseEnv, allowLocalUrl: true });
    assert.deepEqual(r, { ok: true });
    assert.equal(g(tmp, `--git-dir=${bare}`, "rev-parse", `refs/heads/${nhanh}`), g(wt, "rev-parse", "HEAD"), "nhánh lên remote đúng commit");
    assert.ok(!existsSync(thay), "hook KHÔNG thấy token");
    assert.deepEqual(safePush({ dir: wt, branch: nhanh, url: "https://evil.example/a/b.git", token: TOKEN, root, baseEnv }).ok, false, "URL ngoài github.com bị từ chối");

    // (c) Cấu hình cục bộ nguy hiểm ⇒ từ chối đẩy, không chạy git push.
    for (const [k, v] of [["core.hooksPath", path.join(tmp, "evil")], ["remote.origin.pushurl", "https://evil.example/x.git"], ["url.https://evil.example/.insteadOf", "https://github.com/"], ["http.proxy", "http://127.0.0.1:9"], ["include.path", path.join(tmp, "x.cfg")]] as const) {
      g(repo, "config", "--local", k, v);
      const tu = safePush({ dir: wt, branch: nhanh, url: bare, token: TOKEN, root, baseEnv, allowLocalUrl: true });
      assert.ok(!tu.ok && tu.error.toLowerCase().includes(k.toLowerCase().split(".").slice(-1)[0]!), `${k} cục bộ ⇒ từ chối đẩy`);
      assert.ok(!tu.ok && !tu.error.includes(v), "câu lỗi không in giá trị cấu hình");
      g(repo, "config", "--local", "--unset", k);
    }

    // (d) Dọn cây: cây người cạnh kho (bẩn), cây worker bẩn, cây worker chưa đẩy ⇒ KHÔNG đụng; cây worker sạch đã đẩy ⇒ gỡ.
    const nguoi = path.join(tmp, "wt-tech-lead-v2");
    g(repo, "worktree", "add", "-q", "-b", "claude/lead-v2", nguoi);
    writeFileSync(path.join(nguoi, "dang-lam.txt"), "việc chưa commit của người\n");
    const ban = path.join(root, "wt-tech-tech-2-a1");
    g(repo, "worktree", "add", "-q", "-b", "ai/worker/TECH-2-a1", ban);
    writeFileSync(path.join(ban, "chua-commit.txt"), "x\n");
    const chuaDay = path.join(root, "wt-tech-tech-3-a1");
    g(repo, "worktree", "add", "-q", "-b", "ai/worker/TECH-3-a1", chuaDay);
    writeFileSync(path.join(chuaDay, "d.txt"), "d\n");
    g(chuaDay, "add", "d.txt");
    g(chuaDay, "commit", "-q", "-m", "chua day");
    assert.deepEqual(pruneWorkerWorktrees({ repo, root: "", activeDirs: [], env: sachEnv }).removed, [], "không có TECH_WORKER_ROOT ⇒ không dọn gì");
    const don = pruneWorkerWorktrees({ repo, root, activeDirs: [], env: sachEnv });
    assert.deepEqual(don.removed, ["wt-tech-tech-1-a1"], `chỉ gỡ cây worker sạch đã đẩy — ${JSON.stringify(don)}`);
    assert.ok(existsSync(path.join(nguoi, "dang-lam.txt")), "cây của NGƯỜI cạnh kho còn nguyên việc chưa commit");
    assert.ok(existsSync(path.join(ban, "chua-commit.txt")), "cây worker còn thay đổi chưa commit ⇒ giữ nguyên");
    assert.ok(existsSync(chuaDay), "cây worker còn commit chưa đẩy ⇒ giữ nguyên");
    assert.equal(don.skipped.length, 2);
    assert.ok(don.skipped.some((x) => x.startsWith("wt-tech-tech-2-a1: còn thay đổi chưa commit")), `cây bẩn phải bị CHÍNH bộ dọn nhận ra: ${JSON.stringify(don.skipped)}`);
    assert.ok(don.skipped.some((x) => x.startsWith("wt-tech-tech-3-a1: còn commit chưa đẩy")));
    assert.ok(!existsSync(wt));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Migration 0231 — chạy ĐÚNG câu lệnh thu hồi trong tệp migration (không viết lại luật bằng tay) trên dòng `dogfood-1`
 * thử, qua từng điều kiện chặn, rồi chạy lại để chứng minh idempotent.
 */
async function testDogfoodRevocation() {
  const db = await getDb();
  const cau = src("drizzle/0231_tech_worker_onboarding.sql")
    .split("--> statement-breakpoint")
    .map((x) => x.trim())
    .find((x) => x.startsWith('WITH "thu_hoi"'));
  assert.ok(cau, "migration phải có câu thu hồi dogfood-1");
  const co = await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.key, "dogfood-1") });
  assert.equal(co, undefined, "CSDL kiểm thử không được có sẵn dogfood-1");
  const hashCu = "0".repeat(64);
  const [w] = await db
    .insert(schema.techWorkers)
    .values({ key: "dogfood-1", name: "dogfood-1", provider: "SUBSCRIPTION_CLAUDE_CODE", capabilities: ["write-docs"], maxConcurrency: 1, secretHash: hashCu, createdAt: new Date(Date.now() - 3600_000), enrolledAt: new Date() })
    .returning({ id: schema.techWorkers.id });
  const doc = async () => (await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, w.id) }))!;
  const suKien = async () => (await db.select().from(schema.techEvents).where(eq(schema.techEvents.subjectId, w.id))).filter((e) => e.name === "worker.secret_revoked").length;
  try {
    await db.execute(sql.raw(cau!));
    assert.equal((await doc()).secretHash, hashCu, "đã ghi danh bằng bộ cài (khoá mới) ⇒ KHÔNG thu hồi");
    await db.update(schema.techWorkers).set({ enrolledAt: null, createdAt: new Date(Date.now() + 3600_000) }).where(eq(schema.techWorkers.id, w.id));
    await db.execute(sql.raw(cau!));
    assert.equal((await doc()).secretHash, hashCu, "tạo SAU mốc deploy ⇒ KHÔNG thu hồi");
    // Đã từng nhịp tim KHÔNG miễn: khoá đã hiện ra màn hình là lộ, dù đã dùng hay chưa.
    await db.update(schema.techWorkers).set({ createdAt: new Date(Date.now() - 3600_000), lastHeartbeatAt: new Date() }).where(eq(schema.techWorkers.id, w.id));
    await db.execute(sql.raw(cau!));
    const sau = await doc();
    assert.notEqual(sau.secretHash, hashCu, "đủ điều kiện (kể cả đã từng nhịp tim) ⇒ khoá bị thu hồi");
    assert.match(sau.secretHash, /^[0-9a-f]{64}$/, "băm mới vẫn thoả CHECK");
    assert.ok(sau.secretRevokedAt && !sau.enabled && /có thể đã lộ/.test(sau.disabledReason));
    assert.equal(await suKien(), 1, "ghi đúng một sự kiện");
    await db.execute(sql.raw(cau!));
    const lan2 = await doc();
    assert.equal(lan2.secretHash, sau.secretHash, "chạy lại KHÔNG đổi gì");
    assert.equal(await suKien(), 1, "chạy lại không đẻ sự kiện thứ hai");
    assert.equal(await authenticateTechWorker(`Bearer tw_${w.id}.${"x".repeat(32)}`), null);
    // Đường lấy lại: «Tải bộ cài» ⇒ đổi mã ⇒ bật lại, khoá mới chạy.
    const chu: TechActor = { kind: "HUMAN", id: null, name: "Chủ shop (kiểm thử)" };
    const e = (await createWorkerEnrollment(w.id, chu)) as { code: string };
    const r = (await redeemWorkerEnrollment(e.code, {})) as { ok: true; data: { token: string } };
    assert.ok((await authenticateTechWorker(`Bearer ${r.data.token}`))?.enabled, "dogfood-1 dùng lại được sau khi tải bộ cài");
  } finally {
    await db.delete(schema.techEvents).where(eq(schema.techEvents.subjectId, w.id));
    await db.delete(schema.techWorkers).where(eq(schema.techWorkers.id, w.id));
  }
}
