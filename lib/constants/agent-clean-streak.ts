/**
 * ═══════════ CHUỖI LƯỢT CHẠY SẠCH — TIÊU CHÍ MỞ NẤC TIẾP THEO, THÀNH MỘT CON SỐ ═══════════
 *
 * `lib/constants/agent-scopes.ts` khai từ đầu rằng vai QA (ghi được `tests/`) chỉ bật sau
 * *"5 lượt chạy sạch liên tiếp"*. Tới 23/09/2026 câu ấy chỉ là MỘT DÒNG CHÚ THÍCH. Không ai đếm.
 * Một tiêu chí không ai đo thì không bao giờ được thoả — và cũng không bao giờ bị vi phạm một cách
 * lộ ra được. Nó là trang trí.
 *
 * Tệp này biến câu ấy thành một phép đếm, và mỗi luật đếm dưới đây là một QUYẾT ĐỊNH có lý do.
 *
 * ─── "SẠCH" LÀ PHÁN QUYẾT CỦA NGƯỜI REVIEW, KHÔNG PHẢI CỦA CỔNG ───
 *
 * Bốn cổng xanh KHÔNG có nghĩa là sạch. Đo được 23/09: đặc tả TECH-10 xếp ưu tiên #1 sai và tính
 * sai một phép nhân, vẫn qua cả bốn cổng. Cổng bắt được thứ HỎNG, không bắt được thứ SAI. Nên
 * "sạch" chỉ tồn tại khi một người đã review và không tìm ra gì phải sửa.
 *
 * ─── LƯỢT SỬA KHÔNG ĐƯỢC TÍNH ───
 *
 * Lượt chạy lại theo phản hồi review làm đúng điều người ta vừa chỉ ra — đó là làm theo chỉ dẫn,
 * không phải giao được việc sạch. Tính nó vào chuỗi thì chuỗi thổi phồng được bằng cách chạy lại:
 * một việc có lỗi, sửa ba lần, ra ba lượt "sạch". Lượt sửa không cộng, cũng không cắt chuỗi.
 *
 * ─── KHÔNG PHẠT LỐI RA TRUNG THỰC ───
 *
 * `BLOCKED` = agent khai không làm được ở môi trường này (`khong_lam_duoc`). Nếu nó cắt chuỗi thì
 * hệ thống thưởng cho việc CỐ làm thay vì nói thật — đúng điều lối ra ấy sinh ra để chặn (lượt
 * chạy TECH-5 #39 đã bịa số vì không có lối ra). `CANCELLED` là bị cắt từ bên ngoài. Cả hai không
 * phải một lần giao hàng: không cộng, không cắt.
 *
 * ─── CHƯA REVIEW KHÔNG PHẢI SẠCH ───
 *
 * Mục 42: chưa biết không được in thành một con số. Lượt mới nhất chưa ai review thì đếm RIÊNG
 * (`choReview`) và chuỗi tính từ dưới nó. Nhưng một lượt chưa review nằm GIỮA các lượt đã review
 * thì cắt chuỗi: không ai chứng minh được đoạn liên tiếp ấy.
 */

/** Hai phán quyết. `null` ở CSDL = CHƯA REVIEW — không phải một giá trị thứ ba được chọn. */
export const REVIEW_VERDICTS = ["SACH", "CO_LOI"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  SACH: "Sạch",
  CO_LOI: "Có lỗi",
};

/**
 * Ngưỡng mở vai QA. Trước đây chỉ sống trong một câu chú thích ở `agent-scopes.ts`; nay là một
 * hằng số để màn hình và bài kiểm đọc CÙNG một con số.
 */
export const NGUONG_MO_QA = 5;

/** Lỗi phải nói ra là lỗi gì — một phán quyết "có lỗi" không kèm lý do thì không ai học được gì. */
export const DO_DAI_TOI_THIEU_GHI_CHU_LOI = 10;

export type LuotChoChuoi = {
  id: string;
  taskId: string | null;
  branch: string;
  status: string;
  startedAt: Date;
  reviewVerdict: ReviewVerdict | null;
};

/**
 * Lượt SỬA = đã có một lượt chạy TRƯỚC nó, cùng việc, cùng nhánh.
 *
 * Suy ra lúc đọc, không cần thêm cột: cửa chép sổ về production (`/api/tech/agent-run`) nhận một
 * danh sách trường ĐÓNG và không mang cờ "đây là lượt chạy lại". Nhánh thì có — và lượt chạy lại
 * luôn làm việc trên chính nhánh đã có.
 *
 * Nhánh rỗng hay việc rỗng thì KHÔNG coi là lượt sửa: thiếu căn cứ thì không kết luận.
 */
export function danhDauLuotSua(runs: readonly LuotChoChuoi[]): Set<string> {
  const theoKhoa = new Map<string, LuotChoChuoi[]>();
  for (const r of runs) {
    if (!r.taskId || !r.branch) continue;
    const k = `${r.taskId}\u0000${r.branch}`;
    const ds = theoKhoa.get(k) ?? [];
    ds.push(r);
    theoKhoa.set(k, ds);
  }
  const sua = new Set<string>();
  for (const ds of theoKhoa.values()) {
    const sap = [...ds].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    for (const r of sap.slice(1)) sua.add(r.id);
  }
  return sua;
}

export type ChuoiSach = {
  /** Số lượt SẠCH liên tiếp tính từ lượt mới nhất ĐÃ review. */
  chuoi: number;
  /** Số lượt mới nhất đã giao nhưng CHƯA ai review — đếm riêng, không phải 0 và không phải sạch. */
  choReview: number;
  /** Chuỗi dừng ở đâu: một lượt có lỗi, một lượt hỏng, một lượt chưa review ở giữa, hay hết lịch sử. */
  dungVi: "CO_LOI" | "HONG" | "CHUA_REVIEW_O_GIUA" | "HET_LICH_SU";
  datNguong: boolean;
};

/**
 * Hàm THUẦN. Nhận các lượt chạy của MỘT vai, trả về chuỗi sạch hiện tại.
 */
export function chuoiSach(runs: readonly LuotChoChuoi[]): ChuoiSach {
  const sua = danhDauLuotSua(runs);
  const tinh = runs
    .filter((r) => !sua.has(r.id))
    .filter((r) => r.status !== "RUNNING" && r.status !== "BLOCKED" && r.status !== "CANCELLED")
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  let i = 0;
  let choReview = 0;
  while (i < tinh.length && tinh[i].status === "SUCCEEDED" && tinh[i].reviewVerdict === null) {
    choReview += 1;
    i += 1;
  }

  let chuoi = 0;
  let dungVi: ChuoiSach["dungVi"] = "HET_LICH_SU";
  for (; i < tinh.length; i += 1) {
    const r = tinh[i];
    if (r.status !== "SUCCEEDED") {
      dungVi = "HONG";
      break;
    }
    if (r.reviewVerdict === "SACH") {
      chuoi += 1;
      continue;
    }
    dungVi = r.reviewVerdict === "CO_LOI" ? "CO_LOI" : "CHUA_REVIEW_O_GIUA";
    break;
  }
  return { chuoi, choReview, dungVi, datNguong: chuoi >= NGUONG_MO_QA };
}

export const DUNG_VI_LABEL: Record<ChuoiSach["dungVi"], string> = {
  CO_LOI: "dừng ở một lượt có lỗi",
  HONG: "dừng ở một lượt hỏng",
  CHUA_REVIEW_O_GIUA: "dừng ở một lượt chưa ai review",
  HET_LICH_SU: "chưa có lượt nào cắt chuỗi",
};
