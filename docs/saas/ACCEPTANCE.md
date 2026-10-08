# Nghiệm thu khách Chốt Đơn trên production — ops `saas-acceptance`

*Launch sprint 08/10/2026. Lõi: `lib/saas/acceptance.ts` · sổ khai: `lib/constants/saas-acceptance.ts` · script:
`scripts/saas-acceptance.ts` · bài kiểm: `tests/saas-acceptance.test.ts`.*

Smoke sau deploy (`scripts/smoke.ts`) mở màn hình bằng phiên của NGƯỜI NHÀ. Ops này đi vai KHÁCH: một workspace Chốt Đơn THỬ
(`cdt-nghiem-thu`, tài khoản EXTERNAL, tên hiển thị «Kiểm thử nghiệm thu — không phải khách thật») đi qua đúng các đường mà khách
trả tiền đầu tiên sẽ đi.

## 1. Chứng minh được gì

| Bước | Chứng minh | Đường đi (không đường thứ hai) |
|---|---|---|
| A | Workspace thử tồn tại và đúng cấu hình: job «Tạo khách» xong, tài khoản EXTERNAL, thương hiệu `chotdon`, gói dùng thử của bảng giá CATALOG đang hiệu lực + ghim giá V1, module `ai_sales` bật, mẫu «Chỉ cần AI bán hàng» (khi job có bước đó), chỉ mục đăng nhập email ⇒ workspace, AI theo gói còn được trả lời (dùng thử chưa hết hạn) | `--apply`: `requestProvisioning` — ĐÚNG job mà form «Tạo khách mới» gọi; người thao tác là MÁY (`actor = null`, «Nghiệm thu tự động», AGENTS 34) |
| B | Kích hoạt → trang `/reset` → đăng nhập bằng **email + mật khẩu, KHÔNG mã tổ chức** ra đúng workspace thử; liên kết dùng một lần; mật khẩu sai bị từ chối; cuối lượt mật khẩu bị xoay sang một mật khẩu ngẫu nhiên rồi vứt | `resendActivation` (luật của nút «Gửi lại kích hoạt») / «Đặt lại mật khẩu cho khách» khi đã kích hoạt · `lookupResetToken` + `completePasswordResetCore` (hai hàm của trang `/reset`) · `matchingLoginOrganizations` + `verifyLogin` (lõi của form `/login`) |
| C | Vỏ app 8 mục mở được qua host `app.<CHOTDON_DOMAIN>`: mỗi mục 200, mang dấu vỏ + thương hiệu Chốt Đơn, KHÔNG lộ khung ERP nội bộ, không vòng chuyển hướng, không bị đá về `/login`, không bị cổng quyền / module đưa về trang nhà (`?forbidden=1` · `/module-disabled`); `/` về trang nhà; một tuyến ERP bị chặn về trang nhà | GET thật tới `127.0.0.1:3000` (như smoke) với phiên ký bằng `signSession`; danh sách tuyến DẪN XUẤT từ `salesAgentNavFor` |
| D | (`--e2e`) Khách web hỏi giá → đặt 2 sản phẩm mẫu kèm SĐT + địa chỉ → đồng ý ⇒ AI trả lời từng lượt, đơn **CONFIRMED** trong OMS đúng SKU · số lượng · SĐT · xã; in chi phí AI của lượt | `openConversation("WEB")` + `chatTurn` — lõi chat công khai gọi sau bước định tuyến; đơn do BOT tạo / chốt |
| E | `https://<slug>.<PLATFORM_BASE_DOMAIN>/chat` trả 200 + tên shop, cả qua ứng dụng lẫn qua mạng ngoài (DNS + Caddy + chứng chỉ); in tên miền gốc đang dùng | GET thật |

## 2. KHÔNG chứng minh được gì

- **Không gửi email thật** — nền tảng chưa có kênh thư; liên kết kích hoạt chỉ sống trong bộ nhớ tiến trình.
- **Không đi Meta / Messenger / Zalo** — Meta chưa duyệt quyền Page; E2E đi kênh CHAT WEB.
- **Không bấm giao diện**: B và D gọi đúng lõi mà nút / trang gọi, nhưng không qua trình duyệt (không đo JavaScript phía khách, không
  đo server action qua HTTP). C và E đo HTML thật do máy chủ dựng.
- **Không đo đồng hồ «khách AI» và trần tần suất của chat công khai** (`lib/sales-chatbot/public.ts` ghi chúng sau bước định tuyến
  theo host) — lượt nghiệm thu gọi lõi ngay sau bước đó, nên KHÔNG tiêu hạn mức dùng thử và KHÔNG vào bảng kê.
- **Không xác nhận đơn bằng nút nhanh**: nếu AI không chốt sau lời đồng ý, D báo FAIL và để người bấm «Xác nhận đơn» ở hộp thư —
  ops không bấm hộ.
