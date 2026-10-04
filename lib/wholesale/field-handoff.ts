import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { openActiveConnection } from "@/lib/connectors/service";
import { formatDateTime } from "@/lib/format";
import { deliverMessage } from "@/lib/messaging/service";
import type { MessagingDeps } from "@/lib/messaging/providers";
import { MESSAGING_CONNECTOR_LABEL } from "@/lib/messaging/types";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { CALL_OUTCOME_LABEL, isLeadStatus, LEAD_STATUS_LABEL, type CallOutcome } from "@/lib/wholesale/constants";
import { formatVnPhone } from "@/lib/wholesale/phone";
import { isLeadSegmentKey, LEAD_SEGMENT_LABEL } from "@/lib/wholesale/segments";
import { getLeadHunterConfig } from "@/lib/wholesale/store";

/**
 * ═══════════ GỬI KHÁCH TIỀM NĂNG CHO NHÂN VIÊN THỊ TRƯỜNG (TELEGRAM / ZALO / LARK) ═══════════
 *
 * Chủ shop 04/10/2026: «quét được data khách thì tôi gọi điện chào hàng và gửi thông tin khách tiềm năng qua Telegram để
 * nhân viên thị trường đi chào hàng». Đường gửi là `deliverMessage` — MỘT sổ gửi tin của tổ chức, đúng-một-lần theo khoá
 * (bấm hai lần trong cùng phút không đẻ tin thứ hai).
 *
 * ─── TIN CHỈ MANG DỮ LIỆU CỦA SHOP + LINK BẢN ĐỒ ───
 *
 * Tên / SĐT / địa chỉ Google trả về nằm ở ảnh chụp có hạn 30 ngày và không được mang ra ngoài ứng dụng (điều khoản Google
 * Maps Platform — docs/verticals/wholesale-lead-hunter.md mục tuân thủ). Nên tin chỉ in dữ liệu CỦA SHOP: nhân viên gõ, tệp
 * nhập, hoặc đã GỌI XÁC NHẬN (`logCallCore` chép tên + SĐT vừa gọi được thành dữ liệu của shop). Chưa gọi thì tin nói thẳng
 * «chưa gọi xác nhận» và đưa link Google Maps — mở trên điện thoại là thấy tên, địa chỉ và chỉ đường. Gọi trước rồi gửi:
 * đúng quy trình chủ shop mô tả.
 */

