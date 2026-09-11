/**
 * ═══════════ GÓI TIN WEBHOOK SEPAY → GIAO DỊCH NGÂN HÀNG ═══════════
 *
 * Tệp này KHÔNG chạm cơ sở dữ liệu: chỉ đọc, xác thực và chuẩn hoá. Nhờ vậy mọi cái bẫy thật của
 * một webhook tiền bạc đều kiểm thử được mà không cần dựng CSDL.
 *
 * Tài liệu: https://docs.sepay.vn/tich-hop-webhooks.html
 *           https://developer.sepay.vn/en/sepay-webhooks/xac-thuc
 *
 * ─── BA ĐIỀU KHÔNG ĐƯỢC ĐOÁN ───
 *
 *  1. CHIỀU TIỀN. `transferAmount` của SePay luôn DƯƠNG; chiều nằm ở `transferType`. Đoán sai chiều
 *     là sai dấu cả dòng tiền — 10 triệu vào thành 10 triệu ra, lệch 20 triệu. Nên gặp giá trị lạ
 *     thì TỪ CHỐI gói tin, không đoán.
 *  2. MÚI GIỜ. `transactionDate` là "2024-07-02 11:08:33" — giờ VIỆT NAM, không có hậu tố múi giờ.
 *     `new Date("2024-07-02 11:08:33")` đọc theo giờ MÁY CHỦ; máy chủ chạy UTC thì mọi giao dịch
 *     lệch 7 tiếng và giao dịch buổi tối nhảy sang ngày hôm sau.
 *  3. CHỮ KÝ. HMAC ký trên BYTE GỐC của body. `JSON.stringify` lại đối tượng đã parse sẽ đổi thứ tự
 *     khoá và khoảng trắng ⇒ chữ ký luôn sai, và ai nhìn cũng tưởng SePay cấu hình hỏng.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Tên header SePay gửi kèm mỗi gói tin khi bật HMAC-SHA256. */
export const SEPAY_SIGNATURE_HEADER = "x-sepay-signature";
export const SEPAY_TIMESTAMP_HEADER = "x-sepay-timestamp";

/** Cửa sổ chống phát lại: tài liệu SePay yêu cầu từ chối lệch quá 5 phút. */
export const SEPAY_REPLAY_WINDOW_SECONDS = 300;

export type SepayAuthResult =
  | { ok: true; method: "HMAC" | "APIKEY" }
  | { ok: false; reason: string };

/**
 * So sánh hằng thời gian, an toàn với chuỗi khác độ dài.
 *
 * `timingSafeEqual` NÉM LỖI khi hai buffer khác độ dài, nên gọi thẳng vừa làm sập route vừa rò rỉ
 * độ dài chữ ký đúng. Băm cả hai bên trước rồi mới so: hai bản băm luôn dài bằng nhau.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function sepaySignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/**
 * Xác thực gói tin.
 *
 * HMAC là đường chính. `Authorization: Apikey …` chỉ được chấp nhận khi CHƯA khai secret HMAC —
 * nó chứng minh nguồn gửi nhưng KHÔNG phát hiện nội dung bị sửa, nên đã có HMAC thì không cho phép
 * hạ cấp xuống API key (nếu không, kẻ tấn công biết API key sẽ tự chọn đường yếu hơn).
 */
