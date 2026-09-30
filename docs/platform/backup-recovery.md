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

- **Lịch:** `/etc/cron.d/erp-backup` do `install-vps.sh` cài ở MỖI lần deploy, BA dòng (quyết định C4/C6/C7,
  29/09/2026 — §9):
  - phút 17 mỗi giờ, `cron` — bản ĐÊM của nhà + mọi CSDL tổ chức, chỉ trong khung 02:00–05:59 giờ VN, mỗi ngày đúng một
    bản (`daily-done`), lượt hỏng thử lại giờ sau. **Không đổi.**
  - phút 47 mỗi giờ, `hourly-org` — bản GIỜ của mọi CSDL `erp_org_*` (không bao giờ CSDL nhà) vào
    `orgs/<csdl>/hourly/`, giữ 48 bản (`GIU_BAN_GIO`). Không có tổ chức nào ⇒ thoát 0, không ghi gì.
  - phút 37 mỗi giờ, `drill-org-weekly` — chỉ Chủ nhật 06:00–07:59 giờ VN: diễn tập khôi phục luân phiên MỘT CSDL tổ
    chức vào CSDL TẠM trong container TẠM, mỗi tuần một lượt.
  - PITR (§9.4, quyết định 30/09/2026) ở tệp cron RIÊNG `/etc/cron.d/erp-pitr` do `scripts/erp-pitr.sh install-cron` cài:
    phút 27 `base-cron` (bản nền mỗi đêm SAU bản đêm) · phút 8/23/38/53 `push-wal` (kho WAL lên `gcrypt:pitr/wal/`).
- **Giữ:** 7 bản ngày · 4 bản Chủ nhật · 3 bản bấm tay (`GIU_BAN_NGAY` / `GIU_BAN_TUAN` / `GIU_BAN_TAY`).
- **Ngoài máy:** Google Drive qua remote `gcrypt:` (rclone crypt — Drive chỉ thấy byte mã hoá), cấu hình từ
  Secrets ở `/root/.config/erp-backup/offsite.env`.
- **Kiểm:** kích thước > 0, `pg_restore --list` đọc lại được, mục lục phải có dữ liệu `orders` + `shipments`; ops
  `restore-drill` nạp bản mới nhất vào container tạm rồi đếm 14 bảng then chốt. CSDL tổ chức: ops `restore-drill-org`
  (tay, và tự động mỗi Chủ nhật — §7).
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
| 5 · diễn tập luân phiên | ✓ ops `restore-drill-org` (`erp-backup.sh restore-drill-org [mã]`; không mã ⇒ luân phiên theo lượt diễn tập cũ nhất). Ghi `status/orgs/<csdl>/last-drill.json` nên thẻ của ĐÚNG tổ chức đó hết vàng. **Tự động từ quyết định C7 (29/09/2026)**: `drill-org-weekly` mỗi Chủ nhật 06–07 giờ VN, luân phiên một CSDL / tuần (§9.3). §7 |
| 6 · bài kiểm | ✓ (xem trên) |
| 7 · CSDL ở máy khác | ✓ nêu ra ở hai phía: script (`missingDatabases`) và thẻ của tổ chức (`ORG_DATABASE_URL__…` ⇒ đỏ "không được sao lưu tự động"). Lịch sao lưu riêng cho chúng vẫn là việc của chủ nền tảng |

Hai giới hạn còn lại của BẢN ĐÊM, cố ý (lượt giờ §9.2 bù phần RPO: tổ chức có bản mỗi giờ dù bản đêm hỏng):

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
| **CSDL** (pg_dump) | bản dump MỚI NHẤT (giờ / đêm) của `erp_org_<mã>` nạp sạch vào Postgres thật, bảng lõi có dòng | ops `restore-drill-org` trên VPS (tay) + `drill-org-weekly` (cron, mỗi Chủ nhật, luân phiên) | CHƯA CHẠY trên VPS (production chưa có CSDL `erp_org_*` — lượt tuần thoát 0 không làm gì). Đã kiểm bằng `bash` thật với `docker` giả: đích là CSDL tạm `tam_khoiphuc_<mã>` trong container tạm, `erp-db` chỉ bị đọc, dọn cả khi hỏng |
| **Đầu-cuối trên Postgres tạm** | tạo → tuỳ biến → `pg_dump` → phá + `DROP DATABASE` → khôi phục theo runbook → BẰNG từng bảng + tổ chức CHẠY ĐƯỢC qua mã ứng dụng | workflow **Diễn tập khôi phục tổ chức (Postgres tạm)** (`scripts/restore-drill-pg.ts`) — tay + lịch MỖI TUẦN (C7) | §8 — ĐẠT trên máy lập trình (Postgres 18.4) và CI `postgres:16-alpine` (run 36545135985) |

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
`deploy-vps.yml` nên không chặn deploy. Từ quyết định C7 (29/09/2026) nó chạy thêm theo lịch **mỗi tuần**
(`cron: "0 20 * * 6"` = 03:00 Chủ nhật giờ VN, mã mặc định `drill-ws`) — vẫn 0 secret, 0 SSH, không đụng VPS.

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
| 29/09/2026, CI `postgres:16-alpine` (run 36545135985, `docker exec -i`, cùng ảnh `erp-db`) | 16.15 | 187 bảng · 356 dòng · 1 sequence | 728.765 byte · 397 ms | 3.556 ms · `pg_restore` thoát 0, 0 dòng lỗi | 6.260 ms (cả lượt 17 giây) | **ĐẠT** — bằng nhau từng bảng + sequence; bí mật: cùng khoá giải đúng, khoá khác bị từ chối (fail closed); bản đã phá lệch 4 bảng trước khi khôi phục |

