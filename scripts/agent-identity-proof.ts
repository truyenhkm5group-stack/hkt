import { execFileSync } from "node:child_process";
import {
  AGENT_GITHUB_ALLOWED,
  AGENT_GITHUB_DENIED,
  agentGithubConfig,
  agentGithubDisabledReason,
  agentRemoteUrl,
  commitAgentFile,
  createAgentBranch,
  getAgentGithubIdentity,
  maskRemote,
  openAgentPullRequest,
  readAgentCheckRuns,
} from "@/lib/integrations/github/agent-identity";

/**
 * ═══════════ BẰNG CHỨNG DANH TÍNH AGENT — MỌI LỜI KHẲNG ĐỊNH ĐỀU ĐƯỢC ĐO ═══════════
 *
 * Kịch bản này KHÔNG phải một bài kiểm đơn vị: nó chạy bằng CREDENTIAL THẬT của GitHub App
 * `erp-agent`, trên kho THẬT, và để lại một PR THẬT làm bằng chứng đọc được bằng mắt.
 *
 * ─── VÌ SAO CÓ NHỮNG LỜI GỌI "AGENT KHÔNG ĐƯỢC PHÉP" TRONG TỆP NÀY ───
 *
 * Mỗi lời gọi đặc quyền dưới đây là một **KHẲNG ĐỊNH RẰNG NÓ THẤT BẠI**. Kịch bản thoát KHÁC 0
 * nếu bất kỳ cái nào trong số đó THÀNH CÔNG. Nói cách khác đây là hàng rào chống NỚI QUYỀN: ngày
 * ai đó cấp thêm `Administration` cho App, tệp này đỏ — thay vì không ai biết cho tới lúc có
 * chuyện. Adapter (`lib/integrations/github/agent-identity.ts`) vẫn KHÔNG CÓ những đường ấy; chúng
 * sống ở đây, trong một kịch bản chỉ chạy bằng tay, đúng một mục đích.
 *
 * ─── BỐN CÂU HỎI, BỐN CƠ CHẾ CHẶN KHÁC NHAU ───
 *
 *   đẩy thẳng `main`  → ruleset (luật `pull_request`)
 *   sửa ruleset       → App THIẾU quyền `Administration` ⇒ 403
 *   đọc/ghi secret    → App THIẾU quyền `Secrets` ⇒ 403
 *   duyệt PR của mình → GitHub cấm tác giả tự duyệt
 *
 * Gộp bốn cái này thành một ô "an toàn" là làm mất khả năng sửa khi một trong bốn hỏng.
 *
 * ─── MỘT ĐIỀU KỊCH BẢN NÀY CỐ Ý KHÔNG THỬ, VÀ NÓI THẲNG VÌ SAO ───
 *
 * **Gộp PR.** Hôm nay ruleset đang để `required_approving_review_count: 0`, nên một token mang
 * `contents: write` + `pull_requests: write` GỘP ĐƯỢC. Thử nó là thật sự gộp một thứ vào `main`,
 * không phải chứng minh nó bị chặn. Nên kịch bản BÁO CÁO sự thật đó thay vì diễn một phép thử:
 * cái chặn gộp là bước nâng ruleset lên 1 lượt duyệt, và chỉ sau bước ấy phép thử gộp mới có
 * nghĩa. Chạy lại kịch bản với `--probe-merge` SAU khi ruleset đã nâng thì lúc đó nó mới đo.
 */

const OK = (m: string) => console.log(`  ✓ ${m}`);
const BAD = (m: string) => console.log(`  ✗ ${m}`);
const INFO = (m: string) => console.log(`    ${m}`);
let fails = 0;
const fail = (m: string) => {
  fails += 1;
  BAD(m);
};

/** Quyền mà App TUYỆT ĐỐI không được mang — mỗi cái mở một đường vòng qua chính cổng đang canh. */
const QUYEN_CAM: Record<string, string> = {
  administration: "sửa được chính ruleset đang canh cổng",
  secrets: "đọc/ghi được bí mật của kho",
  variables: "sửa được biến cấu hình của kho",
  environments: "sửa được môi trường và luật phê duyệt deploy",
  repository_hooks: "dựng được webhook ra ngoài",
  workflows: "sửa được `gates.yml`, tức đổi được chính cổng bắt buộc",
};

