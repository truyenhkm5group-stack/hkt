# Shop Control ERP — Quản trị nội bộ shop thời trang online

Hệ thống ERP nội bộ đồng bộ **đơn hàng, khách hàng, sản phẩm, tồn kho, đổi/trả** từ **Pancake POS** và **trạng thái vận đơn, COD** từ **Viettel Post**, rồi gom về một chỗ để vận hành, đối soát tiền và tính lợi nhuận thực.

```
Pancake POS ──(API + webhook)──▶  ERP  ◀──(API + webhook)── Viettel Post
                                   │
   Tổng quan · Đơn hàng · Vận đơn · Đối soát COD · Sản phẩm & tồn kho · Nhật ký kho
   Khách hàng · Đổi/trả · Chi phí & quảng cáo · Báo cáo lợi nhuận · Kết nối dữ liệu · Người dùng · Nhật ký
```

## Tính năng chính

| Module | Nội dung |
|---|---|
| **Tổng quan** | KPI doanh thu/giao thành công/COD chờ về/lợi nhuận ước tính, biểu đồ theo ngày, luồng trạng thái đơn, kênh bán, vận đơn & COD, sản phẩm bán chạy, việc cần xử lý. Tự làm mới khi có webhook (realtime). |
| **Đơn hàng** | Toàn bộ đơn Pancake (mọi trạng thái, kể cả đã xoá) với sản phẩm, khách, ĐVVC, mã vận đơn, COD; lọc theo kỳ/trạng thái/kênh/ĐVVC/nhân viên; tìm theo mã đơn, SĐT, tên, mã vận đơn, SKU; chi tiết đơn với lịch sử trạng thái, hành trình vận đơn, lãi gộp từng đơn; xuất CSV. |
| **Vận đơn** | Vận đơn từ Pancake + Viettel Post (kể cả đơn tạo trực tiếp trên Viettel Post), hành trình đầy đủ (webhook/tra cứu), giao thất bại, hoàn, quá hạn; cập nhật từ Viettel Post theo lô hoặc từng đơn; lịch sử đẩy webhook & gửi lại. |
| **Đối soát COD** | Chưa thu → đã thu → ĐVVC đã đối soát → đã về ngân hàng → chênh lệch; tạo đợt nhận tiền (bảng kê), đánh dấu hàng loạt, xuất CSV. |
| **Sản phẩm & tồn kho** | Mẫu mã (màu/size), giá bán, giá vốn, tồn khả dụng/thực tế **theo từng kho**, bán 30 ngày, giá trị tồn, sắp hết/hết hàng; chi tiết sản phẩm + nhật ký xuất nhập kho. |
| **Khách hàng** | Hồ sơ khách từ Pancake, số đơn/thành công/hoàn, lịch sử mua. |
| **Đổi / trả** | Phiếu đổi trả từ Pancake. |
| **Chi phí & quảng cáo** | Chi phí vận hành theo nhóm, chi tiêu quảng cáo theo nền tảng (ROAS, CPO). **Nhập sao kê MB Bank** (JSON/CSV xuất từ app “Quản lý giao dịch”): xem trước, tự đoán nhóm chi phí (nhãn sao kê → tên nhân sự → từ khoá → ≥ 5 triệu = nhập hàng), chỉ nhập chi phí vận hành (bỏ qua tiền vào, chuyển nội bộ, trả nợ gốc; quảng cáo đã lấy từ tài khoản QC và nhập hàng đã nằm trong giá vốn mặc định không nhập), chống trùng theo mã giao dịch; hoặc `npm run import:bank -- file.csv` / ops `import-bank-ledger`, `bank-ledger-prune`. |
| **Tỷ lệ hoàn theo mã hàng** | Tỷ lệ hoàn từng SKU theo quy tắc: vận đơn giao thành công nhưng COD = 0 và cước < 10.000đ = đơn hoàn; bấm mã xem danh sách đơn; xuất CSV. |
| **Nhập hàng & kiểm kê** | Phiếu nhập hàng / điều chỉnh kiểm kê theo mẫu mã; tồn khả dụng ERP = Nhập − Giao thật − Đang giao (hoàn coi như về kho); giá nhập cập nhật giá vốn. |
| **Facebook Ads** | Tự kéo chi tiêu theo ngày × chiến dịch của mọi tài khoản quảng cáo trong Business Manager (token System User), ghép mã hàng theo tên chiến dịch. Bộ lọc kỳ / tài khoản QC / marketer / mã hàng áp dụng cho KPI, biểu đồ, bảng ghép chiến dịch và danh sách chi tiêu; tích chọn nhiều chiến dịch để gán mã hàng & marketer hàng loạt; thêm marketer ngay tại chỗ. |
| **Báo cáo lợi nhuận** | Giá vốn tính “sống” theo giá nhập trên phiếu nhập ERP gần nhất (→ giá vốn Pancake trên đơn → giá nhập mẫu mã) cho mọi báo cáo, tổng quan và chi tiết đơn. 3 tab: theo đơn giao thành công; dòng tiền thực (COD về ngân hàng, tiền nhập hàng, cước, QC, vận hành); danh nghĩa theo mã hàng (đơn lên × (1 − tỷ lệ hoàn ước tính) − giá vốn − vận chuyển − CPQC, bảng theo ngày từng mã, giả định chỉnh được). Bảng kết quả kinh doanh (doanh thu giao thành công − giá vốn − phí ship − phí hoàn − phí sàn − quảng cáo − vận hành), so sánh kỳ trước, tiền thực về, theo kênh/nhân viên/sản phẩm/ngày, tỷ lệ hoàn huỷ, xuất CSV. |
| **Kết nối dữ liệu** | Trạng thái kết nối, kiểm tra API key, URL webhook + hướng dẫn cấu hình, chạy từng job đồng bộ, lịch sử đồng bộ, webhook đã nhận, lịch tự động. |
| **Người dùng & nhật ký** | Đăng nhập, vai trò (Quản trị / Quản lý / Kế toán / Kho / CSKH / Marketing / Chỉ xem) là mẫu quyền khởi điểm; ma trận quyền × vai trò chỉnh được; phân quyền riêng từng người theo 19 quyền chia theo module (xem/sửa); menu và trang gác theo quyền; nhật ký thao tác. |

