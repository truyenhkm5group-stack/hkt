# Nền tảng ERP — Hợp đồng chung (bắt buộc cho mọi agent)

> Agent KHÔNG tự tạo phiên bản riêng của bất kỳ thứ gì trong tệp này. Cần đổi hợp đồng ⇒ đề xuất
> với phiên tích hợp, sửa tệp này trước, rồi mới sửa mã. Kiến trúc và lý do: `target-architecture.md`.

## 1. Khái niệm chuẩn: `Organization`

Không dùng chữ `tenant` / `company` / `workspace` / `shop` trong identifier mới. Một khái niệm:
**Organization** (tiếng Việt: *tổ chức*). Mã `code` là khoá ổn định, dạng `^[a-z][a-z0-9-]{1,30}$`,
KHÔNG BAO GIỜ đổi (nó nằm trong JWT, khoá đệm, tên CSDL).

```ts
// lib/platform/types.ts  (client-safe, không import gì)
export type OrganizationStatus = "ACTIVE" | "SUSPENDED" | "ARCHIVED";
export type ModuleDefault = "ENABLED" | "DISABLED";

export type Organization = {
  id: string;              // uuid
  code: string;            // "vnx", "demo-wholesale" — bất biến
  name: string;
  status: OrganizationStatus;
  isHome: boolean;         // ĐÚNG MỘT tổ chức — CSDL là DATABASE_URL
  moduleDefault: ModuleDefault; // dòng module thiếu nghĩa là gì (P7)
  plan: string | null;     // chỗ cho billing sau này — Phase 1 không có luật nào đọc
  templateKey: string | null;
};
```

## 2. Mặt phẳng điều khiển (CSDL nhà, migration `0152_platform_control_plane`)

```sql
platform_organizations (
  id uuid pk default gen_random_uuid(), code text not null unique, name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','ARCHIVED')),
  is_home boolean not null default false,
  module_default text not null default 'DISABLED' check (module_default in ('ENABLED','DISABLED')),
  plan text, template_key text, settings jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
)  -- + unique index một dòng is_home = true (partial unique)

platform_organization_modules (
  organization_id uuid not null references platform_organizations(id),
  module_key text not null,
  enabled boolean not null,
  features jsonb not null default '{}',   -- { "<featureKey>": boolean } ghi đè mặc định của feature
  config jsonb not null default '{}',
  enabled_at timestamptz, disabled_at timestamptz,
  updated_by text,                        -- "<orgCode>:<userId>" hoặc "system:<nguồn>"
  updated_at timestamptz not null default now(),
  primary key (organization_id, module_key)
)

platform_flag_overrides (
  organization_id uuid not null references platform_organizations(id),
  flag_key text not null, enabled boolean not null,
  updated_by text, updated_at timestamptz not null default now(),
  primary key (organization_id, flag_key)
)

platform_audit_log (
  id uuid pk default gen_random_uuid(), at timestamptz not null default now(),
  actor_org_code text, actor_user_id text, actor_email text,   -- NULL cả ba = MÁY
  target_org_code text not null,
  action text not null,         -- MODULE_ENABLE · MODULE_DISABLE · FEATURE_SET · FLAG_SET · ORG_CREATE · ORG_STATUS
  subject text not null,        -- khoá module / feature / flag / mã tổ chức
  before jsonb, after jsonb, reason text, source text not null  -- UI · SCRIPT · MIGRATION · TEST
)
```

Migration CHỈ THÊM. Dòng dữ liệu duy nhất nó chèn: tổ chức nhà `code='vnx'`, `name='VNXcommerce'`,
`is_home=true`, `module_default='ENABLED'` (idempotent `on conflict do nothing`). Không chèn dòng
module nào cho tổ chức nhà: `module_default='ENABLED'` ⇒ mọi module bật, đúng hành vi hôm nay.

