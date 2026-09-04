import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDailyBreakdown, parseBasis, REPORT_BASIS_LABEL } from "@/lib/queries/reports";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Xuất CSV lợi nhuận theo ngày (cùng bộ lọc kỳ / cơ sở tính với trang Báo cáo) */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const sp: SearchParams = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    sp[key] = value;
  });
  const period = resolvePeriod(sp, "month");
  const basis = parseBasis(param(sp, "basis"));
  const rows = await getDailyBreakdown(period, basis);

  const header = ["Ngày", "Đơn lên (không huỷ)", "Giao thành công", "Doanh thu giao TC", "Giá vốn", "Lãi gộp", "Phí vận chuyển", "Phí hoàn", "Phí sàn", "Chi phí quảng cáo", "Chi phí vận hành", "Lợi nhuận ròng", "Biên ròng %"];
  const lines = [header.map(csvCell).join(",")];
  const total = { orders: 0, success: 0, revenue: 0, cogs: 0, grossProfit: 0, shipping: 0, returnFee: 0, marketplaceFee: 0, adSpend: 0, operating: 0, netProfit: 0 };
  for (const r of rows) {
    lines.push([r.day.split("-").reverse().join("/"), r.orders, r.success, r.revenue, r.cogs, r.grossProfit, r.shipping, r.returnFee, r.marketplaceFee, r.adSpend, r.operating, r.netProfit, r.revenue ? ((r.netProfit / r.revenue) * 100).toFixed(1) : ""].map(csvCell).join(","));
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += r[key];
  }
  lines.push(["Tổng", total.orders, total.success, total.revenue, total.cogs, total.grossProfit, total.shipping, total.returnFee, total.marketplaceFee, total.adSpend, total.operating, total.netProfit, total.revenue ? ((total.netProfit / total.revenue) * 100).toFixed(1) : ""].map(csvCell).join(","));
  lines.push("");
  lines.push(csvCell(`Kỳ: ${period.label} · ${REPORT_BASIS_LABEL[basis]} · xuất lúc ${new Date().toISOString()}`));

  const body = `﻿${lines.join("\r\n")}`;
  return new Response(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="loi-nhuan-theo-ngay-${period.fromKey ?? "all"}-${period.toKey ?? "all"}.csv"` },
  });
}
