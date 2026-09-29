/**
 * ═══════════ ĐƠN HÀNG TẠO TAY — LÕI GHI (pilot P0 #3) ═══════════
 *
 * LÕI của `createManualOrderAction` / `updateManualOrderAction` / `cancelManualOrderAction` — tách khỏi tệp "use server"
 * cùng lẽ với `customer-create.ts`: mọi hàm xuất khẩu của tệp "use server" là một cửa gọi được từ trình duyệt, và bài
 * kiểm cần gọi đúng hàm action gọi mà không có cookie của Next. Luật nghiệp vụ: `lib/constants/manual-orders.ts`.
 *
 * HÀNG RÀO, theo thứ tự (khuôn requireUser/can → zod → drizzle → audit):
 *  1. Module «Đơn hàng» bật.
 *  2. Tổ chức KHÔNG có nguồn đơn đồng bộ (`orgHasSyncedSource("orders")`) — nhà bật Pancake ⇒ NOT_SUPPORTED, kể cả Quản trị.
 *  3. Quyền `orders:write` (mặc định chỉ Quản trị).
 *  4. zod + phép tính tiền THUẦN (`manualOrderTotals`) — cùng hàm form dùng để hiện số trước khi bấm.
 *  5. Khách và mẫu mã phải CÓ THẬT trong CSDL tổ chức; mẫu mã đã gỡ (`is_removed`) không nhận đơn mới.
 *  6. MỘT giao dịch: đơn + dòng hàng + lịch sử trạng thái. Nhật ký `ORDER_MANUAL_CREATE` / `_UPDATE` / `_CANCEL` kèm TRƯỚC/SAU.
 *
 * Sửa / huỷ: CHỈ đơn mang id `erp-` (đơn Pancake ⇒ NOT_SUPPORTED — lượt đồng bộ kế tiếp ghi đè lại, người sửa tưởng đã
 * lưu mà dữ liệu tự quay về). Đơn đã huỷ không sửa được, không huỷ lại (bấm hai lần không ghi gì thêm — mục 61).
 *
 * KHÔNG ghi phiếu kho, KHÔNG tạo vận đơn, KHÔNG chạm tiền thực thu: tồn thực tế và ORDER_OUTCOME không đổi (luật 10, 3.1).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import {
  isManualOrderId,
  manualOrderRaw,
  manualOrderStageLabel,
  manualOrderTotals,
  MANUAL_ORDER_LIMITS,
  MANUAL_ORDER_ORIGIN,
  MANUAL_ORDER_STAGES,
  MANUAL_ORDER_STATUS_CODE,
  newManualOrderId,
  type ManualOrderCustomerOption,
  type ManualOrderRaw,
  type ManualOrderStage,
  type ManualOrderVariantOption,
} from "@/lib/constants/manual-orders";
import { objectDef } from "@/lib/constants/object-registry";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { canUseModule, orgHasSyncedSource } from "@/lib/platform/capabilities";

export type OrderGate = { allowed: true } | { allowed: false; code: "FORBIDDEN" | "NOT_SUPPORTED" | "MODULE_DISABLED"; reason: string };

/** Người này có được tạo / sửa đơn tay ở tổ chức hiện hành không — trang dùng để hiện nút / trả 404, action dùng để chặn. */
export async function manualOrderGate(user: SessionUser): Promise<OrderGate> {
  const def = objectDef("order");
  if (!def || !def.capabilities.create) return { allowed: false, code: "NOT_SUPPORTED", reason: "Đơn hàng không có đường tạo tay." };
  if (!(await canUseModule(def.module))) return { allowed: false, code: "MODULE_DISABLED", reason: "Module Đơn hàng chưa bật cho tổ chức này." };
  if (await orgHasSyncedSource("orders")) {
    return { allowed: false, code: "NOT_SUPPORTED", reason: "Tổ chức đang đồng bộ đơn từ Pancake: đơn do đồng bộ tạo, không tạo / sửa tay (tránh hai bản cho cùng một lần mua)." };
  }
  if (!can(user, "orders:write")) return { allowed: false, code: "FORBIDDEN", reason: "Bạn không có quyền tạo / sửa đơn hàng (orders:write)." };
  return { allowed: true };
}

