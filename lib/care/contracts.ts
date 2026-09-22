import type { BusinessAction } from "@/lib/constants/care-outcome";
import type { CareDecision } from "@/lib/constants/care-resolution";
import type { CareBacklogGroup, CareTimelineEntry } from "@/lib/constants/care-rounds";
import type { CarrierSubstate } from "@/lib/constants/carrier-substate";
import type { CareSlaHours } from "@/lib/care/view";
import type { TimingStat } from "@/lib/constants/care-timing";
import type { CareEventAction, CareEventSource, CareReasonClass, CareReasonKey, CareStatus, CareView, CarrierActionKey, CarrierRequestStatus } from "@/lib/constants/care";

/**
 * ═══════════ HỢP ĐỒNG KIỂU CỦA CARE ENGINE — ĐÃ CHỐT, KHÔNG ĐỔI TÊN/HÌNH DẠNG TUỲ TIỆN ═══════════
 *
 * UI (Claude Opus) và AI Copilot chỉ dùng các kiểu ở đây. Muốn thêm trường thì THÊM (optional),
 * không đổi tên, không đổi nghĩa. Mọi ngày giờ là `Date` ở máy chủ và được React Flight tuần tự
 * hoá thành Date ở client; qua JSON thuần thì là chuỗi ISO.
 *
 * Nguồn dữ liệu: `lib/queries/care-workbench.ts` (đọc), `lib/care/service.ts` (ghi),
 * Server Actions ở `lib/actions/care-workbench.ts`.
 */

/** Lớp care của một kiện — TÁCH RỜI trạng thái ĐVVC. */
export type CareState = {
  status: CareStatus;
  owner: { id: string; name: string } | null;
  followUpAt: Date | null;
  lastNote: string;
  lastNoteAt: Date | null;
  lastNoteBy: string;
  /** Lần đầu có NGƯỜI động vào (đổi trạng thái / giao / note / hẹn). */
  firstResponseAt: Date | null;
  /** Mốc đóng gần nhất (RESOLVED / CANCELLED). Giữ nguyên khi mở lại để tính "mở lại". */
  doneAt: Date | null;
  reopenCount: number;
  updatedAt: Date | null;
  updatedBy: string;
  /**
   * KẾT QUẢ XỬ LÝ CASE gần nhất — chiều thứ BA, tách hẳn khỏi `status` (đội đang ở đâu) và khỏi
   * chiều ĐVVC (gói hàng ở đâu). Xem `lib/constants/care-resolution.ts`.
   *
   * ĐỌC RA từ dòng `care_decisions` mới nhất của ĐÚNG đợt này, KHÔNG phải một cột lưu song song:
   * một cột thứ hai là tự nhận câu hỏi “hai chỗ lệch nhau thì tin chỗ nào”. `null` = chưa ai quyết
   * gì, khác hẳn “đã quyết là không làm gì”.
   *
   * KHÔNG phải một `BusinessAction`: `care_business_actions` ghi những quyết định GẮN LIỀN với một
   * lệnh gửi Viettel Post, còn đây là lời khai của người và nó ghi được cả khi ĐVVC không nhận lệnh.
   *
   * Optional vì hợp đồng này cấm đổi hình dạng cũ — nơi gọi cũ không truyền thì coi như chưa biết.
   */
  lastDecision?: {
    decision: CareDecision;
    at: Date;
    /** Tên (hoặc email) người quyết — ẢNH CHỤP để đọc; quy kết đi bằng `care_decisions.actor_user_id`. */
    by: string;
    reasonCode: string | null;
    note: string;
  } | null;
};

export type CarrierRequestView = {
  id: string;
  actionKey: CarrierActionKey;
  status: CarrierRequestStatus;
  at: Date;
  error: string | null;
  note: string;
  actor: string;
  /** Số lần đã gọi API (retry hữu hạn). */
  attempts: number;
};

export type CareSlaView = {
  firstResponseDueAt: Date;
  resolveDueAt: Date;
  firstResponseBreached: boolean;
  resolveBreached: boolean;
};

