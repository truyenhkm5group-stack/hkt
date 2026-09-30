"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import { saveAdTestInfoSchema, type AdTestView, type ChatReply } from "@/lib/constants/chatbot-ad-bots";
import type { AdBotPushResult } from "@/lib/integrations/chatbot/ad-bots";
import { addAdTestColor, chatAdTest, loadAdTestView, removeAdTestColor, saveAdTestInfo, setAdTestLive } from "@/lib/integrations/chatbot/ad-test";

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

export async function loadAdTestAction(variantId: string): Promise<{ ok: true; view: AdTestView } | Fail> {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test (cần ideas:write hoặc cs:config)." };
  const v = await loadAdTestView(String(variantId ?? ""));
  return "error" in v ? { error: v.error } : { ok: true, view: v };
}

export async function saveAdTestInfoAction(raw: unknown) {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test (cần ideas:write hoặc cs:config)." } satisfies Fail;
  const p = saveAdTestInfoSchema.safeParse(raw);
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" } satisfies Fail;
  const r = await saveAdTestInfo(p.data, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_TEST", entityId: p.data.variantId, after: p.data });
  return done(r.push, "Đã lưu giá & chất vải.");
}

const colorSchema = z.object({ variantId: z.string().min(1).max(64), color: z.string().trim().min(1, "Nhập tên màu").max(40), mode: z.enum(["ORIGINAL", "AI"]) });

export async function addAdTestColorAction(raw: unknown) {
  const user = await requireUser();
  const p = colorSchema.safeParse(raw);
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" } satisfies Fail;
  if (p.data.mode === "AI" ? !can(user, "ideas:write") : !allowed(user)) return { error: p.data.mode === "AI" ? "Đổi màu bằng AI cần quyền gen ảnh (ideas:write)." : "Bạn không có quyền chat test." } satisfies Fail;
  const r = await addAdTestColor(p.data, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_TEST", entityId: p.data.variantId, after: { addColor: p.data.color, mode: p.data.mode } });
  return done(r.push, p.data.mode === "AI" ? `Đã tạo ảnh màu ${p.data.color}.` : `Đã thêm màu gốc ${p.data.color}.`);
}

export async function removeAdTestColorAction(variantId: string, sha: string) {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test." } satisfies Fail;
  const r = await removeAdTestColor({ variantId: String(variantId ?? ""), sha: String(sha ?? "") }, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SAVE", entity: "CHATBOT_AD_TEST", entityId: variantId, after: { removeColor: sha } });
  return done(r.push, "Đã bỏ màu.");
}

export async function setAdTestLiveAction(variantId: string, live: boolean) {
  const user = await requireUser();
  if (!allowed(user)) return { error: "Bạn không có quyền chat test." } satisfies Fail;
  const r = await setAdTestLive({ variantId: String(variantId ?? ""), live: live === true }, actorOf(user));
  if (!r.ok) return { error: r.error } satisfies Fail;
  await audit({ userId: user.id, userEmail: user.email, action: "CHATBOT_AD_BOT_SWITCH", entity: "CHATBOT_AD_TEST", entityId: variantId, after: { live: live === true } });
  return done(r.push, live ? "Đã BẬT: khách bấm quảng cáo này sẽ chat với bot mẫu test." : "Đã TẮT bot mẫu test cho khách thật.");
}

const chatSchema = z.object({
  variantId: z.string().min(1).max(64),
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
