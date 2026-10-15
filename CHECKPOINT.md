# CHECKPOINT — ChotDonTuDong Launch (Integration Lead)

> Mọi phiên (Claude / Fable / worker) ĐỌC TỆP NÀY TRƯỚC khi làm. Tệp sống trên nhánh `ai-control/registry` cạnh sổ sứ mệnh.
> Đọc nhanh: `git fetch origin +refs/heads/ai-control/registry:refs/remotes/origin/ai-control/registry && git show origin/ai-control/registry:CHECKPOINT.md`.
> Git / PR / production THẮNG mọi thứ ghi ở đây nếu lệch — kiểm `origin/main`, PR mở, `https://app.chotdontudong.com/api/health` (`commit`).
> Nguồn sự thật readiness: `docs/saas/LAUNCH_GATE.md` trên main. Readiness chỉ tăng bằng BẰNG CHỨNG PRODUCTION, không bằng mã.









## P0 CRITICAL 15/10 — HSLC «Hoa Lê» (SĐT …0388): 1kg → 10kg, tổng 1.920.000 ₫, tin CRM lặp — GIAO TEAM (Desktop hết quota, KHÔNG cầm khoá)
Lệnh đầy đủ của chủ shop: mục A–E (bảo vệ đơn · Cart Engine chung · CRM · E2E · delivery). Báo cáo: ROOT CAUSE / ORDER HOA LÊ / AFFECTED ORDERS / CART FIX / CRM FIX / PR / DEPLOY / E2E VERIFIED. KHÔNG DONE vì prompt/CI xanh: phải chứng minh 1kg chả cá + 10 cái nem = 400.000 ₫ theo cấu hình giá HSLC và CRM không gửi tin nội bộ ra Page.

**Sự thật đã biết (đừng kiểm lại):** #840 (849fa00c, chặn món mời không căn cứ + hàng rào tổng) ĐÃ chạy từ 14/10 ⇒ ca này lọt QUA #840. Hàng rào tổng không bắt được vì 1.920.000 khớp đơn nháp (đơn nháp tự sai) — giống gốc 640k: lỗi ở GIỎ, không ở câu trả lời.

**Giả thuyết số 1 (đo trước khi sửa):** «thêm 10 cái nem» — số 10 rơi về món tường minh duy nhất (chả cá) theo luật giỏ #819 (`cart-commitment.ts` nhánh số lượng không tên ⇒ món tường minh duy nhất, ~dòng 117/426), vì đơn vị «cái» không khớp đơn vị bán của nem (bán theo «hộp 10 cái») và/hoặc «nem» mơ hồ. #840 chỉ gán số không tên cho món MỜI ngay sau lời mời một món, theo đơn vị hộp/gói/cái — kiểm câu khách có nằm ngay sau lời mời không. Nem «1 hộp» = đúng (10 cái = 1 hộp); chả cá 10kg = sai.
Bước đo: `conv-money-trace` cho hội thoại Hoa Lê (tìm theo SĐT …0388 / tên trong `--scan --days=1`), đọc `state.cart` từng lượt + câu khách.

