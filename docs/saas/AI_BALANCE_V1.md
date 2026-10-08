# Số dư AI + nạp QR — V1 (08/10/2026)

> Sứ mệnh `ai-balance-v1`. Nguồn: hai yêu cầu của chủ shop ngày 08/10/2026 («AI BALANCE + QR PAYMENT + USAGE ECONOMICS V1»
> và «MASTER MISSION — AI Revenue OS» mục VIII–XXIII) cùng bốn câu trả lời của chủ shop (bộ nhớ `so-du-ai-v1-quyet-dinh`).
> Tài liệu này ghi CÁCH làm và những gì CÒN phải làm; quyết định giá vẫn nằm ở `docs/saas/PRICING_V1.md`.

## 1. Quyết định đang có hiệu lực

| # | Câu hỏi | Chủ shop chốt (08/10/2026) |
|---|---------|----------------------------|
| 1 | Số dư trừ thế nào? | GIỮ giá gói V1 và phần khách AI gồm sẵn. Khách AI VƯỢT phần gồm trừ vào Số dư AI theo giá vượt của gói (590đ · 490đ · 390đ mỗi khách) thay cho hoá đơn phần vượt cuối kỳ. |
| 2 | Dùng thử hết lượt? | Phải chọn gói (giữ luật L5). Số dư AI chỉ dùng cho gói trả phí. |
| 3 | Hết số dư? | Khách AI đã tính phí trong tháng vẫn được AI trả lời (không cắt giữa hội thoại). Khách MỚI không nhận AI ⇒ chuyển người, báo chủ shop, nút Nạp tiền nổi bật. Âm tối đa đúng 1 khách. |
| 4 | Tiền nạp về đâu? | Cùng tài khoản SePay thu thuê bao, mã chuyển khoản riêng `ERPNAP…`. |

**Đơn vị «phiên khách AI 24 giờ»** (Master Mission mục IX, XI, XXVIII) CHƯA được bật: chính yêu cầu đó đòi backtest trên log
thật (P50/P75/P90/P95 chi phí mỗi phiên, mức thử 399–799đ) TRƯỚC khi công bố giá. Sổ cái và bảng giá có phiên bản đủ chỗ cho
đơn vị ấy (`units` + `price_version_key` trên dòng `AI_USAGE`); đổi đơn vị là MỘT phiên bản giá mới có ngày hiệu lực, không sửa
dòng cũ.

## 2. Kiến trúc — dùng lại, không dựng hệ thứ hai

```
Khách bấm «Nạp 1.000.000đ»
  → createAiTopupIntent: phiếu `platform_payment_intents` (mã ERPNAP + 6 ký tự, hạn 30 phút)
  → VietQR động (buildVietQrPayload — cùng bộ dựng của hoá đơn thuê bao) mang sẵn số tiền + tài khoản + mã
Khách chuyển khoản
  → SePay webhook (HMAC trên {timestamp}.{raw_body} · trần body · khử trùng gói tin · ghi sổ đồng bộ, lỗi ⇒ 5xx để SePay gửi lại)
  → bank_transactions của tổ chức nhà (đường có sẵn)
  → reconcileBillingPayments (đường có sẵn) — nay đọc cả mã ERPNAP
  → creditTopupFromBankRow: MỘT dòng platform_billing_payments (khoá bank_ref) + MỘT dòng TOPUP (khoá topup:<bank_ref>), cùng
    một giao dịch CSDL ⇒ webhook gửi lại 10 lần vẫn cộng một lần
  → màn khách hỏi trạng thái mỗi 4 giây; mỗi lần hỏi tự khớp ĐÚNG mã của phiếu (tự lành nếu lượt đối chiếu sau webhook hỏng)
```

