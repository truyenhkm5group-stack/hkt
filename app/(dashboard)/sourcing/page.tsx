import Link from "next/link";
import { PackageSearch, Plus } from "lucide-react";
import { SourcingOffersTable } from "@/app/(dashboard)/sourcing/offers-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { Button } from "@/components/ui/button";
import { SourcingQueryBox } from "@/components/sourcing/sourcing-query-box";
import { LandedCostForm, ScoreWeightsForm, SourcingLimitsForm } from "@/components/sourcing/sourcing-settings-forms";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import {
  DEFAULT_SOURCING_LIMITS,
  EMPTY_LANDED_COST,
  EMPTY_SCORE_WEIGHTS,
  SOURCING_SCORE_WEIGHTS_KEY,
  SUPPLIER_SCORE_COMPONENTS,
  SUPPLIER_SCORE_LABEL,
  parseScoreWeights,
  scoreWeightsDeclared,
  SOURCING_FX_STALE_DAYS,
  SOURCING_LANDED_COST_KEY,
  SOURCING_LIMITS_KEY,
  SOURCING_PLATFORMS,
  SOURCING_PLATFORM_LABEL,
  fxStale,
  landedCostMissing,
  parseLandedCost,
  parseSourcingLimits,
} from "@/lib/constants/sourcing";
import { formatDateTime, formatNumber } from "@/lib/format";
import { SOURCING_OFFER_SORTABLE, listSourcingOffers } from "@/lib/queries/sourcing";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";

export const metadata = { title: "Tìm hàng nguồn" };

/**
 * TÌM HÀNG NGUỒN TRUNG QUỐC (module `sourcing`, docs/tech/ai-sourcing.md). SRC-1: chưa có nguồn dữ liệu được duyệt nên khối tìm
 * hàng ở trạng thái trống có giải thích; hai khối cấu hình (trần lượt AI, tham số giá về Việt Nam) đọc / ghi settings. SRC-2: bộ
 * sinh từ khoá tiếng Trung (từ điển cố định, AI chỉ khi từ điển không đủ — qua server action, trang không tự gọi AI). SRC-3: kho
 * mẫu nhập tay (bảng 0256) + chọn 2–4 mẫu để so sánh.
 */
