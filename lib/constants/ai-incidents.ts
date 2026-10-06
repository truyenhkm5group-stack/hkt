import type { TechIncidentSeverity } from "@/lib/constants/tech";

/**
 * ═══════════ KHOÁ AI HỎNG → SỰ CỐ — HÀM THUẦN, KHÔNG ĐỌC CSDL ═══════════
 *
 * ─── ĐÃ XẢY RA THẬT, VÀ KHÔNG GÌ BÁO (20/09/2026) ───
 *
 * 21:48 VN, lượt chạy agent thứ 10 dừng ở bước kiểm khoá:
 *
 *     ✗ [QUOTA_OR_RATE_LIMIT] 400 … "Your credit balance is too low to access the Anthropic API."
 *
 * Tài khoản Anthropic hết credit. Lượt gọi Copilot thành công cuối cùng đo được là 21:19 — nghĩa
 * là credit cạn đâu đó trong nửa tiếng giữa hai mốc ấy, nhiều khả năng do chính bốn lượt chạy
 * agent trước đó tiêu hết.
 *
 * **Không màn hình nào báo.** `tech-incident-watch` chỉ nhìn `sync_runs`, mà đây không phải job
 * đồng bộ. Thẻ sức khoẻ AI thì chỉ đếm `ai_interactions`, nên nó chỉ biết sau khi đã có người
 * dùng đâm vào tường. Một sự cố kiểu "cần người trả tiền" mà phải chờ người dùng phát hiện hộ là
 * đúng thứ một phòng Tech tự động sinh ra để tránh.
 *
 * ─── VÌ SAO TÁCH "HẾT CREDIT" KHỎI "QUÁ HẠN MỨC" ───
 *
 * `scripts/agent-runner-check.ts::classifyProviderError` gộp cả hai vào `QUOTA_OR_RATE_LIMIT`, và
 * với MỤC ĐÍCH CỦA NÓ thì đúng: cả hai đều là "đừng chạy lúc này". Nhưng với một sự cố thì hai
 * thứ ấy ngược nhau:
 *
 *   · quá hạn mức  → **tự khỏi** sau vài phút. Mở sự cố là đổ nhiễu vào sổ.
 *   · hết credit   → **không bao giờ tự khỏi**. Chờ đợi chỉ làm nó kéo dài.
 *   · khoá sai/hết hạn → cũng không tự khỏi, và cũng cần người.
 *
 * Gộp lại thì hoặc ta bỏ sót cái thứ hai, hoặc ta kêu nhầm ở cái thứ nhất. Nên ở đây chúng là ba
 * lớp riêng.
 */

export const AI_ERROR_CLASSES = ["CREDIT", "AUTH", "RATE_LIMIT", "OTHER"] as const;
export type AiErrorClass = (typeof AI_ERROR_CLASSES)[number];

/** Lớp nào KHÔNG tự khỏi — chỉ những lớp này mới mở sự cố. */
export const AI_CLASSES_CAN_NGUOI: readonly AiErrorClass[] = ["CREDIT", "AUTH"];

export const AI_INCIDENT_RULE = {
  /**
   * Hai lượt LIÊN TIẾP, không phải ba.
   *
   * `sync-incident-watch` đòi ba vì một job đồng bộ hỏng một lượt thường là mạng chập. Lỗi hết
   * credit thì khác: nó TỰ MÔ TẢ chính nó ("credit balance is too low") và không bao giờ tự khỏi,
   * nên chờ tới lượt thứ ba là chờ thêm một người dùng nữa đâm vào tường mà không thu được thông
   * tin gì mới. Hai lượt đủ để loại một lần đọc nhầm chuỗi, và không hơn.
   */
  consecutiveErrors: 2,
  /** Chỉ xét lượt gọi trong bấy nhiêu giờ — cùng lý do với sổ sự cố đồng bộ. */
  lookbackHours: 24,
  /**
   * SEV2, giống mọi sự cố mở tự động.
   *
   * Cám dỗ là đặt SEV1 vì "AI chết hẳn". Nhưng máy KHÔNG đo được hậu quả kinh doanh: ERP vẫn bán
   * hàng bình thường khi Copilot tắt. Đặt sẵn một thang cao là để máy khẳng định thứ nó không
   * quan sát được (mục 8.4). SEV2 = người trực phải xem; nâng lên là quyền của người.
   */
  severity: "SEV2" as TechIncidentSeverity,
} as const;

/**
 * Xếp lớp một thông báo lỗi của nhà cung cấp AI.
 *
 * Thứ tự kiểm là CÓ Ý: chuỗi "credit balance" cũng khớp mẫu hạn mức ở nhiều thư viện, nên phải
 * hỏi nó TRƯỚC — hỏi sau thì mọi lần hết credit đều bị gọi nhầm thành "chờ tí là khỏi".
 */
