# Gia dụng / điện máy nhỏ — mẫu ngành `household` + module `warranty`

Lộ trình chung: `docs/verticals/ROADMAP.md` (Phần B — gia dụng là ngành đầu tiên sau Fashion COD vì dùng lại gần trọn chuỗi
đơn → vận chuyển → hoàn hàng, chỉ thiếu phần SAU bán).

## Nỗi đau (giả thuyết, cần khách thử xác nhận)

- Khách gọi báo lỗi: nhân viên phải lục tin nhắn / sổ tay để biết khách mua gì, ngày nào, còn bảo hành không.
- Serial / IMEI không ghi lại ⇒ không biết máy khách mang tới có đúng máy shop bán không.
- Ca bảo hành gửi nhà cung cấp «mất dấu»: không ai biết ca nào đang nằm ở đâu, khách chờ bao lâu.
- Chi phí bảo hành không đo được ⇒ không biết mã hàng nào lỗi nhiều, nhà cung cấp nào tệ.

## Module `warranty` (0196)

- **Phiếu bảo hành**: khách · sản phẩm (mẫu mã, tên chụp lại) · serial / IMEI (tuỳ chọn) · ngày mua · số tháng ⇒ hạn. Hạn do
  máy chủ tính (`warrantyExpiry`: 31/01 + 1 tháng = ngày cuối tháng 2). Ngày mua không được ở tương lai.
- **Một serial một phiếu đang hiệu lực** — không phân biệt hoa thường; kiểm trong giao dịch sau khoá tư vấn theo serial, chỉ mục
  duy nhất có điều kiện của CSDL chặn lần cuối. Huỷ phiếu (bắt buộc lý do) thì serial dùng lại được.
- **Ca bảo hành**: Mới nhận → Đang xử lý → Đã xong (sửa xong · đổi máy mới · hoàn tiền · gửi nhà cung cấp · không lỗi) hoặc Từ
  chối (bắt buộc lý do). Ca đã đóng không đổi nữa. Hai người bấm cùng lúc ⇒ chỉ một lượt thắng.
- **«Còn bảo hành» KHÔNG lưu thành cột**: phiếu tính từ hạn so với hôm nay; ca tính từ ngày mở ca (giờ VN) so với hạn — ngày hết
  hạn vẫn còn bảo hành. Ca ngoài hạn vẫn mở được (shop có thể sửa có thu tiền), màn hình ghi «ngoài hạn».
- **Tiền**: chi phí của shop và tiền thu khách là số nguyên VND; để trống = CHƯA BIẾT, không phải 0 (luật 42).
- **Tra cứu**: `/warranty?q=` theo SĐT (bỏ ký tự không phải số), serial, tên khách, tên sản phẩm. Hàng đợi «Ca đang mở» cũ nhất
  trước. Trang khách có khung «Bảo hành».
- **Quyền**: `warranty:view` / `warranty:write` (vai trò CS mặc định có cả hai). Module TẮT ở tổ chức nhà.

## Mẫu `household`

Module: lõi · công việc · khách · sản phẩm · đơn · kho · giao vận · hoàn hàng · chăm sóc khách · tài chính · bảo hành. Vai trò
«CSKH & bảo hành» và «Kỹ thuật» (không xem doanh thu, không sửa đơn). Field sản phẩm: nhóm hàng, bảo hành (tháng — chỉ gợi ý),
hàng cồng kềnh, dễ vỡ; field khách: địa chỉ lắp đặt. Không khai số tháng bảo hành mặc định (luật 38).

## Bước sau (khi có khách thử)

- Tạo phiếu tự động khi đơn giao thành công (đọc «Bảo hành (tháng)» của sản phẩm) — cần chốt với shop: phiếu sinh lúc giao hay
  lúc khách kích hoạt.
- Báo cáo chi phí bảo hành theo mã hàng / nhà cung cấp.
- Khách tự tra bảo hành bằng SĐT / serial trên trang công khai của shop.