/** Trạng thái năng lực ĐVVC cho MỘT hành động trên MỘT kiện — xem `lib/care/carrier-capabilities.ts`. */
export type CarrierCapabilityStatus = "SUPPORTED" | "UNSUPPORTED" | "WEB_ONLY" | "PERMISSION_MISSING" | "UNKNOWN";

export type CarrierCapabilityView = {
  actionKey: CarrierActionKey;
  status: CarrierCapabilityStatus;
  /** Chặng hiện tại có cho phép hành động này không (luật nghiệp vụ, độc lập với năng lực API). */
  allowedAtStage: boolean;
  /** Vì sao — một câu, để UI hiện tooltip. */
  reason: string;
  /** Có làm được trên web viettelpost.vn không (khi API không hỗ trợ / không có quyền). */
  webUrl: string | null;
};

/** Một kiện trong hàng đợi care. */
export type CareCase = {
  shipmentId: string;
  /** Mã ĐANG HIỂN THỊ: mã Viettel Post nếu có, không thì mã Pancake, không nữa thì id ERP. */
  tracking: string;
  /**
   * MÃ VIETTEL POST THẬT — chỉ `shipments.vtp_order_number`, `null` khi chưa có. Đứng riêng khỏi
   * `tracking` vì `tracking` có thể đang là mã Pancake (`extend_code`) hoặc id ERP: tra cứu trên
   * viettelpost.vn bằng hai thứ đó ra "không tìm thấy", nên chỉ cột này được phép dựng liên kết.
   */
  vtpOrderNumber: string | null;
  orderId: string | null;
  orderSystemId: number | null;
  customer: string;
  phone: string;
  codAmount: number;
  /** CHIỀU ĐVVC — chứng từ, chỉ đọc. */
  carrier: {
    stage: string;
    stageLabel: string;
    /**
     * ĐVVC ĐANG LÀM GÌ — chiều thứ hai, độc lập với `stage` và độc lập với trạng thái xử lý của
     * shop. `stage` gộp "chờ phát lại" với "tồn - khách nghỉ" thành một nhãn, và gộp "chờ xử lý"
     * của kiện đã đi nửa đường với kiện còn trong kho. Xem lib/constants/carrier-substate.ts.
     */
    substate: CarrierSubstate;
    substateLabel: string;
    /** Mã trạng thái gốc của ĐVVC. Giữ nguyên bên cạnh chữ để màn hình xét lại được đúng luật máy chủ. */
    vtpStatus: number | null;
    rawStatus: string;
    ageHours: number | null;
    failedAttempts: number;
    /** Tài khoản API có đọc được kiện này không. */
    trackingCapability: "API_TRACKABLE" | "WEBHOOK_ONLY" | "UNKNOWN_CAPABILITY";
    /** CHỨNG TỪ nói gói hàng đã rời kho — không suy từ câu chữ trạng thái. */
    leftWarehouse: boolean;
  };
  /**
   * MẶT HÀNG TRONG KIỆN — mã hàng và tên hàng, để lọc "kiện nào chứa mẫu này". Rỗng khi kiện chưa
   * ghép được với đơn (vận đơn nhập từ tài khoản ĐVVC, vận đơn chiều hoàn): KHÔNG BIẾT có gì bên
   * trong, khác hẳn "không có hàng nào".
   */
  products: string[];
  reason: CareReasonKey;
  /**
   * Kiện còn nằm trong ĐIỀU KIỆN CẦN CARE hay không. `false` ⇒ dòng chỉ còn giá trị tra cứu: nó
   * luôn ở góc nhìn "Đã xử lý", không cộng vào COD treo hay số vỡ hạn của hàng đợi đang chạy.
   * Trình duyệt phải biết cờ này vì nó tự tính lại góc nhìn sau mỗi thao tác (`patch`) — thiếu nó
   * thì một lần đổi trạng thái care sẽ kéo kiện đã hết việc quay lại tab Cần care.
   */
  inCareCondition: boolean;
  reasonClass: CareReasonClass;
  reasonLabel: string;
  reasonDetail: string;
  nextAction: string;
  /** Lúc kiện VÀO điều kiện cần care — mốc tính SLA. */
  queueSince: Date;
  sla: CareSlaView;
  /** CHIỀU CARE — đội đã làm tới đâu. */
  care: CareState;
  reopened: boolean;
  lastCareAction: { label: string; at: Date; byHuman: boolean } | null;
  /**
   * ĐỘI ĐÃ LÀM GÌ VỚI KIỆN NÀY, MẤY LƯỢT — xem `lib/constants/care-rounds.ts`.
   *
   * ĐỌC RA lúc xem từ ba sổ chỉ-thêm (`care_actions` · `care_decisions` · `care_case_events`),
   * KHÔNG phải một cột lưu song song: một cột thứ hai giữ cùng một sự thật là tự nhận lấy câu hỏi
   * "hai chỗ lệch nhau thì tin chỗ nào", và nó giữ mãi câu trả lời của lần chạy đầu tiên khi nhân
   * viên bổ sung một dòng hành động của hôm qua.
   *
   * Optional vì hợp đồng này cấm đổi hình dạng cũ. Nơi gọi cũ không truyền thì là CHƯA ĐỌC ĐƯỢC,
   * và màn hình phải nói đúng như vậy — KHÔNG được in ra "0 lượt" (luật 42).
   */
  history?: CareHistory;
  /**
   * Bot nhắn khách sau giao hụt KHÔNG thành công (không có hội thoại Pancake, ngoài 24h, thiếu token).
   * Kết luận này trước đây chỉ nằm trong một dòng `cs_cases` miền giao vận mà không hàng đợi nào hiện
   * — tức là không ai, người lẫn máy, đã chạm tới khách. Bàn care là nơi phải thấy nó.
   */
  botMessageFailure: { caseId: string; title: string; detail: string; at: Date } | null;
  carrierRequest: CarrierRequestView | null;
  /** Rút gọn: có gửi thẳng API được không. Chi tiết từng hành động ở `getCareCaseDetail().capabilities`. */
  carrierCapability: "API" | "MANUAL";
  view: Exclude<CareView, "all">;
};

