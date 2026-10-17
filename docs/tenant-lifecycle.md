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
| Job, việc sau phản hồi, AI | `withOrganization()` ném; `runJob` trả `SKIPPED ORG_INACTIVE` |
| Webhook theo URL bí mật (Pancake, Viettel Post, GHN, GHTK, Zalo OA) | `resolveUrlSecretOrganization` ⇒ không tổ chức ⇒ **HTTP 401** — y hệt tổ chức SUSPENDED |
| Webhook Messenger (một URL cho mọi page) | `resolvePageOrganization` ⇒ không tổ chức ⇒ **HTTP 200**, tin bị bỏ qua (`UNKNOWN_PAGE`) |
| Bộ lập lịch fan-out | `fanOutOrganizationCodes()` |
| Bước kiểm deploy (migrate + đối chiếu sổ) | `scripts/verify-migrations.ts` dùng `fanOutOrganizationCodes()` — không có danh sách bỏ qua thứ hai |
| Mọi lối mở CSDL tổ chức bằng `getDbFor` (trang `/platform`, hỗ trợ, đo dùng AI, cấp lại) | `getDbFor()` ném `OrganizationArchivedError` — chỉ `openForReactivation()` vượt qua |
| Cờ `degradedMigration` của `/api/health` | chỉ tính tổ chức đang hoạt động |

**Rủi ro của 401:** nhà cung cấp gửi lại rồi có thể TỰ TẮT webhook sau nhiều lần 401 liên tiếp (tổ chức lưu trữ
càng lâu càng dễ chạm). Khi kích hoạt lại: kiểm trang Kết nối dữ liệu của tổ chức — webhook đã bị nhà cung cấp tắt
thì đăng ký lại; đừng coi "kích hoạt lại xong" là "kênh đã chạy lại".

Báo cáo nền tảng (trang AI dùng chung, A/B model) đọc tổ chức ARCHIVED qua handle CHỈ ĐỌC (`organizationDbForReport`) —
không migrate; câu đọc hỏng vì lược đồ tụt là lỗi thật của tổ chức đó, không phải số 0.

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

1. không phải nhà, không nằm trong **sổ bảo vệ** `lib/constants/org-archive-protection.ts` (`vnx`, `hslc-hmt`,
   `hslc-hmt-shop`, `hslc-vgcnj` + mọi mã `hslc-*` — từ chối THEO MÃ, kể cả khi sao lưu sạch và 0 đồng nợ), không phải
   workspace nghiệm thu SaaS (`cdt-nghiem-thu`);
2. đang `ACTIVE` hoặc `SUSPENDED` — `SETUP_FAILED` bị từ chối (kích hoạt lại sẽ trả về một workspace dựng dở);
3. không còn nghĩa vụ tiền: hoá đơn MỞ · phiếu nạp còn hạn · Số dư AI tiền mặt > 0 · kỳ thuê bao đã trả chưa hết ·
   khoản tiền về chưa ai xử lý (nối rộng như offboard: `org_code` hoặc hoá đơn / phiếu nạp của tổ chức). Thuê bao sản
   phẩm chưa kết thúc / thu phí còn bật chỉ được CẢNH BÁO ở lượt chạy thử — chiều thương mại do người vận hành tự quyết;
4. bản sao lưu CSDL của CHÍNH tổ chức: OK, có bản ngoài máy, ≤ 26 giờ;
5. diễn tập khôi phục CSDL của CHÍNH tổ chức (`last-drill.json`: `kind=restore-drill`, `scope=ORGANIZATION`, đúng tên
   CSDL — diễn tập trên VPS hay ngoài máy đều được, trường thêm như `site` chỉ để in, đã lọc): OK, ≤ 72 giờ. SKIPPED ⇒ từ chối.
   Mốc ở TƯƠNG LAI quá 5 phút (lệch đồng hồ, tệp sửa tay) ⇒ từ chối, không coi là "mới".

Vì sao không đòi "diễn tập mới hơn mọi lượt ghi": ERP không có mốc lượt-ghi-cuối đáng tin cho một CSDL, và lưu trữ
không xoá gì — CSDL sống nguyên chỗ và vẫn được sao lưu. Diễn tập chứng minh ĐƯỜNG sao lưu của CSDL này khôi phục được;
độ mới của dữ liệu do vế 4 gánh. Muốn chặt hơn: đình chỉ trước, rồi sao lưu + diễn tập, rồi lưu trữ.

Ghi: nhật ký `ORG_ARCHIVE` `archive:start` (chỉ số đếm) → một giao dịch khoá dòng tổ chức, đếm lại tiền, đặt `ARCHIVED`
→ xoá đệm, đóng handle → `archive:done` mang `before.status` = trạng thái cũ. Không tới được `done` (từ chối giữa chừng
hay lỗi) ⇒ luôn có `archive:stopped` kèm lớp lỗi. Không DROP, không xoá dòng, không gỡ webhook Meta (để kích hoạt lại không mất kênh). Tiến trình ứng dụng
thôi phục vụ trong ≤ 10 giây (đệm sổ tổ chức).

## 4. Kích hoạt lại

Tổ chức phải `ARCHIVED`. Lượt chạy mở CSDL qua `openForReactivation()` (đường migrate của ứng dụng), đối chiếu sổ bằng
CHÍNH `checkDb` + `verifyOrganizations` của bước kiểm deploy (có trần thời gian, huỷ câu migrate khi quá trần), và CHỈ
khi `OK` mới đổi trạng thái — về **ĐÚNG trạng thái trước khi lưu trữ**, đọc từ `archive:done` gần nhất: tổ chức bị công
tắc khẩn đình chỉ trước khi lưu trữ thì quay về `SUSPENDED`, không lặng lẽ được mở lại. Không đọc được trạng thái cũ ⇒
`SUSPENDED` (phía hẹp hơn) và lượt chạy nói ra. `MISSING` · `DEGRADED` · `TIMEOUT` · `ERROR` ⇒ vẫn `ARCHIVED`, mã thoát 67. Trong suốt lượt
migrate tổ chức vẫn ARCHIVED nên không phiên, webhook hay job nào chạm vào nó trước khi nó sẵn sàng.
