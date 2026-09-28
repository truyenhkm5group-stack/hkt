import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import type { MusicRow, RunRow, WinProductRow } from "@/lib/queries/video-scale";
import { CreateRunDialog } from "./create-run-dialog";
import { CancelRunButton, SkuModeSelect } from "./small-actions";
import { PauseButton, SkuPublishingSelect } from "./publishing-controls";
import { SkuAdsForm } from "./ads-controls";

const RUN_STATUS_LABEL: Record<string, string> = {
  SCRIPTING: "Đang viết kịch bản",
  PRODUCING: "Đang sản xuất",
  REVIEW: "Chờ duyệt",
  DONE: "Xong",
  FAILED: "Hỏng",
  CANCELLED: "Đã huỷ",
};

/** Tab "Mã win": mỗi mã một thẻ — ảnh, trạng thái khai, số ảnh gốc, số video theo bước, nút tạo chiến dịch media. */
export function WinPanel({ products, runs, music, pages, accounts, canSpend, canEdit, canMode, canMoney, canEngage, canRelease, perVideoUsd = null, costNote = "" }: { products: WinProductRow[]; runs: RunRow[]; music: MusicRow[]; pages: { id: string; name: string }[]; accounts: { id: string; name: string }[]; canSpend: boolean; canEdit: boolean; canMode: boolean; canMoney: boolean; canEngage: boolean; canRelease: boolean; perVideoUsd?: number | null; costNote?: string }) {
  return (
    <div className="space-y-5">
      {products.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-[13px] text-muted-foreground">
          Chưa có mã nào được KHAI từ &ldquo;Thắng test&rdquo; trở đi ở trang Mẫu. Video Scale chỉ chạy cho mã win — máy không tự coi một mã là thắng.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {products.map((p) => (
            <div key={p.productId} className="flex gap-3 rounded-lg border p-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- ảnh Pancake, URL ngoài */}
              {p.image ? <img src={p.image} alt="" className="size-20 shrink-0 rounded object-cover" loading="lazy" /> : <div className="size-20 shrink-0 rounded bg-muted" />}
              <div className="min-w-0 flex-1 space-y-1 text-[13px]">
                <p className="font-semibold">
                  {p.code || "—"} <span className="font-normal text-muted-foreground">{p.name}</span>
                </p>
                <div className="flex flex-wrap gap-1">
                  <Badge variant="secondary">{p.stateLabel || "Mã win"}</Badge>
                  <Badge variant={p.photoCount ? "outline" : "destructive"}>{p.photoCount} ảnh gốc</Badge>
                  {p.inProduction ? <Badge variant="outline">{p.inProduction} đang làm</Badge> : null}
                  {p.awaitingReview ? <Badge>{p.awaitingReview} chờ duyệt</Badge> : null}
                  {p.approved ? <Badge variant="outline">{p.approved} đã duyệt</Badge> : null}
                </div>
                {p.photoCount === 0 ? <p className="text-[12px] text-muted-foreground">Chưa có ảnh sản phẩm thật: Thư viện Media → Nguồn ảnh → Nhập ảnh sản phẩm từ Pancake.</p> : null}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {canSpend && p.photoCount > 0 ? <CreateRunDialog productId={p.productId} label={`${p.code} ${p.name}`} music={music.map((m) => ({ id: m.id, title: m.title }))} perVideoUsd={perVideoUsd} costNote={costNote} /> : null}
                  <SkuModeSelect productId={p.productId} value={p.reviewMode ?? "MANUAL"} disabled={!canMode} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SkuPublishingSelect productId={p.productId} pageId={p.pageId} publishMode={p.publishMode} pages={pages} disabled={!canMode} />
                  <PauseButton scope="SKU" id={p.productId} paused={Boolean(p.pausedAt)} reason={p.pausedReason} canEngage={canEngage} canRelease={canRelease} label="mã" />
                </div>
                {p.pausedAt ? <p className="text-[12px] text-destructive">Mã đang dừng khẩn cấp{p.pausedReason ? `: ${p.pausedReason}` : ""}.</p> : null}
                <SkuAdsForm productId={p.productId} accounts={accounts} value={{ adAccountId: p.adAccountId, adsMode: p.adsMode, dailyBudgetPerAdVnd: p.dailyBudgetPerAdVnd, skuDailyCapVnd: p.skuDailyCapVnd, autoScale: p.autoScale, autoNextRound: p.autoNextRound, adsModeBy: p.adsModeBy }} disabled={!canMoney} />
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold">Lượt tạo gần đây</h2>
        {runs.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Chưa có lượt nào.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-[12.5px]">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-2 py-1.5">Lúc</th>
                  <th className="px-2 py-1.5">Mã</th>
                  <th className="px-2 py-1.5">Trạng thái</th>
                  <th className="px-2 py-1.5 text-right">Biến thể</th>
                  <th className="px-2 py-1.5 text-right">Chi ước tính</th>
                  <th className="px-2 py-1.5">Người tạo</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-2 py-1.5 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                    <td className="px-2 py-1.5">
                      {r.productName}
                      {r.isTest ? <Badge variant="destructive" className="ml-1">DỮ LIỆU THỬ</Badge> : null}
                      {r.error ? <p className="mt-0.5 text-[11.5px] text-muted-foreground">{r.error}</p> : null}
                    </td>
                    <td className="px-2 py-1.5">{RUN_STATUS_LABEL[r.status] ?? r.status}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {r.variants}/{r.variantsRequested}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums" title="Ước tính theo bảng giá; giữ chỗ gồm cả lượt hỏng">
                      {r.costUsd === null ? "—" : `${r.costUsd.toFixed(2)} USD`}
                      {r.reservedUsd > 0 ? <span className="block text-[11px] text-muted-foreground">giữ {r.reservedUsd.toFixed(2)}</span> : null}
                    </td>
                    <td className="px-2 py-1.5">{r.createdBy}</td>
                    <td className="px-2 py-1.5 text-right">{canEdit && ["SCRIPTING", "PRODUCING"].includes(r.status) ? <CancelRunButton runId={r.id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
