# Chuyển tổ chức từ giá cũ (legacy) sang bảng giá V1

> Chủ shop giao 08/10/2026: «chuyển các tổ chức từ giá cũ sang bảng giá V1 — làm theo phương án tốt nhất». Giá V1 là quyết định đã
> chốt ở `PRICING_V1.md` (không sửa ở đây). Thiết kế hoá đơn vượt ở `OVERAGE.md`. Lõi: `lib/pricing/migration.ts`. Ops:
> `saas-v1-migration` (`scripts/saas-v1-migration.ts`). Bài kiểm: `tests/saas-v1-migration.test.ts`.

## 1. Phương án tốt nhất = ba nguyên tắc

1. **Có số trước khi ghi.** Chạy thử là mặc định và chỉ đọc. Postgres phải xác nhận kết nối ở chế độ chỉ đọc. Nó in số dùng thật,
   gói đề xuất, giá cũ → mới, phần vượt dự kiến và mọi hệ quả.
2. **Không bất ngờ cho khách.** Ghim chỉ đổi GIÁ THAM CHIẾU. Lượt ghim không bật thu phí, không tạo hoá đơn, không khởi động dùng
   thử. Không ô nào của `platform_subscriptions` bị ghi. Mọi điều làm khách bất ngờ đều là CHẶN (§4).
3. **Một tổ chức mỗi lần, có lý do, có nhật ký.** Lượt ghim ghi cột gói (`platform_organizations.plan`, cột `planKeyOf` đọc). Nó
   ghim phiên bản CATALOG hiện hành qua `pinOrgPriceVersion` (đường ghim của người vận hành, nguồn ghim `OPERATOR`). Nó ghi hai dòng
   nhật ký nền tảng `ORG_PLAN_SET` + `PRICE_VERSION_PIN`, nguồn `SCRIPT`. Cả bốn việc nằm trong MỘT giao dịch: cùng thành hoặc cùng
   không. Trong giao dịch, dòng ghim bị khoá (`FOR UPDATE`) và phải còn đúng ghim lúc đánh giá. Hoá đơn đang mở, cờ thu phí và cờ
   Số dư AI được hỏi lại; một thứ vừa đổi ⇒ không ghi gì.

Bật thu phí là một bước RIÊNG. Người vận hành làm bước đó ở `/platform/billing` sau khi đã báo khách (§6).

## 2. Cách chạy

| Việc | Ops `saas-v1-migration`, ô arg | Ghi gì |
|---|---|---|
| Chạy thử mọi tổ chức | (rỗng) | không |
| Chạy thử một tổ chức | `--org=<mã>` | không |
| Ghim một tổ chức | `--apply --org=<mã> --plan=<khoá> --reason=<lý do>` | cột gói + ghim + 2 dòng nhật ký |
| Chấp nhận phần vượt / số chưa đo | thêm `--accept-overage` | như trên |
| Chấp nhận khi thu phí đang bật | thêm `--accept-billing-on` | như trên |
| Chấp nhận trần kỹ thuật / nhịp luật thấp hơn hôm nay | thêm `--accept-lower-limits` | như trên |

- Ô arg của ops chỉ nhận chữ ASCII, số, khoảng trắng và `= : . _ , / @ + -`. Vì vậy lý do phải viết không dấu, và không có dấu
  nháy. Lý do là mọi từ đứng sau `--reason=` cho tới cờ kế tiếp. Lý do cần ít nhất 5 ký tự.
- Cả lượt chạy được MÃ HOÁ. Log công khai chỉ có dòng `[ops:tom-tat]`, mang mã tổ chức ĐỌC TỪ SỔ, gói đề xuất và phán quyết:
  `CHUYỂN ĐƯỢC`, `BỊ CHẶN (<mã>)` hoặc `BỊ LOẠI`. Log công khai không có tiền, không có số dùng và không bao giờ chép nội dung ô arg:
  lỗi cách dùng chỉ nói vị trí và loại lỗi, lượt ghim chỉ in phán quyết.
- Mã thoát: `0` xong · `64` sai cách dùng · `65` còn chặn, không ghi gì · `70` kết nối không ở chế độ chỉ đọc.
- Chạy tay trên máy có `.env`: `npx tsx scripts/saas-v1-migration.ts [--org=…]`.

## 3. Ai được chuyển

