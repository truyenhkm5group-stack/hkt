# Cổng mở bán nền tảng — A · khoá bí mật kết nối · B · /start · C · sao lưu / khôi phục · D · AI

> Hai việc cuối cùng giữa "Phase 1 → 12 đã lên production" và "tổ chức thứ hai dùng được thật". Cả hai đều MẶC ĐỊNH TẮT
> và tắt thì tổ chức nhà (VNX) không đổi gì. Trạng thái của cả hai hiện ở `/platform` → khung **Cổng mở bán**.

## A · `PLATFORM_SECRETS_KEY` — khoá mã hoá bí mật kết nối theo tổ chức

**Nó làm gì.** Tổ chức khác lưu bí mật của chính họ (Lark, Telegram, khoá AI) ở `/settings/connections`; bí mật được mã
hoá AES-256-GCM bằng khoá dẫn xuất từ biến này (`lib/connectors/secrets.ts`). Thiếu khoá ⇒ lưu bí mật bị TỪ CHỐI, màn
hình nói rõ; không có đường lùi về khoá nào khác.

**Đường ống (đã nối, kiểm ở `tests/launch-gates.test.ts`):**

```
GitHub Secret PLATFORM_SECRETS_KEY
  → .github/workflows/deploy-vps.yml   bước SSH: env + envs + export
  → scripts/bootstrap.sh               exec sang install-vps.sh, môi trường giữ nguyên
  → scripts/install-vps.sh             ghi .env CHỈ khi khác rỗng (rỗng ⇒ giữ giá trị cũ, không dòng rỗng)
  → docker-compose.prod.yml            env_file: .env ⇒ container app + scheduler
```

Không bước nào in giá trị; log deploy chỉ nói "có / chưa có". Secret bị xoá nhầm KHÔNG xoá khoá trên máy (xoá khoá là
làm mọi bí mật đã lưu thành rác). Giá trị có ký tự ngoài base64 bị từ chối ghi (không làm hỏng `.env`).

**Việc của chủ nền tảng — đúng MỘT thao tác:**

1. GitHub → Settings → Secrets and variables → Actions → **New repository secret**: tên `PLATFORM_SECRETS_KEY`, giá trị
   là đầu ra của `openssl rand -base64 48` (chạy trên máy của bạn, dán thẳng vào ô, không lưu ở đâu khác).
2. Actions → **Deploy ERP to VPS** → Run workflow (nhánh `main`, `reset_env` để trống).

**Kiểm sau khi bật:**

- Log bước "Kiểm tra Secrets bắt buộc" in `PLATFORM_SECRETS_KEY: có`; bước SSH in `PLATFORM_SECRETS_KEY: đã ghi vào .env`.
- `/platform` → Cổng mở bán → **A · Sẵn sàng · mã khoá `xxxxxxxx…`** (8 ký tự đầu của MÃ khoá — HMAC, không suy ngược ra
  khoá; dùng để biết khoá có bị đổi hay không).
- Một tổ chức thử: `/settings/connections` → Lark webhook hoặc Telegram → Lưu → Kiểm tra → Bật. Lưu được là xong.

**Lưu ý không đảo ngược được:** đổi hoặc mất khoá ⇒ mọi bí mật đã lưu phải nhập lại (không có đường khôi phục — có chủ
ý). Sao lưu khoá ở kho mật khẩu của chủ nền tảng; bản dump CSDL KHÔNG giải được nếu thiếu nó (`backup-recovery.md` mục 7).

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


## D — AI: ai trả tiền, hạn mức, công tắc

Hiện trạng đã có trong mã (`docs/platform/ai-usage.md`): sổ dùng AI thống nhất `platform_ai_usage` (0175) ghi MỌI lượt AI
Builder (BYOK · PLATFORM · HOME) và mọi lượt Copilot của nhà; hạn mức AI theo gói (`limits.ai`, gieo cho trial /
standard / internal) + ghi đè theo tổ chức; `checkAiQuota` chặn TRƯỚC khi gọi model; công tắc AI toàn nền tảng + theo tổ
chức (không cần deploy, đệm 10 s); `/settings/plan`, `/platform/org/<mã>`, `/platform` hiện lượt / token / tiền ước tính.
Mô hình A (BYOK — khách tự mang khoá) đang chạy. Mô hình B (nền tảng trả tiền) đã dựng nền và **TẮT**.

| # | Cổng | Loại | Ai | Điều kiện đạt |
|---|---|---|---|---|
| D1 | **Ai trả tiền AI cho tổ chức khách: chỉ BYOK, hay có thêm credit nền tảng (B)** | quyết định kinh doanh | chủ nền tảng | Chỉ BYOK ⇒ không làm gì thêm (credit 0 ở mọi gói là trạng thái hiện tại). Có B ⇒ làm D2 → D4 theo thứ tự |
| D2 | **Tài khoản AI RIÊNG của nền tảng** + trần chi tiêu phía nhà cung cấp | việc tay + quyết định | chủ nền tảng | Một tài khoản Anthropic KHÁC tài khoản của VNX (khoá trùng khoá nhà bị mã từ chối), có trần chi tiêu tháng ở console nhà cung cấp — lớp chặn cuối nếu sổ ước tính lệch hoá đơn |
| D3 | **Nối `PLATFORM_AI_ENABLED` + `PLATFORM_AI_API_KEY` (+ `PLATFORM_AI_MODEL`) vào đường deploy** | thay đổi mã (PR riêng) | chủ nền tảng duyệt | Cùng khuôn đường ống của mục A (GitHub Secret → workflow → install-vps.sh ghi `.env` khi khác rỗng → container), có bài kiểm như `tests/launch-gates.test.ts`. HÔM NAY chưa nối: tên biến chỉ khai ở `.env.example` (không giá trị) |
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
- `tests/ai-usage.test.ts` — mục D: một dòng sổ / lượt đúng nguồn, BLOCKED_QUOTA không gọi model, cảnh báo một lần / ngày,
  A không trừ B, BYOK không trừ credit nền tảng, không cấu hình ⇒ không PLATFORM và không rơi về khoá nhà, công tắc chặn
  trước model, người không vận hành không đổi được, chi phí chưa biết giữ NULL.
- `tests/onboarding.test.ts` — bảng chân lý 6 trần × 3 cài đặt; trần `off` thắng; không phải người vận hành / tổ chức khác
  không đổi được và không để lại dòng; nhật ký có dòng; `/start` phản ánh ngay; qua hạn đệm thì thấy lượt ghi của tiến
  trình khác. `tests/tenant-attack.test.ts` — phiên của tổ chức khác gọi thẳng `setSignupModeAction` bị từ chối.
