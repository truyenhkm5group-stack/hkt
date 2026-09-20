import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

/**
 * ═══════════ BA SECRET CỦA APP CHỈ ĐỌC ĐƯỢC TỪ ENVIRONMENT `agent-identity` ═══════════
 *
 * Bài kiểm trên khoá MỘT tệp. Bài này quét TOÀN BỘ `.github/workflows/`, vì hàng rào mất giá trị
 * ngay khi có một workflow thứ hai đọc cùng ba secret mà quên khai Environment — và đó đúng là
 * thứ đã xảy ra: `agent-update-pr.yml` ra đời sau `agent-open-pr.yml`, đọc cùng ba secret, không
 * ai nhắc, và nó đỏ ngay lượt chạy đầu sau khi secret dọn về Environment (run 35482454679:
 * `✗ Chưa có ERP_AGENT_GITHUB_APP_ID, …`, trong khi Environment có đủ).
 *
 * Liệt kê tên ba workflow đang có là khoá lại đúng lần hỏng đã xảy ra. Bất biến đúng là: **mọi**
 * job chạm tới ba secret ấy phải khai `environment: agent-identity`.
 *
 * ─── VÌ SAO KIỂM Ở MỨC JOB, VÀ VÌ SAO TÊN PHẢI LÀ HẰNG ───
 *
 *  · mức job — khai ở mức step thì bước khác trong cùng job vẫn đọc secret của kho;
 *  · tên hằng — nhận `inputs.*` là để người gọi tự chọn kho secret, tức tự chọn hàng rào của chính
 *    mình, tức không có hàng rào.
 *
 * ─── VÀ MỘT CHIỀU NGƯỢC LẠI, DỄ QUÊN ───
 *
 * Job `ops` của `ops-vps.yml` KHÔNG ĐƯỢC mang Environment này. Gắn vào đó thì `status`, `logs`,
 * `db-query` và ~60 thao tác khác đều phải đi qua chính sách nhánh của một Environment dựng cho ba
 * secret chúng không hề dùng. Hàng rào đặt sai chỗ là hàng rào người ta sẽ tìm cách đi vòng.
 */
