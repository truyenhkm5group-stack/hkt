# ERP DATA TRUTH — BÁO CÁO KIỂM TOÁN KIẾN TRÚC (TASK 1)

> Phạm vi: toàn bộ đường đi của sự thật dữ liệu trong Shop Control ERP — Đơn hàng, Vận đơn,
> Pancake, Viettel Post, COD, Tổng quan, Báo cáo, Chất lượng dữ liệu, Tồn kho, Chi phí/Lợi nhuận,
> Quảng cáo, Nhật ký, cron/queue, schema/migration.
>
> **Kiểm toán này KHÔNG sửa business logic.** Mọi phát hiện được đánh số `F#` và được ánh xạ sang
> kế hoạch thay đổi có thứ tự ở mục 8.
>
> Đặc tả nghiệp vụ ràng buộc: `docs/business-rules/ORDER_OUTCOME.md` (không thương lượng).

---

## 1. Luồng dữ liệu hiện tại

### 1.1 Nạp dữ liệu (ingestion)

| Nguồn | Đường vào | Ghi vào | Ghi chú |
|---|---|---|---|
| Pancake — đơn, sản phẩm, khách | `lib/integrations/pancake/sync.ts` (job) + webhook `app/api/webhooks/pancake/[secret]/[[...event]]` | `orders`, `order_items`, `products`, `customers`, `shipment_events` (bản sao hành trình) | webhook lưu vào `webhook_events` rồi xử lý bất đồng bộ |
| Viettel Post — hành trình | webhook `app/api/webhooks/viettelpost` → `applyVtpTracking(record, "VTP_WEBHOOK")` | `shipment_events`, ảnh chụp `shipments` | trả HTTP 200 ngay, xử lý trong `after()` |
| Viettel Post — tra API | job `vtp_tracking` → `applyVtpTracking(..., "VTP_POLL")` | như trên | tài khoản API có thể KHÔNG sở hữu vận đơn do Pancake tạo (`viettelpost:api-scope`) |
| Viettel Post — tệp danh sách vận đơn | `lib/integrations/viettelpost/import-run.ts` → `applyVtpTracking(..., "VTP_IMPORT")` | như trên | `expandSheetRange()` bắt buộc |
| Viettel Post — bảng kê COD | `lib/integrations/viettelpost/statement.ts` + `statement-db.ts` | `vtp_statement_files`, `cod_statement_lines`, `cod_batches`, `shipments.cod_collected` | **nguồn duy nhất của tiền thực thu** |
| Ngân hàng | `lib/integrations/bank/*` | `expenses` (sổ chứng từ) | |
| Facebook Ads | `lib/integrations/facebook/*` | `ad_spends`, `fb_ads`, `ad_account_billing` | |
| Google Sheet landing | `lib/landing/sheet.ts` | `landing_orders` | chỉ CSV export công khai |

### 1.2 Chuẩn hoá trạng thái vận đơn

`shipments.stage` **không phải ô nhớ ghi đè** mà là ảnh chụp được TÍNH RA từ `shipment_events`:

```
shipment_events  →  deriveShipmentState()  →  materializeShipmentState()  →  shipments.*
   (lịch sử)        (lib/integrations/viettelpost/state.ts)                  (ảnh chụp)
```

- chỉ nhận nguồn `VTP_WEBHOOK | VTP_IMPORT | VTP_POLL | MANUAL` (bản sao Pancake bị loại vì mốc
  thời gian là giờ Pancake ghi nhận, không phải giờ sự kiện của ĐVVC);
- sự kiện mới nhất theo `occurred_at` thắng ⇒ gói tin đến muộn không kéo lùi trạng thái;
- cùng mốc thời gian thì xếp hạng nguồn `VTP_WEBHOOK 40 > VTP_IMPORT 30 > VTP_POLL 20 > MANUAL 15`;
- `onReturnLeg()` quy đổi mã của CHIỀU HOÀN: `501 + RETURN → RETURNED`, `500/506 + RETURN → RETURNING`;
- idempotent: kết quả chỉ phụ thuộc TẬP sự kiện, không phụ thuộc số lần ghi.

