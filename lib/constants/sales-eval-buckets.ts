/**
 * MẺ CHẤM PHÂN TẦNG — MƯỜI BỐN NHÓM CÂU PHẢI CÓ MẶT TRONG MẪU.
 *
 * ═══ VÌ SAO KHÔNG LẤY 30 LƯỢT GẦN NHẤT ═══
 *
 * Bảo một người "chấm 30 lượt" thì họ chấm 30 lượt đầu danh sách. Danh sách xếp theo thời gian,
 * nên 30 lượt ấy gần như chắc chắn cùng một loại câu hỏi — chấm xong vẫn không biết máy xử lý
 * khiếu nại ra sao, vì trong mẫu không có ca nào. Đó là cách tốn công nhất để KHÔNG biết thêm gì.
 *
 * Mười bốn nhóm dưới đây không phải mười bốn cách chia một tập; chúng là mười bốn CÂU HỎI KHÁC
 * NHAU về máy, và mỗi câu hỏi sai theo một kiểu riêng:
 *
 *   · Nhóm HIỂU CÂU (giá · màu · size · chọn mẫu · ý muốn mua) hỏng thì máy trả lời lạc đề.
 *   · Nhóm VA CHẠM TIẾNG VIỆT (xác nhận `vâng` · màu `vàng`) hỏng thì máy CHỐT MỘT ĐƠN KHÁCH
 *     CHƯA ĐỒNG Ý — đã đo được một lỗi đúng dạng này ngày 19/09/2026, nên nhóm này không bao giờ
 *     được bỏ khỏi mẫu dù nó hiếm.
 *   · Nhóm GIỮ TRẠNG THÁI (đổi màu / đổi size) hỏng thì lựa chọn cũ bị nuốt mất giữa cuộc bán.
 *   · Nhóm LẤY DỮ KIỆN (SĐT · địa chỉ) hỏng thì đơn thiếu điều kiện mà không ai biết vì sao.
 *   · Nhóm PHẢI VỀ TAY NGƯỜI (khiếu nại · giao hàng · đổi trả) hỏng thì máy tự xử việc nó không
 *     được phép xử.
 *   · Nhóm CHƯA RÕ MẪU hỏng thì máy báo giá cho một sản phẩm nó chưa nhận ra.
 *   · Nhóm CHUYỂN NGƯỜI trả lời một câu khác hẳn: máy gọi người ĐÚNG LÚC hay gọi bừa?
 *
 * ═══ NHÓM LÀ MỘT CÂU HỎI, KHÔNG PHẢI MỘT BỘ LỌC ═══
 *
 * `matcher` là SQL đọc được, cố ý viết bằng chữ khách gõ chứ không bằng nhãn ý định của chính máy.
 * Lấy nhãn của máy ra làm rổ để chấm máy là vòng tròn: một lượt máy đọc nhầm ý định sẽ rơi vào
 * nhóm sai, và nhóm ĐÚNG sẽ trông như không có ca nào — đúng lỗi mà phép chấm này sinh ra để bắt.
 *
 * Ngoại lệ DUY NHẤT là nhóm `HANDOFF`: ở đó câu hỏi CHÍNH LÀ "máy quyết định chuyển người có
 * đúng không", nên hành động của máy là thứ định nghĩa rổ, không phải chữ của khách.
 *
 * ═══ MỘT LƯỢT ĐƯỢC NẰM Ở NHIỀU NHÓM ═══
 *
 * "Lấy cho chị màu đỏ size XL" vừa là chọn mẫu vừa là ý muốn mua. Ép mỗi lượt vào đúng một nhóm
 * thì phải chọn bừa một nhóm, và nhóm còn lại mất một ca đáng chấm. Nên các nhóm CỐ Ý KHÔNG phân
 * hoạch — tổng số ca của các nhóm LỚN HƠN số ca trong mẻ, và màn hình phải nói ra điều đó thay vì
 * in một dòng tổng gây hiểu nhầm.
 */
export type EvalBucketKey =
  | "PRICE"
  | "COLOR_ASK"
  | "SIZE_ASK"
  | "VARIANT_PICK"
  | "PURCHASE_INTENT"
  | "CONFIRM_VANG"
  | "COLOR_VANG"
  | "CHANGE_CHOICE"
  | "CONTACT"
  | "COMPLAINT"
  | "DELIVERY"
  | "RETURN_EXCHANGE"
  | "UNKNOWN_PRODUCT"
  | "HANDOFF";

