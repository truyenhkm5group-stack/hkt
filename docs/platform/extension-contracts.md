# Hợp đồng mở rộng — năm điểm cắm đã có sổ

> Phase 9 · §4 (`docs/platform/phase-9-contracts.md`). Tài liệu này mô tả HÌNH DẠNG THẬT đọc từ mã, không phải
> một thiết kế mong muốn. Mỗi điểm cắm là một SỔ ĐÓNG: chỉ khoá khai trong sổ mới dùng được, và một bài kiểm đỏ
> khi sổ và mã lệch nhau. Chưa có chợ plugin: "thêm một mục" nghĩa là một PR vào kho mã, qua đủ cổng
> (`tsc` · lint · `npm test` · build) — không nạp mã lúc chạy, không `eval`, không SQL do người khai.

Luật chung cho cả năm điểm:

1. **Sổ là lời khai, không phải ranh giới an ninh.** Trình phân giải / máy chạy tự kiểm module + quyền + phạm vi
   theo NGƯỜI XEM ở mọi lượt. Một mục khai sai quyền không mở được cửa, chỉ làm bài kiểm đỏ.
2. **Không mục nào có công thức riêng.** Đơn / doanh thu / tồn / kết quả giao đi qua hàm có sẵn (`ORDER_OUTCOME`,
   `orderKpis`, sổ kho) — AGENTS.md mục 0, luật 3.
3. **Tổ chức lấy từ ngữ cảnh** (`currentOrganization()` / `getDb()`), không bao giờ từ tham số của mục.
4. **CHƯA BIẾT là `null`**, in «—» (luật 42).

---

## 1. Khối trang — `COMPONENT_REGISTRY` (`lib/pages/components.ts`)

**Hình dạng.** `BLOCK_TYPES` (`lib/pages/types.ts`) là tập đóng: `kpi · table · chart · kanban · timeline · form ·
button · text`. Mỗi loại có đúng một `ComponentSpec<T>`:

```ts
{ type; label; description; defaultSpan: BlockSpan;
  config: z.ZodType<BlockConfigByType[T]>;           // lược đồ cấu hình — kiểm lúc lưu nháp VÀ lúc xuất bản
  example: BlockConfigByType[T];                      // cấu hình mặc định khi thêm khối (khoá nguồn rỗng)
  dependencies: (config, catalog) => BlockDependency[] } // khoá sổ khối trỏ tới + module/quyền LẤY TỪ SỔ
```

Vẽ ở `components/pages/block-view.tsx` (máy chủ) + các khối client (`page-table.tsx`, `page-kanban.tsx`,
`page-form.tsx`, `page-action-button.tsx`); ô cấu hình ở `components/platform/pages/block-config-form.tsx`.

**Bài kiểm bắt buộc.** `tests/page-runtime.test.ts` (sổ phủ đúng `BLOCK_TYPES`, `validatePageSchema` với sổ giả tiêm
vào, cô lập lỗi từng khối), `tests/page-admin.test.ts` (nhãn, lỗi theo đường dẫn `sections.N.blocks.M.config.*`).

**Thêm một loại khối.** (1) thêm tên vào `BLOCK_TYPES` + kiểu cấu hình vào `BlockConfigByType`; (2) thêm mục
`COMPONENT_REGISTRY` (TypeScript đòi đủ khoá — thiếu là lỗi kiểu); (3) vẽ ở `block-view.tsx`; (4) ô cấu hình ở
`block-config-form.tsx`; (5) nếu khối đọc dữ liệu: nhánh trong `resolveBlock` (`lib/pages/data-sources.ts`) — và
nguồn của nó phải ở điểm cắm 2. Không đổi `renderPage` / `resolvePage`.

## 2. Nguồn dữ liệu — `lib/pages/catalog.ts` + `lib/pages/data-sources.ts`

**Hình dạng** (`lib/pages/types.ts`):

```ts
MetricSourceSpec   = { key; label; module; permission; format; periods; why }
SeriesSourceSpec   = { key; label; module; permission; kinds: ChartKind[]; format; periods; why }
ListSourceSpec     = { objectKey; label; module; permission; why }          // dẫn xuất từ sổ đối tượng
TimelineSourceSpec = { key; label; module; permission; recordObject; why }
```

