import { NextResponse } from "next/server";
import { getCurrentUser, can } from "@/lib/auth/session";
import { PLAN_STATUS_LABEL } from "@/lib/constants/planning";
import { getReplenishmentPlan } from "@/lib/queries/planning";

export const dynamic = "force-dynamic";

function cell(v: unknown) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !can(user, "products:view")) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  const report = await getReplenishmentPlan();
  const lines = [["Mã hàng", "Sản phẩm", "SKU", "Màu", "Size", "Tồn ERP", "Tồn Pancake", "Đã chốt chưa gửi", "Khả dụng", "Bán 7 ngày", `Bán ${report.assumptions.velocityWindowDays} ngày`, "Bán 30 ngày", "Tốc độ/ngày", "Còn bán được (ngày)", "Dự kiến hết", "Thời gian SX", "Bán trong lúc SX", "Tồn an toàn", "Mục tiêu", "Đề xuất đặt", "Giá nhập", "Tiền hàng", "Tình trạng"].join(",")];
  for (const r of report.rows) lines.push([r.productCode, r.productName, r.sku, r.color, r.size, r.stock, r.pancakeStock, r.committed, r.available, r.sold7, r.soldInWindow, r.sold30, r.velocity.toFixed(2), r.daysOfCover === null ? "" : Math.floor(r.daysOfCover), r.stockOutDate ?? "", r.leadTimeDays, r.leadTimeDemand, r.safetyStock, r.target, r.suggested, r.unitCost, r.orderCost, PLAN_STATUS_LABEL[r.status]].map(cell).join(","));
  return new NextResponse(`﻿${lines.join("\r\n")}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="ke-hoach-dat-hang-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
