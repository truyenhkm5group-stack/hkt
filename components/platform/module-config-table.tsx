"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toggleFeatureAction, toggleModuleAction, toggleModuleForOrgAction } from "@/lib/actions/platform-modules";
import type { ModuleState, ModuleViewGroup, ModuleViewRow } from "@/lib/queries/platform-modules";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BẢNG CẤU HÌNH MODULE — DÙNG CHUNG CHO HAI MÀN HÌNH ═══════════
 *
 *  · `/settings/modules` — quản trị bật/tắt module + tính năng của CHÍNH tổ chức mình.
 *  · `/platform?org=…` — người vận hành nền tảng đổi module của một tổ chức khác (bắt buộc lý do;
 *    tính năng chỉ xem — việc chỉnh chi tiết thuộc về quản trị của tổ chức đó).
 *
 * Bấm công tắc ⇒ server action ⇒ `revalidatePath` dựng lại trang với dữ liệu mới. KHÔNG
 * `router.refresh()` thêm (dựng hai lần). Bị chặn (thiếu phụ thuộc, đang có module phụ thuộc, lõi,
 * chỉ tổ chức nhà) ⇒ toast nguyên văn câu giải thích của sổ module; không có gì được bật dây chuyền.
 */

const STATE_LABEL: Record<ModuleState, string> = {
  CORE: "Lõi — luôn bật",
  ON: "Đang bật",
  OFF: "Đang tắt",
  HOME_ONLY: "Chỉ tổ chức nhà",
};

const STATE_TONE: Record<ModuleState, string> = {
  CORE: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  ON: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  OFF: "bg-muted text-muted-foreground",
  HOME_ONLY: "border border-dashed border-border text-muted-foreground",
};

const STATE_HINT: Record<ModuleState, string> = {
  CORE: "Module lõi không tắt được — tắt nó là khoá người quản trị khỏi chính màn hình bật lại nó.",
  ON: "Màn hình, quyền và job của module đang mở cho mọi người trong tổ chức (vẫn theo quyền từng người).",
  OFF: "Menu ẩn, trang chuyển tới «Module chưa bật», quyền của module không có hiệu lực — kể cả với quản trị.",
  HOME_ONLY: "Module dùng thông tin kết nối (biến môi trường) của tổ chức nhà. Ở giai đoạn này tổ chức khác chưa bật được.",
};

type Target = { kind: "own" } | { kind: "org"; orgCode: string; orgName: string };

function Chips({ items, empty }: { items: { key: string; label: string; enabled: boolean }[]; empty: string }) {
  if (items.length === 0) return <span className="text-xs text-muted-foreground">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((d) => (
        <span key={d.key} title={d.enabled ? "Đang bật" : "Đang tắt"} className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px]", d.enabled ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200" : "bg-muted text-muted-foreground")}>
          <span className={cn("size-1.5 rounded-full", d.enabled ? "bg-emerald-500" : "bg-muted-foreground/50")} aria-hidden />
          {d.label}
        </span>
      ))}
    </div>
  );
}

