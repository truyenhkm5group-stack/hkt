import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiAgentExecutor } from "@/lib/agents/executor";
import { TIER_MAC_DINH, tierForRole } from "@/lib/constants/agent-model";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { estimateCostUsd, giaCuaModel, khoaGiaKhop } from "@/lib/ai/provider";
import type { AiProvider } from "@/lib/ai/provider";

/**
 * ═══════════ TIỀN CỦA MỘT LƯỢT CHẠY AGENT ═══════════
 *
 * Chủ shop 21/09/2026: *"mới đang ở khâu test luồng mà đã hết $25"*. Và không ai — kể cả tôi —
 * chỉ ra được tiền đi đâu, vì lượt chạy agent diễn ra trên máy Actions với CSDL tạm và KHÔNG ghi
 * vào `ai_interactions` của production.
 *
 * Đo ra ba chỗ, và bài này khoá cả ba:
 *
 *   1. Runner gọi bậc `copilot` cho MỌI vai ⇒ `claude-opus-5` ($5/M vào · $25/M ra) để viết một
 *      tệp Markdown. Nay bậc đi theo VAI, và mặc định là bậc RẺ.
 *   2. Vòng lặp gửi lại toàn bộ lịch sử mỗi vòng, nhưng chỉ prompt hệ thống được đệm.
 *   3. Không có phép đo nào cho từng lượt chạy — nên mọi lượt "tối ưu" đều là niềm tin.
 */

const goc = path.resolve(__dirname, "..");

/* ═════════════ 1 · BẬC MODEL ĐI THEO VAI, MẶC ĐỊNH LÀ RẺ ═════════════ */

export function testBacModelTheoVai() {
  assert.equal(tierForRole("DOCUMENTATION"), "routine", "vai viết tài liệu không cần model đắt nhất");
  assert.equal(tierForRole("QA"), "routine");

  /*
    VAI CHƯA KHAI RƠI VỀ PHÍA RẺ.

    Quên khai một vai mới thì tốn ít tiền và có thể làm kém — người xem thấy ngay ở review. Quên
    theo chiều ngược lại thì tốn nhiều tiền một cách ÂM THẦM, và không có gì đỏ lên.
  */
  assert.equal(tierForRole("BACKEND"), TIER_MAC_DINH);
  assert.equal(tierForRole(null), TIER_MAC_DINH);
  assert.equal(tierForRole(undefined), TIER_MAC_DINH);
  assert.equal(TIER_MAC_DINH, "routine", "mặc định phải là bậc rẻ nhất");

  /*
    VÀ BẬC RẺ PHẢI THẬT SỰ RẺ HƠN.

    Khai `routine` mà bậc ấy lại trỏ vào cùng một model với `copilot` thì cả luật này chỉ là trang
    trí. Bài kiểm đọc chính bảng model đang chạy.
  */
  const a = MODEL_BY_TIER.anthropic;
  assert.notEqual(a.routine, a.copilot, "bậc routine và copilot phải là hai model khác nhau");

  const price = readFileSync(path.join(goc, "lib/ai/provider.ts"), "utf8");
  const gia = (model: string) => {
    const m = price.match(new RegExp(`"${model}":\\s*\\{[^}]*output:\\s*([0-9.]+)`));
    return m ? Number(m[1]) : null;
  };
  const giaRoutine = gia(a.routine);
  const giaCopilot = gia(a.copilot);
  assert.ok(giaRoutine !== null && giaCopilot !== null, "cả hai model phải có trong bảng giá — không có giá thì không so được");
  assert.ok(giaRoutine < giaCopilot, `bậc routine (${a.routine}: $${giaRoutine}/M ra) phải rẻ hơn copilot (${a.copilot}: $${giaCopilot}/M ra)`);
}

/* ═════════════ 2 · ĐỆM CẢ PHẦN ĐẦU HỘI THOẠI ═════════════ */