export type EvalBucket = {
  key: EvalBucketKey;
  label: string;
  /** Câu hỏi về MÁY mà nhóm này trả lời — in ra màn hình để người chấm biết đang tìm gì. */
  question: string;
  /** Hỏng ở nhóm này thì hậu quả là gì. Đây là thứ quyết định nhóm nào phải có mặt bằng mọi giá. */
  risk: string;
  /** Số ca tối thiểu nên có trong mẻ. Tổng các số này là sàn của cỡ mẫu. */
  min: number;
};

export const EVAL_BUCKETS: EvalBucket[] = [
  { key: "PRICE", label: "Hỏi giá", question: "Máy có báo đúng ba con số (đơn giá · phí ship · tổng) không?", risk: "Báo sai giá là hứa một con số shop không bán", min: 3 },
  { key: "COLOR_ASK", label: "Hỏi màu", question: "Máy có kể đúng những màu ERP thật sự có không?", risk: "Kể một màu không tồn tại là hẹn giao thứ không có", min: 3 },
  { key: "SIZE_ASK", label: "Hỏi size", question: "Chưa có bảng số đo thì máy có chịu chuyển người không?", risk: "Đoán size là gửi đi một kiện hàng không vừa", min: 3 },
  { key: "VARIANT_PICK", label: "Chọn mẫu mã", question: "Khách nói màu + size thì máy có chốt đúng mẫu mã không?", risk: "Chốt nhầm mẫu mã là giao sai hàng", min: 3 },
  { key: "PURCHASE_INTENT", label: "Ý muốn mua", question: "Máy có nhận ra khách đang muốn mua và đi tiếp không?", risk: "Không nhận ra là hỏi lại thứ khách vừa nói, khách bỏ đi", min: 3 },
  { key: "CONFIRM_VANG", label: "Xác nhận · chữ “vâng”", question: "“vâng” có được hiểu là đồng ý, và CHỈ khi có bản chốt đã gửi?", risk: "Nhận nhầm là chốt một đơn khách chưa đồng ý", min: 2 },
  { key: "COLOR_VANG", label: "Va chạm · màu “vàng”", question: "“vàng” có bị đọc thành lời đồng ý không?", risk: "ĐÃ ĐO ĐƯỢC 19/09: đúng va chạm này từng chốt được đơn", min: 2 },
  { key: "CHANGE_CHOICE", label: "Đổi màu / đổi size", question: "Lựa chọn MỚI có thắng lựa chọn cũ, và cũ có bị nuốt mất không?", risk: "Giữ nhầm lựa chọn cũ là giao đúng thứ khách vừa từ chối", min: 3 },
  { key: "CONTACT", label: "SĐT / địa chỉ", question: "Máy có nhận đúng số và địa chỉ, không bịa thêm phần thiếu?", risk: "Thiếu hoặc sai là đơn không giao được", min: 3 },
  { key: "COMPLAINT", label: "Khiếu nại", question: "Máy có dừng lại và gọi người không?", risk: "Máy tự thương lượng khiếu nại là việc nó không được phép làm", min: 2 },
  { key: "DELIVERY", label: "Hỏi giao hàng", question: "Việc sau bán có được chuyển đúng phòng không?", risk: "Sai lý do thì việc chạy nhầm phòng và nằm nhầm ô báo cáo", min: 2 },
  { key: "RETURN_EXCHANGE", label: "Đổi / trả", question: "Máy có hứa chính sách đổi trả nào ERP chưa khai không?", risk: "Hứa một chính sách không có là cam kết shop phải gánh", min: 2 },
  { key: "UNKNOWN_PRODUCT", label: "Chưa rõ mẫu nào", question: "Chưa nhận ra mẫu thì máy có nhịn báo giá không?", risk: "Báo giá cho một mẫu chưa nhận ra là nói bừa", min: 3 },
  { key: "HANDOFF", label: "Máy chuyển người", question: "Gọi người ĐÚNG LÚC, hay gọi bừa vì không chắc?", risk: "Gọi bừa thì người gánh hết; gọi muộn thì khách đã đi", min: 4 },
];

/** Sàn cỡ mẫu suy ra từ chính sổ nhóm, không gõ lại — gõ lại là mở đường cho hai nơi nói hai số. */
export const EVAL_BATCH_MIN = EVAL_BUCKETS.reduce((a, b) => a + b.min, 0);

/** Trần cỡ mẻ. Trên 50 thì người chấm bỏ dở, và một mẻ bỏ dở không nói được gì. */
export const EVAL_BATCH_MAX = 50;

export const EVAL_BUCKET_LABEL: Record<EvalBucketKey, string> = Object.fromEntries(
  EVAL_BUCKETS.map((b) => [b.key, b.label]),
) as Record<EvalBucketKey, string>;
