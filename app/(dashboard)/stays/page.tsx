import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { StayBookingForm, StayCancelButton, StayDetailsEditor, StayFeedLinks, StayIcsImport, StayTurnoverButton, StayUnitForm } from "@/components/stays/stays-forms";
import { can, requirePermission } from "@/lib/auth/session";
import { STAY_CHANNEL_LABEL, stayNights, type StayChannel } from "@/lib/constants/stays";
import { env } from "@/lib/env";
import { formatDateTime, formatNumber, formatPercent, formatVND, todayVN } from "@/lib/format";
import { listStayUnits, recentStayImports, stayBoard, stayOwnerReport, type StayBookingView } from "@/lib/queries/stays";
import { stayFeedPath } from "@/lib/stays/feed";

export const metadata = { title: "Lịch phòng" };

/**
 * LƯU TRÚ NGẮN NGÀY (module `stays`, 0198 · docs/verticals/homestay.md) — ba thẻ:
 *  · Lịch: trùng phòng (đỏ, đầu trang), khách nhận / trả / đang ở hôm nay, dọn phòng hôm nay + mai, lưới 14 đêm, đặt tay.
 *  · Phòng & kênh: thêm / sửa phòng, đường dẫn lịch .ics phát cho từng kênh, nhập lịch kênh (chạy thử trước), sổ nhập.
 *  · Chủ nhà: theo tháng — đêm bán / khoá, lấp đầy, doanh thu ĐÃ BIẾT + số lượt chưa ghi tiền.
 */

const TABS = [
  { key: "lich", label: "Lịch" },
  { key: "phong", label: "Phòng & kênh" },
  { key: "chu-nha", label: "Chủ nhà" },
] as const;

const showDay = (d: string) => d.split("-").reverse().join("/");
const dayHead = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return { dow: w === 0 ? "CN" : `T${w + 1}`, dm: `${d.slice(8, 10)}/${d.slice(5, 7)}` };
};
const channelLabel = (c: string) => STAY_CHANNEL_LABEL[c as StayChannel] ?? c;

function guestLine(b: StayBookingView): string {
  if (b.status === "BLOCKED") return b.source === "ICAL" ? `Khoá từ lịch ${channelLabel(b.channel)}` : "Khoá ngày";
  return [b.guestName || b.summary || "Khách chưa ghi tên", b.guestPhone, b.guests ? `${b.guests} khách` : ""].filter(Boolean).join(" · ");
}