| Yêu cầu (bảng) | Thực hiện |
|----------------|-----------|
| `ai_accounts` | `platform_ai_accounts` — trạng thái + ngưỡng báo số dư thấp. KHÔNG cột số dư. |
| `ai_ledger_entries` | `platform_ai_ledger_entries` — chỉ ghi thêm, khoá chống trùng duy nhất, lớp tiền CASH / PROMO, dấu tiền theo loại (ràng buộc CSDL = luật TypeScript). Số dư = tổng sổ. |
| `payment_intents` | `platform_payment_intents` — cột `provider` (hôm nay `SEPAY_BANK_TRANSFER`) để thêm cổng khác không đổi lõi. |
| `payment_transactions` | `platform_billing_payments` (có sẵn từ 0187) + cột `payment_intent_id` — MỘT bảng ghi mỗi giao dịch ngân hàng đúng một lần, dù là tiền thuê bao hay tiền nạp. |
| `ai_usage_events` · `provider_costs` | Đã có: `platform_usage_events` (đồng hồ khách AI, 0224) và `platform_ai_usage` (mỗi lượt gọi: nhà cung cấp, model, token, token cache, token suy nghĩ, độ trễ, chi phí). Hai khái niệm GIỮ TÁCH: phí khách ≠ chi phí nhà cung cấp. |
| `pricing_rates` | Đã có: bảng giá có phiên bản 0228 (`platform_price_versions` · `platform_plan_prices` · `platform_price_pins`). |
| Cổng thanh toán trừu tượng | `BillingProvider` (lib/billing/provider.ts) + cột `provider` của phiếu nạp. payOS là dịch vụ ngoài MỚI ⇒ phải hỏi chủ shop trước khi tích hợp (AGENTS §7). |

