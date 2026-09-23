# TECH-6: Hướng Dẫn Đo Lường Baseline Phía Trình Duyệt

Vì không thể tạo script mới trực tiếp, tài liệu này cung cấp hướng dẫn từng bước để đo các chỉ số baseline phía client bằng công cụ sẵn có.

---

## 1. Chuẩn Bị Môi Trường

### 1.1 Khởi động ứng dụng
```bash
# Terminal 1: Khởi động dev server
npm run dev
# Ứng dụng chạy ở http://localhost:3000

# Terminal 2: (tuỳ chọn) Khởi động scheduler
npm run scheduler

# Terminal 3: Khởi động seed dữ liệu (nếu CSDL trống)
npm run seed:demo
```

### 1.2 Đăng nhập
- Truy cập http://localhost:3000
- Đăng nhập bằng tài khoản admin (xem `.env`)
- Chờ trang Tổng quan tải xong (kiểm tra Network tab không còn request pending)

### 1.3 Chuẩn bị Chrome DevTools
1. Mở Chrome DevTools (F12)
2. Tab **Network:**
   - Bật "Disable cache" nếu đo lần đầu tải
   - Tắt nếu đo reload sau
3. Tab **Performance:**
   - Chuẩn bị để ghi video khi bấm filter
4. Có thể mở 2 DevTools ngoài:
   - Một cửa sổ tối thiểu (performance measurements)
   - Một cửa sổ Network (xem chi tiết requests)

---

## 2. Đo TTFB (Time to First Byte)

### 2.1 Phương pháp: Network Tab
1. **Bước 1:** Xoá cache (Cmd+Shift+Delete)
2. **Bước 2:** Mở Network tab → Bật "Disable cache"
3. **Bước 3:** Reload trang `/orders`
4. **Bước 4:** Kiếm request chính (GET /orders hoặc GET /, không tính CSS/JS)
   - Tìm cột **Time** hoặc tên tệp có `orders` hoặc `page`
5. **Bước 5:** Click vào request, mở tab **Timing**
   - **Queueing:** chờ
   - **DNS Lookup:** ~ 0ms (localhost)
   - **Initial connection:** ~ 0ms
   - **SSL:** 0ms
   - **Request sent:** thường < 1ms
   - **Waiting (TTFB):** ⭐ **ĐÂY LÀ TTFB** (từ khi gửi request tới byte đầu)
   - **Content Download:** thời gian tải nội dung

**Ghi chép:** TTFB = cột "Waiting" hoặc (Timing `responseStart` - `requestStart`)

### 2.2 Phương pháp: Performance.timing API
Mở Browser Console và chạy:
```javascript
const perfData = performance.getEntriesByType('navigation')[0];
const ttfb = perfData.responseStart - perfData.fetchStart;
console.log('TTFB:', ttfb, 'ms');
console.log('Response End:', perfData.responseEnd - perfData.fetchStart, 'ms');
console.log('DOM Content Loaded:', perfData.domContentLoadedEventEnd - perfData.fetchStart, 'ms');
console.log('Load Event End:', perfData.loadEventEnd - perfData.fetchStart, 'ms');
```

**Output mong đợi:**
```
TTFB: 145 ms
Response End: 215 ms
DOM Content Loaded: 350 ms
Load Event End: 520 ms
```

---

## 3. Đo Thời Gian Render Bảng

### 3.1 Thời gian tới hàng đầu tiên (First Row)
1. **Cách 1 (bằng mắt):**
   - Network tab → bật "Slow 3G" (nếu muốn mô phỏng mạng chậm)
   - Reload trang
   - Quan sát khi nào hàng đầu tiên (`<tbody tr>`) hiện ra
   - So sánh với TTFB

2. **Cách 2 (JavaScript):**
   ```javascript
   const observer = new PerformanceObserver((list) => {
     for (const entry of list.getEntries()) {
       if (entry.name.includes('table')) {
         console.log('First row render:', entry.startTime, 'ms');
       }
     }
   });
   observer.observe({ entryTypes: ['measure'] });
   
   // Hoặc đơn giản:
   performance.mark('first-row-observed');
   const firstRow = document.querySelector('tbody tr');
   if (firstRow) {
     console.log('First row exists');
   }
   ```