const money = (label: string) =>
  z
    .number({ error: `Nhập ${label}` })
    .int(`${label} là số tiền nguyên (đồng)`)
    .min(0, `${label} không được âm`)
    .max(MANUAL_ORDER_LIMITS.maxMoney, `${label} quá lớn`);
const lineZ = z
  .object({
    variantId: z.string({ error: "Chọn mẫu mã" }).trim().min(1, "Chọn mẫu mã").max(200),
    quantity: z.number({ error: "Nhập số lượng" }).int("Số lượng là số nguyên").min(1, "Số lượng từ 1 trở lên").max(MANUAL_ORDER_LIMITS.maxQuantity, "Số lượng quá lớn"),
    unitPrice: money("đơn giá"),
    discount: money("chiết khấu dòng").default(0),
  })
  .strict();
const orderInputZ = z
  .object({
    customerId: z.string({ error: "Chọn khách hàng" }).trim().min(1, "Chọn khách hàng").max(200),
    stage: z.enum(MANUAL_ORDER_STAGES, { error: "Trạng thái không hợp lệ cho đơn tạo tay" }),
    lines: z.array(lineZ).min(1, "Đơn cần ít nhất một dòng hàng").max(MANUAL_ORDER_LIMITS.maxLines, "Quá nhiều dòng hàng"),
    orderDiscount: money("chiết khấu đơn").default(0),
    shippingFee: money("phí ship").default(0),
    note: z.string().max(MANUAL_ORDER_LIMITS.noteMax).default(""),
    channel: z.string().trim().max(MANUAL_ORDER_LIMITS.channelMax).default(""),
  })
  .strict();
export type ManualOrderInput = z.input<typeof orderInputZ>;

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

type Prepared = {
  customer: { id: string; name: string; phone: string | null; address: string; province: string };
  stage: ManualOrderStage;
  note: string;
  channel: string;
  orderDiscount: number;
  totals: Extract<ReturnType<typeof manualOrderTotals>, { ok: true }>["totals"];
  variants: Map<string, { id: string; productId: string; productName: string; sku: string; detail: string; color: string; size: string; image: string | null; weight: number }>;
};

