# TECH-6: Phân Tích Kiến Trúc Server/Client & Ranh Giới Component

Tài liệu này phân tích kiến trúc của trang danh sách (orders, shipments) để xác định ranh giới Server Component / Client Component và luồng dữ liệu.

---

## 1. Tổng Quan Kiến Trúc Hiện Tại

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser (Client)                                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ URL in address bar:                                      │   │
│  │ http://localhost:3000/orders?period=month&pageSize=20   │   │
│  └──────────────────────────────────────────────────────────┘   │
│            ↓ (user clicks filter or sort)                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ <OrdersTable /> (Client Component, "use client")         │   │
│  │  ├─ Nhận props: { data, columns, pageCount, total, ... } │   │
│  │  └─ Gọi: router.push(newUrl) khi filter/sort thay đổi   │   │
│  └──────────────────────────────────────────────────────────┘   │
│            ↓ (URL changes)                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Next.js Router (nuqs library)                            │   │
│  │  └─ Thay đổi URL mà không reload page                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│            ↓ (URL changed, trigger page re-render)              │
└─────────────────────────────────────────────────────────────────┘
             ↓ HTTP Request to Server
┌─────────────────────────────────────────────────────────────────┐
│ Server (Node.js, Next.js)                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ app/(dashboard)/orders/page.tsx (Server Component)       │   │
│  │  ├─ NO "use client" directive                            │   │
│  │  ├─ async function OrdersPage({ searchParams })          │   │
│  │  ├─ Read searchParams from URL                           │   │
│  │  ├─ parseListParams(searchParams)                        │   │
│  │  ├─ const orders = await getOrdersList({ ... })          │   │
│  │  ├─ return <OrdersTable data={orders} columns={...} />   │   │
│  │  └─ HTML rendered on server                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│            ↓                                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ lib/queries/orders.ts: getOrdersList()                   │   │
│  │  ├─ Get database connection (getDb())                    │   │
│  │  ├─ Build SQL query with ORDER_OUTCOME logic             │   │
│  │  ├─ SELECT ... FROM orders                               │   │
│  │  │       LEFT JOIN shipments ON ...                      │   │
│  │  │       LEFT JOIN order_items ON ...                    │   │
│  │  │       WHERE [filters from searchParams]               │   │
│  │  │       ORDER BY [sort] [direction]                     │   │
│  │  │       LIMIT [pageSize] OFFSET [page]                  │   │
│  │  ├─ Execute query against PostgreSQL/PGlite              │   │
│  │  └─ Return array of orders with outcome                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│            ↓                                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Database (PostgreSQL 16 / PGlite)                        │   │
│  │  ├─ 50+ tables: orders, shipments, order_items, ...      │   │
│  │  ├─ Indexed on: created_at, stage, order_outcome (?)     │   │
│  │  └─ Row count: ~1,500–10,000 for demo/production         │   │
│  └──────────────────────────────────────────────────────────┘   │
│            ↓ (response HTML + data)                             │
└─────────────────────────────────────────────────────────────────┘
             ↓ HTTP Response
┌─────────────────────────────────────────────────────────────────┐
│ Browser (Client) — HTML Hydration                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ <OrdersTable /> Hydrates                                 │   │
│  │  ├─ Attach event listeners (on click, on change)         │   │
│  │  ├─ Restore state from props                             │   │
│  │  ├─ Ready for user interaction                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│            ↓ (user interaction again)                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ TanStack Table v8 (inside <DataTable>)                   │   │
│  │  ├─ Manages state: sorting, filtering, pagination        │   │
│  │  ├─ Calls: setSorting(), setFilters(), setPageIndex()    │   │
│  │  ├─ Triggers: onSortingChange, onColumnFiltersChange, .. │   │
│  │  └─ Inside TanStack callbacks: router.push(newUrl)       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Các File Quan Trọng

### 2.1 Server Component
**File:** `app/(dashboard)/orders/page.tsx`

```typescript
// NOT "use client" — this is a Server Component
import { getOrdersList } from '@/lib/queries/orders';
import { OrdersTable } from './orders-table';

interface OrdersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OrdersPage(props: OrdersPageProps) {
  // Giải mã searchParams
  const searchParams = await props.searchParams;
  
  // Chuẩn hóa params
  const { period, stage, sort, dir, page, pageSize, q } = parseListParams(searchParams);
  
  // Gọi truy vấn server-side
  const { data, total, pageCount } = await getOrdersList({
    period,
    stage,
    sort,
    dir,
    page,
    pageSize,
    q,
  });
  
  // Trả HTML + dữ liệu (server render)
  return (
    <OrdersTable
      data={data}
      columns={columns}
      total={total}
      pageCount={pageCount}
      defaultSort={sort}
      defaultDir={dir}
    />
  );
}
```

