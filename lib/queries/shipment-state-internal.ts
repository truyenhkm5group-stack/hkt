import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { OrderShipmentRow, ShipmentStateRow } from "@/lib/constants/shipment-state-api";
import { rowsOf } from "@/lib/sql-rows";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";

/**
 * Chặng ERP của các mã vận đơn — CHỈ dòng có chứng từ Viettel Post (`vtp_status_date` khác NULL: chặng do `materializeShipmentState`
 * dựng từ sự kiện ĐVVC). Chưa có chứng từ ⇒ không trả dòng: bot tự lùi về `partner_status` Pancake theo luật của nó, ERP không đoán thay.
 * Không order_id, không người nhận (hợp đồng lib/constants/shipment-state-api.ts). CHỈ ĐỌC.
 */
export async function shipmentStatesByCodes(codes: readonly string[]): Promise<ShipmentStateRow[]> {
  if (!codes.length) return [];
  const s = schema.shipments;
  const db = await getDb();
  const rows = await db
    .select({ code: s.vtpOrderNumber, stage: s.stage, final: s.isFinal, at: s.vtpStatusDate })
    .from(s)
    .where(and(inArray(sql`upper(${s.vtpOrderNumber})`, [...codes]), isNotNull(s.vtpStatusDate)));
  return rows.map((r) => ({ code: String(r.code ?? "").toUpperCase(), stage: r.stage, final: Boolean(r.final), at: r.at ? r.at.toISOString() : null }));
}

/**
 * Lần gửi CHÍNH của từng đơn Pancake theo ĐÚNG `PRIMARY_ATTEMPT` (luật mọi báo cáo dùng), chỉ khi lần gửi đó có chứng từ VTP. Trả lại
 * chính mã đơn bot đã gửi — bot dùng để ghép, không có gì mới bị lộ. Không số tiền, không người nhận. CHỈ ĐỌC.
 */
export async function primaryShipmentsByOrders(orderIds: readonly string[]): Promise<OrderShipmentRow[]> {
  if (!orderIds.length) return [];
  const db = await getDb();
  const rows = rowsOf<{ order_id: string; code: string | null; stage: string; final: boolean | null; at: Date | string | null; reship: boolean }>(
    await db.execute(sql`select "orders"."id" as order_id, "shipments"."vtp_order_number" as code, "shipments"."stage"::text as stage,
        "shipments"."is_final" as final, "shipments"."vtp_status_date" as at, ("shipments"."raw" -> 'reship' ->> 'of' is not null) as reship
      from "orders"
      join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
      where "orders"."id" in (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
        and "shipments"."vtp_status_date" is not null and "shipments"."vtp_order_number" is not null`),
  );
  return rows.map((r) => ({
    orderId: String(r.order_id),
    code: String(r.code ?? "").toUpperCase(),
    stage: r.stage,
    final: Boolean(r.final),
    at: r.at ? new Date(r.at).toISOString() : null,
    reship: Boolean(r.reship),
  }));
}
