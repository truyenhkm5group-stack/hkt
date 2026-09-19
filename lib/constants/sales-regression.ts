/**
 * BỘ CA HỒI QUY CHO NHÂN SỰ BÁN HÀNG — hợp đồng dữ liệu, và chỉ hợp đồng.
 *
 * VÌ SAO NÓ PHẢI TỒN TẠI. Bộ kiểm thử hiện có khoá từng HÀM (bóc ý định, quyết định, xác nhận).
 * Nhưng cái hỏng trong bán hàng qua chat hiếm khi là một hàm — nó là một DÂY CHUYỀN đi sai ở lượt
 * thứ hai: khách chốt "đỏ đô / XL" rồi nhắn "vâng", và chữ "vâng" ngắn quá nên lượt sau mất luôn
 * mẫu mã. Không hàm nào sai, cả dây chuyền vẫn sai. Chỉ có một ca NHIỀU LƯỢT mới bắt được.
 *
 * BA QUYẾT ĐỊNH THIẾT KẾ, và mỗi cái đều có một cách hỏng mà nó tránh:
 *
 *   1. **Ca chụp lại CẢ KẾT QUẢ CÔNG CỤ ERP.** Chạy lại một ca không được phép hỏi CSDL: tồn kho
 *      hôm nay khác hôm ghi ca, và một bài kiểm đỏ vì kho vừa bán hết hàng là bài kiểm không ai
 *      đọc nữa (AGENTS.md mục 50). Ca mang theo đúng những gì công cụ đã trả lúc ấy, nên nó đo
 *      DÂY CHUYỀN chứ không đo cái kho.
 *
 *   2. **Mốc thời gian trong ca là TƯƠNG ĐỐI với chính ca đó** (`minutesFromStart`), và đồng hồ
 *      chạy lại do trình chạy cấp. Ghim một ngày tuyệt đối rồi gieo dữ liệu quanh nó là quả bom
 *      hẹn giờ đã nổ hai lần trong kho mã này.
 *
 *   3. **Kỳ vọng nào không khai thì KHÔNG KIỂM.** `null` = người soát chưa quyết chiều ấy, không
 *      phải "phải bằng rỗng". Một bộ ca ép khai đủ mười hai chiều sẽ được khai bừa cho xong.
 *
 * KHÔNG khớp từng chữ câu trả lời. Chữ nghĩa đổi theo mô hình và theo lời văn; thứ phải giữ nguyên
 * là NGHIỆP VỤ: hiểu đúng ý, giữ đúng mẫu mã, chọn đúng việc, chuyển người đúng lúc. Ràng buộc câu
 * chữ vì vậy chỉ có hai dạng — PHẢI CÓ (một con số, một từ khoá) và TUYỆT ĐỐI KHÔNG ĐƯỢC CÓ (một
 * lời hứa máy không được phép nói).
 */
import type { SalesAction, SalesStage, HandoffReason } from "@/lib/constants/sales-agent";

/** Ý định — khai lại dạng chuỗi để tệp này không kéo theo mã của dây chuyền. */
export type RegressionIntent = string;

/** Một tin của khách trong ca. Chỉ tin KHÁCH gửi: tin của shop không kích hoạt lượt chạy nào. */
export type RegressionMessage = {
  text: string;
  /**
   * Phút kể từ tin đầu tiên của ca. Trình chạy cộng vào mốc bắt đầu do NÓ cấp.
   * Số tuyệt đối ở đây là cách chắc chắn nhất để ca đỏ vào một sáng thứ Tư nào đó.
   */
  minutesFromStart: number;
};

/**
 * Kết quả công cụ ERP đã ghi lại. Khoá là tên công cụ (`product.get_variants`, `pricing.get`,
 * `inventory.check`, `size.recommend`). Giá trị `null` = công cụ ấy LỖI trong ca này — đó là một
 * tình huống phải kiểm được, không phải một ô để trống.
 */
export type RegressionToolResults = Record<string, unknown>;

