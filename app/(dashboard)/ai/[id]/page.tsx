import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { AGENT_MODE_LABEL, ESCALATION_REASON_LABEL, ROUTE_TIER_LABEL, RUN_STATUS_LABEL, RUN_STATUS_TONE, costLabel, type AgentMode, type EscalationReason, type RouteTier, type RunStatus } from "@/lib/constants/ai";
import { TOOL_OUTCOME_LABEL, type ToolOutcome } from "@/lib/constants/ai-tools";
import { HANDOFF_REASON_LABEL, SALES_ACTION_LABEL, SALES_STAGE_LABEL, type HandoffReason, type SalesAction, type SalesStage } from "@/lib/constants/sales-agent";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getAiRunDetail } from "@/lib/queries/ai";
import { OrderDraftCard } from "@/app/(dashboard)/ai/[id]/order-draft-card";
import { RegressionForm } from "@/app/(dashboard)/ai/[id]/regression-form";
import { buildOrderDraft, type OrderDraftOffer } from "@/lib/constants/order-draft";
import { missingOrderRequirements } from "@/lib/ai-workforce/agents/sales/confirm";
import { parseSalesState } from "@/lib/ai-workforce/agents/sales/state";
import { cn } from "@/lib/utils";

export const metadata = { title: "Lượt chạy nhân sự AI" };

const badge = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <p className="text-sm text-muted-foreground">—</p>;
  return <pre className="max-h-80 overflow-auto rounded-lg bg-muted/60 p-3 text-[11.5px] leading-5">{JSON.stringify(value, null, 2)}</pre>;
}