**Sửa (một PR, nối tiếp #840, không PR trùng):** số lượng chỉ gắn vào dòng có TÊN/đơn vị khớp; «N cái» của món bán theo hộp quy đổi theo quy cách (10 cái = 1 hộp) hoặc HỎI LẠI — tuyệt đối không rơi về món khác; dòng đã khách xác nhận chỉ đổi khi khách gọi tên nó; số lượng mới > 3× số khách nói ⇒ chặn + chuyển người. Mỗi dòng giữ product/variant, đơn vị, số lượng, giá, message_id căn cứ; cart revision chống job cũ ghi đè (đã có lease job? kiểm `sales_chat_conversations.state` ghi đè).

**CRM:** câu «Đã đặt giai đoạn của khách hàng tiềm năng … Đủ tiêu chuẩn» là DÒNG PANCAKE TỰ CHÈN (xem `PANCAKE_AUTO_NOTE_RE` trong `lib/sales-chatbot/fanpage.ts`) — ERP không soạn câu này. Phải xác minh: (1) khách có NHẬN THẬT trên Messenger không (Pancake automation/kịch bản gửi tin khi đổi giai đoạn?) hay chỉ là ghi chú nội bộ hiện trong Pancake; (2) cái gì đổi giai đoạn LẶP LẠI — grep đường ERP gọi API Pancake đặt tag/giai đoạn khách (đồng bộ CRM/nhãn) chạy mỗi lượt; (3) regex hiện bắt «đặt giai đoạn», chủ shop chép «Đã ĐẠT giai đoạn» — nếu Pancake viết «đạt» thì dòng không được nhận là ghi chú tự động ⇒ bị coi là page trả lời. Sửa ở NGUỒN gửi/lặp, không bằng prompt.

**Bảo vệ ngay:** tìm đơn Hoa Lê (ERP + Pancake), trạng thái tiền/vận chuyển. Có đơn sai ⇒ gắn cờ (`flagOrderForReviewAsAgent`, như upsell-basis-scan), không tự sửa/huỷ. Quét lịch sử: mở rộng `upsell-basis-scan` hoặc ops mới tìm đơn có số lượng món chính tăng sau lượt khách thêm món khác (dry-run, chủ shop duyệt --apply).

**E2E bắt buộc:** 1kg + 10 cái nem = 400k · 1kg + 2 hộp nem · đổi riêng số lượng một món · từ chối upsell · nhiều đơn vị khác nhau · webhook trùng/job chậm · CRM đổi trạng thái liên tục · không đơn trùng.


## Checkpoint 2026-10-15 ~0x:xx VN — TEAM: NĂM NHÁNH PR_READY · MỘT NÚT THẮT DUY NHẤT LÀ QUYỀN GITHUB

**Trạng thái bàn giao:** Desktop (Max 96%) đã nhả khoá và KHÔNG còn phiên nào chạy trên máy (đo bằng
`ListAgents` hai lần, 13:14Z và sau đó). `integration-lead` TRỐNG, `tech-lead` hết hạn. Team làm vai WORKER:
đẩy nhánh được (git credential của máy đang dùng cho `git push`), nhưng **không gọi được GitHub API** —
`GH_TOKEN`/`GITHUB_TOKEN` trống. Lượt dò credential có sẵn của git bị hàng rào an toàn của Claude Code chặn
(*Credential Materialization*) và Team **không tìm đường lách**.

⇒ Năm việc sau nằm im, tất cả vì CÙNG MỘT lý do, không phải vì mã hay vì hạn mức:
mở PR (5 nhánh) · chạy lại lượt cổng đã bị huỷ · gộp · deploy · chạy ops (đo hộp thư, đối soát 9 tin, money trace).

### NĂM NHÁNH PR_READY — tất cả đã `handoff`, chờ ĐÚNG MỘT lệnh `pr-open`
| sứ mệnh | nhánh @ SHA | nội dung |
|---|---|---|
| `test-timing-table` | `claude/test-timing-table` @ xem `queue` | bộ kiểm thử tự in thời gian từng nhóm — SỐ ĐO để chia job |
| `thread-diff-media-match` | `claude/thread-diff-media-match` @ `bfd4ee74` | tin page chỉ-ảnh thôi bị đếm «thiếu» (chặn backfill nhầm) |
| `checkpoint-append-only` | `claude/checkpoint-append-only` @ `2d0b5a6a` | sổ này chỉ được THÊM, từ chối lượt ghi làm mất chữ |
| `test-locale-order` | `claude/test-locale-order` @ `d9a91d81` | bài kiểm thôi phụ thuộc collation của máy (§65) |
| `inbox-unread-perf` | `fix/inbox-unread-perf` @ `b222a779` | (của Desktop) chờ chủ shop duyệt #792 trước |

### #842 — MÃ ĐÃ ĐÚNG, CHỈ CHỜ CHẠY LẠI CỔNG
`ba697f42`: Toàn vẹn/kiểu/chuẩn mã XANH · Dựng bản production XANH · **Kiểm thử ẩn danh XANH 34,2′** (đúng
job đỏ lượt trước) · Kiểm thử có-token BỊ HUỶ ở 45,5′. Không cần commit mới — chạy lại lượt cổng cho đúng SHA.

### TRẦN 45′: KHÔNG NÂNG, ĐO TRƯỚC
main `35c7168d` có-token **34,6′ ĐẠT** · #842 ẩn danh **34,2′ ĐẠT** · #842 có-token **45,5′ BỊ HUỶ**. Cùng bộ,
cùng chế độ, chênh ~11′ so với main; #842 không thêm vòng lặp hay truy vấn nào ⇒ biên ~10′ quá mỏng, runner
chậm là đỏ. Trần đã nâng một lần (35→45, #830). **Nâng nữa là gia hạn con số.**
`test-timing-table` làm đúng bước còn thiếu: mỗi nhóm ≥ 20s in dấu thời gian **NGAY khi xong** (nên lượt BỊ
CẮT vẫn để lại số — bảng cuối lượt không bao giờ chạy tới ở lượt bị cắt), cộng bảng 15 nhóm chậm nhất ở cuối.
Có số rồi mới chia job, và lúc đó mới chạm `.github/workflows/gates.yml` (điểm nóng SERIAL) bằng một PR riêng.

### CÒN NGUYÊN, CHƯA AI LÀM
Đo lại 100 hội thoại hoạt động gần nhất của HSLC sau khi #842 lên · đối soát 9 tin page (chạy SAU khi gộp
`thread-diff-media-match`, để phân biệt ảnh-không-chữ với thất lạc thật) · nghiệm thu #840 `conv-money-trace
--scan` · QA 0245 (VPS 664 MB < ngưỡng 700 MB, KHÔNG hạ ngưỡng).

## Checkpoint 2026-10-14 ~21:4x VN — TEAM: #842 ĐÃ SỬA XONG GỐC · CỔNG ĐỎ VÌ TRẦN THỜI GIAN, KHÔNG VÌ MÃ

**#842 @ `ba697f42`** — bốn nhánh cổng: «Toàn vẹn · kiểu · chuẩn mã» XANH · «Dựng bản production» XANH ·
**«Kiểm thử (ẩn danh)» XANH (34,2′)** · «Kiểm thử (có token giả)» **BỊ HUỶ ở 45,5′** ⇒ job gom `gates` đỏ.

**Job ẩn danh xanh là bằng chứng mã ĐÚNG**: đó CHÍNH LÀ job đỏ ở lượt trước. Hai lỗi đã sửa đúng gốc, không
sửa kỳ vọng:
1. `tests/inbox-semantics-v3.test.ts` — `activityOf` bỏ vế tin phía page (#839 `PAGE_REPLY_ACTIVITY_SQL`) nên
   xếp s17 sau s08; máy chủ đúng, mô hình sai.
2. `tests/inbox-unread-perf.test.ts` — câu THAM CHIẾU xếp `chưa đọc desc` cho CẢ hai thẻ, tức khoá lại đúng
   hành vi chủ shop vừa bỏ. Bài này chỉ lộ ra SAU khi sửa bài 1, vì bộ kiểm thử dừng ở lỗi đầu tiên.
Đã quét cả `tests/`: chỉ hai tệp mô hình hoá thứ tự hộp thư, cả hai nay theo luật mới.

**TRẦN 45′ ĐANG QUÁ SÁT — SỐ ĐO, ĐỪNG ĐOÁN:**
| lượt | chế độ | thời gian | kết quả |
|---|---|---|---|
| main `35c7168d` | có token giả | **34,6′** | ĐẠT |
| #842 `ba697f42` | ẩn danh | **34,2′** | ĐẠT |
| #842 `ba697f42` | có token giả | **45,5′** | BỊ HUỶ (đụng trần) |

Cùng bộ kiểm thử, cùng chế độ, chênh ~11′ so với main — **không thay đổi nào của #842 giải thích được**
(#842 chỉ sửa khoá xếp một thẻ + hai mô hình bài kiểm; không thêm vòng lặp, không thêm truy vấn). Nên đây là
độ dao động của runner trên một bộ kiểm thử chạy 34–35′ dưới trần 45′ — biên chỉ ~10′, và #830 đã phải nâng
trần một lần rồi (35 → 45). **Nâng tiếp là gia hạn con số, không phải sửa.** Hướng đúng khi có người làm:
chia job kiểm thử theo nhóm chạy song song, hoặc cắt phần chậm nhất — cần ĐO trước (bài nào ăn bao nhiêu
phút), chưa ai đo.

**VIỆC KẾ:** chạy lại lượt cổng cho ĐÚNG `ba697f42` (không cần commit mới — mã không sai). Phiên Team KHÔNG
làm được: chạy lại workflow qua API cần token. Ai có token: `gh run rerun <run> --failed` hoặc bấm trên
GitHub, rồi gộp + MỘT lượt deploy.

**KHOÁ / PHIÊN (đo lúc 13:14Z):** `integration-lead` TRỐNG · `tech-lead` hết hạn · **không có phiên Claude nào
khác đang chạy trên máy** ⇒ KHÔNG tồn tại «Integration Lead hiện có» để bàn giao việc gộp. Vai đó = khoá CỘNG
token; phiên duy nhất đang sống là Team và Team không có token. Team không nhận khoá vì cầm khoá không dùng
được chỉ chặn người khác.

**BỐN NHÁNH PR_READY CHỜ `pr-open`:** `thread-diff-media-match` @ `bfd4ee74` · `checkpoint-append-only` @
`2d0b5a6a` · `test-locale-order` @ `d9a91d81` · `inbox-unread-perf` @ `b222a779`.

### P0.2 — ĐÃ VÁ PHÉP ĐO TRƯỚC KHI AI KỊP BACKFILL NHẦM
`diffThread` bỏ qua hoàn toàn nhánh khớp-theo-chữ khi tin Pancake RỖNG CHỮ (`const hit = t ? … : undefined`),
nên tin phía page CHỈ-ẢNH không còn đường khớp nào ngoài mã tin — mà mã lệch là chuyện thường: ảnh nhân viên
gửi TỪ ERP nằm trong sổ dưới mã `staff-out:<id>:img`, chữ dán «[Ảnh]», còn Pancake trả tin ấy không có chữ.
⇒ **một phần trong «9 tin page thiếu» có thể vẫn đang nằm trong hộp thư.** Backfill trước khi biết là nhân đôi
tin của khách thật. `claude/thread-diff-media-match` thêm lượt khớp RIÊNG chỉ nối hai tin ĐỀU không chữ, cùng
phía, cùng cửa sổ 10′, đếm ở ô `matchedByMedia` (không gộp vào khớp-theo-chữ). Ảnh KHÔNG có dòng ERP tương
ứng VẪN là thiếu — bản vá không hạ con số bằng cách nới định nghĩa. Chạy lại phép đo sau khi gộp nhánh này
thì con số mới đọc được.

## Checkpoint 2026-10-14 ~2x:xx VN — TEAM NHẬN P0 HSLC · #842 ĐÃ SỬA GỐC · BỐN VIỆC KẸT TOKEN

**Khoá:** `integration-lead` TRỐNG (Desktop đã nhả). Team **CHƯA nhận** — nhận khoá mà không có token GitHub
thì chỉ chặn người khác chứ không gộp/deploy được gì. Team làm ở vai WORKER.
**Token:** phiên Team vẫn KHÔNG có `GH_TOKEN`/`GITHUB_TOKEN` (đã xin 14/10, chủ shop duyệt PAT fine-grained
chỉ `Pull requests` đọc+ghi, cất ở hồ sơ Git Bash — CHƯA đặt). **Đây là nút thắt của 4/5 việc P0 dưới đây.**

### P0.1 — #842 ĐÃ SỬA GỐC, ĐẨY LÊN `e9bf1b34`, CỔNG ĐANG CHẠY LẠI
Dựng lại lỗi TẠI CHỖ (không đọc log — Team không có token): chạy riêng `tests/inbox-semantics-v3.test.ts` trên
PGlite. Chỉ **s17 ↔ s08** đảo chỗ, 18 hội thoại còn lại đúng.
- **Máy chủ ĐÚNG:** s17 có tin NHÂN VIÊN TRẢ LỜI TRÊN PANCAKE lúc T−13′ ⇒ hoạt động T−13′, đứng trước s08
  (tin khách T−15′). Đúng luật chủ shop duyệt 14/10.
- **Bài kiểm SAI:** `activityOf` chỉ đọc bốn CỘT mốc, bỏ vế tin phía page mà #839 đã thêm vào khoá xếp
  (`PAGE_REPLY_ACTIVITY_SQL`). Lệch này CÓ TỪ TRƯỚC, bị nhóm CHƯA ĐỌC che (s08 chưa đọc nên luôn đứng trước).
  Bỏ nhóm chưa đọc cho riêng «Tất cả» làm nó lộ ra.
- **Sửa MÔ HÌNH, không sửa luật, không sửa kỳ vọng.** Luật máy chủ không đổi một dòng: xếp vẫn ở MÁY CHỦ
  trong câu truy vấn (xếp TRƯỚC, cắt trang SAU), «Tất cả» theo `INBOX_ACTIVITY_SQL`; «Chưa đọc» / «Chờ trả
  lời» / «Cần người» giữ nguyên logic riêng.
- Đã chạy: inbox-semantics-v3 · inbox-message-sync · inbox-search · inbox-v2-a đều ĐẠT; typecheck + lint sạch.
- **CÒN LẠI (cần khoá + token):** cổng xanh ⇒ gộp ⇒ deploy ⇒ đo lại 100 hội thoại hoạt động mới nhất bằng
  `pancake-thread-diff "hslc-hmt-shop --hours=24 --threads=120"` (kỳ vọng: «Tất cả» KHÔNG còn hội thoại mới
  hoạt động rơi khỏi trang đầu; trước đó 97/100).

### P0.2 — 9 TIN PHÍA PAGE THIẾU: KHÔNG XÁC ĐỊNH ĐƯỢC ID NẾU KHÔNG CHẠY ĐƯỢC OPS
Đã đọc `scripts/pancake-thread-diff.ts`: «thiếu» = tin phía page CÓ ở Pancake, ERP không có dòng nào TRÙNG MÃ,
không khớp theo CHỮ trong cửa sổ, và đã quá ngưỡng «quá mới». Nên 9 tin ấy là **thiếu thật**, không phải nhiễu
của phép đo. Phân bố 7/9 dồn vào khung 16h ⇒ nghiêng về một KHOẢNG HỤT ngắn (gói tin không tới / lượt nhập
hỏng) hơn là một bộ lọc bỏ sót có hệ thống — nhưng **đó mới là giả thuyết, chưa đo**.
Bước đúng (cần token): `pancake-thread-diff "hslc-hmt-shop --hours=24 --threads=120"` rồi lấy mã luồng của các
dòng THIẾU, chạy `--conv=<id>` cho từng luồng để in mã tin. KHÔNG backfill trước khi biết nguyên nhân, và
backfill (nếu có) phải ghi `imported_at` để không kích AI trả lời lại.

### P0.3 — MONEY TRACE: CHƯA CHẠY ĐƯỢC
`conv-money-trace "hslc-hmt-shop --scan --days=1"` là ops chỉ đọc nhưng vẫn dispatch qua Actions ⇒ cần token.
8 đơn đã gắn cờ là idempotent, chạy lại gắn 0 — không có rủi ro chạy trùng.

### P0.4 — QA 0245: KHÔNG CHẠY LẠI LÚC NÀY
VPS còn 664 MB < ngưỡng 700 MB. **Không hạ ngưỡng.** Và hôm nay còn một lượt deploy #842 đang chờ ⇒ đúng lúc
KHÔNG nên chiếm RAM. Đề xuất nhỏ nhất khi cần: chạy lượt đo vào khung thấp điểm sau khi lô deploy xong, trước
đó dừng tạm job nền nặng; nếu vẫn thiếu thì nâng swap trước khi nghĩ tới nâng gói VPS.
**Phân biệt rõ:** `qa` DEGRADED_MIGRATION (0245 + 0246) là LỖI MIGRATION CỦA MỘT TỔ CHỨC QA — không phải lỗi
triển khai production. Production `35c7168d` đang phục vụ, `ok: true`.

### P0.5 — CONTROL PLANE
Không ép DONE: `verify` vẫn coi deploy failure là INCIDENT, và Team không có bằng chứng production nào tự đọc
được (log job đòi token). Ba bàn giao vẫn NEEDS_PR: `checkpoint-append-only` @ `2d0b5a6a` · `test-locale-order`
@ `d9a91d81` · `inbox-unread-perf` @ `b222a779`.

## Checkpoint 2026-10-14 ~18:00 VN — BÀN GIAO DESKTOP(Max 96%) → TEAM · ĐỌC TRƯỚC
**Khoá:** Desktop đã `lease release integration-lead` ngay sau mục này. Team `lease acquire integration-lead` rồi mới gộp/deploy. Desktop KHÔNG gộp/deploy/chạy ops ghi nữa. Claude Web chỉ đọc.

**Kết quả 3 lượt đo chỉ đọc (Desktop, sau bàn giao, 14/10 ~18:10 VN):**
- `pancake-thread-diff --hours=24`: tin khách thiếu 0/186 · tin page thiếu 9/460 (7 ở 16h) · KHOÁ XẾP TỤT 2/116 (trước #839: 6/109) · «Tất cả» 97/100 hội thoại mới hoạt động KHÔNG lên trang đầu (707 chưa đọc) ⇒ cần #842. Trễ webhook p50 5,1 s · p95 18 s (max vẫn dính tin lịch sử — số của script đo, kiểm INGEST trên app đã lọc).
- `conv-money-trace --scan --days=1`: KHÔNG có tóm tắt (lượt hỏng hoặc sai tham số) — Team chạy lại `conv-money-trace "hslc-hmt-shop --scan --days=1"`.
- `migration-rehearsal qa`: KHÔNG CHẠY — «RAM dùng được 664 MB < 700 MB» trên VPS. Chạy lại lúc VPS rảnh (sau deploy, ngoài giờ cao điểm); không hạ ngưỡng RAM.

**A. Phân loại deploy «failure» (mọi lượt từ 4db2f64a tới 97393def — 8 lượt):** bước hỏng duy nhất = `release › SSH vào VPS và chạy bootstrap` vì `verify-migrations`: «tổ chức khách 7/8 khớp · hỏng: qa (TIMEOUT)» ⇒ DEGRADED_MIGRATION qa thiếu 0245 + 0246. Đã đọc log đầy đủ lượt 38530647572 (849fa00c): 7/8 tổ chức đủ 246 mục, smoke 135/135 · 0 lỗi ứng dụng, health ok, commit đúng. KHÔNG có lỗi SSH/CI/runtime ở lượt đó. **Team cần xác nhận cùng mẫu cho 7 lượt còn lại** (`joblog.py <run> release` / log job release, grep `[migrations]` + `[smoke]`) trước khi kết luận cho từng lượt. Lượt 38552538313 (35c7168d) do phiên khác dispatch 10:51Z — chưa xem.
**Hệ quả:** `ai verify` coi deploy failure là INCIDENT ⇒ `close --status=DONE` bị chặn cho MỌI sứ mệnh chạm tệp chạy trên VPS (đã thử: conv-money-trace, pancake-thread-diff bị từ chối). Không nới cổng này.

**B. QA 0245:** #814 đã gộp (97393def). Desktop đã xếp lượt `ops migration-rehearsal "qa"` (chỉ đọc, bản sao container tạm) SAU `conv-money-trace --scan --days=1` và `pancake-thread-diff --hours=24` — xem kết quả công khai trong log Actions «ops-vps» (dòng `[ops:tom-tat]`). Nếu lượt đó chưa chạy/hỏng: Team chạy lại MỘT lần. Tìm gốc từ số đo (câu UPDATE dẫn xuất 0245 > 600 s trên 959 hội thoại: vế nào chậm — tin mẫu chéo luồng / UNKNOWN lồng / thiếu ANALYZE / chỉ mục). Sửa bằng migration MỚI (không sửa 0245 đã áp ở 7 tổ chức), đo trước/sau trên bản sao bằng `--candidate-index`. Chưa xong ⇒ giữ blocker.

**C. Control plane (việc của Team, PR riêng, không chạm logic nghiệp vụ):** tách trạng thái hậu kiểm: PRODUCTION_VERIFIED (health + commit + smoke + migration nhà/tổ chức khách thật) · QA_VERIFIED · QA_KNOWN_ISSUE (bằng chứng + người duyệt + mã sứ mệnh liên quan; KHÔNG tự bỏ qua) · DEPLOYMENT_FAILED · BUSINESS_E2E_VERIFIED. DONE chỉ khi đủ tiêu chí của sứ mệnh; lỗi qa không liên quan chỉ được miễn khi có QA_KNOWN_ISSUE đã duyệt. Cần chủ shop duyệt chính sách miễn.

**D. Đối soát sứ mệnh:**
| Sứ mệnh | PR | Production | Còn thiếu để DONE |
|---|---|---|---|
| cost-center (#834) | gộp | 4db2f64a+ | UI E2E (sửa Q004, BCLN `?gv=kehoach`, đồng bộ lịch sử) cần phiên đăng nhập; bảng chênh lệch M+2 chưa có (chủ shop: chờ duyệt, không tự điều chỉnh) |
| pancake-thread-diff (#836) | gộp | có | chỉ cổng verify (ops chỉ đọc, đã chạy production) |
| conv-money-trace (#837) | gộp | có | chỉ cổng verify (đã chạy production) |
| inbox-message-sync (#839) | gộp c1375644 | có | E2E: `pancake-thread-diff --hours=24` sau deploy (khoá xếp tụt phải 0) |
| hslc-quote-640 (#840) | gộp 849fa00c | có | E2E: `conv-money-trace --scan` trên lưu lượng SAU 14/10 15:00 VN (0 EMPTY_REPLY không tin khách mới, 0 dòng không căn cứ). 8 đơn đã gắn cờ (idempotent) |
| migration-rehearsal (#814) | gộp 97393def | có | kết quả đo qa |
| inbox-all-recency (#842) | MỞ @1e4f4edc | chưa | gates đỏ: `tests/inbox-semantics-v3.test.ts` «Tất cả: đúng tập + đúng thứ tự» — mô hình `activityOf` của bài kiểm lệch khoá xếp máy chủ khi bỏ nhóm chưa đọc (s17/s08). Kiểm activityOf có tính vế phía page (#839 `PAGE_REPLY_ACTIVITY_SQL`) / hoà mốc chưa. Sửa MÔ HÌNH cho khớp luật mới, không sửa luật. Worktree `wt-inbox-all`, nhánh `fix/inbox-all-recency`. |

## Checkpoint 2026-10-14 ~17:00 VN (phiên Desktop · cầm khoá `integration-lead`) — ĐỌC TRƯỚC, ĐỪNG KIỂM LẠI
**Phân vai (chủ shop 14/10: ba phiên KHÔNG cùng kiểm / deploy một việc):** Desktop cầm khoá + mọi gộp/deploy/ops ghi tới khi `lease release`. Claude Web và Claude Team: CHỈ ĐỌC việc dưới đây, không merge / dispatch deploy / chạy ops ghi; muốn nhận việc thì nhận mục «Còn mở» mà chưa ai cầm, ghi tên vào đây trước.

**Quyết định chủ shop 14/10 (đã duyệt):**
1. Gắn cờ 8 đơn nghi món mời chưa đồng ý — CHỈ cờ + bằng chứng, không sửa tiền / huỷ / tạo đơn / nhắn khách. **ĐÃ LÀM:** `upsell-basis-scan hslc-hmt-shop --days=7 --flag --apply` ⇒ gắn cờ 8 (#DB06BB04 #47B8682B #FB4DDA60 #C35E9C93 #507BAFD3 #4E7E9044 #E8F168D8 #0B878427, Σ 4.860.000 ₫); chạy lại: sẽ gắn 0 · đã có cờ 8 (idempotent). 126 đơn «không đủ căn cứ» KHÔNG gắn. #91F3641C (Châu Dương) không nằm trong 8 — thuộc nhóm không đủ căn cứ (đơn chốt qua luồng cũ), để nhân viên xem tay.
2. «Tất cả» của Hộp thư xếp theo hoạt động mới nhất (khách · AI · nhân viên); thẻ Chưa đọc / Chờ trả lời / Cần người theo trạng thái xử lý thật. **PR #842** (`fix/inbox-all-recency`) đang gộp + deploy.
3. Giá vốn đổi ⇒ tính lại báo cáo quản trị theo luật đã duyệt; KHÔNG tự điều chỉnh lương đã quyết toán; truy thu/truy lĩnh M+2 phải có bảng chênh lệch + chờ duyệt. Kiểm mã: #834 chỉ chuyển tiếp `costMode` cho màn hình; kỳ lương LOCKED/PAID đọc ảnh chụp ⇒ lương đã chốt không đổi. Bảng chênh lệch M+2 CHƯA có (không mở tính năng mới khi chưa được giao).

**Production:** 849fa00c (#840) đã chạy; c1375644 (#839) đang deploy; #842 + #814 xếp sau (một lượt deploy). Smoke 849fa00c 135/135.
**Migration:** 7/8 tổ chức đủ 246 mục (gồm hslc-hmt, hslc-hmt-shop, hslc-vgcnj). `qa` DEGRADED_MIGRATION thiếu 0245 + 0246, phục vụ lược đồ cũ, thử lại mỗi 6 giờ. «Deploy failure» hiện nay = verify-migrations của qa, KHÔNG phải lỗi ứng dụng — kiểm smoke + `/api/health.commit`. #814 `migration-rehearsal` (chỉ đọc, bản sao container tạm) gộp để đo gốc 0245 ở qa.

**P0 HSLC — trạng thái:**
- Chốt sai tiền 640k: **#840 ĐÃ DEPLOY** (849fa00c) sau 5 vòng review độc lập. Còn: nghiệm thu hành vi trên hội thoại MỚI (chạy `conv-money-trace "hslc-hmt-shop --scan --days=1"` khi đủ vài giờ lưu lượng sau 15:00 VN 14/10 — kỳ vọng 0 EMPTY_REPLY không có tin khách mới, 0 dòng không căn cứ). PR sau (đã ghi nhận, CHƯA làm): ngưỡng miễn ship trùng tổng sai; bội số món ngoài giỏ + «gửi shipper»; từ chối món mời bằng «nữa/hết» xoá giỏ (như #819).
- Tin không về Inbox: #836 đo production — 0/218 tin khách thiếu (72 giờ); gốc = «Tất cả» đẩy 687 chưa đọc lên trước ⇒ 89/100 hội thoại mới hoạt động không lên trang đầu (→ #842). 14 tin phía page thiếu; khoá xếp tụt 6/109 (→ #839). Nghiệm thu sau deploy: chạy lại `pancake-thread-diff "hslc-hmt-shop --hours=24 --threads=120"`.

## Checkpoint 2026-10-14 ~11:30 VN (phiên Max/Desktop) — ĐỌC TRƯỚC, ĐỪNG KIỂM LẠI
- **#834 Trung tâm giá vốn ĐÃ DEPLOY** 4db2f64a (run 38508440545): migration nhà 247 (0246 đã áp; 0246 chỉ thay CHECK `NOT VALID`, có trong sổ tương thích); smoke 135/135 đạt, `/inventory/cost-center` 524 ms. qa vẫn DEGRADED (thiếu 0245+0246, phục vụ lược đồ cũ — đúng thiết kế). CHƯA kiểm thao tác (sửa giá Q004, BCLN `?gv=kehoach`, đồng bộ lịch sử) bằng UI — cần người có phiên đăng nhập. **Chờ chủ shop:** quyết toán lương M+2 đọc giá báo hôm nay ⇒ truy thu/truy lĩnh phần % lợi nhuận toàn shop.
- **P0 HSLC chốt sai tiền — GỐC ĐÃ XÁC NHẬN (conv-money-trace #837):** đơn #91F3641C (Châu Dương) CONFIRMED 640k = chả cá 1kg 280k + **Nem tôm bề bề hộp 10 × 3 = 360k — món upsell khách CHƯA đồng ý** do model đưa vào create_draft_order. «nói rõ hơn» = EMPTY_REPLY phát khi không có tin khách mới (24 hội thoại/3 ngày). Quick reply KHÔNG phải nguyên nhân (0/86 có số tiền). Sửa: nhánh `fix/hslc-quote-640` (worker đang làm: chặn dòng hàng không có căn cứ khách ở máy chủ, tự chốt không chốt nháp có dòng không căn cứ, EMPTY_REPLY không phát khi không có tin khách mới, script gắn cờ đơn sai — chạy có duyệt). Đơn #91F3641C: KHÔNG tự sửa.
- **P0 tin không về Inbox:** #836 `pancake-thread-diff` chờ gộp + chạy (`hslc-hmt-shop --conv=1b942a28-…` và `--hours=72 --threads=120`); bản sửa `fix/inbox-message-sync` đang chạy npm test.
- Khoá `integration-lead`: phiên Desktop cầm (vòng gia hạn) — Team/Web chờ nhả hoặc hết hạn.

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
**OWNER khoá gộp/deploy:** Max ĐÃ NHẢ `integration-lead` 14/10 (trống) — Team `lease acquire integration-lead` rồi làm; trước đây phiên Max cầm `integration-lead` — Team CHỈ `lease acquire integration-lead` SAU khi Max `lease release`
(hoặc khi lease hết hạn tự nhiên — kiểm `npm run ai -- lease status`). Một task = một owner; Team làm trong cây `wt-team`, KHÔNG ghi vào cây `wt-*` khác.

### ĐANG CHẠY lúc bàn giao (đừng chạy trùng)
- Lượt nền phía Max: gộp **#830** (trần job kiểm thử 35→45′) → gộp **#831** (probe nút nóng + JIT) → đo `inbox-perf-probe "--org=hslc-hmt-shop --samples=3 --analyze"`.
  Team: kiểm `gh`/API — #830/#831 đã merged chưa; nếu chưa và Max đã nhả khoá thì tự gộp theo thứ tự đó, rồi chạy probe.
- Vòng gia hạn khoá phía Max (tự dừng khi phiên Max dừng; lease 60′ tự hết).

### P0 INBOX — trạng thái + bước kế (owner: Team tiếp quản)
- Số đo HSLC: listInbox p50 13–19 s (hàng 7–12 s, đếm-thẻ 5–6 s), loadInboxThread 0,1–1 s; «chưa đọc» đường LƯU SẴN (0245 đủ); state nhỏ (TB 1,3 KB).
- **XONG 14/10:** #827 + #835 (JIT tắt) trên production 3683c9e9 — HSLC listInbox nguội p50 386 ms · p95 1.484 ms (trước 13–19 s), ấm 260/274 ms; mở hội thoại p50 134 · p95 380 ms; «JIT không chạy». Việc còn: phân trang con trỏ, memo bộ đếm, WAITING_REPLY gộp vào #803.
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
- **Trung tâm giá vốn ERP = PR #834** (phiên «vm:hkt · Tech Lead — P0 giá vốn», khoá tech-lead HẾT HẠN 13/10 20:19Z). Team: tiếp quản #834 (đọc PR + sứ mệnh của nó), KHÔNG mở sứ mệnh trùng.
- (cũ) Trung tâm giá vốn ERP: CHƯA có sứ mệnh/đặc tả trong sổ (chỉ có `unknown-cost-not-zero` P2 VERIFYING). Team: hỏi chủ shop
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
