# Hoá đơn vượt gói (OVERAGE) — thiết kế V1

> Thiết kế CHỈ TÀI LIỆU cho MASTER MISSION §30 (08/10/2026, đọc mã ở `origin/main` `051f49a5`). Giá và đơn giá vượt là quyết
> định ĐÃ CHỐT ở `PRICING_V1.md` (không sửa ở đây). Số dư AI trả trước ở `AI_BALANCE_V1.md`, bảng kê ở `COST_BILLING.md`, thu
> tiền thuê bao ở `docs/platform/billing.md`. Tài liệu này chỉ thiết kế MẮT XÍCH CÒN THIẾU: biến phần vượt (hôm nay mới là ƯỚC
> TÍNH) thành một khoản thu có chứng từ. Nó cũng liệt kê đúng những điều máy KHÔNG được tự quyết (§11). Chưa có dòng mã nào.

## 1. Hiện trạng — đã có gì, thiếu đúng chỗ nào

| Mảnh | Đã có (tệp:dòng) | Còn thiếu |
|---|---|---|
| Bảng giá V1 có phiên bản: phần gồm + luật vượt từng gói | `drizzle/0228_pricing_v1_versions.sql:116-139` · đọc qua `lib/pricing/versions.ts:71-84` (`INCLUDED_SPEC`, `OverageSpec`) | — |
| Đồng hồ khách AI (đơn vị thu chính) | ghi ở điểm gửi thành công `lib/pricing/ai-customer.ts:118` · khoá một khách chuẩn một kỳ `lib/pricing/ai-customer-identity.ts:70-72` (khoá cũ `lib/pricing/versions.ts:558`) · độ phủ `lib/pricing/versions.ts:570` | tin nhắn lại do AI soạn chưa đếm (`PRICING_V1.md` §II.6, cố ý) |
| Phép tính phần vượt (thuần) | `computeOverage` `lib/pricing/versions.ts:400` · khối `:377` · hoá đơn ước tính `estimateBill` `:426` | — |
| Cảnh báo 80 · 100 · 120 · 150% | `usageAlert` `lib/pricing/versions.ts:323` · gửi thật một lần mỗi ngưỡng mỗi kỳ `lib/pricing/usage-alerts.ts:51`, chạy trong job `sales-health` `lib/sync/jobs.ts:845` | — |
| Bảng kê nháp có dòng `OVERAGE` | `lib/saas/statement.ts:103` (lấy từ `billedOverage` dựng ở `lib/saas/customers.ts:224`) | — |
| Chốt kỳ (bất biến, luật 21) | `finalizeStatement` `lib/saas/billing.ts:19` — chỉ kỳ đã qua `:21` | — |
| Không thu đôi với Số dư AI | `overageNetOfBalance` `lib/pricing/versions.ts:442`, áp ở `lib/saas/customers.ts:185` và màn khách `lib/pricing/customer.ts:131` | — |
| Số dư AI trả trước | trừ từng khách vượt `lib/billing/ai-usage-charge.ts:47` · cổng hết số dư `lib/pricing/ai-gate.ts:129` · cờ `ai_balance.enabled` `lib/billing/ai-balance.ts:83` | cờ TẮT ở mọi tổ chức (kiểm kê 08/10) |
| Hoá đơn + thu tiền qua SePay | `platform_invoices` `db/schema.ts:5212` · mở hoá đơn `lib/billing/service.ts:325` · khớp tiền `:542` · áp tiền `:461` | **`kind` chỉ nhận `RENEWAL` · `ADDON`** (`db/schema.ts:5261`, migration 0192) — không có đường nào lập hoá đơn phần vượt |
| Tài khoản nhận tiền | đọc `lib/billing/receiver.ts`; chưa khai thì không tạo được mã (`lib/billing/service.ts:326`) | **chưa khai** (`AI_BALANCE_V1.md` §4.1) |
| Ghim phiên bản giá | `platform_price_pins` `db/schema.ts:5789` | **8/8 tổ chức ghim `legacy`** (kiểm kê 08/10) — giá legacy không có phần vượt (`PRICING_V1.md` §II.3) |

