"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { REASON_PASSWORD_CHANGED } from "@/lib/constants/session-revocation";
import { completePasswordResetCore, createResetLinkAsOperator, createResetLinkCore } from "@/lib/users/password-reset";

/** Vỏ Next của liên kết đặt lại mật khẩu. Lõi (`lib/users/password-reset.ts`) kiểm lại quyền / người vận hành / mã. */

export type ResetLinkResult = { ok: true; link: string; expiresAt: string; email: string } | { error: string };

export async function createResetLinkAction(targetUserId: string): Promise<ResetLinkResult> {
  const user = await requirePermission("users:manage");
  const r = await createResetLinkCore(user, String(targetUserId ?? ""));
  return "error" in r ? r : { ok: true, link: r.link, expiresAt: r.expiresAt.toISOString(), email: r.email };
}

export async function createResetLinkAsOperatorAction(input: { orgCode: string; email: string; reason: string }): Promise<ResetLinkResult> {
  const user = await requirePermission("platform:operate");
  const r = await createResetLinkAsOperator(user, input ?? {});
  return "error" in r ? r : { ok: true, link: r.link, expiresAt: r.expiresAt.toISOString(), email: r.email };
}

/** Trang công khai `/reset/<tổ chức>/<mã>`: đặt xong ⇒ về màn đăng nhập với câu «Đã đổi mật khẩu». */
export async function completePasswordResetAction(org: string, token: string, input: unknown): Promise<{ error: string }> {
  const ip = clientIpFrom((await headers()).get("x-forwarded-for"));
  const r = await completePasswordResetCore(String(org ?? ""), String(token ?? ""), input, { ip });
  if ("error" in r) return { error: r.error };
  redirect(`/login?reason=${REASON_PASSWORD_CHANGED}`);
}
