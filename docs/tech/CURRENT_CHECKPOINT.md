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

## Checkpoint 2026-10-09 ~04:25 giờ VN (đo lúc 08/10 21:21Z)

**MAIN_SHA:** `9833d981` (#701 HSLC «Chỉ bán kèm», chưa deploy). Từ lần chụp trước đã gộp: #692 · #701 · #702 · #703 · #704.

**PRODUCTION_SHA:** `c71833950519` — deploy 37838226087 xanh (smoke), `/api/health` khớp, 238 migration. Trước đó deploy 37829126099
(`6883bfbf`) xanh. `npm run ai -- verify --sha=c71833950519` ĐẠT ⇒ 16 mission đóng DONE ở sổ `/tech` (saas-create-customer-correct ·
saas-customer-health · saas-shell-gate-redirects · saas-shell-polish · saas-ops-signals · saas-acceptance-smoke ·
saas-acceptance-hardening · backup-drive-trash · cutover-unpriced-tolerance · platform-key-project-probe · legal-registers ·
legal-counsel-pack · commercial-sweep · master-mission-registry · registry-refresh-0909 · launch-gate-r2).

**PRODUCTION ACCEPTANCE (lần đầu có vết):** `saas-acceptance` chỉ đọc FAIL 0/1 (run 37837987556 — workspace chưa tồn tại, đúng kỳ vọng)
→ `--apply` **PASS 4/4** (run 37838073371): A tạo khách qua đường admin · B1 kích hoạt + đăng nhập email KHÔNG mã tổ chức · C vỏ 8 mục
· B2 xoay mật khẩu. D · E (`--e2e`) bỏ qua — chờ chủ shop chuẩn bị UI một lần (`docs/saas/ACCEPTANCE.md` §3).

**LAUNCH_READINESS** (chép từ nguồn, không tự chấm):
- ENGINEERING: **NOT READY — 60 %** (24,5 / 41; **9 / 41** có bằng chứng production) — `LAUNCH_GATE.md` nhật ký 09/10 sáng.
- LEGAL: **NOT READY — ~23 %**, **WAITING_FOR_LEGAL_COUNSEL** — `LEGAL_LAUNCH_GATE.md`.
- META: **⛔ NGOÀI**. COMMERCIAL READY: **NOT READY**.

### Bảng tốc độ (GitHub API + `events.ndjson` của sổ `/tech`; cửa sổ kết thúc 08/10 21:21Z)

**LAST 24H**

| Chỉ số | Số | Cách đếm |
|---|---|---|
| PR MERGED | **59** | `/pulls?state=closed` lọc `merged_at` trong 24 giờ |
| PR DEPLOYED | **58** | commit gộp là tổ tiên của production `c71833950519`; chưa lên: #701 |
| Lượt deploy | 24 thành công · 1 hỏng | workflow «Deploy ERP to VPS» |
| MISSION DONE | **53** | sự kiện `DONE` của sổ `/tech` |
| PRODUCTION TESTS PASSED | **56** `VERIFY_PASS` + nghiệm thu production PASS 4/4 | `events.ndjson` + ops run 37838073371 |
| NEW BLOCKERS | **1** | #706 trang chủ hứa «Kết nối Facebook» thẳng trong khi `meta-messenger-access` BLOCKED_EXTERNAL ⇒ review FAIL, trả phiên Fable |
| REGRESSIONS | **0** trên production | không có `VERIFY_FAIL` trong 24 giờ |

**TOTAL**

| Chỉ số | Số |
|---|---|
| MISSIONS TOTAL (registry #702) | **215** |
| DONE | registry 89 (chưa chép 16 mission đóng lượt này — sổ `/tech` là nguồn: **82** mission có sự kiện `DONE` từ 06/10) |
| P0 REMAINING | **16** theo registry; trong Launch Gate: **0 P0 mở** — đường tới ĐẠT là E2E D + E và kiểm O1–O8 trên production |
| ACTIVE | 3 RUNNING lô Fable (R2 · G · F) + #705 (PASS, chờ cổng) + #706 (FAIL) |
| BLOCKED_OWNER / BLOCKED_EXTERNAL | 33 / 6 (registry) |

**VELOCITY**

| Chỉ số | Số |
|---|---|
| DONE LAST 24H | **53** mission · 59 PR gộp |
| DONE LAST 7D | **82** mission (nhật ký `/tech` từ 06/10 05:09Z — ít hơn 7 ngày) · **256** PR gộp |
| CURRENT BOTTLENECK | **E2E trên production** (C8–C17 = 10 mục Khách chỉ lên ✅ bằng `--e2e`) cần chủ shop chuẩn bị UI một lần; rồi kiểm O1–O8 |

### WIP hiện tại (giới hạn 3 engineering + 1 audit)

| Loại | Việc | Trạng thái |
|---|---|---|
| ENGINEERING 1 | #705 màn hình lỗi thân thiện (Fable) | review PASS — chờ cổng rồi gộp |
| ENGINEERING 2 | #706 trang chủ đúng sản phẩm (Fable) | review FAIL (hứa nối Facebook thẳng) — phiên Fable sửa |
| ENGINEERING 3 | Round 2 Production Acceptance + Commercial Sweep (phiên Fable code-erp-71: R2 · G · F) | RUNNING |
| AUDIT | `launch-gate-r3` (tệp này + `LAUNCH_GATE.md`) | PR |

### OWNER_DECISIONS (đang chặn việc)
1. **Chuẩn bị UI một lần cho E2E** (`ACCEPTANCE.md` §3): đặt lại mật khẩu khách thử · tạo `NT-AO-01` 150.000 ₫ + nhập ≥ 10 · bật bot
   · xuất bản `cdt-nghiem-thu`. Ops không ghi hộ vào workspace (chỉ đạo 08/10).
2. Sao lưu CSDL nhà: dọn Drive · Google One · tài khoản Google riêng · giảm hạn giữ.
3. `PLATFORM_SIGNUP_MODE=open` — đóng tới READY? · Xoá cửa hàng `qa`? · Quy tắc giao dịch tiền thật qua ops · V6 · dùng thử 7 / 14
   ngày · Meta App Review · luật sư (đầy đủ: registry §14).

### NEXT_3_ACTIONS
1. Gộp #705 (+ #706 sau sửa, R2 · G · F khi handoff) → MỘT lượt deploy cho lô (cùng #701) → `verify --record` → `close`.
2. Chủ shop chuẩn bị UI ⇒ `saas-acceptance --apply --e2e` (kỳ vọng PASS 6/6) ⇒ C8–C17 lên ✅ trong `LAUNCH_GATE.md`.
3. Kiểm O1–O8 trên production bằng `/platform/org` (tín hiệu #692) và chép 16 mission đóng lượt này vào registry.

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
