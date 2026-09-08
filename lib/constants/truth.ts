/**
 * ───────────────────────── NĂM CHIỀU SỰ THẬT CỦA ERP ─────────────────────────
 *
 * Đây là BẢNG ĐĂNG KÝ, không phải chỗ tính toán. Công thức kết quả đơn vẫn chỉ có MỘT bản duy
 * nhất ở `lib/queries/return-rate.ts::ORDER_OUTCOME`; tệp này chỉ đặt tên cho các chiều, nói rõ
 * chiều nào lấy sự thật từ đâu và tuyệt đối không được suy ra từ đâu.
 *
 * Vì sao cần: khi năm chiều không có tên gọi chung, người sửa code sau sẽ tưởng "đã thanh toán"
 * và "đã giao" là một, rồi viết một câu `update` duy nhất là hỏng cả kho số liệu. Đã xảy ra thật —
 * xem F1/F2 trong `docs/erp-data-truth-audit.md`.
 *
 * Đặc tả ràng buộc: `docs/business-rules/ORDER_OUTCOME.md`.
 */
import type { CodStatus, OrderStage, ShipmentStage } from "@/db/schema";
import { orderStageEnum, shipmentStageEnum, codStatusEnum } from "@/db/schema";
import type { OrderOutcome } from "@/lib/constants/returns";
import type { SettlementStatus } from "@/lib/constants/cod";

export type TruthDimension = "order_status" | "shipment_status" | "shipment_outcome" | "payment_status" | "reconciliation_status";

export type TruthDimensionSpec = {
  key: TruthDimension;
  /** Nhãn tiếng Việt dùng trên giao diện — để người dùng không đọc nhầm hai chiều thành một. */
  label: string;
  /** Câu hỏi mà chiều này (và chỉ chiều này) trả lời. */
  question: string;
  /** Nơi giá trị được lưu / tính. */
  storedAt: string;
  /** Nguồn sự thật duy nhất. */
  sourceOfTruth: string;
  /** Những thứ TUYỆT ĐỐI không được dùng để suy ra chiều này. */
  neverInferFrom: readonly string[];
  /** Tập giá trị hợp lệ. */
  values: readonly string[];
};

export const TRUTH_DIMENSIONS: Record<TruthDimension, TruthDimensionSpec> = {
  order_status: {
    key: "order_status",
    label: "Trạng thái đơn (Pancake)",
    question: "Nhân viên bán hàng đang xử lý đơn tới bước nào?",
    storedAt: "orders.stage",
    sourceOfTruth: "Pancake POS (lib/integrations/pancake/mapper.ts)",
    neverInferFrom: ["trạng thái vận đơn", "tiền COD", "bảng kê", "sao kê ngân hàng"],
    values: orderStageEnum.enumValues,
  },
  shipment_status: {
    key: "shipment_status",
    label: "Trạng thái vận đơn (ĐVVC)",
    question: "Hàng đang ở đâu trên đường đi?",
    storedAt: "shipments.stage — ảnh chụp dựng từ shipment_events bởi materializeShipmentState()",
    sourceOfTruth: "sự kiện đến thẳng từ Viettel Post (shipment_events, nguồn VTP_*/MANUAL)",
    neverInferFrom: ["tiền COD", "cod_status", "bảng kê", "settlement", "trạng thái Pancake"],
    values: shipmentStageEnum.enumValues,
  },
  shipment_outcome: {
    key: "shipment_outcome",
    label: "Kết quả đơn",
    question: "Đơn này kết thúc thế nào: tới tay khách, quay về, hay bị huỷ?",
    storedAt: "biểu thức ORDER_OUTCOME (lib/queries/return-rate.ts) — không lưu trong bảng",
    sourceOfTruth: "chứng từ logistics của ĐVVC trước, tiền CÓ CHỨNG TỪ sau",
    neverInferFrom: ["trạng thái Pancake", "COD khai báo", "cod_status đơn thuần"],
    values: ["NOT_SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED", "RETURNED_BY_RULE", "CANCELLED"],
  },
  payment_status: {
    key: "payment_status",
    label: "Trạng thái tiền thu hộ",
    question: "Tiền của đơn này đang nằm ở đâu?",
    storedAt: "shipments.cod_status + shipments.cod_collected",
    sourceOfTruth: "dòng chứng từ bảng kê COD (cod_statement_lines) và sổ ngân hàng",
    neverInferFrom: ["việc vận đơn đã giao", "trạng thái Pancake", "COD khai báo trên đơn"],
    values: codStatusEnum.enumValues,
  },
  reconciliation_status: {
    key: "reconciliation_status",
    label: "Tình trạng đối soát",
    question: "Viettel Post đã trả đủ tiền thu hộ của đơn này chưa?",
    storedAt: "SettlementStatus (lib/queries/cod-settlement.ts) + cod_batches",
    sourceOfTruth: "so tiền thu hộ khai báo với các dòng bảng kê thật đã nhận",
    neverInferFrom: ["trạng thái vận đơn", "trạng thái Pancake"],
    values: ["DA_TRA_DU", "TRA_THIEU", "CHUA_TRA", "QUA_HAN", "CHUA_GIAO", "GIAO_NHUNG_HOAN", "KHONG_PHAI_TRA"],
  },
};

