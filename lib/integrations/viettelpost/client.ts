import { env } from "@/lib/env";
import { asArray, asRecord, fetchJson, int, IntegrationError, num, sleep, str, vtpDate } from "@/lib/integrations/http";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

const TOKEN_KEY = "viettelpost";
const THROTTLE_MS = 200;
let lastCallAt = 0;

export type VtpEnvelope = { status: number; error: boolean; message: string; data: unknown };

export type VtpTrackingRecord = {
  orderNumber: string;
  orderReference: string;
  status: number | null;
  statusName: string;
  statusDate: Date | null;
  location: string;
  note: string;
  reasonCode: number | null;
  moneyCollection: number;
  moneyTotal: number;
  moneyTotalFee: number;
  moneyFeeCod: number;
  productWeight: number;
  service: string;
  expectedDelivery: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  employeeName: string;
  employeePhone: string;
  journey: { status: number | null; statusName: string; location: string; note: string; occurredAt: Date | null; raw: Record<string, unknown> }[];
  raw: Record<string, unknown>;
};

function decodeJwtExp(token: string): Date | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? new Date(json.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** Mã thao tác UpdateOrder của Viettel Post */
export type VtpOrderActionType = 1 | 2 | 3 | 4 | 5 | 11;
export const VTP_ORDER_ACTIONS: { type: VtpOrderActionType; key: string; label: string; hint: string; confirm: string; tone: "default" | "destructive" | "secondary" }[] = [
  { type: 3, key: "redeliver", label: "Phát tiếp", hint: "Yêu cầu bưu tá giao lại cho khách", confirm: "Yêu cầu Viettel Post phát tiếp vận đơn này?", tone: "default" },
  { type: 2, key: "approve-return", label: "Duyệt hoàn", hint: "Đồng ý chuyển hoàn về kho", confirm: "Duyệt chuyển hoàn vận đơn này về kho?", tone: "secondary" },
  { type: 5, key: "resend", label: "Gửi lại", hint: "Lấy lại đơn để gửi lại (đơn đã huỷ / hoàn)", confirm: "Lấy lại đơn để gửi lại?", tone: "secondary" },
  { type: 1, key: "approve", label: "Duyệt đơn", hint: "Duyệt đơn chờ duyệt", confirm: "Duyệt đơn hàng này?", tone: "secondary" },
  { type: 4, key: "cancel", label: "Huỷ vận đơn", hint: "Huỷ đơn trên Viettel Post (chưa phát)", confirm: "HUỶ vận đơn này trên Viettel Post?", tone: "destructive" },
];

export class ViettelPostClient {
  private token: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(private readonly baseUrl = env.viettelPost.baseUrl) {}

  get configured() {
    return Boolean(env.viettelPost.apiKey || (env.viettelPost.username && env.viettelPost.password));
  }

  private async rawCall(path: string, options: { method?: string; body?: unknown; token?: string | null; query?: Record<string, unknown> } = {}): Promise<VtpEnvelope> {
    const wait = THROTTLE_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {};
    if (options.token) headers.Token = options.token;
    const { body } = await fetchJson(url, {
      serviceName: "ViettelPost",
      method: options.method ?? (options.body ? "POST" : "GET"),
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      timeoutMs: 45_000,
      retries: 2,
    });
    if (Array.isArray(body)) return { status: 200, error: false, message: "OK", data: body };
    const record = asRecord(body);
    return {
      status: int(record.status) || 200,
      error: typeof record.error === "boolean" ? record.error : false,
      message: str(record.message),
      data: "data" in record ? record.data : record,
    };
  }

  /** Gọi API thô (dùng cho chẩn đoán) */
  debugCall(path: string, options: { method?: string; body?: unknown; token?: string | null; query?: Record<string, unknown> } = {}) {
    return this.rawCall(path, options);
  }

  /** Lấy token đối tác: ưu tiên loginVTP (token bí mật từ viettelpost.vn), fallback Login → ownerconnect */
  private async authenticate(): Promise<{ token: string; expiresAt: Date | null; method: string }> {
    const errors: string[] = [];
    if (env.viettelPost.apiKey) {
      try {
        const res = await this.rawCall("user/loginVTP", { method: "POST", body: { token: env.viettelPost.apiKey }, token: env.viettelPost.apiKey });
        const token = str(asRecord(res.data).token);
        if (!res.error && token) return { token, expiresAt: decodeJwtExp(token), method: "loginVTP" };
        errors.push(`loginVTP: ${res.message || `mã ${res.status}`}`);
      } catch (error) {
        errors.push(`loginVTP: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Dự phòng: một số tài khoản được cấp token dùng trực tiếp làm header Token (không cần đổi qua loginVTP)
      try {
        const probe = await this.rawCall("user/listInventory", { token: env.viettelPost.apiKey });
        if (!probe.error && probe.status !== 202) return { token: env.viettelPost.apiKey, expiresAt: decodeJwtExp(env.viettelPost.apiKey), method: "direct" };
        errors.push(`token trực tiếp: ${probe.message || `mã ${probe.status}`}`);
      } catch (error) {
        errors.push(`token trực tiếp: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (env.viettelPost.username && env.viettelPost.password) {
      try {
        const credentials = { USERNAME: env.viettelPost.username, PASSWORD: env.viettelPost.password };
        const login = await this.rawCall("user/Login", { method: "POST", body: credentials });
        const shortToken = str(asRecord(login.data).token);
        if (login.error || !shortToken) throw new Error(login.message || "Đăng nhập thất bại");
        const owner = await this.rawCall("user/ownerconnect", { method: "POST", body: credentials, token: shortToken });
        const longToken = str(asRecord(owner.data).token) || shortToken;
        return { token: longToken, expiresAt: decodeJwtExp(longToken), method: "ownerconnect" };
      } catch (error) {
        errors.push(`Login/ownerconnect: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new IntegrationError(
      errors.length ? `ViettelPost: không lấy được token (${errors.join(" · ")})` : "ViettelPost: chưa cấu hình VIETTELPOST_API_KEY hoặc tài khoản",
      401,
    );
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && (!this.tokenExpiresAt || this.tokenExpiresAt.getTime() - Date.now() > 3600_000)) return this.token;
    const db = await getDb().catch(() => null);
    if (!forceRefresh && db) {
      const stored = await db.query.integrationTokens.findFirst({ where: eq(schema.integrationTokens.provider, TOKEN_KEY) }).catch(() => null);
      if (stored && (!stored.expiresAt || stored.expiresAt.getTime() - Date.now() > 3600_000)) {
        this.token = stored.token;
        this.tokenExpiresAt = stored.expiresAt;
        return stored.token;
      }
    }
    const auth = await this.authenticate();
    this.token = auth.token;
    this.tokenExpiresAt = auth.expiresAt;
    if (db) {
      const meta = { method: auth.method, issuedAt: new Date().toISOString() };
      await db
        .insert(schema.integrationTokens)
        .values({ provider: TOKEN_KEY, token: auth.token, expiresAt: auth.expiresAt, meta })
        .onConflictDoUpdate({ target: schema.integrationTokens.provider, set: { token: auth.token, expiresAt: auth.expiresAt, meta, updatedAt: new Date() } })
        .catch(() => undefined);
    }
    return auth.token;
  }

  /** Gọi API có token, tự làm mới token khi hết hạn */
  async call(path: string, options: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<VtpEnvelope> {
    const token = await this.getToken();
    const res = await this.rawCall(path, { ...options, token });
    const tokenError = res.error && (res.status === 202 || res.status === 401 || /token/i.test(res.message));
    if (!tokenError) return res;
    const fresh = await this.getToken(true);
    return this.rawCall(path, { ...options, token: fresh });
  }

  async testConnection() {
    const token = await this.getToken();
    const info = await this.rawCall("user/info", { token }).catch(() => null);
    const inventories = await this.rawCall("user/listInventory", { token }).catch(() => null);
    const account = asRecord(info?.data);
    return {
      ok: true,
      tokenExpiresAt: this.tokenExpiresAt,
      account: { name: str(account.NAME, account.name, account.FULLNAME), phone: str(account.PHONE, account.phone), userId: str(account.USER_ID, account.userId, account.CUS_ID) },
      inventories: asArray(inventories?.data).map((i) => {
        const r = asRecord(i);
        return { id: str(r.groupaddressId, r.GROUPADDRESS_ID), name: str(r.name, r.NAME), address: str(r.address, r.ADDRESS) };
      }),
    };
  }

  /** Tra cứu chi tiết/trạng thái một vận đơn */
  async getOrderDetail(orderNumber: string): Promise<VtpTrackingRecord | null> {
    const res = await this.call("order/getOrderDetailV3", { query: { OrderNumber: orderNumber } });
    if (res.error) {
      if ([203, 207].includes(res.status) || /không tồn tại|not exist/i.test(res.message)) return null;
      throw new IntegrationError(`ViettelPost: ${res.message || `mã ${res.status}`}`, 400, false, res);
    }
    const data = Array.isArray(res.data) ? asRecord(res.data[0]) : asRecord(res.data);
    if (!Object.keys(data).length) return null;
    return normalizeTracking(data, orderNumber);
  }

  /** Danh sách vận đơn theo khoảng ngày (order-filter) */
  async listOrders(params: { from: Date; to: Date; statuses?: number[]; page?: number; inventories?: number[] }) {
    const fmt = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
    const res = await this.call("order/order-filter", {
      method: "POST",
      query: { page: params.page ?? 1 },
      body: { filter: "", from_date: fmt(params.from), to_date: fmt(params.to), list_inventory: params.inventories ?? [], list_status: params.statuses ?? [] },
    });
    if (res.error) throw new IntegrationError(`ViettelPost: ${res.message || `mã ${res.status}`}`, 400, false, res);
    const root = asRecord(res.data);
    const list = Array.isArray(res.data) ? res.data : asArray(root.LIST_ORDER ?? root.list_order ?? root.data ?? root.content ?? root.items ?? root.orders);
    const total = int(root.TOTAL, root.total, root.totalElements, root.total_entries) || list.length;
    return { orders: list.map((o) => normalizeTracking(asRecord(o))), total, raw: res.data };
  }

  /**
   * Thao tác trên vận đơn (API v2/order/UpdateOrder): TYPE 1 duyệt đơn · 2 duyệt chuyển hoàn · 3 phát tiếp · 4 huỷ đơn ·
   * 5 lấy lại / gửi lại · 11 xoá đơn đã huỷ. Tài khoản đối tác phải là chủ vận đơn (cùng mã khách hàng).
   */
  async updateOrder(orderNumber: string, type: VtpOrderActionType, note = "", date?: string) {
    const res = await this.call("order/UpdateOrder", { method: "POST", body: { TYPE: type, ORDER_NUMBER: orderNumber, NOTE: note, DATE: date ?? new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" }) } });
    if (res.error) throw new IntegrationError(`ViettelPost: ${res.message || `mã ${res.status}`}`, 400, false, res);
    return res;
  }

  /** Sửa thông tin người nhận / tiền thu hộ / ghi chú của vận đơn chưa phát (API v2/order/edit) */
  async editOrder(orderNumber: string, fields: { receiverName?: string; receiverPhone?: string; receiverAddress?: string; moneyCollection?: number; note?: string; productName?: string }) {
    const body: Record<string, unknown> = { ORDER_NUMBER: orderNumber };
    if (fields.receiverName !== undefined) body.RECEIVER_FULLNAME = fields.receiverName;
    if (fields.receiverPhone !== undefined) body.RECEIVER_PHONE = fields.receiverPhone;
    if (fields.receiverAddress !== undefined) body.RECEIVER_ADDRESS = fields.receiverAddress;
    if (fields.moneyCollection !== undefined) body.MONEY_COLLECTION = fields.moneyCollection;
    if (fields.note !== undefined) body.ORDER_NOTE = fields.note;
    if (fields.productName !== undefined) body.PRODUCT_NAME = fields.productName;
    const res = await this.call("order/edit", { method: "POST", body });
    if (res.error) throw new IntegrationError(`ViettelPost: ${res.message || `mã ${res.status}`}`, 400, false, res);
    return res;
  }

  /** Lịch sử đẩy webhook của một vận đơn */
  async listPushHistory(orderNumber: string) {
    const res = await this.call("order/list-data-push-his", { query: { orderNumber } });
    return asArray(res.data).map(asRecord);
  }

  /** Yêu cầu VTP gửi lại webhook (trạng thái cuối hoặc cả hành trình) */
  async rePush(orderNumber: string, all = false) {
    return this.call("order/re-push-message", { method: "POST", query: { orderNumber, isAll: all } });
  }
}

/** Chuẩn hoá bản ghi trạng thái (dùng chung cho getOrderDetailV3, order-filter và webhook DATA) */
export function normalizeTracking(data: Record<string, unknown>, fallbackOrderNumber = ""): VtpTrackingRecord {
  const statusRaw = data.ORDER_STATUS ?? data.order_status ?? data.STATUS ?? data.status;
  const status = statusRaw === null || statusRaw === undefined || statusRaw === "" ? null : int(statusRaw);
  const journeySource = [data.LIST_TRACK, data.ORDER_TRACKING, data.TRACKING, data.JOURNEY, data.HISTORY, data.list_track, data.tracking, data.DETAIL_TRACK]
    .map(asArray)
    .find((arr) => arr.length && asRecord(arr[0]).ORDER_STATUS !== undefined || (arr.length && asRecord(arr[0]).STATUS_NAME !== undefined)) ?? [];
  const journey = journeySource.map((entry) => {
    const r = asRecord(entry);
    const s = r.ORDER_STATUS ?? r.STATUS ?? r.status;
    return {
      status: s === null || s === undefined ? null : int(s),
      statusName: str(r.STATUS_NAME, r.ORDER_STATUS_NAME, r.NAME, r.status_name),
      location: str(r.LOCATION_CURRENTLY, r.LOCALION_CURRENTLY, r.LOCATION, r.location),
      note: str(r.NOTE, r.note),
      occurredAt: vtpDate(r.ORDER_STATUSDATE ?? r.STATUS_DATE ?? r.DATE ?? r.date ?? r.TIME),
      raw: r,
    };
  });
  return {
    orderNumber: str(data.ORDER_NUMBER, data.order_number, fallbackOrderNumber),
    orderReference: str(data.ORDER_REFERENCE, data.order_reference),
    status,
    statusName: str(data.STATUS_NAME, data.ORDER_STATUS_NAME, data.status_name),
    statusDate: vtpDate(data.ORDER_STATUSDATE ?? data.order_statusdate ?? data.STATUS_DATE),
    location: str(data.LOCATION_CURRENTLY, data.LOCALION_CURRENTLY, data.location),
    note: str(data.NOTE, data.note),
    reasonCode: data.REASON_CODE === null || data.REASON_CODE === undefined ? null : int(data.REASON_CODE),
    moneyCollection: int(data.MONEY_COLLECTION, data.money_collection),
    moneyTotal: int(data.MONEY_TOTAL, data.money_total),
    moneyTotalFee: int(data.MONEY_TOTALFEE, data.MONEY_TOTAL_FEE, data.money_totalfee),
    moneyFeeCod: int(data.MONEY_FEECOD, data.money_feecod),
    productWeight: int(data.PRODUCT_WEIGHT, data.product_weight),
    service: str(data.ORDER_SERVICE, data.order_service),
    expectedDelivery: str(data.EXPECTED_DELIVERY, data.EXPECTED_DELIVERY_DATE),
    receiverName: str(data.RECEIVER_FULLNAME, data.receiver_fullname),
    receiverPhone: str(data.RECEIVER_PHONE, data.receiver_phone),
    receiverAddress: str(data.RECEIVER_ADDRESS, data.receiver_address),
    employeeName: str(data.EMPLOYEE_NAME),
    employeePhone: str(data.EMPLOYEE_PHONE),
    journey,
    raw: data,
  };
}

export function moneyOrZero(value: unknown) {
  const n = num(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

let cached: ViettelPostClient | null = null;
export function getViettelPostClient() {
  if (!cached) cached = new ViettelPostClient();
  return cached;
}
