# Kiểm vỏ khách Chốt Đơn ở 390 px và 1366 px (08/10/2026)

*MASTER MISSION §4 (cùng §5, §34, §35) · lát D1 (R0) · đo trên bản build của `origin/main` `051f49a5`, chạy cục bộ. Đây là tài
liệu KIỂM TRA: không dòng mã nào đổi. Mọi cửa hàng và hội thoại dùng khi đo là dữ liệu giả. Ảnh chụp chỉ để trên máy người đo,
KHÔNG vào kho (kho PUBLIC). Sau lúc đo, main có thêm #661 (ô soạn: câu mẫu + dòng sản phẩm) và #660 (tài liệu). Không phát hiện
nào dưới đây phụ thuộc hai PR đó, và số dòng mã trích dẫn đã được đối chiếu lại trên `217cb26c`.*

Mức độ dùng trong tài liệu:
- **P0**: chặn khách trả tiền, hoặc làm sai dữ liệu tiền / thuê bao.
- **P1**: khách mới bị lạc hoặc hiểu nhầm. Phải sửa trước khi mở đăng ký rộng.
- **P2**: đánh bóng.

Viết tắt đường dẫn: `inbox/` = `app/(dashboard)/ai/sales-chatbot/inbox/`. Các đường ngắn khác như `ai/…`, `settings/…`,
`products/…`, `orders/…`, `customers/…`, `setup/…` đều nằm dưới `app/(dashboard)/`.

## 0. Tóm tắt

| ID | Mức | Phát hiện | Vùng sửa |
|---|---|---|---|
| F-01 | **P0** | Sau đăng nhập và sau đăng ký, vỏ hiện **trang trắng** ≥ 13 giây (đăng nhập: ≥ 40 giây vẫn trắng), trình duyệt điều hướng cùng một URL hàng nghìn lần | `lib/actions/auth.ts`, `lib/actions/onboarding.ts` |
| F-02 | **P0** | Cửa hàng tự đăng ký không có thuê bao sản phẩm. Trang Gói báo «liên hệ người vận hành» và lộ nhãn nội bộ | `lib/onboarding/service.ts`, `components/saas/my-products.tsx` |
| F-03 | P1 | Đăng ký xong rơi vào Hộp thư rỗng, không chỉ bước tiếp theo. Thẻ «Bắt đầu» không bao giờ hiện trong vỏ | `app/(dashboard)/ai/sales-chatbot/inbox/page.tsx`, `lib/onboarding/*` |
| F-04 | P1 | Trên điện thoại, trang AI Sales tự cuộn xuống đáy (7.532 / 8.889 px) | `components/sales-chat/chat-panel.tsx` |
| F-05 | P1 | Trang Hướng dẫn dẫn vào 4 trang bị chặn và dùng chữ của ERP | `lib/constants/help-guides.ts` |
| F-06 | P1 | Trang «Kết nối theo tổ chức» lộ kết nối của ERP (Viettel Post…) kèm hướng dẫn vào một trang bị chặn | `app/(dashboard)/settings/connections/*`, `components/connectors/*` |
| F-07 | P1 | Bảng «AI đã sẵn sàng…» gọi việc chưa làm là «Hỏng», bảo «liên hệ hỗ trợ» mà không có kênh, và dẫn vào `/inventory` (bị chặn) | `app/(dashboard)/ai/sales-chatbot/page.tsx`, `lib/sales-chatbot/readiness-shared.ts` |
| F-08 | P1 | Thuật ngữ kỹ thuật lộ ra khách ở 9 trang | nhiều tệp, khoá bằng `tests/saas-hide-internal.test.ts` |
| F-09 | P2 | «Nhân viên» là trang quản trị quyền của ERP: 776 ô đánh dấu, cao 4.462 px trên điện thoại | `app/(dashboard)/settings/users/*` |
| F-10 | P2 | Tên trên menu khác tiêu đề trang | các `page.tsx` của vỏ |
| F-11 | P2 | Thiếu ba khu ORDERS · AUTOMATIONS · ANALYTICS. Đường lạ ra trang 404 tiếng Anh, không có vỏ | `lib/constants/saas-nav.ts` (chủ shop quyết), `app/not-found.tsx` (mới) |
| F-12 | P2 | `/settings/ai-balance` khi cờ tắt báo «Không tìm thấy dữ liệu… không có quyền xem» | `app/(dashboard)/settings/ai-balance/*` |
| F-13 | P2 | Điện thoại: thẻ số liệu chiếm hết màn đầu. `/orders` tô sáng mục «Hội thoại» | `products/`, `settings/users/`, `orders/` |
| F-14 | P2 | Thanh điều khiển AI trong hội thoại cao ~130 px, nói một ý ba lần, in đôi một cụm chữ | `app/(dashboard)/ai/sales-chatbot/inbox/control-bar.tsx` |
| F-15 | P2 | Có chữ chỉ đường mà không bấm được, hoặc chỉ tới chỗ không tồn tại. Banner «BẢN NHÁP» trên mọi trang dẫn vào `/setup` đầy chữ ERP | `ai/overview/`, `ai/channels/`, `setup/`, `(dashboard)/layout.tsx` |
| F-16 | P2 | Định dạng và thương hiệu: ngày ISO · «0.0%» khi mẫu số bằng 0 · biểu tượng thông báo đẩy của VNX | `lib/pricing/versions.ts`, `customers/page.tsx`, `public/sw.js` |

