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
   sang máy khác cần CÙNG khoá, nếu không kết nối hiện "không giải mã được" và phải khai lại. Khoá nằm ở
   `/root/erp/.env` — tệp **không** thuộc phạm vi `erp-backup.sh`. Từ cổng A (`launch-gates.md` mục A) nó đi từ
   GitHub Secret `PLATFORM_SECRETS_KEY` qua deploy vào `.env`; GitHub Secret KHÔNG đọc lại được, nên mất VPS thì
   deploy lên máy mới ghi lại đúng khoá, còn đổi / xoá nhầm secret là mất khoá — cất bản sao ở ngoài (`launch-gates.md`
   C3). Diễn tập Postgres (§8) đo cả hai vế: cùng khoá giải đúng, khoá khác bị từ chối.
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
| **Đầu-cuối trên Postgres tạm** | tạo → tuỳ biến → `pg_dump` → phá + `DROP DATABASE` → khôi phục theo runbook → BẰNG từng bảng + tổ chức CHẠY ĐƯỢC qua mã ứng dụng | workflow **Diễn tập khôi phục tổ chức (Postgres tạm)** (`scripts/restore-drill-pg.ts`) | §8 — ĐẠT trên máy lập trình (Postgres 18.4); lượt CI trên `postgres:16-alpine` do phiên tích hợp chạy |

Tầng cấu hình KHÔNG thay tầng CSDL: blueprint không mang bản ghi, tệp, người dùng hay bí mật (§3). Tầng CSDL là lời
hứa cho tới lượt `restore-drill-org` đầu tiên chạy trên VPS sau khi có tổ chức thật — đó là mục của `launch-gates.md` C.

## 8. Diễn tập khôi phục tổ chức — Postgres thật

§7 có hai tầng, và cả hai đều dừng TRƯỚC câu hỏi chủ nền tảng thật sự hỏi: *một tổ chức có dữ liệu, cấu hình, người
dùng, luật, bí mật — mất CSDL — khôi phục từ bản `pg_dump` thì nó có CHẠY ĐƯỢC không?* Tầng cấu hình dùng PGlite (không
có `pg_dump`); tầng CSDL chưa từng chạy vì production chưa có tổ chức thứ hai và KHÔNG được tạo một tổ chức chỉ để thử.
Tầng thứ ba này trả lời câu đó trên một máy Postgres **dùng một lần**.

### 8.1 Chạy ở đâu, và vì sao

| Lựa chọn | Vì sao không / có |
|---|---|
| VPS production | Không: cấm tạo tổ chức thứ hai khi chưa có yêu cầu, cấm destructive test trên máy phục vụ VNX (2 nhân, ~1,9 GB) |
| PGlite trong `npm test` | Không: không có `pg_dump` / `pg_restore`, mà điều cần chứng minh chính là hai công cụ đó |
| **GitHub Actions + service container** | **Có**: `postgres:16-alpine` — CÙNG ảnh với `erp-db` (bài kiểm đọc `docker-compose.prod.yml` rồi so) — sống và chết cùng job; 0 secret, 0 SSH, kho PUBLIC vẫn an toàn; `createdb` / `pg_dump` / `pg_restore` chạy BÊN TRONG container bằng `docker exec -i`, đúng cách `erp-backup.sh` gọi `docker exec erp-db pg_dump …` và đúng phiên bản công cụ của máy chủ |

**Chạy:** Actions → **Diễn tập khôi phục tổ chức (Postgres tạm)** → *Run workflow* (ô `ma`, mặc định `drill-ws`; bắt
buộc bắt đầu bằng `drill-`). Kết quả: log `[drill] …`, tóm tắt của lượt chạy, artifact `restore-drill-report`
(JSON: số, tên bảng, băm, thời gian — không bí mật, không dòng dữ liệu; bản dump KHÔNG được tải lên). Thoát 0 = ĐẠT,
1 = KHÔNG ĐẠT (kèm từng câu hỏng), 2 = dùng sai / môi trường không phải máy tạm. Job này không nằm trong `gates.yml` /
`deploy-vps.yml` nên không chặn deploy, và chỉ chạy tay (lịch tự động: `launch-gates.md` C7).

