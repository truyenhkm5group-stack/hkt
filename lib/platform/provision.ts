import { eq, sql } from "drizzle-orm";
import { getDbFor, getPlatformDb, isPglite, organizationDatabaseName, schema } from "@/db";
import { indexAccountIdentities } from "@/lib/auth/identities";
import { hashPassword } from "@/lib/auth/password";
import { platformAudit, type PlatformActor, type PlatformAuditSource } from "@/lib/platform/audit";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { ORGANIZATION_CODE_PATTERN, type Organization } from "@/lib/platform/types";
import { ensureAccountForWorkspace, openSubscriptionsForProductsInUse } from "@/lib/saas/accounts";

/**
 * ═══════════ CẤP MỘT TỔ CHỨC MỚI ═══════════
 *
 * Năm bước, theo thứ tự, mỗi bước idempotent — chạy lại sau một lần hỏng giữa chừng là đi tiếp chứ
 * không nhân đôi:
 *
 *  1. Dòng `platform_organizations` (`module_default = DISABLED`: tổ chức mới chỉ có đúng thứ được bật).
 *  2. CSDL: Postgres ⇒ `CREATE DATABASE` nếu chưa có (cần quyền CREATEDB trên máy chủ Postgres —
 *     trên production đây là HUMAN GATE, docs/platform/migration-strategy.md mục 6). PGlite ⇒ thư mục
 *     tự tạo khi mở.
 *  3. Mở CSDL ⇒ `db/index.ts` tự áp bộ migration và dọn bản sao mặt phẳng điều khiển.
 *  4. Dòng module theo danh sách được truyền vào (người gọi dựng từ mẫu `ORG_TEMPLATES`), ghi TƯỜNG
 *     MINH `enabled = true` — không dựa vào mặc định.
 *  5. Tài khoản quản trị đầu tiên trong CSDL của CHÍNH tổ chức đó (tư cách thành viên = tài khoản
 *     trong CSDL tổ chức, target-architecture P5) + dòng chỉ mục đăng nhập của nó (email ⇒ tổ chức,
 *     `lib/auth/identities.ts`) — thiếu dòng này thì quản trị kích hoạt xong vẫn chỉ vào được khi gõ
 *     «mã tổ chức» (P0 08/10/2026). Ghi cả khi quản trị ĐÃ có (lượt chạy lại sau một lần hỏng giữa
 *     chừng); khoá duy nhất của chỉ mục giữ nó một dòng.
 *  6. Hồ sơ thương mại (0224, docs/saas/README.md): workspace gắn vào TÀI KHOẢN khách (`accountId` hoặc một tài khoản mới
 *     mang tên workspace) và mở thuê bao cho sản phẩm mà module vừa bật thuộc về. Mọi đường tạo workspace (tự đăng ký,
 *     người vận hành, job cấp phát) đều đi qua đây nên không workspace nào thiếu tài khoản.
 *
 * Không nhận chuỗi kết nối: CSDL dẫn xuất từ mã tổ chức (`organizationDatabaseUrl`). Không bao giờ
 * cấp tổ chức "nhà" — tổ chức nhà duy nhất do migration 0152 tạo.
 */
export type ProvisionInput = {
  code: string;
  name: string;
  templateKey?: string | null;
  plan?: string | null;
  /** Thương hiệu nơi khách tự đăng ký (0215). Chỉ ghi khi CHÈN dòng mới — cấp lại / chạy lại không đổi. */
  brand?: "vnx" | "chotdon" | null;
  /** Tài khoản khách sở hữu workspace (0224). Bỏ trống ⇒ tạo một tài khoản khách ngoài mang tên workspace. */
  accountId?: string | null;
  /** Module bật ngay khi cấp. Người gọi đảm bảo tập này đóng dưới phụ thuộc (sổ module kiểm). */
  modules: string[];
  admin?: { email: string; name: string; password: string };
  source: PlatformAuditSource;
  actor: PlatformActor;
};

export type ProvisionResult = { organization: Organization; created: boolean; adminCreated: boolean };

