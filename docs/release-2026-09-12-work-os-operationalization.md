# Bản vận hành hoá Work OS — 12/09/2026

Nhánh `claude/work-management-os-v1`. Bản trước (`docs/release-2026-09-12-work-os.md`) dựng **khung**:
phép chiếu bảy nguồn việc, OKR, BSC, kỳ review. Bản này không mở rộng khung. Nó trả lời đúng một
câu hỏi: **ngày mai nhân viên mở `/work` lên thì nó có dùng được không?**

---

## 0. Điều đo được trên production trước khi bắt tay (12/09/2026, `db-query` chỉ đọc)

| Số | Giá trị | Nghĩa là gì |
|---|---|---|
| Tài khoản đang hoạt động | **2** | `admin@vnxcommerce.com` · Trần Anh Quân |
| Người đã có phòng ban | **1** | Chỉ Trần Anh Quân (MARKETING). Admin chưa có phòng nào. |
| Dòng `department_members` đang hoạt động | **1** | |
| Việc đang mở (ước theo nguồn) | **~1.600** | case CSKH 383 · care 45 · hoàn chưa kiểm 782 · cảnh báo mở 435 |

Tức là: hệ thống đã có gần 1.600 việc và gần như **không ai** được xếp phòng để nhận chúng. Người
chưa xếp phòng mở `/work` lên thấy một danh sách rỗng, và màn hình không nói gì — một danh sách
rỗng trông hệt như "hôm nay hết việc". Đó là lỗ hổng chặn toàn bộ bản trước khỏi việc được dùng
thật, và nó đứng đầu danh sách dưới đây.

---

## 1. Sơ đồ tổ chức thật (`/work/settings` → *Nhân sự và phòng ban*)

- `listOrgPeople()` liệt kê **mọi** tài khoản đang hoạt động, kể cả người chưa thuộc phòng nào.
- Dải cảnh báo vàng ở đầu bảng nêu đích danh ai chưa có phòng ban.
- Gán phòng / bỏ khỏi phòng / đặt trưởng phòng ngay trên dòng. Đặt trưởng phòng ghi **hai** thứ:
  `departments.lead_user_id` và vai `LEAD` trong chính phòng đó — thiếu cái thứ hai thì trưởng
  phòng chỉ thấy việc của mình.
- `/work` (Việc của tôi) hiện một dải riêng khi NGƯỜI ĐANG XEM chưa có phòng, nói thẳng rằng danh
  sách trống không có nghĩa là hết việc.

**ERP không đoán phòng ban cho ai.** `ROLE_DEPARTMENT_HINT` chỉ hiện thành một dòng chữ cạnh ô
chọn. Vai trò phân quyền nói người đó *được xem* gì, không nói họ *làm* việc gì.

## 2. Luật sở hữu — phòng ban trước, người sau (`lib/constants/work-ownership.ts`)

Khoá `<nguồn>` hoặc `<nguồn>:<loại>`, mặc định lấy lại từ `WORK_SOURCE_SPEC[].department` và
`CASE_TEAM → TEAM_DEPARTMENT`. Ghi đè lưu ở `settings.work.ownership`.

**Bảng này không có cột "người mặc định", và đó là một quyết định.** Máy biết loại việc nhưng
không biết hôm nay ai nghỉ, ai đang gánh 40 ca, ai vừa vào làm. Tự gán cho cá nhân sinh ra hai hậu
quả đều tệ hơn "chưa ai nhận": việc mang tên người không làm được nó thì **biến mất** khỏi hàng
đợi phòng, và số quá hạn của người đó phồng lên vì việc họ chưa từng nhận.

Một chỗ đáng chú ý: `FULFILLMENT_EXCEPTION` **không** có luật mức nguồn. Bốn lý do tắc không cùng
một phòng — `DATA_BLOCKED` (thiếu SĐT/địa chỉ) phải **gọi khách**, nên nó thuộc kinh doanh chứ
không thuộc kho. `BOTTLENECK_TEAM` đã chốt điều đó từ trước; ở đây chỉ tái dùng.

## 3. Hạn xử lý: một bảng, sửa được (`lib/constants/work-sla.ts`)

Trước bản này hạn nằm ở **bốn** chỗ và không chỗ nào sửa được nếu không deploy: `CASE_SLA_HOURS`
(23 loại) · `CARE_SLA` · `BOTTLENECK_SLA_HOURS` (4 lý do) · `WORK_SOURCE_SPEC[].slaHours`.

Nay gom thành một bảng có khoá, đọc ghi đè từ `settings.work.sla`, sửa trên `/work/settings` và
có hiệu lực ngay.

- **Mặc định là chính con số đang chạy.** Mọi giá trị được *lấy lại* từ hằng số gốc, không gõ lại.
  Chưa ai sửa thì mọi báo cáo giữ nguyên số cũ — đây là điều kiện để bản này không âm thầm đổi một
  con số nào.