Con số trên là phần MÁY của RTO trên một tổ chức nhỏ. Nó không gồm: tải bản từ Drive, người vận hành đọc runbook, tạm
ngừng / mở lại ở `/platform`; và nó tăng theo cỡ CSDL (`pg_restore` tỉ lệ với dữ liệu + chỉ mục).

### 8.4 RPO · RTO · nơi lưu · thời gian giữ — theo mã đang chạy

| | Giá trị | Nguồn |
|---|---|---|
| **RPO** danh nghĩa | **≤ 1 giờ** — bản GIỜ phút 47 (`hourly-org`, §9.2) cộng bản ĐÊM 02:17 | `PHUT_CRON_GIO=47`, `PHUT_CRON=17`, `/etc/cron.d/erp-backup` |
| **RPO** xấu nhất (bình thường) | ~2 giờ: một lượt giờ bị bỏ vì khoá bận (bản đêm / diễn tập / deploy / đọc nặng quá 10 phút) thì giờ sau làm lại. Khung 02:00–05:59 mà bản đêm chưa xong thì lượt giờ nhường, bản đêm dump cả tổ chức. Thẻ Sao lưu của tổ chức báo vàng khi bản thành công gần nhất > 3 giờ (`ORG_BACKUP_RPO_ALERT_HOURS`) | §9.2 |
| **RPO** ngoài máy | = RPO trên máy cộng thời gian đẩy Drive KHI đã bật Drive (C4); chưa bật ⇒ mất VPS là mất mọi bản. Lỗi đẩy không xoá bản cục bộ (trạng thái PARTIAL) | `day_ngoai_may_to_chuc` |
| **RTO** | phần máy đo ở §8.3 (6,3 giây, tổ chức nhỏ); runbook có thời gian từng bước ở §10 | §8.3, §10 |
| **Nơi lưu** | VPS `/root/backups/orgs/<csdl>/{hourly,daily,weekly,manual}/<csdl>-YYYYmmdd-HHMM.dump` (thư mục 700); Drive `gcrypt:orgs/<csdl>/{hourly,daily,weekly,manual}/` (rclone crypt — Drive chỉ thấy byte mã hoá) | `THU_MUC_TO_CHUC`, `REMOTE_CRYPT` |
| **Giữ trên VPS** | 48 bản giờ · 7 bản ngày · 4 bản Chủ nhật · 3 bản bấm tay, đếm RIÊNG theo tiền tố từng CSDL | `GIU_BAN_GIO=48`, `GIU_BAN_NGAY=7`, `GIU_BAN_TUAN=4`, `GIU_BAN_TAY=3` |
| **Giữ trên Drive** | xoá theo tuổi: `hourly` > 49 giờ, `daily` > 8 ngày, `weekly` > 29 ngày, `manual` > 8 ngày | `rclone delete --min-age` trong `erp-backup.sh` |

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

## 9. Quyết định C4 / C6 / C7 (29/09/2026) — mục tiêu, cái đạt được hôm nay, và PITR

Nguyên văn quyết định của chủ nền tảng: «C4/C6/C7: full backup hằng đêm; incremental/PITR mỗi giờ nếu hạ tầng DB hỗ
trợ; target RPO <= 1 giờ; target RTO <= 4 giờ; tự động restore drill mỗi tuần trên môi trường test, không restore đè
production.»

### 9.1 Mục tiêu so với hôm nay

"Hôm nay" = mã của commit này SAU khi deploy (lịch cron cài ở lần deploy kế tiếp). Chữ **ĐO** = có số chạy thật; chữ
**ƯỚC LƯỢNG** = suy luận, chưa có số.

| | Mục tiêu | CSDL NHÀ (`erp`, VNX) | CSDL tổ chức khách (`erp_org_*`) |
|---|---|---|---|
| Bản đầy đủ | hằng đêm | ✓ `pg_dump -Fc` 02:17 giờ VN (khung 02–05, thử lại mỗi giờ) — **không đổi** | ✓ cùng lượt đêm, sau nhà |
| Bản gia tăng / PITR mỗi giờ | "nếu hạ tầng hỗ trợ" | ◐ **MÃ SẴN (30/09/2026), CHỜ DEPLOY trong cửa sổ bảo trì** — PITR cấp cụm: `archive_mode=on`, `archive_timeout=900`, bản nền mỗi đêm, WAL ngoài máy mỗi 15 phút, diễn tập `pitr-drill` (§9.4). Deploy đó tạo lại `erp-db` (~10–30 giây, ƯỚC LƯỢNG). Bản logic mỗi giờ của cả CSDL nhà thì không: dump CSDL đang gánh VNX mỗi giờ trên máy 2 nhân đang bão hoà là thêm đúng loại tải đã đo gây nghẽn | ✓ bản LOGIC mỗi giờ (`hourly-org`, §9.2) — CSDL tổ chức nhỏ, dump giây; không cần đổi cấu hình Postgres. Sau khi bật PITR: thêm PITR cấp cụm (≤ 15 phút) |
| RPO | ≤ 1 giờ | **≤ 1 ngày** tới khi deploy PITR (bản đêm; hỏng cả khung 02–05 ⇒ tới ~2 ngày, thẻ đỏ ở 36 giờ). Sau khi bật: **≤ 15 phút** THIẾT KẾ (`archive_timeout`), số ĐO = `now − last_archived_time` của ops `pitr-status` (§9.4.5) | **≤ 1 giờ** (lượt phút 47); lỡ một lượt ⇒ ~2 giờ, tự lành giờ sau; thẻ vàng khi > 3 giờ |
| RPO ngoài máy | ≤ 1 giờ | = trên máy khi Drive đã cấu hình (C4). Sau PITR: ≈ 30 phút (WAL lên `gcrypt:pitr/wal/` mỗi 15 phút) | = trên máy + thời gian đẩy (`gcrypt:orgs/<csdl>/hourly/`), khi Drive đã cấu hình (C4) |
| RTO | ≤ 4 giờ | **CHƯA ĐO** cỡ production — runbook §10.2, ước lượng 1–2 giờ nếu CSDL vài GB | phần máy **ĐO** 6,3 giây (tổ chức nhỏ, CI 36545135985); cả quy trình **ƯỚC LƯỢNG** 1–1,5 giờ trên VPS còn sống, 2–3 giờ khi mất VPS (§10.1) |
| Diễn tập tự động mỗi tuần, môi trường test | mỗi tuần | ✗ `restore-drill` của nhà vẫn **chạy tay** (tháng một lần). Đưa nó vào cron = dựng một Postgres cỡ CSDL nhà mỗi tuần trên máy 1,9 GB — cần số đo RAM/thời gian của một lượt tay trước (§10.2 bước 2) | ✓ **hai tầng**: (a) CI mỗi tuần — workflow **Diễn tập khôi phục tổ chức (Postgres tạm)**, `cron: "0 20 * * 6"`, dữ liệu tổng hợp, máy GitHub; (b) VPS mỗi Chủ nhật 06–07 giờ VN — `drill-org-weekly` luân phiên một CSDL thật vào CSDL TẠM trong container TẠM (§9.3) |
| Không restore đè production | tuyệt đối | ✓ diễn tập chỉ vào container tạm | ✓ đích luôn `tam_khoiphuc_<mã>` trong container tạm không mạng; `erp-db` chỉ bị đọc `count(*)` / `pg_database_size` (bài kiểm chạy bash thật khoá) |

