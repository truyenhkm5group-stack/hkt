import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { SendCard } from "@/app/(dashboard)/ai/copilot/send-card";
import { SALES_ACTION_LABEL, SALES_STAGE_LABEL, HANDOFF_REASON_LABEL, type HandoffReason, type SalesAction, type SalesStage } from "@/lib/constants/sales-agent";
import { AGENT_MODE_LABEL, modeAtLeast } from "@/lib/constants/ai";
import { COPILOT_REJECT_LABEL, type CopilotRejectReason } from "@/lib/constants/sales-copilot";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { getAgent } from "@/lib/ai-workforce/registry";
import { requirePermission } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/auth/session";
import { formatDateTime, formatNumber } from "@/lib/format";
import { copilotKpi, copilotPages, copilotQueue } from "@/lib/queries/sales-copilot";

export const metadata = { title: "Hàng đợi trợ lý AI" };

/**
 * HÀNG ĐỢI NẤC TRỢ LÝ — máy soạn, người bấm gửi.
 *
 * Màn hình này là nơi DUY NHẤT một câu do AI soạn tới được khách, và nó nói thẳng ra điều đó ở
 * đầu trang: nấc quyền hạn đang là gì, hai công tắc chặn cứng đang đóng hay mở, page nào được thí
 * điểm. Một người mở màn hình này phải biết ngay mình đang ở chế độ nào — chứ không phải bấm gửi
 * rồi mới biết tin không đi (hoặc tệ hơn: tưởng không đi mà lại đi).
 */
