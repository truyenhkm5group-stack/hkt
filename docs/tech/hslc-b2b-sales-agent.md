# AI B2B Sales Agent cho HSLC — tài liệu trạng thái chung

> **Nguồn sự thật cho mọi phiên** làm chương trình này. Phiên nào nhận / xong việc thì sửa **Sổ việc** (mục 6) và
> **Bàn giao** (mục 10) trong cùng PR. Tổ chức thật: HSLC «Hải Sản Làng Chài», mã `hslc-hmt-shop` (CSDL riêng qua `getDb()`).
> Mở rộng module **Săn khách sỉ** (`wholesale_leads`, `docs/verticals/wholesale-lead-hunter.md`) — **KHÔNG** dựng hệ
> thống song song, KHÔNG dựng CRM thứ hai.

## 1. Mục tiêu & định nghĩa hoàn thành

**Mục tiêu.** Một tác tử AI giúp HSLC tìm và chốt khách sỉ (quán, nhà hàng, cửa hàng đặc sản…) từ lead thật tới đơn thật
trên ERP, với người duyệt ở mọi bước có rủi ro (gửi thật, mặc cả, chốt đơn).

**Hoàn thành (end-to-end) chỉ khi đo được trên production đủ chuỗi:**

| # | Bước | Bằng chứng phải có |
|---|---|---|
| 1 | Lead thật đã xác minh | `wholesale_leads` có SĐT `VERIFIED_CALL` hoặc email xác minh, không trùng (PHONE/DOMAIN/NAME) |
| 2 | Liên hệ hợp lệ | kênh có đồng ý (consent) hoặc cơ sở hợp lệ, không nằm trong danh sách chặn; dòng `wholesale_lead_activities` |
| 3 | Phản hồi | `first_response_at` của lead, nội dung phản hồi lưu được |
| 4 | Báo giá đúng | báo giá văn bản do **máy tất định** tính từ `quoteUnitPrice` (không LLM tính tiền), lưu lại, truy được |
| 5 | Khách chấp nhận | trạng thái báo giá `ACCEPTED` kèm mốc + người/kênh |
| 6 | Đơn hợp lệ trên ERP | `createOrderAsAgent` (idempotency `agentKey`), giá khớp `agentPriceProblems` = rỗng |
| 7 | Thanh toán / vận chuyển đồng bộ | phiếu thu `order_payments` / đối soát chuyển khoản; vận đơn qua đường giao có sẵn |
| 8 | KPI đúng | phễu B2B đọc từ chứng từ, doanh thu theo `ORDER_OUTCOME` (docs/business-rules/ORDER_OUTCOME.md) |

Chưa có đơn sỉ thật đi qua đủ 8 bước ⇒ trạng thái chương trình ghi **«pilot chưa chứng minh hiệu quả kinh doanh»**,
kể cả khi mọi bài kiểm xanh.

**Trạng thái hiện tại (27/10/2026):** pilot chưa chứng minh hiệu quả kinh doanh. Chưa có email, consent, báo giá văn
bản, đối soát chuyển khoản–đơn.

## 2. Kiến trúc (sơ đồ khối)

```
 discovery (Google Places · CSV · NV nhập)          lib/wholesale/engine.ts · providers.ts
      │
      ▼
 scoring A–D + khử trùng PHONE/DOMAIN/NAME          lib/wholesale/scoring.ts · dedupe.ts
      │
      ▼
 consent / suppression (PHONE·DOMAIN·PLACE → +EMAIL) wholesale_suppressions  ── P1a
      │
      ▼
 outreach / email (người duyệt, cờ gửi thật OFF)    wholesale_outreach_items · opener.ts  ── P2 · P4
      │
      ▼
 reply agent (đọc phản hồi → đề nghị bước tiếp)     ── P3 (chỉ ĐỀ NGHỊ, không tự gửi)
      │
      ▼
 quotation engine — TẤT ĐỊNH, không LLM tính tiền   quoteUnitPrice · agentUnitQuote · bảng quotations  ── P1b
      │        ▲ cổng sẵn sàng danh mục (P1c): giá sỉ · MOQ · khối lượng · ảnh · mô tả · tồn
      ▼
 order (createOrderAsAgent, agentKey)               lib/records/order-create.ts
      │
      ▼
 payment (phiếu thu · đối soát chuyển khoản)        order_payments · bank_transaction_links (+ORDER)  ── P5
      │
      ▼
 fulfillment (giao hàng có sẵn)                     lib/carriers/engine.ts · lib/shipping/*
      │
      ▼
 reorder (nhắc mua lại → /work)                     lib/queries/reorder.ts  ── P6
      │
      ▼
 dashboard phễu B2B                                 lib/queries/wholesale.ts::wholesaleDashboard  ── P7
      │
      └──► self-improvement (học từ kết cục, có cổng người duyệt)  ── P8
```

