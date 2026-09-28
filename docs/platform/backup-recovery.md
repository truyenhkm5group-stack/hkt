# Sao lưu · khôi phục · xuất cấu hình tổ chức (Phase 11 · H3)

> Runbook sao lưu CSDL NHÀ đã có ở `docs/backup-restore.md` và KHÔNG đổi. Tài liệu này trả lời câu hỏi của nền tảng
> đa tổ chức: mỗi tổ chức không-nhà là một CSDL riêng (`erp_org_<mã>`), vậy cái gì đang được sao lưu, cái gì chưa,
> và khôi phục MỘT tổ chức làm thế nào. Đo bằng cách đọc mã nguồn tại commit của tài liệu này, không phải trên máy chủ.

## 1. Ba lớp, ba câu hỏi khác nhau

| Lớp | Trả lời câu hỏi | Công cụ | Chứa dữ liệu khách? |
|---|---|---|---|
| Bản sao CSDL (pg_dump) | "Mất máy chủ thì lấy lại MỌI THỨ" | `scripts/erp-backup.sh` (cron) | CÓ — đơn, bản ghi, người dùng, bí mật đã mã hoá |
| Blueprint cấu hình | "Dựng lại / nhân bản CẤU HÌNH của một tổ chức" | `/settings/export` → `/settings/templates` «Cài từ tệp JSON» | KHÔNG |
| Migration | "Lược đồ CSDL đang ở đâu" | `drizzle/` + `drizzle.__drizzle_migrations` | KHÔNG |

Blueprint KHÔNG thay bản sao CSDL: nó không mang bản ghi, giá trị field, người dùng, email hay bí mật kết nối. Mất CSDL
mà chỉ có blueprint thì dựng lại được cái khung (module, vai trò, đối tượng, field, form, danh sách, trang, luật), dữ
liệu thì không.

## 2. Sao lưu CSDL hiện có — đọc từ `scripts/erp-backup.sh`

- **Lịch:** `/etc/cron.d/erp-backup` do `install-vps.sh` cài ở MỖI lần deploy — cron phút 17 mỗi giờ, chỉ chạy trong
  khung 02:00–05:59 giờ Việt Nam, mỗi ngày đúng một bản (`daily-done`), lượt hỏng thử lại giờ sau.
- **Giữ:** 7 bản ngày · 4 bản Chủ nhật · 3 bản bấm tay (`GIU_BAN_NGAY` / `GIU_BAN_TUAN` / `GIU_BAN_TAY`).
- **Ngoài máy:** Google Drive qua remote `gcrypt:` (rclone crypt — Drive chỉ thấy byte mã hoá), cấu hình từ
  Secrets ở `/root/.config/erp-backup/offsite.env`.
- **Kiểm:** kích thước > 0, `pg_restore --list` đọc lại được, mục lục phải có dữ liệu `orders` + `shipments`; ops
  `restore-drill` nạp bản mới nhất vào container tạm rồi đếm 14 bảng then chốt.
- **PHẠM VI — đúng MỘT CSDL:** `docker exec erp-db pg_dump -U erp -d erp -Fc` (`erp-backup.sh`, lệnh `cmd_run`, bước 2),
  cộng volume dữ liệu bot chat. Mặt phẳng điều khiển (`platform_organizations`, `platform_organization_modules`, gói,
  mã mời) nằm trong CSDL nhà (`getPlatformDb()` = CSDL nhà) nên ĐƯỢC phủ.

### 2.1 KHOẢNG HỞ: CSDL của tổ chức khác nhà KHÔNG được sao lưu

Tổ chức không-nhà nằm ở CSDL `erp_org_<mã với - thành _>` trên cùng máy Postgres (`organizationDatabaseName`,
`db/index.ts`), hoặc ở máy khác nếu khai `ORG_DATABASE_URL__<MÃ>`. Script sao lưu cứng `-d erp`, và kiểm toàn vẹn cứng
bảng `orders` / `shipments` — một tổ chức dịch vụ không có đơn thì dù có dump cũng bị coi là hỏng. Hệ quả:

