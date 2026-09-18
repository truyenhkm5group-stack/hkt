/**
 * ═══════════ MÁY XẾP RỦI RO — LUẬT, KHÔNG PHẢI CẢM TÍNH ═══════════
 *
 * Phase 1 cố ý KHÔNG dùng AI để xếp rủi ro. Một bộ phân loại bằng mô hình không giải thích được vì
 * sao nó xếp một việc vào R0, và thứ không giải thích được thì không ai dám dùng nó làm cổng phê
 * duyệt. Luật ở đây thì đọc được, kiểm thử được, và cãi lại được.
 *
 * ─── HAI NGUYÊN TẮC ───
 *
 * 1. **LUẬT CHỈ NÂNG, KHÔNG BAO GIỜ HẠ.** Mỗi luật khớp thì kéo mức rủi ro LÊN mức nó khai. Không
 *    luật nào hạ được mức của luật khác — cùng lý do `effectivePriority` ở `lib/work/escalation.ts`
 *    chỉ nâng: mọi nhánh sai phải rơi về phía AN TOÀN HƠN.
 * 2. **NGƯỜI ĐÈ ĐƯỢC, NHƯNG PHẢI KÝ TÊN.** Chủ shop / quản trị đổi được mức rủi ro, và lượt đổi đó
 *    bắt buộc có LÝ DO, vào `audit_logs` và vào nhật ký việc. Một cổng không đè được là một cổng bị
 *    người ta đi vòng; một cổng đè được mà không để lại vết là một cổng không tồn tại.
 *
 * Tệp này CLIENT-SAFE và hàm `classifyTechRisk` là hàm THUẦN: cùng đầu vào ra cùng kết quả, không
 * đọc CSDL, không đọc đồng hồ.
 */
import { TECH_MODULE_LABEL, type TechModule, type TechRisk, type TechTaskType } from "@/lib/constants/tech";

export type TechRiskRule = {
  key: string;
  label: string;
  /** Vì sao chạm vào đây là rủi ro — câu này hiện thẳng trên màn hình, không phải chú thích nội bộ. */
  why: string;
  risk: TechRisk;
  modules?: readonly TechModule[];
  taskTypes?: readonly TechTaskType[];
  /** Từ khoá trong tiêu đề / mô tả (không dấu, thường). Chỉ để BẮT THÊM, không để hạ mức. */
  keywords?: readonly string[];
};

/**
 * MƯỜI BA LUẬT R2. Danh sách này là bản dịch trực tiếp của `AGENTS.md` mục 0 và mục 7 sang dạng
 * máy đọc được: những chỗ mà một lần sửa sai làm đổi một con số chủ shop dùng để ra quyết định,
 * hoặc mở ra một cánh cửa quyền.
 */
