# Tiến độ release "ERP Data Truth"

Nhánh: `claude/erp-data-truth-p0` · tách từ `main` tại `cf90934`.
Quy tắc: mỗi task một commit riêng, KHÔNG deploy giữa chừng, KHÔNG merge `main` giữa chừng.
Chỉ deploy MỘT LẦN sau khi FINAL GATE đạt.

Kế hoạch gốc: `CLAUDE_ERP_MASTER_PLAN.md` (chủ shop giao).
Kiểm toán nền: `docs/erp-data-truth-audit.md`.

| Task | Nội dung | Trạng thái | Commit |
|---|---|---|---|
| 1 | Kiểm toán kiến trúc & data truth | ✅ xong | `docs: audit ERP data truth architecture` |
| 2 | Chuẩn hoá lớp chân lý nghiệp vụ | ✅ xong | `feat: centralize canonical order shipment payment truth` |
| 3 | Cứng hoá nạp dữ liệu Viettel Post | ✅ xong | `feat: harden ViettelPost event ingestion` |
| 4 | Bộ máy đối soát | ✅ xong | `feat: add shipment reconciliation safeguards` |
| 5 | Lớp chân lý chỉ số | ✅ xong | `feat: centralize ERP metric truth` |
| 6 | Dry-run lịch sử + backfill an toàn | ✅ xong | `chore: rebuild canonical historical ERP truth` |
| 7 | Trung tâm điều khiển Chất lượng dữ liệu | ✅ xong | `feat: turn data quality into ERP control tower` |
| 8 | Bộ kiểm thử bất biến nghiệp vụ | ✅ xong | `test: enforce ERP business truth invariants` |
| 9 | Chân lý tài chính | ✅ xong | `feat: standardize ERP financial truth` |
| 10 | Chân lý tồn kho + rủi ro hết hàng | ✅ xong | `feat: improve inventory truth and stock risk` |
| 11 | Chỉ số theo mẫu mã | ✅ xong | `feat: add product variant performance intelligence` |
| 12 | Hàng đợi việc theo mức ưu tiên | ✅ xong | `feat: add prioritized ERP action queue` |
| 13 | Tổng quan ra quyết định | ✅ xong | `feat: optimize ERP management dashboard` |
| 14 | ROAS theo kết quả đơn | ✅ xong | `feat: add COD-aware ads profitability metrics` |
| 15 | Sức khoẻ tích hợp | ✅ xong | `feat: add integration health observability` |
| 16 | Hiệu năng | ✅ xong | `perf: optimize ERP critical paths` |
| 17 | Nhật ký truy vết | ✅ xong | `feat: improve ERP business audit trail` |
| 18 | Nhất quán giao diện | ✅ xong | `refactor: improve ERP UX consistency` |
| — | FINAL GATE | ✅ đạt 17/17 | `docs: báo cáo release ERP Data Truth` |

## Nhật ký

### TASK 1 — Kiểm toán kiến trúc & data truth

Không sửa business logic. Kết quả: `docs/erp-data-truth-audit.md` với 12 phát hiện `F1`–`F12`.

Hai phát hiện nghiêm trọng, cùng nằm ở `lib/sync/consistency.ts` (job `data-check` với `fix=1`):

- **F1** — suy `DELIVERED` từ `cod_status` (`PAID_TO_BANK` / `RECONCILED`) rồi GHI ĐÈ
  `shipments.stage`. Vi phạm trực tiếp `docs/business-rules/ORDER_OUTCOME.md` mục 10 và phá bất
  biến "trạng thái vận đơn là hàm của lịch sử sự kiện".
- **F2** — hạ `cod_status` về `NOT_APPLICABLE` cho đơn hoàn/huỷ, mâu thuẫn với
  `codStatusForAmount` và với `applyVtpTracking`. Xoá dấu vết thu hộ ⇒ không đòi được tiền ĐVVC.

Cả hai sẽ được sửa ở TASK 4 (bộ máy đối soát).

