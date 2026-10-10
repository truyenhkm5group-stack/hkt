import Link from "next/link";
import { TenantValueTable } from "@/components/platform/tenant-value-table";
import { SectionCard } from "@/components/ui-bits";
import { TENANT_VALUE_DEFAULT_DECISIONS, TENANT_VALUE_IMPACT_LABEL, TENANT_VALUE_WINDOWS, type TenantValueDecisionId } from "@/lib/constants/tenant-value-metrics";
import { formatDate, formatDateTime } from "@/lib/format";
import type { TenantValueBoard } from "@/lib/saas/tenant-value-read";
import { provisionalDecisionsOf } from "@/lib/saas/tenant-value-view";
import { cn } from "@/lib/utils";

/**
 * KHỐI «GIÁ TRỊ KHÁCH HÀNG» — đầu trang /platform/saas. Thành phần máy chủ, nhận ẢNH CHỤP đã đọc (`readTenantValueBoard`), không
 * tự đọc gì: không mở CSDL tổ chức, không gọi lượt chụp (tests/saas-value-ui.test.ts quét). Vắng ảnh hôm nay ⇒ nói thẳng và hiện
 * ảnh gần nhất — không tự chụp.
 */

/** Tám câu hỏi kinh doanh ↔ cột trả lời (docs/saas/VALUE_CENTER.md §1). */
const QUESTIONS: [string, string][] = [
  ["Khách trả bao nhiêu?", "«Khách trả» — doanh thu ghi nhận (D1); tầng 2 là tiền đã về."],
  ["AI tạo / tác động bao nhiêu đơn & doanh thu?", "«AI tạo · tác động» — đơn AI tự chốt · đơn AI tác động; tầng 2: doanh thu quy công · doanh thu tác động (đã giao). HAI số, không cộng góp công vào công khi D2 chưa quyết."],
  ["Khách nhận giá trị kinh tế bao nhiêu?", "Tooltip «Bội số» — tử số là lãi gộp quy công cho AI (D4), tầng 2 là độ phủ giá vốn."],
  ["Khách nhận giá trị tốt hay kém?", "«Bội số» — ƯỚC TÍNH, chỉ ở cửa sổ 90 ngày (D12), «—» khi độ phủ giá vốn dưới ngưỡng (D3)."],
  ["Nền tảng lãi bao nhiêu trên khách?", "«Ta tốn» (giá vốn biến đổi đã biết — cận dưới khi còn lượt chưa định giá) + «Lãi nền tảng» (lãi gộp, hoặc «≤» cận trên khi chưa đủ chi phí; tầng 2 đóng góp sau AI)."],
  ["Nguy cơ rời bỏ?", "«Sức khoẻ · rời bỏ» — MỨC + mã lý do, không chấm điểm tổng (D9); «Chưa đủ dữ liệu» kèm chỗ thiếu ở tooltip."],
  ["Vấn đề lớn nhất cần làm hôm nay?", "«Vấn đề chính» — lý do nặng nhất + lối ra."],
  ["Sau tối ưu cải thiện bao nhiêu?", "CHƯA ĐO ĐƯỢC (PR-6): chỉ so hai ảnh CÙNG cửa sổ và CÙNG phiên bản công thức."],
];

function windowHref(w: number, b: TenantValueBoard): string {
  const q = new URLSearchParams({ w: String(w) });
  if (b.sort) q.set("sort", b.sort);
  q.set("dir", b.dir);
  return `?${q.toString()}`;
}

