import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb, schema } from "@/db";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { LIVE_BOARD_DEFAULT_PERIOD } from "@/lib/constants/creative-live-board";
import { variantDailySeries } from "@/lib/queries/creative-loop";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

/**
 * Chuỗi THEO NGÀY của một camp (tab ④ Đang chạy, nút "Theo ngày"). Chỉ đọc. Kỳ đọc từ CÙNG tham số URL với trang
 * (`period` / `from` / `to`, mặc định của tab), nên cộng các ngày lại ra đúng số của dòng camp trên bảng.
 */
export async function GET(request: NextRequest) {
  const guard = await apiGuard(null);
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "ideas:view")) return NextResponse.json({ ok: false, error: "Không có quyền xem số đo camp" }, { status: 403 });
  const raw = Object.fromEntries(request.nextUrl.searchParams.entries()) as SearchParams;
  const id = String(raw.variant ?? "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "Thiếu mã mẫu" }, { status: 400 });

  const db = await getDb();
  const cv = schema.creativeVariants;
  const cb = schema.creativeBatches;
  const [row] = await db.select({ fbAdId: cv.fbAdId, startAt: cb.startAt }).from(cv).innerJoin(cb, eq(cb.id, cv.batchId)).where(eq(cv.id, id)).limit(1);
  if (!row) return NextResponse.json({ ok: false, error: "Không tìm thấy mẫu" }, { status: 404 });

  const period = resolvePeriod(raw, LIVE_BOARD_DEFAULT_PERIOD);
  const window = period.key === "all" ? null : { from: period.from, to: period.to };
  const series = await variantDailySeries(db, { fbAdId: row.fbAdId, startAt: new Date(row.startAt) }, window, new Date());
  return NextResponse.json({ ok: true, periodLabel: period.label, ...series });
}
