/**
 * ═══════════ NHÁNH AGENT ĐẨY LÊN PHẢI VỀ TỚI DÒNG VIỆC — VÀ CHỈ KHI KHÔNG CÃI NGƯỜI ═══════════
 *
 * ĐÃ ĐO THẬT 21/09/2026, sau lượt chạy đầu-cuối đầu tiên:
 *
 *     TECH-2 | TRIAGED | pr = 0 | pr_state = (trống)
 *
 * Agent đã làm việc thật, đã đẩy nhánh `ai/documentation/TECH-2-mub8rgnd`, PR #82 đã được duyệt
 * và ĐÃ GỘP — mà production vẫn tưởng việc ấy chưa có PR nào.
 *
 * ─── VÌ SAO: CÁI KHOÁ TỰ NHIÊN KHÔNG BAO GIỜ ĐƯỢC GHI ───
 *
 * `syncPullRequests()` ghép PR với việc bằng `tech_tasks.branch === head.ref` — nhánh LÀ khoá tự
 * nhiên, và đó là một lựa chọn đúng. Nhưng cột ấy chỉ có MỘT đường ghi: `setTechTaskBranch()`,
 * gọi từ một server action, tức là do NGƯỜI gõ vào. Cửa chép sổ lượt chạy nhận `branch` trong
 * phong bì, lưu nó vào `tech_agent_runs.branch`, rồi dừng ở đó.
 *
 * Nên với mọi việc agent tự làm, ô khoá ấy vĩnh viễn rỗng, PR không bao giờ ghép được, và TOÀN BỘ
 * Nấc 4 (việc tự đi tiếp theo bằng chứng GitHub) chạy không tải: nó chỉ xét việc có `pr_synced_at`,
 * và `pr_synced_at` chỉ được ghi cho việc ghép được PR.
 *
 * Một dây chuyền hỏng ở khúc này KHÔNG có gì đỏ: agent xanh, cổng xanh, PR gộp được. Chỉ có hàng
 * đợi `/tech` lặng lẽ nói sai, và nó nói sai theo hướng dễ tin — "việc vẫn đang chờ".
 *
 * ─── VÌ SAO KHÔNG GHI ĐÈ VÔ ĐIỀU KIỆN ───
 *
 * Cột này cũng là nơi NGƯỜI khai nhánh của mình (AGENTS.md mục 9: mỗi phiên một cây, một nhánh).
 * Một lượt chạy agent đè lên nhánh người đang làm thì phép chiếu PR của họ trỏ sang PR của agent
 * — cùng lớp với "máy không cãi người" của Nấc 4.
 *
 * Nên luật hẹp: máy chỉ ghi vào ô ĐANG RỖNG, hoặc đè lên chính nhánh của một lượt agent trước
 * (tiền tố `ai/`, do runner đặt). Mọi giá trị khác là lời khai của người và được GIỮ NGUYÊN —
 * lượt chạy vẫn còn nguyên nhánh của nó ở `tech_agent_runs.branch`, nên không mất gì cả.
 */

/** Tiền tố nhánh do runner agent đặt: `ai/<vai>/<MÃ VIỆC>-<hậu tố>`. Xem `lib/agents/workspace.ts`. */
export const TIEN_TO_NHANH_AGENT = "ai/";

export type BranchClaim =
  /** Ô rỗng hoặc đang giữ nhánh agent cũ ⇒ ghi. */
  | { ghi: true; nhanh: string; ly: string }
  /** Không ghi — và `ly` nói rõ vì sao, vì cả ba lý do đều BÌNH THƯỜNG, không phải lỗi. */
  | { ghi: false; ma: "KHONG_CO_NHANH" | "TRUNG" | "NGUOI_GIU"; ly: string };

/**
 * Lượt chạy này có được ghi nhánh của nó vào dòng việc không — HÀM THUẦN.
 *
 * Tách khỏi cửa chép sổ để mọi ca biên kiểm được mà không cần dựng CSDL: ô rỗng, trùng nhau, nhánh
 * agent cũ, nhánh người, và lượt chạy không đẩy nhánh nào.
 */
export function xetGhiNhanhViec(input: { hienTai: string | null | undefined; moi: string | null | undefined }): BranchClaim {
  const moi = (input.moi ?? "").trim();
  const hienTai = (input.hienTai ?? "").trim();

  /*
    Lượt chạy KHÔNG đẩy nhánh nào — thất bại sớm, hoặc không có gì để commit. Đây không phải lỗi,
    và tuyệt đối không được xoá nhánh đang có: một ô rỗng sẽ làm phép chiếu PR mù trở lại.
  */
  if (!moi) return { ghi: false, ma: "KHONG_CO_NHANH", ly: "Lượt chạy không đẩy nhánh nào — giữ nguyên ô hiện có." };
  if (hienTai === moi) return { ghi: false, ma: "TRUNG", ly: `Dòng việc đã trỏ đúng ${moi}.` };
  if (!hienTai) return { ghi: true, nhanh: moi, ly: `Ô nhánh đang rỗng — ghi ${moi} để phép chiếu PR ghép được.` };
  if (hienTai.startsWith(TIEN_TO_NHANH_AGENT)) {
    return { ghi: true, nhanh: moi, ly: `Thay nhánh agent cũ ${hienTai} bằng ${moi} — lượt chạy mới hơn thắng.` };
  }
  return {
    ghi: false,
    ma: "NGUOI_GIU",
    ly: `Dòng việc đang giữ nhánh ${hienTai} — không mang tiền tố ${TIEN_TO_NHANH_AGENT}, nên đó là lời khai của người và máy không đè. Nhánh của lượt chạy vẫn nằm ở sổ lượt chạy.`,
  };
}
