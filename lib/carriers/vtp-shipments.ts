import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { connectionIsActive, openActiveConnection } from "@/lib/connectors/service";
import type { SecretsKeyState } from "@/lib/connectors/secrets";
import {
  attemptHoldsOrder,
  canCancelAtCarrier,
  carrierCancelOf,
  carrierCreateOf,
  draftProblems,
  linesWeight,
  normalizeVtpPhone,
  parseVtpCreated,
  parseVtpQuote,
  receiverAddressLine,
  VTP_CARRIER_CONNECTOR,
  VTP_DEFAULT_NOTE,
  VTP_MAX_COD,
  VTP_MAX_WEIGHT_G,
  vtpCreateBody,
  vtpPrintUrl,
  vtpQuoteBody,
  vtpReferenceFor,
  type CarrierCancelRaw,
  type CarrierCreateRaw,
  type VtpQuote,
  type VtpSender,
  type VtpShipmentDraft,
  type VtpShipmentLine,
} from "@/lib/constants/carrier-vtp";
import { manualOrderAmountDue, manualPaymentStatus, sumConfirmedPayments } from "@/lib/constants/order-payments";
import { isManualOrderId, manualOrderRaw, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { VtpCarrierClient, type VtpCarrierDeps } from "@/lib/integrations/viettelpost/carrier-org";
import { currentOrganization } from "@/lib/platform/context";

/**
 * ═══════════ TẠO VẬN ĐƠN VIETTEL POST TỪ ĐƠN ERP (POS tự chủ · docs/verticals/pos-tu-chu.md) ═══════════
 *
 * Shop khách không dùng Pancake POS vẫn đẩy được đơn sang hãng: tính cước → tạo → in nhãn → huỷ khi hãng chưa lấy hàng. Tài
 * khoản là của CHÍNH tổ chức (kết nối «viettelpost-carrier», mở bằng `openActiveConnection` — AAD gắn tổ chức ngữ cảnh).
 *
 * BA LUẬT KHÔNG THƯƠNG LƯỢNG:
 *  1. MỘT LẦN GỬI KHÔNG BAO GIỜ THÀNH HAI VẬN ĐƠN. Dòng `shipments` được GIỮ CHỖ trong một giao dịch có khoá theo đơn TRƯỚC
 *     khi gọi hãng; mã ERP gửi đi kèm `CHECK_UNIQUE` để chính hãng chặn trùng; client không tự gửi lại. Lượt gọi đứt giữa
 *     chừng ⇒ giữ chỗ ở trạng thái UNKNOWN, KHÔNG tự xoá, KHÔNG tự gửi lại — người tra rồi quyết.
 *  2. LOGISTICS ≠ TIỀN (ORDER_OUTCOME.md). Lõi này chỉ ghi chặng chờ lấy (mặc định của cột) và KHÔNG ghi `shipments.stage`
 *     (`SHIPMENT_STAGE_WRITERS`): hành trình về qua webhook của tổ chức. Huỷ thành công ở hãng ghi `raw.carrierCancel` — lời
 *     nhận lệnh của hãng — chứ không tự đặt «Đã huỷ»; mã 107 của webhook mới là chứng từ.
 *  3. ĐƠN ĐÃ GỬI KHÔNG SỬA LẶNG LẼ. `loadEditable` (lib/records/order-create.ts) chặn sửa / huỷ đơn khi còn lần gửi đang
 *     giữ đơn: sửa dòng hàng ở ERP không đổi được vận đơn bên hãng.
 */

export type CarrierResult<T extends object = object> = ({ ok: true; message: string } & T) | { ok: false; error: string };

const PERMISSION = "shipments:manage";

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

type Opened = { ok: true; client: VtpCarrierClient; sender: VtpSender; defaultNote: string } | { ok: false; error: string };

async function openCarrier(deps: { keyState?: SecretsKeyState; client?: VtpCarrierDeps } = {}): Promise<Opened> {
  const org = await currentOrganization();
  const conn = await openActiveConnection(VTP_CARRIER_CONNECTOR, { keyState: deps.keyState });
  if (!conn.ok) return { ok: false, error: `Chưa dùng được Viettel Post của tổ chức: ${conn.reason}` };
  const client = VtpCarrierClient.fromOrgConnection({ organization: org.code, username: conn.settings.username ?? "", password: conn.secrets.password ?? "" }, deps.client);
  const sender = { name: (conn.settings.senderName ?? "").trim(), phone: normalizeVtpPhone(conn.settings.senderPhone ?? ""), address: (conn.settings.senderAddress ?? "").trim() };
  return { ok: true, client, sender, defaultNote: (conn.settings.defaultNote ?? "").trim() || VTP_DEFAULT_NOTE };
}

/** Số khách CÒN PHẢI TRẢ theo chứng từ thanh toán — mặc định tiền thu hộ (khách đã chuyển khoản trước thì thu hộ ít đi). */
async function outstandingOf(order: OrderRow): Promise<number> {
  const db = await getDb();
  const rows = await db.select({ kind: schema.orderPayments.kind, amount: schema.orderPayments.amount, status: schema.orderPayments.status }).from(schema.orderPayments).where(eq(schema.orderPayments.orderId, order.id));
  return manualPaymentStatus(sumConfirmedPayments(rows), manualOrderAmountDue(order)).outstanding;
}

function draftOf(order: OrderRow, lines: VtpShipmentLine[], sender: VtpSender, input: { weightGrams: number; cod: number; serviceCode?: string; note?: string }, reference: string, defaultNote: string): VtpShipmentDraft {
  return {
    reference,
    sender,
    receiver: { name: order.shipFullName || order.billFullName || "", phone: normalizeVtpPhone(order.shipPhone || order.billPhone || ""), address: receiverAddressLine(order) },
    lines,
    goodsValue: Math.max(0, order.totalPriceAfterDiscount),
    weightGrams: input.weightGrams,
    cod: input.cod,
    serviceCode: input.serviceCode ?? "",
    note: (input.note ?? "").trim() || defaultNote,
  };
}

function eligibility(order: OrderRow, attempts: ShipmentRow[]): string | null {
  if (order.stage !== "CONFIRMED") return "Chỉ đơn «Đã xác nhận» mới tạo vận đơn — chốt đơn với khách trước.";
  if (attempts.some((a) => attemptHoldsOrder({ stage: a.stage, raw: a.raw }))) return "Đơn đang có một lần gửi còn hiệu lực — huỷ vận đơn đó (hoặc bỏ lượt tạo chưa rõ kết quả) trước khi tạo lần gửi mới.";
  return null;
}

// ───────────────────────────── ĐỌC CHO MÀN HÌNH ─────────────────────────────

export type CarrierAttemptView = {
  id: string;
  vtpOrderNumber: string | null;
  create: CarrierCreateRaw | null;
  cancel: CarrierCancelRaw | null;
  canCancel: boolean;
  canPrint: boolean;
  canDiscard: boolean;
};

export type CarrierPanelView = {
  /** Người này + tổ chức này có dùng được nút Viettel Post không; `null` ⇒ ẩn hẳn khung (không phải đơn ERP / thiếu quyền). */
  canManage: boolean;
  connectionReady: boolean;
  connectionNote: string | null;
  blockedReason: string | null;
  /** Không có ghi chú: ô để trống ⇒ lõi dùng ghi chú mặc định của tổ chức (khai ở kết nối) — trang không đọc cài đặt kết nối. */
  defaults: { weightGrams: number | null; cod: number; receiverAddress: string };
  attempts: CarrierAttemptView[];
};

/** Mọi thứ khung «Gửi Viettel Post» trên trang đơn cần — CHỈ ĐỌC, không gọi hãng, không giải mã mật khẩu. */
export async function vtpCarrierPanel(user: SessionUser, orderId: string): Promise<CarrierPanelView | null> {
  if (!can(user, PERMISSION)) return null;
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return null;
  const { order, lines, attempts } = loaded;
  // Trạng thái kết nối đọc qua service (bảng org_connections chỉ có MỘT đường đọc/ghi) — không giải mã gì.
  const ready = await connectionIsActive(VTP_CARRIER_CONNECTOR);
  return {
    canManage: true,
    connectionReady: ready,
    connectionNote: ready ? null : "Chưa bật Viettel Post của tổ chức — Cài đặt → Kết nối → «Viettel Post của tổ chức (tạo vận đơn)»: khai tài khoản, Kiểm tra đạt rồi Bật.",
    blockedReason: eligibility(order, attempts),
    defaults: { weightGrams: linesWeight(lines), cod: await outstandingOf(order), receiverAddress: receiverAddressLine(order) },
    attempts: attempts
      .filter((a) => carrierCreateOf(a.raw))
      .map((a) => {
        const create = carrierCreateOf(a.raw);
        const cancel = carrierCancelOf(a.raw);
        return {
          id: a.id,
          vtpOrderNumber: a.vtpOrderNumber,
          create,
          cancel,
          canCancel: canCancelAtCarrier({ vtpOrderNumber: a.vtpOrderNumber, vtpStatus: a.vtpStatus, stage: a.stage, raw: a.raw }),
          canPrint: Boolean(a.vtpOrderNumber) && a.stage !== "CANCELLED" && !cancel,
          canDiscard: !a.vtpOrderNumber && (create?.state === "UNKNOWN" || (create?.state === "REQUESTED" && Date.now() - Date.parse(create.at) > 5 * 60_000)),
        };
      }),
  };
}

// ───────────────────────────── TÍNH CƯỚC ─────────────────────────────

const quoteZ = z.object({ weightGrams: z.coerce.number().int().min(1).max(VTP_MAX_WEIGHT_G), cod: z.coerce.number().int().min(0).max(VTP_MAX_COD) }).strict();

export async function quoteVtpShipmentCore(user: SessionUser, orderId: unknown, rawInput: unknown, deps: { keyState?: SecretsKeyState; client?: VtpCarrierDeps } = {}): Promise<CarrierResult<{ quote: VtpQuote }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: "Bạn không có quyền thao tác vận đơn (shipments:manage)." };
  const parsed = quoteZ.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: "Trọng lượng (gam) và tiền thu hộ phải là số nguyên hợp lệ." };
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;
  const blocked = eligibility(loaded.order, loaded.attempts);
  if (blocked) return { ok: false, error: blocked };
  const opened = await openCarrier(deps);
  if (!opened.ok) return opened;
  const draft = draftOf(loaded.order, loaded.lines, opened.sender, parsed.data, "", opened.defaultNote);
  const problems = draftProblems(draft, { needService: false });
  if (problems.length) return { ok: false, error: problems.map((p) => p.message).join(" · ") };
  const res = await opened.client.quote(vtpQuoteBody(draft));
  if (res.kind !== "OK") return { ok: false, error: `Không tính được cước: ${res.message}` };
  const quote = parseVtpQuote(res.envelope.data);
  if (!quote.services.length) return { ok: false, error: "Viettel Post không trả dịch vụ nào cho tuyến này — kiểm tra lại địa chỉ người nhận / người gửi." };
  return { ok: true, message: `${quote.services.length} dịch vụ`, quote };
}

