# Danh tính hợp nhất — thiết kế (Phase 3)

*Sứ mệnh `saas-c-shared-identity` · rủi ro CRITICAL · 07/10/2026 · đo trên `origin/main` `0b5ec24f`. Tài liệu THIẾT KẾ:
không có dòng mã chạy nào đổi trong lượt này. Chỗ nào ghi **SUY LUẬN** là chưa kiểm bằng bài kiểm hay số đo production.*

Đọc kèm: `SECURITY.md` §3 (bất biến phải giữ), `PLAN.md` Phase 3, `docs/platform/target-architecture.md` P5, AGENTS.md
luật 28–36.

## 1. Hiện trạng — đo từ mã

**Danh tính là SILO theo workspace.** Tư cách thành viên = một dòng `users` trong CSDL của workspace
(`target-architecture.md:99`, P5). Một người thuộc hai workspace = hai dòng `users` ở hai CSDL, hai mật khẩu, hai `id`
ngẫu nhiên (`db/schema.ts:6` — `crypto.randomUUID()`). Không có chuyển workspace trong phiên.

| Mảnh | Ở đâu | Làm gì |
|---|---|---|
| Ký phiên | `lib/auth/session.ts:85-95` `signSession` | JWT HS256 mang `sub` = `users.id` CỦA WORKSPACE, `org` (BẮT BUỘC, ném nếu thiếu), `lgn` (mốc đăng nhập gốc), email/tên/vai trò chỉ để hiển thị |
| Chọn CSDL | `lib/platform/context.ts:86-96` `currentOrganization` → `db/index.ts:203-206` `getDb` | `withOrganization` tường minh thắng; không có thì claim `org` đã xác minh chữ ký (`context.ts:152-167`); token cũ không claim ⇒ nhà; claim trỏ tới workspace không ACTIVE ⇒ NÉM `OrgContextError`, không rơi về nhà |
| Dựng người dùng | `session.ts:291-316` `resolveSessionUser` | tra `users` theo `sub` TRONG CSDL của `org` (không `memo`); không thấy ⇒ `NOT_FOUND`; khoá ⇒ `DISABLED`; `lgn` < `session_invalid_before` ⇒ `REVOKED` (`:314`) |
| Tính quyền | `session.ts:324-369` → `lib/auth/access.ts:184` `effectiveAccess` | vai trò + quyền riêng + vai trò tuỳ chỉnh + phạm vi + phòng ban — TẤT CẢ đọc trong CSDL workspace; quyền không nằm trong token |
| Cổng nhà | `lib/auth/permissions.ts:532` `homeOrgPermissionDenied` | `platform:operate` chỉ có hiệu lực khi workspace của phiên là nhà |
| Host ⇄ phiên | `session.ts:266` | trên tên miền con `<slug>`, phiên phải đúng workspace đó, lệch ⇒ `HOST_MISMATCH`; cookie host-only |
| Gia hạn | `middleware.ts:176-197` + `lib/constants/session.ts:193` `renewalClaims` | chép NGUYÊN mọi claim (kể cả `org`), giữ `lgn` |
| Thu hồi | `lib/auth/session-revoke.ts:37-92` | một đường ghi, `GREATEST` chỉ tiến, theo từng dòng `users` của MỘT workspace |
| Chỉ mục danh tính | `db/schema.ts:5129-5145` (`platform_identities`, 0193) · `lib/auth/identities.ts:19,34` | `(kind, value, org_code) ⇒ user_id`, kind ∈ EMAIL · PHONE · GOOGLE · FACEBOOK. CHỈ là chỉ mục; bản ở CSDL workspace bị xoá mỗi lần mở (`db/migrate.ts:85-86`) |
| Đăng nhập trang chung | `lib/actions/auth.ts:48-63` · `lib/auth/login.ts:132` `loginCandidates`, `:109` `credentialsMatch`, `:85` `verifyLogin` | không mã workspace ⇒ ứng viên = chỉ mục + nhà ⇒ thử mật khẩu ở TỪNG workspace (trong `withOrganization`) ⇒ khớp 1 vào thẳng, khớp nhiều hỏi chọn, 0 ⇒ câu sai mật khẩu chung |
| Ghi chỉ mục | `login.ts:76-77, 156` · `lib/onboarding/quick.ts:103-105` | ghi khi đăng nhập thành công / đăng ký nhanh; ghi hỏng không làm hỏng đăng nhập |
| Google / Facebook | `lib/auth/social.ts:18-20` · `app/login/oauth/[provider]/callback/route.ts:50-60` · `lib/actions/oauth.ts:18-28` | tra GOOGLE/FACEBOOK theo `sub` của nhà cung cấp; không có ⇒ tra **EMAIL** đã xác minh của hồ sơ; một workspace vào thẳng, nhiều ⇒ cookie ký `erp_pick` |
| Nhận lời mời | `lib/users/invites.ts:236, 313` | tạo dòng `users` mới trong workspace đích rồi `verifyLogin` |