### 9.2 Lượt sao lưu MỖI GIỜ cho tổ chức — `erp-backup.sh hourly-org`

- **Chỉ `erp_org_*`.** Danh sách hỏi `pg_database` qua đúng hàng rào tên của lượt đêm; mỗi CSDL đi qua đúng
  `sao_luu_mot_to_chuc` (kiểm ổ đĩa, `pg_dump -Fc`, `pg_restore --list` phải có `users` / `settings` /
  `__drizzle_migrations`, xoay vòng, đẩy Drive). KHÔNG một lời gọi `pg_dump -d erp`, không bot chat, không ghi
  `last-run.json` / `last-success.json` / `daily-done` của nhà — phần của nhà trong `scripts/erp-backup.sh` vẫn đúng băm
  `BAM_PHAN_NHA`.
- **Thư mục:** `/root/backups/orgs/<csdl>/hourly/<csdl>-YYYYmmdd-HHMM.dump`, giữ 48 bản (2 ngày); Drive
  `gcrypt:orgs/<csdl>/hourly/`, xoá theo tuổi > 49 giờ (chỉ dọn `hourly/` — không 72 lượt gọi Drive vô ích mỗi ngày).
  Lỗi đẩy Drive KHÔNG xoá bản cục bộ: trạng thái `PARTIAL`, thoát 1.
- **Không chạy chồng:** cùng ổ khoá với bản đêm / ops / deploy. FD 7 KHÔNG chờ — bận ⇒ bỏ lượt, thoát 0, giờ sau làm
  lại; FD 8 / FD 9 chờ tối đa 10 phút (`TRAN_CHO_KHOA_GIO_GIAY`) để không treo sang lượt sau. Trong khung 02:00–05:59 mà
  bản đêm hôm nay chưa xong ⇒ nhường (bản đêm dump cả tổ chức).
- **Không có tổ chức nào** (production 29/09/2026) ⇒ một câu đọc `pg_database`, thoát 0, không khoá, không tệp, không
  một dòng log. `psql` lỗi ⇒ CHƯA BIẾT, thoát 1, không ghi tệp (thẻ tự lộ khi bản quá cũ).
- **Trạng thái:** `status/orgs/<csdl>/last-hourly.json` (mọi lượt, `trigger: "hourly"`) + `last-success.json` (khi có
  bản dùng được) + `status/orgs-last-hourly.json` (tổng hợp). `last-run.json` của tổ chức vẫn là lời khai bản ĐÊM. Thẻ
  Sao lưu của tổ chức (`evaluateBackupHealth`) thêm: bản thành công gần nhất > 3 giờ ⇒ vàng "RPO ≤ 1 giờ KHÔNG giữ
  được"; lượt giờ gần nhất hỏng (sau bản tốt) ⇒ vàng; dòng "Lượt mỗi giờ gần nhất". Thẻ của NHÀ không đổi và không đọc
  tệp giờ.
- **Dung lượng:** 48 × cỡ bản dump của mỗi tổ chức, cộng dự trữ 3.000 MB kiểm TRƯỚC mỗi lượt như bản đêm. Tổ chức đo ở
  §8.3 dump 0,7 MB ⇒ 48 bản ≈ 35 MB.

### 9.3 Diễn tập tự động mỗi tuần — hai tầng, không tầng nào đè production

**(a) CI — dữ liệu tổng hợp.** `.github/workflows/restore-drill.yml` có thêm `schedule: cron "0 20 * * 6"` (Thứ Bảy
20:00 UTC = Chủ nhật 03:00 giờ VN). Service container `postgres:16-alpine` (cùng ảnh `erp-db`) sống và chết cùng job;
0 secret, 0 SSH, 0 quyền ghi (`tests/restore-drill-pg.test.ts` khoá: đúng hai cửa vào `schedule` + `workflow_dispatch`,
lịch đúng một thứ trong tuần). GitHub chỉ chạy lịch trên `main`; một lượt đỏ gửi thông báo tới người theo dõi kho.

**(b) VPS — bản thật của một tổ chức.** Dòng cron phút 37 gọi `erp-backup.sh drill-org-weekly`, script tự lọc Chủ nhật
06:00–07:59 giờ VN (SAU khung bản đêm — diễn tập đúng bản vừa sinh):

