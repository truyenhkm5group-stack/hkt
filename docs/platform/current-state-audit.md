# Nền tảng ERP — Hiện trạng (Phase 0)

> Đo trên `origin/main` `41002d1e`, 27/09/2026. Tài liệu này là bản TỔNG HỢP; chi tiết có tệp:dòng
> nằm ở năm bản kiểm kê do các agent audit viết (chỉ đọc mã):
>
> | Tệp | Trả lời câu hỏi |
> | --- | --- |
> | `module-inventory.md` | Có những module nào, route/API/bảng/quyền/menu nào thuộc module nào, phụ thuộc chéo |
> | `data-ownership.md` | 144 bảng thuộc ai, loại gì, UNIQUE nào, FK nào |
> | `vnx-specific-rules.md` | 125 chỗ mã mang giả định riêng của VNX / ngành thời trang COD |
> | `integration-inventory.md` | Connector, biến môi trường, job, webhook, tuyến máy-gọi-máy |
> | `tenant-readiness-audit.md` | 30 phát hiện cô lập (ISO-01…30), mẫu cho máy quét tĩnh |

## 1. Hệ thống là gì

Một ERP nội bộ cho MỘT shop thời trang bán online (Pancake POS → Viettel Post COD → Facebook Ads).
Next.js 15.5 App Router (Server Components + Server Actions), Drizzle ORM, PostgreSQL 16 trên một VPS
2 nhân (PGlite cho kiểm thử), một tiến trình app + một container scheduler gọi HTTP.

| Chỉ số | Số |
| --- | --- |
| Trang (`page.tsx`) | 97 |
| Route API | 27 |
| `lib/queries/*` · `lib/actions/*` · `lib/constants/*` | 197 · 81 · 216 |
| Bảng · enum · `check` | 144 · 7 · 289 |
| Bảng có FK tới `users` | 81 |
| Khoá quyền | 66 |
| Mục menu | 44 |
| Job đồng bộ | 45 |
| Migration đã áp | 151 |
| Đoạn SQL thô / tệp chứa | 1.879 / 253 |
| Tệp gọi `getDb()` | 388 |

## 2. Có sẵn gì để tái dùng (AUDIT → REUSE)

| Năng lực | Có sẵn ở | Đánh giá |
| --- | --- | --- |
| Cửa CSDL duy nhất | `db/index.ts::getDb()` (async, 388 tệp gọi) | **Điểm cắm lý tưởng** cho silo — KEEP + EXTEND |
| Phiên | JWT HS256 trong cookie, gia hạn trượt ở middleware, thu hồi theo `lgn` | KEEP + thêm claim `org` |
| RBAC | Vai trò hệ thống + vai trò tuỳ chỉnh + phạm vi dữ liệu + chức danh (luật 28–33), `can()`, `requirePermission()` | KEEP nguyên — trong silo nó tự đa tổ chức |
| Sổ menu | `lib/constants/department-modules.ts::NAV_MODULES` (44 mục, có quyền) | EXTEND: lọc thêm theo module |
| Cấu hình động | bảng `settings` + `getSettingJson` | KEEP — nằm trong CSDL tổ chức nên tự cô lập |
| Nhật ký | `audit()` → `audit_logs` (có `actor_kind`) | KEEP; thêm `platform_audit_log` cho cấp nền tảng |
| Sổ job | `lib/sync/jobs.ts` + `runner.ts` + `sync_runs` | EXTEND: `?org=`, khoá theo tổ chức |
| Công việc / sự kiện | `/work` (phép chiếu), `domain_events` | KEEP — CORE |
| Tệp đính kèm | TRONG CSDL (bytea/base64) | Silo cô lập miễn phí |

**Không có**: khái niệm tổ chức/tenant/workspace (0 kết quả trong 144 bảng), sổ module, cờ tính
năng theo tổ chức. `department-modules.ts` là sổ MENU theo phòng ban, không phải sổ module sản phẩm
— giữ nguyên và nối thêm, không thay (mục 65 của yêu cầu).

## 3. Ba phát hiện định hình kiến trúc

1. **SQL thô ở khắp nơi** (1.879 đoạn / 253 tệp) ⇒ cô lập bằng cột `organization_id` không khả thi
   an toàn ⇒ SILO (target-architecture mục 2). Bằng chứng phụ: 48 migration tham chiếu cứng
   `"public"."<bảng>"` (ISO-30) ⇒ schema-per-tenant cũng bị chặn; CSDL riêng thì không.
2. **Quyền không ánh xạ một-một sang module** (`/ads` gác bằng `expenses:view`, `planning:view` gác
   cả `/production` lẫn `/inventory/*`, `/my-payslip` không gác khoá nào) ⇒ cổng module phải đi theo
   ĐƯỜNG DẪN, quyền chỉ là lớp thứ hai (target-architecture P9).
3. **Rò rỉ nằm ở mức TIẾN TRÌNH, không ở SQL**: đệm `memo` không khoá tổ chức (kể cả mẫu quyền —
   leo thang quyền chéo tổ chức), credential trong `process.env` + client singleton, fallback Lark
   từ env, một bot chat, webhook dùng chung bí mật, bus SSE phát cho mọi phiên, `runningJobs` toàn
   cục (tenant-readiness-audit ISO-01…17).

## 4. Luật nghiệp vụ và nền tảng

Luật "không thương lượng" trong `AGENTS.md` (ORDER_OUTCOME, COD thực thu, sổ kho, phân bổ chi phí…)
là luật của **VNX / gói ngành thời trang-COD**, không phải của lõi. Phase 1 KHÔNG di dời chúng
(contract test vẫn chặn deploy như cũ). Hệ quả đã biết khi tổ chức thứ hai chạy cùng mã: đơn công nợ
0đ COD bị `ORDER_OUTCOME` xếp "hoàn", sổ kho chỉ trừ theo sự kiện Viettel Post, cảnh báo
`VTP_ORDER_LIST_DUE` bật mặc định (vnx-specific-rules mục 5). Tổ chức demo Phase 1 chỉ bật module mà
những luật đó không phá (không Viettel Post, không COD); tách gói ngành là Phase 2+.

## 5. CI / triển khai

`gates.yml` chạy typecheck · lint · `npm test` hai chế độ · build trên mọi PR; `main` có ruleset
(PR bắt buộc, gates bắt buộc). Deploy là `workflow_dispatch` tay (`deploy-vps.yml`), migration tự áp
khi app khởi động. Ops (`ops-vps.yml`) và sao lưu cứng một CSDL `erp` (ISO-20) — đúng cho Phase 1 vì
production chỉ có tổ chức nhà.
