"use client";

import { useMemo, useState, useTransition } from "react";
import { Copy, ExternalLink, FileUp, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { NavLink } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { InfoHint } from "@/components/info-hint";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import {
  RECONCILE_REASON_FIX,
  RECONCILE_REASON_LABEL,
  RECONCILE_REASON_RANK,
  RECONCILE_REASON_TONE,
  RECONCILE_REASONS,
  type ReconcileReason,
} from "@/lib/constants/vtp-reconcile-queue";
import type { ReconcileQueue, ReconcileRow } from "@/lib/queries/vtp-reconcile-queue";
import { FRESHNESS_HOURS_MAX, FRESHNESS_HOURS_MIN, type FreshnessThreshold } from "@/lib/constants/logistics-freshness";
import { setFreshnessThreshold } from "@/lib/actions/logistics-config";
import { layMaDoiChieu } from "@/lib/actions/vtp-reconcile";
import { formatNumber, formatVND, vnShortStamp } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ "VTP CẦN ĐỐI CHIẾU" — HÀNG ĐỢI CHO NGƯỜI, KHÔNG PHẢI BẢNG SỐ ═══════════
 *
 * ─── VÌ SAO KHÔNG CÓ NÚT "ĐÁNH DẤU XONG" ───
 *
 * Mỗi dòng ở đây là một PHÉP CHIẾU lên trạng thái thật của vận đơn, không phải một bản sao (luật
 * 19). Dòng rời hàng đợi khi ĐIỀU KIỆN sinh ra nó hết: câu lạ được bổ sung vào bảng mã, lỗi đối
 * chiếu hết, ĐVVC gửi mốc mới. Một nút "đánh dấu xong" sẽ cho phép giấu một kiện mà ERP vẫn đang
 * nói sai về nó — đúng thứ hàng đợi này sinh ra để chặn.
 *
 * ─── NÊN THAY VÀO ĐÓ LÀ HAI ĐƯỜNG RA THẬT ───
 *
 * Tài khoản API Viettel Post không đọc được vận đơn do Pancake tạo (2.138/2.151 kiện), nên ERP
 * KHÔNG tự tra lại được. Việc thật của người trực là: chép mã sang viettelpost.vn xem, rồi tải tệp
 * về nhập lại. Hai nút ở đây phục vụ đúng hai bước đó và không hứa gì hơn.
 */
export type NguongChang = {
  stage: string;
  label: string;
  /** Ngưỡng ĐANG CÓ HIỆU LỰC — ghi đè của chủ shop nếu có, còn lại là mặc định của mã. */
  hieuLuc: FreshnessThreshold;
  macDinh: FreshnessThreshold;
  daGhiDe: boolean;
};

export function ReconcilePanel({ queue, nguong, canAdmin }: { queue: ReconcileQueue; nguong: NguongChang[]; canAdmin: boolean }) {
  const [reason, setReason] = useState<ReconcileReason | "all">("all");
  const [chon, setChon] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  const rows = useMemo(() => (reason === "all" ? queue.rows : queue.rows.filter((r) => r.reasons.includes(reason))), [queue.rows, reason]);

  const toggle = (id: string) =>
    setChon((truoc) => {
      const sau = new Set(truoc);
      if (sau.has(id)) sau.delete(id);
      else sau.add(id);
      return sau;
    });

  const daChon = rows.filter((r) => chon.has(r.id));
  const maDaChon = (daChon.length ? daChon : rows).map((r) => r.vtpOrderNumber ?? r.trackingCode ?? "").filter(Boolean);
  /* Số mã mà "toàn bộ" thật sự có — của cả tập, không của trang đang hiện. */
  const soMaToanBo = reason === "all" ? queue.total : queue.counts[reason];
  const conAn = Math.max(0, soMaToanBo - maDaChon.length);

  const chep = async (ma: string[], cau: string) => {
    if (!ma.length) return;
    try {
      await navigator.clipboard.writeText(ma.join("\n"));
      toast.success(`Đã chép ${formatNumber(ma.length)} mã vận đơn — ${cau}`);
    } catch {
      // Trình duyệt chặn clipboard (http, quyền bị tắt) là chuyện thật, không phải lỗi hiếm.
      toast.error("Trình duyệt không cho chép tự động. Bôi đen cột mã rồi Ctrl+C.");
    }
  };

  const chepMa = () => chep(maDaChon, "dán vào ô tra cứu của viettelpost.vn");

  /*
    ═══ "CHÉP TOÀN BỘ" HỎI LẠI MÁY CHỦ, KHÔNG CHÉP CÁI ĐANG HIỆN ═══

    Trình duyệt chỉ giữ những dòng đã tải. Chép từ đó rồi gọi là "toàn bộ" thì với 354 kiện mà mới
    tải 300, người trực mang đi tra 300 mã và tin rằng mình đã tra hết — 54 kiện im lặng lâu nhất
    lặng lẽ ở lại. Nên nút này gọi Server Action chạy lại đúng phép lọc trên CSDL.
  */
  const chepToanBo = () =>
    start(async () => {
      const r = await layMaDoiChieu(reason);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      await chep(r.data, "toàn bộ kết quả của bộ lọc đang chọn");
    });

  if (!queue.total) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-6 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
        Không kiện nào cần đối chiếu. ERP đang hiểu mọi câu Viettel Post đã nói, không kiện đang chạy nào im lặng quá ngưỡng của chặng, và lượt hỏi lại gần nhất không lỗi.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setReason("all")}
          className={cn("rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors", reason === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground")}
        >
          Tất cả <span className="numeric">{formatNumber(queue.total)}</span>
        </button>
        {[...RECONCILE_REASONS]
          .sort((a, b) => RECONCILE_REASON_RANK[a] - RECONCILE_REASON_RANK[b])
          .filter((r) => queue.counts[r] > 0)
          .map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className={cn("rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors", reason === r ? "bg-foreground text-background" : cn(RECONCILE_REASON_TONE[r], "hover:opacity-80"))}
            >
              {RECONCILE_REASON_LABEL[r]} <span className="numeric">{formatNumber(queue.counts[r])}</span>
            </button>
          ))}
        <InfoHint>
          Một kiện mang nhiều lý do vẫn chỉ là MỘT dòng — người trực mở viettelpost.vn đúng một lần cho một mã. Bộ đếm theo lý do vì thế cộng lại LỚN HƠN tổng số kiện.
        </InfoHint>
      </div>

      {reason !== "all" ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{RECONCILE_REASON_FIX[reason]}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={chepMa} disabled={!maDaChon.length}>
          <Copy className="size-4" /> Chép {formatNumber(maDaChon.length)} mã {daChon.length ? "đã chọn" : "đang hiện"}
        </Button>
        {/* Hiện khi — và chỉ khi — hai con số thật sự khác nhau. Một nút "toàn bộ" đứng cạnh một
            nút "đang hiện" cùng đếm 300 chỉ làm người đọc phân vân thêm một nhịp. */}
        {conAn > 0 ? (
          <Button size="sm" variant="outline" onClick={chepToanBo} disabled={pending}>
            <Copy className="size-4" /> Chép toàn bộ {formatNumber(soMaToanBo)} mã
          </Button>
        ) : null}
        <Button asChild size="sm" variant="outline">
          <a href="https://viettelpost.vn/tra-cuu-hanh-trinh-don-hang" target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" /> Mở tra cứu Viettel Post
          </a>
        </Button>
        <Button asChild size="sm">
          <NavLink href="/import-vtp">
            <FileUp className="size-4" /> Nhập tệp để vá lại
          </NavLink>
        </Button>
        {queue.truncated ? (
          // Số bị cắt phải in ra — VÀ phải có một đường mở nó ra. In con số rồi để đó là nói cho
          // người trực biết họ đang thiếu việc mà không cho họ cách nào lấy phần thiếu.
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            Đang hiện {formatNumber(queue.rows.length)} kiện đầu · còn {formatNumber(queue.truncated)} kiện nữa
            <Button asChild size="sm" variant="outline">
              <NavLink href={`/shipments?view=reconcile&dc=${queue.page + 1}`}>
                Xem thêm {formatNumber(Math.min(queue.truncated, queue.pageSize))} kiện
              </NavLink>
            </Button>
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-[12.5px]">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-2" />
              <th className="px-2 py-2 font-medium">Mã vận đơn</th>
              <th className="px-2 py-2 font-medium">ERP đang tin</th>
              <th className="px-2 py-2 font-medium">Vì sao cần tra</th>
              <th className="px-2 py-2 font-medium">Tin ĐVVC gần nhất</th>
              <th className="px-2 py-2 text-right font-medium">COD</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Dong key={r.id} row={r} checked={chon.has(r.id)} onToggle={() => toggle(r.id)} />
            ))}
          </tbody>
        </table>
      </div>

      {canAdmin ? <BangNguong rows={nguong} /> : null}
    </div>
  );
}

