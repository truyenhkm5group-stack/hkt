"use client";

import { CheckCircle2, Download, Loader2, Megaphone } from "lucide-react";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { importOwnAdsAction, importPancakeProductPhotosAction, previewOwnAdCandidatesAction } from "@/lib/actions/creative-import";
import { ProductSearch } from "@/app/(dashboard)/marketing/creatives/product-search";
import { OWN_AD_IMPORT, OWN_AD_REASON_LABEL } from "@/lib/constants/creative-loop";
import { OWN_AD_RANK_METRICS, OWN_AD_RANK_METRIC_LABEL, OWN_AD_RANK_STATUS_LABEL, type OwnAdMode } from "@/lib/constants/own-ad-ranking";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import type { OwnAdCandidate, OwnAdCandidateList } from "@/lib/queries/creative-own-ads";
import type { ProductOption } from "@/lib/queries/creative-sources";
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

/** Ô điểm: hạng + điểm (nhánh xếp hạng) hoặc nhãn luật cũ kèm điểm để đọc; chưa đủ dữ liệu thì nói ra, không chấm. */
function DiemCell({ c, mode, rankedOf }: { c: OwnAdCandidate; mode: OwnAdMode; rankedOf: number }) {
  const r = c.rank;
  const chiTiet = OWN_AD_RANK_METRICS.map((m) => `${OWN_AD_RANK_METRIC_LABEL[m]}: ${r.percentiles[m] === null ? "—" : `hơn ${Math.round((r.percentiles[m] as number) * 100)}% nhóm`}`).join("\n");
  const diem =
    r.status === "RANKED" ? (
      <span title={`Điểm = trung bình thứ hạng phần trăm trong các mẩu của shop (không ngưỡng tiền)\n${chiTiet}`}>
        #{formatNumber(r.rank)}/{formatNumber(rankedOf)} · <b>{formatNumber(r.score)}</b>
      </span>
    ) : (
      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] font-semibold text-warning" title={r.insufficientReason ?? undefined}>
        {OWN_AD_RANK_STATUS_LABEL[r.status]}
      </span>
    );
  if (mode === "RANK") return <HaiTang tren={diem} duoi={r.status === "RANKED" ? "điểm / 100" : (r.insufficientReason ?? "")} />;
  return (
    <HaiTang
      tren={c.reason ? <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", c.reason === "WIN" ? "bg-success/15 text-success" : "bg-primary/10 text-primary")}>{OWN_AD_REASON_LABEL[c.reason]}</span> : "—"}
      duoi={diem}
    />
  );
}

