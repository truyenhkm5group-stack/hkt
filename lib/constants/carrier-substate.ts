/**
 * ═══════════ HAI CHIỀU ĐỘC LẬP: ĐVVC ĐANG LÀM GÌ, VÀ SHOP ĐANG XỬ LÝ TỚI ĐÂU ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * `shipment_stage` chỉ có mười giá trị và không có chỗ cho ba tình huống khác hẳn nhau:
 *
 *   "Chờ phát lại"  — bưu tá sẽ quay lại. Kiện vẫn đang đi tới khách.
 *   "Chờ xử lý"     — kiện đang nằm chờ một quyết định ở bưu cục.
 *   "Tồn - …"       — có sự cố cụ thể (khách nghỉ, không có nhà…).
 *
 * Cả ba đang bị ép vào `DELIVERY_FAILED` (mã 506/507 khai thẳng như vậy), và tệ hơn: chữ
 * "chờ xử lý" bị luật đọc chữ ép thành `PENDING` — tức *chưa lấy hàng*. Một kiện đã đi được nửa
 * đường bỗng bị xếp cùng nhóm với kiện còn nằm trong kho, rồi biến mất khỏi hàng đợi care.
 *
 * ─── VÌ SAO KHÔNG MỞ RỘNG `shipment_stage` ───
 *
 * Enum đó là hợp đồng của `ORDER_OUTCOME`, của sổ kho, của mọi báo cáo doanh thu. Thêm giá trị
 * vào nó là đụng vào phần đã chốt và đang chạy đúng — và đề bài nói rõ không phá canonical truth.
 *
 * Nên trạng thái con là một tầng DẪN XUẤT, tính từ `vtp_status` + `vtp_status_name` vốn đã được
 * lưu thô. Không cần cột mới, không cần migration, không cần backfill — nó đúng ngay lập tức cho
 * toàn bộ dữ liệu lịch sử, kể cả kiện đồng bộ từ trước.
 *
 * ─── THỨ TỰ CĂN CỨ ───
 *
 *   1. MÃ SỐ chính thức của ĐVVC   (mạnh nhất, không mơ hồ)
 *   2. CHỮ trong tên trạng thái     (chỉ khi không có mã, hoặc mã không nói rõ)
 *   3. KHÔNG RÕ                     — và đây là một câu trả lời hợp lệ
 *
 * Chữ KHÔNG được đè lên mã. Mã 508 "Đơn vị yêu cầu phát tiếp" là đang đi giao, kể cả khi tên
 * trạng thái có chữ "tồn" ở đâu đó.
 */
import type { ShipmentStage } from "@/db/schema";

export const CARRIER_SUBSTATES = [
  "AWAITING_PICKUP",
  "PICKUP_FAILED",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "WAITING_REDELIVERY",
  "WAITING_PROCESSING",
  "DELIVERY_EXCEPTION",
  "DELIVERED",
  "RETURNING",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
] as const;
export type CarrierSubstate = (typeof CARRIER_SUBSTATES)[number];

export const CARRIER_SUBSTATE_LABEL: Record<CarrierSubstate, string> = {
  AWAITING_PICKUP: "Chờ lấy hàng",
  PICKUP_FAILED: "Lấy hàng không thành công",
  PICKED_UP: "Đã lấy hàng",
  IN_TRANSIT: "Đang vận chuyển",
  OUT_FOR_DELIVERY: "Đang đi giao",
  WAITING_REDELIVERY: "Chờ phát lại",
  WAITING_PROCESSING: "Chờ xử lý",
  DELIVERY_EXCEPTION: "Tồn / giao gặp sự cố",
  DELIVERED: "Đã giao",
  RETURNING: "Đang chuyển hoàn",
  RETURNED: "Đã hoàn",
  CANCELLED: "Đã huỷ",
  UNKNOWN: "Chưa rõ",
};

/**
 * ĐÃ CẦM HÀNG CHƯA — BA CÂU TRẢ LỜI, VÌ DỮ LIỆU THẬT CÓ BA.
 *
 * `"AMBIGUOUS"` KHÔNG phải chỗ trống chờ ai đó điền nốt. Đo trên production 13/09/2026:
 * **225 vận đơn mang chữ "chờ xử lý"**, trong đó 169 mang mã **102** — mã thuộc dải 1xx, tức giai
 * đoạn tạo đơn / điều phối bưu tá, hàng còn trong kho — còn **56** thì đã có mốc lấy hàng và có sự
 * kiện hành trình sau đó. Cùng một câu chữ, hai vị trí ngược nhau trong vòng đời.
 *
 * Ép nhóm này về `true` là thổi 169 gói hàng còn nằm trong kho vào cột "đang đi tới khách". Ép về
 * `false` là giấu mất 56 gói đã rời kho. Cả hai đều là một con số sai trông rất hợp lý.
 *
 * Nên với `"AMBIGUOUS"` thì trạng thái KHÔNG được quyền kết luận: phải đọc CHỨNG TỪ — mốc
 * `picked_up_at`, hoặc một sự kiện hành trình sau mốc lấy hàng. Xem `getOrderFulfillmentBucket()`.
 */
