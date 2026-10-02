import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { REORDER_CYCLE_MAX, REORDER_SETTING_KEY, TOUCH_KINDS, TOUCH_OUTCOMES, TOUCH_KIND_LABEL, TOUCH_OUTCOME_LABEL, parseReorderSetting } from "@/lib/constants/reorder";
import { todayVN } from "@/lib/format";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * Ghi MỘT lượt liên hệ khách (`customers:write`) và sửa chu kỳ mua lại mặc định của tổ chức (`settings:manage`).
 * Người làm đi bằng khoá tài khoản; tên là ảnh chụp do máy chủ đọc từ phiên (luật 34).
 */

export type TouchResult = { ok: true; id: string; message: string } | MetaFailure;

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

const touchZ = z
  .object({
    kind: z.enum(TOUCH_KINDS, { error: "Chọn cách liên hệ" }),
    outcome: z.enum(TOUCH_OUTCOMES, { error: "Chọn kết quả" }),
    note: z.string().max(1000, "Ghi chú quá dài").default(""),
    nextContactOn: z.iso.date({ error: "Ngày hẹn không hợp lệ" }).nullable().default(null),
  })
  .strict();

export type TouchInput = z.input<typeof touchZ>;

export async function recordTouchpointCore(user: SessionUser, customerId: string, raw: unknown): Promise<TouchResult> {
  if (!can(user, "customers:write")) return fail("FORBIDDEN", "Bạn không có quyền ghi liên hệ khách (customers:write).");
  const parsed = touchZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  if (v.nextContactOn && v.nextContactOn <= todayVN()) return fail("INVALID", [{ field: "nextContactOn", message: "Ngày hẹn liên hệ lại phải sau hôm nay." }]);
  const db = await getDb();
  const [customer] = await db.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!customer) return fail("NOT_FOUND", "Không có khách này.");
  const [row] = await db
    .insert(schema.customerTouchpoints)
    .values({ customerId, kind: v.kind, outcome: v.outcome, note: v.note.trim(), nextContactOn: v.nextContactOn, userId: user.id, userName: user.name })
    .returning({ id: schema.customerTouchpoints.id });
  return { ok: true, id: row.id, message: `Đã ghi: ${TOUCH_KIND_LABEL[v.kind]} «${customer.name}» — ${TOUCH_OUTCOME_LABEL[v.outcome]}${v.nextContactOn ? `, hẹn lại ${v.nextContactOn}` : ""}.` };
}

const settingZ = z
  .object({
    defaultCycleDays: z.number().int("Số ngày là số nguyên").min(1).max(REORDER_CYCLE_MAX).nullable(),
    dueSoonDays: z.number().int().min(0).max(30),
  })
  .strict();

/** Chu kỳ mặc định là QUYẾT ĐỊNH KINH DOANH (luật 38) — trống = chưa khai, khách mới mua một lần là "chưa biết". */
export async function setReorderSettingCore(user: SessionUser, raw: unknown): Promise<TouchResult> {
  if (!can(user, "settings:manage")) return fail("FORBIDDEN", "Bạn không có quyền sửa cài đặt (settings:manage).");
  const parsed = settingZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const before = parseReorderSetting(await getSettingJson<Record<string, unknown>>(REORDER_SETTING_KEY, {}));
  await setSettingJson(REORDER_SETTING_KEY, parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTING", entityId: REORDER_SETTING_KEY, before, after: parsed.data, reason: "Chu kỳ mua lại mặc định + cửa sổ sắp đến hạn (nhắc mua lại)" });
  return { ok: true, id: REORDER_SETTING_KEY, message: parsed.data.defaultCycleDays === null ? "Đã bỏ chu kỳ mặc định — khách mới mua một lần là «chưa biết chu kỳ»." : `Chu kỳ mua lại mặc định: ${parsed.data.defaultCycleDays} ngày.` };
}
