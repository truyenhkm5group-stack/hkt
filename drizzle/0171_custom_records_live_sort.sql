-- 0171 · HAI INDEX XẾP HẠNG CHO BẢN GHI TUỲ BIẾN CÒN SỐNG (docs/platform/phase-11-12-plan.md §H2 — kết quả H2).
--
--  · ĐO TRƯỚC, THÊM SAU (scripts/platform-load-probe.ts, 20.000 hợp đồng + 5.000 bản ghi đối tượng khác cùng bảng,
--    15 lượt, trung vị): index có sẵn `custom_records_object_idx (object_key, deleted_at, updated_at)` KHÔNG phục vụ
--    được phép xếp `updated_at desc nulls last, id` của `/o/<khoá>` (thứ tự NULLS và khoá phụ không khớp) nên mỗi
--    trang phải xếp lại cả đối tượng:
--      `custom_records_live_updated_idx` — listRecords trang 1: 36,9 → 15,5 ms và 41,8 → 15,3 ms (hai lượt đo);
--        trang 100: 39,8 → 32,8 ms; lọc jsonb trạng thái (5.000 dòng khớp): 94,7 → 51,4 ms.
--      `custom_records_live_created_idx` — bảng x_… trên trang động (xếp `created_at desc nulls last, id desc`):
--        26,4 → 15,2 ms; kanban 200 thẻ: 34,9 → 23,6 ms.
--  · ĐÃ ĐO VÀ KHÔNG THÊM: GIN `jsonb_path_ops` trên `custom_values.values` — lọc bằng trạng thái 94,7 → 94,3 ms,
--    lọc một khách (10/20.000 dòng) 77,3 → 82,7 ms, KPI đếm 40,5 → 48 ms: không nhanh hơn, chỉ thêm giá ghi.
--  · Index MỘT PHẦN (`where deleted_at is null`) đúng mệnh đề `recordScopeSql` / `liveWhere` mà mọi đường đọc đã mang.
--  · CHỈ THÊM, không đổi dữ liệu. Viết tay và idempotent như các migration trước.

CREATE INDEX IF NOT EXISTS "custom_records_live_updated_idx" ON "custom_records" ("object_key", "updated_at" DESC NULLS LAST, "id") WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_records_live_created_idx" ON "custom_records" ("object_key", "created_at" DESC NULLS LAST, "id" DESC) WHERE "deleted_at" is null;
