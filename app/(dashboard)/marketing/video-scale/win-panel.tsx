import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import type { MusicRow, RunRow, WinProductRow } from "@/lib/queries/video-scale";
import { CancelRunButton } from "./small-actions";
import { WinGrid } from "./win-grid";

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
        <WinGrid
          products={products}
          music={music.map((m) => ({ id: m.id, title: m.title, assetId: m.assetId }))}
          pages={pages}
          accounts={accounts}
          canSpend={canSpend}
          canMode={canMode}
          canMoney={canMoney}
          canEngage={canEngage}
          canRelease={canRelease}
          perVideoUsd={perVideoUsd}
          costNote={costNote}
        />
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
