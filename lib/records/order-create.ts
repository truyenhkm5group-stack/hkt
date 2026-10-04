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
 * Tạo / sửa / huỷ KHÔNG ghi phiếu kho, KHÔNG tạo vận đơn, KHÔNG chạm tiền thực thu: tồn thực tế và ORDER_OUTCOME không đổi
 * (luật 10, 3.1).
 *
 * XÁC NHẬN GIAO (G-ORDER — ORDER_OUTCOME.md mục 11): `confirmManualDeliveryCore` ghi PHIẾU GIAO CÓ KÝ NHẬN cho đơn
 * "Đã xác nhận" ⇒ stage `DELIVERED`; từ đó `ORDER_OUTCOME` = `DELIVERED` và hàng rời kho (`ORDER_LEFT_WAREHOUSE`) — cả hai
 * đọc DÒNG PHIẾU, không đọc stage. Tiền KHÔNG đổi: không ghi thanh toán, không đổi COD nào. Ghi nhầm ⇒
 * `voidManualDeliveryCore` (bắt buộc lý do, không xoá cứng) ⇒ đơn về "Đã xác nhận". Đơn đã giao không sửa / huỷ được.
 *
 * ─── SỰ KIỆN ĐƠN (0180 · hành trình tự phục vụ) ───
 * Đơn CHỐT («Đã xác nhận»), đơn đã chốt bị SỬA ở phần vận hành phải biết, và đơn bị HUỶ phát `order.confirmed` ·
 * `order.updated` · `order.cancelled` TRONG CÙNG giao dịch với lượt ghi đơn (không bao giờ có đơn mà thiếu sự kiện). Ngay
 * sau khi giao dịch xong, bộ máy luật chạy MỘT lượt cho tổ chức hiện hành (`runWorkflows`, đúng hàm của job và của nút
 * trên trang — không engine thứ hai) để luật «báo nhóm vận hành» gửi tin khi đơn vừa chốt, không đợi lịch. Lỗi của lượt
 * chạy luật KHÔNG làm hỏng lượt ghi đơn đã xong: sự kiện nằm trong sổ, lượt chạy sau xét tiếp từ con trỏ.
 *
 * ─── AI GHI ĐƠN ───
 * Người (phiên đăng nhập, cần `orders:write`) hoặc MÁY — chatbot bán hàng của tổ chức (`createOrderAsAgent` …). Máy
 * không giả làm người (luật 36): nhật ký và sự kiện mang tác nhân `AGENT`, không mang `users.id` nào; lời khai gốc
 * `raw.createdBy = null`, `raw.agent` nói máy nào. Cổng module / nguồn đồng bộ áp y hệt; quyền của máy do lớp gọi
 * (cấu hình chatbot, công cụ được bật) quyết.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { checkCredit } from "@/lib/constants/price-lists";
import { manualPaymentStatus, sumConfirmedPayments } from "@/lib/constants/order-payments";
import { customerExposure } from "@/lib/queries/receivables";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import {
  canConfirmManualDelivery,
  canMarkManualDeliveryFailed,
  DELIVERY_NOTE_LIMITS,
  MANUAL_DELIVERY_FEE_SETTING_KEY,
  AUTO_CONFIRM_COMPLETE_SETTING_KEY,
  manualOrderComplete,
  MANUAL_FAILED_FROM_STAGES,
  parseManualDeliveryFee,
  isManualOrderId,
  MANUAL_DELIVERY_FROM_STAGES,
  manualOrderRaw,
  manualOrderStageLabel,
  manualOrderTotals,
  MANUAL_ORDER_ID_PREFIX,
  MANUAL_ORDER_LIMITS,
  MANUAL_ORDER_ORIGIN,
  MANUAL_ORDER_STAGES,
  MANUAL_ORDER_STATUS_CODE,
  newManualOrderId,
  type ManualOrderCustomerOption,
  type ManualOrderRaw,
  type ManualOrderStage,
  type ManualOrderVariantOption,
  type OrderMaterialChange,
} from "@/lib/constants/manual-orders";
import { objectDef } from "@/lib/constants/object-registry";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { emitDomainEvent } from "@/lib/events/emit";
import { canUseModule, orgHasSyncedSource } from "@/lib/platform/capabilities";
import { runWorkflows } from "@/lib/workflow/engine";
import { agentPriceProblems, agentUnitPrices, type AgentPricingMode } from "@/lib/commerce/pricing";
import { additionalNeed, lockVariants, shortfalls, type StockTx } from "@/lib/commerce/stock";
import { getSettingJson, setSettingJson } from "@/lib/settings";

export type OrderGate = { allowed: true } | { allowed: false; code: "FORBIDDEN" | "NOT_SUPPORTED" | "MODULE_DISABLED"; reason: string };

/** Cổng CỦA TỔ CHỨC (không hỏi người): module Đơn hàng bật + tổ chức không đồng bộ đơn. Người và máy cùng đi qua. */
export async function manualOrderOrgGate(): Promise<OrderGate> {
  const def = objectDef("order");
  if (!def || !def.capabilities.create) return { allowed: false, code: "NOT_SUPPORTED", reason: "Đơn hàng không có đường tạo tay." };
  if (!(await canUseModule(def.module))) return { allowed: false, code: "MODULE_DISABLED", reason: "Module Đơn hàng chưa bật cho tổ chức này." };
  if (await orgHasSyncedSource("orders")) {
    return { allowed: false, code: "NOT_SUPPORTED", reason: "Tổ chức đang đồng bộ đơn từ Pancake: đơn do đồng bộ tạo, không tạo / sửa tay (tránh hai bản cho cùng một lần mua)." };
  }
  return { allowed: true };
}

/** Người này có được tạo / sửa đơn tay ở tổ chức hiện hành không — trang dùng để hiện nút / trả 404, action dùng để chặn. */
export async function manualOrderGate(user: SessionUser): Promise<OrderGate> {
  const org = await manualOrderOrgGate();
  if (!org.allowed) return org;
  if (!can(user, "orders:write")) return { allowed: false, code: "FORBIDDEN", reason: "Bạn không có quyền tạo / sửa đơn hàng (orders:write)." };
  return { allowed: true };
}

/** Máy ghi đơn thay người — chatbot bán hàng của tổ chức. `source` đi vào nhật ký / sự kiện. */
export type OrderAgent = { name: string; source: string };

