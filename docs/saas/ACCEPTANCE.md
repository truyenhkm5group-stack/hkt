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
| P | (`--apply --prep`) Chuẩn bị MỘT lần cho D / E: sản phẩm mẫu `NT-AO-01` 150.000 ₫ (một mẫu mã) · tồn khả dụng ≥ 10 qua phiếu nhập · bot bật (đủ «Tìm sản phẩm» · «Lên đơn nháp» · «Chốt đơn», giờ làm việc luôn mở) · tên miền con `cdt-nghiem-thu` đã xuất bản. Mỗi việc ĐÃ LÀM / CÓ SẴN / BỎ QUA (lý do) / HỎNG (lý do) | `lib/saas/acceptance-prep.ts` — ĐÚNG lõi của nút UI (`createProductCore` · `writeStockReceiptCore` · `saveSalesChatbotConfig` · `setDomainSlug` + `publishOrganization`), đứng tên tài khoản CHỦ của workspace thử |
| C | Vỏ app 8 mục mở được qua host `app.<CHOTDON_DOMAIN>`: mỗi mục 200, mang dấu vỏ + thương hiệu Chốt Đơn, KHÔNG lộ khung ERP nội bộ, không vòng chuyển hướng, không bị đá về `/login`, không bị cổng quyền / module đưa về trang nhà (`?forbidden=1` · `/module-disabled`); `/` về trang nhà; một tuyến ERP bị chặn về trang nhà | GET thật tới `127.0.0.1:3000` (như smoke) với phiên ký bằng `signSession`; danh sách tuyến DẪN XUẤT từ `salesAgentNavFor` |
| D | (`--e2e`) Khách web hỏi giá → đặt 2 sản phẩm mẫu kèm SĐT + địa chỉ → đồng ý ⇒ AI trả lời từng lượt, đơn **CONFIRMED** trong OMS đúng SKU · số lượng · SĐT · xã; in chi phí AI của lượt | `openConversation("WEB")` + `chatTurn` — lõi chat công khai gọi sau bước định tuyến; đơn do BOT tạo / chốt |
| R | (`--apply --e2e-ops`) Sáu hạng mục Launch Gate Khách mà D không phủ, mỗi hạng mục ĐẠT / HỎNG / BỎ QUA (lý do): **C14** khách lưỡng lự sau khi có đơn nháp ⇒ đơn ở lại «Mới» + cờ CẦN NGƯỜI KIỂM `CUSTOMER_CANCELLED`, máy KHÔNG chốt · **C15** nút nhanh «Xác nhận đơn» ⇒ CONFIRMED, lượt kiểm mang khoá tài khoản người bấm · **C17** bấm xác nhận lần hai + phát lại cùng ý định khách ⇒ đúng MỘT đơn, không ghi thêm · **C9** tin nhân viên ở hộp thư lưu với `user_id` người gửi, gửi lại cùng khoá ⇒ cùng tin · **C11** tin nhân viên làm bot NHƯỜNG, rồi «Tiếp quản» ⇒ HUMAN_TAKEOVER, «Trả lại cho AI» ⇒ AI_ACTIVE · **C18** MỘT lượt chat qua đường CÔNG KHAI thật ⇒ đồng hồ khách AI của kỳ +1, trần tần suất không chặn | `lib/saas/acceptance-e2e.ts` — ĐÚNG lõi hộp thư / nút nhanh (`executeTool` cho C14, không gọi model · `confirmOrderReviewCore` · `sendStaffReplyCore` · `setConversationControlCore`), đứng tên tài khoản CHỦ; C18 = hai POST server action (`startPublicChatAction` · `sendPublicChatAction`, mã đọc từ `.next/server/server-reference-manifest.json` của bản dựng đang chạy) tới `127.0.0.1:3000/chat` với Host tên miền con |
| E | `https://<slug>.<PLATFORM_BASE_DOMAIN>/chat` trả 200 + tên shop, cả qua ứng dụng lẫn qua mạng ngoài (DNS + Caddy + chứng chỉ); in tên miền gốc đang dùng | GET thật |