export function testDemHoiThoai() {
  const src = readFileSync(path.join(goc, "lib/ai/provider.ts"), "utf8");
  const than = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /*
    Đệm phải đánh dấu lên khối CUỐI của tin nhắn CUỐI — Anthropic đệm toàn bộ tiền tố tính tới
    điểm ấy. Đánh dấu ở chỗ khác thì phần lịch sử lặp lại vẫn trả giá đầy đủ mỗi vòng.
  */
  assert.ok(/req\.messages\.length - 1/.test(than), "phải xác định tin nhắn cuối cùng để đặt mốc đệm");
  assert.ok(/m\.content\.length - 1/.test(than), "và khối cuối cùng của tin nhắn ấy");
  const soDem = (than.match(/cache_control/g) ?? []).length;
  assert.ok(soDem >= 2, `phải đệm CẢ prompt hệ thống lẫn phần đầu hội thoại, đang thấy ${soDem} chỗ`);
}

/* ═════════════ 3 · MỖI LƯỢT CHẠY PHẢI ĐẾM ĐƯỢC TIỀN ═════════════ */

function providerGia(luot: { text?: string; finish?: string }[], usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, model = "claude-haiku-4-5") {
  let i = 0;
  const p = {
    name: "gia",
    model,
    async complete() {
      const b = luot[Math.min(i, luot.length - 1)];
      i += 1;
      const content = b.finish !== undefined
        ? [{ type: "tool_use" as const, id: `t${i}`, name: "finish", input: { summary: b.finish } }]
        : [{ type: "text" as const, text: b.text ?? "" }];
      return { content, usage, model };
    },
  };
  return p as unknown as AiProvider;
}

const JOB = {
  taskCode: "TECH-2",
  taskTitle: "Viết tài liệu",
  taskDescription: "",
  writeGlobs: ["docs/"] as const,
  readGlobs: ["docs/", "lib/"] as const,
  baseCommit: "abc1234",
  branch: "ai/documentation/TECH-2-x",
  workspace: null as never,
};

export async function testDemTienLuotChay() {
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300 };
  const ra = await new AiAgentExecutor(providerGia([{ finish: "xong" }], usage), null).run(JOB);

  assert.equal(ra.chiPhi.soVong, 1);
  assert.equal(ra.chiPhi.vao, 1000);
  assert.equal(ra.chiPhi.ra, 200);
  assert.equal(ra.chiPhi.demDoc, 5000, "token đọc từ đệm phải được đếm RIÊNG — nó rẻ hơn mười lần, gộp vào là mất chính con số chứng minh đệm có tác dụng");
  assert.equal(ra.chiPhi.demGhi, 300);
  // haiku: vào $1/M · ra $5/M · đệm đọc $0,1/M · đệm ghi $1,25/M
  assert.ok(ra.chiPhi.usd !== null && Math.abs(ra.chiPhi.usd - (1000 * 1 + 200 * 5 + 5000 * 0.1 + 300 * 1.25) / 1_000_000) < 1e-9, `tiền phải khớp bảng giá, đang là ${ra.chiPhi.usd}`);

  // Nhiều vòng thì cộng dồn.
  const nhieu = await new AiAgentExecutor(providerGia([{ text: "chưa xong" }, { finish: "xong" }], usage), null).run(JOB);
  assert.equal(nhieu.chiPhi.soVong, 2);
  assert.equal(nhieu.chiPhi.vao, 2000);

  /*
    ───────── MỘT VÒNG KHÔNG ĐỊNH GIÁ ĐƯỢC LÀM CẢ LƯỢT THÀNH CHƯA BIẾT ─────────

    Cộng phần định giá được rồi in nó ra như một tổng là nói dối bằng phép cộng: con số nhỏ hơn sự
    thật mà trông y như một phép đo đầy đủ (AGENTS.md mục 42).
  */
  const la = await new AiAgentExecutor(providerGia([{ finish: "xong" }], usage, "model-chua-khai-gia"), null).run(JOB);
  assert.equal(la.chiPhi.usd, null, "model không có trong bảng giá ⇒ tiền là CHƯA BIẾT, không phải 0");
  assert.equal(la.chiPhi.vao, 1000, "nhưng token thì vẫn đếm được và vẫn phải đếm");

  // Chưa gọi model lần nào (chưa bật AI) ⇒ 0 thật, không phải chưa biết.
  const tat = await new AiAgentExecutor(null, "chưa bật").run(JOB);
  assert.equal(tat.chiPhi.usd, 0);
  assert.equal(tat.chiPhi.soVong, 0);
}

/* ═════════════ 3b · TÊN MODEL TRẢ VỀ ≠ TÊN TRONG BẢNG GIÁ ═════════════ */

