# Phase 5 — Trình dựng trang kéo-thả: hợp đồng

> Runtime KHÔNG đổi bản chất (X1): vẫn `PageSchema → sections → blocks`, `validatePageSchema`, `resolvePage`,
> một renderer. Phase 5 (a) mở rộng schema một cách TƯƠNG THÍCH NGƯỢC (mọi trang đã xuất bản vẫn hợp lệ, không
> migration dữ liệu), (b) thêm trình soạn trực quan ba cột. Không thêm thư viện: kéo-thả bằng HTML5 Drag and Drop
> gốc của trình duyệt, còn bàn phím dùng các nút lên/xuống/chuyển nhóm/độ rộng sẵn có.

## 1. Schema 1.1 (`lib/pages/types.ts`) — chỉ THÊM

```ts
BLOCK_TYPES = [...cũ, "filter", "column"]            // 10 loại
PageSection = { key; title?; blocks; variant?: "card" | "plain" }   // "plain" = HÀNG (không khung, không tiêu đề)
PageBlock   = { ...cũ; children?: PageBlock[] }      // CHỈ khối "column" có children
```

- **Section** (thư viện "Nhóm") = section `variant: "card"` (mặc định, như Phase 4).
- **Row** (thư viện "Hàng") = section `variant: "plain"`: các khối xếp lưới 12 cột, không khung.
- **Column** (thư viện "Cột") = khối `column` có `span`, chứa tối đa 6 khối con xếp DỌC (vd hai KPI chồng nhau cạnh một
  biểu đồ). Khối con không phải `column`/`filter`; `span` của khối con bị bỏ qua (rộng hết cột). Chỉ MỘT tầng lồng.
  Trần 20 khối đếm CẢ khối con.
- **Heading/Text**: `TextConfig` thêm `variant?: "heading" | "paragraph" | "note"`.
- **Filter** (`FilterConfig`):
  ```ts
  { period?: boolean;                                      // hiện chọn kỳ (tham số `period` chung của trang)
    fields: { objectKey: string; ref: FieldRef; op: ListFilterOp; label?: string }[];   // ≤ 4
    targets: string[] }                                     // id khối nhận bộ lọc (table · kanban · kpi/chart tổng hợp)
  ```
  Giá trị người xem nhập đi qua URL `pf_<filterBlockId>_<i>` (máy chủ đọc, không tin kiểu: parse theo kiểu field).
  Trình phân giải áp bộ lọc lên khối đích CÙNG `objectKey`, và CHỈ khi field `filterable` (như lọc cố định).
- **KPI tổng hợp** — `KpiConfig` thành hợp:
  ```ts
  { metric: string; period?; label? }                                   // cũ — sổ METRIC_SOURCES
  | { aggregate: AggregateSpec; period?; dateField?: FieldRef; label? } // mới
  AggregateSpec = { objectKey: string; fn: "count" | "sum" | "avg" | "min" | "max"; field?: FieldRef; filters?: ListFilter[] }
  ```
- **Biểu đồ tổng hợp** — `ChartConfig` thành hợp:
  ```ts
  { series: string; kind; period? }                                      // cũ — sổ SERIES_SOURCES
  | { aggregate: AggregateSpec; kind; groupBy: { ref: FieldRef } | { bucket: "day" | "week" | "month"; dateField: FieldRef }; period? }
  ```
  Tối đa 50 nhóm (còn lại gộp "Khác"). `pie` chỉ với `groupBy.ref`.
- **Hành động theo dòng** — `TableConfig.rowActions?: { action: string; label: string; input?: Record<string, unknown>; confirm?: string }[]` (≤ 3).
  `executePageAction(slug, blockId, input, user, { loadPublished, recordId?, actionIndex? })`: máy chủ đọc lại khối
  ĐÃ XUẤT BẢN, lấy `rowActions[actionIndex]`, kiểm bản ghi `recordId` tồn tại và nằm trong phạm vi người bấm.

### Luật tổng hợp (quan trọng — AGENTS.md mục 0/3)

- Chỉ đối tượng có trong `LIST_SOURCES` (và sau Phase 6: đối tượng tuỳ biến). Module + quyền + phạm vi như bảng.
- `sum/avg/min/max` chỉ trên field SỐ khai `aggregatable`. **Field tiền của `order` / `shipment` / `return` KHÔNG
  aggregatable**: doanh thu, COD, tiền hoàn chỉ có MỘT công thức (ORDER_OUTCOME, qua `METRIC_SOURCES`). `count` và
  nhóm theo trạng thái/ngày thì được — đó là đếm bản ghi, không phải kết luận kết quả đơn. Field số tuỳ biến (Phase 2)
  aggregatable mặc định.