## 3. REUSE / EXTEND / BUILD NEW theo 16 khối

Tệp:dòng đo trên `origin/main` 0b3bd5605 (27/10/2026) — dòng trôi theo thời gian, tìm lại theo tên hàm.

| # | Khối | Quyết định | Ở đâu (tệp:dòng) | Ghi chú |
|---|---|---|---|---|
| 1 | Discovery lead | REUSE | `lib/wholesale/engine.ts:919` `runLeadHunterTick` · `providers.ts` | Google Places qua trạm Cloud Run; trần ngân sách cứng |
| 2 | Khử trùng | REUSE | `lib/wholesale/dedupe.ts:25` `websiteDomain` · `:52` `nameAddressKey` · `phone.ts` | Place ID → SĐT → tên miền → tên+số nhà |
| 3 | Chấm điểm A–D | REUSE | `lib/wholesale/scoring.ts:211` `scoreLead` · `:29` `gradeOf` | AI không chấm điểm |
| 4 | Nhiệt độ HOT/WARM/COLD | BUILD NEW (P1a) | — | suy từ hoạt động, không thay hạng A–D |
| 5 | Consent / suppression | EXTEND (P1a) | `db/schema.ts` `wholesale_suppressions` (kind `PHONE·DOMAIN·PLACE`) · `lib/wholesale/store.ts:83` `suppressionHit` · `leads.ts:78` `suppressLead` | thêm `EMAIL` + bảng đồng ý — **migration** |
| 6 | Outreach / hàng đợi | REUSE | `lib/wholesale/outreach.ts:172` `queueOutreachCore` · `:143` `prepareOutreachCore` · `opener.ts:123` `channelAction` | mọi kênh hiện là thủ công |
| 7 | Email gửi thật | BUILD NEW — **nền tảng chạy thử xong (E1)**; gửi thật P2 | `lib/wholesale/email-outbox.ts` · `email-policy.ts` · `lib/email-provider/` · `/wholesale/outbox` | adapter thật = **BLOCKER** chủ shop (mục 8) |
| 8 | Reply agent | BUILD NEW (P3) | — | chỉ đề nghị; dữ kiện từ `openerLooksInvented` (`opener.ts:60`) làm mẫu chặn bịa |
| 9 | Bảng giá sỉ / bậc / MOQ | REUSE | `lib/constants/price-lists.ts:33` `quoteUnitPrice` · `lib/queries/price-lists.ts:38` `priceBooksFor` · `lib/commerce/pricing.ts:34` `agentUnitQuote` · `:75` `agentPriceProblems` | bậc nhỏ nhất = MOQ |
| 10 | Báo giá văn bản (quotation) | BUILD NEW — **làm ở nhánh `claude/b2b-quotation` (P1b)** | `lib/wholesale/quotation-engine.ts` `computeQuotation` · `lib/wholesale/quotation.ts` · `/wholesale/quotations` | bảng `wholesale_quotations` + `wholesale_quotation_lines` — migration `0263` (mục 11) |
| 11 | Catalog readiness | BUILD NEW — **xong ở PR này (P1c)** | `lib/wholesale/catalog-readiness.ts` · `lib/queries/wholesale-readiness.ts` · `/wholesale/readiness` | chỉ đọc, không bảng mới |
| 12 | Tồn kho | REUSE (HIGH — chỉ đọc qua hàm có sẵn) | `lib/queries/stock.ts:381` `stockKnownExpr` · `:389` `erpStockExpr` · `:394` `availableStockExpr` | chưa phiếu nhập = CHƯA BIẾT |
| 13 | Tạo đơn | REUSE | `lib/records/order-create.ts:599` `createOrderAsAgent` (idempotency `raw.agentKey`, `:677`) | giá do máy chủ tính lại |
| 14 | Chuyển lead → khách | REUSE | `lib/wholesale/leads.ts:422` `convertLeadCore` → `lib/records/customer-create.ts:182` `createCustomerAsAgent` | ghép theo SĐT 9 số cuối, **không theo tên** |
| 15 | Thanh toán / đối soát | EXTEND (P5, HIGH) | `lib/records/order-payments.ts:94` `recordManualPaymentCore` · `db/schema.ts` `bank_transaction_links` (target chưa có `ORDER`) | thêm `ORDER` = **migration** + luật 17 |
| 16 | Reorder · dashboard | EXTEND (P6 · P7) | `lib/queries/reorder.ts:33` `loadReorderBoard` · `lib/constants/work-sources.ts:33` · `lib/queries/wholesale.ts:627` `wholesaleDashboard` | việc vào `/work` là phép chiếu (luật 19) |