/**
 * ═══════════ NGƯỠNG IM LẶNG ĐẶT NGAY CẠNH HẬU QUẢ CỦA NÓ ═══════════
 *
 * Ô chỉnh ngưỡng nằm ở ĐÂY chứ không ở một trang cấu hình riêng, vì người duy nhất biết ngưỡng
 * đang đúng hay sai là người vừa nhìn hàng đợi này: thấy 300 kiện thì ngưỡng quá chặt, thấy 0 kiện
 * suốt tuần trong khi webhook vẫn rơi thì ngưỡng quá lỏng. Bắt họ đi sang một trang khác để sửa là
 * cách chắc chắn nhất để không ai sửa.
 *
 * Mỗi dòng in cả MẶC ĐỊNH lẫn LÝ DO của mặc định: một ngưỡng không kèm lý do thì không ai dám sửa,
 * và một ngưỡng đã sửa mà không thấy con số cũ thì không ai dám sửa lại.
 */
function BangNguong({ rows }: { rows: NguongChang[] }) {
  return (
    <details className="rounded-xl border">
      <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-medium">
        Ngưỡng im lặng theo chặng
        <span className="ml-2 font-normal text-muted-foreground">
          {rows.filter((r) => r.daGhiDe).length ? `${formatNumber(rows.filter((r) => r.daGhiDe).length)} chặng đã sửa` : "đang dùng mặc định của mã"}
        </span>
      </summary>
      <div className="space-y-2 border-t p-3">
        <p className="text-xs text-muted-foreground">
          Đây là đồng hồ ĐO IM LẶNG — “bao lâu rồi ERP không nghe tin gì về kiện này”. Nó KHÁC đồng hồ tuổi chặng ở trang Tồn đọng
          (“kiện đứng ở chặng hiện tại bao lâu rồi”): một kiện có thể nhận mốc mới mỗi ngày mà vẫn đứng yên một chỗ suốt tuần.
        </p>
        {rows.map((r) => (
          <DongNguong key={r.stage} row={r} />
        ))}
      </div>
    </details>
  );
}

