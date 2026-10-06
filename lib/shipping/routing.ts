import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { autoCreateShipmentCore, enabledCarriers } from "@/lib/carriers/engine";
import { CARRIER_ADAPTERS } from "@/lib/carriers/registry";
import { CARRIER_KEYS, type CarrierDeps, type CarrierKey } from "@/lib/carriers/types";
import { attemptHoldsOrder, linesWeight } from "@/lib/constants/carrier-vtp";
import { MANUAL_ORDER_ID_PREFIX, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { manualOrderAmountDue, manualPaymentStatus, sumConfirmedPayments } from "@/lib/constants/order-payments";
import { isServiceCode, nextFailedAttempts, parseShippingRoutingConfig, SHIPPING_ROUTING_LIMITS, SHIPPING_ROUTING_SETTING_KEY, type AutoAttemptState, type ShippingRoute, type ShippingRoutingConfig } from "@/lib/constants/shipping-routing";
import { manualOrderGate, manualOrderOrgGate } from "@/lib/records/order-create";
import { canonicalProvince, canonicalWard, decideShippingRoute } from "@/lib/shipping/route";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

/**
 * ═══════════ TUYẾN GIAO TỰ ĐỘNG — ĐỌC / GHI / JOB (POS tự chủ P7 · lib/constants/shipping-routing.ts) ═══════════
 *
 * MỘT đường đọc cho cả màn hình lẫn máy: `routedOrders()` lấy đơn tạo tay «Đã xác nhận», gọi `decideShippingRoute` (thuần) cho
 * từng đơn. Trang «Danh sách tự giao» hiện kết quả; job `shipping-route` chỉ làm việc với đúng những đơn mà kết quả ấy nói «đi
 * hãng, máy được tự tạo». Không có cách nào để màn hình nói một đằng mà máy làm một nẻo.
 */

export const SHIPPING_ROUTE_JOB = "shipping-route";

/** Cấu hình tuyến giao của tổ chức ngữ cảnh (mặc định TẮT tự tạo vận đơn). */
export async function loadShippingRouting(): Promise<ShippingRoutingConfig> {
  return parseShippingRoutingConfig(await getSettingJson<unknown>(SHIPPING_ROUTING_SETTING_KEY, null));
}

/** Hãng tổ chức đang bật (Kiểm tra đạt + Bật) — đọc trạng thái kết nối, không giải mã gì. */
export async function readyCarrierKeys(): Promise<Set<CarrierKey>> {
  return new Set((await enabledCarriers()).filter((c) => c.ready).map((c) => c.key));
}

// ───────────────────────────── ĐỌC ─────────────────────────────

export type RoutedOrder = {
  id: string;
  code: string;
  receiverName: string;
  phone: string;
  address: string;
  province: string;
  ward: string;
  /** Số khách CÒN PHẢI TRẢ theo chứng từ thanh toán — số người giao thu tận tay. */
  toCollect: number;
  items: string;
  totalQuantity: number;
  note: string;
  confirmedAt: Date | null;
  courierUserId: string | null;
  courierName: string;
  route: ShippingRoute;
};

/** Trần số đơn một lượt đọc — một shop có hơn chừng này đơn đã chốt chưa giao thì trang nói rõ, không cắt im lặng. */
export const ROUTED_ORDERS_MAX = 2000;

/**
 * Đơn tạo tay «Đã xác nhận» kèm tuyến giao. Đơn có lần gửi còn hiệu lực trả tuyến `SHIPPED`. Sắp theo mốc xác nhận (cũ trước).
 * `truncated` = có hơn `ROUTED_ORDERS_MAX` đơn — màn hình phải nói ra.
 */
export async function routedOrders(now = new Date()): Promise<{ rows: RoutedOrder[]; truncated: boolean; config: ShippingRoutingConfig; ready: Set<CarrierKey> }> {
  const [config, ready] = await Promise.all([loadShippingRouting(), readyCarrierKeys()]);
  const db = await getDb();
  const o = schema.orders;
  const d = schema.orderDispatch;
  const base = await db
    .select({ order: o, dispatch: d })
    .from(o)
    .leftJoin(d, eq(d.orderId, o.id))
    .where(and(eq(o.stage, "CONFIRMED"), sql`${o.id} like ${`${MANUAL_ORDER_ID_PREFIX}%`}`))
    .orderBy(asc(o.lastUpdateStatusAt), asc(o.id))
    .limit(ROUTED_ORDERS_MAX + 1);
  const truncated = base.length > ROUTED_ORDERS_MAX;
  const list = base.slice(0, ROUTED_ORDERS_MAX);
  const ids = list.map((r) => r.order.id);
  const [items, ships, pays] = ids.length
    ? await Promise.all([
        db.select({ orderId: schema.orderItems.orderId, name: schema.orderItems.productName, detail: schema.orderItems.variationDetail, quantity: schema.orderItems.quantity, weight: schema.orderItems.weight }).from(schema.orderItems).where(inArray(schema.orderItems.orderId, ids)).orderBy(asc(schema.orderItems.id)),
        db.select({ orderId: schema.shipments.orderId, stage: schema.shipments.stage, raw: schema.shipments.raw }).from(schema.shipments).where(inArray(schema.shipments.orderId, ids)),
        db.select({ orderId: schema.orderPayments.orderId, kind: schema.orderPayments.kind, amount: schema.orderPayments.amount, status: schema.orderPayments.status }).from(schema.orderPayments).where(inArray(schema.orderPayments.orderId, ids)),
      ])
    : [[], [], []];
  const group = <T extends { orderId: string | null }>(rows: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (r.orderId) m.set(r.orderId, [...(m.get(r.orderId) ?? []), r]);
    return m;
  };
  const itemsBy = group(items);
  const shipsBy = group(ships);
  const paysBy = group(pays);
  const rows = list.map(({ order, dispatch }): RoutedOrder => {
    const its = itemsBy.get(order.id) ?? [];
    const weightGrams = linesWeight(its.map((i) => ({ name: i.name ?? "", quantity: i.quantity, unitPrice: 0, weightGrams: i.weight })));
    const auto: AutoAttemptState | null = dispatch ? { attempts: dispatch.autoAttempts, lastAt: dispatch.autoLastAt, lastResult: dispatch.autoLastResult === "CREATED" || dispatch.autoLastResult === "FAILED" ? dispatch.autoLastResult : null, lastMessage: dispatch.autoLastMessage } : null;
    const route = decideShippingRoute(
      {
        isErp: true,
        stage: order.stage,
        province: order.shipProvince ?? "",
        ward: order.shipCommune ?? "",
        hasLiveShipment: (shipsBy.get(order.id) ?? []).some((s) => attemptHoldsOrder({ stage: s.stage, raw: s.raw })),
        weightGrams,
        confirmedAt: order.lastUpdateStatusAt ?? null,
        updatedAt: order.updatedAt,
        auto,
      },
      config,
      ready,
      now,
    );
    return {
      id: order.id,
      code: manualOrderShortCode(order.id),
      receiverName: order.shipFullName || order.billFullName || "",
      phone: order.shipPhone || order.billPhone || "",
      address: order.shipAddress || order.shipFullAddress || "",
      province: order.shipProvince ?? "",
      ward: order.shipCommune ?? "",
      toCollect: manualPaymentStatus(sumConfirmedPayments(paysBy.get(order.id) ?? []), manualOrderAmountDue(order)).outstanding,
      items: its.map((i) => `${[i.name, i.detail].filter(Boolean).join(" · ") || "Hàng hoá"} × ${i.quantity}`).join("; "),
      totalQuantity: its.reduce((s, i) => s + i.quantity, 0),
      note: order.note ?? "",
      confirmedAt: order.lastUpdateStatusAt ?? null,
      courierUserId: dispatch?.courierUserId ?? null,
      courierName: dispatch?.courierName ?? "",
      route,
    };
  });
  return { rows, truncated, config, ready };
}

// ───────────────────────────── GHI: CẤU HÌNH ─────────────────────────────

type Failure = { ok: false; error: string };

const configZ = z
  .object({
    selfAreas: z.array(z.object({ province: z.string().trim().min(1).max(SHIPPING_ROUTING_LIMITS.nameMax), wards: z.array(z.string().trim().min(1).max(SHIPPING_ROUTING_LIMITS.nameMax)).max(SHIPPING_ROUTING_LIMITS.maxWardsPerArea) }).strict()).max(SHIPPING_ROUTING_LIMITS.maxAreas),
    defaultCarrier: z.enum(CARRIER_KEYS).nullable(),
    autoCreate: z.boolean(),
    serviceCode: z.string().trim().max(10).nullable(),
  })
  .strict();

/**
 * Lưu cấu hình tuyến giao. Cổng: tổ chức tạo đơn tay (`manualOrderOrgGate`) + `settings:manage`. Tên tỉnh / xã phải nằm trong
 * danh mục địa giới mới (lưu TÊN CHUẨN) — tên lạ bị từ chối kèm danh sách, không lặng lẽ bỏ. Bật «Tự tạo vận đơn» đòi hãng
 * mặc định ĐANG BẬT; mốc bật (`autoSince`) giữ nguyên qua các lần lưu sau, tắt thì xoá — bật lại là một mốc mới.
 */
export async function saveShippingRoutingCore(user: SessionUser, raw: unknown): Promise<{ ok: true; config: ShippingRoutingConfig } | Failure> {
  const gate = await manualOrderOrgGate();
  if (!gate.allowed) return { ok: false, error: gate.reason };
  if (!can(user, "settings:manage")) return { ok: false, error: "Cần quyền cấu hình (settings:manage) để đổi tuyến giao." };
  const parsed = configZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · ") };
  const v = parsed.data;
  const unknown: string[] = [];
  const areas = new Map<string, Set<string>>();
  for (const a of v.selfAreas) {
    const province = canonicalProvince(a.province);
    if (!province) {
      unknown.push(`tỉnh «${a.province}»`);
      continue;
    }
    const wards = areas.get(province) ?? new Set<string>();
    for (const w of a.wards) {
      const ward = canonicalWard(province, w);
      if (ward) wards.add(ward);
      else unknown.push(`«${w}» (${province})`);
    }
    areas.set(province, wards);
  }
  if (unknown.length) return { ok: false, error: `Không có trong danh mục địa giới mới: ${unknown.slice(0, 8).join(", ")}${unknown.length > 8 ? "…" : ""}. Chọn từ danh sách.` };
  const serviceCode = v.serviceCode ? v.serviceCode.toUpperCase() : null;
  if (serviceCode && !isServiceCode(serviceCode)) return { ok: false, error: "Mã dịch vụ chỉ gồm chữ in hoa và số (tối đa 10 ký tự) — để trống để máy chọn dịch vụ rẻ nhất." };
  if (v.autoCreate) {
    if (!v.defaultCarrier) return { ok: false, error: "Bật «Tự tạo vận đơn» cần chọn hãng mặc định." };
    if (!(await readyCarrierKeys()).has(v.defaultCarrier)) return { ok: false, error: `${CARRIER_ADAPTERS[v.defaultCarrier].label} chưa bật kết nối — Cài đặt → Kết nối → nhóm «Vận chuyển»: khai tài khoản, Kiểm tra đạt rồi Bật.` };
  }
  const before = await loadShippingRouting();
  const autoSince = v.autoCreate ? (before.autoCreate && before.autoSince ? before.autoSince : new Date().toISOString()) : null;
  const config: ShippingRoutingConfig = {
    selfAreas: [...areas].map(([province, wards]) => ({ province, wards: [...wards] })),
    defaultCarrier: v.defaultCarrier,
    autoCreate: v.autoCreate,
    serviceCode,
    autoSince,
  };
  await setSettingJson(SHIPPING_ROUTING_SETTING_KEY, config);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SHIPPING_ROUTING_SAVE",
    entity: "SETTINGS",
    entityId: SHIPPING_ROUTING_SETTING_KEY,
    before,
    after: config,
    reason: config.autoCreate && !before.autoCreate ? "Bật tự tạo vận đơn theo tuyến giao — chỉ đơn xác nhận từ bây giờ" : "Sửa tuyến giao (khu tự giao / hãng mặc định)",
  });
  return { ok: true, config };
}

