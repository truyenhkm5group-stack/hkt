import { VTP_CANCEL_TYPE, VTP_CARRIER_CONNECTOR, VTP_PARTNER_API, VTP_PRINT_TTL_MS } from "@/lib/constants/carrier-vtp";
import { assertConnectionOwner } from "@/lib/platform/credentials";

/**
 * ═══════════ CLIENT VIETTEL POST CỦA TỔ CHỨC KHÁCH — TẠO / HUỶ / IN VẬN ĐƠN (POS tự chủ) ═══════════
 *
 * Khác client của nhà (`client.ts` — biến môi trường, chặn bằng `assertHomeCredentials`) ở năm điểm:
 *  ① chặn bằng `assertConnectionOwner` (chủ của tài khoản) TRƯỚC khi một byte rời máy — client của A lọt sang lượt chạy của
 *    B thì NÉM;
 *  ② địa chỉ API là HẰNG SỐ (`VTP_PARTNER_API`), không theo chuyển hướng (`redirect: "manual"`);
 *  ③ KHÔNG GIỮ TOKEN ở đâu cả — không trong instance, không trong `integration_tokens`. Mỗi lượt gọi đăng nhập lại; mỗi lượt
 *    bấm của người chỉ gọi hãng một lần, nên không có gì để tiết kiệm, và không có credential nào sống lâu hơn lượt bấm;
 *  ④ KHÔNG TỰ GỬI LẠI. `fetchJson` thử lại khi 5xx / đứt mạng — với lệnh TẠO ĐƠN đó là cách đẻ hai vận đơn cho một lần
 *    gửi. Lỗi giữa chừng trả `kind: "UNKNOWN"` để lõi giữ chỗ và để người kiểm tra;
 *  ⑤ mọi câu lỗi đã che mật khẩu / token.
 *
 * Đọc phong bì `{status, error, message, data}` — Viettel Post từ chối bằng HTTP 200 + `error: true` (AGENTS.md mục 5).
 * `deps.fetch` để bài kiểm đưa vào máy chủ giả: bộ kiểm thử không gọi mạng thật (luật 65).
 */

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type VtpCarrierDeps = { fetch?: FetchLike };

const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 256 * 1024;

export type VtpEnvelope = { status: number; error: boolean; message: string; data: unknown };

/**
 * Kết quả một lượt gọi:
 *  · OK — hãng nhận;
 *  · REJECTED — hãng TRẢ LỜI và từ chối (chắc chắn không có gì được tạo / đổi);
 *  · UNKNOWN — không có câu trả lời đọc được (mạng, quá giờ, 5xx, chuyển hướng): KHÔNG BIẾT hãng đã làm hay chưa.
 */
export type VtpCallResult = { kind: "OK"; envelope: VtpEnvelope } | { kind: "REJECTED"; message: string; envelope: VtpEnvelope | null } | { kind: "UNKNOWN"; message: string };

