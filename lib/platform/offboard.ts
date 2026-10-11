import { existsSync, rmSync } from "node:fs";
import { sql, type SQL } from "drizzle-orm";
import { getDbForInspection, getPlatformDb, isPglite, organizationDatabaseName, organizationDatabaseUrl, releaseOrganizationDb, schema } from "@/db";
import { CONTROL_PLANE_TABLES, type ControlPlaneTable } from "@/lib/blueprints/restore-drill";
import { platformAudit } from "@/lib/platform/audit";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { offboardDeletableAccountType } from "@/lib/saas/policy";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ XOÁ MỘT WORKSPACE TỰ ĐĂNG KÝ — CHẠY THỬ TRƯỚC, MỖI LẦN MỘT, KHÔNG BAO GIỜ ĐỤNG NHÀ HAY KHÁCH NGƯỜI VẬN HÀNH TẠO ═══════════
 *
 * Quyết định của chủ shop 08/10/2026: các cửa hàng TRƯỚC ĐÂY TỰ ĐĂNG KÝ (qua /start của vnx · chotdon) bị xoá hẳn để họ đăng ký lại từ
 * đầu khi hệ thống sẵn sàng. Tổ chức nhà và tổ chức người vận hành tạo (gồm khách thật) TUYỆT ĐỐI không đụng.
 *
 * ─── AI LÀ «TỰ ĐĂNG KÝ» ───
 * `brand` khác NULL CHƯA ĐỦ: người vận hành đặt được brand cho tổ chức cũ (`ORG_BRAND_SET`, lib/platform/org-brand.ts) và tạo được
 * workspace mang brand từ /platform/saas (job `CREATE_CUSTOMER`). Nên `SELF_SIGNUP` đòi CẢ HAI: brand khác NULL VÀ chứng cứ của lượt
 * tự đăng ký (`settings.onboarding.source` ∈ OPEN · INVITE, hoặc một lượt `platform_signup_attempts` CREATED chế độ open / invite) —
 * và KHÔNG một dấu hiệu nào của người vận hành. Thiếu chứng cứ ⇒ `UNVERIFIED` ⇒ không xoá (bên an toàn).
 *
 * ─── TIỀN THẬT THÌ DỪNG ───
 * Không xoá một dòng sổ tiền nào: tiền đã về (`platform_billing_payments`), hoá đơn / phiếu nạp ĐÃ TRẢ, sổ cái Số dư AI (chỉ ghi thêm —
 * tests/ai-balance.test.ts), sổ chi phí ngoài AI, bảng kê đã chốt. Có bất kỳ dòng nào ⇒ TỪ CHỐI cả tổ chức, người vận hành quyết.
 * Giữ nguyên dòng sổ mà vẫn xoá tổ chức là sai theo cách khác: mã tổ chức được DÙNG LẠI khi khách đăng ký lại cùng tên cửa hàng
 * (lib/onboarding/quick.ts::freeOrgCode), và tổ chức mới sẽ thừa kế số dư / chi phí của tổ chức cũ.
 *
 * ─── MỖI BẢNG MẶT PHẲNG ĐIỀU KHIỂN MỘT QUYẾT ĐỊNH ───
 * `OFFBOARD_TABLES` khai ĐÚNG mọi bảng của `CONTROL_PLANE_TABLES` (bài kiểm so hai danh sách): thêm bảng `platform_*` mới mà không quyết
 * nó đi đâu khi xoá tổ chức thì bài kiểm đỏ. Bốn quyết định: XOÁ (dòng của tổ chức) · GIỮ (lịch sử, không dữ liệu người) · CHẶN (dòng
 * tiền — có là từ chối) · CHUNG (không thuộc tổ chức nào). Bảng khoá theo MÃ đều XOÁ, kể cả sổ đo — mã sẽ được dùng lại.
 *
 * ─── THỨ TỰ KHI GHI ───
 *  1. nhật ký nền tảng `ORG_OFFBOARD` (`offboard:start`, số dòng từng bảng, KHÔNG tên / email / SĐT) — TRƯỚC mọi lượt xoá;
 *  2. gỡ đăng ký webhook Meta của page (khi tổ chức còn ACTIVE — token page nằm trong CSDL tổ chức), cố gắng hết sức;
 *  3. ĐÌNH CHỈ (`SUSPENDED`): webhook theo token / trang đăng nhập / job thôi vào tổ chức ngay (đệm sổ 10 giây);
 *  4. đóng handle của tiến trình này, ĐỢI kết nối của ứng dụng tự rã (bể `pg` đóng kết nối rảnh sau 10 giây) rồi `DROP DATABASE`
 *     KHÔNG `FORCE` — cắt ngang kết nối đang rảnh của ứng dụng làm bể ấy phát lỗi không ai nghe và sập tiến trình. Còn kết nối ⇒
 *     DỪNG ở đây (tổ chức vẫn đình chỉ, dữ liệu mặt phẳng điều khiển nguyên), chạy lại sau;
 *  5. xoá dòng mặt phẳng điều khiển trong MỘT giao dịch (bảng con trước, tài khoản cuối);
 *  6. nhật ký `offboard:done` + đếm lại.
 * CSDL xoá TRƯỚC dòng sổ: hỏng giữa chừng thì dòng tổ chức còn ⇒ chạy lại đi tiếp (`DROP … IF EXISTS`); làm ngược lại thì một CSDL mồ
 * côi không còn dòng nào trỏ tới. Đã xoá xong ⇒ chạy lại trả «không có tổ chức».
 *
 * Chỉ script vận hành gọi (scripts/org-offboard.ts) — không server action, không trang (tests/org-offboard.test.ts quét mã nguồn).
 */

export const OFFBOARD_SCRIPT_LABEL = "script:org-offboard";
export const OFFBOARD_REASON = "Xoá cửa hàng TỰ ĐĂNG KÝ trước đây để khách đăng ký lại từ đầu khi hệ thống sẵn sàng — quyết định của chủ shop 08/10/2026 (ops org-offboard)";
/** Trần chờ kết nối của ứng dụng tới CSDL tổ chức tự rã sau khi đình chỉ (bể `pg` đóng kết nối rảnh sau 10 giây; đệm sổ 10 giây). */
export const OFFBOARD_CONNECTION_WAIT_MS = 60_000;

export type OffboardDisposition = "DELETE" | "KEEP" | "BLOCK" | "GLOBAL";
export type OffboardKind = "HOME" | "SELF_SIGNUP" | "OPERATOR_CREATED" | "UNVERIFIED";