export function verifySepayRequest(input: {
  secret: string;
  apiKey: string;
  signature: string | null;
  timestamp: string | null;
  authorization: string | null;
  rawBody: string;
  now?: Date;
}): SepayAuthResult {
  const { secret, apiKey, signature, timestamp, authorization, rawBody } = input;
  const now = input.now ?? new Date();

  if (secret) {
    if (!signature || !timestamp) return { ok: false, reason: "Thiếu chữ ký hoặc mốc thời gian" };
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: "Mốc thời gian không hợp lệ" };
    const drift = Math.abs(Math.floor(now.getTime() / 1000) - seconds);
    if (drift > SEPAY_REPLAY_WINDOW_SECONDS) return { ok: false, reason: `Mốc thời gian lệch ${drift}s, quá ${SEPAY_REPLAY_WINDOW_SECONDS}s` };
    if (!safeEqual(sepaySignature(secret, timestamp, rawBody), signature.trim())) return { ok: false, reason: "Chữ ký không khớp" };
    return { ok: true, method: "HMAC" };
  }

  if (apiKey) {
    const sent = (authorization ?? "").replace(/^Apikey\s+/i, "").trim();
    if (!sent || !safeEqual(apiKey, sent)) return { ok: false, reason: "API key không khớp" };
    return { ok: true, method: "APIKEY" };
  }

  return { ok: false, reason: "Chưa cấu hình SEPAY_WEBHOOK_SECRET" };
}

// ───────────────────────── Đọc gói tin ─────────────────────────

/** Giao dịch SePay đã chuẩn hoá — tất cả các trường ERP cần, không hơn. */
export type SepayTransaction = {
  /** `id` của SePay — danh tính GIAO HÀNG, dùng làm khoá chống trùng ở tầng CSDL. */
  providerTxnId: string;
  /** Tên ngân hàng do SePay đặt (MBBank, Vietcombank…). Không hard-code ngân hàng nào. */
  gateway: string;
  accountNumber: string;
  /** Tài khoản ảo (VA) — '' nếu tiền vào thẳng tài khoản gốc. */
  subAccount: string;
  /** Mã giao dịch CỦA NGÂN HÀNG — cầu nối với sao kê tải tay. Có thể rỗng. */
  referenceCode: string;
  /** DƯƠNG = tiền vào, ÂM = tiền ra. Đã áp `transferType`. */
  amount: number;
  direction: "in" | "out";
  txnAt: Date;
  /** Nội dung giao dịch (`content`), lùi về `description` nếu rỗng. */
  content: string;
  /** Mã thanh toán SePay bóc từ nội dung (dùng để ghép đơn hàng sau này). */
  code: string;
  /** Số dư luỹ kế sau giao dịch. `null` = SePay không gửi ⇒ CHƯA BIẾT, không phải 0. */
  balanceAfter: number | null;
};

export type SepayParseResult = { ok: true; txn: SepayTransaction } | { ok: false; error: string };

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return "";
}

