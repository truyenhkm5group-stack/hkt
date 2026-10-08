# MASTER MISSION REGISTRY — Chốt Đơn Tự Động / ERP

> **Nguồn sự thật DUY NHẤT về «việc gì từng được giao, đang ở đâu, còn gì».** Không dựa vào trí nhớ chat.
> Dựng lại 09/10/2026 ~01:00 giờ VN từ: sổ `/tech` (`origin/ai-control/registry`, 96 tệp `mission.*.json` + `CHECKPOINT.md`),
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

**STATUS** (chỉ dùng các giá trị này): `BACKLOG` · `READY` · `IN_PROGRESS` · `PR_READY` · `IN_REVIEW` · `MERGED` · `DEPLOYED` ·
`VERIFYING` · `BLOCKED_EXTERNAL` · `BLOCKED_OWNER` · `DEFERRED` · `DONE`.
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

## 0b. Tổng hợp (đếm tự động từ tệp này lúc dựng, 09/10/2026)

- Tổng số mission: **202** (khối đủ trường + dòng bảng gọn).
- Theo STATUS: `BACKLOG` 41 · `READY` 3 · `IN_PROGRESS` 8 · `PR_READY` 2 · `IN_REVIEW` 2 · `MERGED` 3 · `DEPLOYED` 4 · `VERIFYING` 5 · `BLOCKED_EXTERNAL` 6 · `BLOCKED_OWNER` 33 · `DEFERRED` 12 · `DONE` 83.
- Còn mở (khác `DONE`) theo ưu tiên: P0 **16** · P1 **27** · P2 38 · P3 38.
- Đếm lại: mỗi khối `#### ` lấy `PRIORITY:` + `STATUS:` đầu tiên; mỗi dòng bảng có cột `MISSION_ID` lấy cột `P` + `STATUS`.

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
| saas-signup-subscription | Cửa hàng tự đăng ký có thuê bao dùng thử ngay (F-02) | P0 | DONE | DONE | #670 | run 37744823972, verify PASS c360b7c6 | 2026-10-08 |
| saas-delete-signup-shops | Xoá cửa hàng tự đăng ký cũ bằng ops có chạy thử + sao lưu | P1 | DONE | DONE | #673 | ops run 37771243600 (xoá `kd`, sao lưu trước) | 2026-10-08 |
| saas-v1-plan-migration | Công cụ chuyển tổ chức legacy → giá V1 (chạy thử + nhật ký) | P1 | DONE | DONE | #676 | run 37772436572 — công cụ có, CHƯA chuyển tổ chức nào (xem MM-BILL-02) | 2026-10-08 |
| saas-identity-email-login | P0: khách do admin tạo đăng nhập email + mật khẩu; gửi lại liên kết kích hoạt | P0 | DONE | DONE | #681 | run 37781964748; ops `identity-reconcile` 37786092653 (chạy thử) → 37786400515 (ghi 12, THIẾU 0) | 2026-10-08 |
| saas-identity-followup | Gửi lại form Tạo khách không phát liên kết sai người; mở khoá ghi lại chỉ mục | P1 | DONE | DONE | #684 | run 37786938351 | 2026-10-08 |
| saas-c-shared-identity | Phase C: thiết kế danh tính toàn nền tảng (`docs/saas/IDENTITY.md`) | P3 | DONE | DONE (phần tài liệu; phần mã = MM-IDENT-01) | #617 | tài liệu, trong production 85faea0b | 2026-10-08 |

### 1.2 Đang mở