/** Phạm vi một lượt xoá: tổ chức + tài khoản (chỉ xoá tài khoản khi nó CHỈ sở hữu workspace này). */
type Scope = { orgId: string; code: string; accountId: string | null; deleteAccount: boolean };
type TableSpec = { disposition: OffboardDisposition; why: string; where?: (s: Scope) => SQL | null };

const byCode = (s: Scope) => sql`org_code = ${s.code}`;
const byCodeOrDeletedAccount = (s: Scope) => (s.deleteAccount && s.accountId ? sql`(org_code = ${s.code} or account_id = ${s.accountId})` : sql`org_code = ${s.code}`);

export const OFFBOARD_TABLES: Readonly<Record<ControlPlaneTable, TableSpec>> = {
  platform_organizations: { disposition: "DELETE", why: "Dòng sổ tổ chức (gồm settings.onboarding mang email quản trị) — mất dòng ⇒ đăng nhập / webhook theo token trả 401, mã trống để đăng ký lại.", where: (s) => sql`id = ${s.orgId}` },
  platform_organization_modules: { disposition: "DELETE", why: "Module của tổ chức (khoá ngoài tới dòng tổ chức).", where: (s) => sql`organization_id = ${s.orgId}` },
  platform_flag_overrides: { disposition: "DELETE", why: "Cờ nền tảng của tổ chức (khoá ngoài tới dòng tổ chức).", where: (s) => sql`organization_id = ${s.orgId}` },
  platform_audit_log: { disposition: "KEEP", why: "Nhật ký nền tảng CHỈ THÊM — lịch sử là thứ được giữ lại, kèm dòng ORG_OFFBOARD của chính lượt xoá.", where: (s) => sql`target_org_code = ${s.code}` },
  platform_plans: { disposition: "GLOBAL", why: "Gói dịch vụ — của nền tảng." },
  platform_signup_invites: { disposition: "KEEP", why: "Mã mời đã dùng (chỉ băm, không dữ liệu người) — lịch sử; mã dùng một lần nên không mở lại được.", where: (s) => sql`organization_code = ${s.code}` },
  platform_signup_attempts: { disposition: "KEEP", why: "Lượt đăng ký (IP chỉ băm) — nguồn ĐẾM của trần chống dò, đồng thời là chứng cứ «tự đăng ký».", where: (s) => sql`organization_code = ${s.code}` },
  platform_settings: { disposition: "GLOBAL", why: "Cài đặt của nền tảng." },
  platform_ai_usage: { disposition: "DELETE", why: "Sổ dùng AI theo MÃ — mã được dùng lại khi đăng ký lại; tổng chi phí theo nguồn được chép vào nhật ký ORG_OFFBOARD trước khi xoá.", where: byCode },
  platform_subscriptions: { disposition: "DELETE", why: "Cấu hình thu phí thuê bao (không phải tiền — tiền nằm ở platform_billing_payments).", where: byCode },
  platform_invoices: { disposition: "DELETE", why: "Hoá đơn đã huỷ / hết lượt — hoá đơn ĐÃ TRẢ là tiền thật (chặn ở MONEY_CHECKS VÀ không bao giờ khớp điều kiện xoá), hoá đơn OPEN còn nhận tiền được ⇒ từ chối.", where: (s) => sql`org_code = ${s.code} and status <> 'PAID'` },
  platform_billing_payments: { disposition: "BLOCK", why: "Tiền đã về tài khoản — không bao giờ xoá; có dòng ⇒ từ chối.", where: (s) => sql`(org_code = ${s.code} or invoice_id in (select id from platform_invoices where org_code = ${s.code}) or payment_intent_id in (select id from platform_payment_intents where org_code = ${s.code}))` },
  platform_identities: { disposition: "DELETE", why: "Chỉ mục email / SĐT / Google / Facebook ⇒ tổ chức — dữ liệu người, phải đi cùng tổ chức.", where: byCode },
  platform_saas_daily: { disposition: "DELETE", why: "Ảnh chụp MRR theo ngày, khoá theo MÃ — mã được dùng lại.", where: byCode },
  platform_org_milestones: { disposition: "DELETE", why: "Mốc kích hoạt GHI MỘT LẦN theo MÃ — để lại thì tổ chức đăng ký lại cùng mã «đã đạt» mốc của tổ chức cũ.", where: byCode },
  platform_tenant_usage_daily: { disposition: "DELETE", why: "Sổ dùng theo ngày, khoá theo MÃ.", where: byCode },
  platform_messenger_pages: { disposition: "DELETE", why: "Chỉ mục page Messenger ⇒ tổ chức — mất dòng ⇒ webhook Meta bỏ qua page, không rơi về tổ chức nào.", where: byCode },
  platform_phone_otps: { disposition: "GLOBAL", why: "Mã xác minh SĐT — khoá theo SĐT, không theo tổ chức; tự hết hạn." },
  platform_org_pricing: { disposition: "DELETE", why: "Ghi đè giá / tính năng của tổ chức.", where: byCode },
  platform_accounts: { disposition: "DELETE", why: "Tài khoản thương mại — CHỈ khi nó sở hữu đúng workspace này; dùng chung ⇒ giữ.", where: (s) => (s.deleteAccount && s.accountId ? sql`id = ${s.accountId}` : null) },
  platform_product_subscriptions: { disposition: "DELETE", why: "Thuê bao sản phẩm của workspace (và của tài khoản bị xoá — khoá ngoài).", where: byCodeOrDeletedAccount },
  platform_usage_events: { disposition: "DELETE", why: "Sổ dùng chung theo MÃ.", where: byCode },
  platform_cost_entries: { disposition: "BLOCK", why: "Sổ chi phí của nền tảng — huỷ thì giữ dòng, không xoá; có dòng ⇒ từ chối.", where: (s) => (s.deleteAccount && s.accountId ? sql`(org_code = ${s.code} or account_id = ${s.accountId})` : sql`org_code = ${s.code}`) },
  platform_billing_statements: { disposition: "BLOCK", why: "Bảng kê kỳ ĐÃ CHỐT là bất biến (luật 21) — có dòng của tài khoản bị xoá ⇒ từ chối.", where: (s) => (s.deleteAccount && s.accountId ? sql`account_id = ${s.accountId}` : null) },
  platform_provisioning_jobs: { disposition: "DELETE", why: "Job cấp phát (đầu vào có thể mang email) của workspace / tài khoản bị xoá.", where: byCodeOrDeletedAccount },
  platform_price_versions: { disposition: "GLOBAL", why: "Phiên bản bảng giá — của nền tảng." },
  platform_plan_prices: { disposition: "GLOBAL", why: "Giá gói theo phiên bản — của nền tảng." },
  platform_price_pins: { disposition: "DELETE", why: "Ghim phiên bản giá của tổ chức.", where: byCode },
  platform_ai_accounts: { disposition: "DELETE", why: "Trạng thái + ngưỡng Số dư AI (không có cột số dư — số dư là tổng sổ cái).", where: byCode },
  platform_ai_ledger_entries: { disposition: "BLOCK", why: "Sổ cái Số dư AI CHỈ GHI THÊM — có dòng (kể cả tặng / trừ) ⇒ từ chối; mã dùng lại sẽ thừa kế số dư.", where: byCode },
  platform_payment_intents: { disposition: "DELETE", why: "Phiếu nạp hết hạn / đã huỷ — phiếu ĐÃ TRẢ là tiền thật (chặn ở MONEY_CHECKS VÀ không bao giờ khớp điều kiện xoá), phiếu PENDING còn hạn ⇒ từ chối.", where: (s) => sql`org_code = ${s.code} and status <> 'PAID'` },
  platform_org_health: { disposition: "DELETE", why: "Gương sức khoẻ của tổ chức (kết luận job sales-health, khoá theo MÃ) — để lại thì tổ chức đăng ký lại cùng mã thấy sự cố của tổ chức cũ.", where: byCode },
  platform_auth_failures: { disposition: "DELETE", why: "Lỗi đăng nhập của tổ chức (định danh đã băm + bản che) — dữ liệu người, đi cùng tổ chức; dòng không quy được về tổ chức nào (org_code NULL) không bị đụng.", where: byCode },
  platform_tenant_value_snapshots: { disposition: "DELETE", why: "Ảnh giá trị theo ngày, khoá theo MÃ (số đếm + tiền, không dữ liệu người) — để lại thì tổ chức đăng ký lại cùng mã thừa kế lịch sử giá trị của tổ chức cũ.", where: byCode },
  platform_tenant_health_daily: { disposition: "DELETE", why: "Sức khoẻ / rủi ro rời bỏ theo ngày, khoá theo MÃ (chỉ mã lý do) — mã được dùng lại.", where: byCode },
};