Chống trùng / an toàn (sửa theo review độc lập 08/10/2026 — bảng chân lý ở `topupOutcome` + `topupBankRowTrust`):
- CHỈ dòng sổ ngân hàng do CHÍNH SePay tạo (webhook / lượt quét API — `source` WEBHOOK · API, `provider = SEPAY` + mã giao
  dịch SePay) và tiền vào ĐÚNG tài khoản nhận đã khai mới được TỰ cộng. Dòng gõ tay / sao kê nhập: KHÔNG tự cộng, KHÔNG ghi gì —
  kể cả khi SePay xác nhận cùng mã bút toán SAU đó, vì đường ghi SePay chỉ điền ô còn rỗng, không sửa số tiền / nội dung của dòng
  đã có (review #650: nhập trước một sao kê dựng sẵn mang mã nạp + số tiền tuỳ ý, rồi chờ SePay «xác nhận» khoản thật nhỏ hơn).
  Chúng hiện ở khung «Tiền mang mã nạp mà SePay CHƯA xác nhận»; người vận hành đối chiếu app ngân hàng rồi «điều chỉnh tiền thật».
  Đường chuẩn (webhook về trong vài giây) vẫn tự cộng; sao kê thường nhập sau nhiều ngày. Lý do: một
  người có quyền ghi sổ ngân hàng (kế toán) không được tự «nạp» cho khách bằng một dòng gõ tay, và một khoản tiền vào sổ hai lần
  (sao kê + webhook khác mã tham chiếu) không được sinh tiền hai lần.
- Phiếu CHƯA trả (đang chờ — kể cả quá hạn hiển thị; đã huỷ) ⇒ cộng NGUYÊN số tiền thật nhận được, ĐÚNG MỘT lần: lượt cộng GIÀNH
  phiếu bằng câu UPDATE có điều kiện «chưa PAID» trong cùng giao dịch, nên hai khoản tới cùng lúc chỉ một khoản được cộng. Đúng
  số ⇒ `TOPUP_CREDITED`; lệch số / phiếu đã huỷ ⇒ `TOPUP_CREDITED_REVIEW` (đã cộng, người vận hành nhìn thấy). Trả SAU hạn 30
  phút vẫn cộng như thường (phiếu vẫn ở trạng thái chờ trong CSDL — «Hết hạn» chỉ là nhãn hiển thị).
- Phiếu ĐÃ trả, hoặc tiền vào tài khoản khác tài khoản nhận ⇒ `TOPUP_HELD`: GIỮ LẠI, KHÔNG cộng — máy không phân biệt được
  «khách chuyển lần hai thật» với «cùng một khoản vào sổ hai lần». Người vận hành xem ở /platform/ai-balance, là tiền thật thì
  ghi «điều chỉnh tiền thật» (có lý do + nhật ký) rồi đánh dấu đã xử lý. Mã `ERPNAP` không thuộc phiếu nào ⇒ `NO_INVOICE`, KHÔNG
  cộng cho ai.
- Tiền nạp tách khỏi tiền thuê bao ở mọi danh sách / bộ đếm: «Tiền chưa khớp» của khung thu phí thuê bao không có khoản nạp nào
  (để chung là để người vận hành dùng nhầm một khoản nạp xác nhận tay một hoá đơn — một khoản tiền dùng hai lần); nút «Đối chiếu
  lại» đếm riêng «khoản nạp đã cộng / giữ lại».
- Số dư AI chỉ nhận nạp ở gói TRẢ PHÍ (quyết định #2) · tối đa 3 mã chờ còn hạn mỗi tổ chức · màn khách thôi hỏi trạng thái 15 phút
  sau khi mã hết hạn · số tiền gõ tay phải là số nguyên VND (phần lẻ bị từ chối) · tặng / hoàn nhập số dương.
- Không có nhập nội dung tay, không gửi ảnh, không người duyệt (điều kiện hoàn thành của chủ shop).
- Cờ `ai_balance.enabled` theo tổ chức, mặc định TẮT, chỉ người vận hành bật (có lý do + nhật ký). Tắt cờ KHÔNG đụng tiền:
  tiền về muộn của phiếu cũ vẫn được cộng.

## 3. Màn hình

- Khách — `/settings/ai-balance` (vào từ «Số dư AI →» ở «Gói dịch vụ»; trong vỏ Chốt Đơn là trang con của mục «Gói»): số dư,
  đã dùng tháng này, chi trung bình 7 ngày, dự kiến còn N ngày, gợi ý nạp tới cuối tháng, 4 mức chọn sẵn + số khác, mã QR
  (máy tính) / sao chép STK · số tiền · nội dung + lưu ảnh QR (điện thoại), đếm ngược, báo «Đã nhận» ngay khi tiền về, lịch sử
  (dùng AI gộp theo ngày), ngưỡng cảnh báo. Không token / model / chi phí nhà cung cấp. Ở «Gói dịch vụ», khi Số dư AI đang bật,
  «Hoá đơn ước tính» trừ khỏi dòng khách AI vượt ĐÚNG số khách đã thu qua số dư trong kỳ (theo sổ cái, không theo cờ — §5) và câu cuối khung nói đúng
  luật hết số dư thay cho «không bao giờ tự tắt».
- Người vận hành — `/platform/ai-balance` (vào từ «Số dư AI →» ở /platform/saas): số dư từng tổ chức tách tiền thật / tiền
  tặng, nạp 30 ngày, dùng 30 ngày, khoản cần xem lại, bật / tắt từng tổ chức, tặng · điều chỉnh · hoàn (một lượt một dòng,
  bắt buộc lý do, bấm hai lần ra một dòng, hoàn không vượt tiền thật). «Dùng 30 ngày» tách phần tiền thật; lối «Doanh thu · chi
  phí · biên →» sang khung kinh tế đơn vị.

## 4. CẦN CHỦ SHOP / KẾ TOÁN / PHÁP LÝ XEM TRƯỚC KHI BẬT CHO KHÁCH THẬT

Kỹ thuật KHÔNG tự kết luận các điểm dưới đây — chúng được nêu để người có thẩm quyền quyết:

1. **Khai tài khoản nhận tiền** ở /platform (khung «Thu phí thuê bao») — hiện CHƯA khai, nên khách chưa tạo được mã nạp.
2. **Tính chất pháp lý của số dư trả trước**: gọi là «Số dư AI», chỉ dùng mua dịch vụ Chốt Đơn, không chuyển giữa khách, không
   rút, không dùng ngoài nền tảng — cần xác nhận mô hình này không rơi vào phạm vi ví điện tử / trung gian thanh toán.
3. **Hoá đơn VAT**: xuất lúc NẠP (tiền nhận trước) hay lúc DÙNG (doanh thu thực hiện)? Ảnh hưởng cách ghi sổ kế toán.
4. **Chính sách hoàn tiền** khi khách ngừng dịch vụ (hệ thống đã có dòng REFUND, chỉ hoàn từ tiền thật — không hoàn tiền tặng).
5. **Hạn dùng số dư** (dòng `EXPIRY` đã có chỗ, CHƯA dùng): có hết hạn không, bao lâu, có báo trước không.
6. **Thứ tự trừ** giữa tiền tặng và tiền thật khi bắt đầu trừ (đề xuất: trừ tiền tặng trước — có lợi cho khách, cần kế toán duyệt).
7. **Phí thu hộ** của SePay / ngân hàng (nếu có) — đưa vào «chi phí thu tiền» của kinh tế đơn vị.

## 5. Doanh thu · chi phí · biên (người vận hành — /platform/saas#unit-economics)

Một chỗ tính, dùng lại khung kinh tế đơn vị sẵn có (`lib/pricing/admin.ts::loadPricingEconomics`), không dựng màn thứ hai:

| Khoản | Nguồn | Vào doanh thu? |
|-------|-------|----------------|
| Thuê bao | MRR của ảnh chụp ngày (`platform_saas_daily`) | Có (như cũ) |
| Tiền THẬT khách đã dùng AI qua Số dư | Sổ cái — dòng `AI_USAGE` lớp `CASH` trong kỳ (`readAiBalancePeriod`) | **Có** — doanh thu ghi nhận lúc dùng |
| Đảo một khoản trừ oan | Dòng `ADJUSTMENT` nguồn `AI_CUSTOMER`, `source_ref` = khoá khách AI của khoản trừ — nút «Đảo» trên ĐÚNG một dòng trừ ở /platform/ai-balance (`reverseAiUsageCharge`): số tiền + lớp tiền của khoản ấy, khoá `aic-reverse:<mã dòng>` ⇒ mỗi khoản một lần | Khoản đảo tiền thật **trừ** khỏi doanh thu (`aiBalanceRevenueVnd`), cộng lại số dư |
| Tiền khách nạp, chưa dùng | Dòng `TOPUP` (nạp QR) · điều chỉnh tiền thật nguồn `OPERATOR` (tiền đưa ngoài QR) · số dư `CASH` | **Không** — tiền giữ để phục vụ, khoản phải hoàn (khung «Số dư AI khách đang giữ» — MỌI tổ chức trừ nhà, kể cả đình chỉ / lưu trữ; số dư âm tách thành «khách đang nợ») |
| Tiền nền tảng tặng đã dùng | Dòng `AI_USAGE` lớp `PROMO` | **Không** — doanh thu BỎ QUA. Chi phí thật của lượt AI ấy đã nằm ở `platform_ai_usage`; không trừ thêm lần hai |
| Hoàn tiền | Dòng `REFUND` | Không phải doanh thu âm — giảm tiền đang giữ |
| Chi phí AI nhà cung cấp | `platform_ai_usage` (nguồn `PLATFORM`) | Là CHI PHÍ (như cũ) |

- Lãi gộp cả nền tảng (`platformGrossMargin`) = MRR + doanh thu Số dư AI CHIẾU cuối tháng (cùng nhịp với chi phí AI chiếu — so
  tới-nay với cả-tháng là biên đầu tháng NGUY CẤP giả) − chi phí AI chiếu − hạ tầng đã khai. Tổng Số dư (`aiBalanceTotals`):
  dòng tiền kỳ chỉ của tổ chức trong khung (cùng tập với chi phí AI); số dư đang giữ của mọi tổ chức trừ nhà.
- PHẦN VƯỢT KHÁCH AI — MỘT hàm cho mọi màn (`overageNetOfBalance`, review N2 08/10/2026): dòng «khách AI vượt» trừ ĐÚNG số khách
  đã thu qua sổ cái trong CHÍNH kỳ đó (dòng `aic-charge`, kể cả khoản đã đảo), KHÔNG theo cờ hiện tại. Khách vượt chưa trừ
  (trước khi bật cờ · sau khi tắt · lượt trừ hỏng) vẫn tính theo KHỐI như bảng giá. Bảng kê (`lib/saas/customers.ts`), hoá
  đơn ước tính của khách (`lib/pricing/customer.ts`), khung /platform/saas và /platform/customers đều đi qua nó ⇒ hai màn vận
  hành không nói hai số cho cùng một kỳ. Sổ không đọc được ⇒ bảng kê KHÔNG chốt (như ghim giá); hoá đơn ước tính in dòng «chưa
  biết». Tổ chức chưa từng có dòng sổ ⇒ trừ 0 khách ⇒ công thức cũ nguyên vẹn (production 08/10/2026: chưa tổ chức nào bật ⇒
  trước = sau).
- Doanh thu Số dư AI vào phần KINH TẾ của /platform/customers và /platform/products (sản phẩm Chốt Đơn) — KHÔNG thành dòng bảng
  kê (đã thu qua số dư; đưa vào bảng kê là thu hai lần). Thiếu nó thì khách trả phần vượt qua số dư bị gắn «lỗ» oan.
- Phần vượt khi cờ TẮT vẫn chỉ là ƯỚC TÍNH: chưa có đường thu hoá đơn phần vượt (`docs/saas/COST_BILLING.md`) — khung kinh tế
  đơn vị in nó như doanh thu chiếu, Số dư AI là đường đầu tiên biến phần vượt thành tiền thật.

## 6. Còn lại (theo thứ tự phụ thuộc)

| Việc | Phụ thuộc | Ghi chú |
|------|-----------|---------|
| ~~Trừ số dư cho khách AI VƯỢT phần gồm · cổng hết số dư (chỉ chặn khách MỚI, bình luận theo NGƯỜI bình luận) · cảnh báo số dư thấp / hết~~ | — | Xong trong PR này (`lib/billing/ai-usage-charge.ts`, `aiBalanceGate`, `runAiBalanceAlerts`). |
| ~~Hoá đơn ước tính + bảng kê kỳ KHÔNG gồm khách AI đã trừ số dư~~ | — | Xong — đếm theo dòng sổ của kỳ, không theo cờ (`overageNetOfBalance`, review N2): bật / tắt cờ giữa tháng, chốt bảng kê sau mốc đổi cờ đều ra đúng số. |
| Lượt bù khi trừ tiền hỏng (khách đã ghi đồng hồ mà chưa có dòng `aic-charge:`) | Không | Doanh thu KHÔNG còn mất: khách chưa trừ nằm lại dòng vượt của bảng kê (N2). Còn lại là công bằng cho khách — phần ấy tính theo KHỐI thay vì đơn giá từng khách; bù bằng job idempotent theo khoá sẵn có, CHỈ kỳ đang mở và khách ghi SAU mốc bật cờ (bảng kê đã chốt thì không trừ thêm — thu hai lần). |
| ~~Đảo một khoản trừ oan~~ | — | Xong — nút «Đảo» theo ĐÚNG một dòng trừ (`reverseAiUsageCharge`, review #648 vòng 2 MEDIUM-2): không gõ số tiền, truy được khách, mỗi khoản một lần kể cả bấm cùng lúc. Trừ khỏi doanh thu; khách bị trừ oan vẫn KHÔNG bị tính lại ở bảng kê. |
| Ranh giới «âm tối đa 1 khách» khi NHIỀU khách mới tới cùng lúc | Không | Cổng chỉ hỏi số dư > 0 trước lượt; hai khách mới cùng lúc khi còn 20đ ⇒ âm hai đơn giá. Hiếm; sửa bằng khoá theo tổ chức quanh cổng + lượt ghi. |
| Tiền tặng lẻ nhỏ hơn một đơn giá | Không | Không bao giờ được trừ (trừ tiền tặng chỉ khi đủ một đơn giá). Chấp nhận ở V1; hạn dùng tiền tặng (§4.5) sẽ dọn phần lẻ. |
| ~~Kinh tế đơn vị: doanh thu dùng AI · chi phí nhà cung cấp · biên theo tổ chức / tháng~~ | — | Xong (§5). |
| Kinh tế đơn vị theo ngày / việc / model · chi phí thu tiền (phí SePay / ngân hàng) | Chủ shop khai phí thu hộ (§4.7) | Chi phí theo model đã có ở khung Platform AI; phí thu tiền chưa có nguồn. |
| Backtest «phiên khách AI 24 giờ» trên log thật (399–799đ) ⇒ đề xuất Starter / Growth / Scale | Không | Chỉ đọc; KHÔNG công bố giá khi chưa có bằng chứng. |
| Liên kết mở thẳng app ngân hàng trên điện thoại (deeplink) | Không | V1 dùng sao chép + lưu ảnh QR (luôn chạy); deeplink tuỳ ngân hàng, thêm sau. |
| Xử lý khoản «cần xem lại» bằng một nút (gán về tổ chức · cộng · hoàn) | Không | Hôm nay: «điều chỉnh tiền thật» ở khung «Tặng · điều chỉnh · hoàn tiền» (có lý do + nhật ký), rồi nút «Đã xử lý…» ngay trên dòng (cùng hàm đánh dấu của luồng thu phí). |
| Ranh giới phần gồm khi HAI khách mới tới cùng lúc: khách thứ «gồm» có thể bị trừ một đơn giá (đếm kỳ đọc sau lượt ghi của cả hai) | Không | Hiếm, tối đa một đơn giá mỗi lần chạm ranh; sửa bằng khoá theo tổ chức quanh lượt ghi + đếm, hoặc đối soát cuối kỳ hoàn phần trừ thừa. |

## 7. Chế độ trả trước toàn phần — «AI dùng chung trả trước theo khách AI» (08/10/2026)

Quyết định chủ shop 08/10/2026: HSLC (`hslc-hmt-shop` — khách thật, bot AI Bán hàng ~2.000 lượt/ngày, đang chạy khoá Gemini RIÊNG
`gemini-byok`, gói cũ `standard`, credit AI dùng chung = 0) chuyển sang AI DÙNG CHUNG của nền tảng NHƯ MỘT KHÁCH: nạp tiền qua QR,
nạp bao nhiêu dùng bấy nhiêu, chạy đồng hồ khách AI như khách. KHÔNG cấp credit nền tảng miễn phí.

**Phương án (ĐỀ XUẤT KỸ THUẬT theo «phương án tốt nhất» chủ shop giao — cần chủ shop xác nhận ĐƠN GIÁ trước khi kích hoạt):**
chế độ này là DỮ LIỆU, không có nhánh theo mã tổ chức và không có hệ tính tiền thứ hai.

| Mảnh | Thực hiện |
|------|-----------|
| Phiên bản giá «Trả trước theo khách AI» | `prepaid-ai-v1` (`lib/pricing/price-book.ts::publishPrepaidAiVersion`, nhật ký `PRICE_VERSION_PUBLISH`). Kind `LEGACY_SNAPSHOT` = CHỈ tới bằng ghim, không bao giờ thành bảng giá niêm yết (CHECK của 0228 buộc kind `CATALOG` phải có ngày hiệu lực; một kind riêng `PREPAID` cần migration đổi CHECK — không làm ở V1). `isPrepaidAiPrice` CHỈ nhận dòng của kind này — một gói CATALOG tương lai «gồm 0 + khối khách AI» không bị coi là trả trước. Chép MỌI dòng của giá cũ `legacy` rồi chỉ thay phần AI (`prepaidAiPriceRows`): giá thuê bao · tặng tháng · mua thêm · tính năng GIỮ NGUYÊN; `included.aiCustomers = 0`; khối khách AI = giá vượt của gói AI tự mua RẺ NHẤT trong bảng giá đang niêm yết (`prepaidAiTerms` — V1: Starter 59.000đ / 100 khách ⇒ **590đ / khách**, dẫn xuất, không gõ số); không phần vượt fanpage / người dùng (như giá cũ). Đổi đơn giá = `prepaid-ai-v2`, không sửa v1. |
| Trừ tiền | KHÔNG đổi một dòng nào: `balanceOverageTerms` đọc `included = 0` ⇒ `chargeAiCustomerUsage` trừ MỌI khách AI mới của kỳ (một lần mỗi khách mỗi kỳ, dòng sổ mang `prepaid-ai-v1` + 590đ). |
| Hết số dư | KHÔNG đổi: `aiBalanceGate` — khách MỚI không nhận AI (chuyển người, hộp thư nói lý do + lối nạp), khách đã tính trong kỳ vẫn được trả lời, âm tối đa một đơn giá. |
| Trần AI | `isPrepaidAiPrice` + cờ Số dư AI BẬT ⇒ `prepaidAiLimits` (trần LƯỢT của gói giữ nguyên — AI Bán hàng không tính vào trần lượt); trần TIỀN quyết sau ghi đè (`applyAiOverride`). **Chưa có credit** (bot còn khoá riêng) ⇒ trần tiền của GÓI, không softOnly — y như trước khi chuyển. **Có credit** (đặt cùng lượt `org-ai-cutover --credit`) ⇒ `softOnly`: credit = **ngưỡng CẢNH BÁO** (khách nhận câu kinh doanh không số USD — `CUSTOMER_AI_SOFT_LIMIT_NOTICE`; người vận hành nhận tin có số qua kênh vận hành, một lần / ngày), **trần CỨNG chống lạm dụng = credit × 3** (`PREPAID_ABUSE_HARD_MULTIPLIER`). Cổng tiền của khách AI MỚI là Số dư AI; trần cứng giữ các việc KHÔNG qua cổng số dư (khách đã tính nhắn tiếp, học hội thoại, nhắc khách, Copilot / AI Builder) khi số dư ≤ 0 — chạm trần là chặn CẢ AI Bán hàng, người vận hành nâng credit. Ghi đè tường minh `costUsdSoft` / `costUsdHard` của người vận hành thắng. **Cờ TẮT ⇒ trần cũ của gói (credit là trần CỨNG)**: không trừ, không chặn khách mới thì cũng không có AI nền tảng không giới hạn. |
| AI dùng chung mở cho tổ chức | `platformChatAi` vẫn đòi credit > 0 ⇒ người vận hành đặt credit bằng `org-ai-cutover <mã> --apply --credit=<USD>` — CÙNG lượt chuyển động cơ AI. Sổ AI ghi nguồn `PLATFORM` (`salesBotBillingSource("platform")`). |
| Hoá đơn gia hạn | Kích hoạt BỊ CHẶN khi còn hoá đơn gia hạn ĐANG MỞ theo giá khác trả trước (huỷ, hoặc cho khách trả trước khi kích hoạt). Đường trả hoá đơn (`applyInvoicePaid`): tổ chức đang ghim trả trước + hoá đơn giá CŨ + CÙNG gói ⇒ KHÔNG ghim lùi (nhật ký `INVOICE_PAID` ghi `keptPrepaidPin`); đổi sang gói khác (vd mua gói V1) ⇒ ghim theo hoá đơn như thường. |

**Thao tác người vận hành — `ops org-prepaid-ai` (`scripts/org-prepaid-ai.ts`, lõi `lib/billing/prepaid-ai.ts`):** mặc định CHẠY THỬ
(chỉ đọc, hỏi lại Postgres; động cơ AI đọc bằng kết nối KIỂM TRA ép chỉ đọc): gói / phiên bản giá · tài khoản nhận tiền · cờ + số
dư (đủ ≈ bao nhiêu giờ) · động cơ AI Bán hàng đang lưu · hoá đơn gia hạn đang mở · đơn giá · trần AI hiện tại / sau kích hoạt / sau
cutover · mức dùng 7 ngày quy ra khách AI × đơn giá ≈ tiền / ngày + gợi ý nạp 7 / 30 ngày + credit gợi ý · khách AI trong kỳ chưa
có dòng `aic-charge` · BƯỚC KẾ TIẾP. `--apply` làm ĐÚNG MỘT bước, đọc lại tươi trước khi ghi, nhật ký nền tảng nguồn SCRIPT:

1. **MỞ NẠP** — bật cờ `ai_balance.enabled` (`enableAiBalanceAsOperator`) khi tổ chức còn ở giá cũ: giá cũ không có khối khách AI
   ⇒ chưa trừ, chưa chặn gì; chủ shop tạo được mã QR ở /settings/ai-balance. Chạy thử CẢNH BÁO khi cờ bật + bot đang ở AI dùng
   chung mà tổ chức chưa ở trả trước (AI nền tảng chạy mà không thu).
2. **CHỜ NẠP** — số dư < max(100.000đ, ước tính 1 ngày) ⇒ TỪ CHỐI ghim, in «đủ ≈ N giờ». `--force-low-balance` (người vận hành chủ
   động) hạ xuống > 0; số dư ≤ 0 thì KHÔNG BAO GIỜ ghim (bot im với khách thật).
3. **KÍCH HOẠT** — đòi `--unit=<đ>` KHỚP đơn giá đọc lúc ghi (người bấm xác nhận đúng con số sẽ trừ); chặn khi còn hoá đơn gia hạn
   đang mở theo giá cũ; phát hành `prepaid-ai-v1` (nếu chưa có) + ghim tổ chức (`PRICE_VERSION_PIN`); kiểm lại trên đúng đường trừ
   tiền (gồm 0 · 590đ) — sai ⇒ hoàn ghim. Từ đây MỌI khách AI trừ số dư (kể cả khi bot còn chạy khoá riêng).
4. **ĐANG CHẠY** — chạy thử in «CHƯA chuyển động cơ — đang thu 590đ trong khi chạy khoá riêng» khi bot còn ở khoá riêng; chạy NGAY
   `org-ai-cutover <mã> --apply --credit=<USD>` (script này KHÔNG đổi động cơ AI, KHÔNG đặt credit) để bot sang AI dùng chung.

Cổng chặn mọi bước: **chưa khai tài khoản nhận tiền ⇒ không làm gì** và in «chủ shop cần khai tài khoản nhận tiền ở /platform»
(script KHÔNG tự khai). V1 chỉ chuyển tổ chức đang ở giá cũ `legacy` (tổ chức theo bảng giá V1 đã trừ Số dư cho khách vượt phần
gồm); tổ chức nhà / tổ chức không ACTIVE / gói dùng thử bị chặn. Đã ghim mà cờ tắt (tắt khẩn) ⇒ ops không tự bật lại.

**Runbook — chủ shop / người vận hành làm để HSLC chạy thật:**
1. Khai tài khoản nhận tiền ở /platform (khung «Thu phí thuê bao») — hôm nay CHƯA khai.
2. Chủ shop xác nhận đơn giá 590đ / khách AI (đề xuất: bằng giá vượt của gói Starter) và việc GIỮ giá thuê bao cũ của HSLC.
3. Deploy bản có mã này (ops lấy script từ `main` nhưng `lib/` từ image đang chạy). `org-prepaid-ai hslc-hmt-shop` (chạy thử) để đọc
   mức dùng quy ra tiền, rồi `org-prepaid-ai hslc-hmt-shop --apply` (MỞ NẠP).
4. HSLC nạp ở /settings/ai-balance — ít nhất «gợi ý nạp 7 ngày» của bản chạy thử (cơ sở hội thoại AI là CẬN TRÊN khi đồng hồ
   khách AI mới có dưới 3 ngày trọn). «~2.000 lượt / ngày» của HSLC là LƯỢT AI (tin), KHÔNG phải số khách — số khách AI / ngày
   phải đọc ở bản chạy thử; tiền / ngày = khách AI MỚI / ngày × 590đ (vd 500 khách mới / ngày ≈ 295.000đ / ngày ≈ 8,9 triệu đ /
   30 ngày). Đầu tháng gần như mọi khách đều mới; khách quay lại trong cùng tháng không bị tính lại.
5. Có hoá đơn gia hạn đang mở theo giá cũ ⇒ huỷ hoặc cho khách trả TRƯỚC khi kích hoạt.
6. `org-prepaid-ai hslc-hmt-shop --apply --unit=590` (KÍCH HOẠT) rồi NGAY `org-ai-cutover hslc-hmt-shop --apply --credit=<credit
   gợi ý>` — credit = ngưỡng cảnh báo, trần cứng chống lạm dụng = credit × 3: chọn credit ≥ chi phí AI tháng dự kiến, nếu không bot
   chạm trần cứng giữa tháng. Hậu kiểm `--apply-probe`.

**Giới hạn đã biết (review #674 — ghi nhận, chưa sửa ở lát này):**
- **L3** — khách AI ghi đồng hồ TRƯỚC lúc kích hoạt (hoặc lượt trừ hỏng) không có dòng `aic-charge` và không được bù; chạy thử in
  số «khách AI trong kỳ chưa có dòng aic-charge» để người vận hành thấy. Lượt bù vẫn là việc ở §6.
- **L4** — «Âm tối đa một đơn giá» chỉ đúng khi các lượt đi TUẦN TỰ: cổng (`aiBalanceGate`) đọc số dư TRƯỚC, lượt trừ
  (`chargeAiCustomerUsage`) chạy SAU khi câu trả lời đã gửi, nên N khách MỚI tới đồng thời có thể làm số dư âm tới N × đơn giá.
  Giới hạn này có từ trước PR này (§6 «Ranh giới âm tối đa 1 khách»); với gói trả trước «gồm 0» thì MỌI khách AI đi qua đường này.
- **L8** — nếu `platformAudit` hỏng ngay sau khi phát hành phiên bản (`lib/pricing/price-book.ts::publishPrepaidAiVersion`, lượt ghi
  nhật ký `PRICE_VERSION_PUBLISH` sau giao dịch chèn phiên bản), phiên bản ĐÃ có trong sổ giá mà KHÔNG có nhật ký phát hành, và các
  lượt sau dùng lại nó (nhánh «đã có») KHÔNG ghi bù. Người vận hành đối chiếu bằng bảng phiên bản (`platform_price_versions`:
  `created_at`, `created_by_email`, `note`).
- Màn khách (/settings/plan) in dòng khách AI «Gói không gồm» cho gói trả trước — đúng về số (mọi khách AI trừ số dư) nhưng câu chữ
  nên là «trả theo Số dư AI» (việc giao diện, chưa làm). Gói cũ có số người dùng / fanpage VƯỢT trần `platform_plans` sẽ hiện dòng
  ghế «chưa khai đơn giá» trên hoá đơn ước tính (giá cũ là «không phần vượt»).
- Câu cảnh báo vượt ngưỡng cho KHÁCH vẫn là câu chung «AI sắp chạm hạn mức tháng của gói» — với gói trả trước câu đúng hơn là về
  Số dư AI (việc câu chữ, chưa làm).
- Hệ số trần chống lạm dụng (× 3) là hằng số kỹ thuật — chủ shop chưa chốt.
