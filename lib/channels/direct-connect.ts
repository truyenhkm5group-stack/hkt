import type { SessionUser } from "@/lib/auth/session";
import { directConnectAllowed } from "@/lib/channels/direct-connect-shared";
import { readDirectConnectOpen } from "@/lib/platform/direct-connect-flag";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

/**
 * Người đang xem có được thấy nút nối thẳng Facebook thật không — quyền đọc qua `platformOperatorDenial` (dùng `can()` có sẵn),
 * hỏi TRƯỚC lượt đọc cờ ở control plane (`lib/platform/direct-connect-flag.ts`). Xem `direct-connect-shared.ts` cho luật.
 */
/**
 * Trang CÔNG KHAI (không phiên): người đọc không phải người vận hành và không thuộc cửa hàng nào ⇒ cùng `directConnectAllowed`, nên
 * chỉ «mở» khi cờ = mọi cửa hàng. Cờ danh sách (cửa hàng thử / người duyệt Meta) KHÔNG đổi chữ trên trang giới thiệu.
 */
export async function directConnectPublic(): Promise<boolean> {
  return directConnectAllowed({ operator: false, open: await readDirectConnectOpen(), orgCode: null });
}

export async function directConnectFor(user: SessionUser): Promise<boolean> {
  const operator = platformOperatorDenial(user) === null;
  if (operator) return true;
  return directConnectAllowed({ operator, open: await readDirectConnectOpen(), orgCode: user.organization?.code ?? null });
}