## 2. KHÔNG chứng minh được gì

- **Không gửi email thật** — nền tảng chưa có kênh thư; liên kết kích hoạt chỉ sống trong bộ nhớ tiến trình.
- **Không đi Meta / Messenger / Zalo** — Meta chưa duyệt quyền Page; E2E đi kênh CHAT WEB.
- **Không bấm giao diện**: B, P, D và R gọi đúng lõi mà nút / trang gọi, nhưng không qua trình duyệt (không đo JavaScript phía khách).
  C và E đo HTML thật do máy chủ dựng; riêng C18 (bước R) đi server action qua HTTP thật, nhưng không đo phần Caddy / IP thật của
  khách (POST đi thẳng `127.0.0.1:3000`, không có `X-Forwarded-For` ⇒ trần theo IP không áp, trần theo khách + tổ chức vẫn áp).
- **D không đo đồng hồ «khách AI» và trần tần suất của chat công khai** (`lib/sales-chatbot/public.ts` ghi chúng sau bước định tuyến
  theo host) — D gọi lõi ngay sau bước đó, nên KHÔNG tiêu hạn mức dùng thử và KHÔNG vào bảng kê. **Bước R (C18) đo phần này**: một lượt
  qua đường công khai thật tiêu MỘT khách AI của hạn mức dùng thử workspace thử; dùng thử hết ⇒ C18 BỎ QUA, ops không gia hạn.
- **D không xác nhận đơn bằng nút nhanh**: nếu AI không chốt sau lời đồng ý, D báo FAIL và để người bấm «Xác nhận đơn» ở hộp thư —
  D không bấm hộ. Bước R (C15) bấm «Xác nhận đơn» trên đơn RIÊNG của nó (đơn C14, hội thoại riêng của lượt), không bao giờ trên đơn của D.
- **C14 không đi nhánh «địa chỉ chưa ghép xã»**: với nhánh đó luật chủ shop 08/10/2026 là MÁY VẪN CHỐT kèm cờ, nên «máy không chốt» không
  áp; C14 đi nhánh khách lưỡng lự (`mark_declined` ⇒ cờ `CUSTOMER_CANCELLED`, đơn ở lại «Mới», công tắc «đơn đủ thông tin» không nâng).
  Công tắc ấy đang BẬT ở workspace thử ⇒ C14 BỎ QUA kèm lý do (ops không đổi công tắc hộ).
- **Không gia hạn dùng thử**: dùng thử V1 có 7 ngày. Hết hạn ⇒ A báo FAIL kèm việc người vận hành làm (/platform/org/<mã> → «Thu phí
  thuê bao» → «Đã trả tới ngày»); ops không tự gia hạn ngầm.

## 3. Chuẩn bị MỘT lần (cho D và E) — tự động bằng `--apply --prep`

**Quyết định chủ shop 09/10/2026** («Giao diện thế nào bạn cứ làm theo phương án tốt nhất»): phần chuẩn bị nay do ops làm, bằng cờ
`--prep` (chỉ đi cùng `--apply`, KHÔNG BAO GIỜ chạy mặc định). Chỉ đạo 08/10 «ops không ghi hộ vào workspace» được nới **CHỈ cho
workspace nghiệm thu này** — không bao giờ cho một workspace khách thật.

Bước **P** (`lib/saas/acceptance-prep.ts`) chạy SAU A + B1 (A xác nhận workspace do ops tạo, B1 kích hoạt tài khoản chủ) và TRƯỚC
C / D / E, nên `--apply --prep --e2e` = A → B1 → P → C → D → E → B2 (xoay mật khẩu vẫn CUỐI). Nó tự kiểm lại ba lá chắn trước mọi lượt
ghi — tiến trình ops (không phải máy chủ ứng dụng) · mã thuộc sổ khai · workspace đúng do ops tạo (`acceptanceWorkspaceOwned`) — và
đứng tên tài khoản CHỦ của workspace thử (email trong sổ khai, tra qua chỉ mục danh tính; quyền dựng bằng đúng đường nhanh của phiên
đăng nhập), không phải người vận hành nền tảng, không phải khách thật. Mỗi việc đi qua ĐÚNG lõi mà nút trên UI gọi:

