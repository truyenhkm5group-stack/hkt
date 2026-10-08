# Continuous SaaS Auditor — thiết kế

> Thiết kế CHỈ TÀI LIỆU cho MASTER MISSION §40–§43 (Continuous SaaS Auditor + quản trị R0–R4), 08/10/2026, đọc mã ở `origin/main`
> `051f49a5`. Kiểm kê 08/10 ghi: Auditor CHƯA CÓ, R0–R4 ĐÃ CÓ (`lib/constants/tech-policy.ts:10-31`). Thang rủi ro và phép quy
> đổi ở `docs/saas/RISK_SCALE.md`.
>
> **Auditor không phải một hệ thứ hai.** Nó không có lịch mới, không có bảng mới ở pha 1, không có màn điều khiển riêng. Nó là một
> lượt ĐỌC chạy trong job có sẵn, đặt kết quả vào sổ có sẵn (`sync_runs`, `tech_incidents`), và hiện đúng MỘT ô trên `/tech` — cửa
> duy nhất của phòng Tech (`docs/tech-control-plane/README.md` §1).

## 1. Bảy luật nền (lấy từ AGENTS, không đặt luật mới)

1. **Chỉ đọc.** Auditor không sửa dữ liệu nghiệp vụ, không đổi cấu hình, không gọi API ngoài để ghi. Sửa luôn là một việc riêng,
   đi đúng đường của việc đó (luật 19, 53: hàng đợi là phép chiếu, không có nút «đánh dấu xong»).
2. **Không có bằng chứng thì không nói «khoẻ».** Phép kiểm không đo được in `CHƯA ĐO ĐƯỢC`, không in ✓ (luật 52, 65). Nó cũng
   không gửi tin đỏ, nhưng có tính vào ĐỘ PHỦ của lượt chạy.
3. **Ngưỡng là quyết định kinh doanh** (luật 38). Ngưỡng nào chủ shop đã chốt thì đọc từ đúng cài đặt đã có. Ngưỡng chưa chốt thì
   để TRỐNG: phép kiểm vẫn đo và in thực tế, nhưng không kết luận đạt / không đạt. Riêng bất biến bảo mật (khoá nội bộ lọt ra, lộ
   chéo tổ chức) là bất biến, không phải đích: ngưỡng của nó là 0.
4. **Không dữ liệu khách trong báo cáo.** Báo cáo chỉ được chứa mã phép kiểm, mã tổ chức và số đếm. Không SĐT, tên, nội dung tin,
   token, khoá, chi phí theo khách. Dòng `[ops:tom-tat]` công khai chỉ mang nhãn và phán quyết. Phần chi tiết theo tổ chức nằm ở
   phần MÃ HOÁ, như `scripts/org-ai-cutover.ts:23-24` (kho PUBLIC — AGENTS §5).
5. **Một tin / phòng / ngày** (luật 26 — `escalationDigest`, `lib/work/escalation.ts:128`). Không một dòng `notifications` cho
   mỗi phát hiện, vì cảnh báo lại là một việc và hàng đợi sẽ tự nhân bản.
6. **Chỉ mở, không tự đóng sự cố.** Đóng một sự cố đòi kể được ĐÃ LÀM GÌ. Máy không có câu đó, nên mẫu của
   `tech-incident-watch` / `ai-incident-watch` được giữ nguyên (`lib/sync/jobs.ts:352-362`, `:385-394`).
7. **Không đo lại thứ đã có người đo.** Hội thoại không ai trả lời, bot im, lỗi gửi, webhook im đã có `sales-health` đo mỗi 5 phút
   và báo ngay (`lib/sync/jobs.ts:845-864`). Auditor chỉ ĐỌC kết quả của job đó và gộp theo ngày / tuần.

## 2. Vòng lặp OBSERVE → … → LEARN

