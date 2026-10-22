/**
 * ═══ QUY CHẾ CHIA THƯỞNG LỢI NHUẬN (CỔNG LỖ LŨY KẾ) — LÕI GHI DÙNG CHUNG CỦA MÀN HÌNH VÀ JOB ═══
 *
 * `lib/actions/payroll-policy.ts::saveProfitGatePolicy` (người bấm ở Lương → Cấu hình) và
 * `scripts/payroll-owner-apply.ts` (Tech Lead thực hiện theo ủy quyền của chủ shop) đi qua ĐÚNG hàm này.
 * KHÔNG phải server action: chỗ gọi đã kiểm quyền «Khai báo lương» + «Duyệt lương» và truyền CỔNG DUYỆT.
 * Đặc tả: `docs/payroll-profit-gate.md`. Luật và câu chữ y như bản trước khi tách (22/10/2026).
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { listEmployees } from "@/lib/queries/payroll";
import { getSettingJson } from "@/lib/settings";
import { DEFAULT_PROFIT_GATE_CONFIG, PAYROLL_PROFIT_GATE_KEY, poolCapLabel, type ProfitGateConfig, type ProfitGatePolicy } from "@/lib/constants/payroll-profit-gate";
import type { GuardInput, GuardResult } from "@/lib/approvals/service";

export type ProfitGateActor = { id: string | null; email: string };
export type ProfitGateServiceOptions = { guard: (input: GuardInput) => Promise<GuardResult>; /** Thêm vào lý do của dòng nhật ký. */ auditNote?: string };

export const profitGateSchema = z
  .object({
    openingMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Tháng mở sổ phải dạng YYYY-MM"),
    openingCumulative: z.coerce.number().int("Số dư lũy kế là số nguyên VND").min(-1e13).max(1e13),
    openingHighWater: z.coerce.number().int("Mốc cao nhất đã chia là số nguyên VND").min(0, "Mốc cao nhất đã chia không âm"),
    openingPaidBonus: z.coerce.number().int().min(0, "Thưởng đã chi không âm").default(0),
    // Trống = không có trần chung (chỉ hợp lệ khi có lịch trần theo tháng) — KHÔNG phải 0%.
    poolCapPercent: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : v),
      z.coerce.number().gt(0, "Quỹ thưởng tối đa phải lớn hơn 0%").max(100, "Quỹ thưởng tối đa không vượt 100% lợi nhuận đủ điều kiện").nullable(),
    ),
    poolCapSchedule: z
      .array(
        z.object({
          fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mốc trần phải dạng YYYY-MM"),
          percent: z.coerce.number().gt(0, "Trần theo tháng phải lớn hơn 0%").max(100, "Trần theo tháng không vượt 100%"),
        }),
      )
      .max(36)
      .default([]),
    residualClaimantId: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().min(1).optional()),
    regulationRef: z.string().trim().min(3, "Ghi số hiệu / tên quy chế thưởng đang áp dụng").max(200),
    reason: z.string().trim().min(10, "Ghi căn cứ của số dư (biên bản đối soát, báo cáo tài chính…) — tối thiểu 10 ký tự").max(1000),
  })
  .refine((v) => v.poolCapPercent !== null || v.poolCapSchedule.length > 0, { message: "Khai quỹ thưởng tối đa (một con số) hoặc lịch trần theo tháng", path: ["poolCapPercent"] })
  .refine((v) => new Set(v.poolCapSchedule.map((m) => m.fromMonth)).size === v.poolCapSchedule.length, { message: "Lịch trần có hai mốc trùng tháng", path: ["poolCapSchedule"] })
  .refine((v) => v.poolCapSchedule.every((m) => m.fromMonth >= v.openingMonth), { message: "Mốc trần không được trước tháng mở sổ", path: ["poolCapSchedule"] })
  .refine((v) => v.openingHighWater >= Math.max(0, v.openingCumulative), {
    message:
      "Mốc cao nhất đã chia phải ≥ max(0, lợi nhuận lũy kế). Khai mốc thấp hơn lũy kế là cho phép chia lại phần lãi trước mốc mở sổ — đúng thứ quy chế này sinh ra để chặn.",
    path: ["openingHighWater"],
  });

export type ProfitGatePolicyInput = z.infer<typeof profitGateSchema>;

/**
 * ĐỌC – SỬA – GHI SỔ QUY CHẾ TRONG MỘT GIAO DỊCH CẦM KHOÁ TÊN.
 *
 * Quy chế và các dòng điều chỉnh nằm chung một ô `settings`. Hai lượt lưu gần nhau (một quy chế mới
 * và một điều chỉnh, hay hai điều chỉnh) mà cùng đọc rồi cùng ghi cả ô thì lượt sau xoá mất dòng của
 * lượt trước — một khoản lũy kế biến mất không dấu vết. Khoá tên tự nhả khi giao dịch kết thúc.
 */
