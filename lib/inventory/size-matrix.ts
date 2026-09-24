import type { PlanStatus } from "@/lib/constants/planning";

/**
 * TỒN THEO MÀU × SIZE — gom mẫu mã vào ô, hàm THUẦN.
 *
 * Nhận đúng những con số sổ kho đã tính cho từng mẫu mã (`available` = khả dụng bán, `erpStock` =
 * tồn thực tế, `status` = mức cảnh báo của Kế hoạch SX) và chỉ XẾP LẠI; không tính tồn lần thứ hai.
 *
 * Hai luật:
 *  · mẫu mã đã xoá không có ô (vẫn tra được ở bảng mẫu mã);
 *  · ô gộp nhiều mẫu mã mà có MỘT mẫu mã chưa biết tồn ⇒ cả ô CHƯA BIẾT (`null`). Cộng phần biết
 *    được là in ra một con số trông chắc chắn mà thật ra thiếu (AGENTS mục 42).
 */

export type SizeMatrixVariant = { id: string; sku: string; color: string; size: string; available: number | null; erpStock: number | null; isRemoved: boolean; status: PlanStatus | null };

export type SizeMatrixCell = { available: number | null; erpStock: number | null; status: PlanStatus | null; skus: string };

/** Mức nặng nhất đứng trước — ô mang mức của mẫu mã tệ nhất trong ô. */
export const STATUS_SEVERITY: PlanStatus[] = ["OUT", "CRITICAL", "LOW", "UNKNOWN", "OK", "IDLE"];

export function buildStockSizeMatrix(variants: SizeMatrixVariant[]): { colors: string[]; sizes: string[]; cell: (color: string, size: string) => SizeMatrixCell | null } | null {
  const con = variants.filter((v) => !v.isRemoved);
  const colors = [...new Set(con.map((v) => v.color || "—"))];
  const sizes = [...new Set(con.map((v) => v.size || "—"))];
  if (colors.length < 2 && sizes.length < 2) return null;
  const cell = (color: string, size: string): SizeMatrixCell | null => {
    const vs = con.filter((v) => (v.color || "—") === color && (v.size || "—") === size);
    if (!vs.length) return null;
    const known = vs.every((v) => v.available !== null && v.erpStock !== null);
    const status = vs.map((v) => v.status).filter((x): x is PlanStatus => x !== null).sort((a, b) => STATUS_SEVERITY.indexOf(a) - STATUS_SEVERITY.indexOf(b))[0] ?? null;
    return {
      available: known ? vs.reduce((t, v) => t + (v.available ?? 0), 0) : null,
      erpStock: known ? vs.reduce((t, v) => t + (v.erpStock ?? 0), 0) : null,
      status,
      skus: vs.map((v) => v.sku || v.id).join(", "),
    };
  };
  return { colors, sizes, cell };
}
