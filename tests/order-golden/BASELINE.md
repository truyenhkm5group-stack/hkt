# Bộ đo đơn vàng v2 — số đo hiện trạng (BASELINE)

<!-- NỀN ĐO -->
> Đo lúc 08/10/2026 (giờ Việt Nam) trên SHA nền `c360b7c6` — `npx tsx tests/order-golden/update-baseline.ts`.
<!-- HẾT NỀN ĐO -->

Sứ mệnh `saas-order-accuracy`, lát C1 (bộ đo) + lát `order-confirm-rules` (luật chủ shop 08/10/2026 + sửa lỗi thuần mã). Tài liệu
này là SỐ ĐO của luật chốt đơn **đang chạy**, để chủ shop quyết luật mới.

## Đo cái gì, bằng cách nào

- **Dataset** — `tests/order-golden/cases.ts`: hội thoại TỔNG HỢP tiếng Việt (không dấu, viết tắt, nhắn rời, đổi ý…), không
  PII thật (SĐT dạng `09xx000xxx`, số nhà / đường hư cấu). Mỗi ca có NHÃN ĐÚNG: ý định mua, số đơn phải có, SKU / biến thể /
  SL + đơn vị / đơn giá, SĐT người nhận, tỉnh / huyện / xã / dòng địa chỉ, tổng tiền, và đơn **được tự chốt**
  (`AUTO_CONFIRM_OK`) hay **phải người xác minh** (`NEED_VERIFICATION`) kèm CĂN CỨ. Huyện ghi `null`: địa giới từ 01/07/2025
  không còn cấp huyện và đơn ERP không có cột huyện — không chấm.
- **Đường chạy** — `tests/order-golden/harness.ts` dùng LẠI khung hội thoại vàng (`runGoldenCases` ⇒ `chatTurn` thật ⇒ công
  cụ thật ⇒ lõi đơn thật, trên tổ chức PGlite thật). Model là KỊCH BẢN tất định: `GOOD` = làm đúng việc một model tốt sẽ làm (đo
  phần MÁY CHỦ: giá, sửa đơn, chuẩn hoá địa chỉ, chặn chốt, khoá lần mua); `TRAP` = model mắc một lỗi có thật (ghi ở từng ca)
  để đo hàng rào của máy chủ. Đơn đọc thẳng từ CSDL sau mỗi hội thoại. «Đã chốt» = đã phát `order.confirmed` hoặc ở «Đã xác
  nhận» trở đi, KỂ CẢ đơn sau đó bị huỷ; đơn được đếm = còn sống hoặc từng chốt.
- **Bộ đo** — `lib/sales-chatbot/order-golden-metrics.ts`, hàm thuần. Mẫu số 0 ⇒ `—` (CHƯA ĐO ĐƯỢC), không bao giờ 0%. Chốt
  sai và đơn trùng là CRITICAL: vượt 0 ⇒ cờ.
- **Hai biến thể**, mỗi biến thể một tổ chức thử mới tinh: công tắc «đơn đủ thông tin = đã xác nhận»
  (`orders.autoConfirmComplete`) TẮT (mặc định) và BẬT. NHÃN theo TỪNG biến thể: BẬT là luật chủ shop đã chốt 04/10/2026, nên
  dưới BẬT đơn đủ thông tin mà khách không huỷ là `AUTO_CONFIRM_OK` (`confirmWhenAutoConfirmOn` trong `cases.ts`).
- **Phạm vi**: đường BOT tự trả lời và tự chốt (`chatTurn`). CHƯA phủ — việc của lát sau: (1) đường «ghi đơn từ hội thoại
  nhân viên chốt» (`order-sync.ts` — chạy được bằng Pancake giả như `tests/sales-order-sync.test.ts`); (2) lớp khử trùng webhook
  theo mã tin (`sales_chat_inbound.message_id` UNIQUE) — ca `webhook-trung` đo lớp BOT khi bản lặp đã lọt qua (khách gửi lặp /
  hai đường nhận); (3) hội thoại THẬT của HSLC — cần thao tác ops chỉ-đọc xuất hội thoại từ CSDL tổ chức.

## Kết luận cho chủ shop