// ───────────────────────────── GHI: NGƯỜI GIAO ─────────────────────────────

const assignZ = z.object({ orderIds: z.array(z.string().min(1).max(200)).min(1, "Chọn ít nhất một đơn.").max(SHIPPING_ROUTING_LIMITS.assignMax), courierUserId: z.string().min(1).max(200).nullable() }).strict();

/**
 * Gán (hoặc bỏ gán — `null`) NGƯỜI GIAO cho đơn tự giao. Cổng = cổng sửa đơn tay (`orders:write`). Người giao là KHOÁ tài khoản
 * đang bật (luật 34); tên lưu kèm là ảnh chụp do máy chủ đọc. Chỉ đơn tạo tay còn «Đã xác nhận» — đơn đã giao / đã huỷ bị bỏ
 * qua và đếm riêng. Không đổi trạng thái đơn, không chạm tiền, không chạm tồn.
 */
export async function assignCourierCore(user: SessionUser, raw: unknown): Promise<{ ok: true; assigned: number; skipped: number; courierName: string } | Failure> {
  const gate = await manualOrderGate(user);
  if (!gate.allowed) return { ok: false, error: gate.reason };
  const parsed = assignZ.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join(" · ") };
  const db = await getDb();
  let courierName = "";
  if (parsed.data.courierUserId) {
    const [u] = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, active: schema.users.active }).from(schema.users).where(eq(schema.users.id, parsed.data.courierUserId)).limit(1);
    if (!u || !u.active) return { ok: false, error: "Người giao không có hoặc tài khoản đã tắt." };
    courierName = u.name || u.email;
  }
  const ids = [...new Set(parsed.data.orderIds)];
  const live = await db.select({ id: schema.orders.id }).from(schema.orders).where(and(inArray(schema.orders.id, ids), eq(schema.orders.stage, "CONFIRMED"), sql`${schema.orders.id} like ${`${MANUAL_ORDER_ID_PREFIX}%`}`));
  const now = new Date();
  const courierUserId = parsed.data.courierUserId;
  for (const r of live) {
    const set = { courierUserId, courierName, assignedAt: courierUserId ? now : null, assignedByUserId: courierUserId ? user.id : null, updatedAt: now };
    await db.insert(schema.orderDispatch).values({ orderId: r.id, ...set }).onConflictDoUpdate({ target: schema.orderDispatch.orderId, set });
  }
  if (live.length) {
    await audit({ userId: user.id, userEmail: user.email, action: "ORDER_COURIER_ASSIGN", entity: "ORDER", entityId: live.length === 1 ? live[0]!.id : undefined, after: { orderIds: live.map((r) => r.id), courierUserId, courierName }, reason: courierUserId ? `Giao cho ${courierName} đi giao` : "Bỏ người giao" });
  }
  return { ok: true, assigned: live.length, skipped: ids.length - live.length, courierName };
}

