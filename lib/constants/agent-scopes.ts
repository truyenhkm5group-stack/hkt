import { type TechAgentRole } from "@/lib/constants/tech";

/**
 * ═══════════ PHẠM VI GHI CỦA AGENT, THEO VAI ═══════════
 *
 * Nấc 1 cho agent đúng một quyền ghi: `docs/`. Nấc 2 nới theo TỪNG BƯỚC KIẾM ĐƯỢC, và sổ này là
 * chỗ DUY NHẤT khai ai ghi được ở đâu.
 *
 * ─── HAI TẦNG, VÀ TẦNG DƯỚI KHÔNG AI VƯỢT ĐƯỢC ───
 *
 * Tầng trên (`WRITE_GLOBS_BY_ROLE`) là thứ NỚI DẦN: hôm nay `tests/`, mai có thể `lib/queries/`.
 * Nó là một quyết định, và quyết định thì đổi được.
 *
 * Tầng dưới (`NEVER_WRITE`) là thứ KHÔNG BAO GIỜ nới, cho BẤT KỲ vai nào, kể cả vai chưa tồn tại.
 * Nó không đọc sổ vai — nên một dòng khai sai ở tầng trên cũng không mở được tầng dưới. Đó là
 * điểm của việc tách hai tầng: hàng rào không được phụ thuộc vào việc cấu hình có đúng hay không.
 *
 * ─── VÌ SAO `tests/` LÀ BƯỚC NGUY HIỂM NHẤT, VÀ NÓ ĐI KÈM MỘT HÀNG RÀO RIÊNG ───
 *
 * Một agent ghi được `tests/` có thể làm cổng xanh bằng cách XOÁ khẳng định, thay vì sửa mã. Đó
 * không phải một rủi ro lý thuyết: nó là cách RẺ NHẤT để đạt mục tiêu "bốn cổng xanh", nên một
 * bộ tối ưu sẽ tìm ra nó. Vì thế `lib/constants/agent-test-guard.ts` đếm khẳng định trước/sau và
 * lượt chạy KHÔNG ĐẠT nếu số khẳng định giảm.
 *
 * Hàng rào ấy KHÔNG hoàn hảo — nó bắt việc xoá, không bắt việc làm yếu một khẳng định mà giữ
 * nguyên số lượng (đổi `assert.equal` thành `assert.ok(true)`). Nói thẳng giới hạn đó ở đây, vì
 * một hàng rào được mô tả quá lời còn nguy hiểm hơn không có: người ta thôi đọc diff.
 */

/**
 * KHÔNG VAI NÀO ĐƯỢC GHI — kiểm TRƯỚC sổ vai, nên không cấu hình nào lách được.
 *
 * Mỗi mục là một thứ mà một lượt ghi sai làm hỏng nhiều hơn hẳn một tệp:
 *
 * · `lib/actions/`   — Server Action là đường GHI vào dữ liệu nghiệp vụ thật.
 * · `lib/auth/`      — quyền và phiên đăng nhập.
 * · `db/schema.ts`   — lược đồ; đổi ở đây là đổi cả production ở lần khởi động sau.
 * · `drizzle/`       — migration ĐÃ ÁP; sửa là viết lại lịch sử của một CSDL đang chạy.
 * · `.github/`       — chính các workflow chấm điểm agent. Sửa được nó là tự chấm điểm mình.
 * · `middleware.ts`  — chặn mọi lượt gọi; một dòng ở đây mở toang API (đã đo 20/09/2026).
 * · `scripts/`       — chạy trên VPS với quyền thật.
 * · `lib/constants/agent-sandbox.ts`, `agent-scopes.ts`, `agent-test-guard.ts` — CHÍNH hàng rào.
 *   Một agent sửa được hàng rào của mình thì hàng rào chỉ còn là một lời đề nghị.
 */
export const NEVER_WRITE: readonly string[] = [
  "lib/actions/",
  "lib/auth/",
  "db/schema.ts",
  "drizzle/",
  ".github/",
  "middleware.ts",
  "scripts/",
  "lib/constants/agent-sandbox.ts",
  "lib/constants/agent-scopes.ts",
  "lib/constants/agent-test-guard.ts",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "next.config.ts",
];

/**
 * PHẠM VI GHI THEO VAI — mặc định là `docs/` cho mọi vai chưa khai gì thêm.
 *
 * Nới một vai ở đây là một QUYẾT ĐỊNH, và nó chỉ có hiệu lực khi vai ấy được BẬT trong sổ
 * `tech_agents` (mặc định TẮT, AGENTS.md mục 25). Hai cổng độc lập: khai phạm vi, và bật vai.
 */
export const WRITE_GLOBS_BY_ROLE: Partial<Record<TechAgentRole, readonly string[]>> = {
  DOCUMENTATION: ["docs/"],
  /*
    NẤC 2 · BƯỚC 1 — vai QA ghi được `tests/`.

    Vai này CHƯA ĐƯỢC BẬT trên production: cờ `enabled` của `tech_agents` mặc định `false`, và bật
    nó là một thao tác của người. Bản này chỉ dựng CƠ CHẾ và HÀNG RÀO đi kèm; việc bật chờ cổng
    "5 lượt chạy sạch liên tiếp" của vai DOCUMENTATION.
  */
  QA: ["docs/", "tests/"],
};

/** Phạm vi mặc định cho vai chưa khai — hẹp nhất, không phải rộng nhất. */
export const DEFAULT_WRITE_GLOBS: readonly string[] = ["docs/"];

/**
 * Vai này ghi được ở đâu.
 *
 * Vai lạ / chưa khai ⇒ rơi về `docs/`. Mọi nhánh lỗi phải rơi về phía HẸP HƠN (cùng luật với
 * AGENTS.md mục 31: vai trò bị tắt rơi về mẫu hệ thống, không bao giờ rơi về toàn quyền).
 */
export function writeGlobsForRole(role: string | null | undefined): readonly string[] {
  if (!role) return DEFAULT_WRITE_GLOBS;
  return WRITE_GLOBS_BY_ROLE[role as TechAgentRole] ?? DEFAULT_WRITE_GLOBS;
}