Phát hiện chia hai loại theo review độc lập #664: **LỖI THUẦN MÃ** (sửa được mà không cần chủ shop quyết gì) và **QUYẾT ĐỊNH
LUẬT** (máy đang làm theo một lựa chọn chưa ai chốt — nhãn của các ca này mang dấu ⚖ `dependsOn` và đổi theo quyết định).

### Trước / sau lát `order-confirm-rules` (08/10/2026)

| | TẮT trước | TẮT sau | BẬT trước | BẬT sau |
|---|---|---|---|---|
| Chốt sai (`false_auto_confirm_rate`) | 4/11 | **2/10** | 2/5 | **0/3** |
| Đơn trùng | 0/30 | 0/30 | 0/30 | 0/30 |
| Thiếu đơn | 0/29 | 0/30 | 0/29 | 0/30 |
| Bỏ lỡ lời chốt | 0/22 | 0/23 | 0/28 | 0/30 |
| Đúng cờ CẦN NGƯỜI KIỂM (chỉ số mới) | — | 30/30 | — | 30/30 |
| … chỉ trên ca nhãn đòi cờ (độ nhạy) | — | 2/2 | — | 2/2 |

Mẫu số đổi vì NHÃN đổi theo quyết định của chủ shop 08/10/2026 (không phải vì đo dễ hơn): (1) luật 04/10 «đơn đủ thông tin = đã
xác nhận» CÓ áp cho nháp của bot — giữ nguyên hành vi; (2) khách huỷ sau khi đã có đơn ⇒ `mark_declined` KHÔNG huỷ đơn, ghi chú
«khách huỷ» (nguyên văn + mốc) + cờ CẦN NGƯỜI KIỂM, người huỷ hoặc xác nhận lại — `huy-sau-tom-tat` nay là «1 đơn + cờ»; (3) địa
chỉ chưa ghép được xã ⇒ VẪN chốt + cờ CẦN NGƯỜI KIỂM — `dia-chi-chua-ghep-xa` nay là «chốt + cờ» (khỏi mẫu số chốt sai). Cờ nằm ở
`orders.raw.review` (`lib/constants/order-review.ts`), chấm hai chiều ở `review_flag_accuracy`. Lỗi thuần mã đã sửa:

1. **Lời xác nhận chỉ có dấu câu / emoji / một chữ / chuỗi con giữa từ** — MỘT hàm `quotedInText` (`lib/sales-chatbot/text.ts`)
   cho chốt đơn, đặt lịch và dùng địa chỉ cũ: sau NFC + gấp dấu phải còn ≥ 2 chữ cái / chữ số, khớp theo RANH GIỚI TỪ («on»
   không khớp «không», «ok» không khớp «okie»). `xac-nhan-chi-dau-cau` («??») nay bị máy chủ từ chối ⇒ đơn giữ «Mới». Luật là
   luật HAI CHỮ, không phải luật nghĩa: «ừ ạ» vẫn qua — chặn nó là việc của luật phủ định / mơ hồ (mục 1 bên dưới).
2. **SĐT người nhận chuẩn hoá ở ĐƯỜNG GHI** (`prepare()` trong `lib/records/order-create.ts`, cùng `normalizeCustomerPhone` của hồ
   sơ khách): «0919.000.808» lưu «0919000808». Không backfill đơn cũ.

### Còn lại — chốt sai TẮT 2/10 (CRITICAL)

- `ok-de-hoi-chong` («ok để chị hỏi chồng đã», model trích «ok») và `phu-dinh-co-chu-chot` («chị chưa chốt đâu», model trích
  «chốt»): lời trích ĐÚNG là nguyên văn, theo ranh giới từ — chặn được cần luật máy chủ về PHỦ ĐỊNH / HOÃN (quyết định luật).
- Dưới BẬT không còn chốt sai: đơn đủ thông tin mà khách không huỷ là đúng luật 04/10 (`RULE_AUTO_CONFIRM` ⚖).
- `sua-sdt-tao-lai-khach` (model TRAP): khách sửa SĐT, model sửa bằng `create_customer` thay vì `update_draft_order(recipient_phone)`
  ⇒ người nhận của nháp giữ số CŨ (`human_correction_rate` 1/30).

### Chung cả hai biến thể