1. Mọi thứ của tổ chức khác — bản ghi tuỳ biến, tệp đính kèm (`custom_files.data`, bytea), người dùng, luật, trang,
   bí mật kết nối đã mã hoá — **không có bản sao nào**. Mất ổ đĩa là mất hẳn.
2. `restore-drill` không bao giờ thử một CSDL tổ chức.
3. Trang sức khoẻ sao lưu (`lib/queries/backup-status.ts`) đọc thư mục trạng thái CHUNG — tổ chức B thấy "sao lưu tốt"
   của VNX và tưởng mình được sao lưu (đã ghi ở `tenant-readiness-audit.md` ISO-20, `risk-register.md` R-06).

Hôm nay khoảng hở này CHƯA gây mất gì vì production chưa có tổ chức thứ hai (cấp tổ chức trên production là HUMAN GATE
— `migration-strategy.md` §6). Nó thành lỗ thật đúng vào ngày tổ chức đầu tiên được cấp.

### 2.2 Đề xuất (việc của chủ nền tảng — không đổi trong commit này)

Không cần secret mới, không đổi lịch cron — chỉ mở rộng thân lệnh `run` trong `erp-backup.sh`:

1. **Liệt kê CSDL tổ chức từ chính Postgres**, không từ cấu hình:
   `psql -U erp -d erp -Atc "select datname from pg_database where datname like 'erp\_org\_%' order by 1"`.
   Đối chiếu với `select code from platform_organizations where status <> 'ARCHIVED' and not is_home` — CSDL có mà tổ
   chức không có (hoặc ngược lại) phải in ra thành cảnh báo, không bỏ qua.
