import Link from "next/link";
import { BellRing } from "lucide-react";
import { AcknowledgeButton, AlertConfigForm, AssignSelect, IgnoreButton, MarkAllReadButton, ResolveButton, RunAlertsButton, StartButton, UnassignButton, UnignoreButton } from "@/app/(dashboard)/alerts/alerts-actions";
import { PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { SectionCard } from "@/components/ui-bits";
import { loadAlertConfig } from "@/lib/alerts/config";
import { can, requirePermission } from "@/lib/auth/session";
import { NOTIFICATION_KIND_LABEL, NOTIFICATION_KIND_ORDER, SEVERITY_TONE } from "@/lib/constants/alerts";
import { formatDateTime, formatNumber, formatTimeAgo, formatVND } from "@/lib/format";
import { countOpenNotifications, listOpenNotifications, openCountsByKind } from "@/lib/queries/notifications";
import { getActionQueue, queueThroughput } from "@/lib/queries/action-queue";
import { assignableUsers } from "@/lib/actions/alerts";
import { CASE_STATUS_LABEL, CASE_STATUS_TONE, PRIORITY_LABEL, PRIORITY_TONE, TEAM_LABEL, type CasePriority, type CaseStatus, type CaseTeam, type CaseType } from "@/lib/constants/action-queue";
import { QueueFilters } from "@/app/(dashboard)/alerts/queue-filters";
import { ApprovalSection } from "@/app/(dashboard)/alerts/approval-section";
import { ideasWaitingReview } from "@/lib/queries/ideas";
import { Lightbulb } from "lucide-react";
import { UrlPagination } from "@/components/data-table/url-pagination";
import { cn } from "@/lib/utils";

export const metadata = { title: "Cần xử lý" };

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("alerts:view");
  const raw = await searchParams;
  const kindFilter = typeof raw.kind === "string" ? raw.kind : "";
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
    PHÂN TRANG DANH SÁCH CẢNH BÁO THÔ.
    Đo được: trang này trả về 1.368 KB HTML vì nó dựng thẳng 300 cảnh báo cộng 100 dòng hàng đợi,
    mỗi dòng kèm sáu nút thao tác. Trên 3G của nhân viên giao hàng thì đó là vài giây chỉ để tải
    những dòng không ai cuộn xuống đọc. Nay 50 dòng mỗi trang, lọc theo loại chạy TRONG SQL nên
    không còn chuyện cảnh báo cũ bị rơi khỏi 300 dòng mới nhất rồi biến mất khỏi bộ lọc.
  */
  const queuePage = Math.max(1, Number(one("qpage")) || 1);
  const queuePageSize = Math.min(200, Math.max(20, Number(one("qsize")) || 100));
  const page = Math.max(1, Number(one("page")) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(one("pageSize")) || 50));
  const [items, openTotal, counts, config, queue, staff, throughput] = await Promise.all([
    listOpenNotifications(pageSize, { offset: (page - 1) * pageSize, kind: kindFilter || undefined }),
    countOpenNotifications(kindFilter || undefined),
    openCountsByKind(),
    loadAlertConfig(),
    // Phân trang THẬT: nạp đúng một trang, đếm bằng CSDL. Trước đây nạp 300 rồi lấy số đó làm tổng.
    getActionQueue({ limit: queuePageSize, page: queuePage, filter }),
    assignableUsers(),
    // 30 ngày gần nhất: đủ dài để có mẫu, đủ ngắn để nói về cách làm việc hiện tại.
    queueThroughput(new Date(Date.now() - 30 * 86_400_000), new Date()),
  ]);
  // Hàng đợi việc có bộ lọc riêng (theo LOẠI VIỆC); các thẻ đếm ở trên lọc danh sách cảnh báo thô
  // bên dưới (theo LOẠI CẢNH BÁO). Hai thứ khác nhau, trước đây chồng lên nhau nên lọc một cái là
  // cả hai cùng rỗng mà không rõ vì sao.
  const visibleCases = queue.cases;
  const visible = items;
  const canConfig = can(user, "alerts:manage");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="Cần xử lý"
        description="Việc cần làm hôm nay: đơn quá hạn, vận đơn treo, chuyển hoàn, case CSKH."
        hint="Đơn chờ xử lý quá hạn, vận đơn giao thất bại chờ phát lại, vận đơn treo lâu, chuyển hoàn, case CSKH mới — nhân viên vận đơn theo dõi tại đây và nhận tin qua nhóm Lark Suite (hoặc Telegram)."
        actions={
          <>
            <MarkAllReadButton />
            <RunAlertsButton />
          </>
        }
      />
      {/* Việc có NGƯỜI đang chờ đứng trên việc do máy quét ra — để lẫn xuống dưới thì người xin ngồi đợi mà không ai biết. */}
      <ApprovalSection />
      {/* Ý tưởng marketing chờ duyệt cũng là NGƯỜI đang chờ, và trước đây không có chỗ nào báo. */}
      <IdeasWaiting />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {NOTIFICATION_KIND_ORDER.filter((k) => k !== "SYSTEM").map((kind) => (
          <Link key={kind} href={kindFilter === kind ? "/alerts" : `/alerts?kind=${kind}&page=1`} className={cn("block rounded-xl", kindFilter === kind && "ring-2 ring-primary/40")}>
            <MetricCard label={NOTIFICATION_KIND_LABEL[kind]} value={formatNumber(counts[kind] ?? 0)} note={kindFilter === kind ? "Đang lọc · bấm để bỏ lọc" : "Bấm để lọc"} icon={BellRing} tone={(counts[kind] ?? 0) > 0 ? (kind === "SHIPMENT_RETURNING" ? "blue" : "amber") : "slate"} />
          </Link>
        ))}
      </section>

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
                  <Link href={c.href || "#"} className="block text-sm font-semibold hover:text-primary hover:underline">{c.title}</Link>
                  <p className="text-xs text-muted-foreground">{c.reason}</p>
                  <p className="mt-0.5 text-xs"><span className="text-muted-foreground">Nên làm: </span>{c.recommendedAction}</p>
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
                  {/* Vì sao việc này đứng ở đây — điểm ưu tiên phải kiểm chứng được, không phải cảm tính. */}
                  <p className="text-[10.5px] text-muted-foreground/80">
                    Ưu tiên vì: {c.scoreExplanation} · nguồn: {c.evidence.source}
                    {c.status === "IGNORED" && c.ignoredReason ? ` · bỏ qua: ${c.ignoredReason}` : ""}
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

      <SectionCard
        title={`Đang mở (${formatNumber(openTotal)})`}
        description={`Mỗi dòng là một đơn / vận đơn cần chăm sóc. Tự đóng khi trạng thái đã thay đổi; hoặc bấm “Đã xử lý”.${openTotal > pageSize ? ` Đang xem ${formatNumber((page - 1) * pageSize + 1)}–${formatNumber(Math.min(page * pageSize, openTotal))}.` : ""}`}
        padded={false}
      >
        {visible.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">Không có việc cần xử lý.</p>
        ) : (
          <ul className="divide-y">
            {visible.map((n) => {
              const read = n.readBy.includes(user.id);
              return (
                <li key={n.id} className={cn("flex flex-wrap items-start gap-3 px-5 py-3", !read && "bg-primary/5")}>
                  <span className={cn("mt-0.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", SEVERITY_TONE[n.severity] ?? SEVERITY_TONE.info)}>{NOTIFICATION_KIND_LABEL[n.kind] ?? n.kind}</span>
                  <div className="min-w-0 flex-1">
                    <Link href={n.href || "#"} className={cn("block text-sm hover:text-primary hover:underline", !read && "font-semibold")}>
                      {n.title}
                    </Link>
                    <div className="text-xs text-muted-foreground">{n.body}</div>
                    <div className="text-[10.5px] text-muted-foreground" title={`Cảnh báo lúc ${formatDateTime(n.createdAt)}${n.occurredAt ? ` · cập nhật gần nhất ${formatDateTime(n.occurredAt)}` : ""}`}>
                      {formatTimeAgo(n.createdAt)}{n.occurredAt ? ` · cập nhật ${formatDateTime(n.occurredAt)}` : ""}
                      {n.notifiedAt ? " · đã gửi Telegram" : ""}
                    </div>
                  </div>
                  <ResolveButton id={n.id} />
                </li>
              );
            })}
          </ul>
        )}
        {openTotal > pageSize ? (
          <div className="border-t px-3 py-2">
            <UrlPagination pageCount={Math.max(1, Math.ceil(openTotal / pageSize))} total={openTotal} />
          </div>
        ) : null}
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
