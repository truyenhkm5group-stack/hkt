# Cổng mở bán nền tảng — A · khoá bí mật kết nối · B · /start · C · sao lưu / khôi phục · D · AI

> Hai việc cuối cùng giữa "Phase 1 → 12 đã lên production" và "tổ chức thứ hai dùng được thật". Cả hai đều MẶC ĐỊNH TẮT
> và tắt thì tổ chức nhà (VNX) không đổi gì. Trạng thái của cả hai hiện ở `/platform` → khung **Cổng mở bán**.

## A · `PLATFORM_SECRETS_KEY` — khoá mã hoá bí mật kết nối theo tổ chức

**Nó làm gì.** Tổ chức khác lưu bí mật của chính họ (Lark, Telegram, khoá AI) ở `/settings/connections`; bí mật được mã
hoá AES-256-GCM bằng khoá dẫn xuất HKDF-SHA256 từ biến này (`lib/connectors/secrets.ts`), AAD gắn mã tổ chức + khoá
connector. Thiếu khoá ⇒ lưu bí mật bị TỪ CHỐI, màn hình nói rõ; không có đường lùi về khoá nào khác (không `AUTH_SECRET`,
không hằng số trong mã — kho PUBLIC).

### A.1 · Kiểm toán đường ống (đọc mã thật 29/09/2026)

| # | Chặng | Kết luận | Căn cứ |
|---|---|---|---|
| 1 | GitHub Secret → `deploy-vps.yml` | ĐỦ: env của bước SSH đọc `secrets.PLATFORM_SECRETS_KEY`, tên có trong `envs` (appleboy chỉ chở biến có tên ở đó) VÀ trong `export` của script trên VPS. Bước "Kiểm tra Secrets bắt buộc" chỉ in `có / chưa có`, KHÔNG chặn deploy khi thiếu. | `tests/launch-gates.test.ts` (quét) |
| 2 | `bootstrap.sh` → `install-vps.sh` | ĐỦ: `exec bash scripts/install-vps.sh` — môi trường đi nguyên, không `env -i`, không `unset`. | như trên |
| 3 | `install-vps.sh` → `/root/erp/.env` | ĐỦ: ghi CHỈ khi khác rỗng (Secret bị xoá ⇒ `.env` giữ nguyên từng byte), từ chối ký tự ngoài base64 (`&` sẽ làm `sed` ghi SAI khoá một cách im lặng), chạy SAU cả hai nhánh tạo / giữ `.env`. Không in giá trị, không `set -x`. | chạy THẬT khối shell dưới `bash -euo pipefail` |
| 4 | `.env` → container | ĐỦ: `docker-compose.prod.yml` — `app` và `scheduler` có `env_file: .env`; `chatbot`, `caddy`, `db` KHÔNG nạp `.env` (chatbot chỉ nhận biến khai tường minh) ⇒ khoá chỉ ở hai tiến trình cần nó. Cuối `install-vps.sh` là `docker compose up -d` (nhánh ảnh) / `up -d --build`: compose dựng lại container khi nội dung `env_file` đổi, và mỗi lượt deploy đổi ảnh + `ERP_COMMIT` nên container luôn được dựng lại. Compose v2 bỏ dấu nháy của `KEY="…"` (cùng cách `AUTH_SECRET` đang chạy nhiều tháng); `secretsKeyState()` cắt khoảng trắng thừa. | đọc compose thật; bài kiểm quét `env_file` của hai service |

**Chỗ dễ sai (không phải lỗi mã, là thao tác):**

- **`reset_env = 1`** chuyển `.env` sang `.env.bak-<giây>` rồi sinh `.env` MỚI: khoá chỉ được ghi lại nếu secret GitHub
  còn. Secret đã bị xoá mà bấm `reset_env` ⇒ `.env` sống KHÔNG có khoá (khoá cũ vẫn nằm trong `.env.bak-*`). Đừng bấm
  `reset_env` khi secret không còn.
- **ops `restart`** là `docker compose restart` — KHÔNG nạp lại `.env`. Sửa `.env` bằng tay thì dựng lại:
  `docker compose -f docker-compose.prod.yml up -d app scheduler`.

