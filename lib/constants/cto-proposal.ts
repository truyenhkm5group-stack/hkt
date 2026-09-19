/**
 * ═══════════ HỢP ĐỒNG ĐẦU RA CỦA AI CTO ═══════════
 *
 * AI CTO trả về một BẢN KẾ HOẠCH, và bản đó phải qua được cái cổng dưới đây trước khi chạm CSDL.
 *
 * ─── VÌ SAO LÀ ZOD, KHÔNG PHẢI REGEX ───
 *
 * Một bản kế hoạch sai định dạng mà lọt qua sẽ thành những dòng rác trong `tech_proposal_tasks`,
 * và người đọc `/tech/cto` không có cách nào biết dòng nào model thật sự viết, dòng nào bộ đọc
 * đoán ra. Dò JSON bằng biểu thức chính quy là mời đúng lỗi đó vào nhà: nó "gần đúng" trong 95%
 * trường hợp, và 5% còn lại không báo lỗi — nó im lặng bỏ mất một việc.
 *
 * Nên: PARSE ĐƯỢC hay KHÔNG. Không có vùng xám. Sai ⇒ bản đề xuất mang `error` và trạng thái
 * `DRAFT`, người đọc thấy nguyên văn lý do.
 *
 * ─── HAI THỨ AI KHÔNG ĐƯỢC QUYẾT ───
 *
 * 1. **Mức rủi ro.** `suggestedRisk` ở đây chỉ là Ý KIẾN, và tên trường nói đúng điều đó. Lúc
 *    duyệt, từng việc chạy lại `classifyTechRisk()` và lấy kết quả của MÁY. Xem
 *    `lib/tech/proposal.ts`.
 * 2. **Vai agent.** Chỉ những vai CÓ THẬT trong `TECH_AGENT_TEMPLATES` mới nhận. Một vai bịa
 *    ("SUPER_ENGINEER") làm cả bản kế hoạch bị từ chối, chứ không im lặng rơi về một vai gần
 *    giống — đoán hộ ở đây là giao việc cho một cái không tồn tại.
 */
import { z } from "zod";
import { TECH_AGENT_TEMPLATES, TECH_MODULES, TECH_PRIORITIES, TECH_RISKS, TECH_TASK_TYPES } from "@/lib/constants/tech";

/** Vai agent hợp lệ — DẪN XUẤT từ bản khai, không phải một danh sách thứ hai chép tay. */
export const CTO_AGENT_KEYS = TECH_AGENT_TEMPLATES.map((t) => t.key);

/** Trần số việc trong MỘT bản kế hoạch. Một "kế hoạch" 200 việc là một bãi rác, không phải kế hoạch. */
export const CTO_MAX_TASKS = 12;

const cau = z.string().trim().min(1).max(2000);

export const ctoTaskSchema = z.object({
  /** Khoá cục bộ trong bản kế hoạch. `dependsOn` trỏ bằng khoá này, không bằng chỉ số mảng. */
  key: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/, "khoá việc phải ngắn, bắt đầu bằng chữ cái (ví dụ T1)"),
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().min(10).max(4000),
  taskType: z.enum(TECH_TASK_TYPES),
  module: z.enum(TECH_MODULES),
  suggestedPriority: z.enum(TECH_PRIORITIES),
  /** Ý KIẾN của AI. Không bao giờ thành `tech_tasks.risk`. */
  suggestedRisk: z.enum(TECH_RISKS),
  /* Nói "R2" mà không nói vì sao thì người duyệt không có gì để cãi lại. */
  riskExplanation: z.string().trim().min(10).max(1000),
  suggestedAgent: z
    .string()
    .trim()
    .refine((v) => CTO_AGENT_KEYS.includes(v), { message: `vai agent không có thật — phải là một trong: ${CTO_AGENT_KEYS.join(", ")}` }),
  dependsOn: z.array(z.string().trim()).max(CTO_MAX_TASKS).default([]),
  /* Một việc không có tiêu chí nghiệm thu là một việc không ai biết lúc nào thì xong. */
  acceptanceCriteria: z.array(cau).min(1).max(10),
  expectedScope: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  needsHumanDecision: z.boolean().default(false),
  humanDecisionNote: z.string().trim().max(1000).default(""),
});

