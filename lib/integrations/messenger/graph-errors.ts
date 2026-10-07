/**
 * ═══════════ LỖI GRAPH API — PHÂN LOẠI ĐỂ BIẾT AI PHẢI SỬA (docs/meta-production-readiness.md §5) ═══════════
 *
 * Một câu «Facebook từ chối» gộp sáu tình huống mà mỗi cái sửa ở một chỗ khác — và chỉ HAI trong số đó nói rằng KẾT NỐI hỏng:
 *  · TOKEN       — mã 190 / 102: token page hết hiệu lực (người cấp đổi mật khẩu, gỡ quyền app, mất vai trò quản trị page,
 *                  Meta thu hồi). Sửa: chủ page nối lại. Mọi lần gửi sau đều hỏng tới khi nối lại.
 *  · PERMISSION  — mã 200–299 (vd 230 «cần pages_messaging»), mã 10 không thuộc khung nhắn tin: app không còn quyền với page.
 *                  Sửa: nối lại (cấp lại quyền) hoặc App Review.
 *  · WINDOW      — mã 10 phụ 2018278 / mã 100 phụ 2018109: ngoài khung 24 giờ. Kết nối KHÔNG hỏng — chỉ tin này không gửi được.
 *  · RECIPIENT   — mã 551 / mã 100 phụ 2018001: khách chặn page / không nhận tin. Kết nối KHÔNG hỏng.
 *  · RATE_LIMIT  — mã 4 · 17 · 32 · 613 · 80006: chạm trần gọi. Kết nối KHÔNG hỏng, đợi rồi thử lại.
 *  · OTHER       — còn lại (mạng, lỗi tạm của Meta).
 * Gộp thành «kết nối thất bại» là đẩy người đi sửa nhầm chỗ (cùng tinh thần AGENTS luật 55). HÀM THUẦN.
 */

export type GraphErrorKind = "TOKEN" | "PERMISSION" | "WINDOW" | "RECIPIENT" | "RATE_LIMIT" | "OTHER";

const WINDOW_SUBCODES = new Set([2018278, 2018109]);
const RECIPIENT_SUBCODES = new Set([2018001, 2018108]);
const RATE_CODES = new Set([4, 17, 32, 613, 80006]);

export function classifyGraphError(code: number | null | undefined, subcode?: number | null): GraphErrorKind {
  if (code === null || code === undefined) return "OTHER";
  if (subcode && WINDOW_SUBCODES.has(subcode)) return "WINDOW";
  if (subcode && RECIPIENT_SUBCODES.has(subcode)) return "RECIPIENT";
  if (code === 190 || code === 102) return "TOKEN";
  if (code === 551) return "RECIPIENT";
  if (RATE_CODES.has(code)) return "RATE_LIMIT";
  if (code === 10 || (code >= 200 && code <= 299)) return "PERMISSION";
  return "OTHER";
}

/** Lỗi này nói KẾT NỐI hỏng (phải nối lại), không chỉ một tin không gửi được. */
export function needsReconnect(kind: GraphErrorKind | null | undefined): boolean {
  return kind === "TOKEN" || kind === "PERMISSION";
}

/** Câu nói người phải làm gì — gắn sau câu lỗi gốc của Meta. */
export const GRAPH_ERROR_HINT: Record<GraphErrorKind, string> = {
  TOKEN: "Token page hết hiệu lực — chủ page vào Chatbot bán hàng → Messenger, bấm «Đổi page» để nối lại.",
  PERMISSION: "App không còn quyền nhắn tin với page — nối lại page (cấp lại quyền) hoặc kiểm tra App Review.",
  WINDOW: "Ngoài 24 giờ kể từ tin cuối của khách — Meta chặn tin này; chờ khách nhắn lại.",
  RECIPIENT: "Khách không nhận tin từ page (đã chặn hoặc tài khoản không còn).",
  RATE_LIMIT: "Facebook đang giới hạn số lời gọi — thử lại sau ít phút.",
  OTHER: "",
};

/**
 * LOẠI LỖI ĐỌC LẠI TỪ CÂU ĐÃ LƯU — `org_channel_pages.last_error` chỉ giữ CÂU (graph.ts ghép «Facebook từ chối: … — <gợi ý>»),
 * không giữ mã. Gợi ý ở cuối câu là chữ CỦA CHÍNH tệp này nên nhận lại được loại một cách TẤT ĐỊNH; câu không mang gợi ý nào
 * ⇒ `null` (CHƯA BIẾT — không đoán là lỗi kết nối, mục 42). HÀM THUẦN.
 */
export function graphErrorKindOfText(text: string | null | undefined): GraphErrorKind | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  for (const kind of ["TOKEN", "PERMISSION", "WINDOW", "RECIPIENT", "RATE_LIMIT"] as const) if (s.includes(GRAPH_ERROR_HINT[kind])) return kind;
  return null;
}

/**
 * CÂU CHO KHÁCH của từng loại lỗi — lời thường + MỘT việc phải làm, không thuật ngữ kỹ thuật (màn «Kênh kết nối»,
 * lib/channels/overview-shared.ts quét chuỗi). Câu gốc của Meta chỉ hiện cho người vận hành nền tảng.
 */
export const CUSTOMER_GRAPH_ERROR_TEXT: Record<GraphErrorKind, { title: string; action: string }> = {
  TOKEN: { title: "Facebook đã ngắt quyền của ERP với Page này", action: "Bấm «Kết nối lại» và đăng nhập bằng tài khoản quản trị Page." },
  PERMISSION: { title: "ERP không còn quyền nhắn tin thay Page này", action: "Bấm «Kết nối lại» và giữ BẬT mọi quyền Facebook hỏi." },
  WINDOW: { title: "Khách nhắn đã quá 24 giờ nên Facebook chặn tin trả lời", action: "Không cần làm gì — bot trả lời tiếp khi khách nhắn lại." },
  RECIPIENT: { title: "Khách đã chặn Page hoặc không nhận tin", action: "Không cần làm gì với kết nối." },
  RATE_LIMIT: { title: "Facebook đang tạm giới hạn số tin gửi đi", action: "Đợi vài phút — ERP tự gửi lại." },
  OTHER: { title: "Lần gửi tin gần nhất chưa thành công", action: "Bấm «Kiểm tra lại»; nếu vẫn lỗi, bấm «Kết nối lại»." },
};