1. Đã có kết luận tuần này (`status/drill-org-week-done` = hôm nay) ⇒ thoát 0, im lặng.
2. Chọn luân phiên MỘT CSDL có bản trên máy (chưa diễn tập / diễn tập lâu nhất đứng đầu). Không có ⇒ thoát 0, không
   ghi gì.
3. Cầm FD 7 (khoá sao lưu, không chờ): không dựng Postgres thứ hai giữa lúc một lượt dump đang ăn RAM. Bận ⇒ giờ sau.
4. Gọi ĐÚNG `cmd_restore_drill_to_chuc` của ops `restore-drill-org`: kiểm RAM ≥ 700 MB + ổ đĩa TRƯỚC khi dựng; container
   tạm cùng ảnh, `--network none`, `--memory 512m`, `--cpus 1`; CSDL TẠM `tam_khoiphuc_<mã>` bên trong container đó;
   `pg_restore` bản MỚI NHẤT (kể cả bản giờ); đếm 12 bảng lõi ở bản khôi phục và CSDL sống; `trap EXIT` xoá container.
5. Ghi `status/orgs/<csdl>/last-drill.json` (thẻ của tổ chức đó đọc). Chỉ đánh dấu "tuần này xong" khi lượt đi tới KẾT
   LUẬN của CHÍNH nó (OK / FAILED, `finishedAt` ≥ lúc bắt đầu). SKIPPED (thiếu RAM / ổ) hay hết giờ chờ khoá ⇒ 07 giờ thử
   lại. FAILED không thử lại — cùng bản cho cùng kết luận; nó là tín hiệu đỏ trên thẻ.

Giới hạn, nói thẳng: một CSDL mỗi tuần. Có N tổ chức thì mỗi tổ chức được diễn tập mỗi N tuần; thẻ chuyển vàng khi lượt
đạt gần nhất quá 35 ngày (`BACKUP_DRILL_MAX_AGE_DAYS`) ⇒ từ tổ chức thứ 6 trở đi cần tăng nhịp (nhiều CSDL / lượt, hoặc
thêm ngày) — một quyết định vận hành, không tự đổi.

### 9.4 PITR cho cả cụm `erp-db` — ĐÃ TRIỂN KHAI TRONG MÃ (chờ deploy trong cửa sổ bảo trì)

Quyết định của chủ nền tảng (30/09/2026), nguyên văn: «PITR POSTGRESQL: Chuẩn bị và thực hiện PITR theo phương án đã
audit. Yêu cầu: backup hiện tại phải healthy trước khi thay đổi; downtime tối thiểu; không mất migration/data; verify
WAL/PITR thực sự hoạt động; thực hiện restore drill ở môi trường an toàn; xác nhận RPO/RTO sau khi bật; VNX smoke đầy đủ
sau thay đổi. Nếu cần downtime production 10–30 giây, đây là approval của owner…»

**Trạng thái:** mã + bài kiểm có trong kho (commit của mục này). **Có hiệu lực ở lần deploy KẾ TIẾP** — và lần deploy
đó TẠO LẠI `erp-db` (§9.4.2). Vì vậy bản này chỉ được gộp vào `main` ngay trước cửa sổ bảo trì, hoặc gộp rồi deploy
ngay trong cửa sổ: sau khi gộp, BẤT KỲ lượt deploy nào (kể cả của một PR khác) cũng mang theo lần khởi động lại ấy.

#### 9.4.1 Ba mảnh, mỗi mảnh ở đúng một chỗ

| Mảnh | Ở đâu | Làm gì |
|---|---|---|
| Cấu hình Postgres | `docker-compose.prod.yml`, dịch vụ `db`, `command:` | `postgres -c wal_level=replica -c archive_mode=on -c archive_timeout=900 -c archive_command=/bin/sh /erp-pitr-bin/luu-wal.sh %p %f` + `stop_grace_period: 60s`. KHÔNG sửa tệp nào trong volume `erp_pgdata`. Ảnh (`postgres:16-alpine`), volume, mật khẩu KHÔNG đổi (`tests/pitr.test.ts` khoá từng dòng) |
| Lưu từng đoạn WAL | `deploy/pitr-luu-wal.sh` — chạy TRONG `erp-db` (busybox `sh`), mount MỘT TỆP chỉ-đọc | gzip → tệp tạm → fsync → `ln` vào `/pitr/wal/<đoạn>.gz`. Đích đã có + CÙNG nội dung ⇒ 0 (idempotent); KHÁC nội dung ⇒ ≠0, không bao giờ ghi đè. Cờ `.tam-dung` ⇒ bỏ đoạn + ghi sổ lỗ hổng (phanh). Ổ còn < 1.536 MB ⇒ bỏ đoạn + ghi sổ lỗ hổng (thà mất độ phủ PITR còn hơn để `pg_wal` làm đầy ổ và Postgres PANIC). Kho WAL > 8.192 MB ⇒ ≠0 (lỗi NHÌN THẤY ĐƯỢC ở `pg_stat_archiver`, cảnh báo sớm trong lúc ổ còn chỗ) |
| Mọi thứ còn lại | `scripts/erp-pitr.sh` (máy chủ; `source` erp-backup.sh để DÙNG LẠI khoá/JSON/ngoài máy, không đè hàm nào) | bản nền, xoay vòng, đẩy ngoài máy, trạng thái, dòng đánh dấu, diễn tập, phanh, lịch |

Thư mục trên máy chủ: `/root/backups/pitr/{wal,base}` (chủ uid 70 = `postgres` của ảnh alpine), mount vào `erp-db` tại
`/pitr`. CHỈ dịch vụ `db` gắn nó (nó đã là CSDL, không mở thêm dữ liệu cho container nào). `install-vps.sh` chạy
`erp-pitr.sh chuan-bi` TRƯỚC `up -d --build db`; hỏng ⇒ deploy DỪNG trước khi đụng `erp-db` (thiếu thư mục thì Docker tự
tạo thư mục của root, mọi lượt lưu hỏng vì sai quyền, WAL dồn trong `pg_wal`).