## 4. Roadmap (có phụ thuộc)

| Phase | Nội dung | Phụ thuộc | Migration | Rủi ro |
|---|---|---|---|---|
| **P1a** | consent + suppression `EMAIL` + nhiệt độ HOT/WARM/COLD | — | có | trung bình |
| **P1b** | quotation engine tất định + bảng `quotations` | P1a (số migration nối sau) · P1c | có | cao (tiền) |
| **P1c** | catalog readiness + export readiness gate (chỉ đọc) | — | không | thấp |
| **P1d** | probe production HSLC (đo danh mục, bảng giá, lead thật) — chỉ đọc qua ops | P1c (đọc cùng câu hỏi) | không | thấp |
| **E1** | nền tảng email CHẠY THỬ: hộp thư đi · cổng chính sách · huỷ đăng ký RFC 8058 · nhận phản hồi · vòng gửi | P1a (`contactability`) | có (0264) | trung bình |
| **P2** | adapter nhà cung cấp email thật (gửi thật sau cờ) | **BLOCKER chủ shop** (mục 8) · E1 | không (E1 đã có bảng) | cao |
| **P3** | reply agent (đọc phản hồi → đề nghị) | P2 | có thể | trung bình |
| **P4** | sequences D0 / D3 / D7 / D14 | P2 · P1a | có thể | trung bình |
| **P5** | chốt đơn + đối soát chuyển khoản (`ORDER` trong `bank_transaction_links`) | P1b | có | **HIGH** (luật 17) |
| **P6** | nhắc mua lại vào `/work` | P5 | không | thấp |
| **P7** | dashboard phễu B2B (lead → báo giá → đơn → tiền) | P1b · P5 | không | thấp |
| **P8** | self-improvement (học từ kết cục, người duyệt) | P7 + ≥ 20 kết cục/nhóm | không | trung bình |

## 5. Quyết định đã chốt

| # | Quyết định |
|---|---|
| D1 | Feature flag **mặc định OFF** cho: gửi thật (email/Zalo/SMS) · tự mặc cả (auto-negotiation) · tự chốt đơn (auto-order). Bật = quyết định của chủ shop, ghi ngày. |
| D2 | **Không ghép khách theo tên.** Chỉ SĐT chuẩn hoá (9 số cuối) / tên miền / Place ID. |
| D3 | **Email công khai ≠ đồng ý.** Email tìm thấy trên website là kênh liên hệ, không phải consent để gửi chuỗi tự động. |
| D4 | **Không bịa** giá / chứng nhận / tồn / hạn dùng. Giá từ `quoteUnitPrice`; tồn chưa biết thì nói «nhân viên sẽ kiểm»; hạng mục không có nguồn là `UNAVAILABLE`. |
| D5 | LLM **không tính tiền**: số trên báo giá do máy tất định tính, LLM chỉ diễn đạt. |
| D6 | Bậc giá cho khách sỉ mới đọc ở **bảng mặc định** (chế độ `DEFAULT_BOOK`): bậc chỉ ở bảng riêng ⇒ khách mới nhận giá lẻ ⇒ chưa sẵn sàng. |
| D7 | Không hệ thống song song: mọi ghi đi qua lõi có sẵn (`convertLeadCore`, `createOrderAsAgent`, `recordManualPaymentCore`). |

## 6. Sổ việc

