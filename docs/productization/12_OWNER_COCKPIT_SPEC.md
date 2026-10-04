# 12 · Owner Cockpit — `/platform/saas`

> Màn nội bộ của chủ nền tảng. Chỉ người của **tổ chức nhà** có `platform:operate` (trang + lõi `loadOwnerCockpit`
> đều hỏi `platformOperatorDenial` trước mọi lượt đọc — S21 của `tests/platform-isolation-static.test.ts`).
> Lối vào: nút "Kinh tế nền tảng" trên `/platform`. Định nghĩa từng con số: `11_SAAS_METRICS_SPEC.md`.

## Bố cục

1. **Hàng số** — MRR (+ARR) · Khách trả tiền (/ tổng, ARPA) · Net New MRR tháng · Rời bỏ tháng · NRR tháng (+GRR) ·
   Biên gộp (chưa khai hạ tầng ⇒ "—" và "chỉ trừ AI: x%") · Chi phí AI 30 ngày nền tảng trả.
2. **Vòng đời** — đếm theo `TENANT_LIFECYCLES`.
3. **Biến động MRR** — tháng này (tới hôm nay) và tháng trước, cầu nối đầu kỳ → cuối kỳ, GRR · NRR · logo churn,
   câu cảnh báo khi sổ bắt đầu giữa kỳ hoặc có tổ chức chưa biết; dòng "tổ chức: biến động".
4. **Biên lợi nhuận nền tảng** — bảng doanh thu · AI · hạ tầng · hỗ trợ; form khai chi phí (bắt buộc căn cứ, vào
   nhật ký nền tảng `PLATFORM_COSTS_SET`). Ô trống = CHƯA KHAI, không phải 0.
5. **Kích hoạt · Time-to-Value** — phễu 7 mốc, "đã tới x/n", trung vị ngày từ lúc tạo; mốc chưa đo được in
   "Chưa đo được" kèm lý do khi rê chuột.
6. **Từng tổ chức** — gói · vòng đời · MRR · AI nền tảng trả · đóng góp (+%) · lượt AI · xu hướng · lỗi AI · kích hoạt
   (ngày tới kích hoạt, ngày tới đơn AI đầu) · đăng nhập cuối · hội thoại / bot / đơn AI 30 ngày kèm chuỗi 4 tuần (tuần chưa
   có ngày nào trong sổ là «—») và xu hướng tuần này so tuần trước (dưới 10 hội thoại ⇒ «—»). Tên tổ chức dẫn sang `/platform/org/<mã>` (chẩn đoán,
   thu phí, sổ AI của tổ chức đó — đã có).

## Quyền riêng tư

Cockpit chỉ mang **mã tổ chức, số tiền, số đếm, mốc thời gian**. Không mang nội dung hội thoại, tên / SĐT khách, email
người dùng của khách, khoá. Bài kiểm khẳng định chuỗi nhận diện hội thoại gieo trong CSDL khách không xuất hiện trong
kết quả.

## Chi phí vận hành của màn

Mở trang ⇒ nếu ảnh chụp hôm nay cũ hơn 30 phút thì chụp lại (đọc sổ tổ chức + mở CSDL của từng tổ chức khách ACTIVE
để tìm mốc **còn thiếu**; tổ chức đã đủ mốc không bị mở). Ở quy mô hàng trăm tổ chức, lượt quét mốc phải chuyển
hẳn sang job nền theo lô — ghi ở `docs/platform/scale-plan.md` khi tới ngưỡng.

## Câu hỏi của chủ nền tảng → ô trả lời

| Câu hỏi | Ô |
|---|---|
| Có bao nhiêu tenant? bao nhiêu trả tiền? | Hàng số · Vòng đời |
| MRR / ARR? | Hàng số |
| Churn / Expansion / NRR? | Biến động MRR |
| Gross margin / contribution margin? | Biên lợi nhuận nền tảng (cần khai hạ tầng + hỗ trợ) |
| LLM cost? theo tenant? | Hàng số · cột "AI nền tảng trả" |
| Contribution margin từng tenant? | Cột "Đóng góp" (chưa phân bổ hạ tầng) |
| Khách nào đang làm SaaS mất tiền? | Cột "Đóng góp" âm tô đỏ |
| Khách nào healthy / có nguy cơ? | Tín hiệu rời: đăng nhập cuối, xu hướng AI, xu hướng hội thoại 4 tuần, lỗi AI, kích hoạt — **không có điểm tổng** |
| Khách nào dùng AI hiệu quả nhất? | Lượt AI + đơn AI đầu tiên ở đây; hiệu quả bán hàng thật (đơn giao, doanh thu) nằm ở màn «Hiệu quả» của từng tổ chức (#522) |
| Time to first value? | Kích hoạt · Time-to-Value |
