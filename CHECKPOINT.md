# CHECKPOINT — ChotDonTuDong Launch (Integration Lead)

> Mọi phiên (Claude / Fable / worker) ĐỌC TỆP NÀY TRƯỚC khi làm. Tệp sống trên nhánh `ai-control/registry` cạnh sổ sứ mệnh.
> Đọc nhanh: `git fetch origin +refs/heads/ai-control/registry:refs/remotes/origin/ai-control/registry && git show origin/ai-control/registry:CHECKPOINT.md`.
> Git / PR / production THẮNG mọi thứ ghi ở đây nếu lệch — kiểm `origin/main`, PR mở, `https://app.chotdontudong.com/api/health` (`commit`).
> Nguồn sự thật readiness: `docs/saas/LAUNCH_GATE.md` trên main. Readiness chỉ tăng bằng BẰNG CHỨNG PRODUCTION, không bằng mã.

## Checkpoint 2026-10-09 ~04:30 VN (Integration Lead)

- **MISSION:** CHOTDONTUDONG LAUNCH SPRINT. Sổ tổng: `docs/tech/MASTER_MISSION_REGISTRY.md` + `docs/tech/CURRENT_CHECKPOINT.md`.
- **STATE:** NOT READY · readiness **60 %** (24,5/41; **9/41** có vết production) — PR #707 `launch-gate-r3`.
- **MAIN_SHA:** `9833d981` (+ #705 #707 đang gộp). **PRODUCTION_SHA:** `c71833950519` (deploy 37838226087 xanh, verify ĐẠT).
- **ACCEPTANCE:** `saas-acceptance --apply` PASS 4/4 (run 37838073371) — A tạo khách · B1 kích hoạt + đăng nhập email · C vỏ · B2.
  D/E (`--e2e`) chờ chủ shop chuẩn bị UI một lần (`docs/saas/ACCEPTANCE.md` §3).
- **ĐÃ ĐÓNG DONE** (verify c7183395): 16 mission — xem `CURRENT_CHECKPOINT.md`.

### ACTIVE
#705 màn lỗi thân thiện (PASS, đang gộp) · #707 Launch Gate r3 (PASS, đang gộp) → MỘT lượt deploy (kèm #701 HSLC) → verify.
#706 trang chủ: review FAIL (hứa «Kết nối Facebook» thẳng khi meta-messenger-access BLOCKED_EXTERNAL) — phiên Fable code-erp-71 sửa.
Fable Round 2 (R2 · G · F) RUNNING ở code-erp-71. #631 chủ shop gộp.

### BLOCKED
Meta App Review (EXTERNAL) · legal-acceptance L2 tạm dừng (WAITING_FOR_LEGAL_COUNSEL) · sao lưu CSDL nhà (Drive đầy tệp riêng).

### OWNER_DECISIONS
1. Chuẩn bị UI cho E2E (ACCEPTANCE.md §3). 2. Sao lưu CSDL nhà. 3. PLATFORM_SIGNUP_MODE=open? 4. Xoá `qa`? 5. Quy tắc tiền thật qua ops.
6. V6 bản sao khoá. 7. Dùng thử 7/14 ngày.

### NEXT_ACTIONS
1. Deploy lô #701 #705 #707 → verify → close. 2. Owner UI prep → `--apply --e2e` → C8–C17 ✅. 3. Kiểm O1–O8 trên production; chép 16 DONE vào registry.

## Checkpoint 2026-10-09 ~03:30 VN (Integration Lead)

- **MISSION:** CHOTDONTUDONG LAUNCH SPRINT. Sổ tổng: `docs/tech/MASTER_MISSION_REGISTRY.md` + `docs/tech/CURRENT_CHECKPOINT.md` (#698, trên main) — 202 mission.
- **STATE:** NOT READY · readiness 35 % (Launch Gate; 1/41 có bằng chứng production).
- **MAIN_SHA:** đang nhích (≥ 94bb5b0c: #682 #683 #690 #694 #695 #698 đã gộp).
- **PRODUCTION_SHA:** `4dbd864a` — lượt deploy MỘT LẦN cho lô đang được dispatch sau khi #692 #700 #696 gộp.

### ACTIVE_PRS (đều PASS review)
#697 sổ pháp lý L1 · #699 cutover bỏ phần nhỏ token chưa có giá (script-only; sau gộp chạy lại `org-ai-cutover hslc-hmt-shop --apply --credit=150`) ·
#692 tín hiệu sự cố (0237) · #700 làm gọn vỏ (thương hiệu sau redirect) · #696 cứng hoá nghiệm thu (bắt buộc trước acceptance --apply) · #631 (chủ shop).

### BLOCKED
- HSLC chuyển khoá dùng chung: mã lý do thật `BASIS_UNMEASURED` (model chưa có giá trong hỗn hợp 30 ngày) ⇒ gỡ bằng #699.
  HSLC đã kích hoạt trả trước 590 ₫/khách AI; tới khi chuyển xong, HSLC vẫn tự trả token khoá riêng.
- Phép dò số project khoá nền tảng: UNAVAILABLE (Google không trả ErrorInfo) ⇒ chủ shop xem ở aistudio.google.com/apikey.
- legal-acceptance (L2) TẠM DỪNG — `wip/legal-acceptance` 43c19ff9; pháp lý WAITING_FOR_LEGAL_COUNSEL.
- Meta App Review (EXTERNAL).

### OWNER_DECISIONS
1. Sao lưu CSDL nhà lên Drive (Drive 15 GB đầy ~9,9 GB tệp riêng; 7 CSDL tổ chức đã đẩy OK 09/10 23:04).
2. PLATFORM_SIGNUP_MODE=open — đóng tới READY? 3. Xoá cửa hàng `qa`? 4. Quy tắc cho phép giao dịch tiền thật qua ops (`/permissions`).
5. V6 bản sao khoá bí mật nền tảng đã cất? 6. Dùng thử 7 ngày (mã) hay 14 (README)?

### NEXT_ACTIONS
1. Deploy một lượt (lô #682 #683 #690 #692 #696 #700 …) → tóm tắt thay đổi cho chủ shop → verify + close sứ mệnh.
2. `saas-acceptance` (chỉ đọc) → `--apply` → chủ shop chuẩn bị UI một lần (ACCEPTANCE.md §3) → `--apply --e2e` → cập nhật LAUNCH_GATE bằng bằng chứng production.
3. Gộp #699 → chuyển khoá HSLC. Giao Round 2 + Commercial Sweep cho phiên Fable HIỆN CÓ (không tạo mới).