Những chỗ đã làm tốt (giữ nguyên):
- Đăng ký chỉ một màn, ngành «Chỉ cần AI bán hàng» được chọn sẵn trên host Chốt Đơn. Tạo xong trong ~8 giây (3/3 lượt).
- Trang bị chặn thì chuyển về Hộp thư kèm câu «Trang này không có trong gói Chốt Đơn».
- **0/19 đường bị tràn ngang ở 390 px.**
- Thanh dưới gồm 4 mục và «Thêm».
- Tổng quan phân biệt «—» với «0 ₫» (AGENTS 42).
- Trang Cài đặt ngắn và rõ.
- Ô soạn tin bỏ qua phím Enter khi bộ gõ tiếng Việt đang ghép chữ.

## 1. Cách đo (chạy lại được)

1. Dựng cây riêng theo `origin/main`, nối `node_modules` bằng junction, chạy `npm run build`.
2. Tạo CSDL PGlite và tài khoản quản trị: `DATABASE_URL="pglite://./data/pglite-dev" ADMIN_EMAIL=… ADMIN_PASSWORD=… AUTH_SECRET=…
   npx tsx --tsconfig tsconfig.json scripts/seed-admin.ts`.
3. Mở đăng ký, **chỉ trên CSDL thử**:
   - dòng `platform_settings('platform.signup.mode') = 'open'`;
   - biến `PLATFORM_SIGNUP_MODE=open`.
   Production vẫn để `off` / `invite` (`docs/platform/launch-gates.md` mục B).
4. Chạy `npx next start -p 3300` với `CHOTDON_DOMAIN=chotdon.test` và `CHOTDON_APP_URL=http://app.chotdon.test:3300`.
   `brandOfHost` (`lib/platform/site-host.ts`) nhờ đó nhận host `app.chotdon.test` là thương hiệu Chốt Đơn.
5. Mở Chrome hệ thống ở chế độ headless qua `playwright-core`, với cờ `--host-resolver-rules="MAP app.chotdon.test 127.0.0.1"`.
   Không dùng cổng 9222 dùng chung. Rồi làm:
   - đăng ký 3 cửa hàng giả qua `/start`;
   - kiểm **19 đường × 2 khổ** (390×844 cảm ứng, 1366×768). Mỗi đường đo: đích sau chuyển hướng · `h1` · chữ nhìn thấy (quét
     thuật ngữ) · có tràn ngang không · link vào trang vỏ chặn (theo đúng `SALES_AGENT_ALLOWED_PREFIXES` / `DENIED`) · số phần tử
     bấm nhỏ hơn 32 px;
   - gieo 40 hội thoại giả vào CSDL của một cửa hàng để đo hộp thư có dữ liệu (`INBOX_V2.md` §1).
6. **Không tính là phát hiện**, vì chỉ do môi trường thử:
   - ứng dụng Facebook chưa cấu hình, nên Kênh kết nối báo «đang được bảo trì»;
   - thiếu khoá bí mật nền tảng, nên Kết nối báo «Chưa lưu được bí mật kết nối».
   Số ms đo cục bộ cũng không dùng làm số hiệu năng.

## 2. Các khu của vỏ: có / thiếu

Tám mục vỏ khai ở `lib/constants/saas-nav.ts:74-83`. Đối chiếu với 9 khu của MASTER MISSION:

| Khu | Hiện có trong vỏ | Bằng chứng | Đánh giá |
|---|---|---|---|
| HOME | «Tổng quan» (`/ai/overview`): số liệu AI 30 ngày. Còn `/` thì chuyển thẳng về Hộp thư | `saas-nav.ts:75`, `:106-109` | Có trang, nhưng không phải «trang nhà»: không có việc cần làm, không có trạng thái kênh (F-03) |
| INBOX | «Hội thoại» | `saas-nav.ts:76` | Có, xem `INBOX_V2.md` |
| ORDERS | Không có mục menu. `/orders` mở như trang phụ của «Hội thoại» | `saas-nav.ts:76` (`owns`), `:119-122` | **Thiếu mục**. Danh sách đơn chỉ vào được qua hội thoại. Trên điện thoại, mở `/orders` thì thanh dưới tô sáng «Hội thoại» |
| PRODUCTS | «Sản phẩm» và trang con `/inventory/receipts` | `saas-nav.ts:78` | Có. Bảng nặng chữ kho của ERP (F-08) |
| CHANNELS | «Kênh kết nối» (`/ai/channels`). Trên điện thoại nằm trong «Thêm» | `saas-nav.ts:79`, `:86` | Có. Không có trên thanh dưới |
| AI SALES | «AI Sales», nhưng tiêu đề trang là «Chatbot bán hàng» | `saas-nav.ts:77` | Có. Tên không khớp (F-10) |
| AUTOMATIONS | Không có. `/automations` ra 404 | — | **Thiếu** (F-11) |
| ANALYTICS | Không có mục riêng. «Hiệu quả» chỉ là một nút trong AI Sales | — | **Thiếu** (F-11) |
| SETTINGS · PLAN · HELP | «Nhân viên», «Gói dịch vụ», «Cài đặt». Hướng dẫn nằm trong Cài đặt | `saas-nav.ts:80-82` | Có. Hướng dẫn không có lối trên menu (`HELP_CENTER.md` §5) |

## 3. Đăng ký và đăng nhập đưa người dùng tới đâu

Luồng đăng ký:
1. Bấm «Tạo cửa hàng» ở `/start`.
2. `quickSignupAction` gọi `redirect("/")` (`lib/actions/onboarding.ts:96`).
3. Vỏ chặn `/` (`lib/auth/session.ts:281`, `:435`) và chuyển về trang nhà của vỏ là Hộp thư (`saas-nav.ts:201-205`).

Hộp thư lúc này **rỗng**. Thẻ «Bắt đầu» và GoLiveCard chỉ dựng ở `/` (`app/(dashboard)/page.tsx:55`), nên không bao giờ hiện
trong vỏ (F-03).

**F-01: trang trắng sau đăng nhập và sau đăng ký** (đo bằng sự kiện `framenavigated` của khung chính và các lần xin RSC):

| Lượt | Đường đi | Thời gian trắng | Điều hướng cùng URL | Xin RSC trong lúc trắng |
|---|---|---|---|---|
| Đăng ký, 390 px | `/start` → `/` → hộp thư | ~13 giây rồi tự hiện | 4.328 | 1 |
| Đăng nhập vỏ, 390 px, host Chốt Đơn | `/login` → `/` → hộp thư | ≥ 15 giây, chưa hiện | 7.244 trong 15 giây | 1 |
| Đăng nhập vỏ, 390 px, host `localhost` | như trên | ≥ 40 giây, chưa hiện | 17.633 trong 40 giây | 2 |
| Đăng nhập vỏ, 1366 px | như trên | ≥ 15 giây, chưa hiện | 7.820 trong 15 giây | 1 |
| *Đối chứng:* đăng nhập tổ chức nhà (ERP) | `/login` → `/` (dựng tại chỗ) | ~1,1 giây | 1 | — |
| *Đối chứng:* trong vỏ, bấm menu «Hội thoại» | điều hướng phía client | bình thường | 2, rồi +1 mỗi 5 giây (lượt làm mới) | — |
| *Đối chứng:* trong vỏ, tải hẳn trang hộp thư | tải đầy đủ | bình thường | — | — |

Vòng lặp chỉ xảy ra trên chuỗi: server action `redirect("/")` → trang `/` bị vỏ chặn → máy chủ `redirect(hộp thư)`. Không có lỗi
console, không có lỗi trang. Tải lại trang thì hiện bình thường.

**SUY LUẬN, chưa truy tới gốc:** bộ định tuyến phía client của Next 15.5 xử lý sai một lượt chuyển hướng lồng trong RSC của trang
đích sau khi server action đã chuyển hướng.

## 4. Trạng thái rỗng có trả lời «đây là gì · làm gì · bấm đâu» không

Đo trên cửa hàng vừa tạo:

| Trang | Chữ đang hiện | Đây là gì | Làm gì | Bấm đâu |
|---|---|---|---|---|
| Hội thoại | «Không có hội thoại nào ở bộ lọc này.» và «Chọn một hội thoại để trả lời · Không có khách nào đang chờ trả lời.» (`inbox/page.tsx:338`, `:354-359`) | ✗ | ✗ | ✗ |
| Tổng quan | «AI chưa trả lời khách nào … Kết nối fanpage ở mục **Kênh kết nối**.» (`ai/overview/page.tsx:85-87`) | ✓ | ✓ | ✗ (chữ đậm, không phải link) |
| AI Sales | bảng «AI đã sẵn sàng…» 9 mục, và «Chưa có hội thoại nào.» | ✓ | ✓ | một phần: link `/inventory` bị chặn (F-07) |
| Sản phẩm | «Không có mẫu mã · Thử đổi bộ lọc hoặc từ khoá. Chưa có mã hàng nào thì bấm «Tạo sản phẩm».» (`products/products-table.tsx:75`, `lib/branding/copy.ts:81`) | một phần | ✓ | ✓, nhưng trên điện thoại nằm dưới 3 thẻ số liệu (F-13) |
| Kênh kết nối | «Chưa có kênh nào» kèm nút «Kết nối Facebook» (`ai/channels/channels-panel.tsx:350-352`) | ✓ | ✓ | ✓ (khi ứng dụng Meta đã sẵn sàng) |
| Đơn hàng | 4 ô «0» và «Không có đơn hàng · Thử đổi khoảng thời gian hoặc bộ lọc» (`orders/orders-table.tsx:53`) | ✗: không nói đơn đến từ hội thoại | ✗ | chỉ có «Tạo đơn hàng» |
| Gói dịch vụ | «Workspace chưa có thuê bao sản phẩm nào — liên hệ người vận hành.» (`components/saas/my-products.tsx:11`) | ✗ | ✗ | ✗ (F-02) |
| Cài đặt · Nhân viên | danh sách mục / danh sách một người | ✓ | ✓ | ✓ |

## 5. Ngôn ngữ kỹ thuật lộ ra khách

Quét chữ nhìn thấy trên từng trang (cùng kết quả ở 390 px và 1366 px):

| Trang | Từ lộ ra | Nguồn (ví dụ) |
|---|---|---|
| AI Sales | «ERP» ×2 · «webhook» · «Field không tick…» · «Khung thử (TEST)» · «Trang chat công khai có sau khi ERP được xuất bản» | `ai/sales-chatbot/config-form.tsx:286`, `:292`; `ai/sales-chatbot/page.tsx:247`, `:295`; `lib/sales-chatbot/readiness-shared.ts:55` |
| Kết nối theo tổ chức | «16 connector trong sổ» · «module» ×5 · «webhook» · «API» · «ERP» ×2 | `settings/connections/page.tsx:51`; `components/connectors/org-carrier-panel.tsx:20` |
| Gói dịch vụ | «workspace» · «Khách ngoài · Hoá đơn khách» · tính năng «API» | `components/saas/my-products.tsx:9-11`, `lib/pricing/features.ts:49` |
| Thiết lập & xuất bản | «ERP» ×4 · tên module nội bộ | `setup/page.tsx:109-110` |
| Hướng dẫn | «ERP» ×3 · «Hệ thống → …» | `lib/constants/help-guides.ts:57`, `:62` |
| Sản phẩm | «0 kho» · «Tồn khả dụng ERP» · các cột ĐÃ XUẤT / ĐANG Ở NGOÀI / ĐƠN GTC / TỶ LỆ GTC | `products/page.tsx:34-36`, `:103` |
| Khách hàng | «Khách hàng được tạo tự động khi đồng bộ đơn» | `customers/customers-table.tsx:27` |
| Nhân viên | «quyền theo từng module» · «Chức danh» · «Vai trò tuỳ chỉnh» | `settings/users/page.tsx:78`, `:131-133` |
| Hộp thư | chip «Direct» / «Pancake» | `lib/sales-chatbot/inbox-shared.ts:35` |

Đã được che từ trước, giữ nguyên: tên mô hình AI, USD và chi phí trên trang Hiệu quả; tên công cụ trong khung thử; dấu vết AI
trong hộp thư (`lib/saas/visibility.ts`). Bảng chữ thay thế nằm ở `HELP_CENTER.md` §6.

## 6. Bố cục trên điện thoại (390 px)

