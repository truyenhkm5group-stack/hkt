import { ScopeDenied } from "@/components/scope-denied";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui-bits";
import { FbCrmTable } from "@/app/(dashboard)/customers/facebook-crm/fb-crm-table";
import { requireResource } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { FB_CRM_SETTING_KEY, FB_CRM_SORTABLE, FB_CRM_VIEWS, FB_CRM_VIEW_LABEL, fbCrmViewOf } from "@/lib/constants/fb-crm";
import { formatNumber } from "@/lib/format";
import { fbCrmAssignableUsers, fbCrmEnabled, fbCrmViewCounts, listFbCrm } from "@/lib/queries/fb-crm";
import { parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Facebook Friend CRM" };

/**
 * FACEBOOK FRIEND CRM (lát 1 · docs/verticals/facebook-friend-crm.md) — khách đã nhắn fanpage / đã mua, để nhân viên CHĂM SÓC
 * BẰNG TAY trên nick Facebook của shop: lưu link trang cá nhân (người dán), ghi đồng ý / lời mời / đã kết bạn, giao người phụ
 * trách, hẹn ngày, tạo nhiệm vụ CSKH. ERP không tự kết bạn, không tự nhắn, không quét Facebook.
 *
 * Cờ tổ chức `fbCrm.enabled` (`{"on": true}`) mặc định TẮT ⇒ trang chỉ báo «chưa bật», và nút vào trang ở /customers không hiện.
 */
export default async function FacebookCrmPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("CUSTOMERS", "customers:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Facebook Friend CRM" reason={decision.reason} fix={decision.fix} />;

  if (!(await fbCrmEnabled())) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Khách hàng" title="Facebook Friend CRM" />
        <EmptyState
          title="Chưa bật Facebook Friend CRM cho tổ chức này"
          description={`Tính năng mặc định TẮT. Chủ shop bật bằng cài đặt «${FB_CRM_SETTING_KEY}» = {"on": true}.`}
        />
      </div>
    );
  }

  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "lastInteractionAt", filterKeys: ["view"], sortable: [...FB_CRM_SORTABLE], defaultPeriod: "all" });
  const view = fbCrmViewOf(params.filters.view?.[0]);
  const [{ rows, total, pageCount, unavailable }, counts, users] = await Promise.all([listFbCrm(params, view), fbCrmViewCounts(params.q), fbCrmAssignableUsers()]);
  const canWrite = can(user, "customers:write");

  // CSDL của tổ chức chưa áp 0262 (đang phục vụ bằng lược đồ cũ) ⇒ nói thẳng, không in một danh sách rỗng trông như «không có khách».
  if (unavailable || !counts) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Khách hàng" title="Facebook Friend CRM" />
        <EmptyState title="CSDL chưa áp 0262" description="Lược đồ của tổ chức chưa cập nhật xong (migration 0262 — Facebook CRM). Trang sẽ hiện khi lượt cập nhật hoàn tất; chưa có gì bị ghi." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Khách hàng"
        title="Facebook Friend CRM"
        description={`${formatNumber(counts.all)} khách từng nhắn fanpage hoặc có đơn · ${formatNumber(counts.friends)} đã kết bạn · ${formatNumber(counts.consented)} đồng ý, chờ kết bạn · ${formatNumber(counts.dnc)} không liên hệ`}
        hint="Giao thành công theo kết quả đơn của ERP (ORDER_OUTCOME — đơn hoàn / huỷ không tính). Doanh thu thực = tiền CÓ CHỨNG TỪ (COD thực thu, chuyển khoản) của đơn giao thành công; «—» = chưa có chứng từ, không phải 0đ. Link Facebook chỉ có khi NGƯỜI dán (khách gửi, hoặc nhân viên bấm avatar trên Pancake) — mã trong hộp thư là mã THEO PAGE, không mở được trang cá nhân."
      />
      <p className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        ERP <b>không</b> tự kết bạn, <b>không</b> tự nhắn tin từ nick cá nhân và <b>không</b> quét Facebook. Chỉ mời kết bạn khi khách đã đồng ý; khách «không liên hệ» thì không ai nhắn.
      </p>
      <DataTableToolbar
        searchPlaceholder="Tên khách, số điện thoại…"
        period={false}
        facets={[{ key: "view", label: "Nhóm khách", single: true, options: FB_CRM_VIEWS.filter((v) => v !== "all").map((v) => ({ value: v, label: FB_CRM_VIEW_LABEL[v], count: counts[v] })) }]}
        resultLabel={`${formatNumber(total)} khách · ${FB_CRM_VIEW_LABEL[view]}`}
      />
      <FbCrmTable rows={rows} pageCount={pageCount} total={total} users={users} canWrite={canWrite} />
    </div>
  );
}
