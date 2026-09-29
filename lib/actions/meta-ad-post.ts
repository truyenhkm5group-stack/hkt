"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { decideScope } from "@/lib/auth/scope-guard";
import { IntegrationError } from "@/lib/integrations/http";
import { ConnectorUnavailableError } from "@/lib/platform/credentials";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { resolveAdPosts } from "@/lib/integrations/facebook/ad-post-resolver";
import { erpFanpageNames, loadAdPostErpContext, saveAdPostResolutions, type AdPostErpContext, type AdPostSaveResult } from "@/lib/integrations/facebook/ad-post-store";
import { emptyResolution, META_AD_POST_BATCH_MAX, META_AD_POST_ERROR_LABEL, parseAdIdList, postOpenUrl, type AdPostResolution } from "@/lib/constants/meta-ad-post";
import type { SessionUser } from "@/lib/auth/session";

/**
 * ═══════════ TRA / ĐỒNG BỘ MẨU QUẢNG CÁO → BÀI VIẾT ═══════════
 *
 * Hai hành động, hai quyền, cùng khoá của module Quảng cáo (không thêm khoá quyền mới — khoá mới
 * không tự tới các vai trò có mảng ghi đè trên production):
 *  · TRA  = `expenses:view` + phạm vi `ADS` khác NONE. Chỉ ĐỌC Meta, không ghi CSDL.
 *  · GHI  = `expenses:write`. Máy chủ TRA LẠI rồi mới ghi — không bao giờ nhận Post ID từ trình duyệt.
 *
 * Mọi lời gọi Graph chạy ở máy chủ bằng token System User của `FacebookAdsClient`; token không bao
 * giờ đi vào kết quả trả về, vào nhật ký, hay vào câu lỗi (`graphErrorInfo` đã che).
 */

export type AdPostRow = AdPostResolution & {
  /** Link mở bài: permalink Meta trả, hoặc link DỰNG từ page_id + post_id (`constructed`). */
  openUrl: { url: string; constructed: boolean } | null;
  erp: AdPostErpContext | null;
};

export type ResolveAdPostsResult =
  | { error: string }
  | { ok: true; rows: AdPostRow[]; invalid: { raw: string; reason: string }[]; duplicates: number; overflow: number; canSync: boolean };

export type SyncAdPostsResult = { error: string } | { ok: true; rows: AdPostRow[]; saved: AdPostSaveResult };

// ─── GIỚI HẠN TẦN SUẤT ─── Mỗi người tối đa 12 lượt / phút (mỗi lượt ≤ 50 mã). Trần KỸ THUẬT để một
// cú bấm liên hồi không đốt hạn mức Graph dùng chung với job đồng bộ chi tiêu; không phải ngưỡng nghiệp vụ.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const recentCalls = new Map<string, number[]>();

function rateLimited(userId: string, now = Date.now()): boolean {
  const calls = (recentCalls.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (calls.length >= RATE_MAX) {
    recentCalls.set(userId, calls);
    return true;
  }
  calls.push(now);
  recentCalls.set(userId, calls);
  return false;
}

async function guardRead(): Promise<{ user: SessionUser } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "expenses:view")) return { error: "Bạn chưa có quyền xem module Quảng cáo." };
  const decision = await decideScope("ADS", user, "expenses:view");
  if (decision.allow === "NONE") return { error: decision.reason || "Phạm vi dữ liệu của bạn không bao gồm Quảng cáo." };
  if (rateLimited(user.id)) return { error: "Bạn vừa tra quá nhiều lượt trong một phút — chờ một chút rồi thử lại." };
  return { user };
}

/** Kết nối Meta không dùng được cho cả lượt ⇒ mỗi mã một kết quả `NOT_CONFIGURED`, không ném lên trang. */
function isNotConfigured(error: unknown) {
  return error instanceof ConnectorUnavailableError || (error instanceof IntegrationError && /chưa cấu hình FACEBOOK_/.test(error.message));
}

async function runResolve(adIds: string[]): Promise<AdPostRow[]> {
  let results: AdPostResolution[];
  try {
    const graph = getFacebookAdsClient();
    results = await resolveAdPosts(adIds, { graph, erpPageNames: (ids) => erpFanpageNames(ids) });
  } catch (error) {
    if (!isNotConfigured(error)) throw error;
    const at = new Date().toISOString();
    results = adIds.map((id) => ({ ...emptyResolution(id, at), error: "NOT_CONFIGURED" as const, message: META_AD_POST_ERROR_LABEL.NOT_CONFIGURED }));
  }
  // Nhật ký CÓ CẤU TRÚC cho người gỡ lỗi: mã ổn định + mã Graph + fbtrace_id. Không token, không URL.
  for (const r of results) {
    if (!r.error) continue;
    console.warn(JSON.stringify({ evt: "meta_ad_post_error", adId: r.adId, code: r.error, graphCode: r.graphError?.code ?? null, graphSubcode: r.graphError?.subcode ?? null, fbtraceId: r.graphError?.fbtraceId ?? "" }));
  }
  const context = await loadAdPostErpContext(results.map((r) => ({ adId: r.adId, storyId: r.objectStoryId })));
  return results.map((r) => ({ ...r, openUrl: r.ok ? postOpenUrl(r) : null, erp: context.get(r.adId) ?? null }));
}