Drizzle: bảng khai trong `db/schema.ts` dưới khối `// ═══ NỀN TẢNG — mặt phẳng điều khiển ═══`,
tên export `platformOrganizations`, `platformOrganizationModules`, `platformFlagOverrides`,
`platformAuditLog`. Migration viết tay, idempotent (`IF NOT EXISTS`), `when` đặt LÚC TÍCH HỢP (lớn
hơn mọi `when` trên `main`).

## 3. Ngữ cảnh tổ chức — `lib/platform/context.ts` (chỉ máy chủ)

```ts
export type OrgContext = { code: string; isHome: boolean; source: OrgContextSource };
export type OrgContextSource = "EXPLICIT" | "SESSION" | "LEGACY_SESSION" | "HOME_DEFAULT";

/** Chạy fn trong ngữ cảnh tổ chức TƯỜNG MINH. Dùng cho job, webhook, script, kiểm thử. Lồng được;
 *  ngữ cảnh trong cùng thắng. Mã tổ chức không tồn tại / không ACTIVE ⇒ ném OrgContextError. */
export function withOrganization<T>(code: string, fn: () => Promise<T>): Promise<T>;

/** Ngữ cảnh hiện hành. Thứ tự: ALS tường minh → claim `org` của JWT phiên (đã xác minh chữ ký) →
 *  token cũ không có claim (LEGACY_SESSION ⇒ nhà) → không có phiên (HOME_DEFAULT ⇒ nhà). */
export function currentOrganization(): Promise<OrgContext>;

/** Chỉ đọc ALS, đồng bộ. `null` = không có ngữ cảnh tường minh. Dùng ở chỗ không await được. */
export function peekOrganization(): OrgContext | null;

export class OrgContextError extends Error { code: "ORG_UNKNOWN" | "ORG_INACTIVE" | "ORG_MISMATCH" }
```

Luật:
- Không ai được đọc `organization_id`/`org` từ query string, body, header do client gửi để đổi ngữ
  cảnh. Ngoại lệ DUY NHẤT: `POST /api/sync/[job]?org=<mã>` — tuyến máy-gọi-máy, đã xác thực bằng
  `CRON_SECRET` (bí mật của nền tảng, không của khách).
- Claim `org` trong JWT: tên `org`, giá trị `code`. `signSession()` BẮT BUỘC nhận `orgCode`.
  `middleware.ts` khi gia hạn PHẢI chép nguyên claim `org` (quên là đá người dùng tổ chức khác về
  tổ chức nhà — một lỗi rò, không phải lỗi giao diện). Có bài kiểm.
- Tổ chức `SUSPENDED` / `ARCHIVED`: phiên của họ bị từ chối (`denied: "ORG_INACTIVE"`), job bỏ qua.

## 4. CSDL — `db/index.ts`

```ts
export async function getDb(): Promise<Db>;               // CSDL của currentOrganization() — KHÔNG ĐỔI CHỮ KÝ
export async function getPlatformDb(): Promise<Db>;       // luôn CSDL nhà (mặt phẳng điều khiển)
export async function getDbFor(orgCode: string): Promise<Db>; // tường minh — chỉ dùng trong lib/platform/*
export function organizationDatabaseUrl(org: { code: string; isHome: boolean }): string;
```

- Tổ chức nhà ⇒ `DATABASE_URL` và đúng handle singleton hiện có (không đổi bể, không đổi hành vi).
- Tổ chức khác ⇒ URL dẫn xuất: Postgres `…/<tên-csdl>_org_<code với - thành _>`; PGlite
  `pglite://<thư-mục>-org-<code>`. Ghi đè bằng biến môi trường `ORG_DATABASE_URL__<CODE_HOA>` (cho
  CSDL ở máy khác). **Không lưu chuỗi kết nối (có mật khẩu) trong CSDL.**
