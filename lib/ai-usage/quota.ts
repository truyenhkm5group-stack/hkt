/**
 * ═══════════ HẠN MỨC AI — `checkAiQuota(orgCode, source)` GỌI TRƯỚC MỖI LƯỢT AI (docs/platform/ai-usage.md §3) ═══════════
 *
 * Hạn mức = `platform_plans.limits.ai` của gói tổ chức (gói lạ ⇒ `trial`, như `lib/entitlements`) rồi ghi đè THƯA của
 * người vận hành (`platform_organizations.settings.ai.limits`). Mức dùng đếm TƯƠI từ `platform_ai_usage`, lọc ĐÚNG tổ
 * chức × ĐÚNG nguồn. Phép so là `evaluateAiQuota` (thuần, `types.ts`) — không có phép thứ hai.
 *
 *  · Vượt trần cứng ⇒ `{ ok: false, error }`: nơi gọi ghi MỘT dòng `BLOCKED_QUOTA` và KHÔNG gọi model.
 *  · Vượt ngưỡng cảnh báo ⇒ cho qua, kèm câu cảnh báo, và báo quản trị tổ chức MỘT lần / ngày / nguồn (một dòng
 *    `notifications` trong CSDL của CHÍNH tổ chức đó, khoá chống trùng `ai-quota-soft:<nguồn>:<ngày VN>`).
 *  · Tổ chức nhà ⇒ không giới hạn, không đếm (gói `internal`).
 *  · Không đọc được gói ⇒ TỪ CHỐI (phía hẹp) và nói vì sao.
 */
