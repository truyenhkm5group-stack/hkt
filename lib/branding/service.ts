/**
 * ═══════════ THƯƠNG HIỆU CỦA TỔ CHỨC (Phase 10 · §4) — CHỈ MÁY CHỦ ═══════════
 *
 * Tệp THƯỜNG (không "use server") để bài kiểm gọi được với một `SessionUser` dựng tay; server action ở
 * `lib/actions/branding.ts` chỉ đọc phiên rồi gọi vào đây. Mọi lượt đọc / ghi đi qua `getDb()` — CSDL của tổ chức NGỮ
 * CẢNH — nên tổ chức A không có đường nào chạm tới cài đặt hay logo của B (không tham số nào nhận mã tổ chức).
 *
 * Logo nằm trong `custom_files` của CSDL tổ chức (khuôn tệp sẵn có của field `file`, `object_key = org_branding` — không
 * đối tượng nào mang khoá này nên route tải tệp metadata không bao giờ trả nó ra). Trần 512 KB, kiểu theo CHỮ KÝ BYTE.
 * Tổ chức nhà: không ghi — nhà giữ nguyên giao diện hiện tại.
 */
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { checkEntitlement } from "@/lib/entitlements/check";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { accentCss, BRANDING_NAME_MAX, BRANDING_SETTING_KEY, isAccentKey, LOGO_MAX_BYTES, sanitizeBranding, sniffImageMime, type LogoMime, type OrgBranding } from "@/lib/branding/accents";

export const LOGO_OBJECT_KEY = "org_branding";
const LOGO_RECORD_ID = "org";
const LOGO_FIELD_KEY = "logo";

export type BrandingResult = { ok: true; branding: OrgBranding } | { error: string };

/** Thương hiệu đã lưu của tổ chức NGỮ CẢNH (sạch). */
export async function getBranding(): Promise<OrgBranding> {
  return sanitizeBranding(await getSettingJson<unknown>(BRANDING_SETTING_KEY, null));
}

/** Thứ thanh đầu + bố cục cần. `null` ⇒ tổ chức nhà (giữ nguyên giao diện) hoặc phiên không mang tổ chức. */
export type OrgBrand = { name: string; logoUrl: string | null; accentCss: string | null };

export async function getOrgBrand(user: Pick<SessionUser, "organization">): Promise<OrgBrand | null> {
  if (!user.organization || user.organization.isHome) return null;
  const b = await getBranding();
  return {
    name: b.displayName ?? user.organization.name,
    logoUrl: b.logoFileId ? `/api/branding/logo?v=${b.logoFileId.slice(0, 8)}` : null,
    accentCss: accentCss(b.accent),
  };
}

function denial(user: SessionUser): string | null {
  if (!can(user, "settings:manage")) return "Bạn không có quyền đổi thương hiệu của tổ chức (cần quyền cài đặt).";
  if (!user.organization) return "Phiên chưa gắn tổ chức — đăng nhập lại.";
  if (user.organization.isHome) return "Tổ chức nhà giữ nguyên giao diện hiện tại — thương hiệu chỉ áp cho tổ chức khác.";
  return null;
}

/** Lưu tên hiển thị + màu nhấn (logo đi đường riêng). */
export async function saveBrandingCore(user: SessionUser, input: unknown): Promise<BrandingResult> {
  const deny = denial(user);
  if (deny) return { error: deny };
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawName = typeof o.displayName === "string" ? o.displayName.trim() : "";
  if (rawName.length > BRANDING_NAME_MAX) return { error: `Tên hiển thị tối đa ${BRANDING_NAME_MAX} ký tự.` };
  if (o.accent !== null && o.accent !== undefined && o.accent !== "" && !isAccentKey(o.accent)) return { error: "Màu nhấn phải chọn trong tám màu có sẵn." };
  const before = await getBranding();
  const after: OrgBranding = sanitizeBranding({ displayName: rawName || null, accent: isAccentKey(o.accent) ? o.accent : null, logoFileId: before.logoFileId });
  await setSettingJson(BRANDING_SETTING_KEY, after);
  await audit({ userId: user.id, userEmail: user.email, action: "BRANDING_UPDATE", entity: "SETTING", entityId: BRANDING_SETTING_KEY, before, after });
  return { ok: true, branding: after };
}