**Cục bộ** (máy có Postgres ≥ 16 cài sẵn — không đụng cụm đang chạy, dựng một cụm tạm; một cụm = một lượt):

```bash
B="C:/Program Files/PostgreSQL/18/bin"; D=<thư mục tạm>/pgdrill
"$B/initdb" -D "$D" -U erp --auth=trust -E UTF8 --locale=C
"$B/pg_ctl" -D "$D" -o "-p 55432 -c listen_addresses=localhost" -l "$D.log" -w start
"$B/createdb" -h localhost -p 55432 -U erp erp
ERP_RESTORE_DRILL_EPHEMERAL=1 DATABASE_URL=postgres://erp@localhost:55432/erp ERP_DRILL_PG_BIN="$B" \
  npx tsx --tsconfig tsconfig.json scripts/restore-drill-pg.ts --bao-cao=data/restore-drill-pg-report.json
"$B/pg_ctl" -D "$D" stop     # rồi xoá thư mục $D
```

### 8.2 Bảy bước

| # | Bước | Ai làm | Đúng theo |
|---|---|---|---|
| 1 | **Tạo + tuỳ biến:** migrate CSDL nhà → `provisionOrganization` (`CREATE DATABASE erp_org_drill_ws`) → cài mẫu `wholesale` → đối tượng `x_diem_giao` + `x_hop_dong_si`, 7 field (quan hệ một tới khách và tới điểm giao, quan hệ nhiều, trạng thái có luật chuyển, tệp) + giá trị field của mẫu trên khách → form tạo + danh sách + nhãn trạng thái đơn XUẤT BẢN → trang tay 5 khối XUẤT BẢN + menu → luật BẬT + LIVE có cửa duyệt → 2 hợp đồng ⇒ 1 lượt chờ duyệt → **duyệt** → thực thi đúng 1 lần ⇒ 1 việc → vai trò `KD_SI` + người dùng gán vai trò → module bật `apps` `alerts`, tắt `purchasing` → thương hiệu → kết nối Lark + khoá AI (lưu → kiểm tra với máy chủ GIẢ → bật) → xuất blueprint | tiến trình con 1, ĐÚNG hàm dịch vụ mà màn hình gọi | — |
| 2 | **Ảnh "trước"**: mọi bảng `public` + `drizzle` của `erp_org_drill_ws` (số dòng + băm nội dung) + `pg_sequences`; dòng sổ + module của tổ chức ở CSDL nhà | điều phối, SQL thẳng | — |
| 3 | **Sao lưu**: `pg_dump -U erp -d erp_org_drill_ws -Fc`, rồi `pg_restore --list` phải có dữ liệu `public.users`, `public.settings`, `drizzle.__drizzle_migrations` | điều phối | `erp-backup.sh::sao_luu_mot_to_chuc` (bài kiểm so chuỗi lệnh) |
| 4 | **Phá**: tạm ngừng tổ chức (`SUSPENDED`) → xoá `custom_values`, `org_connections`, sửa `custom_records`, `users` → ảnh "đã phá" (phải KHÁC "trước", nếu không phép so là mù) → `DROP DATABASE erp_org_drill_ws` → kiểm không còn trong `pg_database` | điều phối | runbook §7 bước 0 |
| 5 | **Khôi phục**: `createdb -U erp -O erp tam_khoiphuc_drill_ws` → `pg_restore -U erp -d tam_khoiphuc_drill_ws --no-owner --no-privileges < bản.dump` (lỗi ⇒ DỪNG) → đối chiếu `users` / `settings` / migration → đổi tên tạm ⇒ `erp_org_drill_ws` (bản cũ đã DROP nên không có bước `hong_<mã>`) → ảnh "sau" → mở lại (`ACTIVE`) | điều phối | `docs/backup-restore.md` §7 bước 2–4 (bài kiểm so chuỗi lệnh) |
| 6 | **So + chạy thật** (tiến trình con 2 — tiến trình MỚI, không mang handle CSDL cũ): blueprint xuất lại (trước mọi thao tác ghi) · `getRecord` + `reverseRelations` + `getCustomValues` + `openCustomFile` ra đúng giá trị / byte · `resolvePage` hai trang, 0 lỗi khối, menu đủ · `runWorkflows` KHÔNG chạy lại lượt đã chạy (lượt + việc không đổi), bản ghi MỚI vẫn sinh đúng 1 lượt xin duyệt · `testOrgConnection` Lark + `openActiveConnection` khoá AI bằng CÙNG khoá ⇒ đúng bản rõ; khoá KHÁC ⇒ từ chối, 0 lượt gọi ra ngoài · `verifyLogin` quản trị + người dùng vai trò được, sai mật khẩu bị từ chối | tiến trình con 2, mã ứng dụng trong `withOrganization` | — |
| 7 | **Phán quyết + báo cáo**: `judgePgRestoreDrill` (`lib/platform/restore-drill-pg.ts`) — thuần, 34 đột biến trong `tests/restore-drill-pg.test.ts` | điều phối | — |