/**
 * Lượt ghi của MÁY phải khai chế độ giá (`lib/commerce/pricing.ts`): lõi tính lại đơn giá và từ chối khi lệch — không công
 * cụ / kênh / agent nào truyền được giá tuỳ ý (TD-01). `idempotencyKey` = khoá LẦN MUA phía gọi (vd hội thoại + lượt mua):
 * gọi lại cùng khoá ⇒ trả lại ĐÚNG đơn đã tạo, không đơn thứ hai (TD-03). Chốt đơn của máy kiểm tồn khả dụng TRONG giao
 * dịch ghi, có khoá theo mẫu mã (TD-02) — người tạo đơn tay vẫn được chốt khi thiếu hàng (đặt trước, chờ hàng).
 */
export type AgentOrderOptions = { pricing: AgentPricingMode; idempotencyKey?: string | null };

/** Người hay máy đang ghi — MỘT hình cho ba lượt ghi, để nhật ký / sự kiện / lời khai gốc nói cùng một điều. */
type Writer = { userId: string | null; email: string; name: string; actorKind: "USER" | "AGENT"; source: string; agent: string | null };
const userWriter = (u: SessionUser): Writer => ({ userId: u.id, email: u.email, name: u.name, actorKind: "USER", source: "lib/records/order-create.ts", agent: null });
const agentWriter = (a: OrderAgent): Writer => ({ userId: null, email: `agent:${a.source}`, name: a.name, actorKind: "AGENT", source: a.source, agent: a.name });

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
    /**
     * Người nhận / địa chỉ GIAO của RIÊNG đơn này (0180) — khách đặt hộ người khác, hay giao tới chỗ làm. Bỏ trống ⇒ lấy
     * của khách như trước. Chỉ ô đã điền mới đè; ô trống lấy của khách.
     */
    recipient: z
      .object({
        name: z.string().trim().max(120).default(""),
        phone: z.string().trim().max(30).default(""),
        address: z.string().trim().max(300).default(""),
        province: z.string().trim().max(120).default(""),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ManualOrderInput = z.input<typeof orderInputZ>;

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

type Recipient = { name: string; phone: string; address: string; province: string };
type Prepared = {
  customer: { id: string; name: string; phone: string | null; address: string; province: string };
  /** Người nhận của đơn — của khách, đè bởi ô `recipient` đã điền. */
  recipient: Recipient;
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
  const r = v.recipient;
  const recipient: Recipient = {
    name: r?.name || customer.name,
    phone: r?.phone || (customer.phone ?? ""),
    address: r?.address || customer.address,
    // Địa chỉ giao khác mà không nói tỉnh ⇒ KHÔNG mượn tỉnh của địa chỉ khách (hai địa chỉ, hai tỉnh có thể khác nhau).
    province: r?.province || (r?.address ? "" : customer.province),
  };
  return { ok: true, p: { customer, recipient, stage: v.stage, note: v.note.trim(), channel: v.channel.trim(), orderDiscount: v.orderDiscount, totals: t.totals, variants } };
}

/** Chữ mô tả mẫu mã trên dòng đơn — cùng dạng "màu · size" mà dòng Pancake mang. */
function variationText(v: { detail: string; color: string; size: string }): string {
  return v.detail.trim() || [v.color, v.size].filter((x) => x.trim()).join(" · ");
}

function orderColumns(p: Prepared, w: Writer, extraRaw: { agentKey?: string } = {}) {
  const t = p.totals;
  const raw: ManualOrderRaw & { agent?: string; agentKey?: string } = { origin: MANUAL_ORDER_ORIGIN, orderDiscount: p.orderDiscount, createdBy: w.userId, ...(w.agent ? { agent: w.agent } : {}), ...extraRaw };
  return {
    status: MANUAL_ORDER_STATUS_CODE[p.stage],
    statusName: manualOrderStageLabel(p.stage),
    stage: p.stage,
    customerId: p.customer.id,
    billFullName: p.customer.name,
    billPhone: p.customer.phone ?? "",
    shipFullName: p.recipient.name,
    shipPhone: p.recipient.phone,
    shipAddress: p.recipient.address,
    shipFullAddress: [p.recipient.address, p.recipient.province].filter((x) => x.trim()).join(", "),
    shipProvince: p.recipient.province,
    totalPrice: t.totalPrice,
    totalDiscount: t.totalDiscount,
    totalPriceAfterDiscount: t.totalPriceAfterDiscount,
    shippingFee: t.shippingFee,
    // Phí ship của đơn tay là tiền KHÁCH trả (form ghi «Khách trả (gồm ship)»): cờ này là thứ trang đơn + tệp xuất đọc
    // để in dòng «Phí ship thu của khách» — thiếu nó thì 30.000 ₫ khách trả biến mất khỏi trang chi tiết.
    customerPayFee: t.shippingFee > 0,
    ...(p.channel ? { source: p.channel } : {}),
    creatorName: w.name,
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
    recipient: p.recipient,
  };
}

/**
 * Phần của đơn mà NHÓM VẬN HÀNH phải biết khi nó đổi — hàm THUẦN. Đổi ghi chú / kênh bán thì không báo (không đổi việc
 * đóng gói / giao / thu); đổi dòng hàng, người nhận, tiền phải thu, khách, hay rút lại lượt chốt thì báo.
 */
export type OrderMaterial = {
  customerId: string;
  stage: string;
  lines: { variantId: string; quantity: number; unitPrice: number; discount: number }[];
  recipient: Recipient;
  /** Tiền khách phải trả khi nhận = tiền hàng sau chiết khấu + phí ship (COD của đơn tay). */
  amountDue: number;
};

export function materialChanges(before: OrderMaterial, after: OrderMaterial): OrderMaterialChange[] {
  const out: OrderMaterialChange[] = [];
  const norm = (l: OrderMaterial["lines"]) => JSON.stringify(l.map((x) => [x.variantId, x.quantity, x.unitPrice, x.discount]).sort());
  if (norm(before.lines) !== norm(after.lines)) out.push("lines");
  const rc = (r: Recipient) => [r.name, r.phone, r.address, r.province].map((x) => x.trim()).join("|");
  if (rc(before.recipient) !== rc(after.recipient)) out.push("shipping_address");
  if (before.amountDue !== after.amountDue) out.push("amount_due");
  if (before.customerId !== after.customerId) out.push("customer");
  if (before.stage !== after.stage) out.push("stage");
  return out;
}

function materialOf(p: Prepared): OrderMaterial {
  return { customerId: p.customer.id, stage: p.stage, lines: snapshotOf(p).lines, recipient: p.recipient, amountDue: p.totals.totalPriceAfterDiscount + p.totals.shippingFee };
}

type Tx = Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0];

async function emitOrderEvent(tx: Tx, w: Writer, name: "order.confirmed" | "order.updated" | "order.cancelled", orderId: string, dedupeKey: string, payload: Record<string, unknown>) {
  await emitDomainEvent(tx, { name, subjectType: "order", subjectId: orderId, payload: { orderId, ...payload }, actorKind: w.actorKind, actorId: w.userId, source: w.source, dedupeKey });
}

/**
 * Một lượt bộ máy luật cho tổ chức hiện hành, NGAY sau lượt ghi đơn — để luật nghe `order.*` chạy không đợi lịch. Không
 * ném: đơn đã ghi xong; sự kiện nằm trong sổ, lượt sau xét tiếp từ con trỏ.
 */
async function kickWorkflows() {
  try {
    await runWorkflows();
  } catch (error) {
    console.error("[order-create] lượt chạy luật sau khi ghi đơn hỏng — sự kiện vẫn nằm trong sổ, lượt sau xét tiếp:", error instanceof Error ? error.message : error);
  }
}

export type ManualOrderResult = { ok: true; id: string } | MetaFailure;

/** Đơn giá máy gửi phải đúng giá máy chủ tính theo chế độ đã khai; máy không chiết khấu. */
async function agentPriceGate(p: Prepared, mode: AgentPricingMode): Promise<MetaFailure | null> {
  const lines = p.totals.lines;
  const problems = agentPriceProblems(lines, await agentUnitPrices(lines, p.customer.id, mode), p.orderDiscount);
  return problems.length ? fail("CONFLICT", problems) : null;
}

/** Thiếu hàng giữa chừng giao dịch ⇒ ném để huỷ giao dịch, rồi trả lỗi đọc được ở ngoài. */
class StockShortError extends Error {
  constructor(readonly failure: MetaFailure) {
    super("Không đủ hàng khả dụng");
  }
}

/**
 * Phần CẦN THÊM (dòng mới − phần đơn này đang giữ) có đủ hàng khả dụng không — `null` = đủ. `lock` ⇒ khoá mẫu mã trước khi
 * đọc (gọi TRONG giao dịch ghi); không khoá = phép xem trước ngoài giao dịch (quyết định giữ nháp của đơn tự nâng).
 */
async function agentStockFailure(db: StockTx, p: Prepared, held: readonly { variantId: string; quantity: number }[], lock: boolean): Promise<MetaFailure | null> {
  const need = additionalNeed(p.totals.lines, held);
  if (lock) await lockVariants(db, [...need.keys()]);
  const short = await shortfalls(db, need);
  if (!short.length) return null;
  const label = (id: string) => {
    const v = p.variants.get(id);
    return v ? `${v.productName}${v.sku ? ` (${v.sku})` : ""}` : id;
  };
  return fail("CONFLICT", short.map((s) => ({ field: "lines", message: `Không đủ hàng: ${label(s.variantId)} còn ${Math.max(0, s.available)}, cần thêm ${s.need}.` })));
}

/** Kiểm CHẶT trong giao dịch ghi: thiếu ⇒ ném để huỷ giao dịch. */
async function assertAgentStock(tx: StockTx, p: Prepared, held: readonly { variantId: string; quantity: number }[]): Promise<void> {
  const failure = await agentStockFailure(tx, p, held, true);
  if (failure) throw new StockShortError(failure);
}

/**
 * HẠN MỨC NỢ (0188, docs/verticals/price-lists-receivables.md). Chỉ chấm khi đơn được CHỐT (`CONFIRMED`) và khách đã
 * khai hạn mức: dư nợ của mọi đơn tay khác đang chốt / đã giao + phần CHƯA THU của đơn này không được vượt hạn mức. Đơn
 * Mới / Chờ hàng không chấm — chưa ai cam kết giao. Hạn mức trống = chưa khai ⇒ không chặn; hạn mức 0 là khai THẬT.
 */
async function creditGate(p: Prepared, existingOrderId?: string): Promise<MetaFailure | null> {
  if (p.stage !== "CONFIRMED") return null;
  const db = await getDb();
  const [terms] = await db.select({ creditLimit: schema.customerTradeTerms.creditLimit }).from(schema.customerTradeTerms).where(eq(schema.customerTradeTerms.customerId, p.customer.id)).limit(1);
  const limit = terms?.creditLimit ?? null;
  if (limit === null) return null;
  const other = await customerExposure(p.customer.id, { excludeOrderId: existingOrderId });
  let thisDue = p.totals.totalPriceAfterDiscount + p.totals.shippingFee;
  if (existingOrderId) {
    const pays = await db.select({ kind: schema.orderPayments.kind, amount: schema.orderPayments.amount, status: schema.orderPayments.status }).from(schema.orderPayments).where(eq(schema.orderPayments.orderId, existingOrderId));
    thisDue = manualPaymentStatus(sumConfirmedPayments(pays), thisDue).outstanding;
  }
  const c = checkCredit(limit, other, thisDue);
  if (c.ok) return null;
  const vnd = (n: number) => `${n.toLocaleString("vi-VN")} ₫`;
  return fail("INVALID", [{ field: "customerId", message: `Vượt hạn mức nợ của ${p.customer.name}: dư nợ sau đơn ${vnd(c.exposureAfter)} > hạn mức ${vnd(c.limit)} (vượt ${vnd(c.overBy)}). Thu nợ trước, nâng hạn mức ở hồ sơ khách, hoặc lưu đơn ở trạng thái Mới.` }]);
}

export async function createManualOrderCore(user: SessionUser, rawInput: unknown): Promise<ManualOrderResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  return createOrder(userWriter(user), rawInput);
}