| Việc | Lõi | Idempotent |
|---|---|---|
| Sản phẩm mẫu `Mẫu · Áo thun nghiệm thu` · SKU `NT-AO-01` · 150.000 ₫ · một mẫu mã | `createProductCore` (Sản phẩm → Tạo sản phẩm) | SKU đã có ⇒ CÓ SẴN, không tạo bản hai; có mà giá lệch / ẩn / trùng ⇒ HỎNG kèm lý do, KHÔNG sửa dữ liệu đã có |
| Tồn khả dụng ≥ 10 | `writeStockReceiptCore` (lõi của «Nhập hàng» và «tồn đầu» khi nhập từ tệp) — phiếu NHẬP HÀNG, định giá theo chế độ giá nhập của tổ chức; khai tay ⇒ đơn giá bỏ trống = CHƯA BIẾT, không bịa giá vốn | khả dụng (đúng biểu thức sổ kho, đã trừ đơn chốt chưa xuất) ≥ 10 ⇒ CÓ SẴN; thiếu ⇒ MỘT phiếu đúng phần chênh |
| Bot bật · đủ «Tìm sản phẩm» · «Lên đơn nháp» · «Chốt đơn» · giờ làm việc luôn mở | `saveSalesChatbotConfig` với đúng hình đầu vào của form KHÁCH (không ô động cơ AI — nguồn AI / model là của người vận hành) | đã bật đủ ⇒ CÓ SẴN. AI theo gói chưa sẵn sàng ⇒ BỎ QUA kèm đúng phần thiếu (phần mã hoá); P KHÔNG đổi cấu hình AI nền tảng — người vận hành cấu hình «AI của workspace» ở /platform/org/cdt-nghiem-thu |
| Tên miền con `cdt-nghiem-thu` → Xuất bản | `setDomainSlug` + `publishOrganization` (/setup) | đã xuất bản đúng tên ⇒ CÓ SẴN; đã xuất bản tên khác ⇒ HỎNG (tên miền khoá sau xuất bản) |

P không gọi AI. Chi tiết từng việc (id sản phẩm / mẫu mã / phiếu, số lượng, câu lỗi của lõi) chỉ ở phần MÃ HOÁ; dòng `[ops:tom-tat]` chỉ
thêm `chuẩn bị: ĐÃ LÀM … · CÓ SẴN … · BỎ QUA … · HỎNG …` với TÊN việc. Bước P: có việc HỎNG ⇒ FAIL; mọi việc ĐÃ LÀM / CÓ SẴN ⇒ PASS;
còn lại ⇒ SKIP (chuẩn bị chưa trọn không phải đạt). Workspace trùng mã không do ops tạo ⇒ P bỏ qua, không một dòng nào được ghi.

**Dự phòng: làm tay trên UI** (khi P báo BỎ QUA / HỎNG, hoặc muốn tự kiểm giao diện). Thiếu phần nào thì D / E báo **SKIP** kèm đúng
phần thiếu.

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
| `--apply --drills` | GHI — thêm F diễn tập tín hiệu O1–O8 (KHÔNG chạy mặc định, không tốn AI) | xem §10 |
| `--apply --prep` | GHI — thêm P chuẩn bị MỘT lần cho D / E (KHÔNG chạy mặc định, không tốn AI); đi cùng `--e2e` được | xem §3, §5 |
| `--apply --e2e-ops` | GHI + TỐN MỘT LƯỢT AI — thêm R (sau D, trước E) vận hành hộp thư C9 · C11 · C14 · C15 · C17 · C18 (KHÔNG chạy mặc định); đi cùng `--prep --e2e` được: A → B1 → P → C → D → R → E → B2 | xem §1, §5 |
| `--org=<mã>` | chỉ khi sổ khai có nhiều mục | — |

