# Phase 4 — Dynamic Page Runtime: hợp đồng chung

> Khảo sát 28/09/2026 (chỉ đọc): kho đã có ~70% vật liệu — `MetricCard`/`StatStrip`, `METRIC_BINDINGS` +
> `resolveMetric` (số liệu qua ORDER_OUTCOME), `DataTable` + list view Phase 2, `DynamicForm`, `EntityTimeline`
> + `getOrderTimeline`/`getModelTimeline`/`getShipmentTimeline`, Recharts + `ChartContainer`, khuôn sổ
> `defineTool` (AI), `config-store` (nháp/xuất bản). Phase 4 là LỚP GHÉP, không phải hệ thứ hai.

## 1. Mười hai quyết định

**G1 — Trang là metadata của tổ chức** (CSDL tổ chức): bảng `meta_pages` (slug duy nhất, tên, module chủ,
quyền xem, menu, trạng thái) + nháp/xuất bản theo khuôn `config-store` (thêm `ConfigKind = "PAGE"`), ảnh chụp
xuất bản ở `meta_config_versions` (kind `PAGE`). Người dùng CHỈ thấy bản đã xuất bản.

**G2 — MỘT schema, MỘT renderer** (`lib/pages/types.ts`): `PageSchema → sections → blocks`, lưới 12 cột
(`span` ∈ 3/4/6/8/12), dưới `md` mọi khối rộng hết. Trần 8 section / 20 khối.

**G3 — Tám loại khối**: `kpi` · `table` · `chart` · `kanban` · `timeline` · `form` · `button` · `text`.
Mỗi loại khai trong `COMPONENT_REGISTRY` (`lib/pages/components.ts`): zod cấu hình, module/quyền phụ thuộc,
nguồn dữ liệu dùng, action dùng. Cấu hình kiểm ở MÁY CHỦ khi lưu nháp VÀ khi xuất bản.

**G4 — Nguồn dữ liệu là SỔ ĐÓNG** (`lib/pages/data-sources.ts`, chỉ máy chủ). Ba họ:
- *metric* — bọc `resolveMetric` / `METRIC_BINDINGS` + khoá mới cần cho trang mẫu (đơn hôm nay, doanh thu lên
  đơn, tồn khả dụng, hàng hoàn trong kỳ) — MỌI số đơn/doanh thu đi qua hàm có sẵn dựa trên ORDER_OUTCOME,
  không viết lại điều kiện `stage`; CHƯA BIẾT ⇒ `null` ⇒ "—" (luật 42).
- *list* — theo đối tượng của sổ đối tượng, bọc `list*(ListParams)` có sẵn + cột/lọc custom Phase 2.
- *series* — chuỗi cho biểu đồ (theo ngày / theo nhóm), bọc truy vấn có sẵn hoặc truy vấn mới trong `lib/queries/*`.
- *timeline* — `getOrderTimeline` / `getShipmentTimeline` / `getModelTimeline` + `domain_events` theo bản ghi.
Mỗi nguồn khai `module` + `permission` + trường/phép lọc được phép. **Trình phân giải kiểm module + quyền +
phạm vi dữ liệu (`requireResource`/scope-guard) theo NGƯỜI XEM ở mọi lượt đọc** — cấu hình trang KHÔNG BAO GIỜ
là ranh giới an ninh. Không SQL tự do, không biểu thức; lọc chỉ nhận `ListFilterOp` + field khai `filterable`.

**G5 — Action là SỔ ĐÓNG** (`lib/pages/actions.ts`, khuôn `defineTool`): `key`, đối tượng áp dụng, quyền,
zod đầu vào, mức tác động (`NONE`/`WRITE`), cần duyệt, handler gọi đường nghiệp vụ SẴN CÓ. MVP: `open_page`,
`open_record`, `create_record` (customer — cùng cổng Phase 2), `update_safe_field` (qua `saveCustomValues`),
`run_workflow` (bọc `runWorkflows` — không engine thứ hai), `request_approval` (qua luật workflow có cửa duyệt).
Nút gọi MỘT server action `executePageAction(slug, blockId, input)`: máy chủ đọc lại cấu hình ĐÃ XUẤT BẢN theo
`slug + blockId` (không tin cấu hình từ client) rồi mới gọi handler.

**G6 — Kanban** chỉ trên field custom kiểu `status` (Phase 2); đổi cột = `update_safe_field` ⇒
`saveCustomValues` ⇒ luật chuyển của field. Không đổi trạng thái HỆ THỐNG.

