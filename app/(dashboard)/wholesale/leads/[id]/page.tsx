import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { DescriptionList, EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { requireResource, rowInScope } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { assignableUsers, getWholesaleLead } from "@/lib/queries/wholesale";
import { ACTIVITY_KIND_LABEL, BUSINESS_STATUS_LABEL, CALL_OUTCOME_LABEL, ENRICHMENT_KIND_LABEL, ENRICHMENT_STATUS_LABEL, LEAD_FIELD_LABEL, FILTER_REASON_LABEL, LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, OUTREACH_CHANNEL_LABEL, OUTREACH_RESULT_LABEL, OUTREACH_STATUS_LABEL, isLeadStatus, type CallOutcome, type LeadSourceKey, type OutreachChannel, type OutreachResult } from "@/lib/wholesale/constants";
import { leadContactability } from "@/lib/wholesale/consents";
import { CONSENT_CHANNELS } from "@/lib/wholesale/contactability";
import { leadView } from "@/lib/wholesale/engine";
import { EMAIL_CONSENT_NOTICE, EMAIL_MX_LABEL, EMAIL_RESCAN_DAYS, EMAIL_ROLE_LABEL, EMAIL_VIA_LABEL } from "@/lib/constants/wholesale-email";
import { websiteDomain } from "@/lib/wholesale/dedupe";
import { emailScanOf, leadEmailRows } from "@/lib/wholesale/email-discovery";
import { fieldHandoffOptions } from "@/lib/wholesale/field-handoff";
import { formatVnPhone, PHONE_KIND_LABEL } from "@/lib/wholesale/phone";
import type { ScoreComponent } from "@/lib/wholesale/scoring";
import { LEAD_SEGMENT_LABEL, isLeadSegmentKey } from "@/lib/wholesale/segments";
import { leadTemperature } from "@/lib/wholesale/temperature";
import { GoogleAttribution, WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { GradeBadge, LeadStatusBadge, TemperatureBadge } from "@/app/(dashboard)/wholesale/leads/leads-table";
import { ConsentPanel } from "@/app/(dashboard)/wholesale/leads/[id]/consent-panel";
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
  const [users, handoff, contact] = await Promise.all([can(user, "wholesale:assign") ? assignableUsers() : Promise.resolve([]), fieldHandoffOptions(), leadContactability(lead, snap, "AUTOMATED")]);
  const lastNote = data.activities.find((a) => (a.kind === "NOTE" || a.kind === "CALL") && a.note);
  const temp = leadTemperature({ grade: lead.leadGrade, status, lastContactAt: lead.lastContactAt, firstResponseAt: lead.firstResponseAt, lastActivityAt: lastNote?.createdAt ?? null, nextFollowupAt: lead.nextFollowupAt, contactAttemptCount: lead.contactAttemptCount });
  const phoneNational = v.phone?.startsWith("+84") ? `0${v.phone.slice(3)}` : v.phone;
  const emailScan = data.activities.map((a) => (a.kind === "ENRICHED" ? emailScanOf(a.meta) : null)).find((x) => x != null) ?? null;
  const emailRows = leadEmailRows(
    data.enrichments.filter((e) => e.kind === "EMAIL"),
    emailScan,
    lead.email,
    lead.websiteDomain ?? websiteDomain(v.website),
  );
  const profileEmailRow = emailRows.find((r) => r.inProfile && r.inLatestScan) ?? null;
  const rescanAt = lead.websiteCheckedAt ? new Date(lead.websiteCheckedAt.getTime() + EMAIL_RESCAN_DAYS * 86_400_000) : null;
  const otherEnrichments = data.enrichments.filter((e) => e.kind !== "EMAIL");
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Khách sỉ tiềm năng"
        title={v.name ?? "Lead chưa có tên (dữ liệu Google đã hết hạn lưu)"}
        description={`${LEAD_SEGMENT_LABEL[segment]}${lead.areaName || lead.provinceLabel ? ` · ${[lead.areaName, lead.provinceLabel].filter(Boolean).join(", ")}` : ""}`}
        actions={
          <span className="flex items-center gap-3">
            {canWork && status !== "DO_NOT_CONTACT" ? (
              <Link href={`/wholesale/quotations/new?lead=${encodeURIComponent(lead.id)}`} className="rounded-md border px-2.5 py-1 text-sm font-medium hover:bg-muted">
                Tạo báo giá
              </Link>
            ) : null}
            <Link href="/wholesale/leads" className="text-sm text-muted-foreground hover:underline">← Danh sách</Link>
          </span>
        }
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
                { label: "Email", value: lead.email ? <span>{lead.email}{profileEmailRow ? <span className="text-xs text-muted-foreground"> ({EMAIL_ROLE_LABEL[profileEmailRow.role]} · {EMAIL_MX_LABEL[profileEmailRow.mx]})</span> : null}</span> : "—" },
                { label: "Facebook / Zalo", value: lead.facebookUrl || lead.zaloUrl ? [lead.facebookUrl, lead.zaloUrl].filter((u): u is string => Boolean(u)).map((u) => <a key={u} className="mr-2 text-primary hover:underline" href={u} target="_blank" rel="noopener noreferrer nofollow">{u.includes("zalo") ? "Zalo" : "Facebook"}</a>) : "—" },
                { label: "Đánh giá Google", value: v.rating != null ? `${v.rating.toFixed(1)}★${v.reviewCount != null ? ` · ${formatNumber(v.reviewCount)} đánh giá` : ""}` : v.ratingsRequested ? "Chưa có đánh giá" : "—" },
                { label: "Hoạt động", value: v.businessStatus ? (BUSINESS_STATUS_LABEL[v.businessStatus] ?? "Chưa rõ") : "—" },
                { label: "Nguồn", value: `${LEAD_SOURCE_LABEL[lead.source as LeadSourceKey] ?? lead.source}${data.sourceCampaign ? ` · chiến dịch «${data.sourceCampaign.name}»` : ""}` },
                { label: "Truy vấn tìm thấy", value: lead.sourceQuery ?? "—" },
                { label: "Lần đầu thấy", value: formatDateTime(lead.firstSeenAt) },
                { label: "Dữ liệu", value: `${ENRICHMENT_STATUS_LABEL[lead.enrichmentStatus] ?? lead.enrichmentStatus}${lead.filterReason ? ` — ${FILTER_REASON_LABEL[lead.filterReason] ?? lead.filterReason}` : ""}` },
              ]}
            />
            {lead.staffEditedFields.length ? <p className="mt-2 text-[11px] text-muted-foreground">Nhân viên đã sửa: {lead.staffEditedFields.map((f) => LEAD_FIELD_LABEL[f] ?? f).join(", ")} — máy không ghi đè các ô này.</p> : null}
          </SectionCard>

          <SectionCard title="Điểm & lý do" hint="Điểm tính bằng luật cố định từ dữ liệu có thật — cùng dữ liệu luôn ra cùng điểm. AI không tham gia chấm.">
            <div className="flex items-center gap-3">
              <GradeBadge grade={lead.leadGrade} score={lead.leadScore} />
              <p className="text-sm">{reasons?.summary ?? "Chưa chấm (đang lấy chi tiết)."}</p>
            </div>
            <div className="mt-2 text-sm">
              <span className="mr-2 text-xs text-muted-foreground">Nhiệt độ lúc này:</span>
              <TemperatureBadge temperature={temp.temperature} reasons={temp.reasons} showReasons />
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

          {emailRows.length || lead.websiteCheckedAt ? (
            <SectionCard
              title="Email tìm được trên website"
              hint="Chỉ đọc trang công khai CÙNG website, tôn trọng robots.txt. «Tên miền nhận thư» = tên miền có bản ghi MX (hoặc A) — kiểm bằng DNS, KHÔNG gửi thư, KHÔNG dò hộp thư."
            >
              <p className="mb-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">{EMAIL_CONSENT_NOTICE}</p>
              {emailRows.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-1.5 pr-3 text-left font-medium">Email</th>
                        <th className="py-1.5 pr-3 text-left font-medium">Vai trò</th>
                        <th className="py-1.5 pr-3 text-left font-medium">Tên miền</th>
                        <th className="py-1.5 pr-3 text-left font-medium">Nguồn</th>
                        <th className="py-1.5 text-left font-medium">Xác minh</th>
                      </tr>
                    </thead>
                    <tbody>
                      {emailRows.map((r) => (
                        <tr key={r.email} className="border-b last:border-0 align-top">
                          <td className="py-1.5 pr-3 break-all">
                            {r.email}
                            {r.inProfile ? <span className="ml-1 text-[11px] font-medium text-primary">(đang dùng)</span> : null}
                            {r.sameDomain ? <div className="text-[11px] text-muted-foreground">cùng tên miền website</div> : null}
                          </td>
                          <td className="py-1.5 pr-3 whitespace-nowrap">{EMAIL_ROLE_LABEL[r.role]}</td>
                          <td className={r.mx === "VALID_MX" ? "py-1.5 pr-3 text-emerald-700 dark:text-emerald-300" : r.mx === "NO_MX" ? "py-1.5 pr-3 text-rose-700 dark:text-rose-300" : "py-1.5 pr-3 text-muted-foreground"}>
                            {EMAIL_MX_LABEL[r.mx]}
                            {r.mxVia === "A" ? <div className="text-[11px] text-muted-foreground">không có MX, nhận qua bản ghi A</div> : null}
                          </td>
                          <td className="py-1.5 pr-3">
                            <a className="text-[11px] text-primary hover:underline" href={r.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                              trang nguồn
                            </a>
                            {r.inLatestScan ? <div className="text-[11px] text-muted-foreground">{EMAIL_VIA_LABEL[r.via]}</div> : null}
                          </td>
                          <td className="py-1.5 text-[11px] text-muted-foreground">{r.verifiedAt ? formatDateTime(r.verifiedAt) : `không thấy ở lượt quét gần nhất · tìm thấy ${formatDateTime(r.firstSeenAt)}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Đã đọc website nhưng không thấy email doanh nghiệp công bố.</p>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                {lead.websiteCheckedAt ? `Đọc website lần gần nhất ${formatDateTime(lead.websiteCheckedAt)}` : "Chưa đọc website"}
                {rescanAt && !lead.email ? ` · nút «Thu thập email» quét lại được từ ${formatDateTime(rescanAt)}` : ""}
              </p>
            </SectionCard>
          ) : null}

          {otherEnrichments.length ? (
            <SectionCard title="Tìm thấy trên website của doanh nghiệp" hint="Chỉ đọc trang công khai; mỗi dòng ghi URL nguồn để kiểm lại.">
              <ul className="space-y-1 text-sm">
                {otherEnrichments.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-2">
                    <span className="w-28 shrink-0 text-muted-foreground">{ENRICHMENT_KIND_LABEL[e.kind] ?? "Khác"}</span>
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

          <SectionCard title="Đồng ý liên hệ" hint="Bằng chứng khách cho phép liên hệ, chỉ thêm — thu hồi để lại vết. Máy chỉ được TỰ liên hệ một kênh khi có đồng ý còn hiệu lực cho đúng địa chỉ đó.">
            <ConsentPanel
              leadId={lead.id}
              canWork={canWork}
              schemaReady={contact.schemaReady}
              verdicts={CONSENT_CHANNELS.map((ch) => ({ channel: ch, allowed: contact.byChannel[ch].allowed, detail: contact.byChannel[ch].detail }))}
              rows={contact.consents.map((c) => ({ id: c.id, channel: c.channel, contactValue: c.contactValue, basis: c.basis, evidenceText: c.evidenceText, evidenceUrl: c.evidenceUrl, recordedByName: c.recordedByName, recordedAt: c.recordedAt.toISOString(), revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null, revokeReason: c.revokeReason, revokedByName: c.revokedByName }))}
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
