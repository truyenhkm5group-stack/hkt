import { DISPATCHABLE_WORKFLOWS, DISPATCH_REF } from "@/lib/constants/agent-dispatch";
import { GithubError, githubConfig, maskToken } from "@/lib/integrations/github/client";

/**
 * ═══════════ ĐƯỜNG GHI DUY NHẤT SANG GITHUB ═══════════
 *
 * `lib/integrations/github/client.ts` là CHỈ ĐỌC, và `tests/tech-phase2a.test.ts` quét mã nguồn để
 * giữ nguyên tính chất đó: tìm thấy `method: "POST"` hay `/dispatches` trong tệp ấy là ĐỎ.
 *
 * Nấc 3 cần đúng MỘT lượt ghi: khởi động `agent-run.yml`. Nó sống ở tệp RIÊNG này thay vì được
 * nhét vào client, vì tách tệp làm hai câu hỏi tách bạch và trả lời được bằng `ls`:
 *
 *     "ERP ghi gì sang GitHub?"  →  đọc một tệp, dài hơn trăm dòng một chút.
 *     "ERP đọc gì từ GitHub?"    →  đọc tệp kia.
 *
 * Nhét lượt ghi vào client thì câu hỏi thứ nhất chỉ trả lời được bằng cách đọc cả tệp bốn trăm
 * dòng và tin rằng mình không bỏ sót.
 *
 * ─── TOKEN RIÊNG, KHÔNG MƯỢN TOKEN ĐỌC ───
 *
 * `ERP_GITHUB_TOKEN` hôm nay chỉ có `actions: read` — và nó NÊN ở nguyên như vậy: nó nằm trong
 * `.env` production để vẽ trang Deploy, một thứ đọc suốt ngày. Quyền KHỞI ĐỘNG workflow đi bằng
 * một khoá khác (`ERP_GITHUB_DISPATCH_TOKEN`), nên:
 *
 *   · chưa khai khoá ghi ⇒ ERP KHÔNG khởi động được gì, dù token đọc vẫn chạy bình thường;
 *   · một lượt rò rỉ token đọc KHÔNG cho ai chạy workflow;
 *   · thu hồi quyền ghi = xoá một biến, không đụng tới trang Deploy.
 *
 * ─── DANH SÁCH ĐÓNG, KHÔNG PHẢI THAM SỐ ───
 *
 * Hàm này KHÔNG nhận tên workflow từ nơi gọi. Nhận được thì một ngày nào đó sẽ có người truyền
 * `deploy-vps.yml` vào, và một màn hình nghiệp vụ deploy được production.
 */

type FetchLike = typeof fetch;
let fetchImpl: FetchLike | null = null;

/** CHỈ DÙNG CHO KIỂM THỬ — tiêm `fetch` giả. Bộ kiểm thử không bao giờ gọi GitHub thật. */
export function __setDispatchFetchForTests(f: FetchLike | null) {
  fetchImpl = f;
}

const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;

/**
 * Khoá GHI. Tách hẳn khỏi khoá đọc — xem khối trên.
 *
 * KHÔNG rơi về `GITHUB_TOKEN`/`GH_TOKEN`: hai biến ấy có mặt sẵn trong mọi lượt chạy Actions, nên
 * một fallback như thế làm quyền ghi tự xuất hiện ở nơi không ai chủ ý cấp.
 */
function dispatchToken(): string | null {
  const t = (process.env.ERP_GITHUB_DISPATCH_TOKEN || "").trim();
  return t || null;
}

export type DispatchState = { configured: boolean; reason: string | null; repo: string | null; tokenMasked: string | null };

/** Cửa ghi đã bật chưa — dùng cho màn hình, để nút hiện đúng trạng thái thay vì bấm rồi mới biết. */
export function dispatchConfig(): DispatchState {
  const cfg = githubConfig();
  const t = dispatchToken();
  if (!cfg.repo) return { configured: false, reason: cfg.reason ?? "Chưa cấu hình kho GitHub.", repo: null, tokenMasked: null };
  if (!t) {
    return {
      configured: false,
      reason:
        "Chưa khai ERP_GITHUB_DISPATCH_TOKEN trên máy chủ. Đây là khoá RIÊNG cho quyền khởi động workflow, tách khỏi ERP_GITHUB_TOKEN (chỉ đọc) — chưa có nó thì ERP đọc được lịch sử deploy nhưng KHÔNG giao việc cho agent được. Đó là CHƯA BẬT, không phải hỏng.",
      repo: cfg.repo,
      tokenMasked: null,
    };
  }
  return { configured: true, reason: null, repo: cfg.repo, tokenMasked: maskToken(t) };
}

export type DispatchResult = { ok: true; workflow: string; ref: string } | { ok: false; kind: "NOT_CONFIGURED" | "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMITED" | "NETWORK" | "HTTP"; detail: string };