Nền đo được trước khi sửa: `typecheck` sạch · `lint` sạch · `npm test` **TẤT CẢ KIỂM THỬ ĐẠT**.

### TASK 2 — Lớp chân lý nghiệp vụ

Thêm `lib/constants/truth.ts`: bảng đăng ký năm chiều (`TRUTH_DIMENSIONS`) nêu rõ với mỗi chiều
câu hỏi nó trả lời, nơi lưu, nguồn sự thật và danh sách **cấm suy ra từ**. Không có công thức mới:
`ORDER_OUTCOME` vẫn là bản duy nhất ở `lib/queries/return-rate.ts`.

Gộp các danh sách nguồn sự kiện vốn bị chép cứng ở 4 tệp thành hai hằng số có ý nghĩa khác nhau:

- `CARRIER_EVENT_SOURCES` (có `MANUAL`) — được quyền dựng trạng thái vận đơn;
- `CARRIER_DOCUMENT_SOURCES` (không có `MANUAL`) — chứng từ máy, chỉ nhóm này được đọc mã cuối.

`state.ts`, `return-rate.ts`, `integrations.ts`, `logistics.ts` nay đọc chung hai hằng số đó.

Thêm `OUTCOME_GROUP` / `isFinishedOutcome()` để màn hình thôi liệt kê tay
`('RETURNED','RETURNED_BY_RULE')`, và `legTypeFromReturningFlag()` cho cờ `IS_RETURNING`.

`tests/canonical-truth.test.ts` khoá đủ 8 tình huống kế hoạch yêu cầu, cộng kiểm tra bảng đăng ký
khớp enum trong schema.

### TASK 3 — Cứng hoá nạp dữ liệu Viettel Post

Đóng F3, F6, F7.

- **F3** — bước hành trình nay có cờ chiều. `normalizeTracking` đọc `IS_RETURNING` của TỪNG bước;
  `journeyLegType()` chỉ gán cờ khi bước có cờ riêng, hoặc khi bước mang MÃ TRẠNG THÁI CUỐI thì
  lấy cờ của bản ghi chính. Bước trung gian để trống — một vận đơn đi rồi quay về có cả hai chiều
  trong cùng hành trình, gán bừa sẽ hỏng các mốc "lần đầu lấy hàng / lần đầu đi phát".
- **Một hàm duy nhất ghi trạng thái vận đơn.** `applyVtpTracking` thôi ghi
  `stage / vtp_status* / is_final / các mốc`; chỉ `materializeShipmentState()` ghi, và nó dựng từ
  lịch sử. Trước đây hai chỗ cùng ghi nên luồng chạy sau thắng kể cả khi mang sự kiện cũ hơn.
- **F6/F7** — `webhook_events` thêm `dedupe_key` (unique), `occurred_at`, `delivery_count`
  (migration `0032_webhook_dedupe.sql`, viết tay idempotent). Lần gửi lại rơi vào đúng dòng cũ và
  vẫn được xử lý lại (xử lý vốn idempotent) nên gói tin hỏng lần đầu còn cơ hội chữa.
- **Trạng thái lạ nhìn thấy được**: `viettelPostHealth()` trả `unknownStatuses` + `redelivered`,
  hiển thị trên trang Kết nối dữ liệu.

`tests/vtp-ingestion.test.ts` khoá cả bốn điểm, kèm kiểm tra mã nguồn để `applyVtpTracking` không
lặng lẽ ghi lại `stage` trong tương lai.

Lưu ý về migration: `drizzle-kit generate` sinh ra bản gộp cả 0027–0031 (những migration viết tay
chưa có snapshot) — chạy nguyên bản đó sẽ `CREATE TABLE` đè lên bảng production. Đã thay bằng bản
viết tay chỉ chứa thay đổi của 0032, đúng lối idempotent các migration 0025–0031 đang dùng.

### TASK 4 — Bộ máy đối soát

