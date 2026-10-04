import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { DescriptionList, EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { requireResource, rowInScope } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { assignableUsers, getWholesaleLead } from "@/lib/queries/wholesale";
import { ACTIVITY_KIND_LABEL, CALL_OUTCOME_LABEL, ENRICHMENT_STATUS_LABEL, FILTER_REASON_LABEL, LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, OUTREACH_CHANNEL_LABEL, OUTREACH_RESULT_LABEL, OUTREACH_STATUS_LABEL, isLeadStatus, type CallOutcome, type LeadSourceKey, type OutreachChannel, type OutreachResult } from "@/lib/wholesale/constants";
import { leadView } from "@/lib/wholesale/engine";
import { fieldHandoffOptions } from "@/lib/wholesale/field-handoff";
import { formatVnPhone, PHONE_KIND_LABEL } from "@/lib/wholesale/phone";
import type { ScoreComponent } from "@/lib/wholesale/scoring";
import { LEAD_SEGMENT_LABEL, isLeadSegmentKey } from "@/lib/wholesale/segments";
import { GoogleAttribution, WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { GradeBadge, LeadStatusBadge } from "@/app/(dashboard)/wholesale/leads/leads-table";
import { LeadActions } from "@/app/(dashboard)/wholesale/leads/[id]/lead-actions";

export const metadata = { title: "Lead khách sỉ" };

export default async function WholesaleLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, decision } = await requireResource("WHOLESALE_LEADS", "wholesale:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Lead khách sỉ" reason={decision.reason} fix={decision.fix} />;
  const { id } = await params;
  if (!(await rowInScope(decision, "wholesale_leads", "id", id))) notFound();
  const data = await getWholesaleLead(id);
  if (!data) notFound();
  const { lead, snap } = data;
  const v = leadView(lead, snap);
  const status = isLeadStatus(lead.contactStatus) ? lead.contactStatus : "NEW";
  const segment = isLeadSegmentKey(lead.segment) ? lead.segment : "UNCLASSIFIED";
  const reasons = (lead.scoreReasons ?? null) as { summary?: string; components?: ScoreComponent[] } | null;
  const googleExpired = Boolean(lead.placeId && (!snap || snap.purgedAt));
  const canWork = can(user, "wholesale:work");
  const [users, handoff] = await Promise.all([can(user, "wholesale:assign") ? assignableUsers() : Promise.resolve([]), fieldHandoffOptions()]);
  const phoneNational = v.phone?.startsWith("+84") ? `0${v.phone.slice(3)}` : v.phone;
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Khách sỉ tiềm năng"
        title={v.name ?? "Lead chưa có tên (dữ liệu Google đã hết hạn lưu)"}
        description={`${LEAD_SEGMENT_LABEL[segment]}${lead.areaName || lead.provinceLabel ? ` · ${[lead.areaName, lead.provinceLabel].filter(Boolean).join(", ")}` : ""}`}
        actions={<Link href="/wholesale/leads" className="text-sm text-muted-foreground hover:underline">← Danh sách</Link>}
      />
      <WholesaleNav user={user} active="leads" />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title="Thông tin doanh nghiệp" actions={lead.placeId ? <GoogleAttribution /> : null}>
            {googleExpired ? (
              <p className="mb-3 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Dữ liệu nguồn Google của lead này đã hết hạn lưu (theo điều khoản Google Maps Platform) và đã được xoá — chỉ còn Place ID. Bấm «Làm mới dữ liệu Google» (tốn một lượt Place Details) hoặc nhập thông tin khách xác nhận.
              </p>
            ) : null}
            <DescriptionList
              items={[
                { label: "Tên", value: v.name ?? "—" },
                { label: "Trạng thái", value: <LeadStatusBadge status={status} label={LEAD_STATUS_LABEL[status]} /> },
                { label: "SĐT", value: v.phone ? <span className="font-medium tabular-nums">{formatVnPhone(v.phone)} <span className="text-xs text-muted-foreground">({PHONE_KIND_LABEL[v.phoneKind ?? "UNKNOWN"]}{lead.normalizedPhone ? ` · ${lead.phoneSource === "WEBSITE" ? "từ website" : lead.phoneSource === "IMPORT" ? "từ tệp" : lead.phoneSource === "VERIFIED_CALL" ? "đã gọi xác nhận" : "nhân viên nhập"}` : " · Google"})</span></span> : "Chưa có" },
                { label: "Website", value: v.website && /^https?:\/\//i.test(v.website) ? <a className="text-primary hover:underline" href={v.website} target="_blank" rel="noopener noreferrer nofollow">{v.website}</a> : "—" },
                { label: "Địa chỉ", value: v.address ?? "—", span: true },
                { label: "Email", value: lead.email ?? "—" },
                { label: "Facebook / Zalo", value: lead.facebookUrl || lead.zaloUrl ? [lead.facebookUrl, lead.zaloUrl].filter((u): u is string => Boolean(u)).map((u) => <a key={u} className="mr-2 text-primary hover:underline" href={u} target="_blank" rel="noopener noreferrer nofollow">{u.includes("zalo") ? "Zalo" : "Facebook"}</a>) : "—" },
                { label: "Đánh giá Google", value: v.rating != null ? `${v.rating.toFixed(1)}★ · ${formatNumber(v.reviewCount ?? 0)} đánh giá` : v.ratingsRequested ? "Chưa có đánh giá" : "—" },
                { label: "Hoạt động", value: v.businessStatus === "OPERATIONAL" ? "Đang hoạt động" : (v.businessStatus ?? "—") },
                { label: "Nguồn", value: `${LEAD_SOURCE_LABEL[lead.source as LeadSourceKey] ?? lead.source}${data.sourceCampaign ? ` · chiến dịch «${data.sourceCampaign.name}»` : ""}` },
                { label: "Truy vấn tìm thấy", value: lead.sourceQuery ?? "—" },
                { label: "Lần đầu thấy", value: formatDateTime(lead.firstSeenAt) },
                { label: "Dữ liệu", value: `${ENRICHMENT_STATUS_LABEL[lead.enrichmentStatus] ?? lead.enrichmentStatus}${lead.filterReason ? ` — ${FILTER_REASON_LABEL[lead.filterReason] ?? lead.filterReason}` : ""}` },
              ]}
            />
            {lead.staffEditedFields.length ? <p className="mt-2 text-[11px] text-muted-foreground">Nhân viên đã sửa: {lead.staffEditedFields.join(", ")} — máy không ghi đè các ô này.</p> : null}
          </SectionCard>

          <SectionCard title="Điểm & lý do" hint="Điểm tính bằng luật cố định từ dữ liệu có thật — cùng dữ liệu luôn ra cùng điểm. AI không tham gia chấm.">
            <div className="flex items-center gap-3">
              <GradeBadge grade={lead.leadGrade} score={lead.leadScore} />
              <p className="text-sm">{reasons?.summary ?? "Chưa chấm (đang lấy chi tiết)."}</p>
            </div>
            {reasons?.components?.length ? (
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {reasons.components.map((c) => (
                    <tr key={c.key} className="border-t">
                      <td className="py-1.5 pr-3 font-medium">{c.label}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {c.points}/{c.max}
                      </td>
                      <td className="py-1.5 text-muted-foreground">{c.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </SectionCard>

          <SectionCard title="Lịch sử liên hệ & ghi chú">
            {data.activities.length ? (
              <ol className="space-y-2">
                {data.activities.map((a) => (
                  <li key={a.id} className="border-l-2 pl-3 text-sm">
                    <div className="text-[11px] text-muted-foreground">
                      {formatDateTime(a.createdAt)} · {a.actorName || "Máy"} · {ACTIVITY_KIND_LABEL[a.kind] ?? a.kind}
                      {a.channel ? ` · ${OUTREACH_CHANNEL_LABEL[a.channel as OutreachChannel] ?? a.channel}` : ""}
                      {a.outcome ? ` · ${CALL_OUTCOME_LABEL[a.outcome as CallOutcome] ?? OUTREACH_RESULT_LABEL[a.outcome as OutreachResult] ?? a.outcome}` : ""}
                      {a.toStatus ? ` · → ${LEAD_STATUS_LABEL[a.toStatus as keyof typeof LEAD_STATUS_LABEL] ?? a.toStatus}` : ""}
                    </div>
                    {a.note ? <div className="whitespace-pre-wrap">{a.note}</div> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState title="Chưa có liên hệ nào" description="Bấm «Gọi», rồi ghi kết quả cuộc gọi ở khối bên phải." />
            )}
          </SectionCard>

          <SectionCard title="Lời chào & liên hệ đã gửi">
            {data.outreach.length ? (
              <ul className="space-y-2 text-sm">
                {data.outreach.map((o) => (
                  <li key={o.id} className="rounded-md border p-2">
                    <div className="text-[11px] text-muted-foreground">
                      {OUTREACH_CHANNEL_LABEL[o.channel as OutreachChannel] ?? o.channel} · {OUTREACH_STATUS_LABEL[o.status] ?? o.status} · {o.preparedBy === "AI" ? "AI soạn" : o.preparedBy === "STAFF" ? "nhân viên sửa" : "theo mẫu"} · {formatTimeAgo(o.createdAt)}
                      {o.result ? ` · Kết quả: ${OUTREACH_RESULT_LABEL[o.result as OutreachResult] ?? o.result}` : ""}
                    </div>
                    <div className="whitespace-pre-wrap">{o.message}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Chưa soạn lời chào nào" />
            )}
          </SectionCard>

          {data.enrichments.length ? (
            <SectionCard title="Tìm thấy trên website của doanh nghiệp" hint="Chỉ đọc trang công khai; mỗi dòng ghi URL nguồn để kiểm lại.">
              <ul className="space-y-1 text-sm">
                {data.enrichments.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-2">
                    <span className="w-28 shrink-0 text-muted-foreground">{e.kind}</span>
                    <span className="break-all">{e.kind === "PHONE" ? formatVnPhone(e.value) : e.value}</span>
                    <a className="text-[11px] text-primary hover:underline" href={e.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                      nguồn
                    </a>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </div>

        <div className="space-y-4">
          <SectionCard title="Thao tác">
            <LeadActions
              lead={{
                id: lead.id,
                status,
                phone: phoneNational,
                website: v.website && /^https?:/i.test(v.website) ? v.website : null,
                mapsUrl: snap && !snap.purgedAt ? snap.googleMapsUri : null,
                placeId: lead.placeId,
                name: v.name,
                address: v.address,
                hasCustomer: Boolean(lead.customerId),
                assignedToUserId: lead.assignedToUserId,
                googleExpired,
                email: lead.email,
                facebookUrl: lead.facebookUrl,
                zaloUrl: lead.zaloUrl,
                businessName: lead.businessName,
                ownAddress: lead.address,
                ownPhone: lead.phoneRaw,
                ownWebsite: lead.website,
              }}
              canWork={canWork}
              users={users}
              handoff={handoff}
            />
          </SectionCard>

          <SectionCard title="Cơ hội & doanh thu">
            <DescriptionList
              columns={1}
              items={[
                { label: "Giá trị ước tính / tháng", value: lead.opportunityValue != null ? <Money value={lead.opportunityValue} /> : "—" },
                { label: "Khách quan tâm", value: lead.opportunityNote ?? "—" },
                { label: "Người phụ trách", value: lead.assignedToName ?? "Chưa giao" },
                { label: "Lần liên hệ", value: `${lead.contactAttemptCount} lần${lead.lastContactAt ? ` · gần nhất ${formatTimeAgo(lead.lastContactAt)}` : ""}` },
                { label: "Gọi lại", value: lead.nextFollowupAt ? formatDateTime(lead.nextFollowupAt) : "—" },
                { label: "Khách hàng ERP", value: data.customer ? <Link className="text-primary hover:underline" href={`/customers/${data.customer.id}`}>{data.customer.name}</Link> : "Chưa chuyển" },
                { label: "Doanh thu đã giao", value: data.revenue ? <span><Money value={data.revenue.revenue} /> · {data.revenue.delivered}/{data.revenue.orders} đơn đã giao</span> : "—" },
                { label: "Mất vì", value: lead.lostReason ?? "—" },
              ]}
            />
          </SectionCard>

          <SectionCard title="Chiến dịch">
            {data.campaigns.length ? (
              <ul className="space-y-1 text-sm">
                {data.campaigns.map((c) => (
                  <li key={c.id}>
                    <Link className="hover:underline" href={`/wholesale/leads?campaign=${c.id}`}>
                      {c.name}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Không thuộc chiến dịch nào.</p>
            )}
            {data.duplicates.length ? <p className="mt-2 text-[11px] text-muted-foreground">Gộp {data.duplicates.length} địa điểm trùng SĐT / website (chi nhánh hoặc trang trùng): {data.duplicates.map((d) => d.name ?? "?").join(", ")}</p> : null}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
