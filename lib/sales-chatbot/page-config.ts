/**
 * LƯU PHẦN ĐÈ CẤU HÌNH AI CỦA MỘT PAGE (luật ở `page-config-shared.ts`). Chỉ người cấu hình bot; chỉ page đang nối / có hội
 * thoại của tổ chức ngữ cảnh; `null` = bỏ phần đè, page dùng lại cấu hình tổ chức. Nhật ký mỗi lượt.
 */
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { readJsonSetting } from "@/lib/sales-chatbot/engine";
import { inboxPages } from "@/lib/sales-chatbot/inbox";
import { PAGE_OVERRIDES_SETTING_KEY, pageOverrideZ, parsePageOverrides, type PageOverride, type PageOverrides } from "@/lib/sales-chatbot/page-config-shared";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";
import { setSettingJson } from "@/lib/settings";

export async function loadPageOverrides(): Promise<PageOverrides> {
  return parsePageOverrides(await readJsonSetting(PAGE_OVERRIDES_SETTING_KEY));
}

export async function savePageOverride(user: SessionUser, pageId: unknown, raw: unknown): Promise<{ ok: true; message: string } | { error: string }> {
  if (!can(user, SALES_CHATBOT_MANAGE)) return { error: "Bạn không có quyền cấu hình chatbot bán hàng (ai_sales:manage)." };
  const id = typeof pageId === "string" ? pageId.trim() : "";
  if (!(await inboxPages()).some((p) => p.id === id)) return { error: "Không có page này trong tổ chức." };
  const all = await loadPageOverrides();
  const before = all[id] ?? null;
  if (raw === null) {
    delete all[id];
  } else {
    // GỘP với phần đè đang có: trường có trong lượt lưu thì đặt; ô để trống = BỎ đè trường đó (dùng của tổ chức), không phải
    // «đè bằng chuỗi rỗng». Trường không có trong lượt lưu giữ nguyên.
    const next: Record<string, unknown> = { ...(before ?? {}) };
    for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim() === "") delete next[k];
      else next[k] = v;
    }
    const parsed = pageOverrideZ.safeParse(next);
    if (!parsed.success) return { error: "Cấu hình riêng của page không hợp lệ." };
    if (!Object.keys(parsed.data).length) delete all[id];
    else all[id] = parsed.data as PageOverride;
  }
  await setSettingJson(PAGE_OVERRIDES_SETTING_KEY, all);
  await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHATBOT_PAGE_OVERRIDE", entity: "SETTING", entityId: `${PAGE_OVERRIDES_SETTING_KEY}:${id}`, before, after: all[id] ?? null, reason: "Cấu hình AI riêng cho page" });
  return { ok: true, message: all[id] ? "Đã lưu cấu hình riêng cho page — các mục để trống dùng cấu hình chung." : "Page dùng lại cấu hình chung." };
}