/**
 * Thứ đi xuống trình duyệt: bỏ câu chữ thô của Graph (đã che token nhưng vẫn là nguyên văn phản hồi
 * ngoài) — màn hình chỉ cần mã ổn định + câu của ERP. Bản đầy đủ chỉ nằm ở `fb_ads.resolve_error`.
 */
function forClient(rows: AdPostRow[]): AdPostRow[] {
  return rows.map((r) => (r.graphError ? { ...r, graphError: { ...r.graphError, message: "" } } : r));
}

function summary(rows: AdPostRow[]) {
  const byError: Record<string, number> = {};
  for (const r of rows) if (r.error) byError[r.error] = (byError[r.error] ?? 0) + 1;
  return { adIds: rows.map((r) => r.adId), found: rows.filter((r) => r.ok).length, byError };
}

const resolveInput = z.string().max(20_000, "Dán tối đa khoảng 50 mã mỗi lượt.");

/** TRA: một hoặc nhiều Ad ID (hoặc link `feed_demo_ad=`). Chỉ đọc Meta; không ghi CSDL. */
export async function resolveMetaAdPosts(input: string): Promise<ResolveAdPostsResult> {
  const parsed = resolveInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Đầu vào không hợp lệ." };
  const list = parseAdIdList(parsed.data);
  if (!list.adIds.length) {
    return list.invalid.length ? { error: `Không có mã quảng cáo hợp lệ: ${list.invalid[0].reason}` } : { error: "Dán một Ad ID hoặc link xem trước quảng cáo (feed_demo_ad=…)." };
  }
  const guard = await guardRead();
  if ("error" in guard) return guard;

  const rows = await runResolve(list.adIds);
  await audit({
    userId: guard.user.id,
    userEmail: guard.user.email,
    action: "META_AD_POST_LOOKUP",
    entity: "fb_ads",
    after: summary(rows),
    reason: "Tra tay mẩu quảng cáo → bài viết (chỉ đọc Meta)",
  });
  return { ok: true, rows: forClient(rows), invalid: list.invalid, duplicates: list.duplicates, overflow: list.overflow, canSync: can(guard.user, "expenses:write") };
}

const syncInput = z.array(z.string().regex(/^\d{5,25}$/, "Mã quảng cáo phải toàn chữ số.")).min(1).max(META_AD_POST_BATCH_MAX);

/**
 * GHI: tra lại ở máy chủ rồi lưu vào `fb_ads` (idempotent theo `ad_id`). Mẩu Meta không trả về
 * thì không ghi và được liệt kê trong `saved.skipped`.
 */
export async function syncMetaAdPosts(adIds: string[]): Promise<SyncAdPostsResult> {
  const parsed = syncInput.safeParse(adIds);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Danh sách mã không hợp lệ." };
  const guard = await guardRead();
  if ("error" in guard) return guard;
  if (!can(guard.user, "expenses:write")) return { error: "Bạn chưa có quyền ghi của module Quảng cáo (expenses:write)." };

  const ids = [...new Set(parsed.data)];
  const rows = await runResolve(ids);
  const saved = await saveAdPostResolutions(rows);
  await audit({
    userId: guard.user.id,
    userEmail: guard.user.email,
    action: "META_AD_POST_SYNC",
    entity: "fb_ads",
    entityId: ids.length === 1 ? ids[0] : undefined,
    after: { ...summary(rows), inserted: saved.inserted, updated: saved.updated, unchanged: saved.unchanged, skipped: saved.skipped.map((s) => s.adId) },
    reason: "Đồng bộ mối nối mẩu quảng cáo → creative → bài viết vào ERP (máy chủ tra lại Meta trước khi ghi)",
  });
  revalidatePath("/ads/post-resolver");
  // Ngữ cảnh ERP đọc SAU khi ghi, để màn hình nói đúng "đã lưu lúc …".
  const context = await loadAdPostErpContext(rows.map((r) => ({ adId: r.adId, storyId: r.objectStoryId })));
  return { ok: true, rows: forClient(rows.map((r) => ({ ...r, erp: context.get(r.adId) ?? null }))), saved };
}
