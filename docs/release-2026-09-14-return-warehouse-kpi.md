# Bản phát hành 14/09/2026 — ĐO HIỆU SUẤT KHO HÀNG HOÀN

> `/inventory/returns` từ màn hình xử lý hàng thành một hệ thống đo — **trên thứ đo được thật**,
> và nói thẳng ba chỗ chưa đo được thay vì in chúng thành 0.

Nhánh: `claude/return-warehouse-kpi` · Nền: `5e1552c`

---

## 1. Audit trước khi xây — và nó đổi hẳn phạm vi

Yêu cầu có 22 mục. Đọc mã nguồn trước thì phần lớn hạ tầng **đã có**, nên bản này chỉ lấp khoảng
trống thật thay vì dựng lại:

| Yêu cầu | Đã có sẵn | Bản này làm gì |
|---|---|---|
| §1 vòng đời | `RETURN_PIPELINE` (6 khâu, SLA từng khâu) · `RETURN_LIFECYCLE` | dùng lại nguyên vẹn |
| §3 SLA / tuổi | `getReturnPipeline` (median · p90 · oldest · breach) | **thêm** nhóm giờ + chặng thứ hai |
| §5 hiệu suất người | `dept-performance.ts` (`inspection_sla`) | **dùng lại đúng phép đo**, đưa lên trang kho |
| §6 phân loại | `RETURN_CONDITIONS` · `ITEM_CONDITIONS` | dùng lại, **không** tạo bảng phân loại thứ hai |
| §10 Work OS | nguồn `RETURN_INSPECTION` (phòng KHO, SLA, `statusAuthority: SOURCE`) | **không** tạo việc trùng |
| §13 thất thoát | `capitalLocked` / `Released` / `WrittenOff` | không đụng |
| §4 §7 §12 §15 | — | **mới** |

### Sáu mốc thời gian: cái nào có thật

§1 hỏi sáu mốc. Đo trên lược đồ thật:

| Mốc | Có thật? | Cột |
|---|---|---|
| `received_at` | ✅ | `return_inspections.received_at` (NOT NULL) |
| `inspected_at` | ✅ | `return_inspections.inspected_at` |
| `restocked_at` | ✅ | `stock_receipts.received_at` qua `stock_receipt_id` — mốc **nghiệp vụ**, không phải `created_at` |
| `expected_at` | ➖ suy ra | vận đơn `RETURNED` mà chưa có dòng kiểm đếm |
| `inspection_started_at` | ❌ | **không có, và cố ý không thêm** |
| `closed_at` | ❌ | `INSPECTED` là trạng thái cuối |

`lib/constants/return-lifecycle.ts` đã ghi rõ vì sao chỉ HAI trạng thái được lưu: *"hai nguồn cho
cùng một sự thật thì sớm muộn lệch nhau"*. Bản này tôn trọng quyết định đó — **không** thêm cột
"đang kiểm" chỉ để lấp một ô KPI.

## 2. Ba chỗ ERP chưa đo được — đo bằng số, không đoán

Trước khi viết dòng truy vấn nào, đo thẳng trên production:

```
phiếu kiểm 672 · đã kiểm 610 · chờ kiểm 62
dòng món (return_inspection_items):   4   ← trên 2 kiện
có khoá người kiểm:                 610
có khoá người NHẬN:                   0   ← trên 672
```

Ba hệ quả, và cả ba **hiện ra màn hình** (AGENTS.md mục 24, 37, 45):

1. **Kết luận theo TỪNG MÓN — 4 dòng trên 672 kiện.** Trạm đếm một chạm (`recordInspection`) chỉ
   ghi kết luận cho CẢ KIỆN; chỉ đường đếm từng món mới sinh dòng món, và kho hầu như không dùng.
   ⇒ **không có** tỷ lệ hỏng/thiếu theo MẪU MÃ. Một kiện ba mẫu mã kết luận "hỏng" không nói được
   mẫu nào hỏng; chia đều cho ba là bịa ra con số trông như đo được.
2. **Ai NHẬN kiện — 0/672.** Kiện được ghi nhận qua đối soát sổ giấy và xác nhận hàng loạt, tức là
   MÁY làm, nên `NULL` ở đây đúng nghĩa (AGENTS.md mục 34). ⇒ chỉ chấm được đoạn **ĐẾM**.
