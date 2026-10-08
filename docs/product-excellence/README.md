# Product Excellence — mục lục và chu kỳ review

*Sứ mệnh `product-excellence-baseline` · R0 (chỉ tài liệu) · lập 08/10/2026 trên `origin/main` `36b7791b`. Thư mục này trả lời
một câu: **Chốt Đơn Tự Động đang tốt tới đâu với chủ shop, và việc gì đáng làm tiếp nhất** — bằng bằng chứng, không bằng cảm giác.*

## 1. Tệp

| Tệp | Trả lời câu gì | Sửa thế nào |
|---|---|---|
| `SCORECARD_2026-10-08.md` | 16 chiều chấm 0–100 hay `UNKNOWN`, kèm bằng chứng và chỉ số nên theo dõi. Lần đầu: **36/100, phủ 11/16** | BẤT BIẾN — lần chấm sau là tệp mới |
| `FRICTION_MAP.md` | 20 bước DISCOVER → REFER, mỗi bước: ma sát · nhầm lẫn · chữ kỹ thuật · lỗi · độ trễ · thiếu hướng dẫn · tin cậy | sửa tại chỗ, ghi ngày |
| `TIME_TO_VALUE.md` | Chuỗi mốc signup → đơn thành công: nguồn thật, giới hạn, 11 câu SQL chỉ đọc cho CSDL nhà, công cụ cần cho CSDL tổ chức | sửa tại chỗ khi mốc / nguồn đổi |
| `OPPORTUNITY_BACKLOG.md` | 29 cơ hội xếp theo luật R, mỗi cơ hội có bằng chứng, KPI, công sức, rủi ro, sứ mệnh liên quan | sửa tại chỗ mỗi chu kỳ |
| `TOP5_2026-10-08.md` | 5 cơ hội ROI cao nhất + DAG + tiêu chí làm giàu cho sứ mệnh đang chạy + thiết kế ô trên `/tech` | BẤT BIẾN — chu kỳ sau là tệp mới |

Nguồn dùng lại (không viết lại): `docs/saas/{SHELL_AUDIT_2026-10-08,INBOX_V2,ORDER_CANDIDATE,HELP_CENTER,OVERAGE,RISK_SCALE,AI_COST_WORKLOAD,PRICING_V1,IDENTITY}.md`,
`docs/saas/auditor/DESIGN.md`, `docs/revenue-os/MASTER_MISSION_STATUS.md`, `docs/productization/*`, bộ đo đơn vàng v2
(`tests/order-golden/BASELINE.md` trên nhánh `feat/order-golden-v2`).

## 2. Bốn luật của thư mục này

1. **Chưa đo thì `UNKNOWN`**, kèm «cần đo gì, ở đâu». Không có điểm, tỷ lệ hay ROI ước bằng tay (AGENTS 42, 8.5–8.6).
2. **Điểm tổng luôn đi kèm độ phủ.** Hai lần chấm khác độ phủ không so được trực tiếp; lần chấm sau in cả tổng trên đúng tập chiều cũ.
3. **Đích kinh doanh là của chủ shop** (AGENTS 3.38). Ở đây chỉ đặt đích kỹ thuật: bất biến = 0, số trên bộ đo có nhãn, thời gian dựng trang.
4. **Việc đã có sứ mệnh thì không nhân đôi** — chỉ làm giàu tiêu chí nghiệm thu của sứ mệnh đó.

## 3. Chu kỳ review (W)

Chu kỳ gắn vào Continuous SaaS Auditor (`docs/saas/auditor/DESIGN.md` §2 LEARN, §4 nhịp tuần). Không lịch mới, không control plane
thứ hai: thêm lịch scheduler là việc phải hỏi chủ shop (AGENTS §7).