Kết quả MÃ HOÁ như mọi ops trả dữ liệu; log công khai chỉ có ĐÚNG MỘT dòng
`[ops:tom-tat] saas-acceptance: <PASS|FAIL> <n đạt>/<n> · hỏng … · bỏ qua … · chế độ … · workspace cdt-nghiem-thu · miền chat <miền gốc>`.
Có FAIL ⇒ mã thoát 1; mã ngoài sổ / arg sai ⇒ 64; chạy thử mà CSDL không chỉ đọc ⇒ 70.

**Hiệu lực**: ops lấy SCRIPT từ `main` nhưng `lib/` từ IMAGE đang chạy — chỉ chạy được sau lượt deploy mang `lib/saas/acceptance.ts`.

Thứ tự lần đầu trên production: deploy → `--apply` (tạo workspace, kích hoạt, đăng nhập) → `--apply --prep --e2e` (chuẩn bị §3 rồi
chat → AI → đơn trong CÙNG lượt) → từ đó `(rỗng)` sau mỗi deploy, `--apply --prep --e2e` khi cần bằng chứng trọn vòng (P CÓ SẴN thì
không ghi gì; mỗi đơn bot chốt giữ 2 cái nên lượt sau bù đúng một phiếu nhỏ), `--apply --prep --e2e --e2e-ops` khi cần bằng chứng
Launch Gate Khách (đơn C15 cũng giữ 2 cái ⇒ lượt `--prep` sau bù thêm).

Dòng công khai của lượt có R thêm `vận hành: ĐẠT C14,… · HỎNG … · BỎ QUA …` — CHỈ mã hạng mục; id hội thoại / đơn / tin, SĐT, câu lỗi
chỉ ở phần MÃ HOÁ. Bước R: có hạng mục HỎNG ⇒ FAIL; mọi hạng mục ĐẠT ⇒ PASS; còn lại ⇒ SKIP (phủ thiếu không phải đạt).

## 5. Dữ liệu ops ghi (chỉ trên workspace thử)

- Lần đầu: một job `platform_provisioning_jobs` (khoá cố định `saas-acceptance:cdt-nghiem-thu`) ⇒ tài khoản + workspace + CSDL +
  thuê bao dùng thử + quản trị. Job đã xong thì lượt sau KHÔNG gửi lại (gửi lại cùng khoá mà danh mục / bảng giá đã đổi sẽ bị
  từ chối là «thông tin KHÁC»); job hỏng / treo thì chạy lại đúng job ấy.
- Mỗi `--apply`: hai liên kết đặt lại (`password_reset_tokens`, chỉ băm) + hai lượt đổi mật khẩu (thu hồi phiên), một lượt đăng nhập
  (`lastLoginAt`, nhật ký `LOGIN`, mốc dùng của chỉ mục danh tính), nhật ký nền tảng `PASSWORD_RESET_LINK` đứng tên MÁY nguồn SCRIPT.
- Mỗi `--e2e`: một hội thoại WEB (khoá khách truy cập theo mã lượt chạy), các tin + dòng sổ AI, một khách (SĐT thử `0900000001`) và
  một đơn do bot tạo / chốt — giữ lại làm vết, không xoá.

- Mỗi `--prep` (chỉ phần còn thiếu): một sản phẩm + một mẫu mã mẫu (lần đầu), một phiếu NHẬP HÀNG đúng phần chênh tới 10 khả dụng,
  một lượt lưu cấu hình bot (bật · thêm công cụ thiếu · tắt giờ làm việc), một lượt chọn tên miền con + xuất bản — kèm nhật ký tổ
  chức đứng tên tài khoản CHỦ của workspace thử (và nhật ký nền tảng `ORG_DOMAIN_SET` / `ORG_PUBLISH`). Giữ lại làm vết, không xoá.

- Mỗi `--e2e-ops`: một hội thoại WEB riêng (khoá khách truy cập theo mã lượt chạy) mang một đơn (C14 lên nháp → khách lưỡng lự → C15
  chủ workspace thử xác nhận), MỘT tin nhân viên đứng tên chủ, hai lượt đổi chế độ (tiếp quản → trả lại AI) kèm nhật ký; và một
  hội thoại WEB CÔNG KHAI (C18) với một tin khách + câu AI + một dòng `chotdon.ai_customers` + dòng sổ AI. Giữ lại làm vết, không xoá.