export default async function SourcingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("sourcing:view");
  const canWrite = can(user, "sourcing:write");
  const params = parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["platform", "state"], sortable: SOURCING_OFFER_SORTABLE });
  const canConfigure = can(user, "sourcing:approve");
  const canSearch = can(user, "sourcing:search");
  const [limits, landed, weights, offers] = await Promise.all([
    getSettingJson<unknown>(SOURCING_LIMITS_KEY, DEFAULT_SOURCING_LIMITS).then(parseSourcingLimits),
    getSettingJson<unknown>(SOURCING_LANDED_COST_KEY, EMPTY_LANDED_COST).then(parseLandedCost),
    getSettingJson<unknown>(SOURCING_SCORE_WEIGHTS_KEY, EMPTY_SCORE_WEIGHTS).then(parseScoreWeights),
    listSourcingOffers(params),
  ]);
  const now = new Date();
  const missing = landedCostMissing(landed);
  const stale = fxStale(landed, now);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sản xuất"
        title="Tìm hàng nguồn"
        description="Gõ tiếng Việt hoặc tải ảnh để tìm sản phẩm thật trên nguồn Trung Quốc, so sánh nhà cung cấp, lưu mẫu và xin mua thử."
      />

      <SectionCard title="Sinh từ khoá tiếng Trung" description="Gõ món hàng bằng tiếng Việt ⇒ 3–5 truy vấn tiếng Trung từ cụ thể tới rộng, bấm «Chép» để tìm trên 1688.">
        {canSearch ? <SourcingQueryBox /> : <p className="text-sm text-muted-foreground">Cần quyền «Tìm hàng: tìm» để sinh từ khoá.</p>}
      </SectionCard>

      <SectionCard
        id="kho-mau"
        title="Kho mẫu"
        description="Mẫu đã tìm thấy và lưu tay: link, bậc giá, MOQ, nhà cung cấp. Chọn 2–4 mẫu để so sánh."
        actions={
          canWrite && !offers.unavailable ? (
            <Button asChild size="sm">
              <Link href="/sourcing/offers/new">
                <Plus className="size-4" />
                Thêm mẫu
              </Link>
            </Button>
          ) : null
        }
      >
        {offers.unavailable ? (
          <p className="text-sm text-amber-700 dark:text-amber-300" data-sourcing-unavailable>
            CSDL của tổ chức chưa áp migration 0256 (kho mẫu nguồn) — kho mẫu chưa dùng được, các phần khác của trang vẫn chạy.
          </p>
        ) : (
          <div className="space-y-3">
            <DataTableToolbar
              searchPlaceholder="Tên mẫu, mã sản phẩm, link, nhà cung cấp…"
              facets={[
                { key: "platform", label: "Nguồn", options: SOURCING_PLATFORMS.map((p) => ({ value: p, label: SOURCING_PLATFORM_LABEL[p] })) },
                {
                  key: "state",
                  label: "Trạng thái",
                  options: [
                    { value: "ACTIVE", label: "Đang dùng" },
                    { value: "ARCHIVED", label: "Lưu trữ" },
                  ],
                },
              ]}
              resultLabel={`${formatNumber(offers.total)} mẫu`}
            />
            <SourcingOffersTable rows={offers.rows} pageCount={offers.pageCount} total={offers.total} nowIso={now.toISOString()} />
          </div>
        )}
      </SectionCard>

      <SectionCard title="Tìm hàng" description="Từ khoá tiếng Việt / ảnh ⇒ sản phẩm nguồn ⇒ so sánh giá theo bậc, MOQ, nhà cung cấp.">
        <EmptyState
          icon={PackageSearch}
          title="Chưa có nguồn dữ liệu được duyệt"
          description="ERP chỉ dùng nguồn dữ liệu có quyền sử dụng rõ ràng (API chính thức hoặc đối tác có văn bản) — không cào web. Việc này đang chờ chủ shop chọn nguồn (docs/tech/ai-sourcing.md §6, B1 / B2). Trong lúc chờ: dùng bộ sinh từ khoá ở trên, tìm trên 1688 bằng tài khoản của bạn, rồi lưu mẫu vào «Kho mẫu» bằng tay."
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

      <SectionCard title="Trọng số điểm nhà cung cấp" description="Không có bộ mặc định: chưa khai thì màn so sánh chỉ hiện từng thành phần (đánh giá, phản hồi, xác minh, số năm) kèm độ phủ, không có điểm tổng.">
        <div className="space-y-3 text-sm" data-score-weights-status>
          <p>
            {scoreWeightsDeclared(weights)
              ? `Đang tính điểm tổng theo: ${SUPPLIER_SCORE_COMPONENTS.filter((k) => (weights.supplier[k] ?? 0) > 0)
                  .map((k) => `${SUPPLIER_SCORE_LABEL[k]} ${weights.supplier[k]}`)
                  .join(" · ")}${weights.yearsCap !== null ? ` · trần số năm ${weights.yearsCap}` : ""}.`
              : "Chưa khai trọng số — không có điểm tổng."}
          </p>
          {weights.setAt ? (
            <p className="text-xs text-muted-foreground">
              Lưu lần cuối {formatDateTime(weights.setAt)}
              {weights.setByEmail ? ` bởi ${weights.setByEmail}` : ""}
              {weights.reason ? ` — ${weights.reason}` : ""}.
            </p>
          ) : null}
          {canConfigure ? <ScoreWeightsForm initial={weights} /> : <p className="text-muted-foreground">Chỉ người có quyền «Tìm hàng: duyệt & cấu hình» đổi được trọng số.</p>}
        </div>
      </SectionCard>
    </div>
  );
}
