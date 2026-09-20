# Cầu nối mở PR bằng danh tính agent

*19/09/2026. Đi sau `docs/agent-github-identity.md` (Phase 2B.5) và `docs/main-protection.md`.*

## 1 · Cái đang hỏng, đo được

`required_approving_review_count` đã lên **1**. Nhưng mọi phiên Claude vẫn mở PR bằng tài khoản
chủ shop:

| Phép đo (19/09/2026) | Kết quả |
| --- | --- |
| 10 PR gần nhất | **9/10** mang `truyenhkm5group-stack` |
| số phiên Claude khác nhau đã mở PR | **≥ 5** |
| PR mang `erp-agent-vnx[bot]` | **đúng 1** — #24, do bộ chứng minh tự sinh nhánh của nó |
| `GET /user` từ trong một phiên | `truyenhkm5group-stack` |
| biến `ERP_AGENT_GITHUB_*` trong phiên | **không có** |

GitHub **cấm tác giả tự duyệt PR của mình**. Chủ shop là collaborator duy nhất. Nên mọi PR do một
phiên mở đều kẹt vĩnh viễn — đo được: **PR #26, cổng xanh, `mergeable_state: blocked`**.

> Đây không phải lỗi của bản nâng cổng. Bản nâng cổng đúng. Thứ còn thiếu là **đường để phiên mở
> PR dưới danh tính thứ hai**, và nó chưa bao giờ tồn tại.

## 2 · Vòng tròn, và vì sao phải bootstrap

```
thêm cầu nối → phải merge → phải có PR → phiên mở PR dưới tài khoản chủ shop
             → cổng đòi 1 duyệt → chủ shop không tự duyệt được → KHÔNG merge được
```

Vòng này **không tự phá được từ bên trong**. Nó cần đúng một lần can thiệp của người — xem mục 6.

## 3 · Thiết kế

```
phiên Claude ──dispatch──▶ agent-open-pr.yml (trên main) ──App token──▶ POST /pulls
                                   │
                                   └──GITHUB_TOKEN (chỉ đọc)──▶ GET /pulls/N  ← đối chứng
```

`.github/workflows/agent-open-pr.yml` nhận bốn input: `head` · `base` · `title` · `body`.
`scripts/agent-open-pr.ts` gọi `openAgentPullRequest()` của adapter đã có, rồi **đọc lại** PR bằng
một credential khác.

### Nhánh nguồn KHÔNG bao giờ được chạy

Đây là trung tâm của thiết kế. Nhánh nguồn là **mã chưa ai review**. Cầu nối:

- **không** `checkout` nhánh nguồn;
- **không** chạy `npm`, `npx`, script hay bất cứ thứ gì của nó;
- chỉ đưa tên nhánh vào trường `head` của một lời gọi API — một **chuỗi**, không phải mã.

Và input **chỉ đi qua `env:`**, không bao giờ nội suy thẳng vào thân `run:` — nội suy là đường tiêm
lệnh, vì tên nhánh do người gọi đặt và `$(...)` trong đó sẽ được shell chạy.

### Quyền — không nới một ô nào

| | |
| --- | --- |
| `GITHUB_TOKEN` của workflow | `contents: read` + `pull-requests: read`. **Không một quyền ghi nào** |
| Quyền GitHub App | **không đổi** — `contents: write` + `pull_requests: write` đã đủ mở PR |
| Gộp PR | **không có đường đi** trong adapter |
| Duyệt PR | **không có đường đi** trong adapter |
| `gates / gates` | **không đụng tới**, vẫn bắt buộc |
| Người duyệt | vẫn là chủ shop |

### Đối chứng bằng credential KHÁC

Sau khi mở, script đọc lại PR bằng `GITHUB_TOKEN`, **không** bằng token App, và **thoát khác 0**
nếu `user.login` không phải bot hoặc `user.type` không phải `Bot`.

Hỏi lại chính cái token vừa ghi thì *"đã mở bằng bot"* và *"trông như đã mở bằng bot"* nhìn giống
hệt nhau — đúng bài học mà bộ chứng minh danh tính đã phải trả giá để rút ra (nó từng dùng
`git push` và phép đối chứng với token **rác** cũng thành công, vì môi trường tự tiêm credential
của phiên).

## 4 · Hàng rào chống dispatch từ nhánh chưa review

Bước **đầu tiên** của workflow so `github.ref_name` với nhánh mặc định và `exit 1` nếu lệch — và
nó đứng **trước** bước đọc secret. Kiểm sau khi đã đọc là không kiểm gì.

