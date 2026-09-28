# Phase 9 — Connector / Extension foundation: hợp đồng (cập nhật theo mã đã làm)

> Không viết lại tích hợp đang chạy (Pancake, Viettel Post, Meta, SePay, Lark/Telegram, Gemini/Anthropic/OpenAI…).
> Chúng giữ nguyên đường chạy của tổ chức nhà (VNX). Phase 9 KHAI chúng vào một sổ và mở đường cho tổ chức khác.
> Mã: `lib/connectors/*`, `lib/actions/connections.ts`, `app/(dashboard)/settings/connections/`,
> `components/connectors/*`, migration `0164_org_connections`. Bài kiểm: `tests/connectors.test.ts`.

## 1. Sổ connector (`lib/connectors/registry.ts`, thuần, client-safe)

```ts
ConnectorSpec = {
  key; label; vendor;
  kind: "ORDER_SOURCE" | "SHIPPING" | "PAYMENT" | "ADS" | "MESSAGING" | "ACCOUNTING" | "AI" | "STORAGE" | "PLATFORM";
  capabilities: string[];               // tập ĐÓNG theo kind (CAPABILITIES_BY_KIND)
  auth: "API_KEY" | "USERNAME_PASSWORD" | "OAUTH_TOKEN" | "WEBHOOK_SECRET" | "NONE";
  settings: SettingField[];             // { key; label; type: "text"|"url"; secret; required; hint?; pattern?; maxLength?; envVar? }
  config: { store: "ENV" | "ORG_CONNECTIONS" | "SETTINGS_TABLE" | "NONE"; where: string };
  webhook: null | { path; verify; tenantResolution: "URL_SECRET" | "SIGNATURE" | "HOME_ONLY"; idempotencyKey; binding };
  tenancy: "HOME_ONLY" | "PER_ORG";
  health: "testConnection" | null; healthRef: "tệp::hàm" | null;   // hàm kiểm tra THẬT, bài kiểm tìm nó trong mã
  module: ModuleKey; code: string[]; consumers: string[]; why: string;
}
```

Khác bản khởi đầu (đọc mã thật mới thấy cần):

- `kind: "PLATFORM"` — GitHub (deploy, PR, agent) là của NGƯỜI VẬN HÀNH nền tảng, không thuộc tám loại nghiệp vụ.
- `config.store` — cài đặt không phải lúc nào cũng ở một chỗ: biến môi trường (nhà), `settings` (link Google Sheet ở
  `/landing`, kênh Lark ở `/alerts`), `org_connections` (mới), hoặc không cần (sao kê tải lên).
- `code` — tệp hiện thực; là thứ để bài kiểm đối chiếu sổ ↔ `lib/integrations/*` hai chiều.
- `consumers` — luồng nào ĐỌC kết nối theo tổ chức lúc chạy. Rỗng ⇒ màn hình nói "chưa luồng nào dùng".
- `envVar` — biến môi trường giữ giá trị của nhà; bài kiểm đòi mọi `CUSTOMER_CREDENTIAL_ENV` có chủ.
- `webhook.binding` — dòng trong `WEBHOOK_BINDINGS`; chế độ phân giải phải khớp.

Sổ hôm nay: **18 connector — 14 `HOME_ONLY`, 4 `PER_ORG`** (ORDER_SOURCE 2 · SHIPPING 2 · PAYMENT 2 · ADS 1 ·
MESSAGING 6 · AI 3 · STORAGE 1 · PLATFORM 1). `PER_ORG`: `google-sheet-landing` (settings, đã theo tổ chức từ
trước), `bank-statement-file` (không khoá), và hai kết nối MỚI lưu ở `org_connections`: `lark-webhook`,
`telegram-bot`. `lib/integrations/http.ts` là helper (`INTEGRATION_HELPERS`), không phải connector.

Phase 8 thêm hai kết nối AI `PER_ORG` (sổ thành **20 — 14 `HOME_ONLY`, 6 `PER_ORG`**, AI 5): `anthropic-byok`,
`openai-byok` — khoá AI của CHÍNH tổ chức cho AI Builder. Kiểm tra = `GET /v1/models` (chỉ đọc, không tốn token), chỉ
tới địa chỉ hằng của nhà cung cấp. Consumer đầu tiên đọc bí mật lúc chạy qua `openActiveConnection()` (service vẫn là
nơi DUY NHẤT giải mã; connector chưa khai `consumers` bị từ chối).

## 2. Kết nối theo tổ chức

- Bảng `org_connections` trong CSDL CỦA TỔ CHỨC (migration `0164`, CHỈ THÊM, idempotent): `org_code` (dây bẫy — dòng
  chép sang CSDL khác bị từ chối), `connector_key` UNIQUE, `status DRAFT|ACTIVE|DISABLED`, `settings jsonb` (không bí
  mật), `secrets_enc bytea`, `secrets_key_id`, `secret_hints jsonb` (`••••` + 4 ký tự cuối, ghi lúc lưu), `last_test_at /
  last_test_ok / last_test_message`, `activated_at/by`, `created_by/updated_by`. Ràng buộc CSDL
  `org_connections_active_tested_check`: `ACTIVE` chỉ khi `last_test_ok = true`.
