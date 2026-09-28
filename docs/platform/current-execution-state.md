# Trạng thái thực thi — ERP Builder Platform

> Tệp BÀN GIAO. Phiên nào tiếp quản (hoặc phiên này sau khi nén ngữ cảnh) đọc tệp này trước, rồi `builder-roadmap.md`.
> Cập nhật mỗi khi một phase gộp / deploy, hoặc trước khi ngữ cảnh đầy.

## Production (erp.vnxcommerce.com) — cập nhật 28/09/2026 12:10 (giờ VN)

| Mốc | Commit | PR | Migration |
|---|---|---|---|
| Phase 1 · 1.x · hotfix | `ec208b26` … `3885b374` | #313 #314 #318 #319 #323 #333 | — |
| Phase 3 — workflow | `4cc9b711` | #341 | 0160 |
| Phase 3.1 — tải tệp · phục hồi lượt treo · rào migration | `95848d9f` | #345 | 0162 |
| Phase 4 — trang động `/p/<slug>` | `4f82910a` | #346 | 0163 |
| Phase 9 — sổ connector · kết nối theo tổ chức | `2c8f908c` | #350 | 0164 |
| Phase 7a — blueprint · 3 mẫu ngành | `d91067b0` | #353 | 0165 |
| Phase 6 — đối tượng tuỳ biến | `23a2cd2c` | #356 | 0166 (module 24/24) |
| Phase 5 — trình kéo-thả | `658fff61` | #358 | 0167 |

Health 12:08: `ok`, `homeModules 24/24`, commit khớp `main`.

## Đang phát hành

| Việc | Nhánh | PR | Migration |
|---|---|---|---|
| Đợt 2: Phase 7b (mẫu dùng đối tượng) · Phase 8 (AI dựng cấu hình) · Phase 10 (tự phục vụ) | `claude/platform-wave2` | #359 | 0168, 0169 |
| P56 — đối tượng tuỳ biến trong trang + liên kết ngược + chọn khối con + blueprint kiểm trang theo sổ của gói | `claude/platform-p56int` | (sau #359) | — |

## Đang làm — Phase 11 (gia cố, `phase-11-12-plan.md`)

| Agent | Nhánh / cây | Việc |
|---|---|---|
| H1 | `claude/platform-p11-h1` · `wt-h1` | bộ tấn công cô lập (E2E #7 mức mã) + quét tĩnh server action |
| H2 | `claude/platform-p11-h2` · `wt-h2` | tải 20k bản ghi, ngân sách câu truy vấn (N+1), index nếu đo ra cần |
| H3 | `claude/platform-p11-h3` · `wt-h3` | xuất cấu hình thành blueprint, vòng tròn khôi phục, tài liệu sao lưu |
| H4 | `claude/platform-p11-h4` · `wt-h4` | chẩn đoán theo tổ chức, gỡ dấu VNX cho tổ chức khác, nối hạn mức |

Sau Phase 11: Phase 12 — ba tổ chức mẫu qua `/start` trên máy thử + 8 E2E cuối (`phase-11-12-plan.md`).

## Quy trình phát hành

`scratchpad/pr/ship_platform.py` là tiến trình chạy liền (tự thoát sau 6 giờ rảnh): chỉ cần THÊM dòng
`<nhánh>|<tệp tiêu đề>|<tệp thân>` vào `queue.txt`. KHÔNG khởi động tiến trình thứ hai (hai tiến trình ⇒ dispatch trùng).
Deploy đỏ: đọc log job `release` (`scratchpad/pr/joblog.py <run> release`); "chưa chạm máy chủ" ⇒ dispatch lại một lượt.
Nhánh chồng lên nhánh chưa gộp: sau khi nhánh dưới gộp squash ⇒ `git rebase --onto origin/main <commit-dưới-cũ> <nhánh>`.
Đổi số migration: `npm run migration:renumber -- --base <ref> --apply` + thêm dòng MOI + sửa số trần trong chú thích.
Commit/PR KHÔNG mang tên model AI, KHÔNG dòng Co-Authored-By (AGENTS.md 6.6).

## Human gate

Không có gate nào chặn việc đang làm. Gom lại để hỏi chủ nền tảng MỘT lần ở Phase 12:
1. `PLATFORM_SECRETS_KEY` (≥ 32 ký tự ngẫu nhiên) — để tổ chức khác lưu được bí mật kết nối trên production / máy thử.
2. Khoá AI thật (Anthropic/OpenAI) của một tổ chức thử — cho E2E #6 với model thật; hoặc chủ shop đồng ý thử bằng khoá VNX.
3. Mở đăng ký trên production (`PLATFORM_SIGNUP_MODE`) — hiện `off` theo X7.

## Nợ đã biết

- Bảng trang động không bọc `list*()` cũ (thiếu bộ lọc/cờ riêng của `/orders`).
- `available_stock` của trang tính đường ngắn (có thể lệch nhẹ thẻ trang chủ).
- `request_approval` chỉ gắn khách hàng.
- Menu đọc `meta_pages` + `meta_objects` mỗi lượt tải bố cục (không đệm — M13).
- Trang không tìm thấy trả HTTP 200 (streaming có `loading.tsx`).
- AI Builder chưa chạy với model thật (schema công cụ ~11 KB chưa thử với nhà cung cấp).
- Kéo xa khi phải cuộn trong trình kéo-thả chưa đo trên màn hình thường.
