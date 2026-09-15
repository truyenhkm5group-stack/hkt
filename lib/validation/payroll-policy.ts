/**
 * ═══════ LƯỢC ĐỒ ĐẦU VÀO CHO CHÍNH SÁCH LƯƠNG ═══════
 *
 * Đây là cửa duy nhất mà một tham số phép tính đi từ trình duyệt vào CSDL, nên nó phải ĐÓNG. Cụ
 * thể: `calc` chỉ nhận đúng sáu hình dạng khai ở `PayrollCalcParams`, và `basisKey` chỉ nhận khoá
 * có thật trong sổ đăng ký đầu vào. Một chuỗi lạ lọt qua đây sẽ nằm trong `jsonb` cho tới ngày ai
 * đó chốt lương bằng nó, và lúc ấy nó là một khoản tiền sai chứ không còn là một lỗi nhập liệu.
 */
import { z } from "zod";
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  PAYROLL_COMPONENT_KINDS,
  PAYROLL_INPUT_KEYS,
  PAYROLL_PRORATE_RULES,
  PAYROLL_ROUNDING_RULES,
  WORK_MODES,
  carryForwardAllowed,
  type PayrollCalcParams,
} from "@/lib/constants/payroll-components";

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày phải dạng YYYY-MM-DD");
const optionalDateKey = z.union([dateKey, z.literal("")]).optional();
/*
  TRẦN CỦA Ô TIỀN PHẢI BẰNG TRẦN CỦA CỘT, KHÔNG RỘNG HƠN.

  Cột tiền trong lược đồ là `integer` — 32 bit, tối đa 2.147.483.647đ. Lược đồ đầu vào trước bản
  này cho tới 10 tỷ, nên một khoản 3 tỷ đi qua zod trót lọt rồi chết ở Postgres với một câu lỗi
  tiếng Anh về "integer out of range" mà người nhập không đọc được và không sửa được. Chặn ở đây,
  bằng tiếng Việt, nói rõ trần là bao nhiêu.

  Nới trần thật sự là đổi kiểu cột (`bigint`) — một quyết định của chủ shop kèm một migration, chứ
  không phải một con số gõ lại ở lược đồ đầu vào.
*/
export const VND_COLUMN_MAX = 2_147_483_647;
const vnd = z
  .number()
  .int("Tiền VND là số nguyên")
  .min(-VND_COLUMN_MAX, `Số tiền không được nhỏ hơn -${VND_COLUMN_MAX.toLocaleString("vi-VN")}đ`)
  .max(VND_COLUMN_MAX, `Số tiền tối đa ${VND_COLUMN_MAX.toLocaleString("vi-VN")}đ — vượt trần cột tiền của CSDL`);
const basisKey = z.enum(PAYROLL_INPUT_KEYS as [string, ...string[]], { error: "Đại lượng không có trong sổ đăng ký đầu vào" });

/**
 * TẬP ĐÓNG CÁC HÌNH DẠNG THAM SỐ.
 *
 * Cố ý dùng `discriminatedUnion` chứ không phải `z.record(z.unknown())`: một ô JSON tự do là cách
 * để một tham số thiếu (vd `ratePercent`) đi lọt vào CSDL, rồi máy tính đọc `undefined`, nhân ra
 * `NaN`, và `NaN` in ra màn hình thành "—" như thể đó là một chỗ trống bình thường.
 */
export const calcParamsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("FIXED_AMOUNT"), amount: vnd }),
  z.object({ type: z.literal("PER_UNIT"), basisKey, unitRate: z.number().min(-1_000_000_000).max(1_000_000_000) }),
  z.object({ type: z.literal("RATE_OF_BASIS"), basisKey, ratePercent: z.number().min(-100).max(1000) }),
  z.object({
    type: z.literal("TIERED_RATE"),
    basisKey,
    tiers: z
      .array(z.object({ from: z.number().min(0), ratePercent: z.number().min(0).max(1000) }))
      .min(1, "Phải có ít nhất một bậc")
      .max(10, "Tối đa 10 bậc")
      // Bậc đầu phải từ 0, nếu không phần dưới bậc đầu rơi ra ngoài mọi bậc và lặng lẽ thành 0.
      .refine((t) => [...t].sort((a, b) => a.from - b.from)[0].from === 0, "Bậc thấp nhất phải bắt đầu từ 0, nếu không phần dưới nó không thuộc bậc nào")
      .refine((t) => new Set(t.map((x) => x.from)).size === t.length, "Hai bậc không được cùng một mốc"),
  }),
  z.object({ type: z.literal("THRESHOLD_BONUS"), basisKey, threshold: z.number(), amount: vnd }),
]);

export const policySchema = z.object({
  id: z.string().optional(),
  code: z
    .string()
    .trim()
    .min(2, "Nhập mã chính sách")
    .max(40)
    // Mã là KHOÁ, và khoá phải gõ lại được: chữ hoa, số, gạch dưới.
    .regex(/^[A-Z][A-Z0-9_]*$/, "Mã chỉ gồm chữ HOA, số và gạch dưới, bắt đầu bằng chữ"),
  name: z.string().trim().min(1, "Nhập tên chính sách").max(120),
  description: z.string().trim().max(1000).default(""),
  departmentId: z.string().trim().max(64).optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(100),
});

