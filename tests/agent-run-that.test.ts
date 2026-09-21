import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiAgentExecutor } from "@/lib/agents/executor";
import type { AiProvider } from "@/lib/ai/provider";

/**
 * ═══════════ HAI LỖI CỦA LƯỢT CHẠY THẬT ĐẦU TIÊN (#14) ═══════════
 *
 * Chủ shop tạo `TECH-2` — việc THẬT đầu tiên của Phòng Tech AI. Lượt chạy làm xong việc, **bốn
 * cổng đều PASSED**, rồi hỏng ở hai chỗ mà không một bài kiểm nào trước đó chạm tới:
 *
 * ─── LỖI 1 · SỔ PRODUCTION GHI LƯỢT CHẠY VÀO SAI VIỆC ───
 *
 * CSDL tạm của máy CI RỖNG, nên bộ sinh mã cấp `TECH-1` cho việc vừa gieo. Mọi bước sau đọc mã
 * CỤC BỘ: nhánh thành `ai/documentation/TECH-1-…`, và cửa chép sổ ghi lượt chạy vào **TECH-1 trên
 * production** — một việc hoàn toàn khác (“Đánh giá tốc độ trang vận đơn”, R2).
 *
 * Không có gì đỏ lên. Đây đúng là loại sai mà AGENTS.md mục 34–35 gọi tên.
 *
 * ─── LỖI 2 · LÀM XONG NHƯNG BỊ TÍNH LÀ HỎNG ───
 *
 * Agent viết xong tài liệu, commit, bốn cổng xanh, rồi kết thúc lượt bằng một đoạn văn tóm tắt
 * thay vì gọi `finish`. Lượt chạy bị tính FAILED, và vì hỏng nên PR không được mở — công đã làm
 * xong nằm lại trên một nhánh không ai mở ra xem.
 */

const goc = path.resolve(__dirname, "..");

/* ═════════════ 1 · MÃ VIỆC PHẢI LÀ MÃ CỦA PRODUCTION ═════════════ */

