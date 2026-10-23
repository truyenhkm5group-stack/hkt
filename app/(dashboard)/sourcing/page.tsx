import { PackageSearch } from "lucide-react";
import { LandedCostForm, SourcingLimitsForm } from "@/components/sourcing/sourcing-settings-forms";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import {
  DEFAULT_SOURCING_LIMITS,
  EMPTY_LANDED_COST,
  SOURCING_FX_STALE_DAYS,
  SOURCING_LANDED_COST_KEY,
  SOURCING_LIMITS_KEY,
  fxStale,
  landedCostMissing,
  parseLandedCost,
  parseSourcingLimits,
} from "@/lib/constants/sourcing";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getSettingJson } from "@/lib/settings";

export const metadata = { title: "Tìm hàng nguồn" };

/**
 * TÌM HÀNG NGUỒN TRUNG QUỐC (module `sourcing`, SRC-1 · docs/tech/ai-sourcing.md) — KHUNG: chưa có nguồn dữ liệu được duyệt nên
 * khối tìm hàng ở trạng thái trống có giải thích; hai khối cấu hình (trần lượt AI, tham số giá về Việt Nam) đọc / ghi settings.
 * Không gọi nguồn ngoài, không gọi AI.
 */
export default async function SourcingPage() {
  const user = await requirePermission("sourcing:view");
  const canConfigure = can(user, "sourcing:approve");
  const [limits, landed] = await Promise.all([
    getSettingJson<unknown>(SOURCING_LIMITS_KEY, DEFAULT_SOURCING_LIMITS).then(parseSourcingLimits),
    getSettingJson<unknown>(SOURCING_LANDED_COST_KEY, EMPTY_LANDED_COST).then(parseLandedCost),
  ]);
  const missing = landedCostMissing(landed);
  const stale = fxStale(landed, new Date());
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản xuất"
        title="Tìm hàng nguồn"
        description="Gõ tiếng Việt hoặc tải ảnh để tìm sản phẩm thật trên nguồn Trung Quốc, so sánh nhà cung cấp, lưu mẫu và xin mua thử."
      />

      <SectionCard title="Tìm hàng" description="Từ khoá tiếng Việt / ảnh ⇒ sản phẩm nguồn ⇒ so sánh giá theo bậc, MOQ, nhà cung cấp.">
        <EmptyState
          icon={PackageSearch}
          title="Chưa có nguồn dữ liệu được duyệt"
          description="ERP chỉ dùng nguồn dữ liệu có quyền sử dụng rõ ràng (API chính thức hoặc đối tác có văn bản) — không cào web. Việc này đang chờ chủ shop chọn nguồn (docs/tech/ai-sourcing.md §6, B1 / B2). Bộ sinh từ khoá tiếng Trung và kho mẫu nhập tay sẽ có ở bước kế tiếp."
        />
      </SectionCard>

      <SectionCard title="Trần lượt AI" description="Số lượt gọi AI tối đa mỗi ngày của tổ chức cho việc tìm hàng. Hết trần thì dừng và báo, không tự nạp thêm.">
        <div className="space-y-3 text-sm">
          <p>
            Đang đặt: <strong>{formatNumber(limits.aiCallsPerDay)}</strong> lượt / ngày.
          </p>
          {canConfigure ? <SourcingLimitsForm initial={limits} /> : <p className="text-muted-foreground">Chỉ người có quyền «Tìm hàng: duyệt & cấu hình» đổi được trần.</p>}
        </div>
      </SectionCard>

      <SectionCard title="Tham số giá về Việt Nam" description="Tỷ giá, cước, phí mua hộ, thuế — giá về Việt Nam luôn là số ƯỚC TÍNH và chỉ tính khi đủ tham số.">
        <div className="space-y-3 text-sm" data-landed-cost-status>
          {missing.length ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              Chưa đủ tham số: {missing.join(" · ")}. Ô giá về Việt Nam sẽ in «chưa đủ tham số».
            </p>
          ) : (
            <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
              Đủ tham số
              {stale ? ` — tỷ giá áp từ ${landed.fxAsOf}, đã quá ${SOURCING_FX_STALE_DAYS} ngày, nên cập nhật` : ""}.
            </p>
          )}
          {landed.setAt ? (
            <p className="text-xs text-muted-foreground">
              Lưu lần cuối {formatDateTime(landed.setAt)}
              {landed.setByEmail ? ` bởi ${landed.setByEmail}` : ""}
              {landed.reason ? ` — ${landed.reason}` : ""}.
            </p>
          ) : null}
          {canConfigure ? <LandedCostForm initial={landed} /> : <p className="text-muted-foreground">Chỉ người có quyền «Tìm hàng: duyệt & cấu hình» đổi được tham số.</p>}
        </div>
      </SectionCard>
    </div>
  );
}
