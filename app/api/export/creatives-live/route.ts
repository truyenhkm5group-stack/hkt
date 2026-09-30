import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { apiGuard } from "@/lib/auth/api-guard";
import { can } from "@/lib/auth/session";
import { liveRowsToCsv } from "@/lib/constants/creative-live-board";
import { CREATIVE_VERDICT_LABEL } from "@/lib/constants/creative-loop";
import { loadLiveBoard, parseLiveBoardQuery } from "@/lib/queries/creative-live-board";
import type { SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

/**
 * Xuất CSV đúng tập camp đang lọc ở tab ④ Đang chạy (mọi trang, không chỉ trang đang xem). Đọc URL bằng CÙNG hàm
 * `parseLiveBoardQuery` với trang, nên tệp tải về và bảng trên màn hình là một tập. Chỉ đọc; cùng quyền với trang.
 */
export async function GET(request: NextRequest) {
  const guard = await apiGuard(null, { format: "text" });
  if (guard instanceof Response) return guard;
  const { user } = guard;
  if (!can(user, "ideas:view")) return new Response("Không có quyền xuất dữ liệu này", { status: 403 });
  const raw = Object.fromEntries(request.nextUrl.searchParams.entries()) as SearchParams;
  const q = parseLiveBoardQuery(raw);
  const db = await getDb();
  // Một trang đủ lớn để chứa cả tập: phân trang là việc của màn hình, không phải của tệp tải về.
  const data = await loadLiveBoard(db, new Date(), { ...q, page: 1, pageSize: 100_000 });
  const csv = liveRowsToCsv(data.rows, { verdict: CREATIVE_VERDICT_LABEL });
  const tag = [q.period.fromKey ?? "all", q.period.toKey ?? "all"].join("_");
  return new Response(`﻿${csv}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="camp-dang-chay-${tag}.csv"`,
    },
  });
}
