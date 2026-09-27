import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { PLATFORM_MODULES, isModuleKey, moduleDependencyErrors, resolveEnabledModules, resolveFeature, type ModuleCategory, type ModuleKey } from "@/lib/constants/platform-modules";
import { getModuleRows } from "@/lib/platform/capabilities";
import type { ModuleRow, Organization } from "@/lib/platform/types";

/**
 * ═══════════ GÓC NHÌN CẤU HÌNH MODULE CỦA MỘT TỔ CHỨC ═══════════
 *
 * Đọc cấu hình QUA bộ phân giải năng lực (`getModuleRows` — chỗ duy nhất đọc
 * `platform_organization_modules`), rồi dựng bảng hiển thị bằng hàm THUẦN `buildModuleView` để bài
 * kiểm chạy được mà không cần CSDL. Không có luật phân giải nào viết lại ở đây: trạng thái bật/tắt,
 * lõi, phụ thuộc đều hỏi sổ module.
 */

export const MODULE_CATEGORY_LABEL: Record<ModuleCategory, string> = {
  CORE: "Lõi",
  COMMERCE: "Bán hàng",
  OPERATIONS: "Vận hành",
  FINANCE: "Tài chính",
  PEOPLE: "Nhân sự",
  MARKETING: "Marketing",
  INDUSTRY: "Theo ngành",
  CONNECTOR: "Kết nối",
  INTELLIGENCE: "Kỹ thuật & AI",
};

export const MODULE_CATEGORY_ORDER: ModuleCategory[] = ["CORE", "COMMERCE", "OPERATIONS", "INDUSTRY", "FINANCE", "PEOPLE", "MARKETING", "INTELLIGENCE", "CONNECTOR"];

/**
 * Bốn trạng thái, bốn câu:
 *  · `CORE` — lõi, không tắt được.
 *  · `ON` / `OFF` — theo DỮ LIỆU đã phân giải (dòng thiếu ⇒ `module_default`, đóng dưới phụ thuộc).
 *  · `HOME_ONLY` — connector dùng credential của tổ chức nhà; tổ chức khác chưa bật được (P12).
 */
export type ModuleState = "CORE" | "ON" | "OFF" | "HOME_ONLY";

export type ModuleViewRow = {
  key: ModuleKey;
  label: string;
  description: string;
  why: string;
  category: ModuleCategory;
  state: ModuleState;
  enabled: boolean;
  /** Dữ liệu nói bật nhưng bị coi là TẮT vì thiếu phụ thuộc — câu giải thích của sổ module. */
  dependencyError: string | null;
  dependsOn: { key: ModuleKey; label: string; enabled: boolean }[];
  /** Module khác phụ thuộc vào module này — tắt nó bị chặn khi một trong số này đang bật. */
  dependents: { key: ModuleKey; label: string; enabled: boolean }[];
  features: { key: string; label: string; why: string; enabled: boolean; overridden: boolean }[];
};

export type ModuleViewGroup = { category: ModuleCategory; label: string; rows: ModuleViewRow[] };

export type ModuleView = { groups: ModuleViewGroup[]; enabledCount: number; total: number; unknownKeys: string[] };

const LABEL = new Map(PLATFORM_MODULES.map((m) => [m.key, m.label]));

/** Hàm THUẦN: tổ chức + dòng cấu hình ⇒ bảng hiển thị theo nhóm. */
export function buildModuleView(org: Pick<Organization, "moduleDefault" | "isHome">, rows: readonly ModuleRow[]): ModuleView {
  const enabled = resolveEnabledModules(org, rows);
  const depErrors = new Map(moduleDependencyErrors(org, rows).map((e) => [e.key, e.message]));
  const viewRows: ModuleViewRow[] = PLATFORM_MODULES.map((m) => {
    const on = enabled.has(m.key);
    const state: ModuleState = m.core ? "CORE" : on ? "ON" : m.requiresHomeCredentials && !org.isHome ? "HOME_ONLY" : "OFF";
    return {
      key: m.key,
      label: m.label,
      description: m.description,
      why: m.why,
      category: m.category,
      state,
      enabled: on,
      dependencyError: depErrors.get(m.key) ?? null,
      dependsOn: m.dependsOn.map((d) => ({ key: d, label: LABEL.get(d) ?? d, enabled: enabled.has(d) })),
      dependents: PLATFORM_MODULES.filter((x) => x.dependsOn.includes(m.key)).map((x) => ({ key: x.key, label: x.label, enabled: enabled.has(x.key) })),
      features: m.features.map((f) => {
        const override = rows.find((r) => r.moduleKey === m.key)?.features?.[f.key];
        return { key: f.key, label: f.label, why: f.why, enabled: resolveFeature(f.key, enabled, rows), overridden: typeof override === "boolean" };
      }),
    };
  });
  const groups = MODULE_CATEGORY_ORDER.map((category) => ({ category, label: MODULE_CATEGORY_LABEL[category], rows: viewRows.filter((r) => r.category === category) })).filter((g) => g.rows.length > 0);
  return {
    groups,
    enabledCount: viewRows.filter((r) => r.enabled).length,
    total: viewRows.length,
    unknownKeys: [...new Set(rows.filter((r) => !isModuleKey(r.moduleKey)).map((r) => r.moduleKey))].sort(),
  };
}

/** Bảng cấu hình module của MỘT tổ chức (mã tường minh — trang gọi với tổ chức của người xem). */
export async function getOrganizationModuleView(orgCode: string): Promise<{ organization: Organization; view: ModuleView }> {
  const { organization, rows } = await getModuleRows(orgCode);
  return { organization, view: buildModuleView(organization, rows) };
}

/**
 * Quản trị viên đang hoạt động của tổ chức HIỆN HÀNH — những người CHẮC CHẮN bật được module (ADMIN
 * luôn có `modules:manage`, khoá thuộc lõi nên không module nào tắt được nó). Người được cấp riêng
 * quyền này không liệt kê ở đây: tính quyền đủ ba chiều cho cả danh bạ để in một câu gợi ý là quá tay,
 * nên trang nói rõ "và người được cấp quyền…" thay vì in một danh sách THIẾU mà trông như đủ.
 */
export async function listActiveAdmins(): Promise<{ name: string; email: string }[]> {
  const db = await getDb();
  return db
    .select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(and(eq(schema.users.role, "ADMIN"), eq(schema.users.active, true)))
    .orderBy(asc(schema.users.name))
    .limit(10);
}
