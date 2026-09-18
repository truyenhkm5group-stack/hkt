import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { redactedErrorMessage, runningVersion } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * Health check. Ngoài việc chứng minh tiến trình sống và CSDL kết nối được, còn trả về
 * commit đang chạy để đối chiếu Production với Git — "deploy xanh" không chứng minh được
 * máy chủ đang chạy đúng bản nào. ERP_COMMIT do scripts/install-vps.sh ghi vào .env khi deploy.
 *
 * Việc đọc biến môi trường nằm ở `lib/version.ts` để trang `/tech` và tuyến này đọc CÙNG một chỗ;
 * phong bì trả về giữ nguyên hình dạng cũ (`"unknown"` khi chưa biết) vì `scripts/smoke.ts`, VPS và
 * người đang dùng đã đọc nó nhiều tháng.
 *
 * TUYẾN NÀY CÔNG KHAI (`middleware.ts::PUBLIC_PREFIXES`) — không đăng nhập vẫn gọi được, vì cả
 * workflow deploy lẫn script cài đặt đều hỏi nó trước khi có phiên nào. Nên câu lỗi phải đi qua
 * `redactedErrorMessage()`: lỗi CSDL có thể mang chuỗi kết nối, và kho mã này PUBLIC.
 */
export async function GET() {
  const running = runningVersion();
  const version = { commit: running.commit ?? "unknown", branch: running.branch ?? "unknown" };
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, time: new Date().toISOString(), ...version });
  } catch (error) {
    return NextResponse.json({ ok: false, error: redactedErrorMessage(error), ...version }, { status: 500 });
  }
}