| Bước | Làm gì | Dựng trên (có sẵn) |
|---|---|---|
| OBSERVE | Đọc nguồn của từng phép kiểm (§3), chỉ đọc. Mỗi CSDL tổ chức mở TUẦN TỰ, giống cách sức khoẻ nền tảng làm (`lib/queries/platform-health.ts:219-226`) | `getPlatformDb()`, `withOrganization`, các hàm `lib/queries/*-health.ts` |
| DETECT | Mỗi phép kiểm là một HÀM THUẦN `(quan sát, ngưỡng) → phát hiện[]`. Không đọc CSDL, không đọc đồng hồ, chạy hai lần ra một kết quả — cùng khuôn với `nextSyncAt`, `measureWebhookGap` (luật 48, 51) | mẫu `lib/constants/*` |
| CLASSIFY | Gắn ba nhãn độc lập: **mức** SEV0–SEV3 (thang của `tech_incidents`, `db/schema.ts:8726`) · **phòng chịu trách nhiệm** (luật 22 — phòng, không bao giờ một người) · **mức tự chủ khi sửa** R0–R4 (`classifyTechPolicy`, `lib/constants/tech-policy.ts:77`). Kết quả `UNKNOWN` thì xếp tiếp theo bốn loại chỗ trống `TRUE_UNKNOWN · RESOLVABLE · STALE · AMBIGUOUS` (luật 45, `lib/constants/data-quality-issues.ts:33`) | — |
| DEDUPE | Khoá `audit:<mã phép kiểm>:<phạm vi>`. Mỗi khoá có nhiều nhất MỘT sự cố chưa đóng (mẫu `lib/sync/jobs.ts:359-360`) và MỘT dòng trong bản tin ngày | `tech_incidents`, `sync_state` |
| ROUTE | SEV0 · SEV1 thuộc Tech ⇒ mở `tech_incidents` (`createTechIncident`, `lib/tech/service.ts:915`, nguồn `MONITOR`). Còn lại ⇒ bản tin ngày của phòng. Mọi thứ hiện ở ô `/tech` (§6) | — |
| PROPOSE | Phát hiện sửa được bằng mã ⇒ tạo việc Tech (`createTechTask`, `lib/tech/service.ts:170`). Mức chính sách xếp bằng chính máy xếp đang có, không khai tay | `tech_tasks.policy_level` |
| ACT | Theo §5: máy chỉ tự làm R0 · R1 (PR + cổng). R2 có người review, R3 · R4 có chủ shop. Auditor KHÔNG BAO GIỜ tự sửa dữ liệu | worker (`lib/constants/tech-worker.ts:176-207`) |
| VERIFY | Lượt sau đo lại. Điều kiện hết ⇒ phát hiện rời bản tin (phép chiếu, luật 53). Sự cố vẫn mở tới khi NGƯỜI đóng có lời giải thích (`db/schema.ts:8730-8733`) | — |
| LEARN | Bản tin TUẦN: số phát hiện mở / đóng mỗi phép kiểm, thời gian tới khi hết, phát hiện bị người đánh «không phải lỗi» (kèm lý do). Hai đầu ra: việc R0 «xem lại ngưỡng» (người quyết, không bao giờ tự đổi ngưỡng) và việc R0 / R1 «thêm bài kiểm hồi quy» cho lỗi đã xác nhận | `tech_tasks` |

## 3. Danh mục phép kiểm (chỉ đọc, trên dữ liệu / job CÓ SẴN)

Ký hiệu ngưỡng: **0** = bất biến (không phải đích kinh doanh) · **đã chốt** = quyết định có sẵn của chủ shop, đọc từ cài đặt / hằng
đã khai · **⚑** = để trống, chủ shop đặt.

