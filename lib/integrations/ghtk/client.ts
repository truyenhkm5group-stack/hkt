import { GHTK_API, GHTK_CARRIER_CONNECTOR, GHTK_LABEL_PATTERN } from "@/lib/constants/carrier-ghtk";
import type { CarrierCall } from "@/lib/carriers/types";
import { assertConnectionOwner } from "@/lib/platform/credentials";

/**
 * ═══════════ CLIENT GIAO HÀNG TIẾT KIỆM (GHTK) CỦA TỔ CHỨC KHÁCH (POS tự chủ) ═══════════
 *
 * Cùng khuôn với client GHN / Viettel Post của tổ chức:
 *  ① chặn bằng `assertConnectionOwner` TRƯỚC mỗi lượt gửi — client của A lọt sang lượt chạy của B thì NÉM;
 *  ② địa chỉ API HẰNG SỐ (`GHTK_API`), không theo chuyển hướng;
 *  ③ KHÔNG tự gửi lại: lỗi giữa chừng trả UNKNOWN (lệnh tạo: GHTK chặn trùng bằng `order.id` và trả mã đơn đã có —
 *    `ORDER_ID_EXIST` + `ghtk_label` — nên người thử lại bằng CÙNG mã nhận đúng đơn cũ, không đẻ đơn thứ hai);
 *  ④ token chỉ đi trong tiêu đề và bị che trong mọi câu lỗi.
 *
 * Phong bì GHTK `{ success, message, error?, … }` (tài liệu «Xử lý mã lỗi»): `success: true` là nhận; `success: false` với
 * HTTP < 500 là TỪ CHỐI (hãng đã trả lời); 5xx / không đọc được là KHÔNG BIẾT. `deps.fetch` để bài kiểm đưa máy chủ giả vào.
 */

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 512 * 1024;
/** Nhãn PDF một đơn cỡ vài chục KB — trần 5 MB chặn phản hồi lạ, không cắt nhãn thật. */
const MAX_PDF_BYTES = 5 * 1024 * 1024;

export class GhtkClient {
  private readonly fetchImpl: FetchLike;

  private constructor(
    private readonly token: string,
    private readonly clientSource: string,
    private readonly orgOwner: string,
    deps: { fetch?: FetchLike },
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  static fromOrgConnection(source: { organization: string; token: string; clientSource: string }, deps: { fetch?: FetchLike } = {}) {
    return new GhtkClient(source.token.trim(), source.clientSource.trim(), source.organization, deps);
  }

  scrub(text: string): string {
    return (this.token && this.token.length >= 6 ? text.split(this.token).join("***") : text).slice(0, 400);
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: json ? "application/json" : "application/pdf, application/json", Token: this.token };
    if (this.clientSource) h["X-Client-Source"] = this.clientSource;
    return h;
  }

