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
  `restore-drill` nạp bản mới nhất vào container tạm rồi đếm 14 bảng then chốt. CSDL tổ chức: ops `restore-drill-org`
  (CHẠY TAY, §7).
- **PHẠM VI:** CSDL nhà `docker exec erp-db pg_dump -U erp -d erp -Fc` (`cmd_run`, bước 2) + volume bot chat, rồi
  (từ Phase 11 · P11-BACKUP, bước 9) **mọi CSDL `erp_org_*` trên `erp-db`** — xem §2.1 và `docs/backup-restore.md`
  mục 7. Mặt phẳng điều khiển (`platform_organizations`, `platform_organization_modules`, gói, mã mời) nằm trong CSDL
  nhà (`getPlatformDb()` = CSDL nhà) nên ĐƯỢC phủ.

### 2.1 KHOẢNG HỞ (ĐÃ VÁ ở P11-BACKUP, trừ các điểm nêu ở §2.2): CSDL của tổ chức khác nhà KHÔNG được sao lưu

> Phần dưới mô tả hiện trạng TRƯỚC bản vá, giữ lại để đọc lý do. Trạng thái sau bản vá: §2.2.

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

### 2.2 Bản vá P11-BACKUP — đã làm gì, còn gì

Không secret mới, không đổi lịch cron, không đổi một byte đường sao lưu của nhà. Toàn bộ phần tổ chức nằm giữa các
cặp dấu `# >>> TỔ CHỨC KHÁC NHÀ` / `# <<< TỔ CHỨC KHÁC NHÀ` trong `scripts/erp-backup.sh`; `tests/backup.test.ts`
gỡ các khối đó ra và băm phần còn lại (`BAM_PHAN_NHA` = đúng bản trước Phase 11), rồi chạy `cmd_run` thật với
`docker`/`psql`/`rclone` giả, so trạng thái + tệp + bản ngoài máy của nhà giữa lượt không có và có tổ chức.

| Đề xuất (bản H3, giữ nguyên bên dưới) | Đã làm |
|---|---|
| 1 · liệt kê từ Postgres, đối chiếu sổ | ✓ `pg_database` + mẫu `^erp_org_[a-z0-9_]+$` (tên lạ bị bỏ, nói ra); tổ chức `ACTIVE`/`SUSPENDED` trong sổ mà không có CSDL ⇒ `::warning::` + `missingDatabases` (không làm lượt thất bại). CSDL có mà sổ không có vẫn được SAO LƯU (sao lưu thừa rẻ hơn mất) |
| 2 · dump + xoay vòng riêng | ✓ thư mục RIÊNG `/root/backups/orgs/<csdl>/{daily,weekly,manual}/`, tệp `<csdl>-<mốc>.dump`, xoay vòng theo tiền tố của CHÍNH CSDL, cùng `GIU_BAN_*`; ngoài máy `gcrypt:orgs/<csdl>/…` |
| 3 · kiểm toàn vẹn theo loại | ✓ tổ chức: dữ liệu `public.users` + `public.settings` + `drizzle.__drizzle_migrations` trong mục lục; không đòi orders |
| 4 · trạng thái theo tổ chức | ✓ khác đề xuất ở chỗ: KHÔNG thêm mảng vào `last-run.json` của nhà (đổi tệp của nhà); mỗi CSDL một thư mục `status/orgs/<csdl>/` + tệp tổng hợp `status/orgs-last-run.json`. Tổ chức chỉ đọc thư mục của chính nó; chưa có ⇒ "Chưa có bản sao lưu nào cho CSDL của tổ chức này" (đỏ) |
| 5 · diễn tập luân phiên | ✓ CHẠY TAY (Commercial readiness C) — ops `restore-drill-org` (`erp-backup.sh restore-drill-org [mã]`; không mã ⇒ luân phiên theo lượt diễn tập cũ nhất). Ghi `status/orgs/<csdl>/last-drill.json` nên thẻ của ĐÚNG tổ chức đó hết vàng. **Chưa nằm trong cron** — bật tự động là quyết định của chủ nền tảng (`launch-gates.md` mục C). §7 |
| 6 · bài kiểm | ✓ (xem trên) |
| 7 · CSDL ở máy khác | ✓ nêu ra ở hai phía: script (`missingDatabases`) và thẻ của tổ chức (`ORG_DATABASE_URL__…` ⇒ đỏ "không được sao lưu tự động"). Lịch sao lưu riêng cho chúng vẫn là việc của chủ nền tảng |