// ───────────────────────────── TẠO ─────────────────────────────

const createZ = quoteZ.extend({ serviceCode: z.string().trim().regex(/^[A-Z0-9]{2,10}$/, "Chọn một dịch vụ từ bảng cước."), note: z.string().max(300).default("") }).strict();

export async function createVtpShipmentCore(user: SessionUser, orderId: unknown, rawInput: unknown, deps: { keyState?: SecretsKeyState; client?: VtpCarrierDeps } = {}): Promise<CarrierResult<{ shipmentId: string; vtpOrderNumber: string | null }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: "Bạn không có quyền thao tác vận đơn (shipments:manage)." };
  const parsed = createZ.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded;
  const opened = await openCarrier(deps);
  if (!opened.ok) return opened;
  const { order, lines } = loaded;
  const preview = draftOf(order, lines, opened.sender, parsed.data, "", opened.defaultNote);
  const problems = draftProblems(preview, { needService: true });
  if (problems.length) return { ok: false, error: problems.map((p) => p.message).join(" · ") };

  // ① GIỮ CHỖ — một giao dịch, khoá theo đơn: hai người bấm cùng lúc thì người sau thấy chỗ đã giữ.
  const db = await getDb();
  const now = new Date();
  const held = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`carrier-create:${order.id}`}, 0))`);
    const [fresh] = await tx.select().from(schema.orders).where(eq(schema.orders.id, order.id)).limit(1);
    const attempts = await tx.select().from(schema.shipments).where(eq(schema.shipments.orderId, order.id));
    const blocked = fresh ? eligibility(fresh, attempts) : "Không có đơn này.";
    if (blocked) return { ok: false as const, error: blocked };
    const attemptNo = attempts.reduce((m, a) => Math.max(m, a.attemptNo ?? 0), 0) + 1;
    const reference = vtpReferenceFor(manualOrderShortCode(order.id), attemptNo);
    const create: CarrierCreateRaw = { state: "REQUESTED", reference, by: user.id, at: now.toISOString(), service: parsed.data.serviceCode };
    const [row] = await tx
      .insert(schema.shipments)
      .values({
        orderId: order.id,
        attemptNo,
        direction: "OUTBOUND",
        carrier: "Viettel Post",
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

  // ② GỌI HÃNG — ngoài giao dịch (không giữ khoá CSDL trong lúc chờ mạng).
  const draft = { ...preview, reference: held.reference };
  const res = await opened.client.create(vtpCreateBody(draft));
  const by = { userId: user.id, userEmail: user.email };

  if (res.kind === "REJECTED") {
    // Hãng trả lời và từ chối ⇒ chắc chắn không có vận đơn: bỏ chỗ giữ, đơn quay lại như trước khi bấm.
    await db.delete(schema.shipments).where(and(eq(schema.shipments.id, held.shipmentId), sql`${schema.shipments.vtpOrderNumber} is null`));
    await audit({ ...by, action: "SHIPMENT_CARRIER_CREATE_REJECTED", entity: "ORDER", entityId: order.id, after: { reference: held.reference, service: draft.serviceCode, cod: draft.cod, weight: draft.weightGrams }, reason: `Viettel Post từ chối: ${res.message}` });
    return { ok: false, error: `Viettel Post từ chối: ${res.message}` };
  }
  if (res.kind === "UNKNOWN") {
    const unknown: CarrierCreateRaw = { ...held.create, state: "UNKNOWN", message: res.message };
    await db.update(schema.shipments).set({ raw: { carrierCreate: unknown }, updatedAt: new Date() }).where(eq(schema.shipments.id, held.shipmentId));
    await audit({ ...by, action: "SHIPMENT_CARRIER_CREATE_UNKNOWN", entity: "ORDER", entityId: order.id, after: { shipmentId: held.shipmentId, reference: held.reference }, reason: res.message });
    return {
      ok: false,
      error: `Không rõ Viettel Post đã tạo vận đơn chưa (${res.message}). Tra trên viettelpost.vn theo mã đơn ${held.reference}: có thì chờ webhook, không có thì bấm «Bỏ lượt tạo» rồi tạo lại — hãng chặn trùng mã nên tạo lại không đẻ vận đơn thứ hai.`,
    };
  }

  const created = parseVtpCreated(res.envelope.data);
  if (!created) {
    const unknown: CarrierCreateRaw = { ...held.create, state: "UNKNOWN", message: "Hãng nhận lệnh nhưng phản hồi không có mã vận đơn." };
    await db.update(schema.shipments).set({ raw: { carrierCreate: unknown, vtpCreateResponse: res.envelope.data ?? null }, updatedAt: new Date() }).where(eq(schema.shipments.id, held.shipmentId));
    return { ok: false, error: `Viettel Post nhận lệnh nhưng không trả mã vận đơn — tra trên viettelpost.vn theo mã đơn ${held.reference}.` };
  }

  // ③ GHI MÃ VẬN ĐƠN. Webhook của hãng có thể đã tới trước và dựng một dòng mồ côi cùng mã (tài liệu: gói tin đầu tiên tới
  // trong vài giây) ⇒ vi phạm UNIQUE: nhận dòng mồ côi về đơn này và bỏ chỗ giữ — không bao giờ để hai dòng cho một vận đơn.
  const done: CarrierCreateRaw = { ...held.create, state: "CREATED", sortCode: created.sortCode || undefined };
  const patch = {
    vtpOrderNumber: created.orderNumber,
    trackingCode: created.orderNumber,
    shippingFee: created.moneyTotal,
    codAmount: created.moneyCollection || draft.cod,
    raw: { carrierCreate: done, vtpCreated: created },
    updatedAt: new Date(),
  };
  let shipmentId = held.shipmentId;
  try {
    await db.update(schema.shipments).set(patch).where(eq(schema.shipments.id, held.shipmentId));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const [orphan] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, created.orderNumber)).limit(1);
    if (!orphan || (orphan.orderId && orphan.orderId !== order.id)) throw error;
    await db.transaction(async (tx) => {
      await tx.delete(schema.shipments).where(eq(schema.shipments.id, held.shipmentId));
      await tx
        .update(schema.shipments)
        .set({ orderId: order.id, attemptNo: (await tx.select().from(schema.shipments).where(eq(schema.shipments.orderId, order.id))).reduce((m, a) => Math.max(m, a.attemptNo ?? 0), 0) + 1, direction: "OUTBOUND", orderReference: held.reference, weight: draft.weightGrams, service: draft.serviceCode, shippingFee: created.moneyTotal, raw: { ...((orphan.raw as Record<string, unknown>) ?? {}), carrierCreate: done, vtpCreated: created }, updatedAt: new Date() })
        .where(eq(schema.shipments.id, orphan.id));
    });
    shipmentId = orphan.id;
  }
  await audit({ ...by, action: "SHIPMENT_CARRIER_CREATE", entity: "ORDER", entityId: order.id, after: { shipmentId, vtpOrderNumber: created.orderNumber, reference: held.reference, service: draft.serviceCode, cod: patch.codAmount, fee: created.moneyTotal, weight: draft.weightGrams }, reason: "Tạo vận đơn Viettel Post từ đơn ERP" });
  return { ok: true, message: `Đã tạo vận đơn ${created.orderNumber} — cước ${created.moneyTotal.toLocaleString("vi-VN")} ₫. Hành trình về qua webhook của tổ chức.`, shipmentId, vtpOrderNumber: created.orderNumber };
}

// ───────────────────────────── HUỶ / BỎ LƯỢT / IN ─────────────────────────────

async function loadAttempt(shipmentId: unknown): Promise<{ ok: true; row: ShipmentRow } | { ok: false; error: string }> {
  if (typeof shipmentId !== "string" || !/^[0-9a-f-]{36}$/i.test(shipmentId)) return { ok: false, error: "Không có vận đơn này." };
  const db = await getDb();
  const [row] = await db.select().from(schema.shipments).where(eq(schema.shipments.id, shipmentId)).limit(1);
  if (!row || !row.orderId || !isManualOrderId(row.orderId) || !carrierCreateOf(row.raw)) return { ok: false, error: "Vận đơn này không do ERP tạo — thao tác ở nơi đã tạo nó." };
  return { ok: true, row };
}

const cancelZ = z.object({ reason: z.string().trim().min(3, "Nói vì sao huỷ vận đơn").max(150) }).strict();

/** Huỷ ở hãng (UpdateOrder TYPE 4) — chỉ khi hãng chưa nhận hàng. Không tự đặt «Đã huỷ»: chờ mã 107 của webhook. */
export async function cancelVtpShipmentCore(user: SessionUser, shipmentId: unknown, rawInput: unknown, deps: { keyState?: SecretsKeyState; client?: VtpCarrierDeps } = {}): Promise<CarrierResult> {
  if (!can(user, PERMISSION)) return { ok: false, error: "Bạn không có quyền thao tác vận đơn (shipments:manage)." };
  const parsed = cancelZ.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const loaded = await loadAttempt(shipmentId);
  if (!loaded.ok) return loaded;
  const row = loaded.row;
  if (!canCancelAtCarrier({ vtpOrderNumber: row.vtpOrderNumber, vtpStatus: row.vtpStatus, stage: row.stage, raw: row.raw })) return { ok: false, error: "Vận đơn không huỷ được nữa — hãng đã nhận hàng, đã huỷ, hoặc chưa có mã vận đơn." };
  const opened = await openCarrier(deps);
  if (!opened.ok) return opened;
  const res = await opened.client.cancel(row.vtpOrderNumber!, parsed.data.reason);
  if (res.kind !== "OK") return { ok: false, error: res.kind === "UNKNOWN" ? `Không rõ Viettel Post đã nhận lệnh huỷ chưa (${res.message}) — kiểm tra trên viettelpost.vn trước khi bấm lại.` : `Viettel Post từ chối huỷ: ${res.message}` };
  const cancel: CarrierCancelRaw = { state: "ACCEPTED", by: user.id, at: new Date().toISOString(), reason: parsed.data.reason, message: res.envelope.message };
  const db = await getDb();
  await db.update(schema.shipments).set({ raw: { ...((row.raw as Record<string, unknown>) ?? {}), carrierCancel: cancel }, updatedAt: new Date() }).where(eq(schema.shipments.id, row.id));
  await audit({ userId: user.id, userEmail: user.email, action: "SHIPMENT_CARRIER_CANCEL", entity: "SHIPMENT", entityId: row.id, before: { vtpOrderNumber: row.vtpOrderNumber, stage: row.stage }, after: { carrierCancel: cancel }, reason: parsed.data.reason });
  return { ok: true, message: `Viettel Post đã nhận lệnh huỷ ${row.vtpOrderNumber}. Đơn tạo được lần gửi mới; trạng thái «Đã huỷ» về theo webhook.` };
}

/** Bỏ một lượt tạo KHÔNG CÓ mã vận đơn (lượt đứt mạng, hoặc treo quá 5 phút) — người đã tra trên viettelpost.vn và chắc không có. */
export async function discardVtpCreateCore(user: SessionUser, shipmentId: unknown): Promise<CarrierResult> {
  if (!can(user, PERMISSION)) return { ok: false, error: "Bạn không có quyền thao tác vận đơn (shipments:manage)." };
  const loaded = await loadAttempt(shipmentId);
  if (!loaded.ok) return loaded;
  const row = loaded.row;
  const create = carrierCreateOf(row.raw);
  const stale = create?.state === "REQUESTED" && Date.now() - Date.parse(create.at) > 5 * 60_000;
  if (row.vtpOrderNumber || !(create?.state === "UNKNOWN" || stale)) return { ok: false, error: "Chỉ bỏ được lượt tạo chưa có mã vận đơn và không còn đang chạy." };
  const db = await getDb();
  const [events] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, row.id));
  if ((events?.n ?? 0) > 0) return { ok: false, error: "Lượt này đã có hành trình từ hãng — không bỏ được." };
  await db.delete(schema.shipments).where(and(eq(schema.shipments.id, row.id), sql`${schema.shipments.vtpOrderNumber} is null`));
  await audit({ userId: user.id, userEmail: user.email, action: "SHIPMENT_CARRIER_DISCARD", entity: "ORDER", entityId: row.orderId ?? undefined, before: { shipmentId: row.id, carrierCreate: create }, reason: "Bỏ lượt tạo vận đơn không rõ kết quả — người đã tra trên viettelpost.vn" });
  return { ok: true, message: "Đã bỏ lượt tạo — đơn tạo được vận đơn mới." };
}

/** Link in nhãn của chính Viettel Post (mã in sống 1 giờ). Chỉ đọc ở hãng — không ghi gì vào ERP. */
export async function vtpPrintLinkCore(user: SessionUser, shipmentId: unknown, deps: { keyState?: SecretsKeyState; client?: VtpCarrierDeps } = {}): Promise<CarrierResult<{ url: string }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: "Bạn không có quyền thao tác vận đơn (shipments:manage)." };
  const loaded = await loadAttempt(shipmentId);
  if (!loaded.ok) return loaded;
  if (!loaded.row.vtpOrderNumber) return { ok: false, error: "Chưa có mã vận đơn để in." };
  const opened = await openCarrier(deps);
  if (!opened.ok) return opened;
  const res = await opened.client.printingCode([loaded.row.vtpOrderNumber]);
  if (res.kind !== "OK" || !res.envelope.message) return { ok: false, error: `Không lấy được mã in: ${res.kind === "OK" ? "phản hồi trống" : res.message}` };
  return { ok: true, message: "Mở nhãn in", url: vtpPrintUrl(res.envelope.message) };
}

// ───────────────────────────── HÀNG LOẠT (danh sách đơn) ─────────────────────────────

/** Trần một lượt chọn: tạo tuần tự, mỗi đơn hai-ba lượt gọi hãng — 50 đơn là chừng một phút chờ. */
export const VTP_BULK_MAX = 50;
/** Trần tài liệu `printing-code`: tối đa 100 vận đơn một mã in. */
export const VTP_PRINT_MAX = 100;

const idsZ = z.array(z.string().min(1).max(200)).min(1, "Chọn ít nhất một đơn.").max(VTP_BULK_MAX, `Tối đa ${VTP_BULK_MAX} đơn một lượt.`);

export type BulkCreateRow = { orderId: string; ok: boolean; message: string; vtpOrderNumber?: string | null };

/**
 * Bảng cước cho lượt tạo hàng loạt: tra bằng đơn ĐẦU TIÊN tạo được (đủ điều kiện + có cân nặng). Người bấm chọn MỘT dịch vụ
 * dùng chung; đơn nào hãng không phục vụ dịch vụ đó trên tuyến của nó thì hãng từ chối RIÊNG đơn ấy — báo trong kết quả.
 */
export async function bulkQuoteVtpCore(user: SessionUser, rawIds: unknown, deps: { keyState?: SecretsKeyState; client?: VtpCarrierDeps } = {}): Promise<CarrierResult<{ quote: VtpQuote; sampleOrderId: string }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: "Bạn không có quyền thao tác vận đơn (shipments:manage)." };
  const ids = idsZ.safeParse(rawIds);
  if (!ids.success) return { ok: false, error: ids.error.issues.map((i) => i.message).join(" · ") };
  for (const id of ids.data) {
    const loaded = await loadOrder(id);
    if (!loaded.ok || eligibility(loaded.order, loaded.attempts)) continue;
    const weight = linesWeight(loaded.lines);
    if (weight === null) continue;
    const q = await quoteVtpShipmentCore(user, id, { weightGrams: weight, cod: await outstandingOf(loaded.order) }, deps);
    return q.ok ? { ...q, sampleOrderId: id } : q;
  }
  return { ok: false, error: "Không đơn nào trong lựa chọn tạo được vận đơn: cần đơn tạo trong ERP, «Đã xác nhận», chưa có vận đơn, mẫu mã đã khai cân nặng." };
}

/**
 * TẠO HÀNG LOẠT — đi qua ĐÚNG `createVtpShipmentCore` cho từng đơn (giữ chỗ, CHECK_UNIQUE, không tự gửi lại: mọi luật của tạo
 * một đơn giữ nguyên), TUẦN TỰ (không dội hãng). Mỗi đơn dùng mặc định của chính nó: cân = cân mẫu mã × số lượng (thiếu ⇒ bỏ
 * qua, KHÔNG đoán), thu hộ = số khách còn phải trả, ghi chú mặc định của tổ chức. Một đơn hỏng không dừng cả lượt.
 */
export async function bulkCreateVtpShipmentsCore(user: SessionUser, rawIds: unknown, rawInput: unknown, deps: { keyState?: SecretsKeyState; client?: VtpCarrierDeps } = {}): Promise<CarrierResult<{ rows: BulkCreateRow[] }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: "Bạn không có quyền thao tác vận đơn (shipments:manage)." };
  const ids = idsZ.safeParse(rawIds);
  if (!ids.success) return { ok: false, error: ids.error.issues.map((i) => i.message).join(" · ") };
  const svc = z.object({ serviceCode: z.string().trim().regex(/^[A-Z0-9]{2,10}$/, "Chọn một dịch vụ từ bảng cước.") }).strict().safeParse(rawInput);
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
    const r = await createVtpShipmentCore(user, id, { weightGrams: weight, cod: await outstandingOf(loaded.order), serviceCode: svc.data.serviceCode, note: "" }, deps);
    rows.push(r.ok ? { orderId: id, ok: true, message: r.message, vtpOrderNumber: r.vtpOrderNumber } : { orderId: id, ok: false, message: r.error });
  }
  const made = rows.filter((r) => r.ok).length;
  return { ok: true, message: `Tạo được ${made}/${rows.length} vận đơn.`, rows };
}

/**
 * IN HÀNG LOẠT — MỘT mã in cho mọi lần gửi do ERP tạo còn in được của các đơn đã chọn (tối đa 100 vận đơn — trần tài liệu).
 * Chỉ đọc ở hãng, không ghi gì vào ERP.
 */
export async function bulkVtpPrintLinkCore(user: SessionUser, rawIds: unknown, deps: { keyState?: SecretsKeyState; client?: VtpCarrierDeps } = {}): Promise<CarrierResult<{ url: string; count: number }>> {
  if (!can(user, PERMISSION)) return { ok: false, error: "Bạn không có quyền thao tác vận đơn (shipments:manage)." };
  const ids = z.array(z.string().min(1).max(200)).min(1).max(VTP_PRINT_MAX).safeParse(rawIds);
  if (!ids.success) return { ok: false, error: `Chọn từ 1 tới ${VTP_PRINT_MAX} đơn.` };
  const db = await getDb();
  const rows = await db.select({ orderId: schema.shipments.orderId, vtpOrderNumber: schema.shipments.vtpOrderNumber, stage: schema.shipments.stage, raw: schema.shipments.raw }).from(schema.shipments).where(inArray(schema.shipments.orderId, ids.data));
  const numbers = rows.filter((r) => r.vtpOrderNumber && r.orderId && isManualOrderId(r.orderId) && carrierCreateOf(r.raw)?.state === "CREATED" && r.stage !== "CANCELLED" && !carrierCancelOf(r.raw)).map((r) => r.vtpOrderNumber!);
  if (!numbers.length) return { ok: false, error: "Không đơn nào đã chọn có vận đơn Viettel Post do ERP tạo còn in được." };
  const opened = await openCarrier(deps);
  if (!opened.ok) return opened;
  const unique = [...new Set(numbers)].slice(0, VTP_PRINT_MAX);
  const res = await opened.client.printingCode(unique);
  if (res.kind !== "OK" || !res.envelope.message) return { ok: false, error: `Không lấy được mã in: ${res.kind === "OK" ? "phản hồi trống" : res.message}` };
  return { ok: true, message: `Mở ${unique.length} nhãn in`, url: vtpPrintUrl(res.envelope.message), count: unique.length };
}

/** Danh sách đơn có bật lối «hàng loạt Viettel Post» không: quyền + kết nối đang bật. Không giải mã gì. */
export async function vtpBulkEnabled(user: SessionUser): Promise<boolean> {
  return can(user, PERMISSION) && (await connectionIsActive(VTP_CARRIER_CONNECTOR));
}
