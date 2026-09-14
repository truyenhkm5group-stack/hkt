/**
 * ═══════════ "ĐÃ GỬI" NGHĨA LÀ GÌ — MỘT ĐỊNH NGHĨA, MỘT CHỖ KHAI ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Khối "Luồng đơn hàng" trên trang chủ đếm đơn theo `orders.stage`, tức theo TRẠNG THÁI PANCAKE.
 * Ở đó "Đã gửi hàng" là mã 2 của Pancake — nó nói NHÂN VIÊN BÁN HÀNG đã bấm nút, không nói bưu tá
 * đã cầm gói hàng. Hai chuyện đó lệch nhau hàng ngày: đơn bấm "đã gửi" rồi huỷ lấy, đơn bấm "đã
 * gửi" mà bưu tá tới không lấy được, đơn đã giao tới khách từ hôm kia mà chưa ai bấm sang "Đã
 * nhận". Một con số tên là "Đã gửi" mà không đếm hàng đang đi thì không dùng để quyết việc gì.
 *
 * ─── ĐỊNH NGHĨA ───
 *
 * **Đã gửi = ĐVVC ĐÃ CẦM ĐƯỢC HÀNG, và kiện vẫn đang trên đường TỚI KHÁCH.**
 *
 * Cố ý KHÔNG gồm:
 *   · chưa bàn giao (mới tạo, đang đóng, chờ chuyển, chờ bưu tá tới lấy) — hàng còn trong kho;
 *   · bưu tá tới mà không lấy được, hoặc shop huỷ lượt lấy — chưa bao giờ rời kho;
 *   · huỷ;
 *   · **đã giao tới khách** — tới nơi rồi, không còn "đang gửi";
 *   · **đang hoàn / đã hoàn** — đã quay đầu, không còn đi tới khách.
 *
 * Đây là chỉ số TRẠNG THÁI HIỆN TẠI ("bây giờ có bao nhiêu kiện đang đi"), không phải chỉ số tích
 * luỹ ("kỳ này đã gửi tổng bao nhiêu"). Cột "Đã gửi" của bảng hiệu quả mẫu mã
 * (`lib/queries/return-rate.ts`) là loại TÍCH LUỸ và giữ nguyên nghĩa cũ — hai chỉ số khác nhau,
 * khác tên rổ, khai riêng ở đây để không ai gộp nhầm.
 *
 * ─── CĂN CỨ ───
 *
 * Chỉ CHỨNG TỪ ĐVVC. Không đọc trạng thái Pancake, không đọc COD, không đọc thanh toán, không đọc
 * đối soát — tiền không nói gì về việc gói hàng đang nằm ở đâu (luật nghiệp vụ số 1).
 *
 * ─── MỘT ĐƠN ĐẾM ĐÚNG MỘT LẦN ───
 *
 * Từ 10/09/2026 một đơn có thể có NHIỀU lần gửi. Rổ của ĐƠN là rổ của LẦN GỬI ĐANG QUYẾT ĐỊNH —
 * xem `pickAttempt()`. Lần gửi cũ hỏng KHÔNG được đè lên lần gửi mới đang chạy: gửi lại sau khi
 * bưu tá không lấy được thì đơn đó đang đi, không phải "lấy hàng thất bại".
 */
