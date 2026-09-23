import type { AdsAction, DecisionBasis } from "@/lib/constants/ads-decision";
import {
  ACTION_FOR_DECISION,
  ADS_WRITE_DENIAL_REASON,
  ADS_WRITE_LIMITS,
  ALLOW_ADS_WRITE_ON_PROJECTED_BASIS,
  type AdsWriteAction,
  type AdsWriteDenial,
  type AdsWriteMode,
} from "@/lib/constants/ads-write";
import type { Stability } from "@/lib/marketing/decision-stability";

/**
 * ═══════════ CỔNG GHI QUẢNG CÁO — HÀM THUẦN, VÀ ĐÓ LÀ CẢ Ý NGHĨA CỦA NÓ ═══════════
 *
 * Không đọc CSDL, không đọc đồng hồ, không gọi mạng. Vào là một bản khai tình trạng, ra là CHO hay
 * KHÔNG kèm lý do. Nhờ vậy mọi tổ hợp chặn được kiểm bằng vài dòng chữ, không cần dựng CSDL và
 * không cần một tài khoản Facebook thật.
 *
 * ─── HÀM NÀY KHÔNG PHẢI HÀNG RÀO CUỐI CÙNG ───
 *
 * Nó tin vào bản khai mà nơi gọi đưa xuống. Chốt CỨNG nằm ở `lib/integrations/facebook/ads-write.ts`:
 * nó đọc LẠI biến môi trường và đọc LẠI sổ ngay trước lời gọi mạng, và bản khai từ nơi gọi chỉ được
 * dùng để LÀM HẸP thêm, không bao giờ nới ra. Cùng thiết kế với `assertOutboundAllowed()` của nền
 * tảng nhân sự AI, và vì cùng một lý do: muốn ghi được phải đổi DỮ LIỆU, không đổi được bằng cách
 * làm một hàm trả về giá trị khác.
 */

export type BrakeState = {
  on: boolean;
  /** Số lượt đổi ĐO ĐƯỢC gần nhất mà lợi nhuận góp sau quảng cáo đi xuống. */
  consecutiveWorse: number;
  /** Số lượt chưa đo được kết quả — CHƯA BIẾT, không phải "không sao" (mục 42). */
  unmeasured: number;
};

export const BRAKE_OFF: BrakeState = { on: false, consecutiveWorse: 0, unmeasured: 0 };

export type WriteOutcomeObservation = {
  /** Ngày Việt Nam của lượt đổi. */
  changedAt: string;
  /** Lợi nhuận góp sau quảng cáo TRƯỚC lượt đổi, và SAU khi kết quả đã ngã ngũ. `null` = chưa đo được. */
  profitBefore: number | null;
  profitAfter: number | null;
};

/**
 * ───────────── PHANH: MÁY PHẢI BIẾT TỰ NGHI NGỜ MÌNH ─────────────
 *
 * Bật khi `brakeConsecutiveWorse` lượt đổi ĐO ĐƯỢC gần nhất đều làm lợi nhuận đi xuống. Không có
 * phanh thì một luật sai sẽ tự tin hơn sau mỗi lần sai.
 *
 * ─── VÌ SAO LƯỢT CHƯA ĐO ĐƯỢC BỊ BỎ QUA CHỨ KHÔNG CẮT CHUỖI ───
 *
 * Kết quả một lượt đổi chỉ ngã ngũ sau khi đơn của nó đi hết vòng — vài ngày. Nếu một lượt chưa đo
 * được mà CẮT chuỗi thì phanh gần như không bao giờ bật: lượt mới nhất luôn chưa đo được, và nó sẽ
 * che mọi lượt cũ đằng sau.
 *
 * Nhưng bỏ qua trong im lặng thì thành nói dối, nên `unmeasured` đi kèm mọi lần trả về và màn hình
 * phải in nó cạnh con số phanh: "đang xét trên 3 lượt đo được, 2 lượt chưa đo".
 *
 * Chưa đủ `brakeConsecutiveWorse` lượt đo được thì phanh TẮT — và đó là hành vi đúng, không phải
 * một lỗ hổng: giai đoạn đầu được bảo vệ bởi bốn cái trần kia (biên độ · trần ngày · số lần mỗi
 * chiến dịch · cổng độ bền), còn phanh là lớp bảo vệ bậc hai chống một LUẬT sai có hệ thống.
 */