| Điểm đo | Kết quả |
|---|---|
| Tràn ngang | 0/19 đường (`scrollWidth = clientWidth` ở mọi trang) |
| Thanh dưới | Hội thoại · Tổng quan · AI Sales · Sản phẩm · Thêm (`saas-nav.ts:86`). «Kênh kết nối», «Nhân viên», «Gói dịch vụ», «Cài đặt» nằm trong «Thêm» |
| Hộp thư | Khối lọc cao 214 px. Dòng hội thoại đầu bắt đầu ở y = 474, thấy trọn 3 dòng. Mở một hội thoại thì phần đầu khung và thanh điều khiển AI chiếm ~290 px, timeline còn ~210 px (F-14) |
| AI Sales | Tự cuộn tới `scrollY = 7.532` trên tổng 8.889 px ngay khi mở (F-04) |
| Sản phẩm · Nhân viên · Đơn hàng | 3–4 thẻ số liệu chiếm cả màn đầu, việc chính nằm dưới nếp gấp (F-13) |
| Nhân viên | 776 ô đánh dấu nhỏ hơn 32 px, trang cao 4.462 px (F-09) |
| Phần tử bấm < 32 px (khác ô đánh dấu) | Hộp thư 28 · AI Sales 41 · Hướng dẫn 30 · Thiết lập 27 |

## 7. Phát hiện chi tiết

### F-01 · P0 · Trang trắng sau đăng nhập / đăng ký
- **Bằng chứng:** bảng ở §3. Lặp lại được 7/7 lượt đo, ở cả hai khổ và cả hai host. Đối chứng ERP nhà không lỗi.
- **Đề xuất:**
  1. Đưa đích cuối vào chính action. Nếu người dùng thuộc vỏ thì `redirect(salesAgentHomeFor(user))` một bước, áp cho
     `loginAction` (`lib/actions/auth.ts:81`, hiện là `safeNextPath(next)`) và cho `quickSignupAction`
     (`lib/actions/onboarding.ts:96`). Tham số `next` nào không qua `salesAgentPathAllowed` thì cũng về trang nhà vỏ.
  2. Thêm bài kiểm trình duyệt: đăng nhập vỏ thì `h1` của hộp thư phải hiện trong ≤ 3 giây, và số lần điều hướng ≤ 5.
  3. Truy gốc vòng lặp trong Next để chặn những đường khác cùng mẫu (server action chuyển hướng tới một trang mà vỏ chặn).
- **Vùng:** `lib/actions/auth.ts`, `lib/actions/onboarding.ts` (dùng lại `salesAgentHomeFor`). **R3**, vì chạm đường đăng nhập.

