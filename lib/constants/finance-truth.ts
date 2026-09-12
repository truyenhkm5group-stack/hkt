/**
 * ═══════════════ SỰ THẬT TÀI CHÍNH: NĂM SỔ, KHÔNG PHẢI MỘT ═══════════════
 *
 * Hợp đồng đầy đủ: `docs/finance-truth-contract.md`.
 *
 * ERP có năm cuốn sổ nói về tiền, và chúng KHÔNG suy ra lẫn nhau. Mỗi lần một màn hình mượn kết
 * luận của sổ này cho câu hỏi của sổ kia là một lần con số ra quyết định bị bịa:
 *
 *   TIỀN MẶT      (`bank_transactions`)  — đồng nào đã thật sự vào/ra tài khoản, theo ngày ngân hàng ghi.
 *   CHI PHÍ       (Profit Engine)        — kỳ nào hưởng lợi ích, theo nguồn có thẩm quyền.
 *   ĐỐI SOÁT ĐVVC (bảng kê COD)          — ĐVVC đã chốt và trả bao nhiêu, theo từng dòng bảng kê.
 *   NGHĨA VỤ LƯƠNG(cấu hình lương)       — kỳ này shop NỢ nhân sự bao nhiêu.
 *   KẾT QUẢ ĐƠN   (`ORDER_OUTCOME`)      — đơn tới tay khách hay quay về, theo chứng từ ĐVVC.
 *
 * BA ĐIỀU CẤM, cả ba đều đã từng xảy ra ở kho mã này:
 *
 *  1. **Mọi tiền ra là chi phí.** Trả lương ngày 05/10 cho tháng 9 là TIỀN của tháng 10 và CHI PHÍ
 *     của tháng 9. Sinh một khoản chi từ dòng sao kê thì cùng một đồng bị trừ hai lần, lần thứ hai
 *     còn rơi sai kỳ. Mua tài sản, trả nợ gốc, rút vốn: tiền ra, không phải chi phí.
 *  2. **Mọi tiền vào là doanh thu.** Chủ shop bơm vốn, ngân hàng giải ngân, chuyển giữa hai tài
 *     khoản của chính mình — tiền vào, không phải bán được hàng. Và tiền COD ĐVVC trả về là tiền
 *     của doanh thu ĐÃ ghi khi đơn giao thành công: cộng lần nữa là đếm đôi doanh thu.
 *  3. **Tiền chứng minh đã giao hàng.** Không. Chiều logistics chỉ kết luận bằng chứng từ ĐVVC
 *     (`docs/business-rules/ORDER_OUTCOME.md`). Tệp này KHÔNG được dùng để suy ra `DELIVERED`.
 *
 * NỐI ≠ GHI NHẬN. Nối một dòng tiền với một chứng từ chỉ trả lời "đồng tiền này ứng với khoản nào".
 * Nó không tạo chi phí, không tạo doanh thu, không đổi kết quả đơn. Nó chỉ làm cho hai cuốn sổ
 * KHỚP được với nhau — và cho phép trả lời "khoản chi này đã trả tiền chưa".
 */

/** Năm cuốn sổ. Mỗi cuốn có ĐÚNG MỘT nguồn có thẩm quyền. */
export const TRUTH_DOMAINS = ["CASH", "EXPENSE", "CARRIER_SETTLEMENT", "PAYROLL", "ORDER_OUTCOME"] as const;
export type TruthDomain = (typeof TRUTH_DOMAINS)[number];

export type TruthDomainSpec = {
  label: string;
  /** Bảng / hàm cầm quyền. Không nguồn nào khác được trả lời câu hỏi của sổ này. */
  authority: string;
  /** Hạt: một dòng của sổ này là một cái gì. */
  grain: string;
  /** Câu hỏi sổ này trả lời được. */
  answers: string;
  /** Câu hỏi sổ này TUYỆT ĐỐI không được trả lời — có người sẽ thử, nên viết ra. */
  neverAnswers: string;
};