Hai giới hạn còn lại, cố ý:

- Tổ chức chạy SAU nhà trong cùng lượt. Nhà thất bại (ổ đầy, `pg_dump erp` lỗi, hết giờ chờ khoá) thì lượt dừng như
  trước và tổ chức **không được sao lưu đêm đó** — đổi điều này là đổi đường của nhà.
- `daily-done` của cron vẫn ghi theo kết quả của NHÀ: tổ chức hỏng lúc 02 giờ KHÔNG được thử lại lúc 03–05 giờ; lượt
  sau là đêm kế tiếp (hoặc ops `backup` bấm tay). Ops `backup` đỏ (thoát 1) khi có tổ chức hỏng.

**Đề xuất gốc của H3 (trước bản vá):**

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

Bản dump của CSDL tổ chức nằm ở `/root/backups/orgs/<csdl>/{daily,weekly,manual}/<csdl>-YYYYmmdd-HHMM.dump` và trên
Drive ở `gcrypt:orgs/<csdl>/…` (từ P11-BACKUP, §2.2). Lệnh copy-dán đầy đủ: `docs/backup-restore.md` mục 7. Ghi đè dữ
liệu production ⇒ cần chủ nền tảng đồng ý (AGENTS.md §7).

**Tên CSDL tạm KHÔNG được bắt đầu bằng `erp_org_`**: lượt sao lưu đêm liệt kê mọi `erp_org_%` và sẽ dump nó như một
tổ chức thật (và kiểm toàn vẹn nó). Dùng `tam_khoiphuc_<mã>` cho bản tạm và `hong_<mã>_<mốc>` cho bản cũ đổi tên.

1. **Xác định tổ chức và CSDL:** mã tổ chức `<ma>` ⇒ CSDL `erp_org_<ma với - thành _>` (hoặc URL ở
   `ORG_DATABASE_URL__<MÃ>`). Ghi lại mốc bản sao định dùng.
2. **Tạm ngừng tổ chức** ở `/platform` (trạng thái `SUSPENDED`) để không phiên / job / webhook nào ghi vào trong lúc nạp;
   các tổ chức khác và nhà chạy bình thường — đó là lợi ích của SILO.
3. **Sao lưu hiện trạng** (dù hỏng) để có đường lui: ops `backup` (nó dump cả CSDL tổ chức vào `orgs/<csdl>/manual/`).
4. **Nạp vào CSDL TẠM trước**, đối chiếu số dòng (`users`, `custom_records`, `meta_pages`, `drizzle.__drizzle_migrations`):
   ```bash
   docker exec -i erp-db createdb -U erp -O erp tam_khoiphuc_<ma>
   docker exec -i erp-db pg_restore -U erp -d tam_khoiphuc_<ma> --no-owner --no-privileges < /root/backups/orgs/erp_org_<ma>/daily/erp_org_<ma>-<mốc>.dump
   ```
   `pg_restore` báo lỗi ⇒ DỪNG.
5. **Đổi chỗ:** ngắt kết nối vào CSDL cũ, đổi tên cũ ⇒ `hong_<ma>_<mốc>`, tạm ⇒ tên thật (`ALTER DATABASE … RENAME TO …`).
   Không `dropdb` bản cũ cho tới khi xác nhận xong.
6. **Mở lại tổ chức** (`ACTIVE`). Lần mở đầu tiên tự migrate phần còn thiếu (§4) và xoá bản sao `platform_*`. Kiểm
   `/settings/export` của tổ chức: `contentHash` phải khớp bản xuất gần nhất trước sự cố nếu có lưu.
