# CURRENT CHECKPOINT — Chốt Đơn Tự Động Launch

> Ảnh chụp NGẮN của lúc này. Chi tiết từng việc: `docs/tech/MASTER_MISSION_REGISTRY.md`. Checkpoint của Integration Lead trên sổ
> `/tech`: `git show origin/ai-control/registry:CHECKPOINT.md` (khung của tệp này — đã kiểm lại từng dòng với Git / PR).
> **Git / PR / production THẮNG tệp này nếu lệch.** Readiness chỉ đọc từ `docs/saas/LAUNCH_GATE.md` và
> `docs/legal/LEGAL_LAUNCH_GATE.md` — không tự chấm cao hơn.

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
2. Cập nhật tệp này (MAIN_SHA · PRODUCTION_SHA · ACTIVE_PRS · BLOCKED · NEXT_3_ACTIONS).
3. Việc dở phải ở remote: push nhánh hoặc ảnh chụp `wip/<tên>` (AGENTS §9) — không để chỉ trên đĩa.
4. `npm run ai -- heartbeat | handoff | close` trong sổ `/tech`.
5. Viết handoff: đã làm · còn lại · lệnh kiểm · rủi ro. Phiên sau bắt đầu từ SESSION START, không từ trí nhớ chat.

---

## Checkpoint 2026-10-09 ~01:00 giờ VN (đo lúc 08/10 17:56Z)

