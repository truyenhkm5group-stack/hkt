# Nhập danh sách vận đơn VTP có truy nguyên

## Phạm vi bản sửa

Sửa parser, preview và luồng nhập danh sách vận đơn. Chưa thay công thức ORDER_OUTCOME/KPI, chưa chuyển báo cáo sang payment ledger, chưa nhập dữ liệu production. Nhãn Chất lượng dữ liệu phản ánh đúng việc truy vấn hiện vẫn dựa trên COD/prepaid legacy.

## Mapping

| Cột VTP | Cách dùng |
|---|---|
| Mã Vận Đơn | Khóa chính xác với vtp_order_number/tracking_code; mã trùng nhiều shipment cần đối chiếu |
| Mã đơn hàng | Giữ nguyên khi preview và nhập; với hậu tố chiều về dùng để tìm mã gốc, không ghi đè gốc |
| Ngày chuyển trạng thái | Giữ giờ/phút/giây, diễn giải UTC+7; không fallback sang Ngày tạo/giờ nhập |
| Ngày tạo | Lưu riêng trong kết quả phân tích; không dùng làm ngày giao/hoàn |
| Tổng phí (9) | Ưu tiên hơn Cước vận chuyển và Tổng cước; bao gồm thành phần/phụ phí theo định nghĩa file |
| Tiền thu hộ (4) | COD khai báo; không tự ghi cod_collected hoặc verified ledger |
| Trạng thái đối soát COD | Giữ nguyên trong snapshot để đối chiếu; chưa tự chứng nhận thực thu |
| Trạng thái thanh toán | Giữ riêng; không suy thành COD về ngân hàng |
| Đơn chuyển hoàn/chuyển tiếp | Lưu tín hiệu gốc; chưa tự quyết kết quả đơn chỉ từ dấu x |

Ô tiền rỗng là NULL. Tiền âm, tiền lẻ hoặc chuỗi không hợp lệ bị từ chối. Giữ expandSheetRange để đọc đủ file có dimension sai. Chặn dùng danh sách vận đơn như file chi tiết bảng kê COD.

## Luồng ghi

Preview nhiều file và nhập đều đọc lại các file gốc trên server, cùng một hàm merge. Không nhận bản cắt bớt cột từ bảng UI. Cùng mã lấy timestamp mới hơn; cùng thời điểm khác nội dung thì báo xung đột. Giới hạn một lượt dưới 2,5 MB, tối đa 10 file.

Mỗi dòng được xử lý trong transaction và khóa shipment. Bản cũ được lưu lịch sử nhưng không đè trạng thái mới. Timestamp bằng nhau mà stage khác bị giữ lại để đối chiếu. Thiếu ngày, không ghép được mã hoặc trạng thái không biết được trả riêng; không tự tạo vận đơn lẻ chưa ghép. Chiều hoàn nằm ở shipment riêng, order_id NULL và có order_reference gốc.

shipment_events giữ normalized stage, leg, source hash, dòng nguồn, snapshot không chứa tên/SĐT/địa chỉ, actor và kết quả applied/stale/conflict. verification_status là PENDING; các cột xác minh tiền không được ghi. audit_logs có before/snapshot và dấu nguồn trong cùng transaction; audit lỗi rollback dòng đó. Cùng sự kiện nhập lại không nhân lịch sử/audit. Giao dịch theo từng dòng: nếu một lỗi hạ tầng ngắt batch, các dòng trước có thể đã xong; retry được nhờ idempotency và nhật ký, chưa phải transaction nguyên file.

Không sửa cod_status/cod_collected/cod_paid_to_bank_at của dòng hiện có từ danh sách này. COD legacy vốn ghi sai vẫn cần đối soát và sửa có audit sau; không silent backfill.

## API và file

ERP có VTP webhook/polling/partner client nhưng quyền đọc vận đơn phải được kiểm chứng trên tài khoản/hợp đồng thực tế. Tài liệu cũ ghi API đối tác chưa truy cập được vận đơn tạo qua Pancake; đó là kết quả thử trước đây, không đủ để khẳng định mọi API VTP đều không hỗ trợ.

Trước khi bật thêm tự động hóa: kiểm tra quyền đọc một số mã gốc/chiều hoàn và bảng kê COD qua API chính thức; xác thực nguồn webhook, phân trang và thời điểm cập nhật; so sánh với file; giữ request/source reference. Một API trung gian không tự tạo quyền truy cập lịch sử nằm trong tài khoản/hợp đồng khác. Không dùng endpoint suy đoán, token web không chính thức hoặc dịch vụ ngoài chưa được cấp quyền.

Hiện bản sửa hoàn thiện hướng file thủ công. Không đổi lịch sync, không gọi API có ghi production, không thay các writer legacy khác. API và file trong giai đoạn sau phải cùng đi qua lớp quan sát logistics/chứng từ, không tự copy MONEY_COLLECTION hoặc COD khai báo thành thực thu.

## Các bước cần làm trước khi xác nhận KPI đúng

1. Lấy snapshot ERP chỉ đọc, ghép file với shipment/order và xuất danh sách unmatched/conflict/stale; không suy rằng mã ghép được giữa hai file là đã ghép được ERP.
2. Nhập chứng từ COD/bank vào ledger có idempotency, evidence và review completeness. Tách tiền khách trả cho carrier khỏi carrier chuyển về ngân hàng để không đếm tiền hai lần.
3. Đánh giá kết quả tài chính cùng logistics outbound, không coi vận đơn chiều hoàn đã giao là khách đã nhận hàng. Đơn nhận một phần/hoàn một phần cần phân bổ dòng hàng và refund.
4. Chạy rule mới ở shadow mode theo cùng grain và kỳ. Không dùng các biểu thức CASH_COLLECTED/HAS_CASH_PROOF/ORDER_OUTCOME_VERIFIED legacy như bằng chứng ledger; chúng vẫn có fallback.
5. Chỉ chuyển KPI khi đã đối chiếu chênh lệch. Tồn cần mốc kiểm kê/nhập đầu kỳ và nhận hàng hoàn theo số lượng; một phiếu nhập chưa chứng minh toàn bộ tồn đã đầy đủ. Giá vốn kỳ chốt cần được khóa theo chính sách đã thống nhất.

## Kiểm thử

Suite vtp-import-truth sử dụng bố cục VTP và dữ liệu tổng hợp: cột tổng phí, ngày/giờ, missing khác 0, không nhập nhầm bảng kê, gộp file, xung đột cùng timestamp, stale, idempotency, audit, ghép mơ hồ, chiều hoàn và không sinh verified payment. Không đưa file khách hàng hoặc dữ liệu thật vào fixture/repo public.