#### saas-create-customer-correct
- TITLE: LAUNCH BLOCKER — Tạo khách mới đúng mặc định: thương hiệu Chốt Đơn tự đặt, chỉ gói đang bán, nút không khoá im lặng, cài mẫu AI bán hàng như `/start`
- BUSINESS_GOAL: Người vận hành tạo khách trả tiền mà khách không rơi vào vỏ ERP / gói nội bộ / bot im (Launch Gate A1 · A4 · A6)
- OWNER: Integration Lead · SESSION/AGENT: `wt-create-customer`
- PRIORITY: P0 · STATUS: MERGED · CLASS: STILL REQUIRED (chờ deploy + smoke)
- BRANCH: `fix/create-customer-defaults` · PR: #682 → `67647aae` (gộp 08/10 17:07Z, review vòng 2 PASS)
- DEPENDENCIES: — · BLOCKERS: chưa có lượt deploy sau gộp (production đang `4dbd864a`)
- DONE: luật gói + thương hiệu ở tầng ghi chung cho mọi cửa; cài lại mẫu; nút `ConfirmWithReason` không khoá im lặng (thay việc FINISH_LINE handoff #4)
- REMAINING: deploy · smoke tạo khách qua đúng form admin (ops `saas-acceptance --apply` bước A) · nâng A1/A4/A6 trên Launch Gate
- ACCEPTANCE_CRITERIA: khách mới tạo từ `/platform/customers` ⇒ thương hiệu `chotdon`, gói CATALOG đang bán, module `ai_sales`, mẫu AI cài xong; cài mẫu hỏng thì job KHÔNG «Xong»
- PRODUCTION_EVIDENCE: —
- NEXT_ACTION: gộp `fix/saas-acceptance-hardening` → MỘT deploy chung → `saas-acceptance --apply`
- LAST_UPDATED: 2026-10-09

#### MM-ADMIN-01 — Bố cục `/platform` + 9 nút không tên (Commercial PR F)
- TITLE: `/platform` cao 6.223 px, khung Webhook Meta đứng trên bảng tổ chức; 9 nút `outline` khoá không chữ
- BUSINESS_GOAL: Người vận hành thấy ngay khách nào cần xử lý
- OWNER: Integration Lead · SESSION/AGENT: — (đề xuất phiên Fable commercial sweep)
- PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- BRANCH: — · PR: —
- DEPENDENCIES: #682 lên production (chạm `app/(dashboard)/platform/page.tsx`) · BLOCKERS: —
- DONE: — · REMAINING: toàn bộ
- ACCEPTANCE_CRITERIA: bảng tổ chức & sức khoẻ ở màn đầu; 0 nút không tên (harness commercial sweep)
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: chờ deploy #682 rồi giao · LAST_UPDATED: 2026-10-09

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
| saas-l1-hide-internal | Che dữ liệu AI nội bộ khỏi khách (UI + máy chủ) | P0 | DONE | DONE | #639 | run 37654798771 | 2026-10-07 |
| saas-l2-customer-shell | Vỏ app khách Chốt Đơn: 8 mục, mặc định hộp thư, mobile | P1 | DONE | DONE | #638 | run 37664556049 | 2026-10-07 |
| saas-l1-followup | Khách không ghi / tắt khoá AI; che replay · học · ai-builder · USD · go-live | P0 | DONE | DONE | #669 | run 37741568283; Launch Gate S4 ✅ PROD | 2026-10-08 |
| saas-shell-login-loop | Đăng nhập / đăng ký trong vỏ không trang trắng (F-01) | P0 | DONE | DONE | #671 | run 37744823972 | 2026-10-08 |
| saas-finish-line | Finish Line R1: audit admin + vỏ, quick wins (rỗng · chữ kỹ thuật · help · 404 · AI Sales cuộn) | P1 | DONE | DONE | #680 | run 37781964748 | 2026-10-08 |
| saas-shell-gate-redirects | Vỏ không trang trắng khi thiếu quyền / module tắt | P1 | DEPLOYED | DONE (chưa smoke riêng) | #686 | trong production 4dbd864a (run 37800951308) | 2026-10-08 |
| saas-lowtech-ux | UX cho chủ shop ít rành máy: audit + thiết kế | P2 | DONE | SUPERSEDED — thay bằng `docs/saas/SHELL_AUDIT_2026-10-08.md` (#663) + Finish Line R1/R2 + saas-shell-polish + commercial-sweep; phần mã còn lại nằm ở MM-UX-* | — | — | 2026-10-09 |

### 2.2 Đang mở

#### saas-shell-polish
- TITLE: Vỏ Chốt Đơn: `/login` sau đặt mật khẩu đúng thương hiệu, bỏ chữ kỹ thuật còn lộ, `/module-disabled` có ranh giới lỗi, câu `BILLING_LOCKED` theo sản phẩm, trang Nhân viên
- BUSINESS_GOAL: Khách không thấy thương hiệu VNX / chữ kỹ thuật (Launch Gate C3; Commercial C1 #5 #6 #7)
- OWNER: Integration Lead · SESSION/AGENT: `wt-saas-shell-polish`
- PRIORITY: P1 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED
- BRANCH: `fix/saas-shell-polish` — **chưa đẩy lên remote; thay đổi CHỈ nằm trên đĩa (≥ 12 tệp sửa)** · PR: —
- DEPENDENCIES: — · BLOCKERS: —
- DONE: (chưa commit) · REMAINING: commit + push, cổng, PR
- ACCEPTANCE_CRITERIA: sau đặt mật khẩu trên host Chốt Đơn, `/login` dựng thương hiệu Chốt Đơn ngay lượt đầu; danh sách chữ cấm = 0 ở AI Sales / Kết nối / Thiết lập / Nhân viên / Gói
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: chụp `wip/saas-shell-polish` ngay (AGENTS §9) rồi hoàn tất · LAST_UPDATED: 2026-10-09

#### saas-finish-line-r2
- TITLE: Finish Line Round 2: tiêu đề theo menu vỏ (Sản phẩm · Nhân viên · Gói), tỷ lệ hoàn mẫu số 0 in «—», nhãn tính năng API/Webhook thành chữ khách hiểu
- OWNER: Integration Lead · SESSION/AGENT: phiên Fable `code-erp-a4` (`wt-saas-r2`)
- PRIORITY: P2 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED
- BRANCH: `claude/saas-finish-line-r2` @ `db011e27` (đã đẩy, 1 commit, 5 tệp) · PR: —
- DEPENDENCIES: — · BLOCKERS: chưa `handoff` trong sổ `/tech`
- DONE: F-10, F-16 (`pctOrNull`), nhãn tính năng; `docs/saas/FINISH_LINE_R2_2026-10-08.md`
- REMAINING: handoff → PR → cổng → gộp; phần «Round 2 Production Acceptance» sau deploy
- ACCEPTANCE_CRITERIA: tiêu đề trang = tên menu; không «0.0 %» khi mẫu số 0
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: phiên Fable `npm run ai -- handoff` · LAST_UPDATED: 2026-10-08

#### commercial-sweep
- TITLE: Commercial Perfection Sweep — Phase A chỉ đọc: kiểm kê 207 trang + bảng chất lượng thương mại
- OWNER: Integration Lead · SESSION/AGENT: phiên Fable (`wt-sweep`)
- PRIORITY: P2 · STATUS: PR_READY · CLASS: STILL REQUIRED
- BRANCH: `claude/commercial-sweep` @ `8661ddf0` (handoff 08/10 17:32Z) · PR: — (chưa mở)
- DONE: `docs/product/COMMERCIAL_PAGE_INVENTORY.md`, `docs/product/COMMERCIAL_POLISH_BOARD.md`: C0 = 0, C1 14 → 6
- REMAINING: mở PR tài liệu; các lô sửa PR A / B / C / F / G (xem MM-UX-*)
- ACCEPTANCE_CRITERIA: bảng có bằng chứng từng dòng · PRODUCTION_EVIDENCE: — (tài liệu)
- NEXT_ACTION: Integration Lead mở PR · LAST_UPDATED: 2026-10-08

#### trang-chu-su-that-thuong-mai (Commercial PR A)
- TITLE: Trang chủ Chốt Đơn nói đúng sản phẩm: nối Facebook thẳng (Pancake là lựa chọn), bỏ claim tuyệt đối, bỏ «Chi phí AI hiện rõ», FAQ không hứa khoá AI riêng
- OWNER: Integration Lead · SESSION/AGENT: `wt-pr-a`
- PRIORITY: P1 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED
- BRANCH: `claude/trang-chu-su-that-thuong-mai` @ `e17a9224` (đã đẩy, 1 commit) · PR: —
- DEPENDENCIES: quyết định `PLATFORM_SIGNUP_MODE` (CTA dùng thử phụ thuộc chế độ đăng ký) · BLOCKERS: chưa handoff
- DONE: sửa `app/gioi-thieu/page.tsx` + `tests/public-site.test.ts` · REMAINING: handoff → PR → deploy
- ACCEPTANCE_CRITERIA: không claim tuyệt đối; bước nối fanpage nói Facebook trực tiếp; không hứa điều mã không làm
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: handoff · LAST_UPDATED: 2026-10-09

#### error-boundary-than-thien (Commercial PR C)
- TITLE: Lỗi thân thiện: error boundary dashboard + gốc không in `error.message` / `DATABASE_URL`, chỉ mã tham chiếu
- OWNER: Integration Lead · SESSION/AGENT: `wt-pr-c`
- PRIORITY: P1 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED (rò thông tin kỹ thuật cho khách)
- BRANCH: `claude/error-boundary-than-thien` @ `9f5adec3` (đã đẩy, 1 commit) · PR: —
- DONE: `error.tsx` + `tests/error-boundary.test.ts` · REMAINING: handoff → PR → deploy
- ACCEPTANCE_CRITERIA: bài kiểm nguồn không in `DATABASE_URL` / `error.message` cho khách
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: handoff · LAST_UPDATED: 2026-10-09

#### erp-a11y-bo-cuc (Commercial PR G)
- TITLE: ERP: màn «không tìm thấy» có h1; công tắc / ô số / nút biểu tượng có tên (`/work/settings` · `/alerts` · `/inventory/shortage`); `/payroll` không tràn 390 px
- OWNER: Integration Lead · SESSION/AGENT: `wt-pr-g`
- PRIORITY: P2 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED
- BRANCH: `claude/erp-a11y-bo-cuc` — **chưa commit, chưa đẩy (11 tệp chỉ trên đĩa)** · PR: —
- DONE: — (trên đĩa) · REMAINING: commit, push, handoff
- ACCEPTANCE_CRITERIA: `tests/erp-a11y.test.ts` xanh; 0 «nút không tên» ở ba trang
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: chụp `wip/erp-a11y-bo-cuc` · LAST_UPDATED: 2026-10-09

#### MM-UX-01 — Token chữ nhỏ · chiều cao nút · tiền «đ» tay (Commercial PR B)
- OWNER: Integration Lead · PRIORITY: P3 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DONE: số đo ở COMMERCIAL_POLISH_BOARD #16–#18 · REMAINING: ba bậc chữ hợp lệ trong `docs/design-system.md` + bài kiểm cấm `text-[10px]` ở trang khách
- DEPENDENCIES: — · ACCEPTANCE_CRITERIA: bài kiểm quét mã · NEXT_ACTION: sau Launch Gate · LAST_UPDATED: 2026-10-09

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

#### MM-UX-04 — Trang «Nhân viên» trong vỏ: vai trò rút gọn thay ma trận 776–786 ô (F-09)
- OWNER: Chủ shop (AGENTS §7 — đổi quyền) · PRIORITY: P1 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- BLOCKERS: chủ shop quyết bộ vai trò (Chủ shop · Nhân viên bán hàng · Chỉ xem) · DONE: một phần chữ kỹ thuật ở saas-shell-polish
- REMAINING: vai trò rút gọn · ACCEPTANCE_CRITERIA: Launch Gate C19 không còn ghi chú P1 · NEXT_ACTION: hỏi chủ shop · LAST_UPDATED: 2026-10-08

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
| hotfix-messenger-discovery | Kết nối Facebook nói đúng vì sao 0 page; AI hết tiền báo nhóm vận hành | P0 | DONE | DONE | #603 | run 37431030954; log `PERMISSION_NOT_GRANTED` | 2026-10-06 |
| messenger-permission-diag | Phân biệt 7 nguyên nhân nối Page; hồ sơ kỹ thuật App Review | P0 | DONE | DONE | #608 | run 37459821433 | 2026-10-06 |
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
| saas-l4-channels | Kênh kết nối hợp nhất cho khách | P1 | DONE | DONE | #637 | run 37654798771 | 2026-10-07 |
| saas-l3-inbox | Hộp thư hợp nhất + song song Pancake / Meta Direct (0233) | P1 | DONE | DONE | #641 | run 37667608381 | 2026-10-07 |
| sales-human-takeover | Tiếp quản / cho AI tiếp tục trong hội thoại (0231) | P1 | DONE | DONE | #633 | run 37614289468 | 2026-10-07 |
| ai-sales-recovery | Cứu hội thoại khách nhắn mà bot chưa trả lời (chỉ đọc) | P1 | DONE | DONE | #613 | run 37493421549 | 2026-10-06 |
| inbox-composer-templates | Chèn câu mẫu + dòng sản phẩm (giá / tồn ERP) ngay ô soạn | P2 | DONE | DONE | #661 | run 37735795033 | 2026-10-08 |
| inbox-composer-hardening | Ô soạn dùng chung cổng quyền với Gửi, không chèn tồn âm | P1 | DONE | DONE | #666 | run 37741568283 | 2026-10-08 |
| MM-INBOX-00 | Hộp thư khách hiện như Pancake: ảnh, nhãn dán, emoji (#679); lọc nâng cao (#595); đủ lịch sử fanpage (#599); dễ nhìn (#577); gửi ảnh + nhãn + ghi chú (#576); hộp thư người (#573) | P1 | DONE | DONE | #573 #576 #577 #595 #599 #679 | đã deploy | 2026-10-08 |

### 4.2 Đang mở

#### saas-inbox-perf
- TITLE: Hiệu năng hộp thư — đo nền trước (V2-0 / PX-14), tối ưu sau
- OWNER: Integration Lead · PRIORITY: P2 · STATUS: BACKLOG · CLASS: STILL REQUIRED
- DEPENDENCIES: saas-l3-inbox (DONE) · DONE: kế hoạch đo `INBOX_V2.md` §8 · REMAINING: V2-0 số nền p50/p95, rồi V2-7
- ACCEPTANCE_CRITERIA: có số nền trước mọi sửa · NEXT_ACTION: sau Launch Gate · LAST_UPDATED: 2026-10-07

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
| ai-balance-v1 | Số dư AI + nạp QR SePay (ERPNAP), sổ cái chỉ ghi thêm | P1 | DONE | DONE | #644 | run 37697610332 | 2026-10-07 |
| ai-balance-economics | Doanh thu · chi phí · biên Số dư AI trên /platform | P2 | DONE | DONE | #648 | run 37700846133 | 2026-10-08 |
| ai-balance-hardening | Sao kê không nạp hộ; báo hết số dư không nuốt nhau | P1 | DONE | DONE | #650 | run 37709225559 | 2026-10-08 |
| ai-balance-followup | Đảo đúng một khoản trừ; cockpit tính doanh thu Số dư | P2 | DONE | DONE | #653 | run 37714463197 | 2026-10-08 |
| billing-sepay-trust | Thuê bao chỉ tự gia hạn khi SePay ghi đúng tài khoản nhận | P1 | DONE | DONE | #655 | run 37717239217 | 2026-10-08 |
| MM-BILL-00 | Gói Dùng thử in «còn N ngày» thay «—» (FINISH_LINE §5) | P2 | DONE | SUPERSEDED — làm trong #670 | #670 | run 37744823972 | 2026-10-08 |

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
| conversation-delivered-profit | Lãi gộp đã giao theo AI tự bán / AI góp công / Người bán | P2 | DONE | DONE | #646 | run 37684290837 | 2026-10-07 |
| ai-vs-human-profit | AI vs Người theo lãi gộp đã giao + sau chi phí AI | P2 | DONE | DONE | #658 | run 37727378042 | 2026-10-08 |
| MM-KPI-00 | Hiệu quả AI lọc «Hôm nay» / khoảng ngày, đếm đơn như Báo cáo danh nghĩa | P2 | DEPLOYED | DONE | #688 | trong production 4dbd864a | 2026-10-08 |
| MM-KPI-01 | Sổ chỉ số AI Sales (bán chéo, chênh lệch AI − người…) + bán chéo trên đơn đã giao | P2 | DONE | DONE | #563 #564 | đã deploy (04/10) | 2026-10-04 |

### 7.2 Đang mở

#### saas-customer-health
- TITLE: Danh sách / chi tiết khách cho admin thấy sức khoẻ < 30 giây (Messenger · AI · đăng nhập · đơn · hạn mức · vấn đề)
- BUSINESS_GOAL: Launch Gate A7 · A8 · A10 (3/10 mục Admin)
- OWNER: Integration Lead · SESSION/AGENT: `wt-customer-health`
- PRIORITY: P0 · STATUS: IN_REVIEW · CLASS: STILL REQUIRED (Launch Gate §7 ghi «LAUNCH SUPPORT», nhưng thiếu nó thì Admin tối đa 70 % < ngưỡng 90 %)
- BRANCH: `feat/customer-health` @ `e2b6cbf6` · PR: #683 (review vòng 2 PASS; CI xanh ở e2b6cbf6; xung đột với main sau #682)
- DEPENDENCIES: — · BLOCKERS: rebase sau #682 + sửa F1 (`chatOk7d`)
- DONE: mức Nguy cấp · Cần chú ý · Chưa đủ dữ liệu · Khoẻ · Đã dừng; thiếu dữ liệu không bao giờ «Khoẻ»
- REMAINING: rebase, F1, cổng, gộp, deploy, smoke trên `/platform/customers`
- ACCEPTANCE_CRITERIA: A7/A8/A10 lên ✅ PROD bằng một lượt xem có vết
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: worker rebase + F1 → Integration Lead gộp · LAST_UPDATED: 2026-10-09

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
| MM-ORDER-01 | Trang sản phẩm có nút «Thêm mẫu mã» | P2 | DEPLOYED | DONE | #685 | trong production 4dbd864a | 2026-10-08 |
| MM-ORDER-02 | Nhân viên tạo đơn trong hội thoại (không cộng công bot, chống bấm hai lần); đơn tự ghép tỉnh + xã mới | P1 | DONE | DONE | #565 #583 | đã deploy | 2026-10-05 |

### 8.2 Đang mở

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
| backup-drive-trash | Sao lưu ngoài máy: xoá hẳn bản quá hạn, dọn thùng rác chỉ trong thư mục sao lưu, `backup-status` đo Drive | P1 | DEPLOYED | DONE (mã); vấn đề dung lượng còn lại ở MM-OPS-02 | #689 | run 37796789087 (b3a8d74e) | 2026-10-08 |

### 9.2 Đang mở

#### saas-ops-signals
- TITLE: Người vận hành chẩn đoán 8 loại sự cố của khách (O1–O8): đăng nhập · page mất kết nối · webhook · AI im · gửi tin · đơn không hợp lệ · ghi đơn hỏng · hết hạn mức
- BUSINESS_GOAL: Launch Gate §4 QUAN SÁT — cổng ĐẠT đòi đủ 8 tín hiệu
- OWNER: Integration Lead · SESSION/AGENT: `wt-saas-ops-signals`
- PRIORITY: P0 · STATUS: IN_REVIEW · CLASS: STILL REQUIRED
- BRANCH: `feat/saas-ops-signals` @ `f20ebde9` · PR: #692 (review PASS + 2 MEDIUM)
- DEPENDENCIES: — · BLOCKERS: CI đỏ `tests/ops-signals.test.ts:344` (run 37803265699); 2 MEDIUM (báo nhân viên khi ghi đơn hỏng; phân biệt lỗi trước / sau ghi đơn); hoà với #690 ở `lib/actions/auth.ts`; migration 0236 va số với #631
- DONE: `platform_auth_failures`, gương `platform_org_health`, `error_class` trên sổ AI, ORDER_WRITE_FAILED thay AI_DOWN, khung Sự cố trên `/platform/org`
- REMAINING: sửa bài + 2 MEDIUM, cổng xanh, gộp, deploy, kiểm từng tín hiệu trên production
- ACCEPTANCE_CRITERIA: O1–O8 lên ✅ PROD (mỗi tín hiệu một lượt kiểm có vết)
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: worker sửa → gộp khi xanh · LAST_UPDATED: 2026-10-09

#### saas-acceptance-smoke
- TITLE: Smoke nghiệm thu khách Chốt Đơn trên production (ops `saas-acceptance`)
- OWNER: Integration Lead · SESSION/AGENT: `wt-saas-acceptance`
- PRIORITY: P0 · STATUS: MERGED · CLASS: STILL REQUIRED
- BRANCH: `feat/saas-acceptance-smoke` · PR: #690 → `5ce11027` (review bảo mật PASS, gộp 08/10 17:30Z)
- DEPENDENCIES: — · BLOCKERS: MM-ACC-01 phải gộp + deploy TRƯỚC lượt `--apply` đầu tiên
- DONE: bước A cấp phát · B kích hoạt + đăng nhập email · C vỏ · D chat web → AI → đơn (`--e2e`) · E định tuyến chat công khai
- REMAINING: deploy → `--apply` → chuẩn bị UI một lần (`docs/saas/ACCEPTANCE.md` §3) → `--apply --e2e`
- ACCEPTANCE_CRITERIA: A–E xanh trên production; Launch Gate A2 · A5 · C1 · C2 · C7–C17 lên ✅ PROD theo bằng chứng
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: MM-ACC-01 · LAST_UPDATED: 2026-10-09

#### MM-ACC-01 — `fix/saas-acceptance-hardening`
- TITLE: Chặn chiếm mã `cdt-nghiem-thu` (MEDIUM-1) + loại workspace thử khỏi buồng lái (MEDIUM-2, ACCEPTANCE §8) + L1–L4
- OWNER: Integration Lead · SESSION/AGENT: — (cây `wt-saas-acceptance` còn 3 tệp `tests/_tmp-*` chưa theo dõi; nhánh CHƯA tồn tại trên remote)
- PRIORITY: P0 · STATUS: READY · CLASS: STILL REQUIRED
- DEPENDENCIES: #690 (MERGED) · BLOCKERS: —
- DONE: — · REMAINING: toàn bộ
- ACCEPTANCE_CRITERIA: mã workspace thử không bị tổ chức khác chiếm; chỉ số buồng lái loại workspace thử ở cả bảy nơi
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: tạo nhánh từ `origin/main`, claim, làm · LAST_UPDATED: 2026-10-09

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

#### MM-OPS-02 — Sao lưu ngoài máy (Google Drive) vẫn không đủ chỗ
- TITLE: CSDL nhà ~180 MB không lên Drive 15 GB (~9,9 GB là tệp riêng của chủ shop); bản trên VPS + PITR vẫn tốt
- OWNER: Chủ shop · PRIORITY: P1 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DEPENDENCIES: backup-drive-trash (DEPLOYED) · BLOCKERS: chọn dọn Drive · Google One · tài khoản Google riêng · hay giảm hạn giữ (giờ 48→24, tay 3→1)
- REMAINING: một lượt `backup-status` xanh sau quyết định · PRODUCTION_EVIDENCE: — · LAST_UPDATED: 2026-10-09

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

Readiness pháp lý: `docs/legal/LEGAL_LAUNCH_GATE.md` — LEGAL READY **NOT READY (2,0 / 11 = ~18 %)**, trạng thái chung
**WAITING_FOR_LEGAL_COUNSEL**.

### 10.2 Đang mở

#### legal-registers
- TITLE: Pháp lý L1 — sổ phiên bản văn bản · bên xử lý phụ · chuyển xuyên biên giới (UNKNOWN khi chưa xác minh) · khung lưu trữ (null = chưa quyết) · sổ hệ thống AI · cổng pháp lý 5 trạng thái · quy trình DSR / sự cố (tài liệu)
- OWNER: Integration Lead · SESSION/AGENT: `wt-legal-registers`
- PRIORITY: P0 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED (bằng chứng cho LEGAL P0-3 · P0-8 · P0-9)
- BRANCH: `feat/legal-registers` — **chưa commit, chưa đẩy (≥ 12 tệp chỉ trên đĩa, có `DSR_PROCEDURE.md` mới)** · PR: —
- DEPENDENCIES: — · BLOCKERS: —
- REMAINING: commit, push, cổng (chạm `app/chinh-sach-bao-mat`, `app/dieu-khoan-su-dung`, `tests/sync-fixtures.test.ts`), PR
- ACCEPTANCE_CRITERIA: mọi ô chưa xác minh in UNKNOWN, không xanh giả; quy trình DSR ghi hạn đúng luật (2 / 10 / 15 / 20 ngày)
- PRODUCTION_EVIDENCE: — · NEXT_ACTION: chụp `wip/legal-registers` ngay · LAST_UPDATED: 2026-10-09

#### legal-acceptance
- TITLE: Pháp lý L2 — sổ chấp thuận văn bản (phiên bản · băm · mốc · tài khoản · workspace) ghi ở backend lúc đăng ký, không checkbox (M-ACCEPT, LEGAL P1-6)
- OWNER: Chủ shop (đã tạm dừng) · SESSION/AGENT: `wt-legal-acceptance`
- PRIORITY: P1 · STATUS: DEFERRED · CLASS: DEFERRED (lý do: chủ shop TẠM DỪNG — WAITING_FOR_LEGAL_COUNSEL; mở lại khi luật sư trả lời hoặc chủ shop mở lại)
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
| org-ai-platform-cutover | Ops `org-ai-cutover`: kiểm khoá AI + chuyển AI Bán hàng sang AI dùng chung | P1 | DONE | DONE (công cụ); lượt `--apply` cho HSLC = MM-HSLC-01 | #659 #667 | run 37772436572 | 2026-10-08 |
| MM-HSLC-00 | HSLC tự phục vụ: mẫu thực phẩm, nhập SP, chatbot, báo nhóm; đơn tay · GTC · ads; bot im lặng / tin đơn nhanh | P1 | DONE | DONE | #408 #499 #500 #501 #502 #570 #575 | đã deploy | 2026-10-05 |

### 11.2 Đang mở

#### MM-HSLC-01 — Chuyển HSLC sang khoá AI dùng chung (`org-ai-cutover hslc-hmt-shop --apply`)
- BUSINESS_GOAL: HSLC chỉ trả một lần (590 ₫ / khách AI qua Số dư), không đồng thời tự trả token khoá riêng; bot không im vì cạn credit khoá riêng (PX-01)
- OWNER: Integration Lead (+ chủ shop nếu phải nâng trần) · PRIORITY: P1 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DEPENDENCIES: platform-key-project-probe (#694) · BLOCKERS: `--apply` từ chối với credit 150 / 300; nghi `COST_HARD_BELOW_NEED` (trần `costUsdHard` của gói thấp) ⇒ có thể phải nâng ở `/platform/org/hslc-hmt-shop`
- DONE: trả trước đã kích hoạt; #694 đã gộp (`a582a5ad`) · REMAINING: đọc ops chỉ đọc → (nâng trần nếu cần) → `--apply`
- ACCEPTANCE_CRITERIA: AI Bán hàng HSLC chạy trên khoá nền tảng, sổ AI ghi nguồn nền tảng, khoá riêng không còn bị gọi
- PRODUCTION_EVIDENCE: lượt từ chối trước đó (ops) · NEXT_ACTION: đọc ops run 37819643201 · LAST_UPDATED: 2026-10-09

#### platform-key-project-probe
- TITLE: Dò số project Google của khoá AI nền tảng (chỉ đọc, không in khoá) + mã lý do của `org-ai-cutover`
- OWNER: Integration Lead · SESSION/AGENT: `wt-platform-key-project-probe`
- PRIORITY: P1 · STATUS: MERGED · CLASS: STILL REQUIRED (chờ đọc kết quả ops)
- BRANCH: `feat/platform-key-project-probe` @ `eff36495` · PR: #694 → `a582a5ad` (gộp 08/10 ~17:49Z; chỉ script — ops lấy script từ `main`, không cần deploy)
- DONE: `COST_HARD_BELOW_NEED` cả khi hết tháng; che khoá dán nhầm
- REMAINING: đọc kết quả lượt «Vận hành ERP trên VPS» 37819643201 (đang chạy lúc dựng sổ) → quyết MM-HSLC-01
- ACCEPTANCE_CRITERIA: ops in mã lý do cụ thể · PRODUCTION_EVIDENCE: ops run 37819643201 (chưa xong lúc dựng sổ)
- NEXT_ACTION: đọc log run 37819643201 · LAST_UPDATED: 2026-10-09

#### MM-HSLC-02 — Cấu hình danh mục HSLC: quy cách 0,5 kg, bảng giá sỉ mặc định, hai công tắc bot
- OWNER: Chủ shop / HSLC (thao tác trên UI — ops ghi hộ CSDL tổ chức khách bị chặn) · PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED
- DONE: mã #677 / #685 · REMAINING: HSLC tự cấu hình theo hướng dẫn · LAST_UPDATED: 2026-10-08

#### MM-ADS-01 — Đơn chốt trong Messenger tự gửi Purchase sang Meta (Conversions API)
- OWNER: phiên khác (`wt-hslc-sku`) · PRIORITY: P2 · STATUS: IN_PROGRESS · CLASS: STILL REQUIRED (không thuộc lô Launch)
- BRANCH: `claude/meta-capi-chot-don` @ `c5da52bc` · PR: #695 (CI lần trước đỏ, lượt mới đang chạy; mergeable_state `blocked`)
- NEXT_ACTION: phiên sở hữu sửa CI · LAST_UPDATED: 2026-10-09

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
| saas-e2e-customer | E2E như khách ngoài sau 4 PR SaaS | P0 | DONE | SUPERSEDED — thay bằng `saas-acceptance-smoke` (#690) + MM-ACC-01; phần tiếp quản / hạn mức / kênh Meta chưa có trong ops ⇒ ghi ở REMAINING của saas-acceptance-smoke khi mở rộng | — | — | 2026-10-09 |

### 12.2 Đang mở

#### tech-worker-onboarding
- TITLE: Cài worker `/tech` một nút cho chủ shop không kỹ thuật
- OWNER: Chủ shop (CRITICAL — chủ shop tự gộp) · SESSION/AGENT: `wt-worker-onboard`
- PRIORITY: P3 · STATUS: BLOCKED_OWNER · CLASS: STILL REQUIRED (Launch Gate §7: POST-LAUNCH)
- BRANCH: `feat/tech-worker-onboarding` @ `c8c3a272` (10 commit trước main) · PR: #631
- BLOCKERS: chủ shop gộp; migration 0236 va số với #692 (ai gộp sau thì `npm run migration:renumber`); review mất hiệu lực khi có commit mới
- NEXT_ACTION: chủ shop quyết · LAST_UPDATED: 2026-10-08

#### master-mission-registry
- TITLE: Sổ sứ mệnh tổng + checkpoint bền (tệp này + `CURRENT_CHECKPOINT.md`)
- OWNER: Integration Lead · SESSION/AGENT: worker docs (`wt-master-registry`)
- PRIORITY: P1 · STATUS: PR_READY · CLASS: STILL REQUIRED
- BRANCH: `docs/master-mission-registry` · PR: — (worker không mở PR)
- NEXT_ACTION: Integration Lead mở PR tài liệu · LAST_UPDATED: 2026-10-09

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
| MM-REC-14 | Khoá AI nền tảng và khoá riêng HSLC dùng chung MỘT tài khoản trả trước Google (sự cố 06/10, 07/10); chưa quyết tách thanh toán | P1 | BLOCKED_OWNER | STILL REQUIRED (gắn MM-HSLC-01) | #603 | chủ shop quyết tách tài khoản |
| MM-REC-15 | Bot nhà nghe ghi âm chưa thử ghi âm thật (token âm thanh tính giá chữ); cảnh báo phản hồi chậm theo nhân viên | P3 | BACKLOG | STILL REQUIRED | #480 | — |
| MM-REC-16 | Phần thấp của #689: sàn giữ N bản mới nhất, dọn trước khoá, che ID thư mục trong tài liệu | P2 | BACKLOG | STILL REQUIRED | #689 | sau MM-OPS-02 |
| MM-REC-17 | `ERP_GITHUB_DISPATCH_TOKEN` mất sau deploy `reset_env` — thêm vào `deploy-vps.yml` | P2 | BACKLOG | STILL REQUIRED (kiểm lại) | khoa-dispatch-github | kiểm `deploy-vps.yml` trên `main` |
| MM-REC-18 | Bật merge queue cho `main` (đổi ruleset) | P3 | BLOCKED_OWNER | STILL REQUIRED | luot-mo-trang-pr338 | chủ shop quyết |
| MM-REC-19 | Sau ~12/10: liệt kê trang 0 lượt / ít lượt mở, hỏi chủ shop từng trang | P3 | DEFERRED | DEFERRED (điều kiện: đủ dữ liệu từ 28/09, mốc ~12/10) | #338 | ~12/10 |
| MM-REC-20 | Trạm chuyển Telegram (Cloudflare Worker + biến GitHub) khi VPS bị chặn Telegram | P2 | BLOCKED_OWNER | STILL REQUIRED | #445 | chủ shop tạo Worker |
| MM-REC-21 | Tiến trình lạ giữ khoá vòng đời VPS ~02:15–02:50 VN | P3 | BACKLOG | STILL REQUIRED (chưa xác minh) | deploy-smoke-giu-khoa | đo log |
| MM-REC-22 | Chậm cấu trúc: `getBusinessBrief` ~104 truy vấn, `/operations` · `/orders` · `/work/settings` · `/chatbot` (Commercial C1 #13) | P2 | BACKLOG | STILL REQUIRED (đo median 3–5 lượt trước) | do-hieu-nang-erp | sau Launch Gate |
| MM-REC-23 | `docs/legal/COUNSEL_PACK.md` CHỈ nằm trên đĩa ở `wt-legal-compliance` (chưa commit) | P0 | IN_PROGRESS | STILL REQUIRED (gói câu hỏi gửi luật sư — đầu vào MM-LEGAL-01) | #691 / #693 | commit hoặc chụp `wip/`, đưa vào PR pháp lý kế |
| MM-REC-24 | Sự cố log Actions 24/09 chưa được đánh giá theo nghĩa vụ báo 72 giờ | P0 | BACKLOG | STILL REQUIRED (LEGAL P0-8) | legal-compliance-phase1 | gộp vào runbook sự cố (legal-registers) |
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

---

## 14. Quyết định của chủ shop đang chặn việc (tổng hợp)

| # | Quyết định | Chặn mission | Nguồn |
|---|---|---|---|
| D1 | Sao lưu Drive đầy: dọn Drive · Google One · tài khoản riêng · giảm hạn giữ | MM-OPS-02 | CHECKPOINT 09/10 |
| D2 | `PLATFORM_SIGNUP_MODE=open` — đóng (chỉ mời) tới khi READY? (khuyến nghị: đóng) | trang-chu-su-that-thuong-mai (CTA), Commercial C1 #4 | LAUNCH_GATE §8 |
| D3 | Xoá cửa hàng `qa` (khuyến nghị); giữ `hs-thien-nga-test` khi còn giữ Page thử Meta | — | CHECKPOINT |
| D4 | Bộ phân loại quyền chặn giao dịch tiền thật qua ops: chủ shop tự bấm, hoặc thêm quy tắc ở `/permissions` | MM-HSLC-01, MM-BILL-02 | CHECKPOINT |
| D5 | Meta App Dashboard + App Review | meta-messenger-access, MM-META-* | meta-review-guide |
| D6 | IDENTITY §7 Q1–Q6; sửa OAuth khớp EMAIL | MM-IDENT-01, MM-IDENT-02 | IDENTITY.md |
| D7 | OVERAGE Q1–Q10; chuyển 8 tổ chức legacy → V1 | MM-BILL-01, MM-BILL-02 | OVERAGE.md |
| D8 | Order Candidate §11 Q1 / Q3 / Q4 / Q5 | MM-ORDER-05 | ORDER_CANDIDATE.md |
| D9 | Duyệt page VNX SHADOW → LIVE | saas-a-vnx-runtime, saas-f-legacy-cleanup | OWNERSHIP.md |
| D10 | Kênh hỗ trợ khách; menu vỏ thêm mục; vai trò rút gọn | saas-help-system (H2), MM-UX-03, MM-UX-04 | FINISH_LINE §5 |
| D11 | Gộp #631 (CRITICAL) | tech-worker-onboarding | CHECKPOINT |
| D12 | Luật sư (G-1…G-11) · kế toán (HĐĐT) · câu chữ công bố AI · DPA | MM-LEGAL-01 → 05, 08, legal-acceptance | LEGAL_LAUNCH_GATE |
| D13 | Tài khoản kiểm thử người vận hành / Page thử | MM-ACC-02 | LAUNCH_GATE §6 |
| D14 | Ngưỡng Auditor A4 · A8 · A10 · A14 · A16; thang rủi ro RS | MM-OPS-01, MM-TECH-01 | auditor/DESIGN.md, RISK_SCALE.md |
| D15 | Dọn cây làm việc cũ | MM-TECH-03 | ai-tech-room |

---

## 15. POSSIBLE LOST TASKS RECOVERED

Việc từng được giao / phát hiện mà KHÔNG có mission / PR nào đang giữ trước lượt dựng sổ này (nay đã có MM-id ở trên, hoặc
ghi ở đây để phiên sau quyết):

| # | Việc | Nguồn | Nay ở |
|---|---|---|---|
| L1 | `fix/saas-acceptance-hardening` (MEDIUM-1/2 + L1–L4 của review #690) — CHECKPOINT ghi «IN_PROGRESS» nhưng nhánh KHÔNG tồn tại ở remote lẫn cục bộ | CHECKPOINT 09/10 · `git ls-remote` | MM-ACC-01 (READY) |
| L2 | Ba nhánh có thay đổi CHỈ trên đĩa, chưa commit / chưa ảnh chụp `wip/`: `fix/saas-shell-polish`, `feat/legal-registers`, `claude/erp-a11y-bo-cuc` | `git worktree list` + `status` | khối mission tương ứng — NEXT_ACTION: chụp `wip/` |
| L3 | Lưới đỡ mất webhook Meta (quét bù Graph) và nâng Graph trước 21/01/2027 | MASTER_MISSION_STATUS rủi ro 3 | MM-META-02, MM-META-03 |
| L4 | CSP (report-only → enforce), correlation ID | MASTER_MISSION_STATUS F3 / F4 | MM-SEC-01, MM-SEC-02 |
| L5 | `idempotency_key` UNIQUE cho đơn máy (`agentKey`) | ORDER_CANDIDATE C4 | MM-ORDER-04 |
| L6 | OAuth khớp EMAIL chưa xác minh | IDENTITY §1 / §7 Q5 | MM-IDENT-02 |
| L7 | Khung `/platform` + 9 nút không tên (Commercial PR F) | COMMERCIAL_POLISH_BOARD §3 | MM-ADMIN-01 |
| L8 | Token chữ / nút / tiền «đ» tay (Commercial PR B) | COMMERCIAL_POLISH_BOARD §5 | MM-UX-01 |
| L9 | Đếm khách AI cho tin nhắn lại (E3) | MASTER_MISSION_STATUS WS-E | MM-INBOX-04 |
| L10 | Sự kiện «Revenue Rescue» có giá trị + kết quả | MASTER_MISSION_STATUS P1 #6 | MM-INBOX-02 |
| L11 | Nợ pilot nền tảng còn MỞ (CSV, lợi nhuận thực nhận không ĐVVC, phiếu thu ↔ sổ ngân hàng) | `docs/platform/pilot-readiness.md` §4 | MM-ORDER-06 |
| L12 | Thao tác ops chỉ đọc theo CSDL tổ chức (điều kiện chốt giá phiên) | MASTER_MISSION_STATUS «Đo lường» | MM-METRIC-05 |
| L13 | Cô lập / bí mật / token page chưa có bằng chứng production (S1–S3) | LAUNCH_GATE §3 | MM-SEC-03 |
| L14 | Đợt kỹ thuật pháp lý (M-AI-DISCLOSE-UI, M-TRIAL-CONSISTENCY, M-LOGIN-LOG, …) chưa có mission `/tech` | TECH_HANDOFF_LEGAL §0 | MM-LEGAL-02, MM-LEGAL-06, MM-LEGAL-07 |
| L15 | `docs/legal/COUNSEL_PACK.md` (gói câu hỏi cho luật sư) chỉ nằm trên đĩa, chưa commit | `wt-legal-compliance` status | MM-REC-23 |
| L16 | Sự cố log Actions 24/09 chưa đánh giá theo nghĩa vụ báo 72 giờ | ghi nhớ legal-compliance | MM-REC-24 |
| L17 | Tổ chức cũ thương hiệu NULL (chỉ đường tạo mới được #682 chữa) | ghi nhớ chot-don-tu-dong | MM-REC-01 |
| L18 | Khoá AI nền tảng + khoá riêng HSLC chung một tài khoản trả trước Google | ghi nhớ gemini-tra-truoc / benchmark | MM-REC-14 |
| L19 | Tách hẳn app Messenger riêng (`appsecret_proof`, echo nhiều app id); redirect OAuth host Chốt Đơn | ghi nhớ meta-messenger | MM-REC-04, MM-REC-05 |
| L20 | 30+ việc vận hành / ERP / vertical chờ chủ shop hoặc chưa ai chạy thật | ghi nhớ nhiều tệp | MM-REC-06 → MM-REC-34 |

## 16. CRITICAL PATH — P0 còn lại, theo thứ tự

1. **#692 `saas-ops-signals`** — sửa CI `:344` + 2 MEDIUM → gộp (Launch Gate O1–O8).
2. **#683 `saas-customer-health`** — rebase sau #682 + F1 → gộp (A7 · A8 · A10).
3. **MM-ACC-01 `fix/saas-acceptance-hardening`** — tạo + gộp (bắt buộc trước `--apply`).
4. **MỘT deploy** `main` chứa #682 · #690 · #692 · #683 · MM-ACC-01 (production hiện `4dbd864a`).
5. **`saas-acceptance --apply`** → chuẩn bị UI (`ACCEPTANCE.md` §3) → **`--apply --e2e`**; kèm MM-SEC-03 (S1–S3).
6. **Cập nhật `LAUNCH_GATE.md`** bằng bằng chứng production (chỉ PROD mới tính 1 điểm).
7. **Pháp lý P0**: legal-registers (đẩy lên + PR) · MM-REC-23 `COUNSEL_PACK.md` vào kho · MM-REC-24 đánh giá sự cố 24/09 · MM-LEGAL-02 công bố AI (giao diện) · chủ shop đưa câu hỏi cho luật sư (MM-LEGAL-01) · MM-LEGAL-03 / 04 / 05 chờ chủ shop / luật sư / kế toán.
8. **Meta**: meta-messenger-access (chủ shop + Meta) → MM-META-01 smoke tài khoản ngoài ⇒ READY FOR FIRST PAYING CUSTOMER.

P1 còn lại (theo tác động thương mại): saas-shell-polish · trang-chu-su-that-thuong-mai · error-boundary-than-thien ·
platform-key-project-probe → MM-HSLC-01 · MM-BILL-01 / 02 / 03 · MM-OPS-02 · MM-SEC-01 · MM-ORDER-04 · MM-META-02 / 03 ·
MM-IDENT-02 · MM-UX-04 · MM-ACC-02 · MM-REC-01 · MM-REC-04 · MM-REC-05 · MM-REC-14 · MM-LEGAL-06 / 07 / 08 · legal-acceptance (DEFERRED) · master-mission-registry.

## 17. Nguồn lệch nhau (đã ghi nhận, Git / PR / production thắng)

Xem `docs/tech/CURRENT_CHECKPOINT.md` §«Lệch nguồn».
