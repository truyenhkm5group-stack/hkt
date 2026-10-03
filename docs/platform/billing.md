# Thu phí thuê bao — Vertical SaaS Factory · bước 1

> Migration `0187_platform_billing`. Mã: `lib/billing/rules.ts` (luật thuần) · `lib/billing/standing.ts` (đọc tình trạng,
> có đệm) · `lib/billing/service.ts` (đường ghi duy nhất) · `lib/actions/billing.ts`. Kiểm thử: `tests/platform-billing.test.ts`.

## 1. Mô hình: "trả tới ngày"

Mỗi tổ chức khách có đúng một con số: **`paid_through`**. Đó là ngày cuối cùng đã trả, tính theo giờ Việt Nam và tính cả
ngày đó. Tình trạng **không lưu ở đâu cả**. Nó là hàm thuần của `paid_through`, số ngày ân hạn và hôm nay:

| Hôm nay so với `paid_through` | Tình trạng | Dùng được |
|---|---|---|
| còn ≥ 7 ngày | `ACTIVE` | đủ |
| còn 0–6 ngày | `DUE_SOON` | đủ, có dải nhắc vàng |
| quá 1…ân hạn ngày | `OVERDUE` | đủ, có dải nhắc đỏ |
| quá hơn ân hạn | `LOCKED` | **chỉ xem**: xem, tìm, xuất, đăng xuất |
| chưa bật thu phí | `NOT_BILLED` | đủ, không nhắc, không bao giờ khoá |

Vì sao không lưu tình trạng:
- Không có job nào phải chạy đúng giờ để khoá hay mở khoá. Kết quả đúng tới từng ngày, giống luật 26 với leo thang SLA.
- Không đổi lịch scheduler (AGENTS.md §7).

**Không bao giờ xoá dữ liệu và không bao giờ tự đình chỉ.** Đình chỉ (`SUSPENDED`) là công tắc khẩn do người bấm, tiền
không kích hoạt nó.

## 2. Chế độ CHỈ XEM chặn gì

Cổng nằm ở `resolveCurrentUser()` (`lib/auth/session.ts`), đứng sau mọi cổng khác.

- Middleware gắn `x-erp-method`. Client không giả được header này, vì middleware xoá mọi `x-erp-*` do client gửi lên.
- **Lượt GHI** (POST/PUT/PATCH/DELETE: server action, API ghi) của tổ chức `LOCKED` bị từ chối `BILLING_LOCKED`:
  - trang và server action được chuyển tới `/billing-locked`;
  - API trả `402 BILLING_LOCKED`.
- **Được miễn:** `/settings/plan` (trang gia hạn), `/billing-locked`, `/login`, `/logout`, `/api/auth`. Đăng xuất dùng
  `getSession()` nên không đi qua cổng này.
- **Job nền:** `runJob` trả `SKIPPED BILLING_LOCKED` cho tổ chức khách bị khoá.
- **Webhook vẫn nhận:** tin khách nhắn tới không được mất.
  - Hệ quả: bot bán hàng trả lời trong webhook vẫn chạy bằng khoá AI của chính tổ chức (BYOK).
  - Muốn dừng hẳn thì dùng công tắc khẩn.
- **Lỗi đọc sổ thuê bao ⇒ KHÔNG khoá.** Khoá nhầm một khách đã trả tiền tệ hơn để lọt vài phút.
- **Độ trễ:** đệm 10 giây trong tiến trình, cùng trần với sổ tổ chức.
  - Tiền về thì tiến trình khác mở khoá trễ tối đa 10 giây.
  - Trong cùng tiến trình, lượt ghi xoá đệm nên mở khoá ngay.

## 3. Báo giá một lần gia hạn (`quoteRenewal`)

Gói mới luôn có hiệu lực **ngay khi tiền về**. Các trường hợp chỉ khác nhau ở chỗ kỳ được trả bắt đầu từ ngày nào:

| Trường hợp | Kỳ bắt đầu | Phần trừ |
|---|---|---|
| Chưa từng trả / đã bị khoá | hôm nay (không bắt trả những ngày bị khoá) | 0 |
| Quá hạn, còn ân hạn | ngay sau `paid_through` (những ngày ân hạn đã dùng đủ) | 0 |
| Còn hạn, cùng gói hoặc gói đang dùng không có giá (dùng thử) | ngay sau `paid_through` | 0 |
| Còn hạn, đổi sang gói giá thấp hơn hoặc bằng | ngay sau `paid_through` | 0 (ngày còn lại không quy ra tiền) |
| Còn hạn, nâng lên gói giá cao hơn | hôm nay | giá cũ / 30 × số ngày còn lại (tính cả hôm nay), làm tròn xuống |

Nếu phần trừ ≥ tiền gói mới thì khách phải chọn nhiều tháng hơn. Số tháng chọn được: 1 · 3 · 6 · 12.

**Chiết khấu kỳ dài là một cột tường minh** (`platform_plans.yearly_free_months`, 0194): trả 12 tháng thì tặng N tháng
(0–3), tức tiền = giá tháng × (12 − N). Kỳ 1 · 3 · 6 tháng không giảm. Giảm giá là quyết định kinh doanh (luật 38) nên
không có phép nhân nào khác được tự thêm vào. Bảng giá và phép tính giá vốn: `docs/platform/pricing.md`.

