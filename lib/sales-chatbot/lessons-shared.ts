/**
 * ═══════════ BOT TỰ HỌC TỪ HỘI THOẠI THẬT — PHẦN THUẦN (client import được) ═══════════
 *
 * Chủ shop Hải Sản Làng Chài 03/10/2026: «Hãy cho chat bot tự học hội thoại liên tục để chat khôn hơn, tối ưu hơn qua từng cuộc
 * hội thoại, từng câu chat». «Học từ hội thoại cũ» (playbook.ts) chỉ chạy khi chủ shop bấm, đọc lịch sử Pancake và cần người
 * xuất bản — không học từ những lần bot làm sai mỗi ngày.
 *
 * Tự học (lessons.ts) đọc hội thoại fanpage ĐÃ LƯU trong ERP (`sales_chat_inbound` có đủ ba giọng: KHÁCH · BOT · SHOP — tức
 * nhân viên / trả lời tự động của page), cứ `everyMs` một lần, cho AI của shop rút ra BÀI HỌC cụ thể «Khi … ⇒ …» và cập nhật
 * danh sách bài học đang dùng (giữ bài đúng, sửa bài sai, gộp trùng). Nguồn học mạnh nhất: chỗ NHÂN VIÊN phải vào trả lời thay
 * bot (câu của nhân viên là mẫu đúng) và chỗ khách phàn nàn. Bài học vào lời nhắc NGAY (không chờ duyệt) nhưng: không được trái
 * luật cứng, mọi con số giá bị lọc (`stripPrices`), SĐT / tên khách được che trước khi gửi AI; chủ shop xem · sửa · xoá · quay
 * lại bản trước · tắt được.
 */
import { foldVi } from "@/lib/sales-chatbot/text";
import { redactForLearning, stripPrices } from "@/lib/sales-chatbot/playbook-shared";

export const LESSONS_SETTING_KEY = "ai.salesChatbot.lessons";

export const LESSON_LIMITS = {
  maxLessons: 25,
  lessonChars: 220,
  /** Tối thiểu giữa hai lượt tự học. */
  everyMs: 6 * 3_600_000,
  /** Lượt tự động cần ít nhất chừng này hội thoại mới (bấm «Học ngay» thì không cần). */
  minThreads: 3,
  maxThreads: 60,
  linesPerThread: 40,
  transcriptChars: 45_000,
  history: 5,
} as const;

export type LessonVersion = { version: number; lessons: string[]; at: string; by: string };
export type LessonsRun = { at: string; status: "RUNNING" | "OK" | "SKIPPED" | "ERROR"; threads: number; note: string };
export type LessonsState = {
  enabled: boolean;
  lessons: string[];
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Bản trước (mới nhất CUỐI) — quay lại được. */
  history: LessonVersion[];
  lastRun: LessonsRun | null;
  /** Hội thoại có tin tới SAU mốc này mới là «mới» với lượt học kế tiếp. */
  learnedUntil: string | null;
};

export const EMPTY_LESSONS: LessonsState = { enabled: true, lessons: [], version: 0, updatedAt: null, updatedBy: null, history: [], lastRun: null, learnedUntil: null };

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseLessonsState(raw: unknown): LessonsState {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const run = o.lastRun && typeof o.lastRun === "object" ? (o.lastRun as Record<string, unknown>) : null;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    lessons: normalizeLessons(strList(o.lessons)),
    version: typeof o.version === "number" && Number.isInteger(o.version) ? o.version : 0,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
    updatedBy: typeof o.updatedBy === "string" ? o.updatedBy : null,
    history: (Array.isArray(o.history) ? o.history : [])
      .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === "object")
      .map((h) => ({ version: Number(h.version) || 0, lessons: strList(h.lessons), at: String(h.at ?? ""), by: String(h.by ?? "") }))
      .slice(-LESSON_LIMITS.history),
    learnedUntil: typeof o.learnedUntil === "string" ? o.learnedUntil : null,
    lastRun: run && typeof run.at === "string" ? { at: run.at, status: (["RUNNING", "OK", "SKIPPED", "ERROR"].includes(String(run.status)) ? run.status : "ERROR") as LessonsRun["status"], threads: Number(run.threads) || 0, note: String(run.note ?? "") } : null,
  };
}

