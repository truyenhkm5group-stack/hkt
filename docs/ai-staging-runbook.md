# Bản chạy thử nhân sự AI (`ai-staging`) — sổ tay vận hành

> Tài liệu này mô tả **bộ dựng đã viết xong trong kho mã**, không phải đề xuất.
> Bản đề xuất ban đầu (và lý do không được bấm workflow deploy hiện tại trên nhánh này) ở
> `docs/ai-staging-plan.md`.
>
> **Chưa có gì được dựng trên VPS.** Mọi lệnh dưới đây là lệnh chủ shop (hoặc phiên có quyền SSH)
> chạy khi đã duyệt.

## 0. Bộ dựng gồm những gì

| Tệp | Việc của nó |
|---|---|
| `scripts/staging-preflight.sh` | **Chỉ đọc.** Chụp hiện trạng production rồi kiểm 7 lớp va chạm. Thoát 1 = DỪNG. |
| `scripts/staging-up.sh` | Dựng bản chạy thử. Gọi preflight trước và **không có cờ nào bỏ qua nó**. |
| `docker-compose.staging.yml` | Ngăn xếp riêng: project `vnx-ai-staging`, 2 container, volume riêng, cổng localhost. |
| `.env.staging.example` | Mẫu tệp môi trường. Toàn giá trị rỗng — `.env.staging` thật nằm trong `.gitignore`. |
| `deploy/Caddyfile.ai-staging` | Khối Caddy cho tên miền công khai. **Chưa áp dụng**, và chỉ áp dụng ở mục 8. |
| `scripts/ai-sales-ingest.ts` | Nạp tay một lượt hội thoại nhỏ (`npm run ai:ingest`). |
| `scripts/import-size-rules.ts` | Đưa bảng số đo THẬT vào (`npm run ai:size-rules`). |

Không có cờ `--force` trong `staging-up.sh`. Một cờ như vậy sẽ được dùng đúng vào lúc không nên dùng.

## 0.1 Nhánh này ĐÃ nhập `main` về — bản chạy thử là ERP đầy đủ

`staging-up.sh` tải nhánh `claude/ai-workforce-sales-v1`, và nhánh ấy nay đã nhập `main` (422
commit / 49 migration) về. Bản chạy thử vì vậy là **ERP hôm nay cộng thêm nhân sự AI**, không còn
là ảnh chụp của thời điểm tách nhánh.

Ba điều phải biết đi kèm:

1. **Migration của nhân sự AI nay là `0084` và `0085`.** Chúng từng mang số `0035`/`0036` — nhưng
   trên production hai số ấy đã thuộc về `manual_verification_source` và `expense_cost_allocation`
   và đã chạy rồi. Giữ số cũ thì drizzle thấy mục `0035` "đã áp" và **bỏ qua vĩnh viễn** 14 bảng
   của nhân sự AI: không lỗi, không cảnh báo. `tests/migration-upgrade-path.test.ts` đi đúng đường
   mà máy chủ thật đi và chứng minh việc đánh số lại đã đúng.
2. **Mã của nhân sự AI nằm ở `lib/ai-workforce/`, không phải `lib/ai/`.** `lib/ai/` là AI Copilot
   sẵn có của ERP — một hệ khác, bảng khác (`ai_interactions`), nhà cung cấp khác. Hai hệ từng đâm
   nhau ở `lib/ai/tools/erp.ts` vì cùng khai một hàm tên `registerErpTools`.
3. **Biến môi trường nhà cung cấp cũng tách: `AI_WORKFORCE_PROVIDER`.** `AI_PROVIDER` là của
   Copilot với bộ giá trị `auto|openai|anthropic|off`; nhân sự AI dùng `stub|anthropic`. Đặt đúng
   cho hệ này mà đọc chung thì hệ kia hiểu sai, và cái sai ấy im lặng. Không khai biến riêng thì
   `AI_PROVIDER` chỉ được nhận khi nó là tên nhà cung cấp mà nhân sự AI thật sự có, còn lại rơi về
   `stub` (không gọi mạng).

## 1. Danh tính tách khỏi production

