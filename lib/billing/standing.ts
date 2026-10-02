import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { billingStanding, vnDate, type BillingStanding, type SubscriptionTerms } from "@/lib/billing/rules";

/**
 * ĐỌC TÌNH TRẠNG THU PHÍ CỦA MỘT TỔ CHỨC — đường đọc DUY NHẤT mà cổng chỉ-xem (`resolveCurrentUser`) và `runJob` dùng.
 *
 * Cố ý không import gì của phiên đăng nhập: `lib/auth/session.ts` import tệp này, vòng ngược lại là vòng import.
 *
 * Đọc ở mọi lượt GHI của tổ chức khách nên có đệm 10 giây trong tiến trình — cùng trần với sổ tổ chức: tiền vừa về thì
 * tiến trình khác mở khoá trễ tối đa 10 giây; cùng tiến trình thì lượt ghi gọi `invalidateSubscriptions()` nên có hiệu
 * lực ngay. Bảng chưa có (máy chưa migrate) ⇒ coi như chưa thu phí: không bao giờ khoá vì một lỗi đọc sổ.
 */

const TTL_MS = 10_000;
type Entry = { at: number; terms: SubscriptionTerms | null };
const holder = globalThis as unknown as { __erpSubscriptions?: Map<string, Entry> };
if (!holder.__erpSubscriptions) holder.__erpSubscriptions = new Map();
const cache = holder.__erpSubscriptions;

export function invalidateSubscriptions(orgCode?: string) {
  if (orgCode) cache.delete(orgCode);
  else cache.clear();
}

export async function readSubscriptionTerms(orgCode: string, opts: { fresh?: boolean } = {}): Promise<SubscriptionTerms | null> {
  const hit = cache.get(orgCode);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.terms;
  let terms: SubscriptionTerms | null = null;
  try {
    const pdb = await getPlatformDb();
    const row = await pdb.query.platformSubscriptions.findFirst({ where: eq(schema.platformSubscriptions.orgCode, orgCode) });
    terms = row ? { billingEnabled: row.billingEnabled, paidThrough: row.paidThrough ?? null, graceDays: row.graceDays } : null;
  } catch {
    // Phía an toàn của MỘT LỖI ĐỌC là không khoá: khoá nhầm một khách đã trả tiền tệ hơn để lọt vài phút.
    terms = null;
  }
  cache.set(orgCode, { at: Date.now(), terms });
  return terms;
}

/** Tình trạng thu phí. Tổ chức nhà luôn `NOT_BILLED`. */
export async function orgBillingStanding(org: { code: string; isHome: boolean }, now: Date = new Date(), opts: { fresh?: boolean } = {}): Promise<BillingStanding> {
  if (org.isHome) return billingStanding(null, vnDate(now));
  return billingStanding(await readSubscriptionTerms(org.code, opts), vnDate(now));
}
