import { and, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { vnDateKey, vnStartOfDay } from "@/lib/format";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { CONTACT_TRACK_LABEL, EMAIL_TRACKS, NO_EMAIL_HINT, type ContactTrack } from "@/lib/wholesale/contact-plan";
import { contactPlansFor } from "@/lib/wholesale/contact-plan-store";
import { normalizeEmail } from "@/lib/wholesale/contactability";
import { aiDraftEmailCore, type AiDeps } from "@/lib/wholesale/email-ai-draft";
import { approveEmailCore, editEmailDraftCore, emailDraftForLeadCore } from "@/lib/wholesale/email-outbox";
import { getEmailSettings } from "@/lib/wholesale/email-outbox-store";
import { leadView } from "@/lib/wholesale/engine";
import { zaloDraftCore } from "@/lib/wholesale/leads";
import { openerVariables, renderTemplate, type OpenerFacts } from "@/lib/wholesale/opener";
import { promoteAiDraftCore } from "@/lib/wholesale/email-ai-draft";
import { isLeadSegmentKey } from "@/lib/wholesale/segments";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import type { LeadHunterConfig } from "@/lib/wholesale/config";

/**
 * ═══════════ LIÊN HỆ HÀNG LOẠT TỪ DANH SÁCH LEAD — DÙNG LẠI MÁY CÓ SẴN ═══════════
 *
 * Chủ shop 31/10/2026: «nút gửi email … nội dung soạn sẵn cá nhân hoá từng khách … bulk action gửi Zalo / email cho khách
 * được tích chọn». KHÔNG có đường gửi mới:
 *
 *  · EMAIL — dựng nháp CÁ NHÂN HOÁ cho từng lead (mẫu thay biến, hoặc AI soạn của #1100 trong trần ngày), người DUYỆT từng
 *    thư trên màn hình duyệt hàng loạt, rồi mỗi thư đi đúng đường E1: `emailDraftForLeadCore` (làn kênh · KHÔNG LIÊN HỆ ·
 *    khoá trùng) → `editEmailDraftCore` → `approveEmailCore` (cổng chính sách: đồng ý · danh sách chặn · nước đã rà ·
 *    nút dừng · hạn mức). Thư cổng sẽ chặn trả về KÈM LÝ DO; không thư nào bị bỏ âm thầm. Nhịp gửi vẫn là của hộp thư đi.
 *  · ZALO — KHÔNG tự gửi (Zalo cá nhân không có API; gửi tự động là khoá nick và trái ràng buộc dự án). Chỉ dựng PHIÊN NHẮN
 *    TUẦN TỰ: tin cá nhân hoá + link zalo.me cho từng khách làn «Trong nước — Zalo»; nhân viên bấm Gửi trong Zalo rồi ghi kết
 *    quả qua `logZaloResultCore` sẵn có. Máy không gọi mạng Zalo.
 *  · Quyền `wholesale:work`; lead ngoài phạm vi dữ liệu KHÔNG vào lô (đếm riêng). Mọi lần ghi đi qua lõi đã có audit + khoá
 *    tài khoản người thao tác. Không luân phiên tài khoản, không «spin» nội dung, không trễ ngẫu nhiên.
 */

export const BULK_MAX = 100;
const FORBIDDEN = "Bạn không có quyền liên hệ khách sỉ (wholesale:work).";
/** Mẫu tiêu đề mặc định — cùng câu với tiêu đề mặc định của E1, thêm tên khách. */
export const DEFAULT_SUBJECT_TEMPLATE = "Bảng giá sỉ {{san_pham}} cho {{ten_doanh_nghiep}} — {{ten_shop}}";

type Lead = typeof schema.wholesaleLeads.$inferSelect;

/**
 * Biến thay của thư / tin cá nhân hoá: mọi biến của lời chào (`openerVariables`: ten_doanh_nghiep · loai_hinh · khu_vuc ·
 * san_pham · ten_shop · moq · giao_hang…) + `thanh_pho` (khu vực, không thì tỉnh / nước). HÀM THUẦN.
 */
export function personalVariables(cfg: LeadHunterConfig, f: OpenerFacts): Record<string, string> {
  return { ...openerVariables(cfg, f), thanh_pho: f.areaName || f.provinceLabel || "" };
}

/** Thay biến cho MỘT lead: tiêu đề một dòng, thân giữ xuống dòng. HÀM THUẦN. */
export function personalize(cfg: LeadHunterConfig, f: OpenerFacts, subjectTpl: string, bodyTpl: string): { subject: string; body: string } {
  const vars = personalVariables(cfg, f);
  // Dòng chỉ chứa biến rỗng (vd chưa khai khuyến mãi) bị bỏ; dòng trống CỐ Ý (ngắt đoạn) giữ nguyên.
  const body = bodyTpl
    .split(/\r?\n/)
    .map((line) => ({ had: /\{\{/.test(line), text: renderTemplate(line, vars) }))
    .filter((x) => !(x.had && !x.text))
    .map((x) => x.text)
    .join("\n")
    .trim();
  return { subject: renderTemplate(subjectTpl, vars).replace(/\s+/g, " ").trim().slice(0, 200), body: body.slice(0, 5000) };
}

/**
 * Dự kiến bao lâu gửi hết N thư theo nhịp của hộp thư đi (thư / giờ, thư / ngày). Không tính trần theo tên miền (phụ thuộc từng
 * địa chỉ) — câu in ra nói rõ. HÀM THUẦN.
 */
export function sendEta(n: number, limits: { perHour: number; perDay: number; perRecipientDomainPerDay: number }): string {
  if (n <= 0) return "Không có thư nào xếp gửi.";
  const days = Math.ceil(n / limits.perDay);
  if (days <= 1) {
    const hours = Math.ceil(n / limits.perHour);
    return `${n} thư · nhịp ${limits.perHour} thư / giờ ⇒ khoảng ${hours} giờ (nếu không chạm trần ${limits.perRecipientDomainPerDay} thư / tên miền / ngày).`;
  }
  return `${n} thư · trần ${limits.perDay} thư / ngày ⇒ khoảng ${days} ngày (nhịp ${limits.perHour} thư / giờ, ${limits.perRecipientDomainPerDay} thư / tên miền / ngày).`;
}

const AI_CAP = /chạm trần|tạm dừng tới mai/i;

/** Lead trong phạm vi của người thao tác (giữ thứ tự chọn). Ngoài phạm vi ⇒ đếm riêng, không vào lô. */
async function scopedLeads(user: SessionUser, ids: readonly string[]): Promise<{ leads: Lead[]; outOfScope: number } | { error: string }> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN };
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  const unique = [...new Set(ids)];
  const inScope: string[] = [];
  for (const id of unique) if (await rowInScope(decision, "wholesale_leads", "id", id)) inScope.push(id);
  const db = await getDb();
  const rows = inScope.length ? await db.select().from(schema.wholesaleLeads).where(inArray(schema.wholesaleLeads.id, inScope)) : [];
  const by = new Map(rows.map((r) => [r.id, r]));
  return { leads: inScope.map((id) => by.get(id)).filter((x): x is Lead => Boolean(x)), outOfScope: unique.length - inScope.length };
}

async function factsAndNames(leads: readonly Lead[]): Promise<Map<string, { facts: OpenerFacts; name: string }>> {
  const db = await getDb();
  const placeIds = leads.map((l) => l.placeId).filter((x): x is string => Boolean(x));
  const snaps = placeIds.length ? await db.select().from(schema.wholesalePlaceSnapshots).where(inArray(schema.wholesalePlaceSnapshots.placeId, placeIds)) : [];
  const snapBy = new Map(snaps.map((s) => [s.placeId, s]));
  const out = new Map<string, { facts: OpenerFacts; name: string }>();
  for (const l of leads) {
    const snap = l.placeId ? snapBy.get(l.placeId) : null;
    const v = leadView(l, snap && !snap.purgedAt ? snap : null);
    const name = v.name ?? l.businessName ?? "anh/chị";
    out.set(l.id, { name, facts: { businessName: name, segment: isLeadSegmentKey(l.segment) ? l.segment : "UNCLASSIFIED", areaName: l.areaName, provinceLabel: l.provinceLabel } });
  }
  return out;
}

// ─────────────────────────── EMAIL ───────────────────────────

export type BulkEmailItem = {
  leadId: string;
  name: string;
  email: string | null;
  track: ContactTrack | null;
  trackLabel: string;
  subject: string;
  body: string;
  /** Nháp do AI soạn (#1100) — khi đưa vào hộp thư đi đi qua `promoteAiDraftCore` (hàng rào câu bịa chạy lại). */
  aiDraftId: string | null;
  /** Vì sao KHÔNG soạn được thư cho lead này (đã nói rõ, không âm thầm bỏ). */
  refusal: string | null;
};

export type BulkEmailPrep = {
  items: BulkEmailItem[];
  outOfScope: number;
  /** AI: dừng ở lead thứ mấy vì chạm trần, còn bao nhiêu chưa soạn. `null` = không dùng AI / không chạm trần. */
  aiStop: { message: string; remaining: number } | null;
};

const prepareSchema = z.object({
  leadIds: z.array(z.string().min(1).max(64)).min(1, "Chọn ít nhất một khách").max(BULK_MAX, `Tối đa ${BULK_MAX} khách một lô`),
  source: z.enum(["TEMPLATE", "AI"]).default("TEMPLATE"),
  /** Mẫu thân thư: `__opener` = lời chào trong cấu hình; còn lại = mã một mẫu thêm (khung Mẫu nội dung). */
  templateId: z.string().max(40).default("__opener"),
  subjectTemplate: z.string().trim().min(3).max(200).default(DEFAULT_SUBJECT_TEMPLATE),
});

/**
 * Dựng nháp email cá nhân hoá cho TỪNG lead — CHƯA ghi gì vào hộp thư đi (mẫu: chỉ đọc; AI: tạo dòng nháp AI như nút «AI soạn
 * nháp» hiện có). Lead không đi được email (KHÔNG LIÊN HỆ · thiếu email · làn Zalo · thiếu căn cứ nước) có `refusal`.
 */
export async function bulkEmailPrepareCore(user: SessionUser, raw: unknown, now = new Date(), deps: AiDeps = {}): Promise<CoreResult<{ prep: BulkEmailPrep }>> {
  const parsed = prepareSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const g = await scopedLeads(user, parsed.data.leadIds);
  if ("error" in g) return g;
  const cfg = await getLeadHunterConfig();
  const extra = cfg.outreach.extraTemplates.find((t) => t.id === parsed.data.templateId && t.channel !== "ZALO");
  const bodyTpl = extra?.body ?? cfg.outreach.openerTemplate;
  const [plans, info] = await Promise.all([contactPlansFor(g.leads.map((l) => l.id)), factsAndNames(g.leads)]);
  const db = await getDb();
  const items: BulkEmailItem[] = [];
  let aiStop: BulkEmailPrep["aiStop"] = null;
  for (const [i, l] of g.leads.entries()) {
    const plan = plans.get(l.id) ?? null;
    const meta = info.get(l.id)!;
    const email = normalizeEmail(l.email);
    const base = { leadId: l.id, name: meta.name, email, track: plan?.track ?? null, trackLabel: plan ? CONTACT_TRACK_LABEL[plan.track] : "—", subject: "", body: "", aiDraftId: null };
    const refusal =
      l.contactStatus === "DO_NOT_CONTACT"
        ? "Lead ở danh sách KHÔNG LIÊN HỆ."
        : !email
          ? NO_EMAIL_HINT
          : plan && !EMAIL_TRACKS.includes(plan.track)
            ? `Lead đang ở làn «${CONTACT_TRACK_LABEL[plan.track]}» — ${plan.notes[0] ?? "chưa đi kênh email"}`
            : null;
    if (refusal) {
      items.push({ ...base, refusal });
      continue;
    }
    if (parsed.data.source === "TEMPLATE") {
      items.push({ ...base, ...personalize(cfg, meta.facts, parsed.data.subjectTemplate, bodyTpl), refusal: null });
      continue;
    }
    if (aiStop) {
      items.push({ ...base, refusal: `Chưa soạn — ${aiStop.message}` });
      continue;
    }
    const r = await aiDraftEmailCore(user, l.id, now, deps);
    if ("error" in r) {
      if (AI_CAP.test(r.error)) {
        aiStop = { message: r.error, remaining: g.leads.length - i };
        items.push({ ...base, refusal: `Chưa soạn — ${r.error}` });
      } else items.push({ ...base, refusal: r.error });
      continue;
    }
    const d = await db.query.wholesaleEmailAiDrafts.findFirst({ where: eq(schema.wholesaleEmailAiDrafts.id, r.id) });
    if (!d || r.status === "BLOCKED") {
      items.push({ ...base, subject: d?.subject ?? "", body: d?.body ?? "", refusal: `AI soạn vi phạm hàng rào: ${r.violations.map((v) => v.detail).join(" ") || "nháp bị chặn"} — soạn lại bằng mẫu.` });
      continue;
    }
    items.push({ ...base, subject: d.subject, body: d.body, aiDraftId: d.id, refusal: null });
  }
  return { ok: true, prep: { items, outOfScope: g.outOfScope, aiStop } };
}

const submitSchema = z.object({
  items: z
    .array(
      z.object({
        leadId: z.string().min(1).max(64),
        subject: z.string().trim().min(3, "Tiêu đề quá ngắn").max(200),
        body: z.string().trim().min(5, "Nội dung quá ngắn").max(5000),
        aiDraftId: z.string().min(1).max(64).nullable().default(null),
        /** Người duyệt ĐÃ MỞ XEM thư này và tích chọn ⇒ duyệt + xếp gửi; `false` ⇒ chỉ đưa vào hộp thư đi ở trạng thái chờ duyệt. */
        approve: z.boolean().default(false),
      }),
    )
    .min(1, "Không có thư nào")
    .max(BULK_MAX),
});

export type BulkEmailResult = { leadId: string; outboxId: string | null; status: "QUEUED" | "DRAFT" | "ERROR"; error: string | null; warnings: string[] };

/**
 * Đưa các thư đã soạn vào hộp thư đi — MỖI thư đi đúng đường E1 (không đường ghi mới). Thư lỗi (làn kênh, trùng thư mở đầu,
 * hàng rào AI…) trả `error`; thư được duyệt mà cổng chính sách SẼ chặn trả `warnings` (đồng ý · nước chưa rà · nút dừng…).
 */
export async function bulkEmailSubmitCore(user: SessionUser, raw: unknown, now = new Date()): Promise<CoreResult<{ results: BulkEmailResult[]; eta: string; dryRun: boolean }>> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN };
  const parsed = submitSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const results: BulkEmailResult[] = [];
  for (const it of parsed.data.items) {
    let outboxId: string | null = null;
    if (it.aiDraftId) {
      const p = await promoteAiDraftCore(user, it.aiDraftId, { subject: it.subject, body: it.body }, now);
      if ("error" in p) {
        results.push({ leadId: it.leadId, outboxId: null, status: "ERROR", error: p.error, warnings: [] });
        continue;
      }
      outboxId = p.outboxId;
    } else {
      const d = await emailDraftForLeadCore(user, it.leadId, { useAi: false }, now);
      if ("error" in d) {
        results.push({ leadId: it.leadId, outboxId: null, status: "ERROR", error: d.error, warnings: [] });
        continue;
      }
      outboxId = d.id;
      const e = await editEmailDraftCore(user, outboxId, { subject: it.subject, body: it.body }, now);
      if ("error" in e) {
        results.push({ leadId: it.leadId, outboxId, status: "DRAFT", error: `Đã vào hộp thư đi nhưng chưa sửa được nội dung: ${e.error}`, warnings: [] });
        continue;
      }
    }
    if (!it.approve) {
      results.push({ leadId: it.leadId, outboxId, status: "DRAFT", error: null, warnings: [] });
      continue;
    }
    const a = await approveEmailCore(user, outboxId, { queue: true }, now);
    if ("error" in a) results.push({ leadId: it.leadId, outboxId, status: "DRAFT", error: `Chưa duyệt được: ${a.error}`, warnings: [] });
    else results.push({ leadId: it.leadId, outboxId, status: "QUEUED", error: null, warnings: a.warnings });
  }
  const settings = await getEmailSettings();
  const queued = results.filter((r) => r.status === "QUEUED").length;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "WHOLESALE_BULK_EMAIL",
    entity: "WHOLESALE_LEAD",
    entityId: "bulk",
    after: { total: results.length, queued, drafted: results.filter((r) => r.status === "DRAFT").length, failed: results.filter((r) => r.status === "ERROR").length, blockedByGate: results.filter((r) => r.warnings.length).length },
    reason: "Soạn email hàng loạt từ danh sách lead (mỗi thư qua đường E1 + cổng chính sách)",
  });
  return { ok: true, results, eta: sendEta(queued, settings.limits), dryRun: settings.mode !== "LIVE" };
}

