import { z } from "zod";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";

/**
 * ═══════════ BÁO CÁO CEO HẰNG NGÀY — HẰNG SỐ + LUẬT THUẦN (docs/tech/ai-daily-report.md) ═══════════
 *
 * Agent rủi ro thấp nhất, CHỈ ĐỌC: MÁY gom số bằng các hàm báo cáo sẵn có (không công thức mới); AI chỉ VIẾT LỜI từ khối số đó, và
 * hàng rào `numbersNotInFacts` chặn mọi con số trong lời AI không có trong khối số (cùng cách với hàng rào khẳng định của bot bán
 * hàng: `extractVndAmounts` + `unverifiedAmounts`). Chưa đo được ⇒ `null` ⇒ in «—», không 0 (luật 42).
 *
 * Tệp này KHÔNG đọc / ghi CSDL ⇒ bài kiểm gọi thẳng được.
 */

export const DAILY_REPORT_CONFIG_KEY = "dailyReport.config";

/**
 * Cấu hình của tổ chức. MẶC ĐỊNH TẮT. `hourVn` = giờ VN sớm nhất tạo bản của HÔM QUA (bắt buộc khi bật — không có giờ mặc định).
 * `maxCostUsdPerDay` = trần chi phí AI mỗi ngày; chưa khai ⇒ KHÔNG gọi AI (bản vẫn có khối số), vì không ai đồng ý tiêu tiền vô hạn.
 */
export type DailyReportConfig = { on: boolean; hourVn: number | null; maxCostUsdPerDay: number | null };
export const DAILY_REPORT_OFF: DailyReportConfig = { on: false, hourVn: null, maxCostUsdPerDay: null };

export const dailyReportConfigZ = z
  .object({
    on: z.boolean(),
    hourVn: z.number().int("Giờ là số nguyên").min(0, "Giờ 0–23").max(23, "Giờ 0–23").nullable(),
    maxCostUsdPerDay: z.number().min(0.01, "Trần tối thiểu 0,01 USD").max(100, "Trần tối đa 100 USD").nullable(),
  })
  .strict()
  .refine((v) => !v.on || v.hourVn !== null, { message: "Bật báo cáo thì phải chọn giờ chạy", path: ["hourVn"] });

/** Đọc thận trọng: hỏng / thiếu ⇒ TẮT. HÀM THUẦN. */
export function parseDailyReportConfig(value: unknown): DailyReportConfig {
  const parsed = dailyReportConfigZ.safeParse(value);
  return parsed.success ? parsed.data : DAILY_REPORT_OFF;
}

// ─────────────────────────── KHỐI SỐ ───────────────────────────

export type FactUnit = "count" | "vnd" | "pct";
/** Một con số. `value = null` ⇒ CHƯA ĐO ĐƯỢC (`missing` nói vì sao) — in «—», không bao giờ 0. */
export type Fact = { key: string; label: string; value: number | null; unit: FactUnit; missing?: string };
export type FactSection = { key: string; title: string; facts: Fact[] };
/** Khối số của MỘT ngày báo cáo (`date` = ngày VN được báo cáo, thường là hôm qua). */
export type DailyFacts = { date: string; generatedAt: string; sections: FactSection[] };

export function factText(f: Fact): string {
  if (f.value === null) return "—";
  if (f.unit === "vnd") return formatVND(f.value);
  if (f.unit === "pct") return formatPercent(f.value, 1);
  return formatNumber(f.value);
}

/** Khối số dạng chữ — đúng thứ AI được đọc, và phần đầu của tin gửi đi. HÀM THUẦN. */
export function factsText(facts: DailyFacts): string {
  const lines: string[] = [];
  for (const s of facts.sections) {
    lines.push(`## ${s.title}`);
    for (const f of s.facts) lines.push(`- ${f.label}: ${factText(f)}${f.value === null && f.missing ? ` (chưa đo được: ${f.missing})` : ""}`);
  }
  return lines.join("\n");
}

// ─────────────────────────── HÀNG RÀO SỐ ───────────────────────────

/** Đơn vị theo sau một số ⇒ đó là TIỀN, hàng rào tiền (`extractVndAmounts`) đã xét — lượt số trơn bỏ qua. */
// Đơn vị phải ĐỨNG RIÊNG (không chữ / số liền sau): «15 đơn» không phải «15 đ», «3 trong» không phải «3 tr» (cùng luật PLAIN_CURRENCY_RE
// của hàng rào bot bán hàng).
const MONEY_SUFFIX_RE = /^\s*(?:k|nghìn|ngàn|tr|triệu|tỷ|ty|đ|₫|vnđ|vnd|đồng)(?![\p{L}\d])/iu;

/** Đọc một token số kiểu Việt: «1.234.567» = nghìn; «37,5» / «37.5» = thập phân. HÀM THUẦN. */
export function parseVnNumber(token: string): number | null {
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(token)) return Number(token.replace(/[.,]/g, ""));
  if (/^\d+[.,]\d+$/.test(token)) return Number(token.replace(",", "."));
  if (/^\d+$/.test(token)) return Number(token);
  return null;
}

/** Mọi số TRƠN (không phải tiền) trong câu, kèm cờ phần trăm. HÀM THUẦN. */
export function extractPlainNumbers(text: string): { value: number; percent: boolean; raw: string }[] {
  const out: { value: number; percent: boolean; raw: string }[] = [];
  const re = /\d+(?:[.,]\d+)*/g;
  for (const m of text.normalize("NFC").matchAll(re)) {
    const after = text.slice((m.index ?? 0) + m[0].length);
    if (MONEY_SUFFIX_RE.test(after)) continue;
    const v = parseVnNumber(m[0]);
    if (v === null || !Number.isFinite(v)) continue;
    out.push({ value: v, percent: /^\s*%/.test(after), raw: m[0] });
  }
  return out;
}