/** Máy (chatbot bán hàng) tạo đơn — cổng tổ chức y hệt, quyền do lớp gọi quyết; giá / tồn / khoá lần mua theo `opts`. */
export async function createOrderAsAgent(agent: OrderAgent, rawInput: unknown, opts: AgentOrderOptions): Promise<ManualOrderResult> {
  const gate = await manualOrderOrgGate();
  if (!gate.allowed) return fail(gate.code, gate.reason);
  return createOrder(agentWriter(agent), rawInput, opts);
}

/** Công tắc «đơn đủ thông tin = đã xác nhận» của tổ chức ngữ cảnh (mặc định TẮT). */
export async function loadAutoConfirmComplete(): Promise<boolean> {
  return (await getSettingJson<{ enabled?: unknown }>(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: false })).enabled === true;
}

/**
 * Đơn «Mới» ĐỦ THÔNG TIN ở tổ chức bật công tắc ⇒ «Đã xác nhận» (`AUTO_CONFIRM_COMPLETE_SETTING_KEY`). Vượt hạn mức nợ ⇒ giữ
 * «Mới» — hạn mức là quyết định của người, công tắc không được vượt qua nó.
 */
async function autoConfirmComplete(p: Prepared, existingOrderId?: string): Promise<Prepared> {
  if (p.stage !== "NEW" || !manualOrderComplete(p.recipient, p.totals.lines.length) || !(await loadAutoConfirmComplete())) return p;
  const promoted: Prepared = { ...p, stage: "CONFIRMED" };
  return (await creditGate(promoted, existingOrderId)) ? p : promoted;
}

