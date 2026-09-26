import { STOCK_FEEDBACK_ADS_PERIOD } from "@/lib/constants/stock-feedback";
import { getAdsDecision } from "@/lib/queries/ads-decision";
import { getBusinessBrief } from "@/lib/queries/business-brief";
import { getDashboardData } from "@/lib/queries/dashboard";
import { getInventoryDecisionReport } from "@/lib/queries/inventory-decision";
import { getModelSignalsBatch } from "@/lib/queries/model-signal";
import { ownerDecisionAdsPeriod } from "@/lib/queries/owner-decisions";
import { getPurchasingReport } from "@/lib/queries/purchasing";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ═══════ GIỮ ẤM BẢNG ĐIỀU KHIỂN — NGƯỜI TRẢ GIÁ PHẢI LÀ BỘ LẬP LỊCH, KHÔNG PHẢI NGƯỜI DÙNG ═══════
 *
 * Đo trên production 10/09/2026: trang chủ nguội mất **76–88 giây**; ấm thì khoảng 100ms. Bộ nhớ đệm
 * chỉ cứu được người mở trang TRONG hạn TTL — người mở đầu tiên sau mỗi lần hết hạn vẫn trả giá đầy
 * đủ, và đó thường chính là chủ shop mở máy buổi sáng.
 *
 * VÌ SAO KHÔNG PHẢI LÀ GIẤU VẤN ĐỀ: chi phí thật vẫn còn nguyên và vẫn đo được (`perf-probe` xoá đệm
 * trước mỗi phép đo). Thay đổi ở đây là AI trả giá đó. Bộ lập lịch chạy nền, không ai ngồi đợi nó;
 * người dùng bấm vào trang chủ thì có người đang ngồi đợi.
 *
 * Chạy mỗi 2 phút, ngắn hơn TTL 180 giây của bảng điều khiển, nên đệm không bao giờ kịp nguội.
 *
 * CHỈ ĐỌC. Không job nào ở đây được phép ghi dữ liệu nghiệp vụ — nếu cần ghi thì nó thuộc về một
 * job khác, có tên khác, và người vận hành phải nhìn thấy nó ghi cái gì.
 */

/** Các kỳ người dùng thật hay mở. Giữ ấm kỳ không ai xem là đốt CPU vô ích. */
/**
 * CHỈ KỲ MẶC ĐỊNH.
 *
 * Bản đầu giữ ấm ba kỳ + bản tóm tắt, chạy mỗi 2 phút. Trên máy 2 nhân, chính việc giữ ấm giành mất
 * CPU của người đang mở trang: smoke sau đó có `/cod?recon=stale` quá hạn 60 giây, dù chính trang đó
 * đo được 146ms ở lượt trước.
 *
 * Giữ ấm là để NGƯỜI DÙNG không phải chờ — nếu nó làm người dùng chờ ở trang khác thì nó đang tự
 * phản lại mục đích. Kỳ 30 ngày là kỳ mặc định của trang chủ và chiếm gần hết lượt mở; hai kỳ còn
 * lại người dùng tự trả giá một lần rồi được đệm 5 phút.
 */
const KY_HAY_MO = ["30d"] as const;

/** Một mục giữ ấm: `key` là nhãn trong nhật ký job (KHÔNG phải khoá đệm — khoá đệm do chính hàm đọc dựng). */
export type WarmTask = { key: string; run: () => Promise<unknown> };

export type WarmTiming = { key: string; ms: number; ok: boolean };
export type WarmResult = { warmed: string[]; failed: { key: string; error: string }[]; timings: WarmTiming[]; ms: number };

/**
 * Chạy lần lượt từng mục, mỗi mục một `try/catch` RIÊNG: một nguồn hỏng (vd tín hiệu mẫu ném vì bảng
 * topic lỗi) không được làm các mục sau nguội theo. Ghi thời gian từng mục để nhật ký job nói được mục
 * nào đắt — kể cả mục hỏng.
 *
 * Mục trúng đệm CŨ (`memo` trả số cũ ngay, làm mới phía sau) đo ra gần 0 ms: lượt làm mới vẫn chạy trong
 * tiến trình, người mở trang kế tiếp nhận số mới. Con số nhỏ ở đây KHÔNG có nghĩa là nguồn rẻ.
 */
export async function runWarms(tasks: readonly WarmTask[]): Promise<WarmResult> {
  const t0 = Date.now();
  const warmed: string[] = [];
  const failed: { key: string; error: string }[] = [];
  const timings: WarmTiming[] = [];
  // TUẦN TỰ, không song song: máy chỉ có 2 nhân và mục đích ở đây là dựng đệm nền, không phải
  // giành CPU với người đang mở trang. Chạy song song sẽ làm chậm đúng thứ nó định làm nhanh.
  for (const task of tasks) {
    const t = Date.now();
    try {
      await task.run();
      warmed.push(task.key);
      timings.push({ key: task.key, ms: Date.now() - t, ok: true });
    } catch (error) {
      failed.push({ key: task.key, error: error instanceof Error ? error.message : String(error) });
      timings.push({ key: task.key, ms: Date.now() - t, ok: false });
    }
  }
  return { warmed, failed, timings, ms: Date.now() - t0 };
}

