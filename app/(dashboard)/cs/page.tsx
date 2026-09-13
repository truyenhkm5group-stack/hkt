import { AlarmClock, Headset, Inbox, ShoppingCart, Truck } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { CaseDialog } from "@/app/(dashboard)/cs/case-dialog";
import { OrderIntakeSection } from "@/app/(dashboard)/cs/intake-section";
import { CsTable, DetectButton } from "@/app/(dashboard)/cs/cs-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { UrlPagination } from "@/components/data-table/url-pagination";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can } from "@/lib/auth/session";
import { requireResource } from "@/lib/auth/scope-guard";
import { ScopeDenied } from "@/components/scope-denied";
import { CS_KIND_LABEL, CS_KINDS, CS_STATUS_LABEL, CS_STATUSES } from "@/lib/constants/cs";
import { CS_DOMAIN_LABEL, CS_DOMAINS } from "@/lib/constants/cs-domain";
import { formatNumber } from "@/lib/format";
import { CS_SORTABLE, csFacets, csOwnerLoad, csSummary, listCsCases, listCsCustomerQueue } from "@/lib/queries/cs";
import { CustomerQueueTable } from "@/app/(dashboard)/cs/customer-queue-table";
import { OwnerLoadSection } from "@/app/(dashboard)/cs/owner-load-section";
import { listEmployees } from "@/lib/queries/payroll";
import { listUsers } from "@/lib/queries/users";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "CSKH" };

/**
 * ═══════════ TAB CSKH CHỈ CHỨA VIỆC CỦA CSKH ═══════════
 *
 * Mặc định: miền CSKH (`lib/constants/cs-domain.ts`) và trạng thái CÒN PHẢI LÀM. Case sinh từ
 * trạng thái vận chuyển thuộc về "Vận đơn & care" — chúng vẫn còn nguyên trong `cs_cases`, vẫn tra
 * được bằng bộ lọc Miền, chỉ là không chiếm chỗ trong hàng đợi của người đang ngồi trả lời khách.
 */
