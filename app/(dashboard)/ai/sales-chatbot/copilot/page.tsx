import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatPercent } from "@/lib/format";
import { loadCopilotView } from "@/lib/sales-chatbot/operating-mode";
import { COPILOT_NO_REPLY_HOURS, COPILOT_SIMILARITY, COPILOT_VERDICT_LABEL, COPILOT_VERDICTS, OPERATING_MODE_LABEL } from "@/lib/sales-chatbot/operating-mode-shared";

export const metadata = { title: "Gợi ý Copilot" };

const pct = (r: number | null | undefined) => formatPercent(r === null || r === undefined ? null : r * 100, 0);

/**
 * GỢI Ý COPILOT & THỬ NGHIỆM — 30 ngày gần nhất. Câu bot soạn (không gửi) cạnh câu thật của page, độ giống và phán quyết;
 * số hội thoại mỗi nhánh của thử nghiệm đang chạy. Kết quả bán hàng theo nhánh (đơn, giao, doanh thu) đọc ở màn «Hiệu quả».
 */
export default async function CopilotPage() {
  const user = await requirePermission("ai_sales:view");
  const r = await loadCopilotView(user);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="AI"
        title="Gợi ý Copilot & thử nghiệm"
        description={"ok" in r ? `Chế độ hiện tại: ${OPERATING_MODE_LABEL[r.config.mode]}` : undefined}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Ở chế độ Copilot, bot soạn câu cho từng lượt tin khách ở hội thoại BÓNG (không gửi). Câu thật đầu tiên của page tới SAU gợi ý được đem so: độ giống ≥ {COPILOT_SIMILARITY.same} = gửi gần như nguyên văn; ≥ {COPILOT_SIMILARITY.edited} = sửa rồi gửi; thấp hơn = khác hẳn; không có câu nào trong {COPILOT_NO_REPLY_HOURS} giờ = không ai trả lời.</p>
            <p>Lưu ý: câu trả lời tự động của Meta cũng là «tin page» — nó được đem so như câu người. Trung vị độ giống in cạnh để không phải tin nhãn.</p>
          </div>
        }
        actions={
          <Link href="/ai/sales-chatbot" className="text-sm font-medium text-primary hover:underline">
            ← Chatbot bán hàng
          </Link>
        }
      />
      {"error" in r ? (
        <p className="text-sm text-destructive">{r.error}</p>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard title="Copilot — 30 ngày" description={`${r.stats.suggestions} gợi ý · đã chấm ${r.stats.scored} · AI hỏng ${r.stats.failed}`}>
              <table className="w-full text-sm" data-testid="copilot-stats">
                <tbody>
                  {COPILOT_VERDICTS.map((v) => (
                    <tr key={v} className="border-t border-hairline">
                      <td className="py-1">{COPILOT_VERDICT_LABEL[v]}</td>
                      <td className="numeric py-1 text-right">{r.stats.byVerdict[v]}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-hairline font-semibold">
                    <td className="py-1">Trung vị độ giống</td>
                    <td className="numeric py-1 text-right">{pct(r.stats.medianSimilarity)}</td>
                  </tr>
                </tbody>
              </table>
            </SectionCard>
            <SectionCard title="Thử nghiệm AI vs Người" description={r.arms ? `Khoá thử nghiệm ${r.arms.key}` : "Chưa chạy thử nghiệm"}>
              {r.arms ? (
                <p className="text-sm" data-testid="experiment-arms">
                  Nhánh AI: <b className="numeric">{r.arms.ai}</b> hội thoại · Nhánh người: <b className="numeric">{r.arms.human}</b> hội thoại · tỷ lệ cấu hình {r.config.aiSharePct}% AI.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Chọn «Thử nghiệm AI vs Người» ở trang Chatbot bán hàng để chia hội thoại mới.</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">Nhánh được ghim vào hội thoại ở lượt đầu — đổi tỷ lệ giữa chừng không chuyển hội thoại đang chạy. Đơn / giao / doanh thu theo nhánh: màn «Hiệu quả».</p>
            </SectionCard>
          </div>
          <SectionCard title="Gợi ý gần đây" padded={false}>
            {r.rows.length === 0 ? (
              <EmptyState title="Chưa có gợi ý nào" description="Bật chế độ Copilot ở trang Chatbot bán hàng — gợi ý xuất hiện khi khách nhắn fanpage." className="m-4" />
            ) : (
              <div className="divide-y divide-hairline" data-testid="copilot-rows">
                {r.rows.map((x) => (
                  <div key={x.id} className="grid gap-2 p-3 text-sm md:grid-cols-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Khách · {formatDateTime(x.createdAt)}</div>
                      <p className="whitespace-pre-wrap">{x.customerText}</p>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Gợi ý của bot</div>
                      <p className="whitespace-pre-wrap">{x.suggestion ?? x.error ?? "—"}</p>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Câu thật{x.verdict ? ` · ${COPILOT_VERDICT_LABEL[x.verdict]}` : " · chưa chấm"}
                        {x.similarity !== null ? ` · giống ${pct(x.similarity)}` : ""}
                      </div>
                      <p className="whitespace-pre-wrap text-muted-foreground">{x.humanReply ?? "—"}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
