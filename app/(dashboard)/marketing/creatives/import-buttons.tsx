"use client";

import { CheckCircle2, Download, Loader2, Megaphone } from "lucide-react";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { importOwnAdsAction, importPancakeProductPhotosAction, previewOwnAdCandidatesAction } from "@/lib/actions/creative-import";
import { OWN_AD_IMPORT, OWN_AD_REASON_LABEL } from "@/lib/constants/creative-loop";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { OwnAdCandidateList } from "@/lib/queries/creative-own-ads";
import { cn } from "@/lib/utils";

/** Kiểu tóm tắt lấy từ CHÍNH action — client không nhập tệp chỉ-máy-chủ `lib/creative/import`, kể cả chỉ để lấy kiểu. */
type OwnAdImportSummary = Extract<Awaited<ReturnType<typeof importOwnAdsAction>>, { summary: unknown }>["summary"];

/**
 * Hai nút nhập nguồn ảnh có sẵn ở tab Nguồn ảnh (`lib/actions/creative-import.ts`):
 *  · "Nhập ảnh sản phẩm từ Pancake" — một lần bấm, bấm lại không đẻ bản trùng.
 *  · "Nhập mẫu thắng / mẫu tốt từ Facebook" — HAI bước: xem trước danh sách (chỉ đọc CSDL) → chọn → nhập.
 */

