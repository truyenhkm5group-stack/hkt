import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ResolvePaymentForm } from "@/components/billing/operator-billing";
import { AiBalanceAdjustForm, AiBalanceToggleForm } from "@/components/platform/ai-balance-forms";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { loadAiBalanceOperatorView } from "@/lib/billing/ai-balance";
import { formatDateTime, formatVND } from "@/lib/format";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

export const metadata = { title: "Số dư AI · vận hành" };

const OUTCOME_LABEL: Record<string, string> = {
  TOPUP_CREDITED_REVIEW: "Đã cộng — cần xem lại (lệch số tiền / phiếu đã huỷ)",
  TOPUP_HELD: "GIỮ LẠI, CHƯA cộng — mã của phiếu đã cộng rồi (khách chuyển lần hai, hoặc cùng một khoản vào sổ hai lần), hoặc tiền vào tài khoản khác tài khoản nhận. Là tiền thật thì cộng tay ở khung «Tặng · điều chỉnh · hoàn tiền» (điều chỉnh tiền thật, ghi mã giao dịch vào lý do).",
  NO_INVOICE: "Mã nạp không thuộc phiếu nào — CHƯA cộng cho ai",
};

const RESOLVE_TOPUP_NOTE =
  "Khoản tiền rời danh sách cần xem lại nhưng KHÔNG bị xoá — dòng và lý do của bạn còn trong nhật ký. Nếu là tiền thật chưa cộng, ghi «điều chỉnh tiền thật» cho đúng tổ chức TRƯỚC khi đánh dấu.";

/**
 * SỐ DƯ AI — MÀN NGƯỜI VẬN HÀNH (docs/saas/AI_BALANCE_V1.md): số dư từng tổ chức tách tiền thật / tiền tặng, nạp 30 ngày,
 * dùng 30 ngày (tách phần tiền thật — doanh thu); khoản tiền nạp cần xem lại; bật / tắt từng tổ chức (canary) và tặng /
 * điều chỉnh / hoàn — mọi lượt bắt buộc lý do, vào sổ và nhật ký nền tảng. Doanh thu · chi phí AI · biên của cùng tổ chức nằm
 * ở khung kinh tế đơn vị /platform/saas (một chỗ tính, không tính lại ở đây).
 */
export default async function PlatformAiBalancePage() {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const v = await loadAiBalanceOperatorView(user);
  if ("error" in v) redirect("/?forbidden=1");
  return (
    <div className="space-y-5">
      <PageHeader
        title="Số dư AI"
        description="Sổ cái chỉ ghi thêm · tiền thật (CASH) tách tiền tặng (PROMO) · nạp qua VietQR mã ERPNAP… khớp tự động."
        actions={
          <Link href="/platform/saas#unit-economics" className="text-sm font-medium text-primary hover:underline" data-link-unit-economics>
            Doanh thu · chi phí · biên →
          </Link>
        }
      />
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
                    <td className="numeric py-2 pr-3 text-right">
                      <div>{formatVND(r.usage30dVnd)}</div>
                      {r.usage30dCashVnd !== r.usage30dVnd ? <div className="text-xs text-muted-foreground">tiền thật {formatVND(r.usage30dCashVnd)}</div> : null}
                    </td>
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
              <li key={r.bankRef} className="flex flex-wrap items-center justify-between gap-2 py-2" data-ai-balance-review={r.bankRef} data-outcome={r.outcome}>
                <span>
                  <span className="font-mono">{r.transferCode}</span> · {r.orgCode ?? "không rõ tổ chức"} · {formatDateTime(r.txnAt)}
                </span>
                <span className="flex items-center gap-3">
                  <span className="numeric font-medium">{formatVND(r.amountVnd)}</span>
                  <ResolvePaymentForm paymentId={r.paymentId} consequence={RESOLVE_TOPUP_NOTE} />
                </span>
                <span className="w-full text-xs text-muted-foreground">{OUTCOME_LABEL[r.outcome] ?? r.outcome}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Không có khoản nào cần xem lại.</p>
        )}
      </SectionCard>
      {v.unconfirmed.length ? (
        <SectionCard
          title="Tiền mang mã nạp mà SePay CHƯA xác nhận"
          description="Dòng gõ tay / sao kê nhập vào sổ ngân hàng nhà — KHÔNG tự cộng (một người ghi sổ không được tự «nạp» cho khách). SePay xác nhận cùng mã bút toán thì lượt đối chiếu sau tự cộng; dòng trùng một khoản đã cộng thì bỏ qua."
        >
          <ul className="divide-y text-sm" data-ai-balance-unconfirmed>
            {v.unconfirmed.map((r) => (
              <li key={r.bankRef} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate">
                  {formatDateTime(r.txnAt)} · {r.source} · <span className="text-muted-foreground">{r.description}</span>
                </span>
                <span className="numeric font-medium">{formatVND(r.amountVnd)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
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
