import type { AgentOutcome } from "@/lib/agents/executor";

/**
 * ═══════════ CỔNG ĐỎ THÌ CHO AGENT SỬA MỘT LẦN, NGAY TRONG LƯỢT CHẠY ═══════════
 *
 * ─── ĐÃ ĐO: HAI LƯỢT LIỀN MẤT TRẮNG VÌ CÙNG MỘT LÝ DO ───
 *
 *     Lượt #23   QA viết bài kiểm · 20 vòng · $0,2719 · typecheck=FAILED ⇒ không commit
 *     Lượt #24   QA viết bài kiểm · 18 vòng · $0,3024 · typecheck=FAILED ⇒ không commit
 *
 * Cả hai lượt agent đều tin là mình đã xong. Nó **không sai về ý thức**: runner chạy bốn cổng SAU
 * khi agent gọi `finish`, nên agent chưa từng nhìn thấy thông báo lỗi của chính mình. Nó không có
 * cách nào biết, và không có cách nào sửa.
 *
 * Giá của chỗ hở ấy là **toàn bộ lượt chạy** — không commit, không nhánh, không PR — đổi lấy một
 * lỗi kiểu dữ liệu mà chính agent sửa được trong một vòng.
 *
 * ─── VÌ SAO SỬA TRONG LƯỢT, KHÔNG PHẢI CHẠY LẠI CẢ LƯỢT ───
 *
 * Nấc 5 (chạy lại trên cùng nhánh kèm phản hồi review) vẫn đúng cho phản hồi của NGƯỜI. Nhưng
 * dùng nó cho một lỗi cổng thì phải trả giá một lượt dispatch mới, một lần dựng cây làm việc mới,
 * và agent bắt đầu lại từ con số không — trong khi **tệp nó vừa viết vẫn còn nguyên trên đĩa**.
 *
 * Một vòng sửa tốn vài xu. Một lượt chạy bỏ đi tốn $0,30. Phép so sánh không cần bàn thêm.
 *
 * ─── VÀ CHỈ MỘT LẦN ───
 *
 * `toiDa: 1`. Một agent sửa không xong trong một lượt thì lần thứ hai gần như luôn là nó đang
 * loay hoay quanh cùng một chỗ, và mỗi vòng đều tính tiền thật. Hết một lần thì lượt chạy KẾT
 * THÚC ĐỎ như cũ — người xem rồi quyết, đúng chỗ nó phải dừng.
 */
export const GATE_REPAIR = {
  /** Số lượt sửa cho mỗi lượt chạy. KHÔNG nâng mà không có phép đo cho thấy lượt thứ hai cứu được gì. */
  toiDa: 1,
  /** Số ký tự đuôi của mỗi thông báo lỗi đưa lại cho agent. Đủ để thấy dòng `error TS…`, không đủ để tràn ngữ cảnh. */
  doDaiLoi: 3_000,
} as const;

export type KetQuaCong = { ten: string; exitCode: number | null; dauRa: string };

/**
 * Dựng câu phản hồi cho agent khi cổng đỏ — HÀM THUẦN.
 *
 * Ba điều câu này PHẢI nói, và không nói gì hơn:
 *  1. việc chưa xong, và VÌ SAO (cổng nào, lỗi gì) — không mớm cách sửa;
 *  2. tệp nó viết VẪN CÒN, nó đang sửa tiếp chứ không làm lại từ đầu;
 *  3. đây là lần sửa DUY NHẤT.
 *
 * KHÔNG gợi ý "xoá bài kiểm đi cho xanh": đó là lối thoát rẻ nhất và tệ nhất, và một câu nhắc mớm
 * sẵn lối ấy sẽ được dùng.
 */
export function dungPhanHoiCong(hong: KetQuaCong[]): string {
  const khoi = hong
    .map((g) => `── ${g.ten} (exit=${g.exitCode ?? "?"}) ──\n${g.dauRa.slice(-GATE_REPAIR.doDaiLoi).trim()}`)
    .join("\n\n");
  return [
    "LƯỢT CHẠY CHƯA XONG: cổng kiểm thử của runner ĐỎ sau khi bạn gọi finish.",
    "",
    "Tệp bạn đã ghi VẪN CÒN NGUYÊN trong cây làm việc — bạn đang sửa tiếp, không làm lại từ đầu.",
    "",
    khoi,
    "",
    "Hãy sửa cho hết lỗi trên rồi gọi finish lại. TUYỆT ĐỐI không xoá bài kiểm hay nới lỏng khẳng định để cổng xanh —",
    "một cổng xanh nhờ xoá mất thứ nó đo thì tệ hơn một cổng đỏ.",
    "Đây là lần sửa DUY NHẤT của lượt chạy này.",
  ].join("\n");
}

/**
 * Cộng phép đo tiền của hai vòng chạy — HÀM THUẦN.
 *
 * Một vế `null` (có vòng không định giá được) làm TỔNG thành `null`, không làm nó thành vế kia:
 * cộng phần đo được rồi in ra như một tổng là nói dối bằng phép cộng (cùng luật với `doDuocGia`).
 */
export function congChiPhi(a: AgentOutcome["chiPhi"], b: AgentOutcome["chiPhi"]): AgentOutcome["chiPhi"] {
  return {
    soVong: a.soVong + b.soVong,
    vao: a.vao + b.vao,
    ra: a.ra + b.ra,
    demDoc: a.demDoc + b.demDoc,
    demGhi: a.demGhi + b.demGhi,
    usd: a.usd === null || b.usd === null ? null : Math.round((a.usd + b.usd) * 1_000_000) / 1_000_000,
  };
}
