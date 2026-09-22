import { ADS_DECISION_RULE, type AdsAction } from "@/lib/constants/ads-decision";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ SỔ QUYẾT ĐỊNH QUẢNG CÁO — TRÍ NHỚ CỦA PHÒNG MARKETING ═══════════
 *
 * Đặc tả: `docs/marketing-ai-department.md`. Đọc trước khi sửa bất kỳ con số nào ở đây.
 *
 * ─── VÌ SAO PHẢI CÓ SỔ, TRONG KHI BẢNG QUYẾT ĐỊNH ĐÃ CHẠY TỐT ───
 *
 * `lib/queries/ads-decision.ts` tính lại từ đầu mỗi lần ai đó mở `/ads`. Nó trả lời rất tốt câu
 * *"lúc này nên làm gì"*, và cố ý không trả lời ba câu còn lại:
 *
 *   · hôm qua nó khuyên gì — nên không ai biết nó có đổi ý xoành xoạch không;
 *   · sau lời khuyên đó có ai làm gì không;
 *   · làm rồi thì kết quả ra sao.
 *
 * Với NGƯỜI, ba câu ấy là tiện nghi. Với một AGENT thì chúng là điều kiện tồn tại: một cỗ máy
 * không có trí nhớ sẽ đề nghị lại đúng thứ vừa bị từ chối, mỗi ngày, mãi mãi. Phòng Tech đã cắn
 * đúng lớp lỗi này — dây chuyền chạy được nửa ĐI rồi dừng, vì việc không bao giờ biết PR của nó
 * đã mở (`docs/tech-ai-room-status.md`, mục *Nửa VỀ*).
 *
 * ─── SỔ NÀY KHÔNG ĐẺ RA MỘT CON SỐ NÀO ───
 *
 * Nó CHÉP LẠI kết luận của `decideAction()` kèm bằng chứng của chính lượt chép đó. Không có công
 * thức thứ hai, không có ngưỡng thứ hai. Sửa luật quyết định vẫn chỉ sửa ở
 * `lib/constants/ads-decision.ts`; việc duy nhất sổ phải làm khi ấy là **tăng phiên bản**.
 */

/**
 * ───────────── KỲ CHUẨN: MỘT, VÀ KHÔNG PHỤ THUỘC NGƯỜI ĐANG XEM ─────────────
 *
 * Bảng trên màn hình chạy theo kỳ người dùng chọn — đổi từ tháng sang tuần là đổi khuyến nghị, và
 * đó là hành vi ĐÚNG cho một màn tra cứu. Nhưng một dòng sổ phải so sánh được với dòng hôm qua,
 * nên nó chỉ được sinh ra trên MỘT kỳ đã khai.
 *
 * **14 ngày, kết thúc ở NGÀY HÔM QUA (giờ Việt Nam).**
 *
 * · *Kết thúc hôm qua* vì hôm nay chưa đóng: tiền quảng cáo tiêu từ sáng còn hàng thì chưa tới tay
 *   ai. Một ngày đang chạy luôn trông như đang lỗ.
 * · *14 ngày* vì cổng độ chín của `decideAction` đòi 60% số đơn đã ngã ngũ. Hàng đi 3–7 ngày, nên
 *   cửa sổ 7 ngày sẽ rơi vào `INSUFFICIENT_DATA` gần như mọi hôm — một sổ toàn chữ "chưa đủ dữ
 *   liệu" thì không phải trí nhớ, chỉ là tiếng ồn có ngày tháng.
 */
export const LEDGER_WINDOW_DAYS = 14;

/**
 * ───────────── PHIÊN BẢN LUẬT — ĐỔI CÔNG THỨC LÀ CẮT CHUỖI ─────────────
 *
 * Cùng một chữ `CUT` sinh ra bởi hai bộ ngưỡng khác nhau KHÔNG phải cùng một kết luận, nên chúng
 * không được nối thành một chuỗi "đã giữ 9 ngày". Đây đúng là luật AGENTS.md mục 40 áp cho chỉ số
 * (`METRIC_DEFINITION_VERSION`): hai kỳ khác phiên bản đứng trên hai tập luật khác nhau.
 *
 * **Tăng số này mỗi khi `ADS_DECISION_RULE` hoặc `decideAction()` đổi.**
 * `tests/marketing-decision-ledger.test.ts` khoá bộ ngưỡng lại: sửa ngưỡng mà quên tăng phiên bản
 * thì bài kiểm đỏ, không phải chuỗi lặng lẽ nói sai.
 */
export const DECISION_RULE_VERSION = 1;

/** Ảnh chụp ngưỡng đang chạy — ghi vào từng dòng sổ để "vì sao hôm ấy nó nói CẮT" trả lời được mãi mãi. */
export function decisionRuleSnapshot() {
  return { version: DECISION_RULE_VERSION, windowDays: LEDGER_WINDOW_DAYS, ...ADS_DECISION_RULE };
}

/**
 * ───────────── BA HẠNG HÀNH ĐỘNG ─────────────
 *
 * `ACTIONABLE` là hạng DUY NHẤT được phép đi tiếp vào hàng đợi việc hay vào tay một agent. Hai
 * hạng còn lại vẫn được ghi sổ đầy đủ — chúng là mẫu số, và không có mẫu số thì không đo được
 * chất lượng lời khuyên.
 */
export type DecisionClass = "ACTIONABLE" | "NO_CHANGE" | "NO_OPINION";

