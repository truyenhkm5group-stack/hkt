import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { GraduationForm } from "@/app/(dashboard)/departments/mission-control/graduation-form";
import { can, requirePermission } from "@/lib/auth/session";
import { GRADUATION_VERDICT_LABEL, MC_WINDOWS, accuracyOf, type GraduationVerdict, type ReviewSample } from "@/lib/constants/mission-control";
import { formatDateTime, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { loadMissionControl, type UsageCell, type ZoneRow } from "@/lib/queries/mission-control";
import { cn } from "@/lib/utils";

export const metadata = { title: "Mission Control — AI agent" };

const NOT_MEASURED = "chưa đo được";

function usd(v: number | null): string {
  return v === null ? "—" : `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

function UsageCellView({ u, w }: { u: UsageCell; w: number }) {
  return (
    <div>
      <span className="font-medium">{formatNumber(u.turns)}</span> lượt · {usd(u.costUsd)}
      <span className="text-muted-foreground"> /{w}n</span>
      {u.unknownCost ? <span className="text-muted-foreground" title="Lượt chưa định giá được — không cộng là 0"> · {formatNumber(u.unknownCost)} chưa rõ giá</span> : null}
    </div>
  );
}

function ReviewView({ r, w }: { r: ReviewSample; w: number }) {
  const acc = accuracyOf(r);
  return (
    <div>
      <span className="font-medium">{acc === null ? "—" : formatPercent(acc * 100, 0)}</span> đúng · {formatNumber(r.correct)}/{formatNumber(r.sample)}
      <span className="text-muted-foreground"> /{w}n</span>
    </div>
  );
}

const VERDICT_TONE: Record<GraduationVerdict["kind"], string> = {
  NO_RULE: "text-muted-foreground",
  NOT_MEASURABLE: "text-muted-foreground",
  INSUFFICIENT_SAMPLE: "text-muted-foreground",
  PASS: "font-semibold text-emerald-700 dark:text-emerald-400",
  FAIL: "font-semibold text-amber-700 dark:text-amber-400",
};

function VerdictView({ z }: { z: ZoneRow }) {
  const v = z.verdict;
  const detail =
    v.kind === "PASS" || v.kind === "FAIL"
      ? ` · ${formatPercent(v.accuracy * 100, 0)} / đích ${formatPercent(v.minAccuracyPct, 0)} · ${formatNumber(v.sample)} mẫu (cần ${formatNumber(v.need)})`
      : v.kind === "INSUFFICIENT_SAMPLE"
        ? ` · ${formatNumber(v.sample)}/${formatNumber(v.need)} mẫu`
        : v.kind === "NOT_MEASURABLE"
          ? ` · ${v.missing}`
          : "";
  return (
    <div className={cn("text-xs", VERDICT_TONE[v.kind])}>
      {GRADUATION_VERDICT_LABEL[v.kind]}
      <span className="font-normal text-muted-foreground">{detail}</span>
      {z.rule ? <div className="font-normal text-muted-foreground">đích {formatPercent(z.rule.minAccuracyPct, 0)} · ≥ {formatNumber(z.rule.minSamples)} mẫu · {z.rule.windowDays} ngày</div> : null}
    </div>
  );
}

/**
 * MISSION CONTROL (chủ shop 30/10/2026) — đo các AI agent ĐANG CÓ theo sổ `lib/constants/department-ai.ts`: nấc tự chủ, lượt / chi phí
 * AI, việc máy phát hiện trên /work, tỷ lệ người duyệt / bác, kết quả bằng tiền thật nơi có, và điều kiện «tốt nghiệp» do chủ shop
 * khai. Chỉ đọc; khai điều kiện không đổi nấc. Quyền: approvals:decide (người điều hành) — khai điều kiện cần settings:manage.
 */
export default async function MissionControlPage() {
  const user = await requirePermission("approvals:decide");
  const mc = await loadMissionControl();
  const canEdit = can(user, "settings:manage");
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Ban điều hành"
        title="Mission Control — AI agent"
        description={`${formatNumber(mc.zones.length)} agent theo sổ phòng ban · tính lúc ${formatDateTime(mc.generatedAt)}`}
        hint="Mỗi dòng là một khoá của sổ department-ai (không có danh sách agent thứ hai). «chưa đo được» = ERP chưa có nguồn ghi chỉ số đó, kèm thiếu gì — không phải 0. Chi phí là USD token theo sổ dùng AI của tổ chức. Tiền kết quả = tiền CÓ CHỨNG TỪ của đơn giao thành công. Đủ điều kiện tốt nghiệp chỉ là thông tin: máy KHÔNG tự đổi nấc."
        actions={
          <Link href="/departments" className="text-sm font-semibold text-primary hover:underline">
            Bản đồ phòng ban & AI
          </Link>
        }
      />
      {mc.workFailed.length ? <p className="text-xs text-amber-700 dark:text-amber-400">Hàng đợi /work đang thiếu một phần ({mc.workFailed.join(", ")}) — số việc có thể thấp hơn thật.</p> : null}
      <SectionCard padded={false}>
        {mc.zones.length === 0 ? (
          <EmptyState title="Chưa có agent nào trong sổ" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-mission-control>
              <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Agent · nấc tự chủ</th>
                  <th className="px-3 py-2">Lượt · chi phí AI</th>
                  <th className="px-3 py-2">Việc máy mở</th>
                  <th className="px-3 py-2">Người duyệt / bác</th>
                  <th className="px-3 py-2">Kết quả tiền thật</th>
                  <th className="px-3 py-2">Tốt nghiệp</th>
                </tr>
              </thead>
              <tbody>
                {mc.zones.map((z) => (
                  <tr key={z.zone} className="border-t border-hairline align-top text-xs" data-agent-zone={z.zone}>
                    <td className="px-3 py-2">
                      <div className="text-sm font-semibold">
                        {z.home ? (
                          <Link href={z.home} className="hover:underline">
                            {z.name ?? z.label}
                          </Link>
                        ) : (
                          (z.name ?? z.label)
                        )}
                      </div>
                      <div className="text-muted-foreground">
                        {z.label} · {z.autonomyLabel}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {z.usage ? MC_WINDOWS.map((w) => <UsageCellView key={w} u={z.usage![w]} w={w} />) : <span className="text-muted-foreground" title={z.measure.usageNone}>Không dùng mô hình AI</span>}
                    </td>
                    <td className="px-3 py-2">
                      {z.workOpen === null ? <span className="text-muted-foreground">{NOT_MEASURED}</span> : <span className="font-medium">{formatNumber(z.workOpen)}</span>}
                      {z.workOpen !== null ? <span className="text-muted-foreground"> đang mở</span> : null}
                      {z.volume ? (
                        <div className="text-muted-foreground" title={z.measure.volume?.label}>
                          {z.measure.volume?.label}: {formatNumber(z.volume[7].count)} /7n · {formatNumber(z.volume[30].count)} /30n
                          {z.volume[30].unknown ? ` · ${formatNumber(z.volume[30].unknown)} chưa rõ nguồn mở` : ""}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2" title={z.measure.review.kind === "NONE" ? z.measure.review.missing : z.measure.review.definition}>
                      {z.review ? (
                        <>
                          {MC_WINDOWS.map((w) => (
                            <ReviewView key={w} r={z.review![w]} w={w} />
                          ))}
                          {z.measure.review.kind === "BOT_ORDERS" ? <div className="text-muted-foreground">{z.measure.review.missingPart}</div> : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">
                          {NOT_MEASURED}: {z.measure.review.kind === "NONE" ? z.measure.review.missing : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2" title={z.measure.outcome.kind === "NONE" ? z.measure.outcome.missing : z.measure.outcome.definition}>
                      {z.outcome ? (
                        MC_WINDOWS.map((w) => (
                          <div key={w}>
                            {formatNumber(z.outcome![w].delivered)} đơn giao TC · <span className="font-medium">{z.outcome![w].verifiedCash === null ? "—" : formatVND(z.outcome![w].verifiedCash, { compact: true })}</span>
                            <span className="text-muted-foreground"> /{w}n</span>
                          </div>
                        ))
                      ) : (
                        <span className="text-muted-foreground">{NOT_MEASURED}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <VerdictView z={z} />
                      {canEdit ? <GraduationForm zone={z.zone} label={z.name ?? z.label} rule={z.rule} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      <p className="text-xs text-muted-foreground">
        «—» ở tiền = chưa có chứng từ (COD thực thu / chuyển khoản), không phải 0đ. Đổi nấc tự chủ của một agent là quyết định của chủ shop và phải cập nhật sổ department-ai rồi triển khai lại — trang này không có nút đổi nấc.
      </p>
    </div>
  );
}
