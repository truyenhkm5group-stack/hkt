/**
 * ═══════════ BOT CHAT BÁN HÀNG (container `erp-chatbot`) — CHỈ MÁY CHỦ ═══════════
 *
 * Bot Pancake + Gemini chạy thành một tiến trình RIÊNG (mã ở `chatbot/`, dịch vụ `chatbot` trong
 * `docker-compose.prod.yml`), không nằm trong tiến trình ERP. ERP chỉ làm hai việc:
 *   1. Gác cửa: kiểm đăng nhập + quyền rồi mới chuyển tiếp sang API quản trị của bot.
 *   2. Giữ khoá nội bộ `CHATBOT_ADMIN_TOKEN` (install-vps.sh sinh trên máy chủ): khoá chỉ đi từ máy
 *      chủ ERP sang bot trong mạng Docker — không xuống trình duyệt, không vào nhật ký.
 *
 * Bot tự quyết mọi thứ về hội thoại (chốt chặn giá, size, mã mẫu…); ERP không tính lại gì.
 */

import { assertHomeCredentials } from "@/lib/platform/credentials";

const DEFAULT_URL = "http://chatbot:3456";

export function chatbotConfig() {
  return {
    baseUrl: (process.env.CHATBOT_INTERNAL_URL || DEFAULT_URL).replace(/\/+$/, ""),
    token: process.env.CHATBOT_ADMIN_TOKEN || "",
  };
}

/** Gọi API quản trị của bot. Ném lỗi đọc được khi không kết nối được — không bao giờ kèm khoá. */
export async function chatbotFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  // MỘT bot cho cả máy chủ = bot của tổ chức nhà (audit ISO-06): tổ chức khác không quản trị được nó.
  await assertHomeCredentials("chatbot");
  const { baseUrl, token } = chatbotConfig();
  const { timeoutMs, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("x-admin-token", token);
  return fetch(`${baseUrl}${path}`, { ...rest, headers, cache: "no-store", signal: rest.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined) });
}

export type ChatbotFileStatus = { name: string; present: boolean; bytes: number; updatedAt: string | null };

/**
 * Ba trạng thái, ba cách sửa khác nhau — không gộp thành một chữ "lỗi":
 *   UNREACHABLE  — container chưa chạy / chưa deploy (sửa ở VPS);
 *   NEEDS_SETUP  — bot chạy nhưng chưa có .env (nạp tệp từ trang này);
 *   RUNNING      — bot chạy thật.
 */
export type ChatbotStatus =
  | { state: "UNREACHABLE"; error: string }
  | { state: "NEEDS_SETUP" | "RUNNING"; files: ChatbotFileStatus[]; tokenConfigured: boolean };

export async function getChatbotStatus(): Promise<ChatbotStatus> {
  const { token } = chatbotConfig();
  try {
    const health = await chatbotFetch("/health", { timeoutMs: 4000 });
    if (!health.ok) return { state: "UNREACHABLE", error: `Bot trả HTTP ${health.status}` };
    if (!token) return { state: "UNREACHABLE", error: "Máy chủ ERP chưa có CHATBOT_ADMIN_TOKEN (chạy lại deploy để install-vps.sh sinh khoá)" };
    const res = await chatbotFetch("/api/erp/status", { timeoutMs: 4000 });
    if (!res.ok) return { state: "UNREACHABLE", error: res.status === 403 ? "Bot từ chối khoá nội bộ (CHATBOT_ADMIN_TOKEN hai bên không khớp)" : `Bot trả HTTP ${res.status}` };
    const body = (await res.json()) as { configured: boolean; files: ChatbotFileStatus[] };
    return { state: body.configured ? "RUNNING" : "NEEDS_SETUP", files: body.files, tokenConfigured: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { state: "UNREACHABLE", error: `Không kết nối được tới bot (${msg}). Container erp-chatbot chưa chạy hoặc chưa deploy.` };
  }
}

/**
 * Báo cáo trong ngày của Bot lên đơn (chủ shop 02/10/2026: "chỉ cần báo bao nhiêu đơn trong ngày đã xác nhận và bao nhiêu
 * đơn thiếu thông tin"). `null` = không hỏi được bot (CHƯA BIẾT), khác hẳn 0 đơn. Số nào bot không trả thì là `null`
 * riêng số đó — không điền 0.
 */
export type ChatbotOrderSummary = { confirmedToday: number | null; reviewToday: number | null; review: number | null };

export async function getChatbotOrderSummary(): Promise<ChatbotOrderSummary | null> {
  try {
    const res = await chatbotFetch("/api/orderbot", { timeoutMs: 4000 });
    if (!res.ok) return null;
    const body = (await res.json()) as { counts?: { review?: unknown; reviewToday?: unknown; confirmedToday?: unknown } };
    const so = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { confirmedToday: so(body.counts?.confirmedToday), reviewToday: so(body.counts?.reviewToday), review: so(body.counts?.review) };
  } catch {
    return null;
  }
}
