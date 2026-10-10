# Hồ sơ trải nghiệm theo ngành — sản phẩm / quy cách

Ảnh chụp cục bộ: tổ chức thử `hai-san-thu` (mẫu `wholesale`, dữ liệu mẫu), CÙNG mã nguồn với tổ chức nhà (thời trang).
**Chưa phải ảnh production** — sau deploy cần chụp lại trên HSLC (thực phẩm) và VNX (thời trang).

| Bước | Ảnh |
|---|---|
| TRƯỚC — tổ chức chưa chọn ngành: form vẫn Size / Màu (= giao diện cũ, giữ tương thích) | `product-new-before-1366.png` · `product-new-before-390.png` |
| Quản trị chọn «Thực phẩm / hải sản» ở Hệ thống → Module của tổ chức (không sửa mã) | `settings-before-1366.png` → `settings-picked-1366.png` |
| SAU — form: Quy cách · Khối lượng (g) · đơn vị «gói» · ví dụ «Chả cá thu / CCT500» | `product-new-after-1366.png` · `product-new-after-390.png` |
| SAU — tạo thật «Chả cá thu · CCT500 · 500g/gói · 280.000 ₫»: «1 quy cách», «Tồn kho theo quy cách», không ma trận Màu × Size | `product-detail-after-1366.png` |

CSDL sau lượt tạo (`erp_org_hai_san_thu.product_variants`): `size = ''`, `color = ''`, `detail = 'Quy cách: 500g/gói'`,
`attributes = {"spec":"500g/gói"}`, `weight = 500` — «500g» KHÔNG vào cột size.

Ghi chú: ảnh chụp trên cây có cả thay đổi điều hướng của PR «ERP-UX-A/B» (thanh menu mới) — phần thanh menu không thuộc PR này.
