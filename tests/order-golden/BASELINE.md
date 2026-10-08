# Bộ đo đơn vàng v2 — số đo hiện trạng (BASELINE)

<!-- NỀN ĐO -->
> Đo lúc 08/10/2026 (giờ Việt Nam) trên SHA nền `051f49a5` — `npx tsx tests/order-golden/update-baseline.ts`.
<!-- HẾT NỀN ĐO -->

Sứ mệnh `saas-order-accuracy`, lát C1. Tài liệu này là SỐ ĐO của luật chốt đơn **đang chạy**, để chủ shop quyết luật mới. Lát
này KHÔNG đổi hành vi production nào: không sửa `order-sync.ts`, `tools.ts`, `engine.ts`, `order-create.ts`.

## Đo cái gì, bằng cách nào

- **Dataset** — `tests/order-golden/cases.ts`: hội thoại TỔNG HỢP tiếng Việt (không dấu, viết tắt, nhắn rời, đổi ý…), không
  PII thật (SĐT dạng `09xx000xxx`, số nhà / đường hư cấu). Mỗi ca có NHÃN ĐÚNG: ý định mua, số đơn phải có, SKU / biến thể /
  SL + đơn vị / đơn giá, SĐT người nhận, tỉnh / huyện / xã / dòng địa chỉ, tổng tiền, và đơn **được tự chốt**
  (`AUTO_CONFIRM_OK`) hay **phải người xác minh** (`NEED_VERIFICATION`) kèm CĂN CỨ. Huyện ghi `null`: địa giới từ 01/07/2025
  không còn cấp huyện và đơn ERP không có cột huyện — không chấm.
- **Đường chạy** — `tests/order-golden/harness.ts` dùng LẠI khung hội thoại vàng (`runGoldenCases` ⇒ `chatTurn` thật ⇒ công
  cụ thật ⇒ lõi đơn thật, trên tổ chức PGlite thật). Model là KỊCH BẢN tất định: `GOOD` = làm đúng việc một model tốt sẽ làm (đo
  phần MÁY CHỦ: giá, sửa đơn, chuẩn hoá địa chỉ, chặn chốt, khoá lần mua); `TRAP` = model mắc một lỗi có thật (ghi ở từng ca)
  để đo hàng rào của máy chủ. Đơn đọc thẳng từ CSDL sau mỗi hội thoại; chỉ đơn CÒN SỐNG (không huỷ / xoá) được đếm.
- **Bộ đo** — `lib/sales-chatbot/order-golden-metrics.ts`, hàm thuần. Mẫu số 0 ⇒ `—` (CHƯA ĐO ĐƯỢC), không bao giờ 0%. Chốt
  sai và đơn trùng là CRITICAL: vượt 0 ⇒ cờ.
- **Hai biến thể**, mỗi biến thể một tổ chức thử mới tinh: công tắc «đơn đủ thông tin = đã xác nhận»
  (`orders.autoConfirmComplete`) TẮT (mặc định) và BẬT.
- **Phạm vi**: đường BOT tự trả lời và tự chốt (`chatTurn`). CHƯA phủ — việc của lát sau: (1) đường «ghi đơn từ hội thoại
  nhân viên chốt» (`order-sync.ts` — chạy được bằng Pancake giả như `tests/sales-order-sync.test.ts`); (2) lớp khử trùng webhook
  theo mã tin (`sales_chat_inbound.message_id` UNIQUE) — ca `webhook-trung` đo lớp BOT khi bản lặp đã lọt qua (khách gửi lặp /
  hai đường nhận); (3) hội thoại THẬT của HSLC — cần thao tác ops chỉ-đọc xuất hội thoại từ CSDL tổ chức.

## Kết luận cho chủ shop