**Bất biến SECURITY §3 đứng được là nhờ `sub` cục bộ:** token `org = B`, `sub` = id người của A ⇒ tra trong CSDL B ⇒ id
ngẫu nhiên đó không tồn tại ⇒ `NOT_FOUND`. Có bài kiểm: `tests/tenant-attack.test.ts` (`:1166-1170` "không phiên nào mang org = B được ký cho tài khoản
của A"; đòn 9 phiên giả `:1419`), `tests/platform-isolation.test.ts`, `tests/session-revocation.test.ts`,
`tests/session-renewal.test.ts`, `tests/quick-start.test.ts::testOAuth`, `tests/user-invites.test.ts`.

**Ba điều quan sát được khi đọc (chưa phải lỗi đã chứng minh):**
1. `forgetIdentitiesOf` (`identities.ts:55`) **không có nơi gọi** — dòng chỉ mục không bao giờ bị gỡ. Hiện vô hại vì lúc
   đọc vẫn tra CSDL workspace, nhưng chỉ mục sẽ cũ dần.
2. Đăng nhập Google/Facebook rơi về khớp **EMAIL** (`social.ts:20`) rồi mở phiên **không mật khẩu** theo `user_id` của
   dòng chỉ mục. Email của tài khoản ERP do quản trị GÕ, không được xác minh. **SUY LUẬN:** quản trị gõ nhầm email
   của người khác ⇒ chủ Gmail đó đăng nhập được vào tài khoản ấy. Không thuộc phạm vi sứ mệnh này, nhưng mô hình mới
   KHÔNG được thừa kế phép khớp này (xem B6).
3. Đăng nhập trang chung khớp mật khẩu ở nhiều workspace (`actions/auth.ts:52`) là chứng cứ mạnh nhất hiện có rằng hai
   tài khoản thuộc cùng một người — và hệ thống đang không lưu lại điều đó.

## 2. Mục tiêu

- **User toàn nền tảng**: một người, một danh tính đăng nhập (email đã xác minh / SĐT đã xác minh OTP / Google / Facebook).
- **Membership** = User × Workspace × (vai trò, quyền, phạm vi do WORKSPACE quyết).
- **Chuyển workspace trong phiên** không phải đăng xuất / gõ lại mật khẩu.
- KHÔNG đổi: dữ liệu nghiệp vụ vẫn SILO; quy kết (luật 34) vẫn bằng `users.id` của workspace; quyền vẫn tính ở CSDL
  workspace; một token vẫn đúng MỘT workspace.

## 3. Phương án

| | **A. Liên kết danh tính, giữ silo tài khoản** | **B. User toàn nền tảng ở control plane, `sub` vẫn cục bộ** (đề xuất) | **C. Một `users.id` toàn cục ở mọi CSDL** |
|---|---|---|---|
| Ý | Bảng liên kết `(người) ↔ (workspace, user_id)` ở control plane; mỗi workspace vẫn mật khẩu riêng; chuyển workspace = mở phiên ở tài khoản đã liên kết | `platform_users` (danh tính + mật khẩu + mốc thu hồi toàn nền tảng) + `platform_memberships` (chỉ mục). Dòng `users` của workspace ở lại làm "hồ sơ thành viên", thêm cột `platform_user_id` (NULL được). Token: `sub` = id CỤC BỘ, thêm claim `pu` | Dòng `users` mọi CSDL dùng chung một id; token `sub` = id toàn cục |
| Bất biến §3 | giữ nguyên chữ | giữ nguyên chữ (`sub` cục bộ) + thêm phép buộc `users.platform_user_id = pu` | **đổi nghĩa**: `sub` của A CÓ THỂ tồn tại ở B — an toàn chuyển hết sang "ai được ký `org`" |
| Mật khẩu | N mật khẩu | 1 mật khẩu nền tảng (mật khẩu cục bộ tuỳ chủ shop, §7 Q1) | 1 |
| Công sức | thấp–vừa | vừa (2 bảng control plane, 1 cột, 1 claim, 1 đường chuyển) | rất lớn: đổi id + mọi khoá ngoại quy kết (luật 34), dữ liệu lịch sử |
| Đảo ngược | dễ (xoá liên kết) | dễ ở mọi PR trước khi tắt mật khẩu cục bộ: cờ tắt ⇒ token `pu` bị từ chối, đăng nhập cục bộ vẫn chạy | **không** — viết lại id là backfill (trái luật 35) |
| Rủi ro chính | UX nửa vời; vẫn N mật khẩu (mật khẩu yếu nhất mở được cả nhóm nếu liên kết cho chuyển không mật khẩu) | một mật khẩu nền tảng mở mọi workspace của người đó (giảm bằng thu hồi toàn nền tảng, xác minh lại khi chuyển — §7 Q2) | mất lớp phòng thủ "id không tồn tại" |

**Đề xuất B, đi theo lộ trình của A**: các PR đầu chỉ dựng phần liên kết (không đổi đăng nhập), mật khẩu nền tảng và
chuyển workspace bật sau cờ. Lý do: B giữ nguyên CHỮ của bất biến §3 (vì `sub` vẫn là id cục bộ ngẫu nhiên), không chạm
một dòng quy kết nào, và mọi bước trước bước cuối đều tắt được bằng cờ. C bị loại vì phá luật 34/35 và không đảo được.

### Sơ đồ B

```
CSDL NHÀ (control plane)                         CSDL workspace B (nguồn sự thật thành viên)
┌──────────────────────────┐                     ┌────────────────────────────────────────┐
│ platform_users           │                     │ users                                  │
│  id (pu) · email đã XM   │   chỉ mục, có thể   │  id (cục bộ, ngẫu nhiên) ← JWT.sub     │
│  password_hash · status  │   cũ ⇒ chỉ HẸP lại  │  role · permissions · data_scope …     │
│  session_invalid_before  │ ─────────────────▶  │  active · session_invalid_before       │
│ platform_memberships     │                     │  platform_user_id  (NULL = chưa liên   │
│  pu · org_code · user_id │                     │                     kết, KHÔNG backfill)│
│  linked_via · unlinked_at│                     └────────────────────────────────────────┘
└──────────────────────────┘
JWT: { sub: <id cục bộ ở B>, org: "B", pu: <pu>, lgn: <mốc đăng nhập gốc> }   — đúng MỘT org
```

Dựng người dùng (bổ sung vào `resolveSessionUser`, sau các kiểm hiện có): token có `pu` ⇒ (1) dòng `users` của B có
`platform_user_id = pu`, (2) `platform_users[pu]` ACTIVE, (3) `lgn` ≥ `platform_users.session_invalid_before`. Bất kỳ vế
nào không trả lời được (control plane không đọc được, bảng chưa có, cờ tắt) ⇒ TỪ CHỐI. Token không có `pu` ⇒ y như hôm nay.

Chuyển workspace (server action, chỉ máy chủ): phiên hiện tại hợp lệ ⇒ đọc `pu` TỪ TOKEN (không bao giờ từ form) ⇒ chỉ mục
cho `(pu, B) ⇒ user_id` ⇒ `withOrganization(B)`: tra `users[user_id]`, kiểm buộc `platform_user_id = pu`, `active`, thu
hồi ⇒ ký token MỚI `{sub: user_id của B, org: B, pu, lgn: GIỮ lgn cũ}` ⇒ ghi cookie ⇒ nhật ký `SWITCH_IN` ở B (và
`SWITCH_OUT` ở A) ⇒ chuyển về `/`. Trình duyệt chỉ gửi mã workspace; mã đó chỉ chọn trong tập do máy chủ tra.

## 4. Bất biến bảo mật — mỗi cái một bài kiểm

Bài kiểm mới đặt ở `tests/identity-unified.test.ts` (PGlite, hai workspace thử + nhà), đường đi qua ĐÚNG
`resolveCurrentUser` / `getDb` như request thật (móc `setSessionTokenSourceForTests`), không nhánh tắt.

| # | Bất biến | Bài kiểm sẽ viết |
|---|---|---|
| B1 | Không phiên nào đọc CSDL workspace mà nó không là thành viên | (a) token hợp lệ `{org:B, sub: id ở A, pu:P}` ⇒ `NOT_FOUND`; (b) `{org:B, sub: id của người Q ở B, pu:P}` ⇒ từ chối (buộc lệch); (c) chỉ mục còn dòng `(P,B)` nhưng `users.platform_user_id` ở B là NULL ⇒ chuyển thất bại, không cookie nào được ghi; (d) `switchWorkspace("B")` khi P không có thành viên ở B ⇒ lỗi, ảnh chụp CSDL B trước = sau; (e) đòn 9 của `tenant-attack` chạy lại với claim `pu` |
| B2 | Vai trò / quyền vẫn tính ở CSDL workspace | P là ADMIN ở A, VIEWER ở B ⇒ sau khi chuyển `can(user,"users:manage") = false`; P có `platform:operate` ở nhà ⇒ chuyển sang workspace khách thì mất; token không mang quyền (quét: `signSession` chỉ nhận `SessionSubject` + `pu`) |
| B3 | Chuyển = phiên MỚI, một `org`, không token đa-org | `signSession` ném nếu `org` không phải chuỗi đơn; quét mã: không chỗ nào đọc mảng workspace từ token; token sau khi chuyển có `lgn` BẰNG token cũ (trần 30 ngày không bị dời); `renewalClaims` giữ `pu` (thêm ca vào `session-renewal.test.ts`) |
| B4 | Thu hồi có hiệu lực ngay, đúng tầm | thu hồi nền tảng ⇒ phiên ở A VÀ B (kể cả phiên cục bộ cũ không `pu` của tài khoản đã liên kết — thu hồi nền tảng toả xuống từng workspace qua `applySessionRevocation`, một đường ghi) bị từ chối; thu hồi / khoá ở B ⇒ chỉ phiên B chết, A còn; `platform_users.status = DISABLED` ⇒ mọi phiên `pu` chết; mốc nền tảng chỉ tiến (`GREATEST`, như 0106) |
| B5 | Mọi nhánh lỗi rơi về phía HẸP hơn (luật 31) | control plane ném khi dựng phiên `pu` ⇒ từ chối (không rơi về "chỉ kiểm cục bộ"); `pu` lạ ⇒ từ chối; cờ `identity.unified` tắt ⇒ token `pu` bị từ chối, token cục bộ vẫn chạy; workspace đích không ACTIVE ⇒ `OrgContextError`, không rơi về nhà; đang ở tên miền con ⇒ không chuyển được (v1) |
| B6 | Không tác nhân cấp workspace nào chạm được danh tính nền tảng | ADMIN của B đặt lại mật khẩu / đổi email người đã liên kết ⇒ chỉ đổi phần cục bộ, `platform_users` nguyên vẹn; quét mã: chỉ `lib/identity/*` ghi `platform_users` / `platform_memberships` / `users.platform_user_id`; liên kết Google/Facebook chỉ theo `sub` nhà cung cấp hoặc email ĐÃ XÁC MINH ở `platform_users`, không theo email gõ tay |
| B7 | Thành viên ở B không cho gì ở A | liên kết P↔B chỉ thêm đường VÀO B; quét: không hàm nào suy quyền ở A từ thành viên ở B; quản trị B gắn `platform_user_id` của người lạ ⇒ không có đường ghi nào cho phép (chỉ luồng chứng minh ở §5) |
| B8 | Quy kết không đổi, không backfill | quét: `lib/queries/**` không nhắc `platform_user_id`; sau migrate trên CSDL đã gieo, `users.platform_user_id` toàn NULL và `platform_memberships` rỗng |

## 5. Migration — KHÔNG backfill đoán người (luật 35)

1. **Lược đồ**: `platform_users`, `platform_memberships` ở CSDL nhà (khai ở `CONTROL_PLANE_TABLES`,
   `lib/blueprints/restore-drill.ts:67`, VÀ thêm lệnh xoá bản sao ở `db/migrate.ts` như dòng 85-86); cột
   `users.platform_user_id text NULL` + chỉ mục duy nhất khi khác NULL ở CSDL workspace. Migration viết tay, idempotent,
   KHÔNG `DEFAULT`, KHÔNG `UPDATE`.
2. **Báo cáo chạy thử** (`scripts/identity-link-report.ts`, chỉ đọc, ép `ERP_READ_ONLY=1`): đếm theo nhóm — danh tính
   chỉ ở 1 workspace · cùng email ở ≥ 2 workspace (ỨNG VIÊN, chưa chứng minh) · cùng SĐT khác email (MƠ HỒ) · dòng chỉ
   mục trỏ tới tài khoản không còn (CŨ). In SỐ ĐẾM qua `[ops:tom-tat]`, không in email/SĐT (kho và log ops công khai).
   Con số này cũng trả lời câu "có bao nhiêu người thật sự cần tính năng" trước khi đầu tư PR 5–7.
3. **Ghép chỉ khi XÁC ĐỊNH, và do CHÍNH người đó bấm.** Cùng email ở hai CSDL KHÔNG đủ (email do quản trị gõ). Chứng cứ
   chấp nhận, ghi vào `linked_via`:
   - `PASSWORD_BOTH` — đăng nhập trang chung khớp mật khẩu ở nhiều workspace (đường có sẵn) ⇒ hiện nút "Dùng một tài
     khoản cho các cửa hàng này", người bấm mới ghép;
   - `PASSWORD_PROVEN` — đang ở phiên A, gõ đúng mật khẩu tài khoản ở B;
   - `OAUTH_SUB` — cùng `sub` Google/Facebook đã có trong chỉ mục ở cả hai (đã từng đăng nhập bằng nút đó ở mỗi bên);
   - `INVITE` — người đang có `pu` nhận lời mời của B (sở hữu mã mời + phiên `pu`);
   - `SIGNUP` — từ ngày bật cờ, đăng ký mới (`/start`, SĐT đã OTP) tạo `pu` ngay — chỉ TIẾN, không áp cho tài khoản cũ.
4. Tài khoản cũ không ai bấm thì **mãi là tài khoản cục bộ**, đăng nhập như hôm nay. Không có lượt ghép hàng loạt.
5. Gỡ liên kết: đặt `unlinked_at` + `users.platform_user_id = NULL` + thu hồi phiên `pu` ở workspace đó; không xoá dòng.

## 6. Các PR theo thứ tự

| PR | Nội dung | Đảo ngược | Cổng chủ shop |
|---|---|---|---|
| 1 | Tài liệu này | — | đọc, trả lời §7 |
| 2 | Lược đồ §5.1 + hàm THUẦN (quyết định liên kết, đọc claim `pu`) + bài kiểm B8. Không nơi gọi | bảng rỗng, cột NULL | không |
| 3 | Báo cáo chạy thử §5.2 (ops chỉ đọc) | xoá script | chạy trên production = lượt đọc; đọc số rồi quyết làm tiếp không |
| 4 | Dựng phiên chấp nhận claim `pu` (buộc + thu hồi nền tảng) — CHƯA nơi nào phát `pu`. Bài kiểm B1–B5 bằng token tự ký | gỡ nhánh; token `pu` không tồn tại ngoài bài kiểm | không |
| 5 | Liên kết tài khoản (§5.3) + đăng nhập bằng `platform_users`, sau cờ `identity.unified` (mặc định TẮT) + B6, B7 | tắt cờ ⇒ token `pu` bị từ chối, mật khẩu cục bộ vẫn dùng | **BẬT CỜ** — đổi cách xác thực/quyền (AGENTS §7) |
| 6 | Chuyển workspace trong phiên (chỉ host chính v1; tên miền con hiện liên kết về host chính) | tắt cờ | **BẬT** (AGENTS §7) |
| 7 | Lời mời gắn vào `pu` có sẵn; `/start` tạo `pu` (chỉ tiến) | tắt cờ | cùng cổng PR 5 |
| 8 *(tuỳ)* | Thôi dùng mật khẩu cục bộ cho tài khoản đã liên kết | giữ băm, chỉ tắt đường ⇒ bật lại được | **CÓ** — §7 Q1 |

Mỗi PR có `typecheck` · `lint` · `npm test` · `build` (PR 4–6 chạm ranh giới server/client) trên cây sạch theo SHA.

## 7. Câu hỏi cho chủ shop

1. **Một mật khẩu cho mọi cửa hàng** (tiện, nhưng lộ một mật khẩu là lộ mọi workspace của người đó) hay giữ mật khẩu
   riêng từng cửa hàng sau khi liên kết? Có làm PR 8 không?
2. Chuyển sang workspace có **Tài chính / Nhân sự** có bắt gõ lại mật khẩu (xác minh lại) không?
3. Tài khoản của **workspace nhà có `platform:operate`** có được liên kết với workspace khách không? Đề xuất v1: KHÔNG —
   một mật khẩu nền tảng bị lộ không được mở tới control plane.
4. Quản trị của một workspace có được thấy thành viên mình còn ở **workspace nào khác** không? Đề xuất: KHÔNG.
5. Sửa luôn phép khớp EMAIL không xác minh của đăng nhập Google/Facebook (§1, quan sát 2) như một PR riêng, trước PR 5?
6. Ưu tiên: đợi số của báo cáo chạy thử (PR 3) rồi mới quyết làm PR 5–7?

*SUY LUẬN chưa kiểm trong tài liệu: chi phí thêm một lượt đọc CSDL nhà cho mỗi lần dựng phiên `pu` (phải đo ở PR 4, không
được `memo` vì là thu hồi); số người thật sự ở ≥ 2 workspace (PR 3 đo); rủi ro ở quan sát 2 của §1.*