/** Tiền: SePay gửi số, nhưng vẫn có thể là chuỗi "5000000" hay "5,000,000". `null` khi không có. */
function money(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  const raw = text(value);
  if (!raw) return null;
  const negative = raw.startsWith("-");
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/**
 * "2024-07-02 11:08:33" là GIỜ VIỆT NAM. Gắn +07:00 trước khi cho `Date` đọc, nếu không máy chủ
 * chạy UTC sẽ hiểu thành 11:08 UTC = 18:08 giờ Việt Nam và giao dịch buổi tối nhảy sang ngày sau.
 * Chuỗi nào đã tự mang múi giờ (có `Z` hoặc `+07:00`) thì tôn trọng nguyên bản.
 */
export function sepayInstant(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const normalized = hasZone ? raw.replace(" ", "T") : `${raw.replace(" ", "T")}+07:00`;
  const at = new Date(normalized);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Chuẩn hoá mã giao dịch ngân hàng để ba đường vào (sao kê · webhook · API) hội tụ về MỘT dòng.
 *
 * Lệch một dấu cách hay một chữ hoa là ra hai dòng canonical, và không ai nhìn ra bằng mắt. Giữ
 * lại chữ, số và dấu gạch — mã bút toán MB có dạng `FT26217021601512`, mã trả lãi có dạng
 * `9972165264-20260815`.
 */
export function normalizeBankRef(value: unknown): string {
  return text(value).toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

/** Chiều tiền. KHÔNG đoán: giá trị lạ trả `null` để gói tin bị từ chối chứ không vào sổ sai dấu. */
export function sepayDirection(value: unknown): "in" | "out" | null {
  const raw = text(value).toLowerCase();
  if (["in", "vao", "credit", "c"].includes(raw)) return "in";
  if (["out", "ra", "debit", "d"].includes(raw)) return "out";
  return null;
}

export function parseSepayPayload(payload: unknown): SepayParseResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "Gói tin không phải đối tượng JSON" };
  const p = payload as Record<string, unknown>;

  const providerTxnId = text(p.id);
  if (!providerTxnId) return { ok: false, error: "Thiếu `id` — không có danh tính thì không chống trùng được" };

  const direction = sepayDirection(p.transferType);
  if (!direction) return { ok: false, error: `transferType không hợp lệ: ${JSON.stringify(p.transferType)}` };

  const gross = money(p.transferAmount);
  if (gross === null) return { ok: false, error: "Thiếu `transferAmount`" };
  // SePay luôn gửi số dương; nếu có bản nào gửi số âm thì `transferType` vẫn là nguồn sự thật về chiều.
  const magnitude = Math.abs(gross);
  if (!magnitude) return { ok: false, error: "Số tiền bằng 0 — không phải giao dịch" };

  const txnAt = sepayInstant(p.transactionDate);
  if (!txnAt) return { ok: false, error: `transactionDate không đọc được: ${JSON.stringify(p.transactionDate)}` };

  const accountNumber = text(p.accountNumber);
  if (!accountNumber) return { ok: false, error: "Thiếu `accountNumber` — không biết tiền ở tài khoản nào" };

  return {
    ok: true,
    txn: {
      providerTxnId,
      gateway: text(p.gateway),
      accountNumber,
      subAccount: text(p.subAccount),
      referenceCode: text(p.referenceCode),
      amount: direction === "out" ? -magnitude : magnitude,
      direction,
      txnAt,
      content: text(p.content) || text(p.description),
      code: text(p.code),
      balanceAfter: money(p.accumulated),
    },
  };
}

/**
 * KHOÁ CANONICAL của giao dịch trong sổ ERP.
 *
 * Ưu tiên mã của NGÂN HÀNG: đó là thứ sao kê tải tay cũng có, nên webhook và file tự hội tụ về một
 * dòng mà không cần bảng ánh xạ nào. Không có mã ngân hàng thì lùi về mã SePay — vẫn tất định, nên
 * gửi lại bao nhiêu lần cũng ra đúng một khoá.
 */
export function sepayBankRef(txn: Pick<SepayTransaction, "referenceCode" | "providerTxnId">): string {
  const ref = normalizeBankRef(txn.referenceCode);
  return ref || `SEPAY:${txn.providerTxnId}`;
}

/**
 * LƯỚI AN TOÀN để PHÁT HIỆN trùng, KHÔNG phải để gộp.
 *
 * CỐ Ý KHÔNG có số tài khoản trong khoá, dù chính nó là thứ phân biệt hai giao dịch. Lý do: sao kê
 * tải tay KHÔNG nói tài khoản nào (người nhập tự biết), nên đưa tài khoản vào khoá là khiến dòng
 * nhập từ file và dòng từ webhook KHÔNG BAO GIỜ khớp nhau — đúng cặp mà lưới này sinh ra để canh.
 * Số tài khoản vẫn nằm ở cột `account` để người đối chiếu nhìn thấy khi xem lại.
 *
 * CỐ Ý thô (làm tròn xuống phút): hai nguồn ghi lệch vài giây vẫn cùng khoá.
 * CỐ Ý KHÔNG unique: hai lần chuyển cùng số tiền cho cùng một người trong cùng một phút là giao
 * dịch thật — gộp lại là xoá tiền. Khoá này chỉ thu hẹp danh sách để NGƯỜI quyết định.
 */
export function bankMatchKey(input: { amount: number; txnAt: Date }): string {
  return `${input.amount}|${Math.floor(input.txnAt.getTime() / 60_000)}`;
}
