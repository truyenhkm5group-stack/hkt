import { and, gte, lte, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { addDays, todayVN } from "@/lib/format";
import { PAGE_USAGE_WINDOW_DAYS, summarizePageUsage, type PageUsageSummary } from "@/lib/constants/page-usage";

/**
 * GHI MỘT LƯỢT MỞ TRANG — một câu UPSERT, cộng dồn trên dòng (ngày, mục). Không ghi ai mở
 * (`lib/constants/page-usage.ts` điều 1). Khoá đã được quy về mục đã khai TRƯỚC khi tới đây.
 */
export async function recordPageVisit(pageKey: string, day: string = todayVN(), db?: Db): Promise<void> {
  const d = db ?? (await getDb());
  const t = schema.pageVisitDaily;
  await d
    .insert(t)
    .values({ day, pageKey, visits: 1 })
    .onConflictDoUpdate({ target: [t.day, t.pageKey], set: { visits: sql`${t.visits} + 1`, lastAt: sql`now()` } });
}

/** Đọc cửa sổ `windowDays` ngày tới `today` và tóm tắt theo đúng danh sách mục của người gọi. */
export async function getPageUsage(keys: readonly string[], opts: { today?: string; windowDays?: number; db?: Db } = {}): Promise<PageUsageSummary> {
  const d = opts.db ?? (await getDb());
  const today = opts.today ?? todayVN();
  const windowDays = opts.windowDays ?? PAGE_USAGE_WINDOW_DAYS;
  const t = schema.pageVisitDaily;
  const start = addDays(today, -(windowDays - 1));
  const [rows, first] = await Promise.all([
    d.select({ day: t.day, key: t.pageKey, visits: t.visits }).from(t).where(and(gte(t.day, start), lte(t.day, today))),
    d.select({ day: sql<string | null>`min(${t.day})` }).from(t),
  ]);
  return summarizePageUsage({ rows, keys, today, windowDays, firstMeasuredDay: first[0]?.day ?? null });
}