**Đóng F1 và F2 — hai vi phạm nghiêm trọng nhất của release này.**

`lib/constants/reconciliation.ts` là bộ luật: 15 luật, mỗi luật có mức nghiêm trọng
(ERROR/WARNING/INFO), nghĩa thật, việc nên làm, và cờ **có được tự sửa hay không**.

`lib/sync/consistency.ts` viết lại thành hai hàm tách bạch:

- `scanReconciliation()` — CHỈ ĐỌC, chạy được mọi lúc, hỗ trợ quét gia tăng (`since=N`);
- `repairReconciliation({ apply })` — mặc định chạy thử; chỉ sửa 3 luật XÁC ĐỊNH, và cả ba đều lấy
  nguồn sự thật của **chính chiều đó**: dựng lại ảnh chụp vận đơn từ lịch sử sự kiện, khôi phục mốc
  giao từ lịch sử, và sửa nhãn "không thu hộ" theo chính số tiền thu hộ. Mỗi lần sửa ghi
  `audit_logs`.

Đã **bỏ hẳn** ba hành vi sai của bản cũ:

1. suy `stage = 'DELIVERED'` từ `cod_status` (F1) — nay là luật `PAYMENT_DELIVERED_CONFLICT`
   mức ERROR, chỉ báo cáo;
2. hạ `cod_status` đơn hoàn/huỷ về `NOT_APPLICABLE` (F2) — bỏ hoàn toàn;
3. lấy `updated_at` của ERP làm mốc giao khi thiếu — nay dựng từ lịch sử, không có thì để trống.

`tests/reconciliation.test.ts` khoá: tiền về ngân hàng KHÔNG biến vận đơn thành đã giao · đơn hoàn
giữ nguyên dấu vết thu hộ · chạy thử không ghi gì · sửa xác định thì phải đúng theo lịch sử · mỗi
lần sửa để lại nhật ký · quét hai lần cho cùng kết quả.

### TASK 5 — Lớp chân lý chỉ số

Đóng F4 và F9.

`lib/queries/metrics.ts` giữ hai POPULATION có tên (`confirmed` / `reportable`), bộ lọc chuẩn
`metricScope()`, các vị ngữ theo kết quả đơn và các biểu thức tiền. Không có công thức kết quả đơn
mới — tất cả đi qua `ORDER_OUTCOME`.

**F4 đã sửa:** Tổng quan tính `successRevenue` và `successCogs` trong CÙNG một câu truy vấn, cùng
population. Trước đây giá vốn là một truy vấn riêng thiếu bộ lọc "đơn đã xác nhận", nên lợi nhuận
ước tính lấy doanh thu của một tập đơn và giá vốn của tập đơn khác. Trên fixture: doanh thu GTC
4.903.000đ, giá vốn 3.600.000đ, GTC 34,7% — khớp mọi màn hình.

`docs/metrics-contract.md` ghi với từng chỉ số: ý nghĩa · tử số · mẫu số · population · loại trừ ·
trường ngày · nguồn sự thật · cài đặt. Nêu rõ ba con số tiền không bao giờ được coi là một
(lên đơn / giao thành công / thực nhận).

`tests/metrics-contract.test.ts` khoá bất biến "cùng chỉ số + cùng kỳ + cùng bộ lọc ⇒ cùng con số",
kèm chốt chặn giá vốn không được vượt doanh thu của chính tập đơn đó.

### TASK 6 — Dry-run lịch sử + backfill an toàn

`lib/sync/backfill.ts` dựng lại các giá trị SUY RA (trạng thái vận đơn, các mốc, và qua đó là kết
quả đơn) từ lịch sử sự kiện. Không đụng dữ liệu gốc: `raw` của đơn/vận đơn/webhook, tiền
(`cod_collected`, `cod_status`), người nhận, mốc kho thực nhận hàng hoàn.