Sổ (`METRIC_SOURCES`, `SERIES_SOURCES`, `LIST_SOURCES`, `TIMELINE_SOURCES`) thuần, client-safe — trình soạn đọc được.
Hàm đọc ở `data-sources.ts` (chỉ máy chủ): `METRIC_RUNNERS[key]`, `SERIES_RUNNERS[key]` + khai phạm vi
`*_SCOPE[key]`. `permission` = ĐÚNG khoá cổng vào của trang cũ cùng dữ liệu (không mượn khoá "gần đúng").

**Bài kiểm bắt buộc.** `tests/page-data.test.ts`: `METRIC_WIRING_GAPS`, `SERIES_WIRING_GAPS`, `TIMELINE_WIRING_GAPS`
phải rỗng (sổ ↔ hàm đọc hai chiều); số đơn của nguồn khớp `orderKpis`; module tắt / thiếu quyền / lọc sai ⇒ 0 lượt
gọi nguồn (`pageDataProbe.sourceCalls`).

**Thêm một nguồn.** Một dòng sổ ở `catalog.ts` + một hàm đọc (và khai phạm vi) ở `data-sources.ts` gọi hàm truy vấn
CÓ SẴN trong `lib/queries/*`. Hàm đọc nhận `Period`, trả `null` khi chưa biết.

## 3. Action — `PAGE_ACTIONS` (`lib/pages/catalog.ts`) + `HANDLERS` (`lib/pages/actions.ts`)

**Hình dạng.**

```ts
PageActionSpec = { key; label; module: ModuleKey | null; permission: string | null; objectKey?;
                   sideEffect: "NONE" | "WRITE"; requiresApproval: boolean; why }
HANDLERS: Record<string, (input, user, spec) => Promise<PageActionResult>>
PageActionResult = { ok: true; redirectTo?; message? } | { ok: false; error; code?; errors?: FieldError[] }
```

`executePageAction(slug, blockId, input, user, deps)` đọc bản ĐÃ XUẤT BẢN của trang (không tin cấu hình client gửi),
`actionAvailability` kiểm module + quyền + đối tượng trước khi chạy.

**Bài kiểm bắt buộc.** `tests/page-data.test.ts`: `PAGE_ACTION_HANDLER_KEYS` = khoá `PAGE_ACTIONS` (hai chiều); action
đọc bản đã xuất bản; thiếu quyền ⇒ không gọi handler.

**Thêm một action.** Một dòng `PAGE_ACTIONS` + một handler gọi Server-Action-lõi CÓ SẴN của miền (luật 19: đóng một
việc phải qua action của chính miền). `sideEffect: "WRITE"` phải có `permission`.

## 4. Trigger / action của luật tự động — `lib/workflow/*` + `lib/constants/domain-events.ts`

**Hình dạng** (`lib/workflow/types.ts`, tập ĐÓNG — không eval, không SQL do người khai, không HTTP ra ngoài, không đổi
trạng thái hệ thống đơn / vận đơn / COD / kho):

```ts
WorkflowTrigger = { kind: "event"; event }                         // event ∈ DOMAIN_EVENTS (status LIVE)
                | { kind: "custom_status"; objectKey; fieldKey; to; from? }
WorkflowAction  = { kind: "create_task"; … } | { kind: "notify"; message } | { kind: "set_custom_value"; field; value }
DomainEventSpec = { name; subjectType; owner; status: "LIVE" | "RESERVED"; emitter: string | null; why }
ACTION_RETRY_SAFETY: Record<WorkflowAction["kind"], { retrySafe: boolean; why }>
```

Luật mới luôn NHÁP + CHẠY THỬ (luật 23, 25); luật không nghe `workflow.*` (chặn vòng lặp).

**Bài kiểm bắt buộc.** `tests/workflow-admin.test.ts`, `tests/workflow-recovery.test.ts` (mỗi hành động khai căn cứ
làm lại không sinh bản sao; lượt treo được chiếm lại đúng một lần), `tests/company-os-models.test.ts` (sự kiện `LIVE`
có `emitter` là nơi DUY NHẤT phát tên đó).

**Thêm một trigger.** Thêm `DomainEventSpec` vào `DOMAIN_EVENTS` (tên khớp `DOMAIN_EVENT_NAME_PATTERN`), phát bằng
`emitDomainEvent` ở đúng MỘT tệp `emitter`, `status: "LIVE"` khi đã phát thật.
**Thêm một hành động.** Thêm biến thể vào `WorkflowAction`, nhánh thực thi trong `lib/workflow/actions.ts`, khai
`ACTION_RETRY_SAFETY` (TypeScript đòi đủ khoá) kèm căn cứ lũy đẳng kiểm được, lược đồ ở `lib/workflow/rules.ts`.