| Mã | Phép kiểm | Tín hiệu | Nguồn có thật | Ngưỡng | Mức | Ai xử lý | Nhịp | Sửa ở mức |
|---|---|---|---|---|---|---|---|---|
| A1 | Khoá nội bộ lọt DTO khách | Chạy các loader ĐỌC của màn khách (`loadCustomerEntitlementView` `lib/pricing/ai-gate.ts:197`, `loadCustomerPlan` `lib/pricing/customer.ts:87`, các hàm `customer*` của `lib/saas/visibility.ts`) cho từng workspace khách, rồi quét đệ quy | regex + bộ quét hôm nay nằm trong bài kiểm (`tests/saas-hide-internal.test.ts:61-80`) ⇒ chuyển sang `lib/` (AU-2) | 0 | SEV1 (SEV0 nếu là khoá / bí mật) | Tech | ngày + lượt đầu sau mỗi deploy | R1 |
| A2 | Cô lập tổ chức | (a) bảng `platform_*` trong CSDL tổ chức phải rỗng, CSDL mở được · (b) mỗi page Messenger thuộc đúng một tổ chức · (c) `org_code` trong sổ AI / sổ dùng phải thuộc tổ chức có thật | `getPlatformHealth` `lib/queries/platform-health.ts:219` · `platform_messenger_pages` (`db/schema.ts:5164`) · `platform_ai_usage`, `platform_usage_events` | 0 | SEV0 | Tech | ngày + sau deploy | R1 (mã) · R4 (nếu phải sửa dữ liệu) |
| A3 | Allowlist vỏ khớp href | Mã nguồn: mọi `href` của 8 mục vỏ và của trang trong vỏ (help, InfoHint) đều được `salesAgentPathAllowed` cho qua. Runtime: số lượt bị đá về trang nhà (`SHELL_RESTRICTED`) mỗi ngày | CI đã khoá 8 mục (`tests/saas-shell.test.ts:180-183`, `lib/constants/saas-nav.ts:74`, `:175`). Runtime: CHƯA CÓ nguồn (`lib/auth/session.ts:281` không đếm) ⇒ `UNAVAILABLE` + việc «ghi bộ đếm» | 0 | SEV2 | Tech | mỗi PR (CI) · ngày | R1 |
| A4 | Bảng kê bất thường | Kỳ đã qua chưa chốt sau ngày ⚑ của tháng · bảng kê FINAL có `unknown_lines > 0` · tổng lệch kỳ trước quá ⚑% · dòng `OVERAGE` CHƯA BIẾT | `platform_billing_statements` (`db/schema.ts:5661`) · nháp `loadCommercialSnapshot` (`lib/saas/customers.ts`) | ⚑ (ngày chốt, % lệch) | SEV2 | FINANCE | ngày (dày hơn ngày 1–5) | R0 (báo) |
| A5 | Biên < 60% | Biên lãi gộp chiếu của nền tảng và của từng khách, kèm ĐỘ PHỦ (lượt AI chưa định giá) | `platformGrossMargin` `lib/pricing/economics.ts:204` · `tenantMarginRisk` `:154` · `marginBand` `lib/pricing/versions.ts:498` | đã chốt 07/10: đích 75–85 · cảnh báo < 70 · nguy cấp < 60 (`platform.pricing.margin`, `lib/pricing/versions.ts:475`) | SEV2 (< 70) · SEV1 (< 60) | MANAGEMENT + FINANCE | ngày | R4 (giá / gói là quyết định chủ shop) |
| A6 | Hội thoại không ai trả lời | Số lần / thời gian đỏ trong ngày theo tổ chức, gộp từ kết quả đã lưu của `sales-health` | `runSalesHealthCheck` `lib/sales-chatbot/health.ts:265` · `sync_runs` của job `sales-health` | đã chốt 06/10: cảnh báo 5′ · nguy cấp 10′ (`lib/constants/ai-sales-slo.ts:23-25`) | theo `sales-health` | SALES | realtime ĐÃ CÓ · Auditor gộp ngày | — (vận hành) |
| A7 | AI im (bot im) | như A6 | như A6 | đã chốt 06/10: ≥ 3 tin trong 30′ không câu bot (`lib/constants/ai-sales-slo.ts:36-37`) | như A6 | SALES + Tech | như A6 | R1 nếu do mã |
| A8 | Lỗi Send API | Tỷ lệ tin gửi hỏng (dead-letter tiền tố `DEAD_SEND_NOTE_PREFIX`) theo kênh Messenger · Pancake · Zalo | `lib/sales-chatbot/fanpage.ts:1184` · mã lỗi `lib/sales-chatbot/ai-status-shared.ts:166-168` · hàng `SEND_FAILED` `lib/sales-chatbot/health.ts:227` | ⚑ (% lỗi / ngày) | SEV2 | Tech | ngày | R1 |
| A9 | Webhook im | Im so với nền CÙNG KHUNG GIỜ 14 ngày, dưới 5 ngày dữ liệu ⇒ `UNKNOWN` (luật 52) | `sales-health` (kênh bán hàng) · `lib/queries/vtp-webhook-health.ts:70` · `lib/queries/webhook-health.ts:57` · `lib/queries/integration-health.ts:458` | phương pháp đã chốt (luật 52) | SEV1 | Tech (đường truyền) · LOGISTICS (VTP) | realtime ĐÃ CÓ · Auditor gộp ngày | R1 · R4 nếu phải đổi tích hợp |
| A10 | Đơn trùng | Hàng đợi đơn nghi trùng theo tổ chức. Đơn AI cùng `agentKey` (chưa UNIQUE — kiểm kê C4) | `getDuplicateOrderQueue` `lib/queries/order-duplicate.ts:119` · luật ở cài đặt (`getDuplicateRule` `:110`) | ⚑ (tỷ lệ báo động) | SEV2 | SALES | ngày | R3 (sửa luật chốt đơn) |
| A11 | Migration trôi | Số migration đã áp ≠ số mục sổ `_journal.json` (+ `migrationRowOffset`); tổ chức chạy lược đồ khác mã | `readJournalCount` `lib/queries/platform-health.ts:117` · `/api/health` · `.ai/config.json:12` | 0 | SEV1 | Tech | sau mỗi deploy + ngày | R2 · R3 |
| A12 | Sao lưu | Bản sao nhà quá cũ · bản giờ của tổ chức quá RPO · diễn tập quá hạn | `getBackupHealth` `lib/queries/backup-status.ts:88` · `evaluateBackupHealth` `lib/constants/backup.ts:258` | đã khai: bản nhà 36 giờ (`:47`) · ngưỡng báo bản giờ của tổ chức 3 giờ (`:57`) cho mục tiêu RPO ≤ 1 giờ (quyết định C6, 29/09) · diễn tập 35 ngày (`:50`) | SEV1 | Tech | ngày | R2 (chạy lại) · R4 (khôi phục) |
| A13 | Sổ sứ mệnh trôi | Sổ `ai-control/registry` nói khác git / GitHub: RUNNING mà nhánh đã vào main, DONE không bằng chứng, nhịp tim > 24 giờ, chạm tệp ngoài phạm vi | `reconcileEntry` của `board` (`docs/ai-tech-room/delivery-v2.md` §3) · `tech_missions.registry_id` (`db/schema.ts:8823`) | đã khai: `staleHeartbeatHours` 24 (`.ai/config.json:10`) | SEV3 | Tech | tuần | R0 |
| A14 | AI chưa định giá *(bổ sung)* | Tỷ lệ lượt `cost_usd IS NULL` (trừ `BLOCKED_QUOTA`) theo model · model không có trong bảng giá | `platform_ai_usage` (`db/schema.ts:5070`) · `estimateCostUsd` `lib/ai/provider.ts:137` | 0 model lạ · ⚑ % | SEV2 | Tech | ngày | R1 |
| A15 | Đồng hồ khách AI hụt *(bổ sung)* | Tổ chức trả phí V1 mà độ phủ `NOT_MEASURED` / `PARTIAL` · bộ đếm lỗi ghi đồng hồ > 0 | `aiCustomerCoverage` `lib/pricing/versions.ts:570` · `aiCustomerMeterErrors` `lib/pricing/ai-customer.ts:46` (đếm trong RAM — mất khi khởi động lại ⇒ cần ghi bền, AU-4) | 0 | SEV1 | Tech + FINANCE | ngày | R1 |
| A16 | Tiền chưa khớp *(bổ sung)* | Khoản `UNDERPAID` · `INVOICE_NOT_OPEN` · `NO_INVOICE` · `TOPUP_HELD` · `TOPUP_CREDITED_REVIEW` chưa xử lý, kèm tuổi · dòng SePay chưa xác nhận nguồn | `platform_billing_payments` (`db/schema.ts:5280-5307`) · `/platform` | ⚑ (tuổi tối đa) | SEV2 | FINANCE | ngày | R4 (tiền) |
| A17 | Lệch thang rủi ro *(bổ sung)* | Việc / PR khai R0 · R1 mà chạm vùng tệp ≥ HIGH | `docs/saas/RISK_SCALE.md` §3 · danh sách tệp PR | 0 | SEV3 | Tech | mỗi PR (công cụ dev `queue`, không ở production) | R0 |
| A18 | Hai màn nói hai số *(bổ sung)* | Hoá đơn ước tính trên màn khách ≠ dòng vượt của bảng kê nháp cùng kỳ | `lib/pricing/customer.ts:119-131` vs `lib/saas/customers.ts:176-185` (`docs/saas/OVERAGE.md` §12.2) | 0 ₫ chênh | SEV2 | FINANCE + Tech | ngày | R1 |