| Thành phần | Production | Bản chạy thử |
|---|---|---|
| Thư mục | `/root/erp` | `/opt/vnx-ai-staging` |
| Compose project | (mặc định theo thư mục) | `vnx-ai-staging` |
| Container | `erp-app` · `erp-db` · `erp-scheduler` · `erp-caddy` | `vnx-ai-staging-app` · `vnx-ai-staging-db` |
| Cổng | Caddy giữ 80/443, app 3000 | `127.0.0.1:3100` — **không** ra Internet |
| Volume CSDL | `erp_pgdata` | `vnx-ai-staging_vnx_ai_staging_pgdata` |
| Image | `erp-app:local` | `vnx-ai-staging-app:local` |
| Tệp môi trường | `/root/erp/.env` | `/opt/vnx-ai-staging/.env.staging` (quyền 600) |
| Nhật ký | như cũ | json-file riêng, 10 MB × 3 |
| Bộ lập lịch | đang chạy | **KHÔNG có service scheduler** |
| Caddy | `erp-caddy` | dùng chung, và chỉ khi tới mục 8 |

`staging-preflight.sh` kiểm đúng bảng này: tên project, tên container, trùng tên với container
production, cổng (kể cả chặn 80/443/5432/3000), volume (chặn không gian tên `erp_*`), thư mục
(chặn mọi đường nằm trong `/root/erp`), và sức khoẻ production **trước** khi dựng để có mốc so sánh.

## 2. CSDL và dữ liệu danh mục

CSDL staging là **container + volume riêng, trắng hoàn toàn**. `DATABASE_URL` do
`docker-compose.staging.yml` tự dựng trỏ vào service `db` nội bộ; service ấy **không publish cổng
nào**, nên không có đường nào từ bên ngoài chạm vào, và cũng không có đường nào để cấu hình nhầm
thành CSDL production.

Nhưng CSDL trắng thì `product.search`, `pricing.get`, `inventory.check` trả rỗng — chưa đo được
chất lượng nhận diện sản phẩm. Ba cách đưa danh mục vào, xếp theo mức rủi ro:

**A. Đồng bộ danh mục từ Pancake (khuyến nghị).**

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging exec -T app \
  npm run sync -- pancake-products
```

Job `pancake-products` **chỉ đọc** từ Pancake POS và **chỉ ghi** vào CSDL staging. Không chạm
CSDL production, không ghi ngược lên Pancake (API Pancake không có `update-order`, và luồng này
không gọi bất cứ endpoint ghi nào). Cần `PANCAKE_API_KEY` + `PANCAKE_SHOP_ID` — dùng chung được
với production vì đây là đường đọc, nhưng nếu Pancake cấp được khoá thứ hai thì nên tách.

Có sản phẩm, mẫu mã, giá vốn, tồn theo kho — đủ để chấm nhận diện sản phẩm và báo giá.
Không có: đơn hàng, khách hàng, vận đơn. Bản chạy thử không cần.

**B. Bản sao chỉ-đọc của vài bảng danh mục.** `pg_dump` từ production, chỉ các bảng
`products` / `product_variants` / `inventory*`, nạp vào staging. Chính xác hơn A ở chỗ mang theo
số liệu ERP tự tính, nhưng phải đọc CSDL production — làm ngoài giờ cao điểm, và **chỉ đọc**.

**C. Gõ tay vài mẫu mã.** Đủ cho phép thử đường truyền, không đủ để chấm chất lượng.

> **Cấm tuyệt đối:** trỏ `DATABASE_URL` của staging vào CSDL production. Nhân sự AI GHI vào các
> bảng `ai_*` và `sales_*`; các bảng đó là bảng mới, nhưng một sai sót cấu hình vẫn là ghi vào
> chính CSDL đang phục vụ khách. `docker-compose.staging.yml` dựng `DATABASE_URL` từ service `db`
> nội bộ nên không đọc giá trị khai trong `.env.staging` — đây là chốt chặn, không phải tiện lợi.

## 3. Nấc quyền hạn và hai công tắc chặn cứng

Ba giá trị được ép trong khối `environment` của `docker-compose.staging.yml`. Khối `environment`
**đè lên** `env_file`, nên dù `.env.staging` ghi gì, dù ai sửa nhầm, dù một câu SQL đổi bảng
`settings` — ba giá trị này vẫn giữ nguyên cho tới khi có người sửa **chính tệp compose** rồi
dựng lại container:

```yaml
AI_ALLOW_CUSTOMER_SEND: "false"
AI_ALLOW_ORDER_CREATE: "false"
AI_DEFAULT_MODE: "SHADOW"
```

Chúng được đọc thẳng từ biến môi trường trong `lib/ai-workforce/config.ts::aiEnv.hardLimits`, và
`getAiSettings()` cố tình **không** hợp nhất chúng với JSON trong bảng `settings` — ghi khoá
`hardLimits` vào CSDL là ghi vào hư không. Chỉ đúng chuỗi `"true"` mở được; `1`, `yes`, `on` đều
là CẤM; không khai gì cũng là CẤM.

Bốn lớp, từ ngoài vào trong:

1. `AI_ALLOW_CUSTOMER_SEND` / `AI_ALLOW_ORDER_CREATE` — biến môi trường, CSDL không với tới.
2. Trần `MAX_ALLOWED_MODE = "SHADOW"` trong `lib/constants/ai.ts` — khai cao hơn cũng bị kẹp xuống.
3. `assertOutboundAllowed()` đọc lại nấc THẬT từ bảng `ai_agents` — khai `mode` từ nơi gọi không nới ra được.
4. Cổng công cụ chặn mọi công cụ GHI ở nấc SHADOW, và ghi sổ cả lần bị từ chối.

`tests/sales-agent.test.ts` khối 5B quét 16 tổ hợp nấc × phiếu duyệt × nội dung và khẳng định tất
cả đều bị chặn.

## 4. Nạp hội thoại — đường ĐÃ KIỂM CHỨNG, không dùng webhook

Webhook hội thoại Pancake **chưa kiểm chứng được** (xem `docs/pancake-chat-setup.md`). Lần chạy
thử đầu tiên dùng đường đọc bù qua Pages API, là đường đã chạy thật trong ERP.

```bash
cd /opt/vnx-ai-staging
COMPOSE="docker compose -f docker-compose.staging.yml --env-file .env.staging"