Ops KHÔNG ghi: xác nhận đơn tay ngoài đơn của chính bước R, gia hạn, thu phí, cấu hình AI nền tảng / «AI của workspace», module, gói; và không ghi gì vào workspace
nào ngoài workspace nghiệm thu do chính nó tạo.

## 6. Chi phí AI mỗi lượt

Chỉ `--e2e` và `--e2e-ops` gọi AI (`--prep` không gọi; `--e2e` 3–4 lượt khách, `--e2e-ops` ĐÚNG MỘT lượt — C18 qua đường công khai;
C9 · C11 · C14 · C15 · C17 không gọi model; mỗi lượt một vài lời gọi model của AI dùng chung). Số THẬT đọc từ sổ AI theo hội thoại của lượt và
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
FAIL. Bằng chứng O1 trọn vòng cho CẢ HAI luồng: chạy `saas-acceptance --apply` rồi `ops-signals-check`. Bước B1 để lại hai dòng
`platform_auth_failures` cho workspace thử: (1) cố ý dùng lại liên kết đã dùng ⇒ `RESET_LINK_USED` (luồng `RESET_LINK`); (2) lượt
mật khẩu SAI lấy lý do qua `onFailure` của `verifyLogin` rồi ghi qua `recordAuthFailure` đúng hình lời gọi của `loginAction` ⇒
`LOGIN/BAD_PASSWORD` (định danh đã che, không IP — máy). Lượt mật khẩu sai chạy SAU lượt dùng lại liên kết, nên dòng «O1 bằng chứng
cdt-nghiem-thu» phải báo «CÓ» với 24h ≥ 2 · lý do cuối `BAD_PASSWORD` · luồng `LOGIN`. Lượt đăng nhập ĐÚNG không ghi gì; lý do chỉ
nằm ở sổ của người vận hành và phần mã hoá, không ra dòng `[ops:tom-tat]` của nghiệm thu.

## 10. Diễn tập tín hiệu O1–O8 — `saas-acceptance --apply --drills`

`ops-signals-check` (§9) chứng minh tám tín hiệu TÍNH ĐƯỢC; bước F chứng minh chúng BẮT ĐƯỢC một sự cố có kiểm soát trên workspace
thử. Chỉ chạy khi gõ `--drills` (đi cùng `--apply`), chỉ trên workspace trong sổ khai và chỉ sau khi A xác nhận workspace do ops tạo
(`acceptanceWorkspaceOwned`). Mỗi diễn tập đi qua ĐÚNG đường mã production ghi tín hiệu với đầu vào cố ý sai — không chèn dòng lỗi
giả, không gọi AI, không gọi dịch vụ ngoài, không đổi cấu hình bot / gói / công tắc. Tín hiệu nào chỉ gây được bằng những cách đó in
«CHƯA ĐO ĐƯỢC» kèm lý do (`ACCEPTANCE_UNMEASURABLE_DRILLS`), không làm giả.

| Tín hiệu | Diễn tập | Đường mã |
|---|---|---|
| O1 LOGIN | ĐÃ DIỄN TẬP (ở B1) | lượt mật khẩu sai: `verifyLogin` + `onFailure` ⇒ `recordAuthFailure` ⇒ `LOGIN/BAD_PASSWORD` |
| O2 FB_CONNECTION | CHƯA ĐO ĐƯỢC | workspace không nối page Facebook (N/A); gây lỗi token đòi gọi Graph thật |
| O3 WEBHOOK | CHƯA ĐO ĐƯỢC | đo từ đăng ký webhook page + hàng chờ tin fanpage; chat WEB không đi đường webhook |
| O4 AI | CHƯA ĐO ĐƯỢC | dòng ERROR chỉ sinh khi gọi AI thật hỏng — cần đổi khoá / công tắc AI thật hoặc tốn tiền AI |
| O5 SEND | CHƯA ĐO ĐƯỢC | lỗi gửi chỉ có ở kênh nhắn tin (dịch vụ ngoài thật); chat WEB không gửi đi đâu |
| O6 ORDER_VALIDATION | ĐÃ DIỄN TẬP | `executeTool("create_customer")` (bộ chạy công cụ của bot) THIẾU SĐT, kênh WEB ⇒ `MISSING_CONTACT` ⇒ `order.validation_failed` trong `audit_logs` của workspace + gương `platform_org_health` CẢNH BÁO |
| O7 ORDER_WRITE | CHƯA ĐO ĐƯỢC | cần lõi đơn NÉM lỗi CSDL; không có đường không phá huỷ |
| O8 QUOTA | CHƯA ĐO ĐƯỢC | cổng gói chỉ chặn khi dùng thử hết / hết số dư — cần đổi gói / hạn mức thật hoặc tiêu hết lượt AI thật |

