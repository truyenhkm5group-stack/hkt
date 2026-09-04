import { asc, desc } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb, schema } from "@/db";
import { getSession } from "@/lib/auth/session";
import { ORDER_STAGE_LABEL } from "@/lib/constants/pancake";
import { SHIPMENT_STAGE_LABEL, COD_STATUS_LABEL } from "@/lib/constants/viettelpost";
import { formatDateTime } from "@/lib/format";
import { orderListWhere, ORDER_SORTABLE } from "@/lib/queries/orders";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const sp: SearchParams = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    const existing = sp[key];
    sp[key] = existing ? [...(Array.isArray(existing) ? existing : [existing]), value] : value;
  });
  const params = parseListParams(sp, { defaultSort: "insertedAt", filterKeys: ["stage", "source", "carrier", "seller", "payment", "tag"], sortable: ORDER_SORTABLE, defaultPeriod: "30d" });
  const db = await getDb();
  const rows = await db.query.orders.findMany({
    where: orderListWhere(params),
    orderBy: [params.dir === "asc" ? asc(schema.orders.insertedAt) : desc(schema.orders.insertedAt)],
    limit: 20000,
    with: { shipment: true, items: { columns: { productName: true, variationDetail: true, quantity: true, sku: true } } },
  });
  const header = ["Mã đơn", "Ngày tạo", "Trạng thái", "Kênh", "Khách hàng", "SĐT", "Địa chỉ", "Tỉnh/TP", "Sản phẩm", "Số lượng", "Tiền hàng", "Giảm giá", "Tổng đơn", "COD", "Giá vốn", "Phí ship khách trả", "Phí ĐVVC", "ĐVVC", "Mã vận đơn", "Trạng thái vận đơn", "Trạng thái COD", "Nhân viên", "Ghi chú", "Thẻ"];
  const lines = [header.map(csvCell).join(",")];
  for (const o of rows) {
    lines.push(
      [
        o.systemId ?? o.id,
        formatDateTime(o.insertedAt),
        ORDER_STAGE_LABEL[o.stage],
        o.source,
        o.billFullName,
        o.billPhone,
        o.shipFullAddress,
        o.shipProvince,
        o.items.map((i) => `${i.productName}${i.variationDetail ? ` (${i.variationDetail})` : ""} x${i.quantity}`).join(" | "),
        o.totalQuantity,
        o.totalPrice,
        o.totalDiscount,
        o.totalPriceAfterDiscount,
        o.moneyToCollect,
        o.cogs,
        o.customerPayFee ? o.shippingFee : 0,
        o.partnerFee,
        o.shipment?.carrier ?? "",
        o.shipment?.vtpOrderNumber ?? o.shipment?.trackingCode ?? "",
        o.shipment ? SHIPMENT_STAGE_LABEL[o.shipment.stage] : "",
        o.shipment ? COD_STATUS_LABEL[o.shipment.codStatus] : "",
        o.sellerName,
        o.note,
        o.tags.join(", "),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const body = `﻿${lines.join("\r\n")}`;
  return new Response(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="don-hang-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}