export function classifyAiError(message: string | null | undefined): AiErrorClass {
  const s = (message ?? "").toLowerCase();
  if (!s.trim()) return "OTHER";
  if (/credit balance|insufficient[_ ]?quota|insufficient[_ ]?funds|billing|payment required|exceeded your current quota|prepayment credits|credits? (?:are |is )?depleted/.test(s)) return "CREDIT";
  if (/\b401\b|\b403\b|unauthor|invalid[_ ]?api[_ ]?key|authentication|permission/.test(s)) return "AUTH";
  if (/\b429\b|rate[_ ]?limit|too many requests|overloaded|\b529\b/.test(s)) return "RATE_LIMIT";
  return "OTHER";
}

/**
 * ─── LỚP LỖI ĐỂ CHUYỂN NHÀ CUNG CẤP (06/10/2026 — lib/sales-chatbot/provider-failover.ts) ───
 *
 * `classifyAiError` giữ NGUYÊN bốn lớp: sổ sự cố, câu cho chủ shop (`salesBotError`) và bài kiểm cũ đứng trên nó — «Request
 * timed out.» vẫn là `OTHER` ở đó. Việc CHUYỂN sang khoá dự phòng cần mịn hơn, vì câu hỏi khác hẳn: «gọi lại cùng câu này ở
 * nhà cung cấp KHÁC có khả năng được không?»
 *
 *   · CREDIT · AUTH · MODEL_UNAVAILABLE — lỗi của TÀI KHOẢN / cấu hình, không tự khỏi ⇒ chuyển, và ngắt mạch lâu.
 *   · RATE_LIMIT · SERVER_ERROR · TIMEOUT — nhà cung cấp đang ốm, tự khỏi ⇒ chuyển; lặp lại nhiều lần mới ngắt mạch ngắn.
 *   · INVALID_REQUEST — chính CÂU HỎI bị từ chối (400 nội dung / sai hình / bộ lọc an toàn) ⇒ KHÔNG chuyển: gửi cùng câu sang
 *     nhà khác là trả tiền hai lần cho cùng một lần hỏng.
 *   · OTHER — chưa đọc được ⇒ KHÔNG chuyển (không đoán).
 *
 * Bốn lớp thô đi trước, nên câu «hết credit» không bao giờ rơi xuống thành «lỗi máy chủ» chỉ vì có số 5xx trong đó.
 */
export const AI_FAILURE_CLASSES = ["CREDIT", "AUTH", "RATE_LIMIT", "MODEL_UNAVAILABLE", "SERVER_ERROR", "TIMEOUT", "INVALID_REQUEST", "OTHER"] as const;
export type AiFailureClass = (typeof AI_FAILURE_CLASSES)[number];

/** Lớp lỗi được CHUYỂN sang nhà cung cấp dự phòng. Ngoài danh sách (nội dung · chưa rõ) ⇒ không chuyển. */
export const AI_FAILOVER_CLASSES: readonly AiFailureClass[] = ["CREDIT", "AUTH", "RATE_LIMIT", "MODEL_UNAVAILABLE", "SERVER_ERROR", "TIMEOUT"];

/** «Model không có / không còn cho khoá này» — một mẫu cho mọi nơi hỏi (engine lùi model · bộ phân loại chuyển provider). */
export const MODEL_UNAVAILABLE_RE = /HTTP 404\b|model[_ ]not[_ ]found|no longer available|is not found for api version|models\/[a-z0-9.-]+ is not found|(?:model|models)\b[^\n]{0,80}\b(?:does not exist|not found|not supported|unknown)/i;

export function classifyAiFailure(message: string | null | undefined): AiFailureClass {
  const coarse = classifyAiError(message);
  if (coarse !== "OTHER") return coarse;
  const raw = message ?? "";
  const s = raw.toLowerCase();
  if (MODEL_UNAVAILABLE_RE.test(raw)) return "MODEL_UNAVAILABLE";
  if (/timed? ?out|timeout|aborted due to timeout|etimedout|deadline exceeded|\b504\b/.test(s)) return "TIMEOUT";
  if (/^\s*5\d\d\b|http 5\d\d\b|status(?: code)?:? 5\d\d\b|internal server error|internal error|service unavailable|bad gateway|server_error|api_error|fetch failed|econnreset|econnrefused|enotfound|eai_again|socket hang up|connection error|network error|other side closed/.test(s)) return "SERVER_ERROR";
  if (/^\s*4\d\d\b|http 4\d\d\b|invalid_request|invalid argument|bad request|validation|safety|content policy|refus/.test(s)) return "INVALID_REQUEST";
  return "OTHER";
}

