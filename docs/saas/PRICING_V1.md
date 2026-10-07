# Bảng giá V1 Chốt Đơn Tự Động — bản ghi quyết định (07/10/2026)

> Quyết định kinh doanh CHÍNH THỨC của chủ shop ngày **07/10/2026**, chép NGUYÊN VĂN dưới đây (phần I). Phần II ghi cách kỹ
> thuật thực hiện nó (migration `0228_pricing_v1_versions`, sứ mệnh `saas-d-pricing-overage`). Đổi giá về sau = THÊM một phiên
> bản giá mới trong CSDL, không sửa phần I và không sửa dòng giá cũ.

## I. Nguyên văn quyết định

```text
BUSINESS DECISION — CHỐT PRICING CHOTDONTUDONG V1 (chủ shop, 07/10/2026)

1. PUBLIC PLANS
TRIAL — 7 ngày · 0 ₫ · fanpage 1 · AI customers 100 · AI conversations fair-use 300 · AI replies fair-use 2.000 · users 2 · orders không giới hạn
INBOX — tháng 299.000 · năm 2.990.000 · fanpage 3 · users 3 · KHÔNG có AI Sales · inbox/hội thoại tay · orders không giới hạn
STARTER — tháng 790.000 · năm 7.900.000 · fanpage 3 · AI customers/tháng 1.500 · conversations fair-use 4.500 · replies fair-use 30.000 · users 5 · orders không giới hạn
GROWTH — tháng 1.490.000 · năm 14.900.000 · ĐỀ XUẤT / phổ biến nhất · fanpage 10 · AI customers 3.000 · conversations 10.000 · replies 75.000 · users 10 · orders không giới hạn
SCALE — tháng 2.990.000 · năm 29.900.000 · fanpage 30 · AI customers 7.500 · conversations 30.000 · replies 200.000 · users 25 · orders không giới hạn
ENTERPRISE — từ 5.990.000/tháng · hợp đồng riêng · mục tiêu 20.000–30.000+ AI customers hoặc tuỳ chỉnh · pages/users/fair-use tuỳ chỉnh · orders không giới hạn
Không giả định thuế/VAT trong thu phí cho tới khi cấu hình thuế được khai rõ. Cách hiển thị giá / xử lý thuế phải cấu hình được.

2. PRIMARY BILLING METER: AI_CUSTOMER
Một liên hệ DUY NHẤT trong MỘT workspace và MỘT kỳ thu đã nhận ÍT NHẤT MỘT câu trả lời outbound do AI sinh ra THẬT SỰ.
Cùng liên hệ nhiều hội thoại/tin trong cùng kỳ = 1 AI customer. Dùng danh tính kênh/liên hệ chuẩn tốt nhất hiện có.
Không đếm đôi chỉ vì có nhiều usage event. Hội thoại, số trả lời AI, token KHÔNG đồng thời là đồng hồ thu chính.

3. OVERAGE
STARTER 59.000 ₫ / mỗi 100 AI customers thêm · GROWTH 49.000 · SCALE 39.000 · ENTERPRISE theo hợp đồng
Fanpage thêm 99.000 ₫ / page / tháng · User thêm 49.000 ₫ / user / tháng
Orders: KHÔNG có phần vượt, không giới hạn ở gói AI trả phí.
Không bao giờ thu đồng thời AI customer + hội thoại + tin cho dùng bình thường.

4. FAIR USE
Hội thoại AI và trả lời AI là chỉ số fair-use / an toàn chi phí: đo và hiện trong phân tích dùng, KHÔNG sinh phí cộng thêm.
Vượt mật độ bất thường ⇒ gắn cờ tổ chức · báo người vận hành · đề xuất nâng gói / gói riêng · giữ bằng chứng · không âm thầm tạo hoá đơn đôi.
KHÔNG tự tắt Sales AI đang khoẻ chỉ vì vượt 100% hạn mức AI customer.

5. USAGE ALERTS
80% ⇒ cảnh báo khách + người vận hành · 100% ⇒ bắt đầu tính phần vượt · 120% ⇒ cảnh báo mạnh + đề xuất nâng gói · 150% ⇒ người vận hành rà soát chi phí/rủi ro.
Không tự tắt bot ở 100%. Chính sách lạm dụng/bảo mật/chưa trả tiền/bất thường chi phí nhà cung cấp là RIÊNG.

6. INTERNAL COST GUARDRAIL
Token/provider/model là số NỘI BỘ. Tiếp tục ghi: provider, model, input_tokens, output_tokens, cached_tokens (nếu có), request_count, provider_cost, currency, workspace, product, conversation, agent.
Biên lãi gộp đích 75–85%. Cảnh báo nội bộ: biên chiếu < 70%. Nguy cấp: < 60%.
Không đưa giá token làm khái niệm thu chính với khách. Giá không gắn với một nhà cung cấp/model (đổi định tuyến model không đổi gói khách).

7. ORDER METRICS (KPI giá trị, KHÔNG phải trần thu)
orders_assisted · orders_created_by_ai · orders_closed_by_ai · revenue_attributed_to_ai · GMV_attributed_to_ai · conversion_rate · upsell_rate · cross_sell_rate

8. KIẾN TRÚC
Usage Event → Usage Ledger → Aggregation → Pricing Rules → Billable Usage → Invoice / Internal Chargeback.
Giá do dữ liệu/cấu hình quyết, CÓ PHIÊN BẢN + NGÀY HIỆU LỰC. Không có `if (plan === "growth")` rải trong runtime AI Sales — dùng entitlement / resolver giá.
Thuê bao hiện có phải GIỮ phiên bản giá truy vết được khi giá tương lai đổi.

9. INTERNAL CUSTOMER
VNXCommerce Internal dùng ĐÚNG gói / entitlement / đồng hồ như khách ngoài. billing_mode vẫn internal_chargeback.
Không có hành vi miễn phí/vô hạn ẩn cho INTERNAL. Gán VNXCommerce vào gói thường NHỎ NHẤT vừa với số dùng thật đo được, áp phần vượt + chargeback bình thường.

10. CUSTOMER UI
/pricing và Cổng khách hiện: AI Customers đã dùng / gồm · fanpage đã dùng / gồm · users đã dùng / gồm · sức khoẻ fair-use AI · hoá đơn ước tính / phần vượt hiện tại nếu có.
KHÔNG đưa số token làm đồng hồ nổi bật với khách. Bảng điều hành người vận hành vẫn hiện token, chi phí nhà cung cấp, chi phí AI, doanh thu, lãi gộp, biên lãi.

11. ACCEPTANCE — kiểm thử phải chứng minh:
cùng khách đếm một lần mỗi kỳ · hội thoại lặp không sinh phí AI-customer lặp · phần vượt tính đúng · đơn không sinh phần vượt · khách nội bộ đi cùng bộ máy giá · giá theo phiên bản/lịch sử tái lập được · cô lập tổ chức còn nguyên.
```

