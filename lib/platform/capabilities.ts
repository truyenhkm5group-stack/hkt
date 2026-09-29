import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { moduleOfPath, resolveEnabledModules, resolveFeature, type ModuleKey } from "@/lib/constants/platform-modules";
import { currentOrganization, OrgContextError } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import type { ModuleRow, Organization } from "@/lib/platform/types";

/**
 * ═══════════ BỘ PHÂN GIẢI NĂNG LỰC — CHỖ DUY NHẤT ĐỌC CẤU HÌNH MODULE ═══════════
 *
 * Hợp đồng: docs/platform/shared-contracts.md mục 6. Không nơi nào khác được đọc
 * `platform_organization_modules`. Luật phân giải (dòng thiếu, core, đóng dưới phụ thuộc) là hàm
 * THUẦN trong sổ module; tệp này chỉ nạp dòng và đệm.
 *
 * ─── ĐỆM 5 GIÂY ───
 *
 * Đọc ở mọi lần dựng trang (menu + cổng đường dẫn). Lượt ghi trong CÙNG tiến trình xoá đệm ngay
 * (`invalidateCapabilities`) nên người vừa bấm thấy hiệu lực tức thì — "bật module không cần deploy".
 * Tiến trình khác (script) trễ tối đa 5 giây — risk-register R-07.
 *
 * ─── BẢNG CHƯA CÓ ⇒ KHÔNG DÒNG NÀO ───
 *
 * Trước khi migration 0152 áp, không có dòng module nào; tổ chức nhà `module_default = ENABLED`
 * (bản dựng sẵn của sổ tổ chức cũng vậy) ⇒ mọi module bật, đúng hành vi cũ.
 */

const TTL_MS = 5_000;
type Entry = { at: number; rows: ModuleRow[] };
const holder = globalThis as unknown as { __erpCapabilities?: Map<string, Entry> };
if (!holder.__erpCapabilities) holder.__erpCapabilities = new Map();
const cache = holder.__erpCapabilities;

export class ModuleDisabledError extends Error {
  readonly code = "MODULE_DISABLED" as const;
  constructor(readonly module: string) {
    super(`Module "${module}" chưa được bật cho tổ chức này.`);
    this.name = "ModuleDisabledError";
  }
}

function isMissingTable(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "42P01";
}

async function loadRows(org: Organization): Promise<ModuleRow[]> {
  const hit = cache.get(org.code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const db = await getPlatformDb();
  let rows: ModuleRow[] = [];
  try {
    const found = await db
      .select({ moduleKey: schema.platformOrganizationModules.moduleKey, enabled: schema.platformOrganizationModules.enabled, features: schema.platformOrganizationModules.features })
      .from(schema.platformOrganizationModules)
      .where(eq(schema.platformOrganizationModules.organizationId, org.id));
    rows = found.map((r) => ({ moduleKey: r.moduleKey, enabled: r.enabled, features: r.features ?? {} }));
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  cache.set(org.code, { at: Date.now(), rows });
  return rows;
}

async function resolveOrg(orgCode?: string): Promise<Organization> {
  const code = orgCode ?? (await currentOrganization()).code;
  const org = await findOrganization(code);
  if (!org) throw new OrgContextError("ORG_UNKNOWN", `Không có tổ chức "${code}".`);
  return org;
}

/** Dòng cấu hình module đã lưu (chưa phân giải) — cho màn hình cấu hình và trang sức khoẻ. */
export async function getModuleRows(orgCode?: string): Promise<{ organization: Organization; rows: ModuleRow[] }> {
  const organization = await resolveOrg(orgCode);
  return { organization, rows: await loadRows(organization) };
}

export async function getEnabledModules(orgCode?: string): Promise<Set<ModuleKey>> {
  const org = await resolveOrg(orgCode);
  return resolveEnabledModules(org, await loadRows(org));
}

export async function canUseModule(key: ModuleKey, orgCode?: string): Promise<boolean> {
  return (await getEnabledModules(orgCode)).has(key);
}

export async function canUseFeature(featureKey: `${string}.${string}`, orgCode?: string): Promise<boolean> {
  const org = await resolveOrg(orgCode);
  const rows = await loadRows(org);
  return resolveFeature(featureKey, resolveEnabledModules(org, rows), rows);
}

/** Ném `ModuleDisabledError` (mã `MODULE_DISABLED`) khi module tắt — dùng ở lối vào server action / job. */
export async function assertModule(key: ModuleKey, orgCode?: string): Promise<void> {
  if (!(await canUseModule(key, orgCode))) throw new ModuleDisabledError(key);
}

/** Đường dẫn này thuộc module nào, và module đó có bật cho tổ chức hiện hành không. `module = null` ⇒ không thuộc module nào (công khai / webhook). */
export async function pathAccess(pathname: string, orgCode?: string): Promise<{ module: ModuleKey | null; enabled: boolean }> {
  const owner = moduleOfPath(pathname);
  if (!owner) return { module: null, enabled: true };
  return { module: owner, enabled: await canUseModule(owner, orgCode) };
}

/** Gọi sau MỌI lượt ghi `platform_organization_modules` (không truyền mã ⇒ xoá mọi tổ chức). */
export function invalidateCapabilities(orgCode?: string) {
  if (orgCode) cache.delete(orgCode);
  else cache.clear();
}

// ═══════════ TỔ CHỨC CÓ NGUỒN ĐỒNG BỘ CHO LOẠI BẢN GHI NÀY KHÔNG (pilot bán buôn) ═══════════

export type SyncedSourceKind = "orders" | "products" | "customers";

/**
 * Loại bản ghi ⇒ module connector ĐỒNG BỘ ra nó. Hôm nay cả ba đến từ Pancake POS (connector HOME_ONLY). Đây là bảng
 * khai DUY NHẤT của câu hỏi "bản ghi loại này do đồng bộ tạo hay do người tạo": cổng tạo tay (sản phẩm / đơn / khách)
 * và nút «Đồng bộ …» cùng đọc nó — `tests/pilot-products.test.ts` khoá sổ đối tượng (`requiresModuleOff`) và bảng nút
 * đồng bộ (`SYNC_JOB_MODULES`) phải nói cùng một module.
 */
export const SYNCED_SOURCE_MODULE: Readonly<Record<SyncedSourceKind, ModuleKey>> = {
  orders: "connector_pancake",
  products: "connector_pancake",
  customers: "connector_pancake",
};

/**
 * Tổ chức (ngữ cảnh hiện hành, hoặc `orgCode`) có nguồn ĐỒNG BỘ cho loại bản ghi này không. `true` ⇒ bản ghi do đồng bộ
 * tạo: KHÔNG tạo / sửa tay (hai bản cho cùng một thứ), nút «Đồng bộ …» có nghĩa. `false` ⇒ ngược lại.
 */
export async function orgHasSyncedSource(kind: SyncedSourceKind, orgCode?: string): Promise<boolean> {
  return canUseModule(SYNCED_SOURCE_MODULE[kind], orgCode);
}
