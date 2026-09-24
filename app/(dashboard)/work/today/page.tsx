import Link from "next/link";
import { AlertTriangle, ArrowRight, Ban, Clock, UserX } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AutoAssignButton, ReassignSelect } from "@/app/(dashboard)/work/today/panels";
import { ScopeDenied } from "@/components/scope-denied";
import { requireResource } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER } from "@/lib/constants/departments";
import { INTERVENTION_ACTION, INTERVENTION_LABEL, getManagerDay, scopeFor } from "@/lib/queries/manager-day";
import { departmentsOfUser } from "@/lib/queries/work";
import { autoAssignOn } from "@/lib/constants/workforce";
import { InfoHint } from "@/components/info-hint";
import { WORK_PRIORITY_LABEL, WORK_PRIORITY_TONE } from "@/lib/constants/work";
import { WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { OVERDUE_CAUSE_ACTION, OVERDUE_CAUSE_LABEL, OVERDUE_DIAGNOSIS_MIN, type OverdueCause, type OverdueDiagnosis } from "@/lib/work/overdue-diagnosis";
import { formatDate, formatVND } from "@/lib/format";
import { param, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Hôm nay" };

/* Hai nguyên nhân mà trưởng phòng KHÔNG tự sửa được bằng một cú giao việc thì tô đậm; còn lại để trung tính — đây là chẩn đoán phòng, không phải xếp hạng. */
const CAUSE_TONE: Record<OverdueCause, string> = {
  NO_STAFF: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  NO_CAPACITY: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  UNCLAIMED: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  CONCENTRATED: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  SPREAD: "bg-muted text-muted-foreground",
  TOO_FEW: "bg-muted text-muted-foreground",
  NONE: "bg-muted text-muted-foreground",
};

function causeDetail(d: OverdueDiagnosis): string {
  const nguon = d.topSource ? ` · nhiều nhất ở ${WORK_SOURCE_SPEC[d.topSource.source as WorkSource]?.label ?? d.topSource.source} (${d.topSource.overdue})` : "";
  switch (d.cause) {
    case "NO_STAFF":
      return d.members === 0 ? "phòng chưa có thành viên" : `cả ${d.members} người đang nghỉ`;
    case "NO_CAPACITY":
      return `${d.unclaimed} việc chưa ai cầm, cả phòng còn ${d.freeSlots} chỗ (${d.present} người)${d.ceilingIsDefault ? " · trần mặc định, chưa khai" : ""}${nguon}`;
    case "UNCLAIMED":
      return `${d.overdueUnclaimed}/${d.overdue} việc quá hạn chưa ai cầm, phòng còn ${d.freeSlots} chỗ`;
    case "CONCENTRATED":
      return d.topHolder ? `${d.topHolder.overdue} việc quá hạn ở tay ${d.topHolder.name} (${Math.round(d.topHolder.share * 100)}% phần đã có người cầm)` : "";
    case "SPREAD":
      return d.present === 1 ? `phòng chỉ có 1 người có mặt, không có ai để chia${nguon}` : `rải ở nhiều người${nguon}`;
    case "TOO_FEW":
      return `${d.overdue} việc quá hạn — dưới ${OVERDUE_DIAGNOSIS_MIN}, đọc từng việc`;
    default:
      return "";
  }
}

/**
 * ═══════ MÀN HÌNH SÁNG — 30 GIÂY ĐỂ BIẾT HÔM NAY PHẢI CHẠM VÀO CÁI GÌ ═══════
 *
 * Bảy khối theo đúng thứ tự người ta hỏi: tồn đọng · quá hạn · chưa ai nhận · tải theo người ·
 * tiền đang treo · việc bị chặn · năm việc phải can thiệp.
 *
 * Khối cuối là khối có giá trị nhất và nó CỐ Ý không phải "năm việc gấp nhất": việc gấp nhất đã
 * nằm đầu hàng đợi và người làm tự thấy. Đây là việc mà **người làm không tự gỡ được** — bị chặn,
 * vỡ hạn lâu chưa ai cầm, hoặc nằm trong tay một người đã quá tải. Cả ba đều cần một quyết định
 * của trưởng phòng.
 */
export default async function ManagerDayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Hàng đợi phòng chứa việc CHƯA GIAO CHO AI — người phạm vi Chỉ của mình / Việc được giao bị từ chối kèm lý do.
  const { user, decision } = await requireResource("WORK", "work:department");
  if (decision.allow === "NONE") return <ScopeDenied title="Hôm nay" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const crossDept = can(user, "work:all");
  const mine = (await departmentsOfUser(user.id)).map((d) => d.code);
  const scope = scopeFor(crossDept, mine, param(raw, "dept", "") ?? "");
  const day = await getManagerDay(scope);
  const canAssign = can(user, "work:assign");

  const nguoiNhan = day.capacity.map((c) => ({ id: c.userId, name: c.name, free: c.free, limit: c.limit, away: Boolean(c.away) }));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Công việc"
        title={`Hôm nay · ${day.label}`}
        description={`${day.backlog} việc đang mở · ${day.overdue} quá hạn · ${day.unassigned} chưa ai nhận`}
        hint="Trang này trả lời một câu: hôm nay phải chạm vào cái gì. Đào sâu một phòng thì mở tab “Phòng ban” — ở đó có toàn bộ hàng đợi và thống kê 30 ngày. Mức leo thang (sắp vỡ hạn / đã vỡ hạn / vỡ hạn lâu chưa ai nhận) được TÍNH LÚC ĐỌC, không ghi vào CSDL, nên nó luôn đúng tới từng giây và không bao giờ ghi đè mức ưu tiên bạn đặt tay."
        actions={
          canAssign && scope ? <AutoAssignButton department={scope} unassigned={day.unassigned} /> : null
        }
      />

      {crossDept ? (
        <div className="flex flex-wrap gap-1.5">
          <Link href="/work/today" className={cn("rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-accent", !scope && "border-primary bg-accent font-medium")}>
            Toàn shop
          </Link>
          {DEPARTMENT_ORDER.map((d) => (
            <Link key={d} href={`/work/today?dept=${d}`} className={cn("rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-accent", scope === d && "border-primary bg-accent font-medium")}>
              {DEPARTMENT_LABEL[d]}
            </Link>
          ))}
        </div>
      ) : null}

      {/*
        PHÒNG CÓ VIỆC MÀ KHÔNG CÓ NGƯỜI — LỖ HỔNG CHẶN MỌI THỨ KHÁC.
        Hiện kể cả khi đang xem phòng khác: nó không được chỉ lộ ra khi vô tình mở đúng phòng đó.
      */}
      {day.emptyDepartments.length ? (
        <div className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          <UserX className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{day.emptyDepartments.length} phòng có việc nhưng chưa có ai</p>
            <p className="text-xs">
              {day.emptyDepartments.map((e) => `${e.label} (${e.open} việc)`).join(" · ")} — không ai trong phòng thì không ai nhận được việc, và máy phân việc cũng
              không có ai để giao. Xếp người ở <Link href="/work/settings" className="underline">Cấu hình → Nhân sự và phòng ban</Link>.
            </p>
          </div>
        </div>
      ) : null}

      {day.failedSources.length ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p className="text-xs">
            Chưa đọc được: {day.failedSources.map((f) => f.source).join(", ")}. Con số bên dưới đang THIẾU phần đó — không phải bằng 0.
          </p>
        </div>
      ) : null}

      {/*
        NĂM Ô, KHÔNG PHẢI SÁU. "Chờ bên ngoài" cố ý KHÔNG có mặt ở dải này: nó là con số duy nhất
        trong nhóm mà trưởng phòng không làm gì được sáng nay, và để nó ở đây chỉ làm loãng năm ô
        còn lại. Nó vẫn đọc được ở bảng tải theo người, cột "Chờ / chặn".
      */}
      <StatStrip
        columns={5}
        items={[
          { label: "Tồn đọng", value: day.backlog, note: "việc đang mở" },
          { label: "Quá hạn", value: day.overdue, tone: day.overdue ? "rose" : "muted", note: "làm trước hết" },
          { label: "Sắp vỡ hạn", value: day.dueSoon, tone: day.dueSoon ? "amber" : "muted", note: "còn cứu được hôm nay", hint: "Đây là con số duy nhất trong dải này mà một hành động HÔM NAY còn đổi được kết quả. Việc đã quá hạn thì hậu quả đã xảy ra rồi." },
          { label: "Chưa ai nhận", value: day.unassigned, tone: day.unassigned ? "amber" : "muted", note: `${day.blocked} việc bị chặn`, hint: "Bị chặn ≠ chờ bên ngoài. Bị chặn là nút thắt NỘI BỘ — gỡ được, và gỡ là việc của trưởng phòng. Số việc đang chờ khách / ĐVVC / ngân hàng nằm ở bảng tải theo người." },
          {
            label: "Tiền đang treo",
            value: day.money.known ? formatVND(day.money.atRisk, { compact: true }) : "—",
            note: day.money.unknown ? `${day.money.unknown} việc chưa tra được` : "đã tra được hết",
          },
        ]}
      />

      {/*
        BA VIỆC LIÊN PHÒNG — chỉ ở chế độ toàn shop. Trong một phòng, "việc đáng làm nhất" đã là đầu
        hàng đợi của phòng đó; khối này trả lời câu mà không hàng đợi phòng nào trả lời được.
      */}
      {day.morning ? (
        <SectionCard
          title="Ba việc đáng làm nhất sáng nay"
          description={`Mỗi phòng một đầu việc, xếp giữa ${day.morning.departmentsWithWork} phòng đang có việc làm được ngay.`}
          hint={
            <>
              <p className="mb-1">
                Mỗi phòng góp ĐẦU VIỆC của mình (đúng thứ tự leo thang của hàng đợi phòng đó), rồi xếp giữa các phòng: mức gấp trước, cùng mức thì tiền đang treo lớn hơn
                đứng trước. Không lấy ba việc điểm cao nhất toàn shop, vì phòng sinh nhiều việc nhất sẽ chiếm cả ba ô.
              </p>
              <p className="mb-1">Tiền chưa tra được không phải 0 đồng — nhưng không so được, nên nó đứng sau các việc cùng mức có số tiền, và dòng đó ghi rõ lý do.</p>
              Việc đang chờ bên ngoài và việc đang hoãn (chưa vỡ hạn) không được xét: sáng nay không ai trong shop làm gì được với chúng. Khối này chỉ ĐỀ NGHỊ — không giao
              việc cho ai.
            </>
          }
          padded={false}
        >
          {day.morning.picks.length ? (
            <ul className="divide-y">
              {day.morning.picks.map((p) => (
                <li key={p.item.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold tabular-nums">{p.rank}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[11px]">{p.departmentLabel}</Badge>
                      <Badge variant="secondary" className={cn("text-[11px]", WORK_PRIORITY_TONE[p.priority])}>{p.escalation?.label ?? WORK_PRIORITY_LABEL[p.priority]}</Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {WORK_SOURCE_SPEC[p.item.sourceType as WorkSource]?.label ?? p.item.sourceType} · đầu {p.departmentActionable} việc của phòng
                      </span>
                    </div>
                    <Link href={p.item.sourceUrl || "/work/all"} className="mt-1 block truncate text-sm font-medium hover:underline" title={p.item.title}>
                      {p.item.title}
                    </Link>
                    {p.item.recommendedAction ? <p className="text-xs text-foreground/80">→ {p.item.recommendedAction}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                    <span className="whitespace-nowrap text-xs tabular-nums" title={p.item.money.basis || undefined}>
                      {p.moneyAtRisk === null ? <span className="text-muted-foreground">chưa tra được tiền</span> : `${formatVND(p.moneyAtRisk, { compact: true })} đang treo`}
                    </span>
                    {p.rankedWithoutMoney ? <span className="text-[11px] text-muted-foreground">xếp sau vì chưa biết tiền</span> : null}
                    <span className="text-[11px] text-muted-foreground">{p.item.assignee ? p.item.assignee.name : "chưa ai nhận"}</span>
                    {canAssign ? <ReassignSelect workKey={p.item.key} current={p.item.assignee?.name ?? ""} people={nguoiNhan} /> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Không phòng nào có việc làm được ngay" description="Mọi việc đang mở đều đang chờ bên ngoài hoặc đang hoãn." className="border-0" />
          )}
          {day.morning.skipped.waiting || day.morning.skipped.snoozed ? (
            <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
              Không xét {day.morning.skipped.waiting} việc đang chờ bên ngoài · {day.morning.skipped.snoozed} việc đang hoãn chưa tới hạn.
            </p>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard
        title={`Ai quá tải, ai còn chỗ · ${day.overloaded} quá tải · còn ${day.freeSlots} chỗ trống`}
        description="Quá tải = vượt trần HOẶC quá nửa việc đang cầm đã vỡ hạn — một người 6 việc mà 4 việc quá hạn đang chìm, dù còn xa trần."
        hint="Trần việc là con số KHAI BÁO ở Cấu hình → Sức chứa, không phải số đo. Nó tồn tại để khi hết chỗ thì máy phân việc DỪNG và báo thiếu người, thay vì nhồi cho hết rồi làm hỏng mọi thước đo của người nhận."
        padded={false}
      >
        {day.capacity.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Người</TableHead>
                  <TableHead className="w-[130px]">Đang cầm</TableHead>
                  <TableHead className="w-[90px] text-right">Quá hạn</TableHead>
                  <TableHead className="w-[110px] text-right">Chờ / chặn</TableHead>
                  <TableHead className="w-[130px] text-right">Tiền đang giữ</TableHead>
                  <TableHead className="w-[150px]">Nhận loại việc</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {day.capacity.map((c) => (
                  <TableRow key={c.userId} className={cn(c.overloaded && "bg-rose-50/60 dark:bg-rose-950/20")}>
                    <TableCell>
                      <p className="font-medium">{c.name}</p>
                      <p className="text-[11px] text-muted-foreground">{c.departments.map((d) => DEPARTMENT_LABEL[d]).join(", ") || "chưa xếp phòng"}</p>
                    </TableCell>
                    <TableCell>
                      <span className={cn("tabular-nums", c.over > 0 && "font-semibold text-destructive")}>
                        {c.load}/{c.limit}
                      </span>
                      {c.away ? (
                        <Badge variant="secondary" className="ml-1.5 text-[10px]">nghỉ tới {formatDate(c.away.until)}</Badge>
                      ) : c.overloaded ? (
                        <Badge variant="secondary" className="ml-1.5 bg-rose-100 text-[10px] text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">quá tải</Badge>
                      ) : c.nearFull ? (
                        <Badge variant="secondary" className="ml-1.5 bg-amber-50 text-[10px] text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">sắp đầy</Badge>
                      ) : (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">còn {c.free}</span>
                      )}
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums", c.overdue && "font-semibold text-destructive")}>{c.overdue}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{c.waiting} / {c.blocked}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.money.known ? formatVND(c.money.atRisk, { compact: true }) : "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.skills.length ? `${c.skills.length} loại đã khai` : "mọi loại của phòng"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title={scope ? `${DEPARTMENT_LABEL[scope]} chưa có thành viên nào` : "Chưa ai được xếp vào phòng ban"}
            description="Hàng đợi chỉ chảy khi người dùng thuộc một phòng. Xếp người ở Cấu hình → Nhân sự và phòng ban."
            className="border-0"
          />
        )}
      </SectionCard>

      {day.diagnosis.some((d) => d.overdue > 0) ? (
        <SectionCard
          title="Vì sao quá hạn"
          description="Cùng một con số quá hạn có bốn nguyên nhân, và cách sửa của cái này làm hỏng cái kia."
          hint={
            <>
              <p className="mb-1">
                <b>Phòng hết chỗ</b>: việc chưa ai cầm nhiều hơn tổng chỗ trống của mọi người đang có mặt — thiếu người (hoặc trần khai thấp hơn sức thật). <b>Còn chỗ, chưa ai
                nhận</b>: phần lớn việc quá hạn nằm ở hàng đợi chung trong khi phòng còn chỗ — sửa bằng phân việc, không phải tuyển người. <b>Dồn ở một người</b>: phần lớn
                việc quá hạn ở tay một người trong khi người khác còn chỗ — chia lại. <b>Chậm đều cả phòng</b>: quá hạn rải ở nhiều người — xem lại hạn hoặc quy trình.
              </p>
              <p className="mb-1">
                &quot;Dồn ở một người&quot; nói việc ĐANG NẰM Ở ĐÂU, không nói ai làm kém: ERP không có dữ liệu để phân biệt người chậm với người chịu nhận việc khó.
              </p>
              Chỗ trống tính theo TRẦN KHAI BÁO (Cấu hình → Sức chứa). Phòng chưa khai trần riêng dùng mặc định, nên kết luận &quot;hết chỗ&quot; của phòng đó là ước tính.
            </>
          }
          padded={false}
        >
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">Phòng</TableHead>
                  <TableHead className="w-[80px] text-right">Quá hạn</TableHead>
                  <TableHead className="w-[110px] text-right">Chưa ai cầm</TableHead>
                  <TableHead className="w-[100px] text-right">Chỗ trống</TableHead>
                  <TableHead>Nguyên nhân</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {day.diagnosis
                  .filter((d) => d.overdue > 0)
                  .map((d) => (
                    <TableRow key={d.department}>
                      <TableCell className="font-medium">{d.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.overdue}</TableCell>
                      <TableCell className="text-right tabular-nums" title="Quá hạn chưa ai cầm / mọi việc đang mở chưa ai cầm">
                        {d.overdueUnclaimed} / {d.unclaimed}
                      </TableCell>
                      <TableCell className="text-right tabular-nums" title={`${d.present}/${d.members} người đang có mặt`}>
                        {d.freeSlots}
                        {d.ceilingIsDefault ? <span className="ml-1 text-[10px] text-muted-foreground">ước tính</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="secondary" className={cn("text-[11px]", CAUSE_TONE[d.cause])}>{OVERDUE_CAUSE_LABEL[d.cause]}</Badge>
                          <span className="text-xs text-muted-foreground">{causeDetail(d)}</span>
                          {OVERDUE_CAUSE_ACTION[d.cause] ? <InfoHint>{OVERDUE_CAUSE_ACTION[d.cause]}</InfoHint> : null}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Năm việc cần can thiệp ngay"
        description="KHÔNG phải năm việc gấp nhất — đó đã ở đầu hàng đợi. Đây là việc người làm không tự gỡ được."
        padded={false}
      >
        {day.interventions.length ? (
          <ul className="divide-y">
            {day.interventions.map((it) => (
              <li key={it.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className={cn("text-[11px]", it.kind === "BLOCKED" || it.kind === "NO_DEPARTMENT_STAFF" ? "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300")}>
                      {it.kind === "BLOCKED" ? <Ban className="mr-0.5 size-3" /> : <Clock className="mr-0.5 size-3" />}
                      {INTERVENTION_LABEL[it.kind]}
                    </Badge>
                    {!scope ? <Badge variant="outline" className="text-[11px]">{DEPARTMENT_LABEL[it.department]}</Badge> : null}
                    <span className="text-[11px] text-muted-foreground">{it.sourceLabel}</span>
                  </div>
                  <Link href={it.url || "/work/all"} className="mt-1 block truncate text-sm font-medium hover:underline" title={it.title}>
                    {it.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">{it.detail}</p>
                  {/* VIỆC NÊN LÀM, không chỉ nêu vấn đề: một danh sách vấn đề không kèm lối ra là một danh sách bị bỏ qua. */}
                  <p className="mt-0.5 text-xs text-foreground/80">→ {INTERVENTION_ACTION[it.kind]}</p>
                </div>
                <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                  <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                    {it.moneyAtRisk === null ? "chưa tra được tiền" : formatVND(it.moneyAtRisk, { compact: true })}
                  </span>
                  {canAssign ? <ReassignSelect workKey={it.key} current={it.holder} people={nguoiNhan} /> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Không việc nào cần bạn can thiệp" description="Không có việc bị chặn, không việc nào vỡ hạn lâu mà chưa ai cầm, và không ai đang quá tải." className="border-0" />
        )}
      </SectionCard>

      <SectionCard title="Tồn đọng theo nguồn việc" description="Nguồn nào đang dồn lại, và bao nhiêu phần trong đó chưa có người." padded={false}>
        {day.bySource.length ? (
          <div className="overflow-x-auto">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Nguồn việc</TableHead>
                  <TableHead className="w-[100px] text-right">Đang mở</TableHead>
                  <TableHead className="w-[100px] text-right">Quá hạn</TableHead>
                  <TableHead className="w-[130px] text-right">Chưa ai nhận</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {day.bySource.map((s) => (
                  <TableRow key={s.source}>
                    <TableCell className="font-medium">{s.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.open}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", s.overdue && "font-semibold text-destructive")}>{s.overdue}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.unassigned}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Không còn việc nào đang mở" className="border-0" />
        )}
      </SectionCard>

      {scope && !autoAssignOn(scope, day.cfg) ? (
        <p className="text-xs text-muted-foreground">
          Phân việc tự động của {DEPARTMENT_LABEL[scope]} đang <strong>tắt</strong> — nút ở trên vẫn chạy được khi bạn bấm, và nó luôn cho xem trước.
          Bật chạy nền cho phòng này ở <Link href="/work/settings" className="underline">Cấu hình → Sức chứa và phân việc</Link>.
          <Link href="/work/department" className="ml-1 underline">Xem hàng đợi đầy đủ <ArrowRight className="inline size-3" /></Link>
        </p>
      ) : null}
    </div>
  );
}