**Đổi khoá thì sao.** Mỗi dòng `org_connections` mang `secrets_key_id` (8 byte đầu HMAC của khoá dẫn xuất). Khoá đổi mà
KHÔNG theo kế hoạch A.4 ⇒ `openSecrets` từ chối NGAY bằng mã khoá, không phải một lỗi GCM mơ hồ:
`SECRETS_DECRYPT_FAILED` — "Bí mật được mã hoá bằng một PLATFORM_SECRETS_KEY khác (mã khoá xxxxxxxx…, hiện tại
yyyyyyyy…) — nhập lại bí mật của kết nối này." Câu này tới người dùng ở nút Kiểm tra, ở `openActiveConnection` (AI Builder
nói "không có kết nối"), và lượt Lưu kế tiếp bỏ bản mã cũ, chỉ giữ ô vừa nhập lại. Không bao giờ trả bản rõ rác: thiếu mã
khoá thì thẻ xác thực GCM vẫn chặn.

**Khoá có lọt ra đâu không:**

| Nơi | Kết luận |
|---|---|
| Log Actions | Chỉ `có / chưa có` / `đã ghi vào .env (không in giá trị)`; GitHub còn tự che secret. Bài kiểm quét mọi dòng chạm biến. |
| Log ứng dụng | `lib/connectors/*` không có `console.*` (quét). Bài kiểm vòng đời BẮT mọi `console.*` trong lúc lưu / kiểm / xoay và tìm từng bí mật: 0. |
| `/api/health` (công khai) | `secretsKey: ready \| missing \| invalid`, `secretsKeyIdShort` (8 hex của MÃ khoá — HMAC, không suy ngược, đủ để so hai lượt deploy), `secretsKeyPrevious`. Không khoá, không khoá dẫn xuất, không mã khoá đầy đủ, không câu lý do. |
| `/platform`, `/settings/connections` | Mã khoá rút gọn `xxxxxxxx…`. |
| CSDL / bản sao lưu | Khoá không nằm trong bảng nào (bài kiểm QUÉT mọi bảng của hai tổ chức thử + nhà, cả dạng chữ lẫn hex). `.env` KHÔNG thuộc phạm vi `erp-backup.sh` ⇒ bản dump một mình không giải được — vì thế C3 bắt buộc cất khoá ra ngoài VPS. Xuất cấu hình (`/settings/export`) không chạm `org_connections` (chỉ `service.ts` chạm bảng — quét). |
| Tiến trình con của agent | `sandboxEnv()` là danh sách CHO PHÉP; hai tên khoá nay nằm trong `SECRET_ENV_NAMES` để bài kiểm chứng minh chúng không lọt xuống. |
| Còn lại, chấp nhận có chủ ý | Root trên VPS đọc được `.env` / `docker inspect erp-app`. Root trên VPS là mất tất cả — khoá này không bảo vệ được điều đó và không giả vờ bảo vệ. |

### A.2 · Tự kiểm trên production — không cần tổ chức thứ hai

`/platform` → **Cổng mở bán** → A → nút **«Tự kiểm khoá bí mật»** (người vận hành: tổ chức nhà + `platform:operate`).
Máy chủ, TRONG BỘ NHỚ, trên một tổ chức GIẢ (`__tu_kiem__`, không phải mã hợp lệ): mã hoá một chuỗi NGẪU NHIÊN, giải lại
đúng, rồi đòi bốn lượt giải sai phải bị TỪ CHỐI — AAD tổ chức khác · AAD connector khác · khoá khác (có và không mang mã
khoá cũ) · bản mã sửa một byte; thêm "bản mã không chứa bản rõ" và "nonce mới mỗi lần"; có PREVIOUS thì thêm "bản mã của
khoá cũ vẫn giải được". Một lượt "giải được" ở chỗ phải từ chối ⇒ **HỎNG** (fail closed). Trả `{ ok, mã khoá rút gọn,
nguồn = PLATFORM_SECRETS_KEY, PREVIOUS, danh sách phép thử }` — không một ký tự của khoá hay chuỗi thử. KHÔNG đọc/ghi
`org_connections`; ghi ĐÚNG một dòng `platform_audit_log` (`SECRETS_SELF_TEST`: ai, lúc nào, đạt/hỏng, mã khoá rút gọn).

Từ ngoài (không đăng nhập): `curl -s https://<miền>/api/health` → `platform.secretsKey`.

### A.3 · Việc của chủ nền tảng — ONE HUMAN GATE (đã giao)

1. Chạy `openssl rand -base64 48` trên máy của bạn. GitHub → Settings → Secrets and variables → Actions → **New repository
   secret**: tên `PLATFORM_SECRETS_KEY`, dán giá trị.
2. Cất **một bản sao** ở trình quản lý mật khẩu / giấy cất riêng (cùng chỗ mật khẩu crypt của Drive) — đây cũng là C3.
   GitHub KHÔNG cho đọc lại secret; mất bản sao + mất VPS = mọi bí mật kết nối của mọi tổ chức thành rác.
