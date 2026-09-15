"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, Loader2, ScanBarcode, Volume2, VolumeX, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { scanReceiveReturnAction } from "@/lib/actions/returns-unidentified";
import type { ScanOutcome } from "@/lib/returns/receive-scan";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BÀN BẮN MÃ NHẬN HÀNG HOÀN ═══════════
 *
 * Máy quét USB/Bluetooth/PDA ở chế độ HID (Keyboard Wedge) gõ `<mã><ENTER>` vào ô đang có con trỏ.
 * Không cần trình điều khiển, không cần thư viện: cái ERP phải làm là giữ con trỏ ở ĐÚNG MỘT ô và
 * xử lý được phím Enter. Toàn bộ thiết kế dưới đây xoay quanh hai điều đó.
 *
 * ─── TIẾNG BÍP CỦA MÁY QUÉT KHÔNG PHẢI BẰNG CHỨNG ───
 *
 * Máy quét kêu khi nó ĐỌC ĐƯỢC VẠCH — trước khi ERP nhận được ký tự nào, và bất kể ERP có ghi nổi
 * hay không. Người kho bắn 40 kiện, nghe 40 tiếng bíp, và tin rằng 40 kiện đã vào sổ. Nên ERP phát
 * âm báo RIÊNG với ba cao độ khác nhau, và nháy màu cả khung: xanh chỉ dành cho lượt ghi THẬT SỰ
 * thành công, vàng cho "đã nhận từ trước", đỏ cho "không thấy mã".
 *
 * ─── CHỐNG BẮN ĐÚP, VÀ VÌ SAO NÓ KHÔNG PHẢI LÀ CÁI CHỐT ───
 *
 * Cò máy quét bấm hơi lâu là gửi hai lần. Ở đây khoá bằng `dangGui` (không gửi lượt thứ hai khi
 * lượt đầu chưa xong) và bỏ qua mã GIỐNG HỆT bắn lại trong `NHAY_TRUNG` mili-giây.
 *
 * Nhưng đó chỉ là phép lịch sự với người bấm. CÁI CHỐT THẬT nằm ở CSDL:
 * `return_inspections.shipment_id` là UNIQUE, nên hai tab, hai người, hay một lượt thử lại của
 * mạng cũng chỉ ra đúng một phiếu. Khoá ở trình duyệt mà không khoá ở CSDL là kiểu bảo vệ hỏng
 * đúng lúc tải nặng — tức là đúng lúc cần nó nhất.
 *
 * ─── BẮN MÃ KHÔNG CỘNG TỒN ───
 *
 * Lượt bắn ở đây chỉ nói "kiện đã nằm trên bàn". Hàng vào tồn ở TRẠM ĐẾM bên dưới, theo số người
 * kho đếm được, và chỉ phần còn bán lại được.
 */

/** Cùng một mã bắn lại trong khoảng này coi như cò máy quét nảy hai lần, không phải hai kiện. */
const NHAY_TRUNG = 1200;
/** Số dòng lịch sử giữ trên màn hình — đủ để nhìn lại mấy kiện vừa bắn, không thành một bảng. */
const LICH_SU = 12;

type Dong = {
  key: string;
  outcome: ScanOutcome;
  code: string;
  message: string;
  at: Date;
  /** Kiện tìm thấy nhưng ĐVVC không báo đang hoàn — cần lượt bấm thứ hai. */
  needsConfirm: boolean;
  shipmentCode: string | null;
};

const TONE: Record<ScanOutcome, { ring: string; chip: string; icon: typeof CheckCircle2 }> = {
  RECEIVED: { ring: "ring-emerald-500/60 bg-emerald-500/10", chip: "bg-emerald-600 text-white", icon: CheckCircle2 },
  ALREADY: { ring: "ring-amber-500/60 bg-amber-500/10", chip: "bg-amber-500 text-white", icon: CircleAlert },
  NEEDS_CONFIRM: { ring: "ring-amber-500/60 bg-amber-500/10", chip: "bg-amber-500 text-white", icon: CircleAlert },
  NOT_FOUND: { ring: "ring-destructive/60 bg-destructive/10", chip: "bg-destructive text-white", icon: XCircle },
};

const NHAN: Record<ScanOutcome, string> = {
  RECEIVED: "Đã nhận",
  ALREADY: "Đã nhận từ trước",
  NEEDS_CONFIRM: "Cần xác nhận",
  NOT_FOUND: "Không thấy mã",
};

/**
 * ÂM BÁO CỦA ERP, DỰNG BẰNG WEB AUDIO — không tải tệp âm thanh nào.
 *
 * Ba cao độ để phân biệt được mà không cần nhìn màn hình: người kho đang cúi xuống kiện hàng.
 * Trình duyệt chặn phát âm trước khi người dùng chạm vào trang, nên mọi lỗi ở đây đều bị nuốt —
 * âm báo là thứ đi kèm, mất nó không được làm hỏng lượt ghi.
 */
