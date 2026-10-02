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

**Không có chiết khấu theo kỳ dài.** Giảm giá là quyết định kinh doanh (luật 38). Nếu chủ nền tảng muốn giảm giá, việc đó
phải thành một cột tường minh, không phép nhân nào được tự thêm vào.

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

- Hoá đơn điện tử (VAT) theo pháp luật Việt Nam. Hiện chỉ có chứng từ nội bộ.
- Nhắc gia hạn qua tin nhắn / email. Hiện chỉ có dải nhắc trong ERP.
- Tự động đẩy khách từ `/start` vào gói có giá kèm số ngày dùng thử. Hiện người vận hành bật tay.
- Cổng thẻ (VNPay / PayOS): là dịch vụ ngoài mới, cần hỏi chủ nền tảng (AGENTS.md §7).