Bộ dịch mã ĐVVC → `ShipmentStage` tập trung ở `lib/integrations/viettelpost/status.ts`
(`resolveVtpStatus`) và `lib/constants/viettelpost.ts` (`VTP_FINAL_STATUSES`, `VTP_REASON_CODES`).

### 1.3 Kết luận kết quả đơn

`lib/queries/return-rate.ts` giữ **một** công thức `ORDER_OUTCOME` (và biến thể
`ORDER_OUTCOME_VERIFIED` cho trang Chất lượng dữ liệu). Thứ tự căn cứ:

1. `VTP_RETURNED` / `VTP_CANCELLED` — chứng từ mã cuối của ĐVVC kèm cờ `leg_type`;
2. `GOODS_CAME_BACK` — có vận đơn chiều hoàn, hoặc doanh thu bị sửa sau khi giao;
3. ngưỡng tiền **có số dương** (50K / 100K) trên tiền thực thu + trả trước;
4. `VTP_DELIVERED` (mã 501 chiều đi);
5. trạng thái vận đơn khi có chứng từ ĐVVC (`HAS_VTP_EVIDENCE`);
6. cuối cùng mới tới trạng thái Pancake, và Pancake **không bao giờ** được kết luận `DELIVERED`.

---

## 2. Nguồn sự thật theo từng chiều

| Chiều | Bảng / biểu thức | Nguồn sự thật | Tuyệt đối KHÔNG suy từ |
|---|---|---|---|
| `order_status` | `orders.stage` (`orderStageEnum`, 13 giá trị) | Pancake | trạng thái vận đơn, tiền |
| `shipment_status` | `shipments.stage` (`shipmentStageEnum`, 10 giá trị) — dựng từ `shipment_events` | sự kiện Viettel Post | COD, `cod_status`, bảng kê, Pancake |
| `shipment_outcome` | `ORDER_OUTCOME` / `ORDER_OUTCOME_VERIFIED` | logistics trước, tiền có chứng từ sau | trạng thái Pancake |
| `payment_status` | `shipments.cod_status` (`codStatusEnum`, 6 giá trị) + `shipments.cod_collected` | `cod_statement_lines` (dòng chứng từ bảng kê), sổ ngân hàng | việc đã giao hàng |
| `reconciliation_status` | `SettlementStatus` (`lib/constants/cod.ts`) + `cod_batches` | so tiền thu hộ khai báo với dòng bảng kê thật | trạng thái vận đơn |

Năm chiều đã **tách bạch về mặt kiểu dữ liệu**. Vấn đề còn lại nằm ở một số nơi VIẾT chéo chiều
(mục 5) chứ không nằm ở mô hình.

---

## 3. Bản đồ ánh xạ trạng thái ngoài

| Ánh xạ | Nơi duy nhất | Đã tập trung? |
|---|---|---|
| mã ĐVVC → `ShipmentStage` | `lib/integrations/viettelpost/status.ts::resolveVtpStatus` | có |
| mã cuối ĐVVC | `lib/constants/viettelpost.ts::VTP_FINAL_STATUSES` | có |
| mã lý do ĐVVC (20–47) | `lib/constants/viettelpost.ts::VTP_REASON_CODES` | có |
| cờ `IS_RETURNING` → `leg_type` | `client.ts::normalizeTracking` + `sync.ts::applyVtpTracking` | có (bản ghi chính) / **không** (bước hành trình — xem **F3**) |
| trạng thái Pancake → `OrderStage` | `lib/integrations/pancake/mapper.ts` + `lib/constants/pancake.ts` | có |
| COD → `CodStatus` | `lib/constants/cod.ts::codStatusForAmount` | có (trừ **F2**) |
| ngưỡng nghiệp vụ 50K/100K/10K | `lib/constants/returns.ts::RETURN_RULE` | có |
| hạn trả tiền COD | `lib/constants/cod.ts::COD_OVERDUE_DAYS` | có |

---

## 4. KPI nằm ở đâu

