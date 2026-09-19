import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertAgentBranch } from "@/lib/integrations/github/agent-identity";

/**
 * ═══════════ CẦU NỐI MỞ PR: BỐN HÀNG RÀO PHẢI CÒN NGUYÊN ═══════════
 *
 * Cầu nối này cầm credential của GitHub App. Thứ nguy hiểm không phải việc nó mở PR — mà là bốn
 * điều nó KHÔNG được làm. Cả bốn đều được khoá bằng SỰ VẮNG MẶT của đường đi, và sự vắng mặt thì
 * `tsc` và `eslint` không nhìn thấy: thêm một dòng `fetch` vào script là đủ để mở một đường mới
 * mà mọi cổng khác vẫn xanh.
 *
 * Nên bài này quét MÃ NGUỒN. Nó là loại kiểm thử duy nhất bắt được một quyền bị nới ra.
 */

const GOC = path.resolve(__dirname, "..");
const SCRIPT = "scripts/agent-open-pr.ts";
const WORKFLOW = ".github/workflows/agent-open-pr.yml";

/** Bỏ chú thích trước khi quét: chính đoạn giải thích luật lại chứa đúng chữ đang bị cấm. */
function khongChuThich(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

export function testAgentPrBridge() {
  const script = readFileSync(path.join(GOC, SCRIPT), "utf8");
  const than = khongChuThich(script);
  const wf = readFileSync(path.join(GOC, WORKFLOW), "utf8");
  const wfThan = wf.replace(/^\s*#[^\n]*$/gm, "");

  /* ═══ 1 · KHÔNG GỘP, KHÔNG DUYỆT ═══

     Hai việc này là lý do cả bộ governance tồn tại. Một agent gộp được PR của chính nó thì cổng
     duyệt chỉ còn là trang trí; một agent duyệt được thì còn tệ hơn — nó tạo ra một chữ ký người
     mà không có người nào. */

  for (const cam of ["/merge", "/reviews", "/requested_reviewers"]) {
    assert.ok(!than.includes(cam), `${SCRIPT} không được có đường "${cam}" — agent KHÔNG gộp và KHÔNG duyệt PR`);
  }
  assert.ok(!/\bPUT\b/.test(than), `${SCRIPT} không được dùng PUT — đó là động từ của lệnh gộp`);

  /* ═══ 2 · KHÔNG CHẠM CẤU HÌNH KHO ═══ */

  for (const cam of ["rulesets", "/actions/secrets", "/actions/variables", "/environments", "/hooks", "/dispatches", "branch_protection"]) {
    assert.ok(!than.includes(cam), `${SCRIPT} không được chạm "${cam}" — cầu nối chỉ mở PR`);
  }

  /* ═══ 3 · KHÔNG CHẠY MÃ CỦA NHÁNH NGUỒN ═══

     TRUNG TÂM CỦA CẢ THIẾT KẾ. Nhánh nguồn là mã CHƯA AI REVIEW. Nếu workflow checkout nó rồi
     chạy bất cứ thứ gì trong đó, thì secret của App vừa gặp mã chưa review — và cầu nối trở
     thành đúng cái lỗ mà nó được viết ra để tránh. `head` chỉ được là một CHUỖI. */

  assert.ok(!/ref:\s*\$\{\{\s*inputs\.head/.test(wf), `${WORKFLOW}: KHÔNG được checkout nhánh nguồn`);

  /*
    Nội suy `${{ inputs.* }}` THẲNG vào thân `run:` là đường tiêm lệnh: tên nhánh do người gọi đặt,
    và `$(...)` trong đó sẽ được shell chạy. Truyền qua `env:` thì không — biến môi trường là dữ
    liệu, không phải mã. Nên luật là: mọi lần `inputs.` xuất hiện phải nằm ở một dòng gán `env:`.
  */
  const dongInput = wfThan.split("\n").filter((d) => d.includes("inputs."));
  assert.ok(dongInput.length > 0, `${WORKFLOW}: phải có dòng nhận input`);
  for (const d of dongInput) {
    assert.match(d.trim(), /^AGENT_PR_[A-Z]+:\s*\$\{\{\s*inputs\.\w+\s*\}\}$/, `${WORKFLOW}: input chỉ được đi qua env, không nội suy vào thân run: — thấy "${d.trim()}"`);
  }
  const soCheckout = (wfThan.match(/actions\/checkout/g) ?? []).length;
  assert.equal(soCheckout, 1, `${WORKFLOW}: đúng MỘT lượt checkout (nhánh mặc định), không hơn`);
  assert.ok(/persist-credentials:\s*false/.test(wfThan), `${WORKFLOW}: không giữ credential của Actions trong .git/config`);

  /* ═══ 4 · CHỈ CHẠY TỪ NHÁNH MẶC ĐỊNH ═══

     Chặn lối tắt dễ nghĩ ra nhất: sửa workflow trên một nhánh rồi dispatch nhánh đó, để mã chưa
     review chạy với secret. Hàng rào này nằm trong chính tệp nên nó chặn nhầm lẫn chứ không chặn
     cố ý — hàng rào cứng là Environment, ghi trong tài liệu. Vẫn phải có: bỏ nó đi là bỏ luôn
     lời cảnh báo. */

  assert.ok(/github\.event\.repository\.default_branch/.test(wf), `${WORKFLOW}: phải so ref với nhánh mặc định`);
  assert.ok(/exit 1/.test(wfThan), `${WORKFLOW}: sai nhánh thì phải DỪNG, không phải cảnh báo rồi chạy tiếp`);
  const viTriKiem = wfThan.indexOf("default_branch");
  const viTriSecret = wfThan.indexOf("ERP_AGENT_GITHUB_PRIVATE_KEY");
  assert.ok(viTriKiem > 0 && viTriSecret > viTriKiem, `${WORKFLOW}: phép kiểm nhánh phải đứng TRƯỚC bước đọc secret — kiểm sau khi đã đọc là không kiểm gì`);

  /* ═══ 5 · QUYỀN CỦA `GITHUB_TOKEN`: KHÔNG MỘT QUYỀN GHI NÀO ═══ */

  const khoiQuyen = /permissions:\s*\n((?:\s+\S+:\s*\S+\n)+)/.exec(wfThan)?.[1] ?? "";
  assert.ok(khoiQuyen.length > 0, `${WORKFLOW}: phải khai permissions tường minh`);
  assert.ok(!/:\s*write/.test(khoiQuyen), `${WORKFLOW}: GITHUB_TOKEN không được có quyền GHI nào — nó chỉ để đọc lại PR làm đối chứng`);
  assert.ok(/contents:\s*read/.test(khoiQuyen) && /pull-requests:\s*read/.test(khoiQuyen), `${WORKFLOW}: cần đúng contents:read + pull-requests:read`);

  /* ═══ 6 · ĐỐI CHỨNG BẰNG CREDENTIAL KHÁC, VÀ SAI THÌ ĐỎ ═══

     Hỏi lại chính cái token vừa ghi thì "đã mở bằng bot" và "trông như đã mở bằng bot" nhìn giống
     hệt nhau. Script phải đọc lại bằng GITHUB_TOKEN và THOÁT KHÁC 0 nếu tác giả không phải bot. */

  assert.ok(/GITHUB_TOKEN/.test(than), `${SCRIPT}: phải đọc lại bằng GITHUB_TOKEN, không phải token App`);
  assert.ok(/botLogin/.test(than) && /throw new Error\(`TÁC GIẢ SAI/.test(script), `${SCRIPT}: tác giả khác bot phải là LỖI, không phải một dòng cảnh báo`);
  assert.ok(/type.*!==.*"Bot"|kieu !== "Bot"/.test(than), `${SCRIPT}: phải kiểm cả user.type === "Bot"`);

  /* ═══ 7 · LUẬT NHÁNH CŨ VẪN ÁP, CẦU NỐI KHÔNG NỚI RA ═══

     Dùng lại `assertAgentBranch` của adapter thay vì tự kiểm — một luật, một chỗ. */

  assert.throws(() => assertAgentBranch("main"), /không được đẩy thẳng/, "nhánh mặc định phải bị chặn");
  assert.throws(() => assertAgentBranch("feature/x"), /phải bắt đầu bằng/, "nhánh không mang tiền tố agent phải bị chặn");
  assert.equal(assertAgentBranch("claude/calibrate-population"), "claude/calibrate-population", "nhánh của phiên Claude phải đi qua được");
  assert.equal(assertAgentBranch("ai/proof/x"), "ai/proof/x", "nhánh ai/ phải đi qua được");
  assert.ok(!/AGENT_BRANCH_PREFIXES|startsWith\("ai\/"\)/.test(than), `${SCRIPT}: không được chép lại luật nhánh — phải gọi assertAgentBranch qua openAgentPullRequest`);

  /* ═══ 8 · SECRET SỐNG TRONG ENVIRONMENT, VÀ TÊN ENVIRONMENT LÀ HẰNG ═══

     Hàng rào 4 (`ref` phải là nhánh mặc định) nằm trong chính tệp này, nên nó chặn nhầm lẫn chứ
     không chặn cố ý. Hàng rào cứng nằm ở phía GitHub: Environment `agent-identity` giữ ba secret
     và có chính sách nhánh chỉ cho `main`, nên một lượt chạy từ nhánh khác KHÔNG ĐỌC ĐƯỢC secret
     — thất bại ĐÓNG, không phụ thuộc vào nội dung một tệp mà agent sửa được.

     Ba điều được khoá ở đây, và không điều nào thay thế được điều kia. */

  const wfDongs = wfThan.split("\n");
  const iEnv = wfDongs.findIndex((d) => /^\s{4}environment:/.test(d));
  assert.ok(iEnv >= 0, `${WORKFLOW}: job phải khai \`environment:\` ở MỨC JOB (thụt 4 dấu cách) — khai ở mức step thì bước khác trong cùng job vẫn đọc secret của kho`);

  const tenEnv = wfDongs[iEnv].split(":").slice(1).join(":").trim();
  assert.equal(tenEnv, "agent-identity", `${WORKFLOW}: tên Environment phải là "agent-identity", thấy "${tenEnv}"`);

  /*
    Tên Environment nhận được từ `inputs.*` thì người gọi tự chọn kho secret của mình — tức là tự
    chọn hàng rào, tức là không có hàng rào. Nó phải là một CHUỖI CỐ ĐỊNH.
  */
  assert.ok(!tenEnv.includes("${{"), `${WORKFLOW}: tên Environment phải là hằng, không nội suy — nội suy là để người gọi tự chọn hàng rào của chính mình`);

  /*
    Và Environment KHÔNG ĐƯỢC thay cho hàng rào nhánh. Environment chưa tồn tại thì GitHub TỰ TẠO
    nó lúc job chạy lần đầu — rỗng, không chính sách nhánh. Nếu lúc ấy hàng rào 4 đã bị gỡ vì
    "đã có Environment rồi", thì cả hai cùng mất và không ai được báo. Khối 4 ở trên đã đòi phép
    kiểm nhánh; dòng này ghi rõ VÌ SAO nó vẫn phải còn sau khi có Environment.
  */
  assert.ok(iEnv < wfDongs.findIndex((d) => d.includes("ERP_AGENT_GITHUB_PRIVATE_KEY")), `${WORKFLOW}: khai environment phải đứng trước bước đọc secret`);

  console.log(
    "✓ Cầu nối mở PR: không gộp · không duyệt · không chạm cấu hình kho · KHÔNG checkout hay chạy mã nhánh nguồn · chỉ chạy từ nhánh mặc định (kiểm TRƯỚC khi đọc secret) · GITHUB_TOKEN không có quyền ghi · đối chứng bằng credential khác và sai thì đỏ · luật nhánh dùng lại adapter · secret nằm trong Environment agent-identity (tên là hằng, khai ở mức job)",
  );
}