function DongNguong({ row }: { row: NguongChang }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [aging, setAging] = useState(String(row.hieuLuc.aging));
  const [stale, setStale] = useState(String(row.hieuLuc.stale));
  const [critical, setCritical] = useState(String(row.hieuLuc.critical));

  const gui = (payload: Parameters<typeof setFreshnessThreshold>[0]) =>
    start(async () => {
      const res = await setFreshnessThreshold(payload);
      if ("error" in res) toast.error(res.error);
      else {
        toast.success("Đã lưu ngưỡng");
        router.refresh();
      }
    });

  const so = (v: string) => Number(v.trim());

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5">
      <div className="min-w-[10rem]">
        <div className="text-[12.5px] font-medium">{row.label}</div>
        <div className="text-[11px] text-muted-foreground">
          mặc định {row.macDinh.aging}/{row.macDinh.stale}/{row.macDinh.critical} giờ
          {row.daGhiDe ? " · đang dùng bản đã sửa" : ""}
        </div>
      </div>
      {([["aging", aging, setAging, "bắt đầu cũ"], ["stale", stale, setStale, "cũ"], ["critical", critical, setCritical, "nghiêm trọng"]] as const).map(([k, v, set, nhan]) => (
        <label key={k} className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {nhan}
          <Input className="h-7 w-16 text-[12px]" inputMode="numeric" value={v} min={FRESHNESS_HOURS_MIN} max={FRESHNESS_HOURS_MAX} onChange={(e) => set(e.target.value)} />
        </label>
      ))}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => gui({ stage: row.stage, aging: so(aging), stale: so(stale), critical: so(critical) })}>
        Lưu
      </Button>
      {row.daGhiDe ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => gui({ stage: row.stage, reset: true })} title="Trả về mặc định của mã">
          <RotateCcw className="size-3.5" />
        </Button>
      ) : null}
      <span className="w-full text-[11px] text-muted-foreground">{row.hieuLuc.why}</span>
    </div>
  );
}