O6 bỏ qua bước model chọn công cụ (phần duy nhất tốn tiền) và gọi thẳng bộ chạy công cụ — giống B1 gọi thẳng lõi đăng nhập. Công cụ từ
chối TRƯỚC mọi lượt ghi khách: không khách, không đơn, không hội thoại mới; id tương quan là `nghiem-thu-drill:<mã lượt chạy>`. Dọn
dẹp: không có gì để gỡ — mức của tín hiệu tính trên số đếm 24 giờ, nên tự về «Ổn» sau 24 giờ (job `sales-health` đếm lại từ
`audit_logs`). Dòng công khai thêm `diễn tập: ĐÃ DIỄN TẬP O1,O6 · CHƯA ĐO ĐƯỢC O2,…` — chỉ số hiệu tín hiệu; mã lý do và id dòng
chỉ ở phần MÃ HOÁ. Kiểm sau lượt chạy: `ops-signals-check` phải in `cdt-nghiem-thu O6 ORDER_VALIDATION: WARNING · … · lý do cuối
MISSING_CONTACT`.

## 11. Hộp thư khách mở / chuyển hội thoại mất bao lâu — ops `inbox-perf-probe`

Actions → «Vận hành ERP trên VPS» → `inbox-perf-probe` (arg trống = mọi workspace ACTIVE, không phải nhà, đang bật `ai_sales`, tối
đa 10, `cdt-nghiem-thu` trước; `--org=<mã>` đo một workspace; `--samples=<n>` 1–20, mặc định 5; arg khác ⇒ mã 64). CHỈ ĐỌC: script đặt
`ERP_READ_ONLY=1`, hỏi lại Postgres ở CSDL nhà và CSDL từng tổ chức, và mở CSDL tổ chức bằng handle chẩn đoán (không migrate). Nó bấm
giờ ĐÚNG chuỗi hàm máy chủ mà `app/(dashboard)/ai/sales-chatbot/inbox/page.tsx` chạy — **tải** = mở hộp thư (`listLabels` →
`inboxPages` → `listInbox` cùng sáu lời gọi song song), **chuyển** = bấm một hội thoại (`?c=<id>`: thêm `loadInboxThread` trước
Promise.all) trên N hội thoại đầu danh sách — mỗi phép đo «nguội» (xoá `memo`) và «ấm», kèm tổng ms + số câu SQL. Danh tính là một
tài khoản CHỈ XEM của chính workspace (hoặc tài khoản đã chọn bị THU HẸP — bỏ quyền gửi tin), nên lượt mở hội thoại không xoá dấu «chưa
đọc» của shop. Log công khai che workspace thành `org#i` (bản đồ ở phần MÃ HOÁ), in p50 · p95 · max (ms) + cỡ mẫu; dưới 3 quan sát
in «mẫu nhỏ — chưa kết luận». **Không có ngưỡng đạt / không đạt** (AGENTS 38) — dòng đầu ghi «chưa có đích». Đọc con số cho đúng: chỉ
là phần máy chủ (không tra phiên, không dựng HTML, không mạng), và bể kết nối của handle chỉ đọc là 1 (app: 2) nên số nghiêng về phía
CHẬM. Mã thoát 0 = mọi lượt đo được; 1 = có workspace / lượt đo hỏng (câu lỗi ở phần MÃ HOÁ).