## 5. Connector — `CONNECTORS` (`lib/connectors/registry.ts`)

**Hình dạng.**

```ts
ConnectorSpec = {
  key; label; vendor;
  kind: "ORDER_SOURCE" | "SHIPPING" | "PAYMENT" | "ADS" | "MESSAGING" | "ACCOUNTING" | "AI" | "STORAGE" | "PLATFORM";
  capabilities: CAPABILITIES_BY_KIND[kind][number][];     // tập đóng theo loại
  auth: "API_KEY" | "USERNAME_PASSWORD" | "OAUTH_TOKEN" | "WEBHOOK_SECRET" | "NONE";
  settings: SettingField[];   // { key; label; type: "text" | "url"; secret; required; hint?; pattern?; maxLength?; envVar? }
  config: { store: "ENV" | "ORG_CONNECTIONS" | "SETTINGS_TABLE" | "NONE"; where };
  webhook: null | { path; verify; tenantResolution: "URL_SECRET" | "SIGNATURE" | "HOME_ONLY"; idempotencyKey; binding };
  tenancy: "HOME_ONLY" | "PER_ORG";
  health: "testConnection" | null; healthRef: "tệp::hàm" | null;
  module: ModuleKey; code: string[]; consumers: string[]; why;
}
```

Kết nối theo tổ chức (`config.store = "ORG_CONNECTIONS"`) lưu ở bảng `org_connections` của CSDL tổ chức, bí mật
AES-256-GCM (`lib/connectors/secrets.ts`), đọc/ghi DUY NHẤT qua `lib/connectors/service.ts`; hàm kiểm tra ở
`ORG_CONNECTION_TESTERS` (`lib/connectors/testers.ts`) nhận bí mật đã giải mã, không đọc biến môi trường.

**Bài kiểm bắt buộc.** `tests/connectors.test.ts`: mỗi tệp `lib/integrations/**` thuộc đúng một mục (hoặc
`INTEGRATION_HELPERS` kèm lý do); mỗi route `app/api/webhooks/**` có mục khai và chế độ khớp `WEBHOOK_BINDINGS`;
`healthRef` trỏ hàm có thật; `CUSTOMER_CREDENTIAL_ENV` có chủ; mã hoá (AAD, thiếu khoá ⇒ từ chối); hai tổ chức thật
không thấy nhau; không đường nào trả bí mật. Cộng thêm `tests/platform-isolation-static.test.ts` (lối gọi mạng mới
phải chặn `assertHomeCredentials` hoặc khai `GOI_MANG_KHONG_CREDENTIAL`; webhook mới phải qua
`resolveWebhookOrganization` + `withOrganization`).

**Thêm một connector.**
- Chỉ tổ chức nhà (credential môi trường): mục `tenancy: "HOME_ONLY"` + `envVar` từng ô; client gọi
  `assertHomeCredentials()` ở lối gửi request; getter client đi qua `perOrganizationClients`.
- Theo tổ chức: mục `tenancy: "PER_ORG"`, `config.store: "ORG_CONNECTIONS"`, ô bí mật `secret: true`, ô có `pattern`
  khi là URL / token (máy chủ chỉ gọi đúng máy của nhà cung cấp — chống SSRF); một hàm trong `ORG_CONNECTION_TESTERS`
  (nhận `fetch` tiêm được, không ném, che bí mật trong câu lỗi); luồng nào đọc nó thì khai vào `consumers` và đọc qua
  một hàm của `lib/connectors/service.ts` (không đọc thẳng bảng — bài kiểm quét).
- Webhook theo tổ chức (CHƯA có ở Phase 9): phải phân giải tổ chức TƯỜNG MINH trước khi ghi một byte (bí mật trong
  URL ⇒ `secret_hash → đúng một tổ chức` ở mặt phẳng điều khiển, hoặc chữ ký theo tổ chức), thêm chế độ vào
  `WEBHOOK_BINDINGS`, idempotent theo `idempotencyKey`, audit mỗi gói tin. Không suy tổ chức từ nội dung gói tin.
