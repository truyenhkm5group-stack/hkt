import type { AdsAction, DecisionBasis } from "@/lib/constants/ads-decision";
import {
  ACTION_FOR_DECISION,
  ADS_WRITE_DENIAL_REASON,
  ADS_WRITE_LIMITS,
  ALLOW_ADS_WRITE_ON_PROJECTED_BASIS,
  type AdsWriteAction,
  type AdsWriteDenial,
  type AdsWriteLevel,
  BUDGET_DIRECTION,
  PRODUCT_ACTION_FOR_DECISION,
  type AdsWriteMode,
} from "@/lib/constants/ads-write";
import type { Stability } from "@/lib/marketing/decision-stability";
import type { IntradayRate, IntradayVerdict } from "@/lib/constants/ads-intraday";

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

export function subjectFreshness(s: SubjectState, level: AdsWriteLevel = "campaign"): { ok: true } | { ok: false; denial: AdsWriteDenial } {
  if (s.status === null) return { ok: false, denial: "SUBJECT_UNREADABLE" };
  if (s.status !== "ACTIVE") return { ok: false, denial: "SUBJECT_NOT_RUNNING" };
  /*
    "CHẠY LẠI" CHỈ CÓ NGHĨA Ở CẤP CHIẾN DỊCH.

    Ở cấp mã, kết luận nói về MÃ HÀNG, còn chiến dịch nhận hành động thường là chiến dịch MỚI — chưa
    có một đồng nào trong kỳ kết luận. So "tiền sau kỳ > tiền trong kỳ" ở đó thì luôn luôn đúng, và
    phép kiểm sẽ chặn mọi thứ vì một lý do sai. Một mã hàng không "chạy lại": nó chạy liên tục bằng
    những chiến dịch thay nhau, và đó chính là lý do bàn tay chuyển lên cấp mã.
  */
  if (level === "product") return { ok: true };
  if (s.spendAfterWindowVnd === null) return { ok: false, denial: "SUBJECT_UNREADABLE" };
  if (s.spendAfterWindowVnd > s.spendInWindowVnd) return { ok: false, denial: "SUBJECT_CHANGED" };
  return { ok: true };
}