## II. Thực hiện kỹ thuật

### 1. Bảng giá có phiên bản (mở rộng 0223 / 0224, không dựng hệ thứ hai)

| Bảng | Vai trò |
|---|---|
| `platform_price_versions` | Một phiên bản: `LEGACY_SNAPSHOT` (ảnh chụp giá đang thu lúc 0228, chỉ tới bằng ghim) hoặc `CATALOG` (bảng giá niêm yết, hiệu lực từ `effective_from`). Ngưỡng cảnh báo (`alert_thresholds`), chế độ thuế (`tax_mode`). |
| `platform_plan_prices` | Giá của một gói trong một phiên bản: giá tháng, **giá năm tường minh**, «từ …» của gói hợp đồng, số ngày dùng thử, hạn mức gồm (`included`: khách AI · fanpage · người dùng · fair-use hội thoại / trả lời AI · đơn), luật vượt (`overage`: khối khách AI + đơn giá · fanpage / người dùng thêm), tính năng, giá mua thêm cũ (0192). |
| `platform_price_pins` | Tổ chức đang ở phiên bản nào. Không có dòng ⇒ bảng giá CATALOG đang hiệu lực; trả hoá đơn gia hạn ⇒ ghim vào phiên bản của hoá đơn (cùng giao dịch). |
| `platform_invoices.price_version_key` | Hoá đơn tính theo phiên bản nào (NULL = trước 0228 = legacy). |

- **V1** = `v1-2026-10`, hiệu lực 07/10/2026 00:00 giờ VN, gieo đúng số phần I cho `trial · inbox · starter · growth · scale ·
  enterprise`. Gói `inbox`, `scale` thêm vào `platform_plans` (danh tính + hạn mức kỹ thuật cho `checkEntitlement`); giá chỉ ở
  phiên bản. Tính năng theo gói là đề xuất kỹ thuật (quyết định chỉ chốt «INBOX không có AI Sales»): Inbox = hộp thư · chuyển
  người · báo cáo · nhiều người dùng; Starter thêm AI bán hàng, tạo đơn, upsell, nhắn lại; Growth thêm cross-sell, báo cáo nâng
  cao, dạy AI, webhook; Scale / Enterprise thêm API.
