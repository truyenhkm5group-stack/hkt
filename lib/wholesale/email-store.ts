import { and, asc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { EMAIL_DISCOVERY_VERSION, EMAIL_QUEUE_DEFAULT, EMAIL_QUEUE_MAX, EMAIL_RESCAN_DAYS, type EmailCheck } from "@/lib/constants/wholesale-email";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { socialKind, websiteDomain } from "@/lib/wholesale/dedupe";
import { buildEmailChecks, emailFillDecision, pickBestEmail, type EmailCandidate } from "@/lib/wholesale/email-discovery";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import type { EnrichResult } from "@/lib/wholesale/website";

/**
 * ═══════════ THU THẬP EMAIL B2B — LƯU & XẾP HÀNG (CHỈ MÁY CHỦ) ═══════════
 *
 * Chỗ lưu (KHÔNG thêm cột, KHÔNG migration):
 *  · mỗi email = MỘT dòng `wholesale_lead_enrichments` (kind `EMAIL`, `source_url` = trang có email) — vòng ghi phát hiện
 *    sẵn có của `enrichLeadWebsite` làm việc này;
 *  · vai trò + trạng thái MX + nguồn + ngày xác minh của LƯỢT QUÉT = `meta` của dòng nhật ký `ENRICHED`
 *    (`wholesale_lead_activities`) — bảng phát hiện không có cột jsonb. Mỗi lượt quét là một bản ghi bất biến: đọc lượt
 *    MỚI NHẤT có `emailChecks` là biết email của lead đang ở trạng thái nào và kiểm lúc nào;
 *  · `wholesale_leads.email` = email tốt nhất, CHỈ khi ô trống hoặc do máy điền ở lượt trước (`emailFilled` của lượt cũ;
 *    lead nguồn Google thì email chỉ có thể đến từ máy hoặc nhân viên, nên giá trị trùng một phát hiện CŨ cũng là của máy).
 *    Ô nhân viên đã sửa thì không bao giờ.
 *
 * Xếp hàng quét lại: `website_status = 'PENDING'` — job `wholesale-leads` đọc dần như mọi lead mới (mỗi lượt vài lead,
 * tôn trọng cờ `websiteEnrichment.enabled`). «Quét lại sau» = `website_checked_at + EMAIL_RESCAN_DAYS`; không cột riêng.
 */

type Lead = typeof schema.wholesaleLeads.$inferSelect;

/** Khoá trong `wholesale_lead_activities.meta` của lượt quét có email. */
export type EmailDiscoveryMeta = {
  emailChecks: EmailCheck[];
  emailBest: string | null;
  emailFilled: string | null;
  emailVerifiedAt: string;
  emailDiscoveryVersion: number;
};

/** Phát hiện EMAIL của một lượt đọc website ⇒ dòng kiểm (vai trò · MX · cùng tên miền · nguồn). HÀM THUẦN. */
export function emailChecksOf(r: Pick<EnrichResult, "findings" | "emailDomains">, siteDomain: string | null): EmailCheck[] {
  const candidates: EmailCandidate[] = r.findings.filter((f) => f.kind === "EMAIL").map((f) => ({ email: f.value, sourceUrl: f.sourceUrl, via: f.via ?? "TEXT" }));
  return buildEmailChecks(candidates, r.emailDomains ?? {}, siteDomain);
}

async function machineFilledBefore(lead: Lead, now: Date): Promise<boolean> {
  const cur = (lead.email ?? "").trim().toLowerCase();
  if (!cur) return false;
  const db = await getDb();
  const a = schema.wholesaleLeadActivities;
  const [byMeta] = await db
    .select({ id: a.id })
    .from(a)
    .where(and(eq(a.leadId, lead.id), eq(a.kind, "ENRICHED"), sql`${a.meta}->>'emailFilled' = ${cur}`))
    .limit(1);
  if (byMeta) return true;
  if (lead.source !== "GOOGLE_PLACES") return false;
  const e = schema.wholesaleLeadEnrichments;
  const [legacy] = await db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.leadId, lead.id), eq(e.kind, "EMAIL"), eq(e.value, cur), lt(e.fetchedAt, now)))
    .limit(1);
  return Boolean(legacy);
}

/**
 * Gọi trong `enrichLeadWebsite` SAU khi phát hiện đã vào `wholesale_lead_enrichments`. Trả email cần ghi vào hồ sơ lead
 * (hoặc null) và `meta` để gắn vào dòng nhật ký `ENRICHED` của lượt này. Không tìm thấy email ⇒ `meta` rỗng.
 */
