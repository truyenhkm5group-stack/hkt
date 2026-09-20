# Biên bản bằng chứng — danh tính agent và cầu nối Environment

Đo ngày **20/09/2026**. Mọi con số dưới đây đọc từ GitHub API tại thời điểm ghi, không chép lại từ
tài liệu khác.

> **Vì sao có tệp này.** Hai PR chứng minh (#24, #38) tồn tại để **bấm một lần rồi đọc kết quả**,
> không phải để gộp vào `main` — bản thân chúng chỉ chứa một tệp tài liệu. Đóng chúng mà không ghi
> lại thì bằng chứng biến mất cùng cái PR. Nên bằng chứng ở **đây**, và PR được đóng chứ không gộp.
>
> Tệp này là **biên bản**, không phải đặc tả. Luật sống ở `docs/agent-github-identity.md` và
> `docs/agent-pr-bridge.md`; bài kiểm khoá luật sống ở `tests/agent-pr-bridge.test.ts`.

---

## 1. PR #24 — cổng duyệt có nấc giữa

Câu hỏi nó trả lời: *coding agent có một danh tính GitHub **thứ hai**, tách khỏi tài khoản chủ shop,
đủ để `required_approving_review_count: 1` là một luật chạy được chứ không phải một cái bẫy khoá
chết kho?*

| Hạng mục | Giá trị đo được |
|---|---|
| PR | [#24](https://github.com/truyenhkm5group-stack/hkt/pull/24) |
| Tác giả | **`erp-agent-vnx[bot]`** (id `331317687`) — **không** phải `truyenhkm5group-stack` |
| HEAD SHA | `3e8de1b883a53d17999e3cd5ae021b25698b3fca` |
| Người duyệt | **`nguyenloineu94`** (`COLLABORATOR`), APPROVED lúc `2026-09-19T18:07:00Z` |
| Lượt duyệt gắn vào commit | `3e8de1b8…` — **đúng HEAD hiện tại**, nên lượt duyệt còn hiệu lực |
| Cổng | `gates / gates` — **success** ([run 35481246672](https://github.com/truyenhkm5group-stack/hkt/actions/runs/35481246672)) |
| Quy mô | 1 tệp, +15 dòng, chỉ tài liệu |
| Phép đo `probe_merge` | **CHƯA CHẠY** — xem mục 3 |

**Kết luận phần danh tính: ĐẠT.** Ba vế đủ — PR do bot mở, người duyệt là một tài khoản **thứ ba**
(không phải bot, không phải chủ kho), và lượt duyệt nằm đúng trên HEAD đang xét. Vòng lặp bootstrap
mà `docs/agent-pr-bridge.md` mục 6 nêu đã được phá bằng một người duyệt thật.

---

## 2. PR #38 — cầu nối lấy credential từ Environment

Câu hỏi nó trả lời: *sau khi ba secret `ERP_AGENT_GITHUB_*` dọn hết về Environment `agent-identity`
và bản cùng tên ở mức kho bị xoá, đường mở PR bằng danh tính agent **còn chạy được không**?*

| Hạng mục | Giá trị đo được |
|---|---|
| PR | [#38](https://github.com/truyenhkm5group-stack/hkt/pull/38) |
| Tác giả | **`erp-agent-vnx[bot]`** |
| HEAD SHA | `69337e247f45381abb478ed629b1e62ea73e84a2` |
| Base | `de8a449` (= `main` lúc đo) |
| Cổng | `gates / gates` — **success** ([run 35483897162](https://github.com/truyenhkm5group-stack/hkt/actions/runs/35483897162)) |
| Lượt chạy đã mở PR này | `agent-open-pr.yml` **run #11** = [`35483880174`](https://github.com/truyenhkm5group-stack/hkt/actions/runs/35483880174) |
| — ref của lượt chạy | `main` @ `de8a449` |
| — kết quả | **success**, 02:23:51 → 02:24:17Z (PR tạo lúc 02:24:13Z) |
| Quy mô | 1 tệp, +19 dòng, chỉ tài liệu |

Nguồn credential, đọc thẳng từ `main`:

```
$ git show origin/main:.github/workflows/agent-open-pr.yml | grep -n 'open:\|environment:'
2:  open:
6:    environment: agent-identity
```

### Đối chứng ÂM — hàng rào chặn thật, không chỉ có mặt

Một lượt chạy thành công chỉ chứng minh đường đi tồn tại. Thứ chứng minh **hàng rào** là những lượt
chạy **phải hỏng**:

| Run | ref dispatch | Kết quả |
|---|---|---|
| [`35483880174`](https://github.com/truyenhkm5group-stack/hkt/actions/runs/35483880174) (#11) | `main` @ `de8a449` | **success** → mở #38 |
| [`35485829462`](https://github.com/truyenhkm5group-stack/hkt/actions/runs/35485829462) (#12) | `main` @ `de8a449` | **success** → mở #39 |
| [`35483855808`](https://github.com/truyenhkm5group-stack/hkt/actions/runs/35483855808) (#10) | `claude/agent-identity-environment` | **failure** |
| [`35483845176`](https://github.com/truyenhkm5group-stack/hkt/actions/runs/35483845176) (#9) | `claude/session-revocation-e2e` | **failure** |

*Deployment branch policy* của Environment chỉ cho `main`, nên lượt chạy từ nhánh khác **không đọc
được secret** và thất bại ĐÓNG. Hàng rào này nằm ở phía GitHub và không đọc một dòng nào của tệp
workflow — nên nó chặn được cả **cố ý**, không chỉ nhầm lẫn.

**Kết luận: ĐẠT.** Đủ ba vế owner yêu cầu — tác giả đúng là bot, cổng xanh, credential đến từ
Environment. Cộng thêm đối chứng âm.

---

## 3. Phép đo `probe_merge` — CHƯA CHẠY ĐƯỢC, và lý do là một lỗi đã biết

`agent-identity-proof.yml` có input `probe_merge` (mặc định `false`) để đo nốt câu hỏi cuối: *App có
gộp được PR không?* — câu trả lời **phải là KHÔNG**. Ruleset đã lên 1 duyệt bắt buộc từ lâu nên phép
đo ấy nay chạy được về mặt chính sách.

**Nhưng nó chưa chạy được về mặt kỹ thuật.** Trên `main` (`de8a449`), job `proof` đọc ba secret mà
**không khai Environment**:

```
$ git show origin/main:.github/workflows/agent-identity-proof.yml | grep -n 'proof:\|environment:\|ERP_AGENT_GITHUB_'
31:  proof:
48:          ERP_AGENT_GITHUB_APP_ID: ${{ secrets.ERP_AGENT_GITHUB_APP_ID }}
49:          ERP_AGENT_GITHUB_INSTALLATION_ID: ${{ secrets.ERP_AGENT_GITHUB_INSTALLATION_ID }}
50:          ERP_AGENT_GITHUB_PRIVATE_KEY: ${{ secrets.ERP_AGENT_GITHUB_PRIVATE_KEY }}
```

Không có dòng `environment:` nào ở job `proof`. Ba secret chỉ tồn tại trong Environment, nên chạy
`probe_merge` hôm nay sẽ nhận **ba giá trị rỗng** và hỏng y hệt run `35482454679` của
`agent-update-pr.yml` — đúng lỗi mà **PR #39** sinh ra để vá.

> **Phụ thuộc:** `probe_merge` chờ **#39 vào `main`**. Đây không phải lựa chọn thứ tự cho gọn; nó là
> một phụ thuộc cứng. Chạy trước sẽ tạo ra một lượt đỏ với thông điệp *"chưa có Secret"* — thông
> điệp **đúng ngữ pháp và sai địa chỉ**, và người đọc nó sẽ đi thêm lại Repository secret, tức dựng
> lại đúng bản trùng tên mà Environment sinh ra để xoá.

Ô này để trống có chủ đích. Điền sau khi #39 merge:

| | |
|---|---|
| Run `probe_merge` | *(chưa chạy)* |
| Kết quả mong đợi | App **KHÔNG** gộp được PR của chính nó |
| Kết quả thực tế | *(chưa có)* |

---

## 4. Vì sao hai PR này được ĐÓNG chứ không GỘP

Cả hai chỉ chứa một tệp tài liệu sinh tự động, và thân PR #24 ghi thẳng: *"Đừng gộp PR này để lấy
tài liệu."* Gộp một tài liệu chứng minh vào `main` là biến **một phép đo tại một thời điểm** thành
**một tệp phải bảo trì mãi mãi** — và nó sẽ cũ đi trong khi vẫn đọc ra như một lời khẳng định hiện
tại. Bằng chứng thuộc về biên bản, không thuộc về cây mã.

**Nhánh proof KHÔNG bị xoá:** `ai/proof/identity-2026-09-19-mu8jribc` và
`ai/proof/bridge-env-2026-09-20` giữ nguyên, vì SHA trong bảng trên chỉ tra được khi nhánh còn sống.
