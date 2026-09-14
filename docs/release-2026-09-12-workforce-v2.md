# Quản trị nhân lực thông minh (V2) — 12/09/2026

Nhánh `claude/work-management-os-v1`. Bản trước dựng khung Work OS rồi vận hành hoá nó. Bản này
trả lời câu tiếp theo: **việc tự tìm đúng người, và trưởng phòng biết ai đang chìm.**

---

## 0. Đo production TRƯỚC khi sửa (12/09/2026, `db-query` chỉ đọc)

| Số | Giá trị |
|---|---|
| Tài khoản đang hoạt động | **7** (tăng từ 2 — chủ shop đã tạo thêm 5 người) |
| Người **đã có phòng ban** | **1** — Trần Anh Quân (MARKETING, trưởng phòng) |
| Việc đang mở | **~783** (case CSKH 384 · care 45 · cảnh báo 442, trừ phần trùng độ mịn) |
| Việc **chưa ai nhận** | **695 / 783 ≈ 89%** (care 45/45 · cảnh báo 442/442 · CSKH 296/384) |
| `work_item_events` | **0** — chưa ai từng thao tác qua hàng đợi |
| `work_items` | **0** — phép chiếu còn nguyên |

**Điều này đổi một giả định của yêu cầu.** Đề bài nói "sau khi owner đã gán nhân viên/phòng ban";
thực tế owner đã **tạo tài khoản** nhưng **chưa gán phòng**: 6/7 người còn ở "chưa có phòng ban",
và 6/7 phòng không có một thành viên nào. Máy phân việc "trong đúng phòng ban" ở trạng thái đó
không có ai để giao.

Bản này **vẫn giao đủ**, và xử lý sự thật đó như một trường hợp hạng nhất chứ không phải lỗi:

- Máy phân việc trả lý do `NO_CANDIDATE` — *"Phòng chưa có ai"* — kèm lối ra, thay vì im lặng
  không làm gì.
- Màn hình sáng có dải đỏ **"N phòng có việc nhưng chưa có ai"**, hiện kể cả khi đang xem phòng
  khác.
- `NO_DEPARTMENT_STAFF` là một trong bốn loại "việc cần can thiệp ngay".

---

## 1. Sổ nhân lực (`lib/constants/workforce.ts`, `lib/queries/workforce.ts`)

Ba thứ máy phân việc cần mà CSDL nghiệp vụ không biết và không suy ra được:

| Thứ | Mặc định | Vì sao |
|---|---|---|
| **Trần việc đang cầm** | 20 | Không có con số nào đọc được từ dữ liệu (hàng đợi chưa chạy đủ lâu). Đây là mặc định KHAI BÁO, chọn theo công dụng: quá 20 việc thì danh sách thôi là danh sách việc. |
| **Kỹ năng** | rỗng = **nhận mọi loại việc của phòng** | Ở shop nhỏ ai cũng làm mọi việc của phòng. Bắt khai kỹ năng trước khi dùng được máy phân việc là dựng hàng rào không cần thiết. Khai chỉ để THU HẸP. |
| **Ngày nghỉ** | không | Không hệ thống nào trong ERP biết hôm nay ai vắng. |

Trần riêng > trần phòng > mặc định. Người kiêm nhiều phòng lấy trần **cao nhất**, **không cộng
dồn** — cộng dồn thì người kiêm ba phòng bỗng gánh được gấp ba, mà họ vẫn chỉ có một ngày làm việc.

**Quá tải ≠ nhiều việc.** `overloaded` = vượt trần **HOẶC** quá nửa việc đang cầm đã vỡ hạn. Thiếu
vế thứ hai thì màn hình báo "còn chỗ" cho đúng người đang cần gỡ việc ra.

**Ghép người theo cả hai chiều.** `cs_cases.assignee` là ô CHỮ do Pancake ghi (88/384 case đang mở
có tên ở đó), không phải khoá người dùng. Bỏ qua nó thì bảng sức chứa báo người đó đang rảnh trong
khi họ đang ôm mấy chục case — và máy phân việc sẽ dồn thêm cho đúng người bận nhất.

## 2. Máy phân việc (`lib/work/distribution.ts`)

