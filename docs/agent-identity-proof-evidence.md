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

### Cập nhật cùng ngày, 07:10 — chỗ chặn đã hết, phép đo thì chưa chạy

| | |
|---|---|
| #39 | **MERGED** lúc `2026-09-20T06:50:57Z` → `main` = `6df5881` |
| Job `proof` trên main mới | **đã có** `environment: agent-identity` (dòng 46) ⇒ chỗ chặn kỹ thuật HẾT |
| Số lượt chạy `agent-identity-proof.yml` | **0** (`total_count: 0`) — chưa bao giờ được dispatch |
| Run `probe_merge` | **CHƯA CHẠY** |
| Kết quả thực tế | **CHƯA CÓ** |
| PR #24 | **ĐÃ ĐÓNG** lúc `2026-09-20T07:03:48Z` — không phải do phiên này |

**Nên ô này vẫn trống, và giờ nó trống theo một kiểu khác.** Trước 06:50 nó trống vì *không chạy
được*; sau 06:50 nó trống vì *chưa ai chạy*, trong khi cái PR dựng ra để đo đã bị đóng.

Hai thứ đó khác nhau và phải nói tách ra: phần **danh tính** (mục 1) đã ĐẠT và đóng #24 là đúng —
bằng chứng của nó đầy đủ, ghi ở trên. Phần **"App có gộp được PR không"** thì vẫn là một câu hỏi
CHƯA CÓ CÂU TRẢ LỜI ĐO ĐƯỢC.

### ĐÃ CHẠY — 20/09/2026 07:21, và kết quả quan trọng hơn câu hỏi ban đầu

