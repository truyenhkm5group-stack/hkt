import { AsyncLocalStorage } from "node:async_hooks";
import { maskPancakeKey, PANCAKE_POS_API, PANCAKE_POS_ORG_CONNECTOR } from "@/lib/constants/pancake-pos-org";
import { env } from "@/lib/env";
import { asArray, asRecord, fetchJson, int, IntegrationError, sleep, str } from "@/lib/integrations/http";
import { assertConnectionOwner, assertHomeCredentials, ConnectorUnavailableError, perOrganizationClients } from "@/lib/platform/credentials";

export type PancakeListResponse<T = Record<string, unknown>> = {
  data: T[];
  pageNumber: number;
  pageSize: number;
  totalEntries: number;
  totalPages: number;
};

export type PancakeOrdersQuery = {
  pageSize?: number;
  pageNumber?: number;
  /** inserted_at | updated_at | partner_inserted_at | paid_at | ... hoặc mã trạng thái */
  updateStatus?: string;
  /** unix seconds */
  startDateTime?: number;
  endDateTime?: number;
  filterStatus?: number[];
  includeRemoved?: boolean;
  optionSort?: string;
  search?: string;
  customerId?: string;
  fields?: string[];
};

const THROTTLE_MS = 250;
let lastCallAt = 0;

export class PancakeClient {
  constructor(
    private readonly apiKey = env.pancake.apiKey,
    private readonly shopId = env.pancake.shopId,
    private readonly baseUrl = env.pancake.baseUrl,
    /** Tổ chức sở hữu khoá khi client dựng từ kết nối «pancake-pos-org»; `null` = biến môi trường của tổ chức nhà. */
    private readonly orgOwner: string | null = null,
  ) {
    if (!this.apiKey) throw new IntegrationError("Pancake: chưa cấu hình PANCAKE_API_KEY", 400);
    if (!this.shopId) throw new IntegrationError("Pancake: chưa cấu hình PANCAKE_SHOP_ID", 400);
  }

  /**
   * Client từ KẾT NỐI CỦA MỘT TỔ CHỨC KHÁCH (F1 · lib/integrations/pancake/org.ts). Khác nhánh nhà ở ba điểm:
   *  ① chặn bằng `assertConnectionOwner` (chủ của khoá) thay vì `assertHomeCredentials` — client của A lọt sang lượt chạy của
   *    B thì NÉM trước khi một byte rời máy;
   *  ② địa chỉ API là HẰNG SỐ (`PANCAKE_POS_API`), không lấy từ cấu hình của nhà hay từ người dùng;
   *  ③ mọi câu lỗi ném ra đã che khoá (API Pancake POS nhận khoá trong query, nên khoá nằm trong URL của request).
   */
  static fromOrgConnection(source: { organization: string; apiKey: string; shopId: string }) {
    return new PancakeClient(source.apiKey, source.shopId, PANCAKE_POS_API, source.organization);
  }

  /** Lời chặn TRƯỚC điều tiết nhịp và trước khi gửi: nhà ⇒ phải đang ở nhà; kết nối tổ chức ⇒ phải đúng chủ của khoá. */
  private async guard() {
    if (this.orgOwner) await assertConnectionOwner(PANCAKE_POS_ORG_CONNECTOR, this.orgOwner);
    else await assertHomeCredentials("pancake");
  }

  /** Nhánh tổ chức: câu lỗi không bao giờ mang khoá. Nhánh nhà giữ nguyên lỗi như cũ. */
  private scrub(error: unknown): unknown {
    if (!this.orgOwner || !(error instanceof Error)) return error;
    const message = maskPancakeKey(error.message, this.apiKey);
    if (message === error.message) return error;
    return error instanceof IntegrationError ? new IntegrationError(message, error.status, error.retryable) : new Error(message);
  }

  get shop() {
    return this.shopId;
  }

