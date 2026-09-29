# Trạng thái thực thi — ERP Builder Platform

> Tệp BÀN GIAO. Phiên nào tiếp quản (hoặc phiên này sau khi nén ngữ cảnh) đọc tệp này trước, rồi `builder-roadmap.md`.
> Cập nhật mỗi khi một phase gộp / deploy, hoặc trước khi ngữ cảnh đầy.

## Tóm tắt — 29/09/2026 12:30 (giờ VN)

**ERP BUILDER PLATFORM — COMMERCIAL MVP COMPLETE.** Phase 1 → 12 đã code, gộp và lên production; bài chấp nhận Phase 12
(`phase-12-acceptance.md`) 8/8 ĐẠT, kể cả E2E #6 AI dựng ERP với model thật (khoá riêng của tổ chức thử).

## Production (erp.vnxcommerce.com)

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
| Đợt 2 — Phase 7b · 8 (AI) · 10 (tự phục vụ) | `64cd4732` | #359 | 0168, 0169 |
| Đối tượng tuỳ biến trong trang (§7 Phase 6) | `30dd60a2` | #360 | — |
| Phase 11 — gia cố (tấn công · tải · xuất cấu hình · chẩn đoán) | `7fb07c55` | #363 | 0171 |
| Sao lưu CSDL `erp_org_*` | `32f1c2fa` | #365 | — |
| Phase 12 — 5 lỗi E2E (màn duyệt lõi `/approvals` …) | `ca0fc7a6` | #366 | — |
| Sẵn sàng thương mại A–D (khoá bí mật · /start không deploy · diễn tập khôi phục · 176 mặt) | `559099c1` | #378 | 0172 |
| AI Builder gọi Anthropic thật (schema công cụ) | `a483e1d6` | #386 | — |

Production chạy `a483e1d6` (có mọi mốc trên), health `ok`, 24/24 module, 174 migration.

## Tính năng (đều cấu hình không deploy)

Tổ chức (SILO, mỗi tổ chức một CSDL) · module bật/tắt · field tuỳ biến + tệp · form / danh sách / trạng thái · luật
(trigger → điều kiện → cửa duyệt → hành động, đúng một lần, phục hồi lượt treo) · trang động + trình kéo-thả (KPI, bảng,
biểu đồ, kanban, form, dòng thời gian, bộ lọc, cột, nút) · đối tượng tuỳ biến + quan hệ · blueprint + 5 mẫu ngành + nâng
phiên bản 3 chiều · AI soạn blueprint (khoá AI của chính tổ chức) · sổ connector + kết nối theo tổ chức (bí mật mã hoá)
· `/start` tự phục vụ (TẮT trên production) · thương hiệu · gói + hạn mức · xuất / khôi phục cấu hình · chẩn đoán từng
tổ chức · màn duyệt lõi.

## Cổng mở bán — CHỦ ĐỘNG TẮT, bật khi chủ nền tảng quyết (`launch-gates.md`)

1. `PLATFORM_SECRETS_KEY` trên production: tạo secret GitHub (`openssl rand -base64 48`) rồi dispatch deploy — thiếu thì
   tổ chức khác không lưu được bí mật kết nối (VNX không ảnh hưởng).
2. Đăng ký `/start`: TẮT. Bật «Cần mã mời» ở `/platform` → Cổng mở bán (không deploy); `open` cần trần môi trường.
3. Sao lưu tổ chức: dung lượng Drive, tải VPS 02–05 giờ, diễn tập khôi phục tự động (C1–C6).
4. Ai trả tiền token Copilot cho tổ chức khác (hiện Copilot chỉ ở tổ chức nhà; AI Builder dùng khoá của chính tổ chức).

## Quy trình phát hành

`scratchpad/pr/ship_platform.py` là tiến trình chạy liền (tự thoát sau 6 giờ rảnh): chỉ cần THÊM dòng
`<nhánh>|<tệp tiêu đề>|<tệp thân>` vào `queue.txt`. KHÔNG khởi động tiến trình thứ hai. Nhánh `*-docs` không deploy.
Deploy đỏ: đọc log (`scratchpad/pr/joblog.py <run> "<tên job>"`); gates đỏ ⇒ chưa chạm máy chủ.
Nhánh chồng lên nhánh chưa gộp: sau khi nhánh dưới gộp squash ⇒ `git rebase --onto origin/main <commit-dưới-cũ> <nhánh>`.
Đổi số migration: `npm run migration:renumber -- --base <ref> --apply` + dòng MOI + số trần trong chú thích.
Commit/PR KHÔNG mang tên model AI, KHÔNG dòng Co-Authored-By (AGENTS.md 6.6).

## Nợ đã biết (không chặn)

- Bảng trang động không bọc `list*()` cũ; `available_stock` của trang tính đường ngắn; `request_approval` chỉ khách hàng.
- Menu đọc `meta_pages` + `meta_objects` mỗi lượt tải bố cục; trang không tìm thấy trả HTTP 200 (streaming).
- AI Builder: một lượt dựng mới ~1,1 USD (3 lượt gọi claude-opus-5); chưa có trần chi phí theo gói ngoài 20 lượt/ngày.
- Kéo xa khi phải cuộn trong trình kéo-thả chưa đo trên màn hình thường.
- Cài blueprint vượt hạn mức đối tượng hỏng giữa chừng (kế hoạch chưa báo trước).
- Sao lưu tổ chức chưa có diễn tập khôi phục TỰ ĐỘNG (có ops `restore-drill-org` chạy tay — bật tự động là cổng C2 ở `launch-gates.md`); đêm nhà hỏng thì tổ chức không được sao lưu.
- `/login`, `/start` và một số trang lõi ngoài danh sách H4 còn chữ gốc VNX.