Hệ quả hôm nay: KHÔNG tổ chức nào phát sinh được một đồng phần vượt. Không có loại hoá đơn để thu, và cả tám tổ chức đều đang ở
giá legacy. Phần vượt chỉ tồn tại ở hai chỗ: hoá đơn ƯỚC TÍNH trên màn khách, và dòng `OVERAGE` của bảng kê nháp / đã chốt.

## 2. Bảng chân lý: khoản nào thu bằng đường nào

Một khoản kinh tế có ĐÚNG MỘT đường thu trong một kỳ (cùng tinh thần AGENTS mục 15). Đây là đề xuất; các ô có dấu ⚑ chờ chủ shop
(§11).

| Khoản | Số dư AI TẮT (mặc định) | Số dư AI BẬT (tổ chức đã bật cờ) |
|---|---|---|
| Khách AI vượt phần gồm | Hoá đơn `OVERAGE` cuối kỳ, theo KHỐI 100 khách (59.000 · 49.000 · 39.000 ₫) | Trừ số dư lúc phát sinh, theo ĐƠN GIÁ từng khách (590 · 490 · 390 ₫ — `lib/billing/ai-usage-charge.ts:36`). Khách vượt CHƯA trừ được (trước khi bật cờ, lượt trừ hỏng) vào hoá đơn `OVERAGE` theo khối (`overageNetOfBalance`) |
| Fanpage thêm | Hoá đơn `OVERAGE` cuối kỳ, 99.000 ₫ / page / tháng ⚑ cách đếm | như cột trái — Số dư AI không trả ghế |
| Người dùng thêm | MUA TRƯỚC bằng hoá đơn `ADDON` (đã có, 0192 — `lib/billing/service.ts:399`). Vượt chỉ có thể xảy ra sau khi hạ gói, vì số người dùng có trần kỹ thuật (`lib/users/create-user.ts:70` → `lib/entitlements/check.ts:174`) ⚑ | như cột trái |
| Hội thoại AI · trả lời AI | KHÔNG BAO GIỜ thu — fair-use (`fairUseVerdict.billable = false`, `lib/pricing/versions.ts:338-353`) | như cột trái |
| Đơn hàng | KHÔNG BAO GIỜ thu (`INCLUDED_SPEC.orders = NEVER`, `lib/pricing/versions.ts:77`) | như cột trái |
| Dùng thử | không có phần vượt; hết lượt ⇒ AI dừng (L5, `PRICING_V1.md` §II.7) | Số dư AI chỉ cho gói trả phí (`AI_BALANCE_V1.md` §1.2) |
| Enterprise | hợp đồng (`mode = CONTRACT`, `lib/pricing/versions.ts:402`) — lập tay ⚑ | như cột trái |
| Khách nội bộ VNX | bảng kê `INTERNAL_CHARGEBACK`, KHÔNG hoá đơn thu tiền (`COST_BILLING.md` §2) | — |

Chênh lệch giữa hai cột của dòng đầu là có chủ đích (`AI_BALANCE_V1.md` §1.1): khối làm tròn LÊN (vượt 101 khách = 2 khối =
118.000 ₫), còn trừ số dư tính đúng từng khách (101 × 590 = 59.590 ₫). Chủ shop xác nhận chênh lệch này là chấp nhận được (⚑ Q5).

## 3. Phép tính — đã có, không viết lại

```
khối vượt      = ceil(max(0, khách AI của kỳ − gồm) / 100)          lib/pricing/versions.ts:377-382
tiền khách AI  = khối vượt × đơn giá khối của gói                     :409-414
tiền ghế       = max(0, đang dùng − gồm) × đơn giá ghế               :384-393
tổng           = null nếu còn dòng CHƯA BIẾT (không lập hoá đơn)      :417-420
```

