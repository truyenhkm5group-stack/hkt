import { GHN_API, GHN_CARRIER_CONNECTOR } from "@/lib/constants/carrier-ghn";
import type { CarrierCall } from "@/lib/carriers/types";
import { assertConnectionOwner } from "@/lib/platform/credentials";

/**
 * ═══════════ CLIENT GIAO HÀNG NHANH (GHN) CỦA TỔ CHỨC KHÁCH (POS tự chủ) ═══════════
 *
 * Cùng khuôn với client Viettel Post của tổ chức (`lib/integrations/viettelpost/carrier-org.ts`):
 *  ① chặn bằng `assertConnectionOwner` TRƯỚC mỗi lượt gửi — client của A lọt sang lượt chạy của B thì NÉM;
 *  ② địa chỉ API HẰNG SỐ (`GHN_API`), không theo chuyển hướng;
 *  ③ KHÔNG tự gửi lại: lỗi giữa chừng trả UNKNOWN (với lệnh tạo, GHN chống trùng bằng `client_order_code` — người thử lại
 *    bằng CÙNG mã thì GHN trả đúng đơn đã tạo, không đẻ đơn thứ hai);
 *  ④ token chỉ đi trong tiêu đề và bị che trong mọi câu lỗi.
 *
 * Phong bì GHN `{ code, message, data }`: `code = 200` là nhận; 4xx là TỪ CHỐI (hãng đã trả lời); 5xx / không đọc được là
 * KHÔNG BIẾT. `deps.fetch` để bài kiểm đưa vào máy chủ giả (luật 65).
 */

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 512 * 1024;

export type GhnEnvelope = { code: number; message: string; data: unknown };

export class GhnClient {
  private readonly fetchImpl: FetchLike;

  private constructor(
    private readonly token: string,
    private readonly shopId: string,
    private readonly orgOwner: string,
    deps: { fetch?: FetchLike },
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  static fromOrgConnection(source: { organization: string; token: string; shopId: string }, deps: { fetch?: FetchLike } = {}) {
    return new GhnClient(source.token.trim(), source.shopId.trim(), source.organization, deps);
  }

  scrub(text: string): string {
    return (this.token && this.token.length >= 6 ? text.split(this.token).join("***") : text).slice(0, 400);
  }

  private async send(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string | number>; withShop?: boolean } = {}): Promise<CarrierCall<GhnEnvelope>> {
    await assertConnectionOwner(GHN_CARRIER_CONNECTOR, this.orgOwner);
    const url = new URL(`${GHN_API}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json", Token: this.token };
    if (opts.withShop !== false) headers.ShopId = this.shopId;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const why = e instanceof Error && e.name === "TimeoutError" ? `quá ${TIMEOUT_MS / 1000} giây không phản hồi` : `không gọi được (${e instanceof Error ? e.message : String(e)})`;
      return { kind: "UNKNOWN", message: this.scrub(`GHN ${why}`) };
    }
    if (res.status >= 300 && res.status < 400) return { kind: "UNKNOWN", message: `GHN trả chuyển hướng HTTP ${res.status} — không theo.` };
    const text = await res.text().catch(() => "");
    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text) as unknown;
      parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !("code" in parsed)) {
      // 5xx / trang lỗi: hãng có thể đã xử lý rồi mới sập ở đường về — không biết.
      return res.status >= 500 || !parsed ? { kind: "UNKNOWN", message: `GHN trả HTTP ${res.status} không kèm phong bì đọc được.` } : { kind: "REJECTED", message: `GHN trả HTTP ${res.status}.` };
    }
    const envelope: GhnEnvelope = { code: Number(parsed.code) || res.status, message: typeof parsed.message === "string" ? parsed.message : "", data: parsed.data ?? null };
    if (envelope.code === 200) return { kind: "OK", value: envelope };
    if (envelope.code >= 500 || res.status >= 500) return { kind: "UNKNOWN", message: this.scrub(`GHN lỗi máy chủ (${envelope.code}): ${envelope.message}`) };
    // Tài liệu: phần có nghĩa của câu lỗi là đoạn SAU dấu « - » cuối cùng (phần trước là mã nội bộ).
    const reason = envelope.message.includes(" - ") ? envelope.message.slice(envelope.message.lastIndexOf(" - ") + 3) : envelope.message;
    return { kind: "REJECTED", message: this.scrub(reason || `GHN từ chối (mã ${envelope.code}).`) };
  }

  /** Danh sách shop của token (Get Shop) — chỉ đọc; dùng cho «Kiểm tra». */
  shops() {
    return this.send("GET", "v2/shop/all", { query: { offset: 0, limit: 200 }, withShop: false });
  }

  /** Danh mục tỉnh / thành theo địa giới MỚI (2 cấp). */
  provinces() {
    return this.send("GET", "v3/master-data/province/all", { query: { offset: 0, limit: 200 } });
  }

  /** Danh mục xã / phường của một tỉnh (địa giới mới). */
  wards(provinceId: number) {
    return this.send("GET", "v3/master-data/ward/all-by-province-id", { query: { province_id: provinceId, offset: 0, limit: 200 } });
  }

  preview(body: Record<string, unknown>) {
    return this.send("POST", "v2/shipping-order/preview", { body });
  }

  create(body: Record<string, unknown>) {
    return this.send("POST", "v2/shipping-order/create", { body });
  }

  cancel(orderCodes: readonly string[], reason: string) {
    return this.send("POST", "v2/switch-status/cancel", { body: { order_codes: [...orderCodes], reason_code: "GHN-CANCEL-OTHER", reason: reason.slice(0, 500) } });
  }

  printToken(orderCodes: readonly string[]) {
    return this.send("POST", "v2/a5/gen-token", { body: { order_codes: [...orderCodes] } });
  }
}