- Mã hoá (`lib/connectors/secrets.ts`): AES-256-GCM; khoá HKDF-SHA256 từ `PLATFORM_SECRETS_KEY` (≥ 32 ký tự) — thiếu /
  ngắn ⇒ lưu bí mật TẮT với câu nói rõ, KHÔNG lùi về `AUTH_SECRET` hay khoá cứng; nonce 12 byte ngẫu nhiên mỗi lần;
  AAD `org:<mã>|connector:<khoá>|v1` (bản mã chép sang tổ chức / connector khác không giải được); `secrets_key_id` để
  báo "khoá máy chủ đã đổi" thay vì một lỗi mơ hồ.
- Không bao giờ trả bí mật về client (chỉ `secret_hints`), không log (`lib/connectors/*` không có `console.*`), không vào
  ngữ cảnh AI (`lib/ai|agents/*` không import `lib/connectors/*`); chỉ `lib/connectors/service.ts` giải mã và chạm bảng.
- Tổ chức nhà (VNX): màn hình hiện các connector HOME_ONLY ở chế độ CHỈ ĐỌC — đã cấu hình hay chưa, đọc bằng các getter
  có sẵn (`integrationStatus()`, `loadAlertConfig()`, `env.*`), không một ký tự giá trị; KHÔNG chuyển credential của VNX
  sang bảng mới (X7). Tổ chức khác thấy "Chỉ tổ chức nhà — chưa mở" và KHÔNG được đọc trạng thái của nhà.
- Luồng: Lưu ⇒ NHÁP + xoá kết quả kiểm tra cũ · Kiểm tra (gọi thật) · Bật chỉ khi kiểm tra đạt, do người bấm · kiểm tra
  hỏng trên kết nối đang bật ⇒ về NHÁP. Mọi lượt ghi `audit_logs` (`ORG_CONNECTION_SAVE|TEST|ACTIVATE|DISABLE`, không bí
  mật). AI không bao giờ bật (không có công cụ AI nào chạm tệp này).
- Hàm kiểm tra (`lib/connectors/testers.ts`): Lark — gửi MỘT tin thử, chỉ tới `open.larksuite.com` / `open.feishu.cn`
  `/open-apis/bot/v2/hook/…`; Telegram — `getMe` (chỉ đọc) rồi MỘT tin thử, chỉ tới `api.telegram.org`. Không theo
  chuyển hướng (chống SSRF), trần 10 giây, đọc `code` trong phong bì, che bí mật trong câu lỗi. Không đọc biến môi
  trường nào ⇒ không credential nào của VNX đi qua đây.
- Quyền màn hình `/settings/connections`: `settings:manage` (lõi). `integrations:*` thuộc module «Kết nối dữ liệu» chỉ
  tổ chức nhà bật được — dùng nó thì tổ chức khác không bao giờ tới được màn hình khai kết nối của chính mình.
- CHƯA nối: luồng cảnh báo (`loadAlertConfig`, `postToLark`) vẫn chặn tổ chức khác và chưa đọc `org_connections`.
  `consumers: []` nói ra điều đó trên màn hình. Nối là bước sau (đọc qua một hàm của service, không đọc bảng thẳng).

## 3. Webhook

KHÔNG đổi route webhook đang chạy của VNX (bốn route vẫn `HOME_ONLY` trong `WEBHOOK_BINDINGS`). Phase 9 CHƯA thêm
webhook theo tổ chức: hai kết nối `PER_ORG` hiện có đều là chiều RA. Khi thêm: phân giải tổ chức TƯỜNG MINH (bí mật
trong URL ánh xạ tới đúng một tổ chức qua mặt phẳng điều khiển, hoặc chữ ký) — không suy từ nội dung gói tin;
idempotent theo khoá khai trong sổ; audit mỗi gói tin; chế độ mới vào `WEBHOOK_BINDINGS` và bài kiểm đòi khớp.

## 4. Hợp đồng mở rộng (`docs/platform/extension-contracts.md`)

Năm điểm cắm đã có sổ: khối trang (`COMPONENT_REGISTRY`), nguồn dữ liệu (`lib/pages/catalog.ts`), action
(`PAGE_ACTIONS`), trigger/action luật (`lib/workflow/*` + `DOMAIN_EVENTS`), connector (`lib/connectors/registry.ts`).
Mỗi điểm: hình dạng, bài kiểm bắt buộc, cách thêm một mục mà không sửa lõi. Chưa làm chợ plugin.

## 5. Việc của người (HUMAN GATE)

- `PLATFORM_SECRETS_KEY` trên production: chuỗi ngẫu nhiên ≥ 32 ký tự (vd `openssl rand -base64 48`), đặt ở `.env`
  máy chủ / GitHub Secret. Thiếu nó KHÔNG làm hỏng gì của VNX — chỉ tắt việc lưu bí mật kết nối theo tổ chức (màn hình
  nói rõ). Đổi / mất khoá ⇒ mọi bí mật đã lưu phải nhập lại (không có đường khôi phục — có chủ ý). Là quyết định của
  chủ nền tảng: thêm một secret mới vào môi trường production (AGENTS.md mục 7).
