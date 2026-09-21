/**
 * ═══════════ SỔ LƯỢT CHẠY AGENT CÓ THỂ MẤT DÒNG — VÀ HÔM NAY KHÔNG AI BIẾT ═══════════
 *
 * Lượt chạy agent diễn ra trên máy GitHub Actions. Máy ấy KHÔNG nối được PostgreSQL production —
 * và giữ nguyên tính chất đó là chủ ý: *code chưa qua review không chạy cạnh CSDL production*.
 * Nên sổ đi về qua một cửa HTTP hẹp, và bước gửi sổ mang `continue-on-error: true`.
 *
 * Đó là một lựa chọn ĐÚNG — một lần ERP bận không được làm cả lượt chạy agent trông như hỏng.
 * Nhưng nó có cái giá mà tới hôm nay chưa ai trả: **một lượt chạy thành công có thể không bao giờ
 * xuất hiện trong sổ, và không có gì đỏ lên.** ERP không tự phát hiện được một gói tin chưa từng
 * tới (cùng lớp vấn đề với AGENTS.md mục 51) — chỗ hụt chỉ lộ ra khi một nguồn ĐỘC LẬP nói lại
 * cùng một sự việc. Ở đây nguồn độc lập là chính GitHub Actions.
 *
 * ─── ĐO THẬT, 21/09/2026 ───
 *
 * 12 lượt chạy `agent-run.yml` trên GitHub, 6 dòng trong sổ production. Đối chiếu từng lượt:
 *
 *   · 4 lượt `failure` (#1 #2 #3 #10) — hỏng ở bước kiểm khoá AI, agent CHƯA BAO GIỜ chạy. Không
 *     có dòng sổ là ĐÚNG, không phải mất.
 *   · 6 lượt `success` có đủ dòng sổ (#6 #7 #8 #9 #11 #12).
 *   · **2 lượt `success` KHÔNG có dòng sổ (#4 #5)** — công đã làm, bằng chứng đã mất.
 *
 * Hai lượt ấy chạy TRƯỚC khi cửa chép sổ với tới được. Mốc ấy đo được tới từng giây, và nó là lý
 * do hằng số dưới đây không phải một con số đoán.
 *
 * ─── VÌ SAO PHẢI CHIA ĐÔI THEO MỘT MỐC ───
 *
 * Cùng luật với AGENTS.md mục 62: dòng mất TRƯỚC khi cửa hoạt động là DI SẢN ĐÃ VÁ; dòng mất SAU
 * mốc ấy là lỗi CÒN ĐANG XẢY RA và phải bằng 0. Gộp hai bên lại thì con số "2 lượt mất" sẽ đứng
 * mãi ở đó, mỗi lần nhìn lại làm chủ shop tưởng cửa chép sổ đang hỏng — trong khi nó đã chạy đúng
 * suốt sáu lượt liên tiếp. Và tệ hơn: một lượt mất THẬT xảy ra tuần sau sẽ chìm vào con số cũ.
 */

/**
 * Mốc cửa chép sổ bắt đầu với tới được — **ĐO ĐƯỢC, không đoán**.
 *
 * Deploy #368 (PR #49 — middleware chặn cửa TRƯỚC khi phép kiểm khoá chạy) kết thúc lúc
 * `2026-09-20T12:35:20Z`. Lượt chạy agent #6 bắt đầu lúc `12:35:54Z` — **34 giây sau** — và nó là
 * dòng ĐẦU TIÊN từng có trong sổ production. Mọi lượt trước đó không có dòng nào.
 *
 * Không lấy mốc này từ dữ liệu (`min(started_at)` của chính sổ): làm thế thì mọi lượt mất trong
 * tương lai cũng tự thành "di sản" khi nó là lượt sớm nhất — một phép đo tự chứng minh mình đúng.
 */
export const LEDGER_LIVE_AT = new Date("2026-09-20T12:35:20Z");

