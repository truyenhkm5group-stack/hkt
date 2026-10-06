import type { PlannedHistoryMessage } from "@/lib/sales-chatbot/history";

/**
 * ═══════════ LỊCH SỬ HỘI THOẠI MESSENGER / INSTAGRAM TRỰC TIẾP — PHẦN THUẦN (gap analysis lát B) ═══════════
 *
 * Meta cho đọc tối đa 20 tin GẦN NHẤT mỗi hội thoại (Conversations API) — lượt nhập vì vậy là MỘT lượt có trần, không có con trỏ
 * nhiều giờ như đường Pancake (#599): mỗi page tối đa `conversationsPerPage` hội thoại mới cập nhật nhất, mỗi lời gọi một trang
 * `pageSize` hội thoại kèm sẵn tin. Ghi qua ĐÚNG đường ghi của #599 (`writeThreadPage` — dấu `imported_at`, `HISTORY`, không gọi
 * bot, không thổi phồng «chưa đọc»).
 */

export const MESSENGER_HISTORY_SETTING_KEY = "ai_sales.messenger_history";
export const MESSENGER_HISTORY_JOB = "messenger-inbox-history";
export const MESSENGER_HISTORY_LIMITS = {
  conversationsPerPage: 200,
  pageSize: 25,
  messagesPerConversation: 20,
  /** Tin mới hơn chừng này không nhập — là việc của webhook / bot (cùng luật #599). */
  freshMinutes: 60,
  /** Lượt RUNNING không xong sau chừng này ⇒ coi như tiến trình đã chết — bấm lại được. */
  staleMs: 15 * 60_000,
} as const;

export type MessengerHistoryStatus = "IDLE" | "RUNNING" | "DONE" | "FAILED";
export const MESSENGER_HISTORY_STATUS_LABEL: Record<MessengerHistoryStatus, string> = { IDLE: "Chưa chạy", RUNNING: "Đang chạy", DONE: "Xong", FAILED: "Có lỗi" };

export type MessengerHistoryPage = { pageId: string; kind: "PAGE" | "INSTAGRAM"; conversations: number; inserted: number; duplicates: number; fresh: number; error: string | null };
export type MessengerHistoryRun = { status: MessengerHistoryStatus; requestedBy: string | null; startedAt: string | null; finishedAt: string | null; pages: MessengerHistoryPage[]; lastError: string | null };

export const EMPTY_MESSENGER_HISTORY: MessengerHistoryRun = { status: "IDLE", requestedBy: null, startedAt: null, finishedAt: null, pages: [], lastError: null };

export function parseMessengerHistoryRun(raw: unknown): MessengerHistoryRun {
  if (!raw || typeof raw !== "object") return EMPTY_MESSENGER_HISTORY;
  const v = raw as Record<string, unknown>;
  const status = (["IDLE", "RUNNING", "DONE", "FAILED"] as const).find((s) => s === v.status) ?? "IDLE";
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const pages = Array.isArray(v.pages)
    ? (v.pages as Record<string, unknown>[]).filter((p) => typeof p?.pageId === "string").map((p) => ({ pageId: String(p.pageId), kind: p.kind === "INSTAGRAM" ? ("INSTAGRAM" as const) : ("PAGE" as const), conversations: num(p.conversations), inserted: num(p.inserted), duplicates: num(p.duplicates), fresh: num(p.fresh), error: str(p.error) }))
    : [];
  return { status, requestedBy: str(v.requestedBy), startedAt: str(v.startedAt), finishedAt: str(v.finishedAt), pages, lastError: str(v.lastError) };
}

export function messengerHistoryStale(run: MessengerHistoryRun, now: Date): boolean {
  return run.status === "RUNNING" && (!run.startedAt || now.getTime() - Date.parse(run.startedAt) > MESSENGER_HISTORY_LIMITS.staleMs);
}

const s = (x: unknown) => (typeof x === "string" ? x : "");

/**
 * MỘT hội thoại của Conversations API ⇒ luồng (PSID / IGSID của khách — đúng mã luồng webhook ghi) + dòng sẽ ghi. Tin của chủ
 * kênh (`from.id` = page / tài khoản Instagram) ⇒ phía PAGE; còn lại ⇒ KHÁCH. Tin mới hơn `freshMs` ⇒ đếm, KHÔNG ghi. Tin page
 * không chữ không ảnh ⇒ bỏ; tin khách không chữ không ảnh (nhãn dán / ghi âm…) ⇒ dòng giữ chỗ để người mở kênh xem. HÀM THUẦN.
 */
export function planGraphConversation(
  conv: unknown,
  ownerId: string,
  opts: { nowMs: number; freshMs: number; mediaOnlyText: string; imageMark: string },
): { threadId: string; name: string; updatedAt: string | null; rows: PlannedHistoryMessage[]; fresh: number } | null {
  const c = (conv && typeof conv === "object" ? conv : {}) as Record<string, unknown>;
  const parts = Array.isArray((c.participants as { data?: unknown } | undefined)?.data) ? ((c.participants as { data: Record<string, unknown>[] }).data) : [];
  const other = parts.find((p) => s(p.id) && s(p.id) !== ownerId);
  const threadId = s(other?.id);
  if (!/^\d{5,40}$/.test(threadId)) return null;
  const name = (s(other?.name) || s(other?.username)).slice(0, 200);
  const msgs = Array.isArray((c.messages as { data?: unknown } | undefined)?.data) ? ((c.messages as { data: Record<string, unknown>[] }).data) : [];
  const rows: PlannedHistoryMessage[] = [];
  let fresh = 0;
  const seen = new Set<string>();
  for (const m of msgs) {
    const id = s(m.id);
    const at = new Date(s(m.created_time));
    if (!id || seen.has(id) || !Number.isFinite(at.getTime())) continue;
    seen.add(id);
    if (opts.nowMs - at.getTime() < opts.freshMs) {
      fresh += 1;
      continue;
    }
    const fromPage = s((m.from as { id?: unknown } | undefined)?.id) === ownerId;
    const text = s(m.message).slice(0, 4000);
    const atts = Array.isArray((m.attachments as { data?: unknown } | undefined)?.data) ? ((m.attachments as { data: Record<string, unknown>[] }).data) : [];
    const images = atts.map((a) => s((a.image_data as { url?: unknown } | undefined)?.url)).filter((u) => u.startsWith("https://")).slice(0, 4);
    if (fromPage) {
      if (!text.trim() && !images.length) continue;
      rows.push({ messageId: id, side: "PAGE", text: text.trim() ? text : opts.imageMark, at, imageUrls: images, customerName: null });
    } else {
      rows.push({ messageId: id, side: "CUSTOMER", text: text.trim() || images.length ? text : opts.mediaOnlyText, at, imageUrls: images, customerName: name || null });
    }
  }
  rows.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { threadId, name, updatedAt: s(c.updated_time) || null, rows, fresh };
}
