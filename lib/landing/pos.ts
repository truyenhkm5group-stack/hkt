/**
 * Gửi đơn landing lên Pancake POS làm đơn nháp (trạng thái Mới) để nhân viên chốt trên POS; lưu id đơn để ERP theo dõi
 * trạng thái giao / hoàn / huỷ qua đồng bộ đơn Pancake. Chấm rủi ro trước khi gửi và ghi vào đơn.
 */
import { landingShippingFee } from "@/lib/constants/landing";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getPancakeClient } from "@/lib/integrations/pancake/client";
import { loadLandingConfig, refreshLandingChecks } from "@/lib/landing/sheet";

export async function pushLandingToPos(id: string, actor: string): Promise<{ ok: true; systemId: number; pancakeOrderId: string } | { error: string }> {
  const db = await getDb();
  const row = await db.query.landingOrders.findFirst({ where: eq(schema.landingOrders.id, id), with: { variant: { with: { product: true } } } });
  if (!row) return { error: "Không tìm thấy đơn landing" };
  if (row.status === "CANCELLED") return { error: "Đơn đã huỷ" };
  if (row.pancakeOrderId) return { error: `Đã gửi POS trước đó (#${row.pancakeSystemId ?? row.pancakeOrderId})` };
  if (!row.phone) return { error: "Thiếu số điện thoại" };
  if (!row.variantId || !row.variant) return { error: "Chưa chọn mẫu mã Pancake cho đơn này" };
  const config = await loadLandingConfig();
  const checks = await refreshLandingChecks(id);
  const riskNote = checks?.risk?.risky ? ` ⚠ Khách rủi ro: GTC ${checks.risk.succeed} · hoàn ${checks.risk.returned} · ${checks.risk.reasons.join(", ")} → xin cọc / xác nhận kỹ.` : "";
  const dupNote = checks?.duplicates?.length ? ` ⚠ Trùng SĐT với ${checks.duplicates.length} đơn khác gần đây.` : "";
  const note = [config.posNote, row.note ? `Khách ghi: ${row.note}` : "", row.source ? `Nguồn: ${row.source}` : "", `Landing dòng ${row.rowIndex}`, riskNote, dupNote].filter(Boolean).join(" · ");
  try {
    const client = getPancakeClient();
    const res = await client.createOrder({
      name: row.customerName || `Khách ${row.phone}`,
      phone: row.phone,
      address: row.address,
      province: row.province,
      note,
      // 1 sản phẩm không có giá trên form → giá mặc định (499k) + phí ship; gói ≥ 2 sản phẩm → giá gói / sp, free ship
      items: [{ variationId: row.variantId, quantity: row.quantity, price: Number(row.price) || (row.quantity === 1 ? config.singlePrice : undefined) }],
      shippingFee: landingShippingFee(row.quantity, config.shippingFee),
      warehouseId: config.warehouseId || undefined,
      source: "Landing page",
    });
    if (!res.id) return { error: "Pancake không trả về id đơn" };
    await db
      .update(schema.landingOrders)
      .set({ status: "PUSHED", pancakeOrderId: res.id, pancakeSystemId: res.systemId || null, pushedAt: new Date(), pushError: "", assignee: actor, updatedAt: new Date() })
      .where(eq(schema.landingOrders.id, id));
    return { ok: true, systemId: res.systemId, pancakeOrderId: res.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.update(schema.landingOrders).set({ pushError: message.slice(0, 500), updatedAt: new Date() }).where(eq(schema.landingOrders.id, id));
    return { error: message };
  }
}
