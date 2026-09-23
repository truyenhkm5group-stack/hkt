import { NextResponse } from "next/server";
import { getCurrentUser, can } from "@/lib/auth/session";
import { DELIVERY_RATE_SOURCE_LABEL } from "@/lib/constants/delivery-rate";
import { PLAN_STATUS_LABEL } from "@/lib/constants/planning";
import { getReplenishmentPlan } from "@/lib/queries/planning";

export const dynamic = "force-dynamic";

function cell(v: unknown) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || !can(user, "planning:view")) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  // Xuất đúng bảng người dùng đang xem: cùng số ngày muốn đủ bán và cùng lựa chọn trừ hàng sắp về.
  const sp = new URL(req.url).searchParams;
  const soNgay = Number(sp.get("ngay"));
  const report = await getReplenishmentPlan({
    coverDays: Number.isFinite(soNgay) && soNgay >= 0 ? soNgay : undefined,
    countIncoming: sp.get("hoan") !== "0",
  });
  // Tồn / khả dụng của mẫu mã chưa có phiếu nhập để TRỐNG (chưa biết), không in số âm bịa ra.
  const lines = [["Mã hàng", "Sản phẩm", "SKU", "Màu", "Size", "Tồn ERP", "Đã chốt chưa gửi", "Khả dụng", "Đang ở ngoài", "Chờ hoàn về", "Sắp quay về kho", "Bán 7 ngày", `Chốt ${report.assumptions.velocityWindowDays} ngày`, "Bán 30 ngày", "Gửi đi/ngày", "GTC mã (%)", "Căn cứ GTC", "Hao kho ròng/ngày", "Trừ hàng hoàn đơn mới", "Còn bán được (ngày)", "Dự kiến hết", "Thời gian SX", "Bán trong lúc SX", "Tồn an toàn", "Mục tiêu", "Đề xuất đặt", "Giá nhập", "Tiền hàng", "Tình trạng"].join(",")];
  for (const r of report.rows) lines.push([r.productCode, r.productName, r.sku, r.color, r.size, r.stockKnown ? r.stock : "", r.committed, r.stockKnown ? r.available : "", r.inTransit, r.awaitingReturn, r.incoming, r.sold7, r.soldInWindow, r.sold30, r.velocity.toFixed(2), r.deliveryRate, DELIVERY_RATE_SOURCE_LABEL[r.deliverySource], r.netVelocity.toFixed(2), r.futureReturnCredit, r.daysOfCover === null ? "" : Math.floor(r.daysOfCover), r.stockOutDate ?? "", r.leadTimeDays, r.leadTimeDemand, r.safetyStock, r.target, r.suggested, r.unitCost, r.orderCost, PLAN_STATUS_LABEL[r.status]].map(cell).join(","));
  return new NextResponse(`﻿${lines.join("\r\n")}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="ke-hoach-dat-hang-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