export type RegressionContext = {
  humanTakeover: boolean;
  orderCreated: boolean;
  stale: boolean;
  /** `null` = CHƯA BIẾT tồn ⇒ máy không được hứa còn hàng. */
  canPromiseStock: boolean | null;
};

/** Ô kỳ vọng về thực thể. Ô nào `undefined` là KHÔNG KIỂM chiều đó. */
export type RegressionExpectedState = {
  size?: string;
  color?: string;
  phone?: string;
  quantity?: number;
  purchaseIntent?: boolean;
  hasVariant?: boolean;
  productName?: string;
};

export type RegressionExpectation = {
  /** Ý định của lượt CUỐI. `null` = không kiểm. Kiểm theo phép CHỨA: máy đọc thêm ý định phụ không phải là sai. */
  intents: RegressionIntent[] | null;
  stage: SalesStage | null;
  action: SalesAction | null;
  /** `true` = phải chuyển người · `false` = KHÔNG được chuyển người · `null` = không kiểm. */
  handoff: boolean | null;
  handoffReason: HandoffReason | null;
  state: RegressionExpectedState;
  /** Câu máy soạn PHẢI chứa (so sau khi bỏ dấu, không phân biệt hoa thường). */
  replyMustContain: string[];
  /** Câu máy soạn TUYỆT ĐỐI KHÔNG được chứa. */
  replyMustNotContain: string[];
};

export const EMPTY_EXPECTATION: RegressionExpectation = {
  intents: null,
  stage: null,
  action: null,
  handoff: null,
  handoffReason: null,
  state: {},
  replyMustContain: [],
  replyMustNotContain: [],
};

export type RegressionCase = {
  /** Khoá ổn định, đọc được — in ra trong báo cáo thất bại. */
  key: string;
  title: string;
  /** SEED = ca dựng sẵn trong kho mã · REVIEW = ca người soát bấm thêm từ `/ai/review`. */
  origin: "SEED" | "REVIEW";
  messages: RegressionMessage[];
  /** Trạng thái hội thoại TRƯỚC tin đầu tiên của ca. Khai thưa; ô thiếu rơi về mặc định rỗng. */
  priorState: Record<string, unknown>;
  priorStage: SalesStage;
  toolResults: RegressionToolResults;
  context: RegressionContext;
  expected: RegressionExpectation;
  /** Dấu vết về nơi ca sinh ra — hội thoại nào, lượt gợi ý nào. Rỗng với ca dựng sẵn. */
  sourceConversationId: string;
  sourceSuggestionId: string;
  pageId: string;
};

/**
 * VÌ SAO MỘT CA TRƯỢT — mỗi mã là MỘT chỗ phải đi sửa, và hai chỗ khác nhau thì không được gộp mã.
 *
 * `ERROR` đứng riêng khỏi mọi mã còn lại: dây chuyền NÉM là "không đo được", khác hẳn "đo được và
 * ra sai". Gộp chúng thì một lỗi hạ tầng trông y như một lỗi nghiệp vụ, và người đọc đi sửa nhầm chỗ.
 */
export const REGRESSION_FAILURES = [
  "WRONG_INTENT",
  "WRONG_STAGE",
  "WRONG_ACTION",
  "WRONG_HANDOFF",
  "WRONG_HANDOFF_REASON",
  "LOST_STATE",
  "REPLY_MISSING_REQUIRED",
  "REPLY_SAID_FORBIDDEN",
  "ERROR",
] as const;
export type RegressionFailure = (typeof REGRESSION_FAILURES)[number];