export default async function StaysPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("stays:view");
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "lich";
  const today = todayVN();
  const canWrite = can(user, "stays:write");
  const units = await listStayUnits();
  const activeUnits = units.filter((u) => u.active);
  const unitName = new Map(units.map((u) => [u.id, `${u.code} · ${u.name}`]));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Lưu trú"
        title="Lịch phòng"
        description={`${activeUnits.length} phòng đang cho thuê`}
        hint="Gộp lịch Airbnb / Booking / Agoda bằng tệp lịch .ics và phát lịch của ERP cho từng kênh để kênh tự khoá ngày. Lượt nhập từ lịch kênh chỉ kênh đổi được ngày / huỷ; ERP bổ sung tên khách, SĐT, tiền. Tiền để trống nghĩa là chưa biết, không phải 0."
      />
      <nav className="flex flex-wrap gap-1 border-b text-sm" aria-label="Thẻ lịch phòng">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key === "lich" ? "/stays" : `/stays?tab=${t.key}`} className={`-mb-px border-b-2 px-3 py-1.5 ${tab === t.key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "lich" ? <CalendarTab today={today} canWrite={canWrite} unitName={unitName} hasUnits={activeUnits.length > 0} /> : null}
      {tab === "phong" ? <UnitsTab units={units} canWrite={canWrite} orgCode={user.organization?.code ?? null} unitName={unitName} /> : null}
      {tab === "chu-nha" ? <OwnerTab month={typeof sp.thang === "string" && /^\d{4}-\d{2}$/.test(sp.thang) ? sp.thang : today.slice(0, 7)} /> : null}
    </div>
  );
}

async function CalendarTab({ today, canWrite, unitName, hasUnits }: { today: string; canWrite: boolean; unitName: Map<string, string>; hasUnits: boolean }) {
  if (!hasUnits)
    return (
      <EmptyState
        title="Chưa có phòng nào"
        description={
          <>
            Thêm phòng ở thẻ{" "}
            <Link href="/stays?tab=phong" className="underline">
              Phòng & kênh
            </Link>
            .
          </>
        }
      />
    );
  const board = await stayBoard(today);
  const name = (id: string) => unitName.get(id) ?? id;
  return (
    <>
      {board.conflicts.length ? (
        <SectionCard title={`Trùng phòng · ${board.conflicts.length}`} description="Hai lượt cùng giữ một phòng một đêm — xử lý trên kênh (huỷ / chuyển phòng) trước khi khách tới." className="border-red-300 dark:border-red-800">
          <ul className="divide-y text-sm text-red-700 dark:text-red-300" data-stay-conflicts={board.conflicts.length}>
            {board.conflicts.map((c) => (
              <li key={`${c.a.id}-${c.b.id}`} className="py-1.5">
                <b>{name(c.unitId)}</b>: {channelLabel(c.a.channel)} {showDay(c.a.checkIn)}→{showDay(c.a.checkOut)} ({guestLine(c.a)}) ⟷ {channelLabel(c.b.channel)} {showDay(c.b.checkIn)}→{showDay(c.b.checkOut)} ({guestLine(c.b)})
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <TodayList title="Nhận phòng hôm nay" rows={board.arrivals} name={name} empty="Không có khách nhận phòng" />
        <TodayList title="Trả phòng hôm nay" rows={board.departures} name={name} empty="Không có khách trả phòng" />
        <TodayList title="Đang ở" rows={board.inHouse} name={name} empty="Không có khách đang ở" />
      </div>

      <SectionCard title="Dọn phòng" description="Phòng có khách trả hôm nay và ngày mai. «Có khách nhận cùng ngày» là việc gấp nhất — phải xong trước giờ nhận.">
        {board.turnovers.length ? (
          <ul className="divide-y text-sm" data-stay-turnovers={board.turnovers.length}>
            {board.turnovers.map((t) => (
              <li key={`${t.unitId}-${t.day}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  <b>{name(t.unitId)}</b> · {t.day === board.today ? "hôm nay" : "ngày mai"}
                  {t.sameDayArrival ? <span className="text-amber-700 dark:text-amber-300"> · có khách nhận cùng ngày</span> : null}
                  {t.doneByName ? <span className="text-emerald-700 dark:text-emerald-300"> · đã dọn ({t.doneByName})</span> : null}
                </span>
                {canWrite ? <StayTurnoverButton unitId={t.unitId} day={t.day} done={t.doneByName !== null} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Không có phòng phải dọn hôm nay và ngày mai.</p>
        )}
      </SectionCard>

      <SectionCard title="Lịch 14 đêm" description="Mỗi ô là một đêm. Ô đỏ = trùng phòng; ô gạch = ngày khoá.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-xs" data-stay-grid>
            <thead>
              <tr>
                <th className="sticky left-0 bg-card px-2 py-1 text-left font-medium">Phòng</th>
                {board.days.map((d) => {
                  const h = dayHead(d);
                  return (
                    <th key={d} className={`px-1 py-1 text-center font-normal ${d === board.today ? "text-primary" : "text-muted-foreground"}`}>
                      {h.dow}
                      <br />
                      {h.dm}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {board.units.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="sticky left-0 bg-card px-2 py-1 font-medium">{u.code}</td>
                  {u.cells.map((c, i) => {
                    const d = board.days[i];
                    if (c.kind === "FREE") return <td key={d} className="h-7 border-l" />;
                    if (c.kind === "CONFLICT") return <td key={d} className="h-7 border-l bg-red-200 text-center text-red-900 dark:bg-red-900/60 dark:text-red-100" title="Trùng phòng">!</td>;
                    const b = board.bookings[c.bookingId];
                    if (c.kind === "BLOCKED")
                      return <td key={d} className="h-7 border-l bg-muted bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(127,127,127,0.25)_3px,rgba(127,127,127,0.25)_6px)]" title={b ? guestLine(b) : "Khoá ngày"} />;
                    return (
                      <td key={d} className="h-7 truncate border-l bg-primary/15 px-1 text-[11px]" title={b ? `${channelLabel(b.channel)} · ${guestLine(b)}` : undefined}>
                        {c.start && b ? channelLabel(b.channel).slice(0, 3) : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {canWrite ? (
        <SectionCard title="Đặt phòng / khoá ngày">
          <StayBookingForm units={board.units.map((u) => ({ id: u.id, name: u.name, code: u.code }))} today={board.today} />
        </SectionCard>
      ) : null}

      <SectionCard title="Sắp tới" description="Lượt đang ở và sắp tới trong 90 ngày.">
        {board.upcoming.length ? (
          <ul className="divide-y text-sm" data-stay-upcoming={board.upcoming.length}>
            {board.upcoming.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  <b>{name(b.unitId)}</b> · {showDay(b.checkIn)} → {showDay(b.checkOut)} ({stayNights(b.checkIn, b.checkOut)} đêm) · {channelLabel(b.channel)} — {guestLine(b)}
                  {b.status === "CONFIRMED" ? <span className="text-muted-foreground"> · {b.amountVnd === null ? "chưa ghi tiền" : formatVND(b.amountVnd)}</span> : null}
                  {b.note ? <span className="text-muted-foreground"> · {b.note}</span> : null}
                </span>
                {canWrite ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {b.status === "CONFIRMED" ? <StayDetailsEditor booking={b} /> : null}
                    {b.source === "MANUAL" ? <StayCancelButton id={b.id} label={b.status === "BLOCKED" ? "Mở lại ngày" : "Huỷ lượt"} /> : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có lượt nào sắp tới.</p>
        )}
      </SectionCard>
    </>
  );
}

function TodayList({ title, rows, name, empty }: { title: string; rows: StayBookingView[]; name: (id: string) => string; empty: string }) {
  return (
    <SectionCard title={`${title} · ${rows.length}`}>
      {rows.length ? (
        <ul className="divide-y text-sm">
          {rows.map((b) => (
            <li key={b.id} className="py-1.5">
              <b>{name(b.unitId)}</b> — {guestLine(b)}
              <span className="text-muted-foreground"> · {channelLabel(b.channel)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </SectionCard>
  );
}

async function UnitsTab({ units, canWrite, orgCode, unitName }: { units: Awaited<ReturnType<typeof listStayUnits>>; canWrite: boolean; orgCode: string | null; unitName: Map<string, string> }) {
  const imports = await recentStayImports();
  const base = env.appUrl.replace(/\/+$/, "");
  const feedChannels: StayChannel[] = ["AIRBNB", "BOOKING", "AGODA"];
  return (
    <>
      {canWrite ? (
        <SectionCard title="Thêm phòng">
          <StayUnitForm />
        </SectionCard>
      ) : null}
      <SectionCard title="Phòng" description="Đường dẫn lịch: dán vào mục «Nhập lịch / Sync calendar» của từng kênh để kênh tự khoá ngày đã bán ở nơi khác. Lịch chỉ mang ngày, không mang tên / SĐT khách.">
        {units.length ? (
          <ul className="divide-y" data-stay-units={units.length}>
            {units.map((u) => (
              <li key={u.id} className="space-y-2 py-3">
                <div className="text-sm">
                  <b>
                    {u.code} · {u.name}
                  </b>
                  {u.active ? null : <span className="text-muted-foreground"> · ngưng cho thuê</span>}
                  {u.capacity ? <span className="text-muted-foreground"> · {u.capacity} khách</span> : null}
                  {u.ownerName ? <span className="text-muted-foreground"> · chủ nhà {u.ownerName}</span> : null}
                  {u.address ? <span className="text-muted-foreground"> · {u.address}</span> : null}
                </div>
                {canWrite && orgCode && u.active ? <StayFeedLinks unitId={u.id} links={feedChannels.map((c) => ({ channel: c, url: `${base}${stayFeedPath(orgCode, u.icalToken, c)}` }))} /> : null}
                {canWrite ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-xs text-muted-foreground">Sửa phòng</summary>
                    <div className="pt-2">
                      <StayUnitForm unit={u} />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Chưa có phòng nào" description={canWrite ? "Thêm phòng ở khung phía trên." : undefined} />
        )}
      </SectionCard>
      {canWrite && units.some((u) => u.active) ? (
        <SectionCard title="Nhập lịch của kênh" description="Tải tệp lịch .ics từ Airbnb (Lịch → Đồng bộ lịch → Xuất lịch), Booking.com, Agoda… Chạy thử trước; lượt đặt kênh đã bỏ khỏi lịch sẽ được huỷ, lượt đã qua giữ nguyên.">
          <StayIcsImport units={units.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, code: u.code }))} />
        </SectionCard>
      ) : null}
      <SectionCard title="Sổ nhập lịch" description="20 lượt gần nhất, kể cả chạy thử.">
        {imports.length ? (
          <ul className="divide-y text-xs" data-stay-imports={imports.length}>
            {imports.map((i) => (
              <li key={i.id} className="py-1">
                {formatDateTime(i.createdAt)} · {unitName.get(i.unitId) ?? i.unitId} · {channelLabel(i.channel)} · {i.applied ? "nhập thật" : "chạy thử"} · {i.events} sự kiện: {i.created} mới, {i.updated} đổi, {i.cancelled} huỷ, {i.unchanged} giữ nguyên
                {i.skipped ? `, ${i.skipped} dòng hỏng` : ""} · {i.byName || "—"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa nhập lịch lần nào.</p>
        )}
      </SectionCard>
    </>
  );
}

async function OwnerTab({ month }: { month: string }) {
  const report = await stayOwnerReport(month);
  const [y, m] = month.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  return (
    <SectionCard
      title={`Báo cáo chủ nhà · tháng ${m}/${y}`}
      description="Doanh thu tính theo ngày nhận phòng, chỉ cộng lượt ĐÃ ghi tiền; lượt chưa ghi tiền đếm riêng. Lấp đầy = đêm đã bán / (đêm trong tháng − đêm khoá)."
      actions={
        <span className="flex gap-2 text-sm">
          <Link href={`/stays?tab=chu-nha&thang=${prev}`} className="hover:underline">
            ← Tháng trước
          </Link>
          <Link href={`/stays?tab=chu-nha&thang=${next}`} className="hover:underline">
            Tháng sau →
          </Link>
        </span>
      }
    >
      {report.rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-stay-owner-report={report.rows.length}>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Chủ nhà</th>
                <th className="py-1 pr-3">Phòng</th>
                <th className="py-1 pr-3 text-right">Lượt</th>
                <th className="py-1 pr-3 text-right">Đêm bán</th>
                <th className="py-1 pr-3 text-right">Đêm khoá</th>
                <th className="py-1 pr-3 text-right">Lấp đầy</th>
                <th className="py-1 pr-3 text-right">Doanh thu đã biết</th>
                <th className="py-1 text-right">Chưa ghi tiền</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.unitId} className="border-t">
                  <td className="py-1 pr-3">{r.ownerName || "—"}</td>
                  <td className="py-1 pr-3">
                    {r.unitCode} · {r.unitName}
                  </td>
                  <td className="py-1 pr-3 text-right">{formatNumber(r.stays)}</td>
                  <td className="py-1 pr-3 text-right">{formatNumber(r.soldNights)}</td>
                  <td className="py-1 pr-3 text-right">{formatNumber(r.blockedNights)}</td>
                  <td className="py-1 pr-3 text-right">{formatPercent(r.occupancy === null ? null : r.occupancy * 100)}</td>
                  <td className="py-1 pr-3 text-right">{formatVND(r.revenueKnownVnd)}</td>
                  <td className="py-1 text-right">{r.missingAmount ? `${r.missingAmount} lượt` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="Chưa có phòng nào" />
      )}
    </SectionCard>
  );
}