| KPI | Định nghĩa tại | Dùng lại ở |
|---|---|---|
| Kết quả đơn | `return-rate.ts::ORDER_OUTCOME` | dashboard, orders, shipments, reports, payroll, expenses, planning, products, stock, cod-settlement, landing, customers, data-quality |
| Kết quả đơn (đã xác minh tiền) | `return-rate.ts::ORDER_OUTCOME_VERIFIED` | data-quality |
| Phạm vi đơn vào báo cáo | `return-rate.ts::REPORTABLE_ORDER`, `lib/constants/pancake.ts::CONFIRMED_STAGES` | hai phạm vi khác nhau, dùng lẫn — xem **F4** |
| Hàng đã rời kho | `return-rate.ts::SHIPMENT_LEFT_WAREHOUSE` | `stock.ts` |
| Hoàn chờ nhập kho | `return-rate.ts::RETURN_PENDING_WAREHOUSE` | `stock.ts` |
| Tiền có chứng từ | `return-rate.ts::CASH_COLLECTED / VERIFIED_CASH / HAS_CASH_PROOF` | data-quality, cod-settlement |
| Tồn thực tế / khả dụng | `stock.ts::erpStockExpr / availableStockExpr` | products, planning, dashboard, alerts |
| Days of cover / đề xuất SX | `lib/constants/planning.ts::computePlan` | planning, alerts |
| Dòng tiền thật | `profit-cash.ts::getCashProfitReport` | reports (tab Tiền thật) |
| Lợi nhuận danh nghĩa | `profit-nominal.ts` | reports (tab Danh nghĩa) |
| Đối soát COD | `cod-settlement.ts` | cod |

**Không tìm thấy công thức kết quả đơn nào viết lại ngoài `return-rate.ts`.** Việc tập trung
`ORDER_OUTCOME` coi như đã xong từ các đợt trước; kiểm toán này xác nhận lại bằng `grep` toàn kho
mã (chỉ `cod-settlement.ts` có `stage = 'DELIVERED'`, và nó dùng KÈM `ORDER_OUTCOME` để đặt nhãn
`GIAO_NHUNG_HOAN`, không tự kết luận).

---

## 5. Điểm không nhất quán và rủi ro (phát hiện)

### F1 — NGHIÊM TRỌNG: job `data-check` suy `DELIVERED` từ chứng từ tiền và GHI ĐÈ vào `shipments.stage`

`lib/sync/consistency.ts` (khối `codPaidNotDelivered`):

```
COD đã về ngân hàng / đã đối soát ⇒ vận đơn phải là Giao thành công.
db.update(s).set({ stage: "DELIVERED", isFinal: true, deliveredAt: codPaidToBankAt ?? ... })
```

Đây đúng là điều `docs/business-rules/ORDER_OUTCOME.md` mục 10 CẤM: *"Suy `DELIVERED` từ tiền, COD,
`cod_status`, settlement"*. Tệ hơn, nó **ghi vào ảnh chụp logistics**, phá vỡ bất biến "trạng thái
vận đơn là hàm của lịch sử sự kiện". Sau khi ghi, chỉ khi có sự kiện ĐVVC mới thì
`materializeShipmentState()` mới sửa lại được; cho tới lúc đó ERP hiển thị một mốc `delivered_at`
bịa ra từ ngày tiền về ngân hàng.

Job chạy được từ trang Kết nối dữ liệu / `/api/sync/data-check?fix=1`.

### F2 — NGHIÊM TRỌNG: job `data-check` hạ `cod_status` về `NOT_APPLICABLE` cho đơn hoàn/huỷ

`lib/sync/consistency.ts` (khối `returnedWithCod`) mâu thuẫn trực tiếp với
`lib/constants/cod.ts::codStatusForAmount` và với `applyVtpTracking` (đã sửa đúng ở commit
`cd582a1`): *"Hoàn / huỷ KHÔNG được hạ về 'không thu hộ'"*. Chạy `fix=1` một lần là xoá sạch dấu vết
thu hộ của toàn bộ đơn hoàn — đúng loại *silent correction* mà mục 8 của AGENTS.md cấm.

