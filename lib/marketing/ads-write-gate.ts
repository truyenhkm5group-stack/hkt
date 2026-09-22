import type { AdsAction } from "@/lib/constants/ads-decision";
import {
  ACTION_FOR_DECISION,
  ADS_WRITE_DENIAL_REASON,
  ADS_WRITE_LIMITS,
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

export type GateInput = {
  /** `ADS_WRITE_ENABLED` đọc THẲNG từ biến môi trường. Chốt ngoài cùng. */
  hardEnabled: boolean;
  /** Nấc quyền hạn ĐÃ kẹp bằng `clampAdsWriteMode`. */
  mode: AdsWriteMode;
  /** Người đã bấm xác nhận với một phiếu duyệt hợp lệ chưa. */
  confirmed: boolean;
  decision: AdsAction;
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