- Khách AI chỉ tính khi độ phủ của kỳ là `MEASURED` (`lib/pricing/versions.ts:410-412`). `PARTIAL` (đồng hồ bật giữa kỳ, hoặc
  còn runtime cũ `chatbot/`) hay `NOT_MEASURED` ⇒ dòng `null`. Cận dưới không phải số để thu (AGENTS mục 42).
- Gói gồm 0 khách AI (Inbox) không có dòng khách AI (`:409`). Phần gồm `null` (Enterprise) ⇒ 0 khối.

### 3.1 Ví dụ (bảng giá V1, không đổi số nào)

| Gói | Dùng trong kỳ | Phần vượt | Tiền vượt | Hoá đơn ước tính |
|---|---|---|---|---|
| Starter | 1.650 khách AI · 3 fanpage | 150 khách ⇒ 2 khối × 59.000 | 118.000 ₫ | 790.000 + 118.000 = 908.000 ₫ |
| Growth | 3.420 khách AI · 12 fanpage | 420 khách ⇒ 5 khối × 49.000 · 2 page × 99.000 | 245.000 + 198.000 = 443.000 ₫ | 1.933.000 ₫ |
| Scale | 7.501 khách AI | 1 khách ⇒ 1 khối × 39.000 | 39.000 ₫ | 3.029.000 ₫ |

### 3.2 Khi nào nâng gói rẻ hơn trả phần vượt (dẫn xuất từ giá V1, chỉ tính khách AI)

| Từ → sang | Trả vượt theo khối: nâng rẻ hơn khi khách AI ≥ | Trả qua Số dư AI: nâng rẻ hơn khi khách AI ≥ |
|---|---|---|
| Starter → Growth | 2.601 (12 khối = 708.000 ₫ > chênh giá gói 700.000 ₫) | 2.687 |
| Growth → Scale | 6.001 (31 khối = 1.519.000 ₫ > 1.500.000 ₫) | 6.062 |
| Scale → Enterprise («từ 5.990.000») | 15.101 (77 khối = 3.003.000 ₫ > 3.000.000 ₫) | 15.193 |

Màn khách đã có câu «Nâng gói thường rẻ hơn trả phần vượt» ở ngưỡng 120% (`lib/pricing/usage-alerts.ts:46`). Bảng trên cho phép
thay câu chung chung ấy bằng một con số cụ thể. Bảng dẫn xuất từ dòng giá đang ghim của chính tổ chức, không gõ số vào mã.

## 4. Vòng đời một kỳ

```
Tháng M (giờ VN, usagePeriodOf — lib/pricing/meter.ts:67) đang chạy
  · đồng hồ ghi khách AI · 80/100/120/150% báo khách + người vận hành (đã có)
  · nếu Số dư AI bật: khách vượt trừ số dư ngay lúc phát sinh (đã có)
Ngày 1 tháng M+1 trở đi
  1. Người vận hành CHỐT bảng kê tháng M (đã có — lib/saas/billing.ts:19, ảnh chụp bất biến)
  2. Máy dựng hoá đơn OVERAGE NHÁP cho từng workspace từ ĐÚNG ảnh chụp ấy — không tính lại   (MỚI)
     · bỏ qua khi tổng = 0, hoặc còn dòng CHƯA BIẾT (in lý do, không lập)
  3. DUYỆT ⚑ Q3 — V1 đề xuất: người vận hành bấm «Phát hành», bắt buộc lý do + nhật ký nền tảng            (MỚI)
     ⇒ hoá đơn OPEN, mã ERPHD… + VietQR tới tài khoản nhận (đường 0187 có sẵn)
  4. Khách chuyển khoản ⇒ SePay ⇒ reconcileBillingPayments (không đổi) ⇒ PAID
     · chỉ dòng do SePay tạo vào đúng tài khoản nhận mới tự khớp (lib/billing/service.ts:590)
  5. Quá hạn N ngày ⚑ Q4 ⇒ chỉ nhắc (V1). KHÔNG khoá, KHÔNG tắt bot.                                     (MỚI)
  6. Huỷ / phát hành lại: VOID có lý do (đã có — lib/billing/service.ts:984), phát hành lại từ cùng ảnh chụp
```

