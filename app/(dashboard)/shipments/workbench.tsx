"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { TableToolsFor } from "@/components/data-table/table-tools";
import Link from "next/link";
import { parseAsString, useQueryStates } from "nuqs";
import { CalendarClock, CalendarRange, Check, ChevronDown, ChevronRight, ExternalLink, Loader2, MessageSquarePlus, Pencil, Phone, Plus, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";
import { CareDrawerHost, CareOpenButton, onCareUpdated } from "@/app/(dashboard)/shipments/care-drawer";
import { CopyButton } from "@/components/misc";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { addCareNote, bulkRequestCarrierAction, loadCarrierJourney, markCarrierManualDone, recordBusinessAction, recordCareDecision, reopenCase, requestCarrierAction, saveCareNotePresets, setCareFollowUp, setCareOwner, setCareStatus } from "@/lib/actions/care-workbench";
import type { BulkOutcome, BulkResult } from "@/lib/care/service";
import { canRequestCarrierAction } from "@/lib/care/redelivery-eligibility";
import { CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { ACTION_CALLS_CARRIER, BUSINESS_ACTIONS, BUSINESS_ACTION_HINT, BUSINESS_ACTION_LABEL, type BusinessAction } from "@/lib/constants/care-outcome";
import { ResolutionControl, type ResolutionExtra } from "@/app/(dashboard)/shipments/resolution-control";
import {
  FOLLOW_UP_FILTERS,
  FOLLOW_UP_FILTER_HINT,
  FOLLOW_UP_FILTER_LABEL,
  RESOLUTION_FILTER_KEYS,
  RESOLUTION_FILTER_LABEL,
  RESOLUTION_HINT,
  RESOLUTION_LABEL,
  followUpBucket,
  type CareDecision,
  type FollowUpFilterKey,
  type ResolutionFilterKey,
} from "@/lib/constants/care-resolution";
import {
  CARE_DATES,
  CARE_DATE_KEYS,
  CARE_DATE_PRESETS,
  CARE_DATE_PROBLEM_LABEL,
  CARE_DATE_UNKNOWN,
  careDatePresetOf,
  careDatePresetValue,
  careDateValue,
  describeCareDateFilter,
  parseCareDateFilter,
  type CareDateKey,
} from "@/lib/constants/care-dates";
import { RETURN_REASON_GROUPS, RETURN_REASON_GROUP_LABEL, RETURN_REASON_GROUP_OF, RETURN_REASON_LABEL, RETURN_REASONS, type ReturnReason } from "@/lib/constants/return-reason";
import { careViewOf, slaOf, teamWorkEnded } from "@/lib/care/view";
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
  careRoundBandOf,
  careStateFor,
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
  followUpPresetAt,
  type CareStatus,
  type CareView,
  type CarrierActionKey,
  CARE_NOTE_PRESETS_MAX,
  type CareNotePreset,
} from "@/lib/constants/care";
import { CARE_ACTION_KINDS, CARE_ACTION_LABEL, type CareActionKind } from "@/lib/constants/delivery-tower";
import {
  CARE_ROUND_BANDS,
  CARE_ROUND_BAND_HINT,
  CARE_ROUND_MERGE_MINUTES,
  CARE_TIMELINE_INLINE_MAX,
  CARE_TIMELINE_KIND_LABEL,
  CARE_TIMELINE_KIND_TONE,
  careRoundAppend,
  careRoundBand,
  type CareRoundBand,
  type CareTimelineEntry,
  type CareTimelineKind,
} from "@/lib/constants/care-rounds";
import { formatDateTime, formatNumber, formatTimeAgo, formatVND, todayVN, vnShortStamp } from "@/lib/format";
import { ManualRequestVerdict } from "./manual-request-verdict";
import type { CareCase, CareState, CareWorkbench, CarrierRequestView } from "@/lib/queries/care-workbench";
import { customerNameForDisplay } from "@/lib/constants/customer-name";
import { VtpTrackingLink } from "@/components/vtp-tracking-link";
import { getViettelPostTrackingUrl } from "@/lib/constants/viettelpost";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { StatusSelect } from "@/components/status-select";
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
  /** Mẫu note gắn với TỪNG kết quả xử lý (`care.resolutionNotes`). */
  resolutionPresets: Record<CareDecision, string[]>;
  canManage: boolean;
  /**
   * KHOÁ TÀI KHOẢN của người đang mở màn hình. Chỉ dùng để cộng lượt vừa ghi bằng đúng luật gộp
   * của máy chủ (`careRoundAppend`) — máy chủ vẫn là nơi quyết định ai đã làm gì (luật 34), đây
   * chỉ là ảnh chụp để trình duyệt khỏi nói sai trong vài giây trước lượt dựng lại.
   */
  meId: string;
};

const CARRIER_MENU: CarrierActionKey[] = ["redeliver", "approve-return", "resend", "cancel"];

/**
 * CÒN BAO LÂU TỚI HẸN, hoặc ĐÃ QUÁ HẸN BAO LÂU. Hàm THUẦN: nhận `now` từ ngoài nên mọi dòng trong
 * cùng một lượt vẽ được đo ở CÙNG một thời điểm — đọc `Date.now()` bên trong vòng lặp thì hai dòng
 * cạnh nhau tính ở hai mốc, và tổng trên chip lệch khỏi bảng đúng lúc một ca vừa chạm hạn.
 */
function hanHen(at: Date, now: Date): string {
  const phut = Math.round((at.getTime() - now.getTime()) / 60_000);
  const doDai = (p: number) => (p < 60 ? `${p} phút` : p < 2880 ? `${Math.round(p / 60)} giờ` : `${Math.round(p / 1440)} ngày`);
  if (phut <= 0) return `quá hẹn ${doDai(Math.max(1, -phut))}`;
  return `còn ${doDai(phut)}`;
}

function gio(h: number | null) {
  if (h === null) return "chưa có tin";
  if (h < 1) return "<1 giờ";
  if (h < 48) return `${Math.round(h)} giờ`;
  return `${Math.round(h / 24)} ngày`;
}

/**
 * ═══════════ VÁ LỊCH SỬ NGAY SAU MỘT LƯỢT VỪA GHI ═══════════
 *
 * Bàn care không tải lại trang sau mỗi thao tác. Thiếu hàm này thì người vừa ghi note xong nhìn
 * thấy note của mình hiện ra NGAY BÊN TRÊN dòng chữ "Chưa xử lý lần nào" — một dòng tự mâu thuẫn
 * với chính nó, và người dùng sẽ thôi tin cả hai nửa.
 *
 * Phép cộng lượt đi qua `careRoundAppend`, tức ĐÚNG luật gộp mà máy chủ dùng: không có bản sao thứ
 * hai của cửa sổ 5 phút ở phía trình duyệt. Lượt dựng lại tiếp theo của máy chủ ghi đè bằng số đo
 * thật — nếu hai bên lệch nhau thì lệch ở đúng một chỗ, và chỗ đó có kiểm thử.
 *
 * `undefined` vào thì `undefined` ra: CHƯA ĐỌC ĐƯỢC không được biến thành "1 lượt" chỉ vì vừa có
 * một thao tác (luật 42).
 */
