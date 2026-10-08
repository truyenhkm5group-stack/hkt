# Product Excellence Score — Chốt Đơn Tự Động (08/10/2026)

*Sứ mệnh `product-excellence-baseline` · R0 (chỉ tài liệu) · đọc mã ở `origin/main` `36b7791b`. Không dòng mã nào đổi. Đây là
bản CHẤM ĐIỂM ĐẦU TIÊN. Tệp này BẤT BIẾN sau khi gộp: lần chấm sau là một tệp mới `SCORECARD_<ngày>.md` (cùng tinh thần AGENTS
21 — kỳ đã chốt không bị sửa ngược). Không có dữ liệu khách, SĐT, khoá hay số tiền theo khách trong tệp này.*

Nguồn dùng lại, không kiểm lại từ đầu:
- `docs/saas/SHELL_AUDIT_2026-10-08.md` (F-01…F-16, đo trên bản build cục bộ, dữ liệu giả);
- `docs/saas/INBOX_V2.md`, `docs/saas/ORDER_CANDIDATE.md`, `docs/saas/HELP_CENTER.md`;
- `docs/saas/auditor/DESIGN.md`, `docs/saas/RISK_SCALE.md`, `docs/saas/AI_COST_WORKLOAD.md`, `docs/saas/PRICING_V1.md`;
- `docs/revenue-os/MASTER_MISSION_STATUS.md` và bảng kiểm kê 08/10 (dẫn bằng «B#n» như `INBOX_V2.md`);
- bộ đo đơn vàng v2, nhánh `feat/order-golden-v2`, tệp `tests/order-golden/BASELINE.md` (dẫn là «golden v2»);
- số đo production ngày 08/10 do Integration Lead cung cấp (dẫn là «production 08/10»).

## 0. Kết quả

| | |
|---|---|
| **Điểm tổng** | **36 / 100** — trung bình KHÔNG trọng số của các chiều có bằng chứng |
| **Độ phủ** | **11 / 16 chiều** có điểm. 5 chiều `UNKNOWN`: Performance · AI Quality · Customer Value · Retention · Competitive Differentiation |
| Chiều thấp nhất | Monetization 10 · Support 20 · Activation 25 |
| Chiều cao nhất | Mobile 55 · Inbox UX 50 · Security 50 |

**Đọc con số này thế nào.** Điểm từng chiều là PHÁN ĐOÁN có căn cứ theo thang neo ở §1, không phải một số đo. Điểm tổng chỉ so
được với một lần chấm sau CÓ CÙNG độ phủ. Khi một chiều `UNKNOWN` có số đo và được chấm, điểm tổng sẽ đổi vì mẫu số đổi, kể cả khi
sản phẩm không đổi gì. Lần chấm sau phải in hai số: tổng trên đúng 11 chiều này, và tổng trên toàn bộ chiều có điểm.

## 1. Thang neo

| Điểm | Nghĩa |
|---|---|
| 90–100 | Có số đo production, đạt đích chủ shop đã đặt, có giám sát tự động và bài kiểm hồi quy |
| 70–89 | Chạy tốt trên production, có số đo, chỉ còn lỗ P2 |
| 50–69 | Chạy được, có lỗ P1 đã biết và đã có kế hoạch sửa |
| 30–49 | Có lỗ P0/P1 đang làm sai dữ liệu, chặn khách, hoặc thiếu lưới đỡ |
| 10–29 | Phần lớn chưa vận hành, hoặc đã đo được là đang hỏng ở bước chính |
| 0–9 | Không tồn tại |
| `UNKNOWN` | Không có số đo đủ để đặt vào bất kỳ dải nào ở trên. Không được thay bằng một con số đoán (AGENTS 42, 8.5) |

Chiều chỉ có bằng chứng từ ĐỌC MÃ, không có số đo hành vi, vẫn được chấm nếu mã chứng minh được lỗ (ví dụ «không có cơ chế X»),
nhưng không bao giờ được chấm trên 69.

## 2. Bảng 16 chiều

| # | Chiều | Điểm | Bằng chứng chính (rút gọn — chi tiết §3) | Chỉ số nên theo dõi |
|---|---|---|---|---|
| 1 | Activation | **25** | F-01 trang trắng ≥ 13 giây sau đăng ký, ≥ 15–40 giây sau đăng nhập, 7/7 lượt · F-02: production 08/10 có 2/3 workspace tự đăng ký thiếu thuê bao · F-03 hộp thư rỗng không bước tiếp · Meta trực tiếp BLOCKED | % workspace tới `CHANNEL_CONNECTED` và `FIRST_AI_REPLY` · trung vị giờ tới từng mốc (n ≥ 3) · số workspace tự đăng ký thiếu thuê bao (bất biến 0) |
| 2 | Ease of Use | **40** | Thuật ngữ kỹ thuật ở 9 trang vỏ (F-08) · 2/8 trạng thái rỗng trả lời đủ «đây là gì · làm gì · bấm đâu» · 4/13 bài hướng dẫn dẫn vào trang bị chặn (F-05) · tốt: đăng ký một màn ~8 giây | số từ cấm lộ trong vỏ · % trạng thái rỗng đủ 3 câu · số liên kết vỏ dẫn tới trang bị chặn |
| 3 | Inbox UX | **50** | Khung 3 cột chạy (B#8) · ô soạn có câu mẫu + dòng sản phẩm (#661) · bỏ Enter khi bộ gõ đang ghép chữ · nhưng chỉ 3 dòng thấy trọn ở 1366×768, khối lọc ~300 px, chưa có ưu tiên P0–P3 (`INBOX_V2.md` §1) | dòng hội thoại thấy trọn · thời gian tới phản hồi đầu của P0/P1 theo đội + độ phủ |
| 4 | Performance | `UNKNOWN` | Chưa có p50/p95 production cho trang nào của vỏ (B#24, B#49). Số ms đo cục bộ bị loại có chủ đích (`SHELL_AUDIT` §1 bước 6) | xem §3.4 «cần đo» |
| 5 | Messaging Reliability | **40** | Production: bot HSLC im ~2 giờ ngày 06/10 và lần nữa 07/10 vì cạn credit trả trước dùng chung · có `sales-health` 5′, bộ bắt «bot im», thử lại + DLQ + khoá dự phòng · webhook Meta là nguồn duy nhất, không quét bù | phút bot im / tuần · tỷ lệ Send API lỗi · số lần hàng chờ > 5′ / > 10′ · % lượt AI `ERROR` theo lớp lỗi |
| 6 | AI Quality | `UNKNOWN` | Golden v2 chạy model KỊCH BẢN: đo hàng rào máy chủ, không đo model thật. Bench không lưu kết quả (B#23) | xem §3.6 |
| 7 | Order Accuracy | **40** | Golden v2: chốt sai khi khách chưa đồng ý 4/11 (công tắc TẮT), 8/11 (BẬT) — CRITICAL · đơn trùng 0/30 · thiếu đơn 0/29 · giá 34/34 · tổng 29/29 · SĐT 28/29 | `false_auto_confirm_rate` · `duplicate_order_rate` · `human_correction_rate` (golden, mỗi PR) · tỷ lệ đơn AI bị người sửa / huỷ trên production (chưa có nguồn) |
| 8 | Trust | **35** | Tốt: vỏ khách che tên model AI và USD (`lib/saas/visibility.ts`) · Lỗ: nhãn «Hỏng» cho việc chưa làm (F-07) · 12 câu «liên hệ hỗ trợ» không kèm kênh · đơn không lưu bằng chứng từng trường · khách đáp «??» vẫn thành «Đã xác nhận» (golden v2) | số đơn «Đã xác nhận» thiếu tin đồng ý · số câu «liên hệ» không kênh (đích kỹ thuật 0) · số trạng thái chưa biết tô màu xấu (0) |
| 9 | Customer Value | `UNKNOWN` | Có máy đo (phễu, `ORDER_OUTCOME`, lãi gộp theo nhãn AI #646, AI vs Người #658) nhưng chưa đọc được số của khách nào: `db-query` chỉ mở CSDL nhà | xem §3.9 |
| 10 | Retention | `UNKNOWN` | 8/8 tổ chức ghim giá legacy, chưa có kỳ thu V1 nào, chưa có tổ chức nào rời | xem §3.10 |
| 11 | Monetization | **10** | Production 08/10: 0 ₫ thu theo V1 · 8/8 legacy · 2/3 workspace tự đăng ký thiếu thuê bao · chưa có hoá đơn vượt gói (B#30) · Số dư AI cờ TẮT, chưa khai tài khoản nhận | số workspace V1 có thuê bao sống · MRR V1 (`platform_saas_daily`) · độ phủ đồng hồ khách AI (Auditor A15) · biên gộp (A5) |
| 12 | Mobile | **55** | 0/19 đường tràn ngang ở 390 px · thanh dưới 4 mục + «Thêm» · thông báo đẩy (#581) · Lỗ: trang AI Sales tự cuộn tới 7.532/8.889 px (F-04) · trang Nhân viên 776 ô đánh dấu, cao 4.462 px (F-09) · thẻ số liệu chiếm màn đầu (F-13) | phần tử bấm < 32 px mỗi trang vỏ · số trang tự cuộn sai · thời gian mở hội thoại trên điện thoại |
| 13 | Support | **20** | Không kênh liên hệ trong vỏ (12 chỗ) · không sổ yêu cầu hỗ trợ (`11_SAAS_METRICS_SPEC.md` §8) · `/help` không biết vỏ · thiếu bài cho 3/8 mục vỏ · không có phiên «xem như khách» (B#53) | lượt liên hệ / tuần (cần sổ) · số mục vỏ có bài · liên kết cụt trong bài = 0 |
| 14 | Security | **50** | Tốt: token mã hoá AES-256-GCM, khoá HKDF có xoay, bài tấn công chéo tổ chức 1.507 dòng, chữ ký webhook, chuỗi vá an toàn bot #647–#657 · Lỗ: không CSP · chat công khai từng không giới hạn tần suất (PR #665 đang review) · OAuth khớp EMAIL chưa xác minh mở được phiên (B#36) · bản vá lộ nội bộ L1 chưa gộp | Auditor A1 (khoá nội bộ lọt DTO) = 0 · A2 (cô lập) = 0 · số hội thoại công khai mới / IP / giờ |
| 15 | Operational Scalability | **35** | Tốt: mỗi workspace một CSDL, cấp phát idempotent · Lỗ: chỉ đọc được CSDL nhà bằng `db-query` · credit AI trả trước dùng chung giữa khách và việc đo thử · hộp thư đếm toàn bảng mỗi 5 giây · không correlation ID · Auditor chưa có · 218 cây làm việc | số sự cố SEV0/SEV1 / tuần · thời gian tới phát hiện · % phép kiểm Auditor đo được |
| 16 | Competitive Differentiation | `UNKNOWN` | Chỉ có so sánh bằng tài liệu (`docs/platform/pricing.md:9-17`, `docs/productization/CHOTDON_SMART_ROADMAP.md`). Không có số thắng/thua hay nghiên cứu người dùng | xem §3.16 |

**Tính tổng:** (25 + 40 + 50 + 40 + 40 + 35 + 10 + 55 + 20 + 50 + 35) / 11 = 400 / 11 = 36,4 ⇒ **36**.

## 3. Chi tiết từng chiều

### 3.1 Activation — 25
- **F-01**: sau đăng ký, vỏ trắng ~13 giây rồi mới hiện. Sau đăng nhập vỏ: trắng ≥ 15 giây (host Chốt Đơn), ≥ 40 giây (host
  `localhost`), trình duyệt điều hướng cùng một URL 4.328–17.633 lần. Lặp lại 7/7 lượt, đối chứng ERP nhà không lỗi
  (`SHELL_AUDIT` §3). Chuỗi gây lỗi: `redirect("/")` ở `lib/actions/onboarding.ts:96` và `lib/actions/auth.ts:81`.
- **F-02**: production 08/10, 2/3 workspace tự đăng ký không có dòng `platform_product_subscriptions` sống. Khách thấy «liên hệ
  người vận hành» (`components/saas/my-products.tsx:11`).
- **F-03**: đăng ký xong rơi vào Hộp thư rỗng. Thẻ «Bắt đầu» chỉ dựng ở `/` (`app/(dashboard)/page.tsx:55`), mà vỏ chặn `/`.
- **Kênh**: Meta Messenger trực tiếp chưa được cấp quyền Page (BLOCKED, chờ chủ shop). Shop không dùng Pancake hiện chỉ còn Zalo
  OA và ô chat web.
- **Tốt**: đăng ký một màn, ngành «Chỉ cần AI bán hàng» chọn sẵn, tạo xong ~8 giây (3/3 lượt).
- **Chưa đo**: thời gian tới từng mốc trên production. Câu SQL ở `TIME_TO_VALUE.md` §3.

### 3.2 Ease of Use — 40
- Từ kỹ thuật lộ ra ở 9 trang vỏ: «ERP», «webhook», «module», «workspace», «connector», «Field không tick» (`SHELL_AUDIT` §5).
- Trạng thái rỗng: chỉ «Kênh kết nối» và «Cài đặt · Nhân viên» trả lời đủ ba câu (`SHELL_AUDIT` §4) ⇒ 2/8.
- Chữ chỉ đường không bấm được, hoặc chỉ tới chỗ không có (F-15). Tên menu khác tiêu đề trang ở 5 mục (F-10).
- Tốt: 0/19 đường tràn ngang; trang bị chặn thì chuyển về Hộp thư kèm câu giải thích; Tổng quan phân biệt «—» với «0 ₫».

### 3.3 Inbox UX — 50
- Có: 3 cột, 10 thẻ lọc + lọc nâng cao, ghi chú, nhãn, giao việc, lịch sử mua + giao theo `ORDER_OUTCOME`, tiếp quản / trả lại AI,
  câu mẫu + dòng sản phẩm chèn tại con trỏ (#661, `app/(dashboard)/ai/sales-chatbot/inbox/composer-tools.tsx`).
- Thiếu: hạng ưu tiên (B#9), sự kiện hệ thống trong timeline (B#11–12), «bước tiếp theo» (B#14), lệnh `/`, tải tin cũ hơn 200.
- Đo trên bản thử (40 hội thoại giả): 3 dòng thấy trọn ở 1366×768; thanh điều khiển AI cao ~130 px, nói «AI chưa sẵn sàng» ba lần
  (F-14). Làm mới 5 giây có thể đổi thứ tự dòng ngay dưới tay người bấm (`INBOX_V2.md` D3).

### 3.4 Performance — UNKNOWN
Cần đo, ở đâu:
1. p50/p95 máy chủ của `listInbox` / `loadInboxThread` trên production: bọc `probe()` (`lib/perf/probe.ts:72-77`), PR V2-0 của
   `INBOX_V2.md` §9.
2. Số câu SQL mỗi lượt dựng hộp thư: thêm kịch bản vào `tests/page-query-budget.test.ts` (S2).
3. Độ trễ tin khách → câu AI đầu tiên: mục tiêu đã chốt 60 giây (`lib/constants/ai-sales-slo.ts:21`). `sales-health` đã đo P95 khi
   đủ mẫu, nhưng kết quả nằm ở CSDL tổ chức — cần đọc qua ops theo tổ chức (`scripts/org-summary.ts` mở rộng).
4. Thời gian từ đăng nhập tới `h1` hộp thư trên trình duyệt (bài kiểm đề xuất của F-01).

### 3.5 Messaging Reliability — 40
- Sự cố production: bot HSLC im ~2 giờ ngày 06/10 (11:38–13:29 giờ VN) và lần hai 07/10, cả hai vì tài khoản trả trước Google cạn.
  Khoá BYOK của HSLC và khoá nền tảng hỏng CÙNG phút ⇒ dùng chung một tài khoản trả trước. Khoá dự phòng (`lib/sales-chatbot/engine.ts:552-578`)
  chỉ đỡ được khi nó nằm ở tài khoản trả tiền KHÁC — điều này chưa kiểm được trên CSDL tổ chức.
- Lưới có sẵn: `sales-health` 5 phút, bắt «bot im» khi ≥ 3 tin khách trong 30 phút không có câu bot (`lib/constants/ai-sales-slo.ts:36-37`),
  thử lại 3 lượt + DLQ, `message_id` UNIQUE, một đường nhận cho mỗi page.
- Lỗ: webhook Meta là nguồn duy nhất, không quét bù Graph (B#6). Chat công khai: vòng 15 giây tạo hội thoại rác (PR #665).

### 3.6 AI Quality — UNKNOWN
Golden v2 tự nói rõ: SKU 29/29, số lượng 34/34 đúng «vì model kịch bản chọn đúng»; độ chính xác của MODEL THẬT là việc của bench có
model. Cần đo, ở đâu:
1. Chạy `sales-bench` / `order-sync-bench` với model thật trên chính dataset golden v2, LƯU kết quả theo model × phiên bản lời nhắc
   (kiểm kê B#23, sứ mệnh `saas-order-accuracy`). Chú ý: bench ăn credit trả trước chung (sự cố 07/10) ⇒ chạy trên khoá tách riêng.
2. Tỷ lệ gợi ý Copilot «gần như nguyên văn + sửa» của HSLC (`docs/productization/19_HSLC_PILOT.md` §3), đọc ở CSDL tổ chức.
3. Tỷ lệ hội thoại AI chuyển người, theo lý do (`sales_conversation_events` kiểu `handoff.requested`), CSDL tổ chức.

### 3.7 Order Accuracy — 40
- Golden v2 (33 hội thoại tổng hợp, nền `051f49a5`): `false_auto_confirm_rate` **36,4% (4/11)** khi công tắc tắt, **72,7% (8/11)**
  khi bật. Bốn ca khi tắt: «ok để chị hỏi chồng», «chị chưa chốt đâu» (trích «chốt» trong câu phủ định), khách đáp «??» (chuỗi chỉ
  dấu câu gập về rỗng nên luôn khớp), địa chỉ chưa ghép được xã.
- Lỗi thuần mã (không phải luật kinh doanh): lời xác nhận chỉ có dấu câu khớp mọi câu; so chuỗi con không có ranh giới từ
  (`lib/sales-chatbot/tools.ts:648`, `lib/sales-chatbot/text.ts:7-16`); SĐT lưu nguyên dạng khách gõ («0919.000.808»). Công tắc
  `autoConfirmComplete` là LUẬT chủ shop chốt 04/10, không phải lỗi; mọi đổi luật chờ chủ shop (`ORDER_CANDIDATE.md` §5).
- Tốt: đơn trùng 0/30, thiếu đơn 0/29, giá 34/34, tổng tiền 29/29, địa chỉ 87/87 thành phần.
- Chưa đo: các số trên với hội thoại THẬT, và tỷ lệ đơn AI bị người sửa / huỷ trên production.

### 3.8 Trust — 35
- Tốt: khách không thấy tên model, USD, tên công cụ (`lib/saas/visibility.ts`); Tổng quan in «—» khi chưa biết.
- Lỗ: «Hỏng» cho việc chưa làm (`app/(dashboard)/ai/sales-chatbot/page.tsx:124`); «liên hệ hỗ trợ» không kênh ở ≥ 12 chỗ
  (`HELP_CENTER.md` §1); `customer_confirmation` không lưu thành dữ liệu có cấu trúc, đơn không mang bằng chứng từng trường
  (`ORDER_CANDIDATE.md` §1); «Tỷ lệ hoàn 0.0%» khi mẫu số bằng 0 (F-16, trái AGENTS 42); panel hộp thư vẫn hiện lịch sử của hồ sơ
  chưa xác minh cho nhân viên (rủi ro LOW đã ghi ở `MASTER_MISSION_STATUS.md`).

### 3.9 Customer Value — UNKNOWN
Máy đo đã có ở ERP: phễu + kết cục đơn theo `ORDER_OUTCOME`, lãi gộp đã giao theo nhãn AI (#646), lãi sau chi phí AI theo nhánh
AI vs Người (#658). Chưa có số vì:
1. `db-query` chỉ đọc CSDL nhà (`MASTER_MISSION_STATUS.md` mục «Đo lường phát hiện được»).
2. Mốc `FIRST_DELIVERED_AI_ORDER` có trên sổ nhà nhưng chưa ai đọc (`TIME_TO_VALUE.md` Q2).
Cần đo: đơn AI chốt / giao thành công / doanh thu giao / lãi sau AI của từng workspace 30 ngày, qua `scripts/org-summary.ts`
(đã đọc đơn theo `ORDER_OUTCOME`) mở rộng thêm khối AI. Không tính «ROI» khi giá thuê bao còn legacy hoặc chưa biết.

### 3.10 Retention — UNKNOWN
Cần đo: số ngày có tin khách / có câu AI trong 14 ngày (`platform_tenant_usage_daily`, `TIME_TO_VALUE.md` Q9), đăng nhập cuối
(`platform_identities.last_used_at`, Q10), cohort theo tuần đăng ký. Logo churn / GRR / NRR chỉ có nghĩa sau kỳ thu V1 đầu tiên
(`docs/productization/11_SAAS_METRICS_SPEC.md` §3).

### 3.11 Monetization — 10
- 8/8 tổ chức còn ở giá legacy; 0 ₫ thu theo V1 (production 08/10).
- Hoá đơn chỉ có `kind` RENEWAL / ADDON, chưa có OVERAGE (B#30). Thiết kế đã xong (`docs/saas/OVERAGE.md`), mã chờ chủ shop.
- Số dư AI cờ TẮT, chưa khai tài khoản nhận tiền (`docs/saas/AI_BALANCE_V1.md` §4).
- Có nền: bảng giá V1 có phiên bản (0228), đồng hồ khách AI ghi từ 07/10, QR SePay cộng đúng một lần (#644, #650, #655).

### 3.12 Mobile — 55
Như bảng. Thêm: biểu tượng và tiêu đề thông báo đẩy là của VNX (`public/sw.js:15`, `:18-19`); chưa có bài kiểm trình duyệt
điện thoại tự động (B#35).

### 3.13 Support — 20
Như bảng. Kênh hỗ trợ trong app chỉ xuất hiện ở GoLiveCard (`components/onboarding/go-live-card.tsx:148-149`), mà thẻ này không
hiện trong vỏ. Kênh hỗ trợ chính thức là câu hỏi mở cho chủ shop (`HELP_CENTER.md` §9 Q1).

### 3.14 Security — 50
Như bảng. Nguồn: kiểm kê B#47 (tenant-attack, S1–S21, HKDF, `ops-log-leak`), B#36 (`lib/auth/social.ts:20`), B#4 (chỗ lộ còn lại,
bản vá ở `wip/saas-l1`). Chưa có lượt kiểm thâm nhập độc lập nào cho vỏ khách.

### 3.15 Operational Scalability — 35
- Đọc CSDL tổ chức cần một ops riêng cho từng câu hỏi (`org-summary`, `org-order-audit`), vì `db-query` chỉ mở CSDL nhà.
- Credit AI trả trước dùng chung giữa AI của khách, AI nền tảng và việc đo thử (sự cố 06/10, 07/10).
- Hộp thư: `router.refresh()` 5 giây + đếm toàn bảng mỗi lượt (`INBOX_V2.md` §8 K1–K2) — chi phí tăng theo số tab mở × số hội thoại.
- Không `x-request-id`, không logger cấu trúc (B#48); Continuous Auditor mới là thiết kế.

### 3.16 Competitive Differentiation — UNKNOWN
Bằng chứng trong kho chỉ là so sánh trên giấy:
- Giá thị trường tra 03/10: Retion / Bot Bán Hàng Lite 199k, Pro 480k; Fchat 99k–999k (`docs/platform/pricing.md:9-17`). Gói AI
  thấp nhất của V1 là STARTER 790.000 ₫ (`PRICING_V1.md` §I.1).
- Khác biệt tự khai (`CHOTDON_SMART_ROADMAP.md`): kết cục đơn theo chứng từ ĐVVC, lãi đã giao theo AI, chuẩn hoá 34 tỉnh / 3.321 xã.
- Khoảng trống tự khai: TikTok / Instagram DM trực tiếp (D1), Messenger trực tiếp đang BLOCKED.
Cần đo: lý do chọn / bỏ của từng workspace (một câu hỏi lúc đăng ký và lúc huỷ — chưa có nguồn), và so sánh tính năng có kiểm chứng
bằng dùng thử sản phẩm đối thủ.

## 4. Lần chấm sau

Theo chu kỳ ở `README.md` §3. Điều kiện để chấm một chiều `UNKNOWN`: có ít nhất một số đo production nêu ở mục «cần đo» của nó.