Vì sao dựng từ bảng kê ĐÃ CHỐT mà không tính lại lúc phát hành: số trên hoá đơn phải truy về đúng một chứng từ bất biến. Tính lại
lúc phát hành thì sửa công thức tháng sau đổi được số của hoá đơn tháng trước (luật 21, mục 8.9).

## 5. Dùng thử · ân hạn · nâng / hạ gói · giá legacy

| Tình huống | Hôm nay (mã) | Đề xuất cho phần vượt |
|---|---|---|
| Dùng thử | 7 ngày, 100 khách AI; hết lượt hoặc hết hạn ⇒ AI dừng tự trả lời, hộp thư vẫn chạy (`lib/pricing/ai-gate.ts:146`); bảng kê bỏ phần vượt khi mọi thuê bao đang dùng thử (`lib/saas/statement.ts:102-103`) | Không đổi. Không bao giờ có hoá đơn `OVERAGE` cho kỳ dùng thử |
| Ân hạn thuê bao | `paid_through` + `grace_days` (mặc định 7, dùng thử tự đăng ký 3 — `lib/billing/rules.ts:34,167`) ⇒ `LOCKED` chỉ xem (`:114-125`, `:237-242`) | Hoá đơn `OVERAGE` KHÔNG đụng `paid_through`. Chưa trả phần vượt không làm workspace bị khoá ở V1 (`PRICING_V1.md` §I.5: chính sách chưa trả tiền là RIÊNG) ⚑ Q4 |
| Nâng gói giữa kỳ | gói mới hiệu lực khi tiền về (`lib/billing/service.ts:494-500`), kỳ trả tính từ hôm nay, trừ phần chưa dùng (`lib/billing/rules.ts:323-326`) | Phần gồm khách AI của kỳ = phần gồm của gói CAO NHẤT có hiệu lực trong kỳ (có lợi cho khách, tất định, dựng từ hoá đơn `RENEWAL` đã trả của kỳ) ⚑ Q7 |
| Hạ gói giữa kỳ | kỳ nối sau `paid_through` (`lib/billing/rules.ts:320-322`) | như trên. Người dùng đang vượt trần gói mới hiện cảnh báo trước khi hạ (không tự xoá người dùng) |
| Đổi gói nhiều lần | bảng kê dựng bằng gói + ghim LÚC CHỐT (`COST_BILLING.md` §4 — giới hạn v1) | cần lịch sử gói theo ngày — đọc từ `platform_invoices` đã PAID + `platform_audit_log` (`INVOICE_PAID` before/after), không thêm bảng |
| Giá legacy (8/8 tổ chức) | không có phần vượt | Muốn thu theo V1 thì phải chuyển ghim từng tổ chức (`setOrgPriceVersion`, có lý do + nhật ký — `PRICING_V1.md` §II.1) ⚑ Q8 |

## 6. Quan hệ với Số dư AI và SePay QR

- **Cùng một tài khoản nhận** cho thuê bao, nạp số dư và phần vượt. Chủ shop đã chốt cho tiền nạp (`AI_BALANCE_V1.md` §1.4), còn
  với phần vượt thì phải xác nhận (⚑ Q1). Ba loại tiền tách bằng TIỀN TỐ MÃ: `ERPHD…` cho hoá đơn (gia hạn · mua thêm · vượt —
  `lib/billing/rules.ts:42`), `ERPNAP…` cho nạp (`lib/billing/ai-balance-rules.ts:65`). Một lượt đọc sổ ngân hàng xử lý cả hai
  (`lib/billing/service.ts:557`). Một bút toán chỉ trả MỘT chứng từ (`platform_billing_payments.bank_ref` UNIQUE,
  `db/schema.ts:5305`).
