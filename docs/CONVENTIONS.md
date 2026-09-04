# Quy ước mã nguồn — Shop Control ERP

Next.js 15 (App Router, React 19, TypeScript strict) · Tailwind CSS v4 · shadcn/ui (Radix, style new-york-v4) · Drizzle ORM · PostgreSQL (hoặc PGlite nhúng) · TanStack Table v8 · nuqs (URL state) · Recharts (qua `components/ui/chart.tsx`) · lucide-react · sonner (toast).

Ngôn ngữ giao diện: **tiếng Việt có dấu**. Tiền tệ VND (số nguyên). Thời gian hiển thị theo giờ Việt Nam (`lib/format.ts`).

## Cấu trúc

```
app/(dashboard)/<module>/page.tsx        # Server Component: đọc searchParams → query → render
app/(dashboard)/<module>/columns.tsx     # "use client": ColumnDef<Row>[] cho TanStack Table
app/(dashboard)/<module>/<x>-table.tsx   # "use client": bọc <DataTable columns={...} .../> (KHÔNG truyền columns/hàm từ server component)
app/(dashboard)/<module>/[id]/page.tsx   # trang chi tiết
lib/queries/<module>.ts                  # hàm truy vấn Drizzle (chỉ chạy server)
lib/actions/<module>.ts                  # "use server" server actions (kiểm tra quyền, audit, revalidatePath)
components/                              # UI dùng chung
db/schema.ts                             # schema + relations + types (Order, Shipment, ...)
```

## Truy cập DB

```ts
import { getDb, schema } from "@/db";
const db = await getDb();
const rows = await db.query.orders.findMany({ where: eq(schema.orders.id, id), with: { items: true } });
const [{ total }] = await db.select({ total: count() }).from(schema.orders).where(where);
```
Upsert: `db.insert(t).values(v).onConflictDoUpdate({ target: t.id, set: v })`. Enum types: `OrderStage`, `ShipmentStage`, `CodStatus`, `ExpenseCategory`, `Role` export từ `@/db/schema`.

## Trang danh sách (list page) — mẫu chuẩn

```tsx
// page.tsx (server)
const raw = await searchParams;
const params = parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["stage", "carrier"], sortable: [...], defaultPeriod: "30d" });
const { rows, total, pageCount } = await listShipments(params);
return (
  <div className="space-y-5">
    <PageHeader eyebrow="Vận chuyển" title="Vận đơn" description="..." actions={<SyncButton job="vtp-tracking" label="Cập nhật từ Viettel Post" />} />
    <DataTableToolbar searchPlaceholder="..." period={{ defaultKey: "30d" }} facets={[{ key: "stage", label: "Trạng thái", options: [{ value, label, count }] }]} resultLabel={`${total} vận đơn`} />
    <ShipmentsTable rows={rows} pageCount={pageCount} total={total} />   // client wrapper
  </div>
);
```
`ListParams` = `{ page, pageSize, sort, dir, q, filters: Record<string,string[]>, period: { from: Date|null, to: Date|null, key, label } }` (`lib/search-params.ts`).
`DataTable` (`components/data-table/data-table.tsx`) nhận `columns, data, pageCount, total, rowHref?, getRowId?, selectable?, bulkActions?(rows, clear)`. Sort/pagination được đồng bộ vào URL (`sort`, `dir`, `page`, `pageSize`). Cột có `meta: { align: "right" }` để căn phải; `enableSorting: false` nếu không sort được; `id` của cột sortable phải trùng khoá trong `sortable` của `parseListParams`.

## Component dùng chung (đã có)