export const TRUTH_DIMENSION_ORDER: TruthDimension[] = ["order_status", "shipment_status", "shipment_outcome", "payment_status", "reconciliation_status"];

/**
 * ───────── Nguồn sự kiện được quyền kết luận chiều LOGISTICS ─────────
 *
 * Hai danh sách, khác nhau có chủ đích, trước đây bị chép cứng ở ba nơi:
 *
 *  · CARRIER_EVENT_SOURCES — được quyền dựng trạng thái vận đơn. Có `MANUAL` vì nhân viên
 *    tra cứu trên trang Viettel Post rồi ghi lại cũng là chứng từ của ĐVVC, chỉ là qua tay người.
 *  · CARRIER_DOCUMENT_SOURCES — chứng từ MÁY, đến thẳng từ hệ thống Viettel Post. Chỉ nhóm này
 *    được dùng để đọc MÃ TRẠNG THÁI CUỐI (501/503/504/101/107/201), vì mã cuối là kết luận nghiệp
 *    vụ chứ không phải mô tả; người nhập tay không được quyền tạo ra kết luận đó.
 *
 * Bản sao hành trình từ Pancake KHÔNG nằm trong cả hai: mốc thời gian của nó là giờ Pancake ghi
 * nhận, không phải giờ sự kiện của ĐVVC.
 */
export const CARRIER_EVENT_SOURCES = ["VTP_WEBHOOK", "VTP_IMPORT", "VTP_POLL", "MANUAL"] as const;
export const CARRIER_DOCUMENT_SOURCES = ["VTP_WEBHOOK", "VTP_POLL", "VTP_IMPORT"] as const;

/** Danh sách dùng trong chuỗi SQL: `... in ('VTP_WEBHOOK','VTP_POLL',...)`. */
export const sqlSourceList = (sources: readonly string[]) => sources.map((s) => `'${s}'`).join(",");