- Bể kết nối tổ chức khác: `PGPOOL_MAX_ORG` (mặc định 2).
- Mở CSDL tổ chức khác lần đầu ⇒ `ensureMigrated(org)` (advisory lock trên Postgres) TRƯỚC khi trả handle.
- `isPglite()` vẫn đọc `DATABASE_URL`: mọi tổ chức cùng một loại driver.

## 5. Sổ module — `lib/constants/platform-modules.ts` (thuần, client-safe)

```ts
export type ModuleCategory = "CORE" | "COMMERCE" | "OPERATIONS" | "FINANCE" | "PEOPLE" | "MARKETING" | "INDUSTRY" | "CONNECTOR" | "INTELLIGENCE";
export type FeatureDef = { key: string; label: string; defaultEnabled: boolean; why: string };
export type ModuleDef = {
  key: ModuleKey; label: string; description: string; category: ModuleCategory;
  version: 1;
  core: boolean;                 // true ⇒ không tắt được, luôn bật
  dependsOn: ModuleKey[];
  features: FeatureDef[];        // khoá đầy đủ "<module>.<feature>"
  routes: string[];              // tiền tố đường dẫn trang + API sở hữu (khớp dài nhất thắng)
  permissions: string[];         // khoá quyền SỞ HỮU DUY NHẤT (một khoá thuộc tối đa một module)
  requiresHomeCredentials?: boolean; // connector dùng biến môi trường — Phase 1 chỉ tổ chức nhà bật được
  why: string;                   // vì sao module này tồn tại / ranh giới của nó
};
export const PLATFORM_MODULES: readonly ModuleDef[];
export const ORG_TEMPLATES: Record<string, { label: string; modules: ModuleKey[] }>; // "fashion-commerce", "wholesale"
```

**Khoá module là BẤT BIẾN** (nằm trong `platform_organization_modules.module_key`). Danh sách khởi đầu:

| Khoá | Nhãn | Core | Phụ thuộc | Tiền tố đường dẫn chính |
| --- | --- | --- | --- | --- |
| `core` | Nền tảng | ✔ | — | `/` (chỉ đúng `/`), `/settings`, `/audit`, `/departments`, `/data-quality`, `/module-disabled`, `/platform`, `/api/events`, `/api/notifications`, `/api/health`, `/api/perf`, `/api/refresh` |
| `integrations` | Kết nối dữ liệu | | — | `/integrations`, `/api/integrations` · `requiresHomeCredentials` (trang in secret webhook của tổ chức nhà — audit tích hợp 27/09) |
| `work` | Công việc & mục tiêu | ✔ | — | `/work` |
| `customers` | Khách hàng | | — | `/customers` |
| `products` | Sản phẩm | | — | `/products`, `/api/export/products` |
| `orders` | Đơn hàng | | customers, products | `/orders`, `/api/export/orders` |
| `inventory` | Kho | | products | `/inventory` (trừ các con thuộc module khác), `/inventory/receipts`, `/inventory/packing` |
| `purchasing` | Mua hàng | | inventory | `/inventory/purchasing`, `/inventory/shortage`, `/inventory/decisions` |
| `production` | Sản xuất | | products, inventory | `/production`, `/models`, `/inventory/planning`, `/inventory/workshop`, `/api/production`, `/api/export/planning` |
| `logistics` | Vận chuyển | | orders | `/shipments`, `/operations`, `/import-vtp`, `/api/shipments` |
| `returns` | Hàng hoàn | | orders, inventory | `/returns`, `/reports/returns`, `/inventory/returns`, `/api/export/return-rate` |
| `customer_care` | CSKH | | customers | `/cs` |
| `sales_channels` | Kênh bán (landing) | | orders | `/landing` |
| `marketing` | Marketing | | orders | `/ads`, `/ideas`, `/marketing`, `/outreach`, `/api/ideas`, `/api/creative` |
| `finance` | Tài chính | | — | `/finance`, `/finance-ops`, `/cod`, `/bank`, `/expenses`, `/reports` (trừ con thuộc module khác), `/cockpit`, `/api/export/cod`, `/api/export/report` |
| `payroll` | Lương & hoa hồng | | — | `/payroll`, `/my-payslip`, `/api/export/payroll` |
| `alerts` | Cần xử lý | | orders | `/alerts` |
| `ai` | Phòng Tech AI | | — | `/tech`, `/api/tech` |
| `connector_pancake` | Pancake POS | | orders | `/chatbot`, `/api/chatbot` (proxy tới bot DUY NHẤT, chạy trên Pancake Pages của tổ chức nhà) · `requiresHomeCredentials` |
| `connector_viettelpost` | Viettel Post | | logistics | · `requiresHomeCredentials` |
| `connector_meta` | Meta Ads | | marketing | · `requiresHomeCredentials` |
| `connector_bank` | Ngân hàng / SePay | | finance | · `requiresHomeCredentials` |
| `connector_messaging` | Lark / Telegram | | — | · `requiresHomeCredentials` |

