/**
 * ═══════════ CẦU NỐI: MỞ PR BẰNG DANH TÍNH AGENT ═══════════
 *
 * Chạy trong `.github/workflows/agent-open-pr.yml`, với credential của GitHub App `erp-agent-vnx`.
 *
 * ─── VÌ SAO CẦN CÁI NÀY ───
 *
 * Phase 2B.5 chứng minh được agent CÓ một danh tính thứ hai (PR #24 mang `erp-agent-vnx[bot]`),
 * nhưng đường duy nhất tạo ra nó là bộ chứng minh — nó tự sinh nhánh của riêng nó. Mọi phiên Claude
 * vẫn mở PR bằng tài khoản chủ shop: đo 19/09/2026, **9/10 PR gần nhất** mang
 * `truyenhkm5group-stack`, từ ít nhất 5 phiên khác nhau.
 *
 * Với `required_approving_review_count: 1`, điều đó không còn là chuyện nhãn mác: chủ shop KHÔNG
 * tự duyệt PR của chính mình được, nên mọi PR do phiên mở đều **kẹt vĩnh viễn** (đo: PR #26,
 * cổng xanh, `mergeable_state: blocked`). Cầu nối này là đường thoát, và nó phải nằm trên `main`
 * TRƯỚC khi dùng được — đó là lý do nó đi bằng một PR bootstrap.
 *
 * ─── NÓ KHÔNG LÀM GÌ ───
 *
 * KHÔNG checkout nhánh nguồn. KHÔNG chạy một dòng mã nào của nhánh nguồn. KHÔNG gộp. KHÔNG duyệt.
 * Nó gọi đúng một lượt `POST /pulls` rồi đọc lại kết quả. Nhánh nguồn chỉ là một CHUỖI đi vào
 * trường `head` — nội dung của nó không bao giờ được thực thi ở đây, nên secret của App không bao
 * giờ gặp mã chưa qua review.
 *
 * ─── ĐỌC LẠI BẰNG MỘT CREDENTIAL KHÁC ───
 *
 * Sau khi mở, script đọc lại PR bằng `GITHUB_TOKEN` (chỉ `pull-requests: read`), KHÔNG bằng token
 * của App. Hai credential khác nhau cho hai vế của phép đo: nếu chỉ hỏi chính cái token vừa ghi
 * thì "đã mở bằng bot" và "trông như đã mở bằng bot" nhìn giống hệt nhau — đúng bài học mà bộ
 * chứng minh danh tính đã phải trả giá để rút ra.
 *
 * Tác giả trả về KHÁC bot ⇒ thoát khác 0. Một cầu nối im lặng mở PR dưới danh tính sai còn tệ hơn
 * không có cầu nối: nó làm người đọc tin rằng cổng duyệt đang chạy.
 */
import { getAgentGithubIdentity, openAgentPullRequest } from "@/lib/integrations/github/agent-identity";

function bat(ten: string): string {
  const v = (process.env[ten] ?? "").trim();
  if (!v) throw new Error(`Thiếu ${ten}`);
  return v;
}

async function main() {
  const head = bat("AGENT_PR_HEAD");
  const base = (process.env.AGENT_PR_BASE ?? "main").trim() || "main";
  const title = bat("AGENT_PR_TITLE");
  const body = process.env.AGENT_PR_BODY ?? "";
  const repo = bat("ERP_AGENT_GITHUB_REPO");

  const danhTinh = await getAgentGithubIdentity();
  console.log(`danh tính đang dùng : ${danhTinh.botLogin}  (app ${danhTinh.appSlug})`);
  console.log(`quyền               : ${Object.entries(danhTinh.permissions).map(([k, v]) => `${k}=${v}`).sort().join(" · ")}`);

  // `openAgentPullRequest` gọi `assertAgentBranch`: chặn nhánh mặc định và bắt tiền tố của agent.
  // Không nới ra ở đây — cầu nối này không phải chỗ để lách một luật đã có.
  const pr = await openAgentPullRequest({ head, base, title, body });
  console.log(`đã mở              : #${pr.number} — ${pr.url}`);

  /*
    ĐỐI CHỨNG. Đọc lại bằng GITHUB_TOKEN của lượt chạy, không phải token App.
  */
  const gh = bat("GITHUB_TOKEN");
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr.number}`, {
    headers: { authorization: `Bearer ${gh}`, accept: "application/vnd.github+json", "user-agent": "erp-agent-pr-bridge" },
  });
  if (!res.ok) throw new Error(`Không đọc lại được PR #${pr.number} (HTTP ${res.status})`);
  const json = (await res.json()) as { user?: { login?: string; type?: string }; head?: { ref?: string; sha?: string }; base?: { ref?: string } };
  const tacGia = json.user?.login ?? "";
  const kieu = json.user?.type ?? "";

  console.log(`đọc lại · tác giả  : ${tacGia}  (type ${kieu})`);
  console.log(`đọc lại · head     : ${json.head?.ref} @ ${json.head?.sha}`);
  console.log(`đọc lại · base     : ${json.base?.ref}`);

  if (tacGia !== danhTinh.botLogin) {
    throw new Error(`TÁC GIẢ SAI: đọc lại ra "${tacGia}", phải là "${danhTinh.botLogin}". Cầu nối coi đây là hỏng, không phải cảnh báo.`);
  }
  if (kieu !== "Bot") {
    throw new Error(`KIỂU TÀI KHOẢN SAI: "${kieu}", phải là "Bot".`);
  }

  console.log(`\n✓ PR #${pr.number} do ${tacGia} mở — KHÁC tài khoản chủ shop, nên chủ shop duyệt được nó.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