**Đặc điểm:**
- ✅ `async` function (có thể `await` queries)
- ✅ Gọi `getOrdersList()` từ `lib/queries/*` trực tiếp
- ✅ Không có state (`useState`, `useEffect`)
- ✅ Không có event listeners
- ❌ KHÔNG có `"use client"` directive

### 2.2 Client Wrapper Component
**File:** `app/(dashboard)/orders/orders-table.tsx`

```typescript
'use client';

import { DataTable } from '@/components/data-table';
import { columns } from './columns';
import { useRouter } from 'next/navigation';

interface OrdersTableProps {
  data: Order[];
  columns: ColumnDef[];
  total: number;
  pageCount: number;
  defaultSort?: string;
  defaultDir?: 'asc' | 'desc';
}

export function OrdersTable(props: OrdersTableProps) {
  const router = useRouter();
  
  const handleFilterChange = (newParams: Record<string, string>) => {
    // Build new URL query
    const url = new URLSearchParams(newParams);
    router.push(`/orders?${url.toString()}`);
  };
  
  return (
    <DataTable
      {...props}
      onSortingChange={handleFilterChange}
      onFiltersChange={handleFilterChange}
    />
  );
}
```

**Đặc điểm:**
- ✅ `"use client"` directive ở đầu
- ✅ Có `useRouter()` hook
- ✅ Nhận dữ liệu từ props (từ Server Component)
- ✅ Gọi `router.push()` khi người dùng tương tác
- ❌ KHÔNG gọi database queries trực tiếp
- ❌ KHÔNG dùng `useState` lưu dữ liệu (dữ liệu từ props)

### 2.3 Shared Data Table Component
**File:** `components/data-table/data-table.tsx`

```typescript
'use client';

import { DataTablePagination } from './pagination';
import { DataTableToolbar } from './toolbar';
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useQueryState } from 'nuqs';

interface DataTableProps<TData> {
  data: TData[];
  columns: ColumnDef[];
  pageCount: number;
  total: number;
  onSortingChange?: (params: Record<string, string>) => void;
  onFiltersChange?: (params: Record<string, string>) => void;
}

export function DataTable<TData>({
  data,
  columns,
  pageCount,
  total,
  onSortingChange,
  onFiltersChange,
}: DataTableProps<TData>) {
  // Parse URL query params using nuqs
  const [sort, setSort] = useQueryState('sort', { shallow: false });
  const [dir, setDir] = useQueryState('dir', { shallow: false });
  const [page, setPage] = useQueryState('page', { shallow: false });
  
  // TanStack Table instance
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // ... other options
  });
  
  // Handle sorting change
  const handleSortingChange = (newSorting: SortingState) => {
    // updateQueryState with new sort/dir
    onSortingChange?.({ sort: newSort, dir: newDir });
  };
  
  return (
    <div>
      <DataTableToolbar table={table} />
      <table>
        <thead>
          {/* header rows */}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr key={row.id}>
              {row.getVisibleCells().map(cell => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <DataTablePagination table={table} pageCount={pageCount} />
    </div>
  );
}
```

**Đặc điểm:**
- ✅ `"use client"` directive
- ✅ TanStack Table v8 (React hook)
- ✅ Quản lý URL state qua `nuqs`
- ✅ Trigger callbacks để parent xử lý router.push()
- ❌ KHÔNG fetch dữ liệu (dữ liệu từ props)

---

## 3. Luồng Dữ Liệu Chi Tiết

### 3.1 Tải lần đầu (First Load)

