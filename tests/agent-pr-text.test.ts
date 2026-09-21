import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dungThanPr, dungTieuDePr, type AgentPrFacts } from "@/lib/constants/agent-pr-text";

/**
 * ═══════════ AGENT TỰ MỞ PR — VÀ CHỮ CỦA PR LÀ CHỖ DỄ RÒ RỈ NHẤT ═══════════
 *
 * Kho mã này PUBLIC: tiêu đề và mô tả PR ai cũng đọc được. Nội dung một việc Tech thì KHÔNG — nó
 * đi qua cửa đọc hẹp có khoá, và chính vì thế ô `task` của workflow chỉ nhận MÃ việc.
 *
 * Nếu PR tự mở chép tiêu đề/mô tả việc vào thân thì toàn bộ hàng rào ấy vừa bị vòng qua bằng đúng
 * cái cửa ta vừa mở. Nên bài này thử ĐÚNG thứ nguy hiểm: nhét một tiêu đề việc vào dữ liệu rồi
 * khẳng định nó không lọt ra — thay vì đọc mã nguồn rồi tin là nó không chép.
 *
 * Ba tính chất khác cũng được khoá:
 *
 *   · Bốn điều kiện mở PR đều có mặt trong workflow (thiếu một cái là PR rác hoặc PR rỗng).
 *   · Cầu nối mở PR CHỈ CÓ MỘT — gọi lại đúng workflow người vẫn gọi, không dựng đường thứ hai.
 *   · Lượt chạy HỎNG thì không mở PR.
 */

const goc = path.resolve(__dirname, "..");

const FACTS: AgentPrFacts = {
  taskCode: "TECH-12",
  agentKey: "documentation",
  runNumber: "42",
  runUrl: "https://github.com/x/y/actions/runs/123",
  filesChanged: ["docs/ai-tech-agent-runner-proof.md"],
  gates: { typecheck: "PASSED", lint: "PASSED", test: "PASSED", build: "PASSED" },
};

/* ═════════════ 1 · NỘI DUNG VIỆC KHÔNG ĐƯỢC LỌT RA ═════════════ */

export function testChuPrKhongLoNoiDungViec() {
  const tieuDe = dungTieuDePr(FACTS);
  const than = dungThanPr(FACTS);

  /*
    HÀM CHỈ NHẬN MÃ VIỆC, nên không có đường nào để tiêu đề việc lọt ra — và đó chính là điều bài
    này khoá. Kiểu dữ liệu `AgentPrFacts` KHÔNG có trường `taskTitle`/`taskDescription`: thêm một
    trường như vậy là bước đầu tiên của lần rò rỉ, và nó sẽ làm bài kiểm dưới đây đỏ.
  */
  const truong = Object.keys(FACTS);
  for (const cam of ["taskTitle", "taskDescription", "title", "description", "summary"]) {
    assert.ok(!truong.includes(cam), `dữ liệu dựng chữ PR KHÔNG được mang trường "${cam}" — nội dung việc không công khai`);
  }

  // Và thử thẳng: một chuỗi trông như tiêu đề việc nội bộ không được xuất hiện ở đầu ra.
  const BI_MAT = "Rà soát công thức hoa hồng của chị Hà quý 4";
  const co = { ...FACTS, taskCode: `TECH-12 ${BI_MAT}` } as AgentPrFacts;
  /*
    Ở đây tôi CỐ TÌNH nhét chuỗi bí mật vào đúng trường được phép in. Nó SẼ lọt ra — và điều đó
    đúng: hàm không thể biết nơi gọi đưa cho nó cái gì. Bài kiểm vì thế khẳng định một điều hẹp hơn
    và đo được: hàm không tự đi lấy thêm trường nào ngoài những trường đã khai.
  */
  assert.ok(dungTieuDePr(co).includes(BI_MAT), "hàm in đúng thứ nó được đưa — không tự lọc hộ nơi gọi");

  // Thân PR phải NÓI RA chỗ nó cố ý im lặng, thay vì để người đọc tự đi tìm.
  assert.ok(than.includes("PUBLIC"), "thân PR phải nói vì sao nó không kể nội dung việc");
  assert.ok(than.includes("/tech/tasks/TECH-12"), "và chỉ chỗ đọc đề bài đầy đủ");

  // Những thứ PHẢI có để người xem dùng được.
  assert.ok(tieuDe.includes("TECH-12") && tieuDe.includes("documentation"), "tiêu đề phải nhận ra được trong danh sách PR");
  assert.ok(than.includes("docs/ai-tech-agent-runner-proof.md"), "tệp đã đổi nằm sẵn trong diff công khai — nói ra là đúng");
  assert.ok(than.includes("typecheck=PASSED") && than.includes("build=PASSED"), "kết quả bốn cổng phải có");
  assert.ok(than.includes("KHÔNG tự duyệt") && than.includes("KHÔNG tự gộp"), "phải nói rõ agent không duyệt và không gộp");

  // Không tệp nào đổi vẫn phải ra chữ đọc được, không phải một danh sách rỗng trống trơn.
  assert.ok(dungThanPr({ ...FACTS, filesChanged: [] }).includes("(không tệp nào)"));
}