export function brakeState(observations: WriteOutcomeObservation[]): BrakeState {
  const sorted = [...observations].sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : 0));
  let consecutiveWorse = 0;
  let unmeasured = 0;
  for (const o of sorted) {
    if (o.profitBefore === null || o.profitAfter === null) {
      unmeasured += 1;
      continue;
    }
    if (o.profitAfter < o.profitBefore) consecutiveWorse += 1;
    else break;
  }
  return { on: consecutiveWorse >= ADS_WRITE_LIMITS.brakeConsecutiveWorse, consecutiveWorse, unmeasured };
}

/**
 * ═══════════ KẾT LUẬN CÒN NÓI VỀ ĐÚNG CÁI MÀ NÚT NÀY SẼ TÁC ĐỘNG KHÔNG ═══════════
 *
 * Mọi hàng rào khác hỏi về KẾT LUẬN: nó có đứng trên số đo không, có giữ nguyên đủ lâu không. Không
 * hàng rào nào hỏi về CHIẾN DỊCH: nó có còn là thứ mà kết luận đã nhìn thấy không.
 *
 * Và với shop này đó là câu hỏi quyết định. Kỳ chuẩn lùi 15 ngày để số tiền kịp chín (mô hình bán
 * trước), trong khi shop chạy 619 chiến dịch mỗi 14 ngày — một chiến dịch thường chết trước khi bằng
 * chứng về nó kịp chín. Đo production 23/09/2026 trên 8 dòng có khuyến nghị hành động:
 *
 *     6/8 đã TẮT từ 05–09/09 — trong đó 4 dòng đang được khuyên TĂNG NGÂN SÁCH
 *     QA4_Q002_13/08_Linh Tây Luxury_V1: khuyên CẮT, nhưng đã CHẠY LẠI từ 20/09 và tiêu
 *         4.439.115 ₫ sau kỳ, gấp 2,43 lần 1.825.871 ₫ mà kết luận dựa vào
 *
 * Dòng cuối là dòng tôi đã định đưa chủ shop bấm — lần đầu tiên bàn tay chạm vào tiền thật.
 *
 * ─── HAI CÂU HỎI, KHÔNG CÓ NGƯỠNG TỰ ĐẶT ───
 *
 *  · **Nó còn chạy không?** Hỏi thẳng Facebook (`status === "ACTIVE"`), không suy từ số chi. Trạng
 *    thái sống là chứng cứ; "mấy ngày không chi" là một ngưỡng phải bịa ra.
 *  · **Nó có còn là lần chạy đã được đo không?** Tiền SAU kỳ lớn hơn tiền TRONG kỳ ⇒ phần chưa ai
 *    đo đã lớn hơn phần sinh ra kết luận. Ranh giới 1,0 không phải một lựa chọn thẩm mỹ: nó là điểm
 *    mà "kết luận nói về chiến dịch này" thôi đúng hơn "kết luận nói về một chiến dịch khác".
 *
 * CHƯA BIẾT ⇒ không ghi, cùng luật với ngân sách hiện tại chưa đọc được.
 */
export type SubjectState = {
  /** Trạng thái Facebook trả về. `null` = không đọc được. */
  status: string | null;
  spendInWindowVnd: number;
  /** Chi SAU ngày cuối kỳ kết luận. `null` = không đọc được. */
  spendAfterWindowVnd: number | null;
};

