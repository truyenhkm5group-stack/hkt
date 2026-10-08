# Backlog cơ hội — Product Excellence (08/10/2026)

*Sứ mệnh `product-excellence-baseline` · R0 · đọc mã ở `origin/main` `36b7791b`. Tệp này SỬA TẠI CHỖ mỗi chu kỳ (`README.md` §3).
Không có số doanh thu / ROI nào được ước bằng tay ở đây: chỗ nào chưa đo thì ghi «chưa đo» và trỏ tới câu đo (AGENTS 8.5, 8.6).*

## 0. Luật xếp hạng (R)

1. **Mức trước.**
   - **P0**: sự cố đang xảy ra · khách bị chặn hẳn · sai tiền / thuê bao · lộ dữ liệu.
   - **P1**: mất doanh thu · sai đơn · chặn kích hoạt.
   - **P2**: ma sát ảnh hưởng nhiều người · đo lường mở khoá việc khác.
   - **P3**: chiến lược · đánh bóng.
2. **Trong cùng mức: Điểm R = Giá trị × Tần suất × Độ tin / (Công sức × Rủi ro)**, mỗi thừa số 1–3:
   - Giá trị V: 1 thấp · 2 vừa · 3 cao (tiền, đơn đúng, khách vào được);
   - Tần suất F: 1 hiếm / chưa đo · 2 hằng tuần · 3 mỗi khách mới hoặc hằng ngày;
   - Độ tin C: 1 suy luận · 2 đọc mã · 3 đo được (production hoặc bộ đo có nhãn);
   - Công sức E: 1 một PR nhỏ · 2 hai–ba PR · 3 migration hoặc nhiều PR;
   - Rủi ro K: 1 R0–R1 · 2 R2–R3 · 3 R4 (chủ shop quyết, tiền, không đảo được). Thang R là của `lib/constants/tech-policy.ts:10-31`.
3. **Việc ĐÃ nằm trong sứ mệnh đang chạy** không được nhân đôi: thẻ ghi «làm giàu tiêu chí nghiệm thu của <sứ mệnh>» và chỉ thêm
   tiêu chí đo được.
4. **Đích kinh doanh** (tỷ lệ, số ngày, số tiền) để trống cho chủ shop (AGENTS 3.38). Chỉ đích KỸ THUẬT (bất biến = 0, số trên bộ đo
   có nhãn, thời gian dựng trang) được đặt ở đây.

Kiểu giá trị: **MM** MAKE MONEY · **SM** SAVE MONEY · **ST** SAVE TIME · **RR** REDUCE RISK.

## 1. Bảng xếp hạng

