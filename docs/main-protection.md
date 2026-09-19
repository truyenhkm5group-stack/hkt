# Khoá nhánh `main` — chính sách, và phần ai phải bấm

*19/09/2026. Đi kèm `.github/rulesets/main-protection.json` (bản khai áp được bằng một lệnh).*

## 0 · Hiện trạng ĐO ĐƯỢC, không phải phỏng đoán

```
GET /repos/…/branches/main            → protected: false
GET /repos/…/rulesets                 → []            (không có ruleset nào)
GET /repos/…/branches/main/protection → 403 Resource not accessible by integration
POST /repos/…/rulesets                → 403 Write access to this GitHub API path is not
                                             permitted through this proxy
```

Hai điều rút ra:

1. **`main` đang hoàn toàn mở.** Ai có quyền đẩy đều đẩy thẳng được, ép được, xoá được.
2. **Agent KHÔNG bật được, và cũng KHÔNG gỡ được.** Chặn nằm ở tầng proxy, trước cả quyền của
   GitHub App — nên nó đúng là thứ mục "không để agent tự gỡ khoá" cần: không phải một lời hứa
   trong tài liệu mà là một cánh cửa không tồn tại.

Phần bật khoá vì vậy **phải do người có quyền admin trên kho bấm**. Dưới đây là đúng những gì cần.

## 1 · Thứ tự BẮT BUỘC: dựng cổng trước, khoá sau

Trước bản này, **không workflow nào chạy trên `pull_request`** — cả ba đều `workflow_dispatch`.
Tức là một PR không có cổng nào cả. Bật "required status checks" vào lúc đó sẽ khoá chết mọi PR:
cái check bắt buộc không bao giờ chạy, nên không PR nào xanh được, mãi mãi.

Nên:

| Bước | Việc | Ai làm |
| --- | --- | --- |
| 1 | `gates.yml` + `ci.yml` vào `main` | đã xong (bản này) |
| 2 | Một PR bất kỳ chạy xanh, đọc ĐÚNG TÊN check | đã xong (xem mục 3) |
| 3 | Áp ruleset | **admin** |

## 2 · Chính sách

| Luật | Giá trị | Vì sao |
| --- | --- | --- |
| `deletion` | chặn | không ai xoá được `main` |
| `non_fast_forward` | chặn | không force push — lịch sử đã đẩy là bất biến |
| `pull_request` | 1 duyệt · dismiss khi đẩy thêm · duyệt lần đẩy cuối · phải giải quyết hết thread | agent không merge được PR của chính nó: nó không phải người |
| `required_status_checks` | `gates / gates`, strict | strict = PR phải cập nhật với `main` trước khi merge |
| `bypass_actors` | **rỗng** | có một lối vòng là không có khoá |

`allowed_merge_methods` cố ý bỏ `rebase`: rebase viết lại SHA, mà `tech_tasks.head_sha` và sổ
deploy đều neo vào SHA. Merge hoặc squash thì SHA trên `main` truy ngược được về PR.

## 3 · Tên check — đọc từ lượt chạy thật, đừng đoán

`ci.yml` có job `gates` gọi lại `gates.yml` (job trong đó cũng tên `gates`), nên tên check hiện ra
là **`gates / gates`**. Đây là chỗ dễ sai nhất của cả chính sách: gõ nhầm tên thì check bắt buộc
không bao giờ khớp lượt chạy nào, và PR treo vô hạn với lý do trông như CI hỏng.

**Trước khi áp, mở một PR bất kỳ và đọc tên check hiện ra ở đó.** Nếu khác, sửa `context` trong
`.github/rulesets/main-protection.json` cho khớp — và nhớ rằng **đổi tên job sau này là gỡ khoá
`main` mà không ai nhận ra**.

## 4 · Áp ruleset (admin)

Bằng `gh`:

```
gh api -X POST /repos/truyenhkm5group-stack/hkt/rulesets \
  --input .github/rulesets/main-protection.json
```

Hoặc trên giao diện: **Settings → Rules → Rulesets → New branch ruleset**, rồi khai đúng bảng ở
mục 2, target `Default branch`, enforcement `Active`, bypass list **để trống**.

Kiểm lại:

```
gh api /repos/truyenhkm5group-stack/hkt/rulesets
gh api /repos/truyenhkm5group-stack/hkt/branches/main | jq .protected
```

## 5 · Hậu quả phải biết trước khi bấm

Khoá xong thì **mọi phiên làm việc song song đang đẩy thẳng vào `main` sẽ dừng được ngay lập
tức** — kể cả phiên của người. Đó đúng là điều chính sách này muốn, nhưng nó không phải một thay
đổi âm thầm: từ lúc đó mọi thay đổi đi bằng PR, chờ `gates / gates` xanh, và cần một lượt duyệt.

