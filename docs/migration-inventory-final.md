# Kiểm kê migration — đối chiếu kho mã với production

Đo ngày 09/09/2026 bằng ops `db-query` trên `drizzle.__drizzle_migrations` của production.
**Trạng thái CSDL production là thẩm quyền cuối cùng**, không phải tên file hay số hiệu.

## Kết luận

**44/44 migration trong kho đã được áp trên production. Không thiếu bản nào, không trùng bản nào,
không có bản nào bị bỏ qua.** Mọi băm nội dung đều khớp.

## Cách drizzle quyết định áp hay bỏ qua

`node_modules/drizzle-orm/pg-core/dialect.cjs`:

```js
select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
...
if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { ...áp... }
```

Nghĩa là: **chỉ áp migration có `when` LỚN HƠN `created_at` của bản áp gần nhất.** Không so theo số
hiệu, không so theo tên, không so theo băm. Một mục thêm vào sổ với mốc cũ hơn sẽ **không bao giờ**
được áp trên CSDL đã chạy — kiểm thử vẫn xanh vì CSDL kiểm thử dựng mới từ đầu.

## Ràng buộc bắt buộc cho migration TIẾP THEO

```
Mốc áp gần nhất trên production = 1788945578898  (2026-09-09 16:19:38 giờ VN)
```

> **Mọi migration mới phải có `when` > 1788945578898.**
> Nhỏ hơn hoặc bằng ⇒ bị bỏ qua vĩnh viễn, và không có gì báo lỗi.

`npm run db:generate` lấy mốc theo đồng hồ hiện tại nên tự thoả điều kiện. Chỉ nguy hiểm khi có người
sửa tay mốc trong sổ.

## Đối chiếu chi tiết 6 bản gần nhất

| Bản trên production | `created_at` | Khớp file trong kho | `when` trong sổ | Ghi chú |
| ---: | ---: | --- | ---: | --- |
| 39 | 1788839390150 | `0039_marketing_ideas` | 1788839390150 | khớp |
| 40 | 1788839391150 | `0038_fb_ads_post_link` | 1788839391150 | khớp |
| 41 | 1788839392150 | `0043_return_inspections` | 1788839392150 | khớp |
| 42 | 1788945576898 | `0042_bank_ledger` | 1788945576898 | khớp |
| 43 | 1788945577898 | `0044_cost_authority` | 1788945577898 | khớp |
| 44 | 1788945578898 | `0041_shipment_return_leg_index` | **1788940601682** | **mốc trong sổ khác mốc đã ghi khi áp** |

### Về dòng 44

`0041_shipment_return_leg_index` **đã được áp** (băm khớp tuyệt đối). Nhưng sổ trong kho hiện ghi
`when = 1788940601682`, còn production ghi `created_at = 1788945578898` — tức là mốc trong sổ **đã bị
sửa sau khi bản đó được áp** (commit `2d09a60`, để cứu chính nó khỏi bị bỏ qua).

**Không được sửa lại.** Lý do: bản đó đã áp rồi, và nếu nâng mốc trong sổ lên trên 1788945578898 thì
drizzle sẽ **áp LẠI** nó. Để nguyên thì mốc trong sổ nhỏ hơn mốc áp gần nhất ⇒ không bao giờ chạy
lại. Đây là trạng thái an toàn.

Với CSDL dựng mới từ đầu, thứ tự áp đọc theo mảng trong sổ nên vẫn đúng.

## Thứ tự trong sổ (10 mục cuối)

| # mảng | Tệp | idx | `when` |
| ---: | --- | ---: | ---: |
| 35 | `0034_perf_indexes` | 34 | 1788839386150 |
| 36 | `0035_manual_verification_source` | 35 | 1788839387150 |
| 37 | `0036_expense_cost_allocation` | 36 | 1788839388150 |
| 38 | `0037_action_queue_workflow` | 37 | 1788839389150 |
| 39 | `0039_marketing_ideas` | 39 | 1788839390150 |
| 40 | `0038_fb_ads_post_link` | 40 | 1788839391150 |
| 41 | `0043_return_inspections` | 43 | 1788839392150 |
| 42 | `0041_shipment_return_leg_index` | 41 | 1788940601682 |
| 43 | `0042_bank_ledger` | 42 | 1788945576898 |
| 44 | `0044_cost_authority` | 44 | 1788945577898 |

Số hiệu file **không** theo thứ tự áp (0043 áp trước 0041). Đó là kết quả của bốn phiên làm việc song
song, và **cố ý không sửa** — đổi tên file là tạo mục mới và drizzle sẽ áp lại. Thứ tự đọc được nằm ở
cột `when`, không ở tên file.

`tests/migration-journal.test.ts` khoá: mọi mục có tệp · mọi tệp có mục · `when` **tăng nghiêm ngặt**
theo thứ tự mảng · số hiệu trùng không được tăng thêm (đang có 1 ca lịch sử: idx 32).

## Va chạm số hiệu đã biết

| Số hiệu | Tệp | Xử lý |
| --- | --- | --- |
| 0032 | `0032_webhook_dedupe` + `0032_marketing_ideas` | Ca lịch sử, cả hai đã áp đúng một lần. **Không đổi tên.** Bản `marketing_ideas` sau đó được đánh lại thành `0039`. |
| 0040 | không có tệp nào | idx 40 thuộc về `0038_fb_ads_post_link` sau khi sửa mốc. Bình thường. |

## Migration trên các nhánh cũ

| Nhánh | Migration | Xử lý |
| --- | --- | --- |
| `claude/fashion-erp-poscake-viettelpost-u97pgx` | không có | 1 commit đã thu hồi, không chạm `drizzle/` |
| `claude/mb-bank-transaction-app-3am23s` | không có | sản phẩm độc lập trong `hkt/`, không phải ERP |
| `hotfix/vtp-import-recovery` | không có | nội dung đã có trong `main` |
| `wip/*` | không có | ảnh chụp cây làm việc |

**Không có migration nào nằm ngoài `main`.**
