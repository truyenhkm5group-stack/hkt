# Tự động hoá không tốn credit AI

Cập nhật 25/09/2026. Mọi thứ dưới đây chạy bằng SQL + luật + bộ lập lịch + tin Lark trên VPS sẵn có —
chi phí thêm ≈ 0 ₫. AI chỉ còn ở chỗ PHẢI đọc hiểu chữ tự do, và chỗ đó nay không trả tiền hai lần
cho cùng một câu hỏi.

## 1. `cs-chat` không hỏi model lại khi hội thoại không đổi

**Trước:** job chạy 15 phút/lần trên cửa sổ 48 giờ và gửi model MỌI hội thoại có dấu hiệu ở MỌI
lượt — kể cả khi không có tin nhắn mới. Một hội thoại nằm trọn cửa sổ bị hỏi tới ~190 lần. Và các
lượt gọi ấy **không vào sổ `ai_interactions`**, nên phanh trần tiền ngày (`ai.tran-ngay-usd`) không
thấy chúng.

**Nay** (`lib/cs/semantic-cache.ts`, bảng `cs_semantic_verdicts`):

- Khoá = dấu vân tay của toàn bộ đầu vào model đọc (model · lời dặn · lược đồ · khách · thẻ · chứng
  từ · hội thoại). Khách nhắn thêm một câu, đơn vừa lên, thẻ đổi, đổi model ⇒ hỏi lại.
- Mỗi lượt gọi THẬT ghi một dòng `ai_interactions` route `cs.semantic` (không chép nội dung chat).
- Hỏi phanh trước mỗi lượt gọi: chạm trần ⇒ dừng, ứng viên bằng chữ không thành việc (như khi AI tắt),
  ứng viên "đủ SĐT + địa chỉ mà chưa có đơn" vẫn chạy vì nó không cần AI.
- Kết quả job có thêm `semanticCacheHits` (lượt dùng lại, 0 đồng) cạnh `semanticCalls` (lượt trả tiền)
  và `semanticBudgetBlocked`.

**Chưa đo trên production** — máy phát triển không có đường vào CSDL thật. Sau deploy, đo bằng ops
`db-query` (chỉ đọc, một câu mỗi lần):

```sql
select date_trunc('hour', created_at) as gio, count(*) as luot, sum(nullif(cost_usd,'')::numeric) as usd from ai_interactions where route = 'cs.semantic' and created_at > now() - interval '2 days' group by 1 order by 1;
```

```sql
select count(*) as ket_luan, sum(hits) as lan_dung_lai from cs_semantic_verdicts;
```

`lan_dung_lai` chia `ket_luan + lan_dung_lai` là tỷ lệ lượt KHÔNG phải trả tiền.

## 2. Ba việc máy tự nhắc (phép chiếu — tự đóng khi hết điều kiện)

Luật và các mốc ở `lib/constants/feed-freshness.ts`; phát hiện ở `lib/alerts/rules.ts`. Bật/tắt từng
loại ở trang **Cảnh báo**. Không có nút "đánh dấu xong": việc rời hàng đợi khi điều kiện sinh ra nó hết.

| Loại | Khi nào nhắc | Phòng | Tự đóng khi |
|---|---|---|---|
| `VTP_ORDER_LIST_DUE` | Từ 10 giờ sáng, tệp Danh sách vận đơn chưa nhập trong 24 giờ (hoặc chưa từng) | Giao vận | Có lượt nhập (APPLY) mới |
| `COD_STATEMENT_MISSING` | Sao kê có chuyển khoản COD (nhóm `COD_SETTLEMENT`) quá 24 giờ mà không có bảng kê khớp | Kế toán | Có tệp bảng kê khớp số (đã ghép hoặc script Gmail đã gửi sang), hoặc đợt cùng số tiền ±3 ngày, hoặc đã nối tay |
| `STATEMENT_MAIL_SILENT` | Script Gmail bảng kê không liên lạc quá 2 giờ | Kế toán | Script liên lạc lại |