export type VtpCarrierCredentials = { username: string; password: string };

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export class VtpCarrierClient {
  private readonly fetchImpl: FetchLike;

  private constructor(
    private readonly creds: VtpCarrierCredentials,
    private readonly orgOwner: string,
    deps: VtpCarrierDeps,
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  /** Client từ kết nối «viettelpost-carrier» ĐANG BẬT của tổ chức `organization` (lib/carriers/vtp-shipments.ts mở kết nối). */
  static fromOrgConnection(source: { organization: string; username: string; password: string }, deps: VtpCarrierDeps = {}) {
    return new VtpCarrierClient({ username: source.username.trim(), password: source.password }, source.organization, deps);
  }

  /** Che mật khẩu và token đang dùng trong một câu sắp in ra. */
  scrub(text: string, token: string | null = null): string {
    let out = text;
    for (const secret of [this.creds.password, token ?? ""]) if (secret && secret.length >= 4) out = out.split(secret).join("***");
    return out.slice(0, 400);
  }

  private async post(path: string, body: unknown, token: string | null): Promise<VtpCallResult> {
    await assertConnectionOwner(VTP_CARRIER_CONNECTOR, this.orgOwner);
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (token) headers.Token = token;
    let res: Response;
    try {
      res = await this.fetchImpl(`${VTP_PARTNER_API}/${path}`, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const why = e instanceof Error && e.name === "TimeoutError" ? `quá ${TIMEOUT_MS / 1000} giây không phản hồi` : `không gọi được (${e instanceof Error ? e.message : String(e)})`;
      return { kind: "UNKNOWN", message: this.scrub(`Viettel Post ${why}`, token) };
    }
    if (res.status >= 300 && res.status < 400) return { kind: "UNKNOWN", message: `Viettel Post trả chuyển hướng HTTP ${res.status} — không theo.` };
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text);
    } catch {
      parsed = null;
    }
    const r = rec(parsed);
    if (!parsed || (!("error" in r) && !("status" in r))) {
      // 5xx / trang lỗi HTML: hãng có thể đã xử lý rồi mới sập ở đường về — không biết.
      return res.status >= 500 || !parsed ? { kind: "UNKNOWN", message: `Viettel Post trả HTTP ${res.status} không kèm phong bì đọc được.` } : { kind: "REJECTED", message: `Viettel Post trả HTTP ${res.status}.`, envelope: null };
    }
    const envelope: VtpEnvelope = {
      status: typeof r.status === "number" ? r.status : Number(r.status) || res.status,
      error: r.error === true,
      message: typeof r.message === "string" ? r.message.trim() : "",
      data: "data" in r ? r.data : null,
    };
    if (envelope.error) return { kind: "REJECTED", message: this.scrub(envelope.message || `Viettel Post từ chối (mã ${envelope.status}).`, token), envelope };
    return { kind: "OK", envelope };
  }

  /** Login (token ngắn hạn) → ownerconnect (token dài hạn) — đúng hai bước tài liệu «Lấy token tài khoản». */
  async login(): Promise<{ ok: true; token: string } | { ok: false; kind: "REJECTED" | "UNKNOWN"; message: string }> {
    const body = { USERNAME: this.creds.username, PASSWORD: this.creds.password };
    const first = await this.post("user/Login", body, null);
    if (first.kind !== "OK") return { ok: false, kind: first.kind, message: `Đăng nhập Viettel Post: ${first.message}` };
    const shortToken = typeof rec(first.envelope.data).token === "string" ? String(rec(first.envelope.data).token) : "";
    if (!shortToken) return { ok: false, kind: "REJECTED", message: "Đăng nhập Viettel Post: phản hồi không có token." };
    const owner = await this.post("user/ownerconnect", body, shortToken);
    // ownerconnect không trả token dài hạn ⇒ dùng token ngắn hạn cho lượt này (đủ cho một lần bấm).
    const longToken = owner.kind === "OK" && typeof rec(owner.envelope.data).token === "string" ? String(rec(owner.envelope.data).token) : "";
    return { ok: true, token: longToken || shortToken };
  }

  /** Gọi một API cần token. Lỗi đăng nhập giữ nguyên loại (REJECTED / UNKNOWN). */
  async call(path: string, body: unknown): Promise<VtpCallResult> {
    const auth = await this.login();
    if (!auth.ok) return auth.kind === "UNKNOWN" ? { kind: "UNKNOWN", message: auth.message } : { kind: "REJECTED", message: auth.message, envelope: null };
    return this.post(path, body, auth.token);
  }

  /** Kho lấy hàng của tài khoản (`user/listInventory`) — chỉ đọc; dùng cho «Kiểm tra». */
  async listInventory(): Promise<VtpCallResult> {
    const auth = await this.login();
    if (!auth.ok) return auth.kind === "UNKNOWN" ? { kind: "UNKNOWN", message: auth.message } : { kind: "REJECTED", message: auth.message, envelope: null };
    await assertConnectionOwner(VTP_CARRIER_CONNECTOR, this.orgOwner);
    try {
      const res = await this.fetchImpl(`${VTP_PARTNER_API}/user/listInventory`, { method: "GET", headers: { accept: "application/json", Token: auth.token }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const parsed = rec(JSON.parse((await res.text()).slice(0, MAX_BODY_BYTES)));
      const envelope: VtpEnvelope = { status: Number(parsed.status) || res.status, error: parsed.error === true, message: String(parsed.message ?? ""), data: parsed.data ?? null };
      return envelope.error ? { kind: "REJECTED", message: this.scrub(envelope.message, auth.token), envelope } : { kind: "OK", envelope };
    } catch (e) {
      return { kind: "UNKNOWN", message: this.scrub(`Không đọc được danh sách kho: ${e instanceof Error ? e.message : String(e)}`, auth.token) };
    }
  }

  quote(body: Record<string, unknown>) {
    return this.call("order/getPriceAllNlp", body);
  }

  create(body: Record<string, unknown>) {
    return this.call("order/createOrderNlp", body);
  }

  cancel(orderNumber: string, note: string) {
    return this.call("order/UpdateOrder", { TYPE: VTP_CANCEL_TYPE, ORDER_NUMBER: orderNumber, NOTE: note.slice(0, 150) });
  }

  /** Mã in cho tối đa 100 vận đơn; mã nằm ở `message` (tài liệu «Lấy link in vận đơn»). */
  printingCode(orderNumbers: readonly string[], now = Date.now()) {
    return this.call("order/printing-code", { EXPIRY_TIME: now + VTP_PRINT_TTL_MS, ORDER_ARRAY: orderNumbers.slice(0, 100) });
  }
}
