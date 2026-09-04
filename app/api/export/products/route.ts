import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { listProducts, listWarehouses, PRODUCT_SORTABLE } from "@/lib/queries/products";
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
  const params = parseListParams(sp, { defaultSort: "sku", defaultDir: "asc", filterKeys: ["stock", "category", "warehouse", "status"], sortable: PRODUCT_SORTABLE, defaultPeriod: "all" });
  const [{ rows }, warehouses] = await Promise.all([listProducts(params, 20000), listWarehouses()]);
  const header = ["Sản phẩm", "Mã SP", "SKU", "Barcode", "Màu", "Size", "Danh mục", "Trạng thái", "Giá bán", "Giá nhập gần nhất", "Giá vốn TB", "Tồn khả dụng", "Tồn thực tế", ...warehouses.map((w) => `Tồn ${w.name}`), "Bán 30 ngày", "Giá trị tồn", "Cập nhật Pancake"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.productName,
        r.productId,
        r.sku,
        r.barcode ?? "",
        r.color,
        r.size,
        r.categories.join(" | "),
        r.selling ? "Đang bán" : "Ẩn/khoá",
        r.retailPrice,
        r.lastImportedPrice,
        Math.round(r.avgImportedPrice),
        r.remainQuantity,
        r.actualRemainQuantity,
        ...warehouses.map((w) => r.stocks.find((s) => s.warehouseId === w.id)?.remainQuantity ?? ""),
        r.sold30,
        r.stockValue,
        formatDateTime(r.updatedAtExternal),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const body = `﻿${lines.join("\r\n")}`;
  return new Response(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ton-kho-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}
