#!/usr/bin/env node
/**
 * Đo token Claude Code của chính máy này và quy về VIỆC ĐÃ GIAO — chạy hằng tuần, so với baseline.
 *
 *   node scripts/claude-usage.mjs [--days=7] [--until=ISO] [--project=chuỗi] [--out=tệp.json] [--baseline=tệp.json] [--json]
 *
 * Nguồn: transcript `~/.claude/projects/<dự án>/**.jsonl` (chỉ ĐỌC; khử trùng theo `message.id` vì một phản hồi
 * stream ghi nhiều dòng cùng usage). Mẫu số: PR gộp vào `origin/main` (git log) và sự kiện DONE của sổ
 * `ai-control/registry` (việc đã hậu kiểm production — `docs/ai-tech-room/delivery-v2.md`).
 *
 * CU (đơn vị chi phí) = input + 1,25·ghi cache + 0,1·đọc cache + 5·output — tỷ lệ giá công khai, giống nhau giữa các
 * model, để SO SÁNH tuần với tuần. KHÔNG phải tiền, và KHÔNG phân biệt được gói subscription với API: transcript
 * không ghi nguồn thanh toán. Baseline 10–16/10/2026 nằm ở `docs/ai-tech-room/token-budget.md`.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** HÀM THUẦN. */
export function costUnits(u) {
  return (u.input ?? 0) + 1.25 * (u.cacheWrite ?? 0) + 0.1 * (u.cacheRead ?? 0) + 5 * (u.output ?? 0);
}

/** Lệnh shell có phải một lượt NGỦ để chờ không. HÀM THUẦN. */
export function isSleepCommand(cmd) {
  return /(^|[\s;&|(])sleep\s+\d|Start-Sleep/.test(String(cmd ?? ""));
}

/** Ngày theo giờ Việt Nam của một mốc ISO. HÀM THUẦN. */
export function vnDay(iso) {
  return new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);
}

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function* walk(dir) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(p);
    else if (d.name.endsWith(".jsonl")) yield p;
  }
}

/** Đọc MỘT transcript, trả các lượt gọi model trong cửa sổ (đã khử trùng) + số liệu chờ. */
async function readTranscript(file, sinceIso, untilIso) {
  const calls = new Map();
  let afterSleep = false;
  let sleeps = 0;
  const sleepMsgs = new Set();
  const rewriteAfterSleep = new Map();
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"assistant"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = r.timestamp ?? "";
    if (r.type !== "assistant" || ts < sinceIso || ts >= untilIso) continue;
    const m = r.message ?? {};
    if (m.model === "<synthetic>") continue;
    const id = m.id ?? r.uuid;
    const u = m.usage ?? {};
    const first = !calls.has(id);
    calls.set(id, {
      model: m.model ?? "?",
      ts,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    });
    if (first && afterSleep) rewriteAfterSleep.set(id, true);
    if (first) afterSleep = false;
    for (const b of m.content ?? []) {
      if (b?.type === "tool_use" && (b.name === "Bash" || b.name === "PowerShell") && isSleepCommand(b.input?.command)) {
        if (!sleepMsgs.has(id)) sleeps += 1;
        sleepMsgs.add(id);
        afterSleep = true;
      }
    }
  }
  let cacheRewriteAfterSleep = 0;
  for (const id of rewriteAfterSleep.keys()) cacheRewriteAfterSleep += calls.get(id)?.cacheWrite ?? 0;
  let sleepCu = 0;
  for (const id of sleepMsgs) sleepCu += costUnits(calls.get(id) ?? {});
  return { calls: [...calls.values()], sleeps, sleepCu, cacheRewriteAfterSleep };
}

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Mẫu số: PR gộp (tiêu đề squash kết thúc bằng "(#n)") và việc DONE trong sổ. null = không đọc được, KHÔNG phải 0. */
function delivery(sinceIso, untilIso) {
  const log = git(["log", "origin/main", "--first-parent", `--since=${sinceIso}`, `--until=${untilIso}`, "--format=%s"]);
  const mergedPrs = log === null ? null : log.split("\n").filter((s) => /\(#\d+\)\s*$/.test(s)).length;
  const ev = git(["show", "origin/ai-control/registry:events.ndjson"]);
  let done = null;
  if (ev !== null) {
    done = 0;
    for (const l of ev.split("\n")) {
      try {
        const e = JSON.parse(l);
        if (e.kind === "DONE" && e.at >= sinceIso && e.at < untilIso) done += 1;
      } catch {
        /* dòng hỏng trong sổ không phải việc DONE */
      }
    }
  }
  return { mergedPrs, done };
}

export async function measure({ root, sinceIso, untilIso, project }) {
  const sinceMs = Date.parse(sinceIso);
  const tot = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 };
  const byModel = {};
  const byDay = {};
  const sessions = [];
  let sleeps = 0;
  let sleepCu = 0;
  let cacheRewriteAfterSleep = 0;
  let ctxSum = 0;
  for (const proj of existsSync(root) ? readdirSync(root) : []) {
    if (project && !proj.includes(project)) continue;
    const dir = path.join(root, proj);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of walk(dir)) {
      if (statSync(file).mtimeMs < sinceMs) continue;
      const t = await readTranscript(file, sinceIso, untilIso);
      if (!t.calls.length) continue;
      const s = { file: path.relative(root, file).split(path.sep).join("/"), sub: file.split(path.sep).includes("subagents"), cu: 0, calls: t.calls.length, maxCtx: 0 };
      for (const c of t.calls) {
        for (const k of ["input", "output", "cacheWrite", "cacheRead"]) tot[k] += c[k];
        tot.calls += 1;
        const cu = costUnits(c);
        s.cu += cu;
        const ctx = c.input + c.cacheWrite + c.cacheRead;
        ctxSum += ctx;
        s.maxCtx = Math.max(s.maxCtx, ctx);
        byModel[c.model] = (byModel[c.model] ?? 0) + cu;
        const d = vnDay(c.ts);
        byDay[d] = (byDay[d] ?? 0) + cu;
      }
      sleeps += t.sleeps;
      sleepCu += t.sleepCu;
      cacheRewriteAfterSleep += t.cacheRewriteAfterSleep;
      sessions.push(s);
    }
  }
  const cu = costUnits(tot);
  const subs = sessions.filter((s) => s.sub);
  const del = delivery(sinceIso, untilIso);
  const per = (n) => (n ? cu / n : null);
  return {
    window: { since: sinceIso, until: untilIso },
    calls: tot.calls,
    mainSessions: sessions.length - subs.length,
    subagents: subs.length,
    cu,
    share: cu ? { cacheRead: (0.1 * tot.cacheRead) / cu, cacheWrite: (1.25 * tot.cacheWrite) / cu, output: (5 * tot.output) / cu } : null,
    byModel,
    byDay,
    sleeps,
    sleepShare: cu ? sleepCu / cu : null,
    cacheRewriteAfterSleep,
    avgCtx: tot.calls ? ctxSum / tot.calls : null,
    subagentMaxCtxMedian: quantile(subs.map((s) => s.maxCtx), 0.5),
    subagentsOver200k: subs.filter((s) => s.maxCtx > 200_000).length,
    subagentCuMedian: quantile(subs.map((s) => s.cu), 0.5),
    subagentCuP90: quantile(subs.map((s) => s.cu), 0.9),
    mergedPrs: del.mergedPrs,
    doneTasks: del.done,
    cuPerMergedPr: per(del.mergedPrs),
    cuPerDoneTask: per(del.done),
    top: [...sessions].sort((a, b) => b.cu - a.cu).slice(0, 5),
  };
}