/** Thứ tự XOÁ trong giao dịch: bảng con trước, dòng tổ chức rồi mới tới tài khoản (khoá ngoài `platform_organizations.account_id`). */
export const OFFBOARD_DELETE_ORDER: readonly ControlPlaneTable[] = [
  "platform_organization_modules",
  "platform_flag_overrides",
  "platform_messenger_pages",
  "platform_identities",
  "platform_ai_usage",
  "platform_org_health",
  "platform_auth_failures",
  "platform_usage_events",
  "platform_saas_daily",
  "platform_org_milestones",
  "platform_tenant_usage_daily",
  "platform_tenant_value_snapshots",
  "platform_tenant_health_daily",
  "platform_org_pricing",
  "platform_price_pins",
  "platform_subscriptions",
  "platform_invoices",
  "platform_payment_intents",
  "platform_ai_accounts",
  "platform_provisioning_jobs",
  "platform_product_subscriptions",
  "platform_organizations",
  "platform_accounts",
];

/** Dòng tiền thật nằm TRONG bảng XOÁ được — có là từ chối (bảng `BLOCK` tự là kiểm tra). */
const MONEY_CHECKS: readonly { key: string; label: string; table: ControlPlaneTable; where: (s: Scope) => SQL }[] = [
  { key: "paid_invoices", label: "hoá đơn ĐÃ TRẢ", table: "platform_invoices", where: (s) => sql`org_code = ${s.code} and status = 'PAID'` },
  { key: "paid_intents", label: "phiếu nạp ĐÃ TRẢ", table: "platform_payment_intents", where: (s) => sql`org_code = ${s.code} and status = 'PAID'` },
  // Còn nhận tiền được: tiền về giữa lượt xoá sẽ khớp một mã không còn chủ. Huỷ / để hết hạn trước, rồi mới xoá.
  { key: "open_invoices", label: "hoá đơn còn MỞ (nhận tiền được)", table: "platform_invoices", where: (s) => sql`org_code = ${s.code} and status = 'OPEN'` },
  { key: "pending_intents", label: "phiếu nạp còn HẠN (nhận tiền được)", table: "platform_payment_intents", where: (s) => sql`org_code = ${s.code} and status = 'PENDING' and expires_at > now()` },
];

type Exec = { execute: (q: SQL) => Promise<unknown> };

/**
 * Đếm MỌI dòng tiền chặn việc xoá (bảng `BLOCK` + `MONEY_CHECKS`) trên `exec` — gọi lúc lập kế hoạch, NGAY TRƯỚC `DROP DATABASE`,
 * và TRONG giao dịch xoá sau khi khoá dòng tổ chức: tiền về trong cửa sổ gỡ Meta / đình chỉ / đợi kết nối vẫn bị bắt
 * (`creditTopupFromBankRow` khớp mã ERPNAP không xét trạng thái tổ chức, kể cả phiếu đã hết hạn).
 */
async function moneyBlockers(exec: Exec, scope: Scope): Promise<{ label: string; rows: number }[]> {
  const out: { label: string; rows: number }[] = [];
  for (const table of CONTROL_PLANE_TABLES) {
    const spec = OFFBOARD_TABLES[table];
    const where = spec.disposition === "BLOCK" ? (spec.where?.(scope) ?? null) : null;
    if (where) out.push({ label: table, rows: count(await exec.execute(sql`select count(*)::int as n from ${sql.raw(table)} where ${where}`)) });
  }
  for (const m of MONEY_CHECKS) out.push({ label: m.label, rows: count(await exec.execute(sql`select count(*)::int as n from ${sql.raw(m.table)} where ${m.where(scope)}`)) });
  return out.filter((x) => x.rows > 0);
}

class MoneyArrivedError extends Error {
  constructor(readonly found: { label: string; rows: number }[]) {
    super("Có dòng tiền mới trong lúc xoá");
  }
}

export type OffboardSignals = {
  brand: string | null;
  /** `platform_organizations.settings.onboarding.source` — `OPEN` · `INVITE` · `OPERATOR` · `null` (không qua /start). */
  onboardingSource: string | null;
  /** Lượt `platform_signup_attempts` CREATED chế độ open / invite. */
  signupCreated: number;
  /** Lượt `platform_signup_attempts` CREATED chế độ operator (người vận hành tạo hộ). */
  operatorSignup: number;
  /** Nhật ký `ORG_BRAND_SET` — brand do NGƯỜI VẬN HÀNH đặt, không phải lúc khách đăng ký. */
  brandSetByOperator: number;
  /** Job cấp phát `CREATE_CUSTOMER` (tạo từ /platform/saas). */
  createCustomerJobs: number;
};