- **Không thu đôi khách AI**: dòng khách AI của hoá đơn `OVERAGE` lấy từ bảng kê đã trừ ĐÚNG số khách đã thu qua sổ cái trong
  chính kỳ đó (đếm dòng `aic-charge`, không theo cờ — `lib/pricing/versions.ts:434-462`). Bật / tắt cờ giữa tháng vẫn đúng.
- **Không trộn tiền**: tiền nạp không bao giờ trả hoá đơn (`lib/billing/service.ts:949`), và hoá đơn không trừ vào số dư. Khách
  muốn dùng số dư để trả phần vượt ghế ⇒ không hỗ trợ ở V1 (số dư là «Số dư AI», chỉ cho khách AI).
- **Khi đã bật Số dư AI**: hoá đơn `OVERAGE` thường chỉ còn dòng fanpage. Hết số dư ⇒ khách MỚI không nhận AI
  (`lib/pricing/ai-gate.ts:129`), không có nợ phần vượt khách AI tích lại. Đó là lý do Số dư AI là đường đầu tiên biến phần vượt
  thành tiền thật (`AI_BALANCE_V1.md` §5).

## 7. Nơi chặn và nơi cảnh báo

| Ở đâu | Chặn gì | Cảnh báo gì | Nguồn |
|---|---|---|---|
| Runtime AI Bán hàng | CHỈ dùng thử (hết lượt / hết hạn) và tổ chức `SUSPENDED`; Số dư AI bật mà hết tiền ⇒ chặn khách MỚI | — | `lib/pricing/ai-gate.ts:146`, `:129` |
| Gói trả phí ở 100% / 120% / 150% | KHÔNG chặn — `pauseBot` là hằng `false` (`lib/pricing/versions.ts:319`) | khách + người vận hành, một lần mỗi ngưỡng mỗi kỳ | `lib/pricing/usage-alerts.ts:51` |
| Thêm người dùng | chặn ở trần gói + phần đã mua | màn khách mời mua thêm | `lib/entitlements/check.ts:174` |
| Thêm fanpage | không có trần kỹ thuật (`PRICING_V1.md` §II.1) | màn khách hiện «fanpage thêm 99.000 ₫ / tháng» trước khi nối page thứ (gồm + 1) (MỚI, đề xuất) | — |
| Hoá đơn `OVERAGE` quá hạn | KHÔNG chặn ở V1 ⚑ Q4 | chuông khách theo nhịp chủ shop đặt + một tin gộp cho người vận hành mỗi ngày | (MỚI) |
| Chốt bảng kê | từ chối chốt kỳ đang chạy, từ chối khi đọc ghim / sổ hỏng | — | `lib/saas/billing.ts:21`, `:29-30` |
| Phát hành hoá đơn `OVERAGE` | từ chối khi còn dòng CHƯA BIẾT, khi tổng = 0, khi đã có hoá đơn chưa huỷ cho cùng (workspace, kỳ) | — | (MỚI) |

## 8. Ai thấy gì

**Khách** (`/settings/plan`, trang con `/settings/ai-balance`) thấy:

- gói, kỳ, ngày đặt lại (`lib/pricing/customer.ts:60-61`);
- khách AI: đã dùng / gồm / còn lại, kèm độ phủ «đo trọn kỳ · cận dưới · chưa đo» (`:42`, `:127`);
- fanpage, người dùng: dùng / gồm (`:128-129`);
- fair-use: chỉ một cờ «vượt mức dùng hợp lý — không thu thêm» (`:116`);
- hoá đơn ƯỚC TÍNH kỳ này = gói + phần vượt, đã trừ khách thu qua số dư (`:119`, `:131`);
- MỚI: «nâng lên X rẻ hơn từ N khách AI» (§3.2);
- MỚI: hoá đơn vượt đã phát hành: kỳ, từng dòng (số khối khách AI, số fanpage thêm), số tiền, hạn trả, mã QR / số tài khoản /
  nội dung chuyển khoản (cùng khung với gia hạn), trạng thái.

