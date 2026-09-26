export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    public readonly retryable = false,
    public readonly body?: unknown,
    /**
     * LỜI TỪ CHỐI NGHIỆP VỤ CỦA ĐỐI TÁC, tách khỏi mã HTTP.
     *
     * Hai chuyện khác hẳn nhau vẫn hay bị in chung một dòng: "máy chủ trả 400" và "Viettel Post nói
     * vận đơn không thuộc tài khoản này". Cái đầu nói đường truyền, cái sau nói phải làm gì tiếp.
     * Người vận hành cần cái sau; ERP trước đây chỉ hiện cái đầu.
     */
    public readonly carrier?: { status: number | null; message: string; detail?: string },
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

/**
 * ═══════════ LÔI LỜI TỪ CHỐI RA KHỎI PHONG BÌ, DÙ NÓ NẰM Ở TẦNG NÀO ═══════════
 *
 * Bản cũ chỉ đọc `message` ở TẦNG NGOÀI CÙNG. Đối tác nào đặt lý do ở `error_description`, ở
 * `data.message`, hay trong một mảng `errors[]` thì ERP in ra 200 ký tự JSON thô — và người đọc
 * không rút ra được việc phải làm.
 *
 * Trả về chuỗi rỗng khi không tìm thấy gì: KHÔNG bịa ra một câu nghe hợp lý.
 */
export function loiNghiepVu(parsed: unknown, tho: string): { message: string; detail?: string } {
  const chuoi = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
  const r = (parsed ?? {}) as Record<string, unknown>;
  const ungVien: string[] = [];
  for (const k of ["message", "Message", "error_description", "errorMessage", "error_message", "detail", "title", "msg"]) ungVien.push(chuoi(r[k]));
  if (typeof r.error === "string") ungVien.push(chuoi(r.error));
  // Facebook Graph gói lỗi trong ĐỐI TƯỢNG `error{…}`: câu cho người dùng nằm ở `error_user_title` / `error_user_msg`, câu kỹ
  // thuật ở `message`, kèm mã. Thiếu vế này thì ERP in 200 ký tự JSON thô và cắt cụt đúng câu cần đọc (26/09/2026: lỗi
  // "ứng dụng đang ở chế độ phát triển" chỉ còn "Bài viết chứa nội dung quảng c…").
  if (r.error && typeof r.error === "object" && !Array.isArray(r.error)) {
    const eo = r.error as Record<string, unknown>;
    const nguoi = [chuoi(eo.error_user_title), chuoi(eo.error_user_msg)].filter(Boolean).join(" — ");
    const ma = [eo.code, eo.error_subcode].filter((x) => typeof x === "number" || (typeof x === "string" && x !== "")).join("/");
    const cau = nguoi || chuoi(eo.message);
    if (cau) ungVien.push(ma ? `${cau} (mã ${ma})` : cau);
  }
  const data = (r.data ?? {}) as Record<string, unknown>;
  if (data && typeof data === "object" && !Array.isArray(data)) for (const k of ["message", "Message", "error", "detail"]) ungVien.push(chuoi(data[k]));
  const mang = Array.isArray(r.errors) ? r.errors : Array.isArray((r.error as { errors?: unknown[] })?.errors) ? ((r.error as { errors: unknown[] }).errors as unknown[]) : [];
  const chiTiet = mang
    .map((e) => (typeof e === "string" ? e : chuoi((e as Record<string, unknown>)?.message) || chuoi((e as Record<string, unknown>)?.field)))
    .filter(Boolean)
    .join(" · ");
  const message = ungVien.find(Boolean) ?? "";
  return { message: message || chiTiet || tho.slice(0, 200), detail: chiTiet || undefined };
}

/**
 * JSON.parse an toàn với số nguyên lớn: các số >= 16 chữ số được chuyển thành chuỗi
 * (Pancake trả về id > 2^53 cho đơn từ sàn TMĐT).
 */
export function parseJsonSafeInts(text: string): unknown {
  const guarded = text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(guarded);
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type FetchJsonOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  serviceName: string;
  /** trả về true nếu body JSON được coi là lỗi có thể retry */
  isRetryableBody?: (body: unknown) => boolean;
};

/**
 * fetch + parse JSON, retry với backoff cho 429 / 5xx / lỗi mạng.
 */
export async function fetchJson(url: string | URL, options: FetchJsonOptions): Promise<{ body: unknown; status: number; text: string }> {
  const { method = "GET", headers = {}, body, timeoutMs = 60_000, retries = 4, serviceName } = options;
  let attempt = 0;
  let lastError: IntegrationError | null = null;

  while (attempt <= retries) {
    attempt += 1;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "quá thời gian phản hồi" : "không thể kết nối";
      lastError = new IntegrationError(`${serviceName}: ${reason} (${(error as Error)?.message ?? ""})`, 502, true);
      if (attempt <= retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw lastError;
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = parseJsonSafeInts(text);
      } catch {
        parsed = null;
      }
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new IntegrationError(`${serviceName}: API trả về HTTP ${response.status}`, response.status, true, parsed ?? text);
      if (attempt <= retries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      throw lastError;
    }

    if (!response.ok) {
      const loi = loiNghiepVu(parsed, text);
      const maDoiTac = typeof (parsed as { status?: unknown })?.status === "number" ? ((parsed as { status: number }).status) : null;
      throw new IntegrationError(`${serviceName}: HTTP ${response.status} ${loi.message}`.trim(), response.status, false, parsed ?? text, { status: maDoiTac, message: loi.message, detail: loi.detail });
    }

    if (parsed === null && text) {
      throw new IntegrationError(`${serviceName}: phản hồi không phải JSON`, 502, false, text.slice(0, 500));
    }

    if (options.isRetryableBody?.(parsed) && attempt <= retries) {
      await sleep(backoff(attempt));
      continue;
    }

    return { body: parsed, status: response.status, text };
  }

  throw lastError ?? new IntegrationError(`${serviceName}: lỗi không xác định`);
}

function backoff(attempt: number) {
  const base = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  return base + Math.round(Math.random() * 500);
}

// ───────── helpers đọc dữ liệu không tin cậy ─────────

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "bigint") return value.toString();
  }
  return "";
}

export function num(...values: unknown[]): number {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^\d.-]/g, "")) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function int(...values: unknown[]): number {
  const value = num(...values);
  return Math.max(-2_147_483_647, Math.min(2_147_483_647, Math.round(value)));
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.toLowerCase());
  if (typeof value === "number") return value !== 0;
  return fallback;
}

/** Pancake trả về thời gian ISO không múi giờ nhưng là UTC. */
export function pancakeDate(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Viettel Post trả về "dd/MM/yyyy HH:mm:ss" theo giờ Việt Nam. */
export function vtpDate(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const [, d, m, y, hh = "0", mm = "0", ss = "0"] = match;
    const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm}:${ss}+07:00`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (/^\d{12,13}$/.test(raw)) return new Date(Number(raw));
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizePhone(value: string) {
  const digits = value.replace(/[^\d+]/g, "");
  if (digits.startsWith("+84")) return `0${digits.slice(3)}`;
  if (digits.startsWith("84") && digits.length >= 11) return `0${digits.slice(2)}`;
  return digits;
}
