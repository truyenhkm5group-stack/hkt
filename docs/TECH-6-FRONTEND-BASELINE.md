# TECH-6: Đo Baseline Phía Trình Duyệt — Tải Lần Đầu & Đổi Bộ Lọc

## Mục đích

Thiết lập các chỉ số baseline về hiệu suất phía client cho trang danh sách đơn hàng (orders) và trang báo cáo lợi nhuận danh nghĩa (reports/returns), bao gồm:
- TTFB (Time to First Byte) — thời gian máy chủ phản hồi byte đầu tiên
- Thời gian tới khi bảng dữ liệu hiển thị đầy đủ
- Kích thước payload gửi từ máy chủ về
- Số lần fetch API phát sinh khi đổi một bộ lọc (facet, sort, page)
- Hành vi render: refetch toàn bảng hay cập nhật từng phần
- Ranh giới Server Component / Client Component hiện tại

---

## 1. Kiến trúc tải trang hiện tại

### 1.1 Server Components & Server Actions
- **Trang:** `app/(dashboard)/<module>/page.tsx` (Server Component)
  - Đọc `searchParams` từ URL (phần query string như `?sort=created_at&dir=desc&page=1&pageSize=20&period=month`)
  - Gọi hàm `parseListParams(searchParams)` để chuẩn hoá các tham số
  - Gọi `lib/queries/<module>.ts` (các hàm truy vấn chỉ-server) để lấy dữ liệu từ CSDL
  - Trả về dữ liệu sang Client Component wrapper (`<OrdersTable>`, `<ReturnsTable>`)

### 1.2 Client Components & Data Table
- **Wrapper:** `app/(dashboard)/<module>/<module>-table.tsx` (Client Component)
  - Import `<DataTable>` chung từ `components/data-table/data-table.tsx`
  - Xác định cột dữ liệu, định dạng, sắp xếp, lọc
- **Bảng chung:** `components/data-table/data-table.tsx` (Client Component)
  - TanStack Table v8 để quản lý trạng thái (sort, filter, pagination)
  - State lưu ở URL qua `nuqs` (Next URL Query String): thay đổi một tham số → `router.push()` → page rerender
  - Mỗi thay đổi sort/filter/page → render lại bảng (gọi hàm server component của trang)

### 1.3 Luồng khi đổi bộ lọc
1. Người dùng chọn sort hoặc filter → bảng client gọi `router.push(newUrl)`
2. URL thay đổi → Next.js Server Component **trang tổng** tính lại dữ liệu từ CSDL
3. Dữ liệu trả về → trang truyền sang Client Component
4. Client Component render bảng mới với dữ liệu

---

## 2. Các trang cần đo

| Trang | Đường dẫn | Module | Loại dữ liệu | Bộ lọc chính |
|---|---|---|---|---|
| Đơn hàng | `/orders` | `orders` | Danh sách đơn | Kỳ (period), trạng thái (stage), từ khóa |
| Báo cáo GTC | `/reports/returns` | `returns` | Tỷ lệ hoàn theo mã hàng | Kỳ (period), mã hàng |
| Vận đơn | `/shipments` | `shipments` | Danh sách vận đơn | Trạng thái, từ khóa |

**Ưu tiên 1 (đo chi tiết):** `/orders` — trang danh sách phức tạp nhất, many-to-many với `order_items`, có `ORDER_OUTCOME` logic phức tạp

**Ưu tiên 2 (tham khảo):** `/reports/returns` — trang báo cáo, dữ liệu tính toán trên server, có cache 60s

---

## 3. Quy trình đo TTFB & thời gian render

### 3.1 Công cụ đo
- **Network waterfall (Chrome DevTools):** hiển thị từng request và thời gian
- **Performance API (JavaScript):** ghi các mốc thời gian:
  ```javascript
  performance.mark('filter-change');
  // ... thay đổi filter
  performance.mark('data-received');
  performance.measure('filter-to-data', 'filter-change', 'data-received');
  ```
- **Web Vitals:** LCP (Largest Contentful Paint), FCP (First Contentful Paint), CLS (Cumulative Layout Shift)

### 3.2 Các mốc thời gian cần ghi
1. **Navigation Start** = người dùng bấm filter/sort (mốc 0ms)
2. **TTFB** = Server gửi byte đầu tiên (đo từ Network tab, hoặc `performance.timing.responseStart - performance.timing.navigationStart`)
3. **Response Received** = Server gửi toàn bộ HTML + dữ liệu JSON (đo từ `performance.timing.responseEnd`)
4. **DOM Content Loaded** = trình duyệt parse HTML xong (đo từ `performance.timing.domContentLoadedEventEnd`)
5. **Bảng hiển thị đầy đủ dữ liệu** = React render xong tất cả rows (đo bằng IntersectionObserver trên hàng cuối)

---

## 4. Kích thước payload

### 4.1 Cách đo
- **DevTools Network:** lọc XHR/Fetch, xem "Response" size (độ nén) và "Size" (khi giải nén)
- **Ghi curl:** 
  ```bash
  curl -i -H 'Accept-Encoding: gzip' \
    'http://localhost:3000/orders?period=month&pageSize=50' \
    2>&1 | head -20
  ```