```
1. Browser: User opens http://localhost:3000/orders?period=month&pageSize=20
   
2. Next.js Router: Matches route to app/(dashboard)/orders/page.tsx
   
3. Server: OrdersPage({ searchParams: { period: 'month', pageSize: '20' } })
   └─ searchParams.period = 'month'
   └─ parseListParams() → { period: 'month', page: 0, pageSize: 20, ... }
   
4. Server: await getOrdersList({ period: 'month', page: 0, pageSize: 20 })
   └─ Build SQL: SELECT ... FROM orders LEFT JOIN shipments
   └─ WHERE (orders.inserted_at >= DATE_TRUNC('month', NOW()) 
                   AND orders.inserted_at < DATE_TRUNC('month', NOW()) + INTERVAL '1 month')
   └─ LIMIT 20 OFFSET 0
   
5. Database: PostgreSQL/PGlite returns 20 rows
   └─ Rows include: id, stage, cod, total_price, order_outcome, ...
   
6. Server: OrdersPage returns HTML
   └─ <OrdersTable data={[...20 rows...]} columns={...} pageCount={...} />
   
7. Browser: HTML arrives (network waterfall complete)
   └─ TTFB: time from request sent to first byte of response
   └─ First Paint: browser starts rendering
   
8. Browser: React hydrates <OrdersTable /> 
   └─ Attach event listeners
   └─ TanStack Table mounts
   └─ Table becomes interactive
   └─ LCP: largest element (table) is painted
   
9. Browser: User sees full table with 20 rows
```

### 3.2 Đổi Bộ Lọc (Filter Change: month → week)

```
1. Browser: User clicks filter dropdown, selects "week" instead of "month"
   
2. Client: <OrdersTable /> calls router.push() with new URL
   └─ Old URL: /orders?period=month&pageSize=20
   └─ New URL: /orders?period=week&pageSize=20
   
3. Next.js Router: Detects URL change
   └─ Doesn't reload full page (client-side navigation)
   └─ Triggers re-render of Server Component (OrdersPage)
   
4. Server: OrdersPage({ searchParams: { period: 'week', pageSize: '20' } }) runs again
   └─ (This is NOT a network request that user sees as XHR/Fetch)
   └─ (This is Next.js internal mechanism)
   
5. Server: await getOrdersList({ period: 'week', page: 0, pageSize: 20 })
   └─ Build SQL with new WHERE clause (week range instead of month)
   └─ Return 20 NEW rows from different time range
   
6. Browser: React re-renders with new data
   └─ TanStack Table receives new data prop
   └─ Old rows removed from DOM
   └─ New 20 rows added to DOM
   └─ Page scrolls to top (or maintains scroll)
   
7. Browser: User sees new table data for "week" period
```

**Key point:** No visible XHR/Fetch request in Network tab for filter change. It's all Next.js internal navigation. But the underlying mechanism is:
- URL change → Server Component re-run → New HTML generated → Sent to browser → React reconciliation

### 3.3 Đổi Sắp Xếp (Sort Change: ASC → DESC)

```
1. Browser: User clicks sort arrow on "Created" column to reverse sort
   
2. Client: DataTable handles click event
   └─ TanStack Table: setSorting([{ id: 'created_at', desc: true }])
   
3. Client: Trigger onSortingChange() callback
   └─ Calls: router.push({ sort: 'created_at', dir: 'desc' })
   
4. URL changes: /orders?period=month&pageSize=20&sort=created_at&dir=desc
   
5. Server: OrdersPage re-runs with new sort/dir params
   └─ getOrdersList() builds SQL with ORDER BY created_at DESC
   └─ Returns 20 rows sorted in DESCENDING order (different from before)
   
6. Browser: New sorted data received, table re-renders
   └─ Order of rows changes
   
7. User sees: Same 20 rows, but in different order
```

---

## 4. Ranh Giới Server/Client — Kiểm Chứng

### 4.1 Cách Xác Định

| Dấu Hiệu | Server Component | Client Component |
|---|---|---|
| **Dòng đầu file** | KHÔNG có `'use client'` | CÓ `'use client'` |
| **Có `async`?** | ✅ CÓ thể | ❌ KHÔNG thể |
| **Gọi database trực tiếp?** | ✅ CÓ thể (qua `lib/queries/*`) | ❌ KHÔNG được |
| **Gọi Server Actions?** | ✅ CÓ thể | ✅ CÓ thể |
| **Dùng `useState`?** | ❌ KHÔNG được | ✅ CÓ thể |
| **Dùng `useEffect`?** | ❌ KHÔNG được | ✅ CÓ thể |
| **Dùng hooks (`useRouter`)?** | ❌ KHÔNG được | ✅ CÓ thể |
| **Nhận props từ Server?** | N/A | ✅ CÓ thể |

### 4.2 Kiểm Chứng Trên Mã Nguồn

**File để kiểm tra:** `app/(dashboard)/orders/page.tsx`