2. **Dump từng CSDL** cùng lệnh, cùng thư mục, cùng xoay vòng: `pg_dump -U erp -d erp_org_<mã> -Fc > erp_org_<mã>-<mốc>.dump`.
   Xoay vòng (`xoay_vong`) chỉ nhận tên khớp `^<tiền tố>-[0-9]{8}-[0-9]{4}\.` với tiền tố `erp` / `chatbot`, và
   `ban_moi_nhat` (ước lượng ổ đĩa, diễn tập) chỉ nhìn `erp-*.dump`. Tệp `erp_org_<mã>-…` KHÔNG khớp cả hai ⇒ không
   bao giờ bị xoay (ổ đầy dần — sự cố #242 lặp lại) và không vào phép ước lượng. Phải thêm từng tiền tố tổ chức vào
   vòng `xoay_vong_tat_ca` và đếm RIÊNG theo tiền tố; gộp chung thì bản của 5 tổ chức đẩy bản của nhà ra khỏi 7 bản giữ.
3. **Kiểm toàn vẹn theo loại CSDL:** CSDL nhà giữ luật `orders`/`shipments`; CSDL tổ chức kiểm `drizzle.__drizzle_migrations`
   + `users` có dữ liệu (tổ chức nào cũng có ít nhất một quản trị) — không ép bảng đơn.
4. **Trạng thái theo tổ chức:** `status/last-run.json` thêm mảng `organizations[]` (mã, tệp, byte, OK/FAILED);
   `backup-status.ts` chỉ cho tổ chức ngữ cảnh thấy dòng của CHÍNH nó.
5. **Diễn tập:** `restore-drill` luân phiên một CSDL tổ chức mỗi lượt (bảng then chốt: `users`, `meta_fields`,
   `meta_pages`, `custom_records`).
6. **Bài kiểm:** `tests/backup.test.ts` đã chạy shell thật với `docker`/`psql` giả — thêm ca "hai CSDL `erp_org_*` ⇒ hai
   tệp dump, xoay vòng riêng, một CSDL hỏng ⇒ PARTIAL chứ không OK".
7. Tổ chức đặt ở máy Postgres KHÁC (`ORG_DATABASE_URL__<MÃ>`) nằm ngoài container `erp-db` ⇒ ngoài tầm script này;
   cấp một tổ chức như thế phải kèm lịch sao lưu riêng — ghi vào checklist cấp tổ chức.

Đổi lịch, thêm nơi lưu, hay thêm tải cho VPS 2 nhân là quyết định của chủ nền tảng (AGENTS.md §7).

## 3. Khôi phục CẤU HÌNH bằng blueprint

**Xuất** (`/settings/export`, quyền `metadata:manage` + `settings:manage`): `exportOrgBlueprint()`
(`lib/blueprints/export.ts`) dựng NGƯỢC cấu hình hiện tại của tổ chức NGỮ CẢNH thành một blueprint Phase 7:

| Mang | Không mang |
|---|---|
| module đang bật (module cần thông tin kết nối của nhà ⇒ thành gợi ý `integrations`) | bản ghi, giá trị field, tệp đính kèm |
| vai trò tuỳ chỉnh đang bật (gỡ quyền luật 31 cấm) | người dùng, email, mật khẩu |
| đối tượng tuỳ biến ACTIVE, field tuỳ biến ACTIVE (trên đối tượng hệ thống và tuỳ biến) | bí mật kết nối, mọi khoá `settings` ngoài danh sách an toàn |
| override trạng thái hệ thống | id nội bộ (mọi mục đi bằng khoá tự nhiên) |
| form + danh sách + trang ĐÃ XUẤT BẢN (kèm menu) | nháp chưa xuất bản (nêu ở «không đi theo») |
| luật tự động (cài lại luôn ở NHÁP + CHẠY THỬ) | trạng thái bật / chạy thật của luật |
| cài đặt an toàn (`SAFE_SETTING_KEYS`), ngữ cảnh AI | giá trị mặc định / quyền riêng của field (nêu ở «thiếu một phần») |

Màn hình in hai danh sách — `omitted` (mục không đi theo, kèm lý do) và `lossy` (đi theo nhưng thiếu một phần) —
thay vì bỏ im lặng. Gói phải qua `validateBlueprint`; mục làm gói hỏng bị gỡ và nêu đúng câu lỗi.

Tải: `GET /api/metadata/blueprint-export` — kiểm quyền lần hai, phiên phải cùng tổ chức với ngữ cảnh (409 nếu lệch),
trả `attachment` + `nosniff` + `private, no-store`, một dòng nhật ký `BLUEPRINT_EXPORT` (không ghi nội dung).

**Khôi phục:** tổ chức mới → `/settings/templates` → «Cài từ tệp JSON» → máy kiểm tệp (`parseBlueprintFile`: trần
2 MB, JSON hợp lệ, `validateBlueprint`, khoá không trùng mẫu ngành) → xem trước (`planForOrg`, không ghi) → xác nhận →
`installBlueprint` (CÙNG bộ cài của mẫu và AI, so `planHash`). Sau đó: nhập lại người dùng, khai lại kết nối, bật lại
từng luật sau khi kiểm.

**Chứng minh vòng tròn** (`tests/org-export.test.ts`): A cài `service-business` + field tay + trang mẫu sửa tay + trang
tay + form sửa tay + luật tay + vai trò + module bật thêm + override trạng thái đơn + danh sách đơn sửa tay ⇒ xuất ⇒ B
trống cài từ tệp ⇒ xuất B ⇒ hai gói BẰNG NHAU sau khi bỏ phần đầu (`key`, `version`, `name`, `description`,
`industry` — `comparableBlueprint`, băm `stableHash`). Cài lại cùng tệp ⇒ 0 mục phải ghi.

Blueprint cũng là phép đo "nâng lõi không mất tuỳ biến" (Phase 12 · E2E #8): xuất trước và sau khi nâng bản build trên
cùng CSDL, so `contentHash`.

## 4. Khôi phục MIGRATION

- Migration CHỈ THÊM. Không sửa, không đánh số lại, không xoá migration đã áp (AGENTS.md §4). Số mới nhất đọc ở
  `drizzle/meta/_journal.json`, không chép vào tài liệu.
- **Lời khai cuối cùng** về việc gì đã chạy là bảng `drizzle.__drizzle_migrations` TRONG TỪNG CSDL — CSDL nhà và mỗi
  `erp_org_*` có sổ riêng. Bản dump `-Fc` mang cả lược đồ `drizzle`, nên khôi phục một CSDL là khôi phục luôn sổ ấy.
- CSDL nhà migrate lúc app khởi động (`ensureMigrated`); CSDL tổ chức migrate lúc được MỞ lần đầu trong tiến trình
  (`migrateOrganizationDb`, khoá tư vấn `780152001`, rồi xoá bản sao `platform_*`). Khôi phục một bản dump CŨ hơn mã đang
  chạy ⇒ lần mở kế tiếp tự áp phần migration còn thiếu — đúng đường nâng cấp mà `tests/migration-upgrade-path.test.ts`
  đã kiểm.
- KHÔNG khôi phục một bản dump MỚI hơn mã đang chạy (sổ có migration mà thư mục `drizzle/` không có): deploy mã tương
  ứng trước. Không bao giờ "sửa" sổ bằng tay cho khớp.

## 5. Quy trình khôi phục MỘT tổ chức từ bản sao

Chỉ áp dụng khi đã có bản dump của CSDL tổ chức (xem khoảng hở §2.1 — hôm nay chưa có). Ghi đè dữ liệu production ⇒ cần
chủ nền tảng đồng ý (AGENTS.md §7).

1. **Xác định tổ chức và CSDL:** mã tổ chức `<ma>` ⇒ CSDL `erp_org_<ma với - thành _>` (hoặc URL ở
   `ORG_DATABASE_URL__<MÃ>`). Ghi lại mốc bản sao định dùng.
2. **Tạm ngừng tổ chức** ở `/platform` (trạng thái `SUSPENDED`) để không phiên / job / webhook nào ghi vào trong lúc nạp;
   các tổ chức khác và nhà chạy bình thường — đó là lợi ích của SILO.
3. **Sao lưu hiện trạng** (dù hỏng) để có đường lui: `pg_dump -d erp_org_<ma> -Fc`.
4. **Nạp vào CSDL TẠM trước**, đối chiếu số dòng (`users`, `custom_records`, `meta_pages`, `drizzle.__drizzle_migrations`):
   ```bash
   docker exec -i erp-db createdb -U erp -O erp erp_org_<ma>_khoiphuc
   docker exec -i erp-db pg_restore -U erp -d erp_org_<ma>_khoiphuc --no-owner --no-privileges < erp_org_<ma>-<mốc>.dump
   ```
   `pg_restore` báo lỗi ⇒ DỪNG.
5. **Đổi chỗ:** ngắt kết nối vào CSDL cũ, đổi tên cũ ⇒ `..._hong_<mốc>`, tạm ⇒ tên thật (`ALTER DATABASE … RENAME TO …`).
   Không `dropdb` bản cũ cho tới khi xác nhận xong.
6. **Mở lại tổ chức** (`ACTIVE`). Lần mở đầu tiên tự migrate phần còn thiếu (§4) và xoá bản sao `platform_*`. Kiểm
   `/settings/export` của tổ chức: `contentHash` phải khớp bản xuất gần nhất trước sự cố nếu có lưu.
7. **Bí mật kết nối** trong bản dump được mã hoá AES-256-GCM với AAD theo tổ chức bằng `PLATFORM_SECRETS_KEY`: khôi phục
   sang máy khác cần CÙNG khoá, nếu không kết nối hiện "không giải mã được" và phải khai lại.
8. **Chỉ còn blueprint, không có dump:** tạo tổ chức mới cùng mã (hoặc mã mới) → cài tệp blueprint (§3) → nhập lại
   người dùng và dữ liệu. Đây là khôi phục CẤU HÌNH, không phải khôi phục dữ liệu, và phải được nói đúng như thế với
   khách.
