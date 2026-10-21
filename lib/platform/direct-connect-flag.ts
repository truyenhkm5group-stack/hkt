import { and, eq, inArray } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import {
  DIRECT_CONNECT_MAX_ORGS,
  DIRECT_CONNECT_MODES,
  DIRECT_CONNECT_OPEN_KEY,
  parseDirectConnectOpen,
  parseOrgCodeList,
  type DirectConnectMode,
  type DirectConnectOpen,
} from "@/lib/channels/direct-connect-shared";
import { platformAudit } from "@/lib/platform/audit";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

/**
 * Đọc cờ nền tảng `meta.direct-connect.open` ở control plane (CHỈ MÁY CHỦ). Thiếu dòng / thiếu bảng / CSDL hỏng ⇒ ĐÓNG — không
 * bao giờ mở nhầm cho khách vì một lỗi đọc. Luật ở `lib/channels/direct-connect-shared.ts`; người xem dùng `directConnectFor`.
 */
export async function readDirectConnectOpen(): Promise<DirectConnectOpen> {
  try {
    const pdb = await getPlatformDb();
    const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY) });
    return row ? parseDirectConnectOpen(row.value) : false;
  } catch {
    return false;
  }
}

/** Trạng thái cờ cho khung người vận hành: giá trị đang đọc + ai đặt lúc nào (không dòng ⇒ chưa từng đặt). */
export async function directConnectFlagState(): Promise<{ open: DirectConnectOpen; stored: boolean; updatedAt: string | null; updatedByEmail: string | null }> {
  try {
    const pdb = await getPlatformDb();
    const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY) });
    if (!row) return { open: false, stored: false, updatedAt: null, updatedByEmail: null };
    return { open: parseDirectConnectOpen(row.value), stored: true, updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null, updatedByEmail: row.updatedByEmail ?? null };
  } catch {
    return { open: false, stored: false, updatedAt: null, updatedByEmail: null };
  }
}

export type SetDirectConnectResult = { ok: true; changed: boolean; open: DirectConnectOpen } | { error: string };

const sameOpen = (a: DirectConnectOpen, b: DirectConnectOpen) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join(",") === [...b].sort().join(","));

/**
 * ĐƯỜNG GHI DUY NHẤT của cờ (đóng MM-FU-712, 17/10/2026). Trước bản này cờ chỉ mở được bằng sửa CSDL, nên cửa hàng dựng cho người
 * duyệt Meta App Review thấy ô «sắp mở» thay cho nút «Kết nối Facebook Page» — người duyệt không tự kiểm được luồng.
 *  · Chỉ người vận hành nền tảng (`platformOperatorDenial`), bắt buộc lý do — mọi lượt đổi vào `platform_audit_log` (`FLAG_SET`).
 *  · `ORGS`: mỗi mã phải là cửa hàng CÓ THẬT, đang `ACTIVE`, không phải tổ chức nhà (người vận hành vốn đã thấy nút). Mã lạ ⇒ từ
 *    chối cả lượt, không ghi phần đúng — mở nhầm một khách thật vì gõ sai một ký tự là thứ không được xảy ra.
 *  · `ALL` chỉ dành cho ngày Meta duyệt (MM-META-01) — mở sớm là hứa với mọi khách một nút chưa chạy được.
 *  · Nhật ký ghi hỏng ⇒ hoàn lại giá trị cũ rồi báo lỗi (cùng khuôn `setSignupSetting`).
 */
export async function setDirectConnectOpen(user: SessionUser, input: unknown): Promise<SetDirectConnectResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const raw = (input && typeof input === "object" ? input : {}) as { mode?: unknown; orgCodes?: unknown; reason?: unknown };
  const mode = DIRECT_CONNECT_MODES.find((m) => m === raw.mode) as DirectConnectMode | undefined;
  if (!mode) return { error: "Chế độ chỉ nhận CLOSED · ORGS · ALL." };
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (reason.length < 5) return { error: "Ghi lý do (ít nhất 5 ký tự) — nó vào nhật ký nền tảng." };
  if (reason.length > 500) return { error: "Lý do dài quá 500 ký tự." };

  const home = await getHomeOrganization();
  let next: DirectConnectOpen;
  if (mode === "CLOSED") next = false;
  else if (mode === "ALL") next = true;
  else {
    const { codes, invalid } = parseOrgCodeList(typeof raw.orgCodes === "string" ? raw.orgCodes : "");
    if (invalid.length) return { error: `Mã cửa hàng không hợp lệ (chỉ chữ thường, số, gạch nối): ${invalid.join(", ")}` };
    if (!codes.length) return { error: "Chế độ «Chỉ các cửa hàng được liệt kê» cần ít nhất một mã cửa hàng." };
    if (codes.length > DIRECT_CONNECT_MAX_ORGS) return { error: `Tối đa ${DIRECT_CONNECT_MAX_ORGS} cửa hàng — danh sách này cho cửa hàng thử / người duyệt Meta.` };
    if (codes.includes(home.code)) return { error: `«${home.code}» là tổ chức nhà — người vận hành đã thấy nút thật, không cần liệt kê.` };
    const pdb = await getPlatformDb();
    const found = await pdb
      .select({ code: schema.platformOrganizations.code, status: schema.platformOrganizations.status })
      .from(schema.platformOrganizations)
      .where(and(inArray(schema.platformOrganizations.code, codes), eq(schema.platformOrganizations.isHome, false)));
    const missing = codes.filter((c) => !found.some((f) => f.code === c));
    if (missing.length) return { error: `Không có cửa hàng mã: ${missing.join(", ")} — kiểm lại mã ở bảng tổ chức.` };
    const inactive = found.filter((f) => f.status !== "ACTIVE").map((f) => `${f.code} (${f.status})`);
    if (inactive.length) return { error: `Cửa hàng không ở trạng thái hoạt động: ${inactive.join(", ")}.` };
    next = [...codes].sort();
  }

  const before = await directConnectFlagState();
  if (before.stored && sameOpen(before.open, next)) return { ok: true, changed: false, open: before.open };

  const pdb = await getPlatformDb();
  const actor = { orgCode: user.organization!.code, userId: user.id, email: user.email };
  const set = { value: next, updatedAt: new Date(), updatedBy: `${actor.orgCode}:${actor.userId}`, updatedByEmail: actor.email };
  // Cột jsonb: drizzle tự tuần tự hoá giá trị (true / false / mảng chuỗi) — `parseDirectConnectOpen` đọc lại đúng ba dạng đó.
  await pdb.insert(schema.platformSettings).values({ key: DIRECT_CONNECT_OPEN_KEY, ...set }).onConflictDoUpdate({ target: schema.platformSettings.key, set });
  try {
    await platformAudit({ action: "FLAG_SET", targetOrgCode: home.code, subject: DIRECT_CONNECT_OPEN_KEY, before: before.stored ? before.open : null, after: next, reason, source: "UI", actor });
  } catch {
    if (before.stored) await pdb.update(schema.platformSettings).set({ value: before.open }).where(eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY));
    else await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY));
    return { error: "Không ghi được nhật ký nền tảng — đã hoàn lại cờ cũ, chưa đổi gì." };
  }
  return { ok: true, changed: true, open: next };
}