export const componentSchema = z
  .object({
    id: z.string().optional(),
    code: z.string().trim().min(1, "Nhập khoá thành phần").max(40).regex(/^[A-Z][A-Z0-9_]*$/, "Khoá chỉ gồm chữ HOA, số và gạch dưới"),
    label: z.string().trim().min(1, "Nhập tên hiển thị").max(120),
    kind: z.enum(PAYROLL_COMPONENT_KINDS, { error: "Chọn loại thành phần" }),
    calc: calcParamsSchema,
    prorate: z.enum(PAYROLL_PRORATE_RULES).default("NONE"),
    rounding: z.enum(PAYROLL_ROUNDING_RULES).default("ROUND"),
    minAmount: z.number().int().nullable().default(null),
    maxAmount: z.number().int().nullable().default(null),
    carryForward: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(9999).default(100),
    note: z.string().trim().max(500).default(""),
  })
  /*
    HAI LUẬT KIỂM Ở ĐÂY, VÀ CẢ HAI CÒN ĐƯỢC KHOÁ LẠI Ở CSDL.

    Kiểm hai lớp là cố ý: lược đồ bắt lỗi sớm và nói được câu tiếng Việt cho người nhập; ràng buộc
    CSDL chặn cả những đường KHÔNG đi qua màn hình (một script chạy tay, một lần sửa thẳng bảng).
  */
  .refine((c) => c.minAmount === null || c.maxAmount === null || c.maxAmount >= c.minAmount, {
    message: "Trần phải lớn hơn hoặc bằng sàn — cặp ngược lại không có giá trị nào thoả",
    path: ["maxAmount"],
  })
  .refine((c) => !c.carryForward || carryForwardAllowed(c.calc as PayrollCalcParams), {
    message: "Bù lỗ lũy kế chỉ có nghĩa với thành phần tính theo LỢI NHUẬN — doanh thu, số đơn, giờ công và sản lượng không bao giờ âm",
    path: ["carryForward"],
  });

export const versionSchema = z.object({
  id: z.string().optional(),
  policyId: z.string().min(1, "Chọn chính sách"),
  effectiveFrom: dateKey,
  effectiveTo: optionalDateKey,
  note: z.string().trim().max(500).default(""),
  components: z.array(componentSchema).max(30, "Tối đa 30 thành phần trong một phiên bản"),
});

export const employmentSchema = z
  .object({
    id: z.string().optional(),
    employeeId: z.string().min(1, "Chọn nhân sự"),
    userId: z.string().trim().max(64).optional(),
    departmentId: z.string().trim().max(64).optional(),
    positionId: z.string().trim().max(64).optional(),
    managerUserId: z.string().trim().max(64).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES, { error: "Chọn hình thức làm việc" }),
    workMode: z.enum(WORK_MODES, { error: "Chọn nơi làm việc" }),
    status: z.enum(EMPLOYMENT_STATUSES).default("ACTIVE"),
    standardWorkDays: z.number().int().min(1).max(31).nullable().default(null),
    costCenter: z.string().trim().max(64).default(""),
    effectiveFrom: dateKey,
    effectiveTo: optionalDateKey,
    note: z.string().trim().max(500).default(""),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    message: "Mốc kết thúc phải từ mốc bắt đầu trở đi",
    path: ["effectiveTo"],
  });

export const policyAssignmentSchema = z
  .object({
    id: z.string().optional(),
    employeeId: z.string().min(1, "Chọn nhân sự"),
    policyId: z.string().min(1, "Chọn chính sách lương"),
    effectiveFrom: dateKey,
    effectiveTo: optionalDateKey,
    note: z.string().trim().max(500).default(""),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    message: "Mốc kết thúc phải từ mốc bắt đầu trở đi",
    path: ["effectiveTo"],
  });

export const payrollInputSchema = z.object({
  employeeId: z.string().min(1, "Chọn nhân sự"),
  periodKey: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/, "Khoá kỳ không hợp lệ"),
  inputKey: basisKey,
  value: z.number().min(0, "Giá trị không được âm").max(1_000_000),
  /*
    CHỨNG CỨ BẮT BUỘC.

    Đây là những đại lượng ERP KHÔNG đo được — chấm công, KPI, sản lượng. Con số ở đây là lời khai
    của một người, và một lời khai không nói được nó dựa trên cái gì thì sáu tháng sau không ai đối
    chiếu lại được. Bắt buộc ngay ở lược đồ, không phải một ô "nên điền".
  */
  evidence: z.string().trim().min(3, "Ghi rõ căn cứ: bảng công tháng nào, ai duyệt, số phiếu nào").max(500),
});

export const adjustmentSchema = z.object({
  id: z.string().optional(),
  employeeId: z.string().min(1, "Chọn nhân sự"),
  periodKey: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/, "Khoá kỳ không hợp lệ"),
  kind: z.enum(["BONUS", "ALLOWANCE", "ADJUSTMENT", "ADVANCE", "DEDUCTION", "REIMBURSEMENT"], { error: "Chọn loại khoản" }),
  label: z.string().trim().min(1, "Nhập tên khoản").max(120),
  /** LUÔN DƯƠNG — dấu do `kind` quyết định, để một dấu trừ gõ nhầm không lật ý nghĩa khoản tiền. */
  amount: z.number().int().min(0, "Số tiền không được âm — dấu do loại khoản quyết định").max(VND_COLUMN_MAX, `Số tiền tối đa ${VND_COLUMN_MAX.toLocaleString("vi-VN")}đ — vượt trần cột tiền của CSDL`),
  reason: z.string().trim().min(3, "Một khoản tiền không có lý do là một khoản không ai duyệt lại được").max(500),
  reference: z.string().trim().max(200).default(""),
});

export type PolicyInput = z.infer<typeof policySchema>;
export type VersionInput = z.infer<typeof versionSchema>;
export type ComponentInput = z.infer<typeof componentSchema>;
export type EmploymentInput = z.infer<typeof employmentSchema>;
export type PolicyAssignmentInput = z.infer<typeof policyAssignmentSchema>;
export type PayrollInputEntry = z.infer<typeof payrollInputSchema>;
export type AdjustmentInputEntry = z.infer<typeof adjustmentSchema>;
