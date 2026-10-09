/**
 * ═══════════ NÂNG VAI TRÒ «NHÂN VIÊN BÁN HÀNG» (BAN_HANG) CHO TỔ CHỨC ĐÃ CÀI MẪU AI BÁN HÀNG ═══════════
 *
 * Chủ shop duyệt 09/10/2026: vai trò `BAN_HANG` của mẫu «AI bán hàng» nhận thêm ĐÚNG MỘT quyền `ai_sales:reply` (trả lời khách
 * trong hộp thư), cho cả tổ chức mới lẫn tổ chức đã có. Tổ chức mới nhận qua mẫu (`templates/ai-sales.ts` 1.1.0). Tổ chức đã có
 * nhận qua ĐƯỜNG NÂNG CẤP CÓ SẴN của bộ cài mẫu — phép so ba chiều của `planBlueprint` (bản gói cũ · bản gói mới · bản tổ
 * chức đang có) — không phải một lệnh UPDATE viết tay:
 *
 *   · vai trò chưa ai sửa từ lần cài (current = applied)  ⇒ UPDATE: ghi qua `applyBlueprint` → `saveAccessRoleCore` (đúng đường
 *     ghi của màn Vai trò tuỳ chỉnh: nhật ký `ACCESS_ROLE_*` + `BLUEPRINT_STEP`), sổ cài ghi `appliedHash` mới để lần nâng sau
 *     vẫn so ba chiều đúng. Một UPDATE viết tay sẽ để sổ cài giữ băm cũ và vai trò bị coi là «đã tuỳ biến» mãi mãi.
 *   · tổ chức đã tự sửa vai trò (tên, mô tả, quyền…)       ⇒ SKIP_CUSTOMIZED: BỎ QUA và báo — không đoán ý người sửa.
 *   · vai trò cùng mã nhưng không do mẫu cài (ngoài sổ)     ⇒ CONFLICT: BỎ QUA và báo.
 *
 * Gói đem đi lập kế hoạch là bản THU HẸP của mẫu: cùng khoá + phiên bản, CHỈ mục vai trò `ban_hang` + module `core` (lược đồ gói
 * đòi ít nhất một module; `core` luôn bật ⇒ bước của nó luôn «không đổi») — không module khác, không field, không trang. Nên lượt nâng không bật lại module tổ chức đã tắt, không dựng lại thứ tổ chức đã xoá, và giữa 1.0.0 với 1.1.0 mục
 * này là thay đổi DUY NHẤT của mẫu — sổ cài ghi 1.1.0 là đúng sự thật.
 *
 * Bộ lọc thêm trước kế hoạch (không phụ thuộc sổ cài): mã ĐÚNG `BAN_HANG`, nền VIEWER (nền khác ⇒ mơ hồ, bỏ qua), đã có quyền ⇒
 * không làm gì. Không bao giờ chạm vai trò mang mã khác, không bao giờ đổi quyền nào khác.
 */
import { asc, eq, and } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { adminSessionUser } from "@/lib/onboarding/service";
import { applyBlueprint } from "@/lib/blueprints/apply";
import { planForOrg } from "@/lib/blueprints/install";
import { AI_SALES_BLUEPRINT } from "@/lib/blueprints/templates/ai-sales";
import type { Blueprint } from "@/lib/blueprints/types";
import { SHELL_SALES_STAFF_ROLE_CODE } from "@/lib/constants/roles";
import { listOrganizations } from "@/lib/platform/organizations";
import { withOrganization } from "@/lib/platform/context";

export const BAN_HANG_REPLY_PERMISSION = "ai_sales:reply";
const ROLE_KEY = SHELL_SALES_STAFF_ROLE_CODE.toLowerCase();

/** Kết quả từng tổ chức. Chỉ `UPDATED` / `WOULD_UPDATE` là có (hoặc sẽ có) ghi. */
export type BanHangReplyOutcome =
  | "UPDATED"
  | "WOULD_UPDATE"
  | "ALREADY"
  | "NO_ROLE"
  | "SKIP_BASE"
  | "SKIP_CUSTOMIZED"
  | "SKIP_NOT_FROM_TEMPLATE"
  | "SKIP_NO_ADMIN"
  | "SKIP_HOME"
  | "SKIP_INACTIVE_ORG"
  | "FAILED";

export const BAN_HANG_REPLY_OUTCOME_LABEL: Record<BanHangReplyOutcome, string> = {
  UPDATED: "đã thêm quyền trả lời",
  WOULD_UPDATE: "SẼ thêm quyền trả lời (chạy thử)",
  ALREADY: "đã có sẵn quyền",
  NO_ROLE: "không có vai trò BAN_HANG",
  SKIP_BASE: "bỏ qua — nền không phải VIEWER (mơ hồ)",
  SKIP_CUSTOMIZED: "bỏ qua — tổ chức đã tự sửa vai trò sau lần cài mẫu",
  SKIP_NOT_FROM_TEMPLATE: "bỏ qua — vai trò cùng mã nhưng không do mẫu cài",
  SKIP_NO_ADMIN: "bỏ qua — không có quản trị đang hoạt động đứng tên lượt nâng",
  SKIP_HOME: "bỏ qua — tổ chức nhà không dùng mẫu AI bán hàng",
  SKIP_INACTIVE_ORG: "bỏ qua — tổ chức không hoạt động",
  FAILED: "lỗi",
};

