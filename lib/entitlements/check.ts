/**
 * ═══════════ HẠN MỨC GÓI — `checkEntitlement` (Phase 10 · §5) — CHỈ MÁY CHỦ ═══════════
 *
 * Gọi ở ĐÚNG điểm tạo: người dùng, trang, luật, tải tệp, đối tượng tuỳ biến (`createObject` + khôi phục), bản ghi tuỳ
 * biến (`createRecord`), bản nháp AI (`createDraft`). Vượt ⇒ `{ ok: false, error }` — LỖI NGHIỆP VỤ, không ném: điểm gọi trả thẳng câu đó cho người bấm.
 *
 *  · KHÔNG có nhánh "tổ chức nhà" (Phase 14 · docs/saas/ENTITLEMENTS.md): nhà mang gói được GÁN cho nó bằng DỮ LIỆU (cột
 *    `platform_organizations.plan`; 0227 ghi đúng gói mã cũ tự gán — `internal`) và đi ĐÚNG đường của khách. Gán gói khác
 *    cho nhà = ghi cột đó (đường ghi có chạy thử là việc của phase D), không cần sửa tệp này. Cột trống ⇒ xem `planKeyOf`.
 *  · Đếm THẬT từ CSDL tổ chức (không bộ đếm riêng dễ lệch). Đệm 60 giây qua `memo` (khoá tự mang tổ chức) — NHƯNG khi
 *    số đệm đã tới 80% trần thì đếm lại tươi, VÀ mỗi lượt cho qua thì QUÊN số đệm (`forgetMemo`): lượt cho qua là lời
 *    hứa sắp có một dòng mới, nên số đệm vừa thấp hơn thật một đơn vị. Lượt ghi do NGƯỜI bấm đã xoá đệm qua `audit()`,
 *    nhưng lượt ghi trong JOB NỀN chỉ đánh dấu cũ (đệm trả ngay số cũ) — không quên thì với trần nhỏ (vd 2) số đệm 0
 *    cho lọt lượt thứ ba (bài kiểm H4 mô phỏng bằng một dòng chèn không qua `audit`).
 *  · Loại chưa có bộ đếm ⇒ cho qua và nói `used: null` (chưa biết ≠ 0): chặn một thứ không đo được là đoán.
 *  · Gói lạ trên tổ chức ⇒ dùng hạn mức `trial` (phía HẸP); không đọc được cả `trial` ⇒ từ chối, nói rõ vì sao.
 *    Luật này áp cho MỌI workspace, kể cả nhà — không có gói ẩn vô hạn nào trong mã (quyết định giá V1, 07/10/2026).
 */
