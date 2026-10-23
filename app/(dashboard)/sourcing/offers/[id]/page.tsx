import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { LandedCostCell } from "@/components/sourcing/landed-cost-view";
import { AddWeightForm, ArchiveOfferForm, AddSnapshotForm, EditOfferForm, SupplierFactsForm } from "@/components/sourcing/offer-forms";
import { DataAge, OfferImage, TiersText } from "@/components/sourcing/offer-bits";
import { PageHeader } from "@/components/page-header";
import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import {
  EMPTY_LANDED_COST,
  EMPTY_SCORE_WEIGHTS,
  SOURCING_COMPARE_QUANTITIES,
  SOURCING_LANDED_COST_KEY,
  SOURCING_PLATFORM_LABEL,
  SOURCING_SCORE_WEIGHTS_KEY,
  parseLandedCost,
  parseScoreWeights,
} from "@/lib/constants/sourcing";
import { formatDateTime, formatNumber, vnDateKey } from "@/lib/format";
import { getSourcingOffer, latestOfferWeights } from "@/lib/queries/sourcing";
import { getSettingJson } from "@/lib/settings";
import { landedConfigEmpty, landedCostAtQty } from "@/lib/sourcing/landed-cost";
import { supplierScore } from "@/lib/sourcing/score";
import { safeHttpUrl } from "@/lib/sourcing/offer-url";
import { formatCny, formatHundredths } from "@/lib/sourcing/price";

export const metadata = { title: "Mẫu nguồn" };

