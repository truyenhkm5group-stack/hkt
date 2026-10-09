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

## Checkpoint 2026-10-09 ~13:00 giờ VN (đo lúc 09/10 06:07Z, nhánh `docs/registry-reconcile-0910`)

**MAIN_SHA:** `50293da6` (#725). Từ lần chụp trước (`9833d981`) đã gộp: #705 → #727 (23 PR).

**PRODUCTION_SHA:** `50293da6` — deploy 37886395475, `/api/health` khớp (239 migration) lúc chụp; hậu kiểm / `verify` CHƯA chạy. Trước đó `ef9b302ab11f` (deploy 37879275359, hậu kiểm ĐẠT).

Chuỗi deploy 09/10 (mọi lượt xanh đều hậu kiểm ĐẠT: `/api/health` khớp · 239 migration · smoke):
- `c71833950519` — deploy 37838226087: #692 #702 #703 #704, trên lô 37829126099 (`6883bfbf`: #682 #683 #690 #694 #696 #697 #698 #699 #700).
- `9833d981` — #701 (phiên khác deploy).
- `dbab68130a72` — deploy 37854562530: #705 #706 #707 #708 #709 #710.
- `d23c0deb3ce1` — deploy 37860758200: #711 #712 #713 #714.
- deploy 37871032076 cho `304bcbcb` **HỎNG ở bước release** (SSH «Run Command Timeout» khi kéo image) — production đứng yên `d23c0deb`,
  không đổi gì; đã được lượt sau thay thế.
- `ef9b302ab11f` — deploy 37879275359: #715 #716 #717 (chủ shop tự gộp — CRITICAL vì thêm `export` cho `HAS_CASH_EVIDENCE` trong
  `return-rate.ts`) #718 #719 #720 #722 #723.
- `50293da6` — deploy 37886395475: #721 #724 #725 #726 #727 — **DEPLOYED** (`/api/health` khớp; verify CHỜ).

