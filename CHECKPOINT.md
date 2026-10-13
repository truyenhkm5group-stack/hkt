# CHECKPOINT — ChotDonTuDong Launch (Integration Lead)

> Mọi phiên (Claude / Fable / worker) ĐỌC TỆP NÀY TRƯỚC khi làm. Tệp sống trên nhánh `ai-control/registry` cạnh sổ sứ mệnh.
> Đọc nhanh: `git fetch origin +refs/heads/ai-control/registry:refs/remotes/origin/ai-control/registry && git show origin/ai-control/registry:CHECKPOINT.md`.
> Git / PR / production THẮNG mọi thứ ghi ở đây nếu lệch — kiểm `origin/main`, PR mở, `https://app.chotdontudong.com/api/health` (`commit`).
> Nguồn sự thật readiness: `docs/saas/LAUNCH_GATE.md` trên main. Readiness chỉ tăng bằng BẰNG CHỨNG PRODUCTION, không bằng mã.






## Checkpoint 2026-10-14 ~00:20 VN — TEAM: #827 ĐÃ LÊN PRODUCTION · BA NHÁNH CHỜ MỞ PR

**PRODUCTION `e557a910`** (#827 + #831 + #833), `ok: true`, `migrations 246`, `degradedMigration: true`.

**Lượt deploy 38423392247 = ĐỎ NHƯNG ĐÃ LÊN.** Mọi job cổng + `bang_chung` + `build_image` XANH; chỉ job
`release` đỏ ở bước «SSH vào VPS và chạy bootstrap». Production ĐANG phục vụ đúng SHA đích và khoẻ ⇒ mã đã
lên, cái đỏ là bước hậu kiểm. Dấu hiệu khớp dạng «đỏ CỐ Ý» đã ghi trong các checkpoint trước: `qa` còn
DEGRADED ở 0245 (`degradedMigration: true`). **CHƯA XÁC MINH ĐƯỢC TỪNG CHỮ**: đọc log job đòi token, phiên
Team hỏi ẩn danh bị HTTP 403. Ai có token mở log bước SSH, kiểm «smoke 134/134 đạt», rồi `verify --record`.
Gốc của cái đỏ này là quyết định đang chờ chủ shop: **cách sửa 0245 cho `qa`** (OWNER_DECISIONS) — không
phải lỗi mới của #827.

### CHỜ NGƯỜI CẦM KHOÁ `integration-lead` + TOKEN — BA NHÁNH ĐÃ PR_READY
```
npm run ai -- pr-open cost-center-unify     --token=…   # claude/lucid-brahmagupta-fnvimb — P0 giá vốn, RỦI RO CAO
npm run ai -- pr-open test-locale-order     --token=…   # claude/test-locale-order @ d9a91d81
npm run ai -- pr-open checkpoint-append-only --token=…  # claude/checkpoint-append-only @ b2997846
```
`cost-center-unify` rủi ro HIGH ⇒ sau khi có số PR phải có `review <PR> --sha=<đầu nhánh> --verdict=PASS`
trong sổ thì hàng đợi mới cho gộp. **Chủ nó (`vm:hkt`) đã bàn giao, Team KHÔNG nhận trùng.**

### VIỆC 2 CHƯA LÀM ĐƯỢC: XÁC MINH HỘP THƯ HSLC TRÊN PRODUCTION
Cần chạy ops (dispatch workflow ⇒ token + khoá). Bốn phép đo, chạy SAU khi #827 đã lên (đã lên lúc ~17:1xZ):
```
ops: inbox-perf-probe "--org=hslc-hmt-shop --samples=3 --analyze"
```
- tốc độ tải hội thoại: so với nền TRƯỚC #827 (listInbox p50 13–19 s · p95 21–29 s);
- bộ lọc «Chưa đọc» / «Chờ trả lời»: số đếm thẻ phải khớp số dòng thật của từng bộ lọc;
- bộ đếm + realtime: đổi `?c=` KHÔNG được dựng lại trang (vế chính của #827), tự làm mới không chồng lượt.
Chưa đo thì **chưa được đóng `inbox-list-perf` thành DONE** — workflow xanh không phải hậu kiểm.

### TEAM LÀM XONG TRONG LƯỢT NÀY
- **`checkpoint-append-only`** — công cụ ghi sổ này an toàn: nội dung LUÔN dựng từ đầu nhánh vừa fetch (không
  có tham số nhận cả tệp), lượt ghi làm MẤT dòng thì bị TỪ CHỐI và nêu đúng dòng mất, va thì fetch lại và
  thử lại, không bao giờ `--force`. Sinh ra từ chính lỗi Team gây ra chiều 13/10 (ăn mất dòng «probe #831 đã
  XÁC NHẬN JIT»). **Mục này được ghi bằng chính công cụ đó.**
- **`test-locale-order`** — bài kiểm chạy shell thôi phụ thuộc collation của máy; lá chắn §65 mục 2a chặn cả lớp.

### QUYỀN GITHUB CỦA TEAM (chủ shop chốt 14/10)
Team được cấp PAT fine-grained RIÊNG, chỉ kho này, chỉ `Pull requests` đọc+ghi (+ `Contents`/`Metadata` đọc) —
đủ `pr-open`, KHÔNG gộp, KHÔNG deploy. Không chép credential của phiên khác. Token cất ở hồ sơ Git Bash của
máy, không bao giờ vào cây làm việc (kho PUBLIC).

## Checkpoint 2026-10-13 ~21:15 VN — TEAM: VIỆC CẦN NGƯỜI CẦM KHOÁ `integration-lead` LÀM

> Phiên Team (`DESKTOP-56TH98Y:wt-team`) KHÔNG có khoá và KHÔNG có token GitHub ⇒ không gộp, không mở PR,
> không deploy. Bốn việc dưới đây là của phiên đang cầm khoá (hiện là Max, gia hạn 14:04Z, tới ~15:00Z).

**1 · GỘP #827 — P0 hộp thư, việc cuối của lô này.** Cổng XANH, hàng đợi xếp `MERGE_NOW`, đầu lô.
```
npm run ai -- merge 827 --sha=99013db136b7a25a9a2254bd93c059cc3debc42e --token=…
```
(#831 đã gộp lúc ~14:0xZ → `d9bdaca2`; #833 đã gộp VÀ đã lên production `785d1e28`.)

**2 · MỘT LƯỢT DEPLOY CHO CẢ LÔ, RỒI HẬU KIỂM.** `#831` đang nằm trên main mà CHƯA lên production.
```
npm run ai -- deploy-plan --token=…      # phải nói DEPLOY
npm run ai -- deploy --token=…           # MỘT lượt cho cả lô
npm run ai -- verify --record --mission=inbox-list-perf
```
Deploy «đỏ» vì `verify-migrations` báo `qa` DEGRADED là CỐ Ý — đọc log bước SSH, smoke phải «134/134 đạt».

**3 · ĐO LẠI SAU KHI #831 LÊN PRODUCTION — xác nhận giả thuyết JIT.**
```
ops: inbox-perf-probe "--org=hslc-hmt-shop --samples=3 --analyze"
```
Tìm dòng «JIT … biên dịch». Xác nhận rồi thì bản sửa chồng `fix/inbox-list-subplans` (`4ccf931b`, nay đã
có bản gộp main `c591531d` trong cây `wt-team`) mới đáng đưa qua PR — Team đã chạy `typecheck` + `lint` sạch
cho nó, `npm test` đủ CHƯA chạy xong (lượt chạy bị dừng vì máy hết RAM).

**4 · MỞ PR CHO HAI BÀN GIAO ĐANG CHỜ.**
```
npm run ai -- pr-open test-locale-order --token=…     # claude/test-locale-order @ d9a91d81 — MỚI, xem mục dưới
npm run ai -- pr-open inbox-unread-perf --token=…     # CHỜ chủ shop duyệt #792 trước (owner-approve-792)
```

### TEAM ĐÃ LÀM XONG (13/10, không cần làm lại)
- **Gỡ nghẽn cổng #827 + #831.** Cổng đỏ KHÔNG phải lỗi mã: job kiểm thử bị cắt ở 34:46 = trần 35′ cũ;
  #830 đã nâng 45′ nhưng chỉ trên main. Gộp main vào hai nhánh ⇒ `99013db1` và `c9d33af4`, cổng xanh cả bốn
  nhánh (run 38403175630). Kết quả đo được: **#831 đã gộp được ngay sau đó**.
- **`test-locale-order` (`claude/test-locale-order` @ `d9a91d81`) — PR_READY, rủi ro thấp, chỉ chạm `tests/`.**
  Bài kiểm sao lưu đỏ trên Windows / xanh ở CI vì `find … | sort` của shell xếp theo COLLATION của máy chạy
  (`-` 0x2D < `/` 0x2F ở C.UTF-8; en_US.UTF-8 bỏ qua dấu ⇒ ngược lại). Nó NÉM lỗi nên chặn mọi bài sau nó —
  đó là lý do `npm test` trên máy Windows không bao giờ chạy tới các bài hộp thư. Sửa ở đúng tầng:
  `tests/shell-locale.ts` ghim `LC_COLLATE=C` + GỠ `LC_ALL` cho mọi lượt gọi shell của bài kiểm, và
  `tests/test-hygiene.test.ts` thêm mục 2a chặn cả lớp ở mức mã nguồn. **Không đổi một giá trị kỳ vọng nào,
  không bỏ qua bài nào, không đụng luật nghiệp vụ sao lưu.** Đã chạy riêng từng bộ (máy thiếu RAM):
  backup ĐẠT · pitr ĐẠT · test-hygiene ĐẠT · typecheck + lint sạch.
  Chồng tệp với PR #814: ĐÃ ĐỐI CHIẾU — #814 chỉ sửa `tests/backup.test.ts` vùng dòng 1300–1330, việc này
  sửa vùng ~60–110; hai vùng không giao nhau, đã khai `OVERLAP_ACCEPTED` trong sổ.

### ĐÍNH CHÍNH 21:40 VN — SỨ MỆNH GIÁ VỐN VẪN CÓ NGƯỜI LÀM, TEAM ĐÃ TRẢ KHOÁ

Mục ngay dưới nói khoá `tech-lead` hết hạn ⇒ «không còn ai giữ». SAI. Team nhận khoá lúc 14:34Z rồi phát hiện
nhánh `claude/lucid-brahmagupta-fnvimb` có commit mới lúc **14:31:27Z** (gộp `origin/main`) — phiên ấy VẪN ĐANG
LÀM, nó chỉ thôi ghi nhịp tim vào sổ. Team **đã nhả khoá ngay** (`tech-lead` nay trống) và KHÔNG ghi một byte
nào vào nhánh của họ (lượt đẩy bị git từ chối non-fast-forward — không có gì lọt).

**BÀI HỌC: khoá hết hạn KHÔNG có nghĩa là phiên đã chết.** Nhịp tim trong sổ là lời khai; git là sự thật
(AGENTS 10.1 «git/GitHub thắng sổ»). Trước khi tiếp quản một sứ mệnh vì khoá hết hạn, PHẢI xem mốc commit cuối
trên nhánh của nó — không thì hai phiên cùng ghi một phạm vi, đúng thứ cả hệ điều phối này sinh ra để chặn.

### CẦN CHỦ SHOP QUYẾT
- **Sứ mệnh giá vốn `cost-center-unify` nay KHÔNG CÒN AI GIỮ**: khoá `tech-lead` của `vm:hkt` HẾT HẠN lúc
  14:04:53Z, nhịp tim cuối 13:13Z, nhánh `claude/lucid-brahmagupta-fnvimb` dừng ở `19ed1d52` (3 commit).
  Sáng 13/10 chủ shop chốt Team đứng ngoài vì phiên kia đang sống — nay nó đã chết. Team tiếp quản hay không
  là quyết định của chủ shop, không phải của phiên nào.

## Checkpoint 2026-10-13 ~20:05 VN — TEAM TIẾP QUẢN P0 HỘP THƯ (phiên Claude Team, cây `wt-team`)

**Phiên:** Claude Team · DESKTOP-56TH98Y:wt-team. Max 89% hạn mức tuần; vòng gia hạn khoá phía Max ĐÃ DỪNG
(nhịp `integration-lead` đứng ở 12:22:24Z, hết hạn 13:22:24Z). Team KHÔNG cướp khoá, chờ hết hạn tự nhiên.

### GIÁ VỐN — KHÔNG PHẢI VIỆC CỦA TEAM (chủ shop chốt 13/10 ~20:00)
Checkpoint 19:00 ghi «chưa có sứ mệnh giá vốn» — nay ĐÃ CÓ: `cost-center-unify` RUNNING, chủ `vm:hkt`,
khoá `tech-lead` («Tech Lead — P0 giá vốn») còn hiệu lực, nhịp tim tươi, đã đẩy **2 commit · 1.329 dòng**
trên `claude/lucid-brahmagupta-fnvimb` (Trung tâm giá vốn + BCLN hai chế độ Thực tế/Kế hoạch).
⇒ Team ĐỨNG NGOÀI, không dựng sứ mệnh thứ hai (AGENTS 10.1: đang có người làm ⇒ phối hợp).

### NGUYÊN NHÂN GỐC CỔNG ĐỎ #827 + #831 — KHÔNG phải lỗi mã, đã sửa
Job kiểm thử bị CẮT ở phút **34:46** trên cả hai lượt — đúng trần **35′ CŨ**:
run 38384289979 job 115252103978 (#827, «Kiểm thử ẩn danh») · run 38386551746 job 115259660846 (#831, «có token giả»).
Job kia XANH; một job bị HUỶ là đủ làm job gom `gates` ĐỎ. #830 đã nâng trần 35′→45′ nhưng **chỉ trên main**;
hai nhánh PR chưa có #830 nên vẫn chạy trần cũ. Không ai đọc kỹ chữ «cancelled» nên nó trông như lỗi kiểm thử.

**Đã sửa (gộp main vào nhánh, không xung đột, chỉ thêm merge commit — không sửa mã của worker):**
- `fix/inbox-perf-probe-hotnodes` 12566b62 → **c9d33af4** (đẩy 13:01Z)
- `fix/inbox-list-perf` ff284930 → **99013db1** (đẩy 13:02Z)
Cổng 45′ đang chạy trên cả hai.

**CẬP NHẬT 13:55Z — CỔNG ĐÃ XANH HOÀN TOÀN, HAI PR SẴN SÀNG GỘP.** Cả bốn nhánh cổng + job gom `gates` ĐẠT trên
`99013db1` (#827) và `c9d33af4` (#831) — run 38403175630. `npm run ai -- queue` xếp **MERGE_NOW · cùng MỘT lô ·
một lượt deploy cho cả lô** (kèm #832 đang chờ trên main).

**AI GỘP ĐƯỢC:** phiên Max — khoá `integration-lead` được gia hạn lúc 13:42Z (đời 6, tới 14:42Z) nên Max VẪN SỐNG;
phiên Team KHÔNG có khoá và KHÔNG có token GitHub (`GITHUB_TOKEN`/`GH_TOKEN` đều trống, máy không có `gh`), nên
Team không gộp/deploy được và cũng KHÔNG chép credential sang (luật bàn giao). Team dừng đúng ở ranh giới này.
Lệnh cho người cầm khoá: `merge 827 --sha=99013db136b7a25a9a2254bd93c059cc3debc42e` → `merge 831 --sha=c9d33af4e898c2565f03e2342f09786c351463a7`
→ `deploy-plan` → MỘT lượt deploy → `verify`.

**CẢNH BÁO §65 — QUẢ BOM THỨ BA, CHƯA SỬA:** `tests/backup.test.ts:1095` chạy `find . -type f | sort` KHÔNG ghim
locale. CI (`LANG=C.UTF-8`) xếp `./orgs-last-hourly.json` TRƯỚC `./orgs/erp_org_alpha/…`; máy Windows dev
(`LANG=en_US.UTF-8`) xếp NGƯỢC LẠI (collation UTF-8 bỏ qua `-` và `/`) ⇒ khẳng định dòng 1598 ĐỎ trên máy dev,
XANH ở CI. Bài kiểm NÉM LỖI nên chặn cả phần sau — không phiên nào trên Windows chạy được `npm test` tới các bài
hộp thư. Sửa đúng chỗ: ghim `LC_ALL=C` trong chính dòng lệnh của bài kiểm (KHÔNG vá từng khẳng định), và cân nhắc
thêm locale vào `tests/test-hygiene.test.ts` như nguồn môi trường thứ năm. CHƯA SỬA vì tệp nằm trong phạm vi
PR #814 đang mở ⇒ phải khai phạm vi với sổ trước.

### BƯỚC KẾ (Team)
1. Cổng xanh ⇒ `handoff` LẠI đúng SHA mới cho cả hai sứ mệnh (nhánh đã đi tiếp sau bàn giao).
2. Lấy `lease acquire integration-lead` SAU 13:22:24Z.
3. Gộp **#831** (chỉ công cụ đo, không cần deploy) ⇒ chạy `inbox-perf-probe "--org=hslc-hmt-shop --samples=3 --analyze"`
   để XÁC NHẬN giả thuyết JIT Postgres (dòng «JIT … biên dịch»).
4. Gộp **#827** + deploy — lưu ý main `f457f6de8` (#832) đang đi TRƯỚC production `d6db83717` một commit chưa deploy;
   gộp chung MỘT lượt deploy.
5. Rebase `fix/inbox-list-subplans` (4ccf931b) lên main sau khi #827 squash → `npm test` đủ → handoff → PR.

### KHÔNG ĐỤNG
`cost-center-unify` (vm:hkt) · #833 `claude/vigilant-sagan-dzqtn5` (chưa thuộc sứ mệnh nào trong sổ) · #814 (nháp).

## Checkpoint 2026-10-13 ~19:00 VN — BÀN GIAO MAX → TEAM (Max 89% tuần) — ĐỌC PHẦN NÀY TRƯỚC

**PRODUCTION:** `b5296e6d` (main tới #826). Deploy «đỏ» = CỐ Ý (qa DEGRADED trong verify-migrations); kiểm smoke trong log SSH.
**OWNER khoá gộp/deploy:** phiên Max đang cầm `integration-lead` — Team CHỈ `lease acquire integration-lead` SAU khi Max `lease release`
(hoặc khi lease hết hạn tự nhiên — kiểm `npm run ai -- lease status`). Một task = một owner; Team làm trong cây `wt-team`, KHÔNG ghi vào cây `wt-*` khác.

### ĐANG CHẠY lúc bàn giao (đừng chạy trùng)
- Lượt nền phía Max: gộp **#830** (trần job kiểm thử 35→45′) → gộp **#831** (probe nút nóng + JIT) → đo `inbox-perf-probe "--org=hslc-hmt-shop --samples=3 --analyze"`.
  Team: kiểm `gh`/API — #830/#831 đã merged chưa; nếu chưa và Max đã nhả khoá thì tự gộp theo thứ tự đó, rồi chạy probe.
- Vòng gia hạn khoá phía Max (tự dừng khi phiên Max dừng; lease 60′ tự hết).

### P0 INBOX — trạng thái + bước kế (owner: Team tiếp quản)
- Số đo HSLC: listInbox p50 13–19 s (hàng 7–12 s, đếm-thẻ 5–6 s), loadInboxThread 0,1–1 s; «chưa đọc» đường LƯU SẴN (0245 đủ); state nhỏ (TB 1,3 KB).
- **ĐÃ XÁC NHẬN 13/10 (probe #831):** JIT — listInbox.hàng «JIT 291 hàm», Limit 6.873 ms tự thân/100 dòng; đếm-thẻ «JIT 187 hàm», Seq Scan 3.788 dòng 4.521 ms; mọi nút khác < 200 ms. #830 (trần 45′) + #831 đã gộp.
- (cũ) GIẢ THUYẾT: **JIT Postgres** (cost ước ~300 triệu do nhánh lùi #803 lập kế hoạch nhưng 0 vòng chạy) — tiền lệ `db/index.ts::chayKhongJit`.
  Xác nhận bằng dòng «JIT … biên dịch» của probe #831.
- Bản sửa sẵn: `fix/inbox-list-subplans` @ `4ccf931b` (xếp chồng trên `fix/inbox-list-perf` @ `ff284930` = PR **#827**): 5 câu quét cả hộp thư
  chạy `set local jit = off` qua `chayKhongJit` + state giải nén 1 lần + câu lấy hàng 2 pha. CHƯA PR, CHƯA `npm test` đủ.
  Bước: (1) probe xác nhận JIT; (2) #827: `handoff inbox-list-perf` lại @ff284930 → review → merge+deploy (client: bỏ router.refresh khi chuyển
  hội thoại, tự làm mới không chồng lượt, thử lại 20 s); (3) rebase subplans lên main (`rebase --onto origin/main 1027a21d` nếu #827 squash),
  npm test đủ, `handoff inbox-list-subplans` → PR → review → merge+deploy → đo lại (mục tiêu p95 < 2 s).
- Việc sau: phân trang con trỏ 30–50, memo bộ đếm, «chờ trả lời» (WAITING_REPLY_SQL) gộp vào định nghĩa #803 (cần cột lưu sẵn mới), «AI gửi hỏng ⇒ vẫn chờ».

### ĐÃ XONG hôm nay (đừng làm lại)
- #821 hậu mãi: AI im 751→149, KHÔNG CHỦ 127→0. Release POST_ORDER cũ **39/39 xong** (4 lô; mã lượt rel-20261013064629-kmi3 · rel-20261013091310-ftwe ·
  rel-20261013102634-5wgs · rel-20261013112843-yzkn — hoàn tác `--rollback=<mã> --apply`); 66 hội thoại còn lại cần NGƯỜI (49–50 khách đang chờ).
- #819 giỏ dính: CART_INTENT_DRIFT 13/368 → **0/218**, ORDER_READY_LOOP 22/215 → **1/99**. #804 Customer 360, #823, #824, #826 trên production.

### KHÁC
- **Trung tâm giá vốn ERP** (ưu tiên chủ shop 13/10): CHƯA có sứ mệnh/đặc tả trong sổ (chỉ có `unknown-cost-not-zero` P2 VERIFYING). Team: hỏi chủ shop
  đặc tả hoặc đọc yêu cầu gốc, rồi `claim` MỘT sứ mệnh — không tự bịa phạm vi. Luật liên quan: AGENTS 3.13 (giá vốn «sống»), 3.14–3.15, 3.18.
- qa 0245: rehearsal #814 (nháp, PASS review) — chạy sau P0 inbox, không cùng lúc deploy.
- Chủ shop: xếp người phòng «Kinh doanh & CSKH» HSLC; dọn Google Drive.

### KHÔNG ĐƯỢC
Không bật API trả phí / usage credits; không chép credential giữa hai tài khoản; không bỏ PR gates/review; không ghi production ngoài ops có chạy thử + duyệt.

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

### LÀM RÕ (sau bàn giao thử 13/10)
- Điều kiện chủ shop cho release 40 hội thoại POST_ORDER: lô nhỏ (≤ 10/lượt), có audit + rollback theo run id, KHÔNG gửi lại tin cũ,
  KHÔNG kích follow-up hàng loạt, KHÔNG tạo đơn trùng, KHÔNG mất handoff cần người (49 hội thoại khách đang chờ phải ở lại).
- inbox-list-perf: gộp `fix/inbox-perf-probe-topn` (CHỈ công cụ đo, script) TRƯỚC để đo top-N câu chậm; `fix/inbox-list-perf` là bản SỬA chính.
  Hai nhánh này chưa có trên remote khi ghi checkpoint — kiểm `git ls-remote origin 'fix/inbox-*'`.
- Deploy 935ffdb2: run 38326139783 (đỏ vì verify qa; smoke 134/134 — đọc log bước «SSH vào VPS và chạy bootstrap»).
- sticky-cart AFTER: đã hẹn chạy 10:00Z 13/10 (phiên Max); nếu checkpoint chưa có số AFTER thì chạy lại lệnh ở bảng.
- Thứ tự #823 → #804: hàng đợi tự chặn (HIGH đi riêng — WAIT_SERIAL), chỉ cần chạy `merge` theo thứ tự.

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
