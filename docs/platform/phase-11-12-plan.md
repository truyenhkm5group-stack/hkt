# Phase 11 — Gia cố sản phẩm · Phase 12 — Chấp nhận thương mại

> Sau Phase 5–10, nền tảng có đủ tính năng MVP. Phase 11 KHÔNG thêm tính năng: nó chứng minh các tính năng không rò
> giữa tổ chức, không sập khi dữ liệu lớn, khôi phục được, và quan sát được. Phase 12 là bài chấp nhận cuối.

## Phase 11 — bốn mảng, chạy song song

### H1 · Tấn công cô lập (E2E #7 ở mức mã)
`tests/tenant-attack.test.ts`: hai tổ chức thật A, B có ĐỦ thứ (field + tệp, đối tượng tuỳ biến + bản ghi + quan hệ,
form, trang đã xuất bản, luật + lượt chạy + lời duyệt, blueprint đã cài, bản nháp AI, kết nối có bí mật, thương hiệu +
logo). Người của A gọi THẲNG mọi server action / route handler / hàm dịch vụ bằng id, khoá, slug của B:
đọc · ghi · xuất bản · chạy luật · duyệt · tải tệp · tải logo · mở trang · phân giải khối · executePageAction ·
xem trước blueprint · áp dụng nháp AI · kiểm tra / bật kết nối · đọc ngữ cảnh AI. MỌI lượt phải thất bại mà không
đổi một dòng nào của B (so ảnh chụp đếm dòng trước/sau). Thêm bộ quét tĩnh: mọi server action mới có `requireUser`
và không nhận `orgCode` từ client.

### H2 · Tải và quy mô
- Gieo tổ chức thử: 20.000 bản ghi tuỳ biến, 5.000 đơn, trang 20 khối (bảng, KPI tổng hợp, biểu đồ nhóm, kanban).
- Đo `resolvePage` (p50/p95), `listRecords` trang 1/100, bộ lọc jsonb, tổng hợp nhóm theo ngày, kanban 200 thẻ.
- Đếm câu truy vấn mỗi lượt dựng trang (móc drizzle logger ở bài kiểm): không N+1 (số câu KHÔNG tăng theo số dòng).
- Index CHỈ THÊM nếu đo ra cần: `custom_records(object_key, deleted_at, updated_at)`, `custom_values` theo
  `(object_key, record_id)`, GIN trên `custom_values.values` nếu lọc jsonb chậm. Không đoán — đo trước/sau.
- Nhiều tổ chức trong một tiến trình: 5 tổ chức × trang song song; bể kết nối mỗi tổ chức (quyết định đã đo: 5).

#### Kết quả H2 (28/09/2026 · PGlite trên máy lập trình · `scripts/platform-load-probe.ts`, 15 lượt + 2 làm nóng, memo xoá mỗi lượt)

Tổ chức `lprobe-1`: 20.000 `x_contract` + 5.000 bản ghi đối tượng khác cùng bảng + 5.000 đơn + 2.000 khách; bốn tổ chức
còn lại 5.000 hợp đồng. Con số tuyệt đối là PGlite một luồng, KHÔNG phải VPS; so sánh được là số câu và trước/sau.

| Kịch bản (sau H2) | p50 ms | p95 ms | câu |
|---|---:|---:|---:|
| `resolvePage` trang 20 khối | 708,7 | 918,8 | 46 (trước: 94) |
| `listRecords` trang 1 (50 dòng) | 14,7 | 16,6 | 9 |
| `listRecords` trang 100 | 29,8 | 32,5 | 9 |
| lọc jsonb trạng thái = … (5.000 khớp) | 51,7 | 59,5 | 9 |
| lọc jsonb một khách (10 khớp) | 90,3 | 226 | 9 |
| bảng lọc jsonb giá trị ≥ 90 tr | 28,3 | 33,5 | 8 |
| biểu đồ tổng theo ngày (365 mốc) | 145,7 | 153,7 | 3 |
| kanban 200 thẻ | 23,2 | 27,9 | 9 |
| 5 tổ chức × trang 20 khối song song (tường) | 1.657 | 2.053 | — |

- **N+1 theo số dòng: KHÔNG CÓ** ở bảng hệ thống, bảng `x_…`, kanban, KPI / biểu đồ tổng hợp, cả trang, `/o/<khoá>`,
  `/o/<khoá>/<id>`, liên kết ngược, `getCustomValues` — `tests/page-query-budget.test.ts` khoá 10 dòng = 200 dòng.
- **N+1 theo số KHỐI: CÓ, đã sửa.** Mỗi khối / mỗi cổng tự đọc lại `meta_objects` (31×) và `meta_custom_fields` (22×)
  của cùng đối tượng — 53/94 câu của trang 20 khối. `lib/metadata/read-scope.ts`: một lượt dựng (`resolvePage`,
  `resolveBlock`, `listRecords`, `reverseRelations`, trang `/o/<khoá>/<id>` qua `loadRecordDetailPage`) là MỘT phạm vi đọc
  metadata, mất khi lượt xong (M13 giữ nguyên — không đệm giữa các lượt). 94 → 45 câu (trang 20 khối), 59 → 32 (trang 9
  khối của bài kiểm), 28 → 21 (chi tiết), 13 → 12 (danh sách). 5 tổ chức song song: p50 1.980 → 1.740 ms.