  private async raw(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string | number>; pdf?: boolean }): Promise<{ ok: true; res: Response } | { ok: false; call: CarrierCall<never> }> {
    await assertConnectionOwner(GHTK_CARRIER_CONNECTOR, this.orgOwner);
    const url = new URL(`${GHTK_API}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const headers = this.headers(!opts.pdf);
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    try {
      const res = await this.fetchImpl(url.toString(), { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status >= 300 && res.status < 400) return { ok: false, call: { kind: "UNKNOWN", message: `GHTK trả chuyển hướng HTTP ${res.status} — không theo.` } };
      return { ok: true, res };
    } catch (e) {
      const why = e instanceof Error && e.name === "TimeoutError" ? `quá ${TIMEOUT_MS / 1000} giây không phản hồi` : `không gọi được (${e instanceof Error ? e.message : String(e)})`;
      return { ok: false, call: { kind: "UNKNOWN", message: this.scrub(`GHTK ${why}`) } };
    }
  }

  private async send(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string | number>; acceptCodes?: readonly string[] } = {}): Promise<CarrierCall<Record<string, unknown>>> {
    const sent = await this.raw(method, path, opts);
    if (!sent.ok) return sent.call;
    const res = sent.res;
    const text = await res.text().catch(() => "");
    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text) as unknown;
      parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !("success" in parsed)) {
      // 5xx / trang lỗi: hãng có thể đã xử lý rồi mới sập ở đường về — không biết.
      return res.status >= 500 || !parsed ? { kind: "UNKNOWN", message: `GHTK trả HTTP ${res.status} không kèm phong bì đọc được.` } : { kind: "REJECTED", message: `GHTK trả HTTP ${res.status}.` };
    }
    if (parsed.success === true) return { kind: "OK", value: parsed };
    const error = parsed.error && typeof parsed.error === "object" ? (parsed.error as Record<string, unknown>) : {};
    const code = typeof error.code === "string" ? error.code : typeof parsed.error_code === "string" ? parsed.error_code : "";
    // Mã lỗi mà người gọi TỰ đọc tiếp (vd ORDER_ID_EXIST: đơn của chính mã ERP này đã có — không phải từ chối).
    if (code && opts.acceptCodes?.includes(code)) return { kind: "OK", value: parsed };
    const message = typeof parsed.message === "string" && parsed.message ? parsed.message : `GHTK từ chối${code ? ` (${code})` : ""}.`;
    if (res.status >= 500) return { kind: "UNKNOWN", message: this.scrub(`GHTK lỗi máy chủ (HTTP ${res.status}): ${message}`) };
    return { kind: "REJECTED", message: this.scrub(message) };
  }

  /** Danh sách kho lấy hàng của shop — chỉ đọc; dùng cho «Kiểm tra». */
  pickAddresses() {
    return this.send("GET", "services/shipment/list_pick_add");
  }

  fee(query: Record<string, string | number>) {
    return this.send("GET", "services/shipment/fee", { query });
  }

  create(body: Record<string, unknown>) {
    return this.send("POST", "services/shipment/order/", { body, query: { ver: "1.5" }, acceptCodes: ["ORDER_ID_EXIST"] });
  }

  /** Huỷ theo mã GHTK (tài liệu: POST /services/shipment/cancel/{mã}). */
  cancel(label: string) {
    if (!GHTK_LABEL_PATTERN.test(label)) return Promise.resolve<CarrierCall<Record<string, unknown>>>({ kind: "REJECTED", message: "Mã GHTK không hợp lệ." });
    return this.send("POST", `services/shipment/cancel/${encodeURIComponent(label)}`);
  }

  /** Nhãn PDF MỘT đơn (tài liệu In nhãn: trả tệp PDF nhị phân; lỗi trả JSON). */
  async label(code: string, opts: { pageSize: "A5" | "A6" } = { pageSize: "A6" }): Promise<CarrierCall<Uint8Array>> {
    if (!GHTK_LABEL_PATTERN.test(code)) return { kind: "REJECTED", message: "Mã GHTK không hợp lệ." };
    const sent = await this.raw("GET", `services/label/${encodeURIComponent(code)}`, { query: { original: "portrait", page_size: opts.pageSize }, pdf: true });
    if (!sent.ok) return sent.call;
    const res = sent.res;
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && type.includes("pdf")) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_PDF_BYTES) return { kind: "REJECTED", message: "GHTK trả nhãn quá lớn — không chuyển tiếp." };
      return buf.byteLength > 0 ? { kind: "OK", value: buf } : { kind: "UNKNOWN", message: "GHTK trả nhãn rỗng." };
    }
    const text = await res.text().catch(() => "");
    let message = `GHTK không trả nhãn (HTTP ${res.status}).`;
    try {
      const v = JSON.parse(text.slice(0, MAX_BODY_BYTES)) as { message?: unknown };
      if (typeof v?.message === "string" && v.message) message = v.message;
    } catch {
      /* giữ câu mặc định */
    }
    return res.status >= 500 ? { kind: "UNKNOWN", message: this.scrub(message) } : { kind: "REJECTED", message: this.scrub(message) };
  }
}
