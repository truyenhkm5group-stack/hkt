import assert from "node:assert/strict";
import { AUTO_CONFIRMABLE, MATCH_CONFIDENCES, MATCH_CONFIDENCE_LABEL, matchTransaction, type MatchCandidate } from "@/lib/integrations/bank/match";

/**
 * ═══════ ĐỐI KHỚP SAO KÊ ═══════
 *
 * Nối sai một dòng sao kê làm HAI sổ cùng lúc mất tin cậy: chứng từ bị đánh dấu đã trả trong khi
 * tiền thật đi chỗ khác. Nên mọi luật ở đây đều nghiêng về phía "thà không khớp còn hơn khớp bừa".
 *
 * Bốn điều được khoá, và điều thứ hai là lý do tồn tại của cả tệp.
 */

const ngay = (d: string) => new Date(`${d}T03:00:00Z`);

function ungVien(over: Partial<MatchCandidate> = {}): MatchCandidate {
  return { type: "EXPENSE", id: "e1", amount: 5_000_000, at: ngay("2026-09-05"), identifiers: [], label: "Khoản chi mẫu", ...over };
}

const saoKe = (over: Partial<Parameters<typeof matchTransaction>[0]> = {}) => ({
  id: "b1",
  amount: -5_000_000,
  txnAt: ngay("2026-09-05"),
  description: "",
  counterparty: "",
  ...over,
});

