import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { AiBalanceAdjustForm, AiBalanceToggleForm } from "@/components/platform/ai-balance-forms";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { loadAiBalanceOperatorView } from "@/lib/billing/ai-balance";
import { formatDateTime, formatVND } from "@/lib/format";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

export const metadata = { title: "Số dư AI · vận hành" };

const OUTCOME_LABEL: Record<string, string> = {
  TOPUP_CREDITED_REVIEW: "Đã cộng — cần xem lại (lệch số tiền / phiếu đã trả / đã huỷ)",
  NO_INVOICE: "Mã nạp không thuộc phiếu nào — CHƯA cộng cho ai",
};

/**
 * SỐ DƯ AI — MÀN NGƯỜI VẬN HÀNH (docs/saas/AI_BALANCE_V1.md): số dư từng tổ chức tách tiền thật / tiền tặng, nạp 30 ngày,
 * dùng 30 ngày; khoản tiền nạp cần xem lại; bật / tắt từng tổ chức (canary) và tặng / điều chỉnh / hoàn — mọi lượt bắt
 * buộc lý do, vào sổ và nhật ký nền tảng.
 */
export default async function PlatformAiBalancePage() {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const v = await loadAiBalanceOperatorView(user);
  if ("error" in v) redirect("/?forbidden=1");
  return (
    <div className="space-y-5">
      <PageHeader title="Số dư AI" description="Sổ cái chỉ ghi thêm · tiền thật (CASH) tách tiền tặng (PROMO) · nạp qua VietQR mã ERPNAP… khớp tự động." />
      {!v.receiverReady ? (
        <p className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          Chưa khai tài khoản nhận tiền (khung «Thu phí thuê bao» ở /platform) — khách chưa tạo được mã nạp. Đây là bước bắt buộc trước khi bật cho khách thật.
        </p>
      ) : null}
      <SectionCard title="Số dư theo tổ chức" description="Chỉ hiện tổ chức đã bật hoặc đã có dòng sổ.">
        {v.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Tổ chức</th>
                  <th className="py-2 pr-3">Bật</th>
                  <th className="py-2 pr-3 text-right">Tiền thật</th>
                  <th className="py-2 pr-3 text-right">Tiền tặng</th>
                  <th className="py-2 pr-3 text-right">Tổng</th>
                  <th className="py-2 pr-3 text-right">Nạp 30 ngày</th>
                  <th className="py-2 pr-3 text-right">Dùng 30 ngày</th>
                  <th className="py-2">Nạp gần nhất</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {v.rows.map((r) => (
                  <tr key={r.orgCode} data-ai-balance-org={r.orgCode}>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{r.orgName}</span> <span className="text-xs text-muted-foreground">{r.orgCode}</span>
                    </td>
                    <td className="py-2 pr-3">{r.enabled ? "Bật" : "Tắt"}</td>
                    <td className="numeric py-2 pr-3 text-right">{formatVND(r.cashVnd)}</td>
                    <td className="numeric py-2 pr-3 text-right">{formatVND(r.promoVnd)}</td>
                    <td className="numeric py-2 pr-3 text-right font-semibold">{formatVND(r.totalVnd)}</td>
                    <td className="numeric py-2 pr-3 text-right">{formatVND(r.topup30dVnd)}</td>
                    <td className="numeric py-2 pr-3 text-right">{formatVND(r.usage30dVnd)}</td>
                    <td className="py-2 text-xs">{r.lastTopupAt ? formatDateTime(r.lastTopupAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Chưa tổ chức nào bật Số dư AI" description="Bật cho một workspace thử trước (canary) ở khung bên dưới." />
        )}
      </SectionCard>
      <SectionCard title="Tiền nạp cần xem lại" description="Tiền KHÔNG bao giờ biến mất: khoản lệch vẫn được cộng nguyên số thật; khoản mang mã lạ nằm đây cho tới khi xử lý.">
        {v.review.length ? (
          <ul className="divide-y text-sm">
            {v.review.map((r) => (
              <li key={r.bankRef} className="flex flex-wrap items-center justify-between gap-2 py-2" data-ai-balance-review={r.bankRef}>
                <span>
                  <span className="font-mono">{r.transferCode}</span> · {r.orgCode ?? "không rõ tổ chức"} · {formatDateTime(r.txnAt)}
                </span>
                <span className="numeric font-medium">{formatVND(r.amountVnd)}</span>
                <span className="w-full text-xs text-muted-foreground">{OUTCOME_LABEL[r.outcome] ?? r.outcome}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Không có khoản nào cần xem lại.</p>
        )}
      </SectionCard>
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Bật / tắt cho một tổ chức" description="Tắt lại không đụng tiền đã nạp — chỉ ẩn màn khách và chặn tạo mã nạp mới.">
          <AiBalanceToggleForm />
        </SectionCard>
        <SectionCard title="Tặng · điều chỉnh · hoàn tiền" description="Một lượt = một dòng sổ, bắt buộc lý do. Hoàn tiền không vượt số tiền thật đang có.">
          <AiBalanceAdjustForm />
        </SectionCard>
      </div>
    </div>
  );
}