/**
 * KHỞI ĐỘNG LƯỢT CHẠY AGENT.
 *
 * GitHub trả **204 No Content** cho một lượt dispatch thành công — nó KHÔNG trả về id của lượt
 * chạy vừa tạo. Nên hàm này trả về "đã gửi yêu cầu", KHÔNG trả về "lượt chạy số mấy", và nơi gọi
 * tuyệt đối không được ghi một id bịa ra. Muốn biết lượt chạy nào thì đọc lại danh sách run —
 * một câu hỏi khác, của một hàm khác.
 */
export async function dispatchAgentRun(input: { workflow: string; gates: string }): Promise<DispatchResult> {
  /*
    DANH SÁCH ĐÓNG KIỂM Ở ĐÂY, KHÔNG Ở NƠI GỌI.

    Nơi gọi có thể quên, có thể bị thêm một nhánh mới, có thể là một server action viết vội. Hàm
    thực thi thì chỉ có một chỗ. Hàng rào đặt ở chỗ hẹp nhất.
  */
  if (!DISPATCHABLE_WORKFLOWS.includes(input.workflow)) {
    return { ok: false, kind: "FORBIDDEN", detail: `ERP chỉ được khởi động ${DISPATCHABLE_WORKFLOWS.join(", ")} — \`${input.workflow}\` không nằm trong danh sách.` };
  }
  const cfg = dispatchConfig();
  if (!cfg.configured || !cfg.repo) return { ok: false, kind: "NOT_CONFIGURED", detail: cfg.reason ?? "Chưa cấu hình." };
  const t = dispatchToken();
  if (!t) return { ok: false, kind: "NOT_CONFIGURED", detail: cfg.reason ?? "Chưa có khoá ghi." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await (fetchImpl ?? fetch)(`${API}/repos/${cfg.repo}/actions/workflows/${input.workflow}/dispatches`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "vnxcommerce-erp",
          Authorization: `Bearer ${t}`,
          "Content-Type": "application/json",
        },
        // `ref` là HẰNG SỐ, không phải tham số — xem `DISPATCH_REF`.
        body: JSON.stringify({ ref: DISPATCH_REF, inputs: { gates: input.gates } }),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { ok: false, kind: "NETWORK", detail: controller.signal.aborted ? `Hết ${TIMEOUT_MS / 1000} giây chờ GitHub trả lời.` : `Không gọi được GitHub: ${m}` };
    }

    // 204 = đã nhận. GitHub KHÔNG trả id lượt chạy ở đây.
    if (res.status === 204) return { ok: true, workflow: input.workflow, ref: DISPATCH_REF };

    const body = await res.text().catch(() => "");
    let message = "";
    try {
      message = String((JSON.parse(body) as { message?: unknown }).message ?? "");
    } catch {
      message = "";
    }
    /*
      BA CÂU TRẢ LỜI KHÁC NHAU CHO BA VIỆC PHẢI LÀM KHÁC NHAU (mục 55).

      403 ⇒ token thiếu quyền `actions: write` — đi cấp quyền.
      404 ⇒ sai tên kho hoặc tệp workflow — đi sửa cấu hình.
      422 ⇒ workflow không khai `workflow_dispatch`, hoặc nhánh không có tệp ấy — đi sửa workflow.
      Gộp cả ba thành "gọi GitHub thất bại" là đẩy người đọc đi sửa nhầm chỗ.
    */
    if (res.status === 401 || res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining !== null && remaining.trim() === "0") {
        return { ok: false, kind: "RATE_LIMITED", detail: "GitHub tạm khoá vì vượt hạn mức. Thử lại sau." };
      }
      return {
        ok: false,
        kind: "FORBIDDEN",
        detail: `GitHub từ chối (${res.status}${message ? `: ${message.slice(0, 120)}` : ""}). Khoá ERP_GITHUB_DISPATCH_TOKEN cần quyền \`actions: write\` trên kho này — khoá chỉ-đọc sẽ luôn nhận 403 ở đây.`,
      };
    }
    if (res.status === 404) {
      return { ok: false, kind: "NOT_FOUND", detail: `GitHub không thấy kho \`${cfg.repo}\` hoặc tệp \`${input.workflow}\` (404). Với khoá thiếu quyền, GitHub cũng trả 404 để không tiết lộ kho có tồn tại hay không.` };
    }
    return { ok: false, kind: "HTTP", detail: `GitHub trả ${res.status}${message ? `: ${message.slice(0, 160)}` : ""}.` };
  } finally {
    clearTimeout(timer);
  }
}

/** Kiểu lỗi của client đọc, dùng lại để nơi gọi chỉ phải bắt một họ lỗi. */
export { GithubError };
