/**
 * ═══════════ NHÓM LÝ DO HOÀN THEO CHỨNG CỨ — NHÓM PHỤ THUỘC VÀO AI NÓI RA ═══════════
 *
 * ─── VẤN ĐỀ ĐÃ ĐO ĐƯỢC (20/10/2026, `ops reason-coverage`) ───
 *
 * 1.693 kiện hoàn xếp được lý do. Bảng nhóm cũ (`RETURN_REASON_GROUP_OF`) đặt
 * `CUSTOMER_UNREACHABLE` (702) và `CUSTOMER_RESCHEDULE_FAILED` (156) vào "Giao lâu", và
 * `CUSTOMER_REFUSED` (425) + `CUSTOMER_CHANGED_MIND` (287) vào "Cố ý boom hàng". Tức là:
 *
 *   · 858 ca "giao lâu" không có ca nào mang chứng cứ về THỜI GIAN — chúng là "gọi không được"
 *     và "hẹn lại không thành". Đi tới ĐVVC để sửa "giao lâu" là sửa nhầm chỗ.
 *   · 712 ca "boom" không có ca nào đã được người của shop xác minh — chúng là chữ bưu tá gõ
 *     "khách từ chối". Gọi một khách là "boom hàng" vì một câu bưu tá gõ vội là kết luận không
 *     có căn cứ, và hành động theo nó (đòi cọc, chặn khách) làm mất khách thật.
 *
 * ─── LUẬT: NHÓM LÀ HÀM CỦA (LÝ DO, NGUỒN), KHÔNG CHỈ CỦA LÝ DO ───
 *
 * Mỗi lý do khai HAI nhóm trong MỘT bảng (`REASON_EVIDENCE`): nhóm khi nguồn CÓ thẩm quyền kết
 * luận (`SOURCE_CAN_CONCLUDE_SHOP_FAULT` — người của shop, kho, ghi chú chăm sóc) và nhóm khi chỉ
 * có lời của bên ngoài (ĐVVC, Pancake). Hai nhóm trùng nhau với lý do là QUAN SÁT ("không liên
 * lạc được" thì ai nói cũng vậy); khác nhau với lý do là KẾT LUẬN về lỗi (chất lượng, size, boom,
 * sai hàng): chỉ có lời ĐVVC thì ca ấy là "khách từ chối — chưa rõ vì sao", một việc phải đi hỏi.
 *
 * Phòng ban (`department`) khai CÙNG dòng — không có bảng thứ hai để lệch nhau. Nó trả lời "đi
 * tới đâu để SỬA", không phải "ai CÓ LỖI" (AGENTS.md mục 24): nhóm chưa đủ căn cứ khai `null`.
 *
 * ─── KHOÁ LÝ DO KHÔNG ĐỔI (mục 37) ───
 *
 * Tệp này KHÔNG thêm, bớt hay đổi tên một lý do nào. Nó chỉ thêm một CÁCH ĐỌC mới lên trên chúng,
 * sau cờ `returns.reason-taxonomy` (mặc định `LEGACY` = số cũ). Bật/tắt là một dòng `settings`,
 * đảo ngược được, không ghi lại một dòng lịch sử nào.
 */
import type { DepartmentCode } from "@/lib/constants/departments";
import { RETURN_REASON_GROUP_ACTION, RETURN_REASON_GROUP_LABEL, RETURN_REASON_GROUPS, type ReturnReason, type ReturnReasonGroup } from "@/lib/constants/return-reason";
import { SOURCE_CAN_CONCLUDE_SHOP_FAULT, SOURCE_RANK, type ReasonSource } from "@/lib/constants/return-reason-source";

export const EVIDENCE_GROUPS = [
  "GIAO_CHAM_XAC_NHAN",
  "KHONG_LIEN_LAC",
  "KHACH_VANG_NHA",
  "HEN_LAI_THAT_BAI",
  "KHACH_TU_CHOI_CHUA_RO",
  "KHACH_DOI_Y",
  "BOM_DA_XAC_MINH",
  "CHAT_LUONG",
  "SAI_MAU",
  "SAI_SIZE",
  "SAI_HANG",
  "SAI_DIA_CHI_SDT",
  "LOI_DVVC",
  "SHOP_YEU_CAU_HOAN",
  "LY_DO_KHAC",
  "CHUA_XAC_DINH",
] as const;
export type EvidenceGroup = (typeof EVIDENCE_GROUPS)[number];

