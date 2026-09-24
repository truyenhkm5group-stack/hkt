# Chỉ mục `docs/` — đọc tệp nào, tin tệp nào

Cập nhật: **24/09/2026**. Luật cho agent nằm ở `AGENTS.md` (luật) và `HANDOFF.md` (bối cảnh) ở gốc
kho — không nằm trong thư mục này.

`docs/` có ~150 tệp viết trong ba tuần, và phần lớn là **biên bản của một thời điểm**. Một biên bản
cũ đọc như hiện hành là cách nhanh nhất để sửa nhầm chỗ, nên tệp này chia bốn nhóm:

| Nhóm | Nghĩa | Khi tài liệu và mã nói khác nhau |
|---|---|---|
| **(a) Hợp đồng / luật** | Đang hiệu lực, mã và bài kiểm bám theo | Sửa MÃ, hoặc chủ shop sửa hợp đồng trước |
| **(b) Runbook** | Làm theo từng bước | Sửa runbook |
| **(c) Trạng thái hiện hành** | Một tệp sống cho mỗi miền, cập nhật tại chỗ | Mã đúng, sửa tệp trạng thái |
| **(d) Lịch sử** | Biên bản phiên, phát hành, số đo có ngày | KHÔNG viết lại — đọc làm bối cảnh, kiểm lại trước khi dùng |

Quy ước: **không di chuyển, không đổi tên tệp** — mã nguồn, bài kiểm và đề bài của agent trỏ tới
đúng đường dẫn. Thêm tài liệu mới thì thêm một dòng vào đúng nhóm ở đây.

---

## (a) Hợp đồng và luật đang hiệu lực

### Nghiệp vụ lõi

- `business-rules/ORDER_OUTCOME.md` — đặc tả bắt buộc kết quả đơn (giao / hoàn / huỷ); `tests/contract-order-outcome.test.ts` khoá.
- `metrics-contract.md` — bất biến chỉ số: cùng chỉ số · cùng kỳ · cùng bộ lọc ⇒ cùng một con số ở mọi trang.
- `finance-truth-contract.md` — sự thật tài chính và mối nối tiền ↔ chứng từ (`lib/constants/finance-truth.ts`).
- `profit-cost-allocation-contract.md` — phân bổ chi phí vào báo cáo lợi nhuận (AGENTS.md mục 14).
- `cogs-recognition-contract.md` — ghi nhận giá vốn; tăng tốc không được đổi cách xác định giá vốn.
- `finance-cockpit.md` — buồng lái tài chính: vì sao thiết kế như vậy và ranh giới của nó.
- `P0.1-PAYMENT-FOUNDATION.md` — lược đồ chứng từ thanh toán (grain, trường); câu "chưa nối" trong tệp là trạng thái lúc viết (08/09).
- `inventory-forecast-contract.md` — tồn · tốc độ bán · số nên đặt sản xuất (`lib/constants/planning.ts`).
- `inventory-capital-decision-contract.md` — quyết định vốn tồn kho (`lib/constants/inventory-decision.ts`).
- `return-reason-observation-contract.md` — lớp quan sát LÝ DO hoàn; không định nghĩa lại "hoàn".
- `VTP-IMPORT-DATA-TRUTH.md` — nhập Danh sách vận đơn Viettel Post có truy nguyên: cột nào dùng thế nào.

### Bán hàng, marketing, vận hành

- `sales-funnel-contract.md` — phễu bán hàng; bước cuối dùng lại `ORDER_OUTCOME`.
- `revenue-conversion-contract.md` — lớp chuyển đổi doanh thu (bốn câu hỏi, không thêm dashboard).
- `operating-funnel-metric-contract.md` — phễu vận hành của `/operations`: một khâu phải trả lời đủ bốn câu.
- `ads-decision-contract.md` — hợp đồng chỉ số của màn ra quyết định quảng cáo.
- `marketing-daily-contract.md` — báo cáo hiệu quả marketing theo ngày.
- `care-engine-contract.md` — backend "Vận đơn & care": UI chỉ gọi service / action trong đây.
- `care-rounds.md` — đặc tả lượt xử lý care (`lib/constants/care-rounds.ts`) kèm số đo và lý do.
- `work-management-os.md` — Work OS: hàng đợi là PHÉP CHIẾU (AGENTS.md mục 19).
- `ban-giao/BAN-GIAO-BOT-CHAT-CHO-ERP.md` — đặc tả hành vi bot chat bán hàng đang chạy (mã ở `chatbot/`); mục 13 là phương án KHÔNG được chọn.

