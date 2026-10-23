import { NextResponse, type NextRequest } from "next/server";
import { secretEquals } from "@/lib/auth/secret-compare";
import { parseShipmentQuery, SHIPMENT_STATE_TOKEN_HEADER } from "@/lib/constants/shipment-state-api";
import { chatbotConfig } from "@/lib/integrations/chatbot/client";
import { primaryShipmentsByOrders, shipmentStatesByCodes } from "@/lib/queries/shipment-state-internal";

export const dynamic = "force-dynamic";

/**
 * CỬA NỘI BỘ bot nhà → ERP (hợp đồng: lib/constants/shipment-state-api.ts). Khoá chỉ qua HEADER — URL nằm trong access log. Khoá rỗng ở
 * máy chủ ⇒ từ chối mọi lượt (phía hẹp hơn). Không phiên người dùng, không đổi ngữ cảnh tổ chức: chỉ CSDL nhà, đúng như bot nhà.
 */
export async function GET(request: NextRequest) {
  if (!secretEquals(request.headers.get(SHIPMENT_STATE_TOKEN_HEADER), chatbotConfig().token)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = parseShipmentQuery(request.nextUrl.searchParams.get("codes"), request.nextUrl.searchParams.get("orders"));
  if ("error" in q) return NextResponse.json({ error: q.error }, { status: 400 });
  const [states, orders] = await Promise.all([shipmentStatesByCodes(q.codes), primaryShipmentsByOrders(q.orders)]);
  return NextResponse.json({ states, orders }, { headers: { "cache-control": "no-store" } });
}
