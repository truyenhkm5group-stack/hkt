import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { waitVerdict } from "../scripts/ai-tech";

/**
 * ═══════════ NGÂN SÁCH TOKEN — ĐO ĐƯỢC THÌ MỚI NÓI GIẢM (docs/ai-tech-room/token-budget.md) ═══════════
 *
 * Hai thứ phải đúng trước khi một con số "CU/việc DONE" được dùng để kết luận:
 *   · bộ đo (`scripts/claude-usage.mjs`) khử trùng phản hồi stream, bỏ lượt ngoài cửa sổ, và bắt đúng lượt NGỦ;
 *   · lệnh chờ (`npm run ai -- wait`) thoát đúng lúc — thoát sớm thì agent lại quay về poll, thoát muộn thì treo.
 * Mốc trong bài là chuỗi ISO CỐ ĐỊNH truyền thẳng vào hàm, không đọc đồng hồ (luật 50).
 * Khác hẳn `tests/ai-usage.test.ts` (sổ dùng AI của KHÁCH trên nền tảng) — tệp này đo agent làm phần mềm.
 */
type Usage = { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
type UsageModule = {
  costUnits: (u: Usage) => number;
  isSleepCommand: (cmd: string) => boolean;
  vnDay: (iso: string) => string;
  measure: (o: { root: string; sinceIso: string; untilIso: string; project: string | null }) => Promise<{
    calls: number;
    cu: number;
    sleeps: number;
    cacheRewriteAfterSleep: number;
    subagents: number;
    mainSessions: number;
  }>;
};

const goc = path.resolve(__dirname, "..");

const assistant = (id: string, ts: string, u: { i?: number; o?: number; w?: number; r?: number }, cmd?: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      id,
      model: "claude-opus-5-5",
      usage: { input_tokens: u.i ?? 0, output_tokens: u.o ?? 0, cache_creation_input_tokens: u.w ?? 0, cache_read_input_tokens: u.r ?? 0 },
      content: cmd ? [{ type: "tool_use", name: "Bash", input: { command: cmd } }] : [{ type: "text", text: "x" }],
    },
  });