function Dong({ row, checked, onToggle }: { row: ReconcileRow; checked: boolean; onToggle: () => void }) {
  const ma = row.vtpOrderNumber ?? row.trackingCode ?? "—";
  return (
    <tr className="border-t align-top">
      <td className="px-2 py-2">
        <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={`Chọn ${ma}`} />
      </td>
      <td className="px-2 py-2">
        <NavLink href={`/shipments/${row.id}`} className="numeric font-medium hover:underline">
          {ma}
        </NavLink>
        <div className="text-[11.5px] text-muted-foreground">
          {row.receiverName || "—"}
          {row.careOpen ? <span className="ml-1 rounded bg-sky-100 px-1 text-[10.5px] text-sky-800 dark:bg-sky-950/60 dark:text-sky-300">đang care</span> : null}
        </div>
      </td>
      <td className="px-2 py-2">
        <div>{SHIPMENT_STAGE_LABEL[row.stage as keyof typeof SHIPMENT_STAGE_LABEL] ?? row.stage}</div>
        <div className="text-[11.5px] text-muted-foreground">{row.vtpStatusName || "—"}</div>
      </td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap gap-1">
          {row.reasons.map((ly) => (
            <span key={ly} className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-medium", RECONCILE_REASON_TONE[ly])}>
              {RECONCILE_REASON_LABEL[ly]}
            </span>
          ))}
        </div>
        {/*
          Chữ NGUYÊN VĂN của ĐVVC khi ERP chưa dịch được: đó chính là thứ người sửa phải dán vào
          bảng mã, nên nó phải hiện ở đây chứ không nằm sau một cú bấm.
        */}
        {row.reasons.includes("UNMAPPED_STATUS") && row.vtpRawStatusName ? (
          <div className="mt-1 text-[11.5px] text-violet-700 dark:text-violet-300">VTP nói: “{row.vtpRawStatusName}”</div>
        ) : null}
        {row.vtpLastError ? <div className="mt-1 text-[11.5px] text-rose-700 dark:text-rose-300">{row.vtpLastError}</div> : null}
      </td>
      <td className="px-2 py-2">
        {/* CHƯA BIẾT in ra là "—", không phải "0 giờ": chưa có mốc nào khác hẳn vừa có mốc xong. */}
        <div>{row.lastCarrierAt ? vnShortStamp(row.lastCarrierAt) : "—"}</div>
        <div className="text-[11.5px] text-muted-foreground">
          {row.hoursSilent === null ? "chưa có mốc ĐVVC nào" : `im ${formatNumber(row.hoursSilent)} giờ · ngưỡng ${formatNumber(row.criticalHours)} giờ`}
        </div>
      </td>
      <td className="numeric px-2 py-2 text-right">{formatVND(row.codAmount)}</td>
    </tr>
  );
}