/**
 * ═══════════ LỊCH SỬ XỬ LÝ CỦA ĐỢT ĐANG HIỂN THỊ ═══════════
 *
 * Khoá theo ĐỢT (`shipment_care.id`), không theo kiện: kiện hỏng lần hai là một đợt mới, và ba
 * lượt gọi của đợt trước KHÔNG được hiện lên như thể đợt này đã được chăm ba lần. Số đợt đã đóng
 * trước đó vẫn đọc được ở `previousEpisodes` — mất nó thì một kiện hỏng lần thứ ba trông y hệt một
 * kiện vừa vào hàng đợi lần đầu.
 */
export type CareHistory = {
  /** Số LƯỢT XỬ LÝ của đợt này — `careRoundCount` ở `lib/constants/care-rounds.ts`. */
  rounds: number;
  /**
   * Số lần có NGƯỜI CHẠM vào ca (đổi trạng thái · đặt hẹn · ghi note · bấm kết quả). Đếm RIÊNG,
   * KHÔNG gộp với `rounds` — luật 57: gộp lại thì không phân biệt được *đội đã làm việc* với *đội
   * đã nhìn thấy*. `ASSIGN` bị loại khỏi cả hai vì giao việc là điều phối, không phải chăm sóc.
   */
  touches: number;
  /**
   * Mốc lượt xử lý ĐẦU TIÊN của đợt. `null` = CHƯA LƯỢT NÀO.
   *
   * Đây là thứ trả lời câu "đội đã phản hồi chưa" của hạn xử lý — KHÔNG phải cột
   * `shipment_care.first_response_at`, cột đó được ghi ngay lúc GIAO VIỆC. Xem
   * `lib/care/view.ts::teamResponded`.
   */
  firstRoundAt: Date | null;
  /** Mốc lượt xử lý gần nhất. `null` = CHƯA LƯỢT NÀO, không phải "lâu rồi". */
  lastRoundAt: Date | null;
  /**
   * KHOÁ TÀI KHOẢN của người làm lượt cuối (luật 34). Đi cùng `lastRoundAt` để trình duyệt cộng
   * thêm một lượt vừa ghi bằng ĐÚNG luật gộp của máy chủ (`careRoundAppend`) — không có bản sao
   * thứ hai của phép gộp ở phía client. `null` = máy, hoặc dòng cũ chưa nối được tài khoản.
   */
  lastRoundActorId: string | null;
  /**
   * ĐVVC ĐÃ NÓI THÊM ĐIỀU GÌ KỂ TỪ LƯỢT XỬ LÝ CUỐI.
   *
   * Người trực gọi khách lúc 9 giờ rồi hẹn xem lại chiều mai; 10 giờ Viettel Post báo phát hụt lần
   * nữa. Lượt xử lý kia đứng trên một bức tranh đã cũ, nhưng cái hẹn vẫn giữ ca nằm im tới chiều
   * mai. Cờ này là thứ DUY NHẤT trên dòng nói ra điều đó.
   *
   * `false` khi chưa có lượt xử lý nào — chưa làm gì thì không có "kể từ lúc nào" để so.
   */
  carrierNewsAfterLastRound: boolean;
  /** Số đợt care ĐÃ ĐÓNG trước đợt đang hiển thị, cùng kiện. */
  previousEpisodes: number;
  /** Nhật ký rút gọn, MỚI NHẤT TRƯỚC, tối đa `CARE_TIMELINE_INLINE_MAX` dòng. */
  timeline: CareTimelineEntry[];
  /** `timeline` đã bị cắt bớt ⇒ TUYỆT ĐỐI không đếm các dòng đang hiện rồi gọi đó là tổng. */
  timelineTruncated: boolean;
};

