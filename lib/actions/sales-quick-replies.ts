"use server";

import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { addQuickReplyImages, deleteQuickReply, quickReplyByKeyword, removeQuickReplyImage, saveQuickReply, saveQuickReplySettings, setQuickReplyActive } from "@/lib/sales-chatbot/quick-replies";
import { QUICK_REPLY_LIMITS } from "@/lib/sales-chatbot/quick-replies-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";

/**
 * Server action của màn hình «Câu trả lời mẫu» (0183 · /ai/sales-chatbot/quick-replies). Mọi thao tác chạy trong tổ chức
 * của PHIÊN; quyền `ai_sales:manage` kiểm ở dịch vụ (`lib/sales-chatbot/quick-replies.ts`).
 */

const PATH = "/ai/sales-chatbot/quick-replies";
type Result = { ok: true; message: string } | { error: string };

export async function saveQuickReplyAction(input: { id?: string | null; title: string; triggers: string; answer: string; active: boolean }): Promise<Result> {
  const user = await requireUser();
  const r = await saveQuickReply(user, { id: input?.id ?? null, title: input?.title, triggers: input?.triggers, answer: input?.answer, active: Boolean(input?.active) });
  if ("error" in r) return r;
  revalidatePath(PATH);
  return { ok: true, message: input?.id ? "Đã lưu câu mẫu" : "Đã thêm câu mẫu" };
}

export async function setQuickReplyActiveAction(id: string, active: boolean): Promise<Result> {
  const user = await requireUser();
  const r = await setQuickReplyActive(user, String(id ?? ""), Boolean(active));
  if ("error" in r) return r;
  revalidatePath(PATH);
  return { ok: true, message: active ? "Đã bật câu mẫu" : "Đã tắt câu mẫu" };
}

export async function deleteQuickReplyAction(id: string): Promise<Result> {
  const user = await requireUser();
  const r = await deleteQuickReply(user, String(id ?? ""));
  if ("error" in r) return r;
  revalidatePath(PATH);
  return { ok: true, message: "Đã xoá câu mẫu" };
}

export async function addQuickReplyImagesAction(form: FormData): Promise<Result> {
  const user = await requireUser();
  const id = String(form.get("id") ?? "");
  const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
  if (files.length === 0) return { error: "Chưa chọn ảnh." };
  if (files.length > QUICK_REPLY_LIMITS.images) return { error: `Tối đa ${QUICK_REPLY_LIMITS.images} ảnh mỗi câu mẫu.` };
  const bytes = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
  const r = await addQuickReplyImages(user, id, bytes);
  if ("error" in r) return r;
  revalidatePath(PATH);
  return { ok: true, message: `Đã thêm ${r.added} ảnh` };
}

export async function removeQuickReplyImageAction(imageId: string): Promise<Result> {
  const user = await requireUser();
  const r = await removeQuickReplyImage(user, String(imageId ?? ""));
  if ("error" in r) return r;
  revalidatePath(PATH);
  return { ok: true, message: "Đã gỡ ảnh" };
}

export async function saveQuickReplySettingsAction(input: { enabled: boolean; aiMatch: boolean }): Promise<Result> {
  const user = await requireUser();
  const r = await saveQuickReplySettings(user, { enabled: Boolean(input?.enabled), aiMatch: Boolean(input?.aiMatch) });
  if ("error" in r) return r;
  revalidatePath(PATH);
  return { ok: true, message: "Đã lưu cách trả lời" };
}

/** Chọn (hoặc bỏ) câu mẫu bot gửi ở bước UPSELL / CROSS-SELL của quy trình bán. */
export async function setUpsellQuickReplyAction(id: string | null): Promise<Result> {
  const user = await requireUser();
  const r = await saveQuickReplySettings(user, { upsellReplyId: id ? String(id) : null });
  if ("error" in r) return r;
  revalidatePath(PATH);
  return { ok: true, message: id ? "Đã chọn câu upsell" : "Đã bỏ câu upsell" };
}

/** Thử khớp CHỮ một câu khách (0 token — không gọi AI): câu mẫu nào sẽ trả lời và câu trả lời sau khi điền số từ ERP. */
export async function tryQuickReplyAction(text: string): Promise<{ ok: true; result: string } | { error: string }> {
  const user = await requireUser();
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  const msg = String(text ?? "").trim().slice(0, 500);
  if (!msg) return { error: "Gõ một câu khách hay hỏi." };
  const step = await quickReplyByKeyword(msg, { ordering: false, cfg: await loadSalesChatbotConfig() });
  if (step.kind === "ANSWER") return { ok: true, result: `Khớp chữ «${step.pick.entry.title}» — bot gửi:\n${step.pick.text}${step.pick.imageIds.length ? `\n(+ ${step.pick.imageIds.length} ảnh)` : ""}` };
  if (step.kind === "SKIP") return { ok: true, result: `Không dùng câu mẫu: ${step.reason} — chatbot AI trả lời.` };
  return { ok: true, result: `Không khớp chữ — ${step.candidates.length > 1 ? `AI đọc hiểu sẽ chọn trong ${step.candidates.length} câu mẫu (nếu bật)` : "AI đọc hiểu sẽ xét (nếu bật)"}; không câu nào hợp thì chatbot AI trả lời.` };
}