export async function provisionOrganization(input: ProvisionInput): Promise<ProvisionResult> {
  if (!ORGANIZATION_CODE_PATTERN.test(input.code)) throw new Error(`Mã tổ chức "${input.code}" không hợp lệ (chữ thường, số, gạch ngang; 2–31 ký tự, bắt đầu bằng chữ).`);
  const pdb = await getPlatformDb();

  // 1. Dòng tổ chức.
  let created = false;
  const existing = await findOrganization(input.code);
  if (existing?.isHome) throw new Error("Không cấp lại tổ chức nhà.");
  if (!existing) {
    const inserted = await pdb
      .insert(schema.platformOrganizations)
      .values({ code: input.code, name: input.name, status: "ACTIVE", isHome: false, moduleDefault: "DISABLED", templateKey: input.templateKey ?? null, plan: input.plan ?? null, brand: input.brand ?? null })
      .onConflictDoNothing()
      .returning({ id: schema.platformOrganizations.id });
    created = inserted.length > 0;
    invalidateOrganizations();
    if (created) {
      await platformAudit({ action: "ORG_CREATE", targetOrgCode: input.code, subject: input.code, after: { name: input.name, templateKey: input.templateKey ?? null, modules: input.modules }, source: input.source, actor: input.actor });
    }
  }
  const org = await findOrganization(input.code);
  if (!org) throw new Error(`Không đọc lại được tổ chức "${input.code}" sau khi tạo.`);

  // 2. CSDL (Postgres). Tên đã qua regex của mã tổ chức nên an toàn để nội suy vào DDL.
  if (!isPglite() && !process.env[`ORG_DATABASE_URL__${org.code.toUpperCase().replace(/-/g, "_")}`]) {
    const dbName = organizationDatabaseName(org.code);
    const found = await pdb.execute(sql`select 1 from pg_database where datname = ${dbName}`);
    const rows = (found as unknown as { rows?: unknown[] }).rows ?? (found as unknown as unknown[]);
    if (!Array.isArray(rows) || rows.length === 0) await pdb.execute(sql.raw(`create database "${dbName}"`));
  }

  // 3. Mở ⇒ migrate + dọn bản sao mặt phẳng điều khiển.
  const odb = await getDbFor(org);

  // 4. Dòng module — tường minh.
  for (const key of input.modules) {
    const row = await pdb
      .insert(schema.platformOrganizationModules)
      .values({ organizationId: org.id, moduleKey: key, enabled: true, enabledAt: new Date(), updatedBy: "system:provision" })
      .onConflictDoNothing()
      .returning({ key: schema.platformOrganizationModules.moduleKey });
    if (row.length > 0) {
      await platformAudit({ action: "MODULE_ENABLE", targetOrgCode: org.code, subject: key, before: null, after: { enabled: true }, reason: "Bật khi cấp tổ chức", source: input.source, actor: input.actor });
    }
  }

  // 5. Tài khoản quản trị đầu tiên — trong CSDL của tổ chức, dưới ngữ cảnh của nó.
  let adminCreated = false;
  if (input.admin) {
    const admin = input.admin;
    const cols = { id: schema.users.id, email: schema.users.email, phone: schema.users.phone, active: schema.users.active };
    const account = await withOrganization(org.code, async () => {
      const email = admin.email.trim().toLowerCase();
      const has = await odb.query.users.findFirst({ where: eq(schema.users.email, email), columns: { id: true, email: true, phone: true, active: true } });
      if (has) return { row: has, created: false };
      const [row] = await odb.insert(schema.users).values({ email, name: admin.name, passwordHash: await hashPassword(admin.password), role: "ADMIN" }).returning(cols);
      return { row, created: true };
    });
    adminCreated = account.created;
    // Chỉ mục ĐÚNG dòng vừa tạo / tìm thấy (email UNIQUE trong CSDL tổ chức ⇒ xác định, không đoán). Chưa phải một lượt đăng
    // nhập: mốc dùng để trống cho tới khi quản trị thật sự vào (lib/auth/identities.ts).
    await indexAccountIdentities(org.code, account.row);
  }

  // 6. Hồ sơ thương mại — idempotent: đã gắn tài khoản / đã có thuê bao sống ⇒ không đổi gì.
  invalidateCapabilities(org.code);
  const saasSource = input.source === "TEST" ? "TEST" : "PROVISIONING";
  await ensureAccountForWorkspace(org.code, { accountId: input.accountId ?? null, source: saasSource, actor: input.actor });
  await openSubscriptionsForProductsInUse(org.code, { actor: input.actor, source: saasSource, reason: "Mở cùng lượt cấp workspace" });
  return { organization: org, created, adminCreated };
}