/**
 * HÀNG ĐỢI MẶC ĐỊNH = đúng tập kiện cần người. Không phải toàn bộ vận đơn.
 * `cases` là CUSTOMER_ACTION + CARRIER_ACTION (+ kiện đã đóng trong 7 ngày cho tab Đã xử lý);
 * `dataGaps` là kiện cũ dữ liệu / thiếu dữ liệu — việc của giao vận, KHÔNG tính vào backlog care.
 */
export type CareQueue = {
  cases: CareCase[];
  dataGaps: CareCase[];
  counts: Record<Exclude<CareView, "all">, number>;
  /** Backlog theo lý do (chỉ kiện đang ở góc nhìn Cần care). */
  byReason: { reason: CareReasonKey; label: string; count: number; money: number }[];
  /**
   * Backlog theo người (chỉ kiện đang mở, kể cả chờ / escalate).
   *
   * `notStarted` = việc ĐÃ NẰM TRONG TAY người này mà chưa có một lượt xử lý nào. Đo production
   * 22/09/2026: **22 đợt ở trạng thái `ASSIGNED` với 0 lượt và 0 lần chạm** — việc đã giao xong
   * rồi đứng im. Cột `open` một mình không nói được điều đó: một người cầm 10 việc và làm cả 10
   * trông y hệt một người cầm 10 việc và chưa mở cái nào.
   */
  byOwner: { ownerId: string | null; name: string; open: number; overdue: number; notStarted: number; money: number }[];
  moneyAtRisk: number;
  overdue: number;
  unassigned: number;
  /**
   * "CÒN TREO" BỔ RA BA CON SỐ — xem `CARE_BACKLOG_GROUP_HINT`.
   *
   * Tổng ba nhóm bằng đúng `counts.care`: đây là một phép BỔ, không phải một bộ lọc thứ hai, nên
   * không kiện nào rơi ra ngoài và không kiện nào bị đếm hai lần. Trước bản này chỉ có `counts.care`,
   * và nó gộp kiện chưa ai mở ra nhìn với kiện đã gọi khách ba lượt đang chờ tới giờ hẹn — hai
   * tình huống đòi hai hành động trái ngược.
   */
  backlogGroups: Record<CareBacklogGroup, { count: number; money: number }>;
  /**
   * ĐỘ NGUỘI GIỮA HAI LƯỢT — trung vị KÈM ĐỘ PHỦ, `null` khi mẫu dưới ngưỡng (luật 63).
   *
   * Câu hỏi khác hẳn "phản hồi đầu": cái kia hỏi đội bắt đầu nhanh không, cái này hỏi đội có bỏ ca
   * giữa chừng không. `population` là số ca đang mở, `sample` là số ca có ÍT NHẤT HAI lượt (tức là
   * có một khoảng để đo) — chênh lệch giữa hai con số chính là thứ phải in ra.
   */
  roundGap: TimingStat;
  /**
   * NGƯỠNG SLA ĐANG HIỆU LỰC, đi kèm hàng đợi xuống trình duyệt. Trước bản này máy chủ đọc ghi đè
   * của chủ shop (`settings.work.sla`) còn trình duyệt tính lại bằng mặc định dựng sẵn sau mỗi
   * thao tác — cùng một kiện đổi hạn giữa chừng chỉ vì ai đó bấm một nút.
   */
  slaHours: CareSlaHours;
  measuredAt: Date;
};

