"use server";

import { and, eq, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { matchSupplier } from "@/lib/constants/suppliers";
import { cellsTotal, normalizeProductCode } from "@/lib/constants/workshop-ledger";
import { vnStartOfDay } from "@/lib/format";
import { supplierCatalog } from "@/lib/queries/suppliers";
import { batchInput, deliveryInput, fabricInput, paymentInput } from "@/lib/validation/workshop-ledger";

/**
 * ═══════════ SỔ ĐẶT XƯỞNG — ĐƯỜNG GHI ═══════════
 *
 * Quyền: lô / đợt trả hàng / đợt vải đi theo `planning:write` (cùng người lập bảng đặt xưởng);
 * ĐỢT THANH TOÁN đòi thêm `expenses:write` — ghi "đã trả xưởng 20 triệu" là một lời khai về TIỀN, và
 * một lời khai sai làm lô hiện "Đã xong" trong khi xưởng chưa nhận đồng nào.
 *
 * Không đường ghi nào ở đây chạm phiếu kho, giá vốn hay bảng Chi phí (xem đầu `db/schema.ts`).
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

const ROOT = "/inventory/workshop";

function refresh(batchId?: string | null) {
  revalidatePath(ROOT);
  if (batchId) revalidatePath(`${ROOT}/${batchId}`);
}

function firstIssue(e: { issues: { message: string }[] }) {
  return e.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

/** Mã hàng khớp ĐÚNG MỘT sản phẩm đang bán ⇒ nối khoá. Không khớp / khớp nhiều ⇒ chỉ giữ chữ (mục 35). */
async function resolveProduct(code: string): Promise<{ id: string; name: string } | null> {
  if (!code) return null;
  const db = await getDb();
  const rows = await db
    .select({ id: schema.products.id, name: schema.products.name })
    .from(schema.products)
    .where(sql`upper(replace(trim(coalesce(${schema.products.customId}, '')), ' ', '')) = ${code} and ${schema.products.isRemoved} = false`)
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

/** Mã mẫu (màu/size) của một sản phẩm — để kiểm bảng chia mẫu chỉ chứa mẫu CỦA ĐÚNG mã hàng đó. */
async function variantIdsOf(productId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.productId, productId));
  return new Set(rows.map((r) => r.id));
}

/** Danh sách mẫu (màu/size) của mã hàng — cho ô chia số lượng trên form lô / đợt trả hàng. */
export async function listVariantsForProductCode(rawCode: string): Promise<{ productId: string | null; productName: string; variants: { id: string; color: string; size: string; sku: string }[] }> {
  const user = await requireUser();
  if (!can(user, "planning:view")) return { productId: null, productName: "", variants: [] };
  const product = await resolveProduct(normalizeProductCode(rawCode));
  if (!product) return { productId: null, productName: "", variants: [] };
  const db = await getDb();
  const variants = await db
    .select({ id: schema.productVariants.id, color: schema.productVariants.color, size: schema.productVariants.size, sku: schema.productVariants.sku })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.productId, product.id));
  return { productId: product.id, productName: product.name, variants: variants.map((v) => ({ id: v.id, color: v.color ?? "", size: v.size ?? "", sku: v.sku ?? "" })) };
}

async function resolveSupplier(raw: string) {
  const xuong = matchSupplier(raw, (await supplierCatalog()).index);
  return { supplier: xuong.state === "MATCHED" ? xuong.name : raw, supplierId: xuong.state === "MATCHED" ? xuong.id : null };
}

// ─────────────────────────── LÔ SẢN XUẤT ───────────────────────────

