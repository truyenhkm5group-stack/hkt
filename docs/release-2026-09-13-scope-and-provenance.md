# Phạm vi dữ liệu thi hành thật · Chỉ số hiệu suất có xuất xứ · Lịch sử bất biến

## A · Phạm vi dữ liệu

### Trạng thái trước bản này

`users.data_scope` tồn tại, hiện trên màn hình quản trị, nằm trong phiên đăng nhập — và **không
một hàm truy vấn nào đọc nó**. Kiểm kê 13/09: `user.scope` và `user.departmentCodes` không được
đọc ở đâu ngoài `lib/auth/*` và giao diện quản trị.

Chủ shop đặt "Chỉ của mình" cho một người, màn hình xác nhận đã lưu, và người đó vẫn xem được
toàn bộ đơn hàng của shop. **Một ô cấu hình không nối vào đâu còn tệ hơn không có ô đó: nó tạo ra
niềm tin.**

### Sự thật khó chịu phải nói trước

Kiểm kê `db/schema.ts` — trong mười nhóm dữ liệu chủ shop nêu, **chỉ Công việc và Chăm sóc vận đơn
có khoá ngoại thật tới `users.id`**:

| nhóm | có cột chủ dòng? | thực tế trong bảng |
|---|---|---|
| Đơn hàng | ✗ | `seller_name` · `care_name` · `marketer_name` — chuỗi tên Pancake |
| Khách hàng | ✗ | không một cột người nào |
| Vận đơn | ✗ | người phụ trách chỉ có ở `shipment_care`, và chỉ cho kiện đã mở ca |
| CSKH | ✓ (chuỗi) | `assignee` · `created_by` — email / tên |
| Công việc | ✓ | `assignee_id` · `owner_id` · `department_id` |
| Tài chính | ✗ | `classified_by` là *ai đã phân loại*, không phải tiền *của ai* |
| Kho · Hàng hoàn | ✗ | `created_by` / `inspected_by` là *ai đã gõ / đã đếm* |
| Quảng cáo | ✗ | `marketer_id` trỏ nhân sự bảng lương, không phải tài khoản ERP |
| Báo cáo | ✗ | số tổng hợp — cộng xong không tách lại được |

Nghĩa là **"SELF: chỉ dữ liệu thuộc chính user" không thực hiện được trên phần lớn dữ liệu** —
không phải vì code lười mà vì dữ liệu không mang thông tin đó.

Ba đường, hai đường sai:

| | hậu quả |
|---|---|
| cho xem hết | lỗ hổng im lặng — **đúng trạng thái hôm nay** |
| trả rỗng lặng lẽ | người dùng không hiểu gì, rồi có người tắt hẳn phạm vi cho xong |
| **từ chối và nói rõ** | lỗ hổng vô hình thành một việc thấy được |

### Thiết kế

**Hai kiểu thu hẹp**, khai một chỗ ở `lib/constants/data-scope-policy.ts`:

1. **theo dòng** — bảng có cột chỉ ra người của từng dòng (chỉ CSKH);
2. **theo phòng sở hữu** — cả loại dữ liệu thuộc một phòng. Không có "tiền của riêng chị Lan"
   trong sổ ngân hàng; thu hẹp có nghĩa ở đó là *người không thuộc Kế toán thì không vào*.

**Không truyền người dùng qua tham số.** Cách hiển nhiên là `listOrders(params, viewer)`. Nhược
điểm chí mạng: quên truyền thì mặc định là xem được hết. Danh tính lấy từ `getCurrentUser()` vốn
đã `cache()` theo lượt dựng — không chỗ gọi nào truyền gì, nên không chỗ gọi nào quên được.

**Hai tình huống "không có người dùng", hai câu trả lời ngược nhau.** Trong một yêu cầu HTTP mà
không có phiên hợp lệ ⇒ **đóng**. Ngoài mọi yêu cầu (job nền, script, kiểm thử) `cookies()` ném
lỗi ⇒ **mở**, an toàn vì đường đó không phục vụ ai. Gộp hai cái theo hướng "không có người dùng
thì mở" sẽ biến một cookie hỏng thành toàn quyền.

**Khoá quyền truyền tường minh.** `/cod` dùng `cod:view`, `/bank` dùng `bank:view`,
`/reports/cashflow` dùng `reports:cash`. Nếu cổng áp khoá "đại diện" của sổ thì mỗi tuyến âm thầm
đổi quyền cần có — thoái lui quyền mà không ai nhận ra cho tới khi có người mất màn hình.

### Kiểm chứng trên trình duyệt

Kế toán (thuộc phòng FINANCE), phạm vi đặt thành *Cả phòng ban của mình*:

| tuyến | kết quả |
|---|---|
| `/bank` · `/cod` | **mở được** |
| `/orders` · `/customers` · `/cs` | bị chặn — "là dữ liệu của phòng SALES" |
| `/shipments` | bị chặn — "phòng LOGISTICS" |
| `/inventory` | bị chặn — "phòng WAREHOUSE" |
| `/ads` | bị chặn — "phòng MARKETING" |
| `/reports` | bị chặn — "phòng MANAGEMENT" |

Không lỗi console, không 5xx. Bảng xem trước trong màn quản trị nói **trước khi lưu** đúng từng
dòng đó.

### Gia cố kèm theo

`AUTH_SECRET` thiếu trên production thì app **dừng** thay vì rơi về một chuỗi nằm công khai trong
kho mã — ai đọc kho cũng tự ký được cookie quản trị. Luật áp ở cả `lib/env.ts` lẫn `middleware.ts`
(Edge không import được `lib/env`); kiểm thử giữ hai bản chép khớp nhau.

