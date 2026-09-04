import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, schema } from "@/db";
import { getSession } from "@/lib/auth/session";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";

export const dynamic = "force-dynamic";

/** Lịch sử Viettel Post đẩy webhook cho một vận đơn (gọi trực tiếp API VTP, không lưu) */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Chưa đăng nhập" }, { status: 401 });
  const { id } = await context.params;
  const db = await getDb();
  const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id), columns: { id: true, vtpOrderNumber: true, trackingCode: true } });
  if (!shipment) return NextResponse.json({ ok: false, error: "Không tìm thấy vận đơn" }, { status: 404 });
  const number = shipment.vtpOrderNumber ?? shipment.trackingCode;
  if (!number) return NextResponse.json({ ok: false, error: "Vận đơn chưa có mã Viettel Post" }, { status: 400 });
  const client = getViettelPostClient();
  if (!client.configured) return NextResponse.json({ ok: false, error: "Chưa cấu hình token Viettel Post" }, { status: 400 });
  try {
    const items = await client.listPushHistory(number);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
