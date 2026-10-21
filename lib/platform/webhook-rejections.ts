import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";

/**
 * ═══════════ SỔ GÓI WEBHOOK BỊ TỪ CHỐI (0251 · M4 mục 4, 21/10/2026) — CSDL NHÀ, CHỈ MÁY CHỦ ═══════════
 *
 * Webhook Meta là MỘT URL cho mọi tổ chức. Chữ ký sai, thân không phải JSON, không tra được page, page lạ… là chuyện MỨC NỀN TẢNG
 * (chưa biết tổ chức nào) — trước bản này chỉ ra stdout, nên «chữ ký sai hàng loạt» (app secret lệch sau một lần xoay khoá) không
 * ai đọc được ở /platform. Gương `platform_org_health` là THEO TỔ CHỨC và đếm lại bằng job của từng tổ chức — ghi dưới mã nhà thì
 * không ai đo lại, số 24 giờ cộng mãi (luật 42). Nên sổ riêng, append-only:
 *  · MỘT dòng mỗi (nguồn, lý do, PHÚT) — gói dồn dập cộng vào `count`, không đẻ thêm dòng (chống bão);
 *  · 24 giờ / 7 ngày tính LÚC ĐỌC từ các xô phút — không có số nào «trôi» phải đặt lại;
 *  · KHÔNG mã page, KHÔNG PSID, KHÔNG nội dung — chỉ nguồn + mã lý do + số đếm;
 *  · giữ {@link WEBHOOK_REJECTION_RETENTION_DAYS} ngày: chưa có job dọn chung cho sổ nền tảng, nên lượt ghi tự xoá xô quá hạn
 *    (chỉ chạm đúng xô cũ của nguồn đó — chỉ mục `bucket`).
 * Đường ghi KHÔNG BAO GIỜ ném và không chạy trong giao dịch của webhook: sổ hỏng không được làm webhook trả lỗi.
 */

export const WEBHOOK_REJECTION_PROVIDERS = ["MESSENGER"] as const;
export type WebhookRejectionProvider = (typeof WEBHOOK_REJECTION_PROVIDERS)[number];
export const WEBHOOK_REJECTION_RETENTION_DAYS = 30;
const REASON_RE = /^[A-Z][A-Z0-9_]{1,40}$/;
const DAY_MS = 86_400_000;

/** Đầu phút của `at` — khoá xô. HÀM THUẦN. */
export function rejectionBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

function isMissingTable(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "42P01";
}

/**
 * Cộng MỘT gói bị từ chối vào xô phút. `true` = đã ghi; `false` = đầu vào lạ hoặc ghi hỏng (đã in một dòng log, không dữ liệu
 * khách). KHÔNG BAO GIỜ ném.
 */
export async function noteWebhookRejection(provider: WebhookRejectionProvider, reason: string, at: Date = new Date(), n = 1): Promise<boolean> {
  if (!(WEBHOOK_REJECTION_PROVIDERS as readonly string[]).includes(provider) || !REASON_RE.test(reason) || !Number.isInteger(n) || n < 1) return false;
  try {
    const pdb = await getPlatformDb();
    const t = schema.platformWebhookRejections;
    await pdb
      .insert(t)
      .values({ provider, reason, bucket: rejectionBucket(at), count: n, lastAt: at })
      .onConflictDoUpdate({ target: [t.provider, t.reason, t.bucket], set: { count: sql`${t.count} + ${n}`, lastAt: sql`greatest(${t.lastAt}, excluded.last_at)` } });
    await pdb.delete(t).where(and(eq(t.provider, provider), lt(t.bucket, new Date(at.getTime() - WEBHOOK_REJECTION_RETENTION_DAYS * DAY_MS))));
    return true;
  } catch (error) {
    if (!isMissingTable(error)) console.error(`[webhook-rejections] ghi ${provider}/${reason} hỏng: ${error instanceof Error ? error.message.slice(0, 200) : "lỗi lạ"}`);
    return false;
  }
}

export type WebhookRejectionRow = { reason: string; count24h: number; count7d: number; lastAt: string };

/**
 * Gói bị từ chối của `provider`: mỗi lý do có trong 7 ngày ⇒ số 24 giờ · 7 ngày · lần cuối, nặng nhất trước. `null` = CHƯA ĐO
 * được (bảng chưa có / đọc hỏng) — khác hẳn `[]` (đo được, không gói nào bị từ chối).
 */
export async function webhookRejectionSummary(provider: WebhookRejectionProvider, now: Date = new Date()): Promise<WebhookRejectionRow[] | null> {
  try {
    const pdb = await getPlatformDb();
    const t = schema.platformWebhookRejections;
    const since24 = new Date(now.getTime() - DAY_MS);
    const rows = await pdb
      .select({
        reason: t.reason,
        count24h: sql<number>`coalesce(sum(${t.count}) filter (where ${t.bucket} >= ${since24.toISOString()}::timestamptz), 0)::int`,
        count7d: sql<number>`sum(${t.count})::int`,
        lastAt: sql<string>`max(${t.lastAt})`,
      })
      .from(t)
      .where(and(eq(t.provider, provider), gte(t.bucket, new Date(now.getTime() - 7 * DAY_MS))))
      .groupBy(t.reason);
    return rows
      .map((r) => ({ reason: r.reason, count24h: Number(r.count24h), count7d: Number(r.count7d), lastAt: new Date(r.lastAt).toISOString() }))
      .sort((a, b) => b.count24h - a.count24h || b.count7d - a.count7d || a.reason.localeCompare(b.reason));
  } catch {
    return null;
  }
}