export function subjectFreshness(s: SubjectState): { ok: true } | { ok: false; denial: AdsWriteDenial } {
  if (s.status === null || s.spendAfterWindowVnd === null) return { ok: false, denial: "SUBJECT_UNREADABLE" };
  if (s.status !== "ACTIVE") return { ok: false, denial: "SUBJECT_NOT_RUNNING" };
  if (s.spendAfterWindowVnd > s.spendInWindowVnd) return { ok: false, denial: "SUBJECT_CHANGED" };
  return { ok: true };
}

export type GateInput = {
  /** `ADS_WRITE_ENABLED` đọc THẲNG từ biến môi trường. Chốt ngoài cùng. */
  hardEnabled: boolean;
  /** Nấc quyền hạn ĐÃ kẹp bằng `clampAdsWriteMode`. */
  mode: AdsWriteMode;
  /** Người đã bấm xác nhận với một phiếu duyệt hợp lệ chưa. */
  confirmed: boolean;
  decision: AdsAction;
  /** Khuyến nghị đứng trên SỐ ĐO hay trên lợi nhuận TẠM TÍNH. Xem `ALLOW_ADS_WRITE_ON_PROJECTED_BASIS`. */
  basis: DecisionBasis;
  /** Chiến dịch hôm nay còn là thứ mà kết luận đã nhìn thấy không. Xem `subjectFreshness`. */
  subject: SubjectState;
  stability: Stability;
  /** Ngân sách ngày hiện tại (VND). `null` = ERP chưa đọc được ⇒ không đổi được. */
  currentBudgetVnd: number | null;
  /** Ngân sách muốn đặt (VND). Chỉ dùng cho `SET_DAILY_BUDGET`. */
  nextBudgetVnd: number | null;
  /** Tổng trị tuyệt đối đã dịch chuyển hôm nay trên toàn shop. */
  shiftedTodayVnd: number;
  changesForCampaignToday: number;
  brake: BrakeState;
};

export type GateResult =
  | { allow: true; action: AdsWriteAction; deltaVnd: number }
  | { allow: false; denial: AdsWriteDenial; reason: string };

/** Câu kèm theo, bằng số của chính chiến dịch — lý do chặn phải cãi lại được, không chỉ đọc được. */
export function subjectDetail(s: SubjectState): string {
  if (s.status === null) return "";
  if (s.status !== "ACTIVE") return `(Facebook báo: ${s.status}.)`;
  if (s.spendAfterWindowVnd === null) return "";
  const ratio = s.spendInWindowVnd > 0 ? (s.spendAfterWindowVnd / s.spendInWindowVnd).toFixed(2) : "∞";
  return `(Sau kỳ: ${s.spendAfterWindowVnd.toLocaleString("vi-VN")}đ · trong kỳ: ${s.spendInWindowVnd.toLocaleString("vi-VN")}đ · gấp ${ratio} lần.)`;
}

function deny(denial: AdsWriteDenial, extra = ""): GateResult {
  return { allow: false, denial, reason: extra ? `${ADS_WRITE_DENIAL_REASON[denial]} ${extra}` : ADS_WRITE_DENIAL_REASON[denial] };
}

/**
 * THỨ TỰ CÁC CHỐT LÀ MỘT PHẦN CỦA THIẾT KẾ, KHÔNG PHẢI NGẪU NHIÊN.
 *
 * Chốt cứng cấp môi trường đứng TRƯỚC mọi thứ, kể cả trước nấc quyền hạn và phiếu duyệt. Đó là câu
 * trả lời cho *"có tổ hợp cấu hình nào lỡ đổi ngân sách thật không"*: không, vì nhánh đầu tiên
 * không đọc gì ngoài một biến môi trường.
 *
 * Phanh đứng ngay sau nó — trước cả cổng độ bền — vì phanh nói về SỨC KHOẺ CỦA CHÍNH LUẬT, và một
 * luật đang sai thì khuyến nghị "đã chín" của nó cũng không đáng tin.
 */