| Mã | Nhánh | Phạm vi tệp | Trạng thái | PR |
|---|---|---|---|---|
| b2b-p1a-consent | `claude/b2b-p1a-consent` | `db/schema.ts` · `drizzle/` · `lib/wholesale/*` (suppression, consent, nhiệt độ) | đang làm (phiên khác) | — |
| b2b-p1-readiness | `claude/b2b-p1-readiness` | `docs/tech/hslc-b2b-sales-agent.md` · `lib/wholesale/catalog-readiness.ts` · `lib/queries/wholesale-readiness.ts` · `app/(dashboard)/wholesale/readiness/*` · `app/(dashboard)/wholesale/wholesale-nav.tsx` · `tests/wholesale-catalog-readiness.test.ts` · `tests/sync-fixtures.test.ts` (đăng ký) · `tests/ui-consistency.test.ts` (miễn menu) | xong, chờ gộp | — |
| b2b-p1d-probe | `claude/b2b-p1d-probe` | script ops chỉ đọc | đang làm (phiên khác) | — |
| b2b-quotation (P1b) | `claude/b2b-quotation` | `db/schema.ts` · `drizzle/0263_wholesale_quotations.sql` · `lib/wholesale/quotation-engine.ts` · `lib/wholesale/quotation.ts` · `lib/queries/wholesale-quotations.ts` · `lib/actions/wholesale-quotations.ts` · `app/(dashboard)/wholesale/quotations/*` · `app/wholesale/quotations/[id]/print` · nút trên trang lead / khách · `tests/wholesale-quotation.test.ts` | xong, chờ gộp (0261 · 0262 đã vào main) | — |
| b2b-email-foundation (E1) | `claude/b2b-email-foundation` | `drizzle/0264_wholesale_email_outbox.sql` · `db/schema.ts` (3 bảng) · `lib/wholesale/email-*.ts` · `lib/email-provider/*` · `lib/constants/email-unsubscribe.ts` · `lib/queries/wholesale-email.ts` · `lib/actions/wholesale-email.ts` · `app/api/wholesale/unsubscribe/[token]/route.ts` · `app/(dashboard)/wholesale/outbox/*` · `middleware.ts` (một mục) · `lib/wholesale/job.ts` · `tests/wholesale-email.test.ts` | xong, chờ gộp (sau P1a) | — |
| b2b-email-ai-draft (P2b) | `claude/b2b-email-ai-draft` | `drizzle/0265_wholesale_email_ai_drafts.sql` · `db/schema.ts` (1 bảng) · `lib/wholesale/email-ai-draft.ts` · `lib/wholesale/email-ai-draft-guard.ts` · `lib/queries/wholesale-email-ai-drafts.ts` · `lib/actions/wholesale-email-ai.ts` · `app/(dashboard)/wholesale/outbox/ai-drafts-panel.tsx` · nút trên trang lead · `lib/constants/ai-systems.ts` (AI-07 thêm feature) · `tests/wholesale-email-ai-draft.test.ts` | xong, chờ gộp | — |
| b2b-email-sequence (P4a) | `claude/b2b-email-sequence` | `lib/wholesale/email-sequence.ts` · `lib/wholesale/email-sequence-core.ts` · `lib/actions/wholesale-email-sequence.ts` · `app/(dashboard)/wholesale/outbox/sequence-panel.tsx` · `lib/wholesale/email-ai-draft.ts` (bước nhắc) · `tests/wholesale-email-sequence.test.ts` | xong, chờ gộp (sau P2b) | — |
| b2b-p2-email | — | adapter nhà cung cấp thật (SES / Resend / Gmail) cài `EmailProvider` + khai `LIVE_EMAIL_ADAPTERS` | **chặn** — chờ chủ shop (mục 8) | — |

## 7. P1c — cổng sẵn sàng (đã làm ở PR này)

Trang `/wholesale/readiness` (tab «Sẵn sàng bán sỉ», quyền `wholesale:view`, module `wholesale_leads`). Chỉ đọc.

| Kiểm | Nguồn | Thiếu khi |
|---|---|---|
| Bậc giá sỉ | `price_list_items` của bảng **mặc định** đang bật | không có bảng mặc định, hoặc mẫu mã không có bậc ở đó |
| MOQ | bậc «mua từ» nhỏ nhất của bảng mặc định | chưa có bậc |
| Khối lượng | `product_variants.weight` | 0 / trống (= chưa nhập, không phải 0 g) |
| Ảnh | `product_variants.images[0]` → `products.image` | cả hai trống |
| Mô tả | field sản phẩm đã khai ∩ khoá mẫu ngành (`DESCRIPTION_FIELD_KEYS`) | tổ chức chưa khai field nào, hoặc mọi field trống |
| Tồn | sổ kho `stockKnownExpr` / `availableStockExpr` | chưa có phiếu nhập (= CHƯA BIẾT). Tồn đã biết = 0 chỉ là cảnh báo |

