import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { SendCard } from "@/app/(dashboard)/ai/copilot/send-card";
import { SALES_ACTION_LABEL, SALES_STAGE_LABEL, HANDOFF_REASON_LABEL, type HandoffReason, type SalesAction, type SalesStage } from "@/lib/constants/sales-agent";
import { AGENT_MODE_LABEL, ROUTE_TIER_LABEL, modeAtLeast, type RouteTier } from "@/lib/constants/ai";
import { COPILOT_REJECT_LABEL, COPILOT_WARNING_LABEL, type CopilotRejectReason } from "@/lib/constants/sales-copilot";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { getAgent } from "@/lib/ai-workforce/registry";
import { requirePermission } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { copilotKpi, copilotPages, copilotQueue, firstHumanSend, ingestStatus, pilotStatus } from "@/lib/queries/sales-copilot";
import { LIVE_INGEST_HEALTH_LABEL } from "@/lib/constants/live-ingest";
import { AutoRefresh } from "@/app/(dashboard)/ai/copilot/auto-refresh";

export const metadata = { title: "Hàng đợi trợ lý AI" };

/**
 * HÀNG ĐỢI NẤC TRỢ LÝ — máy soạn, người bấm gửi.
 *
 * Màn hình này là nơi DUY NHẤT một câu do AI soạn tới được khách, và nó nói thẳng ra điều đó ở
 * đầu trang: nấc quyền hạn đang là gì, hai công tắc chặn cứng đang đóng hay mở, page nào được thí
 * điểm. Một người mở màn hình này phải biết ngay mình đang ở chế độ nào — chứ không phải bấm gửi
 * rồi mới biết tin không đi (hoặc tệ hơn: tưởng không đi mà lại đi).
 */
