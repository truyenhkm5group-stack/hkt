import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { parseAddonUnits, type AddonUnits } from "@/lib/billing/addons";
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
/** Điều khoản dùng thử của thuê bao (0234). Mọi ô `null` = không dùng thử / dòng cũ / đọc lỗi. */
export type TrialTerms = { trialStartedAt: Date | null; trialEndsAt: Date | null; trialDays: number | null; paidThrough: string | null };
const NO_TRIAL: TrialTerms = { trialStartedAt: null, trialEndsAt: null, trialDays: null, paidThrough: null };
type Entry = { at: number; terms: SubscriptionTerms | null; addons: AddonUnits; trial: TrialTerms };
const holder = globalThis as unknown as { __erpSubscriptions?: Map<string, Entry> };
if (!holder.__erpSubscriptions) holder.__erpSubscriptions = new Map();
const cache = holder.__erpSubscriptions;

export function invalidateSubscriptions(orgCode?: string) {
  if (orgCode) cache.delete(orgCode);
  else cache.clear();
}

async function readEntry(orgCode: string, fresh: boolean): Promise<Entry> {
  const hit = cache.get(orgCode);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit;
  let terms: SubscriptionTerms | null = null;
  let addons: AddonUnits = {};
  let trial: TrialTerms = NO_TRIAL;
  try {
    const pdb = await getPlatformDb();
    const row = await pdb.query.platformSubscriptions.findFirst({ where: eq(schema.platformSubscriptions.orgCode, orgCode) });
    terms = row ? { billingEnabled: row.billingEnabled, paidThrough: row.paidThrough ?? null, graceDays: row.graceDays } : null;
    addons = parseAddonUnits(row?.addons);
    trial = row ? { trialStartedAt: row.trialStartedAt ?? null, trialEndsAt: row.trialEndsAt ?? null, trialDays: row.trialDays ?? null, paidThrough: row.paidThrough ?? null } : NO_TRIAL;
  } catch {
    // Phía an toàn của MỘT LỖI ĐỌC là không khoá: khoá nhầm một khách đã trả tiền tệ hơn để lọt vài phút.
    // Phần mua thêm đọc hỏng ⇒ chỉ còn hạn mức gói (phía hẹp) — lượt tạo bị chặn nói rõ hạn mức, không mất dữ liệu nào.
    terms = null;
    addons = {};
    trial = NO_TRIAL;
  }
  const entry = { at: Date.now(), terms, addons, trial };
  cache.set(orgCode, entry);
  return entry;
}

export async function readSubscriptionTerms(orgCode: string, opts: { fresh?: boolean } = {}): Promise<SubscriptionTerms | null> {
  return (await readEntry(orgCode, !!opts.fresh)).terms;
}

/** Hạn mức đã MUA THÊM của tổ chức (`platform_subscriptions.addons`) — cùng đệm 10 giây với tình trạng thu phí. */
export async function readSubscriptionAddons(orgCode: string, opts: { fresh?: boolean } = {}): Promise<AddonUnits> {
  return (await readEntry(orgCode, !!opts.fresh)).addons;
}

/** Điều khoản dùng thử (0234) — cùng đệm 10 giây. Cổng AI (`lib/pricing/ai-gate.ts`) đọc mốc hết hạn ở đây. */
export async function readTrialTerms(orgCode: string, opts: { fresh?: boolean } = {}): Promise<TrialTerms> {
  return (await readEntry(orgCode, !!opts.fresh)).trial;
}

/** Tình trạng thu phí. Tổ chức nhà luôn `NOT_BILLED`. */
export async function orgBillingStanding(org: { code: string; isHome: boolean }, now: Date = new Date(), opts: { fresh?: boolean } = {}): Promise<BillingStanding> {
  if (org.isHome) return billingStanding(null, vnDate(now));
  return billingStanding(await readSubscriptionTerms(org.code, opts), vnDate(now));
}
