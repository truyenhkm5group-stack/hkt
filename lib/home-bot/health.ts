/**
 * Sức khoẻ bot nhà — phần CHẠM CSDL (luật ở lib/constants/home-bot-health.ts). CHỈ MÁY CHỦ.
 *
 * Trạng thái ở MỘT khoá settings của tổ chức NHÀ (`home-bot.health`). Ghi bằng setSettingJson, KHÔNG qua audit(): audit() xoá đệm
 * (clearMemo) của tổ chức — một nhịp 5′ mà đi qua đó là /reports/returns, /work… về nguội liên tục (lỗi #1036). Vết của sự cố là chính
 * dòng platform_operator_alerts mà notifyPlatformOperator ghi (một tin mỗi sự cố, một tin hồi phục). Chỉ ghi settings khi trạng thái đổi.
 * Đọc thô + JSON.parse (không getSettingJson — nó biến mảng thành object).
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { applyHomeBotReport, HOME_BOT_HEALTH_KEY, homeBotStaleCheck, parseHomeBotState, type HomeBotAlert, type HomeBotHealthState, type HomeBotReport } from "@/lib/constants/home-bot-health";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { notifyPlatformOperator } from "@/lib/sales-chatbot/alerts";
import { setSettingJson } from "@/lib/settings";

async function readState(): Promise<HomeBotHealthState> {
  const db = await getDb();
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, HOME_BOT_HEALTH_KEY)).limit(1);
  if (!row) return parseHomeBotState(null);
  try {
    return parseHomeBotState(typeof row.value === "string" ? JSON.parse(row.value) : row.value);
  } catch {
    return parseHomeBotState(null);
  }
}

type Deps = { notify?: (title: string, lines: string[], opts: { dedupeKey: string; orgCode: string }) => Promise<unknown> };

async function commit(prev: HomeBotHealthState, next: { state: HomeBotHealthState; alerts: HomeBotAlert[] }, orgCode: string, deps: Deps): Promise<number> {
  if (JSON.stringify(next.state) !== JSON.stringify(prev)) await setSettingJson(HOME_BOT_HEALTH_KEY, next.state);
  const notify = deps.notify ?? notifyPlatformOperator;
  for (const a of next.alerts) await notify(a.title, a.lines, { dedupeKey: a.dedupeKey, orgCode }).catch(() => undefined);
  return next.alerts.length;
}

/** Một báo cáo của bot nhà (route /api/internal/bot-health). Luôn trong ngữ cảnh tổ chức NHÀ. */
export async function recordHomeBotReport(report: HomeBotReport, now: Date = new Date(), deps: Deps = {}): Promise<{ alerts: number }> {
  const home = await getHomeOrganization();
  return withOrganization(home.code, async () => {
    const prev = await readState();
    return { alerts: await commit(prev, applyHomeBotReport(prev, report, now), home.code, deps) };
  });
}

/** Kiểm «mất nhịp» — job sales-health gọi khi tổ chức ngữ cảnh là NHÀ. Không ném. */
export async function checkHomeBotStale(now: Date = new Date(), deps: Deps = {}): Promise<{ alerts: number }> {
  try {
    const home = await getHomeOrganization();
    return await withOrganization(home.code, async () => {
      const prev = await readState();
      return { alerts: await commit(prev, homeBotStaleCheck(prev, now), home.code, deps) };
    });
  } catch {
    return { alerts: 0 };
  }
}

/** Trạng thái cho banner /platform. Lỗi đọc ⇒ trạng thái rỗng (banner không hiện). */
export async function readHomeBotHealth(): Promise<HomeBotHealthState> {
  try {
    const home = await getHomeOrganization();
    return await withOrganization(home.code, readState);
  } catch {
    return parseHomeBotState(null);
  }
}