async function createOrder(w: Writer, rawInput: unknown, agentOpts?: AgentOrderOptions): Promise<ManualOrderResult> {
  const prep = await prepare(rawInput);
  if (!prep.ok) return prep;
  if (agentOpts) {
    const priceBad = await agentPriceGate(prep.p, agentOpts.pricing);
    if (priceBad) return priceBad;
  }
  let p = await autoConfirmComplete(prep.p);
  // Máy chỉ LƯU NHÁP mà công tắc tự nâng lên «Đã xác nhận»: thiếu hàng ⇒ giữ «Mới» (cùng tinh thần hạn mức nợ ở trên) —
  // chỉ lượt máy CHỦ ĐỘNG chốt mới bị từ chối vì thiếu hàng.
  if (agentOpts && p !== prep.p && (await agentStockFailure(await getDb(), p, [], false))) p = prep.p;
  const credit = await creditGate(p);
  if (credit) return credit;
  const id = newManualOrderId();
  const now = new Date();
  const db = await getDb();
  const key = agentOpts?.idempotencyKey?.trim().slice(0, 200) || null;
  let reused = null as string | null;
  try {
    await db.transaction(async (tx) => {
      if (key) {
        // Cùng khoá lần mua ⇒ cùng đơn: khoá theo khoá rồi mới tìm, để hai lượt gọi đồng thời không cùng thấy «chưa có».
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent-order:${key}`}, 0))`);
        const [dup] = await tx.select({ id: schema.orders.id }).from(schema.orders).where(sql`${schema.orders.raw}->>'agentKey' = ${key}`).limit(1);
        if (dup) {
          reused = dup.id;
          return;
        }
      }
      if (agentOpts && p.stage === "CONFIRMED") await assertAgentStock(tx, p, []);
      await tx.insert(schema.orders).values({ id, ...orderColumns(p, w, key ? { agentKey: key } : {}), insertedAt: now, lastUpdateStatusAt: now, syncedAt: now });
    await tx.insert(schema.orderItems).values(itemRows(id, p));
    await tx.insert(schema.orderStatusHistory).values({ orderId: id, status: MANUAL_ORDER_STATUS_CODE[p.stage], oldStatus: null, editorName: w.name, updatedAt: now });
      if (p.stage === "CONFIRMED") await emitOrderEvent(tx, w, "order.confirmed", id, `order.confirmed:${id}`, { stage: p.stage, wasConfirmed: false, changes: [] });
    });
  } catch (error) {
    if (error instanceof StockShortError) return error.failure;
    throw error;
  }
  if (reused) return { ok: true, id: reused };
  await audit({ userId: w.userId, userEmail: w.email, actorKind: w.actorKind === "AGENT" ? "AGENT" : undefined, action: "ORDER_MANUAL_CREATE", entity: "ORDER", entityId: id, before: null, after: snapshotOf(p), reason: w.agent ? `Tạo đơn bởi ${w.agent}` : "Tạo đơn tay trên ERP (tổ chức không đồng bộ đơn)" });
  if (p.stage === "CONFIRMED") await kickWorkflows();
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
  // Đơn đã giao (phiếu ký nhận) là chứng từ đã khép: sửa dòng hàng / huỷ đơn lúc này là viết lại thứ khách đã ký nhận.
  if (row.stage === "DELIVERED") return fail("CONFLICT", "Đơn đã giao (có phiếu ký nhận) — không sửa / huỷ được. Ghi nhầm thì huỷ phiếu giao trước.");
  if (row.stage === "RETURNED") return fail("CONFLICT", "Đơn đã ghi giao không thành công — không sửa / huỷ được. Ghi nhầm thì hoàn tác trước.");
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
  return updateOrder(userWriter(user), orderId, rawInput);
}

export async function updateOrderAsAgent(agent: OrderAgent, orderId: unknown, rawInput: unknown, opts: AgentOrderOptions): Promise<ManualOrderResult> {
  const gate = await manualOrderOrgGate();
  if (!gate.allowed) return fail(gate.code, gate.reason);
  return updateOrder(agentWriter(agent), orderId, rawInput, opts);
}

/** Người nhận đang lưu trên dòng đơn — để so với bản mới. */
function storedRecipient(row: typeof schema.orders.$inferSelect): Recipient {
  return { name: row.shipFullName ?? "", phone: row.shipPhone ?? "", address: row.shipAddress ?? "", province: row.shipProvince ?? "" };
}

