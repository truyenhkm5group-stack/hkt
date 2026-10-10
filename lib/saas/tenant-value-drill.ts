/**
 * ═══════════ GIÁ TRỊ KHÁCH HÀNG — DRILL-DOWN ĐƠN ↔ HỘI THOẠI (ĐỌC SỐNG CSDL TỔ CHỨC, CHỈ KHI NGƯỜI VẬN HÀNH BẤM MỞ) ═══════════
 *
 * Trang danh sách và trang một khách CHỈ đọc ảnh chụp (`lib/saas/tenant-value-read.ts`). Tệp này là lối DUY NHẤT của Trung tâm giá
 * trị mở CSDL của một tổ chức lúc xem — và chỉ trên tuyến riêng `/platform/customers/<mã>/attributed-orders`, tức là sau một cú bấm
 * của người vận hành, không bao giờ trong lượt dựng trang danh sách (tests/saas-value-ui.test.ts quét mã).
 *
 *  · Hỏi `platformOperatorDenial` TRƯỚC lượt đọc đầu tiên (S21); tổ chức phải THUỘC tài khoản trên đường dẫn (không đọc chéo bằng
 *    cách đổi `?org=`).
 *  · Đọc qua `listAttributedOrders` (PR-2) — CÙNG tập và CÙNG luật với tổng quy kết trong ảnh chụp, có phân trang ổn định.
 *  · KHÔNG PII: chỉ mã đơn · mã hội thoại · nhãn · kết cục · số tiền. Không tên, SĐT, địa chỉ, nội dung tin (kho PUBLIC).
 */
import { and, eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { TENANT_VALUE_WINDOWS, type TenantValueWindow } from "@/lib/constants/tenant-value-metrics";
import { withOrganization } from "@/lib/platform/context";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { listAttributedOrders } from "@/lib/sales-chatbot/attribution";
import { ATTRIBUTION_OVERLAYS, ORDER_ATTRIBUTIONS, type AttributionOverlay, type OrderAttribution } from "@/lib/sales-chatbot/attribution-shared";
import type { OrderOutcome } from "@/lib/constants/returns";

export const DRILL_PAGE_SIZE = 25;

export type DrillFilter = OrderAttribution | "UNATTRIBUTED" | AttributionOverlay | null;

export function parseDrillFilter(raw: unknown): DrillFilter {
  const s = typeof raw === "string" ? raw : null;
  if (!s) return null;
  if (s === "UNATTRIBUTED") return s;
  if ((ORDER_ATTRIBUTIONS as readonly string[]).includes(s)) return s as OrderAttribution;
  if ((ATTRIBUTION_OVERLAYS as readonly string[]).includes(s)) return s as AttributionOverlay;
  return null;
}

export type DrillRow = {
  orderId: string;
  conversationId: string;
  confirmedAtMs: number | null;
  attribution: OrderAttribution | null;
  overlays: AttributionOverlay[];
  outcome: OrderOutcome;
  pending: boolean;
  valueVnd: number;
  deliveredRevenueVnd: number;
  /** `null` = đơn không mang AI_UPSELL; `{ amountVnd: null }` = CHƯA BIẾT số tiền bán thêm. */
  upsell: { amountVnd: number | null } | null;
};

export type DrillPage = { orgCode: string; days: TenantValueWindow; filter: DrillFilter; rows: DrillRow[]; total: number; page: number; pageCount: number };

/**
 * Một trang đơn của tập quy kết của MỘT workspace thuộc tài khoản `accountCode`. `null` = tài khoản / workspace không khớp (404).
 */
export async function loadAttributedOrdersAsOperator(
  user: SessionUser,
  input: { accountCode: string; orgCode: string; days: number; page: number; filter: DrillFilter; now?: Date },
): Promise<{ ok: true; value: DrillPage } | { ok: false; error: string } | null> {
  const denial = platformOperatorDenial(user);
  if (denial) return { ok: false, error: denial };
  const days = ((TENANT_VALUE_WINDOWS as readonly number[]).includes(input.days) ? input.days : 30) as TenantValueWindow;
  const pdb = await getPlatformDb();
  const o = schema.platformOrganizations;
  const a = schema.platformAccounts;
  const [owned] = await pdb
    .select({ code: o.code, status: o.status })
    .from(o)
    .innerJoin(a, eq(a.id, o.accountId))
    .where(and(eq(o.code, input.orgCode), eq(a.code, input.accountCode)))
    .limit(1);
  if (!owned) return null;
  if (owned.status !== "ACTIVE") return { ok: false, error: `Workspace ${owned.code} đang ${owned.status} — không mở CSDL để đọc đơn.` };
  const f = input.filter;
  const attribution = f === "UNATTRIBUTED" || (f && (ORDER_ATTRIBUTIONS as readonly string[]).includes(f)) ? (f as OrderAttribution | "UNATTRIBUTED") : null;
  const overlay = f && (ATTRIBUTION_OVERLAYS as readonly string[]).includes(f) ? (f as AttributionOverlay) : null;
  try {
    const p = await withOrganization(owned.code, () => listAttributedOrders({ days, now: input.now, page: input.page, pageSize: DRILL_PAGE_SIZE, attribution, overlay }));
    return {
      ok: true,
      value: {
        orgCode: owned.code,
        days,
        filter: f,
        total: p.total,
        page: p.page,
        pageCount: p.pageCount,
        rows: p.rows.map((r) => ({
          orderId: r.orderId,
          conversationId: r.conversationId,
          confirmedAtMs: r.confirmedAt ? r.confirmedAt.getTime() : null,
          attribution: r.attribution,
          overlays: r.overlays,
          outcome: r.outcome,
          pending: r.pending,
          valueVnd: r.valueVnd,
          deliveredRevenueVnd: r.deliveredRevenueVnd,
          upsell: r.upsell,
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: `Không đọc được đơn của ${owned.code}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
}