export const DECISION_CLASS: Record<AdsAction, DecisionClass> = {
  CUT: "ACTIONABLE",
  FIX_DELIVERY: "ACTIONABLE",
  SCALE: "ACTIONABLE",
  HOLD: "NO_CHANGE",
  WATCH: "NO_CHANGE",
  INSUFFICIENT_DATA: "NO_OPINION",
  NO_SPEND_DATA: "NO_OPINION",
};

/**
 * ───────────── ĐỘ BỀN CỦA MỘT KHUYẾN NGHỊ — HAI SỐ, VÀ VÌ SAO KHÔNG PHẢI MỘT ─────────────
 *
 * Cửa sổ 14 ngày LĂN nghĩa là hai ngày liên tiếp dùng chung 13/14 dữ liệu. Nên "hôm nay giống hôm
 * qua" gần như luôn đúng, và một cái cổng chỉ nhìn chuỗi liên tiếp sẽ mở ra sau đúng hai ngày —
 * tưởng là thận trọng, thực ra là tự động gật.
 *
 * Thứ thật sự phân biệt một dòng ĐÃ NGÃ NGŨ với một dòng đang ngồi trên ranh giới là **số lần đổi
 * ý**. Một chiến dịch nhảy `CUT → WATCH → CUT → HOLD` trong mười ngày không cho ai quyền kết luận
 * gì, kể cả khi hôm nay tình cờ đã sang ngày thứ ba của `CUT`.
 *
 * Nên cổng có HAI vế, và phải qua CẢ HAI:
 *   · `minHeldDays` — khuyến nghị hiện tại đã giữ liên tiếp bấy nhiêu ngày;
 *   · `maxFlips`    — trong `flipWindowDays` ngày gần nhất, khuyến nghị đổi không quá bấy nhiêu lần.
 *
 * ─── ĐÂY LÀ NGƯỠNG NGHIỆP VỤ, VÀ CHỦ SHOP ĐÃ CHỐT (AGENTS.md mục 7) ───
 *
 * Chốt ngày **22/09/2026**. Sửa chỉ ở ĐÂY, và chỉ khi chủ shop yêu cầu — kèm tăng
 * `DECISION_RULE_VERSION`, vì đổi ngưỡng là đổi nghĩa của mọi chuỗi đã ghi.
 *
 * Lý lẽ của từng con số, để người sau không phải đoán:
 *  · `CUT` đi sớm hơn `SCALE` — một dòng đang lỗ thì mỗi ngày chờ là mất thêm tiền thật, còn tăng
 *    ngân sách là CAM KẾT thêm tiền nên đòi bằng chứng dày hơn.
 *  · `FIX_DELIVERY` đi sớm nhất vì nó KHÔNG đụng tới ngân sách: sai thì mất một lượt kiểm tra khâu
 *    đóng gói, không mất đồng nào.
 *  · `maxFlips = 1` cho cả hai hành động tiền: một dòng đã đổi ý hai lần trong mười ngày là một
 *    dòng đang nằm trên ranh giới, và cả hai phía của ranh giới ấy đều không đáng tin.
 */
export const DECISION_STABILITY = {
  /** Cắt đang chảy máu — chờ lâu là mất thêm tiền; nhưng cắt nhầm là giết một dòng đang học. */
  CUT: { minHeldDays: 3, maxFlips: 1 },
  /** Tăng tiền là cam kết thêm ngân sách: đòi bằng chứng dày hơn cắt. */
  SCALE: { minHeldDays: 4, maxFlips: 1 },
  /** Sửa khâu giao không đụng tới ngân sách, nên rẻ khi sai — cho đi sớm hơn. */
  FIX_DELIVERY: { minHeldDays: 2, maxFlips: 2 },
} as const satisfies Record<string, { minHeldDays: number; maxFlips: number }>;

/** Cửa sổ đếm số lần đổi ý. Ngắn hơn cửa sổ dữ liệu, vì nó hỏi về NHỊP chứ không hỏi về kết quả. */
export const FLIP_WINDOW_DAYS = 10;

/** Hành động nào có cổng độ bền. Hạng khác không đi tới đâu nên không cần cổng. */
export type StableAction = keyof typeof DECISION_STABILITY;

export function stabilityRuleOf(action: AdsAction): { minHeldDays: number; maxFlips: number } | null {
  return action in DECISION_STABILITY ? DECISION_STABILITY[action as StableAction] : null;
}

/** Ngày Việt Nam của một mốc UTC, dạng `YYYY-MM-DD`. */
export function vnDay(at: Date): string {
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Khoảng cách theo NGÀY giữa hai ngày Việt Nam (`b − a`). */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Kỳ chuẩn của một lượt ghi sổ, và NGÀY GHI SỔ của nó.
 *
 * Hàm THUẦN: không đọc CSDL, không đọc đồng hồ ngoài tham số. Chạy hai lần trên cùng `now` ra cùng
 * kết quả — điều kiện để một lượt chạy lại không đẻ ra dòng thứ hai.
 *
 * `decisionDay` là ngày hôm nay (lúc chạy), KHÔNG phải ngày cuối kỳ: nó trả lời *"ngày ấy ERP nghĩ
 * gì"*, và hai lượt chạy cùng ngày là cùng một dòng.
 */
export function ledgerPeriod(now: Date): { decisionDay: string; period: Period } {
  const decisionDay = vnDay(now);
  const toKey = shiftDay(decisionDay, -1);
  const fromKey = shiftDay(toKey, -(LEDGER_WINDOW_DAYS - 1));
  return {
    decisionDay,
    period: {
      key: "custom",
      from: new Date(`${fromKey}T00:00:00+07:00`),
      to: new Date(`${toKey}T23:59:59.999+07:00`),
      label: `${fromKey}→${toKey}`,
      fromKey,
      toKey,
    },
  };
}