async function updateOrder(w: Writer, orderId: unknown, rawInput: unknown, agentOpts?: AgentOrderOptions): Promise<ManualOrderResult> {
  const existing = await loadEditable(orderId);
  if (!existing.ok) return existing;
  const prep = await prepare(rawInput);
  if (!prep.ok) return prep;
  if (agentOpts) {
    const priceBad = await agentPriceGate(prep.p, agentOpts.pricing);
    if (priceBad) return priceBad;
  }
  const row = existing.row;
  let p = await autoConfirmComplete(prep.p, row.id);
  // Như lượt tạo: công tắc tự nâng đơn NHÁP của máy mà thiếu hàng ⇒ giữ «Mới» (đơn tự nâng chỉ đi từ «Mới» ⇒ chưa giữ hàng).
  if (agentOpts && p !== prep.p && (await agentStockFailure(await getDb(), p, [], false))) p = prep.p;
  const credit = await creditGate(p, row.id);
  if (credit) return credit;
  const beforeItems = await itemsSnapshot(row.id);
  const now = new Date();
  const db = await getDb();
  const stageChanged = row.stage !== p.stage;
  const before: OrderMaterial = {
    customerId: row.customerId ?? "",
    stage: row.stage,
    lines: beforeItems.map((i) => ({ variantId: i.variantId ?? "", quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount })),
    recipient: storedRecipient(row),
    amountDue: row.totalPriceAfterDiscount + row.shippingFee,
  };
  const after = materialOf(p);
  const wasConfirmed = row.stage === "CONFIRMED";
  const changes = materialChanges(before, after);
  // Chốt LẦN ĐẦU qua lượt sửa ⇒ `confirmed`. Đơn ĐÃ chốt đổi phần vận hành phải biết ⇒ `updated`, khoá theo mốc sửa TRƯỚC
  // đó + bản mới: gửi lại đúng lượt sửa này thì bản mới = bản đang lưu ⇒ không đổi gì ⇒ không sự kiện; A→B→A→B thì mỗi
  // lượt một mốc khác ⇒ mỗi lượt một sự kiện.
  const event: { name: "order.confirmed" | "order.updated"; key: string } | null =
    !wasConfirmed && p.stage === "CONFIRMED"
      ? { name: "order.confirmed", key: `order.confirmed:${row.id}` }
      : wasConfirmed && changes.length > 0
        ? { name: "order.updated", key: `order.updated:${row.id}:${createHash("sha256").update(`${row.updatedAt.toISOString()}|${JSON.stringify(after)}`).digest("hex").slice(0, 24)}` }
        : null;
  try {
    await db.transaction(async (tx) => {
      // Máy chốt / sửa đơn đã chốt ⇒ kiểm phần hàng CẦN THÊM so với phần đơn này đang giữ (đơn đã chốt trước đó).
      if (agentOpts && p.stage === "CONFIRMED") await assertAgentStock(tx, p, wasConfirmed ? beforeItems.flatMap((i) => (i.variantId ? [{ variantId: i.variantId, quantity: i.quantity }] : [])) : []);
      await tx
      .update(schema.orders)
      .set({ ...orderColumns(p, w), creatorName: row.creatorName, raw: { ...(row.raw as Record<string, unknown>), ...(manualOrderRaw(row.raw) as ManualOrderRaw), orderDiscount: p.orderDiscount }, ...(stageChanged ? { lastUpdateStatusAt: now } : {}), updatedAt: now })
      .where(and(eq(schema.orders.id, row.id)));
    await tx.delete(schema.orderItems).where(eq(schema.orderItems.orderId, row.id));
    await tx.insert(schema.orderItems).values(itemRows(row.id, p));
    if (stageChanged) await tx.insert(schema.orderStatusHistory).values({ orderId: row.id, status: MANUAL_ORDER_STATUS_CODE[p.stage], oldStatus: row.status, editorName: w.name, updatedAt: now });
      if (event) await emitOrderEvent(tx, w, event.name, row.id, event.key, { stage: p.stage, wasConfirmed, changes });
    });
  } catch (error) {
    if (error instanceof StockShortError) return error.failure;
    throw error;
  }
  await audit({
    userId: w.userId,
    userEmail: w.email,
    actorKind: w.actorKind === "AGENT" ? "AGENT" : undefined,
    action: "ORDER_MANUAL_UPDATE",
    entity: "ORDER",
    entityId: row.id,
    before: { customerId: row.customerId, stage: row.stage, lines: beforeItems, shippingFee: row.shippingFee, totalPriceAfterDiscount: row.totalPriceAfterDiscount, note: row.note, recipient: before.recipient },
    after: snapshotOf(p),
    reason: w.agent ? `Sửa đơn bởi ${w.agent}` : "Sửa đơn tạo tay",
  });
  if (event) await kickWorkflows();
  return { ok: true, id: row.id };
}

const cancelZ = z.object({ reason: z.string().trim().min(MANUAL_ORDER_LIMITS.reasonMin, "nói vì sao huỷ đơn").max(MANUAL_ORDER_LIMITS.reasonMax) }).strict();

export async function cancelManualOrderCore(user: SessionUser, orderId: unknown, rawInput: unknown): Promise<ManualOrderResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  return cancelOrder(userWriter(user), orderId, rawInput);
}

async function cancelOrder(w: Writer, orderId: unknown, rawInput: unknown): Promise<ManualOrderResult> {
  const existing = await loadEditable(orderId);
  if (!existing.ok) return existing;
  const parsed = cancelZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const row = existing.row;
  const now = new Date();
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.update(schema.orders).set({ stage: "CANCELLED", status: MANUAL_ORDER_STATUS_CODE.CANCELLED, statusName: manualOrderStageLabel("CANCELLED"), lastUpdateStatusAt: now, updatedAt: now }).where(eq(schema.orders.id, row.id));
    await tx.insert(schema.orderStatusHistory).values({ orderId: row.id, status: MANUAL_ORDER_STATUS_CODE.CANCELLED, oldStatus: row.status, editorName: w.name, updatedAt: now });
    await emitOrderEvent(tx, w, "order.cancelled", row.id, `order.cancelled:${row.id}`, { stage: "CANCELLED", wasConfirmed: row.stage === "CONFIRMED", changes: ["stage"], reason: parsed.data.reason });
  });
  await audit({ userId: w.userId, userEmail: w.email, actorKind: w.actorKind === "AGENT" ? "AGENT" : undefined, action: "ORDER_MANUAL_CANCEL", entity: "ORDER", entityId: row.id, before: { stage: row.stage }, after: { stage: "CANCELLED" }, reason: parsed.data.reason });
  await kickWorkflows();
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
export async function manualOrderFormValues(orderId: string): Promise<{ customerId: string; stage: ManualOrderStage; lines: { variantId: string; quantity: number; unitPrice: number; discount: number }[]; orderDiscount: number; shippingFee: number; note: string; channel: string; recipient: Recipient } | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  const raw = row ? manualOrderRaw(row.raw) : null;
  if (!row || !raw || !isManualOrderId(row.id) || row.stage === "CANCELLED" || row.stage === "DELIVERED") return null;
  const items = await itemsSnapshot(row.id);
  return {
    customerId: row.customerId ?? "",
    stage: (MANUAL_ORDER_STAGES as readonly string[]).includes(row.stage) ? (row.stage as ManualOrderStage) : "NEW",
    lines: items.map((i) => ({ variantId: i.variantId ?? "", quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount })),
    orderDiscount: raw.orderDiscount,
    shippingFee: row.shippingFee,
    note: row.note,
    channel: row.source === "Khác" ? "" : row.source,
    recipient: storedRecipient(row),
  };
}

// ─────────────────────────── Xác nhận giao bằng phiếu có ký nhận (G-ORDER) ───────────────────────────

