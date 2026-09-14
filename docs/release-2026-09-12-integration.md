# Release 12/09/2026 — gom nhánh dở, đóng vòng hàng hoàn theo món, một lần deploy

Vai trò: Release Coordinator duy nhất. Một nhánh tích hợp, một SHA qua cổng sạch, một lần deploy.

## 1. Tình trạng trước khi tích hợp (fetch 02:10 UTC 12/09)

| Mục | Giá trị |
|---|---|
| Production | `fa34e71` (deploy #236, 18:36 UTC 11/09) — `drizzle.__drizzle_migrations` max id 64 (`0064_bank_balance_zero_is_unknown`) |
| `origin/main` | `af9d664` — hơn production 2 commit: `6cacd0e` phễu chuyển đổi + rủi ro trước giao (migration 0065), `af9d664` docs SQL chỉ-đọc |
| Workflow đang chạy lúc bắt đầu | không (deploy #236 xong; ops #617 `db-query` xong) |
| Production DB trước deploy (ops `db-query` #619, 02:50 UTC) | `__drizzle_migrations` max id **64** · bank_transactions 82 (82 có `bank_ref`) · vận đơn RETURNING/RETURNED chưa kho nhận 950 · return_inspections 0 · phiếu kho RETURN 0 · ai_interactions 20 · shipment_care 2 · care_case_events 8 |
| Production DB (ops `db-query` 02:10 UTC) | bank_transactions 82 · bank_accounts ACTIVE 1 · sepay webhooks FAILED 1 / IGNORED 1 · care IN_PROGRESS 1, WAITING_CUSTOMER 1 · care_case_events UI 7 / AI 1 · ai_interactions OK 16 / ERROR 3 / NEEDS_CONFIRMATION 1 · kiện hoàn chờ kho 759 · return_inspections 0 |

KPI snapshot production TRƯỚC (ops `kpi-snapshot` #618, SHA af9d664 trên máy chủ đang chạy fa34e71):

| Chỉ số | Trước (02:48:38 UTC) |
|---|---|
| Đơn: tổng / giao thành công / hoàn / hoàn theo luật / đang giao / chưa rõ / chưa gửi / huỷ | 2.608 / 432 / 946 / 0 / 317 / 13 / 244 / 656 |
| GTC | 31,3 % |
| Tiền: lên đơn / giao thành công / thực nhận có chứng từ / COD đang chờ | 996.870.498 / 229.785.000 / 212.052.000 / 16.237.000 |
| Quy mô: đơn / vận đơn / sự kiện / việc đang mở / hoàn chờ kiểm đếm | 2.608 / 1.988 / 28.472 / 371 / 530 |

## 2. Phân loại nhánh

| Nhánh | Ahead main | Phân loại | Vì sao |
|---|---|---|---|
| `claude/return-item-inspection` (`f5a9c0b`, chứa `162d5fd`) | 2 | **NEEDS_FINISHING → đã hoàn thiện & gộp** | Kiểm hàng hoàn theo từng món + ghép kiện↔đơn bằng định danh. Thiếu khi nhận: migration đặt trùng số **0064** (production đã dùng cho SePay) và trùng mốc `when`; `expectedQty` ép về 0 khi chưa biết; SLA 3 ngày hard-code; đếm theo món không có giao dịch/khoá (đếm trùng đồng thời cộng tồn hai lần); kiện ORDER_ONLY mặc định "đủ"; hai engine ghép đơn (data-quality tự làm một bản). Mục 3. |
| `claude/return-product-context` (`162d5fd`) | 1 | **ALREADY_INCLUDED** (là commit đầu của nhánh trên) | |
| `claude/fix-care-note-presets` (`b0fca66`) | 1 | **STALE / SUPERSEDED → DROP** | `main d847830` đã có cùng tính năng (cùng khoá `care.notePresets`, cùng dedupe, cùng giới hạn 30). Điểm còn thiếu trên main là **quyền sửa mẫu** — siết ở `58b579a`: người có `shipments:view` chỉ dùng mẫu, `shipments:manage`/admin mới thêm bớt. |
| `claude/sepay-bank-webhook` (`ae229e7`) | 1 | **STALE / SUPERSEDED → DROP** | `main 9c0b30c` + 5 commit SePay sau đó là bản mới hơn và đã production; 4 dòng "thừa" của nhánh là hành vi cũ main đã cố ý sửa (khác mã nhà cung cấp ≠ mâu thuẫn; số dư 0 = chưa biết). Chỉ **xác minh**, không viết lại. |
| `claude/sepay-integration`, `claude/erp-ui-redesign-opus5`, `release/integration-2026-09-11`, `claude/serene-hopper-bsfnnh` | 0 | **ALREADY_INCLUDED** | |
| `perf/p0-reporting-speed`, `claude/release-engineering-p0`, `claude/localhost-erp-test-setup-ugsba4`, `hotfix/vtp-import-recovery`, `claude/vtp-direct-fulfillment-p1`, `claude/erp-data-truth-p0`, `codex/erp-data-truth-p0`, `claude/mb-bank-transaction-app-3am23s`, `claude/fashion-erp-poscake-viettelpost-u97pgx`, `wip/*` | 4–200 | **STALE / SUPERSEDED → DROP** | Không có merge-base với `main` hiện tại (main tiếp quản 10/09); main là siêu tập nội dung, mọi khác biệt là main mới hơn (đã đo 11/09). `wip/*` là ảnh chụp, không phải bản phát hành. |

## 3. Nhánh tích hợp `release/integration-2026-09-12` (từ `af9d664`)

| Commit | Workstream | Nội dung |
|---|---|---|
| `58b579a` | Care note presets | `saveCareNotePresets` yêu cầu `shipments:manage`; nút "Sửa mẫu" ẩn với người chỉ có quyền xem. Test care-workbench khoá mặc định/ghi đè. |
| `feea9de` | Returns (merge) | Gộp `claude/return-item-inspection`; giải quyết xung đột `page.tsx` (lấy `ReceiveQueue` có `ctx` sản phẩm); migration đánh lại **0066_return_inspection_items** (`when` 1789125828546 > 0065). |
| `20db50a` | Returns (hoàn thiện) | `expectedQty` = `null` khi chưa biết (không phải 0); `RECEIVE_SLA_DAYS` vào `lib/constants/return-lifecycle.ts`; đếm theo món chạy trong một giao dịch `SELECT … FOR UPDATE` + lật trạng thái có điều kiện; kiện ORDER_ONLY bắt tick "đã đối chiếu thực tế"; `data-quality` dùng chung `returnProductContext`; test 8b/8c. |
| `c7e424b` | Revenue conversion (an toàn) | Khai `orders_ship_province_idx` trong `db/schema.ts` (migration 0065 đã tạo); `/orders/verify` nêu rõ điểm rủi ro **CHƯA kiểm chứng trên dữ liệu thật** cho tới khi backtest 90 ngày đạt ngưỡng phân biệt. |
| `836ce49` | Returns (đóng vòng) | Đếm nhanh cả kiện cũng khoá một giao dịch (test hai lượt đồng thời ⇒ một phiếu kho); kiện chưa ghép đơn kết luận được bằng số đếm tay; thẻ kiện nói đúng vì sao không có dòng hàng (mã gốc ra nhiều đơn / chưa lần ra đơn). |

Luật hợp nhất: nghiệp vụ / truy vấn / quyền giữ main + Fable; giao diện giữ Opus; AI/Care/UI đã
production không bị chạm (chỉ thêm, không sửa hành vi).

## 4. Mô hình hàng hoàn sau release (`/inventory/returns`)

- **Kiện ↔ đơn** chỉ bằng định danh: `order_id` (DIRECT) → mã gốc của vận đơn chiều về `…1P1` (RETURN_LEG) → nhiều đơn cùng mã gốc = **AMBIGUOUS** (ERP không chọn hộ, hiện "Mã gốc ra nhiều đơn") → UNRESOLVED. **Không bao giờ theo SĐT.**
- **Danh sách món** có căn cứ: `ITEM_EVIDENCE` (order_items.return_quantity > 0) hay `ORDER_ONLY` (chỉ biết đơn; hiện "Chưa xác nhận mặt hàng hoàn", ngăn kéo bắt tick đối chiếu).
- **RECEIVED ≠ INSPECTED**: bấm "Đã nhận" chỉ tạo phiếu `return_inspections` trạng thái RECEIVED, **không** cộng tồn. Chỉ khi đếm xong mới có phiếu kho `RETURN`.
- **RESTOCKABLE vs NON_RESTOCKABLE**: chỉ món kết luận `OK` (theo món) / `RESTOCKABLE` (cả kiện) vào tồn; SHORT/WRONG_ITEM/DAMAGED/DIRTY/UNSELLABLE/OTHER ghi vào `return_inspection_items` kèm lý do bắt buộc, không vào tồn.
- **Chống trùng**: cả hai đường đếm khoá dòng kiện trong một giao dịch; lượt thứ hai nhận "Kiện này vừa được người khác đếm — không ghi lại lần hai" hoặc "đã đếm rồi".
- **Hàng loạt** chỉ áp cho kiện đã tick; "Nhận đủ" hàng loạt = đúng số ERP đã xuất, muốn khác thì đếm từng kiện.

## 5. Cổng phát hành

| Bước | Kết quả |
|---|---|
| Migration DB sạch (PGlite, `ensureMigrated` từ 0) | 0000 → 0066, `verify-migrations` + `migration-journal.test` + `repo-integrity.test` xanh |
| Nâng cấp từ production (mô phỏng: áp 0000–0064 như production rồi chạy bản mới) | áp thêm 0065, 0066; bảng `return_inspection_items`, `conversation_funnel`, index `orders_ship_province_idx` có mặt; chạy lại lần hai không đổi gì (idempotent) |
| `npm test` (cây tích hợp) | **TẤT CẢ KIỂM THỬ ĐẠT** (thêm 8b/8c kiểm theo món, đua hai lượt đếm nhanh, presets quyền) |
| Cổng checkout SẠCH tại `836ce49` (`git worktree add --detach` + `npm ci` + typecheck + lint + test + build) | **GATE_EXIT=0** — TẤT CẢ KIỂM THỬ ĐẠT, build xong |
| QA runtime (Playwright, PGlite demo + kịch bản hàng hoàn dựng riêng) | kiện 1 món · kiện 3 món có 1 món thiếu (1 vào tồn, cờ lệch, ghi lý do) · kiện ORDER_ONLY (nút khoá tới khi tick đối chiếu) · kiện mơ hồ `QADUP1P1` (SL "—", không suy số, kết luận bằng số đếm tay) · Hỏng không lý do bị chặn · tab cũ bấm lại bị chặn · 9 trang (/, /operations, /orders, /shipments, /inventory, /cod, /bank, /reports, /returns) **0 lỗi console / hydration** · ngăn kéo AI Copilot hiện "AI chưa được cấu hình" khi thiếu khoá |
| Đối chiếu sổ sau QA | phiếu kho chỉ có ở kiện OK/RESTOCKABLE (1 + 1 + 2 món); kiện DAMAGED và kiện mơ hồ **không** có phiếu kho; `return_inspection_items` giữ dòng SHORT kèm lý do |

## 6. Deploy

| Bước | Kết quả |
|---|---|
| Cổng trước deploy | `origin/main` fast-forward `af9d664 → 836ce49` (không có commit mới nào chen vào giữa lúc kiểm và lúc đẩy); không workflow nào đang chạy |
| `Deploy ERP to VPS` #237 (run 34668788463) | **success** 02:51 → 03:03 UTC. Trên runner: toàn vẹn kho mã · typecheck · lint · test · build · image `ghcr.io/truyenhkm5group-stack/hkt:836ce49…` · VPS pull + bootstrap · "✓ https://erp.vnxcommerce.com đang chạy đúng commit 836ce493b211" |
| Sau deploy (ops `db-query` #620, 03:04 UTC) | `__drizzle_migrations` max id **66** (64 → 66: 0065 phễu, 0066 return_inspection_items) · bảng `return_inspection_items` có mặt (0 dòng) · index `orders_ship_province_idx` có mặt · bank_transactions **82 = 82** (không nhân đôi) · return_inspections 0 · phiếu kho RETURN 0 · shipment_care 2 / care_case_events 8 (không đổi) · ai_interactions 21 (+1 do sử dụng thật) · vận đơn hoàn chưa kho nhận 951 (+1, dữ liệu ĐVVC sống) |
| KPI snapshot SAU (ops `kpi-snapshot`) | #621, 03:05:18 UTC (17 phút sau bản TRƯỚC, dữ liệu sống vẫn đổ về): đơn 2.611 / GTC 433 / hoàn 947 / hoàn theo luật **0** / đang giao 315 / chưa rõ 13 / chưa gửi 247 / huỷ 656 · GTC 31,4 % · tiền lên đơn **996.870.498 (= trước)** / GTC 230.309.000 (+1 đơn vừa giao) / thực nhận có chứng từ **212.052.000 (= trước)** / COD chờ 16.761.000 · vận đơn 1.988 (= trước) · sự kiện 28.484 (+12 webhook) · việc mở 377 · hoàn chờ kiểm đếm **530 (= trước)**. Mọi chênh lệch đều là dữ liệu mới (đồng bộ Pancake +3 đơn, webhook VTP +12 sự kiện), không có chỉ số nào nhảy do đổi công thức |
| Smoke (ops `smoke`) | #622, 03:05–03:08 UTC: **39/39 màn hình đạt · 0 lỗi ứng dụng · 0 sai quyền · 0 hết phiên**. `/inventory/returns` 44 ms (1,2 MB — 750+ kiện kèm bối cảnh sản phẩm). Một màn hình chậm sẵn có: `/ads` 5,8 s (ngoài phạm vi release này, cần việc riêng) |
| AI (ops `ai-check`) | #623, 03:09–03:10 UTC: **AI PRODUCTION: HEALTHY**. provider openai, khoá configured (không in); routing routine→gpt-5.6-luna / copilot→gpt-5.6-terra / analysis→gpt-5.6-sol đúng model API trả về (1,2–1,4 s/chat); read tool `get_care_queue_summary` trên dữ liệu thật 4,4 s; case care `get_care_case` 6,0 s; write tool `add_care_note` dừng ở NEEDS_CONFIRMATION, người khác / thiếu quyền / token lạ đều bị từ chối, `care_case_events` 8 → 8; timeout / 429 / model sai ⇒ ERROR có nhật ký; `ai_interactions` 21 → 27, không có chuỗi giống khoá trong log |
| Rollback | KHÔNG cần. Nếu cần: chạy `Deploy ERP to VPS` với SHA `fa34e71` (image vẫn còn trên GHCR); migration 0065/0066 chỉ thêm bảng/index, không phá lược đồ cũ. |

## 7. Việc còn lại cho chủ shop (P0 trước, không tự làm)

1. **Kiện mơ hồ (AMBIGUOUS)**: ERP cố ý không chọn đơn; cần đường "gắn đơn tay" có audit cho CS. Hiện kho vẫn đếm được bằng số đếm tay, hàng không vào tồn (đúng luật) — cần quyết định ai được gắn.
2. **Món "Sai hàng"**: đã ghi `actual_variant_id` nếu người đếm chọn, nhưng giao diện chưa có ô chọn mẫu mã thực nhận — hàng sai vẫn không vào tồn (đúng), chỉ chưa biết nó là mẫu nào.
3. **Báo cáo thất thoát hàng hoàn** từ `return_inspection_items` (thiếu / hỏng / sai theo mẫu mã, theo tuần) — bảng đã có dữ liệu, chưa có trang.
4. **`RECEIVE_SLA_DAYS = 3`** là ngưỡng nghiệp vụ mới (kiện ĐVVC báo về quá 3 ngày mà kho chưa nhận = quá hạn). Đặt ở `lib/constants/return-lifecycle.ts`, cần chủ shop chốt.
5. **Điểm rủi ro trước giao**: chưa kiểm chứng trên dữ liệu thật (banner trên `/orders/verify`); chỉ dùng để tham khảo cho tới khi backtest 90 ngày đạt ngưỡng.
6. **Swap trên VPS** (1,9 GB, 0 swap): build đã chuyển sang GitHub Actions nhưng app + Postgres vẫn sát ngưỡng; nên thêm 2 GB swap.
7. Bảng giá `gpt-5.6-*` chưa có trong `estimateCostUsd` ⇒ chi phí AI hiện "chưa biết" thay vì đoán; điền khi có bảng giá chính thức.
