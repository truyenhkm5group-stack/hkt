# ERP-UX — Chi tiết đơn

CSDL demo cục bộ (1.126 đơn), ADMIN tổ chức nhà, `next dev`. **Chưa phải ảnh production.**
- `order-detail-*` — đơn đang chuyển hoàn (demo-o-5209); `order-new-*` — đơn mới chưa gửi (demo-o-6322). Khổ 1366 · 1440 · 390.
- TRƯỚC: không chỗ nào nói đơn đang chờ việc gì; ở 390px trang TRÀN NGANG (`scrollWidth` 654 > 390) vì bảng sản phẩm kéo giãn cột lưới.
- SAU: dải Khách · Tiền · Hàng đang ở đâu · Việc tiếp theo; 390px `scrollWidth` = 390 (bảng cuộn trong khung của nó).
