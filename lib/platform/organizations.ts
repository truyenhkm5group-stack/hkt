import { getPlatformDb, schema } from "@/db";
import type { Organization, OrganizationStatus, ModuleDefault } from "@/lib/platform/types";

/**
 * SỔ TỔ CHỨC — đọc `platform_organizations` trong CSDL NHÀ.
 *
 * Đọc ở MỌI lượt phân giải ngữ cảnh của một phiên không phải nhà, nên có đệm ngắn trong tiến trình.
 * 10 giây là trần cho việc một tổ chức vừa bị ĐÌNH CHỈ vẫn còn đăng nhập được trên một tiến trình
 * khác; cùng tiến trình thì lượt ghi gọi `invalidateOrganizations()` nên có hiệu lực ngay.
 *
 * ─── BẢNG CHƯA TỒN TẠI KHÔNG PHẢI LÀ LỖI ───
 *
 * Script cũ, máy vừa kéo mã mà chưa migrate, lượt khởi động đầu tiên trước khi `ensureMigrated()`
 * xong: bảng `platform_organizations` chưa có. Lúc đó hệ thống ĐÚNG LÀ chỉ có một tổ chức — tổ chức
 * nhà — nên trả về một bản dựng sẵn của nó thay vì làm sập mọi trang. Mọi lỗi KHÁC ném lên.
 */

const TTL_MS = 10_000;

/** Mã của bản dựng sẵn khi sổ chưa đọc được. Không trùng mã thật nào vì migration chèn `vnx`. */
export const FALLBACK_HOME_CODE = "home";

type Cache = { at: number; list: Organization[] } | null;
const holder = globalThis as unknown as { __erpOrgs?: { cache: Cache; pending: Promise<Organization[]> | null } };
if (!holder.__erpOrgs) holder.__erpOrgs = { cache: null, pending: null };
const store = holder.__erpOrgs;

function fallbackHome(): Organization {
  return { id: "org-home", code: FALLBACK_HOME_CODE, name: "Tổ chức nhà", status: "ACTIVE", isHome: true, moduleDefault: "ENABLED", plan: null, templateKey: null };
}

function isMissingTable(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string }; message?: string } | null;
  const code = e?.code ?? e?.cause?.code;
  if (code === "42P01") return true;
  return /platform_organizations.*(does not exist|không tồn tại)/i.test(String(e?.message ?? ""));
}

async function load(): Promise<Organization[]> {
  const db = await getPlatformDb();
  try {
    const rows = await db.select().from(schema.platformOrganizations);
    const list = rows.map(
      (r): Organization => ({
        id: r.id,
        code: r.code,
        name: r.name,
        status: r.status as OrganizationStatus,
        isHome: r.isHome,
        moduleDefault: r.moduleDefault as ModuleDefault,
        plan: r.plan,
        templateKey: r.templateKey,
      }),
    );
    // Sổ rỗng (không nên xảy ra sau 0152) cũng nghĩa là: chỉ có tổ chức nhà.
    return list.some((o) => o.isHome) ? list : [...list, fallbackHome()];
  } catch (error) {
    if (isMissingTable(error)) return [fallbackHome()];
    throw error;
  }
}

/** Mọi tổ chức (mọi trạng thái). */
export async function listOrganizations(): Promise<Organization[]> {
  const now = Date.now();
  if (store.cache && now - store.cache.at < TTL_MS) return store.cache.list;
  if (!store.pending) {
    store.pending = load()
      .then((list) => {
        store.cache = { at: Date.now(), list };
        return list;
      })
      .finally(() => {
        store.pending = null;
      });
  }
  return store.pending;
}

export async function findOrganization(code: string): Promise<Organization | null> {
  const list = await listOrganizations();
  return list.find((o) => o.code === code) ?? null;
}

export async function getHomeOrganization(): Promise<Organization> {
  const list = await listOrganizations();
  return list.find((o) => o.isHome) ?? fallbackHome();
}

/** Gọi sau MỌI lượt ghi `platform_organizations` trong tiến trình này. */
export function invalidateOrganizations() {
  store.cache = null;
}