// ───────────────────────────── JOB: MÁY TỰ TẠO VẬN ĐƠN ─────────────────────────────

export type ShippingRouteRun =
  | { skipped: "ORG_GATE" | "OFF" | "CARRIER_OFF" | "IDLE" | "RUNNING"; detail: string }
  | { skipped?: undefined; due: number; created: number; failed: number; detail: string[] };

async function recordAttempt(orderId: string, carrier: CarrierKey, prev: AutoAttemptState | null, orderUpdatedAt: Date, r: { ok: true; message: string } | { ok: false; error: string }) {
  const db = await getDb();
  const now = new Date();
  const set = r.ok
    ? { autoAttempts: 0, autoLastAt: now, autoLastResult: "CREATED", autoLastCarrier: carrier, autoLastMessage: r.message.slice(0, 500), updatedAt: now }
    : { autoAttempts: nextFailedAttempts(prev, orderUpdatedAt), autoLastAt: now, autoLastResult: "FAILED", autoLastCarrier: carrier, autoLastMessage: r.error.slice(0, 500), updatedAt: now };
  await db.insert(schema.orderDispatch).values({ orderId, ...set }).onConflictDoUpdate({ target: schema.orderDispatch.orderId, set });
}

/**
 * MỘT LƯỢT của job `shipping-route` cho tổ chức ngữ cảnh: đơn mà tuyến nói «đi hãng, máy được tự tạo» ⇒ `autoCreateShipmentCore`
 * TUẦN TỰ, tối đa `autoPerRun` đơn (cũ trước). Mỗi lượt gọi để lại dấu ở `order_dispatch` (thành công / hỏng + câu lỗi) để lượt
 * sau không dội hãng. Một đơn hỏng không dừng cả lượt. Công tắc tắt / tổ chức không tạo đơn tay ⇒ bỏ qua sau một câu đọc.
 */
