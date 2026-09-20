/**
 * CHẠY CÁC BÀI KIỂM VIẾT THEO KIỂU `node:test` — TÌM RA CHÚNG, KHÔNG BẮT AI ĐĂNG KÝ.
 *
 * ═══ VÌ SAO TỆP NÀY TỒN TẠI ═══
 *
 * `npm test` chạy đúng MỘT tệp: `tests/sync-fixtures.test.ts`, và tệp ấy gọi các bài kiểm khác
 * bằng cách `import` một hàm đã xuất. Kiểu ấy đòi mỗi bài kiểm mới phải được ĐĂNG KÝ tay.
 *
 * Bài kiểm viết bằng `node:test` thì không xuất hàm nào — nó gọi `test()` ở mức mô-đun. Không ai
 * import nó, nên nó KHÔNG CHẠY. Và một bài kiểm không chạy thì không phải một bài kiểm: nó là một
 * tệp trông như đang canh gác.
 *
 * Đo 20/09/2026: CHÍN tệp ở trạng thái ấy, 44 phép khẳng định chưa bao giờ chạy trong cổng — cả
 * bộ kiểm sổ giá, sổ nguồn ô đơn hàng, cầu dao và mô phỏng định tuyến. Tất cả đều XANH khi đem
 * chạy, nên không có gì hỏng; nhưng suốt thời gian ấy chúng không bảo vệ điều gì cả.
 *
 * Nên tệp này TỰ TÌM thay vì đọc một danh sách: một danh sách lại là một chỗ phải nhớ cập nhật,
 * và nó sẽ lại quên đúng như lần trước.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DIEM_VAO = "tests/sync-fixtures.test.ts";

const tatCa = execFileSync("git", ["ls-files", "tests/*.test.ts"], { encoding: "utf-8" })
  .split("\n")
  .map((d) => d.trim())
  .filter(Boolean);

const diemVao = readFileSync(DIEM_VAO, "utf-8");

const canChay = tatCa.filter((tep) => {
  if (tep === DIEM_VAO) return false;
  if (!/from "node:test"/.test(readFileSync(tep, "utf-8"))) return false;
  // Tệp vừa dùng `node:test` vừa được điểm vào import thì đã chạy rồi — chạy lần nữa là đếm đôi.
  const ten = tep.replace(/^tests\//, "").replace(/\.ts$/, "");
  return !diemVao.includes(`"./${ten}"`);
});

if (!canChay.length) {
  console.log("Không có bài kiểm kiểu node:test nào cần chạy riêng.");
  process.exit(0);
}

console.log(`── ${canChay.length} tệp kiểm kiểu node:test ──`);
for (const tep of canChay) console.log(`   ${tep}`);
console.log("");

try {
  execFileSync("npx", ["tsx", "--test", "--tsconfig", "tsconfig.json", ...canChay], { stdio: "inherit" });
} catch {
  console.error("\n✗ CÓ BÀI KIỂM ĐỎ — xem TAP ở trên.");
  process.exit(1);
}