**Khách KHÔNG BAO GIỜ thấy**: token, model, nhà cung cấp AI, chi phí AI, biên lãi, ngân sách AI mềm. Đã có bài kiểm duyệt đệ
quy (`tests/saas-l5-billing-trial.test.ts`, `tests/saas-hide-internal.test.ts:61`). Màn hoá đơn mới phải nằm trong phạm vi quét.

**Người vận hành** (`/platform/customers/[code]`) thấy: bảng kê nháp / đã chốt (đã có), nút «Phát hành hoá đơn vượt» trên kỳ đã
chốt, danh sách hoá đơn vượt theo trạng thái, khoản tiền chưa khớp (đã có ở `/platform`), và kinh tế đơn vị (doanh thu · chi phí AI
· biên — đã có ở `/platform/saas`).

## 9. Dữ liệu dự kiến (PHÁC — chưa có trong `drizzle/`)

Đề xuất MỞ RỘNG `platform_invoices` (một bảng hoá đơn, một bộ khớp tiền), không dựng bảng hoá đơn thứ hai. Số migration lấy bằng
`npm run ai -- migration reserve` lúc làm (sổ 08/10 đang ở 0235; `0236` đã có PR giữ). Phác:

```sql
-- PHÁC, không chạy. Thứ tự và cú pháp thật theo quy trình migration của kho (AGENTS mục 4).
ALTER TABLE platform_invoices DROP CONSTRAINT platform_invoices_kind_check;
ALTER TABLE platform_invoices ADD CONSTRAINT platform_invoices_kind_check CHECK (kind IN ('RENEWAL','ADDON','OVERAGE'));
ALTER TABLE platform_invoices ADD COLUMN statement_id text REFERENCES platform_billing_statements(id);
ALTER TABLE platform_invoices ADD COLUMN period_month date;      -- ngày 1 của kỳ, giờ VN
ALTER TABLE platform_invoices ADD COLUMN due_date date;          -- phát hành + N ngày (N ở cài đặt, ⚑ Q4)
ALTER TABLE platform_invoices ADD COLUMN lines jsonb;            -- ảnh chụp dòng OVERAGE của workspace từ bảng kê
-- months_check thêm vế: kind = 'OVERAGE' AND months = 0 AND addon_kind IS NULL AND statement_id IS NOT NULL AND period_month IS NOT NULL
DROP INDEX platform_invoices_one_open;
CREATE UNIQUE INDEX platform_invoices_one_open ON platform_invoices (org_code, kind) WHERE status = 'OPEN';
CREATE UNIQUE INDEX platform_invoices_overage_period ON platform_invoices (org_code, period_month) WHERE kind = 'OVERAGE' AND status <> 'VOID';
```

Cấu hình (không hằng số trong mã — luật 38), ví dụ `platform_settings['platform.billing.overage']`:
`{ "issue": "MANUAL", "dueDays": null, "minAmountVnd": null, "remindEveryDays": null }`. Ô `null` = CHƯA KHAI. Chưa khai thì
nút phát hành vẫn chạy được, nhưng hoá đơn không có hạn trả và máy không nhắc.

Bất biến mà đường ghi phải giữ, mỗi cái một bài kiểm:

1. Một (workspace, kỳ) có tối đa MỘT hoá đơn `OVERAGE` chưa huỷ. Bấm hai lần ra một dòng.
2. Hoá đơn `OVERAGE` lấy số từ `platform_billing_statements.snapshot`, không gọi lại `computeOverage`. Đổi công thức sau khi phát
   hành không đổi số.
