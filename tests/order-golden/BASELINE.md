# Bộ đo đơn vàng v2 — số đo hiện trạng (BASELINE)

<!-- NỀN ĐO -->
> Đo lúc 08/10/2026 (giờ Việt Nam) trên SHA nền `4c3787ae` — `npx tsx tests/order-golden/update-baseline.ts`.
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

### Công tắc TẮT (mặc định) — chốt sai 4/11 ca (CRITICAL); bỏ 4 ca không có đơn: 4/7

Hàng rào về LỜI ĐỒNG Ý của `confirm_order` chỉ có hai: (i) đơn không được lên / sửa LẦN ĐẦU trong chính lượt chốt — khách phải
thấy tóm tắt ở lượt trước (chặn đúng `chua-dong-y-du-thong-tin`); (ii) lời xác nhận là chuỗi con ≥ 2 ký tự của câu cuối của khách
(`lib/sales-chatbot/tools.ts:638–648`). (ii) chặn được lời model BỊA (ca vàng `chot-khi-chua-dong-y`) nhưng không chặn model TRÍCH
SAI. Mỗi đơn chốt sai đã phát `order.confirmed` ⇒ luật «báo nhóm vận hành» gửi tin như đơn thật.

**LỖI THUẦN MÃ**
1. **Chuỗi chỉ có dấu câu / emoji khớp MỌI câu** — `xac-nhan-chi-dau-cau`: khách đáp «??», model trích «??», gấp dấu ra chuỗi
   RỖNG nên luôn «nằm trong» câu của khách ⇒ «Đã xác nhận». Cùng mẫu kiểm ở `tools.ts:480` (đặt lịch) và `tools.ts:568` (dùng
   địa chỉ cũ).
2. **Độ dài đo trên chữ THÔ, không đo sau khi gấp dấu, và không theo ranh giới từ** (đọc mã, chưa có ca riêng): «on» khớp
   «không»; «ừ» viết dạng tổ hợp (NFD) dài 3 ký tự nên lọt trần `min(2)`. Ca `dong-y-u` (khách chỉ «ừ» dạng dựng sẵn) KHÔNG chốt
   được chỉ vì «ừ» dài MỘT ký tự — không phải vì máy hiểu nghĩa; «ừ ạ» cũng sẽ lọt.
3. **SĐT lưu nguyên dạng khách gõ** (`lib/records/order-create.ts:245` người nhận lấy thẳng ô `phone`, `:265` ghi `ship_phone`) —
   `go-sai-tieng-long` lưu `"0919.000.808"`. So theo số chuẩn hoá thì đúng (bộ đo chấm như vậy) nhưng chuỗi lưu còn dấu chấm.

**QUYẾT ĐỊNH LUẬT**
4. **Phủ định / hoãn trong câu có chữ đồng ý** — `ok-de-hoi-chong` («ok để chị hỏi chồng đã», model trích «ok»),
   `phu-dinh-co-chu-chot` («chị chưa chốt đâu», model trích «chốt») ⇒ «Đã xác nhận». Chặn được cần một luật máy chủ về phủ định /
   hoãn — chủ shop chọn luật.