Lịch (tệp RIÊNG `/etc/cron.d/erp-pitr`, `/etc/cron.d/erp-backup` không đổi một byte; `BAM_PHAN_NHA` vẫn khớp):
- phút 27 mỗi giờ `base-cron` — bản nền `pg_basebackup -Ft -X stream -Z 1 -c spread -r 32M` trong khung 02:00–05:59 giờ VN,
  SAU bản đêm của nhà (`daily-done` = hôm nay; giờ cuối khung thì chạy dù bản đêm hỏng — PITR không chết theo `pg_dump`),
  mỗi đêm một bản. Khoá: FD 7 không chờ → FD 8 → FD 9 như lượt đêm. `archive_mode` chưa bật ⇒ im lặng.
- phút 8/23/38/53 `push-wal` — `rclone copy` kho WAL lên `gcrypt:pitr/wal/` (copy, không sync; khoá riêng FD 6). Lỗi đẩy
  không đụng bản cục bộ.
- Giữ **2 bản nền** + mọi WAL từ đoạn bắt đầu của bản nền CŨ NHẤT còn giữ (xoá WAL / `.partial` / `.backup` cũ hơn;
  `.history` luôn giữ). Ngoài máy dọn theo tuổi > 4 ngày.

Năm thao tác ops (ops-vps.yml, kết quả MÃ HOÁ, con số qua kênh `[ops:tom-tat]`):

| Ops | Làn khoá | Tham số | Làm gì |
|---|---|---|---|
| `pitr-status` | DOC_NHE | — | CHỈ ĐỌC: `pg_stat_archiver` (archived/failed count, đoạn + mốc gần nhất), `wal_level`/`archive_mode`/`archive_timeout`, số đoạn chờ lưu, cỡ `pg_wal`; kho WAL trên máy (số tệp, MB, đoạn mới nhất, cờ tạm dừng); bản nền mới nhất + tuổi; sổ lỗ hổng sau bản nền; ngoài máy; băm kịch bản lưu WAL trong `erp-db` so với kho; **RPO hiện tại = now − last_archived_time**; KẾT LUẬN OK / VÀNG / ĐỎ (ĐỎ ⇒ thoát 1) |
| `pitr-basebackup` | DOC_NANG | — | chụp bản nền NGAY (như lượt cron) — dùng ngay sau khi bật để có mốc khôi phục đầu tiên |
| `pitr-mark` | GHI | — | GHI đúng MỘT dòng `settings` khoá `platform.pitr.marker` = nonce ngẫu nhiên; lưu nonce + mốc COMMIT vào `status/pitr-marker.json` |
| `pitr-drill` | DOC_NANG | mốc ISO (`2026-09-30T20:15:00Z` / `+07:00`); rỗng = đoạn WAL mới nhất − 2 phút | diễn tập PITR, không chạm `erp-db` (§9.4.4) |
| `pitr-pause` | GHI | rỗng = tạm dừng · `resume` = chạy lại | phanh không cần khởi động lại (§9.4.6) |

#### 9.4.2 Deploy có dựng lại `db` không — và gián đoạn bao lâu

**Có, đúng một lần.** `install-vps.sh` chạy `docker compose -f docker-compose.prod.yml up -d --build db` ở MỌI lần deploy.
Compose so nhãn `com.docker.compose.config-hash` của container đang chạy với cấu hình mới; `command`, `volumes` và
`stop_grace_period` đều nằm trong phép băm ⇒ khác ⇒ **Recreate**: dừng container cũ (STOPSIGNAL SIGINT của ảnh postgres =
fast shutdown, có checkpoint; trần 60 giây), xoá container, tạo container mới trên CÙNG volume `erp_pgdata`, CÙNG ảnh đã
có trên máy (không kéo ảnh mới), CÙNG biến môi trường. Entrypoint thấy `PG_VERSION` ⇒ không initdb, khởi động thẳng với
các `-c` mới. Dữ liệu không đổi định dạng: `wal_level` vẫn `replica` (mặc định cũ), chỉ thêm việc lưu đoạn WAL. Các lần
deploy SAU đó: hash không đổi ⇒ compose không đụng `erp-db` (kịch bản lưu WAL đổi nội dung KHÔNG làm tạo lại — mount một
tệp giữ inode cũ; `pitr-status` báo VÀNG "kịch bản trong erp-db khác kho" cho tới lần tạo lại có chủ đích:
`docker compose -f docker-compose.prod.yml up -d --force-recreate db` trong một cửa sổ khác).

Kiểm trước (CHỈ ĐỌC, trên máy chủ, không cần cửa sổ): `docker inspect erp-db --format '{{index .Config.Labels "com.docker.compose.config-hash"}}'`
khác `docker compose -f docker-compose.prod.yml config --hash db` ở commit mới ⇒ lần deploy đó sẽ tạo lại.

**Gián đoạn — ƯỚC LƯỢNG, chưa đo trên máy này:** CSDL không nhận kết nối **khoảng 10–30 giây** (dừng nhanh + khởi động
không cần phục hồi; `shared_buffers` mặc định 128 MB). `app`/`scheduler` KHÔNG bị `up -d db` khởi động lại — kết nối cũ
bị cắt, truy vấn kế tiếp mở kết nối mới (như mọi lần `erp-db` khởi động lại); trong khoảng đó yêu cầu đang chạy lỗi, job của scheduler đang dở chạy lại ở nhịp sau, webhook Viettel Post được
VTP thử lại (idempotent). Cùng lượt deploy vẫn tạo lại `app`/`scheduler` như mọi lần deploy (ảnh mới) — gián đoạn đó
không mới. **Đo thật:** mốc `Recreate`/`Started` của `erp-db` trong log deploy + dòng `database system is ready to accept
connections` trong `docker logs erp-db`.