/** Kiểm đầu vào + tra khách / mẫu mã THẬT. Không ghi gì. */
async function prepare(rawInput: unknown): Promise<{ ok: true; p: Prepared } | MetaFailure> {
  const parsed = orderInputZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const t = manualOrderTotals(v.lines, v.orderDiscount, v.shippingFee);
  if (!t.ok) return fail("INVALID", t.errors);
  const db = await getDb();
  const [customer] = await db
    .select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone, address: schema.customers.address, province: schema.customers.province })
    .from(schema.customers)
    .where(eq(schema.customers.id, v.customerId))
    .limit(1);
  const errors: FieldError[] = [];
  if (!customer) errors.push({ field: "customerId", message: "Khách hàng không tồn tại trong tổ chức này." });
  const ids = [...new Set(v.lines.map((l) => l.variantId))];
  const rows = await db
    .select({
      id: schema.productVariants.id,
      productId: schema.productVariants.productId,
      productName: schema.products.name,
      sku: schema.productVariants.sku,
      detail: schema.productVariants.detail,
      color: schema.productVariants.color,
      size: schema.productVariants.size,
      images: schema.productVariants.images,
      weight: schema.productVariants.weight,
      removed: schema.productVariants.isRemoved,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(inArray(schema.productVariants.id, ids));
  const variants = new Map(rows.map((r) => [r.id, { id: r.id, productId: r.productId, productName: r.productName, sku: r.sku, detail: r.detail, color: r.color, size: r.size, image: r.images?.[0] ?? null, weight: r.weight, removed: r.removed }]));
  v.lines.forEach((l, i) => {
    const found = variants.get(l.variantId);
    if (!found) errors.push({ field: `lines.${i}.variantId`, message: "Mẫu mã không tồn tại trong tổ chức này." });
    else if (found.removed) errors.push({ field: `lines.${i}.variantId`, message: `Mẫu mã ${found.sku || found.productName} đã gỡ — không nhận đơn mới.` });
  });
  if (errors.length || !customer) return fail("INVALID", errors);
  return { ok: true, p: { customer, stage: v.stage, note: v.note.trim(), channel: v.channel.trim(), orderDiscount: v.orderDiscount, totals: t.totals, variants } };
}

/** Chữ mô tả mẫu mã trên dòng đơn — cùng dạng "màu · size" mà dòng Pancake mang. */
function variationText(v: { detail: string; color: string; size: string }): string {
  return v.detail.trim() || [v.color, v.size].filter((x) => x.trim()).join(" · ");
}

function orderColumns(p: Prepared, user: SessionUser) {
  const t = p.totals;
  const raw: ManualOrderRaw = { origin: MANUAL_ORDER_ORIGIN, orderDiscount: p.orderDiscount, createdBy: user.id };
  return {
    status: MANUAL_ORDER_STATUS_CODE[p.stage],
    statusName: manualOrderStageLabel(p.stage),
    stage: p.stage,
    customerId: p.customer.id,
    billFullName: p.customer.name,
    billPhone: p.customer.phone ?? "",
    shipFullName: p.customer.name,
    shipPhone: p.customer.phone ?? "",
    shipAddress: p.customer.address,
    shipFullAddress: [p.customer.address, p.customer.province].filter((x) => x.trim()).join(", "),
    shipProvince: p.customer.province,
    totalPrice: t.totalPrice,
    totalDiscount: t.totalDiscount,
    totalPriceAfterDiscount: t.totalPriceAfterDiscount,
    shippingFee: t.shippingFee,
    ...(p.channel ? { source: p.channel } : {}),
    creatorName: user.name,
    note: p.note,
    itemsCount: t.lines.length,
    totalQuantity: t.totalQuantity,
    raw,
  };
}

function itemRows(orderId: string, p: Prepared) {
  return p.totals.lines.map((l, i) => {
    const v = p.variants.get(l.variantId)!;
    return {
      id: `${orderId}-${i + 1}`,
      orderId,
      variantId: v.id,
      productId: v.productId,
      productName: v.productName,
      variationDetail: variationText(v),
      sku: v.sku,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      // Giá vốn của dòng Pancake là "giá vốn Pancake" — đơn tay không có nguồn đó; để 0 thì thang giá vốn "sống" (luật 13)
      // tự lùi về phiếu nhập ERP / giá nhập mẫu mã như mọi đơn khác.
      unitCost: 0,
      discountEach: Math.floor(l.discount / l.quantity),
      totalDiscount: l.discount,
      lineTotal: l.lineTotal,
      weight: v.weight,
      image: v.image,
    };
  });
}

function snapshotOf(p: Prepared) {
  return {
    customerId: p.customer.id,
    stage: p.stage,
    lines: p.totals.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount })),
    orderDiscount: p.orderDiscount,
    shippingFee: p.totals.shippingFee,
    totalPriceAfterDiscount: p.totals.totalPriceAfterDiscount,
    channel: p.channel || null,
    note: p.note,
  };
}

export type ManualOrderResult = { ok: true; id: string } | MetaFailure;

export async function createManualOrderCore(user: SessionUser, rawInput: unknown): Promise<ManualOrderResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const prep = await prepare(rawInput);
  if (!prep.ok) return prep;
  const p = prep.p;
  const id = newManualOrderId();
  const now = new Date();
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.insert(schema.orders).values({ id, ...orderColumns(p, user), insertedAt: now, lastUpdateStatusAt: now, syncedAt: now });
    await tx.insert(schema.orderItems).values(itemRows(id, p));
    await tx.insert(schema.orderStatusHistory).values({ orderId: id, status: MANUAL_ORDER_STATUS_CODE[p.stage], oldStatus: null, editorName: user.name, updatedAt: now });
  });
  await audit({ userId: user.id, userEmail: user.email, action: "ORDER_MANUAL_CREATE", entity: "ORDER", entityId: id, before: null, after: snapshotOf(p), reason: "Tạo đơn tay trên ERP (tổ chức không đồng bộ đơn)" });
  return { ok: true, id };
}

