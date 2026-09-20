import type { TechIncidentSeverity, TechModule } from "@/lib/constants/tech";

/**
 * ═══════════ JOB ĐỒNG BỘ HỎNG → SỰ CỐ — HÀM THUẦN, KHÔNG ĐỌC CSDL ═══════════
 *
 * ─── VÌ SAO PHẢI CÓ ĐƯỜNG NÀY ───
 *
 * Đo 20/09/2026: `tech_incidents` có **0 sự cố đang mở**, trong khi cùng lúc `facebook-ads` hỏng
 * lặp lại nhiều giờ liền và bảng kê Gmail im bốn ngày. Không có đường nào từ `sync_runs` sang sổ
 * sự cố, nên "0 sự cố" không có nghĩa là không có sự cố — nó có nghĩa là **không ai gõ tay**. Một
 * thẻ đếm chỉ đếm được cái người ta nhớ gõ thì nó đo trí nhớ, không đo hệ thống.
 *
 * ─── MỘT LẦN HỎNG KHÔNG PHẢI MỘT SỰ CỐ ───
 *
 * Mạng chập, Pancake trả 429, GitHub hết hạn mức — mỗi thứ đó tự khỏi ở lượt sau. Mở sự cố cho
 * từng lượt hỏng là đổ đầy sổ bằng nhiễu, và người trực sẽ học cách bỏ qua sổ. Cái PHÂN BIỆT được
 * "chập một cái" với "hỏng thật" là **CHUỖI LIÊN TIẾP**: job đã chạy lại N lượt và lượt nào cũng
 * hỏng nghĩa là nó không tự khỏi.
 *
 * ─── LƯỢT ĐANG CHẠY KHÔNG PHẢI MỘT PHÁN QUYẾT ───
 *
 * `RUNNING` chưa nói gì cả nên nó KHÔNG cắt chuỗi và cũng KHÔNG nối dài chuỗi — bỏ qua. `PARTIAL`
 * thì CẮT: job có chạy và có làm được việc, chỉ kèm cảnh báo. Đếm nó là hỏng thì mọi job có một
 * dòng cảnh báo sẽ thành sự cố.
 */

export const SYNC_INCIDENT_RULE = {
  /** Bao nhiêu lượt hỏng LIÊN TIẾP thì mở sự cố. Dưới ngưỡng là nhiễu, không phải sự cố. */
  consecutiveFailures: 3,
  /**
   * Chỉ xét lượt chạy trong bấy nhiêu giờ gần đây.
   *
   * Không có cửa sổ thì một job chạy 30 phút/lần đã ngừng hỏng từ tháng trước vẫn mang ba lượt
   * hỏng cuối cùng của đời nó ở đầu danh sách, và sổ sự cố mở một sự cố cho một chuyện đã qua.
   */
  lookbackHours: 24,
  /**
   * MỌI sự cố mở tự động đều là SEV2 — và đó là lựa chọn, không phải chưa nghĩ tới.
   *
   * Máy đo được job có chạy hay không; nó KHÔNG đo được hậu quả kinh doanh. `facebook-ads` hỏng
   * ba tiếng là SEV3 với shop không chạy quảng cáo và SEV1 với shop đang tiêu tiền theo giờ. Đặt
   * sẵn một thang tự động là để máy khẳng định thứ nó không quan sát được (AGENTS.md mục 8.4).
   * SEV2 = "hỏng một phần, có đường vòng" — đúng mức người trực phải xem, và người nâng/hạ được.
   */
  severity: "SEV2" as TechIncidentSeverity,
} as const;

/**
 * NGUỒN ĐỒNG BỘ → MÔ-ĐUN CỦA SỰ CỐ.
 *
 * Mô-đun quyết định ai mở sổ ra sẽ thấy sự cố này. Nó đi theo NGUỒN chứ không theo tên job: mọi
 * job Pancake hỏng đều là chuyện của đường dữ liệu đơn hàng, dù tên job là gì.
 *
 * Nguồn lạ (job mới thêm mà quên khai) rơi về `INTEGRATIONS`, KHÔNG rơi về `PLATFORM`: một job
 * đồng bộ hỏng là chuyện của kết nối dữ liệu cho tới khi có người chứng minh ngược lại.
 */