/**
 * ĐÃ CẮN THẬT — lượt chạy agent #16. Kho gọi bí danh `claude-haiku-4-5`; Anthropic trả về
 * `claude-haiku-4-5-20251001`. Tra thẳng chuỗi ấy không thấy gì, nên cả lượt chạy in
 * **"tiền: CHƯA ĐO ĐƯỢC"** — đúng luật nhưng vô dụng: phép đo sinh ra để trả lời "tốn bao nhiêu"
 * lại không trả lời được câu nào.
 */
export function testTraGiaTheoTienTo() {
  const alias = MODEL_BY_TIER.anthropic.routine;
  assert.ok(giaCuaModel(alias), "bí danh phải tra được");
  assert.deepEqual(giaCuaModel(`${alias}-20251001`), giaCuaModel(alias), "bí danh + ngày phát hành phải ra CÙNG một bảng giá");

  /*
    KHỚP TIỀN TỐ DÀI NHẤT, KHÔNG PHẢI KHỚP ĐẦU TIÊN.

    Nếu một ngày bảng giá có cả `claude-opus-5` lẫn một biến thể dài hơn, khớp đầu tiên sẽ tính
    giá model to cho model nhỏ — sai theo hướng ĐẮT LÊN, và không ai kiểm lại một con số đã có vẻ
    hợp lý. Bài này dựng đúng tình huống ấy bằng hai khoá có thật trong bảng.
  */
  const KHOA = ["claude-opus-5", "claude-opus-5-mini"];
  assert.equal(khoaGiaKhop("claude-opus-5-mini-20260101", KHOA), "claude-opus-5-mini", "biến thể phải ăn giá của CHÍNH nó, không phải của model to hơn");
  assert.equal(khoaGiaKhop("claude-opus-5-20260101", KHOA), "claude-opus-5");
  assert.equal(khoaGiaKhop("claude-sonnet-9", KHOA), null, "không khớp tiền tố nào ⇒ CHƯA BIẾT, không đoán");

  const opus = MODEL_BY_TIER.anthropic.copilot;
  assert.deepEqual(giaCuaModel(`${opus}-20260101`), giaCuaModel(opus));
  assert.notDeepEqual(giaCuaModel(`${alias}-20251001`), giaCuaModel(opus), "biến thể của haiku KHÔNG được ăn giá của opus");

  // Model chưa khai vẫn phải là CHƯA BIẾT — đoán giá còn tệ hơn nói không biết.
  assert.equal(giaCuaModel("model-hoan-toan-la"), null);
  assert.equal(estimateCostUsd("model-hoan-toan-la", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
}

/* ═════════════ 4 · KHÔNG AI LẶNG LẼ NÂNG BẬC LÊN LẠI ═════════════ */

export function testKhongNangBacAmTham() {
  const cli = readFileSync(path.join(goc, "scripts/agent-run.ts"), "utf8");
  const than = cli.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  assert.ok(/getAiProvider\(bac\)/.test(than), "runner phải lấy bậc từ VAI, không gõ cứng");
  assert.ok(!/getAiProvider\("copilot"\)|getAiProvider\("analysis"\)/.test(than), "KHÔNG được gõ cứng bậc đắt trong đường chạy agent");
  assert.ok(/tierForRole/.test(than), "phải đi qua sổ khai bậc theo vai");
  // Và tiền phải được in ra — một con số không ai thấy là một con số không ai dùng.
  /*
    KHẲNG ĐỊNH VÀO ĐÚNG VẾ ĐIỀU KIỆN, KHÔNG VÀO THÂN NHÁNH.

    Bản đầu chỉ hỏi "có nhắc tới `res.chiPhi` không" — và đột biến tắt hẳn nhánh in tiền
    (`if (false)`) vẫn SỐNG SÓT, vì thân nhánh còn nguyên chữ ấy. Một khẳng định tìm đúng chữ ở
    nhầm chỗ thì nó canh một thứ không ai định canh.
  */
  assert.ok(than.includes("if (res.chiPhi) {"), "nhánh in tiền phải được canh bằng chính `res.chiPhi`");
  assert.ok(/tiền: \$\{gia\}/.test(than) || than.includes("`  tiền:"), "và phải thật sự in ra một dòng tiền");
}
