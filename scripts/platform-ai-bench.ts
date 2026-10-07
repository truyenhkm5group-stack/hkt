/*
  ops `platform-ai-bench` — BENCHMARK PHÁT LẠI OFFLINE CHO PLATFORM AI POLICY (docs/platform/ai-model-control.md §9).

  Vì sao (07/10/2026): canary 3.1-flash-lite trên ghi đơn tốn ~850 token ra / hội thoại so với ~127 của 3.5 — chờ 200 hội
  thoại production để biết là chậm và đắt. Phát lại dữ liệu THẬT đã lưu với từng cấu hình (model × mức suy nghĩ × trần token),
  chấm bằng luật tất định, đo token hiện ra / suy nghĩ, độ trễ, tiền — rồi mới quyết chính sách theo TỪNG loại việc.

  Hai chế độ:
    sync <mã tổ chức> [--cases=120] [--days=30] [--configs=D35l,C31l,…] [--concurrency=6]
        ghi đơn từ hội thoại — CHỈ ĐỌC theo cấu tạo (chỉ select + gọi model): không khách, không đơn, không chuông, không nhật ký.
    sales <mã tổ chức> [--points=60] [--days=30] [--configs=S35,S31,F31] [--concurrency=4]
        Sales Agent — đường «Phát lại hội thoại cũ»: kênh THỬ, công cụ ghi chỉ MÔ PHỎNG, hội thoại tạm bị xoá; lượt AI KHÔNG
        vào sổ AI thật của shop (bắt riêng để tính tiền của benchmark).

    quick <mã tổ chức> [--cases=80] [--configs=Q35l,Q31n,…]
        AI chọn câu mẫu (quick_extract) trên tin khách THẬT — nhãn = câu mẫu bộ khớp CHỮ (tất định) chọn; ca khớp chữ không ra
        thì so với cấu hình đầu tiên (đang chạy). Chỉ đọc.

  PHANH CHI TIÊU (07/10/2026 — lượt benchmark ~2 USD làm cạn tài khoản trả trước Google DÙNG CHUNG với khoá riêng của HSLC,
  bot thật của shop hỏng ~40 phút): `--max-usd` (mặc định 0,2) là trần CẢ LƯỢT; lỗi hết tiền / khoá / quá tải ⇒ DỪNG mọi lời
  gọi còn lại. Lỗi trả cho engine bị đổi thành câu trung tính — engine không được báo chủ shop «hết credit» vì một lượt
  benchmark.

  Mọi lời gọi đi bằng KHOÁ NỀN TẢNG (`PLATFORM_AI_API_KEY`) — không tốn tiền khoá riêng của shop. Chỉ in SỐ TỔNG HỢP
  (`[ops:tom-tat]`): không tên, SĐT, địa chỉ, nội dung tin, mã hội thoại. Chạy một lượt ≤ ~10 phút (giữ khoá đọc của VPS
  ngắn); muốn nhiều ca hơn thì chạy nhiều lượt và cộng các số đếm.
*/
const ARGV = process.argv.slice(2).join(" ").split(/\s+/).filter(Boolean);

import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { ByokGeminiProvider } from "@/lib/ai-builder/providers";
import { withRequestOverrides } from "@/lib/ai-builder/provider";
import { estimateCostUsd, type AiProvider, type AiRequest } from "@/lib/ai/provider";
import { classifyAiFailure } from "@/lib/constants/ai-incidents";
import { listQuickReplies, quickReplyByAi, quickReplyByKeyword } from "@/lib/sales-chatbot/quick-replies";
import type { QuickReplyEntry } from "@/lib/sales-chatbot/quick-replies-shared";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { setAiUsageCaptureForBench } from "@/lib/ai-usage/ledger";
import { platformAiConfig } from "@/lib/ai-usage/platform-ai";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { buildSyncBenchCases, runSyncCase, summarizeSyncBench, type SyncBenchConfig, type SyncBenchResult } from "@/lib/sales-chatbot/order-sync-bench";
import { groundedPrices, loadReplaySources } from "@/lib/sales-chatbot/replay";
import { extractMoneyAmounts } from "@/lib/sales-chatbot/replay-shared";
import { pickBenchPoints, scoreSalesPoint, summarizeSalesBench, type SalesBenchResult, type SalesCallObs } from "@/lib/sales-chatbot/sales-bench";
import { setSalesChatBenchProvider } from "@/lib/sales-chatbot/engine";
import { shadowTurn } from "@/lib/sales-chatbot/shadow";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const M35 = "gemini-3.5-flash-lite";
const M31 = "gemini-3.1-flash-lite";

