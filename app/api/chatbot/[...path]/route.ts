import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { can, getCurrentUser } from "@/lib/auth/session";
import { chatbotFetch } from "@/lib/integrations/chatbot/client";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * ═══════════ CỬA DUY NHẤT TỪ TRÌNH DUYỆT TỚI BOT CHAT ═══════════
 *
 * `/api/chatbot/<đường>` ⇒ `http://chatbot:3456/<đường>` kèm khoá nội bộ. Giao diện quản trị của bot
 * (`/api/chatbot/admin`) mở trong khung của trang Bot chat, nên mọi lời gọi của nó đều đi qua đây.
 *
 * Quyền: `cs:config` (quy tắc & mẫu tin nhắn khách) — bot nhắn khách thay nhân viên, bật/tắt nó là
 * đổi cách shop nói chuyện với khách, đúng phạm vi của khoá này. Không thêm khoá quyền mới.
 *
 * Nhật ký: mọi lượt GHI (khác GET) vào `audit` với phương thức + đường dẫn. KHÔNG ghi thân yêu cầu:
 * lượt nạp tệp mang khoá Gemini / token page, lượt chat mang tin nhắn khách.
 */
async function forward(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (!can(user, "cs:config")) return NextResponse.json({ error: "Cần quyền CSKH: quy tắc & mẫu tin" }, { status: 403 });

  const { path } = await ctx.params;
  const target = "/" + path.map(encodeURIComponent).join("/");
  const query = new URLSearchParams(request.nextUrl.searchParams);
  query.delete("token"); // khoá do máy chủ gắn, không nhận từ trình duyệt
  const qs = query.toString();

  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await chatbotFetch(target + (qs ? `?${qs}` : ""), {
      method,
      body,
      headers: { "Content-Type": request.headers.get("content-type") ?? "application/json", Accept: request.headers.get("accept") ?? "*/*" },
      signal: request.signal,
    });
  } catch (e) {
    return NextResponse.json({ error: `Không kết nối được tới bot: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  if (hasBody) {
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: target.startsWith("/api/erp/import") ? "CHATBOT_IMPORT" : "CHATBOT_ADMIN",
      entity: "chatbot",
      entityId: target,
      after: { method, status: upstream.status },
      reason: "Thao tác trên trang Bot chat",
    }).catch(() => {});
  }

  // Trả nguyên luồng (giữ SSE /api/events sống), bỏ các đầu mục gắn với kết nối.
  const headers = new Headers();
  for (const k of ["content-type", "cache-control"]) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }
  if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) headers.set("X-Accel-Buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers });
}

export { forward as GET, forward as POST, forward as PUT, forward as DELETE, forward as PATCH };