1. **Chốt sai khi khách CHƯA đồng ý xảy ra cả khi công tắc TẮT — 4/11 ca (CRITICAL).** Hàng rào về LỜI ĐỒNG Ý của
   `confirm_order` chỉ có hai: (i) đơn không được lên / sửa LẦN ĐẦU trong chính lượt chốt — khách phải thấy tóm tắt ở lượt trước
   (chặn đúng `chua-dong-y-du-thong-tin` khi TẮT); (ii) lời xác nhận là chuỗi con ≥ 2 ký tự của câu cuối của khách
   (`lib/sales-chatbot/tools.ts:638–648`). (ii) chặn được lời model BỊA (ca vàng `chot-khi-chua-dong-y`), nhưng KHÔNG chặn model
   TRÍCH SAI:
   - `ok-de-hoi-chong` — «ok để chị hỏi chồng đã rồi báo em», model trích «ok» ⇒ «Đã xác nhận».
   - `phu-dinh-co-chu-chot` — «khoan, chị chưa chốt đâu…», model trích «chốt» (nằm trong câu PHỦ ĐỊNH) ⇒ «Đã xác nhận».
   - `xac-nhan-chi-dau-cau` — khách đáp «??», model trích «??»: chuỗi chỉ có dấu câu / emoji gấp dấu ra RỖNG nên LUÔN «nằm
     trong» câu của khách ⇒ «Đã xác nhận».
   - `dia-chi-chua-ghep-xa` — khách đồng ý thật, nhưng địa chỉ chỉ có quận cũ («Hoàn Kiếm») nên chưa ghép được xã mới; bot vẫn
     chốt — `confirm_order` chỉ đòi tên / SĐT / địa chỉ KHÁC RỖNG, không đòi ghép được xã (nhãn an toàn: `ADDRESS_UNRESOLVED`).
   Mỗi đơn chốt sai đã phát `order.confirmed` ⇒ luật «báo nhóm vận hành» gửi tin như đơn thật.
2. **Bật công tắc «đơn đủ thông tin = đã xác nhận» ⇒ chốt sai lên 8/11.** Lõi đơn nâng NGAY đơn nháp của bot lên «Đã xác
   nhận» lúc bot vừa lên nháp — trước khi khách thấy tóm tắt (`lib/records/order-create.ts:460–464`, gọi ở `createOrder` /
   `updateOrder`) — và phát `order.confirmed`. Thêm bốn ca sai so với TẮT: khách gửi đủ thông tin rồi im
   (`chua-dong-y-du-thong-tin`), khách chỉ «ừ» (`dong-y-u`), nhân viên đã tiếp quản (`tiep-quan-nguoi`), và khách huỷ sau tóm
   tắt (`huy-sau-tom-tat` — đơn «Đã xác nhận» còn sống dù khách đã nói «không lấy nữa»). Trên 22 ca nhãn cho tự chốt, công tắc
   KHÔNG đổi kết quả (bot đã chốt khi khách đồng ý — «bỏ lỡ lời chốt» 0/22 ở cả hai biến thể): mọi khác biệt nằm ở ca phải người
   xác minh. Nếu chủ shop coi «khách tự gửi SĐT + địa chỉ» là chốt (mục 3 phần dưới) thì `chua-dong-y-du-thong-tin` đổi nhãn và
   là ca DUY NHẤT công tắc làm đúng hơn.
3. **Đơn trùng 0/30, thiếu đơn 0/29 ở cả hai biến thể.** Tin đặt hàng tới hai lần (`webhook-trung`) sửa ĐÚNG đơn nháp cũ; lời
   chốt lặp lại rơi vào nhánh «khách nhắn sau khi chốt ⇒ nhân viên»; trạng thái hội thoại MẤT giữa chừng rồi khách gửi lại
   (`mat-trang-thai-goi-lai`) ⇒ khoá lần mua (`raw.agentKey`, khoá tư vấn `pg_advisory_xact_lock` — `order-create.ts:482–494`)
   trả lại ĐÚNG đơn cũ. Cột `agentKey` không có chỉ mục UNIQUE nên an toàn ĐANG dựa hoàn toàn vào khoá tư vấn — lượt chạy tuần
   tự ở đây không thử được hai tiến trình đua nhau.
