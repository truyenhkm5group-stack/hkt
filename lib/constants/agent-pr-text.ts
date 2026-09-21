/**
 * ═══════════ CHỮ CỦA MỘT PR DO AGENT TỰ MỞ — HÀM THUẦN ═══════════
 *
 * Tới Nấc 5, agent chạy xong thì đẩy một nhánh rồi dừng. NGƯỜI phải mở PR. Mắt xích "tạo PR" trong
 * dây chuyền *nhận việc → code → test → tạo PR → review → gộp* vẫn là một thao tác tay.
 *
 * ─── ĐIỀU DUY NHẤT KHÓ Ở ĐÂY KHÔNG PHẢI GỌI API, MÀ LÀ VIẾT GÌ ───
 *
 * **Kho mã này PUBLIC. Tiêu đề và mô tả PR ai cũng đọc được.**
 *
 * Nội dung một việc Tech thì không: nó đi qua cửa đọc hẹp `GET /api/tech/agent-task` và phải có
 * khoá. Chính vì vậy ô `task` của workflow chỉ nhận **MÃ việc**, không nhận tiêu đề hay mô tả —
 * đầu vào dispatch hiện nguyên văn trong giao diện Actions.
 *
 * Nếu PR tự mở lại chép tiêu đề/mô tả việc vào thân, thì mọi hàng rào ấy vừa bị vòng qua bằng
 * chính cái cửa mà ta vừa mở. Nên luật ở đây rất hẹp:
 *
 *   **CHỈ được viết những thứ đã công khai sẵn hoặc không phải nội dung nghiệp vụ** — mã việc,
 *   khoá vai agent, số lượt chạy GitHub, kết quả bốn cổng, danh sách ĐƯỜNG DẪN tệp đã đổi.
 *
 * Tên tệp trong `docs/` là thứ người xem cần để biết PR đụng vào đâu, và nó nằm trong diff công
 * khai của chính PR ấy — nói ra không thêm rò rỉ gì. Tiêu đề việc thì không nằm ở đâu công khai cả.
 *
 * `tests/agent-pr-text.test.ts` khoá điều này bằng cách thử đúng thứ nguy hiểm: đưa một tiêu đề
 * việc vào hàm rồi khẳng định nó KHÔNG xuất hiện ở đầu ra.
 */

export type AgentPrFacts = {
  /** MÃ việc, ví dụ `TECH-12`. KHÔNG phải tiêu đề việc. */
  taskCode: string;
  agentKey: string;
  /** Số lượt chạy của GitHub Actions (`github.run_number`). */
  runNumber: string;
  runUrl: string;
  /** Đường dẫn tệp agent đã đổi — nằm sẵn trong diff công khai của PR. */
  filesChanged: readonly string[];
  gates: { typecheck: string; lint: string; test: string; build: string };
};

/** Tiêu đề: đủ để nhận ra trong danh sách PR, và không mang một chữ nào của nội dung việc. */
export function dungTieuDePr(f: AgentPrFacts): string {
  const soTep = f.filesChanged.length;
  return `Agent ${f.agentKey} · ${f.taskCode} · lượt chạy #${f.runNumber} (${soTep} tệp)`;
}

/**
 * Thân PR.
 *
 * Nói ba điều, và nói luôn điều nó CỐ Ý không nói — một khoảng trống không giải thích thì người
 * xem sẽ tự đi tìm, và chỗ họ tìm tới là chỗ ta vừa quyết định không công khai.
 */
export function dungThanPr(f: AgentPrFacts): string {
  const cong = `typecheck=${f.gates.typecheck} · lint=${f.gates.lint} · test=${f.gates.test} · build=${f.gates.build}`;
  const tep = f.filesChanged.length ? f.filesChanged.map((t) => `- \`${t}\``).join("\n") : "- (không tệp nào)";
  return [
    `PR này do **agent \`${f.agentKey}\`** tự mở sau lượt chạy [#${f.runNumber}](${f.runUrl}) cho việc **${f.taskCode}**.`,
    "",
    "### Tệp đã đổi",
    tep,
    "",
    "### Cổng agent tự chạy trước khi commit",
    cong,
    "",
    "### Vì sao mô tả này không kể nội dung việc",
    "",
    "Kho mã PUBLIC, nên tiêu đề và mô tả PR ai cũng đọc được; còn nội dung việc Tech đi qua cửa đọc",
    `có khoá. Chép nội dung việc vào đây là vòng qua chính hàng rào ấy bằng cửa vừa mở. Đọc đề bài`,
    `đầy đủ ở \`/tech/tasks/${f.taskCode}\` trong ERP.`,
    "",
    "### Agent KHÔNG tự duyệt và KHÔNG tự gộp",
    "",
    "Cầu nối mở PR không có đường `/reviews` lẫn `/merge` — khoá bằng SỰ VẮNG MẶT của đường đi.",
    "Cổng `gates / gates` và luật một-lượt-duyệt vẫn nguyên; người duyệt vẫn là chủ shop.",
  ].join("\n");
}
