# ERP-UX-A/B — Điều hướng thông minh · ô lệnh · «Tạo mới» · bộ lọc chuẩn · Đơn hàng trên điện thoại

Ảnh chụp trên CSDL demo cục bộ (`npm run seed:demo`: 1.126 đơn), tài khoản ADMIN của tổ chức nhà, `next dev`.
Cùng trang, cùng khổ. **Chưa phải ảnh production** — sau khi deploy cần chụp lại trên production (DoD 10/10).

| Bề mặt | Trước | Sau |
|---|---|---|
| Đơn hàng 1366 | `orders-before-1366.png` | `orders-after-1366.png` |
| Đơn hàng 1440 | `orders-before-1440.png` | `orders-after-1440.png` |
| Đơn hàng 390 | `orders-before-390.png` | `orders-after-390.png` |
| Trang chủ 1366 / 1440 / 390 | `home-before-*.png` | `home-after-*.png` |
| Ô lệnh trống · «đơn hoàn» · «bảng lương» | — (chỉ tìm dữ liệu + tên trang) | `palette-empty-1366.png` · `palette-don-hoan-1366.png` · `palette-bang-luong-1366.png` |
| «Tất cả chức năng» | 9 viên thả xuống | `menu-all-1366.png` |
| «+ Tạo mới» | — | `create-1366.png` |
| Ngăn kéo «Bộ lọc khác» | — | `filters-drawer-1366.png` |

Đo (dev server, lượt nạp `load`): /orders 3,2–5,4 s cả trước lẫn sau (dao động của `next dev`, không phải của thay đổi);
`scrollWidth` = bề rộng khung ở cả ba khổ, trước và sau (không cuộn ngang trang). Không thêm truy vấn nào vào lượt nạp trang:
danh sách «Tạo mới» chỉ hỏi máy chủ khi người dùng MỞ menu.
