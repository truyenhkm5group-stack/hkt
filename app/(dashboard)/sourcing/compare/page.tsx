import Link from "next/link";
import { Columns3 } from "lucide-react";
import { LandedCostCell } from "@/components/sourcing/landed-cost-view";
import { DataAge, OfferImage, TiersText } from "@/components/sourcing/offer-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import {
  EMPTY_LANDED_COST,
  EMPTY_SCORE_WEIGHTS,
  SOURCING_COMPARE_MAX,
  SOURCING_COMPARE_QUANTITIES,
  SOURCING_LANDED_COST_KEY,
  SOURCING_PLATFORM_LABEL,
  SOURCING_SCORE_WEIGHTS_KEY,
  parseLandedCost,
  parseScoreWeights,
} from "@/lib/constants/sourcing";
import { formatNumber } from "@/lib/format";
import { getSourcingCompare, latestOfferWeights, type SourcingCompareItem } from "@/lib/queries/sourcing";
import { getSettingJson } from "@/lib/settings";
import { landedConfigEmpty, landedCostAtQty } from "@/lib/sourcing/landed-cost";
import { safeHttpUrl } from "@/lib/sourcing/offer-url";
import { formatCny, formatHundredths, priceAtQty } from "@/lib/sourcing/price";
import { requestMatch, supplierScore } from "@/lib/sourcing/score";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "So sánh mẫu nguồn" };

function idsOf(raw: SearchParams): string[] {
  const v = raw.ids;
  const s = Array.isArray(v) ? v.join(",") : (v ?? "");
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z0-9-]{1,100}$/.test(x));
}

function PriceCell({ item, qty }: { item: SourcingCompareItem; qty: number }) {
  const l = item.latest;
  const p = priceAtQty(l?.tiers ?? null, qty, l?.moq ?? null);
  if (p.kind === "UNKNOWN") return <span className="text-muted-foreground">—</span>;
  if (p.kind === "BELOW_LOWEST_TIER") return <span className="text-xs text-muted-foreground">nguồn bán từ {p.lowestFrom} cái</span>;
  return (
    <span className="tabular-nums">
      {formatCny(p.priceFen)}
      <span className="ml-1 text-[11px] text-muted-foreground">(bậc ≥{p.tierFrom})</span>
      {p.belowMoq ? <span className="ml-1 rounded bg-amber-100 px-1 text-[11px] text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">dưới MOQ</span> : null}
    </span>
  );
}

/**
 * SO SÁNH 2–4 MẪU NGUỒN (SRC-3) từ lần chụp giá MỚI NHẤT của mỗi mẫu. Giá là nhân dân tệ / cái tại từng mốc số lượng
 * (`SOURCING_COMPARE_QUANTITIES`, chỉ để hiển thị). SRC-4: giá về Việt Nam ƯỚC TÍNH theo tham số đã khai (thiếu ⇒ «—» + lý do,
 * không số mặc định), điểm nhà cung cấp theo thành phần (tổng chỉ khi chủ shop khai trọng số), khớp yêu cầu ✓ / ✗, tiềm năng chưa đo.
 * Không tô màu, không xếp hạng: số tay chưa đủ căn cứ để kết luận mẫu nào «tốt hơn».
 */
