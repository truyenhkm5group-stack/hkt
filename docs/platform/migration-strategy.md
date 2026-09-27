# Nền tảng ERP — Chiến lược chuyển đổi

## 1. Nguyên tắc

1. **Chỉ THÊM.** Không `DROP`, không `RENAME`, không `ALTER` bảng nghiệp vụ nào. Migration Phase 1
   duy nhất (`0152_platform_control_plane`) tạo 4 bảng `platform_*` và chèn một dòng.
2. **Dữ liệu VNX không di chuyển.** CSDL hiện tại TRỞ THÀNH CSDL của tổ chức nhà (`is_home`). Không
   backfill, không cột mới trên 144 bảng, không khoá bảng lớn.
3. **Hành vi trước ≈ hành vi sau cho tổ chức nhà**: `module_default = ENABLED` ⇒ mọi module bật ⇒
   `can()` trả đúng như cũ, menu đúng như cũ, job đúng như cũ, khoá đệm đúng như cũ.
4. **Đảo ngược được** ở từng bước (mục 5).

## 2. Thứ tự (mỗi bước một PR, mỗi PR tự đứng được và xanh)

| Bước | Nội dung | Đổi hành vi production? | Đảo ngược |
| --- | --- | --- | --- |
| 1 | `docs/platform/*` | Không | xoá tài liệu |
| 2 | Migration `0152` + `lib/platform/{types,context,organizations}.ts` + `getDb()` định tuyến | Không — mọi request chưa có claim `org` ⇒ nhà | revert mã; bảng `platform_*` để lại vô hại |
| 3 | Sổ module + bộ phân giải + `can()` theo module + cổng đường dẫn | Không cho nhà (`ENABLED`) | revert |
| 4 | Claim `org` trong JWT + đăng nhập có mã tổ chức + gia hạn giữ claim | Token mới có `org: "vnx"`; token cũ vẫn hợp lệ (⇒ nhà) | revert: token có claim thừa vẫn đọc được bằng mã cũ (jose bỏ qua claim lạ) |
| 5 | Cô lập mức tiến trình: đệm, SSE, credential env, job `?org=` | Không cho nhà | revert |
| 6 | Giao diện: `/settings/modules`, `/platform`, menu theo module | Thêm 2 trang quản trị | revert |
| 7 | Cấp tổ chức demo (chỉ kiểm thử + máy cục bộ) + E2E | Không | — |

Bước 2–5 có thể gộp thành một PR tích hợp nếu nhỏ hơn ~40 tệp; ưu tiên tách.

## 3. Tương thích ngược — những chỗ dễ vỡ nhất và cách chặn

| Chỗ | Rủi ro | Chặn |
| --- | --- | --- |
| Gia hạn JWT ở middleware chỉ chép `email/name/role` | Mất claim `org` ⇒ người tổ chức B bị đẩy về A | Chép claim `org`; bài kiểm `platform-rbac` |
| Token cũ không có `org` | Bị coi là lạ ⇒ đăng xuất hàng loạt sau deploy | Không có claim ⇒ nhà (`LEGACY_SESSION`) |
| `memoKeys()` được bài kiểm so sánh | Đổi định dạng khoá làm đỏ bài kiểm giữ ấm | Khoá của nhà giữ nguyên |
| Bảng `platform_*` chưa tồn tại (migration chưa áp, script cũ) | `getDb()` ném khi đọc sổ tổ chức | Đọc sổ lỗi `42P01` ⇒ chỉ có tổ chức nhà (log một lần) |
| Scheduler là tiến trình riêng | Đệm năng lực trễ | TTL 5 giây |
| `ensureMigrated()` chỉ chạy một lần / tiến trình | CSDL tổ chức mới không có bảng | `ensureMigrated(org)` theo tổ chức, khi mở lần đầu |
| Hai tiến trình (app + scheduler) cùng mở CSDL tổ chức mới lần đầu | Hai lượt migrate đua nhau | `pg_advisory_lock` quanh migrate |

## 4. Kiểm trước khi đưa lên production

1. `npm run typecheck` · `npm run lint` · `npm test` (hai chế độ) · `npm run build` trên cây sạch.
2. Bài kiểm migration: `0152` áp trên CSDL trống VÀ trên CSDL đã có 151 migration (đường nâng cấp —
   `tests/migration-upgrade-path.test.ts`), áp lại lần hai không lỗi (idempotent).
3. Đếm dòng trước/sau trên production bằng ops `db-query` (chỉ đọc):
   ```sql
   select count(*) from platform_organizations;                 -- sau deploy: 1
   select code, is_home, module_default from platform_organizations; -- vnx | t | ENABLED
   select count(*) from platform_organization_modules;          -- 0
   ```
4. Smoke sau deploy: đăng nhập, `/`, `/orders`, `/shipments`, `/inventory`, `/ads`, `/production`,
   `/returns`, `/reports`, `/payroll` — cùng danh sách trang smoke hiện có.

## 5. Kế hoạch lùi

- Mã: revert PR ⇒ `getDb()` về singleton. Bảng `platform_*` ở lại, không ai đọc, vô hại.
- Dữ liệu: không có dữ liệu nghiệp vụ nào bị đổi nên không có gì để khôi phục.
- Phiên: token mang claim `org` vẫn đọc được bởi mã cũ (claim lạ bị bỏ qua).

## 6. HUMAN GATE — tổ chức thứ hai trên production

Tạo tổ chức thứ hai trên production nghĩa là `CREATE DATABASE` trên máy Postgres của VPS (cần quyền
`CREATEDB`, thêm tải cho VPS 2 nhân, thêm một mục sao lưu). Đó là thêm hạ tầng ⇒ hỏi chủ shop trước
(AGENTS.md §7). Phase 1 chứng minh kiến trúc bằng: (a) bài kiểm E2E hai tổ chức trên PGlite; (b) chạy
thử cục bộ (`scripts/platform-provision-org.ts` + `next start`). Lệnh cấp trên production được soạn
sẵn nhưng KHÔNG chạy.

## 7. Sao lưu

Sao lưu hiện tại (`pg_dump` CSDL `DATABASE_URL` + Google Drive) giữ nguyên và phủ tổ chức nhà + mặt
phẳng điều khiển. Mỗi tổ chức mới cần một mục sao lưu riêng — việc của bước cấp tổ chức trên
production (HUMAN GATE ở trên), ghi trong `risk-register.md` R-06.