**G7 — Module tắt: CHẶN XUẤT BẢN** khi phụ thuộc biết trước (module chủ của trang hoặc của nguồn/action trong
khối). Nếu module bị tắt SAU khi đã xuất bản: khối hiện chỗ giữ "chưa bật", trang vẫn mở (không đổi dữ liệu).

**G8 — Quyền theo người xem ở MỖI khối**: thiếu quyền ⇒ khối không lấy dữ liệu (máy chủ từ chối) và hiện chỗ giữ
"không có quyền"; ẩn khối (`visibility`) chỉ là UX.

**G9 — Cô lập lỗi**: mỗi khối dựng riêng (Suspense + error boundary + try/catch ở trình phân giải) ⇒ khối hỏng
hiện chỗ giữ an toàn (người có `metadata:manage` thấy mã lỗi chẩn đoán), không lộ stack trace; trang có lỗi
cấu hình KHÔNG xuất bản được.

**G10 — Hiệu năng**: mọi khối phân giải SONG SONG (không nối tiếp), bảng luôn phân trang (≤ 100 dòng), kanban
≤ 200 thẻ, số liệu nặng dùng `memo` (khoá tự gắn tổ chức). Ghi thời gian dựng trang/khối vào `lib/perf/registry`.

**G11 — Route** `app/(dashboard)/p/[slug]` (tiền tố `/p` thuộc module `core` trong sổ module; module THẬT của
trang kiểm trong route). Tổ chức đi theo phiên (Phase 1), không đưa mã tổ chức vào URL.

**G12 — Menu động**: trang đã xuất bản có `nav.enabled` được nối vào menu qua adapter (`visibleGroups` /
`allowedNavItems` nhận thêm mục do máy chủ nạp) — không viết lại menu cũ. Quyền cấu hình: `metadata:manage`.

## 2. Lược đồ (migration `<số kế tiếp>_meta_pages`, CHỈ THÊM, CSDL tổ chức)

```sql
meta_pages (id text pk, slug text unique, name text, module_key text, required_permission text,
  nav jsonb default '{"enabled":false,...}', status text default 'ACTIVE' check in ('ACTIVE','ARCHIVED'),
  draft jsonb, published jsonb, published_version int default 0, published_at, published_by,
  created_by, updated_by, created_at, updated_at)
```

## 3. Dịch vụ (`lib/pages/*`) — chữ ký chốt

```ts
// registry.ts
listPages(opts?: { includeArchived?: boolean }): Promise<PageDefinition[]>;
getPageBySlug(slug): Promise<{ page: PageDefinition; schema: PageSchema } | null>;          // BẢN ĐÃ XUẤT BẢN
getPageDraft(id): Promise<{ page: PageDefinition; draft: PageSchema }>;
createPage(input, actor) / updatePageMeta(id, input, actor) / savePageDraft(id, schema, actor) / publishPage(id, actor) / archivePage(id, actor)
  → { ok: true; … } | { ok: false; code; errors: { path; message }[] }
validatePageSchema(schema, { modules: Set<ModuleKey> }): PageValidation;                    // components.ts — thuần
// data-sources.ts
resolveBlock(block, user: SessionUser, ctx: PageRenderContext): Promise<{ ok: true; data: unknown } | { ok: false; issue: BlockIssue }>;
listDataSources(user): { metrics; series; lists; timelines }                                 // cho trình soạn
// actions.ts
PAGE_ACTIONS; executePageAction(slug, blockId, input, user): Promise<{ ok: true; redirectTo?; message? } | { ok: false; error }>;
// templates.ts — mẫu trang (Sales Overview, Inventory Overview, Customer Workspace): chỉ tạo khi NGƯỜI bấm (luật 23), sinh ở NHÁP.
```

## 4. Chấp nhận

No-deploy (cùng PID + BUILD_ID): tạo trang → thêm KPI + bảng → xuất bản → trang mở ở `/p/<slug>` → thêm biểu đồ
→ xuất bản lại → tải lại thấy biểu đồ. Hai tổ chức: không thấy trang/cấu hình/dữ liệu của nhau; mở id/slug của
tổ chức kia ⇒ không tìm thấy; sửa tay cấu hình trỏ nguồn của module tắt ⇒ không xuất bản được; người thiếu quyền
Tài chính ⇒ khối KPI tài chính không lấy dữ liệu (máy chủ từ chối).
