import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";

/**
 * Sổ AI (`platform_ai_usage`, CSDL nhà) nhìn từ phía GIÁM SÁT AI BÁN HÀNG (lib/sales-chatbot/health.ts): số lượt OK / lỗi /
 * bị chặn trong cửa sổ, mốc thành công / lỗi gần nhất — tách riêng lượt ghi đơn (`ref` = `order-sync:…`). Chỉ SELECT.
 *
 * MỘT câu SQL cho mọi người đọc: `salesAiUsageHealthByOrg` gom theo tổ chức (màn danh sách khách của người vận hành —
 * `lib/saas/customer-signals.ts`, sau cổng người vận hành); `salesAiUsageHealth` là bản MỘT tổ chức của chính câu đó, mã tổ chức
 * do nơi gọi lấy từ NGỮ CẢNH máy chủ (`currentOrganization()`), không bao giờ từ người dùng.
 */
export type SalesAiUsageHealth = {
  okInWindow: number;
  errorsInWindow: number;
  blockedInWindow: number;
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  errors24h: number;
  orderSyncErrors24h: number;
  orderSyncErrorsInWindow: number;
  orderSyncLastOkAt: Date | null;
  orderSyncLastErrorAt: Date | null;
  /** Lượt OK / bị chặn 24 giờ, lượt OK 7 ngày (gồm lượt ghi đơn) — màn sức khoẻ khách đọc thêm. */
  ok24h: number;
  blocked24h: number;
  ok7d: number;
};

const num = (v: unknown) => (Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0);
const date = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Sổ AI bán hàng của nhiều tổ chức trong một lượt (7 ngày gần nhất). Tổ chức không có dòng nào ⇒ mọi số 0 THẬT (đọc được, không
 * có lượt nào), mốc `null`. Lỗi đọc ⇒ NÉM — người gọi quyết «chưa đo», không bao giờ đổi thành 0.
 */
export async function salesAiUsageHealthByOrg(orgCodes: readonly string[], now: Date, windowMinutes: number): Promise<Map<string, SalesAiUsageHealth>> {
  const out = new Map<string, SalesAiUsageHealth>();
  const codes = [...new Set(orgCodes)];
  if (!codes.length) return out;
  const pdb = await getPlatformDb();
  const a = schema.platformAiUsage;
  const windowFrom = new Date(now.getTime() - windowMinutes * 60_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const sync = sql`${a.ref} like 'order-sync:%'`;
  const rows = await pdb
    .select({
      orgCode: a.orgCode,
      okW: sql<number>`count(*) filter (where ${a.status} = 'OK' and ${a.at} >= ${windowFrom})`,
      errW: sql<number>`count(*) filter (where ${a.status} = 'ERROR' and ${a.at} >= ${windowFrom})`,
      blockedW: sql<number>`count(*) filter (where ${a.status} = 'BLOCKED_QUOTA' and ${a.at} >= ${windowFrom})`,
      lastOk: sql<Date | string | null>`max(${a.at}) filter (where ${a.status} = 'OK')`,
      lastErr: sql<Date | string | null>`max(${a.at}) filter (where ${a.status} <> 'OK')`,
      err24: sql<number>`count(*) filter (where ${a.status} = 'ERROR' and ${a.at} >= ${dayAgo})`,
      syncErr24: sql<number>`count(*) filter (where ${a.status} = 'ERROR' and ${sync} and ${a.at} >= ${dayAgo})`,
      syncErrW: sql<number>`count(*) filter (where ${a.status} = 'ERROR' and ${sync} and ${a.at} >= ${windowFrom})`,
      syncLastOk: sql<Date | string | null>`max(${a.at}) filter (where ${a.status} = 'OK' and ${sync})`,
      syncLastErr: sql<Date | string | null>`max(${a.at}) filter (where ${a.status} <> 'OK' and ${sync})`,
      ok24: sql<number>`count(*) filter (where ${a.status} = 'OK' and ${a.at} >= ${dayAgo})`,
      blocked24: sql<number>`count(*) filter (where ${a.status} = 'BLOCKED_QUOTA' and ${a.at} >= ${dayAgo})`,
      ok7: sql<number>`count(*) filter (where ${a.status} = 'OK')`,
    })
    .from(a)
    .where(and(inArray(a.orgCode, codes), eq(a.feature, "sales_chatbot"), gte(a.at, new Date(now.getTime() - 7 * 86_400_000))))
    .groupBy(a.orgCode);
  const by = new Map(rows.map((r) => [r.orgCode, r]));
  for (const code of codes) {
    const r = by.get(code);
    out.set(code, {
      okInWindow: num(r?.okW),
      errorsInWindow: num(r?.errW),
      blockedInWindow: num(r?.blockedW),
      lastOkAt: date(r?.lastOk),
      lastErrorAt: date(r?.lastErr),
      errors24h: num(r?.err24),
      orderSyncErrors24h: num(r?.syncErr24),
      orderSyncErrorsInWindow: num(r?.syncErrW),
      orderSyncLastOkAt: date(r?.syncLastOk),
      orderSyncLastErrorAt: date(r?.syncLastErr),
      ok24h: num(r?.ok24),
      blocked24h: num(r?.blocked24),
      ok7d: num(r?.ok7),
    });
  }
  return out;
}

export async function salesAiUsageHealth(orgCode: string, now: Date, windowMinutes: number): Promise<SalesAiUsageHealth> {
  return (await salesAiUsageHealthByOrg([orgCode], now, windowMinutes)).get(orgCode)!;
}