/** Bản THU HẸP của mẫu: cùng khoá + phiên bản, chỉ mục vai trò `ban_hang`. */
export function banHangRoleBlueprint(template: Blueprint = AI_SALES_BLUEPRINT): Blueprint {
  const role = (template.roles ?? []).find((r) => r.key === ROLE_KEY);
  if (!role) throw new Error(`Mẫu «${template.key}» không có vai trò «${ROLE_KEY}».`);
  return { format: template.format, formatVersion: template.formatVersion, key: template.key, version: template.version, name: template.name, description: template.description, industry: template.industry, modules: ["core"], roles: [role] };
}

async function readFacts(db: Awaited<ReturnType<typeof getDb>>) {
  const role = await db.query.accessRoles.findFirst({ where: eq(schema.accessRoles.code, SHELL_SALES_STAFF_ROLE_CODE) });
  const admin = await db.query.users.findFirst({ where: and(eq(schema.users.role, "ADMIN"), eq(schema.users.active, true)), orderBy: [asc(schema.users.createdAt)], columns: { email: true } });
  return { role, adminEmail: admin?.email ?? null };
}

export type BanHangReplyOrgResult = { orgCode: string; outcome: BanHangReplyOutcome; detail: string | null };

/** Một tổ chức: đọc vai trò, lập kế hoạch bằng bộ cài, ghi khi `apply`. Gọi BÊN NGOÀI `withOrganization` (tự bọc). */
export async function upgradeBanHangReplyForOrg(org: { code: string; name: string; isHome: boolean; status: string }, opts: { apply: boolean; template?: Blueprint }): Promise<BanHangReplyOrgResult> {
  const r = (outcome: BanHangReplyOutcome, detail: string | null = null): BanHangReplyOrgResult => ({ orgCode: org.code, outcome, detail });
  if (org.isHome) return r("SKIP_HOME");
  if (org.status !== "ACTIVE") return r("SKIP_INACTIVE_ORG");
  try {
    // Lượt lọc CHỈ ĐỌC qua đúng ngữ cảnh tổ chức (getDb() — luật S17, không chọn CSDL vòng qua ngữ cảnh).
    const facts = await withOrganization(org.code, async () => readFacts(await getDb()));
    if (!facts.role) return r("NO_ROLE");
    if (facts.role.baseRole !== "VIEWER") return r("SKIP_BASE", `nền ${facts.role.baseRole}`);
    if (facts.role.permissions.includes(BAN_HANG_REPLY_PERMISSION)) return r("ALREADY");
    if (!facts.adminEmail) return r("SKIP_NO_ADMIN");
    const subject = await adminSessionUser(org.code, org.name, facts.adminEmail);
    if (!subject) return r("SKIP_NO_ADMIN");

    const bp = banHangRoleBlueprint(opts.template);
    return await withOrganization(org.code, async () => {
      const plan = await planForOrg(bp, subject);
      const step = plan.steps.find((s) => s.kind === "role" && s.key === ROLE_KEY);
      if (!step) return r("FAILED", "kế hoạch không có bước vai trò");
      if (step.action === "SKIP_CUSTOMIZED") return r("SKIP_CUSTOMIZED");
      if (step.action === "CONFLICT") return r("SKIP_NOT_FROM_TEMPLATE");
      if (step.action === "UNCHANGED") return r("ALREADY");
      if (step.action !== "UPDATE") return r("FAILED", `bước vai trò ${step.action}${step.reason ? ` — ${step.reason}` : ""}`);
      if (!opts.apply) return r("WOULD_UPDATE");
      const res = await applyBlueprint(plan, subject, { blueprint: bp, note: "nâng vai trò Nhân viên bán hàng: thêm quyền trả lời khách (chủ shop duyệt 09/10/2026)" });
      if (!res.ok) return r("FAILED", res.errors.map((e) => e.message).join(" · ").slice(0, 300));
      return r("UPDATED");
    });
  } catch (error) {
    return r("FAILED", (error instanceof Error ? error.message : String(error)).slice(0, 300));
  }
}

export type BanHangReplyRun = { apply: boolean; orgs: BanHangReplyOrgResult[]; counts: Record<BanHangReplyOutcome, number> };

/** Mọi tổ chức (hoặc một mã). Mặc định CHẠY THỬ — chỉ `apply: true` mới ghi. */
export async function runBanHangReplyUpgrade(opts: { apply: boolean; orgCode?: string | null; template?: Blueprint }): Promise<BanHangReplyRun> {
  const all = await listOrganizations();
  const orgs = opts.orgCode ? all.filter((o) => o.code === opts.orgCode) : all;
  const results: BanHangReplyOrgResult[] = [];
  for (const org of orgs) results.push(await upgradeBanHangReplyForOrg(org, { apply: opts.apply, template: opts.template }));
  const counts = Object.fromEntries(Object.keys(BAN_HANG_REPLY_OUTCOME_LABEL).map((k) => [k, 0])) as Record<BanHangReplyOutcome, number>;
  for (const x of results) counts[x.outcome] += 1;
  return { apply: opts.apply, orgs: results, counts };
}

/** Dòng tóm tắt CÔNG KHAI: chỉ số đếm (kho PUBLIC), không định danh nào. */
export function banHangReplySummaryLines(run: BanHangReplyRun): string[] {
  const lines = [`${run.apply ? "GHI" : "CHẠY THỬ"} — quét ${run.orgs.length} tổ chức`];
  for (const [k, n] of Object.entries(run.counts) as [BanHangReplyOutcome, number][]) if (n > 0) lines.push(`${BAN_HANG_REPLY_OUTCOME_LABEL[k]}: ${n}`);
  return lines;
}