/** Một dòng lịch sử case — chỉ thêm. */
export type CareEvent = {
  id: string;
  at: Date;
  actor: string;
  source: CareEventSource;
  action: CareEventAction;
  note: string;
  previousStatus: CareStatus | null;
  nextStatus: CareStatus | null;
  previousOwner: string | null;
  nextOwner: string | null;
  followUpAt: Date | null;
  sla: { queueSince: string; firstResponseDueAt: string; resolveDueAt: string; firstResponseBreached: boolean; resolveBreached: boolean } | null;
  payload: unknown;
};

/** Toàn bộ bối cảnh một kiện — cho ngăn kéo và cho AI tóm tắt. */
export type CareCaseDetail = {
  shipment: {
    id: string;
    tracking: string;
    carrier: string;
    stage: string;
    stageLabel: string;
    rawStatus: string;
    codAmount: number;
    receiver: { name: string; phone: string; address: string };
    attemptNo: number | null;
    trackingCapability: "API_TRACKABLE" | "WEBHOOK_ONLY" | "UNKNOWN_CAPABILITY";
    /**
     * MÃ VIETTEL POST THẬT — chỉ `shipments.vtp_order_number`. Đứng riêng khỏi `tracking` (đã bị
     * `coalesce` sang mã Pancake / id ERP) vì CHỈ cột này dựng được liên kết tra cứu: tra bằng mã
     * Pancake trên viettelpost.vn ra "không tìm thấy", và một liên kết sai tệ hơn không có.
     */
    vtpOrderNumber: string | null;
    /** ĐVVC ĐANG LÀM GÌ ở mức chi tiết — `stage` gộp "chờ phát lại" với "tồn - khách nghỉ" làm một. */
    substate: CarrierSubstate;
    substateLabel: string;
    /** Số lần bưu tá phát hụt, đếm từ chứng từ hành trình. */
    failedAttempts: number;
    /** Giờ kể từ tin ĐVVC gần nhất. `null` = CHƯA CÓ TIN NÀO, không phải 0 giờ. */
    ageHours: number | null;
    vtpStatus: number | null;
    /**
     * ERP ĐÃ KHAI TÀI KHOẢN API VIETTEL POST CHƯA — máy chủ trả lời, màn hình KHÔNG đoán.
     *
     * Trước đây panel gán cứng `configured: true` khi xét điều kiện, nên nút "Yêu cầu phát lại trên
     * VTP" vẫn sáng trên một ERP chưa khai tài khoản: bấm vào là một lời từ chối. Một nút bấm-không-
     * chạy dạy người dùng bỏ qua nút, và lần nút đó thật sự hỏng thì không ai báo nữa.
     *
     * Cờ này CHỈ chi phối khối "Thao tác Viettel Post". Ba nút kết quả care KHÔNG đọc nó.
     */
    carrierConfigured: boolean;
  };
  /**
   * ĐƠN HÀNG — VÀ ĐỦ SỐ ĐỂ GIẢI THÍCH VÌ SAO COD KHÁC TỔNG SẢN PHẨM.
   *
   * Người trực nhìn "sản phẩm 998.000" cạnh "COD 749.000" rồi phải đoán: khách được giảm giá?
   * trả trước một phần? phí ship shop chịu? gõ nhầm? Mỗi lần đoán là một cuộc gọi hỏi lại kế toán.
   * Các con số dưới đây đến thẳng từ Pancake (`orders`), KHÔNG tính lại ở ERP — ERP chỉ BÀY phép
   * cộng ra để người đọc tự đối chiếu, và khi phép cộng không khớp thì NÓI THẲNG là không khớp
   * chứ không sửa hộ một con số nào.
   *
   *  · `subtotal`   — `orders.total_price` (tiền hàng trước giảm)
   *  · `discount`   — `orders.total_discount`
   *  · `shippingFee`— `orders.shipping_fee` (phần khách trả)
   *  · `total`      — `orders.total_price_after_discount`
   *  · `prepaid`    — đã trả trước (chuyển khoản + tiền mặt + cọc)
   *
   * `itemsTruncated` = danh sách mặt hàng đã bị cắt bớt ⇒ TUYỆT ĐỐI không được cộng các dòng đang
   * hiện rồi gọi đó là tổng tiền hàng.
   */
  order: {
    id: string;
    systemId: number | null;
    total: number;
    prepaid: number;
    subtotal: number | null;
    discount: number | null;
    shippingFee: number | null;
    items: { name: string; qty: number; price: number; isBonus: boolean }[];
    itemsTruncated: boolean;
    chatUrl: string | null;
  } | null;
  customer: { name: string; phone: string; history: { delivered: number; returned: number; totalOrders: number } | null };
  /** Hành trình ĐVVC thô, mới nhất trước. */
  journey: { at: Date; status: string; note: string; location: string; source: string }[];
  care: CareState;
  queueSince: Date | null;
  sla: CareSlaView | null;
  events: CareEvent[];
  careActions: { kind: string; label: string; note: string; actor: string; at: Date }[];
  /**
   * NHẬT KÝ KẾT QUẢ XỬ LÝ — `care_decisions`, chỉ thêm, mới nhất trước. Ai đã quyết gì, lúc nào,
   * lý do gì, hẹn gì — VÀ ảnh chụp chiều ĐVVC lúc bấm, để đọc lại vẫn thấy hai chiều là hai chiều.
   */
  decisions: {
    id: string;
    at: Date;
    actor: string;
    decision: CareDecision;
    reasonCode: string | null;
    note: string;
    previousCareStatus: string | null;
    nextCareStatus: string | null;
    followUpAt: Date | null;
    /** Viettel Post đang nói gì LÚC người bấm — không tính lại theo hôm nay. */
    carrierStageAtDecision: string;
    carrierSubstateAtDecision: string;
  }[];
  /**
   * NHẬT KÝ LỆNH GỬI ĐVVC — `care_business_actions`, chỉ thêm. Đứng RIÊNG khỏi `decisions`: cái
   * trên là lời khai của người, cái này là một lệnh đã (hoặc chưa) đi tới Viettel Post.
   */
  carrierDecisions: {
    id: string;
    at: Date;
    actor: string;
    action: BusinessAction;
    reasonCode: string | null;
    note: string;
    carrierResult: string | null;
  }[];
  carrierRequests: CarrierRequestView[];
  capabilities: CarrierCapabilityView[];
};

/** Kết quả chuẩn của mọi hàm ghi. */
export type CareResult<T> = { ok: true; data: T } | { error: string };
/** Kết quả hàng loạt: kiện nào đổi được, kiện nào bị bỏ qua và vì sao. */
export type CareBulkResult = { states: Record<string, CareState>; skipped: { shipmentId: string; reason: string }[] };