export function testBankMatch() {
  // ───────── 1. ĐỊNH DANH + TIỀN KHỚP ⇒ EXACT, và chỉ mức này được tự nối ─────────
  const exact = matchTransaction(saoKe({ description: "CK thanh toan BK-2026-0912 cho VTP" }), [
    ungVien({ id: "cod1", type: "COD_BATCH", identifiers: ["BK-2026-0912"] }),
    ungVien({ id: "khac", amount: 9_000_000 }),
  ]);
  assert.equal(exact.confidence, "EXACT", "có mã chứng từ trong nội dung và tiền khớp thì là khớp định danh");
  assert.equal(exact.target?.id, "cod1");
  assert.ok(exact.reasons.length >= 2, "phải nói VÌ SAO khớp — người dùng không tin một con số không giải thích được");
  assert.equal(AUTO_CONFIRMABLE.EXACT, true, "chỉ EXACT được tự nối");

  // ───────── 2. NHIỀU ỨNG VIÊN CÙNG SỐ TIỀN ⇒ KHÔNG BAO GIỜ tự chọn ─────────
  //
  // Đây là luật quan trọng nhất. Shop trả lương nhiều người cùng mức, trả xưởng nhiều đợt cùng giá —
  // số tiền trùng là chuyện thường ngày. Chọn đại một cái rồi đánh dấu "đã đối soát" tạo ra một sổ
  // sai mà TRÔNG NHƯ đã kiểm, và đó là kiểu sai không ai đi tìm lại.
  const nhapNhang = matchTransaction(saoKe(), [
    ungVien({ id: "e1" }),
    ungVien({ id: "e2" }),
    ungVien({ id: "e3" }),
  ]);
  assert.equal(nhapNhang.confidence, "AMBIGUOUS", "ba khoản cùng số tiền thì máy KHÔNG được chọn hộ");
  assert.equal(nhapNhang.target, null, "nhập nhằng thì tuyệt đối không trả về một mục tiêu");
  assert.equal(nhapNhang.others.length, 3, "phải đưa CẢ BA ứng viên cho người chọn, không giấu bớt");
  assert.ok(
    nhapNhang.reasons.some((r) => r.includes("KHÔNG nối bằng số tiền đơn độc")),
    "phải nói rõ vì sao không tự nối, nếu không người dùng tưởng máy hỏng",
  );

  // ───────── 3. MỘT ỨNG VIÊN, TIỀN + NGÀY KHỚP ⇒ ĐỀ XUẤT, không tự nối ─────────
  const deXuat = matchTransaction(saoKe(), [ungVien({ id: "e9", at: ngay("2026-09-07") })]);
  assert.equal(deXuat.confidence, "HIGH_CONFIDENCE", "duy nhất một ứng viên khớp tiền và gần ngày ⇒ gần như chắc");
  assert.equal(deXuat.target?.id, "e9");
  assert.equal(AUTO_CONFIRMABLE.HIGH_CONFIDENCE, false, "gần như chắc VẪN phải có người bấm — 'gần như' không phải 'chắc'");

  // Ngày lệch quá ngưỡng thì thôi đề xuất, không nới ngưỡng cho ra kết quả đẹp.
  const quaXa = matchTransaction(saoKe(), [ungVien({ at: ngay("2026-08-20") })]);
  assert.equal(quaXa.confidence, "UNMATCHED", "lệch ngày quá ngưỡng thì là CHƯA KHỚP, không phải khớp yếu");

  // ───────── 4. CÓ MÃ NHƯNG LỆCH TIỀN ⇒ manh mối mạnh, VẪN không tự nối ─────────
  const lechTien = matchTransaction(saoKe({ amount: -4_950_000, description: "TT hoa don HD-99881" }), [
    ungVien({ id: "sr1", type: "STOCK_RECEIPT", identifiers: ["HD-99881"], amount: 5_000_000 }),
  ]);
  assert.equal(lechTien.confidence, "AMBIGUOUS", "mã đúng mà tiền lệch thì phải có người xem — có thể là phí ngân hàng, có thể là ghép nhầm");
  assert.equal(lechTien.target, null);
  assert.ok(lechTien.reasons.some((r) => r.includes("SỐ TIỀN LỆCH")), "phải nêu rõ lệch bao nhiêu");

  // Mã quá ngắn KHÔNG được tính là định danh: nó trùng ngẫu nhiên với mọi nội dung, và khớp ngẫu
  // nhiên còn tệ hơn không khớp vì nó đội lốt bằng chứng.
  const maNgan = matchTransaction(saoKe({ description: "thanh toan a1 b2" }), [ungVien({ identifiers: ["a1"], amount: 5_000_000 }), ungVien({ id: "e2", amount: 5_000_000 })]);
  assert.equal(maNgan.confidence, "AMBIGUOUS", "mã hai ký tự không được nâng lên thành khớp định danh");

  // ───────── 5. Không có ứng viên nào ⇒ nói rõ là chưa khớp ─────────
  const khong = matchTransaction(saoKe(), []);
  assert.equal(khong.confidence, "UNMATCHED");
  assert.ok(khong.reasons.length > 0, "chưa khớp cũng phải nói vì sao");

  // Sổ đăng ký phải đầy đủ: thiếu nhãn thì giao diện hiện mã máy cho người dùng đọc.
  for (const c of MATCH_CONFIDENCES) assert.ok(MATCH_CONFIDENCE_LABEL[c]?.trim(), `${c}: thiếu nhãn tiếng Việt`);
  assert.equal(
    MATCH_CONFIDENCES.filter((c) => AUTO_CONFIRMABLE[c]).length,
    1,
    "ĐÚNG MỘT mức được tự nối — nới thêm mức nào nữa là bắt đầu ghi sổ bằng phỏng đoán",
  );

  console.log(
    "✓ Đối khớp sao kê: mã + tiền khớp ⇒ tự nối · nhiều ứng viên cùng tiền ⇒ KHÔNG tự chọn, trả cả danh sách · một ứng viên ⇒ đề xuất chờ người bấm · mã đúng tiền lệch ⇒ vẫn phải xem · mã quá ngắn không tính là định danh",
  );
}

// Chạy được độc lập (không cần CSDL), và cũng export để bộ kiểm thử chung dùng lại.
if (process.argv[1] && /bank-match\.test\.ts$/.test(process.argv[1])) {
  try {
    testBankMatch();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