export type DaCamHang = "YES" | "NO" | "AMBIGUOUS";

export const SUBSTATE_IMPLIES_PICKED_UP: Record<CarrierSubstate, DaCamHang> = {
  AWAITING_PICKUP: "NO",
  PICKUP_FAILED: "NO",
  PICKED_UP: "YES",
  IN_TRANSIT: "YES",
  OUT_FOR_DELIVERY: "YES",
  // Bưu tá phải cầm hàng rồi mới phát hụt được, và phải phát hụt rồi mới có chuyện "phát lại".
  WAITING_REDELIVERY: "YES",
  WAITING_PROCESSING: "AMBIGUOUS",
  DELIVERY_EXCEPTION: "YES",
  DELIVERED: "YES",
  RETURNING: "YES",
  RETURNED: "YES",
  CANCELLED: "NO",
  UNKNOWN: "AMBIGUOUS",
};

/**
 * ĐANG TRONG LUỒNG GIAO TỚI KHÁCH — chiều ĐI, chưa tới đích, chưa quay đầu.
 *
 * Đây là nửa thứ hai của điều kiện cho chỉ số "Đã gửi"; nửa thứ nhất là `SUBSTATE_IMPLIES_PICKED_UP`.
 * Cố ý KHÔNG gồm `DELIVERED` (đã tới nơi), `RETURNING`/`RETURNED` (đã quay đầu) và `CANCELLED` —
 * đó là chỉ số TRẠNG THÁI HIỆN TẠI, không phải chỉ số tích luỹ.
 */
export const SUBSTATE_IS_FORWARD_ACTIVE: Record<CarrierSubstate, boolean> = {
  AWAITING_PICKUP: false,
  PICKUP_FAILED: false,
  PICKED_UP: true,
  IN_TRANSIT: true,
  OUT_FOR_DELIVERY: true,
  WAITING_REDELIVERY: true,
  WAITING_PROCESSING: true,
  DELIVERY_EXCEPTION: true,
  DELIVERED: false,
  RETURNING: false,
  RETURNED: false,
  CANCELLED: false,
  UNKNOWN: false,
};