export type OffboardTableCount = { table: ControlPlaneTable; disposition: OffboardDisposition; rows: number };
export type OffboardMoney = { key: string; label: string; rows: number };
export type OrgDbFacts = { readable: boolean; reason: string | null; users: number | null; orders: number | null; activeConnections: string[] | null; activeChannelPages: number | null };

export type OffboardPlan = {
  org: { id: string; code: string; status: string; isHome: boolean; brand: string | null; accountId: string | null; createdAt: Date };
  kind: OffboardKind;
  signals: OffboardSignals;
  account: { id: string; type: string; workspaces: number; isHomeAccount: boolean; deleteAccount: boolean } | null;
  tables: OffboardTableCount[];
  money: OffboardMoney[];
  aiUsage: { rows: number; costUsdBySource: Record<string, number | null> };
  messengerPageIds: string[];
  database: { name: string; storage: "POSTGRES" | "PGLITE" | "MEMORY" | "EXTERNAL"; exists: boolean | null };
  orgDb: OrgDbFacts;
  /** Lý do TỪ CHỐI xoá (không tính `--confirm`). Rỗng ⇔ xoá được. */
  refusals: string[];
};

/** Hàm THUẦN: tổ chức thuộc loại nào, từ dấu hiệu đã đọc. Dấu hiệu người vận hành THẮNG mọi chứng cứ tự đăng ký. */
export function classifyOrganization(isHome: boolean, s: OffboardSignals): OffboardKind {
  if (isHome) return "HOME";
  if (s.onboardingSource === "OPERATOR" || s.operatorSignup > 0 || s.brandSetByOperator > 0 || s.createCustomerJobs > 0) return "OPERATOR_CREATED";
  if (s.brand !== null && (s.onboardingSource === "OPEN" || s.onboardingSource === "INVITE" || s.signupCreated > 0)) return "SELF_SIGNUP";
  return "UNVERIFIED";
}

/** Hàm THUẦN: vì sao KHÔNG được xoá. Rỗng ⇔ xoá được (vẫn cần `--confirm` khớp mã). */
export function offboardRefusals(p: Pick<OffboardPlan, "org" | "kind" | "signals" | "account" | "tables" | "money" | "database">): string[] {
  const out: string[] = [];
  if (p.org.isHome || p.kind === "HOME") out.push("tổ chức NHÀ — không bao giờ xoá");
  if (p.org.brand === null) out.push("brand NULL — không phải workspace tự đăng ký (nhà / người vận hành tạo / có từ trước 0215)");
  if (p.kind === "OPERATOR_CREATED") out.push(`có dấu hiệu NGƯỜI VẬN HÀNH tạo / đặt brand (onboarding ${p.signals.onboardingSource ?? "—"} · đăng ký operator ${p.signals.operatorSignup} · ORG_BRAND_SET ${p.signals.brandSetByOperator} · job CREATE_CUSTOMER ${p.signals.createCustomerJobs})`);
  if (p.kind === "UNVERIFIED" && p.org.brand !== null) out.push("brand có nhưng KHÔNG có chứng cứ tự đăng ký (onboarding OPEN / INVITE hoặc lượt đăng ký CREATED) — không đoán");
  for (const t of p.tables) if (t.disposition === "BLOCK" && t.rows > 0) out.push(`${t.table}: ${t.rows} dòng sổ tiền — không xoá, người vận hành quyết`);
  for (const m of p.money) if (m.rows > 0) out.push(`${m.label}: ${m.rows} dòng — tiền thật, không xoá`);
  if (p.account && !offboardDeletableAccountType(p.account.type)) out.push(`tài khoản thương mại loại ${p.account.type} — không phải khách ngoài`);
  if (p.account?.isHomeAccount) out.push("tài khoản thương mại dùng chung với tổ chức nhà");
  if (p.database.storage === "EXTERNAL") out.push("CSDL ở máy khác (ORG_DATABASE_URL__…) — xoá tay, script không đụng");
  if (p.database.storage === "POSTGRES" && Buffer.byteLength(p.database.name, "utf8") > 63) out.push("tên CSDL dài quá 63 byte — Postgres cắt định danh, không xoá theo một cái tên có thể trỏ nhầm");
  return out;
}

function count(rows: unknown): number {
  const [r] = rowsOf<{ n: number | string }>(rows);
  return Number(r?.n ?? 0);
}

function databaseStorage(code: string): OffboardPlan["database"]["storage"] {
  if ((process.env[`ORG_DATABASE_URL__${code.toUpperCase().replace(/-/g, "_")}`] || "").trim()) return "EXTERNAL";
  if (!isPglite()) return "POSTGRES";
  return organizationDatabaseUrl({ code, isHome: false }) === "pglite:memory" ? "MEMORY" : "PGLITE";
}

function pgliteDir(code: string): string {
  return organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, "");
}

async function databaseExists(code: string, storage: OffboardPlan["database"]["storage"]): Promise<boolean | null> {
  if (storage === "EXTERNAL" || storage === "MEMORY") return null;
  if (storage === "PGLITE") return existsSync(pgliteDir(code));
  const pdb = await getPlatformDb();
  return count(await pdb.execute(sql`select count(*)::int as n from pg_database where datname = ${organizationDatabaseName(code)}`)) > 0;
}

/** Đếm trong CSDL tổ chức qua handle CHỈ ĐỌC — không migrate, không tạo. Không đọc được ⇒ `readable: false` + lý do, không bao giờ 0. */
async function readOrgDbFacts(org: { code: string }, exists: boolean | null): Promise<OrgDbFacts> {
  const none = (reason: string): OrgDbFacts => ({ readable: false, reason, users: null, orders: null, activeConnections: null, activeChannelPages: null });
  if (exists === false) return none("CSDL không tồn tại");
  try {
    const db = await getDbForInspection({ code: org.code, isHome: false });
    const users = count(await db.execute(sql`select count(*)::int as n from users`));
    const orders = count(await db.execute(sql`select count(*)::int as n from orders`));
    const conns = rowsOf<{ k: string }>(await db.execute(sql`select connector_key as k from org_connections where status = 'ACTIVE' order by connector_key`)).map((r) => r.k);
    const pages = count(await db.execute(sql`select count(*)::int as n from org_channel_pages where status = 'ACTIVE'`));
    return { readable: true, reason: null, users, orders, activeConnections: conns, activeChannelPages: pages };
  } catch (error) {
    return none((error instanceof Error ? error.message : String(error)).slice(0, 200));
  }
}

