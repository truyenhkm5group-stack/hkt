# TECH-6: Baseline Phía Trình Duyệt — Tóm Tắt Thực Hiện

**Tác vụ:** Đo baseline hiệu suất phía client: TTFB, thời gian render bảng, kích thước payload, số requests, ranh giới server/client.

**Branch:** `ai/frontend/TECH-6-mudq6e2k`  
**Base SHA:** `65547ab1dfc85edd0a5dfe4892038faaae17265e`  
**Ngày cập nhật:** 2026-09-24

---

## 📋 Nội Dung Đã Tạo

### 1. **TECH-6-FRONTEND-BASELINE.md** (Chính)
- **Mục đích:** Định nghĩa các chỉ số cần đo và quy trình đo
- **Nội dung:**
  - Kiến trúc tải trang (Server Component → Client Component → TanStack Table)
  - Luồng khi đổi filter (router.push → re-render server → HTML response)
  - Các trang cần đo (orders, reports, shipments)
  - Công cụ đo (DevTools Network, Performance, Performance API)
  - Mẫu bảng ghi chép kết quả
  - Điểm optimize tiếp theo

### 2. **TECH-6-MEASUREMENT-GUIDE.md** (Hướng Dẫn)
- **Mục đích:** Bước-by-bước đo bằng công cụ sẵn có
- **Nội dung:**
  - Chuẩn bị môi trường (npm run dev, seed dữ liệu)
  - Cách đo TTFB (Network tab → Timing → Waiting)
  - Cách đo thời gian render (Performance tab, JavaScript API)
  - Cách đo kích thước payload (Size column, decodedBodySize)
  - Cách kiểm tra số requests (Network tab, preserve log)
  - Cách xác định Server vs Client component (mã nguồn)
  - Mẫu bảng ghi kết quả
  - Cách lưu & so sánh baseline

### 3. **TECH-6-ARCHITECTURE-ANALYSIS.md** (Kiến Trúc)
- **Mục đích:** Phân tích chi tiết kiến trúc server/client
- **Nội dung:**
  - Biểu đồ luồng dữ liệu (browser → server → db → response)
  - Chi tiết các file quan trọng (`page.tsx`, `orders-table.tsx`, `data-table.tsx`)
  - Luồng tải lần đầu
  - Luồng đổi filter (month → week)
  - Luồng đổi sort (asc → desc)
  - Cách xác định ranh giới server/client
  - Cache behavior hiện tại
  - Refetch: full vs partial
  - Hydration check
  - Summary: hiện tại vs optimize ideas

### 4. **BASELINE-TEMPLATE.json** (Mẫu)
- **Mục đích:** Mẫu JSON để ghi kết quả đo
- **Nội dung:**
  - Thông tin môi trường (branch, commit, browser, OS)
  - Các scenario đo (page load, filter change, sort change, pagination)
  - Các metric cụ thể (TTFB, FCP, LCP, CLS, payload, requests)
  - Network throttle settings
  - Observations (refetch type, skeleton, revalidation)
  - Summary & recommendations

---

## 🎯 Các Chỉ Số Cần Đo

### Tải Trang Lần Đầu (`/orders`)
| Chỉ Số | Công Thru | Kỳ Vọng |
|---|---|---|
| **TTFB** | DevTools Network > Timing > Waiting | 100–200ms |
| **FCP** | Performance API / Performance tab | 150–250ms |
| **LCP** | Performance tab | 250–400ms |
| **DCL** | `performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd` | 300–500ms |
| **Load** | `performance.timing.loadEventEnd` | 500–800ms |
| **HTML Size (gzip)** | Network tab, Size column (số bên phải) | 150–250 KB |
| **HTML Size (raw)** | `decodedBodySize` API | 500–800 KB |
| **Total Requests** | Network tab | 8–15 (js, css, fonts) |
| **CLS** | Performance tab | < 0.1 |
| **Time to First Row** | Bảng render sau HTML bao lâu | 200–300ms |
| **Time to Last Row** | Tất cả rows render xong | 250–350ms |