> ⚠️ **Hàng rào này chặn nhầm lẫn, không chặn cố ý.** Nó nằm trong chính tệp workflow, nên ai sửa
> được tệp trên một nhánh thì cũng xoá được dòng kiểm ấy rồi dispatch nhánh đó.

### Hàng rào cứng — Environment `agent-identity`

Job khai `environment: agent-identity`. Ba secret `ERP_AGENT_GITHUB_*` sống **trong Environment
đó**, không phải ở Actions Secrets của kho, và Environment có *deployment branch policy* chỉ cho
`main`. Lượt chạy từ nhánh khác **không đọc được secret** — thất bại **ĐÓNG**, và lần này quyết
định nằm ở phía GitHub, không đọc một dòng nào của tệp mà agent sửa được.

**Hai hàng rào cùng tồn tại, không cái nào thay cái nào.** Environment chưa được tạo thì GitHub
**tự tạo** nó khi job chạy lần đầu — **rỗng, và không có chính sách nhánh**. Hàng rào cứng lúc đó
biến mất mà không ai được báo, và chỉ còn phép kiểm `ref` đứng lại. Một hàng rào tự dựng lên ở
trạng thái mở là lý do để giữ hàng rào thứ hai, không phải lý do để bỏ nó.

**Tên Environment là hằng số trong tệp.** Cho nó nhận `inputs.*` là để người gọi tự chọn kho
secret — tự chọn hàng rào của chính mình, tức là không có hàng rào. `tests/agent-pr-bridge.test.ts`
khối 8 khoá cả ba điều: khai ở **mức job** (khai ở mức step thì bước khác trong cùng job vẫn đọc
secret kho), tên đúng `agent-identity`, và tên **không nội suy**.

#### Việc của người — đặt secret ĐÚNG CHỖ

| | |
| --- | --- |
| Tạo Environment `agent-identity` | *Settings → Environments → New environment* |
| *Deployment branch policy* | **Selected branches** → chỉ `main` |
| Ba secret đặt **trong Environment** | `ERP_AGENT_GITHUB_APP_ID` · `ERP_AGENT_GITHUB_INSTALLATION_ID` · `ERP_AGENT_GITHUB_PRIVATE_KEY` |
| Secret **cùng tên ở mức kho** | **XOÁ** — xem ngay dưới |

`secrets.X` trong một job có `environment:` lấy giá trị của Environment **trước**, rồi mới **lùi
về** secret của kho. Nên để lại một bản cùng tên ở mức kho là giữ nguyên đúng cái đường mà
Environment sinh ra để đóng: một nhánh chưa review vẫn đọc được bản của kho. Khoá riêng của App
chỉ được tồn tại **một bản**, và bản đó nằm trong Environment.

**Đây là một lỗ hổng có từ trước, không phải do bản này sinh ra.** Hôm nay `ops-vps.yml` và
`deploy-vps.yml` cũng dispatch được với `ref` là một nhánh đã sửa — tức là mã chưa review chạy được
với khoá SSH của VPS và token GHCR. Bản này đóng **một** trong ba chỗ; hai chỗ kia đóng bằng đúng
cách ấy, ở một bản riêng, vì chúng đụng tới đường deploy đang chạy.

## 5 · Bài kiểm

`tests/agent-pr-bridge.test.ts` quét **mã nguồn**, vì `tsc` và `eslint` không nhìn thấy một *sự
vắng mặt*: thêm một dòng `fetch` là mở một đường mới mà mọi cổng khác vẫn xanh.

Tám khối: không `/merge` · không `/reviews` · không chạm cấu hình kho · không checkout hay chạy mã
nhánh nguồn (và input chỉ đi qua `env:`) · phép kiểm nhánh đứng trước bước đọc secret ·
`GITHUB_TOKEN` không có quyền ghi · đối chứng bằng credential khác và sai thì đỏ · luật nhánh dùng
lại `assertAgentBranch` thay vì chép · secret nằm trong Environment `agent-identity` khai ở mức job
với tên là hằng.

## 6 · Việc của người — đúng MỘT thao tác

Vòng tròn ở mục 2 chỉ phá được bằng một lần can thiệp:

> **Chủ shop thêm một tài khoản GitHub thứ hai làm collaborator quyền `write`.**

Tài khoản đó duyệt PR bootstrap này (PR do `truyenhkm5group-stack` mở, nên chính chủ shop không tự
duyệt được). Merge xong thì cầu nối nằm trên `main`, và **từ đó mọi PR của mọi phiên đi qua bot** —
chủ shop tự duyệt được chúng, không cần tài khoản thứ hai nữa.

