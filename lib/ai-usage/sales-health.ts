import { sql } from "drizzle-orm";
import { getPlatformDb } from "@/db";
import { rowsOf } from "@/lib/sql-rows";

/**
 * Sổ AI (`platform_ai_usage`, CSDL nhà) nhìn từ phía GIÁM SÁT AI BÁN HÀNG (lib/sales-chatbot/health.ts): số lượt OK / lỗi /
 * bị chặn trong cửa sổ, mốc thành công / lỗi gần nhất — tách riêng lượt ghi đơn (`ref` = `order-sync:…`). Mã tổ chức do nơi
 * gọi lấy từ NGỮ CẢNH máy chủ (`currentOrganization()`), không bao giờ từ người dùng. Chỉ SELECT.
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
};

const num = (v: unknown) => (Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0);
const date = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export async function salesAiUsageHealth(orgCode: string, now: Date, windowMinutes: number): Promise<SalesAiUsageHealth> {
  const pdb = await getPlatformDb();
  const windowFrom = new Date(now.getTime() - windowMinutes * 60_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [r] = rowsOf<Record<string, unknown>>(
    await pdb.execute(sql`
      select
        count(*) filter (where status = 'OK' and at >= ${windowFrom}) as ok_w,
        count(*) filter (where status = 'ERROR' and at >= ${windowFrom}) as err_w,
        count(*) filter (where status = 'BLOCKED_QUOTA' and at >= ${windowFrom}) as blocked_w,
        max(at) filter (where status = 'OK') as last_ok,
        max(at) filter (where status <> 'OK') as last_err,
        count(*) filter (where status = 'ERROR' and at >= ${dayAgo}) as err_24h,
        count(*) filter (where status = 'ERROR' and ref like 'order-sync:%' and at >= ${dayAgo}) as sync_err_24h,
        count(*) filter (where status = 'ERROR' and ref like 'order-sync:%' and at >= ${windowFrom}) as sync_err_w,
        max(at) filter (where status = 'OK' and ref like 'order-sync:%') as sync_last_ok,
        max(at) filter (where status <> 'OK' and ref like 'order-sync:%') as sync_last_err
      from platform_ai_usage
      where org_code = ${orgCode} and feature = 'sales_chatbot' and at >= ${new Date(now.getTime() - 7 * 86_400_000)}
    `),
  );
  return {
    okInWindow: num(r?.ok_w),
    errorsInWindow: num(r?.err_w),
    blockedInWindow: num(r?.blocked_w),
    lastOkAt: date(r?.last_ok),
    lastErrorAt: date(r?.last_err),
    errors24h: num(r?.err_24h),
    orderSyncErrors24h: num(r?.sync_err_24h),
    orderSyncErrorsInWindow: num(r?.sync_err_w),
    orderSyncLastOkAt: date(r?.sync_last_ok),
    orderSyncLastErrorAt: date(r?.sync_last_err),
  };
}