/** Tập số HỢP LỆ của khối số: giá trị đếm · tiền · phần trăm (đúng 1 chữ số thập phân và làm tròn nguyên) · ngày / tháng / năm báo cáo. */
export function allowedNumbersOf(facts: DailyFacts): { plain: Set<number>; vnd: Set<number>; pct: Set<number> } {
  const plain = new Set<number>();
  const vnd = new Set<number>();
  const pct = new Set<number>();
  const [y, mo, d] = facts.date.split("-").map(Number);
  for (const n of [y, mo, d]) if (Number.isFinite(n)) plain.add(n);
  for (const s of facts.sections) {
    // Số nằm trong NHÃN của máy («7 ngày», «30 ngày») là chữ của khối số, không phải số bịa.
    for (const n of extractPlainNumbers(s.title)) plain.add(n.value);
    for (const f of s.facts) {
      for (const n of extractPlainNumbers(f.label)) plain.add(n.value);
      if (f.value === null) continue;
      if (f.unit === "vnd") {
        vnd.add(Math.round(f.value));
        plain.add(Math.round(f.value));
      } else if (f.unit === "pct") {
        pct.add(Math.round(f.value * 10) / 10);
        pct.add(Math.round(f.value));
      } else plain.add(f.value);
    }
  }
  return { plain, vnd, pct };
}

/**
 * HÀNG RÀO: mọi con số trong lời AI phải có trong khối số. `vndAmounts` = số tiền đã đọc bằng `extractVndAmounts` (bộ đọc tiền của
 * hàng rào khẳng định bot bán hàng — truyền vào để tệp này thuần), `unverified` = `unverifiedAmounts` của cùng bộ ấy. Trả về các số
 * BỊA (rỗng = qua). HÀM THUẦN.
 */
export function numbersNotInFacts(
  text: string,
  facts: DailyFacts,
  money: { vndAmounts: number[]; unverified: (amounts: readonly number[], allowed: ReadonlySet<number>) => number[] },
): string[] {
  const allowed = allowedNumbersOf(facts);
  const bad = new Set<string>();
  for (const v of money.unverified(money.vndAmounts, allowed.vnd)) bad.add(formatVND(v));
  for (const n of extractPlainNumbers(text)) {
    const ok = n.percent ? allowed.pct.has(Math.round(n.value * 10) / 10) : allowed.plain.has(n.value) || allowed.vnd.has(n.value);
    if (!ok) bad.add(n.percent ? `${n.raw}%` : n.raw);
  }
  return [...bad];
}

// ─────────────────────────── LỜI AI ───────────────────────────

export const DAILY_REPORT_SYSTEM = [
  "Bạn viết BÁO CÁO NGÀY cho chủ shop, tiếng Việt, ngắn gọn, giọng trung tính.",
  "CHỈ dùng số có trong khối DỮ KIỆN, chép ĐÚNG như được viết (cả dấu chấm nghìn và ký hiệu ₫ / %). KHÔNG tự cộng, trừ, chia, làm tròn, so sánh ra số mới.",
  "«—» nghĩa là CHƯA ĐO ĐƯỢC: nói «chưa đo được», TUYỆT ĐỐI không nói là 0.",
  "Không đánh số thứ tự, không ghi ngày giờ ngoài ngày có trong dữ kiện.",
  'Trả về ĐÚNG một đối tượng JSON: {"summary": "<2–4 câu>", "highlights": ["<điểm 1>", "<điểm 2>", "<điểm 3>"]} — không chữ nào ngoài JSON.',
].join("\n");

/** Đọc JSON của AI: đúng một `summary` chữ + đúng 3 `highlights` chữ. Sai hình ⇒ `null`. HÀM THUẦN. */
export function parseAiReport(raw: string): { summary: string; highlights: string[] } | null {
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(raw.slice(a, b + 1)) as { summary?: unknown; highlights?: unknown };
    if (typeof v.summary !== "string" || !v.summary.trim()) return null;
    if (!Array.isArray(v.highlights) || v.highlights.length !== 3 || !v.highlights.every((h) => typeof h === "string" && h.trim())) return null;
    return { summary: v.summary.trim().slice(0, 1200), highlights: (v.highlights as string[]).map((h) => h.trim().slice(0, 400)) };
  } catch {
    return null;
  }
}

export type AiStatus = "OK" | "BLOCKED" | "SKIPPED" | "ERROR";
export const AI_STATUS_LABEL: Record<AiStatus, string> = {
  OK: "AI đã viết lời (qua hàng rào số)",
  BLOCKED: "Lời AI bị chặn — có số không có trong khối số",
  SKIPPED: "Không gọi AI",
  ERROR: "AI lỗi",
};

/** Tin gửi nhóm: khối số (máy) + lời AI nếu qua hàng rào. HÀM THUẦN. */
export function dailyReportMessage(facts: DailyFacts, ai: { status: AiStatus; summary: string | null; highlights: string[]; note: string }, link: string | null): string {
  const [y, m, d] = facts.date.split("-");
  const parts = [`📊 Báo cáo ngày ${d}/${m}/${y}`, factsText(facts)];
  if (ai.status === "OK" && ai.summary) parts.push(`## Tóm tắt (AI viết từ khối số trên)\n${ai.summary}\n${ai.highlights.map((h) => `• ${h}`).join("\n")}`);
  else parts.push(`(${AI_STATUS_LABEL[ai.status]}${ai.note ? `: ${ai.note}` : ""})`);
  if (link) parts.push(`Xem: ${link}/daily-report`);
  return parts.join("\n\n");
}