/**
 * KẾ HOẠCH xoá một tổ chức — CHỈ ĐỌC. `null` = không có tổ chức mã này (đã xoá / gõ sai). Đọc thẳng `platform_organizations` (không qua
 * đệm sổ 10 giây) để lượt chạy lại ngay sau khi xoá trả lời đúng.
 */
export async function planOffboard(code: string): Promise<OffboardPlan | null> {
  const pdb = await getPlatformDb();
  const o = schema.platformOrganizations;
  const [row] = rowsOf<{ id: string; code: string; status: string; is_home: boolean; brand: string | null; account_id: string | null; created_at: Date | string; source: string | null }>(
    await pdb.execute(sql`select id, code, status, is_home, brand, account_id, created_at, settings #>> '{onboarding,source}' as source from ${o} where code = ${code} limit 1`),
  );
  if (!row) return null;
  const org = { id: row.id, code: row.code, status: row.status, isHome: Boolean(row.is_home), brand: row.brand ?? null, accountId: row.account_id ?? null, createdAt: new Date(row.created_at) };

  const signals: OffboardSignals = {
    brand: org.brand,
    onboardingSource: row.source ?? null,
    // Chứng cứ tự đăng ký chỉ tính lượt quanh lúc TẠO tổ chức này (mã từng thuộc tổ chức khác đã xoá thì lượt cũ không phải chứng cứ);
    // dấu hiệu người vận hành giữ phạm vi RỘNG — bên an toàn.
    signupCreated: count(await pdb.execute(sql`select count(*)::int as n from platform_signup_attempts where organization_code = ${code} and outcome = 'CREATED' and mode in ('open','invite') and at >= ${org.createdAt.toISOString()}::timestamptz - interval '1 day'`)),
    operatorSignup: count(await pdb.execute(sql`select count(*)::int as n from platform_signup_attempts where organization_code = ${code} and outcome = 'CREATED' and mode = 'operator'`)),
    brandSetByOperator: count(await pdb.execute(sql`select count(*)::int as n from platform_audit_log where target_org_code = ${code} and action = 'ORG_BRAND_SET'`)),
    createCustomerJobs: count(await pdb.execute(sql`select count(*)::int as n from platform_provisioning_jobs where org_code = ${code} and kind = 'CREATE_CUSTOMER'`)),
  };
  const kind = classifyOrganization(org.isHome, signals);

  let account: OffboardPlan["account"] = null;
  if (org.accountId) {
    const [a] = rowsOf<{ id: string; account_type: string }>(await pdb.execute(sql`select id, account_type from platform_accounts where id = ${org.accountId} limit 1`));
    if (a) {
      const workspaces = count(await pdb.execute(sql`select count(*)::int as n from platform_organizations where account_id = ${a.id}`));
      const isHomeAccount = count(await pdb.execute(sql`select count(*)::int as n from platform_organizations where account_id = ${a.id} and is_home`)) > 0;
      account = { id: a.id, type: a.account_type, workspaces, isHomeAccount, deleteAccount: workspaces === 1 && !isHomeAccount && offboardDeletableAccountType(a.account_type) };
    }
  }
  const scope: Scope = { orgId: org.id, code, accountId: account?.id ?? null, deleteAccount: account?.deleteAccount ?? false };

  const tables: OffboardTableCount[] = [];
  for (const table of CONTROL_PLANE_TABLES) {
    const spec = OFFBOARD_TABLES[table];
    const where = spec.where?.(scope) ?? null;
    // Tên bảng lấy từ hằng số trong mã (CONTROL_PLANE_TABLES), không từ đầu vào — nội suy an toàn.
    const rows = where ? count(await pdb.execute(sql`select count(*)::int as n from ${sql.raw(table)} where ${where}`)) : 0;
    tables.push({ table, disposition: spec.disposition, rows });
  }
  const money: OffboardMoney[] = [];
  for (const m of MONEY_CHECKS) money.push({ key: m.key, label: m.label, rows: count(await pdb.execute(sql`select count(*)::int as n from ${sql.raw(m.table)} where ${m.where(scope)}`)) });

  const usage = rowsOf<{ src: string; n: number | string; cost: number | string | null; priced: number | string }>(
    await pdb.execute(sql`select billing_source as src, count(*)::int as n, sum(cost_usd) as cost, count(cost_usd)::int as priced from platform_ai_usage where org_code = ${code} group by billing_source order by billing_source`),
  );
  const aiUsage = {
    rows: usage.reduce((s, r) => s + Number(r.n), 0),
    // Lượt chưa định giá không phải 0 USD (luật 42): nguồn có lượt chưa định giá ⇒ `null` = chưa biết trọn.
    costUsdBySource: Object.fromEntries(usage.map((r) => [r.src, Number(r.priced) === Number(r.n) && r.cost !== null ? Math.round(Number(r.cost) * 10_000) / 10_000 : null])),
  };
  const messengerPageIds = rowsOf<{ page_id: string }>(await pdb.execute(sql`select page_id from platform_messenger_pages where org_code = ${code} order by page_id`)).map((r) => r.page_id);

  const storage = databaseStorage(code);
  const exists = org.isHome ? null : await databaseExists(code, storage);
  const database = { name: org.isHome ? "(CSDL nhà)" : organizationDatabaseName(code), storage, exists };
  const orgDb = org.isHome || storage === "EXTERNAL" ? { readable: false, reason: org.isHome ? "tổ chức nhà — không đọc" : "CSDL ở máy khác", users: null, orders: null, activeConnections: null, activeChannelPages: null } : await readOrgDbFacts(org, exists);
  // Lượt chạy thử không giữ kết nối tới CSDL của khách sau khi đếm xong.
  if (!org.isHome) await releaseOrganizationDb(code, { inspectionOnly: true });

  const base = { org, kind, signals, account, tables, money, database };
  return { ...base, aiUsage, messengerPageIds, orgDb, refusals: offboardRefusals(base) };
}

const DISPOSITION_LABEL: Record<OffboardDisposition, string> = { DELETE: "XOÁ", KEEP: "GIỮ", BLOCK: "CHẶN", GLOBAL: "CHUNG" };
const KIND_LABEL: Record<OffboardKind, string> = { HOME: "NHÀ", SELF_SIGNUP: "TỰ ĐĂNG KÝ", OPERATOR_CREATED: "NGƯỜI VẬN HÀNH TẠO", UNVERIFIED: "CHƯA XÁC MINH" };

/**
 * Hàm THUẦN: dòng in của một kế hoạch. `summary` đi ra log CÔNG KHAI (kho PUBLIC) — chỉ mã tổ chức, loại, số đếm, phán quyết: KHÔNG
 * tên, email, SĐT, mã page. `detail` chỉ nằm ở phần MÃ HOÁ.
 */
