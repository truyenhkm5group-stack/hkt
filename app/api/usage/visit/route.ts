import { NextResponse } from "next/server";
import { NAV_TITLES } from "@/components/app-sidebar";
import { apiGuard } from "@/lib/auth/api-guard";
import { usageKeyOf, usageKeysFrom } from "@/lib/constants/page-usage";
import { recordPageVisit } from "@/lib/usage/page-visits";

export const dynamic = "force-dynamic";

const KEYS = usageKeysFrom(Object.keys(NAV_TITLES));

/**
 * +1 LƯỢT MỞ TRANG (`components/page-visit-beacon.tsx` gửi mỗi lần đổi trang).
 *
 * Chỉ cần PHIÊN, không cần khoá quyền nào: ai đã mở được trang thì lượt mở ấy là thật, và tuyến này
 * không đọc cũng không trả một dòng dữ liệu nghiệp vụ nào. Đường dẫn gửi lên chỉ được dùng để TRA
 * mục đã khai — không bao giờ được lưu nguyên văn — nên gửi rác vào đây chỉ làm tăng ô "(khác)".
 * Lỗi ghi bị nuốt: một bộ đếm hỏng không được làm hỏng lượt điều hướng của người dùng.
 */
export async function POST(request: Request) {
  const guard = await apiGuard();
  if (guard instanceof Response) return guard;
  let path: unknown = null;
  try {
    const body = (await request.json()) as { path?: unknown };
    path = body?.path;
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const key = usageKeyOf(path, KEYS);
  if (key) {
    try {
      await recordPageVisit(key);
    } catch (e) {
      console.warn("[page-usage] không ghi được lượt mở trang:", e instanceof Error ? e.message : e);
    }
  }
  return new NextResponse(null, { status: 204 });
}