**Phạm vi so sánh.** Mọi bảng của lược đồ `public` và `drizzle` trong CSDL tổ chức — 187 bảng ở lượt đo 29/09/2026, kể
cả bảng rỗng (bảng rỗng biến mất vẫn là lệch) — mỗi bảng: số dòng + `md5` của chuỗi các `md5(dòng::text)` đã SẮP (không
phụ thuộc thứ tự vật lý; cùng số dòng mà khác nội dung vẫn bị bắt); cộng `last_value` của mọi sequence (sequence lùi =
id va nhau sau khôi phục). Ngoài phạm vi, CÓ CHỦ Ý: chủ sở hữu / quyền (runbook khôi phục `--no-owner
--no-privileges`), thống kê planner, CSDL nhà (không nằm trong bản dump tổ chức — §6). Mặt phẳng điều khiển của tổ chức
(sổ + module, cột ổn định) so riêng: khôi phục CSDL tổ chức không được làm đổi nó.

**Hàng rào** (thuần, có bài kiểm): mã tổ chức bắt buộc `drill-…`; tên tạm `tam_khoiphuc_…` qua hai hàng rào của
`erp-backup.sh` (mẫu tạm, và không khớp `^erp_org_`); `DROP DATABASE` chỉ nhận ĐÚNG hai tên của lượt (`erp`, `postgres`,
một `erp_org_*` thật, tên có dấu nháy đều ném trước khi dựng câu SQL); trước khi ghi một byte: phải khai
`ERP_RESTORE_DRILL_EPHEMERAL=1`, máy chủ là localhost, CSDL nhà tên `erp` và CHƯA CÓ BẢNG NÀO (production có ~190), máy
chưa có `erp_org_*` nào khác. Không đọc `.env`. Chạy lại trên cùng máy ⇒ bị từ chối (đo: "CSDL nhà đã có 186 bảng").

### 8.3 Kết quả đo

| Lượt | Postgres | Bảng / dòng | Bản dump | Khôi phục (createdb → đổi tên) | RTO tới khi CHẠY ĐƯỢC (đã kiểm) | Kết quả |
|---|---|---|---|---|---|---|
| 29/09/2026, máy lập trình (Windows, cụm `initdb` tạm, công cụ trên máy) | 18.4 | 187 bảng · 355 dòng | 735.660 byte · 220 ms | 1.119 ms · `pg_restore` 0 lỗi | 3.973 ms | **ĐẠT** — 187/187 bảng + sequence bằng nhau; mặt phẳng điều khiển bằng nhau; blueprint `6f079aba…` trước = sau; bản ghi / quan hệ / tệp đúng; 2 trang · 9 khối · 0 lỗi khối; chạy luật lại: thực thi 0, lượt 2→2, việc 1→1, bản ghi mới xin duyệt 1; cùng khoá giải đúng, khoá khác bị từ chối (0 lượt gọi ra); đăng nhập được, sai mật khẩu bị từ chối; bản đã phá lệch 4 bảng (phép so không mù) |
| CI `postgres:16-alpine`, `docker exec -i` | 16 | — | — | — | — | CHƯA CHẠY — phiên tích hợp chạy workflow sau khi gộp rồi điền số vào đây |

Con số trên là phần MÁY của RTO trên một tổ chức nhỏ. Nó không gồm: tải bản từ Drive, người vận hành đọc runbook, tạm
ngừng / mở lại ở `/platform`; và nó tăng theo cỡ CSDL (`pg_restore` tỉ lệ với dữ liệu + chỉ mục).

