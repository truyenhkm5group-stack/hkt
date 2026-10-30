# Mission Control — đo các AI agent đang có

> Chủ shop đồng ý 30/10/2026. Trang: `/departments/mission-control` (trang con của «Bản đồ phòng ban & AI», không chiếm mục
> menu). Quyền xem: `approvals:decide`. Quyền khai điều kiện tốt nghiệp: `settings:manage`. Không thêm khoá quyền mới.

## Một sổ agent

Danh sách agent là `AGENTS` của `lib/constants/department-ai.ts`, không có danh sách thứ hai. `lib/constants/mission-control.ts`
chỉ khai cách đo cho từng khoá của sổ ấy (`MC_MEASURES: Record<AgentZone, …>`): thiếu hay thừa một khoá là lỗi biên dịch, và bài
kiểm so khoá với `AGENT_ZONES`.

## Mỗi agent đo gì

| Cột | Nguồn | Chưa đo được khi |
|---|---|---|
| Nấc tự chủ | `AGENTS[zone].autonomy` | luôn đọc được |
| Lượt · chi phí AI (7 / 30 ngày) | `aiUsageDaily` — sổ `platform_ai_usage`, lọc theo mã tổ chức đang đăng nhập | agent chạy bằng luật ⇒ «không dùng mô hình AI» (không áp dụng, khác «chưa đo») |
| Việc máy mở | `collectWorkItems` (đúng phép chiếu của `/work`), `creationSource = AUTO`, phòng của agent | hàng đợi đang thiếu một phần ⇒ in cảnh báo |
| Người duyệt / bác | bot bán hàng: quy kết đơn của màn Hiệu quả (`attributedOrderFacts`) — huỷ = bác · đề xuất buồng lái: `recommendation_decisions`, phản ứng mới nhất, «nhắc lại sau» ngoài mẫu · Tech: PR của việc agent cầm, gộp = đúng | phòng chưa có nguồn ghi phản ứng của người ⇒ «chưa đo được» + thiếu gì |
| Kết quả tiền thật | bot bán hàng: đơn «AI tự bán» + «AI góp công» giao thành công (ORDER_OUTCOME) + `VERIFIED_CASH`; chưa có chứng từ ⇒ «—» | mọi phòng khác ⇒ «chưa đo được» + thiếu gì |

## Điều kiện «tốt nghiệp»

`settings["missionControl.graduation"] = { <zone>: { minAccuracyPct, minSamples, windowDays } }`.

- Không có bộ mặc định (luật 38/43). Chưa khai thì trang hiện số thực tế và không kết luận gì.
- Khai rồi, trang chỉ kết luận «đủ / chưa đủ điều kiện» khi đo được tỷ lệ đúng và đủ mẫu trong cửa sổ đã khai. Thiếu mẫu ⇒ «chưa
  đủ mẫu». Không có nguồn đo ⇒ «chưa đo được».
- Trang không bao giờ đổi nấc tự chủ. Đổi nấc là quyết định của chủ shop: sửa sổ `department-ai` rồi triển khai lại (luật 69).

## Việc còn lại

- Ghi phản ứng của người với tool ghi của Copilot (đồng ý / huỷ) để đo được Ban điều hành.
- Lý do «mở nhầm» khi đóng ca care, để đo được tỷ lệ bác của care máy mở.
- Lượt sửa đơn bot lên (sự kiện riêng), để phần «sửa» của bot bán hàng không còn «chưa đo được».
- Sổ chi phí cho agent Phòng Tech: nó chạy ngoài ERP, nên không ghi vào `platform_ai_usage`.