### F-02 · P0 · Tự đăng ký mà không có thuê bao sản phẩm
- **Bằng chứng:**
  - Trang Gói của cả 3 cửa hàng vừa tạo hiện «Workspace chưa có thuê bao sản phẩm nào — liên hệ người vận hành.», kèm mô tả «Khách
    ngoài · Hoá đơn khách · workspace …» (`components/saas/my-products.tsx:9-11`).
  - **SUY LUẬN** về nguyên nhân: `/start` gọi `provisionOrganization` với `modules: CORE_MODULES` (`lib/onboarding/service.ts:339`).
    Bước mở thuê bao `openSubscriptionsForProductsInUse` (`lib/platform/provision.ts:113-114`) vì vậy chạy khi chưa bật `ai_sales`.
    Mẫu ngành cài sau đó không mở thuê bao. Kiểm kê 08/10 (B#37) đã ghi «`/start` đi đường riêng».
  - Ảnh hưởng: khách thấy câu như báo lỗi, và số thuê bao / MRR theo sản phẩm thiếu các cửa hàng tự đăng ký.
- **Đề xuất:**
  1. Đếm trên production bằng thao tác chỉ đọc: workspace `brand = 'chotdon'` không có dòng nào trong `platform_product_subscriptions`.
  2. Mở thuê bao sau khi cài mẫu (hoặc khi bật module), idempotent.
  3. Câu cho khách: «Đang dùng thử Chốt Đơn Tự Động — còn N ngày». Ẩn `account.type` / `billing` thô.
- **Vùng:** `lib/onboarding/service.ts`, `lib/saas/accounts.ts` (dùng lại hàm đang có), `components/saas/my-products.tsx`.
  **R3**: thuê bao / thu phí, nên có thể bị xếp CRITICAL theo `docs/saas/HANDOFF.md` §3.

### F-03 · P1 · Không có bước tiếp theo sau khi đăng ký
- **Bằng chứng:** §3 và §4. Hộp thư rỗng không có nút «Kết nối kênh». Danh sách việc (`lib/onboarding/progress.ts:39-114`) chỉ
  hiện ở `/` và `/setup`. GoLiveCard chỉ có ở `/`.
- **Đề xuất:**
  1. Khi cửa hàng chưa có kênh nào, Hộp thư có trạng thái rỗng riêng: «Chưa có tin khách vì shop chưa nối kênh bán hàng.
     [Kết nối Facebook] [Đặt ô chat lên website]».
  2. Thẻ «Việc cần làm» 10 bước (`HELP_CENTER.md` §7) đặt trên đầu Hộp thư.
- **Vùng:** `app/(dashboard)/ai/sales-chatbot/inbox/page.tsx` (một chỗ chèn), `lib/onboarding/checklist-shared.ts` (mới). **R1.**

### F-04 · P1 · AI Sales tự cuộn xuống đáy trên điện thoại
- **Bằng chứng:**
  - Đo ngay sau khi mở: `scrollY = 7.532 / 8.889` ở 390 px, `0` ở 1366 px.
  - Nguyên nhân: khung thử gọi `bottom.current?.scrollIntoView({ block: "end" })` ngay lần dựng đầu và mỗi khi `view` /
    `pending` đổi (`components/sales-chat/chat-panel.tsx:36-38`). Trên một cột, lệnh đó cuộn cả trang.
  - Hậu quả: bảng «AI đã sẵn sàng…» và phần cấu hình nằm khuất phía trên.
- **Đề xuất:** chỉ cuộn khung tin (`scrollTop = scrollHeight` của phần tử chứa), không gọi `scrollIntoView`.
- **Vùng:** `components/sales-chat/chat-panel.tsx`. Thành phần này dùng chung với trang chat công khai, nên phải kiểm cả hai.
  **R1.**

### F-05 · P1 · Hướng dẫn dẫn vào trang bị chặn
- **Bằng chứng:**
  - 4/13 bài: `help-guides.ts:84-91`, `:126-134`, `:155-163`, `:169-177`.
  - Câu chữ «Hệ thống → Người dùng» (`:62`), «Mời nhân viên vào ERP» (`:55-57`).
  - Đo trên bản thử: bấm vào thì bị chuyển về Hộp thư kèm câu «ngoài gói».
- **Đề xuất:** làm theo `HELP_CENTER.md` §4–§5: trường `audience`, `shellAllows`, bài kiểm `href` qua `salesAgentPathAllowed`.
- **Vùng:** `lib/constants/help-guides.ts`, `app/(dashboard)/help/page.tsx`, `tests/help-guides.test.ts`. **R1.**

### F-06 · P1 · Kết nối của ERP lộ trong vỏ
- **Bằng chứng:**
  - `/settings/connections` (mục «Kênh kết nối» sở hữu trang này, `saas-nav.ts:79`) hiện «16 connector trong sổ»
    (`settings/connections/page.tsx:51`).
  - Có khung Viettel Post với câu «Bật module Giao vận (Hệ thống → Module của tổ chức)…»
    (`components/connectors/org-carrier-panel.tsx:20`). Trang được nhắc tới, `/settings/modules`, bị vỏ chặn.
  - Kiểm kê B#4 đã ghi «module chưa mua vẫn hiện ở `/settings/connections`».
- **Đề xuất:** lọc kết nối theo sản phẩm của workspace (danh mục `lib/saas/catalog.ts`). Vỏ Chốt Đơn chỉ còn Facebook / Pancake /
  Zalo / chat web. Câu chữ theo bảng thuật ngữ.
- **Vùng:** `app/(dashboard)/settings/connections/page.tsx`, `components/connectors/*`. **R1.**

### F-07 · P1 · Bảng «AI đã sẵn sàng…» làm khách hoảng
- **Bằng chứng:**
  - Nhãn «Hỏng» cho trạng thái FAIL (`app/(dashboard)/ai/sales-chatbot/page.tsx:124`). Cửa hàng mới thấy «Hỏng» ở «Bot đang tắt»,
    «Cần cấu hình», «Chưa có mẫu mã nào có giá».
  - «Bộ phận hỗ trợ đang hoàn tất cấu hình AI cho shop — liên hệ hỗ trợ nếu cần gấp» (`lib/saas/visibility.ts:82`) mà không có
    kênh liên hệ.
  - Mục tồn kho dẫn tới `/inventory` (`lib/sales-chatbot/readiness-shared.ts:48-49`), trang vỏ chặn.
  - `docs/design-system.md` §9: trạng thái chưa biết không được tô như trạng thái xấu.
- **Đề xuất:**
  1. Đổi nhãn thành «Cần làm» / «Nên làm» / «Xong».
  2. Link qua `shellAllows`, mục tồn kho trỏ `/inventory/receipts`.
  3. Câu «liên hệ hỗ trợ» dùng thành phần liên hệ của `HELP_CENTER.md` §5.
  4. Về lâu dài, bảng này là một cách hiển thị của danh sách 10 bước.
- **Vùng:** hai tệp trên. **R1.**

### F-08 · P1 · Thuật ngữ kỹ thuật lộ ra khách
- **Bằng chứng:** bảng ở §5.
- **Đề xuất:**
  1. Đưa danh sách cấm (`HELP_CENTER.md` §6) vào `tests/saas-hide-internal.test.ts` cho các trang vỏ.
  2. Sửa chữ theo bảng thay thế. Trang dùng chung với ERP thì rẽ nhánh theo `isSalesAgentUser`, giống cách vỏ đã làm ở
     `app/(dashboard)/layout.tsx:64` (`shell ? "cửa hàng" : "ERP này"`).
- **Vùng:** các trang trong `SALES_AGENT_ALLOWED_PREFIXES`. **R1.**

### F-09 · P2 · «Nhân viên» là trang quản trị quyền của ERP
- **Bằng chứng:** 5 khối «Danh sách người dùng · Lời mời · Vai trò tuỳ chỉnh · Chức danh · Vai trò hệ thống & quyền». Có 776 ô
  đánh dấu quyền. Trang cao 4.462 px ở 390 px.
- **Đề xuất:** trong vỏ chỉ giữ danh sách người, lời mời và 3 vai trò dễ hiểu (Chủ shop · Nhân viên bán hàng · Chỉ xem). Ma trận
  quyền đặt sau một nút «Nâng cao». Không đổi mô hình quyền (AGENTS 28–31).
- **Vùng:** `app/(dashboard)/settings/users/*`. **R1.** Đổi quyền hay vai trò thì phải hỏi chủ shop (AGENTS §7).

### F-10 · P2 · Tên trên menu khác tiêu đề trang

| Menu | Tiêu đề trang | Nhãn nhỏ trên tiêu đề |
|---|---|---|
| Hội thoại | Hộp thư khách | «AI» (`inbox/page.tsx:193`) |
| AI Sales | Chatbot bán hàng | «AI» (`ai/sales-chatbot/page.tsx:85`) |
| Sản phẩm | Sản phẩm & tồn kho | «Kho» (`products/page.tsx:34`) |
| Nhân viên | Người dùng | «Hệ thống» (`settings/users/page.tsx:76`) |
| Gói dịch vụ | Gói & thanh toán | «Hệ thống» (`settings/plan/page.tsx:50`) |

- **Đề xuất:** trong vỏ, tiêu đề trang dùng đúng nhãn menu, và bỏ nhãn nhỏ của ERP.
- **Vùng:** các `page.tsx` kể trên. **R1.**

### F-11 · P2 · Thiếu ORDERS · AUTOMATIONS · ANALYTICS; 404 tiếng Anh
- **Bằng chứng:**
  - §2.
  - `/automations` ra trang mặc định «404 · This page could not be found.», không có vỏ và không có lối về. Kho chỉ có
    `app/(dashboard)/not-found.tsx`, không có `app/not-found.tsx`.
- **Đề xuất:**
  1. `app/not-found.tsx` bằng tiếng Việt, có nút về trang nhà. Việc này R1, làm ngay được.
  2. Thêm mục Đơn hàng, Tự động hoá, Hiệu quả vào menu là **quyết định của chủ shop**: bài kiểm khoá con số 8 (`saas-nav.ts:73`).
     Trước mắt, «Hiệu quả» có thể là một thẻ trong Tổng quan và «Đơn» một thẻ trong Hội thoại.
- **Vùng:** `app/not-found.tsx` (mới), `lib/constants/saas-nav.ts`. **R1** / **R4** (menu).

### F-12 · P2 · Số dư AI khi cờ tắt báo «không có quyền»
- **Bằng chứng:** `/settings/ai-balance` thuộc mục «Gói dịch vụ» (`saas-nav.ts:81`). Khi cờ `ai_balance.enabled` tắt, trang hiện
  «Không tìm thấy dữ liệu — Bản ghi không tồn tại, đã bị xoá hoặc bạn không có quyền xem».
- **Đề xuất:** đổi thành «Số dư AI chưa mở cho cửa hàng của bạn» kèm link về Gói dịch vụ.
- **Vùng:** `app/(dashboard)/settings/ai-balance/*`. **R1.**

### F-13 · P2 · Điện thoại: thẻ số liệu chiếm màn đầu
- **Bằng chứng:**
  - Sản phẩm: 3 thẻ «0» đứng trước nút và danh sách.
  - Nhân viên: 3 thẻ «1».
  - Đơn hàng: 4 ô «0».
  - `/orders` được mục «Hội thoại» sở hữu (`saas-nav.ts:76`), nên thanh dưới tô «Hội thoại» khi đang xem đơn.
- **Đề xuất:** dưới 640 px, gom các thẻ thành một dòng tóm tắt và đưa trạng thái rỗng / việc chính lên trước. Khi có mục Đơn
  (F-11) thì bỏ `owns: ["/orders"]`.
- **Vùng:** `products/page.tsx`, `settings/users/page.tsx`, `orders/page.tsx`. **R1.**

### F-14 · P2 · Thanh điều khiển AI trong hội thoại
- **Bằng chứng:**
  - Cao ~130 px ở 1366 px. Nói «AI chưa sẵn sàng» ba lần.
  - Cụm «đội ngũ đang xử lý» in hai lần liền: lý do đã chứa cụm này (`lib/saas/visibility.ts:208`), và
    `inbox/control-bar.tsx:179` in thêm khi `hideCodes`.
- **Đề xuất:** một dòng trạng thái kèm một nút chính, chi tiết đặt trong popover (`INBOX_V2.md` §2).
- **Vùng:** `app/(dashboard)/ai/sales-chatbot/inbox/control-bar.tsx`. **R1.**

### F-15 · P2 · Chữ chỉ đường không bấm được, hoặc chỉ tới chỗ không có
- **Bằng chứng:**
  - Tổng quan: «Kênh kết nối» là chữ đậm, không phải link (`ai/overview/page.tsx:85-87`).
  - Kênh trống: «Nối ở Cài đặt → Kết nối» (`ai/channels/channels-panel.tsx:351`), trong khi trang Cài đặt của vỏ không có mục
    «Kết nối» (`settings/shop/page.tsx:20-27`).
  - Banner «BẢN NHÁP — cửa hàng chưa xuất bản…» hiện trên mọi trang (`app/(dashboard)/layout.tsx:64`) và dẫn vào `/setup`. Trang
    `/setup` có «Xem trước ERP», tên module nội bộ, link `/p/<slug>` bị chặn (`setup/page.tsx:81`), và các link sửa lỗi xuất bản
    vào trang bị chặn (`lib/platform/publish.ts:156`, `:170`, `:187`).
  - Với shop chỉ bán qua Facebook, «xuất bản» không liên quan tới việc nhận tin.
- **Đề xuất:**
  1. Biến chữ chỉ đường thành link.
  2. Thêm mục «Kết nối» vào Cài đặt vỏ, hoặc sửa câu.
  3. Chỉ hiện banner khi shop dùng trang chat công khai. Còn lại thì đưa việc xuất bản vào danh sách 10 bước.
  4. `/setup` trong vỏ lọc link bằng `shellAllows`.
- **Vùng:** các tệp kể trên. **R1.**

### F-16 · P2 · Định dạng và thương hiệu
- **Bằng chứng:**
  - Trang Gói ghi ngày kiểu ISO («bắt đầu ghi từ 2026-10-08», `lib/pricing/versions.ts:574`). AGENTS §1 yêu cầu giờ Việt Nam qua
    `lib/format.ts`.
  - Trang Khách hàng in «Tỷ lệ hoàn 0.0% — 0 đơn hoàn / 0 đơn»:
    - dùng `pct` thay cho `pctOrNull` (`customers/page.tsx:42`; hai hàm ở `lib/format.ts:195`, `:205`), trái AGENTS 42 vì mẫu số bằng 0 phải in «—»;
    - dấu chấm thập phân;
    - ngưỡng màu viết cứng `>= 10` (`:75`, AGENTS 38).
  - Thông báo đẩy dùng tiêu đề «VNXcommerce ERP» và biểu tượng VNX (`public/sw.js:15`, `:18-19`).
  - Trang tài khoản ghi «Cài ERP lên màn hình chính» (`app/(dashboard)/settings/profile/page.tsx:49`).
- **Đề xuất:** dùng `lib/format.ts` và `pctOrNull`. Tiêu đề và biểu tượng của service worker lấy theo thương hiệu của host
  (`brandOfHost`). Đổi câu cài đặt PWA.
- **Vùng:** các tệp kể trên. **R1** (riêng `public/sw.js` là việc D5 của kiểm kê).

## 8. Gắn với các tài liệu thiết kế khác

| Phát hiện | Tài liệu xử lý |
|---|---|
| F-03, F-05, F-07, F-15 | `HELP_CENTER.md`: danh sách 10 bước, ba tầng trợ giúp, tầng liên hệ |
| F-14, Hộp thư (§6) | `INBOX_V2.md` §2, §4 |
| F-01, F-02 | Sửa ngay, không cần thiết kế thêm. Cả hai thuộc danh sách chặn khách trả tiền của sứ mệnh `saas-e2e-customer` |