5. **Chốt khi địa chỉ chưa ghép được xã** — `dia-chi-chua-ghep-xa` ⚖: khách đồng ý thật, địa chỉ chỉ có quận cũ («Hoàn Kiếm»);
   `confirm_order` chỉ đòi tên / SĐT / địa chỉ KHÁC RỖNG. Nhãn an toàn `ADDRESS_UNRESOLVED` (quyết định #5).
6. **Khách huỷ sau khi đã lên nháp** — `huy-sau-tom-tat` ⚖ (`order_intent_precision` 29/30): `mark_declined` không huỷ đơn nháp ⇒
   khách nói «thôi không lấy nữa» mà ERP vẫn còn đơn «Mới». Nhãn mã hoá lựa chọn «huỷ nháp» của quyết định #4.
7. **Sửa SĐT người nhận** — `sua-sdt-tao-lai-khach` (model TRAP): khách sửa SĐT, model sửa bằng `create_customer` thay vì
   `update_draft_order(recipient_phone)` ⇒ hồ sơ mang số mới, người nhận của nháp giữ số CŨ (`human_correction_rate` 1/29).
8. Nhãn an toàn còn chờ quyết định ⚖: `chua-dong-y-du-thong-tin` (khách gửi đủ SĐT + địa chỉ rồi im — quyết định #3; hôm nay máy
   giữ «Mới» = đúng nhãn), `dong-y-u` (luật 6 `engine.ts:166` có coi «ừ» là đồng ý không).

### Công tắc BẬT = luật chủ shop ĐÃ CHỐT 04/10/2026 — chốt sai 2/5; bỏ ca không có đơn: 1/1

`lib/constants/manual-orders.ts:186–195`: «đơn có đủ SĐT, địa chỉ, SKU được tính là đơn hàng luôn, trừ đơn huỷ» (05/10 thêm: địa
chỉ phải ghép được tỉnh + xã), MỘT chỗ cho chatbot, ghi đơn từ hội thoại và form tay; lõi đơn áp có chủ đích
(`order-create.ts:460–467`). Nên dưới BẬT, đơn đủ thông tin mà khách KHÔNG huỷ là ĐÚNG luật (`RULE_AUTO_CONFIRM` ⚖) — kể cả các ca
dưới TẮT là chốt sai hoặc nhãn an toàn (`ok-de-hoi-chong`, `phu-dinh-co-chu-chot`, `xac-nhan-chi-dau-cau`,
`chua-dong-y-du-thong-tin`, `dong-y-u`, `tiep-quan-nguoi`). Còn sai dưới BẬT:
- `huy-sau-tom-tat` — đơn nháp lên «Đã xác nhận» NGAY lúc lên nháp và phát `order.confirmed`, rồi khách huỷ: luật 04/10 trừ đơn
  huỷ, nhưng không gì huỷ nó (cùng gốc với mục 6).
- `dia-chi-chua-ghep-xa` — công tắc giữ nháp «Mới» (đúng luật 05/10), nhưng lời đồng ý với bot vẫn chốt (mục 5).

Câu hỏi cho chủ shop KHÔNG phải «luật 04/10 đúng hay sai» mà chỉ là **có muốn áp luật ấy cho đơn nháp của BOT không**: dưới BẬT,
nháp của bot thành «Đã xác nhận» trước khi khách thấy tóm tắt (kể cả khi nhân viên đã tiếp quản — `tiep-quan-nguoi` ⚖).

### Chung cả hai biến thể

- **Đơn trùng 0/30, thiếu đơn 0/29, bỏ lỡ lời chốt 0.** Tin đặt hàng tới hai lần (`webhook-trung`) sửa ĐÚNG nháp cũ; lời chốt lặp
  rơi vào nhánh «khách nhắn sau khi chốt ⇒ nhân viên»; trạng thái MẤT giữa chừng rồi khách gửi lại (`mat-trang-thai-goi-lai`) ⇒
  khoá lần mua (`raw.agentKey` + `pg_advisory_xact_lock` — `order-create.ts:482–494`) trả lại ĐÚNG đơn cũ. Cột `agentKey` không
  có chỉ mục UNIQUE nên an toàn dựa hoàn toàn vào khoá tư vấn — lượt chạy tuần tự ở đây không thử được hai tiến trình đua nhau.
- **Phần máy chủ tính đúng hết trên dataset:** đơn giá luôn từ ERP (34/34 dòng), tổng gồm ship (29/29), địa chỉ ghép tỉnh + xã
  87/87 thành phần — kể cả địa chỉ CŨ viết tắt «11 hem gia p5 q3 sg» ⇒ Phường Bàn Cờ — và địa chỉ chỉ có quận cũ thì ĐỂ TRỐNG xã.
  SKU + biến thể (29/29) và số lượng (34/34) đúng vì model kịch bản chọn đúng; bộ này chỉ chứng minh máy chủ KHÔNG làm lệch
  chúng. Độ chính xác của MODEL THẬT là việc của bench có model (`sales-bench` / `order-sync-bench`) chạy trên dataset này.

## Luật chủ shop cần quyết (đề xuất cho lát sau — đo lại bằng chính bộ này trước / sau)

1. **Phủ định / hoãn**: luật máy chủ cho câu cuối mang dấu hiệu «chưa», «không», «để … đã», «hỏi chồng / vợ», «xem lại», câu
   hỏi «?» ⇒ giữ «Mới» và hỏi lại. (Lỗi thuần mã 1–2 sửa không cần quyết định: lời xác nhận phải còn chữ SAU gấp dấu, đo độ dài
   sau gấp dấu, khớp theo ranh giới từ.) Mục tiêu đo: `false_auto_confirm_rate` (TẮT) về 0 mà `missed_confirm_rate` vẫn 0.
2. **Luật 04/10 có áp cho nháp của BOT không**: (a) không — bot đã có bước khách đồng ý; (b) có, nhưng sau lời đồng ý; (c) giữ như
   nay. Dưới (c) nhãn BẬT hiện tại là đúng; điều duy nhất còn thiếu là huỷ nháp khi khách huỷ (mục 4).
3. **Một luật «khách tự gửi SĐT + địa chỉ» cho cả hai đường**: đường nhân viên chốt (`order-sync`, luật HSLC 05/10/2026) coi đó là
   CHỐT; đường bot đòi đồng ý sau tóm tắt (nhãn TẮT của `chua-dong-y-du-thong-tin`).
4. **Khách huỷ sau khi đã lên nháp** ⇒ `mark_declined` huỷ (hoặc đánh dấu) đơn nháp của chính hội thoại? (Nhãn hiện tại: huỷ.)
5. **Địa chỉ chưa ghép được xã** ⇒ khách đồng ý thì chốt (như nay) hay giữ «Mới» chờ người chọn xã? (Nhãn hiện tại: giữ «Mới».)
6. **SĐT**: chuẩn hoá SĐT trên đơn bot (lỗi thuần mã 3); khách đổi SĐT của chính mình thì người nhận của nháp (khi người nhận là
   người mua) đổi theo.

Nhãn PHỤ THUỘC LUẬT mang `dependsOn` trong `cases.ts` (dấu ⚖ ở Bảng 3): `RULE_6` (luật 6 của lời nhắc bot — `doi-so-luong`,
`upsell`, `dong-y-ok-tron`), `RULE_AUTO_CONFIRM` (nhãn dưới BẬT), `ADDRESS_UNRESOLVED`, `chua-dong-y-du-thong-tin`, `dong-y-u`,
`huy-sau-tom-tat`. Chủ shop đổi luật ⇒ đổi nhãn của các ca đó, chạy lại lệnh cập nhật.

## Cập nhật số đo

`npm test` so lượt chạy hôm nay với `tests/order-golden/baseline.json` TỪNG Ô và đòi khối bảng dưới đây trùng nguyên văn bảng
dựng lại. Đổi luật / sửa lỗi / thêm ca ⇒ `npx tsx tests/order-golden/update-baseline.ts` (ghi lại `baseline.json`, khối bảng
và dòng «nền đo»), sửa phần nhận định ở trên cho khớp số mới, đưa diff vào PR.

## Bảng số

<!-- BẢNG SỐ ĐO: sinh bởi tests/order-golden/update-baseline.ts — KHÔNG sửa tay -->

**Dataset:** 33 hội thoại (26 model làm đúng · 7 model mắc lỗi có chủ đích) · 20 fanpage · 13 web · 29 ca phải có đơn · nhãn NEED_VERIFICATION: 11 ca dưới TẮT, 5 ca dưới BẬT · 11 ca có nhãn PHỤ THUỘC LUẬT (⚖).

- **TẮT** = Công tắc «đơn đủ thông tin = đã xác nhận» TẮT (mặc định của tổ chức)
- **BẬT** = Công tắc «đơn đủ thông tin = đã xác nhận» BẬT (orders.autoConfirmComplete)

### Bảng 1 — Số đo hiện trạng

| Chỉ số | Tử số / mẫu số | Tốt khi | TẮT | BẬT |
|---|---|---|---|---|
| `order_intent_recall` — Bắt được đơn | ca nhãn PHẢI có đơn (muốn mua + đủ thông tin) mà máy để lại ≥ 1 đơn / ca nhãn phải có đơn | ↑ cao | 100.0% (29/29) | 100.0% (29/29) |
| `order_intent_precision` — Đơn máy tạo là đơn thật | ca máy để lại đơn mà nhãn phải có đơn / ca máy để lại ≥ 1 đơn | ↑ cao | 96.7% (29/30) | 96.7% (29/30) |
| `sku_accuracy` — Đúng SKU (gồm biến thể) | ca chấm được có tập SKU đúng y nhãn / ca chấm được | ↑ cao | 100.0% (29/29) | 100.0% (29/29) |
| `quantity_accuracy` — Đúng số lượng | dòng khớp SKU có đúng SL / dòng khớp SKU | ↑ cao | 100.0% (34/34) | 100.0% (34/34) |
| `phone_accuracy` — Đúng SĐT người nhận | ca chấm được có SĐT đúng (so số chuẩn hoá) / ca chấm được | ↑ cao | 96.6% (28/29) | 96.6% (28/29) |
| `address_component_accuracy` — Đúng thành phần địa chỉ | thành phần đúng / thành phần chấm (tỉnh · xã · dòng địa chỉ; huyện không áp dụng) | ↑ cao | 100.0% (87/87) | 100.0% (87/87) |
| `price_accuracy` — Đúng đơn giá | dòng khớp SKU có đúng đơn giá ERP / dòng khớp SKU | ↑ cao | 100.0% (34/34) | 100.0% (34/34) |
| `total_accuracy` — Đúng tổng tiền khách trả | ca chấm được có tổng (tiền hàng + ship) đúng / ca chấm được | ↑ cao | 100.0% (29/29) | 100.0% (29/29) |
| `false_auto_confirm_rate` — Chốt sai (CRITICAL) | ca nhãn NEED_VERIFICATION (theo biến thể) mà có đơn ĐÃ CHỐT (phát order.confirmed / «Đã xác nhận» trở đi, kể cả đã huỷ sau đó) / ca nhãn NEED_VERIFICATION | ↓ thấp | **36.4% (4/11) ⚠ CRITICAL** | **40.0% (2/5) ⚠ CRITICAL** |
| `missed_confirm_rate` — Bỏ lỡ lời chốt | ca nhãn AUTO_CONFIRM_OK (theo biến thể) mà không có đơn đã chốt / ca nhãn AUTO_CONFIRM_OK | ↓ thấp | 0.0% (0/22) | 0.0% (0/28) |
| `duplicate_order_rate` — Đơn trùng (CRITICAL) | đơn thừa (máy để lại quá số đơn nhãn, tối thiểu 1) / đơn được đếm (còn sống hoặc từng chốt) | ↓ thấp | 0.0% (0/30) | 0.0% (0/30) |
| `missing_order_rate` — Thiếu đơn | đơn nhãn đòi mà máy không để lại / đơn theo nhãn | ↓ thấp | 0.0% (0/29) | 0.0% (0/29) |
| `human_correction_rate` — Đơn người phải sửa | ca chấm được có ≥ 1 trường sai (SKU · SL · đơn giá · SĐT · tỉnh · xã · dòng địa chỉ · tổng) / ca chấm được | ↓ thấp | 3.4% (1/29) | 3.4% (1/29) |

`false_auto_confirm_rate` bỏ các ca NO_ORDER (chỉ ca CÓ đơn phải người xác minh): TẮT 57.1% (4/7) · BẬT 100.0% (1/1).

Thành phần địa chỉ (gộp trong `address_component_accuracy`):

| Thành phần | TẮT | BẬT |
|---|---|---|
| Tỉnh / thành | 100.0% (29/29) | 100.0% (29/29) |
| Xã / phường | 100.0% (29/29) | 100.0% (29/29) |
| Dòng địa chỉ | 100.0% (29/29) | 100.0% (29/29) |

### Bảng 2 — Chốt sai theo căn cứ của nhãn

| Căn cứ | TẮT | BẬT |
|---|---|---|
| `NO_CONSENT` — Khách chưa đồng ý | 75.0% (3/4) | — |
| `AMBIGUOUS_CONSENT` — Lời đồng ý mơ hồ — an toàn: người xác minh | 0.0% (0/1) | — |
| `HUMAN_OWNS` — Hội thoại đang do nhân viên xử lý — chốt là việc của người | 0.0% (0/1) | — |
| `ADDRESS_UNRESOLVED` — Địa chỉ chưa ghép được xã / phường — chưa giao được | 100.0% (1/1) | 100.0% (1/1) |
| `NO_ORDER` — Không có đơn để chốt | 0.0% (0/4) | 25.0% (1/4) |

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
| `huy-sau-tom-tat` | Khách huỷ sau khi đã lên đơn nháp | GOOD | 0 đơn · NEED_VERIFICATION (NO_ORDER) ⚖ | 0 đơn · NEED_VERIFICATION (NO_ORDER) ⚖ | NEW · ✗ đơn không có thật | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai · ✗ đơn không có thật |
| `dia-chi-chua-ghep-xa` | Địa chỉ chưa ghép được xã | GOOD | 1 đơn · NEED_VERIFICATION (ADDRESS_UNRESOLVED) ⚖ | 1 đơn · NEED_VERIFICATION (ADDRESS_UNRESOLVED) ⚖ | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai |
| `bien-the` | Chọn đúng biến thể | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `quy-doi-don-vi` | Quy đổi đơn vị | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `mat-trang-thai-goi-lai` | Mất trạng thái giữa chừng ⇒ khách gửi lại | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `xac-nhan-chi-dau-cau` | Khách đồng ý mơ hồ («ok», «ừ») | TRAP | 1 đơn · NEED_VERIFICATION (NO_CONSENT) | 1 đơn · AUTO_CONFIRM_OK (RULE_AUTO_CONFIRM) ⚖ | CONFIRMED (phát order.confirmed ×1) · ✗ chốt sai | CONFIRMED (phát order.confirmed ×1) · ✓ |
| `dia-chi-cu-viet-tat` | Gõ sai / tiếng lóng | GOOD | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | 1 đơn · AUTO_CONFIRM_OK (CUSTOMER_AGREED) | CONFIRMED (phát order.confirmed ×1) · ✓ | CONFIRMED (phát order.confirmed ×1) · ✓ |

### Bảng 4 — Ca làm sai theo chỉ số

| Chỉ số | TẮT | BẬT |
|---|---|---|
| `order_intent_precision` | `huy-sau-tom-tat` | `huy-sau-tom-tat` |
| `phone_accuracy` | `sua-sdt-tao-lai-khach` | `sua-sdt-tao-lai-khach` |
| `false_auto_confirm_rate` | `ok-de-hoi-chong`, `phu-dinh-co-chu-chot`, `dia-chi-chua-ghep-xa`, `xac-nhan-chi-dau-cau` | `huy-sau-tom-tat`, `dia-chi-chua-ghep-xa` |
| `human_correction_rate` | `sua-sdt-tao-lai-khach` | `sua-sdt-tao-lai-khach` |

<!-- HẾT BẢNG SỐ ĐO -->