/** Làm sạch danh sách bài học: bỏ đầu dòng, bỏ mọi con số giá, bỏ trùng (không dấu), cắt độ dài, tối đa `maxLessons`. HÀM THUẦN. */
export function normalizeLessons(list: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const t = stripPrices(raw.replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, "").replace(/\s+/g, " ").trim()).text.trim().slice(0, LESSON_LIMITS.lessonChars);
    const key = foldVi(t);
    if (t.length < 8 || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= LESSON_LIMITS.maxLessons) break;
  }
  return out;
}

/** Chữ trả về của AI ⇒ danh sách bài học (mảng JSON chuỗi, có thể nằm trong khối ```json). `null` khi không đọc được. HÀM THUẦN. */
export function parseLessonsFromAi(text: string): string[] | null {
  const m = /\[[\s\S]*\]/.exec(text.replace(/```(?:json)?/gi, ""));
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(v)) return null;
    return normalizeLessons(v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String((x as { lesson?: unknown; text?: unknown }).lesson ?? (x as { text?: unknown }).text ?? "") : "")));
  } catch {
    return null;
  }
}

/** Khối lời nhắc cho bot — `""` khi tắt / chưa có bài học. HÀM THUẦN. */
export function lessonsPrompt(state: Pick<LessonsState, "enabled" | "lessons">): string {
  if (!state.enabled || !state.lessons.length) return "";
  return [
    "BÀI HỌC TỪ HỘI THOẠI THẬT CỦA SHOP (bot tự học hằng ngày từ chỗ nhân viên phải sửa / khách phàn nàn / đơn chốt được — làm theo, nhưng KHÔNG được trái các luật trên; giá / tồn / phí ship vẫn CHỈ từ công cụ):",
    ...state.lessons.map((l) => `- ${l}`),
  ].join("\n");
}

export type TranscriptLine = { who: "KHÁCH" | "BOT" | "SHOP"; text: string };

/** Một hội thoại ⇒ đoạn chép đã che (số, link, email, tên khách), bỏ dòng rỗng / trùng liền nhau, giữ `linesPerThread` dòng cuối. HÀM THUẦN. */
export function lessonTranscript(lines: readonly TranscriptLine[], outcome: string, names: readonly string[] = []): string | null {
  const out: string[] = [];
  for (const l of lines) {
    const t = redactForLearning(l.text, names);
    if (!t) continue;
    const row = `${l.who}: ${t}`;
    if (out[out.length - 1] === row) continue;
    out.push(row);
  }
  const tail = out.slice(-LESSON_LIMITS.linesPerThread);
  if (!tail.some((r) => r.startsWith("KHÁCH:")) || !tail.some((r) => !r.startsWith("KHÁCH:"))) return null;
  return [outcome, ...tail].join("\n");
}

export const LESSONS_SYSTEM = [
  "Bạn là trưởng nhóm bán hàng online của shop. Bạn đọc các hội thoại THẬT trên fanpage giữa KHÁCH, BOT (chatbot AI) và SHOP (nhân viên / trả lời tự động của page), rồi cập nhật BẢN BÀI HỌC cho BOT để lần sau bán tốt hơn.",
  "Tìm: chỗ BOT trả lời sai, dài dòng, hỏi thừa (vd xin lại thông tin khách đã cho), hỏi lại câu vừa hỏi, làm khách khó chịu hoặc bỏ đi; chỗ SHOP phải vào trả lời thay BOT — câu của SHOP là MẪU ĐÚNG, học cả câu chữ; mẫu câu đã chốt được đơn.",
  "Mỗi bài học MỘT dòng, dạng «Khi <tình huống cụ thể> ⇒ <làm gì / nói câu gì>», tối đa 200 ký tự, áp dụng được cho khách sau. KHÔNG ghi giá, số tiền, SĐT, tên khách, địa chỉ khách. Không lặp lại luật chung kiểu «hãy lịch sự».",
  "GIỮ bài học cũ còn đúng, SỬA bài học bị hội thoại mới chứng minh là sai, GỘP bài trùng, BỎ bài vô dụng. Tối đa 25 bài, bài quan trọng nhất trước.",
  'Chỉ trả về MỘT mảng JSON các chuỗi, vd ["Khi …  ⇒ …", "…"]. Không giải thích.',
].join("\n");
