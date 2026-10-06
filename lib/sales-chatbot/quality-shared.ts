/**
 * ═══════════ RÀ LỖI AI TRÊN HỘI THOẠI THẬT — PHÁT HIỆN LÚC ĐỌC (docs/product-audit.md P7) ═══════════
 *
 * Câu hỏi: «bot đã nói gì sai với khách thật mà chưa ai thấy?». Chấm bằng LUẬT TẤT ĐỊNH, không dùng một AI thứ hai làm giám
 * khảo — giám khảo AI cũng bịa được, và lệnh chủ shop nói rõ không coi phán đoán của một LLM là sự thật. Luật giá DÙNG LẠI
 * ĐÚNG luật của màn phát lại (`replay-shared.ts`: `extractMoneyAmounts` · `ungroundedAmounts`) để hai màn không nói hai
 * điều khác nhau về cùng một câu.
 *
 *  · `PRICE_UNGROUNDED` — câu bot gửi khách có số tiền KHÔNG nằm trong tập căn cứ: giá bảng mẫu mã · phí ship đã khai · số do
 *    công cụ trả trong hội thoại TỚI lúc đó · số bot đã nói trước đó (nhắc lại không phải bịa). Dấu hiệu bịa giá, KHÔNG phải
 *    bằng chứng: bot có thể cộng hai số có căn cứ (tổng đơn) — nên người rà quyết.
 *  · `TOOL_ERROR` — một công cụ trả lỗi trong lượt (bot có thể đã nói tiếp mà không có dữ liệu thật).
 *  · `REPEATED_QUESTION` — khách gửi LẠI y nguyên một câu đã hỏi sau khi bot đã trả lời — dấu hiệu khách không được trả
 *    lời đúng câu hỏi.
 *
 * Phát hiện không có cột trạng thái: một phát hiện CHƯA có dòng rà là «chờ rà». Dòng rà (`sales_ai_reviews`) chỉ là quyết
 * định của người lên phát hiện đó (đúng lỗi / không phải lỗi) — phép chiếu, không phải bản sao (AGENTS §19).
 * HÀM THUẦN: không đọc / ghi CSDL.
 */
import type { AiBlock } from "@/lib/ai/provider";
import { maskPhones } from "@/lib/sales-chatbot/experiment-shared";
import { extractMoneyAmounts, SHOP_SAID_PREFIX, ungroundedAmounts } from "@/lib/sales-chatbot/replay-shared";

export const QUALITY_RULES_VERSION = 1;

export const QUALITY_KINDS = ["PRICE_UNGROUNDED", "TOOL_ERROR", "REPEATED_QUESTION"] as const;
export type QualityKind = (typeof QUALITY_KINDS)[number];

export const QUALITY_KIND_LABEL: Record<QualityKind, string> = {
  PRICE_UNGROUNDED: "Giá không có căn cứ",
  TOOL_ERROR: "Công cụ lỗi",
  REPEATED_QUESTION: "Khách hỏi lại y nguyên",
};

export const QUALITY_SEVERITY: Record<QualityKind, "HIGH" | "MEDIUM" | "LOW"> = { PRICE_UNGROUNDED: "HIGH", TOOL_ERROR: "MEDIUM", REPEATED_QUESTION: "LOW" };

export const REVIEW_STATUSES = ["CONFIRMED", "DISMISSED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_STATUS_LABEL: Record<ReviewStatus | "OPEN", string> = { OPEN: "Chờ rà", CONFIRMED: "Đúng là lỗi", DISMISSED: "Không phải lỗi" };

export type ScanMessage = { seq: number; role: "user" | "assistant"; content: AiBlock[]; at: Date };
export type QualityFinding = { kind: QualityKind; seq: number; at: Date; evidence: string; amounts: number[] };

const EVIDENCE_MAX = 240;
const textOf = (m: ScanMessage) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
const excerpt = (s: string) => maskPhones(s.replace(/\s+/g, " ").trim()).slice(0, EVIDENCE_MAX);
/** Câu khách đủ dài để «hỏi lại y nguyên» có nghĩa (không bắt «dạ», «ok», «alo»). */
const REPEAT_MIN_CHARS = 10;
const normalizeQuestion = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Số trong KẾT QUẢ CÔNG CỤ: JSON mang số nguyên trần (`"total":730000`) mà bộ đọc câu chữ không nhận (nó cần «730.000» /
 * «730k»). Mọi số nguyên ≥ 1.000 trong kết quả công cụ đều là căn cứ — thừa căn cứ chỉ làm luật hiền hơn, không bao giờ cờ
 * nhầm một câu đúng.
 */
function toolAmounts(content: string): number[] {
  const out = new Set(extractMoneyAmounts(content));
  for (const m of content.matchAll(/(?<![\d.,])(\d{4,12})(?![\d.,])/g)) out.add(Number(m[1]));
  return [...out];
}

/**
 * Quét MỘT hội thoại theo thứ tự `seq`. `catalogGrounded` = giá bảng + phí ship của tổ chức. Mỗi tin có tối đa một phát hiện
 * mỗi loại (khoá rà = hội thoại · seq · loại).
 */
export function scanConversation(messages: readonly ScanMessage[], catalogGrounded: ReadonlySet<number>): QualityFinding[] {
  const out: QualityFinding[] = [];
  const grounded = new Set<number>(catalogGrounded);
  const toolName = new Map<string, string>();
  const asked = new Set<string>();
  let botSpokeSinceLast = false;
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    for (const b of m.content) {
      if (b.type === "tool_use") toolName.set(b.id, b.name);
      if (b.type === "tool_result") {
        for (const n of toolAmounts(b.content)) grounded.add(n);
        if (b.isError && !out.some((f) => f.kind === "TOOL_ERROR" && f.seq === m.seq)) {
          out.push({ kind: "TOOL_ERROR", seq: m.seq, at: m.at, evidence: excerpt(`${toolName.get(b.toolUseId) ?? "công cụ"}: ${b.content}`), amounts: [] });
        }
      }
    }
    const text = textOf(m);
    if (!text) continue;
    if (m.role === "assistant") {
      // Tin của NHÂN VIÊN / page (lưu là `assistant` mang «[Shop đã nhắn]») không phải lỗi của bot — nhưng số họ đã nói là căn
      // cứ khi bot nhắc lại.
      if (text.startsWith(SHOP_SAID_PREFIX)) {
        for (const n of extractMoneyAmounts(text)) grounded.add(n);
        botSpokeSinceLast = true;
        continue;
      }
      const bad = ungroundedAmounts(text, grounded);
      if (bad.length) out.push({ kind: "PRICE_UNGROUNDED", seq: m.seq, at: m.at, evidence: excerpt(text), amounts: bad });
      // Số bot đã nói là căn cứ cho các câu SAU (nhắc lại không phải bịa) — kể cả số vừa bị cờ, để một số sai chỉ cờ một lần.
      for (const n of extractMoneyAmounts(text)) grounded.add(n);
      botSpokeSinceLast = true;
      continue;
    }
    const q = normalizeQuestion(text);
    if (q.length >= REPEAT_MIN_CHARS && asked.has(q) && botSpokeSinceLast) out.push({ kind: "REPEATED_QUESTION", seq: m.seq, at: m.at, evidence: excerpt(text), amounts: [] });
    if (q.length >= REPEAT_MIN_CHARS) asked.add(q);
    botSpokeSinceLast = false;
  }
  return out;
}

export type QualitySummary = { conversationsScanned: number; botReplies: number; findings: Record<QualityKind, number>; open: number; confirmed: number; dismissed: number };
