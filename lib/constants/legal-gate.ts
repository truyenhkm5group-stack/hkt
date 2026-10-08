/**
 * ═══════════ CỔNG RA MẮT PHÁP LÝ — TRẠNG THÁI THEO CHIỀU (docs/legal/LEGAL_LAUNCH_GATE.md) ═══════════
 *
 * Mỗi mục của cổng (LEGAL-P0, LEGAL-P1) mang NĂM chiều TÁCH RỜI — mỗi chiều do một người khác đóng, và một chiều xong
 * không nói gì về chiều kia:
 *   · ENGINEERING        READY · WIP · NOT_STARTED · NOT_NEEDED   (kỹ thuật — mã, bài kiểm, tài liệu cơ chế)
 *   · COUNSEL            PENDING · ANSWERED · NOT_NEEDED           (G — luật sư trả lời bằng văn bản có viện dẫn)
 *   · GOVERNMENT_FILING  PENDING · FILED · NOT_NEEDED              (D — đã nộp / cơ quan tiếp nhận; FILED = ⛔ chờ cơ quan)
 *   · ACCOUNTING         PENDING · DONE · NOT_NEEDED               (E — kế toán xác nhận)
 *   · OWNER              PENDING · DECIDED · NOT_NEEDED            (F — chủ sở hữu quyết bằng văn bản)
 * Chiều OWNER không có trong đề bài gốc (bốn chiều) nhưng cổng ghi F ở nhiều mục (P0-3, P0-4, P0-5…): thiếu nó thì một mục
 * chờ chủ sở hữu có thể trông như đã xong — phía an toàn là thêm.
 *
 * ─── LEGAL READY LÀ DẪN XUẤT, KHÔNG KHAI TAY ───
 * `legalReady(item)` = mọi chiều ở trạng thái xong hoặc NOT_NEEDED. Không có trường nào để gõ «ready: true». Mỗi
 * `NOT_NEEDED` phải kèm lý do (`notNeeded`), vì «không cần» là một khẳng định — chưa chắc thì để PENDING.
 *
 * ─── TÀI LIỆU ↔ HẰNG ───
 * Bảng «Trạng thái theo chiều» trong LEGAL_LAUNCH_GATE.md §8 SINH từ `renderLegalGateDimensionTable()`; bài kiểm so từng
 * byte. Cột ký hiệu cũ (✅ 🟡 🔧 ❌ ⛔ ❓) của §2 / §3 khai lại ở `docMark` và bài kiểm so với tài liệu: ✅ ⇔ LEGAL READY,
 * ⛔ ⇒ đã nộp. Tổng điểm P0 tính từ `docMark` và phải bằng dòng «Tổng P0» của tài liệu.
 */

export const GATE_DIMENSIONS = ["ENGINEERING", "COUNSEL", "GOVERNMENT_FILING", "ACCOUNTING", "OWNER"] as const;
export type GateDimension = (typeof GATE_DIMENSIONS)[number];

export const ENGINEERING_STATES = ["READY", "WIP", "NOT_STARTED", "NOT_NEEDED"] as const;
export const COUNSEL_STATES = ["PENDING", "ANSWERED", "NOT_NEEDED"] as const;
export const FILING_STATES = ["PENDING", "FILED", "NOT_NEEDED"] as const;
export const ACCOUNTING_STATES = ["PENDING", "DONE", "NOT_NEEDED"] as const;
export const OWNER_STATES = ["PENDING", "DECIDED", "NOT_NEEDED"] as const;

export type GateDimensionStates = {
  ENGINEERING: (typeof ENGINEERING_STATES)[number];
  COUNSEL: (typeof COUNSEL_STATES)[number];
  GOVERNMENT_FILING: (typeof FILING_STATES)[number];
  ACCOUNTING: (typeof ACCOUNTING_STATES)[number];
  OWNER: (typeof OWNER_STATES)[number];
};