function themLuot(truoc: CareCase["history"], moi: { at: Date; actorId: string; kind: CareTimelineKind; label: string; note: string }): CareCase["history"] {
  if (!truoc) return truoc;
  const cong = careRoundAppend(truoc, { at: moi.at, actorId: moi.actorId });
  const dong: CareTimelineEntry = { at: moi.at, kind: moi.kind, label: moi.label, note: moi.note, actor: "bạn", bySystem: false };
  return {
    ...truoc,
    rounds: cong.rounds,
    // Lượt ĐẦU chỉ được ghi một lần: nó là mốc mà hạn phản hồi đầu đo tới, không phải mốc mới nhất.
    firstRoundAt: truoc.firstRoundAt ?? cong.lastRoundAt,
    lastRoundAt: cong.lastRoundAt,
    lastRoundActorId: cong.lastRoundActorId,
    // Vừa làm xong thì không còn "ĐVVC có tin mới sau lượt xử lý cuối": lượt cuối vừa là bây giờ.
    carrierNewsAfterLastRound: false,
    /*
      SỐ LẦN CHẠM ĐI THEO ĐÚNG QUYẾT ĐỊNH GỘP CỦA SỐ LƯỢT.

      Mọi lượt xử lý cũng là một lần chạm, nên ghi nhận này gộp vào lượt trước thì nó cũng gộp vào
      lần chạm trước. Cộng thẳng `+ 1` là dựng lại đúng phép ĐẾM ĐÔI mà máy chủ vừa phải bỏ: một
      lần ghi note để lại hai dòng ở hai sổ (`care_actions` + sự kiện `NOTE`). Con số này không
      hiện trên dòng; lượt dựng lại của máy chủ chốt nó bằng số đo thật.
    */
    touches: cong.rounds === truoc.rounds ? truoc.touches : truoc.touches + 1,
    timeline: [dong, ...truoc.timeline].slice(0, CARE_TIMELINE_INLINE_MAX),
    timelineTruncated: truoc.timelineTruncated || truoc.timeline.length + 1 > CARE_TIMELINE_INLINE_MAX,
  };
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

export function CareWorkbenchView({ initial, view, staff, presets: initialPresets, resolutionPresets, canManage, meId }: Props) {
  const [cases, setCases] = useState<CareCase[]>(() => initial.cases.map((c) => ({ ...c, queueSince: new Date(c.queueSince) })));
  /*
    ═══ MÁY CHỦ NÓI LẠI THÌ DANH SÁCH NGHE THEO ═══

    `useState(() => …)` chỉ chạy MỘT LẦN. Trước bản này, panel chi tiết ghi xong rồi gọi
    `router.refresh()`: máy chủ dựng lại hàng đợi và gửi xuống `initial` mới, nhưng danh sách vẫn
    giữ nguyên ảnh chụp lúc mở trang — người dùng đổi kết quả trong panel, đóng panel, và thấy dòng
    ngoài bảng vẫn y như cũ cho tới khi bấm F5 (CASE 2 của đề bài).

    `initial` chỉ đổi danh tính khi MÁY CHỦ gửi một lượt dựng mới (điều hướng · `router.refresh()` ·
    SSE realtime). Thao tác ở ngay trên bảng KHÔNG đi qua đây — chúng vá dòng bằng `patch()` với
    đúng `CareState` máy chủ trả về, nên hiệu ứng này không nuốt mất chúng.
  */
  useEffect(() => {
    setCases(initial.cases.map((c) => ({ ...c, queueSince: new Date(c.queueSince) })));
  }, [initial]);

  /*
    ═══ PANEL ĐỔI ⇒ DÒNG NGOÀI BẢNG ĐỔI NGAY, KHÔNG ĐỢI MỘT LƯỢT DỰNG LẠI ═══

    Panel phát `CareState` mà máy chủ vừa trả về; ở đây vá đúng dòng đó bằng CÙNG hàm `patch` mà
    thao tác ngay trên bảng dùng. Nhờ vậy hai đường (bấm ngoài bảng · bấm trong panel) hội tụ về
    một chỗ, và không có kịch bản "panel đã đổi mà row chưa đổi".
  */
  useEffect(() => onCareUpdated(({ shipmentId, care }) => patch(shipmentId, care)));
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
      ketqua: parseAsString.withDefault(""),
      hen: parseAsString.withDefault(""),
      luot: parseAsString.withDefault(""),
      /*
        BỐN MỐC THỜI GIAN. Tên tham số đọc thẳng từ sổ đăng ký (`CARE_DATES[k].param`) chứ không gõ
        lại: gõ lại là mở đường cho đường dẫn và bộ lọc nói hai tên khác nhau, và một đường dẫn gửi
        cho đồng nghiệp sẽ mở ra một danh sách khác.
      */
      [CARE_DATES.orderCreated.param]: parseAsString.withDefault(""),
      [CARE_DATES.carrierStageSince.param]: parseAsString.withDefault(""),
      [CARE_DATES.carrierLastEvent.param]: parseAsString.withDefault(""),
      [CARE_DATES.erpLastTouch.param]: parseAsString.withDefault(""),
    },
    { history: "replace", clearOnDefault: true },
  );
  const filters: CareFilters = useMemo(
    () => ({
      view,
      q: f.q,
      owner: f.nguoi,
      reason: f.lydo,
      substate: f.dvvc,
      sla: f.han as CareSlaBucket | "",
      cod: f.tien as CareCodBand | "",
      attempts: f.hut as CareAttemptBand | "",
      sku: f.hang,
      resolution: f.ketqua as ResolutionFilterKey | "",
      followUp: f.hen as FollowUpFilterKey | "",
      rounds: f.luot as CareRoundBand | "",
      orderCreated: f[CARE_DATES.orderCreated.param],
      carrierStageSince: f[CARE_DATES.carrierStageSince.param],
      carrierLastEvent: f[CARE_DATES.carrierLastEvent.param],
      erpLastTouch: f[CARE_DATES.erpLastTouch.param],
    }),
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
        /*
          KIỆN ĐÃ RỜI ĐIỀU KIỆN CARE KHÔNG QUAY LẠI TAB "CẦN CARE" VÌ MỘT LẦN ĐỔI TRẠNG THÁI.

          `careViewOf` chỉ đọc trạng thái của ĐỢT care. Dòng đã hết điều kiện (`inCareCondition =
          false`) mà mở lại / đổi sang "Đang xử lý" sẽ được nó xếp về "care" — đúng luật của nó,
          sai với sự thật: điều kiện sinh ra việc đã hết. Máy chủ chốt điều đó, trình duyệt nghe
          theo, nếu không thì hai bên nói hai điều khác nhau ngay sau cú bấm đầu tiên.
        */
        /*
          GÓC NHÌN VÀ HẠN XỬ LÝ ĐỌC CHIỀU CARE **KÈM LỊCH SỬ VỪA VÁ** — qua đúng `careStateFor` mà
          máy chủ dùng. Truyền `revived` trơn thì `teamResponded` lùi về cột `first_response_at`
          (cột được ghi ngay lúc giao việc), nên ngay sau một cú bấm, trình duyệt sẽ kết luận "đã
          phản hồi" cho một ca mà máy chủ vừa nói là chưa — hai bên nói hai điều khác nhau đúng
          lúc người dùng đang nhìn.
        */
        const sau = { ...c, ...extra, care: revived };
        const choHan = careStateFor(sau);
        const { view: v, reopened } = c.inCareCondition ? careViewOf(choHan, c.queueSince) : { view: "done" as const, reopened: false };
        return { ...sau, view: v, reopened, sla: slaOf(c.queueSince, choHan, new Date(), initial.slaHours) };
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

  /*
    ĐẾM THEO KẾT QUẢ và THEO CÁI HẸN — cùng `careFacet`, cùng vị từ, nên con số trên chip luôn bằng
    số dòng sẽ hiện ra khi bấm nó. Kiện mang một quyết định NGOÀI ba nút (vd "Đổi") không rơi vào
    rổ nào: nó đã được quyết, nên nó không phải "chưa quyết định", và ép nó vào một rổ là đếm sai.
  */
  const resolutionFacet = useMemo(() => {
    const m = new Map(careFacet(cases, filters, "resolution", (c) => c.care.lastDecision?.decision ?? "none", now, hours));
    return RESOLUTION_FILTER_KEYS.map((k) => [k, m.get(k) ?? 0] as const).filter(([, n]) => n > 0);
  }, [cases, filters, now, hours]);
  const followUpFacet = useMemo(() => {
    const m = new Map(careFacet(cases, filters, "followUp", (c) => followUpBucket(c.care.followUpAt, now), now, hours));
    return FOLLOW_UP_FILTERS.map((k) => [k, m.get(k) ?? 0] as const).filter(([, n]) => n > 0);
  }, [cases, filters, now, hours]);
  /*
    ĐẾM THEO SỐ LƯỢT ĐÃ XỬ LÝ — cùng `careFacet`, cùng vị từ, nên con số trên chip bằng đúng số
    dòng hiện ra khi bấm. Rổ "Chưa xử lý lần nào" GIỮ NGUYÊN kể cả khi bằng 0, khác mọi chip khác:
    một hàng đợi không còn kiện nào chưa ai đụng là một TIN TỐT, và tin tốt biến mất khỏi màn hình
    thì người trực không có cách nào biết mình đã dọn sạch hay bộ lọc đang hỏng.
  */
  const roundFacet = useMemo(() => {
    const m = new Map(careFacet(cases, filters, "rounds", (c) => careRoundBandOf(c), now, hours));
    return CARE_ROUND_BANDS.map((b) => [b, m.get(b.key) ?? 0] as const).filter(([b, n]) => n > 0 || b.key === "0");
  }, [cases, filters, now, hours]);

  /* Đếm và gỡ bộ lọc: người lọc bốn chiều rồi thấy bảng rỗng phải có một nút để ra, không phải sửa
     đường dẫn bằng tay. `view` không nằm trong đây — nó là cái TAB, không phải bộ lọc. */
  const daLoc = Object.values(f).filter((v) => v !== "").length;
  const xoaLoc = () => setF(Object.fromEntries(Object.keys(f).map((k) => [k, ""])));

  /*
    ═══ BAO NHIÊU KIỆN RƠI KHỎI BỘ LỌC VÌ CHƯA CÓ MỐC ═══

    Lọc theo một khoảng ngày thì kiện CHƯA CÓ mốc ấy không lọt — đúng, nhưng nó không được im lặng
    biến mất (cùng luật với `carrier_handoff_at`, mục 41). Đếm ở đây bằng CHÍNH vị từ của bảng với
    chiều đó bị tắt, nên con số luôn bằng số kiện sẽ hiện thêm nếu bấm "chưa có mốc".
  */
  const thieuMoc = useMemo(() => {
    const m = {} as Record<CareDateKey, number>;
    for (const k of CARE_DATE_KEYS) {
      const loc = parseCareDateFilter(filters[k]);
      m[k] = loc?.kind === "RANGE" ? cases.filter((c) => !c.dates?.[k] && matchesCareFilters(c, { ...filters, [k]: "" }, now, hours)).length : 0;
    }
    return m;
  }, [cases, filters, now, hours]);

  /** Bốn giá trị lọc ngày, gom lại để truyền xuống popover và dựng chip. */
  const locNgay = useMemo(() => Object.fromEntries(CARE_DATE_KEYS.map((k) => [k, filters[k]])) as Record<CareDateKey, string>, [filters]);

  /*
    MỐC ĐANG LỌC PHẢI HIỆN RA TRÊN TỪNG DÒNG. Một bộ lọc mà người dùng không kiểm lại được là một
    bộ lọc họ sẽ thôi tin sau lần đầu nghi ngờ — và ở bàn này, nghi ngờ đúng thường xuyên hơn.
    Chỉ hiện mốc ĐANG lọc, nên bảng không dài thêm một dòng nào khi chưa ai lọc.
  */
  const ngayHien = useMemo(() => CARE_DATE_KEYS.filter((k) => locNgay[k]), [locNgay]);

  /** Bộ lọc ngày người dùng gõ mà máy không đọc được — phải NÓI RA, không được lặng lẽ bỏ qua. */
  const ngayHong = CARE_DATE_KEYS.map((k) => [k, parseCareDateFilter(filters[k])] as const).filter((x): x is [CareDateKey, { kind: "INVALID"; raw: string; problem: keyof typeof CARE_DATE_PROBLEM_LABEL }] => x[1]?.kind === "INVALID");

  const queue = visible.map((c) => ({ shipmentId: c.shipmentId }));
  const moneyAtRisk = visible.reduce((a, c) => a + c.codAmount, 0);
  const overdue = visible.filter((c) => c.sla.firstResponseBreached || c.sla.resolveBreached).length;
  /*
    ═══ CÙNG PHÉP CỘNG, HAI CÂU KHÁC NHAU — VÀ TAB QUYẾT ĐỊNH CÂU NÀO ═══

    `moneyAtRisk` và `overdue` cộng trên ĐÚNG tập dòng đang hiện. Ở tab "Cần care" đó là tiền đang
    treo và số ca đang vỡ hạn — hai con số để hành động. Ở tab "Đã xử lý" thì chính phép cộng ấy trả
    lời một câu khác hẳn: tiền của những ca ĐÃ ĐÓNG, và số ca TỪNG vỡ hạn phản hồi (`resolveBreached`
    luôn tắt khi ca đã đóng, nhưng `firstResponseBreached` thì ở lại mãi nếu chưa ai từng chạm vào).

    Đo trên production 19/09/2026: tab "Đã xử lý" in "COD treo 152,1 tr · 147 vỡ SLA" trên 272 ca đã
    đóng — đọc thẳng ra là shop đang treo 152 triệu và có 147 việc quá hạn phải làm ngay, trong khi
    con số thật của hàng đợi đang chạy nhỏ hơn hẳn. Không phải phép cộng sai: NHÃN sai. Nên nhãn đi
    theo tab, và tab lịch sử nói rõ nó đang nhìn về quá khứ.
  */
  const dangChay = view === "care" || view === "waiting" || view === "escalated";
  const nhanTien = dangChay ? "COD treo" : "COD của các ca này";
  const nhanHan = dangChay ? "vỡ SLA" : "từng vỡ hạn phản hồi";

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
        <span className="text-muted-foreground">
          · {nhanTien} {formatVND(moneyAtRisk, { compact: true })}
        </span>
        {overdue ? (
          <span className={cn("font-semibold", dangChay ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
            · {formatNumber(overdue)} {nhanHan}
          </span>
        ) : null}
        <span className="text-muted-foreground">· chưa ai nhận {formatNumber(visible.filter((c) => !c.care.owner).length)}</span>
        <InfoHint>
          {/* Số giờ đọc từ ngưỡng ĐANG HIỆU LỰC máy chủ gửi xuống — chủ shop đổi hạn ở cấu hình thì câu này đổi theo, không phải sửa mã. */}
          SLA: phản hồi đầu trong {formatNumber(hours.firstResponseHours)} giờ, đóng hoặc escalate trong {formatNumber(hours.resolveHours)} giờ, tính từ lúc kiện VÀO điều kiện cần care (lần giao hụt gần nhất / tin cuối). Kiện rời danh sách khi điều kiện hết (đã giao, đã hoàn…) — lịch sử giữ nguyên.
          {dangChay ? null : (
            <>
              <br />
              <br />
              <b>Tab này là LỊCH SỬ.</b> Hai con số trên cộng trên các ca ĐÃ ĐÓNG: tiền là COD của chính các ca đó (không phải tiền đang treo),
              và “từng vỡ hạn phản hồi” đếm ca mà tới lúc đóng vẫn chưa ai chạm vào trong hạn — nó không sinh ra việc phải làm hôm nay.
            </>
          )}
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
          <BoLocNgay values={locNgay} missing={thieuMoc} onChange={(k, v) => setF({ [CARE_DATES[k].param]: v })} />
        </span>
      </div>

      {/*
        ═══ BỘ LỌC NGÀY ĐANG BẬT PHẢI ĐỌC ĐƯỢC MÀ KHÔNG CẦN MỞ POPOVER ═══

        Một bộ lọc giấu trong popover là một bộ lọc người ta quên đã bật, rồi đọc con số ở dải tóm
        tắt như thể nó nói về cả hàng đợi. Chip ở đây nói rõ đang lọc mốc nào, và bấm vào là gỡ.
      */}
      {CARE_DATE_KEYS.some((k) => locNgay[k]) || ngayHong.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Mốc</span>
          {CARE_DATE_KEYS.filter((k) => locNgay[k]).map((k) => {
            const d = parseCareDateFilter(locNgay[k]);
            const chu =
              d?.kind === "UNKNOWN_ONLY"
                ? CARE_DATES[k].unknownLabel
                : d?.kind === "RANGE"
                  ? `${d.fromKey ? vnNgay(d.fromKey) : "…"} → ${d.toKey ? vnNgay(d.toKey) : "…"}`
                  : "không đọc được";
            return (
              <button
                key={k}
                type="button"
                onClick={() => setF({ [CARE_DATES[k].param]: "" })}
                title={`${CARE_DATES[k].question}

Nguồn: ${CARE_DATES[k].source}

Bấm để bỏ bộ lọc này.`}
                className="inline-flex items-center gap-1 rounded-full border border-primary bg-accent px-2.5 py-0.5 text-[11.5px] font-medium hover:bg-accent/70"
              >
                {CARE_DATES[k].short}: {chu}
                <Trash2 className="size-3 opacity-60" />
              </button>
            );
          })}
        </div>
      ) : null}

      {/* CHUỖI LỌC HỎNG: nói ra, KHÔNG âm thầm bỏ qua — bảng ngắn đi mà không ai biết vì sao là tệ hơn. */}
      {ngayHong.map(([k, d]) => (
        <p key={k} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <b>{CARE_DATES[k].label}</b>: {CARE_DATE_PROBLEM_LABEL[d.problem]} (“{d.raw}”). Danh sách dưới đây <b>chưa</b> lọc theo mốc này.
        </p>
      ))}

      {/*
        KIỆN RƠI KHỎI BỘ LỌC VÌ CHƯA CÓ MỐC — in ra cạnh bảng, kèm lối vào xem chúng.
        Chưa biết không được biến mất im lặng (mục 41, mục 42).
      */}
      {CARE_DATE_KEYS.filter((k) => thieuMoc[k] > 0).map((k) => (
        <p key={k} className="text-[11.5px] text-muted-foreground">
          {formatNumber(thieuMoc[k])} kiện khác nằm ngoài bộ lọc <b>{CARE_DATES[k].label}</b> vì {CARE_DATES[k].unknownLabel.toLowerCase()} —{" "}
          <button type="button" onClick={() => setF({ [CARE_DATES[k].param]: CARE_DATE_UNKNOWN })} className="underline underline-offset-2 hover:text-foreground">
            xem riêng nhóm này
          </button>
          .
        </p>
      ))}

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

      {/*
        ═══ HÀNG THỨ TƯ: ĐỘI ĐÃ QUYẾT GÌ, VÀ BAO GIỜ PHẢI QUAY LẠI ═══

        Ba hàng trên nói về KIỆN (vì sao cần care · ĐVVC đang làm gì · gấp tới đâu). Hàng này nói về
        ĐỘI: đã quyết gì cho kiện, và cái hẹn rơi vào đâu. "Chưa quyết định" và "Quá hẹn" là hai rổ
        người trực mở đầu mỗi buổi, nên chúng phải bấm được, không phải đọc từng dòng mới thấy.
      */}
      {resolutionFacet.length > 1 || followUpFacet.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {resolutionFacet.length > 1 ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Kết quả</span>
              {resolutionFacet.map(([k, n]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setF({ ketqua: f.ketqua === k ? "" : k })}
                  title={k === "none" ? "Chưa ai bấm Đã hoàn / Phát tiếp / Xử lý sau cho kiện này." : RESOLUTION_HINT[k as CareDecision]}
                  className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-accent", f.ketqua === k && "border-primary bg-accent font-semibold")}
                >
                  {RESOLUTION_FILTER_LABEL[k as ResolutionFilterKey]} <span className="numeric text-muted-foreground">{n}</span>
                </button>
              ))}
            </span>
          ) : null}
          {followUpFacet.length > 1 ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Hẹn</span>
              {followUpFacet.map(([k, n]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setF({ hen: f.hen === k ? "" : k })}
                  title={FOLLOW_UP_FILTER_HINT[k]}
                  className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-accent", k === "overdue" && "text-rose-700 dark:text-rose-300", f.hen === k && "border-primary bg-accent font-semibold")}
                >
                  {FOLLOW_UP_FILTER_LABEL[k]} <span className="numeric text-muted-foreground">{n}</span>
                </button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {/*
        ═══ HÀNG THỨ NĂM: ĐÃ XỬ LÝ MẤY LƯỢT RỒI ═══

        Hàng "Kết quả" ở trên nói đội đã QUYẾT gì — một trạng thái, ghi đè lẫn nhau. Hàng này nói
        đội đã LÀM BAO NHIÊU LẦN — một phép đếm, chỉ tăng. Hai chiều rời nhau, và chỗ chúng rời
        nhau xa nhất chính là chỗ đáng nhìn: "chưa quyết định" gộp một kiện chưa ai mở ra với một
        kiện đã gọi khách hai lượt mà chưa chốt được, và sáng hôm sau đó là hai việc khác hẳn.

        "Chưa xử lý lần nào" luôn hiện kể cả khi bằng 0 — xem `roundFacet`.
      */}
      {roundFacet.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" title={`Một LƯỢT = một lần ghi việc đã làm (gọi / nhắn / sửa) hoặc một lần bấm kết quả. Hai ghi nhận của cùng một người trong ${CARE_ROUND_MERGE_MINUTES} phút tính là MỘT lượt. Đổi trạng thái và giao việc KHÔNG tính.`}>
            Đã xử lý
          </span>
          {roundFacet.map(([b, n]) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setF({ luot: f.luot === b.key ? "" : b.key })}
              title={CARE_ROUND_BAND_HINT[b.key]}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11.5px] hover:bg-accent",
                // Chỉ rổ "chưa ai đụng" mang màu cảnh báo, và chỉ khi nó còn kiện: đó là rổ duy
                // nhất nói "có việc chưa ai nhìn tới". Tô màu cả năm rổ thì không rổ nào nổi lên.
                b.key === "0" && n > 0 && "text-rose-700 dark:text-rose-300",
                f.luot === b.key && "border-primary bg-accent font-semibold",
              )}
            >
              {b.label} <span className="numeric opacity-70">{n}</span>
            </button>
          ))}
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
        <>
          <TableToolsFor tableId="shipments-workbench" />
          <div className={cn(TABLE_SCROLL, "rounded-xl border")}>
            <table id="shipments-workbench" className="w-full min-w-[1180px] text-[12px]">
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
                  {/*
                    HAI Ô, HAI CÂU HỎI — TIÊU ĐỀ PHẢI NÓI RA CẢ HAI.

                    “Care · kết quả xử lý” gộp hai trường khác hẳn nhau vào một cụm chữ: KẾT QUẢ CASE
                    (đội quyết gì: Đã hoàn · Phát tiếp · Xử lý sau) và TRẠNG THÁI CARE (đội đang ở đâu
                    trong quy trình: Chưa xử lý · Đang xử lý · Chờ khách…). Người đọc lần đầu tưởng
                    chúng là một, rồi đọc “Chờ phát lại” ở ô trạng thái và tưởng Viettel Post vừa nói
                    vậy.
                  */}
                  <th className="px-2 py-2 font-semibold" title="Chiều nội bộ — đội đã quyết gì (KẾT QUẢ CASE) và đang ở đâu (TRẠNG THÁI CARE). KHÔNG suy ra từ trạng thái VTP: “Đã hoàn” ở đây là quyết định của shop, không phải chứng từ hoàn của Viettel Post.">
                    Kết quả case
                    <span className="ml-1 font-normal normal-case text-muted-foreground/70">+ trạng thái care</span>
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
                    now={now}
                    ngayHien={ngayHien}
                    staff={staff}
                    presets={presets}
                    resolutionPresets={resolutionPresets}
                    onPresetsChange={setPresets}
                    canManage={canManage}
                    meId={meId}
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
        </>
      )}
      <p className="text-[11px] text-muted-foreground">
        {(["care", "waiting", "escalated", "done"] as const).map((v) => `${CARE_VIEW_LABEL[v]} ${counts[v]}`).join(" · ")}
      </p>
    </div>
  );
}