### 3.2 Thời gian tới hàng cuối cùng (Last Row)
```javascript
const rows = document.querySelectorAll('tbody tr');
if (rows.length > 0) {
  const lastRow = rows[rows.length - 1];
  console.log('Total rows:', rows.length);
  console.log('Last row DOM element exists');
  
  // Thời gian mà tất cả rows đã render
  const paintEntries = performance.getEntriesByType('paint');
  const lcpEntry = performance.getEntriesByType('largest-contentful-paint')[0];
  console.log('LCP (Largest Contentful Paint):', lcpEntry?.startTime, 'ms');
}
```

### 3.3 Phương pháp: Performance Tab
1. **Mở Performance Tab**
2. **Bấm Record (red dot)**
3. **Reload trang hoặc bấm filter**
4. **Bấm Stop khi bảng tải xong**

Kết quả hiển thị:
- **FCP (First Contentful Paint):** khi có nội dung đầu tiên
- **LCP (Largest Contentful Paint):** khi element lớn nhất render (thường là bảng)
- **CLS (Cumulative Layout Shift):** độ nhảy layout

**Ghi chú:** LCP ≈ thời gian tới khi bảng có dữ liệu hiển thị đầy đủ

---

## 4. Đo Kích Thước Payload

### 4.1 HTML + dữ liệu trả về
1. **Network Tab:**
   - Tìm request GET `/orders` (hoặc trang cần đo)
   - Xem cột **Size:**
     - **Số bên phải** = kích thước after transfer (gzip/brotli)
     - **Số bên trái** = kích thước uncompressed
   - Ví dụ: `185 KB / 598 KB` = 185 KB (gzip), 598 KB (raw)

2. **Response Header:**
   - Click vào request → tab **Headers** → tìm `Content-Encoding: gzip`
   - Tìm `Content-Length: 189245` (bytes gửi)

3. **JavaScript Snippet:**
   ```javascript
   // Lấy kích thước response sau gzip
   const perfEntries = performance.getEntriesByType('resource');
   const htmlRequest = perfEntries.find(e => e.name.includes('/orders'));
   console.log('Transfer Size (gzip):', htmlRequest.transferSize, 'bytes');
   console.log('Encoded Size:', htmlRequest.encodedBodySize, 'bytes');
   console.log('Decoded Size:', htmlRequest.decodedBodySize, 'bytes');
   console.log('Size in KB:', (htmlRequest.transferSize / 1024).toFixed(1), 'KB');
   ```

**Ghi chú:** Payload lớn → tối ưu hóa có thể loại bỏ cột không cần, pagination nhỏ hơn, hoặc caching.

---

## 5. Đo Số Requests Khi Đổi Bộ Lọc

### 5.1 Cách đo
1. **Network Tab:**
   - Bật "Preserve log" (để không xoá log khi navigate)
   - Mở trang `/orders?period=month&pageSize=20`
   - Clear Network log (click icon xoá)
   - **Bấm filter: thay đổi `period` thành `week`**
   - Đếm số **XHR/Fetch** requests mới phát sinh

2. **Kỳ vọng:**
   - Nếu hiện tại **1 request** (reload toàn bộ page) → không optimize được ngay
   - Nếu **0 requests** → dữ liệu lọc ở client (tốt)
   - Nếu **N requests** → có thể có API gọi từ bảng

### 5.2 Ghi chú kiến trúc hiện tại
- **Hiện tại:** Bảng client gọi `router.push()` → URL thay đổi → server component tính lại → trả HTML mới
- **Kết quả:** 1 request HTML lớn (không phải XHR)

### 5.3 Script kiểm tra network requests
```javascript
// Chạy ở Console trước khi bấm filter
const initialRequestCount = performance.getEntriesByType('resource').length;
console.log('Initial requests:', initialRequestCount);

// Sau khi bấm filter
setTimeout(() => {
  const finalRequestCount = performance.getEntriesByType('resource').length;
  const newRequests = finalRequestCount - initialRequestCount;
  console.log('New requests after filter:', newRequests);
}, 3000);
```