const deliveryZ = z
  .object({
    signedAt: z.iso.datetime({ offset: true, error: "Nhập mốc người nhận ký (ngày giờ)" }),
    receiverName: z.string({ error: "Nhập tên người ký nhận" }).trim().min(1, "Nhập tên người ký nhận trên phiếu").max(DELIVERY_NOTE_LIMITS.receiverMax, "Tên người ký nhận quá dài"),
    note: z.string().max(DELIVERY_NOTE_LIMITS.noteMax, "Ghi chú quá dài").default(""),
  })
  .strict();
const voidDeliveryZ = z.object({ reason: z.string().trim().min(DELIVERY_NOTE_LIMITS.reasonMin, "nói vì sao huỷ phiếu giao").max(DELIVERY_NOTE_LIMITS.reasonMax) }).strict();

async function loadManual(orderId: unknown): Promise<ExistingManual> {
  if (typeof orderId !== "string" || !orderId || orderId.length > 200) return fail("NOT_FOUND", "Không có đơn này.");
  const db = await getDb();
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  if (!row) return fail("NOT_FOUND", "Không có đơn này.");
  if (!isManualOrderId(row.id) || !manualOrderRaw(row.raw)) return fail("NOT_SUPPORTED", "Đơn đồng bộ từ nguồn khác — kết quả giao theo chứng từ đơn vị vận chuyển, không theo phiếu giao tay.");
  return { ok: true, row };
}

/**
 * XÁC NHẬN ĐÃ GIAO bằng phiếu giao có ký nhận. Cổng: cùng `manualOrderGate` (tổ chức không đồng bộ đơn + `orders:write`)
 * → đơn tay → CHỈ "Đã xác nhận" → không có vận đơn nào (đơn có vận đơn đi theo chứng từ ĐVVC, không nhận phiếu tay) →
 * zod → mốc ký không ở tương lai. MỘT giao dịch: stage `DELIVERED` (chỉ khi stage còn là CONFIRMED — bấm hai lần hay hai
 * người bấm cùng lúc thì lượt sau không ghi gì) + phiếu + lịch sử trạng thái. Nhật ký `ORDER_MANUAL_DELIVER`.
 */
export async function confirmManualDeliveryCore(user: SessionUser, orderId: unknown, rawInput: unknown): Promise<ManualOrderResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const existing = await loadManual(orderId);
  if (!existing.ok) return existing;
  const row = existing.row;
  if (!canConfirmManualDelivery(row.stage)) {
    return fail("CONFLICT", row.stage === "DELIVERED" ? "Đơn đã có phiếu giao còn hiệu lực." : `Chỉ đơn «${manualOrderStageLabel("CONFIRMED")}» mới xác nhận giao được — chốt đơn với khách trước.`);
  }
  const db = await getDb();
  const [ship] = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.orderId, row.id)).limit(1);
  if (ship) return fail("NOT_SUPPORTED", "Đơn đã có vận đơn — kết quả giao theo chứng từ đơn vị vận chuyển, không theo phiếu giao tay.");
  const parsed = deliveryZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const signedAt = new Date(parsed.data.signedAt);
  const now = new Date();
  if (signedAt.getTime() > now.getTime() + DELIVERY_NOTE_LIMITS.futureSkewMs) return fail("INVALID", [{ field: "signedAt", message: "Mốc ký nhận ở tương lai — nhập đúng ngày giờ trên phiếu." }]);
  const note = { orderId: row.id, signedAt, receiverName: parsed.data.receiverName, note: parsed.data.note.trim(), recordedByUserId: user.id, recordedByName: user.name, recordedAt: now };
  // Phí giao đồng giá của tổ chức (đã khai) ⇒ cước shop trả cho đơn này; chưa khai ⇒ giữ nguyên số đang có.
  const fee = await loadManualDeliveryFee();
  const noteId = await db.transaction(async (tx) => {
    const moved = await tx
      .update(schema.orders)
      .set({ stage: "DELIVERED", status: MANUAL_ORDER_STATUS_CODE.DELIVERED, statusName: manualOrderStageLabel("DELIVERED"), ...(fee !== null ? { partnerFee: fee } : {}), lastUpdateStatusAt: now, updatedAt: now })
      .where(and(eq(schema.orders.id, row.id), inArray(schema.orders.stage, [...MANUAL_DELIVERY_FROM_STAGES])))
      .returning({ id: schema.orders.id });
    if (!moved.length) return null;
    const [ins] = await tx.insert(schema.orderDeliveryNotes).values(note).returning({ id: schema.orderDeliveryNotes.id });
    await tx.insert(schema.orderStatusHistory).values({ orderId: row.id, status: MANUAL_ORDER_STATUS_CODE.DELIVERED, oldStatus: row.status, editorName: user.name, updatedAt: now });
    return ins.id;
  });
  if (!noteId) return fail("CONFLICT", "Đơn vừa đổi trạng thái — tải lại trang rồi thử lại.");
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ORDER_MANUAL_DELIVER",
    entity: "ORDER",
    entityId: row.id,
    before: { stage: row.stage },
    after: { stage: "DELIVERED", deliveryNoteId: noteId, signedAt: signedAt.toISOString(), receiverName: note.receiverName, note: note.note || null, ...(fee !== null ? { partnerFee: fee } : {}) },
    reason: "Xác nhận đã giao bằng phiếu giao có ký nhận (G-ORDER) — không ghi nhận tiền",
  });
  return { ok: true, id: row.id };
}

/**
 * HUỶ PHIẾU GIAO (ghi nhầm): bắt buộc lý do; phiếu giữ nguyên làm vết (`voided_*`), đơn về "Đã xác nhận" ⇒ `ORDER_OUTCOME`
 * thôi `DELIVERED`, hàng quay lại kho (vào lại phần giữ ở khả dụng). Không có phiếu còn hiệu lực ⇒ CONFLICT, không ghi gì
 * (bấm hai lần — mục 61). Nhật ký `ORDER_MANUAL_DELIVERY_VOID`.
 */
