import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { getViettelPostClient } from "@/lib/integrations/viettelpost/client";
import { syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(200) });

/** Tra cứu lại trạng thái Viettel Post cho các vận đơn được chọn */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Chưa đăng nhập" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Danh sách vận đơn không hợp lệ" }, { status: 400 });
  if (!getViettelPostClient().configured) return NextResponse.json({ ok: false, error: "Chưa cấu hình token Viettel Post (VIETTELPOST_API_KEY hoặc tài khoản)" }, { status: 400 });
  try {
    const ids = [...new Set(parsed.data.ids)];
    const result = await syncViettelPostShipments({ shipmentIds: ids, trigger: "MANUAL", actor: session.email, includeFinal: true, limit: ids.length });
    if (result.skippedBecauseRunning) return NextResponse.json({ ok: false, running: true, error: "Đang có tiến trình cập nhật vận đơn, vui lòng thử lại sau" }, { status: 202 });
    return NextResponse.json({ ok: true, run: result.run, summary: result.summary });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
