import {
  DELIVERY_LEVEL_LABEL,
  DELIVERY_LEVEL_SHORT,
  MISSION_CONTROL_LABEL,
  MISSION_CONTROL_TONE,
  REGISTRY_LIVENESS_LABEL,
  REGISTRY_RISK_LABEL,
  REGISTRY_RISK_TONE,
  type DeliveryLevel,
  type MissionControlState,
  type RegistryLiveness,
  type RegistryRisk,
} from "@/lib/constants/tech-registry";
import { cn } from "@/lib/utils";

/**
 * Nhãn của Mission Control. KHÔNG `"use client"`: chỉ đọc hằng số, nên cả Server Component lẫn cột bảng (client)
 * import được — qua ranh giới chỉ mang COMPONENT, không mang hằng số (`tests/client-boundary-exports.test.ts`).
 */
const base = "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

export function MissionControlBadge({ state, className }: { state: MissionControlState; className?: string }) {
  return <span className={cn(base, MISSION_CONTROL_TONE[state], className)}>{MISSION_CONTROL_LABEL[state]}</span>;
}

export function RegistryRiskBadge({ risk, className }: { risk: string; className?: string }) {
  const r = risk as RegistryRisk;
  if (!REGISTRY_RISK_LABEL[r]) return null;
  return <span className={cn(base, REGISTRY_RISK_TONE[r], className)}>{REGISTRY_RISK_LABEL[r]}</span>;
}

export function LivenessBadge({ liveness, className }: { liveness: RegistryLiveness | null; className?: string }) {
  if (!liveness || liveness === "FRESH") return null;
  const tone = liveness === "STALE" ? "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";
  return <span className={cn(base, tone, className)}>{REGISTRY_LIVENESS_LABEL[liveness]}</span>;
}

const DELIVERY_TONE: Record<DeliveryLevel, string> = {
  NONE: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  CODE_DONE: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  DEPLOYED: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  PRODUCT_VERIFIED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
};

export function DeliveryBadge({ level, short, className }: { level: DeliveryLevel; short?: boolean; className?: string }) {
  return (
    <span className={cn(base, DELIVERY_TONE[level], className)} title={DELIVERY_LEVEL_LABEL[level]}>
      {short ? DELIVERY_LEVEL_SHORT[level] : DELIVERY_LEVEL_LABEL[level]}
    </span>
  );
}