export const EVIDENCE_GROUP_LABEL: Record<EvidenceGroup, string> = {
  GIAO_CHAM_XAC_NHAN: "Giao chậm (đã xác nhận)",
  KHONG_LIEN_LAC: "Không liên lạc được khách",
  KHACH_VANG_NHA: "Khách vắng nhà",
  HEN_LAI_THAT_BAI: "Hẹn giao lại không thành",
  KHACH_TU_CHOI_CHUA_RO: "Khách từ chối — chưa rõ vì sao",
  KHACH_DOI_Y: "Khách đổi ý / hết nhu cầu",
  BOM_DA_XAC_MINH: "Boom hàng (đã xác minh)",
  CHAT_LUONG: "Chất lượng sản phẩm",
  SAI_MAU: "Không giống mẫu / ảnh",
  SAI_SIZE: "Sai size / không vừa",
  SAI_HANG: "Sai hàng / đóng sai / chốt sai",
  SAI_DIA_CHI_SDT: "Sai địa chỉ / số điện thoại",
  LOI_DVVC: "Lỗi đơn vị vận chuyển",
  SHOP_YEU_CAU_HOAN: "Shop yêu cầu hoàn",
  LY_DO_KHAC: "Lý do khác",
  CHUA_XAC_DINH: "Chưa xác định được",
};

/** Một câu: nhóm này sửa ở đâu. Nhóm chưa đủ căn cứ nói LỐI RA là đi hỏi, không chỉ ai. */
export const EVIDENCE_GROUP_ACTION: Record<EvidenceGroup, string> = {
  GIAO_CHAM_XAC_NHAN: "Đi tới ĐVVC và mốc bàn giao của kho — nhóm này CHỈ có ca người của shop xác nhận khách bỏ vì đợi lâu.",
  KHONG_LIEN_LAC: "Đi tới khâu xác nhận số điện thoại lúc chốt đơn và nhịp gọi của đội chăm sóc. KHÔNG phải giao chậm.",
  KHACH_VANG_NHA: "Hẹn khung giờ giao với khách trước khi bưu tá đi phát.",
  HEN_LAI_THAT_BAI: "Đội chăm sóc giữ hẹn: gọi lại đúng giờ khách hẹn, xin phát lại trước khi kiện bị hoàn.",
  KHACH_TU_CHOI_CHUA_RO: "CHƯA PHẢI MỘT NGUYÊN NHÂN. Chỉ có lời ĐVVC/hệ thống ngoài — gọi khách hỏi vì sao rồi ghi lý do.",
  KHACH_DOI_Y: "Rút ngắn thời gian từ chốt tới giao, gọi xác nhận trước khi gửi.",
  BOM_DA_XAC_MINH: "Chỉ ca người của shop đã xác minh. Xác nhận đơn kỹ / đặt cọc với khách có lịch sử boom.",
  CHAT_LUONG: "Đi tới nguồn hàng và khâu kiểm trước khi đóng gói.",
  SAI_MAU: "Đi tới ảnh/video trên trang bán: khách nhận hàng không giống thứ họ đã xem.",
  SAI_SIZE: "Đi tới bảng size và cách tư vấn chốt size.",
  SAI_HANG: "Đi tới khâu đóng gói và khâu xác nhận mẫu mã — xổ nhóm ra để thấy phần của kho và của sale.",
  SAI_DIA_CHI_SDT: "Đi tới khâu nhập đơn: kiểm địa chỉ và số điện thoại trước khi gửi.",
  LOI_DVVC: "Khiếu nại ĐVVC với mã vận đơn cụ thể.",
  SHOP_YEU_CAU_HOAN: "Quyết định của shop — xem lý do người duyệt hoàn đã ghi.",
  LY_DO_KHAC: "Mỗi lý do trong nhóm có chỗ sửa riêng — xổ nhóm ra để thấy.",
  CHUA_XAC_DINH: "KHÔNG phải một nguyên nhân: số ca chưa ai nói vì sao.",
};

/**
 * ═══ BẢNG ÁNH XẠ DUY NHẤT ═══
 *
 * `verified`   — nhóm khi nguồn có thẩm quyền kết luận (hoặc người xác nhận).
 * `unverified` — nhóm khi chỉ có lời ĐVVC / hệ thống ngoài.
 * `department` — phòng đi SỬA. `null` = chưa đủ căn cứ để chỉ một phòng.
 *
 * `Record<ReturnReason, …>` nên thêm một lý do mới mà quên khai ở đây là lỗi biên dịch.
 */