/** Trạng thái được coi là XONG của từng chiều (ngoài NOT_NEEDED). */
export const GATE_DONE_STATE: Readonly<{ [K in GateDimension]: GateDimensionStates[K] }> = {
  ENGINEERING: "READY",
  COUNSEL: "ANSWERED",
  GOVERNMENT_FILING: "FILED",
  ACCOUNTING: "DONE",
  OWNER: "DECIDED",
};

/** Ký hiệu của cột «Trạng thái» ở tài liệu (§1 Cách chấm). */
export const GATE_DOC_MARKS = { DONE: "✅", PARTIAL: "🟡", WIP: "🔧", MISSING: "❌", PENDING_AUTHORITY: "⛔", UNKNOWN: "❓" } as const;
export type GateDocMark = keyof typeof GATE_DOC_MARKS;
export const GATE_DOC_MARK_SCORE: Readonly<Record<GateDocMark, number>> = { DONE: 1, PARTIAL: 0.5, WIP: 0, MISSING: 0, PENDING_AUTHORITY: 0, UNKNOWN: 0 };

export type GateTier = "P0" | "P1";

export type LegalGateItem = {
  id: string;
  tier: GateTier;
  title: string;
  states: GateDimensionStates;
  /** Lý do cho MỖI chiều đang NOT_NEEDED. */
  notNeeded: Partial<Record<GateDimension, string>>;
  /** Bằng chứng kỹ thuật (tệp trong kho) — bắt buộc khi ENGINEERING = READY. */
  engineeringEvidence: readonly string[];
  /** Ký hiệu đang in ở tài liệu. */
  docMark: GateDocMark;
  note: string;
};

const NN_NO_ENG = "Mục là thủ tục / ý kiến pháp lý — không có việc kỹ thuật (CONVERSION_FIRST_REAUDIT.md)";
const NN_NO_FILING = "Cổng không ghi loại bằng chứng D cho mục này — không có hồ sơ nộp cơ quan";
const NN_NO_ACCOUNTING = "Cổng không ghi loại bằng chứng E cho mục này";
const NN_NO_OWNER = "Không có quyết định chủ sở hữu (F) nào treo ở mục này trong cổng";
const NN_NO_COUNSEL = "Mục RECOMMENDED / backend-only, cổng không gắn câu hỏi G nào";