- **Trần kỹ thuật theo phiên bản** (tổ chức ghim / theo bảng giá CATALOG; legacy GIỮ NGUYÊN trần cũ của `platform_plans`):
  - Người dùng (`checkEntitlement` qua `resolvePlan` → `plansForOrg`): trial 2 · inbox 3 · starter 5 · growth 10 · scale 25,
    cộng phần mua thêm 0192. Fanpage gồm 1 · 3 · 3 · 10 · 30 là hạn mức THƯƠNG MẠI (`resolveOrgPricing.quotas.fanpages`,
    màn khách, phần vượt 99.000 ₫ / page) — ERP không có trần kỹ thuật fanpage (khoá `pages` của `checkEntitlement` là
    «trang tuỳ biến», không phải fanpage).
  - AI (`resolveAiLimits` → `lib/pricing/versions.ts::catalogAiLimits`): gói có `ai_sales` ⇒ KHÔNG trần cứng nào (lượt /
    ngày, lượt / tháng, tiền), credit nền tảng = NGÂN SÁCH MỀM (`softOnly`, chỉ cảnh báo):
    `ngân sách USD/tháng = giá gốc tháng × (1 − ngưỡng biên nguy cấp/100) ÷ tỷ giá USD→VND` (giá gốc = giá tháng; dùng thử
    ⇒ giá tháng rẻ nhất của gói AI tự mua cùng phiên bản; hợp đồng ⇒ giá «từ …»; nguy cấp mặc định 60% ⇒ 40% giá cho AI).
    INBOX không có `ai_sales` ⇒ AI bán hàng tắt bằng entitlement, trần AI kỹ thuật giữ dòng `platform_plans`. Ghi đè AI tay
    của người vận hành (chính sách lạm dụng / bất thường chi phí) vẫn áp như cũ.
- **Legacy** = `legacy`: chép NGUYÊN `platform_plans` lúc migration chạy (mọi khoá gói, kể cả `standard`, `basic`, `pro`,
  `internal`, giá, tặng tháng, mua thêm, limits, commercial). MỌI tổ chức có từ trước 0228 được ghim `legacy` ⇒ số tiền khách
  hiện tại trả KHÔNG ĐỔI (bài kiểm so báo giá 1/3/6/12 tháng trước / sau). Phiên bản legacy chỉ thay GIÁ; hạn mức kỹ thuật và
  phần thương mại của gói cũ vẫn là dòng `platform_plans` người vận hành đang sửa.
- **Resolver duy nhất**: `lib/pricing/price-book.ts` (`plansForOrg`, `catalogPlans`, `orgPriceVersion`) + hàm thuần
  `lib/pricing/versions.ts` (`priceOf`, `renewalPricing`, `overlayPlanRow`). Gia hạn ĐÚNG gói đang dùng ⇒ giá ghim; đổi gói /
  mua lần đầu ⇒ bảng giá đang niêm yết (gói cũ không bán mới). Mọi chỗ trước đây đọc thẳng `platform_plans.price_vnd` /
  `yearly_free_months` / `addon_prices` để lập hoá đơn (báo giá gia hạn, mua thêm, MRR, bảng kê, trang khách, trang giá, trang
  giới thiệu) nay đi qua resolver.
- **Sửa giá** (`setPlanPrice`, `setPlanAddonPrices`) = PHÁT HÀNH phiên bản CATALOG mới chép từ phiên bản hiện hành
  (`publishCatalogVersion`), hiệu lực ngay; dòng cũ bất biến ⇒ tính lại một kỳ cũ ra đúng số cũ. Gói cũ không có trong bảng giá
  hiện hành không sửa được (chuyển tổ chức sang phiên bản khác bằng `setOrgPriceVersion`, có lý do + nhật ký).
- **Thuế**: `tax_mode = 'UNDECLARED'` — không giả định VAT; hoá đơn VAT vẫn theo luồng 0192 (khách khai thông tin, người vận
  hành ghi số hoá đơn đã xuất). Trang giá in câu thuế của phiên bản.