Bảng trên là BẢN NHÁP có căn cứ (danh sách `page.tsx`/`route.ts` đo 27/09); agent B chốt từng tiền
tố bằng bài kiểm "mọi `page.tsx` và `route.ts` thuộc đúng một module". Webhook (`/api/webhooks/*`)
và `/api/sync` KHÔNG thuộc module theo đường dẫn — chúng chạy trong `withOrganization` và tự kiểm
module của connector tương ứng.

### 5.1 Luật gán quyền cho module (chốt theo mã thật, agent B)

Khoá quyền thuộc module M khi MỌI trang dùng nó làm cổng vào nằm trong M hoặc trong module phụ thuộc
M. Khoá dùng làm cổng cho trang của hai module không phụ thuộc nhau là **vô chủ** và khai tường minh
trong `UNOWNED_PERMISSIONS` kèm lý do (8 khoá: `planning:view/write`, `expenses:view/write`,
`reports:nominal`, `reports:returns`, `cod:write`, `cs:config`). Khoá vô chủ đi theo luật quyền cũ
(`can()` không chặn theo module); trang của chúng vẫn bị chặn bởi CỔNG ĐƯỜNG DẪN. Khoá chỉ mở một
phần trang của module khác vẫn thuộc module chủ (tắt module chủ ⇒ phần đó ẩn).

Export dùng chung (không agent nào viết lại): `MODULE_KEYS`, `PLATFORM_PERMISSION_KEYS`,
`MODULE_FREE_PATH_PREFIXES`, `moduleDef`, `isModuleKey`, `ModuleDependencyError`, `ModuleChangeResult`.
`moduleOfPath` CHUẨN HOÁ trước khi khớp (chữ thường, gộp `//`, giải mã `%`, bỏ `/` cuối) — `/PAYROLL`
bị chặn như `/payroll`.

## 6. Bộ phân giải năng lực — `lib/platform/capabilities.ts`

