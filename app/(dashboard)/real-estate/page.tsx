import Link from "next/link";
import { ReProjectForm, ReUnitActions, ReUnitsBulkForm } from "@/components/real-estate/re-forms";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { RE_UNIT_STATE_LABEL, RE_UNIT_STATES, type ReUnitState } from "@/lib/constants/real-estate";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { listReProjects, myLiveHolds, reBoard } from "@/lib/queries/real-estate";

export const metadata = { title: "Bảng hàng BĐS" };

/**
 * BẢNG HÀNG BẤT ĐỘNG SẢN (module `real_estate`, 0201 · docs/verticals/real-estate.md) — căn tôi đang giữ, bảng hàng theo dự án
 * (lọc theo trạng thái), thao tác giữ chỗ / cọc / ký bán / khoá theo đúng quyền, quản lý dự án và thêm căn.
 */

const TONE: Record<ReUnitState, string> = {
  AVAILABLE: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100",
  HELD: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100",
  DEPOSITED: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100",
  SOLD: "border-muted bg-muted text-muted-foreground",
  LOCKED: "border-dashed border-muted-foreground/40 text-muted-foreground",
};

const left = (min: number) => (min >= 60 ? `còn ${Math.floor(min / 60)} giờ ${min % 60} phút` : `còn ${min} phút`);

