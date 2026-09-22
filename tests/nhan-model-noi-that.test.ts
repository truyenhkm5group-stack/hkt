import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BAC_COPILOT_MAC_DINH, BAC_COPILOT_SAU } from "@/lib/constants/ai-budget";
import { MODEL_BY_TIER } from "@/lib/ai/router";

/**
 * ═══════════ NHÃN MODEL PHẢI NÓI ĐÚNG MODEL SẼ TRẢ LỜI ═══════════
 *
 * ĐÃ CẮN THẬT 22/09/2026. Chủ shop mở Copilot ở `/shipments`; nhãn góc trên ghi `claude-opus-5`.
 * Sổ `ai_interactions` của CHÍNH câu hỏi ấy ghi:
 *
 *     03:14:51 | claude-haiku-4-5-20251001 | $0,018574 | OK
 *
 * Nhãn lấy `modelFor(name, "copilot")` — hằng số TĨNH của bậc `copilot` — trong khi lượt hỏi thật
 * đi bằng bậc mặc định. Hai nơi nói hai điều, và cái người dùng nhìn thấy là cái SAI.
 *
 * Một con số trên màn hình không khớp thứ thật sự xảy ra thì TỆ HƠN không hiện gì: người đọc dùng
 * nó để quyết định. Ở đây nó còn che mất chính việc hạ bậc vừa làm — nhìn nhãn thì tưởng không có
 * gì đổi.
 *
 * ─── VÀ HẠ BẬC PHẢI ĐI KÈM LỐI NÂNG ───
 *
 * Bậc mặc định nay rẻ hơn 4,6 lần. Hạ bậc mà KHÔNG để lại đường nâng là bắt người dùng chịu câu
 * trả lời kém cho câu hỏi khó — họ sẽ thôi dùng, và cái mất lớn hơn số tiền tiết kiệm.
 *
 * Máy KHÔNG tự đoán câu nào khó (68 lượt thật đều cùng một hình dạng). Nên đường nâng là một NÚT,
 * và bài kiểm này đòi nó nối thông từ giao diện tới tận nơi chọn model.
 */

const goc = path.resolve(__dirname, "..");
const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function testNhanModelNoiThat() {
  const act = bo(readFileSync(path.join(goc, "lib/actions/ai.ts"), "utf8"));

  /*
    NHÃN DỰNG TỪ CÙNG HÀM MÀ LƯỢT HỎI DÙNG.

    Gõ lại tên bậc ở đây là mở đường cho hai nơi trôi xa nhau — đúng thứ vừa xảy ra.
  */
  assert.match(act, /bacChoLuotHoi\(/, "nhãn phải dựng từ cùng hàm quyết bậc mà lượt hỏi dùng");
  assert.ok(!/modelFor\(name,\s*"copilot"\)/.test(act), 'KHÔNG được ghi cứng bậc "copilot" cho nhãn — lượt hỏi thật đi bằng bậc mặc định');

  /* Hai bậc phải ra hai model KHÁC nhau, nếu không cái nút "Hỏi kỹ" chỉ là trang trí. */
  for (const p of ["anthropic", "openai"] as const) {
    assert.notEqual(
      MODEL_BY_TIER[p][BAC_COPILOT_MAC_DINH],
      MODEL_BY_TIER[p][BAC_COPILOT_SAU],
      `provider ${p}: bậc mặc định và bậc "hỏi kỹ" phải ra model khác nhau`,
    );
  }

  /* ───────── LỐI NÂNG BẬC PHẢI NỐI THÔNG TỪ NÚT TỚI PROVIDER ─────────
     Bốn mắt xích; đứt một mắt là cái nút bấm xong không đổi gì, và không ai biết. */
  const ui = readFileSync(path.join(goc, "components/ai-copilot.tsx"), "utf8");
  assert.match(ui, /Hỏi kỹ/, "giao diện phải có nút nâng bậc — hạ bậc mà không có lối thoát là bắt người dùng chịu");
  assert.match(bo(ui), /send\(input,\s*context,\s*true\)/, "nút phải thật sự gửi cờ nâng bậc, không chỉ hiện ra");
  assert.match(act, /sauHon:\s*z\.boolean\(\)/, "lược đồ đầu vào phải nhận cờ ấy, nếu không nó bị vứt lặng lẽ ở server action");

  const cop = bo(readFileSync(path.join(goc, "lib/ai/copilot.ts"), "utf8"));
  assert.match(cop, /bacChoLuotHoi\(\{\s*sauHon:\s*input\.sauHon\s*\}\)/, "cờ phải đi tới tận nơi chọn bậc model");

  console.log("✓ Nhãn model nói thật: dựng từ cùng hàm quyết bậc · hai bậc ra hai model khác nhau · nút 'Hỏi kỹ' nối thông từ giao diện tới provider");
}
