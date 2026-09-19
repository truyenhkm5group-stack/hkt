# Thu hồi phiên từ phía máy chủ

*19/09/2026. Issue #17. Đi sau bản gia hạn trượt (#12) và **phụ thuộc vào nó** — xem mục 2.*

## 1 · Cái đang hỏng

Đổi mật khẩu **không** làm token cũ chết. Ai đang cầm cookie thì dùng tiếp tới khi hết hạn: tối đa
7 ngày kể từ lần dùng gần nhất, và tối đa 30 ngày kể từ lần đăng nhập nếu phiên được gia hạn trượt.

Nghĩa là việc đổi mật khẩu **vì nghi bị lộ** — đúng tình huống duy nhất người ta đổi mật khẩu gấp —
không có tác dụng gì. Và không có gì trên màn hình nói cho người dùng biết điều đó; trang
`/settings/profile` còn ghi ngược lại: *"Các phiên đăng nhập khác vẫn còn hiệu lực tới khi hết hạn
(7 ngày)"*, như thể đó là một thiết kế chứ không phải một lỗ hổng.

Không có đường nào để một người tự đá mình ra khỏi một máy đã quên đăng xuất, và không có đường nào
để quản trị làm việc đó hộ.

## 2 · Luật: so với `lgn`, KHÔNG BAO GIỜ so với `iat`

```
users.session_invalid_before  timestamptz NULL     -- mốc CHỈ TIẾN, không bao giờ lùi

hợp lệ ⟺ users.active
       ∧ (session_invalid_before IS NULL OR lgn > session_invalid_before)
```

Đây là chỗ cả tính năng sống hoặc chết im lặng.

Gia hạn trượt **ký lại token và đẩy `iat` lên ở mỗi lượt GET**. Nếu luật so mốc thu hồi với `iat`
thì một phiên vừa bị thu hồi sẽ **tự sống lại ở lượt tải trang kế tiếp** — tính năng trông như
đang chạy, nút bấm được, nhật ký có dòng, và không có gì báo rằng nó không làm gì cả.

`lgn` (mốc đăng nhập **gốc**) đi nguyên vẹn qua mọi lần gia hạn, nên nó là mốc duy nhất dùng được.
`tests/session-revocation.test.ts` chạy `middleware()` **thật**, lấy cookie nó trả ra, rồi khẳng
định cả hai vế: phiếu vừa ký lại **vẫn bị từ chối** theo `lgn`, và **đã sống lại** nếu so theo
`iat`. Vế thứ hai là bằng chứng chứ không phải trang trí — nó bắt được ngay ngày ai đó "dọn dẹp".

## 3 · Ai thu hồi, ai không

| Sự kiện | Thu hồi? | Vì sao |
| --- | --- | --- |
| **Đổi mật khẩu** (tự đổi) | ✅ bắt buộc | Lý do tồn tại của cả tính năng. Thu hồi **toàn bộ**, kể cả phiên đang dùng |
| **Đặt lại mật khẩu** (quản trị) | ✅ bắt buộc | Như trên, cho tài khoản đích |
| **Đăng xuất mọi thiết bị** | ✅ | Người dùng tự bấm. Đá luôn máy đang dùng — xem mục 4 |
| **Quản trị thu hồi phiên** | ✅ | Công cụ cho "máy bị mất, tài khoản vẫn tốt". **Bắt buộc ghi lý do** |
| **Khoá tài khoản** | ✅ | Dư cho hôm nay (`active=false` đã chặn), cần cho **ngày mở khoá lại**: không đẩy mốc thì token cũ sống lại nguyên vẹn lúc mở khoá |
| **Đổi vai trò / quyền / phạm vi** | ❌ **không** | Quyền đã nạp lại từ CSDL ở **mọi** lượt gọi. Thu hồi ở đây là đá cả đội ra vì một lần sửa nhãn — và dạy họ bỏ qua thông báo phiên |
| **Đăng xuất thường** | ❌ **không** | Chỉ xoá cookie máy này. Máy khác không liên quan |

