# Trạng thái thực thi — ERP Builder Platform

> Tệp BÀN GIAO. Phiên nào tiếp quản (hoặc phiên này sau khi nén ngữ cảnh) đọc tệp này trước, rồi `builder-roadmap.md`.
> Cập nhật mỗi khi một phase gộp / deploy, hoặc trước khi ngữ cảnh đầy.

## Tóm tắt — 29/09/2026 (giờ VN)

**ERP BUILDER PLATFORM — READY FOR CONTROLLED PILOT** (`pilot-readiness.md`). Sau MVP thương mại (Phase 1 → 12,
`phase-12-acceptance.md` 8/8), chương trình Commercial Pilot Readiness đã lên production: khoá bí mật sẵn sàng (chờ chủ
đặt khoá), diễn tập khôi phục Postgres ĐẠT, sổ dùng AI + hạn mức + công tắc, sản phẩm / đơn tạo tay, vòng đời pilot +
trang sức khoẻ + công tắc khẩn + đổi gói, chạy lại cô lập 243 mặt. Bài chấp nhận pilot bán buôn 9/9 qua giao diện, 0 P0.

**01/10/2026 — PLATFORM WORKSTREAM CLOSED FOR FEATURE DEVELOPMENT.** Production `dd23666a` (183 migration). Ba việc cuối
đã xong: khoá bí mật giữ nguyên (chủ tự cất bản phục hồi); PITR `erp-db` bật 30/09 22:52 (#421, #424), diễn tập OK hai vế,
RPO đo ≤ 15 phút, RTO phần máy 18 giây; chứng từ thanh toán đơn tay (#416). Trạng thái: **READY FOR CONTROLLED PILOT**.
Chỉ mở lại khi HSLC / khách pilot phát hiện khoảng trống GENERIC — xem `pilot-readiness.md` mục 4 (nợ) và mục 5 (quan sát).

**30/09/2026:** khoá bí mật đã đặt và kiểm 8/8 trên production (`pilot-readiness.md` mục 6); bốn quyết định của chủ
nền tảng đã lên production — G-ORDER #407, G-SCHED #405, D1 = BYOK, sao lưu tổ chức hằng giờ + diễn tập hằng tuần #410.
Production `6ea8b524`, 181 migration. Cổng còn lại: V6 (bản sao khoá ngoài VPS) và cửa sổ bảo trì bật PITR cho CSDL nhà.

**DỪNG MỞ RỘNG NỀN TẢNG Ở ĐÂY.** Việc kế tiếp là khách thương mại đầu tiên HSLC SHOP — workstream / phiên RIÊNG, đọc
`hslc-commercial-pilot-handoff.md` (bảng HSLC SELF-SERVICE GAP + thứ tự gap P0). Chưa triển khai HSLC trong phiên này.

**G-SCHED (chủ duyệt 29/09/2026) — nhánh `claude/platform-pilot-g-sched`, CHƯA gộp / deploy.** Luật tự động + việc định
kỳ của tổ chức khách tự chạy mỗi 10 phút (nhịp theo gói, ≥ 5 phút; `lib/constants/workflow-cadence.ts`), tuần tự từng tổ
chức, trần 60 giây / tổ chức / lượt, qua job `workflows` + tầng fan-out tự động hoá (`SCHEDULER_AUTOMATION_FANOUT`, compose
đặt `1`). Luật của VNX vẫn chạy ké job cảnh báo, lịch giữ nguyên. Tạm dừng một tổ chức: công tắc khẩn «Tạm dừng mọi
luật»; cả nền tảng: `.env` `SCHEDULER_AUTOMATION_FANOUT="0"` + khởi động lại scheduler (`pilot-operations.md` mục 3a).

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
| Pilot A1 — khoá bí mật: tự kiểm, health, xoay khoá | `ad71adf5` | #391 | — |
| Pilot A2 — diễn tập khôi phục Postgres thật (CI) | `715fafc2` | #392 | — |
| Pilot B1 — sản phẩm / mẫu mã tay, nhập kho có đơn giá | `0e846632` | #396 | — |
| Pilot B2 — đơn tạo tay | `9df34708` | #398 | — |
| Pilot A3 — sổ dùng AI · hạn mức · công tắc AI | `f1c96673` | #393 | 0176 |
| Pilot A4 — vòng đời pilot · sức khoẻ · công tắc khẩn · đổi gói | `e571a9de` | #399 | 0177 |
| Pilot — chạy lại cô lập 243 mặt · `/login` không lộ cấu hình nhà | `a8f7887d` | #402 | — |

Production chạy `a8f7887d` (có mọi mốc trên), health `ok`, 24/24 module, 178 migration.

## Tính năng (đều cấu hình không deploy)

Tổ chức (SILO, mỗi tổ chức một CSDL) · module bật/tắt · field tuỳ biến + tệp · form / danh sách / trạng thái · luật
(trigger → điều kiện → cửa duyệt → hành động, đúng một lần, phục hồi lượt treo) · trang động + trình kéo-thả (KPI, bảng,
biểu đồ, kanban, form, dòng thời gian, bộ lọc, cột, nút) · đối tượng tuỳ biến + quan hệ · blueprint + 5 mẫu ngành + nâng
phiên bản 3 chiều · AI soạn blueprint (khoá AI của chính tổ chức) · sổ connector + kết nối theo tổ chức (bí mật mã hoá)
· `/start` tự phục vụ (TẮT trên production) · thương hiệu · gói + hạn mức · xuất / khôi phục cấu hình · chẩn đoán từng
tổ chức · màn duyệt lõi.

## Cổng mở bán — CHỦ ĐỘNG TẮT, bật khi chủ nền tảng quyết (`launch-gates.md`)

1. `PLATFORM_SECRETS_KEY` trên production: tạo secret GitHub (`openssl rand -base64 48`) rồi dispatch deploy — thiếu thì
   tổ chức khác không lưu được bí mật kết nối (VNX không ảnh hưởng). Sau khi đặt: checklist V1–V7 (`launch-gates.md` A.5).
   Quyết định kinh doanh còn treo cho pilot: G-ORDER (`pilot-readiness.md` mục 4–5). G-SCHED đã duyệt 29/09 (xem trên).
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
- AI Builder: một lượt dựng mới ~1,1 USD, một lượt sửa ~0,14 USD; trần theo gói ở sổ dùng AI (`ai-usage.md`).
- Kéo xa khi phải cuộn trong trình kéo-thả chưa đo trên màn hình thường.
- Cài blueprint vượt hạn mức đối tượng hỏng giữa chừng (kế hoạch chưa báo trước).
- Sao lưu tổ chức: từ quyết định C4/C6/C7 (29/09/2026) có bản mỗi giờ (RPO ≤ 1 giờ) và diễn tập tự động mỗi Chủ nhật (`backup-recovery.md` §9) — cả hai chưa chạy trên VPS vì chưa có tổ chức thật. CSDL NHÀ vẫn RPO ≤ 1 ngày cho tới khi bật PITR (§9.4, cần cửa sổ bảo trì).
- `/login`, `/start` và một số trang lõi ngoài danh sách H4 còn chữ gốc VNX (trạng thái tích hợp của nhà + gợi ý `.env` trên
  `/login` đã ẩn khi có tổ chức thứ hai).
- Nợ P0/P1/P2 của đợt pilot: `pilot-readiness.md` mục 4.