export default async function AiRunPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("ai:view");
  const { id } = await params;
  const detail = await getAiRunDetail(id);
  if (!detail) notFound();
  const { run, agent, toolCalls, modelCalls, suggestion, conversation, messages } = detail;
  const decision = (run.decision ?? {}) as Record<string, unknown>;
  const stateAfter = (run.stateAfter ?? {}) as Record<string, unknown>;
  const input = (run.input ?? {}) as Record<string, unknown>;

  /*
    BẢN NHÁP ĐƠN — dựng từ TRẠNG THÁI SAU của chính lượt này, không đọc lại hội thoại hôm nay.

    Đọc lại nguồn sống thì màn hình quan sát một lượt chạy của tuần trước lại in ra con số của hôm
    nay, và lúc hai con số lệch nhau thì không ai kiểm được gì nữa. Điều kiện bán lấy từ ẢNH CHỤP
    trên hội thoại (`offer_snapshot`) vì lý do y hệt: khách được báo 499k thì cuộc ấy thuộc mức 499k.

    Xác nhận đọc từ chính quyết định đã ghi — không tính lại: `checkContextualConfirmation` cần mốc
    tin nhắn và đồng hồ LÚC ẤY, mà lúc ấy đã qua rồi.
  */
  const draftState = parseSalesState(run.stateAfter);
  const offer = (conversation?.offerSnapshot ?? null) as OrderDraftOffer | null;
  const orderDraft = buildOrderDraft({
    state: draftState,
    missing: missingOrderRequirements(draftState),
    confirmed: Boolean((decision.facts as Record<string, unknown> | undefined)?.confirmed),
    offer: offer
      ? {
          unitPrice: offer.unitPrice ?? null,
          shippingFee: offer.shippingFee ?? null,
          freeShipFrom: offer.freeShipFrom ?? null,
          availableColors: Array.isArray(offer.availableColors) ? offer.availableColors : [],
          codPolicy: typeof offer.codPolicy === "string" ? offer.codPolicy : "",
        }
      : null,
    productCode: "",
    sku: draftState.variantLabel,
    sourcePageId: conversation?.pageId ?? "",
    sourceConversationId: conversation?.externalId ?? "",
    humanTakeoverAt: conversation?.humanTakeoverAt ?? null,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Nhân sự AI"
        title={`Lượt chạy · ${agent?.name ?? run.agentId}`}
        description={`${formatDateTime(run.startedAt)} · nấc ${AGENT_MODE_LABEL[run.mode as AgentMode] ?? run.mode} · ${formatNumber(run.latencyMs)} ms`}
        actions={
          <Link href="/ai" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted">
            <ArrowLeft className="size-4" /> Về danh sách
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(badge, RUN_STATUS_TONE[run.status as RunStatus] ?? RUN_STATUS_TONE.SKIPPED)}>{RUN_STATUS_LABEL[run.status as RunStatus] ?? run.status}</span>
        <span className={cn(badge, "bg-muted text-muted-foreground")}>Nấc xử lý: {ROUTE_TIER_LABEL[run.tier as RouteTier] ?? run.tier}</span>
        {run.escalationReason ? <span className={cn(badge, "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300")}>Leo nấc: {ESCALATION_REASON_LABEL[run.escalationReason as EscalationReason] ?? run.escalationReason}</span> : null}
        <span className={cn(badge, "bg-muted text-muted-foreground")}>
          Token {formatNumber(run.inputTokens)} / {formatNumber(run.outputTokens)}
          {run.cachedInputTokens > 0 ? ` · đệm ${formatNumber(run.cachedInputTokens)}` : ""} · chi phí {costLabel(run.costVnd, (n) => formatVND(n))}
        </span>
        {/*
          MỘT CON SỐ TIỀN KHÔNG NÓI NÓ ĐƯỢC TÍNH THEO BẢNG GIÁ NÀO thì không so sánh được giữa hai
          kỳ: đổi giá một lần là mọi con số lịch sử đổi nghĩa mà không ai biết. Nên phiên bản bảng
          giá đứng NGAY CẠNH số tiền, và "chưa khai giá" phải hiện ra chứ không im lặng.
        */}
        <span className={cn(badge, run.pricingVersion ? "bg-muted text-muted-foreground" : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300")}>
          Bảng giá: {run.pricingVersion || "chưa khai — chi phí là CHƯA BIẾT"}
        </span>
        {suggestion?.sent ? <span className={cn(badge, "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300")}>ĐÃ GỬI CHO KHÁCH</span> : <span className={cn(badge, "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300")}>Không gửi cho khách</span>}
      </div>

      {run.error ? (
        <Card className="gap-1 border-destructive/40 p-4">
          <h2 className="text-sm font-semibold text-destructive">Lỗi</h2>
          <p className="text-sm">{run.error}</p>
        </Card>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="gap-2 p-4">
          <h2 className="text-sm font-semibold">1 · Tin nhắn vào</h2>
          <p className="rounded-lg bg-muted/60 p-3 text-sm">{String(input.text ?? "—")}</p>
          <p className="text-xs text-muted-foreground">
            Hội thoại: {conversation ? `${conversation.customerName || "khách chưa rõ tên"} · ${conversation.pageId}/${conversation.externalId}` : run.subjectId}
            {conversation?.humanTakeoverAt ? ` · NGƯỜI ĐÃ TIẾP NHẬN lúc ${formatDateTime(conversation.humanTakeoverAt)}` : ""}
          </p>
        </Card>

        <Card className="gap-2 p-4">
          <h2 className="text-sm font-semibold">2 · Ý định &amp; thực thể bóc được</h2>
          <Json value={run.understanding} />
        </Card>

        <Card className="gap-2 p-4">
          <h2 className="text-sm font-semibold">3 · Trạng thái trước</h2>
          <Json value={run.stateBefore} />
        </Card>

        <Card className="gap-2 p-4">
          <h2 className="text-sm font-semibold">4 · Trạng thái sau</h2>
          <p className="text-xs text-muted-foreground">Giai đoạn: {SALES_STAGE_LABEL[stateAfter.stage as SalesStage] ?? String(stateAfter.stage ?? "—")}</p>
          <Json value={run.stateAfter} />
        </Card>
      </div>

      <Card className="gap-2 p-4">
        <h2 className="text-sm font-semibold">5 · Quyết định</h2>
        <p className="text-sm">
          <span className="font-semibold">{SALES_ACTION_LABEL[decision.action as SalesAction] ?? String(decision.action ?? "—")}</span>
          {decision.reason ? <span className="text-muted-foreground"> — {String(decision.reason)}</span> : null}
        </p>
        {decision.handoffReason ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">Lý do chuyển người: {HANDOFF_REASON_LABEL[decision.handoffReason as HandoffReason] ?? String(decision.handoffReason)}</p>
        ) : null}
        <Json value={run.decision} />
      </Card>

      <Card className="gap-2 p-4">
        <h2 className="text-sm font-semibold">6 · Công cụ ERP đã gọi ({toolCalls.length})</h2>
        {toolCalls.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="p-2">#</th>
                  <th className="p-2">Công cụ</th>
                  <th className="p-2">Kết cục</th>
                  <th className="p-2">Tham số</th>
                  <th className="p-2">Kết quả / lý do</th>
                  <th className="p-2 text-right">ms</th>
                </tr>
              </thead>
              <tbody>
                {toolCalls.map((call) => (
                  <tr key={call.id} className="border-t border-border/60 align-top">
                    <td className="p-2 tabular-nums">{call.seq}</td>
                    <td className="p-2 font-medium">{call.tool}</td>
                    <td className="p-2">
                      <span className={cn(badge, call.outcome === "OK" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300")}>
                        {TOOL_OUTCOME_LABEL[call.outcome as ToolOutcome] ?? call.outcome}
                      </span>
                    </td>
                    <td className="max-w-[220px] p-2"><pre className="overflow-x-auto text-[11px]">{JSON.stringify(call.args)}</pre></td>
                    <td className="max-w-[320px] p-2"><pre className="overflow-x-auto text-[11px]">{call.error ?? JSON.stringify(call.result)}</pre></td>
                    <td className="p-2 text-right tabular-nums">{formatNumber(call.latencyMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Không gọi công cụ nào.</p>
        )}
      </Card>

      <Card className="gap-2 p-4">
        <h2 className="text-sm font-semibold">7 · Lần gọi mô hình ({modelCalls.length})</h2>
        {modelCalls.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="p-2">Bước</th>
                  <th className="p-2">Nấc</th>
                  <th className="p-2">Nhà cung cấp · mô hình</th>
                  <th className="p-2 text-right">Token vào / ra</th>
                  <th className="p-2 text-right">Đệm</th>
                  <th className="p-2 text-right">Chi phí</th>
                  <th className="p-2">Bảng giá</th>
                  <th className="p-2 text-right">ms</th>
                  <th className="p-2">Lỗi</th>
                </tr>
              </thead>
              <tbody>
                {modelCalls.map((call) => (
                  <tr key={call.id} className="border-t border-border/60">
                    <td className="p-2">{call.step}</td>
                    <td className="p-2">{call.tier}</td>
                    <td className="p-2">{call.provider} · {call.model}</td>
                    <td className="p-2 text-right tabular-nums">{formatNumber(call.inputTokens)} / {formatNumber(call.outputTokens)}</td>
                    <td className="p-2 text-right tabular-nums">{call.cachedInputTokens > 0 ? formatNumber(call.cachedInputTokens) : "—"}</td>
                    <td className="p-2 text-right tabular-nums">{costLabel(call.costVnd, (n) => formatVND(n))}</td>
                    <td className="p-2 text-muted-foreground">{call.pricingVersion || "chưa khai"}</td>
                    <td className="p-2 text-right tabular-nums">{formatNumber(call.latencyMs)}</td>
                    <td className="p-2 text-muted-foreground">{call.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Không gọi mô hình lần nào — lượt chạy này xử lý hết bằng luật, chi phí thật sự bằng 0.</p>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="gap-2 p-4">
          <h2 className="text-sm font-semibold">8 · Máy gợi ý</h2>
          <p className="whitespace-pre-wrap rounded-lg bg-primary/5 p-3 text-sm">{run.suggestedReply || "— (không soạn gì)"}</p>
          <p className="text-xs text-muted-foreground">Ở nấc chạy ngầm, câu này chỉ nằm trong ERP. Cổng gửi tin từ chối mọi câu do AI soạn khi chưa đạt nấc COPILOT.</p>
        </Card>
        <Card className="gap-2 p-4">
          <h2 className="text-sm font-semibold">9 · Nhân viên thực sự trả lời</h2>
          <p className="whitespace-pre-wrap rounded-lg bg-muted/60 p-3 text-sm">{suggestion?.humanReply || "Chưa có câu trả lời của nhân viên"}</p>
          {suggestion?.humanRepliedAt ? <p className="text-xs text-muted-foreground">{formatDateTime(suggestion.humanRepliedAt)}</p> : null}
        </Card>
      </div>

      <Card className="gap-2 p-4">
        <h2 className="text-sm font-semibold">10 · Bối cảnh hội thoại (12 tin gần nhất)</h2>
        <ul className="space-y-2 text-sm">
          {messages.map((m) => (
            <li key={m.id} className={cn("rounded-lg p-2", m.fromPage ? "bg-muted/60" : "bg-primary/5")}>
              <div className="text-[11px] text-muted-foreground">
                {m.fromPage ? "Shop" : "Khách"} · {formatDateTime(m.sentAt ?? m.createdAt)}
                {m.fromAgent ? " · do nhân sự AI gửi" : ""}
              </div>
              <div className="whitespace-pre-wrap">{m.text || "(không có chữ)"}</div>
            </li>
          ))}
          {messages.length === 0 ? <li className="text-muted-foreground">Chưa có tin nhắn nào.</li> : null}
        </ul>
      </Card>

      <OrderDraftCard draft={orderDraft} />

      <Card className="gap-3 p-4">
        <h2 className="text-sm font-semibold">12 · Bộ ca hồi quy</h2>
        <RegressionForm runId={run.id} defaultTitle={`Lượt ${formatDateTime(run.startedAt)} · ${String(input.text ?? "").slice(0, 80)}`} />
      </Card>
    </div>
  );
}