Chạy thử báo đủ: tổng · không đổi · sẽ đổi · không có chứng từ · mốc hỏng · sự kiện ERP chưa hiểu ·
ma trận chuyển trạng thái · phân bố kết quả đơn trước/sau · số đơn lật giao thành công ↔ hoàn ·
ca nhập nhằng · vận đơn không có chứng từ nào · ví dụ cụ thể.

`backfillWarnings()` chặn tay người chạy khi bất thường: >20% vận đơn sẽ đổi, có đơn đang giao
thành công bị lật, có ca "đã giao mà không có chứng từ giao", hoặc còn mã ĐVVC chưa hiểu.

Idempotent (chạy lại báo 0 thay đổi), resumable (con trỏ trong `sync_state`), auditable
(`backfill.canonical-state`). Quay lui không cần bản sao lưu vì lịch sử không bị đụng — dựng lại
lần nữa là về đúng trạng thái tính được.

Chạy được bằng `npx tsx scripts/erp-backfill.ts` (mặc định chạy thử) hoặc job `canonical-backfill`
trên trang Kết nối dữ liệu.

### TASK 7 — Trung tâm điều khiển Chất lượng dữ liệu

Đóng F10. Bộ luật mở rộng lên 18 luật, đủ 12 luật kế hoạch yêu cầu (thêm
`DELIVERED_WITHOUT_LOGISTICS_EVIDENCE`, `MISSING_PRODUCT_MAPPING`, `ZERO_TOTAL_WITH_ITEMS`), mỗi
luật có thêm `entity` để biết vi phạm nằm trên loại đối tượng nào.

`lib/queries/control-tower.ts` định nghĩa CÂU TRUY VẤN của từng luật đúng một lần, dùng lại cho cả
đếm, lấy ví dụ và mở danh sách đầy đủ — nên con số trên thẻ và danh sách mở ra không thể lệch nhau.
Mỗi dòng mang: mã · **bằng chứng cụ thể** · thời điểm · id để mở chi tiết.

Trang Chất lượng dữ liệu có thêm mục "Trung tâm điều khiển": mức nghiêm trọng, nghĩa thật, việc nên
làm, nhãn "ERP tự sửa được" hay "Chỉ báo cáo", 5 ví dụ kèm bằng chứng, nút mở danh sách có phân
trang, và link sang trang xử lý tương ứng.

Kiểm thử bổ sung trong `tests/reconciliation.test.ts`: mọi luật đang bật phải có lý do, việc cần
làm, mốc phát hiện, loại đối tượng và bằng chứng cho từng dòng; tổng của drill-down phải bằng số
trên thẻ; phân trang phải chạy.

### TASK 8 — Bộ kiểm thử bất biến nghiệp vụ

`tests/business-invariants.test.ts` khoá đủ 12 bất biến kế hoạch yêu cầu. Chạy trong `npm test`,
mà `npm test` đã là điều kiện CHẶN của workflow **Deploy ERP to VPS** — nên bộ này ở trong CI sẵn.

**Bộ kiểm thử tìm ra hai vi phạm còn sót** (bất biến 10, quét mã nguồn):

- `lib/integrations/pancake/sync.ts` giữ một BẢN THỨ HAI của luật dựng trạng thái (`keepVtpStage`
  so mốc thời gian riêng). Đã bỏ; nay quy tắc gọn một câu: có bất kỳ chứng từ nào của ĐVVC thì
  Pancake không đụng vào chiều logistics, và `materializeShipmentState()` được gọi ngay sau để chốt
  theo lịch sử. Vận đơn chưa có chứng từ nào thì trạng thái Pancake vẫn dùng — `ORDER_OUTCOME` đã
  chặn sẵn, không chứng từ thì cao nhất chỉ là ĐANG GIAO.
- `lib/integrations/viettelpost/statement-db.ts` ghi thẳng `stage/isFinal/mốc` rồi mới gọi
  `materializeShipmentState()` — thừa và dễ lệch. Nay chỉ ghi tiền/cước, trạng thái do lịch sử
  quyết định.

