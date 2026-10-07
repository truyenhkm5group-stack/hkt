/*
  ops `platform-ai-model-probe` — KHOÁ AI DÙNG CHUNG (`PLATFORM_AI_API_KEY`) CÓ GỌI ĐƯỢC MODEL NÀY KHÔNG.
  MẶC ĐỊNH CHỈ ĐỌC; `--apply=<%>` / `--rollback` mới ghi chính sách model (Platform AI Policy).

  Vì sao có (06/10/2026): muốn hạ chi phí AI Sales Agent của SaaS bằng cách chuyển AI dùng chung từ `gemini-3.5-flash-lite`
  (0,30 / 2,50 USD mỗi 1M token) sang `gemini-2.5-flash-lite` (0,10 / 0,40). Nhưng 02/10/2026 khoá Gemini MỚI của HSLC nhận
  404 «no longer available to new users» với 2.5 — nên trước khi đổi production phải hỏi ĐÚNG khoá nền tảng, ở ĐÚNG máy chủ
  (khoá chỉ nằm trong `.env` của VPS). Mỗi model MỘT lời gọi `generateContent` một chữ, `maxOutputTokens` 8 — cùng hàm với
  nút «Kiểm tra khả dụng» ở /platform/saas (`lib/ai-usage/platform-model-probe.ts`), không có luật thứ hai.

  Không in khoá: chỉ in phán quyết, mã HTTP, độ trễ và câu lỗi của Google ĐÃ che khoá + che dãy số dài (số project).

  arg (mặc định CHỈ ĐỌC — không đổi model, không lưu, không nhật ký):
    `[model …]`                      — trống ⇒ `gemini-2.5-flash-lite gemini-3.5-flash-lite`
  arg GHI (cùng lõi với nút trên màn hình, nhật ký nguồn SCRIPT; model chính được kiểm lại NGAY trước khi ghi):
    `--apply=<1-100> <model>`        — chạy thử (< 100) / áp dụng (100) `<model>`; dự phòng = model đang chạy
    `--rollback`                     — hoàn tác về bản trước (không có ⇒ tắt chính sách ⇒ model của biến môi trường)
    thêm cho hai cờ trên (Platform AI Policy theo loại việc, §8):
    `--workload=<sales_chatbot|order_sync|quick_extract|vision>` — chính sách RIÊNG của loại việc (trống = chính sách chung)
    `--reasoning=<minimal|low|medium|high>` · `--max-tokens=<256-16000>` — chỉ cho model chính (nhánh canary)
  arg ĐỌC thêm:
    `--report`                       — bảng A/B canary vs đối chứng (lib/ai-usage/platform-ai-ab.ts): chỉ số tổng hợp + đề xuất
*/
import "dotenv/config";
import { applyPlatformAiPolicyAsScript, probeWithPlatformKey, rollbackPlatformAiPolicyAsScript, SCRIPT_WRITER_LABEL } from "@/lib/ai-usage/platform-ai-admin";
import { PLATFORM_AI_REASONINGS, readPlatformAiPolicies, type PlatformAiPolicy, type PlatformAiReasoning } from "@/lib/ai-usage/platform-ai-policy";
import { PLATFORM_WORKLOADS, type PlatformWorkload } from "@/lib/ai-usage/types";
import { AB_DECISION_LABEL, readPlatformModelAbForScript, type AbVerdict, type TokenArm } from "@/lib/ai-usage/platform-ai-ab";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const DEFAULT_MODELS = ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite"];
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{1,60}$/;

async function printPolicy() {
  const set = await readPlatformAiPolicies({ fresh: true });
  const line = (tag: string, p: PlatformAiPolicy | null | undefined) =>
    tomTat(p ? `chính sách ${tag}: ${p.enabled ? "BẬT" : "TẮT"} · ${p.primaryModel}${p.reasoning ? ` suy nghĩ ${p.reasoning}` : ""}${p.maxOutputTokens ? ` trần ${p.maxOutputTokens}` : ""} ở ${p.canaryPct}% · dự phòng ${p.fallbackModel ?? "(biến môi trường)"} · từ ${p.effectiveFrom} · bởi ${p.changedBy === SCRIPT_WRITER_LABEL ? "ops" : "người vận hành (xem nhật ký nền tảng)"}` : `chính sách ${tag}: (chưa có)`);
  line("chung", set.global);
  for (const w of PLATFORM_WORKLOADS) if (set.workloads[w]) line(w, set.workloads[w]);
}

