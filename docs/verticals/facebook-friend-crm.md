# Facebook Friend CRM — lát 1

> Chủ shop HSLC (`hslc-hmt-shop`) yêu cầu: chăm sóc khách đã nhắn fanpage / đã mua bằng **nick Facebook của shop**, ngay trong
> ERP, dựa trên Customer 360 + hội thoại + đơn hàng sẵn có. **Không** dựng một CRM độc lập.

## 1. Mục tiêu

Một danh sách duy nhất cho nhân viên chăm sóc: khách nào đáng kết bạn, đã đồng ý chưa, đã kết bạn chưa, ai phụ trách, hẹn chăm
sóc ngày nào — và mọi con số (đơn, giao thành công, doanh thu thực) lấy từ đúng nguồn sự thật của ERP.

Trang: `/customers/facebook-crm` (module Khách hàng). Lối vào: nút **Facebook CRM** trên `/customers`, chỉ hiện khi tổ chức bật cờ.

## 2. Giới hạn pháp lý / nền tảng — KHÔNG thương lượng

- ERP **không tự kết bạn**, **không tự nhắn tin từ nick cá nhân**, **không quét (scrape)** Facebook, **không dùng tài khoản
  Facebook cá nhân** (AGENTS §5). Mọi nút trên trang chỉ **ghi lại việc một người đã làm bằng tay**.
- **PSID ≠ trang cá nhân.** Mã trong hộp thư (`sales_chat_conversations.thread_id`, `customers.fb_id`) là mã **theo page**
  (`lib/sales-chatbot/avatar-profile.ts` → `FACEBOOK_ID_SOURCES`). `facebook.com/<PSID>` mở ra trang lỗi hoặc **sai người** — ERP
  không bao giờ dựng nó, và từ chối cả link người dán nếu link trỏ vào chính PSID của khách. `page_customer.global_id` chưa được
  chứng minh là mã công khai ⇒ không dùng.
- Chỉ đánh dấu «đã gửi lời mời» **sau khi khách đồng ý**. Khách «không liên hệ» (bắt buộc ghi lý do) thì không ghi được đồng ý /
  lời mời / đã kết bạn / ngày chăm sóc / nhiệm vụ — chỉ người gỡ cờ mới mở lại.

## 3. Dữ liệu

Migration `0262_customer_fb_connections` (CSDL **của tổ chức** — tổ chức này không bao giờ thấy khách của tổ chức khác):

| Bảng | Nội dung |
|---|---|
| `customer_fb_connections` | MỘT dòng / khách (`customer_id` UNIQUE): `fb_profile_url` (dạng chuẩn `https://www.facebook.com/…`), `fb_url_source` (`CUSTOMER_PROVIDED` · `STAFF_VERIFIED_FROM_PANCAKE` · `NONE`), người dán + lúc dán (`users.id`), `connection_status` (`NOT_ASKED` · `CONSENTED` · `INVITE_SENT` · `FRIENDS` · `DECLINED`), `care_owner_user_id`, `next_care_on`, `do_not_contact` + lý do. CHECK: có link ⇔ nguồn khác `NONE`; không liên hệ ⇒ có lý do. |
| `customer_fb_connection_events` | Nhật ký CHỈ THÊM: `URL_SET` · `URL_CLEARED` · `STATUS_CHANGED` · `CONSENT_RECORDED` · `OWNER_CHANGED` · `NEXT_CARE_SET` · `DNC_SET` · `DNC_CLEARED`, kèm từ → tới, ghi chú, `actor_id` (`users.id`, luật 34; `NULL` = máy). |

Cờ tổ chức: `settings["fbCrm.enabled"] = {"on": true}` (object — chuỗi trần / `true` trần đều đọc là TẮT). Mặc định TẮT.

Các con số trên trang — **không** tính lại theo kiểu riêng:

| Cột | Nguồn |
|---|---|
| Danh sách | khách có ≥ 1 hội thoại (`sales_chat_conversations.customer_id`, trừ khung TEST) **hoặc** có đơn |
| Fanpage · hội thoại gần nhất | hội thoại hoạt động gần nhất + tên page (`fanpages.alias` / `name`) |
| Giao thành công | `ORDER_OUTCOME_FAST = 'DELIVERED'` trên lần gửi chính (`PRIMARY_ATTEMPT`) — đơn hoàn / huỷ không tính |
| Doanh thu thực | tổng `VERIFIED_CASH` (COD thực thu + chuyển khoản có ghi nhận) của đơn giao thành công. Chưa có chứng từ ⇒ **«—»**, không phải 0đ (luật 42) |
| Ảnh | ảnh có sẵn của hội thoại (Meta → Pancake → proxy ERP khi có hộp thư), cùng thứ tự với hộp thư |