export function offboardPlanLines(p: OffboardPlan): { summary: string[]; detail: string[] } {
  const del = p.tables.filter((t) => t.disposition === "DELETE" && t.rows > 0);
  const keep = p.tables.filter((t) => t.disposition === "KEEP" && t.rows > 0);
  const db = p.database.exists === null ? (p.database.storage === "EXTERNAL" ? "ở máy khác" : "—") : p.database.exists ? "CÓ" : "không còn";
  const summary = [
    `${p.org.code} · ${KIND_LABEL[p.kind]} · trạng thái ${p.org.status} · brand ${p.org.brand ?? "NULL"} · tạo ${p.org.createdAt.toISOString().slice(0, 10)} · ${p.refusals.length ? "KHÔNG xoá được" : "XOÁ ĐƯỢC (cần --apply --confirm=<mã>)"}`,
    `${p.org.code} · chứng cứ: onboarding ${p.signals.onboardingSource ?? "—"} · đăng ký CREATED ${p.signals.signupCreated} · operator ${p.signals.operatorSignup} · ORG_BRAND_SET ${p.signals.brandSetByOperator} · CREATE_CUSTOMER ${p.signals.createCustomerJobs}`,
    `${p.org.code} · sẽ XOÁ: ${del.length ? del.map((t) => `${t.table} ${t.rows}`).join(" · ") : "0 dòng"} · CSDL ${p.database.name} (${db}) · GIỮ: ${keep.length ? keep.map((t) => `${t.table} ${t.rows}`).join(" · ") : "0"}`,
    `${p.org.code} · tiền: ${[...p.tables.filter((t) => t.disposition === "BLOCK").map((t) => `${t.table} ${t.rows}`), ...p.money.map((m) => `${m.label} ${m.rows}`)].join(" · ")} · page Meta ${p.messengerPageIds.length} · đơn ${p.orgDb.orders ?? "—"} · kết nối đang bật ${p.orgDb.activeConnections === null ? "—" : p.orgDb.activeConnections.length} · page kênh ${p.orgDb.activeChannelPages ?? "—"}${offboardHasActivity(p) ? " · ĐANG CÓ HOẠT ĐỘNG ⇒ --apply cần --allow-active" : ""}`,
    ...p.refusals.map((r) => `${p.org.code} · TỪ CHỐI: ${r}`),
  ];
  const detail = [
    `Tài khoản thương mại: ${p.account ? `${p.account.id} · ${p.account.type} · ${p.account.workspaces} workspace · ${p.account.deleteAccount ? "XOÁ cùng" : "GIỮ (dùng chung / nội bộ)"}` : "không gắn"}`,
    `CSDL tổ chức: ${p.orgDb.readable ? `người dùng ${p.orgDb.users} · đơn ${p.orgDb.orders} · kết nối đang bật ${(p.orgDb.activeConnections ?? []).join(", ") || "không"} · page kênh đang bật ${p.orgDb.activeChannelPages}` : `không đọc được — ${p.orgDb.reason}`}`,
    `Sổ AI sẽ xoá: ${p.aiUsage.rows} dòng · chi phí theo nguồn ${Object.entries(p.aiUsage.costUsdBySource).map(([k, v]) => `${k} ${v === null ? "—" : v.toFixed(4)} USD`).join(" · ") || "—"}`,
    `Page Messenger đang trỏ về tổ chức: ${p.messengerPageIds.join(", ") || "không"}`,
    ...p.tables.map((t) => `  ${DISPOSITION_LABEL[t.disposition]} · ${t.table}: ${t.disposition === "GLOBAL" ? "—" : t.rows}`),
  ];
  return { summary, detail };
}

/** Tổ chức đang có dữ liệu / kết nối sống: đơn, kết nối đang bật, page kênh / page Meta — hoặc CSDL còn mà không đọc được (chưa biết ≠ không có). */
export function offboardHasActivity(p: Pick<OffboardPlan, "orgDb" | "messengerPageIds" | "database">): boolean {
  if (p.messengerPageIds.length > 0) return true;
  if (!p.orgDb.readable) return p.database.exists !== false;
  return (p.orgDb.orders ?? 0) > 0 || (p.orgDb.activeConnections?.length ?? 0) > 0 || (p.orgDb.activeChannelPages ?? 0) > 0;
}

export type OffboardOptions = {
  /** `--confirm` — phải ĐÚNG mã. */
  confirm: string | null;
  /** `--created-before` — tổ chức phải được TẠO trước mốc này (người chạy khai rõ «cửa hàng TRƯỚC ĐÂY»). Thiếu ⇒ từ chối. */
  createdBefore: Date | null;
  /** `--allow-active` — bắt buộc khi tổ chức có đơn / kết nối / page đang bật (hoặc không đọc được CSDL). */
  allowActive: boolean;
};

export type OffboardDeps = {
  /**
   * Gỡ đăng ký webhook Meta cho các page (best effort) — gọi khi CSDL tổ chức còn (token page nằm trong đó), BẤT KỂ trạng thái tổ chức.
   * `failed` = page chưa gỡ được ⇒ in «cần gỡ tay». Thiếu ⇒ mọi page «cần gỡ tay»; chỉ mục vẫn bị xoá nên tin tới bị bỏ qua.
   */
  unsubscribeMeta?: (code: string, pageIds: readonly string[]) => Promise<{ ok: number; failed: number; note: string | null }>;
  /** Trần chờ kết nối của ứng dụng tự rã (ms). Mặc định `OFFBOARD_CONNECTION_WAIT_MS`. */
  connectionWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Móc cho bài kiểm: chạy NGAY TRƯỚC lượt đếm lại tiền ở hai cửa (trước DROP · trước giao dịch xoá) — mô phỏng tiền về giữa chừng. */
  hook?: (phase: "BEFORE_DROP" | "BEFORE_DELETE") => Promise<void>;
};

/** `lines` ra log CÔNG KHAI (kênh tóm tắt); `detail` chỉ ở phần MÃ HOÁ (câu lỗi có thể mang dữ liệu). */
export type OffboardResult =
  | { outcome: "GONE"; lines: string[]; detail: string[] }
  | { outcome: "REFUSED"; lines: string[]; detail: string[]; refusals: string[] }
  | { outcome: "WAITING_CONNECTIONS"; lines: string[]; detail: string[]; connections: number }
  | { outcome: "MONEY_ARRIVED"; lines: string[]; detail: string[]; found: { label: string; rows: number }[] }
  | { outcome: "DONE"; lines: string[]; detail: string[]; deleted: Record<string, number>; remaining: Record<string, number> };

