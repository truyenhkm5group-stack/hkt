# Trung tâm trợ giúp ba tầng và luồng vào việc 10 bước (thiết kế)

*MASTER MISSION §34 (nối với §5) · lát D3 (R0) · 08/10/2026 · số dòng mã đối chiếu trên `origin/main` `217cb26c`, cộng bản chạy
thử cục bộ của vỏ Chốt Đơn (`SHELL_AUDIT_2026-10-08.md`). Đây là tài liệu THIẾT KẾ: không dòng mã nào đổi.*

Đọc kèm:
- `docs/platform/help-guides.md`: luật viết bài hiện hành. Một luật trong đó trái với vỏ khách, xem §5.
- `docs/platform/quick-start.md`.
- `docs/productization/11_SAAS_METRICS_SPEC.md` (`:76-91`): các mốc kích hoạt / Time-to-Value.
- `docs/design-system.md` §4: chữ giải thích nằm trong ⓘ.
- `SHELL_AUDIT_2026-10-08.md`, `INBOX_V2.md`.
- `lib/constants/saas-nav.ts`: 8 mục vỏ và danh sách trang được mở.

## 1. Hiện trạng

| Mảnh | Ở đâu | Hiện nay | Khoảng trống |
|---|---|---|---|
| Trung tâm `/help` | `app/(dashboard)/help/page.tsx`, nội dung ở `lib/constants/help-guides.ts:52-353` (21 bài) và `:356-362` (5 câu hỏi thường gặp) | 6 chủ đề. Lọc theo quyền và module (`help/page.tsx:17-18`, `help-guides.ts:368-373`). Trang tự hứa «chỉ hiện những việc tài khoản của bạn làm được» (`help/page.tsx:23`) | **Không biết vỏ khách**: không có lời gọi `isSalesAgentUser` / `shellAllows` nào |
| Bài dẫn vào trang bị chặn | `help-guides.ts:84-91` (`/settings/modules`), `:126-134` (`/products/price-lists`), `:155-163` (`/customers/receivables`), `:169-177` (`/customers/reorder`) | Chủ shop vỏ Chốt Đơn thấy 13 bài, trong đó 4 bài dẫn vào trang vỏ chặn. Bấm «Mở trang» thì bị đưa về Hộp thư kèm câu «Trang này không có trong gói Chốt Đơn» (đo trên bản chạy thử) | Bài kiểm lối cụt chỉ quét chuỗi `href` trong `.tsx` của thư mục trang (`tests/saas-shell.test.ts:265-280`). Link nằm trong dữ liệu ở `lib/` nên lọt |
| Câu chữ lệch vỏ | `help-guides.ts:57`, `:62`, `:77`, `:335`, `:348`, `:357-361` | «Mời nhân viên vào ERP», «Mở Hệ thống → Người dùng». Trong vỏ, menu tên là «Nhân viên» và «Gói dịch vụ». Câu hỏi thường gặp bảo «liên hệ bên cung cấp phần mềm» mà không có kênh nào | Luật viết bài còn ghi rõ «nhóm Hệ thống, không phải Cài đặt» (`docs/platform/help-guides.md:30`) |
| Bài còn thiếu | — | Chưa có bài cho Hội thoại, Kênh kết nối (Facebook / Zalo / chat web), Số dư AI, Tổng quan, Cài đặt cửa hàng | Ba trong tám mục vỏ (Tổng quan, Hội thoại, Kênh kết nối) chưa có bài nào |
| Trợ giúp tại chỗ | `components/info-hint.tsx:36-55` | Popover «Giải thích cách tính». Có 90 tệp import nó, và còn đi gián tiếp qua `hint` của `PageHeader` / `StatTile` / `MetricCard` | Không có link sang bài hướng dẫn. Không có nút «?» theo trang |
| Lối vào `/help` | `components/nav-user.tsx:62`, `app/(dashboard)/settings/shop/page.tsx:26` | Menu tài khoản, và Cài đặt → «Hướng dẫn sử dụng» | Không có mục nào trong 8 mục vỏ. Trên điện thoại phải mở «Thêm» → Cài đặt → Hướng dẫn |
| Liên hệ | `lib/constants/company.ts:9-14` | Kênh hỗ trợ trong app chỉ xuất hiện ở GoLiveCard (`components/onboarding/go-live-card.tsx:148-149`), mà thẻ này không bao giờ hiện trong vỏ (§7) | Ít nhất 12 chỗ trong vỏ nói «liên hệ hỗ trợ / người vận hành» mà không kèm kênh (ví dụ `app/(dashboard)/ai/sales-chatbot/page.tsx:184`, `app/(dashboard)/settings/plan/page.tsx:67`, `components/saas/my-products.tsx:11`). Chưa có sổ yêu cầu hỗ trợ (`11_SAAS_METRICS_SPEC.md:118`) |
| Dạng nội dung | `help-guides.ts:32-50` | Hằng TypeScript: bài gồm `{ key, topic, title, summary, href, permission, steps[{ text, href? }] }`. Bài kiểm `tests/help-guides.test.ts` xác nhận đường dẫn tồn tại và quyền khớp | Không có phiên bản, không có ảnh / GIF / video, không có trường «dành cho vỏ nào» |

