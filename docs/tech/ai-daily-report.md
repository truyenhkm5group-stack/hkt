# Báo cáo CEO hằng ngày

> Lộ trình đã được chủ shop duyệt (30/10/2026): agent rủi ro thấp nhất, CHỈ ĐỌC. Trang `/daily-report` (Ban điều hành, khai trong
> `lib/constants/department-modules.ts`). Quyền xem: `approvals:decide`. Quyền cấu hình: `settings:manage`. Mặc định TẮT.

## Luồng một lượt (`lib/daily-report/service.ts::runDailyReport`)

1. Chạy ké job `work-recurrence` (15 phút/lần, mọi tổ chức), không thêm lịch mới. Bỏ qua khi một trong các điều kiện sau đúng:
   - `settings["dailyReport.config"]` đang tắt;
   - chưa tới giờ VN đã khai;
   - bản của hôm qua đã có;
   - CSDL chưa áp 0266. Lượt bỏ qua trước khi gom số, nên không tốn tiền AI.
2. **Máy gom số** của ngày D (hôm qua) bằng các hàm báo cáo đang chạy, không viết công thức mới:

   | Khối | Hàm |
   |---|---|
   | Đơn tạo trong ngày · giao thành công · hoàn · tiền có chứng từ · tỷ lệ giao thành công 7 ngày | `dataQualitySummary` (ORDER_OUTCOME + VERIFIED_CASH) |
   | Chi quảng cáo | `adSpendTotal` |
   | Care vận đơn (quá hạn · chưa ai nhận · tiền treo) | `getCareQueue` |
   | Việc trên /work (mở · quá hạn · chưa ai nhận) | `getManagerDay` |
   | Bán sỉ (module bật): lead mới · có email · thư chờ gửi · báo giá chưa chốt | `wholesaleDashboard` · `wholesaleEmailCoverage` · `outboxCounts` · `quotationOpenCount` (hàm đếm không nhận phiên) |
   | Facebook CRM (cờ bật): đã kết bạn · tới hẹn | `fbCrmOverview` · `fbCrmDueCare` |

   Khối nào lỗi thì số của khối đó là `null` (in «—», kèm lý do). Không in 0, và không làm hỏng cả bản.
3. **AI chỉ viết lời.** Đầu ra là JSON `{summary, highlights[3]}`, AI lấy qua `getBuilderAi`. Lời gọi bị chặn khi:
   - chưa khai trần chi phí / ngày;
   - đã chạm trần (đọc từ `aiUsageDaily`, feature `daily_report`);
   - hạn mức của tổ chức chặn.

   Mỗi lần gọi AI ghi một dòng `platform_ai_usage` (feature `daily_report`, hệ thống AI-10 trong `lib/constants/ai-systems.ts`).
4. **Hàng rào số** (`numbersNotInFacts`): mọi con số trong lời AI (số đếm, tiền, %) phải có trong khối số. Tiền được đọc bằng
   `extractVndAmounts` + `unverifiedAmounts` của hàng rào khẳng định bot bán hàng. Có số bịa ⇒ `BLOCKED`, lời không được lưu, bản
   chỉ còn khối số.
5. **Lưu một dòng `daily_reports`**, bất biến: trigger CSDL chặn mọi UPDATE. Sau đó gửi tin vào nhóm báo vận hành đã cấu hình
   (`operationsGroupChannel` + `deliverMessage`, khoá chống gửi lại `daily-report:<ngày>`). Không thêm kênh mới. Chưa cấu hình nhóm ⇒
   chỉ lưu, không gửi.

## Việc còn lại

- Số «đơn giao thành công trong ngày» theo MỐC GIAO (không theo ngày tạo đơn) cần một hàm báo cáo theo mốc giao dùng chung. Hiện
  bản báo cáo theo ngày tạo đơn và ghi rõ điều đó trên nhãn.
- Nút «tạo lại bản hôm nay» cố ý không có: bản là bất biến.