function dungChuong() {
  let ctx: AudioContext | null = null;
  return (outcome: ScanOutcome) => {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx ??= new AC();
      void ctx.resume();
      const notes: Record<ScanOutcome, { hz: number; ms: number }[]> = {
        RECEIVED: [{ hz: 880, ms: 90 }],
        ALREADY: [
          { hz: 520, ms: 90 },
          { hz: 520, ms: 90 },
        ],
        NEEDS_CONFIRM: [
          { hz: 520, ms: 90 },
          { hz: 520, ms: 90 },
        ],
        NOT_FOUND: [{ hz: 200, ms: 260 }],
      };
      let t = ctx.currentTime;
      for (const n of notes[outcome]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = n.hz;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n.ms / 1000);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + n.ms / 1000 + 0.02);
        t += n.ms / 1000 + 0.05;
      }
    } catch {
      /* Không phát được âm thì thôi — màu và dòng chữ vẫn nói đủ. */
    }
  };
}

export function ReceiveScanDesk({ canWrite, awaiting }: { canWrite: boolean; awaiting: number }) {
  const router = useRouter();
  const [ma, setMa] = React.useState("");
  const [dangGui, setDangGui] = React.useState(false);
  const [lichSu, setLichSu] = React.useState<Dong[]>([]);
  const [nhay, setNhay] = React.useState<ScanOutcome | null>(null);
  const [amBao, setAmBao] = React.useState(true);
  const [daNhan, setDaNhan] = React.useState(0);
  /** Mã đang chờ lượt bấm thứ hai vì ĐVVC không báo nó đang hoàn. */
  const [choXacNhan, setChoXacNhan] = React.useState<string | null>(null);
  const o = React.useRef<HTMLInputElement>(null);
  const lanCuoi = React.useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const chuong = React.useRef(dungChuong());

  /** Con trỏ LUÔN quay về ô mã — đây là thứ giữ nhịp bắn liên tục không cần chạm chuột. */
  const tuTu = React.useCallback(() => {
    requestAnimationFrame(() => o.current?.focus());
  }, []);
  React.useEffect(() => {
    if (canWrite) tuTu();
  }, [canWrite, tuTu]);

  const phanHoi = React.useCallback(
    (outcome: ScanOutcome) => {
      setNhay(outcome);
      if (amBao) chuong.current(outcome);
      window.setTimeout(() => setNhay(null), 700);
    },
    [amBao],
  );

  async function gui(raw: string, confirmUnexpected: boolean) {
    const code = raw.trim();
    if (!code) return;

    /*
      BỎ QUA MÃ GIỐNG HỆT BẮN LẠI TRONG TÍCH TẮC.
      Không bỏ qua thì lượt thứ hai đi lên máy chủ, trả về `ALREADY`, và người kho nhận một dòng
      vàng cho một kiện họ vừa bắn ĐÚNG MỘT LẦN — rồi bắt đầu nghi ngờ mọi dòng vàng khác.
      Lượt XÁC NHẬN (bấm lần hai có chủ ý) đi qua chốt này, vì nó là một hành động khác.
    */
    if (!confirmUnexpected && lanCuoi.current.code === code && Date.now() - lanCuoi.current.at < NHAY_TRUNG) {
      setMa("");
      tuTu();
      return;
    }
    lanCuoi.current = { code, at: Date.now() };

    setDangGui(true);
    const r = await scanReceiveReturnAction({ code, confirmUnexpected });
    setDangGui(false);
    setMa("");
    tuTu();

    if ("error" in r) {
      phanHoi("NOT_FOUND");
      toast.error(r.error);
      return;
    }

    phanHoi(r.outcome);
    setChoXacNhan(r.outcome === "NEEDS_CONFIRM" ? code : null);
    setLichSu((prev) =>
      [
        {
          key: `${code}-${Date.now()}`,
          outcome: r.outcome,
          code,
          message: r.message,
          at: new Date(),
          needsConfirm: r.outcome === "NEEDS_CONFIRM",
          shipmentCode: r.parcel?.code ?? null,
        },
        ...prev,
      ].slice(0, LICH_SU),
    );

    if (r.outcome === "RECEIVED") {
      setDaNhan((n) => n + 1);
      toast.success(r.message);
      /*
        KHÔNG `router.refresh()` SAU MỖI LƯỢT BẮN.
        Trang này dựng hàng chục truy vấn báo cáo; làm mới sau từng kiện là bắt máy chủ tính lại tất
        cả 300 lần trong một ca, và màn hình nhấp nháy đúng lúc người kho đang nhìn dòng vừa hiện.
        Dòng lịch sử ngay dưới đây đã là phản hồi đủ; hàng đợi bên dưới làm mới khi người kho bấm
        nút, hoặc lần tải trang sau.
      */
    } else if (r.outcome === "NOT_FOUND") {
      toast.error(r.message, { duration: 8000 });
    } else {
      toast.warning(r.message, { duration: 8000 });
    }
  }

  if (!canWrite) return null;

  const tone = nhay ? TONE[nhay] : null;

  return (
    <div className={cn("rounded-xl border bg-card p-3 ring-2 ring-transparent transition-colors duration-200", tone?.ring)}>
      <div className="flex flex-wrap items-center gap-2">
        <ScanBarcode className="size-5 shrink-0 text-primary" />
        <form
          className="flex min-w-[260px] flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dangGui) return;
            void gui(ma, false);
          }}
        >
          <Input
            ref={o}
            value={ma}
            onChange={(e) => setMa(e.target.value)}
            placeholder="Bắn mã vận đơn để NHẬN KIỆN rồi Enter…"
            className="h-11 flex-1 font-mono text-base"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            aria-label="Mã vận đơn của kiện hàng hoàn đang cầm trên tay"
          />
          <Button type="submit" className="h-11" disabled={dangGui || !ma.trim()}>
            {dangGui ? <Loader2 className="size-4 animate-spin" /> : "Nhận kiện"}
          </Button>
        </form>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11"
          onClick={() => {
            setAmBao((v) => !v);
            tuTu();
          }}
          title={amBao ? "Tắt âm báo của ERP" : "Bật âm báo của ERP"}
        >
          {amBao ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
        </Button>
      </div>

      <p className="mt-2 text-[11.5px] text-muted-foreground">
        Bắn mã CHỈ ghi nhận kiện đã về tới kho — <span className="font-medium">không cộng một món nào vào tồn</span>. Hàng vào tồn ở trạm đếm bên dưới, theo số đếm
        thực tế. Con trỏ tự quay về ô này sau mỗi lần bắn; bắn trùng không tạo phiếu thứ hai.
        {awaiting ? ` Còn ${formatNumber(awaiting)} kiện ĐVVC đã trả về mà kho chưa bấm nhận.` : ""}
        {daNhan ? <span className="ml-1 font-medium text-emerald-700 dark:text-emerald-400">Phiên này đã nhận {formatNumber(daNhan)} kiện.</span> : null}
      </p>

      {/*
        NÚT XÁC NHẬN CHO KIỆN NGOÀI CHẶNG HOÀN.
        Kiện đang nằm trên bàn mà ĐVVC báo "đã giao" là một mâu thuẫn có thật — và nó phải đi qua
        một lượt bấm CÓ CHỦ Ý, chứ không được ghi lặng lẽ. Lượt ghi mang dấu "nhận ngoài chặng hoàn".
      */}
      {choXacNhan ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[12px]">
          <CircleAlert className="size-4 shrink-0 text-amber-600" />
          <span className="flex-1">
            <span className="font-mono font-medium">{choXacNhan}</span> không ở chiều hoàn theo ĐVVC. Kiện vẫn đang trên tay bạn?
          </span>
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={dangGui}
            onClick={() => {
              const c = choXacNhan;
              setChoXacNhan(null);
              void gui(c, true);
            }}
          >
            Vẫn nhận kiện này
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setChoXacNhan(null);
              tuTu();
            }}
          >
            Bỏ qua
          </Button>
        </div>
      ) : null}

      {lichSu.length ? (
        <div className="mt-2 space-y-1">
          {lichSu.map((d) => {
            const t = TONE[d.outcome];
            const Icon = t.icon;
            return (
              <div key={d.key} className="flex items-start gap-2 rounded-lg border bg-background/60 px-2 py-1.5 text-[12px]">
                <Icon className={cn("mt-0.5 size-3.5 shrink-0", d.outcome === "RECEIVED" ? "text-emerald-600" : d.outcome === "NOT_FOUND" ? "text-destructive" : "text-amber-600")} />
                <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-medium", t.chip)}>{NHAN[d.outcome]}</span>
                <span className="font-mono text-[11.5px]">{d.shipmentCode ?? d.code}</span>
                <span className="min-w-0 flex-1 text-muted-foreground">{d.message}</span>
                <span className="numeric shrink-0 text-[11px] text-muted-foreground">{d.at.toLocaleTimeString("vi-VN")}</span>
              </div>
            );
          })}
          <div className="pt-1">
            <Button type="button" variant="outline" size="sm" className="h-7 text-[11.5px]" onClick={() => router.refresh()}>
              Làm mới hàng đợi
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