4. **Đơn không có thật (`order_intent_precision` 29/30): `huy-sau-tom-tat`.** `mark_declined` không huỷ đơn nháp bot đã ghi
   ⇒ khách nói «thôi không lấy nữa» mà ERP vẫn còn một đơn «Mới» (TẮT) / «Đã xác nhận» (BẬT).
5. **Sai SĐT người nhận: `sua-sdt-tao-lai-khach`.** Khách sửa SĐT, model sửa bằng `create_customer` (số mới) thay vì
   `update_draft_order(recipient_phone)` ⇒ hồ sơ khách mang số mới nhưng người nhận của đơn nháp vẫn giữ số CŨ
   (`tools.ts` — người nhận của đơn nháp chỉ đổi khi `update_draft_order` gửi ô người nhận). Đơn chốt đi với SĐT sai.
6. **Phần máy chủ tính đúng hết trên dataset:** đơn giá luôn từ ERP (34/34 dòng), tổng tiền gồm ship (29/29), địa chỉ ghép
   tỉnh + xã 87/87 thành phần — kể cả địa chỉ CŨ viết tắt «11 hem gia p5 q3 sg» ⇒ Phường Bàn Cờ — và địa chỉ chỉ có quận cũ thì
   ĐỂ TRỐNG xã chứ không đoán. SKU + biến thể (29/29 ca) và số lượng (34/34 dòng) đúng vì model kịch bản chọn đúng; bộ này chỉ
   chứng minh máy chủ KHÔNG làm lệch chúng (gộp dòng, sửa đơn nháp, tìm danh mục theo tên gọi tắt / biến thể). Độ chính xác của
   MODEL THẬT khi đọc khách là việc của bench có model (`sales-bench` / `order-sync-bench`), chạy trên chính dataset này ở lát sau.
7. **Phát hiện phụ (không phải chỉ số):** SĐT lưu trên đơn bot NGUYÊN DẠNG khách gõ — `go-sai-tieng-long` lưu
   `ship_phone = "0919.000.808"`. So theo số chuẩn hoá thì đúng (bộ đo chấm như vậy), nhưng chuỗi lưu còn dấu chấm.

## Luật chủ shop cần quyết (đề xuất cho lát sau — đo lại bằng chính bộ này trước / sau)

1. **Lời đồng ý**: thay «chuỗi con ≥ 2 ký tự» bằng luật máy chủ chặt hơn — lời xác nhận phải còn chữ sau khi gấp dấu, câu cuối
   không mang dấu hiệu PHỦ ĐỊNH / HOÃN («chưa», «không», «để … đã», «hỏi chồng / vợ», «xem lại», câu hỏi «?»); không chắc ⇒ giữ
   «Mới» và hỏi lại. Mục tiêu đo: `false_auto_confirm_rate` (TẮT) về 0 mà `missed_confirm_rate` vẫn 0.
2. **Công tắc tự xác nhận và đơn của BOT**: (a) không áp cho đơn nháp của bot — bot đã có bước khách đồng ý; (b) áp sau khi đã
   có lời đồng ý; hay (c) giữ như nay và chấp nhận 8/11. Trên dataset này (c) không đổi kết quả của ca nào khách đã đồng ý, chỉ
   thêm bốn ca chốt sai (trừ khi mục 3 coi «tự gửi SĐT + địa chỉ» là chốt).
3. **Một luật «khách tự gửi SĐT + địa chỉ» cho cả hai đường**: đường nhân viên chốt (`order-sync`, luật HSLC 05/10/2026) coi đó
   là CHỐT; đường bot đòi khách đồng ý sau tóm tắt. Nhãn hiện tại theo đường bot (`chua-dong-y-du-thong-tin` =
   `NEED_VERIFICATION`).
4. **Khách huỷ sau khi đã lên nháp** ⇒ `mark_declined` huỷ (hoặc đánh dấu) đơn nháp của chính hội thoại?
5. **Địa chỉ chưa ghép được xã** ⇒ khách đồng ý thì chốt (như nay) hay giữ «Mới» chờ người chọn xã? (Nhãn hiện tại: giữ
   «Mới» — căn cứ `ADDRESS_UNRESOLVED`.)