import { count, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import { forgetMemo, memo } from "@/lib/cache";
import { currentOrganization, withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { dauNgayVN } from "@/lib/ai/budget";
import { applyAddons, hasAddons, type AddonUnits } from "@/lib/billing/addons";
import { readSubscriptionAddons } from "@/lib/billing/standing";
import type { Organization } from "@/lib/platform/types";
import { DEFAULT_PLAN_KEY, ENTITLEMENT_KINDS, ENTITLEMENT_SPEC, HOME_PLAN_KEY, overLimitMessage, parseLimits, type EntitlementKind, type PlanLimits } from "@/lib/entitlements/kinds";

export { HOME_PLAN_KEY, DEFAULT_PLAN_KEY };
const CACHE_MS = 60_000;
const FRESH_AT = 0.8;
const MB = 1024 * 1024;

/** `limits` = hạn mức HIỆU LỰC (gói + phần mua thêm); `planLimits` = của riêng gói; `addons` = phần đã mua thêm (0192). */
export type ResolvedPlan = { key: string; name: string; description: string | null; limits: PlanLimits; planLimits: PlanLimits; addons: AddonUnits; undeclared: EntitlementKind[]; fellBack: boolean };

export type EntitlementVerdict =
  | { ok: true; kind: EntitlementKind; planKey: string; used: number | null; limit: number | null }
  | { ok: false; kind: EntitlementKind; planKey: string; planName: string; used: number; limit: number; error: string };

/**
 * Gói danh nghĩa của một workspace = cột `plan` — gói đã gán LUÔN thắng, với mọi workspace kể cả nhà (0227 ghi `internal`
 * vào cột của nhà). Cột TRỐNG ⇒ `trial`, TRỪ workspace nhà ⇒ `internal`.
 *
 * Nhánh nhà ấy là nhánh AN TOÀN VỀ KHẢ DỤNG, không phải nhánh thương mại (docs/saas/ENTITLEMENTS.md «Nhánh GIỮ»): app khởi
 * động gọi `ensureMigrated()` KHÔNG đợi, nên trong lượt deploy mang 0227 có request tới trước khi cột được ghi; và nếu một
 * migration khác cùng lô lỗi thì drizzle hoàn cả lô. Rơi về `trial` lúc đó là khoá ERP đang vận hành của chính nền tảng
 * (3 người dùng · 5 trang · 50 MB). Nó chỉ chạy khi cột trống — phase D gán gói V1 cho nhà vẫn chỉ là ghi cột.
 */
export function planKeyOf(org: Pick<Organization, "isHome" | "plan">): string {
  const assigned = org.plan?.trim();
  if (assigned) return assigned;
  return org.isHome ? HOME_PLAN_KEY : DEFAULT_PLAN_KEY;
}

/** `priceVnd` = giá MỘT THÁNG (0187); `null` = gói không bán (không phải giá 0). `addonPrices` = đơn giá mua thêm (0192, thô). */
export type PlanRow = { key: string; name: string; description: string | null; limits: unknown; position: number; priceVnd: number | null; addonPrices: unknown; yearlyFreeMonths: number; commercial: unknown };

/**
 * Dòng gói HIỆU LỰC cho khoá `key` — MỘT phép chọn cho hạn mức kỹ thuật (`resolvePlan`) lẫn hạn mức thương mại / tính năng
 * (`lib/pricing/entitlements.ts`): có trong sổ ⇒ dòng đó; vắng ⇒ `trial` (`fellBack`, phía hẹp); không cả `trial` ⇒ `null`
 * (nơi gọi từ chối). Không khoá nào được đối xử riêng.
 */
export function effectivePlanRow<T extends PlanRow>(plans: readonly T[], key: string): { row: T; fellBack: boolean } | null {
  const hit = plans.find((p) => p.key === key);
  if (hit) return { row: hit, fellBack: false };
  const trial = plans.find((p) => p.key === DEFAULT_PLAN_KEY);
  return trial ? { row: trial, fellBack: true } : null;
}

/** Mọi gói (cho màn vận hành). Bảng chưa có ⇒ rỗng. */
export async function listPlans(): Promise<PlanRow[]> {
  const pdb = await getPlatformDb();
  try {
    const rows = await pdb.select().from(schema.platformPlans).orderBy(schema.platformPlans.position);
    // `commercial` (0222) đọc qua `lib/pricing/catalog.ts::parseCommercial` — máy chưa migrate tới 0222 thì ô vắng ⇒ `{}` = chưa khai.
    return rows.map((r) => ({ key: r.key, name: r.name, description: r.description, limits: r.limits, position: r.position, priceVnd: r.priceVnd ?? null, addonPrices: r.addonPrices, yearlyFreeMonths: r.yearlyFreeMonths ?? 0, commercial: r.commercial ?? {} }));
  } catch {
    return [];
  }
}

export async function resolvePlan(org: Pick<Organization, "isHome" | "plan"> & { code?: string }): Promise<ResolvedPlan | null> {
  // Nguồn hàng gói theo PHIÊN BẢN giá đã ghim (0228 — bảng giá V1: người dùng 2 · 3 · 5 · 10 · 25) cho MỌI tổ chức kể cả nhà
  // (nhà ghim legacy ⇒ đúng hàng `platform_plans`). Nhập động: lib/pricing/price-book đọc `listPlans` của chính tệp này.
  const rows = org.code ? await (await import("@/lib/pricing/price-book")).plansForOrgSafe(org.code) : await listPlans();
  const picked = effectivePlanRow(rows, planKeyOf(org));
  if (!picked) return null;
  const { row, fellBack } = picked;
  const parsed = parseLimits(row.limits);
  // Phần MUA THÊM cộng vào hạn mức gói (0192). Tổ chức không có `code` (gọi từ bước xem trước của onboarding) ⇒ chỉ gói.
  const addons: AddonUnits = org.code ? await readSubscriptionAddons(org.code) : {};
  const limits = hasAddons(addons) ? applyAddons(parsed.limits, addons) : parsed.limits;
  return { key: row.key, name: row.name, description: row.description, limits, planLimits: parsed.limits, addons, undeclared: parsed.undeclared, fellBack };
}

// ─── Bộ đếm: ĐẾM THẬT trong CSDL của tổ chức NGỮ CẢNH ───

type Counter = () => Promise<number>;

const COUNTERS: Partial<Record<EntitlementKind, Counter>> = {
  users: async () => {
    const db = await getDb();
    const [r] = await db.select({ n: count() }).from(schema.users).where(eq(schema.users.active, true));
    return Number(r?.n ?? 0);
  },
  pages: async () => {
    const db = await getDb();
    const [r] = await db.select({ n: count() }).from(schema.metaPages).where(ne(schema.metaPages.status, "ARCHIVED"));
    return Number(r?.n ?? 0);
  },
  workflows: async () => {
    const db = await getDb();
    const [r] = await db.select({ n: count() }).from(schema.workflowRules).where(ne(schema.workflowRules.status, "ARCHIVED"));
    return Number(r?.n ?? 0);
  },
  objects: async () => {
    const db = await getDb();
    // Đối tượng đã lưu trữ không tính (như trang / luật) — khôi phục thì kiểm lại hạn mức ở `restoreObject`.
    const [r] = await db.select({ n: count() }).from(schema.metaObjects).where(ne(schema.metaObjects.status, "ARCHIVED"));
    return Number(r?.n ?? 0);
  },
  records: async () => {
    const db = await getDb();
    // Bản ghi còn sống (xoá mềm = `deleted_at` ⇒ không tính), mọi đối tượng tuỳ biến cộng lại.
    const [r] = await db.select({ n: count() }).from(schema.customRecords).where(isNull(schema.customRecords.deletedAt));
    return Number(r?.n ?? 0);
  },
  aiDraftsPerDay: async () => {
    const db = await getDb();
    // Cùng mốc "hôm nay" với trần kỹ thuật của AI Builder (00:00 giờ Việt Nam) — một ngày, một định nghĩa.
    const [r] = await db.select({ n: count() }).from(schema.aiBlueprintDrafts).where(gte(schema.aiBlueprintDrafts.createdAt, dauNgayVN(new Date())));
    return Number(r?.n ?? 0);
  },
  storageMb: async () => {
    const db = await getDb();
    const [r] = await db.select({ bytes: sql<string>`coalesce(sum(${schema.customFiles.size}), 0)` }).from(schema.customFiles);
    return Number(r?.bytes ?? 0) / MB;
  },
};

/** Loại này có bộ đếm thật chưa. */
export function isMeasured(kind: EntitlementKind): boolean {
  return Boolean(COUNTERS[kind]);
}

async function inOrg<T>(orgCode: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!orgCode) return fn();
  const current = await currentOrganization();
  return current.code === orgCode ? fn() : withOrganization(orgCode, fn);
}

async function targetOrg(orgCode?: string): Promise<Organization | null> {
  return findOrganization(orgCode ?? (await currentOrganization()).code);
}

/**
 * Tạo thêm `delta` (đơn vị của loại — MB với `storageMb`) có vượt gói không. `orgCode` bỏ trống ⇒ tổ chức của ngữ
 * cảnh (phiên / `withOrganization`), đúng tổ chức mà lượt ghi ngay sau đó sẽ chạm vào.
 */
export async function checkEntitlement(kind: EntitlementKind, delta = 1, opts: { orgCode?: string } = {}): Promise<EntitlementVerdict> {
  const org = await targetOrg(opts.orgCode);
  if (!org) return { ok: false, kind, planKey: "?", planName: "?", used: 0, limit: 0, error: "Không xác định được tổ chức — không kiểm được hạn mức gói." };
  const plan = await resolvePlan(org);
  if (!plan) return { ok: false, kind, planKey: planKeyOf(org), planName: planKeyOf(org), used: 0, limit: 0, error: "Không đọc được gói dịch vụ của tổ chức — người vận hành nền tảng cần kiểm bảng gói." };
  const limit = plan.limits[kind];
  if (limit === null) return { ok: true, kind, planKey: plan.key, used: null, limit: null };
  const counter = COUNTERS[kind];
  if (!counter) return { ok: true, kind, planKey: plan.key, used: null, limit };
  return inOrg(org.code, async () => {
    let used = await memo(`entitlement:${kind}`, CACHE_MS, counter);
    if (used + delta > limit * FRESH_AT) used = await counter();
    if (used + delta > limit) return { ok: false, kind, planKey: plan.key, planName: plan.name, used, limit, error: overLimitMessage(kind, plan.name, used, limit) };
    await forgetMemo(`entitlement:${kind}`);
    return { ok: true, kind, planKey: plan.key, used, limit };
  });
}

export type UsageRow = { kind: EntitlementKind; label: string; unit: string; used: number | null; limit: number | null; measured: boolean; undeclared: boolean; note: string | null };
export type PlanUsage = { orgCode: string; plan: ResolvedPlan | null; rows: UsageRow[] };

/** Mức dùng hiện tại — đếm TƯƠI (màn hình /settings/plan), không qua đệm. */
export async function getPlanUsage(orgCode?: string): Promise<PlanUsage> {
  const org = await targetOrg(orgCode);
  if (!org) return { orgCode: orgCode ?? "?", plan: null, rows: [] };
  const plan = await resolvePlan(org);
  const rows = await inOrg(org.code, async () => {
    const out: UsageRow[] = [];
    for (const kind of ENTITLEMENT_KINDS) {
      const spec = ENTITLEMENT_SPEC[kind];
      const counter = COUNTERS[kind];
      out.push({
        kind,
        label: spec.label,
        unit: spec.unit,
        used: counter ? await counter() : null,
        limit: plan ? plan.limits[kind] : null,
        measured: Boolean(counter),
        undeclared: plan?.undeclared.includes(kind) ?? false,
        note: counter ? spec.source : spec.missingWhat,
      });
    }
    return out;
  });
  return { orgCode: org.code, plan, rows };
}

/** Kế hoạch sắp cài có vượt gói không (bước Xem trước của onboarding): trả câu cho mỗi loại vượt. */
export function overPlanLimits(limits: PlanLimits, want: Partial<Record<EntitlementKind, number>>, planName: string): string[] {
  const out: string[] = [];
  for (const [k, n] of Object.entries(want) as [EntitlementKind, number][]) {
    const limit = limits[k];
    if (limit !== null && n > limit) out.push(`${ENTITLEMENT_SPEC[k].label}: cần ${n}, gói «${planName}» cho ${limit}.`);
  }
  return out;
}
