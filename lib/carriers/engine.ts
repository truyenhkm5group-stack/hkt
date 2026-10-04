import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { connectionIsActive } from "@/lib/connectors/service";
import { CARRIER_ADAPTERS, carrierAdapter, isCarrierKey } from "@/lib/carriers/registry";
import { CARRIER_KEYS, type CarrierAdapter, type CarrierDeps, type CarrierDraft, type CarrierKey, type CarrierQuote, type CarrierSession } from "@/lib/carriers/types";
import { attemptHoldsOrder, carrierCancelOf, carrierCreateOf, linesWeight, normalizeVtpPhone, receiverAddressLine, vtpReferenceFor, type CarrierCancelRaw, type CarrierCreateRaw, type VtpShipmentLine } from "@/lib/constants/carrier-vtp";
import { manualOrderAmountDue, manualPaymentStatus, sumConfirmedPayments } from "@/lib/constants/order-payments";
import { isManualOrderId, manualOrderRaw, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { isUniqueViolation } from "@/lib/db/unique-violation";

/**
 * ═══════════ LÕI TẠO VẬN ĐƠN TỪ ĐƠN ERP — MỌI HÃNG (POS tự chủ · docs/verticals/pos-tu-chu.md) ═══════════
 *
 * Shop khách không dùng Pancake POS vẫn đẩy được đơn sang hãng: tính cước → tạo → in nhãn → huỷ khi hãng chưa lấy hàng. Mỗi
 * hãng là MỘT adapter (`lib/carriers/registry.ts`); mọi luật dưới đây là của lõi, không hãng nào viết lại.
 *
 * BA LUẬT KHÔNG THƯƠNG LƯỢNG:
 *  1. MỘT LẦN GỬI KHÔNG BAO GIỜ THÀNH HAI VẬN ĐƠN. Dòng `shipments` được GIỮ CHỖ trong một giao dịch có khoá theo đơn TRƯỚC
 *     khi gọi hãng; mã ERP của lần gửi đi kèm để chính hãng chặn trùng; client không tự gửi lại. Lượt gọi đứt giữa chừng ⇒
 *     giữ chỗ ở UNKNOWN, KHÔNG tự xoá, KHÔNG tự gửi lại — người tra rồi quyết («Thử lại» chỉ có ở hãng gửi lại CÙNG mã là an
 *     toàn, «Bỏ lượt tạo» khi chắc chắn hãng không có).
 *  2. LOGISTICS ≠ TIỀN (ORDER_OUTCOME.md). Lõi chỉ ghi chặng chờ lấy (mặc định của cột) và KHÔNG ghi `shipments.stage`
 *     (`SHIPMENT_STAGE_WRITERS`): hành trình về qua webhook của tổ chức. Huỷ thành công ở hãng ghi `raw.carrierCancel` — lời
 *     nhận lệnh của hãng — chứ không tự đặt «Đã huỷ»; mã huỷ trên webhook mới là chứng từ.
 *  3. ĐƠN ĐÃ GỬI KHÔNG SỬA LẶNG LẼ. `loadEditable` (lib/records/order-create.ts) chặn sửa / huỷ đơn khi còn lần gửi đang
 *     giữ đơn: sửa dòng hàng ở ERP không đổi được vận đơn bên hãng.
 */

export type CarrierResult<T extends object = object> = ({ ok: true; message: string } & T) | { ok: false; error: string };

const PERMISSION = "shipments:manage";
const NO_PERMISSION = "Bạn không có quyền thao tác vận đơn (shipments:manage).";
/** Lượt tạo «đang chờ hãng» quá ngần này mà chưa có kết quả ⇒ coi như treo, cho người bỏ / thử lại. */
const STALE_REQUEST_MS = 5 * 60_000;
/** Trần một lượt hàng loạt: tạo tuần tự, mỗi đơn hai-ba lượt gọi hãng — 50 đơn là chừng một phút chờ. */
export const BULK_MAX = 50;
/** Trần một lượt in hàng loạt (trần tài liệu `printing-code` của Viettel Post; GHN cho tới 10.000). */
export const PRINT_MAX = 100;

type OrderRow = typeof schema.orders.$inferSelect;
type ShipmentRow = typeof schema.shipments.$inferSelect;

type Loaded = { ok: true; order: OrderRow; lines: VtpShipmentLine[]; attempts: ShipmentRow[] } | { ok: false; error: string };

async function loadOrder(orderId: unknown): Promise<Loaded> {
  if (typeof orderId !== "string" || !orderId || orderId.length > 200) return { ok: false, error: "Không có đơn này." };
  const db = await getDb();
  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  if (!order) return { ok: false, error: "Không có đơn này." };
  if (!isManualOrderId(order.id) || !manualOrderRaw(order.raw)) return { ok: false, error: "Chỉ đơn tạo trong ERP mới tạo vận đơn ở đây — đơn đồng bộ được nguồn của nó đẩy sang hãng." };
  const [items, attempts] = await Promise.all([
    db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order.id)).orderBy(asc(schema.orderItems.id)),
    db.select().from(schema.shipments).where(eq(schema.shipments.orderId, order.id)).orderBy(asc(schema.shipments.createdAt)),
  ]);
  const lines = items.map((i) => ({ name: [i.productName, i.variationDetail].filter(Boolean).join(" · ") || "Hàng hoá", quantity: i.quantity, unitPrice: i.unitPrice, weightGrams: i.weight }));
  return { ok: true, order, lines, attempts };
}