# 1. Xem trước, KHÔNG ghi gì
$COMPOSE exec -T app npm run ai:ingest -- --page=<PAGE_ID> --hours=24 --max=20 --dry-run

# 2. Nạp thật
$COMPOSE exec -T app npm run ai:ingest -- --page=<PAGE_ID> --hours=24 --max=20
```

Script tự bảo vệ mình: in cấu hình đang chạy trước khi làm gì (kể cả hai công tắc chặn cứng),
**từ chối chạy** nếu `AI_ALLOW_CUSTOMER_SEND` đang mở, và cuối lượt **đọc lại CSDL** để chứng minh
0 tin đã gửi / 0 tin do máy soạn nằm trong bảng tin nhắn / 0 đơn do máy tạo — sai một trong ba thì
thoát khác 0.

Chống trùng nằm ở **tầng dữ liệu**, hai chốt độc lập: khoá duy nhất `(conversation_id, external_id)`
và vân tay nội dung (`chiều | mốc giây | nội dung chuẩn hoá`). Nên webhook và đọc bù không bao giờ
xử lý hai lần cùng một tin, kể cả khi sau này bật cả hai.

**Bộ lập lịch vẫn TẮT.** Compose staging không có service `scheduler`; dòng lịch `ai-sales-ingest`
trong `scripts/scheduler.mjs` vẫn là chú thích.

## 5. Khoá Pancake cần điền

Điền vào `/opt/vnx-ai-staging/.env.staging` (quyền 600, đã nằm trong `.gitignore`):

```
PANCAKE_PAGE_ID="<id của page cần đọc>"
PANCAKE_PAGE_ACCESS_TOKEN="<access token của CHÍNH page đó>"
```

Lấy ở pancake.vn → Cấu hình → Page → **Access token**.

Token của một page chỉ mở đúng page ấy; token người dùng (`PANCAKE_ACCESS_TOKEN`) mở mọi page của
tài khoản. Với một bản chạy thử cắm vào dữ liệu thật, phạm vi hẹp hơn là phạm vi đúng — nên
**không cần** khai `PANCAKE_ACCESS_TOKEN`.

Kiểm chứng không cần nạp gì:

```bash
$COMPOSE exec -T app npm run ai:probe
```

In độ dài token và chế độ đang chạy, **không bao giờ in token**.

## 6. Mô hình: thiếu khoá vẫn phải chạy

`AI_PROVIDER="stub"` + `AI_API_KEY=""` + `AI_MODEL_CALLS_ENABLED="false"` là cấu hình khởi điểm.
Hệ thống chạy đủ nấc luật (bóc ý định, khớp sản phẩm, dựng trạng thái), và phần cần mô hình được
đánh dấu `MODEL_NOT_CONFIGURED` rồi chuyển người — **không ném lỗi, không làm sập lượt nạp**.
`tests/sales-agent.test.ts` khối 10C khoá hành vi này.

Muốn gọi mô hình thật thì khai `AI_PROVIDER="anthropic"`, `AI_API_KEY`, `AI_MODEL_ECONOMY`,
`AI_MODEL_STRONG`, rồi bật `AI_MODEL_CALLS_ENABLED="true"`. **Đơn giá không nằm trong mã** — khai
trong `settings["ai.config"].pricing` kèm `pricingVersion`. Chưa khai giá thì chi phí từng lượt là
**CHƯA BIẾT (`null`)**, không phải 0đ.

## 7. Bảng số đo

ERP không có số đo nào: `size` là nhãn chữ, `weight` là trọng lượng kiện hàng, `attributes` là chữ
tự do. Máy gợi ý size trả `SIZE_DATA_MISSING` và chuyển người — và giữ nguyên như vậy.

Đường đưa số đo THẬT vào:

```bash
$COMPOSE exec -T app npm run ai:size-rules -- --template > mau.json   # lấy mẫu
# điền số đo thật vào mau.json rồi:
cat mau.json | $COMPOSE exec -T app npm run ai:size-rules -- --stdin            # kiểm, không ghi
cat mau.json | $COMPOSE exec -T app npm run ai:size-rules -- --stdin --apply    # ghi thật
```

Script kiểm bằng zod, đối chiếu mã sản phẩm/mẫu mã với ERP, cảnh báo khi hai size khai dải trùng
nhau, và tự thử một phép gợi ý ở giữa dải trước khi ghi.

## 8. Tên miền công khai — chỉ sau khi localhost đã xanh

**Thứ tự bắt buộc.** Trước khi nghĩ tới Caddy, bốn thứ này phải xanh trên `127.0.0.1:3100`:

1. `/api/health` trả `{"ok":true}`.
2. CSDL nối được và migration đã chạy (health check bao gồm cả hai).
3. `/ai/review` mở được.
4. `npm run ai:ingest -- --dry-run` chạy hết không lỗi.

Vào bằng SSH tunnel, không cần mở cổng nào ra Internet:

```bash
ssh -L 3100:127.0.0.1:3100 <user>@<vps>
# rồi mở http://localhost:3100/ai/review
```

Với giai đoạn chạy ngầm, **đây đã là đủ** và là phương án ít bề mặt rủi ro nhất. Chỉ cần tên miền
công khai khi muốn nhiều người cùng vào soát, hoặc khi bật webhook hội thoại (chưa phải lúc này).

Khi đã quyết định mở, làm theo `deploy/Caddyfile.ai-staging`: thêm khối vào **cuối** Caddyfile,
không sửa khối `{$ERP_DOMAIN}` đang có, rồi

```bash
docker exec erp-caddy caddy validate --config /etc/caddy/Caddyfile   # ĐẠT mới được reload
docker exec erp-caddy caddy reload --config /etc/caddy/Caddyfile     # reload êm, không dừng kết nối
curl -fsS https://erp.vnxcommerce.com/api/health                      # production PHẢI vẫn xanh
```

`caddy reload` nạp cấu hình mới mà không dừng tiến trình, nên tên miền ERP không đứt. `caddy
validate` chạy trước để một lỗi cú pháp không bao giờ tới được bước reload.

### DNS

**Chưa kiểm chứng được từ phiên này** (không có quyền DNS, và không truy vấn được từ container).
Bản ghi cần có:

```
Loại : A
Tên  : ai-staging            (thành ai-staging.vnxcommerce.com)
Giá trị: <đúng IP VPS đang chạy erp.vnxcommerce.com>
TTL  : 300
Proxy: TẮT (DNS only) nếu dùng Cloudflare — Caddy cần tự xin chứng chỉ Let's Encrypt
```

Chưa trỏ DNS thì **dừng ở mục 8**, đừng thêm khối Caddy: Caddy sẽ xin chứng chỉ thất bại lặp lại
và bị Let's Encrypt hạn chế tần suất.

## 9. Màn hình soát

`http://127.0.0.1:3100/ai/review` — ba cột cạnh nhau: khách nói gì · máy gợi ý gì · nhân viên trả
lời thật thế nào. Chấm tay ba trạng thái (đúng / sai / không đánh giá được); **tỷ lệ chính xác chỉ
tính trên phần đã chấm**, chưa chấm dòng nào thì hiện `null`, không hiện 0%.

