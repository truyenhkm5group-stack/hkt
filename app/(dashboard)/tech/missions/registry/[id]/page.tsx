import Link from "next/link";
import { notFound } from "next/navigation";
import { TechPriorityBadge } from "@/app/(dashboard)/tech/badges";
import { DeliveryBadge, LivenessBadge, MissionControlBadge, RegistryRiskBadge } from "@/app/(dashboard)/tech/missions/registry-badges";
import { TechNav } from "@/app/(dashboard)/tech/tech-nav";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import type { TechPriority } from "@/lib/constants/tech";
import {
  EVIDENCE_CLASS_LABEL,
  MISSION_CONTROL_LABEL,
  REGISTRY_PHASE_LABEL,
  TECH_REGISTRY_BRANCH,
  ownerEscalationLabel,
  registryProjectLabel,
  verifyPassed,
} from "@/lib/constants/tech-registry";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { getRegistryMission } from "@/lib/queries/tech-registry";

export const metadata = { title: "Sứ mệnh (sổ Tech Room) · Phòng Tech AI" };

/**
 * Chi tiết MỘT sứ mệnh của sổ Tech Room — chỉ đọc. Bốn câu chủ shop hỏi: đang ở đâu · bằng chứng gì · ai làm · còn
 * vướng gì. Bằng chứng in NGUYÊN VĂN của sổ kèm phép phân loại (vì sao được / không được coi là đã kiểm production).
 */