```bash
# 1. Kiểm tra dòng đầu file
head -5 app/(dashboard)/orders/page.tsx
# OUTPUT: không thấy 'use client' → Server Component ✅

# 2. Kiểm tra import
grep -E "^import|^from" app/(dashboard)/orders/page.tsx
# OUTPUT: import { getOrdersList } from '@/lib/queries/orders' ✅ (server-only)
# OUTPUT: import { OrdersTable } from './orders-table' ✅ (can import client component)

# 3. Kiểm tra function signature
grep -A 2 "export default" app/(dashboard)/orders/page.tsx
# OUTPUT: async function OrdersPage() ✅

# 4. Kiểm tra async/await
grep "await" app/(dashboard)/orders/page.tsx
# OUTPUT: const { data, total } = await getOrdersList(...) ✅
```

**File để kiểm tra:** `app/(dashboard)/orders/orders-table.tsx`

```bash
# 1. Dòng đầu
head -1 app/(dashboard)/orders/orders-table.tsx
# OUTPUT: 'use client'; ✅ Client Component

# 2. Hooks
grep -E "useState|useEffect|useRouter" app/(dashboard)/orders/orders-table.tsx
# OUTPUT: const router = useRouter() ✅

# 3. router.push()
grep "router.push" app/(dashboard)/orders/orders-table.tsx
# OUTPUT: router.push(`/orders?...`) ✅
```

---

## 5. Cache & Revalidation

### 5.1 Hiện Tại (Không Explicit Cache)

**Server Component:** `page.tsx`
- Không có `revalidate` directive
- Không có `cache: 'force-cache'`
- Mặc định: **Dynamic rendering** (mỗi request tính lại)

**Query Function:** `lib/queries/orders.ts`
- Có thể dùng `memo()` để cache 60s:
  ```typescript
  export const getOrdersList = memo(
    async (params) => { /* query */ },
    { ttl: 60 * 1000 } // 60 seconds cache
  );
  ```

### 5.2 Response Headers

```
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Encoding: gzip
Cache-Control: private, max-age=0, no-cache, no-store, must-revalidate
Content-Length: 185000
```

**Giải thích:**
- `Cache-Control: private` → chỉ browser cache, không CDN
- `max-age=0` → không cache (tính lại mỗi lần)
- `no-cache` → validation với server trước dùng cache
- `no-store` → không lưu cache delicate data

### 5.3 Cách Optimize

```typescript
// 1. Cache query 60 giây
export const getOrdersList = memo(
  async (params: ListParams) => { /* ... */ },
  { ttl: 60_000 }
);

// 2. Thêm cache header vào page
export const revalidate = 60; // ISR: revalidate mỗi 60s

// 3. Hoặc dynamic = false nếu data không thay đổi
export const dynamic = 'force-static'; // build-time rendering
```

---

## 6. Network Requests Khi Đổi Filter

### 6.1 Hiện Tại — LỌC TRỰC TIẾP (NETWORK TAB KHÔNG HIỆN REQUEST)

**Quan sát:**
- Bấm filter
- Bảng cập nhật
- Network tab: KHÔNG thấy XHR/Fetch request mới
- Chỉ thấy: page reload (document request), CSS/JS revalidation

**Lý do:**
- Next.js App Router dùng `router.push()` = client-side navigation
- Không gửi HTTP request qua wire (hoặc đóng gói trong HTML response)

### 6.2 Cách Kiểm Chứng

1. **DevTools Network Tab:**
   - Bấm Clear Log
   - Bấm filter
   - Đếm requests mới:
     - Nếu `0` → Client-side hydration (không fetch)
     - Nếu `1+` → Server request gửi

2. **DevTools Performance Tab:**
   - Record
   - Bấm filter
   - Stop
   - Tìm "Scripting" time vs "Network" time

3. **Browser Console:**
   ```javascript
   let requestCount = 0;
   const originalFetch = window.fetch;
   window.fetch = function(...args) {
     console.log('Fetch called:', args[0]);
     requestCount++;
     return originalFetch.apply(this, args);
   };
   
   // Bấm filter
   setTimeout(() => console.log('Total requests:', requestCount), 2000);
   ```

---

## 7. Refetch Behavior — Full vs Partial

### 7.1 Hiện Tại: Full Page Re-render

```
Old Data (20 rows, period=month)
    ↓
User clicks filter → period=week
    ↓
router.push('/orders?period=week')
    ↓
Server Component re-run
    ↓
Database query runs again (khác dữ liệu)
    ↓
New HTML generated
    ↓
React reconciliation (compare old vnode vs new vnode)
    ↓
TanStack Table gets new data prop
    ↓
Old 20 rows REMOVED from DOM
    ↓
New 20 rows ADDED to DOM
    ↓
Re-paint entire table
```

