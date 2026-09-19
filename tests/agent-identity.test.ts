import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  __setAgentGithubFetchForTests,
  AGENT_GITHUB_ALLOWED,
  AGENT_GITHUB_DENIED,
  agentGithubConfig,
  agentGithubDisabledReason,
  agentRemoteUrl,
  appJwt,
  commitAgentFile,
  createAgentBranch,
  assertAgentBranch,
  forgetAgentToken,
  getAgentGithubIdentity,
  maskRemote,
  openAgentPullRequest,
  readAgentCheckRuns,
  testAgentGithubIdentity,
  updateAgentPullRequest,
} from "@/lib/integrations/github/agent-identity";

/**
 * ───────────── DANH TÍNH GITHUB CỦA CODING AGENT ─────────────
 *
 * Đo thật 19/09/2026: agent, tác giả PR, collaborator duy nhất và admin là CÙNG MỘT tài khoản
 * (`truyenhkm5group-stack`), và ruleset đang áp có `required_approving_review_count: 0` — nên PR
 * #12 do agent mở đã được chính agent merge với ZERO lượt duyệt.
 *
 * Bài kiểm này khoá bốn điều:
 *  1. danh tính thứ hai ký được và đổi được token NGẮN HẠN, không lưu đâu cả;
 *  2. agent KHÔNG đẩy được vào nhánh mặc định — chặn ở tầng mã, trước cả ruleset;
 *  3. mô-đun KHÔNG CÓ đường nào duyệt / gộp PR / sửa ruleset / sửa cấu hình kho. Khoá bằng SỰ
 *     VẮNG MẶT chứ không bằng một cờ tắt — cờ thì bật lại được;
 *  4. token và khoá riêng không rơi ra màn hình, nhật ký hay prompt.
 */