export async function saveProductionBatch(input: unknown, id?: string): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền ghi sổ đặt xưởng" };
  const parsed = batchInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const d = parsed.data;
  const code = normalizeProductCode(d.productCode);
  const db = await getDb();

  const trung = await db
    .select({ id: schema.productionBatches.id })
    .from(schema.productionBatches)
    .where(and(eq(schema.productionBatches.productCode, code), eq(schema.productionBatches.batchNo, d.batchNo), id ? ne(schema.productionBatches.id, id) : undefined))
    .limit(1);
  if (trung.length) return { error: `Mã ${code} đã có lô ${d.batchNo} — chọn số lô khác` };

  if (d.productionOrderId) {
    const po = await db.query.productionOrders.findFirst({ where: eq(schema.productionOrders.id, d.productionOrderId), columns: { id: true } });
    if (!po) return { error: "Không tìm thấy bảng đặt hàng màu × size đã chọn" };
  }

  const product = await resolveProduct(code);
  // Bảng chia mẫu chỉ hợp lệ khi mã hàng khớp ĐÚNG MỘT sản phẩm, và mọi ô là mẫu của chính sản phẩm ấy.
  const cells = d.cells;
  const chiaMau = Object.keys(cells).length > 0;
  if (chiaMau) {
    if (!product) return { error: `Mã ${code} chưa khớp sản phẩm nào — không chia được theo màu/size` };
    const ids = await variantIdsOf(product.id);
    if (Object.keys(cells).some((v) => !ids.has(v))) return { error: "Bảng chia màu/size có mẫu không thuộc mã hàng này — tải lại form rồi nhập lại" };
  }
  const orderedQty = chiaMau ? cellsTotal(cells) : d.orderedQty;
  if (id && chiaMau) {
    // Chuyển sang chia mẫu khi đã có đợt trả hàng ghi TỔNG: số đã về theo từng mẫu là CHƯA BIẾT.
    const [khongChia] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.productionDeliveries)
      .where(and(eq(schema.productionDeliveries.batchId, id), sql`${schema.productionDeliveries.cells} = '{}'::jsonb`));
    if (Number(khongChia?.n)) return { error: "Lô đã có đợt trả hàng ghi tổng (không chia màu/size) — xoá và ghi lại các đợt đó theo màu/size trước khi chia lô" };
  }
  const values = {
    productId: product?.id ?? null,
    productCode: code,
    productName: d.productName || product?.name || "",
    batchNo: d.batchNo,
    ...(await resolveSupplier(d.supplier)),
    productionOrderId: d.productionOrderId,
    orderedAt: vnStartOfDay(d.orderedAt),
    orderedQty,
    agreedQty: d.agreedQty,
    cells,
    workshopPenalty: d.workshopPenalty,
    penaltyNote: d.penaltyNote,
    marketerPrice: d.marketerPrice,
    dueDate: d.dueDate ? vnStartOfDay(d.dueDate) : null,
    laborUnitPrice: d.laborUnitPrice,
    adjustment: d.adjustment,
    adjustmentNote: d.adjustmentNote,
    fabricSource: d.fabricSource,
    note: d.note,
    updatedAt: new Date(),
  };

  let rowId = id;
  if (id) {
    const existing = await db.query.productionBatches.findFirst({ where: eq(schema.productionBatches.id, id), columns: { id: true } });
    if (!existing) return { error: "Không tìm thấy lô" };
    await db.update(schema.productionBatches).set(values).where(eq(schema.productionBatches.id, id));
  } else {
    const [row] = await db
      .insert(schema.productionBatches)
      .values({ ...values, createdByUserId: user.id, createdBy: user.name || user.email })
      .returning({ id: schema.productionBatches.id });
    rowId = row.id;
  }
  await audit({ userId: user.id, userEmail: user.email, action: id ? "PRODUCTION_BATCH_UPDATE" : "PRODUCTION_BATCH_CREATE", entity: "PRODUCTION_BATCH", entityId: rowId, detail: { code, batchNo: d.batchNo, orderedQty, agreedQty: d.agreedQty, laborUnitPrice: d.laborUnitPrice, adjustment: d.adjustment, workshopPenalty: d.workshopPenalty, marketerPrice: d.marketerPrice, variants: Object.keys(cells).length } });
  refresh(rowId);
  return { ok: true, id: rowId as string };
}