## 2. Ba tầng

| Tầng | Ở đâu | Trả lời câu hỏi | Thành phần |
|---|---|---|---|
| 1. **Vào việc** (onboarding trong app) | Thẻ «Việc cần làm» trên đầu Hộp thư (gập được) và trang `/setup` | «Tôi phải làm gì tiếp để AI bán được hàng?» | MỘT danh sách 10 bước (§7). Không dựng danh sách thứ hai |
| 2. **Trợ giúp tại chỗ «?»** | Nút «?» ở tiêu đề mỗi trang vỏ (`PageHeader`). `InfoHint` có thêm link «Xem hướng dẫn» | «Trang này để làm gì? Ô này nghĩa là gì?» | Bảng ánh xạ đường dẫn → bài. Bài mở trong ngăn bên, người dùng không rời trang |
| 3. **Trung tâm trợ giúp** | `/help` | Tìm, đọc theo chủ đề, liên hệ | Ô tìm · chủ đề · «Không thấy câu trả lời?» → kênh liên hệ (§5) |

## 3. Bản đồ chủ đề cho vỏ Chốt Đơn

| Chủ đề | Bài (tên viết đơn giản) | Trang |
|---|---|---|
| account | Đăng nhập · Quên mật khẩu · Mời nhân viên · Đổi mật khẩu | `/settings/users`, `/settings/profile` |
| channels | Kết nối Facebook · Kết nối Zalo · Đặt ô chat lên website · Vì sao chưa thấy tin khách | `/ai/channels` |
| inbox | Trả lời khách · Câu mẫu và lệnh `/` · Nhận / giao hội thoại · Tiếp quản và trả lại cho AI · Vì sao hội thoại này ở «Cần xử lý» | `/ai/sales-chatbot/inbox` |
| orders | Đơn lên từ hội thoại · Sửa đơn AI lên sai · «Đơn đủ thông tin» nghĩa là gì | `/orders` |
| products | Thêm sản phẩm · Giá · Size / màu · Nhập tồn (không bắt buộc) | `/products`, `/inventory/receipts` |
| ai-sales | Bật AI · Dạy AI về shop · Khung thử · Phát lại hội thoại cũ | `/ai/sales-chatbot` |
| automations | Nhắn lại khách im lặng · Báo nhóm khi có đơn | `/settings/notifications`. Khu Tự động hoá chưa có trang riêng, xem `SHELL_AUDIT_2026-10-08.md` |
| analytics | Đọc trang Tổng quan · Vì sao một ô hiện «—» | `/ai/overview` |
| billing | Gói và dùng thử · Gia hạn bằng QR · Số dư AI | `/settings/plan`, `/settings/ai-balance` |
| troubleshooting | AI không trả lời · Không thấy tin mới · Không nối được Page · Trang trắng sau khi đăng nhập | nhiều trang |

## 4. Kiến trúc nội dung

- **Giữ MỘT sổ bài.** Tiếp tục dùng `lib/constants/help-guides.ts` làm sổ có kiểu. Thêm vào kiểu `HelpGuide` các trường sau:
  - `audience`: `CHOTDON` | `ERP` | `ALL`;
  - `routes`: các trang nhận bài này ở tầng 2;
  - `since`: ngày hoặc phiên bản sản phẩm có bài;
  - `reviewedAt`;
  - `media[]`: mỗi mục gồm `{ kind: image | gif | video, src, alt, status }`.
  Không dựng sổ thứ hai.
  Bài dài nào cần văn bản dài thì có thêm thân bài Markdown ở `docs/help/<khoá>.md`, đọc lúc build. Sổ vẫn là nơi duy nhất khai
  khoá, quyền và đối tượng.