export const TRUTH_DOMAIN_SPEC: Record<TruthDomain, TruthDomainSpec> = {
  CASH: {
    label: "Tiền mặt",
    authority: "bank_transactions (sao kê + SePay)",
    grain: "một giao dịch ngân hàng",
    answers: "Đồng nào đã vào/ra tài khoản, ngày nào, số dư còn bao nhiêu.",
    neverAnswers: "Kỳ này chi phí bao nhiêu · doanh thu bao nhiêu · đơn nào đã giao.",
  },
  EXPENSE: {
    label: "Chi phí",
    authority: "lib/queries/cost-engine.ts::getRecognizedCosts",
    grain: "một thành phần chi phí của một kỳ",
    answers: "Kỳ này hưởng lợi ích từ bao nhiêu chi phí, theo nguồn có thẩm quyền.",
    neverAnswers: "Tiền đã đi ra chưa · đi ra ngày nào.",
  },
  CARRIER_SETTLEMENT: {
    label: "Đối soát ĐVVC",
    authority: "cod_statement_lines / cod_batches",
    grain: "một dòng bảng kê của một vận đơn",
    answers: "ĐVVC đã chốt trả bao nhiêu cho vận đơn nào, trừ cước bao nhiêu.",
    neverAnswers: "Đơn có giao thành công không (ĐVVC ghi “giao thành công” cho cả chiều hoàn).",
  },
  PAYROLL: {
    label: "Nghĩa vụ lương",
    authority: "lib/queries/payroll-cost.ts::getRecognizedPayrollCost",
    grain: "một kỳ lương",
    answers: "Kỳ này shop nợ nhân sự bao nhiêu (phát sinh, chưa cần trả).",
    neverAnswers: "Đã trả chưa — đó là câu hỏi của sổ TIỀN MẶT.",
  },
  ORDER_OUTCOME: {
    label: "Kết quả đơn",
    authority: "lib/queries/return-rate.ts::ORDER_OUTCOME",
    grain: "một đơn hàng",
    answers: "Đơn tới tay khách, quay về, hay bị huỷ.",
    neverAnswers: "Tiền đã về tài khoản chưa.",
  },
};

/**
 * ═══════ LOẠI CHỨNG TỪ MỘT DÒNG TIỀN CÓ THỂ NỐI TỚI ═══════
 *
 * Bốn loại đầu đã có từ trước (`lib/constants/bank.ts::BANK_LINK_TYPES`), giữ nguyên tên để dữ liệu
 * đã nối không phải viết lại. Hai loại sau là phần thiếu khiến sổ tiền không bao giờ khớp được:
 *
 *  · `PAYROLL_PERIOD`  — nghĩa vụ lương của MỘT KỲ (`YYYY-MM`). Bảng Lương là cấu hình chứ không
 *    phải bảng dữ liệu nên không có `id` để nối; khoá tự nhiên của một kỳ lương chính là tháng của
 *    nó. Nhờ vậy trả lời được "lương tháng 9 đã trả chưa" mà KHÔNG phải dựng thêm một phân hệ tài
 *    chính thứ hai.
 *  · `BANK_TRANSACTION` — chân kia của một lần CHUYỂN NỘI BỘ. Tiền rời tài khoản A và vào tài khoản
 *    B là HAI dòng sao kê của cùng MỘT sự kiện; không ghép được hai chân thì dòng tiền công ty vừa
 *    cộng tiền ra vừa cộng tiền vào cho một đồng không hề rời khỏi shop.
 */
export const LINK_TARGET_TYPES = ["EXPENSE", "COD_BATCH", "STOCK_RECEIPT", "AD_SPEND", "PAYROLL_PERIOD", "BANK_TRANSACTION"] as const;
export type LinkTargetType = (typeof LINK_TARGET_TYPES)[number];

export const LINK_TARGET_LABEL: Record<LinkTargetType, string> = {
  EXPENSE: "Khoản chi ở bảng Chi phí",
  COD_BATCH: "Đợt nhận tiền COD",
  STOCK_RECEIPT: "Phiếu nhập kho",
  AD_SPEND: "Chi tiêu quảng cáo",
  PAYROLL_PERIOD: "Kỳ lương",
  BANK_TRANSACTION: "Chân kia của lần chuyển nội bộ",
};

/** Sổ mà chứng từ đích thuộc về — để không ai nối một dòng tiền vào chính sổ tiền rồi cộng hai lần. */
export const LINK_TARGET_DOMAIN: Record<LinkTargetType, TruthDomain> = {
  EXPENSE: "EXPENSE",
  COD_BATCH: "CARRIER_SETTLEMENT",
  STOCK_RECEIPT: "EXPENSE",
  AD_SPEND: "EXPENSE",
  PAYROLL_PERIOD: "PAYROLL",
  BANK_TRANSACTION: "CASH",
};

/** Khoá tự nhiên của một kỳ lương: `YYYY-MM`. */
export const PAYROLL_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * MỨC TIN CẬY ĐƯỢC GHI LẠI CÙNG MỐI NỐI.
 *
 * `AMBIGUOUS` và `UNMATCHED` cố ý KHÔNG có mặt: một mối nối đã lưu là một KHẲNG ĐỊNH ("đồng tiền
 * này chính là khoản kia"), mà nhập nhằng thì theo định nghĩa không khẳng định được. Chúng chỉ tồn
 * tại ở tầng gợi ý (`lib/integrations/bank/match.ts`) và phải có người chọn mới thành mối nối.
 */
export const LINK_CONFIDENCES = ["EXACT", "HIGH_CONFIDENCE", "MANUAL"] as const;
export type LinkConfidence = (typeof LINK_CONFIDENCES)[number];

export const LINK_CONFIDENCE_LABEL: Record<LinkConfidence, string> = {
  EXACT: "Khớp mã chứng từ",
  HIGH_CONFIDENCE: "Khớp tiền + ngày, người xác nhận",
  MANUAL: "Người nối tay",
};

/** Cách máy/người đi tới mối nối này — để sau còn truy được vì sao nó tồn tại. */
export const LINK_METHODS = ["IDENTIFIER_MATCH", "AMOUNT_DATE_MATCH", "MANUAL", "TRANSFER_PAIR"] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];

