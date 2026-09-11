/**
 * ═══════════ KIỂM AI COPILOT TRÊN PRODUCTION — CHỈ IN META ═══════════
 *
 * Chạy trong container app (ops "ai-check"). Log Actions là CÔNG KHAI, nên tuyệt đối không in:
 * khoá API, câu trả lời của model (có thể chứa tên / SĐT khách), nội dung tool trả về. Chỉ in trạng
 * thái, model thật mà API báo, số tool, số vòng, độ trễ, token, chi phí ước tính.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/ai-check.ts [--write]
 *
 * --write: chạy cả bước xác nhận một hành động GHI không phá huỷ (một note care có nhãn kiểm thử
 * trên một kiện đang trong hàng đợi). Không có cờ thì chỉ kiểm đến chỗ "chờ xác nhận".
 */
import "dotenv/config";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { confirmCopilotActions, runCopilot } from "@/lib/ai/copilot";
import { getAiProvider } from "@/lib/ai/provider";
import { OpenAiProvider } from "@/lib/ai/providers/openai";
import { MODEL_BY_TIER, modelFor, resolveProviderName, type AiTier } from "@/lib/ai/router";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { getCareQueue } from "@/lib/queries/care-workbench";

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const info = (m: string) => console.log(`    ${m}`);
const WRITE = process.argv.includes("--write");
let fails = 0;
const fail = (m: string) => {
  fails += 1;
  bad(m);
};
const usageLine = (u: { inputTokens: number; outputTokens: number; cacheReadTokens: number }, cost: number | null) => `token in ${u.inputTokens} (đệm ${u.cacheReadTokens}) out ${u.outputTokens} · chi phí ${cost === null ? "chưa có giá" : `$${cost}`}`;