type ExistingManual = { ok: true; row: typeof schema.orders.$inferSelect } | MetaFailure;

async function loadEditable(orderId: unknown): Promise<ExistingManual> {
  if (typeof orderId !== "string" || !orderId || orderId.length > 200) return fail("NOT_FOUND", "Không có đơn này.");
  const db = await getDb();
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  if (!row) return fail("NOT_FOUND", "Không có đơn này.");
  if (!isManualOrderId(row.id) || !manualOrderRaw(row.raw)) return fail("NOT_SUPPORTED", "Đơn đồng bộ từ nguồn khác — sửa ở nguồn; ERP không ghi đè đơn đồng bộ.");
  if (row.stage === "CANCELLED") return fail("CONFLICT", "Đơn đã huỷ — không sửa được.");
  return { ok: true, row };
}

async function itemsSnapshot(orderId: string) {
  const db = await getDb();
  const rows = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)).orderBy(asc(schema.orderItems.id));
  return rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity, unitPrice: r.unitPrice, discount: r.totalDiscount }));
}

export async function updateManualOrderCore(user: SessionUser, orderId: unknown, rawInput: unknown): Promise<ManualOrderResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const existing = await loadEditable(orderId);
  if (!existing.ok) return existing;
  const prep = await prepare(rawInput);
  if (!prep.ok) return prep;
  const p = prep.p;
  const row = existing.row;
  const beforeItems = await itemsSnapshot(row.id);
  const now = new Date();
  const db = await getDb();
  const stageChanged = row.stage !== p.stage;
  await db.transaction(async (tx) => {
    await tx
      .update(schema.orders)
      .set({ ...orderColumns(p, user), creatorName: row.creatorName, raw: { ...(manualOrderRaw(row.raw) as ManualOrderRaw), orderDiscount: p.orderDiscount }, ...(stageChanged ? { lastUpdateStatusAt: now } : {}), updatedAt: now })
      .where(and(eq(schema.orders.id, row.id)));
    await tx.delete(schema.orderItems).where(eq(schema.orderItems.orderId, row.id));
    await tx.insert(schema.orderItems).values(itemRows(row.id, p));
    if (stageChanged) await tx.insert(schema.orderStatusHistory).values({ orderId: row.id, status: MANUAL_ORDER_STATUS_CODE[p.stage], oldStatus: row.status, editorName: user.name, updatedAt: now });
  });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ORDER_MANUAL_UPDATE",
    entity: "ORDER",
    entityId: row.id,
    before: { customerId: row.customerId, stage: row.stage, lines: beforeItems, shippingFee: row.shippingFee, totalPriceAfterDiscount: row.totalPriceAfterDiscount, note: row.note },
    after: snapshotOf(p),
    reason: "Sửa đơn tạo tay",
  });
  return { ok: true, id: row.id };
}

const cancelZ = z.object({ reason: z.string().trim().min(MANUAL_ORDER_LIMITS.reasonMin, "nói vì sao huỷ đơn").max(MANUAL_ORDER_LIMITS.reasonMax) }).strict();

export async function cancelManualOrderCore(user: SessionUser, orderId: unknown, rawInput: unknown): Promise<ManualOrderResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const existing = await loadEditable(orderId);
  if (!existing.ok) return existing;
  const parsed = cancelZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const row = existing.row;
  const now = new Date();
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.update(schema.orders).set({ stage: "CANCELLED", status: MANUAL_ORDER_STATUS_CODE.CANCELLED, statusName: manualOrderStageLabel("CANCELLED"), lastUpdateStatusAt: now, updatedAt: now }).where(eq(schema.orders.id, row.id));
    await tx.insert(schema.orderStatusHistory).values({ orderId: row.id, status: MANUAL_ORDER_STATUS_CODE.CANCELLED, oldStatus: row.status, editorName: user.name, updatedAt: now });
  });
  await audit({ userId: user.id, userEmail: user.email, action: "ORDER_MANUAL_CANCEL", entity: "ORDER", entityId: row.id, before: { stage: row.stage }, after: { stage: "CANCELLED" }, reason: parsed.data.reason });
  return { ok: true, id: row.id };
}

