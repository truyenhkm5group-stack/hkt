# MASTER MISSION REGISTRY — Chốt Đơn Tự Động / ERP

> **Nguồn sự thật DUY NHẤT về «việc gì từng được giao, đang ở đâu, còn gì».** Không dựa vào trí nhớ chat.
> **Đối chiếu lại 09/10/2026 ~13:00 giờ VN (06:00Z, nhánh `docs/registry-reconcile-0910` từ `origin/main` `50293da6`)** theo số đo
> của Integration Lead (deploy · ops · verify `/tech`), `git log origin/main`, `/api/health` và bàn giao Round 2 của phiên Fable sweep.
> Làm mới 09/10/2026 ~02:30 giờ VN (08/10 19:25Z, nhánh `docs/registry-refresh-0909`, #702) theo lệnh EXECUTION COMMANDER.
> Dựng lần đầu 09/10/2026 ~01:00 giờ VN (#698) từ: sổ `/tech` (`origin/ai-control/registry`, 96 tệp `mission.*.json` + `CHECKPOINT.md`),
> GitHub (PR mở / đã gộp #560–#695, nhánh, lượt CI / deploy), `https://app.chotdontudong.com/api/health`, tài liệu trên `main`
> (`docs/saas/*`, `docs/legal/*`, `docs/revenue-os/*`, `docs/product-excellence/*`, `docs/platform/*`, `docs/productization/*`,
> `docs/meta-app-review/*`), nhánh `claude/commercial-sweep` (`docs/product/COMMERCIAL_POLISH_BOARD.md`), danh sách cây làm việc
> và ghi nhớ của các phiên (chỉ làm bằng chứng phụ).
> **Khi lệch nhau: Git / PR / production THẮNG tệp này.** Phiên nào thấy lệch thì sửa tệp này, không sửa thực tế cho khớp tệp.
> Trạng thái readiness KHÔNG chấm ở đây — đọc `docs/saas/LAUNCH_GATE.md` (kỹ thuật) và `docs/legal/LEGAL_LAUNCH_GATE.md` (pháp lý).
> Đi kèm: `docs/tech/CURRENT_CHECKPOINT.md` (ảnh chụp ngắn của lúc này).

---

## SESSION START PROTOCOL — bắt buộc trước khi viết dòng mã đầu tiên

1. `git fetch origin` → làm việc trên cây riêng tạo từ `origin/main` MỚI NHẤT (AGENTS §9); ghi lại SHA của `origin/main`.
2. Đọc tệp này (`docs/tech/MASTER_MISSION_REGISTRY.md` trên `origin/main`, hoặc nhánh mới hơn nếu PR registry đang mở).
3. Đọc `docs/tech/CURRENT_CHECKPOINT.md`, rồi sổ `/tech`:
   `git fetch origin +refs/heads/ai-control/registry:refs/remotes/origin/ai-control/registry && git show origin/ai-control/registry:CHECKPOINT.md`.
4. Đọc PR đang mở (GitHub API `/pulls?state=open`) và nhánh đang có người cầm (`npm run ai -- board`, `git worktree list`).
5. Đọc trạng thái production: `curl https://app.chotdontudong.com/api/health` (trường `commit`, `migrations`) và lượt
   «Deploy ERP to VPS» gần nhất.
6. **Reconcile**: mỗi lệch giữa (1)–(5) và tệp này ⇒ sửa tệp này TRƯỚC (một dòng, kèm bằng chứng). Việc mình định làm đã có
   mission ⇒ nhận đúng mission đó (`npm run ai -- claim`), KHÔNG tạo mission mới. Việc đã `DONE` ⇒ không làm lại.
7. Chỉ sau đó mới code.

## SESSION END PROTOCOL — bắt buộc trước khi phiên kết thúc, khi ngữ cảnh gần đầy, hoặc trước khi đổi model

1. Cập nhật khối mission mình đã chạm trong tệp này: `STATUS`, `DONE`, `REMAINING`, `PRODUCTION_EVIDENCE` (chỉ vết thật: run
   deploy / ops / smoke), `NEXT_ACTION`, `LAST_UPDATED`.
2. Cập nhật `docs/tech/CURRENT_CHECKPOINT.md` (MAIN_SHA, PRODUCTION_SHA, ACTIVE_PRS, NEXT_3_ACTIONS).
3. Việc dở KHÔNG được chỉ nằm trên đĩa: commit + `git push` nhánh, hoặc ảnh chụp `wip/<tên>` theo AGENTS §9; ghi tên nhánh
   vào khối mission.
4. `npm run ai -- heartbeat` / `handoff` / `close` cho mission trong sổ `/tech`.
5. Viết handoff (trong mô tả PR hoặc trong khối mission): đã làm gì · còn gì · lệnh kiểm · rủi ro.
6. Đổi model / mở phiên mới: phiên sau bắt đầu lại từ SESSION START PROTOCOL, không từ trí nhớ chat.

---

## 0. Quy ước

**Vòng đời chuẩn:** CODED → PR → CI → `MERGED` → `DEPLOYED` → PRODUCTION VERIFIED (`VERIFYING` khi đang kiểm) → `DONE`.
**`MERGED` ≠ `DONE`.** Ngoại lệ duy nhất: PR CHỈ tài liệu / CHỈ script ops (không có mã chạy trong ứng dụng) là `DONE` khi đã gộp
và (với script) đã chạy thật một lượt có vết.

**STATUS** (chỉ dùng các giá trị này): `BACKLOG` · `READY` · `IN_PROGRESS` · `PR_READY` · `IN_REVIEW` · `MERGED` · `DEPLOYED` ·
`VERIFYING` · `BLOCKED_EXTERNAL` · `BLOCKED_OWNER` · `DEFERRED` · `CODE_DONE_UI_NOT_VERIFIED` · `PARTIAL_IMPLEMENTATION` · `DONE`.
**Từ 10/10/2026 (chủ shop):** việc hướng tới khách / admin chỉ `DONE` khi đã MỞ TRANG THẬT trên production và có ảnh TRƯỚC / SAU cùng
trang, cùng khổ màn hình (`docs/product/VISIBLE_PRODUCT_FINISH_BOARD.md`). Mã xong + gộp + deploy mà chưa có ảnh ⇒ `CODE_DONE_UI_NOT_VERIFIED`;
yêu cầu của chủ shop mới làm một phần ⇒ `PARTIAL_IMPLEMENTATION`. Việc không nhìn thấy được (ops, pháp lý, tài liệu, logic nền) vẫn đóng bằng
vết production (run ops). «Đã kiểm kê 207/207 trang» KHÔNG phải bằng chứng hoàn tất.
`DONE` = đã gộp + đã lên production + hậu kiểm có vết. `DEPLOYED` = đã lên production, chưa có hậu kiểm riêng. `MERGED` = trong
`main`, chưa lên production (hoặc chỉ tài liệu).

**PRIORITY**: `P0` LAUNCH BLOCKER · `P1` COMMERCIAL READINESS · `P2` PRODUCT ADVANTAGE · `P3` POST-LAUNCH.
Ưu tiên ở đây là thang MỚI; sổ `/tech` dùng P0–P2 theo nghĩa cũ — khi khác nhau, cột này ghi theo `LAUNCH_GATE.md` §7.

**CLASS** (phân loại việc cũ): `DONE` · `STILL REQUIRED` · `SUPERSEDED` (ghi thay bằng gì) · `DEFERRED` (lý do + điều kiện mở
lại) · `DUPLICATE` · `NO LONGER NEEDED`.

**MISSION_ID**: id sứ mệnh `/tech` khi có; việc chưa có id dùng `MM-<NHÓM>-<số>`.
**OWNER** = ai quyết / ai chịu trách nhiệm giao; **AGENT** = cây / phiên đang cầm (theo sổ `/tech` hoặc `git worktree list`).
Bằng chứng deploy dạng `run <id>` là lượt GitHub Actions «Deploy ERP to VPS» của kho `truyenhkm5group-stack/hkt`.

Việc `SUPERSEDED` / `DUPLICATE` / `NO LONGER NEEDED` được ĐÓNG với `STATUS = DONE`; cột CLASS ghi lý do và việc thay thế.
Mission đã `DONE` được gom vào bảng gọn của từng nhóm (trường không ghi = «—»); mission CHƯA xong viết thành khối đủ trường.

## 0b. Tổng hợp (đếm bằng script từ tệp này; đối chiếu 09/10 ~13:00 VN, điều chỉnh theo DoD mới 10/10)

- Tổng số mission: **245** (không thêm, không xoá). Lượt 10/10 chỉ đổi STATUS của 41 mission hướng tới khách / admin (xem «Đổi trạng thái 10/10»).
- Theo STATUS: `BACKLOG` 54 · `READY` 3 · `IN_PROGRESS` 4 · `PR_READY` 1 · `IN_REVIEW` 0 · `MERGED` 0 · `DEPLOYED` 3 · `VERIFYING` 5 · `BLOCKED_EXTERNAL` 7 · `BLOCKED_OWNER` 33 · `DEFERRED` 11 · `CODE_DONE_UI_NOT_VERIFIED` **38** · `PARTIAL_IMPLEMENTATION` **3** · `DONE` **83**. (Trước: DONE 119 · DEPLOYED 8.)
- Còn mở (khác `DONE`) theo ưu tiên: P0 **19** · P1 **44** · P2 61 · P3 38 (= 162). Trong đó 41 mission chờ ảnh UI: P0 9 · P1 19 · P2 12 · P3 1.
- Cách đếm (state method): mỗi khối `#### ` lấy `PRIORITY:` + `STATUS:` đầu tiên; mỗi dòng bảng có cột đầu `MISSION_ID` lấy cột `P` (cột 3) +
  `STATUS` (cột 4). Bảng §14 và §15.H không tính. Lượt 10/10 tính theo hiệu: DONE −36, DEPLOYED −5, +38 / +3 hai trạng thái mới; số mở cộng thêm 36
  (5 mission DEPLOYED vốn đã tính là mở; ưu tiên của chúng: P1 ×1, P2 ×4 trừ khỏi phần cộng).

## Đổi trạng thái 10/10 theo DoD mới

Lý do: không mission nào dưới đây có ảnh TRƯỚC / SAU của trang production. Logic có run ops vẫn được ghi ở PRODUCTION_EVIDENCE, nhưng phần nhìn thấy thì chưa.
- `PARTIAL_IMPLEMENTATION` (3): saas-l3-inbox · MM-INBOX-00 (Inbox V2-A/B đang làm) · trang-chu-su-that-thuong-mai (CTA đăng ký chờ D2).
- `CODE_DONE_UI_NOT_VERIFIED` (38) — §1: saas-signup-subscription · saas-identity-followup · saas-create-customer-correct · platform-viec-hang-ngay-len-dau.
  §2: saas-l1-hide-internal · saas-l2-customer-shell · saas-l1-followup · saas-shell-login-loop · saas-finish-line · saas-shell-gate-redirects ·
  saas-shell-polish · saas-finish-line-r2 · error-boundary-than-thien · erp-a11y-bo-cuc · kenh-dang-chay-trong-app · commercial-polish-2 ·
  erp-chi-tiet-duoi-dai · erp-o-nhap-co-ten. §3: hotfix-messenger-discovery · messenger-permission-diag. §4: saas-l4-channels · sales-human-takeover ·
  inbox-composer-templates · inbox-composer-hardening. §6: ai-balance-v1 · ai-balance-economics · MM-BILL-00. §7: MM-KPI-00 ·
  conversation-delivered-profit · ai-vs-human-profit · saas-customer-health. §8: MM-ORDER-01 · MM-ORDER-02 · customer-outcome-truth ·
  customer-list-outcome-truth · unknown-cost-not-zero · vtp-edit-cod-prefill · chi-tiet-don-khach-sach.
- Giữ nguyên `DONE`: backend / ops / pháp lý / tài liệu / audit (vd saas-identity-email-login, saas-acceptance-*, ops-signals-check, MM-LEGAL-*, commercial-sweep*).
  Bằng chứng logic: `saas-acceptance` PASS 7/7 run 37935922309 (tạo khách · kích hoạt · đăng nhập · vỏ · chat → AI → đơn).

---

## 1. SaaS restructuring · Platform Admin · provisioning · account / workspace

### 1.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| pricing-billing-foundation | Gói cấu hình được, đo usage, sổ chi phí AI, chặn lỗ, entitlement | P1 | DONE | DONE | #612 | run 37489937226, migration 0223, verify PASS 5529f717 | 2026-10-06 |
| saas-platform-restructure | SaaS Control Plane: tài khoản · sản phẩm · thuê bao theo sản phẩm · Operator Console (nền móng) | P1 | DONE | DONE | #615 | run 37496420935, migration 0224, smoke 0 trang đỏ | 2026-10-06 |
| saas-handoff-doc | Tài liệu bàn giao Phase A–F (`docs/saas/HANDOFF.md`) | P3 | DONE | DONE | #616 | tài liệu | 2026-10-06 |
| saas-b-internal-special-cases | Phase B: gỡ nhánh `isHome` thương mại | P3 | DONE | DONE | #622 | run 37557688936, `vnx.plan=internal` | 2026-10-07 |
| saas-d-pricing-overage | Phase D: bảng giá V1 có phiên bản, đồng hồ khách AI, phần vượt (0228) | P1 | DONE | DONE | #627 | run 37564156345, 8/8 tổ chức ghim legacy | 2026-10-07 |
| saas-signup-subscription | Cửa hàng tự đăng ký có thuê bao dùng thử ngay (F-02) | P0 | CODE_DONE_UI_NOT_VERIFIED | DONE | #670 | run 37744823972, verify PASS c360b7c6 | 2026-10-08 |
| saas-delete-signup-shops | Xoá cửa hàng tự đăng ký cũ bằng ops có chạy thử + sao lưu | P1 | DONE | DONE | #673 | ops run 37771243600 (xoá `kd`, sao lưu trước) | 2026-10-08 |
| saas-v1-plan-migration | Công cụ chuyển tổ chức legacy → giá V1 (chạy thử + nhật ký) | P1 | DONE | DONE | #676 | run 37772436572 — công cụ có, CHƯA chuyển tổ chức nào (xem MM-BILL-02) | 2026-10-08 |
| saas-identity-email-login | P0: khách do admin tạo đăng nhập email + mật khẩu; gửi lại liên kết kích hoạt | P0 | DONE | DONE | #681 | run 37781964748; ops `identity-reconcile` 37786092653 (chạy thử) → 37786400515 (ghi 12, THIẾU 0) | 2026-10-08 |
| saas-identity-followup | Gửi lại form Tạo khách không phát liên kết sai người; mở khoá ghi lại chỉ mục | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #684 | run 37786938351 | 2026-10-08 |
| saas-c-shared-identity | Phase C: thiết kế danh tính toàn nền tảng (`docs/saas/IDENTITY.md`) | P3 | DONE | DONE (phần tài liệu; phần mã = MM-IDENT-01) | #617 | tài liệu, trong production 85faea0b | 2026-10-08 |
| saas-create-customer-correct | LAUNCH BLOCKER — Tạo khách mới đúng mặc định: thương hiệu Chốt Đơn tự đặt, chỉ gói đang bán, nút không khoá im lặng, cài mẫu AI như `/start` | P0 | CODE_DONE_UI_NOT_VERIFIED | DONE (follow-up MM-FU-682) | #682 | deploy 37829126099 (`6883bfbf`) hậu kiểm ĐẠT; `saas-acceptance --apply` PASS 4/4 bước A (run 37838073371, lặp lại 37860546515 · 37866720324); verify `/tech` 09/10 | 2026-10-09 |
| platform-viec-hang-ngay-len-dau | `/platform`: tổ chức & sức khoẻ, công tắc khẩn, cổng mở bán lên đầu; khung Webhook Meta (một lần) xuống cuối (Commercial PR F, C1 #10) | P2 | CODE_DONE_UI_NOT_VERIFIED | DONE («9 nút không tên» chưa xác nhận trên DOM) | #714 | deploy 37860758200 (`d23c0deb`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |

### 1.2 Đang mở

#### saas-a-vnx-runtime
- TITLE: Phase A — chuyển runtime chatbot VNX sang Chốt Đơn (gỡ 4 chặn kỹ thuật, rồi bóng từng page)
- BUSINESS_GOAL: Workspace nhà VNX dùng cùng đường bot với khách ngoài; tắt container bot cũ
- OWNER: Chủ shop (duyệt từng page) · SESSION/AGENT: —
- PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- BRANCH: `feat/saas-a-vnx-runtime`, `feat/saas-a2-page-gate` · PR: #621, #625 (đã gộp)
- DEPENDENCIES: saas-platform-restructure, saas-d-pricing-overage (đều DONE) · BLOCKERS: chủ shop duyệt chuyển page OFF → SHADOW → LIVE (`docs/saas/OWNERSHIP.md` §4)
- DONE: gỡ 4 chặn kỹ thuật; cổng theo page (OFF/SHADOW/LIVE) — run 37555457699
- REMAINING: bật SHADOW cho MỘT page nhà → so hội thoại vàng → chủ shop duyệt LIVE → tắt container cũ
- ACCEPTANCE_CRITERIA: page LIVE trả lời qua `lib/sales-chatbot`, bot cũ tắt, không trùng tin
- PRODUCTION_EVIDENCE: run 37555457699 (phần mã) · NEXT_ACTION: chủ shop chọn page bóng đầu tiên · LAST_UPDATED: 2026-10-07

#### saas-e-customer-portal
- TITLE: Phase E — cổng khách tự phục vụ: tự đổi gói theo sản phẩm, API key, tên miền theo sản phẩm
- OWNER: Integration Lead · PRIORITY: P3 · STATUS: DEFERRED · CLASS: DEFERRED (lý do: Launch Gate đóng băng phạm vi ngoài kích hoạt / tin cậy / thu tiền; điều kiện mở lại: Launch Gate ĐẠT hoặc khách trả tiền đầu tiên yêu cầu)
- BRANCH / PR: — · DEPENDENCIES: saas-platform-restructure · BLOCKERS: —
- DONE: — · REMAINING: toàn bộ · ACCEPTANCE_CRITERIA: theo `docs/platform/phase-11-12-plan.md` Phase 12
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: — · LAST_UPDATED: 2026-10-06

#### saas-f-legacy-cleanup
- TITLE: Phase F — dọn di sản (container bot cũ, nhánh `/chatbot` cũ, đặc cách còn sót)
- OWNER: Integration Lead · PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DEPENDENCIES: saas-a-vnx-runtime (chờ chủ shop duyệt page) · BLOCKERS: như trên
- DONE: — · REMAINING: toàn bộ · ACCEPTANCE_CRITERIA: không còn đường chạy song song cho cùng một page
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: chờ saas-a-vnx-runtime · LAST_UPDATED: 2026-10-06

#### MM-IDENT-01 — Danh tính hợp nhất: phần mã (IDENTITY PR 2–8)
- TITLE: Một tài khoản nền tảng nhiều workspace (`platform_users`, claim `pu`, cờ `identity.unified`)
- OWNER: Chủ shop (AGENTS §7 — đổi quyền) · PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- BRANCH / PR: — · DEPENDENCIES: saas-c-shared-identity (tài liệu, DONE)
- BLOCKERS: chủ shop trả lời `docs/saas/IDENTITY.md` §7 Q1–Q6
- DONE: thiết kế + bất biến SECURITY §3 · REMAINING: PR 2 → PR 8 theo §6
- ACCEPTANCE_CRITERIA: bài kiểm B1–B8 của IDENTITY §4 · PRODUCTION_EVIDENCE: —
- NEXT_ACTION: chủ shop trả lời §7 · LAST_UPDATED: 2026-10-08

#### MM-IDENT-02 — Sửa phép khớp EMAIL chưa xác minh của đăng nhập Google / Facebook
- TITLE: OAuth khớp tài khoản theo email chưa xác minh (IDENTITY §1 quan sát 2; rủi ro lớn #1 của MASTER_MISSION_STATUS)
- OWNER: Chủ shop (IDENTITY §7 Q5) · PRIORITY: P1 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- BRANCH / PR: — · DEPENDENCIES: — · BLOCKERS: chủ shop cho phép sửa (đổi hành vi xác thực)
- DONE: — · REMAINING: PR riêng, trước IDENTITY PR 5 · ACCEPTANCE_CRITERIA: email không `verified` không liên kết được tài khoản có sẵn
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: hỏi chủ shop Q5 · LAST_UPDATED: 2026-10-08

---

## 2. Customer SaaS shell · UX polish · mobile · onboarding / help · Commercial Perfection Sweep

### 2.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| saas-l1-hide-internal | Che dữ liệu AI nội bộ khỏi khách (UI + máy chủ) | P0 | CODE_DONE_UI_NOT_VERIFIED | DONE | #639 | run 37654798771 | 2026-10-07 |
| saas-l2-customer-shell | Vỏ app khách Chốt Đơn: 8 mục, mặc định hộp thư, mobile | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #638 | run 37664556049 | 2026-10-07 |
| saas-l1-followup | Khách không ghi / tắt khoá AI; che replay · học · ai-builder · USD · go-live | P0 | CODE_DONE_UI_NOT_VERIFIED | DONE | #669 | run 37741568283; Launch Gate S4 ✅ PROD | 2026-10-08 |
| saas-shell-login-loop | Đăng nhập / đăng ký trong vỏ không trang trắng (F-01) | P0 | CODE_DONE_UI_NOT_VERIFIED | DONE | #671 | run 37744823972 | 2026-10-08 |
| saas-finish-line | Finish Line R1: audit admin + vỏ, quick wins (rỗng · chữ kỹ thuật · help · 404 · AI Sales cuộn) | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #680 | run 37781964748 | 2026-10-08 |
| saas-shell-gate-redirects | Vỏ không trang trắng khi thiếu quyền / module tắt | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #686 | trong production 4dbd864a (run 37800951308); verify `/tech` 09/10 | 2026-10-09 |
| saas-lowtech-ux | UX cho chủ shop ít rành máy: audit + thiết kế | P2 | DONE | SUPERSEDED — thay bằng `docs/saas/SHELL_AUDIT_2026-10-08.md` (#663) + Finish Line R1/R2 + saas-shell-polish + commercial-sweep; phần mã còn lại nằm ở MM-UX-* | — | — | 2026-10-09 |
| saas-shell-polish | Vỏ Chốt Đơn: `/login` sau đặt mật khẩu đúng thương hiệu, bỏ chữ kỹ thuật, `/module-disabled` có ranh giới lỗi, câu `BILLING_LOCKED` theo sản phẩm, Nhân viên gọn ở vỏ (ẩn ma trận quyền) | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE — đối chiếu Fable 09/10: đóng C1 #5 (ma trận quyền ẩn ở vỏ) và C1 #6 (thương hiệu sau `redirect()`); chữ kỹ thuật còn lại (C1 #7) = `shell-copy-brand-r3`; follow-up MM-FU-700 | #700 | deploy 37829126099 (`6883bfbf`) hậu kiểm ĐẠT; verify `/tech` 09/10. Chưa có lượt nghiệm thu CÓ ĐĂNG NHẬP xác nhận riêng (§17) | 2026-10-09 |
| saas-finish-line-r2 | Finish Line R2: tiêu đề theo menu vỏ (Sản phẩm · Nhân viên · Gói), tỷ lệ hoàn mẫu số 0 in «—», nhãn API/Webhook thành chữ khách hiểu | P2 | CODE_DONE_UI_NOT_VERIFIED | DONE | #713 | deploy 37860758200 (`d23c0deb`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| commercial-sweep | Commercial Perfection Sweep Phase A chỉ đọc: kiểm kê 207 trang + bảng chất lượng thương mại | P2 | DONE | DONE (tài liệu) | #703 | tài liệu; verify `/tech` 09/10 | 2026-10-09 |
| commercial-sweep-cap-nhat | Sweep: 207/207 trang (32 trang động đọc mã) + bảng C0/C1 theo trạng thái đã gộp | P2 | DONE | DONE (tài liệu — quy ước §0; sổ `/tech` đóng sau verify lô `50293da6`). Bàn giao Round 2 cuối (`claude/commercial-sweep-ban-giao`) đi PR riêng | #727 | tài liệu | 2026-10-09 |
| trang-chu-su-that-thuong-mai | Trang chủ Chốt Đơn nói đúng sản phẩm (Commercial PR A, C1 #1–#3): Pancake là lối chính hôm nay, nối thẳng Facebook «sắp mở», bỏ claim tuyệt đối, bỏ «Chi phí AI hiện rõ» | P1 | PARTIAL_IMPLEMENTATION | DONE (C1 #4 CTA theo chế độ đăng ký còn chờ D2) | #706 | deploy 37854562530 (`dbab6813`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| error-boundary-than-thien | Lỗi thân thiện (Commercial PR C, C1 #11): không in `error.message` / `DATABASE_URL`, chỉ mã tham chiếu | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #705 | deploy 37854562530 (`dbab6813`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| erp-a11y-bo-cuc | ERP (Commercial PR G, C1 #12 #14 #15): màn «không tìm thấy» có h1; công tắc / ô số / nút biểu tượng có tên; `/payroll` không tràn 390 px | P2 | CODE_DONE_UI_NOT_VERIFIED | DONE | #708 | deploy 37854562530 (`dbab6813`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| kenh-dang-chay-trong-app | Trong app chỉ hướng dẫn kênh đang chạy; cổng nối thẳng Facebook: khách thấy «sắp mở», người vận hành thấy nút thật (cờ `meta.direct-connect.open`) | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE — chưa có đường UI / ops bật cờ (MM-FU-712); ngày bật = D20 | #712 | deploy 37860758200 (`d23c0deb`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| commercial-polish-2 | Commercial PR B: vỏ Chốt Đơn không có chữ dưới 11 px (token 12 · 13 · 14 + bài chốt) · câu an toàn của màn lỗi | P3 | CODE_DONE_UI_NOT_VERIFIED | DONE (phần còn lại của PR B ở MM-UX-01) | #718 | deploy 37879275359 (`ef9b302a`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |

### 2.2 Đang mở

#### MM-UX-01 — Token chiều cao nút / ô nhập · ô bấm nhỏ · tiền tự định dạng (phần còn lại của Commercial PR B)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED (backlog Tech Lead từ bàn giao Fable 09/10)
- DONE: token chữ 12 · 13 · 14 + bài chốt 0 chữ < 11 px trên tệp CHỈ thuộc vỏ (#718, commercial-polish-2)
- REMAINING: (C2) token chiều cao nút / ô nhập + ô bấm nhỏ (board #17 · #20); (C2) bảng giá sỉ tự định dạng tiền (`products/price-lists/[id]/page.tsx:35`, board #18); mật độ chữ 10–10,5 px của trang dùng chung ERP ↔ vỏ chờ D21
- DEPENDENCIES: D21 (chỉ phần mật độ) · ACCEPTANCE_CRITERIA: bài kiểm quét mã · NEXT_ACTION: giao khi có slot · LAST_UPDATED: 2026-10-09

#### MM-UX-02 — Vào việc sau đăng ký + danh sách 10 bước (PX-08, F-03, HELP H4)
- TITLE: Hộp thư rỗng có bước tiếp theo; một danh sách 10 bước thay 4 danh sách rời
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DONE: thiết kế `docs/saas/HELP_CENTER.md` §7; #680 thêm trạng thái rỗng + Hướng dẫn (Launch Gate C4 🟡)
- REMAINING: H4 (hàm thuần checklist, thẻ trên Hộp thư, `/setup`) · ACCEPTANCE_CRITERIA: khách mới thấy bước nối kênh ngay sau đăng ký
- NEXT_ACTION: sau Launch Gate (đo TTV trước — MM-METRIC-01) · LAST_UPDATED: 2026-10-08

#### saas-help-system
- TITLE: Trợ giúp trong app cho khách: theo màn + câu hỏi thường gặp (HELP H1–H5)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DEPENDENCIES: saas-l2-customer-shell (DONE) · BLOCKERS: H2 (tầng liên hệ) chờ chủ shop chọn kênh hỗ trợ (PX-17)
- DONE: thiết kế `docs/saas/HELP_CENTER.md`; #680 sửa «Hệ thống →» + chủ đề AI Sales
- REMAINING: H1 audience theo vỏ, H2 thành phần «Nhắn hỗ trợ», H3 nút «?», H5 ảnh
- ACCEPTANCE_CRITERIA: 0 câu «liên hệ hỗ trợ» không có kênh · NEXT_ACTION: chủ shop chọn kênh hỗ trợ · LAST_UPDATED: 2026-10-07

#### MM-UX-03 — Menu vỏ thiếu Đơn hàng · Tự động hoá · Hiệu quả (F-11)
- OWNER: Chủ shop · PRIORITY: P2 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- BLOCKERS: chủ shop quyết thêm mục menu (FINISH_LINE §5) · DONE: — · REMAINING: sửa `lib/constants/saas-nav.ts`
- ACCEPTANCE_CRITERIA: đường lạ không ra 404 tiếng Anh · NEXT_ACTION: hỏi chủ shop · LAST_UPDATED: 2026-10-08

#### MM-UX-04 — Trang «Nhân viên» trong vỏ: bộ vai trò rút gọn (TUỲ CHỌN) (F-09, Commercial C1 #5)
- OWNER: Chủ shop (AGENTS §7 — đổi quyền) · PRIORITY: P2 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED (hạ P1 → P2 09/10: đối chiếu Fable đóng C1 #5 vì #700 đã ẩn ma trận quyền ở vỏ)
- BLOCKERS: D10 — chủ shop quyết có cần bộ vai trò Chốt Đơn (Chủ shop · Nhân viên bán hàng · Chỉ xem) hay không · DONE: #700 ẩn ma trận + bỏ chữ kỹ thuật ở trang Nhân viên
- REMAINING: chỉ khi chủ shop muốn — vai trò rút gọn · ACCEPTANCE_CRITERIA: Launch Gate C19 không còn ghi chú P1 · NEXT_ACTION: hỏi chủ shop · LAST_UPDATED: 2026-10-09

#### shell-copy-brand-r3
- TITLE: Vỏ Chốt Đơn Round 3: chữ kỹ thuật còn lộ ở vỏ (Commercial C1 #7) + phần vỏ của MM-FU-700 (lời mời / `hostSlug` sau `redirect()`)
- OWNER: Integration Lead · SESSION/AGENT: phiên đang chạy (sổ `/tech` RUNNING)
- PRIORITY: P1 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED (C1 duy nhất còn mở ở vỏ)
- BRANCH / PR: — (chưa có PR lúc chụp) · DEPENDENCIES: saas-shell-polish (DONE) · BLOCKERS: —
- DONE: — · REMAINING: code → PR → cổng → deploy → nghiệm thu có đăng nhập
- ACCEPTANCE_CRITERIA: danh sách chữ cấm = 0 trên các trang vỏ; C1 #7 đóng trên bảng thương mại
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: phiên đang cầm mở PR · LAST_UPDATED: 2026-10-09

#### erp-chi-tiet-duoi-dai
- TITLE: Trang chi tiết ERP đuôi dài: «%» trên đường dẫn thôi gây 500 ở 4 trang cài đặt, tiền theo `formatVND`, mã Google / trường thô ở khách sỉ thành tiếng Việt, đầu trang xuống dòng 390 px, phiếu sản xuất cuộn ngang, lượt nhập VTP hỏng thôi in 9 ô 0
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: CODE_DONE_UI_NOT_VERIFIED · CLASS: STILL REQUIRED (chờ hậu kiểm)
- BRANCH / PR: #721 → `f7eae2c2` · DEPENDENCIES: — · BLOCKERS: —
- DONE: mã + bài kiểm · REMAINING: hậu kiểm production · ACCEPTANCE_CRITERIA: 4 trang `/settings/…/[id]` không 500 với «%» lẻ
- PRODUCTION_EVIDENCE: production `50293da6` (deploy 37886395475, `/api/health` khớp) — hậu kiểm riêng CHƯA · NEXT_ACTION: `verify --sha=50293da6` → đóng trong sổ `/tech` · LAST_UPDATED: 2026-10-09

#### erp-o-nhap-co-ten
- TITLE: Ô nhập ở trang chi tiết ERP có tên cho trình đọc màn hình (lô xưởng 36 ô, khách sỉ, gọi điện, topic, trạng thái mẫu, góp ý ý tưởng, trình sửa luật tự động)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: CODE_DONE_UI_NOT_VERIFIED · CLASS: STILL REQUIRED (chờ hậu kiểm)
- BRANCH / PR: #726 → `279a7105` · DONE: mã + `tests/erp-form-names.test.ts` · REMAINING: hậu kiểm
- PRODUCTION_EVIDENCE: production `50293da6` (deploy 37886395475, `/api/health` khớp) — hậu kiểm riêng CHƯA · NEXT_ACTION: `verify --sha=50293da6` → đóng trong sổ `/tech` · LAST_UPDATED: 2026-10-09

#### MM-UX-05 — Biểu tượng thông báo đẩy / `sw.js` / apple-touch-icon theo host (D5, F-16)
- OWNER: Integration Lead · PRIORITY: P3 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DONE: — · REMAINING: icon theo thương hiệu host · NEXT_ACTION: sau Launch Gate · LAST_UPDATED: 2026-10-08

---

## 3. Messenger direct · Meta OAuth · Meta App Review · multi-page

### 3.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| master-mission | AI bán hàng nhiều page, đo tiền AI làm ra, Pancake thành tuỳ chọn | P1 | DONE | DONE | #598 | run 37417089563 | 2026-10-06 |
| pancake-replacement | Thay Pancake bằng Meta/Facebook gốc (ghi đơn, lịch sử, phân trang page) | P1 | DONE | DONE | #602 | run 37431030954 | 2026-10-06 |
| hotfix-messenger-discovery | Kết nối Facebook nói đúng vì sao 0 page; AI hết tiền báo nhóm vận hành | P0 | CODE_DONE_UI_NOT_VERIFIED | DONE | #603 | run 37431030954; log `PERMISSION_NOT_GRANTED` | 2026-10-06 |
| messenger-permission-diag | Phân biệt 7 nguyên nhân nối Page; hồ sơ kỹ thuật App Review | P0 | CODE_DONE_UI_NOT_VERIFIED | DONE | #608 | run 37459821433 | 2026-10-06 |
| messenger-app-webhook | Webhook nhận gói của app Meta Messenger riêng | P0 | DONE | DONE | #611 | run 37468537396 (GET sai token 403, POST không chữ ký 401) | 2026-10-06 |
| messenger-app-switch | Nối page đi bằng app Meta Messenger riêng | P0 | DONE | DONE | #614 | run 37483380845 | 2026-10-06 |
| messenger-oauth-scopes | Sửa «Invalid Scopes» — chỉ xin 5 quyền Page | P0 | DONE | DONE | #628 | run 37566448070 | 2026-10-07 |
| meta-review-guide | Hướng dẫn chủ shop: use case Messenger + App Review | P1 | DONE | DONE | #672 | tài liệu `docs/meta-app-review/HUONG_DAN_CHU_SHOP.md` | 2026-10-08 |
| MM-META-00 | Messenger trực tiếp ngang Pancake: ảnh câu mẫu, trả lời bình luận bằng tin riêng | P1 | DONE | DONE | #580 | đã deploy (05/10) | 2026-10-05 |

### 3.2 Đang mở

#### meta-messenger-access
- TITLE: Kết nối Facebook Page trực tiếp — Meta chưa cấp quyền Page cho app nền tảng; App Review
- BUSINESS_GOAL: Khách ngoài tự nối Page không qua Pancake (Launch Gate C6 — điều kiện «READY FOR FIRST PAYING CUSTOMER»)
- OWNER: Chủ shop (App Dashboard Meta) · SESSION/AGENT: —
- PRIORITY: P0 · STATUS: BLOCKED_EXTERNAL · CLASS: STILL REQUIRED
- BRANCH / PR: — (mã phía ERP đã xong: #603 #608 #611 #614 #628)
- BLOCKERS: thêm use case «Engage with customers on Messenger from Meta» + `pages_show_list` · `pages_messaging` · `pages_manage_metadata` · `pages_read_engagement`; bấm «Kết nối Facebook Page» một lần; nộp App Review / Business Verification
- DONE: chẩn đoán 7 lý do, hướng dẫn chủ shop · REMAINING: việc của chủ shop + Meta duyệt
- ACCEPTANCE_CRITERIA: `LAUNCH_GATE.md` §5 — smoke bằng tài khoản / Page KHÔNG có vai trò trong app
- PRODUCTION_EVIDENCE: log 06/10 `reason=PERMISSION_NOT_GRANTED granted=public_profile`
- NEXT_ACTION: chủ shop làm `docs/meta-app-review/HUONG_DAN_CHU_SHOP.md` · LAST_UPDATED: 2026-10-08

#### MM-META-01 — Smoke Meta Direct bằng tài khoản ngoài sau khi Meta duyệt
- OWNER: Integration Lead · PRIORITY: P0 · STATUS: BLOCKED_EXTERNAL · CLASS: STILL REQUIRED
- DEPENDENCIES: meta-messenger-access · DONE: — · REMAINING: OAuth → Page → subscribe → tin → hộp thư → AI → đơn nháp → đơn
- ACCEPTANCE_CRITERIA: `LAUNCH_GATE.md` §5 đi trọn · NEXT_ACTION: chờ Meta · LAST_UPDATED: 2026-10-08

#### MM-META-02 — Lưới đỡ khi mất webhook Meta: quét bù Graph (PX-12, B3)
- OWNER: Integration Lead · PRIORITY: P1 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DEPENDENCIES: meta-messenger-access (cần quyền thật để kiểm) · DONE: — · REMAINING: job quét bù hội thoại theo page
- ACCEPTANCE_CRITERIA: tin rơi webhook được nhặt lại trong một chu kỳ · NEXT_ACTION: sau Meta duyệt · LAST_UPDATED: 2026-10-08

#### MM-META-03 — Nâng phiên bản Graph API trước hạn 21/01/2027
- OWNER: Integration Lead · PRIORITY: P1 · STATUS: BACKLOG · CLASS: STILL REQUIRED (có hạn cứng)
- DONE: — · REMAINING: đổi phiên bản + chạy lại bài kiểm Messenger · ACCEPTANCE_CRITERIA: không lời gọi nào còn v21
- NEXT_ACTION: lên lịch trước 12/2026 · LAST_UPDATED: 2026-10-08

#### MM-META-04 — Meta Direct: thẻ HUMAN_AGENT, bộ nhớ hội thoại cho Meta / Zalo / Web (B3 còn lại)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DEPENDENCIES: meta-messenger-access · DONE: — · NEXT_ACTION: sau Meta duyệt · LAST_UPDATED: 2026-10-08

---

## 4. Inbox · human takeover · follow-up · recovery radar

### 4.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| saas-l4-channels | Kênh kết nối hợp nhất cho khách | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #637 | run 37654798771 | 2026-10-07 |
| saas-l3-inbox | Hộp thư hợp nhất + song song Pancake / Meta Direct (0233) | P1 | PARTIAL_IMPLEMENTATION | DONE | #641 | run 37667608381 | 2026-10-07 |
| sales-human-takeover | Tiếp quản / cho AI tiếp tục trong hội thoại (0231) | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #633 | run 37614289468 | 2026-10-07 |
| ai-sales-recovery | Cứu hội thoại khách nhắn mà bot chưa trả lời (chỉ đọc) | P1 | DONE | DONE | #613 | run 37493421549 | 2026-10-06 |
| inbox-composer-templates | Chèn câu mẫu + dòng sản phẩm (giá / tồn ERP) ngay ô soạn | P2 | CODE_DONE_UI_NOT_VERIFIED | DONE | #661 | run 37735795033 | 2026-10-08 |
| inbox-composer-hardening | Ô soạn dùng chung cổng quyền với Gửi, không chèn tồn âm | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #666 | run 37741568283 | 2026-10-08 |
| MM-INBOX-00 | Hộp thư khách hiện như Pancake: ảnh, nhãn dán, emoji (#679); lọc nâng cao (#595); đủ lịch sử fanpage (#599); dễ nhìn (#577); gửi ảnh + nhãn + ghi chú (#576); hộp thư người (#573) | P1 | PARTIAL_IMPLEMENTATION | DONE | #573 #576 #577 #595 #599 #679 | đã deploy | 2026-10-08 |

### 4.2 Đang mở

#### saas-inbox-perf
- TITLE: Hiệu năng hộp thư — đo nền trước (V2-0 / PX-14), tối ưu sau
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DEPENDENCIES: saas-l3-inbox (DONE); số đo của `inbox-perf-probe` (IN_PROGRESS) · DONE: kế hoạch đo `INBOX_V2.md` §8 · REMAINING: V2-0 số nền p50/p95, rồi V2-7
- ACCEPTANCE_CRITERIA: có số nền trước mọi sửa · NEXT_ACTION: đọc kết quả `inbox-perf-probe` rồi mới quyết tối ưu · LAST_UPDATED: 2026-10-09

#### inbox-perf-probe
- TITLE: Đo hiệu năng trên PRODUCTION: hộp thư + các trang chậm của Commercial C1 #13 (`/chatbot` · `/chatbot/ad-bots` · `/cod` · `/reports/returns` · `/reports/target`)
- BUSINESS_GOAL: đóng C1 #13 bằng số đo production (harness cục bộ trên dữ liệu demo không đại diện)
- OWNER: Integration Lead · SESSION/AGENT: phiên đang chạy (sổ `/tech`)
- PRIORITY: P1 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED
- BRANCH / PR: — · DEPENDENCIES: — · BLOCKERS: —
- DONE: — · REMAINING: số p50 / p95 trên production + ops smoke các trang trên; sửa chỉ sau khi có số (MM-REC-22)
- ACCEPTANCE_CRITERIA: mỗi trang C1 #13 có số đo production 3–5 lượt (median), có vết run
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: chạy đo chỉ đọc · LAST_UPDATED: 2026-10-09

#### MM-INBOX-01 — Hộp thư V2 (V2-1 → V2-6: tách màn, ưu tiên P0–P3, timeline, lệnh `/`, Copilot 7 khối)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: DEFERRED · CLASS: DEFERRED (lý do: đóng băng phạm vi Launch Sprint; mở lại khi Launch Gate ĐẠT và V2-0 có số)
- DONE: thiết kế `docs/saas/INBOX_V2.md` (#663) · REMAINING: V2-1…V2-6 · LAST_UPDATED: 2026-10-08

#### MM-INBOX-02 — Revenue Rescue có sự kiện + giá trị kỳ vọng + kết quả
- TITLE: Sự kiện cứu có lý do · giá trị kỳ vọng · kết quả · đơn / doanh thu giao / lợi nhuận cứu được (MASTER_MISSION_STATUS P1 #6)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DONE: quét khách bị bỏ sót (`recovery.ts`), follow-up, quét lại tin rơi (#613) · REMAINING: sổ sự kiện cứu + báo cáo
- NEXT_ACTION: sau Launch Gate · LAST_UPDATED: 2026-10-08

#### MM-INBOX-03 — «Bác sĩ kết nối» cho khách (PX-11)
- TITLE: Tin có tới không · AI có trả lời không · vì sao — một màn cho khách
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED (phía người vận hành do saas-ops-signals + saas-customer-health phủ)
- DEPENDENCIES: saas-ops-signals · DONE: — · NEXT_ACTION: sau saas-ops-signals · LAST_UPDATED: 2026-10-08

#### MM-INBOX-04 — Đếm khách AI cho tin nhắn lại do AI soạn (E3, OVERAGE Q10)
- OWNER: Chủ shop · PRIORITY: P2 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- BLOCKERS: OVERAGE Q10 (hôm nay cố ý KHÔNG đếm) · NEXT_ACTION: hỏi chủ shop · LAST_UPDATED: 2026-10-08

---

## 5. AI Sales Agent · độ tin cậy · bảo mật bot · AI cost optimization

### 5.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| ai-sales-reliability | AI Sales production-grade: SLO, DLQ, cockpit, cứu hội thoại sót (0222) | P0 | DONE | DONE | #607 | run 37465273143; `sales-health` SUCCESS 6 tổ chức | 2026-10-06 |
| ai-provider-failover | Failover primary → secondary → người, circuit breaker | P0 | DONE | DONE | #610 | run 37462403157 (mặc định không khoá dự phòng) | 2026-10-06 |
| bot-order-status | Bot tra trạng thái đơn theo lời khai ĐVVC | P1 | DONE | DONE | #645 | run 37697610332 | 2026-10-07 |
| returning-history-leak | Chặn lộ lịch sử mua qua SĐT gõ tay | P1 | DONE | DONE | #647 | run 37697610332 | 2026-10-07 |
| order-truth-stamp | Đơn bot chốt mang dấu lời nhắc · model · bản mã | P2 | DONE | DONE | #649 | run 37700846133 | 2026-10-08 |
| returning-hardening | Đơn nháp người lạ không thành «lần trước»; giá đại lý đúng chủ | P1 | DONE | DONE | #651 | run 37707093592 | 2026-10-08 |
| chatbot-security-2 | Đơn nháp người lạ không chặn đơn thật; bài học xin chuyển khoản không tự áp | P1 | DONE | DONE | #652 | run 37707093592 | 2026-10-08 |
| chatbot-security-3 | Bộ lọc bài học: tên miền / handle trần | P1 | DONE | DONE | #654 | run 37712043105 | 2026-10-08 |
| chatbot-security-4 | Bộ lọc bài học: đuôi lạ, chấm che giấu, ký tự vô hình | P1 | DONE | DONE | #656 | run 37719581360 | 2026-10-08 |
| chatbot-security-5 | Form đơn trong chat không điền chữ hồ sơ chưa xác minh | P1 | DONE | DONE | #657 | run 37727378042 | 2026-10-08 |
| saas-public-chat-limits | Chat công khai / nhúng có giới hạn tần suất (PX-04, F5) | P0 | DONE | DONE | #665 | run 37741568283 | 2026-10-08 |
| MM-AI-00 | Platform AI Model Control: đổi model không deploy, canary 10 %, A/B KPI, chính sách theo loại việc, benchmark có phanh, sổ AI ghi token suy nghĩ / bộ đệm / độ trễ | P2 | DONE | DONE | #618 #626 #630 #632 #634 #635 #636 #642 | đã deploy (06–07/10) | 2026-10-07 |
| MM-AI-01 | Bot không trả lời trùng, không im sau tin mẫu; bỏ trần 500 lượt/ngày; luật chốt «khách tự gửi SĐT + địa chỉ» | P1 | DONE | DONE | #570 #575 #588 | đã deploy (05/10) | 2026-10-05 |

### 5.2 Đang mở

#### ai-cost-opt-v2
- TITLE: Tối ưu chi phí AI V2 — đo nền theo workload trước (không làm lại #618/#626/#630/#632/#634)
- BUSINESS_GOAL: Giảm chi phí mỗi đơn AI chốt thành công mà không giảm chất lượng
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DEPENDENCIES: E2 — Integration Lead chạy câu Q0–Q9 của `docs/saas/AI_COST_WORKLOAD.md`
- DONE: tài liệu nền (#662) · REMAINING: số nền theo loại việc × model × kết quả, rồi đề xuất · PRODUCTION_EVIDENCE: —
- NEXT_ACTION: chạy Q0–Q9 (chỉ đọc) · LAST_UPDATED: 2026-10-07

#### MM-AI-02 — An toàn khi phát hành AI (đổi lời nhắc / model / định tuyến) (PX-23)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DONE: nền có (golden, dấu lời nhắc #649, A/B model) · REMAINING: cổng golden bắt buộc trước khi đổi lời nhắc / model
- NEXT_ACTION: sau Launch Gate · LAST_UPDATED: 2026-10-08

#### MM-AI-03 — Rủi ro LOW đã ghi nhận của bot (không chặn)
- TITLE: Hộp thư hiện tên / địa chỉ / lịch sử của hồ sơ chưa xác minh cho NHÂN VIÊN; form POS chọn hồ sơ bot tạo mà để trống địa chỉ thì lõi lấy địa chỉ đã lưu
- OWNER: Integration Lead · PRIORITY: P3 · STATUS: DEFERRED · CLASS: DEFERRED (lý do: LOW, chỉ nhân viên thấy; mở lại khi review bảo mật nâng mức)
- LAST_UPDATED: 2026-10-08

---

## 6. AI Balance · pricing · quota · usage · billing · QR payment · invoice readiness

### 6.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| saas-l5-billing-trial | Dùng thử + hết lượt dừng AI, kỳ tính tiền, ngưỡng cảnh báo (0234) | P1 | DONE | DONE | #640 | run 37673293447 | 2026-10-07 |
| ai-balance-v1 | Số dư AI + nạp QR SePay (ERPNAP), sổ cái chỉ ghi thêm | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #644 | run 37697610332 | 2026-10-07 |
| ai-balance-economics | Doanh thu · chi phí · biên Số dư AI trên /platform | P2 | CODE_DONE_UI_NOT_VERIFIED | DONE | #648 | run 37700846133 | 2026-10-08 |
| ai-balance-hardening | Sao kê không nạp hộ; báo hết số dư không nuốt nhau | P1 | DONE | DONE | #650 | run 37709225559 | 2026-10-08 |
| ai-balance-followup | Đảo đúng một khoản trừ; cockpit tính doanh thu Số dư | P2 | DONE | DONE | #653 | run 37714463197 | 2026-10-08 |
| billing-sepay-trust | Thuê bao chỉ tự gia hạn khi SePay ghi đúng tài khoản nhận | P1 | DONE | DONE | #655 | run 37717239217 | 2026-10-08 |
| MM-BILL-00 | Gói Dùng thử in «còn N ngày» thay «—» (FINISH_LINE §5) | P2 | CODE_DONE_UI_NOT_VERIFIED | SUPERSEDED — làm trong #670 | #670 | run 37744823972 | 2026-10-08 |

### 6.2 Đang mở

#### MM-BILL-01 — Hoá đơn phần vượt gói (OVERAGE O1–O5) — PX-10 «Thu được tiền theo V1»
- OWNER: Chủ shop (Q2–Q10) + Integration Lead (mã) · PRIORITY: P1 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DEPENDENCIES: — · BLOCKERS: O2–O5 chờ `docs/saas/OVERAGE.md` §11 Q2–Q10 (kỳ thu, đường duyệt, hạn trả, ghế, đổi gói giữa kỳ, VAT)
- DONE: thiết kế (#662) · REMAINING: O1 (hàm «phần gồm tính tiền» dùng chung — làm được ngay, READY) → O2 migration → O3 phát hành → O4 màn khách → O5 nhắc hạn
- ACCEPTANCE_CRITERIA: một hoá đơn vượt gói phát hành + thu qua QR + ghi sổ, không thu hai lần với Số dư AI
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: chủ shop trả lời Q2–Q4; O1 giao khi có slot · LAST_UPDATED: 2026-10-08

#### MM-BILL-02 — Chuyển 8 tổ chức từ giá legacy sang V1 (OVERAGE O6 / Q8)
- OWNER: Chủ shop · PRIORITY: P1 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DEPENDENCIES: saas-v1-plan-migration (DONE — công cụ) · BLOCKERS: chủ shop chọn tổ chức, ngày hiệu lực, thời gian báo trước
- DONE: công cụ chạy thử theo tổ chức · REMAINING: chạy `--apply` từng tổ chức · NEXT_ACTION: hỏi chủ shop · LAST_UPDATED: 2026-10-08

#### MM-BILL-03 — Số dư AI: kế toán / pháp lý duyệt; giá phiên công bố khi đủ dữ liệu
- OWNER: Chủ shop + luật sư (LEGAL P0-10, G-7) · PRIORITY: P1 · STATUS: BLOCKED_EXTERNAL · CLASS: STILL REQUIRED
- DONE: thiết kế «tín dụng dịch vụ» (`ai-balance-rules.ts`), HSLC đã dùng thật · REMAINING: văn bản luật sư; giá phiên chỉ công bố sau 30 ngày dữ liệu + tỷ lệ chốt (DEFERRED tới khi đủ dữ liệu)
- NEXT_ACTION: luật sư trả lời G-7 · LAST_UPDATED: 2026-10-08

#### MM-BILL-04 — Gán gói thường cho workspace VNX (E6)
- OWNER: Chủ shop · PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DEPENDENCIES: saas-a-vnx-runtime · NEXT_ACTION: sau Phase A · LAST_UPDATED: 2026-10-08

#### MM-BILL-05 — Thêm cổng thanh toán payOS
- OWNER: Chủ shop · PRIORITY: P3 · STATUS: DEFERRED · CLASS: DEFERRED (lý do: chưa có yêu cầu; SePay đủ cho V1; mở lại khi chủ shop quyết — MASTER_MISSION_STATUS «cần chủ shop quyết» 2)
- LAST_UPDATED: 2026-10-08

---

## 7. Customer health · analytics / KPI · SaaS metrics

### 7.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| conversation-delivered-profit | Lãi gộp đã giao theo AI tự bán / AI góp công / Người bán | P2 | CODE_DONE_UI_NOT_VERIFIED | DONE | #646 | run 37684290837 | 2026-10-07 |
| ai-vs-human-profit | AI vs Người theo lãi gộp đã giao + sau chi phí AI | P2 | CODE_DONE_UI_NOT_VERIFIED | DONE | #658 | run 37727378042 | 2026-10-08 |
| MM-KPI-00 | Hiệu quả AI lọc «Hôm nay» / khoảng ngày, đếm đơn như Báo cáo danh nghĩa | P2 | CODE_DONE_UI_NOT_VERIFIED | DONE | #688 | trong production 4dbd864a | 2026-10-08 |
| MM-KPI-01 | Sổ chỉ số AI Sales (bán chéo, chênh lệch AI − người…) + bán chéo trên đơn đã giao | P2 | DONE | DONE | #563 #564 | đã deploy (04/10) | 2026-10-04 |
| saas-customer-health | Danh sách / chi tiết khách cho admin thấy sức khoẻ < 30 giây (Launch Gate A7 · A8 · A10; Commercial C1 #8) | P0 | CODE_DONE_UI_NOT_VERIFIED | DONE — trang admin mới có vết smoke 200, chưa có lượt xem có vết từng khối; follow-up MM-FU-683 · MM-FU-692b | #683 | deploy 37829126099 (`6883bfbf`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |

### 7.2 Đang mở

#### MM-METRIC-01 — Đo Time-to-Value đủ chuỗi (PX-13, TV-1 → TV-4)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DONE: tài liệu + 11 câu SQL (`docs/product-excellence/TIME_TO_VALUE.md`) · REMAINING: mốc M4/M5, Zalo + chat web, mốc tới phút, lý do kẹt
- NEXT_ACTION: sau Launch Gate · LAST_UPDATED: 2026-10-08

#### MM-METRIC-02 — Giữ chân sớm: ngày hoạt động, đăng nhập cuối, cohort tuần (PX-15)
- OWNER: Integration Lead · PRIORITY: P3 · STATUS: BACKLOG · CLASS: STILL REQUIRED · DONE: câu đo Q9, Q10 · LAST_UPDATED: 2026-10-08

#### MM-METRIC-03 — «AI đã mang về cho bạn bao nhiêu» trong vỏ khách (PX-19)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED (dùng lại #646, #658) · LAST_UPDATED: 2026-10-08

#### MM-METRIC-04 — Lãi theo hội thoại trừ cước / quảng cáo / nhân sự; ROI khách
- OWNER: Chủ shop (căn cứ phân bổ — AGENTS §3.14) · PRIORITY: P3 · STATUS: DEFERRED · CLASS: DEFERRED (lý do: chưa có căn cứ phân bổ theo hội thoại; mở lại khi chủ shop khai căn cứ)
- LAST_UPDATED: 2026-10-08

#### MM-METRIC-05 — Thao tác ops chỉ đọc theo CSDL tổ chức (tỷ lệ chốt / giao / lợi nhuận theo phiên)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED (điều kiện để chốt giá phiên — MM-BILL-03)
- LAST_UPDATED: 2026-10-08

---

## 8. Order candidate · mapping · accuracy · OMS · product / SKU / inventory

### 8.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| saas-order-accuracy | Golden replay v2: SKU 29/29 · SL 34/34 · SĐT 28/29 · địa chỉ 87/87 · trùng 0/30 | P1 | DONE | DONE | #664 | run 37741568283 | 2026-10-08 |
| order-confirm-rules-0810 | Luật chốt 08/10: khách huỷ / xã chưa ghép ⇒ cần người kiểm + nút nhanh; lời xác nhận theo ranh giới từ, SĐT chuẩn hoá (PX-06 · PX-07) | P1 | DONE | DONE | #675 | run 37761350570 | 2026-10-08 |
| MM-ORDER-00 | Bot không lấy giá lẻ làm giá sỉ, quy cách 0,5 kg + 1 kg; ops `org-catalog` | P1 | DONE | DONE | #677 | đã deploy (08/10) | 2026-10-08 |
| MM-ORDER-01 | Trang sản phẩm có nút «Thêm mẫu mã» | P2 | CODE_DONE_UI_NOT_VERIFIED | DONE | #685 | trong production 4dbd864a | 2026-10-08 |
| MM-ORDER-02 | Nhân viên tạo đơn trong hội thoại (không cộng công bot, chống bấm hai lần); đơn tự ghép tỉnh + xã mới | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #565 #583 | đã deploy | 2026-10-05 |
| vtp-edit-cod-prefill | Sửa đơn VTP thôi điền sẵn COD của đơn cho vận đơn COD 0; đổi tiền thu hộ phải xác nhận; «Đã thu» chưa có chứng từ in «Chưa xác minh» (Commercial C0 duy nhất) | P0 | CODE_DONE_UI_NOT_VERIFIED | DONE — chủ shop tự gộp (CRITICAL: thêm `export` cho `HAS_CASH_EVIDENCE` trong `return-rate.ts`). Chưa mở `/shipments/<id>` của một vận đơn COD 0 trên production (§17) | #717 | deploy 37879275359 (`ef9b302a`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| customer-outcome-truth | Trang khách + cảnh báo rủi ro thôi lấy bộ đếm Pancake làm giao thành công (AGENTS 0.1 / 3.2) | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE (phần còn lại = pancake-counters-remaining) | #715 | deploy 37879275359 (`ef9b302a`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| customer-list-outcome-truth | Danh sách khách + bộ lọc + cột Đã thanh toán của danh sách đơn thôi trộn bộ đếm Pancake (nối #715) | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #722 | deploy 37879275359 (`ef9b302a`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| unknown-cost-not-zero | Giá vốn CHƯA BIẾT không in thành 0 ₫ trên trang đơn / sản phẩm (AGENTS 42) | P1 | CODE_DONE_UI_NOT_VERIFIED | DONE | #716 | deploy 37879275359 (`ef9b302a`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| production-unpriced-approval | Lệnh đặt xưởng chưa có giá không lọt bước duyệt PURCHASING_LARGE; giá trống không lưu thành 0 | P1 | DONE | DONE | #719 | deploy 37879275359 (`ef9b302a`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |

### 8.2 Đang mở

#### pancake-counters-remaining
- TITLE: Phần còn đọc bộ đếm Pancake sau #715 / #722: khối «Khách hàng» trên trang đơn + bộ lọc đã lưu
- BUSINESS_GOAL: không màn nào kết luận giao thành công / hoàn từ bộ đếm Pancake (AGENTS 0.1, 3.1 — chỉ `ORDER_OUTCOME`)
- OWNER: Integration Lead · SESSION/AGENT: phiên đang chạy (sổ `/tech`)
- PRIORITY: P1 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED
- BRANCH / PR: — · DEPENDENCIES: customer-outcome-truth, customer-list-outcome-truth (DONE) · BLOCKERS: —
- DONE: — · REMAINING: khối «Khách hàng» trang đơn + bộ lọc đã lưu → PR → cổng → deploy
- ACCEPTANCE_CRITERIA: grep không còn bộ đếm Pancake trong đường tính kết quả ở hai chỗ trên; bài kiểm nguồn
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: phiên đang cầm mở PR · LAST_UPDATED: 2026-10-09

#### chi-tiet-don-khach-sach
- TITLE: Trang chi tiết đơn / khách / hội thoại không nói Pancake với khách không dùng Pancake, không in 0 ₫ cho tiền đơn tay không có, diễn biến hội thoại bằng tiếng Việt
- OWNER: Integration Lead · PRIORITY: P1 · STATUS: CODE_DONE_UI_NOT_VERIFIED · CLASS: STILL REQUIRED (chờ hậu kiểm)
- BRANCH / PR: #725 → `50293da6` · DONE: mã + `tests/detail-pages-shell.test.ts`
- REMAINING: mở các trang này trên production bằng một tổ chức KHÔNG dùng Pancake (§17)
- PRODUCTION_EVIDENCE: production `50293da6` (deploy 37886395475, `/api/health` khớp) — hậu kiểm riêng CHƯA · NEXT_ACTION: `verify --sha=50293da6` → đóng trong sổ `/tech` · LAST_UPDATED: 2026-10-09

#### MM-ORDER-03 — Order Candidate: hàm thuần + bảng bóng + panel (C3a · C3b · C3c)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DONE: thiết kế `docs/saas/ORDER_CANDIDATE.md` (#663); C1 golden v2 (#664); quyết định chủ shop 08/10 (§12) đã vào #675
- REMAINING: C3a hàm thuần + MỘT hàm SĐT · C3b migration ghi bóng (gộp B4) · C3c panel
- ACCEPTANCE_CRITERIA: bóng ghi candidate song song, hành vi đơn không đổi · NEXT_ACTION: sau Launch Gate · LAST_UPDATED: 2026-10-08

#### MM-ORDER-04 — Chống trùng đơn: đo khoá trùng trên production → `idempotency_key` UNIQUE (C4)
- OWNER: Integration Lead · PRIORITY: P1 · STATUS: BACKLOG · CLASS: STILL REQUIRED (rủi ro lớn #2: `agentKey` không UNIQUE)
- DONE: golden trùng 0/30 (Launch Gate C17 🟡) · REMAINING: đo production (chỉ đọc) → migration UNIQUE (R3)
- NEXT_ACTION: chạy đo chỉ đọc · LAST_UPDATED: 2026-10-08

#### MM-ORDER-05 — Đổi luật chốt theo phương án A / B / C (C3d) · nơi lưu golden có PII
- OWNER: Chủ shop · PRIORITY: P2 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- BLOCKERS: `ORDER_CANDIDATE.md` §11 Q1 (phương án), Q3, Q4, Q5 (nơi lưu hội thoại thật — kho PUBLIC) · LAST_UPDATED: 2026-10-08

#### MM-ORDER-06 — Nợ pilot nền tảng còn MỞ (`docs/platform/pilot-readiness.md` §4)
- TITLE: Nhập CSV sản phẩm / khách / đơn (A5 #15) · lợi nhuận thực nhận cho tổ chức không ĐVVC · phiếu thu chuyển khoản nối sổ ngân hàng
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED · LAST_UPDATED: 2026-10-01

---

## 9. Observability · incident · backup · tenant isolation · security

### 9.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| backup-drive-trash | Sao lưu ngoài máy: xoá hẳn bản quá hạn, dọn thùng rác chỉ trong thư mục sao lưu, `backup-status` đo Drive | P1 | DONE | DONE (mã chạy đúng: lượt 23:04 dọn 109 MB thùng rác, 7 CSDL tổ chức OK); dung lượng còn lại = MM-OPS-02; phần thấp = MM-FU-689 | #689 | run 37796789087 (b3a8d74e) + lượt sao lưu 23:04 | 2026-10-09 |
| saas-ops-signals | Người vận hành chẩn đoán 8 loại sự cố của khách (O1–O8), migration 0237; sửa lộ `reason` / `orgCode` ở đăng nhập công khai | P0 | DONE | DONE — O1 chứng minh trọn hai luồng; O2–O8 TÍNH ĐƯỢC nhưng chưa chứng minh PHÁT HIỆN (acceptance-signal-drills · MM-FU-724); follow-up MM-FU-692a / 692b | #692 | deploy 37838226087 (`c71833950519`) hậu kiểm ĐẠT; `ops-signals-check` PASS 9 tổ chức × 8 tín hiệu, 0 ô hỏng (run 37853956678 · 37860619173 · 37867472656); O1 RESET_LINK_USED (37860619173) + LOGIN / BAD_PASSWORD (37867472656) | 2026-10-09 |
| saas-acceptance-smoke | Smoke nghiệm thu khách Chốt Đơn trên production (ops `saas-acceptance`: A cấp phát · B kích hoạt + đăng nhập email · C vỏ; D · E cần `--e2e`) | P0 | DONE | DONE — D · E (`--e2e`) chờ D19 chủ shop chuẩn bị UI | #690 | `--apply` PASS 4/4 ba lần: run 37838073371 (`6883bfbf`) · 37860546515 (`dbab6813`) · 37866720324 (`d23c0deb`) | 2026-10-09 |
| saas-acceptance-hardening | Cứng hoá ops `saas-acceptance`: chặn chiếm mã `cdt-nghiem-thu`, loại workspace thử khỏi buồng lái (trước là MM-ACC-01) | P0 | DONE | DONE (follow-up MM-FU-696) | #696 | deploy 37829126099 (`6883bfbf`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| ops-signals-check | Ops chỉ đọc `ops-signals-check`: chứng minh 8 tín hiệu O1–O8 chạy trên production | P0 | DONE | DONE (chỉ script, đã chạy thật 3 lượt) | #710 | run 37853956678 · 37860619173 · 37867472656 — PASS 9 × 8, 0 ô hỏng | 2026-10-09 |
| acceptance-login-recorder | Nghiệm thu B1: lượt sai mật khẩu đi qua đúng đường ghi `platform_auth_failures` (chứng minh O1 luồng LOGIN) | P0 | DONE | DONE | #711 | deploy 37860758200 (`d23c0deb`); `ops-signals-check` run 37867472656 thấy LOGIN / BAD_PASSWORD | 2026-10-09 |

### 9.2 Đang mở

#### acceptance-signal-drills
- TITLE: Nghiệm thu dựng sự cố có kiểm soát cho O2–O8 trên workspace thử (chứng minh tín hiệu PHÁT HIỆN đúng)
- OWNER: Integration Lead · PRIORITY: P0 · STATUS: DEPLOYED · CLASS: STILL REQUIRED (Launch Gate §4)
- BRANCH / PR: #724 → `bcad9350` (chạm `lib/saas/acceptance.ts` ⇒ cần deploy, không phải chỉ-script)
- DEPENDENCIES: saas-ops-signals, ops-signals-check (DONE) · BLOCKERS: — (deploy `50293da6` đã lên)
- DONE: mã + bài kiểm. Giới hạn đã biết: dựng sự cố CHỈ chứng minh được **O6**; O2–O5 · O7 · O8 là **CHƯA ĐO ĐƯỢC** (cần kênh nhắn tin thật / AI trả tiền / thao tác phá huỷ) ⇒ MM-FU-724
- REMAINING: `saas-acceptance --apply --drills` → O6 lên ✅ trong `LAUNCH_GATE.md`
- ACCEPTANCE_CRITERIA: run ops có vết cho O6 PHÁT HIỆN đúng sự cố dựng sẵn
- PRODUCTION_EVIDENCE: production `50293da6` (deploy 37886395475, `/api/health` khớp) — hậu kiểm riêng CHƯA · NEXT_ACTION: `verify --sha=50293da6` → đóng trong sổ `/tech` rồi `--apply --drills` · LAST_UPDATED: 2026-10-09

#### MM-ACC-02 — Tài khoản kiểm thử production
- TITLE: 1 người vận hành nền tảng kiểm thử (hoặc smoke ký phiên ngắn hạn phía máy chủ) · 1 Page Facebook kiểm thử
- OWNER: Chủ shop (quyết định QUYỀN — AGENTS §7) · PRIORITY: P1 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DONE: khách EXTERNAL thử do `saas-acceptance` tạo · REMAINING: tài khoản người vận hành thử (đề xuất: không tạo, dùng phiên ký ngắn hạn như `scripts/smoke.ts`)
- NEXT_ACTION: chủ shop chọn · LAST_UPDATED: 2026-10-08

#### MM-OPS-01 — Continuous SaaS Auditor (AU-2 → AU-8)
- TITLE: Kiểm toán SaaS liên tục: rò dữ liệu nội bộ · quyền · cách ly tổ chức · tiền chưa khớp (sứ mệnh `saas-auditor`)
- MISSION_ID gốc: `saas-auditor` · OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DONE: thiết kế `docs/saas/auditor/DESIGN.md` (#662) · BLOCKERS: ngưỡng A4 · A8 · A10 · A14 · A16 chủ shop chưa khai
- REMAINING: AU-2 danh mục phép kiểm → AU-8 · NEXT_ACTION: sau Launch Gate · LAST_UPDATED: 2026-10-08

#### MM-OPS-02 — Sao lưu CSDL NHÀ ra ngoài máy (Google Drive) vẫn hỏng
- TITLE: CSDL nhà không lên Drive 15 GB (~9,9 GB là tệp riêng của chủ shop); bản trên VPS + PITR vẫn tốt
- OWNER: Chủ shop · PRIORITY: P1 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DEPENDENCIES: backup-drive-trash (DONE) · BLOCKERS: chọn dọn Drive · Google One · tài khoản Google riêng · hay giảm hạn giữ (giờ 48→24, tay 3→1)
- DONE: lượt sao lưu 23:04 giờ VN gần nhất: dọn thùng rác 109 MB, 7 CSDL tổ chức đẩy OK
- REMAINING: CSDL nhà FAILED (Drive đầy) — một lượt `backup-status` xanh sau quyết định
- PRODUCTION_EVIDENCE: lượt sao lưu 23:04 (CSDL nhà FAILED) · NEXT_ACTION: chủ shop quyết · LAST_UPDATED: 2026-10-09

#### MM-SEC-01 — CSP report-only → enforce (F4)
- OWNER: Integration Lead · PRIORITY: P1 · STATUS: BACKLOG · CLASS: STILL REQUIRED (rủi ro lớn #1 «không có CSP»)
- DONE: — · REMAINING: CSP report-only, thu báo cáo, rồi enforce (R3, `middleware.ts`) · LAST_UPDATED: 2026-10-08

#### MM-SEC-02 — Correlation ID xuyên request → audit / events / sổ AI / `sync_runs` (F3)
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED · LAST_UPDATED: 2026-10-08

#### MM-SEC-03 — Cô lập tổ chức / bí mật / token page có bằng chứng production (Launch Gate S1–S3)
- OWNER: Integration Lead · PRIORITY: P0 · STATUS: VERIFYING · CLASS: STILL REQUIRED
- DONE: 🟡 CODE — bài tấn công chéo tổ chức chạy mỗi PR, AES-256-GCM token page, lá chắn connectors
- REMAINING: một lượt kiểm production có vết cho S1–S3 (chưa có kịch bản ghi rõ trong Launch Gate)
- NEXT_ACTION: thêm vào lượt `saas-acceptance` hoặc ops riêng · LAST_UPDATED: 2026-10-08

---

## 10. Vietnam Legal Compliance

### 10.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| MM-LEGAL-00 | Hồ sơ tuân thủ pháp luật VN Phase 1 (`docs/legal/*`) | P0 | DONE | DONE (tài liệu — không cần deploy) | #691 | — (tài liệu) | 2026-10-08 |
| MM-LEGAL-00b | Cổng pháp lý rà lại «tuân thủ đúng luật, ma sát thấp nhất»: P0 còn 11 mục | P0 | DONE | DONE (tài liệu — không cần deploy) | #693 | — (tài liệu) | 2026-10-08 |
| legal-registers | Pháp lý L1: sổ phiên bản văn bản · bên xử lý phụ · chuyển xuyên biên giới · khung lưu trữ · sổ AI · cổng pháp lý 5 chiều · quy trình DSR / sự cố | P0 | DONE | DONE (follow-up MM-FU-697a MEDIUM · 697b) | #697 | deploy 37829126099 (`6883bfbf`) hậu kiểm ĐẠT; verify `/tech` 09/10 | 2026-10-09 |
| legal-counsel-pack | Gói câu hỏi gửi luật sư vào kho (`docs/legal/COUNSEL_PACK.md`): ba câu chặn ra mắt + sự cố log 24/09, mỗi câu có ô YES / NO / CONDITIONS | P0 | DONE | DONE (tài liệu) — thay MM-REC-23 | #704 | tài liệu; verify `/tech` 09/10 | 2026-10-09 |

Readiness pháp lý: `docs/legal/LEGAL_LAUNCH_GATE.md` — LEGAL READY **NOT READY (2,5 / 11 = ~23 %, sau #697)**, trạng thái chung
**WAITING_FOR_LEGAL_COUNSEL**.

### 10.2 Đang mở

#### legal-acceptance
- TITLE: Pháp lý L2 — sổ chấp thuận văn bản (phiên bản · băm · mốc · tài khoản · workspace) ghi ở backend lúc đăng ký, không checkbox (M-ACCEPT, LEGAL P1-6)
- OWNER: Chủ shop (đã tạm dừng) · SESSION/AGENT: `wt-legal-acceptance`
- PRIORITY: P1 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED (chủ shop TẠM DỪNG — WAITING_FOR_LEGAL_COUNSEL; mở lại khi luật sư trả lời hoặc chủ shop mở lại)
- BRANCH: `feat/legal-acceptance` (cây có thay đổi chưa commit ở `db/schema.ts`, `drizzle/`, `lib/onboarding/*`) · ảnh chụp `wip/legal-acceptance` @ `43c19ff9`
- REMAINING: khi mở lại — migration mới (va số với #692 / #631), bài kiểm · LAST_UPDATED: 2026-10-09

#### MM-LEGAL-01 — Câu hỏi luật sư G-1 → G-11 (dịch vụ xử lý DLCN, DPIA, xuyên biên giới, TMĐT, ví điện tử, NĐ 333…)
- OWNER: Chủ shop + luật sư · PRIORITY: P0 · STATUS: BLOCKED_EXTERNAL · CLASS: STILL REQUIRED
- BLOCKERS: chưa có ý kiến luật sư (LEGAL P0-1 · P0-2 · P0-3 · P0-7 · P0-10 ❓ / ❌)
- REMAINING: luật sư trả lời; nộp hồ sơ DPIA (Mẫu 10), hồ sơ xuyên biên giới X1–X5 (+X9)
- ACCEPTANCE_CRITERIA: `LEGAL_LAUNCH_GATE.md` §2 mọi P0 ✅ / ⛔, không ❓ · NEXT_ACTION: chủ shop gửi câu hỏi cho luật sư · LAST_UPDATED: 2026-10-08

#### MM-LEGAL-02 — Công bố AI ở lớp giao diện (M-AI-DISCLOSE-UI, cơ chế 1 — LEGAL P0-4)
- OWNER: Integration Lead · PRIORITY: P0 · STATUS: READY · CLASS: STILL REQUIRED (CĐ NONE, đợt 1 TECH_HANDOFF_LEGAL)
- REMAINING: tên hiển thị + greeting / tiêu đề; bỏ lời nhắc che giấu (`engine.ts`, `followup.ts`, `config.ts`, `app/chat/page.tsx`)
- NEXT_ACTION: giao sau lô Launch hiện tại · LAST_UPDATED: 2026-10-08

#### MM-LEGAL-03 — Một dòng công bố AI đầu hội thoại mới (M-AI-DISCLOSE-LINE, cơ chế 2) + đo A/B
- OWNER: Chủ shop (duyệt câu chữ — [CHỜ F]) · PRIORITY: P0 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED · LAST_UPDATED: 2026-10-08

#### MM-LEGAL-04 — DPA là phụ lục Điều khoản (M-DPA-ANNEX — LEGAL P0-5)
- OWNER: Chủ shop + luật sư ([CHỜ F + G]) · PRIORITY: P0 · STATUS: BLOCKED_EXTERNAL · CLASS: STILL REQUIRED · LAST_UPDATED: 2026-10-08

#### MM-LEGAL-05 — Xuất hoá đơn đúng khi thu tiền; giá công bố nói rõ thuế (LEGAL P0-11)
- OWNER: Chủ shop + kế toán (bằng chứng loại E) · PRIORITY: P0 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DONE: `tax_mode = UNDECLARED` · REMAINING: kế toán chốt cách xuất, chọn nhà cung cấp HĐĐT (PL-2 tích hợp sau) · LAST_UPDATED: 2026-10-08

#### MM-LEGAL-06 — Đợt 1 kỹ thuật CĐ NONE còn lại: M-TRIAL-CONSISTENCY · M-PRIVACY-THIRD-PARTIES · M-LOGIN-LOG · M-INVARIANT-CREDIT · M-OBSERVE
- TITLE: số công bố khớp mã (dùng thử 7 / 14, tên VPS) · chính sách nêu đủ bên thứ ba · nhật ký đăng nhập ≥ 12 tháng · bài kiểm bất biến tín dụng · đo production chỉ đọc
- OWNER: Integration Lead · PRIORITY: P1 · STATUS: READY · CLASS: STILL REQUIRED (LEGAL P1-1 · P1-2 · P1-3 · P1-13; M-PRIVACY-THIRD-PARTIES có thể đã nằm một phần trong legal-registers — kiểm khi nhánh đó đẩy lên)
- NEXT_ACTION: cắt thành PR nhỏ sau legal-registers · LAST_UPDATED: 2026-10-08

#### MM-LEGAL-07 — Đợt 3 backend (P1 trong 90 ngày sau khách đầu): M-CONSENT · M-OPTOUT · M-AI-REG · M-RETENTION · M-INCIDENT (bảng) · M-TAX-CATEGORY · M-DSR (tự phục vụ)
- OWNER: Integration Lead · PRIORITY: P1 · STATUS: BACKLOG · CLASS: STILL REQUIRED (M-RETENTION cần số do chủ shop + luật sư + kế toán điền) · LAST_UPDATED: 2026-10-08

#### MM-LEGAL-08 — Đợt 4 chờ luật sư / chủ sở hữu: M-PHONE-AUTH · M-ECOM-DISCLOSURE · M-OFFSITE-VN; bộ phận bảo vệ DLCN (P1-4); chính sách khiếu nại (P1-5); MFA người vận hành (P1-10)
- OWNER: Chủ shop + luật sư · PRIORITY: P1 · STATUS: BLOCKED_EXTERNAL · CLASS: STILL REQUIRED · LAST_UPDATED: 2026-10-08

#### MM-LEGAL-09 — Mục DEFER của pháp lý
- TITLE: checkbox đồng ý ở `/start` · M-ALERT-MINIMIZE (che SĐT trong tin đơn) · M-PROMPT-MIN · `/platform/compliance` · trang bên xử lý phụ động
- OWNER: Chủ shop · PRIORITY: P3 · STATUS: DEFERRED · CLASS: DEFERRED (lý do + điều kiện mở lại theo `LEGAL_LAUNCH_GATE.md` §4) · LAST_UPDATED: 2026-10-08

---

## 11. HSLC (khách thương mại đầu tiên) · quảng cáo / CAPI

### 11.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| hslc-prepaid-ai | HSLC dùng AI dùng chung trả trước: nạp QR như khách, đồng hồ khách AI | P1 | DONE | DONE | #674 | run 37772436572; ops kích hoạt run 37799525447 (tài khoản nhận đã khai, cờ Số dư AI BẬT, số dư dương) | 2026-10-09 |
| org-ai-platform-cutover | Ops `org-ai-cutover`: kiểm khoá AI + chuyển AI Bán hàng sang AI dùng chung | P1 | DONE | DONE (công cụ); lượt `--apply` cho HSLC = MM-HSLC-01 (DONE) | #659 #667 | run 37772436572 | 2026-10-08 |
| cutover-unpriced-tolerance | `org-ai-cutover`: bỏ phần nhỏ token model chưa có giá khỏi phép cân giá, in tên model chưa có giá (tử số tính trên TOÀN BỘ token — phía an toàn) | P1 | DONE | DONE (chỉ script, đã chạy thật) | #699 | ops run 37829090945 (chuyển khoá HSLC thành công) | 2026-10-09 |
| MM-HSLC-00 | HSLC tự phục vụ: mẫu thực phẩm, nhập SP, chatbot, báo nhóm; đơn tay · GTC · ads; bot im lặng / tin đơn nhanh | P1 | DONE | DONE | #408 #499 #500 #501 #502 #570 #575 | đã deploy | 2026-10-05 |
| MM-HSLC-01 | Chuyển HSLC sang khoá AI dùng chung (`org-ai-cutover hslc-hmt-shop --apply`): trả trước 590 ₫ / khách AI qua Số dư | P1 | DONE | DONE (cảnh báo trước khi cạn credit nhà cung cấp = MM-REC-14) | #659 #667 #699 | ops run 37799525447 · 37829090945 (chuyển 09/10 02:04 VN) · 37829221110 (dò sau chuyển OK) | 2026-10-09 |
| platform-key-project-probe | Dò số project Google của khoá AI nền tảng (chỉ đọc, không in khoá) + mã lý do của `org-ai-cutover` | P1 | DONE | DONE (chỉ script; đã chạy thật — phép dò trả UNAVAILABLE ⇒ MM-REC-38) | #694 | ops run 37819643201 | 2026-10-09 |

### 11.2 Đang mở

#### MM-HSLC-02 — Cấu hình danh mục HSLC: quy cách 0,5 kg, bảng giá sỉ mặc định, hai công tắc bot
- OWNER: Chủ shop / HSLC (thao tác trên UI — ops ghi hộ CSDL tổ chức khách bị chặn) · PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DONE: mã #677 / #685 · REMAINING: HSLC tự cấu hình theo hướng dẫn · LAST_UPDATED: 2026-10-08

#### MM-ADS-01 — Đơn chốt trong Messenger tự gửi Purchase sang Meta (Conversions API)
- OWNER: phiên khác (`wt-hslc-sku`) · PRIORITY: P2 · STATUS: DEPLOYED · CLASS: STILL REQUIRED (chưa hậu kiểm; không thuộc lô Launch)
- BRANCH: `claude/meta-capi-chot-don` · PR: #695 → `1b057829` (gộp 08/10 18:10Z)
- PRODUCTION_EVIDENCE: deploy 37822211552 (production `1b057829`) — chưa có sự kiện Purchase thật
- REMAINING: cài kết nối `meta-capi-org` cho HSLC (MM-REC-06) rồi kiểm một sự kiện thật
- NEXT_ACTION: MM-REC-06 · LAST_UPDATED: 2026-10-09

---

## 12. Tech Control Plane `/tech` · điều phối · automated audit / optimization · pipeline

### 12.1 Đã xong

| MISSION_ID | TITLE | P | STATUS | CLASS | PR | PRODUCTION_EVIDENCE | LAST_UPDATED |
|---|---|---|---|---|---|---|---|
| ai-tech-room | AI Tech Room — nền điều phối nhiều worker | P3 | DONE | DONE | #592 #594 #597 | không đổi mã chạy | 2026-10-06 |
| tech-lead-delivery-v2 | Tech Lead một cửa + sổ điều phối + đường giao hàng V2 | P3 | DONE | DONE | #601 #605 | run 37444778809 | 2026-10-06 |
| deploy-reuse-wait | Deploy dùng lại CI không bỏ cuộc vì danh sách rỗng | P3 | DONE | DONE | #606 | run 37459821433 | 2026-10-06 |
| migration-release | Nhả số migration giữ chỗ | P3 | DONE | DONE | #609 | công cụ điều phối | 2026-10-06 |
| tech-control-plane | Company AI Tech Control Plane trên `/tech` (Pha 1) | P3 | DONE | DONE | #623 | run 37531822071 | 2026-10-06 |
| tech-control-plane-workers | `/tech` Pha 2–6: worker headless, hàng đợi lease, chính sách R0–R4 | P3 | DONE | DONE | #629 | run 37568481637 (0 worker đăng ký) | 2026-10-07 |
| fix-consistency-hen-gio | Gỡ bom hẹn giờ bài kiểm nhất quán chi phí | P0 | DONE | DONE | #643 | run 37664556049 | 2026-10-07 |
| docs-revenue-os-status-0810 | Bản đồ AI Revenue OS (`docs/revenue-os/MASTER_MISSION_STATUS.md`) | P3 | DONE | DONE | #660 | tài liệu | 2026-10-08 |
| docs-saas-platform-design | Thiết kế R0: OVERAGE · Auditor · RISK_SCALE · AI_COST_WORKLOAD | P1 | DONE | DONE | #662 | tài liệu | 2026-10-08 |
| docs-saas-product-design | Thiết kế R0: INBOX_V2 · ORDER_CANDIDATE · HELP_CENTER · SHELL_AUDIT | P1 | DONE | DONE | #663 | tài liệu | 2026-10-08 |
| product-excellence-baseline | Scorecard 16 chiều (36/100) + backlog 29 cơ hội + TOP 5 | P2 | DONE | DONE | #668 | tài liệu | 2026-10-08 |
| launch-gate | Launch Gate khách trả tiền đầu tiên (nguồn readiness) | P0 | DONE | DONE | #678 | tài liệu | 2026-10-08 |
| launch-gate-r2 | Launch Gate: mục Quan sát O1–O8, chấm lại 35 % | P0 | DONE | DONE | #687 | tài liệu (trong 4dbd864a) | 2026-10-08 |
| saas-e2e-customer | E2E như khách ngoài sau 4 PR SaaS | P0 | DONE | SUPERSEDED — thay bằng `saas-acceptance-smoke` (#690) + saas-acceptance-hardening (#696); phần tiếp quản / hạn mức / kênh Meta chưa có trong ops ⇒ ghi ở REMAINING của saas-acceptance-smoke khi mở rộng | — | — | 2026-10-09 |
| master-mission-registry | Sổ sứ mệnh tổng + checkpoint bền (tệp này + `CURRENT_CHECKPOINT.md`) | P1 | DONE | DONE (tài liệu) | #698 | tài liệu; verify `/tech` 09/10 | 2026-10-09 |
| registry-refresh-0909 | Làm mới sổ 09/10 sáng sau lô #682–#700: RECOVERED / LOST WORK + bảng tốc độ (trước là MM-TECH-04) | P1 | DONE | DONE (tài liệu) | #702 | tài liệu; verify `/tech` 09/10 | 2026-10-09 |
| launch-gate-r3 | Launch Gate r3: bằng chứng production sau nghiệm thu PASS 4/4 (60 %, 9 / 41 PROD) | P0 | DONE | DONE (tài liệu) | #707 | tài liệu; verify `/tech` 09/10 | 2026-10-09 |
| launch-gate-r4 | Launch Gate r4: O1 ✅ bằng sự cố dựng sẵn hai luồng; O2–O8 tính được trên production — 25 / 41 = 61 %, 10 / 41 PROD, NOT READY | P0 | DONE | DONE (tài liệu) | #723 | tài liệu; verify `/tech` 09/10 | 2026-10-09 |
| hide-internal-429-flake | Bài kiểm hộp thư khách thôi đỏ ngẫu nhiên vì UUID chứa «429» | P3 | DONE | DONE (chỉ bài kiểm) | #709 | trong production `dbab6813`; verify `/tech` 09/10 | 2026-10-09 |

### 12.2 Đang mở

#### tech-worker-onboarding
- TITLE: Cài worker `/tech` một nút cho chủ shop không kỹ thuật
- OWNER: Chủ shop (CRITICAL — chủ shop tự gộp) · SESSION/AGENT: `wt-worker-onboard`
- PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED (Launch Gate §7: POST-LAUNCH)
- BRANCH: `feat/tech-worker-onboarding` @ `c8c3a272` (10 commit trước main) · PR: #631
- BLOCKERS: chủ shop gộp; migration 0236 va số với #692 (ai gộp sau thì `npm run migration:renumber`); review mất hiệu lực khi có commit mới
- NEXT_ACTION: chủ shop quyết · LAST_UPDATED: 2026-10-08

#### registry-reconcile-0910
- TITLE: Đối chiếu sổ + checkpoint 09/10 trưa sau lô #705–#727 (nguồn: số đo Integration Lead, `git log origin/main`, `/api/health`, bàn giao Fable Round 2)
- OWNER: Integration Lead · SESSION/AGENT: worker docs (`wt-registry-reconcile`) — việc AUDIT duy nhất đang mở
- PRIORITY: P1 · STATUS: PR_READY · CLASS: STILL REQUIRED
- BRANCH: `docs/registry-reconcile-0910` · PR: — (worker không mở PR) · NEXT_ACTION: Integration Lead mở PR tài liệu · LAST_UPDATED: 2026-10-09

#### pipeline-upgrade
- TITLE: CI theo phạm vi ảnh hưởng · gộp deploy · quan sát · rollback
- OWNER: Integration Lead · PRIORITY: P3 · STATUS: BACKLOG · CLASS: STILL REQUIRED · LAST_UPDATED: 2026-10-07

#### tech-cloud-pool
- TITLE: Bể thực thi Claude Cloud: gói việc + prompt sinh sẵn, không secret, không merge / deploy
- OWNER: Integration Lead · PRIORITY: P3 · STATUS: BACKLOG · CLASS: STILL REQUIRED · LAST_UPDATED: 2026-10-07

#### MM-TECH-01 — Thang rủi ro hợp nhất (RS-1 → RS-4)
- OWNER: Integration Lead (RS-1, RS-4) · Chủ shop (RS-2, RS-3 là R4) · PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- BLOCKERS: `docs/saas/RISK_SCALE.md` §7 (`lib/billing/` HIGH hay CRITICAL; ai gộp PR xác thực; `.ai/config.json` lên R4) · LAST_UPDATED: 2026-10-08

#### MM-TECH-02 — Ô PRODUCT EXCELLENCE trên `/tech` (thiết kế ở #668)
- OWNER: Integration Lead · PRIORITY: P3 · STATUS: BACKLOG · CLASS: STILL REQUIRED · LAST_UPDATED: 2026-10-08

#### MM-TECH-03 — Dọn ~190–218 cây làm việc đã gộp
- OWNER: Chủ shop (dặn 06/10 CHƯA dọn) · PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED (rủi ro va chạm phiên — MASTER_MISSION_STATUS rủi ro 4) · LAST_UPDATED: 2026-10-08

---

## 13. Builder Platform · vertical · lộ trình sản phẩm dài hạn

| MISSION_ID | TITLE | P | STATUS | CLASS | Ghi chú | LAST_UPDATED |
|---|---|---|---|---|---|---|
| MM-PLAT-00 | ERP Builder Platform Phase 0 → 12 + Commercial Pilot Readiness | P3 | DONE | DONE | `docs/platform/current-execution-state.md`: READY FOR CONTROLLED PILOT; workstream ĐÓNG cho tính năng từ 01/10 | 2026-10-01 |
| MM-PLAT-01 | Smart roadmap Chốt Đơn A1–D3 (`docs/productization/CHOTDON_SMART_ROADMAP.md`) — cứu khách để SĐT, nhắc theo level, điểm chốt, chấm rủi ro, cảnh báo bom hàng, chia ca, TikTok / Instagram… | P3 | DEFERRED | DEFERRED (lý do: đóng băng phạm vi Launch Sprint; một số mục đã có nền — C5 PWA #581, A4 Copilot; điều kiện mở lại: Launch Gate ĐẠT) | đề xuất 06/10 | 2026-10-06 |
| MM-PLAT-02 | Cơ hội PX-20 · PX-24 · PX-26 · PX-27 · PX-28 · PX-29 (Simulator, «wow», nút «?», gói AI giá vào / TikTok, chuyển từ Pancake / Sapo, giới thiệu khách) | P3 | DEFERRED | DEFERRED (Product Opportunity Backlog giữ; mở lại sau Launch Gate) | `docs/product-excellence/OPPORTUNITY_BACKLOG.md` | 2026-10-08 |
| MM-PLAT-03 | Thương hiệu riêng `<tên>.chotdontudong.com` cho chat web (hiện `<tên>.erp.vnxcommerce.com`) | P3 | DEFERRED | DEFERRED (Launch Gate §8: việc sau ra mắt; kéo theo LEGAL PL-6) | — | 2026-10-08 |

---

## 13b. Việc khôi phục từ ghi nhớ phiên + nhánh (chưa có mission `/tech`)

Nguồn: ghi nhớ các phiên (`memory/*.md`, chỉ là bằng chứng phụ) đối chiếu lại với GitHub. Mục nào GitHub cho thấy đã gộp thì
KHÔNG đưa vào đây (đã kiểm: #522 · #535 · #538 · #551 · #555 · #515 · #426 · #545 · #642 đều đã gộp). Mỗi dòng là một mission
gọn; trường không ghi = «—». OWNER «Chủ shop» = việc cần con người bấm / quyết.

| MISSION_ID | Việc | P | STATUS | CLASS | Nguồn / PR liên quan | NEXT_ACTION |
|---|---|---|---|---|---|---|
| MM-REC-01 | Tổ chức cũ có thương hiệu NULL ⇒ khách rơi vỏ ERP; người vận hành đặt ở `/platform/org/<mã>` «Đổi thương hiệu» (#682 chỉ chữa đường TẠO mới) | P1 | BLOCKED_OWNER | STILL REQUIRED | #582, #682 | đo số tổ chức NULL (chỉ đọc) rồi chủ shop đặt |
| MM-REC-02 | R-17: lá chắn slug `/api/sync` không khớp tên job (lỗi cũ) | P2 | BACKLOG | STILL REQUIRED (kiểm lại còn không) | nen-tang-da-to-chuc-phase1 | kiểm trên `main` |
| MM-REC-03 | Kiểm header `frame-ancestors` của `/chat/embed` trên tên miền con sau deploy | P2 | VERIFYING | STILL REQUIRED | #515 | một lượt curl trên production |
| MM-REC-04 | Tách hẳn app Messenger riêng: `appsecret_proof`, nhận diện echo nhận DANH SÁCH app id | P1 | BACKLOG | STILL REQUIRED | #611 «việc sau» | sau meta-messenger-access |
| MM-REC-05 | Khai redirect OAuth `app.chotdontudong.com` trong app Meta | P1 | BLOCKED_OWNER | STILL REQUIRED (chưa xác nhận đã làm) | #582 | chủ shop xác nhận trong App Dashboard |
| MM-REC-06 | Cài kết nối `meta-capi-org` cho HSLC (dataset ↔ fanpage, System User) sau khi #695 gộp | P2 | BLOCKED_OWNER | STILL REQUIRED | #695 | sau gộp #695 |
| MM-REC-07 | Đăng camp theo tổ chức (#551) cho HSLC: token System User `ads_management`, công tắc đăng, camp thử | P3 | BLOCKED_OWNER | STILL REQUIRED | #551 | HSLC cấp token |
| MM-REC-08 | Tính năng chưa ai chạy thật trên production: mục tiêu lượt mua / giá trị (#376), tải video lên (#411), video editor / studio ảnh / bảng màu (#377 #387 #388 #394), thử lại `thinkingConfig` Gemini 3 (#447) | P3 | VERIFYING | STILL REQUIRED | các PR nêu | một lượt dùng thật có vết |
| MM-REC-09 | Hộp thư M8: việc `SALES_HANDOFF` lên `/work` | P2 | BACKLOG | STILL REQUIRED | #573 #576 #577 | sau Launch Gate |
| MM-REC-10 | Nối kết cục đơn vào Historical Replay + mốc `FIRST_DELIVERED_AI_ORDER` | P2 | BACKLOG | STILL REQUIRED | #522 (đã gộp), nhánh `claude/ai-sales-replay` | sau Launch Gate |
| MM-REC-11 | Khách cũ mua lại cùng hội thoại sau khi bot đã chốt ⇒ chuyển người (giới hạn đã biết) | P2 | BACKLOG | STILL REQUIRED | #450 | sau Launch Gate |
| MM-REC-12 | Webhook Pancake theo từng page chưa kiểm với Pancake thật (có thể phải polling) | P2 | VERIFYING | STILL REQUIRED | #426 | đo trên tổ chức dùng Pancake |
| MM-REC-13 | HSLC: tắt tin báo giá tự động của Pancake / Meta trên page (gây trả lời trùng); bật module tài chính / hàng hoàn + công tắc tự xác nhận; đổi luật «chỉ SĐT ⇒ thành dòng đơn» | P3 | BLOCKED_OWNER | STILL REQUIRED | #570 #575 #526; hslc-08-10 | HSLC / chủ shop quyết |
| MM-REC-14 | Khoá AI nền tảng đi trên tài khoản trả trước Google (sự cố cạn credit 06/10, 07/10); sau khi HSLC chuyển sang khoá nền tảng (MM-HSLC-01) mọi bot phụ thuộc một nguồn credit — phần «cảnh báo trước khi cạn» của PX-01 CHƯA có | P1 | BACKLOG | STILL REQUIRED (khoá riêng HSLC không còn được gọi ⇒ vế «hai khoá chung tài khoản» hết nghĩa) | #603, PX-01 | thiết kế cảnh báo số dư nhà cung cấp |
| MM-REC-15 | Bot nhà nghe ghi âm chưa thử ghi âm thật (token âm thanh tính giá chữ); cảnh báo phản hồi chậm theo nhân viên | P3 | BACKLOG | STILL REQUIRED | #480 | — |
| MM-REC-16 | Phần thấp của #689 | P2 | DONE | DUPLICATE — chuyển thành MM-FU-689 | #689 | — |
| MM-REC-17 | `ERP_GITHUB_DISPATCH_TOKEN` mất sau deploy `reset_env` — thêm vào `deploy-vps.yml` | P2 | BACKLOG | STILL REQUIRED (kiểm lại) | khoa-dispatch-github | kiểm `deploy-vps.yml` trên `main` |
| MM-REC-18 | Bật merge queue cho `main` (đổi ruleset) | P3 | BLOCKED_OWNER | STILL REQUIRED | luot-mo-trang-pr338 | chủ shop quyết |
| MM-REC-19 | Sau ~12/10: liệt kê trang 0 lượt / ít lượt mở, hỏi chủ shop từng trang | P3 | DEFERRED | DEFERRED (điều kiện: đủ dữ liệu từ 28/09, mốc ~12/10) | #338 | ~12/10 |
| MM-REC-20 | Trạm chuyển Telegram (Cloudflare Worker + biến GitHub) khi VPS bị chặn Telegram | P2 | BLOCKED_OWNER | STILL REQUIRED | #445 | chủ shop tạo Worker |
| MM-REC-21 | Tiến trình lạ giữ khoá vòng đời VPS ~02:15–02:50 VN | P3 | BACKLOG | STILL REQUIRED (chưa xác minh) | deploy-smoke-giu-khoa | đo log |
| MM-REC-22 | Chậm cấu trúc: `getBusinessBrief` ~104 truy vấn, `/operations` · `/orders` · `/work/settings` · `/chatbot` (Commercial C1 #13) | P2 | BACKLOG | STILL REQUIRED (đo median 3–5 lượt trước — số đo do `inbox-perf-probe` lấy) | do-hieu-nang-erp | sửa sau khi `inbox-perf-probe` có số |
| MM-REC-23 | `docs/legal/COUNSEL_PACK.md` CHỈ nằm trên đĩa ở `wt-legal-compliance` (chưa commit) | P0 | DONE | NO LONGER NEEDED — đã vào kho ở #704 (legal-counsel-pack) | #704 | — |
| MM-REC-24 | Sự cố log Actions 24/09 chưa được đánh giá theo nghĩa vụ báo 72 giờ | P0 | BLOCKED_EXTERNAL | STILL REQUIRED (LEGAL P0-8) — câu hỏi đã vào `COUNSEL_PACK.md` (#704), chờ luật sư | legal-compliance-phase1, #704 | chủ shop gửi gói cho luật sư (MM-LEGAL-01) |
| MM-REC-25 | ĐVVC tự chủ: đăng ký J&T; vận đơn thật đầu tiên mỗi hãng + khổ tem A6/A7; chăm sóc + đối soát COD cho GHN / GHTK | P3 | BLOCKED_OWNER | STILL REQUIRED | #545 #556 #566 | chủ shop |
| MM-REC-26 | Lọc nhiều đơn POS (`o_c_i`) chưa kiểm; định mức vải chỉ ở localStorage | P3 | VERIFYING | STILL REQUIRED | #369 | — |
| MM-REC-27 | Ca CSKH chưa có đường giao tự động bằng máy | P3 | BACKLOG | STILL REQUIRED | #332 | — |
| MM-REC-28 | `/cod` in «0 ₫ / chốt chưa rõ» với bảng kê tải tay | P2 | BACKLOG | STILL REQUIRED | #246 | — |
| MM-REC-29 | Company OS: công tắc chủ shop (duyệt thiết kế, approval v2, TTL 72 h, đồng bộ model-registry, luật QC) | P3 | BLOCKED_OWNER | STILL REQUIRED | #264–#329 | chủ shop |
| MM-REC-30 | ERP vận hành chờ chủ shop: SePay đẩy số dư (ngân sách đặt hàng #475), trần gửi tin hàng loạt (#294), webhook nhóm quản lý (#227 / #236), «Định giá phiếu nhập» cho phiếu giá 0 (#277) | P3 | BLOCKED_OWNER | STILL REQUIRED | các PR nêu | chủ shop |
| MM-REC-31 | ERP còn mở không chặn: đo đứt size trên production + nối quảng cáo (#468); ai tạo lô đơn Pancake 15h / 03h (#279); form phiếu nhập còn cho giá 0 (#287, DEFERRED); trần video 50 MB tự đặt (#290) | P3 | BACKLOG | STILL REQUIRED | các PR nêu | — |
| MM-REC-32 | Vertical SaaS (tạm dừng 04/10): bán theo cân, nhắc lịch hẹn tự động, POS nhà hàng, hoa hồng nhiều tầng, Shopee / TikTok (cần pháp nhân), quyết hạ tầng scale-plan, chỉ sao lưu tổ chức ACTIVE | P3 | DEFERRED | DEFERRED (lý do: chủ shop tạm dừng 04/10 + Launch Gate đóng băng; điều kiện: có khách vertical trả tiền) | vertical-saas-factory, #459 | — |
| MM-REC-33 | Lead Hunter khách sỉ: lượt «Bắt đầu quét» tốn tiền — chủ shop bấm, lượt đầu một tỉnh | P3 | BLOCKED_OWNER | STILL REQUIRED | #521 #543 #567 | chủ shop |
| MM-REC-34 | Đăng camp: sửa ngân sách ngày ngay trong bảng camp đang chạy (tiêu tiền thật — phải hỏi) | P3 | BLOCKED_OWNER | STILL REQUIRED | #414 #419 | chủ shop |
| MM-REC-35 | Bật thu phí theo tổ chức / giá add-on (#454 #485, bảng giá cũ `docs/platform/pricing.md`) | P2 | DONE | DUPLICATE — của MM-BILL-02 (bảng giá V1 thay bảng cũ) | #454 #485 | — |
| MM-REC-36 | Số ngày dùng thử 7 (mã) vs 14 (README / tài liệu cũ) | P1 | DONE | DUPLICATE — của MM-LEGAL-06 (M-TRIAL-CONSISTENCY) | #512 #541 | — |
| MM-REC-37 | Cột sổ AI token suy nghĩ / độ trễ / loại việc chờ đánh số lại 0233 | P2 | DONE | NO LONGER NEEDED — đã vào #642 | #642 | — |
| MM-REC-38 | Phép dò số project của khoá AI nền tảng trả UNAVAILABLE ⇒ chủ shop tự xem project của khoá ở trang quản lý khoá API của Google | P2 | BLOCKED_OWNER | STILL REQUIRED | #694 | chủ shop xem một lần |
| MM-REC-39 | «Chỉ bán kèm»: bot báo giá từ quy cách chính (#701) + bot mời thêm món CHỈ bằng câu upsell kèm ảnh menu (#720) | P2 | DEPLOYED | STILL REQUIRED (chưa hậu kiểm riêng; do phiên khác deploy #701 ở `9833d981`, #720 nằm trong production `ef9b302a`) | #701 #720 | phiên sở hữu kiểm một hội thoại thật |

---

## 14. Quyết định của chủ shop đang chặn việc (tổng hợp)

| # | Quyết định | Chặn mission | Nguồn |
|---|---|---|---|
| D1 | Sao lưu Drive đầy: dọn Drive · Google One · tài khoản riêng · giảm hạn giữ | MM-OPS-02 | CHECKPOINT 09/10 |
| D2 | `PLATFORM_SIGNUP_MODE=open` — đóng (chỉ mời) tới khi READY? (khuyến nghị: đóng) | Commercial C1 #4 (CTA trang chủ; #706 đã gộp phần còn lại) | LAUNCH_GATE §8 |
| D3 | Xoá cửa hàng `qa` (khuyến nghị); giữ `hs-thien-nga-test` khi còn giữ Page thử Meta | — | CHECKPOINT |
| D4 | Bộ phân loại quyền chặn giao dịch tiền thật qua ops: chủ shop tự bấm, hoặc thêm quy tắc ở `/permissions` | MM-BILL-02 (MM-HSLC-01 đã DONE) | CHECKPOINT |
| D5 | Meta App Dashboard + App Review | meta-messenger-access, MM-META-* | meta-review-guide |
| D6 | IDENTITY §7 Q1–Q6; sửa OAuth khớp EMAIL | MM-IDENT-01, MM-IDENT-02 | IDENTITY.md |
| D7 | OVERAGE Q1–Q10; chuyển 8 tổ chức legacy → V1 | MM-BILL-01, MM-BILL-02 | OVERAGE.md |
| D8 | Order Candidate §11 Q1 / Q3 / Q4 / Q5 | MM-ORDER-05 | ORDER_CANDIDATE.md |
| D9 | Duyệt page VNX SHADOW → LIVE | saas-a-vnx-runtime, saas-f-legacy-cleanup | OWNERSHIP.md |
| D10 | Kênh hỗ trợ khách; menu vỏ thêm mục; bộ vai trò rút gọn cho `/settings/users` (TUỲ CHỌN — C1 #5 đã đóng nhờ #700) | saas-help-system (H2), MM-UX-03, MM-UX-04 | FINISH_LINE §5, bàn giao Fable 09/10 |
| D11 | Gộp #631 (CRITICAL) | tech-worker-onboarding | CHECKPOINT |
| D12 | Luật sư (G-1…G-11) · kế toán (HĐĐT) · câu chữ công bố AI · DPA | MM-LEGAL-01 → 05, 08, legal-acceptance | LEGAL_LAUNCH_GATE |
| D13 | Tài khoản kiểm thử người vận hành / Page thử | MM-ACC-02 | LAUNCH_GATE §6 |
| D14 | Ngưỡng Auditor A4 · A8 · A10 · A14 · A16; thang rủi ro RS | MM-OPS-01, MM-TECH-01 | auditor/DESIGN.md, RISK_SCALE.md |
| D15 | Dọn cây làm việc cũ | MM-TECH-03 | ai-tech-room |
| D16 | Xác nhận V6 — bản sao khoá bí mật nền tảng đã cất ngoài VPS | — | CHECKPOINT `/tech` 09/10 |
| D17 | Dùng thử 7 ngày (mã) hay 14 (README) | MM-LEGAL-06 | CHECKPOINT `/tech` 09/10 |
| D18 | Xem số project của khoá AI nền tảng (dò tự động UNAVAILABLE) | MM-REC-38 | ops run 37819643201 |
| D19 | Chuẩn bị UI một lần cho E2E (`ACCEPTANCE.md` §3): đặt lại mật khẩu khách thử · `NT-AO-01` 150.000 ₫ + nhập ≥ 10 · bật bot · xuất bản `cdt-nghiem-thu` | saas-acceptance-smoke (D · E `--e2e`), Launch Gate C8–C17 | CHECKPOINT 09/10 |
| D20 | Ngày bật cờ `meta.direct-connect.open` (cần thêm đường bật — MM-FU-712) | kenh-dang-chay-trong-app, MM-FU-712 | bàn giao Fable 09/10 |
| D21 | Mật độ trang dùng chung ERP ↔ vỏ (chữ 10–10,5 px ở Sản phẩm · Đơn · Khách · Phiếu nhập) | MM-UX-01 (phần mật độ) | bàn giao Fable 09/10 |
| D22 | Luật sư rà Chính sách bảo mật / Điều khoản (chữ «token · API · Gemini», «module») | MM-LEGAL-01 | COMMERCIAL_POLISH_BOARD §2 |

---

## 15. RECOVERED / LOST WORK

Đo 08/10 19:25Z (09/10 02:25 VN): `git worktree list` (257 cây) so với nhánh trên remote, PR GitHub, sổ `/tech`. **Chỉ ghi
lại — không đụng cây của phiên khác.** Cây chỉ có tệp tạm / di sản của việc đã gộp không liệt kê từng cái.

### 15.A Nhánh đã đẩy nhưng KHÔNG có PR — ĐÃ GIẢI QUYẾT (09/10 trưa)

Cả sáu nhánh lô Fable đã gộp: platform-viec-hang-ngay-len-dau #714 · erp-a11y-bo-cuc #708 · error-boundary-than-thien #705 ·
trang-chu-su-that-thuong-mai #706 · saas-finish-line-r2 #713 · commercial-sweep #703. Phiên Fable sweep: **WAITING_FOR_NEXT_PRODUCTION_ROUND**
(bàn giao Round 2 cuối ở `claude/commercial-sweep-ban-giao`, PR tài liệu riêng).

### 15.B Cây chỉ có ở cục bộ (commit chưa đẩy / thay đổi chưa commit)

| Cây | Nhánh | Tình trạng | Kết luận |
|---|---|---|---|
| `wt-hslc-sku` | `claude/ban-kem-aov` | commit 09/10 02:23 VN chưa có trên remote, không mission | ĐÃ GỘP #701 (`9833d981`) ⇒ MM-REC-39 DEPLOYED |
| `wt-legal-compliance` | `claude/legal-conversion-first` (đã gộp #693) | `docs/legal/COUNSEL_PACK.md` chưa theo dõi | ĐÃ VÀO KHO #704 ⇒ MM-REC-23 DONE |
| `wt-legal-acceptance` | `feat/legal-acceptance` | 12 tệp sửa + 3 tệp mới chưa commit; ảnh chụp `wip/legal-acceptance` @ `43c19ff9` | legal-acceptance (BLOCKED_OWNER) — ảnh chụp có thể cũ hơn đĩa |
| `wt-saas-l1` · `wt-signup-subscription` | nhánh đã gộp (#639 · #670) | 20 / 3 tệp sửa chưa commit | Di sản sau gộp — chủ cây xác nhận rồi bỏ; không phải việc mở |
| `wt-ai-sales-reliability` · `wt-ai-tech-room` · `wt-ai-usage` · `wt-hop-thu-lich-su` · `wt-hslc-self-service` · `wt-platform*` (5 cây) · `wt-pos` · `wt-reorder` · `wt-replay` · `wt-roadmap` · `wt-vtp` | nhánh không có trên remote, commit không là tổ tiên của `main` | Phần lớn là nhánh đã tích hợp qua nhánh khác (#408 `claude/hslc-tu-phuc-vu`, #592, #599, #607, #644, Builder Platform) — gộp squash nên không còn là tổ tiên | Kiểm từng nhánh trước khi dọn (MM-TECH-03). Riêng `claude/ai-sales-replay` (+1) gắn MM-REC-10 |
| `agent-a5c50a8b…` · `wt-marketing-ai` · `wt-saas-finish-line` | +1 commit chưa đẩy trên nhánh đã gộp (#425 · #196 · #680) | Di sản | Không phải việc mở |

### 15.C PR_READY chưa mở PR
registry-reconcile-0910 (tệp này, `docs/registry-reconcile-0910`).

### 15.D Mission ACTIVE (09/10 trưa)
pancake-counters-remaining · inbox-perf-probe · shell-copy-brand-r3 · registry-reconcile-0910 (audit). tech-worker-onboarding
vẫn chờ chủ shop (#631).

### 15.E Đã gộp, chưa xác nhận trên production
Lô `50293da6` (deploy 37886395475): #721 · #724 · #725 · #726 (có mã chạy) — #727 tài liệu. Deploy trước đó 37871032076 cho
`304bcbcb` HỎNG ở bước release (SSH «Run Command Timeout» khi kéo image; production đứng yên `d23c0deb`, không đổi gì) — đã được
37879275359 (`ef9b302a`) thay thế.

### 15.F Đã deploy, còn thiếu kiểm production
#695 Meta CAPI (chưa sự kiện Purchase thật) · #701 / #720 (MM-REC-39) · nghiệm thu CÓ ĐĂNG NHẬP xác nhận #700 / #712 / #718 ·
#717 mở `/shipments/<id>` của vận đơn COD 0 · #683 xem có vết từng khối của `/platform/customers`.

### 15.G Follow-up / LOW của các review hôm nay (nay là mission)

| MISSION_ID | Việc | P | STATUS | CLASS | PR nguồn | NEXT_ACTION |
|---|---|---|---|---|---|---|
| MM-FU-682 | Bắt buộc trường `commercial` ở mức KIỂU; `moveWorkspaceToAccount` đi qua cùng luật gói / thương hiệu; huỷ thuê bao ERP vẫn giữ workspace `vnx` | P2 | BACKLOG | STILL REQUIRED | #682 | giao khi có slot (#682 đã DONE) |
| MM-FU-696 | `validateRequest` giữ chỗ cho cửa người vận hành; `decideRenewal` không kéo dài phiên ngắn | P2 | BACKLOG | STILL REQUIRED | #696 | giao khi có slot (#696 đã DONE) |
| MM-FU-697a | Bài kiểm `:119` / `:122` gõ cứng phiên bản văn bản (MEDIUM — vỡ mỗi lần sửa văn bản, AGENTS §65: dựng kỳ vọng từ cùng nguồn) | P1 | READY | STILL REQUIRED | #697 | giao ngay sau lô |
| MM-FU-697b | Sổ băm văn bản chỉ ghi thêm; `NOT_NEEDED` đối chiếu cột Loại; `RESERVED_TLDS` thêm `example.*` | P2 | BACKLOG | STILL REQUIRED | #697 | cùng PR với 697a nếu nhỏ |
| MM-FU-700 | Lời mời ở vỏ gán được vai trò tuỳ chỉnh; miễn trừ Module quá rộng; `hostSlug` sau `redirect()` | P1 | IN_PROGRESS | STILL REQUIRED (lời mời gán vai trò = quyền) — một phần đang làm trong `shell-copy-brand-r3`; phần quyền vẫn cần xem lại phạm vi | #700 | tách phần quyền khỏi phần chữ khi PR r3 mở |
| MM-FU-689 | Sàn giữ N bản mới nhất; dọn TRƯỚC khi giữ khoá; che ID thư mục trong tài liệu / `configure-offsite`; dọn qua lớp `gcrypt` | P2 | BACKLOG | STILL REQUIRED (thay MM-REC-16) | #689 | sau MM-OPS-02 |
| MM-FU-683 | Một tài khoản mang hai lý do cùng mã trên danh sách sức khoẻ | P2 | BACKLOG | STILL REQUIRED | #683 | giao khi có slot (#683 đã DONE) |
| MM-FU-692a | `mark_declined` cần câu POSTWRITE; `ORDER_VALIDATION` nhiễu (quá nhiều tín hiệu không phải lỗi) | P2 | BACKLOG | STILL REQUIRED | #692 | giao khi có slot (#692 đã DONE) |
| MM-FU-692b | **Hai nguồn sức khoẻ** (#683 danh sách khách vs gương `platform_org_health` của ops-signals) phải về MỘT nguồn — không để hai màn nói hai điều | P1 | BACKLOG | STILL REQUIRED (AGENTS §8.12 «logic chung không copy sang từng page») | #683 · #692 | cả hai đã DONE trên production ⇒ thiết kế một nguồn là việc P1 kế tiếp |
| MM-FU-712 | Không có đường UI / ops nào bật cờ `meta.direct-connect.open` — cổng nối thẳng Facebook chỉ mở được bằng sửa CSDL | P2 | BACKLOG | STILL REQUIRED (ngày bật = D20) | #712 | thêm công tắc người vận hành hoặc ops `set-setting` có vết |
| MM-FU-724 | Dựng sự cố chỉ chứng minh được O6; O2–O5 · O7 · O8 «CHƯA ĐO ĐƯỢC» (cần kênh nhắn tin thật / AI trả tiền / thao tác phá huỷ) ⇒ cần CHUẨN BẰNG CHỨNG từ sự cố thật cho Launch Gate | P2 | BACKLOG | STILL REQUIRED (quyết định cách chấm O2–O8) | #724 | viết chuẩn vào `LAUNCH_GATE.md` §4 |
| MM-FU-727a | (C2) `/o/[object]/new` gửi định nghĩa trường bị chặn bởi `viewPermission` xuống client (`new/page.tsx:27-44`) | P2 | BACKLOG | STILL REQUIRED | #727 (bàn giao Fable) | — |
| MM-FU-727b | (C3) `ideas/[id]/page.tsx:25` xác định người đăng bằng email thay vì `users.id` (AGENTS 34) | P2 | BACKLOG | STILL REQUIRED | #727 | — |
| MM-FU-727c | (C2) Chữ lỗi thô: `models/[id]/blocks.tsx:115` · `components/blueprints/install-panel.tsx:197` · `lib/actions/production-topics.ts:127` · import-vtp | P2 | BACKLOG | STILL REQUIRED | #727 | — |
| MM-FU-727d | (C2) Bảng không cuộn ngang: `/platform/products/[key]`, Model 360, lô xưởng, phiếu việc | P2 | BACKLOG | STILL REQUIRED | #727 | — |
| MM-FU-727e | (C3) `/orders/[id]/edit` mở được bằng URL cho đơn đã hoàn (lõi vẫn chặn ghi); `toInt` đọc «1.5» thành 15 | P2 | BACKLOG | STILL REQUIRED | #727 | — |
| MM-FU-727f | (C3) Mã thô trên `/tech` | P2 | BACKLOG | STILL REQUIRED | #727 | — |

### 15.H Lượt dựng 09/10 01:00 (L1–L20) — trạng thái hiện tại

| # | Việc | Nay ở |
|---|---|---|
| L1 | `fix/saas-acceptance-hardening` từng không tồn tại | ĐÃ GỘP #696 (saas-acceptance-hardening, DONE 09/10) |
| L2 | Ba nhánh chỉ trên đĩa: `fix/saas-shell-polish`, `feat/legal-registers`, `claude/erp-a11y-bo-cuc` | #700 · #697 · #708 đều DONE (09/10) |
| L3 | Quét bù Graph · nâng Graph trước 21/01/2027 | MM-META-02, MM-META-03 |
| L4 | CSP · correlation ID | MM-SEC-01, MM-SEC-02 |
| L5 | `idempotency_key` UNIQUE | MM-ORDER-04 |
| L6 | OAuth khớp EMAIL chưa xác minh | MM-IDENT-02 |
| L7 | `/platform` + 9 nút không tên | platform-viec-hang-ngay-len-dau DONE #714 («9 nút không tên» chưa xác nhận trên DOM) |
| L8 | Token chữ / nút / tiền | MM-UX-01 |
| L9 | Đếm khách AI cho tin nhắn lại | MM-INBOX-04 |
| L10 | Revenue Rescue | MM-INBOX-02 |
| L11 | Nợ pilot nền tảng | MM-ORDER-06 |
| L12 | Ops chỉ đọc theo CSDL tổ chức | MM-METRIC-05 |
| L13 | S1–S3 chưa có bằng chứng production | MM-SEC-03 |
| L14 | Đợt kỹ thuật pháp lý | MM-LEGAL-02, MM-LEGAL-06, MM-LEGAL-07 |
| L15 | `COUNSEL_PACK.md` chỉ trên đĩa | ĐÃ VÀO KHO #704 (legal-counsel-pack) — MM-REC-23 DONE |
| L16 | Sự cố log 24/09 chưa đánh giá | MM-REC-24 |
| L17 | Tổ chức cũ thương hiệu NULL | MM-REC-01 |
| L18 | Hai khoá chung tài khoản trả trước | HSLC đã chuyển khoá ⇒ còn vế cảnh báo cạn credit (MM-REC-14) |
| L19 | App Messenger riêng (`appsecret_proof`, echo) · redirect OAuth | MM-REC-04, MM-REC-05 |
| L20 | 30+ việc vận hành / ERP / vertical | MM-REC-06 → MM-REC-34 |

## 16. WIP hiện tại (giới hạn 3 engineering + 1 audit) — 09/10 trưa

| Loại | Việc | Trạng thái |
|---|---|---|
| ENGINEERING 1 | `pancake-counters-remaining` (khối «Khách hàng» trang đơn + bộ lọc đã lưu) | IN_PROGRESS |
| ENGINEERING 2 | `inbox-perf-probe` (đo production, C1 #13) | IN_PROGRESS |
| ENGINEERING 3 | `shell-copy-brand-r3` (C1 #7 + một phần MM-FU-700) | IN_PROGRESS |
| AUDIT | `registry-reconcile-0910` (tệp này) | PR_READY |
| (ngoài WIP) | Deploy 37886395475 lô `50293da6` (#721 #724 #725 #726 #727) | DEPLOYED — chờ verify |

## 17. CRITICAL PATH — P0 còn lại, theo thứ tự

1. **Deploy `50293da6` xong** → `/api/health` + smoke + `verify` ⇒ #721 · #724 · #725 · #726 lên DONE; rồi **`saas-acceptance --apply --drills`**
   ⇒ O6 lên ✅ (acceptance-signal-drills).
2. **Hiệu năng production** (C1 #13): `inbox-perf-probe` + ops smoke `/chatbot` · `/cod` · `/reports/*`.
3. **Vỏ**: C1 #7 chữ kỹ thuật (`shell-copy-brand-r3`); C1 #4 CTA chờ D2.
4. **Kiểm production còn thiếu**: nghiệm thu CÓ ĐĂNG NHẬP xác nhận #700 / #712 / #718 · trang chi tiết của tổ chức KHÔNG dùng Pancake (#725) ·
   `/shipments/<id>` vận đơn COD 0 (#717).
5. **E2E D + E**: chủ shop chuẩn bị UI (D19) ⇒ `saas-acceptance --apply --e2e` ⇒ C8–C17. O2–O5 · O7 · O8 cần chuẩn bằng chứng sự cố thật
   (MM-FU-724). Kèm MM-SEC-03 (S1–S3).
6. **Pháp lý P0**: chủ shop gửi `COUNSEL_PACK.md` (#704) cho luật sư (MM-LEGAL-01, MM-REC-24) · MM-LEGAL-02 công bố AI ở giao diện ·
   MM-LEGAL-03 / 04 / 05 chờ chủ shop / luật sư / kế toán.
7. **Meta**: meta-messenger-access (chủ shop + Meta) → MM-META-01 smoke tài khoản ngoài ⇒ READY FOR FIRST PAYING CUSTOMER.

Readiness (chép nguồn): ENGINEERING **NOT READY — 25 / 41 = 61 %**, **10 / 41** có bằng chứng production (`LAUNCH_GATE.md` 09/10 trưa,
#723) · LEGAL **NOT READY ~23 %**, WAITING_FOR_LEGAL_COUNSEL.

Commercial (bàn giao Fable Round 2, 09/10): **C0 còn 0** (C0 duy nhất đã sửa ở #717). **C1 còn 3**: #7 chữ kỹ thuật vỏ
(`shell-copy-brand-r3`, RUNNING) · #4 CTA đăng ký (D2) · #13 trang chậm (đo production). Đóng theo đối chiếu: #5 (#700 ẩn ma trận quyền ở
vỏ) · #6 (#700) · #8 (#683) · #9 (#682) · lệnh đặt xưởng chưa có giá (#719).

P1 còn lại (theo tác động thương mại): MM-FU-692b (một nguồn sức khoẻ) · MM-FU-697a (MEDIUM) · MM-FU-700 · pancake-counters-remaining ·
inbox-perf-probe · shell-copy-brand-r3 · MM-BILL-01 / 02 / 03 · MM-OPS-02 · MM-SEC-01 · MM-ORDER-04 · MM-META-02 / 03 · MM-IDENT-02 ·
MM-ACC-02 · MM-REC-01 · MM-REC-04 · MM-REC-05 · MM-REC-14 · MM-LEGAL-06 / 07 / 08 · legal-acceptance (BLOCKED_OWNER) ·
registry-reconcile-0910.

Pháp lý (giữ đủ): legal-acceptance · MM-LEGAL-01 → 09 · MM-REC-24. Backlog Tech Lead từ sweep: MM-UX-01 · MM-FU-712 · MM-FU-727a → f.

## 18. Nguồn lệch nhau (đã ghi nhận, Git / PR / production thắng)

Xem `docs/tech/CURRENT_CHECKPOINT.md` §«Lệch nguồn».