export const TECH_RISK_RULES: readonly TechRiskRule[] = [
  {
    key: "ORDER_OUTCOME",
    label: "Kết quả đơn (ORDER_OUTCOME)",
    why: "Chỉ có MỘT công thức kết quả đơn và mọi báo cáo dùng lại nó (AGENTS.md mục 3.1). Sửa sai là mọi con số của mọi phòng sai theo cùng lúc.",
    risk: "R2",
    keywords: ["order_outcome", "return-rate", "ket qua don", "giao thanh cong", "return_rule"],
  },
  {
    key: "PAYROLL",
    label: "Lương & hoa hồng",
    why: "Tiền trả cho người thật. Kỳ đã chốt là bất biến (mục 21), và lương đi theo thời gian còn hoa hồng đi theo đơn (mục 16).",
    risk: "R2",
    modules: ["PAYROLL"],
    keywords: ["luong", "payroll", "hoa hong", "commission"],
  },
  {
    key: "PROFIT",
    label: "Lợi nhuận & phân bổ chi phí",
    why: "Một khoản chi có ĐÚNG MỘT nguồn (mục 15) và phân bổ phải khai căn cứ (mục 14). Cộng nhầm một nguồn là lợi nhuận sai mà không ai thấy.",
    risk: "R2",
    modules: ["REPORTS", "FINANCE"],
    keywords: ["loi nhuan", "profit", "cost-allocation", "cost-engine", "gia von", "cogs"],
  },
  {
    key: "INVENTORY_TRUTH",
    label: "Sự thật tồn kho",
    why: "Sổ kho (mục 10): tồn thực tế tính từ phiếu kho trừ đã xuất qua ĐVVC. Hàng hoàn chỉ vào tồn khi kho lập phiếu RETURN.",
    risk: "R2",
    modules: ["INVENTORY", "PURCHASING"],
    keywords: ["ton kho", "stock", "phieu kho", "receipt"],
  },
  {
    key: "ACCESS",
    label: "Quyền, vai trò, phạm vi dữ liệu",
    why: "Ba chiều quyền không suy ra lẫn nhau (mục 28–31). Một lần nới sai là dữ liệu lương / dòng tiền lộ ra ngoài phạm vi.",
    risk: "R2",
    modules: ["ACCESS"],
    taskTypes: ["SECURITY"],
    keywords: ["quyen", "permission", "role", "scope", "auth", "dang nhap", "session"],
  },
  {
    key: "MIGRATION",
    label: "Migration CSDL",
    why: "Migration đã áp trên production thì không sửa, không đánh số lại, không xoá (AGENTS.md mục 4). Migration phá huỷ cần chủ shop đồng ý.",
    risk: "R2",
    taskTypes: ["MIGRATION"],
    keywords: ["migration", "drop column", "drop table", "alter type", "truncate"],
  },
  {
    key: "DATA_FIX",
    label: "Sửa dữ liệu production",
    why: "Sửa / hạ trạng thái dữ liệu production phải hỏi chủ shop trước (mục 7). Không backfill im lặng (mục 8.8).",
    risk: "R2",
    taskTypes: ["DATA_FIX"],
    keywords: ["backfill", "sua du lieu", "update production", "data-check fix"],
  },
  {
    key: "SCHEDULER",
    label: "Lịch chạy job nền",
    why: "Đổi lịch scheduler phải hỏi chủ shop (mục 7). Một job chạy dày lên là hạn mức API cạn; thưa đi là dữ liệu cũ mà không ai biết.",
    risk: "R2",
    keywords: ["scheduler", "cron", "lich job", "sync_every"],
  },
  {
    key: "SECRETS",
    label: "Secret & khoá API",
    why: "Kho mã này PUBLIC. Một lần lộ token là lộ vĩnh viễn (mục 5).",
    risk: "R2",
    keywords: ["secret", "token", "api key", "password", "webhook secret", ".env"],
  },
  {
    key: "INTEGRATION_CHANGE",
    label: "Đổi tích hợp bên ngoài",
    why: "Thêm dịch vụ ngoài / đổi cách gọi Pancake · Viettel Post · Facebook · ngân hàng phải hỏi chủ shop (mục 7), và webhook phải luôn idempotent.",
    risk: "R2",
    taskTypes: ["INTEGRATION"],
    modules: ["INTEGRATIONS"],
  },
  {
    key: "COD_MONEY",
    label: "Tiền COD & đối soát",
    why: "Tiền thực thu là chứng từ, không phải trạng thái. NULL là CHƯA BIẾT, không phải 0 (mục 0.3).",
    risk: "R2",
    modules: ["COD"],
    keywords: ["cod", "doi soat", "bang ke", "settlement"],
  },
  {
    key: "CARRIER_TRUTH",
    label: "Chứng từ đơn vị vận chuyển",
    why: "Lời khai của ĐVVC và kết luận của ERP là hai thứ, không bao giờ gộp (mục 47). Mốc bàn giao chỉ tính khi ĐVVC thật sự cầm hàng (mục 41).",
    risk: "R2",
    modules: ["SHIPMENTS"],
    keywords: ["shipment_events", "vtp_raw", "normalized_stage", "carrier_handoff"],
  },
  {
    key: "METRIC_DEFINITION",
    label: "Định nghĩa chỉ số & đích",
    why: "Khoá chỉ số không được đổi (mục 37) và đích là quyết định kinh doanh, không phải hằng số (mục 38).",
    risk: "R2",
    keywords: ["metric_catalog", "metric_targets", "metric_bindings", "chi so", "kpi"],
  },

  /* ───────── R1: chạm hệ thống, không chạm định nghĩa một con số nào ───────── */
  {
    key: "BACKEND_CHANGE",
    label: "Sửa backend / truy vấn",
    why: "Không đổi sự thật nhưng đổi được hiệu năng và hình dạng dữ liệu trả về.",
    risk: "R1",
    taskTypes: ["BUGFIX", "REFACTOR", "PERFORMANCE"],
  },
  {
    key: "INFRA",
    label: "Hạ tầng & deploy",
    why: "Không đổi số nào nhưng hỏng thì cả hệ thống không mở được.",
    risk: "R1",
    taskTypes: ["INFRA"],
    modules: ["PLATFORM"],
  },
  {
    key: "FEATURE",
    label: "Tính năng mới",
    why: "Mã mới luôn có bề mặt lỗi mới, kể cả khi không đụng công thức nào.",
    risk: "R1",
    taskTypes: ["FEATURE"],
  },
] as const;