function ModuleRowView({ row, target, reason, pendingKey, run }: { row: ModuleViewRow; target: Target; reason: string; pendingKey: string | null; run: (key: string, fn: () => Promise<{ ok: true; changed: boolean } | { error: string }>, success: string) => void }) {
  const locked = row.state === "CORE" || row.state === "HOME_ONLY";
  const toggleModule = (enabled: boolean) =>
    run(
      row.key,
      () => (target.kind === "own" ? toggleModuleAction({ moduleKey: row.key, enabled }) : toggleModuleForOrgAction({ orgCode: target.orgCode, moduleKey: row.key, enabled, reason })),
      `${enabled ? "Đã bật" : "Đã tắt"} «${row.label}»${target.kind === "org" ? ` cho ${target.orgName}` : ""}`,
    );
  return (
    <tr className="border-b border-hairline align-top last:border-b-0">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[13.5px] font-semibold">{row.label}</span>
          <InfoHint label={`Vì sao có module «${row.label}»`}>
            <p className="text-xs leading-5">{row.why}</p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{row.key}</p>
          </InfoHint>
        </div>
        <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{row.description}</p>
        {row.dependencyError ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">⚠ {row.dependencyError}</p> : null}
      </td>
      <td className="px-3 py-2.5">
        <span title={STATE_HINT[row.state]} className={cn("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium", STATE_TONE[row.state])}>
          {STATE_LABEL[row.state]}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <Chips items={row.dependsOn} empty="Không cần gì" />
      </td>
      <td className="px-3 py-2.5">
        <Chips items={row.dependents} empty="Không module nào" />
      </td>
      <td className="px-3 py-2.5">
        {row.features.length === 0 ? (
          <span className="text-xs text-muted-foreground">Không có tính năng riêng</span>
        ) : (
          <ul className="space-y-1">
            {row.features.map((f) => (
              <li key={f.key} className="flex items-center gap-2">
                <Switch
                  size="sm"
                  checked={f.enabled}
                  disabled={target.kind === "org" || !row.enabled || pendingKey !== null}
                  aria-label={`${f.enabled ? "Tắt" : "Bật"} tính năng ${f.label}`}
                  onCheckedChange={(enabled) => run(f.key, () => toggleFeatureAction({ featureKey: f.key, enabled }), `${enabled ? "Đã bật" : "Đã tắt"} tính năng «${f.label}»`)}
                />
                <span className={cn("text-xs", !row.enabled && "text-muted-foreground")} title={f.why}>
                  {f.label}
                  {f.overridden ? null : <span className="text-muted-foreground"> · mặc định</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2.5 text-right">
        <Switch checked={row.enabled} disabled={locked || pendingKey !== null} aria-label={`${row.enabled ? "Tắt" : "Bật"} module ${row.label}`} title={locked ? STATE_HINT[row.state] : undefined} onCheckedChange={toggleModule} />
      </td>
    </tr>
  );
}

export function ModuleConfigTable({ groups, target }: { groups: ModuleViewGroup[]; target: Target }) {
  const [pending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const run = (key: string, fn: () => Promise<{ ok: true; changed: boolean } | { error: string }>, success: string) => {
    if (target.kind === "org" && reason.trim().length < 5) {
      toast.error("Ghi lý do (ít nhất 5 ký tự) trước khi đổi module của tổ chức khác — người của tổ chức đó sẽ đọc nó trong nhật ký.");
      return;
    }
    setPendingKey(key);
    startTransition(async () => {
      try {
        const result = await fn();
        if ("error" in result) toast.error(result.error);
        else toast.success(result.changed ? success : "Không có gì thay đổi");
      } catch {
        toast.error("Không lưu được — thử lại.");
      } finally {
        setPendingKey(null);
      }
    });
  };

  return (
    <div className="space-y-3">
      {target.kind === "org" ? (
        <label className="flex max-w-xl items-center gap-2 text-sm">
          <span className="shrink-0 font-medium">Lý do thay đổi</span>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Bắt buộc — ghi vào nhật ký của cả hai tổ chức" className="h-8" maxLength={500} />
        </label>
      ) : null}
      <div className={cn("overflow-x-auto rounded-xl border", pending && "opacity-70")}>
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-[30%] px-3 py-2">Module</th>
              <th className="px-3 py-2">Trạng thái</th>
              <th className="px-3 py-2">Cần bật trước</th>
              <th className="px-3 py-2">Module dựa vào nó</th>
              <th className="px-3 py-2">Tính năng</th>
              <th className="px-3 py-2 text-right">Bật</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.category}>
              <tr className="border-y border-hairline bg-surface-sunken/60">
                <th colSpan={6} className="px-3 py-1.5 text-left text-[11.5px] font-semibold text-muted-foreground">
                  {g.label} · {g.rows.filter((r) => r.enabled).length}/{g.rows.length} đang bật
                </th>
              </tr>
              {g.rows.map((row) => (
                <ModuleRowView key={row.key} row={row} target={target} reason={reason} pendingKey={pendingKey} run={run} />
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