export async function runShippingRoutes(opts: { now?: Date } = {}, deps: CarrierDeps = {}): Promise<ShippingRouteRun> {
  const gate = await manualOrderOrgGate();
  if (!gate.allowed) return { skipped: "ORG_GATE", detail: gate.reason };
  const cfg = await loadShippingRouting();
  if (!cfg.autoCreate || !cfg.defaultCarrier) return { skipped: "OFF", detail: "Tự tạo vận đơn đang tắt." };
  const { rows } = await routedOrders(opts.now ?? new Date());
  const due = rows.filter((r): r is RoutedOrder & { route: Extract<ShippingRoute, { kind: "CARRIER" }> } => r.route.kind === "CARRIER" && r.route.auto.ok);
  if (!due.length) {
    const off = rows.some((r) => r.route.kind === "HOLD" && r.route.code === "CARRIER_OFF");
    return off ? { skipped: "CARRIER_OFF", detail: "Hãng mặc định chưa bật kết nối." } : { skipped: "IDLE", detail: "Không đơn nào chờ máy tạo vận đơn." };
  }
  const db = await getDb();
  let created = 0;
  let failed = 0;
  const detail: string[] = [];
  for (const r of due.slice(0, SHIPPING_ROUTING_LIMITS.autoPerRun)) {
    const [state] = await db.select().from(schema.orderDispatch).where(eq(schema.orderDispatch.orderId, r.id)).limit(1);
    const [ord] = await db.select({ updatedAt: schema.orders.updatedAt }).from(schema.orders).where(eq(schema.orders.id, r.id)).limit(1);
    const prev: AutoAttemptState | null = state ? { attempts: state.autoAttempts, lastAt: state.autoLastAt, lastResult: state.autoLastResult === "CREATED" || state.autoLastResult === "FAILED" ? state.autoLastResult : null, lastMessage: state.autoLastMessage } : null;
    let res: { ok: true; message: string } | { ok: false; error: string };
    try {
      res = await autoCreateShipmentCore(SHIPPING_ROUTE_JOB, r.route.carrier, r.id, { serviceCode: cfg.serviceCode }, deps);
    } catch (error) {
      res = { ok: false, error: `Lỗi máy chủ: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
    }
    if (!res.ok) {
      // Hỏng vì đơn ĐÃ có một lần gửi còn giữ đơn (người bấm tay / lượt khác giữ chỗ trước, hoặc chính lượt này đứt mạng và
      // lõi giữ chỗ ở UNKNOWN) ⇒ không phải lỗi của tuyến: không ghi «hỏng», đơn tự sang «Đã có vận đơn» và người tra ở trang đơn.
      const live = await db.select({ stage: schema.shipments.stage, raw: schema.shipments.raw }).from(schema.shipments).where(eq(schema.shipments.orderId, r.id));
      if (live.some((s) => attemptHoldsOrder(s))) {
        detail.push(`${r.code}: ${res.error}`);
        continue;
      }
    }
    await recordAttempt(r.id, r.route.carrier, prev, ord?.updatedAt ?? new Date(0), res);
    if (res.ok) created += 1;
    else {
      failed += 1;
      detail.push(`${r.code}: ${res.error}`);
    }
  }
  return { due: due.length, created, failed, detail };
}

/** Bọc `runShippingRoutes` trong `runSyncJob` CHỈ khi có việc — lượt rỗng không ghi `sync_runs` (288 dòng rỗng mỗi ngày). */
export async function runShippingRouteJob(o: { trigger: SyncTrigger; actor: string }, deps: CarrierDeps = {}): Promise<ShippingRouteRun> {
  const gate = await manualOrderOrgGate();
  if (!gate.allowed) return { skipped: "ORG_GATE", detail: gate.reason };
  if (!(await loadShippingRouting()).autoCreate) return { skipped: "OFF", detail: "Tự tạo vận đơn đang tắt." };
  // Câu hỏi «có việc không» dùng CHÍNH phép xếp tuyến của lượt chạy — không có đơn nào máy được tạo ⇒ không mở sổ.
  const { rows } = await routedOrders();
  if (!rows.some((x) => x.route.kind === "CARRIER" && x.route.auto.ok)) return { skipped: "IDLE", detail: "Không đơn nào chờ máy tạo vận đơn." };
  const r = await runSyncJob({ source: "ERP", job: SHIPPING_ROUTE_JOB, trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
    const run = await runShippingRoutes({}, deps);
    if (run.skipped) {
      ctx.summary.detail = run.detail;
      return run;
    }
    ctx.summary.imported = run.created;
    ctx.summary.failed = run.failed;
    ctx.summary.detail = `${run.due} đơn chờ máy tạo vận đơn · tạo ${run.created} · hỏng ${run.failed}${run.detail.length ? ` — ${run.detail.slice(0, 4).join(" · ")}` : ""}`.slice(0, 900);
    return run;
  });
  if (r.skippedBecauseRunning) return { skipped: "RUNNING", detail: "Lượt trước của tổ chức này còn đang chạy." };
  return r.result ?? { skipped: "IDLE", detail: "Lượt không trả kết quả." };
}