export async function voidManualDeliveryCore(user: SessionUser, orderId: unknown, rawInput: unknown): Promise<ManualOrderResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const existing = await loadManual(orderId);
  if (!existing.ok) return existing;
  const parsed = voidDeliveryZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const row = existing.row;
  const now = new Date();
  const db = await getDb();
  const voided = await db.transaction(async (tx) => {
    const [n] = await tx
      .update(schema.orderDeliveryNotes)
      .set({ voidedAt: now, voidedByUserId: user.id, voidedByName: user.name, voidReason: parsed.data.reason })
      .where(and(eq(schema.orderDeliveryNotes.orderId, row.id), isNull(schema.orderDeliveryNotes.voidedAt)))
      .returning({ id: schema.orderDeliveryNotes.id, signedAt: schema.orderDeliveryNotes.signedAt, receiverName: schema.orderDeliveryNotes.receiverName });
    if (!n) return null;
    await tx
      .update(schema.orders)
      .set({ stage: "CONFIRMED", status: MANUAL_ORDER_STATUS_CODE.CONFIRMED, statusName: manualOrderStageLabel("CONFIRMED"), partnerFee: 0, lastUpdateStatusAt: now, updatedAt: now })
      .where(and(eq(schema.orders.id, row.id), eq(schema.orders.stage, "DELIVERED")));
    await tx.insert(schema.orderStatusHistory).values({ orderId: row.id, status: MANUAL_ORDER_STATUS_CODE.CONFIRMED, oldStatus: row.status, editorName: user.name, updatedAt: now });
    return n;
  });
  if (!voided) return fail("CONFLICT", "Đơn không có phiếu giao còn hiệu lực.");
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "ORDER_MANUAL_DELIVERY_VOID",
    entity: "ORDER",
    entityId: row.id,
    before: { stage: row.stage, deliveryNoteId: voided.id, signedAt: voided.signedAt.toISOString(), receiverName: voided.receiverName },
    after: { stage: "CONFIRMED", deliveryNoteId: voided.id, voided: true },
    reason: parsed.data.reason,
  });
  return { ok: true, id: row.id };
}

/** Phí giao đồng giá đã khai của tổ chức ngữ cảnh — `null` khi chưa khai. */
export async function loadManualDeliveryFee(): Promise<number | null> {
  return parseManualDeliveryFee(await getSettingJson<unknown>(MANUAL_DELIVERY_FEE_SETTING_KEY, null));
}

/** Khai / sửa / xoá (`null`) phí giao mỗi đơn giao thành công. Cùng cổng đơn tay + quyền cấu hình. Đơn đã giao giữ phí cũ. */
export async function saveManualDeliveryFeeCore(user: SessionUser, raw: unknown): Promise<{ ok: true; fee: number | null } | MetaFailure> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  if (!can(user, "settings:manage")) return fail("FORBIDDEN", "Cần quyền cấu hình (settings:manage) để khai phí giao.");
  const empty = raw === null || raw === undefined || raw === "";
  const fee = empty ? null : parseManualDeliveryFee(raw);
  if (!empty && fee === null) return fail("INVALID", [{ field: "fee", message: "Phí giao là số tiền nguyên từ 0 tới 10.000.000 ₫." }]);
  const before = await loadManualDeliveryFee();
  await setSettingJson(MANUAL_DELIVERY_FEE_SETTING_KEY, fee);
  await audit({ userId: user.id, userEmail: user.email, action: "ORDER_MANUAL_DELIVERY_FEE", entity: "SETTINGS", entityId: MANUAL_DELIVERY_FEE_SETTING_KEY, before: { fee: before }, after: { fee }, reason: fee === null ? "Xoá phí giao đồng giá" : "Khai phí giao đồng giá mỗi đơn giao thành công" });
  return { ok: true, fee };
}

/**
 * Bật / tắt «đơn đủ thông tin = đã xác nhận». Bật ⇒ các đơn tay «Mới» ĐANG CÓ mà đủ thông tin cũng được xác nhận NGAY
 * trong lượt bấm này — đi qua ĐÚNG đường sửa đơn (`updateOrder`: hạn mức nợ, sự kiện `order.confirmed`, nhật ký từng
 * đơn), và kết quả trả về nói rõ bao nhiêu đơn được chuyển. Đơn thiếu SĐT / địa chỉ / hàng giữ «Mới».
 */
export async function saveAutoConfirmCompleteCore(user: SessionUser, enabled: boolean): Promise<{ ok: true; enabled: boolean; promoted: number; kept: number } | MetaFailure> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  if (!can(user, "settings:manage")) return fail("FORBIDDEN", "Cần quyền cấu hình (settings:manage) để đổi cách tính đơn.");
  const before = await loadAutoConfirmComplete();
  await setSettingJson(AUTO_CONFIRM_COMPLETE_SETTING_KEY, { enabled: enabled === true });
  await audit({ userId: user.id, userEmail: user.email, action: "ORDER_AUTO_CONFIRM_COMPLETE", entity: "SETTINGS", entityId: AUTO_CONFIRM_COMPLETE_SETTING_KEY, before: { enabled: before }, after: { enabled: enabled === true }, reason: enabled ? "Đơn đủ thông tin (SĐT · địa chỉ · hàng) tính là đã xác nhận" : "Tắt tự xác nhận đơn đủ thông tin" });
  let promoted = 0;
  let kept = 0;
  if (enabled === true) {
    const db = await getDb();
    const rows = await db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.stage, "NEW"), sql`${schema.orders.id} like ${`${MANUAL_ORDER_ID_PREFIX}%`}`));
    for (const r of rows) {
      const values = await manualOrderFormValues(r.id);
      if (!values || !manualOrderComplete(values.recipient, values.lines.length)) {
        kept += 1;
        continue;
      }
      const res = await updateOrder(userWriter(user), r.id, values);
      const [after] = await db.select({ stage: schema.orders.stage }).from(schema.orders).where(eq(schema.orders.id, r.id)).limit(1);
      if (res.ok && after?.stage === "CONFIRMED") promoted += 1;
      else kept += 1;
    }
  }
  return { ok: true, enabled: enabled === true, promoted, kept };
}

const failedZ = z.object({ reason: z.string().trim().min(DELIVERY_NOTE_LIMITS.reasonMin, "nói vì sao giao không thành công (khách không nhận, sai địa chỉ…)").max(DELIVERY_NOTE_LIMITS.reasonMax) }).strict();

/**
 * GIAO KHÔNG THÀNH CÔNG (ORDER_OUTCOME.md mục 11.2): «Đã xác nhận» ⇒ «Đã hoàn» (`RETURNED`). Cùng cổng với phiếu giao,
 * bắt buộc lý do, không vận đơn nào. MỘT giao dịch: stage (chỉ khi còn CONFIRMED — bấm hai lần không ghi gì thêm) + lịch
 * sử trạng thái. Hàng quay lại khả dụng ngay vì đơn thôi «giữ hàng» và chưa từng rời kho. Nhật ký `ORDER_MANUAL_DELIVERY_FAILED`.
 */
