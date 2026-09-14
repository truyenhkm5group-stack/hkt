# HỆ ĐIỀU HÀNH CÔNG VIỆC (Work OS) — đặc tả

> Đọc trước khi chạm vào `lib/constants/work*.ts`, `lib/queries/work*.ts`, `lib/actions/work.ts`,
> `app/(dashboard)/work/*`. Luật kết quả đơn vẫn ở `docs/business-rules/ORDER_OUTCOME.md` — tệp này
> KHÔNG định nghĩa lại bất kỳ sự thật nghiệp vụ nào.

---

## 0. Kết luận audit: ERP đã có gì trước bản này

Trước khi thiết kế, đã soi toàn bộ những chỗ đang đóng vai "việc phải làm":

| Nơi | Bảng / truy vấn | Đã có sẵn | Thiếu |
|---|---|---|---|
| Hàng đợi việc (`/alerts`) | `notifications` + `lib/queries/action-queue.ts` | 23 loại việc, 7 nhóm, điểm ưu tiên, SLA, người nhận, tiền liên quan, bằng chứng, 7 trạng thái | chỉ phủ việc do job cảnh báo sinh |
| CSKH (`/cs`) | `cs_cases` + `cs_case_events` | vòng đời riêng, người phụ trách, hẹn lại, chống trùng, lịch sử | không thấy được cùng chỗ với việc khác |
| Care vận đơn (`/shipments`) | `shipment_care` + `care_case_events` + `carrier_action_requests` | vòng đời 9 trạng thái, chủ sở hữu, SLA, phản hồi đầu, mở lại | như trên |
| Kiểm đếm hàng hoàn | `return_inspections` + `return_inspection_items` | phiếu, người kiểm, tình trạng hàng | không có hạn, không có chủ |
| Tác vụ tài chính (`/finance-ops`) | `bank_transactions` + `lib/queries/finance-ops.ts` | danh sách việc còn treo, số tiền | không có chủ, không có hạn |
| Quyết định quảng cáo (`/ads`) | `lib/queries/ads-decision.ts` | hành động đề xuất, tiền đang đốt | không có chủ, không có hạn |
| Nút thắt fulfillment | `lib/queries/fulfillment-bottleneck.ts` | 4 lý do, nhóm, SLA | không có chủ |
| Hiệu suất nhân sự | `lib/queries/staff-performance.ts` | đo bằng KẾT QUẢ (doanh thu giao thành công, GTC), không bằng số lượng | không nối với công việc / OKR |

**Kết luận: ERP KHÔNG thiếu hàng đợi. ERP thiếu MỘT CHỖ NHÌN CHUNG và thiếu tầng tổ chức**
(phòng ban, mục tiêu, kỳ review). Vì vậy bản này **không** tạo hệ thống task thứ hai.

---

## 1. Nguyên tắc nền: PHÉP CHIẾU, KHÔNG PHẢI BẢN SAO

> **Work item không phải một bản ghi mới. Nó là một CÁCH NHÌN lên việc đã tồn tại ở miền nghiệp vụ.**

Vì sao đây là quyết định quan trọng nhất của bản này:

Nếu mỗi case CSKH sinh ra một dòng `work_items` thì lập tức có **hai** nơi giữ trạng thái cho cùng
một sự việc. Khi đó phải có job đồng bộ; job đồng bộ sẽ trễ; và ngày nào đó `cs_cases.status='DONE'`
sẽ đứng cạnh `work_items.status='IN_PROGRESS'`. Đó chính là cái bệnh mà `docs/business-rules/ORDER_OUTCOME.md`
và `lib/constants/cost-sources.ts` đã chống ở hai miền khác: **một sự thật, một nguồn**.

Nên:

```
TRẠNG THÁI NGHIỆP VỤ (nguồn)          TRẠNG THÁI CÔNG VIỆC (work)
shipments.stage = chứng từ ĐVVC   ≠   shipment_care.care_status = người đang xử lý tới đâu
bank_transactions.bank_group      ≠   "dòng tiền này đã có ai phân loại chưa"
cs_cases.status                   =   trạng thái công việc (case CSKH VỐN LÀ việc)
```

Đóng một work item **không bao giờ** được sửa trạng thái chứng từ. Và ngược lại: việc được giải
quyết tại nguồn thì work item **tự** biến mất khỏi hàng đợi, không cần job nào đóng hộ.