export function OwnAdImportDialog({ products }: { products: ProductOption[] }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<OwnAdCandidateList | null>(null);
  const [winAbove, setWinAbove] = useState<number | null>(null);
  const [chon, setChon] = useState<Set<string>>(new Set());
  /** Mã hàng người nhập chọn cho từng mẩu (mẩu → products.id) — máy không đoán khi không suy được. */
  const [maChon, setMaChon] = useState<Record<string, string>>({});
  const [ketQua, setKetQua] = useState<OwnAdImportSummary | null>(null);
  const [loading, startLoad] = useTransition();
  const [importing, startImport] = useTransition();

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
      setMaChon({});
      // Nhánh luật cũ: mọi mẩu đã ĐẠT ngưỡng nên chọn sẵn. Nhánh xếp hạng: không mẩu nào "đạt" — người chọn từ đầu bảng.
      setChon(r.list.mode === "CLASSIFY" ? new Set(r.list.rows.filter((x) => !x.importedSourceId).slice(0, OWN_AD_IMPORT.maxPerImport).map((x) => x.adId)) : new Set());
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
  const chonDauBang = () => setChon(new Set(chuaNhap.filter((x) => x.rank.status === "RANKED").slice(0, OWN_AD_IMPORT.maxPerImport).map((x) => x.adId)));

  const nhap = () =>
    startImport(async () => {
      const productIds = Object.fromEntries(Object.entries(maChon).filter(([adId, pid]) => chon.has(adId) && pid));
      const r = await importOwnAdsAction({ adIds: [...chon], productIds });
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
    });

  const mode: OwnAdMode = list?.mode ?? "CLASSIFY";
  const chiSoDung = list ? list.ranking.metricsUsed.map((m) => OWN_AD_RANK_METRIC_LABEL[m]).join(" · ") : "";

  return (
    <>
      <Button size="sm" variant="outline" onClick={mo} title="Xem trước mẫu thắng / mẫu có chỉ số tốt của chính shop rồi chọn mẩu để nhập làm nguồn ảnh.">
        <Megaphone className="size-4" /> Nhập mẫu thắng / mẫu tốt từ Facebook
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>Nhập mẫu thắng / mẫu tốt của shop từ Facebook</DialogTitle>
            {mode === "CLASSIFY" ? (
              <DialogDescription>
                Mẩu QC có chi trong {OWN_AD_IMPORT.lookbackDays} ngày gần nhất, ít nhất {OWN_AD_IMPORT.minMessages} tin nhắn, và: <b>THẮNG</b> (đơn chốt vượt{" "}
                {winAbove === null ? "ngưỡng thắng" : formatNumber(winAbove)}) hoặc <b>TỐT</b> (chi / tin nhắn cả đời dưới {formatVND(OWN_AD_IMPORT.goodCostPerMessageBelowVnd)}, đã chi từ{" "}
                {formatVND(OWN_AD_IMPORT.goodMinSpendVnd)}). Số đo đọc từ dữ liệu ERP đã đồng bộ; bấm nhập thì máy mới đọc ảnh + câu chữ của mẩu trên Facebook. Chỉ nhận quảng
                cáo MỘT ảnh — video, băng chuyền, quảng cáo động bị bỏ kèm lý do.
              </DialogDescription>
            ) : (
              <DialogDescription>
                Shop chưa có đơn quy về mẩu quảng cáo, nên máy <b>xếp hạng tương đối</b> mọi mẩu có chi trong {OWN_AD_IMPORT.lookbackDays} ngày gần nhất, so với CHÍNH các mẩu
                của shop: chi nhiều · chi / tin nhắn rẻ · nhiều lượt mua · chi / lượt mua rẻ (lượt mua theo Meta). Điểm 0–100 = trung bình thứ hạng phần trăm — không có ngưỡng
                tiền nào. Mẩu dưới {formatNumber(list?.ranking.minEvents ?? OWN_AD_IMPORT.minMessages)} sự kiện (tin nhắn + lượt mua) là <b>chưa đủ dữ liệu</b>, không phải kém. Bấm
                nhập thì máy mới đọc ảnh + câu chữ của mẩu trên Facebook; chỉ nhận quảng cáo MỘT ảnh của chính tài khoản shop. Mẩu không suy được mã hàng: chọn mã ở cột «Mã hàng»
                để ảnh làm tham chiếu bố cục / phong cách cho mã đó.
              </DialogDescription>
            )}
          </DialogHeader>

          {list && list.rows.length > 0 ? (
            <p className="text-[11.5px] text-muted-foreground">
              Điểm tính trên {formatNumber(list.ranking.ranked)} mẩu đủ dữ liệu (chưa đủ: {formatNumber(list.ranking.insufficient)}) · chỉ số dùng: {chiSoDung || "—"}
              {list.ranking.metricsSkipped.length ? ` · bỏ: ${list.ranking.metricsSkipped.map((x) => `${OWN_AD_RANK_METRIC_LABEL[x.metric]} (${x.reason})`).join(" · ")}` : ""}
            </p>
          ) : null}

          {loading || !list ? (
            <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Đang đọc số đo quảng cáo…
            </div>
          ) : list.rows.length === 0 ? (
            <p className="py-6 text-[13px] text-muted-foreground">
              {mode === "CLASSIFY"
                ? `Không mẩu nào đạt ngưỡng (đã xét ${formatNumber(list.scanned)} mẩu có chi từ ${list.since} và đủ tin nhắn).`
                : `Chưa có mẩu nào có chi từ ${list.since}.`}{" "}
              Số đo cấp mẩu chỉ có từ khi bật đồng bộ hạt quảng cáo.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[12.5px]">
                <thead className="bg-muted/50 text-left text-[11.5px] text-muted-foreground">
                  <tr>
                    <th className="w-8 px-2 py-1.5" />
                    <th className="px-2 py-1.5">Quảng cáo</th>
                    <th className="px-2 py-1.5" title="Hạng / số mẩu đã xếp hạng · điểm 0–100. Rê chuột để xem thứ hạng từng chỉ số.">
                      {mode === "RANK" ? "Hạng · điểm" : "Vì sao · điểm"}
                    </th>
                    <th className="px-2 py-1.5 text-right">Chi · tin nhắn</th>
                    <th className="px-2 py-1.5 text-right" title="Lượt mua và chi / lượt mua THEO META (đồng bộ chi tiêu) — không phải đơn ERP">
                      Mua (Meta)
                    </th>
                    <th className="px-2 py-1.5 text-right">CTR · CPC</th>
                    <th className="px-2 py-1.5 text-right" title="Đơn chốt quy về ad_id (không huỷ) · giao / hoàn theo kết quả đơn">
                      Đơn ERP
                    </th>
                    <th className="px-2 py-1.5">Mã hàng</th>
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
                      <td className="max-w-[260px] px-2 py-1.5 align-top">
                        <HaiTang tren={<span className="line-clamp-1 font-medium">{c.adName || c.adId}</span>} duoi={<span className="line-clamp-1">{c.importedSourceId ? "Đã nhập · " : ""}{c.campaignName || "—"} · {c.adId}</span>} />
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <DiemCell c={c} mode={mode} rankedOf={list.ranking.ranked} />
                      </td>
                      <td className="px-2 py-1.5 text-right align-top">
                        <HaiTang tren={formatVND(c.spendVnd)} duoi={`${formatNumber(c.messages)} tin · ${formatVND(c.costPerMessageVnd)}/tin`} />
                      </td>
                      <td className="px-2 py-1.5 text-right align-top">
                        <HaiTang tren={formatNumber(c.metaPurchases)} duoi={c.costPerMetaPurchaseVnd === null ? "—" : `${formatVND(c.costPerMetaPurchaseVnd)}/lượt`} />
                      </td>
                      <td className="px-2 py-1.5 text-right align-top">
                        <HaiTang tren={formatPercent(c.ctrPct, 2)} duoi={formatVND(c.cpcVnd)} />
                      </td>
                      <td className="px-2 py-1.5 text-right align-top">
                        <HaiTang tren={formatNumber(c.bookedOrders)} duoi={`giao ${formatNumber(c.deliveredOrders)} · hoàn ${formatNumber(c.returnedOrders)}`} />
                      </td>
                      <td className="w-[200px] px-2 py-1.5 align-top">
                        {chon.has(c.adId) && !c.importedSourceId ? (
                          <div className="space-y-0.5">
                            <ProductSearch
                              products={products}
                              value={maChon[c.adId] ?? ""}
                              onChange={(pid) => setMaChon((cu) => ({ ...cu, [c.adId]: pid }))}
                              placeholder={c.inferredProduct ? "Đổi mã…" : "Chọn mã hàng…"}
                            />
                            {!maChon[c.adId] ? (
                              <p className={cn("text-[11px]", c.inferredProduct ? "text-muted-foreground" : "text-warning")}>
                                {c.inferredProduct ? `Suy được: ${c.inferredProduct.name}` : "Chưa suy được mã — chọn để làm mẫu cha"}
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <span className={cn("line-clamp-2 text-[11.5px]", c.inferredProduct ? "" : "text-muted-foreground")}>{c.inferredProduct?.name ?? "Chưa suy được"}</span>
                        )}
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
                  {formatNumber(ketQua.noProduct.length)} mẩu chưa có mã hàng (không suy được, người nhập chưa chọn) — chúng chỉ làm nguồn cảm hứng, chưa làm mẫu cha được.
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
              {mode === "RANK" && list ? (
                <Button type="button" variant="outline" onClick={chonDauBang} disabled={importing || loading}>
                  Chọn {formatNumber(Math.min(OWN_AD_IMPORT.maxPerImport, chuaNhap.filter((x) => x.rank.status === "RANKED").length))} mẩu đầu bảng
                </Button>
              ) : null}
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
