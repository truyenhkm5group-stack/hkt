import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, getCurrentUser } from "@/lib/auth/session";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";

export const dynamic = "force-dynamic";

/** Yêu cầu Viettel Post gửi lại webhook (toàn bộ hành trình) cho một vận đơn */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // Đây là hành động GHI ra ngoài: gọi sang Viettel Post rồi ghi nhật ký dưới tên người bấm.
  // "Đã đăng nhập" là chưa đủ — phải đúng quyền quản lý vận đơn.
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Chưa đăng nhập" }, { status: 401 });
  if (!can(user, "shipments:manage")) return NextResponse.json({ ok: false, error: "Không có quyền quản lý vận đơn" }, { status: 403 });
  const { id } = await context.params;
  const db = await getDb();
  const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id), columns: { id: true, carrier: true, vtpOrderNumber: true, trackingCode: true } });
  if (!shipment) return NextResponse.json({ ok: false, error: "Không tìm thấy vận đơn" }, { status: 404 });
  const number = shipment.vtpOrderNumber ?? shipment.trackingCode;
  if (!number) return NextResponse.json({ ok: false, error: "Vận đơn chưa có mã Viettel Post" }, { status: 400 });
  const client = getViettelPostClient();
  if (!client.configured) return NextResponse.json({ ok: false, error: "Chưa cấu hình token Viettel Post" }, { status: 400 });
  try {
    const res = await client.rePush(number, true);
    if (res.error) return NextResponse.json({ ok: false, error: `Viettel Post: ${res.message || `mã ${res.status}`}` }, { status: 502 });
    await audit({ userId: user.id, userEmail: user.email, action: "SHIPMENT_REPUSH", entity: "SHIPMENT", entityId: shipment.id, detail: { orderNumber: number, message: res.message } });
    return NextResponse.json({ ok: true, message: res.message || "Đã yêu cầu Viettel Post gửi lại webhook. Hành trình sẽ cập nhật trong ít phút." });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
