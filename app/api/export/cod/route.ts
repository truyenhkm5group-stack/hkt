import type { NextRequest } from "next/server";
import { can, getCurrentUser } from "@/lib/auth/session";
import { SETTLEMENT_LABEL, type SettlementStatus } from "@/lib/constants/cod";
import { listCodSettlement } from "@/lib/queries/cod-settlement";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Xuất CSV đúng bảng đối soát đang xem: mỗi dòng là một vận đơn, kèm tiền thu hộ khai báo, tiền
 * bảng kê Viettel Post đã trả, chênh lệch, cước bị trừ và số ngày chờ.
 */
export async function GET(request: NextRequest) {
  // Bảng đối soát COD là số tiền thật — cùng quyền với trang Đối soát COD.
  const user = await getCurrentUser();
  if (!user) return new Response("Chưa đăng nhập", { status: 401 });
  if (!(can(user, "cod:view"))) return new Response("Không có quyền xuất dữ liệu này", { status: 403 });
  const raw = Object.fromEntries(request.nextUrl.searchParams.entries()) as SearchParams;
  const params = parseListParams(raw, { defaultSort: "deliveredAt", sortable: [], defaultPeriod: "all" });
  const tt = param(raw, "tt");
  const { rows } = await listCodSettlement({
    period: params.period,
    status: (tt || "ALL") as SettlementStatus | "ALL",
    q: params.q,
    page: 1,
    pageSize: 200,
  });

  const header = ["Mã vận đơn", "Mã đơn", "Khách", "Ngày phát", "Thu hộ khai báo", "Bảng kê trả", "Chênh lệch", "Cước ĐVVC", "Ngày trả", "Số ngày chờ", "Tình trạng", "Tệp bảng kê"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.vtpOrderNumber ?? "",
      r.systemId ?? "",
      r.customer,
      r.deliveredAt ?? "",
      r.codDeclared,
      r.codPaid,
      r.status === "TRA_THIEU" ? r.gap : 0,
      r.fee,
      r.paidAt ?? "",
      r.waitingDays ?? "",
      SETTLEMENT_LABEL[r.status],
      r.statementFile ?? "",
    ].map(csvCell).join(","));
  }
  return new Response(`﻿${lines.join("\r\n")}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="doi-soat-cod-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
