import Link from "next/link";
import { listAiProviderIncidents, PROVIDER_BALANCE_UNREADABLE, type AiProviderIncident } from "@/lib/ai-usage/credit-incidents";
import { formatDateTime } from "@/lib/format";

const REASON_LABEL: Record<string, string> = { CREDIT: "hết tiền nhà cung cấp AI", AUTH: "khoá AI bị từ chối" };
const FIX: Record<string, string> = {
  CREDIT: "Chủ shop nạp tài khoản trả trước của nhà cung cấp (Google AI Studio). Không chạy bench / probe tới khi nạp xong.",
  AUTH: "Kiểm khoá AI (hết hạn / bị thu hồi) ở cấu hình nhà cung cấp.",
};

/**
 * BANNER SỰ CỐ AI «CẦN NGƯỜI» (P0 cạn credit, 24/10/2026) — đọc ĐÚNG gương `platform_org_health` (job `sales-health`), không câu đếm
 * mới. Hồi phục ⇒ job ghi lại dòng AI ⇒ banner tự mất. `orgCode` ⇒ chỉ tổ chức đó (trang /platform/org/<mã>).
 */
export async function AiProviderIncidentBanner({ orgCode }: { orgCode?: string }) {
  let incidents: AiProviderIncident[];
  try {
    incidents = await listAiProviderIncidents();
  } catch {
    return <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">Không đọc được gương sức khoẻ AI — chưa biết có tổ chức nào đang hết tiền nhà cung cấp hay không.</p>;
  }
  const shown = orgCode ? incidents.filter((i) => i.orgCode === orgCode) : incidents;
  if (!shown.length) return null;
  return (
    <div role="alert" className="space-y-1 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100" data-ai-provider-incident>
      {shown.map((i) => (
        <p key={i.orgCode}>
          🔴 AI bán hàng{" "}
          {orgCode ? (
            <strong>{i.orgCode}</strong>
          ) : (
            <Link className="font-semibold underline" href={`/platform/org/${i.orgCode}`}>
              {i.orgCode}
            </Link>
          )}{" "}
          — {REASON_LABEL[i.reason] ?? i.reason} từ {formatDateTime(i.since)}
          {i.measuredAt ? ` (đo lần cuối ${formatDateTime(i.measuredAt)})` : ""}. {FIX[i.reason] ?? ""}
        </p>
      ))}
      <p className="text-xs opacity-80">{PROVIDER_BALANCE_UNREADABLE}</p>
    </div>
  );
}