export const ctoPlanSchema = z
  .object({
    summary: z.string().trim().min(10).max(4000),
    /* Giả định AI TỰ NHẬN là đã đặt ra. Đọc được thì mới cãi lại được. */
    assumptions: z.array(cau).max(20).default([]),
    /* Chỗ AI thiếu dữ liệu. Rỗng là hợp lệ, nhưng một kế hoạch không câu hỏi nào trên một mục
       tiêu mơ hồ là dấu hiệu AI đang đoán thay vì hỏi. */
    questions: z.array(cau).max(20).default([]),
    tasks: z.array(ctoTaskSchema).min(1).max(CTO_MAX_TASKS),
  })
  .superRefine((plan, ctx) => {
    const keys = new Set<string>();
    for (const t of plan.tasks) {
      if (keys.has(t.key)) {
        ctx.addIssue({ code: "custom", message: `khoá việc trùng: ${t.key} — \`dependsOn\` sẽ trỏ vào chỗ nhập nhằng` });
      }
      keys.add(t.key);
    }
    for (const t of plan.tasks) {
      for (const d of t.dependsOn) {
        if (!keys.has(d)) {
          ctx.addIssue({ code: "custom", message: `${t.key} phụ thuộc \`${d}\` nhưng bản kế hoạch không có việc nào mang khoá đó` });
        }
        if (d === t.key) {
          ctx.addIssue({ code: "custom", message: `${t.key} phụ thuộc chính nó` });
        }
      }
    }
    /*
      VÒNG PHỤ THUỘC LÀ MỘT KẾ HOẠCH KHÔNG BAO GIỜ BẮT ĐẦU ĐƯỢC.

      Không bắt ở đây thì màn hình vẽ một đồ thị đẹp đẽ mà không việc nào đủ điều kiện làm trước,
      và người đọc mất một lúc mới nhận ra vì sao. Sắp xếp tô-pô, còn dư là còn vòng.
    */
    const conLai = new Map(plan.tasks.map((t) => [t.key, new Set(t.dependsOn.filter((d) => keys.has(d)))]));
    let doi = true;
    while (doi) {
      doi = false;
      for (const [k, deps] of conLai) {
        if (deps.size === 0) {
          conLai.delete(k);
          for (const other of conLai.values()) other.delete(k);
          doi = true;
        }
      }
    }
    if (conLai.size > 0) {
      ctx.addIssue({ code: "custom", message: `phụ thuộc thành vòng, không việc nào bắt đầu được: ${[...conLai.keys()].join(" → ")}` });
    }
  });

export type CtoPlan = z.infer<typeof ctoPlanSchema>;
export type CtoPlanTask = z.infer<typeof ctoTaskSchema>;

export type CtoParseResult = { ok: true; plan: CtoPlan } | { ok: false; error: string };

/**
 * Đọc bản kế hoạch từ văn bản model trả về.
 *
 * Chấp nhận một khối ```json … ``` bọc ngoài vì model hay gói vào đó — nhưng KHÔNG đi xa hơn:
 * không dò dấu ngoặc, không vá JSON hỏng, không đoán trường thiếu. Cắt hàng rào code là một phép
 * BỎ VỎ xác định được; mọi thứ khác là đoán.
 */
export function parseCtoPlan(raw: string): CtoParseResult {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Không đọc được JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = ctoPlanSchema.safeParse(data);
  if (!r.success) {
    const loi = r.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(gốc)"}: ${i.message}`);
    return { ok: false, error: `Bản kế hoạch không hợp lệ — ${loi.join(" · ")}` };
  }
  return { ok: true, plan: r.data };
}
