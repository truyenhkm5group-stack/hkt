"use client";

import * as React from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Barcode, Check, ChevronLeft, ChevronRight, FilterX, Layers, Loader2, PackageX, ScanLine, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ItemInspectionDrawer } from "@/app/(dashboard)/inventory/returns/item-inspection-drawer";
import { FacetPicker } from "@/app/(dashboard)/inventory/returns/facet-picker";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui-bits";
import { scanReturnByCode, submitBulkInspection, submitFullReturn, submitReturnInspection } from "@/lib/actions/returns-warehouse";
import { CONDITION_ACTION_LABEL, CONDITION_LABEL, CONDITION_NEEDS_NOTE, type ReturnCondition } from "@/lib/constants/returns-condition";
import { formatDate, formatNumber } from "@/lib/format";
import {
  activeFilterCount,
  BULK_INSPECT_PER_REQUEST,
  chiaMe,
  filterPending,
  PENDING_AGE,
  PENDING_AGE_LABEL,
  PENDING_FILTER_EMPTY,
  PENDING_LINK,
  PENDING_LINK_LABEL,
  PENDING_PAGE_SIZE_DEFAULT,
  PENDING_PAGE_SIZES,
  PENDING_SORT_HINT,
  PENDING_SORT_LABEL,
  PENDING_SORTS,
  PENDING_VARIETY,
  PENDING_VARIETY_LABEL,
  pendingFacets,
  sortPending,
  tallyPending,
  variantCount,
  type PendingFilter,
  type PendingPageSize,
  type PendingSortKey,
  type SortDir,
  type StationRow,
} from "@/lib/returns/inspection-filter";
import type { OrderLinkBasis } from "@/lib/returns/product-context";
import { cn } from "@/lib/utils";

/**
 * ═══════ TRẠM ĐẾM HÀNG HOÀN — MỘT MÀN HÌNH CHO CẢ VIỆC ═══════
 *
 * Hàng trăm kiện đang chờ. Ở nhịp "mở đơn ở tab khác để xem màu/size" thì đó là hơn một ngày công
 * chỉ để chuyển tab. Nên màn hình này gánh cả việc:
 *
 *  · BẮN MÃ → kiện nhảy lên đầu danh sách, tự chọn sẵn. Con trỏ luôn nằm trong ô mã, kể cả sau khi
 *    vừa xử lý xong một kiện — người đếm không bao giờ phải chạm chuột giữa hai kiện.
 *  · LỌC THEO MÃ HÀNG / MÀU / SIZE. Hàng trong kho nằm theo SỌT MẪU MÃ, không theo mã vận đơn: việc
 *    thật là "gom hết kiện có Q002 rồi đếm một lượt", không phải "xử lý kiện thứ 147".
 *  · MỖI DÒNG hiện sẵn đơn · khách · SĐT · từng mã hàng kèm màu, size, số lượng · HAI MỐC THỜI GIAN.
 *  · MỘT CHẠM ra kết luận. "Nhận đủ" là nút to nhất vì đó là ca chiếm đa số — và nay nó chạy được
 *    cho cả kiện NHIỀU mẫu mã, miễn là số đếm bằng số kỳ vọng.
 *  · HÀNG LOẠT khi nhiều kiện cùng kết luận — mở một xe hàng, mười kiện nguyên seal là một lần bấm.
 *
 * PHẢN HỒI TỨC THÌ, KHÔNG CHỜ MÁY CHỦ: kiện vừa xử lý biến khỏi danh sách ngay, rồi mới đồng bộ
 * lại phía sau. Nếu máy chủ báo lỗi thì kiện đó QUAY LẠI kèm thông báo — không mất việc, và cũng
 * không bắt người đếm đứng nhìn con quay 300ms mỗi kiện.
 *
 * ─── VÌ SAO LỌC Ở TRÌNH DUYỆT, VÀ ĐIỀU KIỆN ĐỂ ĐIỀU ĐÓ TRUNG THỰC ───
 *
 * Danh sách món trong kiện không nằm ở một cột nào — nó do `returnProductContext` dựng sau truy vấn
 * (xem `lib/returns/inspection-filter.ts`). Nên lọc chạy trên kết quả đã ghép, ngay tại trình duyệt:
 * bấm là thấy, không mất lượt đi máy chủ, và phần đang chọn không bị xoá giữa chừng.
 *
 * Điều đó CHỈ trung thực khi cả hàng đợi đã nằm trong tay. Trang tải tới `PENDING_STATION_CAP` kiện
 * và truyền xuống đây cả TỔNG THẬT; chạm trần thì dải cảnh báo nói thẳng đang lọc trong bao nhiêu
 * trên tổng bao nhiêu. Đây chính là cái bẫy đã sập một lần ở bàn nhận hàng: lọc trong một phần danh
 * sách rồi hiện "0 kiện", và người đứng ở kho đọc câu đó thành "kiện này không có trong hệ thống".
 */

export type Row = StationRow;

/** Kiện không có dòng hàng để đếm: nói đúng VÌ SAO — chưa ghép được đơn khác hẳn đơn không còn hàng. */
const KHONG_DONG_HANG: Record<OrderLinkBasis, string> = {
  AMBIGUOUS: "Mã gốc lần ra NHIỀU đơn — ERP không chọn hộ. Đếm theo thực tế, ghi rõ mã hàng ở ô lý do; CS gắn đơn sau.",
  UNRESOLVED: "Chưa lần ra đơn nào cho kiện này — đếm theo thực tế và ghi rõ mã hàng ở ô lý do.",
  DIRECT: "Đơn không còn dòng hàng nào trong ERP — đếm theo thực tế và ghi rõ ở ô lý do.",
  RETURN_LEG: "Đơn không còn dòng hàng nào trong ERP — đếm theo thực tế và ghi rõ ở ô lý do.",
};