```ts
// thuần (client-safe) — đặt trong lib/constants/platform-modules.ts
export function moduleOfPath(pathname: string): ModuleKey | null;       // null = không thuộc module nào (công khai/webhook)
export function moduleOfPermission(permission: string): ModuleKey | null;
export function resolveEnabledModules(org: Pick<Organization, "moduleDefault">, rows: readonly ModuleRow[]): Set<ModuleKey>; // thuần: P7 + core + phụ thuộc
export function validateModuleChange(current: ReadonlySet<ModuleKey>, key: string, enable: boolean, opts?: { orgIsHome: boolean } /* mặc định false — hẹp hơn */): ModuleChangeResult;

// máy chủ
export async function getEnabledModules(orgCode?: string): Promise<Set<ModuleKey>>; // mặc định = currentOrganization()
export async function canUseModule(key: ModuleKey, orgCode?: string): Promise<boolean>;
export async function canUseFeature(featureKey: `${string}.${string}`, orgCode?: string): Promise<boolean>;
export async function assertModule(key: ModuleKey, orgCode?: string): Promise<void>;   // ném ModuleDisabledError (code "MODULE_DISABLED")
export async function pathAccess(pathname: string, orgCode?: string): Promise<{ module: ModuleKey | null; enabled: boolean }>;
export async function getModuleRows(orgCode?: string): Promise<{ organization: Organization; rows: ModuleRow[] }>;
// lib/platform/module-config.ts — ĐƯỜNG GHI DUY NHẤT
export async function setOrganizationModule(input: { orgCode; moduleKey; enabled; reason?; actor; source }): Promise<ModuleChangeResult & { changed?: boolean }>;
export async function setOrganizationFeature(input: { orgCode; featureKey; enabled; reason?; actor; source }): Promise<…>;
export function invalidateCapabilities(orgCode?: string): void;       // gọi sau mọi lượt ghi cấu hình
```

- Một chỗ duy nhất. Không nơi nào khác được đọc `platform_organization_modules`.
- Đệm trong tiến trình tối đa 5 giây + xoá ngay khi ghi (cùng tiến trình). Scheduler là tiến trình
  khác: trễ tối đa 5 giây — chấp nhận được, ghi trong `risk-register.md`.
- `resolveEnabledModules` luôn trả tập ĐÓNG dưới phụ thuộc: module bật mà phụ thuộc tắt (dữ liệu
  hỏng, gõ tay) ⇒ coi module đó là TẮT và `/platform/health` báo lỗi phụ thuộc. Hỏng về phía hẹp.

## 7. Phiên & cổng truy cập — `lib/auth/session.ts`

```ts
export type SessionUser = { /* …như cũ… */ organization?: { code: string; name: string; isHome: boolean }; modules?: string[] };
//   Tuỳ chọn CHỈ vì người dùng dựng tay trong kiểm thử; `resolveCurrentUser()` LUÔN điền cả hai.
//   `modules === undefined` ⇒ không cổng module (không bao giờ xảy ra trên đường production).
export type SessionDenyReason = /* …như cũ… */ | "ORG_INACTIVE" | "MODULE_DISABLED";
export function can(subject: SessionUser | Role, permission: Permission): boolean;
//   SessionUser: moduleOfPermission(permission) ∉ subject.modules ⇒ false (KỂ CẢ ADMIN), rồi luật cũ.
//   Role (chuỗi): không có ngữ cảnh tổ chức ⇒ luật cũ (chỉ dùng cho màn hình mẫu quyền).
export async function signSession(user: SessionIdentity & { orgCode: string }, opts?): Promise<string>;
```

- Middleware đặt header `x-erp-path` = `pathname` cho MỌI request đi qua nó, và XOÁ mọi header
  `x-erp-*` client gửi lên trước đó. Chỉ máy chủ đặt được header này.
- `resolveCurrentUser()`: đọc `x-erp-path`; `moduleOfPath(path)` là module tắt ⇒ `{ denied: "MODULE_DISABLED", module }`.
  `requireUser()` ⇒ chuyển tới `/module-disabled?m=<khoá>`; `getCurrentUser()` ⇒ `null`. Route API dùng
  `apiGuard(permission?, { format })` (`lib/auth/api-guard.ts`) ⇒ 401 / 403 `{ ok: false, error, code:
  "MODULE_DISABLED" | "ORG_INACTIVE" | "FORBIDDEN", module? }`; route trả chữ trần dùng `format: "text"`,
  mã nằm ở header `x-erp-deny`. 16/18 route đã chuyển; `export/payroll`, `export/planning` giữ nguyên
  (đổi là đổi hành vi — ghi ở risk-register).
- `readSessionTokenRaw()` NUỐT lỗi "ngoài request" (ngữ cảnh tổ chức cần thế); đường DANH TÍNH
  (`getSessionRaw`) giữ hợp đồng cũ "ngoài request ⇒ ném" vì `decideScope()` dựa vào nó.