### F3 — CAO: bước hành trình (`journey`) được ghi KHÔNG kèm `leg_type`

`lib/integrations/viettelpost/sync.ts` ghi các bước hành trình mà không truyền `legType`, trong khi
bản ghi chính ngay phía trên thì có. Hậu quả: một bước `501` thuộc CHIỀU HOÀN nằm trong mảng hành
trình sẽ có `normalized_stage = DELIVERED` và `leg_type = NULL`; `deriveShipmentState()` gọi
`onReturnLeg(null, DELIVERED)` → giữ nguyên `DELIVERED`. Tức **mã của chiều hoàn có thể đẩy vận đơn
thành "giao thành công"** — đúng cái bẫy mà toàn bộ kiến trúc `leg_type` sinh ra để chặn.

`ORDER_OUTCOME` vẫn an toàn ở tầng cao (`VTP_DELIVERED` đòi `leg_type = 'OUTBOUND'`), nhưng
`shipments.stage` — thứ mà tồn kho, đối soát COD, hiệu suất giao vận và mọi màn hình theo dõi đang
dùng — thì sai.

### F4 — CAO: hai phạm vi đơn khác nhau dùng lẫn trong cùng một màn hình

`REPORTABLE_ORDER` (`stage <> 'NEW'`) và `CONFIRMED_STAGES` không bằng nhau. Trong
`lib/queries/dashboard.ts`, khối `successCogs` lọc **chỉ** bằng `ORDER_OUTCOME = 'DELIVERED'` mà
**thiếu** `inArray(orders.stage, CONFIRMED_STAGES)` — trong khi `successRevenue` ngay bên trên thì
có. Lợi nhuận ước tính trên Tổng quan vì thế lấy doanh thu của một tập đơn và giá vốn của một tập
đơn KHÁC.

### F5 — CAO: cảnh báo thiếu hàng trên Tổng quan vẫn là ngưỡng cứng `tồn <= 5`

`lib/queries/dashboard.ts` (`lowStock`) dùng `lte(erpStockExpr(...), 5)`, trong khi cảnh báo vận
hành (`lib/alerts/rules.ts`, loại `STOCK_LOW`) đã chuyển sang rủi ro theo `days of cover`. Hai nơi
cho hai con số "cần xử lý" khác nhau, và ngưỡng 5 bỏ qua tốc độ bán lẫn thời gian sản xuất.

### F6 — TRUNG BÌNH: `webhook_events` không có khoá chống trùng

Bảng chỉ có index theo `(source, received_at)` và `status`. Viettel Post thử lại tối đa 5 lần ⇒ mỗi
gói tin lặp tạo thêm một dòng. Không sai kết quả (dedup thật nằm ở `shipment_events_uq`), nhưng làm
số liệu "đã nhận / đã xử lý" trên trang Kết nối dữ liệu không đọc được, và không phân biệt được
*"VTP gửi lại"* với *"VTP gửi sự kiện mới"*.

### F7 — TRUNG BÌNH: không phân biệt `occurred_at` và `received_at` ở tầng webhook

`webhook_events` chỉ có `received_at`. Mốc sự kiện thật chỉ tồn tại sau khi đã bóc thành
`shipment_events.occurred_at`. Gói tin xử lý lỗi (`FAILED`) vì vậy không tra được nó thuộc thời điểm
nào nếu không mở payload.

### F8 — TRUNG BÌNH: quan sát sức khoẻ tích hợp chỉ có cho Viettel Post

`viettelPostHealth()` rất đầy đủ (lag, webhook không áp dụng được, lệch trạng thái, gói tin chưa xử
lý). Pancake / Facebook / Ngân hàng / Landing chỉ có `sync_runs` thô, không có phân loại
`HEALTHY / DEGRADED / DOWN / UNKNOWN`, không có "sự kiện cuối cùng nhận được", không có số gói tin
lỗi theo nguồn.

### F9 — TRUNG BÌNH: chưa có hợp đồng chỉ số (metrics contract)