Hàm **thuần**: nhận việc + người + cấu hình, trả về một **bản kế hoạch**. Không đọc CSDL, không
ghi gì. Ghi là việc của Server Action, và chỉ sau khi người bấm "Áp dụng".

**Hai lần xếp hạng, không phải một:**
1. *Xếp việc*: quá hạn → gấp → sắp vỡ hạn → tiền → điểm. Việc quan trọng nhất chọn người **trước**,
   lúc mọi người còn chỗ. Xếp ngược thì việc gấp nhất rơi vào người cuối cùng còn chỗ — người bận nhất.
2. *Xếp người*: còn nhiều chỗ nhất → ít việc quá hạn nhất → tên (để kết quả **ổn định**; một máy
   cho kết quả khác nhau mỗi lần bấm là máy không ai dám dùng).

Không xét "ai làm nhanh nhất": đo được điều đó cần lịch sử đóng việc mà shop chưa có, và đoán thì
thành vòng lặp — người nhanh nhận nhiều nhất rồi chậm lại.

**Không bao giờ nhồi quá trần.** Hết chỗ thì việc còn lại nằm nguyên ở hàng đợi phòng và được đếm
ở `unplaced` kèm **lý do + lối ra** (`NO_CANDIDATE` · `NO_CAPACITY` · `NO_SKILL` · `ALL_AWAY`). Đó
là tín hiệu thật — thiếu người, trần đặt thấp, cả phòng đang nghỉ — và nó phải lên màn hình trưởng
phòng chứ không bị giấu dưới một danh sách cá nhân không ai làm nổi.

Tiền **chưa tra được** xếp sau tiền đã biết nhưng **trước** một khoản 0đ có thật: 0đ đã tra ra là
việc thật sự không giữ đồng nào, còn chưa tra được thì có thể là bất cứ số nào.

## 3. Leo thang SLA (`lib/work/escalation.ts`) — tính lúc đọc, **0 dòng CSDL**

Cách hiển nhiên là một job quét việc vỡ hạn rồi `update work_items set priority='URGENT'`. Cách đó
hỏng theo ba hướng cùng lúc:

1. **Biến lớp ghi chú thành bản sao** — 442 cảnh báo + 45 ca care đang mở, phần lớn đã vỡ hạn. Job
   đó tạo vài trăm dòng `work_items` chỉ để ghi một chữ, đúng thứ AGENTS.md mục 19 cấm.
2. **Luôn trễ** — việc vỡ hạn lúc 9h02 chỉ được nâng lúc 9h15.
3. **Ghi đè quyết định của người** — trưởng phòng hạ một việc xuống Thấp vì khách hẹn tuần sau; 15
   phút sau job kéo lại lên Gấp.

Nên mức leo thang là một **hàm của thời gian và cái hạn**, tính lúc đọc: luôn đúng tới từng giây,
không tốn một dòng CSDL, không đụng thứ người dùng đặt tay. Ba mức: `WARN` (còn <4 giờ) ·
`BREACH` (đã vỡ) · `STALE` (vỡ >24 giờ **và chưa ai cầm**).

`effectivePriority` **chỉ nâng, không bao giờ hạ**: việc chủ shop đánh Gấp vì lý do ngoài hệ thống
giữ nguyên là Gấp.

**Phần "tự báo"** là job `work-escalation` (30 phút/lần, trong scheduler): **một** tin Lark cho mỗi
phòng mỗi **ngày**, chỉ khi có việc mức `STALE`. Ngưỡng là `STALE` chứ không phải `BREACH` — phòng
nào cũng có việc vỡ hạn mỗi ngày, báo hết thì thành tiếng ồn và người ta tắt thông báo. Không tạo
một dòng `notifications` cho mỗi việc: cảnh báo lại là một việc, và hàng đợi sẽ tự nhân bản.

## 4. Giao việc an toàn (`lib/actions/workforce.ts`)

Mọi đường ghi đi qua đúng một cửa: `svc.assignWork` → một dòng `work_item_events` cho mỗi lần đổi
chủ. Một việc bị giao nhầm luôn truy ngược được về người bấm nút.