const API = "https://api.github.com";

/**
 * Gọi một endpoint ĐẶC QUYỀN và khẳng định nó BỊ TỪ CHỐI.
 *
 * BA MÃ, BA CƠ CHẾ CHẶN KHÁC NHAU — và gộp chúng lại là mất khả năng sửa khi một cái hỏng:
 *   · 403 — App THIẾU QUYỀN (`Administration`, `Secrets`…). Chặn ở tầng cài đặt App.
 *   · 404 — GitHub trả 404 thay vì 403 ở vài đường, để không lộ sự tồn tại của tài nguyên.
 *   · 409 kèm "rule violations" — App CÓ quyền nhưng RULESET chặn. Đây đúng là điều ta muốn thấy
 *     khi ghi thẳng vào nhánh mặc định: quyền `contents: write` là quyền THẬT, và thứ đứng chắn
 *     là luật của kho. Bản đầu của hàm này chỉ nhận 403/404 nên chấm 409 thành ĐỎ — một báo động
 *     giả đúng ở chỗ nguy hiểm nhất: nó làm người đọc nghi ngờ một hàng rào đang hoạt động.
 *
 * Một 409 KHÔNG kèm câu "rule violations" thì vẫn ĐỎ: xung đột vì lý do khác không chứng minh
 * được điều gì về hàng rào.
 */