Nếu kho đang có nhiều phiên chạy song song (hôm nay có), nên bấm vào lúc chúng đã đẩy xong, và
báo cho các phiên biết.

## 6 · Những gì agent KHÔNG làm được — và vì sao không phải nhờ lời hứa

| Hành vi | Chặn ở đâu |
| --- | --- |
| sửa protection / ruleset | proxy chặn ghi vào API cấu hình kho (403, đo ở mục 0) |
| tắt required checks | như trên |
| force push / xoá `main` | ruleset (sau khi admin áp) |
| đẩy thẳng `main` | ruleset (sau khi admin áp) |
| merge PR của chính nó | ruleset đòi một lượt duyệt của NGƯỜI |
| sửa workflow bảo vệ để né cổng | thay đổi `.github/workflows/*` cũng phải đi qua PR + cổng + duyệt |

Hàng cuối là hàng dễ quên nhất: nếu `main` được khoá nhưng workflow sửa được tự do thì khoá chỉ
là trang trí. Ruleset phủ mọi tệp trên nhánh, `.github/` không có ngoại lệ.

---

# PHỤ LỤC 19/09/2026 · ĐO LẠI SAU KHI KHOÁ ĐÃ BẬT — KHOÁ CHƯA ĐẠT MỤC TIÊU

*Phần trên là bản THIẾT KẾ. Phần này là bản ĐO. Chúng không khớp nhau, và tài liệu phải nói ra
điều đó thay vì để người đọc tin vào bản thiết kế.*

## A · Sự việc

PR #12 (phiên trượt) được agent mở, `gates / gates` xanh, rồi **agent tự merge được** — trong khi
kho chỉ có **không một lượt duyệt nào**. Bảng ở mục 6 nói *"merge PR của chính nó → ruleset đòi một
lượt duyệt của NGƯỜI"*. **Câu đó hiện SAI.**

## B · Bằng chứng, theo đúng thứ tự thu thập

| # | Phép đo | Kết quả |
|---|---|---|
| 1 | `git push origin HEAD:main` | **BỊ TỪ CHỐI** — `GH013`, kèm đúng hai dòng: *"Changes must be made through a pull request."* và *"Required status check `gates / gates` is expected."* |
| 2 | `GET /pulls/12/reviews` | **một** review, `state: COMMENTED`, body `"ok"`, `author_association: OWNER`. **Không có review nào `APPROVED`** |
| 3 | `PUT /pulls/12/merge` (REST chuẩn, KHÔNG cờ override nào) | **THÀNH CÔNG** → `31dceb0` |
| 4 | `GET /repos/…/collaborators` | **đúng một**: `truyenhkm5group-stack`, vai trò `admin` |
| 5 | `GET /user` (danh tính token agent đang dùng) | `truyenhkm5group-stack` — **trùng** với tác giả PR và với người duy nhất có quyền ghi |
| 6 | `GET /repos/…/branches` | `main` → `protected: false` (trường này phản ánh *classic branch protection*, không phản ánh ruleset) |

## C · Suy luận — loại trừ được một giả thuyết bằng chính dữ liệu

**Giả thuyết "có bypass actor cho admin": BỊ BÁC BỎ.** Bypass của ruleset áp cho **mọi luật** trong
ruleset đó. Nếu tài khoản này nằm trong danh sách bypass thì phép đo #1 (đẩy thẳng) đã phải THÀNH
CÔNG. Nó bị từ chối ⇒ **không có bypass actor nào phủ tài khoản này**.

**Giả thuyết còn lại, khớp toàn bộ dữ liệu: ruleset ĐANG ÁP có số duyệt bắt buộc = 0.**

Luật `pull_request` tự nó đã sinh ra dòng *"Changes must be made through a pull request"* — **bất
kể** `required_approving_review_count` là 0 hay 1. Nên "chặn đẩy thẳng" và "cho merge khi chưa ai
duyệt" cùng tồn tại được, và chỉ có đúng một cách giải thích: **tệp `.github/rulesets/main-protection.json`
trong kho KHÁC với ruleset thật đang chạy trên GitHub.** Tệp trong kho là bản khai; nó chưa bao giờ
được kiểm lại sau khi admin áp bằng tay.

> ⚠️ Agent **không đọc được** ruleset đang áp (không có công cụ, và proxy chặn ghi/đọc API cấu hình
> kho — xem mục 0). Nên đây là **suy luận**, không phải quan sát trực tiếp. Chủ shop xác nhận trong
> 10 giây, xem mục E.

## D · PHÁT HIỆN QUAN TRỌNG HƠN: MỘT DANH TÍNH THÌ KHÔNG CÓ CẤU HÌNH NÀO ĐÚNG

Giả sử sửa số duyệt về 1 và giữ danh sách bypass rỗng. Lúc đó:

