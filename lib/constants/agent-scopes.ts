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
  /*
    `db/` CHỨ KHÔNG CHỈ `db/schema.ts`.

    Cạnh lược đồ còn `db/migrate.ts` — bộ áp migration CHẠY TỰ ĐỘNG lúc app khởi động, trên dữ
    liệu thật, không ai bấm gì — và `db/index.ts`, nơi mở kết nối và ép cờ chỉ-đọc. Khoá đúng một
    tệp trong ba tệp ấy là khoá cái cửa rồi để ngỏ hai cửa bên cạnh.
  */
  "db/",
  "drizzle/",
  ".github/",
  "middleware.ts",
  "scripts/",
  "lib/constants/agent-sandbox.ts",
  "lib/constants/agent-scopes.ts",
  "lib/constants/agent-test-guard.ts",
  /* Sàn của bánh cóc đăng ký bài kiểm — hạ được sàn thì bánh cóc không còn là bánh cóc. */
  "lib/constants/agent-test-registry.ts",
  /*
    `lib/agents/` — RUNNER VÀ EXECUTOR, tức nơi hàng rào được ÁP LÊN.

    Ba tệp hằng số ở trên là nơi hàng rào được KHAI; `lib/agents/runner.ts` là nơi nó được ĐỌC và
    truyền xuống `AgentWorkspace`. Khoá bản khai mà để ngỏ nơi thi hành thì vẫn còn nguyên một
    đường: sửa một dòng ở runner để nó thôi đọc bản khai. Lý lẽ "agent sửa được hàng rào của mình
    thì hàng rào chỉ còn là một lời đề nghị" áp cho CẢ HAI nửa.
  */
  "lib/agents/",
  /*
    `lib/tech/` — DỊCH VỤ GIỮ SỔ CỦA CHÍNH PHÒNG TECH.

    `service.ts` mở/đóng lượt chạy, đổi trạng thái việc và ghi sự kiện; `dispatch-service.ts` là
    nơi ERP giao việc cho agent. Đó là đường GHI vào chính cuốn sổ ghi lại agent đã làm gì — cùng
    một lớp với `lib/actions/`, và sửa được nó là sửa được lời khai về chính mình.
  */
  "lib/tech/",
  /*
    `app/api/` — tuyến HTTP hướng ra Internet, trong đó có cửa chép sổ `POST /api/tech/agent-run`.
    Đây là bề mặt mà người ngoài chạm được; nó không bao giờ là việc của một lượt chạy agent.
  */
  "app/api/",
  /*
    ═══════════ `docs/perf/` — THƯ MỤC CHỨNG TỪ, KHÔNG PHẢI THƯ MỤC TÀI LIỆU ═══════════

    Mọi mục khác trong danh sách này là nơi một lượt ghi sai làm hỏng nhiều hơn hẳn một tệp. Thư
    mục này cũng vậy, và theo một cách riêng: nó chứa SỐ ĐO PRODUCTION THẬT, chép nguyên văn từ
    `ops perf-probe` / `ops smoke`. Giá trị của nó nằm ở chỗ đọc một tệp ở đây thì biết chắc con
    số ấy đã từng được đo. Một tệp bịa nằm cạnh là đủ phá tính chất đó của CẢ THƯ MỤC — kể từ đó
    người đọc phải tự xác minh từng tệp, mà nếu phải thế thì thư mục không còn công dụng gì.

    Đây không phải một rủi ro lý thuyết. Đo 22/09/2026, việc TECH-5, lượt chạy #39 (PR #144, đã
    đóng): agent được giao "ghi lại số đo đã có" và sinh ra `docs/perf/baseline-T1-example.json`
    khai `orders: 1147 · shipments: 1302` — production khi ấy có **1.401 đơn · 2.572 vận đơn**.
    Không dòng nào trong ba tài liệu chính của lượt ấy trích tệp số đo thật, và số `7948` không
    xuất hiện một lần nào. Tệp bịa nằm ĐÚNG cạnh `TECH-5-so-do-tho-2026-09-22.md`.

    Agent vẫn ĐỌC được thư mục này — `docs/` nằm trong `DOCUMENTATION_READ_GLOBS` và không có gì
    ở đây đổi điều đó. Đọc số đo rồi viết phân tích ra `docs/` mới đúng là việc của agent; cái bị
    chặn là ghi ĐÈ hay ghi THÊM vào chính cuốn sổ chứng từ. Đó cũng là AGENTS.md mục 20 ở dạng
    hàng rào thay vì lời dặn: "ERP chưa đo được thì để MANUAL — KHÔNG viết một truy vấn gần đúng
    rồi gọi nó là chỉ số."

    VÌ SAO LÀ HÀNG RÀO CHỨ KHÔNG PHẢI MỘT DÒNG TRONG `AGENTS.md`: lượt chạy #39 đã có cả tệp số
    đo lẫn đề bài trong tay và vẫn bịa. Một lời dặn nữa cho cùng một bộ đọc cùng một thứ là chờ
    một kết quả khác từ cùng một đầu vào.
  */
  "docs/perf/",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "next.config.ts",
  /*
    ═══════════ BÀI KIỂM KHOÁ LUẬT — CHỖ HỞ MÀ BỘ ĐẾM KHẲNG ĐỊNH KHÔNG BỊT ═══════════

    `lib/constants/agent-test-guard.ts` chặn lối tắt "xoá khẳng định cho cổng xanh", và nó làm
    việc đó tốt. Nhưng nó đếm SỐ khẳng định, nên có đúng hai đường lách mà nó không thấy:

     1. **Đổi GIÁ TRỊ KỲ VỌNG.** `assert.equal(x, 5)` → `assert.equal(x, 6)`: số khẳng định không
        đổi, cổng xanh, và luật nghiệp vụ vừa bị viết lại. AGENTS.md mục 0 gọi thẳng tên đường
        này: *"Không được sửa giá trị kỳ vọng của chúng để CI xanh — nếu chúng đỏ thì code sai,
        không phải test sai."*
     2. **Xoá một dòng ĐĂNG KÝ trong bộ chạy.** `testX()` trong `tests/sync-fixtures.test.ts`
        không phải một khẳng định, nên xoá nó không làm bộ đếm nhúc nhích — mà cả một khối kiểm
        thử biến mất, và diff chỉ là MỘT DÒNG.

    Nên những bài kiểm mà AGENTS.md TỰ NHẮC TỚI như chỗ khoá một luật nằm ngoài tầm với, ở mọi
    vai. Sửa chúng là một quyết định của người, không phải một bước trong một lượt chạy.
    `tests/agent-scopes.test.ts` nằm đây cùng lý do với ba tệp hằng số ở trên: nó là bài kiểm của
    chính hàng rào.
  */
  "tests/sync-fixtures.test.ts",
  "tests/contract-order-outcome.test.ts",
  "tests/repo-integrity.test.ts",
  "tests/migration-journal.test.ts",
  "tests/migration-upgrade-path.test.ts",
  "tests/access-model.test.ts",
  "tests/cost-allocation.test.ts",
  "tests/product-notes.test.ts",
  "tests/care-reopen.test.ts",
  /*
    Bài kiểm của BẢN ĐỒ MÀN HÌNH (mục 69). Nó khoá hai thứ mà một lượt chạy agent rất dễ "dọn":
    danh sách module chỉ sống ở một sổ khai, và mọi nấc AI khai "đang chạy" phải trỏ tới tệp có
    thật. Một agent sửa được bài kiểm này thì nó tự cấp cho mình quyền khai khống năng lực của
    chính mình.
  */
  "tests/department-map.test.ts",
  "tests/test-hygiene.test.ts",
  "tests/agent-scopes.test.ts",
];