3. Actions → **Deploy ERP to VPS** → Run workflow (nhánh `main`, `reset_env` để trống).

Không tạo tổ chức thứ hai để "thử" — A.2 đã trả lời câu "khoá dùng được chưa" mà không cần nó.

### A.4 · Xoay khoá (khi nghi khoá lộ, hoặc theo lịch) — có kế hoạch, không mất bí mật nào

Nguyên tắc: `PLATFORM_SECRETS_KEY_PREVIOUS` giữ khoá CŨ trong lúc xoay. `openSecrets` chọn khoá theo MÃ KHOÁ lưu cạnh bản
mã (hiện tại, hoặc PREVIOUS nếu khớp — không "thử bừa"); mã hoá LUÔN bằng khoá hiện tại. Biến PREVIOUS đi CÙNG đường ống
với khoá chính (secret → workflow env/envs/export → `install-vps.sh`, rỗng ⇒ không ghi, ký tự lạ ⇒ từ chối).

1. `openssl rand -base64 48` ⇒ khoá MỚI; cất bản sao.
2. GitHub: secret `PLATFORM_SECRETS_KEY_PREVIOUS` = khoá ĐANG chạy (lấy từ bản sao đã cất); `PLATFORM_SECRETS_KEY` = khoá
   MỚI. Deploy. Kiểm: `/api/health` → `secretsKey: ready`, `secretsKeyPrevious: ready`, `secretsKeyIdShort` ĐỔI; `/platform`
   → Tự kiểm = ĐẠT (có dòng "Bản mã của PLATFORM_SECRETS_KEY_PREVIOUS vẫn giải được"). Lúc này KHÔNG kết nối nào chết.
3. SSH VPS: `docker exec erp-app npm run platform:rotate-secrets` — CHẠY THỬ, không ghi gì. Đọc báo cáo từng tổ chức:
   `WOULD_REKEY` (sẽ mã hoá lại) · `CURRENT` · `UNKNOWN_KEY` / `DECRYPT_FAILED` (người của tổ chức phải nhập lại — máy
   không sửa hộ) · `TRIPWIRE` · tổ chức không ACTIVE bị BỎ QUA.
4. `docker exec erp-app npm run platform:rotate-secrets -- --apply --confirm-production`. Mỗi dòng mã hoá lại ghi một dòng
   `audit_logs` (`ORG_CONNECTION_REKEY`, mã khoá rút gọn trước → sau) trong CSDL của tổ chức đó. Trạng thái / kết quả kiểm
   tra / mốc bật KHÔNG đổi (bản rõ không đổi). Ghi có điều kiện "mã khoá vẫn là khoá cũ" ⇒ không đè lượt lưu tay xen giữa.
5. Chạy thử lại: dòng cuối phải là `Gỡ PLATFORM_SECRETS_KEY_PREVIOUS: ĐƯỢC` (mã thoát 0). Chạy thật lần hai = không đổi.
6. Gỡ khoá cũ — theo ĐÚNG thứ tự: xoá secret GitHub `PLATFORM_SECRETS_KEY_PREVIOUS` (không thì lần deploy sau ghi lại
   nó) → trên VPS `sed -i '/^PLATFORM_SECRETS_KEY_PREVIOUS=/d' /root/erp/.env` →
   `docker compose -f docker-compose.prod.yml up -d app scheduler` → `/api/health` → `secretsKeyPrevious: absent`.

Tổ chức đình chỉ không mở được bằng ngữ cảnh ⇒ bị BỎ QUA ở bước 3–5 và bí mật của nó chỉ sống nhờ PREVIOUS: kích hoạt tạm
hoặc chấp nhận để họ nhập lại TRƯỚC khi gỡ PREVIOUS. Chưa có ops action cho bước 3–4 (chạy tay qua SSH, có chủ ý: đây là
lượt ghi hàng loạt vào CSDL của mọi tổ chức — AGENTS.md mục 7).

### A.5 · Checklist xác minh sau khi đặt khoá (phiên tích hợp chạy)

> **Đã chạy 30/09/2026** — chủ nền tảng đặt secret 29/09; kết quả đầy đủ ở `pilot-readiness.md` mục 6. Tóm tắt: V1 ĐẠT
> (deploy run 36586233151: «có» + «đã ghi vào .env (không in giá trị)»), V2 ĐẠT (`ready`, mã khoá `3c0b04e1`), V3/V4 thay
> bằng ops `platform-secrets-verify` (cùng phép thử, trên khoá THẬT và CSDL THẬT, không cần phiên người vận hành — nút ở
> `/platform` vẫn dùng được), V5 ĐẠT (hai lượt deploy sau, mã khoá không đổi; canary niêm trước deploy giải đúng sau
> deploy), V6 chờ chủ nền tảng xác nhận, V7 có sẵn (`npm run platform:rotate-secrets`, chạy thử chỉ đọc — không chạy vì chủ
> dặn không xoay khoá).