export async function markManualDeliveryFailedCore(user: SessionUser, orderId: unknown, rawInput: unknown): Promise<ManualOrderResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const existing = await loadManual(orderId);
  if (!existing.ok) return existing;
  const row = existing.row;
  if (!canMarkManualDeliveryFailed(row.stage)) {
    return fail(
      "CONFLICT",
      row.stage === "DELIVERED"
        ? "Đơn đang có phiếu giao — huỷ phiếu giao (ghi nhầm) trước rồi mới báo giao không thành công."
        : row.stage === "RETURNED"
          ? "Đơn đã được ghi giao không thành công."
          : `Chỉ đơn «${manualOrderStageLabel("CONFIRMED")}» mới báo giao không thành công được.`,
    );
  }
  const parsed = failedZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const db = await getDb();
  const [ship] = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.orderId, row.id)).limit(1);
  if (ship) return fail("NOT_SUPPORTED", "Đơn đã có vận đơn — kết quả giao theo chứng từ đơn vị vận chuyển.");
  const now = new Date();
  const moved = await db.transaction(async (tx) => {
    const r = await tx
      .update(schema.orders)
      .set({ stage: "RETURNED", status: MANUAL_ORDER_STATUS_CODE.RETURNED, statusName: manualOrderStageLabel("RETURNED"), partnerFee: 0, lastUpdateStatusAt: now, updatedAt: now })
      .where(and(eq(schema.orders.id, row.id), inArray(schema.orders.stage, [...MANUAL_FAILED_FROM_STAGES])))
      .returning({ id: schema.orders.id });
    if (!r.length) return false;
    await tx.insert(schema.orderStatusHistory).values({ orderId: row.id, status: MANUAL_ORDER_STATUS_CODE.RETURNED, oldStatus: row.status, editorName: user.name, updatedAt: now });
    return true;
  });
  if (!moved) return fail("CONFLICT", "Đơn vừa đổi trạng thái — tải lại trang rồi thử lại.");
  await audit({ userId: user.id, userEmail: user.email, action: "ORDER_MANUAL_DELIVERY_FAILED", entity: "ORDER", entityId: row.id, before: { stage: row.stage }, after: { stage: "RETURNED" }, reason: parsed.data.reason });
  return { ok: true, id: row.id };
}

/** Hoàn tác «giao không thành công» (ghi nhầm): «Đã hoàn» ⇒ «Đã xác nhận», hàng vào lại phần giữ. Bắt buộc lý do. */
export async function undoManualDeliveryFailedCore(user: SessionUser, orderId: unknown, rawInput: unknown): Promise<ManualOrderResult> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return fail(gate.code, gate.reason);
  const existing = await loadManual(orderId);
  if (!existing.ok) return existing;
  const parsed = failedZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const row = existing.row;
  const now = new Date();
  const db = await getDb();
  const moved = await db.transaction(async (tx) => {
    const r = await tx
      .update(schema.orders)
      .set({ stage: "CONFIRMED", status: MANUAL_ORDER_STATUS_CODE.CONFIRMED, statusName: manualOrderStageLabel("CONFIRMED"), lastUpdateStatusAt: now, updatedAt: now })
      .where(and(eq(schema.orders.id, row.id), eq(schema.orders.stage, "RETURNED")))
      .returning({ id: schema.orders.id });
    if (!r.length) return false;
    await tx.insert(schema.orderStatusHistory).values({ orderId: row.id, status: MANUAL_ORDER_STATUS_CODE.CONFIRMED, oldStatus: row.status, editorName: user.name, updatedAt: now });
    return true;
  });
  if (!moved) return fail("CONFLICT", "Đơn không ở trạng thái giao không thành công.");
  await audit({ userId: user.id, userEmail: user.email, action: "ORDER_MANUAL_DELIVERY_FAILED_UNDO", entity: "ORDER", entityId: row.id, before: { stage: "RETURNED" }, after: { stage: "CONFIRMED" }, reason: parsed.data.reason });
  return { ok: true, id: row.id };
}

export type DeliveryNoteView = { id: string; signedAt: Date; receiverName: string; note: string; recordedByName: string; recordedAt: Date; voidedAt: Date | null; voidedByName: string; voidReason: string | null };

/**
 * Phiếu giao của MỘT đơn tay (còn hiệu lực + đã huỷ, mới nhất trước) và các phiếu XUẤT TAY cũ tham chiếu tới đơn — bản
 * trước có lối "Lập phiếu xuất kho" điền `reference` = id đơn. Có phiếu xuất như vậy thì xác nhận giao sẽ trừ tồn LẦN
 * HAI: trang đơn nêu ra để kho lập phiếu điều chỉnh tăng (ORDER_OUTCOME.md mục 11). ERP không tự sửa dữ liệu kho.
 */
export async function manualOrderDeliveryView(orderId: string): Promise<{ active: DeliveryNoteView | null; voided: DeliveryNoteView[]; priorIssues: { id: string; receivedAt: Date; totalQuantity: number }[] }> {
  if (!isManualOrderId(orderId) || orderId.length > 200) return { active: null, voided: [], priorIssues: [] };
  const db = await getDb();
  const n = schema.orderDeliveryNotes;
  const [notes, issues] = await Promise.all([
    db
      .select({ id: n.id, signedAt: n.signedAt, receiverName: n.receiverName, note: n.note, recordedByName: n.recordedByName, recordedAt: n.recordedAt, voidedAt: n.voidedAt, voidedByName: n.voidedByName, voidReason: n.voidReason })
      .from(n)
      .where(eq(n.orderId, orderId))
      .orderBy(desc(n.recordedAt)),
    db
      .select({ id: schema.stockReceipts.id, receivedAt: schema.stockReceipts.receivedAt, totalQuantity: schema.stockReceipts.totalQuantity })
      .from(schema.stockReceipts)
      .where(and(eq(schema.stockReceipts.kind, "ISSUE"), eq(schema.stockReceipts.reference, orderId)))
      .orderBy(asc(schema.stockReceipts.receivedAt)),
  ]);
  return { active: notes.find((x) => !x.voidedAt) ?? null, voided: notes.filter((x) => x.voidedAt), priorIssues: issues.map((r) => ({ id: r.id, receivedAt: r.receivedAt, totalQuantity: Math.abs(Number(r.totalQuantity ?? 0)) })) };
}