export default async function CopilotPage() {
  await requirePermission("ai:view");
  const [user, settings, pages] = await Promise.all([getCurrentUser(), getAiSettings(), copilotPages()]);
  const agent = await getAgent("sales", settings);
  const mode = agent?.mode ?? "OFF";
  const sanSang = modeAtLeast(mode, "COPILOT") && settings.hardLimits.allowHumanApprovedSend && pages.length > 0;
  const [queue, kpi] = await Promise.all([copilotQueue({ limit: 40 }), copilotKpi(7)]);

  return (
    <div className="space-y-4">
      <PageHeader title="Hàng đợi trợ lý AI" description="Máy soạn — nhân viên đọc, sửa nếu cần, rồi bấm gửi. Không có đường nào cho máy tự gửi." />

      {/* TRẠNG THÁI CỔNG — đọc từ đúng nơi cổng gửi đọc, không phải một bản mô tả chép tay. */}
      <Card className="p-3">
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Nấc quyền hạn</p>
            <p className="font-semibold">{AGENT_MODE_LABEL[mode]}</p>
          </div>
          <div>
            <p className="text-muted-foreground">MÁY tự gửi</p>
            <p className={settings.hardLimits.allowAutoSend ? "font-semibold text-rose-600 dark:text-rose-400" : "font-semibold text-emerald-700 dark:text-emerald-300"}>
              {settings.hardLimits.allowAutoSend ? "⛔ ĐANG MỞ" : "CẤM"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">NHÂN VIÊN bấm gửi</p>
            <p className="font-semibold">{settings.hardLimits.allowHumanApprovedSend ? "được phép" : "CẤM (chưa mở công tắc)"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Page thí điểm</p>
            <p className="font-semibold">{pages.length ? pages.join(", ") : "chưa khai — không page nào gửi được"}</p>
          </div>
        </div>
        {!sanSang ? (
          <p className="mt-2 rounded bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            Cổng gửi đang ĐÓNG. Câu máy soạn vẫn hiện ra để đọc và chấm, nhưng bấm Gửi sẽ bị từ chối kèm lý do. Cần đủ ba
            điều: nấc TRỢ LÝ trở lên · <code>AI_ALLOW_HUMAN_APPROVED_SEND=true</code> · page có tên trong{" "}
            <code>ai.copilotPages</code>.
          </p>
        ) : null}
      </Card>

      {/* CHỈ SỐ — mẫu số rỗng thì in dấu gạch, không in 0%. */}
      <Card className="p-3">
        <div className="grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Gợi ý đã soạn (7 ngày)" value={formatNumber(kpi.suggestions)} />
          <Stat label="Gửi nguyên văn" value={formatNumber(kpi.sentUnchanged)} />
          <Stat label="Sửa rồi gửi" value={formatNumber(kpi.editedSent)} />
          <Stat label="Từ chối" value={formatNumber(kpi.rejected)} />
          <Stat label="Tỷ lệ dùng được" value={kpi.acceptanceRate === null ? "—" : `${kpi.acceptanceRate}%`} />
          <Stat label="Thời gian soát (trung vị)" value={kpi.medianReviewSeconds === null ? "—" : `${kpi.medianReviewSeconds}s`} />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Tin THẬT SỰ đã rời khỏi ERP: <strong>{formatNumber(kpi.actuallySent)}</strong>
          {kpi.failedSends ? ` · ${formatNumber(kpi.failedSends)} lượt gửi hỏng` : ""} · đọc từ sổ thao tác, không suy từ cờ nào.
          {kpi.rejectReasons.length ? ` · Lý do từ chối nhiều nhất: ${kpi.rejectReasons.slice(0, 3).map((r) => `${COPILOT_REJECT_LABEL[r.reason as CopilotRejectReason] ?? r.reason} (${r.n})`).join(" · ")}` : ""}
        </p>
      </Card>

      {!pages.length ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Chưa khai page nào vào <code>ai.copilotPages</code> nên hàng đợi trống. Đây là mặc định an toàn: quên khai thì không
          ai nhắn được cho khách, chứ không phải mọi page cùng mở.
        </Card>
      ) : !queue.length ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">Không có hội thoại nào đang chờ xử lý.</Card>
      ) : null}

      {queue.map((row) => (
        <Card key={row.conversationId} className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-semibold">{row.customerName || "(chưa có tên)"}</span>
            <Badge>{row.sourceType || "?"}</Badge>
            <Badge>{SALES_STAGE_LABEL[row.stage as SalesStage] ?? row.stage}</Badge>
            {row.productName ? <Badge>{row.productName}</Badge> : <Badge tone="warn">chưa nhận ra sản phẩm</Badge>}
            <span className="text-muted-foreground">page {row.pageId}</span>
            <Link href={`/ai/review?conversation=${row.conversationId}`} className="ml-auto text-muted-foreground underline">
              xem lượt chạy
            </Link>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Khách nhắn</p>
              <p className="whitespace-pre-wrap rounded bg-muted/60 p-2 text-sm">{row.customerMessage || "(không có nội dung)"}</p>
              <p className="text-[11px] text-muted-foreground">{row.customerMessageAt ? formatDateTime(row.customerMessageAt) : "—"}</p>
            </div>

            {/*
              DỮ KIỆN MÁY CHỦ ĐÃ DÙNG — hiện cạnh câu, không giấu sau một cú bấm.
              Người soát phải kiểm được câu chữ dựa trên cái gì, nếu không họ chỉ còn cách tin nó.
            */}
            <div className="space-y-1 text-[11px]">
              <p className="font-semibold uppercase tracking-wide text-muted-foreground">Máy hiểu &amp; căn cứ</p>
              <p>Ý định: {row.intents.length ? row.intents.join(", ") : "—"}</p>
              <p>Việc máy chọn: {SALES_ACTION_LABEL[row.action as SalesAction] ?? (row.action || "—")} · tin cậy {row.confidence === null ? "—" : row.confidence}</p>
              {row.decisionReason ? <p className="text-muted-foreground">{row.decisionReason}</p> : null}
              {row.missing.length ? <p>Còn thiếu để lên đơn: {row.missing.join(", ")}</p> : null}
              {row.handoffReason ? (
                <p className="font-semibold text-amber-700 dark:text-amber-300">
                  Chuyển người: {HANDOFF_REASON_LABEL[row.handoffReason as HandoffReason] ?? row.handoffReason}
                  {row.handoffReason === "SIZE_DATA_MISSING" ? " — ERP chưa có bảng số đo, máy KHÔNG đoán size" : ""}
                </p>
              ) : null}
              <EntityList entities={row.entities} />
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Máy soạn</p>
            <SendCard
              conversationId={row.conversationId}
              suggestionId={row.suggestionId}
              suggestedReply={row.suggestedReply}
              stale={row.stale}
              humanTakeover={Boolean(row.humanTakeoverAt)}
              canRelease={row.takeoverByUserId === user?.id}
            />
            <p className="text-[11px] text-muted-foreground">Máy soạn lúc {row.suggestedAt ? formatDateTime(row.suggestedAt) : "—"}</p>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="text-base font-semibold">{value}</p>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  const cls = tone === "warn" ? "border-amber-500 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground";
  return <span className={`rounded border px-1.5 py-0.5 text-[11px] ${cls}`}>{children}</span>;
}

/** Thực thể máy bóc ra — chỉ hiện ô CÓ giá trị, để mắt người đọc không phải lọc chỗ trống. */
function EntityList({ entities }: { entities: Record<string, unknown> }) {
  const co = Object.entries(entities).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "");
  if (!co.length) return null;
  return <p className="text-muted-foreground">Bóc được: {co.map(([k, v]) => `${k}=${String(v)}`).join(" · ")}</p>;
}
