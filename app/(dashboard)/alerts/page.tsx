import Link from "next/link";
import { AcknowledgeButton, AlertConfigForm, AssignSelect, IgnoreButton, MarkAllReadButton, ResolveButton, RunAlertsButton, StartButton, UnassignButton, UnignoreButton } from "@/app/(dashboard)/alerts/alerts-actions";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { loadAlertConfig } from "@/lib/alerts/config";
import { can, requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getActionQueue, queueThroughput } from "@/lib/queries/action-queue";
import { assignableUsers } from "@/lib/actions/alerts";
import { CASE_STATUS_LABEL, CASE_STATUS_TONE, PRIORITY_LABEL, PRIORITY_TONE, TEAM_LABEL, type CasePriority, type CaseStatus, type CaseTeam, type CaseType } from "@/lib/constants/action-queue";
import { QueueFilters } from "@/app/(dashboard)/alerts/queue-filters";
import { ApprovalSection } from "@/app/(dashboard)/alerts/approval-section";
import { CareDrawerHost, CareOpenButton } from "@/app/(dashboard)/shipments/care-drawer";
import { InfoHint } from "@/components/info-hint";
import { QueueViewTabs } from "@/components/queue-view-tabs";
import { ideasWaitingReview } from "@/lib/queries/ideas";
import { Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

export const metadata = { title: "Cần xử lý" };

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("alerts:view");
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  // Bộ lọc lấy thẳng từ URL nên chia sẻ được: "việc trễ hạn trên 1 triệu chưa ai nhận" là một
  // đường dẫn gửi cho nhau được.
  const ownerRaw = one("owner");
  const filter = {
    team: (one("team") || undefined) as CaseTeam | undefined,
    type: (one("type") || undefined) as CaseType | undefined,
    priority: (one("priority") || undefined) as CasePriority | undefined,
    status: (one("status") || undefined) as CaseStatus | undefined,
    owner: ownerRaw === "none" ? "" : ownerRaw || undefined,
    minAmount: Number(one("minAmount")) || undefined,
    breachedOnly: one("breached") === "1",
    sort: (one("sort") || "impact") as "impact" | "money" | "age",
  };
  /*
    MỘT HÀNG ĐỢI, KHÔNG PHẢI HAI DANH SÁCH TRÊN CÙNG MỘT BẢNG.

    Trước đây trang này hiện "Hàng đợi việc" (xếp theo ưu tiên, có người nhận, có hạn) VÀ bên dưới
    là "Đang mở" — cùng bảng `notifications`, cùng những dòng đó, chỉ khác bộ lọc — cộng sáu thẻ đếm
    theo loại cảnh báo lọc danh sách dưới chứ không lọc hàng đợi trên. Người dùng không biết bấm
    "Đã xử lý" ở danh sách nào, và trang trả về hơn 1 MB HTML. Nay chỉ còn hàng đợi: bộ lọc theo loại
    việc / đội / người nhận / tiền / trễ hạn nằm ở góc phải.
  */
  const queuePage = Math.max(1, Number(one("qpage")) || 1);
  const queuePageSize = Math.min(200, Math.max(20, Number(one("qsize")) || 100));
  const [config, queue, staff, throughput] = await Promise.all([
    loadAlertConfig(),
    // Phân trang THẬT: nạp đúng một trang, đếm bằng CSDL. Trước đây nạp 300 rồi lấy số đó làm tổng.
    getActionQueue({ limit: queuePageSize, page: queuePage, filter }),
    assignableUsers(),
    // 30 ngày gần nhất: đủ dài để có mẫu, đủ ngắn để nói về cách làm việc hiện tại.
    queueThroughput(new Date(Date.now() - 30 * 86_400_000), new Date()),
  ]);
  const visibleCases = queue.cases;
  const canConfig = can(user, "alerts:manage");

  // Ngăn kéo tra nhanh đi LẦN LƯỢT theo đúng 50 việc đang hiện: ghi nhận xong tự sang việc kế.
  const hangDoiCare = visibleCases
    .slice(0, 50)
    .filter((c) => c.quickShipmentId)
    .map((c) => ({ shipmentId: c.quickShipmentId as string, caseId: c.id }));

  return (
    <div className="space-y-5">
      {/* Ngăn kéo tra nhanh đứng ngoài danh sách: việc bị đóng, dòng biến mất, ngăn kéo vẫn đi tiếp. */}
      <CareDrawerHost queue={hangDoiCare} />
      <PageHeader
        eyebrow="Vận hành"
        title="Cần xử lý"
        description="Việc cần làm hôm nay: đơn quá hạn, vận đơn treo, chuyển hoàn, case CSKH."
        hint="Đơn chờ xử lý quá hạn, vận đơn giao thất bại chờ phát lại, vận đơn treo lâu, chuyển hoàn, case CSKH mới — nhân viên vận đơn theo dõi tại đây và nhận tin qua nhóm Lark Suite (hoặc Telegram)."
        actions={
          <>
            <QueueViewTabs active="queue" />
            <MarkAllReadButton />
            <RunAlertsButton />
          </>
        }
      />
      {/* Việc có NGƯỜI đang chờ đứng trên việc do máy quét ra — để lẫn xuống dưới thì người xin ngồi đợi mà không ai biết. */}
      <ApprovalSection />
      {/* Ý tưởng marketing chờ duyệt cũng là NGƯỜI đang chờ, và trước đây không có chỗ nào báo. */}
      <IdeasWaiting />

      {/* ───────── HÀNG ĐỢI VIỆC: xếp theo mức ưu tiên tính được ───────── */}
      <SectionCard
        title={`Hàng đợi việc — ${formatNumber(queue.openTotal)} việc đang mở`}
        description={`${formatNumber(queue.totals.URGENT)} gấp · ${formatNumber(queue.totals.HIGH)} cao · ${formatNumber(queue.unassigned)} chưa ai nhận${queue.neglected ? ` · ${formatNumber(queue.neglected)} bị bỏ quên quá 3 ngày` : ""}${queue.breached ? ` · ${formatNumber(queue.breached)} TRỄ HẠN` : ""}${queue.financialImpact > 0 ? ` · ${formatVND(queue.financialImpact)} đang treo` : ""} · đang hiển thị ${formatNumber(queue.loaded === 0 ? 0 : (queue.page - 1) * queue.pageSize + 1)}–${formatNumber((queue.page - 1) * queue.pageSize + queue.matched)} / ${formatNumber(queue.total)}${queue.exactTotal ? "" : " (lọc theo mức ưu tiên/tiền/trễ hạn nên tổng là ước lượng trên)"}${queue.loaded < queue.total ? ` · các con số tổng hợp tính trên ${formatNumber(queue.loaded)} việc của trang này` : ""}`}
        actions={<QueueFilters types={queue.byType} teams={queue.byTeam} staff={staff} />}
        hint="Mức ưu tiên tính bằng quy tắc, không phải cảm tính: mức nghiêm trọng + tuổi việc + tiền đang treo + KHẢ NĂNG CỨU ĐƯỢC + có khách đang chờ + sắp cháy hàng. Đơn giao thất bại còn gọi lại được nên đứng trên đơn đã hoàn xong — việc không cứu được nữa thì gấp cũng vô ích. Rê chuột lên mức ưu tiên để xem từng phần điểm."
        padded={false}
      >
        {/*
          ĐỘI THỰC SỰ ĐÓNG ĐƯỢC BAO NHIÊU VIỆC — 30 ngày.
          "Đã đóng" gộp ba chuyện khác hẳn nhau: người làm xong · điều kiện tự hết · thôi theo dõi.
          Không tách ra thì con số 3.896 việc đã đóng không nói lên điều gì về đội.
        */}
        {throughput.byPeople + throughput.automatic + throughput.stale + throughput.unknown > 0 ? (
          <p className="border-b px-5 py-2.5 text-xs text-muted-foreground">
            30 ngày qua đã đóng: <strong className="text-foreground">{formatNumber(throughput.byPeople)}</strong> việc do người xử lý
            {throughput.peopleShare !== null ? ` (${throughput.peopleShare}%)` : ""} · {formatNumber(throughput.automatic)} tự đóng vì điều
            kiện hết
            {throughput.stale ? ` · ${formatNumber(throughput.stale)} thôi theo dõi` : ""}
            {throughput.ignored ? ` · ${formatNumber(throughput.ignored)} bỏ qua có lý do` : ""}
            {throughput.unknown ? ` · ${formatNumber(throughput.unknown)} đóng trước khi ERP ghi được ai đóng` : ""}
          </p>
        ) : null}

        {/*
          CHIA VIỆC THEO BỘ PHẬN.
          Một hàng đợi gần nghìn việc xếp đúng thứ tự vẫn không chạy nếu ai mở lên cũng thấy toàn
          việc của người khác. Dải này trả lời "việc này của bộ phận nào" trước khi hỏi "làm cái nào
          trước", và bấm vào là lọc ra đúng phần đó.
        */}
        {queue.byTeam.length > 1 ? (
          <div className="flex flex-wrap gap-2 border-b px-5 py-3">
            {queue.byTeam.map((t) => {
              const params = new URLSearchParams();
              if (one("team") !== t.team) params.set("team", t.team);
              const href = params.toString() ? `/alerts?${params.toString()}` : "/alerts";
              return (
                <Link
                  key={t.team}
                  href={href}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-accent",
                    one("team") === t.team && "border-primary bg-accent font-semibold",
                  )}
                >
                  <span>{TEAM_LABEL[t.team]}</span>
                  <span className="numeric ml-1.5 font-semibold">{formatNumber(t.count)}</span>
                  {t.breached ? <span className="ml-1.5 text-destructive">{formatNumber(t.breached)} trễ</span> : null}
                  {t.financialImpact > 0 ? <span className="ml-1.5 text-muted-foreground">{formatVND(t.financialImpact)}</span> : null}
                </Link>
              );
            })}
          </div>
        ) : null}

        {visibleCases.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {queue.total ? "Không có việc nào khớp bộ lọc đang chọn." : "Không có việc nào đang mở."}
          </p>
        ) : (
          <ul className="divide-y">
            {/*
              50 dòng, không phải 100. Mỗi dòng mang sáu nút thao tác (đều là component phía trình
              duyệt) nên nó là phần nặng nhất của trang: đo được ~2 KB gói dữ liệu cho MỖI dòng.
              Hàng đợi đã xếp theo mức ưu tiên nên 50 việc đầu là 50 việc đáng làm trước; tổng số
              vẫn hiện ở tiêu đề, và bộ lọc ở góc phải để đi tới phần còn lại.
            */}
            {visibleCases.slice(0, 50).map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
                <span
                  className={cn("mt-0.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", PRIORITY_TONE[c.priority])}
                  title={`Điểm ${c.score}/100 = ${c.scoreExplanation}`}
                >
                  {PRIORITY_LABEL[c.priority]} · {c.score}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Link href={c.href || "#"} className="text-sm font-semibold hover:text-primary hover:underline">{c.title}</Link>
                    {/* Mở kiện hàng ngay tại đây: gọi khách / xem ĐVVC nói gì mà không rời hàng đợi; ghi nhận xong tự sang việc kế. */}
                    {c.quickShipmentId ? (
                      <CareOpenButton shipmentId={c.quickShipmentId} caseId={c.id} className="rounded border px-1.5 py-px text-[10.5px] font-medium text-muted-foreground hover:bg-accent hover:no-underline">
                        Tra nhanh
                      </CareOpenButton>
                    ) : null}
                    {/* "Nên làm" + "vì sao đứng ở đây" nằm trong ⓘ — màn hình chính chỉ còn việc và lý do. */}
                    <InfoHint label="Nên làm gì và vì sao việc này đứng ở đây">
                      <p><b>Nên làm:</b> {c.recommendedAction}</p>
                      <p className="mt-1"><b>Ưu tiên vì:</b> {c.scoreExplanation}</p>
                      <p className="mt-1"><b>Nguồn:</b> {c.evidence.source}</p>
                      {c.status === "IGNORED" && c.ignoredReason ? <p className="mt-1"><b>Bỏ qua:</b> {c.ignoredReason}</p> : null}
                    </InfoHint>
                  </div>
                  <p className="text-xs text-muted-foreground">{c.reason}</p>
                  <p className="text-[10.5px] text-muted-foreground" title={formatDateTime(c.detectedAt)}>
                    {c.typeLabel} · phát hiện {c.ageLabel} trước ·{" "}
                    <span className={cn("rounded px-1 py-px", CASE_STATUS_TONE[c.status])}>{CASE_STATUS_LABEL[c.status]}</span>
                    {c.owner ? ` · ${c.owner.name} đang xử lý` : " · chưa ai nhận"}
                    {c.financialImpact > 0 ? ` · ${formatVND(c.financialImpact)} đang treo` : ""}
                    {c.sla ? (
                      <span className={cn("ml-1 font-semibold", c.sla.breached && "text-rose-600 dark:text-rose-400")} title={`Hạn xử lý ${formatDateTime(c.sla.dueAt)}`}>
                        · {c.sla.label}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  {c.status === "IGNORED" ? (
                    <UnignoreButton id={c.id} />
                  ) : (
                    <>
                      <AssignSelect id={c.id} users={staff} current={c.owner?.id ?? null} />
                      {c.status === "OPEN" ? <AcknowledgeButton id={c.id} /> : null}
                      {c.status !== "IN_PROGRESS" ? <StartButton id={c.id} /> : null}
                      {c.owner ? <UnassignButton id={c.id} /> : null}
                      <IgnoreButton id={c.id} />
                    </>
                  )}
                  <ResolveButton id={c.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {canConfig ? (
        <SectionCard title="Cấu hình cảnh báo · Lark Suite / Telegram" description="Nơi nhận cảnh báo và ngưỡng thời gian coi là quá hạn."
 hint="Lark: thêm Custom Bot vào nhóm nhân viên vận đơn rồi dán Webhook URL. Telegram: tạo bot qua @BotFather. Ngưỡng thời gian chỉnh theo quy trình của shop.">
          <AlertConfigForm config={{ ...config, telegramBotToken: "", larkSecret: "" }} hasToken={Boolean(config.telegramBotToken)} hasLarkSecret={Boolean(config.larkSecret)} />
        </SectionCard>
      ) : null}
    </div>
  );
}

/**
 * Ý TƯỞNG MARKETING ĐANG CHỜ DUYỆT.
 *
 * `ideasWaitingReview()` có sẵn từ lâu nhưng KHÔNG nơi nào gọi, nên marketer đăng ý tưởng xong là
 * nó nằm im — quản lý chỉ biết nếu tự nhớ mở trang Ý tưởng. Đây là NGƯỜI đang chờ người khác, đúng
 * loại việc trang này sinh ra để hiển thị.
 *
 * Không có gì chờ thì mục này BIẾN MẤT hẳn, không hiện khung rỗng: trang này vốn đã dài.
 */
async function IdeasWaiting() {
  const n = await ideasWaitingReview();
  if (!n) return null;
  return (
    <Link
      href="/ideas?tt=NEW"
      className="flex items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-2.5 text-sm transition-colors hover:border-amber-400 dark:border-amber-900/60 dark:bg-amber-950/20"
    >
      <Lightbulb className="size-4 shrink-0 text-amber-600" />
      <b>{formatNumber(n)} ý tưởng marketing</b> đang chờ duyệt
      <span className="ml-auto text-[12px] text-muted-foreground">Mở trang Ý tưởng →</span>
    </Link>
  );
}