- **Không gia hạn dùng thử**: dùng thử V1 có 7 ngày. Hết hạn ⇒ A báo FAIL kèm việc người vận hành làm (/platform/org/<mã> → «Thu phí
  thuê bao» → «Đã trả tới ngày»); ops không tự gia hạn ngầm.

## 3. Chuẩn bị MỘT lần trên UI (cho D và E)

Ops **không ghi hộ** vào workspace (chỉ đạo 08/10/2026): tạo sản phẩm, bật bot, xuất bản là việc của NGƯỜI, đăng nhập bằng chính tài
khoản thử. Thiếu phần nào thì D / E báo **SKIP** kèm đúng phần thiếu.

1. Người vận hành: /platform/customers → khách «Kiểm thử nghiệm thu» → «Đặt lại mật khẩu cho khách» (email `nghiem-thu@chotdontudong.com`)
   → mở liên kết, đặt mật khẩu, đăng nhập (không cần mã tổ chức). Lượt `--apply` kế tiếp sẽ xoay mật khẩu này — muốn quay lại UI
   thì đặt lại lần nữa.
2. **Sản phẩm** → Tạo sản phẩm: tên `Mẫu · Áo thun nghiệm thu`, mã / SKU `NT-AO-01`, giá **150.000 ₫** (một mẫu mã). Rồi **Nhập hàng**
   (phiếu kho) ≥ 10 cái — bot chỉ chốt khi tồn khả dụng đủ.
3. **AI Sales** → bật bot (giữ đủ công cụ «Tìm sản phẩm» · «Lên đơn nháp» · «Chốt đơn»; giờ làm việc tắt hoặc 24/7). Nếu trang báo AI
   chưa sẵn sàng: người vận hành cấu hình «AI của workspace» ở /platform/org/cdt-nghiem-thu.
4. **Cài đặt → Thiết lập & xuất bản** (/setup): tên miền con `cdt-nghiem-thu` → Xuất bản.

Sổ khai giữ đúng các giá trị này (`ACCEPTANCE_SAMPLE_PRODUCTS`, `ACCEPTANCE_WORKSPACES[].domainSlug`); đổi ở UI mà không đổi sổ ⇒ D / E
báo đúng chỗ lệch.

## 4. Cách chạy

Actions → «Vận hành ERP trên VPS» → `saas-acceptance`, ô arg:

| arg | Chế độ | Ghi gì |
|---|---|---|
| (rỗng) | CHỈ ĐỌC — script đặt `ERP_READ_ONLY=1` và hỏi lại Postgres; A kiểm · C · E | không ghi (các trang được mở như một người dùng mở) |
| `--apply` | GHI — thêm cấp phát (lần đầu) + B | xem §5 |
| `--apply --e2e` | GHI + TỐN AI — thêm D | xem §5 |
| `--org=<mã>` | chỉ khi sổ khai có nhiều mục | — |

Kết quả MÃ HOÁ như mọi ops trả dữ liệu; log công khai chỉ có ĐÚNG MỘT dòng
`[ops:tom-tat] saas-acceptance: <PASS|FAIL> <n đạt>/<n> · hỏng … · bỏ qua … · chế độ … · workspace cdt-nghiem-thu · miền chat <miền gốc>`.
Có FAIL ⇒ mã thoát 1; mã ngoài sổ / arg sai ⇒ 64; chạy thử mà CSDL không chỉ đọc ⇒ 70.

**Hiệu lực**: ops lấy SCRIPT từ `main` nhưng `lib/` từ IMAGE đang chạy — chỉ chạy được sau lượt deploy mang `lib/saas/acceptance.ts`.

Thứ tự lần đầu trên production: deploy → `--apply` (tạo workspace, kích hoạt, đăng nhập) → người làm §3 → `--apply --e2e` → từ đó
`(rỗng)` sau mỗi deploy, `--apply --e2e` khi cần bằng chứng trọn vòng.

## 5. Dữ liệu ops ghi (chỉ trên workspace thử)

- Lần đầu: một job `platform_provisioning_jobs` (khoá cố định `saas-acceptance:cdt-nghiem-thu`) ⇒ tài khoản + workspace + CSDL +
  thuê bao dùng thử + quản trị. Job đã xong thì lượt sau KHÔNG gửi lại (gửi lại cùng khoá mà danh mục / bảng giá đã đổi sẽ bị
  từ chối là «thông tin KHÁC»); job hỏng / treo thì chạy lại đúng job ấy.
- Mỗi `--apply`: hai liên kết đặt lại (`password_reset_tokens`, chỉ băm) + hai lượt đổi mật khẩu (thu hồi phiên), một lượt đăng nhập
  (`lastLoginAt`, nhật ký `LOGIN`, mốc dùng của chỉ mục danh tính), nhật ký nền tảng `PASSWORD_RESET_LINK` đứng tên MÁY nguồn SCRIPT.
- Mỗi `--e2e`: một hội thoại WEB (khoá khách truy cập theo mã lượt chạy), các tin + dòng sổ AI, một khách (SĐT thử `0900000001`) và
  một đơn do bot tạo / chốt — giữ lại làm vết, không xoá.