6. **SĐT**: chuẩn hoá SĐT trên đơn bot; khách đổi SĐT của chính mình thì người nhận của đơn nháp (khi người nhận là người mua)
   đổi theo.

Nhãn phụ thuộc luật được đánh dấu bằng căn cứ: `RULE_6` (luật 6 của lời nhắc bot — «ok» trơn sau tóm tắt, thêm / sửa món sau
khi đã thấy tóm tắt là đồng ý: `doi-so-luong`, `upsell`, `dong-y-ok-tron`) và `ADDRESS_UNRESOLVED`. Chủ shop đổi luật ⇒ đổi nhãn
của các ca đó trong `cases.ts`, chạy lại lệnh cập nhật.

## Cập nhật số đo

`npm test` so lượt chạy hôm nay với `tests/order-golden/baseline.json` TỪNG Ô và đòi khối bảng dưới đây trùng nguyên văn bảng
dựng lại. Đổi luật / sửa lỗi / thêm ca ⇒ `npx tsx tests/order-golden/update-baseline.ts` (ghi lại `baseline.json`, khối bảng
và dòng «nền đo»), sửa phần nhận định ở trên cho khớp số mới, đưa diff vào PR.

## Bảng số

<!-- BẢNG SỐ ĐO: sinh bởi tests/order-golden/update-baseline.ts — KHÔNG sửa tay -->

**Dataset:** 33 hội thoại (26 model làm đúng · 7 model mắc lỗi có chủ đích) · 20 fanpage · 13 web · 29 ca phải có đơn · 11 ca nhãn NEED_VERIFICATION · 22 ca nhãn AUTO_CONFIRM_OK.

- **TẮT** = Công tắc «đơn đủ thông tin = đã xác nhận» TẮT (mặc định của tổ chức)
- **BẬT** = Công tắc «đơn đủ thông tin = đã xác nhận» BẬT (orders.autoConfirmComplete)

### Bảng 1 — Số đo hiện trạng

| Chỉ số | Tử số / mẫu số | Tốt khi | TẮT | BẬT |
|---|---|---|---|---|
| `order_intent_recall` — Bắt được đơn | ca nhãn có đơn mà máy tạo ≥ 1 đơn / ca nhãn có đơn | ↑ cao | 100.0% (29/29) | 100.0% (29/29) |
| `order_intent_precision` — Đơn máy tạo là đơn thật | ca máy tạo đơn và nhãn có đơn / ca máy tạo ≥ 1 đơn | ↑ cao | 96.7% (29/30) | 96.7% (29/30) |
| `sku_accuracy` — Đúng SKU (gồm biến thể) | ca chấm được có tập SKU đúng y nhãn / ca chấm được | ↑ cao | 100.0% (29/29) | 100.0% (29/29) |
| `quantity_accuracy` — Đúng số lượng | dòng khớp SKU có đúng SL / dòng khớp SKU | ↑ cao | 100.0% (34/34) | 100.0% (34/34) |
| `phone_accuracy` — Đúng SĐT người nhận | ca chấm được có SĐT đúng (so số chuẩn hoá) / ca chấm được | ↑ cao | 96.6% (28/29) | 96.6% (28/29) |
| `address_component_accuracy` — Đúng thành phần địa chỉ | thành phần đúng / thành phần chấm (tỉnh · xã · dòng địa chỉ; huyện không áp dụng) | ↑ cao | 100.0% (87/87) | 100.0% (87/87) |
| `price_accuracy` — Đúng đơn giá | dòng khớp SKU có đúng đơn giá ERP / dòng khớp SKU | ↑ cao | 100.0% (34/34) | 100.0% (34/34) |
| `total_accuracy` — Đúng tổng tiền khách trả | ca chấm được có tổng (tiền hàng + ship) đúng / ca chấm được | ↑ cao | 100.0% (29/29) | 100.0% (29/29) |
| `false_auto_confirm_rate` — Chốt sai (CRITICAL) | ca nhãn NEED_VERIFICATION mà có đơn «Đã xác nhận» / ca nhãn NEED_VERIFICATION | ↓ thấp | **36.4% (4/11) ⚠ CRITICAL** | **72.7% (8/11) ⚠ CRITICAL** |
| `missed_confirm_rate` — Bỏ lỡ lời chốt | ca nhãn AUTO_CONFIRM_OK mà không có đơn «Đã xác nhận» / ca nhãn AUTO_CONFIRM_OK | ↓ thấp | 0.0% (0/22) | 0.0% (0/22) |
| `duplicate_order_rate` — Đơn trùng (CRITICAL) | đơn thừa (máy tạo quá số nhãn, tối thiểu 1) / đơn máy tạo | ↓ thấp | 0.0% (0/30) | 0.0% (0/30) |
| `missing_order_rate` — Thiếu đơn | đơn nhãn đòi mà máy không tạo / đơn theo nhãn | ↓ thấp | 0.0% (0/29) | 0.0% (0/29) |
| `human_correction_rate` — Đơn người phải sửa | ca chấm được có ≥ 1 trường sai (SKU · SL · đơn giá · SĐT · tỉnh · xã · dòng địa chỉ · tổng) / ca chấm được | ↓ thấp | 3.4% (1/29) | 3.4% (1/29) |