Định nghĩa KPI nằm rải trong chú thích của từng truy vấn. Không có một tài liệu nói rõ với mỗi chỉ
số: ý nghĩa · tử số · mẫu số · population · loại trừ · trường ngày · nguồn sự thật · bộ lọc · tiền
tệ. Kiểm thử `tests/consistency.test.ts` đã khoá được sự bằng nhau giữa các màn hình, nhưng không
khoá được **định nghĩa**.

### F10 — TRUNG BÌNH: chưa có bộ luật Chất lượng dữ liệu dạng "issue" chuẩn

Trang Chất lượng dữ liệu hiện là 7 nhóm truy vấn (`DQ_ISSUES`) trả về danh sách đơn/vận đơn. Không
có bản ghi *issue* mang `severity / rule / reason / evidence / detected_at / suggested_action /
status`, nên không theo dõi được "vấn đề này đã xử lý chưa", cũng không có các luật mà kế hoạch yêu
cầu: `ORDER_WITH_TRACKING_NO_SHIPMENT`, `DUPLICATE_TRACKING`, `INVALID_EVENT_ORDER`,
`ZERO_TOTAL_WITH_ITEMS`, `UNKNOWN_VTP_STATUS`.

### F11 — THẤP: chưa có bộ kiểm thử bất biến nghiệp vụ tách riêng

`tests/contract-order-outcome.test.ts` khoá 14 tình huống của `ORDER_OUTCOME`; `consistency.test.ts`
khoá sự bằng nhau giữa màn hình. Nhưng chưa khoá: gói tin lặp cho cùng kết quả cuối, sự kiện đến
muộn không phá trạng thái, raw payload được bảo toàn, backfill == realtime, mã ĐVVC lạ không được
âm thầm hoá thành công.

### F12 — THẤP: `ORDER_OUTCOME` chỉ tồn tại ở dạng SQL

Mọi kiểm thử bất biến vì thế phải dựng CSDL. Chưa có cách kiểm tra nhanh các ca biên ở tầng
TypeScript — nhưng cũng KHÔNG được tạo bản thứ hai của luật (mục 10 của đặc tả cấm), nên nếu làm
thì phải sinh ra từ **cùng một** định nghĩa.

---

## 6. Rủi ro xếp theo mức độ

| # | Rủi ro | Ảnh hưởng | Xác suất |
|---|---|---|---|
| F1 | Doanh thu / GTC bị thổi lên vì tiền đẻ ra "đã giao" | Cao — sai KPI ra quyết định | Chỉ khi chạy `fix=1`, nhưng job có sẵn một cú bấm |
| F2 | Mất dấu vết thu hộ của đơn hoàn | Cao — không đòi được tiền ĐVVC | như trên |
| F3 | Vận đơn chiều hoàn thành "giao thành công" ở tầng `shipments.stage` | Cao — sai tồn kho và đối soát | Trung bình (phụ thuộc ĐVVC có gửi hành trình chiều hoàn) |
| F4 | Lợi nhuận ước tính lệch vì lệch population | Trung bình | Cao (luôn xảy ra) |
| F5 | "Cần xử lý" báo sai mặt hàng cần sản xuất | Trung bình | Cao |
| F6/F7 | Không quan sát được luồng webhook | Thấp về số liệu, cao về vận hành | Cao |
| F8 | Tích hợp chết âm thầm (đã từng xảy ra với VTP API) | Trung bình | Trung bình |
| F9/F10/F11 | Không có hàng rào ngăn hồi quy trong tương lai | Trung bình | — |

---

## 7. Kiến trúc đích

