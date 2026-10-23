"use server";

/**
 * Cấu hình module Tìm hàng nguồn (SRC-1): trần lượt AI / ngày và tham số giá về Việt Nam. Ghi = quyền `sourcing:approve` (mặc
 * định chỉ ADMIN — chủ shop): đây là tham số tiền và trần chi phí, không phải thao tác hằng ngày. Mỗi lần lưu có lý do + nhật ký.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import {
  DEFAULT_SOURCING_LIMITS,
  EMPTY_LANDED_COST,
  EMPTY_SCORE_WEIGHTS,
  SOURCING_SCORE_WEIGHTS_KEY,
  parseScoreWeights,
  type SourcingScoreWeights,
  SOURCING_AI_CALLS_MAX,
  SOURCING_LANDED_COST_KEY,
  SOURCING_LIMITS_KEY,
  parseLandedCost,
  parseSourcingLimits,
  type LandedCostConfig,
} from "@/lib/constants/sourcing";
import { getSettingJson, setSettingJson } from "@/lib/settings";

export type SourcingSettingsResult = { ok: true; message: string } | { ok: false; errors: { message: string }[] };

const fail = (message: string): SourcingSettingsResult => ({ ok: false, errors: [{ message }] });

const limitsSchema = z.object({
  aiCallsPerDay: z.number().int("Số lượt phải là số nguyên").min(0, "Không được âm").max(SOURCING_AI_CALLS_MAX, `Tối đa ${SOURCING_AI_CALLS_MAX} lượt / ngày`),
  reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự)").max(500),
});

const so = z.number().finite().min(0, "Không được âm").nullable();
const landedSchema = z.object({
  cnyToVnd: so,
  fxAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày dạng YYYY-MM-DD").nullable(),
  fxSource: z.string().trim().max(200),
  cnDomesticShipCny: so,
  intlFreightVndPerKg: so,
  agentFeePercent: z.number().finite().min(0).max(100, "Tối đa 100%").nullable(),
  dutyVatPercent: z.number().finite().min(0).max(100, "Tối đa 100%").nullable(),
  otherVndPerUnit: so,
  reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự)").max(500),
});

async function guard(): Promise<{ id: string; email: string } | SourcingSettingsResult> {
  const user = await requireUser();
  if (!can(user, "sourcing:approve")) return fail("Cần quyền «Tìm hàng: duyệt & cấu hình» để đổi tham số này.");
  return { id: user.id, email: user.email };
}

export async function saveSourcingLimitsAction(input: unknown): Promise<SourcingSettingsResult> {
  const u = await guard();
  if ("ok" in u) return u;
  const parsed = limitsSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ");
  const before = parseSourcingLimits(await getSettingJson<unknown>(SOURCING_LIMITS_KEY, DEFAULT_SOURCING_LIMITS));
  const after = { aiCallsPerDay: parsed.data.aiCallsPerDay };
  await setSettingJson(SOURCING_LIMITS_KEY, after);
  await audit({ userId: u.id, userEmail: u.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: SOURCING_LIMITS_KEY, before, after, reason: parsed.data.reason });
  revalidatePath("/sourcing");
  return { ok: true, message: `Đã lưu trần ${after.aiCallsPerDay} lượt AI / ngày` };
}

export async function saveLandedCostAction(input: unknown): Promise<SourcingSettingsResult> {
  const u = await guard();
  if ("ok" in u) return u;
  const parsed = landedSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ");
  const before = parseLandedCost(await getSettingJson<unknown>(SOURCING_LANDED_COST_KEY, EMPTY_LANDED_COST));
  const after: LandedCostConfig = { ...parsed.data, setByEmail: u.email, setAt: new Date().toISOString() };
  await setSettingJson(SOURCING_LANDED_COST_KEY, after);
  await audit({ userId: u.id, userEmail: u.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: SOURCING_LANDED_COST_KEY, before, after, reason: parsed.data.reason });
  revalidatePath("/sourcing");
  return { ok: true, message: "Đã lưu tham số giá về Việt Nam" };
}

const weight = z.number().finite().min(0, "Trọng số không âm").max(100, "Trọng số tối đa 100").nullable();
const weightsSchema = z.object({
  supplier: z.object({ rating: weight, responseRate: weight, verified: weight, years: weight }),
  yearsCap: z.number().int("Trần số năm là số nguyên").min(1).max(100).nullable(),
  reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự)").max(500),
});

/** Trọng số điểm nhà cung cấp (SRC-4) — KHÔNG có bộ mặc định; để trống hết là «không tính điểm tổng». */
export async function saveScoreWeightsAction(input: unknown): Promise<SourcingSettingsResult> {
  const u = await guard();
  if ("ok" in u) return u;
  const parsed = weightsSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ");
  if ((parsed.data.supplier.years ?? 0) > 0 && parsed.data.yearsCap === null) return fail("Có trọng số cho số năm thì phải khai trần số năm (số năm coi là «đủ»).");
  const before = parseScoreWeights(await getSettingJson<unknown>(SOURCING_SCORE_WEIGHTS_KEY, EMPTY_SCORE_WEIGHTS));
  const after: SourcingScoreWeights = { ...parsed.data, setByEmail: u.email, setAt: new Date().toISOString() };
  await setSettingJson(SOURCING_SCORE_WEIGHTS_KEY, after);
  await audit({ userId: u.id, userEmail: u.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: SOURCING_SCORE_WEIGHTS_KEY, before, after, reason: parsed.data.reason });
  revalidatePath("/sourcing");
  return { ok: true, message: "Đã lưu trọng số điểm nhà cung cấp" };
}
