import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getReturnRateByVariant } from "@/lib/queries/return-rate";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Xuất CSV tỷ lệ hoàn theo mã hàng (cùng bộ lọc với trang báo cáo) */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const sp: SearchParams = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    sp[key] = value;
  });
  const period = resolvePeriod(sp, "90d");
  const q = param(sp, "q");
  const minShipped = Math.max(1, Number(param(sp, "min", "1")) || 1);
  const { all } = await getReturnRateByVariant({ period, q, minShipped, sort: "rate", dir: "desc", page: 1, pageSize: 1 });

  const header = ["SKU", "Sản phẩm", "Mẫu mã", "Đã gửi", "Giao thành công thật", "Hoàn", "Hoàn theo quy tắc COD/cước", "Đang giao", "Chờ phát lại", "Huỷ", "Tỷ lệ hoàn %", "Số lượng hoàn", "Doanh thu hoàn", "Doanh thu giao thật"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of all) {
    lines.push([r.sku, r.productName, r.variationDetail, r.shipped, r.delivered, r.returned, r.returnedByRule, r.inTransit, r.failed, r.cancelled, r.rate === null ? "" : r.rate.toFixed(1), r.expectedRate === null ? "" : r.expectedRate.toFixed(1), r.returnedQty, r.lostRevenue, r.deliveredRevenue].map(csvCell).join(","));
  }
  lines.push("");
  lines.push(csvCell(`Kỳ: ${period.label} · tỷ lệ hoàn = hoàn / (giao thật + hoàn) · xuất lúc ${new Date().toISOString()}`));
  return new Response(`﻿${lines.join("\r\n")}`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ty-le-hoan-theo-ma-hang-${period.fromKey ?? "all"}-${period.toKey ?? "all"}.csv"` },
  });
}
