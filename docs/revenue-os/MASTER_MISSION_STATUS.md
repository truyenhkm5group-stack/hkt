# AI Revenue OS — bản đồ hiện trạng (08/10/2026)

> Kiểm kê theo «TECH LEAD DELIVERY PIPELINE — MASTER MISSION» của chủ shop (08/10/2026). Mỗi mục: **DONE** (đã chạy production)
> · **PARTIAL** (có nền, còn thiếu phần ghi rõ) · **MISSING** · **BLOCKED** (chờ bên ngoài / chủ shop). Dùng lại nền có sẵn —
> không dựng hệ song song. Cập nhật tệp này khi một lát vào production.

## P0

| # | Hạng mục | Trạng thái | Đã có (bằng chứng) | Còn thiếu |
|---|----------|-----------|--------------------|-----------|
| 1 | Meta Direct độc lập Pancake | BLOCKED | Kết nối Facebook bằng Configuration ID, webhook trực tiếp, song song Pancake/Meta theo page (#641), Kênh kết nối hợp nhất (#637) | Meta chưa cấp quyền Page cho app (use case Messenger) — việc của chủ shop trong App Dashboard |
| 2 | Unified Inbox | PARTIAL | Tất cả / từng page · chưa đọc · chưa trả lời · có / chưa SĐT · đã / chưa chốt · AI / Người · cần người · phụ trách · level; ghi chú nội bộ; nhãn; giao việc; lịch sử mua + giao (ORDER_OUTCOME); dấu vết AI từng tin; tiếp quản / trả lại AI; vỏ app điện thoại (#638) | Chèn câu trả lời mẫu ngay ô soạn · gửi thẻ sản phẩm · tìm kiếm · đo hiệu năng (sứ mệnh `saas-inbox-perf`) |
| 3 | Commerce Truth | PARTIAL | Tập công cụ đóng; giá luôn đọc lại ở máy chủ; tồn khả dụng; tính giỏ; **tra trạng thái đơn của CHÍNH hội thoại theo căn cứ (đơn → vận đơn đại diện → chứng từ ĐVVC; giao lỗi / hoàn ⇒ chuyển người — `get_order_status`, lát này)**; khách cũ: lịch sử mua / địa chỉ chỉ theo danh tính ĐÃ XÁC MINH (mã Facebook) hoặc đơn có người đứng sau — đơn nháp người lạ gõ SĐT của chủ thật không thành «lần trước», không chặn ghi đơn thật (#647 · #651 · #652) | Khuyến mại (chưa có bộ máy khuyến mại) · giữ hàng (reserve) |
| 4 | Order Truth | DONE | `confirm_order` đòi đơn nháp + đủ người nhận + giá không đổi + không vượt tồn + lời xác nhận NGUYÊN VĂN; đơn thật qua cùng lõi đơn tay (idempotent theo lượt mua); truy vết đơn → hội thoại (`sales_conversation_id`) → sự kiện `order.confirmed` → sổ AI theo `ref` (model, nhà cung cấp, mốc); **dấu phiên bản lời nhắc (model · nhà cung cấp · phiên bản) trên sự kiện chốt đơn (#649)** | — |
| 5 | Conversation → Delivered Profit | PARTIAL | Quy kết từng đơn (`attribution.ts`), màn Hiệu quả AI (phễu · kết cục đơn qua ORDER_OUTCOME · tiền AI theo hội thoại), so AI vs Người theo nhánh (`experiment-report.ts`); **lãi gộp đã giao theo nhãn AI tự bán / AI góp công / Người bán qua giá vốn chung `orderCogsFast`, đơn chưa có giá vốn đứng riêng (#646)**; **lãi gộp + chi phí AI (ước tính, theo hội thoại của nhánh) + lãi sau AI theo nhánh thử nghiệm AI vs Người (#658)** | Trừ cước / quảng cáo / nhân sự theo hội thoại (chưa có căn cứ phân bổ theo hội thoại — luật 3.14) · ROI khách |

## P1

| # | Hạng mục | Trạng thái | Đã có | Còn thiếu |
|---|----------|-----------|-------|-----------|
| 6 | Revenue Rescue | PARTIAL | Quét khách bị bỏ sót (`recovery.ts`), follow-up, quét lại tin rơi | Sự kiện cứu có lý do · giá trị kỳ vọng · kết quả · đơn / doanh thu giao / lợi nhuận cứu được |
| 7 | AI vs Human dashboard | DONE | Chế độ EXPERIMENT + báo cáo nhánh + drill-down hội thoại; **so hai nhánh bằng lãi gộp đã giao / hội thoại và lãi sau chi phí AI, chênh lệch có chiều cận, thiếu giá vốn / chưa định giá thì không kết luận (#658)** | Chưa trừ nhân sự / cước / quảng cáo (xem mục 5) |
| 8–10 | AI Balance + QR + ledger + giá phiên | PARTIAL | #644: sổ cái chỉ ghi thêm, nạp QR ERPNAP qua SePay (cộng đúng một lần), trừ khách AI vượt phần gồm, cổng hết số dư chỉ chặn khách mới, báo số dư; backtest phiên 24 giờ (docs/saas/AI_SESSION_BACKTEST_2026-10-08.md); #648 doanh thu · chi phí · biên Số dư AI trên /platform; #650 sao kê / gõ tay không «nạp» hộ, tài khoản nhận đọc hỏng không khoá tiền; #653 đảo đúng MỘT khoản trừ theo mã dòng, cockpit tính doanh thu Số dư, «dùng» ròng; #655 tiền thuê bao cùng luật SePay — sao kê nhập tệp / gõ tay mang mã ERPHD chờ người vận hành xác nhận nguồn, không tự gia hạn; #659 ops `org-ai-cutover`: kiểm khoá AI của một tổ chức (dấu băm, project Google, credit) + chuyển AI Bán hàng sang AI dùng chung qua lõi /platform/org | Chủ shop khai tài khoản nhận tiền + bật cờ cho MỘT tổ chức thử (DoD nạp QR thật, không ai duyệt tay) · kế toán / pháp lý duyệt (AI_BALANCE_V1 §4) · giá phiên chỉ công bố khi đủ 30 ngày dữ liệu + có tỷ lệ chốt |

## P2 / P3

| Hạng mục | Trạng thái | Ghi chú |
|----------|-----------|---------|
| Model / task optimizer | PARTIAL | Platform AI Model Control (định tuyến model, A/B model, `workload` từ 07/10); thiếu đo theo việc × model × kết quả kinh doanh |
| Replay / regression | DONE | Replay · Shadow · sales-bench · hội thoại vàng (12 kịch bản) |
| Automation builder | PARTIAL | Luật tự động (workflows) có sẵn |
| Ads / CAPI closed loop | PARTIAL | Quy kết quảng cáo trên đơn chat (`chatOrderAdId`) |
| Vertical playbooks | PARTIAL | Hải sản (HSLC) chạy thật; thời trang / mỹ phẩm chưa |
| Instagram · Zalo · TikTok / Shopee · Outcome pricing | PARTIAL / MISSING | Zalo OA có; Instagram theo Meta; còn lại chưa |

## An toàn bot bán hàng (review bảo mật độc lập 08/10/2026)

| PR | Đóng lỗ gì |
|----|-----------|
| #647 | Lịch sử mua qua SĐT gõ tay: chỉ danh tính đã xác minh mới thấy «lần trước»; mức PHONE không bao giờ mang dữ liệu cũ vào lời nhắc ghi đơn |
| #651 | Đơn nháp người lạ dưới SĐT chủ thật không thành «lần trước»; giá đại lý chỉ cho đúng chủ hồ sơ; ô chữ hồ sơ vào lời nhắc là dữ liệu một dòng |
| #652 | Đơn máy (kể cả lượt nối hỏng) không chặn ghi đơn thật / không nâng mức khách; ký tự C1 / định dạng; bài học AI nhắc tới tiền / tài khoản / liên kết không tự áp (tự học + góp ý) |
| #654 | Bộ lọc bài học bắt tên miền / handle trần, không chặn nhầm; nguyên văn bài bị bỏ in ra; cờ bài cũ; hồ sơ do máy tạo không làm địa chỉ dự phòng |
| #656 | Tên miền dạng chung + có dấu, dấu chấm che giấu, @ ở mọi chỗ, cụm viết dính, ký tự vô hình, dãy số dài không lọt bộ lọc bài học; không nhìn-ngược trong mã tới trình duyệt; hồ sơ máy tạo không làm gợi ý `lookup_customer` và không làm tên / địa chỉ dự phòng |
| #657 | Form tạo đơn trong khung chat không điền / không dùng chữ ĐÃ LƯU của hồ sơ chưa xác minh (gắn qua SĐT gõ tay, kể cả chữ máy chủ điền từ đơn cũ) — chỉ chữ khách gõ, không có thì bắt nhập; LOW vòng 2 của bộ lọc bài học |

Rủi ro còn lại, đã ghi nhận: khung hộp thư vẫn hiện tên / địa chỉ / lịch sử đơn của hồ sơ chưa xác minh cho nhân viên (LOW — chỉ nhân
viên xem); form tạo đơn tay (POS) chọn hồ sơ bot tạo mà để trống địa chỉ thì lõi lấy địa chỉ đã lưu (LOW — cách hẹp: dự phòng về đơn
đáng tin gần nhất).

## Đo lường phát hiện được trong lượt kiểm kê

- `platform_ai_usage.conversation_id` từng rỗng ở 100% dòng 30 ngày — #649 điền ở đường ghi của bot + follow-up; lượt «AI ghi
  đơn hộ nhân viên» vẫn chỉ mang `ref = order-sync:<mã>`. Mọi báo cáo chi phí AI theo hội thoại đọc qua `ref` bằng một phép ánh xạ
  chung (`conversationOfRef`, #658) nên không thiếu.
- Chưa đọc được tỷ lệ chốt / giao / lợi nhuận theo phiên ở CSDL tổ chức qua `db-query` (chỉ đọc CSDL nhà) — cần một thao tác
  ops chỉ đọc theo tổ chức trước khi chốt giá phiên.

## MASTER MISSION SaaS A–Z (08/10/2026) — DAG & workstream

> Tóm tắt mục D của kiểm kê ngày 08/10/2026. Kiểm kê đo lúc 10:45–11:10 giờ VN, chỉ đọc, trên `origin/main` `82f562d4`. Sau đó đã
> gộp thêm #659 (`051f49a5`) và #661 (`07ef8aa8` — câu mẫu + dòng sản phẩm ngay ô soạn, tức B0). «R» là thang mức tự chủ R0–R4
> (`docs/saas/RISK_SCALE.md`). Bốn thiết kế R0 đi kèm:
> `docs/saas/OVERAGE.md` (E1) · `docs/saas/AI_COST_WORKLOAD.md` (E2) · `docs/saas/auditor/DESIGN.md` (F1) ·
> `docs/saas/RISK_SCALE.md` (F2). Điểm nóng SERIAL chung: `db/schema.ts` + `drizzle/` (giữ chỗ số từ 0237), `lib/auth/`,
> `middleware.ts`, `.github/`. Riêng `tests/sync-fixtures.test.ts` chỉ được NỐI THÊM.

```
#659 ĐÃ GỘP (051f49a5) → deploy → [chủ shop --apply AI Bán hàng HSLC]      #631 review lại ở đầu nhánh → gộp (0236)
A1 l1-followup ─┬────────────────────────────→ saas-e2e-customer (deps L2/L3/L5 đã DONE) → danh sách chặn khách trả tiền
B0 composer #661┼→ B2 Inbox V2 mã ←── D2 baseline perf ←┐
D1 UX audit ────┴→ A4 wizard mã · D4 help mã            │ (chỉ đọc)
C1 golden v2 + số nền ─→ C3 Order Candidate mã ←── C2 thiết kế + [chủ shop: autoConfirm]
B4 Identity kênh + C3 ─→ MỘT migration chung (SERIAL)
E1 OVERAGE (tài liệu XONG) ─→ [chủ shop: tài khoản nhận · duyệt · kỳ thu · hạn trả] ─→ E4 mã (R4)
F1 Auditor · F2 thang rủi ro (tài liệu XONG) ─→ AU-2… · RS-1… ─→ F3 correlation ID (middleware, R3)
saas-a-vnx-runtime ─→ [chủ shop duyệt từng page] ─→ saas-f dọn di sản · E6 gán gói VNX
```

| WS | Làm NGAY (nhỏ nhất) | Phụ thuộc / phải chờ | Vùng tệp · bảng sở hữu | Rủi ro |
|---|---|---|---|---|
| **A** Customer / Identity | A1 `saas-l1-followup`: tiếp từ `wip/saas-l1`, rebase main, thêm 3 chỗ lộ vào danh sách quét, chặn ghi khoá AI ở connectors | A2 sửa OAuth khớp EMAIL (chủ shop, IDENTITY §7 Q5) · A3 identity PR2 (IDENTITY §7 Q1–Q6) · A4 wizard: thiết kế ngay, mã sau A1 + D1 · A5 job gọi `markPilotCreated` + trạng thái liên kết kích hoạt · A6 phiên hỗ trợ «xem như khách»: thiết kế R0, mã R4 | `lib/saas/{visibility*,operator-ai,console,provisioning,portal}`, `lib/connectors/service.ts`, `lib/auth/**`, `app/{login,start,join}`, `lib/onboarding/*`; bảng `platform_identities` · `platform_organizations` · `platform_provisioning_jobs` · `platform_audit_log` | A1 R3 · A2–A3 R4 · A4–A5 R1 |
| **B** Messaging / Inbox | B0 `inbox-composer-templates`: ĐÃ GỘP (#661), chờ deploy + hậu kiểm · B1 (R0) thiết kế Inbox V2 + điểm ưu tiên P0–P3 là hàm thuần | B2 Inbox V2 mã chờ D2 + D1 (B0 đã gộp) · B3 Meta Direct còn thiếu (quét bù Graph, HUMAN_AGENT, memory cho Meta / Zalo / Web, nâng Graph trước 21/01/2027) — mở được sau B0 · B4 bảng Identity kênh, thiết kế chung với C2 | `lib/sales-chatbot/{inbox*,channel-ownership*,messenger*,fanpage,zalo,conversation-control*,ai-status*,recovery,quick-replies*}`, `lib/integrations/messenger/*`, `app/api/webhooks/*`; bảng `sales_chat_*` · `sales_conversation_events` · `sales_copilot_suggestions` · `org_channel_pages` · `platform_messenger_pages` | B0–B2 R1 · B3 R1–R3 · B4 R3 |
| **C** Order Accuracy | C1 golden v2 + bộ đo LƯU kết quả (`order_intent_recall`, đúng từng trường, `false_auto_confirm_rate`, `duplicate_order_rate`) dựng trên golden / bench sẵn có · C2 (R0) thiết kế state machine Order Candidate từ nháp ngầm hiện có | C3 mã Order Candidate / đổi luật chốt CHỜ C1 có số + C2 duyệt + chủ shop quyết `autoConfirmComplete` · C4 UNIQUE `agentKey` (đo trùng trên production trước) · C5 gom hàm SĐT sau C3 | `tests/sales-agent-golden/**`, `lib/sales-chatbot/{order-sync*,sales-bench,prompt-stamp,returning}.ts`, công cụ đơn của `tools.ts`, `lib/records/{order-create,customer-create,chat-order}.ts`, `lib/commerce/*`, `lib/address/*`; ranh giới chung `engine.ts` · `events-shared.ts` | C1–C2 R0–R1 · C3–C4 R3 |
| **D** UX / Help / Perf | D1 (R0) audit 8 mục vỏ ở 390px · D2 (R0, đọc production) baseline p50 / p95 hộp thư + ngân sách ms cho 8 trang vỏ · D3 (R0) Help 3 tầng · D5 (R1) `sw.js` icon theo host, apple-touch-icon | D4 mã help chờ D1 + D3 · D6 tối ưu SQL hộp thư chờ D2 (B0 đã gộp; giao B vì chạm `inbox.ts`) | `components/{saas-shell,nav-user,page-header,info-hint}`, `help-guides.ts`, `app/(dashboard)/{help,setup,ai/overview,settings/shop}`, `lib/onboarding/progress.ts`, `public/**`, `lib/perf/*`; `saas-nav.ts` chung với A (A giữ allowlist, D giữ nhãn) | R0 · D4–D5 R1 |
| **E** Billing / Cost | E0 #659 đã gộp → deploy → chủ shop `--apply` · E1 thiết kế hoá đơn vượt gói: XONG (`docs/saas/OVERAGE.md`) · E2 nền chi phí AI theo loại việc: XONG phần tài liệu (`docs/saas/AI_COST_WORKLOAD.md`), Integration Lead chạy Q0–Q9 | E3 đếm khách AI cho tin nhắn lại (`followup.ts`) · E4 mã OVERAGE (O1–O5 ở `OVERAGE.md` §10; O1 làm được ngay) chờ chủ shop · E5 bật Số dư AI chờ tài khoản nhận + kế toán / pháp lý · E6 gán gói VNX chờ `saas-a-vnx-runtime` · E7 gom hàm kỳ / biên sau E4 | `lib/saas/*` (trừ phần A), `lib/pricing/*`, `lib/billing/*`, `lib/ai-usage/{ledger,quota,control,platform-ai*}`, `lib/platform/{saas-*,usage-meter,org-plan}`; bảng `platform_{plans,price_*,plan_prices,org_pricing,*subscriptions,invoices,billing_*,payment_intents,ai_*,usage_events,tenant_usage_daily,cost_entries}` | E0 R3 / R4 · E1–E2 R0 · E3 R3 · E4 R4 |
| **F** Auditor / Observability | F1 thiết kế Continuous SaaS Auditor: XONG (`docs/saas/auditor/DESIGN.md`) · F2 quy đổi thang rủi ro: XONG (`docs/saas/RISK_SCALE.md`) | AU-2…AU-8 (Auditor §8) · RS-1…RS-4 (RISK_SCALE §6) · F3 correlation ID (`middleware.ts` → ALS → audit / events / sổ AI / `sync_runs`), R3 · F4 CSP report-only → enforce, R3 · F5 giới hạn tần suất chat công khai, R1 | `docs/saas/auditor/**`, `lib/platform/{audit,support,kill-switches}`, `platform-health.ts`, `app/api/{health,perf}`, bài kiểm cô lập / tấn công; F2 thuộc vùng `/tech` (`scripts/ai-tech.ts`, `.ai/`) | F1–F2 R0 · F3–F4 R3 |

**Bốn slot mã ngay:** A1 · C1 · D5 · một trong E3 / O1 của OVERAGE (slot B0 đã trả lại sau #661). Việc R0 còn lại (B1 · C2 ·
D1–D3) chạy song song.
`saas-e2e-customer` (P0) chạy sau A1 trên workspace thử, đầu ra là danh sách chặn khách trả tiền.

**Năm rủi ro lớn nhất:**

1. **Lộ dữ liệu nội bộ / danh tính trước khách trả tiền đầu tiên.**
   - Bản vá L1 mới ở `wip/saas-l1`.
   - OAuth khớp EMAIL chưa xác minh.
   - Không có CSP.
   - Chat công khai không giới hạn tần suất.
2. **Đơn «đã xác nhận» khi khách chưa đồng ý, và đơn trùng.**
   - `autoConfirmComplete` vẫn bật.
   - `agentKey` không UNIQUE.
   - Chưa có số `false_auto_confirm_rate`.
3. **Meta Direct phụ thuộc phê duyệt ngoài và không có lưới đỡ.**
   - Không quét bù khi mất webhook.
   - Graph v21 hết hạn 21/01/2027.
4. **Va chạm phiên song song.**
   - Có 218 cây làm việc (đo 08/10).
   - Review của #631 mất hiệu lực vì có commit mới.
   - Tệp nóng: `sync-fixtures`, `engine.ts`, `schema.ts`, `fanpage.ts`.
5. **Mô hình thu V1 chưa thu được đồng nào.**
   - 8/8 tổ chức ghim giá legacy.
   - Chưa có hoá đơn vượt gói.
   - Số dư AI đang TẮT, chưa có tài khoản nhận.
   - Biên gộp chưa tin được vì hạ tầng chưa khai.

**Cần chủ shop quyết — máy không được tự làm:**

1. **Meta (phê duyệt ngoài):**
   - trong App Dashboard, thêm use case Messenger và các quyền `pages_show_list` · `pages_messaging` · `pages_manage_metadata` ·
     `pages_read_engagement`;
   - bấm «Kết nối Facebook Page» một lần;
   - nộp App Review / Business Verification;
   - duyệt mục Messenger trong chính sách bảo mật.
2. **Thanh toán:**
   - khai tài khoản nhận tiền;
   - kế toán / pháp lý cho Số dư AI (`AI_BALANCE_V1.md` §4);
   - hoá đơn vượt gói: kỳ thu, đường duyệt, hạn trả và hậu quả quá hạn, VAT, cách đếm ghế, đổi gói giữa kỳ (`OVERAGE.md` §11
     Q1–Q10);
   - có thêm payOS không.
3. **Luật chốt đơn:**
   - giữ hay tắt `orders.autoConfirmComplete` và luật HSLC «khách tự gửi SĐT + địa chỉ là chốt»;
   - dữ liệu hội thoại thật cho golden (có PII, kho PUBLIC) được lưu ở đâu.
4. **Xác thực (AGENTS §7):**
   - trả lời IDENTITY §7 Q1–Q6;
   - cho sửa OAuth khớp EMAIL;
   - chính sách phiên hỗ trợ «xem như khách».
5. **Không đảo được / khách thật:**
   - `--apply` AI Bán hàng HSLC sang nền tảng (credit đủ hay phải ghi đè hạn mức — `AI_COST_WORKLOAD.md` §6);
   - chuyển page VNX SHADOW → LIVE và tắt container bot cũ;
   - gán gói VNX;
   - chuyển 8 tổ chức legacy sang V1 (`OVERAGE.md` Q8);
   - mở signup `open`;
   - V6 (bản sao khoá ngoài VPS);
   - dọn ~190 cây đã gộp.
6. **Thang rủi ro** (`RISK_SCALE.md` §7):
   - `lib/billing/` HIGH hay CRITICAL;
   - PR xác thực do Lead hay chủ shop gộp;
   - `.ai/config.json` · `scripts/ai-tech.ts` lên R4;
   - thêm sàn HIGH cho `lib/pricing/` · `lib/saas/` · `lib/ai-usage/`.
7. **Ngưỡng Auditor còn trống** (`auditor/DESIGN.md` §3): ngày chốt bảng kê và % lệch (A4) · % lỗi gửi (A8) · tỷ lệ đơn trùng
   (A10) · % AI chưa định giá (A14) · tuổi tối đa của tiền chưa khớp (A16).