**Xuất khẩu** — cổng chung, không bao giờ «sẵn sàng» khi còn một hạng mục `UNAVAILABLE`:

| Hạng mục | Trạng thái hôm nay | Thiếu gì |
|---|---|---|
| Chứng nhận | `UNAVAILABLE` | không bảng/cột/field nào lưu giấy chứng nhận |
| Điều kiện xuất khẩu | `UNAVAILABLE` | không lưu Incoterms / cảng / chứng từ; chủ shop chưa quyết có xuất khẩu |
| Mã HS | `UNAVAILABLE` | không có cột `hs_code`; máy không suy mã HS từ tên |
| Hạn dùng | theo lô (`stock_lots.expires_on`) — `AVAILABLE`/`PARTIAL`/`MISSING` | là hạn của LÔ, chưa có «thời hạn sử dụng» chuẩn của sản phẩm |
| Bảo quản | field `bao_quan` / `storage_instruction`; chưa khai field ⇒ `UNAVAILABLE` | nhập field cho từng sản phẩm |

## 8. Blockers cần chủ shop

| # | Cần quyết | Chặn phase |
|---|---|---|
| B1 | Chọn nhà cung cấp gửi email (vd Resend / SES / Gmail Workspace) | P2 · P3 · P4 |
| B2 | Tên miền gửi (SPF/DKIM/DMARC) + hộp thư nhận phản hồi | P2 · P3 |
| B3 | Bảng giá **mặc định** cho khách sỉ mới + bậc/MOQ từng mẫu (xem `/wholesale/readiness`) | P1b |
| B4 | Có bán xuất khẩu không; có thì chứng nhận / HS / điều kiện xuất khẩu | hạng mục xuất khẩu |
| B5 | Ngày mở từng cờ: gửi thật · tự mặc cả · tự chốt đơn | P2 · P3 · P5 |
| B6 | Chính sách báo giá `settings["wholesale.quotation"]`: trần chiết khấu % (`maxDiscountPercent`) · biên lợi nhuận gộp tối thiểu % (`minMarginPercent`) · thuế suất + căn cứ (`taxRatePercent` + `taxSource`). Không có số mặc định (luật 38) | P1b (chưa khai ⇒ chiết khấu nào cũng phải duyệt; giá chưa gồm thuế) |

## 9. Acceptance tests

| Phase | Bài kiểm | Trạng thái |
|---|---|---|
| P1c | `tests/wholesale-catalog-readiness.test.ts` (K21): đủ ⇒ READY · thiếu từng trường · bậc chỉ ở bảng riêng vẫn thiếu · tồn chưa biết ≠ 0 · xuất khẩu `UNAVAILABLE` kèm `missingWhat` · null đứng cuối khi xếp | ĐẠT |
| P1a | email bị chặn ⇒ không vào hàng đợi; email công khai không tự thành consent | chưa |
| P1b | `tests/wholesale-quotation.test.ts` (K21): bậc theo SL (= `quoteUnitPrice`) · dưới MOQ / không giá sỉ chặn · tồn biết < SL chặn, chưa biết chỉ cảnh báo · chiết khấu chưa khai trần ⇒ cần duyệt, vượt trần ⇒ chặn · không tự duyệt (lõi + CHECK) · sửa ⇒ phiên bản mới, bản cũ bất biến (trigger) · ảnh chụp không đổi khi bảng giá đổi · hết hạn lúc đọc · tiền nguyên VND · phạm vi · cách ly tổ chức · chưa áp 0263 không sập | ĐẠT (cục bộ) |
| E1 | `tests/wholesale-email.test.ts` (K21): cổng chặn từng lý do · email công khai không đồng ý ⇒ chặn · OFF / DRY_RUN / LIVE-không-adapter · gửi 2 lần / 2 lượt song song ⇒ 1 SENT · List-Unsubscribe RFC 8058 · huỷ đăng ký ⇒ chặn EMAIL + dừng thư chờ · token A gắn nhãn B ⇒ 404 · trả lời ⇒ REPLY + dừng chuỗi + 1 việc | ĐẠT (cục bộ) |
| P2–P4 | adapter thật: cờ gửi thật OFF ⇒ không một lượt gửi nào ra ngoài; idempotent khi chạy lại | chưa |
| P5 | đối soát ORDER không nhân đôi tiền khi nhập lại sao kê (luật 17) | chưa |
| E2E | một đơn sỉ thật đi đủ 8 bước mục 1 trên production | chưa |

## 10. Bàn giao & việc tiếp theo

