import { desc } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb, schema } from "@/db";
import { getSession } from "@/lib/auth/session";
import { COD_STATUS_LABEL } from "@/lib/constants/viettelpost";
import { formatDate, formatDateTime } from "@/lib/format";
import { codListWhere, COD_SORTABLE } from "@/lib/queries/cod";
import { orderByNullsLast } from "@/lib/queries/shipments";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Xuất CSV danh sách đối soát COD theo bộ lọc hiện tại của trang /cod */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const sp: SearchParams = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    const existing = sp[key];
    sp[key] = existing ? [...(Array.isArray(existing) ? existing : [existing]), value] : value;
  });
  const params = parseListParams(sp, { defaultSort: "deliveredAt", filterKeys: ["cod", "carrier", "batch"], sortable: COD_SORTABLE, defaultPeriod: "all" });
  const sortMap = {
    deliveredAt: schema.shipments.deliveredAt,
    codAmount: schema.shipments.codAmount,
    codCollected: schema.shipments.codCollected,
    codPaidToBankAt: schema.shipments.codPaidToBankAt,
    createdAt: schema.shipments.createdAt,
  } as const;
  const sortColumn = sortMap[params.sort as keyof typeof sortMap] ?? schema.shipments.deliveredAt;
  const db = await getDb();
  const rows = await db.query.shipments.findMany({
    where: codListWhere(params),
    orderBy: [orderByNullsLast(sortColumn, params.dir), desc(schema.shipments.id)],
    limit: 20000,
    with: {
      order: { columns: { id: true, systemId: true, billFullName: true, billPhone: true } },
      codBatch: { columns: { reference: true } },
    },
  });
  const header = ["Mã vận đơn", "ĐVVC", "Mã đơn", "Khách hàng", "SĐT", "Ngày giao", "COD", "Đã thu", "Phí ship", "Phí COD", "Trạng thái COD", "Đợt tiền", "Ngày về NH", "ĐVVC đối soát"];
  const lines = [header.map(csvCell).join(",")];
  for (const s of rows) {
    lines.push(
      [
        s.vtpOrderNumber ?? s.trackingCode ?? "",
        s.carrier,
        s.order ? (s.order.systemId ?? s.order.id) : s.orderReference ?? "",
        s.receiverName || s.order?.billFullName || "",
        s.receiverPhone || s.order?.billPhone || "",
        formatDateTime(s.deliveredAt),
        s.codAmount,
        s.codCollected,
        s.shippingFee,
        s.codFee,
        COD_STATUS_LABEL[s.codStatus],
        s.codBatch?.reference ?? "",
        s.codPaidToBankAt ? formatDate(s.codPaidToBankAt) : "",
        s.codReconciledAt ? formatDate(s.codReconciledAt) : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const body = `﻿${lines.join("\r\n")}`;
  return new Response(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="doi-soat-cod-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}