/** Chi tiết một mẫu nguồn (SRC-3): thông tin, lịch sử chụp giá (chỉ thêm), nhà cung cấp, cờ trùng ảnh, lưu trữ. */
export default async function SourcingOfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePermission("sourcing:view");
  const canWrite = can(user, "sourcing:write");
  const [detail, landed, weights] = await Promise.all([
    getSourcingOffer(id),
    getSettingJson<unknown>(SOURCING_LANDED_COST_KEY, EMPTY_LANDED_COST).then(parseLandedCost),
    getSettingJson<unknown>(SOURCING_SCORE_WEIGHTS_KEY, EMPTY_SCORE_WEIGHTS).then(parseScoreWeights),
  ]);
  if (detail && "unavailable" in detail) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Tìm hàng nguồn" title="Mẫu nguồn" />
        <p className="text-sm text-amber-700 dark:text-amber-300">CSDL của tổ chức chưa áp migration 0256 (kho mẫu nguồn).</p>
      </div>
    );
  }
  if (!detail) notFound();
  const { offer, supplier, snapshots, sameImage } = detail;
  const now = new Date();
  const latest = snapshots[0] ?? null;
  const link = safeHttpUrl(offer.canonicalUrl);
  const weightRows = await latestOfferWeights([offer.id], 10);
  const weightHistory = weightRows.byOffer.get(offer.id) ?? [];
  const grams = weightHistory[0]?.grams ?? null;
  const score = supplierScore(supplier, weights);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tìm hàng nguồn"
        title={offer.titleVi || "(chưa đặt tên)"}
        description={
          <>
            {SOURCING_PLATFORM_LABEL[offer.platform]} · {offer.offerId ? `mã ${offer.offerId}` : "không có mã"}
            {offer.archivedAt ? ` · lưu trữ từ ${formatDateTime(offer.archivedAt)}` : ""}
          </>
        }
        actions={
          <Link className="text-sm text-primary underline" href="/sourcing#kho-mau">
            ← Kho mẫu
          </Link>
        }
      />

      <SectionCard title="Mẫu">
        <div className="flex flex-col gap-4 md:flex-row">
          <OfferImage src={offer.imageUrl} alt={offer.titleVi} size={160} />
          <DescriptionList
            className="flex-1"
            items={[
              { label: "Tên tiếng Trung", value: offer.titleZh ? <span lang="zh-CN">{offer.titleZh}</span> : "—" },
              {
                label: "Link nguồn",
                value: link ? (
                  <a className="inline-flex items-center gap-1 break-all text-primary underline" href={link} target="_blank" rel="noopener noreferrer">
                    {offer.canonicalUrl}
                    <ExternalLink className="size-3.5 shrink-0" />
                  </a>
                ) : (
                  offer.canonicalUrl
                ),
                span: true,
              },
              { label: "Người lưu", value: `${offer.createdByName ?? "—"} · ${formatDateTime(offer.createdAt)}` },
              {
                label: "Có thể trùng ảnh",
                value: sameImage.length ? (
                  <span className="space-x-2">
                    {sameImage.map((m) => (
                      <Link key={m.id} className="text-primary underline" href={`/sourcing/offers/${m.id}`}>
                        {m.titleVi || m.id}
                        {m.archived ? " (lưu trữ)" : ""}
                      </Link>
                    ))}
                  </span>
                ) : offer.imageUrl ? (
                  "không thấy"
                ) : (
                  "chưa có link ảnh"
                ),
              },
            ]}
          />
        </div>
        {sameImage.length ? <p className="mt-3 text-xs text-muted-foreground">Cùng link ảnh chỉ là DẤU HIỆU — hai shop hay dùng chung ảnh. ERP không tự gộp; xem rồi tự quyết lưu trữ mẫu nào.</p> : null}
      </SectionCard>

      <SectionCard title="Giá theo bậc" description="Mỗi lần chụp là một dòng riêng, không ghi đè — giá nhảy thì đọc được. Tiền tệ là nhân dân tệ (¥), chưa quy ra giá về Việt Nam.">
        {snapshots.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-snapshot-history>
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Chụp lúc</th>
                  <th className="py-1 pr-3 font-medium">Bậc giá</th>
                  <th className="py-1 pr-3 font-medium">MOQ</th>
                  <th className="py-1 pr-3 font-medium">Màu / cỡ</th>
                  <th className="py-1 font-medium">Người ghi</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s, i) => (
                  <tr key={s.id} className="border-t align-top">
                    <td className="py-1.5 pr-3">
                      <div className="whitespace-nowrap">{formatDateTime(s.capturedAt)}</div>
                      {i === 0 ? <DataAge source={s.source} asOf={s.capturedAt} now={now} /> : null}
                    </td>
                    <td className="py-1.5 pr-3">
                      <TiersText tiers={s.tiers} />
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">{s.moq ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-xs">{s.skus ? [s.skus.colors.join(", "), s.skus.sizes.join(", ")].filter(Boolean).join(" · ") : "—"}</td>
                    <td className="py-1.5 text-xs">{s.capturedByName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa có lần chụp giá nào.</p>
        )}
        {canWrite ? (
          <div className="mt-4 border-t pt-4">
            <AddSnapshotForm
              offerId={offer.id}
              initial={{
                tiers: latest?.tiers?.map((t) => ({ fromQty: String(t.fromQty), price: formatCny(t.priceFen).replace("¥", "") })) ?? [],
                moq: latest?.moq ? String(latest.moq) : "",
                colors: latest?.skus?.colors.join(", ") ?? "",
                sizes: latest?.skus?.sizes.join(", ") ?? "",
              }}
            />
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Giá về Việt Nam (ước tính)" description="Theo tham số giá về đã khai và lần chụp giá mới nhất. Chỉ để so sánh — không vào giá vốn, không vào giá dự tính.">
        <div className="space-y-4 text-sm">
          {landedConfigEmpty(landed) ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Tham số giá về Việt Nam chưa khai — mọi ô in «—». Khai ở <Link className="underline" href="/sourcing">trang Tìm hàng nguồn</Link>.
            </p>
          ) : null}
          <div className="grid gap-3 md:grid-cols-4" data-landed-grid>
            {SOURCING_COMPARE_QUANTITIES.map((q) => (
              <div key={q} className="rounded-lg border p-2">
                <div className="mb-1 text-xs text-muted-foreground">Mỗi cái khi mua {q}</div>
                <LandedCostCell value={landedCostAtQty({ tiers: latest?.tiers ?? null, moq: latest?.moq ?? null, weightG: grams, qty: q, cfg: landed, now })} />
              </div>
            ))}
          </div>
          <div className="space-y-2 border-t pt-3">
            <p>
              Cân nặng một cái: <strong>{grams === null ? "chưa khai" : `${formatNumber(grams)} g`}</strong>
              {weightHistory[0] ? <span className="ml-1 text-xs text-muted-foreground">({formatDateTime(weightHistory[0].capturedAt)}{weightHistory[0].capturedByName ? ` · ${weightHistory[0].capturedByName}` : ""})</span> : null}
            </p>
            {weightRows.unavailable ? <p className="text-xs text-amber-700 dark:text-amber-300">CSDL của tổ chức chưa áp migration 0257 — chưa lưu được cân nặng.</p> : null}
            {weightHistory.length > 1 ? (
              <p className="text-xs text-muted-foreground">Lần khai trước: {weightHistory.slice(1).map((w) => `${formatNumber(w.grams)} g (${formatDateTime(w.capturedAt)})`).join(" · ")}</p>
            ) : null}
            {canWrite && !weightRows.unavailable ? <AddWeightForm offerId={offer.id} initialGrams={grams} /> : null}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Nhà cung cấp" description="Số trên trang nguồn, gõ tay. Ô trống là CHƯA BIẾT — không chấm điểm khi chưa đủ căn cứ.">
        {supplier ? (
          <div className="space-y-4">
            <DescriptionList
              columns={3}
              items={[
                { label: "Tên", value: supplier.name || "—" },
                {
                  label: "Link shop",
                  value: safeHttpUrl(supplier.shopUrl) ? (
                    <a className="break-all text-primary underline" href={safeHttpUrl(supplier.shopUrl)!} target="_blank" rel="noopener noreferrer">
                      {supplier.shopUrl}
                    </a>
                  ) : (
                    supplier.shopUrl
                  ),
                },
                { label: "Số năm trên nền tảng", value: supplier.yearsOnPlatform ?? "—" },
                { label: "Điểm đánh giá", value: supplier.ratingX100 === null ? "—" : `${formatHundredths(supplier.ratingX100)} / 5` },
                { label: "Tỷ lệ phản hồi", value: supplier.responseRateBp === null ? "—" : `${formatHundredths(supplier.responseRateBp)}%` },
                { label: "Đã xác minh", value: supplier.verified === null ? "—" : supplier.verified ? "có" : "không" },
                { label: "Gửi hàng từ", value: supplier.shipFrom ?? "—" },
                { label: "Số liệu", value: <DataAge source={supplier.factsSource} asOf={supplier.factsAsOf} now={now} /> },
                { label: "Điểm nhà cung cấp", value: `${score.total === null ? "—" : `${score.total} điểm (thang 100)`} · có số ${score.coverage.have}/${score.coverage.of} thành phần. ${score.totalNote}`, span: true },
              ]}
            />
            {canWrite ? (
              <div className="border-t pt-4">
                <SupplierFactsForm
                  offerId={offer.id}
                  supplierId={supplier.id}
                  initial={{
                    name: supplier.name,
                    years: supplier.yearsOnPlatform === null ? "" : String(supplier.yearsOnPlatform),
                    rating: supplier.ratingX100 === null ? "" : formatHundredths(supplier.ratingX100),
                    responseRate: supplier.responseRateBp === null ? "" : formatHundredths(supplier.responseRateBp),
                    verified: supplier.verified === null ? "" : supplier.verified ? "yes" : "no",
                    shipFrom: supplier.shipFrom ?? "",
                    factsAsOf: supplier.factsAsOf ? vnDateKey(supplier.factsAsOf) : "",
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Chưa gắn nhà cung cấp — thêm link shop ở «Sửa mẫu».</p>
        )}
      </SectionCard>

      {canWrite ? (
        <>
          <SectionCard title="Sửa mẫu">
            <EditOfferForm
              offerId={offer.id}
              initial={{ titleVi: offer.titleVi, titleZh: offer.titleZh, imageUrl: offer.imageUrl ?? "", shopUrl: supplier?.shopUrl ?? "", shopName: supplier?.name ?? "" }}
            />
          </SectionCard>
          <SectionCard title={offer.archivedAt ? "Khôi phục" : "Lưu trữ"} description="Không xoá mẫu: lưu trữ để danh sách gọn, vẫn tra lại được.">
            <ArchiveOfferForm offerId={offer.id} archived={offer.archivedAt !== null} />
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
