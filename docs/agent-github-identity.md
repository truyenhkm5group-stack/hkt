# Danh tính GitHub của coding agent — `erp-agent`

*19/09/2026 · Phase 2B.5 phần B. Đi kèm `lib/integrations/github/agent-identity.ts` và
`tests/agent-identity.test.ts`. Đọc sau `docs/main-protection.md`.*

---

## 0 · Đo lại ruleset — giả thuyết của PR #18 được XÁC NHẬN, không còn là suy luận

PR #18 viết: *"Agent **không đọc được** ruleset đang áp (proxy chặn API cấu hình kho). Đây là
**suy luận**, không phải quan sát trực tiếp."* Câu đó **đã hết đúng**. Lượt đo 19/09/2026 đọc
được ruleset thật:

```
GET /repos/truyenhkm5group-stack/hkt/rulesets        → [{ id: 23697012, "Khoá nhánh main", active }]
GET /repos/truyenhkm5group-stack/hkt/rulesets/23697012
```

| Luật | Giá trị ĐANG CHẠY | Bản khai trong `.github/rulesets/main-protection.json` |
|---|---|---|
| `required_approving_review_count` | **0** | 1 |
| `dismiss_stale_reviews_on_push` | **false** | true |
| `require_last_push_approval` | **false** | true |
| `required_review_thread_resolution` | true | true |
| `required_status_checks` | `gates / gates`, `strict: true` | như vậy |
| `bypass_actors` | **`[]`** | `[]` |
| `deletion` · `non_fast_forward` | chặn | chặn |
| `current_user_can_bypass` | **`never`** | — |

Ba điều rút ra, và điều thứ ba mới là điều phải làm gì đó:

1. **Suy luận của PR #18 đúng từng chữ**: số duyệt bắt buộc là **0**, và **không có bypass actor
   nào** — nên "agent merge được PR của chính nó" không phải vì có cửa sau, mà vì **cổng duyệt
   đang đặt ở mức không cấm gì**.
2. **Tệp bản khai trong kho KHÁC ruleset thật.** Tệp là thứ người ta đọc; ruleset là thứ chạy.
   Từ nay mọi câu về khoá `main` phải kèm một lượt `GET /rulesets/23697012`, không đọc tệp.
3. **Vẫn KHÔNG được nâng số duyệt lên 1 lúc này.** Lý do ở mục 1 dưới đây, và nó không đổi.

---

## 1 · Vì sao phải có danh tính thứ hai TRƯỚC khi nâng cổng

Đo được, không phải phỏng đoán:

```
GET /user                       → truyenhkm5group-stack        (danh tính agent đang dùng)
GET /repos/…/collaborators      → truyenhkm5group-stack, admin  (ĐÚNG MỘT người)
PR #18: user.login              → truyenhkm5group-stack
```