- **Đơn trùng 0/30, thiếu đơn 0/30, bỏ lỡ lời chốt 0.** Tin đặt hàng tới hai lần (`webhook-trung`) sửa ĐÚNG nháp cũ; lời chốt lặp
  rơi vào nhánh «khách nhắn sau khi chốt ⇒ nhân viên»; trạng thái MẤT giữa chừng rồi khách gửi lại (`mat-trang-thai-goi-lai`) ⇒
  khoá lần mua (`raw.agentKey` + `pg_advisory_xact_lock` — `order-create.ts`) trả lại ĐÚNG đơn cũ. Cột `agentKey` không có chỉ mục
  UNIQUE nên an toàn dựa hoàn toàn vào khoá tư vấn — lượt chạy tuần tự ở đây không thử được hai tiến trình đua nhau.
- **Phần máy chủ tính đúng hết trên dataset:** đơn giá luôn từ ERP (35/35 dòng), tổng gồm ship (30/30), địa chỉ ghép tỉnh + xã
  90/90 thành phần — kể cả địa chỉ CŨ viết tắt «11 hem gia p5 q3 sg» ⇒ Phường Bàn Cờ — và địa chỉ chỉ có quận cũ thì ĐỂ TRỐNG xã.
  SKU + biến thể và số lượng đúng vì model kịch bản chọn đúng; bộ này chỉ chứng minh máy chủ KHÔNG làm lệch chúng. Độ chính xác
  của MODEL THẬT là việc của bench có model (`sales-bench` / `order-sync-bench`) chạy trên dataset này.

## Luật chủ shop còn cần quyết (đo lại bằng chính bộ này trước / sau)

1. **Phủ định / hoãn**: luật máy chủ cho câu cuối mang dấu hiệu «chưa», «không», «để … đã», «hỏi chồng / vợ», «xem lại», câu
   hỏi «?» ⇒ giữ «Mới» và hỏi lại. Mục tiêu đo: `false_auto_confirm_rate` (TẮT) về 0 mà `missed_confirm_rate` vẫn 0.
2. **Một luật «khách tự gửi SĐT + địa chỉ» cho cả hai đường**: đường nhân viên chốt (`order-sync`, luật HSLC 05/10/2026) coi đó là
   CHỐT; đường bot đòi đồng ý sau tóm tắt (nhãn TẮT của `chua-dong-y-du-thong-tin`).
3. **SĐT**: khách đổi SĐT của chính mình thì người nhận của nháp (khi người nhận là người mua) đổi theo?

Đã quyết 08/10/2026 (nhãn đã đổi): luật 04/10 áp cho nháp bot; khách huỷ ⇒ ghi chú + cờ, không tự huỷ; xã chưa ghép ⇒ chốt + cờ.

Nhãn PHỤ THUỘC LUẬT mang `dependsOn` trong `cases.ts` (dấu ⚖ ở Bảng 3): `RULE_6` (luật 6 của lời nhắc bot — `doi-so-luong`,
`upsell`, `dong-y-ok-tron`), `RULE_AUTO_CONFIRM` (nhãn dưới BẬT), quyết định 08/10/2026 (`huy-sau-tom-tat`, `dia-chi-chua-ghep-xa`),
`chua-dong-y-du-thong-tin`, `dong-y-u`. Chủ shop đổi luật ⇒ đổi nhãn của các ca đó, chạy lại lệnh cập nhật.

## Cập nhật số đo

`npm test` so lượt chạy hôm nay với `tests/order-golden/baseline.json` TỪNG Ô và đòi khối bảng dưới đây trùng nguyên văn bảng
dựng lại. Đổi luật / sửa lỗi / thêm ca ⇒ `npx tsx tests/order-golden/update-baseline.ts` (ghi lại `baseline.json`, khối bảng
và dòng «nền đo»), sửa phần nhận định ở trên cho khớp số mới, đưa diff vào PR.

## Bảng số

<!-- BẢNG SỐ ĐO: sinh bởi tests/order-golden/update-baseline.ts — KHÔNG sửa tay -->

