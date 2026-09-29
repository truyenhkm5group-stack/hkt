"use server";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { ChatView } from "@/lib/sales-chatbot/config";
import { visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { sendPublicChat, startPublicChat, type PublicChatOpened } from "@/lib/sales-chatbot/public";

/**
 * ═══════════ SERVER ACTION CỦA TRANG CHAT CÔNG KHAI (0180) — KHÔNG CẦN ĐĂNG NHẬP ═══════════
 *
 * Mỏng: chỉ lo cookie khách truy cập (`erp_chat_v`, ngẫu nhiên, httpOnly) rồi gọi lõi `lib/sales-chatbot/public.ts` — lõi
 * lấy tổ chức từ HOST (chỉ tổ chức đã xuất bản) và chạy trong ngữ cảnh tường minh của nó. Không nhận mã tổ chức từ client.
 * Hội thoại khoá theo BĂM của cookie: đoán được id hội thoại cũng không đọc / gõ tiếp hội thoại của người khác.
 */

const VISITOR_COOKIE = "erp_chat_v";

async function visitorKey(create: boolean): Promise<string | null> {
  const jar = await cookies();
  let raw = jar.get(VISITOR_COOKIE)?.value ?? "";
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(raw)) {
    if (!create) return null;
    raw = randomBytes(24).toString("base64url");
    jar.set(VISITOR_COOKIE, raw, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 24 * 3600 });
  }
  return visitorKeyOf(raw);
}

export async function startPublicChatAction(): Promise<PublicChatOpened> {
  return startPublicChat(await visitorKey(true));
}

export async function sendPublicChatAction(conversationId: string, text: string): Promise<{ ok: true; view: ChatView } | { error: string; view?: ChatView | null }> {
  const key = await visitorKey(false);
  if (!key) return { error: "Phiên chat đã hết — tải lại trang để bắt đầu lại." };
  return sendPublicChat(key, String(conversationId ?? ""), String(text ?? ""));
}