### Hệ quả 1 — chống trùng là tính chất cấu trúc, không phải một cơ chế

Khoá của một work item là `sourceType:sourceKey`, trong đó `sourceKey` **là khoá tự nhiên tại
nguồn** (`cs_cases.id`, `shipment_care.shipment_id`, `bank_transactions.id`…). Hai việc cho cùng một
gốc là điều **không biểu diễn được**. Không có job dedupe, không có `dedupe_key` thứ hai.

### Hệ quả 2 — hành động phải gọi hành động miền thật

Một nút bấm trên hàng đợi không "đánh dấu xong". Nó gọi đúng Server Action của miền
(`lib/actions/cs.ts`, `lib/actions/care-workbench.ts`, `lib/actions/bank.ts`…). `WORK_ACTION_SPEC`
khai báo action nào gọi hàm nào; `tests/work-os.test.ts` khoá: mọi hành động ghi phải trỏ tới một
Server Action **đã tồn tại**.

---

## 2. Thẩm quyền trạng thái — `lib/constants/work-sources.ts`

Cùng hình dạng với `lib/constants/cost-authority.ts`: một **sổ đăng ký** khai rõ mỗi nguồn việc.

```
statusAuthority: "SOURCE" | "WORK"
```

* **`SOURCE`** — miền nghiệp vụ giữ trạng thái. `work_items` (nếu có dòng) chỉ là **lớp ghi chú**:
  người nhận, mức ưu tiên đặt tay, hạn đặt tay, lý do chặn, hoãn tới. Cột `status` của dòng đó
  **bắt buộc `NULL`** — ràng buộc CHECK ở CSDL, không phải quy ước.
* **`WORK`** — việc không có miền nào sở hữu (việc tay, việc định kỳ). `work_items` là nguồn duy nhất.

| `sourceType` | Thẩm quyền | Nguồn | Phòng ban mặc định |
|---|---|---|---|
| `CS_CASE` | SOURCE | `cs_cases` (miền CUSTOMER) | SALES |
| `SHIPMENT_CARE` | SOURCE | `shipment_care` | LOGISTICS |
| `RETURN_INSPECTION` | SOURCE | kiện đã hoàn về chưa có phiếu tái nhập | WAREHOUSE |
| `FULFILLMENT_EXCEPTION` | SOURCE | `lib/queries/fulfillment-bottleneck.ts` | WAREHOUSE |
| `BANK_EXCEPTION` | SOURCE | `bank_transactions` chưa phân loại | FINANCE |
| `COD_EXCEPTION` | SOURCE | `notifications` kind `COD_OVERDUE` | FINANCE |
| `ADS_DECISION` | SOURCE | `lib/queries/ads-decision.ts` (hành động ≠ KEEP) | MARKETING |
| `INVENTORY_EXCEPTION` | SOURCE | `notifications` kind `STOCK_LOW` / `STOCKOUT_RISK` | WAREHOUSE |
| `ALERT` | SOURCE | `notifications` còn lại | theo `CASE_TEAM` |
| `MANUAL_TASK` | WORK | `work_items` | người tạo chọn |
| `RECURRING_TASK` | WORK | `work_items` sinh từ `work_recurrences` | định nghĩa chọn |

---

## 3. Vòng đời — 7 trạng thái, không hơn

```
NEW → ASSIGNED → IN_PROGRESS → DONE
             ↘ BLOCKED ↗   ↘ WAITING ↗
             ↘ CANCELLED
```

Mỗi nguồn khai **bản đồ trạng thái riêng → 7 trạng thái chung** trong `WORK_SOURCE_SPEC[...].mapStatus`.
Contract test đòi bản đồ **phủ hết** giá trị của nguồn: thêm một trạng thái ở `shipment_care` mà quên
khai ở đây thì `npm test` đỏ, chứ không im lặng rơi vào `NEW`.

`BLOCKED` ≠ `WAITING`: **BLOCKED** là *ta không làm tiếp được* (thiếu thông tin, chờ quyết định nội
bộ) — lỗi nằm trong tầm kiểm soát; **WAITING** là *đang chờ bên ngoài* (khách, ĐVVC, ngân hàng).
Gộp hai cái lại là mất đúng thông tin mà trưởng phòng cần để gỡ nút thắt.

---

## 4. Tiền — `null` là CHƯA BIẾT