export const TECH_RISK_RULE_BY_KEY: Record<string, TechRiskRule> = Object.fromEntries(TECH_RISK_RULES.map((r) => [r.key, r]));

/** Bỏ dấu tiếng Việt để luật từ khoá khớp được cả "lương" lẫn "luong". */
function khongDau(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

const RANK: Record<TechRisk, number> = { R0: 0, R1: 1, R2: 2 };

export type TechRiskInput = {
  taskType: TechTaskType;
  module: TechModule;
  title: string;
  description?: string;
};

export type TechRiskVerdict = {
  risk: TechRisk;
  /** Khoá của các luật đã khớp, mức cao nhất đứng đầu. Rỗng ⇒ không luật nào chạm ⇒ R0. */
  rules: string[];
  /** Câu giải thích hiện thẳng cho người đọc. */
  reasons: string[];
  /** R2 ⇒ bắt buộc chủ shop phê duyệt. Đây là chỗ DUY NHẤT quyết định điều đó. */
  requiresApproval: boolean;
};

/**
 * Xếp mức rủi ro cho một việc Tech. HÀM THUẦN.
 *
 * Mặc định là `R0` — nhưng `R0` ở đây nghĩa là "không luật nào khớp", không phải "đã kiểm tra và
 * thấy an toàn". Màn hình phải nói đúng câu đó, và người vẫn đè được lên.
 */
export function classifyTechRisk(input: TechRiskInput): TechRiskVerdict {
  const text = khongDau(`${input.title} ${input.description ?? ""}`);
  const khop: TechRiskRule[] = [];

  for (const rule of TECH_RISK_RULES) {
    const theoModule = rule.modules?.includes(input.module) ?? false;
    const theoLoai = rule.taskTypes?.includes(input.taskType) ?? false;
    const theoTuKhoa = rule.keywords?.some((k) => text.includes(khongDau(k))) ?? false;
    if (theoModule || theoLoai || theoTuKhoa) khop.push(rule);
  }

  const risk = khop.reduce<TechRisk>((cao, r) => (RANK[r.risk] > RANK[cao] ? r.risk : cao), "R0");
  // Chỉ nêu lý do của những luật đã ĐẨY mức lên tới mức cuối: liệt kê cả luật R1 bên dưới một luật
  // R2 chỉ làm loãng câu trả lời "vì sao việc này cần chủ shop duyệt".
  const quyetDinh = khop.filter((r) => r.risk === risk);

  return {
    risk,
    rules: quyetDinh.map((r) => r.key),
    reasons: quyetDinh.map((r) => `${r.label}: ${r.why}`),
    requiresApproval: risk === "R2",
  };
}

/** Câu một dòng cho màn hình khi không luật nào khớp. */
export function techRiskEmptyReason(module: TechModule) {
  return `Không luật rủi ro nào khớp với việc này (module ${TECH_MODULE_LABEL[module]}). Đây là “chưa thấy rủi ro”, không phải “đã kiểm tra và an toàn” — người vẫn nâng mức lên được, kèm lý do.`;
}