// ─────────────────────────── ZALO ───────────────────────────

export type ZaloSessionItem = {
  leadId: string;
  name: string;
  phoneDisplay: string | null;
  /** Tin cá nhân hoá (câu mở Zalo của cấu hình, thay biến). */
  text: string;
  /** zalo.me/<số> — `null` khi không nhắn được (lý do ở `reason`). */
  link: string | null;
  reason: string | null;
  /** Lead không ở làn Zalo trong nước — gợi ý kênh khác (nước ngoài ⇒ email). */
  suggestion: string | null;
  /** Đã có kết quả Zalo HÔM NAY (phiên trước / người khác) ⇒ phiên tiếp tục bỏ qua. */
  doneToday: string | null;
};

/**
 * Phiên nhắn Zalo TUẦN TỰ: chỉ dựng danh sách — KHÔNG gửi gì, không gọi mạng Zalo. Ghi kết quả từng khách vẫn qua
 * `logZaloOpenedCore` / `logZaloResultCore` sẵn có (nút trên màn hình phiên).
 */
export async function zaloSessionPrepareCore(user: SessionUser, raw: unknown, now = new Date()): Promise<CoreResult<{ items: ZaloSessionItem[]; outOfScope: number }>> {
  const parsed = z.object({ leadIds: z.array(z.string().min(1).max(64)).min(1, "Chọn ít nhất một khách").max(BULK_MAX, `Tối đa ${BULK_MAX} khách một phiên`) }).safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const g = await scopedLeads(user, parsed.data.leadIds);
  if ("error" in g) return g;
  const [plans, info] = await Promise.all([contactPlansFor(g.leads.map((l) => l.id)), factsAndNames(g.leads)]);
  const db = await getDb();
  const a = schema.wholesaleLeadActivities;
  const since = vnStartOfDay(vnDateKey(now));
  const today = g.leads.length ? await db.select({ leadId: a.leadId, outcome: a.outcome }).from(a).where(and(inArray(a.leadId, g.leads.map((l) => l.id)), eq(a.kind, "ZALO"), gte(a.createdAt, since))) : [];
  const doneBy = new Map(today.filter((t) => t.outcome).map((t) => [t.leadId, t.outcome as string]));
  const items: ZaloSessionItem[] = [];
  for (const l of g.leads) {
    const plan = plans.get(l.id);
    const name = info.get(l.id)!.name;
    if (plan && plan.track !== "DOMESTIC_ZALO") {
      const suggestion = EMAIL_TRACKS.includes(plan.track) ? `Làn «${CONTACT_TRACK_LABEL[plan.track]}» — dùng «Soạn email» thay vì Zalo.` : `Làn «${CONTACT_TRACK_LABEL[plan.track]}» — ${plan.notes[0] ?? "không nhắn Zalo"}`;
      items.push({ leadId: l.id, name, phoneDisplay: null, text: "", link: null, reason: null, suggestion, doneToday: null });
      continue;
    }
    const d = await zaloDraftCore(user, l.id);
    if ("error" in d) {
      items.push({ leadId: l.id, name, phoneDisplay: null, text: "", link: null, reason: d.error, suggestion: null, doneToday: null });
      continue;
    }
    items.push({ leadId: l.id, name, phoneDisplay: d.draft.phoneDisplay, text: d.draft.text, link: d.draft.link, reason: d.draft.reason, suggestion: null, doneToday: doneBy.get(l.id) ?? null });
  }
  return { ok: true, items, outOfScope: g.outOfScope };
}