// ─────────────────────────── Dữ liệu cho form ───────────────────────────


/** Khách + mẫu mã chọn được (mẫu mã chưa gỡ). Trần 2.000 mỗi loại — tổ chức pilot; tìm trong ô chọn phía client. */
export async function manualOrderFormOptions(): Promise<{ customers: ManualOrderCustomerOption[]; variants: ManualOrderVariantOption[] }> {
  const db = await getDb();
  const [customers, variants] = await Promise.all([
    db.select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone, province: schema.customers.province }).from(schema.customers).orderBy(asc(schema.customers.name)).limit(2000),
    db
      .select({ id: schema.productVariants.id, productName: schema.products.name, sku: schema.productVariants.sku, detail: schema.productVariants.detail, color: schema.productVariants.color, size: schema.productVariants.size, price: schema.productVariants.retailPrice })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(eq(schema.productVariants.isRemoved, false))
      .orderBy(asc(schema.products.name), asc(schema.productVariants.sku))
      .limit(2000),
  ]);
  return {
    customers,
    variants: variants.map((v) => {
      const extra = variationText(v);
      return { id: v.id, label: `${v.productName}${extra ? ` · ${extra}` : ""}`, sku: v.sku, price: v.price > 0 ? v.price : null };
    }),
  };
}

/** Giá trị ban đầu của form SỬA — đọc từ đơn tay đã lưu. `null` ⇒ không phải đơn tay / không có. */
export async function manualOrderFormValues(orderId: string): Promise<{ customerId: string; stage: ManualOrderStage; lines: { variantId: string; quantity: number; unitPrice: number; discount: number }[]; orderDiscount: number; shippingFee: number; note: string; channel: string } | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  const raw = row ? manualOrderRaw(row.raw) : null;
  if (!row || !raw || !isManualOrderId(row.id) || row.stage === "CANCELLED") return null;
  const items = await itemsSnapshot(row.id);
  return {
    customerId: row.customerId ?? "",
    stage: (MANUAL_ORDER_STAGES as readonly string[]).includes(row.stage) ? (row.stage as ManualOrderStage) : "NEW",
    lines: items.map((i) => ({ variantId: i.variantId ?? "", quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount })),
    orderDiscount: raw.orderDiscount,
    shippingFee: row.shippingFee,
    note: row.note,
    channel: row.source === "Khác" ? "" : row.source,
  };
}

/**
 * Điền sẵn hộp thoại XUẤT TAY (`/inventory/receipts?xuat-don=<id>`) cho MỘT đơn tay: mẫu mã + số lượng của đơn, người
 * nhận = khách, tham chiếu = mã đơn. Chỉ là số KHỞI TẠO — người kho sửa theo số ĐẾM THẬT rồi lưu qua đúng
 * `createStockReceipt`. Đơn đồng bộ / đã huỷ / không có ⇒ `null` (đơn đồng bộ rời kho qua ĐVVC, không qua phiếu này).
 */
export async function manualOrderIssuePrefill(orderId: string): Promise<{ orderId: string; customerName: string; qty: Record<string, number>; unmapped: { cell: string; qty: number }[] } | null> {
  if (!isManualOrderId(orderId) || orderId.length > 200) return null;
  const db = await getDb();
  const [row] = await db.select({ id: schema.orders.id, stage: schema.orders.stage, raw: schema.orders.raw, name: schema.orders.billFullName }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  if (!row || row.stage === "CANCELLED" || !manualOrderRaw(row.raw)) return null;
  const items = await db.select({ variantId: schema.orderItems.variantId, quantity: schema.orderItems.quantity, name: schema.orderItems.productName, sku: schema.orderItems.sku }).from(schema.orderItems).where(eq(schema.orderItems.orderId, row.id));
  const qty: Record<string, number> = {};
  const unmapped: { cell: string; qty: number }[] = [];
  for (const it of items) {
    if (it.variantId) qty[it.variantId] = (qty[it.variantId] ?? 0) + it.quantity;
    else unmapped.push({ cell: it.sku || it.name, qty: it.quantity });
  }
  return { orderId: row.id, customerName: row.name, qty, unmapped };
}
