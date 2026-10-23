/**
 * ═══ AI BỔ SUNG CHO BỘ SINH TỪ KHOÁ (SRC-2) — CHỈ KHI TỪ ĐIỂN KHÔNG ĐỦ, CÓ TRẦN, MỌI LƯỢT VÀO SỔ ═══
 *
 *  · Chỉ gọi khi `buildChineseQueries` báo `needsAi` (còn cụm chưa hiểu / chưa nhận ra loại hàng) VÀ người dùng cho phép.
 *  · Trần: `sourcing.limits.aiCallsPerDay` của tổ chức, đếm bằng CHÍNH sổ `platform_ai_usage` (feature 'sourcing', ngày giờ Việt
 *    Nam) — không có bộ đếm thứ hai. Không đếm được ⇒ KHÔNG gọi (chưa biết ≠ còn lượt). Hết trần ⇒ dừng và nói ra; không tự nạp.
 *  · Hạn mức gói AI của nền tảng (`checkAiQuota`) vẫn áp như mọi tính năng AI khác.
 *  · Mọi lời gọi thật ghi MỘT dòng sổ: thành công ⇒ token + chi phí ước tính (model chưa có giá ⇒ `null`); lỗi ⇒ dòng ERROR với
 *    token / chi phí `null` (CHƯA BIẾT, không phải 0). Ghi sổ hỏng không làm hỏng lượt tìm.
 *  · Không bao giờ ném: hỏng ở đâu thì người dùng vẫn nhận nguyên phần từ điển, kèm câu nói vì sao không có phần AI.
 *  · Phần AI tách riêng, nhãn «AI gợi ý — chưa kiểm»; nó KHÔNG sửa truy vấn của từ điển.
 *
 * Lõi `expandWithAi` nhận mọi phụ thuộc qua `deps` để bài kiểm chạy không cần CSDL / mạng; `defaultSourcingAiDeps` nối vào thật.
 */
import { z } from "zod";
import type { AiProvider, AiUsage } from "@/lib/ai/provider";
import type { AiBillingSource } from "@/lib/ai-usage/types";
import type { QueryBuild } from "@/lib/sourcing/query";

export const SOURCING_AI_QUERY_MAX = 3;

export type AiQueryHint = { zh: string; vi: string };
export type AiTermHint = { vi: string; zh: string };
export type AiExpansionStatus = "NOT_NEEDED" | "NOT_REQUESTED" | "DISABLED" | "NO_AI" | "QUOTA" | "UNCOUNTABLE" | "OK" | "UNREADABLE" | "ERROR";
export type AiExpansion = {
  status: AiExpansionStatus;
  queries: AiQueryHint[];
  terms: AiTermHint[];
  /** Câu nói cho người dùng; `null` khi không có gì phải nói. */
  note: string | null;
  usedToday: number | null;
  limit: number;
};

export type SourcingAiRecord = {
  source: AiBillingSource;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usage: AiUsage | null;
  status: "OK" | "ERROR";
};

export type SourcingAiDeps = {
  limit: number;
  /** Số lượt AI tìm hàng đã dùng HÔM NAY; `null` = không đếm được. */
  usedToday: () => Promise<number | null>;
  resolveAi: () => Promise<{ ok: true; provider: AiProvider; source: AiBillingSource } | { ok: false; reason: string }>;
  checkQuota: (source: AiBillingSource) => Promise<{ ok: true } | { ok: false; error: string }>;
  record: (r: SourcingAiRecord) => Promise<void>;
};

const SYSTEM = [
  "Bạn là chuyên viên tìm hàng thời trang trên 1688 (Trung Quốc) cho một shop Việt Nam bán cho khách 35–60 tuổi.",
  "Đầu vào: câu tiếng Việt của người dùng, các ý ĐÃ được từ điển dịch, và các cụm CHƯA dịch được.",
  "Việc của bạn: dịch các cụm chưa dịch được sang từ khoá tiếng Trung giản thể thường dùng trên 1688, rồi đề xuất tối đa 3 truy vấn tìm hàng.",
  "KHÔNG bịa thuộc tính người dùng không nói. Cụm không liên quan tới hàng hoá thì bỏ qua, không dịch.",
  'Chỉ trả về MỘT khối JSON, không giải thích: {"terms":[{"vi":"<cụm chưa dịch>","zh":"<từ khoá>"}],"queries":[{"zh":"<truy vấn>","vi":"<giải thích tiếng Việt ngắn>"}]}',
].join("\n");

const CJK = /[㐀-鿿]/;
const replySchema = z.object({
  terms: z.array(z.object({ vi: z.string(), zh: z.string() })).default([]),
  queries: z.array(z.object({ zh: z.string(), vi: z.string() })).default([]),
});