**Dataset:** 33 hội thoại (26 model làm đúng · 7 model mắc lỗi có chủ đích) · 20 fanpage · 13 web · 30 ca phải có đơn · nhãn NEED_VERIFICATION: 10 ca dưới TẮT, 3 ca dưới BẬT · 11 ca có nhãn PHỤ THUỘC LUẬT (⚖).

- **TẮT** = Công tắc «đơn đủ thông tin = đã xác nhận» TẮT (mặc định của tổ chức)
- **BẬT** = Công tắc «đơn đủ thông tin = đã xác nhận» BẬT (orders.autoConfirmComplete)

### Bảng 1 — Số đo hiện trạng

| Chỉ số | Tử số / mẫu số | Tốt khi | TẮT | BẬT |
|---|---|---|---|---|
| `order_intent_recall` — Bắt được đơn | ca nhãn PHẢI có đơn (muốn mua + đủ thông tin) mà máy để lại ≥ 1 đơn / ca nhãn phải có đơn | ↑ cao | 100.0% (30/30) | 100.0% (30/30) |
| `order_intent_precision` — Đơn máy tạo là đơn thật | ca máy để lại đơn mà nhãn phải có đơn / ca máy để lại ≥ 1 đơn | ↑ cao | 100.0% (30/30) | 100.0% (30/30) |
| `sku_accuracy` — Đúng SKU (gồm biến thể) | ca chấm được có tập SKU đúng y nhãn / ca chấm được | ↑ cao | 100.0% (30/30) | 100.0% (30/30) |
| `quantity_accuracy` — Đúng số lượng | dòng khớp SKU có đúng SL / dòng khớp SKU | ↑ cao | 100.0% (35/35) | 100.0% (35/35) |
| `phone_accuracy` — Đúng SĐT người nhận | ca chấm được có SĐT đúng (so số chuẩn hoá) / ca chấm được | ↑ cao | 96.7% (29/30) | 96.7% (29/30) |
| `address_component_accuracy` — Đúng thành phần địa chỉ | thành phần đúng / thành phần chấm (tỉnh · xã · dòng địa chỉ; huyện không áp dụng) | ↑ cao | 100.0% (90/90) | 100.0% (90/90) |
| `price_accuracy` — Đúng đơn giá | dòng khớp SKU có đúng đơn giá ERP / dòng khớp SKU | ↑ cao | 100.0% (35/35) | 100.0% (35/35) |
| `total_accuracy` — Đúng tổng tiền khách trả | ca chấm được có tổng (tiền hàng + ship) đúng / ca chấm được | ↑ cao | 100.0% (30/30) | 100.0% (30/30) |
| `false_auto_confirm_rate` — Chốt sai (CRITICAL) | ca nhãn NEED_VERIFICATION (theo biến thể) mà có đơn ĐÃ CHỐT (phát order.confirmed / «Đã xác nhận» trở đi, kể cả đã huỷ sau đó) / ca nhãn NEED_VERIFICATION | ↓ thấp | **20.0% (2/10) ⚠ CRITICAL** | 0.0% (0/3) |
| `missed_confirm_rate` — Bỏ lỡ lời chốt | ca nhãn AUTO_CONFIRM_OK (theo biến thể) mà không có đơn đã chốt / ca nhãn AUTO_CONFIRM_OK | ↓ thấp | 0.0% (0/23) | 0.0% (0/30) |
| `duplicate_order_rate` — Đơn trùng (CRITICAL) | đơn thừa (máy để lại quá số đơn nhãn, tối thiểu 1) / đơn được đếm (còn sống hoặc từng chốt) | ↓ thấp | 0.0% (0/30) | 0.0% (0/30) |
| `missing_order_rate` — Thiếu đơn | đơn nhãn đòi mà máy không để lại / đơn theo nhãn | ↓ thấp | 0.0% (0/30) | 0.0% (0/30) |
| `human_correction_rate` — Đơn người phải sửa | ca chấm được có ≥ 1 trường sai (SKU · SL · đơn giá · SĐT · tỉnh · xã · dòng địa chỉ · tổng) / ca chấm được | ↓ thấp | 3.3% (1/30) | 3.3% (1/30) |
| `review_flag_accuracy` — Đúng cờ cần người kiểm | ca chấm được có cờ CẦN NGƯỜI KIỂM đúng nhãn (đủ lý do nhãn đòi, không lý do thừa) / ca chấm được | ↑ cao | 100.0% (30/30) | 100.0% (30/30) |