const M = (x) => (x === null || x === undefined ? "—" : `${(x / 1e6).toFixed(1)}M`);
const P = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
const K = (x) => (x === null || x === undefined ? "—" : `${Math.round(x / 1000)}k`);

function render(r, base) {
  const o = [];
  o.push(`TOKEN CLAUDE CODE · ${r.window.since} → ${r.window.until}`);
  o.push(`  ${r.calls} lượt gọi · ${r.mainSessions} phiên chính · ${r.subagents} subagent · ${M(r.cu)} CU (đọc cache ${P(r.share?.cacheRead)} · ghi cache ${P(r.share?.cacheWrite)} · output ${P(r.share?.output)})`);
  o.push(`  model: ${Object.entries(r.byModel).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${P(r.cu ? v / r.cu : null)}`).join(" · ")}`);
  o.push(`  theo ngày (giờ VN): ${Object.keys(r.byDay).sort().map((d) => `${d.slice(5)} ${M(r.byDay[d])}`).join(" · ")}`);
  o.push(`  chờ bằng sleep: ${r.sleeps} lượt · ${P(r.sleepShare)} CU · ghi lại cache ngay sau ngủ ${M(r.cacheRewriteAfterSleep)} token`);
  o.push(`  context TB/lượt ${K(r.avgCtx)} · subagent: ctx lớn nhất trung vị ${K(r.subagentMaxCtxMedian)} · vượt 200k ${r.subagentsOver200k}/${r.subagents} · CU trung vị ${M(r.subagentCuMedian)} · p90 ${M(r.subagentCuP90)}`);
  o.push(`  giao: PR gộp ${r.mergedPrs ?? "—"} · việc DONE (sổ) ${r.doneTasks ?? "—"} ⇒ CU/PR ${M(r.cuPerMergedPr)} · CU/việc DONE ${M(r.cuPerDoneTask)}`);
  if (base) {
    const d = (now, then) => (now === null || then === null || !then ? "—" : `${now >= then ? "+" : ""}${(((now - then) / then) * 100).toFixed(0)}%`);
    o.push(`  so baseline ${base.window.since.slice(0, 10)}: CU/việc DONE ${d(r.cuPerDoneTask, base.cuPerDoneTask)} · CU/PR ${d(r.cuPerMergedPr, base.cuPerMergedPr)} · CU tổng ${d(r.cu, base.cu)} · sleep ${d(r.sleepShare, base.sleepShare)} · ctx TB ${d(r.avgCtx, base.avgCtx)}  (mục tiêu CU/việc DONE ≤ −50%)`);
  }
  return o.join("\n");
}

async function cli(argv) {
  const v = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => { const [k, ...x] = a.slice(2).split("="); return [k, x.join("=") || "1"]; }));
  const days = Number(v.days ?? 7);
  if (!Number.isFinite(days) || days <= 0 || days > 60) throw new Error("--days=1..60");
  const until = v.until ? new Date(v.until) : new Date();
  if (Number.isNaN(until.getTime())) throw new Error("--until phải là mốc ISO");
  const untilIso = until.toISOString();
  const sinceIso = new Date(until.getTime() - days * 86_400_000).toISOString();
  const root = v.root ?? path.join(homedir(), ".claude", "projects");
  const r = await measure({ root, sinceIso, untilIso, project: v.project ?? null });
  const base = v.baseline ? JSON.parse(readFileSync(v.baseline, "utf8")) : null;
  // Tệp so sánh không mang tên tệp transcript (định danh phiên của máy này) — chỉ con số.
  if (v.out) writeFileSync(v.out, `${JSON.stringify({ ...r, top: undefined }, null, 2)}
`);
  process.stdout.write(`${v.json ? JSON.stringify(r, null, 2) : render(r, base)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`✗ ${e.message}\n`);
    process.exit(1);
  });
}