/** Số khách CÒN PHẢI TRẢ theo chứng từ thanh toán — mặc định tiền thu hộ (khách đã chuyển khoản trước thì thu hộ ít đi). */
async function outstandingOf(order: OrderRow): Promise<number> {
  const db = await getDb();
  const rows = await db.select({ kind: schema.orderPayments.kind, amount: schema.orderPayments.amount, status: schema.orderPayments.status }).from(schema.orderPayments).where(eq(schema.orderPayments.orderId, order.id));
  return manualPaymentStatus(sumConfirmedPayments(rows), manualOrderAmountDue(order)).outstanding;
}

type DraftInput = { weightGrams: number; cod: number; serviceCode?: string; note?: string; province?: string; ward?: string };

function draftOf(order: OrderRow, lines: VtpShipmentLine[], input: DraftInput, reference: string): CarrierDraft {
  return {
    reference,
    receiver: {
      name: order.shipFullName || order.billFullName || "",
      phone: normalizeVtpPhone(order.shipPhone || order.billPhone || ""),
      address: receiverAddressLine(order),
      province: (input.province ?? "").trim() || order.shipProvince || "",
      ward: (input.ward ?? "").trim() || order.shipCommune || "",
    },
    lines,
    goodsValue: Math.max(0, order.totalPriceAfterDiscount),
    weightGrams: input.weightGrams,
    cod: input.cod,
    serviceCode: input.serviceCode ?? "",
    note: (input.note ?? "").trim(),
  };
}

function eligibility(order: OrderRow, attempts: ShipmentRow[]): string | null {
  if (order.stage !== "CONFIRMED") return "Chỉ đơn «Đã xác nhận» mới tạo vận đơn — chốt đơn với khách trước.";
  if (attempts.some((a) => attemptHoldsOrder({ stage: a.stage, raw: a.raw }))) return "Đơn đang có một lần gửi còn hiệu lực — huỷ vận đơn đó (hoặc bỏ lượt tạo chưa rõ kết quả) trước khi tạo lần gửi mới.";
  return null;
}

/** Hãng của một lần gửi do ERP tạo (dòng cũ của bước 1 không ghi hãng ⇒ Viettel Post). */
function adapterOf(row: ShipmentRow): CarrierAdapter | null {
  const create = carrierCreateOf(row.raw);
  if (!create) return null;
  return carrierAdapter(create.carrier ?? "VTP");
}

async function openSession(adapter: CarrierAdapter, deps: CarrierDeps): Promise<{ ok: true; session: CarrierSession } | { ok: false; error: string }> {
  return adapter.open(deps);
}

// ───────────────────────────── ĐỌC CHO MÀN HÌNH ─────────────────────────────

export type CarrierAttemptView = {
  id: string;
  carrier: CarrierKey;
  carrierLabel: string;
  trackingCode: string | null;
  create: CarrierCreateRaw | null;
  cancel: CarrierCancelRaw | null;
  canCancel: boolean;
  canPrint: boolean;
  canDiscard: boolean;
  canRetry: boolean;
};

export type CarrierOption = { key: CarrierKey; label: string; ready: boolean; needsStructuredAddress: boolean };

export type CarrierPanelView = {
  /** Hãng nào tổ chức đã bật (Kiểm tra đạt + Bật) — rỗng ⇒ lời dẫn đi khai kết nối. */
  carriers: CarrierOption[];
  connectionNote: string | null;
  blockedReason: string | null;
  /** Không có ghi chú: ô để trống ⇒ adapter dùng ghi chú mặc định của tổ chức — trang không đọc cài đặt kết nối. */
  defaults: { weightGrams: number | null; cod: number; receiverAddress: string; province: string; ward: string };
  attempts: CarrierAttemptView[];
};

function trackingOf(a: ShipmentRow): string | null {
  return a.vtpOrderNumber ?? a.trackingCode ?? null;
}