Không có nút gửi tin cho khách trên màn hình này, và cũng không có action nào đứng sau nó — đường
gửi tin duy nhất trong kho mã là `sendSalesMessage()`, và nó đi qua `assertOutboundAllowed()`.

Mỗi lượt bấm được sang `/ai/<mã lượt chạy>` — nơi hiện ĐỦ dây chuyền của một lượt, và đó là thứ
phân biệt "soát được" với "chỉ nhìn được":

| Mắt xích | Ở đâu trên màn hình |
|---|---|
| Tin nhắn của khách | §1 |
| Ý định &amp; thực thể bóc được | §2 |
| Trạng thái trước / sau | §3 · §4 (kèm nhãn giai đoạn) |
| Quyết định &amp; lý do, lý do chuyển người | §5 |
| Công cụ ERP đã gọi: tham số · kết cục · lý do từ chối · ms | §6 |
| Lần gọi mô hình: nhà cung cấp · mô hình · nấc · token vào/ra · token đệm · chi phí · **phiên bản bảng giá** · ms · lỗi | §7 |
| Câu máy gợi ý | §8 |
| Câu nhân viên thật sự trả lời | §9 |
| 12 tin gần nhất của hội thoại | §10 |
| Lỗi của cả lượt chạy | thẻ đỏ trên đầu |
| ĐÃ GỬI / KHÔNG GỬI cho khách | phù hiệu trên đầu |

