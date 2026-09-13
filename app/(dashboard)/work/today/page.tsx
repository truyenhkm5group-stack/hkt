import Link from "next/link";
import { AlertTriangle, ArrowRight, Ban, Clock, UserX } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AutoAssignButton, ReassignSelect } from "@/app/(dashboard)/work/today/panels";
import { can, requirePermission } from "@/lib/auth/session";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER } from "@/lib/constants/departments";
import { INTERVENTION_ACTION, INTERVENTION_LABEL, getManagerDay, scopeFor } from "@/lib/queries/manager-day";
import { departmentsOfUser } from "@/lib/queries/work";
import { autoAssignOn } from "@/lib/constants/workforce";
import { formatDate, formatVND } from "@/lib/format";
import { param, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Hôm nay" };

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
  const user = await requirePermission("work:department");
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