`false_auto_confirm_rate` bỏ các ca NO_ORDER (chỉ ca CÓ đơn phải người xác minh): TẮT 28.6% (2/7) · BẬT — (0/0).

`review_flag_accuracy` chỉ trên ca DƯƠNG (nhãn đòi cờ cần người kiểm — độ nhạy): TẮT 100.0% (2/2) · BẬT 100.0% (2/2).

Thành phần địa chỉ (gộp trong `address_component_accuracy`):

| Thành phần | TẮT | BẬT |
|---|---|---|
| Tỉnh / thành | 100.0% (30/30) | 100.0% (30/30) |
| Xã / phường | 100.0% (30/30) | 100.0% (30/30) |
| Dòng địa chỉ | 100.0% (30/30) | 100.0% (30/30) |

### Bảng 2 — Chốt sai theo căn cứ của nhãn

| Căn cứ | TẮT | BẬT |
|---|---|---|
| `NO_CONSENT` — Khách chưa đồng ý | 40.0% (2/5) | — |
| `AMBIGUOUS_CONSENT` — Lời đồng ý mơ hồ — an toàn: người xác minh | 0.0% (0/1) | — |
| `HUMAN_OWNS` — Hội thoại đang do nhân viên xử lý — chốt là việc của người | 0.0% (0/1) | — |
| `NO_ORDER` — Không có đơn để chốt | 0.0% (0/3) | 0.0% (0/3) |

### Bảng 3 — Từng hội thoại

⚖ = nhãn PHỤ THUỘC LUẬT / quyết định của chủ shop (`dependsOn` trong `cases.ts`).

