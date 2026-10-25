# ODOO-INSPIRED ERP TRANSFORMATION — tệp tiến độ bền

> **Đây là tệp tiến độ DUY NHẤT của chương trình.** Phiên nào nhận việc của chương trình thì đọc tệp này
> trước, và cập nhật bảng nhiệm vụ (mục 5) trong CHÍNH PR của việc đó. Không chép trạng thái sang nơi
> khác. Sổ `/tech` (`ai-control/registry`) giữ khoá và lease; tệp này giữ **vì sao · làm gì · tới đâu**.

| | |
|---|---|
| Chủ shop giao | 23/10/2026 |
| Integration Lead | phiên `code-erp-11` (mở PR · cổng · gộp · deploy) |
| Người giữ tệp tiến độ | phiên `cc2379e4` (Lead giao 23/10/2026). Phiên khác KHÔNG mở PR tài liệu riêng cho tệp này: gửi trạng thái cho người giữ tệp. |
| Phase 1 (discovery) | sứ mệnh `odoo-upgrade-phase1-audit`. CHỈ TÀI LIỆU, một PR. |
| Mốc kho lúc khảo sát | `main` = `eedfc7a38` (#992). Production = `6644a3cbc09a` (#989, đo `/api/health` 23/10/2026 06:13Z), sau đó lên `eedfc7a389a1` lúc 06:40Z. |

---

## 1. Mục tiêu tổng

Đưa VNXcommerce ERP lên mức trưởng thành của một ERP đóng gói ở những chỗ **thật sự đang đau**
(kho · mua hàng · lịch hẹn và phân việc · quy trình tự động · chế độ xem), bằng cách **học thiết kế
nghiệp vụ** của Odoo. Không chuyển sang Odoo và không viết lại. Mỗi bước là một PR nhỏ đi đủ vòng:
kiểm thử → deploy → xác minh trên production.

Thước đo thành công: số chỉ số đang `UNAVAILABLE` giảm vì có nguồn THẬT (không phải vì đổi nhãn), số
thao tác tay ở kho và mua hàng giảm, và không có luật nào trong `AGENTS.md` bị phá.

## 2. Sáu nguyên tắc

> Sáu nguyên tắc này được dựng từ bản giao việc của Lead và các luật đang chạy trong `AGENTS.md`. Nếu bản
> gốc của chủ shop khác, sửa ở đây trước rồi mới làm việc tiếp.

1. **Học thiết kế, không mang mã về.** Chỉ đọc tài liệu công khai `odoo.com/documentation`. Không chép mã
   Odoo, và tuyệt đối không lấy mã hay tài liệu riêng của Odoo **Enterprise**. Mỗi ý tưởng ghi nguồn URL.
2. **Không viết lại, không chuyển nền tảng.** Ý tưởng nào cũng phải đáp xuống một tệp, bảng hoặc tuyến
   đang có. "Odoo có module X" không phải lý do để dựng module X.
3. **Luật nghiệp vụ đứng trên ý tưởng.** Các luật sau không thương lượng, kể cả khi Odoo làm khác:
   - `ORDER_OUTCOME`, `docs/business-rules/ORDER_OUTCOME.md` và AGENTS mục 0–3;
   - NULL = chưa biết;
   - hàng hoàn chỉ vào tồn qua phiếu RETURN;
   - một nguồn cho một khoản chi.
4. **PR nhỏ, đủ vòng.** Mỗi PR có kiểm thử khoá hành vi, typecheck, lint và `npm test` đạt. PR chạm số
   liệu thì đo production trước/sau (AGENTS 6.5). Việc chỉ xong khi đã deploy và xác minh.
5. **Có nhu cầu mới làm.** Mỗi hạng mục phải trỏ tới một lỗ hổng CÓ BẰNG CHỨNG trong kho (đo production,
   chỉ số `UNAVAILABLE`, mục registry). Module chưa có nhu cầu thì ghi "khảo sát trước", không dựng.
6. **Máy đề nghị, người quyết.** Tự động hoá mới mặc định `DRAFT` / chạy thử / tắt (AGENTS 23, 25). Không
   tự ghi vào tiền và tồn kho (`RISK_FLOOR`). Ngưỡng và đích là quyết định của chủ shop (AGENTS 7, 38).

## 3. Scope đã duyệt

| Trong scope | Ngoài scope (không làm, trừ khi chủ shop mở) |
|---|---|
| Phase 1: tệp này. Audit 12 nhóm module, đưa sẵn các việc P0 vào bảng, đề xuất thứ tự Phase 2–5. | Chuyển dữ liệu sang Odoo, dùng Odoo song song, hay cài Odoo Community làm hệ phụ. |
| Phase 2–5 + nhánh UI/UX & tốc độ: từng PR nhỏ theo §7 (Lead đã duyệt thứ tự 23/10/2026). Thay đổi thứ tự hay thêm mục phải qua Lead. | Sổ cái kế toán kép, hoá đơn VAT, kế toán pháp định. ERP là kế toán QUẢN TRỊ (mục 6.4). |
| | Sản xuất nội bộ (work order, routing). Shop thuê xưởng ngoài, xem mục 6.5. |
| | Bất kỳ đổi ngưỡng, quyền hay lịch scheduler nào chưa qua chủ shop (AGENTS mục 7). |

## 4. Trạng thái

| Bước | Trạng thái | Ghi chú |
|---|---|---|
| Phase 1: discovery | `IN_REVIEW` khi PR này mở | Tệp này. |
| Phase 2–5 + nhánh UI/UX | `BACKLOG` (thứ tự ĐÃ DUYỆT) | Lead duyệt §7 ngày 23/10/2026: Phase 2 rủi ro thấp trước, không chạm `ORDER_OUTCOME` / tiền, SKIP có lý do. Thêm nhánh «UI/UX & tốc độ» (§7.2) chạy song song Phase 2 và đi TRƯỚC Phase 3. |

Vòng đời một nhiệm vụ: `BACKLOG → READY → IN_PROGRESS → IN_REVIEW → MERGED → DEPLOYED → VERIFIED → DONE`.
Thêm hai nhánh rẽ: `BLOCKED` (ghi blocker) và `CANCELLED` (ghi lý do). `DONE` chỉ khi đã xác minh trên
production.

## 5. Bảng nhiệm vụ

Quy ước cột:

- **Deploy** = SHA đã nằm trong commit production (`/api/health`).
- **Xác minh** = đã đối chiếu trên production sau deploy. "—" nghĩa là chưa ghi vào tệp này; tra
  `/tech` hoặc PR, không suy ra là đã xác minh.
- **Owner** = phiên hoặc vai trò, không phải tên người (AGENTS 22).

### 5.1 Việc P0 đang chạy / đã xong (đưa sẵn vào chương trình, trạng thái đo 23/10/2026)

Đo lúc 06:13Z, production `6644a3cbc09a` chứa mọi SHA dưới đây có ghi "DEPLOYED". Lead báo 06:40Z:
production lên `eedfc7a389a1` (#992, run 39911382774, verify PASS), nên #990 cũng đã lên theo.

| Task ID | Module | Mục tiêu | Owner | Ưu tiên | Trạng thái | PR | SHA | Test | Deploy | Xác minh | Blocker | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P0-VTP-1 | Vận đơn | Vận đơn tạo lại trên web VTP gắn về đúng đơn (lần gửi kế) thay vì mồ côi | worker VTP | P0 | DEPLOYED | #979 | `f87db2e0b` | trong PR | ✓ | — | — | Lead ghi xác minh |
| P0-VTP-2 | Vận đơn / KQ đơn | Kết quả đơn đọc lần gửi còn sống. Đơn Pancake huỷ mà lần gửi thay thế đang đi thì không còn là huỷ. | `code-erp-56` | P0 (CRITICAL: `ORDER_OUTCOME`) | IN_REVIEW (PR mở) | #981 | — | trong PR | ✗ | — | Chủ shop gộp PR CRITICAL | Review + gộp |
| P0-VTP-3 | Vận đơn | Script vá 330 vận đơn tạo lại về đơn gốc (chạy thử + `--apply`) | worker VTP | P0 | DEPLOYED | #982 | `6041f7f0d` | trong PR | ✓ | — | Phụ thuộc #981 (phiên bản KQ ≥ 5, #988) | Chạy `--apply` sau #981 |
| P0-VTP-4 | POS Pancake | Ops `pos-reship-link`: gắn mã vận đơn tạo lại vào khối partner đơn POS | worker VTP | P0 | IN_REVIEW (PR mở) | #980 | — | trong PR | ✗ | — | — | Review + gộp |
| P0-VTP-5 | Tháp giao vận | 501 trên chặng hoàn vào rổ «hoàn đã về shop» | phiên này | P1 | DEPLOYED · VERIFIED | #989 | `6644a3cbc` | care-states 15 · delivery-tower | ✓ | ✓ verify PASS (run 39898884835) | — | — |
| P0-VTP-6 | Tháp + care | Chặng RETURNED thắng chữ «đã giao»/«đang hoàn» (TS+SQL), xoá bản vá `entry.ts:97`. Production đo trước = sau: 0 kiện đổi rổ. | phiên này | P2 | DEPLOYED · VERIFIED | #992 | `eedfc7a38` | care-states 25 · delivery-tower · đột biến | ✓ (run 39911382774, 06:40Z) | ✓ verify PASS | — | — |
| P0-ADDR-1 | Bot bán hàng | Khách đã cho phường thì đơn nhận phường; bỏ câu «nhân viên sẽ xác nhận lại địa chỉ» | worker sales | P0 | DEPLOYED | #966 | `705f954cf` | trong PR | ✓ | — | — | — |
| P0-ADDR-2 | Bot bán hàng | AGENTS 3.12b: không hỏi lại địa chỉ đã gửi; đơn chờ xác minh địa chỉ vẫn chốt + mời mua thêm | worker sales | P0 | DEPLOYED | #972 | `f53d1883d` | trong PR | ✓ | — | — | — |
| P0-ADDR-3 | Bot bán hàng | Máy ánh xạ địa chỉ nền (PR-B) | worker sales | P0 | DEPLOYED | #973 | `15d62efc7` | trong PR | ✓ | — | — | — |
| P0-ADDR-4 | Bot bán hàng | Câu máy tự soạn (qtyAck · roundCheck · serverCancel) không xin lại địa chỉ | worker sales | P0 | IN_REVIEW (PR mở) | #991 | — | trong PR | ✗ | — | — | Review + gộp |
| P0-QTY-1 | Bot bán hàng | Quantity/Unit Guard: số không đơn vị không phải số hộp; sửa đơn tăng bất thường thì chuyển người | worker sales | P0 | DEPLOYED | #968 | `eb615ec19` | trong PR | ✓ | — | — | — |
| P0-QTY-2 | Bot bán hàng | 2B `PACK_MULTIPLIER_LEAKED`: số hộp = số trần khách nói | worker sales | P0 | DEPLOYED | #975 | `63303e94f` | trong PR | ✓ | — | — | — |
| P0-PAY-1 | Lương | Quỹ thưởng % LN: trần theo tháng + người nhận phần còn lại | worker lương | P0 | DEPLOYED | #957 | `67a7f74bc` | trong PR | ✓ | — | — | — |
| P0-PAY-2 | Lương | Thực nhận không còn «—» vì số tạm tính không ai trả | worker lương | P0 | DEPLOYED | #965 | `bf31f3ad1` | trong PR | ✓ | — | — | — |
| P0-PAY-3 | Lương | Job `payroll-owner-apply` thực hiện quyết định lương 22/10 | worker lương | P0 | DEPLOYED | #967 | `2d588c630` | trong PR | ✓ | — | Lượt chạy job do Lead/ops | Ghi run id job |
| P0-PAY-4 | Lương | Sổ lỗ cá nhân: tháng làm việc đầu có số dư đầu kỳ 0 (gỡ chặn chốt lương 08/2026) | worker lương | P0 | DEPLOYED | #971 | `9564c65f2` | trong PR | ✓ | — | — | — |
| P0-REG-1 | Tech / chất lượng | Lỗi 2B đã sửa mà tái diễn tự MỞ LẠI (`REGRESSION_REOPENED` + chặn DONE) | worker tech | P1 | DEPLOYED | #977 | `351068ef7` | trong PR | ✓ | — | — | — |
| P0-REG-2 | Tech / chất lượng | `regression-watch-status` đọc được mọi tổ chức | worker tech | P1 | DEPLOYED | #984 | `d6165a7d9` | trong PR | ✓ | — | — | — |
| P0-RET-1 | Hàng hoàn | Bộ lọc khối lý do hoàn (nguồn đơn · nhân viên care · ĐVVC · bưu cục · tỉnh · trạng thái) | worker báo cáo | P1 | DEPLOYED | #960 | `e09383f7a` | trong PR | ✓ | — | — | — |
| P0-AI-GD3 | Bot bán hàng | GĐ3: xếp lời nhắc cho đệm tiền tố. Công tắc `sales.prompt-layout`, mặc định `LEGACY` (chưa bật). | phiên này | P1 | DEPLOYED (tắt) | #987 | `3cc4b3c99` | hoán vị golden · bench `--layout` | ✓ | — | Bench 3 × 0,2 USD chỉ Lead dispatch | Lead chạy bench rồi quyết bật |

### 5.2 Nhiệm vụ của chương trình (Phase 1–5)

Chi tiết từng hạng mục Phase 2–5 ở mục 7.

| Task ID | Module | Mục tiêu | Owner | Ưu tiên | Trạng thái | PR | SHA | Test | Deploy | Xác minh | Blocker | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OD-P1-01 | Toàn chương trình | Tệp tiến độ bền + audit 12 nhóm module + lộ trình | `cc2379e4` | P2 | DONE | #995 | `db264b9d3` | chỉ tài liệu | — (chỉ tài liệu) | — | — | — |
| OD-P2-01 | Dashboards / Views | Bộ lọc yêu thích (favorites) theo người dùng cho `DataTable` | — | P3 | HOÃN | — | — | — | — | — | Chưa có bằng chứng nhu cầu | **Lead quyết 23/10: HOÃN.** `page_visit_daily` chỉ có `page_key`, không có chuỗi query ⇒ không đo được ai lặp lại bộ lọc. `/shipments` ≈ 3 lượt/ngày. Giá: migration + đụng `DataTable` dùng chung + build. Mở lại khi có số lượt dùng bộ lọc. |
| OD-P2-02 | Purchase | `suppliers` thành khoá thật cho đơn xưởng (thôi ô chữ) | — | P3 | BACKLOG | — | — | — | — | — | — | **Hạ ưu tiên (Lead 23/10):** ROI ≈ 0 tới khi shop dùng đặt xưởng trong ERP (production_orders CSDL nhà = 1 dòng CANCELLED 25/09). |
| OD-P2-03 | Purchase | Thời gian giao của xưởng đọc `production_orders.received_at` thay vì ghép phiếu nhập | phiên purchasing | P1 | DEPLOYED | #998 | `cceb5e4bd863` | `tests/purchasing.test.ts` (mốc thật thắng · ước tính có nhãn · mốc mâu thuẫn đếm riêng) · ops `purchasing-leadtime-probe` (#996) | ✓ (health d864b3332b2c) | — | — | **0 lô dữ liệu, tính năng chưa được dùng** (run 39943865920, db-query 39944299981). VERIFIED ở lượt deploy kế. |
| OD-P2-04 | Manufacturing | Định mức vải lên máy chủ (thôi `localStorage`), MM-REC-26 | `cc2379e4` | P1 | CANCELLED | — (không mở PR) | `04c30ab7` ở `wip/od-p2-04-fabric-norms` | `tests/fabric-norms.test.ts` · npm test đạt | — | — | — | **DỪNG — 7 lượt/30 ngày, 0 thao tác** (db-query Lead 23/10: `/inventory/shortage` 7 lượt trong 5 ngày; 0 lần `STOCK_SHORTAGE_DECISION`). Mã giữ ở nhánh wip; mở lại khi có người dùng đều. |
| OD-P2-05 | Activities | Hẹn việc kế tiếp hiện trên trang chi tiết đơn/vận đơn/khách (phép chiếu, không bảng mới) | — | P2 | BACKLOG | — | — | — | — | — | — | — |
| OD-UX-01 | UI/UX | Design system tối thiểu: token + quy tắc loading/empty/error. Kiểm hiện trạng trước, không đổi đồng loạt. | — | P1 | BACKLOG | — | — | — | — | — | Số nền của `code-erp-56` | Phần **error đã có** (§7.2): không làm PR «error.tsx từng route». Còn token + loading/empty. |
| OD-UX-02 | UI/UX | Sidebar gom theo nghiệp vụ, đọc `department-modules.ts` | — | P1 | BACKLOG | — | — | — | — | — | Số nền của `code-erp-56` | — |
| OD-UX-03 | UI/UX | Chỉ báo «cập nhật lúc / nguồn / trễ đối tác» cho màn hình số liệu | `code-erp-56` | P1 | DEPLOYED | #1001 | `4f4d098cb` | TEST_KHOI K01 · K03 · K04 · K06 · K07 · K11 · K15 · K17 · K18 | ✓ (run 39961732491, health d864b3332b2c) | chờ ảnh production | — | `/shipments` + `/reports/returns` xong. Bằng chứng tạm (db-query 39966275866): bảng kê COD cuối 23/10 03:08Z · Pancake SUCCESS cuối 14:00Z · webhook cuối 14:02Z. GTC + lương ở vòng sau. |
| OD-UX-03b | UI/UX | Thẻ «Đồng bộ dữ liệu» CẢNH BÁO khi tệp «Danh sách vận đơn» lâu không nhập (trước chỉ in mốc) | `code-erp-56` | P1 | IN_REVIEW | (PR của nhánh `claude/od-ux-03b-webhook-gap` @ `10790f9809f9`) | — | TEST_KHOI K06 · K15 | — | — | — | Lead đổi thành làm NGAY 23/10. Thẻ trên `/shipments` + `/reports/returns` in «Chỗ hụt webhook: chưa đo từ <mốc> (N ngày) — nhập tệp Danh sách vận đơn để đo», có lối bấm `/import-vtp`. Hổ phách theo `VTP_ORDER_LIST_MAX_AGE_HOURS` (24 giờ, đã khai ở feed-freshness, không gõ số mới). Kèm tỷ lệ khớp webhook ↔ tệp 30 ngày (mẫu < 30 ⇒ «chưa đủ mẫu»), không tô màu. Căn cứ db-query 39966275866: APPLY tệp cuối 02/10/2026 08:13Z ⇒ 3 tuần không có phép đo (AGENTS 51). |
| OD-UX-04 | UI/UX | KPI bấm được xuống dữ liệu cấu thành (`/reports/returns`, trang chủ) | `cc2379e4` | P1 | DEPLOYED | #1006 (chủ shop gộp 25/10) | `ead92882e` (commit gộp) | `tests/returns-kpi-drill.test.ts` (K01): 144 phép so — số thẻ y hệt bản trước refactor · danh sách = thẻ ở 8 nhóm × 3 mốc × 3 kỳ × 2 ô tìm · phân trang; đột biến vị từ «chờ phát lại» ⇒ đỏ · npm test · build | ✓ health `ead92882 · run 40181186535 · 09:56:39Z 25/10` | — · ảnh production trước/sau CHƯA CHỤP (cần phiên Chrome 9222 của chủ shop) | — | `/reports/returns` xong. Trang chủ ở PR sau. |
| OD-UX-05 | Tốc độ | Tối ưu 2–3 trang chậm nhất theo số nền, có đích đo được | nhiều phiên | P1 | IN_PROGRESS | xem 05.1–05.4 | — | — | — | — | — | Căn cứ từng mục ở §5.4. |
| OD-UX-05.1 | Tốc độ | `/orders` + `/shipments`: dải số tổng tắt JIT | `code-erp-56` | P1 | DEPLOYED | #1008 | `4a92d9206` | `tests/trang-cham-jit.test.ts` | ✓ run 40011916149 | ✓ perf-probe sau deploy: `orderSummary` 3.275 → 143 ms · `shipmentSummary` 4.078 → 132 ms (đích < 500); smoke `/orders` 1.590 ms (25/10) | — | — |
| OD-UX-05.2 | Tốc độ | `/work`: hàng đợi không chạm hạn, đệm ấm | `code-erp-56` | P1 | DONE (đường ẤM) | #1016 · #1018 · #1021 · #1025 · #1035 · #1037 | `4816be1b4` · `0e93a57fa` … | trong PR | ✓ | ✓ probe ấm #1035: toàn trang 70 ms, mọi nguồn ≤ 17 ms; smoke 25/10 1.344 ms (≤ 2 s) | Đường NGUỘI sau mỗi lần xoá đệm còn mở | Đo lại sau #1036 + #1037 |
| OD-UX-05.3 | Tốc độ | Trang chủ: khử trùng đọc khoá cấu hình theo request | `code-erp-56` | P2 | DEPLOYED (đích KHÔNG đạt nhờ mục này) | #1033 | `4eeb7751f` | trong PR | ✓ | Chỉ bớt khoảng 1 lượt (6 lượt / 5 khoá) ⇒ đích −30 % KHÔNG đạt nhờ cái này | — | — |
| OD-UX-05.3b | Tốc độ | Đối soát lương · bảng lương · `/ads` · `/work` đọc cấu hình theo phạm vi | `code-erp-56` | P1 | DEPLOYED | #1037 | `0e93a57fa` | trong PR | ✓ `6ca3af26` | ✓ `getReconCenter` 202 → 18 lượt / 10 khoá · `getMyWork` 17 → 12 · `getPayrollReport` 15 → 9 · `getAdsPerformance` 11 → 6 | — | — |
| OD-UX-05.3c | Tốc độ | Hai đường đọc thô (xác nhận trọng số mã · chữ ký đối soát) qua `readSettingValue` | `code-erp-56` | P1 | DEPLOYED | #1043 | `7d59abf7` (commit gộp) | K06 · K10 · K14 · K24 | ✓ run 40086846234 · health `5d4997bb` (11:13:45Z 24/10) | — CHƯA đo riêng sau #1043 (số 202 → 18 lượt của `getReconCenter` là đo sau #1037) | — | Đo `getReconCenter` sau #1043 — đích ≈ 10–12 lượt / 10 khoá |
| OD-UX-05.4 | Tốc độ | `/reports/returns`: thân nguội (câu lý do hoàn ×3 → ×1 · `careRows` chỉ kiện có care) + hồi quy đường ấm (đệm theo tổ chức) | `cc2379e4` | P1 | DEPLOYED (đích ≥ 40 % ĐẠT sau 05.4b + 05.4c — Lead chốt) | #1030 · #1036 | `65883e6be` · `6ca3af26b` | `tests/returns-body.test.ts` · `tests/memo-org-scope.test.ts` | ✓ `6ca3af26` | Riêng mục này — smoke cùng công cụ: 12.556 → 8.347 ms (−34 % so lượt 1 nền; −23 % so trung bình nền 10,8 s); ấm 618 ms. Sau 05.4b + 05.4c: xem hai dòng dưới | — | `with don` ×2 trong `getReturnRateByVariant` chỉ khi probe thấy nó trên đường găng |
| OD-UX-05.4b | Tốc độ | `/reports/returns`: KPI hiện trước — mỗi khối một `<Suspense>`, thẻ đồng bộ gọi `vtpWebhookHealth` một lần; probe thêm mốc «KPI hiện» + phép đo câu nhỏ chờ bể | `cc2379e4` | P1 | DEPLOYED · VERIFIED | #1065 (+ probe #1063) | `5ff9266a8` | build · K06 · K08 · K12 · K21 | ✓ `5ff9266a` (11:18Z 25/10) | ✓ returns-page-probe, 1 mẫu mỗi bên: lượt 1 nguội KPI hiện 11.491 → 4.219 ms (−63 %), thân 11.672 → 7.407; kỳ 30 ngày KPI 6.604 → 6.120 (−7 % — KPI xếp hàng, xem 05.4c); ấm ~0,3 s | — | Đích (Lead 25/10): «thời gian tới khi thấy KPI»; đầu phản hồi là chỉ số phụ |
| OD-UX-05.4c | Tốc độ | `/reports/returns`: KPI khởi chạy TRƯỚC 7 nhánh nặng (chờ KPI hoặc trần 800 ms), câu đếm ‖ dự báo PRODUCT song song — sau cờ `reports.returns-kpi-first` | `cc2379e4` | P1 | DEPLOYED · cờ BẬT | #1073 (+ đo #1067 · #1069 · #1071 · #1075) | `1ba755032` · `7aaa60f26` | `tests/returns-kpi-first.test.ts` (bật / tắt ⇒ cùng dữ liệu, so nguyên khối 17 trường · cờ hỏng ⇒ TẮT) | ✓ `1ba75503` (15:54Z 25/10) · cờ bật 18:27Z 26/10, giữ từ 18:49:05Z | ✓ xen kẽ: probe 1d KPI 2.366 → 686 ms (−71 %), cả trang ×1,06 (< 1,10); HTTP kỳ 30 ngày dữ liệu nguội — KPI 4.728 · 8.127 → 3.217 · 3.610 ms, thân 7.317 · 9.190 → 3.544 · 5.230 ms; ấm như nhau (185–290 ms) | — | Tắt bằng `set-setting reports.returns-kpi-first {"on":false}` nếu số người dùng xấu đi; cờ đệm 30 s |
| OD-UX-06 | UI/UX | Kiểm mobile cho 5 màn hình dùng nhiều | — | P2 | BACKLOG | — | — | — | — | — | Số nền của `code-erp-56` | — |
| OD-P3-01 | Inventory | Phiếu kiểm kê (đếm thực tế vs sổ) ⇒ mở được `inventory_accuracy` | — | P1 | BACKLOG | — | — | — | — | — | Chủ shop chốt cách kiểm kê (§7.6) | — |
| OD-P3-02 | Inventory | Kiểm kê xoay vòng (cycle count) theo nhóm mẫu mã | — | P2 | BACKLOG | — | — | — | — | — | Phụ thuộc OD-P3-01 | — |
| OD-P3-03 | Purchase | Trạng thái thanh toán của đơn xưởng (chưa / chờ / đủ), đối chiếu đặt – nhận – trả | — | P3 | BACKLOG | — | — | — | — | — | — | **Hạ ưu tiên (Lead 23/10):** ROI ≈ 0 tới khi shop dùng đặt xưởng trong ERP (production_orders CSDL nhà = 1 dòng CANCELLED 25/09). Cùng áp cho OD-P3-03b (§7.3). |
| OD-P3-04 | Purchase / QC | Kiểm hàng nhập từ xưởng (đạt/lỗi) trước khi vào tồn | — | P3 | BACKLOG | — | — | — | — | — | Khảo sát quy trình kho | **Hạ ưu tiên (Lead 23/10):** ROI ≈ 0 tới khi shop dùng đặt xưởng trong ERP (production_orders CSDL nhà = 1 dòng CANCELLED 25/09). |
| OD-P4-01 | Workflow | Trigger theo thời gian + điều kiện trước/sau cho `lib/workflow` | — | P2 | BACKLOG | — | — | — | — | — | — | — |
| OD-P4-02 | Approvals | Nối 3 nhóm duyệt còn thiếu (sửa COD · ghi đè ĐVVC · ngân sách QC) | — | P2 | BLOCKED | — | — | — | — | — | Production có 2 tài khoản (enforcement OFF) | Chủ shop quyết |
| OD-P4-03 | Payroll | Kế hoạch hoa hồng có vòng đời Nháp → Duyệt (đã duyệt không sửa) | — | P2 | BLOCKED | — | — | — | — | — | `COMMISSION_BASIS_NEEDS_REVIEW`: chủ shop chốt cơ sở | — |
| OD-P5-01 | Subscriptions | MRR · churn · gia hạn cho nền tảng SaaS | — | P3 | BACKLOG | — | — | — | — | — | — | — |
| OD-P5-02 | Manufacturing | Khảo sát BOM / định mức đầy đủ (chỉ tài liệu) | — | P3 | BACKLOG | — | — | — | — | — | — | — |
| SRC-P0 | Sourcing (AI China Fashion Sourcing) | P0 nghiên cứu: audit ERP tái dùng · nguồn dữ liệu hợp lệ có bằng chứng · thiết kế dữ liệu / truy vấn tiếng Trung / giá về VN / chấm điểm / duyệt · lộ trình P1–P4 (SRC-1…SRC-8) · blocker B1–B5 — chi tiết `docs/tech/ai-sourcing.md` | `code-erp-95` | P1 | IN_REVIEW | (PR này) | — | chỉ tài liệu | — | — | B1/B2 (quyền dùng dữ liệu 1688 / bên thứ ba) chặn P2–P3; P1 cần B3–B5 | Lead gộp; chủ shop trả lời B1–B5 |

### 5.3 Bảng làm việc nhỏ (việc vặt phát hiện trong lúc khảo sát, không thuộc phase nào)

| Task ID | Việc | Bằng chứng | Trạng thái | Ghi chú |
|---|---|---|---|---|
| OD-MISC-01 | `AGENTS.md` dùng số mục **70 hai lần**: «đơn chờ hàng là kết quả phân bổ» và «thưởng % lợi nhuận đi qua cổng lỗ lũy kế». | `AGENTS.md:573` và `AGENTS.md:672` | BACKLOG | Lead 23/10: KHÔNG sửa AGENTS lượt này. Đánh số lại phải giữ nguyên MỌI chỗ đang trích "AGENTS 70" (grep cả `lib/`, `docs/`, `tests/`). |
| OD-MISC-02 | Khối drill «đơn của mẫu mã» trên `/reports/returns` (`?variant=`) in SĐT khách cho MỌI người có `reports:returns`, không gác quyền xem đơn. | `app/(dashboard)/reports/returns/page.tsx` (khối `variantOrders`) | IN_REVIEW | PR riêng `returns-drill-phone-gate`: SĐT chỉ hiện khi có `orders:read` (chuẩn bảng đơn), thiếu quyền in «— (cần quyền xem đơn)». THU HẸP, không mở quyền (luật 30). Theo bộ quyền MẶC ĐỊNH không vai trò nào mất; production phải đo vì vai trò có mảng ghi đè. |

### 5.4 Bằng chứng đo của nhánh tốc độ (OD-UX-05)

Số đo lấy từ log ops của Lead (`code-erp-11`); máy chủ 2 nhân, nên mọi số nguội phải đọc cùng tải lúc đo. Bảng §5.2 giữ
trạng thái; mục này giữ căn cứ (chuyển từ nhật ký tạm §7.2.1 ngày 25/10/2026, sau khi #1006 vào `main`).

**OD-UX-05 mục 1 · `/orders` + `/shipments`: dải số tổng tắt JIT — DONE.** #1008 `4a92d9206`, owner `code-erp-56`,
deploy run 40011916149 (health `c7d87cb0`, 23/10 19:59Z). perf-probe nguội, trung vị:

| Câu | Trước | Sau | Đích |
|---|---|---|---|
| `orderSummary` | 3.275 ms | 143 ms | < 500 ms |
| `shipmentSummary` | 4.078 ms | 132 ms | < 500 ms |
| smoke `/orders` | 8.930 / 8.990 ms | 1.028 / 2.050 ms | < 2 s |

EXPLAIN xen kẽ JIT bật ↔ tắt: 10.907 ↔ 168,6 ms và 5.382 ↔ 59,6 ms. `/shipments` không hồi quy (902 ms ở lượt máy
rảnh). Chốt bằng `tests/trang-cham-jit.test.ts`.

**OD-UX-05 mục 2 · `/work` (owner `code-erp-56`) — DONE ở đường ẤM (Lead chốt 24/10).** Căn cứ: `getReconCenter` nguội 22,5 s, 857 câu, giữ 3,1–3,7 trên 5
kết nối của bể; ba nguồn chạm hạn chậm ở cả 3/3 lượt nguội.

| Việc | PR | Trạng thái |
|---|---|---|
| Hàng đợi báo «thiếu nguồn» thay vì «Không còn việc nào» khi một phần nguồn chưa có số | #1016 `bfc3e4a9f` | MERGED |
| perf-probe liệt kê từng câu của ba nguồn chạm hạn | #1018 `e5a2cb026` | MERGED |
| `PAYROLL_RECON` chỉ đọc đệm; job giữ ấm là đường tính duy nhất | #1021 `7c081caea` | MERGED |
| Ba khoá riêng của `/work` giữ số CŨ khi người dùng ghi; `clearMemoAll` cho nút «Làm mới số liệu» | #1025 `4816be1b4` | MERGED |
| perf-probe đo lại từng nguồn của `/work` khi đệm đã ấm | #1035 `4ee3c8f2e` | MERGED |
| Đối soát lương / bảng lương / `/ads` / `/work` đọc khoá cấu hình theo phạm vi (thôi xin 202 lần kết nối cho 10 khoá) | #1037 `0e93a57fa` | MERGED |

Bằng chứng DONE (perf-probe khối ấm, #1035, `perf2410/probe-work-am.log`): `/work` toàn trang ấm 70 ms · 603 việc · không
nguồn nào chạm hạn hay lỗi · mọi nguồn ≤ 17 ms. Trước đó: smoke `/work` 1,8–4,9 s, 3–4/14 nguồn chạm hạn 2,5 s.

Còn mở (ngoài phần DONE): chi phí NGUỘI sau mỗi lần xoá đệm, và tập nền dùng chung (kết quả theo vận đơn · danh mục mẫu
mã · doanh thu đơn). Đo lại sau khi #1036 (đệm theo tổ chức) và #1037 đã lên production.

**OD-UX-05 mục 3 · trang chủ:** khử trùng `getSettingJson` theo request — #1033 `4eeb7751f` MERGED. Đo: chỉ bớt được
khoảng 1 lượt đọc (6 lượt cho 5 khoá) ⇒ đích −30 % KHÔNG đạt nhờ thay đổi này. Owner `code-erp-56`.

**Hạ tầng đo và giao dịch (owner `cc2379e4`):**

| Việc | PR | Ghi chú |
|---|---|---|
| Trong một giao dịch các câu chạy nối tiếp (bỏ `Promise.all` trên client của `chayKhongJit`) | #1013 `d143c7143` | MERGED |
| Một giao dịch = một client: `theoClient` + lá chắn lúc chạy (`ERP_TX_GUARD=1` chỉ bật trong bộ kiểm thử) + lương / bảng tên tính trước giao dịch | #1020 `0002422cf` | MERGED. Lá chắn bắt thêm đường `dimensionKeys → marketerNames → getDb` mà máy quét mã nguồn bỏ sót. |
| Ops `returns-page-probe`: đo vòng sự kiện bị chặn + đầu phản hồi thật (chỉ đọc) | #1015 `219e916ad` · #1019 `89d931e57` | MERGED |
| Deploy làm ấm 8 trang nặng NGAY sau health, TRƯỚC smoke | #1024 `321f70901` | DEPLOYED. Làm ấm chạy 42,7 s trong lượt deploy `c6968e7e`. |
| perf-probe liệt kê câu bên trong các hàm nặng của `/reports/returns` | #1026 `2aad88b48` | MERGED |

**`/reports/returns`: số nền và hai phép đo đầu phản hồi.**

Số nền: đo 23/10 17:05–17:35Z (`code-erp-56`), 5 lượt perf-probe nguội + 2 lượt smoke, tải máy 1,70 → 3,00 trên 2
nhân, lấy trung vị:

| Phép đo | Giá trị |
|---|---|
| `getReturnIntelligence` | p50 7.294 ms (max 9.284) |
| `getReturnRateByVariant` | 3.776 ms |
| `getReturnRateSummary` | 3.264 ms |
| `getReturnReasonReport` | 1.780 ms |
| smoke, tổng | 12.556 / 9.016 ms |
| smoke, đầu phản hồi | 3.787 / 3.341 ms |
| kích thước trang | 694 kB |

`settings where key=$1` tốn 2.389 ms trong `getReturnIntelligence`: đó là chờ bể kết nối, không phải câu chậm.

Đầu phản hồi, hai lượt đo:

| Lượt | Lượt 1 sau khởi động | Module ấm, dữ liệu nguội (`?period=30d`) | Ấm cả hai |
|---|---|---|---|
| returns-probe-2 | đầu 5.559 ms | đầu 1.026 ms | đầu 285 ms |
| returns-probe-4 (sau `c6968e7e` có làm ấm, tải 3,0–3,5) | đầu 4.390 · thân 12.882 ms | đầu 2.643 · thân 9.470 ms | đầu 228 · thân 446 ms |

Đọc của Lead: TTL đệm dữ liệu (90–120 s) đã hết khi probe tới, mà đầu phản hồi vẫn 4,4 s ⇒ «chỉ do nạp module» chưa
đủ giải thích; có thứ phụ thuộc DỮ LIỆU đang được `await` trước khi khung trang được gửi đi. Chỗ sửa là Suspense ở
`page.tsx`, làm sau khi #1006 vào `main` (tệp của #1006). Làm ấm vẫn giữ, vì nó cứu lượt đầu sau deploy.

**Hướng (b), chờ chủ shop:** healthcheck chờ làm ấm xong + Caddy chờ container `healthy` rồi mới mở lưu lượng, để lượt
đầu sau deploy không rơi vào người dùng. Lead đưa lên khi có đủ số của hướng (a).

**`/reports/returns`: thân nguội (`returns-body-dedupe`, owner `cc2379e4`) — DEPLOYED #1030 `65883e6be` (04:57Z 24/10).**
Căn cứ trước khi sửa: probe-rb-1..3, ba lượt nguội đo lúc có deploy chạy song
song. Thời gian tuyệt đối lệch 2–4 lần giữa các lượt nên KHÔNG dùng làm số trước/sau; cấu trúc câu thì giống hệt ở cả
3 lượt.

1. **`baseRows` chạy 3 lần → 1 lần.** Câu lý do hoàn chạy 3 lần cho kỳ này · kỳ trước · `problemByProduct` với ĐÚNG
   một bộ tham số, vì câu SQL không lọc kỳ. perf-probe ghi «câu chạy lại nhiều nhất ×3, tốn 6.284–12.208 ms». Nay phần
   SQL được đệm theo khoá không có kỳ, TTL 90 s.
   - RAM: câu trả 3.544 dòng (đếm production 24/10), khoảng 836 B/dòng ⇒ khoảng 3 MB, lớn dần theo số đơn.
   - Phía máy chủ câu này chỉ khoảng 0,2 s, nên phần còn lại của 2,0–2,2 s mỗi lượt chưa được giải thích (nghi chờ bể
     / xếp hàng).
2. **`careRows` chỉ tính kiện có đợt care.** EXPLAIN ANALYZE production, kỳ 90 ngày: cùng 1.202 dòng; nhánh nặng
   khoảng 1,04 s → khoảng 0,52 s; cost 1,2M → 323k.

Đích: thân giảm ≥ 40%, không đổi số nào (returns-parity / outcome-parity xanh).

**Hồi quy đường ẤM sau deploy, gốc KHÔNG phải #1030 — sửa ở #1036 `6ca3af26b` (deploy 09:38Z 24/10).**
- Triệu chứng (returns-page-probe ~05:50Z, `perf2410/returns-1.log`): mở lần hai — đáng ra trúng đệm — đầu 3.472 · thân
  9.250 ms; buổi sáng cùng ngày 228 / 446 ms. Trong chính tiến trình probe, lượt ấm vẫn 2–4 ms.
- Gốc: kho đệm là MỘT cho cả tiến trình, mà mọi lượt `audit()` (và các nơi gọi thẳng `clearMemo()`) xoá đệm của MỌI tổ
  chức. CSDL nhà 05:40–06:00Z chỉ có 3 dòng nhật ký (db-query 40069757141), còn giờ trưa bot HSLC ghi liên tục vào
  CSDL của HSLC. Lượt tính đang chạy gặp lượt xoá thì kết quả còn bị vứt. Đường ấm không chạm phần #1030 sửa, nên
  Lead quyết KHÔNG revert #1030.
- Sửa (#1036): `clearMemo(scope)` xoá theo tổ chức; `audit()` tự phân giải tổ chức; vết rào bot
  `SALES_CHAT_DUPLICATE_ORDER_BLOCKED` thôi xoá đệm; xuất bản tổ chức (ghi CSDL nền tảng) xoá `"ALL"`; hợp đồng
  `docs/platform/shared-contracts.md` §9 sửa theo.
- Còn mở: 16 chỗ gọi thẳng `clearMemo()` khi chạy THEO PHIÊN (người của tổ chức khác thao tác trên trình duyệt) vẫn
  xoá `"ALL"`, vì hàm đồng bộ không đọc được phiên. PR sau nếu số còn hụt.

**Đo sau #1036 (returns-page-probe ngay sau deploy, `perf2410/returns-2.log`):**

| Lượt | Trước hồi quy | Lúc hồi quy (trưa) | Sau #1036 |
|---|---|---|---|
| Lượt 1 (dữ liệu nguội) | — | đầu 6.285 · thân 20.087 ms | đầu 3.445 · thân 8.272 ms |
| 30 ngày (dữ liệu nguội) | — | đầu 3.015 · thân 16.525 ms | đầu 2.060 · thân 7.149 ms |
| Ấm | đầu 228 · thân 446 ms | đầu 3.472 · thân 9.250 ms | đầu 270 · thân 618 ms |
| Tham số mặc định ghi rõ | — | đầu 513 · thân 15.269 ms | đầu 229 · thân 768 ms |

Đọc: đường ấm đã về lại. Thân nguội lượt 1 còn 8,3 s, so với smoke nền 23/10 là 12,6 s (khoảng −34 %). Hai số này đo bằng
hai công cụ khác nhau (smoke ↔ returns-page-probe) và ở hai mức tải khác nhau, nên đích ≥ 40 % CHƯA được xác nhận. Cần một
lượt perf-probe cùng công cụ với số nền. Chưa đạt thì việc kế là câu `with don` của dự báo GTC chạy hai lần trong
`getReturnRateByVariant` (bậc VARIANT + bậc PRODUCT, cùng tập đơn), ở `lib/queries/projected-delivery.ts`. Suspense theo khối
(«KPI hiện trước») — xem OD-UX-05.4b ở §5.2.

**Bài học đo (ghi để phiên sau khỏi lặp):** brief đầu tiên của mục trên đoán «~10⁵ dòng» từ TỔNG số dòng mọi câu của
`getReturnIntelligence`, rồi chọn phương án theo con số đoán đó. Lead đếm thật bằng `db-query` ra 3.544 dòng. Trước khi
chọn phương án theo kích thước dữ liệu, gửi Lead một câu `count(*)` của đúng câu đó.

**`/reports/returns` sau Suspense (05.4b) và «KPI khởi chạy trước» (05.4c) — căn cứ từng bước (25–26/10/2026).**

| Bước | Phép đo | Số | Đọc |
|---|---|---|---|
| Suspense #1065 | returns-page-probe, 1 mẫu / bên | lượt 1 KPI 11.491 → 4.219 ms; kỳ 30 ngày KPI 6.604 → 6.120 ms | Lượt 1 đạt; kỳ 30 ngày chưa được lợi |
| 1b (#1063) | `select 1` mỗi 100 ms trong lúc trang nguội | trung vị 1 ms (= lúc rảnh) · p90 34–67 · max 713–936 ms | Chờ bể CÓ nhưng hiếm ⇒ không giải thích đầu phản hồi 2–3 s |
| 1c (#1067) | KPI kỳ 30 ngày một mình ↔ chung cả trang | 1.090 ↔ 2.172 ms (2,0×) | KPI XẾP HÀNG sau các nhánh khác |
| Dòng thời gian xả (#1069) | lúc chữ KPI / từng ranh giới Suspense tới | KPI tới CÙNG lượt với thân chính (8 ranh giới ở 5.594 ms), không sau khối phân tích | Lượt xả không bị giữ; thân chính resolve muộn |
| Mốc từng lời hứa (#1071) | 4 thứ thân chính chờ | summary 2.356 · danh mục mã 18 · marketer 361 · hồ sơ hiển thị 2 ms | Thân chính = CHÍNH summary ⇒ hướng (B) |
| Cờ bật / tắt bằng set-setting (#1073) | 1 cặp, 15:5xZ | KHÔNG so được: dự báo gọi thẳng (không qua cờ) cũng chậm 2,3× ở lượt «sau» | Máy bận lên giữa hai lượt ⇒ cờ giữ TẮT, đo lại xen kẽ |
| 1d (#1075) | tắt/bật xen kẽ × 3 trong cùng lượt script | KPI trung vị 2.366 → 686 ms · cả trang 3.937 → 4.173 (×1,06) | Dưới ngưỡng 1,10 ⇒ bật cờ |
| HTTP xen kẽ | tắt/bật × 2 cặp, kỳ 30 ngày nguội | KPI 4.728 · 8.127 → 3.217 · 3.610 ms; thân 7.317 · 9.190 → 3.544 · 5.230 ms | BẬT tốt hơn cả KPI lẫn thân ⇒ giữ cờ BẬT |

Quyết định của Lead đi kèm (25/10): rút giả thuyết «layout xếp hàng trên bể»; KHÔNG làm cổng đếm kết nối cho trang; KHÔNG đưa
lượt đọc layout qua đệm; CHƯA ghi dòng thời gian vòng sự kiện phía app (đụng mã production) — chỉ mở lại khi chủ shop hoặc số
đo người dùng cho thấy còn đau. Bài học đo của bước có cờ: so một mẫu «sau» với một mẫu «trước» ở khung giờ khác là đo tải máy,
không đo thay đổi — đo xen kẽ trong cùng khung giờ, lấy trung vị.

## 6. Audit theo module

### 6.0 Cách đọc

Mỗi module có các ô sau:

- **Đang có:** tệp và tuyến thật.
- **Lỗi / tồn tại:** chỉ những gì kho mã TỰ ghi nhận, kèm `tệp:dòng`. Không có phỏng đoán.
- **Điểm tốt của Odoo:** nguồn là `odoo.com/documentation/18.0`, kèm URL.
- **Nên ứng dụng · Ưu tiên · Cách triển khai.**
- **Phân loại:**
  - `KEEP`: giữ nguyên, đã tốt hơn hoặc ngang Odoo;
  - `IMPROVE`: có rồi, nâng;
  - `FIX`: có rồi nhưng sai hoặc hở;
  - `BUILD`: chưa có, cần;
  - `INTEGRATE`: nối hai thứ đang có;
  - `SKIP`: không làm.

**Ấn bản Community / Enterprise.** Các trang tài liệu đã đọc KHÔNG ghi ấn bản, và bảng so sánh
`odoo.com/page/editions` không trích được ô dấu tích. Nên ấn bản được xác định bằng cách kiểm module có
nằm trong mã nguồn mở `github.com/odoo/odoo` nhánh `18.0/addons` hay không. Phép kiểm chỉ liệt kê tên
thư mục, không đọc mã, đo 23/10/2026 trên 628 module:

| Community (có trong `odoo/odoo`) | Enterprise (KHÔNG có trong `odoo/odoo`) |
|---|---|
| `stock`, `stock_account`, `stock_landed_costs`, `purchase`, `purchase_stock`, `mrp`, `crm`, `sale`, `mail` (chatter + activities), `base_automation` (automation rules), `account` (Invoicing), `analytic`, `hr`, `hr_expense`, `mass_mailing`, `sms`, `project`, `spreadsheet_dashboard` | `quality`, `quality_control`, `mrp_workorder`, `account_accountant` (Accounting đầy đủ), `hr_payroll`, `approvals`, `sale_commission`, `sale_subscription`, `marketing_automation`, `helpdesk`, `web_studio`, `spreadsheet_edition` |

Module Enterprise chỉ được học ở mức **khái niệm trong tài liệu công khai**.

### 6.1 Bảng tổng hợp

| # | Module | Phân loại | Ưu tiên | Nên ứng dụng (một dòng) |
|---|---|---|---|---|
| 1 | Inventory / Stock ledger | KEEP + BUILD | P1 | Giữ sổ kho một công thức. Thêm phiếu kiểm kê và kiểm kê xoay vòng. |
| 2 | Sales / CRM / Contacts / Activities / Chatter | KEEP + IMPROVE | P2 | Giữ nhật ký bốn chiều. Thêm "việc kế tiếp có hạn" gắn bản ghi (phép chiếu). |
| 3 | Accounting / Profitability | KEEP | P3 | Giữ bộ máy chi phí và sổ ngân hàng. Không dựng sổ cái kép. |
| 4 | Purchase | IMPROVE + FIX | P1 | Nhà cung cấp là khoá thật. Trạng thái thanh toán đơn xưởng. Lead time đọc mốc thật. |
| 5 | Manufacturing / BOM / QC | khảo sát trước (FIX nhỏ) | P2 / P3 | Định mức vải lên máy chủ. BOM và QC chỉ khảo sát. |
| 6 | Helpdesk / SLA | KEEP | — | Đã ngang hoặc hơn Odoo. Việc còn lại là đo, không phải dựng. |
| 7 | Payroll / Commission / Approvals | KEEP + BLOCKED | P2 | Vòng đời kế hoạch hoa hồng sau khi chủ shop chốt cơ sở. |
| 8 | Marketing automation | SKIP (tạm) | — | Bị chặn ngoài (cửa sổ 24 giờ, App Review). Giữ cổng ghi quảng cáo. |
| 9 | Subscriptions / Billing (SaaS) | KEEP + IMPROVE | P3 | Giữ "trả tới ngày". Thêm KPI MRR / churn. |
| 10 | Studio / Automated actions / Workflow | IMPROVE | P2 | Trigger theo thời gian + hai lớp điều kiện, mặc định chạy thử. |
| 11 | Dashboards / Search / Views | BUILD (nhỏ) | P1 | Bộ lọc yêu thích theo người dùng, nằm trên URL state đang có. |
| 12 | Audit / Access / Multi-company | KEEP + FIX | P2 | Giữ ba chiều quyền + silo. Đóng các rủi ro R-01 / R-16 đang mở. |

### 6.2 Inventory / Stock ledger: **KEEP + BUILD · P1**

- **Đang có**
  - Tuyến:
    - `app/(dashboard)/inventory/` gồm `page`, `receipts`, `returns`, `lots`, `shortage`, `decisions`,
      `cost-center`, `packing`, `purchasing`, `workshop`, `planning`;
    - `app/(dashboard)/returns/`;
    - `reports/stock-wait`.
  - Công thức duy nhất ở `lib/queries/stock.ts` (`erpStockExpr`, `availableStockExpr`), theo AGENTS 10.
  - Phiếu kho: bảng `stock_receipts` (`db/schema.ts:2616`), kiểu RECEIPT / RETURN / ISSUE / ADJUSTMENT,
    số lượng có dấu. Kèm `stock_receipt_items` và `stock_lots`.
  - Hàng hoàn đi qua `return_inspections` → phiếu RETURN.
  - `warehouses` / `variant_stocks` / `inventory_histories` chỉ là bản sao Pancake.
- **Lỗi / tồn tại**
  - Độ chính xác tồn kho là `UNAVAILABLE`: ERP không có kiểm kê định kỳ, không có dòng đếm vs sổ
    (`lib/constants/metric-catalog.ts:229-245`).
  - Giá vốn lịch sử dựng ngược chỉ từ 2 phiếu nhập: 368/407 đơn đã giao `UNVERIFIABLE`, hụt
    58.049.000 ₫ (`docs/cogs-recognition-contract.md:95-124`).
  - Form nhập còn cho giá 0: #287 DEFERRED, #277 chờ chủ shop
    (`docs/tech/MASTER_MISSION_REGISTRY.md:789-790`).
  - Sổ kho ERP không có cột kho (`stock_receipts` không có `warehouse_id`, `db/schema.ts:2616-2643`).
    Đa kho chỉ có ở bản sao Pancake.
- **Điểm tốt của Odoo** (Community: `stock`)
  - Tách rời Location · Operation type · Inventory adjustment · Cycle count · Scrap.
  - Route là tập rule push/pull có tên, gắn được vào sản phẩm hoặc dòng đơn.
  - Nguồn:
    - https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory.html
    - https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/use_routes.html
- **Nên ứng dụng**
  - Thêm phiếu KIỂM KÊ: một lượt đếm sinh ra dòng "đếm được vs sổ".
  - Chênh lệch thành phiếu ADJUSTMENT có lý do, do người bấm. Không tự cân sổ.
  - Từ đó mở được `inventory_accuracy` với nguồn thật.
  - Sau đó mới tới kiểm kê xoay vòng theo nhóm mẫu mã.
  - Route push/pull: **SKIP**. Shop một kho, giao qua ĐVVC, không cần chuỗi chuyển kho.
- **Cách triển khai**
  - OD-P3-01: bảng `stock_counts` + `stock_count_lines` (mẫu mã, sổ lúc chốt, đếm được). Server action
    chốt, sinh ADJUSTMENT qua đúng đường ghi phiếu kho đang có. Bài kiểm: chênh 0 không sinh phiếu;
    NULL đếm ≠ 0.
  - OD-P3-02: lịch xoay vòng.
  - Cột kho: chỉ làm khi chủ shop có kho thứ hai thật.

### 6.3 Sales / CRM / Contacts / Activities / Chatter: **KEEP + IMPROVE · P2**

- **Đang có**
  - Tuyến:
    - `app/(dashboard)/orders/*`;
    - `customers/*` (receivables, reorder, retention);
    - `ai/sales-chatbot/*` (inbox, conversations, cockpit, quality, replay…);
    - `o/[object]/[id]`.
  - Thư viện `lib/sales-chatbot/*` (≈150 tệp).
  - Nhật ký: `lib/queries/{entity-timeline,record-timeline,shipment-timeline}.ts`. Nhật ký vận đơn tách
    bốn chiều CARRIER · HUMAN · SYSTEM · DERIVED (AGENTS 47).
  - `customer_touchpoints` (`db/schema.ts:1585`); `product_notes` không chạm số (AGENTS 46).
- **Lỗi / tồn tại**
  - Không có activity chung kiểu "việc kế tiếp, có hạn, có người" gắn với mọi bản ghi. Hẹn chỉ nằm rời
    rạc ở `shipment_care.follow_up_at`, `cs_cases`, `work_items`.
  - "Tỷ lệ chốt từ tin nhắn" và "chất lượng đơn tôi chốt" là `UNAVAILABLE`: Pancake không trả người chốt
    và `orders` không có cột đó (`lib/constants/department-performance.ts:49-56`).
  - HSLC có 98/214 hội thoại `HANDOFF_UNANSWERED`, đo 21/10 (`lib/constants/sales-quality.ts:6`).
  - Customer 360 chưa hiện hội thoại (`docs/pancake-replacement-gap-analysis.md:110`).
  - Hộp thư trần 100 hội thoại (`:103`).
  - Chưa đồng bộ lịch sử Messenger (`:116`).
- **Điểm tốt của Odoo** (Community: `mail`, `crm`, `sale`)
  - Activity gắn đúng một bản ghi và hiện ở mọi nơi bản ghi đó hiện.
  - Activity type là khuôn mẫu: người mặc định, việc kế tiếp tự sinh.
  - Màu theo hạn: quá hạn / hôm nay / tương lai.
  - Lý do thua là danh mục bắt buộc chọn, không phải ghi chú tự do.
  - Nguồn:
    - https://www.odoo.com/documentation/18.0/applications/essentials/activities.html
    - https://www.odoo.com/documentation/18.0/applications/sales/crm/pipeline/lost_opportunities.html
- **Nên ứng dụng**
  - Một khối "việc kế tiếp" trên trang chi tiết đơn / vận đơn / khách. Nó ĐỌC từ các nguồn hẹn đang có
    (phép chiếu như `/work`, AGENTS 19), không thêm bảng activity thứ hai.
  - Lý do thua có cấu trúc: đã có ở lý do hoàn (#960) và lý do care. **KEEP.**
  - Pipeline CRM và lead scoring: **SKIP**. Bán qua chat, chu kỳ ngắn. Xác suất giao thành công đã có
    thang bậc riêng (AGENTS 68).
- **Cách triển khai**
  - OD-P2-05: hàm thuần `nextActivitiesFor(entity)` gộp hẹn từ care / cs / work, kèm nguồn của từng
    dòng. Đóng việc vẫn đi qua Server Action của miền đó.
  - Bài kiểm: không dòng nào ghi `work_items.status`.

### 6.4 Accounting / Profitability: **KEEP · P3**

- **Đang có**
  - Tuyến: `/finance`, `/finance-ops`, `/bank`, `/cod`, `/expenses`, `/reports` (+ `cashflow`,
    `target`, `scenario`), `/inventory/cost-center`.
  - Bộ máy chi phí: MỘT đường `lib/queries/cost-engine.ts` + sổ thẩm quyền
    `lib/constants/cost-authority.ts` + phân bổ `lib/constants/cost-allocation.ts` (AGENTS 14–18).
  - Sổ ngân hàng: `bank_transactions` khoá `bank_ref`, nhãn tay không bị ghi đè.
  - COD: `cod_batches`, `cod_statement_lines`.
  - Giá vốn đóng băng lúc giao (`docs/cogs-recognition-contract.md`).
- **Lỗi / tồn tại**
  - Không có sổ cái kép, hệ thống tài khoản hay bút toán. Đây là mô hình kế toán QUẢN TRỊ.
  - Nền thanh toán P0.1 chưa nối vào importer, action hay `ORDER_OUTCOME` nào
    (`docs/P0.1-PAYMENT-FOUNDATION.md:3,54`).
  - Một lần chuyển khoản trả cho nhiều chứng từ phải tách tay (`docs/finance-truth-contract.md:169,193-198`).
  - `/cod` in «0 ₫ / chốt chưa rõ» cho bảng kê tải tay (MM-REC-28, `MASTER_MISSION_REGISTRY.md:787`).
- **Điểm tốt của Odoo**
  - Giao dịch ngân hàng nằm ở tài khoản treo (suspense) cho tới khi đối chiếu với chứng từ đối ứng; phần
    lệch thì write-off có chủ ý.
  - Lock date chặn sửa kỳ đã khoá.
  - Phân bổ analytic.
  - Ấn bản: `account` là Community (Invoicing); Accounting đầy đủ (`account_accountant`) là Enterprise.
  - Nguồn:
    - https://www.odoo.com/documentation/18.0/applications/finance/accounting/bank/reconciliation.html
    - https://www.odoo.com/documentation/18.0/applications/finance/accounting.html
- **Nên ứng dụng**
  - Ba ý ERP đã có tương đương, nên **KEEP**:
    - "chưa đối chiếu" ≈ `linked_type` / `linked_id` NULL;
    - lock date ≈ kỳ FINAL bất biến (AGENTS 21);
    - analytic ≈ căn cứ phân bổ (AGENTS 14).
  - Một ý đáng học: **tách một giao dịch cho nhiều chứng từ có phần lệch tường minh** (write-off có lý
    do). Đây là FIX của lỗ hổng `finance-truth-contract.md:169`.
  - Sổ cái kép: **SKIP**. Không có nhu cầu đã đo, rủi ro lớn, kế toán pháp định làm ngoài ERP.
- **Cách triển khai**
  - Để Phase 5 hoặc sau. Trước đó phải nối P0.1 vào một luồng thật. Không làm trong chương trình này nếu
    chưa có ca thật bị chặn.

### 6.5 Purchase (đặt xưởng / nhà cung cấp): **IMPROVE + FIX · P1**

- **Đang có**
  - Tuyến: `/inventory/purchasing`, `/inventory/planning/orders/*`, `/inventory/workshop/*`,
    `/inventory/decisions`.
  - Bảng:
    - `suppliers` (`db/schema.ts:448`);
    - `production_orders` (`:465`): DRAFT / SENT / RECEIVED / CANCELLED, `unit_cost` NULL = chưa biết,
      `received_at` + `received_by_user_id`;
    - `production_batches`, `production_deliveries` (âm = trả lỗi về xưởng), `fabric_orders`,
      `supplier_payments`.
  - Đơn gợi ý = kế hoạch − đơn xưởng còn mở (`suggestedNetOfOpenPo`).
  - Cam kết (`production_orders`) tách khỏi hàng thật nhận (phiếu nhập).
- **Lỗi / tồn tại**
  - `supplier` vẫn là ô chữ (`docs/department-module-map.md:148`).
  - Mốc nhận hàng thật chỉ có từ 23/09, nên mẫu đo xưởng giao trễ bắt đầu từ 0.
  - `lib/queries/purchasing.ts:15-27` vẫn ghi đơn xưởng không có ngày nhận, và suy lead time bằng cách
    ghép đúng một phiếu nhập (≈`:221-259`). Không đọc `received_at`.
  - Đơn xưởng chưa có giá cộng 0 ₫ vào dòng tiền 30 ngày ⇒ dư địa ngân sách trông cao hơn thật
    (`lib/queries/order-budget.ts:43-46`).
- **Điểm tốt của Odoo** (Community: `purchase`, `purchase_stock`)
  - Chính sách hoá đơn theo số **đã nhận**.
  - Trạng thái thanh toán của PO: Nothing to Bill / Waiting Bills / Fully Billed.
  - Khớp ba chiều PO – nhận – hoá đơn; sửa thì cảnh báo, không chặn.
  - Nguồn: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase/manage_deals/control_bills.html
- **Nên ứng dụng**
  - Trạng thái thanh toán đơn xưởng suy ra lúc đọc từ `production_deliveries` (đã nhận) vs
    `supplier_payments` (đã trả). Không cột mới, không backfill.
  - Lead time đọc `received_at`, mẫu nhỏ thì trả `null` (AGENTS 39).
  - Nhà cung cấp là khoá thật.
  - "Chưa có giá" phải hiện ra như một dòng cảnh báo, không cộng 0 (AGENTS 42).
- **Cách triển khai**
  - OD-P2-02: thêm `production_orders.supplier_id` (nullable). Ánh xạ tên → nhà cung cấp chỉ khi khớp
    đúng một, có báo cáo chạy thử (AGENTS 35).
  - OD-P2-03: sửa `purchasing.ts` đọc `received_at`, giữ đường ghép cũ làm dự phòng có nhãn.
  - OD-P3-03: hàm thuần `workshopBillingStatus()` + cột trên `/inventory/workshop`.
  - Sửa dư địa ngân sách: tách cảnh báo "N đơn chưa có giá".

### 6.6 Manufacturing / BOM / QC: **khảo sát trước · FIX nhỏ P1, phần còn lại P3**

- **Đang có:** chỉ NỬA ĐẦU của sản xuất thuê ngoài.
  - Luồng topic → định giá → mẫu → duyệt → đơn xưởng (`lib/constants/production-os.ts:1-17`).
  - Tuyến `app/(dashboard)/production/*`.
  - Bảng `production_topics`, `cost_sheets` (bản FINAL bất biến), `samples`, `sample_reviews`.
- **Lỗi / tồn tại**
  - Không có BOM hay nhu cầu vật tư.
  - Định mức vải chỉ nằm trong `localStorage` của trình duyệt
    (`app/(dashboard)/inventory/shortage/pending-matrix-section.tsx:31-48`, MM-REC-26).
  - Không có kiểm hàng nhập từ xưởng; "QC" trong schema là QC video/quảng cáo.
- **Điểm tốt của Odoo**
  - BOM là bản thiết kế, linh kiện tiêu hao trên lệnh sản xuất. Cờ tiêu hao linh hoạt Blocked / Allowed /
    Allowed with Warning. Phụ phẩm là dòng riêng. Nguồn:
    https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/basic_setup/bill_configuration.html
    (Community: `mrp`).
  - Điểm kiểm và lượt kiểm kiểu pass/fail · đo · ảnh. Nguồn:
    https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/quality.html
    (**Enterprise**: `quality_control`, chỉ học khái niệm).
- **Nên ứng dụng**
  - FIX ngay: định mức vải lên máy chủ. Mất trình duyệt là mất dữ liệu; hai người hai số.
  - Kiểm hàng nhập xưởng ở mức tối thiểu: đạt/lỗi theo lô giao, dòng lỗi = `production_deliveries` âm
    đang có.
  - BOM / work order / routing: **khảo sát trước**. Shop thuê xưởng may, không tự sản xuất. Chỉ dựng khi
    khảo sát cho thấy định mức vải là nút thắt đặt hàng.
- **Cách triển khai**
  - OD-P2-04: bảng `fabric_norms` (mẫu, vải, mét/sản phẩm, người đặt, lý do) + màn hình đọc; nhập lại dữ
    liệu cũ từ `localStorage` bằng tay của người dùng. **DỪNG 23/10/2026:** `/inventory/shortage` chỉ 7
    lượt / 30 ngày và 0 thao tác. Mã đã viết xong và kiểm đạt, nằm ở `wip/od-p2-04-fabric-norms`.
  - OD-P3-04: kiểm hàng nhập (sau khảo sát).
  - OD-P5-02: tài liệu khảo sát BOM.

### 6.7 Helpdesk / SLA: **KEEP · không dựng mới**

- **Đang có**
  - Tuyến: `/cs`, `/work/*`, care trong `app/(dashboard)/shipments/{care-board,care-drawer,care-report,workbench}.tsx`.
  - Thư viện: `lib/care/*`, `lib/cs/*`, `lib/work/{escalation,distribution,auto-assign-run}.ts`.
  - SLA và phòng chịu trách nhiệm ở đúng hai bảng (`lib/constants/work-sla.ts`, `work-ownership.ts`,
    AGENTS 22).
- **Lỗi / tồn tại** (đo production, ghi trong AGENTS)
  - 221/321 ca chưa ai động vào (AGENTS 57).
  - `first_action_at` chỉ có ở 2/319 đợt (AGENTS 63).
  - 22–27/44 ca «cứu được» là ĐVVC tự phục hồi (AGENTS 56).
  - `/cs` có 426 ca mở trên 296 khách (`app/(dashboard)/cs/page.tsx:46`).
- **Điểm tốt của Odoo**
  - SLA theo team.
  - Phân công tự động theo hai kiểu: cân tổng số, hoặc cân số đang mở; bỏ qua người nghỉ.
  - Quyền xem theo team.
  - Ấn bản: **Enterprise** (`helpdesk`). Nguồn: https://www.odoo.com/documentation/18.0/applications/services/helpdesk.html
- **Nên ứng dụng:** không có gì cần dựng. ERP đã có phân việc theo trần, chạy thử mặc định, có lý do
  nằm lại (AGENTS 25), và leo thang tính lúc đọc (AGENTS 26), chặt hơn mô tả của Odoo. Lỗ hổng là **người
  chưa làm**, không phải phần mềm thiếu: đo và điều hành, không code.
- **Cách triển khai:** không có PR trong chương trình. Nếu cần, chỉ là báo cáo đo, theo AGENTS 57/63.

### 6.8 Payroll / Commission / Approvals: **KEEP + BLOCKED · P2**

- **Đang có**
  - Tuyến: `/payroll/*` (runs, policies, codes, adjustments, autopilot, payslip, reconciliation…),
    `/my-payslip`, `/approvals`.
  - Thư viện: `lib/payroll/*` (profit-gate, code-ledger, profit-reconciliation, settlement),
    `lib/approvals/*`.
  - Cổng lỗ lũy kế, ký hai người, "đã trả" chỉ bằng sao kê (AGENTS 70–79).
- **Lỗi / tồn tại**
  - Cơ sở hoa hồng chưa chốt: `COMMISSION_BASIS_NEEDS_REVIEW` (`lib/queries/cost-engine.ts:419`,
    `lib/constants/cost-authority.ts:134-143`).
  - Enforcement duyệt TẮT vì production chỉ có 2 tài khoản. Sửa COD, ghi đè ĐVVC và ngân sách QC chưa
    nối duyệt (`docs/second-approval-policy.md:47-70,142-156`).
  - Đối soát lương từng người chưa chạy trên production (`docs/payroll-production-reconciliation-2026-09-15.md:216-224`).
  - AGENTS dùng số mục **70 hai lần** (`AGENTS.md:573` và `:672`).
- **Điểm tốt của Odoo**
  - Kế hoạch hoa hồng: theo Đích hoặc Thành tích; vòng đời Nháp → Duyệt, đã duyệt thì không sửa, phải
    về Nháp. Ấn bản **Enterprise** (`sale_commission`). Nguồn:
    https://www.odoo.com/documentation/18.0/applications/sales/sales/commissions.html
  - Payroll: hợp đồng mang cấu trúc lương; work entry phải sạch lỗi trước khi tính. Ấn bản
    **Enterprise** (`hr_payroll`). Nguồn: https://www.odoo.com/documentation/18.0/applications/hr/payroll.html
  - Approvals: trang tài liệu trả 404 khi đọc. Ấn bản **Enterprise** (`approvals`).
- **Nên ứng dụng**
  - Vòng đời Nháp → Duyệt → bất biến cho kế hoạch hoa hồng, sau khi chủ shop chốt cơ sở. Cùng ý với kỳ
    FINAL (AGENTS 21).
  - Payroll và Approvals: **KEEP**, ERP đã chặt hơn.
- **Cách triển khai**
  - OD-P4-03 (BLOCKED tới khi có quyết định).
  - OD-P4-02 (BLOCKED tới khi có tài khoản thứ hai thật).
  - Việc vặt ngoài chương trình: đánh số lại mục 70 trùng trong AGENTS (OD-MISC-01, §5.3). Lead
    23/10: không sửa lượt này.

### 6.9 Marketing automation: **SKIP (tạm) · —**

- **Đang có**
  - Tuyến: `/ads/*`, `/outreach/*`, `/landing`, `/marketing/*`.
  - Cổng ghi quảng cáo bảy lớp + kill switch (`lib/marketing/ads-write-gate.ts`), CAPI `event_id` cố định.
  - Gửi tin hàng loạt: `lib/outreach/*`.
- **Lỗi / tồn tại**
  - 25/25 tin bán chéo ngoài cửa sổ 24 giờ thất bại (`lib/constants/outreach-broadcast.ts:17`).
  - Tin HUMAN_AGENT là `BLOCKED_EXTERNAL`, cần App Review (`docs/pancake-replacement-gap-analysis.md:105`).
  - Chỉ 49/1.096 chiến dịch nối được đơn (4,5%) (`docs/ads-measurement-audit-2026-09-22.md:14-27`).
  - CAPI không rút đơn hoàn (`lib/constants/meta-capi.ts:8`).
- **Điểm tốt của Odoo**
  - Chiến dịch là chuỗi activity có trigger + thời lượng.
  - Mỗi bước đếm thành công / bị loại.
  - "Unicity based on" chống gửi trùng.
  - Chế độ test trước khi chạy thật.
  - Ấn bản **Enterprise** (`marketing_automation`). Nguồn: https://www.odoo.com/documentation/18.0/applications/marketing/marketing_automation.html
- **Nên ứng dụng:** chưa. Kênh gửi bị chặn từ bên ngoài, dựng máy chiến dịch lúc này là tự động hoá thứ
  không gửi được. Ý "chống trùng + chạy thử + đếm từng bước" đã có trong `lib/outreach/*` và cổng ghi
  quảng cáo.
- **Cách triển khai:** mở lại khi App Review Meta cho HUMAN_AGENT có kết quả.

### 6.10 Subscriptions / Billing (SaaS): **KEEP + IMPROVE · P3**

- **Đang có**
  - Tuyến: `app/(dashboard)/platform/*`, `settings/plan`, `settings/ai-balance`, `billing-locked`,
    `app/pricing`, `app/start`.
  - Thư viện: `lib/billing/*`, `lib/saas/*`, `lib/pricing/*`.
  - Bảng `platform_*` (`db/schema.ts:4831-5986`).
  - Tình trạng thuê bao là hàm thuần của `paid_through`, quá hạn chỉ chặn ghi (AGENTS 73).
  - Ghim phiên bản giá.
- **Lỗi / tồn tại**
  - KPI SaaS mới làm một phần (`docs/saas/PLAN.md:27`).
  - Cổng khách hàng làm một phần (`:26`).
  - Danh tính hợp nhất chưa dựng (`docs/saas/IDENTITY.md:12-15`).
  - Nghiệm thu vòng 2 dưới đích: Admin 60%, Customer 47% (`docs/saas/FINISH_LINE_R2_2026-10-08.md:15-18`).
  - Rủi ro R-19 (chi phí AI mọi tổ chức về VNX) và R-03 (trần ≈15 tổ chức/máy) còn mở
    (`docs/platform/risk-register.md:9,25`).
- **Điểm tốt của Odoo**
  - Thuê bao = đơn bán gắn kế hoạch định kỳ.
  - Bán thêm diễn ra trên cùng đơn.
  - Tự đóng sau thời gian ân hạn.
  - Ấn bản **Enterprise** (`sale_subscription`). Nguồn: https://www.odoo.com/documentation/18.0/applications/sales/subscriptions.html
- **Nên ứng dụng:** KPI MRR / churn / gia hạn đọc từ `platform_subscriptions` + `platform_invoices`.
  Tài liệu Odoo không định nghĩa MRR, nên công thức phải tự khai vào sổ chỉ số (AGENTS 37), không mượn.
- **Cách triển khai:** OD-P5-01, sau khi có ≥ 1 khách trả tiền thật (mẫu nhỏ thì `null`).

### 6.11 Studio / Automated actions / Workflow: **IMPROVE · P2**

- **Đang có**
  - Máy luật `lib/workflow/*`: bảng `workflow_rules` / `workflow_runs` (khoá `dedupe_key`, lease) /
    `workflow_cursors` (`db/schema.ts:10604-10671`), UI `settings/workflows/*`.
  - Luật mới luôn bắt đầu DRAFT + DRY_RUN.
  - Builder: `settings/{objects,data-model,pages,forms,lists,statuses,templates}`, `meta_*`,
    `custom_records`.
  - Scheduler: `scripts/scheduler*.mjs` + `lib/sync/jobs.ts`.
  - Cảnh báo: `lib/alerts/rules.ts`.
- **Lỗi / tồn tại**
  - Trigger chỉ có `event` và `custom_status`, không có trigger theo thời gian (`lib/workflow/types.ts:17-19`).
  - `request_approval` chỉ chạy cho khách (`docs/platform/current-execution-state.md:89`).
  - Cài blueprint quá hạn mức thì hỏng giữa chừng (`:93`).
  - Cadence không có UI (`docs/platform/pilot-readiness.md` §4).
- **Điểm tốt của Odoo**
  - Automation rule = trigger + điều kiện + danh sách action có thứ tự. Năm nhóm trigger: đổi giá trị /
    email / **theo thời gian** / lưu-xoá / webhook.
  - Hai lớp điều kiện: trước cập nhật và sau trigger.
  - Cảnh báo trigger ẩn: thay đổi do luật khác gây ra không kích hoạt "On UI change".
  - Ấn bản: automation rules là **Community** (`base_automation`); Studio là **Enterprise** (`web_studio`).
  - Nguồn: https://www.odoo.com/documentation/18.0/applications/studio/automated_actions.html
- **Nên ứng dụng**
  - Trigger theo thời gian ("N giờ sau mốc X mà trạng thái vẫn Y"), chạy qua scheduler đang có.
  - Điều kiện "trước cập nhật" để luật chỉ bắn khi một trường THẬT SỰ đổi.
  - Chống dây chuyền: một lượt chạy luật không kích hoạt luật khác trong cùng lượt.
  - Studio kéo-thả: **SKIP**. Builder đang có đủ, và sổ khai đóng (không SQL/JS khách) là chủ ý.
- **Cách triển khai**
  - OD-P4-01: thêm `{ kind: "timer", ... }` vào `WorkflowTrigger`. Bộ quét dùng `workflow_cursors`.
    Mặc định DRY_RUN.
  - Bài kiểm: chạy hai lần không bắn hai lần (`dedupe_key`).

### 6.12 Dashboards / Search / Views: **BUILD (nhỏ) · P1**

- **Đang có**
  - `components/data-table/*` + `lib/search-params.ts::parseListParams` (35 tệp app) + nuqs (25 tệp).
  - `components/global-search.tsx` (⌘K).
  - `lib/constants/command-catalog.ts` (`QUICK_VIEWS`).
  - Thẻ điểm `lib/metrics/scorecard.ts`, sổ chỉ số `lib/constants/metric-catalog.ts`, bản đồ module
    `lib/constants/department-modules.ts`.
- **Lỗi / tồn tại**
  - Không có bộ lọc lưu theo người dùng. Chỉ có `meta_list_views` của builder.
  - Khối "bộ lọc đã lưu" ở trang đơn còn đọc bộ đếm Pancake: P1 IN_PROGRESS
    (`docs/tech/MASTER_MISSION_REGISTRY.md:493-498`).
  - `/work` không lọc theo module: R-09 (`docs/platform/risk-register.md:15`).
  - Hai chỉ số không có nguồn: `inventory_accuracy`, `marketing_contribution_after_ads`
    (`lib/constants/metric-catalog.ts:229,305`).
- **Điểm tốt của Odoo**
  - Bộ lọc cùng nhóm kết hợp OR, khác nhóm AND.
  - Group by nhiều tầng.
  - Favorites có tên, đặt mặc định, chia sẻ cho mọi người; của riêng hiện trước, của chung hiện sau.
  - Nguồn: https://www.odoo.com/documentation/18.0/applications/essentials/search.html (Community)
- **Nên ứng dụng**
  - Favorites = lưu CHUỖI truy vấn URL mà nuqs đã giữ, theo người dùng, có tên, tuỳ chọn chia sẻ.
    Rẻ, vì trạng thái đã nằm trên URL.
  - Group by nhiều tầng / pivot: **SKIP** tới khi có màn hình cần.
  - Phần còn lại của chế độ xem (thiết kế, sidebar, độ tươi dữ liệu, KPI bấm xuống, tốc độ, mobile) nằm ở
    nhánh UI/UX (§7.2). Odoo không phải nguồn của nhánh đó; nguồn là số nền đo trên chính ERP.
- **Cách triển khai**
  - OD-P2-01: bảng `saved_views` (user, đường dẫn, tên, chuỗi query, `shared`) + menu trong thanh công
    cụ `DataTable`. Chạm `components/data-table` thì phải `npm run build` (AGENTS 6.4).
  - Bài kiểm: view chia sẻ không lộ dữ liệu ngoài phạm vi người xem, vì phạm vi vẫn áp ở truy vấn
    (AGENTS 30).

### 6.13 Audit / Access / Multi-company: **KEEP + FIX · P2**

- **Đang có**
  - `lib/audit.ts::audit()` (182 tệp gọi) → `audit_logs` (`db/schema.ts:915`, có `actor_kind`,
    `correlation_id`, `reason`). UI `app/(dashboard)/audit/*`.
  - Ba chiều quyền tính ở một chỗ `lib/auth/access.ts` (AGENTS 28–33).
  - Đa tổ chức là SILO (một CSDL / tổ chức, `lib/platform/context.ts:53 withOrganization`).
  - Bài kiểm cô lập: `platform-isolation(-static)`, `platform-rbac`.
- **Lỗi / tồn tại**
  - 7/7 tài khoản đều `data_scope = ALL`, đo 13/09 (`docs/release-2026-09-13-audit.md:73`).
  - R-01 (mất ngữ cảnh tổ chức rơi về tổ chức nhà) và R-04 (credential trong env) đã giảm nhưng chưa
    đóng. R-16 phụ thuộc mọi `after(` đi qua `bindOrganization()`. R-11: luật VNX/COD chạy cho mọi tổ
    chức. (`docs/platform/risk-register.md:7,10,17,22`.)
  - Quyền không khớp một-một với module (`/ads` gác bằng `expenses:view`,
    `docs/platform/current-state-audit.md:57-59`).
- **Điểm tốt của Odoo** (Community)
  - Hai lớp: nhóm quyền theo app + record rule theo bản ghi.
  - Bản ghi gắn công ty chỉ hiện khi đúng công ty; bản ghi không gắn thì dùng chung.
  - Nguồn:
    - https://www.odoo.com/documentation/18.0/applications/general/users.html
    - https://www.odoo.com/documentation/18.0/applications/general/companies.html
- **Nên ứng dụng**
  - Mô hình silo đã MẠNH hơn record rule chung CSDL: **KEEP**.
  - FIX theo sổ rủi ro: đóng R-16 bằng bài quét mã nguồn (mọi `after(` phải bọc), và R-11 bằng cờ luật
    theo tổ chức.
  - Quyền theo module: gắn quyền vào sổ khai module (AGENTS 69), không gác theo đường dẫn.
- **Cách triển khai:** mỗi rủi ro là một PR riêng, do chủ sổ rủi ro nền tảng nhận. Ngoài thứ tự Phase của
  tệp này nếu nền tảng đã có kế hoạch.

## 7. Đề xuất thứ tự Phase 2–5 (theo ROI / rủi ro)

**Lead duyệt 23/10/2026.** Thứ tự đi từ **rẻ + an toàn + có bằng chứng** tới **đắt + cần quyết định**.
Không phase nào chạm `ORDER_OUTCOME`, tiền thật hay ngưỡng nghiệp vụ. Mỗi dòng là MỘT PR.

```
Phase 2 (rủi ro thấp) ─────────────┐
                                   ├──▶ Phase 3 (kho & mua hàng) ──▶ Phase 4 ──▶ Phase 5
Nhánh UI/UX & tốc độ (sau số nền) ─┘
```

Phase 2 và nhánh UI/UX chạy SONG SONG. Cả hai đi trước Phase 3. Các quyết định cần chủ shop gom ở §7.6.

### 7.1 Phase 2: hoàn thiện cái đang có, rủi ro thấp (không đổi số liệu tiền)

| Thứ tự | Task | PR nhỏ | Vì sao trước | Rủi ro |
|---|---|---|---|---|
| 1 | ~~OD-P2-04~~ | ~~Định mức vải lên máy chủ (bảng + đọc + nhập tay)~~ **DỪNG** | Đo 23/10: 7 lượt/30 ngày, 0 thao tác. Dữ liệu «có thể mất» là đúng, nhưng gần như không ai dùng trang. | — |
| 2 | OD-P2-03 | Lead time xưởng đọc `received_at` (giữ dự phòng có nhãn) | Mốc thật đã ghi từ 23/09 mà không ai đọc | Thấp, chỉ báo cáo |
| 3 | OD-P2-02a | `production_orders.supplier_id` nullable + ánh xạ chạy thử | Nền cho mọi số theo nhà cung cấp | Thấp (migration cộng thêm) |
| 4 | OD-P2-02b | Ghi `supplier_id` ở form đơn xưởng, ô chữ thành ảnh chụp tên | Nối tiếp 2a | Thấp |
| 5 | OD-P2-01 | `saved_views` + menu favorites trong `DataTable` | Dùng hằng ngày, trạng thái đã có trên URL | Trung bình (đụng `data-table`, phải build) |
| 6 | OD-P2-05 | Khối "việc kế tiếp" trên trang chi tiết (phép chiếu) | Gom hẹn đang rời rạc | Thấp, chỉ đọc |

### 7.2 Nhánh UI/UX & tốc độ (song song Phase 2, TRƯỚC Phase 3)

Chủ shop coi UI/UX là trọng tâm: master prompt mục IV, nơi Phase 3 = UI/UX & Performance. Nhánh này
dùng mã `OD-UX-xx` để không lẫn với số Phase của tệp này.

**Điều kiện bắt đầu.** Số nền có hai phần:
- **Tần suất dùng thật:** ĐÃ CÓ, bảng dưới.
- **Thời gian tải từng trang:** do phiên `code-erp-56` đo (đêm 23/10/2026; Lead chuyển từ `code-erp-42` sang).

UX-05 (tốc độ) chờ phần thời gian tải. UX-03 và UX-04 Lead cho bắt đầu 23/10, vì chúng không đổi tốc độ.

**Số nền tần suất: lượt mở trang 30 ngày** (`page_visit_daily`, #338; db-query Lead 23/10/2026). Bảng này
không ghi ai mở (chủ ý của #338).

| # | Trang | Lượt | | # | Trang | Lượt |
|---|---|---|---|---|---|---|
| 1 | `/products` | 113 | | 9 | `/platform` | 38 |
| 2 | `/shipments` | 86 | | 10 | `/` | 37 |
| 3 | `/chatbot` | 83 | | 11 | `/inventory/planning` | 37 |
| 4 | `/inventory/receipts` | 72 | | 12 | `/ads` | 31 |
| 5 | `/marketing/creatives` | 71 | | 13 | `/platform/customers` | 31 |
| 6 | `/reports/returns` | 65 | | 14 | `/payroll` | 29 |
| 7 | `/tech` | 52 | | 15 | `/orders` | 23 |
| 8 | `/platform/saas` | 39 | | | | |

`/tech` và `/platform*` là màn hình vận hành nội bộ, không xếp vào ưu tiên UI/UX nghiệp vụ. Đối chiếu:
`/inventory/shortage` chỉ 7 lượt (lý do DỪNG OD-P2-04).

**Định nghĩa xong của MỌI mục:**
- MỘT PR;
- ảnh production TRƯỚC và SAU, cùng màn hình, cùng cỡ cửa sổ;
- mục tốc độ thì kèm số đo trước/sau trên production;
- chạm `components/data-table`, ranh giới client/server hoặc import `lib/*` vào client component thì
  phải `npm run build` (AGENTS 6.4);
- không lookbehind regex trong mã tới trình duyệt.

| Thứ tự (tạm) | Task | PR nhỏ | Dựa trên cái đang có | Ràng buộc |
|---|---|---|---|---|
| 1 | OD-UX-01 | Design system tối thiểu: token màu / khoảng cách / kiểu chữ + quy tắc trạng thái loading / empty / error | `components/ui/*` (shadcn), `components/ui-bits.tsx` (có `EmptyState`). Có 161 tệp `loading.tsx`. **Sửa bằng chứng (23/10):** bản đầu ghi «chỉ 1 `error.tsx`» như một lỗ hổng. Không phải lỗ hổng: tệp đó là `app/(dashboard)/error.tsx` ở GỐC nhóm dashboard, bắt lỗi cho MỌI trang nghiệp vụ. Nó đã đạt chuẩn từ 08/10 (câu tiếng Việt · «Thử lại» · chỉ in mã `digest` · không lộ stack), và `tests/smoke-coverage.test.ts` khoá. 13 trang nghiệp vụ top 15 không trang nào có layout riêng, nên `error.tsx` từng route sẽ cho cùng hành vi. | KIỂM HIỆN TRẠNG TRƯỚC, viết quy tắc, áp cho màn hình mới và màn hình đang sửa. KHÔNG đổi đồng loạt cả ứng dụng trong một PR. |
| 2 | OD-UX-02 | Sidebar gom theo nghiệp vụ | Đọc `lib/constants/department-modules.ts` (AGENTS 69). `components/app-sidebar.tsx` chỉ giữ icon + cách vẽ. | KHÔNG tạo danh sách module thứ hai. `tests/department-map.test.ts` phải xanh. |
| 3 | OD-UX-03 | Chỉ báo «cập nhật lúc · nguồn · trễ đối tác» cho màn hình số liệu: vận đơn, báo cáo hoàn, GTC, lương | Mốc đồng bộ ở `sync_runs`. Độ tươi logistics ở `lib/constants/logistics-freshness.ts` (AGENTS 54). Cache báo cáo `lib/cache.ts::memo`. | KHÔNG giả realtime: in đúng mốc dữ liệu được tính, không in "bây giờ". Mốc không biết thì in `—` (AGENTS 42). |
| 4 | OD-UX-04 | KPI bấm được xuống dữ liệu cấu thành, bắt đầu ở `/reports/returns` và trang chủ | Danh sách đích dùng LẠI đúng điều kiện của KPI (`ORDER_OUTCOME`, rổ `fulfillmentBucketSql`). | Danh sách phải ra ĐÚNG số đơn bằng con số trên thẻ. Có bài kiểm so hai đường. Không viết lại điều kiện. |
| 5 | OD-UX-05 | Tối ưu 2–3 trang chậm nhất theo số nền | Kinh nghiệm cũ: trang chậm chưa chắc do SQL; JIT và VPS bão hoà là hai bẫy đo. | Đích đo được, ghi TRƯỚC khi sửa. Đo trước/sau trên production. Không đổi số liệu (so từng cột). |
| 6 | OD-UX-06 | Kiểm mobile cho 5 màn hình dùng nhiều (chọn theo số nền) | Bảng phải vừa một màn hình; ô hai tầng. | Ghi tap target < 32px và cuộn ngang. Mỗi màn hình sửa là một PR riêng nếu lớn. |

### 7.3 Phase 3: kho và mua hàng đúng chuẩn

| Thứ tự | Task | PR nhỏ | Vì sao | Rủi ro |
|---|---|---|---|---|
| 1 | OD-P3-01a | Bảng `stock_counts` / `stock_count_lines` + màn hình đếm (chưa sinh phiếu) | Mở `inventory_accuracy` bằng nguồn thật | Thấp |
| 2 | OD-P3-01b | Chốt lượt đếm ⇒ ADJUSTMENT có lý do qua đường ghi phiếu kho đang có | Tồn sổ khớp tồn thật | **Trung bình: chạm tồn kho.** Người bấm, đo trước/sau. |
| 3 | OD-P3-01c | Nối `inventory_accuracy` vào sổ chỉ số (`MEASURED`) | Hết `UNAVAILABLE` | Thấp |
| 4 | OD-P3-03 | `workshopBillingStatus()` (đã nhận vs đã trả) + cột `/inventory/workshop` | Thấy ngay xưởng nào trả thừa / thiếu | Thấp, đọc lúc xem |
| 5 | OD-P3-03b | Dư địa ngân sách: "N đơn chưa có giá" là cảnh báo, không cộng 0 | Sửa số trông đẹp hơn thật | Thấp |
| 6 | OD-P3-02 | Kiểm kê xoay vòng | Sau khi 3.1 chạy ổn | Thấp |
| 7 | OD-P3-04 | Kiểm hàng nhập xưởng (sau khảo sát kho) | Lỗi xưởng có chứng cứ | Trung bình |

Phase 3 chỉ bắt đầu sau khi chủ shop trả lời quyết định Q1 ở §7.6.

### 7.4 Phase 4: tự động hoá và quy trình duyệt

| Thứ tự | Task | PR nhỏ | Blocker |
|---|---|---|---|
| 1 | OD-P4-01a | Trigger `timer` cho `lib/workflow` (DRY_RUN mặc định) | — |
| 2 | OD-P4-01b | Điều kiện "trước cập nhật" + chặn dây chuyền trong một lượt | — |
| 3 | OD-P4-02 | Nối duyệt cho sửa COD · ghi đè ĐVVC · ngân sách QC | Cần tài khoản thứ hai thật (enforcement OFF) |
| 4 | OD-P4-03 | Kế hoạch hoa hồng Nháp → Duyệt → bất biến | Chủ shop chốt cơ sở hoa hồng (`COMMISSION_BASIS_NEEDS_REVIEW`) |

### 7.5 Phase 5: SaaS và khảo sát

| Thứ tự | Task | PR nhỏ | Ghi chú |
|---|---|---|---|
| 1 | OD-P5-01 | KPI MRR / churn / gia hạn khai vào sổ chỉ số | Mẫu nhỏ ⇒ `null` |
| 2 | OD-P5-02 | Tài liệu khảo sát BOM / định mức đầy đủ | Chỉ tài liệu. Dựng chỉ khi định mức vải là nút thắt đã đo. |

**Không đưa vào chương trình** (SKIP có lý do ở mục 6):

- pipeline CRM / lead scoring;
- route kho push/pull;
- sổ cái kép;
- máy chiến dịch marketing;
- Studio kéo-thả;
- work order / routing.

### 7.6 Quyết định cần chủ shop

Không mục nào dưới đây được máy hay phiên làm việc tự quyết (AGENTS mục 7). Có câu trả lời thì ghi ngày +
nội dung vào cột "Trả lời", rồi gỡ blocker ở §5.2.

| Mã | Câu hỏi | Chặn task | Vì sao cần người quyết | Trả lời |
|---|---|---|---|---|
| Q1 | **Quy trình kiểm kê:** ai đếm, bao lâu một lần (toàn bộ hay xoay vòng theo nhóm), và chênh lệch có cần người thứ hai ký trước khi thành phiếu ADJUSTMENT không? | OD-P3-01, OD-P3-02 | Chênh lệch kiểm kê ĐỔI TỒN KHO. Ai ký là quyết định kiểm soát nội bộ, không phải quyết định kỹ thuật. | — |
| Q2 | **Cơ sở hoa hồng:** theo đơn chốt (POS) hay theo đơn giao thành công? | OD-P4-03 | `COMMISSION_BASIS_NEEDS_REVIEW` (AGENTS 16, 18). Đoán là đổi lương. | — |
| Q3 | **Duyệt hai người:** khi nào có tài khoản thứ hai thật để bật enforcement cho sửa COD · ghi đè ĐVVC · ngân sách QC? | OD-P4-02 | Production có 2 tài khoản (`docs/second-approval-policy.md:47-70`). Bật lúc này là tự khoá mình. | — |
| Q4 | **Sáu nguyên tắc ở §2:** có khớp bản giao việc gốc không? | (cả chương trình) | §2 dựng từ bản giao của Lead và AGENTS, chưa đối chiếu nguyên văn bản gốc. | — |

## 8. Hướng dẫn khôi phục cho phiên sau

1. **Đọc theo thứ tự:**
   1. `AGENTS.md`;
   2. `docs/business-rules/ORDER_OUTCOME.md`;
   3. tệp này;
   4. sổ `/tech` (`npm run ai -- board`, hoặc `docs/tech/MASTER_MISSION_REGISTRY.md` + `CURRENT_CHECKPOINT.md`
      trên nhánh `ai-control/registry`).
2. **Tìm việc kế tiếp:** dòng đầu tiên ở §7.1 hoặc §7.2 (song song) mà §5.2 còn `BACKLOG` hoặc `READY`
   và không `BLOCKED`.
   - Nhánh UI/UX (§7.2): UX-03/03b/04 Lead đã mở; UX-01/02/05 chờ số nền thời gian tải của `code-erp-56`.
   - Phase 3 trở đi chỉ mở khi Phase 2 và nhánh UI/UX xong, VÀ quyết định §7.6 tương ứng đã có câu trả lời.
3. **Nhận việc:**
   - dựng cây làm việc riêng:
     `git worktree add -b claude/<task-id-thường> ../wt-<tên> origin/main` (AGENTS 9);
   - đăng ký: `npm run ai -- claim <task-id> --branch=… --paths=<đúng các tệp>`.
4. **Làm xong:**
   - typecheck · lint · `npm test` đạt;
   - đo trước/sau nếu chạm số;
   - cập nhật dòng của mình ở mục 5.2 TRONG CÙNG PR (trạng thái `IN_REVIEW`, PR, test);
   - `npm run ai -- handoff <task-id> --sha=… --tests=…`.
5. **Sau deploy:** Lead hoặc người xác minh sửa các cột Deploy / Xác minh / trạng thái `DONE` trong một PR
   tài liệu nhỏ, hoặc gộp vào PR kế tiếp.
6. **Trạng thái P0 ở mục 5.1 là ảnh chụp 23/10/2026.** Đối chiếu lại bằng `git log origin/main --grep="(#N)"`
   và `/api/health` trước khi dựa vào nó.

## 9. Nguồn

- Tài liệu Odoo 18.0 đã đọc, chỉ đọc khái niệm, không chép mã:
  - Inventory: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory.html
  - Inventory routes: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/use_routes.html
  - Purchase: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase.html
  - Purchase bills: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase/manage_deals/control_bills.html
  - Manufacturing: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing.html
  - BOM: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/basic_setup/bill_configuration.html
  - Quality: https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/quality.html
  - Accounting: https://www.odoo.com/documentation/18.0/applications/finance/accounting.html
  - Bank reconciliation: https://www.odoo.com/documentation/18.0/applications/finance/accounting/bank/reconciliation.html
  - Payroll: https://www.odoo.com/documentation/18.0/applications/hr/payroll.html
  - Commissions: https://www.odoo.com/documentation/18.0/applications/sales/sales/commissions.html
  - Subscriptions: https://www.odoo.com/documentation/18.0/applications/sales/subscriptions.html
  - CRM: https://www.odoo.com/documentation/18.0/applications/sales/crm.html
  - Lost opportunities: https://www.odoo.com/documentation/18.0/applications/sales/crm/pipeline/lost_opportunities.html
  - Lead scoring: https://www.odoo.com/documentation/18.0/applications/sales/crm/track_leads/lead_scoring.html
  - Activities: https://www.odoo.com/documentation/18.0/applications/essentials/activities.html
  - Helpdesk: https://www.odoo.com/documentation/18.0/applications/services/helpdesk.html
  - Marketing Automation: https://www.odoo.com/documentation/18.0/applications/marketing/marketing_automation.html
  - Studio: https://www.odoo.com/documentation/18.0/applications/studio.html
  - Automation rules: https://www.odoo.com/documentation/18.0/applications/studio/automated_actions.html
  - Search: https://www.odoo.com/documentation/18.0/applications/essentials/search.html
  - Users: https://www.odoo.com/documentation/18.0/applications/general/users.html
  - Companies: https://www.odoo.com/documentation/18.0/applications/general/companies.html
- Không đọc được, HTTP 404: trang Approvals (`applications/productivity/approvals.html`) và trang SLA của
  Helpdesk. Các ô liên quan ghi rõ "không có nội dung tài liệu".
- Một số trang chỉ là mục lục. Nội dung chi tiết lấy từ trang con đã liệt kê. Trước khi trích một ý vào
  quyết định lớn, mở lại đúng URL để đối chiếu.
- Ấn bản: `https://api.github.com/repos/odoo/odoo/contents/addons?ref=18.0` (danh sách tên thư mục,
  23/10/2026).
