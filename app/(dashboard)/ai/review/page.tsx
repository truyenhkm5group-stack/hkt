import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { LabelForm } from "@/app/(dashboard)/ai/review/label-form";
import { SALES_ACTION_LABEL, SALES_STAGE_LABEL, type SalesAction, type SalesStage } from "@/lib/constants/sales-agent";
import { costLabel } from "@/lib/constants/ai";
import { pancakeConversationUrl } from "@/lib/constants/sales-copilot";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { listShadowTurns, shadowMetrics, type ShadowTurnFilters } from "@/lib/queries/sales-review";
import { getDb } from "@/db";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "Soát nhân sự AI" };

function one(raw: SearchParams, key: string): string {
  const value = raw[key];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function boolParam(raw: SearchParams, key: string): boolean | undefined {
  const value = one(raw, key);
  return value === "1" ? true : value === "0" ? false : undefined;
}

const FILTER_LINKS: { key: string; label: string; options: { value: string; label: string }[] }[] = [
  { key: "takeover", label: "Chuyển người", options: [{ value: "1", label: "đã chuyển" }, { value: "0", label: "chưa chuyển" }] },
  { key: "error", label: "Lỗi", options: [{ value: "1", label: "có lỗi" }] },
  { key: "suggestion", label: "Gợi ý", options: [{ value: "1", label: "có gợi ý" }, { value: "0", label: "không có" }] },
  { key: "reviewed", label: "Chấm tay", options: [{ value: "0", label: "chưa chấm" }, { value: "1", label: "đã chấm" }] },
];

export default async function ShadowReviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("ai:view");
  const raw = await searchParams;
  const days = Number(one(raw, "days")) || 7;
  const filters: ShadowTurnFilters = {
    from: new Date(Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000),
    conversationId: one(raw, "conversation") || undefined,
    productId: one(raw, "product") || undefined,
    intent: one(raw, "intent") || undefined,
    humanTakeover: boolParam(raw, "takeover"),
    hasError: boolParam(raw, "error"),
    hasSuggestion: boolParam(raw, "suggestion"),
    reviewed: boolParam(raw, "reviewed"),
  };
  /*
    ═══════════ VÌ SAO TRANG NÀY PHẢI PHÂN TRANG ═══════════

    ĐO 19/09/2026 trên bản chạy thử, đúng trang này: HTML **1.097.170 ký tự** và **2.414 thẻ
    <button>** trong MỘT lần dựng. Cả 30/30 tệp JS đều trả 200 — máy chủ giao đủ.

    Nhưng mỗi lượt kéo theo một thẻ chấm, và thẻ chấm là một client component với khoảng 40 nút.
    Sáu mươi lượt ⇒ sáu mươi khối trạng thái React phải gắn tay cầm trước khi BẤT CỨ cú bấm nào có
    tác dụng — kể cả một nút chỉ đổi `useState` và không đụng tới máy chủ. Trong lúc ấy trang đã vẽ
    xong và trông y hệt một trang dùng được. Người soát bấm, không thấy gì xảy ra, và kết luận
    "hỏng". Họ đúng: một trang cần hàng chục giây mới gắn xong là một trang không bấm được.

    Nên số lượt mỗi trang phải CÓ TRẦN, và trần ấy là một con số nhỏ. Mười thẻ ≈ 400 nút — bằng
    một trang bình thường của ERP này.
  */
  const perPage = 10;
  const page = Math.max(1, Number(one(raw, "page")) || 1);
  // Lấy DƯ MỘT dòng để biết còn trang sau hay không, khỏi tốn một câu đếm riêng.
  const [duTurns, metrics] = await Promise.all([
    listShadowTurns({ ...filters, limit: perPage + 1, offset: (page - 1) * perPage }),
    shadowMetrics(days),
  ]);
  const coTrangSau = duTurns.length > perPage;
  const turns = duTurns.slice(0, perPage);
  const db = await getDb();
  const labels = await db.query.salesReviewLabels.findMany({ limit: 500, with: { reviewer: { columns: { name: true, email: true } } } });
  const labelBySuggestion = new Map(
    // Kèm TÊN người chấm để thẻ in được "ĐÃ LƯU · lúc nào · ai" ngay khi mở, không phải đợi tới
    // lần lưu kế tiếp mới biết ai đã chấm.
    labels.map((l) => {
      const nguoi = (l as { reviewer?: { name?: string; email?: string } | null }).reviewer;
      return [l.suggestionId, { ...(l as unknown as Record<string, unknown>), reviewerName: nguoi?.name || nguoi?.email || "" }];
    }),
  );

  const queryWith = (key: string, value: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(raw)) {
      const single = Array.isArray(v) ? v[0] : v;
      // Đổi bộ lọc thì QUAY VỀ TRANG 1: giữ nguyên số trang cũ trên một tập nhỏ hơn là đưa người
      // dùng tới một trang trống và để họ tự đoán vì sao.
      if (single && k !== key && !(k === "page" && key !== "page")) params.set(k, single);
    }
    if (value) params.set(key, value);
    const query = params.toString();
    return query ? `/ai/review?${query}` : "/ai/review";
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Nhân sự AI"
        title="Soát nấc chạy ngầm"
        description={`${formatNumber(metrics.turns)} lượt · ${formatNumber(metrics.conversations)} hội thoại · ${days} ngày`}
        hint={
          <>
            <p className="font-semibold">Đơn vị là LƯỢT, không phải tin nhắn</p>
            <p>Một lượt = một tin của khách + mọi tin shop trả lời cho tới tin tiếp theo của khách. Nhân viên hay trả lời bằng nhiều tin liền, nên không giả định một-đổi-một.</p>
            <p className="mt-2">Tỷ lệ chính xác chỉ tính trên phần ĐÃ CHẤM TAY và luôn hiện kèm độ phủ. Không dòng nào tự sinh sự thật nền.</p>
          </>
        }
      />

      {/* ───────── Đo được không cần chấm tay ───────── */}
      <Card className="gap-2 p-4">
        <h2 className="text-sm font-semibold">Đo trực tiếp (không cần chấm tay)</h2>
        <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Row label="Gửi cho khách" value={formatNumber(metrics.sentToCustomer)} tone={metrics.sentToCustomer === 0 ? "ok" : "bad"} note={metrics.sentToCustomer === 0 ? "đúng với nấc chạy ngầm" : "PHẢI bằng 0"} />
          <Row label="Chuyển người" value={metrics.handoffRate === null ? "—" : formatPercent(metrics.handoffRate)} note={`${formatNumber(metrics.handoffs)} lượt`} />
          <Row label="Lượt có gợi ý" value={formatNumber(metrics.withSuggestion)} note={`trên ${formatNumber(metrics.turns)} lượt`} />
          <Row label="Lỗi" value={formatNumber(metrics.errors)} tone={metrics.errors ? "bad" : "ok"} />
          <Row label="Độ trễ trung vị" value={`${formatNumber(metrics.medianLatencyMs)} ms`} note={`p90 ${formatNumber(metrics.p90LatencyMs)} ms`} />
          <Row label="Token vào / ra" value={`${formatNumber(metrics.inputTokens)} / ${formatNumber(metrics.outputTokens)}`} note={metrics.cachedInputTokens ? `${formatNumber(metrics.cachedInputTokens)} đọc từ đệm` : ""} />
          <Row label="Chi phí" value={costLabel(metrics.costVnd, (n) => formatVND(n))} note={metrics.unpricedRuns ? `${formatNumber(metrics.unpricedRuns)} lượt chưa khai giá` : ""} />
          <Row label="Chi phí / hội thoại" value={costLabel(metrics.costPerConversationVnd, (n) => formatVND(n))} />
          <Row label="Nhân viên đã trả lời" value={formatNumber(metrics.humanRepliedTurns)} note={`trên ${formatNumber(metrics.turns)} lượt`} />
          <Row label="Nhân viên phản hồi sau" value={metrics.medianHumanResponseSeconds === null ? "—" : `${formatNumber(metrics.medianHumanResponseSeconds)} giây`} note="trung vị" />
        </div>
      </Card>

      {/* ───────── Cần chấm tay ───────── */}
      <Card className="gap-2 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Độ chính xác (chỉ tính trên phần đã chấm tay)</h2>
          <p className="text-xs text-muted-foreground">
            Độ phủ: {metrics.reviewCoverage === null ? "—" : formatPercent(metrics.reviewCoverage)} · {formatNumber(metrics.reviewed)}/{formatNumber(metrics.turns)} lượt
            {metrics.hallucinations ? ` · ${formatNumber(metrics.hallucinations)} lượt bị chấm là bịa / phá luật` : ""}
          </p>
        </div>
        <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {metrics.labelled.map((m) => (
            <Row
              key={m.key}
              label={m.label}
              value={m.accuracy === null ? "chưa chấm" : formatPercent(m.accuracy)}
              note={m.reviewed ? `${formatNumber(m.correct)}/${formatNumber(m.reviewed)}` : ""}
              tone={m.accuracy === null ? "muted" : m.accuracy >= 90 ? "ok" : "bad"}
            />
          ))}
        </div>
      </Card>

      {/* ───────── Bộ lọc ───────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {FILTER_LINKS.map((f) => (
          <span key={f.key} className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{f.label}:</span>
            {f.options.map((o) => (
              <Link key={o.value} href={queryWith(f.key, one(raw, f.key) === o.value ? "" : o.value)} className={`rounded border px-1.5 py-0.5 font-semibold ${one(raw, f.key) === o.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
                {o.label}
              </Link>
            ))}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Khoảng:</span>
          {["1", "7", "30"].map((d) => (
            <Link key={d} href={queryWith("days", d)} className={`rounded border px-1.5 py-0.5 font-semibold ${String(days) === d ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
              {d} ngày
            </Link>
          ))}
        </span>
        {one(raw, "conversation") || one(raw, "product") || one(raw, "intent") ? (
          <Link href="/ai/review" className="rounded border border-border px-1.5 py-0.5 font-semibold text-muted-foreground">
            xoá lọc
          </Link>
        ) : null}
      </div>

      {/* ───────── Danh sách lượt ───────── */}
      <div className="space-y-3">
        {turns.map((turn) => (
          <Card key={turn.suggestionId} className="gap-2 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {formatDateTime(turn.createdAt)} · {turn.customerName || "khách chưa rõ tên"} ·{" "}
                <Link href={queryWith("conversation", turn.conversationId)} className="underline">
                  hội thoại {turn.conversationExternalId}
                </Link>
                {turn.humanTakeoverAt ? " · ĐÃ CHUYỂN NGƯỜI" : ""}
                {/*
                  LIÊN KẾT VỀ CHAT GỐC — không phải tiện nghi, mà là điều kiện để chấm được.

                  Thẻ này chỉ in TIN KÍCH HOẠT và CÂU ĐẦU nhân viên trả lời. Đo 22/09/2026: trung
                  bình 12 tin mỗi hội thoại, nhiều nhất 79. Nên "máy có hiểu đúng ý khách không"
                  thường KHÔNG trả lời được từ một lượt — người chấm phải đọc cả mạch.

                  Thiếu một trong hai khoá thì KHÔNG hiện nút: một liên kết dựng từ chuỗi rỗng vẫn
                  bấm được và vẫn mở ra một trang — hội thoại của người khác, hoặc 404.
                */}
                {pancakeConversationUrl(turn.pageId, turn.conversationExternalId) ? (
                  <>
                    {" · "}
                    <a
                      href={pancakeConversationUrl(turn.pageId, turn.conversationExternalId)!}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                    >
                      <ExternalLink className="size-3" />
                      Mở chat gốc
                    </a>
                  </>
                ) : null}
              </span>
              <span>
                {turn.tier} · {turn.model || "không gọi mô hình"} · {formatNumber(turn.inputTokens)}/{formatNumber(turn.outputTokens)} token ·{" "}
                {costLabel(turn.costVnd, (n) => formatVND(n))}
                {turn.pricingVersion ? ` (giá ${turn.pricingVersion})` : ""} · {formatNumber(turn.latencyMs)} ms · {formatNumber(turn.toolCalls)} lượt gọi công cụ
                {turn.deniedCalls ? ` (${formatNumber(turn.deniedCalls)} bị chặn)` : ""}
              </span>
            </div>

            {turn.error ? <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">{turn.error}</p> : null}

            <div className="grid gap-3 lg:grid-cols-3">
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Khách nhắn</p>
                <p className="whitespace-pre-wrap rounded bg-muted/60 p-2 text-sm">{turn.customerMessage || "—"}</p>
                <p className="text-[11px] text-muted-foreground">
                  Ý định: {turn.intents.join(", ") || "—"} · độ tin {turn.confidence === null ? "—" : turn.confidence.toFixed(2)}
                </p>
                <pre className="max-h-32 overflow-auto rounded bg-muted/40 p-2 text-[10.5px]">{JSON.stringify(turn.entities, null, 1)}</pre>
              </div>

              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">Máy gợi ý</p>
                <p className="whitespace-pre-wrap rounded bg-primary/5 p-2 text-sm">{turn.suggestedReply || "— (không soạn gì)"}</p>
                <p className="text-[11px] text-muted-foreground">
                  {SALES_STAGE_LABEL[turn.stageBefore as SalesStage] ?? turn.stageBefore} → {SALES_STAGE_LABEL[turn.stageAfter as SalesStage] ?? turn.stageAfter} ·{" "}
                  {SALES_ACTION_LABEL[turn.action as SalesAction] ?? turn.action}
                </p>
                {turn.decisionReason ? <p className="text-[11px] text-muted-foreground">{turn.decisionReason}</p> : null}
                {turn.runId ? (
                  <Link href={`/ai/${turn.runId}`} className="text-[11px] underline">
                    mở lượt chạy đầy đủ
                  </Link>
                ) : null}
              </div>

              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Nhân viên trả lời</p>
                <p className="whitespace-pre-wrap rounded bg-muted/60 p-2 text-sm">{turn.humanReply || "chưa trả lời"}</p>
                <p className="text-[11px] text-muted-foreground">
                  {turn.humanReplyCount ? `${formatNumber(turn.humanReplyCount)} tin` : "0 tin"}
                  {turn.humanResponseSeconds === null ? "" : ` · sau ${formatNumber(turn.humanResponseSeconds)} giây`}
                </p>
                {turn.labelSummary ? <p className="text-[11px] text-amber-700 dark:text-amber-300">{turn.labelSummary}</p> : null}
              </div>
            </div>

            <LabelForm suggestionId={turn.suggestionId} initial={labelBySuggestion.get(turn.suggestionId) ?? {}} />
          </Card>
        ))}
        {turns.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            {page > 1
              ? "Hết lượt ở trang này. Quay lại trang trước."
              : "Chưa có lượt nào khớp bộ lọc. Nhân sự AI chạy khi có tin nhắn khách vào qua webhook hội thoại hoặc job nạp bù."}
          </Card>
        ) : null}

        {page > 1 || coTrangSau ? (
          <div className="flex items-center justify-between gap-2 text-xs">
            {page > 1 ? (
              <Link href={queryWith("page", String(page - 1))} className="rounded border border-border px-2 py-1">
                ← trang trước
              </Link>
            ) : (
              <span />
            )}
            <span className="text-muted-foreground">trang {page} · mỗi trang {perPage} lượt</span>
            {coTrangSau ? (
              <Link href={queryWith("page", String(page + 1))} className="rounded border border-border px-2 py-1">
                trang sau →
              </Link>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "ok" | "bad" | "muted" }) {
  const color = tone === "ok" ? "text-success" : tone === "bad" ? "text-destructive" : tone === "muted" ? "text-muted-foreground" : "";
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border/40 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">
        <span className={`font-semibold tabular-nums ${color}`}>{value}</span>
        {note ? <span className="ml-1.5 text-[11px] text-muted-foreground">{note}</span> : null}
      </span>
    </div>
  );
}
