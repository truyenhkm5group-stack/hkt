# Kiểm tra ranh giới tạo đơn — báo cáo trước khi cấp quyền lên đơn cho nhân sự AI

> Kết luận ngắn: **đơn nháp tạo được bằng máy; CHỐT đơn thì không.** Pancake POS không có API sửa
> đơn, nên mọi luồng "máy tự chốt" đều dừng ở chỗ này — không phải giới hạn của ERP.
>
> Ở giai đoạn này nhân sự AI **không** được cấp quyền lên đơn. Tài liệu này là căn cứ để quyết định
> sau, không phải đề nghị bật.

## 1. Đơn nháp hiện sinh ra từ đâu

Có đúng **ba** đường tạo đơn trên Pancake POS trong ERP, và cả ba đều gọi cùng một hàm
`PancakeClient.createOrder()` (`lib/integrations/pancake/client.ts`):

| # | Đường | Tệp | Ai bấm |
|---|---|---|---|
| 1 | Đơn landing page → POS (lẻ) | `lib/landing/pos.ts::pushLandingToPos` | Nhân viên bấm trên trang Đơn landing page |
| 2 | Đơn landing page → POS (hàng loạt) | `lib/landing/pos.ts::pushAllReadyLanding` | Job `landing-push` hoặc nút gửi hàng loạt |
| 3 | Công cụ nhân sự AI | `lib/ai/tools/erp.ts::orderCreateDraftTool` | **Bị chặn ở nấc SHADOW** |

Đường 3 dùng lại đúng client của đường 1–2, nên không có "kiến trúc đơn hàng thứ hai".

## 2. API Pancake thật sự có gì

| Việc | Có API? | Ghi chú |
|---|---|---|
| Tạo đơn | **Có** | `POST /shops/{shop}/orders`, `status: 0` = *Mới* (đơn nháp) |
| Đọc đơn | Có | `GET /shops/{shop}/orders`, `GET /shops/{shop}/orders/{id}` |
| **Sửa / chốt đơn** | **KHÔNG** | Không có endpoint update-order. Ghi rõ ở AGENTS.md §3.11 |
| Huỷ đơn | KHÔNG | Cùng lý do |
| Đọc / gửi tin nhắn | Có | Pages API — khác hệ với POS |

Hệ quả trực tiếp: `order.confirm` của nhân sự AI **chỉ ghi được trong ERP**. Công cụ trả
`posUpdated: false` kèm lý do, và nhân viên vẫn phải bấm chốt trên POS. Đó là hành vi trung thực,
không phải một chỗ chưa làm xong.

## 3. Trường bắt buộc để tạo được một đơn

Lấy từ chính `createOrder()` và các chốt chặn của `pushLandingToPos`:

| Trường | Bắt buộc | Kiểm ở đâu |
|---|---|---|
| `bill_full_name` | có | Tên khách, rỗng thì điền `Khách <SĐT>` |
| `bill_phone_number` | có | `normalizePhone()` phải ra `0` + 9 số |
| `shipping_address` | có | `addressIssue()` — phải thấy được tên tỉnh/thành |
| `items[].variation_id` | có | Mẫu mã phải tồn tại, không ẩn, không xoá |
| `items[].quantity` | có | ≥ 1 |
| `items[].retail_price` | nên có | **MÁY CHỦ tính**, không nhận từ tham số |
| `shipping_fee` | nên có | `landingShippingFee()` — 1 sản phẩm chịu ship, ≥ 2 free |
| `warehouse_id` | tuỳ chọn | Từ `landing.config` |
| `status` | có | Luôn `0` (Mới) — không bao giờ tạo đơn đã chốt |

Nhân sự AI đòi thêm một điều kiện thứ bảy mà hai đường landing không có: **xác nhận có ngữ cảnh của
khách** (`confirmationEvidence`). Đường landing không cần vì ở đó khách đã điền form.

## 4. Việc gì tự động hoá được, việc gì không

**Tự động hoá được** (khi chủ shop cho phép):
- Tạo đơn nháp trạng thái *Mới* với giá do máy chủ tính.
- Chống đơn trùng: hội thoại đã có `order_id` thì công cụ trả `duplicate`, không tạo đơn thứ hai.
- Ghi lại bằng chứng xác nhận của khách để đối chiếu về sau.

**KHÔNG tự động hoá được:**
- Chốt đơn trên POS (không có API).
- Huỷ / sửa đơn đã tạo (không có API).
- Tạo vận đơn Viettel Post (đi qua Pancake, không qua ERP).
- Sửa giá, sửa tồn, đụng COD — **không có công cụ nào làm được**, và kiểm thử quét sổ đăng ký để
  giữ nguyên điều đó.

## 5. Rủi ro nếu bật quyền lên đơn

| Rủi ro | Mức | Chốt chặn đã có |
|---|---|---|
| Đơn ma từ một chữ "ok" | **Cao** | Xác nhận có ngữ cảnh: sáu điều kiện, vân tay đơn, hạn 24 giờ |
| Đơn trùng khi webhook gửi lại | Cao | `order_id` trên hội thoại + chống trùng tin nhắn hai lớp |
| Sai mẫu mã (nhầm size/màu) | Cao | Chỉ khoá mẫu mã khi khớp ĐÚNG MỘT; hai ứng viên bằng điểm ⇒ hỏi lại |
| Sai giá | Trung bình | Giá do máy chủ tính; câu mô hình nhắc số lạ bị vứt |
| Sai địa chỉ ⇒ hoàn hàng | Trung bình | `addressIssue()` chặn trước khi gửi POS |
| Bán mẫu đã hết | Trung bình | Tồn đã biết = 0 ⇒ không đẩy tới chốt đơn |
| Tồn chưa biết mà hứa còn hàng | Trung bình | Chưa có phiếu nhập ⇒ không hứa |
| **Khách đổi ý sau khi máy đã lên đơn** | **Chưa có chốt chặn** | Không huỷ được qua API — phải làm tay trên POS |

Rủi ro cuối là lý do chính để **chưa** bật: một đơn máy tạo nhầm chỉ sửa được bằng tay trên POS.

## 6. Đề nghị thứ tự mở quyền (khi chủ shop quyết)

1. Chạy ngầm cho tới khi số liệu chấm tay đủ để tin: **độ phủ ≥ 100 lượt**, nhận đúng sản phẩm /
   size / SĐT / địa chỉ đều ≥ 95%, **0 lượt bị chấm là bịa hoặc phá luật**.
2. Nâng `sales` lên `COPILOT` — máy soạn, người bấm gửi. Vẫn chưa lên đơn.
3. Chỉ sau khi COPILOT chạy ổn mới bàn tới quyền `order.create_draft`, và nên giới hạn: một mã
   hàng, một page, có hạn mức số đơn mỗi ngày.
4. `order.confirm` không có gì để mở — Pancake không có API.

Không bước nào ở trên được làm mà thiếu quyết định tường minh của chủ shop.
