# Hướng dẫn cho chủ shop — mở Messenger trực tiếp cho mọi shop (thêm quyền + nộp App Review)

Tài liệu này dành cho **chủ shop / chủ nền tảng**: người duy nhất đăng nhập được tài khoản Meta (Facebook) sở hữu app. Kỹ thuật
**không** đăng nhập được tài khoản Meta của bạn, nên mọi bước trên `developers.facebook.com` và `business.facebook.com` dưới đây
là việc bạn tự bấm. Phần kỹ thuật phải làm trong mã / máy chủ nằm ở bảng cuối tài liệu.

Chi tiết kỹ thuật (vì sao cần từng quyền, mã nào gọi API nào) đã có trong các tài liệu cùng thư mục — ở đây chỉ dẫn link, không
chép lại:

- [01-quyen-va-dieu-kien.md](01-quyen-va-dieu-kien.md) — 4 quyền, điều kiện tiên quyết, đề xuất câu chữ cho chính sách bảo mật.
- [02-kiem-thu-va-webhook.md](02-kiem-thu-va-webhook.md) — luồng thử trên ERP, tài khoản thử, bảng lý do lỗi khi nối page.
- [03-screencast-va-bang-chung.md](03-screencast-va-bang-chung.md) — kịch bản quay video.
- [04-reviewer-instructions-en.md](04-reviewer-instructions-en.md) — đoạn tiếng Anh dán vào form Meta.

## Trước khi bắt đầu — đọc 5 điều này

1. **Giao diện Meta đổi thường xuyên.** Tên nút trong tài liệu là nhãn tiếng Anh của Meta, viết trong ngoặc như (**Use cases**).
   Nếu không thấy đúng chữ đó, làm theo dòng «Nếu không thấy …» ở từng bước. Nếu tài khoản Facebook của bạn để tiếng Việt,
   nên tạm đổi sang **English (US)** lúc làm để khớp tài liệu.
2. **Không bao giờ gửi cho ai — kể cả kỹ thuật — App Secret, mật khẩu Facebook, mã đăng nhập 2 lớp.** App ID thì gửi được.
3. **Không chụp / quay khối «Người vận hành nền tảng»** trên ERP (có Verify token). Kho mã là công khai, video gửi Meta cũng
   không được lộ mã này.
4. Mỗi bước có dòng **«Xong khi»** — chưa thấy đúng dấu hiệu đó thì đừng sang bước sau.
5. Thứ tự: A → B → C → D. Phần B tạo ra «lượt gọi API thành công» mà phần D bắt buộc phải có, nên không nhảy thẳng sang nộp.

### Hai app Meta — app nào dùng cho việc gì

Bạn đang có **hai** app trên Meta. Nhầm app là lỗi hay gặp nhất, nên ghi nhớ bảng này:

| App | Dùng cho | Có nộp App Review Messenger không? |
|---|---|---|
| **App đăng nhập** (app cũ, khai ở máy chủ bằng `FACEBOOK_LOGIN_APP_ID`) | Nút «Tiếp tục với Facebook» khi đăng nhập ERP. Chỉ cần `public_profile`, `email`. | **KHÔNG.** Giữ nguyên, đừng thêm quyền page vào app này. |
| **«ChotDonTuDong Messenger»** (app mới tạo 06/10, khai bằng `FACEBOOK_MESSENGER_APP_ID`) | Nối Facebook Page, nhận tin nhắn (webhook), gửi tin trả lời khách. | **CÓ — mọi bước dưới đây làm trên app NÀY.** |

Cách biết đang đứng ở đúng app: trên ERP vào **Nền tảng** (`/platform`) → khung «Webhook Messenger / Instagram — khai ở app
Meta» → dòng **«App Messenger riêng»** in `App ID …`. Trên Meta, App ID hiện ở đầu trang của app và ở **App settings → Basic**.
Hai số phải trùng.

---

## Phần A — Kiểm điều kiện (làm trước, khoảng 15 phút)

### A1. Doanh nghiệp đã được xác minh (Business Verification)

- **Vào đâu:** `https://business.facebook.com/settings` → chọn đúng doanh nghiệp **VNXcommerce** ở góc trên bên trái → cột trái
  (**Security Center**). Nếu không thấy, tìm mục (**Business info**) hoặc gõ «verification» vào ô tìm kiếm của trang cài đặt.
