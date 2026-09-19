# Phiên trượt (sliding session) — thiết kế và rà soát an ninh

**Ngày:** 19/09/2026 · **Phạm vi:** toàn ERP (mọi trang, mọi route `/api/*`) · **Migration:** KHÔNG có

## 1. Sự cố đang chữa

Token phiên ký cứng 7 ngày tính từ lúc đăng nhập và **không bao giờ được gia hạn**
(`createSession` chỉ chạy ở `loginAction`). Đúng 7 ngày sau mỗi lần đăng nhập, giữa giờ làm, chuỗi
sau chạy mà người dùng không chạm vào gì:

```
token hết hạn → /api/events trả 401 → SSE chết
              → realtime-provider: mỗi 5 phút, nếu SSE đứt và tab đang hiện → router.refresh()
              → middleware thấy token hỏng → 307 → /login
```

Người dùng **bị một đồng hồ nền đá ra**, mất thứ đang gõ dở. Mốc là **xác định**, không ngẫu nhiên.

## 2. Thiết kế: hai đồng hồ, không gộp

| Đồng hồ | Hằng số | Hành vi | Trả lời câu |
|---|---|---|---|
| Nghỉ | `SESSION_IDLE_DAYS = 7` | **TRƯỢT** — mỗi lượt dùng thật đẩy lùi | "không dùng bao lâu thì phải đăng nhập lại" |
| Sống | `SESSION_ABSOLUTE_DAYS = 30` | **CỨNG** — tính từ đăng nhập gốc, không bao giờ trượt | "dù chăm tới đâu, bao lâu thì phải nhập lại mật khẩu" |

Chỉ có đồng hồ nghỉ ⇒ cookie bị lấy cắp sống mãi (gọi một trang mỗi tuần là đủ). Chỉ có đồng hồ
sống ⇒ đúng bệnh đang phải chữa. **Phải có cả hai.**

Mốc đăng nhập gốc đi trong claim `lgn`, tách khỏi `iat` (`iat` bị đẩy lên sau mỗi lần gia hạn).

**Luật quyết định** là hàm THUẦN `decideRenewal(claims, nowSec)` trong `lib/constants/session.ts` —
tệp không import gì, nên Edge (middleware) và Node (server action) nạp **cùng một bản**. Bốn lý do
từ chối, không gộp: `NO_TOKEN` · `EXPIRED` · `TOO_EARLY` · `AT_ABSOLUTE_CAP`.

Gia hạn khi token đã qua **nửa đời** (`SESSION_RENEW_AFTER_FRACTION = 0.5`). Hệ quả đo được trong
bài kiểm: người mở ERP mỗi ngày suốt 60 ngày chỉ tốn **≤ 20 chữ ký**, không phải một chữ ký cho
mỗi lượt hỏi chuông (30 giây/lần ≈ 172.800 lượt).

## 3. Vì sao gia hạn nằm ở middleware

Cookie chỉ ghi được ở Server Action, Route Handler hoặc middleware — **không** ghi được trong lúc
dựng trang, mà dựng trang lại là thứ người dùng làm cả ngày. Middleware là chỗ duy nhất thấy **mọi**
lượt gọi (điều hướng, `/api/events`, `/api/notifications`) nên nó gia hạn được mà không cần bắt
trình duyệt gọi thêm một địa chỉ riêng.

**Chỉ GET/HEAD.** Một lượt POST có thể là `logoutAction`, và hàm đó **xoá** cookie. Middleware ghi
cookie trên cùng phản hồi ⇒ hai lệnh `Set-Cookie` đua nhau ⇒ "đăng xuất thỉnh thoảng không ăn", một
lỗi an ninh chứ không phải lỗi giao diện. Bỏ POST không mất gì: ai cũng GET trước khi POST, và cả
hai bộ đếm nền đều là GET.

## 4. Rà soát an ninh