export default async function CopilotPage() {
  /*
    QUYỀN CỦA MÀN HÌNH NÀY LÀ `ai:send`, KHÔNG PHẢI `ai:view`.

    `ai:view` là quyền QUAN SÁT nhân sự AI (lượt chạy, chi phí, chấm tay) và trưởng nhóm có nó.
    Hàng đợi trợ lý thì khác hẳn: nó bày hội thoại THẬT của khách đang chờ, và cả năm nút trên thẻ
    đều đòi `ai:send`. Mở nó cho người chỉ có `ai:view` là lộ dữ liệu khách cho một người không
    thao tác được gì — vừa thừa quyền đọc, vừa vô ích cho chính họ.

    Khai ở ĐÂY chứ không chỉ ở thanh bên: giấu một mục menu không phải là chặn một đường dẫn.
  */
  await requirePermission("ai:send");
  const [user, settings, pages] = await Promise.all([getCurrentUser(), getAiSettings(), copilotPages()]);
  const agent = await getAgent("sales", settings);
  const mode = agent?.mode ?? "OFF";
  const sanSang = modeAtLeast(mode, "COPILOT") && settings.hardLimits.allowHumanApprovedSend && pages.length > 0;
  // Hội thoại người khác đang cầm KHÔNG hiện ở đây — trừ hội thoại của chính người đang xem,
  // để họ còn nút trả lại cho máy.
  const [queue, kpi, nap, lanDau, pilot] = await Promise.all([
    copilotQueue({ limit: 40, heldByUserId: user?.id ?? null }),
    copilotKpi(7),
    ingestStatus(),
    firstHumanSend(),
    pilotStatus(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title="Hàng đợi trợ lý AI" description="Máy soạn — nhân viên đọc, sửa nếu cần, rồi bấm gửi. Không có đường nào cho máy tự gửi." />

      {/*
        SÁU BƯỚC, IN NGAY TRÊN ĐẦU MÀN HÌNH.

        Người trực chat không đọc tài liệu bàn giao, và một buổi tập huấn thì phai sau vài ngày.
        Thứ còn lại là cái họ nhìn thấy mỗi lần mở màn hình. Chữ trên nút được viết Y HỆT nút thật
        ("Gửi nguyên văn", "Sửa & gửi", "Từ chối", "Tự nhận việc") — một bản hướng dẫn gọi tên khác
        với nút trước mắt là một bản hướng dẫn khiến người ta bấm nhầm.

        Hai câu cuối không phải khẩu hiệu: chúng là điều màn hình này phải nói mỗi ngày, vì người
        soát tin cần biết chắc rằng KHÔNG có đường nào để máy tự đi trước họ.
      */}
      <Card className="border-sky-500/60 bg-sky-50/70 p-3 dark:border-sky-400/40 dark:bg-sky-950/30">
        <p className="text-xs font-semibold uppercase tracking-wide">Thí điểm trợ lý — sáu bước</p>
        <ol className="mt-1 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <li>1. Đọc tin khách</li>
          <li>2. Kiểm câu máy soạn</li>
          <li>
            3. Đúng rồi → <strong>Gửi nguyên văn</strong>
          </li>
          <li>
            4. Cần sửa → <strong>Sửa &amp; gửi</strong>
          </li>
          <li>
            5. Sai → <strong>Từ chối</strong>
          </li>
          <li>
            6. Ca phải người xử lý hẳn → <strong>Tự nhận việc</strong>
          </li>
        </ol>
        <p className="mt-1.5 text-xs font-semibold text-rose-700 dark:text-rose-300">
          AI KHÔNG TỰ GỬI TIN. AI KHÔNG TỰ TẠO ĐƠN. Mọi tin tới khách đều do một nhân viên bấm.
        </p>
      </Card>

      {/*
        MỘT DÒNG TRẢ LỜI "HỆ THỐNG CÓ ĐANG SỐNG KHÔNG".

        Nhân viên trực chat không mở log. Nếu bộ nạp chết lúc 10 giờ mà màn hình vẫn im lặng thì
        tới trưa họ mới thấy lạ vì "hôm nay ít khách" — và lúc đó đã mất hai tiếng.

        Con số quyết định là VÒNG CHẠY ĐƯỢC gần nhất, không phải vòng gần nhất: một bộ nạp hỏng
        liên tục vẫn chạy đều đặn.
      */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-semibold">Nạp tin sống</span>
          <AutoRefresh seconds={20} />
        </div>
        {nap.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Chưa khai page thí điểm nào, nên không có gì để đọc. Khai ở <code>settings.ai.copilotPages</code> (thao tác ops <code>ai-staging-copilot</code>) trước khi bật bộ nạp.
          </p>
        ) : (
          nap.map((n) => (
            <div key={n.pageId} className={`mt-2 rounded border p-2 ${n.health === "LIVE" ? "" : n.health === "OFF" ? "border-amber-500/60" : "border-rose-500/60"}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-mono text-[11px]">{n.pageId}</span>
                <span
                  className={`font-semibold ${n.health === "LIVE" ? "text-emerald-700 dark:text-emerald-300" : n.health === "OFF" ? "text-amber-700 dark:text-amber-300" : "text-rose-700 dark:text-rose-300"}`}
                >
                  {LIVE_INGEST_HEALTH_LABEL[n.health]}
                </span>
                <span className="text-muted-foreground">vòng chạy được gần nhất: {n.lastOkAt ? formatDateTime(n.lastOkAt) : "chưa có"}</span>
                <span className="text-muted-foreground">tin khách mới nhất: {n.lastCustomerMessageAt ? formatDateTime(n.lastCustomerMessageAt) : "chưa có"}</span>
                <span className="text-muted-foreground">đã nạp: {formatNumber(n.messagesIngested)} tin</span>
                <span className="text-muted-foreground">hàng đợi: {formatNumber(queue.length)}</span>
              </div>
              {/*
                HAI CHUYỆN KHÁC NHAU, HAI CÁCH NÓI. "Hỏng 3 vòng liền" là mất kết nối — đi xem ngay.
                "Lỗi lẻ ở vòng vừa rồi" là một hội thoại cần xem bằng mắt trong khi phần còn lại vẫn
                chạy. Gộp một màu đỏ thì người trực hoặc hoảng thừa, hoặc quen mắt rồi bỏ qua cả hai.
              */}
              {n.lastError ? (
                <p className={`mt-1 text-[11px] ${n.consecutiveErrors > 0 ? "text-rose-700 dark:text-rose-300" : "text-amber-700 dark:text-amber-300"}`}>
                  {n.consecutiveErrors > 0 ? `hỏng ${formatNumber(n.consecutiveErrors)} vòng liền: ` : "lỗi lẻ ở vòng vừa rồi (các hội thoại khác vẫn nạp): "}
                  {n.lastError}
                </p>
              ) : null}
            </div>
          ))
        )}
      </Card>

      {/* TRẠNG THÁI CỔNG — đọc từ đúng nơi cổng gửi đọc, không phải một bản mô tả chép tay. */}
      <Card className="p-3">
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Nấc quyền hạn</p>
            <p className="font-semibold">{AGENT_MODE_LABEL[mode]}</p>
          </div>
          <div>
            <p className="text-muted-foreground">MÁY tự gửi</p>
            <p className={settings.hardLimits.allowAutoSend ? "font-semibold text-rose-600 dark:text-rose-400" : "font-semibold text-emerald-700 dark:text-emerald-300"}>
              {settings.hardLimits.allowAutoSend ? "⛔ ĐANG MỞ" : "CẤM"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">NHÂN VIÊN bấm gửi</p>
            <p className="font-semibold">{settings.hardLimits.allowHumanApprovedSend ? "được phép" : "CẤM (chưa mở công tắc)"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Page thí điểm</p>
            <p className="font-semibold">{pages.length ? pages.join(", ") : "chưa khai — không page nào gửi được"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Tạo đơn</p>
            <p className={settings.hardLimits.allowOrderCreate ? "font-semibold text-rose-600 dark:text-rose-400" : "font-semibold text-emerald-700 dark:text-emerald-300"}>
              {settings.hardLimits.allowOrderCreate ? "⛔ ĐANG MỞ" : "CẤM"}
            </p>
          </div>
          {/*
            LẦN GỬI ĐẦU TIÊN DO NGƯỜI BẤM — đọc từ SỔ THAO TÁC, không từ một cờ ai đó đặt tay.
            Một cờ thì sai được; một phép đếm trên chính bảng ghi vết thì không.
          */}
          <div>
            <p className="text-muted-foreground">Lần gửi đầu do người bấm</p>
            <p className="font-semibold">
              {lanDau.verified
                ? `ĐÃ XÁC MINH · ${lanDau.at ? formatDateTime(lanDau.at) : "—"}${lanDau.actorName ? ` · ${lanDau.actorName}` : ""}`
                : "CHƯA CÓ — chờ nhân viên bấm lần đầu"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Tin đã rời khỏi ERP</p>
            <p className="font-semibold">{formatNumber(lanDau.sentCount)}</p>
          </div>
        </div>
        {!sanSang ? (
          <p className="mt-2 rounded bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            Cổng gửi đang ĐÓNG. Câu máy soạn vẫn hiện ra để đọc và chấm, nhưng bấm Gửi sẽ bị từ chối kèm lý do. Cần đủ ba
            điều: nấc TRỢ LÝ trở lên · <code>AI_ALLOW_HUMAN_APPROVED_SEND=true</code> · page có tên trong{" "}
            <code>ai.copilotPages</code>.
          </p>
        ) : null}
      </Card>

      {/* CHỈ SỐ — mẫu số rỗng thì in dấu gạch, không in 0%. */}
      <Card className="p-3">
        <div className="grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Gợi ý đã soạn (7 ngày)" value={formatNumber(kpi.suggestions)} />
          <Stat label="Gửi nguyên văn" value={formatNumber(kpi.sentUnchanged)} />
          <Stat label="Sửa rồi gửi" value={formatNumber(kpi.editedSent)} />
          <Stat label="Từ chối" value={formatNumber(kpi.rejected)} />
          <Stat label="Tỷ lệ dùng được" value={kpi.acceptanceRate === null ? "—" : `${kpi.acceptanceRate}%`} />
          <Stat label="Thời gian soát (trung vị)" value={kpi.medianReviewSeconds === null ? "—" : `${kpi.medianReviewSeconds}s`} />
        </div>
        {/*
          LẦN GỬI ĐẦU TIÊN DO NGƯỜI BẤM là phép thử đầu-cuối trên khách thật. Chưa có nghĩa là CHƯA
          CHỨNG MINH — trạng thái hợp lệ để bắt đầu, nhưng phải in ra chứ không im lặng.
        */}
        <p className={`mt-2 rounded p-2 text-[11px] ${kpi.firstHumanSend.pending ? "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200" : kpi.firstHumanSend.verified === true ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" : "bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200"}`}>
          {kpi.firstHumanSend.pending ? (
            <>
              <strong>CHỜ LẦN GỬI ĐẦU TIÊN.</strong> Chưa nhân viên nào bấm Gửi, nên phép thử đầu-cuối trên khách thật chưa
              chạy. Lần đầu có người bấm, hệ thống sẽ tự đọc lại hội thoại từ Pancake và đếm xem tin ấy có mặt đúng một lần.
            </>
          ) : (
            <>
              <strong>Lần gửi đầu tiên:</strong> {kpi.firstHumanSend.at ? formatDateTime(kpi.firstHumanSend.at) : "—"} ·{" "}
              {kpi.firstHumanSend.by || "—"} · kiểm lại:{" "}
              {kpi.firstHumanSend.verified === true ? "ĐẠT (đúng một bản)" : kpi.firstHumanSend.verified === false ? "⛔ KHÔNG ĐẠT" : "chưa kiểm được"}
              {kpi.firstHumanSend.note ? ` · ${kpi.firstHumanSend.note}` : ""}
            </>
          )}
        </p>
        {kpi.duplicateSends > 0 ? (
          <p className="mt-1 rounded bg-rose-50 p-2 text-[11px] font-semibold text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
            ⛔ {formatNumber(kpi.duplicateSends)} lần gửi đọc lại thấy NHIỀU HƠN MỘT bản — dừng thí điểm và kiểm tra Pancake.
          </p>
        ) : null}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Tin THẬT SỰ đã rời khỏi ERP: <strong>{formatNumber(kpi.actuallySent)}</strong>
          {kpi.sentWithWarnings ? ` · ${formatNumber(kpi.sentWithWarnings)} lần người bấm gửi trong lúc hệ thống báo thiếu dữ liệu` : ""}
          {kpi.failedSends ? ` · ${formatNumber(kpi.failedSends)} lượt gửi hỏng` : ""} · đọc từ sổ thao tác, không suy từ cờ nào.
          {kpi.rejectReasons.length ? ` · Lý do từ chối nhiều nhất: ${kpi.rejectReasons.slice(0, 3).map((r) => `${COPILOT_REJECT_LABEL[r.reason as CopilotRejectReason] ?? r.reason} (${r.n})`).join(" · ")}` : ""}
        </p>
      </Card>

      {/*
        ═══════════ BẢNG ĐIỂM THÍ ĐIỂM — ĐỌC ĐƯỢC MÀ KHÔNG PHẢI GÕ MỘT CÂU SQL NÀO ═══════════

        Suốt giai đoạn dựng, mọi con số của đợt thí điểm chỉ có khi ai đó mở ops chạy truy vấn tay.
        Một chỉ số chỉ đọc được bằng dòng lệnh là một chỉ số KHÔNG AI ĐỌC: chủ shop không mở ops,
        nhân viên trực chat lại càng không. Cho nên nó phải nằm ngay trên màn hình họ đang dùng.

        Mẫu số rỗng in dấu gạch, không in 0% — chưa ai bấm lần nào thì "tỷ lệ dùng được" CHƯA BIẾT,
        và 0% là một lời khẳng định khác hẳn (luật 42).
      */}
      <Card className="p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide">Tiến độ thí điểm</p>
          <p className="text-xs text-muted-foreground">
            lượt khách ĐÃ CÓ NGƯỜI SOÁT: <strong className="text-sm text-foreground">{formatNumber(pilot.reviewedTurns)}</strong> / {pilot.target.min}–
            {pilot.target.max}
          </p>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-muted">
          <div className="h-full bg-sky-600 dark:bg-sky-400" style={{ width: `${Math.min(100, Math.round((pilot.reviewedTurns / pilot.target.min) * 100))}%` }} />
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Một lượt = MỘT câu máy soạn được một người kết thúc (gửi · sửa rồi gửi · từ chối). Không tính tin hệ thống, tin bot,
          tin nhân viên, và không tính lượt khách chưa ai soát.
        </p>

        <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Gửi nguyên văn" value={ghepTyLe(pilot.decisions.sendUnchanged, pilot.rates.unchanged)} />
          <Stat label="Sửa &amp; gửi" value={ghepTyLe(pilot.decisions.editAndSend, pilot.rates.edit)} />
          <Stat label="Từ chối" value={ghepTyLe(pilot.decisions.reject, pilot.rates.reject)} />
          {/*
            NGƯỜI NHẬN HẲN VIỆC ĐỨNG CÙNG HÀNG — nhưng NHÃN MANG THEO ĐỘ MỊN.

            Chủ shop đọc bốn nút trên thẻ như bốn lựa chọn ngang nhau, nên giấu một trong bốn xuống
            một dòng chữ nhỏ là làm nó biến mất. Nhưng nó KHÔNG cùng mẫu số: một hội thoại có ba
            lượt soát vẫn chỉ là MỘT lần nhận việc, nên nó không có phần trăm đi kèm như ba ô kia và
            nhãn phải nói ra điều đó (luật 8.2: một con số, một độ mịn, viết rõ).
          */}
          <Stat label="Tự nhận việc (hội thoại)" value={formatNumber(pilot.conversations.takenOver)} />
          <Stat label="Tỷ lệ dùng được" value={pilot.rates.acceptance === null ? "—" : `${pilot.rates.acceptance}%`} />
          <Stat
            label="Thời gian soát"
            value={pilot.reviewSeconds.median === null ? "—" : `${pilot.reviewSeconds.median}s (TB ${pilot.reviewSeconds.avg ?? "—"}s)`}
          />
        </div>

        <p className="mt-2 text-[11px] text-muted-foreground">
          Hội thoại có người thao tác: <strong>{formatNumber(pilot.conversations.touched)}</strong> · trong đó người nhận hẳn việc:{" "}
          <strong>{formatNumber(pilot.conversations.takenOver)}</strong>
          {pilot.conversations.handoffRate === null ? "" : ` (${pilot.conversations.handoffRate}%)`} — hai số này đếm theo HỘI THOẠI, không
          cùng mẫu số với ba ô đầu.
        </p>

        {/*
          ĐƯỜNG MÔ HÌNH · TOKEN · ĐỘ TRỄ. Chi phí chưa khai đơn giá in "chưa khai giá", KHÔNG in 0đ:
          một mô hình chưa có bảng giá không phải một mô hình chạy miễn phí.
        */}
        <div className="mt-2 space-y-0.5 border-t border-border/60 pt-2 text-[11px]">
          <p className="font-semibold uppercase tracking-wide text-muted-foreground">Đường mô hình của chính các câu trong thí điểm</p>
          {pilot.route.length === 0 ? (
            <p className="text-muted-foreground">Chưa có lượt chạy nào gắn với page thí điểm.</p>
          ) : (
            pilot.route.map((r) => (
              <p key={r.tier}>
                <strong>{ROUTE_TIER_LABEL[r.tier as RouteTier] ?? r.tier}</strong>: {formatNumber(r.runs)} lượt · {formatNumber(r.inputTokens)} token vào ·{" "}
                {formatNumber(r.outputTokens)} token ra · độ trễ trung vị {r.medianLatencyMs === null ? "—" : `${formatNumber(r.medianLatencyMs)}ms`} · chi phí{" "}
                {r.costVnd === null ? `CHƯA BIẾT${r.unpricedRuns ? ` (${formatNumber(r.unpricedRuns)} lượt chưa khai giá)` : ""}` : formatVND(r.costVnd)}
              </p>
            ))
          )}
        </div>

        {/*
          HAI CỜ CHỦ SHOP HỎI ĐÍCH DANH, in đúng tên biến để đối chiếu được với báo cáo.
          Cả hai SUY RA từ sổ thao tác (`copilotKpi`), không phải hai giá trị ai đó đặt tay ở đâu đó.
        */}
        <p className="mt-2 border-t border-border/60 pt-2 text-[11px]">
          <code>FIRST_HUMAN_SEND_PENDING</code> = <strong>{kpi.firstHumanSend.pending ? "true" : "false"}</strong> ·{" "}
          <code>COPILOT_LIVE_SEND_VERIFIED</code> ={" "}
          <strong>{!kpi.firstHumanSend.pending && kpi.firstHumanSend.verified === true ? "true" : "false"}</strong>
          {kpi.firstHumanSend.pending ? " — chưa tin nào rời khỏi ERP" : ""}
        </p>
      </Card>

      {!pages.length ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Chưa khai page nào vào <code>ai.copilotPages</code> nên hàng đợi trống. Đây là mặc định an toàn: quên khai thì không
          ai nhắn được cho khách, chứ không phải mọi page cùng mở.
        </Card>
      ) : !queue.length ? (
        /*
          HÀNG ĐỢI RỖNG KHÔNG PHẢI MỘT LỖI — nhưng một màn hình trống thì trông y hệt một màn hình
          hỏng. Câu thứ hai là câu quan trọng: nó nói hệ thống VẪN ĐANG CANH, nên người trực không
          phải bấm tải lại để tự trấn an, và cũng không đi lục lịch sử để "tạo việc" cho đủ.
        */
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Hiện không có khách cần xử lý.
          <br />
          Hệ thống đang tự theo dõi tin nhắn mới.
        </Card>
      ) : null}

      {queue.map((row) => (
        <Card key={row.conversationId} className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {/*
              MÁY ĐÃ KÊU CỨU — nhãn đứng TRƯỚC mọi nhãn khác vì nó đổi cách đọc cả thẻ.

              Đây KHÔNG phải "đã có người cầm": khoá người vẫn rỗng. Máy đọc xong và tự nhận là
              mình không xử lý được, nên thẻ này cần một người NHẤT trong cả hàng đợi.
            */}
            {row.machineHandoff ? <Badge tone="hot">AI CẦN NGƯỜI XỬ LÝ</Badge> : null}
            {/* Bậc ưu tiên cao nhất của hàng đợi, nên nó phải nhìn thấy được ngay. */}
            {row.waitingForReply ? <Badge tone="hot">khách đang chờ</Badge> : null}
            <span className="font-semibold">{row.customerName || "(chưa có tên)"}</span>
            <Badge>{row.sourceType || "?"}</Badge>
            <Badge>{SALES_STAGE_LABEL[row.stage as SalesStage] ?? row.stage}</Badge>
            {row.productName ? <Badge>{row.productName}</Badge> : <Badge tone="warn">chưa nhận ra sản phẩm</Badge>}
            {row.waitedMinutes === null ? null : <Badge tone={row.waitedMinutes > 60 ? "hot" : undefined}>chờ {row.waitedMinutes} phút</Badge>}
            <span className="text-muted-foreground">page {row.pageId}</span>
            <Link href={`/ai/review?conversation=${row.conversationId}`} className="ml-auto text-muted-foreground underline">
              xem lượt chạy
            </Link>
          </div>

          {/*
            LÝ DO MÁY XIN NGƯỜI VÀO, viết ra thành câu.

            Một nhãn đỏ không nói người trực phải làm gì. Lý do thì có: thiếu bảng số đo là một
            việc khác hẳn với khách hỏi một chuyện phức tạp.
          */}
          {row.machineHandoff ? (
            <p className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100">
              <span className="font-semibold">Máy đã chuyển việc này cho người</span>
              {row.handoffRequestReason ? <> · lý do: {HANDOFF_REASON_LABEL[row.handoffRequestReason as HandoffReason] ?? row.handoffRequestReason}</> : null}
              {" "}— chưa ai nhận. Bấm <span className="font-semibold">Tự nhận việc</span> để ghi tên mình vào, hoặc trả lời ngay.
            </p>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Khách nhắn</p>
              <p className="whitespace-pre-wrap rounded bg-muted/60 p-2 text-sm">{row.customerMessage || "(không có nội dung)"}</p>
              <p className="text-[11px] text-muted-foreground">{row.customerMessageAt ? formatDateTime(row.customerMessageAt) : "—"}</p>
            </div>

            {/*
              DỮ KIỆN MÁY CHỦ ĐÃ DÙNG — hiện cạnh câu, không giấu sau một cú bấm.
              Người soát phải kiểm được câu chữ dựa trên cái gì, nếu không họ chỉ còn cách tin nó.
            */}
            <div className="space-y-1 text-[11px]">
              <p className="font-semibold uppercase tracking-wide text-muted-foreground">Máy hiểu &amp; căn cứ</p>
              <p>Ý định: {row.intents.length ? row.intents.join(", ") : "—"}</p>
              <p>Việc máy chọn: {SALES_ACTION_LABEL[row.action as SalesAction] ?? (row.action || "—")} · tin cậy {row.confidence === null ? "—" : row.confidence}</p>
              {row.decisionReason ? <p className="text-muted-foreground">{row.decisionReason}</p> : null}
              {row.missing.length ? <p>Còn thiếu để lên đơn: {row.missing.join(", ")}</p> : null}
              {row.handoffReason ? (
                <p className="font-semibold text-amber-700 dark:text-amber-300">
                  Chuyển người: {HANDOFF_REASON_LABEL[row.handoffReason as HandoffReason] ?? row.handoffReason}
                  {row.handoffReason === "SIZE_DATA_MISSING" ? " — ERP chưa có bảng số đo, máy KHÔNG đoán size" : ""}
                </p>
              ) : null}
              <EntityList entities={row.entities} />
              <FactList facts={row.facts} />
            </div>
          </div>

          {/*
            CẢNH BÁO ĐỨNG TRÊN Ô SOẠN, KHÔNG NẰM DƯỚI.

            Người trực đọc từ trên xuống rồi bấm. Một dòng "chưa có bảng số đo" đặt dưới nút Gửi là
            một dòng không ai đọc. Máy đã bị chặn không đoán; chỗ này để NGƯỜI biết mình đang bấm
            trong lúc thiếu gì — và hệ thống ghi lại việc đó.
          */}
          {row.warnings.length ? (
            <div className="space-y-0.5 rounded border border-amber-500/60 bg-amber-50 p-2 dark:bg-amber-950/40">
              {row.warnings.map((w) => (
                <p key={w} className="text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                  ⚠ {COPILOT_WARNING_LABEL[w] ?? w}
                </p>
              ))}
              <p className="text-[11px] text-amber-700 dark:text-amber-300">
                Chị/anh vẫn sửa tay rồi gửi được — hệ thống ghi lại là đã gửi trong lúc thiếu dữ kiện này.
              </p>
            </div>
          ) : null}

          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Máy soạn</p>
            <SendCard
              conversationId={row.conversationId}
              suggestionId={row.suggestionId}
              suggestedReply={row.suggestedReply}
              stale={row.stale}
              humanTakeover={Boolean(row.humanTakeoverAt)}
              canRelease={row.takeoverByUserId === user?.id}
            />
            <p className="text-[11px] text-muted-foreground">Máy soạn lúc {row.suggestedAt ? formatDateTime(row.suggestedAt) : "—"}</p>
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Số lượt kèm tỷ lệ. Mẫu số rỗng ⇒ chỉ in số, KHÔNG bịa ra "0%". */
function ghepTyLe(n: number, tyLe: number | null): string {
  return tyLe === null ? formatNumber(n) : `${formatNumber(n)} · ${tyLe}%`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="text-base font-semibold">{value}</p>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "warn" | "hot" }) {
  const cls =
    tone === "hot"
      ? "border-rose-500 bg-rose-50 font-semibold text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
      : tone === "warn"
        ? "border-amber-500 text-amber-700 dark:text-amber-300"
        : "border-border text-muted-foreground";
  return <span className={`rounded border px-1.5 py-0.5 text-[11px] ${cls}`}>{children}</span>;
}

/**
 * DỮ KIỆN MÁY CHỦ ĐÃ DÙNG — ảnh chụp lúc soạn câu, không tính lại lúc mở màn hình.
 *
 * Đây là thứ nhân viên cần để quyết bấm hay không: câu chữ thì họ đọc được, còn con số đằng sau nó
 * thì chỉ tin được khi nhìn thấy. Tiền in ba vai riêng (hàng · ship · tổng) vì ba con số ấy phải
 * cộng được với nhau — gộp lại là chỗ một báo giá sai ra đời.
 */
function FactList({ facts }: { facts: Record<string, unknown> }) {
  const so = (k: string) => (typeof facts[k] === "number" ? (facts[k] as number) : null);
  const mang = (k: string) => (Array.isArray(facts[k]) ? (facts[k] as unknown[]).map(String).filter(Boolean) : []);
  const tong = so("quotedTotal");
  const ship = so("shippingFee");
  const hang = so("goodsTotal");
  const sizes = mang("sizes");
  const colors = mang("colors");
  if (tong === null && !sizes.length && !colors.length) return null;
  return (
    <div className="space-y-0.5 border-t border-border/60 pt-1">
      {tong === null ? (
        <p className="text-muted-foreground">Giá: CHƯA TÍNH ĐƯỢC</p>
      ) : (
        <p>
          Tiền hàng {hang === null ? "—" : formatVND(hang)} · ship {ship === null ? "—" : formatVND(ship)} ·{" "}
          <strong>tổng {formatVND(tong)}</strong>
        </p>
      )}
      {colors.length ? <p className="text-muted-foreground">Màu: {colors.join(", ")}</p> : null}
      {sizes.length ? <p className="text-muted-foreground">Size đang bán: {sizes.join(", ")}</p> : null}
      <p className="text-muted-foreground">
        Tồn: {facts.stockKnown === true ? `biết (${so("available") ?? "—"})` : "CHƯA BIẾT"} · Bảng số đo:{" "}
        {facts.sizeCode === null || facts.sizeCode === undefined ? "chưa hỏi tới" : String(facts.sizeCode)}
      </p>
    </div>
  );
}

/** Thực thể máy bóc ra — chỉ hiện ô CÓ giá trị, để mắt người đọc không phải lọc chỗ trống. */
function EntityList({ entities }: { entities: Record<string, unknown> }) {
  const co = Object.entries(entities).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "");
  if (!co.length) return null;
  return <p className="text-muted-foreground">Bóc được: {co.map(([k, v]) => `${k}=${String(v)}`).join(" · ")}</p>;
}
