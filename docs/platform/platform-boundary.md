# Nền tảng ERP — Ranh giới: cái gì là Lõi, cái gì là Module, cái gì là của VNX

> Phân loại theo mã thật (module-inventory mục 2, vnx-specific-rules). Tám nhãn:
> `CORE` · `GENERIC_MODULE` · `INDUSTRY_PACK` · `TENANT_SPECIFIC` · `CONNECTOR` · `SHARED_INFRA` · `LEGACY` · `UNKNOWN`.

## 1. Lõi nền tảng (CORE / SHARED_INFRA) — mọi tổ chức có, không tắt được

| Năng lực | Mã | Nhãn | Ghi chú |
| --- | --- | --- | --- |
| Tổ chức & ngữ cảnh | `lib/platform/*`, `platform_*` | CORE (mới) | |
| Định tuyến CSDL | `db/index.ts` | SHARED_INFRA | |
| Xác thực, phiên | `lib/auth/session.ts`, `middleware.ts` | CORE | |
| RBAC (vai trò · chức danh · phạm vi) | `lib/auth/{permissions,access,scope-guard}.ts` | CORE | luật 28–33 giữ nguyên |
| Sổ module / năng lực / cờ | `lib/constants/platform-modules.ts`, `lib/platform/capabilities.ts` | CORE (mới) | |
| Nhật ký | `lib/audit.ts`, `platform_audit_log` | CORE | |
| Cấu hình | `lib/settings.ts` | CORE | theo tổ chức nhờ silo |
| Công việc & mục tiêu | `/work`, `lib/work/*`, OKR/BSC | CORE (module `work`, `core: true`) | phép chiếu — nguồn việc của module tắt tự rỗng |
| Thông báo, realtime | `notifications`, `lib/realtime/*` | SHARED_INFRA | cần khoá tổ chức (ISO-08) |
| Đệm | `lib/cache.ts` | SHARED_INFRA | cần khoá tổ chức (ISO-01) |
| Job runner | `lib/sync/runner.ts` | SHARED_INFRA | cần khoá tổ chức (ISO-12) |
| Đo hiệu năng | `lib/perf/*`, `/api/perf` | SHARED_INFRA — của NỀN TẢNG | chỉ tổ chức nhà xem (ISO-25) |
| Sơ đồ tổ chức | `/departments`, `departments` | CORE | danh mục phòng ban gieo sẵn là chung |
| Tầng tổng hợp của chủ | `/`, `/cockpit`, `/data-quality` | CORE | nội dung đọc nhiều module; lọc theo module bật là Phase 1.x |

## 2. Module nghiệp vụ chung (GENERIC_MODULE) — bật/tắt theo tổ chức

`customers` · `products` · `orders` · `inventory` · `purchasing` · `finance` · `payroll` · `alerts` ·
`customer_care` · `sales_channels` · `logistics` · `returns` · `marketing` · `production`.

Chung ở mức KHÁI NIỆM; nhiều cái mang luật ngành bên trong (xem mục 3). `orders`, `customers`,
`products`, `inventory`, `purchasing`, `finance` là tập dùng được cho doanh nghiệp bán buôn ngay
Phase 1 với dữ liệu nhập tay (mẫu `wholesale`).

## 3. Gói ngành (INDUSTRY_PACK) — "Thời trang bán online COD Việt Nam"

Hiện NẰM LẪN trong module chung. Phase 1 chỉ kiểm kê, không tách:

- Kết quả đơn theo chứng từ ĐVVC + ngưỡng COD (`ORDER_OUTCOME`, `RETURN_RULE`) — luật của đơn COD.
- Sổ kho trừ theo mốc bàn giao ĐVVC (`SHIPMENT_LEFT_WAREHOUSE`).
- Vòng đời mẫu, topic sản xuất, xưởng, size/màu (`production`, `models`).
- Landing page 499K + 25K ship, quy kết marketer theo fanpage, ROAS theo marketer.
- Chăm sóc vận đơn (care), hàng hoàn, kiểm hàng hoàn.

Chiến lược tách (Phase 2+): luật đi sau một giao diện theo module/feature (`orders.outcome_rule`,
`inventory.shipped_basis`), gói ngành cung cấp bản cài đặt, tổ chức chọn gói qua `template_key`.

## 4. Riêng của VNX (TENANT_SPECIFIC)

Ngưỡng và hằng số đã chốt với chủ shop (50K/100K, tỷ lệ hoàn giả định 45%, cước 17K, tên shop
"Hải An Fashion" trong mẫu tin, BM Facebook mặc định `336423739082347`, múi `+07:00` cứng 36 chỗ,
mẫu mã sản phẩm `[A-Z]{1,2}\d{3}`, quy tắc lương/hoa hồng…). Đích đến: `settings` của tổ chức (đã có
chỗ) — tổ chức nhà giữ giá trị hiện tại làm mặc định của CHÍNH nó. 29 mục TENANT_SPECIFIC, xem
`vnx-specific-rules.md`.

## 5. Connector (CONNECTOR)

| Connector | Module | Credential Phase 1 |
| --- | --- | --- |
| Pancake POS + Pages (+ bot chat) | `connector_pancake` | `process.env` ⇒ chỉ tổ chức nhà |
| Viettel Post | `connector_viettelpost` | như trên |
| Meta Ads | `connector_meta` | như trên |
| Ngân hàng / SePay | `connector_bank` | như trên |
| Lark / Telegram | `connector_messaging` | như trên (fallback env chỉ cho nhà) |
| Trang Kết nối dữ liệu | `integrations` | in secret của tổ chức nhà ⇒ chỉ nhà |
| GitHub (Phòng Tech) | `tech` | credential của NỀN TẢNG — chỉ nhà |
| Nhà cung cấp AI | (tầng credential) | QUYẾT ĐỊNH CHỜ CHỦ: khoá AI là của nền tảng hay của khách |

## 6. LEGACY / UNKNOWN

- `lib/integrations/bank/ledger.ts` (chỉ cho script `import-bank-ledger`, UI đã gỡ) — LEGACY.
- Khoá quyền `reports:view` chỉ còn trong `LEGACY_IMPLIES` — LEGACY.
- 8 bảng `tech_*` quản trị chính kho mã ERP (không phải dữ liệu khách) nhưng đang nằm trong CSDL
  nhà với FK tới `users` — thuộc NỀN TẢNG về bản chất, Phase 1 để nguyên (module `tech` chỉ nhà).
