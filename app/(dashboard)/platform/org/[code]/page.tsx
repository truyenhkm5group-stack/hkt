import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { OrgAiControlForm } from "@/components/ai-usage/ai-controls";
import { AiLimitsTable, AiUsageDailyTable, AiUsageTotalsTable } from "@/components/ai-usage/ai-usage-tables";
import { PageHeader } from "@/components/page-header";
import { KillSwitchPanel, PilotPanel, SupportHealthPanel } from "@/components/platform/org-support-panels";
import { OrgPlanControl } from "@/components/platform/pilot-ops";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { ORG_TEMPLATES } from "@/lib/constants/platform-modules";
import { HOME_PLAN_KEY, listPlans } from "@/lib/entitlements/check";
import { formatDateTime, formatNumber } from "@/lib/format";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { loadOperatorOrgAi } from "@/lib/ai-usage/view";
import { PILOT_STAGE_LABEL } from "@/lib/constants/pilot";
import { loadOrgSupport } from "@/lib/platform/support";
import { loadOrgDiagnostics, type Measured } from "@/lib/queries/platform-org-diagnostics";
import { STALE_RUN_KINDS } from "@/lib/workflow/stale";
import { cn } from "@/lib/utils";

export const metadata = { title: "Sức khoẻ tổ chức" };

const STATUS_LABEL: Record<string, string> = { ACTIVE: "Đang chạy", SUSPENDED: "Đình chỉ", ARCHIVED: "Lưu trữ", SETUP_FAILED: "Dựng hỏng" };
const RULE_STATUS_LABEL: Record<string, string> = { DRAFT: "Nháp", ACTIVE: "Đang bật", PAUSED: "Tạm dừng", ARCHIVED: "Lưu trữ" };
const DRAFT_STATUS_LABEL: Record<string, string> = { DRAFT: "Nháp", APPLIED: "Đã áp dụng", DISCARDED: "Đã bỏ" };

/** Mục CHƯA ĐO ĐƯỢC: in "—" kèm lý do — không bao giờ 0 (luật 42). */
function Unmeasured({ note }: { note: string | null }) {
  return <p className="px-5 py-3 text-xs text-muted-foreground">— {note ?? "Chưa đo."}</p>;
}

function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-hairline px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="numeric text-lg font-bold">{value}</p>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function measured<T>(m: Measured<T>, render: (v: T) => React.ReactNode) {
  return m.value === null ? <Unmeasured note={m.note} /> : render(m.value);
}

const th = "px-3 py-2";
const thead = "bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground";

/**
 * CHẨN ĐOÁN MỘT TỔ CHỨC — chỉ người của TỔ CHỨC NHÀ có `platform:operate` (như `/platform`).
 *
 * Kiểm hai lần: `requirePermission` rồi `platformOperatorDenial` ở trang, VÀ lại ở `loadOrgDiagnostics` (hàm đọc xuyên
 * ranh giới tổ chức). Phần chẩn đoán CHỈ ĐỌC. Ba khung đầu (docs/platform/pilot-operations.md): công tắc khẩn + vòng
 * đời pilot có nút GHI — mỗi nút qua hộp xác nhận + lý do + server action kiểm lại người vận hành + nhật ký nền tảng; tắt
 * kết nối đi qua sổ kết nối của tổ chức (không ghi thẳng bảng). MỖI lượt mở trang ghi `SUPPORT_VIEW` (`loadOrgSupport`).
 * Sửa module vẫn ở `/platform?org=<mã>`. Khung «Dùng AI» có công tắc AI + ghi đè hạn mức — chúng ghi vào MẶT PHẲNG
 * ĐIỀU KHIỂN (`platform_organizations.settings.ai`), có lý do và nhật ký nền tảng.
 */
