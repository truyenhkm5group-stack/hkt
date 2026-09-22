import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BAC_COPILOT_MAC_DINH,
  BAC_COPILOT_SAU,
  KHOA_TRAN_NGAY,
  TRAN_NGAY_USD_MAC_DINH,
  bacChoLuotHoi,
  xetTranNgay,
} from "@/lib/constants/ai-budget";
import { dauNgayVN } from "@/lib/ai/budget";

/**
 * ═══════════ PHANH TIỀN AI, VÀ BẬC MẶC ĐỊNH LÀ BẬC RẺ ═══════════
 *
 * ĐÃ CẮN THẬT 22/09/2026: khoá API hết sạch tín dụng giữa một lượt chạy, và **không màn hình nào
 * trong ERP nói được "hôm nay AI đã tiêu bao nhiêu"** — dù `ai_interactions` đã ghi từng lượt gọi
 * từ lâu.
 *
 * Bằng chứng con số ấy chưa từng được ai cộng: cột `cost_usd` lưu dạng CHỮ và có dòng để rỗng,
 * nên `sum(cost_usd::numeric)` ĐỎ NGAY ở lượt đầu tiên. Ai cộng nó một lần cũng đã vấp.
 *
 * Phép đo lấy được sau khi vá phép cộng — 68 lượt Copilot ERP ở `/shipments`, model `claude-opus-5`:
 *
 *     số vòng | lượt | usd/lượt | tổng   | dùng công cụ | lỗi
 *        1    |  13  |  0,0000  |  0,000 |      0       | 13
 *        2    |  55  |  0,0722  |  3,969 |     55       |  5
 *
 * Mọi lượt THÀNH CÔNG cùng một hình dạng. Không tách được khó/dễ từ lịch sử ⇒ máy KHÔNG đoán.
 */

const goc = path.resolve(__dirname, "..");

export function testPhanhTienAi() {
  /* ───────── DƯỚI TRẦN THÌ CHO, CHẠM TRẦN THÌ DỪNG ───────── */
  const duoi = xetTranNgay({ daTieu: 0.5, tran: 2 });
  assert.ok(duoi.choPhep && duoi.conLai === 1.5, "dưới trần ⇒ cho gọi, và nói còn bao nhiêu");

  const cham = xetTranNgay({ daTieu: 2, tran: 2 });
  assert.ok(!cham.choPhep, "CHẠM trần là hết — `>=` chứ không phải `>`");
  assert.match(cham.choPhep ? "" : cham.ly, /chạm trần/i, "và phải nói rõ vì sao bị dừng");
  assert.match(cham.choPhep ? "" : cham.ly, new RegExp(KHOA_TRAN_NGAY.replace(".", "\\.")), "phải chỉ đúng khoá cài đặt để đổi trần — người đọc cần sửa được, không chỉ cần biết");

  assert.ok(!xetTranNgay({ daTieu: 99, tran: 2 }).choPhep, "vượt xa trần cũng dừng");

  /*
    ───────── KHÔNG ĐỌC ĐƯỢC SỔ ⇒ CHO GỌI, KHÔNG PHẢI CHẶN ─────────

    Chặn vì không đo được là biến một lỗi đọc sổ thành một lần ERP mất trí nhớ. CHƯA BIẾT không
    phải là ĐÃ VƯỢT TRẦN (AGENTS.md mục 42) — nhưng nơi gọi phải nêu cảnh báo, và bộ gác quét mã
    nguồn bên dưới đòi đúng điều đó.
  */
  const chuaBiet = xetTranNgay({ daTieu: null, tran: 2 });
  assert.ok(chuaBiet.choPhep, "không đọc được sổ ⇒ vẫn cho gọi");

  /* Trần <= 0 rơi về mặc định, không rơi về "cấm tất". */
  assert.equal(xetTranNgay({ daTieu: 0, tran: 0 }).tran, TRAN_NGAY_USD_MAC_DINH, "trần 0 là chưa khai, không phải cấm");
  assert.equal(xetTranNgay({ daTieu: 0, tran: -5 }).tran, TRAN_NGAY_USD_MAC_DINH, "trần âm cũng vậy");

  /* ───────── BẬC: RẺ LÀ MẶC ĐỊNH, NGƯỜI HỎI NÂNG ───────── */
  assert.equal(bacChoLuotHoi({}), BAC_COPILOT_MAC_DINH, "mặc định là bậc rẻ");
  assert.equal(BAC_COPILOT_MAC_DINH, "routine", "và bậc rẻ ấy phải là routine");
  assert.equal(bacChoLuotHoi({ sauHon: true }), BAC_COPILOT_SAU, "người hỏi bấm 'hỏi kỹ' ⇒ nâng bậc");
  assert.notEqual(BAC_COPILOT_MAC_DINH, BAC_COPILOT_SAU, "hai bậc phải khác nhau, nếu không cái nút ấy vô nghĩa");

  /* ───────── MỐC NGÀY THEO GIỜ VIỆT NAM ─────────
     Trần "mỗi ngày" mà cắt theo UTC thì nó reset lúc 7 giờ sáng giờ Việt Nam — giữa buổi làm việc. */
  const trua = new Date("2026-09-22T05:00:00Z"); // 12:00 giờ VN
  assert.equal(dauNgayVN(trua).toISOString(), "2026-09-21T17:00:00.000Z", "00:00 giờ VN = 17:00Z hôm trước");
  const khuya = new Date("2026-09-22T16:30:00Z"); // 23:30 giờ VN
  assert.equal(dauNgayVN(khuya).toISOString(), "2026-09-21T17:00:00.000Z", "vẫn cùng NGÀY VIỆT NAM");
  const sauNuaDem = new Date("2026-09-22T17:30:00Z"); // 00:30 giờ VN hôm sau
  assert.equal(dauNgayVN(sauNuaDem).toISOString(), "2026-09-22T17:00:00.000Z", "qua nửa đêm giờ VN là ngày mới");

  console.log("✓ Phanh tiền AI: chạm trần thì DỪNG · chưa đọc được sổ thì vẫn cho gọi · trần chưa khai rơi về mặc định · bậc rẻ là mặc định · ngày cắt theo giờ VN");
}