import { getDb, schema } from "@/db";
import { listPlans, planKeyOf, DEFAULT_PLAN_KEY } from "@/lib/entitlements/check";
import { currentOrganization, withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { readOrgAiControl } from "@/lib/ai-usage/control";
import { orgAiLimits } from "@/lib/pricing/price-book";
import { sourceUsage } from "@/lib/ai-usage/ledger";
import { CUSTOMER_AI_SOFT_LIMIT_NOTICE } from "@/lib/saas/visibility";
import {
  applyAiOverride,
  EMPTY_SOURCE_USAGE,
  evaluateAiQuota,
  HOME_AI_LIMITS,
  parseAiLimits,
  vnDayKey,
  type AiBillingSource,
  type AiLimits,
  type AiLimitsOverride,
  type AiQuotaVerdict,
} from "@/lib/ai-usage/types";

export type ResolvedAiLimits = { orgCode: string; isHome: boolean; planKey: string; planName: string; limits: AiLimits; undeclared: boolean; override: AiLimitsOverride; fellBack: boolean } | null;

/** Hạn mức AI đang áp cho một tổ chức (gói + ghi đè). `null` = không đọc được gói (nơi gọi từ chối). */
export async function resolveAiLimits(orgCode: string): Promise<ResolvedAiLimits> {
  const org = await findOrganization(orgCode);
  if (!org) return null;
  const override = (await readOrgAiControl(orgCode)).limits;
  if (org.isHome) return { orgCode, isHome: true, planKey: planKeyOf(org), planName: "Nội bộ", limits: HOME_AI_LIMITS, undeclared: false, override: {}, fellBack: false };
  const key = planKeyOf(org);
  // Gói AI của bảng giá có phiên bản (0228): không trần cứng, credit = ngân sách mềm — dẫn xuất từ phiên bản đã ghim.
  const versioned = await orgAiLimits(orgCode, key);
  const plans = await listPlans();
  if (versioned) return { orgCode, isHome: false, planKey: key, planName: plans.find((p) => p.key === key)?.name ?? key, limits: applyAiOverride(versioned, override), undeclared: false, override, fellBack: false };
  const hit = plans.find((p) => p.key === key);
  const row = hit ?? plans.find((p) => p.key === DEFAULT_PLAN_KEY);
  if (!row) return null;
  const parsed = parseAiLimits(row.limits);
  return { orgCode, isHome: false, planKey: row.key, planName: row.name, limits: applyAiOverride(parsed.limits, override), undeclared: parsed.undeclared, override, fellBack: !hit };
}

async function inOrg<T>(orgCode: string, fn: () => Promise<T>): Promise<T> {
  const current = await currentOrganization();
  return current.code === orgCode ? fn() : withOrganization(orgCode, fn);
}

/** Khoá chống trùng của cảnh báo ngưỡng — MỘT lần / ngày (giờ VN) / nguồn. */
export function softWarningKey(source: AiBillingSource, now: Date): string {
  return `ai-quota-soft:${source}:${vnDayKey(now)}`;
}

/**
 * Báo quản trị tổ chức: một dòng `notifications` trong CSDL của CHÍNH tổ chức. Trùng khoá ⇒ không thêm. Lỗi ⇒ nuốt (câu cảnh báo
 * vẫn trả cho nơi gọi). Chỉ tổ chức KHÁCH tới đây (nhà không đếm). Nguồn PLATFORM = AI dùng chung, tiền của NỀN TẢNG ⇒ câu kinh
 * doanh, không số USD / tên nguồn nội bộ (`CUSTOMER_AI_SOFT_LIMIT_NOTICE`, lib/saas/visibility.ts); BYOK = khoá của chính shop ⇒
 * câu có số tiền như cũ.
 */
async function notifySoftOnce(orgCode: string, source: AiBillingSource, warning: string, now: Date): Promise<void> {
  const notice = source === "PLATFORM" ? CUSTOMER_AI_SOFT_LIMIT_NOTICE : { title: "Chi phí AI vượt ngưỡng cảnh báo", body: warning };
  try {
    await inOrg(orgCode, async () => {
      const db = await getDb();
      await db
        .insert(schema.notifications)
        .values({ kind: "SYSTEM", severity: "warning", title: notice.title, body: notice.body, href: "/settings/plan", entityType: "AI_QUOTA", entityId: source, dedupeKey: softWarningKey(source, now), occurredAt: now })
        .onConflictDoNothing({ target: schema.notifications.dedupeKey });
    });
  } catch {
    // Thông báo là phụ: lượt AI không được hỏng vì nó.
  }
}

/**
 * Lượt AI sắp tới của `orgCode` tính tiền vào `source` có được chạy không. KHÔNG ghi sổ — nơi gọi ghi dòng
 * `BLOCKED_QUOTA` khi bị chặn (nó biết tính năng, provider, người bấm). `notify: false` cho câu hỏi "có còn credit
 * không" lúc chọn provider (không báo trùng).
 */
export async function checkAiQuota(orgCode: string, source: AiBillingSource, opts: { now?: Date; notify?: boolean } = {}): Promise<AiQuotaVerdict> {
  const now = opts.now ?? new Date();
  const resolved = await resolveAiLimits(orgCode);
  if (!resolved) return { ok: false, source, reason: "PLAN_UNREADABLE", error: "Không đọc được gói dịch vụ của tổ chức — người vận hành nền tảng cần kiểm bảng gói.", usage: EMPTY_SOURCE_USAGE, limits: HOME_AI_LIMITS };
  if (resolved.isHome) return { ok: true, source, softExceeded: false, warning: null, usage: EMPTY_SOURCE_USAGE, limits: HOME_AI_LIMITS };
  if (source === "HOME") return { ok: false, source, reason: "PLAN_UNREADABLE", error: "AI của tổ chức nhà chỉ dành cho tổ chức nhà.", usage: EMPTY_SOURCE_USAGE, limits: resolved.limits };
  const usage = await sourceUsage(orgCode, source, now);
  const verdict = evaluateAiQuota(source, resolved.limits, usage);
  if (verdict.ok && verdict.softExceeded && verdict.warning && opts.notify !== false) await notifySoftOnce(orgCode, source, verdict.warning, now);
  return verdict;
}