- Claim gia hạn: `renewalClaims(payload, lgn)` (`lib/constants/session.ts`) chép NGUYÊN mọi claim trừ
  `iat/exp/nbf/sub/jti` — claim tương lai không bao giờ rơi khi gia hạn.
- Đăng nhập: ô "Mã tổ chức" (tuỳ chọn). Bỏ trống ⇒ tổ chức nhà. Mã không tồn tại / không ACTIVE ⇒
  cùng một câu lỗi với sai mật khẩu (không để dò mã tổ chức). Tra `users` trong `withOrganization(mã)`.
- Chống dò mật khẩu: khoá throttle thêm mã tổ chức.

## 8. Job & webhook

```ts
// lib/sync/runner.ts
runJob(job, opts) // bọc withOrganization(opts.org ?? tổ chức của NGỮ CẢNH HIỆN HÀNH) — người của B bấm đồng bộ
                  // không bao giờ chạy job cho nhà. Job cần credential env ở tổ chức khác ⇒ SKIPPED, không ghi sync_runs.
// Khoá "job đang chạy": `<org>:<nguồn>:<job>`; tổ chức nhà GIỮ dạng cũ `<nguồn>:<job>` (trang /integrations đọc nó).
```
- `JOB_DEFINITIONS` mỗi job khai `module: ModuleKey` (+ `alsoRequires?: ModuleKey[]` cho module
  nghiệp vụ mà connector không tự kéo theo). Job cần credential môi trường khai module CONNECTOR
  (Pancake · Viettel Post · Meta · SePay · Lark/Telegram; GitHub và khoá AI thuộc `tech`). `runJob`
  kiểm theo thứ tự: credential (tổ chức khác ⇒ `SKIPPED CONNECTOR_NOT_CONFIGURED`) rồi MỌI module
  của job (`canUseModule`, tắt ⇒ `SKIPPED MODULE_DISABLED` kèm tên module). Bỏ qua thì không ghi
  `sync_runs`, không ném. Lỗi đọc cấu hình module ⇒ NÉM (không đoán là bật).
- `fanOut: true` — chỉ job THUẦN CSDL (không trong `HOME_CREDENTIAL_JOBS`, không module cần
  credential): `dashboard-warm`, `outcome-materialize`, `work-recurrence`, `work-snapshot`,
  `data-check`. Bản sao cho bộ lập lịch ở `scripts/scheduler-fanout.mjs` (bài kiểm đòi bằng nhau).
- Bộ lập lịch: lịch của nhà GIỮ NGUYÊN (cùng URL, nhịp, lệch pha). `SCHEDULER_FANOUT=1` (mặc định TẮT
  — VPS 2 nhân, và đổi lịch phải hỏi chủ) thì sau lượt của nhà gọi thêm `/api/sync/<job>?org=<mã>`
  cho từng mã lấy từ `GET /api/sync/organizations` (CHỈ `CRON_SECRET`, trả `{ organizations: string[] }`
  = mã tổ chức ACTIVE không phải nhà; đệm 5 phút; lỗi ⇒ không fan-out lượt đó).
- Client tích hợp: `perOrganizationClients({ home, other })` (`lib/platform/credentials.ts`) — ngăn nhà
  là MỘT instance (ngữ cảnh tường minh của nhà hoặc không ngữ cảnh), ngăn tổ chức khác khoá bằng mã
  và KHÔNG BAO GIỜ dựng từ credential môi trường.
- Webhook: resolve tổ chức TƯỜNG MINH qua `resolveWebhookOrganization(provider)`. Phase 1.x vẫn: mọi
  connector chỉ gắn với tổ chức nhà (`requiresHomeCredentials`) ⇒ mọi dòng `WEBHOOK_BINDINGS` là
  `HOME_ONLY` (bài kiểm khoá). Nhà cung cấp không có trong bảng, hay chế độ lạ ⇒ NÉM, không rơi về nhà.
  Sau này: bảng liên kết tài khoản tích hợp → tổ chức.

