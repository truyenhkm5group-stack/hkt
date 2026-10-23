/**
 * ═══ SỰ CỐ NHÀ CUNG CẤP AI «CẦN NGƯỜI» ĐANG MỞ — ĐỌC TỪ GƯƠNG SỨC KHOẺ (P0 cạn credit, 24/10/2026) — CHỈ MÁY CHỦ ═══
 *
 * MỘT nguồn: dòng `AI` của `platform_org_health` do job `sales-health` ghi (5 phút / lần, mọi tổ chức). Không câu đếm mới trên sổ AI,
 * không ngưỡng mới (K / W) — luật «hết credit ⇒ CRITICAL ngay» đã ở `lib/sales-chatbot/health-shared.ts`; ở đây chỉ ĐỌC kết luận.
 * Không gọi AI, không gọi API thanh toán nào: ERP KHÔNG đọc được số dư của nhà cung cấp (sổ chi của ERP không phải số dư Google).
 *
 * Hai người đọc: banner trên /platform và rào của hai script ops gọi AI bằng khoá nền tảng (bench · probe model) — tối 23/10/2026 chính
 * lượt bench GĐ3 đã tiêu cạn tài khoản trả trước đang nuôi bot của khách.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { PROVIDER_KINDS_NEED_HUMAN } from "@/lib/sales-chatbot/health-shared";

export type AiProviderIncident = { orgCode: string; reason: string; since: Date; measuredAt: Date | null; detail: string | null };

/** Lớp lỗi chặn lượt bench / probe: hết tiền — chạy thêm chỉ tiêu thêm vào đúng tài khoản đang cạn. */
export const BENCH_BLOCKING_REASONS: readonly string[] = ["CREDIT"];

/** Câu in ở MỌI lượt bench / probe — ERP không biết số dư, nên luôn nói ra điều đó. */
export const PROVIDER_BALANCE_UNREADABLE = "Số dư tài khoản AI (Google AI Studio trả trước) KHÔNG đọc được từ ERP — sổ chi của ERP không phải số dư. Cần chủ shop xác nhận đã nạp trước khi chạy lượt tốn tiền.";

/** Tổ chức nào đang có AI bán hàng CRITICAL vì lớp lỗi cần người (hết tiền · khoá bị từ chối). Lỗi đọc ⇒ NÉM (người gọi quyết). */
export async function listAiProviderIncidents(reasons: readonly string[] = PROVIDER_KINDS_NEED_HUMAN): Promise<AiProviderIncident[]> {
  const pdb = await getPlatformDb();
  const h = schema.platformOrgHealth;
  const rows = await pdb
    .select({ orgCode: h.orgCode, reason: h.lastReason, since: h.since, measuredAt: h.measuredAt, detail: h.detail })
    .from(h)
    .where(and(eq(h.checkKey, "AI"), eq(h.level, "CRITICAL"), inArray(h.lastReason, [...reasons])));
  return rows.map((r) => ({ orgCode: r.orgCode, reason: r.reason ?? "", since: r.since, measuredAt: r.measuredAt, detail: r.detail })).sort((a, b) => a.since.getTime() - b.since.getTime());
}

export type BenchGuardVerdict = { ok: true; note: string } | { ok: false; message: string };

/**
 * Rào bench / probe — HÀM THUẦN. Có sự cố CREDIT đang mở ở bất kỳ tổ chức nào ⇒ TỪ CHỐI. Không đọc được gương (`null`) ⇒ cũng từ
 * chối: mọi nhánh lỗi rơi về phía HẸP — không biết tài khoản còn tiền hay không thì không tiêu thêm.
 */
export function benchGuard(incidents: readonly AiProviderIncident[] | null): BenchGuardVerdict {
  if (incidents === null) return { ok: false, message: `Không đọc được gương sức khoẻ AI (platform_org_health) — KHÔNG chạy. ${PROVIDER_BALANCE_UNREADABLE}` };
  const credit = incidents.filter((i) => BENCH_BLOCKING_REASONS.includes(i.reason));
  if (credit.length) {
    const who = credit.map((i) => `${i.orgCode} (từ ${i.since.toISOString().slice(0, 16)}Z)`).join(", ");
    return { ok: false, message: `TỪ CHỐI: AI bán hàng đang HẾT TIỀN nhà cung cấp ở ${who} — chạy thêm chỉ tiêu thêm vào tài khoản đang cạn. ${PROVIDER_BALANCE_UNREADABLE}` };
  }
  return { ok: true, note: `Không tổ chức nào đang báo hết tiền nhà cung cấp. ${PROVIDER_BALANCE_UNREADABLE}` };
}

/** Rào cho script: đọc gương rồi phán — lỗi đọc thành `null` (từ chối), không ném. */
export async function benchGuardNow(): Promise<BenchGuardVerdict> {
  try {
    return benchGuard(await listAiProviderIncidents());
  } catch {
    return benchGuard(null);
  }
}