### Kỹ thuật, bảo mật, quy trình

- `CONVENTIONS.md` — quy ước mã nguồn: trang, truy vấn, server action, bảng.
- `design-system.md` — luật trình bày màn hình.
- `ai-copilot-architecture.md` — AI Copilot: ERP là sự thật → tool ĐỌC có kiểu → AI.
- `security-2026-09-19-sliding-session.md` — phiên đăng nhập trượt: thiết kế và rà soát.
- `security-2026-09-19-session-revocation.md` — thu hồi phiên từ phía máy chủ.
- `second-approval-policy.md` — phê duyệt hai bước: chính sách đã chốt và vì sao cưỡng chế đang tắt.
- `main-protection.md` — khoá nhánh `main` (`.github/rulesets/main-protection.json`) và phần ai phải bấm.
- `ci-concurrency.md` — khoá đồng thời của GitHub Actions: ai chờ ai.
- `agent-github-identity.md` — danh tính GitHub `erp-agent` của coding agent.
- `agent-pr-bridge.md` — cầu nối mở PR bằng danh tính agent.

### Đặc tả chưa làm hoặc đang chờ quyết

- `bank-realtime-sync-readiness.md` — đồng bộ sổ ngân hàng thời gian thực: **chờ chủ shop duyệt**, chưa triển khai.
- `adr-deployment-task-link.md` — ADR nối lượt deploy với việc Tech (nhiều-nhiều): **đề xuất**, chưa migration.
- `p1.2-work-performance-evaluator.md` — chuyển `/work/performance` sang `evaluateMetric()`: **chưa làm** (24/09 trang vẫn chưa gọi hàm ấy).

---

## (b) Runbook vận hành

- `TRIEN-KHAI-VPS.md` — triển khai lên VPS `erp.vnxcommerce.com` (Docker + HTTPS tự động).
- `CHECKLIST-DONG-BO-REALTIME.md` — đưa ERP vào vận hành và bật đồng bộ realtime, từng bước có cách kiểm.
- `GMAIL-BANG-KE-VTP.md` — tự lấy bảng kê COD Viettel Post từ Gmail bằng script chạy trong Gmail của shop.
- `API-PANCAKE-VIETTELPOST.md` — ghi chú kỹ thuật API Pancake POS và Viettel Post mà ERP đang dùng.
- `payroll-production-runbook.md` — sổ tay đưa module Lương lên production (câu "chưa thực thi" trong tệp là lúc viết).
- `TECH-2-agent-run-reconcile.md` — job `agent-run-reconcile`: đối chiếu lượt chạy agent trên GitHub với sổ ERP.
- `TECH-4-README.md` — cửa vào bộ đo chuẩn trang `/shipments`; đi cùng `TECH-4-benchmark-scenarios.md` (8 kịch bản), `TECH-4-metrics-definition.md` (chỉ số, công thức), `TECH-4-measurement-runbook.md` (cách chạy), `TECH-4-measurement-template.md` (biểu mẫu). **Chưa có kết quả đo nào**; số trong ví dụ là mẫu.
- `TECH-6-MEASUREMENT-GUIDE.md` — cách đo phía trình duyệt (TTFB, render bảng, payload) bằng công cụ sẵn có.
- `baselines/BASELINE-TEMPLATE.json` — khuôn ghi số đo nền.

---

## (c) Trạng thái hiện hành theo miền

Mỗi miền MỘT tệp sống. Mở tệp mới cho cùng miền là cách tạo ra hai sự thật.

