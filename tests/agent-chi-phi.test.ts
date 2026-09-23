import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiAgentExecutor } from "@/lib/agents/executor";
import { AGENT_LOOP_TIMEOUT_MS, TIER_MAC_DINH, tierForRole } from "@/lib/constants/agent-model";
import { thoiGianThucThi, trungVi } from "@/lib/constants/perf-explain";
import { chuoiSach, danhDauLuotSua, NGUONG_MO_QA, type LuotChoChuoi } from "@/lib/constants/agent-clean-streak";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { TIMEOUT_BY_TIER, estimateCostUsd, giaCuaModel, khoaGiaKhop } from "@/lib/ai/provider";
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
  role: "DOCUMENTATION",
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

  /*
    `bac` PHẢI LÀ THAM SỐ ĐẦU — và từ 23/09/2026 lời gọi còn mang tham số thứ hai (trần chờ), nên
    chốt cũ ghim đúng `getAiProvider(bac)` không còn khớp. Nới đúng một dấu phẩy, và siết lại vế
    thật sự cần canh: KHÔNG bậc nào được gõ cứng, kể cả bậc rẻ — gõ cứng `"routine"` ở đây làm sổ
    `TIER_BY_ROLE` thành trang trí, và ngày một vai cần model mạnh hơn thì không ai thấy vì sao nó
    vẫn chạy bằng model yếu.
  */
  assert.ok(/getAiProvider\(bac[,)]/.test(than), "runner phải lấy bậc từ VAI, không gõ cứng");
  assert.ok(!/getAiProvider\("[a-z]+"/.test(than), "KHÔNG được gõ cứng BẤT KỲ bậc nào trong đường chạy agent — kể cả bậc rẻ");
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

/* ═════════════ TRẦN CHỜ KHÔNG ĐI THEO BẬC MODEL ═════════════ */

export function testTranChoTachKhoiBac() {
  const goc = path.resolve(__dirname, "..");

  /*
    HAI CÂU HỎI, HAI HẰNG SỐ.

    Bậc trả lời "việc này đáng dùng model nào" — quyết định về TIỀN. Trần chờ trả lời "chờ MỘT
    lượt gọi bao lâu thì bỏ". Trước 23/09/2026 chúng đi chung một núm, và cái giá đo được ở việc
    TECH-6 (lượt chạy #41): vòng 1–3 xong, vòng 4 mang 98.734 token đệm đọc vượt trần 60 giây và
    chết bằng `Request timed out` — $0,0891 đã tiêu, 0 tệp giao về.
  */
  assert.ok(
    AGENT_LOOP_TIMEOUT_MS > TIMEOUT_BY_TIER.routine,
    "vòng lặp agent phải có trần chờ RỘNG HƠN bậc routine — ngữ cảnh của nó phình theo số tệp đã đọc, nên lượt gọi cuối luôn nặng nhất",
  );

  /*
    VÀ BẬC `routine` KHÔNG ĐƯỢC BỊ NỚI THEO. Nó còn phục vụ phân loại / tóm tắt trong ERP, nơi
    chờ 5 phút cho một câu trả lời hai chữ là một màn hình treo trước mắt người dùng. Cách sửa dễ
    nhất mà SAI là nâng `TIMEOUT_BY_TIER.routine` — khẳng định này khoá chiều ấy lại.
  */
  assert.ok(TIMEOUT_BY_TIER.routine <= 60_000, "không được nới trần chờ của bậc routine để chữa cho vòng lặp agent — đó là hai việc khác nhau");

  /*
    ĐƯỜNG NỐI PHẢI CÒN. Hằng số đúng mà nơi gọi không truyền nó thì bản vá nằm nguyên trong mã và
    mất sạch tác dụng — đúng lớp lỗi đã bắt được ở ĐB19 lượt trước ("hàm đúng, đường nối đứt").
  */
  const runner = readFileSync(path.join(goc, "scripts/agent-run.ts"), "utf8");
  assert.ok(runner.includes("hanChoMs: AGENT_LOOP_TIMEOUT_MS"), "runner phải truyền trần chờ của vòng lặp agent NGAY trong lời gọi getAiProvider");

  /*
    TRẦN CHỜ NẰM TRONG KHOÁ NHỚ.

    Thiếu vế này thì lượt gọi nào tới TRƯỚC quyết định trần chờ cho mọi lượt sau trong cùng tiến
    trình: một lượt `routine` của ERP chạy trước là agent nhận lại đúng provider 60 giây, và bản
    vá im lặng mất tác dụng ở đúng những lần khó tìm nhất.
  */
  const prov = readFileSync(path.join(goc, "lib/ai/provider.ts"), "utf8");
  const than = prov.slice(prov.indexOf("export function getAiProvider"));
  assert.ok(!than.includes("cached.get(tier)"), "khoá nhớ KHÔNG được chỉ là bậc — trần chờ phải nằm trong khoá");
  const iHanCho = than.indexOf("hanCho");
  const iTra = than.indexOf("cached.get(");
  assert.ok(iHanCho > 0 && iTra > 0 && iHanCho < iTra, "trần chờ phải được tính TRƯỚC khi tra bộ nhớ, nếu không nó không vào được khoá");

  console.log(`✓ Trần chờ vòng lặp agent ${AGENT_LOOP_TIMEOUT_MS / 1000}s tách khỏi bậc routine ${TIMEOUT_BY_TIER.routine / 1000}s · runner truyền thật · trần chờ nằm trong khoá nhớ`);
}

/* ═════════════ PHÉP ĐO JIT BẬT / JIT TẮT — HAI PHÉP TÍNH PHẢI ĐÚNG TRƯỚC KHI CHẠY TRÊN PRODUCTION ═════════════ */

export function testPhepDoJit() {
  /*
    `scripts/perf-probe.ts` chỉ chạy được trên Postgres thật có JIT — PGlite không có JIT, máy
    này không có Postgres. Không tách hai phép tính này ra thì lần chạy đầu trên production là lần
    kiểm đầu tiên, và một trung vị sai đi thẳng vào tệp chứng từ `docs/perf/`.
  */
  assert.equal(trungVi([]), null, "không lượt nào ⇒ CHƯA ĐO ĐƯỢC, không phải 0");
  assert.equal(trungVi([7]), 7);
  assert.equal(trungVi([9, 1, 5]), 5, "lẻ ⇒ phần tử giữa SAU KHI SẮP");
  /*
    CHẴN ⇒ trung bình hai phần tử giữa. Lấy `xs[n/2]` là lấy phần tử lệch về phía LỚN — với bốn
    lượt [1, 2, 8, 9] nó ra 8 thay vì 5, gần gấp đôi.
  */
  assert.equal(trungVi([9, 1, 8, 2]), 5, "chẵn ⇒ trung bình HAI phần tử giữa, không phải phần tử lệch về phía lớn");
  const goc = [3, 1, 2];
  trungVi(goc);
  assert.deepEqual(goc, [3, 1, 2], "không được sắp lại mảng GỐC của người gọi");

  assert.equal(thoiGianThucThi(["Planning Time: 15.085 ms", "Execution Time: 8051.037 ms"]), 8051.037);
  assert.equal(thoiGianThucThi(["    Execution Time: 26 ms"]), 26, "số nguyên, có thụt đầu dòng — vẫn đọc được");
  assert.equal(thoiGianThucThi(["Seq Scan on orders", "Planning Time: 1 ms"]), null, "thiếu dòng Execution Time ⇒ null, KHÔNG phải 0 (mục 42)");
  assert.equal(thoiGianThucThi([]), null);
  /* Planning Time đứng TRƯỚC không được đọc nhầm thành thời gian thực thi. */
  assert.equal(thoiGianThucThi(["Planning Time: 999 ms", "Execution Time: 12.5 ms"]), 12.5, "không được đọc nhầm Planning Time");

  /*
    VÀ SCRIPT PHẢI ĐO CẢ HAI ĐIỀU KIỆN, XEN KẼ, VỚI ĐÚNG CÂU `chayKhongJit` PHÁT RA.

    Đo một phía thì không trả lời được "JIT góp bao nhiêu" — đúng câu tệp chứng từ đang ghi
    CHƯA ĐO ĐƯỢC. Và câu tắt JIT phải là ĐÚNG câu của `chayKhongJit`, nếu không phép đo lại đo
    một điều kiện thứ ba không ai dùng.
  */
  const goc2 = path.resolve(__dirname, "..");
  const probe = readFileSync(path.join(goc2, "scripts/perf-probe.ts"), "utf8");
  const dbIndex = readFileSync(path.join(goc2, "db/index.ts"), "utf8");
  assert.ok(dbIndex.includes('"set local jit = off"'), "chayKhongJit phải còn phát đúng câu này — nếu đổi, phép đo phải đổi theo");
  assert.ok(probe.includes('await c.query("set local jit = off")'), "probe phải tắt JIT bằng ĐÚNG câu chayKhongJit phát ra");
  assert.ok(probe.includes("chayMotLuot(cauLenh, false)") && probe.includes("chayMotLuot(cauLenh, true)"), "probe phải đo CẢ HAI điều kiện");
  const iBat = probe.indexOf("chayMotLuot(cauLenh, false)");
  const iTat = probe.indexOf("chayMotLuot(cauLenh, true)");
  const iVong = probe.lastIndexOf("for (let k = 0; k < LUOT; k += 1)", iBat);
  assert.ok(iVong > 0 && iVong < iBat && iBat < iTat, "hai điều kiện phải chạy XEN KẼ trong CÙNG một vòng — chạy hết một bên rồi mới sang bên kia thì độ trôi của tải dồn lên một phía");
  assert.ok(probe.includes('c.query("rollback")'), "mỗi lượt phải rollback để `set local` không rò sang lượt sau");

  console.log("✓ Phép đo JIT bật / JIT tắt: trung vị đúng cả chẵn lẫn lẻ, không sắp mảng gốc · thiếu thời gian ⇒ null, không 0 · probe đo CẢ HAI điều kiện XEN KẼ, bằng đúng câu chayKhongJit phát ra, mỗi lượt rollback");
}

/* ═════════════ CHUỖI LƯỢT CHẠY SẠCH — MỖI LUẬT ĐẾM LÀ MỘT QUYẾT ĐỊNH ═════════════ */

export function testChuoiSach() {
  /* Mốc dựng TƯƠNG ĐỐI, không ghim ngày tuyệt đối (AGENTS.md mục 50). */
  const goc = Date.now();
  let n = 0;
  const luot = (status: string, reviewVerdict: LuotChoChuoi["reviewVerdict"], phutTruoc: number, taskId = `t${++n}`, branch = `ai/x/${n}`): LuotChoChuoi => ({
    id: `r${n}-${phutTruoc}`,
    taskId,
    branch,
    status,
    startedAt: new Date(goc - phutTruoc * 60_000),
    reviewVerdict,
  });

  assert.deepEqual(chuoiSach([]), { chuoi: 0, choReview: 0, dungVi: "HET_LICH_SU", datNguong: false }, "không lịch sử ⇒ 0, và nói rõ là hết lịch sử");

  const namSach = [1, 2, 3, 4, 5].map((i) => luot("SUCCEEDED", "SACH", i * 10));
  assert.equal(chuoiSach(namSach).chuoi, NGUONG_MO_QA);
  assert.equal(chuoiSach(namSach).datNguong, true, "đủ ngưỡng thì phải nói là đủ — từ CÙNG một hằng số màn hình đọc");

  /*
    CHƯA REVIEW KHÔNG PHẢI SẠCH, CŨNG KHÔNG PHẢI 0.
    Lượt mới nhất chưa ai đọc: đếm RIÊNG, chuỗi tính từ dưới nó. In chuỗi thành 0 chỉ vì lượt mới
    nhất chưa review là biến CHƯA BIẾT thành một con số (mục 42).
  */
  const choDauHang = chuoiSach([luot("SUCCEEDED", null, 1), luot("SUCCEEDED", "SACH", 10), luot("SUCCEEDED", "SACH", 20)]);
  assert.equal(choDauHang.choReview, 1, "lượt mới nhất chưa review ⇒ đếm vào 'chờ review'");
  assert.equal(choDauHang.chuoi, 2, "và chuỗi vẫn tính từ các lượt ĐÃ review bên dưới");

  /* Nhưng một lượt chưa review ở GIỮA thì cắt: không ai chứng minh được đoạn liên tiếp ấy. */
  const lungChung = chuoiSach([luot("SUCCEEDED", "SACH", 1), luot("SUCCEEDED", null, 10), luot("SUCCEEDED", "SACH", 20)]);
  assert.equal(lungChung.chuoi, 1);
  assert.equal(lungChung.dungVi, "CHUA_REVIEW_O_GIUA");

  const coLoi = chuoiSach([luot("SUCCEEDED", "SACH", 1), luot("SUCCEEDED", "CO_LOI", 10), luot("SUCCEEDED", "SACH", 20)]);
  assert.equal(coLoi.chuoi, 1);
  assert.equal(coLoi.dungVi, "CO_LOI", "một lượt có lỗi cắt chuỗi");

  const hong = chuoiSach([luot("SUCCEEDED", "SACH", 1), luot("FAILED", null, 10), luot("SUCCEEDED", "SACH", 20)]);
  assert.equal(hong.chuoi, 1);
  assert.equal(hong.dungVi, "HONG", "một lượt hỏng cắt chuỗi");

  /*
    KHÔNG PHẠT LỐI RA TRUNG THỰC. BLOCKED = agent khai không làm được (`khong_lam_duoc`). Nếu nó
    cắt chuỗi thì hệ thống thưởng cho việc CỐ làm thay vì nói thật — đúng điều lượt chạy TECH-5 #39
    đã làm khi bịa số. CANCELLED là bị cắt từ bên ngoài; RUNNING chưa xong.
  */
  const boQua = chuoiSach([
    luot("SUCCEEDED", "SACH", 1),
    luot("BLOCKED", null, 5),
    luot("CANCELLED", null, 7),
    luot("RUNNING", null, 8),
    luot("SUCCEEDED", "SACH", 10),
  ]);
  assert.equal(boQua.chuoi, 2, "BLOCKED / CANCELLED / RUNNING không cộng, cũng KHÔNG cắt chuỗi");

  /*
    LƯỢT SỬA KHÔNG TÍNH. Cùng việc, cùng nhánh, đã có lượt trước ⇒ đó là làm theo chỉ dẫn review,
    không phải giao được việc sạch. Tính nó thì một việc có lỗi, sửa ba lần, ra ba lượt "sạch".
  */
  const dau = luot("SUCCEEDED", "CO_LOI", 30, "viec-A", "ai/x/A");
  const sua1 = luot("SUCCEEDED", "SACH", 20, "viec-A", "ai/x/A");
  const sua2 = luot("SUCCEEDED", "SACH", 10, "viec-A", "ai/x/A");
  const thoiPhong = chuoiSach([sua2, sua1, dau]);
  assert.equal(thoiPhong.chuoi, 0, "hai lượt sửa 'sạch' KHÔNG được thổi chuỗi lên từ một việc có lỗi");
  assert.equal(thoiPhong.dungVi, "CO_LOI", "chuỗi dừng ở chính lượt đầu có lỗi");

  /* Lượt sửa suy theo MỐC THỜI GIAN, không theo thứ tự mảng. */
  const sua = danhDauLuotSua([sua2, dau, sua1]);
  assert.ok(!sua.has(dau.id), "lượt SỚM NHẤT trên nhánh là lượt đầu, dù đứng giữa mảng");
  assert.ok(sua.has(sua1.id) && sua.has(sua2.id));
  /* Thiếu căn cứ thì không kết luận: nhánh hay việc rỗng KHÔNG bị coi là lượt sửa. */
  const khongNhanh = [luot("SUCCEEDED", "SACH", 2, "viec-B", ""), luot("SUCCEEDED", "SACH", 1, "viec-B", "")];
  assert.equal(danhDauLuotSua(khongNhanh).size, 0, "nhánh rỗng ⇒ không đủ căn cứ để gọi là lượt sửa");

  console.log(`✓ Chuỗi lượt chạy sạch: ngưỡng ${NGUONG_MO_QA} từ một hằng số · chưa review đếm riêng, không in thành 0 · chưa review ở giữa cắt chuỗi · có lỗi / hỏng cắt · BLOCKED/CANCELLED không phạt · lượt sửa không thổi phồng được chuỗi · lượt sửa suy theo mốc thời gian`);
}

