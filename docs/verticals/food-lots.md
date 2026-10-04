# Thực phẩm / hải sản — module `lots` (lô & hạn dùng)

Lộ trình chung: `docs/verticals/ROADMAP.md` (Phần B, dòng «Thực phẩm / hải sản»). Bật sẵn trong mẫu `food-commerce` và
`seafood-commerce` từ bản 1.1.0 — tổ chức đã cài bản 1.0.0 thấy «có bản mới» ở trang mẫu ngành và tự cài.

## Nỗi đau (giả thuyết, cần khách thử xác nhận — HSLC là ứng viên)

- Hàng có HẠN DÙNG mất giá theo ngày; lô cũ nằm sau lô mới trong kho ⇒ hết hạn mới phát hiện, phải huỷ.
- Không biết lô nào còn bao nhiêu để đẩy bán / giảm giá trước khi hết hạn.
- Khách hỏi «hàng date bao giờ» — nhân viên ra kho lật thùng.

## Thiết kế: lô là lớp GẮN THÊM, không phải sổ kho thứ hai

- `stock_lots` (0199): mã lô · hạn dùng · ngày sản xuất (tuỳ chọn) · số lượng, gắn lên MỘT dòng phiếu kho dương (nhập mới / tái
  nhập / điều chỉnh tăng). Một dòng chia được nhiều lô; tổng lô không vượt số của dòng (kiểm sau khoá tư vấn theo dòng); một mã
  lô một lần trên một dòng. Xoá phiếu ⇒ lô đi theo (cascade).
- **Lô KHÔNG tham gia phép tính tồn nào** (AGENTS.md mục 3.10): tồn thực tế / khả dụng vẫn chỉ là phiếu kho − đã xuất. Gắn
  hay gỡ lô không đổi một cái tồn nào (bài kiểm khoá). Hàng hết hạn phải huỷ ⇒ lập PHIẾU XUẤT KHO như mọi lần xuất tay.
- **«Lô còn bao nhiêu» là ƯỚC TÍNH lúc đọc** (`estimateLotRemaining`, luật 8.6): tồn thực tế của mẫu mã rải ngược vào các
  dòng nhập, dòng MỚI NHẤT giữ hàng trước (giả định nhập trước xuất trước); trong một dòng, lô hạn XA giữ trước (hạn gần đi
  trước — FEFO); phần dòng chưa gắn lô giữ phần của nó («chưa gắn lô») nên số không dồn hết vào lô đã khai. Tồn chưa biết
  (mẫu mã chưa có phiếu NHẬP) ⇒ «còn» là `—`, không phải 0. Tồn vượt mọi dòng nhập ⇒ phần dư in riêng.
- Vì sao không bắt chọn lô khi xuất / giao đơn: đổi lược đồ đơn + phiếu giao + vận đơn cho MỘT ngành là động vào xương sống
  sổ kho của mọi tổ chức; ước tính đủ để trả lời câu hỏi thật («lô nào sắp hết hạn mà còn hàng»). Khi khách thử cần truy vết
  lô tới từng đơn (thu hồi sản phẩm) thì làm phase riêng.

## Màn hình `/inventory/lots`

- Đỏ: lô ĐÃ hết hạn mà ước tính còn hàng ⇒ huỷ bằng phiếu xuất kho. Ngày hết hạn vẫn còn dùng được.
- Cận hạn trong 7 / 14 / 30 / 60 / 90 ngày — BỘ LỌC XEM người dùng chọn (mặc định 30), không phải ngưỡng nghiệp vụ (luật 38).
- Theo mẫu mã: tồn thực tế, phần chưa gắn lô, từng lô (hạn, phiếu, số nhập, còn ước tính) và cột «Lấy» = thứ tự lấy hàng hạn
  gần trước, bỏ lô đã hết hạn.
- Form «Gắn lô cho phiếu nhập»: dòng phiếu 120 ngày gần nhất còn phần chưa gắn; số lượng mặc định = phần còn.
- Quyền `lots:view` / `lots:write` (vai trò WAREHOUSE mặc định có cả hai). Module TẮT ở tổ chức nhà.

## Chưa làm

- Gợi ý HSD từ «hạn dùng (ngày)» khai trên sản phẩm; cảnh báo cận hạn qua kênh nhóm (cần job cảnh báo chạy cho tổ chức
  khách — chờ quyết định lịch chạy).
- Bán theo cân lẻ (số lượng thập phân) — vẫn chờ khách thử hàng tươi.