/** `2026-09-01` → `01/09/2026`. Chỉ đổi cách đọc, không đổi múi giờ: chuỗi này vốn đã là ngày VN. */
function vnNgay(key: string): string {
  const [y, m, d] = key.split("-");
  return y && m && d ? `${d}/${m}/${y}` : key;
}

/**
 * ═══════════ BỐN MỐC THỜI GIAN, BỐN Ô LỌC RIÊNG ═══════════
 *
 * Nằm trong popover vì bốn khoảng ngày là tám ô nhập — bày hết ra thanh lọc thì bảng bị đẩy xuống
 * dưới màn hình, đúng thứ bàn làm việc này không chịu được. Bù lại, mốc nào ĐANG BẬT đều có một
 * chip ngoài thanh lọc, nên không ai lọc nhầm mà không biết.
 *
 * KHÔNG gộp "đổi trạng thái" với "tin VTP cuối" thành một ô cho gọn: đó là hai đồng hồ, và một
 * kiện có thể vừa có tin sáng nay vừa đứng nguyên một chỗ mười một ngày (AGENTS.md mục 54).
 */
function BoLocNgay({ values, missing, onChange }: { values: Record<CareDateKey, string>; missing: Record<CareDateKey, number>; onChange: (k: CareDateKey, v: string) => void }) {
  const [open, setOpen] = useState(false);
  const dangBat = CARE_DATE_KEYS.filter((k) => values[k]).length;
  /*
    MỘT "HÔM NAY" CHO CẢ LƯỢT VẼ. Gọi `todayVN()` bên trong từng chip thì mười hai lời gọi có thể
    rơi hai bên nửa đêm, và hai chip cạnh nhau sẽ dựng hai khoảng lệch một ngày. Tính một lần ở đây
    là đủ: popover mở trong vài giây, còn lượt vẽ sau đã lấy lại ngày mới.
  */
  const homNay = todayVN();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-7 gap-1 px-2 text-xs", dangBat && "border-primary bg-accent font-semibold")}>
          <CalendarRange className="size-3.5" /> Mốc thời gian
          {dangBat ? <span className="numeric rounded bg-muted px-1 text-[10.5px]">{dangBat}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-[440px] overflow-y-auto p-0 text-xs">
        <div className="sticky top-0 z-10 border-b bg-popover px-3 py-2.5">
          <p className="font-semibold">Lọc theo mốc thời gian</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Bốn mốc độc lập, không suy ra lẫn nhau. Ngày theo giờ Việt Nam, cả hai đầu đều <b>bao gồm</b>.
          </p>
        </div>
        <div className="divide-y">
          {CARE_DATE_KEYS.map((k) => {
            const spec = CARE_DATES[k];
            const d = parseCareDateFilter(values[k]);
            const chuaCo = d?.kind === "UNKNOWN_ONLY";
            const fromKey = d?.kind === "RANGE" ? d.fromKey : "";
            const toKey = d?.kind === "RANGE" ? d.toKey : "";
            const nacDangBat = careDatePresetOf(values[k], homNay);
            const moTa = describeCareDateFilter(d);
            return (
              <div key={k} className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-center gap-1">
                  <span className="font-medium">{spec.label}</span>
                  <InfoHint>
                    {spec.question}
                    <br />
                    <br />
                    <b>Nguồn:</b> {spec.source}
                    <br />
                    <br />
                    <b>Chưa có mốc:</b> {spec.unknownLabel}. {spec.unknownHint}
                  </InfoHint>
                  {values[k] ? (
                    <button type="button" onClick={() => onChange(k, "")} className="ml-auto text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
                      Bỏ lọc
                    </button>
                  ) : null}
                </div>
                {/* CÂU PHÂN BIỆT KHÔNG NẰM SAU MỘT CÚ BẤM: ai không mở ⓘ vẫn phải chọn đúng mốc. */}
                <p className="text-[10.5px] leading-snug text-muted-foreground">{spec.hint}</p>
                <div className="flex flex-wrap items-center gap-1">
                  {CARE_DATE_PRESETS.map((nac) => (
                    <button
                      key={nac.key}
                      type="button"
                      onClick={() => onChange(k, nacDangBat === nac.key ? "" : careDatePresetValue(nac.key, homNay))}
                      className={cn("rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent", nacDangBat === nac.key && "border-primary bg-accent font-semibold")}
                    >
                      {nac.label}
                    </button>
                  ))}
                  {/*
                    NHÓM CHƯA CÓ MỐC LÀ MỘT RỔ RIÊNG, BẤM ĐƯỢC. Nếu nó chỉ là "thứ bị khoảng ngày
                    loại ra" thì nó không tồn tại trên màn hình — mà đó thường là nhóm phải đi tra
                    đầu tiên (đo production 23/09/2026: 396/445 kiện chưa ai động vào).
                  */}
                  <button
                    type="button"
                    onClick={() => onChange(k, chuaCo ? "" : CARE_DATE_UNKNOWN)}
                    title={`${spec.unknownLabel}. ${spec.unknownHint}`}
                    className={cn("rounded-full border border-dashed px-2 py-0.5 text-[11px] hover:bg-accent", chuaCo && "border-solid border-primary bg-accent font-semibold")}
                  >
                    Chưa có mốc
                  </button>
                </div>
                {/* Ô ngày tuỳ chọn vẫn ở lại: nấc nhanh trả lời câu hay gặp, không thay câu hiếm. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                    Từ
                    <input
                      type="date"
                      value={fromKey}
                      max={toKey || undefined}
                      disabled={chuaCo}
                      onChange={(e) => onChange(k, careDateValue(e.target.value, toKey))}
                      className="h-7 rounded-md border bg-background px-1.5 text-xs text-foreground disabled:opacity-40"
                      aria-label={`${spec.label}: từ ngày`}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                    đến
                    <input
                      type="date"
                      value={toKey}
                      min={fromKey || undefined}
                      disabled={chuaCo}
                      onChange={(e) => onChange(k, careDateValue(fromKey, e.target.value))}
                      className="h-7 rounded-md border bg-background px-1.5 text-xs text-foreground disabled:opacity-40"
                      aria-label={`${spec.label}: đến ngày`}
                    />
                  </label>
                </div>
                {/*
                  IN LẠI BẰNG ĐỊNH DẠNG VIỆT NAM. Ô `<input type="date">` hiện theo định dạng của
                  MÁY (`mm/dd/yyyy` trên máy locale Mỹ), nên người dùng chọn "09/01" mà không có
                  cách nào biết mình vừa chọn mùng 1 tháng 9 hay mùng 9 tháng 1. Dòng này để sai là
                  thấy ngay, thay vì thấy qua một bảng kết quả khó hiểu.
                */}
                {moTa ? <p className="text-[10.5px] font-medium">{moTa}</p> : null}
                {chuaCo ? <p className="text-[10.5px] text-muted-foreground">Chỉ hiện kiện {spec.unknownLabel.toLowerCase()}.</p> : null}
                {missing[k] > 0 ? <p className="text-[10.5px] text-muted-foreground">{formatNumber(missing[k])} kiện chưa có mốc này nên không lọt qua khoảng ngày trên.</p> : null}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CaseRow({ c, now, ngayHien, staff, presets, resolutionPresets, onPresetsChange, canManage, meId, checked, onCheck, onPatch }: { c: CareCase; now: Date; ngayHien: CareDateKey[]; staff: { id: string; name: string }[]; presets: CareNotePreset[]; resolutionPresets: Record<CareDecision, string[]>; onPresetsChange: (p: CareNotePreset[]) => void; canManage: boolean; meId: string; checked: boolean; onCheck: (v: boolean) => void; onPatch: (care: CareState, extra?: Partial<CareCase>) => void }) {
  const [pending, start] = useTransition();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<CareActionKind>("CALLED_REACHED");
  /*
    NHẬT KÝ MỞ / ĐÓNG THEO TỪNG DÒNG, GIỮ TRONG DÒNG.

    Không đưa lên `CareWorkbenchView`: một `Set` các dòng đang mở ở cấp trên nghĩa là mở một dòng
    vẽ lại cả bảng. Ở đây mỗi `CaseRow` tự giữ cờ của mình, nên mở một dòng chỉ vẽ lại dòng đó.
  */
  const [historyOpen, setHistoryOpen] = useState(false);
  const lichSu = c.history;
  const soLuot = lichSu?.rounds ?? 0;
  const [vtpOpen, setVtpOpen] = useState(false);
  const [vtpNote, setVtpNote] = useState("");
  const terminal = c.care.status === "RESOLVED" || c.care.status === "CANCELLED";

  const changeStatus = (status: CareStatus) =>
    start(async () => {
      // Trạng thái CHỜ bắt buộc có giờ xem lại: giữ giờ đang có CHỈ KHI nó còn ở phía trước, không
      // thì cấp giờ mới. Thừa kế một mốc đã trôi qua là đẩy ca về "Cần care" ngay giây sau khi vừa
      // chuyển nó sang "đang chờ", kèm nhãn "quá hẹn" — người trực học cách bỏ qua chính cảnh báo đó.
      const henCu = c.care.followUpAt && c.care.followUpAt.getTime() > Date.now() ? c.care.followUpAt : null;
      const r = await setCareStatus({ shipmentIds: [c.shipmentId], status, followUpAt: CARE_WAITING_STATUSES.includes(status) ? (henCu ?? defaultFollowUpAt()) : undefined });
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
      const at = new Date();
      onPatch(r.data, {
        lastCareAction: { label: CARE_ACTION_LABEL[kind], at, byHuman: true },
        history: themLuot(lichSu, { at, actorId: meId, kind: "ACTION", label: CARE_ACTION_LABEL[kind], note }),
      });
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

  /*
    ═══ BA NÚT KẾT QUẢ ĐI ĐÚNG MỘT ĐƯỜNG GHI ═══

    Không có Server Action thứ hai cho "kết quả xử lý": ba nút ánh xạ về ba `BusinessAction` đã có
    và gọi `recordBusinessAction` — cùng hàm mà menu đầy đủ trong popover "Xử lý" gọi. Nhờ vậy bấm
    ở ngoài bảng và bấm trong panel ghi RA CÙNG MỘT DÒNG SỔ, và không có đường nào lách qua kiểm tra
    điều kiện ĐVVC hay qua nhật ký.

    LẠC QUAN CÓ GIỚI HẠN: dòng chỉ được vá bằng `CareState` MÁY CHỦ TRẢ VỀ (mục 18 của đề bài), nên
    lỗi là dòng tự quay lại đúng trạng thái cũ — không cần bộ nhớ hoàn tác riêng.
  */
  const doResolution = (a: CareDecision, extra: ResolutionExtra) =>
    start(async () => {
      const r = await recordCareDecision({ shipmentId: c.shipmentId, decision: a, note: extra.note, reasonCode: extra.reasonCode, followUpAt: extra.followUpAt });
      if ("error" in r) {
        toast.error(r.error, { duration: 9000 });
        return;
      }
      onPatch(r.data, { history: themLuot(lichSu, { at: new Date(), actorId: meId, kind: "DECISION", label: RESOLUTION_LABEL[a], note: extra.note ?? "" }) });
      toast.success(`${c.tracking} · ${RESOLUTION_LABEL[a]}`, { description: "Đã ghi kết quả xử lý. KHÔNG gửi lệnh nào sang Viettel Post và KHÔNG đổi trạng thái vận đơn.", duration: 6000 });
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
  const ten = customerNameForDisplay(c.customer, c.phone);
  /*
    MỘT LUẬT CHO MỌI NÚT: cùng `canRequestCarrierAction` mà máy chủ dùng, trên đúng dữ liệu thô
    (mã + chữ + chặng + năng lực tài khoản). Trước đây bàn care lọc bằng `carrierActionAllowed`
    (chặng thô), trang chi tiết có danh sách chặng riêng, còn máy chủ xét trạng thái con — ba câu
    trả lời cho một câu hỏi. Nút không đủ điều kiện vẫn HIỆN nhưng khoá, kèm lý do trong tooltip.
  */
  const eligibility = (k: CarrierActionKey) => canRequestCarrierAction(k, { stage: c.carrier.stage, vtpStatus: c.carrier.vtpStatus, vtpStatusName: c.carrier.rawStatus, orderNumber: c.tracking, trackingCapability: c.carrier.trackingCapability, configured: true });
  const vtpUrl = getViettelPostTrackingUrl(c.vtpOrderNumber);
  const businessEligibility = (a: BusinessAction) => (ACTION_CALLS_CARRIER[a] ? eligibility(a === "APPROVE_RETURN" ? "approve-return" : "redeliver") : null);
  const [dialogFor, setDialogFor] = useState<"APPROVE_RETURN" | "EXCHANGE" | null>(null);
  const req = c.carrierRequest;

  return (
    <>
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
          {c.tracking ? <CopyButton value={c.tracking} what="mã vận đơn" className="size-5 shrink-0 [&_svg]:size-3" /> : null}
          {/* Cùng biểu tượng, cùng hàm dựng địa chỉ với bảng "Tất cả vận đơn" và trang chi tiết —
              bàn care là nơi thao tác "mở trang Viettel Post tra kiện" diễn ra nhiều nhất. */}
          <VtpTrackingLink code={c.vtpOrderNumber} className="size-5 shrink-0 [&_svg]:size-3" />
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
          {/*
            VIỆC ĐÃ NẰM TRONG TAY MÀ CHƯA AI MỞ RA.

            "Chưa ai nhận" đã có chỗ của nó (ô chọn người). Nhãn này nói điều NGƯỢC LẠI và khó thấy
            hơn nhiều: đã có người nhận rồi, nhưng chưa một lượt xử lý nào. Đo production
            22/09/2026: 22 đợt như vậy — và cho tới bản này chúng trông y hệt một ca đang được làm,
            vì cột "phản hồi đầu" đã được ghi ngay lúc giao việc.
          */}
          {c.care.owner && soLuot === 0 ? (
            <span
              className="rounded bg-amber-100 px-1.5 py-px text-[10.5px] font-semibold text-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
              title={`Đã giao cho ${c.care.owner.name} nhưng chưa có lượt xử lý nào: chưa gọi, chưa nhắn, chưa bấm kết quả. Giao việc không phải một lượt xử lý.`}
            >
              đã giao, chưa bắt đầu
            </span>
          ) : null}
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
        {/* Chỉ các mốc ĐANG lọc — để kiểm lại bộ lọc ngay trên dòng. `—` là CHƯA BIẾT, không phải hôm nay. */}
        {ngayHien.length ? (
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10.5px] text-muted-foreground">
            {ngayHien.map((k) => (
              <span key={k} title={`${CARE_DATES[k].question}

Nguồn: ${CARE_DATES[k].source}`}>
                {CARE_DATES[k].short}: {c.dates?.[k] ? vnShortStamp(c.dates[k]) : <span title={CARE_DATES[k].unknownLabel}>—</span>}
              </span>
            ))}
          </div>
        ) : null}
      </td>
      <td className="px-2 py-2">
        {/* Tên Pancake điền hộ ("Khách hàng 0984107775") KHÔNG được bày như một cái tên đã biết —
            xem lib/constants/customer-name.ts. Không đoán tên thay, chỉ nói thẳng là chưa có. */}
        {ten.isPlaceholder ? (
          <div className="font-medium text-muted-foreground" title={ten.raw ? `Pancake điền sẵn: “${ten.raw}” — chưa ai hỏi tên khách.` : "Đơn không có tên người mua."}>
            {ten.text}
          </div>
        ) : (
          <div className="font-medium">{ten.text}</div>
        )}
        {c.phone ? (
          // Gọi được thì bấm; nhắn Zalo / dán vào Pancake thì cần sao chép. Hai việc khác nhau nên
          // phải có hai nút — một cái link `tel:` không giúp gì cho người đang mở cửa sổ chat.
          <span className="inline-flex items-center gap-0.5">
            <a href={`tel:${c.phone}`} className="numeric inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline">
              <Phone className="size-3" /> {c.phone}
            </a>
            <CopyButton value={c.phone} what="SĐT" className="size-5 shrink-0 [&_svg]:size-3" />
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">chưa có SĐT</span>
        )}
        <div className="numeric font-semibold">{formatVND(c.codAmount)}</div>
      </td>
      <td className="px-2 py-2">
        {/* Tiền tố “VTP:” vì cùng một cụm chữ (“Chờ phát lại”) còn xuất hiện ở lý do care và ở
            trạng thái care — ba chỗ, ba nghĩa. Chỉ dòng này là CHỨNG TỪ của đơn vị vận chuyển. */}
        <div title="Nguyên văn trạng thái Viettel Post gửi về — không thao tác nào của đội sửa được dòng này">
          <span className="mr-1 rounded bg-violet-100 px-1 text-[10px] font-semibold text-violet-800 dark:bg-violet-950/60 dark:text-violet-300">VTP</span>
          {c.carrier.rawStatus}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {c.carrier.stageLabel} · {gio(c.carrier.ageHours)}
          {c.carrier.failedAttempts ? ` · hụt ${c.carrier.failedAttempts} lần` : ""}
        </div>
      </td>
      <td className="px-2 py-2">
        {/*
          KẾT QUẢ XỬ LÝ ĐỨNG TRÊN CÙNG Ô CARE — đây là câu hỏi người trực phải trả lời cho mỗi kiện.

          KHÔNG có điều kiện ĐVVC nào ở đây: ba nút này ghi LỜI KHAI CỦA NGƯỜI, và chúng phải bấm
          được kể cả khi ERP chưa khai tài khoản API, kiện chưa có mã vận đơn, hay kiện đã kết thúc.
          Lệnh gửi sang Viettel Post nằm ở cột "Viettel Post" bên phải — khối đó mới được phép khoá.
        */}
        <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Kết quả case</div>
        <ResolutionControl
          value={c.care.lastDecision?.decision ?? null}
          pending={pending}
          presets={resolutionPresets}
          canEditPresets={canManage}
          onSubmit={doResolution}
        />
        {c.care.lastDecision ? (
          <div className="mt-0.5 text-[10.5px] text-muted-foreground" title={c.care.lastDecision.note || undefined}>
            {c.care.lastDecision.by || "không rõ người"} · {formatTimeAgo(c.care.lastDecision.at)}
          </div>
        ) : null}
        {/*
          TRƯỜNG THỨ HAI, NÓI RÕ NÓ LÀ CHIỀU NÀO. “Chờ phát lại” ở ô này là TRẠNG THÁI CARE của đội
          (đã hẹn / đã yêu cầu, đang chờ bưu tá đi), KHÔNG phải câu Viettel Post vừa gửi về — câu đó
          nằm ở cột “VTP báo” bên trái và không thao tác nào của đội sửa được.
        */}
        <div className="mt-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Trạng thái care</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {terminal ? (
            <button type="button" disabled={pending} onClick={reopen} className="h-7 rounded-md border px-2 text-[11.5px] font-medium hover:bg-accent" title="Case đã đóng — mở lại để tiếp tục care (lịch sử giữ nguyên)">
              Mở lại
            </button>
          ) : null}
          {/*
            Ô CHỌN CỦA HỆ, KHÔNG PHẢI `<select>` GỐC.

            `<select>` gốc cho `<option>` kế thừa nền của chính nó, nên mở menu ra thì MỌI lựa chọn
            mang đúng một màu — màu của trạng thái đang chọn. Mười một mục trông y hệt nhau và
            người trực phải đọc chữ từng dòng. Xem `components/status-select.tsx`.
          */}
          <StatusSelect
            value={c.care.status}
            disabled={pending || terminal}
            onChange={(v) => changeStatus(v)}
            className="h-7 w-[9.5rem] border-0 px-1.5 text-[11.5px]"
            ariaLabel="Trạng thái care"
            title={CARE_STATUS_HINT[c.care.status]}
            options={CARE_STATUSES.map((s) => ({ value: s, label: CARE_STATUS_LABEL[s], tone: CARE_STATUS_TONE[s], hint: CARE_STATUS_HINT[s] }))}
          />
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
            /*
              CÁI HẸN PHẢI ĐỌC ĐƯỢC BẰNG MẮT, KHÔNG PHẢI BẰNG PHÉP TRỪ TRONG ĐẦU.

              "10:13 20/09" bắt người trực tự tính còn bao lâu; "còn 2 giờ" và "quá hẹn 3 giờ" trả
              lời thẳng câu họ đang hỏi — *cái nào phải làm trước*. Giờ tuyệt đối vẫn ở tooltip cho
              lúc cần chính xác.
            */
            <button
              type="button"
              className={cn("hover:underline", c.care.followUpAt.getTime() <= Date.now() && "font-semibold text-rose-600 dark:text-rose-400")}
              title={`Xử lý lại lúc ${formatDateTime(c.care.followUpAt)} — bấm để bỏ hẹn`}
              onClick={() => followUp(null)}
            >
              Xử lý lại {formatDateTime(c.care.followUpAt)} · {hanHen(c.care.followUpAt, now)}
            </button>
          ) : teamWorkEnded(c.care) ? (
            /*
              Ô TRỐNG Ở CHỖ VỪA CÓ MỘT NGÀY THÁNG LÀ MỘT CÂU HỎI BỎ NGỎ.

              Ca đã chốt "Đã hoàn" cố ý KHÔNG có hẹn (xem `DECISION_ENDS_TEAM_WORK`). Để nguyên ba
              nút hẹn nhanh ở đây thì người trực sẽ bấm một cái — và kéo ngược ca đã xử lý xong về
              "Cần care", đúng thứ bản vá này đi sửa. Nói ra vì sao, và để đường quay lại nằm ở bộ
              ba kết quả ngay bên cạnh ("Phát tiếp" cấp lại hẹn mới).
            */
            <span className="text-muted-foreground" title="Đội đã chốt bỏ kiện này. Không còn việc cho người tới khi Viettel Post báo kết cục — đổi ý thì bấm “Phát tiếp”.">
              Không hẹn lại · chờ chứng từ ĐVVC
            </span>
          ) : (
            FOLLOW_UP_PRESETS.map((p) => (
              <button key={p.key} type="button" disabled={pending} className="rounded border px-1 py-px text-[10.5px] hover:bg-accent" onClick={() => followUp(followUpPresetAt(p))}>
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
        {/*
          ═══ "ĐÃ XỬ LÝ MẤY LƯỢT" ĐỨNG NGAY DƯỚI NOTE, VÀ MỞ RA ĐƯỢC TẠI CHỖ ═══

          Note gần nhất chỉ là DÒNG CUỐI của một câu chuyện. Người trực nhận một ca lúc 2 giờ chiều
          đọc được "khách hẹn mai" mà không biết đó là lần hẹn thứ nhất hay thứ ba — và hai tình
          huống ấy dẫn tới hai cuộc gọi khác hẳn nhau. Trước bản này câu trả lời nằm trong ngăn kéo,
          tức là phải rời bảng, mở, đọc, đóng, cho từng dòng một.

          Con số là NÚT: bấm là mở nhật ký ngay dưới dòng, không rời bảng, không tải lại.
        */}
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          title={soLuot === 0 ? CARE_ROUND_BAND_HINT["0"] : `Bấm để xem ${soLuot === 1 ? "lượt" : `${soLuot} lượt`} xử lý và các lần đổi trạng thái của đợt này.`}
          className={cn("mt-1 flex w-full items-center gap-1 rounded px-1 py-px text-left text-[10.5px] hover:bg-accent", soLuot === 0 && "font-semibold text-rose-600 dark:text-rose-400")}
        >
          {historyOpen ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
          {soLuot === 0 ? "Chưa xử lý lần nào" : `Đã xử lý ${soLuot} lượt`}
          {lichSu && lichSu.lastRoundAt ? <span className="text-muted-foreground">· {formatTimeAgo(lichSu.lastRoundAt)}</span> : null}
        </button>
        {/*
          ĐVVC ĐÃ NÓI THÊM KỂ TỪ LƯỢT XỬ LÝ CUỐI — cảnh báo này KHÔNG có ở đâu khác trên màn hình.
          Ca được hẹn xem lại chiều mai vẫn nằm im tới chiều mai, kể cả khi sáng nay Viettel Post
          báo phát hụt lần nữa: cái hẹn đứng trên một bức tranh đã cũ. Chỉ hiện khi ĐÃ có lượt xử
          lý — chưa làm gì thì không có "kể từ lúc nào" để so.
        */}
        {lichSu?.carrierNewsAfterLastRound ? (
          <div className="mt-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300" title="Viettel Post đã gửi tin mới sau lượt xử lý gần nhất. Đọc lại cột “VTP báo” trước khi làm theo cái hẹn đang có.">
            ⚠ ĐVVC có tin mới sau lượt xử lý cuối
          </div>
        ) : null}
        {lichSu && lichSu.previousEpisodes > 0 ? (
          <div className="mt-0.5 text-[10.5px] text-muted-foreground" title="Kiện này đã từng vào hàng đợi care và được đóng lại trước đây. Nhật ký dưới đây chỉ của ĐỢT ĐANG MỞ — lịch sử các đợt trước ở ngăn kéo.">
            đợt thứ {lichSu.previousEpisodes + 1} của kiện này
          </div>
        ) : null}
        <Popover open={noteOpen} onOpenChange={setNoteOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="mt-1 inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] hover:bg-accent">
              <MessageSquarePlus className="size-3" /> Ghi note
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[22rem] space-y-2 p-3">
            {/*
              NGƯỜI SẮP GÕ MỘT GHI CHÚ PHẢI BIẾT ĐÂY LÀ LƯỢT THỨ MẤY.

              "Khách hẹn mai" ở lượt 1 và "khách hẹn mai" ở lượt 3 là hai tình huống khác hẳn nhau —
              cái sau nghĩa là khách đã hẹn rồi lỡ hai lần. Trước bản này câu trả lời nằm trong ngăn
              kéo, tức là phải đóng popover, mở ngăn kéo, đọc, quay lại. Một dòng chữ ở đây là đủ.

              Chữ gợi ý lấy thẳng `CARE_ROUND_BAND_HINT` — cùng bộ chữ với chip lọc và với tooltip
              của nút mở nhật ký, nên ba chỗ không nói ba điều khác nhau về cùng một rổ.
            */}
            <p className={cn("rounded bg-muted/60 px-2 py-1 text-[10.5px] leading-snug", soLuot === 0 && "text-rose-700 dark:text-rose-300")}>
              <b>{soLuot === 0 ? "Chưa ai xử lý kiện này" : `Đây sẽ là lượt xử lý thứ ${soLuot + 1}`}</b>
              {lichSu?.lastRoundAt ? ` · lượt trước ${formatTimeAgo(lichSu.lastRoundAt)}` : ""}
              {" — "}
              {CARE_ROUND_BAND_HINT[careRoundBand(soLuot)]}
            </p>
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
            <ManualRequestVerdict req={req} className="mt-0.5" />
          </div>
        ) : null}
        {canManage ? (
          <Popover open={vtpOpen} onOpenChange={setVtpOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] hover:bg-accent" title={c.carrierCapability === "API" ? "Gửi thẳng lên Viettel Post bằng tài khoản đối tác" : "Không gửi thẳng được — ERP ghi yêu cầu, soạn sẵn nội dung, bạn làm tay trên viettelpost.vn; webhook tự xác minh"}>
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
                  : "Viettel Post không cấp API cho shop. ERP ghi yêu cầu là PHẢI LÀM TAY và soạn sẵn nội dung để chép; làm trên viettelpost.vn rồi bấm “Đã làm tay”. Webhook tự xác minh khi kiện sang chặng lệnh xin."}
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
              {vtpUrl ? (
                <a href={vtpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                  <ExternalLink className="size-3" /> Mở trên viettelpost.vn
                </a>
              ) : null}
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
      {/*
        ═══ NHẬT KÝ MỞ RA NGAY DƯỚI DÒNG, KHÔNG PHẢI TRONG MỘT NGĂN KÉO KHÁC ═══

        Một `<tr>` phụ trải hết chiều ngang, chỉ dựng khi người dùng MỞ: đóng thì không có node nào
        trong cây, nên một bảng ba trăm dòng không gánh ba trăm danh sách ẩn.

        Dòng này CHỈ có nhật ký của ĐỘI. Hành trình Viettel Post nằm ở cột "VTP báo" và ở ngăn kéo,
        dưới nhãn của chính nó — luật 47: lời khai của ĐVVC và kết luận của ERP không bao giờ đứng
        chung một danh sách, vì đọc xuôi một dòng trộn thì không ai còn phân biệt được cái nào là
        chứng từ và cái nào là việc shop tự làm.
      */}
      {historyOpen ? (
        <tr className="bg-muted/30">
          <td />
          <td colSpan={6} className="px-2 pb-3 pt-1">
            <CareTimeline history={lichSu} shipmentId={c.shipmentId} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * NHẬT KÝ XỬ LÝ CỦA MỘT ĐỢT — mới nhất trước, đúng thứ tự người đọc muốn: "vừa rồi làm gì" trước
 * "hôm kia làm gì".
 *
 * Mỗi dòng nói rõ nó thuộc CHIỀU NÀO (`CARE_TIMELINE_KIND_LABEL`) vì bốn loại việc rất khác nhau
 * đang đứng cạnh nhau: một cuộc gọi, một quyết định, một lần đổi trạng thái, một lệnh gửi ĐVVC.
 * Bỏ cái nhãn đó đi thì "Phát tiếp" (quyết định của shop) trông y hệt "Phát tiếp" (lệnh đã gửi đi),
 * và đó đúng là hai thứ mà cả hệ thống này đang cố tách ra.
 */
function CareTimeline({ history, shipmentId }: { history: CareCase["history"]; shipmentId: string }) {
  /*
    ═══ HAI CỘT, KHÔNG PHẢI MỘT DANH SÁCH TRỘN ═══

    Câu hỏi đắt nhất của người trực là *"ĐVVC báo lúc nào, và đội làm gì sau đó"*. Trộn hai nguồn
    thành một dòng thời gian thì đọc xuôi rất dễ, nhưng sau vài dòng không ai còn phân biệt được
    đâu là CHỨNG TỪ của Viettel Post và đâu là việc shop tự làm — đúng cái nhầm lẫn mà luật 47 dựng
    ra để chống. Hai cột đứng cạnh nhau cho cùng câu trả lời mà không đánh đổi điều đó.

    Hành trình ĐVVC TẢI KHI MỞ, không đi kèm hàng đợi: trang Vận đơn đã nằm trong danh sách trang
    chậm, và cột này chỉ được mở ở vài dòng mỗi buổi.
  */
  const [carrier, setCarrier] = useState<{ at: Date; status: string; note: string; location: string }[] | null>(null);
  const [carrierError, setCarrierError] = useState("");
  useEffect(() => {
    let huy = false;
    loadCarrierJourney(shipmentId).then((r) => {
      if (huy) return;
      if ("error" in r) setCarrierError(r.error);
      else setCarrier(r.data.map((e) => ({ ...e, at: new Date(e.at) })));
    });
    return () => {
      huy = true;
    };
  }, [shipmentId]);

  if (!history) {
    // CHƯA ĐỌC ĐƯỢC ≠ CHƯA CÓ GÌ (luật 42). Không bao giờ vẽ một danh sách rỗng thay cho câu này.
    return <p className="text-[11px] text-muted-foreground">Chưa đọc được lịch sử xử lý của kiện này.</p>;
  }
  return (
    <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Viettel Post nói gì · chứng từ</div>
        {carrierError ? (
          <p className="text-[11px] text-rose-600 dark:text-rose-400">{carrierError}</p>
        ) : carrier === null ? (
          // ĐANG ĐỌC ≠ KHÔNG CÓ. Một danh sách rỗng ở đây là một lời khẳng định sai trong nửa giây.
          <p className="text-[11px] text-muted-foreground">Đang đọc hành trình…</p>
        ) : carrier.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Chưa có sự kiện nào từ Viettel Post cho kiện này.</p>
        ) : (
          <ol className="space-y-0.5">
            {carrier.map((e, i) => (
              <li key={`${e.at.toISOString()}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
                <span className="numeric w-[7.5rem] shrink-0 text-muted-foreground">{formatDateTime(e.at)}</span>
                <span className="font-medium">{e.status}</span>
                {e.location ? <span className="text-muted-foreground">· {e.location}</span> : null}
                {e.note ? <span className="min-w-0 basis-full pl-[7.5rem] text-muted-foreground">{e.note}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Đội làm gì · nhật ký xử lý</div>
        <CareTeamTimeline history={history} />
      </div>
    </div>
  );
}

function CareTeamTimeline({ history }: { history: NonNullable<CareCase["history"]> }) {
  if (!history.timeline.length) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Chưa có dòng nào trong đợt này — chưa ai gọi, chưa ai ghi chú, chưa ai đổi trạng thái. Mở ngăn kéo nếu cần xem các đợt trước của kiện.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <ol className="space-y-0.5">
        {history.timeline.map((e, i) => (
          <li key={`${e.at.toISOString()}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
            <span className="numeric w-[7.5rem] shrink-0 text-muted-foreground" title={formatDateTime(e.at)}>
              {formatDateTime(e.at)}
            </span>
            <span className={cn("shrink-0 font-semibold", CARE_TIMELINE_KIND_TONE[e.kind])} title={CARE_TIMELINE_KIND_LABEL[e.kind]}>
              {CARE_TIMELINE_KIND_LABEL[e.kind]}
            </span>
            <span className="font-medium">{e.label}</span>
            {/*
              "MÁY LÀM" VÀ "CHƯA BIẾT AI" LÀ HAI THỨ (luật 36). Một dòng của bộ đối chiếu lúc 3 giờ
              sáng và một dòng cũ không nối được tài khoản trông giống hệt nhau nếu cả hai cùng in
              ra một ô trống — và người đọc sẽ mặc định đó là một người nào đó.
            */}
            <span className="shrink-0 text-muted-foreground">· {e.bySystem ? "hệ thống" : e.actor || "chưa rõ người"}</span>
            {e.note ? <span className="min-w-0 basis-full pl-[7.5rem] text-muted-foreground">“{e.note}”</span> : null}
          </li>
        ))}
      </ol>
      {history.timelineTruncated ? (
        <p className="text-[10.5px] text-muted-foreground">
          Chỉ hiện {CARE_TIMELINE_INLINE_MAX} dòng gần nhất — mở ngăn kéo để xem toàn bộ nhật ký và hành trình Viettel Post.
        </p>
      ) : null}
    </div>
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