export default async function RealEstatePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("real_estate:view");
  const sp = await searchParams;
  const canHold = can(user, "real_estate:hold");
  const canManage = can(user, "real_estate:manage");
  const projectParam = typeof sp["du-an"] === "string" ? sp["du-an"] : null;
  const filter = RE_UNIT_STATES.find((s) => s === sp["trang-thai"]) ?? null;
  const [projects, board, mine] = await Promise.all([listReProjects(), reBoard(projectParam, { userId: user.id, manager: canManage }), canHold ? myLiveHolds(user.id) : Promise.resolve([])]);
  const units = filter ? board.units.filter((u) => u.state === filter) : board.units;
  const base = board.project ? `/real-estate?du-an=${board.project.id}` : "/real-estate";
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Bất động sản"
        title="Bảng hàng"
        description={board.project ? `${board.project.name} · ${board.units.length} căn · giữ chỗ tối đa ${board.project.holdHours} giờ` : "Chưa có dự án"}
        hint="Mỗi căn nhiều nhất MỘT lượt giữ chỗ và MỘT khoản cọc còn hiệu lực — sale khác không giữ trùng được. Giữ chỗ quá hạn tự trở về còn trống. Khách của lượt giữ / cọc chỉ hiện cho chính sale đó và quản lý. Giá trống nghĩa là chưa công bố."
      />

      {mine.length ? (
        <SectionCard title={`Căn tôi đang giữ · ${mine.length}`} description="Sắp hết hạn trước — cọc hoặc nhả trước khi hết giờ.">
          <ul className="divide-y text-sm" data-re-my-holds={mine.length}>
            {mine.map((h) => (
              <li key={h.holdId} className="py-1.5">
                <b>{h.unitCode}</b> · {h.projectName} · {h.customerName} · <span className={h.minutesLeft < 120 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}>{left(h.minutesLeft)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {projects.length > 1 ? (
        <nav className="flex flex-wrap gap-1 text-sm" aria-label="Dự án">
          {projects.map((p) => (
            <Link key={p.id} href={`/real-estate?du-an=${p.id}`} className={`rounded-md border px-2 py-0.5 ${p.id === board.project?.id ? "border-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}>
              {p.code} · {p.name}
              {p.active ? "" : " (ngưng)"}
            </Link>
          ))}
        </nav>
      ) : null}

      {board.project ? (
        <>
          <nav className="flex flex-wrap gap-1 text-sm" aria-label="Lọc trạng thái" data-re-counts>
            <Link href={base} className={`rounded-md border px-2 py-0.5 ${!filter ? "border-primary font-medium" : "text-muted-foreground"}`}>
              Tất cả · {board.units.length}
            </Link>
            {RE_UNIT_STATES.map((s) => (
              <Link key={s} href={`${base}&trang-thai=${s}`} className={`rounded-md border px-2 py-0.5 ${filter === s ? "border-primary font-medium" : "text-muted-foreground"}`}>
                {RE_UNIT_STATE_LABEL[s]} · {board.counts[s]}
              </Link>
            ))}
          </nav>

          <SectionCard title="Sơ đồ căn" description="Màu theo trạng thái.">
            {board.units.length ? (
              <div className="flex flex-wrap gap-1" data-re-map={board.units.length}>
                {board.units.map((u) => (
                  <span key={u.id} title={`${u.code} · ${RE_UNIT_STATE_LABEL[u.state]}`} className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${TONE[u.state]}`}>
                    {u.code}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Dự án chưa có căn nào.</p>
            )}
          </SectionCard>

          <SectionCard title={filter ? `Căn «${RE_UNIT_STATE_LABEL[filter]}»` : "Danh sách căn"}>
            {units.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-re-units={units.length}>
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3">Căn</th>
                      <th className="py-1 pr-3 text-right">Diện tích</th>
                      <th className="py-1 pr-3 text-right">Giá niêm yết</th>
                      <th className="py-1 pr-3">Trạng thái</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {units.map((u) => (
                      <tr key={u.id} className="border-t align-top">
                        <td className="py-1 pr-3">
                          <b className="font-mono">{u.code}</b>
                          <span className="text-xs text-muted-foreground">{[u.block, u.floor ? `tầng ${u.floor}` : ""].filter(Boolean).map((x) => ` · ${x}`).join("")}</span>
                        </td>
                        <td className="py-1 pr-3 text-right">{u.areaM2 === null ? "—" : `${formatNumber(u.areaM2)} m²`}</td>
                        <td className="py-1 pr-3 text-right">{formatVND(u.listPrice)}</td>
                        <td className="py-1 pr-3 text-xs">
                          <span className={`rounded border px-1.5 py-0.5 ${TONE[u.state]}`}>{RE_UNIT_STATE_LABEL[u.state]}</span>
                          {u.hold ? (
                            <div className="mt-0.5 text-muted-foreground">
                              {u.hold.saleName} · {left(u.hold.minutesLeft)}
                              {u.hold.customerName ? ` · ${u.hold.customerName}` : ""}
                            </div>
                          ) : null}
                          {u.deposit ? (
                            <div className="mt-0.5 text-muted-foreground">
                              {u.deposit.saleName} · cọc {formatVND(u.deposit.amount)} · {formatDateTime(u.deposit.depositedAt)}
                              {u.deposit.customerName ? ` · ${u.deposit.customerName}` : ""}
                            </div>
                          ) : null}
                          {u.lockedReason ? <div className="mt-0.5 text-muted-foreground">{u.lockedReason}</div> : null}
                          {u.soldContract ? <div className="mt-0.5 text-muted-foreground">HĐ {u.soldContract}</div> : null}
                        </td>
                        <td className="py-1 text-right">{canHold || canManage ? <ReUnitActions unit={{ id: u.id, state: u.state, hold: u.hold ? { id: u.hold.id, mine: u.hold.mine } : null, deposit: u.deposit ? { id: u.deposit.id } : null }} canHold={canHold} canManage={canManage} /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="Không có căn nào ở trạng thái này" />
            )}
          </SectionCard>

          {canManage ? (
            <SectionCard title="Thêm căn" description="Mỗi dòng một căn: mã | toà/khu | tầng | diện tích m² | giá niêm yết. Chỉ mã là bắt buộc; dòng hỏng / mã trùng thì không thêm gì.">
              <ReUnitsBulkForm projectId={board.project.id} />
            </SectionCard>
          ) : null}
        </>
      ) : (
        <EmptyState title="Chưa có dự án nào" description={canManage ? "Tạo dự án ở khung bên dưới." : "Quản lý sàn chưa tạo dự án."} />
      )}

      {canManage ? (
        <SectionCard title="Tạo dự án" description="Số giờ giữ chỗ là chính sách của chủ đầu tư / sàn — bắt buộc khai, không có mặc định.">
          <ReProjectForm />
        </SectionCard>
      ) : null}
    </div>
  );
}