*Phương án thay thế:* chủ shop tự mở PR bootstrap bằng App (họ giữ khoá riêng). Sửa đúng lần này,
không sửa gốc — nhưng cũng đủ để merge cầu nối.

## 7 · Sau khi merge — nghiệm thu

1. Dispatch `agent-open-pr.yml` với `head` của một nhánh thật.
2. `GET /pulls/N` → `user.login` phải là **`erp-agent-vnx[bot]`**, `user.type` = `Bot`.
3. **Đối chứng âm:** không PR mới nào của phiên còn mang `truyenhkm5group-stack`.
4. Chỉ khi cả ba đạt mới coi phần danh tính là xong.

---

# PHỤ LỤC · 20/09/2026 — ENVIRONMENT PHẢI PHỦ **MỌI** NGƯỜI DÙNG, KHÔNG CHỈ CẦU NỐI ĐẦU TIÊN

Bản gốc của tài liệu này chuyển ba secret vào Environment `agent-identity` và khai `environment:`
ở **một** workflow. Điều đó đúng, và chưa đủ.

## Sự việc — đo thật

Sau khi ba secret dọn về Environment và bản cùng tên ở mức kho bị xoá, lượt chạy đầu tiên của một
workflow **khác** đọc cùng ba secret đã hỏng:

```
run 35482454679 · agent-update-pr.yml
env:
  ERP_AGENT_GITHUB_APP_ID:            ← rỗng
  ERP_AGENT_GITHUB_INSTALLATION_ID:   ← rỗng
  ERP_AGENT_GITHUB_PRIVATE_KEY:       ← rỗng
  GITHUB_TOKEN: ***                   ← có giá trị thì GitHub in ***
✗ Chưa có ERP_AGENT_GITHUB_APP_ID, ERP_AGENT_GITHUB_INSTALLATION_ID, ERP_AGENT_GITHUB_PRIVATE_KEY
```

`GITHUB_TOKEN` in `***` chứng minh cơ chế che vẫn chạy — nên ba dòng rỗng kia là **thật sự không
có giá trị**, không phải bị che. Chạy lại lượt thứ hai: y hệt.

Thông điệp lỗi **đúng ngữ pháp và sai địa chỉ**: nó nói "chưa có Secret", nên người đọc đi thêm lại
Repository secret — tức **dựng lại đúng cái bản trùng tên mà Environment sinh ra để xoá**. Suýt nữa
thì bản vá cho một lỗ hổng lại mở lại chính lỗ hổng ấy.

## Luật

**Mọi** job chạm tới `ERP_AGENT_GITHUB_*` phải khai `environment: agent-identity`. Bốn job hôm nay:

| Workflow | Job |
|---|---|
| `agent-open-pr.yml` | `open` |
| `agent-update-pr.yml` | `update` |
| `agent-identity-proof.yml` | `proof` |
| `ops-vps.yml` | `agent-env` |

`tests/agent-pr-bridge.test.ts::testEnvironmentOnlyAgentSecrets` quét **toàn bộ** `.github/workflows/`
và khoá bất biến ấy — không liệt kê bốn cái tên, vì liệt kê là khoá lại đúng lần hỏng đã xảy ra
còn workflow thứ năm vẫn rơi vào y hệt cái bẫy.

## Và một chiều ngược lại, dễ quên hơn

`apply-agent-env` từng là một nhánh `case` trong job `ops` của `ops-vps.yml`. Gắn
`environment: agent-identity` cho job ấy sẽ bắt **~60 thao tác VPS** — `status`, `logs`,
`db-query`, `verify` — đi qua chính sách nhánh của một Environment dựng cho ba secret **chúng
không hề dùng**.

Nên `apply-agent-env` tách thành **job riêng** `agent-env`, và chỉ job đó mang Environment. Job
`ops` khai `if: inputs.action != 'apply-agent-env'`; job `agent-env` khai điều ngược lại. Bài kiểm
khẳng định cả hai chiều: job `agent-env` **phải** có Environment, job `ops` **không được** có.

Job mới cầm **đúng** ổ khoá `/var/lock/erp-lifecycle.lock` ở chế độ **độc quyền** như mọi thao tác
GHI — nó ghi `.env` rồi dựng lại container, nên chạy song song với deploy là đúng thứ `flock` sinh
ra để chặn.

> **Hàng rào đặt sai chỗ là hàng rào người ta sẽ tìm cách đi vòng.** Một Environment bảo vệ ba
> secret không được phép trở thành điều kiện của những thao tác không liên quan tới ba secret ấy.
