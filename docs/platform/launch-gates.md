# Cổng mở bán nền tảng — A · khoá bí mật kết nối · B · /start · C · sao lưu / khôi phục

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
`restore-drill-org` — **chạy tay**, chưa từng chạy trên VPS.

| # | Cổng | Loại | Ai | Điều kiện đạt |
|---|---|---|---|---|
| C1 | **Lượt `restore-drill-org` đầu tiên trên VPS** cho tổ chức thật đầu tiên (sau khi nó có ít nhất một bản sao lưu đêm) | việc chạy thật | người vận hành | ops `restore-drill-org` arg = mã tổ chức ⇒ thoát 0, dòng `DIỄN TẬP TỔ CHỨC ĐẠT`, thẻ Sao lưu của tổ chức đó hết vàng "Chưa diễn tập" (`docs/backup-restore.md` mục 8.1) |
| C2 | **Bật diễn tập tổ chức TỰ ĐỘNG hay không** — vd luân phiên một CSDL `erp_org_*` mỗi Chủ nhật sau lượt sao lưu | quyết định (đổi lịch / hành vi vận hành, AGENTS.md mục 7) | chủ nền tảng | Có ⇒ một PR thêm lời gọi `restore-drill-org` (không mã = luân phiên) vào `install-cron`, kèm con số RAM/thời gian đo từ C1. Không ⇒ ghi lịch chạy tay (đề xuất: mỗi tháng một lượt / tổ chức, cùng nhịp `restore-drill` của nhà). Máy 2 nhân / ~1,9 GB đang phục vụ người dùng thật — container diễn tập trần 512 MB |
| C3 | **Cất `PLATFORM_SECRETS_KEY` ra ngoài VPS** | quyết định + việc tay | chủ nền tảng | Khoá chỉ nằm trong `/root/erp/.env`, không thuộc phạm vi `erp-backup.sh`, không đi qua GitHub Secrets (đo 28/09/2026). Mất VPS ⇒ bí mật kết nối (`org_connections`) trong mọi bản dump tổ chức không giải mã được. Đạt khi khoá có bản sao ở trình quản lý mật khẩu / giấy cất riêng, như mật khẩu crypt của Drive |
| C4 | **Bản sao ngoài máy đã bật** (Google Drive + crypt) trước khi nhận tổ chức trả tiền đầu tiên | điều kiện tiên quyết | chủ nền tảng | `backup-status` liệt kê bản dưới `gcrypt:orgs/<csdl>/…`; thẻ Sao lưu không còn "CHƯA CÓ BẢN SAO NGOÀI MÁY" (`docs/backup-restore.md` mục 5) |
| C5 | **Tổ chức đặt CSDL ở máy khác** (`ORG_DATABASE_URL__<MÃ>`) | quyết định từng ca | chủ nền tảng | `erp-backup.sh` KHÔNG sao lưu được nó (chỉ nêu `missingDatabases`). Cấp một tổ chức như thế phải kèm lịch sao lưu + diễn tập riêng, ghi trong hồ sơ tổ chức |
| C6 | **Lời hứa với khách về RPO / RTO** | quyết định kinh doanh | chủ nền tảng | Số đo được hôm nay: RPO ≤ 1 ngày (một bản / đêm, khung 02–05 giờ VN; tổ chức chạy SAU nhà, nhà hỏng thì tổ chức không có bản đêm đó). RTO chưa đo — lấy từ thời gian của C1. Không hứa con số chưa đo |

Đã có sẵn, không cần cổng: dump + xoay vòng + kiểm toàn vẹn theo từng tổ chức; trạng thái theo tổ chức trên ERP;
khôi phục cấu hình từ tệp (`/settings/export` → «Cài từ tệp JSON») — đã diễn tập tự động (`scripts/restore-drill-org-config.ts`).


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
- `tests/onboarding.test.ts` — bảng chân lý 6 trần × 3 cài đặt; trần `off` thắng; không phải người vận hành / tổ chức khác
  không đổi được và không để lại dòng; nhật ký có dòng; `/start` phản ánh ngay; qua hạn đệm thì thấy lượt ghi của tiến
  trình khác. `tests/tenant-attack.test.ts` — phiên của tổ chức khác gọi thẳng `setSignupModeAction` bị từ chối.