/**
 * "Xưởng đã trả xong" ghi mốc `done_at` MỘT lần: bấm lại không dời mốc (cùng bài học với mục 61).
 * Mở lại lô thì xoá mốc — lô chưa xong thì không có mốc xong.
 */
export async function setProductionBatchStatus(id: string, status: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền" };
  if (!["OPEN", "DONE", "CANCELLED"].includes(status)) return { error: "Trạng thái không hợp lệ" };
  const db = await getDb();
  const truoc = await db.query.productionBatches.findFirst({ where: eq(schema.productionBatches.id, id), columns: { status: true, doneAt: true } });
  if (!truoc) return { error: "Không tìm thấy lô" };
  if (truoc.status === status) return { ok: true };
  await db
    .update(schema.productionBatches)
    .set({ status, doneAt: status === "DONE" ? (truoc.doneAt ?? new Date()) : null, updatedAt: new Date() })
    .where(eq(schema.productionBatches.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_BATCH_STATUS", entity: "PRODUCTION_BATCH", entityId: id, detail: { from: truoc.status, to: status } });
  refresh(id);
  return { ok: true };
}

/** Chỉ xoá được lô CHƯA có gì bám vào — lô đã nhận hàng / đã trả tiền / đã gán vải thì dùng Huỷ. */
export async function deleteProductionBatch(id: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền" };
  const db = await getDb();
  const [dem] = await db
    .select({
      giao: sql<number>`(select count(*)::int from production_deliveries where batch_id = ${id})`,
      tien: sql<number>`(select count(*)::int from supplier_payments where batch_id = ${id})`,
      vai: sql<number>`(select count(*)::int from fabric_orders where batch_id = ${id})`,
    })
    .from(sql`(select 1) as x`);
  if (Number(dem?.giao) || Number(dem?.tien) || Number(dem?.vai))
    return { error: "Lô đã có đợt trả hàng, đợt thanh toán hoặc đợt vải — không xoá được, hãy chuyển sang Huỷ" };
  await db.delete(schema.productionBatches).where(eq(schema.productionBatches.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_BATCH_DELETE", entity: "PRODUCTION_BATCH", entityId: id });
  refresh();
  return { ok: true };
}

// ─────────────────────────── ĐỢT XƯỞNG TRẢ HÀNG ───────────────────────────

export async function addProductionDelivery(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền" };
  const parsed = deliveryInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const d = parsed.data;
  const db = await getDb();
  const lo = await db.query.productionBatches.findFirst({ where: eq(schema.productionBatches.id, d.batchId), columns: { status: true, cells: true } });
  if (!lo) return { error: "Không tìm thấy lô" };
  if (lo.status === "CANCELLED") return { error: "Lô đã huỷ — mở lại lô trước khi ghi hàng về" };
  // Lô chia theo mẫu ⇒ đợt trả hàng cũng phải chia theo mẫu, và chỉ trong các mẫu của lô. Không chia
  // thì ERP không biết mẫu nào đã về, và trang Thiếu hàng sẽ phải bỏ cả lô khỏi phép trừ.
  const loCells = lo.cells ?? {};
  if (Object.keys(loCells).length) {
    if (!Object.keys(d.cells).length) return { error: "Lô này đặt theo màu/size — ghi số trả theo từng màu/size" };
    if (Object.keys(d.cells).some((v) => !(v in loCells))) return { error: "Có mẫu không nằm trong bảng đặt của lô" };
  } else if (Object.keys(d.cells).length) return { error: "Lô chưa chia màu/size — ghi số trả dạng tổng, hoặc chia lô trước" };
  const quantity = Object.keys(d.cells).length ? cellsTotal(d.cells) : d.quantity;
  if (quantity === 0) return { error: "Tổng số lượng phải khác 0" };
  const [row] = await db
    .insert(schema.productionDeliveries)
    .values({ batchId: d.batchId, deliveredAt: vnStartOfDay(d.deliveredAt), quantity, cells: d.cells, note: d.note, createdByUserId: user.id, createdBy: user.name || user.email })
    .returning({ id: schema.productionDeliveries.id });
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_DELIVERY_CREATE", entity: "PRODUCTION_BATCH", entityId: d.batchId, detail: { deliveryId: row.id, quantity, deliveredAt: d.deliveredAt, variants: Object.keys(d.cells).length } });
  refresh(d.batchId);
  return { ok: true };
}

export async function deleteProductionDelivery(id: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền" };
  const db = await getDb();
  const [row] = await db.delete(schema.productionDeliveries).where(eq(schema.productionDeliveries.id, id)).returning();
  if (!row) return { error: "Không tìm thấy đợt trả hàng" };
  await audit({ userId: user.id, userEmail: user.email, action: "PRODUCTION_DELIVERY_DELETE", entity: "PRODUCTION_BATCH", entityId: row.batchId, detail: { deliveryId: id, quantity: row.quantity, deliveredAt: row.deliveredAt } });
  refresh(row.batchId);
  return { ok: true };
}

// ─────────────────────────── ĐỢT ĐẶT / NHẬP VẢI ───────────────────────────

export async function saveFabricOrder(input: unknown, id?: string): Promise<Result<{ id: string }>> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền ghi sổ vải" };
  const parsed = fabricInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const d = parsed.data;
  const db = await getDb();

  // Gán vào lô thì MÃ HÀNG lấy theo lô (máy chủ đọc) — vải của lô Q002 không thể mang mã Q003.
  let productId: string | null = null;
  let productCode = normalizeProductCode(d.productCode);
  if (d.batchId) {
    const lo = await db.query.productionBatches.findFirst({ where: eq(schema.productionBatches.id, d.batchId), columns: { productId: true, productCode: true } });
    if (!lo) return { error: "Không tìm thấy lô sản xuất đã chọn" };
    productId = lo.productId;
    productCode = lo.productCode;
  } else {
    productId = (await resolveProduct(productCode))?.id ?? null;
  }
  if (!productCode) return { error: "Nhập mã hàng hoặc chọn lô sản xuất dùng vải này" };

  const values = {
    productId,
    productCode,
    batchId: d.batchId,
    ...(await resolveSupplier(d.supplier)),
    description: d.description,
    orderedAt: vnStartOfDay(d.orderedAt),
    receivedAt: d.receivedAt ? vnStartOfDay(d.receivedAt) : null,
    quantity: d.quantity,
    unit: d.unit,
    unitPrice: d.unitPrice,
    amount: d.amount,
    note: d.note,
    updatedAt: new Date(),
  };
  let rowId = id;
  let oldBatchId: string | null = null;
  if (id) {
    const existing = await db.query.fabricOrders.findFirst({ where: eq(schema.fabricOrders.id, id), columns: { id: true, batchId: true } });
    if (!existing) return { error: "Không tìm thấy đợt vải" };
    oldBatchId = existing.batchId;
    await db.update(schema.fabricOrders).set(values).where(eq(schema.fabricOrders.id, id));
  } else {
    const [row] = await db
      .insert(schema.fabricOrders)
      .values({ ...values, createdByUserId: user.id, createdBy: user.name || user.email })
      .returning({ id: schema.fabricOrders.id });
    rowId = row.id;
  }
  await audit({ userId: user.id, userEmail: user.email, action: id ? "FABRIC_ORDER_UPDATE" : "FABRIC_ORDER_CREATE", entity: "FABRIC_ORDER", entityId: rowId, detail: { productCode, batchId: d.batchId, amount: d.amount, quantity: d.quantity, unit: d.unit } });
  refresh(d.batchId);
  if (oldBatchId && oldBatchId !== d.batchId) refresh(oldBatchId);
  return { ok: true, id: rowId as string };
}

export async function deleteFabricOrder(id: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "planning:write")) return { error: "Không có quyền" };
  const db = await getDb();
  const [dem] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.supplierPayments).where(eq(schema.supplierPayments.fabricOrderId, id));
  if (Number(dem?.n)) return { error: "Đợt vải đã có thanh toán — xoá các đợt thanh toán trước" };
  const [row] = await db.delete(schema.fabricOrders).where(eq(schema.fabricOrders.id, id)).returning();
  if (!row) return { error: "Không tìm thấy đợt vải" };
  await audit({ userId: user.id, userEmail: user.email, action: "FABRIC_ORDER_DELETE", entity: "FABRIC_ORDER", entityId: id, detail: { productCode: row.productCode, amount: row.amount } });
  refresh(row.batchId);
  return { ok: true };
}