- **P1c xong** (nhánh `claude/b2b-p1-readiness`). Việc tiếp: P1d dùng `wholesaleReadinessBoard()` (hoặc cùng câu hỏi) để đo danh
  mục HSLC thật — bao nhiêu mẫu READY, bao nhiêu thiếu bậc giá ở bảng mặc định — rồi ghi số vào mục này.
- **P1b xong** (nhánh `claude/b2b-quotation`, migration `0263`, nối sau 0261 consent và 0262 fb-crm đã vào main). Bộ tính tự làm phần cổng P1c liên quan tới TIỀN (bậc giá sỉ · MOQ · tồn); khối lượng thiếu chỉ là cảnh báo. Việc tiếp: P5 nối báo giá ACCEPTED → `createOrderAsAgent` (giá khớp `agentPriceProblems`); gửi email báo giá chờ P2.
- Chủ shop cần khai `settings["wholesale.quotation"]` (B6 mục 8) — chưa khai thì mọi chiết khấu > 0 đều cần duyệt, báo giá chưa gồm thuế.
- Không phase nào bật gửi thật / tự mặc cả / tự chốt đơn khi B5 chưa có ngày quyết.
- **E1 xong** (nhánh `claude/b2b-email-foundation`, migration 0264): hộp thư đi `/wholesale/outbox`, cổng
  `evaluateEmailSend()` (hàm thuần), nhà cung cấp chạy thử, link huỷ đăng ký `/api/wholesale/unsubscribe/<token>`, `ingestInboundEmail()`.
  Chi tiết vận hành: `docs/verticals/wholesale-lead-hunter.md` §4e. Việc tiếp: P2 = MỘT tệp adapter trong `lib/email-provider/`
  + một tên trong `LIVE_EMAIL_ADAPTERS` + webhook bounce/complaint ghi vào `wholesale_email_events` (khoá `provider_event_id`);
  P3 = bộ đọc hộp thư gọi `ingestInboundEmail()`; P4 = sinh thư nhắc (`FOLLOWUP`, bước ≥ 1) — bảng và tiêu đề luồng đã có.

## 11. P1b — báo giá sỉ tất định

**Một bộ tính.** `computeQuotation` (`lib/wholesale/quotation-engine.ts`) là hàm THUẦN, client-safe: không đọc CSDL, cấu hình hay
đồng hồ. Đơn giá chọn bằng ĐÚNG `quoteUnitPrice` (bảng riêng của khách → bảng mặc định). Dòng rơi về giá lẻ thì bị chặn, vì giá
lẻ không phải giá sỉ. Lõi ghi (`lib/wholesale/quotation.ts`) đọc dữ kiện qua hàm có sẵn: `priceBooksFor`, sổ kho
`stockKnownExpr` / `availableStockExpr`, giá vốn sống `liveLineUnitCost` (luật 3.13). Sau đó gọi bộ tính rồi ghi kèm ẢNH CHỤP
(đầu vào + kết quả). LLM không tính một con số nào.

| Chặn (không gửi / duyệt được) | Cảnh báo (không chặn) | Cần duyệt |
|---|---|---|
| không có giá sỉ ở bảng hiệu lực · dưới MOQ (bậc nhỏ nhất) · tồn ĐÃ BIẾT < SL · tổng / dòng âm · chiết khấu vượt trần đã khai · ship có số mà thiếu căn cứ · mẫu mã không còn · dòng trùng | tồn CHƯA BIẾT (chưa phiếu nhập — không phải 0) · chưa có ship · chưa có thuế · chưa biết giá vốn · chưa có khối lượng | chiết khấu > 0 khi: chưa khai trần · chưa khai sàn biên LN · biên LN chưa biết (thiếu giá vốn) · biên LN dưới sàn |

**Vòng đời.** `DRAFT` → (cần duyệt) `PENDING_APPROVAL` → `APPROVED` → `SENT` → `ACCEPTED` / `REJECTED`. Nháp không cần duyệt thì
gửi thẳng được.
- Quyền: lập / sửa / gửi / ghi kết quả dùng `wholesale:work`; duyệt và trả lại dùng `wholesale:config`. Không thêm khoá quyền mới.
- Người lập KHÔNG tự duyệt: lõi kiểm, và CHECK `wholesale_quotations_self_approval_check` chặn ở CSDL.
- Sửa nghĩa là tạo PHIÊN BẢN MỚI: cùng mã, `version + 1`. Bản trước chuyển sang `SUPERSEDED` và giữ nguyên số. Trigger CSDL từ chối
  mọi lượt đổi tiền, dòng hay ảnh chụp.
