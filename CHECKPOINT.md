# CHECKPOINT — ChotDonTuDong Launch (Integration Lead)

> Mọi phiên (Claude / Fable / worker) ĐỌC TỆP NÀY TRƯỚC khi làm. Tệp sống trên nhánh `ai-control/registry` cạnh sổ sứ mệnh.
> Đọc nhanh: `git fetch origin +refs/heads/ai-control/registry:refs/remotes/origin/ai-control/registry && git show origin/ai-control/registry:CHECKPOINT.md`.
> Git / PR / production THẮNG mọi thứ ghi ở đây nếu lệch — kiểm `origin/main`, PR mở, `https://app.chotdontudong.com/api/health` (`commit`).
> Nguồn sự thật readiness: `docs/saas/LAUNCH_GATE.md` trên main. Readiness chỉ tăng bằng BẰNG CHỨNG PRODUCTION, không bằng mã.


## Checkpoint 2026-10-13 ~10:00 VN (Integration Lead · phiên Max) — ĐỌC PHẦN NÀY TRƯỚC

**PRODUCTION_SHA:** `935ffdb2` (#821) · **MAIN:** kiểm `git log origin/main -5` (đang gộp #823, #804). Deploy «đỏ» hiện nay là CỐ Ý:
`verify-migrations` báo tổ chức `qa` DEGRADED_MIGRATION/TIMEOUT (0245 quá trần ở qa) — đọc log bước SSH: smoke phải «134/134 đạt · ✓ Không có lỗi thật».

### TASKS (mã sứ mệnh trong sổ · owner hiện tại = phiên đang cầm khoá `integration-lead`)
| Mã | Ưu tiên | Nhánh | PR | Trạng thái | Còn dở / bước kế |
|---|---|---|---|---|---|
| hslc-postsale-handoff | P0 | fix/hslc-postsale-handoff | #821 | ĐÃ DEPLOY 935ffdb2 | AI im 751→149, KHÔNG CHỦ 127→0. Còn: release 40 hội thoại POST_ORDER cũ — chờ PR `postorder-release-batch` (--limit, --rollback) rồi chạy lô 10, chủ shop đã duyệt có điều kiện |
| postorder-release-batch | P0 | fix/postorder-release-batch | (sắp mở) | worker đang làm | merge (không cần deploy app nếu chỉ script) → chạy thử → `--apply --limit=10` từng lô, ghi run id để rollback |
| inbox-list-perf | P0 | fix/inbox-list-perf (+ fix/inbox-perf-probe-topn) | (sắp mở) | worker đang làm | ĐO production 13/10: listInbox p50 13,4 s · p95 21–29 s (31 câu, SQL 18 s); loadInboxThread p50 155 ms. Root cause: đổi `?c=` dựng lại trang ⇒ chạy lại listInbox. Gộp nhánh đo trước, đo top-N câu chậm, rồi gộp bản sửa, đo lại `inbox-perf-probe --org=hslc-hmt-shop --samples=10` |
| cart-intent-audit-sync | P1 | fix/cart-audit-rules-sync | #823 | gates/merge (thay #822 đã đóng) | merge, không cần deploy |
| customer-360 | P1 | fix/customer-360 | #804 | PASS review @83dd92b2 | merge + deploy SAU #823; kiểm `customer-360-probe` |
| sticky-cart-intent | P0 | — | #819 | ĐÃ DEPLOY e6b97961 | đo AFTER: `cart-intent-audit "hslc-hmt-shop --since=2026-10-12T21:41:00Z"` (TRƯỚC: drift 13/368 · loop 22/215) |
| org-migrate-isolation | P0 | — | #815 | ĐÃ DEPLOY | qa phục vụ lược đồ cũ, thử lại 0245 mỗi 6 giờ |
| migration-rehearsal | P1 | fix/migration-rehearsal | #814 (nháp) | PASS review | gộp → ops `migration-rehearsal "qa --compare-jit --candidate-index --budget=300"` (≤100 phút, giữ khoá đọc nặng — KHÔNG chạy cùng deploy) → chủ shop chọn cách sửa 0245 cho qa |
| inbox-unread-perf | P0 | — | #792 | ĐÃ DEPLOY | HSLC FALSE_UNREAD 1.812/2.278 → 0/481. Chưa DONE tới khi qa áp 0245 |

### QUYẾT ĐỊNH KỸ THUẬT (đừng phân tích lại)
- «Chưa đọc» = lượt khách mới nhất CHƯA XỬ LÝ — một định nghĩa (#803 `response-ownership-ledger.ts`), lưu sẵn 0245 (`turn_unhandled`), công tắc lùi `inbox.unread.materialized`.
- Migration tổ chức hỏng vì HẾT GIỜ ⇒ phục vụ lược đồ cũ CHỈ khi mọi migration thiếu nằm trong `lib/constants/migration-serve-compat.ts` (#815).
- Không index ngoài migration; 0245 không sửa (cần chủ shop duyệt ngoại lệ nếu rehearsal xác nhận cần index trước backfill).
- Script ops: hàm lib dùng `getDb()` phải chạy trong `withOrganization` sau khi gắn handle chỉ đọc (bài học #813); xả stdout trước `process.exit`.
- PR rủi ro HIGH đi riêng; đổi nhánh sau bàn giao ⇒ `handoff` lại rồi `review` lại đúng SHA; hai sứ mệnh KHÔNG dùng chung một tên nhánh.
- Build gates cần heap 6 GB (#816). Ổ C máy dev hay đầy: dọn `data/pglite-test-*` và `.next` cây đã gộp.

### OWNER_DECISIONS đang chờ
1. Xếp người vào phòng «Kinh doanh & CSKH» HSLC (143 hội thoại hàng đợi chung, cả tổ chức 1 người xem hộp thư). 2. Dọn Google Drive (sao lưu ngoài máy hỏng từ 03/10).
3. Cách sửa 0245 cho qa (sau rehearsal). 4. D11 worker /tech (#631 đã đóng, `tech-worker-onboarding-v2` BLOCKED).

### BÀN GIAO MAX ↔ TEAM (một người ghi tại một thời điểm)
- Khoá duy nhất cho gộp/deploy: lease `integration-lead` (`npm run ai -- lease status|acquire|renew|release`). Phiên bàn giao phải
  `lease release integration-lead --token=…` TRƯỚC; phiên nhận `lease acquire integration-lead` rồi mới gộp/deploy. Không bao giờ hai phiên cùng cầm.
- Phiên bàn giao: (1) dừng vòng gia hạn khoá + các vòng nền gộp/deploy; (2) không để cây nào bẩn: worker commit + push hoặc
  chụp ảnh wip (AGENTS §9); (3) ghi checkpoint này (bảng TASKS + bước kế); (4) release lease.
- Phiên nhận: đọc tệp này → `git fetch` → `npm run ai -- queue` + `gh`/API PR mở → `/api/health` commit → tiếp đúng «bước kế». Không tạo
  sứ mệnh mới cho việc đã có trong bảng. Dùng cây làm việc riêng (`git worktree add`), không ghi vào cây của phiên kia.
- Không chép token / credential giữa hai tài khoản. Mỗi tài khoản đăng nhập riêng (CLAUDE_CONFIG_DIR riêng).

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