- `autoAssign` mặc định **chạy thử**: trả kế hoạch, không ghi. `apply: true` mới ghi.
- `bulkAssign` **từ chối** khi vượt trần, không âm thầm cắt bớt — cắt bớt im lặng nghĩa là người
  bấm tưởng đã giao 40 việc trong khi chỉ 12 việc có chủ. `force` vẫn giao được nhưng phải khai
  tường minh và số vượt trần được ghi vào `audit`.
- `reassignWork` chuyển một việc, hoặc trả về hàng đợi phòng.
- Máy **không bao giờ** lấy việc khỏi tay người đang cầm — đó là hành động riêng, có người quyết.

## 5. Màn hình sáng của trưởng phòng (`/work/today`)

Bảy khối theo thứ tự người ta hỏi khi mở máy: **tồn đọng · quá hạn · sắp vỡ hạn · chưa ai nhận ·
tiền đang treo · ai quá tải/còn chỗ · năm việc cần can thiệp**.

Khối cuối **cố ý không phải "năm việc gấp nhất"** — việc gấp nhất đã ở đầu hàng đợi và người làm
tự thấy. Đây là việc **người làm không tự gỡ được**: bị chặn · vỡ hạn lâu chưa ai cầm · nằm trong
tay người đã quá tải · thuộc phòng chưa có ai. Cả bốn đều cần một quyết định của trưởng phòng, và
mỗi dòng in kèm **việc nên làm** chứ không chỉ nêu vấn đề.

Vì sao là trang riêng, không nhồi vào `/work/department`: hai trang trả lời hai câu hỏi và mở vào
hai lúc. Trang này để nhìn 30 giây đầu ca; `/work/department` là chỗ đào sâu một phòng.

## 6. Hiệu suất theo phòng — số thật, đọc từ chứng từ (`lib/queries/dept-performance.ts`)

Thẻ điểm chung đo thứ ai cũng có (đóng đúng hạn không, có mở lại không). Tệp này đo thứ **chỉ
phòng đó mới có**, đọc thẳng từ bảng nghiệp vụ:

| Phòng | Nguồn | Chỉ số đo được |
|---|---|---|
| Kinh doanh | `cs_cases` + `orders.conversation_id` | Đóng case trong hạn · **hội thoại ra đơn** · đơn từ case giao thành công¹ · doanh thu từ case¹ |
| Giao vận | `care_case_events` (ảnh chụp SLA từng sự kiện) | Đóng ca care trong hạn · **kiện cứu được**¹ · **COD về được**¹ |
| Kho | `return_inspections` (`inspected_by` = email thật) | Kiểm đếm trong hạn · tỷ lệ kiện có lệch¹ |
| Kế toán | `audit_logs` (`BANK_CLASSIFY`/`BANK_LINK`) + `bank_transactions` | Lượt phân loại (người) · **độ đầy đủ đối soát** và **dòng treo lâu nhất** (mức SỔ) |
| Marketing | — | Không có nguồn ở độ mịn NGƯỜI. Nói thẳng, không dựng số thay thế. |

¹ = **kết quả chung**: bên ngoài đồng quyết định (ĐVVC giao được hay không, hàng có hỏng trên
đường về không). Giao diện in nhãn "kết quả chung" ngay dưới tên cột — đọc làm **bối cảnh**, không
phải điểm chấm người. Đó là luật "không phạt nhân viên vì carrier/hệ thống/phòng khác", thực thi
trên nhãn chứ không chỉ trong tài liệu.

**Không có hàm nào trả về "đã làm bao nhiêu việc" như một điểm số.** Số lượng chỉ xuất hiện làm
mẫu số của một tỷ lệ, hoặc đứng cạnh tiền.

Ghép người mỗi phòng một khoá khác nhau (Kinh doanh theo **tên**, Kho và Kế toán theo **email**,
Giao vận theo **khoá người dùng**) — đó là sự thật lịch sử của bốn module, ép về một kiểu nghĩa là
migrate dữ liệu đang chạy của cả bốn.

