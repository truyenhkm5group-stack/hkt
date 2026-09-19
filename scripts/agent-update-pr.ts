/**
 * ═══════════ CẦU NỐI: CẬP NHẬT NHÁNH PR BẰNG DANH TÍNH AGENT ═══════════
 *
 * Chạy trong `.github/workflows/agent-update-pr.yml`, với credential của GitHub App `erp-agent-vnx`
 * lấy từ Actions Secrets — KHÔNG bao giờ từ một bản sao khoá riêng nằm ở nơi khác.
 *
 * ─── VÌ SAO CẦN CÁI NÀY ───
 *
 * `strict_required_status_checks_policy` bắt PR phải cập nhật với nhánh đích NGAY TẠI LÚC merge.
 * Kho này có nhiều phiên chạy song song nên `main` nhảy liên tục: một PR của agent "behind" chỉ
 * vài phút sau khi mở (đo 19/09/2026: PR #30 behind hai lần trong 30 phút).
 *
 * Nếu NGƯỜI bấm nút "Update branch" thì lần bấm ấy biến họ thành **người đẩy cuối**, và
 * `require_last_push_approval: true` sẽ cấm chính họ duyệt PR đó. Cổng đóng lại với đúng người mà
 * nó đang chờ — cùng một cái bẫy đã làm PR #27 không ai merge được. Nên việc bấm nút phải thuộc về
 * agent, và người chỉ làm đúng một việc: DUYỆT.
 *
 * ─── NÓ KHÔNG LÀM GÌ ───
 *
 * KHÔNG checkout nhánh nguồn, KHÔNG chạy một dòng mã nào của nó. KHÔNG gộp PR, KHÔNG duyệt, KHÔNG
 * đụng nhánh đích. Đúng một lượt `PUT /pulls/{n}/update-branch`, tức một lượt ghi vào nhánh CỦA
 * AGENT — đúng thứ `contents: write` đã cho phép, và `assertAgentBranch` vẫn chặn nhánh mặc định.
 *
 * ─── ĐỌC LẠI BẰNG MỘT CREDENTIAL KHÁC ───
 *
 * Sau khi cập nhật, script đọc lại bằng `GITHUB_TOKEN` (chỉ `pull-requests: read`), KHÔNG bằng
 * token App. Hỏi chính cái token vừa ghi thì "đã đẩy bằng bot" và "trông như đã đẩy bằng bot" nhìn
 * giống hệt nhau — bài học đã phải trả giá ở bộ chứng minh danh tính.
 */
import { getAgentGithubIdentity, updateAgentPullRequestBranch } from "@/lib/integrations/github/agent-identity";

function bat(ten: string): string {
  const v = (process.env[ten] ?? "").trim();
  if (!v) throw new Error(`Thiếu ${ten}`);
  return v;
}

async function main() {
  const so = Number(bat("AGENT_PR_NUMBER"));
  if (!Number.isInteger(so) || so <= 0) throw new Error(`AGENT_PR_NUMBER không hợp lệ: ${process.env.AGENT_PR_NUMBER}`);
  const repo = bat("ERP_AGENT_GITHUB_REPO");
  const gh = bat("GITHUB_TOKEN");

  const danhTinh = await getAgentGithubIdentity();
  console.log(`danh tính đang dùng : ${danhTinh.botLogin}  (app ${danhTinh.appSlug})`);
  console.log(`quyền               : ${Object.entries(danhTinh.permissions).map(([k, v]) => `${k}=${v}`).sort().join(" · ")}`);

  const doc = async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${so}`, {
      headers: { authorization: `Bearer ${gh}`, accept: "application/vnd.github+json", "user-agent": "erp-agent-update-pr" },
    });
    if (!res.ok) throw new Error(`Không đọc được PR #${so} (HTTP ${res.status})`);
    return (await res.json()) as { head: { sha: string; ref: string }; mergeable_state: string };
  };

  const truoc = await doc();
  console.log(`head trước          : ${truoc.head.sha.slice(0, 12)} (${truoc.head.ref}) · ${truoc.mergeable_state}`);

  await updateAgentPullRequestBranch({ number: so });

  /*
    `update-branch` trả 202: GitHub NHẬN việc chứ chưa làm xong. Đọc lại tới khi SHA đổi thật.
    In "đã cập nhật" ngay sau 202 là in một điều chưa xảy ra.
  */
  let sau = truoc;
  for (let i = 0; i < 20 && sau.head.sha === truoc.head.sha; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    sau = await doc();
  }
  if (sau.head.sha === truoc.head.sha) {
    console.log("head KHÔNG đổi sau 60 giây — nhánh có thể đã cập nhật sẵn, hoặc GitHub chưa làm xong.");
    process.exit(0);
  }
  console.log(`head sau            : ${sau.head.sha.slice(0, 12)} · ${sau.mergeable_state}`);

  // ĐỐI CHỨNG: người đẩy commit mới phải là BOT. Nếu không, mọi kết luận về cổng duyệt sai hướng.
  const cmRes = await fetch(`https://api.github.com/repos/${repo}/commits/${sau.head.sha}`, {
    headers: { authorization: `Bearer ${gh}`, accept: "application/vnd.github+json", "user-agent": "erp-agent-update-pr" },
  });
  if (!cmRes.ok) throw new Error(`Không đọc được commit ${sau.head.sha.slice(0, 12)} (HTTP ${cmRes.status})`);
  const nguoiDay = ((await cmRes.json()) as { author?: { login?: string } }).author?.login ?? "";
  console.log(`người đẩy commit mới: ${nguoiDay}`);
  if (nguoiDay !== danhTinh.botLogin) {
    console.error(`::error::Commit mới mang tên "${nguoiDay}", không phải ${danhTinh.botLogin}. Cập nhật đã đi bằng danh tính khác.`);
    process.exit(1);
  }
  console.log("✓ nhánh đã cập nhật bằng danh tính agent");
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