Vì sao cần: webhook Viettel Post **không bao giờ** đẩy "lấy hàng thất bại" (đo 21/09: 0 dòng / 4.700
lần ghi nhận), và thiếu bảng kê làm cả đợt tiền hiện "quá hạn chưa trả" (đo 24/09: 4 đợt ~55 triệu
có trong sao kê mà không có tệp).

## 3. Bản tin sáng cho nhóm Quản lý (`morning-brief`)

Chép màn hình `/work/today` vào Lark mỗi sáng từ 7 giờ: ba việc đáng làm nhất (mỗi phòng một việc),
tổng việc mở / quá hạn / chưa ai nhận / bị chặn, tiền đang treo (kèm số việc CHƯA tra được tiền),
phòng chưa có người, nguồn việc đọc hỏng. Không dùng AI, không có phép tính mới.

**Để bật:** trang **Cảnh báo** → dán webhook Custom Bot của nhóm Quản lý vào ô *"Webhook nhóm Quản lý /
chủ shop nhận bản tin sáng"* → **Lưu cấu hình cảnh báo**. Chưa khai thì KHÔNG gửi (không lùi về nhóm
vận đơn). Gửi thử ngay: trang Kết nối dữ liệu → job `morning-brief` với `force=1`.

## 4. Sửa kèm: lưu cấu hình cảnh báo không còn xoá khoá bí mật

Trang Cảnh báo xoá trắng token Telegram và khoá ký Lark trước khi gửi xuống trình duyệt, nhưng lượt
lưu chỉ giữ lại khoá nhóm Kho — nên mỗi lần bấm Lưu mà không gõ lại, token Telegram và khoá ký Lark
chính bị ghi đè thành rỗng; khoá nhóm thanh toán thì bị gửi nguyên văn xuống trình duyệt. Nay mọi
khoá bí mật: không xuống trình duyệt, ô trống = giữ nguyên.

## 5. "Cần anh quyết" vào nhóm Quản lý (Company OS · L — chạy trong job `alerts`)

Không thêm lịch mới: `evaluateAlerts` gọi `runOwnerDecisionDigest()` ở cuối lượt. Khi nào gửi do hàm
thuần `decideOwnerDecisionDigest` (`lib/constants/owner-digest.ts`) quyết:

- **Bản sáng** — lượt đầu tiên từ 7 giờ (giờ VN, cùng giờ bản tin sáng) mỗi ngày, nếu hàng đợi còn dòng:
  số việc theo loại, vài dòng đầu (CÁI GÌ + một ô số liệu), link mở `/cockpit`. Rỗng ⇒ không gửi.
- **Tin thêm trong ngày** — CHỈ khi có yêu cầu duyệt / mẫu chờ duyệt MỚI (khoá nguồn chưa báo hôm nay),
  cách tin trước ≥ 30 phút, trước 22 giờ. Quảng cáo / tồn kho nhúc nhích không kích tin.
- Dòng đã **Bỏ qua** / đang **Hẹn nhắc** không vào tin. Tin không in số tiền, không email, không webhook.
- Người xem là tài khoản MÁY mang bộ quyền mẫu của vai trò **MANAGER** — loại nào Quản lý không mở được
  màn hình chủ thì không vào tin.
- Sổ chống gửi lại `settings["owner.digest.sent"]` ghi bằng so-sánh-rồi-đổi: hai lượt `alerts` song song
  chỉ gửi một tin; gửi hỏng không ghi sổ, lượt sau thử lại.

**Để bật (mặc định TẮT):** trang **Cảnh báo** → khung cấu hình → ô *"Gửi “Cần anh quyết” vào nhóm Quản
lý"* (lưu NGAY khi bấm, ghi nhật ký `SETTINGS_UPDATE owner.digest`). Cần webhook nhóm Quản lý đã lưu —
không lùi về nhóm vận đơn.