- `PageHeader { eyebrow, title, description, actions }`
- `MetricCard { label, value, note, change, icon, tone }`
- `SectionCard { title, description, actions, padded, children }`, `DescriptionList { items, columns }`, `EmptyState`, `Money { value, compact }` — trong `components/ui-bits.tsx`
- Badge trạng thái: `OrderStageBadge`, `ShipmentStageBadge`, `CodStatusBadge`, `SourceBadge`, `RunStatusBadge` — `components/status-badge.tsx`
- `ShipmentTimeline { events }` — `components/shipment-timeline.tsx`
- `SyncButton { job, label, params, wait }` gọi `/api/sync/<job>`; `SyncOrderButton { orderId?, shipmentId? }` gọi `/api/refresh`
- `CopyButton`, `JsonViewer` — `components/misc.tsx`
- Toolbar: `DataTableToolbar`, `SearchInput`, `FacetFilter`, `PeriodFilter`, `ResetFilters` — `components/data-table/toolbar.tsx`
- shadcn/ui trong `components/ui/*` (button, card, dialog, sheet, select, tabs, table, badge, input, label, textarea, checkbox, switch, form, popover, command, dropdown-menu, alert-dialog, tooltip, skeleton, separator, progress, chart, calendar, ...)
- Format: `formatVND(n, { compact })`, `formatNumber`, `formatDate`, `formatDateTime`, `formatTimeAgo`, `vnDateKey`, `todayVN`, `pct` — `lib/format.ts`
- Hằng số: `ORDER_STAGE_LABEL/ORDER_STAGE_ORDER` (`lib/constants/pancake.ts`); `SHIPMENT_STAGE_LABEL/SHIPMENT_STAGE_ORDER/COD_STATUS_LABEL/VTP_STATUS/VTP_REASON_CODES` (`lib/constants/viettelpost.ts`)

## Xác thực & quyền

- Layout `(dashboard)` đã gọi `requireUser()`; trong page/action cần vai trò: `const user = await requireUser(["ADMIN","ACCOUNTANT"])` hoặc `can(user.role, "cod:write")` (`lib/auth/session.ts`). Quyền: `orders:read`, `cod:write`, `expenses:write`, `sync:run`, `users:manage`, `settings:manage`.
- Server action mẫu:
```ts
"use server";
export async function markPaidToBank(input: unknown) {
  const user = await requireUser();
  if (!can(user.role, "cod:write")) return { error: "Không có quyền" };
  const data = schema.parse(input); // zod
  ... // drizzle
  await audit({ userId: user.id, userEmail: user.email, action: "COD_PAID", entity: "SHIPMENT", entityId: id, detail: {...} });
  revalidatePath("/cod");
  return { ok: true };
}
```
- Form phía client: `useActionState` hoặc gọi action trong `startTransition` rồi `toast.success/error`; dialog dùng `Dialog`/`Sheet` của shadcn.

## Đồng bộ dữ liệu (đã có, chỉ gọi lại)

- Pancake: `lib/integrations/pancake/sync.ts` (`syncOrderById`, `syncProducts`, ...), job registry `lib/sync/jobs.ts` (`JOB_DEFINITIONS`), API `POST /api/sync/<job>?wait=0|1&...`.
- Viettel Post: `lib/integrations/viettelpost/sync.ts` (`syncViettelPostShipments({ shipmentIds })`, `importViettelPostOrders`), client `getViettelPostClient()` (`getOrderDetail`, `listPushHistory`, `rePush`, `testConnection`).
- Pancake client: `getPancakeClient().testConnection()`.
- Trạng thái đồng bộ: bảng `sync_runs`, `sync_state` (khoá `pancake.orders.updated_at.cursor`, `pancake.orders.backfill`, ...), `webhook_events`, `integration_tokens`.
- Realtime: `publish()` trong `lib/realtime/bus.ts` → SSE `/api/events` → `RealtimeProvider` gọi `router.refresh()`.

## Dữ liệu demo

`npm run seed:demo` tạo ~1.100 đơn, 71 mẫu mã, vận đơn Viettel Post, chi phí, quảng cáo (id bắt đầu bằng `demo-`). Tài khoản: `admin@shop.local` / `Admin@12345`.

## Kiểm tra

`npm run typecheck` (tsc) và `npm run lint` phải sạch. Không dùng `any`. Không truyền hàm từ Server Component sang Client Component. Ảnh dùng thẻ `<img>` thường với `// eslint-disable-next-line @next/next/no-img-element`.