async function phaiBiTuChoi(nhan: string, url: string, init: RequestInit, token: string) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    fail(`${nhan}: không gọi được (${e instanceof Error ? e.message : String(e)}) — CHƯA BIẾT, không phải "đã bị chặn"`);
    return;
  }
  if (res.status === 403 || res.status === 404) {
    OK(`${nhan}: BỊ TỪ CHỐI (HTTP ${res.status}) — App thiếu quyền`);
    return;
  }
  const body = await res.text();
  if (res.status === 409 && /rule violations|protected branch/i.test(body)) {
    const ly = [...body.matchAll(/(Changes must be made through a pull request|Required status check [^\\"]+|Cannot force-push|[^\\"]*review[^\\"]*required)/gi)].map((m) => m[1]).slice(0, 3);
    OK(`${nhan}: BỊ TỪ CHỐI (HTTP 409) — RULESET chặn${ly.length ? `: ${ly.join(" · ")}` : ""}`);
    return;
  }
  fail(`${nhan}: KHÔNG bị từ chối — HTTP ${res.status}. ${body.slice(0, 300)}`);
}

async function main() {
  const batDau = new Date();
  console.log("Bằng chứng danh tính GitHub của coding agent —", batDau.toISOString());

  const lyDo = agentGithubDisabledReason();
  if (lyDo) {
    BAD(`Chưa cấu hình: ${lyDo}`);
    INFO("Đặt secret theo docs/agent-github-identity.md mục 3.4 rồi chạy lại.");
    process.exit(1);
  }
  const cfg = agentGithubConfig()!;

  // ───────── 1. Danh tính ─────────
  console.log("\n▶ 1. Danh tính");
  const dt = await getAgentGithubIdentity();
  OK(`botLogin ${dt.botLogin} · app ${dt.appSlug} (id ${dt.appId}) · cài đặt ${dt.installationId} · kho ${dt.repo}`);
  INFO(`phạm vi cài đặt: ${dt.repositorySelection}`);

  const chuKho = cfg.owner;
  if (!dt.botLogin) fail("Không đọc được botLogin — chưa chứng minh được gì");
  else if (dt.botLogin === chuKho) fail(`botLogin TRÙNG chủ kho (${chuKho}) — cổng duyệt vẫn không có nấc nào dùng được`);
  else OK(`botLogin KHÁC chủ kho (${chuKho}) — đây là điều kiện để "1 lượt duyệt" trở thành luật chạy được`);
  if (dt.repositorySelection !== "selected") fail(`cài đặt đang ở phạm vi "${dt.repositorySelection}" — phải là "selected", chỉ đúng kho này`);

  // ───────── 2. Quyền: danh sách CHO PHÉP, và những ô tuyệt đối không được có ─────────
  console.log("\n▶ 2. Quyền của App (đọc thẳng từ GitHub, không đọc tài liệu)");
  const perms = dt.permissions;
  INFO(Object.entries(perms).map(([k, v]) => `${k}=${v}`).join(" · ") || "(trống)");
  for (const [quyen, viSao] of Object.entries(QUYEN_CAM)) {
    if (perms[quyen]) fail(`mang quyền ${quyen}=${perms[quyen]} — ${viSao}. Gỡ ở Settings → Developer settings → GitHub Apps → erp-agent → Permissions.`);
    else OK(`không có ${quyen}`);
  }
  if (perms.actions && perms.actions !== "read") fail(`actions=${perms.actions} — chỉ được "read"`);
  else OK(`actions=${perms.actions ?? "(không có)"} — không ghi được Actions`);
  for (const [can, muc] of [["contents", "write"], ["pull_requests", "write"], ["metadata", "read"]] as const) {
    if (perms[can] === muc || (muc === "read" && perms[can])) OK(`có ${can}=${perms[can]} (cần để ${can === "contents" ? "đẩy nhánh" : can === "pull_requests" ? "mở PR" : "GitHub bắt buộc"})`);
    else fail(`thiếu ${can}=${muc} — agent sẽ không ${can === "contents" ? "đẩy được nhánh" : "mở được PR"}`);
  }
  INFO(`agent ĐƯỢC: ${AGENT_GITHUB_ALLOWED.join(" · ")}`);
  INFO(`agent KHÔNG ĐƯỢC: ${AGENT_GITHUB_DENIED.join(" · ")}`);

  // ───────── 3. Nhánh + commit tài liệu, đẩy bằng danh tính agent ─────────
  console.log("\n▶ 3. Nhánh tài liệu, đẩy bằng danh tính agent");
  const ngay = batDau.toISOString().slice(0, 10);
  const nhanh = `ai/proof/identity-${ngay}-${batDau.getTime().toString(36)}`;
  const tep = `docs/proof/agent-identity-${ngay}.md`;
  const base = process.env.ERP_AGENT_PROOF_BASE || "main";

  /* ─── CHẨN ĐOÁN MÔI TRƯỜNG: lượt `git push` có THẬT SỰ đi bằng token của App không? ───
     Đo thật 19/09/2026: trong một phiên agent, lượt đẩy mang token RÁC vẫn THÀNH CÔNG vào kho
     này — lớp proxy của phiên tự gắn credential của phiên vào mọi lời gọi git tới kho được phép.
     Ở môi trường như thế, `git push` nói về danh tính của PHIÊN chứ không nói gì về danh tính của
     App. Nên đây KHÔNG phải một khẳng định pass/fail: nó quyết định phép đo nào còn giá trị. */
  const remote = await agentRemoteUrl();
  INFO(`remote: ${maskRemote(remote)}`);
  const remoteRac = remote.replace(/x-access-token:[^@]+@/, "x-access-token:token-rac-khong-hop-le@");
  let gitPushDoDuoc: boolean;
  try {
    execFileSync("git", ["push", "--dry-run", remoteRac, "HEAD:refs/heads/ai/proof/doi-chung-token-rac"], { encoding: "utf8", stdio: "pipe" });
    gitPushDoDuoc = false;
    BAD("chẩn đoán: token RÁC vẫn đẩy được ⇒ môi trường này TỰ TIÊM credential");
    INFO("⇒ `git push` ở đây KHÔNG chứng minh được danh tính, nên bằng chứng dưới đây đi bằng API");
    INFO("   (Authorization tường minh). Đây KHÔNG phải lỗi của App — là tính chất của môi trường.");
  } catch {
    gitPushDoDuoc = true;
    OK("chẩn đoán: token rác bị từ chối ⇒ lượt đẩy git thật sự đi bằng token trong URL");
  }

  /* ─── ĐỐI CHỨNG QUYẾT ĐỊNH CHO ĐƯỜNG API ───
     `GET /user` bằng TOKEN CÀI ĐẶT phải trả 403: token cài đặt không có ngữ cảnh người dùng. Nếu
     nó trả về một hồ sơ người dùng thì có ai đó đã tráo token của ta, và mọi con số sau đây là
     của người khác. Đây là phép thử rẻ nhất phân biệt "đã chứng minh" với "trông như đã chứng
     minh". */
  const token = remote.replace(/^https:\/\/x-access-token:/, "").replace(/@github\.com.*$/, "");
  const uRes = await fetch(`${API}/user`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (uRes.status === 403) OK("đối chứng API: GET /user bằng token cài đặt ⇒ 403 (không có ngữ cảnh người dùng) — token tới GitHub nguyên vẹn");
  else if (uRes.ok) fail(`đối chứng API HỎNG: GET /user trả về "${((await uRes.json()) as { login?: string }).login}" — token đã bị tráo, mọi con số dưới đây vô giá trị`);
  else fail(`đối chứng API: GET /user trả HTTP ${uRes.status} — CHƯA BIẾT, không kết luận`);
  const insRes = await fetch(`${API}/installation/repositories`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (insRes.ok) {
    const ins = (await insRes.json()) as { total_count: number; repositories: { full_name: string }[] };
    if (ins.total_count === 1 && ins.repositories[0]?.full_name === `${cfg.owner}/${cfg.repo}`) OK(`đối chứng API: token cài đặt chỉ với tới ĐÚNG MỘT kho — ${ins.repositories[0]!.full_name}`);
    else fail(`token cài đặt với tới ${ins.total_count} kho: ${ins.repositories.map((r) => r.full_name).join(", ")} — phải đúng một`);
  } else fail(`không đọc được phạm vi cài đặt (HTTP ${insRes.status})`);
  if (fails) {
    console.log("\nDừng: đối chứng không sạch, không tạo PR bằng một bằng chứng không đáng tin.");
    process.exit(1);
  }

  // ───────── 3b. Tạo nhánh + commit bằng API, mang Authorization của App ─────────
  await createAgentBranch({ branch: nhanh, fromRef: base });
  OK(`tạo được nhánh ${nhanh} từ ${base}`);
  const noiDung = [
    `# Bằng chứng danh tính agent — ${ngay}`,
    "",
    `PR này do **\`${dt.botLogin}\`** mở, KHÔNG phải \`${chuKho}\`. Đó là toàn bộ mục đích của nó.`,
    "",
    "| | |",
    "|---|---|",
    `| App | \`${dt.appSlug}\` (id \`${dt.appId}\`) |`,
    `| Cài đặt | \`${dt.installationId}\`, phạm vi \`${dt.repositorySelection}\` |`,
    `| Kho | \`${dt.repo}\` |`,
    `| Quyền | ${Object.entries(perms).map(([k, v]) => `\`${k}=${v}\``).join(" · ")} |`,
    `| Đường ghi | ${gitPushDoDuoc ? "git push bằng token App" : "GitHub API (môi trường chạy tự tiêm credential git nên git push không chứng minh được danh tính)"} |`,
    "",
    "Chỉ có tệp này. Không đụng mã nghiệp vụ, không đụng cấu hình, không đụng ruleset.",
    "",
    "Sinh bởi `scripts/agent-identity-proof.ts`. Bối cảnh: `docs/agent-github-identity.md`.",
    "",
  ].join("\n");
  const { sha } = await commitAgentFile({ branch: nhanh, path: tep, content: noiDung, message: `Bằng chứng danh tính: PR này do ${dt.botLogin} mở, không phải chủ kho`, baseBranch: base });
  OK(`ghi được ${tep} thành commit ${sha.slice(0, 12)} trên ${nhanh}`);

  // ───────── 4. Mở PR bằng danh tính agent ─────────
  console.log("\n▶ 4. Pull request");
  const pr = await openAgentPullRequest({
    head: nhanh,
    base,
    title: `Bằng chứng danh tính agent — ${ngay}`,
    body: [
      `PR này do **\`${dt.botLogin}\`** mở, không phải \`${chuKho}\`. Chỉ một tệp tài liệu.`,
      "",
      "Mục đích: chứng minh coding agent có một danh tính GitHub **thứ hai**, tách khỏi tài khoản chủ shop —",
      "điều kiện để `required_approving_review_count: 1` trở thành một luật chạy được thay vì một cái bẫy",
      "(xem `docs/agent-github-identity.md`).",
      "",
      "**Đừng gộp PR này để lấy tài liệu.** Nó tồn tại để chủ shop bấm Approve một lần và xem cổng duyệt hoạt động.",
      "",
      `Sinh bởi \`scripts/agent-identity-proof.ts\` · commit \`${sha.slice(0, 12)}\`.`,
    ].join("\n"),
  });
  OK(`mở được PR #${pr.number} — ${pr.url}`);

  /* Tác giả PR do TOKEN quyết định, KHÔNG do `git config user.name`. Nên đọc LẠI từ GitHub là
     phép đo danh tính quyết định nhất trong cả kịch bản — và nó cũng bắt được trường hợp một lớp
     trung gian đã tráo token của ta bằng token khác. */
  const prRes = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}/pulls/${pr.number}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${remote.replace(/^https:\/\/x-access-token:/, "").replace(/@github\.com.*$/, "")}` }, signal: AbortSignal.timeout(20_000) });
  const prJson = (await prRes.json()) as { user?: { login?: string; type?: string } };
  const tacGia = prJson.user?.login ?? "";
  if (tacGia === dt.botLogin) OK(`tác giả PR đọc lại từ GitHub: ${tacGia} (${prJson.user?.type}) — ĐÚNG là danh tính agent`);
  else fail(`tác giả PR là "${tacGia}", KHÔNG phải ${dt.botLogin} — token đã bị tráo ở đâu đó, bằng chứng vô giá trị`);
  if (tacGia === chuKho) fail("tác giả PR là CHỦ KHO — đây đúng là lỗ hổng cần vá, chưa vá được");

  // ───────── 5. Bốn việc agent KHÔNG được làm ─────────
  console.log("\n▶ 5. Những việc agent KHÔNG được làm (mỗi dòng là một khẳng định RẰNG NÓ HỎNG)");
  // 5a. Đẩy thẳng nhánh mặc định. Hai đường, và chỉ đường API là đường đo được ở mọi môi trường.
  await phaiBiTuChoi(`ghi thẳng vào ${base} qua API`, `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${tep.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "phép thử phải hỏng", content: Buffer.from("x").toString("base64"), branch: base }) }, token);
  if (gitPushDoDuoc) {
    try {
      execFileSync("git", ["push", remote, `HEAD:${base}`], { encoding: "utf8", stdio: "pipe" });
      fail(`ĐẨY THẲNG ${base} THÀNH CÔNG — ruleset không chặn. Đây là sự cố, dừng mọi việc khác lại.`);
    } catch (e) {
      const err = maskRemote(String((e as { stderr?: Buffer }).stderr ?? e));
      OK(`git push thẳng ${base}: BỊ TỪ CHỐI`);
      INFO(err.split("\n").filter((l) => /GH0|protected|rule|pull request|status check/i.test(l)).slice(0, 3).join(" | ") || "(git không nói lý do cụ thể)");
    }
  } else {
    INFO(`git push thẳng ${base}: KHÔNG ĐO ĐƯỢC ở môi trường này (xem chẩn đoán ở bước 3) — đường API ở trên mới là phép đo`);
  }

  // 5b. Tự duyệt PR của chính mình — GitHub phải cấm.
  const rvRes = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}/pulls/${pr.number}/reviews`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ event: "APPROVE" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (rvRes.ok) {
    const rv = (await rvRes.json()) as { state?: string };
    if (rv.state === "APPROVED") fail(`TỰ DUYỆT ĐƯỢC PR của chính mình (state ${rv.state}) — cổng duyệt vô nghĩa`);
    else OK(`tự duyệt: GitHub hạ xuống "${rv.state}", KHÔNG phải APPROVED`);
  } else {
    OK(`tự duyệt PR của chính mình: BỊ TỪ CHỐI (HTTP ${rvRes.status})`);
    INFO(((await rvRes.text()).match(/"message":"([^"]+)"/)?.[1] ?? "").slice(0, 160));
  }

  // 5c. Sửa ruleset — thân rỗng nên nếu CÓ quyền thì chỉ ra 422 và không tạo gì; 403 = không có quyền.
  await phaiBiTuChoi("sửa ruleset", `${API}/repos/${cfg.owner}/${cfg.repo}/rulesets`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, token);

  // 5d. Chạm vào secret của kho (chỉ ĐỌC khoá công khai — không ghi gì).
  await phaiBiTuChoi("đọc khoá secret của kho", `${API}/repos/${cfg.owner}/${cfg.repo}/actions/secrets/public-key`, {}, token);

  // 5e. Sửa cấu hình kho.
  await phaiBiTuChoi("sửa cấu hình kho", `${API}/repos/${cfg.owner}/${cfg.repo}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ has_issues: true }) }, token);

  // 5f. GỘP PR — xem chú thích đầu tệp. Chỉ đo khi ruleset ĐÃ nâng lên 1 lượt duyệt.
  if (process.argv.includes("--probe-merge")) {
    await phaiBiTuChoi("gộp PR của chính mình", `${API}/repos/${cfg.owner}/${cfg.repo}/pulls/${pr.number}/merge`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha }) }, token);
  } else {
    INFO("gộp PR: CHƯA ĐO — cờ --probe-merge tắt.");
    INFO("Hôm nay ruleset để 0 lượt duyệt, nên token mang contents+pull_requests GỘP ĐƯỢC; thử nó là");
    INFO("thật sự gộp một thứ vào nhánh mặc định chứ không phải chứng minh nó bị chặn. Cái chặn gộp là");
    INFO("bước nâng ruleset lên 1 lượt duyệt — chạy lại với --probe-merge SAU bước đó thì phép đo mới có nghĩa.");
  }

  // ───────── 6. Cổng ─────────
  console.log("\n▶ 6. Cổng trên commit vừa đẩy");
  /* Cổng chạy trên sự kiện `pull_request` nên nó mất vài giây tới vài chục giây mới xuất hiện.
     Hỏi MỘT lần rồi in "chưa có" là biến "chưa kịp bắt đầu" thành ra giống "không có cổng nào" —
     hai tình huống khác hẳn nhau (AGENTS.md mục 42: CHƯA BIẾT không được in ra thành 0). */
  let checks: Awaited<ReturnType<typeof readAgentCheckRuns>> = [];
  const hanCho = Date.now() + 240_000;
  for (;;) {
    checks = await readAgentCheckRuns(sha);
    if (checks.length && checks.every((c) => c.status === "completed")) break;
    if (Date.now() > hanCho) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!checks.length) {
    fail("không thấy check run nào sau 4 phút — cổng bắt buộc không chạy trên PR này, cần xem lại ci.yml");
  } else {
    for (const c of checks) {
      if (c.conclusion === "success") OK(`${c.name}: ${c.status}/${c.conclusion}`);
      else if (c.status !== "completed") fail(`${c.name}: còn ${c.status} sau 4 phút — CHƯA BIẾT, không kết luận là xanh`);
      else fail(`${c.name}: ${c.conclusion}`);
    }
  }

  console.log(`\n${fails === 0 ? "DANH TÍNH AGENT: ĐẠT" : `DANH TÍNH AGENT: ${fails} khẳng định KHÔNG đạt`} — PR #${pr.number} · ${new Date().toISOString()}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(maskRemote(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