#### 9.4.3 Runbook bật (cửa sổ bảo trì, thấp điểm SAU bản đêm — vd 03:30 giờ VN, không trùng deploy khác)

| # | Bước | Đạt khi | Dừng nếu |
|---|---|---|---|
| 0 | Đo (CHỈ ĐỌC, `db-query`, mỗi câu một lượt, trước ngày bảo trì): các câu `pg_settings` / `pg_database_size` / `pg_stat_wal` / `pg_current_wal_lsn()` ở §9.4.7; `docker exec erp-db grep replication /var/lib/postgresql/data/pg_hba.conf` phải có dòng `local replication all trust` (mặc định của ảnh) | có `wal_bytes_24h`, cỡ cụm, ổ trống; dung lượng 2 bản nền + WAL 2–3 ngày < ổ trống − 3.000 MB | ổ không đủ ⇒ KHÔNG bật (hoặc hạ `TRAN_KHO_WAL_MB` / giữ ít ngày hơn — quyết định chủ nền tảng) |
| 1 | ops `backup-status` | `last-success.json` của nhà mới hơn 24 giờ, `last-run.json` = OK, `daily-done` = hôm nay | bản đêm hỏng ⇒ sửa trước, không bật |
| 2 | ops `backup` (bản logic mới ngay trước thay đổi) | thoát 0, `KẾT QUẢ: OK`, ngoài máy OK | hỏng ⇒ dừng |
| 3 | Gộp PR + deploy (workflow **Deploy ERP to VPS**) — `erp-db` được tạo lại (§9.4.2) | deploy xanh; `/api/health` ok; `docker ps` thấy `erp-db` Up (healthy) | `erp-db` không lên ⇒ ROLLBACK §9.4.6 |
| 4 | ops `pitr-status` | `archive_mode=on`, `wal_level=replica`, `archive_timeout=900s`, `failed_count` không tăng; sau ≤ 15 phút có `last_archived_wal` và đoạn `.gz` trong kho | `failed_count` tăng liên tục ⇒ đọc `docker logs erp-db` dòng `erp-pitr luu-wal`; không tự lành trong 30 phút ⇒ phanh §9.4.6 |
| 5 | ops `pitr-basebackup` | thoát 0, `PITR bản nền: base-…` | lỗi `replication` ⇒ kiểm pg_hba (bước 0) |
| 6 | ops `pitr-mark` | `settings.platform.pitr.marker = nonce …` + mốc commit | — |
| 7 | Chờ ≥ 1 chu kỳ archive (≥ 15 phút + vài phút cho một giao dịch SAU mốc đánh dấu) → ops `pitr-status` thấy đoạn mới hơn mốc đánh dấu | — | — |
| 8 | ops `pitr-drill` (arg rỗng) | `PITR diễn tập: OK` — pha TRƯỚC mốc đánh dấu ⇒ nonce VẮNG, pha SAU ⇒ nonce CÓ, `orders`/`shipments`/`settings`/migration có dữ liệu; ghi lại dòng `RTO phần máy` | PARTIAL ⇒ chờ thêm một chu kỳ rồi chạy lại; FAILED ⇒ đọc lý do, PITR CHƯA được coi là bật |
| 9 | ops `verify` + ops `smoke` (VNX smoke đầy đủ) | xanh | đỏ ⇒ so với smoke trước deploy (memory: smoke có thể nhất thời) |
| 10 | Ghi số vào §9.4.5 (RPO đo = `now − last_archived_time` ở bước 4/7; RTO phần máy của bước 8) và `launch-gates.md` C8 | — | — |

#### 9.4.4 Diễn tập PITR (`pitr-drill`) — ở môi trường an toàn, không bao giờ đè production

- **Không chạm production:** không một lời gọi `docker` nào nhắm vào `erp-db`, volume `erp_pgdata`, cổng hay mạng của nó
  (`tests/pitr.test.ts` quét mã nguồn VÀ chạy với docker giả rồi đọc lại từng lời gọi). Ảnh là HẰNG SỐ `postgres:16-alpine`
  (bài kiểm đòi bằng ảnh của `db`); dữ liệu từ bản nền trên đĩa; WAL từ kho WAL gắn CHỈ-ĐỌC; mốc đánh dấu từ
  `status/pitr-marker.json`.
- Container tạm `--network none --memory 512m --memory-swap 512m --cpus 1`, kiểm RAM ≥ 700 MB + ổ ≥ cỡ cụm lúc chụp +
  3.000 MB TRƯỚC khi dựng; thư mục dữ liệu tạm `/root/backups/.pitr-dien-tap.<pid>` và container bị xoá ngay khi xong (đạt
  hay hỏng), `trap EXIT` là lưới cuối.
- Giải nén `base.tar.gz` + `pg_wal.tar.gz` (`--numeric-owner`), `recovery.signal`,
  `restore_command = gzip -dc /pitr-wal/%f.gz > %p`, `recovery_target_action = pause` (hot standby — đọc được mà không
  promote). **Hai pha trên CÙNG thư mục dữ liệu:** pha TRƯỚC dừng ở (mốc đánh dấu − 1 giây) và đòi nonce VẮNG; dừng
  container; pha SAU phục hồi TIẾP tới mốc yêu cầu và đòi nonce CÓ + bảng lõi có dữ liệu. Docker giả "luôn có dòng đánh
  dấu" ⇒ bài kiểm ĐỎ (phép so không mù).
- Kết quả `status/pitr-drill.json`: OK · PARTIAL (phục hồi được nhưng vế đánh dấu không đo được — thiếu `pitr-mark`, hoặc
  dòng đánh dấu không nằm gọn giữa bản nền và mốc) · FAILED · SKIPPED (thiếu RAM/ổ). Chỉ OK thoát 0.

#### 9.4.5 RPO / RTO sau khi bật