`/api/sync/*` lọt qua middleware theo thiết kế, nhưng route tự bảo vệ bằng cron secret hoặc phiên
có `sync:run` — **không phải lỗ hổng**, đã kiểm.

---

## B · Xem trước quyền thực tế

Hộp thoại **Quyền & phạm vi** thêm bảng *"thực tế đọc / sửa được gì"*: 11 loại dữ liệu, đọc/sửa,
kèm lý do lấy **thẳng từ máy quyết định của máy chủ** — không tính lại ở trình duyệt, vì một màn
xem trước sai còn tệ hơn không có, nó tạo ra niềm tin.

Danh sách quyền nói người này **cầm khoá nào**; bảng này nói khoá ấy **mở được gì**. Chủ shop hỏi
câu thứ hai.

---

## C · Chỉ số hiệu suất tự khai xuất xứ

"Chị Lan đạt 92%" là câu không quyết định được gì. Sáu thứ đi kèm mỗi chỉ số:

| trường | trả lời câu |
|---|---|
| `basis` | đọc từ chứng từ nào |
| `owner` | của một NGƯỜI hay của cả PHÒNG |
| `period` | khoảng nào |
| `sample` + `denominatorLabel` | 92% trên 2 hay trên 200, và 2 **cái gì** |
| `confidence` + `linkage` | nối người bằng khoá tài khoản hay bằng tên gõ tay |
| `attribution` | phần nào **không** do người đó quyết |

### Độ tin cậy là hàm, không phải nhãn

Ai cũng gật gù với chữ "độ tin cậy" cho tới lúc phải điền nó; để người viết code tự chấm thì nó
thành trang trí. Nên nó được **tính**:

- mẫu < 5 ⇒ `LOW`; mẫu < 20 ⇒ `MEDIUM`
- nối bằng **tên gõ tay** ⇒ `LOW` **bất kể mẫu lớn tới đâu** — sai người thì số đúng vẫn vô nghĩa
- kết quả **chung** (ĐVVC giao được hay không) ⇒ trần là `MEDIUM`
- nối bằng email ⇒ trần là `MEDIUM` (đổi email là mất dấu)

"Xếp hạng được" là câu hỏi **khác**: mẫu dưới 20 thì thẻ điểm **không tô màu**. Tô đỏ một con số
50% đứng trên 2 quan sát là nói với người đọc rằng người này làm kém, trong khi thứ duy nhất kết
luận được là *chưa đủ dữ liệu*.

### Gắn ở đúng một chỗ

Mười ba chỗ dựng chỉ số trả về `MetricInput`; một hàm duy nhất gắn sáu trường kia vào. Chỉ số thêm
vào ngày mai **không thể quên khai** — nó lấy xuất xứ tự động hoặc không biên dịch được.

---

## D · Lịch sử bất biến (`performance_snapshots`, migration 0071)

Thẻ điểm sống tính lại mỗi lần mở — đúng cho *"tuần này đang thế nào"*, **sai** cho *"quý trước
chị Lan đạt bao nhiêu"*: chỉ cần ai sửa một mệnh đề `WHERE` là con số quý trước đổi theo, lặng lẽ,
không đối chiếu được với bản đã in ra hồi đó.

| luật | cơ chế |
|---|---|
| không ghi đè | khoá duy nhất `(kỳ, chủ thể, chỉ số)` + `ON CONFLICT DO NOTHING` — ràng buộc ở mức CSDL, không phải lời hứa |
| không chụp kỳ chưa đóng | đóng băng một con số nửa vời thành "sự thật của tuần đó" là thứ luật 1 khiến không sửa được nữa |
| chụp cả `null` | bỏ trống thì "kỳ đó chưa đo được" trông y hệt "kỳ đó job chưa chạy" |

Luật 3 lộ ra một lỗ trong chính thiết kế ban đầu khi kiểm thử đỏ: hàm đo chỉ trả dòng cho người
**có** hoạt động, nên không có gì để ghi `null`. Phải thêm danh mục chỉ số máy đọc được cho từng
phòng (`DEPT_METRIC_KEYS`) thì luật mới thực hiện được.

Lưu thành **dòng** chứ không phải khối JSON: câu hỏi của quản trị hiệu suất là *"chỉ số này đang
lên hay xuống"*, một câu trải **dọc** nhiều kỳ. Không đặt khoá ngoại tới `users` — lịch sử của
người đã nghỉ vẫn là lịch sử của shop.

### Kiểm chứng qua đường HTTP thật

```
POST /api/sync/work-snapshot  lần 1 → written: 3, skipped: 0
POST /api/sync/work-snapshot  lần 2 → written: 0, skipped: 3
```

### Xu hướng

`/work/performance` đọc **từ** ảnh chụp, không tính lại. Chênh lệch theo **đơn vị của chính chỉ
số**, không phải phần trăm của phần trăm. Kỳ chưa đo được không phải một điểm rơi về 0. Hai kỳ
tính bằng hai phiên bản công thức khác nhau thì in *"đổi cách tính giữa hai kỳ"* thay vì vẽ một
mũi tên như thật.

Job `work-snapshot` chạy mỗi 6 giờ — không phải để chụp dày, mà để **không bỏ lỡ** một kỳ nếu máy
chủ tắt đúng lúc giao tuần: bỏ lỡ một tuần là mất hẳn, vì kỳ đó sẽ không bao giờ được chụp lại.
