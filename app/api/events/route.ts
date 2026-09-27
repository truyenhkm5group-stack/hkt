import type { NextRequest } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { currentOrganization, OrgContextError } from "@/lib/platform/context";
import { subscribeOrganization } from "@/lib/realtime/bus";

export const dynamic = "force-dynamic";

/** Server-Sent Events: đẩy thông báo khi có đơn/vận đơn/tồn kho thay đổi (từ webhook hoặc đồng bộ). */
export async function GET(request: NextRequest) {
  const guard = await apiGuard(null, { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "dashboard:view")) return new Response("Không có quyền", { status: 403 });

  /*
    TỔ CHỨC CỦA KẾT NỐI — XÁC ĐỊNH MỘT LẦN, LÚC MỞ (audit ISO-08).

    Kết nối SSE sống hàng giờ; người nghe trên bus chạy trong ngữ cảnh của NGƯỜI PHÁT (job, webhook
    của tổ chức khác), nên không được hỏi lại "đang là ai" bên trong người nghe. Chụp mã ở đây,
    rồi chỉ nhận sự kiện đóng dấu ĐÚNG mã đó. Không xác định được ⇒ từ chối, không rơi về nhà.
  */
  let orgCode: string;
  try {
    orgCode = (await currentOrganization()).code;
  } catch (error) {
    if (error instanceof OrgContextError) return new Response("Phiên không thuộc tổ chức nào đang hoạt động", { status: 403 });
    throw error;
  }

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let interval: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // stream đã đóng
        }
      };
      send({ type: "hello", at: Date.now() });
      // Người nghe chỉ ghi vào luồng — không truy vấn CSDL (nó chạy trong ngữ cảnh của người phát).
      unsubscribe = subscribeOrganization(orgCode, (event) => send(event));
      interval = setInterval(() => send({ type: "ping", at: Date.now() }), 25_000);
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        if (interval) clearInterval(interval);
        try {
          controller.close();
        } catch {
          // ignore
        }
      });
    },
    cancel() {
      unsubscribe();
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