---

## 6. Kiểm Tra Ranh Giới Server/Client

### 6.1 Xác định Server vs Client Component
1. **Mở Source Code:**
   - Đi tới `/orders/` page
   - DevTools → **Sources** tab
   - Tìm file `page.tsx` (hoặc `orders-table.tsx`)

2. **Kiểm tra dòng đầu tiên:**
   ```typescript
   // Server Component (không có "use client")
   import { getOrdersList } from '@/lib/queries/orders';
   
   export default async function OrdersPage({ searchParams }) {
     const orders = await getOrdersList(searchParams);
     return <OrdersTable data={orders} />;
   }
   
   // Client Component (có "use client")
   'use client';
   import { DataTable } from '@/components/data-table';
   export function OrdersTable({ data }) {
     // ...
   }
   ```

3. **Dấu hiệu Server Component:**
   - ✓ Có `import { getOrdersList } from '@/lib/queries/...'`
   - ✓ Hàm `async` ở top level
   - ✓ Gọi database query trực tiếp
   - ✗ KHÔNG có `useState`, `useEffect`, `useCallback`

4. **Dấu hiệu Client Component:**
   - ✓ Dòng đầu: `'use client'`
   - ✓ Có `useState`, `useEffect`
   - ✓ Gọi `router.push()` để thay đổi URL
   - ✓ Gọi Server Actions (function `'use server'`)

### 6.2 Kiểm tra luồng dữ liệu
1. **Ghi breakpoint ở DevTools:**
   - Tab **Sources** → Tab **Debugger**
   - Tìm file `data-table.tsx`
   - Mở breakpoint khi `router.push()` được gọi
   - Bấm filter, xem flow

2. **Theo dõi Server Action (nếu có):**
   - Nếu page gọi `await someServerAction()` từ client
   - Sẽ hiện trong Network tab dưới dạng POST request

### 6.3 Mô tả hiện tại (lấy từ mã nguồn)
```
Page.tsx (Server)
  ├─ function: async, không "use client"
  ├─ read params từ URL
  ├─ gọi getOrdersList() từ lib/queries
  └─ trả về <OrdersTable data={...} />

<OrdersTable /> (Client, "use client")
  ├─ nhận props: { data, columns, ... }
  ├─ gọi <DataTable /> wrapper
  └─ khi người dùng bấm sort/filter:
     ├─ TanStack Table setState
     ├─ gọi router.push(newUrl)
     └─ Page.tsx được gọi lại (thông qua `router.refresh()`)

<DataTable /> (Client, "use client")
  ├─ TanStack Table (v8)
  ├─ State quản lý: sort, filter, pagination
  └─ Props: columns, data, pageCount, ...
```

---

## 7. Mẫu Bảng Ghi Chép Kết Quả

### 7.1 Trang: `/orders` (lần đầu tải)

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| **TTFB** | ___ ms | Performance > Timing > responseStart |
| **FCP (First Contentful Paint)** | ___ ms | Performance tab |
| **LCP (Largest Contentful Paint)** | ___ ms | Performance tab, thường là bảng |
| **DCL (DOM Content Loaded)** | ___ ms | Console: `performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd` |
| **Load Event End** | ___ ms | Khi trang tải hoàn toàn xong |
| **HTML Size (gzip)** | ___ KB | Network tab, cột Size (số bên phải) |
| **HTML Size (uncompressed)** | ___ KB | Network tab hoặc `decodedBodySize` |
| **Total Requests** | ___ | Số resource entries (tính từ Network tab) |
| **CLS (Cumulative Layout Shift)** | ___ | Performance tab |
| **Số hàng hiển thị** | ___ | pageSize trong URL |
| **Thời gian tới hàng đầu** | ___ ms | Sau khi HTML tải, bao lâu hàng render |
| **Thời gian tới hàng cuối** | ___ ms | Sau HTML, tất cả hàng render xong |