A6 · A7 · A9 có realtime riêng từ trước, nên Auditor KHÔNG báo lại chúng theo thời gian thực. Nó chỉ đưa vào bản tin ngày con số «đỏ
bao lâu, bao nhiêu lần». Lỗi job lặp lại (`tech-incident-watch`) và lỗi nhà cung cấp AI (`ai-incident-watch`) cũng vậy: chúng chỉ
được đếm trong bản tin tuần.

## 4. Nhịp và chống spam

| Nhịp | Phép kiểm | Chạy ở đâu (không lịch mới) |
|---|---|---|
| Realtime | — (đã có: `sales-health` 5′, `tech-incident-watch` 30′, `ai-incident-watch` 30′) | không đổi |
| Giờ | A11 sau deploy (lượt đầu sau khi `tech_deployments` có bản đã đối chiếu mới) | ghép vào `task-advance-watch` (15′, `scripts/scheduler.mjs:284`) |
| Ngày | A1 · A2 · A4 · A5 · A8 · A10 · A12 · A14 · A15 · A16 · A18 + gộp A6 · A7 · A9 | ghép vào `tech-incident-watch` (30′, `scripts/scheduler.mjs:265`, chỉ tổ chức nhà). Lượt đầu tiên sau 06:00 giờ VN chạy phần NGÀY, giữ nhịp bằng khoá `sync_state` `audit:last-daily:<ngày VN>` |
| Tuần | A13 · A17 · LEARN | cùng chỗ, khoá `audit:last-weekly:<tuần ISO>` |
| Theo yêu cầu | mọi phép kiểm | job `saas-audit` đăng ký trong `lib/sync/jobs.ts`, KHÔNG có dòng lịch; chạy bằng ops `run-job` hoặc nút trên `/tech` |