const NHANH: { condition: ReturnCondition; icon: typeof Check; tone: string }[] = [
  { condition: "RESTOCKABLE", icon: Check, tone: "bg-emerald-600 hover:bg-emerald-700 text-white" },
  { condition: "MISSING", icon: TriangleAlert, tone: "" },
  { condition: "DAMAGED", icon: PackageX, tone: "" },
  { condition: "WRONG_ITEM", icon: Barcode, tone: "" },
];

export function InspectionStation({
  rows: initial,
  canWrite,
  total,
}: {
  rows: Row[];
  canWrite: boolean;
  /** TỔNG THẬT của hàng đợi phía máy chủ — để biết phần đang tải có phải toàn bộ hay không. */
  total: number;
}) {
  const [rows, setRows] = React.useState<Row[]>(initial);
  const [chon, setChon] = React.useState<Set<string>>(new Set());
  const [ma, setMa] = React.useState("");
  const [lyDo, setLyDo] = React.useState("");
  const [dangChay, setDangChay] = React.useState(false);
  const [loc, setLoc] = React.useState<PendingFilter>(PENDING_FILTER_EMPTY);
  const [sapTheo, setSapTheo] = React.useState<PendingSortKey>("receivedAt");
  const [chieu, setChieu] = React.useState<SortDir>("asc");
  const [trang, setTrang] = React.useState(0);
  const [moiTrang, setMoiTrang] = React.useState<PendingPageSize>(PENDING_PAGE_SIZE_DEFAULT);
  /** Tiến độ mẻ đang chạy — `null` = không có lượt hàng loạt nào. */
  const [tienDo, setTienDo] = React.useState<{ xong: number; tong: number } | null>(null);
  /**
   * Người kho khai ĐÃ ĐỐI CHIẾU THỰC TẾ với kiện mà danh sách món chỉ suy từ cả đơn.
   *
   * Mặc định TẮT và không nhớ qua lần tải trang: đây là một lời khẳng định về việc vừa làm bằng
   * tay, không phải một tuỳ chọn giao diện. Bật sẵn là biến nó thành chữ ký khống.
   */
  const [daDoiChieu, setDaDoiChieu] = React.useState(false);
  const oMa = React.useRef<HTMLInputElement>(null);

  // Danh sách phía máy chủ đổi (sau khi trang dựng lại) thì lấy lại — nhưng KHÔNG đè lên phần vừa xử lý cục bộ.
  React.useEffect(() => setRows(initial), [initial]);

  /** Con trỏ LUÔN quay về ô mã. Đây là thứ giữ nhịp bắn mã liên tục không cần chạm chuột. */
  const tuTuMa = React.useCallback(() => {
    requestAnimationFrame(() => oMa.current?.focus());
  }, []);

  React.useEffect(() => {
    tuTuMa();
  }, [tuTuMa]);

  const oChon = React.useMemo(() => pendingFacets(rows), [rows]);
  const daLoc = React.useMemo(() => sortPending(filterPending(rows, loc), sapTheo, chieu), [rows, loc, sapTheo, chieu]);
  const tong = React.useMemo(() => tallyPending(daLoc), [daLoc]);
  const soLoc = activeFilterCount(loc);

  /*
    TRANG PHẢI TỰ CO LẠI KHI DANH SÁCH NGẮN ĐI.

    Kiện xử lý xong biến khỏi danh sách ngay (phản hồi tức thì), nên đang đứng ở trang 9 mà xử lý hết
    một mẻ thì trang 9 có thể không còn tồn tại. Kẹp lại thay vì hiện một trang trống — người đếm
    nhìn thấy trang trống sẽ kết luận "hết việc rồi".
  */
  const tongTrang = Math.max(1, Math.ceil(daLoc.length / moiTrang));
  const trangHienTai = Math.min(trang, tongTrang - 1);
  React.useEffect(() => {
    if (trang > tongTrang - 1) setTrang(tongTrang - 1);
  }, [trang, tongTrang]);
  const hienThi = daLoc.slice(trangHienTai * moiTrang, (trangHienTai + 1) * moiTrang);
  /** Bộ lọc hay phép sắp xếp đổi ⇒ về trang đầu. Giữ nguyên trang 9 cho một kết quả 4 dòng là vô nghĩa. */
  React.useEffect(() => setTrang(0), [loc, sapTheo, chieu, moiTrang]);

  /*
    PHẦN ĐANG CHỌN KHÔNG TỰ BỎ THEO BỘ LỌC — NHƯNG PHẢI NHÌN THẤY ĐƯỢC.

    Gom một mẻ từ nhiều lượt lọc là việc có thật (ba sọt mẫu mã cùng vào một xe). Nên đổi bộ lọc
    KHÔNG xoá phần đã chọn. Cái nguy hiểm là bấm "xử lý 40 kiện" trong khi màn hình chỉ hiện 12 —
    nên số kiện đang chọn mà bộ lọc đang giấu được nói thẳng, kèm lối bỏ chúng ra.
  */
  const dangHien = React.useMemo(() => new Set(daLoc.map((r) => r.shipmentId)), [daLoc]);
  const chonBiAn = [...chon].filter((id) => !dangHien.has(id));

  const boKien = (id: string) => {
    setRows((r) => r.filter((x) => x.shipmentId !== id));
    setChon((c) => {
      const n = new Set(c);
      n.delete(id);
      return n;
    });
  };

  async function quet(e: React.FormEvent) {
    e.preventDefault();
    const q = ma.trim();
    if (!q) return;
    setDangChay(true);
    const r = await scanReturnByCode(q);
    setDangChay(false);
    setMa("");
    tuTuMa();
    if ("error" in r) {
      toast.error(r.error);
      return;
    }
    const found = r.found as Row;
    /*
      BỘ LỌC KHÔNG ĐƯỢC NUỐT KIỆN VỪA BẮN.

      Người đang cầm kiện trên tay bắn mã và kiện đó không thuộc bộ lọc hiện tại ⇒ nó sẽ không hiện
      ra, và màn hình trông y hệt lúc bắn trượt. Bỏ bộ lọc và NÓI RA vì sao — im lặng giữ bộ lọc là
      cách chắc chắn nhất để người kho kết luận "hệ thống không có kiện này".
    */
    if (soLoc && !filterPending([found], loc).length) {
      setLoc(PENDING_FILTER_EMPTY);
      toast.info("Đã bỏ bộ lọc: kiện vừa bắn không nằm trong phần đang lọc");
    }
    // Đưa lên ĐẦU danh sách và chọn sẵn: bắn xong là mắt nhìn thấy ngay, tay bấm được ngay.
    setRows((prev) => [found, ...prev.filter((x) => x.shipmentId !== found.shipmentId)]);
    setChon((c) => new Set(c).add(found.shipmentId));
    toast.success(`Đã tìm thấy ${found.code ?? found.shipmentId}`);
  }

  /** "Nhận đủ" cho kiện NHIỀU mẫu mã: mỗi dòng hàng về đúng số của nó, không phải một số tổng. */
  async function nhanDu(row: Row) {
    if (!canWrite) return;
    boKien(row.shipmentId);
    tuTuMa();
    const r = await submitFullReturn({ shipmentId: row.shipmentId, note: lyDo.trim(), orderOnlyConfirmed: daDoiChieu });
    if ("error" in r) {
      setRows((prev) => [row, ...prev]);
      toast.error(`${row.code ?? row.shipmentId}: ${r.error}`);
      return;
    }
    toast.success(r.message);
  }

  async function motKien(row: Row, condition: ReturnCondition, soLuong?: number) {
    if (!canWrite) return;
    if (CONDITION_NEEDS_NOTE[condition] && !lyDo.trim()) {
      toast.error(`Kết luận “${CONDITION_LABEL[condition]}” phải ghi lý do ở ô bên dưới trước khi bấm`);
      return;
    }
    // Không biết số kỳ vọng (kiện chưa ghép được đơn) thì KHÔNG được suy ra số nào — phải có số đếm tay.
    if (row.expectedQty === null && soLuong === undefined) {
      toast.error("Kiện này chưa ghép được đơn nên không biết số kỳ vọng — nhập số đếm được rồi mới kết luận");
      return;
    }
    const expected = row.expectedQty ?? soLuong ?? 0;
    const restock = condition === "RESTOCKABLE" ? (soLuong ?? expected) : 0;
    const unsellable = condition === "RESTOCKABLE" ? Math.max(0, expected - restock) : expected;

    // Biến mất NGAY. Máy chủ chạy phía sau.
    boKien(row.shipmentId);
    tuTuMa();

    const r = await submitReturnInspection({
      shipmentId: row.shipmentId,
      condition,
      restockQty: restock,
      unsellableQty: unsellable,
      note: lyDo.trim(),
    });
    if ("error" in r) {
      // Trả kiện về đúng chỗ cũ — không mất việc.
      setRows((prev) => [row, ...prev]);
      toast.error(`${row.code ?? row.shipmentId}: ${r.error}`);
      return;
    }
    toast.success(r.message);
  }

  /**
   * ═══════ HÀNG LOẠT KHÔNG CÓ GIỚI HẠN SỐ KIỆN — TRÌNH DUYỆT TỰ CHIA MẺ ═══════
   *
   * Trước bản này màn hình từ chối quá 200 kiện, và người kho phải tự chia tay: chọn 200, bấm, chọn
   * tiếp 200. Với 800 kiện đó là bốn lượt và bốn cơ hội chọn trùng hoặc bỏ sót.
   *
   * Nhưng gửi cả 800 trong MỘT lời gọi là hỏng theo kiểu tệ hơn hẳn: mỗi kiện là một giao dịch riêng
   * (phải vậy — một kiện lỗi không được kéo cả lô xuống), nên 800 giao dịch nối tiếp vượt hạn chờ và
   * người bấm nhận lỗi mạng SAU KHI vài trăm kiện đã ghi xong, không biết là những kiện nào.
   *
   * Nên: chia mẻ ở đây, gửi lần lượt, CỘNG DỒN kết quả, hiện tiến độ. Mẻ nào hỏng thì trả đúng kiện
   * của mẻ đó về danh sách và **đi tiếp** — một mẻ trượt không được huỷ phần việc còn lại.
   */
  async function hangLoat(condition: ReturnCondition) {
    if (!canWrite || !chon.size) return;
    if (CONDITION_NEEDS_NOTE[condition] && !lyDo.trim()) {
      toast.error(`Kết luận “${CONDITION_LABEL[condition]}” phải ghi lý do trước khi xử lý hàng loạt`);
      return;
    }
    const ids = [...chon];
    const theoId = new Map(rows.map((x) => [x.shipmentId, x] as const));
    const giuLai = ids.map((id) => theoId.get(id)).filter((x): x is Row => Boolean(x));

    // Biến mất NGAY khỏi danh sách; kiện nào máy chủ từ chối sẽ quay lại kèm tên.
    setRows((r) => r.filter((x) => !chon.has(x.shipmentId)));
    setChon(new Set());
    setDangChay(true);

    const me = chiaMe(ids, BULK_INSPECT_PER_REQUEST);
    let xong = 0;
    let tongDone = 0;
    const tongFailed: { shipmentId: string; error: string }[] = [];
    const loiCaMe: string[] = [];
    setTienDo({ xong: 0, tong: ids.length });

    for (const nhom of me) {
      const r = await submitBulkInspection({ shipmentIds: nhom, condition, note: lyDo.trim(), orderOnlyConfirmed: daDoiChieu });
      xong += nhom.length;
      setTienDo({ xong, tong: ids.length });
      if ("error" in r) {
        // Cả mẻ bị từ chối (sai đầu vào / hết quyền): trả nguyên mẻ về, ghi lý do, ĐI TIẾP.
        const cua = new Set(nhom);
        setRows((prev) => [...giuLai.filter((x) => cua.has(x.shipmentId)), ...prev]);
        loiCaMe.push(r.error);
        continue;
      }
      tongDone += r.done;
      if (r.failed.length) {
        const hong = new Set(r.failed.map((f) => f.shipmentId));
        setRows((prev) => [...giuLai.filter((x) => hong.has(x.shipmentId)), ...prev]);
        tongFailed.push(...r.failed);
      }
    }

    setTienDo(null);
    setDangChay(false);
    tuTuMa();

    // Gộp lý do theo SỐ KIỆN: 200 kiện cùng một lý do là MỘT dòng, không phải 200.
    if (tongDone) toast.success(`Đã kiểm ${formatNumber(tongDone)} kiện`);
    if (tongFailed.length) {
      const gom = new Map<string, number>();
      for (const f of tongFailed) gom.set(f.error, (gom.get(f.error) ?? 0) + 1);
      const chiTiet = [...gom.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([ly, n]) => `${formatNumber(n)} kiện — ${ly}`)
        .join(" · ");
      toast.error(`${formatNumber(tongFailed.length)} kiện KHÔNG xử lý được: ${chiTiet}`, { duration: 12_000 });
    }
    for (const e of [...new Set(loiCaMe)]) toast.error(e, { duration: 12_000 });
    if (!tongDone && !tongFailed.length && !loiCaMe.length) toast.info("Không kiện nào được xử lý");
  }

  const tatCa = daLoc.length > 0 && daLoc.every((r) => chon.has(r.shipmentId));
  const chamTran = total > rows.length;
  /** Số kiện đang chọn mà "nhận đủ" hàng loạt cần lời khai đối chiếu — nói TRƯỚC khi bấm. */
  const chonCanDoiChieu = React.useMemo(() => rows.filter((r) => chon.has(r.shipmentId) && r.itemsBasis === "ORDER_ONLY").length, [rows, chon]);

  return (
    <div className="space-y-3">
      {/* ── Ô BẮN MÃ ── */}
      <form onSubmit={quet} className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
        <ScanLine className="size-5 shrink-0 text-primary" />
        <Input
          ref={oMa}
          value={ma}
          onChange={(e) => setMa(e.target.value)}
          placeholder="Bắn mã vận đơn hoặc mã đơn rồi Enter…"
          className="h-10 min-w-[240px] flex-1 font-mono text-sm"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        <Button type="submit" className="h-10" disabled={dangChay || !ma.trim()}>
          {dangChay ? <Loader2 className="size-4 animate-spin" /> : "Tìm kiện"}
        </Button>
        <span className="text-[12px] text-muted-foreground">Ô bắn mã tìm trong TOÀN BỘ hàng đợi, không chỉ phần đang lọc — con trỏ tự về đây sau mỗi lần xử lý.</span>
      </form>

      {/* ── BỘ LỌC ── */}
      <div className="space-y-2 rounded-xl border bg-card p-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            value={loc.q}
            onChange={(e) => setLoc((f) => ({ ...f, q: e.target.value }))}
            placeholder="Tìm nhanh: mã vận đơn · mã đơn · khách · SĐT · mã hàng · màu · size"
            className="h-8 min-w-[240px] flex-1 text-[12.5px]"
            autoComplete="off"
            spellCheck={false}
          />
          <FacetPicker label="Mã hàng" facets={oChon.skus} value={loc.sku} onChange={(v) => setLoc((f) => ({ ...f, sku: v }))} />
          <FacetPicker label="Màu" facets={oChon.colors} value={loc.color} onChange={(v) => setLoc((f) => ({ ...f, color: v }))} />
          <FacetPicker label="Size" facets={oChon.sizes} value={loc.size} onChange={(v) => setLoc((f) => ({ ...f, size: v }))} />
          {/* Nguồn ghi nhận chỉ đáng một ô lọc khi thực sự có nhiều nguồn: lượt đối soát sổ giấy
              phải tách được khỏi kiện người kho tự bấm, nhưng một kho một người thì ô này là rác. */}
          {oChon.receivers.length > 1 ? (
            <FacetPicker label="Kho nhận bởi" facets={oChon.receivers} value={loc.receivedBy} onChange={(v) => setLoc((f) => ({ ...f, receivedBy: v }))} />
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <LocChon
            label="Số mẫu mã"
            value={loc.variety}
            options={PENDING_VARIETY.map((v) => ({ value: v, label: PENDING_VARIETY_LABEL[v] }))}
            onChange={(v) => setLoc((f) => ({ ...f, variety: v }))}
          />
          <LocChon label="Tuổi" value={loc.age} options={PENDING_AGE.map((v) => ({ value: v, label: PENDING_AGE_LABEL[v] }))} onChange={(v) => setLoc((f) => ({ ...f, age: v }))} />
          <LocChon label="Ghép đơn" value={loc.link} options={PENDING_LINK.map((v) => ({ value: v, label: PENDING_LINK_LABEL[v] }))} onChange={(v) => setLoc((f) => ({ ...f, link: v }))} />

          {soLoc ? (
            <Button variant="ghost" size="sm" className="h-8 px-2 text-[12.5px]" onClick={() => setLoc(PENDING_FILTER_EMPTY)}>
              <FilterX className="size-3.5" /> Bỏ {soLoc} bộ lọc
            </Button>
          ) : null}

          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[12px] text-muted-foreground">Sắp theo</span>
            <Select value={sapTheo} onValueChange={(v) => setSapTheo(v as PendingSortKey)}>
              <SelectTrigger size="sm" className="h-8 w-[168px] text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PENDING_SORTS.map((k) => (
                  <SelectItem key={k} value={k} title={PENDING_SORT_HINT[k]}>
                    {PENDING_SORT_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 text-[12.5px]"
              onClick={() => setChieu((d) => (d === "asc" ? "desc" : "asc"))}
              title={`${PENDING_SORT_LABEL[sapTheo]} — ${chieu === "asc" ? "tăng dần (cũ / nhỏ trước)" : "giảm dần (mới / lớn trước)"}. ${PENDING_SORT_HINT[sapTheo]}`}
            >
              {chieu === "asc" ? <ArrowUpNarrowWide className="size-3.5" /> : <ArrowDownWideNarrow className="size-3.5" />}
              {chieu === "asc" ? "Tăng" : "Giảm"}
            </Button>
          </div>
        </div>

        {/*
          MỘT DÒNG NÓI ĐÚNG PHẦN ĐANG NHÌN THẤY.
          Số món CHỈ cộng phần đã ghép được đơn; kiện chưa ghép nêu riêng chứ không ước lượng thành 0.
        */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[12px] text-muted-foreground">
          <span>
            Đang hiện <b className="numeric text-foreground">{formatNumber(daLoc.length)}</b>
            {soLoc ? <> / {formatNumber(rows.length)} kiện đã tải</> : " kiện"}
            {tong.units ? <> · {formatNumber(tong.units)} món kỳ vọng</> : null}
          </span>
          {tong.unknownParcels ? <span className="text-amber-700 dark:text-amber-300">{formatNumber(tong.unknownParcels)} kiện chưa rõ hàng</span> : null}
          {tong.multiVariant ? <span>{formatNumber(tong.multiVariant)} kiện nhiều mẫu mã</span> : null}
          {chamTran ? (
            <span className="font-medium text-amber-700 dark:text-amber-300">
              Mới tải {formatNumber(rows.length)} kiện cũ nhất trong tổng {formatNumber(total)} — bộ lọc chỉ tìm trong phần này. Ô bắn mã vẫn dò cả hàng đợi.
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Ô LÝ DO + LỜI KHAI ĐỐI CHIẾU: dùng chung cho cả đếm một kiện lẫn hàng loạt ── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={lyDo}
            onChange={(e) => setLyDo(e.target.value)}
            placeholder="Lý do / bằng chứng (bắt buộc khi kết luận không phải “nhận đủ”)"
            className="h-9 min-w-[260px] flex-1 text-sm"
          />
          {lyDo ? (
            <Button variant="ghost" size="sm" className="h-9" onClick={() => setLyDo("")}>
              <Trash2 className="size-4" /> Xoá lý do
            </Button>
          ) : null}
        </div>

        {/*
          ─── LỜI KHAI ĐỐI CHIẾU ĐỨNG Ở ĐÂY, KHÔNG ĐỨNG TRONG THANH HÀNG LOẠT ───

          Nó chi phối CẢ HAI đường: "nhận đủ" từng kiện nhiều mẫu mã, và "nhận đủ" hàng loạt. Để nó
          trong thanh hàng loạt thì người đếm từng kiện không bao giờ với tới được — nút của họ báo
          lỗi và không có ô nào để tick, một ngõ cụt.

          Vì sao cần: hai đường đó KHÔNG nhận một con số đếm nào; bấm là khẳng định "về đủ theo đơn".
          Với kiện chưa có phiếu trả từng món, ERP không biết món nào thực sự quay về — một kiện hoàn
          MỘT PHẦN sẽ cộng tồn dư mà không để lại dấu vết. Máy chủ chặn; ô này là chỗ người kho nói
          rằng mình đã mở kiện đối chiếu thật.

          Mặc định TẮT và không nhớ qua lần tải trang: đây là lời khẳng định về việc vừa làm bằng
          tay, không phải một tuỳ chọn giao diện. Chỉ hiện khi trong phần đang xem thực sự CÓ kiện
          như vậy — một ô tick luôn hiện là một ô tick không ai đọc.
        */}
        {tong.orderOnly > 0 ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
            <input type="checkbox" checked={daDoiChieu} onChange={(e) => setDaDoiChieu(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
            <span>
              <b>{formatNumber(tong.orderOnly)} kiện</b> đang hiện chưa có phiếu trả từng món — danh sách kỳ vọng chỉ SUY TỪ CẢ ĐƠN. Tôi xác nhận đã MỞ KIỆN đối chiếu thực tế.
              <span className="block text-[11px] opacity-80">
                Bắt buộc cho “nhận đủ” (từng kiện nhiều mẫu mã và hàng loạt) vì hai đường đó không nhận số đếm. Không tick thì các kiện này bị từ chối kèm lý do, kiện còn lại vẫn chạy.
              </span>
            </span>
          </label>
        ) : null}
      </div>

      {/* ── THANH HÀNG LOẠT ── */}
      {chon.size > 0 && canWrite ? (
        <div className="sticky top-[calc(var(--app-header-height)+0.5rem)] z-10 space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">Đã chọn {formatNumber(chon.size)} kiện</span>
            {NHANH.map(({ condition, icon: Icon, tone }) => (
              <Button
                key={condition}
                size="sm"
                className={cn("h-9", tone)}
                variant={condition === "RESTOCKABLE" ? "default" : "outline"}
                disabled={dangChay}
                onClick={() => hangLoat(condition)}
              >
                <Icon className="size-4" /> {CONDITION_ACTION_LABEL[condition]}
              </Button>
            ))}
            <Button size="sm" variant="ghost" className="h-9" onClick={() => setChon(new Set())} disabled={dangChay}>
              Bỏ chọn
            </Button>
            {/* Tiến độ mẻ: 800 kiện mất vài chục giây, và im lặng suốt thời gian đó là mời bấm lại. */}
            {tienDo ? (
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-primary">
                <Loader2 className="size-3.5 animate-spin" />
                Đang xử lý {formatNumber(tienDo.xong)} / {formatNumber(tienDo.tong)} kiện…
              </span>
            ) : null}
            {chonBiAn.length ? (
              <Button size="sm" variant="outline" className="h-9" onClick={() => setChon(new Set([...chon].filter((id) => dangHien.has(id))))}>
                Bỏ {formatNumber(chonBiAn.length)} kiện ngoài bộ lọc
              </Button>
            ) : null}
          </div>

          {/* Cảnh báo TRƯỚC khi bấm, không phải danh sách lỗi sau khi bấm: ô khai nằm ngay trên ô lý do. */}
          {chonCanDoiChieu > 0 && !daDoiChieu ? (
            <p className="text-[12px] font-medium text-amber-700 dark:text-amber-300">
              {formatNumber(chonCanDoiChieu)} kiện đang chọn chưa có phiếu trả từng món — “nhận đủ” sẽ bị từ chối cho tới khi tick ô xác nhận đã đối chiếu ở trên.
            </p>
          ) : null}

          <p className="text-[12px] text-muted-foreground">
            “Nhận đủ” hàng loạt = mỗi dòng hàng về đúng số kỳ vọng của nó, kể cả kiện nhiều mẫu mã. Muốn khai số KHÁC thì đếm từng kiện.
            {tong.unlinked && chonBiAn.length === 0 ? " Kiện chưa ghép được đơn sẽ bị từ chối kèm lý do, không bị bỏ qua im lặng." : ""}
          </p>
        </div>
      ) : null}

      {/* ── DANH SÁCH ── */}
      {rows.length === 0 ? (
        <EmptyState title="Không còn kiện nào chờ đếm" description="Mọi kiện đã về kho đều đã được đếm. Kiện mới sẽ hiện ở đây khi kho bấm “đã nhận”." />
      ) : daLoc.length === 0 ? (
        <EmptyState
          title="Không kiện nào khớp bộ lọc"
          description={`${formatNumber(rows.length)} kiện đang chờ đếm nhưng không kiện nào thoả ${soLoc} điều kiện đang đặt. Bỏ bớt bộ lọc để xem lại.`}
          action={
            <Button variant="outline" size="sm" onClick={() => setLoc(PENDING_FILTER_EMPTY)}>
              <FilterX className="size-4" /> Bỏ bộ lọc
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          <label className="flex items-center gap-2 px-1 text-[12.5px] text-muted-foreground">
            <input
              type="checkbox"
              checked={tatCa}
              onChange={(e) =>
                setChon((c) => {
                  const n = new Set(c);
                  for (const r of daLoc) {
                    if (e.target.checked) n.add(r.shipmentId);
                    else n.delete(r.shipmentId);
                  }
                  return n;
                })
              }
              className="size-4"
            />
            {/* Tick này chọn CẢ phần khớp bộ lọc, không chỉ phần đã vẽ ra — nói rõ để không ai bấm nhầm quy mô. */}
            {/* Tick này chọn CẢ phần khớp bộ lọc — mọi trang, không chỉ trang đang xem. Nói rõ để không ai bấm nhầm quy mô. */}
            Chọn tất cả {formatNumber(daLoc.length)} kiện khớp bộ lọc
            {tongTrang > 1 ? <span className="opacity-70"> (mọi trang, không chỉ {formatNumber(hienThi.length)} kiện đang xem)</span> : null}
          </label>
          {hienThi.map((row) => (
            <KienHang
              key={row.shipmentId}
              row={row}
              chon={chon.has(row.shipmentId)}
              canWrite={canWrite}
              daDoiChieu={daDoiChieu}
              onChon={(v) =>
                setChon((c) => {
                  const n = new Set(c);
                  if (v) n.add(row.shipmentId);
                  else n.delete(row.shipmentId);
                  return n;
                })
              }
              onKetLuan={(condition, qty) => motKien(row, condition, qty)}
              onNhanDu={() => nhanDu(row)}
            />
          ))}
          <Phan
            trang={trangHienTai}
            tongTrang={tongTrang}
            moiTrang={moiTrang}
            tong={daLoc.length}
            onTrang={setTrang}
            onMoiTrang={setMoiTrang}
          />
        </div>
      )}
    </div>
  );
}

/**
 * ═══════ PHÂN TRANG — ĐỂ NGƯỜI ĐẾM BIẾT MÌNH ĐANG Ở ĐÂU TRONG CÔNG VIỆC ═══════
 *
 * Một danh sách cuộn vô tận với nút "hiện thêm" trả lời được câu "còn bao nhiêu" nhưng không trả
 * lời được "tôi đã đi tới đâu" — và người đếm bỏ dở giữa chừng rồi quay lại thì không có mốc nào để
 * tiếp tục. Trang có số thì có mốc.
 *
 * "Chọn tất cả" vẫn chọn CẢ phần khớp bộ lọc chứ không chỉ trang đang xem: chia trang là để NHÌN
 * cho gọn, không phải để giới hạn phần được xử lý.
 */
function Phan({
  trang,
  tongTrang,
  moiTrang,
  tong,
  onTrang,
  onMoiTrang,
}: {
  trang: number;
  tongTrang: number;
  moiTrang: PendingPageSize;
  tong: number;
  onTrang: (n: number) => void;
  onMoiTrang: (n: PendingPageSize) => void;
}) {
  const tu = tong === 0 ? 0 : trang * moiTrang + 1;
  const den = Math.min(tong, (trang + 1) * moiTrang);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2 text-[12.5px]">
      <span className="text-muted-foreground">
        Kiện <b className="numeric text-foreground">{formatNumber(tu)}</b>–<b className="numeric text-foreground">{formatNumber(den)}</b> trong{" "}
        <b className="numeric text-foreground">{formatNumber(tong)}</b>
      </span>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Mỗi trang</span>
        <Select value={String(moiTrang)} onValueChange={(v) => onMoiTrang(Number(v) as PendingPageSize)}>
          <SelectTrigger size="sm" className="h-8 w-[76px] text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PENDING_PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="h-8 px-2" disabled={trang <= 0} onClick={() => onTrang(trang - 1)} aria-label="Trang trước">
          <ChevronLeft className="size-4" />
        </Button>
        <span className="numeric min-w-[72px] text-center">
          {formatNumber(trang + 1)} / {formatNumber(tongTrang)}
        </span>
        <Button variant="outline" size="sm" className="h-8 px-2" disabled={trang >= tongTrang - 1} onClick={() => onTrang(trang + 1)} aria-label="Trang sau">
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** Ô chọn một trong vài giá trị cố định. Nhãn nằm TRONG nút để hàng lọc không phình thêm một dòng chữ. */
function LocChon<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger size="sm" className={cn("h-8 w-auto min-w-[152px] text-[12.5px]", value !== options[0]?.value && "border-primary/50 bg-primary/5")}>
        <span className="text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function KienHang({
  row,
  chon,
  canWrite,
  daDoiChieu,
  onChon,
  onKetLuan,
  onNhanDu,
}: {
  row: Row;
  chon: boolean;
  canWrite: boolean;
  daDoiChieu: boolean;
  onChon: (v: boolean) => void;
  onKetLuan: (condition: ReturnCondition, qty?: number) => void;
  onNhanDu: () => void;
}) {
  const [qty, setQty] = React.useState(row.expectedQty === null ? "" : String(row.expectedQty));
  const soDem = Math.max(0, Math.trunc(Number(qty) || 0));
  /** `null` = không có mốc để so (chưa biết kỳ vọng). */
  const thieu = row.expectedQty === null ? null : row.expectedQty - soDem;
  const soMauMa = variantCount(row);

  /*
    ─── KIỆN NHIỀU MẪU MÃ: "ĐỦ" ĐI ĐƯỜNG KHÁC VỚI "THIẾU" ───

    "Nhận đủ" là một lời khẳng định TỪNG DÒNG — mỗi mẫu mã về đúng số của nó — nên phân bổ hoàn toàn
    xác định, không phải đoán. Đường này chạy được cho cả kiện nhiều mẫu mã.

    Đếm THIẾU thì khác hẳn: một con số tổng không nói được mẫu nào hụt. Kiện 2 đỏ + 1 đen mà đếm
    được 2 có thể là "2 đỏ" hoặc "1 đỏ 1 đen" — ghi bừa là làm sai tồn của HAI mẫu mã theo hai chiều
    ngược nhau, và không ai tìm ra được cho tới kỳ kiểm kê. Nên chỗ đó bắt buộc mở ngăn kéo đếm từng
    món, và nút nói thẳng ra thay vì mờ đi im lặng.
  */
  const nhieuMauMa = soMauMa >= 2;
  const duSo = row.expectedQty !== null && soDem === row.expectedQty;
  const canTungMon = nhieuMauMa && soDem > 0 && !duSo;

  return (
    <div className={cn("rounded-xl border bg-card p-3 transition-colors", chon && "border-primary/50 bg-primary/5", row.ageDays >= 7 && "border-l-4 border-l-rose-500")}>
      <div className="flex flex-wrap items-start gap-3">
        <input type="checkbox" checked={chon} onChange={(e) => onChon(e.target.checked)} className="mt-1 size-4 shrink-0" />
        {/*
          SÀN 220px CHO CỘT ĐỊNH DANH.

          Không có sàn thì hàng nút bên phải (không co được) ép cột này xuống ~180px, và mã vận đơn ·
          mã đơn · tên khách mỗi thứ rơi một dòng — thẻ cao gấp đôi, màn hình chứa 4 kiện thay vì 8.
          Đúng kiểu hỏng đã gặp ở hàng đợi CSKH: mỗi phần tử vẫn đẹp, chỉ có tổng thể là không dùng được.
        */}
        <div className="min-w-[220px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{row.code ?? row.shipmentId}</span>
            {row.orderCode ? <Badge variant="outline" className="text-[11px]">Đơn {row.orderCode}</Badge> : null}
            {nhieuMauMa ? (
              <Badge variant="secondary" className="gap-1 text-[11px]" title="Kiện có nhiều mẫu mã: nhận đủ được, nhưng đếm thiếu thì phải mở từng món.">
                <Layers className="size-3" /> {soMauMa} mẫu mã
              </Badge>
            ) : null}
            <span className="text-[12px] text-muted-foreground">
              {row.customerName || "—"}
              {row.customerPhone ? ` · ${row.customerPhone}` : ""} · kho nhận bởi {row.receivedBy || "—"}
            </span>
          </div>

        </div>

        {/*
          ─── CỘT THỜI GIAN: HAI MỐC, KHÔNG GỘP ───

          "ĐVVC trả về" là lúc kiện thật sự quay lại shop; "kho ghi" là lúc ERP biết chuyện đó. Với
          hàng trăm kiện vào bằng MỘT lượt đối soát sổ giấy, mốc thứ hai gần như bằng nhau hết —
          gộp hai mốc thành một cột "thời gian" là in ra một dòng thời gian không có thật. Chưa có
          chứng từ ĐVVC thì in "—", không lùi về mốc kho (AGENTS.md mục 42).
        */}
        <div className="w-[132px] shrink-0 text-[11.5px] leading-snug">
          <div className={cn(!row.returnedAt && "text-muted-foreground")}>
            ĐVVC trả <b className="numeric">{row.returnedAt ? formatDate(row.returnedAt) : "—"}</b>
          </div>
          <div className="text-muted-foreground">
            Kho ghi <span className="numeric">{formatDate(row.receivedAt)}</span>
          </div>
          <Badge variant={row.ageDays >= 7 ? "destructive" : row.ageDays >= 3 ? "secondary" : "outline"} className="mt-1 text-[11px]">
            chờ {formatNumber(row.ageDays)} ngày
          </Badge>
        </div>

        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-[12px] text-muted-foreground">Đếm được</span>
              <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" className="h-9 w-16 text-center font-mono text-sm" />
              <span className="text-[12px] text-muted-foreground" title={row.expectedQty === null ? "Chưa ghép được đơn — không biết số kỳ vọng" : undefined}>
                / {row.expectedQty === null ? "—" : formatNumber(row.expectedQty)}
              </span>
            </div>
            {/* "Nhận đủ" đổi nghĩa theo ô đếm: đếm thiếu thì nút tự nói ra phần thiếu, không im lặng cộng đủ. */}
            <Button
              size="sm"
              className="h-9 bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-muted disabled:text-muted-foreground"
              onClick={() => (nhieuMauMa ? onNhanDu() : onKetLuan("RESTOCKABLE", soDem))}
              disabled={soDem <= 0 || canTungMon}
              title={
                canTungMon
                  ? `Kiện có ${soMauMa} mẫu mã và số đếm (${soDem}) khác số kỳ vọng (${row.expectedQty}) — một con số tổng không nói được mẫu nào hụt. Bấm “Kiểm từng món”.`
                  : nhieuMauMa
                    ? `Ghi mỗi mẫu mã về đúng số kỳ vọng của nó (${soMauMa} mẫu mã).${row.itemsBasis === "ORDER_ONLY" && !daDoiChieu ? " Kiện này chưa có phiếu trả từng món — cần tick xác nhận đã đối chiếu ở thanh hàng loạt." : ""}`
                    : undefined
              }
            >
              <Check className="size-4" />
              {canTungMon ? `Hụt ${thieu} — đếm từng món` : thieu === null ? `Nhận ${soDem} (chưa có mốc kỳ vọng)` : thieu > 0 ? `Nhận ${soDem}, hụt ${thieu}` : "Nhận đủ"}
            </Button>
            {/*
              Ba kết luận phụ chỉ còn BIỂU TƯỢNG. Ba nhãn chữ chiếm ~250px của mỗi thẻ và đẩy cột định
              danh xuống dưới sàn — trong khi người đếm chỉ bấm chúng ở ca hiếm. Nhãn đầy đủ vẫn có
              trong `title`/`aria-label`, nên chuột dừng lại là đọc được và trình đọc màn hình vẫn đọc.

              Kiện chưa ghép được đơn: số "không bán được" là số ĐẾM TAY, không có mốc kỳ vọng nào để suy.
            */}
            {NHANH.filter((n) => n.condition !== "RESTOCKABLE").map(({ condition, icon: Icon }) => (
              <Button
                key={condition}
                size="sm"
                variant="outline"
                className="h-9 px-2.5"
                title={CONDITION_ACTION_LABEL[condition]}
                aria-label={CONDITION_ACTION_LABEL[condition]}
                onClick={() => onKetLuan(condition, row.expectedQty === null && soDem > 0 ? soDem : undefined)}
              >
                <Icon className="size-4" />
              </Button>
            ))}
            {/*
              ĐƯỜNG THỨ HAI, KHÔNG THAY ĐƯỜNG THỨ NHẤT.
              Các nút trên là đếm nhanh CẢ KIỆN. Kiện nhiều món mà mỗi món một tình trạng thì ép về
              một kết luận là mất thông tin, nên có lối riêng vào ngăn kéo đếm từng món. Khi số đếm
              không khớp kỳ vọng trên kiện nhiều mẫu mã thì đây là lối DUY NHẤT, nên nó nổi lên.
            */}
            {row.items.length ? (
              <ItemInspectionDrawer
                shipmentId={row.shipmentId}
                code={row.code}
                orderCode={row.orderCode}
                itemsBasis={row.itemsBasis}
                highlight={canTungMon}
                items={row.items.map((it) => ({ variantId: it.variantId ?? null, sku: it.sku, name: it.name, color: it.color, size: it.size, quantity: it.quantity }))}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {/*
        TỪNG MÃ HÀNG KÈM MÀU / SIZE — CẢ BỀ NGANG THẺ, KHÔNG NHÉT VÀO MỘT CỘT HẸP.

        Đây là thứ người đếm nhìn khi mở kiện ra, nên nó không được là phần bị ép xuống cuối một cột
        180px rồi xuống dòng giữa chữ. Thụt vào bằng đúng ô tick để mắt vẫn theo được thẻ.
      */}
      <div className="mt-2 flex flex-wrap gap-1.5 pl-7">
        {row.items.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">{KHONG_DONG_HANG[row.linkBasis]}</span>
        ) : (
          row.items.map((it, i) => (
            <span key={`${it.sku}-${i}`} className="rounded-md border bg-muted/40 px-2 py-1 text-[12px]">
              <b className="font-mono">{it.sku || it.name}</b>
              {it.color ? ` · ${it.color}` : ""}
              {it.size ? ` · ${it.size}` : ""}
              <b className="ml-1">×{it.quantity}</b>
            </span>
          ))
        )}
      </div>
    </div>
  );
}
