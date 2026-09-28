# Trạng thái thực thi — ERP Builder Platform

> Tệp BÀN GIAO. Phiên nào tiếp quản (hoặc phiên này sau khi nén ngữ cảnh) đọc tệp này trước, rồi `builder-roadmap.md`.
> Cập nhật mỗi khi một phase gộp / deploy, hoặc trước khi ngữ cảnh đầy.

## Production (erp.vnxcommerce.com)

| Mốc | Commit | PR | Migration |
|---|---|---|---|
| Phase 1 · 1.x · hotfix | `ec208b26` … `3885b374` | #313 #314 #318 #319 #323 #333 | — |
| Phase 2 — metadata | (trong #333) | | |
| Phase 3 — workflow | `4cc9b711` | #341 | 0160 |
| Phase 3.1 — tải tệp · phục hồi lượt treo · rào migration | `95848d9f` | #345 | 0162 |
| Phase 4 — trang động `/p/<slug>` | `4f82910a` | #346 | 0163 |

Health 28/09/2026 07:48 (giờ VN): `ok`, `homeModules 23/23`, `migrations 164`.

## Đang làm (đợt 1 — xem `builder-roadmap.md` §3)

| Việc | Nhánh / cây | Hợp đồng |
|---|---|---|
| P5-RUNTIME — schema 1.1, tổng hợp, bộ lọc, cột, hành động theo dòng, chống ghi đè nháp | `claude/platform-p5-runtime` · `wt-p5-runtime` | phase-5-contracts.md §1–3 |
| P5-BUILDER — trình kéo-thả ba cột | `claude/platform-p5-builder` · `wt-p5-builder` | phase-5-contracts.md §4–5 |
| P6-OBJECTS — đối tượng tuỳ biến | `claude/platform-p6-objects` · `wt-p6` | phase-6-contracts.md |
| P9-CONNECTORS — sổ connector + kết nối theo tổ chức | `claude/platform-p9-connectors` · `wt-p9` | phase-9-contracts.md |

Mỗi agent: một commit, cổng đầy đủ, KHÔNG push. Phiên tích hợp ghép theo thứ tự P5 → P6 → P9, đánh lại số migration
bằng `npm run migration:renumber`, rồi PR → gộp → deploy → kiểm.

## Quy trình phát hành (không đổi)

`scratchpad/pr/ship_platform.py` (hàng đợi `queue.txt`: `<nhánh>|<tệp tiêu đề>|<tệp thân>`) mở PR, bật tự gộp, cập nhật
nhánh, gộp, dispatch MỘT lượt `Deploy ERP to VPS`, so `/api/health` với commit `main`. Chạy bằng `PYTHONUTF8=1`.
Deploy đỏ: đọc log job `release` (`scratchpad/pr/joblog.py <run> release`) — "chưa chạm máy chủ" (hết giờ chờ khoá) thì
dispatch lại đúng một lượt.

## Human gate đang mở

KHÔNG.

## Nợ đã biết

Xem `phase-5-contracts.md` (không có nợ mới) và mục "Nợ" cuối `phase-4-contracts.md` / báo cáo Phase 4:
bảng trang động không bọc `list*()` cũ · timeline tuỳ biến 6 khoá · `available_stock` đường ngắn · `request_approval`
chỉ khách hàng · menu đọc `meta_pages` mỗi lượt tải · trang không tìm thấy trả 200 (streaming).
