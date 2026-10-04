"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import type { FieldError } from "@/lib/metadata/types";
import { chatOrderContext, createOrderFromChatCore, type ChatOrderContext } from "@/lib/records/chat-order";

/**
 * ═══════════ SERVER ACTION: TẠO ĐƠN TRONG KHUNG CHAT (POS tự chủ · P5) ═══════════
 *
 * Mỏng: phiên → lõi `lib/records/chat-order.ts` (quyền `orders:write`, hội thoại có thật và không phải khung thử, đường tạo đơn
 * tay chung, gắn đơn về hội thoại, sự kiện HUMAN, nhật ký) → `revalidatePath`. Lỗi nghiệp vụ trả `{ error }`, không ném.
 */

type Failure = { error: string; errors: FieldError[] };

export async function chatOrderContextAction(conversationId: string): Promise<{ ok: true; context: ChatOrderContext } | Failure> {
  const user = await requireUser();
  const r = await chatOrderContext(user, conversationId);
  if (!r.ok) return { error: r.errors.map((e) => e.message).join(" · ") || "Không mở được form.", errors: r.errors };
  return { ok: true, context: r.value };
}

export async function createOrderFromChatAction(conversationId: string, input: unknown): Promise<{ ok: true; orderId: string; message: string } | Failure> {
  const user = await requireUser();
  const r = await createOrderFromChatCore(user, conversationId, input);
  if (!r.ok) return { error: r.errors.map((e) => e.message).join(" · ") || "Không tạo được đơn.", errors: r.errors };
  revalidatePath("/orders");
  revalidatePath("/ai/sales-chatbot");
  const who = r.customerExisting === true ? " · dùng khách đã có cùng SĐT (không sửa hồ sơ)" : r.customerExisting === false ? " · đã tạo khách mới" : "";
  return { ok: true, orderId: r.orderId, message: r.reused ? "Đơn này đã được tạo ở lượt bấm trước — không tạo thêm." : `Đã tạo đơn${who}` };
}