/**
 * Đợi số kết nối KHÁC tới CSDL về 0, tối đa `waitMs`. Trả số còn lại (0 = xoá được). Không bao giờ cắt ngang kết nối: còn ⇒ nơi gọi DỪNG.
 */
export async function waitForNoConnections(countNow: () => Promise<number>, waitMs: number, pollMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms))): Promise<number> {
  let left = await countNow();
  for (let waited = 0; left > 0 && waited < waitMs; waited += pollMs) {
    await sleep(pollMs);
    left = await countNow();
  }
  return left;
}

async function otherConnections(dbName: string): Promise<number> {
  const pdb = await getPlatformDb();
  return count(await pdb.execute(sql`select count(*)::int as n from pg_stat_activity where datname = ${dbName} and pid <> pg_backend_pid()`));
}

/**
 * GONE: nếu nhật ký còn một lượt `offboard:start` mà chưa có `offboard:done` sau nó (lượt trước chết giữa giao dịch xoá và nhật ký
 * kết thúc), ghi bù `done` — để «đã xoá xong» đọc được từ nhật ký, không phải suy từ sự vắng mặt.
 */
async function closeDanglingStart(code: string): Promise<boolean> {
  const pdb = await getPlatformDb();
  const [last] = rowsOf<{ subject: string }>(await pdb.execute(sql`select subject from platform_audit_log where target_org_code = ${code} and action = 'ORG_OFFBOARD' order by at desc, id desc limit 1`));
  if (!last || last.subject === "offboard:done") return false;
  await platformAudit({ action: "ORG_OFFBOARD", targetOrgCode: code, subject: "offboard:done", before: { phase: last.subject }, after: { phase: "DONE", note: "Ghi bù: tổ chức đã không còn trong sổ ở lượt chạy lại" }, reason: OFFBOARD_REASON, source: "SCRIPT", actor: null });
  return true;
}

/**
 * XOÁ một tổ chức tự đăng ký. Mọi điều kiện kiểm lại trên dữ liệu MỚI ĐỌC ngay trước khi ghi; tiền đếm lại thêm HAI lần (trước DROP,
 * trong giao dịch xoá sau khi khoá dòng tổ chức). Không có tổ chức ⇒ `GONE` (chạy lại sau khi xoá là vô hại).
 */
