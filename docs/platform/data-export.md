# Xuất dữ liệu của tổ chức (`/settings/data-export`)

«Dữ liệu là của khách thuê» chỉ đúng khi khách tự lấy nó ra được, lúc nào cũng được. Trang này cho quản trị tổ chức tải
toàn bộ dữ liệu của chính tổ chức ra CSV (mở bằng Excel / Google Sheets).

## Luật

- **Quyền:** `settings:manage` (quản trị tổ chức). Tệp mang tên, số điện thoại, địa chỉ khách hàng. Không thêm khoá quyền
  mới — khoá mới không tự tới vai trò đã lưu trên production.
- **Theo module:** mỗi loại khai module sở hữu (`lib/constants/data-export.ts`). Module tắt ⇒ loại ấy không hiện và route
  trả 403.
- **Gói quá hạn vẫn xuất được:** chế độ chỉ xem chặn lượt GHI, không chặn lượt đọc.
- **Không bộ cột thứ hai:** đơn hàng và sản phẩm dùng lại route xuất SẴN CÓ của trang danh sách (đơn hàng với
  `period=all`). Route chung `/api/export/data/<loại>` lo khách hàng, phiếu thu / hoàn tiền, lịch hẹn, liệu trình.
- **Nhật ký:** mỗi lượt tải ghi `DATA_EXPORT` (ai, loại nào, bao nhiêu dòng). Hành động này nằm trong danh sách «không đổi
  số liệu» của `lib/audit.ts` — tải tệp không xoá đệm báo cáo.
- **Tệp:** UTF-8 có BOM (Excel trên Windows mới đọc đúng tiếng Việt); ô chưa biết để TRỐNG, không in 0 (luật 42); tiền là
  số nguyên VND; giờ Việt Nam. Trần 100.000 dòng mỗi tệp — vượt thì dòng cuối nói rõ đã cắt.
- **Phiếu huỷ vẫn có mặt** kèm lý do: tệp là sổ, không phải báo cáo đã lọc.

## Tệp

- Sổ khai + CSV thuần: `lib/constants/data-export.ts`
- Đọc dữ liệu: `lib/exports/tenant-data.ts`
- Route: `app/api/export/data/[kind]/route.ts` · Trang: `app/(dashboard)/settings/data-export/page.tsx`
- Kiểm thử: `tests/data-export.test.ts`