/**
 * BÀI KIỂM ĐƯỢC AGENTS.md NHẮC TỚI NHƯNG **KHÔNG** PHẢI CHỖ KHOÁ MỘT LUẬT.
 *
 * Ba tệp này bị nêu tên như VÍ DỤ về một lỗi đã xảy ra (mục 50 và 65), không phải như nơi một
 * luật được ghim. Khai riêng ra, kèm lý do, để phép kiểm chống trôi ở `tests/agent-scopes.test.ts`
 * phân biệt được "đã cân nhắc và xếp ra ngoài" với "quên chưa xếp" — một danh sách miễn trừ không
 * có lý do là một danh sách không ai dám xoá dòng nào.
 */
export const TEST_NEU_LAM_VI_DU: Record<string, string> = {
  "tests/order-duplicate.test.ts": "Mục 50 nêu nó như VÍ DỤ về bài kiểm ghim ngày tuyệt đối, không phải chỗ khoá một luật nghiệp vụ.",
  "tests/care-os.test.ts": "Mục 50 nêu nó như VÍ DỤ thứ hai về cùng lỗi cửa sổ trượt.",
  "tests/cs-workqueue.test.ts": "Mục 65 nêu nó như VÍ DỤ về bài kiểm đỏ vì kết thúc dòng CRLF, không phải chỗ khoá một luật.",
};

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
