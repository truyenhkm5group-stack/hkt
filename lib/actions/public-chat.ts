"use server";

import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { clientIpFrom } from "@/lib/auth/client-ip";
import type { ChatView } from "@/lib/sales-chatbot/config";
import { visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { refreshPublicChat, sendPublicChat, startPublicChat, type PublicChatOpened } from "@/lib/sales-chatbot/public";

/**
 * ═══════════ SERVER ACTION CỦA TRANG CHAT CÔNG KHAI (0180) — KHÔNG CẦN ĐĂNG NHẬP ═══════════
 *
 * Mỏng: chỉ lo cookie khách truy cập (`erp_chat_v`, ngẫu nhiên, httpOnly) và IP của người gọi, rồi gọi lõi
 * `lib/sales-chatbot/public.ts` — lõi lấy tổ chức từ HOST (chỉ tổ chức đã xuất bản), áp trần tần suất theo khách · IP · tổ chức
 * (`lib/sales-chatbot/public-chat-limits.ts`) và chạy trong ngữ cảnh tường minh của tổ chức. Không nhận mã tổ chức từ client.
 * Hội thoại khoá theo BĂM của cookie: đoán được id hội thoại cũng không đọc / gõ tiếp hội thoại của người khác.
 *
 * IP: phần Caddy ghi vào `X-Forwarded-For` (ngoài cùng bên phải — `clientIpFrom`, cùng cách màn đăng nhập), KHÔNG BAO GIỜ phần
 * client tự khai, không đọc `X-Real-IP`. Không có / không tin được ⇒ lõi bỏ chiều IP, vẫn áp trần khách + tổ chức.
 */

const VISITOR_COOKIE = "erp_chat_v";

async function visitorKey(create: boolean): Promise<string | null> {
  const jar = await cookies();
  let raw = jar.get(VISITOR_COOKIE)?.value ?? "";
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(raw)) {
    if (!create) return null;
    raw = randomBytes(24).toString("base64url");
    // Ô chat NHÚNG website của shop (`/chat/embed` trong iframe) là bối cảnh BÊN THỨ BA: cookie `lax` không được gửi ⇒ mỗi
    // tin là một khách mới. `none` + `partitioned` (CHIPS): trình duyệt gửi cookie trong khung nhưng KHOÁ theo website đang
    // nhúng — không theo dấu được khách giữa hai website. Server action vẫn được Next kiểm Origin = host của ERP.
    const prod = process.env.NODE_ENV === "production";
    jar.set(VISITOR_COOKIE, raw, { httpOnly: true, sameSite: prod ? "none" : "lax", secure: prod, partitioned: prod, path: "/", maxAge: 30 * 24 * 3600 });
  }
  return visitorKeyOf(raw);
}

async function requestIp(): Promise<string> {
  return clientIpFrom((await headers()).get("x-forwarded-for"));
}

const SESSION_GONE = "Phiên chat đã hết — tải lại trang để bắt đầu lại.";

export async function startPublicChatAction(): Promise<PublicChatOpened> {
  return startPublicChat(await visitorKey(true), { ip: await requestIp() });
}

export async function sendPublicChatAction(conversationId: string, text: string): Promise<{ ok: true; view: ChatView } | { error: string; view?: ChatView | null }> {
  const key = await visitorKey(false);
  if (!key) return { error: SESSION_GONE };
  return sendPublicChat(key, String(conversationId ?? ""), String(text ?? ""), { ip: await requestIp() });
}

/** Khung chat tự đọc lại hội thoại đang mở (tin nhân viên trả lời) — chỉ đọc, không mở hội thoại mới, không gọi AI. */
export async function refreshPublicChatAction(conversationId: string): Promise<{ ok: true; view: ChatView } | { error: string }> {
  const key = await visitorKey(false);
  if (!key) return { error: SESSION_GONE };
  return refreshPublicChat(key, String(conversationId ?? ""));
}