| | Trên máy | Ngoài máy (`gcrypt:pitr/`) | Nguồn |
|---|---|---|---|
| RPO nhà + mọi tổ chức (PITR cấp cụm) | ≤ `archive_timeout` = **15 phút** + vài giây lưu | ≤ 15 + 15 phút (`push-wal`) ≈ **30 phút** + thời gian tải | THIẾT KẾ; số ĐO = `now − last_archived_time` của `pitr-status` — **điền sau bước 4/7** |
| RPO khi lưu WAL hỏng | tăng tới khi sửa — `pitr-status` ĐỎ khi > 30 phút (2 chu kỳ) | như bên trái | THIẾT KẾ |
| RTO phần máy (khôi phục tới một mốc) | giải nén + phục hồi — **CHƯA ĐO: điền dòng `RTO phần máy` của bước 8** | + tải bản nền + WAL từ Drive | ĐO ở bước 8 |
| RTO cả quy trình nhà | runbook §9.4.7 + §10.2 — ƯỚC LƯỢNG 1–2 giờ nếu cụm vài GB | + 30–60 phút khi mất VPS | ƯỚC LƯỢNG |

Bản đêm `pg_dump -Fc` GIỮ NGUYÊN: nó là đường khôi phục CHỌN LỌC (một bảng, một tổ chức) mà PITR cấp cụm không cho, và là
đường lui khi chuỗi WAL đứt.

#### 9.4.6 Phanh và rollback

- **Phanh KHÔNG cần khởi động lại:** ops `pitr-pause` (tạo `/root/backups/pitr/wal/.tam-dung`). Kịch bản lưu WAL trả 0 mà
  không lưu, ghi `.lo-hong.log` ⇒ Postgres thôi dồn WAL, chuỗi PITR ĐỨT từ đó. Chạy lại: `pitr-pause` arg `resume`, rồi
  `pitr-basebackup` (chuỗi mới bắt đầu từ bản nền mới). Tự động cùng cơ chế khi ổ còn < 1.536 MB.
- **KHÁC bản đề xuất cũ — `ALTER SYSTEM SET archive_command = '/bin/true'; SELECT pg_reload_conf();` KHÔNG CÓ TÁC DỤNG ở
  cấu hình này:** tham số truyền bằng `postgres -c` thắng cả `postgresql.conf` lẫn `postgresql.auto.conf` (ALTER SYSTEM),
  nên reload vẫn giữ `archive_command` của dòng lệnh. Đừng dùng nó; dùng cờ ở trên.
- **Rollback cấu hình** (cửa sổ + chủ nền tảng đồng ý): revert commit compose → deploy ⇒ `erp-db` tạo lại với
  `archive_mode = off` (thêm 10–30 giây). Dữ liệu không đổi định dạng. `/root/backups/pitr` xoá tay sau khi không còn cần.
  Lịch `/etc/cron.d/erp-pitr` tự im lặng khi `archive_mode` tắt (bản nền không chạy; `push-wal` chỉ chép tệp đã có).
- Mount hỏng / kịch bản mất (lỗi lưu liên tục, WAL dồn trong `pg_wal`) mà cờ không với tới được: rollback cấu hình ở trên
  là đường duy nhất — theo dõi `pitr-status` + cổng ổ đĩa.

#### 9.4.7 Khôi phục PITR THẬT (runbook, KHÔNG tự động, chủ nền tảng quyết)

Không bao giờ phục hồi đè cụm đang chạy. Luôn dựng cụm TẠM từ bản nền + WAL tới mốc, kiểm, rồi mới thay.

1. Chọn mốc T (giờ UTC) và bản nền mới nhất có `finishedAt` < T (`/root/backups/pitr/base/base-*/nen.json`; mất VPS ⇒
   `rclone copy gcrypt:pitr/base/<bản> …` + `rclone copy gcrypt:pitr/wal …`).
2. Chạy `pitr-drill` với arg = T: nó chứng minh bản nền + WAL tới T khôi phục được (và in RTO phần máy). Đạt thì làm lại
   thủ công với thư mục giữ lại: giải nén như §9.4.4 vào `/root/pitr-khoi-phuc/data`, `recovery_target_time = T`,
   `recovery_target_action = promote`.
3. Khôi phục MỘT tổ chức / một bảng: từ cụm tạm `pg_dump -d erp_org_<mã>` (hoặc `-t bảng`) rồi đi tiếp §5 / `docs/backup-restore.md`.
4. Khôi phục CẢ CỤM nhà: dừng `app` `scheduler` `chatbot` → `ops backup` (dump hiện trạng làm đường lui) → dừng `erp-db` →
   đổi tên volume cũ (không xoá) → chép thư mục dữ liệu đã promote vào volume mới cùng tên → `up -d` → `/api/health` →
   `ops verify` + `smoke` → kéo lại phần hụt từ Pancake / Viettel Post (idempotent). Chủ nền tảng quyết từng bước.

Câu đo trước khi bật (CHỈ ĐỌC, `db-query`, mỗi câu một lượt):

```sql
select name, setting from pg_settings where name in ('wal_level','archive_mode','archive_command','archive_timeout','max_wal_size','checkpoint_timeout','full_page_writes','wal_compression','max_wal_senders');
select datname, pg_database_size(datname) as bytes from pg_database order by 2 desc;
select wal_bytes, wal_fpi, stats_reset from pg_stat_wal;          -- tổng WAL sinh ra từ lần reset thống kê
select pg_current_wal_lsn();                                      -- chạy lại sau đúng 24 giờ, rồi:
select pg_wal_lsn_diff('<lsn lần 2>', '<lsn lần 1>') as wal_bytes_24h;
```