/** Link mở địa điểm trên Google Maps (URL chính thức `maps/search/?api=1`). `null` khi lead không có Place ID. */
export function mapsLinkOf(placeId: string | null | undefined, storedUri: string | null | undefined, query: string | null | undefined): string | null {
  if (storedUri && /^https:\/\/(maps\.google\.com|www\.google\.com\/maps|maps\.app\.goo\.gl)/.test(storedUri)) return storedUri;
  if (!placeId) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((query ?? "").trim() || "địa điểm")}&query_place_id=${encodeURIComponent(placeId)}`;
}

export type FieldHandoffInput = {
  /** Dữ liệu CỦA SHOP — `null` khi chưa có (chưa gọi xác nhận / chưa nhập). */
  ownName: string | null;
  ownPhone: string | null;
  ownAddress: string | null;
  areaName: string | null;
  provinceLabel: string | null;
  mapsUrl: string | null;
  segment: string;
  grade: string | null;
  score: number | null;
  status: string;
  lastCall: { outcome: string; note: string | null; at: Date } | null;
  response: string | null;
  nextAction: string | null;
  nextFollowupAt: Date | null;
  opportunityNote: string | null;
  senderName: string;
  note: string | null;
};

/** Nội dung tin (HÀM THUẦN, văn bản thường — Telegram gửi không định dạng). */
export function fieldHandoffMessage(x: FieldHandoffInput): { title: string; body: string } {
  const where = [x.areaName, x.provinceLabel].filter(Boolean).join(", ");
  const segLabel = isLeadSegmentKey(x.segment) ? LEAD_SEGMENT_LABEL[x.segment] : x.segment;
  const title = `Khách sỉ tiềm năng${where ? ` · ${where}` : ""}`;
  const lines: string[] = [];
  lines.push(`🏪 ${x.ownName ?? "Chưa gọi xác nhận tên — mở bản đồ bên dưới"}`);
  lines.push(`📞 ${x.ownPhone ? formatVnPhone(x.ownPhone) : "Chưa có SĐT đã xác nhận"}`);
  lines.push(`📍 ${x.ownAddress ?? (where ? `${where} — xem vị trí trên bản đồ` : "Xem vị trí trên bản đồ")}`);
  if (x.mapsUrl) lines.push(`🗺 ${x.mapsUrl}`);
  lines.push(`Loại hình: ${segLabel}${x.grade ? ` · hạng ${x.grade}` : ""}${x.score != null ? ` (${x.score} điểm)` : ""}`);
  lines.push(`Trạng thái: ${isLeadStatus(x.status) ? LEAD_STATUS_LABEL[x.status] : x.status}`);
  if (x.lastCall) {
    const label = (CALL_OUTCOME_LABEL as Record<string, string>)[x.lastCall.outcome] ?? x.lastCall.outcome;
    lines.push(`Cuộc gọi gần nhất (${formatDateTime(x.lastCall.at)}): ${label}${x.lastCall.note ? ` — ${x.lastCall.note}` : ""}`);
  } else lines.push("Chưa gọi lần nào.");
  if (x.response && x.response !== x.lastCall?.note) lines.push(`Khách nói: ${x.response}`);
  if (x.opportunityNote) lines.push(`Khách quan tâm: ${x.opportunityNote}`);
  if (x.nextAction) lines.push(`Việc tiếp theo: ${x.nextAction}`);
  if (x.nextFollowupAt) lines.push(`Hẹn: ${formatDateTime(x.nextFollowupAt)}`);
  if (x.note) lines.push(`Lời dặn: ${x.note}`);
  lines.push(`Người gửi: ${x.senderName}`);
  return { title, body: lines.join("\n") };
}

const handoffSchema = z.object({
  leadIds: z.array(z.string().min(1).max(64)).min(1, "Chưa chọn lead nào").max(50, "Gửi tối đa 50 lead mỗi lượt"),
  /** Chỉ số trong danh sách nơi nhận của cấu hình; `null` = chat mặc định của kết nối. */
  destination: z.number().int().min(0).max(19).nullable().default(null),
  note: z.string().trim().max(500).default(""),
});

export type HandoffReport = { sent: number; duplicate: number; skipped: { leadId: string; reason: string }[]; failed: { leadId: string; error: string }[]; destinationLabel: string };

/**
 * Gửi từng lead thành MỘT tin (nhân viên chuyển tiếp / ghim từng khách được). Lead KHÔNG LIÊN HỆ / ngoài phạm vi ⇒ bỏ qua
 * kèm lý do. Mỗi lead gửi xong ghi một dòng hoạt động «Gửi nhân viên thị trường» — lead đó có lịch sử ai gửi, gửi đi đâu.
 */
export async function sendLeadsToFieldCore(user: SessionUser, raw: unknown, now = new Date(), deps: MessagingDeps = {}): Promise<CoreResult<{ report: HandoffReport }>> {
  if (!can(user, "wholesale:work")) return { error: "Bạn không có quyền chăm lead khách sỉ (wholesale:work)." };
  const parsed = handoffSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const cfg = await getLeadHunterConfig();
  const fs = cfg.fieldSales;
  const dest = parsed.data.destination == null ? null : (fs.destinations[parsed.data.destination] ?? undefined);
  if (dest === undefined) return { error: "Nơi nhận không còn trong cấu hình — tải lại trang." };
  const destinationLabel = dest ? dest.label : `chat mặc định của «${MESSAGING_CONNECTOR_LABEL[fs.connectorKey]}»`;
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };

  const db = await getDb();
  const l = schema.wholesaleLeads;
  const ids = [...new Set(parsed.data.leadIds)];
  const leads = await db.select().from(l).where(inArray(l.id, ids));
  const placeIds = leads.map((x) => x.placeId).filter((x): x is string => Boolean(x));
  const snaps = placeIds.length
    ? await db
        .select({ placeId: schema.wholesalePlaceSnapshots.placeId, uri: schema.wholesalePlaceSnapshots.googleMapsUri, purgedAt: schema.wholesalePlaceSnapshots.purgedAt })
        .from(schema.wholesalePlaceSnapshots)
        .where(inArray(schema.wholesalePlaceSnapshots.placeId, placeIds))
    : [];
  const snapBy = new Map(snaps.map((s) => [s.placeId, s]));
  const a = schema.wholesaleLeadActivities;
  const calls = await db
    .select({ leadId: a.leadId, outcome: a.outcome, note: a.note, at: a.createdAt })
    .from(a)
    .where(and(inArray(a.leadId, ids), eq(a.kind, "CALL")))
    .orderBy(desc(a.createdAt));
  const lastCall = new Map<string, (typeof calls)[number]>();
  for (const c of calls) if (!lastCall.has(c.leadId)) lastCall.set(c.leadId, c);

  const report: HandoffReport = { sent: 0, duplicate: 0, skipped: [], failed: [], destinationLabel };
  const minute = Math.floor(now.getTime() / 60_000);
  for (const leadId of ids) {
    const lead = leads.find((x) => x.id === leadId);
    if (!lead) {
      report.skipped.push({ leadId, reason: "Không tìm thấy lead" });
      continue;
    }
    if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) {
      report.skipped.push({ leadId, reason: "Ngoài phạm vi dữ liệu của bạn" });
      continue;
    }
    if (lead.contactStatus === "DO_NOT_CONTACT") {
      report.skipped.push({ leadId, reason: "Khách ở danh sách KHÔNG LIÊN HỆ" });
      continue;
    }
    const snap = lead.placeId ? snapBy.get(lead.placeId) : undefined;
    const call = lastCall.get(leadId);
    const msg = fieldHandoffMessage({
      ownName: lead.businessName,
      ownPhone: lead.normalizedPhone,
      ownAddress: lead.address,
      areaName: lead.areaName,
      provinceLabel: lead.provinceLabel,
      mapsUrl: mapsLinkOf(lead.placeId, snap && !snap.purgedAt ? snap.uri : null, lead.businessName ?? lead.areaName ?? lead.provinceLabel),
      segment: lead.segment,
      grade: lead.leadGrade,
      score: lead.leadScore,
      status: lead.contactStatus,
      lastCall: call ? { outcome: call.outcome ?? "", note: call.note || null, at: call.at } : null,
      response: lead.response,
      nextAction: lead.nextAction,
      nextFollowupAt: lead.nextFollowupAt,
      opportunityNote: lead.opportunityNote,
      senderName: user.name,
      note: parsed.data.note || null,
    });
    const r = await deliverMessage(
      {
        connectorKey: fs.connectorKey,
        destination: dest?.chatId || null,
        title: msg.title,
        body: msg.body,
        dedupeKey: `wholesale-handoff:${leadId}:${dest ? `${fs.connectorKey}:${dest.chatId}` : fs.connectorKey}:${minute}`,
        event: "wholesale.lead_handoff",
        subject: { type: "WHOLESALE_LEAD", id: leadId },
        createdBy: user.id,
      },
      deps,
    );
    if (r.status === "SENT") {
      report.sent++;
      await db.insert(a).values({ leadId, kind: "ASSIGN", channel: fs.connectorKey, note: `Gửi nhân viên thị trường — ${destinationLabel}${parsed.data.note ? `: ${parsed.data.note}` : ""}`.slice(0, 2000), meta: { handoff: true, deliveryId: r.deliveryId, destination: dest?.label ?? null }, actorId: user.id, actorName: user.name, createdAt: now });
    } else if (r.status === "DUPLICATE") report.duplicate++;
    else report.failed.push({ leadId, error: r.status === "FAILED" ? r.error : "Lượt gửi trước chưa rõ đã tới hay chưa — kiểm tra nhóm chat rồi gửi lại sau 1 phút." });
  }
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "WHOLESALE_LEAD_HANDOFF",
    entity: "WHOLESALE_LEAD",
    entityId: ids.slice(0, 5).join(","),
    after: { connector: fs.connectorKey, destination: dest?.label ?? null, sent: report.sent, duplicate: report.duplicate, skipped: report.skipped.length, failed: report.failed.length },
    reason: `Gửi ${report.sent} lead cho nhân viên thị trường (${destinationLabel})`,
  });
  return { ok: true, report };
}

export type CallVerifyLead = {
  businessName: string | null;
  address: string | null;
  normalizedPhone: string | null;
  staffEditedFields: string[];
};

/**
 * Cuộc gọi NGHE MÁY / HẸN GỌI LẠI xác nhận địa điểm có thật và số gọi được ⇒ tên + SĐT thành dữ liệu của shop
 * (`phone_source = VERIFIED_CALL`), tương đương nhân viên tự gõ lại. Địa chỉ CHỈ chép khi người gọi tích «khách xác nhận
 * địa chỉ». Ô nhân viên đã sửa / đã có giá trị không bao giờ bị ghi đè. HÀM THUẦN — trả bản vá, không ghi.
 */
export function verifiedCallPatch(
  lead: CallVerifyLead,
  snap: { displayName: string | null; formattedAddress: string | null; normalizedPhone: string | null } | null,
  outcome: CallOutcome,
  addressConfirmed: boolean,
): { businessName?: string; address?: string; normalizedPhone?: string } {
  if (!snap || (outcome !== "ANSWERED" && outcome !== "CALLBACK")) return {};
  const locked = (f: string) => lead.staffEditedFields.includes(f);
  const out: { businessName?: string; address?: string; normalizedPhone?: string } = {};
  if (!lead.businessName && !locked("businessName") && snap.displayName) out.businessName = snap.displayName;
  if (!lead.normalizedPhone && !locked("phone") && snap.normalizedPhone) out.normalizedPhone = snap.normalizedPhone;
  if (addressConfirmed && !lead.address && !locked("address") && snap.formattedAddress) out.address = snap.formattedAddress;
  return out;
}

export type FieldHandoffOptions = { connectorLabel: string; destinations: string[]; ready: boolean; reason: string | null };

/** Cho màn hình: kết nối nào, các nơi nhận đã khai, và kết nối đã bật chưa (chưa bật thì nút vẫn hiện kèm cách sửa). */
export async function fieldHandoffOptions(): Promise<FieldHandoffOptions> {
  const cfg = await getLeadHunterConfig();
  const conn = await openActiveConnection(cfg.fieldSales.connectorKey);
  return {
    connectorLabel: MESSAGING_CONNECTOR_LABEL[cfg.fieldSales.connectorKey],
    destinations: cfg.fieldSales.destinations.map((d) => d.label),
    ready: conn.ok,
    reason: conn.ok ? null : conn.reason,
  };
}