export const LINK_METHOD_LABEL: Record<LinkMethod, string> = {
  IDENTIFIER_MATCH: "Nội dung chuyển khoản chứa mã chứng từ",
  AMOUNT_DATE_MATCH: "Số tiền và ngày khớp, chỉ một ứng viên",
  MANUAL: "Người chọn",
  TRANSFER_PAIR: "Ghép hai chân của một lần chuyển nội bộ",
};

/**
 * CHỈ `EXACT` ĐƯỢC TỰ NỐI. Giữ đúng luật đã có ở `lib/integrations/bank/match.ts::AUTO_CONFIRMABLE`
 * và nhắc lại ở đây vì tệp này là nơi người đọc tìm luật, không phải tầng tích hợp.
 *
 * Nới luật này là nới thẳng vào số liệu ra quyết định: một mối nối sai đánh dấu chứng từ "đã trả"
 * trong khi tiền thật đi chỗ khác, và cả hai sổ cùng lúc mất tin cậy.
 */
export const LINK_AUTO_CONFIRMABLE: Record<LinkConfidence, boolean> = {
  EXACT: true,
  HIGH_CONFIDENCE: false,
  MANUAL: false,
};

/** `confirmed_by` của mối nối do máy tự tạo — phân biệt với email người thật. */
export const LINK_AUTO_ACTOR = "auto:exact";

/**
 * ═══════ PHÂN BỔ MỘT DÒNG TIỀN CHO NHIỀU CHỨNG TỪ ═══════
 *
 * Một chuyển khoản 30 triệu có thể trả hai phiếu nhập 20 + 10. Một khoản chi 20 triệu có thể được
 * trả làm ba lần. Cả hai đều là chuyện thường ngày, và cả hai đều KHÔNG diễn tả được bằng một ô
 * `linked_id` duy nhất trên dòng tiền — đó là lý do bảng `bank_transaction_links` tồn tại.
 *
 * LUẬT BẤT BIẾN: tổng phân bổ của một dòng tiền KHÔNG ĐƯỢC vượt trị tuyệt đối số tiền của nó. Vượt
 * nghĩa là cùng một đồng đang được dùng để đánh dấu hai nghĩa vụ khác nhau đã trả — đúng kiểu đếm
 * đôi mà cả tệp này sinh ra để chặn.
 */
export const ALLOCATION_STATES = ["UNALLOCATED", "PARTIAL", "FULL", "OVER"] as const;
export type AllocationState = (typeof ALLOCATION_STATES)[number];

export const ALLOCATION_STATE_LABEL: Record<AllocationState, string> = {
  UNALLOCATED: "Chưa nối chứng từ nào",
  PARTIAL: "Mới nối một phần",
  FULL: "Đã nối đủ",
  OVER: "Nối VƯỢT số tiền thật",
};

export type Allocation = {
  /** Trị tuyệt đối số tiền của dòng tiền. */
  total: number;
  allocated: number;
  /** Còn lại chưa nối. Âm nghĩa là đã nối vượt — phải nêu ra, không được làm tròn về 0. */
  remaining: number;
  state: AllocationState;
};

/** Hàm thuần: kiểm thử được từng luật mà không cần cơ sở dữ liệu. */
export function allocationOf(txnAmount: number, linkAmounts: readonly number[]): Allocation {
  const total = Math.abs(Math.round(txnAmount));
  const allocated = linkAmounts.reduce((t, v) => t + Math.abs(Math.round(v)), 0);
  const remaining = total - allocated;
  const state: AllocationState = allocated === 0 ? "UNALLOCATED" : remaining < 0 ? "OVER" : remaining === 0 ? "FULL" : "PARTIAL";
  return { total, allocated, remaining, state };
}

/**
 * Số tiền tối đa còn có thể phân bổ thêm cho một dòng tiền.
 *
 * Trả 0 khi đã đầy — người gọi phải TỪ CHỐI mối nối mới chứ không được cắt bớt im lặng: cắt bớt là
 * ghi một con số không ai yêu cầu vào sổ đối chiếu.
 */
export function remainingCapacity(txnAmount: number, linkAmounts: readonly number[]): number {
  return Math.max(0, allocationOf(txnAmount, linkAmounts).remaining);
}

export function isLinkTargetType(v: string): v is LinkTargetType {
  return (LINK_TARGET_TYPES as readonly string[]).includes(v);
}