export async function testAgentGithubIdentityModule() {
  const ENV = ["ERP_AGENT_GITHUB_APP_ID", "ERP_AGENT_GITHUB_INSTALLATION_ID", "ERP_AGENT_GITHUB_PRIVATE_KEY", "ERP_AGENT_GITHUB_REPO"] as const;
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;
  const restore = () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    forgetAgentToken();
    __setAgentGithubFetchForTests(null);
  };
  for (const k of ENV) delete process.env[k];
  forgetAgentToken();

  try {
    // ───────── 1. Chưa cấu hình là CHƯA CẤU HÌNH, và nó nói thiếu biến nào ─────────
    const hadRepoEnv = process.env.ERP_GITHUB_REPO ?? process.env.GITHUB_REPOSITORY;
    assert.equal(agentGithubConfig(), null, "thiếu secret ⇒ chưa cấu hình, không phải lỗi");
    const reason = agentGithubDisabledReason() ?? "";
    assert.match(reason, /ERP_AGENT_GITHUB_APP_ID/, `câu chữ phải nói ĐÚNG biến còn thiếu, thấy: ${reason}`);
    assert.match(reason, /ERP_AGENT_GITHUB_PRIVATE_KEY/);
    if (!hadRepoEnv) assert.match(reason, /ERP_AGENT_GITHUB_REPO/);
    const chuaCauHinh = await testAgentGithubIdentity();
    assert.equal(chuaCauHinh.status, "NOT_CONFIGURED", "ba tình huống phải phân biệt được — gộp vào 'lỗi kết nối' là đẩy người đọc đi sửa nhầm chỗ");
    assert.equal(chuaCauHinh.identity, null);

    // ───────── 2. Nhánh: chặn nhánh mặc định TRƯỚC khi ruleset phải lên tiếng ─────────
    assert.equal(assertAgentBranch("ai/proof/identity"), "ai/proof/identity");
    assert.equal(assertAgentBranch("refs/heads/ai/proof/identity"), "ai/proof/identity", "refs/heads/ phải được bóc");
    assert.throws(() => assertAgentBranch("main"), /không được đẩy thẳng vào main/, "đẩy thẳng nhánh mặc định phải hỏng ở chỗ ĐỌC ĐƯỢC");
    assert.throws(() => assertAgentBranch("master", "master"), /không được đẩy thẳng vào master/, "nhánh mặc định là tham số, không gõ cứng");
    assert.throws(() => assertAgentBranch("hotfix/abc"), /phải bắt đầu bằng/, "nhánh không mang tiền tố agent thì không phải việc của agent");
    assert.throws(() => assertAgentBranch("ai/../main"), /không hợp lệ/);
    assert.throws(() => assertAgentBranch(""), /Thiếu tên nhánh/);

    // ───────── 3. Khả năng là DANH SÁCH CHO PHÉP, và cấm là SỰ VẮNG MẶT ─────────
    assert.deepEqual([...AGENT_GITHUB_ALLOWED], ["branch:create", "branch:push", "pr:open", "pr:update", "checks:read"]);
    for (const denied of ["push:default-branch", "pr:approve", "pr:merge", "ruleset:write"]) {
      assert.ok((AGENT_GITHUB_DENIED as readonly string[]).includes(denied), `phải khai tường minh là agent KHÔNG được ${denied}`);
      assert.ok(!(AGENT_GITHUB_ALLOWED as readonly string[]).includes(denied), `${denied} không được lọt vào danh sách cho phép`);
    }
    const src = readFileSync("lib/integrations/github/agent-identity.ts", "utf8");
    // Không phải một lời hứa trong chú thích: quét MÃ NGUỒN, bỏ qua phần chú thích.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [what, re] of [
      ["gộp PR", /["'`][^"'`]*\/merge/],
      ["duyệt PR", /["'`][^"'`]*\/reviews/],
      ["sửa ruleset", /rulesets/],
      ["sửa cấu hình kho", /\/repos\/\$\{[^}]*\}\/\$\{[^}]*\}["'`]\s*,\s*\{\s*method:\s*["'](?:PATCH|PUT|DELETE)/],
      ["ghi secret", /\/actions\/secrets/],
      ["kích hoạt workflow", /\/dispatches/],
    ] as const) {
      assert.ok(!re.test(code), `agent-identity.ts không được có đường ${what}`);
    }
    // Khoá riêng / token không được in ra.
    assert.ok(!/console\.(log|info|warn|error)/.test(code), "mô-đun danh tính không được in gì — token và khoá riêng đi qua đây");
    for (const f of readdirSync("lib/integrations/github").filter((f) => f.endsWith(".ts"))) {
      assert.ok(!readFileSync(`lib/integrations/github/${f}`, "utf8").startsWith('"use client"'), `lib/integrations/github/${f}: chỉ máy chủ`);
    }

    // ───────── 4. Ký JWT bằng khoá riêng thật, kiểm bằng khoá công khai ─────────
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.ERP_AGENT_GITHUB_APP_ID = "123456";
    process.env.ERP_AGENT_GITHUB_INSTALLATION_ID = "98765";
    process.env.ERP_AGENT_GITHUB_REPO = "truyenhkm5group-stack/hkt";
    // PEM đưa vào dạng base64: nhiều nơi lưu secret không giữ được xuống dòng.
    process.env.ERP_AGENT_GITHUB_PRIVATE_KEY = Buffer.from(pem).toString("base64");
    const cfg = agentGithubConfig();
    assert.ok(cfg, "PEM base64 phải đọc được — mất xuống dòng là lỗi khó đọc nhất của bước này");
    assert.equal(agentGithubDisabledReason(), null);

    const now = new Date("2026-09-19T10:00:00Z");
    const jwt = appJwt(cfg!, now);
    const [h, p, s] = jwt.split(".");
    const dec = (x: string) => JSON.parse(Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    assert.deepEqual(dec(h!), { alg: "RS256", typ: "JWT" });
    const claims = dec(p!) as { iat: number; exp: number; iss: string };
    assert.equal(claims.iss, "123456", "iss phải là App id");
    assert.equal(claims.iat, Math.floor(now.getTime() / 1000) - 60, "lùi 60 giây cho lệch đồng hồ");
    assert.equal(claims.exp - claims.iat, 9 * 60, "GitHub cho tối đa 10 phút — 9 để còn chỗ thở");
    assert.ok(
      createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
      "chữ ký phải kiểm được bằng khoá công khai",
    );
    assert.ok(!jwt.includes("PRIVATE KEY"), "khoá riêng không được lọt vào JWT");

    // ───────── 5. Token cài đặt: ngắn hạn, thu hẹp về đúng một kho, có đệm, không lưu ─────────
    const calls: { url: string; method: string; auth: string; body: unknown }[] = [];
    let tokenSeq = 0;
    let tokenExpiry = "2026-09-19T11:00:00Z";
    __setAgentGithubFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const headers = new Headers(init?.headers as HeadersInit);
      calls.push({ url: u, method: init?.method ?? "GET", auth: headers.get("authorization") ?? "", body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
      if (u.endsWith("/access_tokens")) {
        tokenSeq += 1;
        return json({ token: `ghs_token_${tokenSeq}`, expires_at: tokenExpiry });
      }
      if (u.endsWith("/app")) return json({ slug: "erp-agent", name: "ERP Agent" });
      if (/\/app\/installations\/\d+$/.test(u)) return json({ permissions: { contents: "write", pull_requests: "write", metadata: "read", checks: "read", actions: "read" }, repository_selection: "selected" });
      if (/\/git\/ref\/heads\//.test(u)) return json({ object: { sha: "base0sha" } });
      if (u.endsWith("/git/refs")) return json({ ref: "refs/heads/ai/proof/identity-test" });
      if (u.includes("/contents/")) return json({ commit: { sha: "commit0sha" } });
      if (u.endsWith("/pulls")) return json({ number: 99, html_url: "https://github.com/truyenhkm5group-stack/hkt/pull/99" });
      if (/\/pulls\/\d+$/.test(u)) return json({ number: 99 });
      if (u.includes("/check-runs")) return json({ check_runs: [{ name: "gates / gates", status: "completed", conclusion: "success" }] });
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch);

    const remote1 = await agentRemoteUrl(now);
    assert.match(remote1, /^https:\/\/x-access-token:ghs_token_1@github\.com\/truyenhkm5group-stack\/hkt\.git$/);
    assert.equal(maskRemote(remote1), "https://***@github.com/truyenhkm5group-stack/hkt.git", "in ra thì phải che — URL này mang token");
    const xin = calls.filter((c) => c.url.endsWith("/access_tokens"));
    assert.equal(xin.length, 1);
    assert.equal(xin[0]!.method, "POST");
    assert.deepEqual(xin[0]!.body, { repositories: ["hkt"] }, "token phải thu hẹp về đúng kho này, dù cài đặt có thêm kho khác về sau");
    assert.ok(xin[0]!.auth.startsWith("Bearer eyJ"), "đổi token phải dùng JWT của App");

    // Còn xa hạn ⇒ DÙNG LẠI, không xin thêm.
    await agentRemoteUrl(new Date("2026-09-19T10:05:00Z"));
    assert.equal(calls.filter((c) => c.url.endsWith("/access_tokens")).length, 1, "token còn hạn thì không xin lại");
    // Sát hạn (còn dưới 5 phút) ⇒ XIN MỚI. Token hết hạn giữa một lượt push là lỗi rất khó đọc.
    await agentRemoteUrl(new Date("2026-09-19T10:57:00Z"));
    assert.equal(calls.filter((c) => c.url.endsWith("/access_tokens")).length, 2, "sát hạn thì phải xin token mới trước khi dùng");

    // ───────── 6. Danh tính in ra được: có login bot, KHÔNG có token ─────────
    forgetAgentToken();
    tokenExpiry = "2026-09-19T12:00:00Z";
    const identity = await getAgentGithubIdentity(new Date("2026-09-19T11:00:00Z"));
    assert.equal(identity.botLogin, "erp-agent[bot]", "danh tính hiện trên PR phải KHÁC login của chủ shop");
    assert.notEqual(identity.botLogin, "truyenhkm5group-stack", "nếu hai cái này bằng nhau thì cổng duyệt của người vẫn không có nấc nào dùng được");
    assert.equal(identity.repo, "truyenhkm5group-stack/hkt");
    assert.equal(identity.permissions.pull_requests, "write");
    assert.equal(identity.permissions.administration, undefined, "App không được mang quyền Administration");
    assert.ok(!JSON.stringify(identity).includes("ghs_token"), "danh tính in ra không được mang token");
    assert.ok(!JSON.stringify(identity).includes("PRIVATE KEY"));

    // ───────── 7. Mở / sửa PR đi bằng token cài đặt; head phải là nhánh của agent ─────────
    const pr = await openAgentPullRequest({ head: "ai/proof/identity", base: "main", title: "Bằng chứng danh tính", body: "docs", now: new Date("2026-09-19T11:00:00Z") });
    assert.equal(pr.number, 99);
    const mo = calls.filter((c) => c.url.endsWith("/pulls") && c.method === "POST").at(-1)!;
    assert.deepEqual(mo.body, { head: "ai/proof/identity", base: "main", title: "Bằng chứng danh tính", body: "docs" });
    assert.ok(mo.auth.startsWith("Bearer ghs_token_"), "mở PR phải đi bằng token CÀI ĐẶT, không phải JWT của App");
    await assert.rejects(openAgentPullRequest({ head: "main", title: "x", body: "y" }), /không được đẩy thẳng vào main/);

    const truoc = calls.length;
    await updateAgentPullRequest({ number: 99 });
    assert.equal(calls.length, truoc, "không có gì để sửa thì không gọi mạng");

    /* ─── Tạo nhánh + ghi commit bằng API ───
       Đường API tồn tại vì `git push` KHÔNG chứng minh được danh tính ở mọi môi trường: đo thật
       19/09/2026, một phiên agent đẩy được vào kho này bằng token RÁC, vì lớp proxy của phiên tự
       gắn credential của phiên. Lời gọi API mang `Authorization` tường minh nên nó nói đúng thứ
       nó dùng. */
    const nhanhMoi = await createAgentBranch({ branch: "ai/proof/identity-test", fromRef: "main", now: new Date("2026-09-19T11:00:00Z") });
    assert.equal(nhanhMoi.branch, "ai/proof/identity-test");
    assert.equal(nhanhMoi.baseSha, "base0sha");
    const taoRef = calls.filter((c) => c.url.endsWith("/git/refs") && c.method === "POST").at(-1)!;
    assert.deepEqual(taoRef.body, { ref: "refs/heads/ai/proof/identity-test", sha: "base0sha" });
    assert.ok(taoRef.auth.startsWith("Bearer ghs_token_"), "tạo nhánh phải đi bằng token CÀI ĐẶT");
    await assert.rejects(createAgentBranch({ branch: "main" }), /không được đẩy thẳng vào main/, "không được tạo nhánh trùng nhánh mặc định");
    await assert.rejects(createAgentBranch({ branch: "hotfix/x" }), /phải bắt đầu bằng/);

    const ghi = await commitAgentFile({ branch: "ai/proof/identity-test", path: "docs/proof/x.md", content: "nội dung", message: "m", now: new Date("2026-09-19T11:00:00Z") });
    assert.equal(ghi.sha, "commit0sha");
    const putTep = calls.filter((c) => c.url.includes("/contents/") && c.method === "PUT").at(-1)!;
    assert.equal(Buffer.from((putTep.body as { content: string }).content, "base64").toString("utf8"), "nội dung", "nội dung phải đi dạng base64");
    assert.equal((putTep.body as { branch: string }).branch, "ai/proof/identity-test", "phải ghi lên NHÁNH, không lên nhánh mặc định");
    await assert.rejects(commitAgentFile({ branch: "main", path: "a.md", content: "x", message: "m" }), /không được đẩy thẳng vào main/);
    await assert.rejects(commitAgentFile({ branch: "ai/proof/identity-test", path: "../../etc/passwd", content: "x", message: "m" }), /không hợp lệ/, "đường dẫn đi ngược phải bị chặn");

    const checks = await readAgentCheckRuns("113e487", new Date("2026-09-19T11:00:00Z"));
    assert.deepEqual(checks, [{ name: "gates / gates", status: "completed", conclusion: "success" }]);

    // ───────── 8. Thử kết nối: OK / ERROR phân biệt được, và không in secret ─────────
    const ok = await testAgentGithubIdentity(new Date("2026-09-19T11:00:00Z"));
    assert.equal(ok.status, "OK", ok.message);
    assert.match(ok.message, /erp-agent\[bot\]/);
    assert.ok(!ok.message.includes("ghs_token") && !ok.message.includes("PRIVATE KEY"), "câu trả lời không được mang secret");

    forgetAgentToken();
    __setAgentGithubFetchForTests((async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
    const loi = await testAgentGithubIdentity(new Date("2026-09-19T11:00:00Z"));
    assert.equal(loi.status, "ERROR", "có cấu hình mà không đổi được token là ERROR — khác hẳn CHƯA CẤU HÌNH");
    assert.match(loi.message, /HTTP 401/);

    console.log(
      `✓ Danh tính GitHub của agent: JWT RS256 kiểm được bằng khoá công khai · token cài đặt NGẮN HẠN, thu hẹp về 1 kho, xin lại khi còn <5 phút, không lưu đâu cả · ${AGENT_GITHUB_ALLOWED.length} việc được phép / ${AGENT_GITHUB_DENIED.length} việc KHÔNG (khoá bằng sự vắng mặt của đường đi, quét mã nguồn) · đẩy thẳng nhánh mặc định bị chặn ở tầng mã · botLogin ≠ login chủ shop`,
    );
  } finally {
    restore();
  }
}
