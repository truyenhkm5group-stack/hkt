import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { DisableConnectionButton, PilotStageControls, SuspendSwitch, UatConfirmForm, WorkflowPauseSwitch } from "@/components/platform/pilot-ops";
import { PILOT_STAGE_LABEL, PILOT_STAGE_MEANING, PILOT_STAGES, type PilotCheckState } from "@/lib/constants/pilot";
import { formatUsd } from "@/lib/ai-usage/types";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { Measured, OrgSupport } from "@/lib/platform/support";
import { cn } from "@/lib/utils";

/**
 * Ba khung đầu của `/platform/org/<mã>`: «Công tắc khẩn» · «Vòng đời pilot» · «Sức khoẻ & hỗ trợ». Server component —
 * chỉ in dữ liệu `loadOrgSupport` đã đo (số đếm, mốc, loại); mọi nút ghi nằm ở `pilot-ops.tsx` (client) và đi qua server
 * action có kiểm quyền + nhật ký.
 */

const CHECK_STYLE: Record<PilotCheckState, { label: string; cls: string }> = {
  PASS: { label: "Đạt", cls: "text-emerald-700 dark:text-emerald-300" },
  FAIL: { label: "Chưa đạt", cls: "font-semibold text-destructive" },
  NOT_APPLICABLE: { label: "Không áp dụng", cls: "text-muted-foreground" },
  UNKNOWN: { label: "Chưa đo được", cls: "text-amber-700 dark:text-amber-300" },
};

const BACKUP_STATE_LABEL: Record<string, string> = { HEALTHY: "Tốt", DEGRADED: "Có vấn đề", DOWN: "Hỏng / chưa có", UNKNOWN: "Chưa rõ" };

function bytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${formatNumber(n)} B`;
  if (n < 1024 * 1024) return `${formatNumber(Math.round(n / 102.4) / 10)} KB`;
  if (n < 1024 * 1024 * 1024) return `${formatNumber(Math.round(n / 104857.6) / 10)} MB`;
  return `${formatNumber(Math.round(n / 107374182.4) / 10)} GB`;
}

function Tile({ label, value, note, bad }: { label: string; value: React.ReactNode; note?: React.ReactNode; bad?: boolean }) {
  return (
    <div className="rounded-xl border border-hairline px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("numeric text-base font-bold", bad && "text-destructive")}>{value}</p>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** Ô CHƯA ĐO ĐƯỢC: "—" kèm lý do (luật 42). */
function tile<T>(label: string, m: Measured<T>, render: (v: T) => { value: React.ReactNode; note?: React.ReactNode; bad?: boolean }) {
  if (m.value === null) return <Tile label={label} value="—" note={m.note ?? "Chưa đo."} />;
  const r = render(m.value);
  return <Tile label={label} {...r} />;
}

export function KillSwitchPanel({ s, connections }: { s: OrgSupport; connections: { connectorKey: string; label: string; status: string }[] | null }) {
  const k = s.killSwitches;
  const o = s.organization;
  return (
    <SectionCard
      id="kill-switches"
      title="Công tắc khẩn"
      description="Có hiệu lực ngay, KHÔNG cần deploy · mọi lượt bấm cần lý do và vào nhật ký nền tảng"
      hint="Đình chỉ: chặn phiên, job, webhook, lịch của tổ chức — không xoá dữ liệu. Tạm dừng luật: bộ máy luật bỏ qua tổ chức, lượt chờ duyệt giữ nguyên. Tắt kết nối: qua sổ kết nối của tổ chức; bật lại là việc của quản trị tổ chức. Xem docs/platform/pilot-operations.md."
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-2 text-sm" data-kill-switch="suspend">
          <p className="font-semibold">
            1 · Tổ chức: <span className={cn(k.suspended ? "text-destructive" : "text-emerald-700 dark:text-emerald-300")}>{k.suspended ? "ĐANG ĐÌNH CHỈ" : o.status === "ACTIVE" ? "Đang chạy" : o.status}</span>
          </p>
          {k.lastStatusChange ? (
            <p className="text-xs text-muted-foreground">
              Lần đổi cuối {formatDateTime(k.lastStatusChange.at)} · {k.lastStatusChange.byEmail ?? "máy"} · «{k.lastStatusChange.reason ?? "—"}»
            </p>
          ) : null}
          {o.isHome ? (
            <p className="text-xs text-muted-foreground">Tổ chức nhà không đình chỉ được từ đây (đó là tổ chức của chính người vận hành).</p>
          ) : o.status === "ACTIVE" || o.status === "SUSPENDED" ? (
            <SuspendSwitch orgCode={o.code} orgName={o.name} suspended={k.suspended} />
          ) : (
            <p className="text-xs text-muted-foreground">Tổ chức đang {o.status} — công tắc này chỉ chuyển Đang chạy ⇄ Đình chỉ.</p>
          )}
        </div>

        <div className="space-y-2 text-sm" data-kill-switch="workflows">
          <p className="font-semibold">
            2 · Luật tự động: <span className={cn(k.workflowsPaused ? "text-destructive" : "text-emerald-700 dark:text-emerald-300")}>{k.workflowsPaused ? "ĐANG TẠM DỪNG" : "Đang chạy"}</span>
          </p>
          {k.lastPauseChange ? (
            <p className="text-xs text-muted-foreground">
              Lần đổi cuối {formatDateTime(k.lastPauseChange.at)} · {k.lastPauseChange.byEmail ?? "máy"} · «{k.lastPauseChange.reason ?? "—"}»
            </p>
          ) : null}
          <WorkflowPauseSwitch orgCode={o.code} orgName={o.name} paused={k.workflowsPaused} />
        </div>

        <div className="space-y-2 text-sm" data-kill-switch="connections">
          <p className="font-semibold">3 · Kết nối của tổ chức</p>
          {connections === null ? (
            <p className="text-xs text-muted-foreground">— Chưa đọc được bảng kết nối.</p>
          ) : connections.filter((c) => c.status !== "DISABLED").length === 0 ? (
            <p className="text-xs text-muted-foreground">Không có kết nối nào đang nháp / bật.</p>
          ) : (
            <ul className="space-y-3">
              {connections
                .filter((c) => c.status !== "DISABLED")
                .map((c) => (
                  <li key={c.connectorKey} className="space-y-1">
                    <p className="text-xs">
                      {c.label} · <span className="font-mono">{c.status}</span>
                    </p>
                    {o.status === "ACTIVE" ? <DisableConnectionButton orgCode={o.code} connectorKey={c.connectorKey} label={c.label} /> : null}
                  </li>
                ))}
            </ul>
          )}
        </div>

        <div className="space-y-2 text-sm" data-kill-switch="ai">
          <p className="font-semibold">4 · AI của tổ chức</p>
          <p className="text-xs" data-kill-ai={s.aiUsage.value ? (s.aiUsage.value.disabledReason ? "off" : "on") : "unknown"}>
            AI Builder đang:{" "}
            <span className="font-semibold">{s.aiUsage.value ? (s.aiUsage.value.disabledReason ? "TẮT" : "BẬT") : "—"}</span> —{" "}
            <a href="#ai-usage" className="font-medium text-primary hover:underline">
              tắt / đặt hạn mức ở khung «Dùng AI»
            </a>
          </p>
          <p className="font-semibold">5 · Đăng ký công khai (/start)</p>
          <p className="text-xs text-muted-foreground">
            Công tắc của cả nền tảng —{" "}
            <Link href="/platform#launch-gates" prefetch={false} className="font-medium text-primary hover:underline">
              Cổng mở bán B ở /platform
            </Link>
            .
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

export function PilotPanel({ s }: { s: OrgSupport }) {
  const p = s.pilot;
  const o = s.organization;
  if (!p) return null;
  if (o.isHome) {
    return (
      <SectionCard title="Vòng đời pilot" description="Tổ chức nhà không có vòng đời pilot">
        <p className="text-xs text-muted-foreground">—</p>
      </SectionCard>
    );
  }
  const stage = p.record.stage;
  return (
    <SectionCard
      id="pilot"
      title="Vòng đời pilot"
      description={stage ? `${PILOT_STAGE_LABEL[stage]} — ${PILOT_STAGE_MEANING[stage]}` : "Chưa theo dõi (tổ chức có từ trước vòng đời pilot)"}
      hint="Danh sách kiểm TÍNH từ dữ liệu thật của tổ chức (trừ «UAT đã xác nhận»). Chưa đo được = chưa đạt. Chỉ tiến một bậc mỗi lần; vượt cổng chưa đạt phải ghi đè có lý do ≥ 10 ký tự — nhật ký ghi lại cổng nào đã bị vượt."
    >
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-2">
          <ol className="flex flex-wrap gap-1.5 text-[11px]">
            {PILOT_STAGES.map((st) => (
              <li key={st} className={cn("rounded-full border px-2 py-0.5", st === stage ? "border-primary bg-primary/10 font-semibold" : "text-muted-foreground")}>
                {PILOT_STAGE_LABEL[st]}
              </li>
            ))}
          </ol>
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5">Mục</th>
                <th className="px-3 py-1.5">Kết quả</th>
              </tr>
            </thead>
            <tbody>
              {p.checks.map((c) => (
                <tr key={c.key} className="border-t border-hairline" data-pilot-check={c.key}>
                  <td className="px-3 py-1.5">
                    {c.label}
                    <div className="text-[11px] text-muted-foreground">{c.detail}</div>
                  </td>
                  <td className={cn("px-3 py-1.5 text-xs", CHECK_STYLE[c.state].cls)}>{CHECK_STYLE[c.state].label}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.suggested.length ? <p className="text-[11px] text-muted-foreground">Mẫu gợi ý kết nối: {p.suggested.map((x) => x.label).join(", ")}.</p> : null}
          {p.connectNote ? <p className="text-[11px] text-destructive">{p.connectNote}</p> : null}
          {p.record.uat ? (
            <p className="text-[11px] text-muted-foreground">
              UAT xác nhận {formatDateTime(p.record.uat.at)} · {p.record.uat.byEmail ?? "—"} · «{p.record.uat.note}»
            </p>
          ) : null}
        </div>
        <div className="space-y-4">
          <PilotStageControls orgCode={o.code} stage={stage} next={p.next} missingNext={p.missingNext.map((m) => m.label)} />
          {stage === "READY_FOR_UAT" && !p.record.uat ? <UatConfirmForm orgCode={o.code} /> : null}
        </div>
      </div>
    </SectionCard>
  );
}

export function SupportHealthPanel({ s }: { s: OrgSupport }) {
  return (
    <SectionCard
      title="Sức khoẻ & hỗ trợ"
      description={`Chỉ số đếm, dung lượng, mốc thời gian + loại — không dữ liệu nghiệp vụ của khách · lượt xem này đã ghi vào nhật ký nền tảng`}
      hint="Mỗi lần mở trang này ghi một dòng SUPPORT_VIEW (ai · tổ chức · lúc nào) vào nhật ký nền tảng TRƯỚC khi đọc CSDL của khách. “—” là CHƯA ĐO ĐƯỢC, không phải 0."
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {tile("Người dùng", s.users, (u) => ({ value: `${formatNumber(u.active)} / ${formatNumber(u.total)}`, note: `đang hoạt động / tổng · ${formatNumber(u.admins)} quản trị` }))}
        {tile("Đăng nhập cuối", s.users, (u) => ({ value: <span className="text-sm">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "Chưa ai"}</span> }))}
        {tile("Dung lượng", s.storage, (st) => ({ value: bytes(st.databaseBytes), note: `CSDL${st.databaseNote ? ` (${st.databaseNote})` : ""} · tệp ${bytes(st.fileBytes)} / ${formatNumber(st.fileCount)} tệp` }))}
        {tile("Dùng AI", s.aiUsage, (a) => ({
          value: `${formatNumber(a.requestsToday)} hôm nay · ${formatNumber(a.requestsMonth)} tháng`,
          note: `${a.disabledReason ? "ĐANG TẮT · " : ""}${a.costUsdMonth === null ? "tiền chưa rõ" : `~${formatUsd(a.costUsdMonth)}`}${a.unknownCostMonth > 0 ? ` · ${formatNumber(a.unknownCostMonth)} lượt chưa rõ giá` : ""} · ${formatNumber(a.blockedMonth)} bị chặn`,
          bad: a.blockedMonth > 0,
        }))}
        {tile("Luật 7 ngày", s.automation, (a) => ({ value: `${formatNumber(a.failed7d)} lỗi · ${formatNumber(a.stale)} treo`, note: `${formatNumber(a.waitingApproval)} lượt chờ duyệt`, bad: a.failed7d > 0 || a.stale > 0 }))}
        {tile("Kết nối", s.connections, (c) => ({
          value: `${formatNumber(c.active)} bật · ${formatNumber(c.disabled)} tắt`,
          note: `${formatNumber(c.draft)} nháp · ${formatNumber(c.failingTests)} kiểm hỏng · kiểm cuối ${c.lastTestAt ? formatDateTime(c.lastTestAt) : "—"}`,
          bad: c.failingTests > 0,
        }))}
        {tile("Hoạt động cuối", s.lastActivity, (a) => ({
          value: <span className="text-sm">{a.audit ? formatDateTime(a.audit.at) : "—"}</span>,
          note: `${a.audit ? `nhật ký: ${a.audit.action}` : "nhật ký trống"} · ${a.event ? `sự kiện ${a.event.name} ${formatDateTime(a.event.at)}` : "chưa có sự kiện"}`,
        }))}
        <Tile
          label="Sao lưu cuối"
          value={<span className="text-sm">{s.backup.lastSuccessAt ? formatDateTime(s.backup.lastSuccessAt) : "—"}</span>}
          note={`${BACKUP_STATE_LABEL[s.backup.state] ?? s.backup.state}${s.backup.ageHours !== null ? ` · ${formatNumber(Math.round(s.backup.ageHours))} giờ trước` : ""} · ${s.backup.reason}`}
          bad={s.backup.state === "DOWN"}
        />
        {tile("Lỗi 7 ngày", s.errors, (e) => ({
          value: `${formatNumber(e.failedJobs7d)} job`,
          note: `${formatNumber(e.blockFailures)} lỗi khối trang từ ${formatDateTime(e.blockSince)} (tiến trình này)${e.lastFailedJobAt ? ` · job lỗi cuối ${formatDateTime(e.lastFailedJobAt)}` : ""}`,
          bad: e.failedJobs7d > 0 || e.blockFailures > 0,
        }))}
      </div>
    </SectionCard>
  );
}