export function testEnvironmentOnlyAgentSecrets() {
  const THU_MUC = ".github/workflows";
  const TEN_ENV = "agent-identity";
  const BA_SECRET = /ERP_AGENT_GITHUB_(APP_ID|INSTALLATION_ID|PRIVATE_KEY)/;

  /** Cắt tệp workflow thành từng JOB: tên + số dòng bắt đầu/kết thúc. Job thụt 2, khoá trong thụt 4. */
  function cacJob(src: string): { ten: string; dong: string[] }[] {
    const dong = src.split("\n");
    const iJobs = dong.findIndex((d) => /^jobs:\s*$/.test(d));
    if (iJobs < 0) return [];
    const moc: { ten: string; tu: number }[] = [];
    for (let i = iJobs + 1; i < dong.length; i += 1) {
      const m = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(dong[i]!);
      if (m) moc.push({ ten: m[1]!, tu: i });
    }
    return moc.map((m, k) => ({ ten: m.ten, dong: dong.slice(m.tu, k + 1 < moc.length ? moc[k + 1]!.tu : dong.length) }));
  }

  const tep = readdirSync(THU_MUC).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  assert.ok(tep.length >= 5, `đọc được ${tep.length} workflow — quá ít, bộ đọc hỏng chứ không phải kho hỏng`);

  const nguoiDung: string[] = [];
  for (const f of tep) {
    const src = readFileSync(`${THU_MUC}/${f}`, "utf8");
    if (!BA_SECRET.test(src)) continue;
    const jobs = cacJob(src);
    assert.ok(jobs.length > 0, `${f}: không đọc được job nào — bộ cắt job hỏng`);
    for (const job of jobs) {
      if (!job.dong.some((d) => BA_SECRET.test(d))) continue;
      nguoiDung.push(`${f}::${job.ten}`);

      const iEnv = job.dong.findIndex((d) => /^ {4}environment:/.test(d));
      assert.ok(
        iEnv >= 0,
        `${f}::${job.ten} đọc ERP_AGENT_GITHUB_* nhưng KHÔNG khai \`environment:\` ở MỨC JOB. Không có nó thì secret của Environment không tới được job, và thao tác sẽ báo "thiếu Secret" trong khi Environment có đủ (đã xảy ra: run 35482454679).`,
      );
      const ten = job.dong[iEnv]!.split(":").slice(1).join(":").trim();
      assert.equal(ten, TEN_ENV, `${f}::${job.ten}: tên Environment phải là "${TEN_ENV}", thấy "${ten}"`);
      assert.ok(!ten.includes("${{"), `${f}::${job.ten}: tên Environment phải là HẰNG — nội suy là để người gọi tự chọn kho secret của chính mình`);

      const iSecret = job.dong.findIndex((d) => BA_SECRET.test(d));
      assert.ok(iEnv < iSecret, `${f}::${job.ten}: \`environment\` phải khai TRƯỚC bước đọc secret`);
    }
  }

  // Ba workflow đã biết phải nằm trong danh sách — nếu một cái biến mất, hoặc bộ quét hỏng, hoặc
  // ai đó vừa gỡ một đường đi mà không ai nhắc.
  for (const can of ["agent-open-pr.yml::open", "agent-update-pr.yml::update", "agent-identity-proof.yml::proof", "ops-vps.yml::agent-env"]) {
    assert.ok(nguoiDung.includes(can), `thiếu ${can} trong danh sách job đọc ERP_AGENT_GITHUB_* — quét được: ${nguoiDung.join(", ")}`);
  }

  /* CHIỀU NGƯỢC LẠI: job `ops` không được phụ thuộc Environment của ba secret. */
  const ops = readFileSync(`${THU_MUC}/ops-vps.yml`, "utf8");
  const jobOps = cacJob(ops).find((j) => j.ten === "ops")!;
  assert.ok(jobOps, "ops-vps.yml phải còn job `ops`");
  assert.ok(
    !jobOps.dong.some((d) => /^ {4}environment:/.test(d)),
    "ops-vps.yml::ops KHÔNG được mang environment — gắn vào đó là bắt ~60 thao tác VPS không liên quan phải đi qua chính sách nhánh của một Environment dựng cho ba secret chúng không dùng",
  );
  assert.ok(jobOps.dong.some((d) => /if:\s*inputs\.action != 'apply-agent-env'/.test(d)), "ops-vps.yml::ops phải loại apply-agent-env — thao tác ấy đi ở job riêng");
  assert.ok(!jobOps.dong.some((d) => BA_SECRET.test(d)), "ops-vps.yml::ops không được còn tham chiếu ERP_AGENT_GITHUB_*");

  /* Hai chỗ cầm khoá vòng đời phải cầm CÙNG tệp và CÙNG chế độ, nếu không chúng trôi xa nhau. */
  const jobEnv = cacJob(ops).find((j) => j.ten === "agent-env")!;
  const thanEnv = jobEnv.dong.join("\n");
  assert.ok(/\/var\/lock\/erp-lifecycle\.lock/.test(thanEnv), "ops-vps.yml::agent-env phải cầm ĐÚNG ổ khoá vòng đời mà nhánh GHI của `ops` cầm");
  assert.ok(/flock -x -w/.test(thanEnv), "ops-vps.yml::agent-env ghi .env rồi dựng lại container ⇒ phải cầm khoá ĐỘC QUYỀN, cùng hàng đợi với deploy");
  assert.ok(/\$\{#ERP_AGENT_GITHUB_PRIVATE_KEY\}/.test(thanEnv) && !/echo[^\n]*"\$ERP_AGENT_GITHUB_PRIVATE_KEY"/.test(thanEnv), "ops-vps.yml::agent-env chỉ được in ĐỘ DÀI khoá riêng, không in giá trị");

  console.log(`✓ Secret App chỉ từ Environment: ${nguoiDung.length} job đọc ERP_AGENT_GITHUB_* và MỌI job đều khai \`environment: ${TEN_ENV}\` ở mức job, tên là hằng · job \`ops\` KHÔNG phụ thuộc Environment (60+ thao tác VPS không liên quan) · apply-agent-env tách job riêng, cùng ổ khoá vòng đời ĐỘC QUYỀN, khoá riêng chỉ in độ dài`);
}
