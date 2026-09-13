"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { parseAsString, useQueryStates } from "nuqs";
import { CalendarClock, Check, ExternalLink, Loader2, MessageSquarePlus, Pencil, Phone, Plus, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";
import { CareDrawerHost, CareOpenButton } from "@/app/(dashboard)/shipments/care-drawer";
import { CopyButton } from "@/components/misc";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { addCareNote, bulkRequestCarrierAction, markCarrierManualDone, recordBusinessAction, reopenCase, requestCarrierAction, saveCareNotePresets, setCareFollowUp, setCareOwner, setCareStatus } from "@/lib/actions/care-workbench";
import type { BulkOutcome, BulkResult } from "@/lib/care/service";
import { canRequestCarrierAction } from "@/lib/care/redelivery-eligibility";
import { CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { ACTION_CALLS_CARRIER, BUSINESS_ACTIONS, BUSINESS_ACTION_HINT, BUSINESS_ACTION_LABEL, type BusinessAction } from "@/lib/constants/care-outcome";
import { RETURN_REASON_GROUPS, RETURN_REASON_GROUP_LABEL, RETURN_REASON_GROUP_OF, RETURN_REASON_LABEL, RETURN_REASONS, type ReturnReason } from "@/lib/constants/return-reason";
import { careViewOf, slaOf } from "@/lib/care/view";
import {
  CARE_ATTEMPT_BANDS,
  CARE_COD_BANDS,
  CARE_SLA_BUCKETS,
  CARE_SLA_BUCKET_HINT,
  CARE_SLA_BUCKET_LABEL,
  CARE_SLA_BUCKET_TONE,
  careAttemptBand,
  careCodBand,
  careFacet,
  careSlaBucket,
  matchesCareFilters,
  type CareAttemptBand,
  type CareCodBand,
  type CareFilters,
  type CareSlaBucket,
} from "@/lib/care/filters";
import {
  CARE_REASON_LABEL,
  CARE_STATUSES,
  CARE_STATUS_HINT,
  CARE_STATUS_LABEL,
  CARE_STATUS_TONE,
  CARE_VIEW_LABEL,
  CARRIER_ACTION_LABEL,
  CARRIER_REQUEST_LABEL,
  CARRIER_REQUEST_TONE,
  FOLLOW_UP_PRESETS,
  CARE_WAITING_STATUSES,
  defaultFollowUpAt,
  type CareStatus,
  type CareView,
  type CarrierActionKey,
  CARE_NOTE_PRESETS_MAX,
  type CareNotePreset,
} from "@/lib/constants/care";
import { CARE_ACTION_KINDS, CARE_ACTION_LABEL, type CareActionKind } from "@/lib/constants/delivery-tower";
import { formatDateTime, formatNumber, formatTimeAgo, formatVND } from "@/lib/format";
import type { CareCase, CareState, CareWorkbench, CarrierRequestView } from "@/lib/queries/care-workbench";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BÀN LÀM VIỆC GIAO VẬN ═══════════
 *
 * Danh sách là TRẠNG THÁI PHÍA TRÌNH DUYỆT: mỗi hành động trả về mảnh care mới của kiện và dòng
 * được vá tại chỗ — không tải lại trang, không cuộn. Kiện đổi góc nhìn (vd bấm Đã xong ở Cần care)
 * thì rời danh sách này ngay, đếm trên tab đổi theo, lịch sử vẫn ở nhật ký và ngăn kéo.
 *
 * Chiều ĐVVC (cột "VTP báo") và chiều care (cột "Care") đứng cạnh nhau nhưng KHÔNG bao giờ suy ra
 * lẫn nhau.
 */

type Props = {
  initial: CareWorkbench;
  view: Exclude<CareView, "all">;
  staff: { id: string; name: string }[];
  /** Mẫu note nhanh của shop — bấm là đổ chữ vào ô; thêm/bớt ngay trong popover. */
  presets: CareNotePreset[];
  canManage: boolean;
};

const CARRIER_MENU: CarrierActionKey[] = ["redeliver", "approve-return", "resend", "cancel"];

function gio(h: number | null) {
  if (h === null) return "chưa có tin";
  if (h < 1) return "<1 giờ";
  if (h < 48) return `${Math.round(h)} giờ`;
  return `${Math.round(h / 24)} ngày`;
}

function sangMai() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

function reviveState(s: CareState): CareState {
  // Server Action trả Date đã được tuần tự hoá lại thành Date ở phía client (React Flight), nhưng
  // phòng khi là chuỗi thì ép về Date để luật góc nhìn không so sánh nhầm.
  const d = (v: unknown) => (v ? new Date(v as string) : null);
  return { ...s, followUpAt: d(s.followUpAt), lastNoteAt: d(s.lastNoteAt), firstResponseAt: d(s.firstResponseAt), doneAt: d(s.doneAt), updatedAt: d(s.updatedAt) };
}

/** Nhãn kết quả từng kiện. Bốn lối ra, và chúng KHÔNG được gộp: mỗi cái dẫn tới một việc khác. */
const BULK_LABEL: Record<BulkOutcome, string> = {
  SUCCESS: "ĐÃ GỬI",
  MANUAL_REQUIRED: "LÀM TAY",
  SKIPPED: "BỎ QUA",
  FAILED: "TỪ CHỐI",
};
const BULK_TONE: Record<BulkOutcome, string> = {
  SUCCESS: "text-emerald-600 dark:text-emerald-400",
  MANUAL_REQUIRED: "text-amber-600 dark:text-amber-400",
  SKIPPED: "text-muted-foreground",
  FAILED: "text-rose-600 dark:text-rose-400",
};

export function CareWorkbenchView({ initial, view, staff, presets: initialPresets, canManage }: Props) {
  const [cases, setCases] = useState<CareCase[]>(() => initial.cases.map((c) => ({ ...c, queueSince: new Date(c.queueSince) })));
  // Mẫu note dùng chung cho mọi dòng: sửa ở một dòng, dòng khác thấy ngay.
  const [presets, setPresets] = useState<CareNotePreset[]>(initialPresets);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /*
    ═══ BỘ LỌC SỐNG TRÊN ĐƯỜNG DẪN, KHÔNG SỐNG TRONG BỘ NHỚ MÀN HÌNH ═══

    Trước bản này bộ lọc là `useState`: tải lại trang là mất, gửi đường dẫn cho đồng nghiệp thì họ
    mở ra thấy một danh sách khác, và mở một kiện rồi quay lại là phải lọc lại từ đầu. Đưa vào query
    param thì cả ba thứ đó tự hết.

    `shallow: true` (mặc định) — hàng đợi đã nằm sẵn ở trình duyệt, đổi bộ lọc KHÔNG cần hỏi lại máy
    chủ. `history: "replace"` để gõ một từ khoá không sinh mười lượt Back.
  */
  const [f, setF] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      nguoi: parseAsString.withDefault(""),
      lydo: parseAsString.withDefault(""),
      dvvc: parseAsString.withDefault(""),
      han: parseAsString.withDefault(""),
      tien: parseAsString.withDefault(""),
      hut: parseAsString.withDefault(""),
      hang: parseAsString.withDefault(""),
    },
    { history: "replace", clearOnDefault: true },
  );
  const filters: CareFilters = useMemo(
    () => ({ view, q: f.q, owner: f.nguoi, reason: f.lydo, substate: f.dvvc, sla: f.han as CareSlaBucket | "", cod: f.tien as CareCodBand | "", attempts: f.hut as CareAttemptBand | "", sku: f.hang }),
    [view, f],
  );
  const [pending, start] = useTransition();
  /** Kết quả TỪNG KIỆN của lượt gửi hàng loạt gần nhất. `null` = chưa chạy lượt nào. */
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  /** Hành động đang chờ xác nhận. Chống bấm hai lần: nút xác nhận khoá trong lúc `pending`. */
  const [confirmAction, setConfirmAction] = useState<CarrierActionKey | null>(null);

  const patch = (shipmentId: string, care: CareState, extra: Partial<CareCase> = {}) =>
    setCases((prev) =>
      prev.map((c) => {
        if (c.shipmentId !== shipmentId) return c;
        const revived = reviveState(care);
        const { view: v, reopened } = careViewOf(revived, c.queueSince);
        return { ...c, ...extra, care: revived, view: v, reopened, sla: slaOf(c.queueSince, revived, new Date(), initial.slaHours) };
      }),
    );

  const counts = useMemo(() => {
    const k = { care: 0, waiting: 0, escalated: 0, done: 0 };
    for (const c of cases) k[c.view] += 1;
    return k;
  }, [cases]);

  /*
    ═══ MỘT LUẬT LỌC CHO CẢ BẢNG LẪN CON SỐ TRÊN CHIP ═══

    `matchesCareFilters` (thuần, ở `lib/care/filters.ts`) quyết định bảng hiện gì; `careFacet` gọi
    ĐÚNG hàm đó với một chiều bị tắt để đếm chip. Trước bản này là hai đoạn mã song song, nên mỗi
    lần thêm một bộ lọc phải nhớ sửa cả hai — quên đoạn nào thì chip nói một số, bảng hiện một số.

    Giờ chốt MỘT LẦN mỗi lượt vẽ: SLA là hàm của thời gian, đọc `new Date()` bên trong vòng lặp thì
    hai dòng cạnh nhau được xét ở hai thời điểm, và tổng các chip lệch khỏi tổng bảng đúng vào lúc
    một ca vừa chạm hạn.
  */
  const [now, setNow] = useState(() => new Date());
  // Hạn xử lý là hàm của THỜI GIAN: đứng yên thì một ca vỡ hạn lúc 10:02 vẫn hiện "bình thường" cho
  // tới khi ai đó tải lại trang. Nhịp một phút đủ mịn cho hạn tính bằng giờ và đủ thưa để không phí.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const hours = initial.slaHours;

  const visible = useMemo(() => cases.filter((c) => matchesCareFilters(c, filters, now, hours)), [cases, filters, now, hours]);

  const reasons = useMemo(() => careFacet(cases, filters, "reason", (c) => c.reason, now, hours).sort((a, b) => b[1] - a[1]), [cases, filters, now, hours]);
  const substates = useMemo(() => careFacet(cases, filters, "substate", (c) => c.carrier.substate, now, hours).sort((a, b) => b[1] - a[1]), [cases, filters, now, hours]);
  const slaBuckets = useMemo(() => {
    const m = new Map(careFacet(cases, filters, "sla", (c) => careSlaBucket(c, now, hours), now, hours));
    return CARE_SLA_BUCKETS.map((k) => [k, m.get(k) ?? 0] as const).filter(([, n]) => n > 0);
  }, [cases, filters, now, hours]);
  const codBands = useMemo(() => {
    const m = new Map(careFacet(cases, filters, "cod", (c) => careCodBand(c.codAmount), now, hours));
    return CARE_COD_BANDS.map((b) => [b, m.get(b.key) ?? 0] as const).filter(([, n]) => n > 0);
  }, [cases, filters, now, hours]);
  const attemptBands = useMemo(() => {
    const m = new Map(careFacet(cases, filters, "attempts", (c) => careAttemptBand(c.carrier.failedAttempts), now, hours));
    return CARE_ATTEMPT_BANDS.map((b) => [b, m.get(b.key) ?? 0] as const).filter(([, n]) => n > 0);
  }, [cases, filters, now, hours]);

  /* Đếm và gỡ bộ lọc: người lọc bốn chiều rồi thấy bảng rỗng phải có một nút để ra, không phải sửa
     đường dẫn bằng tay. `view` không nằm trong đây — nó là cái TAB, không phải bộ lọc. */
  const daLoc = Object.values(f).filter((v) => v !== "").length;
  const xoaLoc = () => setF({ q: "", nguoi: "", lydo: "", dvvc: "", han: "", tien: "", hut: "", hang: "" });

  const queue = visible.map((c) => ({ shipmentId: c.shipmentId }));
  const moneyAtRisk = visible.reduce((a, c) => a + c.codAmount, 0);
  const overdue = visible.filter((c) => c.sla.firstResponseBreached || c.sla.resolveBreached).length;

  const bulkStatus = (status: CareStatus) =>
    start(async () => {
      const ids = [...selected];
      // Trạng thái CHỜ bắt buộc có giờ xem lại — bấm nhanh thì lấy mặc định, không để ca chìm.
      const r = await setCareStatus({ shipmentIds: ids, status, followUpAt: CARE_WAITING_STATUSES.includes(status) ? defaultFollowUpAt() : undefined });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      for (const [id, st] of Object.entries(r.data.states)) patch(id, st);
      setSelected(new Set());
      toast.success(`${ids.length} kiện → ${CARE_STATUS_LABEL[status]}`);
    });
  const bulkOwner = (ownerId: string) =>
    start(async () => {
      const ids = [...selected];
      const r = await setCareOwner({ shipmentIds: ids, ownerId: ownerId || null });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      for (const [id, st] of Object.entries(r.data.states)) patch(id, st);
      setSelected(new Set());
      toast.success(`Đã giao ${ids.length} kiện`);
    });

  /*
    ═══ GỬI LỆNH ĐVVC CHO NHIỀU KIỆN: THÀNH CÔNG MỘT PHẦN LÀ KẾT QUẢ HỢP LỆ ═══

    Máy chủ xét điều kiện TỪNG KIỆN và chỉ gửi lệnh cho kiện đủ điều kiện — kiện không đủ không
    sinh một gói tin nào. Ở đây chỉ hiển thị kết quả trả về, KHÔNG tự đoán: một lượt 40 kiện có thể
    ra 12 thành công, 9 bỏ qua, 19 phải làm tay, và cả ba con số đều đúng.

    KHÔNG tự đặt trạng thái lạc quan cho dòng: lệnh được NHẬN không phải hàng đã đi tiếp. Chỉ sự
    kiện hành trình của ĐVVC mới đổi được chiều ĐVVC, nên trang được làm mới từ máy chủ.
  */
  const bulkCarrier = (actionKey: CarrierActionKey) =>
    start(async () => {
      const ids = [...selected];
      const r = await bulkRequestCarrierAction({ shipmentIds: ids, actionKey, note: "" });
      setConfirmAction(null);
      if ("error" in r) {
        toast.error(r.error, { duration: 8000 });
        return;
      }
      setBulkResult(r.data);
      const { SUCCESS, MANUAL_REQUIRED, SKIPPED, FAILED } = r.data.counts;
      const cau = [SUCCESS ? `${SUCCESS} đã gửi` : "", MANUAL_REQUIRED ? `${MANUAL_REQUIRED} phải làm tay` : "", SKIPPED ? `${SKIPPED} bỏ qua` : "", FAILED ? `${FAILED} bị từ chối` : ""].filter(Boolean).join(" · ");
      toast[FAILED ? "warning" : "success"](`${CARRIER_ACTION_LABEL[actionKey]}: ${cau}`, { duration: 9000 });
      setSelected(new Set());
    });

  /* Bao nhiêu kiện trong tập đã chọn THẬT SỰ gửi lệnh được — hiện TRƯỚC khi bấm, không phải sau. */
  const duDieuKien = (actionKey: CarrierActionKey) =>
    [...selected]
      .map((id) => cases.find((c) => c.shipmentId === id))
      .filter((c): c is CareCase => Boolean(c))
      /*
        XÉT BẰNG ĐÚNG HÀM CỦA MÁY CHỦ, trên đúng dữ liệu thô máy chủ dùng (mã + chữ + chặng).

        Hai tham số cuối cố ý coi như "có": màn hình không biết ERP đã khai tài khoản API chưa, và
        kiện thuộc tài khoản khác KHÔNG bị chặn — nó đi đường làm tay. Nên con số này trả lời đúng
        một câu: *bao nhiêu kiện đang ở ĐÚNG TRẠNG THÁI để làm việc này*. Hộp xác nhận nói tiếp
        phần còn lại, và máy chủ mới là nơi quyết định.
      */
      .filter((c) => canRequestCarrierAction(actionKey, { stage: c.carrier.stage, vtpStatus: c.carrier.vtpStatus, vtpStatusName: c.carrier.rawStatus, orderNumber: c.tracking, trackingCapability: "API_TRACKABLE", configured: true }).ok).length;

  const toggleAll = () => setSelected((s) => (s.size === visible.length ? new Set() : new Set(visible.map((c) => c.shipmentId))));

  return (
    <div className="space-y-3">
      <CareDrawerHost queue={queue} />

      {/* Dải tóm tắt + bộ lọc nhẹ: tất cả trên một hàng, không có thẻ KPI to. */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-semibold">{formatNumber(visible.length)} kiện</span>
        <span className="text-muted-foreground">· COD treo {formatVND(moneyAtRisk, { compact: true })}</span>
        {overdue ? <span className="font-semibold text-rose-600 dark:text-rose-400">· {formatNumber(overdue)} vỡ SLA</span> : null}
        <span className="text-muted-foreground">· chưa ai nhận {formatNumber(visible.filter((c) => !c.care.owner).length)}</span>
        <InfoHint>
          {/* Số giờ đọc từ ngưỡng ĐANG HIỆU LỰC máy chủ gửi xuống — chủ shop đổi hạn ở cấu hình thì câu này đổi theo, không phải sửa mã. */}
          SLA: phản hồi đầu trong {formatNumber(hours.firstResponseHours)} giờ, đóng hoặc escalate trong {formatNumber(hours.resolveHours)} giờ, tính từ lúc kiện VÀO điều kiện cần care (lần giao hụt gần nhất / tin cuối). Kiện rời danh sách khi điều kiện hết (đã giao, đã hoàn…) — lịch sử giữ nguyên.
        </InfoHint>
        {daLoc ? (
          <button type="button" onClick={xoaLoc} className="rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent">
            Bỏ {formatNumber(daLoc)} bộ lọc
          </button>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <input value={f.q} onChange={(e) => setF({ q: e.target.value })} placeholder="Mã · SĐT · tên · #đơn" className="h-7 w-40 rounded-md border bg-background px-2 text-xs" aria-label="Tìm theo mã vận đơn, số điện thoại, tên khách hoặc số đơn" />
          <input value={f.hang} onChange={(e) => setF({ hang: e.target.value })} placeholder="Mã hàng · mẫu mã" className="h-7 w-36 rounded-md border bg-background px-2 text-xs" aria-label="Lọc theo mã hàng hoặc mẫu mã trong kiện" />
          <select value={f.nguoi} onChange={(e) => setF({ nguoi: e.target.value })} className="h-7 rounded-md border bg-background px-1.5 text-xs" aria-label="Lọc theo người care">
            <option value="">Mọi người</option>
            <option value="none">Chưa ai nhận</option>
            {staff.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </span>
      </div>

      {reasons.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {reasons.map(([k, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setF({ lydo: f.lydo === k ? "" : k })}
              className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-accent", f.lydo === k && "border-primary bg-accent font-semibold")}
            >
              {CARE_REASON_LABEL[k as keyof typeof CARE_REASON_LABEL] ?? k} <span className="numeric text-muted-foreground">{n}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/*
        ═══ HAI HÀNG CHIP, HAI CHIỀU, KHÔNG TRỘN ═══

        Hàng trên: VÌ SAO kiện cần người (rổ care). Hàng dưới: ĐVVC ĐANG LÀM GÌ (chứng từ).
        Trước bản này chỉ có hàng trên, nên "chờ phát lại" và "tồn - khách nghỉ" — hai việc khác
        hẳn nhau — không có cách nào lọc tách ra.
      */}
      {substates.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">ĐVVC báo</span>
          {substates.map(([k, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setF({ dvvc: f.dvvc === k ? "" : k })}
              title={`Trạng thái của đơn vị vận chuyển, đọc từ mã và tên trạng thái gốc. Khác với “vì sao cần care” ở hàng trên và khác với trạng thái xử lý của đội.`}
              className={cn("rounded-full border border-dashed px-2.5 py-0.5 text-[11.5px] hover:bg-accent", f.dvvc === k && "border-solid border-primary bg-accent font-semibold")}
            >
              {CARRIER_SUBSTATE_LABEL[k as CarrierSubstate]} <span className="numeric text-muted-foreground">{n}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/*
        ═══ HÀNG THỨ BA: XẾP VIỆC — GẤP TỚI ĐÂU · BAO NHIÊU TIỀN · ĐÃ HỤT MẤY LẦN ═══

        Ba chiều này không nói kiện VÌ SAO cần care (hàng một) và cũng không nói ĐVVC đang làm gì
        (hàng hai) — chúng trả lời "sáng nay làm cái nào trước". Rổ 0 kiện không hiện: một chip bấm
        vào ra bảng rỗng là một cái bẫy.
      */}
      {slaBuckets.length > 1 || codBands.length > 1 || attemptBands.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {slaBuckets.length > 1 ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Hạn</span>
              {slaBuckets.map(([k, n]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setF({ han: f.han === k ? "" : k })}
                  title={CARE_SLA_BUCKET_HINT[k]}
                  className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-accent", CARE_SLA_BUCKET_TONE[k], f.han === k && "border-primary bg-accent font-semibold")}
                >
                  {CARE_SLA_BUCKET_LABEL[k]} <span className="numeric opacity-70">{n}</span>
                </button>
              ))}
            </span>
          ) : null}
          {codBands.length > 1 ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">COD</span>
              {codBands.map(([b, n]) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => setF({ tien: f.tien === b.key ? "" : b.key })}
                  className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-accent", f.tien === b.key && "border-primary bg-accent font-semibold")}
                >
                  {b.label} <span className="numeric text-muted-foreground">{n}</span>
                </button>
              ))}
            </span>
          ) : null}
          {attemptBands.length > 1 ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Lần phát</span>
              {attemptBands.map(([b, n]) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => setF({ hut: f.hut === b.key ? "" : b.key })}
                  title="Số lần Viettel Post phát hụt, đếm từ chứng từ hành trình — không đọc từ câu chữ trạng thái."
                  className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-accent", f.hut === b.key && "border-primary bg-accent font-semibold")}
                >
                  {b.label} <span className="numeric text-muted-foreground">{n}</span>
                </button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {selected.size ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          <span className="font-semibold">{selected.size} kiện đã chọn</span>
          {CARE_STATUSES.map((s) => (
            <Button key={s} size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={pending} onClick={() => bulkStatus(s)}>
              {CARE_STATUS_LABEL[s]}
            </Button>
          ))}
          <select className="h-7 rounded-md border bg-background px-1.5 text-xs" defaultValue="" onChange={(e) => e.target.value !== "" && bulkOwner(e.target.value === "none" ? "" : e.target.value)} aria-label="Giao cho">
            <option value="">Giao cho…</option>
            <option value="none">Bỏ người nhận</option>
            {staff.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          {canManage ? (
            <>
              <span className="text-muted-foreground">|</span>
              {(["redeliver", "approve-return"] as CarrierActionKey[]).map((k) => (
                <Button key={k} size="sm" variant="secondary" className="h-7 px-2 text-xs" disabled={pending} onClick={() => setConfirmAction(k)}>
                  <Truck className="size-3.5" /> {CARRIER_ACTION_LABEL[k]} <span className="numeric opacity-70">{duDieuKien(k)}/{selected.size}</span>
                </Button>
              ))}
            </>
          ) : null}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelected(new Set())}>
            Bỏ chọn
          </Button>
        </div>
      ) : null}

      {/* XÁC NHẬN TRƯỚC KHI GỬI: nói rõ bao nhiêu kiện SẼ gửi và bao nhiêu kiện sẽ bị bỏ qua. */}
      {confirmAction ? (
        <div className="rounded-lg border border-amber-300/70 bg-amber-50/60 px-3 py-2.5 text-xs dark:border-amber-900/60 dark:bg-amber-950/20">
          <p className="font-semibold">
            Gửi “{CARRIER_ACTION_LABEL[confirmAction]}” lên Viettel Post? {duDieuKien(confirmAction)} / {selected.size} kiện đã chọn đang ở đúng trạng thái để làm việc này.
          </p>
          <p className="mt-1 text-muted-foreground">
            {selected.size - duDieuKien(confirmAction)} kiện còn lại sẽ được <b>bỏ qua</b> — ERP không gửi lệnh nào cho chúng. Kiện thuộc tài khoản
            Viettel Post khác sẽ được ghi là <b>phải làm tay</b> kèm đường dẫn, cũng không gửi lệnh. Lệnh được ĐVVC nhận <b>không</b> có nghĩa hàng đã đi tiếp:
            chỉ sự kiện hành trình mới xác nhận điều đó.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" className="h-7 px-2.5 text-xs" disabled={pending} onClick={() => bulkCarrier(confirmAction)}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Gửi
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" disabled={pending} onClick={() => setConfirmAction(null)}>
              Huỷ
            </Button>
          </div>
        </div>
      ) : null}

      {/* KẾT QUẢ TỪNG MÃ VẬN ĐƠN — không gộp thành một câu "đã xong". */}
      {bulkResult ? (
        <div className="rounded-lg border text-xs">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <span className="font-semibold">Kết quả lượt gửi gần nhất</span>
            <span className="text-muted-foreground">
              {bulkResult.counts.SUCCESS} đã gửi · {bulkResult.counts.MANUAL_REQUIRED} phải làm tay · {bulkResult.counts.SKIPPED} bỏ qua · {bulkResult.counts.FAILED} bị từ chối
            </span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={() => setBulkResult(null)}>
              Đóng
            </Button>
          </div>
          <ul className="max-h-64 divide-y overflow-y-auto">
            {bulkResult.rows.map((r) => (
              <li key={r.shipmentId} className="flex gap-2 px-3 py-1.5">
                <span className={cn("shrink-0 font-semibold", BULK_TONE[r.outcome])}>{BULK_LABEL[r.outcome]}</span>
                <span className="shrink-0 font-mono text-[11px]">{r.tracking}</span>
                <span className="min-w-0 flex-1 text-muted-foreground">{r.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
          {view === "care" ? "Không có kiện nào đang cần care — mọi kiện đang chạy đúng lịch hoặc đã có người theo." : `Không có kiện nào ở “${CARE_VIEW_LABEL[view]}”.`}
        </div>
      ) : (
        <div className={cn(TABLE_SCROLL, "rounded-xl border")}>
          <table className="w-full min-w-[1180px] text-[12px]">
            <thead className={cn(STICKY_HEAD, "border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground")}>
              <tr>
                <th className="w-8 px-2 py-2">
                  <input type="checkbox" aria-label="Chọn tất cả" checked={selected.size > 0 && selected.size === visible.length} onChange={toggleAll} />
                </th>
                <th className="px-2 py-2 font-semibold">Kiện · vì sao</th>
                <th className="px-2 py-2 font-semibold">Khách · COD</th>
                <th className="px-2 py-2 font-semibold" title="Chiều ĐVVC — chứng từ Viettel Post, đội không sửa được">
                  VTP báo
                </th>
                <th className="px-2 py-2 font-semibold" title="Chiều nội bộ — đội đã làm tới đâu; không suy ra từ trạng thái VTP">
                  Care
                </th>
                <th className="px-2 py-2 font-semibold">Note gần nhất</th>
                <th className="px-2 py-2 font-semibold">Viettel Post</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((c) => (
                <CaseRow
                  key={c.shipmentId}
                  c={c}
                  staff={staff}
                  presets={presets}
                  onPresetsChange={setPresets}
                  canManage={canManage}
                  checked={selected.has(c.shipmentId)}
                  onCheck={(v) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (v) n.add(c.shipmentId);
                      else n.delete(c.shipmentId);
                      return n;
                    })
                  }
                  onPatch={(care, extra) => patch(c.shipmentId, care, extra)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        {(["care", "waiting", "escalated", "done"] as const).map((v) => `${CARE_VIEW_LABEL[v]} ${counts[v]}`).join(" · ")}
      </p>
    </div>
  );
}

function CaseRow({ c, staff, presets, onPresetsChange, canManage, checked, onCheck, onPatch }: { c: CareCase; staff: { id: string; name: string }[]; presets: CareNotePreset[]; onPresetsChange: (p: CareNotePreset[]) => void; canManage: boolean; checked: boolean; onCheck: (v: boolean) => void; onPatch: (care: CareState, extra?: Partial<CareCase>) => void }) {
  const [pending, start] = useTransition();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<CareActionKind>("CALLED_REACHED");
  const [vtpOpen, setVtpOpen] = useState(false);
  const [vtpNote, setVtpNote] = useState("");
  const terminal = c.care.status === "RESOLVED" || c.care.status === "CANCELLED";

  const changeStatus = (status: CareStatus) =>
    start(async () => {
      // Trạng thái CHỜ bắt buộc có giờ xem lại: giữ giờ đang có, không có thì lấy mặc định.
      const r = await setCareStatus({ shipmentIds: [c.shipmentId], status, followUpAt: CARE_WAITING_STATUSES.includes(status) ? (c.care.followUpAt ?? defaultFollowUpAt()) : undefined });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      const st = r.data.states[c.shipmentId];
      if (!st) {
        toast.error(r.data.skipped[0]?.reason ?? "Không đổi được trạng thái");
        return;
      }
      onPatch(st);
      if (status === "RESOLVED" || status === "CANCELLED") toast.success(`${c.tracking}: ${CARE_STATUS_LABEL[status]} — chuyển sang “Đã xử lý”`);
    });
  const reopen = () =>
    start(async () => {
      const r = await reopenCase({ shipmentId: c.shipmentId, note: "Mở lại từ bàn làm việc" });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onPatch(r.data);
      toast.success(`${c.tracking}: đã mở lại — quay về “Cần care”`);
    });
  const changeOwner = (ownerId: string) =>
    start(async () => {
      const r = await setCareOwner({ shipmentIds: [c.shipmentId], ownerId: ownerId || null });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      const st = r.data.states[c.shipmentId];
      if (st) onPatch(st);
    });
  const followUp = (at: Date | null) =>
    start(async () => {
      const r = await setCareFollowUp({ shipmentId: c.shipmentId, at });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onPatch(r.data);
      if (at) toast.success(`${c.tracking}: hẹn theo dõi ${formatDateTime(at)}`);
    });
  const saveNote = () =>
    start(async () => {
      const r = await addCareNote({ shipmentId: c.shipmentId, note, kind });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onPatch(r.data, { lastCareAction: { label: CARE_ACTION_LABEL[kind], at: new Date(), byHuman: true } });
      setNote("");
      setNoteOpen(false);
    });
  /*
    ═══ QUYẾT ĐỊNH NGHIỆP VỤ — KHÁC HẲN TRẠNG THÁI XỬ LÝ ═══

    Trạng thái xử lý nói ĐỘI ĐANG Ở ĐÂU ("đang xử lý", "chờ khách"). Quyết định nghiệp vụ nói ĐỘI
    ĐÃ CHỌN LÀM GÌ ("duyệt hoàn", "phát tiếp"). Trước bản này cả hai nằm chung một menu, nên
    "Duyệt hoàn" đứng cạnh "Đang xử lý" như thể cùng loại — và lịch sử đọc lên không thành câu
    chuyện nào.

    KHÔNG tự đổi chiều ĐVVC ở đây: máy chủ chỉ ghi quyết định và gửi yêu cầu; kết quả do sự kiện
    hành trình chốt (`lib/care/lifecycle.ts`).
  */
  const doBusiness = (action: BusinessAction, extra: { reasonCode?: string; followUpAt?: Date; replacementShipmentId?: string } = {}) =>
    start(async () => {
      const r = await recordBusinessAction({ shipmentId: c.shipmentId, action, note: vtpNote, ...extra });
      setVtpOpen(false);
      setVtpNote("");
      if ("error" in r) {
        toast.error(r.error, { duration: 9000 });
        return;
      }
      onPatch(r.data.care, r.data.request ? { carrierRequest: { ...r.data.request, at: new Date(r.data.request.at) } } : {});
      toast.success(r.data.message, { duration: 9000 });
    });

  const carrier = (actionKey: CarrierActionKey) =>
    start(async () => {
      const r = await requestCarrierAction({ shipmentId: c.shipmentId, actionKey, note: vtpNote });
      setVtpOpen(false);
      setVtpNote("");
      if ("error" in r) {
        toast.error(r.error, { duration: 8000 });
        return;
      }
      onPatch(c.care, { carrierRequest: { ...r.data.request, at: new Date(r.data.request.at) } });
      (r.data.request.status === "MANUAL_REQUIRED" ? toast.warning : toast.success)(r.data.message, { duration: 8000 });
    });
  const manualDone = (req: CarrierRequestView) =>
    start(async () => {
      const r = await markCarrierManualDone({ requestId: req.id });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onPatch(c.care, { carrierRequest: { ...r.data, at: new Date(r.data.at) } });
      toast.success("Đã ghi: làm tay trên Viettel Post");
    });

  const breached = c.sla.firstResponseBreached || c.sla.resolveBreached;
  /*
    MỘT LUẬT CHO MỌI NÚT: cùng `canRequestCarrierAction` mà máy chủ dùng, trên đúng dữ liệu thô
    (mã + chữ + chặng + năng lực tài khoản). Trước đây bàn care lọc bằng `carrierActionAllowed`
    (chặng thô), trang chi tiết có danh sách chặng riêng, còn máy chủ xét trạng thái con — ba câu
    trả lời cho một câu hỏi. Nút không đủ điều kiện vẫn HIỆN nhưng khoá, kèm lý do trong tooltip.
  */
  const eligibility = (k: CarrierActionKey) => canRequestCarrierAction(k, { stage: c.carrier.stage, vtpStatus: c.carrier.vtpStatus, vtpStatusName: c.carrier.rawStatus, orderNumber: c.tracking, trackingCapability: c.carrier.trackingCapability, configured: true });
  const businessEligibility = (a: BusinessAction) => (ACTION_CALLS_CARRIER[a] ? eligibility(a === "APPROVE_RETURN" ? "approve-return" : "redeliver") : null);
  const [dialogFor, setDialogFor] = useState<"APPROVE_RETURN" | "EXCHANGE" | null>(null);
  const req = c.carrierRequest;

  return (
    <tr className={cn("align-top hover:bg-accent/30", pending && "opacity-60")}>
      <td className="px-2 py-2">
        <input type="checkbox" aria-label="Chọn kiện" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-1.5">
          {/*
            SAO CHÉP NGAY CẠNH MÃ — bàn care là nơi thao tác này diễn ra nhiều nhất: mở trang Viettel
            Post tra kiện, dán mã vào chat với ĐVVC, ghi vào sổ. Bôi đen một chuỗi 13 ký tự trong ô
            hẹp là thao tác dễ trượt và dễ thiếu ký tự. Bảng "Tất cả vận đơn" đã có nút này từ trước;
            bàn care thì chưa, tức là đúng chỗ làm việc cả ngày lại là chỗ thiếu.
            `CopyButton` có sẵn `stopPropagation` nên bấm nó KHÔNG mở ngăn kéo.
          */}
          <CareOpenButton shipmentId={c.shipmentId} className="font-mono text-[12.5px] font-semibold">
            {c.tracking}
          </CareOpenButton>
          {c.tracking ? <CopyButton value={c.tracking} className="size-5 shrink-0 [&_svg]:size-3" /> : null}
          {c.orderSystemId ? (
            <Link href={`/orders/${c.orderId}`} className="text-[11px] text-muted-foreground hover:underline">
              #{c.orderSystemId}
            </Link>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <span className="rounded bg-muted px-1.5 py-px text-[10.5px] font-medium" title={c.reasonDetail}>
            {c.reasonLabel}
          </span>
          {c.reopened ? <span className="rounded bg-violet-100 px-1.5 py-px text-[10.5px] font-medium text-violet-800 dark:bg-violet-950/60 dark:text-violet-300">mở lại</span> : null}
          {c.botMessageFailure ? (
            <span className="rounded bg-amber-100 px-1.5 py-px text-[10.5px] font-semibold text-amber-900 dark:bg-amber-950/60 dark:text-amber-300" title={`${c.botMessageFailure.title}\n${c.botMessageFailure.detail}`}>
              bot không nhắn được — gọi / Zalo thủ công
            </span>
          ) : null}
          {breached ? (
            <span className="rounded bg-rose-100 px-1.5 py-px text-[10.5px] font-semibold text-rose-800 dark:bg-rose-950/60 dark:text-rose-300" title={`Phản hồi đầu hạn ${formatDateTime(c.sla.firstResponseDueAt)} · đóng hạn ${formatDateTime(c.sla.resolveDueAt)}`}>
              vỡ SLA
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground" title={c.nextAction}>
          Nên: {c.nextAction.length > 70 ? `${c.nextAction.slice(0, 70)}…` : c.nextAction}
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="font-medium">{c.customer}</div>
        {c.phone ? (
          // Gọi được thì bấm; nhắn Zalo / dán vào Pancake thì cần sao chép. Hai việc khác nhau nên
          // phải có hai nút — một cái link `tel:` không giúp gì cho người đang mở cửa sổ chat.
          <span className="inline-flex items-center gap-0.5">
            <a href={`tel:${c.phone}`} className="numeric inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline">
              <Phone className="size-3" /> {c.phone}
            </a>
            <CopyButton value={c.phone} className="size-5 shrink-0 [&_svg]:size-3" />
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">chưa có SĐT</span>
        )}
        <div className="numeric font-semibold">{formatVND(c.codAmount)}</div>
      </td>
      <td className="px-2 py-2">
        <div>{c.carrier.rawStatus}</div>
        <div className="text-[11px] text-muted-foreground">
          {c.carrier.stageLabel} · {gio(c.carrier.ageHours)}
          {c.carrier.failedAttempts ? ` · hụt ${c.carrier.failedAttempts} lần` : ""}
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {terminal ? (
            <button type="button" disabled={pending} onClick={reopen} className="h-7 rounded-md border px-2 text-[11.5px] font-medium hover:bg-accent" title="Case đã đóng — mở lại để tiếp tục care (lịch sử giữ nguyên)">
              Mở lại
            </button>
          ) : null}
          <select
            value={c.care.status}
            disabled={pending || terminal}
            onChange={(e) => changeStatus(e.target.value as CareStatus)}
            title={CARE_STATUS_HINT[c.care.status]}
            className={cn("h-7 rounded-md border-0 px-1.5 text-[11.5px] font-semibold", CARE_STATUS_TONE[c.care.status])}
            aria-label="Trạng thái care"
          >
            {CARE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CARE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select value={c.care.owner?.id ?? ""} disabled={pending} onChange={(e) => changeOwner(e.target.value)} className="h-7 max-w-[120px] rounded-md border bg-background px-1.5 text-[11.5px]" aria-label="Người care">
            <option value="">Chưa ai nhận</option>
            {staff.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
          <CalendarClock className="size-3 text-muted-foreground" />
          {c.care.followUpAt ? (
            <button type="button" className={cn("hover:underline", c.care.followUpAt.getTime() <= Date.now() && "font-semibold text-rose-600 dark:text-rose-400")} title="Bấm để bỏ hẹn" onClick={() => followUp(null)}>
              {formatDateTime(c.care.followUpAt)}
            </button>
          ) : (
            FOLLOW_UP_PRESETS.map((p) => (
              <button key={p.key} type="button" disabled={pending} className="rounded border px-1 py-px text-[10.5px] hover:bg-accent" onClick={() => followUp(p.hours < 0 ? sangMai() : new Date(Date.now() + p.hours * 3600_000))}>
                {p.label}
              </button>
            ))
          )}
        </div>
        {c.care.updatedAt ? (
          <div className="mt-0.5 text-[10.5px] text-muted-foreground" title={formatDateTime(c.care.updatedAt)}>
            {c.care.updatedBy || "—"} · {formatTimeAgo(c.care.updatedAt)}
          </div>
        ) : null}
      </td>
      <td className="max-w-[220px] px-2 py-2">
        {c.care.lastNote ? (
          <div className="line-clamp-2" title={`${c.care.lastNote}\n— ${c.care.lastNoteBy} · ${c.care.lastNoteAt ? formatDateTime(c.care.lastNoteAt) : ""}`}>
            {c.care.lastNote}
          </div>
        ) : c.lastCareAction ? (
          <div className="text-muted-foreground" title={formatDateTime(c.lastCareAction.at)}>
            {c.lastCareAction.label}
            {c.lastCareAction.byHuman ? null : <span className="ml-1 rounded bg-muted px-1 text-[10px]">bot</span>}
          </div>
        ) : (
          <span className="font-medium text-rose-600 dark:text-rose-400">Chưa ai chạm</span>
        )}
        <Popover open={noteOpen} onOpenChange={setNoteOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="mt-1 inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] hover:bg-accent">
              <MessageSquarePlus className="size-3" /> Ghi note
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[22rem] space-y-2 p-3">
            {/*
              LOẠI hành động: bấm chọn loại và — nếu ô còn trống — đổ luôn nhãn vào ô, để một cú bấm
              là lưu được. Trước đây bấm chip chỉ đổi màu chip, ô vẫn trống, nút Lưu vẫn xám: người
              dùng tưởng hỏng (phản hồi chủ shop 11/09).
            */}
            <div className="flex flex-wrap gap-1">
              {CARE_ACTION_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setKind(k);
                    if (!note.trim() || (Object.values(CARE_ACTION_LABEL) as string[]).includes(note.trim())) setNote(CARE_ACTION_LABEL[k]);
                  }}
                  className={cn("rounded border px-1.5 py-px text-[10.5px]", kind === k ? "border-primary bg-primary/10 font-semibold" : "hover:bg-accent")}
                >
                  {CARE_ACTION_LABEL[k]}
                </button>
              ))}
            </div>
            <NotePresets presets={presets} canEdit={canManage} onChange={onPresetsChange} onPick={(p) => { setKind(p.kind); setNote(p.text); }} />
            <Textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && note.trim()) saveNote();
              }}
              placeholder="Khách nói gì? (Ctrl/⌘ + Enter để lưu)"
              className="min-h-[64px] text-[12px]"
            />
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setNoteOpen(false)}>
                Huỷ
              </Button>
              <Button size="sm" className="h-7 px-2 text-xs" disabled={pending || !note.trim()} onClick={saveNote}>
                {pending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Lưu
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </td>
      <td className="px-2 py-2">
        {req ? (
          <div className="mb-1">
            <span className={cn("rounded px-1.5 py-px text-[10.5px] font-medium", CARRIER_REQUEST_TONE[req.status])} title={`${CARRIER_ACTION_LABEL[req.actionKey]} · ${req.actor} · ${formatDateTime(req.at)}${req.error ? `\n${req.error}` : ""}`}>
              {CARRIER_ACTION_LABEL[req.actionKey]}: {CARRIER_REQUEST_LABEL[req.status]}
            </span>
            {req.status === "MANUAL_REQUIRED" && canManage ? (
              <button type="button" disabled={pending} onClick={() => manualDone(req)} className="ml-1 rounded border px-1.5 py-px text-[10.5px] hover:bg-accent" title="Bạn đã làm việc này trên viettelpost.vn — ghi lại để lịch sử không trống">
                Đã làm tay
              </button>
            ) : null}
          </div>
        ) : null}
        {canManage ? (
          <Popover open={vtpOpen} onOpenChange={setVtpOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] hover:bg-accent" title={c.carrierCapability === "API" ? "Gửi thẳng lên Viettel Post bằng tài khoản đối tác" : "Tài khoản API không sở hữu kiện này — ERP ghi yêu cầu và bạn làm tay trên viettelpost.vn"}>
                <Truck className="size-3" /> Xử lý
                <span className={cn("rounded px-1", c.carrierCapability === "API" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300")}>
                  {c.carrierCapability === "API" ? "API" : "làm tay"}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-2 p-3">
              <p className="text-[11px] text-muted-foreground">
                {c.carrierCapability === "API"
                  ? "Yêu cầu gửi thẳng lên Viettel Post. Chỉ được coi là THÀNH CÔNG khi sự kiện hành trình xác nhận."
                  : "Tài khoản API của ERP không sở hữu kiện này (vận đơn Pancake tạo). ERP ghi yêu cầu là PHẢI LÀM TAY; làm trên viettelpost.vn rồi bấm “Đã làm tay”."}
              </p>
              <Textarea value={vtpNote} onChange={(e) => setVtpNote(e.target.value)} placeholder="Ghi chú cho bưu cục (tuỳ chọn)" className="min-h-[48px] text-[12px]" />
              {/*
                BỐN QUYẾT ĐỊNH ĐỨNG RIÊNG, mỗi cái kèm một dòng nói rõ nó KHÔNG làm gì — vì đúng
                bốn hiểu nhầm đó là thứ làm hỏng số liệu: duyệt hoàn ≠ đã hoàn, phát tiếp ≠ đã cứu,
                đổi ≠ đơn thay thế thành công, theo dõi ≠ đã xử lý.
              */}
              <div className="space-y-1.5 border-t pt-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Xử lý</p>
                {BUSINESS_ACTIONS.map((a) => {
                  const e = businessEligibility(a);
                  const khoa = e !== null && !e.ok;
                  return (
                    <button
                      key={a}
                      type="button"
                      disabled={pending || khoa}
                      title={khoa ? e.reason : BUSINESS_ACTION_HINT[a]}
                      onClick={() => {
                        if (a === "APPROVE_RETURN" || a === "EXCHANGE") {
                          setVtpOpen(false);
                          setDialogFor(a);
                          return;
                        }
                        doBusiness(a, a === "CONTINUE_MONITORING" ? { followUpAt: new Date(Date.now() + 2 * 3600_000) } : {});
                      }}
                      className="flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-[11.5px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="shrink-0 font-semibold">{BUSINESS_ACTION_LABEL[a]}</span>
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        {khoa ? "không đủ điều kiện — xem lý do" : a === "APPROVE_RETURN" ? "chọn lý do hoàn" : a === "EXCHANGE" ? "nối vận đơn đơn đổi" : a === "CONTINUE_MONITORING" ? "hẹn lại sau 2 giờ" : e?.callsApi ? "gửi lệnh lên ĐVVC" : "làm tay, ERP ghi vết"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Lệnh ĐVVC khác</summary>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {CARRIER_MENU.map((k) => {
                    const e = eligibility(k);
                    return (
                      <Button key={k} size="sm" variant={k === "cancel" ? "destructive" : "outline"} className="h-7 px-2 text-xs" disabled={pending || !e.ok} title={e.ok ? e.reason || CARRIER_ACTION_LABEL[k] : e.reason} onClick={() => carrier(k)}>
                        {CARRIER_ACTION_LABEL[k]}
                      </Button>
                    );
                  })}
                </div>
              </details>
              <a href={`https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=${encodeURIComponent(c.tracking)}&orderType=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                <ExternalLink className="size-3" /> Mở trên viettelpost.vn
              </a>
            </PopoverContent>
          </Popover>
        ) : (
          <Link href={`/shipments/${c.shipmentId}`} className="text-[11px] text-primary hover:underline">
            Chi tiết
          </Link>
        )}
        <BusinessActionDialog
          action={dialogFor}
          tracking={c.tracking}
          pending={pending}
          onClose={() => setDialogFor(null)}
          onSubmit={(extra) => {
            setDialogFor(null);
            if (extra.action === "APPROVE_RETURN") doBusiness("APPROVE_RETURN", { reasonCode: extra.reasonCode });
            else doBusiness("EXCHANGE", { replacementShipmentId: extra.replacementShipmentId });
          }}
        />
      </td>
    </tr>
  );
}

/**
 * HAI QUYẾT ĐỊNH CẦN THÊM MỘT DỮ KIỆN: "Duyệt hoàn" cần LÝ DO theo danh mục (không có thì báo cáo
 * lý do hoàn rỗng vĩnh viễn), "Đổi" cần MÃ VẬN ĐƠN của đơn thay thế (không có thì "cứu bằng đơn đổi"
 * chỉ đoán được). Trước bản này hai nút chuyển sang trang chi tiết — nơi chỉ có lệnh ĐVVC thô, không
 * có chỗ nào ghi quyết định; đo 13/09/2026: `care_business_actions` có 0 dòng.
 */
function BusinessActionDialog({ action, tracking, pending, onClose, onSubmit }: { action: "APPROVE_RETURN" | "EXCHANGE" | null; tracking: string; pending: boolean; onClose: () => void; onSubmit: (extra: { action: "APPROVE_RETURN"; reasonCode: string } | { action: "EXCHANGE"; replacementShipmentId: string }) => void }) {
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [replacement, setReplacement] = useState("");
  const nhom = RETURN_REASON_GROUPS.filter((g) => g !== "UNKNOWN");
  const ok = action === "APPROVE_RETURN" ? reason !== "" : replacement.trim().length > 0;
  return (
    <Dialog open={action !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>
            {action ? BUSINESS_ACTION_LABEL[action] : ""} · <span className="font-mono">{tracking}</span>
          </DialogTitle>
          <DialogDescription>{action ? BUSINESS_ACTION_HINT[action] : ""}</DialogDescription>
        </DialogHeader>
        {action === "APPROVE_RETURN" ? (
          <select value={reason} onChange={(e) => setReason(e.target.value as ReturnReason | "")} className="h-9 w-full rounded-md border bg-background px-2 text-[13px]" aria-label="Lý do hoàn">
            <option value="">Chọn lý do hoàn…</option>
            {nhom.map((g) => (
              <optgroup key={g} label={RETURN_REASON_GROUP_LABEL[g]}>
                {RETURN_REASONS.filter((r) => RETURN_REASON_GROUP_OF[r] === g && r !== "UNKNOWN").map((r) => (
                  <option key={r} value={r}>
                    {RETURN_REASON_LABEL[r]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : action === "EXCHANGE" ? (
          <Input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="Mã vận đơn của đơn đổi (VD: 1234567890)" aria-label="Vận đơn đơn đổi" />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Huỷ
          </Button>
          <Button
            disabled={pending || !ok}
            onClick={() => {
              if (action === "APPROVE_RETURN" && reason) onSubmit({ action, reasonCode: reason });
              if (action === "EXCHANGE" && replacement.trim()) onSubmit({ action, replacementShipmentId: replacement.trim() });
            }}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Xác nhận
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


/**
 * MẪU NOTE NHANH — bấm là đổ chữ vào ô (và chọn loại), "Sửa mẫu" để thêm / bớt. Bộ mẫu dùng chung
 * cả shop, lưu ở bảng settings (`care.notePresets`), có nhật ký ai đổi.
 */
function NotePresets({ presets, canEdit, onChange, onPick }: { presets: CareNotePreset[]; canEdit: boolean; onChange: (p: CareNotePreset[]) => void; onPick: (p: CareNotePreset) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<CareActionKind>("CALLED_NO_ANSWER");
  const [saving, start] = useTransition();

  const persist = (next: CareNotePreset[]) =>
    start(async () => {
      const r = await saveCareNotePresets({ presets: next });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      onChange(r.data);
    });
  const add = () => {
    const t = text.trim();
    if (!t) return;
    if (presets.length >= CARE_NOTE_PRESETS_MAX) {
      toast.error(`Tối đa ${CARE_NOTE_PRESETS_MAX} mẫu`);
      return;
    }
    persist([...presets, { id: `p-${Date.now().toString(36)}`, kind, text: t }]);
    setText("");
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10.5px] uppercase tracking-wide text-muted-foreground">
        <span>Mẫu nhanh</span>
        {canEdit ? (
          <button type="button" className="inline-flex items-center gap-1 rounded px-1 hover:bg-accent normal-case" onClick={() => setEditing((v) => !v)}>
            <Pencil className="size-3" /> {editing ? "Xong" : "Sửa mẫu"}
          </button>
        ) : null}
      </div>
      {presets.length === 0 && !editing ? <p className="text-[11px] text-muted-foreground">{canEdit ? "Chưa có mẫu — bấm “Sửa mẫu” để thêm." : "Chưa có mẫu chung — nhờ trưởng CS thêm."}</p> : null}
      <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
        {presets.map((p) => (
          <span key={p.id} className="inline-flex max-w-full items-stretch overflow-hidden rounded border text-[10.5px]">
            <button type="button" className="truncate px-1.5 py-px text-left hover:bg-accent" title={`${CARE_ACTION_LABEL[p.kind]}\n${p.text}`} onClick={() => onPick(p)}>
              {p.text}
            </button>
            {editing ? (
              <button type="button" aria-label="Xoá mẫu" disabled={saving} className="border-l px-1 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40" onClick={() => persist(presets.filter((x) => x.id !== p.id))}>
                <Trash2 className="size-3" />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {editing ? (
        <div className="flex gap-1">
          <select value={kind} onChange={(e) => setKind(e.target.value as CareActionKind)} className="h-7 max-w-[120px] rounded-md border bg-background px-1 text-[11px]" aria-label="Loại hành động của mẫu">
            {CARE_ACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {CARE_ACTION_LABEL[k]}
              </option>
            ))}
          </select>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            maxLength={200}
            placeholder="Nội dung mẫu mới…"
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-[11.5px]"
          />
          <Button size="sm" className="h-7 px-2 text-xs" disabled={saving || !text.trim()} onClick={add}>
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
