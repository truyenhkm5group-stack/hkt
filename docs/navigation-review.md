# RÀ SOÁT ĐIỀU HƯỚNG ERP — ĐỀ XUẤT, CHƯA THỰC HIỆN

> Yêu cầu mục 14 của bản Work OS: *"Không tuỳ tiện xoá module. Nếu module hiện tại ít dùng hoặc
> duplicate: ghi proposal trước khi remove."*
>
> **Bản này KHÔNG xoá, KHÔNG di chuyển route nào.** Nó ghi lại hiện trạng và đề xuất để chủ shop
> quyết. Thứ duy nhất bản Work OS thêm vào thanh bên là **một** mục: *Công việc & mục tiêu*.

Ngày rà: 12/09/2026 · 33 mục menu / 56 trang.

---

## 1. Hiện trạng: bốn nhóm menu

| Nhóm | Số mục | Nhận xét |
|---|---:|---|
| Vận hành | 9 | Dài nhất. Ba mục đầu (Tổng quan · Cần xử lý · Công việc) đều trả lời "hôm nay làm gì" |
| Kho & giao vận | 4 | Mạch lạc |
| Tài chính | 8 | Dài; nhưng mỗi mục là một sổ có thẩm quyền riêng (xem `docs/finance-truth-contract.md`) |
| Kho & sản xuất | 6 | Mạch lạc |
| Hệ thống | 4 | Mạch lạc |

---

## 2. Chồng lấn ĐÃ XÁC ĐỊNH (không đề xuất xoá gì)

### 2.1 Ba lối vào cho cùng một hàng đợi

`Cần xử lý` (`/alerts`) · `Điều hành theo khâu` (`/operations`) · `Nút thắt trước khi rời kho`
(`/operations/fulfillment`) đã được gom thành **một mục menu + dải tab** (`QueueViewTabs`). Đây là
mô hình đúng, và bản Work OS lặp lại nó: `/work` là một mục, năm góc nhìn là tab.

### 2.2 `Cần xử lý` và `Công việc của tôi` — KHÁC NHAU, giữ cả hai

Dễ tưởng là trùng, nhưng hai trang trả lời hai câu:

* `/alerts` — *"hệ thống phát hiện được gì?"* Nguồn là `notifications`, sắp theo điểm tác động.
  Người đọc là người **điều phối**: nhìn toàn bộ, quyết việc nào giao cho ai.
* `/work` — *"tôi phải làm gì?"* Nguồn là **bảy** hàng đợi cộng lại, lọc theo người đăng nhập,
  xếp theo hạn. Người đọc là người **làm**.

Gộp chúng lại sẽ buộc một trong hai nhóm người dùng đọc danh sách của nhóm kia.

### 2.3 `Vận đơn & care` và nguồn `SHIPMENT_CARE` trong `/work`

Cùng dữ liệu, hai độ phân giải: trang Vận đơn có bàn care đầy đủ (hành trình, năng lực ĐVVC, gửi
yêu cầu phát lại); `/work` chỉ hiện dòng việc và nút mở sang đó. **Không** đề xuất bỏ bên nào —
người giao vận làm cả ngày ở trang chuyên biệt, người khác chỉ cần thấy nó tồn tại.

---

## 3. Đề xuất — CẦN CHỦ SHOP QUYẾT

### Đ1. Gom nhóm "Vận hành" theo phòng ban thay vì theo module

Hiện nhóm này trộn việc của ba phòng (CSKH, marketing, kinh doanh). Đề xuất tách:

```
Hôm nay      Tổng quan · Cần xử lý · Công việc & mục tiêu
Bán hàng     CSKH & tin nhắn · Đơn hàng · Đơn landing page · Khách hàng · Chăm sóc & bán chéo
Marketing    Quảng cáo · Ý tưởng marketing
```

**Chi phí:** người dùng cũ phải tìm lại vài mục trong một tuần đầu. **Lợi:** mỗi người mở menu
thấy nhóm của mình ở một chỗ. **Chưa làm** vì đây là thay đổi thói quen, không phải thay đổi kỹ
thuật — chủ shop quyết.

### Đ2. `Nhật ký kho` (`/inventory`) — nghi ít dùng

Là nhật ký thô của `inventory_histories`. Từ khi có `Nhập hàng & kiểm kê` và `Kiểm đếm hàng hoàn`,
gần như mọi thao tác đều có màn hình chuyên biệt. **Đề xuất:** đo lượt truy cập 30 ngày trước khi
quyết; nếu gần 0 thì chuyển thành tab của `Nhập hàng & kiểm kê`, **không xoá** — nó là đường truy
vết cuối cùng khi một con số tồn kho sai.

### Đ3. `Tỷ lệ giao thành công` (`/reports/returns`) nằm ở nhóm "Kho & giao vận"

Nó là một **báo cáo**, và mọi báo cáo khác nằm ở nhóm Tài chính. Đặt ở đây vì người giao vận dùng
nó hằng ngày. **Đề xuất:** giữ nguyên, đây là quyết định đúng dù trông lệch.

---

## 4. Nguyên tắc rút ra, áp cho mọi bản sau

1. **Một bàn làm việc = một mục menu.** Nhiều góc nhìn thì dùng tab, không phải nhiều mục.
2. **Không xoá module vì trông trùng.** Phải đo lượt dùng trước, và phải giữ đường truy vết.
3. **Trang mới phải có lối vào từ menu** — `tests/ui-consistency.test.ts::testNavigationCoverage`
   chặn ở mức mã nguồn, hoặc khai tường minh là vào từ tab bar kèm lý do.
