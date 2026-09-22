/**
 * CẬP NHẬT BẢNG GIÁ MÔ HÌNH THEO TỶ GIÁ VIETCOMBANK — mỗi đầu ngày.
 *
 * Đơn giá USD của nhà cung cấp là SỰ THẬT CÔNG BỐ, nằm trong mã nguồn và chỉ đổi khi họ đổi giá.
 * Tỷ giá là thứ đổi hằng ngày, và nay nó đến từ Vietcombank thay vì từ một con số ai đó gõ tay.
 *
 * ─── HAI ĐIỀU KHÔNG ĐƯỢC LÀM ───
 *
 * 1. LẤY KHÔNG ĐƯỢC THÌ GIỮ NGUYÊN, KHÔNG VỀ 0. Ngày lễ, mạng hỏng, VCB đổi bố cục — mọi nhánh
 *    ấy đều phải để bảng giá hôm qua nguyên vẹn. Ghi 0 vào đây làm mọi chi phí thành `0 ₫`, và
 *    `0 ₫` là một lời khẳng định "không tốn gì" chứ không phải một chỗ trống.
 *
 * 2. KHÔNG BỊA GIÁ CHO MÔ HÌNH CHƯA KHAI. `MODEL_USD_PRICES` chỉ có những mô hình đã chép đơn giá
 *    từ tài liệu nhà cung cấp. Mô hình đang chạy mà không nằm trong đó thì chi phí lượt ấy vẫn là
 *    CHƯA BIẾT — và `modelSpendLast24h()` đã đếm sẵn số lượt như vậy, nên sự thiếu này hiện ra
 *    thành một con số chứ không im lặng.
 */
import { buildVndPricing, pricingVersionLabel } from "@/lib/constants/ai-model-pricing";
import { AI_CONFIG_KEY } from "@/lib/constants/ai";
import { fetchVcbRate, type VcbRate } from "@/lib/integrations/vcb/rate";
import { getSettingJson, setSettingJson } from "@/lib/settings";

export type VcbSyncResult = {
  ok: boolean;
  /** Tỷ giá đã ghi. `null` = không lấy được và đã giữ nguyên giá cũ. */
  rate: VcbRate | null;
  /** Tỷ giá đang dùng TRƯỚC lượt này — để đọc được nó đã đổi bao nhiêu. */
  previousVersion: string;
  pricingVersion: string;
  models: string[];
  message: string;
};

export async function syncVcbRate(options: { apply?: boolean } = {}): Promise<VcbSyncResult> {
  const cfg = (await getSettingJson<Record<string, unknown>>(AI_CONFIG_KEY, {})) ?? {};
  const previousVersion = typeof cfg.pricingVersion === "string" ? cfg.pricingVersion : "";

  let rate: VcbRate;
  try {
    rate = await fetchVcbRate();
  } catch (error) {
    return {
      ok: false,
      rate: null,
      previousVersion,
      pricingVersion: previousVersion,
      models: [],
      // Giữ nguyên giá cũ là KẾT QUẢ ĐÚNG của nhánh này, không phải một thất bại im lặng.
      message: `Không lấy được tỷ giá Vietcombank — GIỮ NGUYÊN bảng giá đang chạy (${previousVersion || "chưa có"}). Lý do: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const pricing = buildVndPricing(rate.sellVnd);
  const pricingVersion = pricingVersionLabel(rate.sellVnd);
  const models = Object.keys(pricing);

  if (!options.apply) {
    return {
      ok: true,
      rate,
      previousVersion,
      pricingVersion,
      models,
      message: `CHẠY THỬ — chưa ghi gì. 1 USD = ${rate.sellVnd.toLocaleString("vi-VN")} ₫ (bán, ${rate.publishedAt || "không rõ ngày"}).`,
    };
  }

  // Ghi ĐÈ hai khoá, giữ nguyên mọi cấu hình AI khác. Đọc–sửa–ghi cả object chứ không ghi từng
  // khoá: `settings` lưu một JSON, nên ghi từng khoá là xoá phần còn lại.
  await setSettingJson(AI_CONFIG_KEY, { ...cfg, pricing, pricingVersion });

  return {
    ok: true,
    rate,
    previousVersion,
    pricingVersion,
    models,
    message: `Đã cập nhật bảng giá ${models.length} mô hình theo tỷ giá ${rate.sellVnd.toLocaleString("vi-VN")} ₫/USD (Vietcombank, bán).`,
  };
}