**MAIN_SHA:** `a582a5ad` (#694 gộp ~17:49Z; trước đó `5ce11027` #690, `67647aae` #682). CI của `5ce11027` và `a582a5ad` đang chạy.

**PRODUCTION_SHA:** `4dbd864a` — `/api/health` `commit 4dbd864aaf86`, `migrations 236` (deploy run 37800951308, 08/10 15:27Z).
Có #680 #681 #684 #685 #686 #687 #688 #689. **CHƯA có** #682 (P0) · #690 (P0) · #694 (chỉ script — ops dùng được ngay) ·
#691 / #693 (tài liệu pháp lý — không cần deploy).

**LAUNCH_READINESS** (chép từ nguồn, không tự chấm):
- ENGINEERING: **NOT READY — 35 %** (14,5 / 41; Admin 25 % · Khách 47 % · Bảo mật 2,5 / 4 · Quan sát 0,5 / 8; 1 / 41 có bằng chứng production) — `LAUNCH_GATE.md` nhật ký 08/10 tối.
- LEGAL: **NOT READY — ~18 %** (2,0 / 11 P0), trạng thái **WAITING_FOR_LEGAL_COUNSEL** — `LEGAL_LAUNCH_GATE.md` §6.
- META: **⛔ NGOÀI** (chưa cấp quyền Page; App Review chưa nộp).
- COMMERCIAL READY: **NOT READY**.

### DONE (gần nhất, đã production)
#680 Finish Line R1 · #681 đăng nhập email (+ `identity-reconcile` ghi bù 12 chỉ mục, THIẾU 0) · #684 · #686 vỏ không trắng
trang · #687 Launch Gate r2 · #688 · #689 sao lưu Drive (thùng rác) · #685. HSLC: tài khoản nhận tiền ĐÃ khai, cờ Số dư AI BẬT,
số dư dương, ĐÃ KÍCH HOẠT trả trước (ops run 37799525447).
Đã gộp chưa deploy: **#682** tạo khách đúng mặc định · **#690** ops `saas-acceptance`. Đã gộp (chỉ script): **#694**.

### IN_PROGRESS
| Việc | Nhánh / cây | Ghi chú |
|---|---|---|
| MM-ACC-01 `fix/saas-acceptance-hardening` | **nhánh chưa tồn tại** | Bắt buộc gộp + deploy trước `saas-acceptance --apply` đầu tiên |
| saas-shell-polish | `fix/saas-shell-polish` — chỉ trên đĩa | Cần ảnh chụp `wip/` ngay |
| legal-registers (L1) | `feat/legal-registers` — chỉ trên đĩa | Cần ảnh chụp `wip/` ngay |
| erp-a11y-bo-cuc (PR G) | `claude/erp-a11y-bo-cuc` — chỉ trên đĩa | Cần ảnh chụp `wip/` |
| saas-finish-line-r2 (Fable) | `claude/saas-finish-line-r2` @ `db011e27` (đã đẩy) | Chờ handoff |
| trang-chu-su-that-thuong-mai (PR A) | `claude/trang-chu-su-that-thuong-mai` @ `e17a9224` (đã đẩy) | Chờ handoff |
| error-boundary-than-thien (PR C) | `claude/error-boundary-than-thien` @ `9f5adec3` (đã đẩy) | Chờ handoff |
| commercial-sweep (docs) | `claude/commercial-sweep` @ `8661ddf0` | PR_READY — chưa mở PR |
| `COUNSEL_PACK.md` | `wt-legal-compliance` — chưa commit | Đầu vào câu hỏi luật sư |
| Meta CAPI (phiên khác) | #695 `claude/meta-capi-chot-don` | Không thuộc lô Launch |
| master-mission-registry | `docs/master-mission-registry` | Tệp này — PR_READY |

### ACTIVE_PRS
| PR | Nội dung | Trạng thái kiểm 08/10 17:56Z |
|---|---|---|
| #692 | Tín hiệu sự cố người vận hành (O1–O8), migration 0236 | Review PASS + 2 MEDIUM; CI ĐỎ ở `f20ebde9` (run 37803265699, `tests/ops-signals.test.ts:344`); worker đang sửa + hoà với #690 ở `lib/actions/auth.ts` |
| #683 | Sức khoẻ khách cho admin | Review vòng 2 PASS; CI xanh ở `e2b6cbf6`; cần rebase sau #682 + sửa F1 (`chatOk7d`) |
| #631 | Worker `/tech` một nút | CRITICAL — chủ shop gộp; migration va số 0236 với #692 |
| #695 | Meta CAPI (phiên khác) | CI lượt trước đỏ, lượt mới đang chạy; `blocked` |
| ~~#694~~ | Dò project khoá nền tảng | ĐÃ GỘP `a582a5ad`; ops run 37819643201 đang chạy |

### BLOCKED
- **HSLC chuyển khoá AI dùng chung** (MM-HSLC-01): `org-ai-cutover --apply` từng từ chối (credit 150 / 300), nghi
  `COST_HARD_BELOW_NEED`; #694 đã gộp ⇒ đọc ops run 37819643201. Trong lúc chờ: HSLC trả 590 ₫ / khách AI VÀ tự trả token khoá riêng.
- **Legal L2 `legal-acceptance`** TẠM DỪNG theo chủ shop (ảnh chụp `wip/legal-acceptance` @ `43c19ff9`); pháp lý chung chờ luật sư.
- **Meta App Review / quyền Page** — EXTERNAL.
- **Sao lưu ngoài máy** — Drive không đủ chỗ (MM-OPS-02).

### OWNER_DECISIONS (đang chặn việc)
1. Sao lưu Drive đầy: dọn Drive · Google One · tài khoản Google riêng · giảm hạn giữ (giờ 48→24, tay 3→1).
2. `PLATFORM_SIGNUP_MODE=open` — đóng (chỉ mời) tới khi READY? (khuyến nghị: đóng) — ảnh hưởng CTA trang chủ.
3. Cửa hàng `qa` — xoá theo quyết định 08/10 (khuyến nghị); giữ `hs-thien-nga-test` khi còn giữ Page thử Meta.
4. Quyền giao dịch tiền thật qua ops bị bộ phân loại chặn: chủ shop tự bấm, hoặc thêm quy tắc ở `/permissions`.
5. Meta App Dashboard (use case Messenger + 4 quyền) + App Review.
6. Luật sư (G-1…G-11), kế toán (HĐĐT / VAT), câu chữ công bố AI, DPA.
7. OVERAGE Q1–Q10 + chuyển 8 tổ chức legacy → V1; IDENTITY §7 Q1–Q6; Order Candidate §11; gộp #631.
   (Danh sách đầy đủ: registry §14.)

### NEXT_3_ACTIONS
1. **Gộp #692** khi CI xanh (sau bản sửa `:344` + 2 MEDIUM) → **rebase + gộp #683** → tạo + gộp **`fix/saas-acceptance-hardening`**.
2. **MỘT deploy `main`** (chứa #682 · #690 · #692 · #683 · hardening) → `saas-acceptance --apply` → chuẩn bị UI một lần
   (`docs/saas/ACCEPTANCE.md` §3) → `--apply --e2e` → cập nhật `LAUNCH_GATE.md` bằng bằng chứng production.
3. **Cứu việc chỉ trên đĩa** (ảnh chụp `wip/`): saas-shell-polish · legal-registers · erp-a11y-bo-cuc · `COUNSEL_PACK.md`;
   đọc ops run 37819643201 để quyết MM-HSLC-01; giao Round 2 Production Acceptance + Commercial Sweep cho phiên Fable hiện có.

---

## Lệch nguồn (đã ghi nhận — Git / PR / production thắng)

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
