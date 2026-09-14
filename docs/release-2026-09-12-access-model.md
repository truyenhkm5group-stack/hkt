# P0 — Sửa gán phòng ban · Ba chiều quyền truy cập · Một sự thật tổ chức

Ba việc P0 làm liền nhau vì chúng là ba tầng của cùng một câu hỏi: **ai, ở đâu, được làm gì.**

---

## P0.1 · Vì sao production không gán được ai vào phòng ban

### Bằng chứng, theo thứ tự tìm ra

1. **Nhật ký kiểm toán production**: suốt cả buổi chủ shop thử gán người, bảng `audit_logs`
   **không có một dòng `DEPARTMENT_MEMBER_SET` nào** — chỉ `DEPARTMENT_SAVE` và
   `DEPARTMENT_MEMBER_REMOVE`. Server action chưa từng được gọi ⇒ lỗi ở giao diện, không ở dữ
   liệu, không ở quyền.
2. **Dựng lại trên trình duyệt**: ô chọn mở ra, cây trợ năng có đủ 7 phòng ban, màn hình không
   thấy gì.
3. **Đo toạ độ thật**: nút bấm `y=1449`, bảng chọn `y=6787`, `position: fixed`, không có lớp bọc
   popper — trên màn hình cao 1100px. Bảng chọn nằm cách đáy màn hình gần 5.700px.

### Cơ chế

`components/ui/select.tsx` để `SelectContent` mặc định `position="item-aligned"`. Ở chế độ đó
Radix căn bảng chọn theo **mục đang chọn**. Bốn ô chọn dùng để RA LỆNH (thêm người, chọn phòng,
chọn trưởng phòng, chuyển việc) đều được điều khiển bằng `value=""` — không khớp mục nào — nên
Radix rơi vào nhánh dự phòng và đặt bảng ở toạ độ vô nghĩa.

### Vì sao không vá bằng `position="popper"`

Vá một chữ thì bốn chỗ hết hỏng, nhưng cái sai gốc còn nguyên: **một ô chọn mà giá trị không bao
giờ đổi thì không phải ô chọn — nó là một thực đơn.** Chỗ thứ năm sẽ lại được viết y như vậy. Nên
đổi hình dạng: `components/picker-menu.tsx` (Popover + danh sách nút bấm, có ô tìm kiếm từ 6 lựa
chọn trở lên). Không có "giá trị đang chọn" thì không có gì để căn sai.

`tests/org-membership.test.ts` quét 325 tệp giao diện để không ai dựng lại `<Select value="">`.
Phép quét bỏ chú thích trước — chính các tệp đã SỬA lỗi đều nhắc tên hình dạng cũ để người đọc sau
hiểu vì sao, và một lá chắn phạt việc ghi lại bài học là lá chắn sai.

### Lỗi ngầm phát hiện khi viết kiểm thử

`audit_logs.user_id` có khoá ngoại tới `users.id`. Mã gọi từ hệ thống truyền `user_id = ""`, vi
phạm khoá ngoại, lượt ghi nhật ký đổ — và `audit()` cố ý nuốt lỗi để không chặn nghiệp vụ. Kết
quả: thao tác chạy xong nhưng **không để lại dấu nào**. Nay chuẩn hoá `"" → null`.

### Kiểm chứng trên trình duyệt (bản build production)

| | trước | sau |
|---|---|---|
| toạ độ bảng chọn | `y=6787` (ngoài màn hình) | `(698, 548)` — cạnh nút bấm |
| gán từ `/settings/users` | không có gì xảy ra | 8 → 7 người chưa có phòng ban |
| `/work/settings` thấy ngay | — | có |
| lỗi console / 5xx | — | không có |

---

## P0.2 · Ba chiều quyền truy cập

ERP chỉ có **một** chiều là `users.role`, nên mọi câu hỏi khác bị nhét vào nó:

| câu hỏi thật | làm gì với một chiều | hậu quả |
|---|---|---|
| "Chị Lan làm kế toán" | đặt vai `ACCOUNTANT` | đúng tình cờ |
| "Anh Hùng là trưởng kho" | đặt vai `MANAGER` | **sai** — anh ấy thấy luôn sổ ngân hàng |
| "Em Mai chỉ xem đơn của em" | không đặt được | không có chiều nào nói "của em" |

| chiều | trả lời | lưu ở |
|---|---|---|
| **VAI TRÒ** | được làm gì | `users.role` + `access_roles` |
| **CHỨC DANH** | làm chức gì | `positions` — **không sinh quyền** |
| **PHẠM VI** | trên dữ liệu nào | `users.data_scope` — **chỉ thu hẹp** |

### Vai trò hệ thống được bảo vệ bằng CẤU TRÚC

Tám vai trò hệ thống **không nằm trong bảng** `access_roles` — chúng là hằng số trong mã nguồn,
nên không câu `DELETE` nào xoá được. Đó là một tính chất của cấu trúc, không phải một cờ
`is_system` mà một câu `UPDATE` nhỡ tay là mất.

### Chặn leo thang ở hai lớp

- Vai trò tuỳ chỉnh **không cấp được `users:manage`** (cửa để tự dựng vai trò toàn quyền rồi gán
  cho chính mình) và **không lấy `ADMIN` làm nền**.
- Chặn ở **lược đồ đầu vào** VÀ chặn lại **lúc tính**. Nếu chỉ lọc lúc tính thì CSDL vẫn lưu một
  vai trò trông như thể nó cấp quyền đó và màn hình vẫn hiện dấu tích: người xem tưởng đã cấp,
  hệ thống thì không.
- Tắt vai trò **không xoá** nó; phép tính rơi về mẫu vai trò nền — **không bao giờ** về toàn quyền.

### Vùng nhạy cảm