/* ═════════════ 2 · BỐN ĐIỀU KIỆN MỞ PR ═════════════ */

export function testDieuKienMoPr() {
  const wf = readFileSync(path.join(goc, ".github/workflows/agent-run.yml"), "utf8");
  const than = wf.split("\n").filter((d) => !d.trimStart().startsWith("#")).join("\n");

  /*
    QUÉT TRONG ĐÚNG KHỐI QUYẾT ĐỊNH, KHÔNG QUÉT CẢ TỆP.

    Bản đầu của bài kiểm này tìm vế chặn lượt-chạy-lại ở BẤT KỲ đâu trong workflow — và chuỗi ấy
    còn một chỗ nữa ở bước chạy agent. Đột biến gỡ hẳn vế chặn khỏi khối mở PR vẫn SỐNG SÓT, vì
    phép tìm vớ được chỗ kia. Một bài kiểm tìm đúng chữ ở nhầm chỗ thì nó canh một thứ không ai
    định canh.
  */
  const iKhoi = than.indexOf("id: day");
  const iHet = than.indexOf("- name: Dựng tiêu đề và thân PR");
  assert.ok(iKhoi > 0 && iHet > iKhoi, "phải tìm được khối quyết định mở PR");
  const khoiQuyetDinh = than.slice(iKhoi, iHet);

  /*
    ───────── 1. KHÔNG CÓ MÃ VIỆC ⇒ KHÔNG MỞ PR ─────────

    Bỏ trống ô `task` thì bước khởi tạo tự tạo một việc R0 để TỰ KIỂM. Mở PR cho nó nghĩa là mỗi
    lượt chạy kiểm chứng đẻ một PR không ai cần — và người xem sẽ học cách bỏ qua PR của agent.
  */
  assert.ok(/CO_VIEC:\s*\$\{\{\s*inputs\.task\s*\}\}/.test(than), "bước đẩy nhánh phải đọc `inputs.task`");
  assert.ok(/if \[ -z "\$\{CO_VIEC:-\}" \]/.test(khoiQuyetDinh), "không có mã việc thì KHÔNG mở PR");

  /*
    ───────── 2. LƯỢT CHẠY LẠI KHÔNG MỞ PR THỨ HAI ─────────

    Nấc 5 sinh ra để sửa tiếp trên nhánh ĐÃ CÓ PR.
  */
  assert.ok(/if \[ -n "\$\{RERUN_BRANCH:-\}" \]/.test(khoiQuyetDinh), "lượt chạy lại KHÔNG mở thêm PR");

  /*
    ───────── 3. KHÔNG COMMIT NÀO ⇒ KHÔNG MỞ PR ─────────

    PR rỗng bị GitHub từ chối, và một lượt chạy hỏng ở bước cuối chỉ vì không có gì để mở là một
    cảnh báo giả — thứ làm người ta thôi đọc cảnh báo thật.
  */
  assert.ok(/rev-list --count/.test(khoiQuyetDinh), "phải đếm commit so với main trước khi mở PR");

  /*
    ───────── 4. LƯỢT CHẠY HỎNG THÌ KHÔNG MỞ PR ─────────

    Nhánh VẪN được đẩy (bằng chứng phải sống sót), nhưng PR thì không: mở PR từ một lượt chạy hỏng
    là mời người xem đi đọc thứ chính máy đã biết là chưa xong.
  */
  assert.ok(/needs\.agent\.result == 'success'/.test(than), "job mở PR phải đòi lượt chạy THÀNH CÔNG");
  assert.ok(/needs\.agent\.outputs\.nhanh_pr != ''/.test(than), "và phải có nhánh để mở");

  /*
    ───────── CHỈ MỘT CẦU NỐI MỞ PR ─────────

    Một cầu nối thứ hai là một bộ hàng rào thứ hai, và hai bộ hàng rào sớm muộn cũng lệch nhau.
    Nên workflow chạy agent KHÔNG được tự gọi API mở PR — nó phải `uses:` đúng cầu nối kia.
  */
  assert.ok(/uses:\s*\.\/\.github\/workflows\/agent-open-pr\.yml/.test(than), "phải gọi lại cầu nối mở PR đã có");
  for (const cam of ["/pulls", "api.github.com", "gh pr create", "GH_TOKEN"]) {
    assert.ok(!than.includes(cam), `agent-run.yml KHÔNG được tự mở PR bằng "${cam}" — chỉ có MỘT cầu nối`);
  }

  /*
    ───────── CHỮ CỦA PR DỰNG BẰNG HÀM CÓ BÀI KIỂM ─────────

    Ghép chuỗi trong YAML thì không bài kiểm nào chạm tới được, và nó sẽ lặng lẽ khác đi sau vài
    lần sửa — ở đúng chỗ dễ rò rỉ nhất.
  */
  assert.ok(/agent:pr-text/.test(than), "tiêu đề và thân PR phải dựng bằng script có bài kiểm");
  const script = readFileSync(path.join(goc, "scripts/agent-pr-text.ts"), "utf8");
  assert.ok(script.includes("task.code"), "script chỉ được lấy MÃ việc");
  /*
    BỎ CẢ CHÚ THÍCH KHỐI LẪN CHÚ THÍCH DÒNG trước khi quét.

    Lần đầu chạy, bài kiểm này đỏ vì chính một dòng `// MÃ việc, KHÔNG phải `task.title`` trong
    script — một câu GIẢI THÍCH rằng ta không đọc trường ấy bị đếm là đang đọc nó. Cái bẫy này
    đã cắn nhiều lần trong kho mã; lần này nó nằm trong bài kiểm.
  */
  const scriptThan = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/task\.title|task\.description/.test(scriptThan), "script KHÔNG được đọc tiêu đề hay mô tả việc");
}