function attemptView(a: ShipmentRow): CarrierAttemptView | null {
  const adapter = adapterOf(a);
  if (!adapter) return null;
  const create = carrierCreateOf(a.raw);
  const cancel = carrierCancelOf(a.raw);
  const code = trackingOf(a);
  const stuck = create?.state === "UNKNOWN" || (create?.state === "REQUESTED" && Date.now() - Date.parse(create.at) > STALE_REQUEST_MS);
  return {
    id: a.id,
    carrier: adapter.key,
    carrierLabel: adapter.label,
    trackingCode: code,
    create,
    cancel,
    canCancel: Boolean(code) && create?.state === "CREATED" && !cancel && adapter.cancellable({ stage: a.stage, vtpStatus: a.vtpStatus }),
    canPrint: Boolean(code) && a.stage !== "CANCELLED" && !cancel,
    canDiscard: !code && stuck,
    canRetry: !code && stuck && adapter.idempotentRetry && Boolean(create?.draft),
  };
}

/** Các hãng tổ chức đã bật — đọc trạng thái kết nối qua service (một đường đọc / ghi), không giải mã gì. */
export async function enabledCarriers(): Promise<CarrierOption[]> {
  const out: CarrierOption[] = [];
  for (const key of CARRIER_KEYS) {
    const a = CARRIER_ADAPTERS[key];
    out.push({ key, label: a.label, ready: await connectionIsActive(a.connectorKey), needsStructuredAddress: a.needsStructuredAddress });
  }
  return out;
}

/** Mọi thứ khung «Gửi hàng» trên trang đơn cần — CHỈ ĐỌC, không gọi hãng, không giải mã mật khẩu. */
export async function carrierPanel(user: SessionUser, orderId: string): Promise<CarrierPanelView | null> {
  if (!can(user, PERMISSION)) return null;
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return null;
  const { order, lines, attempts } = loaded;
  const carriers = await enabledCarriers();
  const anyReady = carriers.some((c) => c.ready);
  return {
    carriers,
    connectionNote: anyReady ? null : "Chưa bật hãng vận chuyển nào — Cài đặt → Kết nối → nhóm «Vận chuyển» («Viettel Post của tổ chức (tạo vận đơn)» hoặc «GHN của tổ chức»): khai tài khoản, Kiểm tra đạt rồi Bật.",
    blockedReason: eligibility(order, attempts),
    defaults: { weightGrams: linesWeight(lines), cod: await outstandingOf(order), receiverAddress: receiverAddressLine(order), province: order.shipProvince ?? "", ward: order.shipCommune ?? "" },
    attempts: attempts.map(attemptView).filter((x): x is CarrierAttemptView => x !== null),
  };
}

/** Danh sách xã / phường theo danh mục chính thức của hãng (ô gợi ý trên màn hình) — chỉ đọc ở hãng. */
export async function carrierWardOptionsCore(user: SessionUser, rawCarrier: unknown, provinceText: unknown, deps: CarrierDeps = {}): Promise<CarrierResult<{ province: string; wards: string[] }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  if (!isCarrierKey(rawCarrier)) return { ok: false, error: "Hãng không hợp lệ." };
  if (typeof provinceText !== "string" || provinceText.length > 120) return { ok: false, error: "Tên tỉnh không hợp lệ." };
  const opened = await openSession(carrierAdapter(rawCarrier), deps);
  if (!opened.ok) return opened;
  if (!opened.session.wardOptions) return { ok: true, message: "", province: "", wards: [] };
  const r = await opened.session.wardOptions(provinceText);
  return r.kind === "OK" ? { ok: true, message: "", ...r.value } : { ok: false, error: r.message };
}

// ───────────────────────────── TÍNH CƯỚC ─────────────────────────────

const placeZ = { province: z.string().trim().max(120).default(""), ward: z.string().trim().max(120).default("") };
const quoteZ = z.object({ weightGrams: z.coerce.number().int().min(1).max(100_000), cod: z.coerce.number().int().min(0).max(100_000_000), ...placeZ }).strict();

export async function quoteShipmentCore(user: SessionUser, rawCarrier: unknown, orderId: unknown, rawInput: unknown, deps: CarrierDeps = {}): Promise<CarrierResult<{ quote: CarrierQuote }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  if (!isCarrierKey(rawCarrier)) return { ok: false, error: "Hãng không hợp lệ." };
  const parsed = quoteZ.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: "Trọng lượng (gam) và tiền thu hộ phải là số nguyên hợp lệ." };
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;
  const blocked = eligibility(loaded.order, loaded.attempts);
  if (blocked) return { ok: false, error: blocked };
  const opened = await openSession(carrierAdapter(rawCarrier), deps);
  if (!opened.ok) return opened;
  const draft = draftOf(loaded.order, loaded.lines, parsed.data, "");
  const problems = opened.session.problems(draft, { needService: false });
  if (problems.length) return { ok: false, error: problems.map((p) => p.message).join(" · ") };
  const res = await opened.session.quote(draft);
  if (res.kind !== "OK") return { ok: false, error: `Không tính được cước: ${res.message}` };
  if (!res.value.services.length) return { ok: false, error: "Hãng không trả dịch vụ nào cho tuyến này — kiểm tra lại địa chỉ người nhận / người gửi." };
  return { ok: true, message: `${res.value.services.length} dịch vụ`, quote: res.value };
}