/** Bỏ dấu + hạ chữ, để cùng một câu viết có dấu hay không đều khớp. */
function boDau(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/**
 * MÃ ĐVVC → TRẠNG THÁI CON. Chỉ khai những mã NÓI RÕ điều gì đó; mã không có ở đây rơi xuống chữ.
 *
 * Đối chiếu `lib/constants/viettelpost.ts::VTP_STATUS`. Khác biệt quan trọng: ở đó 506/507 khai
 * `DELIVERY_FAILED` (đúng ở mức thô), còn ở đây chúng tách ra thành sự cố CỤ THỂ để người xử lý
 * biết nên làm gì — và để cả hai không bị gộp với "chờ phát lại".
 */
export const VTP_CODE_TO_SUBSTATE: Record<number, CarrierSubstate> = {
  100: "AWAITING_PICKUP",
  102: "WAITING_PROCESSING",
  103: "AWAITING_PICKUP",
  104: "AWAITING_PICKUP",
  105: "PICKED_UP",
  107: "CANCELLED",
  101: "CANCELLED",
  106: "PICKUP_FAILED",
  200: "PICKED_UP",
  201: "CANCELLED",
  300: "IN_TRANSIT",
  301: "IN_TRANSIT",
  302: "IN_TRANSIT",
  320: "WAITING_PROCESSING",
  400: "IN_TRANSIT",
  401: "IN_TRANSIT",
  500: "OUT_FOR_DELIVERY",
  501: "DELIVERED",
  502: "RETURNING",
  503: "CANCELLED",
  504: "RETURNED",
  505: "RETURNING",
  506: "DELIVERY_EXCEPTION",
  507: "DELIVERY_EXCEPTION",
  508: "OUT_FOR_DELIVERY",
  509: "IN_TRANSIT",
  510: "IN_TRANSIT",
  515: "RETURNING",
  550: "OUT_FOR_DELIVERY",
};

/**
 * CHỮ → TRẠNG THÁI CON. Thứ tự là ƯU TIÊN: mẫu CỤ THỂ đứng trước mẫu CHUNG.
 *
 * Đây là chỗ lỗi cũ nằm: luật cũ để "cho xu ly" trong một nhánh chung với "cho lay hang" và
 * "moi tao", nên mọi kiện "chờ xử lý" — kể cả kiện đã đi được nửa đường — bị xếp thành *chưa lấy
 * hàng*. Ở đây "chờ xử lý" là một trạng thái RIÊNG và không nói gì về việc đã lấy hàng hay chưa;
 * việc đó do mã và mốc quyết định.
 */
export const SUBSTATE_TEXT_RULES: { match: string[]; substate: CarrierSubstate }[] = [
  // Cụ thể nhất trước: "chờ phát lại" phải thắng "chờ" chung và thắng "phát".
  { match: ["cho phat lai", "hen phat lai", "yeu cau phat lai", "phat lai"], substate: "WAITING_REDELIVERY" },
  { match: ["cho xu ly", "don hang cho xu ly", "cho duyet"], substate: "WAITING_PROCESSING" },
  { match: ["cho lay hang", "moi tao", "tao moi", "khoi tao", "giao cho buu ta di nhan", "dieu phoi buu ta", "tiep nhan don"], substate: "AWAITING_PICKUP" },
  { match: ["lay hang that bai", "lay khong thanh cong", "khong lay duoc hang"], substate: "PICKUP_FAILED" },
  // Sự cố CỤ THỂ khi đang phát — không phải "chờ phát lại", vì chưa hẹn được lần sau.
  { match: ["ton -", "khach hang nghi", "khong co nha", "den buu cuc nhan", "khach tu choi", "khong lien lac", "khach di vang"], substate: "DELIVERY_EXCEPTION" },
  { match: ["giao khong thanh cong", "phat khong thanh cong", "phat that bai", "giao that bai", "khong gap", "delivery fail"], substate: "DELIVERY_EXCEPTION" },
  { match: ["chuyen hoan", "duyet hoan", "yeu cau hoan", "dang hoan", "cho hoan", "chuyen tra", "thong bao chuyen hoan"], substate: "RETURNING" },
  { match: ["giao thanh cong", "phat thanh cong"], substate: "DELIVERED" },
  { match: ["dang giao hang", "phat tiep", "dang phat", "di giao", "buu ta di phat", "phan cong buu ta"], substate: "OUT_FOR_DELIVERY" },
  { match: ["dang van chuyen", "trung chuyen", "dang luan chuyen", "nhan bang ke den", "dong bang ke", "van chuyen di", "chuyen tuyen"], substate: "IN_TRANSIT" },
  { match: ["da lay hang", "da nhan hang", "lay hang thanh cong", "buu ta da nhan hang", "nhap buu cuc goc"], substate: "PICKED_UP" },
  { match: ["huy"], substate: "CANCELLED" },
];

/**
 * TRẠNG THÁI CON CỦA MỘT KIỆN — mã trước, chữ sau, không rõ thì nói là không rõ.
 *
 * `stage` chỉ dùng làm lưới an toàn CUỐI CÙNG khi không có cả mã lẫn chữ: một kiện đã `DELIVERED`
 * trong ERP mà không còn chứng từ nào thì vẫn nên hiện "đã giao" thay vì "chưa rõ".
 *
 * KHÔNG BAO GIỜ im lặng quy về `DELIVERY_EXCEPTION`: trạng thái lạ là `UNKNOWN`, và nó hiện ra
 * thành một nhóm riêng trên màn hình để có người đi tra, chứ không bị trộn vào nhóm "giao hỏng"
 * rồi biến mất.
 */
export function carrierSubstate(input: { code?: number | null; text?: string | null; stage?: ShipmentStage | null }): { substate: CarrierSubstate; basis: "code" | "text" | "stage" | "unknown" } {
  const code = input.code ?? null;
  if (code !== null && VTP_CODE_TO_SUBSTATE[code]) return { substate: VTP_CODE_TO_SUBSTATE[code], basis: "code" };

  const text = boDau(String(input.text ?? ""));
  if (text) {
    for (const luat of SUBSTATE_TEXT_RULES) {
      if (luat.match.some((m) => text.includes(m))) return { substate: luat.substate, basis: "text" };
    }
  }

  const stage = input.stage ?? null;
  if (stage) {
    const theoStage: Partial<Record<ShipmentStage, CarrierSubstate>> = {
      PENDING: "AWAITING_PICKUP",
      PICKED_UP: "PICKED_UP",
      IN_TRANSIT: "IN_TRANSIT",
      OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
      DELIVERED: "DELIVERED",
      DELIVERY_FAILED: "DELIVERY_EXCEPTION",
      RETURNING: "RETURNING",
      RETURNED: "RETURNED",
      CANCELLED: "CANCELLED",
    };
    const s = theoStage[stage];
    if (s) return { substate: s, basis: "stage" };
  }
  return { substate: "UNKNOWN", basis: "unknown" };
}
