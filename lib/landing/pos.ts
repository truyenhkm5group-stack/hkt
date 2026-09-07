/**
 * Gửi đơn landing lên Pancake POS làm đơn nháp (trạng thái Mới) để nhân viên chốt trên POS; lưu id đơn để ERP theo dõi
 * trạng thái giao / hoàn / huỷ qua đồng bộ đơn Pancake. Chấm rủi ro trước khi gửi và ghi vào đơn.
 */
import { ADDRESS_ISSUE_LABEL, addressIssue, landingShippingFee, pushBlockOf } from "@/lib/constants/landing";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
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
  // Địa chỉ phải đủ để Viettel Post định tuyến. Gửi đơn thiếu tỉnh/thành lên POS chỉ đẩy việc sang
  // khâu sau: đơn tạo ra rồi lại không gửi được ĐVVC, hoặc gửi đi rồi hoàn. Chặn ngay tại đây nên
  // gửi lẻ và gửi hàng loạt dùng chung một tiêu chuẩn.
  const addr = addressIssue(row.address, row.province);
  if (addr) return { error: ADDRESS_ISSUE_LABEL[addr] };
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

/**
 * Gửi POS cho MỌI đơn landing đã đủ thông tin mà chưa lên POS.
 *
 * Dùng cho job `landing-push` (chạy từ xa) và cho nút gửi hàng loạt trên giao diện — cùng một lối
 * đi để hai đường không bao giờ áp tiêu chuẩn khác nhau.
 *
 * An toàn khi chạy lại: `pushLandingToPos` từ chối đơn đã có `pancakeOrderId`, nên chạy hai lần
 * không tạo đơn trùng cho khách. Chạy TUẦN TỰ, nghỉ giữa các đơn để không đập vào giới hạn tần
 * suất của Pancake; một đơn lỗi không làm dừng cả lô.
 */
export async function pushAllReadyLanding(actor: string, limit = 200) {
  const db = await getDb();
  const rows = await db.query.landingOrders.findMany({
    where: and(isNull(schema.landingOrders.orderId), isNull(schema.landingOrders.pancakeOrderId), ne(schema.landingOrders.status, "CANCELLED")),
    columns: { id: true, variantId: true, phone: true, address: true, province: true },
    orderBy: [asc(schema.landingOrders.submittedAt)],
    limit: 1000,
  });
  const ready = rows.filter((r) => !pushBlockOf(r)).slice(0, limit);
  const failed: { id: string; error: string }[] = [];
  let pushed = 0;
  for (const row of ready) {
    const r = await pushLandingToPos(row.id, actor);
    if ("error" in r) failed.push({ id: row.id, error: r.error });
    else pushed += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return {
    imported: pushed,
    skipped: rows.length - ready.length,
    failed: failed.length,
    detail: {
      ungGuiDuoc: ready.length,
      conVuong: rows.length - ready.length,
      loi: failed.slice(0, 20),
    },
  };
}