/** Đọc câu trả lời của AI — hàm thuần. Chỉ giữ truy vấn có chữ Hán, ngắn, không trùng từ điển; chỉ giữ «dịch» cho ĐÚNG cụm chưa hiểu. */
export function parseAiReply(text: string, build: QueryBuild): { queries: AiQueryHint[]; terms: AiTermHint[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = replySchema.safeParse(raw);
  if (!parsed.success) return null;
  const known = new Set(build.queries.map((q) => q.zh));
  const queries: AiQueryHint[] = [];
  for (const q of parsed.data.queries) {
    const zh = q.zh.replace(/\s+/g, " ").trim();
    const vi = q.vi.trim().slice(0, 200);
    if (!zh || zh.length > 40 || !CJK.test(zh) || known.has(zh) || queries.some((x) => x.zh === zh)) continue;
    queries.push({ zh, vi });
    if (queries.length >= SOURCING_AI_QUERY_MAX) break;
  }
  const wanted = new Set(build.unmatched.map((u) => u.toLowerCase()));
  const terms = parsed.data.terms
    .map((t) => ({ vi: t.vi.trim().toLowerCase(), zh: t.zh.trim() }))
    .filter((t, i, all) => wanted.has(t.vi) && t.zh.length > 0 && t.zh.length <= 20 && CJK.test(t.zh) && all.findIndex((x) => x.vi === t.vi) === i);
  return { queries, terms };
}

function userPrompt(build: QueryBuild): string {
  return [
    `CÂU NGƯỜI DÙNG: ${build.input}`,
    `ĐÃ DỊCH: ${build.terms.length ? build.terms.map((t) => `${t.text} → ${t.zh[0]}`).join("; ") : "(chưa có)"}`,
    `CHƯA DỊCH ĐƯỢC: ${build.unmatched.length ? build.unmatched.join("; ") : "(không có)"}`,
    build.hasProduct ? "" : "LƯU Ý: từ điển chưa nhận ra LOẠI HÀNG (đầm, áo, quần…).",
    build.queries.length ? `TRUY VẤN TỪ ĐIỂN ĐÃ CÓ (không lặp lại): ${build.queries.map((q) => q.zh).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const empty = (status: AiExpansionStatus, note: string | null, usedToday: number | null, limit: number): AiExpansion => ({ status, queries: [], terms: [], note, usedToday, limit });

export async function expandWithAi(build: QueryBuild, allow: boolean, deps: SourcingAiDeps): Promise<AiExpansion> {
  const { limit } = deps;
  if (!build.needsAi) return empty("NOT_NEEDED", null, null, limit);
  if (!allow) return empty("NOT_REQUESTED", "Từ điển chưa hiểu hết câu — bật «cho phép AI» nếu muốn AI thử phần còn lại.", null, limit);
  if (limit <= 0) return empty("DISABLED", "AI tìm hàng đang tắt (trần 0 lượt / ngày) — chỉ có phần từ điển.", null, limit);
  let used: number | null;
  try {
    used = await deps.usedToday();
  } catch {
    used = null;
  }
  if (used === null) return empty("UNCOUNTABLE", "Không đếm được số lượt AI đã dùng hôm nay — không gọi AI (chưa biết không có nghĩa là còn lượt). Chỉ có phần từ điển.", null, limit);
  if (used >= limit) return empty("QUOTA", `Đã dùng hết ${used}/${limit} lượt AI tìm hàng hôm nay — chỉ có phần từ điển. Trần đổi ở mục «Trần lượt AI».`, used, limit);

  let ai: Awaited<ReturnType<SourcingAiDeps["resolveAi"]>>;
  try {
    ai = await deps.resolveAi();
  } catch (e) {
    ai = { ok: false, reason: e instanceof Error ? e.message : "không rõ" };
  }
  if (!ai.ok) return empty("NO_AI", `Chưa có AI: ${ai.reason}`, used, limit);
  let quota: Awaited<ReturnType<SourcingAiDeps["checkQuota"]>>;
  try {
    quota = await deps.checkQuota(ai.source);
  } catch {
    quota = { ok: false, error: "Không kiểm được hạn mức AI của gói." };
  }
  if (!quota.ok) return empty("QUOTA", quota.error, used, limit);

  const provider = ai.provider;
  const safeRecord = (r: SourcingAiRecord) => deps.record(r).catch(() => undefined);
  try {
    const res = await provider.complete({ system: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: userPrompt(build) }] }], tools: [], maxTokens: 500, reasoning: "low" });
    const model = res.model || provider.model || null;
    await safeRecord({ source: ai.source, provider: provider.name, model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, usage: res.usage, status: "OK" });
    const text = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = parseAiReply(text, build);
    if (!parsed) return { ...empty("UNREADABLE", "AI trả lời không đọc được — chỉ có phần từ điển.", used + 1, limit) };
    const missed = build.unmatched.filter((u) => !parsed.terms.some((t) => t.vi === u.toLowerCase()));
    const note = missed.length ? `AI cũng chưa dịch được: ${missed.join(", ")}.` : null;
    return { status: "OK", queries: parsed.queries, terms: parsed.terms, note, usedToday: used + 1, limit };
  } catch (e) {
    await safeRecord({ source: ai.source, provider: provider.name, model: provider.model || null, inputTokens: null, outputTokens: null, usage: null, status: "ERROR" });
    return empty("ERROR", `AI lỗi (${e instanceof Error ? e.message.slice(0, 120) : "không rõ"}) — chỉ có phần từ điển.`, used + 1, limit);
  }
}
