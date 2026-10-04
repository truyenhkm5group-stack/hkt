# Dịch vụ tại nhà — mẫu ngành `home-service` + module `field_jobs`

Lộ trình chung: `docs/verticals/ROADMAP.md` (Phần B, dòng «Dịch vụ tại nhà»). Ngành bán một VIỆC chứ không bán hàng: không
kho, không vận chuyển.

## Nỗi đau (giả thuyết, cần khách thử xác nhận)

- Điều phối hẹn thợ bằng sổ tay / nhóm Zalo ⇒ một thợ bị hẹn hai nhà cùng giờ, khách chờ.
- Báo giá miệng, phát sinh tại nhà khách không ghi ⇒ cãi nhau lúc thu tiền.
- Không có ảnh trước / sau, không có chữ ký nghiệm thu ⇒ khách báo lại «làm chưa xong» không có gì đối chứng.
- Thu cọc / thu nốt nhiều đợt, không biết khách còn nợ bao nhiêu; bảo hành dịch vụ nhớ bằng trí nhớ.

## Module `field_jobs` (0200)

- **Phiếu** (`field_jobs`, mã `CV-YYMMDD-NN` theo ngày VN, cấp trong giao dịch sau khoá tư vấn): khách · địa chỉ · tên việc ·
  mô tả. Trạng thái: Đã báo giá → Khách đồng ý (cần ≥ 1 dòng báo giá) → Đã hẹn thợ → Đang làm → Đã nghiệm thu (cần TÊN
  khách ký, gõ lại từ biên bản) · Huỷ từ mọi bước chưa xong (bắt buộc lý do). Nghiệm thu / huỷ rồi không đổi nữa. Chuyển trạng
  thái có điều kiện trong câu UPDATE — hai người bấm cùng lúc chỉ một lượt thắng.
- **Hẹn thợ**: thợ là tài khoản đang hoạt động, giờ hẹn + thời lượng. Một thợ không bị hẹn CHỒNG GIỜ (kiểm trong giao dịch
  sau khoá tư vấn theo thợ); hẹn nối tiếp (hết 10:00 — bắt đầu 10:00) không tính trùng; dời hẹn không tự trùng với chính nó.
- **Báo giá** (`field_job_lines`): dòng chữ tự do · số lượng nguyên · đơn giá. Sửa được tới trước khi nghiệm thu (phát sinh
  tại nhà khách); tổng mới không được nhỏ hơn số đã thu.
- **Tiền** (`field_job_receipts`): thu theo đợt (cọc, đợt giữa, nghiệm thu) bằng tiền mặt / chuyển khoản / khác. Không thu khi
  chưa có báo giá, không thu vượt tổng. Huỷ phiếu thu bắt buộc lý do, không xoá dòng. Tổng / đã thu / còn phải thu TÍNH lúc
  đọc (`fieldJobMoney`) — chưa báo giá thì «còn phải thu» là `—`, không phải 0.
  Vì sao không dùng `order_payments`: bảng ấy chỉ nhận đơn tạo tay (`order_id LIKE 'erp-%'`) với dòng là mẫu mã sản phẩm; dịch
  vụ báo giá bằng chữ tự do. Hai sổ tiền KHÔNG cộng chéo — báo cáo doanh thu tổng hợp của ngành dịch vụ là việc sau.
- **Ảnh** (`field_job_photos`): trước / sau, thu nhỏ trên trình duyệt (cạnh dài 1600px), ≤ 2 MB mỗi ảnh, tối đa 24 ảnh mỗi
  phiếu, chỉ JPEG / PNG / WEBP; tải qua `/api/field-jobs/photos/<id>` (đòi phiên + `field_jobs:view`, `nosniff` + `sandbox`).
- **Bảo hành dịch vụ**: số tháng trên phiếu; hạn = ngày nghiệm thu (giờ VN) + N tháng, tính lúc đọc. Khách báo lại ⇒ «Mở
  lượt bảo hành» = phiếu MỚI trỏ về phiếu gốc, chưa có báo giá (trong hạn thì thường 0 đồng — người điều phối tự quyết).
- **Màn hình**: `/field-jobs` (lịch thợ hôm nay · Đang mở / Việc của tôi / Đã nghiệm thu / Tất cả · tra mã / việc / khách / SĐT
  · lập phiếu) và `/field-jobs/<id>` (thông tin + bước kế tiếp · tiền · báo giá · ảnh).
- **Quyền**: `field_jobs:view` / `field_jobs:write` (vai trò CS mặc định có cả hai). Module TẮT ở tổ chức nhà.

## Mẫu `home-service`

Module: lõi · công việc · khách · CSKH · tài chính · phiếu công việc. Vai trò «Điều phối» và «Kỹ thuật viên». Field khách: loại
nhà, lưu ý khi tới, gói dịch vụ (Gọi lẻ · Bảo trì định kỳ · Ngừng). Luật NHÁP: khách chuyển «Bảo trì định kỳ» ⇒ việc lên lịch.
Không khai bảng giá / số tháng bảo hành mặc định (luật 38). Loại hình «Dịch vụ tại nhà» ở /start.

## Chưa làm

- Chữ ký tay trên màn hình (ảnh chữ ký) — bản đầu ghi tên người ký như phiếu giao đơn tạo tay.
- Nhắc lịch cho khách / thợ qua Zalo, bảo trì định kỳ tự sinh phiếu — cần lịch chạy (chủ shop quyết).
- Vật tư xuất kho theo phiếu — khi khách thử có kho vật tư.
