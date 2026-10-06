import { SectionCard } from "@/components/ui-bits";
import { ApplyForm, CanaryForm, ProbeModelButton, RollbackForm } from "@/components/platform/ai-model-control-forms";
import { CONTROL_STAGE_LABEL, PROBE_FRESH_MS, type ControlStage, type PlatformAiControlView } from "@/lib/ai-usage/platform-ai-admin";
import { MODEL_PROBE_LABEL, type ModelProbeVerdict } from "@/lib/ai-usage/platform-model-probe";
import { formatDateTime, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * PLATFORM AI MODEL CONTROL (06/10/2026 · docs/platform/ai-model-control.md) — model của AI DÙNG CHUNG (khoá nền tảng) cho
 * mọi tổ chức khách. Thay dòng «ĐỀ XUẤT, không tự đổi» bằng một quy trình có cổng: Kiểm tra khả dụng → Chạy thử → Áp dụng →
 * Hoàn tác. Mọi tiền là ƯỚC TÍNH theo bảng giá; «—» = chưa biết, không phải 0.
 */

const VERDICT_TONE: Record<ModelProbeVerdict, string> = {
  AVAILABLE: "font-semibold text-emerald-700 dark:text-emerald-400",
  MODEL_UNAVAILABLE: "font-semibold text-rose-700 dark:text-rose-400",
  KEY_REJECTED: "font-semibold text-rose-700 dark:text-rose-400",
  QUOTA: "text-amber-700 dark:text-amber-400",
  OTHER: "text-amber-700 dark:text-amber-400",
};
const STAGE_ORDER: ControlStage[] = ["NEED_PROBE", "READY", "CANARY", "APPLIED"];

const usd = (v: number | null) => (v === null ? "—" : `${v.toFixed(v < 1 ? 4 : 2)} USD`);
const price = (p: { input: number; output: number } | null) => (p ? `${p.input} / ${p.output} USD` : "—");

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-hairline p-3">
      <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="numeric mt-1 text-base font-semibold">{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export function PlatformAiModelControlSection({ data, usdToVnd, now }: { data: PlatformAiControlView; usdToVnd: number; now: Date }) {
  const { key, policy, candidate, estimate: e } = data;
  const probe = candidate ? data.probes[candidate] : undefined;
  const probeFresh = probe ? now.getTime() - Date.parse(probe.checkedAt) < PROBE_FRESH_MS : false;
  const stable = policy?.enabled ? (policy.fallbackModel ?? key.baseModel) : key.baseModel;
  const canAct = key.ready && candidate !== null && stable !== null;
  const probeOk = probeFresh && probe?.verdict === "AVAILABLE";
  const stageIdx = STAGE_ORDER.indexOf(data.stage);
  const vnd = (v: number | null) => (v === null ? "—" : formatVND(Math.round(v * usdToVnd)));
  return (
    <SectionCard
      id="platform-ai-model"
      title="Platform AI Model Control"
      description={`Model của AI dùng chung (khoá nền tảng, mọi tổ chức khách) · ${data.windowDays} ngày gần nhất · chỉ người vận hành nền tảng đổi được`}
      hint="Chính sách nằm TRÊN biến môi trường PLATFORM_AI_MODEL: không có chính sách / đã hoàn tác ⇒ chạy đúng model của biến môi trường như trước. Chạy thử băm theo hội thoại (một hội thoại không nhảy model). Model mới hỏng ⇒ cùng lượt đi lại bằng model dự phòng; lượt hỏng vẫn ghi một dòng ERROR. Chi phí ước tính = cùng lượng token 30 ngày × giá model đề xuất (ESTIMATED; Flash-Lite 2.5 tắt suy nghĩ ở mức Nhanh nên token ra thực tế thường ít hơn)."
    >
      <div className="space-y-4 text-sm" data-platform-ai-model data-stage={data.stage}>
        {!key.ready ? <p className="text-xs text-amber-700 dark:text-amber-400">{key.reason}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Model hiện tại" value={data.currentModel ?? "—"} sub={policy?.enabled ? `chính sách: ${policy.primaryModel} ở ${policy.canaryPct}% · dự phòng ${policy.fallbackModel ?? key.baseModel ?? "—"}` : `biến môi trường PLATFORM_AI_MODEL${key.provider ? ` · ${key.provider}` : ""}`} />
          <Tile label="Model đề xuất" value={candidate ?? "—"} sub={`giá vào / ra (1M token): ${price(data.prices.current)} → ${price(data.prices.candidate)}`} />
          <Tile label={`Chi phí ${data.windowDays} ngày (đã ghi)`} value={usd(e.currentUsd)} sub={`${vnd(e.currentUsd)}${e.currentComplete ? "" : " · cận dưới (có lượt chưa định giá)"} · ${formatNumber(e.inputTokens)} vào / ${formatNumber(e.outputTokens)} ra`} />
          <Tile label="Nếu đổi (ước tính)" value={usd(e.estimatedUsd)} sub={`${vnd(e.estimatedUsd)} · tiết kiệm ${formatPercent(e.savingsPct, 0)} · /1M token ${e.currentPerMTokUsd === null ? "—" : e.currentPerMTokUsd.toFixed(3)} → ${e.candidatePerMTokUsd === null ? "—" : e.candidatePerMTokUsd.toFixed(3)} USD`} />
        </div>

        <div className="rounded-lg border border-hairline p-3" data-probe-state={probe?.verdict ?? "NONE"}>
          <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Khả dụng với PLATFORM_AI_API_KEY</div>
          {probe ? (
            <div className="mt-1 text-xs">
              <span className={cn(VERDICT_TONE[probe.verdict])}>{MODEL_PROBE_LABEL[probe.verdict]}</span>
              {probe.httpStatus !== null ? ` · HTTP ${probe.httpStatus}` : ""} · {formatDateTime(probe.checkedAt)}
              {probe.checkedBy ? ` · ${probe.checkedBy}` : ""}
              {probeFresh ? "" : " · QUÁ 24 GIỜ — kiểm lại trước khi đổi"}
              {probe.message ? <div className="mt-0.5 text-muted-foreground">{probe.message}</div> : null}
            </div>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">{candidate ? `Chưa kiểm ${candidate} bằng khoá nền tảng.` : "Chưa có model đề xuất."}</div>
          )}
        </div>

        <ol className="grid gap-1 text-xs sm:grid-cols-4" data-workflow>
          {["Kiểm tra khả dụng", "Chạy thử / canary", "Áp dụng", "Hoàn tác (khi cần)"].map((s, i) => (
            <li key={s} className={cn("rounded-md border border-hairline px-2 py-1", i < 3 && stageIdx >= i + 1 ? "border-emerald-600/40 text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>
        <p className={cn("text-xs", data.stage === "PROBE_FAILED" ? "font-semibold text-rose-700 dark:text-rose-400" : "text-muted-foreground")}>{CONTROL_STAGE_LABEL[data.stage]}</p>

        {canAct && candidate && stable ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <ProbeModelButton model={candidate} />
              {stable !== key.baseModel ? <ProbeModelButton model={stable} /> : null}
              <CanaryForm primaryModel={candidate} fallbackModel={stable} disabled={!probeOk || data.stage === "APPLIED"} currentPct={policy?.enabled && policy.primaryModel === candidate ? policy.canaryPct : null} />
            </div>
            <div className="space-y-3">
              <ApplyForm primaryModel={candidate} fallbackModel={stable} disabled={!probeOk || data.stage === "APPLIED"} />
              <RollbackForm disabled={!policy} hint={policy?.previous ? `Trả về bản trước: ${policy.previous.enabled ? `${policy.previous.primaryModel} ở ${policy.previous.canaryPct}%` : "chính sách tắt"}. Áp ngay, không cần deploy.` : "Tắt chính sách — AI dùng chung chạy lại model của biến môi trường (PLATFORM_AI_MODEL). Áp ngay, không cần deploy."} />
            </div>
          </div>
        ) : null}

        {data.usage.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-platform-ai-usage>
              <thead className="text-left text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2">Model (sổ AI · nguồn PLATFORM)</th>
                  <th className="py-1 pr-2 text-right">Lượt</th>
                  <th className="py-1 pr-2 text-right">Lỗi</th>
                  <th className="py-1 pr-2 text-right">Token vào / ra</th>
                  <th className="py-1 text-right">Chi phí đã ghi</th>
                </tr>
              </thead>
              <tbody>
                {data.usage.map((u) => (
                  <tr key={u.model ?? "∅"} className="border-t border-hairline">
                    <td className="py-1 pr-2 font-mono">{u.model ?? "(không rõ)"}</td>
                    <td className="numeric py-1 pr-2 text-right">{formatNumber(u.requests)}</td>
                    <td className={cn("numeric py-1 pr-2 text-right", u.requests > 0 && u.errors / u.requests > 0.05 && "text-rose-700 dark:text-rose-400")}>{u.requests ? `${formatNumber(u.errors)} · ${formatPercent((u.errors / u.requests) * 100, 1)}` : "—"}</td>
                    <td className="numeric py-1 pr-2 text-right">
                      {formatNumber(u.inputTokens)} / {formatNumber(u.outputTokens)}
                    </td>
                    <td className="numeric py-1 text-right">
                      {usd(u.costUsd)}
                      {u.unpricedRequests ? ` +${formatNumber(u.unpricedRequests)} chưa định giá` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Chưa có lượt AI dùng chung nào trong {data.windowDays} ngày.</p>
        )}

        {data.audit.length ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Nhật ký đổi model ({data.audit.length} gần nhất)</summary>
            <ul className="mt-1 space-y-0.5">
              {data.audit.map((r, i) => (
                <li key={`${r.at}-${i}`}>
                  {formatDateTime(r.at)} · <span className="font-mono">{r.action}</span> · {r.actorEmail ?? "máy"}
                  {r.reason ? ` · «${r.reason}»` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </SectionCard>
  );
}