/* ═════════════ QUÉT MÃ NGUỒN ═════════════ */

export function testPhanhTienAiGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const cop = bo(readFileSync(path.join(goc, "lib/ai/copilot.ts"), "utf8"));
  const bud = bo(readFileSync(path.join(goc, "lib/ai/budget.ts"), "utf8"));

  /*
    PHANH PHẢI CHẶN TRƯỚC KHI GỌI MODEL.

    Một cảnh báo sau khi đã gọi thì tiền đã tiêu rồi. Bộ gác đòi phép xét trần đứng TRƯỚC vòng lặp
    gọi provider trong mã nguồn.
  */
  const iTran = cop.indexOf("xetTranNgay(");
  const iGoi = cop.indexOf("provider.complete(");
  assert.ok(iTran > 0, "copilot phải xét trần ngày");
  assert.ok(iGoi > 0 && iTran < iGoi, "phép xét trần phải đứng TRƯỚC lời gọi model — sau thì tiền đã tiêu");

  /*
    VÀ PHÁN QUYẾT PHẢI CÓ TÁC DỤNG.

    Bản đầu của bộ gác này chỉ kiểm `xetTranNgay(` CÓ MẶT trước lời gọi. Đột biến "đổi điều kiện
    thành `if (false)`" SỐNG SÓT: phép xét vẫn chạy, kết quả vẫn bị vứt, model vẫn được gọi.
    Một bộ gác đo sự CÓ MẶT thay vì đo TÁC DỤNG là một bộ gác không đo gì.
  */
  const khoiPhanh = cop.slice(iTran, iGoi);
  assert.match(khoiPhanh, /!\s*\w+\.choPhep[\s\S]{0,200}return/, "phán quyết trần phải DỪNG lượt gọi, không chỉ được tính rồi bỏ đi");
  assert.match(khoiPhanh, /AI_BUDGET_EXCEEDED/, "và phải trả về một mã lỗi đọc được, để nơi gọi phân biệt với lỗi khác");

  /* Bậc lấy từ luật thuần, không gõ thẳng tên model hay tên bậc trong copilot. */
  assert.match(cop, /bacChoLuotHoi\(/, "bậc phải lấy từ luật thuần");
  assert.ok(!/getAiProvider\(\)/.test(cop), "KHÔNG được để `getAiProvider()` trống — nó rơi về bậc `copilot` (đắt nhất) cho MỌI câu hỏi");

  /*
    PHÉP CỘNG PHẢI BỎ QUA CHUỖI RỖNG.

    `cost_usd` là cột CHỮ và có dòng rỗng; `sum(cost_usd::numeric)` ném lỗi ngay. Thiếu `nullif`
    thì phép đo chết đúng lúc cần nhất — và đó chính là lý do con số này chưa từng được cộng.
  */
  assert.match(bud, /nullif\(/, "phép cộng tiền phải bỏ qua chuỗi rỗng");
  assert.match(bud, /chuaDoDuoc|chuaDo/, "và phải ĐẾM RIÊNG số lượt chưa định giá được — tổng đang thiếu chừng ấy lượt");

  /* Không đọc được sổ ⇒ trả `null`, KHÔNG trả 0. */
  assert.match(bud, /usd:\s*null/, "không đọc được sổ phải trả null, không phải 0 (mục 42)");

  console.log("✓ Quét mã nguồn: phanh chặn TRƯỚC khi gọi model · bậc lấy từ luật thuần · phép cộng bỏ qua chuỗi rỗng và đếm riêng phần chưa đo được");
}