```
        ┌──────────── NGUỒN NGOÀI ────────────┐
        │ Pancake   Viettel Post   Bank   FB  │
        └───────┬───────────┬──────────┬──────┘
                │           │          │
         webhook_events   (tệp)     (API)      ← RAW: không ghi đè, không xoá
                │           │          │
                └───────────┴──────────┘
                            │
              ┌─────────────▼──────────────┐
              │ ÁNH XẠ TRẠNG THÁI TẬP TRUNG │  viettelpost/status.ts · pancake/mapper.ts
              └─────────────┬──────────────┘
                            │
                    shipment_events            ← LỊCH SỬ (append-only, idempotent theo
                            │                     shipment+source+status+occurred_at)
              ┌─────────────▼──────────────┐
              │ deriveShipmentState()      │  ← trạng thái = hàm của lịch sử
              └─────────────┬──────────────┘
                            │
   ┌────────────────────────▼─────────────────────────┐
   │ NĂM CHIỀU TÁCH BẠCH                              │
   │ order_status · shipment_status · shipment_outcome │
   │ payment_status · reconciliation_status            │
   └────────────────────────┬─────────────────────────┘
                            │
                    ORDER_OUTCOME (một công thức duy nhất)
                            │
   ┌────────────────────────▼─────────────────────────┐
   │ LỚP CHỈ SỐ — docs/metrics-contract.md            │
   └────────────────────────┬─────────────────────────┘
                            │
        Tổng quan · Báo cáo · Lương · Tồn kho · COD · Chất lượng dữ liệu
```

Nguyên tắc giữ nguyên (đã đúng, không đổi):

1. RAW được bảo toàn (`orders.raw`, `shipments.raw`, `shipment_events.raw`, `webhook_events.payload`).
2. Trạng thái vận đơn là hàm xác định của lịch sử.
3. Một công thức kết quả đơn.
4. `NULL` là CHƯA BIẾT.
5. Hàng hoàn chỉ vào tồn khi kho lập phiếu.

Nguyên tắc phải bổ sung:

6. **Không luồng nào được ghi vào `shipments.stage` ngoài `materializeShipmentState()`.**
7. Sửa dữ liệu tự động chỉ được làm khi kết quả là **xác định** và **truy nguyên được**; ca nhập
   nhằng thì báo cáo, không sửa.
8. Mỗi KPI có đúng một định nghĩa được ghi thành văn bản.

---

## 8. Kế hoạch thay đổi có thứ tự

| Task | Nội dung | Đóng phát hiện |
|---|---|---|
| 2 | Chuẩn hoá lớp chân lý: tách 5 chiều thành kiểu/hằng số dùng chung, khoá bằng kiểm thử | F12 |
| 3 | Cứng hoá nạp dữ liệu Viettel Post: `leg_type` cho bước hành trình, chống trùng webhook, mốc sự kiện, phát lại an toàn | F3, F6, F7 |
| 4 | Bộ máy đối soát: quét chỉ-đọc trước, chỉ tự sửa ca xác định, ghi nhật ký | **F1, F2** |
| 5 | Lớp chân lý chỉ số + `docs/metrics-contract.md` | F4, F9 |
| 6 | Dry-run + backfill an toàn (dựng lại trạng thái từ lịch sử sau khi vá F3) | — |
| 7 | Chất lượng dữ liệu thành trung tâm điều khiển với bộ luật đầy đủ | F10 |
| 8 | Bộ kiểm thử bất biến nghiệp vụ | F11 |
| 9 | Chân lý tài chính: tách booked / delivered / collected / reconciled / cash | F4 |
| 10 | Tồn kho + cảnh báo theo rủi ro thay ngưỡng cứng | F5 |
| 11 | Chỉ số theo mẫu mã | — |
| 12 | Hàng đợi việc cần xử lý theo mức ưu tiên | F5 |
| 13 | Tổng quan phân biệt rõ booked / delivered / cash | F4 |
| 14 | ROAS theo kết quả đơn | — |
| 15 | Sức khoẻ tích hợp cho mọi connector | F8 |
| 16 | Hiệu năng | — |
| 17 | Nhật ký truy vết | — |
| 18 | Nhất quán giao diện | — |

---

## 9. Ảnh chụp nền (đo trước khi sửa)

- `npm run typecheck`: sạch.
- `npm run lint`: sạch.
- `npm test`: **TẤT CẢ KIỂM THỬ ĐẠT** (13 tệp kiểm thử, chạy trên PGlite).
- Số dòng lớp truy vấn: 7.161 (`lib/queries/*.ts`), trong đó `return-rate.ts` 742 dòng.
- Migration đã áp dụng ở production: `0000`–`0020`.