export default async function SourcingComparePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("sourcing:view");
  const raw = await searchParams;
  const ids = idsOf(raw);
  const req = (Array.isArray(raw.req) ? raw.req[0] : (raw.req ?? "")).slice(0, 200);
  const [data, landed, weights] = await Promise.all([
    getSourcingCompare(ids),
    getSettingJson<unknown>(SOURCING_LANDED_COST_KEY, EMPTY_LANDED_COST).then(parseLandedCost),
    getSettingJson<unknown>(SOURCING_SCORE_WEIGHTS_KEY, EMPTY_SCORE_WEIGHTS).then(parseScoreWeights),
  ]);
  const now = new Date();
  const header = <PageHeader eyebrow="Tìm hàng nguồn" title="So sánh mẫu" description={`Tối đa ${SOURCING_COMPARE_MAX} mẫu, đọc lần chụp giá mới nhất của mỗi mẫu. Giá tính bằng nhân dân tệ, chưa quy ra giá về Việt Nam.`} />;
  if (data.unavailable)
    return (
      <div className="space-y-5">
        {header}
        <p className="text-sm text-amber-700 dark:text-amber-300">CSDL của tổ chức chưa áp migration 0256 (kho mẫu nguồn).</p>
      </div>
    );
  const { items, missing } = data;
  const offerWeights = await latestOfferWeights(items.map((i) => i.id));
  const gramsOf = (id: string) => offerWeights.byOffer.get(id)?.[0]?.grams ?? null;
  const dropped = ids.length > SOURCING_COMPARE_MAX ? ids.length - SOURCING_COMPARE_MAX : 0;
  if (items.length < 2)
    return (
      <div className="space-y-5">
        {header}
        <EmptyState
          icon={Columns3}
          title="Chọn ít nhất 2 mẫu để so sánh"
          description={
            <>
              Vào <Link className="text-primary underline" href="/sourcing#kho-mau">Kho mẫu</Link>, tick 2–{SOURCING_COMPARE_MAX} mẫu rồi bấm «So sánh».
              {missing.length ? ` ${missing.length} mẫu trong link không còn trong kho.` : ""}
            </>
          }
        />
      </div>
    );

  const row = (label: string, render: (it: SourcingCompareItem) => React.ReactNode) => (
    <tr className="border-t align-top">
      <th scope="row" className="w-40 py-2 pr-3 text-left text-xs font-medium text-muted-foreground">
        {label}
      </th>
      {items.map((it) => (
        <td key={it.id} className="py-2 pr-3 text-sm">
          {render(it)}
        </td>
      ))}
    </tr>
  );
  return (
    <div className="space-y-5">
      {header}
      {missing.length || dropped ? (
        <p className="text-xs text-muted-foreground">
          {missing.length ? `${missing.length} mẫu trong link không còn trong kho. ` : ""}
          {dropped ? `Chỉ lấy ${SOURCING_COMPARE_MAX} mẫu đầu, bỏ ${dropped}.` : ""}
        </p>
      ) : null}
      {landedConfigEmpty(landed) ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Tham số giá về Việt Nam chưa khai — mọi ô giá về in «—». Khai ở <Link className="underline" href="/sourcing">trang Tìm hàng nguồn</Link> (quyền «Tìm hàng: duyệt & cấu hình»).
        </p>
      ) : null}
      {offerWeights.unavailable ? <p className="text-xs text-amber-700 dark:text-amber-300">CSDL của tổ chức chưa áp migration 0257 — chưa đọc được cân nặng, giá về Việt Nam thiếu cước Trung Quốc → Việt Nam.</p> : null}
      <form method="get" className="flex flex-wrap items-end gap-2" data-request-form>
        <input type="hidden" name="ids" value={items.map((i) => i.id).join(",")} />
        <div className="space-y-1">
          <label htmlFor="src-req" className="text-xs font-medium">
            Yêu cầu (tiếng Việt) để xem mẫu nào khớp
          </label>
          <Input id="src-req" name="req" defaultValue={req} placeholder="đầm suông che bụng cho mẹ" className="w-80 max-w-full" maxLength={200} />
        </div>
        <Button type="submit" size="sm" variant="outline">
          Xem khớp
        </Button>
      </form>
      <SectionCard padded={false}>
        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[640px] table-fixed" data-sourcing-compare>
            <thead>
              <tr>
                <th className="w-40" />
                {items.map((it) => (
                  <th key={it.id} className="pb-2 pr-3 text-left align-top font-normal">
                    <div className="flex items-start gap-2">
                      <OfferImage src={it.imageUrl} alt={it.titleVi} size={56} />
                      <div className="min-w-0">
                        <Link className="font-semibold text-primary hover:underline" href={`/sourcing/offers/${it.id}`}>
                          {it.titleVi || "(chưa đặt tên)"}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {SOURCING_PLATFORM_LABEL[it.platform]}
                          {it.archived ? " · lưu trữ" : ""}
                        </div>
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {row("Lần chụp giá", (it) => (it.latest ? <DataAge source={it.latest.source} asOf={it.latest.capturedAt} now={now} /> : <span className="text-muted-foreground">chưa chụp giá</span>))}
              {SOURCING_COMPARE_QUANTITIES.map((q) => (
                <tr key={q} className="border-t align-top">
                  <th scope="row" className="w-40 py-2 pr-3 text-left text-xs font-medium text-muted-foreground">
                    Giá / cái khi mua {q}
                  </th>
                  {items.map((it) => (
                    <td key={it.id} className="py-2 pr-3 text-sm">
                      <PriceCell item={it} qty={q} />
                    </td>
                  ))}
                </tr>
              ))}
              {row("Cân nặng / cái", (it) => (gramsOf(it.id) === null ? "—" : `${formatNumber(gramsOf(it.id))} g`))}
              {SOURCING_COMPARE_QUANTITIES.map((q) => (
                <tr key={`vn-${q}`} className="border-t align-top">
                  <th scope="row" className="w-40 py-2 pr-3 text-left text-xs font-medium text-muted-foreground">
                    Giá về VN / cái khi mua {q}
                  </th>
                  {items.map((it) => (
                    <td key={it.id} className="py-2 pr-3 text-sm">
                      <LandedCostCell value={landedCostAtQty({ tiers: it.latest?.tiers ?? null, moq: it.latest?.moq ?? null, weightG: gramsOf(it.id), qty: q, cfg: landed, now })} />
                    </td>
                  ))}
                </tr>
              ))}
              {row("MOQ", (it) => it.latest?.moq ?? "—")}
              {row("Mọi bậc giá", (it) => (it.latest ? <TiersText tiers={it.latest.tiers} className="text-xs" /> : "—"))}
              {row("Nhà cung cấp", (it) => it.supplier?.name || "—")}
              {row("Số năm trên nền tảng", (it) => it.supplier?.yearsOnPlatform ?? "—")}
              {row("Điểm đánh giá", (it) => (it.supplier?.ratingX100 == null ? "—" : `${formatHundredths(it.supplier.ratingX100)} / 5`))}
              {row("Tỷ lệ phản hồi", (it) => (it.supplier?.responseRateBp == null ? "—" : `${formatHundredths(it.supplier.responseRateBp)}%`))}
              {row("Đã xác minh", (it) => (it.supplier?.verified == null ? "—" : it.supplier.verified ? "có" : "không"))}
              {row("Gửi hàng từ", (it) => it.supplier?.shipFrom ?? "—")}
              {row("Số liệu nhà cung cấp", (it) => (it.supplier ? <DataAge source={it.supplier.factsSource} asOf={it.supplier.factsAsOf} now={now} /> : "—"))}
              {row("Điểm nhà cung cấp", (it) => {
                const sc = supplierScore(it.supplier, weights);
                return (
                  <div className="space-y-0.5 text-xs" data-supplier-score>
                    <div className="font-medium">{sc.total === null ? "—" : `${sc.total} điểm (thang 100)`}</div>
                    <div className="text-muted-foreground">
                      Có số {sc.coverage.have}/{sc.coverage.of} thành phần. {sc.totalNote}
                    </div>
                  </div>
                );
              })}
              {req.trim()
                ? row("Khớp yêu cầu", (it) => {
                    const m = requestMatch(req, it.titleZh);
                    if (m.kind === "NO_TITLE") return <span className="text-xs text-muted-foreground">mẫu chưa có tên tiếng Trung — chưa so được</span>;
                    if (m.kind !== "MATCH") return "—";
                    return (
                      <div className="space-y-0.5 text-xs" data-request-match>
                        {m.terms.length ? (
                          <div className="flex flex-wrap gap-1">
                            {m.terms.map((t) => (
                              <span key={t.label} className="rounded border px-1">
                                {t.hit ? "✓" : "✗"} {t.label} <span lang="zh-CN">{t.zh}</span>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">từ điển chưa hiểu ý nào của yêu cầu</span>
                        )}
                        {m.unmatched.length ? <div className="text-muted-foreground">Chưa hiểu: {m.unmatched.map((u) => `«${u}»`).join(", ")}</div> : null}
                      </div>
                    );
                  })
                : null}
              {row("Tiềm năng", () => <span className="text-xs text-muted-foreground">chưa đo được — mẫu chưa gắn nhóm hàng của shop</span>)}
              {row("Link nguồn", (it) => {
                const href = safeHttpUrl(it.canonicalUrl);
                return href ? (
                  <a className="break-all text-xs text-primary underline" href={href} target="_blank" rel="noopener noreferrer">
                    mở trang nguồn
                  </a>
                ) : (
                  "—"
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
      <p className="text-xs text-muted-foreground">Giá về Việt Nam là số ƯỚC TÍNH theo tham số đã khai — không vào giá vốn. Không tô màu, không xếp hạng: số nhập tay chưa đủ căn cứ để kết luận mẫu nào tốt hơn.</p>
    </div>
  );
}