**Điểm tổng:** chỉ hiện khi chủ shop **tự khai trọng số** ở Cấu hình → Trọng số điểm tổng. Không
có bộ mặc định, và đó là quyết định: một bộ mặc định sẽ được đọc như thể nó có căn cứ, rồi ba
tháng sau không ai nhớ ai chọn các con số đó. Khi có điểm, **độ phủ luôn đứng cạnh**.

## 7. Họp tuần tự sinh (ảnh chụp review **v3**)

Thêm `scoreboard` (**đích → thực tế → chênh → người**) và `nextActions`.

- `delta` tính theo **đơn vị của chính chỉ số**, không theo phần trăm: *"còn thiếu 12 triệu"* hành
  động được, *"đạt 78%"* thì không. Dấu đã tính theo chiều — số dương luôn nghĩa là chưa tới đích,
  kể cả với chỉ số càng-thấp-càng-tốt.
- Mục tiêu **NHÁP không vào bảng họp**: chưa ai bật thì chưa phải cam kết của kỳ.
- `nextActions` là **đề xuất** suy từ số (nút thắt, KR chệch xa nhất, việc nóng chưa ai cầm, việc
  bị chặn), mỗi dòng trỏ tới một con số cụ thể và một người có thật. Cái được **chốt** vẫn là cái
  người chủ trì gõ vào ô biên bản.
- Ảnh chụp đời cũ vẫn đọc được: `normalizeSnapshot` dựng lại phần thiếu **từ chính ảnh chụp**, để
  rỗng khi không đủ — không tính lại từ hôm nay, vì tính lại là sửa ngầm một kỳ đã chốt.

---

## 8. Không đụng vào sự thật nghiệp vụ

Không tệp nào ở bản này đổi `ORDER_OUTCOME`, ngưỡng 50K/100K, luật COD, luật kho hay luật chi phí.
Mọi chỉ số đọc lại từ nguồn có sẵn: `canonical_order_outcome` cho kết quả đơn,
`o.total_price_after_discount` cho doanh thu (**cùng cột với `DELIVERED_REVENUE`**), `CARE_SLA` và
`CASE_SLA_HOURS` cho hạn. Không migration: bản này không đổi schema.

`tests/shipment-join-grain.test.ts` bắt đúng một chỗ đáng bắt và nó được khai miễn trừ **kèm lý
do**: hiệu suất giao vận đo theo **kiện người đó đã care** (nguồn là `care_case_events`, mỗi sự
kiện một `shipment_id`), và kết quả đơn nối theo `shipment_id` — đúng độ mịn của
`canonical_order_outcome`. Thêm `PRIMARY_ATTEMPT` ở đó sẽ **xoá công** của người đã care lần gửi
thứ hai.

## 9. Kiểm thử

`tests/workforce.test.ts` — 9 khối, khoá đúng chỗ một máy phân việc hỏng đắt nhất: không nhồi quá
trần · kế hoạch ổn định giữa hai lần chạy · không dồn hết cho một người · hàm thuần không sửa dữ
liệu đầu vào · người nghỉ và người khai hẹp kỹ năng bị loại đúng · leo thang chỉ nâng không hạ ·
cái hẹn không che được hạn đã vỡ · ngưỡng gửi tin là "bị bỏ quên" chứ không phải "quá hạn" · điểm
tổng chỉ có khi khai trọng số · bảng đích/thực tế bỏ mục tiêu nháp và tính chênh theo chiều. Khối
cuối chạy **truy vấn thật trên CSDL** cho 5 phòng — đúng loại lỗi mà `tsc`/`eslint` không thấy
(sự cố `assignableMembers()` ngày 12/09 là ví dụ).

## 10. Còn phải làm

- **Trần việc 20 là số khai báo, không phải số đo.** Khi `work_item_events` có đủ lịch sử đóng
  việc, nên thay bằng số đo (thời gian xử lý trung vị × giờ làm việc).
- **Độ chính xác tồn kho** và **chất lượng quyết định quảng cáo** vẫn chưa đo được ở độ mịn người
  — thiếu cột "người kiểm" trên phiếu kiểm kê và thiếu bản ghi "ai cắt dòng quảng cáo nào".
- `/ads` vẫn 6,8 giây khi đệm nguội (có từ trước; hạn giờ 2,5s mỗi adapter giữ `/work` không bị kéo theo).