## 4. Tiền về

1. Khách tạo mã ở `/settings/plan`, ra một hoá đơn `OPEN`:
   - nội dung chuyển khoản là `ERPHD` + 6 ký tự, không dùng 0 · 1 · I · O;
   - kèm mã VietQR vẽ ngay trong trình duyệt.
   - Mỗi tổ chức chỉ có **tối đa một** hoá đơn đang mở. Bấm lại với đúng lựa chọn cũ thì trả lại hoá đơn đang mở; đổi lựa
     chọn thì hoá đơn cũ thành `VOID`.
2. Khách chuyển khoản. SePay ghi giao dịch vào **sổ ngân hàng của tổ chức nhà** như mọi giao dịch khác. Không có bảng tiền
   thứ hai.
3. `reconcileBillingPayments()` đọc chính sổ đó và tìm tiền VÀO mang mã `ERPHD`. Nó phủ cả ba đường tiền vào: webhook, lượt
   quét API, sao kê nhập tay. Mỗi khoản được ghi **đúng một** dòng `platform_billing_payments`, khoá theo `bank_ref`. Có
   bốn phán quyết:
   - `MATCHED`: trả đủ hoặc trả thừa. Một giao dịch CSDL làm 4 việc:
     - hoá đơn chuyển sang `PAID`;
     - `paid_through` = `period_end`;
     - gói của tổ chức đổi sang gói của hoá đơn;
     - ghi một dòng nhật ký nền tảng do MÁY ghi.
   - `UNDERPAID`: thiếu tiền, **chưa gia hạn**. Người vận hành quyết định.
   - `INVOICE_NOT_OPEN`: hoá đơn đã trả hoặc đã huỷ.
   - `NO_INVOICE`: mã không khớp hoá đơn nào.
   - Ba phán quyết sau nằm ở «Tiền chưa khớp» trên `/platform` tới khi người vận hành đánh dấu đã xử lý. Đánh dấu không xoá
     dòng nào.
4. Webhook SePay chỉ gọi bộ khớp khi nội dung có mã, nên mọi giao dịch khác không tốn thêm câu truy vấn nào. Nếu bộ khớp
   hỏng thì tiền vẫn nằm trong sổ ngân hàng; nút **«Đối chiếu lại tiền thuê bao»** quét lại 60 ngày.

## 5. Việc của người vận hành (`/platform` → «Thu phí thuê bao»)

1. **Khai tài khoản nhận tiền.** Đây là tài khoản đã nối SePay vào sổ ngân hàng của tổ chức nhà. Chưa khai thì khách
   không tạo được mã.
2. **Bảng giá.** Ba gói gieo sẵn: Khởi đầu 499.000 · Tăng trưởng 999.000 · Chuyên nghiệp 1.990.000.
   - Hạn mức của từng gói là **đề xuất ban đầu**; sửa giá không cần deploy.
   - Hoá đơn đang mở giữ giá cũ.
   - Để trống giá nghĩa là ngừng bán gói đó.
3. **Bật thu phí cho từng tổ chức** ở `/platform/org/<mã>` → «Thu phí», nhập «Đã trả tới ngày» = hạn dùng thử.
   - Tổ chức có từ trước 0187 (khách pilot) mặc định **không** thu phí, nên lần deploy này không đổi gì với họ.
   - Khách tự trả mà chưa được bật thì lượt trả đầu tiên tự bật thu phí.
4. **Xác nhận tay** khi tiền về ngoài sổ (ngân hàng khác, tiền mặt). **Huỷ hoá đơn.** Cả hai bắt buộc ghi lý do và đều
   vào nhật ký nền tảng.

MRR trên `/platform` = tổng giá THÁNG của gói ở các tổ chức đang chạy, đã bật thu phí và chưa bị khoá (`ACTIVE` · `DUE_SOON` ·
`OVERDUE`). Đây là doanh thu định kỳ danh nghĩa, **không phải tiền đã thu**. Tiền đã thu nằm ở danh sách «Vừa thu».

## 6. Còn ngoài phạm vi (bước sau)

- Phát hành hoá đơn điện tử (VAT) **từ trong ERP**. Đó là dịch vụ ngoài (nhà cung cấp hoá đơn điện tử), cần hỏi chủ nền
  tảng. Hiện ERP chỉ thu thông tin xuất hoá đơn và nhắc người vận hành (mục 8).
- Nhắc gia hạn qua tin nhắn / email. Hiện chỉ có dải nhắc trong ERP.
- Tự động đẩy khách từ `/start` vào gói có giá kèm số ngày dùng thử. Hiện người vận hành bật tay.
- Cổng thẻ (VNPay / PayOS): là dịch vụ ngoài mới, cần hỏi chủ nền tảng (AGENTS.md §7).

## 7. Mua thêm hạn mức giữa kỳ (0192)