- **Index thêm (migration 0171), đo cả ba lượt:** `custom_records_live_updated_idx` (listRecords trang 1 36,9 / 41,8 /
  40,3 → 15,5 / 15,3 / 14,7 ms; lọc jsonb trạng thái 94,7 / 106,2 / 108,9 → 51,4 / 51,7 / 51,7 ms) và
  `custom_records_live_created_idx` (bảng x_… trang 1 26,4 / 30,6 → 15,2 / 14,7 ms; kanban 34,9 / 45,4 → 23,6 / 23,2 ms).
- **Không thêm:** GIN `jsonb_path_ops` trên `custom_values.values` — không nhanh hơn ở lượt đo nào (lọc một khách
  77,3 → 82,7 và 90,3 → 101 ms), chỉ thêm giá ghi. Index `(object_key, record_id)` của `custom_values` đã có sẵn (unique).
- **Bể kết nối không đổi:** nhà `PGPOOL_MAX` = 5, tổ chức `PGPOOL_MAX_ORG` = 2 (quyết định đã đo). Giảm câu metadata là cách
  giảm chờ bể, không phải nâng bể. CHƯA ĐO trên Postgres thật (`--postgres` có sẵn, cần máy thử có CREATEDB).

### H3 · Sao lưu / khôi phục / xuất tổ chức
- `exportOrgBlueprint(org)`: dựng ngược cấu hình HIỆN TẠI của tổ chức thành MỘT blueprint (module, vai trò, đối
  tượng, field, trạng thái, form, danh sách, trang, luật, cài đặt an toàn). Không kèm bản ghi, người dùng, secrets.
- Khôi phục cấu hình = cài blueprint đó vào tổ chức mới (cùng bộ cài Phase 7) ⇒ kiểm vòng tròn: xuất → cài vào tổ
  chức trống → xuất lại ⇒ hai blueprint bằng nhau (băm ổn định).
- Màn `/settings/export` (quản trị): tải blueprint JSON. Sao lưu CSDL VPS hằng đêm đã có (Drive) — tài liệu
  `docs/platform/backup-recovery.md` ghi rõ: tổ chức khác nhà là CSDL riêng ⇒ lịch sao lưu phải liệt kê CSDL tổ chức
  (kiểm script sao lưu hiện tại có phủ không; không phủ ⇒ ghi rõ, và thêm bước nếu làm được không cần secret mới).
- Khôi phục migration: tài liệu hoá (migration CHỈ THÊM, `drizzle.__drizzle_migrations` là lời khai cuối).

### H4 · Chẩn đoán + gỡ dấu VNX + nối hạn mức
- `/platform/org/<code>` (người vận hành): module, số metadata (field/form/trang/đối tượng/luật), lượt luật treo,
  kết nối (trạng thái, lần kiểm cuối), nháp AI, blueprint đã cài, lỗi khối trang gần đây (perf registry), job.
- Tổ chức không-nhà không thấy chữ "Pancake" / "Viettel Post" / VNX trong mô tả trang lõi (điều kiện theo
  connector/module); favicon + tên tab theo thương hiệu tổ chức.
- Nối `checkEntitlement` cho đối tượng, bản ghi tuỳ biến, bản nháp AI (Phase 10 đã khai kind).

## Phase 12 — Chấp nhận thương mại (máy thử, KHÔNG production, KHÔNG dữ liệu khách)

Ba tổ chức mẫu dựng qua `/start` (chế độ invite trên máy thử): **A Thời trang** (mẫu fashion-commerce), **B Bán sỉ**
(wholesale, không marketing/sản xuất), **C Dịch vụ** (service-business, có đối tượng riêng). Tám bài E2E chạy bằng
trình duyệt thật (playwright-core + Chrome), cùng một bản build, ghi PID + BUILD_ID:

1. Tổ chức mới → mẫu → module → mở ERP dùng được.
2. Field tuỳ biến → thêm vào form → xuất bản → field hiện.
3. Luật: sự kiện → điều kiện → duyệt → hành động chạy đúng một lần.
4. Trang: kéo-thả → cấu hình → xem trước → xuất bản → menu.
5. Đối tượng tuỳ biến → field → form → danh sách → luật → bản ghi.
6. AI: "Tạo ERP cho công ty bán buôn có CRM, đơn hàng, mua hàng, kho và tài chính" → blueprint → duyệt → áp dụng.
   Cần khoá AI thật của tổ chức thử (HUMAN GATE credential); thiếu thì chạy với provider giả và ghi rõ "chưa chạy
   với model thật".
7. Tấn công cô lập qua trình duyệt (id/slug/tệp của tổ chức khác) — cùng bộ H1 nhưng từ giao diện.
8. Nâng lõi: dựng bản build commit N, tạo tuỳ biến, dựng commit N+1 (một thay đổi an toàn), khởi động lại trên cùng
   CSDL ⇒ mọi tuỳ biến còn nguyên (so blueprint xuất ra trước/sau).

Báo cáo cuối theo đúng khuôn "ERP BUILDER PLATFORM — COMMERCIAL MVP COMPLETE" chỉ khi 1–5, 7, 8 xanh và 6 xanh với
model thật (hoặc gate được nêu rõ).