Công nghệ: Next.js 15 · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · Drizzle ORM · PostgreSQL 16 (hoặc PGlite nhúng để chạy thử không cần cài Postgres).

---

## 1. Chạy thử trên máy cá nhân

### Cách A — Docker Desktop (khuyên dùng, giống môi trường thật)

Yêu cầu: [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
# file .env đã được điền sẵn API key Pancake / Viettel Post và các khoá bí mật ngẫu nhiên (xem mục 2)
docker compose up -d --build
```

Mở http://localhost:3000 — đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD` trong `.env` (mặc định `admin@shop.local` / `Admin@12345`, **đổi ngay sau khi đăng nhập** tại *Người dùng*).

Docker Compose chạy 3 dịch vụ: `db` (PostgreSQL), `app` (ERP, cổng 3000) và `scheduler` (đồng bộ tự động theo lịch). Dữ liệu nằm trong volume `erp_pgdata`.

### Cách B — Chỉ cần Node.js (không cần Docker/Postgres)

Yêu cầu: [Node.js 22+](https://nodejs.org).

```bash
# .env mặc định đã đặt DATABASE_URL="pglite://./data/pglite"
npm install
npm run dev              # http://localhost:3000 (bảng được tạo tự động lần đầu)
```

Chế độ PGlite lưu dữ liệu trong thư mục `data/pglite` và **chỉ cho phép một tiến trình mở cùng lúc**: muốn chạy lệnh `npm run sync` / `npm run seed:demo` thì dừng server (Ctrl+C) trước, hoặc dùng các nút trên giao diện. Khi dùng thật, hãy chuyển sang PostgreSQL (cách A).

### Xem thử với dữ liệu mẫu

```bash
npm run seed:demo        # ~1.100 đơn, 71 mẫu mã, vận đơn Viettel Post, chi phí, quảng cáo
npm run demo:clear       # xoá dữ liệu mẫu (giữ nguyên dữ liệu thật)
```

---

### Cách C — Triển khai thật lên VPS + tên miền (HTTPS tự động)

```bash
git clone <repo> erp && cd erp
sudo bash scripts/install-vps.sh     # cài Docker, tạo .env, chạy db + app + scheduler + Caddy (Let's Encrypt)
```

Chi tiết (trỏ DNS trên name.com, sao lưu, cập nhật): `docs/TRIEN-KHAI-VPS.md`.

---

## 2. Cấu hình `.env`

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | `postgresql://...` (Docker Compose tự đặt) hoặc `pglite://./data/pglite` |
| `AUTH_SECRET` | Chuỗi ngẫu nhiên ≥ 32 ký tự để ký phiên đăng nhập (`openssl rand -hex 32`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Tài khoản quản trị tạo lần đầu (khi chưa có người dùng nào) |
| `CRON_SECRET` | Khoá để scheduler/cron gọi API đồng bộ |
| `APP_URL` | Địa chỉ công khai của ERP (dùng để hiển thị URL webhook) |
| `PANCAKE_API_KEY`, `PANCAKE_SHOP_ID` | API key Pancake POS (*Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook/API → API Key*) và ID shop (số trong URL `pos.pancake.vn/shop/<ID>/...`) |
| `PANCAKE_WEBHOOK_SECRET` | Chuỗi bí mật gắn vào URL webhook Pancake |
| `PANCAKE_BACKFILL_DAYS` | Số ngày lịch sử đơn cần kéo lần đầu (mặc định 365) |
| `VIETTELPOST_API_KEY` | Token bí mật tạo tại https://viettelpost.vn/cau-hinh-tai-khoan → *Thêm mới token* → *Sao chép token* (xác thực OTP). ERP đổi token này lấy token đối tác qua API `loginVTP` và tự làm mới khi hết hạn. |
| `VIETTELPOST_USERNAME`, `VIETTELPOST_PASSWORD` | Tài khoản đối tác Viettel Post (SĐT + mật khẩu đăng nhập partner.viettelpost.vn) để lấy token dài hạn 1 năm (`Login` → `ownerconnect`). Nên điền cả hai cách; ERP tự chọn cách nào hoạt động. |
| `VIETTELPOST_WEBHOOK_SECRET` | "Tham số bí mật" bạn khai báo trong phần webhook của Viettel Post |
| `FACEBOOK_ACCESS_TOKEN`, `FACEBOOK_BUSINESS_ID` | Token System User của Business Manager (quyền `ads_read`, `business_management`, không hết hạn) và ID BM chứa các tài khoản quảng cáo |
| `SYNC_*_EVERY_MINUTES` | Chu kỳ đồng bộ tự động của scheduler |

Kiểm tra API key trước khi đồng bộ:

```bash
npm run check:integrations
```

Lệnh này gọi thử Pancake (shop, đơn, sản phẩm, kho, khách) và Viettel Post (token, kho gửi, tra cứu một vận đơn, danh sách vận đơn) và in kết quả ✓/✗ kèm gợi ý sửa.

---

## 3. Đồng bộ dữ liệu lần đầu

Vào **Kết nối dữ liệu** → *Đồng bộ toàn bộ Pancake (lịch sử)* → chọn số ngày → chạy. Hoặc bằng dòng lệnh:

```bash
npm run sync -- pancake-all --backfill        # kho → sản phẩm → đơn (lịch sử) → khách → đổi trả → nhật ký kho
npm run sync -- vtp-tracking                  # tra cứu trạng thái các vận đơn Viettel Post chưa kết thúc
npm run sync -- vtp-import --days=30          # kéo cả vận đơn tạo trực tiếp trên Viettel Post
npm run sync                                  # liệt kê tất cả job
```

Đồng bộ lịch sử chia theo cửa sổ 7 ngày, có thể chạy lại để tiếp tục nếu bị ngắt. Pancake giới hạn ~10.000 dòng/truy vấn nên cửa sổ lớn được tự chia nhỏ. Mọi lần chạy đều ghi vào *Lịch sử đồng bộ*.

## 4. Đồng bộ tự động & realtime

Có **3 lớp** để dữ liệu luôn mới:

1. **Webhook (tức thì)** — Pancake gửi đơn/khách/sản phẩm/tồn kho, Viettel Post gửi hành trình vận đơn ngay khi có thay đổi. ERP trả lời 200 ngay và xử lý nền; giao diện đang mở tự làm mới (SSE).
2. **Scheduler (định kỳ)** — service `scheduler` gọi các job: đơn mới cập nhật mỗi 3 phút, trạng thái Viettel Post mỗi 10 phút, sản phẩm/tồn kho mỗi 30 phút, khách hàng & nhật ký kho mỗi 60 phút, đối chiếu lại 3 ngày gần nhất lúc 02:15 hằng ngày. Đây là lưới an toàn khi webhook bị lỡ.
3. **Thủ công** — nút *Đồng bộ ngay* trên các trang, *Tải lại từ Pancake* trên từng đơn, *Cập nhật từ Viettel Post* trên từng vận đơn.

### Để webhook hoạt động, ERP cần một địa chỉ HTTPS công khai

Pancake và Viettel Post phải gọi được vào ERP của bạn, nên `localhost` không nhận được webhook. Có 2 lựa chọn:

- **Chạy thử:** tạo tunnel tạm, ví dụ `cloudflared tunnel --url http://localhost:3000` (hoặc ngrok), lấy địa chỉ `https://xxxx.trycloudflare.com` đặt vào `APP_URL` và dùng làm URL webhook.
- **Dùng thật:** triển khai lên VPS có tên miền + HTTPS (xem `docs/TRIEN-KHAI-VPS.md`).

**Pancake POS:** *Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook/API → tab Webhook URL* → bật, dán `https://<domain>/api/webhooks/pancake/<PANCAKE_WEBHOOK_SECRET>`, tick *Đơn hàng*, *Khách hàng*, *Tồn kho* → Lưu. Pancake không ký chữ ký webhook nên bí mật nằm trong URL; ERP sau khi nhận webhook đơn sẽ tải lại đơn từ API để lấy dữ liệu chuẩn.

**Viettel Post:** đăng nhập https://partner.viettelpost.vn → *Cấu hình tài khoản → Thông tin nhận hành trình* → API URL = `https://<domain>/api/webhooks/viettelpost`, Tham số bí mật = `VIETTELPOST_WEBHOOK_SECRET` → Cập nhật. **Viettel Post cần duyệt webhook**: liên hệ đội tích hợp (b2b@viettelpost.com.vn · 0862 235 888) sau khi cấu hình. Trong lúc chờ duyệt, ERP vẫn cập nhật trạng thái qua job tra cứu định kỳ.

Trang **Kết nối dữ liệu** hiển thị sẵn cả hai URL, nút kiểm tra kết nối và danh sách webhook đã nhận để bạn xác nhận.

## 5. Vận hành hằng ngày

- **Cần xử lý** trên Tổng quan: đơn mới chờ xác nhận, vận đơn giao thất bại/đang hoàn, vận đơn quá 4 ngày chưa giao, COD chờ về tài khoản, mẫu mã sắp hết.
- **Đối soát COD:** khi Viettel Post chuyển tiền, vào *Đối soát COD* → chọn các vận đơn trong bảng kê → *Đánh dấu đã về ngân hàng* (tạo đợt nhận tiền có mã bảng kê, ngày nhận). Lệch tiền → đánh dấu *Có chênh lệch*.
- **Chi phí & quảng cáo:** nhập chi phí vận hành và chi tiêu quảng cáo mỗi ngày/tuần để báo cáo lợi nhuận đúng.
- **Báo cáo lợi nhuận:** chọn kỳ, so sánh kỳ trước, xuất CSV theo ngày.

Công thức lợi nhuận ròng = Doanh thu đơn giao thành công − Giá vốn (giá nhập gần nhất × số lượng) − Phí vận chuyển ĐVVC − Phí hoàn − Phí sàn − Chi phí quảng cáo − Chi phí vận hành.

## 6. Cấu trúc mã nguồn

```
app/(dashboard)/<module>/      # trang giao diện (Server Components) + bảng/columns (Client)
app/api/sync/[job]             # chạy job đồng bộ (scheduler / cron / nút bấm)
app/api/webhooks/pancake/...   # nhận webhook Pancake  (POST <secret>/<orders|customers|products|...>)
app/api/webhooks/viettelpost   # nhận webhook Viettel Post ({DATA, TOKEN})
app/api/events                 # SSE realtime cho giao diện
lib/integrations/pancake/      # client API, mapper (chuẩn hoá dữ liệu), sync (đồng bộ), webhook
lib/integrations/viettelpost/  # client API (token loginVTP/ownerconnect), sync (tra cứu, nhập, áp trạng thái)
lib/queries/, lib/actions/     # truy vấn báo cáo & server actions (có kiểm tra quyền + nhật ký)
db/schema.ts, drizzle/         # schema & migration
scripts/                       # scheduler.mjs, sync.ts, check-integrations.ts, seed-demo.ts
docs/                          # CONVENTIONS.md, TRIEN-KHAI-VPS.md, API-PANCAKE-VIETTELPOST.md
```

Checklist đưa vào vận hành và bật realtime: `docs/CHECKLIST-DONG-BO-REALTIME.md`.

Lệnh hữu ích: `npm run typecheck`, `npm run lint`, `npm test` (kiểm thử luồng đồng bộ với dữ liệu mẫu), `npm run db:migrate`, `npm run db:studio`.

## 7. Bảo mật & lưu ý

- Đổi mật khẩu quản trị mặc định, đặt `AUTH_SECRET`, `CRON_SECRET`, `PANCAKE_WEBHOOK_SECRET`, `VIETTELPOST_WEBHOOK_SECRET` bằng chuỗi ngẫu nhiên.
- API key chỉ nằm trong `.env` trên server, không lưu vào DB, giao diện chỉ hiện dạng che.
- ERP **chỉ đọc** từ Pancake và Viettel Post — không sửa đơn, không tạo vận đơn; Pancake vẫn là nơi lên đơn và đẩy đơn cho ĐVVC.
- Sao lưu định kỳ volume `erp_pgdata` (hoặc `pg_dump`).
- Token Viettel Post lấy từ token bí mật có thể có thời hạn ngắn; ERP tự đổi lại khi hết hạn. Nếu Viettel Post đổi cơ chế, điền thêm `VIETTELPOST_USERNAME/PASSWORD`.

## 8. Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| "Pancake: HTTP 403" | Sai API key hoặc key không có quyền với shop. Tạo key mới trên Pancake, kiểm tra `PANCAKE_SHOP_ID`. `npm run check:integrations` |
| "ViettelPost: không lấy được token" | ERP thử lần lượt `loginVTP` → dùng thẳng token bí mật làm header `Token` → `Login/ownerconnect`. Token sai/hết hạn: tạo token mới tại viettelpost.vn/cau-hinh-tai-khoan; hoặc điền tài khoản đối tác. |
| Webhook không về | Chưa có HTTPS công khai / sai secret / Viettel Post chưa duyệt. Xem *Kết nối dữ liệu → Webhook đã nhận*. |
| Tồn kho lệch với Pancake | Chạy job *Sản phẩm & tồn kho*; webhook tồn kho chỉ cập nhật mẫu mã đã có trong ERP. |
| PGlite báo "đang được tiến trình khác sử dụng" | Dừng server trước khi chạy lệnh CLI, hoặc chuyển sang PostgreSQL. |
| Cổng 3000 bận | Đổi `ports` trong `docker-compose.yml` hoặc `PORT`. |
