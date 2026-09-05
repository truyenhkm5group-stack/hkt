import { env } from "@/lib/env";
import { asArray, asRecord, fetchJson, int, IntegrationError, sleep, str } from "@/lib/integrations/http";

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
  ) {
    if (!this.apiKey) throw new IntegrationError("Pancake: chưa cấu hình PANCAKE_API_KEY", 400);
    if (!this.shopId) throw new IntegrationError("Pancake: chưa cấu hình PANCAKE_SHOP_ID", 400);
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
    const wait = THROTTLE_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const { body } = await fetchJson(this.buildUrl(path, params), { serviceName: "Pancake", timeoutMs: 90_000 });
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
    const wait = THROTTLE_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const { body: res } = await fetchJson(this.buildUrl(path, params), { serviceName: "Pancake", timeoutMs: 90_000, method: "POST", body: JSON.stringify(body), retries: 0 });
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

let cached: PancakeClient | null = null;
export function getPancakeClient() {
  if (!cached) cached = new PancakeClient();
  return cached;
}