Agent = tác giả PR = collaborator duy nhất = admin, **cùng một tài khoản**. GitHub **cấm tác giả
tự duyệt PR của mình** (nút Approve bị hạ xuống thành Comment — đã xảy ra ở PR #12). Nên với một
danh tính, "bắt buộc một lượt duyệt" chỉ có hai kết cục:

| Số duyệt | Kết cục |
|---|---|
| **0** (hôm nay) | cổng **vô hiệu** — agent merge PR của chính nó |
| **1** | **không PR nào duyệt được nữa** — kho tự khoá chết |

**Không có nấc giữa, và không công tắc nào của GitHub sửa được.** Thứ còn thiếu là một **danh
tính thứ hai**. Nâng cổng trước khi có nó là tự khoá kho — nên thứ tự dưới đây **không đảo được**.

---

## 2 · Adapter đã xong — `lib/integrations/github/agent-identity.ts`

Mã đã vào kho và chạy được ngay khi có secret. Không dòng nào trong đó cần sửa sau khi chủ shop
tạo App.

| Việc | Hàm | Ghi chú |
|---|---|---|
| ký JWT của App | `appJwt()` | RS256, `node:crypto`, hạn **9 phút** (GitHub cho tối đa 10), `iat` lùi 60 giây cho lệch đồng hồ |
| đổi token cài đặt | (nội bộ) | `POST /app/installations/{id}/access_tokens`, body `{"repositories":["hkt"]}` — thu hẹp lại lần nữa ở **mỗi** lượt xin |
| remote để `git push` | `agentRemoteUrl()` | `https://x-access-token:<token>@…` — **không được in**; in thì dùng `maskRemote()` |
| mở PR | `openAgentPullRequest()` | `head` bắt buộc mang tiền tố `ai/` hoặc `claude/` |
| sửa PR | `updateAgentPullRequest()` | chỉ tiêu đề / mô tả. Không đổi base, không đóng, không gộp |
| đọc cổng | `readAgentCheckRuns()` | chỉ `GET` |
| thử kết nối | `testAgentGithubIdentity()` | ba tình huống: `NOT_CONFIGURED` · `ERROR` · `OK` |

**Token cài đặt là ngắn hạn và KHÔNG được lưu.** Nó sống trong bộ nhớ tiến trình và bị bỏ khi còn
dưới 5 phút. Không CSDL, không tệp, không prompt. Khoá riêng chỉ ở biến môi trường.

**Việc agent KHÔNG được làm được khoá bằng SỰ VẮNG MẶT của đường đi**, không bằng một cờ tắt — cờ
thì bật lại được. `tests/agent-identity.test.ts` quét mã nguồn (đã bỏ chú thích) và đỏ nếu xuất
hiện `/merge`, `/reviews`, `rulesets`, `/actions/secrets`, `/dispatches`, hay một lượt
`PATCH`/`PUT`/`DELETE` vào cấu hình kho. Cộng thêm: `assertAgentBranch()` chặn đẩy thẳng nhánh
mặc định **ở tầng mã**, trước cả khi ruleset phải lên tiếng.

Kiểm chạy không mạng, không token: sinh một cặp khoá RSA thật trong bài kiểm, ký, rồi **kiểm chữ
ký bằng khoá công khai**.

---

## 3 · ⛔ CHECKPOINT — phần này CHỦ SHOP phải bấm

Tạo GitHub App **bắt buộc đi qua trình duyệt**: luồng duy nhất không cần người là
`POST /app-manifests/{code}/conversions`, và cái `code` ấy chỉ sinh ra sau khi một NGƯỜI bấm
"Create GitHub App" trên giao diện. **Agent không có đường nào làm bước này** — và đó là điều
đúng đắn: danh tính thứ hai mà agent tự tạo được thì không phải danh tính thứ hai.

### 3.1 · Tạo App

**https://github.com/settings/apps/new**

| Ô | Điền |
|---|---|
| **GitHub App name** | `erp-agent` (tên phải duy nhất toàn GitHub; nếu trùng thì `erp-agent-vnx`) |
| **Homepage URL** | `https://erp.vnxcommerce.com` |
| **Webhook** | **Bỏ tick "Active"** — adapter này chỉ HỎI GitHub, không nhận gì từ GitHub. Không webhook ⇒ không có URL nào phải canh, không có secret thứ hai phải giữ |
| **Callback URL** | **để trống** — không có đăng nhập bằng GitHub |
| **Where can this GitHub App be installed?** | *Only on this account* |

### 3.2 · Repository permissions — đúng năm ô, không hơn

| Quyền | Mức | Vì sao CẦN |
|---|---|---|
| **Metadata** | Read-only | GitHub bắt buộc kèm theo mọi quyền khác |
| **Contents** | **Read and write** | tạo nhánh và đẩy commit của chính task |
| **Pull requests** | **Read and write** | mở và cập nhật PR |
| **Checks** | Read-only | đọc kết quả `gates / gates` |
| **Actions** | Read-only | đọc lượt chạy workflow (sổ deploy) |

**Không chọn** (và `npm run check:integrations -- --agent-identity` sẽ **báo đỏ** nếu có):

`Administration` · `Secrets` · `Variables` · `Environments` · `Actions: write` ·
`Repository hooks` · `Workflows: write` · mọi quyền Organization/Account.

> `Administration` là quyền sửa được **chính cái ruleset đang canh cổng**. Cấp nó là trao cho agent
> khả năng tự mở khoá — chính xác thứ cả Phase 2B.5 này tồn tại để ngăn. Nếu về sau có một việc
> thật sự cần thêm quyền, **nêu lý do cụ thể rồi mới thêm**, từng ô một.
>
> `Workflows: write` cũng phải tắt: có nó thì agent sửa được `.github/workflows/gates.yml`, tức là
> đổi được chính cái cổng bắt buộc — ruleset vẫn xanh mà cổng đã rỗng.

### 3.3 · Sau khi bấm Create

1. **Ghi lại App ID** (hiện ngay đầu trang App).
2. **Generate a private key** → tải về tệp `.pem`. **Tệp này không bao giờ vào kho mã** (kho PUBLIC).
3. **Install App** → chọn *Only select repositories* → **chỉ** `truyenhkm5group-stack/hkt`.
4. Sau khi cài, đọc **Installation ID** trên URL:
   `https://github.com/settings/installations/<INSTALLATION_ID>`.

### 3.4 · Đặt secret — hai nơi

**VPS** (`/opt/erp/.env` hoặc nơi `.env` đang nằm):

```
ERP_AGENT_GITHUB_APP_ID=<App ID>
ERP_AGENT_GITHUB_INSTALLATION_ID=<Installation ID>
ERP_AGENT_GITHUB_PRIVATE_KEY=<base64 của toàn bộ tệp .pem>
ERP_AGENT_GITHUB_REPO=truyenhkm5group-stack/hkt
```

Lấy chuỗi base64 (một dòng, không xuống dòng — đó là lý do adapter nhận base64):

```
base64 -w0 erp-agent.private-key.pem
```

**GitHub Actions Secrets** (`Settings → Secrets and variables → Actions`), cùng ba giá trị, tên y
hệt: `ERP_AGENT_GITHUB_APP_ID` · `ERP_AGENT_GITHUB_INSTALLATION_ID` ·
`ERP_AGENT_GITHUB_PRIVATE_KEY`. (`ERP_AGENT_GITHUB_REPO` không cần — workflow đã có
`github.repository`.)

### 3.5 · Chủ shop **không** phải viết dòng mã nào

Sau bốn bước trên, phần còn lại tự động: adapter đọc secret, đổi token, và
`npm run check:integrations -- --agent-identity` in ra danh tính đã che.

---

## 4 · Kiểm sau khi có secret — phải thấy đúng hai điều

```
npm run check:integrations -- --agent-identity
```

Xanh khi:

- `botLogin` = `erp-agent[bot]` — và **khác** `truyenhkm5group-stack`;
- danh sách quyền in ra **không có** `administration`, `secrets`, `environments`,
  `repository_hooks`, và `actions` nếu có thì phải là `read`.

Nếu `botLogin` trùng login chủ shop thì **dừng lại**: cổng duyệt vẫn không có nấc nào dùng được,
và nâng số duyệt lên 1 vẫn sẽ khoá chết kho.

---

## 5 · Bằng chứng danh tính — chỉ tài liệu, không chạm mã nghiệp vụ

Sau khi mục 4 xanh, chạy một lượt chứng minh bằng **đúng** danh tính `erp-agent`:

1. tạo nhánh `ai/proof/identity-<ngày>`;
2. commit **một** tệp tài liệu;
3. đẩy nhánh (bằng `agentRemoteUrl()`);
4. mở PR vào `main` (`openAgentPullRequest()`);
5. PR kích hoạt `gates / gates`;
6. agent **thử duyệt chính PR đó** ⇒ phải **KHÔNG CÓ KHẢ NĂNG** (adapter không có đường; và quyền
   App không có `pull_requests: approve` riêng — GitHub App không tự duyệt PR do chính nó mở);
7. agent **thử merge** ⇒ phải **KHÔNG CÓ KHẢ NĂNG**.

Không lượt nào đẩy thẳng `main`.

---

## 6 · ⛔ CHECKPOINT THỨ HAI — nâng ruleset (chỉ SAU khi mục 5 xanh)

**Settings → Rules → Rulesets → "Khoá nhánh main"**, sửa đúng bốn ô:

| Ô | Từ | Thành |
|---|---|---|
| Required approvals | **0** | **1** |
| Dismiss stale pull request approvals when new commits are pushed | tắt | **bật** |
| Require approval of the most recent reviewable push | tắt | **bật** |
| Require conversation resolution before merging | bật | giữ bật |

Giữ nguyên: `gates / gates` bắt buộc · `strict` bật · **bypass list rỗng** · chặn force push ·
chặn xoá nhánh.

Kiểm lại bằng một lượt đọc, không bằng trí nhớ:

```
GET /repos/truyenhkm5group-stack/hkt/rulesets/23697012
```

Rồi mở một PR tài liệu do `erp-agent` làm tác giả và đo:

- **trước** khi chủ shop duyệt: `gates / gates` xanh mà PR **vẫn không merge được** (bị chặn bởi
  luật duyệt, không phải bởi CI);
- **sau** khi chủ shop duyệt: đủ cổng duyệt;
- đẩy thêm một commit **sau** lượt duyệt: lượt duyệt cũ phải **mất hiệu lực**.

---

## 7 · Merge vẫn là việc của NGƯỜI

Phase 2B.5 **không** trao quyền merge cho coding agent, kể cả sau khi đã có lượt duyệt của người.
Agent dừng ở "PR xanh và đã được duyệt"; người bấm Merge. Lý do không phải là sự thận trọng chung
chung: quyền merge là quyền đưa mã lên production, và nó là chỗ duy nhất trong cả chuỗi mà một
người ký tên.

---

## 8 · Điều vẫn KHÔNG đạt được, nói thẳng

Kho thuộc **một tài khoản cá nhân**. Chủ tài khoản là admin vĩnh viễn và sửa hoặc xoá ruleset lúc
nào cũng được; chuyển sang Organization cũng chỉ đổi chỗ. Nên mục tiêu đúng vẫn là:

> **AGENT không bypass được, và mọi lần NGƯỜI bypass đều để lại vết.**

Sau Phase 2B.5, vế đầu có thêm một chân: agent chạy bằng một danh tính **không mang quyền
`Administration`**, nên nó không sửa được ruleset kể cả khi lớp proxy biến mất.
