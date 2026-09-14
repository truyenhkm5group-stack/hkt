# Release 12/09/2026 (vòng 2) — sáu nhánh worker, một SHA qua cổng sạch, một lần deploy

Vai trò: Release Lead duy nhất. Không mở feature mới. Mỗi nhánh được **đối chiếu trên production bằng
ops `db-query` (chỉ đọc)** trước khi quyết gộp / gộp có điều kiện / bỏ.

## 1. Tình trạng trước khi tích hợp (fetch 05:35 UTC 12/09)

| Mục | Giá trị |
|---|---|
| Production | `836ce49` (deploy #237) — `/api/health` qua ops `status` #624: `{"commit":"836ce493b211","branch":"main"}` |
| `origin/main` | `83493cd` — hơn production đúng 1 commit docs (biên bản vòng 1) |
| Workflow đang chạy lúc bắt đầu | không |
| Sáu nhánh ứng viên | đều **1 commit** trên `83493cd` (cùng base, không nhánh nào tụt) |

KPI snapshot production TRƯỚC (ops `kpi-snapshot` #625, 05:39:34 UTC):

| Chỉ số | Trước |
|---|---|
| Đơn: tổng / giao thành công / hoàn / hoàn theo luật / đang giao / chưa rõ / chưa gửi / huỷ | 2.628 / 438 / 957 / 0 / 300 / 13 / 264 / 656 |
| GTC | 31,4 % |
| Tiền: lên đơn / giao thành công / thực nhận có chứng từ / COD đang chờ | 999.616.498 / 232.835.000 / 212.052.000 / 19.287.000 |
| Quy mô: đơn / vận đơn / sự kiện / việc đang mở / hoàn chờ kiểm đếm | 2.628 / 1.988 / 28.668 / 409 / 530 |

## 2. Quyết định từng nhánh (theo thứ tự tích hợp)

| # | Nhánh | Quyết định | Căn cứ production (ops `db-query`, chỉ đọc) |
|---|---|---|---|
| A | `claude/erp-quality-guards` (`94366cd`) | **GỘP có sửa** | Nhánh xoá hai bài kiểm `return-item-inspection` / `return-product-context` đang có trên main (worker tưởng là feature dở) — khôi phục khi gộp. Bỏ 2 import thừa (lint `--max-warnings=0`). Ba guard mới không chạm runtime nghiệp vụ: trùng tên helper/metric trong `lib/queries` (báo NEW, 20 trùng cũ ghi ở `KNOWN_DUPLICATES`, KHÔNG gộp metric trong vòng này), số hiệu migration không tái dùng, ranh giới logistics/tiền (chỉ cảnh báo). Hai mục deferred (auth-session-timeout, exact-tested-SHA) không chặn: SHA đúng đã được `deploy-vps.yml` ghim `github.sha` qua tsc/lint/test/build rồi mới SSH. |
| B | `claude/bank-account-operations` (`b699241`) | **GỘP nguyên** | Đúng base main. Giữ đủ: nhiều tài khoản, UNCONFIRMED/ACTIVE/DISABLED, bộ lọc `account` ở sổ giao dịch, "chưa phân loại" theo từng tài khoản, mốc `sepay_reconcile` gần nhất (job có thật: 15 lượt SUCCESS, lượt cuối 05:08 UTC), việc actionable `BANK_ACCOUNT_UNCONFIRMED` (có cờ bật/tắt, merge mặc định qua `lib/alerts/config.ts`), quyền `bank:accounts` ≠ `bank:write`. Không đụng `sepay-ingest.ts`. Production hôm nay: 1 tài khoản `ACTIVE/SEPAY/MBBank`, 0 UNCONFIRMED ⇒ không sinh việc giả. |
| C | `claude/ads-decision-performance` (`5a55ccb`) | **GỘP + 5 sửa hợp đồng chỉ số** | Audit: kết quả đơn đi qua `ORDER_OUTCOME_FAST`/bảng dẫn xuất, không có điều kiện stage/COD riêng; `bookedRevenue` tách khỏi `deliveredRevenue`, lợi nhuận góp chỉ dùng delivered; không suy giao từ tiền; cấp nhóm/mẩu QC trả `null` (ad_spends không có adset_id/ad_id), không chia đều; 3 cổng dữ liệu (chi ≥ 300K, ≥ 10 đơn kết thúc, ≥ 60 % ngã ngũ) trước mọi SCALE/HOLD/WATCH/CUT. Sửa: (1) cước theo bậc thang Sự thật tài chính (đã giao + hoàn + `return_fee`), bản đầu cộng `partner_fee` của cả đơn huỷ/chưa gửi; (2) giá vốn cấp mã hàng dùng bậc thang chung (phiếu nhập ERP trước); (3) thẻ "tiền chưa kết luận" đếm hai lần chiến dịch không có đơn; (4) `?dim=toString` vỡ trang; (5) ngưỡng màu hard-code ở client. Thêm: dùng chung `spendPeriod` của ads-roas, đổi tên `PID`. |
| D | `claude/inventory-capital-decision` (`e6a9305`) | **GỘP ở trạng thái DỮ LIỆU CHƯA ĐỦ (BETA)** | 41 mẫu mã · 30 có phiếu nhập (73 %) · **0/41 có sổ kho đủ 14 ngày** (toàn bộ phiếu nhập trong 2 tuần gần nhất) · giá nhập theo phiếu 28 · đơn SX SENT 0 · cấu hình `inventory.planning` chưa khai · nhịp bán 25/41, 24 đủ tin. Phân bố xấp xỉ bằng SQL: DATA_INSUFFICIENT 13 · HOLD 13 · REORDER 3 (30 cái) · STOCKOUT_RISK 12 (727 cái) nhưng 10/12 có khả dụng ÂM vì hàng xuất trước khi có phiếu nhập ⇒ số "cần đặt" không đáng tin. Engine chỉ đọc (không insert/update, trang không có nút tạo PO/sửa tồn). Thêm cổng `DECISION_RULE.gate` (tồn ≥ 80 %, giá ≥ 80 %, sổ kho đủ 14 ngày ≥ 50 %): không đạt ⇒ banner "DỮ LIỆU CHƯA ĐỦ" + lý do; đạt ⇒ vẫn "BETA". Backtest 30 ngày trên production rỗng (chưa có phiếu nhập nào 30 ngày trước). |
| E | `claude/fulfillment-bottleneck` (`0ed6eb5`) | **GỘP + loại đơn rỗng** | NOT_YET_SHIPPED 126 (62,7 tr; 99 quá 24 h; 45 quá 7 ngày) · AWAITING_PICKUP 72 (44,2 tr; 16 quá 7 ngày; tất cả PACKING có mã VTP, sự kiện mới nhất "102 Đơn hàng chờ xử lý" ngày 12/09, WEBHOOK_ONLY ⇒ hàng thật chưa rời kho) · DATA_BLOCKED 16 (6,9 tr) · AWAITING_CARRIER_ACCEPT 0. Tuổi theo `orders.last_update_status_at`: 0/214 thiếu mốc, mẫu PACKING trùng `time_send_partner`, mẫu CONFIRMED trùng lúc xác nhận ⇒ đúng nghĩa. Sai dương: 9/214 (4 %) đơn CONFIRMED không dòng hàng, giá trị 0 ⇒ loại trong SQL + kiểm thử `fb-don-rong`. |
| F | `claude/bang-ke-nhip-tim` (`ab74dd9`) | **GỘP** (fix health thật) | `sync_runs`: `vtp-statement-mail` 25 SUCCESS + 11 FAILED (lượt cuối 09/09 07:53 UTC), `sepay_reconcile` 15 SUCCESS — trong khi thẻ BANK trên main truyền cứng `null` ⇒ "Chưa chạy lần nào" là SAI. `vtp_statement_files`: 18 tệp, mốc nhận = mốc đọc = 70 giờ trước, 16 tệp từng được nhập lại. Không có cách phân biệt "VTP chưa gửi bảng kê" với "script Gmail đã tắt" ⇒ thêm nhịp tim (`sync_state`, không ghi `sync_runs`), tách hai nửa bảng kê / SePay. Không chạm SePay ingest, không overlap tệp với B. |

Nhánh KHÔNG đưa vào vòng này (không phải ứng viên, đã phân loại ở biên bản vòng 1): `claude/sepay-bank-webhook`,
`claude/fix-care-note-presets`, `claude/return-*`, `perf/*`, `wip/*`, các nhánh không có merge-base với `main`.

## 3. Nhánh tích hợp → `main` = `2a51d89` (từ `83493cd`, 18 commit, giữ theo workstream để rollback)

| Commit | Workstream | Nội dung |
|---|---|---|
| `599a3c5` + `cf04647` | A guards | merge (khôi phục hai bài kiểm hàng hoàn theo món) + bỏ import thừa |
| `2b0929a` | B bank | merge nguyên |
| `d6058f2` + `0468fa6` + `647533c` | C ads | merge + 5 sửa hợp đồng chỉ số + dùng chung `spendPeriod` |
| `d6e1913` | F bank sync health | merge nguyên |
| `d492957` + `c7cc0ca` | E fulfillment | merge + loại đơn rỗng |
| `12bc824` + `84272ac` | D inventory | merge + cổng dữ liệu BETA / DATA_INSUFFICIENT |
| `2a51d89` | guard | đổi tên `classify` → `classifyBottleneck`, `DAY_MS` → `MS_PER_DAY` (guard trùng tên bắt được sau khi gộp E, D) |

Xung đột duy nhất: `tests/sync-fixtures.test.ts` (khối guard cuối `main()` ↔ `testFulfillmentBottleneck`) — giữ cả hai,
bài fulfillment chạy trước khối guard.

## 4. Cổng sạch (worktree detach `../wt-gate`, `npm ci`, đúng SHA `2a51d89`)

| Bước | Kết quả |
|---|---|
| `tests/repo-integrity.test.ts` | 703 tệp · 2053 import · mọi đích đến đã vào kho · sổ migration 66 mục, max idx 66, không thêm mục mới |
| `tsc --noEmit` | 0 lỗi |
| `eslint --max-warnings=0` | 0 lỗi 0 cảnh báo |
| `npm test` | **TẤT CẢ KIỂM THỬ ĐẠT** (guard mới: 650 định nghĩa / 615 tên, 20 trùng cũ đã khai; ranh giới logistics/tiền: 18 dòng cảnh báo — chỉ advisory) |
| `npm run build` | thành công (có tuyến `/inventory/decisions`, `/operations/fulfillment`) |

Lần chạy cổng đầu trên `84272ac`: mọi kiểm thử nghiệp vụ đạt, guard trùng tên đỏ vì `classify`/`DAY_MS` ⇒ `2a51d89`.
Kiểm thử `conversion-funnel` (Date.now) KHÔNG đỏ ở cả hai lần — không cần sửa.

## 5. QA runtime cục bộ (bản dựng production `next start`, PGlite, dữ liệu demo 1.126 đơn, Playwright Chromium)

23 trang mở bằng phiên đăng nhập thật, HTTP 200, **0 lỗi console**: `/`, `/operations`, `/operations/fulfillment`
(5 đơn kẹt, 2 trễ hạn, hàng đợi xếp trễ hạn trước), `/orders`, `/shipments`, `/inventory`, `/inventory/returns`,
`/inventory/decisions` (banner DỮ LIỆU CHƯA ĐỦ: tồn 0 %, sổ kho 0 %), `/bank` (3 tab), `/ads` (3 cấp; bảng
quyết định NO_SPEND/INSUFFICIENT với dữ liệu demo), `/reports` (lợi nhuận), `/reports/cashflow`, `/reports/returns`,
`/cod`, `/products/performance`, `/customers`, `/integrations`, `/alerts`. Ghi chú: `/reports/profit` không tồn tại
(báo cáo lợi nhuận là `/reports`). `scripts/smoke.ts` không chạy được song song với server trên PGlite
(một tiến trình) — thay bằng smoke production sau deploy.

## 6. Hiệu năng /ads (scripts/bench/ads.ts, PGlite, --scale=3, 3.959 đơn)

| Phép đo | Trước (main, worker đo) | Sau (nhánh tích hợp, đo lại) |
|---|---|---|
| Phần người dùng CHỜ | 552,5 ms / 39 câu | **27,5 ms / 3 câu** |
| `getAdsDecision(campaign)` | — | 32,1 ms / 3 câu |
| `getAdsPerformance` (sau Suspense) | 506 ms / 33 câu | 506 ms / 33 câu (không đổi, streaming) |
| Cả trang | 552,5 ms / 39 câu | 587 ms / 42 câu |

## 7. Deploy #238 = `2a51d89` (06:19 → 06:31 UTC 12/09) — một lần, đúng SHA đã qua cổng

| Bước trong workflow | Kết quả |
|---|---|
| repo-integrity · tsc · eslint · npm test · next build (trên đúng `github.sha`) | xanh |
| Image GHCR `hkt:2a51d89a…` · VPS pull · khởi động lại app + scheduler | xong 06:28:05 |
| Đối chiếu sổ migration với CSDL thật | sổ 66 · CSDL đã áp 66 · không có migration mới trong vòng này |
| Smoke production (đăng nhập thật) | **40/40 đạt** · 0 lỗi ứng dụng · 0 sai quyền · 0 chậm — có `/inventory/decisions` (mới), `/bank`, `/ads`, `/operations` |
| Kiểm tra kết nối | Pancake ✓ · Viettel Post ✓ · Facebook Ads ✓ · Pancake Pages ✗ (mã 121 — gói cước, có từ trước) · AI Copilot ✓ |
| `/api/health` từ ngoài | `{"ok":true,"commit":"2a51d89a20a5","branch":"main"}` |

Production SHA: **`836ce49` → `2a51d89`**.

## 8. KPI parity (ops `kpi-snapshot`, cùng công thức, production đang chạy sync trực tiếp)

| Chỉ số | Trước (#625, 05:39:34 UTC, SHA 836ce49) | Sau (#638, 06:33:55 UTC, SHA 2a51d89) | Nhận xét |
|---|---|---|---|
| Đơn tổng / GTC / hoàn / hoàn theo luật / đang giao / chưa rõ / chưa gửi / huỷ | 2.628 / 438 / 957 / 0 / 300 / 13 / 264 / 656 | 2.633 / 438 / 960 / 0 / 297 / 13 / 269 / 656 | +5 đơn mới, +43 sự kiện vận đơn đến trong 54 phút (đang giao → hoàn 3); không đổi công thức |
| GTC % | 31,4 | 31,3 | theo tử số/mẫu số mới |
| Tiền lên đơn | 999.616.498 | 1.000.015.498 | +399.000 = 5 đơn mới |
| Tiền giao thành công | **232.835.000** | **232.835.000** | = |
| Thực nhận có chứng từ | **212.052.000** | **212.052.000** | = |
| COD đang chờ | **19.287.000** | **19.287.000** | = |
| Vận đơn / sự kiện / việc đang mở / hoàn chờ kiểm đếm | 1.988 / 28.668 / 409 / 530 | 1.988 / 28.711 / 420 / 530 | việc mở +11 do job cảnh báo chạy giữa chừng |

Ba con số tiền đã xác minh và số hoàn chờ kiểm đếm KHÔNG đổi; mọi chênh lệch còn lại là dữ liệu mới về
trong lúc đo, không phải do mã. Sổ ngân hàng: 82 giao dịch trước = 82 sau (mục 9).

## 9. QA production sau deploy (ops `db-query` #639, smoke trong deploy #238)

**Sổ ngân hàng nhiều tài khoản.** `bank_accounts`: 1 tài khoản `SEPAY / MBBank ******5264 / "MBBank 9972165264" / ACTIVE`,
gói tin gần nhất 06:08:19 UTC · 2 giao dịch gắn tài khoản (0 chưa phân loại, vào 4.000₫) · lượt `sepay_reconcile`
gần nhất 06:08:19 UTC (đúng mốc màn hình sẽ hiện) · 0 việc `BANK_ACCOUNT_UNCONFIRMED` đang mở (không có tài khoản
chờ xác nhận ⇒ đúng là không sinh việc) · tổng sổ **82 = 82** dòng trước/sau (80 dòng nhập sao kê tay có
`bank_account_id = NULL` — đúng thiết kế "sao kê tay không thuộc tài khoản SePay", bộ lọc "Tài khoản" chỉ áp cho dòng
đã gắn). Smoke `/bank` HTTP 200 (57 ms). Không mở được trình duyệt tới production từ máy tích hợp (proxy chặn
egress tới erp.vnxcommerce.com) ⇒ QA giao diện /bank làm trên bản dựng production cục bộ (3 tab, 0 lỗi console) +
smoke đăng nhập thật trên production.

**/ads production.** Smoke trước (#237) `/ads` 110 ms · 598 kB → sau (#238) **88 ms · 2.404 kB**. Thời gian máy chủ
giảm, nhưng HTML/RSC to gấp 4: bảng quyết định cấp chiến dịch đưa toàn bộ dòng (tháng này có **454 chiến dịch** có chi,
709 dòng chi, 443 đơn gắn ad_id, 139 fb_ads) xuống client. Đây là chi phí hydration mới — ghi ở mục 11 (P1), không
phải lỗi số liệu.

**perf-probe production sau deploy (#640).** Câu chậm nhất của trang /ads vẫn là độ phủ quy kết (`ads-attribution-coverage`,
927 ms; EXPLAIN 1,7 s) — CÓ TỪ TRƯỚC, nay nằm sau ranh giới Suspense nên không còn chặn lần vẽ đầu. Bảng quyết
định (3 câu) không lọt vào tám câu chậm nhất.

## 10. Guard mới có hiệu lực trong `npm test` (chạy cả ở deploy)

| Guard | Loại | Bắt được gì trong chính vòng này |
|---|---|---|
| `tests/duplicate-metrics.test.ts` | chặn (tên MỚI), báo cáo (20 trùng cũ) | `spendPeriod`/`PID` (ads-decision ↔ ads-roas/profit-nominal), `classify`/`DAY_MS` (fulfillment ↔ integration-health, inventory-decision ↔ purchasing) — đã sửa bằng dùng chung/đổi tên, KHÔNG gộp metric |
| `tests/repo-integrity.test.ts::testMigrationNumberUnique` | chặn | 66 mục, max idx 66; cảnh báo 2 mục thứ tự sổ ≠ số hiệu (0041/0042, lịch sử) |
| `tests/logistics-status-boundary.test.ts` | chỉ cảnh báo | 18 dòng kết hợp logistics + tiền (ORDER_OUTCOME cần cả hai) |
| `docs/GUARDRAILS.md` | tài liệu | 15 guard, 2 mục deferred (auth-session-timeout, exact-tested-SHA — SHA đúng đã do deploy-vps.yml ghim) |

Bên cạnh đó: `tests/ads-decision.test.ts`, `tests/inventory-decision.test.ts`, `tests/fulfillment-bottleneck.test.ts`
(+ ca đơn rỗng), `tests/bank-accounts.test.ts` (mở rộng), `tests/vtp-health.test.ts` (nhịp tim) vào `npm test`.

## 11. Việc còn lại thật sự (sau release)

| Mức | Việc | Vì sao |
|---|---|---|
| P1 | `/ads` HTML/RSC 598 kB → 2,4 MB trên production (454 chiến dịch tháng này vào bảng quyết định) | Máy chủ nhanh hơn (110 → 88 ms) nhưng trình duyệt phải hydrate gấp 4 dữ liệu — cần phân trang/gộp nhóm INSUFFICIENT_DATA phía máy chủ. Không phải lỗi số liệu. |
| P1 | Quyết định vốn tồn kho đang ở DỮ LIỆU CHƯA ĐỦ | Sổ kho ERP mới 2 tuần, 10/12 mẫu "nguy cơ hết hàng" có khả dụng âm — cần chủ shop kiểm kê đầu kỳ (phiếu ADJUSTMENT) và khai `inventory.planning` (lead time, MOQ). |
| P1 | Nút thắt rời kho: 118 đơn "đã chốt chưa có vận đơn" (45 quá 7 ngày, 62,7 tr) + 72 "có mã VTP chưa lấy hàng" (16 quá 7 ngày, 44,2 tr) | Số thật, cần kho/CSKH xử lý; nếu đây là thông lệ (chốt trước, sản xuất sau) thì chủ shop quyết ngưỡng SLA khác cho NOT_YET_SHIPPED. |
| P2 | Script Gmail bảng kê chưa báo nhịp tim (thẻ BANK sẽ ghi "chưa từng báo sống") | Cần chủ shop dán đoạn `baoSong()` theo docs/GMAIL-BANG-KE-VTP.md; lượt cuối script gửi tệp là 09/09 07:53 UTC. |
| P2 | `ads-attribution-coverage` 0,9–1,7 s trên production | Có từ trước; nay không chặn vẽ đầu nhưng vẫn là câu chậm nhất của trang. |
| P2 | 80/82 dòng sổ ngân hàng chưa gắn `bank_account_id` (nhập sao kê tay) | Đúng thiết kế hiện tại; nếu muốn lọc theo tài khoản cho cả sao kê tay thì cần khai tài khoản "sao kê tay" và gắn khi nhập. |

Không có P0 mở: kết quả đơn, ba con số tiền, hoàn chờ kiểm đếm, sổ ngân hàng đều bằng trước/sau; contract test
ORDER_OUTCOME xanh; production chạy đúng SHA đã kiểm.
