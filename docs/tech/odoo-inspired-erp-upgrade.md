# ODOO-INSPIRED ERP TRANSFORMATION — tệp tiến độ bền

> **Đây là tệp tiến độ DUY NHẤT của chương trình.** Phiên nào nhận việc của chương trình thì đọc tệp này
> trước, và cập nhật bảng nhiệm vụ (mục 5) trong CHÍNH PR của việc đó. Không chép trạng thái sang nơi
> khác. Sổ `/tech` (`ai-control/registry`) giữ khoá và lease; tệp này giữ **vì sao · làm gì · tới đâu**.

| | |
|---|---|
| Chủ shop giao | 23/10/2026 |
| Integration Lead | phiên `code-erp-11` (mở PR · cổng · gộp · deploy) |
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
| Phase 2–5: từng PR nhỏ theo mục 7. **Mỗi phase cần Lead duyệt trước khi claim.** | Sổ cái kế toán kép, hoá đơn VAT, kế toán pháp định. ERP là kế toán QUẢN TRỊ (mục 6.4). |
| | Sản xuất nội bộ (work order, routing). Shop thuê xưởng ngoài, xem mục 6.5. |
| | Bất kỳ đổi ngưỡng, quyền hay lịch scheduler nào chưa qua chủ shop (AGENTS mục 7). |

## 4. Trạng thái

| Bước | Trạng thái | Ghi chú |
|---|---|---|
| Phase 1: discovery | `IN_REVIEW` khi PR này mở | Tệp này. |
| Phase 2–5 | `BACKLOG` | Chờ Lead duyệt thứ tự ở mục 7. |

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
| OD-P1-01 | Toàn chương trình | Tệp tiến độ bền + audit 12 nhóm module + lộ trình | phiên này | P2 | IN_REVIEW | (PR này) | — | chỉ tài liệu | — | — | — | Lead gộp. Duyệt mục 7. |
| OD-P2-01 | Dashboards / Views | Bộ lọc yêu thích (favorites) theo người dùng cho `DataTable` | — | P1 | BACKLOG | — | — | — | — | — | — | Lead duyệt Phase 2 |
| OD-P2-02 | Purchase | `suppliers` thành khoá thật cho đơn xưởng (thôi ô chữ) | — | P1 | BACKLOG | — | — | — | — | — | — | — |
| OD-P2-03 | Purchase | Thời gian giao của xưởng đọc `production_orders.received_at` thay vì ghép phiếu nhập | — | P1 | BACKLOG | — | — | — | — | — | — | — |
| OD-P2-04 | Manufacturing | Định mức vải lên máy chủ (thôi `localStorage`), MM-REC-26 | — | P1 | BACKLOG | — | — | — | — | — | — | — |
| OD-P2-05 | Activities | Hẹn việc kế tiếp hiện trên trang chi tiết đơn/vận đơn/khách (phép chiếu, không bảng mới) | — | P2 | BACKLOG | — | — | — | — | — | — | — |
| OD-P3-01 | Inventory | Phiếu kiểm kê (đếm thực tế vs sổ) ⇒ mở được `inventory_accuracy` | — | P1 | BACKLOG | — | — | — | — | — | Chủ shop chốt cách kiểm kê | — |
| OD-P3-02 | Inventory | Kiểm kê xoay vòng (cycle count) theo nhóm mẫu mã | — | P2 | BACKLOG | — | — | — | — | — | Phụ thuộc OD-P3-01 | — |
| OD-P3-03 | Purchase | Trạng thái thanh toán của đơn xưởng (chưa / chờ / đủ), đối chiếu đặt – nhận – trả | — | P1 | BACKLOG | — | — | — | — | — | — | — |
| OD-P3-04 | Purchase / QC | Kiểm hàng nhập từ xưởng (đạt/lỗi) trước khi vào tồn | — | P2 | BACKLOG | — | — | — | — | — | Khảo sát quy trình kho | — |
| OD-P4-01 | Workflow | Trigger theo thời gian + điều kiện trước/sau cho `lib/workflow` | — | P2 | BACKLOG | — | — | — | — | — | — | — |
| OD-P4-02 | Approvals | Nối 3 nhóm duyệt còn thiếu (sửa COD · ghi đè ĐVVC · ngân sách QC) | — | P2 | BLOCKED | — | — | — | — | — | Production có 2 tài khoản (enforcement OFF) | Chủ shop quyết |
| OD-P4-03 | Payroll | Kế hoạch hoa hồng có vòng đời Nháp → Duyệt (đã duyệt không sửa) | — | P2 | BLOCKED | — | — | — | — | — | `COMMISSION_BASIS_NEEDS_REVIEW`: chủ shop chốt cơ sở | — |
| OD-P5-01 | Subscriptions | MRR · churn · gia hạn cho nền tảng SaaS | — | P3 | BACKLOG | — | — | — | — | — | — | — |
| OD-P5-02 | Manufacturing | Khảo sát BOM / định mức đầy đủ (chỉ tài liệu) | — | P3 | BACKLOG | — | — | — | — | — | — | — |

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
    liệu cũ từ `localStorage` bằng tay của người dùng.
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
  - Việc vặt ngoài chương trình: đánh số lại mục 70 trùng trong AGENTS (chỉ khi chủ shop đồng ý sửa
    AGENTS).

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

