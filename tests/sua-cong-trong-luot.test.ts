import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GATE_REPAIR, congChiPhi, dungPhanHoiCong } from "@/lib/constants/agent-gate-repair";

/**
 * ═══════════ CỔNG ĐỎ THÌ CHO AGENT SỬA MỘT LẦN, NGAY TRONG LƯỢT CHẠY ═══════════
 *
 * ĐÃ ĐO — hai lượt liền mất trắng vì đúng một chỗ hở:
 *
 *     Lượt #23   QA viết bài kiểm · 20 vòng · $0,2719 · typecheck=FAILED ⇒ không commit
 *     Lượt #24   QA viết bài kiểm · 18 vòng · $0,3024 · typecheck=FAILED ⇒ không commit
 *
 * Runner chạy bốn cổng SAU khi agent gọi `finish`, nên agent chưa từng nhìn thấy thông báo lỗi của
 * chính mình. Cả hai lượt nó đều tin là đã xong — và nó không sai về ý thức, nó chỉ không có cách
 * nào biết.
 */

const goc = path.resolve(__dirname, "..");

export function testSuaCongTrongLuot() {
  /* ───────── CÂU PHẢN HỒI PHẢI NÓI ĐỦ BA ĐIỀU, VÀ KHÔNG MỚM LỐI THOÁT RẺ ───────── */
  const p = dungPhanHoiCong([{ ten: "npm run typecheck", exitCode: 2, dauRa: "tests/x.test.ts(9,5): error TS2345: sai kiểu" }]);
  assert.match(p, /CHƯA XONG/, "phải nói thẳng là chưa xong");
  assert.match(p, /error TS2345/, "phải đưa đúng thông báo lỗi, không tóm tắt lại");
  assert.match(p, /VẪN CÒN NGUYÊN/, "phải nói tệp còn nguyên — nếu không agent sẽ viết lại từ đầu");
  assert.match(p, /DUY NHẤT/, "phải nói đây là lần sửa duy nhất");

  /*
    Câu nhắc KHÔNG được mớm "xoá bài kiểm đi cho xanh" — đó là lối thoát rẻ nhất và tệ nhất, và
    một câu nhắc mớm sẵn lối ấy sẽ được dùng.
  */
  assert.match(p, /TUYỆT ĐỐI không xoá/, "phải chặn trước lối thoát xoá bài kiểm");

  /* Chỉ cổng ĐỎ mới được nhắc tới: kể cả cổng xanh là làm loãng đúng thứ cần đọc. */
  const hai = dungPhanHoiCong([
    { ten: "npm run typecheck", exitCode: 2, dauRa: "loi-A" },
    { ten: "npm test", exitCode: 1, dauRa: "loi-B" },
  ]);
  assert.match(hai, /loi-A/);
  assert.match(hai, /loi-B/);
  assert.ok(!/npm run lint/.test(hai), "cổng KHÔNG đỏ thì không xuất hiện trong phản hồi");

  /* Đầu ra dài bị cắt từ ĐUÔI — dòng `error TS…` cuối cùng mới là dòng đáng đọc. */
  const dai = dungPhanHoiCong([{ ten: "npm run typecheck", exitCode: 2, dauRa: "x".repeat(50_000) + "DONG-CUOI" }]);
  assert.match(dai, /DONG-CUOI/, "phải giữ ĐUÔI đầu ra");
  assert.ok(dai.length < GATE_REPAIR.doDaiLoi + 1_000, "và không được để một đầu ra dài làm tràn ngữ cảnh");

  /* ───────── ĐÚNG MỘT LẦN SỬA ───────── */
  assert.equal(GATE_REPAIR.toiDa, 1, "một lượt chạy chỉ được sửa MỘT lần — mỗi vòng đều tính tiền thật");

  /* ───────── CỘNG TIỀN: MỘT VẾ CHƯA BIẾT LÀM TỔNG CHƯA BIẾT ───────── */
  const a = { soVong: 3, vao: 10, ra: 20, demDoc: 5, demGhi: 2, usd: 0.1 };
  const b = { soVong: 2, vao: 1, ra: 2, demDoc: 3, demGhi: 4, usd: 0.05 };
  const t = congChiPhi(a, b);
  assert.deepEqual(t, { soVong: 5, vao: 11, ra: 22, demDoc: 8, demGhi: 6, usd: 0.15 }, "cộng đủ mọi vế");
  assert.equal(congChiPhi(a, { ...b, usd: null }).usd, null, "một vòng không định giá được ⇒ TỔNG là chưa biết, không phải vế kia");
  assert.equal(congChiPhi({ ...a, usd: null }, b).usd, null, "và đúng theo cả hai chiều");
  assert.equal(congChiPhi(a, { ...b, usd: null }).soVong, 5, "nhưng số vòng vẫn cộng — chưa biết TIỀN không có nghĩa là chưa biết gì cả");

  /* ───────── ĐƯỜNG THỰC THI: QUÉT MÃ NGUỒN ───────── */
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const rn = bo(readFileSync(path.join(goc, "lib/agents/runner.ts"), "utf8"));

  assert.match(rn, /dungPhanHoiCong\(/, "runner phải đưa lỗi cổng lại cho agent");
  assert.match(rn, /congChiPhi\(/, "và phải CỘNG tiền của lượt sửa vào, không bỏ đi");

  /*
    CHỈ SỬA KHI AGENT ĐÃ GỌI `finish`.

    Nó dừng giữa chừng vì lý do khác (hết vòng, bỏ cuộc) thì cổng đỏ không phải thứ đáng nói tới
    trước — và đưa lỗi cổng cho một agent đang lạc là đốt thêm tiền cho cùng một chỗ lạc.
  */
  assert.match(rn, /outcome\.finished\s*&&\s*GATE_REPAIR\.toiDa/, "chỉ sửa khi agent ĐÃ gọi finish");

  /*
    ĐỀ BÀI DỰNG MỘT CHỖ.

    Lượt sửa phải nhận đề bài Y HỆT lượt đầu, chỉ khác phần phản hồi. Hai nơi dựng đề bài là hai
    nơi sẽ trôi xa nhau — đúng lớp lỗi đã cắn bốn lần trong dây chuyền này.
  */
  assert.equal((rn.match(/taskDescription: task\.description/g) ?? []).length, 1, "đề bài chỉ được dựng ở MỘT chỗ");

  /* Và cổng phải chạy LẠI sau khi sửa — không thì lượt sửa chỉ là một lời an ủi. */
  assert.ok((rn.match(/chayCong\(\)/g) ?? []).length >= 2, "phải chạy lại cổng sau lượt sửa");

  console.log("✓ Sửa cổng trong lượt: phản hồi mang đúng lỗi · không mớm lối xoá bài kiểm · đúng MỘT lần · tiền cộng dồn và chưa-biết lan đúng · đề bài dựng một chỗ · cổng chạy lại");
}