`SHIPMENT_STAGE_WRITERS` thành allowlist hai tên có giải thích; thêm tên phải là quyết định tường
minh. Kèm kiểm tra bằng DỮ LIỆU: mọi vận đơn có chứng từ ĐVVC phải có ảnh chụp khớp lịch sử.

### TASK 9 — Chân lý tài chính

`lib/queries/financial-truth.ts` tách sáu con số tiền, mỗi con số một ý nghĩa: doanh thu lên đơn ·
doanh thu giao thành công · COD ĐVVC đang cầm · COD đã đối soát · tiền thực nhận · lợi nhuận.
Trên fixture: **8.396.000đ lên đơn ≠ 4.903.000đ giao thành công ≠ 1.174.000đ thực nhận** — ba con
số mà trước đây các màn hình đều gọi là "doanh thu".

Bậc thang lợi nhuận kiểm toán được: doanh thu giao TC − giá vốn − cước gửi − cước và phí đơn hoàn −
quảng cáo = **lợi nhuận góp**; trừ tiếp chi phí vận hành = **lợi nhuận ước tính**. Lợi nhuận **thực
nhận** tính theo dòng tiền và trả `null` kèm lý do khi kỳ chưa có bảng kê — không bao giờ thay bằng 0.

Mỗi dòng mang nhãn độ chính xác (`per_order` / `per_document` / `period_only`) để không ai chia
chi phí mức kỳ về từng đơn rồi tưởng đó là con số của đơn.

Tab mới "Sáu con số tiền" trên trang Báo cáo (đi cùng quyền `reports:cash`).

`tests/financial-truth.test.ts` khoá: ba con số phải khác nhau · doanh thu giao TC dùng cùng định
nghĩa với Tổng quan · ba bậc trạng thái tiền loại trừ lẫn nhau · bậc thang cộng đúng · dòng chi phí
mang dấu âm · nhãn độ chính xác đúng · thiếu chứng từ thì trả CHƯA BIẾT.

### TASK 10 — Chân lý tồn kho + rủi ro hết hàng

Kiểm toán sổ kho: phương trình `tồn = phiếu kho − đã xuất qua ĐVVC` và vòng đời hàng hoàn đã đúng
từ trước, không sửa. Bổ sung phần còn thiếu:

- Năm trạng thái của hàng có TÊN (`STOCK_STATE_LABEL`): `ON_HAND` · `RESERVED` · `AVAILABLE` ·
  `INBOUND` · `UNSELLABLE`, mỗi trạng thái kèm giải thích. `UNSELLABLE` là số ĐO ĐƯỢC từ chênh lệch
  phiếu tái nhập so với số đã xuất, không phải ước lượng.
- **Đóng F5**: Tổng quan thôi dùng ngưỡng cứng `tồn <= 5`. Nay dùng `stockRiskSummary()` — cùng bộ
  máy days-of-cover với trang Kế hoạch SX và cảnh báo vận hành, nên ba nơi không thể ra ba con số
  khác nhau. Dòng "Cần xử lý" nói rõ bao nhiêu đã hết, bao nhiêu sẽ hết trước khi lô mới về, bao
  nhiêu chưa có phiếu nhập nên chưa tính được.
- `REJECTED_HARD_STOCK_THRESHOLD` ghi lại điều đã bỏ để nó không lặng lẽ quay lại.

`tests/inventory.test.ts` khoá: khả dụng ≤ tồn thực tế · hàng hụt không âm · Tổng quan dùng đúng
con số rủi ro · Tổng quan / Kế hoạch SX / cảnh báo cùng một bộ máy.

### TASK 11 — Chỉ số theo mẫu mã

`lib/queries/product-intelligence.ts` ghép ba chiều cho từng mẫu mã: **BÁN** (số lên đơn, số giao
thành công, doanh thu giao TC) · **CHẤT** (GTC, tỷ lệ hoàn, doanh thu mất vì hoàn, lợi nhuận góp) ·
**CÒN** (khả dụng bán, days of cover). Lọc được theo kỳ, kênh bán, mã hàng, màu, size.