export type GateTx = Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0];
export async function ghiSoCong(
  mutate: (cur: ProfitGateConfig, tx: GateTx) => Promise<ProfitGateConfig | { error: string }> | ProfitGateConfig | { error: string },
): Promise<{ truoc: ProfitGateConfig; sau: ProfitGateConfig } | { error: string }> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp:payroll-profit-gate'))`);
    const [row] = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PAYROLL_PROFIT_GATE_KEY)).limit(1);
    let raw: Partial<ProfitGateConfig> = {};
    try {
      raw = row ? (JSON.parse(row.value) as Partial<ProfitGateConfig>) : {};
    } catch {
      return { error: "Ô cấu hình quy chế chia thưởng không đọc được — không ghi đè lên nó." };
    }
    const truoc: ProfitGateConfig = { active: raw.active ?? null, history: Array.isArray(raw.history) ? raw.history : [], adjustments: Array.isArray(raw.adjustments) ? raw.adjustments : [] };
    const sau = await mutate(truoc, tx);
    if ("error" in sau) return sau;
    const text = JSON.stringify(sau);
    await tx.insert(schema.settings).values({ key: PAYROLL_PROFIT_GATE_KEY, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
    return { truoc, sau };
  });
}

/** Khai một PHIÊN BẢN quy chế mới (phiên bản cũ giữ trong lịch sử). `d` đã qua `profitGateSchema`. */
export async function saveProfitGatePolicyAs(actor: ProfitGateActor, d: ProfitGatePolicyInput, opts: ProfitGateServiceOptions): Promise<{ ok: true; version: number } | { error: string }> {
  if (d.residualClaimantId && !(await listEmployees()).some((e) => e.id === d.residualClaimantId)) {
    return { error: "Người nhận phần còn lại không có trong danh sách nhân sự của bảng lương" };
  }
  const truoc = await getSettingJson<ProfitGateConfig>(PAYROLL_PROFIT_GATE_KEY, DEFAULT_PROFIT_GATE_CONFIG);
  const history = Array.isArray(truoc.history) ? truoc.history : [];
  const ban: ProfitGatePolicy = {
    version: history.reduce((m, h) => Math.max(m, h.version), 0) + 1,
    openingMonth: d.openingMonth,
    openingCumulative: d.openingCumulative,
    openingHighWater: d.openingHighWater,
    openingPaidBonus: d.openingPaidBonus,
    poolCapPercent: d.poolCapPercent,
    poolCapSchedule: [...d.poolCapSchedule].sort((x, y) => x.fromMonth.localeCompare(y.fromMonth)),
    residualClaimant: d.residualClaimantId ? { employeeId: d.residualClaimantId } : null,
    regulationRef: d.regulationRef,
    reason: d.reason,
    approvedById: actor.id,
    approvedByEmail: actor.email,
    approvedAt: new Date().toISOString(),
  };

  const cong = await opts.guard({
    group: "PAYROLL_EDIT",
    action: "payroll.profit-gate.policy",
    entity: "SETTINGS",
    entityId: PAYROLL_PROFIT_GATE_KEY,
    summary: `Quy chế chia thưởng lợi nhuận v${ban.version}: mở sổ ${ban.openingMonth}, lũy kế ${ban.openingCumulative.toLocaleString("vi-VN")} ₫, quỹ tối đa ${poolCapLabel(ban)} LN đủ điều kiện${ban.residualClaimant ? ` · phần còn lại cho ${ban.residualClaimant.employeeId}` : ""}`,
    amount: null,
    payload: d,
  });
  if (cong.mode === "NEEDS_APPROVAL") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}). Đã gửi yêu cầu — xem ở trang Cảnh báo.` };
  if (cong.mode === "BLOCKED_NO_APPROVER") return { error: `Việc này cần người thứ hai duyệt (${cong.reason}), nhưng chưa có ai khác đủ tư cách duyệt.` };

  let version = ban.version;
  const ghi = await ghiSoCong((cur) => {
    const moi: ProfitGatePolicy = { ...ban, version: cur.history.reduce((m, h) => Math.max(m, h.version), 0) + 1 };
    version = moi.version;
    return { active: moi, history: [...cur.history, moi], adjustments: cur.adjustments };
  });
  if ("error" in ghi) return ghi;
  await audit({
    userId: actor.id,
    userEmail: actor.email,
    action: "PAYROLL_PROFIT_GATE_POLICY",
    entity: "SETTINGS",
    entityId: PAYROLL_PROFIT_GATE_KEY,
    before: ghi.truoc.active,
    after: ghi.sau.active,
    reason: [`${d.regulationRef} — ${d.reason}`, opts.auditNote].filter(Boolean).join(" · "),
  });
  return { ok: true, version };
}