export async function applyEmailDiscovery(lead: Lead, website: string, r: Pick<EnrichResult, "findings" | "emailDomains">, now: Date): Promise<{ email: string | null; meta: EmailDiscoveryMeta | Record<string, never> }> {
  const checks = emailChecksOf(r, lead.websiteDomain ?? websiteDomain(website));
  if (!checks.length) return { email: null, meta: {} };
  const best = pickBestEmail(checks);
  const staffEdited = lead.staffEditedFields.includes("email");
  const email = emailFillDecision({ current: lead.email, staffEdited, machineFilledBefore: !staffEdited && (await machineFilledBefore(lead, now)), best: best?.email ?? null });
  return { email, meta: { emailChecks: checks, emailBest: best?.email ?? null, emailFilled: email, emailVerifiedAt: now.toISOString(), emailDiscoveryVersion: EMAIL_DISCOVERY_VERSION } };
}

// ─────────────────────────── «Thu thập email» hàng loạt ───────────────────────────

const QueueInput = z.object({ limit: z.number().int().min(1).max(EMAIL_QUEUE_MAX).default(EMAIL_QUEUE_DEFAULT) });

/** Trạng thái lead không đi thu thập email: đã dặn không liên hệ, hoặc đã là khách. */
const SKIP_STATUSES = ["DO_NOT_CONTACT", "WON"];

export type EmailQueueReport = { queued: number; eligible: number; skippedNotWebsite: number };

/**
 * Xếp hàng đọc website cho lead CÓ website mà CHƯA có email, chưa quét trong `EMAIL_RESCAN_DAYS` ngày. Không quét trùng:
 * lead đang chờ (`PENDING`) không bị xếp lại, lead vừa quét chưa đủ hạn không vào. Thuần quy tắc — không tốn token AI,
 * không tốn tiền API (đọc website miễn phí, chỉ tốn thời gian của job).
 */
export async function queueEmailDiscoveryCore(user: SessionUser, input: unknown, now = new Date()): Promise<CoreResult<{ report: EmailQueueReport }>> {
  if (!can(user, "wholesale:scan")) return { error: "Bạn không có quyền chạy quét (wholesale:scan)." };
  const parsed = QueueInput.safeParse(input ?? {});
  if (!parsed.success) return { error: `Số lead mỗi lần phải từ 1 tới ${EMAIL_QUEUE_MAX}.` };
  const cfg = await getLeadHunterConfig();
  if (!cfg.websiteEnrichment.enabled) return { error: "Đang TẮT đọc website (Cấu hình săn khách sỉ › Đọc website). Bật lên rồi bấm lại — không có gì được xếp hàng." };
  const db = await getDb();
  const l = schema.wholesaleLeads;
  const ps = schema.wholesalePlaceSnapshots;
  const cutoff = new Date(now.getTime() - EMAIL_RESCAN_DAYS * 86_400_000);
  const website = sql<string | null>`coalesce(${l.website}, ${ps.websiteUri})`;
  const rows = await db
    .select({ id: l.id, website })
    .from(l)
    .leftJoin(ps, eq(ps.placeId, l.placeId))
    .where(
      and(
        eq(l.enrichmentStatus, "READY"),
        ne(l.websiteStatus, "PENDING"),
        or(isNull(l.email), eq(sql`btrim(${l.email})`, "")),
        notInArray(l.contactStatus, SKIP_STATUSES),
        or(isNull(l.websiteCheckedAt), lt(l.websiteCheckedAt, cutoff)),
        sql`${website} is not null`,
      ),
    )
    .orderBy(sql`${l.leadScore} desc nulls last`, asc(l.id))
    .limit(EMAIL_QUEUE_MAX * 4);
  // Website là trang Facebook / Zalo / host dùng chung (Linktree…) ⇒ không phải website để đọc (cùng luật với finalizeLead).
  const readable = rows.filter((r) => r.website && !socialKind(r.website) && websiteDomain(r.website));
  const ids = readable.slice(0, parsed.data.limit).map((r) => r.id);
  let queued = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const moved = await db
      .update(l)
      .set({ websiteStatus: "PENDING", updatedAt: now })
      .where(and(inArray(l.id, ids.slice(i, i + 500)), ne(l.websiteStatus, "PENDING")))
      .returning({ id: l.id });
    queued += moved.length;
  }
  const report: EmailQueueReport = { queued, eligible: readable.length, skippedNotWebsite: rows.length - readable.length };
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_DISCOVERY_QUEUE", entity: "WHOLESALE_LEAD", entityId: "email-discovery", after: { ...report, limit: parsed.data.limit, rescanDays: EMAIL_RESCAN_DAYS }, reason: "Thu thập email cho lead có website mà chưa có email" });
  return { ok: true, report };
}
