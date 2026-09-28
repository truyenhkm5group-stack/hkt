import { NextResponse, type NextRequest } from "next/server";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { getPhoneReputationForOrders, MAX_ORDERS_PER_CALL } from "@/lib/queries/phone-reputation";

export const dynamic = "force-dynamic";

/**
 * Uy tín SĐT theo Pancake cho một lô đơn CHỜ XUẤT — nguồn của hai cột "Tỷ lệ hoàn" / "Cảnh báo SĐT"
 * trên /products/reserved. Nhận MÃ ĐƠN, không nhận SĐT; đơn không đang chờ xuất bị bỏ qua (xem
 * `getPhoneReputationForOrders`). Cùng quyền với trang Sản phẩm.
 */
export async function POST(request: NextRequest) {
  const guard = await apiGuard("products:view");
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "products:view")) return NextResponse.json({ error: "Không có quyền xem dữ liệu này" }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Thân yêu cầu không phải JSON" }, { status: 400 });
  }
  const ids = (body as { orderIds?: unknown })?.orderIds;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string") || ids.length > MAX_ORDERS_PER_CALL) {
    return NextResponse.json({ error: `orderIds phải là danh sách tối đa ${MAX_ORDERS_PER_CALL} mã đơn` }, { status: 400 });
  }
  return NextResponse.json({ data: await getPhoneReputationForOrders(ids as string[]) });
}
