import Link from "next/link";
import { Bot, CircleSlash, Coins, HandHelping, MessageSquareText } from "lucide-react";
import { AiRunsTable } from "@/app/(dashboard)/ai/runs-table";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { AGENT_MODE_HINT, AGENT_MODE_LABEL, AI_ERROR_SCOPE_LABEL, costLabel, type AgentMode, type AiErrorScope } from "@/lib/constants/ai";
import { SALES_STAGE_LABEL, type SalesStage } from "@/lib/constants/sales-agent";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { aiSummary, listAiAgents, listAiRuns, recentAiErrors, salesStageBreakdown } from "@/lib/queries/ai";
import { ensureAgents } from "@/lib/ai/registry";
import { getAiSettings } from "@/lib/ai/config";
import { effectiveMode } from "@/lib/ai/config";

export const metadata = { title: "Nhân sự AI" };

export default async function AiPage() {
  await requirePermission("ai:view");
  await ensureAgents();
  const settings = await getAiSettings();
  const [summary, runs, agents, stages, errors] = await Promise.all([aiSummary(7), listAiRuns({ days: 7, limit: 200 }), listAiAgents(), salesStageBreakdown(), recentAiErrors(10)]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Nền tảng"
        title="Nhân sự AI"
        description="7 ngày gần nhất · mọi quyết định của máy đều mở ra đọc lại được"
        actions={
          <Link href="/ai/review" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted">
            Màn hình soát &amp; chấm tay
          </Link>
        }
        hint={
          <>
            <p className="font-semibold">Nấc chạy ngầm (SHADOW) nghĩa là gì</p>
            <p>
              Nhân sự AI đọc hội thoại thật, dựng trạng thái bán hàng trong ERP và soạn câu trả lời GỢI Ý. Câu đó không bao giờ tới tay khách: cổng gửi tin
              (<code>lib/ai/agents/sales/outbound.ts</code>) từ chối mọi câu do AI soạn khi chưa đạt nấc COPILOT.
            </p>
            <p className="mt-2">Cột &ldquo;Máy gợi ý / Nhân viên trả lời&rdquo; đặt hai câu cạnh nhau để đo xem máy có làm được việc không.</p>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Lượt chạy" value={formatNumber(summary.runs)} note={`${formatNumber(summary.succeeded)} xong · ${formatNumber(summary.failed)} lỗi`} icon={Bot} />
        <MetricCard
          label="Đã gửi cho khách"
          value={formatNumber(summary.sentToCustomer)}
          note={summary.sentToCustomer === 0 ? "Đúng như thiết kế ở nấc chạy ngầm" : "Kiểm tra ngay: nấc chạy ngầm không được gửi"}
          tone={summary.sentToCustomer === 0 ? "green" : "rose"}
          icon={MessageSquareText}
          hint="Số câu do AI soạn thực sự được gửi tới khách. Ở nấc SHADOW con số này PHẢI bằng 0."
        />
        <MetricCard label="Chuyển người" value={formatNumber(summary.handedOff)} note="Việc máy không được tự quyết" tone="amber" icon={HandHelping} />
        <MetricCard
          label="Lượt gọi bị chặn"
          value={formatNumber(summary.deniedToolCalls)}
          note="Cổng quyền đã chặn"
          tone="slate"
          icon={CircleSlash}
          hint="Số lần nhân sự AI ĐỊNH dùng một công cụ mà cổng quyền từ chối (chưa đủ nấc, không được cấp, tham số sai). Ghi lại để biết con bot đang cố làm gì."
        />
        <MetricCard
          label="Chi phí mô hình"
          value={costLabel(summary.costVnd, (n) => formatVND(n))}
          note={summary.unpricedRuns > 0 ? `${formatNumber(summary.unpricedRuns)} lượt chưa khai đơn giá` : `${formatNumber(summary.inputTokens + summary.outputTokens)} token`}
          tone="blue"
          icon={Coins}
          hint="Dấu gạch nghĩa là CHƯA BIẾT: có lượt chạy dùng mô hình chưa khai đơn giá trong settings ai.config.pricing. Chưa biết không được in ra thành 0đ."
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="gap-2 p-4 lg:col-span-1">
          <h2 className="text-sm font-semibold">Nhân sự đã đăng ký</h2>
          <ul className="space-y-2 text-sm">
            {agents.map((agent) => {
              const mode = (agent.enabled ? effectiveMode(agent.key, agent.mode, settings) : "OFF") as AgentMode;
              return (
                <li key={agent.id} className="rounded-lg border border-border/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{agent.name}</span>
                    <span className="rounded-md bg-muted px-2 py-0.5 text-[11.5px] font-semibold">{AGENT_MODE_LABEL[mode]}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{AGENT_MODE_HINT[mode]}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Khoá <code>{agent.key}</code> · nhận sự kiện: {agent.subscribes.join(", ") || "—"}
                  </p>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="gap-2 p-4 lg:col-span-1">
          <h2 className="text-sm font-semibold">Hội thoại theo giai đoạn</h2>
          {stages.length ? (
            <ul className="space-y-1 text-sm">
              {stages.map((s) => (
                <li key={s.stage} className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted-foreground">{SALES_STAGE_LABEL[s.stage as SalesStage] ?? s.stage}</span>
                  <span className="font-semibold tabular-nums">{formatNumber(s.count)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Chưa nạp hội thoại nào.</p>
          )}
        </Card>

        <Card className="gap-2 p-4 lg:col-span-1">
          <h2 className="text-sm font-semibold">Lỗi gần nhất</h2>
          {errors.length ? (
            <ul className="space-y-2 text-xs">
              {errors.map((e) => (
                <li key={e.id} className="rounded-lg border border-border/60 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{AI_ERROR_SCOPE_LABEL[e.scope as AiErrorScope] ?? e.scope}</span>
                    <span className="text-muted-foreground">{formatDateTime(e.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{e.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Không có lỗi nào trong sổ.</p>
          )}
        </Card>
      </div>

      <AiRunsTable rows={runs} />
    </div>
  );
}
