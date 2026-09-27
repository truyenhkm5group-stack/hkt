import { NextResponse, type NextRequest } from "next/server";
import { secretEquals } from "@/lib/auth/secret-compare";
import { env } from "@/lib/env";
import { fanOutOrganizationCodes, listOrganizations } from "@/lib/platform/organizations";

export const dynamic = "force-dynamic";

/**
 * ═══════ DANH SÁCH TỔ CHỨC CHO BỘ LẬP LỊCH — CHỈ `CRON_SECRET`, CHỈ MÃ ═══════
 *
 * `scripts/scheduler.mjs` (khi bật `SCHEDULER_FANOUT=1`) hỏi ở đây mã các tổ chức ĐANG HOẠT ĐỘNG
 * KHÔNG phải nhà, rồi gọi thêm `/api/sync/<job>?org=<mã>` cho những job khai `fanOut`.
 *
 *  · CHỈ bí mật cron trong header. Phiên người dùng — kể cả ADMIN của tổ chức nhà — KHÔNG đọc được:
 *    danh sách khách của nền tảng không phải thứ một màn hình nghiệp vụ cần, và mỗi tuyến đọc được
 *    nó là một cửa để dò xem nền tảng phục vụ ai.
 *  · CHỈ MÃ. Không tên, không trạng thái, không gói — bộ lập lịch không cần, và thứ không trả ra
 *    thì không lộ được.
 *  · Tổ chức nhà KHÔNG có trong danh sách: lịch của nhà đi đường cũ, không mang `?org=`.
 *
 * Tuyến tĩnh này thắng tuyến động `/api/sync/[job]` (Next ưu tiên đoạn tĩnh) — nên không job nào
 * được đặt tên `organizations`; tuyến động chỉ nhận POST nên GET ở đây không che mất gì.
 */
export async function GET(request: NextRequest) {
  const header = request.headers.get("x-cron-secret") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secretEquals(header, env.cronSecret)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  return NextResponse.json({ organizations: fanOutOrganizationCodes(await listOrganizations()) });
}