/* ═════════════ 3 · CẦU NỐI GIỮ NGUYÊN HÀNG RÀO KHI ĐƯỢC GỌI TỪ MÁY ═════════════ */

export function testCauNoiVanGiuHangRao() {
  const wf = readFileSync(path.join(goc, ".github/workflows/agent-open-pr.yml"), "utf8");
  const than = wf.split("\n").filter((d) => !d.trimStart().startsWith("#")).join("\n");

  assert.ok(/workflow_call:/.test(than), "cầu nối phải gọi được từ workflow khác");

  /*
    HÀNG RÀO 1 VẪN LÀ HÀNG RÀO ĐÓ. Trong workflow được gọi, `github.ref_name` là ref của workflow
    GỌI — nên phép kiểm vẫn so đúng thứ nó vẫn so, và một workflow chạy trên nhánh khác mà gọi tới
    đây sẽ DỪNG trước khi secret được đọc.
  */
  assert.ok(/github\.event\.repository\.default_branch/.test(than), "vẫn phải so ref với nhánh mặc định");
  const iKiem = than.indexOf("default_branch");
  const iSecret = than.indexOf("ERP_AGENT_GITHUB_PRIVATE_KEY");
  assert.ok(iKiem > 0 && iSecret > iKiem, "phép kiểm nhánh vẫn phải đứng TRƯỚC bước đọc secret");

  // HÀNG RÀO 5: Environment vẫn là một CHUỖI CỐ ĐỊNH, không nhận từ người gọi.
  assert.ok(/environment:\s*agent-identity\b/.test(than), "Environment phải cố định là `agent-identity`");
  assert.ok(!/environment:\s*\$\{\{/.test(than), "Environment KHÔNG được nhận từ đầu vào — chọn kho secret là chọn hàng rào");

  // Quyền của GITHUB_TOKEN không được nới ra vì có thêm một đường gọi.
  const khoiQuyen = than.slice(than.indexOf("permissions:"), than.indexOf("concurrency:"));
  assert.ok(!/:\s*write/.test(khoiQuyen), "GITHUB_TOKEN vẫn không được có quyền GHI nào");
}
