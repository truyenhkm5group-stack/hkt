import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getViettelPostTrackingUrl } from "@/lib/constants/viettelpost";

/**
 * ═══════════ MỘT ĐỊA CHỈ TRA CỨU ĐVVC, DỰNG Ở ĐÚNG MỘT CHỖ ═══════════
 *
 * Nút "Tra cứu trên Viettel Post" ở trang chi tiết vận đơn nay có mặt ngay trên DANH SÁCH, cạnh
 * từng mã. Hai màn hình mở ra hai trang khác nhau từ cùng một dòng dữ liệu là lỗi không ai phát
 * hiện bằng mắt — người trực đơn chỉ thấy "Viettel Post nói không có đơn này".
 *
 * Nên bài kiểm khoá ba điều:
 *  1. Hình dạng địa chỉ đúng bằng hình dạng nút cũ ở trang chi tiết (`peopleTracking=sender`,
 *     `orderType=1`, mã đi qua `encodeURIComponent`).
 *  2. KHÔNG có mã Viettel Post ⇒ `null` ⇒ màn hình không vẽ liên kết. Không có đường lui sang
 *     `tracking_code`: đó là mã Pancake (`extend_code`) và thường KHÁC mã Viettel Post.
 *  3. Không tệp nào gõ lại chuỗi địa chỉ đó. Trước bản này có BỐN bản sao và chúng đã lệch nhau —
 *     hai nơi bọc `encodeURIComponent`, hai nơi ghép thẳng.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/vtp-tracking-link.test.ts
 */

const goc = path.resolve(__dirname, "..");
const THU_MUC = ["app", "components", "lib", "hooks", "scripts"];
/** Đúng một tệp được phép giữ chuỗi địa chỉ: nơi khai hàm dựng. */
const NOI_KHAI = "lib/constants/viettelpost.ts";

function liet(dir: string, ra: string[] = []): string[] {
  const p = path.join(goc, dir);
  if (!fs.existsSync(p)) return ra;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const con = path.join(dir, e.name);
    if (e.isDirectory()) liet(con, ra);
    else if (/\.tsx?$/.test(e.name)) ra.push(con.split(path.sep).join("/"));
  }
  return ra;
}

export function testVtpTrackingLink() {
  // ───────── 1. Hình dạng địa chỉ: đúng bằng nút cũ ở trang chi tiết vận đơn ─────────
  assert.equal(
    getViettelPostTrackingUrl("PKE1517075220"),
    "https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=PKE1517075220&orderType=1",
    "địa chỉ tra cứu phải y hệt nút “Tra cứu trên Viettel Post” ở trang chi tiết",
  );

  // ───────── 2. Chưa có mã Viettel Post ⇒ KHÔNG có liên kết, không phải liên kết rỗng ─────────
  for (const trong of [null, undefined, "", "   "]) {
    assert.equal(getViettelPostTrackingUrl(trong), null, `“${String(trong)}” phải ra null — một liên kết dẫn tới trang “không tìm thấy” tệ hơn không có liên kết`);
  }
  assert.equal(getViettelPostTrackingUrl("  PKE1517075220  "), getViettelPostTrackingUrl("PKE1517075220"), "khoảng trắng do dán nhầm không được đổi địa chỉ");

  // ───────── 3. Mã lạ phải được mã hoá, không được thoát ra thành tham số thứ hai ─────────
  const maLa = getViettelPostTrackingUrl("PKE 15&x=1")!;
  assert.ok(maLa.includes("orderNumber=PKE%2015%26x%3D1"), `mã phải đi qua encodeURIComponent, đang là: ${maLa}`);
  assert.equal(maLa.split("&").length, 3, "mã chứa dấu & không được tự sinh thêm tham số trong địa chỉ");

  // ───────── 4. Không ai được gõ lại chuỗi địa chỉ ─────────
  const viPham = THU_MUC.flatMap((d) => liet(d)).filter((f) => f !== NOI_KHAI && fs.readFileSync(path.join(goc, f), "utf8").includes("thong-tin-don-hang"));
  assert.deepEqual(viPham, [], `địa chỉ tra cứu Viettel Post bị gõ lại ở: ${viPham.join(", ")} — dùng getViettelPostTrackingUrl() thay vì một bản sao nữa`);

  // ───────── 5. Biểu tượng trên danh sách: mở tab mới, không cướp dòng, có nhãn trợ năng ─────────
  const icon = fs.readFileSync(path.join(goc, "components/vtp-tracking-link.tsx"), "utf8");
  assert.ok(icon.includes('target="_blank"'), "phải mở tab mới — người trực đơn đang ở giữa một danh sách đã lọc");
  assert.ok(icon.includes('rel="noopener noreferrer"'), "trang ĐVVC không được cầm window.opener của ERP");
  assert.ok(icon.includes('aria-label="Tra cứu vận đơn trên ViettelPost"'), "thiếu nhãn trợ năng thì trình đọc màn hình chỉ đọc “liên kết”");
  assert.ok(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(icon), "bấm biểu tượng KHÔNG được kích hoạt dòng / mở chi tiết ERP");
  assert.ok(icon.includes("getViettelPostTrackingUrl"), "biểu tượng phải dùng lại hàm dựng địa chỉ, không tự ghép chuỗi");
  assert.ok(/if \(!url\) return null;/.test(icon), "không có mã Viettel Post thì không vẽ gì — không vẽ nút chết");

  // ───────── 6. Danh sách vận đơn nối biểu tượng vào MÃ VIETTEL POST, không phải mã đang hiển thị ─────────
  const cot = fs.readFileSync(path.join(goc, "app/(dashboard)/shipments/columns.tsx"), "utf8");
  assert.ok(/<VtpTrackingLink code=\{s\.vtpOrderNumber\}/.test(cot), "cột mã vận đơn phải truyền vtpOrderNumber — `number` có thể đang là tracking_code của Pancake");

  console.log("✓ Tra cứu ViettelPost: một hàm dựng địa chỉ cho cả chi tiết lẫn danh sách · chỉ dựng từ mã Viettel Post · thiếu mã thì không vẽ liên kết · bấm biểu tượng không mở dòng");
}

if (process.argv[1] && /vtp-tracking-link\.test\.ts$/.test(process.argv[1])) {
  testVtpTrackingLink();
}