- Bấm hai lần không tạo hai bản: `request_key` là khoá duy nhất, và mỗi bản chỉ có tối đa một bản kế (chỉ mục duy nhất trên
  `parent_quotation_id`).
- `EXPIRED` tính lúc đọc từ `valid_until` (ngày VN, hết ngày đó mới hết hạn), không ghi đè cột trạng thái.
- «Đã gửi» là lời khai của người gửi. Bước này CHƯA gửi email (chờ P2).

**Màn hình.**
- `/wholesale/quotations`: danh sách và lọc trạng thái.
- `/wholesale/quotations/[id]`: dòng, tổng, chặn / cảnh báo / lý do duyệt, lịch sử phiên bản, nút theo trạng thái.
- `/wholesale/quotations/[id]/edit`: tạo phiên bản mới.
- `/wholesale/quotations/new?lead=…|customer=…`: mở từ nút «Tạo báo giá» trên trang lead và trang khách.
- `/wholesale/quotations/[id]/print`: bản in gửi khách. Chỉ đọc ẢNH CHỤP, không in giá vốn hay biên lợi nhuận.
- Khung «Cài đặt báo giá» trên `/wholesale/quotations`: chỉ người có `wholesale:config` thấy. Có ba ô: trần CK %, biên LN gộp
  tối thiểu %, thuế suất + căn cứ. Kèm GỢI Ý tính từ bảng giá sỉ đang bật (chủ shop 30/10/2026: «xem bảng giá sỉ»):
  - Trần CK gợi ý = mức giảm sâu nhất so với giá lẻ, đo ở bậc «mua từ» lớn nhất. Màn hình in kèm bảng, mẫu mã và bậc đó.
  - Biên LN gợi ý = biên gộp thấp nhất ở bậc sâu nhất, theo giá vốn sống (luật 3.13). Mẫu mã chưa có giá vốn hiện «chưa biết».
  - Thuế: không gợi ý số.
  - Gợi ý chỉ là chữ. Bấm «Lưu» (bắt buộc lý do) mới ghi `settings["wholesale.quotation"]` và vào nhật ký
    `WHOLESALE_QUOTATION_POLICY_SET` (`lib/wholesale/quotation-settings.ts` · `quotation-policy.ts`).

**Chưa làm / cố ý không làm.**
- Tiền tệ khác VND: ERP chưa có nguồn tỷ giá có hiệu lực kèm căn cứ, nên CHECK chỉ cho `VND`.
- Incoterms chỉ ghi khi người lập khai; máy không suy.
- PDF: dùng «In / Lưu PDF» của trình duyệt.
- Ảnh chụp chỉ chép dữ kiện của tổ chức về bên nhận (cột lead do nhân viên nhập / hồ sơ khách). Không chép dữ liệu Google Places,
  vì dữ liệu đó có hạn lưu.

## 12. P2b — AI soạn email chào hàng (nháp, có hàng rào bịa đặt)

**Luồng.** Một lead có email, bấm «AI soạn nháp email» trên trang lead. Mỗi lần bấm là một lead, một lượt; không có đường chạy hàng
loạt. Máy dựng DỮ KIỆN THẬT (`buildDraftFacts`) gồm:
- hồ sơ lead: tên, phân khúc + căn cứ, khu vực, website;
- bảng giá sỉ đang áp: khách đã nối thì bảng riêng → bảng mặc định; lead chưa là khách thì chỉ bảng mặc định; tối đa 15 mẫu mã còn
  bán;
- báo giá ĐÃ duyệt / đã gửi / đã chấp nhận của lead;
- lời khai của shop: MOQ, giao hàng, khuyến mãi, catalog;
- danh tính người gửi của E1;
- thuế theo cài đặt báo giá (chưa khai thì ghi «giá chưa gồm thuế»).

Sau đó gọi AI qua đúng đường AI của tổ chức (`resolveAi` của hàng đợi liên hệ; kiểm hạn mức `checkAiQuota`; ghi sổ
`platform_ai_usage` với feature `b2b_email_draft`, workload `lead_hunter`; hệ thống AI-07). Rồi chạy hàng rào `draftViolations` và
ghi một dòng `wholesale_email_ai_drafts`:
- `DRAFT` nếu qua hàng rào;
- `BLOCKED` nếu vi phạm, kèm lý do. Nháp loại này không bao giờ vào hộp thư đi.