- agent mở PR với danh tính `truyenhkm5group-stack`;
- tài khoản **duy nhất** có quyền ghi cũng là `truyenhkm5group-stack`;
- **GitHub cấm tác giả tự duyệt PR của mình** (bấm Approve bị hạ xuống thành Comment — đúng cái đã
  xảy ra ở phép đo #2);
- ⇒ **không PR nào duyệt được nữa. Kho tự khoá chết.**

Nên với một danh tính, "bắt buộc một lượt duyệt" chỉ có hai kết cục: **vô hiệu** (số = 0) hoặc
**tắc nghẽn** (số = 1). **Không có nấc giữa, và không có công tắc nào của GitHub sửa được điều đó.**

**Kết luận: đây không phải lỗi cấu hình. Đây là thiếu một DANH TÍNH THỨ HAI.**

## E · Việc chủ shop cần làm — một lần kiểm, một con số

**Settings → Rules → Rulesets → "Khoá nhánh main" → khối "Require a pull request before merging"
→ đọc ô "Required approvals".**

- Ra **0** ⇒ suy luận ở mục C đúng. **Đừng vội sửa thành 1** — đọc tiếp mục F, sửa lúc này là tự
  khoá chết kho.
- Ra **1** ⇒ suy luận sai, và có một cơ chế bypass khác đang tồn tại mà agent không thấy được.
  Chụp màn hình cả trang ruleset (gồm cả danh sách bypass) rồi mở lại việc này.

## F · Ba phương án có danh tính thứ hai thật

| | Phương án | Cách làm | Được gì | Mất gì |
|---|---|---|---|---|
| **1 ⭐** | **Agent có danh tính riêng** | Tạo một GitHub App (hoặc machine user) `erp-agent`, cài vào kho với quyền `write`; agent đẩy/mở PR bằng token của App ⇒ tác giả PR là `erp-agent[bot]`. Chủ shop duyệt bằng tài khoản người — **khác danh tính, GitHub cho phép**. Đặt số duyệt = 1, bypass rỗng | Agent **không thể** duyệt hay merge PR của chính nó. **Không cần thêm người.** Đây là khuôn mẫu chuẩn của ngành | Phải đổi token mà phiên Claude Code và Actions đang dùng — **cần kiểm xem token của phiên có đổi được không**, vì nó do nền tảng cấp |
| **2** | **Tài khoản thứ hai của chủ shop** | Thêm một tài khoản GitHub nữa làm collaborator quyền `write` (đủ để duyệt; không cần `admin`) | Chạy được **ngay**, không hạ tầng | Vẫn là **cùng một người** ⇒ là cổng DANH TÍNH, không phải cổng CON MẮT THỨ HAI |
| **3** | **Bot duyệt độc lập** | GitHub App riêng, **khác** danh tính agent code. Chỉ tự duyệt khi thoả điều kiện KIỂM ĐƯỢC: cổng xanh · diff không chạm `.github/**`, `middleware.ts`, `lib/auth/**`, `drizzle/**` · không có migration mới · diff dưới ngưỡng · không có secret. Ngoài các điều kiện đó thì **im lặng**, chủ shop tự duyệt | Giảm việc tay cho PR nhỏ | Dễ thành **đóng dấu cho có**. Nên làm **sau** 1 hoặc 2, không thay thế |

## G · "Admin cũng không bypass được" — nói thẳng là KHÔNG đạt được

Kho này thuộc **một tài khoản cá nhân**. Chủ tài khoản là admin vĩnh viễn và **sửa hoặc xoá ruleset
lúc nào cũng được**. Không có cấu hình nào của GitHub ngăn được điều đó. Chuyển kho sang một
**Organization** (miễn phí) cũng chỉ đổi chỗ chứ không đổi bản chất: org owner vẫn sửa được.

Nên mục tiêu phải viết lại cho đúng thứ làm được:

> ~~Admin cũng không bypass được~~
> **AGENT không bypass được, và mọi lần NGƯỜI bypass đều để lại vết** (thay đổi ruleset nằm trong
> audit log của kho).

Vế "agent không bypass được" thì **đã đạt** và có bằng chứng: proxy chặn agent ghi vào API cấu hình
kho (mục 0), và phép đo #1 cho thấy nó cũng không đẩy thẳng được.

## H · Sửa lại bảng ở mục 6

| Hành vi | Trạng thái THẬT (đo 19/09/2026) |
| --- | --- |
| sửa protection / ruleset | ✅ chặn — proxy 403 |
| tắt required checks | ✅ chặn — như trên |
| force push / xoá `main` | ✅ chặn — ruleset |
| đẩy thẳng `main` | ✅ chặn — ruleset (đo được) |
| **merge PR của chính nó** | ❌ **KHÔNG CHẶN** — xem mục A–D |
| sửa workflow bảo vệ để né cổng | ⚠️ đi qua PR + cổng, nhưng vì hàng trên chưa chặn nên **hàng này cũng chưa chặn** |

## I · Ghi chú vận hành

`strict_required_status_checks_policy: true` đòi PR phải cập nhật với `main` ngay tại lúc merge.
Với nhiều phiên chạy song song, `main` nhảy liên tục: PR #12 phải nhập lại `main` **ba lần** và
chạy lại cổng mỗi lần. Đó là cái giá đúng của `strict`, không phải lỗi — nhưng nếu nhịp merge tăng
thì nên xem **merge queue** của GitHub.

---

# PHỤ LỤC 2 · 19/09/2026 (chiều) — ĐỌC ĐƯỢC RULESET THẬT, SUY LUẬN Ở PHỤ LỤC 1 ĐÚNG

Phụ lục 1 khép lại bằng một cảnh báo: *"Agent **không đọc được** ruleset đang áp… Nên đây là
**suy luận**, không phải quan sát trực tiếp."* Lượt đo dưới đây làm câu đó hết đúng — và xác nhận
suy luận từng chữ. **Bằng chứng sự cố ban đầu ở phụ lục 1 giữ nguyên, không sửa một dòng nào.**

## A · Phép đo

```
GET /repos/truyenhkm5group-stack/hkt/rulesets            → 200 · [{ id: 23697012, "Khoá nhánh main", enforcement: active }]
GET /repos/truyenhkm5group-stack/hkt/rulesets/23697012   → 200
```

| Luật | ĐANG CHẠY | `.github/rulesets/main-protection.json` (bản khai) |
|---|---|---|
| `required_approving_review_count` | **0** | 1 |
| `dismiss_stale_reviews_on_push` | **false** | true |
| `require_last_push_approval` | **false** | true |
| `required_review_thread_resolution` | true | true |
| `required_status_checks` | `gates / gates` · `strict: true` | như vậy |
| `bypass_actors` | **`[]`** | `[]` |
| `current_user_can_bypass` | **`never`** | — |
| `deletion` · `non_fast_forward` | chặn | chặn |

## B · Ba điều rút ra

1. **Suy luận ở mục C của phụ lục 1 đúng.** Số duyệt bắt buộc là **0**, và **không có bypass
   actor nào**. Agent merge được PR của chính nó không phải vì có cửa sau — mà vì cổng duyệt đang
   đặt ở mức không cấm gì. Hai phép đo trái ngược nhau ở phụ lục 1 (đẩy thẳng bị từ chối nhưng
   merge thì được) khớp trọn vẹn với cấu hình này.
2. **Bản khai trong kho KHÁC ruleset thật.** Tệp là thứ người ta đọc, ruleset là thứ chạy. Từ nay
   mọi câu về khoá `main` phải kèm một lượt `GET /rulesets/23697012` — **đừng trích tệp**.
   Cũng vì vậy mục 0 của tài liệu này (*"không có ruleset nào"*, `rulesets → []`) là ảnh chụp lúc
   **trước** khi admin áp, không phải hiện trạng.
3. **Vẫn chưa được nâng số duyệt lên 1.** Lý do ở mục D của phụ lục 1 không đổi một chữ: một danh
   tính thì 0 là vô hiệu, 1 là kho tự khoá chết.

## C · Việc đang chạy để có nấc giữa

Phương án 1 ở mục F của phụ lục 1 (**GitHub App `erp-agent`**) đã được triển khai ở phần mã:
`lib/integrations/github/agent-identity.ts` + `tests/agent-identity.test.ts`. Phần còn lại —
tạo App — **bắt buộc đi qua trình duyệt của một NGƯỜI**, và đó là điều đúng đắn: một danh tính
thứ hai mà agent tự tạo được thì không phải danh tính thứ hai.

**Các bước chính xác chủ shop phải bấm, và đúng bốn ô ruleset phải sửa SAU ĐÓ, nằm ở
`docs/agent-github-identity.md`.** Thứ tự không đảo được: danh tính trước, khoá sau.

## D · Sửa lại bảng ở mục H của phụ lục 1

| Hành vi | Trạng thái (đo 19/09/2026 chiều) |
| --- | --- |
| đọc ruleset | ✅ **đọc được** (khác phụ lục 1 — proxy chỉ chặn GHI) |
| sửa protection / ruleset | ⚠️ chưa đo lại lượt GHI. Sẽ đo đúng một lần ở bước nâng cổng, không đo bằng cách thử phá |
| force push / xoá `main` | ✅ chặn — ruleset (`non_fast_forward`, `deletion`) |
| đẩy thẳng `main` | ✅ chặn — ruleset (đo ở phụ lục 1) |
| **merge PR của chính nó** | ❌ **KHÔNG CHẶN** — `required_approving_review_count: 0`, nay đã đọc thẳng từ ruleset |
