# CURRENT CHECKPOINT — Chốt Đơn Tự Động Launch

> Ảnh chụp NGẮN của lúc này. Chi tiết từng việc: `docs/tech/MASTER_MISSION_REGISTRY.md`. Checkpoint của Integration Lead trên sổ
> `/tech`: `git show origin/ai-control/registry:CHECKPOINT.md` (khung của tệp này — đã kiểm lại từng dòng với Git / PR).
> **Git / PR / production THẮNG tệp này nếu lệch.** Readiness chỉ đọc từ `docs/saas/LAUNCH_GATE.md` và
> `docs/legal/LEGAL_LAUNCH_GATE.md` — không tự chấm cao hơn.
> Vòng đời: CODED → PR → CI → MERGED → DEPLOYED → PRODUCTION VERIFIED → DONE. **MERGED ≠ DONE.**

---

## SESSION START PROTOCOL — bắt buộc trước khi viết dòng mã đầu tiên

1. `git fetch origin` → cây riêng từ `origin/main` mới nhất (AGENTS §9); ghi SHA.
2. Đọc `docs/tech/MASTER_MISSION_REGISTRY.md`.
3. Đọc tệp này, rồi `git show origin/ai-control/registry:CHECKPOINT.md`.
4. Đọc PR đang mở (GitHub API `/pulls?state=open`) + `npm run ai -- board` + `git worktree list`.
5. Đọc production: `curl https://app.chotdontudong.com/api/health` (`commit`, `migrations`) + lượt «Deploy ERP to VPS» gần nhất.
6. Reconcile: lệch ⇒ sửa registry + checkpoint TRƯỚC; nhận đúng mission có sẵn, không tạo trùng, không làm lại việc `DONE`.
7. Rồi mới code.

## SESSION END PROTOCOL — trước khi phiên kết thúc / ngữ cảnh gần đầy / đổi model

1. Cập nhật khối mission đã chạm trong registry (STATUS · DONE · REMAINING · PRODUCTION_EVIDENCE · NEXT_ACTION · LAST_UPDATED).
2. Cập nhật tệp này (MAIN_SHA · PRODUCTION_SHA · ACTIVE_PRS · BLOCKED · NEXT_3_ACTIONS · bảng tốc độ).
3. Việc dở phải ở remote: push nhánh hoặc ảnh chụp `wip/<tên>` (AGENTS §9) — không để chỉ trên đĩa.
4. `npm run ai -- heartbeat | handoff | close` trong sổ `/tech`.
5. Viết handoff: đã làm · còn lại · lệnh kiểm · rủi ro. Phiên sau bắt đầu từ SESSION START, không từ trí nhớ chat.

---

## Checkpoint 2026-10-09 ~02:30 giờ VN (đo lúc 08/10 19:25Z)