export default async function CsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("CS", "cs:view");
  // Phạm vi hẹp hơn thứ dữ liệu này biểu diễn được ⇒ TỪ CHỐI và nói rõ, không cho xem hết.
  // (Trường hợp thu hẹp ĐƯỢC thì mệnh đề SQL nằm trong `lib/queries/cs.ts` — cả hai lớp, không một.)
  if (decision.allow === "NONE") return <ScopeDenied title="CSKH" reason={decision.reason} fix={decision.fix} />;
  const canWrite = can(user, "cs:manage");
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["kind", "status", "assignee", "domain", "sla"], sortable: CS_SORTABLE, defaultPeriod: "all" });
  /*
    HAI CÁCH XẾP CÙNG MỘT HÀNG ĐỢI.

    `theo-khach` (mặc định) gom mỗi khách thành MỘT dòng — đo production 13/09/2026: 426 việc đang
    mở nhưng chỉ 296 khách, tức gần một phần ba hàng đợi là cùng người với một dòng khác. Người
    trực gọi cho họ ba lần, hoặc gọi một lần rồi vẫn thấy hai dòng đỏ còn lại.

    `theo-case` giữ nguyên bảng cũ: vẫn cần khi đi tìm MỘT case cụ thể. Cả hai dùng CHUNG bộ lọc,
    nên số ở chip và số dòng không thể lệch nhau.
  */
  const xem = (raw.view === "theo-case" ? "theo-case" : "theo-khach") as "theo-khach" | "theo-case";
  const [{ rows, total, pageCount }, nhom, facets, summary, employees, users, workload] = await Promise.all([
    listCsCases(params),
    xem === "theo-khach" ? listCsCustomerQueue(params) : Promise.resolve(null),
    csFacets(params),
    csSummary(),
    listEmployees(),
    listUsers(),
    csOwnerLoad(),
  ]);
  /*
    NGƯỜI NHẬN VIỆC = TÀI KHOẢN ERP, không phải một danh sách TÊN gộp từ ba nguồn.

    Danh sách cũ trộn nhân sự bảng lương, tài khoản ERP và những chuỗi đã từng xuất hiện trong ô
    chữ — ba sổ danh tính khác nhau đổ chung vào một ô chọn. Chọn một cái tên trong đó không nói
    được case này thuộc về TÀI KHOẢN nào, nên thẻ điểm không quy kết được.

    `employees` (bảng lương) vẫn giữ cho phần khác của trang; chỉ ô giao việc là đi bằng khoá.
  */
  const staff = users.rows.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name || u.email })).sort((a, b) => a.name.localeCompare(b.name, "vi"));
  void employees;
  const kindCount = (...kinds: string[]) => kinds.reduce((a, k) => a + (summary.byKind[k] ?? 0), 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="CSKH · Case chăm sóc khách hàng"
        description="Việc bán hàng và chăm khách: chốt đơn, đổi mẫu, sai thông tin trước khi gửi, khiếu nại, giục giao."
        hint="Case sinh từ TRẠNG THÁI VẬN CHUYỂN (giao không thành, chờ phát lại, sai địa chỉ khi kiện đang trên đường) thuộc trang Vận đơn & care — nơi có nút phát lại, duyệt hoàn và sửa người nhận. Chúng không bị xoá: mở bộ lọc Miền để tra. Case tự phát hiện từ thẻ đơn, ghi chú đơn, phiếu đổi/trả và hội thoại chat Pancake (15 phút/lần), hoặc nhập tay."
        actions={canWrite ? (<><DetectButton /><CaseDialog staff={staff} /></>) : null}
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Còn phải làm" value={formatNumber(summary.open)} note={`${formatNumber(summary.unassigned)} chưa ai nhận (bot nhắn không tính là đã nhận)`} icon={Inbox} tone={summary.unassigned ? "rose" : "slate"} />
        <MetricCard label="Chờ lên đơn / đổi mẫu" value={formatNumber(kindCount("ORDER_NOT_CREATED", "EXCHANGE_SIZE", "EXCHANGE_COLOR"))} note="Khâu chốt đơn — mất ở đây là mất đơn" icon={ShoppingCart} tone="amber" />
        <MetricCard label="Đến hạn hẹn lại" value={formatNumber(summary.followUpDue)} note="Đã hẹn khách và tới giờ quay lại" icon={AlarmClock} tone={summary.followUpDue ? "amber" : "slate"} />
        <MetricCard label="Khiếu nại / giục giao / sai giá" value={formatNumber(kindCount("COMPLAINT", "URGE_DELIVERY", "WRONG_PRICE", "SIZE_ADVICE", "RETURN"))} note="Chăm khách sau bán" icon={Headset} tone="blue" />
      </section>

      {/*
        SỐ CASE ĐÃ CHUYỂN QUYỀN SỞ HỮU — NÓI RÕ, KHÔNG GIẤU.

        Chúng không nằm trong bốn thẻ trên (đó là khối lượng việc của CSKH, cộng vào là đếm hai
        lần), nhưng cũng không được im lặng biến mất: người dùng phải biết chúng còn nguyên và biết
        đường đi tới nơi xử lý được.
      */}
      {summary.logistics > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2 text-[12.5px] dark:border-sky-900 dark:bg-sky-950/30">
          <Truck className="size-4 text-sky-700 dark:text-sky-300" />
          <span>
            <b>{formatNumber(summary.logistics)}</b> case sinh từ trạng thái giao vận (giao không thành, sai địa chỉ khi kiện đang chạy…) thuộc <b>Vận đơn &amp; care</b> — không nằm trong hàng đợi này để một việc không bị giao cho hai người.
          </span>
          <Link href="/shipments" className="font-medium text-sky-800 underline-offset-2 hover:underline dark:text-sky-300">Mở Vận đơn &amp; care</Link>
          <Link href="/cs?domain=LOGISTICS" className="text-muted-foreground underline-offset-2 hover:underline">Xem tại đây</Link>
        </div>
      ) : null}

      {/*
        Trong Suspense riêng: khối này nối case với đơn qua conversation_id, nặng hơn các thẻ đếm ở
        trên và không được giữ cả trang chờ theo.
      */}
      <Suspense fallback={null}>
        <OrderIntakeSection />
      </Suspense>

      <DataTableToolbar
        searchPlaceholder="Tên khách, SĐT, nội dung…"
        period={{ defaultKey: "all" }}
        facets={[
          { key: "domain", label: "Miền", single: true, options: CS_DOMAINS.map((d) => ({ value: d, label: CS_DOMAIN_LABEL[d], count: facets.domains.find((x) => x.value === d)?.count ?? 0 })) },
          { key: "status", label: "Trạng thái", options: CS_STATUSES.map((s) => ({ value: s, label: CS_STATUS_LABEL[s], count: facets.statuses.find((x) => x.value === s)?.count ?? 0 })) },
          { key: "kind", label: "Loại", options: CS_KINDS.map((k) => ({ value: k, label: CS_KIND_LABEL[k], count: facets.kinds.find((x) => x.value === k)?.count ?? 0 })) },
          { key: "assignee", label: "Phụ trách", options: facets.assignees },
          // Hạn xử lý: bốn mức, đếm bằng CHÍNH mệnh đề bộ lọc dùng (`lib/queries/cs.ts::slaCond`).
          { key: "sla", label: "Hạn", options: facets.slas },
        ]}
        resultLabel={xem === "theo-khach" && nhom ? `${formatNumber(nhom.total)} khách · ${formatNumber(total)} việc` : `${formatNumber(total)} case phù hợp`}
      />
      <div className="flex flex-wrap gap-2">
        {([
          { key: "theo-khach", label: "Theo khách", note: nhom ? `${formatNumber(nhom.total)} khách` : "" },
          { key: "theo-case", label: "Theo từng việc", note: `${formatNumber(total)} việc` },
        ] as const).map((t) => {
          const sp = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])));
          sp.set("view", t.key);
          sp.delete("page");
          return (
            <Link
              key={t.key}
              href={`/cs?${sp.toString()}`}
              className={cn("rounded-full border px-4 py-1.5 text-sm font-medium transition", t.key === xem ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}
            >
              {t.label}
              {t.note ? ` · ${t.note}` : ""}
            </Link>
          );
        })}
      </div>
      <SectionCard padded={false}>
        {xem === "theo-khach" && nhom ? (
          /*
            NGÀY THÁNG QUA RANH GIỚI MÁY CHỦ → TRÌNH DUYỆT DƯỚI DẠNG CHUỖI ISO.

            Không phải vì `Date` không đi qua được, mà vì nó đi qua rồi thành một `Date` mang múi
            giờ của MÁY CHỦ trong khi mọi phép in giờ của ERP tính theo giờ Việt Nam
            (`lib/format.ts`). Một chuỗi ISO thì không có chỗ nào để hiểu nhầm.
          */
          <CustomerQueueTable
            canWrite={canWrite}
            currentUser={user.name || user.email}
            staff={staff}
            rows={nhom.rows.map((r) => ({
              key: r.key,
              customerName: r.customerName,
              customerPhone: r.customerPhone,
              openCount: r.openCount,
              overdueCount: r.overdueCount,
              kinds: r.kinds,
              oldestAt: r.oldestAt.toISOString(),
              dueAt: r.dueAt ? r.dueAt.toISOString() : null,
              slaBucket: r.slaBucket,
              owners: r.owners,
              anyAssigned: r.anyAssigned,
              nextAction: r.nextAction,
              chatUrl: r.chatUrl,
              cases: r.cases.map((c) => ({
                id: c.id,
                kind: c.kind,
                status: c.status,
                source: c.source,
                orderId: c.orderId,
                orderSystemId: c.orderSystemId,
                title: c.title,
                createdAt: c.createdAt.toISOString(),
                followUpAt: c.followUpAt ? c.followUpAt.toISOString() : null,
                assignee: c.assignee,
                dueAt: c.dueAt ? c.dueAt.toISOString() : null,
                slaBucket: c.slaBucket,
                chatUrl: c.chatUrl,
              })),
            }))}
          />
        ) : (
          <CsTable rows={rows} staff={staff} canWrite={canWrite} currentUser={user.name || user.email} currentUserId={user.id} />
        )}
        <div className="border-t px-4 py-2">
          <UrlPagination pageCount={xem === "theo-khach" && nhom ? nhom.pageCount : pageCount} total={xem === "theo-khach" && nhom ? nhom.total : total} />
        </div>
      </SectionCard>

      <OwnerLoadSection rows={workload} />
    </div>
  );
}
