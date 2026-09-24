import assert from "node:assert/strict";
import { buildStockSizeMatrix, type SizeMatrixVariant } from "@/lib/inventory/size-matrix";

/**
 * TỒN THEO MÀU × SIZE chỉ XẾP LẠI số sổ kho — và CHƯA BIẾT không được cộng thành một con số.
 */
export function testSizeMatrix() {
  const v = (id: string, color: string, size: string, available: number | null, erpStock: number | null, extra: Partial<SizeMatrixVariant> = {}): SizeMatrixVariant => ({ id, sku: id, color, size, available, erpStock, isRemoved: false, status: "OK", ...extra });

  // Một màu một size ⇒ không dựng ma trận (bảng mẫu mã đã đủ).
  assert.equal(buildStockSizeMatrix([v("a", "Đen", "M", 5, 6)]), null);

  const mt = buildStockSizeMatrix([
    v("den-s", "Đen", "S", 3, 4, { status: "LOW" }),
    v("den-m", "Đen", "M", 10, 12),
    v("trang-s", "Trắng", "S", null, null, { status: "UNKNOWN" }),
    // Hai mẫu mã cùng ô Trắng/M: một biết, một chưa biết ⇒ cả ô CHƯA BIẾT, không in 7.
    v("trang-m-1", "Trắng", "M", 7, 7),
    v("trang-m-2", "Trắng", "M", null, null, { status: "UNKNOWN" }),
    // Hai mẫu mã cùng ô Đen/L, đều biết ⇒ cộng; mức cảnh báo lấy mức NẶNG nhất.
    v("den-l-1", "Đen", "L", 2, 2, { status: "OK" }),
    v("den-l-2", "Đen", "L", -1, 0, { status: "OUT" }),
    // Đã xoá ⇒ không có ô, không kéo thêm size "XL" vào ma trận.
    v("den-xl", "Đen", "XL", 50, 50, { isRemoved: true }),
  ]);
  assert.ok(mt);
  assert.deepEqual(mt!.sizes, ["S", "M", "L"], "mẫu mã đã xoá không được đẻ thêm cột size");
  assert.deepEqual(mt!.cell("Đen", "S"), { available: 3, erpStock: 4, status: "LOW", skus: "den-s" });
  assert.equal(mt!.cell("Trắng", "S")!.available, null, "chưa có phiếu nhập ⇒ chưa biết, không phải 0");
  assert.equal(mt!.cell("Trắng", "M")!.available, null, "một mẫu mã chưa biết ⇒ cả ô chưa biết");
  assert.equal(mt!.cell("Trắng", "M")!.erpStock, null);
  assert.deepEqual(mt!.cell("Đen", "L"), { available: 1, erpStock: 2, status: "OUT", skus: "den-l-1, den-l-2" });
  assert.equal(mt!.cell("Trắng", "L"), null, "không có mẫu mã ⇒ không có ô (khác với ô tồn 0)");

  console.log("✓ Tồn theo Màu × Size: chỉ xếp lại số sổ kho · ô có mẫu mã chưa biết ⇒ cả ô chưa biết · mức cảnh báo nặng nhất · mẫu mã đã xoá không có ô");
}