export default async function RegistryMissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("tech:view");
  const data = await getRegistryMission(decodeURIComponent(id));
  if (!data) notFound();
  const { row, view, events, deps, dependents, tasks, repo } = data;
  const { entry, evidence: done } = view;
  const v = view.row;
  const ev = entry.evidence ?? {};
  const prLink = (n: number) =>
    repo ? (
      <a key={n} href={`https://github.com/${repo}/pull/${n}`} target="_blank" rel="noreferrer" className="font-semibold text-primary hover:underline">
        #{n}
      </a>
    ) : (
      <span key={n}>#{n}</span>
    );

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Sổ Tech Room · ${row.registryId}`}
        title={entry.title || row.registryId}
        description={`${registryProjectLabel(v.project)} (suy từ mã) · tạo ${formatDateTime(entry.createdAt)} · cập nhật ${formatTimeAgo(v.updatedAt)}`}
        actions={
          <Link href="/tech/missions" className="text-xs font-semibold text-primary hover:underline">
            ← Mọi sứ mệnh
          </Link>
        }
        hint={
          <>
            Trang CHỈ ĐỌC — chép từ nhánh <code>{TECH_REGISTRY_BRANCH}</code> lúc đọc sổ{" "}
            {formatTimeAgo(row.syncedAt)}. Đổi gì thì đổi ở sổ bằng <code>npm run ai -- …</code>.
          </>
        }
      />
      <TechNav />

      <div className="flex flex-wrap items-center gap-1.5">
        <MissionControlBadge state={v.state} />
        {v.phase ? <span className="text-xs text-muted-foreground">sổ: {REGISTRY_PHASE_LABEL[v.phase as keyof typeof REGISTRY_PHASE_LABEL] ?? v.phase}</span> : null}
        <LivenessBadge liveness={v.liveness} />
        <TechPriorityBadge priority={entry.priority as TechPriority} />
        <RegistryRiskBadge risk={entry.risk} />
        {v.delivery ? <DeliveryBadge level={v.delivery} /> : null}
        {!row.inRegistry ? <span className="text-xs font-semibold text-destructive">Đã biến khỏi sổ {formatTimeAgo(row.removedAt)}</span> : null}
      </div>

      {v.state === "WAITING_APPROVAL" ? (
        <div className="rounded-xl border-2 border-fuchsia-200 bg-card p-4 dark:border-fuchsia-900">
          <p className="text-xs font-bold uppercase tracking-wide text-fuchsia-700 dark:text-fuchsia-300">{ownerEscalationLabel(entry.needsOwner?.category)}</p>
          <p className="mt-1 text-base font-semibold leading-snug">{entry.needsOwner?.action || entry.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">Chờ từ {formatDateTime(row.stateSince)} ({formatTimeAgo(row.stateSince)})</p>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title="Bằng chứng" description="Nguyên văn sổ · CODE_DONE (gộp) → DEPLOYED (production chứa commit gộp) → PRODUCT_VERIFIED (kiểm hành vi trên production)">
            <DescriptionList
              columns={1}
              items={[
                { label: "Gộp (merged)", value: ev.merged || <span className="text-muted-foreground">— chưa có</span> },
                {
                  label: "Hậu kiểm (verify)",
                  value: ev.verify ? (
                    <span>
                      {ev.verify}
                      {verifyPassed(ev.verify) ? <span className="text-muted-foreground"> — chỉ chứng minh health / phiên bản ⇒ DEPLOYED</span> : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">— chưa có</span>
                  ),
                },
                {
                  label: "Deploy",
                  value: ev.deploy ? (
                    /^https:\/\/github\.com\//.test(ev.deploy) ? (
                      <a href={ev.deploy} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">
                        {ev.deploy}
                      </a>
                    ) : (
                      ev.deploy
                    )
                  ) : (
                    <span className="text-muted-foreground">— chưa có</span>
                  ),
                },
                {
                  label: "ERP tự kiểm production",
                  value:
                    row.deployCheck === "CONTAINED" ? (
                      <span className="text-success">Commit production {row.deployCheckedCommit.slice(0, 7)} CHỨA commit gộp ({formatTimeAgo(row.deployCheckedAt)})</span>
                    ) : row.deployCheck === "NOT_CONTAINED" ? (
                      <span className="text-warning">Commit production {row.deployCheckedCommit.slice(0, 7)} CHƯA chứa commit gộp ({formatTimeAgo(row.deployCheckedAt)})</span>
                    ) : (
                      <span className="text-muted-foreground">Chưa kiểm — cần commit gộp đủ 40 ký tự trong sổ và ERP_COMMIT trên máy chủ</span>
                    ),
                },
                { label: "Chốt (done)", value: ev.done || <span className="text-muted-foreground">— chưa có</span> },
                ...(done
                  ? [
                      {
                        label: "Phân loại bằng chứng chốt",
                        value: (
                          <span className={done.kind === "PRODUCT_VERIFIED" ? "text-success" : "text-warning"}>
                            {EVIDENCE_CLASS_LABEL[done.kind]} — {done.reason}
                            {done.kind !== "PRODUCT_VERIFIED" ? ` ⇒ ${MISSION_CONTROL_LABEL.DONE_UNVERIFIED}, không đếm vào xong` : ""}
                          </span>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </SectionCard>

          <SectionCard title="Báo cáo bàn giao" description="Bản `handoff` cuối của worker">
            {entry.handoff ? (
              <div className="space-y-2 text-sm">
                <p className="font-semibold">{entry.handoff.title}</p>
                {entry.handoff.summary ? <p className="whitespace-pre-wrap">{entry.handoff.summary}</p> : null}
                {entry.handoff.tests.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-xs">
                    {entry.handoff.tests.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="break-all text-[11px] text-muted-foreground">
                  {entry.handoff.branch} @ <span className="font-mono">{entry.handoff.sha.slice(0, 12)}</span> · {entry.handoff.actor} · {formatDateTime(entry.handoff.at)}
                </p>
              </div>
            ) : (
              <EmptyState title="Chưa bàn giao" description="Worker chưa chạy `handoff` cho sứ mệnh này." />
            )}
          </SectionCard>

          <SectionCard title="Lịch sử" description={`${events.length} sự kiện từ events.ndjson · mới nhất trước`}>
            {events.length ? (
              <ul className="divide-y divide-hairline">
                {events.map((e) => (
                  <li key={e.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 text-xs">
                      <span className="font-semibold">{e.kind}</span>
                      <span className="text-muted-foreground">{formatDateTime(e.at)}</span>
                      <span className="truncate text-muted-foreground">{e.actor}</span>
                    </div>
                    {e.detail ? <p className="mt-0.5 whitespace-pre-wrap break-words text-xs">{e.detail}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Chưa có sự kiện" description="Nhật ký sổ chưa có dòng nào gắn sứ mệnh này (hoặc sổ chưa đọc events.ndjson)." />
            )}
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard title="Ai · ở đâu">
            <DescriptionList
              columns={1}
              items={[
                { label: "Phụ trách (AI_LEAD_ID)", value: <span className="break-all">{entry.owner || "—"}</span> },
                { label: "Worker", value: <span className="break-all">{entry.worker || "—"}</span> },
                { label: "Nhánh", value: <span className="break-all font-mono text-xs">{entry.branch || "—"}</span> },
                { label: "Pull request", value: entry.relatedPrs.length ? <span className="flex flex-wrap gap-2">{entry.relatedPrs.map(prLink)}</span> : "—" },
                { label: "Nhịp tim cuối", value: `${formatDateTime(entry.lastHeartbeat)} (${formatTimeAgo(entry.lastHeartbeat)})` },
                { label: "Giữ chỗ migration", value: entry.migrationReservations.length ? entry.migrationReservations.join(", ") : "—" },
              ]}
            />
          </SectionCard>

          <SectionCard title="Phụ thuộc" description="`after` / `blocked_by` và sứ mệnh đang chờ sứ mệnh này">
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Phải xong trước</p>
                {deps.length ? (
                  <ul className="mt-1 space-y-1">
                    {deps.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-1.5">
                        <Link href={`/tech/missions/registry/${encodeURIComponent(d.id)}`} className="font-mono text-xs text-primary hover:underline">
                          {d.id}
                        </Link>
                        {d.state ? <MissionControlBadge state={d.state} /> : <span className="text-xs text-muted-foreground">không có trong sổ</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">Không khai phụ thuộc.</p>
                )}
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Đang chờ sứ mệnh này</p>
                {dependents.length ? (
                  <ul className="mt-1 space-y-1">
                    {dependents.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-1.5">
                        <Link href={`/tech/missions/registry/${encodeURIComponent(d.id)}`} className="font-mono text-xs text-primary hover:underline">
                          {d.id}
                        </Link>
                        <MissionControlBadge state={d.state} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">Không sứ mệnh nào khai chờ.</p>
                )}
              </div>
              {tasks.length ? (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground">Việc trong /tech cùng PR</p>
                  <ul className="mt-1 space-y-1 text-xs">
                    {tasks.map((t) => (
                      <li key={t.id}>
                        <Link href={`/tech/tasks/${t.id}`} className="text-primary hover:underline">
                          {t.code}
                        </Link>{" "}
                        · {t.title} · PR #{t.prNumber} {t.ciState ? `· CI ${t.ciState}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title="Phạm vi tệp" description={`${entry.ownedPaths.length} mẫu đường dẫn sứ mệnh giữ`}>
            {entry.ownedPaths.length ? (
              <ul className="space-y-0.5 font-mono text-[11px]">
                {entry.ownedPaths.map((p) => (
                  <li key={p} className="break-all">
                    {p}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Không khai.</p>
            )}
          </SectionCard>

          {entry.businessGoal || entry.definitionOfDone.length ? (
            <SectionCard title="Mục tiêu">
              <div className="space-y-2 text-sm">
                {entry.businessGoal ? <p className="whitespace-pre-wrap">{entry.businessGoal}</p> : null}
                {entry.definitionOfDone.length ? (
                  <ul className="list-disc pl-5 text-xs">
                    {entry.definitionOfDone.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}
