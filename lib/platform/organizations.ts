import { getDbFor, getDbForInspection, getPlatformDb, schema, type Db } from "@/db";
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
        domainSlug: r.domainSlug ?? null,
        publishState: r.publishState === "DRAFT" || r.publishState === "PUBLISHED" ? r.publishState : null,
        brand: r.brand === "vnx" || r.brand === "chotdon" ? r.brand : null,
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

/**
 * ═══════════ TRẠNG THÁI VẬN HÀNH — MỘT VỊ NGỮ CHO MỌI CỬA VÀO ═══════════
 *
 * `platform_organizations.status` là chiều VẬN HÀNH (docs/tenant-lifecycle.md): chỉ `ACTIVE` được đăng nhập, nhận webhook, chạy
 * job / AI, được bộ lập lịch gọi và được bước kiểm deploy migrate. `SUSPENDED` (đình chỉ tạm, công tắc khẩn) · `ARCHIVED` (lưu trữ —
 * dữ liệu còn nguyên, không tham gia gì) · `SETUP_FAILED` (dựng hỏng) đều KHÔNG. Chiều THƯƠNG MẠI (thuê bao / thu phí) và chiều
 * TRIỂN KHAI (sổ migration, DEGRADED_MIGRATION) là hai câu hỏi khác — không suy ra từ cột này và không ghi vào cột này.
 *
 * Cửa vào nào hỏi "tổ chức này có được chạy không" thì gọi hàm này, không tự so chuỗi — để ngày thêm một trạng thái thứ năm chỉ
 * phải sửa MỘT chỗ (tests/org-lifecycle.test.ts quét các cửa vào chính).
 */
export function isOperationalOrganization(org: Pick<Organization, "status">): boolean {
  return org.status === "ACTIVE";
}

/**
 * CSDL của tổ chức có được MỞ bằng đường của ứng dụng (`getDbFor` — mở lần đầu là MIGRATE) không. Mọi trạng thái trừ `ARCHIVED`:
 * trang /platform vẫn mở CSDL của tổ chức đình chỉ để người vận hành chẩn đoán, nhưng tổ chức LƯU TRỮ không tham gia migration —
 * chỉ lượt KÍCH HOẠT LẠI tường minh (`lib/platform/org-lifecycle.ts`) được mở nó, và chỉ để migrate + đối chiếu trước khi bật.
 */
export function mayOpenOrganizationDb(org: Pick<Organization, "status">): boolean {
  return org.status !== "ARCHIVED";
}

/**
 * CSDL của một tổ chức để ĐỌC cho báo cáo nền tảng (trang AI dùng chung, A/B model): tổ chức LƯU TRỮ đi handle CHỈ ĐỌC
 * (`getDbForInspection` — không migrate, không dọn), còn lại đi đường của ứng dụng như cũ. Lược đồ của tổ chức lưu trữ có thể tụt
 * sau mã nguồn; câu đọc hỏng thì bên gọi ghi lỗi thật của tổ chức đó, không bao giờ in 0.
 */
export async function organizationDbForReport(org: Pick<Organization, "code" | "isHome" | "status">): Promise<Db> {
  return mayOpenOrganizationDb(org) ? getDbFor(org) : getDbForInspection(org);
}

/**
 * Mã các tổ chức mà bộ lập lịch được gọi thêm job `fanOut` cho: ĐANG HOẠT ĐỘNG và KHÔNG phải nhà
 * (lịch của nhà đi đường cũ, không `?org=`). Chỉ MÃ — không tên, không gói, không trạng thái: tuyến
 * trả nó ra (`GET /api/sync/organizations`) chỉ cần đủ để dựng URL. Sắp xếp để hai lượt đọc cùng sổ
 * cho cùng một thứ tự gọi. CÙNG danh sách là tập tổ chức mà bước kiểm deploy (`scripts/verify-migrations.ts`) mở và migrate.
 */
export function fanOutOrganizationCodes(list: readonly Organization[]): string[] {
  return list
    .filter((o) => isOperationalOrganization(o) && !o.isHome)
    .map((o) => o.code)
    .sort();
}

/** Gọi sau MỌI lượt ghi `platform_organizations` trong tiến trình này. */
export function invalidateOrganizations() {
  store.cache = null;
}