Top mẫu mã trên Tổng quan nay xếp theo **doanh thu giao thành công**, không theo số lên đơn — xếp
theo số lên đơn sẽ đẩy đúng những mẫu mã hoàn nhiều lên đầu bảng rồi shop lại sản xuất thêm.

Ma trận Màu × Size trên trang chi tiết sản phẩm, chỉ dựng khi mã hàng thật sự có nhiều màu/size.

Thiếu dữ liệu thì nói CHƯA BIẾT: chưa có phiếu nhập ⇒ `available = null` và không bịa ra days of
cover; không tra được giá vốn ⇒ `contribution = null` kèm lý do.

### TASK 12 — Hàng đợi việc theo mức ưu tiên

"Cần xử lý" cũ là danh sách đọc rồi bỏ: không nói việc nào gấp hơn, không ai cầm việc, và gộp ba
trạng thái khác nhau làm một.

- `lib/constants/action-queue.ts`: 12 loại việc (đủ 7 loại kế hoạch yêu cầu), việc nên làm cho từng
  loại, và công thức ưu tiên **đọc được**: mức nghiêm trọng (0–40) + tuổi việc (0–25, bão hoà ở 7
  ngày) + tiền liên quan (0–20, bão hoà ở 5 triệu) + **khả năng cứu được** (0–15).
- Khả năng cứu được là yếu tố phân biệt hàng đợi việc với danh sách cảnh báo: đơn giao thất bại còn
  gọi lại được nên đứng trên đơn đã đang hoàn về.
- Hai loại việc mới sinh từ dữ liệu: `COD_OVERDUE` (đòi tiền ĐVVC) và `DATA_ERROR` (luật mức ERROR
  của trung tâm điều khiển) — nay có người cầm và đóng được, thay vì chỉ là một con số.
- `notifications` thêm `assigned_to` / `acknowledged_*` (migration `0033_action_queue.sql`) để tách
  **đã đọc ≠ đã tiếp nhận ≠ đã xong**.
- `assignCase` / `acknowledgeCase` / `resolveNotification` đều ghi `audit_logs`.

### TASK 13 — Tổng quan ra quyết định

Hàng KPI đầu trang nay có đủ 8 chỉ số kế hoạch yêu cầu và **phân biệt ba con số tiền ngay trong
nhãn**: ① Doanh thu LÊN ĐƠN → ② Doanh thu GIAO THÀNH CÔNG → ③ TIỀN THỰC NHẬN. Trước đây cả ba đều
được gọi là "doanh thu" nên chủ shop không biết tiền thật đang ở đâu.

