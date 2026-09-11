/**
 * ═══════ SỨC KHOẺ ĐƯỜNG REALTIME SEPAY ═══════
 *
 * Một tích hợp tiền bạc chết âm thầm là chuyện đã xảy ra thật ở kho mã này (tài khoản API Viettel
 * Post không sở hữu vận đơn nhưng mỗi lượt chạy vẫn ghi SUCCESS với "cập nhật 0"). Với sổ ngân hàng
 * hậu quả nặng hơn: webhook ngừng chảy thì sổ vẫn ĐẦY ĐỦ đối với những gì đã nhận, nên nhìn vào
 * không thấy gì bất thường — chỉ là thiếu tiền của những ngày sau đó.
 *
 * Nên bảng này trả lời đúng các câu mà nhìn vào sổ KHÔNG trả lời được:
 * nhận gói tin lần cuối lúc nào · 1 giờ / 24 giờ qua bao nhiêu · bao nhiêu gói bị từ chối xác thực ·
 * bao nhiêu gói xử lý hỏng · tài khoản nào chưa xác nhận · dòng nào đang nghi trùng.
 *
 * CHỈ ĐỌC. Không sinh cảnh báo, không tự sửa — phần đó thuộc về lớp cảnh báo sẵn có.
 */
import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";

const w = schema.webhookEvents;
const b = schema.bankTransactions;
const acc = schema.bankAccounts;

export const SEPAY_SOURCE = "SEPAY";

export type SepayWebhookHealth = {
  /** Gói tin gần nhất ERP nhận được. `null` = CHƯA TỪNG nhận (khác hẳn "đang chạy tốt"). */
  lastReceivedAt: Date | null;
  /** Lần ghi được vào sổ gần nhất — khác hẳn "lần nhận gần nhất". */
  lastProcessedAt: Date | null;
  receivedLastHour: number;
  receivedLast24h: number;
  /** Gói tin đã ghi thành công một dòng mới. */
  processed: number;
  /** Gói tin nói về giao dịch đã có (gửi lại, hoặc sao kê đã nhập trước) — KHÔNG phải lỗi. */
  duplicates: number;
  /** Gói tin không đọc được hoặc ghi sổ hỏng. Đây là số duy nhất trong bảng cần người xử lý ngay. */
  failed: number;
  /** Đã ghi vào sổ nhưng tài khoản ngân hàng chưa ai xác nhận. */
  accountUnmapped: number;
  /** Tổng số lần SePay phải gửi lại (delivery_count > 1) — cao bất thường nghĩa là ERP hay trả lỗi. */
  redelivered: number;
  /** Tài khoản ERP tự khai, chờ người đặt tên. */
  unconfirmedAccounts: { id: string; label: string; gateway: string; accountNumber: string; lastSeenAt: Date | null }[];
  /** Dòng sổ nghi trùng: cùng tài khoản + số tiền + phút nhưng khác mã giao dịch. KHÔNG tự gộp. */
  duplicateSuspects: number;
  /** Giao dịch đã vào sổ qua đường realtime. */
  transactionsFromWebhook: number;
};

/**
 * Số gói tin bị từ chối xác thực KHÔNG nằm trong bảng này, và đó là chủ đích.
 *
 * Gói tin không qua được chữ ký thì route không lưu — ai cũng POST được vào URL công khai thì bảng
 * sự kiện sẽ phình vô hạn. Chúng để lại dòng log `[sepay-webhook] 401 …` tra được bằng `docker logs`.
 * Ghi ra đây để người đọc không tưởng "0 lần từ chối" nghĩa là không ai thử.
 */
export const SEPAY_AUTH_FAILURES_NOTE = "Gói tin sai chữ ký không được lưu vào CSDL (chống phình bảng); xem `docker logs erp-app | grep sepay-webhook`.";

export async function sepayWebhookHealth(): Promise<SepayWebhookHealth> {
  return memo("sepay-webhook-health", 60_000, build);
}

async function build(): Promise<SepayWebhookHealth> {
  const db = await getDb();
  const now = Date.now();
  const hourAgo = new Date(now - 3_600_000);
  const dayAgo = new Date(now - 86_400_000);

  const [counts] = await db
    .select({
      lastReceivedAt: sql<Date | null>`max(${w.receivedAt})`,
      lastProcessedAt: sql<Date | null>`max(${w.processedAt}) filter (where ${w.status} in ('PROCESSED', 'ACCOUNT_UNMAPPED'))`,
      receivedLastHour: sql<number>`count(*) filter (where ${w.receivedAt} >= ${hourAgo})`,
      receivedLast24h: sql<number>`count(*) filter (where ${w.receivedAt} >= ${dayAgo})`,
      processed: sql<number>`count(*) filter (where ${w.status} = 'PROCESSED')`,
      duplicates: sql<number>`count(*) filter (where ${w.status} = 'IGNORED')`,
      failed: sql<number>`count(*) filter (where ${w.status} = 'FAILED')`,
      accountUnmapped: sql<number>`count(*) filter (where ${w.status} = 'ACCOUNT_UNMAPPED')`,
      redelivered: sql<number>`coalesce(sum(${w.deliveryCount} - 1), 0)`,
    })
    .from(w)
    .where(eq(w.source, SEPAY_SOURCE));

  const unconfirmed = await db
    .select({ id: acc.id, label: acc.label, gateway: acc.gateway, accountNumber: acc.accountNumber, lastSeenAt: acc.lastSeenAt })
    .from(acc)
    .where(eq(acc.status, "UNCONFIRMED"))
    .orderBy(desc(acc.lastSeenAt))
    .limit(20);

  // Nghi trùng = khoá lưới an toàn xuất hiện trên NHIỀU hơn một dòng. Đếm số dòng dính, không đếm
  // số khoá: người phải xem từng dòng thì mới quyết được.
  const [suspects] = await db
    .select({ n: sql<number>`coalesce(sum(c), 0)` })
    .from(
      db
        .select({ c: sql<number>`count(*)`.as("c") })
        .from(b)
        .where(sql`${b.matchKey} <> ''`)
        .groupBy(b.matchKey)
        .having(sql`count(*) > 1`)
        .as("g"),
    );

  const [fromWebhook] = await db
    .select({ n: sql<number>`count(*)` })
    .from(b)
    .where(eq(b.provider, SEPAY_SOURCE));

  return {
    lastReceivedAt: counts.lastReceivedAt ? new Date(counts.lastReceivedAt) : null,
    lastProcessedAt: counts.lastProcessedAt ? new Date(counts.lastProcessedAt) : null,
    receivedLastHour: Number(counts.receivedLastHour),
    receivedLast24h: Number(counts.receivedLast24h),
    processed: Number(counts.processed),
    duplicates: Number(counts.duplicates),
    failed: Number(counts.failed),
    accountUnmapped: Number(counts.accountUnmapped),
    redelivered: Number(counts.redelivered),
    unconfirmedAccounts: unconfirmed.map((a) => ({ ...a, lastSeenAt: a.lastSeenAt ? new Date(a.lastSeenAt) : null })),
    duplicateSuspects: Number(suspects?.n ?? 0),
    transactionsFromWebhook: Number(fromWebhook?.n ?? 0),
  };
}