3. `applyInvoicePaid` (`lib/billing/service.ts:461`) thêm nhánh `OVERAGE`: chỉ đổi trạng thái + nhật ký. KHÔNG đổi `paid_through`,
   gói hay ghim (khác hẳn nhánh `RENEWAL` ở `:494-503`).
4. `openInvoice` hôm nay VOID MỌI hoá đơn đang mở khi khách tạo mã mới (`lib/billing/service.ts:335-358`). Nếu giữ nguyên, khách
   bấm gia hạn sẽ huỷ luôn hoá đơn vượt đang chờ trả. Sửa thành chỉ VOID hoá đơn CÙNG loại. Hoá đơn `OVERAGE` chỉ người vận hành
   huỷ được, có lý do.
5. Tiền nạp `ERPNAP` không bao giờ trả hoá đơn `OVERAGE`; một `bank_ref` trả đúng một chứng từ (đã có).
6. Dùng thử, legacy, `CONTRACT`, khách nội bộ: không bao giờ có hoá đơn `OVERAGE`.

## 10. Thứ tự PR (đề xuất)

| PR | Nội dung | Mức R / sàn gộp (`RISK_SCALE.md`) | Chờ gì |
|---|---|---|---|
| O1 | MỘT hàm «phần gồm tính tiền» dùng chung cho màn khách, bảng kê và (sau này) hoá đơn. Phần gồm = dòng giá + ghi đè người vận hành + ghế đã MUA THÊM (0192). Kèm bài kiểm không thu đôi ghế (§12.1) | R1 · MEDIUM hôm nay (đề xuất HIGH cho `lib/pricing/`, `lib/saas/`) | không — làm được ngay, production không đổi số (8/8 legacy) |
| O2 | Migration §9 + `db/schema.ts`, chưa có đường ghi | R3 · HIGH, SERIAL | chủ shop trả lời Q2 · Q3 · Q4 |
| O3 | `issueOverageInvoice(statementId, orgCode)` (người vận hành, lý do + nhật ký) · nhánh `OVERAGE` ở `applyInvoicePaid` · `openInvoice` chỉ VOID cùng loại · bài kiểm bất biến §9 | R4 (luật từ khoá «billing», `lib/constants/tech-policy.ts:50-52`) · HIGH `lib/billing/` | O2 + Q1 |
| O4 | Màn khách (hoá đơn vượt + QR + ngưỡng nâng gói §3.2) và nút người vận hành | R1 · LOW `app/(dashboard)/` | O3 |
| O5 | Nhắc hạn / quá hạn theo Q4, chạy trong job có sẵn (không lịch mới — AGENTS §7) | R3 | O3 + Q4 |
| O6 | Chuyển từng tổ chức legacy → V1, gán gói thường cho VNX (E6) | R4 — việc của chủ shop, không phải mã | Q8 |
| E3 | Đếm khách AI cho tin nhắn lại do AI soạn (`lib/sales-chatbot/followup.ts:176`) | R3 (đổi số phải trả) | chủ shop đồng ý (Q10) |

## 11. Quyết định của chủ shop — máy KHÔNG tự quyết