- **Phiên bản đi cùng sản phẩm.** Bài nằm trong cùng kho và đi cùng lượt deploy, nên luôn khớp mã đang chạy. Trường `reviewedAt` giúp
  người viết biết bài nào lâu chưa được xem lại. Không cần một hệ phiên bản riêng.
- **Chỗ cho GIF / ảnh / video.**
  - Ảnh để ở `public/help/<khoá>/`, chụp từ workspace mẫu với dữ liệu giả. Kho mã PUBLIC, nên không bao giờ dùng ảnh của shop thật.
  - Mỗi ảnh bắt buộc có `alt`.
  - Video chỉ là một liên kết. Nơi lưu là quyết định của chủ shop (§9).
  - Mục `media` có `status: TODO` vẫn hiện được bài, chỉ không có khung ảnh.
- **Bài kiểm.** Mở rộng `tests/help-guides.test.ts`:
  1. Mọi `href` và `routes` của bài có `audience = CHOTDON` phải qua `salesAgentPathAllowed`. Việc này vá đúng lỗ của
     `tests/saas-shell.test.ts:265-280`.
  2. Mỗi mục trong 8 mục vỏ có ít nhất một bài ở tầng 2.
  3. Bài `CHOTDON` không chứa từ trong danh sách cấm ở §6. Dùng cùng cách quét của `tests/saas-hide-internal.test.ts`.

## 5. Nối với vỏ khách

- `/help` lọc theo `isSalesAgentUser(user)`: người trong vỏ chỉ thấy bài `CHOTDON` hoặc `ALL`. Link được bọc bằng `shellAllows`
  (`lib/constants/saas-nav.ts:189-191`), đúng phép quyết định của cổng máy chủ, không có danh sách thứ hai.
- Câu chữ gọi menu theo tên trong vỏ: «Nhân viên», «Gói dịch vụ», «Cài đặt», «Kênh kết nối». Luật «nhóm Hệ thống, không phải Cài
  đặt» ở `docs/platform/help-guides.md:30` sửa thành: «dùng đúng tên menu của giao diện người đọc đang thấy».
- **Tầng liên hệ, bản đầu.** Một thành phần «Nhắn hỗ trợ» duy nhất, đọc `lib/constants/company.ts` (một nguồn), hiện ở ba chỗ:
  1. `/help`;
  2. ngăn «?»;
  3. cả 12 câu «liên hệ hỗ trợ» đang không có kênh, mỗi câu thành một link.
  Tin nhắn mở sẵn chỉ mang **mã cửa hàng**, không mang dữ liệu khách. Sổ yêu cầu (ticket) để sau, khi có số lượt liên hệ thật.
- **Lối vào.**
  - Thêm biểu tượng «?» ở thanh trên của điện thoại (cạnh chuông) và một dòng «Hướng dẫn» trong ngăn «Thêm».
  - Không thêm mục thứ 9 vào menu: thêm hay bớt mục là quyết định của chủ shop (`saas-nav.ts:73`).

## 6. Câu chữ cho người ít rành công nghệ

Sáu luật viết:
1. Câu ngắn, dưới 20 chữ. Động từ đứng đầu: «Bấm…», «Chọn…», «Dán…».
2. Gọi tên nút đúng chữ trên màn hình, đặt trong «».
3. Không tiếng Anh, không viết tắt. Từ nào bắt buộc phải dùng thì giải thích một lần ngay chỗ đó.
4. Một bước làm một việc. Có ảnh thì đặt ảnh ngay dưới bước.
5. Nói kết quả mong đợi: «Xong khi thấy chấm xanh cạnh tên Page».
6. Không đổ lỗi cho người dùng: viết «Chưa nối được», không viết «Lỗi». Việc chưa làm thì gọi là «Cần làm», không gọi là «Hỏng».
   Theo `docs/design-system.md` §9, trạng thái chưa biết không bao giờ được tô như trạng thái xấu.

Bảng thuật ngữ. Các từ ở cột trái là danh sách cấm cho bài kiểm ở §4:

