import { desc } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { isUndefinedTableError } from "@/lib/constants/fb-crm";
import type { AiStatus, DailyFacts } from "@/lib/constants/daily-report";

/**
 * Đọc các bản báo cáo ngày ĐÃ LƯU của tổ chức đang đăng nhập (CSDL tổ chức). Bản là ảnh chụp bất biến: màn hình đọc `facts` đã lưu,
 * KHÔNG tính lại (luật 21). `unavailable = true` ⇒ CSDL chưa áp 0266 (serve-compat) — trang nói thẳng, không in «chưa có bản nào».
 */
export type DailyReportRow = {
  id: string;
  reportDate: string;
  facts: DailyFacts;
  summary: string | null;
  highlights: string[];
  aiStatus: AiStatus;
  aiNote: string;
  blockedNumbers: string[];
  model: string | null;
  costUsd: number | null;
  createdAt: Date;
};

export const DAILY_REPORT_LIST_MAX = 60;

export async function listDailyReports(): Promise<{ rows: DailyReportRow[]; unavailable: boolean }> {
  const db = await getDb();
  const r = schema.dailyReports;
  try {
    const rows = await db.select().from(r).orderBy(desc(r.reportDate)).limit(DAILY_REPORT_LIST_MAX);
    return {
      unavailable: false,
      rows: rows.map((x) => ({
        id: x.id,
        reportDate: x.reportDate,
        facts: x.facts as unknown as DailyFacts,
        summary: x.summary,
        highlights: x.highlights ?? [],
        aiStatus: x.aiStatus as AiStatus,
        aiNote: x.aiNote,
        blockedNumbers: x.blockedNumbers ?? [],
        model: x.model,
        costUsd: x.costUsd,
        createdAt: x.createdAt,
      })),
    };
  } catch (e) {
    if (isUndefinedTableError(e)) return { rows: [], unavailable: true };
    throw e;
  }
}