export function testMaViecLaMaProduction() {
  const src = readFileSync(path.join(goc, "scripts/agent-fetch-task.ts"), "utf8");
  const than = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /*
    Mã in ra cho các bước sau PHẢI là mã production (`viec.code`), không phải mã do CSDL tạm sinh.
    Quét trên mã đã bỏ chú thích: một câu GIẢI THÍCH về `t.code` không phải là đang dùng `t.code`.
  */
  const dongTaskCode = than.split("\n").filter((d) => d.includes("TASK_CODE="));
  assert.ok(dongTaskCode.length > 0, "script phải in TASK_CODE cho các bước sau");
  for (const d of dongTaskCode) {
    assert.ok(
      d.includes("viec.code"),
      `TASK_CODE phải là mã production; thấy dòng dùng mã khác: ${d.trim()}`,
    );
  }

  /*
    Và CSDL tạm phải được đổi mã về đúng mã production — nếu không thì nhánh git, bản báo cáo phạm
    vi tệp và chữ của PR vẫn mang mã cục bộ, mỗi nơi nói một mã khác nhau.
  */
  /*
    ĐẾM, KHÔNG CHỈ TÌM THẤY MỘT CÁI.

    Script có HAI đường ra: gieo việc mới, và dùng lại việc đã có trong CSDL tạm. Bản đầu của bài
    kiểm này chỉ hỏi "có ít nhất một chỗ đổi mã không" — nên đột biến gỡ hẳn lệnh đổi mã ở đường
    GIEO MỚI vẫn sống sót, vì phép tìm vớ được lệnh ở đường kia. Cả hai đường đều phải đổi.
  */
  const soLanDoiMa = (than.match(/set\(\s*\{ code: viec\.code \}\s*\)/g) ?? []).length;
  assert.equal(soLanDoiMa, 2, `cả hai đường ra (gieo mới · dùng lại) đều phải đổi mã việc về mã production, đang thấy ${soLanDoiMa}`);

  /*
    KHÔNG nới `createTechTask` để nhận mã từ ngoài: đó là hàm dịch vụ của `/tech`, và mở nó ra để
    phục vụ một đường CI là đổi luật thật vì một nhu cầu giả.
  */
  const service = readFileSync(path.join(goc, "lib/tech/service.ts"), "utf8");
  const iTao = service.indexOf("export async function createTechTask");
  const khoi = service.slice(iTao, iTao + 2000);
  assert.ok(/const code = await nextCode\(/.test(khoi), "mã việc vẫn do `nextCode` quyết, không nhận từ đầu vào");
  assert.ok(!/input\.code/.test(khoi), "`createTechTask` KHÔNG được nhận mã từ nơi gọi");

  /*
    ───────── NỬA THỨ HAI: LƯỢT TỰ KIỂM KHÔNG THUỘC VIỆC NÀO ─────────

    Lượt tự kiểm không lấy việc từ production — nó tự tạo một việc R0 trong CSDL tạm, và trong một
    CSDL RỖNG việc ấy cũng mang mã `TECH-1`. Gửi mã đó đi thì cửa nhận tra thấy `TECH-1` CỦA
    PRODUCTION và gắn vào. Đo được: 4 lượt tự kiểm đang nằm dưới một việc chúng chưa từng chạm tới.

    Nên mã gửi đi phải là mã PRODUCTION do workflow truyền xuống, KHÔNG phải `task.code` của CSDL
    tạm — và rỗng thì không gắn vào đâu cả.
  */
  const rp = readFileSync(path.join(goc, "scripts/agent-run-report.ts"), "utf8");
  const rpThan = rp.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(/taskCode: maProduction/.test(rpThan), "mã gửi cho cửa nhận phải là mã production truyền xuống");
  assert.ok(!/taskCode: task\.code/.test(rpThan), "KHÔNG được gửi mã của CSDL tạm — hai không gian mã khác nhau");
  assert.ok(/maProduction \|\| undefined/.test(rpThan), "rỗng ⇒ không gắn vào việc nào, chứ không gắn bừa");

  const wf = readFileSync(path.join(goc, ".github/workflows/agent-run.yml"), "utf8");
  const wfThan = wf.split("\n").filter((d) => !d.trimStart().startsWith("#")).join("\n");
  assert.ok(/--prod-task "\$\{\{ steps\.setup\.outputs\.prod_task_code \}\}"/.test(wfThan), "workflow phải truyền mã production cho bước chép sổ");
  assert.ok(/prod_task_code=" >> "\$GITHUB_OUTPUT"/.test(wfThan), "lượt tự kiểm phải xuất mã production RỖNG");
}

/* ═════════════ 2 · NHẮC MỘT LẦN RỒI MỚI BỎ CUỘC ═════════════ */

/** Provider giả: trả về đúng chuỗi lượt đã dựng sẵn, và đếm xem nó được hỏi mấy lần. */
function providerGia(luot: { text?: string; finish?: string }[]) {
  let i = 0;
  const daNhan: string[] = [];
  const provider = {
    name: "gia",
    async complete(input: { messages: { role: string; content: { type: string; text?: string }[] }[] }) {
      // Ghi lại nội dung người dùng gửi ở lượt cuối — để kiểm câu nhắc thật sự tới tay model.
      const cuoi = input.messages[input.messages.length - 1];
      if (cuoi?.role === "user") daNhan.push(cuoi.content.map((c) => c.text ?? "").join(" "));
      const b = luot[Math.min(i, luot.length - 1)];
      i += 1;
      if (b.finish !== undefined) {
        return { content: [{ type: "tool_use" as const, id: `t${i}`, name: "finish", input: { summary: b.finish } }] };
      }
      return { content: [{ type: "text" as const, text: b.text ?? "" }] };
    },
  };
  return { provider: provider as unknown as AiProvider, daNhan, soLuot: () => i };
}

const JOB = {
  taskCode: "TECH-2",
  taskTitle: "Viết tài liệu",
  taskDescription: "",
  writeGlobs: ["docs/"] as const,
  baseCommit: "abc1234",
  branch: "ai/documentation/TECH-2-x",
  workspace: null as never,
};

export async function testNhacFinishDungMotLan() {
  /*
    ───────── KỊCH BẢN CỦA LƯỢT #14 ─────────

    Model nói một đoạn văn tóm tắt thay vì gọi `finish`. Trước bản vá: hỏng ngay. Sau bản vá: được
    nhắc ĐÚNG MỘT lần, và nếu nó gọi `finish` thì lượt chạy XONG — công đã làm không bị vứt đi.
  */
  const a = providerGia([{ text: "**Đã làm:** viết docs/X.md. Cả bốn cổng đều xanh." }, { finish: "Đã viết docs/X.md, bốn cổng PASSED." }]);
  const ra = await new AiAgentExecutor(a.provider, null).run(JOB);
  assert.equal(ra.finished, true, "được nhắc rồi gọi finish ⇒ lượt chạy XONG");
  assert.equal(ra.error, null);
  assert.ok(ra.summary.includes("docs/X.md"), "tóm tắt là lời của MODEL, không phải lời của câu nhắc");
  assert.equal(a.soLuot(), 2, "đúng hai lượt hỏi: lần đầu và lần sau khi nhắc");

  /*
    CÂU NHẮC PHẢI HẸP. Nếu nó mớm sẵn câu trả lời thì tóm tắt thu về là lời của câu nhắc, và cả sổ
    lượt chạy mất ý nghĩa.
  */
  const nhac = a.daNhan[a.daNhan.length - 1];
  assert.ok(nhac.includes("finish"), "câu nhắc phải nói ra giao thức");
  for (const cam of ["coi như", "đã xong rồi", "hãy nói là", "trả lời rằng"]) {
    assert.ok(!nhac.toLowerCase().includes(cam), `câu nhắc KHÔNG được mớm kết luận ("${cam}")`);
  }

  /*
    ───────── NHẮC ĐÚNG MỘT LẦN ─────────

    Nhắc lần thứ hai là bắt đầu dỗ model nói câu mình muốn nghe.
  */
  const b = providerGia([{ text: "vẫn chỉ nói chuyện" }]);
  const ra2 = await new AiAgentExecutor(b.provider, null).run(JOB);
  assert.equal(ra2.finished, false, "nhắc một lần mà vẫn không gọi finish ⇒ vẫn là CHƯA XONG");
  assert.ok((ra2.error ?? "").includes("đã nhắc một lần"), "và lý do phải nói rõ là đã nhắc rồi");
  assert.equal(b.soLuot(), 2, "KHÔNG nhắc lần thứ hai");

  /*
    ───────── GỌI FINISH NGAY THÌ KHÔNG NHẮC GÌ CẢ ─────────

    Đường bình thường không được đổi: một lượt chạy đúng giao thức vẫn chỉ tốn đúng một lượt hỏi.
  */
  const c = providerGia([{ finish: "xong" }]);
  const ra3 = await new AiAgentExecutor(c.provider, null).run(JOB);
  assert.equal(ra3.finished, true);
  assert.equal(c.soLuot(), 1, "gọi finish ngay ⇒ không có lượt hỏi thừa nào");
  assert.equal(c.daNhan.length, 1, "và không câu nhắc nào được gửi");
}