- **Kiểm tra header `Content-Encoding`:** gzip, brotli hay không nén

### 4.2 Những gì cần kích thước
1. **HTML ban đầu** (Server Component render → HTML)
2. **JSON dữ liệu** (nếu trang gọi API riêng để lấy dữ liệu) — **hiện tại: KHÔNG** có vì server component trả dữ liệu trực tiếp
3. **JavaScript bundle:** `_next/static/chunks/*.js` (chỉ đo lần đầu)
4. **CSS bundle:** `_next/static/chunks/*.css`

---

## 5. Số lần fetch & network requests

### 5.1 Loại requests khi tải trang lần đầu
- Một lần `GET /orders` (Server Component) → HTML + dữ liệu
- Nhiều `GET /api/events` (SSE realtime, nếu bật)
- CSS/JS chunks (lấy từ cache nếu đã load lần trước)
- Ảnh, icon, font

### 5.2 Requests khi đổi bộ lọc (ví dụ: đổi `period=month` → `period=week`)
**Hiện tại:** 
- Mỗi lần thay đổi URL → `router.push()` → server component tính lại toàn bộ → 1 request GET
- **Không có cơ chế caching** tại browser level → luôn gọi lại server
- **Không có refetch từng phần** — luôn re-render bảng toàn bộ

**Cần kiểm tra:**
- Có bao nhiêu requests trong DevTools khi đổi filter?
- Có refetch API hay chỉ re-render component cũ?
- Cache header của response có `Cache-Control: private, max-age=60` không?

---

## 6. Ranh giới Server / Client Component

### 6.1 Hiện tại
```
page.tsx (Server)
  ↓ truyền dữ liệu
<OrdersTable /> (Client)
  ↓ wraps
<DataTable /> (Client)
  ↓ contains
rows[] (Client, TanStack Table)
```

### 6.2 Điểm cần kiểm tra
1. **Có dòng "use client"** ở đầu `<OrdersTable>` không?
2. Bảng có import hàm từ `lib/queries/*` không? (Server Action)
3. Khi người dùng bấm sort, có tính lại dữ liệu ở client hay server?
4. Có Server Action nào được gọi từ bảng không?

---

## 7. Baseline cần ghi

### 7.1 Trang: `/orders?period=month&pageSize=20` (lần đầu tải)
- [ ] TTFB: **?** ms
- [ ] Time to First Row: **?** ms
- [ ] Time to Last Row: **?** ms
- [ ] HTML size (gzip): **?** KB
- [ ] JS bundles downloaded: **?** files, **?** KB
- [ ] CSS size: **?** KB
- [ ] Total requests: **?** (excluding images/fonts)
- [ ] LCP time: **?** ms
- [ ] FCP time: **?** ms
- [ ] Layout Shift: **?** CLS
- [ ] Server Component render time: **?** ms

### 7.2 Trang: `/orders` (đổi filter `period=month` → `period=week`, dữ liệu đã load)
- [ ] Thời gian từ click filter tới bảng cập nhật: **?** ms
- [ ] Số requests gửi: **?**
  - [ ] Có fetch từng phần hay tải lại toàn bộ?
  - [ ] Có dùng cache browser không?
  - [ ] Response size so với lần đầu: **?** (nhỏ hơn không?)
- [ ] Re-render DOM: **?** ms
- [ ] Có animation/skeleton khi chờ không?

### 7.3 Trang: `/orders` (đổi sort `created_at` ASC → DESC)
- [ ] Thời gian từ click sort tới bảng cập nhật: **?** ms
- [ ] Có refetch server hay cập nhật từ dữ liệu client?
- [ ] Số rows thay đổi: **?** (cùng 20 rows hay khác?)
- [ ] Có cách nào optimize sort client-side?

### 7.4 Trang: `/orders` (chuyển trang: page 1 → 2)
- [ ] Thời gian tải: **?** ms
- [ ] Có scroll jump hay smooth scroll?
- [ ] Dữ liệu cũ còn hiện không (skeleton/spinner)?

---

## 8. Công cụ & script để đo tự động

### 8.1 Puppeteer / Playwright script
```typescript
// scripts/bench-frontend.ts (chạy: npm run bench:frontend)
import { chromium } from 'playwright';

async function measurePageLoad() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Ghi timing
  const metrics = await page.evaluate(() => ({
    navigationStart: performance.timing.navigationStart,
    responseStart: performance.timing.responseStart,
    responseEnd: performance.timing.responseEnd,
    domContentLoaded: performance.timing.domContentLoadedEventEnd,
    loadComplete: performance.timing.loadEventEnd,
  }));
  
  // Tính TTFB
  const ttfb = metrics.responseStart - metrics.navigationStart;
  
  // Ghi file CSV
  // ...
  
  await browser.close();
}
```

### 8.2 Chrome DevTools Protocol (CDP)
```javascript
// Tự động bấm filter, ghi Network timing
chrome-remote-interface.send('Network.emulateNetworkConditions', {
  offline: false,
  downloadThroughput: -1,
  uploadThroughput: -1,
  latency: 0,
});
```