7. **Bí mật kết nối** trong bản dump được mã hoá AES-256-GCM với AAD theo tổ chức bằng `PLATFORM_SECRETS_KEY`: khôi phục
   sang máy khác cần CÙNG khoá, nếu không kết nối hiện "không giải mã được" và phải khai lại. Khoá này nằm ở
   `/root/erp/.env` — tệp **không** thuộc phạm vi `erp-backup.sh` và không đi qua GitHub Secrets (đo 28/09/2026:
   không workflow / script nào nhắc tới nó) ⇒ mất VPS là mất khoá, trừ khi đã cất bản sao ở ngoài (`launch-gates.md` C).
8. **Chỉ còn blueprint, không có dump:** tạo tổ chức mới cùng mã (hoặc mã mới) → cài tệp blueprint (§3) → nhập lại
   người dùng và dữ liệu. Đây là khôi phục CẤU HÌNH, không phải khôi phục dữ liệu, và phải được nói đúng như thế với
   khách.

## 6. Phạm vi đã xác minh (Commercial readiness C · 28/09/2026)

Câu hỏi: cấu hình / metadata của một tổ chức có nằm TRONG CSDL `erp_org_<mã>` — tức có đi theo bản dump đêm — hay
nằm lẫn ở CSDL nhà? Trả lời bằng ba nguồn độc lập, không đoán:

**(a) Đọc mã.** `getDb()` (`db/index.ts`) phân giải theo ngữ cảnh tổ chức → `getOrgDb(code)` → CSDL
`erp_org_<mã>`. Chỉ `getPlatformDb()` trỏ CSDL nhà, và chỉ các tệp sau gọi nó: `lib/platform/{provision,organizations,
capabilities,module-config,audit}.ts`, `lib/onboarding/{service,invites,rate}.ts`, `lib/entitlements/check.ts` (đọc
`platform_plans`; số đếm hạn mức của tổ chức vẫn đi `getDb()`), `app/api/health/route.ts` — tất cả chỉ chạm bảng
`platform_*` (+ `users` khi cấp tổ chức, ghi qua `getDbFor(org)` vào CSDL CỦA tổ chức). CSDL tổ chức chạy CÙNG bộ
migration (`migrateOrganizationDb`) nên có đủ lược đồ, rồi XOÁ sạch 8 bảng `platform_*` mỗi lần mở. Lệnh dump
`pg_dump -U erp -d "$csdl" -Fc` không lọc bảng / lược đồ ⇒ mọi thứ trong CSDL tổ chức, kể cả `drizzle`, vào bản dump.

**(b) Đo chạy thật** (`scripts/restore-drill-org-config.ts`, PGlite, tổ chức thử sau khi cài mẫu + tuỳ biến): bảng
cấu hình có dòng TRONG CSDL tổ chức — `meta_objects 2 · meta_custom_fields 13 · meta_forms 2 · meta_list_views 2 ·
meta_pages 2 · meta_status_overrides 1 · meta_config_versions 7 · custom_records 1 · custom_values 1 · workflow_rules 2
· blueprint_installs 1 · blueprint_items 26 · access_roles 1 · settings 3 · users 1`; **0** dòng thêm ở cùng các bảng
đó trong CSDL nhà; **0** dòng `platform_*` trong CSDL tổ chức; **+7** dòng sổ tổ chức + module ở CSDL nhà; 185 / 185
bảng `public` ở hai CSDL (một lược đồ).

**(c) Khoá bằng bài kiểm** (`tests/restore-drill-config.test.ts`): `CONTROL_PLANE_TABLES` = ĐÚNG các bảng `platform_*`
của `db/schema.ts` = ĐÚNG các bảng `migrateOrganizationDb` xoá; mọi bảng trong `ORG_CONFIG_TABLES` có trong lược đồ;
kịch bản chạy thật trong `npm test` và phán quyết đỏ nếu một bảng cấu hình ghi sang CSDL nhà.