| Đang thấy trong vỏ | Viết thay bằng |
|---|---|
| webhook | đường nhận tin |
| token, access token, App Secret | mã kết nối |
| Page ID | mã trang Facebook |
| module | tính năng |
| workspace | cửa hàng |
| ERP | phần mềm (hoặc «Chốt Đơn») |
| connector | kết nối |
| khoá AI riêng / BYOK | tài khoản AI riêng của shop |
| tên mô hình AI, USD | không hiện cho khách (đã có `lib/saas/visibility.ts`) |
| Field, tick, TEST | ô thông tin, đánh dấu, thử |
| Hỏng (bảng «AI đã sẵn sàng…») | Cần làm |
| Khách ngoài · Hoá đơn khách (trang Gói) | không hiện |

Ví dụ trước / sau, lấy từ bản chạy thử:

| Trước | Sau |
|---|---|
| «Kiểm tra kênh đã nối (fanpage / Messenger / Zalo / chat web) và webhook.» | «Chưa có tin khách nào. Mở «Kênh kết nối» xem đã nối Facebook chưa.» |
| «Workspace chưa có thuê bao sản phẩm nào — liên hệ người vận hành.» | «Bạn đang dùng thử Chốt Đơn Tự Động, còn 6 ngày. [Xem gói]» |
| «Bật module Giao vận (Hệ thống → Module của tổ chức) để nhận hành trình vận đơn Viettel Post.» | Không hiện trong vỏ: gói này không có giao vận |

## 7. Luồng vào việc 10 bước (§5): hợp nhất

**Các mảnh đang có, đang rời nhau:**

| Mảnh | Số bước | Hiện ở đâu | Vấn đề trong vỏ |
|---|---|---|---|
| Đăng ký nhanh `QuickStart` (`components/onboarding/quick-start.tsx`, `lib/onboarding/quick.ts:52-108`) | 1 màn | `/start` | Xong thì `redirect("/")` (`lib/actions/onboarding.ts:96`). Vỏ chặn `/` nên chuyển tiếp về Hộp thư RỖNG. Đo trên bản thử: trang trắng ~13 giây (`SHELL_AUDIT_2026-10-08.md` F-01) |
| `StartWizard` (`components/onboarding/start-wizard.tsx:40-47`) | 6–7 | `/start?day-du=1`, dành cho người vận hành | Khách vỏ không dùng tới |
| Danh sách «Việc cần làm» (`lib/onboarding/progress.ts:39-114`) | ≤ 9 | `/` và `/setup` | Có bước của ERP: «Tạo khách hàng đầu tiên», «Kết nối dịch vụ ngoài». Bước «Xem trang của mẫu» dẫn tới `/p/<slug>`, trang vỏ chặn (`app/(dashboard)/setup/page.tsx:81`) |
| Mốc go-live (`lib/onboarding/go-live-shared.ts:18-29`) | 7 | không màn hình nào hiện | — |
| `GoLiveCard` (`components/onboarding/go-live-card.tsx:57-231`) | 3 | chỉ ở `/` (`components/onboarding/getting-started.tsx:35-37`, `app/(dashboard)/page.tsx:55`) | Không bao giờ hiện trong vỏ. Dùng chữ Page ID / token / Webhook |
| Bảng sẵn sàng của AI (`lib/sales-chatbot/readiness-shared.ts:34-68`) | 9 | `/ai/sales-chatbot` | Nhãn «Hỏng» (`app/(dashboard)/ai/sales-chatbot/page.tsx:124`). Mục tồn kho dẫn tới `/inventory`, trang vỏ chặn (`readiness-shared.ts:48-49`) |

**Đề xuất: MỘT danh sách.**
- Hàm thuần `onboardingChecklist(input)` đặt ở `lib/onboarding/checklist-shared.ts` (tệp mới).
- Trạng thái của từng bước **suy ra từ dữ liệu thật** lúc đọc, không có cờ «đã xong» bấm tay.
- `progress.ts`, `go-live*` và bảng sẵn sàng trở thành các **cách hiển thị** của cùng hàm này.
- Mỗi bước dưới đây đọc lại nguồn đang có, không viết lại phép kiểm.