- **Độ phủ kiểm ở mức kiểu.** `ALERT_SLA_WHY` là `Record<CaseType, string>`: thêm một loại việc mà
  quên khai lý do thì `tsc` đỏ. Bản nháp đầu của bảng này phủ 11/23 loại — chính lá chắn đó bắt được.
- **`null` là CỐ Ý không đặt hạn**, khác hẳn 0 giờ. Việc không ai làm gì được (đang chuyển hoàn,
  vận đơn chưa ghép đơn) giữ `null`, và `SLA_STATES.NONE` giữ chúng ngoài mẫu số tỷ lệ đúng hạn.
- Mỗi dòng cấu hình nói **VÌ SAO** con số đó, và nêu tên màn hình chuyên biệt cũng hiển thị một
  hạn cho cùng sự việc — thay vì để người dùng tự phát hiện hai con số.

`applyWorkConfig()` trong `lib/queries/work-adapters.ts` là **lượt duy nhất** áp cấu hình lên việc.
Không adapter nào tự đọc cấu hình: bảy nơi cùng nhớ thứ tự ưu tiên thì nơi nào quên sẽ lệch âm thầm.

## 4. `/work` gọn lại

Năm rổ mở sẵn (Quá hạn · Cần làm ngay · Hôm nay · Đang làm · Chờ); rổ **Sắp tới** gấp lại sau một
cú bấm — theo định nghĩa nó không phải việc của hôm nay, và mở sẵn thì nó đẩy năm rổ thật xuống
dưới nếp gấp.

Dòng việc ở dạng gọn mang đúng sáu thứ: **việc cần làm · thực thể (mã đơn / mã vận đơn) · tiền ·
hạn · người cầm · nút bấm**. Nhãn trạng thái bỏ đi (tên rổ đã nói rồi), mức ưu tiên chỉ in khi
khác "bình thường", câu gợi ý việc nên làm lùi vào tooltip. Mã thực thể là thứ **thêm vào**: "gọi
khách đơn nào" là câu hỏi đầu tiên của mọi ca, và trước đây phải mở dòng ra mới biết.

Dạng đầy đủ vẫn dùng ở `/work/all` và hàng đợi phòng — nơi người ta ĐỌC để phân việc chứ không quét
để làm.

## 5. Màn trưởng phòng: thêm ba con số về việc ĐÃ ĐÓNG

Ảnh chụp hiện tại nói phòng đang **gánh** gì; nó không nói phòng có **xử lý được** hay không.
`closedStats()` (cửa sổ 30 ngày) thêm:

- **Thời gian xử lý** — TRUNG VỊ, kèm ca chậm nhất. Trung bình sẽ bị một ca để quên ba tuần kéo lên.
- **Đóng đúng hẹn** — mẫu số chỉ gồm ca CÓ ĐẶT HẠN. Khác hẳn ô "Trong hạn" ở dải trên: ô kia nói
  việc *đang mở* chưa vỡ hạn. Một phòng có thể 100% việc đang mở còn trong hạn mà vẫn thường xuyên
  đóng muộn.
- **Tiền đã cứu được** — CHỈ cộng phần `MEASURED`. Ước tính không được trộn vào một con số mà chủ
  shop sẽ đọc như tiền thật; số ca chưa tra được hiện ngay cạnh.

Trang này đổi từ `includeClosed` sang `closedSince` 30 ngày: `includeClosed` kéo toàn bộ lịch sử,
vừa chậm vừa làm trung vị nói về chuyện của năm ngoái.

## 6. Hiệu suất: mỗi phòng đo bằng thứ họ quyết được

- Thẻ điểm cá nhân nay **chỉ tính việc thuộc phòng của người đó**, lọc theo phòng của CHÍNH VIỆC
  (nên đổi phân công ở màn hình cấu hình là thẻ điểm đi theo ngay). Việc họ đóng hộ phòng khác
  hiện riêng ở dòng "+n việc phòng khác" — không vào trục nào, nhưng người gánh việc hộ không
  trông như đang rảnh.
- Thêm cột **Tiền cứu được** (chỉ phần `MEASURED`).
- `lib/constants/department-performance.ts` khai cho từng phòng: đo bằng gì, **cái gì KHÔNG tính
  cho họ**, và những chỉ số chủ shop muốn mà ERP **chưa đọc được ở độ mịn NGƯỜI** — kèm lý do,
  hiện thẳng trên màn hình. Năm chỉ số đang ở nhóm đó:

  | Chỉ số | Thiếu cái gì |
  |---|---|
  | Tỷ lệ chốt đơn từ tin nhắn (Sales) | Pancake không trả về người chốt của từng hội thoại |
  | Chất lượng đơn theo người chốt (Sales) | `orders` không có cột "ai chốt" — chỉ có marketer |
  | Tỷ lệ cứu được đơn sau care (Logistics) | Kết quả chuyến giao do ĐVVC quyết, và tới sau khi ca đã đóng |
  | Độ chính xác tồn kho (Warehouse) | Chênh lệch kiểm kê ở độ mịn MẪU MÃ, phiếu không ghi người kiểm |
  | Đóng góp / chất lượng quyết định quảng cáo (Marketing) | ERP đọc Facebook Ads chứ không ghi — không biết ai đã cắt dòng nào |

  Giấu chúng đi thì màn hình trông đầy đủ và không ai biết còn thiếu gì.