/** `--ten=giá-trị` ⇒ giá trị; không có ⇒ null. */
const flagValue = (flags: readonly string[], name: string) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

async function main() {
  const argv = process.argv.slice(2).join(" ").split(/\s+/).filter(Boolean);
  const flags = argv.filter((a) => a.startsWith("--"));
  const models = argv.filter((a) => !a.startsWith("--"));
  for (const m of models) {
    if (!MODEL_RE.test(m)) {
      tomTat("model không hợp lệ (chỉ chữ thường, số, . -) — dừng");
      process.exit(64);
    }
  }
  if (flags.includes("--report")) {
    const r = await readPlatformModelAbForScript();
    if (!r) {
      tomTat("A/B: chưa có chính sách nào ⇒ không có cohort");
      process.exit(0);
    }
    const p = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
    const n = (v: number | null, d = 0) => (v === null ? "—" : v.toFixed(d));
    const tok = (tag: string, a: TokenArm) => tomTat(`${tag}: ra hiện/HT ${n(a.visibleOutPerConv)} · suy nghĩ/HT ${n(a.thinkingPerConv)} (${p(a.thinkingPct)}) · USD suy nghĩ/HT ${n(a.thinkingCostPerConvUsd, 5)} · lời gọi p50/p95 ${n(a.callP50Ms)}/${n(a.callP95Ms)} ms · độ phủ ${p(a.thinkCoverage)}`);
    const said = (tag: string, v: AbVerdict) => tomTat(`${tag}: ${AB_DECISION_LABEL[v.decision]}${v.nextPct ? ` → ${v.nextPct}%` : ""} · ${v.reasons.join(" ")}`);
    const checks = (tag: string, v: AbVerdict) => {
      for (const c of v.checks) tomTat(`${tag} ${c.ok === null ? "○" : c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`);
    };
    const head = (tag: string, s: { scope: string; since: string; policy: { canaryPct: number; enabled: boolean; reasoning: string | null; maxOutputTokens: number | null }; canaryModel: string; controlModel: string }) =>
      tomTat(`${tag} · chính sách ${s.scope} · cohort từ ${s.since} · ${s.canaryModel}${s.policy.reasoning ? ` suy nghĩ ${s.policy.reasoning}` : ""}${s.policy.maxOutputTokens ? ` trần ${s.policy.maxOutputTokens}` : ""} ${s.policy.enabled ? `${s.policy.canaryPct}%` : "TẮT"} vs ${s.controlModel}`);
    tomTat(`A/B · ${r.orgs} tổ chức${r.errors.length ? ` · ${r.errors.length} tổ chức không đọc được` : ""}`);
    if (r.chat) {
      const c = r.chat;
      head("CHAT", c);
      for (const [label, a] of [["CANARY", c.canary], ["ĐỐI CHỨNG", c.control]] as const) {
        tomTat(`CHAT ${label} ${a.model}: HT ${a.conversations} · đơn ${a.orders} · chốt ${p(a.closeRate)} · SĐT ${p(a.phoneRate)} · địa chỉ ${p(a.addressRate)} · handoff ${p(a.handoffRate)} · lỗi ${p(a.errorRate)} (${a.requests} lượt)`);
        tomTat(`CHAT ${label} ${a.model}: p50/p95 ${n(a.p50Ms)}/${n(a.p95Ms)} ms · công cụ đúng ${p(a.toolSuccessRate)} · upsell mời ${p(a.upsellOfferRate)} nhận ${p(a.upsellAcceptRate)} · token/HT ${n(a.inputPerConv)}+${n(a.outputPerConv)} · USD/HT ${n(a.costPerConvUsd, 5)} · USD/đơn ${n(a.costPerOrderUsd, 4)}`);
        tok(`CHAT ${label} token`, a);
      }
      said("CHAT", c.verdict);
      checks("chat", c.verdict);
    }
    if (r.sync) {
      const s2 = r.sync;
      head("GHI ĐƠN", s2);
      for (const [label, a] of [["CANARY", s2.canary], ["ĐỐI CHỨNG", s2.control]] as const) {
        tomTat(`GHI ĐƠN ${label} ${a.model}: HT ${a.threads} · ${a.requests} lượt · lỗi ${p(a.errorRate)} · đơn ${a.orders} · ra đơn ${p(a.orderRate)} · lead→đơn ${p(a.leadConversion)} · lead lỡ ${p(a.missedLeadRate)} · token/HT ${n(a.tokensPerThread)} · USD/HT ${n(a.costPerThreadUsd, 5)} · tổng ${a.costUsd.toFixed(4)}`);
        tok(`GHI ĐƠN ${label} token`, a);
      }
      said("GHI ĐƠN", s2.verdict);
      checks("ghi đơn", s2.verdict);
    }
    said("ĐỀ XUẤT CHUNG", r.verdict);
    process.exit(0);
  }
  const apply = flags.find((f) => f.startsWith("--apply="));
  const wlRaw = flagValue(flags, "workload");
  if (wlRaw !== null && !(PLATFORM_WORKLOADS as readonly string[]).includes(wlRaw)) {
    tomTat(`--workload không hợp lệ (${PLATFORM_WORKLOADS.join(" · ")}) — dừng, không ghi gì`);
    process.exit(64);
  }
  const workload = wlRaw as PlatformWorkload | null;
  const reasoningRaw = flagValue(flags, "reasoning");
  if (reasoningRaw !== null && !(PLATFORM_AI_REASONINGS as readonly string[]).includes(reasoningRaw)) {
    tomTat("--reasoning phải là minimal · low · medium · high — dừng, không ghi gì");
    process.exit(64);
  }
  const maxRaw = flagValue(flags, "max-tokens");
  const maxOutputTokens = maxRaw === null ? null : Number(maxRaw);
  if (flags.includes("--rollback")) {
    const r = await rollbackPlatformAiPolicyAsScript({ reason: `Hoàn tác qua ops platform-ai-model-probe${workload ? ` (${workload})` : ""}`, workload });
    tomTat("error" in r ? `HOÀN TÁC KHÔNG CHẠY: ${r.error}` : r.message);
    await printPolicy();
    process.exit("error" in r ? 1 : 0);
  }
  if (apply) {
    const pct = Number(apply.slice("--apply=".length));
    if (!Number.isInteger(pct) || pct < 1 || pct > 100 || models.length !== 1) {
      tomTat("--apply=<1-100> cần ĐÚNG MỘT model — dừng, không ghi gì");
      process.exit(64);
    }
    const r = await applyPlatformAiPolicyAsScript({ primaryModel: models[0], canaryPct: pct, reason: `Ops: ${pct >= 100 ? "áp dụng" : `chạy thử ${pct}%`} ${models[0]}${workload ? ` cho ${workload}` : ""} — giảm chi phí AI dùng chung`, workload, reasoning: reasoningRaw as PlatformAiReasoning | null, maxOutputTokens });
    tomTat("error" in r ? `KHÔNG ĐỔI PRODUCTION: ${r.error}` : `${r.message} (kiểm khả dụng ngay trước khi ghi: ${r.verdict})`);
    await printPolicy();
    process.exit("error" in r ? 1 : 0);
  }
  const list = models.length ? models : DEFAULT_MODELS;
  const r = await probeWithPlatformKey(list);
  if (!r.ready) {
    tomTat(`KHOÁ NỀN TẢNG CHƯA SẴN SÀNG: ${r.reason}`);
    process.exit(2);
  }
  tomTat(`provider=${r.provider} · model của biến môi trường (PLATFORM_AI_MODEL / mặc định)=${r.baseModel} · số model kiểm=${list.length}`);
  for (const x of r.results) {
    const msg = (x.message ?? "").replace(/\d{6,}/g, "#");
    tomTat(`${x.model} ⇒ ${x.verdict} · HTTP ${x.httpStatus ?? "—"} · ${x.latencyMs} ms${x.modelVersion ? ` · modelVersion=${x.modelVersion}` : ""}${msg ? ` · «${msg}»` : ""}`);
  }
  const ok = r.results.filter((x) => x.verdict === "AVAILABLE").map((x) => x.model);
  tomTat(`KẾT LUẬN: dùng được = ${ok.length ? ok.join(", ") : "(không model nào)"}`);
  await printPolicy();
}

main().catch((error) => {
  tomTat(`LỖI: ${(error instanceof Error ? error.message : String(error)).replace(/AIza[0-9A-Za-z_\-]{20,}/g, "AIza…")}`);
  process.exit(1);
});