**MAIN_SHA:** `6883bfbf` (#696). Từ lần chụp trước đã gộp: #682 · #683 · #690 · #694 · #695 · #696 · #697 · #698 · #699 · #700.

**PRODUCTION_SHA:** `1b057829` (#695, deploy 37822211552) — `/api/health` `commit 1b057829ce02`.
**Deploy 37829126099 (`6883bfbf`) ĐANG CHẠY** ⇒ #682 · #683 · #690 · #696 · #697 · #700 vẫn là **MERGED**, chưa DEPLOYED.

**LAUNCH_READINESS** (chép từ nguồn, không tự chấm):
- ENGINEERING: **NOT READY — 35 %** (14,5 / 41; 1 / 41 có bằng chứng production) — `LAUNCH_GATE.md` nhật ký 08/10 tối; chưa cập nhật sau lô này.
- LEGAL: **NOT READY — ~23 %** (2,5 / 11 P0, sau #697), **WAITING_FOR_LEGAL_COUNSEL** — `LEGAL_LAUNCH_GATE.md` §2 / §6.
- META: **⛔ NGOÀI**. COMMERCIAL READY: **NOT READY**.

### Bảng tốc độ (đếm từ GitHub API + sổ `/tech`, không ước — cửa sổ kết thúc 08/10 19:25Z)

**LAST 24H**

| Chỉ số | Số | Cách đếm |
|---|---|---|
| PR MERGED | **56** | `/pulls?state=closed` lọc `merged_at` trong 24 giờ: #644 → #700 (trừ #692) |
| PR DEPLOYED | **50** | trong 56 PR trên, commit gộp là tổ tiên của production `1b057829`; chưa lên: #683 #696 #697 #698 #699 #700 |
| Lượt deploy thành công | 22 (1 hỏng, 1 đang chạy) | workflow «Deploy ERP to VPS» |
| P0 CLOSED | **9** (5 mã: saas-l1-followup · saas-public-chat-limits · saas-shell-login-loop · saas-signup-subscription · saas-identity-email-login; 4 tài liệu: launch-gate · launch-gate-r2 · hồ sơ pháp lý #691 · #693) | mission P0 (ưu tiên theo registry) có sự kiện `DONE` trong sổ `/tech` trong cửa sổ, cộng mission đóng ở lượt làm mới này |
| P1 CLOSED | **29** | như trên, P1 (gồm MM-HSLC-01 · cutover-unpriced-tolerance · platform-key-project-probe · backup-drive-trash · master-mission-registry đóng ở lượt này) |
| PRODUCTION TESTS PASSED | **42** hậu kiểm `VERIFY_PASS` (sổ `/tech`) · 32 lượt ops production thành công (6 hỏng) | `events.ndjson` + workflow «Vận hành ERP trên VPS» |
| NEW BLOCKERS | **4** | MM-OPS-02 (Drive đầy — CSDL nhà FAILED) · MM-LEGAL-01 (cổng pháp lý mở: chờ luật sư) · legal-acceptance (chủ shop tạm dừng) · MM-REC-38 (dò project khoá UNAVAILABLE) |
| REGRESSIONS | **0** ghi nhận trên production | 1 `VERIFY_FAIL` (saas-c-shared-identity) là so nhầm SHA, không phải sự cố |

**TOTAL** (registry sau làm mới)

| Chỉ số | Số |
|---|---|
| MISSIONS TOTAL | **215** |
| DONE | **89** |
| P0 REMAINING | **16** |
| P1 REMAINING | **27** |
| ACTIVE (READY · IN_PROGRESS · PR_READY · IN_REVIEW · MERGED · DEPLOYED · VERIFYING) | **28** |
| BLOCKED_OWNER | **33** |
| BLOCKED_EXTERNAL | **6** |

**VELOCITY**

| Chỉ số | Số |
|---|---|
| DONE LAST 24H | **39** mission (sự kiện `DONE` của sổ `/tech`) · 56 PR gộp |
| DONE LAST 7D | **66** mission (sổ `/tech` chỉ có nhật ký từ 06/10 05:09Z — ít hơn 7 ngày) · **251** PR gộp trong 7 ngày |
| CURRENT BOTTLENECK | **Bằng chứng production**: 1 / 41 mục Launch Gate có vết PROD; 6 PR có mã đang chờ deploy; acceptance chưa chạy lần nào. Sau đó là chủ shop / bên ngoài (33 + 6 mission bị chặn) |

### WIP hiện tại (giới hạn 3 engineering + 1 audit)

| Loại | Việc | Trạng thái |
|---|---|---|
| ENGINEERING 1 | #692 `saas-ops-signals` | đang gộp — review PASS, cổng chạy (run 37829612046); đã sửa lộ `reason` / `orgCode` ở kết quả đăng nhập công khai |
| ENGINEERING 2 | Deploy lô `6883bfbf` | deploy 37829126099 đang chạy |
| ENGINEERING 3 | Production acceptance `saas-acceptance` | sắp chạy — ngay sau hậu kiểm deploy |
| AUDIT | MM-TECH-04 làm mới sổ | PR_READY (`docs/registry-refresh-0909`) |

### DONE (từ lần chụp trước)
- **HSLC chuyển khoá AI dùng chung** 09/10 02:04 VN: ops run 37829090945 (credit 300), dò sau chuyển OK (ops run 37829221110); trả
  trước 590 ₫ / khách AI từ ops run 37799525447 ⇒ MM-HSLC-01 DONE. #699 `cutover-unpriced-tolerance` DONE (script, đã chạy thật).
- #694 dò project khoá nền tảng: DONE (script) — kết quả **UNAVAILABLE** (Google không trả ErrorInfo) ⇒ MM-REC-38 cho chủ shop.
- #698 sổ tổng (tài liệu) DONE. #689 sao lưu: lượt 23:04 VN dọn 109 MB thùng rác, 7 CSDL tổ chức đẩy OK ⇒ backup-drive-trash DONE.

### MERGED / DEPLOYED chưa hậu kiểm
- MERGED (chờ deploy 37829126099): #682 · #683 · #690 · #696 · #697 · #700.
- DEPLOYED chưa hậu kiểm: #695 Meta CAPI (`1b057829`) · #686 · #685 · #688.

### ACTIVE_PRS
| PR | Nội dung | Trạng thái |
|---|---|---|
| #692 | Tín hiệu sự cố người vận hành O1–O8 (migration 0237) | Review PASS; cổng đang chạy ở `a9aad1fb` |
| #631 | Worker `/tech` một nút | CRITICAL — chủ shop gộp |

Nhánh đã đẩy KHÔNG có PR (lô Fable, chưa handoff): `claude/platform-viec-hang-ngay-len-dau` · `claude/erp-a11y-bo-cuc` ·
`claude/error-boundary-than-thien` · `claude/trang-chu-su-that-thuong-mai` · `claude/saas-finish-line-r2` · `claude/commercial-sweep`
(PR_READY). Chi tiết + việc chỉ ở cục bộ: registry §15.

### BLOCKED
- **Sao lưu CSDL NHÀ** ra Drive FAILED (Drive đầy ~9,9 GB tệp riêng) — BLOCKED_OWNER (MM-OPS-02). Bản VPS + PITR vẫn tốt.
- **legal-acceptance (L2)** tạm dừng — `wip/legal-acceptance` @ `43c19ff9`; cây còn thay đổi chưa commit. Pháp lý WAITING_FOR_LEGAL_COUNSEL.
- **Meta App Review / quyền Page** — EXTERNAL.
- **Số project của khoá AI nền tảng** — dò tự động UNAVAILABLE; chủ shop tự xem.

### OWNER_DECISIONS (đang chặn việc)
1. Sao lưu CSDL nhà: dọn Drive · Google One · tài khoản Google riêng · giảm hạn giữ.
2. `PLATFORM_SIGNUP_MODE=open` — đóng (chỉ mời) tới READY? (khuyến nghị: đóng) — ảnh hưởng CTA trang chủ (PR A).
3. Xoá cửa hàng `qa`? (khuyến nghị: xoá; giữ `hs-thien-nga-test` khi còn giữ Page thử Meta).
4. Quy tắc cho phép giao dịch tiền thật qua ops (`/permissions`) hay chủ shop tự bấm.
5. V6: xác nhận bản sao khoá bí mật nền tảng đã cất ngoài VPS.
6. Dùng thử 7 ngày (mã) hay 14 (README).
7. Meta App Dashboard + App Review; luật sư (G-1…G-11); kế toán (HĐĐT); câu chữ công bố AI; DPA.
8. OVERAGE Q1–Q10 + chuyển 8 tổ chức legacy → V1; IDENTITY §7; Order Candidate §11; gộp #631. (Đầy đủ: registry §14.)

### NEXT_3_ACTIONS
1. **Hậu kiểm deploy 37829126099** (`/api/health` commit `6883bfbf`, smoke) → chuyển #682 #683 #690 #696 #697 #700 sang DEPLOYED; gộp **#692** khi cổng xanh rồi deploy một lượt nữa.
2. **`saas-acceptance`** chạy thử → `--apply` → chủ shop chuẩn bị UI một lần (`ACCEPTANCE.md` §3) → `--apply --e2e` → cập nhật `LAUNCH_GATE.md` bằng bằng chứng production; mission MERGED → DONE theo vết.
3. **Thu gom việc treo**: phiên Fable handoff 6 nhánh (registry §15.A) để mở PR theo lô; đưa `COUNSEL_PACK.md` vào kho (MM-REC-23); giao MM-FU-697a (MEDIUM) và MM-FU-692b (một nguồn sức khoẻ).

---

## Lệch nguồn (đã ghi nhận — Git / PR / production thắng)

Dòng 1–15: lượt dựng 09/10 01:00 (nay phần lớn đã được Git giải quyết — giữ làm vết). Dòng 16–18: lượt làm mới 02:30.

| # | Lệch | Kết luận theo sự thật |
|---|---|---|
| 1 | CHECKPOINT `/tech` ghi `fix/saas-acceptance-hardening` là IN_PROGRESS | Nhánh KHÔNG có ở remote lẫn cục bộ ⇒ ghi `READY` (MM-ACC-01) |
| 2 | Sổ `/tech` ghi `saas-acceptance-smoke`, `saas-create-customer-correct`, `launch-gate-r2`, `saas-shell-gate-redirects`, `backup-drive-trash` là `INTEGRATING` | Đều đã gộp; #682 · #690 chưa deploy (MERGED), #686 · #687 · #689 đã ở production `4dbd864a` |
| 3 | Sổ `/tech` ghi `platform-key-project-probe` PR_READY | #694 đã gộp `a582a5ad` lúc dựng sổ |
| 4 | Sổ `/tech` ghi `saas-e2e-customer` BACKLOG P0 | Thay bằng `saas-acceptance-smoke` (#690) + MM-ACC-01; phần tiếp quản / hạn mức / Meta chưa có trong ops |
| 5 | Sổ `/tech` ghi `org-ai-platform-cutover` DONE | Đúng cho CÔNG CỤ; lượt `--apply` cho HSLC vẫn BLOCKED (MM-HSLC-01) |
| 6 | `LAUNCH_GATE.md` §7 xếp #683 là LAUNCH SUPPORT | A7 · A8 · A10 = 3 / 10 mục Admin; thiếu chúng Admin tối đa 70 % < ngưỡng 90 % ⇒ registry xếp P0 |
| 7 | `docs/saas/OVERAGE.md` Q1 + `docs/revenue-os/MASTER_MISSION_STATUS.md` ghi «chưa khai tài khoản nhận tiền», ghi nhớ 08/10 sáng cũng vậy | CHECKPOINT 09/10 + ops run 37799525447: ĐÃ khai (08/10 tối); hai tài liệu kia cũ |
| 8 | `MASTER_MISSION_STATUS.md` liệt V6 (bản sao khoá ngoài VPS) là quyết định chủ shop còn mở | `docs/platform/current-execution-state.md` + `pilot-readiness.md` §5: chủ nền tảng ĐÃ tự cất bản phục hồi (30/09). Cần chủ shop xác nhận một lần |
| 9 | `current-execution-state.md` có đoạn «G-SCHED … CHƯA gộp» | Cùng tệp ghi G-SCHED #405 đã lên production 30/09 — đoạn kia cũ |
| 10 | Số ngày dùng thử: mã 7 · README / tài liệu cũ 14 · trang chủ 7 | LEGAL P1-2 (M-TRIAL-CONSISTENCY) — sửa tài liệu theo mã |
| 11 | Ghi nhớ: «Platform đóng 01/10» vs «mở lại 02/10 (Vertical SaaS Factory)» vs «tạm dừng vertical 04/10» | Theo thứ tự thời gian: vertical TẠM DỪNG; Launch Gate đóng băng phạm vi ⇒ DEFERRED |
| 12 | Bảng giá: `docs/platform/pricing.md` (Cơ bản 249k…, credit USD) vs V1 (`docs/saas/PRICING_V1.md`, đồng hồ khách AI) | V1 là bản sau (#627); `pricing.md` cũ — nên ghi chú «đã thay» |
| 13 | Ghi nhớ «VTP không cấp API, chỉ webhook» (24/09) vs #545 tạo vận đơn VTP qua API (04/10) | Không kiểm được trong lượt này; cần vận đơn thật đầu tiên (MM-REC-25) để kết luận |
| 14 | Ghi nhớ 05/10 «bot im lặng, bỏ mọi câu báo máy» vs pháp lý cần một dòng «Trợ lý AI» đầu hội thoại | Chờ chủ shop duyệt câu chữ (MM-LEGAL-03); LEGAL §4 đã khai ngoại lệ |
| 15 | Ghi nhớ mâu thuẫn về auto-merge khi mở PR và về khoá giải kết quả `db-query` | Quy trình, không phải mission — phiên sau kiểm lại trước khi dựa vào |
| 16 | Sổ `/tech` vẫn ghi `INTEGRATING` cho #683 #690 #694 #696 #697 #698 #699 #700, `PR_READY` cho saas-ops-signals, `RUNNING` cho 5 mission lô Fable | Theo Git: đã gộp (MERGED / DONE như registry); lô Fable đã đẩy nhánh nhưng chưa handoff |
| 17 | CHECKPOINT `/tech` và lệnh điều phối ghi lượt sao lưu «09/10 23:04» | Lúc đo là 09/10 02:25 VN ⇒ mốc đó chưa tới; hiểu là 08/10 23:04 VN. Ghi «lượt 23:04 gần nhất» |
| 18 | `LEGAL_LAUNCH_GATE.md` §2 nay 2,5 / 11 (~23 %) sau #697; lần chụp trước 18 % | Lấy 23 % |