3. **"Đang kiểm"** — không có cột, theo thiết kế.

## 3. Những gì đo được, và mẫu số của chúng

| Chỉ số | Công thức | Vì sao mẫu số là thế |
|---|---|---|
| Tỷ lệ bán lại được | kiện `RESTOCKABLE` ÷ kiện **ĐÃ ĐẾM** | Kiện chưa đếm thì chưa ai biết nó thuộc về đâu. Ném vào mẫu số là khẳng định "không bán lại được" cho thứ chưa ai mở ra. |
| Tỷ lệ thu hồi tồn | món vào lại tồn ÷ **món đếm được** | Cố ý **không** lấy vận đơn `RETURNED` làm mẫu số (§7 yêu cầu): ĐVVC báo "đã hoàn" chỉ nói hàng rời kho họ, hàng có thể còn trên đường, và tỷ lệ sẽ thấp giả tạo đúng bằng phần đang đi đường. |

Mẫu số 0 ⇒ `null` ⇒ in `—`, không bao giờ `0%` (AGENTS.md mục 42).

## 4. Hai chặng SLA, mặc định lấy lại từ hằng số đang chạy

```
received_at ──(A) 72 giờ──► inspected_at ──(B) 24 giờ──► phiếu tái nhập
```

(A) đọc thẳng `CASE_SLA_HOURS.RETURN_RECEIVED_PENDING_INSPECTION`, (B) đọc
`RETURN_STAGE_BY_KEY.INSPECTED.slaHours`. **Không gõ lại một con số nào** (AGENTS.md mục 22); ghi
đè của chủ shop vẫn ở `settings` (`work.sla`). Bài kiểm khẳng định hai hằng số này bằng nhau, nên
đổi hạn ở một chỗ là đổi ở mọi chỗ.

Ranh giới nhóm tuổi cuối (`> 72 giờ`) **trùng đúng** hạn (A), nên ô "quá hạn đếm" và nhóm tuổi cuối
luôn là **cùng một tập kiện** — có bài kiểm khoá.

**Kiện ngoại lệ chưa xác định được không vào mẫu số SLA** — và điều đó đúng theo *cấu trúc*, không
cần thêm bộ lọc: một dòng `return_inspections` chỉ tồn tại khi đã có `shipment_id` thật, nên 26
dòng ngoại lệ sổ giấy chưa bao giờ sinh dòng kiểm đếm.

## 5. Không đếm hai lần

- **KIỆN** đếm từ `return_inspections` (`shipment_id` UNIQUE) ⇒ một kiện ba món vẫn là **một** kiện.
- **MÓN** đếm từ `restock_qty` / `unsellable_qty` và `stock_receipt_items.quantity`.
- Mẫu mã: `count(distinct shipment_id)`, nên hai dòng phiếu cùng một kiện vẫn là **một** kiện.
- Hai đơn vị **không bao giờ** cộng vào nhau; biểu đồ chỉ vẽ KIỆN, số MÓN nằm ở dòng mô tả.

Fixture kiểm thử cố ý dựng **một kiện ba món** để hai con số không thể bằng nhau do trùng hợp.

## 6. Không tạo hai nguồn cho một con số

Dải thẻ cũ đã nói "chờ kho nhận · chờ đếm · đã vào lại tồn · hỏng · thiếu · không đúng hàng". Khối
mới **không lặp lại ô nào** trong số đó — và bài kiểm so trực tiếp `returnWarehouseKpi()` với
`inspectionDashboard()` trên ba ô chung, nên hai màn hình không thể nói hai con số.

Dải tuổi CŨ tính theo **ngày** đã được **thay** bằng dải theo **giờ** — hai dải tuổi trên một trang
là hai câu trả lời cho một câu hỏi.

## 7. §14 — Audit nguồn giá vốn (chỉ khuyến nghị, KHÔNG đổi gì)

Thứ tự ưu tiên §14 mong muốn **đã được cài sẵn** ở `lib/queries/cogs.ts::LINE_UNIT_COST`:

```
1. giá trên PHIẾU NHẬP gần nhất  (LAST_RECEIPT_COST — lớp tồn kho thật)
2. giá vốn Pancake ghi trên đơn  (order_items.unit_cost)
3. giá nhập mẫu mã               (product_variants.last_imported_price)
4. → 0
```