| Ca | Kịch bản | Model | Nhãn TẮT | Nhãn BẬT | Đo TẮT | Đo BẬT |
|---|---|---|---|---|---|---|
| `mot-sku` | Một SKU | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `nhieu-sku` | Nhiều SKU | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `doi-so-luong` | Đổi số lượng («không phải 2kg, lấy 1kg») | GOOD | 1 đơn · AUTO_CONFIRM_OK (RULE_6) ⚖ | 1 đơn · AUTO_CONFIRM_OK (RULE_6) ⚖ | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `doi-dia-chi` | Đổi địa chỉ | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `sua-sdt` | Sửa SĐT | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `sua-sdt-tao-lai-khach` | Sửa SĐT | TRAP | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✗ sai: phone | CONFIRMED (phát order.confirmed ×1) · ✗ sai: phone |
| `ten-goi-tat` | Tên gọi tắt sản phẩm | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `go-sai-tieng-long` | Gõ sai / tiếng lóng | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `nhieu-tin-roi` | Nhiều tin rời | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `hoi-gia-roi-mua` | Hỏi giá rồi mua | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `tu-choi-roi-quay-lai` | Từ chối rồi quay lại | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `upsell` | Upsell | GOOD | 1 đơn · AUTO_CONFIRM_OK (RULE_6) ⚖ | 1 đơn · AUTO_CONFIRM_OK (RULE_6) ⚖ | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `nhac-don-cu` | Nhắc đơn cũ | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `webhook-trung` | Webhook trùng / khách gửi lặp | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `tiep-quan-nguoi` | Tiếp quản người | GOOD | 1 đơn · NEED_VERIFICATION (HUMAN_OWNS) | 1 đơn · AUTO_CONFIRM_OK (RULE_AUTO_CONFIRM) ⚖ | NEW · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `ai-tiep-tuc` | AI tiếp tục | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `thieu-thong-tin` | Đơn thiếu thông tin | TRAP | 0 đơn · NEED_VERIFICATION (NO_ORDER) | 0 đơn · NEED_VERIFICATION (NO_ORDER) | không đơn · ✓ | không đơn · ✓ |
| `sdt-ho-so-nguoi-khac` | SĐT của người khác | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `dat-ho-nguoi-than` | SĐT của người khác | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `dong-y-ok-tron` | Khách đồng ý mơ hồ («ok», «ừ») | GOOD | 1 đơn · AUTO_CONFIRM_OK (RULE_6) ⚖ | 1 đơn · AUTO_CONFIRM_OK (RULE_6) ⚖ | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `dong-y-u` | Khách đồng ý mơ hồ («ok», «ừ») | TRAP | 1 đơn · NEED_VERIFICATION (AMBIGUOUS_CONSENT) ⚖ | 1 đơn · AUTO_CONFIRM_OK (RULE_AUTO_CONFIRM) ⚖ | NEW · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `ok-de-hoi-chong` | Khách đồng ý mơ hồ («ok», «ừ») | TRAP | 1 đơn · NEED_VERIFICATION (NO_CONSENT) | 1 đơn · AUTO_CONFIRM_OK (RULE_AUTO_CONFIRM) ⚖ | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `phu-dinh-co-chu-chot` | Khách đồng ý mơ hồ («ok», «ừ») | TRAP | 1 đơn · NEED_VERIFICATION (NO_CONSENT) | 1 đơn · AUTO_CONFIRM_OK (RULE_AUTO_CONFIRM) ⚖ | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `chua-dong-y-du-thong-tin` | Khách chưa đồng ý mà có đủ SĐT + địa chỉ | TRAP | 1 đơn · NEED_VERIFICATION (NO_CONSENT) ⚖ | 1 đơn · AUTO_CONFIRM_OK (RULE_AUTO_CONFIRM) ⚖ | NEW · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `hoi-gia-roi-thoi` | Không mua | GOOD | 0 đơn · NEED_VERIFICATION (NO_ORDER) | 0 đơn · NEED_VERIFICATION (NO_ORDER) | không đơn · ✓ | không đơn · ✓ |
| `tu-choi-han` | Không mua | GOOD | 0 đơn · NEED_VERIFICATION (NO_ORDER) | 0 đơn · NEED_VERIFICATION (NO_ORDER) | không đơn · ✓ | không đơn · ✓ |
| `huy-sau-tom-tat` | Khách huỷ sau khi đã lên đơn nháp | GOOD | 1 đơn · NEED_VERIFICATION (NO_CONSENT) + ⚑ CUSTOMER_CANCELLED ⚖ | 1 đơn · AUTO_CONFIRM_OK (RULE_AUTO_CONFIRM) + ⚑ CUSTOMER_CANCELLED ⚖ | NEW ⚑ cần kiểm: CUSTOMER_CANCELLED · ✓ | CONFIRMED (phát order.confirmed ×1) ⚑ cần kiểm: CUSTOMER_CANCELLED · ✓ |
| `dia-chi-chua-ghep-xa` | Địa chỉ chưa ghép được xã | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) + ⚑ ADDRESS_UNRESOLVED ⚖ | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) + ⚑ ADDRESS_UNRESOLVED ⚖ | CONFIRMED (phát order.confirmed ×1) ⚑ cần kiểm: ADDRESS_UNRESOLVED · ✓ | CONFIRMED (phát order.confirmed ×1) ⚑ cần kiểm: ADDRESS_UNRESOLVED · ✓ |
| `bien-the` | Chọn đúng biến thể | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `quy-doi-don-vi` | Quy đổi đơn vị | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `mat-trang-thai-goi-lai` | Mất trạng thái giữa chừng ⇒ khách gửi lại | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `xac-nhan-chi-dau-cau` | Khách đồng ý mơ hồ («ok», «ừ») | TRAP | 1 đơn · NEED_VERIFICATION (NO_CONSENT) | 1 đơn · AUTO_CONFIRM_OK (RULE_AUTO_CONFIRM) ⚖ | NEW · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `dia-chi-cu-viet-tat` | Gõ sai / tiếng lóng | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |

### Bảng 4 — Ca làm sai theo chỉ số

| Chỉ số | TẮT | BẬT |
|---|---|---|
| `phone_accuracy` | `sua-sdt-tao-lai-khach` | `sua-sdt-tao-lai-khach` |
| `false_auto_confirm_rate` | `ok-de-hoi-chong`, `phu-dinh-co-chu-chot` | — |
| `human_correction_rate` | `sua-sdt-tao-lai-khach` | `sua-sdt-tao-lai-khach` |

<!-- HẾT BẢNG SỐ ĐO -->