| Nhịp | Ai | Làm gì | Đầu ra |
|---|---|---|---|
| **Tuần** — cùng lượt bản tin TUẦN của Auditor (khoá `audit:last-weekly:<tuần ISO>`) | Integration Lead | Chạy `TIME_TO_VALUE.md` Q5 trước, rồi Q1–Q4, Q9–Q11 qua `db-query`; cập nhật cột «Trạng thái» của `OPPORTUNITY_BACKLOG.md` và `TOP5` hiện hành. KHÔNG chấm lại điểm | một dòng tóm tắt (chỉ số đếm) trong bản tin tuần; PR R0 sửa backlog |
| **Tháng** — hoặc ngay khi một mục Top 5 lên production | worker R0 | Chấm lại 16 chiều thành `SCORECARD_<ngày>.md` mới; chiều `UNKNOWN` chỉ được chấm khi có số đo ở mục «cần đo» của nó; dựng `TOP5_<ngày>.md` mới; sửa `FRICTION_MAP.md` tại chỗ | PR R0; cập nhật hằng của ô `/tech` (`TOP5` §4) |
| **Đột xuất** — Auditor mở sự cố SEV0 / SEV1, hoặc một sự cố production chạm khách (như bot im 06/10) | Integration Lead | Thêm hoặc nâng mức một thẻ trong backlog trong vòng 24 giờ, kèm bằng chứng; KHÔNG đổi điểm của scorecard đã chấm | PR R0 |

Nguồn cho bước LEARN của Auditor: số thẻ backlog mở / đóng mỗi chu kỳ, thời gian từ lúc vào backlog tới lúc lên production, thẻ bị
đánh «không phải vấn đề» kèm lý do.

## 4. Phép kiểm Auditor đề xuất thêm (chỉ đọc, CSDL nhà)

Nối tiếp danh mục A1–A18 của `docs/saas/auditor/DESIGN.md` §3; cùng bảy luật nền ở §1 của tài liệu đó.

| Mã | Phép kiểm | Nguồn | Ngưỡng | Mức | Phòng | Nhịp |
|---|---|---|---|---|---|---|
| A19 | Workspace tự đăng ký không có thuê bao sống | `platform_organizations` + `platform_accounts` + `platform_product_subscriptions` (`TIME_TO_VALUE.md` Q11) | **0** (bất biến) | SEV1 | Tech + FINANCE | ngày |
| A20 | Kích hoạt kẹt: workspace `ACTIVE` quá ⚑ ngày chưa có `CHANNEL_CONNECTED` / `FIRST_AI_REPLY` | `platform_org_milestones` (Q2) | ⚑ chủ shop đặt — chưa đặt thì in thực tế, không kết luận | SEV3 | SALES (hỗ trợ khách) | ngày |
| A21 | Sổ mốc kích hoạt cũ | `max(observed_at)` của `platform_org_milestones` (Q5) | 24 giờ — ngưỡng KỸ THUẬT = 4 lần nhịp chụp 6 giờ của job `alerts` (`11_SAAS_METRICS_SPEC.md` §1), không phải đích kinh doanh | SEV3 — và A20 in `CHƯA ĐO ĐƯỢC` | Tech | ngày |

Làm ở PR AU-2 (danh mục + hàm thuần) và AU-3 (OBSERVE) của Auditor, không tách sứ mệnh riêng.

## 5. Giới hạn của lần lập đầu

- Phụ lục gốc (20 bước, luật R, chu kỳ W) không có trong kho mã; ba thứ đó được dựng lại từ mô tả của sứ mệnh và từ tài liệu sẵn có.
  Nếu phụ lục khác, sửa tên / ngưỡng ở đây, giữ cấu trúc.
- Số đo production trong các tệp là số Integration Lead cung cấp ngày 08/10. Người lập tài liệu KHÔNG chạy truy vấn production nào.
- Số đo trên bản build cục bộ (`SHELL_AUDIT`, `INBOX_V2`) dùng dữ liệu giả; số ms cục bộ không bao giờ được dùng làm số hiệu năng.