**Dung lượng WAL/ngày: CHƯA ĐO.** `TRAN_KHO_WAL_MB = 8192` là ƯỚC LƯỢNG ban đầu; `archive_timeout = 900` ép tối thiểu 96
đoạn 16 MiB/ngày (1,5 GiB thô, phần trống nén rất nhỏ). Đo `wal_bytes_24h` (bước 0) và cỡ kho WAL sau 1 tuần rồi chỉnh
trần / số bản nền giữ trong một PR.

## 10. Runbook RTO ≤ 4 giờ — thời gian từng bước

RTO tính từ lúc chủ nền tảng quyết định khôi phục tới lúc tổ chức (hoặc nhà) chạy lại được. Cột **Nguồn**: **ĐO** = có
lượt chạy thật; **ƯỚC LƯỢNG** = suy luận, phải thay bằng số đo khi có.

### 10.1 Một tổ chức khách (lệnh: `docs/backup-restore.md` §7; lý do: §5, §8.5)

| # | Bước | Thời gian | Nguồn |
|---|---|---|---|
| 1 | Chủ nền tảng đồng ý; chọn mốc bản (`ops backup-status`, khối tổ chức — bản giờ mới nhất ≤ 1 giờ tuổi) | 10–30 phút | ƯỚC LƯỢNG (người) |
| 2 | `/platform` → tổ chức → SUSPENDED | 1–2 phút | ƯỚC LƯỢNG |
| 3 | `ops backup` — dump hiện trạng làm đường lui | dump 0,4 giây (tổ chức 0,7 MB) + 2–5 phút xếp hàng / SSH của ops | ĐO (dump, CI 36545135985) · ƯỚC LƯỢNG (ops) |
| 4 | Lấy bản: trên VPS (`orgs/<csdl>/hourly/…`) hoặc `rclone copy gcrypt:orgs/<csdl>/hourly/<tệp>` | 0 · 1–5 phút cho < 1 GB | ƯỚC LƯỢNG (băng thông Drive) |
| 5 | `createdb tam_khoiphuc_<mã>` + `pg_restore --no-owner --no-privileges` | 3,6 giây (187 bảng, 356 dòng, dump 729 KB); tỉ lệ với dữ liệu + chỉ mục — vài phút / GB trên máy 2 nhân đang bão hoà | ĐO (CI) · ƯỚC LƯỢNG (cỡ production) |
| 6 | Kiểm ĐÚNG tổ chức (`org_connections.org_code`, thương hiệu, email quản trị) + đối chiếu số dòng | 5–15 phút | ƯỚC LƯỢNG (người) |
| 7 | Ngắt kết nối → đổi tên cũ ⇒ `hong_<mã>_<mốc>` → tạm ⇒ `erp_org_<mã>` | giây (nằm trong 3,6 giây ở bước 5) | ĐO |
| 8 | ACTIVE → mở (tự migrate) → kiểm `/settings/export`, `/settings/connections`, đăng nhập | máy: tới "chạy được" 6,3 giây tổng; người 10–20 phút | ĐO (máy) · ƯỚC LƯỢNG (người) |
| | **Tổng — VPS còn sống** | **máy < 10 phút (tổ chức < 1 GB) · cả quy trình ~1–1,5 giờ** | phần máy ĐO trên tổ chức nhỏ, phần còn lại ƯỚC LƯỢNG |
| | **Tổng — mất VPS** | thêm: dựng VPS mới + deploy (30–60 phút) + tải bản từ Drive + đặt lại `PLATFORM_SECRETS_KEY` (C3) ⇒ **~2–3 giờ** | ƯỚC LƯỢNG — CHƯA diễn tập |

### 10.2 CSDL nhà (VNX) — khôi phục toàn phần (lệnh: `docs/backup-restore.md` §3)

| # | Bước | Thời gian | Nguồn |
|---|---|---|---|
| 1 | Chủ shop đồng ý; chọn bản (`ops backup-status`) | 10–30 phút | ƯỚC LƯỢNG (người) |
| 2 | (nên làm) diễn tập chính bản đó: `ops restore-drill` | = `finishedAt − startedAt` trong `status/last-drill.json` | ĐỌC ĐƯỢC trên máy chủ, **chưa ghi vào tài liệu** — lấy số này trước khi hứa RTO của nhà |
| 3 | Dừng `app` `scheduler` `chatbot` | < 1 phút | ƯỚC LƯỢNG |
| 4 | `erp-backup.sh run` — dump hiện trạng | = thời lượng một bản đêm (`last-run.json`) | ĐỌC ĐƯỢC, chưa ghi vào tài liệu |
| 5 | `dropdb` / `createdb` / `pg_restore` | tỉ lệ cỡ CSDL nhà — **cỡ chưa đo trong kho** (câu `pg_database_size` ở §9.4) | CHƯA ĐO |
| 6 | Khôi phục volume bot chat | < 1 phút | ƯỚC LƯỢNG |
| 7 | `docker compose up -d` → `/api/health` → `ops verify` | 3–10 phút | ƯỚC LƯỢNG |
| 8 | Kéo lại phần hụt (Pancake / Viettel Post — idempotent) | dịch vụ đã chạy lại; dữ liệu hụt ≤ RPO của nhà (≤ 1 ngày) | ngoài RTO dịch vụ |
| | **Tổng** | **ƯỚC LƯỢNG 1–2 giờ nếu CSDL nhà vài GB; mất VPS thêm 30–60 phút** — trong 4 giờ, nhưng CHƯA có số đo nào cho nhà | thay bằng số ĐO của bước 2 + 4 |

Việc để biến ƯỚC LƯỢNG thành ĐO (không gián đoạn, không ghi dữ liệu): (1) đọc `startedAt` / `finishedAt` của
`status/last-run.json` và `status/last-drill.json` (ops `backup-status`); (2) chạy `ops restore-drill` một lượt lúc thấp
điểm; (3) lượt `drill-org-weekly` đầu tiên sau khi có tổ chức thật (launch-gates C1) cho số cỡ production của tổ chức.