Muốn có dòng lịch riêng cho `saas-audit` thì đó là đổi lịch scheduler, phải hỏi chủ shop (AGENTS §7). Mẫu «ghép vào job có sẵn» đã
có tiền lệ: ngưỡng khách AI và báo số dư AI chạy trong `sales-health` (`lib/sync/jobs.ts:857-859`).

Chống spam:

1. Một tin / phòng / ngày, khoá `saas-audit:<phòng>:<ngày VN>`. Nội dung gồm số phát hiện theo mức, 5 dòng đầu và một liên kết
   tới `/tech`.
2. SEV0 · SEV1 của Tech ⇒ một sự cố chưa đóng cho mỗi khoá dedupe. Lượt sau thấy sự cố đang mở thì KHÔNG mở thêm.
3. Lỗi mới chỉ được báo NGAY khi mức là SEV0. Mọi thứ khác đợi bản tin ngày.
4. «Đã biết / chấp nhận» = tắt tiếng CÓ HẠN, bắt buộc lý do và người bấm (khoá tài khoản, luật 34). Hết hạn thì phát hiện hiện
   lại. Không có tắt tiếng vĩnh viễn.
5. Lượt chạy hỏng một phép kiểm ⇒ phép kiểm đó `CHƯA ĐO ĐƯỢC`, các phép kiểm khác vẫn chạy, và lỗi không làm hỏng job chủ
   (mẫu `runAiBalanceAlerts` không ném, `lib/billing/ai-usage-charge.ts:86-121`).