/** Cấu hình ghi đơn. D35l = production hôm nay (order-sync gọi reasoning "low", trần 4.000). */
const SYNC_CONFIGS: Record<string, SyncBenchConfig> = {
  D35l: { key: "D35l", model: M35, reasoning: "low", maxTokens: 4000 },
  A35m: { key: "A35m", model: M35, reasoning: "medium", maxTokens: 4000 },
  B31m: { key: "B31m", model: M31, reasoning: "medium", maxTokens: 4000 },
  C31l: { key: "C31l", model: M31, reasoning: "low", maxTokens: 4000 },
  E31n: { key: "E31n", model: M31, reasoning: "minimal", maxTokens: 4000 },
  F35n: { key: "F35n", model: M35, reasoning: "minimal", maxTokens: 4000 },
  G31l1k: { key: "G31l1k", model: M31, reasoning: "low", maxTokens: 1024 },
  H31n1k: { key: "H31n1k", model: M31, reasoning: "minimal", maxTokens: 1024 },
};
/** Cấu hình Sales Agent: SMART = suy nghĩ medium, trần 10.000 · FAST = low, 4.000 (config.ts · SALES_THINKING_BUDGET). */
const SALES_CONFIGS: Record<string, { key: string; model: string; reasoning: AiRequest["reasoning"]; maxTokens: number }> = {
  S35: { key: "S35", model: M35, reasoning: "medium", maxTokens: 10_000 },
  S31: { key: "S31", model: M31, reasoning: "medium", maxTokens: 10_000 },
  F31: { key: "F31", model: M31, reasoning: "low", maxTokens: 4_000 },
  F35: { key: "F35", model: M35, reasoning: "low", maxTokens: 4_000 },
};

const flag = (name: string, dflt: number) => {
  const v = ARGV.find((a) => a.startsWith(`--${name}=`));
  const n = v ? Number(v.slice(name.length + 3)) : dflt;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
const listFlag = (name: string, dflt: string[]) => ARGV.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3).split(",").filter(Boolean) ?? dflt;

async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** Ngân sách CHUNG của cả lượt + công tắc dừng. */
const budget = { capUsd: 0.2, spentUsd: 0, halted: null as string | null };

/**
 * Bọc provider: hết trần / đã dừng ⇒ không gọi; lỗi hết tiền · khoá · quá tải ⇒ DỪNG cả lượt. Lỗi ném ra là câu TRUNG TÍNH
 * (không chứa «credit» / «429» / «permission»…) để bộ phân loại lỗi của engine không báo chủ shop.
 */
function guarded(p: AiProvider): AiProvider {
  return {
    name: p.name,
    schemaDialect: p.schemaDialect,
    get model() {
      return p.model;
    },
    async complete(req) {
      if (budget.halted) throw new Error(`bench da dung: ${budget.halted}`);
      if (budget.spentUsd >= budget.capUsd) {
        budget.halted = `cham tran ${budget.capUsd} USD`;
        throw new Error(`bench da dung: ${budget.halted}`);
      }
      try {
        const res = await p.complete(req);
        budget.spentUsd += estimateCostUsd(res.model || p.model, res.usage) ?? 0;
        return res;
      } catch (e) {
        const cls = classifyAiFailure(e instanceof Error ? e.message : String(e));
        if (cls === "CREDIT" || cls === "AUTH" || cls === "RATE_LIMIT") budget.halted = `nha cung cap loi nhom ${cls.toLowerCase()}`;
        throw new Error(`bench loi nha cung cap (nhom ${cls.toLowerCase()})`);
      }
    },
  };
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, d = 0) => (v === null ? "—" : v.toFixed(d));