| | |
|---|---|
| Run | [`35496633831`](https://github.com/truyenhkm5group-stack/hkt/actions/runs/35496633831) · `agent-identity-proof.yml` · ref `main` @ `6df5881` |
| Kết luận của workflow | **failure** — "3 khẳng định KHÔNG đạt" |
| `main` trước probe | `6df58818dd61b1e7744b5c643d49c0c287b2fde5` |
| `main` sau probe | `6df58818dd61b1e7744b5c643d49c0c287b2fde5` — **KHÔNG ĐỔI** |
| PR sinh ra | #43, nhánh `ai/proof/identity-2026-09-20-mu9hmxkj` @ `bf38c9f07479` |

**Nhưng "3 khẳng định không đạt" KHÔNG có nghĩa là ba hàng rào thủng.** Đọc từng dòng thì hai
trong ba là **lỗi phân loại của chính bộ chứng minh**, và cái thứ ba là một câu trả lời trung thực.

#### Quyền của App — đọc thẳng từ GitHub, không đọc tài liệu

```
checks=read · actions=read · contents=write · metadata=read · pull_requests=write
✓ không có administration   ✓ không có secrets    ✓ không có variables
✓ không có environments     ✓ không có repository_hooks   ✓ không có workflows
```

`botLogin` = `erp-agent-vnx[bot]`, **khác** chủ kho. Token cài đặt chỉ với tới **đúng một kho**.

#### Năm phép thử hàng rào — bốn XANH, một bị chấm nhầm

| Phép thử | Kết quả thật | Bộ chứng minh chấm |
|---|---|---|
| Ghi thẳng `main` qua API | **409** — *"Changes must be made through a pull request"* | ✓ đúng |
| Tự duyệt PR của chính mình | **422** | ✓ đúng |
| Sửa ruleset | **403** | ✓ đúng |
| Đọc khoá secret của kho | **403** | ✓ đúng |
| Sửa cấu hình kho | **403** | ✓ đúng |
| **Gộp PR của chính mình** | **405** — `Repository rule violations found` · *"New changes require approval from someone other than the last pusher"* · *"Required status check `gates / gates` is expected"* | ✗ **chấm nhầm thành "KHÔNG bị từ chối"** |

> **Câu trả lời cho câu hỏi cuối cùng của mô hình danh tính: KHÔNG. App không gộp được PR của
> chính nó.** Và GitHub nói ra **đúng hai luật** đã chặn nó. Đây là bằng chứng mạnh hơn mong đợi —
> nó không chỉ nói "bị chặn", nó nói *chặn bởi cái gì*.

#### Hai lỗi của bộ chứng minh, đã vá trong cùng lượt này

**1 · `phaiBiTuChoi` liệt kê mã trạng thái thay vì đọc kết cục.** Hàm chỉ nhận `403/404/409`.
GitHub trả **405** cho lượt gộp bị ruleset chặn ⇒ một lượt bị từ chối **đúng** bị in ra là *"KHÔNG
bị từ chối"*. Chú thích của chính hàm kể rằng lỗi này **đã xảy ra một lần** với mã `409`, và bản vá
lúc ấy *thêm 409 vào danh sách* — tức vá đúng cái ca đã hỏng, không vá cái lớp. Nay phân loại theo
`res.ok`: khẳng định đang kiểm là *"lời gọi này không được thành công"*, nên thứ quyết định phải là
**nó có thành công không**, không phải mã trả về có nằm trong một danh sách gõ tay hay không.

**2 · Phép thử `git push` là một lượt đẩy RỖNG, và nó báo "sự cố" mỗi lần chạy.** `HEAD` của cây
làm việc là bản `actions/checkout` của chính `main`; commit tài liệu ở bước 3 tạo qua **API** nên
không bao giờ vào cây ấy. `git push remote HEAD:main` do đó đẩy `main` lên `main` → *Everything
up-to-date* → thoát `0` → `try` coi là **đẩy thành công** →

```
✗ ĐẨY THẲNG main THÀNH CÔNG — ruleset không chặn. Đây là sự cố, dừng mọi việc khác lại.
```

`main` đứng nguyên ở `6df5881` suốt lượt chạy, và lượt ghi qua API **ngay dòng trên** bị chặn bằng
409. Hàng rào kín; lời tố cáo là bịa. Đây là **báo động giả to nhất bộ chứng minh có thể phát ra**
— nó tố cáo đúng cái hàng rào quan trọng nhất là đã thủng, và ai tin nó sẽ đi nới một thứ đang
lành. Nay phép thử dựng một **commit rỗng** để `HEAD` thật sự đi trước `main` một bước; bị chặn ⇒
xanh, đẩy được ⇒ một commit rỗng trên `main` gỡ bằng một lượt revert, và lúc đó sự cố là **thật**.

**3 · `gates / gates: còn in_progress sau 4 phút — CHƯA BIẾT, không kết luận là xanh`** — dòng này
**đúng**, và nên giữ. Cổng chưa xong thì chưa biết; đó là hành vi mong muốn, không phải lỗi.

> Sau hai bản vá, lượt chạy tới sẽ chấm đúng **năm trên năm** phép thử hàng rào. Nhưng con số
> đáng nhớ của hôm nay không phải "5/5" — mà là: **bộ chứng minh an ninh vừa tự tố cáo sai hai
> lần, và một trong hai lần là lời tố cáo nghiêm trọng nhất nó biết nói.**

### Và phép đo ấy KHÔNG phải read-only — đọc kỹ trước khi chạy

`scripts/agent-identity-proof.ts` không phải một kịch bản quan sát. Nó là **phép thử xâm nhập vào
chính hàng rào của kho**: mỗi bước gọi THẬT một API bị cấm rồi khẳng định lời gọi ấy **phải hỏng**
(`phaiBiTuChoi`). Riêng `--probe-merge` gọi `PUT /pulls/{n}/merge` vào `main`. Chú thích của chính
nó nói thẳng:

> *"…thử nó là **thật sự gộp một thứ vào nhánh mặc định** chứ không phải chứng minh nó bị chặn."*

Ba hệ quả phải biết trước khi bấm:

1. **Nếu ruleset kín** → lời gọi bị từ chối → đó chính là bằng chứng cần. Đây là kết quả mong đợi,
   vì ruleset nay ở 1 duyệt bắt buộc với `bypass_actors: []`.
2. **Nếu ruleset có lỗ** → một commit **chưa ai duyệt** vào thẳng `main`. Hồi phục được bằng
   `revert`, nhưng đó là một lần vỡ hàng rào thật.
3. **Dù kết quả nào**, script tự tạo một nhánh + một PR mới mỗi lượt chạy (`openAgentPullRequest`)
   rồi mới thử gộp *cái PR nó vừa tạo*. Chạy nó là **cộng thêm một PR vào hàng đợi**.

Bước 5a cũng thử `PUT /contents` lên `main` và `git push HEAD:main` thật, cùng cơ chế.

Không có cách nào đo "App có gộp được không" mà không thử gộp — nên đây là đánh đổi, không phải
thiếu sót của thiết kế. Nhưng nó là quyết định của chủ shop, không phải một bước dọn dẹp.

---

## 4. Vì sao hai PR này được ĐÓNG chứ không GỘP

Cả hai chỉ chứa một tệp tài liệu sinh tự động, và thân PR #24 ghi thẳng: *"Đừng gộp PR này để lấy
tài liệu."* Gộp một tài liệu chứng minh vào `main` là biến **một phép đo tại một thời điểm** thành
**một tệp phải bảo trì mãi mãi** — và nó sẽ cũ đi trong khi vẫn đọc ra như một lời khẳng định hiện
tại. Bằng chứng thuộc về biên bản, không thuộc về cây mã.

**Nhánh proof KHÔNG bị xoá:** `ai/proof/identity-2026-09-19-mu8jribc` và
`ai/proof/bridge-env-2026-09-20` giữ nguyên, vì SHA trong bảng trên chỉ tra được khi nhánh còn sống.

> Lưu ý về SHA của #24: nhánh ấy được cập nhật nhiều lần trong ngày (`3e8de1b8` → `9acd4e10` →
> `a26fd097`) khi các phiên khác đồng bộ nó với `main`. Bảng ở mục 1 ghi SHA **tại thời điểm đọc
> lượt duyệt**, và lượt duyệt của `nguyenloineu94` luôn được GitHub báo gắn đúng HEAD đang xét ở
> mỗi lần đọc. Ai cần truy lại chính xác thì đọc `pullrequestreview-5256913573`.