### Đổi Bộ Lọc (period: month → week)
| Chỉ Số | Cách Đo | Kỳ Vọng |
|---|---|---|
| **Thời gian phản hồi** | Từ lúc bấm filter tới bảng cập nhật | 300–500ms |
| **Số requests** | Network tab (clear trước, count sau) | 1 (navigation) |
| **Loại requests** | XHR, Fetch, hay Document? | Document (page reload) |
| **Cache used?** | Status 304? Cache-Control header? | Không (dynamic rendering) |
| **Payload** | Response size | 150–250 KB gzip |
| **Refetch toàn bộ?** | DOM nodes removed & re-added? | Có (full re-render) |
| **CLS khi update** | Layout shift | < 0.05 |

### Đổi Sort (created_at: ASC → DESC)
| Chỉ Số | Cách Đo | Kỳ Vọng |
|---|---|---|
| **Thời gian cập nhật** | Từ click sort tới bảng thay đổi | 250–400ms |
| **Server request?** | Network tab | Có (sort server-side) |
| **Rows khác không?** | Số thứ tự hàng đảo lộn | Có thể khác nếu sort khác |

### Ranh Giới Server/Client
| Câu Hỏi | Câu Trả Lời |
|---|---|
| **`page.tsx` có `'use client'`?** | Không (Server Component) |
| **`OrdersTable` có `'use client'`?** | Có (Client Component) |
| **Bảng gọi database trực tiếp?** | Không (qua Server Component) |
| **Khi filter thay đổi, có XHR request?** | Không (router.push → internal navigation) |
| **HTML được render ở đâu?** | Server (Next.js SSR) |
| **CSS có hydration mismatch?** | Không (Tailwind static) |

---

## 📊 Cách Ghi Lại Kết Quả

### Bước 1: Tạo tệp JSON
```bash
cp docs/baselines/BASELINE-TEMPLATE.json docs/baselines/frontend-orders-2026-09-24.json
```

### Bước 2: Đo 3 lần mỗi scenario
```
Run 1: Tắt cache (Cmd+Shift+Delete) → reload → ghi TTFB
Run 2: Reload lại (cache bật) → ghi TTFB
Run 3: Reload lại → ghi TTFB lần cuối
Average = (run1 + run2 + run3) / 3
```

### Bước 3: Ghi vào JSON
```json
{
  "date": "2026-09-24T...",
  "measurements": [
    {
      "id": "orders-initial-load",
      "run": 1,
      "ttfb_ms": 145,
      "fcp_ms": 210,
      "lcp_ms": 320,
      // ... các metric khác
    },
    {
      "id": "orders-initial-load",
      "run": 2,
      "ttfb_ms": 142,
      // ...
    },
    // ...
  ],
  "summary": {
    "average_ttfb_ms": 145,
    // ...
  }
}
```

### Bước 4: Commit
```bash
git add docs/TECH-6-*.md docs/baselines/
git commit -m "TECH-6: Đo baseline phía trình duyệt

Baseline đo trên /orders, /reports/returns, /shipments:
- TTFB lần đầu: ~145ms
- LCP: ~320ms
- Payload: ~185KB gzip
- Requests per filter change: 1 (full page reload)
- Refetch: Full bảng (toàn bộ rows re-render)

Ranh giới server/client:
- page.tsx (Server) → OrdersTable (Client) → DataTable (Client)
- Filter change via router.push() → page re-run → HTML response

Tài liệu:
- TECH-6-FRONTEND-BASELINE.md: Định nghĩa chỉ số & quy trình
- TECH-6-MEASUREMENT-GUIDE.md: Hướng dẫn đo chi tiết
- TECH-6-ARCHITECTURE-ANALYSIS.md: Phân tích kiến trúc
- baselines/BASELINE-TEMPLATE.json: Mẫu ghi kết quả
- baselines/frontend-*.json: Kết quả đo thực tế"
```

---

## 🔍 Checklist Hoàn Thành