| Tổ chức | Kết luận | Lý do |
|---|---|---|
| Cửa hàng tự đăng ký (`brand` ≠ NULL) | LOẠI | Ba cửa hàng cũ sắp bị xoá (PR #673). Cửa hàng mới tự đăng ký đã theo bảng giá hiện hành |
| Ghim một phiên bản CATALOG / không ghim (khách) | LOẠI | Đã ở V1 hoặc mới hơn |
| Ghim một phiên bản riêng khác `legacy` (vd `prepaid-ai-v1`) | LOẠI | Phiên bản riêng không bị kéo sang V1 |
| `hslc-hmt-shop` | HOÃN (`V1_MIGRATION_DEFERRED`, TẠM) | Đi lộ trình «Trả trước theo khách AI» (PR #674, ops `org-prepaid-ai`). Xoá dòng hoãn khi #674 đã ghim HSLC vào `prepaid-ai-v1` — luật «phiên bản riêng» loại nó |
| ARCHIVED · SETUP_FAILED | LOẠI | Không hoạt động |
| Workspace NHÀ (VNXCommerce) | LOẠI khỏi lượt GHI (chạy thử vẫn in số dùng + gói nhỏ nhất / cận dưới) | Bất biến «nhà không đổi gói qua đường khách» (`lib/platform/org-plan.ts`, `applyInvoicePaid`, `PRICING_V1.md` §9). Gói thường cho nhà: `scripts/pricing-internal-fit.ts` khi khách AI đo trọn kỳ. `applyV1Migration` từ chối nhà ngay dòng đầu |
| Còn lại, ghim `legacy` | ĐỦ ĐIỀU KIỆN | — |

## 4. Số dùng và gói đề xuất

- **Fanpage đang nối**: `readFanpagesActive`, cùng hàm với sổ dùng. **Người dùng hoạt động**: `users.active`, cùng điều kiện với
  hạn mức gói. Cả hai đọc ở CSDL tổ chức, mở bằng `getDbForInspection` (không migrate, không ghi).
- **Khách AI 30 ngày**: lấy LỚN NHẤT của hai số, vì đó là phía an toàn.
  - Đồng hồ (`platform_usage_events`, `chotdon.ai_customers`). Đồng hồ ghi từ 07/10, nên 30 ngày hôm nay là chưa trọn = cận dưới.
  - Ước từ sổ AI = số hội thoại khác nhau có lượt AI bán hàng (`sales_chatbot`, OK). Số này là cận trên cho tin nhắn riêng. Nó
    KHÔNG chắc là cận trên khi có lượt không mang mã hội thoại, hoặc khi một luồng bình luận gồm nhiều người.
  - Workspace chạy bot runtime cũ (`chatbot/`) ⇒ đồng hồ CHƯA ĐO ⇒ khách AI `null`. Script không ước bằng một sổ có thể thiếu. Khi
    đó nó in thêm một «cận dưới chỉ theo fanpage + người dùng», và dòng ấy không phải đề xuất.
- **Gói đề xuất** = `smallestFittingPlan`: gói thường rẻ nhất có phần gồm phủ số dùng. Đây là cùng luật với khách nội bộ, không có
  luật thứ hai. Không đề xuất dùng thử, không đề xuất hợp đồng. Tổ chức đang chạy AI bán hàng (thuê bao Chốt Đơn hoặc module
  `ai_sales`) không bao giờ được đề xuất Inbox.
- **Phần vượt dự kiến** dùng `computeOverage` với phần gồm TÍNH TIỀN (`billableIncluded`, §7), cùng phép tính với bảng kê. Số
  dùng ở đây là số ƯỚC, nên con số này là dự kiến, không phải hoá đơn.

## 5. Chặn — ghim bị từ chối khi

| Mã | Khi nào | Vượt bằng cờ? |
|---|---|---|
| `ENTITLEMENT_BELOW_USAGE` | Số đang dùng THẬT (cùng bộ đếm `checkEntitlement`: người dùng · trang · đối tượng · bản ghi · luật · bản nháp AI hôm nay · dung lượng) vượt trần kỹ thuật của gói đích — lượt tạo kế tiếp bị từ chối | không |
| `LOWER_LIMITS` | Trần kỹ thuật của gói đích (dòng gói phủ phiên bản + mua thêm, như `resolvePlan`) THẤP HƠN hôm nay ở bất kỳ loại nào, hoặc nhịp luật tự động chậm hơn (`workflowCadenceMinutes`). Vd legacy `standard` → V1 `starter`: người dùng 25 → 5, trang 50 → 10 | `--accept-lower-limits` |
| `OVERAGE_EXPECTED` | Gói đích nhỏ hơn số dùng, tức sẽ sinh phần vượt bất ngờ. Với người dùng, câu chặn nói rõ «KHÔNG thêm được người dùng» (trần kỹ thuật = phần gồm + ghế đã mua) | `--accept-overage` |
| `USAGE_UNKNOWN` | Chưa đo được một số dùng | `--accept-overage` |
| `BILLING_ON` | Thu phí đang BẬT: lần gia hạn kế tính theo giá V1 | `--accept-billing-on` |
| `NO_AI_SALES` | Gói đích không có AI bán hàng mà tổ chức đang dùng | không |
| `FEATURE_LOSS` | Mất tính năng đang có. Chọn gói lớn hơn hoặc khai ghi đè tính năng trước | không |
| `AI_WOULD_BLOCK` | Trần AI sau khi ghim chặn một lượt AI chạy được hôm nay. Phép so là `evaluateAiQuota` của runtime, cho cả khoá riêng (BYOK) lẫn AI dùng chung | không |
| `AI_BALANCE_ON` | Số dư AI đang bật. Ở V1, khách vượt bị trừ số dư; hết số dư thì khách MỚI không nhận AI | không |
| `OPEN_INVOICE` | Có hoá đơn đang mở. Trả hoá đơn ấy sẽ ghim tổ chức NGƯỢC về phiên bản của hoá đơn | không |
| `ADDON_NOT_SOLD` | Thu phí bật mà tổ chức đã mua thêm hạng mục gói đích không bán. Báo giá gia hạn sẽ từ chối (thu phí tắt thì chỉ là lưu ý) | không |
| `CHOTDON_OWN_PLAN` | Thuê bao Chốt Đơn mang gói riêng khác gói đích. Bảng kê tính phần vượt theo gói ấy | không |
| `TARGET_NOT_SELLABLE` · `TARGET_NOT_IN_CATALOG` · `NO_CATALOG` · `READ_FAILED` | Gói đích là dùng thử / hợp đồng / không có; hoặc không đọc đủ sự thật | không |

**Bot dùng khoá riêng (BYOK) có bị chặn sau khi ghim V1 không? Không** — và bài kiểm chứng minh điều đó trên PGlite.

- Cổng gói (`ai-gate.ts`) chỉ dừng AI ở GÓI DÙNG THỬ hoặc khi tổ chức SUSPENDED. Script không bao giờ ghim vào gói dùng thử.
- Trần AI của gói AI V1 không có trần cứng nào (`catalogAiLimits`, `softOnly`). Vì vậy ghim chỉ NỚI trần so với giá cũ. Ghi đè
  lạm dụng của người vận hành vẫn áp như trước.
- Cổng Số dư AI chỉ chặn khi cờ BẬT, và cờ bật thì ghim đã bị chặn ở bước trên (`AI_BALANCE_ON`).
- Đồng hồ khách AI ở gói trả phí chỉ sinh phần vượt, không tắt bot (`pauseBot` là hằng `false`).

Lưu ý in ra cho người vận hành: credit AI dùng chung đổi từ trần CỨNG sang NGÂN SÁCH MỀM. Sau khi ghim, chi phí AI nền tảng không
còn bị chặn ở credit, nên cần theo dõi ở `/platform/saas`.

## 6. Bảng quyết định mặc định (phương án tốt nhất — theo `OVERAGE.md` §11)

| Câu hỏi | Mặc định áp dụng | Ghi chú |
|---|---|---|
| Ghim giá có kéo theo thu phí? | KHÔNG. Ghim chỉ đổi giá tham chiếu; bật thu phí là bước riêng của người vận hành | Khách thấy giá V1 trên `/settings/plan` (ước tính) trước khi trả đồng nào |
| Kỳ thu phần vượt (Q2) | Tháng lịch giờ VN, thu SAU từng tháng | Trùng kỳ đồng hồ khách AI (`usagePeriodOf`) |
| Đường duyệt (Q3) | Người vận hành duyệt TỪNG hoá đơn vượt | Chưa có loại hoá đơn `OVERAGE`. PR O2/O3 của `OVERAGE.md` |
| Quá hạn phần vượt (Q4) | CHỈ NHẮC — không khoá, không tắt bot | Số ngày hạn trả chờ chủ shop |
| Ghế (Q6) | Người dùng bán TRƯỚC (ADDON). Fanpage đếm theo ảnh chụp cuối kỳ | Ghế đã mua không bị tính lại (§7) |
| Gói chọn khi chưa đo trọn | Gói nhỏ nhất vừa số ƯỚC lớn nhất | Thà Starter → Growth đúng số hơn là phần vượt bất ngờ |
| VNXCommerce (nhà) | Gói thường nhỏ nhất vừa số dùng thật, INTERNAL_CHARGEBACK, không thu tiền | Bot nhà còn runtime cũ ⇒ chưa đo khách AI ⇒ chỉ cận dưới; gán thật khi đo trọn kỳ (`scripts/pricing-internal-fit.ts`) |

**Việc còn chờ chủ shop — máy không tự quyết:**

1. Q1: khai tài khoản nhận tiền ở `/platform`. Chưa khai thì không tạo được mã chuyển khoản nào, kể cả khi đã bật thu phí.
2. Q8: báo trước khách bao lâu trước khi bật thu phí theo giá V1, và ngày hiệu lực.
3. Q4: số ngày hạn trả hoá đơn vượt.
4. Gói cụ thể cho từng tổ chức khi chạy thử báo `BỊ CHẶN`. Ví dụ: mất tính năng ⇒ lên gói lớn hơn hay ghi đè tính năng.

## 7. Phần gồm tính tiền dùng chung — sửa lỗi thu đôi ghế (OVERAGE O1)

`billableIncluded` (`lib/pricing/versions.ts`) tính phần gồm theo thứ tự: **dòng giá → ghi đè hạn mức của người vận hành → + ghế
người dùng đã mua thêm**. Ba nơi dùng chung hàm này: màn khách (`lib/pricing/customer.ts`), bảng kê (`lib/saas/customers.ts`) và
khung người vận hành (`lib/pricing/admin.ts`). Lượt chuyển V1 cũng dùng nó.

Trước bản sửa có hai lỗi:

- Khách Starter mua thêm 2 người và dùng đủ 7 người bị tính 2 × 49.000 ₫ «người dùng thêm». Khách đó còn trả cả dòng «Hạn mức mua
  thêm», tức là THU ĐÔI.
- Bảng kê bỏ qua ghi đè của người vận hành, còn màn khách thì áp. Vì vậy hai màn có thể nói hai số cho cùng một kỳ.

Với 8 tổ chức giá cũ, hôm nay chưa ai bị tính. Đó là lý do bản sửa phải vào TRƯỚC khi tổ chức đầu tiên sang V1.

**Bản sửa CÓ đổi số của tổ chức đã ở CATALOG mà có `platform_org_pricing.quota_overrides` (người dùng / fanpage) hoặc ghế đã mua
thêm.** Đó là các cửa hàng tự đăng ký sau 0228. Phần vượt ƯỚC TÍNH trên màn khách và dòng `OVERAGE` của bảng kê NHÁP sẽ theo phần
gồm mới. Bảng kê ĐÃ CHỐT không đổi, vì nó đọc ảnh chụp. Integration Lead đếm số tổ chức này trên production TRƯỚC khi deploy, bằng
`db-query`: tổ chức không ghim `legacy` có `quota_overrides ? 'users'` / `? 'fanpages'` hoặc `addons ? 'users'`.

`smallestFittingPlan` (nhận `includedOf`) và `scripts/pricing-internal-fit.ts` cũng so số dùng với CÙNG phần gồm tính tiền này.

Hai giới hạn còn lại:

- Với tổ chức giá cũ, phần gồm người dùng hiển thị nay theo DÒNG GIÁ. Dòng giá là ảnh chụp `platform_plans` lúc 0228, không phải
  hạn mức hiện tại. Giá cũ không có phần vượt, nên tiền không đổi.
- `loadCustomerEntitlementView` (khung L5) vẫn đọc hạn mức người dùng theo `pricing.quotas` và không cộng ghế mua thêm. Đó chỉ là
  hiển thị, không phải tiền.

## 8. Bảng «tổ chức → gói đề xuất» dự kiến

Mã nguồn không chứa số dùng của khách. Cột đề xuất do Integration Lead điền từ lượt chạy thử ops `saas-v1-migration`, đọc ở phần
mã hoá.

| Tổ chức | Kết luận dự kiến từ mã | Gói đề xuất |
|---|---|---|
| VNXCommerce (nhà) | LOẠI khỏi lượt ghim (bất biến nhà). Chạy thử in số dùng; khách AI chưa đo (runtime cũ) ⇒ chỉ cận dưới theo fanpage + người dùng | gán bằng `pricing-internal-fit` khi đo trọn kỳ |
| `hslc-hmt-shop` | HOÃN — lộ trình trả trước | — |
| 3 cửa hàng tự đăng ký cũ | LOẠI (`brand` ≠ NULL), sắp bị xoá | — |
| Các tổ chức pilot còn lại | Đủ điều kiện nếu ghim `legacy` | theo lượt chạy thử |