### 7.2 Trang: `/orders` (đổi bộ lọc: month → week)

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| **Thời gian phản hồi** | ___ ms | Từ lúc bấm filter tới bảng cập nhật |
| **Số requests mới** | ___ | Network tab, chỉ đếm sau lúc clear log |
| **Loại requests** | ___ | Fetch? XHR? Navigation? |
| **HTML size (gzip)** | ___ KB | Response size lần này |
| **Cache được dùng?** | Yes/No | Xem Network tab, status 304? |
| **Re-render toàn bộ?** | Yes/No | TanStack Table clear data rồi fill lại? |
| **Skeleton/Loading?** | Yes/No | Có loading UI không? |
| **DOM shift?** | ___ CLS | Có nhảy layout không? |

### 7.3 Trang: `/orders` (đổi sort: created_at ASC → DESC)

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| **Thời gian phản hồi** | ___ ms | Từ click sort tới bảng cập nhật |
| **Server roundtrip?** | Yes/No | Có request tới server? |
| **Sort ở client?** | Yes/No | Dữ liệu từ trước sắp xếp lại ngay? |
| **Requests** | ___ | Số requests phát sinh |
| **Dữ liệu thay đổi?** | Yes/No | Rows khác nhau? (nếu server-side sort, có thể khác) |

---

## 8. Cách Ghi Lại Kết Quả

### 8.1 Tạo tệp baseline
```bash
# Tạo folder chứa baselines
mkdir -p docs/baselines

# Tên tệp theo format: frontend-<trang>-<ngày>.json
# Ví dụ: docs/baselines/frontend-orders-2026-09-24.json
```

### 8.2 Nội dung tệp JSON
```json
{
  "date": "2026-09-24T10:30:00Z",
  "environment": {
    "branch": "ai/frontend/TECH-6-mudq6e2k",
    "commit": "65547ab",
    "nodeVersion": "v22.0.0",
    "browserVersion": "Chrome 128.0",
    "platform": "macOS / Linux / Windows",
    "appUrl": "http://localhost:3000"
  },
  "measurements": [
    {
      "scenario": "page-load-first-time",
      "page": "/orders",
      "pageSize": 20,
      "metrics": {
        "ttfb_ms": 145,
        "fcp_ms": 200,
        "lcp_ms": 320,
        "dcl_ms": 350,
        "load_ms": 520,
        "html_size_gzip_kb": 185,
        "html_size_raw_kb": 598,
        "total_requests": 12,
        "cls": 0.05,
        "time_to_first_row_ms": 250,
        "time_to_last_row_ms": 280
      },
      "notes": "Lần đầu tải trang, disable cache"
    },
    {
      "scenario": "filter-change",
      "page": "/orders",
      "filter": "period:month->week",
      "metrics": {
        "time_to_update_ms": 420,
        "requests_sent": 1,
        "requests_type": "navigation",
        "cache_used": false,
        "html_size_gzip_kb": 180,
        "cls": 0.02
      },
      "notes": "Đổi bộ lọc, đã load trang trước đó"
    },
    {
      "scenario": "sort-change",
      "page": "/orders",
      "sort": "created_at:asc->desc",
      "metrics": {
        "time_to_update_ms": 380,
        "requests_sent": 1,
        "server_call": true,
        "rows_changed": true
      },
      "notes": "Đổi sort, server tính lại dữ liệu"
    }
  ],
  "summary": {
    "ttfb_average_ms": 145,
    "filter_change_average_ms": 420,
    "html_size_average_gzip_kb": 182,
    "total_requests_average": 12,
    "slowest_scenario": "filter-change",
    "fastest_scenario": "sort-change"
  }
}
```

### 8.3 Lưu vào docs
```bash
# Copy kết quả vào tệp
cp /tmp/benchmark.json docs/baselines/frontend-orders-2026-09-24.json

# Commit vào repo
git add docs/baselines/
git commit -m "TECH-6: Baseline phía trình duyệt — trang orders

Đo TTFB, thời gian render, payload, requests:
- Tải lần đầu: TTFB 145ms, LCP 320ms, payload 185KB gzip
- Đổi bộ lọc (month→week): 420ms, 1 request (reload page)
- Đổi sort: 380ms, 1 request (server-side sort)

Ranh giới: page.tsx (Server) → OrdersTable (Client) → DataTable
Số hàng hiển thị: 20 (từ pageSize trong URL)"
```