Quyền thuộc Tài chính / Nhân sự / Điều hành chỉ có hiệu lực khi người đó có phạm vi `ALL` **hoặc**
là **thành viên phòng ban sở hữu** vùng đó. Gắn với phòng ban chứ không với vai trò vì thành viên
phòng Kế toán là một sự thật tổ chức có người xếp và có nhật ký. Muốn kế toán viên xem sổ ngân
hàng thì **xếp họ vào phòng Kế toán** — đúng việc phải làm — chứ không nới phạm vi ra toàn công ty.

### Không ai mất quyền vì bản này

`data_scope` mặc định `'ALL'` cho mọi dòng đang có; `ALL` = không thu hẹp gì = đúng hành vi hôm
nay. Phiên đăng nhập có đường nhanh: phạm vi `ALL` và không có vai trò tuỳ chỉnh ⇒ **không thêm
một câu truy vấn nào**. `tests/migration-upgrade-path.test.ts` dựng đúng trạng thái production rồi
kiểm lại tài khoản tạo TRƯỚC migration: phạm vi `ALL`, không bị gán vai trò hay chức danh nào.

### Kiểm chứng trên trình duyệt

| kiểm | kết quả |
|---|---|
| quản trị viên: cảnh báo "giới hạn không có thật" + ô chọn bị khoá | có |
| Kế toán, phạm vi `ALL` → `DEPARTMENT` | 29 → 23 quyền |
| vùng nhạy cảm sau khi thu hẹp | Tài chính · Nhân sự · Điều hành đều "không chạm được" |
| khối "Phạm vi đã cắt 6 quyền" + lý do từng quyền | 6 dòng, đủ lý do |
| ô "Quản lý người dùng" trong trình dựng vai trò | bị khoá |
| vai trò nền chọn được | Quản lý · Trưởng nhóm · Kế toán · Kho · CSKH · Marketing · Chỉ xem — **không có Quản trị** |
| đặt chức danh "Kế toán" cho một người | 20 → 20 quyền (**không đổi**) |

---

## P0.3 · Một sự thật tổ chức

### Một đường đọc

"Còn hiệu lực" phải có nghĩa giống nhau ở mọi màn hình: dòng thành viên còn bật **VÀ** phòng ban
còn bật. Bốn nơi tự viết lấy mệnh đề `WHERE`, và `lib/queries/work-performance.ts` **quên vế phòng
ban** — người thuộc phòng đã tắt vẫn được tính vào thẻ điểm của phòng đó, trong khi hàng đợi của họ
đã trống từ lâu. Không ai báo lỗi: hai con số cùng đúng theo hai định nghĩa khác nhau.

Nay chỉ `lib/org/membership.ts` (và `lib/auth/access.ts`, vì nó là máy tính quyền và không được
phụ thuộc ngược vào tệp ghi nhật ký) được đọc thẳng `department_members`. Kiểm thử quét 589 tệp.

### Một danh sách màn hình cần làm mới

Bốn tệp server action mỗi tệp giữ một mảng riêng, và **cả bốn đều quên `/work/okr` và
`/work/review`**. Hậu quả không phải một lỗi — nó là một câu nói dối: chủ shop xếp người vào phòng,
mở màn Mục tiêu ra vẫn thấy tổ chức cũ, kết luận thao tác của mình đã trượt, rồi làm lại. Đúng cái
vòng lặp đã sinh ra sự cố 12/09. Nay chỉ còn `ORG_DEPENDENT_PATHS`.

### Xem trước tác động, không tự giao lại

`impactOfLeaving` trước đây đếm `work_items` và ra gần như luôn **bằng 0** — đúng kỹ thuật, sai ý
nghĩa: `work_items` chỉ giữ việc tay và việc định kỳ, còn việc thật (case CSKH, care vận đơn, cảnh
báo, dòng tiền chưa phân loại) nằm ở miền nguồn. **Một cảnh báo báo 0 còn tệ hơn không có cảnh
báo**: nó nói với người bấm rằng gỡ người này ra chẳng ảnh hưởng tới ai.

Nay đếm bằng đúng phép chiếu mà hàng đợi của chính người đó dùng, kèm số việc quá hạn, tiền đang
treo và phòng ban của việc. `window.confirm` được thay bằng hộp thoại dùng chung — `confirm()` chỉ
chứa được một dòng chữ nên con số duy nhất lọt vào đó là "đang cầm N việc", và người bấm đọc "12
việc" rồi đồng ý mà không biết trong đó có 4 việc quá hạn. Màn Cấu hình công việc trước đây còn
**không hỏi gì cả**.

---

## Chủ shop cần làm gì sau bản này

Không bắt buộc gì — bản này không đổi hành vi của tài khoản nào. Khi muốn dùng:

1. **`/settings/users` → cột Phòng ban**: xếp người vào phòng (đây là thứ mở vùng nhạy cảm).
2. **Chức danh**: 10 chức danh gieo sẵn, sửa / thêm / tắt thoải mái. Nhớ: chúng **không** mở quyền.
3. **Vai trò tuỳ chỉnh**: chỉ tạo khi không vai trò hệ thống nào tả đúng một bó quyền.
4. **Phạm vi dữ liệu**: mặc định `Toàn công ty`. Thu hẹp cho ai thì mở hộp thoại **Quyền & phạm
   vi**, xem trước quyền thực tế, rồi lưu.

## Migration

`drizzle/0070_access_role_position_scope.sql` — viết tay, idempotent, **chỉ cộng thêm**: hai bảng
(`access_roles`, `positions`), ba cột trên `users` (`access_role_id`, `position_id`, `data_scope`),
mười chức danh gieo sẵn nối đúng phòng ban. Không cột nào bị xoá hay đổi kiểu, không dòng dữ liệu
nào đang có bị viết lại.