| # | Kiểm | Đạt khi |
|---|---|---|
| V1 | Log run Deploy: bước "Kiểm tra Secrets bắt buộc" | `PLATFORM_SECRETS_KEY: có`; bước SSH in `PLATFORM_SECRETS_KEY: đã ghi vào .env (không in giá trị)` |
| V2 | `curl -s https://erp.vnxcommerce.com/api/health` | `platform.secretsKey = "ready"`, `secretsKeyPrevious = "absent"`, ghi lại `secretsKeyIdShort` |
| V3 | `/platform` → Cổng mở bán → A | "Sẵn sàng · mã khoá `xxxxxxxx…`" trùng 8 ký tự của V2 |
| V4 | `/platform` → «Tự kiểm khoá bí mật» | "Tự kiểm ĐẠT", mọi dòng ✓; `platform_audit_log` có một dòng `SECRETS_SELF_TEST` mang email người bấm |
| V5 | Deploy lần hai (không đổi secret), đọc lại `/api/health` | `secretsKeyIdShort` KHÔNG đổi (khoá bền qua deploy / dựng lại container) |
| V6 | Bản sao khoá ngoài VPS (C3) | Chủ nền tảng xác nhận đã cất — không ai kiểm được hộ điều này |
| V7 | Kế hoạch xoay khoá | A.4 đọc được, lệnh `npm run platform:rotate-secrets` có trong ảnh đang chạy (chạy thử = chỉ đọc) |

Chưa làm V1–V5 trước khi có tổ chức trả tiền đầu tiên thì A chưa "mở".

## B · `/start` — đăng ký tổ chức mới, bật KHÔNG CẦN DEPLOY

**Luật:** chế độ có hiệu lực = **min(trần môi trường, cài đặt control plane)** với thứ tự `off < invite < open`.

| Trần `PLATFORM_SIGNUP_MODE` \ Cài đặt ở `/platform` | `off` (mặc định) | `invite` | `open` |
|---|---|---|---|
| không đặt ⇒ trần `invite` (production hôm nay) | **off** | invite | *(bị từ chối lúc lưu)* |
| `off` — công tắc khẩn cấp | off | off | off |
| `invite` | off | invite | *(bị từ chối lúc lưu)* |
| `open` — chủ nền tảng quyết mở hẳn | off | invite | open |
| giá trị lạ ⇒ trần `off` | off | off | off |

- Cài đặt nằm ở `platform_settings['platform.signup.mode']` (migration 0172, CSDL nhà). Chưa có dòng ⇒ `off` ⇒ production
  sau bản này **vẫn TẮT**.
- Chỉ người vận hành nền tảng (tổ chức nhà + `platform:operate`) đổi được; phải ghi lý do; hộp xác nhận in nguyên văn hệ
  quả; mọi lượt đổi vào `platform_audit_log` (`SIGNUP_MODE_SET`: người, trước → sau, trần lúc đó, lý do).
- Đặt chế độ rộng hơn trần bị TỪ CHỐI (không lưu một cài đặt "chờ sẵn" để tự mở khi trần nâng sau này).
- Hiệu lực: ngay lập tức ở tiến trình nhận lượt đổi; tiến trình khác trễ tối đa 10 giây (đệm, bài kiểm khoá ≤ 30 giây).
- Người vận hành LUÔN tạo hộ khách được qua `/start`, bất kể chế độ.

**Bật `invite` (không deploy):** `/platform` → Cổng mở bán → B → Chế độ mới «Cần mã mời» → ghi lý do → Đổi… → Xác nhận.
Rồi tạo mã mời ở khung "Tự phục vụ" bên dưới và gửi liên kết `/start?invite=…` cho khách.

**Mở hẳn `open`:** cần chủ nền tảng khai trần — GitHub Variable/`.env` `PLATFORM_SIGNUP_MODE=open` — rồi deploy/khởi động
lại; sau đó người vận hành mới đặt được «Mở» ở `/platform`. (Hôm nay `install-vps.sh` không ghi biến này: trần mặc định là
`invite`.)

**Tắt khẩn cấp — một trong hai:**

