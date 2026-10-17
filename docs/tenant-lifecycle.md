# Vòng đời tổ chức (tenant) — ba chiều trạng thái, lưu trữ và kích hoạt lại

Quyết định của chủ shop 17/10/2026: workspace THỬ không dùng (`qa`, `test-shop`, `q-store`) được **LƯU TRỮ, không xoá**.
Tổ chức nhà, mọi tổ chức HSLC, `vnx` và workspace nghiệm thu SaaS (`cdt-nghiem-thu`) giữ ACTIVE. Tổ chức còn
nghĩa vụ tiền (vd `hs-thien-nga-test` còn hoá đơn MỞ) không lưu trữ được cho tới khi nghĩa vụ ấy được xử lý.

## 1. Ba chiều, không suy ra lẫn nhau

| Chiều | Ở đâu | Trả lời câu hỏi | Ai đổi |
|---|---|---|---|
| **VẬN HÀNH** | `platform_organizations.status` (`ACTIVE` · `SUSPENDED` · `ARCHIVED` · `SETUP_FAILED`) | Tổ chức có được đăng nhập, nhận webhook, chạy job / AI, được migrate không | công tắc đình chỉ (`/platform/org`), job dựng, ops `org-lifecycle` |
| **THƯƠNG MẠI** | `platform_subscriptions` · `platform_invoices` · sổ Số dư AI | Khách có đang trả tiền / còn nợ / shop còn nợ khách không | thu phí (`lib/billing/*`) |
| **TRIỂN KHAI** | `drizzle.__drizzle_migrations` của CSDL tổ chức · `DEGRADED_MIGRATION` trong tiến trình | CSDL đã áp đủ migration của mã đang chạy chưa | migrate lúc mở CSDL, bước kiểm deploy |

- Quá hạn thanh toán KHÔNG đổi trạng thái vận hành (AGENTS.md luật 73: chỉ chặn ghi). Lưu trữ KHÔNG đổi gói hay huỷ
  hoá đơn. Migration hỏng KHÔNG đổi trạng thái vận hành: một tổ chức ACTIVE migrate hỏng vẫn làm bước kiểm deploy ĐỎ.
- Vị ngữ duy nhất cho "được chạy không": `isOperationalOrganization()` (`lib/platform/organizations.ts`) — chỉ `ACTIVE`.
  Vị ngữ cho "được mở CSDL bằng đường của ứng dụng (= migrate) không": `mayOpenOrganizationDb()` — mọi trạng thái trừ `ARCHIVED`.

## 2. Tổ chức ARCHIVED đứng ngoài những gì

| Cửa | Chốt |
|---|---|
| Đăng nhập / phiên | `currentOrganization()` ⇒ `ORG_INACTIVE` |
| Job, webhook, việc sau phản hồi, AI | `withOrganization()` ném; `runJob` trả `SKIPPED ORG_INACTIVE`; `resolveUrlSecretOrganization` / `resolvePageOrganization` ⇒ không tổ chức (Messenger trả 200, bỏ qua tin) |
| Bộ lập lịch fan-out | `fanOutOrganizationCodes()` |
| Bước kiểm deploy (migrate + đối chiếu sổ) | `scripts/verify-migrations.ts` dùng `fanOutOrganizationCodes()` — không có danh sách bỏ qua thứ hai |
| Mọi lối mở CSDL tổ chức bằng `getDbFor` (trang `/platform`, hỗ trợ, đo dùng AI, cấp lại) | `getDbFor()` ném `OrganizationArchivedError` — chỉ `openForReactivation()` vượt qua |
| Cờ `degradedMigration` của `/api/health` | chỉ tính tổ chức đang hoạt động |

Vẫn chạy cho tổ chức ARCHIVED: **sao lưu** (đêm + mỗi giờ — `scripts/erp-backup.sh` dump mọi CSDL `erp_org_*`, và
cảnh báo khi một tổ chức ARCHIVED mất CSDL), đọc chỉ-đọc của ops (`getDbForInspection`, không migrate). Thẻ sao lưu của
nhà liệt kê tổ chức lưu trữ RIÊNG ("LƯU TRỮ (vẫn sao lưu)"), không gộp vào "HỎNG" của khách đang chạy.

Đã biết: xoay khoá bí mật (`scripts/rotate-platform-secrets.ts`) bỏ qua tổ chức không ACTIVE và vì thế giữ khoá CŨ cần
thiết; lưu trữ lâu dài mà muốn gỡ khoá cũ thì phải kích hoạt lại, xoay, rồi lưu trữ lại.

## 3. Lưu trữ (ops `org-lifecycle`, mặc định CHẠY THỬ)

```
arg rỗng                                  → chạy thử mọi tổ chức (ba chiều + phán quyết)
<mã>                                      → chạy thử một tổ chức
<mã> --archive --apply --confirm=<mã>     → lưu trữ
<mã> --reactivate --apply --confirm=<mã>  → kích hoạt lại (tuỳ chọn --timeout=<giây>, 10–900)
```

Điều kiện lưu trữ (lõi: `lib/platform/org-lifecycle.ts::archiveRefusals`):

1. không phải nhà, không phải workspace nghiệm thu SaaS;
2. không còn nghĩa vụ tiền: hoá đơn MỞ · phiếu nạp còn hạn · Số dư AI tiền mặt > 0 · kỳ thuê bao đã trả chưa hết ·
   khoản tiền về chưa ai xử lý;
3. bản sao lưu CSDL của CHÍNH tổ chức: OK, có bản ngoài máy, ≤ 26 giờ;
4. diễn tập khôi phục CSDL của CHÍNH tổ chức (`last-drill.json`: `kind=restore-drill`, `scope=ORGANIZATION`, đúng tên
   CSDL — diễn tập trên VPS hay ngoài máy đều được, trường thêm như `site` chỉ để in): OK, ≤ 72 giờ. SKIPPED ⇒ từ chối.

Vì sao không đòi "diễn tập mới hơn mọi lượt ghi": ERP không có mốc lượt-ghi-cuối đáng tin cho một CSDL, và lưu trữ
không xoá gì — CSDL sống nguyên chỗ và vẫn được sao lưu. Diễn tập chứng minh ĐƯỜNG sao lưu của CSDL này khôi phục được;
độ mới của dữ liệu do vế 3 gánh. Muốn chặt hơn: đình chỉ trước, rồi sao lưu + diễn tập, rồi lưu trữ.

Ghi: nhật ký `ORG_ARCHIVE` (chỉ số đếm) → một giao dịch khoá dòng tổ chức, đếm lại tiền, đặt `ARCHIVED` → xoá đệm,
đóng handle. Không DROP, không xoá dòng, không gỡ webhook Meta (để kích hoạt lại không mất kênh). Tiến trình ứng dụng
thôi phục vụ trong ≤ 10 giây (đệm sổ tổ chức).

## 4. Kích hoạt lại

Tổ chức phải `ARCHIVED`. Lượt chạy mở CSDL qua `openForReactivation()` (đường migrate của ứng dụng), đối chiếu sổ bằng
CHÍNH `checkDb` + `verifyOrganizations` của bước kiểm deploy (có trần thời gian, huỷ câu migrate khi quá trần), và CHỈ
khi `OK` mới đặt `ACTIVE`. `MISSING` · `DEGRADED` · `TIMEOUT` · `ERROR` ⇒ vẫn `ARCHIVED`, mã thoát 67. Trong suốt lượt
migrate tổ chức vẫn ARCHIVED nên không phiên, webhook hay job nào chạm vào nó trước khi nó sẵn sàng.