export async function applyOffboard(code: string, opts: OffboardOptions, deps: OffboardDeps = {}): Promise<OffboardResult> {
  const plan = await planOffboard(code);
  if (!plan) {
    const closed = await closeDanglingStart(code);
    return { outcome: "GONE", lines: [`${code} · không có tổ chức — không có gì để xoá${closed ? " (đã ghi bù nhật ký offboard:done)" : ""}`], detail: [] };
  }
  const refusals = [...plan.refusals];
  if (opts.confirm !== code) refusals.push(`--confirm phải ĐÚNG mã tổ chức (${code})`);
  if (!opts.createdBefore) refusals.push("thiếu --created-before=<ISO> — khai rõ chỉ xoá tổ chức tạo TRƯỚC mốc nào");
  else if (!(plan.org.createdAt.getTime() < opts.createdBefore.getTime())) refusals.push(`tổ chức tạo ${plan.org.createdAt.toISOString()} — KHÔNG trước mốc --created-before`);
  if (offboardHasActivity(plan) && !opts.allowActive) {
    refusals.push(`tổ chức đang có hoạt động (đơn ${plan.orgDb.orders ?? "—"} · kết nối đang bật ${plan.orgDb.activeConnections?.length ?? "—"} · page kênh ${plan.orgDb.activeChannelPages ?? "—"} · page Meta ${plan.messengerPageIds.length}) — thêm --allow-active nếu chắc chắn`);
  }
  if (refusals.length) return { outcome: "REFUSED", lines: refusals.map((r) => `${code} · TỪ CHỐI: ${r}`), detail: [], refusals };

  const lines: string[] = [];
  const detail: string[] = [];
  const scope: Scope = { orgId: plan.org.id, code, accountId: plan.account?.id ?? null, deleteAccount: plan.account?.deleteAccount ?? false };
  const stopped = async (phase: string, after: Record<string, unknown>) =>
    platformAudit({ action: "ORG_OFFBOARD", targetOrgCode: code, targetAccountId: scope.accountId, subject: "offboard:stopped", before: { phase }, after, reason: OFFBOARD_REASON, source: "SCRIPT", actor: null });
  const rowsBefore = Object.fromEntries(plan.tables.filter((t) => t.disposition !== "GLOBAL").map((t) => [t.table, t.rows]));
  // 1 · Nhật ký TRƯỚC mọi lượt xoá — không tên, không email, không SĐT, không mã page.
  await platformAudit({
    action: "ORG_OFFBOARD",
    targetOrgCode: code,
    targetAccountId: scope.accountId,
    subject: "offboard:start",
    before: {
      status: plan.org.status,
      brand: plan.org.brand,
      kind: plan.kind,
      createdAt: plan.org.createdAt.toISOString(),
      createdBefore: opts.createdBefore?.toISOString() ?? null,
      allowActive: opts.allowActive,
      signals: plan.signals,
      rows: rowsBefore,
      aiUsage: plan.aiUsage,
      orders: plan.orgDb.orders,
      messengerPages: plan.messengerPageIds.length,
      database: plan.database,
      accountDeleted: scope.deleteAccount,
    },
    after: { phase: "STARTED" },
    reason: OFFBOARD_REASON,
    source: "SCRIPT",
    actor: null,
  });
  lines.push(`${code} · đã ghi nhật ký nền tảng ORG_OFFBOARD (offboard:start)`);

  // 2 · Gỡ đăng ký webhook Meta khi CSDL còn (token page nằm trong đó) — không phụ thuộc trạng thái tổ chức. Hỏng không chặn.
  if (plan.messengerPageIds.length) {
    const n = plan.messengerPageIds.length;
    if (plan.database.exists !== false && deps.unsubscribeMeta) {
      try {
        const r = await deps.unsubscribeMeta(code, plan.messengerPageIds);
        lines.push(`${code} · gỡ đăng ký webhook Meta: ${r.ok} được · ${r.failed} không${r.failed ? ` ⇒ ${r.failed} page CẦN GỠ TAY ở Meta` : ""}`);
        if (r.note) detail.push(`Gỡ webhook Meta: ${r.note}`);
      } catch (error) {
        lines.push(`${code} · gỡ đăng ký webhook Meta HỎNG ⇒ ${n} page CẦN GỠ TAY ở Meta (chi tiết ở phần mã hoá) — chỉ mục vẫn bị xoá, tin tới bị bỏ qua`);
        detail.push(`Gỡ webhook Meta hỏng: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      }
    } else {
      lines.push(`${code} · gỡ đăng ký webhook Meta: không làm được (${plan.database.exists === false ? "CSDL tổ chức không còn — không còn token page" : "máy không có đường gỡ"}) ⇒ ${n} page CẦN GỠ TAY ở Meta — chỉ mục vẫn bị xoá, tin tới bị bỏ qua`);
    }
  }

  // 3 · Đình chỉ: đăng nhập / webhook theo token / job thôi vào tổ chức.
  const pdb = await getPlatformDb();
  if (plan.org.status !== "SUSPENDED") {
    await pdb.execute(sql`update platform_organizations set status = 'SUSPENDED', updated_at = now() where id = ${plan.org.id}`);
    lines.push(`${code} · đã ĐÌNH CHỈ (${plan.org.status} → SUSPENDED)`);
  }
  invalidateOrganizations();
  invalidateCapabilities(code);

  // 4 · Xoá CSDL của tổ chức — KHÔNG `FORCE`; tiền đếm lại NGAY TRƯỚC.
  await releaseOrganizationDb(code);
  if (plan.database.storage === "POSTGRES") {
    const dbName = organizationDatabaseName(code);
    const wait = deps.connectionWaitMs ?? OFFBOARD_CONNECTION_WAIT_MS;
    const left = await waitForNoConnections(() => otherConnections(dbName), wait, deps.pollMs ?? 5_000, deps.sleep);
    if (left > 0) {
      lines.push(`${code} · CSDL ${dbName} còn ${left} kết nối sau ${Math.round(wait / 1000)} giây — DỪNG (không cắt ngang ứng dụng). Tổ chức đang ĐÌNH CHỈ, dữ liệu nguyên; chạy lại sau ít phút.`);
      await stopped("WAITING_CONNECTIONS", { connections: left });
      return { outcome: "WAITING_CONNECTIONS", lines, detail, connections: left };
    }
  }
  await deps.hook?.("BEFORE_DROP");
  const moneyNow = await moneyBlockers(pdb, scope);
  if (moneyNow.length) {
    lines.push(`${code} · TIỀN MỚI VỀ trong lúc xoá (${moneyNow.map((m) => `${m.label} ${m.rows}`).join(" · ")}) — DỪNG trước khi xoá CSDL. Tổ chức đang ĐÌNH CHỈ, CSDL + dữ liệu nguyên; người vận hành quyết.`);
    await stopped("BEFORE_DROP", { money: moneyNow });
    return { outcome: "MONEY_ARRIVED", lines, detail, found: moneyNow };
  }
  let dbDropped = false;
  if (plan.database.storage === "POSTGRES") {
    const dbName = organizationDatabaseName(code);
    // Tên đã qua regex của mã tổ chức (và trần 63 byte ở offboardRefusals) nên an toàn để nội suy vào DDL (cùng luật với provision.ts).
    await pdb.execute(sql.raw(`drop database if exists "${dbName}"`));
    dbDropped = true;
    lines.push(`${code} · đã xoá CSDL ${dbName}`);
  } else if (plan.database.storage === "PGLITE") {
    rmSync(pgliteDir(code), { recursive: true, force: true });
    dbDropped = true;
    lines.push(`${code} · đã xoá thư mục CSDL PGlite`);
  }

  // 5 · Dòng mặt phẳng điều khiển — MỘT giao dịch: khoá dòng tổ chức, đếm lại tiền (có ⇒ hoàn tác cả giao dịch), rồi xoá bảng con trước.
  await deps.hook?.("BEFORE_DELETE");
  const deleted: Record<string, number> = {};
  try {
    await pdb.transaction(async (tx) => {
      await tx.execute(sql`select id from platform_organizations where id = ${plan.org.id} for update`);
      const late = await moneyBlockers(tx, scope);
      if (late.length) throw new MoneyArrivedError(late);
      for (const table of OFFBOARD_DELETE_ORDER) {
        const where = OFFBOARD_TABLES[table].where?.(scope) ?? null;
        if (!where) continue;
        const res = rowsOf<{ n: number | string }>(await tx.execute(sql`with d as (delete from ${sql.raw(table)} where ${where} returning 1) select count(*)::int as n from d`));
        deleted[table] = Number(res[0]?.n ?? 0);
      }
    });
  } catch (error) {
    if (!(error instanceof MoneyArrivedError)) throw error;
    lines.push(`${code} · TIỀN MỚI VỀ ngay trước khi xoá dòng (${error.found.map((m) => `${m.label} ${m.rows}`).join(" · ")}) — đã HOÀN TÁC giao dịch, không xoá dòng nào. Tổ chức ĐÌNH CHỈ${dbDropped ? ", CSDL đã xoá" : ""}; người vận hành quyết.`);
    await stopped("BEFORE_DELETE", { money: error.found, databaseDropped: dbDropped });
    return { outcome: "MONEY_ARRIVED", lines, detail, found: error.found };
  }
  invalidateOrganizations();
  invalidateCapabilities(code);
  lines.push(`${code} · đã xoá dòng mặt phẳng điều khiển: ${Object.entries(deleted).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(" · ") || "0"}`);

  // 6 · Đếm lại + nhật ký kết thúc.
  const remaining: Record<string, number> = {};
  for (const table of OFFBOARD_DELETE_ORDER) {
    const where = OFFBOARD_TABLES[table].where?.(scope) ?? null;
    if (where) remaining[table] = count(await pdb.execute(sql`select count(*)::int as n from ${sql.raw(table)} where ${where}`));
  }
  const left = Object.entries(remaining).filter(([, n]) => n > 0);
  const dbLeft = await databaseExists(code, plan.database.storage);
  await platformAudit({ action: "ORG_OFFBOARD", targetOrgCode: code, targetAccountId: scope.accountId, subject: "offboard:done", before: { phase: "STARTED" }, after: { phase: "DONE", deleted, remaining: Object.fromEntries(left), databaseExists: dbLeft }, reason: OFFBOARD_REASON, source: "SCRIPT", actor: null });
  lines.push(`${code} · kiểm lại: ${left.length ? `CÒN ${left.map(([t, n]) => `${t} ${n}`).join(" · ")}` : "0 dòng còn lại ở mọi bảng XOÁ"} · CSDL ${dbLeft === null ? "—" : dbLeft ? "VẪN CÒN" : "không còn"} · nhật ký offboard:done`);
  return { outcome: "DONE", lines, detail, deleted, remaining };
}