export async function testClaudeUsage() {
  const m = (await import(pathToFileURL(path.join(goc, "scripts/claude-usage.mjs")).href)) as UsageModule;

  // ───────── 1. Hàm thuần ─────────
  assert.equal(m.costUnits({ input: 10, cacheWrite: 100, cacheRead: 1000, output: 2 }), 10 + 125 + 100 + 10, "CU = input + 1,25·ghi + 0,1·đọc + 5·output");
  assert.equal(m.isSleepCommand("sleep 240; curl -s x"), true);
  assert.equal(m.isSleepCommand("until curl -s x; do sleep 30; done"), true);
  assert.equal(m.isSleepCommand("Start-Sleep -Seconds 60"), true);
  assert.equal(m.isSleepCommand("grep -n sleepy lib/x.ts"), false, "chữ 'sleep' trong tên không phải một lượt ngủ");
  assert.equal(m.isSleepCommand("npm run ai -- wait pr 870"), false, "lệnh chờ trong một tiến trình KHÔNG bị đếm là ngủ");
  assert.equal(m.vnDay("2026-10-15T17:30:00Z"), "2026-10-16", "17:30Z là 00:30 giờ VN hôm sau");

  // ───────── 2. Đọc transcript ─────────
  const root = mkdtempSync(path.join(tmpdir(), "claude-usage-"));
  try {
    const proj = path.join(root, "c--Code-ERP");
    mkdirSync(path.join(proj, "s1", "subagents"), { recursive: true });
    writeFileSync(
      path.join(proj, "s1.jsonl"),
      [
        assistant("a", "2026-10-10T01:00:00Z", { r: 1000, o: 10 }, "sleep 300"),
        assistant("a", "2026-10-10T01:00:00Z", { r: 1000, o: 10 }, "sleep 300"), // cùng phản hồi stream, ghi hai dòng
        assistant("b", "2026-10-10T01:06:00Z", { w: 5000, o: 1 }),
        assistant("c", "2026-10-20T00:00:00Z", { i: 999999 }), // ngoài cửa sổ
        'không phải json "assistant"',
      ].join("\n"),
    );
    writeFileSync(path.join(proj, "s1", "subagents", "agent-x.jsonl"), assistant("d", "2026-10-11T00:00:00Z", { r: 200, o: 2 }));
    const r = await m.measure({ root, sinceIso: "2026-10-09T17:00:00Z", untilIso: "2026-10-16T17:00:00Z", project: null });
    assert.equal(r.calls, 3, "khử trùng theo message.id và bỏ lượt ngoài cửa sổ: a · b · d");
    assert.equal(r.mainSessions, 1);
    assert.equal(r.subagents, 1);
    assert.equal(r.sleeps, 1);
    assert.equal(r.cacheRewriteAfterSleep, 5000, "lượt NGAY SAU một lần ngủ ghi lại cache — đó là cái giá phải lộ ra");
    assert.equal(r.cu, 100 + 50 + 6250 + 5 + 20 + 10);
    const none = await m.measure({ root, sinceIso: "2026-10-09T17:00:00Z", untilIso: "2026-10-16T17:00:00Z", project: "khong-co" });
    assert.equal(none.calls, 0, "lọc dự án theo tên thư mục");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // ───────── 3. Lệnh chờ thoát đúng lúc ─────────
  type PrObs = { merged: boolean; state: string; mergeableState: string | null; gates: "success" | "failure" | "pending" | "missing"; untilMerged: boolean };
  const pr = (o: Partial<PrObs>) => waitVerdict({ kind: "pr", merged: false, state: "open", mergeableState: "unstable", gates: "pending", untilMerged: false, ...o });
  assert.deepEqual(pr({}), { done: false }, "CI đang chạy ⇒ chờ tiếp, không in gì");
  assert.deepEqual(pr({ gates: "success" }), { done: true, ok: true, line: "gates / gates XANH" });
  assert.deepEqual(pr({ gates: "failure" }), { done: true, ok: false, line: "gates / gates ĐỎ" });
  assert.deepEqual(pr({ gates: "success", untilMerged: true }), { done: false }, "--merged: gates xanh chưa phải lúc thoát");
  assert.deepEqual(pr({ merged: true, untilMerged: true }), { done: true, ok: true, line: "đã gộp" });
  assert.deepEqual(pr({ state: "closed" }), { done: true, ok: false, line: "đã đóng, KHÔNG gộp" });
  assert.deepEqual(pr({ mergeableState: "dirty" }), { done: true, ok: false, line: "xung đột với nhánh gốc (dirty)" }, "xung đột thì chờ bao lâu cũng không tự hết");
  assert.deepEqual(waitVerdict({ kind: "run", status: "in_progress", conclusion: null }), { done: false });
  assert.deepEqual(waitVerdict({ kind: "run", status: "completed", conclusion: "failure" }), { done: true, ok: false, line: "xong: failure" });
  assert.deepEqual(waitVerdict({ kind: "health", commit: "1eee82dab15b", target: "1eee82dab15b0f00aa" }), { done: true, ok: true, line: "production chạy 1eee82dab15b" });
  assert.deepEqual(waitVerdict({ kind: "health", commit: "2982fafb0783", target: "1eee82dab15b" }), { done: false });
  assert.deepEqual(waitVerdict({ kind: "health", commit: null, target: "1eee82dab15b" }), { done: false }, "chưa đọc được health thì CHƯA xong, không phải xong");
  assert.deepEqual(waitVerdict({ kind: "health", commit: "1eee82", target: "1eee82dab15b" }), { done: false }, "dưới 7 ký tự không đủ để khẳng định");

  console.log("✓ Ngân sách token: bộ đo khử trùng + bắt lượt ngủ · lệnh chờ thoát đúng lúc");
}

if (/claude-usage\.test\.ts$/.test(process.argv[1] ?? "")) {
  testClaudeUsage().then(
    () => console.log("ĐẠT"),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