**BẰNG CHỨNG PRODUCTION**
- `saas-acceptance --apply` **PASS 4/4 ba lần**: run 37838073371 (`6883bfbf`) · 37860546515 (`dbab6813`) · 37866720324 (`d23c0deb`).
- `ops-signals-check` (#710) **PASS 9 tổ chức × 8 tín hiệu, 0 ô hỏng**: run 37853956678 · 37860619173 · 37867472656. **O1 chứng minh trọn**:
  RESET_LINK_USED (37860619173) + LOGIN / BAD_PASSWORD (37867472656). O2–O8 TÍNH ĐƯỢC nhưng chưa chứng minh PHÁT HIỆN; dựng sự cố (#724)
  chỉ chứng minh được O6 — O2–O5 · O7 · O8 là **CHƯA ĐO ĐƯỢC** (cần kênh nhắn tin thật / AI trả tiền / thao tác phá huỷ).
- 33 mission đóng DONE ở sổ `/tech` sau verify (danh sách đầy đủ trong registry, cột LAST_UPDATED 2026-10-09).

**LAUNCH_READINESS** (chép từ nguồn, không tự chấm):
- ENGINEERING: **NOT READY — 61 %** (25 / 41; **10 / 41** có bằng chứng production) — `LAUNCH_GATE.md` nhật ký 09/10 trưa (#723).
- LEGAL: **NOT READY — ~23 %** (2,5 / 11), **WAITING_FOR_LEGAL_COUNSEL** — `LEGAL_LAUNCH_GATE.md`.
- META: **⛔ NGOÀI**. COMMERCIAL: C0 **0** · C1 **3** (bàn giao Fable Round 2) — **NOT READY**.

### Bảng tốc độ (cửa sổ 08/10 05:57Z → 09/10 05:57Z)

**LAST 24H**

| Chỉ số | Số | Cách đếm |
|---|---|---|
| PR MERGED | **66** | `git log --since=… --first-parent origin/main`: 66 commit, 66 mang số PR (63 squash «(#n)» + 3 merge commit «Merge pull request #n»); `--merges` một mình chỉ ra 3 vì repo gộp squash là chính |
| PR DEPLOYED | **61** | commit trong cửa sổ là tổ tiên của production `ef9b302a` (`git merge-base --is-ancestor`); chưa lên: #721 #724 #725 #726 #727 |
| Lượt deploy (biết được, từ 08/10 18:00Z) | 6 xanh · 1 hỏng (37871032076, nhất thời) · 1 đang chạy | danh sách trên; không đếm lại toàn cửa sổ bằng API lượt này |
| P0 / P1 CLOSED | **13 / 14** (33 mission DONE: 13 P0 · 14 P1 · 4 P2 · 2 P3) | ưu tiên theo registry của 33 mission `/tech` đóng sau verify 09/10 |
| PRODUCTION TESTS PASSED | 6 deploy hậu kiểm ĐẠT · `saas-acceptance --apply` 3 / 3 PASS · `ops-signals-check` 3 / 3 PASS | run nêu trên |
| NEW BLOCKERS | **2** | MM-FU-724 (O2–O5 · O7 · O8 không dựng sự cố được ⇒ cần chuẩn bằng chứng sự cố thật) · MM-FU-712 (không đường nào bật `meta.direct-connect.open`) |
| REGRESSIONS | **0** trên production | lượt deploy hỏng không đổi production; không có `VERIFY_FAIL` trong số đo của Integration Lead |

**TOTAL** (registry sau lượt này — đếm bằng script, cách đếm ở registry §0b)

| Chỉ số | Số |
|---|---|
| MISSIONS TOTAL | **245** (215 → +30 dòng mới, không xoá) |
| DONE | **119** |
| P0 REMAINING | **10** — 7 chờ bên ngoài / chủ shop (Meta ×2 · luật sư ×3 gồm MM-REC-24 · chủ shop / kế toán ×2: câu chữ công bố AI, hoá đơn) · acceptance-signal-drills (DEPLOYED, chờ `--drills`) · MM-SEC-03 (VERIFYING) · MM-LEGAL-02 (READY) |
| ACTIVE | 4 IN_PROGRESS · 1 PR_READY · 4 DEPLOYED chờ hậu kiểm (#721 #724 #725 #726) |
| BLOCKED_OWNER / BLOCKED_EXTERNAL | 33 / 7 |

**VELOCITY**

| Chỉ số | Số |
|---|---|
| DONE LAST 24H | **33** mission · 66 PR gộp |
| DONE LAST 7D | **275** PR gộp (cùng cách đếm, 02/10 05:57Z → 09/10 05:57Z); số mission 7 ngày chưa đo lượt này (cần `events.ndjson` của `/tech`) |
| CURRENT BOTTLENECK | Chứng minh PHÁT HIỆN O2–O8 + E2E D · E (chờ chủ shop chuẩn bị UI) — kỹ thuật đã xong phần mình làm được |

### WIP hiện tại (giới hạn 3 engineering + 1 audit)

| Loại | Việc | Trạng thái |
|---|---|---|
| ENGINEERING 1 | `pancake-counters-remaining` — khối «Khách hàng» trang đơn + bộ lọc đã lưu còn đọc bộ đếm Pancake | IN_PROGRESS |
| ENGINEERING 2 | `inbox-perf-probe` — số đo production cho C1 #13 | IN_PROGRESS |
| ENGINEERING 3 | `shell-copy-brand-r3` — C1 #7 chữ kỹ thuật vỏ (+ một phần MM-FU-700) | IN_PROGRESS (RUNNING) |
| AUDIT | `registry-reconcile-0910` (tệp này + registry) | PR_READY |

Phiên Fable sweep: **WAITING_FOR_NEXT_PRODUCTION_ROUND** (bàn giao Round 2 cuối ở `claude/commercial-sweep-ban-giao`, PR tài liệu riêng).

### BLOCKED
- **O2–O5 · O7 · O8**: không dựng sự cố được trên workspace thử ⇒ cần chuẩn bằng chứng từ sự cố thật (MM-FU-724).
- **E2E D · E** (`--e2e`, Launch Gate C8–C17): chờ chủ shop chuẩn bị UI (D19).
- **C1 #4** CTA đăng ký: chờ D2. **Meta Direct**: Meta chưa cấp quyền Page (meta-messenger-access).
- **Pháp lý P0**: chờ luật sư (`COUNSEL_PACK.md` #704 đã vào kho — chủ shop gửi đi).

### OWNER_DECISIONS (đang chặn việc — đầy đủ ở registry §14)
1. `PLATFORM_SIGNUP_MODE` mở hay chỉ mời tới khi READY (chặn C1 #4) — D2.
2. Chuẩn bị UI một lần cho E2E (`ACCEPTANCE.md` §3) — D19.
3. Sao lưu CSDL nhà lên Drive (dọn Drive · Google One · tài khoản riêng · giảm hạn giữ) — D1.
4. Xoá cửa hàng `qa` — D3.
5. Quy tắc giao dịch tiền thật qua ops — D4.
6. V6: bản sao khoá bí mật ngoài VPS — D16.
7. Dùng thử 7 hay 14 ngày — D17.
8. Bộ vai trò Chốt Đơn cho `/settings/users` — nay là TUỲ CHỌN (C1 #5 đã đóng nhờ #700 ẩn ma trận quyền) — D10.
9. Ngày bật `meta.direct-connect.open` — D20.
10. Mật độ trang dùng chung ERP ↔ vỏ (chữ 10–10,5 px ở Sản phẩm · Đơn · Khách · Phiếu nhập) — D21.
11. Luật sư rà Chính sách bảo mật / Điều khoản — D22.

### NEXT_3_ACTIONS
1. Deploy `50293da6` xong → hậu kiểm + `verify` → `saas-acceptance --apply --drills` ⇒ O6 lên ✅ trong `LAUNCH_GATE.md`.
2. Hiệu năng production: `inbox-perf-probe` + ops smoke cho `/chatbot` · `/cod` · `/reports/*` (đóng hoặc định lượng C1 #13).
3. C1 #6 / #7 chữ vỏ (`shell-copy-brand-r3`) + C1 #5 trang Nhân viên (tuỳ chọn, chờ D10). Kèm các kiểm production còn thiếu: nghiệm thu CÓ
   ĐĂNG NHẬP xác nhận #700 / #712 / #718 · trang chi tiết tổ chức không Pancake (#725) · `/shipments/<id>` vận đơn COD 0 (#717).

---

## Lệch nguồn (đã ghi nhận — Git / PR / production thắng)

Dòng 1–15: lượt dựng 09/10 01:00 (nay phần lớn đã được Git giải quyết — giữ làm vết). Dòng 16–18: lượt làm mới 02:30. Dòng 19–22: lượt đối chiếu 09/10 trưa.

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
| 19 | Lệnh điều phối đầu lượt ghi C1 #5 «BLOCKED chờ quyết định vai trò», #6 IN_PROGRESS, #9 READY | Bàn giao Fable Round 2 (sau đó): #5 · #6 (#700), #9 (#682) đóng theo đối chiếu; C1 còn 3 (#4 · #7 · #13). Registry theo bản sau; bộ vai trò rút gọn thành TUỲ CHỌN (D10) |
| 20 | `COMMERCIAL_POLISH_BOARD.md` trên `main` (#727) còn ghi «C1 MỞ 6» gồm #8 #683 và lệnh đặt xưởng | #683 đã DEPLOYED, #719 DONE. Bảng do PR bàn giao Fable (`claude/commercial-sweep-ban-giao`) sửa — lượt này KHÔNG chạm tệp đó |
| 21 | Sổ `/tech` liệt #727 vào «đã gộp chờ verify» | #727 chỉ tài liệu ⇒ registry ghi DONE theo quy ước §0 (ngoại lệ tài liệu); sổ `/tech` đóng khi verify lô `50293da6` |
| 22 | `git log --merges` trong 24 giờ chỉ ra 3 | Repo gộp squash là chính ⇒ đếm PR bằng commit first-parent mang số PR: 66 |