- **Bấm gì:** không bấm gì, chỉ đọc trạng thái.
- **Xong khi:** thấy trạng thái (**Verified**) cho mục (**Business verification**).
- **Lỗi hay gặp:**
  - Thấy (**Start verification**) hoặc (**In review**) ⇒ chưa xong; không nộp được Advanced Access. Làm theo hướng dẫn của Meta
    (giấy phép kinh doanh, tên + địa chỉ phải khớp), chờ Meta duyệt rồi mới sang phần D.
  - Thấy (**Verified**) nhưng ở một doanh nghiệp KHÁC với doanh nghiệp sở hữu app ⇒ xem A3.

### A2. Bạn là quản trị (Administrator) của app «ChotDonTuDong Messenger»

- **Vào đâu:** `https://developers.facebook.com/apps` (trang **My Apps**) → bấm vào app **ChotDonTuDong Messenger** → cột trái
  (**App roles**) → (**Roles**). Nếu không thấy, tìm mục (**Roles**) trong cột trái.
- **Xong khi:** tên tài khoản Facebook của bạn nằm trong nhóm (**Administrators**) (hoặc (**Admin**)).
- **Lỗi hay gặp:**
  - Không thấy app trong **My Apps** ⇒ bạn đang đăng nhập nhầm tài khoản Facebook. Đăng xuất, đăng nhập tài khoản đã tạo app.
  - Bạn chỉ là (**Developer**) ⇒ nhờ người là Administrator nâng quyền, vì chỉ Administrator mới nộp App Review được.

### A3. App gắn với doanh nghiệp đã xác minh

- **Vào đâu:** trong app → cột trái (**App settings**) → (**Basic**). Kéo xuống tìm ô (**Business portfolio**) hoặc
  (**Business Manager**). Nếu không thấy ô này, tìm phần (**Verification**) trong cột trái của app.
- **Xong khi:** ô đó ghi **VNXcommerce** — đúng doanh nghiệp đã (**Verified**) ở A1.
- **Lỗi hay gặp:** ô trống ⇒ bấm (**Connect**) / chọn doanh nghiệp VNXcommerce → (**Save changes**).

### A4. Ghi lại App ID và đối chiếu với ERP

- **Vào đâu:** app → (**App settings**) → (**Basic**) → ô (**App ID**).
- **Bấm gì:** so với ERP `/platform` như ở bảng «Hai app Meta» phía trên. Cùng khung đó, đọc dòng **«Nối page dùng app»**.
- **Xong khi:** App ID trùng VÀ dòng «Nối page dùng app» ghi **«App Messenger riêng»**.
- **Lỗi hay gặp:** dòng đó ghi «App đăng nhập (chưa khai đủ app Messenger)» ⇒ **dừng lại, báo kỹ thuật** (việc K1 ở bảng cuối).
  Lúc này mọi lượt thử ở phần B sẽ tính cho app đăng nhập, không tính cho app Messenger, nên làm tiếp là phí công.

---

## Phần B — Thêm quyền (mức Standard) và thử nối page (khoảng 30–60 phút)

Mục tiêu phần này: bốn quyền `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement` có mặt trong
app, và **mỗi quyền có ít nhất một lượt gọi API thành công** — Meta bắt buộc điều này trước khi cho nộp. Ở mức Standard, quyền chỉ
dùng được cho người có vai trò trong app (Administrator / Developer / Tester), nên ta thử bằng chính tài khoản của bạn.

### B1. Mở use case Messenger

- **Vào đâu:** app → cột trái (**Use cases**).
- **Bấm gì:** dòng (**Engage with customers on Messenger from Meta**) → (**Customize**). Nếu chưa có dòng này: (**Add use case**)
  → chọn đúng tên đó → (**Save**) / (**Add**).
- **Xong khi:** mở được trang tuỳ chỉnh của use case Messenger.
- **Lỗi hay gặp:** không có use case Messenger trong danh sách «Add use case» ⇒ app không phải loại (**Business**). Báo kỹ thuật,
  không tự tạo app mới (tạo app mới phải khai lại ở máy chủ).

### B2. Thêm 4 quyền

- **Vào đâu:** trong trang tuỳ chỉnh use case Messenger → phần (**Permissions and features**) hoặc (**Permissions**).
- **Bấm gì:** với từng quyền dưới đây, nếu nút bên cạnh là (**Add**) thì bấm (**Add**):
  `pages_show_list` · `pages_messaging` · `pages_manage_metadata` · `pages_read_engagement`.