- `department-module-map.md` — module thuộc phòng nào và thang tự động hoá AI của từng phòng (nguồn sống: `lib/constants/department-ai.ts`, trang `/departments`).
- `tech-ai-room-status.md` — Phòng Tech AI: dây chuyền agent, cổng, việc chờ chủ shop (ghi cuối 22/09, có ghi chú 24/09).
- `marketing-ai-department.md` — Phòng Marketing AI: năm nấc và nấc nào đã có.
- `creative-loop.md` — vòng mẫu quảng cáo (Nấc 4): đã dựng, chờ chủ shop các việc ở §7.
- `vtp-capability-matrix.md` — Viettel Post làm được gì cho care; API đọc đơn trả rỗng, nguyên nhân chưa biết (đo lại 23/09).
- `navigation-review.md` — rà soát điều hướng: Đ1 đã làm, Đ2 chờ đo lượt dùng, Đ3 giữ nguyên.
- `perf/TRANG-THAI.md` — hiệu năng theo trang: đã vá gì, còn gì, số đo ở đâu.
- `daily-operating-system-progress.md` — sổ theo dõi hệ vận hành theo ngày (ghi cuối 10/09 — kiểm lại trước khi dùng).
- `ads-attribution-coverage.md` — độ phủ quy kết quảng cáo: đo, sửa, trần thật (ghi 09/09 — kiểm lại trước khi dùng).

---

## (d) Lịch sử — đọc làm bối cảnh, không làm căn cứ

Tệp nào dễ bị đọc nhầm là hiện hành đã mang dòng đầu *"Tài liệu lịch sử — trạng thái hiện hành xem
`docs/README.md`"*. Nội dung không bị viết lại: nó là biên bản của điều người ta đo và tin vào lúc
đó.

### Báo cáo phiên làm việc (`claude-*`, 08–12/09)

`claude-4h-progress.md` · `claude-4h-final-report.md` · `claude-next-progress.md` ·
`claude-next-final-report.md` · `claude-final-erp-report.md` · `claude-release-progress.md` ·
`claude-post-v2-progress.md` · `claude-post-v2-final-report.md` ·
`claude-operationalization-final-report.md` · `claude-single-session-final-report.md`

### Biên bản phát hành (`release-*`, 11–19/09)

`release-2026-09-11-integration.md` · `release-2026-09-12-access-model.md` ·
`release-2026-09-12-cskh-workqueue.md` · `release-2026-09-12-finance.md` ·
`release-2026-09-12-integration.md` · `release-2026-09-12-integration-round2.md` ·
`release-2026-09-12-work-os.md` · `release-2026-09-12-work-os-operationalization.md` ·
`release-2026-09-12-workforce-v2.md` · `release-2026-09-13-attribution.md` ·
`release-2026-09-13-audit.md` · `release-2026-09-13-cskh-returns-ops.md` ·
`release-2026-09-13-kpi-clarity.md` · `release-2026-09-13-ops-foundation-care.md` ·
`release-2026-09-13-p1-data-foundation.md` · `release-2026-09-14-cskh-copy-p1-closure.md` ·
`release-2026-09-14-cskh-workqueue-v2-semantic.md` · `release-2026-09-14-fanpage-attribution.md` ·
`release-2026-09-14-return-exception-queues.md` · `release-2026-09-14-return-intelligence-v3.md` ·
`release-2026-09-14-return-warehouse-kpi.md` · `release-2026-09-14-returns-station-filters.md` ·
`release-2026-09-14b-targets-and-reason-layers.md` · `release-2026-09-14c-payroll-truth.md` ·
`release-2026-09-15-payroll-carryover.md` · `release-2026-09-15b-payroll-policy-engine.md` ·
`release-2026-09-15c-payroll-usable.md` · `release-2026-09-16-vtp-source-of-truth.md` ·
`release-2026-09-18-care-persistence.md` · `release-2026-09-19-care-decision.md` ·
`release-2026-09-19-shipments-qa.md` · `release-integration-status.md` (09/09) ·
`release-build-transition.md` (kế hoạch 10/09 — đã thực hiện, xem dòng đầu tệp)