### 8.4 RPO · RTO · nơi lưu · thời gian giữ — theo mã đang chạy

| | Giá trị | Nguồn |
|---|---|---|
| **RPO** danh nghĩa | ≤ 1 ngày — một bản mỗi đêm: cron phút 17 mỗi giờ, chỉ chạy trong khung 02:00–05:59 giờ VN, ngày nào xong thì thôi | `PHUT_CRON=17`, `GIO_BAT_DAU=2`, `GIO_KET_THUC=5`, `/etc/cron.d/erp-backup` |
| **RPO** xấu nhất | ~2 ngày: tổ chức chạy SAU nhà trong cùng lượt và `daily-done` ghi theo kết quả của NHÀ ⇒ tổ chức hỏng đêm nay không được thử lại lúc 03–05 giờ; nhà hỏng cả khung ⇒ tổ chức cũng không có bản đêm đó. Bù bằng ops `backup` bấm tay | §2.2 |
| **RPO** ngoài máy | = RPO trên máy KHI đã bật Drive (C4); chưa bật ⇒ mất VPS là mất mọi bản | `day_ngoai_may_to_chuc` |
| **RTO** | phần máy đo ở §8.3; lời hứa với khách vẫn là quyết định C6 | §8.3 |
| **Nơi lưu** | VPS `/root/backups/orgs/<csdl>/{daily,weekly,manual}/<csdl>-YYYYmmdd-HHMM.dump` (thư mục 700); Drive `gcrypt:orgs/<csdl>/{daily,weekly,manual}/` (rclone crypt — Drive chỉ thấy byte mã hoá) | `THU_MUC_TO_CHUC`, `REMOTE_CRYPT` |
| **Giữ trên VPS** | 7 bản ngày · 4 bản Chủ nhật · 3 bản bấm tay, đếm RIÊNG theo tiền tố từng CSDL | `GIU_BAN_NGAY=7`, `GIU_BAN_TUAN=4`, `GIU_BAN_TAY=3` |
| **Giữ trên Drive** | xoá theo tuổi: `daily` > 8 ngày, `weekly` > 29 ngày, `manual` > 8 ngày | `rclone delete --min-age` trong `erp-backup.sh` |

### 8.5 Quy trình khôi phục từng bước

Lệnh copy-dán: `docs/backup-restore.md` §7 — đúng các lệnh diễn tập chạy ở bước 3–5. Thứ tự và điểm DỪNG:

1. Chủ nền tảng đồng ý (ghi đè dữ liệu của khách — AGENTS.md §7). Xác định `<mã>` ⇒ `erp_org_<mã>` và bản sẽ dùng.
2. `/platform` → tổ chức → **SUSPENDED**.
3. `ops backup` để có đường lui (dump hiện trạng, dù hỏng).
4. Lấy bản: trên VPS, hoặc `rclone copy gcrypt:orgs/<csdl>/…` (cần mật khẩu crypt — C4).
5. `createdb … tam_khoiphuc_<mã>` → `pg_restore … --no-owner --no-privileges` — **có dòng lỗi ⇒ DỪNG**.
6. Kiểm ĐÚNG TỔ CHỨC (§8.6, "khôi phục nhầm") + đối chiếu số dòng.
7. Ngắt kết nối → đổi tên cũ ⇒ `hong_<mã>_<mốc>` → tạm ⇒ `erp_org_<mã>`. Không `dropdb` bản cũ tới khi xác nhận.
8. **ACTIVE** → mở tổ chức (tự migrate phần còn thiếu) → kiểm `/settings/export` (băm khớp bản xuất trước sự cố nếu có),
   `/settings/connections` (không kết nối nào "không giải mã được"), đăng nhập một tài khoản của tổ chức.

### 8.6 Xử lý lỗi