export type LedgerCode =
  /** Có dòng sổ. Không phải việc phải làm. */
  | "CO_SO"
  /** Lượt chạy chưa kết thúc — chưa có dòng sổ là chuyện bình thường, cửa chỉ nhận lượt ĐÃ xong. */
  | "CHUA_XONG"
  /** Workflow hỏng trước khi agent chạy. KHÔNG có dòng sổ là ĐÚNG, không phải mất. */
  | "KHONG_CHAY"
  /** Mất dòng TRƯỚC khi cửa chép sổ hoạt động — di sản đã vá. */
  | "MAT_DI_SAN"
  /** Mất dòng SAU khi cửa hoạt động — lỗi CÒN ĐANG XẢY RA. Con số này phải bằng 0. */
  | "MAT_DANG_XAY_RA";

export type LedgerVerdict = { code: LedgerCode; ly: string };

/**
 * Một lượt chạy workflow có để lại dòng sổ đúng như phải có không — HÀM THUẦN.
 *
 * `coDongSo` do nơi gọi tra từ `tech_agent_runs` theo `external_ref`; hàm này không đọc CSDL, nên
 * nó kiểm được trọn vẹn mà không cần mạng và không cần hôm nay GitHub có lượt chạy nào.
 */
export function classifyAgentRunLedger(input: {
  /** `success` · `failure` · `cancelled` · … · `null` khi lượt chạy chưa kết thúc. */
  conclusion: string | null;
  createdAt: Date;
  coDongSo: boolean;
}): LedgerVerdict {
  if (input.coDongSo) return { code: "CO_SO", ly: "Có dòng trong sổ production." };

  /*
    CHƯA XONG ĐỨNG TRƯỚC MỌI PHÉP KIỂM KHÁC.

    `conclusion` của một lượt đang chạy là `null`, và `null` KHÔNG phải "không thành công". Xếp nó
    vào nhóm hỏng thì mỗi lần ai đó bấm chạy agent, phép đo này lại báo thêm một lượt "không chạy"
    — rồi nó tự biến mất sau mười phút. Một cảnh báo tự khỏi là một cảnh báo không ai đọc nữa.
  */
  if (!input.conclusion) return { code: "CHUA_XONG", ly: "Lượt chạy chưa kết thúc — cửa chép sổ chỉ nhận lượt ĐÃ xong." };

  /*
    HỎNG THÌ KHÔNG CÓ GÌ ĐỂ MẤT.

    4/12 lượt đo được hỏng ngay ở bước kiểm khoá AI: agent chưa chạy một vòng nào, không nhánh,
    không commit, không dòng sổ. Gọi đó là "mất sổ" là biến một lần thiếu credit thành một lỗi hạ
    tầng — và đẩy người đọc đi sửa nhầm chỗ (AGENTS.md mục 55).
  */
  if (input.conclusion !== "success") {
    return { code: "KHONG_CHAY", ly: `Workflow kết thúc “${input.conclusion}” — agent chưa chạy, không có dòng sổ là đúng.` };
  }

  if (input.createdAt.getTime() < LEDGER_LIVE_AT.getTime()) {
    return { code: "MAT_DI_SAN", ly: "Lượt chạy THÀNH CÔNG nhưng không có dòng sổ — chạy TRƯỚC khi cửa chép sổ với tới được (di sản đã vá)." };
  }
  return {
    code: "MAT_DANG_XAY_RA",
    ly: "Lượt chạy THÀNH CÔNG mà KHÔNG có dòng sổ, sau khi cửa chép sổ đã hoạt động — bằng chứng của một lượt chạy thật đã mất.",
  };
}

/*
  KHOÁ ĐỐI CHIẾU DÙNG LẠI `agentRunExternalRef` của cửa chép sổ — KHÔNG dựng lại ở đây.

  Hai nơi tự dựng cùng một khoá là hai nơi để chúng lệch nhau, và phép đối chiếu này chỉ có nghĩa
  khi nó so bằng ĐÚNG chuỗi mà cửa đã ghi. (`"07"` với `"7"` từng là hai khoá khác nhau cho cùng
  một lượt chạy — hàm kia đã học bài đó rồi, bài này không cần học lại.)
*/
export { agentRunExternalRef } from "@/lib/constants/agent-ingest";