  private buildUrl(path: string, params: Record<string, unknown> = {}) {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    url.searchParams.set("api_key", this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${key}[]`, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async get(path: string, params: Record<string, unknown> = {}) {
    // Credential môi trường là của tổ chức nhà — chặn TRƯỚC điều tiết nhịp và trước khi gửi (P12). Kết nối tổ chức: chủ khoá.
    await this.guard();
    const wait = THROTTLE_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const { body } = await fetchJson(this.buildUrl(path, params), { serviceName: "Pancake", timeoutMs: 90_000 }).catch((error: unknown) => {
      throw this.scrub(error);
    });
    const record = asRecord(body);
    if (record.success === false) {
      const message = str(record.message) || "API từ chối yêu cầu";
      const code = int(record.error_code);
      throw new IntegrationError(`Pancake: ${message}${code ? ` (mã ${code})` : ""}`, code === 101 ? 401 : 400, false, body);
    }
    return record;
  }

  /** Gọi POST (tạo / sửa dữ liệu trên Pancake POS) */
  async post(path: string, body: unknown, params: Record<string, unknown> = {}) {
    // Credential môi trường là của tổ chức nhà — chặn TRƯỚC điều tiết nhịp và trước khi gửi (P12). Kết nối tổ chức: chủ khoá.
    await this.guard();
    const wait = THROTTLE_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const { body: res } = await fetchJson(this.buildUrl(path, params), { serviceName: "Pancake", timeoutMs: 90_000, method: "POST", body: JSON.stringify(body), retries: 0 }).catch((error: unknown) => {
      throw this.scrub(error);
    });
    const record = asRecord(res);
    if (record.success === false) {
      const message = str(record.message) || "API từ chối yêu cầu";
      const code = int(record.error_code);
      throw new IntegrationError(`Pancake: ${message}${code ? ` (mã ${code})` : ""}`, code === 101 ? 401 : 400, false, res);
    }
    return record;
  }

  /**
   * Tạo đơn trên Pancake POS (trạng thái Mới = đơn nháp để nhân viên chốt).
   * Body theo API POS: bill_full_name, bill_phone_number, shipping_address{...}, items[{variation_id, quantity}], note, status 0.
   */
  async createOrder(input: { name: string; phone: string; address: string; province?: string; note?: string; items: { variationId: string; quantity: number; price?: number }[]; shippingFee?: number; warehouseId?: string; source?: string }) {
    const body: Record<string, unknown> = {
      shop_id: Number(this.shopId) || this.shopId,
      bill_full_name: input.name,
      bill_phone_number: input.phone,
      note: input.note ?? "",
      status: 0,
      is_free_shipping: false,
      shipping_fee: input.shippingFee ?? 0,
      shipping_address: { full_name: input.name, phone_number: input.phone, address: input.address, full_address: [input.address, input.province].filter(Boolean).join(", ") },
      items: input.items.map((i) => ({ variation_id: i.variationId, quantity: i.quantity, ...(i.price ? { retail_price: i.price } : {}) })),
      ...(input.warehouseId ? { warehouse_id: input.warehouseId } : {}),
      ...(input.source ? { order_sources_name: input.source } : {}),
    };
    const res = await this.post(`shops/${this.shopId}/orders`, body);
    const data = asRecord(res.data);
    return { id: str(data.id), systemId: int(data.system_id), raw: res };
  }

  private toList<T = Record<string, unknown>>(record: Record<string, unknown>): PancakeListResponse<T> {
    return {
      data: asArray(record.data) as T[],
      pageNumber: int(record.page_number) || 1,
      pageSize: int(record.page_size) || 0,
      totalEntries: int(record.total_entries),
      totalPages: int(record.total_pages) || 1,
    };
  }

  // ───────── Shop ─────────
  async getShops() {
    const record = await this.get("shops");
    return asArray(record.shops).map(asRecord);
  }

  async testConnection() {
    const shops = await this.getShops();
    const shop = shops.find((s) => str(s.id) === this.shopId) ?? shops[0];
    return { ok: true, shopName: str(shop?.name), shops: shops.map((s) => ({ id: str(s.id), name: str(s.name) })) };
  }

  // ───────── Orders ─────────
  async listOrders(query: PancakeOrdersQuery = {}) {
    const record = await this.get(`shops/${this.shopId}/orders`, {
      page_size: Math.min(Math.max(query.pageSize ?? 100, 1), 200),
      page_number: query.pageNumber ?? 1,
      updateStatus: query.updateStatus,
      startDateTime: query.startDateTime,
      endDateTime: query.endDateTime,
      filter_status: query.filterStatus,
      include_removed: query.includeRemoved ? 1 : undefined,
      option_sort: query.optionSort,
      search: query.search,
      customer_id: query.customerId,
      fields: query.fields,
    });
    return this.toList(record);
  }

  /**
   * Lịch sử SĐT trên TOÀN MẠNG Pancake (đơn thành công / thất bại, các lần bị shop khác báo) — đường
   * web POS dùng cho cột "Tỷ lệ hoàn" / "Cảnh báo SĐT". Đọc: `lib/constants/phone-reputation.ts`.
   */
  async badReportInfo(phone: string) {
    const record = await this.get(`shops/${this.shopId}/orders/bad_report_info`, { phone_number: phone });
    return record.data;
  }

  async getOrder(orderId: string) {
    const record = await this.get(`shops/${this.shopId}/orders/${encodeURIComponent(orderId)}`);
    return asRecord(record.data);
  }

  /**
   * Duyệt toàn bộ đơn trong một cửa sổ thời gian. Pancake giới hạn ~10.000 dòng/truy vấn nên
   * cửa sổ lớn hơn sẽ được chia đôi đệ quy.
   */
  async *iterateOrders(
    options: { updateStatus: "inserted_at" | "updated_at"; start: Date; end: Date; pageSize?: number; includeRemoved?: boolean },
  ): AsyncGenerator<{ orders: Record<string, unknown>[]; window: { start: Date; end: Date }; page: number; totalPages: number; totalEntries: number }> {
    const pageSize = options.pageSize ?? 100;
    const startSec = Math.floor(options.start.getTime() / 1000);
    const endSec = Math.ceil(options.end.getTime() / 1000);
    if (endSec <= startSec) return;

    const first = await this.listOrders({
      updateStatus: options.updateStatus,
      startDateTime: startSec,
      endDateTime: endSec,
      pageSize,
      pageNumber: 1,
      optionSort: options.updateStatus === "updated_at" ? "last_updated_order_asc" : "inserted_at_asc",
      includeRemoved: options.includeRemoved,
    });

    if (first.totalEntries > 10_000 && endSec - startSec > 3600) {
      const mid = Math.floor((startSec + endSec) / 2);
      yield* this.iterateOrders({ ...options, start: new Date(startSec * 1000), end: new Date(mid * 1000) });
      yield* this.iterateOrders({ ...options, start: new Date(mid * 1000), end: new Date(endSec * 1000) });
      return;
    }

    const window = { start: new Date(startSec * 1000), end: new Date(endSec * 1000) };
    yield { orders: first.data, window, page: 1, totalPages: first.totalPages, totalEntries: first.totalEntries };
    let previousFirstId = str(asRecord(first.data[0]).id);
    for (let page = 2; page <= first.totalPages; page += 1) {
      const next = await this.listOrders({
        updateStatus: options.updateStatus,
        startDateTime: startSec,
        endDateTime: endSec,
        pageSize,
        pageNumber: page,
        optionSort: options.updateStatus === "updated_at" ? "last_updated_order_asc" : "inserted_at_asc",
        includeRemoved: options.includeRemoved,
      });
      const firstId = str(asRecord(next.data[0]).id);
      if (!next.data.length || (firstId && firstId === previousFirstId)) break; // trang lặp lại → dừng
      previousFirstId = firstId;
      yield { orders: next.data, window, page, totalPages: first.totalPages, totalEntries: first.totalEntries };
    }
  }

  // ───────── Products ─────────
  async listProducts(pageNumber = 1, pageSize = 100, search?: string) {
    const record = await this.get(`shops/${this.shopId}/products`, { page_number: pageNumber, page_size: pageSize, search });
    return this.toList(record);
  }

  async getProduct(productId: string) {
    const record = await this.get(`shops/${this.shopId}/products/${encodeURIComponent(productId)}`);
    return asRecord(record.data);
  }

  async listVariations(pageNumber = 1, pageSize = 100, params: Record<string, unknown> = {}) {
    const record = await this.get(`shops/${this.shopId}/products/variations`, { page_number: pageNumber, page_size: pageSize, ...params });
    return this.toList(record);
  }

  // ───────── Warehouses / inventory ─────────
  async listWarehouses() {
    const record = await this.get(`shops/${this.shopId}/warehouses`);
    return asArray(record.data).map(asRecord);
  }

  async listInventoryHistories(params: { page?: number; pageSize?: number; startDate?: number; endDate?: number; warehouseId?: string; variationIds?: string[] } = {}) {
    const record = await this.get(`shops/${this.shopId}/inventory_histories`, {
      page: params.page ?? 1,
      page_size: params.pageSize ?? 100,
      startDate: params.startDate,
      endDate: params.endDate,
      warehouse_id: params.warehouseId,
      variation_ids: params.variationIds,
    });
    return this.toList(record);
  }

  // ───────── Customers ─────────
  async listCustomers(params: { pageNumber?: number; pageSize?: number; search?: string; startUpdated?: number; endUpdated?: number; startInserted?: number; endInserted?: number } = {}) {
    const record = await this.get(`shops/${this.shopId}/customers`, {
      page_number: params.pageNumber ?? 1,
      page_size: params.pageSize ?? 100,
      search: params.search,
      start_time_updated_at: params.startUpdated,
      end_time_updated_at: params.endUpdated,
      start_time_inserted_at: params.startInserted,
      end_time_inserted_at: params.endInserted,
    });
    return this.toList(record);
  }

  // ───────── Returns ─────────
  async listOrderReturns(pageNumber = 1, pageSize = 100, params: Record<string, unknown> = {}) {
    const record = await this.get(`shops/${this.shopId}/orders_returned`, { page_number: pageNumber, page_size: pageSize, ...params });
    return this.toList(record);
  }

  // ───────── Partners ─────────
  async listPartners() {
    const record = await this.get(`shops/${this.shopId}/partners`);
    return asArray(record.data).map(asRecord);
  }
}

/**
 * Một client cho MỖI tổ chức (R-04): nhà giữ đúng một instance như trước; tổ chức khác không có
 * credential Pancake nào ⇒ `ConnectorUnavailableError` ngay tại getter, không dựng client từ khoá
 * môi trường của nhà.
 */
const clients = perOrganizationClients<PancakeClient>({
  home: () => new PancakeClient(),
  other: (organization) => {
    throw new ConnectorUnavailableError("pancake", organization);
  },
});

/**
 * CLIENT GHI ĐÈ THEO NGỮ CẢNH (F1 — Pancake POS của tổ chức khách). Lượt đồng bộ / webhook của một tổ chức khách mở kết nối
 * «pancake-pos-org» CỦA CHÍNH tổ chức đó rồi chạy ĐÚNG bộ đồng bộ của nhà (`lib/integrations/pancake/sync.ts`) bên trong
 * `withPancakeClient` — không có bộ đồng bộ thứ hai (AGENTS.md mục 8.12). Ghi đè chỉ sống trong lượt gọi đó; client ghi đè
 * tự hỏi chủ của khoá ở mỗi request, nên dù lọt sang ngữ cảnh tổ chức khác cũng NÉM trước khi gửi.
 */
const overrideClient = new AsyncLocalStorage<PancakeClient>();

export function withPancakeClient<T>(client: PancakeClient, fn: () => Promise<T>): Promise<T> {
  return overrideClient.run(client, fn);
}

export function getPancakeClient() {
  return overrideClient.getStore() ?? clients.get();
}
