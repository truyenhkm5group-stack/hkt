/**
 * ═══════ API SEPAY — ĐƯỜNG ĐỐI CHIẾU VÀ VÁ GÓI TIN BỊ MẤT ═══════
 *
 * Webhook là đường BIẾT SỚM, không phải đường ĐÁNG TIN NHẤT. SePay chỉ thử lại 7 lần trong 5 giờ;
 * một sự cố dài hơn thế (CSDL bảo trì, ổ đĩa đầy, đổi tên miền) làm mất hẳn những gói tin cuối, và
 * sổ thiếu tiền của đúng khoảng đó mà nhìn vào KHÔNG thấy gì bất thường — vì những gì đã nhận thì
 * vẫn đầy đủ.
 *
 * Đường này quét lại một khoảng ngày rồi cho mọi giao dịch đi qua ĐÚNG cửa ghi của webhook
 * (`ingestSepayTransaction`), nên nó KHÔNG phải hệ thống thứ hai: cùng khoá tự nhiên, cùng ràng
 * buộc chống trùng ở CSDL, cùng mệnh đề `set` hẹp không đụng nhãn người dùng.
 *
 * ─── ĐIỀU PHẢI NÓI THẲNG ───
 *
 * Mã trong tệp này CHƯA từng chạy với API thật: chủ shop chưa tạo `SEPAY_API_TOKEN`. Vì vậy bộ đọc
 * cố ý CHẤP NHẬN NHIỀU DẠNG PHONG BÌ phản hồi và ghi lại dạng thật vào `sync_runs.detail` ngay lần
 * chạy đầu, và thao tác vận hành mặc định CHẠY THỬ (`--dry-run`) — chỉ báo sẽ ghi gì, không ghi.
 * Đọc số liệu lần chạy đầu rồi mới siết lại, đúng hơn là đoán trước rồi tin là đúng.
 */
import { fetchJson, asArray, asRecord, bool, str } from "@/lib/integrations/http";
import { env } from "@/lib/env";
import { sepayDirection, sepayInstant, type SepayTransaction } from "@/lib/integrations/bank/sepay";

/** Tài liệu: developer.sepay.vn/vi/sepay-api/v2 — 3 request/giây/IP, 429 kèm `Retry-After`. */
export const SEPAY_API_RATE_LIMIT_PER_SECOND = 3;

export type SepayApiPage = {
  rows: Record<string, unknown>[];
  /** Còn trang sau không. `null` = phong bì không nói, phải suy từ số dòng trả về. */
  hasMore: boolean | null;
  /** Phong bì thật, cắt ngắn — để lần chạy đầu biết SePay trả về hình dạng gì. */
  shape: string;
};

/**
 * Rút danh sách giao dịch ra khỏi phong bì phản hồi.
 *
 * Cố ý thử nhiều khoá: tài liệu v1 và v2 khác nhau, và một bản nâng cấp của nhà cung cấp không được
 * phép làm ERP im lặng đọc ra 0 giao dịch — đó là cách một đường đối chiếu chết mà không ai biết.
 */
export function extractSepayRows(body: unknown): SepayApiPage {
  const record = asRecord(body);
  const candidates = [record.transactions, record.data, record.items, record.result, body];
  let rows: Record<string, unknown>[] = [];
  for (const c of candidates) {
    const arr = asArray(c);
    if (arr.length) {
      rows = arr.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
      if (rows.length) break;
    }
  }
  const hasMore =
    record.has_more !== undefined ? bool(record.has_more)
    : record.current_page !== undefined && record.last_page !== undefined ? Number(record.current_page) < Number(record.last_page)
    : null;
  const keys = Object.keys(record).slice(0, 12).join(",");
  return { rows, hasMore, shape: `khoá phong bì: [${keys}] · ${rows.length} dòng` };
}

/**
 * Một dòng của API → giao dịch chuẩn hoá, dùng lại ĐÚNG kiểu mà webhook dùng.
 *
 * API v2 trả `amount_in` / `amount_out` tách đôi, khác webhook (`transferType` + `transferAmount`).
 * Chiều tiền vẫn KHÔNG ĐƯỢC ĐOÁN: không suy ra được chiều thì trả lỗi để dòng đó hiện ra trong báo
 * cáo, chứ không im lặng vào sổ sai dấu.
 */