| # | Câu hỏi | Phương án (đề xuất của kỹ thuật in đậm) |
|---|---|---|
| Q1 | Tài khoản nhận tiền phần vượt | Khai tài khoản nhận ở `/platform` — hôm nay CHƯA khai, nên chưa tạo được mã nào. **Dùng chung tài khoản SePay với thuê bao và nạp**, mã `ERPHD…` |
| Q2 | Kỳ thu phần vượt | **Tháng lịch VN, thu SAU từng tháng** · hoặc dồn vào lần gia hạn kế (khách trả năm sẽ nợ tới 12 tháng — không khuyến nghị) |
| Q3 | Đường duyệt | **Người vận hành duyệt từng hoá đơn (V1)** · tự phát hành dưới ngưỡng X ₫ · tự phát hành hết |
| Q4 | Hạn trả và hậu quả quá hạn | N ngày = ? Quá hạn: **chỉ nhắc** · cộng vào lần gia hạn kế (gia hạn chỉ hiệu lực khi trả đủ) · bắt buộc chuyển sang Số dư AI · khoá như quá hạn thuê bao |
| Q5 | Hai cách tính khách AI vượt | Xác nhận: hoá đơn theo KHỐI 100, Số dư AI theo ĐƠN GIÁ từng khách; khi cờ bật thì khách AI vượt **chỉ** đi đường số dư |
| Q6 | Ghế | Người dùng: **chỉ bán trước (ADDON)** hay cho vượt rồi thu sau? Fanpage: đếm theo **ảnh chụp cuối kỳ (mã hiện tại, `lib/saas/customers.ts:266`)** · đỉnh kỳ · trung bình ngày |
| Q7 | Đổi gói giữa kỳ | Phần gồm của kỳ theo **gói cao nhất trong kỳ** · gói cuối kỳ (mã hiện tại) · chia theo ngày |
| Q8 | Chuyển khách khỏi giá legacy | Từng tổ chức, ngày hiệu lực, báo trước bao lâu. Đây là bước thật sự BẬT phần vượt — không làm thì O1–O5 không thu được đồng nào |
| Q9 | Pháp lý / kế toán | Hoá đơn VAT phần vượt xuất lúc phát hành hay lúc thu (`tax_mode = UNDECLARED`). Doanh thu ghi nhận theo tháng phát sinh hay tháng thu. Điều khoản dịch vụ ghi phần vượt + fair-use. Ngưỡng tối thiểu để phát hành (dồn khoản nhỏ sang tháng sau?) |
| Q10 | Đếm tin nhắn lại do AI soạn | Hôm nay cố ý KHÔNG đếm (thận trọng). Đếm thì số khách AI — và tiền khách phải trả — tăng |

## 12. Rủi ro thấy khi đọc mã (chưa chạy thử — kiểm bằng bài kiểm của O1)

1. **Thu đôi ghế đã mua thêm.** Phép tính vượt dùng phần gồm người dùng của DÒNG GIÁ (bảng kê: `lib/saas/customers.ts:176-182`;
   màn khách: `lib/pricing/customer.ts:114`, `:119`). Nó không cộng ghế đã mua qua hoá đơn `ADDON`. Trong khi đó trần kỹ thuật lại
   có cộng (`db/schema.ts:5183-5186` → `lib/entitlements/check.ts`), và bảng kê vẫn in dòng «Hạn mức mua thêm»
   (`lib/saas/statement.ts:86-89`). Ví dụ: khách Starter mua thêm 2 người dùng và dùng đủ 7 người. Khách đó vừa trả dòng mua thêm,
   vừa bị tính 2 × 49.000 ₫ «người dùng thêm». Hôm nay chưa ai bị tính vì 8/8 tổ chức ở legacy, nhưng phải sửa TRƯỚC O3.
2. **Hai đường dựng phần gồm.** Màn khách áp ghi đè của người vận hành (`lib/pricing/customer.ts:114-115`), còn bảng kê thì không.
   Hai màn có thể nói hai số cho cùng một kỳ. O1 gom về một hàm. Auditor có phép kiểm đối chiếu
   (`docs/saas/auditor/DESIGN.md`, A18).
3. **Một hoá đơn mở mỗi tổ chức** (`db/schema.ts:5258`) cộng với VOID chéo loại (`lib/billing/service.ts:358`). Đã nêu ở §9 bất
   biến 4.
4. **Kỳ đồng hồ ≠ kỳ trả tiền.** Đồng hồ và phần vượt chạy theo tháng lịch VN; gia hạn chạy theo `paid_through` (1 · 3 · 6 · 12
   tháng). Đó là lý do hoá đơn `OVERAGE` phải là chứng từ riêng theo tháng, không ghép vào hoá đơn gia hạn.