async function main() {
  const started = new Date();
  console.log("Kiểm AI Copilot production —", started.toISOString());
  const provider = resolveProviderName();
  if (!provider) {
    fail("AI chưa cấu hình (không có khoá) — dừng");
    process.exit(1);
  }
  ok(`provider: ${provider} · khoá: configured (không in)`);

  // ───────── Routing: ba bậc phải đúng bảng ─────────
  console.log("\n▶ Model routing");
  const want: Record<AiTier, string> = { routine: "gpt-5.6-luna", copilot: "gpt-5.6-terra", analysis: "gpt-5.6-sol" };
  for (const tier of ["routine", "copilot", "analysis"] as AiTier[]) {
    const m = modelFor(provider, tier);
    if (provider === "openai" && m !== want[tier] && !process.env.AI_MODEL) fail(`${tier} → ${m} (mong đợi ${want[tier]})`);
    else ok(`${tier} → ${m}`);
  }
  info(`bảng: ${JSON.stringify(MODEL_BY_TIER[provider])}`);

  const db = await getDb();
  const [admin] = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name }).from(schema.users).where(eq(schema.users.role, "ADMIN")).limit(1);
  if (!admin) {
    fail("Không có tài khoản ADMIN");
    process.exit(1);
  }
  const user: SessionUser = { id: admin.id, email: admin.email, name: admin.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null) };
  const [{ n: aiRowsBefore }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.aiInteractions);

  // ───────── 1. Chat đơn giản, từng bậc — model THẬT API báo về ─────────
  console.log("\n▶ 1. Chat đơn giản theo bậc (model do API trả về)");
  for (const tier of ["routine", "copilot", "analysis"] as AiTier[]) {
    const p = getAiProvider(tier)!;
    try {
      const r = await p.complete({ system: "Trả lời đúng một từ: OK", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [], maxTokens: 16 });
      const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      const expected = modelFor(provider, tier);
      const match = r.model === expected || r.model.startsWith(expected);
      (match ? ok : fail)(`${tier}: yêu cầu ${expected} → API báo "${r.model}" · trả lời ${text ? `"${text.slice(0, 12)}"` : "(rỗng)"} · ${r.latencyMs} ms · ${usageLine(r.usage, null)}`);
    } catch (e) {
      fail(`${tier}: lỗi ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }

  // ───────── 2. Read tool trên dữ liệu thật ─────────
  console.log("\n▶ 2. Read tool trên dữ liệu ERP thật");
  const r2 = await runCopilot({ user, message: "Hàng đợi care hiện tại: bao nhiêu kiện cần care, COD treo, vỡ SLA? Trả lời 2 dòng.", context: { route: "/shipments", entityType: "", entityId: "" } });
  const r2ok = r2.status === "OK" && r2.toolCalls.some((t) => t.name === "get_care_queue_summary" && t.executed && t.ok);
  (r2ok ? ok : fail)(`status ${r2.status} · model ${r2.model} · ${r2.rounds} vòng · tool [${r2.toolCalls.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join(", ")}] · ${r2.answer.length} ký tự · ${r2.latencyMs} ms · ${usageLine(r2.usage, r2.costUsd)}${r2.error ? ` · lỗi ${r2.error.slice(0, 120)}` : ""}`);

  // ───────── 3. Vận đơn & care: đọc case, đề xuất bước tiếp ─────────
  console.log("\n▶ 3. Case care: AI đọc hồ sơ, đề xuất bước tiếp theo");
  const q = await getCareQueue();
  const target = q.cases.find((c) => c.view === "care") ?? q.cases[0];
  if (!target) fail("Hàng đợi care rỗng — không có kiện để thử");
  else {
    info(`kiện thử: ${target.shipmentId} (view ${target.view}, care ${target.care.status}, lý do ${target.reason})`);
    const r3 = await runCopilot({ user, message: "Tóm tắt kiện này: chuyện gì đang xảy ra, vì sao cần care, tiền nào đang rủi ro, nên làm gì tiếp? Không đề nghị hành động ghi.", context: { route: "/shipments", entityType: "shipment", entityId: target.shipmentId } });
    const r3ok = r3.status === "OK" && r3.toolCalls.some((t) => t.name === "get_care_case" && t.executed && t.ok) && r3.answer.length > 80;
    (r3ok ? ok : fail)(`status ${r3.status} · model ${r3.model} · ${r3.rounds} vòng · tool [${r3.toolCalls.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join(", ")}] · ${r3.answer.length} ký tự · cảnh báo ${r3.warnings.length} · đề nghị ghi ${r3.pendingActions.length} · ${r3.latencyMs} ms · ${usageLine(r3.usage, r3.costUsd)}${r3.error ? ` · lỗi ${r3.error.slice(0, 120)}` : ""}`);
    if (r3.warnings.length) info(`cảnh báo dữ liệu: ${r3.warnings.map((w) => w.slice(0, 80)).join(" | ")}`);
  }

  // ───────── 4. Write tool: đề nghị → chờ xác nhận → quyền → xác nhận → audit ─────────
  console.log("\n▶ 4. Write tool có xác nhận + quyền + audit (không phá huỷ)");
  if (!target) fail("bỏ qua: không có kiện");
  else {
    const eventsBefore = await db.select({ n: sql<number>`count(*)::int` }).from(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, target.shipmentId));
    const note = `Kiểm thử AI production ${started.toISOString().slice(0, 16)} — không có hành động thật với khách`;
    const r4 = await runCopilot({ user, message: `Ghi một note care loại OTHER cho kiện này với nội dung đúng như sau, không thêm gì: "${note}"`, context: { route: "/shipments", entityType: "shipment", entityId: target.shipmentId } });
    const pending = r4.pendingActions.find((a) => a.name === "add_care_note");
    const eventsMid = await db.select({ n: sql<number>`count(*)::int` }).from(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, target.shipmentId));
    (r4.status === "NEEDS_CONFIRMATION" && pending ? ok : fail)(`đề nghị: status ${r4.status} · pending [${r4.pendingActions.map((a) => a.name).join(", ")}] · model ${r4.model} · ${r4.latencyMs} ms · ${usageLine(r4.usage, r4.costUsd)}${r4.error ? ` · lỗi ${r4.error.slice(0, 120)}` : ""}`);
    (eventsMid[0]!.n === eventsBefore[0]!.n ? ok : fail)(`chưa xác nhận ⇒ care_case_events không đổi (${eventsBefore[0]!.n} → ${eventsMid[0]!.n})`);
    if (pending && r4.interactionId) {
      const other: SessionUser = { ...user, id: "nguoi-khac-khong-ton-tai" };
      const c1 = await confirmCopilotActions({ user: other, interactionId: r4.interactionId, tokens: [pending.token] });
      ("error" in c1 ? ok : fail)(`người khác xác nhận ⇒ từ chối: ${"error" in c1 ? c1.error : "ĐÃ CHẠY (sai)"}`);
      const noPerm: SessionUser = { ...user, role: "VIEWER", permissions: [] };
      const c2 = await confirmCopilotActions({ user: noPerm, interactionId: r4.interactionId, tokens: [pending.token] });
      ("error" in c2 ? ok : fail)(`không có quyền ⇒ từ chối: ${"error" in c2 ? c2.error : "ĐÃ CHẠY (sai)"}`);
      const c3 = await confirmCopilotActions({ user, interactionId: r4.interactionId, tokens: ["00000000000000000000000000000000"] });
      ("error" in c3 ? ok : fail)(`token lạ ⇒ từ chối: ${"error" in c3 ? c3.error : "ĐÃ CHẠY (sai)"}`);
      const eventsAfterDenies = await db.select({ n: sql<number>`count(*)::int` }).from(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, target.shipmentId));
      (eventsAfterDenies[0]!.n === eventsBefore[0]!.n ? ok : fail)(`ba lần từ chối ⇒ không ghi gì (${eventsAfterDenies[0]!.n})`);
      if (WRITE) {
        const c4 = await confirmCopilotActions({ user, interactionId: r4.interactionId, tokens: [pending.token] });
        if ("error" in c4) fail(`xác nhận đúng người ⇒ lỗi: ${c4.error}`);
        else {
          const ex = c4.data.executed[0]!;
          (ex.ok ? ok : fail)(`xác nhận đúng người ⇒ ${ex.ok ? "đã chạy" : "không chạy"}: ${ex.summary.slice(0, 80)}`);
          const [ev] = await db.select({ source: schema.careCaseEvents.source, actor: schema.careCaseEvents.actorEmail, action: schema.careCaseEvents.action }).from(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, target.shipmentId)).orderBy(desc(schema.careCaseEvents.createdAt)).limit(1);
          (ev && ev.source === "AI" && ev.action === "NOTE" ? ok : fail)(`care_case_events mới: source ${ev?.source} · action ${ev?.action} · actor = người xác nhận (${ev?.actor === admin.email ? "đúng" : "sai"})`);
          const au = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "AI_ACTIONS_CONFIRMED"), eq(schema.auditLogs.entityId, r4.interactionId)));
          (au[0]!.n === 1 ? ok : fail)(`audit_logs AI_ACTIONS_CONFIRMED cho lượt hỏi: ${au[0]!.n}`);
          const c5 = await confirmCopilotActions({ user, interactionId: r4.interactionId, tokens: [pending.token] });
          ("ok" in c5 && !c5.data.executed[0]!.ok ? ok : fail)(`xác nhận lại cùng token ⇒ không chạy lại`);
        }
      } else info("bỏ qua bước thực thi (không có --write)");
    }
  }

  // ───────── 5. Lỗi mạng / hạn mức / model sai — không sập, có dấu vết ─────────
  console.log("\n▶ 5. Fallback / error handling");
  const timeoutFetch = (async () => {
    await new Promise((r) => setTimeout(r, 50));
    throw Object.assign(new Error("simulated ETIMEDOUT"), { code: "ETIMEDOUT" });
  }) as unknown as typeof fetch;
  const t5a = Date.now();
  const r5a = await runCopilot({ user, provider: new OpenAiProvider(modelFor(provider, "copilot"), "low", timeoutFetch), message: "ping", context: { route: "/", entityType: "", entityId: "" } });
  (r5a.status === "ERROR" && r5a.error ? ok : fail)(`timeout mạng (giả) ⇒ status ${r5a.status} · lỗi "${(r5a.error ?? "").slice(0, 80)}" · ${Date.now() - t5a} ms (SDK thử lại 2 lần) · nhật ký ${r5a.interactionId ? "đã ghi" : "KHÔNG ghi"}`);
  const quotaFetch = (async () => new Response(JSON.stringify({ error: { message: "You exceeded your current quota (simulated)", type: "insufficient_quota", code: "insufficient_quota" } }), { status: 429, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const r5b = await runCopilot({ user, provider: new OpenAiProvider(modelFor(provider, "copilot"), "low", quotaFetch), message: "ping", context: { route: "/", entityType: "", entityId: "" } });
  (r5b.status === "ERROR" && /quota|429/i.test(r5b.error ?? "") ? ok : fail)(`hết hạn mức 429 (giả) ⇒ status ${r5b.status} · lỗi "${(r5b.error ?? "").slice(0, 80)}"`);
  if (provider === "openai") {
    const r5c = await runCopilot({ user, provider: new OpenAiProvider("gpt-5.6-khong-ton-tai", "low"), message: "ping", context: { route: "/", entityType: "", entityId: "" } });
    (r5c.status === "ERROR" ? ok : fail)(`model không tồn tại (API thật) ⇒ status ${r5c.status} · lỗi "${(r5c.error ?? "").slice(0, 80)}"`);
  }

  // ───────── Audit ─────────
  console.log("\n▶ Audit");
  const rows = await db.select({ status: schema.aiInteractions.status, model: schema.aiInteractions.model, latencyMs: schema.aiInteractions.latencyMs, rounds: schema.aiInteractions.rounds, costUsd: schema.aiInteractions.costUsd }).from(schema.aiInteractions).where(gte(schema.aiInteractions.createdAt, started)).orderBy(schema.aiInteractions.createdAt);
  const [{ n: aiRowsAfter }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.aiInteractions);
  ok(`ai_interactions: ${aiRowsBefore} → ${aiRowsAfter} (+${aiRowsAfter - aiRowsBefore}) · lượt trong bài kiểm: ${rows.map((r) => `${r.status}/${r.model || "-"}/${r.latencyMs}ms/${r.rounds}v`).join(" · ")}`);
  const src = JSON.stringify(rows);
  (!/sk-[A-Za-z0-9_-]{10,}/.test(src) ? ok : fail)("không có chuỗi giống khoá trong nhật ký");

  console.log(`\n${fails === 0 ? "AI PRODUCTION: HEALTHY" : `AI PRODUCTION: ${fails} bước hỏng`} — ${new Date().toISOString()}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Lỗi:", error instanceof Error ? error.message.slice(0, 300) : String(error));
  process.exit(1);
});