### 2. Đồng hồ khách AI (`AI_CUSTOMER`)

- Ghi ở điểm gửi THÀNH CÔNG: `lib/sales-chatbot/fanpage.ts::markWaitingForCustomer` (một lời gọi `noteAiCustomerReply`) — hàm
  này chỉ được gọi sau khi câu trả lời AI đã tới kênh ở cả ba đường: fanpage nhắn, fanpage trả lời bình luận, Messenger. Lỗi
  ghi sổ bị nuốt và đếm (`aiCustomerMeterErrors`), không bao giờ làm hỏng việc gửi.
- Sổ: `platform_usage_events` (0224), chỉ số `chotdon.ai_customers` (`EVENT_LEDGER`, `recordUsage`). Khoá
  `ai_customer:<YYYY-MM>:<kênh>:<page>:<khách>`, khách = `sales_chat_conversations.visitor_key` (băm page + hội thoại / người gửi,
  không SĐT / tên). Chỉ mục duy nhất (tổ chức, khoá) ⇒ cùng khách cùng kỳ = 1 dòng dù nhiều hội thoại / tin / lần thử lại; khung
  THỬ không đếm.
- **Kỳ** = tháng lịch giờ VN — trùng kỳ hạn mức và credit AI. Nền móng chưa có kỳ thu theo ngày gia hạn của từng thuê bao, nên
  đồng hồ không chạy theo `paid_through` (hoá đơn gia hạn vẫn theo kỳ trả tiền của nó).
- **Độ phủ** (`aiCustomerCoverage`): workspace chỉ chạy runtime cũ `chatbot/` (bot nhà, container riêng) ⇒ `null` + «chưa đo»,
  KHÔNG 0; đồng hồ bật giữa kỳ (mốc = `created_at` của phiên bản V1 do 0228 ghi; ghi đè được ở
  `platform.pricing.ai-customer-meter-live-at`) ⇒ cận dưới, phần vượt `null`.
- Chưa đo: kênh Zalo OA và chat web công khai không đi qua `markWaitingForCustomer`.

### 3. Phần vượt, fair-use, cảnh báo

- `computeOverage` (thuần): vượt = `ceil(max(0, dùng − gồm) / 100) × đơn giá khối`; fanpage / người dùng thêm × đơn giá; ĐƠN
  không bao giờ có dòng; hội thoại / trả lời AI chỉ fair-use (`fairUseVerdict.billable = false`). Số dùng chưa biết ⇒ `null`.
  Enterprise `CONTRACT` (không tự tính); dùng thử và giá legacy không có phần vượt.
- Chưa tạo hoá đơn `OVERAGE` tự động (nền móng chưa có đường duyệt): phần vượt là ƯỚC TÍNH trên màn khách + dòng `OVERAGE` truy
  vết được trong bảng kê (`lib/saas/statement.ts`, engine `saas-statement-v2`); chốt kỳ đóng băng nó.
- `usageAlert`: 80% báo khách + vận hành · quá 100% tính phần vượt · 120% cảnh báo mạnh + đề xuất nâng gói · 150% người vận hành
  rà soát. `pauseBot` là hằng `false`. Ngưỡng theo phiên bản (`alert_thresholds`).
- Biên lãi chiếu (khung người vận hành `/platform/saas`): đích 75–85 · cảnh báo < 70 · nguy cấp < 60, sửa ở
  `platform.pricing.margin`.

### 4. Khách nội bộ

VNXCommerce đi cùng bộ máy: bảng kê `INTERNAL_CHARGEBACK` dùng CÙNG giá theo phiên bản + `computeOverage`. Gán gói thường nhỏ
nhất: `npx tsx scripts/pricing-internal-fit.ts` (CHẠY THỬ mặc định; `--apply --reason=…` ghi `platform_organizations.plan` +
ghim phiên bản hiện hành). Không gán khi khách AI chưa đo trọn kỳ (bot nhà còn chạy runtime cũ) hoặc khi trần AI kỹ thuật của
gói đích thấp hơn số dùng AI thật.

### 5. KPI giá trị (không phải trần thu)

`lib/pricing/value-kpis.ts`: đơn AI góp công / AI tạo / AI tự chốt, doanh thu nhờ AI (theo `ORDER_OUTCOME`), GMV nhờ AI (giá trị
đơn lúc tạo), tỷ lệ chốt, tỷ lệ nhận upsell — đọc lại đường đo đã có. `cross_sell_rate` = `UNAVAILABLE` (sổ sự kiện chưa có
`cross_sell.*`).