/**
 * ───────── THANG THẨM QUYỀN CỦA BẰNG CHỨNG LOGISTICS ─────────
 *
 * Viết ra thành bảng vì câu hỏi "cái nào thắng" đã được trả lời khác nhau ở từng chỗ trong lịch sử
 * kho mã. Một chỗ duy nhất, mọi nơi tra lại.
 *
 * Điều tra 08/09/2026 (docs/erp-release-report.md mục 10i) xác định: Pancake CHUYỂN TIẾP NGUYÊN
 * VĂN gói tin webhook của Viettel Post — giữ đủ `ORDER_STATUS` (mã số), `STATUS_NAME`,
 * `ORDER_STATUSDATE`, `IS_RETURNING`, `REASON_CODE` — nên gói tin đó là chứng từ của HÃNG VẬN
 * CHUYỂN, chỉ đi nhờ đường Pancake. Vì vậy nó nằm ở mức CAO, ngang webhook đến thẳng.
 *
 * Ranh giới phải nhớ: đó là gói tin CHUYỂN TIẾP (`webhook_events.source = 'VIETTELPOST'`), KHÁC
 * hẳn bản sao hành trình trong `orders.partner.extend_update` mà Pancake tự dựng — bản sao đó chỉ
 * ở mức TRUNG BÌNH vì mốc thời gian là giờ Pancake ghi nhận.
 */
export const LOGISTICS_EVIDENCE_AUTHORITY = [
  { level: "HIGH", source: "VTP_WEBHOOK", what: "Sự kiện hành trình mang mã số của Viettel Post — đến thẳng hoặc do Pancake chuyển tiếp nguyên văn", decides: true },
  { level: "HIGH", source: "VTP_IMPORT", what: "Tệp danh sách vận đơn tải từ viettelpost.vn", decides: true },
  { level: "HIGH", source: "VTP_POLL", what: "Tra cứu hành trình qua API Viettel Post", decides: true },
  { level: "MEDIUM", source: "PANCAKE_PARTNER_STATUS", what: "Trạng thái vận đơn Pancake tự chuẩn hoá (partner_status) — chỉ dùng khi CHƯA có bằng chứng mức CAO", decides: false },
  { level: "LOW", source: "PANCAKE_ORDER_STAGE", what: "Trạng thái ĐƠN trên Pancake (\"Đã nhận\") — cao nhất chỉ được nói ĐANG GIAO", decides: false },
  { level: "NEVER", source: "PAYMENT_COD", what: "Tiền, COD, bảng kê, trạng thái thanh toán — KHÔNG BAO GIỜ là bằng chứng logistics", decides: false },
] as const;

/**
 * Chỉ những nguồn này được quyền kết luận chiều logistics. Phải trùng đúng
 * `CARRIER_DOCUMENT_SOURCES` — kiểm thử bất biến khoá hai danh sách khớp nhau để không ai nới một
 * bên mà quên bên kia. (`MANUAL` cố ý KHÔNG có mặt: người nhập tay không tạo ra được mã cuối.)
 */
export const LOGISTICS_DECIDING_SOURCES = LOGISTICS_EVIDENCE_AUTHORITY.filter((s) => s.decides).map((s) => s.source);

/**
 * Chiều đi / chiều hoàn của một sự kiện — quy đổi từ cờ IS_RETURNING của Viettel Post.
 * `UNKNOWN` nghĩa là ĐVVC không gửi cờ: KHÔNG được đoán, và mã 501 không có cờ thì không được
 * coi là giao tới tay khách.
 */
export const LEG_TYPES = ["OUTBOUND", "RETURN", "UNKNOWN"] as const;
export type LegType = (typeof LEG_TYPES)[number];

export function legTypeFromReturningFlag(isReturning: boolean | null | undefined): "OUTBOUND" | "RETURN" | null {
  if (isReturning === null || isReturning === undefined) return null;
  return isReturning ? "RETURN" : "OUTBOUND";
}

/**
 * ───────── Nhóm kết quả đơn ─────────
 * Dùng khi màn hình chỉ cần biết "thành công / hoàn / đang chạy / huỷ" thay vì sáu giá trị.
 * `RETURNED` và `RETURNED_BY_RULE` LUÔN được gộp là hoàn trong mọi tổng hợp (đặc tả mục 6).
 */
export type OutcomeGroup = "SUCCESS" | "RETURNED" | "OPEN" | "CANCELLED";