Thứ tự đi từ **rẻ + an toàn + có bằng chứng** tới **đắt + cần quyết định**. Không phase nào chạm
`ORDER_OUTCOME`, tiền thật hay ngưỡng nghiệp vụ. Mỗi dòng là MỘT PR.

### Phase 2: hoàn thiện cái đang có, rủi ro thấp (không đổi số liệu tiền)

| Thứ tự | Task | PR nhỏ | Vì sao trước | Rủi ro |
|---|---|---|---|---|
| 1 | OD-P2-04 | Định mức vải lên máy chủ (bảng + đọc + nhập tay) | Dữ liệu đang có thể MẤT (`localStorage`) | Thấp |
| 2 | OD-P2-03 | Lead time xưởng đọc `received_at` (giữ dự phòng có nhãn) | Mốc thật đã ghi từ 23/09 mà không ai đọc | Thấp, chỉ báo cáo |
| 3 | OD-P2-02a | `production_orders.supplier_id` nullable + ánh xạ chạy thử | Nền cho mọi số theo nhà cung cấp | Thấp (migration cộng thêm) |
| 4 | OD-P2-02b | Ghi `supplier_id` ở form đơn xưởng, ô chữ thành ảnh chụp tên | Nối tiếp 2a | Thấp |
| 5 | OD-P2-01 | `saved_views` + menu favorites trong `DataTable` | Dùng hằng ngày, trạng thái đã có trên URL | Trung bình (đụng `data-table`, phải build) |
| 6 | OD-P2-05 | Khối "việc kế tiếp" trên trang chi tiết (phép chiếu) | Gom hẹn đang rời rạc | Thấp, chỉ đọc |

### Phase 3: kho và mua hàng đúng chuẩn

| Thứ tự | Task | PR nhỏ | Vì sao | Rủi ro |
|---|---|---|---|---|
| 1 | OD-P3-01a | Bảng `stock_counts` / `stock_count_lines` + màn hình đếm (chưa sinh phiếu) | Mở `inventory_accuracy` bằng nguồn thật | Thấp |
| 2 | OD-P3-01b | Chốt lượt đếm ⇒ ADJUSTMENT có lý do qua đường ghi phiếu kho đang có | Tồn sổ khớp tồn thật | **Trung bình: chạm tồn kho.** Người bấm, đo trước/sau. |
| 3 | OD-P3-01c | Nối `inventory_accuracy` vào sổ chỉ số (`MEASURED`) | Hết `UNAVAILABLE` | Thấp |
| 4 | OD-P3-03 | `workshopBillingStatus()` (đã nhận vs đã trả) + cột `/inventory/workshop` | Thấy ngay xưởng nào trả thừa / thiếu | Thấp, đọc lúc xem |
| 5 | OD-P3-03b | Dư địa ngân sách: "N đơn chưa có giá" là cảnh báo, không cộng 0 | Sửa số trông đẹp hơn thật | Thấp |
| 6 | OD-P3-02 | Kiểm kê xoay vòng | Sau khi 3.1 chạy ổn | Thấp |
| 7 | OD-P3-04 | Kiểm hàng nhập xưởng (sau khảo sát kho) | Lỗi xưởng có chứng cứ | Trung bình |

**Quyết định cần chủ shop trước Phase 3:** quy trình kiểm kê (ai đếm, bao lâu một lần). Chênh lệch có cần
người thứ hai ký không.

### Phase 4: tự động hoá và quy trình duyệt

| Thứ tự | Task | PR nhỏ | Blocker |
|---|---|---|---|
| 1 | OD-P4-01a | Trigger `timer` cho `lib/workflow` (DRY_RUN mặc định) | — |
| 2 | OD-P4-01b | Điều kiện "trước cập nhật" + chặn dây chuyền trong một lượt | — |
| 3 | OD-P4-02 | Nối duyệt cho sửa COD · ghi đè ĐVVC · ngân sách QC | Cần tài khoản thứ hai thật (enforcement OFF) |
| 4 | OD-P4-03 | Kế hoạch hoa hồng Nháp → Duyệt → bất biến | Chủ shop chốt cơ sở hoa hồng (`COMMISSION_BASIS_NEEDS_REVIEW`) |

### Phase 5: SaaS và khảo sát

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

## 8. Hướng dẫn khôi phục cho phiên sau

1. **Đọc theo thứ tự:**
   1. `AGENTS.md`;
   2. `docs/business-rules/ORDER_OUTCOME.md`;
   3. tệp này;
   4. sổ `/tech` (`npm run ai -- board`, hoặc `docs/tech/MASTER_MISSION_REGISTRY.md` + `CURRENT_CHECKPOINT.md`
      trên nhánh `ai-control/registry`).
2. **Tìm việc kế tiếp:** dòng đầu tiên ở mục 7 mà mục 5.2 còn `BACKLOG` hoặc `READY` và không `BLOCKED`.
   Chưa có Lead duyệt phase thì KHÔNG claim.
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