## 5. Quản trị R0–R4 cho việc Auditor đề xuất

Thang và hàm xếp là của `/tech` (`lib/constants/tech-policy.ts:19-98`). Auditor không có thang riêng.

| Mức | Máy được làm gì | Ví dụ từ Auditor | Cổng |
|---|---|---|---|
| R0 | Tự tạo việc + tự PR: tài liệu, bài kiểm, runbook | thêm bài kiểm hồi quy cho A1, ghi runbook xử lý A12 | worker mặc định trần R0 (`lib/constants/tech-worker.ts:176-207`) · `gates / gates` |
| R1 | Tự tạo việc + tự PR: mã thường | thêm khoá vào danh sách che DTO, ghi bộ đếm A3, sửa nhãn | worker chỉ nhận khi chủ shop mở trần R1 (`tech.worker-policy-ceiling`) · cổng + review theo sàn gộp (`RISK_SCALE.md` §4) |
| R2 | KHÔNG tự động: Delivery Controller review rồi mới làm | chạy lại job sao lưu, deploy lại sau migration trôi | `TECH_AUTONOMOUS_POLICY` chỉ gồm R0 · R1 (`lib/constants/tech-policy.ts:31`) |
| R3 | Chủ shop duyệt trước deploy | sửa luật chốt đơn (A10), đổi cách đếm đồng hồ (A15 nếu là đổi luật) | `policyRequiresApproval` (`:96`) · `techDeployBlockers` (`lib/constants/tech.ts:391`) |
| R4 | Chủ shop QUYẾT trước khi ai làm gì: việc vào `NEEDS_OWNER` kèm một trong chín loại leo thang | đổi giá / gói vì biên < 60% (A5), xử lý tiền chưa khớp (A16), sửa dữ liệu production, khôi phục sao lưu | `OWNER_ONLY_RISK_RULES` · từ khoá R4 (`lib/constants/tech-policy.ts:34-62`) |

Auditor KHÔNG BAO GIỜ tự nâng trần worker, tự đổi ngưỡng, tự tắt một phép kiểm hay tự đóng sự cố.

## 6. Ô trên `/tech` (không dựng control plane thứ hai)

- **Một ô** trong buồng lái, cùng khuôn với các ô đang có (`app/(dashboard)/tech/cockpit.tsx:34-39`): «Kiểm toán SaaS · n phát
  hiện mở (SEV0 a · SEV1 b · SEV2 c) · đo được x/y phép kiểm · lượt cuối hh:mm». Tông `bad` khi có SEV0 / SEV1, `warn` khi có
  SEV2, `ok` khi sạch VÀ độ phủ đủ. Độ phủ thiếu ⇒ không bao giờ `ok`.
- **Pha 1:** ô dẫn tới `/tech/incidents` (lọc nguồn Auditor) và tới chi tiết lượt chạy (`sync_runs` của `saas-audit`).
- **Pha 2:** thêm một thẻ «Kiểm toán» vào `app/(dashboard)/tech/tech-nav.tsx:15-24`, liệt kê theo phép kiểm: trạng thái, lần
  đầu / lần cuối thấy, phạm vi (mã tổ chức), mức, phòng, nút «tạo việc» và «tắt tiếng có hạn». Không có nút sửa, chạy lệnh hay
  «đánh dấu xong».
