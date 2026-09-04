import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { subscribe } from "@/lib/realtime/bus";

export const dynamic = "force-dynamic";

/** Server-Sent Events: đẩy thông báo khi có đơn/vận đơn/tồn kho thay đổi (từ webhook hoặc đồng bộ). */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

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
      unsubscribe = subscribe((event) => send(event));
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