**Kết quả:** Full page re-render (không optimize)

### 7.2 Optimize: Partial Update (Tương Lai)

Có thể dùng **Server Actions** + **Client caching**:

```typescript
// lib/actions/orders.ts (Server Action)
'use server';
export async function getOrdersForFilter(params: ListParams) {
  const { data, total, pageCount } = await getOrdersList(params);
  return { data, total, pageCount }; // Return JSON, not HTML
}

// Client component
async function handleFilterChange(newPeriod: string) {
  // Fetch JSON (not HTML) từ server
  const response = await getOrdersForFilter({ period: newPeriod });
  // Update state
  setData(response.data);
  // Cập nhật TanStack Table state
  table.setData(response.data);
  // Chỉ re-render table, không reload page
}
```

**Benefit:** 
- Payload nhỏ hơn (JSON vs HTML)
- Refetch chỉ bảng, không page
- Instant feedback (không wait for HTML parsing)

---

## 8. CSS-in-JS & Hydration Mismatch

### 8.1 Hiện Tại: Tailwind CSS (Static)

**Tailwind:** Generate CSS build-time, không runtime CSS-in-JS
- **Pro:** Không hydration mismatch (CSS luôn match)
- **Con:** Không dynamic styling ở runtime

**Kiểm chứng:**
```bash
# Xem CSS bundle
curl http://localhost:3000/_next/static/css/*.css | head -20
# Là static CSS, không generated từ JS
```

### 8.2 Kiểm Tra Hydration

```javascript
// Console: kiểm tra hydration error
const errorElement = document.querySelector('[data-react-root]');
if (errorElement) {
  console.log('Root element hydrated');
} else {
  console.log('⚠️ Potential hydration mismatch');
}

// Next.js 15+ error overlay sẽ báo red nếu có mismatch
```

---

## 9. Summary: Hiện Tại vs Optimize

### Hiện Tại (Baseline)

| Khía Cạnh | Hiện Tại |
|---|---|
| **Server Component** | `page.tsx` |
| **Client Component** | `OrdersTable`, `DataTable` |
| **Fetch khi filter** | `router.push()` → Server re-render → Full HTML response |
| **Request count** | 1 (page load) + 1 (filter change) = 2+ per session |
| **Cache** | No explicit cache (dynamic rendering) |
| **Refetch type** | Full page (toàn bộ `<OrdersTable>` re-mount) |
| **Payload** | ~185KB HTML (gzip) per response |
| **TTFB** | Có thể 100–200ms+ (tùy database query) |

### Optimize Ideas (Tương Lai)

| Idea | Lợi Ích | Chi Phí |
|---|---|---|
| **Database indexing** | ↓ TTFB 30–50% | Một lần setup |
| **Query caching (60s)** | ↓ Database load | Dữ liệu cũ 60s |
| **Virtual scrolling** | ↓ LCP, DOM nodes 90% | UX: scroll smooth |
| **Code splitting** | ↓ JS size | Thêm network request |
| **Partial refetch** | ↓ Payload 50% | Code complexity |
| **GraphQL** | ↓ Payload 30% | Migration effort |
| **ISR (revalidate: 60)** | ↓ TTFB (cached) | Stale data 60s |

---

## 10. Checklist Baseline

Khi đo TECH-6, kiểm tra:

- [ ] **Server Component:** `page.tsx` KHÔNG có `'use client'`
- [ ] **Client Component:** `OrdersTable` CÓ `'use client'`
- [ ] **Database Query:** `getOrdersList()` chỉ gọi từ Server
- [ ] **Router Usage:** `router.push()` chỉ gọi từ Client
- [ ] **Refetch:** Filter change → full page HTML response (KHÔNG XHR)
- [ ] **Cache:** Hiện tại KHÔNG có cache header (dynamic rendering)
- [ ] **Hydration:** KHÔNG có mismatch (Tailwind static CSS)
- [ ] **Payload:** HTML ~150–250KB (gzip), tùy pageSize & joins
- [ ] **TTFB:** ~100–200ms (tùy DB query + server speed)

---

**Cập nhật:** 2026-09-24 | **SHA:** 65547ab | **Branch:** ai/frontend/TECH-6-mudq6e2k