export function mapSepayApiRow(row: Record<string, unknown>): { ok: true; txn: SepayTransaction } | { ok: false; error: string } {
  const providerTxnId = str(row.id, row.transaction_id);
  if (!providerTxnId) return { ok: false, error: "thiếu `id`" };

  const accountNumber = str(row.account_number, row.accountNumber);
  if (!accountNumber) return { ok: false, error: `#${providerTxnId}: thiếu \`account_number\`` };

  const txnAt = sepayInstant(row.transaction_date ?? row.transactionDate);
  if (!txnAt) return { ok: false, error: `#${providerTxnId}: transaction_date không đọc được` };

  const vao = money(row.amount_in);
  const ra = money(row.amount_out);
  let amount = 0;
  if (vao > 0 && ra > 0) return { ok: false, error: `#${providerTxnId}: có CẢ amount_in và amount_out — không kết luận được chiều` };
  if (vao > 0) amount = vao;
  else if (ra > 0) amount = -ra;
  else {
    // Không có cột tách đôi: lùi về dạng của webhook.
    const direction = sepayDirection(row.transfer_type ?? row.transferType);
    const gross = Math.abs(money(row.amount ?? row.transferAmount));
    if (!direction || !gross) return { ok: false, error: `#${providerTxnId}: không suy ra được chiều tiền hoặc số tiền` };
    amount = direction === "out" ? -gross : gross;
  }
  if (!amount) return { ok: false, error: `#${providerTxnId}: số tiền bằng 0` };

  const accumulated = money(row.accumulated);
  return {
    ok: true,
    txn: {
      providerTxnId,
      gateway: str(row.bank_brand_name, row.gateway, row.bank_brand),
      accountNumber,
      subAccount: str(row.va, row.sub_account, row.subAccount),
      referenceCode: str(row.reference_number, row.referenceCode, row.reference_code),
      amount,
      direction: amount > 0 ? "in" : "out",
      txnAt,
      content: str(row.transaction_content, row.content, row.description),
      code: str(row.code, row.payment_code),
      // Cùng luật với webhook: 0 là CHƯA BIẾT (SePay gửi 0 khi không có số dư của MB).
      balanceAfter: accumulated > 0 ? accumulated : null,
    },
  };
}

function money(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;
  const raw = str(value);
  if (!raw) return 0;
  const negative = raw.trim().startsWith("-");
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return 0;
  const n = Number(digits);
  return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

/** `webhook_success = 0` của SePay: chính họ nói gói tin này gửi KHÔNG thành công — đúng chỗ thủng cần vá. */
export function webhookFailedAtProvider(row: Record<string, unknown>): boolean {
  const v = row.webhook_success ?? row.webhookSuccess;
  return v !== undefined && !bool(v);
}

/** Ngày theo giờ Việt Nam, định dạng API SePay nhận. */
export function sepayApiDate(at: Date): string {
  const vn = new Date(at.getTime() + 7 * 3_600_000);
  return vn.toISOString().slice(0, 19).replace("T", " ");
}

export async function fetchSepayTransactionPage(params: { from: Date; to: Date; page: number; perPage: number }): Promise<SepayApiPage> {
  const url = new URL(`${env.sepay.apiBaseUrl}/transactions`);
  url.searchParams.set("transaction_date_min", sepayApiDate(params.from));
  url.searchParams.set("transaction_date_max", sepayApiDate(params.to));
  url.searchParams.set("limit", String(params.perPage));
  url.searchParams.set("per_page", String(params.perPage));
  url.searchParams.set("page", String(params.page));

  const { body } = await fetchJson(url, {
    serviceName: "SePay",
    headers: { Authorization: `Bearer ${env.sepay.apiToken}`, Accept: "application/json" },
    // `fetchJson` đã có backoff cho 429/5xx — đúng thứ API 3 req/s cần.
    retries: 4,
    timeoutMs: 30_000,
  });
  return extractSepayRows(body);
}