1. Nhanh, không cần máy chủ: `/platform` → B → «TẮT» → Xác nhận. `/start` đóng ngay ở lượt dựng kế tiếp.
2. Tắt cứng, thắng mọi cài đặt (khi nghi `/platform` bị lạm dụng): đặt `PLATFORM_SIGNUP_MODE=off` trong `/root/erp/.env`
   trên VPS rồi dựng lại container app (`docker compose -f docker-compose.prod.yml up -d app` — lưu ý: ops `restart`
   là `docker compose restart`, KHÔNG nạp lại `.env`), hoặc chạy lại Deploy ERP to VPS (container được dựng lại). Khi trần
   là `off`, `/platform` hiện "TẮT CỨNG" và từ chối mọi lượt mở.

**Kiểm sau khi đổi:** mở `/start` ở cửa sổ ẩn danh — `off` ⇒ "Chưa mở đăng ký"; `invite` ⇒ ô mã mời; nhật ký nền tảng có
dòng `SIGNUP_MODE_SET` mang email của bạn.

## C — Sao lưu / khôi phục

Hiện trạng đã có trong mã (commit của mục này): sao lưu đêm dump mọi CSDL `erp_org_*` (PR #365); phạm vi cấu hình
tổ chức đã xác minh nằm trọn trong CSDL của nó, mặt phẳng điều khiển nằm ở CSDL nhà (`backup-recovery.md` §6); diễn
tập khôi phục cấu hình bằng blueprint ĐẠT trên PGlite và chạy trong `npm test`; diễn tập CSDL cho một tổ chức là ops
`restore-drill-org` — **chạy tay**, chưa từng chạy trên VPS. Diễn tập ĐẦU-CUỐI trên Postgres thật (tạo → tuỳ biến →
`pg_dump` → phá + `DROP DATABASE` → khôi phục theo runbook → so từng bảng → CHẠY THẬT qua mã ứng dụng) là workflow
**Diễn tập khôi phục tổ chức (Postgres tạm)** trên service container dùng một lần, không đụng production
(`backup-recovery.md` §8): ĐẠT trên máy lập trình và CI `postgres:16-alpine` (run 36545135985) ngày 29/09/2026.

**Quyết định C4 / C6 / C7 của chủ nền tảng (29/09/2026), nguyên văn:** «full backup hằng đêm; incremental/PITR mỗi giờ nếu
hạ tầng DB hỗ trợ; target RPO <= 1 giờ; target RTO <= 4 giờ; tự động restore drill mỗi tuần trên môi trường test, không
restore đè production.» Bảng mục tiêu ↔ đạt được hôm nay cho nhà và cho tổ chức khách: `backup-recovery.md` §9.1.

| Việc theo quyết định | Trạng thái |
|---|---|
| Bản đầy đủ hằng đêm (nhà + mọi `erp_org_*`) | ✓ đã chạy từ trước — không đổi |
| RPO ≤ 1 giờ cho tổ chức khách | ✓ trong mã (commit này): `erp-backup.sh hourly-org`, cron phút 47, bản logic mỗi giờ, giữ 48 bản, đẩy `gcrypt:orgs/<csdl>/hourly/`; thẻ tổ chức vàng khi > 3 giờ. Có hiệu lực từ lần deploy kế tiếp (`install-cron`) — `backup-recovery.md` §9.2 |
| RPO ≤ 1 giờ cho CSDL NHÀ | ◐ **MÃ SẴN (quyết định PITR 30/09/2026), CHỜ DEPLOY** — `archive_mode=on` + `archive_timeout=900` qua `postgres -c` trong compose, bản nền mỗi đêm, WAL ngoài máy mỗi 15 phút, 5 ops `pitr-*` (`backup-recovery.md` §9.4). Deploy mang nó TẠO LẠI `erp-db` (~10–30 giây, ƯỚC LƯỢNG — chủ nền tảng đã duyệt) ⇒ chỉ gộp + deploy trong cửa sổ bảo trì. Đạt khi C8 đạt. Tới lúc đó RPO nhà ≤ 1 ngày |
| RTO ≤ 4 giờ | ◐ runbook có thời gian từng bước (`backup-recovery.md` §10): tổ chức — phần máy ĐO 6,3 giây (tổ chức nhỏ), cả quy trình ƯỚC LƯỢNG 1–1,5 giờ (2–3 giờ khi mất VPS); nhà — CHƯA ĐO, ước lượng 1–2 giờ nếu CSDL vài GB. Đổi ước lượng thành số đo: C1 + một lượt `ops restore-drill` |
| Diễn tập tự động mỗi tuần, môi trường test, không đè production | ✓ tổ chức, hai tầng: CI mỗi tuần (`restore-drill.yml`, `cron: "0 20 * * 6"`, Postgres tạm, dữ liệu tổng hợp) + VPS mỗi Chủ nhật 06–07 giờ VN (`drill-org-weekly`, luân phiên một CSDL thật vào CSDL TẠM trong container TẠM). ✗ CSDL NHÀ: `restore-drill` vẫn chạy tay — đưa vào cron cần số RAM / thời gian của một lượt tay trước (máy 1,9 GB) |

| # | Cổng | Loại | Ai | Điều kiện đạt |
|---|---|---|---|---|
| C1 | **Lượt `restore-drill-org` đầu tiên trên VPS** cho tổ chức thật đầu tiên (sau khi nó có ít nhất một bản sao lưu) | việc chạy thật | người vận hành | ops `restore-drill-org` arg = mã tổ chức ⇒ thoát 0, dòng `DIỄN TẬP TỔ CHỨC ĐẠT`, thẻ Sao lưu của tổ chức đó hết vàng "Chưa diễn tập" (`docs/backup-restore.md` mục 8.1). Từ C7 lượt Chủ nhật tự làm việc này trong vòng một tuần; chạy tay để có số RAM / thời gian sớm hơn. **Ghi `finishedAt − startedAt` của `last-drill.json` vào `backup-recovery.md` §10.1** |
| C2 | **Bật diễn tập tổ chức TỰ ĐỘNG hay không** | ~~quyết định~~ **ĐÃ QUYẾT (C7, 29/09/2026): CÓ** | chủ nền tảng | ✓ Làm trong mã: `install-cron` cài dòng `drill-org-weekly` (phút 37 mỗi giờ, script lọc Chủ nhật 06:00–07:59 giờ VN), luân phiên một CSDL / tuần qua đúng `restore-drill-org`, trần 512 MB + kiểm RAM ≥ 700 MB trước khi dựng, cầm khoá sao lưu trước. Số RAM/thời gian thật vẫn lấy từ C1. Từ tổ chức thứ 6 trở đi, nhịp một CSDL / tuần vượt ngưỡng 35 ngày của thẻ ⇒ cần quyết định tăng nhịp |
| C3 | **Cất `PLATFORM_SECRETS_KEY` ra ngoài VPS** | quyết định + việc tay | chủ nền tảng | Khoá không thuộc phạm vi `erp-backup.sh`. Từ cổng A nó đi GitHub Secret → deploy → `/root/erp/.env`; mất VPS thì deploy lên máy mới ghi lại đúng khoá, nhưng GitHub Secret KHÔNG đọc lại được — đổi / xoá nhầm secret ⇒ bí mật kết nối (`org_connections`) trong mọi bản dump tổ chức không giải mã được (diễn tập Postgres đo: khoá khác ⇒ từ chối). Đạt khi khoá có bản sao ở trình quản lý mật khẩu / giấy cất riêng, như mật khẩu crypt của Drive (`backup-recovery.md` §8.7) |
| C4 | **Bản sao ngoài máy đã bật** (Google Drive + crypt) trước khi nhận tổ chức trả tiền đầu tiên · **lịch sao lưu (29/09/2026): đêm đầy đủ + mỗi giờ cho tổ chức; PITR cho cả cụm là bước kế tiếp** | điều kiện tiên quyết + ĐÃ QUYẾT lịch | chủ nền tảng | `backup-status` liệt kê bản dưới `gcrypt:orgs/<csdl>/{daily,hourly}/…`; thẻ Sao lưu không còn "CHƯA CÓ BẢN SAO NGOÀI MÁY" (`docs/backup-restore.md` mục 5). Lượt giờ đẩy Drive mỗi giờ, lỗi đẩy không xoá bản cục bộ. PITR: mã sẵn, bật theo C8 |
| C5 | **Tổ chức đặt CSDL ở máy khác** (`ORG_DATABASE_URL__<MÃ>`) | quyết định từng ca | chủ nền tảng | `erp-backup.sh` KHÔNG sao lưu được nó (chỉ nêu `missingDatabases`). Cấp một tổ chức như thế phải kèm lịch sao lưu + diễn tập riêng, ghi trong hồ sơ tổ chức |
| C6 | **Lời hứa với khách về RPO / RTO** | **ĐÃ QUYẾT mục tiêu (29/09/2026): RPO ≤ 1 giờ, RTO ≤ 4 giờ** | chủ nền tảng | Tổ chức khách: RPO ≤ 1 giờ ĐẠT trong mã (lượt giờ; lỡ một lượt ~2 giờ, thẻ vàng > 3 giờ); RTO phần máy ĐO 6,3 giây (CI, tổ chức nhỏ), cả quy trình ƯỚC LƯỢNG 1–1,5 giờ / 2–3 giờ khi mất VPS (`backup-recovery.md` §10.1). Nhà (VNX): RPO vẫn ≤ 1 ngày tới khi bật PITR; RTO CHƯA ĐO. Vẫn không hứa với khách con số chưa đo: phần RTO ước lượng đổi thành số đo ở C1 |
| C7 | **Lịch tự động cho diễn tập Postgres** (workflow **Diễn tập khôi phục tổ chức (Postgres tạm)**) | **ĐÃ QUYẾT (29/09/2026): mỗi tuần** | chủ nền tảng | ✓ Làm trong mã: `on: schedule: cron "0 20 * * 6"` (03:00 Chủ nhật giờ VN) + `workflow_dispatch`; `tests/restore-drill-pg.test.ts` khoá đúng hai cửa vào, lịch đúng một thứ trong tuần, 0 secret, 0 quyền ghi. Chưa thêm cửa `pull_request` (đề xuất cũ) — nằm ngoài quyết định; mở cho PR là chạy mã lạ trên một job có service container, cần quyết định riêng. Máy của GitHub, không đụng VPS, không chặn deploy |
| C8 | **PITR của `erp-db` bật trên production** | **ĐÃ LÀM (30/09/2026 22:52, #421 + #424)** — diễn tập OK hai vế 01/10 | chủ nền tảng + người vận hành | `backup-recovery.md` §9.4.5: RPO đo 1–14 phút trên máy, ≈ 30 phút ngoài máy; RTO phần máy 18 giây; gián đoạn CSDL lúc bật ≈ 2–4 giây. Còn: đưa `pitr-drill` vào lịch tuần |

Đã có sẵn, không cần cổng: dump + xoay vòng + kiểm toàn vẹn theo từng tổ chức; trạng thái theo tổ chức trên ERP;
khôi phục cấu hình từ tệp (`/settings/export` → «Cài từ tệp JSON») — đã diễn tập tự động (`scripts/restore-drill-org-config.ts`);
khôi phục CSDL tổ chức từ `pg_dump` + chạy được sau khôi phục — đã diễn tập trên Postgres tạm (`scripts/restore-drill-pg.ts`).


## D — AI: ai trả tiền, hạn mức, công tắc

Hiện trạng đã có trong mã (`docs/platform/ai-usage.md`): sổ dùng AI thống nhất `platform_ai_usage` (0176) ghi MỌI lượt AI
Builder (BYOK · PLATFORM · HOME) và mọi lượt Copilot của nhà; hạn mức AI theo gói (`limits.ai`, gieo cho trial /
standard / internal) + ghi đè theo tổ chức; `checkAiQuota` chặn TRƯỚC khi gọi model; công tắc AI toàn nền tảng + theo tổ
chức (không cần deploy, đệm 10 s); `/settings/plan`, `/platform/org/<mã>`, `/platform` hiện lượt / token / tiền ước tính.
Mô hình A (BYOK — khách tự mang khoá) đang chạy. Mô hình B (nền tảng trả tiền) đã dựng nền và **TẮT**.

| # | Cổng | Loại | Ai | Điều kiện đạt |
|---|---|---|---|---|
| D1 | **Ai trả tiền AI cho tổ chức khách: chỉ BYOK, hay có thêm credit nền tảng (B)** | quyết định kinh doanh | chủ nền tảng | Chỉ BYOK ⇒ không làm gì thêm (credit 0 ở mọi gói là trạng thái hiện tại). Có B ⇒ làm D2 → D4 theo thứ tự |
| D2 | **Tài khoản AI RIÊNG của nền tảng** + trần chi tiêu phía nhà cung cấp | việc tay + quyết định | chủ nền tảng | Một tài khoản Anthropic KHÁC tài khoản của VNX (khoá trùng khoá nhà bị mã từ chối), có trần chi tiêu tháng ở console nhà cung cấp — lớp chặn cuối nếu sổ ước tính lệch hoá đơn |
| D3 | **Nối `PLATFORM_AI_ENABLED` + `PLATFORM_AI_API_KEY` (+ `PLATFORM_AI_MODEL`) vào đường deploy** | thay đổi mã (PR riêng) | chủ nền tảng duyệt | Cùng khuôn đường ống của mục A (GitHub Secret → workflow → install-vps.sh ghi `.env` khi khác rỗng → container), có bài kiểm như `tests/launch-gates.test.ts`. **ĐÃ NỐI (0193, docs/platform/quick-start.md §5):** Secret `PLATFORM_AI_API_KEY` + Variables `PLATFORM_AI_ENABLED` / `PLATFORM_AI_PROVIDER` / `PLATFORM_AI_MODEL`; xoá Variable `PLATFORM_AI_ENABLED` rồi deploy là TẮT |
| D4 | **Credit / tháng cho từng gói** | quyết định kinh doanh | chủ nền tảng | Người vận hành sửa `platform_plans.limits.ai.platformCreditUsdPerMonth` (đề xuất `trial` 5 USD ≈ 4 bản nháp, `standard` 30 USD) hoặc ghi đè từng tổ chức ở `/platform/org/<mã>`. Kiểm: `/platform` khung D in "AI của nền tảng: có cấu hình"; một tổ chức thử không BYOK soạn được bản nháp, dòng sổ mang nguồn `PLATFORM` |
| D5 | **Hạn mức mặc định cho BYOK** (10 lượt/ngày · 100/tháng · cảnh báo 20 / trần 50 USD ở `trial`) | quyết định | chủ nền tảng | Giữ hoặc sửa số trong `platform_plans`. Trần tiền của BYOK là tiền của KHÁCH — trần ở đây bảo vệ khách khỏi hoá đơn bất ngờ, không phải doanh thu |

**Tắt khẩn cấp AI (không cần deploy):** `/platform` → khung «D · AI» → Tắt AI… → lý do → Xác nhận (mọi tổ chức, kể cả
nhà, chỉ AI Builder). Một tổ chức: `/platform/org/<mã>` → «Dùng AI» → tích "Tắt AI Builder" → lý do → Lưu. Tắt cứng
nhánh B: bỏ `PLATFORM_AI_ENABLED` khỏi `.env` rồi dựng lại container app.

## Bài kiểm

- `tests/launch-gates.test.ts` — ba chặng của A (quét mã + CHẠY THẬT khối ghi `.env` dưới `bash -euo pipefail`: rỗng giữ
  nguyên từng byte, base64 qua `sed` nguyên vẹn, ký tự lạ bị từ chối, không in giá trị).
- `tests/connectors.test.ts` — lưu → kiểm tra → bật → `openActiveConnection` ra đúng bản rõ; màn hình / action chỉ có
  `••••` + 4 ký tự và mã khoá rút gọn.
  Cổng A (29/09): tự kiểm fail-closed (bộ giải bỏ qua AAD / nuốt lỗi / ném lỗi lạ ⇒ HỎNG), chỉ người vận hành, đúng một
  dòng `platform_audit_log`; PREVIOUS giải bản mã cũ, trùng / ngắn ⇒ `invalid`; vòng đời trên hai tổ chức thật: cập nhật
  ⇒ Nháp và luồng chạy không nhận bí mật tới khi bật lại, khởi động lại vẫn giải được, khoá sai ⇒ từ chối không rác, A
  không đọc được bản mã của B; xoay khoá chạy thử 0 byte + 0 nhật ký, chạy thật mã hoá lại mọi dòng giải được (trạng thái
  không đổi, dòng hỏng giữ nguyên), chạy lại 0 đổi, gỡ PREVIOUS vẫn đúng bản rõ; QUÉT mọi bảng của A / B / nhà và mọi
  `console.*`: không bản rõ nào. `tests/launch-gates.test.ts` thêm: PREVIOUS đi đủ ba chặng (chạy thật: không đụng dòng
  khoá hiện tại), `/api/health` chỉ trạng thái + 8 hex.
- `tests/ai-usage.test.ts` — mục D: một dòng sổ / lượt đúng nguồn, BLOCKED_QUOTA không gọi model, cảnh báo một lần / ngày,
  A không trừ B, BYOK không trừ credit nền tảng, không cấu hình ⇒ không PLATFORM và không rơi về khoá nhà, công tắc chặn
  trước model, người không vận hành không đổi được, chi phí chưa biết giữ NULL.
- `tests/onboarding.test.ts` — bảng chân lý 6 trần × 3 cài đặt; trần `off` thắng; không phải người vận hành / tổ chức khác
  không đổi được và không để lại dòng; nhật ký có dòng; `/start` phản ánh ngay; qua hạn đệm thì thấy lượt ghi của tiến
  trình khác. `tests/tenant-attack.test.ts` — phiên của tổ chức khác gọi thẳng `setSignupModeAction` bị từ chối.
