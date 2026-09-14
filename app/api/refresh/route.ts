import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, schema } from "@/db";
import { can, getCurrentUser } from "@/lib/auth/session";
import { syncOrderById } from "@/lib/integrations/pancake/sync";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";

export const dynamic = "force-dynamic";

/** Tải lại một đơn từ Pancake và/hoặc một vận đơn từ Viettel Post theo yêu cầu người dùng */
export async function POST(request: NextRequest) {
  // Kéo lại dữ liệu THẬT từ Pancake / Viettel Post cho một bản ghi — chỉ mở cho người vốn đã được
  // xem chính bản ghi đó.
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Chưa đăng nhập" }, { status: 401 });
  if (!can(user, "orders:read") && !can(user, "shipments:view")) return NextResponse.json({ ok: false, error: "Không có quyền tải lại dữ liệu" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { orderId?: string; shipmentId?: string };
  const messages: string[] = [];
  try {
    const db = await getDb();
    let shipmentId = body.shipmentId;
    if (body.orderId) {
      const result = await syncOrderById(body.orderId, { force: true });
      messages.push(`Pancake: ${result === "created" ? "đã tạo" : result === "updated" ? "đã cập nhật" : "không đổi"}`);
      const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.orderId, body.orderId), columns: { id: true } });
      shipmentId = shipmentId ?? shipment?.id;
    }
    if (shipmentId) {
      const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, shipmentId) });
      const number = shipment?.vtpOrderNumber ?? shipment?.trackingCode;
      if (shipment && number && (/viettel/i.test(shipment.carrier) || shipment.vtpOrderNumber)) {
        const client = getViettelPostClient();
        if (client.configured) {
          const record = await client.getOrderDetail(number);
          if (record) {
            const applied = await applyVtpTracking({ ...record, orderNumber: number }, "VTP_POLL");
            messages.push(`Viettel Post: ${applied?.changed ? "có cập nhật mới" : "không đổi"}`);
          } else messages.push("Viettel Post: không tìm thấy vận đơn");
        } else messages.push("Viettel Post: chưa cấu hình token");
      }
    }
    return NextResponse.json({ ok: true, message: messages.join(" · ") || "Không có gì để tải lại" });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