export function syncIncidentModule(source: string): TechModule {
  switch (source.toUpperCase()) {
    case "PANCAKE":
      return "ORDERS";
    case "VIETTELPOST":
      return "SHIPMENTS";
    case "FACEBOOK":
      return "ADS";
    case "SEPAY":
      return "FINANCE";
    case "GITHUB":
      return "TECH";
    case "ERP":
      return "PLATFORM";
    default:
      return "INTEGRATIONS";
  }
}

/**
 * TIÊU ĐỀ **LÀ KHOÁ TỰ NHIÊN** CỦA SỰ CỐ NÀY.
 *
 * `tech_incidents` không có cột khoá chống trùng, và thêm một cột là một migration — trong khi
 * nhiều phiên đang cùng sinh migration (AGENTS.md mục 9), số hiệu trùng nhau là rủi ro lớn hơn
 * lợi ích. Nên khoá nằm ở TIÊU ĐỀ: mở sự cố mới chỉ khi KHÔNG còn sự cố chưa đóng nào mang đúng
 * tiêu đề này.
 *
 * Hệ quả phải biết trước: **đổi công thức tiêu đề = mở lại một sự cố cho mọi job đang hỏng.**
 * `tests/sync-incident-watch.test.ts` ghim đúng một chuỗi đầu ra, nên đổi nó là một hành động có
 * chủ ý với một bài kiểm đỏ, không phải một lần sửa chữ cho đẹp.
 */
export function syncIncidentTitle(source: string, job: string): string {
  return `Job đồng bộ hỏng liên tiếp: ${job} (${source})`;
}

export type SyncRunVerdict = { status: string; startedAt: Date; error?: string | null; detail?: string | null };

export type SyncJobHealth = {
  /** Số lượt hỏng LIÊN TIẾP tính từ lượt gần nhất có phán quyết. */
  consecutiveFailures: number;
  /** Mốc của lượt hỏng CŨ NHẤT trong chuỗi — tức lúc sự cố BẮT ĐẦU, không phải lúc máy nhìn thấy. */
  firstFailureAt: Date | null;
  lastFailureAt: Date | null;
  /** Câu lỗi của lượt hỏng GẦN NHẤT. Rỗng = job hỏng mà không để lại câu nào. */
  lastError: string;
  warrantsIncident: boolean;
};

/**
 * Chuỗi hỏng liên tiếp — HÀM THUẦN.
 *
 * `runs` phải được sắp MỚI TRƯỚC. Hàm không tự sắp: sắp lại ở đây thì nơi gọi có thể truyền một
 * thứ tự khác mà vẫn ra kết quả trông hợp lý, và không ai phát hiện ra truy vấn đã sắp sai.
 */
export function classifySyncJobHealth(runs: SyncRunVerdict[]): SyncJobHealth {
  const out: SyncJobHealth = { consecutiveFailures: 0, firstFailureAt: null, lastFailureAt: null, lastError: "", warrantsIncident: false };
  for (const r of runs) {
    const s = r.status.toUpperCase();
    // Chưa xong thì chưa phán quyết: không nối dài chuỗi, cũng không cắt nó.
    if (s === "RUNNING") continue;
    if (s !== "FAILED") break;
    out.consecutiveFailures += 1;
    if (!out.lastFailureAt) {
      out.lastFailureAt = r.startedAt;
      out.lastError = (r.error ?? r.detail ?? "").trim();
    }
    out.firstFailureAt = r.startedAt;
  }
  out.warrantsIncident = out.consecutiveFailures >= SYNC_INCIDENT_RULE.consecutiveFailures;
  return out;
}