export const LEGAL_GATE_ITEMS: readonly LegalGateItem[] = [
  // ─── LEGAL-P0 ───
  {
    id: "P0-1",
    tier: "P0",
    title: "Phân loại «kinh doanh dịch vụ xử lý DLCN»; nếu áp dụng: Giấy chứng nhận Bộ Công an",
    states: { ENGINEERING: "NOT_NEEDED", COUNSEL: "PENDING", GOVERNMENT_FILING: "PENDING", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { ENGINEERING: NN_NO_ENG, ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: [],
    docMark: "UNKNOWN",
    note: "G-1; nếu áp dụng: Mẫu 05 (D-3), ≥ 3 nhân sự (F-4)",
  },
  {
    id: "P0-2",
    tier: "P0",
    title: "Hồ sơ đánh giá tác động xử lý DLCN (DPIA) — hoặc văn bản xác nhận được hoãn",
    states: { ENGINEERING: "READY", COUNSEL: "PENDING", GOVERNMENT_FILING: "PENDING", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: ["docs/legal/DATA_PROCESSING_REGISTER.md", "docs/legal/DATA_FLOW_MAP.md"],
    docMark: "MISSING",
    note: "Bằng chứng kỹ thuật đã có; chưa lập Mẫu 10 (D-1); hoãn 5 năm — G-2",
  },
  {
    id: "P0-3",
    tier: "P0",
    title: "Hồ sơ chuyển xuyên biên giới X1–X5 (+ X9 Cloudflare) + vùng xử lý xác định",
    states: { ENGINEERING: "WIP", COUNSEL: "PENDING", GOVERNMENT_FILING: "PENDING", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: ["lib/constants/legal-registers.ts", "tests/legal-registers.test.ts"],
    docMark: "MISSING",
    note: "Sổ X1–X11 có kiểu; mọi vùng UNKNOWN — M-OBSERVE + hỏi từng bên; F-2 / F-3; G-3; Mẫu 09 (D-2)",
  },
  {
    id: "P0-4",
    tier: "P0",
    title: "Công bố AI mức tối thiểu (tên hiển thị + greeting / tiêu đề + một dòng đầu hội thoại mới); bot không nói dối khi bị hỏi",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { GOVERNMENT_FILING: "Loại bằng chứng của mục là A (mã + bài kiểm); thông báo hệ thống AI tới cơ quan là việc riêng (§19.D-5), theo dõi ở P1-9", ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-AI-DISCLOSE-UI (cơ chế 1) chưa vào main; cơ chế 2 chờ F; G-4",
  },
  {
    id: "P0-5",
    tier: "P0",
    title: "DPA với khách thuê — phụ lục của Điều khoản, chấp thuận cùng dòng đồng ý hiện có",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { GOVERNMENT_FILING: "Hợp đồng giữa các bên — cổng ghi B → G, không có D", ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "LEGAL_DOCUMENTS.DPA = NOT_PUBLISHED / COUNSEL_PENDING; M-DPA-ANNEX chờ F + G-10",
  },
  {
    id: "P0-6",
    tier: "P0",
    title: "Nơi lưu dữ liệu tại Việt Nam",
    states: { ENGINEERING: "READY", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { GOVERNMENT_FILING: "Cổng ghi loại bằng chứng G · F, không có D", ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: ["docker-compose.prod.yml"],
    docMark: "PARTIAL",
    note: "CSDL + sao lưu chính tại VN; bản Drive mã hoá — G-3; tên nhà cung cấp VPS — F-9",
  },
  {
    id: "P0-7",
    tier: "P0",
    title: "Thông báo / đăng ký nền tảng TMĐT (nếu áp dụng)",
    states: { ENGINEERING: "NOT_NEEDED", COUNSEL: "PENDING", GOVERNMENT_FILING: "PENDING", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { ENGINEERING: "Thủ tục hồ sơ; phần chân trang TMĐT theo dõi ở P1-17", ACCOUNTING: NN_NO_ACCOUNTING, OWNER: "Hồ sơ do người đại diện pháp luật nộp — đã tính ở chiều GOVERNMENT_FILING" },
    engineeringEvidence: [],
    docMark: "UNKNOWN",
    note: "G-6; D-4",
  },
  {
    id: "P0-8",
    tier: "P0",
    title: "Khả năng thông báo sự cố trong 72 giờ: runbook một trang + người trực; đánh giá sự cố log 24/09",
    states: { ENGINEERING: "READY", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { GOVERNMENT_FILING: "Không có hồ sơ thường trực; thông báo cơ quan phát sinh THEO sự cố (runbook §4)", ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: ["docs/legal/INCIDENT_RESPONSE.md"],
    docMark: "PARTIAL",
    note: "Runbook khung có; người trực — F; ngưỡng / mốc thông báo + sự cố 24/09 — G-11",
  },
  {
    id: "P0-9",
    tier: "P0",
    title: "Khả năng đáp yêu cầu chủ thể dữ liệu trong hạn: quy trình tay qua khách thuê + ops chỉ đọc + script xoá chạy thử",
    states: { ENGINEERING: "WIP", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "PENDING", OWNER: "PENDING" },
    notNeeded: { GOVERNMENT_FILING: NN_NO_FILING },
    engineeringEvidence: ["docs/legal/DSR_PROCEDURE.md"],
    docMark: "PARTIAL",
    note: "Quy trình viết ra; thiếu scripts/subject-erase.ts; hạn 2 / 10 / 15 / 20 ngày chờ G; LEGAL HOLD chứng từ chờ E",
  },
  {
    id: "P0-10",
    tier: "P0",
    title: "Số dư AI không phải trung gian thanh toán / ví điện tử",
    states: { ENGINEERING: "READY", COUNSEL: "PENDING", GOVERNMENT_FILING: "PENDING", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { ACCOUNTING: NN_NO_ACCOUNTING, OWNER: NN_NO_OWNER },
    engineeringEvidence: ["lib/billing/ai-balance-rules.ts"],
    docMark: "PARTIAL",
    note: "Thiết kế đúng; G-7 — nếu là ví điện tử thì phải xin phép NHNN (chiều nộp hồ sơ phụ thuộc G-7)",
  },
  {
    id: "P0-11",
    tier: "P0",
    title: "Xuất hoá đơn đúng khi thu tiền; giá công bố nói rõ thuế",
    states: { ENGINEERING: "READY", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "PENDING", OWNER: "PENDING" },
    notNeeded: { GOVERNMENT_FILING: NN_NO_FILING },
    engineeringEvidence: ["docs/platform/billing.md"],
    docMark: "PARTIAL",
    note: "tax_mode = UNDECLARED; E-1…E-3; «dịch vụ phần mềm» cho phần AI — E + G; nhà cung cấp HĐĐT — F-7",
  },
  // ─── LEGAL-P1 ───
  {
    id: "P1-1",
    tier: "P1",
    title: "Chính sách quyền riêng tư nêu đủ bên thứ ba",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-PRIVACY-THIRD-PARTIES; danh sách nguồn: SUBPROCESSORS (lib/constants/legal-registers.ts); G-9",
  },
  {
    id: "P1-2",
    tier: "P1",
    title: "Số công bố khớp mã: dùng thử, VPS, kênh thông báo khi không có email",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "NOT_NEEDED", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { COUNSEL: "Sửa cho khớp sự thật — không phải câu hỏi luật", GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-TRIAL-CONSISTENCY; F-9 · F-10 · F-11",
  },
  {
    id: "P1-3",
    tier: "P1",
    title: "Nhật ký đăng nhập ≥ 12 tháng có IP + cổng",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING, OWNER: NN_NO_OWNER },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-LOGIN-LOG; MANDATORY nếu NĐ 333 áp — G-5",
  },
  {
    id: "P1-4",
    tier: "P1",
    title: "Bộ phận / nhân sự bảo vệ DLCN (hoặc văn bản hoãn)",
    states: { ENGINEERING: "NOT_NEEDED", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { ENGINEERING: NN_NO_ENG, GOVERNMENT_FILING: "Cổng ghi loại bằng chứng F · C", ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "F-4; hoãn — G-2",
  },
  {
    id: "P1-5",
    tier: "P1",
    title: "Chính sách khiếu nại / hỗ trợ (một trang)",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "MANDATORY nếu TMĐT — G-6",
  },
  {
    id: "P1-6",
    tier: "P1",
    title: "Ghi sổ chấp thuận backend: phiên bản · hash · mốc · IP; đổi phiên bản ⇒ thông báo trong app, không chặn",
    states: { ENGINEERING: "WIP", COUNSEL: "NOT_NEEDED", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { COUNSEL: NN_NO_COUNSEL, GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING, OWNER: "Đã quyết 08/10: backend-only, bỏ checkbox / màn chặn (CONVERSION_FIRST_REAUDIT.md)" },
    engineeringEvidence: ["lib/constants/legal-documents.ts"],
    docMark: "PARTIAL",
    note: "Hàm băm nội dung văn bản có (legalContentSha256); bảng platform_legal_acceptances chưa có (M-ACCEPT)",
  },
  {
    id: "P1-7",
    tier: "P1",
    title: "Sổ đồng ý backend (nhóm A; tiếp thị do khách thuê bật) — không popup",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING, OWNER: NN_NO_OWNER },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-CONSENT; căn cứ không cần đồng ý — G-8",
  },
  {
    id: "P1-8",
    tier: "P1",
    title: "Từ khoá «dừng» ⇒ tắt follow-up / broadcast cho người đó; không thêm chữ vào tin bán",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "NOT_NEEDED", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { COUNSEL: NN_NO_COUNSEL, GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING, OWNER: NN_NO_OWNER },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-OPTOUT (mark_declined là một phần)",
  },
  {
    id: "P1-9",
    tier: "P1",
    title: "Sổ hệ thống AI (tệp hằng số, không UI)",
    states: { ENGINEERING: "READY", COUNSEL: "PENDING", GOVERNMENT_FILING: "PENDING", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { ACCOUNTING: NN_NO_ACCOUNTING, OWNER: NN_NO_OWNER },
    engineeringEvidence: ["lib/constants/ai-systems.ts", "tests/legal-registers.test.ts"],
    docMark: "PARTIAL",
    note: "AI-01…AI-08, mọi mức rủi ro UNCLASSIFIED — G-4; thông báo hệ thống AI nếu nghị định đòi — D-5",
  },
  {
    id: "P1-10",
    tier: "P1",
    title: "Chính sách ATTT chính thức; MFA người vận hành nền tảng",
    states: { ENGINEERING: "WIP", COUNSEL: "NOT_NEEDED", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "PENDING" },
    notNeeded: { COUNSEL: NN_NO_COUNSEL, GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING },
    engineeringEvidence: [],
    docMark: "PARTIAL",
    note: "docs/saas/SECURITY.md là bản kỹ thuật; bản chính thức cần chủ sở hữu ký; MFA chưa có",
  },
  {
    id: "P1-11",
    tier: "P1",
    title: "Retention + LEGAL HOLD theo loại (số do F + G + E điền)",
    states: { ENGINEERING: "WIP", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "PENDING", OWNER: "PENDING" },
    notNeeded: { GOVERNMENT_FILING: NN_NO_FILING },
    engineeringEvidence: ["lib/constants/retention.ts"],
    docMark: "PARTIAL",
    note: "Khung 10 loại có, mọi thời hạn null (chưa quyết); job retention-sweep chưa có",
  },
  {
    id: "P1-12",
    tier: "P1",
    title: "Bằng chứng từng trường của đơn — backend, không thêm bước xác nhận",
    states: { ENGINEERING: "WIP", COUNSEL: "NOT_NEEDED", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { COUNSEL: NN_NO_COUNSEL, GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING, OWNER: NN_NO_OWNER },
    engineeringEvidence: [],
    docMark: "WIP",
    note: "ORDER_CANDIDATE.md — roadmap sản phẩm",
  },
  {
    id: "P1-13",
    tier: "P1",
    title: "Bài kiểm bất biến tín dụng dịch vụ",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "NOT_NEEDED", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { COUNSEL: "Phần pháp lý theo dõi ở P0-10 (G-7)", GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING, OWNER: NN_NO_OWNER },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-INVARIANT-CREDIT",
  },
  {
    id: "P1-14",
    tier: "P1",
    title: "Công cụ DSR tự phục vụ (tra · xuất theo chủ thể · xoá / ẩn danh · LEGAL HOLD · sổ yêu cầu)",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "NOT_NEEDED", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { COUNSEL: "Hạn luật định theo dõi ở P0-9", GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: "LEGAL HOLD chứng từ theo dõi ở P0-9", OWNER: NN_NO_OWNER },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-DSR",
  },
  {
    id: "P1-15",
    tier: "P1",
    title: "Bảng platform_incidents",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "NOT_NEEDED", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { COUNSEL: "Ngưỡng thông báo theo dõi ở P0-8 (G-11)", GOVERNMENT_FILING: NN_NO_FILING, ACCOUNTING: NN_NO_ACCOUNTING, OWNER: NN_NO_OWNER },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-INCIDENT (bảng); runbook ở P0-8",
  },
  {
    id: "P1-16",
    tier: "P1",
    title: "Danh mục thuế cấu hình, mã thuế trên dòng, cột HĐĐT",
    states: { ENGINEERING: "NOT_STARTED", COUNSEL: "NOT_NEEDED", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "PENDING", OWNER: "NOT_NEEDED" },
    notNeeded: { COUNSEL: "Phân loại thuế theo dõi ở P0-11", GOVERNMENT_FILING: NN_NO_FILING, OWNER: NN_NO_OWNER },
    engineeringEvidence: [],
    docMark: "MISSING",
    note: "M-TAX-CATEGORY; E-1",
  },
  {
    id: "P1-17",
    tier: "P1",
    title: "Chân trang TMĐT (chủ sở hữu · MST · khiếu nại · số thông báo)",
    states: { ENGINEERING: "WIP", COUNSEL: "PENDING", GOVERNMENT_FILING: "NOT_NEEDED", ACCOUNTING: "NOT_NEEDED", OWNER: "NOT_NEEDED" },
    notNeeded: { GOVERNMENT_FILING: "Số thông báo lấy từ P0-7", ACCOUNTING: NN_NO_ACCOUNTING, OWNER: NN_NO_OWNER },
    engineeringEvidence: ["lib/constants/company.ts"],
    docMark: "PARTIAL",
    note: "COMPANY có; M-ECOM-DISCLOSURE sau G-6",
  },
];

/** Một chiều đã xong (hoặc không cần). */
export function dimensionClosed<K extends GateDimension>(dim: K, state: GateDimensionStates[K]): boolean {
  return state === "NOT_NEEDED" || state === GATE_DONE_STATE[dim];
}

/** Các chiều còn mở của một mục. */
export function openDimensions(item: LegalGateItem): GateDimension[] {
  return GATE_DIMENSIONS.filter((d) => !dimensionClosed(d, item.states[d]));
}

/** LEGAL READY — DẪN XUẤT: mọi chiều đã xong hoặc không cần. Không có đường khai tay. */
export function legalReady(item: LegalGateItem): boolean {
  return openDimensions(item).length === 0;
}

/** Điểm P0 theo ký hiệu tài liệu — cùng phép chấm của §1. */
export function p0Score(items: readonly LegalGateItem[] = LEGAL_GATE_ITEMS): { points: number; total: number } {
  const p0 = items.filter((i) => i.tier === "P0");
  return { points: p0.reduce((s, i) => s + GATE_DOC_MARK_SCORE[i.docMark], 0), total: p0.length };
}

/** «2,5 / 11 = ~23 %» — định dạng của dòng «Tổng P0» trong tài liệu. */
export function formatP0Score(items: readonly LegalGateItem[] = LEGAL_GATE_ITEMS): string {
  const { points, total } = p0Score(items);
  const pct = Math.round((points / total) * 100);
  return `${points.toFixed(1).replace(".", ",")} / ${total} = ~${pct} %`;
}

export const LEGAL_GATE_TABLE_BEGIN = "<!-- legal-gate:begin (sinh từ lib/constants/legal-gate.ts — không sửa tay) -->";
export const LEGAL_GATE_TABLE_END = "<!-- legal-gate:end -->";

/** Bảng markdown «Trạng thái theo chiều» — tài liệu chép đúng chuỗi này (bài kiểm so từng byte). */
export function renderLegalGateDimensionTable(items: readonly LegalGateItem[] = LEGAL_GATE_ITEMS): string {
  const lines = [
    LEGAL_GATE_TABLE_BEGIN,
    "| # | ENGINEERING | COUNSEL | GOVERNMENT_FILING | ACCOUNTING | OWNER | LEGAL READY (dẫn xuất) | Còn mở |",
    "|---|---|---|---|---|---|---|---|",
    ...items.map((i) => {
      const open = openDimensions(i);
      return `| ${i.id} | ${i.states.ENGINEERING} | ${i.states.COUNSEL} | ${i.states.GOVERNMENT_FILING} | ${i.states.ACCOUNTING} | ${i.states.OWNER} | ${legalReady(i) ? "**CÓ**" : "không"} | ${open.length ? open.join(" · ") : "—"} |`;
    }),
    LEGAL_GATE_TABLE_END,
  ];
  return lines.join("\n");
}