| Mặt | Trước | Sau | Kết luận |
|---|---|---|---|
| Khoá ký | HS256, `AUTH_SECRET`, production thiếu ⇒ app dừng | không đổi | — |
| Nội dung token | `sub · email · name · role` | thêm `lgn` (một mốc thời gian) | không lộ thêm gì; JWT vốn đọc được bởi người cầm nó |
| Cờ cookie | `httpOnly · sameSite=lax · secure(prod+https) · path=/` | y hệt, **cộng** lưới an toàn: đang chạy trên `https:` thì luôn `secure` | **tốt hơn** |
| `Max-Age` vs `exp` | cùng 7 ngày | cùng suy từ một `expiresAtSec` | không lệch được |
| Khoá tài khoản | `getCurrentUser()` tra CSDL mỗi lượt, `active=false` ⇒ từ chối ngay | **không đổi** | có hiệu lực ngay, không đợi phiên hết hạn |
| Đổi quyền / vai trò | nạp lại từ CSDL mỗi lượt; vai trò trong token chỉ để hiển thị | **không đổi** | gia hạn không đóng băng quyền cũ |
| Đăng xuất | xoá cookie | **không đổi** + middleware không bao giờ gia hạn trên POST | không bị ghi đè |
| Giả mạo `lgn` | — | `lgn` lấy từ payload **đã xác minh chữ ký** | không tự dời trần được nếu không có khoá ký |
| CSRF | `sameSite=lax` | không đổi | lax không gửi cookie cho subresource; một điều hướng chéo trang chỉ làm phiên của chính nạn nhân dài thêm — không phải leo thang |
| Đường công khai | webhook / health / sync bỏ qua middleware | không đổi, và **không cấp phiên** | có bài kiểm |
| Middleware đọc CSDL | không | vẫn không (Edge) | có bài kiểm quét mã nguồn |

### Một điểm YẾU ĐI, nói thẳng

**Cửa sổ sống của một cookie bị lấy cắp: 7 ngày → tối đa 30 ngày.**

Đây là cái giá trực tiếp của việc gia hạn, và nó bị chặn bởi trần tuyệt đối — không có đường nào
kéo dài quá `lgn + 30 ngày`. Các đường phòng thủ còn lại **không đổi**: khoá tài khoản có hiệu lực
ngay lập tức ở mọi màn hình và mọi API; đổi mật khẩu + khoá tài khoản vẫn là cách chặn tức thì.

**Chưa làm, và cần chủ shop quyết:** ERP hiện **không có** thu hồi phiên phía máy chủ — đăng xuất
chỉ xoá cookie của chính trình duyệt đó, một bản sao token vẫn sống tới hạn. Điều này **đã đúng từ
trước bản này**, nhưng nay cửa sổ rộng hơn. Bản vá đầy đủ là thêm một cột
`users.session_invalid_before` (migration nhỏ, cộng thêm, không phá dữ liệu) và một nút
**"Đăng xuất mọi thiết bị"**. Nó đổi ngữ nghĩa nút Đăng xuất hiện tại (đăng xuất ở máy tính sẽ
đá luôn điện thoại), nên tôi **không tự làm** — xem mục 6.

## 5. Tương thích ngược

Token đang nằm trong trình duyệt nhân viên lúc triển khai **không có** claim `lgn`. `claimsFrom()`
lấy `iat` thay thế — với chúng thì `iat` **đúng là** mốc đăng nhập, vì hồi ấy chưa có lần gia hạn
nào để đẩy `iat` đi. **Không migration, không ai bị đá ra vì một lần triển khai.**

## 6. Hai con số là quyết định kinh doanh

`SESSION_IDLE_DAYS = 7` và `SESSION_ABSOLUTE_DAYS = 30` là **chính sách an ninh**, không phải hằng
số kỹ thuật. Đổi ở `lib/constants/session.ts` và chỉ ở đó. Hai câu hỏi cho chủ shop:

1. Một tháng đăng nhập lại một lần có chịu được không? (ngắn hơn ⇒ an toàn hơn, phiền hơn)
2. Có muốn nút "Đăng xuất mọi thiết bị" + thu hồi phiên phía máy chủ không? (mục 4)
