"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { assignConversationCore, claimConversationCore, releaseConversationCore, sendStaffReplyCore, suggestReplyCore } from "@/lib/sales-chatbot/inbox";
import { setConversationControlCore, setHumanCooldownMinutesCore } from "@/lib/sales-chatbot/conversation-control";
import { setPageConnectionModeCore } from "@/lib/sales-chatbot/channel-ownership";
import type { ConnectionMode } from "@/lib/sales-chatbot/channel-ownership-shared";
import type { ConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { submitConversationFeedbackCore } from "@/lib/sales-chatbot/inbox-feedback";
import { addNoteCore, archiveLabelCore, createLabelCore, deleteNoteCore, setConversationLabelsCore } from "@/lib/sales-chatbot/inbox-labels";
import { STAFF_IMAGE_MAX_BYTES, STAFF_IMAGES_MAX, type InboxLabel, type InboxNote } from "@/lib/sales-chatbot/inbox-shared";

/**
 * ═══════════ SERVER ACTION: HỘP THƯ NGƯỜI (M8) ═══════════
 *
 * Mỏng: phiên → lõi `lib/sales-chatbot/inbox.ts` / `inbox-labels.ts` (quyền, khung gửi của kênh, chống gửi đôi, quy kết theo
 * khoá tài khoản, bot nhường, sổ sự kiện) → `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`, không ném.
 */

const PATH = "/ai/sales-chatbot/inbox";
type Out<T extends object = object> = ({ ok: true } & T) | { error: string };

function done<T extends object>(r: ({ ok: true } & T) | { ok: false; error: string }): Out<T> {
  if (!r.ok) return { error: r.error };
  revalidatePath(PATH);
  return r;
}

/**
 * Gửi tin (chữ + ảnh) — nhận `FormData` vì ảnh là tệp: `text`, `requestKey`, `confirmPaid` ("1"), `images` (nhiều tệp). Trần
 * số / dung lượng kiểm ở đây TRƯỚC khi đọc byte (đọc hết rồi mới chặn là đã tốn bộ nhớ); loại ảnh kiểm từ byte ở lõi.
 */
export async function sendStaffReplyAction(conversationId: string, form: FormData): Promise<Out<{ messageId: string; reused: boolean }>> {
  const user = await requireUser();
  const files = form.getAll("images").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && (f as File).size > 0);
  if (files.length > STAFF_IMAGES_MAX) return { error: `Mỗi tin tối đa ${STAFF_IMAGES_MAX} ảnh.` };
  const big = files.findIndex((f) => f.size > STAFF_IMAGE_MAX_BYTES);
  if (big >= 0) return { error: `Ảnh ${big + 1} quá ${Math.round(STAFF_IMAGE_MAX_BYTES / 1024 / 1024)} MB.` };
  const images = await Promise.all(files.map(async (f) => ({ data: new Uint8Array(await f.arrayBuffer()) })));
  const input = { text: String(form.get("text") ?? ""), requestKey: String(form.get("requestKey") ?? ""), confirmPaid: form.get("confirmPaid") === "1" };
  return done(await sendStaffReplyCore(user, conversationId, input, {}, images));
}

export async function claimConversationAction(conversationId: string): Promise<Out> {
  const user = await requireUser();
  return done(await claimConversationCore(user, conversationId));
}

export async function releaseConversationAction(conversationId: string): Promise<Out> {
  const user = await requireUser();
  return done(await releaseConversationCore(user, conversationId));
}

export async function assignConversationAction(conversationId: string, assigneeUserId: string): Promise<Out> {
  const user = await requireUser();
  return done(await assignConversationCore(user, conversationId, assigneeUserId));
}

/** Tiếp quản / AI gợi ý / Trả lại AI cho MỘT hội thoại (conversation-control.ts) — lý do tuỳ chọn, vào nhật ký. */
export async function setConversationControlAction(conversationId: string, mode: ConversationControl, reason?: string): Promise<Out<{ mode: ConversationControl; changed: boolean }>> {
  const user = await requireUser();
  const r = done(await setConversationControlCore(user, conversationId, mode, reason));
  if ("ok" in r) revalidatePath("/ai/sales-chatbot");
  return r;
}

export async function suggestReplyAction(conversationId: string): Promise<Out<{ suggestion: string }>> {
  const user = await requireUser();
  const r = await suggestReplyCore(user, conversationId);
  return r.ok ? r : { error: r.error };
}

// ───────────────────────────── Nhãn · ghi chú (0211) ─────────────────────────────

export async function createLabelAction(input: { name: string; color: string }): Promise<Out<{ label: InboxLabel; existed: boolean }>> {
  const user = await requireUser();
  return done(await createLabelCore(user, input));
}

export async function archiveLabelAction(labelId: string): Promise<Out> {
  const user = await requireUser();
  return done(await archiveLabelCore(user, labelId));
}

export async function setConversationLabelsAction(conversationId: string, labelIds: string[]): Promise<Out<{ labels: InboxLabel[] }>> {
  const user = await requireUser();
  return done(await setConversationLabelsCore(user, conversationId, labelIds));
}

export async function addNoteAction(conversationId: string, text: string): Promise<Out<{ note: InboxNote }>> {
  const user = await requireUser();
  return done(await addNoteCore(user, conversationId, text));
}

export async function deleteNoteAction(noteId: string): Promise<Out> {
  const user = await requireUser();
  return done(await deleteNoteCore(user, noteId));
}

/** Góp ý của nhân viên cho AI trên một hội thoại ⇒ bài học của bot (lib/sales-chatbot/inbox-feedback.ts). */
export async function submitFeedbackAction(conversationId: string, text: string): Promise<Out<{ message: string; lessons: string[] }>> {
  const user = await requireUser();
  return done(await submitConversationFeedbackCore(user, conversationId, text));
}

/** Chuyển đường nhận tin canonical của MỘT page (Meta trực tiếp ⇄ Pancake) — thao tác tường minh, lý do vào nhật ký (0232). */
export async function setPageConnectionModeAction(pageId: string, mode: ConnectionMode, reason: string): Promise<Out<{ changed: boolean; from: ConnectionMode | null }>> {
  const user = await requireUser();
  return done(await setPageConnectionModeCore(user, pageId, mode, reason));
}

/** Số phút AI tự trả lời lại sau câu tay của nhân viên — cấu hình của workspace (mặc định 30). */
export async function setHumanCooldownMinutesAction(minutes: number): Promise<Out<{ minutes: number; changed: boolean }>> {
  const user = await requireUser();
  return done(await setHumanCooldownMinutesCore(user, minutes));
}
