import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, schema } from "@/db";
import { getSession } from "@/lib/auth/session";
import { syncOrderById } from "@/lib/integrations/pancake/sync";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";

export const dynamic = "force-dynamic";

/** Tải lại một đơn từ Pancake và/hoặc một vận đơn từ Viettel Post theo yêu cầu người dùng */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Chưa đăng nhập" }, { status: 401 });
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