---

## 9. So Sánh Với Baseline Cũ

### 9.1 Cách so sánh thủ công
```bash
# Xem danh sách baselines
ls -lh docs/baselines/

# So sánh hai tệp JSON
# Dùng jq hoặc grep tìm các cột TTFB, LCP, time_to_update_ms
jq '.summary' docs/baselines/frontend-orders-*.json
```

### 9.2 Tính toán % thay đổi
```javascript
const old = { ttfb: 145 };
const new_ = { ttfb: 155 };
const change = ((new_.ttfb - old.ttfb) / old.ttfb * 100).toFixed(1);
console.log(`TTFB: ${old.ttfb}ms → ${new_.ttfb}ms (${change}%)`);
```

**Kết quả thông báo:**
- TTFB: 145ms → 155ms (+6.9%) **⚠️ Chậm hơn**
- HTML: 185KB → 178KB (-3.8%) **✅ Nhanh hơn**

---

## 10. Tối Ưu Hóa Tiếp Theo (lộ trình)

Dựa vào baseline, các điểm tối ưu:

| Phát hiện | Giải pháp | Ưu tiên |
|---|---|---|
| TTFB > 200ms | Thêm index CSDL, cache query (memo), lazy query | 1 |
| LCP > 500ms | Virtual scrolling, pagination nhỏ, code splitting | 2 |
| Payload > 300KB | GraphQL, thinned responses, gzip Brotli | 2 |
| Requests > 5 lần | Batch requests, Server Actions cache | 3 |
| CLS > 0.1 | Fixed header, stable grid layout, load skeleton | 3 |

---

## 11. Chạy Parallel Runs (đo thống kê)

Để kết quả tin cậy hơn, đo **3–5 lần** cùng scenario:

```bash
# Run 1
npm run dev # (terminal 1)
# Clear cache (Cmd+Shift+Delete)
# Reload /orders
# Ghi TTFB vào spreadsheet

# Wait 30s, repeat run 2, 3...

# Tính average
Average TTFB = (145 + 152 + 148) / 3 = 148.3 ms
Std Dev = ...
```

---

## 12. Checkpoint: Khi nào coi là "hoàn thành"

✅ **TECH-6 hoàn thành khi có:**

- [ ] Tệp `docs/TECH-6-FRONTEND-BASELINE.md` (kiến trúc, các chỉ số cần đo)
- [ ] Tệp `docs/baselines/frontend-*.json` (kết quả đo chi tiết, ≥3 runs)
- [ ] Đo được: TTFB, FCP, LCP, CLS, payload size, # requests
- [ ] Kiểm tra ranh giới Server/Client (xác nhận server component vs client component)
- [ ] Phân tích: refetch hay partial update khi đổi filter
- [ ] Ghi chú: điểm tối ưu tiếp theo (index, cache, virtual scroll)
- [ ] Commit vào branch `ai/frontend/TECH-6-mudq6e2k`

---

## Tài liệu tham khảo

- **Chrome DevTools:**
  - Network tab: https://developer.chrome.com/docs/devtools/network/
  - Performance tab: https://developer.chrome.com/docs/devtools/performance/
  - Performance API: https://developer.mozilla.org/en-US/docs/Web/API/Performance

- **Next.js Optimization:**
  - Dynamic imports: https://nextjs.org/docs/app/building-your-application/optimizing/lazy-loading
  - Streaming SSR: https://nextjs.org/docs/app/building-your-application/routing/layouts-and-templates#streaming

- **Web Vitals:**
  - https://web.dev/articles/vitals
  - https://web.dev/articles/cls/

---

**Cập nhật:** 2026-09-24 | **SHA:** 65547ab | **Branch:** ai/frontend/TECH-6-mudq6e2k