function DecisionList({ ids }: { ids: TenantValueDecisionId[] }) {
  return (
    <div id="quyet-dinh-tam" className="scroll-mt-24 space-y-1.5 text-xs">
      <p className="font-semibold">Quyết định TẠM đang chạy (chủ shop chưa chốt)</p>
      <ul className="space-y-1">
        {ids.map((id) => {
          const d = TENANT_VALUE_DEFAULT_DECISIONS[id];
          return (
            <li key={id} id={`decision-${id}`} className="scroll-mt-24 target:rounded target:bg-muted/60 target:px-1">
              <b>{id}</b> · {d.question} <span className="text-muted-foreground">— đang chạy: {d.defaultLabel} · tác động {TENANT_VALUE_IMPACT_LABEL[d.impact]} · hạn quyết {formatDate(d.decideBy)}</span>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground">
        Chủ shop đổi ở mục «Cần chủ shop» (việc <code>owner-saas-value-defs</code>) —{" "}
        <Link href="/tech/needs-owner" className="text-primary hover:underline">
          mở danh sách việc chờ chủ shop →
        </Link>{" "}
        Đặc tả: <code>docs/saas/VALUE_CENTER.md</code> §7.
      </p>
    </div>
  );
}

export function TenantValueSection({ board }: { board: TenantValueBoard }) {
  const b = board;
  const anyRows = b.total > 0;
  const noToday = anyRows && b.capturedToday === 0;
  const ids = provisionalDecisionsOf(b.rows);
  if (!ids.includes("D12")) ids.push("D12");
  return (
    <SectionCard
      id="gia-tri-khach-hang"
      title="Giá trị khách hàng"
      padded={false}
      description={
        <span data-value-snapshot-stamp>
          {b.latestCapturedAtMs === null ? (
            "Chưa có ảnh chụp nào"
          ) : (
            <>
              Ảnh chụp lúc {formatDateTime(new Date(b.latestCapturedAtMs))}
              {noToday ? (
                <b className="ml-1 font-semibold text-amber-700 dark:text-amber-400" data-value-no-today>
                  · chưa có ảnh chụp hôm nay — đang hiện ảnh gần nhất ({b.latestCapturedDay ? formatDate(b.latestCapturedDay) : "—"})
                </b>
              ) : (
                ` · hôm nay ${b.capturedToday}/${b.total} tổ chức đã có ảnh`
              )}
            </>
          )}
          {" · "}cửa sổ {b.window} ngày · bội số đọc ảnh {b.multipleWindow} ngày
        </span>
      }
      hint={
        <div className="space-y-1.5 text-xs leading-5">
          <p>Số đọc từ ẢNH CHỤP mỗi ngày (job alerts của nhà) — mở trang không mở CSDL của khách nào, không tự chụp. Số chín dần theo kết cục đơn: không phải số của kỳ đã chốt.</p>
          <p>«—» = chưa biết (rê chuột xem thiếu gì) · «N/A» = không áp dụng · «≥» cận dưới · «≤» cận trên · «ƯT» ước tính · «tạm» = đang chạy theo quyết định chưa chốt.</p>
          <p>Không tô màu đạt / không đạt: chưa có đích cho chỉ số nào (luật 38 · 44). Doanh thu quy cho AI là doanh thu DANH NGHĨA theo kết cục đơn, không phải tiền đã xác minh.</p>
        </div>
      }
      actions={
        <nav className="flex items-center gap-1 text-xs" aria-label="Cửa sổ">
          {TENANT_VALUE_WINDOWS.map((w) => (
            <Link key={w} href={windowHref(w, b)} className={cn("rounded-md border px-2 py-1", w === b.window ? "border-primary bg-primary/10 font-semibold text-primary" : "border-hairline hover:bg-muted")} aria-current={w === b.window ? "page" : undefined}>
              {w} ngày
            </Link>
          ))}
        </nav>
      }
    >
      <div className="p-3 md:p-4">
        <TenantValueTable rows={b.rows} pageCount={b.pageCount} total={b.total} />
      </div>
      <div className="grid gap-4 border-t border-hairline px-5 py-3 lg:grid-cols-2">
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold">Bảng này trả lời 8 câu hỏi nào?</summary>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4">
            {QUESTIONS.map(([q, a]) => (
              <li key={q}>
                <b>{q}</b> <span className="text-muted-foreground">{a}</span>
              </li>
            ))}
          </ol>
        </details>
        <DecisionList ids={ids} />
      </div>
    </SectionCard>
  );
}
