import { getBusinessBrief } from "@/lib/queries/business-brief";
import { getDashboardData } from "@/lib/queries/dashboard";
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
const KY_HAY_MO = ["30d", "7d", "month"] as const;

export type WarmResult = { warmed: string[]; failed: { key: string; error: string }[]; ms: number };

export async function warmDashboard(): Promise<WarmResult> {
  const t0 = Date.now();
  const warmed: string[] = [];
  const failed: { key: string; error: string }[] = [];

  // TUẦN TỰ, không song song: máy chỉ có 2 nhân và mục đích ở đây là dựng đệm nền, không phải
  // giành CPU với người đang mở trang. Chạy song song sẽ làm chậm đúng thứ nó định làm nhanh.
  for (const key of KY_HAY_MO) {
    try {
      const period = resolvePeriod({ period: key }, key);
      await getDashboardData(period);
      warmed.push(key);
    } catch (error) {
      failed.push({ key, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Bản tóm tắt chỉ giữ ấm kỳ mặc định: nó đắt nhất, và người dùng gần như luôn xem nó ở kỳ đó.
  try {
    await getBusinessBrief(resolvePeriod({ period: "30d" }, "30d"));
    warmed.push("brief:30d");
  } catch (error) {
    failed.push({ key: "brief:30d", error: error instanceof Error ? error.message : String(error) });
  }

  return { warmed, failed, ms: Date.now() - t0 };
}