export function gateAdsWrite(input: GateInput): GateResult {
  if (!input.hardEnabled) return deny("HARD_DISABLED");
  if (input.mode === "OFF") return deny("MODE_OFF");
  if (input.brake.on) return deny("BRAKE_ON", `(${input.brake.consecutiveWorse} lượt xấu liên tiếp, ${input.brake.unmeasured} lượt chưa đo được)`);

  const action = ACTION_FOR_DECISION[input.decision] ?? null;
  if (!action) return deny("NO_ACTION_FOR_DECISION", `Khuyến nghị đang là "${input.decision}".`);

  /*
    CHIẾN DỊCH TRƯỚC, KẾT LUẬN SAU.

    Nếu thứ mà kết luận nói tới đã tắt, hoặc đã thành một lần chạy khác, thì hỏi tiếp kết luận ấy
    đứng trên căn cứ gì hay giữ được bao lâu là vô nghĩa — nó đang mô tả một vật không còn ở đó.
  */
  const tuoi = subjectFreshness(input.subject);
  if (!tuoi.ok) return deny(tuoi.denial, subjectDetail(input.subject));

  /*
    CĂN CỨ ĐỨNG TRƯỚC ĐỘ BỀN, VÀ ĐÓ LÀ CỐ Ý.

    Độ bền hỏi "khuyến nghị này có giữ nguyên nhiều ngày không" — một câu hỏi về SỰ NHẤT QUÁN. Một
    giả định lặp lại mười ngày vẫn là một giả định, nên nó sẽ "chín" đúng như số đo chín, và hỏi
    câu ấy trước là để cái sai đi qua cái cổng không dành cho nó.
  */
  if (input.basis !== "ACTUAL" && !ALLOW_ADS_WRITE_ON_PROJECTED_BASIS) return deny("BASIS_NOT_MEASURED");

  if (!input.stability.ready) return deny("NOT_STABLE", input.stability.reason);

  // Nấc COPILOT: không có phiếu duyệt thì không ghi. `AUTO` bị kẹp ở hằng số nên nhánh này là nhánh
  // duy nhất đang sống — giữ cấu trúc `if` để lúc mở AUTO không phải viết lại cả hàm.
  if (input.mode === "COPILOT" && !input.confirmed) return deny("NOT_CONFIRMED");

  if (input.changesForCampaignToday >= ADS_WRITE_LIMITS.maxChangesPerCampaignPerDay) return deny("CAMPAIGN_RATE_LIMIT");

  if (action === "PAUSE_CAMPAIGN") {
    // Tạm dừng không dịch chuyển đồng nào nên không đụng trần tiền: nó DỪNG tiền chảy, không tiêu thêm.
    return { allow: true, action, deltaVnd: 0 };
  }

  if (input.currentBudgetVnd === null || input.nextBudgetVnd === null) {
    return deny("STEP_TOO_BIG", "Chưa đọc được ngân sách hiện tại nên không tính được biên độ — CHƯA BIẾT thì không ghi.");
  }
  if (input.nextBudgetVnd < ADS_WRITE_LIMITS.minDailyBudgetVnd) return deny("BELOW_MIN_BUDGET");

  const delta = input.nextBudgetVnd - input.currentBudgetVnd;
  if (input.currentBudgetVnd <= 0) return deny("STEP_TOO_BIG", "Ngân sách hiện tại bằng 0 nên không có gốc để tính phần trăm.");
  if (Math.abs(delta) / input.currentBudgetVnd > ADS_WRITE_LIMITS.maxStepPct) {
    return deny("STEP_TOO_BIG", `Đang xin đổi ${Math.round((Math.abs(delta) / input.currentBudgetVnd) * 100)}%.`);
  }
  if (input.shiftedTodayVnd + Math.abs(delta) > ADS_WRITE_LIMITS.maxDailyShiftVnd) {
    return deny("DAILY_CAP", `Hôm nay đã dịch chuyển ${input.shiftedTodayVnd.toLocaleString("vi-VN")}đ.`);
  }

  return { allow: true, action, deltaVnd: delta };
}