/** Tải logo mới (thay logo cũ). Kiểm: quyền · kích thước · chữ ký byte · hạn mức dung lượng của gói. */
export async function uploadLogoCore(user: SessionUser, file: { data: Uint8Array; filename?: string }): Promise<BrandingResult> {
  const deny = denial(user);
  if (deny) return { error: deny };
  const data = file?.data;
  if (!(data instanceof Uint8Array) || data.length === 0) return { error: "Tệp rỗng." };
  if (data.length > LOGO_MAX_BYTES) return { error: `Logo tối đa ${LOGO_MAX_BYTES / 1024} KB.` };
  const mime = sniffImageMime(data);
  if (!mime) return { error: "Logo phải là ảnh PNG, JPEG hoặc WebP." };
  const ent = await checkEntitlement("storageMb", data.length / (1024 * 1024));
  if (!ent.ok) return { error: ent.error };

  const db = await getDb();
  const before = await getBranding();
  const [row] = await db
    .insert(schema.customFiles)
    .values({ objectKey: LOGO_OBJECT_KEY, recordId: LOGO_RECORD_ID, fieldKey: LOGO_FIELD_KEY, filename: `logo.${mime.split("/")[1]}`, mime, size: data.length, data: Buffer.from(data), createdBy: user.id })
    .returning({ id: schema.customFiles.id });
  const after: OrgBranding = { ...before, logoFileId: row.id };
  await setSettingJson(BRANDING_SETTING_KEY, after);
  // Logo cũ không còn ai trỏ tới — xoá để không chiếm dung lượng của gói.
  await db.delete(schema.customFiles).where(and(eq(schema.customFiles.objectKey, LOGO_OBJECT_KEY), ne(schema.customFiles.id, row.id)));
  await audit({ userId: user.id, userEmail: user.email, action: "BRANDING_LOGO_UPLOAD", entity: "SETTING", entityId: BRANDING_SETTING_KEY, before: { logoFileId: before.logoFileId }, after: { logoFileId: row.id, mime, size: data.length } });
  return { ok: true, branding: after };
}

export async function removeLogoCore(user: SessionUser): Promise<BrandingResult> {
  const deny = denial(user);
  if (deny) return { error: deny };
  const before = await getBranding();
  const after: OrgBranding = { ...before, logoFileId: null };
  await setSettingJson(BRANDING_SETTING_KEY, after);
  const db = await getDb();
  await db.delete(schema.customFiles).where(eq(schema.customFiles.objectKey, LOGO_OBJECT_KEY));
  await audit({ userId: user.id, userEmail: user.email, action: "BRANDING_LOGO_REMOVE", entity: "SETTING", entityId: BRANDING_SETTING_KEY, before: { logoFileId: before.logoFileId }, after: { logoFileId: null } });
  return { ok: true, branding: after };
}

/** Byte logo của tổ chức NGỮ CẢNH, hoặc `null`. Kiểu đọc LẠI theo chữ ký byte (không tin cột `mime`). */
export async function readLogo(): Promise<{ mime: LogoMime; data: Buffer } | null> {
  const b = await getBranding();
  if (!b.logoFileId) return null;
  const db = await getDb();
  const row = await db.query.customFiles.findFirst({ where: and(eq(schema.customFiles.id, b.logoFileId), eq(schema.customFiles.objectKey, LOGO_OBJECT_KEY)) });
  if (!row) return null;
  const data = Buffer.from(row.data as Uint8Array);
  const mime = sniffImageMime(data);
  return mime ? { mime, data } : null;
}