export type AiRunRow = { status: string; error: string | null };

export type AiIncidentVerdict = { open: false; reason: string } | { open: true; lop: AiErrorClass; soLuot: number; viDu: string };

/**
 * Có nên mở sự cố không — HÀM THUẦN, nhận danh sách ĐÃ SẮP XẾP mới-nhất-trước.
 *
 * Quy tắc: đếm chuỗi lỗi LIÊN TIẾP tính từ lượt gần nhất. Một lượt `OK` cắt chuỗi — AI vừa trả
 * lời được thì nó chưa chết. Chuỗi phải toàn MỘT lớp cần-người: trộn `CREDIT` với `RATE_LIMIT`
 * nghĩa là có lúc nó chỉ bận, và ta chưa đủ căn cứ nói "cần người".
 */
export function shouldOpenAiIncident(rows: readonly AiRunRow[]): AiIncidentVerdict {
  if (!rows.length) return { open: false, reason: "Chưa có lượt gọi AI nào trong cửa sổ — không có bằng chứng nào để kết luận." };
  let lop: AiErrorClass | null = null;
  let dem = 0;
  let viDu = "";
  for (const r of rows) {
    if (r.status !== "ERROR") break; // OK / NEEDS_CONFIRMATION đều cắt chuỗi: AI vừa trả lời được.
    const l = classifyAiError(r.error);
    if (!AI_CLASSES_CAN_NGUOI.includes(l)) break; // hạn mức hay lỗi lạ ⇒ chưa kết luận "cần người".
    if (lop === null) {
      lop = l;
      viDu = (r.error ?? "").replace(/\s+/g, " ").slice(0, 200);
    } else if (lop !== l) {
      break; // đổi lớp giữa chừng ⇒ chuỗi không thuần, dừng đếm.
    }
    dem += 1;
  }
  if (lop === null || dem < AI_INCIDENT_RULE.consecutiveErrors) {
    return { open: false, reason: `Chuỗi lỗi cần-người hiện là ${dem}, chưa đủ ngưỡng ${AI_INCIDENT_RULE.consecutiveErrors}.` };
  }
  return { open: true, lop, soLuot: dem, viDu };
}

/**
 * TIÊU ĐỀ LÀ KHOÁ TỰ NHIÊN — cùng luật với sổ sự cố đồng bộ.
 *
 * Chạy lại bộ canh không được đẻ ra sự cố thứ hai cho cùng một chuyện, và thứ phân biệt hai sự cố
 * là NHÀ CUNG CẤP + LỚP LỖI. Không nhét số lượt hay mốc thời gian vào tiêu đề: chúng đổi mỗi lượt
 * canh, và khoá đổi thì chống-trùng mất tác dụng.
 */
export function aiIncidentTitle(provider: string, lop: AiErrorClass): string {
  const ten: Record<AiErrorClass, string> = {
    CREDIT: "hết credit",
    AUTH: "khoá bị từ chối",
    RATE_LIMIT: "quá hạn mức",
    OTHER: "lỗi chưa phân loại",
  };
  return `Nhà cung cấp AI ${provider}: ${ten[lop]}`;
}

/** Việc phải làm, viết cho người trực đọc lúc 2 giờ sáng — không phải cho lập trình viên. */
export function aiIncidentViecPhaiLam(lop: AiErrorClass, provider: string): string {
  if (lop === "CREDIT") {
    return [
      `Tài khoản ${provider} hết credit. Nó KHÔNG tự khỏi — phải nạp tiền.`,
      "Hệ quả: AI Copilot trong ERP ngừng trả lời, và mọi lượt chạy agent của Phòng Tech dừng ở bước kiểm khoá.",
      "ERP vẫn bán hàng, đồng bộ đơn và vận đơn bình thường — đây KHÔNG phải sự cố kinh doanh.",
      `Đường vòng tạm: đặt AI_PROVIDER sang nhà cung cấp còn credit (nếu có khoá), hoặc AI_PROVIDER=off để màn hình nói "chưa bật" thay vì báo lỗi.`,
    ].join(" ");
  }
  if (lop === "AUTH") {
    return [
      `${provider} từ chối khoá đang dùng (hết hạn, bị thu hồi, hoặc sai).`,
      "Thay khoá trong .env của máy chủ rồi khởi động lại container.",
      "Nó KHÔNG tự khỏi.",
    ].join(" ");
  }
  return `${provider} đang trả lỗi lặp lại. Xem nhật ký để biết thêm.`;
}