export const REGRESSION_FAILURE_LABEL: Record<RegressionFailure, string> = {
  WRONG_INTENT: "Đọc sai ý định của khách",
  WRONG_STAGE: "Giai đoạn bán sai",
  WRONG_ACTION: "Chọn sai việc phải làm tiếp",
  WRONG_HANDOFF: "Chuyển người sai lúc (hoặc không chuyển khi phải chuyển)",
  WRONG_HANDOFF_REASON: "Chuyển người đúng nhưng khai sai lý do",
  LOST_STATE: "Mất dữ liệu đã thu thập đúng từ lượt trước",
  REPLY_MISSING_REQUIRED: "Câu trả lời thiếu thứ bắt buộc phải có",
  REPLY_SAID_FORBIDDEN: "Câu trả lời nói điều KHÔNG được phép nói",
  ERROR: "Dây chuyền ném lỗi — không đo được ca này",
};

/** Ai phải đi sửa khi một ca trượt. Không phải chiều nào cũng là lỗi của mô hình. */
export const REGRESSION_FAILURE_OWNER: Record<RegressionFailure, "MODEL" | "RULES" | "DATA" | "SYSTEM"> = {
  WRONG_INTENT: "MODEL",
  WRONG_STAGE: "RULES",
  WRONG_ACTION: "RULES",
  WRONG_HANDOFF: "RULES",
  WRONG_HANDOFF_REASON: "RULES",
  LOST_STATE: "RULES",
  REPLY_MISSING_REQUIRED: "DATA",
  REPLY_SAID_FORBIDDEN: "MODEL",
  ERROR: "SYSTEM",
};

export type RegressionFinding = {
  failure: RegressionFailure;
  /** Chiều nào — in kèm để người đọc không phải mở ca ra mới hiểu. */
  field: string;
  expected: string;
  actual: string;
};

export type RegressionCaseResult = {
  key: string;
  title: string;
  origin: "SEED" | "REVIEW";
  passed: boolean;
  findings: RegressionFinding[];
  /** Số lượt đã chạy được trước khi kết thúc (hoặc trước khi ném). */
  turnsRun: number;
  durationMs: number;
};

export type RegressionReport = {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  /** Đếm theo loại thất bại — một ca trượt nhiều chiều thì đếm ở từng chiều. */
  byFailure: Record<RegressionFailure, number>;
  cases: RegressionCaseResult[];
  startedAt: string;
  durationMs: number;
};

/** Bỏ dấu + hạ chữ thường để so ràng buộc câu chữ. Cố ý KHÔNG dùng `lib/text` — hàm này phải chạy ở cả client. */
export function looseIncludes(haystack: string, needle: string): boolean {
  const flatten = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase();
  return flatten(haystack).includes(flatten(needle));
}

/**
 * So kết quả một ca với kỳ vọng. HÀM THUẦN — không đọc CSDL, không đọc đồng hồ.
 *
 * Tách khỏi trình chạy có chủ ý: phép SO là thứ phải kiểm thử được mà không cần dựng cả dây chuyền,
 * và nó là chỗ dễ sai nhất (một `!==` đặt nhầm chiều là cả bộ ca xanh vĩnh viễn).
 */