/** Tổng quan + Tóm tắt & rủi ro — kỳ mặc định. */
export function dashboardWarmTasks(): WarmTask[] {
  return [
    ...KY_HAY_MO.map((key) => ({ key, run: () => getDashboardData(resolvePeriod({ period: key }, key)) })),
    // Bản tóm tắt chỉ giữ ấm kỳ mặc định: nó đắt nhất, và người dùng gần như luôn xem nó ở kỳ đó.
    { key: "brief:30d", run: () => getBusinessBrief(resolvePeriod({ period: "30d" }, "30d")) },
  ];
}

/**
 * ═══════ "CẦN ANH QUYẾT" — LÀM ẤM BỘ MÁY, KHÔNG LÀM ẤM HÀNG ĐỢI CỦA MỘT NGƯỜI ═══════
 *
 * Khối trên trang chủ cho mỗi nguồn 2,5 s (`OWNER_DECISION_TIMEOUT_MS`). Tín hiệu mẫu theo lô đọc nguội
 * ~1 s trên dữ liệu demo và vượt hạn trên production, nên lượt mở đầu buổi sáng in "Chưa đọc được: Tín
 * hiệu mẫu" dù không có gì hỏng.
 *
 * Chỉ làm ấm những bộ máy CẢ SHOP có đệm (`memo`) mà các nguồn của buồng lái đọc — KHÔNG gọi
 * `getOwnerDecisionQueue` cho một người xem: kết quả ấy lọc theo quyền của từng người và không được đệm,
 * làm ấm nó là tính cho không ai. Kỳ lấy từ CHÍNH hằng của buồng lái / vòng phản hồi tồn, nên khoá đệm
 * trùng khoá trang đọc (bài kiểm so tập khoá, không so tên gõ tay).
 *
 * Nguồn KHÔNG có ở đây vì không có đệm để làm ấm (đọc thẳng bảng, 50–260 ms): yêu cầu duyệt, mẫu chờ
 * duyệt, topic chờ quyết.
 */
export function cockpitWarmTasks(): WarmTask[] {
  const ky = ownerDecisionAdsPeriod();
  const kyTon = resolvePeriod({ period: STOCK_FEEDBACK_ADS_PERIOD }, STOCK_FEEDBACK_ADS_PERIOD);
  return [
    // Tồn: nguồn Quyết định vốn tồn + vòng phản hồi tồn + một vế của tín hiệu mẫu.
    { key: "cockpit:inventory-decision", run: () => getInventoryDecisionReport() },
    // Quảng cáo chiều chiến dịch: nguồn CẮT quảng cáo (và phép chiếu `/work` cùng kỳ).
    { key: "cockpit:ads-campaign", run: () => getAdsDecision(ky, "campaign") },
    // Quảng cáo chiều mã hàng theo kỳ của vòng phản hồi tồn (trùng kỳ tín hiệu mẫu thì là một lượt trúng đệm).
    { key: "cockpit:ads-product", run: () => getAdsDecision(kyTon, "product") },
    // Tín hiệu mẫu theo lô: MODEL_SCALE + MODEL_EARLY_TOPIC (một lượt sinh cả hai loại).
    { key: "cockpit:model-signals", run: () => getModelSignalsBatch(ky) },
    // Lệnh sản xuất quá hẹn: cửa sổ mặc định của trang Mua hàng.
    { key: "cockpit:purchasing", run: () => getPurchasingReport() },
  ];
}

export async function warmCockpit(): Promise<WarmResult> {
  return runWarms(cockpitWarmTasks());
}

export async function warmDashboard(): Promise<WarmResult> {
  return runWarms([...dashboardWarmTasks(), ...cockpitWarmTasks()]);
}

/** Một dòng cho `sync_runs.detail`: mỗi mục kèm thời gian, mục hỏng kèm câu lỗi. */
export function warmDetail(r: WarmResult): string {
  const muc = r.timings.map((t) => `${t.key} ${t.ms} ms${t.ok ? "" : " ✗"}`).join(" · ") || "không mục nào";
  const loi = r.failed.length ? ` · LỖI ${r.failed.map((f) => `${f.key}: ${f.error}`).join(" | ")}` : "";
  return `ấm ${r.warmed.length}/${r.timings.length} mục (${muc}) · ${r.ms} ms${loi}`.slice(0, 900);
}
