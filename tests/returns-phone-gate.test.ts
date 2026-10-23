import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * ═══════ SĐT KHÁCH Ở /reports/returns CHỈ CHO NGƯỜI CÓ QUYỀN XEM ĐƠN ═══════
 *
 * Bảng đơn (`/orders`) hiện SĐT cho người có `orders:read`. Khối drill «đơn của mẫu mã» trên trang tỷ lệ
 * giao thành công từng in SĐT cho MỌI người có `reports:returns` — một lối thứ hai thấy SĐT mà quyền xem
 * đơn không cấp. Luật 30: phạm vi chỉ THU HẸP, nên ở đây SĐT đi cùng đúng quyền của bảng đơn.
 *
 * Kiểm ở mức MÃ NGUỒN, cho CẢ thư mục: mọi chỗ in `billPhone` phải đứng cùng dòng với điều kiện quyền.
 * Một khối mới thêm sau này mà quên gác là đỏ ngay, không đợi ai đó nhìn thấy SĐT trên màn hình.
 */
export function testReturnsPhoneGate() {
  const dir = path.join("app", "(dashboard)", "reports", "returns");
  const tep = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  const viPham: string[] = [];
  let soCho = 0;
  for (const f of tep) {
    const dong = readFileSync(path.join(dir, f), "utf8").split(/\r?\n/);
    dong.forEach((l, i) => {
      const ma = l.replace(/\/\/.*$/, "").replace(/\{\/\*.*?\*\/\}/g, "");
      if (!/\.billPhone\b/.test(ma)) return;
      soCho += 1;
      if (!/canSeePhone|can\(user, "orders:read"\)/.test(ma)) viPham.push(`${f}:${i + 1}`);
    });
  }
  assert.ok(soCho >= 1, "phải còn ít nhất một chỗ in SĐT — mất hết thì bài kiểm này đang không kiểm gì");
  assert.deepEqual(viPham, [], `SĐT in ra mà không gác quyền xem đơn: ${viPham.join(", ")}`);
  console.log(`✓ SĐT khách ở /reports/returns: ${soCho} chỗ in, mọi chỗ đều gác bằng quyền xem đơn (orders:read) — không lối thứ hai thấy SĐT`);
}