export function PancakePhotoImportButton() {
  const [pending, start] = useTransition();
  const router = useRouter();
  const chay = () =>
    start(async () => {
      const r = await importPancakeProductPhotosAction();
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      const s = r.summary;
      const loi = s.failed.slice(0, 4).map((f) => `${f.name}: ${f.reason}`);
      const moTa = [
        `${formatNumber(s.scanned)} mã đang bán có ảnh trên Pancake · đã có sẵn ${formatNumber(s.existing)}`,
        s.remaining ? `Còn ${formatNumber(s.remaining)} mã chưa thử (chạm trần một lượt) — bấm lại để nhập tiếp.` : "",
        ...loi,
        s.failed.length > loi.length ? `… và ${s.failed.length - loi.length} lỗi khác.` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const tieuDe = s.scanned === 0 ? "Không có mã đang bán nào có ảnh trên Pancake" : `Đã nhập ${formatNumber(s.imported.length)} ảnh sản phẩm thật${s.failed.length ? ` · ${formatNumber(s.failed.length)} lỗi` : ""}`;
      (s.failed.length ? toast.warning : toast.success)(tieuDe, { description: <span className="whitespace-pre-line">{moTa}</span>, duration: 10_000 });
      if (s.imported.length) router.refresh();
    });
  return (
    <Button size="sm" variant="outline" onClick={chay} disabled={pending} title="Tải ảnh chính của mọi mã đang bán trên Pancake thành “Ảnh sản phẩm thật”. Mã đã có ảnh từ đúng địa chỉ ấy thì bỏ qua.">
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Nhập ảnh sản phẩm từ Pancake
    </Button>
  );
}

function HaiTang({ tren, duoi }: { tren: ReactNode; duoi?: ReactNode }) {
  return (
    <div className="leading-tight">
      <div className="tabular-nums">{tren}</div>
      {duoi ? <div className="text-[11px] text-muted-foreground">{duoi}</div> : null}
    </div>
  );
}

export function OwnAdImportDialog() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<OwnAdCandidateList | null>(null);
  const [winAbove, setWinAbove] = useState<number | null>(null);
  const [chon, setChon] = useState<Set<string>>(new Set());
  const [ketQua, setKetQua] = useState<OwnAdImportSummary | null>(null);
  const [loading, startLoad] = useTransition();
  const [importing, startImport] = useTransition();
  const router = useRouter();

  const mo = () => {
    setOpen(true);
    setKetQua(null);
    startLoad(async () => {
      const r = await previewOwnAdCandidatesAction();
      if ("error" in r) {
        toast.error(r.error);
        setOpen(false);
        return;
      }
      setList(r.list);
      setWinAbove(r.winOrdersAbove);
      setChon(new Set(r.list.rows.filter((x) => !x.importedSourceId).slice(0, OWN_AD_IMPORT.maxPerImport).map((x) => x.adId)));
    });
  };

  const chuaNhap = useMemo(() => (list?.rows ?? []).filter((x) => !x.importedSourceId), [list]);
  const doiChon = (adId: string, bat: boolean) =>
    setChon((cu) => {
      const moi = new Set(cu);
      if (bat && moi.size < OWN_AD_IMPORT.maxPerImport) moi.add(adId);
      else moi.delete(adId);
      return moi;
    });

  const nhap = () =>
    startImport(async () => {
      const r = await importOwnAdsAction({ adIds: [...chon] });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setKetQua(r.summary);
      // Đánh dấu ngay trên danh sách đang mở — không bắt người xem bấm "đã có" lần hai.
      const daCo = new Map<string, string>([...r.summary.imported.map((x) => [x.adId, x.sourceId] as const), ...r.summary.existing.map((x) => [x.adId, "?"] as const)]);
      setList((cu) => (cu ? { ...cu, rows: cu.rows.map((x) => (daCo.has(x.adId) ? { ...x, importedSourceId: daCo.get(x.adId) ?? "?" } : x)) } : cu));
      setChon((cu) => new Set([...cu].filter((id) => !daCo.has(id))));
      toast.success(`Đã nhập ${formatNumber(r.summary.imported.length)} quảng cáo cũ của shop`);
      if (r.summary.imported.length) router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="outline" onClick={mo} title="Xem trước mẫu thắng / mẫu có chỉ số tốt của chính shop rồi chọn mẩu để nhập làm nguồn ảnh.">
        <Megaphone className="size-4" /> Nhập mẫu thắng / mẫu tốt từ Facebook
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Nhập mẫu thắng / mẫu tốt của shop từ Facebook</DialogTitle>
            <DialogDescription>
              Mẩu QC có chi trong {OWN_AD_IMPORT.lookbackDays} ngày gần nhất, ít nhất {OWN_AD_IMPORT.minMessages} tin nhắn, và: <b>THẮNG</b> (đơn chốt vượt{" "}
              {winAbove === null ? "ngưỡng thắng" : formatNumber(winAbove)}) hoặc <b>TỐT</b> (chi / tin nhắn cả đời dưới {formatVND(OWN_AD_IMPORT.goodCostPerMessageBelowVnd)}, đã chi từ{" "}
              {formatVND(OWN_AD_IMPORT.goodMinSpendVnd)}). Số đo đọc từ dữ liệu ERP đã đồng bộ; bấm nhập thì máy mới đọc ảnh + câu chữ của mẩu trên Facebook. Chỉ nhận quảng
              cáo MỘT ảnh — video, băng chuyền, quảng cáo động bị bỏ kèm lý do.
            </DialogDescription>
          </DialogHeader>

          {loading || !list ? (
            <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Đang đọc số đo quảng cáo…
            </div>
          ) : list.rows.length === 0 ? (
            <p className="py-6 text-[13px] text-muted-foreground">
              Không mẩu nào đạt ngưỡng (đã xét {formatNumber(list.scanned)} mẩu có chi từ {list.since} và đủ tin nhắn). Số đo cấp mẩu chỉ có từ khi bật đồng bộ hạt quảng cáo.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[12.5px]">
                <thead className="bg-muted/50 text-left text-[11.5px] text-muted-foreground">
                  <tr>
                    <th className="w-8 px-2 py-1.5" />
                    <th className="px-2 py-1.5">Quảng cáo</th>
                    <th className="px-2 py-1.5">Vì sao</th>
                    <th className="px-2 py-1.5 text-right">Chi · tin nhắn</th>
                    <th className="px-2 py-1.5 text-right">Chi / tin</th>
                    <th className="px-2 py-1.5 text-right">CTR · CPC</th>
                    <th className="px-2 py-1.5 text-right" title="Đơn chốt quy về ad_id (không huỷ) · giao / hoàn theo kết quả đơn">
                      Đơn
                    </th>
                    <th className="px-2 py-1.5">Kỳ đo</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((c) => (
                    <tr key={c.adId} className={cn("border-t", c.importedSourceId && "opacity-60")}>
                      <td className="px-2 py-1.5 align-top">
                        {c.importedSourceId ? (
                          <CheckCircle2 className="size-4 text-success" aria-label="Đã nhập" />
                        ) : (
                          <Checkbox checked={chon.has(c.adId)} onCheckedChange={(v) => doiChon(c.adId, v === true)} aria-label={`Chọn ${c.adName || c.adId}`} />
                        )}
                      </td>
                      <td className="max-w-[320px] px-2 py-1.5 align-top">
                        <HaiTang tren={<span className="line-clamp-1 font-medium">{c.adName || c.adId}</span>} duoi={<span className="line-clamp-1">{c.importedSourceId ? "Đã nhập · " : ""}{c.campaignName || "—"} · {c.adId}</span>} />
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", c.reason === "WIN" ? "bg-success/15 text-success" : "bg-primary/10 text-primary")}>{OWN_AD_REASON_LABEL[c.reason]}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right align-top">
                        <HaiTang tren={formatVND(c.spendVnd)} duoi={`${formatNumber(c.messages)} tin`} />
                      </td>
                      <td className="px-2 py-1.5 text-right align-top tabular-nums">{formatVND(c.costPerMessageVnd)}</td>
                      <td className="px-2 py-1.5 text-right align-top">
                        <HaiTang tren={formatPercent(c.ctrPct, 2)} duoi={formatVND(c.cpcVnd)} />
                      </td>
                      <td className="px-2 py-1.5 text-right align-top">
                        <HaiTang tren={formatNumber(c.bookedOrders)} duoi={`giao ${formatNumber(c.deliveredOrders)} · hoàn ${formatNumber(c.returnedOrders)}`} />
                      </td>
                      <td className="px-2 py-1.5 align-top text-[11.5px] text-muted-foreground">
                        {c.periodFrom ?? "—"}
                        <br />→ {c.periodTo ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {ketQua ? (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-[12.5px]">
              <p>
                <b>Đã nhập {formatNumber(ketQua.imported.length)}</b> · đã có sẵn {formatNumber(ketQua.existing.length)} · bỏ qua {formatNumber(ketQua.skipped.length)}
              </p>
              {ketQua.noProduct.length ? (
                <p className="text-warning">
                  {formatNumber(ketQua.noProduct.length)} mẩu chưa suy được mã hàng (không có đơn mang mã quảng cáo này, tên chiến dịch không ghép được mã) — chúng chỉ làm nguồn
                  cảm hứng, chưa làm mẫu cha được.
                </p>
              ) : null}
              {ketQua.skipped.length ? (
                <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {ketQua.skipped.map((x) => (
                    <li key={x.adId}>
                      {x.name || x.adId}: {x.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-muted-foreground">Máy đọc gen của các nguồn mới ở lượt chạy kế tiếp; nguồn đủ sáu gen + có mã hàng có ảnh thật sẽ làm mẫu cha cho ô khai thác.</p>
            </div>
          ) : null}

          <DialogFooter className="items-center gap-2 sm:justify-between">
            <p className="text-[11.5px] text-muted-foreground">
              {list ? `Chọn ${formatNumber(chon.size)} / ${formatNumber(chuaNhap.length)} mẩu chưa nhập · tối đa ${OWN_AD_IMPORT.maxPerImport} mỗi lượt` : ""}
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={importing}>
                Đóng
              </Button>
              <Button type="button" onClick={nhap} disabled={importing || loading || chon.size === 0}>
                {importing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Nhập {formatNumber(chon.size)} mẩu
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