Hai hàng cuối được khoá ở **mức mã nguồn**: bài kiểm đọc thân từng hàm và khẳng định
`applySessionRevocation` **không** xuất hiện trong `logoutAction`, `updateUserPermissions`,
`saveRolePermissions` — và **có** xuất hiện trong bốn hàm phải có. Một lời gọi thừa lọt vào đây thì
không bài kiểm hành vi nào bắt được: mọi thứ vẫn "chạy".

## 4 · "Đăng xuất mọi thiết bị" đá luôn máy đang dùng

Cố ý. "Mọi token cũ" mà chừa lại đúng cái đang cầm thì không còn là một câu nói được nữa, và khe hở
ấy chính là chỗ một phiên vừa bị thu hồi được cấp phép lại. Hộp thoại nói trước điều đó bằng chữ
đậm; đổi mật khẩu thì máy chủ xoá cookie ngay và đưa người dùng về `/login` với **câu riêng** —
*"Đã đổi mật khẩu. Hãy đăng nhập lại bằng mật khẩu mới."* — chứ không phải câu "phiên đã bị thu
hồi", vốn đọc lên như thể có ai khác vừa can thiệp.

## 5 · Mốc chỉ tiến, khoá ở hai tầng

```sql
SET session_invalid_before = GREATEST(COALESCE(session_invalid_before, 'epoch'::timestamptz), <mốc>)
```

Gán thẳng `= now()` để ngỏ khả năng một lượt ghi tới muộn (đồng hồ lệch, giao dịch chậm) **kéo mốc
lùi lại** — tức là **gỡ thu hồi**. Đó là lỗi an ninh im lặng nhất trong cả thiết kế: hệ thống vẫn
chạy bình thường sau đó.

Nên luật nằm ở **cả hai** tầng: `GREATEST` trong câu lệnh của ứng dụng, và một trigger `BEFORE
UPDATE` trong migration `0106` cho những câu `UPDATE` gõ tay ở ops. Trigger cũng chặn việc đặt cột
về `NULL` — xoá mốc cũng là gỡ thu hồi. Bài kiểm chứng minh cả hai đường.

**Mốc làm tròn LÊN tới giây.** `lgn` chỉ có độ phân giải giây, nên một lần đăng nhập xảy ra *sau*
lượt thu hồi nhưng trong *cùng một giây* không phân biệt được với một phiên cũ. Làm tròn lên biến
sự mơ hồ đó thành một hướng duy nhất và an toàn: mọi phiên của giây đang diễn ra đều chết. Cái giá
tối đa là người vừa bị thu hồi phải bấm đăng nhập lại một lần nữa nếu họ thao tác trong cùng giây
ấy. Chiều ngược lại — để lọt một phiên đáng lẽ đã chết — không được phép đánh đổi.

## 6 · Ba nguyên nhân từ chối, ba câu — và một vòng lặp suýt xảy ra

`getCurrentUser()` trả `null` cho **hai** nguyên nhân khác hẳn nhau, và sau bản này là **ba**. Cả
ba trước đây đều ra `/login?reason=inactive`, tức là **nói với một nhân viên rằng tài khoản họ bị
khoá trong khi tài khoản hoàn toàn bình thường** — họ sẽ đi gọi quản trị.

| Nguyên nhân | `?reason=` | Câu hiện ra |
| --- | --- | --- |
| không tìm thấy tài khoản | `invalid` | Phiên đăng nhập không hợp lệ |
| `active = false` | `inactive` | Tài khoản đã bị khoá |
| phiên bị thu hồi | `revoked` | Phiên đăng nhập đã bị thu hồi |

> ⚠️ **Một vòng lặp chuyển hướng, phát hiện khi đọc mã chứ không phải khi chạy.**
> `/login` gọi `getSession()` — hàm này chỉ kiểm **chữ ký** và **hạn**, nó không biết gì về CSDL.
> Một phiên bị thu hồi vẫn có cookie ký đúng và còn hạn, nên `getSession()` trả về một phiên trông
> hợp lệ. Điều kiện cũ (`params.reason !== "inactive"`) sẽ đẩy người dùng vào trong → trang đó gọi
> `requireUser()` → bị từ chối → đẩy ngược ra `/login` → **lặp vô tận**, trình duyệt báo
> `ERR_TOO_MANY_REDIRECTS`, và người dùng **mất hẳn đường đăng nhập lại**.
>
> Sửa bằng `loginShouldStay()` đọc một danh sách dùng chung. Thêm một lý do từ chối mới thì thêm
> vào danh sách, không sửa điều kiện ở trang.

