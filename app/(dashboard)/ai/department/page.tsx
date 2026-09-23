import Link from "next/link";
import { AlertTriangle, Coins, GaugeCircle, Lock, TrendingDown } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { AGENT_MODE_LABEL } from "@/lib/constants/ai";
import { DEPARTMENT_LABEL } from "@/lib/constants/departments";
import { FUNNEL_AUTONOMY_LABEL } from "@/lib/constants/sales-ai-funnel";
import { AUTONOMY_GATES, DEMOTION_REASON_LABEL, type DemotionReason } from "@/lib/constants/sales-autonomy";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber, formatVND } from "@/lib/format";
import { salesDepartmentReport } from "@/lib/queries/sales-economics";

export const metadata = { title: "Phòng Sales AI" };

/** Tỷ lệ đọc ra chữ. `null` là CHƯA BIẾT ⇒ gạch ngang, không bao giờ 0% (luật 42). */
function pctText(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

export default async function SalesDepartmentPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await requirePermission("ai:view");
  const sp = await searchParams;
  const days = Math.min(Math.max(Number(sp.days) || 30, 1), 365);
  const { funnel, economics, autonomy } = await salesDepartmentReport(days);

  const biPhanh = autonomy.verdict.demotedBy.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Nhân sự AI"
        title="Phòng Sales AI"
        description={`${days} ngày gần nhất · ${formatNumber(funnel.conversations)} hội thoại`}
        actions={
          <Link href="/ai" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted">
            Lượt chạy chi tiết
          </Link>
        }
        hint={
          <>
            <p className="font-semibold">Trang này trả lời bốn câu, và cố ý không gộp chúng</p>
            <p>
              <b>Hiệu suất</b> — phễu đi được tới bậc nào. <b>Hiệu quả</b> — câu máy soạn có dùng được không. <b>Chi phí</b> — tiền mô hình, và tiền để
              chốt một đơn. <b>Tự chủ</b> — máy đang được phép làm gì.
            </p>
            <p className="mt-2">
              Gộp bốn câu thành một điểm tổng thì một cổng đỏ sẽ bị ba cổng xanh che mất, đúng lúc cái đỏ mới là cái đáng đọc.
            </p>
          </>
        }
      />

      {/* ───── TỰ CHỦ: cái phanh phải đứng trên cùng, vì nó quyết định mọi thứ bên dưới có tới tay khách không ───── */}
      <Card className={`p-4 ${biPhanh ? "border-amber-500/50 bg-amber-500/5" : ""}`}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="text-xs text-muted-foreground">Nấc đang khai</div>
            <div className="text-lg font-semibold">{AGENT_MODE_LABEL[autonomy.declared]}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Nấc CÓ HIỆU LỰC</div>
            <div className={`text-lg font-semibold ${biPhanh ? "text-amber-600 dark:text-amber-400" : ""}`}>
              {AGENT_MODE_LABEL[autonomy.verdict.effective]}
            </div>
          </div>
          {biPhanh && (
            <div className="flex items-start gap-2 text-sm">
              <TrendingDown className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <div className="font-medium">Máy đã TỰ hạ bậc</div>
                <ul className="text-muted-foreground">
                  {autonomy.verdict.demotedBy.map((r: DemotionReason) => (
                    <li key={r}>· {DEMOTION_REASON_LABEL[r]}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        {autonomy.verdict.nextRung && (
          <div className="mt-3 border-t border-border pt-3 text-sm">
            <span className="font-medium">Để lên {AGENT_MODE_LABEL[autonomy.verdict.nextRung]}:</span>{" "}
            {autonomy.verdict.blocking.length === 0 ? (
              <span className="text-emerald-600 dark:text-emerald-400">mọi cổng đã xanh — chờ người bấm. Máy không tự lên bậc.</span>
            ) : (
              <ul className="mt-1 text-muted-foreground">
                {autonomy.verdict.blocking.map((b) => (
                  <li key={b}>· {b}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      {/* ───── CHI PHÍ ───── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Chi phí mỗi đơn chốt"
          value={formatVND(economics.costPerOrder)}
          note={economics.costPerOrderUnknownBecause || `${formatNumber(economics.draftOrders)} đơn nháp`}
          icon={Coins}
          tone={economics.costPerOrder === null ? "slate" : "primary"}
          hint={
            <p>
              Tổng tiền mô hình chia cho số đơn nháp máy tạo. Gạch ngang nghĩa là CHƯA BIẾT — và có đúng hai lý do: chưa có đơn nào (mẫu số rỗng), hoặc
              có lượt gọi mô hình chưa khai đơn giá (tử số mù). Hai lý do dẫn tới hai việc khác nhau, nên chúng không được gộp.
            </p>
          }
        />
        <MetricCard
          label="Chi phí mỗi hội thoại"
          value={formatVND(economics.costPerConversation)}
          note={`${formatNumber(economics.conversations)} hội thoại`}
          icon={Coins}
          tone="slate"
        />
        {/*
          TỶ LỆ CHỐT LÀ NỀN SO SÁNH, KHÔNG PHẢI THÀNH TÍCH CỦA AI.

          Nối bằng `orders.conversation_id` của Pancake — khoá thật, không phải quy kết theo SĐT.
          Nhưng hội thoại CÓ đơn không có nghĩa hội thoại ấy TẠO RA đơn, và càng không phải công
          của nhân sự AI khi nó chưa gửi một tin nào. Nhãn phải nói ra điều đó ngay trên thẻ.
        */}
        <MetricCard
          label="Tỷ lệ hội thoại có đơn"
          value={pctText(economics.conversionRate)}
          note={
            economics.ordersAfterAiReply > 0
              ? `${formatNumber(economics.conversationsWithOrder)} hội thoại · ${formatNumber(economics.ordersAfterAiReply)} sau khi AI gửi`
              : `${formatNumber(economics.conversationsWithOrder)} hội thoại — NỀN của bên đang trả lời khách, AI chưa gửi tin nào`
          }
          icon={GaugeCircle}
          tone="slate"
          hint={
            <p>
              Nối hội thoại với đơn bằng mã hội thoại Pancake mang sẵn trên đơn — khoá thật, không phải quy kết theo số điện thoại (một khách
              nhắn ba lần rồi đặt một đơn sẽ đếm thành ba). Đây là <b>liên đới</b>, không phải nhân quả: hội thoại có đơn không có nghĩa hội
              thoại ấy tạo ra đơn. Khi nhân sự AI chưa gửi tin nào thì con số này là <b>nền so sánh</b> — thứ bên đang trả lời khách đạt được.
            </p>
          }
        />
        <MetricCard
          label="Tiền mô hình đã tiêu"
          value={economics.unpricedCalls > 0 ? "—" : formatVND(economics.spendVnd)}
          note={
            economics.unpricedCalls > 0
              ? `${formatNumber(economics.unpricedCalls)}/${formatNumber(economics.modelCalls)} lượt chưa khai đơn giá`
              : `${formatNumber(economics.modelCalls)} lượt gọi`
          }
          icon={Coins}
          tone={economics.unpricedCalls > 0 ? "amber" : "slate"}
        />
        <MetricCard
          label="Token vào / ra"
          value={`${formatNumber(economics.inputTokens)} / ${formatNumber(economics.outputTokens)}`}
          note={`${formatNumber(economics.suggestions)} câu gợi ý`}
          icon={GaugeCircle}
          tone="slate"
        />
      </div>

      {/* ───── VIỆC PHẢI LÀM — đứng TRƯỚC bảng phễu, vì bảng là bằng chứng còn đây mới là việc ───── */}
      {funnel.worstLeak && (
        <Card className="border-amber-500/50 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-sm">
              <div className="font-semibold">
                {formatNumber(funnel.worstLeak.resting)} hội thoại đang nằm lại ở bậc {funnel.worstLeak.order} · {funnel.worstLeak.label}
              </div>
              <p className="mt-1 text-muted-foreground">{funnel.worstLeak.blockedBy}</p>
              <p className="mt-1">
                Phòng chịu trách nhiệm: <b>{DEPARTMENT_LABEL[funnel.worstLeak.owner]}</b>. AI không tự đi tiếp được — số này sẽ không tự giảm.
              </p>
              {/*
                Thẻ nêu việc mà không dẫn tới chỗ làm việc ấy thì người đọc phải tự đi tìm, và
                phần lớn sẽ không tìm. Chỉ dẫn khi bậc rò ĐÚNG là bậc chọn size — gắn một liên
                kết cố định vào mọi bậc là hứa sai ở những bậc nó không sửa được gì.
              */}
              {funnel.worstLeak.stage === "SIZE_SELECTION" && (
                <Link href="/ai/size-rules" className="mt-2 inline-flex items-center gap-1 font-medium text-primary hover:underline">
                  Gán bảng số đo cho mã hàng →
                </Link>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* ───── PHỄU ───── */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-semibold">Phễu bán hàng — đi được tới bậc {funnel.deepestReached}/{funnel.rows.length}</h2>
          <p className="text-sm text-muted-foreground">
            &ldquo;Đã tới&rdquo; gồm cả hội thoại nay đã đi xa hơn, nên cột này không bao giờ phình ra ở giữa.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Bậc</th>
                <th className="px-4 py-2 text-right">Đã tới</th>
                <th className="px-4 py-2 text-right">Đang nằm</th>
                <th className="px-4 py-2 text-right">Đi tiếp</th>
                <th className="px-4 py-2">AI tự đi được?</th>
              </tr>
            </thead>
            <tbody>
              {funnel.rows.map((r) => (
                <tr key={r.stage} className="border-t border-border">
                  <td className="px-4 py-2">
                    <span className="text-muted-foreground">{r.order}.</span> {r.label}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatNumber(r.reached)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.resting ? formatNumber(r.resting) : "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{pctText(r.passRate)}</td>
                  <td className="px-4 py-2">
                    <span className={r.autonomy === "AI_ALONE" ? "text-muted-foreground" : "font-medium text-amber-600 dark:text-amber-400"}>
                      {FUNNEL_AUTONOMY_LABEL[r.autonomy]}
                    </span>
                  </td>
                </tr>
              ))}
              {/* Trần cứng của nhà cung cấp — cố ý nằm NGOÀI thân bảng, sau một đường kẻ đậm. */}
              <tr className="border-t-2 border-border bg-muted/30">
                <td className="px-4 py-2 text-muted-foreground">
                  <Lock className="mr-1 inline size-3.5" />
                  {funnel.beyondReach.label}
                </td>
                <td className="px-4 py-2 text-right text-muted-foreground">N/A</td>
                <td className="px-4 py-2 text-right text-muted-foreground">N/A</td>
                <td className="px-4 py-2 text-right text-muted-foreground">N/A</td>
                <td className="px-4 py-2 font-medium">Bắt buộc có người</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{funnel.beyondReach.blockedBy}</p>
      </Card>

      {/* ───── NHÁNH RẼ ───── */}
      {funnel.branches.length > 0 && (
        <Card className="p-4">
          <h2 className="font-semibold">Ngoài phễu</h2>
          <p className="mb-2 text-sm text-muted-foreground">
            Hội thoại người đã cầm, khách đã từ chối, hoặc đang hẹn lại. Chúng KHÔNG nằm trên phễu: một hội thoại bị người cầm ở bậc 2 và một hội thoại
            bị cầm ở bậc 9 mang cùng một trạng thái, nên đếm chúng như một bậc tiến bộ là bịa ra một tiến độ chưa từng xảy ra.
          </p>
          <div className="flex flex-wrap gap-4 text-sm">
            {funnel.branches.map((b) => (
              <span key={b.stage}>
                <b className="tabular-nums">{formatNumber(b.n)}</b> <span className="text-muted-foreground">{b.stage}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* ───── SÁU CỔNG ───── */}
      <Card className="p-4">
        <h2 className="font-semibold">Sáu cổng trao quyền</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Mỗi cổng hỏi một câu khác nhau và không cổng nào thay được cổng khác — đó là lý do chúng không gộp thành một điểm tổng.
        </p>
        <dl className="grid gap-3 sm:grid-cols-2">
          {AUTONOMY_GATES.map((g) => (
            <div key={g.key}>
              <dt className="text-sm font-medium">{g.label}</dt>
              <dd className="text-sm text-muted-foreground">{g.asks}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 grid gap-x-6 gap-y-1 border-t border-border pt-3 text-sm sm:grid-cols-2">
          <div>Lượt trong kỳ: <b className="tabular-nums">{formatNumber(autonomy.reading.sample)}</b></div>
          <div>Người đã chấm tay: <b className="tabular-nums">{formatNumber(autonomy.reading.humanGraded)}</b></div>
          <div>
            Lượt bị chấm là bịa:{" "}
            <b className={autonomy.reading.fabrications > 0 ? "text-red-600 tabular-nums dark:text-red-400" : "tabular-nums"}>
              {formatNumber(autonomy.reading.fabrications)}
            </b>
          </div>
          <div>Tỷ lệ dùng được: <b className="tabular-nums">{pctText(autonomy.reading.usableRate)}</b></div>
        </div>
      </Card>
    </div>
  );
}
