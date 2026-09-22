/**
 * ═══════════ CÂU LỖI CỦA CỔNG ĐỎ — ĐỌC ĐƯỢC NGAY TRONG ERP ═══════════
 *
 * ─── VÌ SAO ───
 *
 * Sổ lượt chạy trước đây ghi đúng hai thứ về một lượt hỏng: câu `"Có cổng kiểm thử ĐỎ."` và bốn
 * huy hiệu cổng. Người xem biết `typecheck` đỏ nhưng KHÔNG biết đỏ vì gì — nên câu hỏi *"sửa cái
 * gì"* chỉ trả lời được bằng cách rời ERP, mở log GitHub Actions, và phải có quyền vào kho mã.
 * Chủ shop không có đường nào đi tới đó.
 *
 * Một hàng rào báo ĐỎ mà không nói vì sao thì người ta không đi sửa nguyên nhân — họ đi tìm cách
 * tắt hàng rào. Đó là cùng một bài học với `AGENTS.md` mục 50.
 *
 * ─── BA TRẠNG THÁI, BA CÁCH IN (mục 42) ───
 *
 *  · có câu lỗi                     → in ra
 *  · cổng ĐỎ nhưng KHÔNG có câu lỗi → "CHƯA GHI ĐƯỢC" (lượt chạy trước bản vá này)
 *  · không cổng nào đỏ              → không có gì để in
 *
 * Gộp hai trạng thái đầu là để một lượt HỎNG hiện ra như một lượt sạch. Lượt cũ KHÔNG được
 * backfill (mục 8.8): chúng chạy trước khi đường ghi tồn tại và phải hiện đúng như vậy.
 *
 * ─── VỀ SECRET ───
 *
 * Đầu ra bốn cổng đi thẳng vào CSDL rồi lên màn hình, nên câu hỏi "có lộ secret không" là câu
 * phải trả lời chứ không phải câu bỏ qua. Câu trả lời: `gates` chạy bộ kiểm thử với **token giả**
 * theo đúng mục 65 — kho PUBLIC nên bộ kiểm thử không bao giờ cầm khoá thật. Nghĩa là trong tiến
 * trình sinh ra mấy dòng này KHÔNG có secret thật để mà lộ. Ở đây cố ý KHÔNG dựng một bộ che token:
 * một bộ che bắt được `ghp_` rồi bỏ sót mọi dạng khác còn nguy hiểm hơn không có, vì người ta thôi
 * đọc kỹ (cùng lý lẽ với đoạn tự khai giới hạn ở `lib/constants/agent-scopes.ts`).
 */

/**
 * Cắt bao nhiêu cho mỗi cổng, và cắt Ở ĐÂU.
 *
 * `tyLeDau` là phần giữ lại từ ĐẦU. Giữ mỗi đuôi là đánh mất lỗi `tsc` THỨ NHẤT — thứ thường là
 * nguyên nhân, còn bốn chục lỗi sau nó chỉ là dây chuyền. Giữ mỗi đầu thì mất khẳng định vừa gãy
 * của `npm test`, vốn nằm ở cuối. Nên giữ CẢ HAI, và nói rõ phần giữa đã rơi.
 */
export const CAT_LOI_CONG = { moiCong: 2_000, tyLeDau: 0.6 } as const;

export const DAU_CAT = "⋯ ⚠ PHẦN GIỮA ĐÃ CẮT";

export type LoiCong = { ten: string; exitCode: number | null; dauRa: string };

/** Cắt đầu ra một cổng cho vừa sổ — giữ ĐẦU và ĐUÔI, nói rõ đã rơi bao nhiêu. HÀM THUẦN. */
export function catDauRa(s: string, tran: number = CAT_LOI_CONG.moiCong): string {
  const t = s.trimEnd();
  if (t.length <= tran) return t;
  const dau = Math.floor(tran * CAT_LOI_CONG.tyLeDau);
  const duoi = tran - dau;
  const roi = t.length - tran;
  return `${t.slice(0, dau)}\n${DAU_CAT} ${roi.toLocaleString("vi-VN")} ký tự ⋯\n${t.slice(-duoi)}`;
}

export type LoiCongDocRa =
  | { kind: "CO"; ds: LoiCong[] }
  /** Cổng đỏ mà sổ không có câu lỗi — lượt chạy trước bản vá. KHÁC HẲN "không có lỗi". */
  | { kind: "CHUA_GHI" }
  | { kind: "KHONG_DO" };

const MOT_LOI = (v: unknown): LoiCong | null => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.ten !== "string" || !o.ten) return null;
  const ra = typeof o.dauRa === "string" ? o.dauRa : "";
  const ma = typeof o.exitCode === "number" && Number.isFinite(o.exitCode) ? o.exitCode : null;
  return { ten: o.ten, exitCode: ma, dauRa: ra };
};

/**
 * Đọc câu lỗi từ `metadata` của một dòng lượt chạy — HÀM THUẦN, chịu được dữ liệu cũ.
 *
 * `coCongDo` là câu hỏi ĐỘC LẬP, lấy từ bốn cột kết quả cổng chứ không suy từ chính `metadata`:
 * đó mới là thứ phân biệt "lượt sạch" với "lượt hỏng mà chưa ghi được lỗi".
 */
export function docLoiCong(metadata: unknown, coCongDo: boolean): LoiCongDocRa {
  /*
    `metadata` là cột `jsonb`: nó có thể là CHUỖI, SỐ hay mảng chứ không chỉ là đối tượng, và toán
    tử `in` NÉM LỖI trên những giá trị ấy. Một trang việc sập vì một dòng sổ lạ là cái giá quá đắt
    cho một khối phụ — đã cắn thật một lần ở `docChiPhiLuot`.
  */
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const m = metadata as Record<string, unknown>;
    if (Array.isArray(m.loiCong)) {
      const ds = m.loiCong.map(MOT_LOI).filter((x): x is LoiCong => x !== null);
      if (ds.length) return { kind: "CO", ds };
    }
  }
  return coCongDo ? { kind: "CHUA_GHI" } : { kind: "KHONG_DO" };
}

/** Câu giải thích cho trạng thái CHƯA GHI ĐƯỢC — hiện thẳng cho người đọc, không giấu. */
export const CAU_CHUA_GHI =
  "Cổng đỏ nhưng sổ không giữ câu lỗi — lượt chạy này có trước bản vá 22/09/2026. Phải mở log GitHub Actions. Lượt cũ KHÔNG được điền bù (mục 8.8).";

/**
 * Có cổng nào ĐỎ không — đọc từ BỐN CỘT KẾT QUẢ, không suy từ `metadata`.
 *
 * Tách ra khỏi `docLoiCong` vì đây là câu hỏi độc lập, và chính nó phân biệt "lượt sạch" với
 * "lượt hỏng mà sổ chưa giữ được câu lỗi". Suy ngược từ `metadata` thì hai ca ấy nhập làm một.
 */
export function coCongDo(g: { typecheckResult: string; lintResult: string; testResult: string; buildResult: string }): boolean {
  return [g.typecheckResult, g.lintResult, g.testResult, g.buildResult].includes("FAILED");
}