| # | Bước | Xong khi | Nguồn đang có | Bắt buộc trước khi bật AI thật? |
|---|---|---|---|---|
| 1 | Tạo cửa hàng | có tổ chức và người quản trị | QuickStart | có |
| 2 | Tên và logo cửa hàng | có logo, hoặc đã đổi tên hiển thị | `progress.ts` (branding) | không |
| 3 | Kết nối kênh bán hàng | ít nhất một Page / OA / ô chat web đang nhận tin | go-live `CHANNEL_CONNECTED`, sẵn sàng `CHANNEL` | có |
| 4 | Thêm sản phẩm có giá | ít nhất một mẫu mã có giá | sẵn sàng `PRICES`, go-live `CATALOG_READY` | có |
| 5 | Khai tồn kho | có phiếu nhập, hoặc shop chọn «bán không kiểm tồn» | sẵn sàng `STOCK` | không. Tồn chưa biết vẫn là trạng thái hợp lệ |
| 6 | Phí giao và cách thanh toán | đã khai phí giao | `/orders` đang báo «Phí giao: chưa khai» | chủ shop quyết (§9) |
| 7 | Dạy AI về shop | hồ sơ shop và chính sách có nội dung | go-live `AI_CONFIGURED` | có |
| 8 | Thử một đơn trong khung thử | đã lên được một đơn thử | sẵn sàng `TEST_ORDER`, go-live `TEST_PASSED` | có |
| 9 | Mời nhân viên và bật báo nhóm | có ≥ 2 người dùng, hoặc đã bật báo nhóm | `progress.ts` (people, notifications) | không |
| 10 | Bật AI trả lời khách thật | bot bật và đã nhận tin khách thật | sẵn sàng `BOT_ENABLED`, go-live `MESSAGING_READY` → `ACTIVATED` | — (đây là đích) |

**Hiển thị.**
- Thẻ gập trên đầu Hộp thư cho tới khi xong cả 10 bước. Hộp thư là trang về nhà của vỏ (`saas-nav.ts:106-109`).
- `/setup` hiện cùng danh sách đó.
- Bước nào dẫn tới trang thì link phải qua `shellAllows`.

Nếu chữ ở MASTER MISSION §5 khác bảng này thì đổi tên bước theo §5, giữ nguyên kiến trúc (một hàm thuần, nhiều cách hiển thị).

## 8. Thứ tự PR

| PR | Nội dung | Vùng tệp | Rủi ro |
|---|---|---|---|
| H1 | Help biết vỏ: trường `audience`, lọc theo vỏ, `shellAllows`, bài kiểm `href` qua `salesAgentPathAllowed`, sửa chữ «Hệ thống →», thêm 5 bài còn thiếu | `lib/constants/help-guides.ts`, `app/(dashboard)/help/page.tsx`, `tests/help-guides.test.ts`, `docs/platform/help-guides.md` | R1 |
| H2 | Tầng liên hệ: thành phần «Nhắn hỗ trợ», thay 12 câu không có kênh | `components/support-contact.tsx` (mới) và các trang có câu đó | R1. Chờ chủ shop chọn kênh |
| H3 | Nút «?» theo trang: bảng ánh xạ đường dẫn → bài, mở trong ngăn bên | `components/page-header.tsx`, `components/help-sheet.tsx` (mới) | R1 |
| H4 | Danh sách 10 bước hợp nhất: hàm thuần, thẻ trên Hộp thư, `/setup` | `lib/onboarding/checklist-shared.ts` (mới), `lib/onboarding/progress.ts`, `lib/onboarding/go-live*.ts`, chỉ MỘT chỗ chèn ở `app/(dashboard)/ai/sales-chatbot/inbox/page.tsx` | R1. Hẹn thứ tự với PR V2-3 của `INBOX_V2.md` vì cùng chạm `page.tsx` |
| H5 | Ảnh / GIF chụp từ workspace mẫu | `public/help/**` | R0–R1 |

## 9. Câu hỏi cho chủ shop

1. Kênh hỗ trợ chính thức cho khách Chốt Đơn là gì (Zalo OA, Messenger, email) và giờ trực ra sao?
2. Video hướng dẫn để ở đâu, công khai hay không công khai?
3. Trong 10 bước, bước nào bắt buộc xong trước khi cho bật AI trả lời khách thật? Đặc biệt là bước 6, phí giao.
4. Có muốn bỏ hẳn bước «Tạo khách hàng đầu tiên» khỏi danh sách của khách vỏ không? Khách của shop chat tự đến qua hội thoại.