Thành phần địa chỉ (gộp trong `address_component_accuracy`):

| Thành phần | TẮT | BẬT |
|---|---|---|
| Tỉnh / thành | 100.0% (29/29) | 100.0% (29/29) |
| Xã / phường | 100.0% (29/29) | 100.0% (29/29) |
| Dòng địa chỉ | 100.0% (29/29) | 100.0% (29/29) |

### Bảng 2 — Chốt sai theo căn cứ của nhãn

| Căn cứ | TẮT | BẬT |
|---|---|---|
| `NO_CONSENT` — Khách chưa đồng ý | 75.0% (3/4) | 100.0% (4/4) |
| `AMBIGUOUS_CONSENT` — Lời đồng ý mơ hồ — an toàn: người xác minh | 0.0% (0/1) | 100.0% (1/1) |
| `HUMAN_OWNS` — Hội thoại đang do nhân viên xử lý — chốt là việc của người | 0.0% (0/1) | 100.0% (1/1) |
| `ADDRESS_UNRESOLVED` — Địa chỉ chưa ghép được xã / phường — chưa giao được | 100.0% (1/1) | 100.0% (1/1) |
| `NO_ORDER` — Không có đơn để chốt | 0.0% (0/4) | 25.0% (1/4) |

### Bảng 3 — Từng hội thoại