export const OUTCOME_GROUP: Record<OrderOutcome, OutcomeGroup> = {
  DELIVERED: "SUCCESS",
  RETURNED: "RETURNED",
  RETURNED_BY_RULE: "RETURNED",
  IN_TRANSIT: "OPEN",
  NOT_SHIPPED: "OPEN",
  CANCELLED: "CANCELLED",
};

export const OUTCOME_GROUP_LABEL: Record<OutcomeGroup, string> = {
  SUCCESS: "Giao thành công",
  RETURNED: "Hoàn / không thành công",
  OPEN: "Chưa kết thúc",
  CANCELLED: "Huỷ",
};

export function outcomeGroup(outcome: OrderOutcome): OutcomeGroup {
  return OUTCOME_GROUP[outcome];
}

/** Đơn đã KẾT THÚC — mẫu số của tỷ lệ giao thành công. Đơn huỷ không nằm trong mẫu số. */
export function isFinishedOutcome(outcome: OrderOutcome): boolean {
  const group = OUTCOME_GROUP[outcome];
  return group === "SUCCESS" || group === "RETURNED";
}

/**
 * ───────── Bằng chứng TIỀN ─────────
 * Ghi thành hằng số để không ai phải đoán "trường này có tính là tiền thật không".
 * Đặc tả `ORDER_OUTCOME.md` mục 8.
 */
export const VERIFIED_MONEY_SOURCES = [
  "cod_statement_lines.cod_amount — dòng chứng từ trên bảng kê COD của Viettel Post",
  "shipments.cod_collected > 0 — số thực thu đã ghi từ bảng kê",
  "sao kê ngân hàng đã đối chiếu",
  "orders.prepaid / orders.transfer_money — khách chuyển khoản trước",
] as const;

export const NOT_MONEY_EVIDENCE = [
  "orders.cod — COD khai báo trên đơn",
  "shipments.cod_amount — COD khai báo trên vận đơn",
  "orders.money_to_collect",
  "MONEY_COLLECTION trong webhook Viettel Post",
  "shipments.cod_status đơn thuần (không kèm số tiền)",
  "shipments.cod_statement_ref — tên tệp bảng kê, không phải dòng chứng từ",
] as const;

/**
 * ───────── Ai được ghi vào chiều LOGISTICS ─────────
 *
 * Bất biến bổ sung sau kiểm toán TASK 1. Danh sách này là ALLOWLIST, và ngắn có chủ đích:
 *
 *  · `state.ts` — `materializeShipmentState()`, nơi DUY NHẤT dựng trạng thái từ chứng từ của ĐVVC;
 *  · `pancake/sync.ts` — chỉ được ghi khi vận đơn CHƯA có bất kỳ chứng từ nào của ĐVVC
 *    (`vtp_status_date is null`). Có chứng từ rồi thì Pancake không đụng vào nữa, và
 *    `materializeShipmentState()` được gọi ngay sau đó để chốt lại theo lịch sử.
 *    Vận đơn chưa có chứng từ thì trạng thái Pancake là thứ duy nhất ERP có; `ORDER_OUTCOME` đã
 *    chặn sẵn — không chứng từ ĐVVC thì cao nhất chỉ là ĐANG GIAO.
 *
 * Thêm tên vào đây phải là một quyết định tường minh: mỗi luồng ghi thêm là một bản luật thứ hai,
 * và hai bản luật thì sớm muộn cũng lệch nhau. Khoá ở tests/business-invariants.test.ts.
 */
export const SHIPMENT_STAGE_WRITERS = ["lib/integrations/viettelpost/state.ts", "lib/integrations/pancake/sync.ts"] as const;

/** Kiểu tổng hợp một đơn theo cả năm chiều — dùng cho màn hình chi tiết và cho nhật ký truy vết. */
export type OrderTruthSnapshot = {
  orderStatus: OrderStage;
  shipmentStatus: ShipmentStage | null;
  shipmentOutcome: OrderOutcome;
  paymentStatus: CodStatus | null;
  reconciliationStatus: SettlementStatus | null;
};