## 7. Mẫu OKR / BSC — không tự kích hoạt

- `lib/constants/okr-templates.ts`: 8 mẫu, phủ đủ 7 phòng. Nút **Dùng mẫu** mở hộp thoại buộc đi
  qua từng ô ĐÍCH; ô để trống thì KR đó **không** được tạo. Kết quả luôn là mục tiêu **Nháp**, và
  nút **Bật** là một hành động riêng (`setObjectiveStatus`) — từ lúc bật nó mới chảy vào bảng tổng
  hợp và vào thẻ điểm của người phụ trách.
- Bật một mục tiêu **không có KR nào** bị chặn: nó không đo được gì, chỉ làm bẩn bảng tổng hợp.
- **Sửa một lỗi thật của bản trước:** `createScorecard` dựng ô BSC mẫu với `unit: NUMBER,
  direction: UP` ghi cứng. Với chỉ số càng-thấp-càng-tốt (tỷ lệ hoàn, việc quá hạn, dòng tiền chưa
  phân loại) điều đó làm **điểm ô đảo ngược**: hoàn càng nhiều thì thẻ điểm càng đẹp. Nay đọc đơn
  vị và chiều từ `METRIC_BINDINGS`.

## 8. Họp tuần trên MỘT màn hình (`/work/review`)

Không dựng dashboard mới — bổ sung vào đúng trang đã có. Ảnh chụp lên **v2** với ba trường mới:

- `totals` — việc mở / quá hạn / bị chặn / tiền treo của cả kỳ, kèm **số của kỳ trước** ngay bên
  dưới. "38 việc quá hạn" không nói gì; "38, kỳ trước 52" nói rằng đang gỡ được.
- `bottleneck` — phòng đang chặn guồng, chọn theo **TỶ LỆ** quá hạn (cùng thước với `healthOf`),
  không theo số việc nhiều nhất: phòng đông việc nhất là phòng *bận* nhất, không phải phòng *kẹt* nhất.
- `topIssues` — năm việc nóng nhất kèm **tên người đang cầm**. Xếp theo điểm ưu tiên, không theo số
  tiền: việc giữ nhiều tiền nhưng đã hết cứu được thì mang ra họp cũng không đổi được gì.

Kỳ trước chỉ so với kỳ **đã chốt** cùng loại, cùng phạm vi. Ảnh chụp v1 vẫn đọc được:
`normalizeSnapshot` dựng lại `totals`/`bottleneck` **từ chính ảnh chụp**, và để `topIssues` rỗng —
dựng lại từ dữ liệu hôm nay là sửa ngầm một kỳ đã chốt (AGENTS.md mục 8.9).

## 9. Mức sẵn sàng vận hành (`/work/settings`, đầu trang)

`getReadiness()` trả lời "ngày mai dùng được chưa" bằng ba nhóm số: khối lượng thật · **độ phủ hạn
xử lý** · **lỗ hổng khai báo**. Nhóm thứ ba là danh sách việc phải làm của chủ shop, đặt ngay trên
các nút để làm chúng — một trang báo cáo riêng sẽ nói "còn 3 phòng chưa có trưởng" rồi để người đọc
tự đi tìm chỗ sửa.

Nguồn không đọc được **được nêu tên** và số của nó không bị coi là 0. Một báo cáo "sẵn sàng 100%"
dựng trên ba nguồn im lặng là loại báo cáo tệ nhất.

Một chỗ bài kiểm bắt được: bản đầu của báo cáo đếm cả bốn nút chung của lớp công việc (nhận việc,
ghi chú, hoãn, báo chặn) nên **mọi** nguồn đều trông như xử lý được tại chỗ. Nay chỉ đếm nút RIÊNG
của nguồn gọi được Server Action của miền — và `ADS_DECISION` đúng ra phải hiện 0, vì ERP đọc
Facebook Ads chứ không ghi.

---

## 10. Kiểm thử

`tests/work-os.test.ts` thêm sáu khối (21–26): cấu hình hạn & phòng ban (độ phủ, mặc định lấy lại
từ hằng số gốc, thứ tự ghi đè, dữ liệu rác không làm sập) · áp cấu hình lên việc · `closedStats` ·
nút thắt chọn theo tỷ lệ + ảnh chụp v1 · hiệu suất theo phòng + mẫu OKR/BSC · mức sẵn sàng.

## 11. Chủ shop phải tự cấu hình những gì

Xem mục cuối của câu trả lời bàn giao. Tóm tắt: danh sách nhân viên ↔ phòng ban · trưởng phòng ·
hạn xử lý (nếu muốn khác mặc định) · đích OKR · trọng số BSC. ERP cố ý không đoán hộ bất kỳ thứ nào
trong năm thứ đó.