async function runSync(orgCode: string, apiKey: string) {
  const org = await findOrganization(orgCode);
  if (!org) throw new Error("không tìm thấy tổ chức");
  const configs = listFlag("configs", ["D35l", "C31l", "E31n", "B31m", "A35m"]).map((k) => SYNC_CONFIGS[k]).filter(Boolean);
  const conc = Math.min(flag("concurrency", 6), 8);
  await withOrganization(orgCode, async () => {
    const { cases, catalog, skipped } = await buildSyncBenchCases({ days: flag("days", 30), limit: Math.min(flag("cases", 120), 400), now: new Date(), shop: org.name });
    const byLabel = cases.reduce<Record<string, number>>((m, c) => ({ ...m, [c.label]: (m[c.label] ?? 0) + 1 }), {});
    tomTat(`GHI ĐƠN · ${cases.length} ca (${Object.entries(byLabel).map(([k, v]) => `${k} ${v}`).join(" · ")}) · bỏ: không mã hội thoại ${skipped.noThread} · không tin khách ${skipped.noCustomerMessage} · cấu hình ${configs.map((c) => c.key).join(",")}`);
    for (const cfg of configs) {
      const provider = guarded(new ByokGeminiProvider({ apiKey, model: cfg.model, name: "gemini-bench" }));
      const t0 = Date.now();
      const rows: SyncBenchResult[] = await pool(cases, conc, (c) => runSyncCase(c, cfg, provider, catalog));
      const s = summarizeSyncBench(rows);
      const f = (x: { ok: number; n: number; rate: number | null }) => `${x.ok}/${x.n}`;
      tomTat(`${cfg.key} ${cfg.model} ${cfg.reasoning} ${cfg.maxTokens}: ${s.cases} ca · lỗi ${s.errors} · JSON hợp lệ ${pct(s.schemaValid)} · quyết định đúng ${pct(s.decisionAccuracy)} · recall ${pct(s.recall)} · FN ${s.falseNegative} · FP ${s.falsePositive} (${Object.entries(s.falsePositiveByLabel).map(([k, v]) => `${k} ${v}`).join(" ")})`);
      tomTat(`${cfg.key} trường (trên ca ra đơn): đơn đúng hết ${pct(s.exactOrderRate)} · SĐT ${f(s.phone)} · địa chỉ ${f(s.address)} · tên ${f(s.name)} · món ${f(s.product)} · mẫu ${f(s.variant)} · SL ${f(s.quantity)}`);
      tomTat(`${cfg.key} trên ca ORDER — model trả: ${Object.entries(s.replyOnOrder).map(([k, v]) => `${k} ${v}`).join(" · ")} · luật: ${Object.entries(s.decisionOnOrder).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
      tomTat(`${cfg.key} token/ca: vào ${num(s.avgInput)} · ra hiện ${num(s.avgCandidate)} · suy nghĩ ${num(s.avgThinking)} · USD/ca ${num(s.costPerCaseUsd, 6)} · p50/p95 ${num(s.p50Ms)}/${num(s.p95Ms)} ms · ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  });
}

async function runSales(orgCode: string, apiKey: string) {
  const configs = listFlag("configs", ["S35", "S31", "F31"]).map((k) => SALES_CONFIGS[k]).filter(Boolean);
  const conc = Math.min(flag("concurrency", 4), 6);
  const als = new AsyncLocalStorage<SalesCallObs>();
  setAiUsageCaptureForBench((e) => {
    const o = als.getStore();
    if (!o) return;
    o.calls += e.requests;
    o.inputTokens += e.inputTokens ?? 0;
    o.outputTokens += e.outputTokens ?? 0;
    o.thinkingTokens += e.thinkingTokens ?? 0;
    o.latencyMs += e.latencyMs ?? 0;
    if (e.status === "OK" && e.costUsd === null) o.unpriced = true;
    o.costUsd += e.costUsd ?? 0;
  });
  await withOrganization(orgCode, async () => {
    const sources = await loadReplaySources(flag("days", 30), new Date(), 2000);
    const points = pickBenchPoints(sources, Math.min(flag("points", 60), 250));
    const grounded = await groundedPrices();
    const sit = points.flatMap((p) => scoreSalesPoint(p, { ok: true, reply: "", status: null, tools: [], error: null }, grounded).situations).reduce<Record<string, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});
    tomTat(`SALES · ${sources.length} hội thoại nguồn · ${points.length} điểm · tình huống ${Object.entries(sit).map(([k, v]) => `${k} ${v}`).join(" · ")} · cấu hình ${configs.map((c) => c.key).join(",")}`);
    for (const cfg of configs) {
      const provider = guarded(withRequestOverrides(new ByokGeminiProvider({ apiKey, model: cfg.model, name: "gemini-bench" }), { reasoning: cfg.reasoning, maxTokens: cfg.maxTokens }));
      setSalesChatBenchProvider(provider);
      const t0 = Date.now();
      const rows: SalesBenchResult[] = await pool(points, conc, async (pt) => {
        const obs: SalesCallObs = { calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, latencyMs: 0, costUsd: 0, unpriced: false };
        const shadow = await als.run(obs, () => shadowTurn({ tag: `bench:${cfg.key}`, history: pt.history, text: pt.customerText }));
        const g = new Set<number>([...grounded, ...pt.history.filter((m) => m.role === "assistant").flatMap((m) => extractMoneyAmounts(m.text))]);
        return { config: cfg.key, score: scoreSalesPoint(pt, shadow, g), obs };
      });
      setSalesChatBenchProvider(null);
      const s = summarizeSalesBench(rows);
      tomTat(`${cfg.key} ${cfg.model} ${cfg.reasoning}: ${s.points} điểm · lỗi ${s.errors} · rỗng ${s.empty} · đúng giá ${pct(s.priceGrounded)} · bịa tồn ${s.stockFabricated} · đúng công cụ ${s.rightTool.ok}/${s.rightTool.n} · công cụ lỗi ${s.toolErrors} · SĐT/địa chỉ ${s.infoCaptured.ok}/${s.infoCaptured.n}`);
      tomTat(`${cfg.key}: chốt ẩu ${s.confirmWithoutConsent} · chuyển người khi phàn nàn ${s.handoffOnComplaint.ok}/${s.handoffOnComplaint.n} · chuyển thừa ${s.unnecessaryHandoff.k}/${s.unnecessaryHandoff.n} · lộ suy nghĩ ${s.leaks} · mời mua thêm ${pct(s.upsellRate)} · dài p50 ${num(s.replyCharsP50)} ký tự`);
      tomTat(`${cfg.key} mỗi điểm: ${num(s.calls / Math.max(1, s.points), 2)} lời gọi · vào ${num(s.inputPerPoint)} · ra ${num(s.outputPerPoint)} (suy nghĩ ${num(s.thinkingPerPoint)}) · USD ${num(s.costPerPointUsd, 6)} · lượt p50/p95 ${num(s.turnP50Ms)}/${num(s.turnP95Ms)} ms · ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  });
  setAiUsageCaptureForBench(null);
}

/** Cấu hình chọn câu mẫu. Q35l = production hôm nay (quickReplyByAi gọi reasoning "low", trần 1.200). */
const QUICK_CONFIGS: Record<string, { key: string; model: string; reasoning: AiRequest["reasoning"]; maxTokens: number }> = {
  Q35l: { key: "Q35l", model: M35, reasoning: "low", maxTokens: 1200 },
  Q35n: { key: "Q35n", model: M35, reasoning: "minimal", maxTokens: 1200 },
  Q31l: { key: "Q31l", model: M31, reasoning: "low", maxTokens: 1200 },
  Q31n: { key: "Q31n", model: M31, reasoning: "minimal", maxTokens: 1200 },
};

async function runQuick(orgCode: string, apiKey: string) {
  const configs = listFlag("configs", ["Q35l", "Q35n", "Q31n", "Q31l"]).map((k) => QUICK_CONFIGS[k]).filter(Boolean);
  const conc = Math.min(flag("concurrency", 6), 8);
  await withOrganization(orgCode, async () => {
    const cfg = await loadSalesChatbotConfig();
    const entries = (await listQuickReplies()).filter((q) => q.active && !q.needsEdit).map((q) => ({ id: q.id, title: q.title, triggers: q.triggers, answer: q.answer })).slice(0, 60);
    const sources = await loadReplaySources(flag("days", 30), new Date(), 2000);
    const texts = [...new Set(sources.flatMap((c) => c.messages.filter((m) => m.role === "user").map((m) => m.text.trim())).filter((t) => t.length >= 3 && t.length <= 200))];
    type Case = { text: string; label: string | null; candidates: readonly QuickReplyEntry[] };
    const keyword: Case[] = [];
    const open: Case[] = [];
    const want = Math.min(flag("cases", 80), 300);
    for (const text of texts) {
      if (keyword.length + open.length >= want * 3) break;
      const step = await quickReplyByKeyword(text, { ordering: false, cfg });
      if (step.kind === "ANSWER") keyword.push({ text, label: step.pick.entry.id, candidates: entries });
      else if (step.kind === "NO_MATCH") open.push({ text, label: null, candidates: step.candidates });
    }
    const cases = [...keyword.slice(0, Math.ceil(want / 2)), ...open.slice(0, want - Math.min(keyword.length, Math.ceil(want / 2)))];
    tomTat(`CÂU MẪU · ${entries.length} câu mẫu đang bật · ${cases.length} ca (khớp chữ ${cases.filter((c) => c.label).length} · không khớp chữ ${cases.filter((c) => !c.label).length}) · cấu hình ${configs.map((c) => c.key).join(",")}`);
    let reference: (string | null)[] | null = null;
    for (const q of configs) {
      const provider = guarded(withRequestOverrides(new ByokGeminiProvider({ apiKey, model: q.model, name: "gemini-bench" }), { reasoning: q.reasoning, maxTokens: q.maxTokens }));
      const t0 = Date.now();
      const rows = await pool(cases, conc, async (c) => {
        try {
          const { pick, res } = await quickReplyByAi(provider, c.text, "", c.candidates, cfg);
          return { pick: pick?.entry.id ?? null, ok: true, inT: res.usage.inputTokens + res.usage.cacheReadTokens, out: res.usage.outputTokens, think: res.usage.thoughtTokens ?? 0, ms: res.latencyMs, usd: estimateCostUsd(res.model || q.model, res.usage) ?? 0 };
        } catch {
          return { pick: null, ok: false, inT: 0, out: 0, think: 0, ms: 0, usd: 0 };
        }
      });
      const okRows = rows.filter((r) => r.ok);
      const kw = cases.map((c, i) => ({ c, r: rows[i] })).filter((x) => x.c.label && x.r.ok);
      const right = kw.filter((x) => x.r.pick === x.c.label).length;
      const wrongPick = kw.filter((x) => x.r.pick && x.r.pick !== x.c.label).length;
      const agree = reference ? cases.map((c, i) => ({ c, r: rows[i], ref: reference![i] })).filter((x) => !x.c.label && x.r.ok) : [];
      const agreeN = agree.filter((x) => x.r.pick === x.ref).length;
      const lat = okRows.map((r) => r.ms).sort((a, b) => a - b);
      const avg = (f: (r: (typeof rows)[number]) => number) => (okRows.length ? okRows.reduce((t, r) => t + f(r), 0) / okRows.length : null);
      tomTat(`${q.key} ${q.model} ${q.reasoning}: lỗi ${rows.length - okRows.length}/${rows.length} · ĐÚNG câu mẫu khớp chữ ${right}/${kw.length} · chọn SAI câu khác ${wrongPick} · ${reference ? `trùng cấu hình đầu trên ca không khớp chữ ${agreeN}/${agree.length}` : "(cấu hình tham chiếu)"} · chọn NONE ${okRows.filter((r) => !r.pick).length}`);
      tomTat(`${q.key} token/ca: vào ${num(avg((r) => r.inT))} · ra ${num(avg((r) => r.out))} (suy nghĩ ${num(avg((r) => r.think))}) · USD/ca ${num(avg((r) => r.usd), 7)} · p50/p95 ${num(lat[Math.floor(lat.length / 2)] ?? null)}/${num(lat[Math.floor(lat.length * 0.95)] ?? null)} ms · ${Math.round((Date.now() - t0) / 1000)} s`);
      reference ??= rows.map((r) => r.pick);
    }
  });
}

async function main() {
  const [mode, orgCode] = ARGV;
  budget.capUsd = Math.min(Number(ARGV.find((a) => a.startsWith("--max-usd="))?.slice(10) ?? 0.2) || 0.2, 1);
  if (!["sync", "sales", "quick"].includes(mode ?? "") || !/^[a-z0-9-]{2,40}$/.test(orgCode ?? "")) {
    tomTat("arg: sync|sales|quick <mã tổ chức> [--cases=N|--points=N] [--days=N] [--configs=…] [--concurrency=N] [--max-usd=0.2]");
    process.exit(64);
  }
  const cfg = platformAiConfig();
  if (!cfg.ready || cfg.provider !== "gemini") {
    tomTat(`KHOÁ NỀN TẢNG CHƯA SẴN SÀNG / không phải Gemini: ${cfg.ready ? cfg.provider : cfg.reason}`);
    process.exit(2);
  }
  if (mode === "sync") await runSync(orgCode, cfg.apiKey);
  else if (mode === "quick") await runQuick(orgCode, cfg.apiKey);
  else await runSales(orgCode, cfg.apiKey);
  tomTat(`NGÂN SÁCH: đã tiêu ~${budget.spentUsd.toFixed(4)} / trần ${budget.capUsd} USD${budget.halted ? ` · DỪNG SỚM: ${budget.halted}` : ""}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    tomTat(`LỖI: ${(error instanceof Error ? error.message : String(error)).replace(/AIza[0-9A-Za-z_\-]{20,}/g, "AIza…").slice(0, 200)}`);
    process.exit(1);
  },
);