> Mã: `lib/billing/addons.ts` (luật thuần) · `lib/billing/service.ts` (`previewAddon`, `createAddonInvoice`,
> `setPlanAddonPrices`, `setOrgAddons`). Học từ cách các nền tảng chatbot bán hàng trong nước bán "mua thêm trang /
> nhân viên": khách thiếu đúng một hạng mục thì không phải nhảy cả gói.

**Bước bán nằm trong mã, giá do người vận hành khai.**

| Hạng mục | Một bước | Ghi chú |
|---|---|---|
| Người dùng | 1 tài khoản | |
| Trang tuỳ biến | 5 trang | |
| Đối tượng tuỳ biến | 1 đối tượng | |
| Bản ghi tuỳ biến | 1.000 bản ghi | |
| Luật tự động | 5 luật | |
| Dung lượng tệp | 1 GB (1.024 MB) | |
| Bản nháp AI mỗi ngày | — | **không bán**: trần mỗi ngày, không tích luỹ cả kỳ |

- Đơn giá một bước / tháng khai **theo từng gói** ở `/platform` → «Đơn giá mua thêm…». Ô để trống nghĩa là gói đó không
  bán hạng mục ấy.
- Migration **không gieo giá nào** (luật 38). Trước khi chủ nền tảng khai, khung «Mua thêm hạn mức» của khách chỉ nói
  "gói hiện tại chưa bán thêm hạng mục nào".

**Báo giá một lần mua (`quoteAddon`).**
- Chỉ mua được khi đang trả phí và còn hạn (`ACTIVE` · `DUE_SOON`).
  - Dùng thử chưa bật thu phí: chưa có kỳ để chia.
  - Quá hạn: gia hạn trước.
- Tiền = đơn giá × số phần × số ngày còn lại tới `paid_through` (tính cả hôm nay) ÷ 30, **làm tròn xuống**. Đây là cùng
  phép quy đổi với phần trừ khi nâng gói.
- Mỗi lần mua tối đa 100 phần.

**Tiền về.** Hoá đơn `kind = 'ADDON'` (`months = 0`) dùng chung mã `ERPHD…`, chung bộ khớp và chung luật "tối đa một hoá đơn
đang mở". Trả đủ thì:
- cộng đơn vị vào `platform_subscriptions.addons`;
- hạn mức tăng **ngay**: `resolvePlan` cộng phần mua thêm vào hạn mức gói, đệm 10 giây như tình trạng thu phí;
- **không** đổi `paid_through`, **không** đổi gói.

**Gia hạn sau đó (`quoteRenewal`).**
- Giá tháng = giá gói + phần mua thêm theo **bảng giá của gói đích**.
- Phép so nâng / hạ và phần trừ đều dùng tổng tiền tháng, vì đó là số khách thật sự trả.
- Nếu gói đích không bán một hạng mục khách đang có, hệ thống báo lỗi. Nó không lặng lẽ bỏ phần đã mua và cũng không mượn
  giá của gói khác. Người vận hành khai giá cho gói đó hoặc giảm phần mua thêm.

**Người vận hành sửa phần đã mua** ở `/platform/org/<mã>` → «Sửa phần mua thêm…»:
- dùng khi tặng hoặc khi khách xin bớt từ kỳ sau;
- bắt buộc lý do, vào nhật ký `ORG_ADDONS_SET`;
- không tạo hoá đơn và không hoàn tiền.

**MRR** cộng phần mua thêm của tổ chức đang chạy. Phần mà gói không còn khai giá thì **không** được cộng; mô tả khung in số
tổ chức bị như vậy.

## 8. Thông tin xuất hoá đơn VAT (0192)

ERP **không phát hành** hoá đơn điện tử, vì đó là dịch vụ ngoài (AGENTS.md §7). ERP làm ba việc để người vận hành không quên
xuất và không xuất sai:

1. **Khách khai** ở `/settings/plan` → «Thông tin xuất hoá đơn»: tên công ty / hộ kinh doanh, mã số thuế, địa chỉ, email
   nhận hoá đơn.
   - Mã số thuế nhận ba dạng: 10 số · 10 số + «-» + 3 số (đơn vị phụ thuộc) · 12 số (số định danh cá nhân).
   - Lưu ở `platform_subscriptions.invoice_info`, ghi nhật ký `INVOICE_INFO_SET`.
2. **Mỗi lần tạo mã** (gia hạn hoặc mua thêm), khách tích «Xuất hoá đơn VAT» thì thông tin **được chụp vào chính hoá đơn**
   (`platform_invoices.invoice_info`).
   - Sửa thông tin về sau không đổi hoá đơn đã tạo.
   - Chưa khai thông tin thì ô này bị khoá.
3. **Người vận hành** thấy khung «Cần xuất hoá đơn VAT» trên `/platform`. Khung liệt kê các khoản ĐÃ THU có yêu cầu VAT
   mà chưa ghi số hoá đơn.
   - Xuất xong bên ngoài thì nhập số hoá đơn rồi bấm «Đã xuất».
   - Ghi đúng một lần (`INVOICE_VAT_ISSUED`); lần bấm thứ hai không đè số đã ghi.