/** Hành động mà một khuyến nghị đẻ ra, THEO CẤP. Một bảng duy nhất cho mỗi cấp, không suy diễn thêm. */
export function actionFor(decision: AdsAction, level: AdsWriteLevel): AdsWriteAction | null {
  return (level === "product" ? PRODUCT_ACTION_FOR_DECISION[decision] : ACTION_FOR_DECISION[decision]) ?? null;
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
  /**
   * Kết luận đến từ cấp nào. `campaign` = kết luận của CHÍNH chiến dịch này; `product` = kết luận
   * của MÃ HÀNG mà chiến dịch này đang chạy. Hai cấp dịch cùng một chữ ra hai hành động khác nhau
   * (xem `actionFor`), và hỏi hai câu về độ tươi khác nhau (xem `subjectFreshness`).
   */
  level: AdsWriteLevel;
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

  const action = actionFor(input.decision, input.level);
  if (!action) return deny("NO_ACTION_FOR_DECISION", `Khuyến nghị đang là "${input.decision}".`);

  /*
    CHIẾN DỊCH TRƯỚC, KẾT LUẬN SAU.

    Nếu thứ mà kết luận nói tới đã tắt, hoặc đã thành một lần chạy khác, thì hỏi tiếp kết luận ấy
    đứng trên căn cứ gì hay giữ được bao lâu là vô nghĩa — nó đang mô tả một vật không còn ở đó.
  */
  const tuoi = subjectFreshness(input.subject, input.level);
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
  /*
    CHIỀU PHẢI KHỚP KHUYẾN NGHỊ.

    Phiếu duyệt đã khoá đúng con số nên client không đổi được chiều. Nhưng cổng là lớp cuối cùng
    trước tiền thật, và một lỗi ở ĐƯỜNG TÍNH (không phải ở client) vẫn có thể đưa ra "tăng" cho một
    khuyến nghị "cắt". Một phép so rẻ tiền ở đây biến lỗi ấy thành một dòng DENIED thay vì một lượt
    tiêu tiền theo hướng ngược.
  */
  const chieu = BUDGET_DIRECTION[input.decision];
  if (chieu === "UP" && !(input.nextBudgetVnd > input.currentBudgetVnd)) return deny("DIRECTION_MISMATCH");
  if (chieu === "DOWN" && !(input.nextBudgetVnd < input.currentBudgetVnd)) return deny("DIRECTION_MISMATCH");

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

/**
 * ═══════════ KẾ HOẠCH CẤP MÃ: MỘT QUYẾT ĐỊNH, NHIỀU CHIẾN DỊCH ═══════════
 *
 * Hàm THUẦN — không đọc Facebook, không đọc CSDL. Nhận trạng thái ĐÃ ĐỌC của từng chiến dịch, trả về
 * từng dòng được hay bị chặn, kèm lý do. Đường đề nghị và đường áp gọi CHUNG hàm này, nên hai bước
 * không thể lệch nhau vì hai luật.
 *
 * ─── TRẦN TRONG NGÀY PHẢI CỘNG DỒN QUA CẢ LÔ ───
 *
 * `gateAdsWrite` kiểm từng chiến dịch với `shiftedTodayVnd` — số tiền đã dịch chuyển hôm nay. Gọi nó
 * N lần với CÙNG một con số thì mỗi chiến dịch đều tưởng mình là chiến dịch đầu tiên, và trần 2 triệu
 * thành trần 2 triệu × N. Nên dòng sau phải thấy phần mà các dòng TRƯỚC nó trong cùng lô đã chiếm.
 *
 * Thứ tự là thứ tự `targets` truyền vào — nơi gọi xếp theo tiền chi giảm dần, nên khi chạm trần thì
 * phần bị cắt là những chiến dịch nhỏ nhất.
 */
export type PlanTarget = {
  campaignId: string;
  name: string;
  /** Trạng thái Facebook trả về; `null` = không đọc được. */
  status: string | null;
  currentBudgetVnd: number | null;
  changesToday: number;
};

export type PlanRow = PlanTarget & {
  nextBudgetVnd: number | null;
  allow: boolean;
  denial: AdsWriteDenial | null;
  reason: string;
  deltaVnd: number;
};

/** Ngân sách mới theo một bước, ĐÚNG chiều của khuyến nghị. `null` = không tính được (chưa biết ngân sách hiện tại). */
export function nextBudgetFor(currentVnd: number | null, decision: AdsAction): number | null {
  if (currentVnd === null) return null;
  const chieu = BUDGET_DIRECTION[decision];
  if (!chieu) return null;
  const heSo = chieu === "UP" ? 1 + ADS_WRITE_LIMITS.proposeStepPct : 1 - ADS_WRITE_LIMITS.proposeStepPct;
  return Math.round(currentVnd * heSo);
}

export function planProductBudget(i: {
  hardEnabled: boolean;
  mode: AdsWriteMode;
  confirmed: boolean;
  decision: AdsAction;
  basis: DecisionBasis;
  stability: Stability;
  brake: BrakeState;
  shiftedTodayVnd: number;
  targets: PlanTarget[];
  /** Ngân sách đích đã khoá trong phiếu duyệt — đường ÁP truyền vào; đường ĐỀ NGHỊ để trống để tự tính. */
  lockedNext?: Map<string, number | null>;
}): PlanRow[] {
  let daDoi = 0;
  return i.targets.map((t) => {
    const next = i.lockedNext ? (i.lockedNext.get(t.campaignId) ?? null) : nextBudgetFor(t.currentBudgetVnd, i.decision);
    const g = gateAdsWrite({
      hardEnabled: i.hardEnabled,
      mode: i.mode,
      confirmed: i.confirmed,
      decision: i.decision,
      basis: i.basis,
      // Ở cấp mã, "chạy lại" không có nghĩa (xem `subjectFreshness`), nên hai vế tiền không tham gia.
      subject: { status: t.status, spendInWindowVnd: 0, spendAfterWindowVnd: 0 },
      level: "product",
      stability: i.stability,
      currentBudgetVnd: t.currentBudgetVnd,
      nextBudgetVnd: next,
      shiftedTodayVnd: i.shiftedTodayVnd + daDoi,
      changesForCampaignToday: t.changesToday,
      brake: i.brake,
    });
    if (g.allow) {
      daDoi += Math.abs(g.deltaVnd);
      return { ...t, nextBudgetVnd: next, allow: true, denial: null, reason: "", deltaVnd: g.deltaVnd };
    }
    return { ...t, nextBudgetVnd: next, allow: false, denial: g.denial, reason: g.reason, deltaVnd: 0 };
  });
}

/* ═══════════════════ LÀN NHANH: TĂNG TRONG NGÀY ═══════════════════ */

/**
 * CỔNG CỦA LÀN NHANH — cùng các chốt an toàn với `gateAdsWrite`, khác đúng MỘT chỗ: căn cứ.
 *
 * Làn cũ đòi khuyến nghị đứng trên TIỀN ĐÃ ĐO và đã giữ nguyên đủ số ngày. Làn nhanh thay hai chốt ấy
 * bằng ngưỡng HÔM NAY chủ shop chốt ngày 24/09/2026 (`intradayScaleVerdict`) và nhịp theo giờ
 * (`intradayRateCheck`). Mọi chốt còn lại giữ nguyên, CÙNG THỨ TỰ: chốt máy chủ → nấc quyền → phanh
 * → chiến dịch còn chạy → căn cứ → phiếu duyệt → nhịp → biên độ → trần tiền cả shop.
 *
 * Làn nhanh CHỈ TĂNG. Không có nhánh cắt hay tạm dừng: hạ tiền dựa trên số của nửa ngày là để một buổi
 * sáng ế quyết định số phận chiến dịch — việc đó vẫn đi qua làn có tiền thật.
 */
export type IntradayGateInput = {
  hardEnabled: boolean;
  mode: AdsWriteMode;
  confirmed: boolean;
  brake: BrakeState;
  /** Trạng thái Facebook đọc lúc bấm. `null` = không đọc được. */
  status: string | null;
  verdict: IntradayVerdict;
  rate: IntradayRate;
  currentBudgetVnd: number | null;
  nextBudgetVnd: number | null;
  shiftedTodayVnd: number;
};

export function gateIntradayScale(i: IntradayGateInput): GateResult {
  if (!i.hardEnabled) return deny("HARD_DISABLED");
  if (i.mode === "OFF") return deny("MODE_OFF");
  if (i.brake.on) return deny("BRAKE_ON", `(${i.brake.consecutiveWorse} lượt xấu liên tiếp, ${i.brake.unmeasured} lượt chưa đo được)`);
  if (i.status === null) return deny("SUBJECT_UNREADABLE");
  if (i.status !== "ACTIVE") return deny("SUBJECT_NOT_RUNNING", `(Facebook báo: ${i.status}.)`);
  if (!i.verdict.eligible) return deny("INTRADAY_NOT_ELIGIBLE", i.verdict.reason);
  if (i.mode === "COPILOT" && !i.confirmed) return deny("NOT_CONFIRMED");
  if (!i.rate.ok) return deny("INTRADAY_RATE_LIMIT", i.rate.reason);
  if (i.currentBudgetVnd === null || i.nextBudgetVnd === null) {
    return deny("STEP_TOO_BIG", "Chưa đọc được ngân sách hiện tại nên không tính được biên độ — CHƯA BIẾT thì không ghi.");
  }
  if (i.currentBudgetVnd <= 0) return deny("STEP_TOO_BIG", "Ngân sách hiện tại bằng 0 nên không có gốc để tính phần trăm.");
  // Làn nhanh chỉ biết TĂNG — một ngân sách đích không lớn hơn là dấu hiệu đường tính sai.
  if (!(i.nextBudgetVnd > i.currentBudgetVnd)) return deny("DIRECTION_MISMATCH");
  const delta = i.nextBudgetVnd - i.currentBudgetVnd;
  if (delta / i.currentBudgetVnd > ADS_WRITE_LIMITS.maxStepPct) {
    return deny("STEP_TOO_BIG", `Đang xin tăng ${Math.round((delta / i.currentBudgetVnd) * 100)}%.`);
  }
  if (i.shiftedTodayVnd + delta > ADS_WRITE_LIMITS.maxDailyShiftVnd) {
    return deny("DAILY_CAP", `Hôm nay đã dịch chuyển ${i.shiftedTodayVnd.toLocaleString("vi-VN")}đ.`);
  }
  return { allow: true, action: "SET_DAILY_BUDGET", deltaVnd: delta };
}