```ts
type WorkMoney = {
  atRisk: number | null;       // tiền đang bị giữ / có thể mất nếu không làm
  recoverable: number | null;  // phần có thể lấy lại / tạo thêm nếu làm
  confidence: "MEASURED" | "ESTIMATED" | "UNKNOWN";
  basis: string;               // câu giải thích CĂN CỨ, bắt buộc khi khác UNKNOWN
};
```

Theo AGENTS.md mục 0.3 và mục 8.5: **không có căn cứ thì `null`**, không phải `0`. Giao diện in
"chưa tra được", không in `0đ`. Tổng tiền của một hàng đợi luôn kèm số dòng **chưa tra được** —
một tổng che mất mẫu số là một tổng nói dối.

`recoverable` **không bao giờ** lấy giá bán của hàng hoàn (xem `lib/queries/return-pipeline.ts`):
hàng về kho là lấy lại **vốn**, doanh thu đã mất từ lúc khách không nhận.

---

## 5. Phòng ban

Bảng thật (`departments`, `department_members`), không hard-code trong component. Bảy phòng mặc
định: `MANAGEMENT · MARKETING · SALES · LOGISTICS · WAREHOUSE · FINANCE · HR`.

Nhóm việc cũ (`CaseTeam` của `lib/constants/action-queue.ts`) **không bị xoá** — nó được ánh xạ
sang phòng ban ở `TEAM_DEPARTMENT`. Giữ cả hai vì chúng trả lời hai câu khác nhau: `CaseTeam` là
*"việc này thuộc loại công việc nào"*, phòng ban là *"ai trong tổ chức chịu trách nhiệm"*. Ở shop
nhỏ một người gánh nhiều nhóm; ánh xạ vì thế phải sửa được, không phải hằng số chôn trong code.

---

## 6. OKR & BSC — chỉ nối vào chỉ số CÓ THẬT

`lib/constants/metric-bindings.ts` là **sổ đăng ký chỉ số**: mỗi khoá khai nguồn, đơn vị, chiều tốt
(tăng hay giảm), và **mức tin cậy**. KR và ô BSC đều tham chiếu **cùng một** sổ này.

Ba mức tin cậy, và chúng quyết định giao diện:

* `MEASURED` — đọc thẳng từ truy vấn đã có contract test (GTC, doanh thu giao thành công, số dòng
  tiền chưa phân loại…). Hiện số.
* `ESTIMATED` — tính được nhưng phụ thuộc độ phủ dữ liệu (đóng góp sau quảng cáo khi độ phủ gán
  chiến dịch thấp). Hiện số **kèm nhãn ước tính**.
* `MANUAL` — ERP chưa đo được. Người nhập tay, có mốc thời gian và người nhập. **Không** bịa ra
  một truy vấn gần đúng rồi gọi nó là chỉ số.

Mục 9 của yêu cầu: *"Nếu metric chưa có nguồn trustworthy: manual KR hoặc UNKNOWN, không bịa."*
Đây là cách thực thi điều đó ở mức mã nguồn.

---

## 7. Hiệu suất — KHÔNG có "điểm nhân viên"

Sáu trục **để riêng**, không cộng thành một số trừ khi chủ sở hữu tự khai trọng số:

`Kết quả` · `Chất lượng` · `SLA` · `Năng suất` · `OKR` · `BSC`

Và một luật quy trách nhiệm: **một người không bị trừ điểm vì kết quả nằm ngoài tầm kiểm soát của
họ.** ĐVVC giao hỏng không mặc định là lỗi CSKH. Cụ thể: trục `Kết quả` của một người chỉ tính trên
những việc mà `WORK_SOURCE_SPEC[...].outcomeAttributable === true`.

Số lượng việc đã đóng **không phải** năng suất. Trục `Năng suất` giữ kèm độ khó (điểm ưu tiên trung
bình, tiền trung bình mỗi việc) để 10 ca khó không thua 100 ca tầm thường.

---

## 8. Kỳ review — ảnh chụp bất biến

`review_cycles.snapshot` lưu **kết quả đã tính** của kỳ. Sau khi `FINAL`, không truy vấn nào được
tính lại số của kỳ đó. Lý do ở AGENTS.md mục 8.9: *"Không silent correction kỳ đã chốt."* Sửa logic
truy vấn tháng sau thì báo cáo tháng trước phải **không đổi**.
