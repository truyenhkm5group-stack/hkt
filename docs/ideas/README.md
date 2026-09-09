# Sổ ý tưởng — cách làm việc trên ERP

Nơi ghi các **ý tưởng về chính hệ thống ERP** (cách làm, quy trình, công cụ) trước khi bắt tay
làm. Đây **không phải** module *Ý tưởng marketing* trong ứng dụng (`/ideas` — ý tưởng nội dung do
marketer đăng); sổ này nằm trong kho mã, dành cho người làm ERP.

Vì sao phải ghi: một ý tưởng nói miệng thì hai tuần sau không ai nhớ **vì sao** lại làm như thế,
và người kế tiếp sẽ làm khác đi. Ghi lại thì lý do đi cùng cách làm.

## Danh sách

| # | Ý tưởng | Trạng thái | Ghi |
|---|---|---|---|
| [0001](0001-ban-localhost-truoc-khi-len-erp.md) | Dựng **bản test trên máy (localhost)** trước, thử tận mắt rồi mới đưa lên ERP thật | Đã làm — `npm run local` | 09/09/2026 |

## Thêm một mục mới

1. Tạo tệp `docs/ideas/<số thứ tự>-<tên-không-dấu>.md`, chép khung dưới đây.
2. Thêm một dòng vào bảng trên.
3. Ý tưởng đã làm xong thì đổi trạng thái và trỏ tới lệnh / tệp mã thực hiện nó — người đọc sau
   cần đi từ ý tưởng tới mã, không phải đi tìm.

```markdown
# <số>. <Tên ý tưởng>

- **Người đề xuất / ngày:**
- **Trạng thái:** Mới đề xuất | Đang làm | Đã làm | Bỏ (kèm lý do)

## Vấn đề đang gặp
## Ý tưởng
## Cách làm
## Ranh giới an toàn
## Việc còn lại
```
