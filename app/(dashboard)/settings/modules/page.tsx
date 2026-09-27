import { NAV_TITLES } from "@/components/app-sidebar";
import { PageHeader } from "@/components/page-header";
import { PageUsageTable } from "@/components/platform/page-usage-table";
import { ModuleConfigTable } from "@/components/platform/module-config-table";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { OTHER_USAGE_KEY, usageKeysFrom } from "@/lib/constants/page-usage";
import { hrefVisible } from "@/lib/platform-ui/module-visibility";
import { getOrganizationModuleView } from "@/lib/queries/platform-modules";
import { formatDate, formatNumber } from "@/lib/format";
import { getPageUsage } from "@/lib/usage/page-visits";

export const metadata = { title: "Module của tổ chức" };

/**
 * MODULE CỦA TỔ CHỨC — quản trị chọn tổ chức MÌNH dùng những mảng nào của ERP.
 *
 * Luôn là tổ chức CỦA NGƯỜI XEM (`user.organization`, lấy từ phiên do máy chủ ký) — không có tham số
 * nào trên URL đổi được tổ chức ở đây. Đổi tổ chức khác là việc của `/platform`.
 */
export default async function OrganizationModulesPage() {
  const user = await requirePermission("modules:manage");
  const org = user.organization;
  if (!org) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Hệ thống" title="Module của tổ chức" />
        <EmptyState title="Chưa có thông tin tổ chức của phiên" description="Phiên đăng nhập này không mang tổ chức nào — đăng xuất rồi đăng nhập lại để quản lý module." />
      </div>
    );
  }
  // Chỉ trang thuộc module ĐANG BẬT: trang của module tắt thì 0 lượt là hiển nhiên, không phải tín hiệu.
  const usageKeys = usageKeysFrom(Object.keys(NAV_TITLES)).filter((k) => hrefVisible(user, k));
  const [{ organization, view }, usage] = await Promise.all([getOrganizationModuleView(org.code), getPageUsage([...usageKeys, OTHER_USAGE_KEY])]);
  const depErrors = view.groups.flatMap((g) => g.rows).filter((r) => r.dependencyError).length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Module của tổ chức"
        description={`${organization.name} · ${view.enabledCount}/${view.total} module đang bật`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Bật / tắt có hiệu lực NGAY cho mọi người trong tổ chức — không cần triển khai lại.</p>
            <p>Hiệu lực = module bật ∧ tính năng bật ∧ quyền của từng người. Module tắt thì kể cả quản trị cũng không vào được màn hình của nó.</p>
            <p>Phụ thuộc: bật một module cần bật trước những module nó dựa vào; tắt một module bị chặn khi còn module khác đang dựa vào nó. Máy không tự bật hay tắt dây chuyền.</p>
            <p>
              Dòng thiếu nghĩa là {organization.moduleDefault === "ENABLED" ? "BẬT" : "TẮT"} với tổ chức này (khai ở cấp tổ chức). Mọi lượt đổi ghi vào Nhật ký hệ thống.
            </p>
          </div>
        }
      />
      <SectionCard
        title="Module theo nhóm"
        description={depErrors ? `⚠ ${depErrors} module khai bật nhưng đang bị coi là tắt vì thiếu phụ thuộc` : "Bấm công tắc để bật / tắt; tính năng chỉ có hiệu lực khi module của nó bật."}
        padded={false}
        contentClassName="p-3"
      >
        {view.groups.length === 0 ? (
          <EmptyState title="Không có module nào trong sổ" description="Sổ module của mã nguồn rỗng — không nên xảy ra; báo đội kỹ thuật." />
        ) : (
          <ModuleConfigTable groups={view.groups} target={{ kind: "own" }} />
        )}
      </SectionCard>
      <SectionCard
        title={`Lượt mở trang · ${usage.windowDays} ngày gần nhất`}
        description={
          usage.measuredDays === 0
            ? "Chưa có số đo"
            : `Đã đo ${usage.measuredDays}/${usage.windowDays} ngày (từ ${formatDate(usage.firstMeasuredDay)}) · ít dùng nhất lên đầu · đường dẫn ngoài danh sách: ${formatNumber(usage.otherVisits)} lượt`
        }
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Mỗi lần đổi trang được đếm +1 vào MỤC trang đó (trang chi tiết đếm vào trang danh sách của nó). Đổi bộ lọc trên cùng trang không đếm.</p>
            <p>KHÔNG ghi ai mở — chỉ có ngày, trang và số lượt.</p>
            <p>Máy không kết luận trang nào nên bỏ: trang dùng mỗi tháng một lần (chốt lương) vẫn có thể cần. Dùng bảng này để hỏi đúng người trước khi gộp hay ẩn một mục menu.</p>
          </div>
        }
        padded={false}
        contentClassName="p-3"
      >
        <PageUsageTable summary={usage} />
      </SectionCard>
    </div>
  );
}