- Quyền: chỉ người có quyền xem `/tech` ở tổ chức nhà. Dữ liệu theo tổ chức khách chỉ là mã + số đếm.

## 7. Dữ liệu

- **Pha 1 — không bảng mới.** Mỗi lượt ghi MỘT dòng `sync_runs` (`db/schema.ts:4741`, job `saas-audit`): `detail` là bản tóm tắt
  không dữ liệu khách, `failed` là số phép kiểm `CHƯA ĐO ĐƯỢC`. SEV0 · SEV1 của Tech vào `tech_incidents` (`db/schema.ts:8695`,
  bằng chứng = câu truy vấn + số đếm). Nhịp ngày / tuần giữ ở `sync_state`.
- **Pha 2 — chỉ khi pha 1 không đủ** (cần lịch sử từng phát hiện cho bước LEARN): bảng `tech_audit_findings` (mã phép kiểm, phạm
  vi, mức, phòng, lần đầu / lần cuối thấy, trạng thái `OPEN · GONE`, tắt tiếng tới, người tắt + lý do, bằng chứng jsonb KHÔNG dữ
  liệu khách). Đây là migration ⇒ R3 · HIGH, SERIAL. Phương án khác: mở rộng CHECK chủ thể của `tech_events`
  (`db/schema.ts:8880`) thêm `AUDIT`.

## 8. Thứ tự PR

| PR | Nội dung | Mức R / sàn gộp | Chờ gì |
|---|---|---|---|
| AU-1 | Tài liệu này | R0 · LOW | — |
| AU-2 | Danh mục phép kiểm `lib/constants/saas-audit.ts` (mã, nguồn, ngưỡng đọc từ cài đặt nào, phòng, mức) + hàm thuần DETECT + bài kiểm. Chuyển `internalKeyPaths` / `stringHits` / regex từ `tests/saas-hide-internal.test.ts` sang `lib/saas/visibility-scan.ts`, bài kiểm cũ import lại | R1 · MEDIUM | — |
| AU-3 | Job `saas-audit` (theo yêu cầu, không lịch) + phần OBSERVE cho A2 · A4 · A5 · A11 · A12 · A14 · A16 (chỉ đọc sổ nhà và hàm health có sẵn) | R1 · MEDIUM (chạm `lib/platform/` ⇒ HIGH) | AU-2 |
| AU-4 | Ghép nhịp ngày / tuần vào `tech-incident-watch`; bản tin một tin / phòng / ngày; mở `tech_incidents` cho SEV0 · SEV1; ghi bền bộ đếm lỗi đồng hồ (A15) | R2 (đổi hành vi job đang chạy) | AU-3 |
| AU-5 | Ô `/tech` + thẻ «Kiểm toán» | R1 · LOW | AU-3 |
| AU-6 | A1 runtime (loader khách thật, có bài kiểm «không lượt ghi nào»), A8 · A10 · A15 · A18 | R1 | AU-2 |
| AU-7 | A13 đọc sổ `ai-control/registry` qua GitHub API (chỉ đọc, kho công khai) | R1 | AU-3 |
| AU-8 | `tech_audit_findings` (chỉ khi cần) | R3 · HIGH SERIAL | đo pha 1 ≥ 2 tuần |

Ngưỡng ⚑ cần chủ shop đặt trước khi các phép kiểm tương ứng được KẾT LUẬN: A4 (ngày chốt bảng kê, % lệch), A8 (% lỗi gửi), A10
(tỷ lệ đơn trùng), A14 (% chưa định giá chấp nhận được), A16 (tuổi tối đa của khoản chưa khớp). Chưa đặt thì phép kiểm vẫn chạy
và in thực tế.