import { CARRIER_SUBSTATE_LABEL, carrierSubstate, SUBSTATE_IMPLIES_PICKED_UP, SUBSTATE_IS_FORWARD_ACTIVE, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import type { OrderStage, ShipmentStage } from "@/db/schema";

export const FULFILLMENT_BUCKETS = [
  "NOT_SHIPPED",
  "PICKUP_FAILED",
  "IN_FLIGHT",
  "DELIVERED",
  "RETURNING",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
] as const;
export type FulfillmentBucket = (typeof FULFILLMENT_BUCKETS)[number];

export const FULFILLMENT_BUCKET_LABEL: Record<FulfillmentBucket, string> = {
  NOT_SHIPPED: "Chưa bàn giao ĐVVC",
  PICKUP_FAILED: "Bưu tá không lấy được hàng",
  IN_FLIGHT: "Đã gửi — đang trên đường tới khách",
  DELIVERED: "Đã giao tới khách",
  RETURNING: "Đang chuyển hoàn",
  RETURNED: "Đã hoàn về shop",
  CANCELLED: "Đã huỷ",
  UNKNOWN: "Chưa rõ — ERP không có tin gì",
};

/** Lời giải thích hiện trên tooltip. Mỗi rổ nói rõ căn cứ và nói rõ nó KHÔNG nói điều gì. */
export const FULFILLMENT_BUCKET_HINT: Record<FulfillmentBucket, string> = {
  NOT_SHIPPED:
    "Hàng còn ở shop: chưa tạo vận đơn, hoặc đã tạo mà bưu tá chưa tới cầm. Căn cứ là chứng từ ĐVVC, không phải nút bấm trên Pancake.",
  PICKUP_FAILED:
    "Bưu tá tới lấy nhưng không lấy được, hoặc shop huỷ lượt lấy. Gói hàng CHƯA BAO GIỜ rời kho — không được tính vào 'đã gửi'.",
  IN_FLIGHT:
    "ĐVVC đã cầm hàng và kiện vẫn đang đi tới khách: đang trung chuyển, đang đi giao, chờ phát lại, chờ bưu cục xử lý, hoặc đang vướng sự cố giao. Trạng thái “chờ xử lý” chỉ được tính khi CÓ CHỨNG TỪ rời kho (mốc lấy hàng hoặc sự kiện hành trình sau đó) — câu chữ đó xuất hiện ở cả hai phía mốc lấy hàng nên tự nó không kết luận được. KHÔNG gồm đơn đã giao, đang hoàn, đã hoàn hay đã huỷ — đây là số kiện ĐANG đi ngay lúc này, không phải tổng đã gửi trong kỳ.",
  DELIVERED:
    "Kiện đã tới tay khách theo chứng từ ĐVVC. Đây là chiều LOGISTICS; việc thu được bao nhiêu tiền là chiều khác và do ORDER_OUTCOME kết luận.",
  RETURNING: "Kiện đã quay đầu, đang trên đường về shop. Hàng chưa vào lại tồn cho tới khi kho lập phiếu.",
  RETURNED: "ĐVVC đã trả hàng về. Hàng vẫn CHƯA vào tồn cho tới khi kho kiểm đếm và lập phiếu RETURN.",
  CANCELLED: "Vận đơn hoặc đơn đã huỷ. Không nằm trong tử số lẫn mẫu số của tỷ lệ giao thành công.",
  UNKNOWN:
    "Có vận đơn nhưng ERP chưa nhận được tin nào từ ĐVVC, hoặc trạng thái ĐVVC chưa dịch được. CHƯA BIẾT — không ghi 0, không đoán.",
};

/** Thứ tự hiện trên màn hình: đi theo vòng đời, từ trong kho ra tới khách rồi quay về. */
export const FULFILLMENT_BUCKET_ORDER: FulfillmentBucket[] = [
  "NOT_SHIPPED",
  "PICKUP_FAILED",
  "IN_FLIGHT",
  "DELIVERED",
  "RETURNING",
  "RETURNED",
  "CANCELLED",
  "UNKNOWN",
];

/** Rổ nào nghĩa là gói hàng ĐÃ RỜI KHO theo chứng từ ĐVVC. Dùng cho đối chiếu với sổ kho. */
export const BUCKET_LEFT_WAREHOUSE: Record<FulfillmentBucket, boolean> = {
  NOT_SHIPPED: false,
  PICKUP_FAILED: false,
  IN_FLIGHT: true,
  DELIVERED: true,
  RETURNING: true,
  RETURNED: true,
  CANCELLED: false,
  UNKNOWN: false,
};

/** Một lần gửi, ở dạng tối thiểu cần để xếp rổ. Cố ý KHÔNG có trường tiền nào. */
export type AttemptFacts = {
  id: string;
  /** Mã trạng thái ĐVVC (`shipments.vtp_status`). */
  code: number | null;
  /** Tên trạng thái ĐVVC nguyên văn (`shipments.vtp_status_name`). */
  text: string | null;
  stage: ShipmentStage | null;
  /** Lần gửi thứ mấy; NULL coi như 1. */
  attemptNo: number | null;
  /** Mốc tạo dòng vận đơn — chỉ dùng để chọn lần gửi mới nhất, KHÔNG dùng để kết luận trạng thái. */
  createdAt: Date | string | null;
  /** Có bất kỳ dấu vết nào của ĐVVC không: mã vận đơn, mã tra cứu, hoặc một sự kiện hành trình. */
  hasCarrierLink: boolean;
  /**
   * CHỨNG TỪ nói gói hàng đã rời kho: có `picked_up_at`, hoặc có sự kiện hành trình mang chặng sau
   * mốc lấy hàng. KHÔNG suy từ câu chữ trạng thái — xem `DaCamHang` ở carrier-substate.ts.
   */
  pickupEvidence: boolean;
};

/**
 * LẦN GỬI QUYẾT ĐỊNH RỔ CỦA ĐƠN.
 *
 * Cùng thứ tự ưu tiên với `PRIMARY_ATTEMPT` trong `lib/queries/return-rate.ts`, vì hai nơi phải
 * chọn CÙNG một dòng — khác nhau là hai màn hình nói hai con số cho cùng một đơn:
 *   1. lần gửi tới tay khách thắng (khách nhận được rồi thì lần huỷ trước không xoá được);
 *   2. chưa lần nào tới tay khách thì lấy lần gửi MỚI NHẤT — đó là tình trạng hiện thời;
 *   3. chốt bằng `id` để hai lần chạy cho cùng kết quả.
 */
export function pickAttempt(attempts: AttemptFacts[]): AttemptFacts | null {
  if (!attempts.length) return null;
  const moc = (a: AttemptFacts) => (a.createdAt ? new Date(a.createdAt).getTime() : 0);
  return [...attempts].sort((a, b) => {
    const da = a.stage === "DELIVERED" ? 1 : 0;
    const db = b.stage === "DELIVERED" ? 1 : 0;
    if (da !== db) return db - da;
    const na = a.attemptNo ?? 1;
    const nb = b.attemptNo ?? 1;
    if (na !== nb) return nb - na;
    if (moc(a) !== moc(b)) return moc(b) - moc(a);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0]!;
}

/** Trạng thái con của ĐVVC → rổ của đơn. Bảng đầy đủ: mọi giá trị đều có chỗ, không có `default`. */
const BUCKET_OF_SUBSTATE: Record<CarrierSubstate, FulfillmentBucket> = {
  AWAITING_PICKUP: "NOT_SHIPPED",
  PICKUP_FAILED: "PICKUP_FAILED",
  PICKED_UP: "IN_FLIGHT",
  IN_TRANSIT: "IN_FLIGHT",
  OUT_FOR_DELIVERY: "IN_FLIGHT",
  WAITING_REDELIVERY: "IN_FLIGHT",
  // MƠ HỒ: chỉ vào "đang đi" khi CHỨNG TỪ nói gói hàng đã rời kho. Bảng này khai rổ cho trường hợp
  // CÓ chứng từ; trường hợp không có được chặn ở `getOrderFulfillmentBucket()` trước khi tra bảng.
  WAITING_PROCESSING: "IN_FLIGHT",
  DELIVERY_EXCEPTION: "IN_FLIGHT",
  DELIVERED: "DELIVERED",
  RETURNING: "RETURNING",
  RETURNED: "RETURNED",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
};

export type BucketVerdict = {
  bucket: FulfillmentBucket;
  substate: CarrierSubstate;
  substateLabel: string;
  /** Kết luận dựa vào đâu — hiện ra để người đọc biết con số này chắc tới mức nào. */
  basis: "code" | "text" | "stage" | "order" | "no-shipment" | "unknown";
  attemptId: string | null;
};

/**
 * RỔ GIAO VẬN CỦA MỘT ĐƠN — hàm dùng chung, không màn hình nào được tự viết lại.
 *
 * `orderStage` CHỈ dùng cho đúng hai việc và không việc nào khác:
 *   · đơn huỷ/xoá trên Pancake mà chưa từng có vận đơn ⇒ `CANCELLED`;
 *   · đơn chưa có vận đơn nào ⇒ `NOT_SHIPPED`.
 * Ngoài hai chỗ đó, trạng thái Pancake KHÔNG được nói gì về việc gói hàng ở đâu — kể cả khi nó
 * ghi "Đã gửi hàng" hay "Đã nhận".
 */
export function getOrderFulfillmentBucket(input: { orderStage: OrderStage | null; attempts: AttemptFacts[] }): BucketVerdict {
  const chon = pickAttempt(input.attempts);

  if (!chon) {
    const huy = input.orderStage === "CANCELLED" || input.orderStage === "DELETED";
    return {
      bucket: huy ? "CANCELLED" : "NOT_SHIPPED",
      substate: huy ? "CANCELLED" : "AWAITING_PICKUP",
      substateLabel: CARRIER_SUBSTATE_LABEL[huy ? "CANCELLED" : "AWAITING_PICKUP"],
      basis: huy ? "order" : "no-shipment",
      attemptId: null,
    };
  }

  // Có dòng vận đơn mà KHÔNG có một dấu vết nào của ĐVVC: không mã, không sự kiện. ERP không biết
  // gói hàng ở đâu — thậm chí không biết có gói hàng nào. Nói "đang gửi" là bịa ra một sự kiện
  // vận chuyển chưa từng được chứng minh (cùng luật với nhánh đầu của ORDER_OUTCOME).
  if (!chon.hasCarrierLink) {
    const huy = input.orderStage === "CANCELLED" || input.orderStage === "DELETED";
    return {
      bucket: huy ? "CANCELLED" : "UNKNOWN",
      substate: huy ? "CANCELLED" : "UNKNOWN",
      substateLabel: CARRIER_SUBSTATE_LABEL[huy ? "CANCELLED" : "UNKNOWN"],
      basis: huy ? "order" : "unknown",
      attemptId: chon.id,
    };
  }

  const { substate, basis } = carrierSubstate({ code: chon.code, text: chon.text, stage: chon.stage });

  /*
    TRẠNG THÁI MƠ HỒ THÌ CHỨNG TỪ QUYẾT ĐỊNH, KHÔNG PHẢI CÂU CHỮ.

    "Chờ xử lý" xuất hiện ở CẢ HAI phía của mốc lấy hàng (đo 13/09/2026: 169 vận đơn mang mã 102 —
    còn trong kho; 56 vận đơn đã có mốc lấy và sự kiện sau đó). Không mốc nào nói gói hàng đã rời
    kho thì nó CHƯA RỜI KHO theo sổ — đó là câu trả lời theo chứng từ, không phải phỏng đoán.
  */
  if (SUBSTATE_IMPLIES_PICKED_UP[substate] === "AMBIGUOUS" && !chon.pickupEvidence) {
    const roMoHo: FulfillmentBucket = substate === "UNKNOWN" ? "UNKNOWN" : "NOT_SHIPPED";
    return { bucket: roMoHo, substate, substateLabel: CARRIER_SUBSTATE_LABEL[substate], basis, attemptId: chon.id };
  }

  return { bucket: BUCKET_OF_SUBSTATE[substate], substate, substateLabel: CARRIER_SUBSTATE_LABEL[substate], basis, attemptId: chon.id };
}

/** "Đơn này có đang trên đường tới khách không?" — đúng một câu hỏi, đúng một câu trả lời. */
export function isActivelyShippedOrder(input: { orderStage: OrderStage | null; attempts: AttemptFacts[] }): boolean {
  return getOrderFulfillmentBucket(input).bucket === "IN_FLIGHT";
}

/**
 * Tự kiểm bảng: rổ IN_FLIGHT phải đúng bằng tập "đã cầm hàng VÀ còn đi tới khách".
 *
 * Hai bảng `SUBSTATE_IMPLIES_PICKED_UP` và `SUBSTATE_IS_FORWARD_ACTIVE` khai ở
 * `lib/constants/carrier-substate.ts` theo VÒNG ĐỜI của ĐVVC; bảng `BUCKET_OF_SUBSTATE` ở đây khai
 * theo NGHIỆP VỤ. Chúng phải trùng nhau, và hàm này là chỗ phát hiện khi ai đó sửa một bên mà quên
 * bên kia. `tests/carrier-substate.test.ts` gọi nó.
 */
export function kiemTraBangRo(): string[] {
  const loi: string[] = [];
  for (const s of Object.keys(BUCKET_OF_SUBSTATE) as CarrierSubstate[]) {
    const inFlight = BUCKET_OF_SUBSTATE[s] === "IN_FLIGHT";
    const dungNghia = SUBSTATE_IMPLIES_PICKED_UP[s] !== "NO" && SUBSTATE_IS_FORWARD_ACTIVE[s];
    if (inFlight !== dungNghia) loi.push(`${s}: rổ ${BUCKET_OF_SUBSTATE[s]} nhưng đã-cầm-hàng=${SUBSTATE_IMPLIES_PICKED_UP[s]}, còn-đi-tới-khách=${SUBSTATE_IS_FORWARD_ACTIVE[s]}`);
  }
  return loi;
}