export function compareToExpectation(
  expected: RegressionExpectation,
  actual: {
    intents: string[];
    stage: SalesStage;
    action: SalesAction;
    handoffReason: HandoffReason | null;
    state: { size: string; color: string; phone: string; quantity: number; purchaseIntent: boolean; variantId: string | null; productName: string };
    reply: string;
  },
): RegressionFinding[] {
  const out: RegressionFinding[] = [];

  // Ý ĐỊNH: phép CHỨA, không phải phép bằng. Khách nhắn "lấy cho chị màu đỏ size XL" mang cả
  // PURCHASE_INTENT lẫn PROVIDE_VARIANT; đòi khớp đúng một tập là bắt người soát khai hết mọi ý
  // định phụ, và họ sẽ khai thiếu.
  if (expected.intents) {
    const thieu = expected.intents.filter((i) => !actual.intents.includes(i));
    if (thieu.length) {
      out.push({ failure: "WRONG_INTENT", field: "intents", expected: expected.intents.join(", "), actual: actual.intents.join(", ") || "(rỗng)" });
    }
  }

  if (expected.stage && expected.stage !== actual.stage) {
    out.push({ failure: "WRONG_STAGE", field: "stage", expected: expected.stage, actual: actual.stage });
  }

  if (expected.action && expected.action !== actual.action) {
    out.push({ failure: "WRONG_ACTION", field: "action", expected: expected.action, actual: actual.action });
  }

  if (expected.handoff !== null) {
    const daChuyen = actual.action === "HANDOFF_HUMAN";
    if (daChuyen !== expected.handoff) {
      out.push({ failure: "WRONG_HANDOFF", field: "handoff", expected: expected.handoff ? "CHUYỂN NGƯỜI" : "KHÔNG chuyển người", actual: daChuyen ? "CHUYỂN NGƯỜI" : "KHÔNG chuyển người" });
    }
  }

  // Lý do chuyển người chỉ có nghĩa khi ĐÃ chuyển. Báo "sai lý do" trên một lượt không chuyển
  // người là dựng thêm một lỗi thứ hai từ đúng một lỗi.
  if (expected.handoffReason && actual.action === "HANDOFF_HUMAN" && expected.handoffReason !== actual.handoffReason) {
    out.push({ failure: "WRONG_HANDOFF_REASON", field: "handoffReason", expected: expected.handoffReason, actual: actual.handoffReason ?? "(không có)" });
  }

  const s = expected.state;
  const mat = (field: string, mong: string | number | boolean, thuc: string | number | boolean) => {
    out.push({ failure: "LOST_STATE", field, expected: String(mong), actual: String(thuc) || "(rỗng)" });
  };
  if (s.size !== undefined && s.size.toUpperCase() !== actual.state.size.toUpperCase()) mat("state.size", s.size, actual.state.size);
  if (s.color !== undefined && !looseIncludes(actual.state.color, s.color)) mat("state.color", s.color, actual.state.color);
  if (s.phone !== undefined && s.phone !== actual.state.phone) mat("state.phone", s.phone, actual.state.phone);
  if (s.quantity !== undefined && s.quantity !== actual.state.quantity) mat("state.quantity", s.quantity, actual.state.quantity);
  if (s.purchaseIntent !== undefined && s.purchaseIntent !== actual.state.purchaseIntent) mat("state.purchaseIntent", s.purchaseIntent, actual.state.purchaseIntent);
  if (s.hasVariant !== undefined && s.hasVariant !== Boolean(actual.state.variantId)) mat("state.variantId", s.hasVariant, Boolean(actual.state.variantId));
  if (s.productName !== undefined && !looseIncludes(actual.state.productName, s.productName)) mat("state.productName", s.productName, actual.state.productName);

  for (const phai of expected.replyMustContain) {
    if (!looseIncludes(actual.reply, phai)) {
      out.push({ failure: "REPLY_MISSING_REQUIRED", field: "reply", expected: `chứa "${phai}"`, actual: actual.reply.slice(0, 160) || "(không soạn câu nào)" });
    }
  }
  for (const cam of expected.replyMustNotContain) {
    if (looseIncludes(actual.reply, cam)) {
      out.push({ failure: "REPLY_SAID_FORBIDDEN", field: "reply", expected: `KHÔNG chứa "${cam}"`, actual: actual.reply.slice(0, 160) });
    }
  }

  return out;
}

/** Gom báo cáo từ kết quả từng ca. Hàm thuần — trình chạy chỉ việc in ra. */
export function summarizeRegression(cases: RegressionCaseResult[], startedAt: Date, durationMs: number): RegressionReport {
  const byFailure = Object.fromEntries(REGRESSION_FAILURES.map((f) => [f, 0])) as Record<RegressionFailure, number>;
  for (const c of cases) for (const f of c.findings) byFailure[f.failure] += 1;
  return {
    total: cases.length,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
    errored: cases.filter((c) => c.findings.some((f) => f.failure === "ERROR")).length,
    byFailure,
    cases,
    startedAt: startedAt.toISOString(),
    durationMs,
  };
}