export default async function PlatformOrgPage({ params }: { params: Promise<{ code: string }> }) {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const { code } = await params;
  // Sức khoẻ / hỗ trợ TRƯỚC: nó ghi vết SUPPORT_VIEW vào nhật ký nền tảng rồi mới đọc CSDL của khách. Vết không ghi
  // được ⇒ không mở trang (không đọc chẩn đoán luôn).
  const support = await loadOrgSupport(user, code);
  if (!support.ok) {
    if (support.code === "NOT_FOUND") notFound();
    if (support.code === "FORBIDDEN") redirect("/?forbidden=1");
    return (
      <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
        {support.error}
      </div>
    );
  }
  const s = support.value;
  const result = await loadOrgDiagnostics(user, code);
  if (!result.ok) {
    if (result.code === "NOT_FOUND") notFound();
    redirect("/?forbidden=1");
  }
  const d = result.value;
  const o = d.organization;
  const ai = await loadOperatorOrgAi(user, o.code);
  const plans = o.isHome ? [] : (await listPlans()).filter((x) => x.key !== HOME_PLAN_KEY).map((x) => ({ key: x.key, name: x.name }));
  const stage = s.pilot?.record.stage ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành nền tảng"
        title={`Sức khoẻ & chẩn đoán · ${o.name}`}
        description={`${o.code} · ${STATUS_LABEL[o.status] ?? o.status}${o.isHome ? " · tổ chức nhà" : stage ? ` · pilot: ${PILOT_STAGE_LABEL[stage]}` : ""}${s.killSwitches.workflowsPaused ? " · LUẬT TẠM DỪNG" : ""} · gói ${d.plan.value?.plan?.name ?? d.planKey} · đo lúc ${formatDateTime(d.checkedAt)}`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Chỉ ĐỌC CSDL của tổ chức này (mở như khi người của họ đăng nhập). Không hiện bí mật kết nối, không hiện nội dung người dùng gõ (mô tả gửi AI, câu lỗi của job) — chi tiết ở màn hình của chính tổ chức.</p>
            <p>“—” là CHƯA ĐO ĐƯỢC kèm lý do, không phải 0.</p>
          </div>
        }
        actions={
          <div className="flex gap-3 text-xs">
            <Link href={`/platform?org=${encodeURIComponent(o.code)}#module-editor`} prefetch={false} className="font-medium text-primary hover:underline">
              Sửa module
            </Link>
            <Link href="/platform" className="text-muted-foreground hover:text-foreground">
              Về danh sách
            </Link>
          </div>
        }
      />

      {!d.connected ? (
        <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm">
          {d.connectNote}
        </div>
      ) : null}

      <KillSwitchPanel s={s} connections={d.connections.value ? d.connections.value.map((c) => ({ connectorKey: c.connectorKey, label: c.label, status: c.status })) : null} />
      <PilotPanel s={s} />
      <SupportHealthPanel s={s} />

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Tổ chức & gói" description={`Mẫu ${o.templateKey ? (ORG_TEMPLATES[o.templateKey]?.label ?? o.templateKey) : "—"} · dòng module thiếu = ${o.moduleDefault === "ENABLED" ? "BẬT" : "TẮT"}`} padded={false}>
          {measured(d.plan, (u) => (
            <table className="w-full text-sm">
              <thead className={thead}>
                <tr>
                  <th className={th}>Hạn mức</th>
                  <th className={cn(th, "text-right")}>Đang dùng</th>
                  <th className={cn(th, "text-right")}>Trần gói</th>
                </tr>
              </thead>
              <tbody>
                {u.rows.map((r) => (
                  <tr key={r.kind} className="border-t border-hairline">
                    <td className="px-3 py-1.5" title={r.note ?? undefined}>
                      {r.label}
                    </td>
                    <td className={cn("numeric px-3 py-1.5 text-right", r.limit !== null && r.used !== null && r.used >= r.limit && "font-semibold text-destructive")}>{r.used === null ? "—" : formatNumber(Math.round(r.used * 10) / 10)}</td>
                    <td className="numeric px-3 py-1.5 text-right">{r.limit === null ? (r.undeclared ? "chưa khai" : "không giới hạn") : `${formatNumber(r.limit)} ${r.unit}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
          {!o.isHome && plans.length ? (
            <div className="border-t border-hairline px-3 py-3" data-org-plan-control={o.code}>
              <OrgPlanControl orgCode={o.code} orgName={o.name} current={d.planKey} plans={plans} />
            </div>
          ) : null}
        </SectionCard>

        <SectionCard title="Module đang bật" description={`${d.modules.enabled.length}/${d.modules.total}`}>
          <div className="flex flex-wrap gap-1.5">
            {d.modules.enabled.map((m) => (
              <span key={m.key} className="rounded-full bg-muted px-2 py-0.5 text-xs" title={m.key}>
                {m.label}
              </span>
            ))}
          </div>
          {d.modules.dependencyErrors.length || d.modules.unknownKeys.length ? (
            <ul className="mt-3 list-disc space-y-0.5 pl-4 text-xs text-destructive">
              {d.modules.dependencyErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
              {d.modules.unknownKeys.length ? <li>Khoá module không có trong sổ: {d.modules.unknownKeys.join(", ")}</li> : null}
            </ul>
          ) : null}
        </SectionCard>
      </div>

      {ai.ok ? (
        <SectionCard
          id="ai-usage"
          title="Dùng AI"
          description={ai.value.disabledReason ?? `Sổ platform_ai_usage · 31 ngày · gói ${ai.value.limits?.planName ?? "—"}`}
          hint="Chỉ số đếm, model, nguồn trả tiền — không prompt, không khoá. Tiền là ƯỚC TÍNH theo bảng giá model; “chưa rõ” = lượt chưa định giá được (không phải 0). Lượt bị chặn = hạn mức từ chối TRƯỚC khi gọi model."
          padded={false}
        >
          <div className="space-y-4 pb-4">
            <AiUsageTotalsTable today={ai.value.today} month={ai.value.month} />
            {ai.value.limits && !ai.value.limits.isHome ? <AiLimitsTable limits={ai.value.limits.limits} usage={ai.value.quotaUsage} undeclared={ai.value.limits.undeclared} /> : null}
            <AiUsageDailyTable rows={ai.value.daily} />
            <div className="border-t border-hairline px-5 pt-4">
              <p className="mb-2 text-sm font-semibold">Công tắc & ghi đè hạn mức AI</p>
              <OrgAiControlForm orgCode={o.code} orgName={o.name} disabled={ai.value.control.disabled} limits={ai.value.control.limits} cacheSeconds={ai.value.cacheSeconds} />
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Metadata" description="Field · form · danh sách · trang · đối tượng · bản ghi · luật">
        {measured(d.metadata, (m) => (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
            <Stat label="Field" value={formatNumber(m.fields.active)} note={`${formatNumber(m.fields.archived)} lưu trữ`} />
            <Stat label="Form" value={formatNumber(m.forms.total)} note={`${formatNumber(m.forms.published)} đã xuất bản`} />
            <Stat label="Danh sách" value={formatNumber(m.lists.total)} note={`${formatNumber(m.lists.published)} đã xuất bản`} />
            <Stat label="Trang" value={formatNumber(m.pages.active)} note={`${formatNumber(m.pages.published)} đã xuất bản · ${formatNumber(m.pages.archived)} lưu trữ`} />
            <Stat label="Đối tượng" value={formatNumber(m.objects.active)} note={`${formatNumber(m.objects.archived)} lưu trữ`} />
            <Stat label="Bản ghi tuỳ biến" value={formatNumber(m.records.live)} note={`${formatNumber(m.records.deleted)} đã xoá`} />
            <Stat label="Luật" value={formatNumber(m.workflows.ACTIVE)} note={(["DRAFT", "PAUSED", "ARCHIVED"] as const).map((s) => `${formatNumber(m.workflows[s])} ${RULE_STATUS_LABEL[s].toLowerCase()}`).join(" · ")} />
          </div>
        ))}
      </SectionCard>

      <SectionCard title="Lượt chạy luật đang treo" description={d.staleRuns.value ? `${formatNumber(d.staleRuns.value.total)} lượt` : undefined} hint="Cùng câu hỏi với /settings/workflows?view=stale của tổ chức đó (lib/workflow/stale.ts). Không hiện câu lỗi / bản ghi của lượt chạy." padded={false}>
        {measured(d.staleRuns, (s) =>
          s.total === 0 ? (
            <p className="px-5 py-3 text-xs text-muted-foreground">Không có lượt nào treo.</p>
          ) : (
            <div className="overflow-x-auto">
              <p className="px-5 pt-3 text-xs text-muted-foreground">{STALE_RUN_KINDS.filter((k) => s.byKind[k] > 0).map((k) => `${s.rows.find((r) => r.kind === k)?.kindLabel ?? k}: ${s.byKind[k]}`).join(" · ")}</p>
              <table className="w-full min-w-[640px] text-sm">
                <thead className={thead}>
                  <tr>
                    <th className={th}>Luật</th>
                    <th className={th}>Loại treo</th>
                    <th className={th}>Trạng thái</th>
                    <th className={cn(th, "text-right")}>Lần thử</th>
                    <th className={th}>Cập nhật</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r, i) => (
                    <tr key={i} className="border-t border-hairline">
                      <td className="px-3 py-1.5">{r.ruleName}</td>
                      <td className="px-3 py-1.5 text-xs">{r.kindLabel}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{r.status}</td>
                      <td className="numeric px-3 py-1.5 text-right">{r.attempt}</td>
                      <td className="px-3 py-1.5 text-xs">{formatDateTime(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ),
        )}
      </SectionCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Kết nối" description="Trạng thái · lần kiểm cuối — không bí mật, không cấu hình" padded={false}>
          {measured(d.connections, (rows) =>
            rows.length === 0 ? (
              <p className="px-5 py-3 text-xs text-muted-foreground">Tổ chức chưa khai kết nối nào.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className={thead}>
                  <tr>
                    <th className={th}>Connector</th>
                    <th className={th}>Trạng thái</th>
                    <th className={th}>Kiểm cuối</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.connectorKey} className="border-t border-hairline">
                      <td className="px-3 py-1.5">
                        {r.label}
                        <div className="font-mono text-[11px] text-muted-foreground">{r.connectorKey}</div>
                      </td>
                      <td className="px-3 py-1.5 text-xs">{r.statusLabel}</td>
                      <td className={cn("px-3 py-1.5 text-xs", r.lastTestOk === false && "font-semibold text-destructive")}>
                        {r.lastTestAt ? `${r.lastTestOk ? "Đạt" : "Hỏng"} · ${formatDateTime(r.lastTestAt)}` : "Chưa kiểm"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ),
          )}
        </SectionCard>

        <SectionCard title="Nháp AI" description="Số bản nháp và lần cuối — không hiện mô tả người dùng gõ">
          {measured(d.aiDrafts, (a) => (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Tổng" value={formatNumber(a.total)} note={Object.entries(a.byStatus).map(([k, n]) => `${formatNumber(n)} ${(DRAFT_STATUS_LABEL[k] ?? k).toLowerCase()}`).join(" · ") || undefined} />
              <Stat label="Hôm nay" value={formatNumber(a.today)} note="từ 00:00 giờ VN" />
              <Stat label="Đã áp dụng" value={formatNumber(a.applied)} />
              <Stat label="Lần cuối" value={<span className="text-sm">{a.lastCreatedAt ? formatDateTime(a.lastCreatedAt) : "—"}</span>} />
            </div>
          ))}
        </SectionCard>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Blueprint đã cài" description="Phiên bản đã cài = lượt DONE mới nhất" padded={false}>
          {measured(d.blueprints, (rows) =>
            rows.length === 0 ? (
              <p className="px-5 py-3 text-xs text-muted-foreground">Chưa cài blueprint nào.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className={thead}>
                  <tr>
                    <th className={th}>Blueprint</th>
                    <th className={th}>Đã cài</th>
                    <th className={th}>Lượt cuối</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.blueprintKey} className="border-t border-hairline">
                      <td className="px-3 py-1.5 font-mono text-xs">{r.blueprintKey}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{r.installedVersion ?? "—"}</td>
                      <td className={cn("px-3 py-1.5 text-xs", r.lastStatus === "FAILED" && "font-semibold text-destructive")}>
                        {r.lastVersion} · {r.lastStatus} · {formatDateTime(r.lastAt)} · {r.installs} lượt
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ),
          )}
        </SectionCard>

        <SectionCard title="Migration & lỗi khối trang">
          <div className="space-y-3 text-sm">
            {measured(d.migrations, (m) => (
              <p className={cn(m.expected !== null && m.applied !== m.expected && "font-semibold text-destructive")}>
                Đã áp <span className="numeric">{m.applied}</span>/<span className="numeric">{m.expected ?? "—"}</span> migration của mã nguồn · lần áp cuối {m.lastAppliedAt ? formatDateTime(m.lastAppliedAt) : "—"}
              </p>
            ))}
            <div>
              <p className="text-xs text-muted-foreground" title={d.blockFailures.note}>
                Lỗi khối trang từ {formatDateTime(d.blockFailures.since)} (tiến trình này) ⓘ
              </p>
              {d.blockFailures.rows.length === 0 ? (
                <p className="text-xs">Không ghi nhận lỗi bất ngờ nào.</p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {d.blockFailures.rows.map((r) => (
                    <li key={r.name}>
                      <span className="font-mono">{r.name}</span> · {r.count} lần · cuối {formatDateTime(r.lastAt)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Job gần đây" description="15 lượt mới nhất trong sync_runs của tổ chức — không hiện câu chi tiết / lỗi" padded={false}>
        {measured(d.jobs, (rows) =>
          rows.length === 0 ? (
            <EmptyState title="Chưa có lượt job nào" description="Tổ chức chưa chạy job đồng bộ nào ghi vào sync_runs." className="m-4" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className={thead}>
                  <tr>
                    <th className={th}>Job</th>
                    <th className={th}>Trạng thái</th>
                    <th className={th}>Bắt đầu</th>
                    <th className={th}>Xong</th>
                    <th className={cn(th, "text-right")}>Nhập · cập nhật · lỗi</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-hairline">
                      <td className="px-3 py-1.5 font-mono text-xs">
                        {r.source}/{r.job}
                      </td>
                      <td className={cn("px-3 py-1.5 text-xs", r.status === "FAILED" && "font-semibold text-destructive")}>{r.status}</td>
                      <td className="px-3 py-1.5 text-xs">{formatDateTime(r.startedAt)}</td>
                      <td className="px-3 py-1.5 text-xs">{r.finishedAt ? formatDateTime(r.finishedAt) : "—"}</td>
                      <td className="numeric px-3 py-1.5 text-right text-xs">
                        {r.imported} · {r.updated} · {r.failed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ),
        )}
      </SectionCard>
    </div>
  );
}