// ───────────────────────────── TẠO ─────────────────────────────

const createZ = quoteZ.extend({ serviceCode: z.string().trim().regex(/^[A-Z0-9]{1,10}$/, "Chọn một dịch vụ từ bảng cước."), note: z.string().max(300).default("") }).strict();

/** Bản nháp lưu cùng chỗ giữ — để «Thử lại» gửi ĐÚNG những gì đã gửi lần trước (cùng mã, cùng tiền, cùng địa chỉ). */
type StoredDraft = { weightGrams: number; cod: number; serviceCode: string; note: string; province: string; ward: string };

export async function createShipmentCore(user: SessionUser, rawCarrier: unknown, orderId: unknown, rawInput: unknown, deps: CarrierDeps = {}): Promise<CarrierResult<{ shipmentId: string; trackingCode: string | null }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  if (!isCarrierKey(rawCarrier)) return { ok: false, error: "Hãng không hợp lệ." };
  const adapter = carrierAdapter(rawCarrier);
  const parsed = createZ.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;
  const opened = await openSession(adapter, deps);
  if (!opened.ok) return opened;
  const { order, lines } = loaded;
  const preview = draftOf(order, lines, parsed.data, "");
  const problems = opened.session.problems(preview, { needService: true });
  if (problems.length) return { ok: false, error: problems.map((p) => p.message).join(" · ") };

  // ① GIỮ CHỖ — một giao dịch, khoá theo đơn: hai người bấm cùng lúc thì người sau thấy chỗ đã giữ.
  const db = await getDb();
  const now = new Date();
  const stored: StoredDraft = { weightGrams: parsed.data.weightGrams, cod: parsed.data.cod, serviceCode: parsed.data.serviceCode, note: parsed.data.note, province: preview.receiver.province, ward: preview.receiver.ward };
  const held = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`carrier-create:${order.id}`}, 0))`);
    const [fresh] = await tx.select().from(schema.orders).where(eq(schema.orders.id, order.id)).limit(1);
    const attempts = await tx.select().from(schema.shipments).where(eq(schema.shipments.orderId, order.id));
    const blocked = fresh ? eligibility(fresh, attempts) : "Không có đơn này.";
    if (blocked) return { ok: false as const, error: blocked };
    const attemptNo = attempts.reduce((m, a) => Math.max(m, a.attemptNo ?? 0), 0) + 1;
    const reference = vtpReferenceFor(manualOrderShortCode(order.id), attemptNo);
    const create: CarrierCreateRaw = { state: "REQUESTED", carrier: adapter.key, reference, by: user.id, at: now.toISOString(), service: parsed.data.serviceCode, draft: stored };
    const [row] = await tx
      .insert(schema.shipments)
      .values({
        orderId: order.id,
        attemptNo,
        direction: "OUTBOUND",
        carrier: adapter.shipmentCarrier,
        orderReference: reference,
        codAmount: parsed.data.cod,
        weight: parsed.data.weightGrams,
        service: parsed.data.serviceCode,
        receiverName: preview.receiver.name,
        receiverPhone: preview.receiver.phone,
        receiverAddress: preview.receiver.address,
        raw: { carrierCreate: create },
      })
      .returning({ id: schema.shipments.id });
    return { ok: true as const, shipmentId: row.id, reference, create };
  });
  if (!held.ok) return held;
  return callCreate(user, adapter, opened.session, order.id, held.shipmentId, held.create, { ...preview, reference: held.reference, serviceCode: parsed.data.serviceCode, note: parsed.data.note });
}

/** ② GỌI HÃNG (ngoài giao dịch — không giữ khoá CSDL lúc chờ mạng) và ③ ghi kết quả vào chỗ đã giữ. */
async function callCreate(user: SessionUser, adapter: CarrierAdapter, session: CarrierSession, orderId: string, shipmentId: string, create: CarrierCreateRaw, draft: CarrierDraft): Promise<CarrierResult<{ shipmentId: string; trackingCode: string | null }>> {
  const db = await getDb();
  const res = await session.create(draft);
  const by = { userId: user.id, userEmail: user.email };

  if (res.kind === "REJECTED") {
    // Hãng trả lời và từ chối ⇒ chắc chắn không có vận đơn: bỏ chỗ giữ, đơn quay lại như trước khi bấm.
    await db.delete(schema.shipments).where(and(eq(schema.shipments.id, shipmentId), sql`${schema.shipments.vtpOrderNumber} is null`, sql`${schema.shipments.trackingCode} is null`));
    await audit({ ...by, action: "SHIPMENT_CARRIER_CREATE_REJECTED", entity: "ORDER", entityId: orderId, after: { carrier: adapter.key, reference: draft.reference, service: draft.serviceCode, cod: draft.cod, weight: draft.weightGrams }, reason: `${adapter.label} từ chối: ${res.message}` });
    return { ok: false, error: `${adapter.label} từ chối: ${res.message}` };
  }
  if (res.kind === "UNKNOWN") {
    const unknown: CarrierCreateRaw = { ...create, state: "UNKNOWN", message: res.message };
    await db.update(schema.shipments).set({ raw: { carrierCreate: unknown }, updatedAt: new Date() }).where(eq(schema.shipments.id, shipmentId));
    await audit({ ...by, action: "SHIPMENT_CARRIER_CREATE_UNKNOWN", entity: "ORDER", entityId: orderId, after: { carrier: adapter.key, shipmentId, reference: draft.reference }, reason: res.message });
    return {
      ok: false,
      error: adapter.idempotentRetry
        ? `Không rõ ${adapter.label} đã tạo vận đơn chưa (${res.message}). Bấm «Thử lại»: ${adapter.label} nhận CÙNG mã ${draft.reference} sẽ trả đúng đơn đã tạo nếu có, không tạo đơn thứ hai.`
        : `Không rõ ${adapter.label} đã tạo vận đơn chưa (${res.message}). Tra trên trang của hãng theo mã đơn ${draft.reference}: có thì chờ webhook, không có thì bấm «Bỏ lượt tạo» rồi tạo lại — hãng chặn trùng mã nên tạo lại không đẻ vận đơn thứ hai.`,
    };
  }

  const created = res.value;
  // ③ GHI MÃ VẬN ĐƠN. Webhook Viettel Post có thể đã tới trước và dựng một dòng mồ côi cùng mã (`vtp_order_number` UNIQUE)
  // ⇒ nhận dòng mồ côi về đơn này và bỏ chỗ giữ — không bao giờ để hai dòng cho một vận đơn.
  const done: CarrierCreateRaw = { ...create, state: "CREATED", sortCode: created.sortCode, message: undefined };
  const patch = {
    ...(adapter.storesVtpOrderNumber ? { vtpOrderNumber: created.trackingCode } : {}),
    trackingCode: created.trackingCode,
    shippingFee: created.fee,
    codAmount: created.codAmount || draft.cod,
    raw: { carrierCreate: done, carrierCreated: created.raw ?? null },
    updatedAt: new Date(),
  };
  let finalId = shipmentId;
  try {
    await db.update(schema.shipments).set(patch).where(eq(schema.shipments.id, shipmentId));
  } catch (error) {
    if (!adapter.storesVtpOrderNumber || !isUniqueViolation(error)) throw error;
    const [orphan] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, created.trackingCode)).limit(1);
    if (!orphan || (orphan.orderId && orphan.orderId !== orderId)) throw error;
    const [held] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, shipmentId)).limit(1);
    await db.transaction(async (tx) => {
      await tx.delete(schema.shipments).where(eq(schema.shipments.id, shipmentId));
      await tx
        .update(schema.shipments)
        .set({ orderId, attemptNo: held?.attemptNo ?? null, direction: "OUTBOUND", orderReference: draft.reference, weight: draft.weightGrams, service: draft.serviceCode, shippingFee: created.fee, raw: { ...((orphan.raw as Record<string, unknown>) ?? {}), carrierCreate: done, carrierCreated: created.raw ?? null }, updatedAt: new Date() })
        .where(eq(schema.shipments.id, orphan.id));
    });
    finalId = orphan.id;
  }
  await audit({ ...by, action: "SHIPMENT_CARRIER_CREATE", entity: "ORDER", entityId: orderId, after: { carrier: adapter.key, shipmentId: finalId, trackingCode: created.trackingCode, reference: draft.reference, service: draft.serviceCode, cod: patch.codAmount, fee: created.fee, weight: draft.weightGrams }, reason: `Tạo vận đơn ${adapter.label} từ đơn ERP` });
  return { ok: true, message: `Đã tạo vận đơn ${adapter.label} ${created.trackingCode} — cước ${created.fee.toLocaleString("vi-VN")} ₫. Hành trình về qua webhook của tổ chức.`, shipmentId: finalId, trackingCode: created.trackingCode };
}

// ───────────────────────────── HUỶ / BỎ LƯỢT / THỬ LẠI / IN ─────────────────────────────

async function loadAttempt(shipmentId: unknown): Promise<{ ok: true; row: ShipmentRow; adapter: CarrierAdapter } | { ok: false; error: string }> {
  if (typeof shipmentId !== "string" || !/^[0-9a-f-]{36}$/i.test(shipmentId)) return { ok: false, error: "Không có vận đơn này." };
  const db = await getDb();
  const [row] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, shipmentId)).limit(1);
  const adapter = row ? adapterOf(row) : null;
  if (!row || !row.orderId || !isManualOrderId(row.orderId) || !adapter) return { ok: false, error: "Vận đơn này không do ERP tạo — thao tác ở nơi đã tạo nó." };
  return { ok: true, row, adapter };
}

const cancelZ = z.object({ reason: z.string().trim().min(3, "Nói vì sao huỷ vận đơn").max(150) }).strict();

/** Huỷ ở hãng — chỉ khi hãng chưa cầm hàng. Không tự đặt «Đã huỷ»: chờ mã huỷ của webhook. */
export async function cancelShipmentCore(user: SessionUser, shipmentId: unknown, rawInput: unknown, deps: CarrierDeps = {}): Promise<CarrierResult> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  const parsed = cancelZ.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const loaded = await loadAttempt(shipmentId);
  if (!loaded.ok) return loaded;
  const { row, adapter } = loaded;
  const view = attemptView(row);
  if (!view?.canCancel || !view.trackingCode) return { ok: false, error: "Vận đơn không huỷ được nữa — hãng đã nhận hàng, đã huỷ, hoặc chưa có mã vận đơn." };
  const opened = await openSession(adapter, deps);
  if (!opened.ok) return opened;
  const res = await opened.session.cancel(view.trackingCode, parsed.data.reason);
  if (res.kind !== "OK") return { ok: false, error: res.kind === "UNKNOWN" ? `Không rõ ${adapter.label} đã nhận lệnh huỷ chưa (${res.message}) — kiểm tra trên trang của hãng trước khi bấm lại.` : `${adapter.label} từ chối huỷ: ${res.message}` };
  const cancel: CarrierCancelRaw = { state: "ACCEPTED", by: user.id, at: new Date().toISOString(), reason: parsed.data.reason, message: res.value.message };
  const db = await getDb();
  await db.update(schema.shipments).set({ raw: { ...((row.raw as Record<string, unknown>) ?? {}), carrierCancel: cancel }, updatedAt: new Date() }).where(eq(schema.shipments.id, row.id));
  await audit({ userId: user.id, userEmail: user.email, action: "SHIPMENT_CARRIER_CANCEL", entity: "SHIPMENT", entityId: row.id, before: { carrier: adapter.key, trackingCode: view.trackingCode, stage: row.stage }, after: { carrierCancel: cancel }, reason: parsed.data.reason });
  return { ok: true, message: `${adapter.label} đã nhận lệnh huỷ ${view.trackingCode}. Đơn tạo được lần gửi mới; trạng thái «Đã huỷ» về theo webhook.` };
}

/** Bỏ một lượt tạo KHÔNG CÓ mã vận đơn (lượt đứt mạng, hoặc treo quá 5 phút) — người đã tra trên trang hãng và chắc không có. */
export async function discardCreateCore(user: SessionUser, shipmentId: unknown): Promise<CarrierResult> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  const loaded = await loadAttempt(shipmentId);
  if (!loaded.ok) return loaded;
  const { row, adapter } = loaded;
  if (!attemptView(row)?.canDiscard) return { ok: false, error: "Chỉ bỏ được lượt tạo chưa có mã vận đơn và không còn đang chạy." };
  const db = await getDb();
  const [events] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, row.id));
  if ((events?.n ?? 0) > 0) return { ok: false, error: "Lượt này đã có hành trình từ hãng — không bỏ được." };
  await db.delete(schema.shipments).where(and(eq(schema.shipments.id, row.id), sql`${schema.shipments.vtpOrderNumber} is null`, sql`${schema.shipments.trackingCode} is null`));
  await audit({ userId: user.id, userEmail: user.email, action: "SHIPMENT_CARRIER_DISCARD", entity: "ORDER", entityId: row.orderId ?? undefined, before: { carrier: adapter.key, shipmentId: row.id, carrierCreate: carrierCreateOf(row.raw) }, reason: `Bỏ lượt tạo vận đơn ${adapter.label} không rõ kết quả — người đã tra trên trang của hãng` });
  return { ok: true, message: "Đã bỏ lượt tạo — đơn tạo được vận đơn mới." };
}

/**
 * THỬ LẠI một lượt tạo không rõ kết quả — CHỈ với hãng gửi lại cùng mã là an toàn (GHN `client_order_code`): gửi ĐÚNG bản
 * nháp đã lưu với CÙNG mã ERP. Hãng đã tạo ⇒ trả đúng đơn cũ; chưa tạo ⇒ tạo bây giờ. Không bao giờ ra hai đơn.
 */
export async function retryCreateCore(user: SessionUser, shipmentId: unknown, deps: CarrierDeps = {}): Promise<CarrierResult<{ shipmentId: string; trackingCode: string | null }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  const loaded = await loadAttempt(shipmentId);
  if (!loaded.ok) return loaded;
  const { row, adapter } = loaded;
  const create = carrierCreateOf(row.raw);
  if (!attemptView(row)?.canRetry || !create?.draft) return { ok: false, error: `Không thử lại được — ${adapter.idempotentRetry ? "lượt này đã có kết quả" : `${adapter.label} không trả lại mã cũ khi gửi trùng; tra trên trang hãng rồi «Bỏ lượt tạo»`}.` };
  const order = await loadOrder(row.orderId);
  if (!order.ok) return order;
  const opened = await openSession(adapter, deps);
  if (!opened.ok) return opened;
  const draft = { ...draftOf(order.order, order.lines, create.draft, create.reference), serviceCode: create.draft.serviceCode, note: create.draft.note };
  const requested: CarrierCreateRaw = { ...create, state: "REQUESTED", at: new Date().toISOString(), message: undefined };
  const db = await getDb();
  await db.update(schema.shipments).set({ raw: { carrierCreate: requested }, updatedAt: new Date() }).where(eq(schema.shipments.id, row.id));
  return callCreate(user, adapter, opened.session, order.order.id, row.id, requested, draft);
}

/** Link in nhãn của chính hãng. Chỉ đọc ở hãng — không ghi gì vào ERP. */
export async function printLinkCore(user: SessionUser, shipmentId: unknown, deps: CarrierDeps = {}): Promise<CarrierResult<{ url: string }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  const loaded = await loadAttempt(shipmentId);
  if (!loaded.ok) return loaded;
  const view = attemptView(loaded.row);
  if (!view?.canPrint || !view.trackingCode) return { ok: false, error: "Chưa có mã vận đơn còn in được." };
  const opened = await openSession(loaded.adapter, deps);
  if (!opened.ok) return opened;
  const res = await opened.session.printUrl([view.trackingCode]);
  return res.kind === "OK" ? { ok: true, message: "Mở nhãn in", url: res.value.url } : { ok: false, error: `Không lấy được link in: ${res.message}` };
}

// ───────────────────────────── HÀNG LOẠT (danh sách đơn) ─────────────────────────────

const idsZ = z.array(z.string().min(1).max(200)).min(1, "Chọn ít nhất một đơn.").max(BULK_MAX, `Tối đa ${BULK_MAX} đơn một lượt.`);

export type BulkCreateRow = { orderId: string; ok: boolean; message: string; trackingCode?: string | null };

/**
 * Bảng cước cho lượt tạo hàng loạt: tra bằng đơn ĐẦU TIÊN tạo được (đủ điều kiện + có cân nặng). Người bấm chọn MỘT dịch vụ
 * dùng chung; đơn nào hãng không phục vụ dịch vụ đó trên tuyến của nó thì hãng từ chối RIÊNG đơn ấy — báo trong kết quả.
 */
export async function bulkQuoteCore(user: SessionUser, rawCarrier: unknown, rawIds: unknown, deps: CarrierDeps = {}): Promise<CarrierResult<{ quote: CarrierQuote; sampleOrderId: string }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  const ids = idsZ.safeParse(rawIds);
  if (!ids.success) return { ok: false, error: ids.error.issues.map((i) => i.message).join(" · ") };
  for (const id of ids.data) {
    const loaded = await loadOrder(id);
    if (!loaded.ok || eligibility(loaded.order, loaded.attempts)) continue;
    const weight = linesWeight(loaded.lines);
    if (weight === null) continue;
    const q = await quoteShipmentCore(user, rawCarrier, id, { weightGrams: weight, cod: await outstandingOf(loaded.order) }, deps);
    return q.ok ? { ...q, sampleOrderId: id } : q;
  }
  return { ok: false, error: "Không đơn nào trong lựa chọn tạo được vận đơn: cần đơn tạo trong ERP, «Đã xác nhận», chưa có vận đơn, mẫu mã đã khai cân nặng." };
}

/**
 * TẠO HÀNG LOẠT — đi qua ĐÚNG `createShipmentCore` cho từng đơn (giữ chỗ, chặn trùng, không tự gửi lại: mọi luật của tạo một
 * đơn giữ nguyên), TUẦN TỰ (không dội hãng). Mỗi đơn dùng mặc định của chính nó: cân = cân mẫu mã × số lượng (thiếu ⇒ bỏ qua,
 * KHÔNG đoán), thu hộ = số khách còn phải trả, ghi chú mặc định của tổ chức, tỉnh / xã đơn đã lưu. Một đơn hỏng không dừng
 * cả lượt.
 */
export async function bulkCreateCore(user: SessionUser, rawCarrier: unknown, rawIds: unknown, rawInput: unknown, deps: CarrierDeps = {}): Promise<CarrierResult<{ rows: BulkCreateRow[] }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  if (!isCarrierKey(rawCarrier)) return { ok: false, error: "Hãng không hợp lệ." };
  const ids = idsZ.safeParse(rawIds);
  if (!ids.success) return { ok: false, error: ids.error.issues.map((i) => i.message).join(" · ") };
  const svc = z.object({ serviceCode: z.string().trim().regex(/^[A-Z0-9]{1,10}$/, "Chọn một dịch vụ từ bảng cước.") }).strict().safeParse(rawInput);
  if (!svc.success) return { ok: false, error: svc.error.issues.map((i) => i.message).join(" · ") };
  const rows: BulkCreateRow[] = [];
  for (const id of [...new Set(ids.data)]) {
    const loaded = await loadOrder(id);
    if (!loaded.ok) {
      rows.push({ orderId: id, ok: false, message: loaded.error });
      continue;
    }
    const blocked = eligibility(loaded.order, loaded.attempts);
    if (blocked) {
      rows.push({ orderId: id, ok: false, message: blocked });
      continue;
    }
    const weight = linesWeight(loaded.lines);
    if (weight === null) {
      rows.push({ orderId: id, ok: false, message: "Mẫu mã chưa khai cân nặng — tạo riêng đơn này ở trang đơn (nhập cân tay)." });
      continue;
    }
    const r = await createShipmentCore(user, rawCarrier, id, { weightGrams: weight, cod: await outstandingOf(loaded.order), serviceCode: svc.data.serviceCode, note: "" }, deps);
    rows.push(r.ok ? { orderId: id, ok: true, message: r.message, trackingCode: r.trackingCode } : { orderId: id, ok: false, message: r.error });
  }
  const made = rows.filter((r) => r.ok).length;
  return { ok: true, message: `Tạo được ${made}/${rows.length} vận đơn.`, rows };
}

/**
 * IN HÀNG LOẠT — MỘT link in cho mọi lần gửi do ERP tạo của MỘT hãng còn in được, trong các đơn đã chọn. Chỉ đọc ở hãng.
 */
export async function bulkPrintLinkCore(user: SessionUser, rawCarrier: unknown, rawIds: unknown, deps: CarrierDeps = {}): Promise<CarrierResult<{ url: string; count: number }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: NO_PERMISSION };
  if (!isCarrierKey(rawCarrier)) return { ok: false, error: "Hãng không hợp lệ." };
  const ids = z.array(z.string().min(1).max(200)).min(1).max(PRINT_MAX).safeParse(rawIds);
  if (!ids.success) return { ok: false, error: `Chọn từ 1 tới ${PRINT_MAX} đơn.` };
  const db = await getDb();
  const rows = await db.select().from(schema.shipments).where(inArray(schema.shipments.orderId, ids.data));
  const codes = rows
    .filter((r) => r.orderId && isManualOrderId(r.orderId))
    .map((r) => attemptView(r))
    .filter((v): v is CarrierAttemptView => v !== null && v.carrier === rawCarrier && v.canPrint && Boolean(v.trackingCode))
    .map((v) => v.trackingCode!);
  const adapter = carrierAdapter(rawCarrier);
  if (!codes.length) return { ok: false, error: `Không đơn nào đã chọn có vận đơn ${adapter.label} do ERP tạo còn in được.` };
  const opened = await openSession(adapter, deps);
  if (!opened.ok) return opened;
  const unique = [...new Set(codes)].slice(0, PRINT_MAX);
  const res = await opened.session.printUrl(unique);
  return res.kind === "OK" ? { ok: true, message: `Mở ${unique.length} nhãn in`, url: res.value.url, count: unique.length } : { ok: false, error: `Không lấy được link in: ${res.message}` };
}

/** Hãng nào bật lối «hàng loạt» trên danh sách đơn: quyền + kết nối đang bật. Không giải mã gì. */
export async function bulkCarriers(user: SessionUser): Promise<{ key: CarrierKey; label: string }[]> {
  if (!can(user, PERMISSION)) return [];
  return (await enabledCarriers()).filter((c) => c.ready).map((c) => ({ key: c.key, label: c.label }));
}
