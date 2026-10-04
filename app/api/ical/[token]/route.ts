import { NextResponse, type NextRequest } from "next/server";
import { feedExcludeChannel, serveStayFeed } from "@/lib/stays/feed";

export const dynamic = "force-dynamic";

/**
 * Lịch .ics của MỘT phòng cho Airbnb / Booking / Agoda tự tải (module `stays`, 0198 · lib/stays/feed.ts). Không phiên: token
 * trong đường dẫn chọn tổ chức và phòng; mọi nhánh sai trả cùng một 404.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const r = await serveStayFeed(token, feedExcludeChannel(request.nextUrl.searchParams.get("kenh")));
  if (r.status !== 200) return new NextResponse("Không có lịch này", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new NextResponse(r.body, {
    status: 200,
    headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `inline; filename="${r.filename}"`, "cache-control": "no-store" },
  });
}