// ─────────────────────────── ĐỢT THANH TOÁN ───────────────────────────

export async function addSupplierPayment(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Ghi thanh toán cần quyền Chi phí: sửa" };
  const parsed = paymentInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const d = parsed.data;
  const db = await getDb();
  let batchId = d.batchId;
  if (d.batchId) {
    const lo = await db.query.productionBatches.findFirst({ where: eq(schema.productionBatches.id, d.batchId), columns: { id: true } });
    if (!lo) return { error: "Không tìm thấy lô" };
  } else if (d.fabricOrderId) {
    const vai = await db.query.fabricOrders.findFirst({ where: eq(schema.fabricOrders.id, d.fabricOrderId), columns: { batchId: true } });
    if (!vai) return { error: "Không tìm thấy đợt vải" };
    batchId = vai.batchId;
  }
  const [row] = await db
    .insert(schema.supplierPayments)
    .values({
      batchId: d.batchId,
      fabricOrderId: d.fabricOrderId,
      kind: d.kind,
      amount: d.amount,
      paidAt: vnStartOfDay(d.paidAt),
      method: d.method,
      reference: d.reference,
      note: d.note,
      createdByUserId: user.id,
      createdBy: user.name || user.email,
    })
    .returning({ id: schema.supplierPayments.id });
  await audit({ userId: user.id, userEmail: user.email, action: "SUPPLIER_PAYMENT_CREATE", entity: d.batchId ? "PRODUCTION_BATCH" : "FABRIC_ORDER", entityId: (d.batchId ?? d.fabricOrderId) as string, detail: { paymentId: row.id, kind: d.kind, amount: d.amount, paidAt: d.paidAt, method: d.method } });
  refresh(batchId);
  return { ok: true };
}

/** Xoá một đợt thanh toán ghi nhầm. Nhật ký giữ lại số tiền, ngày và người ghi của dòng đã xoá. */
export async function deleteSupplierPayment(id: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "expenses:write")) return { error: "Xoá thanh toán cần quyền Chi phí: sửa" };
  const db = await getDb();
  const [row] = await db.delete(schema.supplierPayments).where(eq(schema.supplierPayments.id, id)).returning();
  if (!row) return { error: "Không tìm thấy đợt thanh toán" };
  let batchId = row.batchId;
  if (!batchId && row.fabricOrderId) batchId = (await db.query.fabricOrders.findFirst({ where: eq(schema.fabricOrders.id, row.fabricOrderId), columns: { batchId: true } }))?.batchId ?? null;
  await audit({ userId: user.id, userEmail: user.email, action: "SUPPLIER_PAYMENT_DELETE", entity: row.batchId ? "PRODUCTION_BATCH" : "FABRIC_ORDER", entityId: (row.batchId ?? row.fabricOrderId) as string, detail: { paymentId: id, kind: row.kind, amount: row.amount, paidAt: row.paidAt, createdBy: row.createdBy } });
  refresh(batchId);
  return { ok: true };
}
