# CHECKPOINT — ChotDonTuDong Launch (Integration Lead)

> Mọi phiên (Claude / Fable / worker) ĐỌC TỆP NÀY TRƯỚC khi làm. Tệp sống trên nhánh `ai-control/registry` cạnh sổ sứ mệnh.
> Đọc nhanh: `git fetch origin +refs/heads/ai-control/registry:refs/remotes/origin/ai-control/registry && git show origin/ai-control/registry:CHECKPOINT.md`.
> Git / PR / production THẮNG mọi thứ ghi ở đây nếu lệch — kiểm `origin/main`, PR mở, `https://app.chotdontudong.com/api/health` (`commit`).
> Nguồn sự thật readiness: `docs/saas/LAUNCH_GATE.md` trên main. Readiness chỉ tăng bằng BẰNG CHỨNG PRODUCTION, không bằng mã.

## Checkpoint 2026-10-09 ~01:00 VN (Integration Lead)

- **MISSION:** CHOTDONTUDONG LAUNCH SPRINT — khách trả tiền đầu tiên.
- **STATE:** NOT READY. Readiness 35 % (14,5/41, Launch Gate r2 · 1/41 có bằng chứng production).
- **MAIN_SHA:** `5ce11027` (gộp #690).
- **PRODUCTION_SHA:** `4dbd864a` (có #680 #681 #684 #685 #686 #687 #688 #689; CHƯA có #682 #690).

### ACTIVE_PRS
| PR | Nội dung | Trạng thái |
|---|---|---|
| #692 | Tín hiệu sự cố cho người vận hành (O1–O8) | Review PASS + 2 MEDIUM; CI đỏ ở `tests/ops-signals.test.ts:344` (bài không cô lập trong runner chung); worker đang sửa bài + MEDIUM (báo nhân viên khi ghi đơn hỏng, phân biệt lỗi trước / sau ghi đơn) + hoà với #690 ở `lib/actions/auth.ts` |
| #683 | Sức khoẻ khách cho admin | Review vòng 2 PASS; xung đột với main sau #682; worker đang rebase + sửa F1 (chatOk7d) |
| #694 | Mã lý do org-ai-cutover + dò số project khoá nền tảng (chỉ script) | PASS; chờ cổng rồi gộp; sau gộp chạy `org-ai-cutover hslc-hmt-shop` (chỉ đọc) — KHÔNG cần deploy |
| #631 | Worker /tech một nút | CRITICAL — chủ shop gộp; giữ migration 0236 (va số với #692 — ai sau renumber) |
| #691/#693 | Pháp lý | ĐÃ gộp (phiên khác) |
| #695 | Meta CAPI (phiên khác) | CI đỏ — không thuộc lô launch |

### DONE (đã production)
#680 Finish Line R1 · #681 P0 đăng nhập email (+ identity-reconcile ghi bù 12 chỉ mục, THIẾU 0) · #684 · #686 vỏ không trắng trang ·
#687 Launch Gate r2 · #689 sao lưu Drive (thùng rác) · HSLC: tài khoản nhận tiền ĐÃ khai, cờ Số dư AI BẬT, số dư DƯƠNG, ĐÃ KÍCH HOẠT
trả trước 590 ₫/khách AI (run 37799525447).
Đã gộp chưa deploy: #682 tạo khách đúng mặc định (P0-C) · #690 ops `saas-acceptance`.

### IN_PROGRESS
- `fix/saas-acceptance-hardening` (từ #690): MEDIUM-1 chặn chiếm mã `cdt-nghiem-thu` + MEDIUM-2 loại workspace thử khỏi buồng lái + L1–L4.
  **BẮT BUỘC gộp + deploy trước lượt `saas-acceptance --apply` đầu tiên.**
- `fix/saas-shell-polish`: P1 /login hiện VNX sau đặt mật khẩu trên host Chốt Đơn · chữ kỹ thuật ở vỏ · /module-disabled error · BILLING_LOCKED · trang Nhân viên.
- `feat/legal-registers` (L1): sổ văn bản · bên xử lý phụ · chuyển xuyên biên giới (UNKNOWN khi chưa xác minh) · khung lưu trữ (null = chưa quyết) · sổ AI · cổng pháp lý 5 trạng thái.
- Phiên Fable Finish Line: nhánh `claude/saas-finish-line-r2` (5 tệp câu chữ) chờ handoff; Commercial sweep docs `claude/commercial-sweep`; PR C (error boundary rò `DATABASE_URL`) + PR A (claim trang chủ) được phép làm.

### BLOCKED
- HSLC chuyển sang khoá AI dùng chung: `org-ai-cutover --apply` từ chối với credit 150 / 300 — chờ mã lý do của #694 (nghi `COST_HARD_BELOW_NEED`: trần costUsdHard của gói thấp ⇒ nâng ở /platform/org/hslc-hmt-shop). Trong lúc chờ HSLC trả 590 ₫/khách AI VÀ tự trả token khoá riêng.
- Legal L2 (sổ chấp thuận) TẠM DỪNG theo lệnh chủ shop (WAITING_FOR_LEGAL_COUNSEL); ảnh chụp ở `wip/legal-acceptance`.
- Meta App Review (EXTERNAL).

### OWNER_DECISIONS (thật sự của chủ shop)
1. Sao lưu ngoài máy: CSDL nhà 180 MB không lên Drive (Drive 15 GB, ~9,9 GB tệp riêng của chủ shop). Chọn: dọn Drive · Google One · tài khoản Google riêng · cho giảm hạn giữ (giờ 48→24, tay 3→1).
2. `PLATFORM_SIGNUP_MODE=open` — đóng (chỉ mời) tới khi READY? (khuyến nghị: đóng).
3. Cửa hàng `qa` — xoá theo quyết định 08/10 (khuyến nghị); giữ `hs-thien-nga-test` khi còn giữ Page thử Meta.
4. Bộ phân loại quyền chặn giao dịch tiền thật qua ops (bật Số dư AI, kích hoạt / chuyển khoá): lần sau cần thì chủ shop bấm, hoặc thêm quy tắc cho phép qua `/permissions`.

### NEXT_ACTIONS
1. Gộp #692 khi xanh (sau bản sửa) → reconcile #683 → gộp.
2. Gộp `fix/saas-acceptance-hardening` → MỘT deploy (main) → `saas-acceptance --apply` → chuẩn bị UI một lần (ACCEPTANCE.md §3) → `--apply --e2e`.
3. Sau deploy: giao Round 2 Production Acceptance + Commercial Perfection Sweep cho PHIÊN FABLE HIỆN CÓ (không tạo phiên mới); cập nhật LAUNCH_GATE bằng bằng chứng production.