| Hạng | ID | Cơ hội | Mức | V·F·C / E·K | Điểm R | Kiểu | Trạng thái | Sứ mệnh liên quan |
|---|---|---|---|---|---|---|---|---|
| 1 | PX-02 | Hết trang trắng sau đăng nhập / đăng ký (F-01) | P0 | 3·3·3 / 1·2 | 13,5 | RR · MM | PR đang làm | làm giàu `saas-e2e-customer` |
| 2 | PX-03 | Workspace tự đăng ký luôn có thuê bao (F-02) | P0 | 3·3·3 / 1·2 | 13,5 | MM · RR | PR đang làm | làm giàu `saas-e2e-customer` |
| 3 | PX-04 | Chat công khai có giới hạn tần suất, hết hội thoại rác | P0 | 2·2·3 / 1·1 | 12 | RR · SM | PR #665 review | làm giàu `chatbot-security-5` / F5 |
| 4 | PX-05 | Không lộ khoá AI / USD / chữ nội bộ cho khách | P0 | 3·2·3 / 1·2 | 9 | RR | PR đang làm (A1) | làm giàu `saas-l1-followup` |
| 5 | PX-01 | Bot không được im vì cạn credit AI trả trước | P0 | 3·2·3 / 1·3 | 6 | RR · MM | phần cutover đã gộp (#659), phần cảnh báo CHƯA có | làm giàu `org-ai-platform-cutover` + `ai-cost-opt-v2` |
| 6 | PX-06 | Chốt đơn sai do lỗi thuần mã (dấu câu, chuỗi con, phủ định) | P1 | 3·2·3 / 1·2 | 9 | RR · MM | có số đo (golden v2), chưa sửa | làm giàu `saas-order-accuracy` (C3) |
| 7 | PX-08 | Vào việc sau đăng ký: Hộp thư rỗng có bước tiếp + danh sách 10 bước | P1 | 3·3·2 / 2·1 | 9 | MM · ST | thiết kế xong (`HELP_CENTER.md` §7) | làm giàu `saas-help-system` (H4) + `saas-lowtech-ux` |
| 8 | PX-09 | Meta Messenger trực tiếp được cấp quyền Page | P1 | 3·3·3 / 1·3 | 9 | MM | BLOCKED, chờ chủ shop | `meta-messenger-access` |
| 9 | PX-07 | Dữ liệu đơn đúng: SĐT chuẩn hoá, sửa SĐT đổi người nhận, huỷ thì huỷ nháp | P1 | 2·2·3 / 1·2 | 6 | RR | có số đo, chưa sửa | làm giàu `saas-order-accuracy` (C3, C5) |
| 10 | PX-11 | «Bác sĩ kết nối»: tin có tới không · AI có trả lời không · vì sao | P1 | 3·2·2 / 2·1 | 6 | ST · MM | chưa có | MỚI (dùng lại nền của B3, Auditor A8/A9) |
| 11 | PX-10 | Thu được tiền theo V1 | P1 | 3·3·3 / 3·3 | 3 | MM | chờ chủ shop | `saas-d-pricing-overage`, `saas-e-customer-portal` (E4/E5) |
| 12 | PX-12 | Lưới đỡ khi mất webhook Meta (quét bù Graph) | P1 | 2·1·2 / 2·2 | 2 | RR | chưa có | B3 của `meta-messenger-access` |
| 13 | PX-13 | Đo Time-to-Value đủ chuỗi | P2 | 2·3·3 / 1·1 | 18 | ST | tài liệu xong (`TIME_TO_VALUE.md`) | MỚI (TV-1…TV-4) |
| 14 | PX-14 | Số nền hiệu năng hộp thư trước khi sửa | P2 | 2·3·2 / 1·1 | 12 | SM | thiết kế xong (V2-0) | `saas-inbox-perf` |
| 15 | PX-15 | Đo giữ chân sớm (ngày hoạt động, đăng nhập cuối, cohort tuần) | P2 | 2·3·2 / 1·1 | 12 | MM | câu đo xong (Q9, Q10) | MỚI → bản tin tuần Auditor |
| 16 | PX-16 | Sửa điện thoại: AI Sales tự cuộn, thẻ số chiếm màn đầu, biểu tượng thông báo | P2 | 2·2·3 / 1·1 | 12 | ST | thiết kế xong | `saas-lowtech-ux` (D5) |
| 17 | PX-17 | Tầng liên hệ hỗ trợ: một thành phần, thay 12 câu không kênh | P2 | 2·2·3 / 1·1 | 12 | RR · ST | chờ chủ shop chọn kênh | `saas-help-system` (H2) |
| 18 | PX-18 | Ngôn ngữ vỏ + hết lối cụt (F-05…F-08, F-15) | P2 | 2·3·3 / 2·1 | 9 | ST | thiết kế xong | `saas-lowtech-ux`, `saas-help-system` (H1) |
| 19 | PX-19 | «AI đã mang về cho bạn bao nhiêu» trong vỏ khách | P2 | 3·2·2 / 2·1 | 6 | MM | chưa có | MỚI (dùng lại #646, #658) · gần `saas-e-customer-portal` |
| 20 | PX-20 | AI Sales Simulator + bảng sẵn sàng nói thật | P2 | 2·2·2 / 2·1 | 4 | RR · ST | chưa có | làm giàu `saas-lowtech-ux` + C1 |
| 21 | PX-21 | Hộp thư V2: mật độ + ưu tiên P0–P3 | P2 | 2·3·2 / 3·1 | 4 | ST · MM | thiết kế xong (`INBOX_V2.md`) | B1/B2 (Inbox V2) |
| 22 | PX-22 | Thiết kế tin cậy cho ĐƠN / GIÁ / ĐỊA CHỈ / SĐT | P2 | 3·3·2 / 3·2 | 3 | RR | thiết kế xong (`ORDER_CANDIDATE.md` §3, `INBOX_V2.md` §7) | làm giàu `saas-order-accuracy` (C3b–C3c) |
| 23 | PX-23 | An toàn khi phát hành AI (đổi lời nhắc / model / định tuyến) | P2 | 3·1·2 / 2·1 | 3 | RR | nền có (golden, dấu lời nhắc, A/B model) | làm giàu `ai-cost-opt-v2`, `pipeline-upgrade` |
| 24 | PX-24 | Khoảnh khắc «wow» theo mốc thật | P3 | 2·1·2 / 1·1 | 4 | MM | chưa có | MỚI |
| 25 | PX-25 | Tín hiệu sức khoẻ khách (KHÔNG có điểm tổng) | P3 | 2·1·2 / 2·1 | 2 | MM | nền có (`11_SAAS_METRICS_SPEC.md` §7) | MỚI |
| 26 | PX-26 | Khám phá tính năng theo ngữ cảnh (nút «?» theo trang) | P3 | 1·2·2 / 2·1 | 2 | ST | thiết kế xong (H3) | `saas-help-system` (H3) |
| 27 | PX-28 | Chuyển sang từ Pancake / Sapo / Vpage | P3 | 2·1·1 / 3·2 | 0,3 | MM | Pancake tuỳ chọn có; Sapo / Vpage chưa có gì | MỚI |
| 28 | PX-29 | Giới thiệu khách mới | P3 | 1·1·1 / 2·2 | 0,25 | MM | chưa có | MỚI · chủ shop quyết |
| 29 | PX-27 | Khoảng trống cạnh tranh: gói AI giá vào · TikTok / Instagram | P3 | 2·1·1 / 3·3 | 0,2 | MM | chưa có | chủ shop quyết |

## 2. Thẻ chi tiết

Thứ tự trường trong mỗi thẻ: Vấn đề · Bằng chứng · Ảnh hưởng (ai · tần suất · mức · doanh thu / giữ chân) · Đề xuất · Phương án đơn
giản hơn · KPI · Công sức · Rủi ro · Độ tin · Phụ thuộc · Trạng thái.

### PX-01 · Bot không được im vì cạn credit AI trả trước (P0)
- **Vấn đề:** khi tài khoản trả trước của nhà cung cấp AI cạn, bot bán hàng của khách im lặng cho tới khi có người nạp.
- **Bằng chứng:** HSLC im ~2 giờ ngày 06/10 và lần hai 07/10. Khoá BYOK của HSLC và khoá nền tảng hỏng cùng phút ⇒ chung tài khoản trả
  trước. Chi AI Bán hàng của HSLC tăng 0,16 → 3,12 USD/ngày từ 02/10 tới 07/10 (production 08/10). Khoá dự phòng có sẵn
  (`lib/sales-chatbot/engine.ts:552-578`) chỉ đỡ được nếu nằm ở tài khoản trả tiền khác — chưa kiểm được.
- **Ảnh hưởng:** mọi workspace dùng AI nền tảng hoặc BYOK cùng tài khoản · đã xảy ra 2 lần / 2 ngày · P0 · khách mất đơn trong giờ
  im, và mất lòng tin vào sản phẩm.
- **Đề xuất:** (1) chủ shop chốt credit tháng cho HSLC rồi `--apply` cutover (#659); (2) cảnh báo DỰ BÁO: nhịp chi 24 giờ theo
  `platform_ai_usage` × số tiền chủ shop khai «đã nạp X USD ngày Y» ⇒ ngày dự kiến cạn, báo một tin / ngày (luật 26); (3) khoá dự
  phòng ở tài khoản trả tiền KHÁC cho workspace trả phí; (4) tách việc đo thử khỏi tài khoản trả trước của khách.
- **Đơn giản hơn:** chỉ (1) + một dòng nhắc tay hằng tuần trong bản tin Auditor.
- **KPI:** phút bot im vì lớp lỗi CREDIT / tuần (đích do chủ shop đặt) · có / không khoá dự phòng khác tài khoản cho mỗi workspace
  trả phí (kỹ thuật: có).
- **Công sức:** 1 (phần cảnh báo là PR nhỏ đọc sổ AI). **Rủi ro:** 3 (chi tiền, khách thật). **Độ tin:** 3.
- **Phụ thuộc:** #659 đã gộp → deploy → chủ shop chọn credit. **Trạng thái:** cutover chờ chủ shop; cảnh báo dự báo chưa có sứ mệnh.

### PX-02 · Hết trang trắng sau đăng nhập / đăng ký (P0) — làm giàu `saas-e2e-customer`
- **Vấn đề / bằng chứng:** F-01, 7/7 lượt, ≥ 13–40 giây trắng (`SHELL_AUDIT` §3).
- **Ảnh hưởng:** 100% khách vỏ ở lần vào đầu · P0 · khách bỏ đi trước khi thấy sản phẩm.
- **Đề xuất:** đã có trong PR đang làm (`redirect` thẳng tới trang nhà vỏ). **Tiêu chí nghiệm thu thêm:** bài kiểm trình duyệt —
  `h1` hộp thư hiện ≤ 3 giây và ≤ 5 lượt điều hướng sau đăng nhập / đăng ký ở cả 390 px và 1366 px; một ca cho tham số `next` dẫn
  tới trang vỏ chặn.
- **E** 1 · **K** 2 (đường đăng nhập, R3) · **C** 3 · **Phụ thuộc:** — · **Trạng thái:** PR đang làm.

### PX-03 · Workspace tự đăng ký luôn có thuê bao (P0) — làm giàu `saas-e2e-customer`
- **Bằng chứng:** F-02; production 08/10: 2/3 workspace tự đăng ký thiếu thuê bao.
- **Ảnh hưởng:** mọi lượt tự đăng ký · P0 · khách thấy câu như báo lỗi; MRR theo sản phẩm thiếu workspace này.
- **Tiêu chí nghiệm thu thêm:** `TIME_TO_VALUE.md` Q11 cột `khong_thue_bao_song` = 0 sau deploy (việc sửa dữ liệu cũ, nếu có, là R4
  — chủ shop duyệt); bài kiểm idempotent (đăng ký hai lần cùng tổ chức không sinh hai thuê bao sống — đã khoá bằng UNIQUE
  `platform_product_subscriptions_live_key`, `db/schema.ts:5573`); thêm phép kiểm A19 vào Auditor (`README.md` §4).
- **E** 1 · **K** 2 (thuê bao, R3) · **C** 3 · **Trạng thái:** PR đang làm.

### PX-04 · Chat công khai có giới hạn tần suất (P0) — làm giàu `chatbot-security-5` / F5
- **Bằng chứng:** chat công khai từng không giới hạn tần suất, vòng 15 giây tạo hội thoại rác; throttle trong RAM (B#47).
- **Ảnh hưởng:** workspace bật trang chat công khai · chi phí AI và đồng hồ khách AI bị thổi phồng · P0 (tiền).
- **Tiêu chí nghiệm thu thêm:** đếm hội thoại kênh WEB mới / workspace / giờ trước và sau deploy (số đo, không ước); khách AI
  (`platform_usage_events`, Q8) không tăng theo hội thoại rác; một ca kiểm khi tiến trình khởi động lại (throttle trong RAM mất).
- **E** 1 · **K** 1 · **C** 3 · **Trạng thái:** PR #665 đang review.

### PX-05 · Không lộ khoá AI / USD / chữ nội bộ cho khách (P0) — làm giàu `saas-l1-followup`
- **Bằng chứng:** kiểm kê B#4: tên công cụ AI (`conversations/[id]/page.tsx:42`, `replay/page.tsx:132`), lý do AI có USD
  (`go-live.ts:102`); bản vá ở `wip/saas-l1`.
- **Tiêu chí nghiệm thu thêm:** ba chỗ trên vào danh sách quét của `tests/saas-hide-internal.test.ts`; Auditor A1 runtime (AU-6) báo 0.
- **E** 1 · **K** 2 · **C** 3 · **Trạng thái:** PR đang làm.

### PX-06 · Chốt đơn sai do lỗi thuần mã (P1) — làm giàu `saas-order-accuracy`
- **Vấn đề:** bot ghi «Đã xác nhận» khi khách chưa đồng ý, vì hàng rào lời xác nhận có lỗ không phụ thuộc luật kinh doanh.
- **Bằng chứng:** golden v2: 4/11 ca chốt sai khi công tắc TẮT. Ba ca do mã: (a) lời trích chỉ có dấu câu («??») gập về chuỗi rỗng
  nên khớp mọi câu; (b) so chuỗi con không có ranh giới từ («ok» khớp «book»); (c) không xét phủ định («chị chưa chốt đâu»)
  (`lib/sales-chatbot/tools.ts:648`, `lib/sales-chatbot/text.ts:7-16`). Mỗi đơn chốt sai phát `order.confirmed` ⇒ báo nhóm như đơn thật.
- **Ảnh hưởng:** mọi workspace bot tự chốt · tần suất production CHƯA ĐO · P1 · đơn ma tốn công gọi xác nhận, giao nhầm.
- **Đề xuất:** đúng mục «Sửa nguyên văn» của `ORDER_CANDIDATE.md` §5: lời trích còn ≥ 2 chữ cái sau khi gập; khớp theo ranh giới từ;
  từ chối khi có phủ định / hoãn trong cùng câu; lưu `agreement_message_id`. Mỗi sửa đổi có ca golden trước.
- **Đơn giản hơn:** chỉ (a) + (b) — hai dòng điều kiện, chặn ngay ca «??».
- **KPI (kỹ thuật, đo trên golden v2):** `false_auto_confirm_rate` (TẮT) 4/11 → 1/11 (chỉ còn `dia-chi-chua-ghep-xa`, chờ chủ
  shop) · `missed_confirm_rate` giữ 0/22 · `duplicate_order_rate` giữ 0/30.
- **E** 1 · **K** 2 (đổi hành vi chốt trên khách thật, R3) · **C** 3.
- **Phụ thuộc:** C1 golden v2 gộp vào main. Không phụ thuộc quyết định `autoConfirmComplete` — đó là LUẬT chủ shop chốt 04/10, tách
  riêng (`ORDER_CANDIDATE.md` §11 Q1–Q3). **Trạng thái:** có số đo, chưa sửa.

### PX-07 · Dữ liệu đơn đúng (P1) — làm giàu `saas-order-accuracy`
- **Bằng chứng:** golden v2 mục 4, 5, 7: `mark_declined` không huỷ nháp (`huy-sau-tom-tat`, precision 29/30); sửa SĐT bằng
  `create_customer` không đổi người nhận (`sua-sdt-tao-lai-khach`, SĐT 28/29); SĐT lưu nguyên dạng («0919.000.808»). ~11 hàm chuẩn
  hoá SĐT (TD-20); bộ kiểm chặt có sẵn mà không dùng (`lib/wholesale/phone.ts:53`).
- **Đề xuất:** C3a (MỘT hàm SĐT) + lưu số chuẩn hoá trên đơn bot; `mark_declined` đánh dấu nháp của chính hội thoại (quyết định
  «huỷ hay đánh dấu» là câu 4 của golden v2 cho chủ shop).
- **Đơn giản hơn:** chỉ chuẩn hoá SĐT lúc ghi đơn bot, không gom 11 hàm.
- **KPI (golden v2):** `order_intent_precision` 30/30 · `phone_accuracy` 29/29 · chuỗi SĐT lưu không còn ký tự ngoài chữ số.
- **E** 1 · **K** 2 · **C** 3 · **Phụ thuộc:** C1 · **Trạng thái:** chưa sửa.

### PX-08 · Vào việc sau đăng ký (P1) — làm giàu `saas-help-system` (H4) + `saas-lowtech-ux`
- **Bằng chứng:** F-03 (Hộp thư rỗng không bước tiếp), 4 danh sách việc rời nhau, GoLiveCard không hiện trong vỏ (`HELP_CENTER.md` §7).
- **Ảnh hưởng:** mọi workspace mới · P1 · khách không biết phải nối kênh trước ⇒ không bao giờ tới «AI trả lời khách thật».
- **Đề xuất:** đúng thiết kế H4: hàm thuần `onboardingChecklist()` suy trạng thái từ dữ liệu thật; trạng thái rỗng riêng cho Hộp thư
  khi chưa có kênh; một chỗ chèn ở `inbox/page.tsx`.
- **Đơn giản hơn:** chỉ trạng thái rỗng «Chưa có tin khách vì chưa nối kênh. [Kết nối Facebook] [Đặt ô chat lên website]».
- **KPI:** tỷ lệ workspace tự đăng ký tới `CHANNEL_CONNECTED` và `FIRST_AI_REPLY` (Q3) và trung vị giờ (Q4) — đích do chủ shop đặt;
  kỹ thuật: 10/10 bước có liên kết qua `shellAllows`.
- **E** 2 · **K** 1 · **C** 2 (đo trên bản thử, chưa đo hành vi production) · **Phụ thuộc:** PX-02 (khách phải vào được), PX-13 để đo
  trước / sau · **Trạng thái:** thiết kế xong.

### PX-09 · Meta Messenger trực tiếp (P1) — `meta-messenger-access`
- **Bằng chứng:** nối page trả `PERMISSION_NOT_GRANTED`, Meta chỉ cấp `public_profile` (06/10); app Meta riêng đã tạo, webhook đã xác
  minh; mã OAuth `config_id`, token mã hoá, `subscribed_apps`, chữ ký webhook đã xong (B#6).
- **Ảnh hưởng:** mọi shop không dùng Pancake muốn nối Facebook · P1 · chặn kích hoạt kênh lớn nhất.
- **Đề xuất:** việc của chủ shop trong App Dashboard (use case Messenger + 4 quyền) rồi App Review / Business Verification
  (`MASTER_MISSION_STATUS.md` «Cần chủ shop quyết» 1). Máy không lách quyền Meta.
- **KPI:** số page Meta trực tiếp nối thành công (Q6) · lượt nối ra `PERMISSION_NOT_GRANTED` = 0.
- **E** 1 (phía mã) · **K** 3 · **C** 3 · **Trạng thái:** BLOCKED.

### PX-10 · Thu được tiền theo V1 (P1) — `saas-d-pricing-overage`, `saas-e-customer-portal`
- **Bằng chứng:** 8/8 tổ chức ở giá legacy, 0 ₫ V1 (production 08/10); không hoá đơn OVERAGE (B#30); Số dư AI TẮT, chưa tài khoản nhận.
- **Ảnh hưởng:** toàn bộ doanh thu nền tảng · P1.
- **Đề xuất:** quyết định chủ shop theo `MASTER_MISSION_STATUS.md` «Cần chủ shop quyết» 2 và 5 (tài khoản nhận, kỳ thu, chuyển 8 tổ
  chức legacy — `OVERAGE.md` Q1–Q10); mã E4 theo `OVERAGE.md` §10 sau đó.
- **Đơn giản hơn:** bắt đầu thu THUÊ BAO V1 cho workspace mới tự đăng ký (đã có QR ERPHD, #655) trước khi có hoá đơn vượt gói.
- **KPI:** số workspace có thuê bao V1 sống · MRR V1 (`platform_saas_daily`) · độ phủ đồng hồ khách AI (A15).
- **E** 3 · **K** 3 · **C** 3 · **Phụ thuộc:** PX-03 · **Trạng thái:** chờ chủ shop.

### PX-11 · Bác sĩ kết nối (P1) — MỚI
- **Vấn đề:** khi «không thấy tin khách» hay «AI không trả lời», chủ shop không có một chỗ nói nguyên nhân và ai phải làm gì.
- **Bằng chứng:** các mảnh có sẵn nhưng rời: chẩn đoán quyền Meta theo lý do (`lib/integrations/messenger/permission-guide.ts:29`,
  hiện ở `app/(dashboard)/ai/channels/page.tsx:30`), `sales-health` (hàng chờ, bot im, lỗi nhà cung cấp — `lib/constants/ai-sales-slo.ts`),
  sức khoẻ webhook (`lib/queries/webhook-health.ts:57`), bảng sẵn sàng (`readiness-shared.ts:34`). Thiếu bài «Vì sao chưa thấy tin
  khách» (`HELP_CENTER.md` §3).
- **Đề xuất:** một hàm thuần gộp các nguồn trên thành MỘT kết luận cho mỗi kênh, theo mẫu ba tình huống của AGENTS 55: không gọi
  được · gọi được nhưng 0 tin · nhận tin nhưng AI không trả lời (kèm lớp lỗi: CREDIT / bot tắt / nhường người). Mỗi kết luận nói ai
  làm (chủ page / chủ nền tảng / hỗ trợ). Hiện ở «Kênh kết nối» và ở trạng thái rỗng của Hộp thư.
- **Đơn giản hơn:** bài hướng dẫn «Vì sao chưa thấy tin khách» + liên kết tới thẻ chẩn đoán đang có.
- **KPI (kỹ thuật):** 100% kênh đang hiện có một kết luận; 0 câu «kết nối thất bại» chung chung.
- **E** 2 · **K** 1 · **C** 2 · **Phụ thuộc:** phần Meta chờ PX-09; Pancake / Zalo / chat web làm được ngay · **Trạng thái:** chưa có.

### PX-12 · Lưới đỡ khi mất webhook Meta (P1) — B3 của `meta-messenger-access`
- **Bằng chứng:** webhook là nguồn duy nhất, không quét bù (B#6); cùng lớp lỗi với AGENTS 51 (ERP không tự thấy gói tin chưa từng tới).
- **Đề xuất:** quét bù hội thoại gần đây qua Graph cho page Meta trực tiếp, đo chỗ hụt như `measureWebhookGap`.
- **E** 2 · **K** 2 · **C** 2 · **F** 1 (tần suất mất gói chưa đo) · **Phụ thuộc:** PX-09 · **Trạng thái:** chưa có.

### PX-13 · Đo Time-to-Value đủ chuỗi (P2) — MỚI
- **Bằng chứng:** `TIME_TO_VALUE.md` §1: thiếu mốc order candidate; `FIRST_AI_ORDER` có thể bỏ sót đơn máy ghi từ hội thoại nhân viên
  (SUY LUẬN); Zalo OA / chat web không bao giờ đạt `CHANNEL_CONNECTED`.
- **Đề xuất:** TV-1…TV-4 (`TIME_TO_VALUE.md` §4). Không đổi định nghĩa mốc cũ — thêm khoá mới.
- **Đơn giản hơn:** chỉ chạy Q1–Q11 hằng tuần và đọc kèm giới hạn.
- **KPI (kỹ thuật):** 7/7 mốc chuỗi sứ mệnh có nguồn đo; Q5 cho lượt quét cuối < 24 giờ.
- **E** 1 · **K** 1 · **C** 3 · **Trạng thái:** câu đo sẵn sàng; mã TV-1/TV-2 chưa có.

### PX-14 · Số nền hiệu năng hộp thư (P2) — `saas-inbox-perf`
- **Bằng chứng:** K1–K8 của `INBOX_V2.md` §8; chưa có p50/p95 (B#24).
- **Đề xuất / KPI:** V2-0 đúng thiết kế; ngân sách đề xuất ở `INBOX_V2.md` §8 (đích kỹ thuật, chốt sau khi có số nền).
- **E** 1 · **K** 1 · **C** 2 · **Trạng thái:** thiết kế xong.

### PX-15 · Đo giữ chân sớm (P2) — MỚI, chạy trong bản tin tuần Auditor
- **Bằng chứng:** Retention `UNKNOWN` (`SCORECARD_2026-10-08.md` §3.10); sổ dùng theo ngày có từ 0204.
- **Đề xuất:** định nghĩa «workspace hoạt động trong tuần» = có ≥ 1 ngày `customer_messages > 0` và `bot_messages > 0`
  (`platform_tenant_usage_daily`); cohort theo tuần tạo; in độ phủ (số ngày có dòng). Không chấm điểm.
- **KPI:** số workspace hoạt động / tuần theo cohort (đích chủ shop đặt).
- **E** 1 · **K** 1 · **C** 2 · **Trạng thái:** câu đo Q9, Q10 sẵn sàng.

### PX-16 · Sửa điện thoại (P2) — `saas-lowtech-ux` (D5)
- **Bằng chứng:** F-04 (`components/sales-chat/chat-panel.tsx:36-38`), F-13, F-16 (`public/sw.js:15`, `:18-19`).
- **KPI (kỹ thuật):** `scrollY = 0` khi mở AI Sales ở 390 px; việc chính nằm trên nếp gấp ở 3 trang; biểu tượng thông báo theo
  thương hiệu host.
- **E** 1 · **K** 1 · **C** 3 · **Trạng thái:** thiết kế xong.

### PX-17 · Tầng liên hệ hỗ trợ (P2) — `saas-help-system` (H2)
- **Bằng chứng:** ≥ 12 câu «liên hệ hỗ trợ» không kênh; `lib/constants/company.ts:9-14` là nguồn duy nhất đã có.
- **KPI (kỹ thuật):** 0 câu «liên hệ» không kèm liên kết trong vỏ.
- **E** 1 · **K** 1 · **C** 3 · **Phụ thuộc:** chủ shop chọn kênh chính thức (`HELP_CENTER.md` §9 Q1) · **Trạng thái:** chờ chủ shop.

### PX-18 · Ngôn ngữ vỏ + hết lối cụt (P2) — `saas-lowtech-ux`, `saas-help-system` (H1)
- **Bằng chứng:** F-05, F-06, F-07, F-08, F-15.
- **Tiêu chí nghiệm thu thêm:** danh sách cấm của `HELP_CENTER.md` §6 vào `tests/saas-hide-internal.test.ts` cho mọi trang vỏ; mọi
  `href` trong dữ liệu `lib/` (bài hướng dẫn, bảng sẵn sàng, lỗi xuất bản) qua `salesAgentPathAllowed`; Auditor A3 runtime có bộ đếm.
- **E** 2 · **K** 1 · **C** 3.

### PX-19 · «AI đã mang về cho bạn bao nhiêu» (P2) — MỚI
- **Vấn đề:** chủ shop không thấy giá trị bằng tiền của AI trong vỏ ⇒ khó gia hạn.
- **Bằng chứng:** `MASTER_MISSION_STATUS.md` P0 #5 «ROI khách» còn thiếu; máy đo có ở ERP (#646, #658) nhưng chưa ở vỏ.
- **Đề xuất:** một thẻ trên Tổng quan vỏ: đơn AI chốt · đơn AI đã giao (`ORDER_OUTCOME`) · doanh thu đã giao · độ phủ (đơn chưa có kết
  cục, chưa có giá vốn). KHÔNG in «ROI» hay «tiết kiệm được X giờ» khi chưa có căn cứ — chỉ số đo được.
- **Đơn giản hơn:** chỉ «đơn AI đã giao / đơn AI chốt» trong 30 ngày, kèm số đơn chưa có kết cục.
- **KPI:** tỷ lệ workspace có ≥ 1 đơn AI đã giao (`FIRST_DELIVERED_AI_ORDER`) — đích chủ shop đặt.
- **E** 2 · **K** 1 · **C** 2 · **Phụ thuộc:** PX-13 (đơn máy ghi phải được tính) · **Trạng thái:** chưa có.

### PX-20 · AI Sales Simulator + bảng sẵn sàng nói thật (P2) — làm giàu `saas-lowtech-ux` + C1
- **Bằng chứng:** F-04, F-07 («Hỏng», link `/inventory` bị chặn); shop mới không có lịch sử để phát lại.
- **Đề xuất:** dựng 5–10 kịch bản thử từ danh mục của CHÍNH shop (một SKU, hỏi giá, khách đổi SĐT, khách từ chối) chạy qua khung thử
  bằng khung golden (`tests/order-golden/harness.ts` trên nhánh C1); bảng sẵn sàng chỉ «Xong» khi kịch bản đạt.
- **Đơn giản hơn:** đổi nhãn «Hỏng» → «Cần làm» và sửa link (đã có trong PX-18).
- **E** 2 · **K** 1 · **C** 2 · **Phụ thuộc:** C1 gộp vào main · **Trạng thái:** chưa có.

### PX-21 · Hộp thư V2 (P2) — B1/B2
- Như `INBOX_V2.md` §9 (V2-1…V2-7). **Tiêu chí nghiệm thu thêm:** dòng hội thoại thấy trọn 3 → ≥ 4 ở 1366×768 và 390×844 (đích kỹ
  thuật đã khai ở `INBOX_V2.md` §4); thời gian tới phản hồi đầu của P0/P1 theo đội kèm độ phủ.
- **E** 3 · **K** 1 · **C** 2 · **Phụ thuộc:** PX-14.

### PX-22 · Tin cậy cho ĐƠN / GIÁ / ĐỊA CHỈ / SĐT (P2) — làm giàu `saas-order-accuracy` (C3b–C3c)
- **Đề xuất:** đúng `ORDER_CANDIDATE.md` §3 và khối 4 của `INBOX_V2.md` §7: câu theo từng trường, không bao giờ in phần trăm; hồ sơ
  chưa xác minh gắn nhãn «chưa xác minh» trong panel nhân viên.
- **Tiêu chí nghiệm thu thêm:** mỗi đơn «Đã xác nhận» do máy có `agreement_message_id` hoặc `confirmed_via` (đếm thiếu = 0 sau C3b).
- **E** 3 · **K** 2 (migration) · **C** 2.

### PX-23 · An toàn khi phát hành AI (P2) — làm giàu `ai-cost-opt-v2`, `pipeline-upgrade`
- **Bằng chứng:** dấu lời nhắc chỉ có ở đơn bot đã chốt (B#29); bench không lưu kết quả (B#23); A/B model chỉ áp nguồn PLATFORM (B#32).
- **Đề xuất:** đổi lời nhắc / model / định tuyến cho khách thật ⇒ chạy golden v2 + bench model thật trên khoá tách riêng, lưu kết quả
  theo `prompt_stamp`, so với lần trước; chênh `false_auto_confirm_rate` > 0 ⇒ chặn.
- **E** 2 · **K** 1 · **C** 2 · **Phụ thuộc:** C1.

### PX-24 · Khoảnh khắc «wow» theo mốc thật (P3) — MỚI
- **Đề xuất:** khi sổ mốc ghi lần đầu `FIRST_AI_REPLY`, `FIRST_AI_ORDER`, `FIRST_DELIVERED_AI_ORDER` ⇒ một thông báo trong vỏ («AI vừa
  trả lời khách đầu tiên của bạn») dẫn tới đúng hội thoại / đơn. Chỉ dựa trên chứng từ, không chúc mừng ước tính.
- **E** 1 · **K** 1 · **C** 2 · **Phụ thuộc:** PX-13.

### PX-25 · Tín hiệu sức khoẻ khách, KHÔNG có điểm tổng (P3) — MỚI
- **Bằng chứng:** `11_SAAS_METRICS_SPEC.md` §7 cấm điểm tổng khi chưa có ≥ 10 tổ chức đã rời để kiểm chứng trọng số.
- **Đề xuất:** một hàng tín hiệu / workspace trên `/platform/customers`: đăng nhập cuối (Q10), ngày hoạt động (Q9), mốc kích hoạt (Q2),
  phút bot im 7 ngày, tình trạng thu phí. Không xếp hạng, không màu đạt / không đạt (AGENTS 27, 44).
- **E** 2 · **K** 1 · **C** 2.

### PX-26 · Khám phá tính năng theo ngữ cảnh (P3) — `saas-help-system` (H3)
- Nút «?» theo trang mở bài trong ngăn bên; gợi ý lệnh `/` khi người gõ câu giá lặp lại. **E** 2 · **K** 1 · **C** 2.

### PX-28 · Chuyển sang từ Pancake / Sapo / Vpage (P3) — MỚI
- **Bằng chứng:** Pancake là kênh tuỳ chọn (#598, #641), nhập lịch sử hội thoại có (`lib/sales-chatbot/history-shared.ts:13`), nhập
  sản phẩm từ link có (#515). Sapo / Vpage: không có mã hay tài liệu nhập dữ liệu nào trong kho.
- **Đề xuất:** đo trước — hỏi lúc đăng ký «đang dùng phần mềm nào» (một câu, tuỳ chọn) để biết nhập từ đâu đáng làm.
- **E** 3 · **K** 2 · **C** 1.

### PX-29 · Giới thiệu khách mới (P3) — chủ shop quyết
- **Bằng chứng:** không có cơ chế trong mã (tìm 08/10). Ưu đãi giới thiệu là quyết định giá.
- **E** 2 · **K** 2 · **C** 1.

### PX-27 · Khoảng trống cạnh tranh (P3) — chủ shop quyết
- **Bằng chứng:** gói AI vào là 790.000 ₫ (`PRICING_V1.md`), đối thủ chatbot 199k–480k (`docs/platform/pricing.md:13-17`, tra 03/10);
  TikTok / Instagram DM trực tiếp chưa chạy (`CHOTDON_SMART_ROADMAP.md` D1). Chưa có số thắng / thua ⇒ Độ tin 1.
- **Đề xuất:** ghi lý do chọn / bỏ của từng workspace trước khi đổi giá hay mở kênh.
- **E** 3 · **K** 3 · **C** 1.