| Tình huống | Dấu hiệu | Làm gì | Cái gì chặn sẵn |
|---|---|---|---|
| **Bản sao hỏng** | `pg_restore --list` không đọc được, hoặc `pg_restore` có dòng `error` | DỪNG; lấy bản cũ hơn (`daily` → `weekly` → Drive). Không đổi tên CSDL tạm thành CSDL thật | Lúc sao lưu: kích thước > 0 + mục lục có dữ liệu 3 bảng lõi, bản hỏng bị xoá ngay (`sao_luu_mot_to_chuc`). Diễn tập: cùng phép kiểm mục lục + đếm dòng lỗi `pg_restore` |
| **Sai khoá bí mật** | Dữ liệu khôi phục đủ, nhưng kết nối báo "không giải mã được" / "PLATFORM_SECRETS_KEY khác" | Đặt lại ĐÚNG khoá (GitHub Secret → deploy) rồi kiểm tra lại kết nối. **Đừng** lưu lại kết nối khi đang sai khoá: lượt lưu niêm phong lại bằng khoá mới và chỉ giữ ô vừa nhập. Khoá mất hẳn ⇒ khai lại bí mật từng kết nối | Fail closed (AES-GCM + AAD theo tổ chức + connector), `secrets_key_id` nói ngay "khoá đã đổi"; diễn tập đo: khoá khác ⇒ từ chối, 0 lượt gọi ra ngoài |
| **Thiếu migration** | Bản dump CŨ hơn mã đang chạy | Không làm gì: lần mở đầu tiên tự áp phần còn thiếu (`migrateOrganizationDb`, idempotent, có khoá) | `drizzle.__drizzle_migrations` nằm TRONG bản dump; diễn tập so cả bảng đó |
| **Migration ngược** | Bản dump MỚI hơn mã đang chạy (sổ có migration mà `drizzle/` không có) | Deploy mã tương ứng TRƯỚC rồi mới mở tổ chức. Không bao giờ sửa sổ bằng tay | §4 |
| **Khôi phục nhầm tổ chức** | Bản của A nạp vào tên của B | Trước bước đổi tên: `select distinct org_code from org_connections` trong CSDL tạm phải bằng `<mã>` đích (nếu có dòng); tên thương hiệu (`settings`) và email quản trị (`users`) phải là của đích. Lệch ⇒ `dropdb` CSDL TẠM, chọn lại bản | Tên tệp + thư mục mang tên CSDL (`orgs/<csdl>/<csdl>-<mốc>.dump`); CSDL tạm dẫn xuất từ mã đích; nạp nhầm vẫn KHÔNG lộ bí mật của A cho B: AAD gắn mã tổ chức nên bản mã không giải được, và dòng kết nối mang mã khác ngữ cảnh bị từ chối (`tripwire`) |
| **Diễn tập bị trỏ nhầm máy** | — | — | Hàng rào môi trường §8.2: thiếu khẳng định / không localhost / nhà có bảng / có `erp_org_*` khác ⇒ thoát 2 trước khi ghi |

### 8.7 Chiến lược bí mật — hai nơi, không bao giờ chung một chỗ

- **Bản mã** nằm TRONG bản dump: `org_connections.secrets_enc` (AES-256-GCM, nonce ngẫu nhiên, AAD theo tổ chức +
  connector). Mật khẩu người dùng là băm bcrypt. Bản dump vì thế vẫn là dữ liệu nhạy cảm (thư mục 700, Drive qua crypt),
  nhưng một mình nó KHÔNG mở được bí mật kết nối.
- **Khoá** `PLATFORM_SECRETS_KEY` KHÔNG BAO GIỜ nằm trong bản dump và `erp-backup.sh` không chép nó lên Drive: nó ở
  GitHub Secret (không đọc lại được) → deploy → `/root/erp/.env`. Mật khẩu crypt của Drive là một khoá THỨ HAI, tách
  riêng. Lộ Drive + mật khẩu crypt vẫn chưa lộ bí mật kết nối; lộ `.env` mà không có bản dump cũng chưa.
- **Khôi phục cần CÙNG khoá.** Diễn tập chứng minh cả hai chiều bằng một khoá GIẢ sinh trong bộ nhớ của lượt chạy: cùng
  khoá ⇒ đúng bản rõ; khoá khác ⇒ từ chối. Vì GitHub Secret không đọc lại được, bản sao của khoá ở trình quản lý mật
  khẩu của chủ nền tảng là điều kiện để "đổi / xoá nhầm secret" không thành "mất mọi bí mật" (`launch-gates.md` C3).
