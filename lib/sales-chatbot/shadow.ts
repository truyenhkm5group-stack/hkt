import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { appendContextMessages, chatTurn, openConversation } from "@/lib/sales-chatbot/engine";

/**
 * ═══════════ LƯỢT BÓNG — AI TRẢ LỜI MÀ KHÔNG AI NHẬN ĐƯỢC ═══════════
 *
 * Dùng chung cho «Phát lại hội thoại cũ» (replay.ts) và chế độ COPILOT (operating-mode.ts): mở một hội thoại kênh THỬ, nạp
 * lịch sử, gọi ĐÚNG `chatTurn` của đường bán thật rồi XOÁ hội thoại tạm. Kênh THỬ ⇒ công cụ ghi chỉ mô phỏng: không khách,
 * không đơn, không giữ hàng, không tin nhắn nào rời máy. Hội thoại tạm mang `created_by = <tag>` để nếu không xoá được (một
 * bảng khác còn tham chiếu) nó vẫn được nhận ra và ĐÓNG — không bao giờ trông như khách thật.
 */
export type ShadowResult = { ok: boolean; reply: string; status: string | null; tools: { name: string; ok: boolean; summary: string }[]; error: string | null };

export async function shadowTurn(input: { tag: string; history: readonly { role: "user" | "assistant"; text: string }[]; text: string; actorId?: string | null; context?: string }): Promise<ShadowResult> {
  let tempId: string | null = null;
  try {
    const conv = await openConversation("TEST", { createdBy: input.tag });
    tempId = conv.id;
    await appendContextMessages(conv.id, input.history.map((m) => ({ role: m.role, text: m.text.replace(/^\[Shop đã nhắn\]\s*/, "") })));
    const res = await chatTurn(conv.id, input.text, { channel: "TEST", actorId: input.actorId ?? null, ...(input.context ? { context: input.context } : {}) });
    if (!res.ok) return { ok: false, reply: "", status: null, tools: [], error: res.error };
    const msgs = res.view.messages;
    const lastUser = msgs.map((x) => x.role).lastIndexOf("user");
    const after = msgs.slice(lastUser + 1).filter((x) => x.role === "assistant");
    return { ok: true, reply: after.map((x) => x.text).filter(Boolean).join("\n").trim(), status: res.view.status, tools: after.flatMap((x) => x.tools ?? []), error: null };
  } catch (e) {
    return { ok: false, reply: "", status: null, tools: [], error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) };
  } finally {
    if (tempId) await dropShadowConversation(tempId).catch(() => undefined);
  }
}

async function dropShadowConversation(id: string) {
  const db = await getDb();
  const c = schema.salesChatConversations;
  await db
    .delete(c)
    .where(eq(c.id, id))
    .catch(() => db.update(c).set({ status: "CLOSED" }).where(eq(c.id, id)));
}
