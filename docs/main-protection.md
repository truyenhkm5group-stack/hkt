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