## 9. Trạng thái mức tiến trình

- `memo(key, …)`: tổ chức không phải nhà ⇒ khoá thật là `org:<code>:<key>`. Tổ chức nhà giữ khoá
  cũ. `clearMemo()` / `staleMemo()` xoá/đánh dấu MỌI tổ chức (an toàn, chỉ tốn hiệu năng).
- `publish(event)`: gắn `org` (từ `currentOrganization()`); `subscribe` ở `/api/events` chỉ chuyển
  sự kiện cùng `org` với phiên.
- Credential từ `process.env` (danh sách `CUSTOMER_CREDENTIAL_ENV` trong `lib/env.ts`) là của tổ chức
  nhà. Mọi LỐI GỌI MẠNG dùng chúng gọi `assertHomeCredentials(provider)` (`lib/platform/credentials.ts`)
  TRƯỚC khi gửi — tổ chức khác ⇒ `ConnectorUnavailableError` (`CONNECTOR_NOT_CONFIGURED`), 0 lượt gọi mạng.
  Máy quét tĩnh đòi mọi tệp máy chủ gọi mạng khai rõ.
- Việc chạy SAU phản hồi (`after(`, promise bỏ rơi) đi qua `bindOrganization()` (`lib/platform/background.ts`).
- Webhook: `resolveWebhookOrganization(provider)` + `WEBHOOK_BINDINGS` (`lib/platform/webhooks.ts`).

## 10. Nhật ký

```ts
// lib/platform/audit.ts
export async function platformAudit(entry: { action; targetOrgCode; subject; before?; after?; reason?; source; actor?: { orgCode; userId; email } | null }): Promise<void>;
```
Mọi lượt ghi cấu hình module/feature/cờ/tổ chức gọi `platformAudit` (CSDL nhà) VÀ `audit()` (CSDL
của tổ chức bị đổi). Lỗi ghi `platformAudit` ⇒ lượt ghi cấu hình thất bại (không đổi cấu hình mà
không có vết).

## 11. Quyền mới

| Khoá | Ai | Làm gì |
| --- | --- | --- |
| `modules:manage` | ADMIN (mặc định) | bật/tắt module + feature CỦA CHÍNH tổ chức mình (`/settings/modules`) |
| `platform:operate` | chỉ tài khoản quản trị của TỔ CHỨC NHÀ có quyền này | xem `/platform` (mọi tổ chức, health), đổi module của tổ chức khác |

`platform:operate` không nằm trong mẫu vai trò mặc định nào ngoài ADMIN của tổ chức nhà, và vai trò
tuỳ chỉnh KHÔNG cấp được nó (cùng hàng rào `users:manage`, luật 31). Người của tổ chức không phải nhà
KHÔNG BAO GIỜ có `platform:operate`, kể cả ADMIN — kiểm ở `can()`, không chỉ ở giao diện.

## 12. Kiểm thử — tên tệp cố định

| Tệp | Chủ |
| --- | --- |
| `tests/platform-context.test.ts` | A — ngữ cảnh, định tuyến CSDL, migration tổ chức |
| `tests/platform-modules.test.ts` | B — sổ module (mọi route thuộc đúng một module, phụ thuộc không vòng), phân giải, bật/tắt |
| `tests/platform-rbac.test.ts` | C — claim `org`, gia hạn giữ claim, `can()` theo module, ADMIN không vượt, `platform:operate` |
| `tests/platform-isolation.test.ts` | D/QA — kịch bản E2E §55, truy cập trực tiếp theo id, máy quét tĩnh |

Mỗi tệp export `testXxx()` và được gọi trong `tests/sync-fixtures.test.ts`.
