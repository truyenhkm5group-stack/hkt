"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import { addManualAdSchema, saveAdTestInfoSchema, setAdTestPageSchema, type AdTestView, type ChatReply } from "@/lib/constants/chatbot-ad-bots";
import type { AdBotPushResult } from "@/lib/integrations/chatbot/ad-bots";
import { addAdTestColor, addManualAd, chatAdTest, loadAdTestView, removeAdTestColor, removeManualAd, saveAdTestInfo, setAdTestLive, setAdTestPage, uploadAdTestColor } from "@/lib/integrations/chatbot/ad-test";

/**
 * Nút "Chat test" ở Thư viện Media · tab ④. Người chạy camp (ideas:write) hoặc người giữ kịch bản bot (cs:config) đều dùng
 * được. Đổi màu bằng AI TỐN TIỀN nên đòi ideas:write — cùng quyền với nút "Sửa ảnh". Tên người sửa do máy chủ đọc (mục 34).
 */

type Fail = { error: string };
const PATHS = ["/marketing/creatives", "/chatbot/ad-bots"];

function allowed(user: SessionUser): boolean {
  return can(user, "ideas:write") || can(user, "cs:config");
}
const actorOf = (u: SessionUser) => ({ id: u.id, name: u.name || u.email });

function done(push: AdBotPushResult, ok: string): { ok: true; message: string; warning: string | null } {
  for (const p of PATHS) revalidatePath(p);
  return { ok: true, message: ok, warning: push.ok ? null : `Đã lưu nhưng chưa gửi được sang bot: ${push.error}` };
}

export async function loadAdTestAction(campKey: string): Promise<{ ok: true; view: AdTestView } | Fail> {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test (cần ideas:write hoặc cs:config)." };
  const v = await loadAdTestView(String(campKey ?? ""));
  return "error" in v ? { error: v.error } : { ok: true, view: v };
}

export async function saveAdTestInfoAction(raw: unknown) {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test (cần ideas:write hoặc cs:config)." } satisfies Fail;
  const p = saveAdTestInfoSchema.safeParse(raw);
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" } satisfies Fail;
  const r = await saveAdTestInfo(p.data, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_TEST", entityId: p.data.campKey, after: p.data });
  return done(r.push, "Đã lưu giá & chất vải.");
}

const colorSchema = z.object({ campKey: z.string().min(1).max(64), color: z.string().trim().min(1, "Nhập tên màu").max(40), mode: z.enum(["ORIGINAL", "AI"]) });

export async function addAdTestColorAction(raw: unknown) {
  const user = await requireUser();
  const p = colorSchema.safeParse(raw);
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" } satisfies Fail;
  if (p.data.mode === "AI" ? !can(user, "ideas:write") : !allowed(user)) return { error: p.data.mode === "AI" ? "Đổi màu bằng AI cần quyền gen ảnh (ideas:write)." : "Bạn không có quyền chat test." } satisfies Fail;
  const r = await addAdTestColor(p.data, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_TEST", entityId: p.data.campKey, after: { addColor: p.data.color, mode: p.data.mode } });
  return done(r.push, p.data.mode === "AI" ? `Đã tạo ảnh màu ${p.data.color}.` : `Đã thêm màu gốc ${p.data.color}.`);
}

export async function removeAdTestColorAction(campKey: string, sha: string) {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test." } satisfies Fail;
  const r = await removeAdTestColor({ campKey: String(campKey ?? ""), sha: String(sha ?? "") }, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_TEST", entityId: campKey, after: { removeColor: sha } });
  return done(r.push, "Đã bỏ màu.");
}

export async function setAdTestLiveAction(campKey: string, live: boolean) {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test." } satisfies Fail;
  const r = await setAdTestLive({ campKey: String(campKey ?? ""), live: live === true }, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SWITCH", entity: "CHATBOT_AD_TEST", entityId: campKey, after: { live: live === true } });
  return done(r.push, live ? "Đã BẬT: khách bấm quảng cáo này sẽ chat với bot mẫu test." : "Đã TẮT bot mẫu test cho khách thật.");
}

const chatSchema = z.object({
  campKey: z.string().min(1).max(64),
  history: z.array(z.object({ role: z.enum(["user", "model"]), text: z.string().max(2000) })).min(1).max(40),
});

export async function chatAdTestAction(raw: unknown): Promise<{ ok: true; reply: ChatReply } | Fail> {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test." };
  const p = chatSchema.safeParse(raw);
  if (!p.success) return { error: "Tin nhắn không hợp lệ" };
  const r = await chatAdTest(p.data);
  return r.ok ? { ok: true, reply: r.reply } : { error: r.error };
}

/** Tải ảnh một màu lên (FormData: campKey, color, file). Không gọi AI, không tốn tiền. */
export async function uploadAdTestColorAction(fd: FormData) {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test." } satisfies Fail;
  const campKey = String(fd.get("campKey") ?? "");
  const color = String(fd.get("color") ?? "").trim();
  const file = fd.get("file");
  if (!campKey || !color) return { error: "Nhập tên màu." } satisfies Fail;
  if (!(file instanceof File) || file.size === 0) return { error: "Chọn ảnh cần tải lên." } satisfies Fail;
  const r = await uploadAdTestColor({ campKey, color: color.slice(0, 40), bytes: new Uint8Array(await file.arrayBuffer()) }, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_TEST", entityId: campKey, after: { uploadColor: color } });
  return done(r.push, `Đã thêm màu ${color} (ảnh tải lên).`);
}

export async function setAdTestPageAction(raw: unknown) {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test." } satisfies Fail;
  const p = setAdTestPageSchema.safeParse(raw);
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" } satisfies Fail;
  const r = await setAdTestPage(p.data, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_TEST", entityId: p.data.campKey, after: { pageId: p.data.pageId } });
  return done(r.push, "Đã chọn fanpage cho camp.");
}

/** Khai quảng cáo DỰNG TAY trên Facebook ⇒ trả khoá camp để mở khung Chat test. */
export async function addManualAdAction(raw: unknown): Promise<{ ok: true; campKey: string } | Fail> {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test (cần ideas:write hoặc cs:config)." };
  const p = addManualAdSchema.safeParse(raw);
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const r = await addManualAd(p.data, actorOf(user));
  if (!r.ok) return { error: r.error };
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_TEST", entityId: r.campKey, after: p.data });
  for (const path of PATHS) revalidatePath(path);
  return { ok: true, campKey: r.campKey };
}

export async function removeManualAdAction(adId: string) {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test." } satisfies Fail;
  const r = await removeManualAd(String(adId ?? ""));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SWITCH", entity: "CHATBOT_AD_TEST", entityId: adId, after: { removedManualAd: true } });
  return done(r.push, "Đã bỏ quảng cáo dựng tay — bot thôi dùng bot riêng của nó.");
}