## 7 · Kiến trúc: Edge vẫn không đọc CSDL

Middleware giữ nguyên — nó chạy ở Edge và `tests/session-renewal.test.ts` quét mã nguồn để chặn
việc đưa `@/db` vào đó.

**Hệ quả phải chấp nhận và ghi rõ: middleware VẪN gia hạn cookie của một phiên đã bị thu hồi.** Vô
hại: mọi màn hình và mọi API đều đi qua `resolveCurrentUser()`, và hàm đó từ chối. Đây đúng là mô
hình đang chạy cho `users.active` từ trước, không phải một khái niệm mới.

**Không** đưa mốc thu hồi vào token: token chính là thứ đang bị thu hồi.

**Không** đưa cột này vào bất kỳ `memo()` nào. Một cửa sổ đệm 60 giây là 60 giây mà token đã thu
hồi vẫn dùng được — lúc đó nó không còn là thu hồi nữa. Bài kiểm quét mã nguồn để giữ điều này.

Cột đi **cùng lượt tra người dùng đã có sẵn** trong `resolveCurrentUser()`, nên bản này **không
thêm một câu truy vấn nào** cho mỗi lần dựng trang.

## 8 · Nhật ký

Mỗi lượt thu hồi ghi **một** dòng `audit_logs`, `action = SESSION_REVOKE`, mang khoá tài khoản của
**người bấm** (luật 34), kèm `before → after` và `trigger`. Thiếu `before/after` thì không phân
biệt được lần thu hồi **đầu** với lần thu hồi **lại**.

`ADMIN_REVOKE` **bắt buộc có lý do**, chặn ở **hai** lớp: lược đồ zod của server action, và
`applySessionRevocation()` ở tầng dịch vụ — để một đường gọi mới (job, script) không đi qua zod vẫn
gặp cùng luật. Lượt bị từ chối **không ghi gì và không đụng vào mốc**: một thao tác đã thất bại mà
vẫn đá người ta ra là tệ hơn cả không có tính năng.

## 9 · Migration và lùi bản

- `0106_session_revocation` — **chỉ cộng thêm**: một cột nullable + một trigger. Không backfill
  (luật 35), không default. Cột `NULL` = **chưa từng thu hồi** ⇒ mọi tài khoản đang chạy giữ nguyên
  hành vi hôm nay.
- **Lùi bản = deploy lại image cũ.** Cột đơn giản không được đọc. Không mất dữ liệu, không cần
  migration ngược. Đây là kiểu thay đổi CSDL an toàn nhất có thể.

## 10 · Phép kiểm `I` của `session-verify` đo được gì — và không đo được gì

**Đo được:** migration `0106` đã áp trên máy chủ; luật *chỉ tiến* không bị vi phạm ở bất kỳ dòng
nào đang có; mỗi lượt thu hồi đã xảy ra đều có dòng nhật ký; và với tài khoản đã bị thu hồi, một
phiếu phiên cũ thật sự bị luật từ chối.

**KHÔNG đo được:** *"thu hồi có chặn được một lượt gọi thật trên production hay không"*. Câu đó chỉ
trả lời được bằng cách **ghi** vào CSDL production, mà script này chỉ đọc và kho không có tài khoản
QA riêng. Một dấu ✓ ở phép `I` **không** phải bằng chứng cho vế đó, và tài liệu nói thẳng như vậy
thay vì để con số 12/12 trông đầy đủ hơn sự thật.

**Xác minh tay, 4 bước** (chủ shop, sau khi deploy):

1. Đăng nhập trên **hai** trình duyệt khác nhau bằng cùng tài khoản.
2. Trình duyệt A: `/settings/profile` → **Đăng xuất mọi thiết bị**.
3. Trình duyệt B: tải lại một trang bất kỳ → phải ra `/login?reason=revoked` với câu *"Phiên đăng
   nhập đã bị thu hồi"*. **Không** được là vòng lặp chuyển hướng.
4. Đăng nhập lại ở cả hai → phải vào được **ngay**, không phải đợi gì.