export const REASON_EVIDENCE: Record<ReturnReason, { verified: EvidenceGroup; unverified: EvidenceGroup; department: DepartmentCode | null }> = {
  QUALITY_POOR: { verified: "CHAT_LUONG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "PRODUCTION" },
  QUALITY_COLOR_BAD: { verified: "CHAT_LUONG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "PRODUCTION" },
  QUALITY_FABRIC_BAD: { verified: "CHAT_LUONG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "PRODUCTION" },
  QUALITY_SEWING_BAD: { verified: "CHAT_LUONG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "PRODUCTION" },
  QUALITY_FABRIC_HOT: { verified: "CHAT_LUONG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "PRODUCTION" },
  QUALITY_TOO_THICK: { verified: "CHAT_LUONG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "PRODUCTION" },
  QUALITY_FABRIC_THIN: { verified: "CHAT_LUONG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "PRODUCTION" },
  QUALITY_DEFECT: { verified: "CHAT_LUONG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "PRODUCTION" },
  // Khách nhận hàng không giống thứ đã xem trên ảnh — chỗ sửa là ảnh/video bán hàng.
  QUALITY_NOT_AS_PICTURED: { verified: "SAI_MAU", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "MARKETING" },
  QUALITY_LOOKS_BAD_ON: { verified: "SAI_MAU", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "MARKETING" },
  SIZE_TIGHT: { verified: "SAI_SIZE", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  SIZE_TIGHT_TOP: { verified: "SAI_SIZE", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  SIZE_TIGHT_BOTTOM: { verified: "SAI_SIZE", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  SIZE_LOOSE: { verified: "SAI_SIZE", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  SIZE_LOOSE_TOP: { verified: "SAI_SIZE", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  SIZE_LOOSE_BOTTOM: { verified: "SAI_SIZE", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  SIZE_SALES_ADVICE_WRONG: { verified: "SAI_SIZE", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  SIZE_DOES_NOT_FIT: { verified: "SAI_SIZE", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  /*
    GIAO CHẬM CHỈ KHI CÓ NGƯỜI XÁC NHẬN HOẶC CÓ CHỨNG CỨ THỜI GIAN. Không nguồn máy nào hôm nay sinh
    ra lý do này (không luật chữ ĐVVC, không mã ĐVVC nào trỏ tới nó) — nên vế `unverified` chỉ để
    đóng bảng cho đủ, và nó KHÔNG được là "giao chậm".
  */
  SLOW_DELIVERY: { verified: "GIAO_CHAM_XAC_NHAN", unverified: "LY_DO_KHAC", department: "LOGISTICS" },
  CUSTOMER_AWAY: { verified: "KHACH_VANG_NHA", unverified: "KHACH_VANG_NHA", department: "LOGISTICS" },
  BOOM_NO_REASON: { verified: "BOM_DA_XAC_MINH", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  BOOM_MULTIPLE_ATTEMPTS: { verified: "BOM_DA_XAC_MINH", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  CARRIER_NO_SUPPORT: { verified: "LOI_DVVC", unverified: "LOI_DVVC", department: "LOGISTICS" },
  WAREHOUSE_PACKED_WRONG: { verified: "SAI_HANG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "WAREHOUSE" },
  SALES_CONFIRMED_WRONG: { verified: "SAI_HANG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "SALES" },
  CANCELLED_BEFORE_SHIP: { verified: "LY_DO_KHAC", unverified: "LY_DO_KHAC", department: "SALES" },
  DUPLICATE_ORDER: { verified: "LY_DO_KHAC", unverified: "LY_DO_KHAC", department: "SALES" },
  CUSTOMER_REFUSED: { verified: "KHACH_TU_CHOI_CHUA_RO", unverified: "KHACH_TU_CHOI_CHUA_RO", department: null },
  // "Không liên lạc được" KHÔNG BAO GIỜ thành giao chậm — ai nói thì nó vẫn là chuyện gọi không được.
  CUSTOMER_UNREACHABLE: { verified: "KHONG_LIEN_LAC", unverified: "KHONG_LIEN_LAC", department: "SALES" },
  WRONG_PHONE: { verified: "SAI_DIA_CHI_SDT", unverified: "SAI_DIA_CHI_SDT", department: "SALES" },
  WRONG_ADDRESS: { verified: "SAI_DIA_CHI_SDT", unverified: "SAI_DIA_CHI_SDT", department: "SALES" },
  CUSTOMER_RESCHEDULE_FAILED: { verified: "HEN_LAI_THAT_BAI", unverified: "HEN_LAI_THAT_BAI", department: "LOGISTICS" },
  DELIVERY_ATTEMPTS_EXHAUSTED: { verified: "HEN_LAI_THAT_BAI", unverified: "HEN_LAI_THAT_BAI", department: "LOGISTICS" },
  CUSTOMER_CHANGED_MIND: { verified: "KHACH_DOI_Y", unverified: "KHACH_DOI_Y", department: "SALES" },
  SHOP_REQUESTED_RETURN: { verified: "SHOP_YEU_CAU_HOAN", unverified: "SHOP_YEU_CAU_HOAN", department: "LOGISTICS" },
  // ĐVVC ghi "hư hỏng" / "sai màu" là lời khách nói với bưu tá — chưa ai của shop mở kiện ra xem.
  DAMAGED: { verified: "CHAT_LUONG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "WAREHOUSE" },
  WRONG_ITEM: { verified: "SAI_HANG", unverified: "KHACH_TU_CHOI_CHUA_RO", department: "WAREHOUSE" },
  CARRIER_EXCEPTION: { verified: "LOI_DVVC", unverified: "LOI_DVVC", department: "LOGISTICS" },
  OTHER: { verified: "LY_DO_KHAC", unverified: "LY_DO_KHAC", department: null },
  UNKNOWN: { verified: "CHUA_XAC_DINH", unverified: "CHUA_XAC_DINH", department: null },
};

/** Nhóm đòi nguồn có thẩm quyền — dẫn xuất từ bảng, không khai lần hai. */
export const AUTHORITY_REQUIRED_GROUPS: readonly EvidenceGroup[] = [
  ...new Set(Object.values(REASON_EVIDENCE).filter((m) => m.verified !== m.unverified).map((m) => m.verified)),
];

/**
 * Phòng của một nhóm, dẫn xuất từ CÙNG bảng: mọi lý do trong nhóm chỉ cùng một phòng ⇒ phòng đó;
 * khác nhau (sai hàng: kho đóng sai · sale chốt sai) ⇒ `null`, xổ nhóm ra mới thấy.
 */
export function evidenceGroupDepartment(g: EvidenceGroup): DepartmentCode | null {
  const phong = new Set(Object.values(REASON_EVIDENCE).filter((m) => m.verified === g || m.unverified === g).map((m) => (m.verified === g ? m.department : null)));
  return phong.size === 1 ? [...phong][0] : null;
}

/* ═══════════ BẬC CHỨNG CỨ — TÍNH LÚC ĐỌC, KHÔNG CỘT MỚI, KHÔNG BACKFILL ═══════════ */

export const EVIDENCE_TIERS = ["HUMAN_CONFIRMED", "CARE_REPORTED", "CARRIER_OBSERVED", "CONFLICTED", "UNKNOWN"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

export const EVIDENCE_TIER_LABEL: Record<EvidenceTier, string> = {
  HUMAN_CONFIRMED: "Người của shop xác nhận",
  CARE_REPORTED: "Nhân viên ghi nhận (chưa xác nhận)",
  CARRIER_OBSERVED: "Chỉ có lời ĐVVC / hệ thống ngoài",
  CONFLICTED: "Các nguồn nói khác nhau",
  UNKNOWN: "Chưa có chứng cứ",
};

/**
 * HỌ NGUỒN. Hai quan sát CÙNG họ nói khác nhau là lời khai đổi theo thời gian (bưu tá ghi "không
 * liên lạc được" rồi hôm sau "khách từ chối") — cái muộn hơn thắng, không phải mâu thuẫn. Mâu thuẫn
 * chỉ có khi hai HỌ khác nhau nói hai nhóm khác nhau.
 */
const FAMILY_OF: Record<ReasonSource, "HUMAN" | "WAREHOUSE" | "CARE" | "CARRIER" | "PANCAKE"> = {
  HUMAN_CONFIRMED: "HUMAN",
  WAREHOUSE_INSPECTION: "WAREHOUSE",
  CARE_NOTE: "CARE",
  CS_NOTE: "CARE",
  CARRIER_CODE: "CARRIER",
  CARRIER_TEXT: "CARRIER",
  PANCAKE_RETURN: "PANCAKE",
  PANCAKE_ORDER_NOTE: "PANCAKE",
};

/** Một lời khai đã xếp được lý do. `at` là mốc của chính sự việc (ms). */
export type ReasonEvidenceItem = { source: ReasonSource; reason: ReturnReason; at: number };

export type EvidenceOptions = {
  /**
   * CHỨNG CỨ THỜI GIAN cho lời khai "giao chậm" của nguồn không có thẩm quyền. `true` = đo được
   * kiện thật sự đi quá hạn; `false`/`null` = không / chưa đo. Hôm nay không nguồn máy nào sinh
   * `SLOW_DELIVERY` nên nơi gọi chưa cần nối phép đo; vế này đứng sẵn để ngày đó không phải đoán.
   */
  slowByTime?: boolean | null;
  /** Ghi đè nhóm đã CHUYỂN từ bảng cũ (`transitionGroupOverrides`) — chỉ áp cho vế `verified`. */
  overrides?: Partial<Record<ReturnReason, EvidenceGroup>>;
};

/**
 * Nhóm của MỘT lời khai. Vế `unverified` không bao giờ bị ghi đè: một lượt sửa nhóm của chủ shop
 * không được kéo lời ĐVVC vào một nhóm quy lỗi.
 */
export function evidenceGroupOf(reason: ReturnReason, source: ReasonSource, opts: EvidenceOptions = {}): EvidenceGroup {
  const m = REASON_EVIDENCE[reason];
  const coThamQuyen = SOURCE_CAN_CONCLUDE_SHOP_FAULT[source] || (reason === "SLOW_DELIVERY" && opts.slowByTime === true);
  if (!coThamQuyen) return m.unverified;
  return opts.overrides?.[reason] ?? m.verified;
}

export type EvidenceVerdict = {
  /** Nguyên nhân CHÍNH — một đơn một nguyên nhân chính. `null` = không có lời khai nào xếp được. */
  primary: (ReasonEvidenceItem & { group: EvidenceGroup }) | null;
  /** Nguyên nhân PHỤ: lời khai của HỌ NGUỒN KHÁC nói nhóm khác — GIỮ LẠI, không xoá. */
  secondary: (ReasonEvidenceItem & { group: EvidenceGroup })[];
  tier: EvidenceTier;
};

const hon = (a: ReasonEvidenceItem, b: ReasonEvidenceItem | undefined) => !b || SOURCE_RANK[a.source] > SOURCE_RANK[b.source] || (SOURCE_RANK[a.source] === SOURCE_RANK[b.source] && a.at >= b.at);

/**
 * ═══ MỘT ĐƠN, MỘT NGUYÊN NHÂN CHÍNH — HÀM THUẦN ═══
 *
 *   1. Có người xác nhận ⇒ lời người MUỘN NHẤT là chính, bậc `HUMAN_CONFIRMED`. Lời các nguồn khác
 *      nói khác vẫn nằm ở `secondary`: người thắng, nhưng không xoá chứng từ.
 *   2. Không có người: lấy lời mạnh nhất của từng HỌ NGUỒN (hạng cao thắng, bằng hạng thì muộn hơn).
 *      Tất cả cùng một nhóm ⇒ bậc theo nguồn của lời chính.
 *   3. Khác nhóm: nếu lời chính đến từ nguồn CÓ THẨM QUYỀN và nói một KẾT LUẬN chỉ nó được nói
 *      (chất lượng, size, boom…) ⇒ nó thắng, bậc `CARE_REPORTED`. Còn lại ⇒ `CONFLICTED`: vẫn có
 *      một nguyên nhân chính để đếm (cộng các nhóm luôn bằng tổng ca hoàn), nhưng màn hình phải nói
 *      rằng các nguồn đang nói khác nhau.
 *
 * Lời khai `UNKNOWN` không tham gia: một ghi chú chăm sóc "đã gọi lần 2" không đè được gì.
 */
export function resolveEvidence(items: readonly ReasonEvidenceItem[], opts: EvidenceOptions = {}): EvidenceVerdict {
  const dung = items.filter((i) => i.reason !== "UNKNOWN");
  if (!dung.length) return { primary: null, secondary: [], tier: "UNKNOWN" };
  const kem = (i: ReasonEvidenceItem) => ({ ...i, group: evidenceGroupOf(i.reason, i.source, opts) });

  const theoHo = new Map<string, ReasonEvidenceItem>();
  for (const i of dung) {
    const ho = FAMILY_OF[i.source];
    if (hon(i, theoHo.get(ho))) theoHo.set(ho, i);
  }
  const ungVien = [...theoHo.values()].map(kem);
  let chinh = ungVien[0];
  for (const u of ungVien) if (hon(u, chinh)) chinh = u;
  const phu = ungVien.filter((u) => u !== chinh && u.group !== chinh.group);

  if (chinh.source === "HUMAN_CONFIRMED") return { primary: chinh, secondary: phu, tier: "HUMAN_CONFIRMED" };
  const coThamQuyen = SOURCE_CAN_CONCLUDE_SHOP_FAULT[chinh.source];
  const tierNguon: EvidenceTier = coThamQuyen ? "CARE_REPORTED" : "CARRIER_OBSERVED";
  if (!phu.length) return { primary: chinh, secondary: [], tier: tierNguon };
  if (coThamQuyen && AUTHORITY_REQUIRED_GROUPS.includes(chinh.group)) return { primary: chinh, secondary: phu, tier: "CARE_REPORTED" };
  return { primary: chinh, secondary: phu, tier: "CONFLICTED" };
}

/* ═══════════ CHUYỂN GHI ĐÈ NHÓM CŨ SANG NHÓM MỚI — TƯỜNG MINH ═══════════ */

/**
 * Nhóm cũ → nhóm mới, CHỈ khi nghĩa không đổi. "Giao lâu" và "Cố ý boom" cũ gộp quan sát với kết
 * luận, nên không có một nhóm mới nào đúng nghĩa với chúng: ghi đè trỏ tới hai nhóm ấy KHÔNG được
 * dịch tự động mà phải hiện ra màn hình để chủ shop xếp lại.
 */
export const LEGACY_GROUP_TRANSITION: Record<ReturnReasonGroup, EvidenceGroup | null> = {
  QUALITY: "CHAT_LUONG",
  SIZE: "SAI_SIZE",
  SLOW: null,
  BOOM: null,
  OTHER: "LY_DO_KHAC",
  UNKNOWN: "CHUA_XAC_DINH",
};

export function transitionGroupOverrides(old: Partial<Record<ReturnReason, ReturnReasonGroup>>): {
  applied: Partial<Record<ReturnReason, EvidenceGroup>>;
  unmappable: { reason: ReturnReason; legacyGroup: ReturnReasonGroup }[];
} {
  const applied: Partial<Record<ReturnReason, EvidenceGroup>> = {};
  const unmappable: { reason: ReturnReason; legacyGroup: ReturnReasonGroup }[] = [];
  for (const [r, g] of Object.entries(old) as [ReturnReason, ReturnReasonGroup][]) {
    const moi = LEGACY_GROUP_TRANSITION[g];
    if (moi) applied[r] = moi;
    else unmappable.push({ reason: r, legacyGroup: g });
  }
  return { applied, unmappable };
}

/* ═══════════ CỜ CHUYỂN CÁCH ĐỌC ═══════════ */

export const REASON_TAXONOMY_KEY = "returns.reason-taxonomy";
export const REASON_TAXONOMIES = ["LEGACY", "EVIDENCE"] as const;
export type ReasonTaxonomy = (typeof REASON_TAXONOMIES)[number];

/** Giá trị lạ / thiếu ⇒ `LEGACY`: mọi nhánh lỗi rơi về cách đọc đang chạy, không về cách mới. */
export function parseReasonTaxonomy(v: unknown): ReasonTaxonomy {
  return v === "EVIDENCE" ? "EVIDENCE" : "LEGACY";
}

/* ═══════════ MỘT CÁCH XẾP NHÓM CHO MỘT LƯỢT ĐỌC — BẢNG, DRILLDOWN, MÀN HÌNH ═══════════ */

export type ReasonGroupKey = ReturnReasonGroup | EvidenceGroup;

export type ReasonGrouping = {
  taxonomy: ReasonTaxonomy;
  /** Nhóm hiện trên bảng, theo thứ tự in. KHÔNG có nhóm chỗ trống (UNKNOWN / CHUA_XAC_DINH). */
  groups: { key: ReasonGroupKey; label: string; action: string; department: DepartmentCode | null }[];
  /** Nhóm của MỘT ca. `null` = chỗ trống (chưa xác định) — nó đi vào ô độ phủ, không vào bảng nhóm. */
  groupOf: (v: { reason: ReturnReason; items: readonly ReasonEvidenceItem[] }) => ReasonGroupKey | null;
  /** Bậc chứng cứ của MỘT ca — cùng hàm với `groupOf`, nên ô bậc và ô nhóm không lệch nhau. */
  tierOf: (v: { items: readonly ReasonEvidenceItem[] }) => EvidenceTier;
  /** Câu phải hiện ra màn hình (ghi đè không chuyển được). Rỗng = không có gì phải báo. */
  notes: string[];
};

export function isReasonGroupKey(s: string): s is ReasonGroupKey {
  return (RETURN_REASON_GROUPS as readonly string[]).includes(s) || (EVIDENCE_GROUPS as readonly string[]).includes(s);
}

/**
 * Dựng cách xếp nhóm cho một lượt đọc. HÀM THUẦN: cờ và ghi đè do nơi gọi đọc từ `settings` rồi
 * truyền vào, nên kiểm được không cần CSDL.
 *
 * `legacyTable` là `reasonGroupTable(ghi đè)` — truyền vào thay vì dựng ở đây để tệp này không phải
 * biết bảng ghi đè cũ được dọn thế nào.
 */
export function buildReasonGrouping(
  taxonomy: ReasonTaxonomy,
  legacyTable: Record<ReturnReason, ReturnReasonGroup>,
  legacyOverrides: Partial<Record<ReturnReason, ReturnReasonGroup>>,
): ReasonGrouping {
  const tierOf = (v: { items: readonly ReasonEvidenceItem[] }) => resolveEvidence(v.items).tier;
  if (taxonomy === "LEGACY") {
    return {
      taxonomy,
      groups: RETURN_REASON_GROUPS.filter((g) => g !== "UNKNOWN").map((g) => ({ key: g, label: RETURN_REASON_GROUP_LABEL[g], action: RETURN_REASON_GROUP_ACTION[g], department: null })),
      groupOf: (v) => (v.reason === "UNKNOWN" ? null : legacyTable[v.reason]),
      tierOf,
      notes: [],
    };
  }
  const { applied, unmappable } = transitionGroupOverrides(legacyOverrides);
  return {
    taxonomy,
    groups: EVIDENCE_GROUPS.filter((g) => g !== "CHUA_XAC_DINH").map((g) => ({ key: g, label: EVIDENCE_GROUP_LABEL[g], action: EVIDENCE_GROUP_ACTION[g], department: evidenceGroupDepartment(g) })),
    groupOf: (v) => {
      if (v.reason === "UNKNOWN") return null;
      const g = resolveEvidence(v.items, { overrides: applied }).primary?.group ?? null;
      return g === "CHUA_XAC_DINH" ? null : g;
    },
    tierOf,
    notes: unmappable.map(
      (u) => `Ghi đè cũ “${u.reason} → ${RETURN_REASON_GROUP_LABEL[u.legacyGroup]}” KHÔNG chuyển được sang cách xếp theo chứng cứ (nhóm cũ gộp quan sát với kết luận) — lý do này đang theo bảng mặc định; xếp lại nếu cần.`,
    ),
  };
}

/**
 * Ô CHỌN LÝ DO trên trang vận đơn, xếp theo CÁCH XẾP ĐANG BẬT. Bản trước dựng từ bảng tĩnh
 * `RETURN_REASON_GROUP_OF` trong client component — chủ shop đổi nhóm (hay bật cách xếp mới) thì
 * bảng báo cáo đổi mà ô chọn vẫn xếp theo cách cũ. Mỗi lý do đứng ở nhóm nó sẽ vào khi NGƯỜI xác
 * nhận — đúng thứ người bấm sắp tạo ra.
 */
export function reasonPickerGroups(grouping: ReasonGrouping, reasons: readonly ReturnReason[]): { key: ReasonGroupKey; label: string; reasons: ReturnReason[] }[] {
  return grouping.groups
    .map((g) => ({
      key: g.key,
      label: g.label,
      // UNKNOWN và OTHER là chỗ TRỐNG, không phải lựa chọn — chọn chúng là ghi lại một cái không biết.
      reasons: reasons.filter((r) => r !== "UNKNOWN" && r !== "OTHER" && grouping.groupOf({ reason: r, items: [{ source: "HUMAN_CONFIRMED", reason: r, at: 0 }] }) === g.key),
    }))
    .filter((g) => g.reasons.length);
}
