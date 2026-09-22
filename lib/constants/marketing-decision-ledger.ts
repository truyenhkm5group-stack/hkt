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
 * ───────────── KỲ CHUẨN: MỘT, VÀ NÓ PHẢI LÙI LẠI ĐỦ XA ─────────────
 *
 * Bảng trên màn hình chạy theo kỳ người dùng chọn — đổi từ tháng sang tuần là đổi khuyến nghị, và
 * đó là hành vi ĐÚNG cho một màn tra cứu. Nhưng một dòng sổ phải so sánh được với dòng hôm qua,
 * nên nó chỉ được sinh ra trên MỘT kỳ đã khai.
 *
 * **14 ngày, KẾT THÚC 15 NGÀY TRƯỚC.**
 *
 * ─── VÌ SAO KHÔNG KẾT THÚC Ở HÔM QUA, NHƯ BẢN ĐẦU ───
 *
 * Bản đầu chọn "kết thúc hôm qua" và biện minh bằng câu *"hàng đi 3–7 ngày"*. Câu ấy **chưa bao giờ
 * được đo**, và nó sai với mô hình BÁN TRƯỚC của shop. Đường cong độ chín thật, đo trên production
 * 22/09/2026 (2.492 đơn đã chốt trong 60 ngày):
 *
 * | Tuổi đơn | Đã ngã ngũ |
 * |---|---|
 * | 0–6 ngày  | **8,2%** |
 * | 7–13      | 28,9% |
 * | 14–20     | **83,5%** |
 * | 21–29     | 93,4% |
 * | 30–44     | 98,7% |
 *
 * Cửa sổ "1–14 ngày tuổi" vì thế có độ chín ~18% — và `decideAction` đòi 60%. Hệ quả đo được ở lượt
 * ghi sổ đầu tiên: **425/425 dòng cấp chiến dịch đều `INSUFFICIENT_DATA`**, độ chín trung bình
 * **0,02** ở cấp chiến dịch và **0,18** ở cấp mã hàng. Một cuốn sổ chỉ ghi "chưa đủ dữ liệu" thì
 * không phải trí nhớ, chỉ là tiếng ồn có ngày tháng.
 *
 * Lùi cửa sổ về `[D−28, D−15]` cho cohort tuổi 15–28 ngày ⇒ độ chín ~93%. Đó là cửa sổ ĐẦU TIÊN
 * vượt ngưỡng một cách thoải mái; `[D−21, D−8]` chỉ được ~55%, tức vẫn trượt.
 *
 * ─── CÁI GIÁ, VÀ VÌ SAO NÓ KHÔNG TRÁNH ĐƯỢC ───
 *
 * Quyết định về TIỀN vì thế trễ hai tuần: hôm nay ta kết luận về ngân sách đã tiêu 2–4 tuần trước.
 * Đó không phải khuyết điểm của ERP mà là hình dạng của mô hình bán trước — **kết quả tiền của một
 * đồng quảng cáo hôm nay đơn giản là chưa tồn tại**. Rút ngắn cửa sổ không làm nó tồn tại sớm hơn,
 * chỉ làm ERP kết luận trên phần hoàn chưa về, tức lợi nhuận đẹp hơn sự thật.
 *
 * Những thứ KHÔNG cần đợi giao hàng — tiêu tiền mà không ra đơn, giá tin nhắn vọt, tỷ lệ chốt sụp —
 * đã có đường riêng ở `lib/marketing/alerts.ts` với cửa sổ NÓNG (hôm nay / hôm qua). Hai câu hỏi
 * khác nhau, hai cửa sổ khác nhau; gộp chúng là lý do phần lớn hệ thống cảnh báo bị tắt sau một tuần.
 */
export const LEDGER_WINDOW_DAYS = 14;

/**
 * Cửa sổ kết thúc cách hôm nay bấy nhiêu ngày. `1` = kết thúc hôm qua (bản đầu); `15` = lùi đủ xa
 * để cohort đạt ~93% độ chín theo đường cong đo được ở trên.
 *
 * > Đây là NGƯỠNG NGHIỆP VỤ (AGENTS.md mục 7): nó đánh đổi **độ tin cậy** lấy **độ trễ**. Con số
 * > hiện tại suy ra từ phép đo, không phải từ sở thích — nhưng chủ shop muốn quyết định sớm hơn và
 * > chấp nhận kết luận trên dữ liệu non thì đó là quyền của chủ shop, và chỉ sửa ở ĐÂY.
 */
export const LEDGER_SETTLE_LAG_DAYS = 15;

/**
 * ───────────── PHIÊN BẢN LUẬT — ĐỔI CÔNG THỨC LÀ CẮT CHUỖI ─────────────
 *
 * Cùng một chữ `CUT` sinh ra bởi hai bộ ngưỡng khác nhau KHÔNG phải cùng một kết luận, nên chúng
 * không được nối thành một chuỗi "đã giữ 9 ngày". Đây đúng là luật AGENTS.md mục 40 áp cho chỉ số
 * (`METRIC_DEFINITION_VERSION`): hai kỳ khác phiên bản đứng trên hai tập luật khác nhau.
 *
 * **Tăng số này mỗi khi `ADS_DECISION_RULE`, `decideAction()`, hoặc HÌNH DẠNG KỲ CHUẨN đổi.**
 * Đổi kỳ là đổi TẬP DỮ LIỆU sinh ra kết luận — cùng chữ `CUT` trên hai kỳ khác nhau không phải cùng
 * một kết luận, đúng như đổi ngưỡng (AGENTS.md mục 40).
 * `tests/marketing-decision-ledger.test.ts` khoá bộ ngưỡng lại: sửa ngưỡng mà quên tăng phiên bản
 * thì bài kiểm đỏ, không phải chuỗi lặng lẽ nói sai.
 */
export const DECISION_RULE_VERSION = 2;

/** Ảnh chụp ngưỡng đang chạy — ghi vào từng dòng sổ để "vì sao hôm ấy nó nói CẮT" trả lời được mãi mãi. */
export function decisionRuleSnapshot() {
  return { version: DECISION_RULE_VERSION, windowDays: LEDGER_WINDOW_DAYS, settleLagDays: LEDGER_SETTLE_LAG_DAYS, ...ADS_DECISION_RULE };
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
  const toKey = shiftDay(decisionDay, -LEDGER_SETTLE_LAG_DAYS);
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