Ops KHÔNG ghi: sản phẩm, cấu hình bot, xuất bản, xác nhận đơn tay, gia hạn, thu phí.

## 6. Chi phí AI mỗi lượt

Chỉ `--e2e` gọi AI (3–4 lượt khách, mỗi lượt một vài lời gọi model của AI dùng chung). Số THẬT đọc từ sổ AI theo hội thoại của lượt và
in ở dòng D + dòng tóm tắt («AI lượt này ≈ … USD»); lượt chưa định giá in «CHƯA ĐỊNH GIÁ», không in 0. Chạy thử / `--apply` không gọi AI.

## 7. Khi nào chạy

Sau mỗi deploy chạm: vỏ app (`lib/constants/saas-nav.ts`, `components/saas-shell.tsx`, layout) · danh tính / đăng nhập / đặt lại mật
khẩu · cấp phát / «Tạo khách» · bot bán hàng · đơn hàng. Tối thiểu chạy thử (rỗng); có chạm bot / đơn thì `--apply --e2e`.

## 8. Workspace thử KHÔNG phải khách — loại khỏi chỉ số, giữ chỗ tên

Một vị ngữ dùng chung (`acceptanceWorkspaceOf`, tệp lá `lib/constants/saas-acceptance-registry.ts`):

- **Loại khỏi chỉ số khách**: sổ kinh tế SaaS không chụp nó (`captureSaasSnapshot` — không ảnh chụp MRR, không mốc vòng đời /
  kích hoạt, không số dùng theo ngày); buồng lái (`lib/platform/saas-cockpit.ts`) không đếm nó ở số khách, vòng đời, phễu kích
  hoạt, MRR, AI của khách, số dùng — và in RIÊNG một dòng «Không tính workspace kiểm thử … chi phí AI của lượt nghiệm thu» (tiền
  thật, không giấu); phân bổ chi phí chung (`EQUAL_ACTIVE_WORKSPACES`) và kinh tế sản phẩm không chia / đếm nó; ô tổng của kinh
  tế đơn vị (`lib/pricing/admin.ts`) không cộng nó. Danh sách khách (/platform/customers) vẫn hiện tài khoản thử, gắn nhãn
  «Kiểm thử», không vào ô đếm.
- **Vẫn hiện, có chủ ý**: hàng canh hạn mức AI của nó (`lib/pricing/admin.ts`, vẫn phải canh), bảng thu phí (gia hạn dùng thử ở
  /platform/org/<mã>), top chi phí AI (`lib/ai-usage/view.ts` — tiền thật), tóm tắt hỗ trợ /platform.
- **Giữ chỗ tên**: mã + tên miền con của sổ không ai tự đăng ký (`orgStepZ`, `freeOrgCode`) hay tự đặt tên miền con
  (`checkDomainSlug`) được — kho mã PUBLIC, mã đã lộ. Chỉ job «Tạo khách» của ops mang được mã ấy.

Workspace chưa tồn tại trên production lúc thêm luật này ⇒ mọi số hiện có không đổi.

## 9. Tám tín hiệu vận hành O1–O8 — ops `ops-signals-check`

Actions → «Vận hành ERP trên VPS» → `ops-signals-check` (ô arg để trống; CHỈ ĐỌC — script đặt `ERP_READ_ONLY=1` và hỏi lại
Postgres). Nó gọi ĐÚNG `loadOpsSignalsForOrgs` của khung «Sự cố 24 giờ / 7 ngày» ở `/platform/org/<mã>` cho MỌI tổ chức trong sổ, dưới
danh tính một tài khoản tổ chức nhà mà bộ tính quyền của phiên nói là có `platform:operate`. Chi tiết từng tổ chức đi phần MÃ HOÁ; log
công khai chỉ có số tổ chức ở từng mức (OK · WARNING · CRITICAL · UNKNOWN · NA) + số ô tính hỏng của mỗi tín hiệu, và mức + mã lý do
của `cdt-nghiem-thu`. **PASS** = cả tám tín hiệu tính được cho mọi tổ chức, 0 ô hỏng; UNKNOWN là «chưa biết», đếm riêng, KHÔNG làm
FAIL. Bằng chứng O1 trọn vòng: chạy `saas-acceptance --apply` rồi `ops-signals-check` — bước B1 cố ý dùng lại liên kết đã dùng nên
`platform_auth_failures` có dòng `RESET_LINK_USED` (luồng `RESET_LINK`) cho workspace thử, và dòng «O1 bằng chứng cdt-nghiem-thu» phải
báo «CÓ». Lượt mật khẩu SAI của B1 gọi thẳng `verifyLogin` (không qua `loginAction`) nên KHÔNG vào sổ — O1 cho luồng `LOGIN` chỉ
chứng minh được bằng một lượt đăng nhập sai thật qua form `/login`.