| Ca | Kịch bản | Model | Nhãn | TẮT | BẬT |
|---|---|---|---|---|---|
| `mot-sku` | Một SKU | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `nhieu-sku` | Nhiều SKU | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `doi-so-luong` | Đổi số lượng («không phải 2kg, lấy 1kg») | GOOD | 1 đơn · AUTO_CONFIRM_OK (RULE_6) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `doi-dia-chi` | Đổi địa chỉ | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `sua-sdt` | Sửa SĐT | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `sua-sdt-tao-lai-khach` | Sửa SĐT | TRAP | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✗ sai: phone | CONFIRMED (phát order.confirmed ×1) · ✗ sai: phone |
| `ten-goi-tat` | Tên gọi tắt sản phẩm | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `go-sai-tieng-long` | Gõ sai / tiếng lóng | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `nhieu-tin-roi` | Nhiều tin rời | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `hoi-gia-roi-mua` | Hỏi giá rồi mua | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `tu-choi-roi-quay-lai` | Từ chối rồi quay lại | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `upsell` | Upsell | GOOD | 1 đơn · AUTO_CONFIRM_OK (RULE_6) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `nhac-don-cu` | Nhắc đơn cũ | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `webhook-trung` | Webhook trùng / khách gửi lặp | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `tiep-quan-nguoi` | Tiếp quản người | GOOD | 1 đơn · NEED_VERIFICATION (HUMAN_OWNS) | NEW · ✓ | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai |
| `ai-tiep-tuc` | AI tiếp tục | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `thieu-thong-tin` | Đơn thiếu thông tin | TRAP | 0 đơn · NEED_VERIFICATION (NO_ORDER) | không đơn · ✓ | không đơn · ✓ |
| `sdt-ho-so-nguoi-khac` | SĐT của người khác | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `dat-ho-nguoi-than` | SĐT của người khác | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `dong-y-ok-tron` | Khách đồng ý mơ hồ («ok», «ừ») | GOOD | 1 đơn · AUTO_CONFIRM_OK (RULE_6) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `dong-y-u` | Khách đồng ý mơ hồ («ok», «ừ») | TRAP | 1 đơn · NEED_VERIFICATION (AMBIGUOUS_CONSENT) | NEW · ✓ | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai |
| `ok-de-hoi-chong` | Khách đồng ý mơ hồ («ok», «ừ») | TRAP | 1 đơn · NEED_VERIFICATION (NO_CONSENT) | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai |
| `phu-dinh-co-chu-chot` | Khách đồng ý mơ hồ («ok», «ừ») | TRAP | 1 đơn · NEED_VERIFICATION (NO_CONSENT) | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai |
| `chua-dong-y-du-thong-tin` | Khách chưa đồng ý mà có đủ SĐT + địa chỉ | TRAP | 1 đơn · NEED_VERIFICATION (NO_CONSENT) | NEW · ✓ | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai |
| `hoi-gia-roi-thoi` | Không mua | GOOD | 0 đơn · NEED_VERIFICATION (NO_ORDER) | không đơn · ✓ | không đơn · ✓ |
| `tu-choi-han` | Không mua | GOOD | 0 đơn · NEED_VERIFICATION (NO_ORDER) | không đơn · ✓ | không đơn · ✓ |
| `huy-sau-tom-tat` | Khách huỷ sau khi đã lên đơn nháp | GOOD | 0 đơn · NEED_VERIFICATION (NO_ORDER) | NEW · ✗ đơn không có thật | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai · ✗ đơn không có thật |
| `dia-chi-chua-ghep-xa` | Địa chỉ chưa ghép được xã | GOOD | 1 đơn · NEED_VERIFICATION (ADDRESS_UNRESOLVED) | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai |
| `bien-the` | Chọn đúng biến thể | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `quy-doi-don-vi` | Quy đổi đơn vị | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `mat-trang-thai-goi-lai` | Mất trạng thái giữa chừng ⇒ khách gửi lại | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `xac-nhan-chi-dau-cau` | Khách đồng ý mơ hồ («ok», «ừ») | TRAP | 1 đơn · NEED_VERIFICATION (NO_CONSENT) | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai |
| `dia-chi-cu-viet-tat` | Gõ sai / tiếng lóng | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |

### Bảng 4 — Ca làm sai theo chỉ số

| Chỉ số | TẮT | BẬT |
|---|---|---|
| `order_intent_precision` | `huy-sau-tom-tat` | `huy-sau-tom-tat` |
| `phone_accuracy` | `sua-sdt-tao-lai-khach` | `sua-sdt-tao-lai-khach` |
| `false_auto_confirm_rate` | `ok-de-hoi-chong`, `phu-dinh-co-chu-chot`, `dia-chi-chua-ghep-xa`, `xac-nhan-chi-dau-cau` | `tiep-quan-nguoi`, `dong-y-u`, `ok-de-hoi-chong`, `phu-dinh-co-chu-chot`, `chua-dong-y-du-thong-tin`, `huy-sau-tom-tat`, `dia-chi-chua-ghep-xa`, `xac-nhan-chi-dau-cau` |
| `human_correction_rate` | `sua-sdt-tao-lai-khach` | `sua-sdt-tao-lai-khach` |

<!-- HẾT BẢNG SỐ ĐO -->
