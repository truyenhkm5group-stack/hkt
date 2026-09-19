"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, MessageSquare, Phone, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { CopyButton } from "@/components/misc";
import { openCopilot } from "@/components/ai-copilot";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { resolveNotification } from "@/lib/actions/alerts";
import { loadCareWorkspace, recordCareAction, type CareWorkspace } from "@/lib/actions/care";
import { recordCareDecision, requestCarrierAction, setCareFollowUp, setCareOwner } from "@/lib/actions/care-workbench";
import { ResolutionBadge, ResolutionControl, type ResolutionExtra } from "@/app/(dashboard)/shipments/resolution-control";
import type { CareState } from "@/lib/care/contracts";
import { journeyTone, parseCourier } from "@/lib/care/journey-display";
import { CARE_STATUS_LABEL, CARE_STATUS_TONE, FOLLOW_UP_PRESETS, followUpPresetAt, type CareStatus } from "@/lib/constants/care";
import { customerNameForDisplay } from "@/lib/constants/customer-name";
import { isAppShortcut } from "@/lib/keyboard";
import { CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { canRequestCarrierAction } from "@/lib/care/redelivery-eligibility";
import { BUSINESS_ACTION_LABEL } from "@/lib/constants/care-outcome";
import { CARRIER_ACTION_LABEL, CARRIER_REQUEST_LABEL, CARRIER_REQUEST_TONE, type CarrierActionKey, type CarrierRequestStatus } from "@/lib/constants/care";
import { CARE_DECISIONS, RESOLUTION_LABEL, type CareDecision } from "@/lib/constants/care-resolution";
import { CARE_ACTION_KINDS, CARE_ACTION_LABEL, type CareActionKind } from "@/lib/constants/delivery-tower";
import { RETURN_REASON_LABEL, type ReturnReason } from "@/lib/constants/return-reason";
import { getViettelPostTrackingUrl } from "@/lib/constants/viettelpost";
import { formatDateTime, formatNumber, formatTimeAgo, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ───────────── BÀN XỬ LÝ MỘT KIỆN HÀNG (panel bên phải) ─────────────
 *
 * ĐO ĐƯỢC: gọi một khách giao hụt trước đây cần SÁU lần chuyển màn hình (vận đơn → chi tiết → quay
 * lại → đơn → khách → tab Pancake). Panel này gom vào MỘT lần mở, và danh sách phía sau không mất
 * chỗ — đóng lại là vẫn ở đúng dòng vừa đọc.
 *
 * ─── BẢN NÀY ĐỔI GÌ (18/09/2026) ───
 *
 * Panel cũ chỉ TRA CỨU được: nó đọc `getShipmentQuickView`, nên không có trạng thái care, không có
 * người phụ trách, không có hạn, không có kết quả đã quyết, và không có mã Viettel Post thật (nên
 * mã vận đơn chỉ sao chép được chứ không bấm sang ĐVVC được). Muốn XỬ LÝ thì phải đóng panel, tìm
 * lại dòng trong bảng, thao tác ở ngoài — đúng thứ panel sinh ra để khỏi phải làm.
 *
 * Nay panel đọc `getCareCaseDetail` (cùng phép đọc mà AI Copilot dùng) và mang đủ BA CHIỀU:
 *
 *   ĐVVC nói gì   → hành trình + trạng thái con, CHỈ ĐỌC, không nút nào sửa được;
 *   đội ở đâu     → trạng thái xử lý, người phụ trách, hạn;
 *   đội quyết gì  → ba nút Đã hoàn · Phát tiếp · Xử lý sau, CÙNG một bản dựng với bảng bên ngoài.
 *
 * Ba chiều đứng ba khối riêng và KHÔNG khối nào suy ra khối nào. Bấm "Đã hoàn" ở đây KHÔNG làm vận
 * đơn thành hoàn: hành trình bên dưới vẫn nguyên si cho tới khi Viettel Post nói khác.
 *
 * ─── VẪN KHÔNG CÓ NÚT NÀO TỰ NHẮN KHÁCH ───
 *
 * Nút ở đây GHI LẠI điều người vừa làm, hoặc GỬI một yêu cầu có ghi vết sang ĐVVC. ERP không thay
 * người nói chuyện với khách.
 *
 * LÀM MỘT LƯỢT, KHÔNG MỞ-ĐÓNG TỪNG KIỆN. `queue` (danh sách kiện theo đúng thứ tự của bảng phía
 * sau) cho panel có ‹ Trước · n/N · Tiếp ›, phím J/K, và — nếu bật — TỰ CHUYỂN sang kiện kế tiếp
 * sau khi ghi nhận: một buổi gọi 30 khách là 30 lần bấm, không phải 30 lần đóng panel và tìm dòng.
 */
export type CareQueueItem = { shipmentId: string; caseId?: string | null };

/** Bật/tắt "ghi nhận xong tự chuyển kiện kế". Lựa chọn của từng người, từng máy — nên ở trình duyệt. */
const AUTO_NEXT_KEY = "erp.care.autoNext";

function readAutoNext(): boolean {
  try {
    return window.localStorage.getItem(AUTO_NEXT_KEY) !== "0";
  } catch {
    // Chặn cookie / chế độ ẩn danh ⇒ mặc định BẬT, không làm panel chết.
    return true;
  }
}

/** Một dòng nhật ký gộp: quyết định · thao tác care · việc đã chăm. Ba nguồn, một trục thời gian. */
type LogRow = { at: Date; actor: string; kind: "DECISION" | "CARRIER" | "CARE" | "ACTION"; title: string; detail: string };

export function CareDrawer({
  shipmentId,
  caseId = null,
  queue,
  children,
  className,
  open: openNgoai,
  onOpenChange,
}: {
  shipmentId: string;
  /** Việc trong hàng đợi Cần xử lý gắn với kiện này — có thì hiện thêm "Ghi nhận & đóng việc". */
  caseId?: string | null;
  /** Danh sách kiện để đi lần lượt. Kiện hiện tại phải nằm trong danh sách; không có thì bỏ qua. */
  queue?: CareQueueItem[];
  /** Không truyền thì panel không tự vẽ nút mở — dùng cho nơi đã có sẵn nút (ô lệnh ⌘K). */
  children?: React.ReactNode;
  className?: string;
  /** Điều khiển từ ngoài. Bỏ trống thì panel tự quản trạng thái mở của mình. */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const router = useRouter();
  const [openTrong, setOpenTrong] = useState(false);
  const open = openNgoai ?? openTrong;
  const setOpen = (v: boolean) => {
    setOpenTrong(v);
    onOpenChange?.(v);
  };
  // Kiện ĐANG XEM có thể khác kiện được truyền vào khi người dùng đi tiếp trong danh sách.
  const [current, setCurrent] = useState<CareQueueItem>({ shipmentId, caseId });
  const [ws, setWs] = useState<CareWorkspace | null>(null);
  const [dangTai, setDangTai] = useState(false);
  const [kind, setKind] = useState<CareActionKind>("CALLED_REACHED");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [autoNext, setAutoNext] = useState(true);
  const [openFor, setOpenFor] = useState<CareDecision | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setAutoNext(readAutoNext()), []);

  const data = ws?.detail ?? null;
  /*
    ═══ DANH SÁCH ĐI LẦN LƯỢT LÀ MỘT ẢNH CHỤP, KHÔNG PHẢI BỘ LỌC ĐANG SỐNG ═══

    `queue` đến từ `visible` của bảng, và nó CO LẠI sau mỗi lần ghi: kiện vừa xử lý rời bộ lọc hiện
    tại (vd "Phát tiếp" đẩy ca sang "Đang chờ kết quả"). Nếu điều hướng bám vào mảng sống thì ngay
    khi người dùng KHÔNG bật tự-chuyển, kiện đang xem biến khỏi `queue`, `hangDoi` thành `null`, và
    ‹ n/N › cùng hai nút Trước/Tiếp BIẾN MẤT giữa chừng — người trực đang đi dở một danh sách 41
    kiện thì mất luôn đường đi.

    Nên chụp danh sách MỘT LẦN lúc mở panel. Người trực đi hết đúng cái danh sách họ nhìn thấy lúc
    bắt đầu; kiện đã xử lý vẫn còn chỗ trong đó (quay lại xem được), và số thứ tự không nhảy dưới
    tay họ. Điều hướng đi bằng `shipmentId` chứ không bằng chỉ số, nên không có chuyện nhảy nhầm.
  */
  const [walk, setWalk] = useState<CareQueueItem[]>([]);
  useEffect(() => {
    if (!open) return;
    setWalk((truoc) => (truoc.length ? truoc : (queue ?? [])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const hangDoi = walk.length && walk.some((q) => q.shipmentId === current.shipmentId) ? walk : null;
  const viTri = hangDoi ? hangDoi.findIndex((q) => q.shipmentId === current.shipmentId) : -1;
  const truoc = hangDoi && viTri > 0 ? hangDoi[viTri - 1] : null;
  const tiep = hangDoi && viTri >= 0 && viTri < hangDoi.length - 1 ? hangDoi[viTri + 1] : null;

  const tai = useCallback(async (id: string) => {
    setDangTai(true);
    const r = await loadCareWorkspace(id);
    setWs(r ?? null);
    setDangTai(false);
  }, []);

  const chuyen = useCallback(
    (item: CareQueueItem) => {
      setCurrent(item);
      setWs(null);
      setMsg(null);
      setNote("");
      setOpenFor(null);
      void tai(item.shipmentId);
    },
    [tai],
  );

  /** Nạp lại kiện đang xem — dùng sau mỗi lần ghi, để panel đọc ĐÚNG thứ máy chủ vừa lưu. */
  const naplai = useCallback(async () => {
    const r = await loadCareWorkspace(current.shipmentId);
    setWs(r ?? null);
  }, [current.shipmentId]);

  function ghi(dongViec: boolean) {
    start(async () => {
      const r = await recordCareAction({ shipmentId: current.shipmentId, kind, note });
      if (r.error) {
        setMsg(r.error);
        return;
      }
      if (dongViec && current.caseId) {
        const d = await resolveNotification(current.caseId);
        if ("error" in d) {
          setMsg(`Đã ghi nhận, nhưng chưa đóng được việc: ${d.error}`);
          return;
        }
        router.refresh();
      }
      setNote("");
      if (autoNext && tiep) {
        toast.success(`Đã ghi nhận${dongViec ? " và đóng việc" : ""} · chuyển sang kiện ${viTri + 2}/${hangDoi!.length}`);
        chuyen(tiep);
        return;
      }
      setMsg("Đã ghi nhận");
      await naplai();
    });
  }

  /*
    ═══ BA NÚT KẾT QUẢ — CÙNG SERVER ACTION VỚI BẢNG BÊN NGOÀI ═══

    `recordBusinessAction` là đường ghi DUY NHẤT cho một quyết định xử lý. Panel không có đường tắt
    riêng: nếu có, thì kiểm tra điều kiện ĐVVC, nhật ký, và sổ `care_business_actions` sẽ có hai
    phiên bản, và phiên bản nào thiếu một bước sẽ là phiên bản người ta dùng vì nó nhanh hơn.

    Sau khi ghi: TẢI LẠI từ máy chủ (mục 18 — máy chủ là nguồn sự thật, không vá bằng thứ mình đoán),
    rồi mới tự chuyển kiện nếu người dùng bật. Ghi lỗi thì KHÔNG chuyển, và panel đứng nguyên ở kiện
    đang lỗi — chuyển đi là giấu mất lỗi.
  */
  const doResolution = (a: CareDecision, extra: ResolutionExtra) =>
    start(async () => {
      const r = await recordCareDecision({ shipmentId: current.shipmentId, decision: a, note: extra.note, reasonCode: extra.reasonCode, followUpAt: extra.followUpAt });
      if ("error" in r) {
        toast.error(r.error, { duration: 9000 });
        return;
      }
      /*
        "Xử lý sau" đẩy ca sang "Đang chờ kết quả" tới giờ hẹn. Đúng vòng đời, nhưng nhìn từ chỗ
        người trực thì kiện BIẾN MẤT khỏi danh sách — và họ sẽ nghĩ là mình bấm hỏng. Nói ra GIỜ
        QUAY LẠI, ngay trong câu xác nhận, là cách rẻ nhất để chặn hiểu nhầm đó.
      */
      const quayLai = a === "CARE_FOLLOW_UP" && extra.followUpAt ? extra.followUpAt : null;
      toast.success(`${RESOLUTION_LABEL[a]} · ${data?.shipment.tracking ?? ""}`, {
        description: quayLai
          ? `Đã hẹn xử lý lại lúc ${formatDateTime(quayLai)}. Ca tạm rời “Cần care” và tự quay lại đúng giờ đó — không mất đi đâu cả.`
          : "Đã ghi kết quả xử lý. KHÔNG gửi lệnh nào sang Viettel Post và KHÔNG đổi trạng thái vận đơn.",
        duration: 7000,
      });
      // Dòng ngoài bảng đổi theo panel NGAY, bằng đúng `CareState` máy chủ vừa trả về.
      phatCapNhat(current.shipmentId, r.data);
      if (autoNext && tiep) {
        chuyen(tiep);
        return;
      }
      await naplai();
    });

  const doOwner = (ownerId: string) =>
    start(async () => {
      const r = await setCareOwner({ shipmentIds: [current.shipmentId], ownerId: ownerId || null });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      const st = r.data.states[current.shipmentId];
      if (st) phatCapNhat(current.shipmentId, st);
      await naplai();
    });

  /*
    HẸN NHANH TRONG PANEL — CÙNG BỘ NÚT, CÙNG PHÉP TÍNH, CÙNG MỘT CỘT `follow_up_at` VỚI BẢNG.

    Ba nút +2 giờ · Sáng mai · +2 ngày trước đây chỉ có ở dòng ngoài bảng. Người trực đang mở panel
    để gọi khách — đúng lúc họ biết nên hẹn lại khi nào — lại phải đóng panel, tìm lại dòng, rồi
    bấm. Thực tế quan sát được là họ không hẹn nữa, và ca chìm.

    Dùng lại `FOLLOW_UP_PRESETS` + `followUpPresetAt` (hàm thuần ở `lib/constants/care.ts`) chứ
    không chép phép tính: chép là mở đường cho "Sáng mai" của panel khác "Sáng mai" của bảng.
  */
  const doFollowUp = (at: Date | null) =>
    start(async () => {
      const r = await setCareFollowUp({ shipmentId: current.shipmentId, at });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      phatCapNhat(current.shipmentId, r.data);
      toast.success(at ? `Hẹn xem lại ${formatDateTime(at)}` : "Đã bỏ hẹn xem lại");
      await naplai();
    });

  // Mở từ ngoài (ô lệnh ⌘K) cũng phải nạp dữ liệu — nếu chỉ nạp trong hàm bấm nút thì panel mở ra
  // rỗng và đứng im mãi.
  useEffect(() => {
    if (open && !ws && !dangTai) void tai(current.shipmentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /*
    ═══ PHÍM TẮT: CHỈ KHI KHÔNG AI ĐANG GÕ, VÀ 1·2·3 KHÔNG BAO GIỜ GHI THẲNG ═══

    J/K đi kiện · 1/2/3 CHỌN một trong ba kết quả · N nhảy vào ô note.

    ─── VÌ SAO 1·2·3 CHỈ CHỌN, KHÔNG GHI ───

    Một ký tự là phím nhanh nhất và cũng nguy hiểm nhất: nó trùng với ký tự người ta gõ. Nếu nó ghi
    thẳng thì mỗi lần bắt hụt (con trỏ vừa rời ô note, một lớp nổi vừa đóng) là một dòng sổ SAI
    trong `care_decisions` — sổ CHỈ THÊM, không sửa được. Hoàn tác thì phải ghi thêm một dòng nữa
    để huỷ dòng trước, và nhật ký kể một câu chuyện chưa từng xảy ra: "đã hoàn rồi lại không hoàn".

    Nên phím chỉ MỞ bảng của kết quả đó (`setOpenFor`), còn nút "Ghi nhận" mới ghi. Bấm hụt thì
    đóng bảng, không có gì được ghi, không có gì phải hoàn tác. Một cú bấm thêm rẻ hơn một sổ sai.

    ─── CHẶN ĐỨNG TRƯỚC MỌI NHÁNH ───

    `isAppShortcut` (`lib/keyboard.ts`) loại: đang gõ vào input/textarea/select/contenteditable/ô
    tìm kiếm/ô note (dò bằng `closest`, vì điểm nhận phím có thể là một thẻ con bên trong), phím có
    phụ trợ Ctrl/⌘/Alt (phím tắt của trình duyệt), và lượt gõ giữa chừng của bộ gõ tiếng Việt.
  */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isAppShortcut(e)) return;
      if (e.key === "j" || e.key === "J") {
        if (tiep) chuyen(tiep);
      } else if (e.key === "k" || e.key === "K") {
        if (truoc) chuyen(truoc);
      } else if (e.key === "1" || e.key === "2" || e.key === "3") {
        if (!ws?.canManage) return;
        // CHỌN, không ghi. Bấm lại cùng phím thì đóng bảng — thoát được bằng đúng phím vừa bấm.
        const chon = CARE_DECISIONS[Number(e.key) - 1];
        setOpenFor((truoc) => (truoc === chon ? null : chon));
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        noteRef.current?.focus();
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, tiep, truoc, chuyen, ws?.canManage]);

  const vtpUrl = getViettelPostTrackingUrl(data?.shipment.vtpOrderNumber);
  const resolution = data?.care.lastDecision?.decision ?? null;
  const tenKhach = customerNameForDisplay(data?.customer.name, data?.customer.phone);

  /* Nhật ký gộp ba nguồn, mới nhất trước — xem `LogRow`. Dựng ở client vì nó chỉ là cách BÀY, không
     phải một phép đo: ba nguồn vẫn là ba bảng riêng ở CSDL. */
  const log = useMemo<LogRow[]>(() => {
    if (!data) return [];
    const rows: LogRow[] = [];
    for (const d of data.decisions) {
      const chiTiet = [
        d.reasonCode ? `Lý do: ${RETURN_REASON_LABEL[d.reasonCode as ReturnReason] ?? d.reasonCode}` : "",
        d.followUpAt ? `Hẹn: ${formatDateTime(d.followUpAt)}` : "",
        // ẢNH CHỤP CHIỀU ĐVVC LÚC BẤM — bằng chứng đọc lại được rằng hai chiều không suy ra nhau.
        d.carrierSubstateAtDecision ? `VTP lúc đó: ${CARRIER_SUBSTATE_LABEL[d.carrierSubstateAtDecision as CarrierSubstate] ?? d.carrierSubstateAtDecision}` : "",
        d.note,
      ]
        .filter(Boolean)
        .join(" · ");
      rows.push({ at: d.at, actor: d.actor, kind: "DECISION", title: `Chọn: ${RESOLUTION_LABEL[d.decision]}`, detail: chiTiet });
    }
    // LỆNH GỬI ĐVVC là loại dòng KHÁC — không trộn vào "đội đã quyết gì".
    for (const b of data.carrierDecisions) {
      const chiTiet = [b.reasonCode ? `Lý do: ${RETURN_REASON_LABEL[b.reasonCode as ReturnReason] ?? b.reasonCode}` : "", b.carrierResult ? `ĐVVC: ${b.carrierResult}` : "", b.note].filter(Boolean).join(" · ");
      rows.push({ at: b.at, actor: b.actor, kind: "CARRIER", title: `Gửi ĐVVC: ${BUSINESS_ACTION_LABEL[b.action]}`, detail: chiTiet });
    }
    for (const e of data.events) {
      // Sự kiện CARRIER_REQUEST đã được kể bằng dòng quyết định ở trên — kể lại là nhân đôi.
      if (e.action === "CARRIER_REQUEST") continue;
      const truocSau = e.previousStatus && e.nextStatus && e.previousStatus !== e.nextStatus ? `${CARE_STATUS_LABEL[e.previousStatus]} → ${CARE_STATUS_LABEL[e.nextStatus]}` : "";
      rows.push({ at: e.at, actor: e.actor || (e.source === "SYSTEM" ? "Hệ thống" : "không rõ người"), kind: "CARE", title: truocSau || e.action, detail: e.note });
    }
    for (const a of data.careActions) rows.push({ at: a.at, actor: a.actor || "không rõ người", kind: "ACTION", title: a.label, detail: a.note });
    return rows.sort((x, y) => y.at.getTime() - x.at.getTime()).slice(0, 60);
  }, [data]);

  /**
   * Điều kiện của LỆNH GỬI ĐVVC — và CHỈ của nó. Ba nút kết quả care ở trên KHÔNG hỏi hàm này một
   * câu nào: năng lực API của ERP không được phép quyết định xem nhân viên có ghi nhận được việc
   * mình vừa làm hay không.
   */
  const carrierEligibility = (key: CarrierActionKey) => {
    if (!data) return { ok: false, callsApi: false, reason: "Đang tải…" };
    const e = canRequestCarrierAction(key, {
      stage: data.shipment.stage,
      vtpStatus: data.shipment.vtpStatus,
      vtpStatusName: data.shipment.rawStatus,
      orderNumber: data.shipment.vtpOrderNumber,
      trackingCapability: data.shipment.trackingCapability,
      // Sự thật từ máy chủ, không phải một hằng số lạc quan: ERP chưa khai tài khoản thì nút khoá
      // kèm đúng câu giải thích, thay vì sáng lên rồi trả về một lời từ chối.
      configured: data.shipment.carrierConfigured,
    });
    return { ok: e.ok, callsApi: e.callsApi, reason: e.reason };
  };

  /** Lệnh ĐVVC đang chờ xác nhận. `null` = chưa bấm gì. Xem `doCarrier`. */
  const [confirmCarrier, setConfirmCarrier] = useState<CarrierActionKey | null>(null);

  /**
   * Gửi một lệnh sang Viettel Post. Tách hẳn khỏi `doResolution` — hai việc, hai đường ghi.
   *
   * CÓ BƯỚC XÁC NHẬN vì đây là hành động có TÁC DỤNG PHỤ THẬT ra ngoài ERP: bưu tá được điều đi
   * lần nữa, hoặc kiện được duyệt cho quay đầu. Ba nút kết quả care thì không — chúng chỉ ghi vào
   * sổ của chính shop, nên hỏi lại ở đó là thêm ma sát không đổi lấy gì.
   */
  const doCarrier = (key: CarrierActionKey) =>
    start(async () => {
      setConfirmCarrier(null);
      const r = await requestCarrierAction({ shipmentId: current.shipmentId, actionKey: key, note: "" });
      if ("error" in r) {
        toast.error(r.error, { duration: 9000 });
        return;
      }
      (r.data.request.status === "MANUAL_REQUIRED" ? toast.warning : toast.success)(r.data.message, { duration: 9000 });
      // Lệnh ĐVVC đổi cột "Viettel Post" ngoài bảng — thứ KHÔNG nằm trong `CareState`, nên ở đây
      // vẫn phải để máy chủ dựng lại. Hiếm hơn nhiều so với ba nút kết quả care.
      router.refresh();
      await naplai();
    });

  const breached = Boolean(data?.sla && (data.sla.firstResponseBreached || data.sla.resolveBreached));

  return (
    <>
      {children ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            if (!ws && !dangTai) void tai(current.shipmentId);
          }}
          className={cn("text-left hover:underline", className)}
        >
          {children}
        </button>
      ) : null}
      <Sheet open={open} onOpenChange={setOpen}>
        {/* Panel CUỘN RIÊNG và đầu panel DÍNH: người cuộn xuống đọc hành trình vẫn bấm được ba nút. */}
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <SheetHeader className="shrink-0 border-b px-4 pb-2.5 pt-4">
            {/* `pr-8` chừa chỗ cho nút đóng của Sheet — không chừa thì dòng gợi ý phím tắt chui xuống dưới nó. */}
            <div className="flex flex-wrap items-center gap-1 pr-8 text-[11.5px] text-muted-foreground">
              {hangDoi ? (
                <>
                  <button type="button" disabled={!truoc} onClick={() => truoc && chuyen(truoc)} className="rounded border p-0.5 hover:bg-accent disabled:opacity-40" aria-label="Kiện trước (phím K)" title="Kiện trước · phím K">
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <span className="numeric px-1">
                    {viTri + 1}/{hangDoi.length}
                  </span>
                  <button type="button" disabled={!tiep} onClick={() => tiep && chuyen(tiep)} className="rounded border p-0.5 hover:bg-accent disabled:opacity-40" aria-label="Kiện tiếp theo (phím J)" title="Kiện tiếp theo · phím J">
                    <ChevronRight className="size-3.5" />
                  </button>
                  <label className="ml-1 inline-flex cursor-pointer items-center gap-1" title="Ghi nhận xong thì panel tự mở kiện kế tiếp trong danh sách. Ghi LỖI thì không chuyển — panel đứng lại ở kiện đang lỗi.">
                    <input
                      type="checkbox"
                      checked={autoNext}
                      onChange={(e) => {
                        setAutoNext(e.target.checked);
                        try {
                          window.localStorage.setItem(AUTO_NEXT_KEY, e.target.checked ? "1" : "0");
                        } catch {
                          /* Không lưu được thì lựa chọn chỉ sống trong phiên này — không chặn thao tác. */
                        }
                      }}
                    />
                    Ghi nhận xong tự chuyển kiện kế
                  </label>
                  <span className="ml-auto hidden sm:inline">Phím: J/K đi kiện · 1·2·3 kết quả · N ghi note</span>
                </>
              ) : (
                <span className="ml-auto hidden sm:inline">Phím: 1·2·3 kết quả · N ghi note</span>
              )}
            </div>
            <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
              {data ? (
                <>
                  {/* Tên Pancake điền hộ không được bày như tên đã biết — lib/constants/customer-name.ts */}
                  {tenKhach.isPlaceholder ? (
                    <span className="text-muted-foreground" title={tenKhach.raw ? `Pancake điền sẵn: “${tenKhach.raw}” — chưa ai hỏi tên khách.` : "Đơn không có tên người mua."}>
                      {tenKhach.text}
                    </span>
                  ) : (
                    <span>{tenKhach.text}</span>
                  )}
                  {/*
                    MÃ VẬN ĐƠN BẤM ĐƯỢC — mở thẳng trang tra cứu Viettel Post ở TAB MỚI, panel giữ
                    nguyên chỗ đang đứng. Địa chỉ dựng bằng `getViettelPostTrackingUrl`, cùng hàm mà
                    bảng và trang chi tiết dùng: không có chuỗi địa chỉ thứ hai trong kho mã.

                    Chưa có mã Viettel Post thì KHÔNG vẽ liên kết — mã Pancake tra trên viettelpost.vn
                    ra "không tìm thấy", và một liên kết sai tệ hơn không có liên kết.
                  */}
                  {vtpUrl ? (
                    <a
                      href={vtpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Mở hành trình kiện này trên viettelpost.vn (tab mới)"
                      className="inline-flex cursor-pointer items-center gap-1 font-mono text-[13px] font-semibold text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
                    >
                      {data.shipment.tracking} <ExternalLink className="size-3.5" />
                    </a>
                  ) : (
                    <span className="font-mono text-[13px]" title="Chưa có mã Viettel Post — không tra cứu trên viettelpost.vn được.">
                      {data.shipment.tracking}
                    </span>
                  )}
                  <CopyButton value={data.shipment.tracking} what="mã vận đơn" className="size-6 shrink-0" />
                </>
              ) : (
                "Đang mở kiện hàng…"
              )}
            </SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {data ? (
                <>
                  <span>
                    ĐVVC: <b className="font-medium text-foreground">{data.shipment.rawStatus}</b> · {data.shipment.substateLabel}
                  </span>
                  <span>· COD {formatVND(data.shipment.codAmount)}</span>
                  <ResolutionBadge value={resolution} at={data.care.lastDecision?.at ?? null} by={data.care.lastDecision?.by} />
                </>
              ) : (
                "Tải đủ ba chiều: ĐVVC nói gì · đội ở đâu · đội quyết gì"
              )}
            </SheetDescription>
          </SheetHeader>

          {dangTai || !data || !ws ? (
            <div className="flex items-center gap-2 px-4 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Đang tải…
            </div>
          ) : (
            <>
              {/* ───── KẾT QUẢ CARE — LUÔN THẤY, VÀ KHÔNG ĐỨNG ĐÈ LÊN GÌ CẢ ─────

                   Khối này TỪNG là `sticky top-0` bên trong vùng cuộn: luôn thấy thật, nhưng cái giá
                   là nó NẰM ĐÈ. Cuộn tới đâu thì một hai dòng hành trình bị phủ tới đó — mà hành
                   trình ĐVVC chính là căn cứ người trực đang đọc để quyết. Một dòng "Phát thất bại -
                   khách hẹn lại" bị che thì nút bên trên vẫn bấm được, chỉ là bấm mà thiếu căn cứ.

                   Không chữa được bằng `top` hay `scroll-padding-top`: phủ lên nội dung phía sau là
                   BẢN CHẤT của `sticky`. Nên khối ra HẲN khỏi vùng cuộn, thành một dải cố định của
                   panel. Vẫn luôn thấy, còn vùng cuộn bên dưới ngắn lại đúng bằng chiều cao của nó —
                   không dòng nào bị phủ nữa.

                   Ba nút này KHÔNG gửi gì sang ĐVVC và KHÔNG bao giờ bị khoá vì lý do ĐVVC.
                   Lệnh gửi ĐVVC nằm trong vùng cuộn bên dưới, tách bạch cả về chỗ đứng lẫn về chữ. */}
              <div className="shrink-0 border-y border-primary/30 bg-primary/[0.03] px-4 py-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-semibold uppercase tracking-wide">Kết quả care</span>
                  <span className="text-[11px] text-muted-foreground">ghi nhận việc người xử lý vừa quyết — KHÔNG gửi lệnh sang Viettel Post, KHÔNG đổi trạng thái vận đơn</span>
                </div>
                {/*
                  HAI CHIỀU IN CẠNH NHAU, LUÔN LUÔN.

                  "Kết quả care: Đã hoàn" và "VTP báo: Đang chuyển hoàn" được phép cùng đúng một
                  lúc, và màn hình phải nói ra điều đó thay vì để người đọc tự suy. Nhãn "VTP báo"
                  KHÔNG BAO GIỜ đổi theo quyết định care.
                */}
                <div
                  className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-2.5 py-1.5 text-[11.5px]"
                  title="Kết quả care là QUYẾT ĐỊNH XỬ LÝ NỘI BỘ của shop. Trạng thái vận chuyển thực tế lấy từ Viettel Post và chỉ Viettel Post đổi được."
                >
                  <span>
                    <span className="text-muted-foreground">Kết quả care: </span>
                    <ResolutionBadge value={resolution} at={data.care.lastDecision?.at ?? null} by={data.care.lastDecision?.by} />
                  </span>
                  <span>
                    <span className="text-muted-foreground">VTP báo: </span>
                    <b className="font-medium">{data.shipment.rawStatus}</b>
                  </span>
                </div>
                {ws.canManage ? (
                  <ResolutionControl
                    variant="panel"
                    value={resolution}
                    pending={pending}
                    presets={ws.resolutionPresets}
                    canEditPresets={ws.canManage}
                    onSubmit={doResolution}
                    openFor={openFor}
                    onOpenForChange={setOpenFor}
                  />
                ) : (
                  <p className="text-[12px] text-muted-foreground">Bạn không có quyền thao tác vận đơn (shipments:manage) nên ba nút kết quả bị khoá. Ghi chú và ghi nhận việc đã chăm thì vẫn làm được ở dưới.</p>
                )}
                {data.care.lastNote ? (
                  <p className="mt-2 border-t pt-2 text-[12px]">
                    <span className="text-muted-foreground">Note gần nhất: </span>
                    {data.care.lastNote}
                    <span className="text-[11px] text-muted-foreground">
                      {" "}
                      — {data.care.lastNoteBy || "không rõ người"} · {data.care.lastNoteAt ? formatDateTime(data.care.lastNoteAt) : "—"}
                    </span>
                  </p>
                ) : null}
              </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-8 pt-3">
              {/* ───── Liên hệ: gọi · sao chép · chat · đơn ───── */}
              <div className="flex flex-wrap items-center gap-2">
                {data.customer.phone ? (
                  <span className="inline-flex items-center gap-0.5 rounded-lg border bg-card pr-1">
                    <a href={`tel:${data.customer.phone}`} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] font-semibold hover:bg-accent">
                      <Phone className="size-3.5" /> {data.customer.phone}
                    </a>
                    <CopyButton value={data.customer.phone} what="SĐT" className="size-6 shrink-0" />
                  </span>
                ) : (
                  <span className="rounded-lg border px-2.5 py-1.5 text-[12.5px] text-muted-foreground">Chưa có SĐT</span>
                )}
                {data.order?.chatUrl ? (
                  <a href={data.order.chatUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] hover:bg-accent">
                    <MessageSquare className="size-3.5" /> Mở chat Pancake
                  </a>
                ) : null}
                {data.order?.systemId ? (
                  <Link href={`/orders/${data.order.id}`} className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] hover:bg-accent">
                    <ExternalLink className="size-3.5" /> Đơn #{data.order.systemId}
                  </Link>
                ) : null}
                <Link href={`/shipments/${data.shipment.id}`} className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] hover:bg-accent">
                  Chi tiết vận đơn
                </Link>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-card px-2.5 py-1.5 text-[12.5px] hover:bg-accent"
                  title="AI đọc đơn, khách, hành trình Viettel Post, COD và lịch sử care rồi tóm tắt + đề nghị bước tiếp theo. Không tự làm gì."
                  onClick={() => openCopilot({ message: "Tóm tắt kiện này: chuyện gì đang xảy ra, vì sao cần care, tiền nào đang rủi ro, nên làm gì tiếp?", context: { entityType: "shipment", entityId: data.shipment.id }, send: true })}
                >
                  <Sparkles className="size-3.5 text-brand" /> Tóm tắt bằng AI
                </button>
              </div>

              {/* ───── Dữ kiện trong một lưới: không phải cuộn đi tìm từng con số ───── */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl border px-3 py-2 text-[12px] sm:grid-cols-3">
                <Fact label="COD" value={formatVND(data.shipment.codAmount)} />
                <Fact label="Lần phát hụt" value={data.shipment.failedAttempts ? `${formatNumber(data.shipment.failedAttempts)} lần` : "chưa hụt lần nào"} />
                {/* CHƯA CÓ TIN khác hẳn 0 giờ — in dấu gạch, không in số 0 (luật 42). */}
                <Fact label="Tin ĐVVC gần nhất" value={data.shipment.ageHours === null ? "—" : data.shipment.ageHours < 1 ? "<1 giờ trước" : data.shipment.ageHours < 48 ? `${Math.round(data.shipment.ageHours)} giờ trước` : `${Math.round(data.shipment.ageHours / 24)} ngày trước`} />
                <Fact label="Lần gửi thứ" value={data.shipment.attemptNo === null ? "—" : String(data.shipment.attemptNo)} />
                <Fact
                  label="Hạn xử lý"
                  value={data.sla ? (breached ? "QUÁ HẠN" : `đóng trước ${formatDateTime(data.sla.resolveDueAt)}`) : "—"}
                  tone={breached ? "font-semibold text-rose-600 dark:text-rose-400" : ""}
                  title={data.sla ? `Phản hồi đầu hạn ${formatDateTime(data.sla.firstResponseDueAt)} · đóng hạn ${formatDateTime(data.sla.resolveDueAt)}` : undefined}
                />
                <Fact
                  label="Trạng thái xử lý"
                  value={CARE_STATUS_LABEL[data.care.status as CareStatus]}
                  tone={cn("rounded px-1", CARE_STATUS_TONE[data.care.status as CareStatus])}
                  title="Đội đang ở đâu với việc của mình. KHÔNG phải trạng thái gói hàng."
                />
                <div className="col-span-2 flex items-center gap-1.5 sm:col-span-3">
                  <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Phụ trách</span>
                  <select
                    value={data.care.owner?.id ?? ""}
                    disabled={pending || !ws.canManage}
                    onChange={(e) => doOwner(e.target.value)}
                    className="h-7 max-w-[180px] rounded-md border bg-background px-1.5 text-[11.5px] disabled:opacity-60"
                    aria-label="Người phụ trách ca"
                  >
                    <option value="">Chưa ai nhận</option>
                    {ws.staff.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                  {/* HẸN XEM LẠI — cùng bộ nút và cùng phép tính với dòng ngoài bảng. */}
                  {data.care.followUpAt ? (
                    <button
                      type="button"
                      disabled={pending || !ws.canManage}
                      onClick={() => doFollowUp(null)}
                      title={`Xem lại lúc ${formatDateTime(data.care.followUpAt)} — bấm để bỏ hẹn`}
                      className={cn("text-[11.5px] hover:underline disabled:no-underline disabled:opacity-60", data.care.followUpAt.getTime() <= Date.now() && "font-semibold text-rose-600 dark:text-rose-400")}
                    >
                      · hẹn {formatDateTime(data.care.followUpAt)}
                    </button>
                  ) : ws.canManage ? (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Hẹn lại</span>
                      {FOLLOW_UP_PRESETS.map((pre) => (
                        <button
                          key={pre.key}
                          type="button"
                          disabled={pending}
                          onClick={() => doFollowUp(followUpPresetAt(pre))}
                          className="rounded border px-1 py-px text-[10.5px] hover:bg-accent disabled:opacity-50"
                        >
                          {pre.label}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* ───── THAO TÁC VIETTELPOST — HÀNH ĐỘNG KHÁC, ĐIỀU KIỆN KHÁC ─────

                   Khối này GỬI THẬT một lệnh sang ĐVVC, nên nó ĐƯỢC PHÉP khoá: kiện đã kết thúc,
                   chưa có mã vận đơn, ERP chưa khai tài khoản API — mỗi lý do hiện nguyên văn trong
                   tooltip. Khoá ở đây KHÔNG ảnh hưởng gì tới ba nút kết quả care bên trên, và đó
                   chính là điều bản 19/09/2026 sinh ra để sửa. */}
              {ws.canManage ? (
                <div className="rounded-xl border p-3">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-semibold uppercase tracking-wide">Thao tác Viettel Post</span>
                    <span className={cn("rounded px-1 text-[10.5px] font-medium", data.shipment.trackingCapability === "API_TRACKABLE" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300")}>
                      {data.shipment.trackingCapability === "API_TRACKABLE" ? "gửi thẳng API" : "phải làm tay"}
                    </span>
                  </div>
                  <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                    Gửi một yêu cầu THẬT sang đơn vị vận chuyển. Lệnh được ĐVVC <b>nhận</b> không có nghĩa hàng đã đi tiếp — chỉ sự kiện hành trình mới xác nhận. Khối này khoá được; ba nút kết quả care ở trên thì không.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(["redeliver", "approve-return"] as CarrierActionKey[]).map((k) => {
                      const e = carrierEligibility(k);
                      return (
                        <button
                          key={k}
                          type="button"
                          disabled={pending || !e.ok}
                          title={e.reason}
                          onClick={() => setConfirmCarrier(k)}
                          className="rounded-md border px-2.5 py-1.5 text-[12px] font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          {k === "redeliver" ? "Yêu cầu phát lại trên VTP" : "Duyệt hoàn trên VTP"}
                          {e.ok && !e.callsApi ? <span className="ml-1 text-[10.5px] text-amber-700 dark:text-amber-300">(làm tay, ERP ghi vết)</span> : null}
                        </button>
                      );
                    })}
                    {vtpUrl ? (
                      <a href={vtpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[12px] hover:bg-accent">
                        <ExternalLink className="size-3.5" /> Mở trên viettelpost.vn
                      </a>
                    ) : null}
                  </div>
                  {/* XÁC NHẬN TRƯỚC KHI GỬI: nói rõ lệnh này đi RA NGOÀI ERP, và nói rõ nó KHÔNG
                      phải kết quả care — hai thứ dễ lẫn nhất đúng ở màn hình này. */}
                  {confirmCarrier ? (
                    <div className="mt-2 rounded-lg border border-amber-300/70 bg-amber-50/60 px-2.5 py-2 text-[11.5px] dark:border-amber-900/60 dark:bg-amber-950/20">
                      <p className="font-semibold">Gửi “{confirmCarrier === "redeliver" ? "Yêu cầu phát lại" : "Duyệt hoàn"}” lên Viettel Post?</p>
                      <p className="mt-0.5 text-muted-foreground">
                        Đây là lệnh đi RA NGOÀI ERP{data.shipment.trackingCapability === "API_TRACKABLE" ? " và sẽ được gửi thẳng qua API" : " — tài khoản API không sở hữu kiện này nên ERP sẽ ghi là PHẢI LÀM TAY, kèm đường dẫn"}. Nó KHÔNG phải kết quả care và KHÔNG thay cho ba nút ở trên.
                      </p>
                      <div className="mt-1.5 flex gap-1.5">
                        <button type="button" disabled={pending} onClick={() => doCarrier(confirmCarrier)} className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 font-medium hover:bg-accent disabled:opacity-50">
                          {pending ? <Loader2 className="size-3 animate-spin" /> : null} Gửi
                        </button>
                        <button type="button" disabled={pending} onClick={() => setConfirmCarrier(null)} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent">
                          Huỷ
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {/* Lệnh gần nhất và ĐVVC trả lời gì — không có dòng này thì "vì sao 400" không tra lại được. */}
                  {data.carrierRequests.length ? (
                    <p className="mt-2 text-[11.5px]">
                      <span className={cn("rounded px-1.5 py-px text-[10.5px] font-medium", CARRIER_REQUEST_TONE[data.carrierRequests[0].status as CarrierRequestStatus])}>
                        {CARRIER_ACTION_LABEL[data.carrierRequests[0].actionKey]}: {CARRIER_REQUEST_LABEL[data.carrierRequests[0].status as CarrierRequestStatus]}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {data.carrierRequests[0].actor || "không rõ người"} · {formatDateTime(data.carrierRequests[0].at)}
                        {data.carrierRequests[0].error ? ` · ${data.carrierRequests[0].error}` : ""}
                      </span>
                    </p>
                  ) : null}
                </div>
              ) : null}

              {data.shipment.receiver.address ? <p className="text-[12px] leading-snug text-muted-foreground">{data.shipment.receiver.address}</p> : null}

              {/* ───── Khách này đã mua bao nhiêu lần: đổi hẳn cách nói chuyện ───── */}
              {data.customer.history ? (
                <div className="rounded-lg border bg-muted/30 px-3 py-2 text-[12px]" title="Đếm theo số điện thoại — một người nhắn từ hai trang Pancake vẫn là một khách.">
                  <b>Khách cũ:</b> {formatNumber(data.customer.history.totalOrders)} đơn · giao thành công {formatNumber(data.customer.history.delivered)} · hoàn {formatNumber(data.customer.history.returned)}
                </div>
              ) : null}

              {data.order?.items.length ? (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Khách đặt gì</div>
                  <ul className="space-y-0.5 text-[12.5px]">
                    {data.order.items.map((it, idx) => (
                      <li key={idx} className="flex justify-between gap-3">
                        <span>
                          {it.name}
                          {/*
                            MỘT DÒNG "1 × 0 ₫" KHÔNG TỰ NÓI NÓ LÀ GÌ, và hai khả năng đòi hai việc
                            khác hẳn: hàng tặng (đúng rồi, đừng đụng vào) hay mẫu chưa ai điền giá
                            (phải đi sửa đơn). `is_bonus` là lời khai của chính Pancake — đọc nó,
                            không suy từ "giá bằng 0".
                          */}
                          {it.isBonus ? <span className="ml-1 rounded bg-emerald-100 px-1 text-[10px] font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">quà tặng</span> : null}
                          {!it.isBonus && it.price === 0 ? (
                            <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-300" title="Đơn không khai giá cho dòng này và cũng không đánh dấu là hàng tặng. ERP không đoán giá — kiểm lại trên Pancake.">
                              chưa có giá
                            </span>
                          ) : null}
                        </span>
                        <span className="numeric shrink-0 text-muted-foreground">
                          {formatNumber(it.qty)} × {formatVND(it.price)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {data.order.itemsTruncated ? <p className="mt-0.5 text-[11px] text-muted-foreground">Đơn còn mặt hàng khác — danh sách đang cắt bớt. Mở đơn để xem đủ.</p> : null}
                  <CodBreakdown order={data.order} codAmount={data.shipment.codAmount} />
                </div>
              ) : null}

              {/* ───── Hành trình ĐVVC: CHỨNG TỪ, chỉ đọc ───── */}
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">ĐVVC nói gì</span>
                  <span className="text-[10.5px] text-muted-foreground">chứng từ Viettel Post · không thao tác nào của đội sửa được dòng nào ở đây</span>
                </div>
                {data.journey.length ? (
                  <ul className="space-y-1.5 border-l pl-3 text-[12px]">
                    {data.journey.map((t, idx) => {
                      const buuTa = parseCourier(`${t.status} ${t.note}`);
                      return (
                        <li key={idx} className="relative">
                          <span className="absolute -left-[15px] top-1.5 size-1.5 rounded-full bg-border" />
                          <div className={cn("font-medium", journeyTone(t.status))}>{t.status}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {formatDateTime(t.at)}
                            {t.location ? ` · ${t.location}` : ""} · <span className="rounded bg-muted px-1">{t.source}</span>
                          </div>
                          {buuTa ? (
                            <div className="text-[11.5px]">
                              Bưu tá {buuTa.name} ·{" "}
                              <a href={`tel:${buuTa.phone}`} className="text-primary hover:underline">
                                {buuTa.phone}
                              </a>
                            </div>
                          ) : null}
                          {t.note && t.note !== t.status ? <div className="text-[11.5px] leading-snug text-muted-foreground">{t.note}</div> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  /* Không có mốc nào là một THÔNG TIN, không phải một ô trống: kiện này ERP chưa từng nhận tin gì. */
                  <p className="text-[12px] text-muted-foreground">Chưa nhận được sự kiện nào từ ĐVVC cho kiện này — đây là lỗ hổng dữ liệu, không phải kiện đang yên ổn.</p>
                )}
              </div>

              {/* ───── Ghi lại việc vừa làm (đo hiệu quả chăm sóc) ───── */}
              <div className="rounded-xl border p-3">
                <div className="text-[12px] font-semibold" title="ERP không tự nhắn khách. Ghi ở đây để đo được việc chăm có cứu được đơn hay không — đo từ hôm nay, không dựng lại quá khứ.">
                  Ghi lại việc vừa làm
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {CARE_ACTION_KINDS.map((k) => (
                    <button key={k} type="button" onClick={() => setKind(k)} className={cn("rounded-lg border px-2 py-1 text-[11.5px]", kind === k ? "border-primary bg-primary/10 font-semibold" : "hover:bg-accent")}>
                      {CARE_ACTION_LABEL[k]}
                    </button>
                  ))}
                </div>
                <Textarea ref={noteRef} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Khách nói gì? (không bắt buộc · phím N để nhảy vào ô này)" className="mt-2 min-h-[60px] text-[12.5px]" />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => ghi(false)} disabled={pending}>
                    {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Ghi nhận{autoNext && tiep ? " · kiện tiếp" : ""}
                  </Button>
                  {current.caseId ? (
                    <Button size="sm" variant="outline" onClick={() => ghi(true)} disabled={pending} title="Ghi nhận việc chăm và đóng việc này trong hàng đợi Cần xử lý">
                      Ghi nhận & đóng việc
                    </Button>
                  ) : null}
                  {msg ? <span className="text-[12px] text-muted-foreground">{msg}</span> : null}
                </div>
              </div>

              {/* ───── Nhật ký xử lý: ai · lúc nào · đã quyết gì · note gì ───── */}
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Nhật ký xử lý</span>
                  <span className="text-[10.5px] text-muted-foreground">chỉ thêm — không thao tác nào sửa hay xoá được một dòng đã ghi</span>
                </div>
                {log.length ? (
                  <ul className="space-y-1.5 text-[12px]">
                    {log.map((r, idx) => (
                      <li key={idx} className="flex gap-2">
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={formatDateTime(r.at)}>
                          {formatTimeAgo(r.at)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <b className={cn("font-medium", r.kind === "DECISION" && "text-foreground")}>{r.title}</b>
                          {r.detail ? <span className="text-muted-foreground"> · {r.detail}</span> : null}
                          <span className="text-[11px] text-muted-foreground"> — {r.actor}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] text-muted-foreground">Chưa ai chạm vào ca này.</p>
                )}
              </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * ═══════════ COD KHÁC TỔNG SẢN PHẨM THÌ PHẢI NÓI RA PHÉP CỘNG, KHÔNG ĐỂ NGƯỜI ĐỌC ĐOÁN ═══════════
 *
 * Quan sát 19/09/2026: panel in "sản phẩm 998.000" ngay cạnh "COD 749.000" và không một dòng nào
 * giải thích khoảng chênh. Người trực chỉ có ba cách đọc, và cả ba đều dẫn tới một cuộc gọi: khách
 * được giảm giá? khách đã trả trước? hay ai đó gõ sai COD? Con số đúng mà không có phép cộng bên
 * cạnh thì vẫn là con số không dùng được.
 *
 * ─── ERP KHÔNG SỬA GÌ, CHỈ BÀY RA ───
 *
 * Bốn cột dưới đây đến thẳng từ Pancake (`orders`). ERP không tính lại, không làm tròn, không sửa
 * giá và không sửa đơn — nó chỉ xếp chúng thành phép cộng mà người đọc tự kiểm được:
 *
 *     Tạm tính − Giảm giá + Phí ship (khách trả) = Tổng đơn
 *     Tổng đơn − Đã trả trước               = COD dự kiến   ←→ so với COD trên vận đơn
 *
 * ─── VÀ KHI KHÔNG KHỚP THÌ NÓI THẲNG LÀ KHÔNG KHỚP ───
 *
 * Chênh lệch có thể là điều chỉnh tay trên Viettel Post, một lần sửa đơn sau khi tạo vận đơn, hay
 * một lỗi thật. ERP KHÔNG đoán cái nào — nó chỉ nói "COD khác tổng đơn N ₫" và để người có chứng
 * từ quyết. Ép ra một con số "đúng" ở đây là bịa một khoản mà không chứng từ nào đỡ.
 *
 * Cột nào Pancake không trả (`null`) thì BỎ khỏi phép cộng và nói là chưa biết — điền 0 vào đó là
 * khẳng định "shop không giảm giá đồng nào", một điều chưa ai chứng minh (luật 42).
 */
function CodBreakdown({
  order,
  codAmount,
}: {
  order: NonNullable<CareWorkspace["detail"]>["order"];
  codAmount: number;
}) {
  if (!order) return null;
  const { subtotal, discount, shippingFee, total, prepaid } = order;
  // Không có cột nào để dựng phép cộng ⇒ không vẽ một bảng rỗng.
  if (subtotal === null && discount === null && shippingFee === null && !total && !prepaid) return null;

  const codDuKien = total - prepaid;
  const lech = codAmount - codDuKien;
  const thieuCot = subtotal === null || discount === null || shippingFee === null;

  const dong = (nhan: string, gia: number | null, dau?: string, mo?: boolean) => (
    <div className={cn("flex justify-between gap-3", mo && "text-muted-foreground")}>
      <span>
        {dau ? <span className="mr-0.5">{dau}</span> : null}
        {nhan}
      </span>
      <span className="numeric shrink-0">{gia === null ? "—" : formatVND(gia)}</span>
    </div>
  );

  return (
    <div className="mt-2 space-y-0.5 rounded-lg border bg-muted/20 px-2.5 py-2 text-[11.5px]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">COD được cộng ra sao</div>
      {dong("Tạm tính (tiền hàng)", subtotal, "", true)}
      {dong("Giảm giá", discount, "−", true)}
      {dong("Phí ship khách trả", shippingFee, "+", true)}
      <div className="flex justify-between gap-3 border-t pt-0.5 font-medium">
        <span>Tổng đơn</span>
        <span className="numeric shrink-0">{formatVND(total)}</span>
      </div>
      {prepaid ? dong("Đã trả trước", prepaid, "−", true) : null}
      <div className="flex justify-between gap-3 border-t pt-0.5 font-semibold">
        <span>COD trên vận đơn</span>
        <span className="numeric shrink-0">{formatVND(codAmount)}</span>
      </div>
      {lech !== 0 ? (
        <p className="mt-1 rounded border border-amber-300/60 bg-amber-50/60 px-1.5 py-1 text-[10.5px] leading-snug text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200">
          <b>COD khác tổng đơn {formatVND(Math.abs(lech))}</b> ({lech > 0 ? "vận đơn thu nhiều hơn" : "vận đơn thu ít hơn"} số đơn đang ghi). ERP không sửa hộ:
          kiểm lại đơn trên Pancake và vận đơn trên Viettel Post rồi sửa ở nguồn.
        </p>
      ) : null}
      {thieuCot ? <p className="mt-1 text-[10.5px] text-muted-foreground">Dấu “—” là Pancake chưa trả cột đó cho đơn này — chưa biết, không phải bằng 0.</p> : null}
    </div>
  );
}

function Fact({ label, value, tone, title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div title={title}>
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("font-medium", tone)}>{value}</div>
    </div>
  );
}

/**
 * ───────────── MỘT PANEL CHO CẢ DANH SÁCH ─────────────
 *
 * Panel đặt TRONG từng dòng thì sống chết theo dòng: bấm "Ghi nhận & đóng việc" là việc biến khỏi
 * hàng đợi, dòng bị gỡ, panel đóng sập giữa chừng và không sang được kiện kế. Vì thế panel đứng
 * NGOÀI danh sách (host), còn mỗi dòng chỉ là một nút phát tín hiệu "mở kiện này". Danh sách dựng
 * lại bao nhiêu lần thì host vẫn đứng nguyên.
 */
const CARE_OPEN_EVENT = "erp:care-open";

/**
 * ═══════════ PANEL BÁO CHO BẢNG, KHÔNG BẮT CẢ TRANG DỰNG LẠI ═══════════
 *
 * Bản trước gọi `router.refresh()` sau MỖI lần ghi để dòng ngoài bảng đổi theo panel. Nó đúng về
 * kết quả nhưng đắt: mỗi cú bấm kéo máy chủ dựng lại TOÀN BỘ hàng đợi care (và `clearMemo()` vừa
 * xoá đệm nên không có đường tắt nào) — với người xử lý vài chục kiện một buổi thì đó là vài chục
 * lượt dựng lại cho một thay đổi chạm đúng MỘT dòng.
 *
 * Panel phát một tín hiệu mang theo `CareState` mà MÁY CHỦ VỪA TRẢ VỀ; bảng nghe và vá đúng dòng
 * đó. Dữ liệu vẫn là dữ liệu máy chủ (không phải thứ màn hình tự đoán), nhưng không có lượt đi-về
 * thứ hai. `Date` đi qua `CustomEvent` trong cùng một tiến trình nên vẫn là `Date`.
 */
const CARE_UPDATED_EVENT = "erp:care-updated";
export type CareUpdatedDetail = { shipmentId: string; care: CareState };

function phatCapNhat(shipmentId: string, care: CareState) {
  window.dispatchEvent(new CustomEvent<CareUpdatedDetail>(CARE_UPDATED_EVENT, { detail: { shipmentId, care } }));
}

/** Bảng đăng ký nghe tín hiệu cập nhật từ panel. Trả về hàm huỷ đăng ký. */
export function onCareUpdated(fn: (d: CareUpdatedDetail) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<CareUpdatedDetail>).detail);
  window.addEventListener(CARE_UPDATED_EVENT, h);
  return () => window.removeEventListener(CARE_UPDATED_EVENT, h);
}

export function CareDrawerHost({ queue }: { queue: CareQueueItem[] }) {
  const [item, setItem] = useState<CareQueueItem | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => setItem((e as CustomEvent<CareQueueItem>).detail);
    window.addEventListener(CARE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CARE_OPEN_EVENT, onOpen);
  }, []);
  if (!item) return null;
  // `key` theo kiện MỞ BAN ĐẦU: đi tiếp trong danh sách đổi trạng thái bên trong, không đổi key.
  return <CareDrawer key={item.shipmentId} shipmentId={item.shipmentId} caseId={item.caseId ?? null} queue={queue} open onOpenChange={(v) => !v && setItem(null)} />;
}

/** Nút mở panel dùng chung (host) — đặt được trong bất kỳ dòng nào, kể cả trong server component. */
export function CareOpenButton({ shipmentId, caseId = null, className, children }: { shipmentId: string; caseId?: string | null; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent<CareQueueItem>(CARE_OPEN_EVENT, { detail: { shipmentId, caseId } }))}
      className={cn("text-left hover:underline", className)}
    >
      {children}
    </button>
  );
}