**Hàng rào (máy chặn).** Những gì bị chặn:
- số tiền không thuộc đơn giá bậc / số báo giá / số trong lời khai (đọc bằng `extractVndAmounts` của chatbot);
- tiền tệ khác VND;
- chứng nhận / tiêu chuẩn;
- xuất khẩu / Incoterms;
- tồn kho / sẵn hàng;
- thời gian giao khi shop chưa khai, hoặc khác lời khai;
- % không có trong dữ kiện;
- link / email / SĐT không có trong dữ kiện;
- sai ngôn ngữ.

**Ngôn ngữ.** Trong nước / Việt Kiều ⇒ tiếng Việt; còn lại ⇒ tiếng Anh. ERP chưa lưu nước của lead, nên đọc mã nước SĐT và đuôi tên
miền 2 chữ. Khi nhánh khám phá quốc tế thêm cột nước thì nối vào `draftLanguageFor`. Chưa hỗ trợ ngôn ngữ bản địa.

**Người duyệt.** Người sửa nháp rồi bấm «Đưa vào hộp thư đi». Bản cuối qua LẠI hàng rào (cùng dữ kiện đã chụp lúc soạn). Qua thì
tạo thư `DRAFT` của E1 (`preparedBy = AI`), vẫn phải duyệt gửi ở E1 và qua cổng chính sách. Máy ghi người yêu cầu, người duyệt,
model, chi phí và `edit_ratio` (khoảng cách theo từ / độ dài). Khối «Nháp AI» in tỷ lệ bị chặn, tỷ lệ sửa trung bình và chi phí
30 ngày. E1 không có luật «người soạn không tự duyệt», nên bước này cũng không thêm.

**Cấu hình.** `settings["wholesale.emailAiDraft"]`, mặc định TẮT. Người có `wholesale:config` bật, bắt buộc khai trần nháp / ngày
và trần chi phí USD / ngày, kèm lý do; có audit. Hôm nay đã có một lượt chưa biết chi phí (model chưa có giá) ⇒ dừng tới mai,
không coi chi phí đó là 0.

## 13. P4a — chuỗi thư theo dõi (thư nhắc)

**Luật** (`lib/wholesale/email-sequence.ts`, hàm thuần). Mỗi lead luồng email có tối đa N lần nhắc, mỗi lần sau K ngày kể từ thư
trước mà khách không phản hồi. N và K nằm ở `settings["wholesale.emailSequence"]` và **không có số mặc định**: chưa khai ⇒ không
lead nào có lần nhắc.

Chuỗi dừng khi một trong các điều kiện sau xảy ra:
- khách trả lời: sự kiện REPLY, gồm mọi thư vào nối luồng / khớp lead;
- huỷ đăng ký;
- khiếu nại;
- bounce cứng (bounce mềm không dừng chuỗi);
- lead khớp danh sách chặn hoặc ở trạng thái KHÔNG LIÊN HỆ;
- lead chuyển Thắng / Mất;
- đã đủ N lần.

Lead đang có thư mở hoặc nháp AI mở thì không soạn thêm thư chồng lên. Chỉ đếm thư «đã gửi» của đúng chế độ đang chạy: chạy thử
đếm thư chạy thử, gửi thật đếm thư thật.

**Hiện ở MỘT chỗ.** Khối «Lần nhắc đến hạn» của Hộp thư đi. Đây là phép chiếu tính lúc đọc (luật 19); không chiếu thêm lên `/work`
và không có job tự soạn.

**Soạn = người bấm, chỉ khi ĐẾN HẠN** (máy chủ kiểm lại):
- «AI soạn lần nhắc»: đi đúng đường P2b (`aiDraftEmailCore` với thư trước làm dữ kiện, lời nhắc «thư nhắc lần N», cùng hàng rào).
  Nháp nằm ở khối «Nháp AI»; khi đưa vào hộp thư đi thành thư `FOLLOWUP` đúng bước.
- «Dùng mẫu»: mẫu tĩnh shop khai (biến `{{ten_doanh_nghiep}}` `{{ten_shop}}` `{{lan_nhac}}`), qua cùng hàng rào, rồi thành thư
  `DRAFT` (FOLLOWUP, nối luồng thư trước qua `thread_id` / `in_reply_to`).

Không đường nào gửi: thư nhắc vẫn qua lượt duyệt E1 và cổng chính sách.