- **KHÔNG thêm đợt này:** `business_management`, `instagram_basic`, `instagram_manage_messages` (lý do: [01 §3](01-quyen-va-dieu-kien.md#3-không-nộp-đợt-đầu)).
  Nếu Meta đã tự thêm sẵn, cứ để đó nhưng **không** xin Advanced Access cho chúng ở phần D.
- **Xong khi:** cả 4 quyền hiện trạng thái (**Ready for testing**) / (**Standard access**) / (**Added**) — tuỳ chữ Meta đang dùng.
- **Lỗi hay gặp:** một quyền bị mờ, không bấm (**Add**) được ⇒ di chuột vào xem Meta đòi gì (thường là một quyền khác phải thêm
  trước, ví dụ `pages_show_list`). Thêm quyền được đòi rồi quay lại.

### B3. Khai webhook (đã làm 06/10 — chỉ kiểm lại)

- **Vào đâu:** cùng trang use case Messenger → phần (**Messenger API Settings**) → mục (**Configure webhooks**). Nếu không thấy,
  tìm mục (**Webhooks**) ở cột trái.
- **Điền gì:** (**Callback URL**) và (**Verify token**) lấy ở ERP `/platform` khung «Webhook Messenger / Instagram» (chỉ người vận
  hành nền tảng thấy) → (**Verify and save**). Ở danh sách trường (**Webhook fields**) bật (**Subscribe**) cho:
  `messages` · `messaging_postbacks` · `message_echoes` · `feed`.
- **Xong khi:** Callback URL hiện dấu tích / không báo lỗi, 4 trường trên đều bật.
- **Lỗi hay gặp:** «The URL couldn't be validated» ⇒ chép thiếu ký tự của Verify token, hoặc chép nhầm khung. Chép lại nguyên văn;
  vẫn lỗi ⇒ báo kỹ thuật (máy chủ ghi một dòng `messenger_webhook_rejected reason=VERIFY_TOKEN`).

### B4. Khai địa chỉ quay về sau khi đăng nhập Facebook (OAuth redirect)

Không có bước này thì bấm «Kết nối Facebook Page» sẽ ra lỗi «URL blocked» / «redirect_uri».

- **Vào đâu:** app → cột trái tìm (**Facebook Login for Business**) → (**Settings**). Nếu không thấy, tìm (**Facebook Login**) →
  (**Settings**), hoặc trong (**Use cases**) mở use case có chữ «Facebook Login» → (**Customize**) → (**Settings**).
- **Điền gì:** ô (**Valid OAuth Redirect URIs**): dán **từng dòng** ở ERP `/platform` → «URI chuyển hướng OAuth hợp lệ» (thường là
  hai dòng: một cho miền ERP, một cho `app.chotdontudong.com`) → (**Save changes**).
- **Xong khi:** các địa chỉ hiện thành từng ô riêng trong danh sách và đã lưu.
- **Lỗi hay gặp:** dán cả hai dòng vào một ô ⇒ Meta coi là một địa chỉ sai. Dán từng dòng, Enter sau mỗi dòng.

### B5. Thử nối page bằng tài khoản của chính bạn (tạo «lượt gọi API thành công»)

Chuẩn bị: một **page thử** do bạn quản trị (không dùng page đang bán thật — khách sẽ nhận tin thử); một tài khoản Facebook thứ
hai đóng vai khách. Làm theo đúng luồng ở [02 §1](02-kiem-thu-va-webhook.md#1-luồng-thử-từng-bước-cũng-là-kịch-bản-quay-video),
tóm tắt:

1. Đăng nhập ERP → **AI · Chatbot bán hàng → Messenger trực tiếp** (`/ai/sales-chatbot/messenger`).
2. Bấm **«Kết nối Facebook Page»** → Facebook hỏi quyền → giữ **BẬT** tất cả → chọn page thử → (**Continue**) / (**Save**).
3. Về ERP: thấy dòng xanh «Đã nối page …». Khối «Webhook theo page» → **«Kiểm tra lại»** ⇒ «Webhook đã đăng ký đủ».
   (Bước này dùng `pages_show_list` + `pages_manage_metadata`.)
4. Từ tài khoản «khách», nhắn vào page thử. Mở **Hộp thư khách** trên ERP ⇒ thấy tin; bot trả lời ⇒ khách nhận được.
   (Dùng `pages_messaging`.)
5. Từ tài khoản «khách», bình luận dưới một bài của page thử ⇒ khách nhận một tin riêng trên Messenger.
   (Dùng `pages_read_engagement` + `pages_messaging`.)

- **Xong khi:** đủ 5 bước trên chạy được; trên Meta, trang (**Permissions and features**) của use case Messenger (hoặc trang
  (**App Review**) → (**Requests**)) không còn ghi «0 of 1 API call(s) required» / «API test call required» bên cạnh 4 quyền.
  Meta có thể mất **tới 24 giờ** mới đếm xong — chưa thấy thì đợi một ngày rồi xem lại, đừng thử dồn dập.
- **Lỗi hay gặp:** ERP in một lý do có chữ in hoa — tra đủ ở [02 §4](02-kiem-thu-va-webhook.md#4-chẩn-đoán-trên-erp--bảng-lý-do).
  Ba lý do hay gặp nhất:

  | ERP báo | Nghĩa | Cách sửa |
  |---|---|---|
  | `PERMISSION_NOT_IN_APP` | Bạn có vai trò trong app mà vẫn không được cấp quyền ⇒ quyền chưa thật sự thêm vào app | Quay lại B2. Đã thêm đủ mà vẫn lỗi ⇒ làm B6. |
  | `PERMISSION_DECLINED` | Bạn đã tắt một quyền trong hộp thoại Facebook | Bấm kết nối lại, giữ BẬT mọi quyền. |
  | `PERMISSION_NEEDS_APP_REVIEW` | Tài khoản đang bấm KHÔNG có vai trò trong app | Đúng như mong đợi trước khi duyệt — dùng tài khoản có vai trò (A2), hoặc thêm người đó làm Tester (B7). |

  Thêm: hộp thoại Facebook báo «Invalid Scopes» ⇒ báo kỹ thuật (ERP đang xin sai bộ quyền; `/platform` → dòng «Quyền hộp thoại
  … xin» sẽ in thiếu / thừa).

### B6. (Chỉ khi B5 báo `PERMISSION_NOT_IN_APP` dù đã thêm đủ quyền) Tạo cấu hình đăng nhập (Configuration)

App loại Business có thể bỏ qua danh sách quyền mà ERP xin, và chỉ cấp quyền theo một **Configuration** khai trên Meta.

- **Vào đâu:** app → (**Facebook Login for Business**) → (**Configurations**). Nếu không thấy, tìm chữ «Configurations» trong cột
  trái hoặc trong use case có chữ «Facebook Login».
- **Bấm gì / điền gì:** (**Create configuration**) / (**Create from template**) → đặt tên, ví dụ `Ket noi Page Messenger` →
  kiểu đăng nhập (**General**) nếu được hỏi → kiểu token (**User access token**) → chọn đúng 4 quyền ở B2 → (**Create**).
- **Xong khi:** thấy một dãy số (**Configuration ID**). Gửi dãy số này cho kỹ thuật (không phải bí mật) — việc K2 ở bảng cuối.
  Sau khi kỹ thuật báo đã khai, làm lại B5.

### B7. Thêm người thử (Tester) nếu cần

Dùng khi người khác (nhân viên, hoặc tài khoản «khách» muốn nối page) cần thử trước khi Meta duyệt.

- **Vào đâu:** app → (**App roles**) → (**Roles**) → (**Add People**) → chọn (**Testers**) → gõ tên / Facebook ID → (**Add**).
- **Xong khi:** người được mời mở `https://developers.facebook.com/requests` và bấm (**Confirm**) / (**Accept**). Nếu Meta bắt họ
  đăng ký tài khoản nhà phát triển, làm theo hướng dẫn của Meta.
- **Lưu ý:** vai trò (**Insights users**) KHÔNG đủ để thử.

---

## Phần C — Chuẩn bị hồ sơ nộp (khoảng 1–2 giờ, chưa bấm nộp)

### C1. Chính sách bảo mật phải có mục Messenger

Trang hiện tại `https://vnxcommerce.com/chinh-sach-bao-mat` mới nói về **đăng nhập** bằng Facebook, và còn có câu «không đọc tin
nhắn cá nhân» — đặt cạnh yêu cầu quyền `pages_messaging`, người duyệt của Meta sẽ thấy mâu thuẫn và từ chối. Kiểm kê 08/10 xác nhận
trang **chưa** có mục Messenger.

Trang phải nói được 5 điều (đề xuất câu chữ đầy đủ ở [01 §5](01-quyen-va-dieu-kien.md#5-việc-cần-làm--trang-chính-sách-quyền-riêng-tư-không-tự-sửa-trang-pháp-lý)):

1. Khi shop bấm «Kết nối Facebook Page», chúng tôi nhận từ Facebook những gì (danh sách page, mã truy cập page được chọn).
2. Sau khi nối, chúng tôi nhận gì (tin nhắn khách gửi page, bình luận mới, nội dung bài được bình luận) và dùng để làm gì
   (chatbot + nhân viên của shop trả lời khách).
3. Lưu ở đâu, ai xem được, có bán / chia sẻ không (không).
4. Cách gỡ kết nối (trên ERP và trong cài đặt page trên Facebook).
5. Cách yêu cầu xoá dữ liệu Messenger (mục 9 của trang, neo `#xoa-du-lieu`).

- **Việc của bạn:** đọc đề xuất ở 01 §5, sửa chữ nếu muốn, rồi **báo kỹ thuật đồng ý** (sửa trang pháp lý là quyết định của bạn).
- **Việc của kỹ thuật:** đưa lên trang + tăng số phiên bản chính sách (K3).
- **Xong khi:** mở `https://vnxcommerce.com/chinh-sach-bao-mat` bằng trình duyệt ẩn danh (không đăng nhập) thấy mục Messenger, và
  link `https://vnxcommerce.com/chinh-sach-bao-mat#xoa-du-lieu` nhảy đúng tới mục xoá dữ liệu.

### C2. Điền thông tin cơ bản của app

- **Vào đâu:** app «ChotDonTuDong Messenger» → (**App settings**) → (**Basic**).
- **Điền gì:**

  | Ô trên Meta | Điền |
  |---|---|
  | (**Privacy Policy URL**) | `https://vnxcommerce.com/chinh-sach-bao-mat` |
  | (**User data deletion**) | chọn (**Data deletion instructions URL**) → `https://vnxcommerce.com/chinh-sach-bao-mat#xoa-du-lieu` |
  | (**App icon**) | ảnh vuông 1024 × 1024 của thương hiệu |
  | (**Category**) | chọn nhóm gần nhất với «Business» / «Business and Pages» |
  | (**Contact email**) | email hỗ trợ của công ty (Meta gửi kết quả duyệt về đây) |
  | (**Terms of Service URL**) nếu có ô | `https://vnxcommerce.com/dieu-khoan-su-dung` |

  → (**Save changes**).
- **Xong khi:** lưu không báo đỏ. Meta tự mở thử link chính sách — link hỏng sẽ báo ngay.
- **Lỗi hay gặp:** «Privacy policy URL is invalid / not reachable» ⇒ mở link bằng trình duyệt ẩn danh; nếu trang đòi đăng nhập
  hoặc lỗi ⇒ báo kỹ thuật.

### C3. Tài khoản ERP cho người duyệt (reviewer)

- **Việc của kỹ thuật (K4):** dựng sẵn một tổ chức ERP thử, bật module «AI bán hàng».
- **Việc của bạn:** trong tổ chức thử đó, tạo một người dùng cho reviewer (quyền Cài đặt + AI bán hàng), tự đặt mật khẩu.
  **Chỉ** ghi mật khẩu vào form Meta ở bước D3 — không gửi qua Lark / Zalo / email cho ai.
- **Page thử phải công khai:** vào cài đặt page thử trên Facebook, bỏ mọi giới hạn quốc gia / độ tuổi để reviewer (ở nước ngoài)
  nhắn được.
- **Xong khi:** bạn đăng nhập thử tài khoản reviewer bằng trình duyệt ẩn danh và mở được `/ai/sales-chatbot/messenger`.

### C4. Quay video (screencast)

- **Kịch bản:** đúng 10 cảnh ở [03 §1](03-screencast-va-bang-chung.md#1-danh-sách-cảnh--cảnh-nào-chứng-minh-quyền-nào). Mỗi cảnh
  có sẵn câu chú thích tiếng Anh — chèn câu đó lên màn hình (phụ đề) khi dựng video.
- **Cách quay đơn giản:** Windows bấm `Win + G` (Xbox Game Bar) hoặc dùng OBS; điện thoại dùng ghi màn hình có sẵn cho cảnh
  «khách nhắn tin». Ghép hai phần bằng CapCut / Clipchamp, thêm phụ đề tiếng Anh.
- **Yêu cầu:** MP4, tối thiểu 720p, thấy rõ con trỏ chuột, quay liền mạch từng thao tác; cảnh 2 phải thấy **tên app** và danh sách
  quyền trong hộp thoại Facebook.
- **Tuyệt đối không xuất hiện:** khối «Người vận hành nền tảng», trang `/platform`, mật khẩu, App Secret.
- **Xong khi:** một tệp MP4 chạy từ đầu tới cuối, xem lại thấy đủ 4 quyền đều có cảnh minh hoạ (cột «Chứng minh» của 03 §1).
- **Lỗi hay gặp:** video bị Meta từ chối vì «không thấy luồng đăng nhập» ⇒ thiếu cảnh 2 (hộp thoại Facebook). Đừng cắt cảnh đó.

### C5. Chuẩn bị đoạn chữ tiếng Anh

Mở [04-reviewer-instructions-en.md](04-reviewer-instructions-en.md), chép sẵn ra Notepad:

- §1 — mô tả app (dán vào ô mô tả / cách dùng chung);
- §2 — bốn đoạn, mỗi quyền một đoạn;
- §3 — hướng dẫn cho reviewer: điền vào các chỗ `<…>` (URL đăng nhập, mã tổ chức thử, email + mật khẩu reviewer ở C3, tên page thử)
  **ngay trong Notepad trên máy bạn**, không gửi lại cho kỹ thuật;
- §4 — câu trả lời về xử lý dữ liệu.

Lưu ý tên: app trên Meta tên «ChotDonTuDong Messenger» còn đoạn chữ viết «VNXcommerce». Nên thêm một câu đầu §1:
*"ChotDonTuDong (Chốt Đơn Tự Động) is a product of VNXcommerce."* để reviewer không thắc mắc hai tên.

---

## Phần D — Nộp, theo dõi, xử lý khi bị từ chối

### D1. Kiểm danh sách trước khi nộp

Chỉ bấm nộp khi đánh dấu được hết:

- [ ] A1 Business Verification = (**Verified**).
- [ ] A4 ERP `/platform` ghi «Nối page dùng app: App Messenger riêng».
- [ ] B2 đủ 4 quyền; B5 Meta không còn đòi «API call required» cho quyền nào.
- [ ] C1 trang chính sách đã có mục Messenger (mở ẩn danh thấy được).
- [ ] C2 lưu xong thông tin cơ bản.
- [ ] C3 tài khoản reviewer đăng nhập được; page thử công khai.
- [ ] C4 có tệp MP4.
- [ ] C5 có sẵn đoạn tiếng Anh đã điền chỗ `<…>`.

### D2. Mở form nộp

- **Vào đâu:** app → cột trái (**App Review**) → (**Requests**). Nếu không thấy: trong trang use case Messenger tìm nút / mục
  (**Complete App Review**) hoặc (**Go to App Review**); hoặc cột trái (**Review**) → (**App Review**).
- **Bấm gì:** (**New request**) hoặc (**Edit request**) nếu đã có bản nháp.
- **Chọn quyền:** với từng quyền trong 4 quyền ở B2, chọn (**Request advanced access**) / (**Get advanced access**).
  KHÔNG chọn `business_management`, `instagram_*`.

### D3. Điền form

Form của Meta thường chia thành các phần như dưới (thứ tự và tên có thể khác — làm theo phần Meta hiện):

| Phần trên form (tên thường gặp) | Điền gì |
|---|---|
| (**Verification**) | Meta tự kiểm Business Verification — phải xanh sẵn từ A1. |
| (**App settings**) | Meta tự kiểm C2 — ô nào đỏ thì quay lại C2. |
| (**Allowed usage**) / (**How will your app use this permission?**) | Với TỪNG quyền: dán đoạn tương ứng ở 04 §2; tải lên tệp MP4 ở C4 (cùng một tệp cho cả 4 quyền là được); tích các ô cam kết của Meta sau khi đọc. |
| (**Data handling**) / (**Data handling questions**) | Trả lời THẬT theo thực tế, dựa trên 04 §4. Thường gặp: *Có bên xử lý dữ liệu (data processors) không?* — **Có**: máy chủ VNPT (lưu trữ), nhà cung cấp AI shop chọn (ví dụ Google Gemini, chỉ để soạn câu trả lời), Google Drive (bản sao lưu đã mã hoá). *Bên chịu trách nhiệm dữ liệu (responsible entity)?* — tên công ty, quốc gia Việt Nam. *Từng cung cấp dữ liệu cho cơ quan nhà nước trong 12 tháng qua?* — trả lời đúng sự thật. Câu nào không chắc ⇒ hỏi kỹ thuật trước khi chọn, đừng đoán. |
| (**Reviewer instructions**) | Dán 04 §3 đã điền ở C5. |

- **Xong khi:** mọi phần có dấu tích xanh, nút (**Submit for review**) sáng lên.

### D4. Nộp

- **Bấm gì:** (**Submit for review**) → xác nhận.
- **Xong khi:** trang (**App Review**) → (**Requests**) ghi trạng thái (**In review**) / (**Submitted**). Meta gửi email xác nhận
  về (**Contact email**) ở C2.
- **Trong lúc chờ:** **giữ nguyên** page thử, tài khoản reviewer, tổ chức thử và module AI bán hàng — reviewer có thể vào thử bất
  kỳ lúc nào. Không đổi mật khẩu reviewer, không gỡ page thử.

### D5. Theo dõi

- Xem trạng thái ở (**App Review**) → (**Requests**) và email. Thời gian Meta duyệt không cố định — thường vài ngày làm việc, có
  lúc lâu hơn. Không nộp lại liên tục trong lúc đang (**In review**).
- Meta có thể hỏi thêm qua mục tin nhắn của yêu cầu — trả lời bằng tiếng Anh; câu hỏi kỹ thuật thì chép nguyên văn gửi kỹ thuật
  soạn câu trả lời.

### D6. Khi được duyệt

1. Mỗi quyền chuyển sang (**Advanced access**) — kiểm ở trang (**Permissions and features**) của use case Messenger.
2. Nếu thanh trên cùng của app có công tắc (**App Mode**) đang ở (**Development**) ⇒ chuyển sang (**Live**). App loại Business có
   thể không có công tắc này mà có mục (**Publish**) — nếu Meta nhắc (**Publish**) thì bấm theo. Không thấy cả hai ⇒ bỏ qua.
3. **Thử thật:** nhờ một người KHÔNG có vai trò gì trong app (không Admin / Developer / Tester) nối page của họ trên ERP ⇒ ERP báo
   «Đủ quyền, có page nhắn tin được», khối «Webhook theo page» báo «Webhook đã đăng ký đủ». Đó là dấu hiệu Messenger trực tiếp đã
   mở cho mọi shop.
4. Báo kỹ thuật ngày được duyệt (K6).

### D7. Khi bị từ chối

Meta luôn ghi lý do cho từng quyền ở (**App Review**) → (**Requests**) → mở yêu cầu → phần ghi chú của người duyệt. Đọc kỹ, sửa
đúng chỗ, rồi (**Edit request**) → (**Resubmit**). Lý do hay gặp:

| Meta viết (thường gặp) | Nghĩa | Sửa |
|---|---|---|
| «We were unable to log in» / «test credentials didn't work» | Reviewer không đăng nhập được ERP | Thử lại tài khoản C3 bằng trình duyệt ẩn danh; kiểm URL, mã tổ chức trong 04 §3. |
| «Screencast doesn't show the permission being used» / «doesn't show the login flow» | Video thiếu cảnh | Quay lại theo đủ 10 cảnh 03 §1, nhất là cảnh 2 (hộp thoại Facebook) và cảnh quyền bị nêu tên. |
| «Privacy policy doesn't explain …» / «invalid privacy policy» | Chính sách thiếu nội dung hoặc link hỏng | Quay lại C1, báo kỹ thuật bổ sung đúng câu Meta nêu. |
| «Unable to test: page not accessible» / «couldn't send a message» | Reviewer không nhắn được page thử | Bỏ giới hạn quốc gia / độ tuổi của page; kiểm page đang công khai. |
| «Your app doesn't need this permission» / «not required for the described use case» | Mô tả chưa nói rõ quyền dùng để làm gì | Viết lại đoạn 04 §2 của quyền đó rõ hơn (nhờ kỹ thuật), chỉ ra đúng cảnh trong video. Nếu là `pages_read_engagement`: có thể bỏ quyền này khỏi đợt đó và nộp lại 3 quyền còn lại — báo kỹ thuật trước, vì bỏ nó thì bot trả lời bình luận kém ngữ cảnh. |
| «Business verification required» | A1 chưa xong hoặc app gắn nhầm doanh nghiệp | Làm lại A1, A3. |

Bị từ chối **không** làm mất quyền Standard đang có: bạn và Tester vẫn dùng được trong lúc sửa.

---

## Bảng chia việc

| # | Việc của chủ shop (trên Meta / Facebook) | Phần |
|---|---|---|
| S1 | Kiểm Business Verification, vai trò Administrator, app gắn đúng doanh nghiệp | A1–A3 |
| S2 | Đối chiếu App ID với ERP `/platform` | A4 |
| S3 | Thêm use case Messenger + 4 quyền; kiểm webhook; khai OAuth redirect | B1–B4 |
| S4 | Nối page thử bằng tài khoản của mình (tạo lượt gọi API thành công) | B5 |
| S5 | (Nếu cần) tạo Configuration, gửi Configuration ID cho kỹ thuật; thêm Tester | B6–B7 |
| S6 | Duyệt câu chữ mục Messenger trong chính sách bảo mật | C1 |
| S7 | Điền App settings → Basic; tạo tài khoản reviewer + đặt mật khẩu; mở công khai page thử | C2–C3 |
| S8 | Quay + dựng video có phụ đề tiếng Anh | C4 |
| S9 | Điền form, nộp, theo dõi, trả lời Meta, nộp lại khi bị từ chối | D1–D7 |

| # | Việc của kỹ thuật (mã / máy chủ — chủ shop không phải làm) | Khi nào |
|---|---|---|
| K1 | **Xác nhận ERP production nối page / gửi tin / ký `appsecret_proof` / nhận diện tin của bot bằng app Messenger riêng.** Mã đã có cơ chế chuyển từ 06/10 (PR #614, `messengerApp()` trong `lib/integrations/messenger/graph.ts`): VPS có ĐỦ cặp `FACEBOOK_MESSENGER_APP_ID` + `FACEBOOK_MESSENGER_APP_SECRET` thì mọi bước đi app Messenger, thiếu một nửa thì lùi về app đăng nhập. Việc cần làm: đọc `/platform` dòng «Nối page dùng app»; nếu chưa là «App Messenger riêng» thì kiểm GitHub Variable/Secret đúng tên và deploy lại. Page đã nối bằng app đăng nhập trước đó (nếu có) phải được nối lại — token page do app nào cấp thì phải ký bằng secret của app đó. | Trước B5 |
| K2 | Nhận Configuration ID từ chủ shop (B6) → khai GitHub Variable `FACEBOOK_MESSENGER_LOGIN_CONFIG_ID` → deploy; kiểm `/platform` dòng «Cách xin quyền» đổi sang «Configuration ID …». | Chỉ khi B6 xảy ra |
| K3 | Thêm mục «Kết nối Facebook Page để nhắn tin (Messenger)» vào `app/chinh-sach-bao-mat/page.tsx` theo câu chữ chủ shop đã duyệt (01 §5), sửa câu mục 3 cho rõ phạm vi «khi đăng nhập», thêm câu vào mục 9; tăng `PRIVACY_POLICY.version` ở `lib/constants/company.ts`; cập nhật `docs/legal/privacy-policy.md`; deploy; mở ẩn danh kiểm. | Trước D2 |
| K4 | Dựng tổ chức ERP thử cho reviewer, bật module AI bán hàng; kiểm luồng 02 §1 chạy trên tổ chức đó (kể cả qua miền `app.chotdontudong.com` nếu reviewer dùng miền này). | Trước C3 |
| K5 | Sửa tài liệu cho khớp hiện trạng: `README.md` + `01 §1` của thư mục này còn ghi «cùng app đăng nhập»; chú thích `facebookMessengerAppId` trong `lib/env.ts` còn ghi «nối page vẫn đi app đăng nhập» (đã sai từ PR #614); 04 §1/§3 thêm tên ChotDonTuDong và URL đăng nhập đúng miền. | Trước D2 |
| K6 | Sau khi Meta duyệt: theo dõi log `[messenger-connect] … reason=OK` của shop đầu tiên không có vai trò trong app; theo dõi `messenger_webhook_rejected` (chữ ký sai = webhook của app khác / secret sai). | Sau D6 |
| K7 | Đợt sau (không làm đợt này): Instagram DM (`instagram_*`), `business_management` cho page chỉ giao qua Business Portfolio — mỗi cái là một lần nộp riêng. | Sau khi đợt đầu được duyệt |