---

## 9. Kết quả mong đợi (dự đoán)

| Chỉ số | Dự đoán | Ghi chú |
|---|---|---|
| TTFB | 50–200 ms | Server cần tính `ORDER_OUTCOME` logic phức tạp |
| Time to render | 200–500 ms | Next.js hydration + TanStack Table |
| Payload (HTML+data) | 100–300 KB | 50 rows × ~5KB/row + dữ liệu tính toán |
| Requests khi filter | 1 | `router.push()` → re-render server component |
| Cache hiệu lực | Không (hoặc 60s) | Server tính toán mỗi lần, cache bằng `memo()` |
| Refetch type | Full page | Hiện tại reload toàn bộ, không partial |

---

## 10. Độ ưu tiên optimize (tương lai)

### A. Giảm TTFB (Server-side)
1. **Indexing:** thêm index cho cột `inserted_at`, `stage`, `order_outcome`
2. **Query caching:** dùng materialized view cho `ORDER_OUTCOME` thay vì CASE expression
3. **Pagination aggressive:** giảm pageSize mặc định từ 50 → 20
4. **Connection pooling:** tối ưu hóa Pool PostgreSQL

### B. Giảm render time (Client-side)
1. **Code splitting:** chia `DataTable` thành các chunks nhỏ hơn
2. **Virtual scrolling:** chỉ render rows nhìn thấy (react-window)
3. **Memoization:** `useMemo`, `useCallback` cho TanStack Table state
4. **Skeleton loading:** hiện skeleton lúc chờ refetch

### C. Giảm payload
1. **GraphQL hoặc thinned responses:** gửi chỉ cột cần (tránh gửi toàn bộ row object)
2. **Compression:** bật Brotli (thay vì gzip)
3. **Deduplication:** nếu có dữ liệu lặp (customer, product), gửi một lần + join ở client

---

## 11. Cách lưu & so sánh kết quả

### 11.1 Format lưu trữ
Tạo file `docs/baselines/frontend-<ngày>.json`:
```json
{
  "date": "2024-09-24",
  "environment": {
    "branch": "ai/frontend/TECH-6-mudq6e2k",
    "commit": "65547ab",
    "nodeVersion": "22.x",
    "browserVersion": "Chrome 128.x"
  },
  "measurements": [
    {
      "page": "/orders",
      "scenario": "first-load",
      "ttfb_ms": 145,
      "time_to_first_row_ms": 280,
      "time_to_last_row_ms": 320,
      "html_size_kb": 185,
      "total_requests": 8,
      "lcp_ms": 290
    },
    {
      "page": "/orders",
      "scenario": "filter-change",
      "filter": "period=month->week",
      "time_ms": 420,
      "requests": 1,
      "cache_used": false
    }
  ]
}
```

### 11.2 Script so sánh
```bash
# Đo baseline hiện tại
npm run bench:frontend -- --branch=ai/frontend/TECH-6-mudq6e2k > docs/baselines/frontend-current.json

# So sánh với baseline cũ
npm run bench:frontend -- --compare=docs/baselines/frontend-main.json
# Output: TTFB +10ms (Slower), Requests -1 (Better)
```

---

## 12. Checklist đo

- [ ] Tạo script Playwright/Puppeteer đo tự động
- [ ] Đo 3 lần mỗi scenario, lấy trung bình (loại outliers)
- [ ] Đo ở 2 điều kiện: **network bình thường** (3G) và **mạng nhanh** (Fiber)
- [ ] Ghi Network throttling settings
- [ ] Kiểm tra DevTools "Performance" tab để xác nhận mốc thời gian
- [ ] Lưu video screen recording để replay lại
- [ ] So sánh với competitor (nếu có) hoặc ERP khác

---

## 13. Ghi chú implementation

### Điểm cần xác nhận trước khi bắt đầu
1. **Trang chủ muốn đo chi tiết nhất là gì?** (orders / shipments / reports)
2. **Điều kiện mạng nào?** (3G? Fiber? Offline?)
3. **Cần real browser hay headless browser?** (Chromium headless đo không chính xác như browser thật)
4. **Có cần đo Mobile không?** (responsive design)
5. **Có cần đo pagination hay chỉ sort/filter?**

### Về ranh giới server/client
- **Hiện tại:** `page.tsx` là Server Component, dữ liệu truyền sang `<Table>` Client Component qua props
- **Không có Server Action được gọi từ bảng** — mỗi thay đổi URL là `router.push()` → page re-render
- **Có thể optimize:** dùng Server Actions để filter/sort nhưng cache ở client, giảm server calls

---

## Kế tiếp

Lần sau khi làm TECH-6, cần:
1. Viết script tự động để đo các mốc thời gian
2. Chọn 1–2 trang ưu tiên đo chi tiết
3. Chạy baseline 3 lần, ghi min/max/avg
4. Lưu vào `docs/baselines/` để so sánh tương lai
5. Phân tích ranh giới server/client để tìm điểm optimize tiếp theo

---

**Cập nhật:** 2026-09-24 | **SHA:** 65547ab | **Branch:** ai/frontend/TECH-6-mudq6e2k