Bộ lọc: từng nhắn fanpage · đã mua (≥ 1 giao thành công) · chưa mua · hỏi giá chưa đặt (`quote.given`, chưa đơn còn sống, chưa
hội thoại nào ở mức «Đã chốt đơn») · mua nhiều lần (≥ `REPEAT_BUYER_MIN_DELIVERED` = 2 giao thành công) · lâu chưa quay lại
(phân khúc `AT_RISK` ∪ `CHURNED` của `segmentOf`, trang Giữ chân khách) · đã đồng ý chờ kết bạn · đã kết bạn · chưa kết bạn ·
không liên hệ.

## 4. Cách dùng

1. Chủ shop bật cờ `fbCrm.enabled` = `{"on": true}` cho tổ chức.
2. Vào **Khách hàng → Facebook CRM**, chọn nhóm (vd «Mua nhiều lần»).
3. Có link Facebook ⇒ nút **Facebook** mở trang khách ở tab mới; nhân viên tự kết bạn / nhắn trên nick của shop.
   Chưa có link ⇒ nút **Pancake để bấm avatar** mở hội thoại Pancake; nhân viên bấm avatar khách, **tự xác nhận đúng người**, rồi
   **Thao tác → Lưu link Facebook** (nguồn «NV xác nhận từ Pancake»). Khách tự gửi link ⇒ nguồn «Khách tự gửi».
4. Ghi từng bước: khách đồng ý → đã gửi lời mời → đã kết bạn (hoặc khách từ chối / không liên hệ). Bấm lại cùng bước không ghi gì.
5. Đổi NV phụ trách, đặt ngày chăm sóc tiếp, **Tạo nhiệm vụ CSKH** (việc tay phòng Kinh doanh & CSKH trên `/work`, giao NV phụ
   trách; một khách chỉ một nhiệm vụ mở mỗi ngày).
6. **360** mở hồ sơ khách; **Hội thoại** mở hộp thư ERP (tổ chức có AI bán hàng) hoặc Pancake.

Quyền: xem cần `customers:view`; mọi thao tác ghi cần `customers:write` (không thêm khoá quyền mới).

Bật / tắt: quản trị cài đặt tổ chức (`settings:manage`) bấm công tắc ngay trên `/customers/facebook-crm` (lát 1b).

## 5. Lát 2 — hàng đợi việc, Customer 360, thẻ số

- **Nguồn việc `FB_CRM_CARE` trên `/work`** (phép chiếu, luật 19): khách có ngày hẹn chăm sóc ≤ hôm nay (giờ VN), không «không liên
  hệ», cờ tổ chức bật. MỘT dòng / khách, phòng Kinh doanh & CSKH (`work.ownership`), hạn cố ý bỏ trống (`work.sla`, ngày hẹn đã là
  mốc). Người phụ trách = NV phụ trách khách ở miền; «Giao cho» trên /work ghi vào miền (`fbCrmApplyCore` SET_OWNER). Không có nút
  «xong»: nút MỞ `/customers/facebook-crm?c=<mã>`, việc rời hàng đợi khi người đặt ngày mới / bỏ hẹn / đánh dấu không liên hệ.
  **Không đếm hai lần:** khách đã có nhiệm vụ CSKH tay của lát 1 (nhãn `fb-crm`) còn mở thì không sinh dòng chiếu. Không cảnh báo
  `notifications` nào nói về hẹn chăm sóc khách, nên `ALERT_KINDS_OWNED_ELSEWHERE` không đổi.
- **Khối «Facebook CRM» trên Customer 360** (`components/fb-crm/customer-fb-crm-section.tsx`): trạng thái, link + nguồn, phụ trách,
  ngày hẹn, 5 dòng nhật ký gần nhất (người làm đọc từ `users`), nút sang trang Facebook CRM. Ẩn khi cờ tắt.
- **Thẻ số đầu trang:** số khách theo trạng thái kết bạn (cùng tập khách của trang) và **«Kết bạn rồi mua»**: khách ĐANG «Đã kết
  bạn» có đơn GIAO THÀNH CÔNG (ORDER_OUTCOME) đặt SAU mốc kết bạn (dòng nhật ký đầu tiên `STATUS_CHANGED → FRIENDS`), kèm tiền có
  chứng từ (VERIFIED_CASH; chưa chứng từ ⇒ «—»). Luôn in nhãn **«Tương quan, KHÔNG phải doanh thu do CRM mang lại»** và **độ phủ**
  (bao nhiêu khách đã kết bạn có mốc). Đây không phải quy kết nhân quả.

## 6. Việc còn lại

- **Lát 3:** AI **gợi ý** câu chăm sóc (người duyệt rồi tự gửi) — cần chủ shop duyệt chi phí AI trước; dashboard theo NV.
- Cách lấy link profile đã chốt với chủ shop (30/10): **bấm avatar khách trên Pancake** (nguồn «NV xác nhận từ Pancake»). Không thử
  `page_customer.global_id`.