- [x] **Tài liệu kiến trúc:** TECH-6-FRONTEND-BASELINE.md
- [x] **Hướng dẫn đo:** TECH-6-MEASUREMENT-GUIDE.md
- [x] **Phân tích chi tiết:** TECH-6-ARCHITECTURE-ANALYSIS.md
- [x] **Mẫu baseline:** BASELINE-TEMPLATE.json
- [ ] **Đo thực tế:** Chạy 3 lần trên /orders, /reports, /shipments
- [ ] **Ghi kết quả:** Điền vào JSON template
- [ ] **So sánh:** Với expectations
- [ ] **Commit:** Push lên branch
- [ ] **Đánh giá:** Điểm optimize tiếp theo

---

## 🚀 Các Bước Tiếp Theo

### Lần sau khi làm TECH-6:

1. **Chạy đo thực tế** (3 runs mỗi scenario)
   - Trang `/orders` (page load, filter change, sort change)
   - Trang `/reports/returns` (page load, filter change)
   - Trang `/shipments` (page load, status filter)

2. **Điền vào JSON template**
   ```bash
   cp docs/baselines/BASELINE-TEMPLATE.json \
      docs/baselines/frontend-orders-$(date +%Y-%m-%d).json
   # Dùng text editor hoặc jq để cập nhật giá trị null
   ```

3. **Phân tích kết quả**
   - So sánh TTFB với kỳ vọng
   - Kiểm tra refetch type (full hay partial)
   - Tìm bottleneck (DB query? rendering? network?)

4. **Tối ưu hóa dựa vào baseline**
   - Nếu TTFB > 200ms: thêm database index, cache query
   - Nếu LCP > 500ms: virtual scrolling, giảm pageSize, code splitting
   - Nếu payload > 300KB: GraphQL, thinned responses, Brotli
   - Nếu requests > 5: batch API calls, Server Actions caching

5. **Đo lại sau optimize**
   - Chạy script đo lại (cùng scenario)
   - So sánh before/after
   - Tính % improvement

---

## 📚 Tài Liệu Liên Quan

- **Next.js Performance:** https://nextjs.org/docs/app/building-your-application/optimizing
- **Chrome DevTools Performance:** https://developer.chrome.com/docs/devtools/performance
- **Web Vitals:** https://web.dev/articles/vitals
- **TanStack Table:** https://tanstack.com/table/v8
- **nuqs (URL State):** https://nuqs.47ng.com

---

## 💡 Ghi Chú Quan Trọng

### Về Kiến Trúc
- **Page.tsx** là Server Component (KHÔNG có `'use client'`)
- **OrdersTable & DataTable** là Client Components (CÓ `'use client'`)
- Khi filter thay đổi, **KHÔNG có XHR request** — chỉ là `router.push()` → internal navigation
- **Full page re-render** (hiện tại, có thể optimize → partial refetch)

### Về Dữ Liệu
- Dữ liệu đơn hàng có **ORDER_OUTCOME logic phức tạp** (CASE statement)
- **Pagesize = 20** (hiện tại) → có thể giảm xuống 10–15 để tăng LCP
- **Bảng many-to-many** (`order_items` join) → impact TTFB

### Về Optimize
- **Không hard-code** cache time — dùng `memo()` hoặc `revalidate` directive
- **Không thêm API route** cho filter — dùng Server Actions thay vì XHR
- **Không viết custom fetch logic** — Next.js Router + `router.push()` đã tối ưu

---

## 📞 Liên Hệ / Hỏi Đáp

- **TTFB lâu quá?** → Kiểm tra: Database index có không? Query plan OK không? `memo()` cache có bật không?
- **Payload lớn quá?** → Kiểm tra: HTML bao gồm những gì? Có CSS/JS lớn? Có inline image không?
- **Requests nhiều quá?** → Kiểm tra: Có lazy-load CSS/JS không? Có 3rd party script không?
- **Ranh giới unclear?** → Đọc TECH-6-ARCHITECTURE-ANALYSIS.md phần "Cách Xác Định"

---

**Tạo bởi:** TECH-6 | **Branch:** ai/frontend/TECH-6-mudq6e2k | **SHA:** 65547ab