Phiên bản bảng giá đứng ngay cạnh số tiền có chủ ý: một con số tiền không nói nó tính theo bảng giá
nào thì hai kỳ khác giá trông giống hệt nhau khi đọc lại. Chưa khai giá thì phù hiệu chuyển vàng và
ghi thẳng "chi phí là CHƯA BIẾT" — không hiện 0đ.

`tests/ai-platform.test.ts` khoá 19 mắt xích này ở mức nguồn: một lần "dọn dẹp" gỡ mất khối token
hay khối công cụ sẽ không làm hỏng bài kiểm dữ liệu nào, nên phải có một bài kiểm đọc chính màn hình.

## 10. Lượt chạy thử đầu tiên

Một page · cửa sổ 24 giờ · 10–30 hội thoại. Dừng lại, đọc kết quả, báo cáo, rồi mới nói tới lượt
lớn hơn. Cần xem đủ:

- Bao nhiêu hội thoại nạp được, bao nhiêu bị từ chối và vì lý do gì.
- Máy bóc đúng sản phẩm / size / màu / SĐT / địa chỉ được bao nhiêu phần.
- Chỗ nào máy chuyển người, và chuyển có đúng lúc không.
- `select count(*) from sales_suggestions where sent` — **phải bằng 0**.

## 11. Chưa bật, và chưa được bật

- Bộ lập lịch tự chạy (không có service scheduler, dòng lịch vẫn là chú thích).
- Webhook hội thoại Pancake (`PANCAKE_CHAT_WEBHOOK_SECRET` rỗng ⇒ trả 401).
- Nấc COPILOT · nấc AUTO (trần đang là SHADOW).
- Máy nhắn tin cho khách (`AI_ALLOW_CUSTOMER_SEND=false`).
- Máy tự tạo đơn (`AI_ALLOW_ORDER_CREATE=false`).
- Nhân sự Marketing, và mọi nhân sự AI khác.

## 12. Quay lui

| Việc | Lệnh | Ảnh hưởng production |
|---|---|---|
| Dừng bản chạy thử | `docker compose -f docker-compose.staging.yml down` | Không |
| Xoá hẳn kèm dữ liệu | `docker compose -f docker-compose.staging.yml down -v` | Không |
| Gỡ tên miền | Xoá khối vừa thêm khỏi Caddyfile → `caddy validate` → `caddy reload` | Không |
| Xoá mã nguồn | `rm -rf /opt/vnx-ai-staging` | Không |

Không bước nào chạm vào `/root/erp`, container `erp-*`, hay volume `erp_pgdata`.
