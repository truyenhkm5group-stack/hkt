"use server";

import { revalidatePath } from "next/cache";
import { can, requireUser } from "@/lib/auth/session";
import { currentOrganization } from "@/lib/platform/context";
import { checkDomainSlug, publishOrganization, PUBLISH_PERMISSION, setDomainSlug, type Publication, type PublishCheck } from "@/lib/platform/publish";

/**
 * Server action của «Thiết lập & xuất bản» (0180) — mỏng: phiên → lõi `lib/platform/publish.ts` (quyền, kiểm, ghi, nhật
 * ký). Tổ chức luôn là tổ chức của PHIÊN; client không gửi mã tổ chức nào.
 */

export async function checkDomainSlugAction(slug: string): Promise<{ ok: true; url: string | null } | { error: string }> {
  const user = await requireUser();
  if (!can(user, PUBLISH_PERMISSION)) return { error: "Bạn không có quyền đổi tên miền của tổ chức (settings:manage)." };
  const ctx = await currentOrganization();
  const r = await checkDomainSlug(slug, ctx.code);
  return r.ok ? { ok: true, url: r.url } : { error: r.error };
}

export async function setDomainSlugAction(slug: string): Promise<{ ok: true; message: string; publication: Publication } | { error: string }> {
  const user = await requireUser();
  const r = await setDomainSlug(user, slug);
  if (!r.ok) return { error: r.error };
  revalidatePath("/setup");
  return { ok: true, message: r.message, publication: r.publication };
}

export async function publishAction(): Promise<{ ok: true; message: string; publication: Publication } | { error: string; checks?: PublishCheck[] }> {
  const user = await requireUser();
  const r = await publishOrganization(user);
  if (!r.ok) return { error: r.error, checks: r.checks };
  revalidatePath("/", "layout");
  return { ok: true, message: r.message, publication: r.publication };
}