Khớp AGENTS.md mục 13, và **không dùng giá bán thay giá vốn** ở bất kỳ nhánh nào.

**Một khuyến nghị cho phase sau, không làm ở đây:** bậc cuối rơi về **`0`**, trong khi §14 và
AGENTS.md mục 8.5 đều nói bậc cuối phải là **UNKNOWN**. ERP đã tự biết lỗ hổng này — `ops cogs-drift`
in `BASIS_NONE 12 ← đã giao mà CHƯA BIẾT giá vốn (NULL, báo cáo đang tính 0)`. Sửa nó là đổi **chân
lý tài chính**, nên nó cần một bản phát hành riêng có chủ shop duyệt.

Vì vậy bản này **không gắn tiền vào một ô KPI nào**: chỉ hiện SỐ MÓN. Phần tiền của hàng hoàn đã có
ở khối đường ống (`capitalLocked` / `capitalReleased` / `capitalWrittenOff`), dùng đúng helper trên.

## 8. Đo hiệu năng

Chạy trên chính bộ đo sẵn có (`scripts/bench-reports.ts`, có lớp đếm câu truy vấn):

| Quy mô | Câu truy vấn | Nguội | Nóng | p95 |
|---|---|---|---|---|
| ×1 | **8** | 11,9 ms | 0,1 ms | 15,7 ms |
| ×5 (5.932 vận đơn · 13.013 dòng đơn) | **8** | 13,3 ms | 0,1 ms | 17,7 ms |

**Số câu truy vấn không đổi khi dữ liệu gấp 5** ⇒ không có N+1.

*Nói thẳng giới hạn của phép đo này:* bộ đổ dữ liệu của bench không tạo dòng `return_inspections`,
nên phần nặng nhất chạy trên bảng rỗng. Con số đáng tin hơn là lượt smoke trên production sau khi
triển khai — ghi ở mục dưới.

Trang **không** đọc bảng tính HMT lúc dựng (§17): việc đó đã được gỡ khỏi đường dựng trang ở
`74d35f0`, và hai bài kiểm quét mã nguồn đang khoá.

## 9. Kiểm mắt bằng trình duyệt thật

CSDL riêng, đổ đúng mọi nhánh hiển thị (bốn nhóm tuổi, hai người đếm, một lượt đếm vô danh, một
phiếu tái nhập hai mẫu mã), mở bằng Chromium ở **hai chủ đề × ba mức thu phóng** — **0 lỗi**:

```
✓ khối “Kho hàng hoàn hôm nay” · ô “Quá hạn đếm” · hai tỷ lệ · dải tuổi theo GIỜ
✓ khối năng suất · bảng người đếm · bảng mẫu mã · khối chưa đo được
✓ dải tuổi cũ theo ngày đã bỏ   ✓ lượt đếm vô danh đếm riêng   ✓ biểu đồ vẽ được
✓ 6/6 tổ hợp: không tràn ngang · không lỗi console · không lỗi HTTP
```

Số hiện ra khớp đúng dữ liệu đã đổ: nhận hôm nay 2 · đếm xong 3 (3 món) · quá hạn 1 (chỉ kiện 100
giờ vượt 72) · Nguyễn Thị Kho 2,0 giờ · Trần Văn Đếm 18,0 giờ (nhận 20 giờ trước, đếm 2 giờ trước).

Lượt kiểm đầu **thất bại 10/10 khẳng định nội dung** vì tài khoản QA chưa có trong CSDL nên máy chủ
đá về trang đăng nhập — bộ kiểm bắt đúng chuyện đó thay vì báo xanh trên một trang trống.

## 10. Việc KHÔNG làm trong bản này

- **§16 cảnh báo tự động** — chưa làm. Hàng đợi việc đã có nguồn `RETURN_INSPECTION` với đúng hạn
  72 giờ; thêm một máy cảnh báo thứ hai ở đây là nhân đôi việc (§11 của chính yêu cầu cấm điều đó).
- **§9 bộ lọc đầy đủ cho bảng tồn đọng** — trạm đếm hiện đã sắp *cũ nhất trước* và có ô tìm mã.
  Bộ lọc theo mẫu mã / người phụ trách / loại ngoại lệ chưa làm.
- **§14 đổi bậc cuối giá vốn thành UNKNOWN** — cố ý để lại, xem mục 7.