- `groupBy.ref`: field kiểu select/status/boolean/người dùng, hoặc field trạng thái hệ thống; nhãn lấy theo override
  trạng thái Phase 2. `dateField`: field ngày/giờ.
- Chưa biết ⇒ `null` (luật 42), không phải 0.

## 2. Lưu nháp chống ghi đè

- Migration CHỈ THÊM `meta_pages.draft_revision integer NOT NULL DEFAULT 0`.
- `savePageDraft(id, schema, actor, { baseRevision? })`: có `baseRevision` mà khác revision hiện tại ⇒ `CONFLICT`
  (không ghi); ghi thành công ⇒ revision + 1 và trả về. Không truyền ⇒ hành vi Phase 4 (trình soạn cũ).
- `getPageDraft` trả thêm `draftRevision`.

## 3. Xem trước từng khối

`previewPageBlock(pageId, block)` (server action, `metadata:manage`): kiểm khối bằng `validatePageSchema` trên một
schema một-khối → `resolveBlock(block, người soạn, ctx)`. Trình soạn gọi khi cấu hình khối đổi (chống dội 400 ms);
kéo / đổi chỗ / đổi độ rộng KHÔNG gọi máy chủ.

## 4. Trình soạn ba cột (`/settings/pages/[id]/builder`)

```
TRÁI  Thư viện: Nhóm · Hàng · Cột · KPI · Bảng · Form · Kanban · Biểu đồ · Dòng thời gian · Bộ lọc · Nút · Tiêu đề/Chữ · Mẫu
GIỮA  Khung: renderer THẬT ở chế độ soạn — chọn, kéo đổi chỗ, kéo sang nhóm/cột khác, tay nắm đổi độ rộng (bắt 3/4/6/8/12),
      nhân bản, xoá; xem Máy tính / Điện thoại (khung 390px)
PHẢI  Thuộc tính theo tab: Dữ liệu (nguồn · cột · lọc · sắp xếp · phân trang · tổng hợp · nhóm theo · kỳ) ·
      Hành động (nút · hành động theo dòng · xác nhận · luật) · Hiển thị (tiêu đề · độ rộng · ẩn theo quyền/module)
THANH TRÊN  Tên · trạng thái tự lưu · Hoàn tác / Làm lại · Xem trước · Xuất bản · Thêm vào menu · phiên bản
```

- Mọi thao tác là HÀM THUẦN `(schema, op) → schema` trong `lib/platform-ui/page-builder-ops.ts`, có bài kiểm:
  `insertBlock · moveBlock · moveSection · setSpan · duplicateBlock (id mới, không trùng) · removeBlock ·
  wrapInColumn · insertSection`. Hoàn tác/làm lại = ngăn xếp schema (≤ 50 bước), chỉ ở trình duyệt.
- Tự lưu 2 giây sau thao tác cuối, gửi `baseRevision`; `CONFLICT` ⇒ hộp "người khác vừa lưu — tải bản của họ / ghi đè
  (xác nhận)". Lỗi kiểm của máy chủ hiện ở khung phải theo `path`, KHÔNG xoá thao tác của người dùng.
- Thuộc tính DÙNG LẠI `block-config-form.tsx` (một form cho cả trình soạn cũ lẫn mới), mở rộng cho cấu hình mới.
- Trình soạn Phase 4 (`/settings/pages/[id]`) ở lại làm chế độ bàn phím / dự phòng; danh sách trang mở trình kéo-thả.

## 5. Chấp nhận (không deploy, cùng PID + BUILD_ID) — Phase 5 chỉ XONG khi bài này xanh

1. Quản trị tổ chức: tạo trang → kéo KPI → kéo Bảng → kéo Biểu đồ → cấu hình theo Đơn hàng → xuất bản → trang có trên menu.
2. Sửa: kéo biểu đồ sang chỗ khác → thêm Bộ lọc (trạng thái đơn) nhắm vào bảng → xuất bản → tải lại: bố cục mới + bộ lọc
   lọc được bảng.
3. Khung điện thoại không vỡ; trang thật ở 390px không cuộn ngang.
4. Hai người cùng soạn ⇒ người lưu sau nhận CONFLICT.
5. Tổ chức khác / thiếu quyền / module tắt: lặp nguyên các bài Phase 4, kết quả không đổi.