Thêm: Viettel Post còn giữ · lợi nhuận góp · lợi nhuận ước tính (ghi rõ "ước tính theo đơn, KHÔNG
phải tiền trong tài khoản") · việc cần xử lý · **dữ liệu sai nghiêm trọng**.

Mọi thẻ bấm được và mở đúng TẬP ĐƠN đã sinh ra con số đó. Con số lấy từ đúng nơi định nghĩa
(`financial-truth.ts`, `control-tower.ts`), không tính lại — khoá bằng kiểm thử.

### TASK 14 — ROAS theo kết quả đơn

`lib/queries/ads-roas.ts` tính bốn mức ROAS theo chiến dịch (hoặc từng mẩu quảng cáo), luôn giảm
dần: **lên đơn → giao thành công → tiền về → lợi nhuận góp**. Chỗ tụt nhiều nhất chính là vấn đề.

Với shop bán COD, ROAS theo doanh thu lên đơn là con số vô nghĩa: đơn có thể hoàn, và phần giao
được thì tiền còn nằm ở ĐVVC hàng tuần.

KHÔNG BỊA QUY KẾT: chỉ đơn có `ad_id` mới được gán. Đơn không có `ad_id`, đơn có `ad_id` lạ, và
tiền quảng cáo của chiến dịch không có đơn nào — cả ba đều đếm riêng và hiển thị, không chia đều
cho các chiến dịch để bảng trông đẹp.

Chưa tiêu đồng nào thì ROAS trả `null` (chia cho 0 là vô nghĩa), không phải 0.

### TASK 15 — Sức khoẻ tích hợp

Đóng F8. `lib/queries/integration-health.ts` trả lời **cùng một bộ câu hỏi cho mọi connector**
(Pancake · Viettel Post · Facebook Ads · Bảng kê/ngân hàng), thay vì chỉ Viettel Post có:
nhận tin lần cuối · xử lý thành công lần cuối · độ trễ · đối chiếu lần cuối · sự kiện/giờ ·
gói tin lỗi · gói tin chưa khớp được đơn · số lần bên gửi phải gửi lại · mã ánh xạ chưa hiểu.

Bốn mức: `HEALTHY` / `DEGRADED` / `DOWN` / `UNKNOWN`, mỗi mức luôn kèm **lý do**. `UNKNOWN` không
bao giờ được hiểu là khoẻ — chưa từng nhận dữ liệu và chưa từng chạy đối chiếu thì ERP không có cơ
sở để nói. Ngưỡng "im lặng" đặt theo nhịp thật của từng nguồn (bảng kê về vài ngày một lần thì
không thể lấy ngưỡng 24 giờ).

Mỗi connector ghi rõ **vì sao xử lý lại là an toàn** (idempotent theo khoá nào) — không idempotent
thì không được cho bấm retry.

### TASK 16 — Hiệu năng

**Đo trước.** `scripts/perf-audit.ts` đo 11 truy vấn nặng nhất. Kết quả trên CSDL fixture:
Tổng quan **324ms** — gấp 8 lần trang kế tiếp (Chân lý tài chính 40ms). Mọi trang khác đều dưới
45ms, nên chỉ sửa đúng chỗ chậm nhất, không đụng phần đang chạy tốt.

Ba thay đổi:

1. **Tổng quan**: 19 truy vấn độc lập chạy nối tiếp → gom vào một `Promise.all`. Số liệu không đổi
   một chữ số nào, chỉ hết chờ vô ích.
2. **Trung tâm điều khiển**: 18 truy vấn đếm chạy nối tiếp → chạy cùng lúc. Quan trọng hơn con số
   hiện tại là **độ dốc**: cứ thêm một luật thì trước đây thời gian mở trang lại tăng thêm.
3. **Hai index riêng phần** (migration `0034_perf_indexes.sql`) cho hai truy vấn chạy trên TỪNG vận
   đơn: "có sự kiện phát thành công nào của ĐVVC không?" và "đã giao, có thu hộ, chưa thấy tiền".
   Chi phí của chúng tăng theo bình phương khi shop lớn dần.

**Đo lại**: Tổng quan 324ms → **284ms** trên PGlite. Mức cải thiện ở đây bị giới hạn vì PGlite chỉ
có MỘT kết nối nên `Promise.all` vẫn xếp hàng; trên Postgres production (có connection pool) các
truy vấn thật sự chạy song song nên phần rút ngắn lớn hơn nhiều. Ghi lại đúng như đo được, không
suy diễn thêm.

KHÔNG cache theo cách làm KPI sai: mọi `memo` giữ nguyên TTL 60–120 giây như cũ, và mọi tham số
ảnh hưởng kết quả đều nằm trong khoá cache.

### TASK 17 — Nhật ký truy vết

`audit()` nay nhận `before` · `after` · `reason` · `correlationId` để một dòng nhật ký trả lời đủ
**sáu câu**: ai · làm gì · trên cái gì · trước ra sao · sau ra sao · vì sao. Thiếu "trước/sau" thì
đúng lúc số liệu lệch lại không lần ngược được.

`correlationId` nối các thay đổi cùng MỘT lần chạy — không có nó thì 300 dòng của một lượt dựng
lại trông y hệt 300 lần sửa tay rời rạc.

`redactSecrets()` che token / mật khẩu / URL webhook trước khi ghi, kể cả trong đối tượng lồng
nhau; kho mã này PUBLIC nên một lần lộ là lộ vĩnh viễn. Trường trống vẫn giữ trống để còn phân biệt
"chưa có" với "đã có".

Bổ sung nhật ký cho luồng còn thiếu: **phát lại gói tin webhook** (`scripts/vtp-retry-webhooks.ts`)
trước đây ghi đè trạng thái gói tin mà không để lại dấu vết nào. Đối soát tự sửa và dựng lại lịch
sử nay ghi before/after đầy đủ. 11 hành động và 4 loại đối tượng mới có nhãn tiếng Việt.

### TASK 18 — Nhất quán giao diện

Không đụng business logic. Xử lý đúng luật quan trọng nhất của task: **bốn chiều không được trình
bày như một**.

"Đã giao" của Pancake · "Giao thành công" của Viettel Post · "Đã về ngân hàng" của tiền · "Giao
thành công" của KẾT QUẢ ĐƠN là bốn điều khác hẳn nhau, nhưng cả bốn đều là nhãn xanh hình viên
thuốc. Người đọc thấy xanh là yên tâm mà không biết đang nhìn chiều nào.

- Mỗi nhãn mang một tiền tố ngắn (`Đơn` · `VĐ` · `KQ` · `Tiền`) và tooltip nói rõ nguồn sự thật của
  chiều đó cùng những gì **cấm suy ra** — đọc thẳng từ `lib/constants/truth.ts`.
- Thêm `OrderOutcomeBadge` và `VerifiedOutcomeBadge` dùng chung. Trước đây kết quả đơn được vẽ tay
  ở ba trang khác nhau nên mỗi trang một kiểu và mất luôn dấu hiệu phân biệt chiều.
- `tests/ui-consistency.test.ts` khoá: 35 trạng thái của bốn chiều đều có nhãn tiếng Việt · mỗi
  nhãn mang dấu hiệu chiều · **không trang nào được tự vẽ lại nhãn kết quả đơn**.

### FINAL GATE

17/17 kiểm tra ĐẠT. Báo cáo đầy đủ: `docs/erp-release-report.md`.

Hai điểm đáng ghi:

- **Tự soát diff tìm ra một hồi quy do chính release gây ra**: `upsertShipmentFromOrder()` gọi
  `materializeShipmentState()` cho MỌI đơn, tức hàng chục nghìn truy vấn thừa mỗi lần đồng bộ lịch
  sử. Đã sửa ở `81a33c3` — chỉ chốt lại khi vận đơn thật sự có chứng từ ĐVVC.
- **Migration chạy thử theo đúng đường production**: dựng CSDL bằng migration của `main` (0000–0031)
  rồi mới áp 0032–0034. Kết quả giống hệt CSDL dựng mới (36 bảng / 133 index), chạy lại lần hai
  không lỗi.

### Deploy — CHƯA CHẠY

`main` đã có toàn bộ release (`adff461`), đã push. Deploy chưa chạy vì workflow *Deploy ERP to VPS*
chỉ kích hoạt bằng `workflow_dispatch` và môi trường này không có `gh` CLI lẫn token GitHub.
Chủ shop bấm: Actions → Deploy ERP to VPS → Run workflow → nhánh `main`.
Danh sách kiểm tra sau deploy nằm ở `docs/erp-release-report.md` mục 11.

## Backlog (phát hiện ngoài phạm vi, không tự sửa)

- `npm run lint` có sẵn 3 cảnh báo từ trước release này (0 lỗi):
  `production-editor.tsx` biến `matrixTotals` không dùng · `lib/cs/failed-delivery.ts:205` biểu thức
  không gán · `lib/landing/sheet.ts` `fetchJson` không dùng.