### Báo cáo ERP tổng (`erp-*`, 08–09/09)

`erp-data-truth-audit.md` · `erp-release-report.md` · `erp-next-release-report.md` ·
`erp-post-v2-release-report.md` · `erp-security-reliability.md`

### Hiệu năng — thay bằng `perf/TRANG-THAI.md`

`erp-perf-audit.md` (08/09, vòng 1 — kết luận "không nút thắt" đã bị bác) · `erp-perf-audit-round2.md` ·
`erp-performance-p0-report.md` · `erp-performance-p0-2-report.md` · `erp-performance-p0-3-report.md` ·
`erp-performance-p0-5-report.md` · `TECH-6-SUMMARY.md` · `TECH-6-FRONTEND-BASELINE.md` ·
`TECH-6-ARCHITECTURE-ANALYSIS.md` · `TECH-7-explain-analyze-findings.md` ·
`TECH-9-infrastructure-health-check-2026-09-23.md` · `TECH-10-improvement-spec.md` (phương án với %
cải thiện ƯỚC TÍNH)

**Số đo thô `perf/*`** — CHỨNG TỪ, không phải kết luận: giữ nguyên văn, trích được, nhưng mỗi số là
của đúng ngày và điều kiện ghi trong tệp. `perf/TECH-5-so-do-tho-2026-09-22.md` (+ `…-raw-….txt`) ·
`perf/TECH-6-TECH-9-so-do-tho-2026-09-23.md` (+ `perf/TECH-6-smoke-tho-2026-09-23.txt`) ·
`perf/JIT-bat-tat-2026-09-23.md` · `perf/*.json`, `perf/explain-before.txt`,
`perf/ads-decision-explain.txt` (bench PGlite 09–11/09).

### Kiểm toán và số đo production có ngày

`audit-metric-parity-2026-09-13.md` · `audit-vtp-source-of-truth-2026-09-16.md` ·
`ads-attribution-audit.md` · `ads-measurement-audit-2026-09-22.md` ·
`do-production-2026-09-13-care.md` · `data-quality-p05-report.md` ·
`measured-daily-operating-system-report.md` · `smart-logistics-freshness-report.md` ·
`order-report-grain-audit.md` · `order-shipment-1n-migration-audit.md` ·
`payroll-production-reconciliation-2026-09-15.md` · `migration-inventory-final.md` (số migration
trong tệp đã cũ — đọc `drizzle/meta/_journal.json`) · `TECH-8-SHIPMENT-OUTCOME-AUDIT.md` ·
`GUARDRAILS.md` · `fable-5-1-review-final.md`

### Phòng Tech AI theo từng nấc (18–22/09)

`ai-tech-department-phase1.md` · `ai-tech-phase2a.md` · `ai-tech-phase2a-verify.md` ·
`ai-tech-phase2b.md` · `ai-tech-nac0-agent-thuc-te.md` · `ai-tech-nac1-cua-hep-chep-so.md` ·
`ai-tech-nac2-bo-sung-hang-rao.md` · `agent-identity-proof-evidence.md` ·
`proof/gate-deadlock-2026-09-19.md` · `TECH-3-test-note.md` — trạng thái gộp ở `tech-ai-room-status.md`.

### Bàn giao, lộ trình, phiên song song (05–12/09)

`LO-TRINH-HOAN-THIEN.md` (05/09) · `roadmap-session-0909.md` · `session-3-handoff.md` ·
`single-session-takeover-inventory.md` · `safe-release-review.md` · `handoff-care-engine.md` ·
`handoff-ai-copilot.md` · `phase-3-outcome-performance-kickoff.md`

### Tệp không phải tài liệu

`screenshots/*.png` — ảnh chụp màn hình cũ (tổng quan, đơn hàng, vận đơn, COD, lợi nhuận, tồn kho, kết nối); hiện không tệp nào trỏ tới.
