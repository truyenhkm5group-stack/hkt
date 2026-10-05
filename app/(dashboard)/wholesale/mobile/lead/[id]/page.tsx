import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { requireResource, rowInScope } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { getWholesaleLead } from "@/lib/queries/wholesale";
import { isMobileChip } from "@/lib/queries/wholesale-mobile";
import type { SearchParams } from "@/lib/search-params";
import { CALL_OUTCOME_LABEL, isLeadStatus, LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, type LeadSourceKey } from "@/lib/wholesale/constants";
import { leadView } from "@/lib/wholesale/engine";
import { mapsLinkOf } from "@/lib/wholesale/field-handoff";
import { formatVnPhone } from "@/lib/wholesale/phone";
import { isLeadSegmentKey, LEAD_SEGMENT_LABEL } from "@/lib/wholesale/segments";
import { GradeBadge, LeadStatusBadge } from "@/app/(dashboard)/wholesale/leads/leads-table";
import { MobileCall } from "@/app/(dashboard)/wholesale/mobile/lead/[id]/mobile-call";

export const metadata = { title: "Gọi khách" };

/** Màn một khách trên điện thoại: tên · nhóm · điểm · trạng thái, rồi nút GỌI NGAY chiếm trọn bề ngang. */
export default async function WholesaleMobileLead({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("WHOLESALE_LEADS", "wholesale:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Gọi khách" reason={decision.reason} fix={decision.fix} />;
  const { id } = await params;
  if (!(await rowInScope(decision, "wholesale_leads", "id", id))) notFound();
  const data = await getWholesaleLead(id);
  if (!data) notFound();
  const sp = await searchParams;
  const f = Array.isArray(sp.f) ? sp.f[0] : sp.f;
  const chip = isMobileChip(f) ? f : "call";
  const { lead, snap } = data;
  const v = leadView(lead, snap);
  const status = isLeadStatus(lead.contactStatus) ? lead.contactStatus : "NEW";
  const segment = isLeadSegmentKey(lead.segment) ? LEAD_SEGMENT_LABEL[lead.segment] : lead.segment;
  const nationalMobile = v.phone && v.phoneKind === "MOBILE" && v.phone.startsWith("+84") ? `0${v.phone.slice(3)}` : null;
  // Zalo chỉ khi CÓ THẬT: link Zalo shop tự công bố, hoặc SĐT di động người bán đã gọi xác nhận / tự nhập (không đoán từ số Google).
  const zaloUrl = lead.zaloUrl ?? (nationalMobile && (lead.phoneSource === "VERIFIED_CALL" || lead.phoneSource === "STAFF") ? `https://zalo.me/${nationalMobile}` : null);
  const calls = data.activities.filter((a) => a.kind === "CALL").slice(0, 3);
  const notes = data.activities.filter((a) => a.kind === "NOTE").slice(0, 2);
  return (
    <div className="mx-auto max-w-md space-y-4 pb-10">
      <div className="flex items-center justify-between text-sm">
        <Link href={`/wholesale/mobile/queue?f=${chip}`} className="text-muted-foreground">
          ← Danh sách
        </Link>
        <Link href={`/wholesale/leads/${lead.id}`} className="text-muted-foreground underline">
          Chi tiết đầy đủ
        </Link>
      </div>
      <div className="space-y-1">
        <PageHeader title={v.name ?? "(chưa có tên — mở bản đồ)"} description={`${segment}${lead.areaName || lead.provinceLabel ? ` · ${[lead.areaName, lead.provinceLabel].filter(Boolean).join(", ")}` : ""}`} />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <GradeBadge grade={lead.leadGrade} score={lead.leadScore} />
          <LeadStatusBadge status={status} label={LEAD_STATUS_LABEL[status]} />
          <span className="text-xs text-muted-foreground">{LEAD_SOURCE_LABEL[lead.source as LeadSourceKey] ?? lead.source}</span>
        </div>
      </div>
      <MobileCall
        lead={{
          id: lead.id,
          status,
          phoneE164: v.phone,
          phoneDisplay: v.phone ? formatVnPhone(v.phone) : null,
          mapsUrl: mapsLinkOf(lead.placeId, snap && !snap.purgedAt ? snap.googleMapsUri : null, v.name),
          website: v.website && /^https?:\/\//i.test(v.website) ? v.website : null,
          zaloUrl: zaloUrl && /^https:\/\/(zalo\.me|oa\.zalo\.me)\//.test(zaloUrl) ? zaloUrl : null,
          doNotContact: status === "DO_NOT_CONTACT",
        }}
        nextHref={`/wholesale/mobile/next?f=${chip}&after=${lead.id}`}
        canWork={can(user, "wholesale:work")}
      />
      <div className="space-y-1.5 rounded-xl border bg-card p-3 text-sm">
        {v.address ? <div>📍 {v.address}</div> : null}
        {lead.nextAction ? <div>➡️ Việc tiếp theo: {lead.nextAction}</div> : null}
        {lead.nextFollowupAt ? <div>⏰ Hẹn gọi lại: {formatDateTime(lead.nextFollowupAt)}</div> : null}
        {lead.response ? <div>💬 Khách nói: {lead.response}</div> : null}
        <div className="text-xs text-muted-foreground">{lead.lastContactAt ? `Liên hệ gần nhất ${formatTimeAgo(lead.lastContactAt)} · ${lead.contactAttemptCount} lần gọi` : "Chưa liên hệ lần nào"}</div>
      </div>
      {calls.length || notes.length ? (
        <div className="space-y-1.5">
          <div className="text-sm font-semibold">Lần trước</div>
          {[...calls, ...notes].map((a) => (
            <div key={a.id} className="rounded-xl border bg-card p-2.5 text-sm">
              <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>{a.kind === "CALL" ? ((CALL_OUTCOME_LABEL as Record<string, string>)[a.outcome ?? ""] ?? a.outcome) : "Ghi chú"}</span>
                <span>
                  {a.actorName} · {formatDateTime(a.createdAt)}
                </span>
              </div>
              {a.note ? <div>{a.note}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