### 6. An toàn tiền & giới hạn (review 07/10/2026)

- **Lỗi đọc ghim / sổ giá ⇒ NÉM, không đệm**: báo giá gia hạn / mua thêm trả «thử lại», ảnh chụp MRR BỎ dòng tổ chức đó trong
  ngày (không ghi 0). Không bao giờ rơi về bảng giá hiện hành — hoá đơn mang phiên bản mới sẽ ghim khách cũ vào giá mới. Chỉ
  tổ chức đọc ghim THÀNH CÔNG mà không có dòng mới theo bảng giá hiện hành. Ghim trỏ phiên bản không còn ⇒ legacy + cảnh báo.
  Entitlement / trần người dùng dùng `plansForOrgSafe` (lỗi ⇒ `platform_plans` thô, phía hẹp).
- **Chỉ câu do MODEL sinh mới là khách AI**: engine trả `aiGenerated` (có chữ do model viết, sau bộ lọc); câu mẫu theo từ khoá /
  AI chọn câu mẫu, câu hệ thống, chuyển người, nhân viên ⇒ không đếm. Ghi tại `fanpage.ts` (nhắn + bình luận) và `messenger.ts`
  (nhắn + tin riêng bình luận) SAU khi gửi thành công (`!sendError && out.replies > 0`). Bài kiểm chạy đường gửi thật:
  `tests/ai-customer-send.test.ts`.
- **Gói giá 0 (dùng thử)** giữ trần tiền CỨNG = ngân sách dẫn xuất (chưa trả tiền; chính sách chi phí riêng, đăng ký mở tự do).
  Gói trả phí không trần cứng. Tỷ giá thiếu ⇒ ngân sách `null`, không chặn.
- **Mua thêm người dùng ở V1** = đơn giá «người dùng thêm» của chính phiên bản (49.000 ₫ / người / tháng, migration dẫn xuất
  `addon_prices.users` từ cột `overage`). Fanpage thêm không phải hạng mục mua thêm 0192 — chỉ là phần vượt. Tổ chức legacy có
  hạng mục mua thêm khác (trang, dung lượng…) đổi lên gói V1 bị báo «gói đích không bán phần đang có» — người vận hành gỡ phần
  đó (`setOrgAddons`) hoặc chuyển phiên bản trước.
- **Chốt kỳ**: bảng kê chốt ghi `priceVersionKey` của từng workspace vào ảnh chụp. Giới hạn: ghim không có lịch sử theo thời
  gian — chốt một kỳ cũ dùng ghim HIỆN TẠI; chốt ngay đầu tháng sau (như giới hạn v1 của COST_BILLING §4).
- **Soát lần 2**: bảng kê nháp / chốt kỳ đọc ghim KHÔNG nuốt lỗi — lỗi ⇒ không lập, `finalizeStatement` từ chối (không bao giờ
  chốt FINAL trên ghim rỗng). Trần AI: lỗi đọc ghim tạm thời ⇒ dùng kết quả đọc được gần nhất, chưa có thì KHÔNG chặn (mềm,
  đếm `priceReadWarningCount`) — không rơi về `platform_plans` thô. Khách AI đếm theo câu DO MODEL SINH đã gửi thành công ở
  CHÍNH lượt (không theo bộ đếm cộng dồn các vòng).
- **Đếm thiếu có chủ ý (thận trọng)**: tin nhắn lại (follow-up) do AI soạn (`lib/sales-chatbot/followup.ts`) chưa ghi khách AI;
  kênh Zalo OA và chat web cũng chưa. **Fanpage thêm 99.000 ₫** hôm nay chỉ tính qua dòng phần vượt của bảng kê — khách chưa tự
  mua thêm fanpage ở màn thanh toán được.
- **Tiến trình vừa khởi động** mà lần đọc sổ giá đầu tiên lỗi ⇒ `AI_LIMITS_UNREADABLE` (không trần nào): NỚI chứ không chặn, có
  đếm cảnh báo (`priceReadWarningCount`); đệm «đọc được gần nhất» theo khoá (tổ chức, gói) — tổ chức này không bao giờ mượn trần
  của tổ chức khác. Khách AI đếm theo NGUỒN từng câu (`TurnResult.aiTexts` do engine đánh dấu): câu mẫu chữ / kèm ảnh trong lượt
  model không bao giờ được đếm.
