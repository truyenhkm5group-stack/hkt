"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/session";
import { CONNECTIONS_PERMISSION, saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import type { ConnectionActionResult } from "@/lib/connectors/types";

/**
 * ═══════════ KẾT NỐI THEO TỔ CHỨC — BA SERVER ACTION ═══════════
 *
 * Vỏ mỏng: đọc phiên (`settings:manage`) → zod → lõi `lib/connectors/service.ts` (kiểm quyền lần hai,
 * kiểm từng ô theo sổ, mã hoá, nhật ký) → `revalidatePath`. Không trả bí mật: kết quả chỉ có trạng
 * thái + một câu tiếng Việt. Tổ chức lấy từ phiên do máy chủ ký — không có tham số nào chọn tổ chức.
 *
 * Không `router.refresh()` phía client — `revalidatePath` đã dựng lại trang (tiền lệ PR #272).
 */

const PATH = "/settings/connections";
const keySchema = z.string().trim().regex(/^[a-z][a-z0-9-]{1,60}$/, "Khoá connector không hợp lệ");
const fieldMap = z.record(z.string().max(80), z.string().max(2000)).default({});
const saveSchema = z.object({ connectorKey: keySchema, settings: fieldMap, secrets: fieldMap }).strict();

export async function saveConnectionAction(input: unknown): Promise<ConnectionActionResult> {
  const user = await requirePermission(CONNECTIONS_PERMISSION);
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const result = await saveConnection(user, parsed.data);
  if ("ok" in result) revalidatePath(PATH);
  return result;
}

export async function testConnectionAction(connectorKey: unknown): Promise<ConnectionActionResult> {
  const user = await requirePermission(CONNECTIONS_PERMISSION);
  const key = keySchema.safeParse(connectorKey);
  if (!key.success) return { error: key.error.issues[0]?.message ?? "Khoá connector không hợp lệ" };
  const result = await testOrgConnection(user, key.data);
  revalidatePath(PATH);
  return result;
}

export async function setConnectionStatusAction(input: unknown): Promise<ConnectionActionResult> {
  const user = await requirePermission(CONNECTIONS_PERMISSION);
  const parsed = z.object({ connectorKey: keySchema, status: z.enum(["ACTIVE", "DISABLED"]) }).strict().safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const result = await setConnectionStatus(user, parsed.data.connectorKey, parsed.data.status);
  if ("ok" in result) revalidatePath(PATH);
  return result;
}