| Nhóm | Bảng | Nằm ở | Đi theo bản dump nào |
|---|---|---|---|
| Metadata | `meta_objects` · `meta_custom_fields` · `meta_forms` · `meta_list_views` · `meta_pages` · `meta_status_overrides` · `meta_config_versions` | `erp_org_<mã>` | dump tổ chức |
| Bản ghi tuỳ biến | `custom_records` · `custom_values` · `custom_files` (bytea — tệp đính kèm) | `erp_org_<mã>` | dump tổ chức |
| Tự động hoá | `workflow_rules` · `workflow_runs` · `workflow_cursors` | `erp_org_<mã>` | dump tổ chức |
| Blueprint / AI | `blueprint_installs` · `blueprint_items` · `ai_blueprint_drafts` | `erp_org_<mã>` | dump tổ chức |
| Kết nối | `org_connections` (bí mật mã hoá bằng `PLATFORM_SECRETS_KEY`, khoá KHÔNG ở trong dump — §5 bước 7) | `erp_org_<mã>` | dump tổ chức |
| Người & quyền | `users` · `access_roles` · `departments` · `department_members` · `positions` | `erp_org_<mã>` | dump tổ chức |
| Cài đặt | `settings` | `erp_org_<mã>` | dump tổ chức |
| Nghiệp vụ + nhật ký | mọi bảng còn lại của `db/schema.ts` (đơn, khách, sản phẩm, `audit_logs`, `notifications`, …) — cùng lược đồ, dùng hay không tuỳ module | `erp_org_<mã>` | dump tổ chức |
| Sổ migration | `drizzle.__drizzle_migrations` | từng CSDL | dump của chính CSDL đó |
| **Mặt phẳng điều khiển** | `platform_organizations` · `platform_organization_modules` · `platform_flag_overrides` · `platform_audit_log` · `platform_plans` · `platform_signup_invites` · `platform_signup_attempts` · `platform_settings` | `erp` (nhà); RỖNG trong mọi `erp_org_*` | dump **nhà** (`pg_dump -d erp`) |

Hệ quả vận hành: module đang bật, trạng thái (ACTIVE / SUSPENDED), gói, tiến trình dựng (`platform_organizations.settings.onboarding`)
của một tổ chức sống ở CSDL NHÀ. Khôi phục
riêng CSDL tổ chức từ bản dump ngày T trong khi sổ ở nhà là hiện tại ⇒ module theo sổ hiện tại, không theo ngày T.
Khôi phục CẢ nhà từ bản cũ ⇒ sổ lùi về ngày đó (tổ chức cấp sau ngày ấy biến khỏi sổ dù CSDL của nó còn). Không
tệp nào ngoài CSDL (`.env`, `PLATFORM_SECRETS_KEY`) nằm trong phạm vi `erp-backup.sh`.

## 7. Diễn tập khôi phục MỘT tổ chức — hai tầng

Chi tiết lệnh + tiêu chí đạt: `docs/backup-restore.md` mục 8.

| Tầng | Chứng minh | Chạy | Kết quả đo |
|---|---|---|---|
| **Cấu hình** (blueprint) | xuất → MẤT CSDL + sổ → cấp lại CÙNG mã trống → cài từ tệp → xuất lại ⇒ cùng băm | `scripts/restore-drill-org-config.ts` (PGlite, 3 tiến trình); `npm test` chạy nó | 28/09/2026, máy Windows: **ĐẠT** — tệp 16.251 byte; băm nội dung nguồn `f308c4b1f0623ae188a062904a78a11e` = sau khôi phục; tổ chức trống `4a3cdd1d196a87e281542687f4b11593` (khác — phép so không mù); 0 xung đột, 0 bị chặn; cài lại 0 mục phải ghi; 1 → 0 bản ghi; 0 rò; ~20 giây |
| **CSDL** (pg_dump) | bản dump đêm của `erp_org_<mã>` nạp sạch vào Postgres thật, bảng lõi có dòng | ops `restore-drill-org` trên VPS, người vận hành bấm | CHƯA CHẠY trên VPS (production chưa có CSDL `erp_org_*`). Đã kiểm bằng `bash` thật với `docker` giả: đích là CSDL tạm `tam_khoiphuc_<mã>` trong container tạm, `erp-db` chỉ bị đọc, dọn cả khi hỏng |

Tầng cấu hình KHÔNG thay tầng CSDL: blueprint không mang bản ghi, tệp, người dùng hay bí mật (§3). Tầng CSDL là lời
hứa cho tới lượt `restore-drill-org` đầu tiên chạy trên VPS sau khi có tổ chức thật — đó là mục của `launch-gates.md` C.
