import Link from "next/link";
import { Card } from "@/components/ui/card";
import { AutoRefresh } from "@/app/(dashboard)/ai/copilot/auto-refresh";
import { AGENT_MODE_LABEL, ROUTE_TIER_LABEL, type AgentMode, type RouteTier } from "@/lib/constants/ai";
import { COPILOT_REJECT_LABEL, type CopilotRejectReason } from "@/lib/constants/sales-copilot";
import { LIVE_INGEST_HEALTH_LABEL } from "@/lib/constants/live-ingest";
import { SAFETY_KIND_SPEC } from "@/lib/constants/sales-safety";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import type { copilotKpi, firstHumanSend, ingestStatus, pilotStatus, safetyBoard } from "@/lib/queries/sales-copilot";

/**
 * ═══════════ BẢNG GIÁM SÁT THÍ ĐIỂM — ĐỨNG DƯỚI VIỆC, KHÔNG ĐỨNG TRÊN ═══════════
 *
 * Chủ shop mở `/ai/copilot` ngày 23/09/2026 và nói: "UI lộn xộn và rối quá, tôi không biết cần
 * phải làm gì ở đây."
 *
 * Không khối nào trong bảng này sai. Vấn đề là chúng trả lời một câu hỏi KHÁC với câu hỏi của
 * người đang mở màn hình. Màn hình này phục vụ hai vai:
 *
 *   · NGƯỜI TRẢ LỜI KHÁCH hỏi "khách này tôi đáp gì" — cần đúng ba thứ: tin khách, câu máy soạn,
 *     nút gửi;
 *   · NGƯỜI GIÁM SÁT THÍ ĐIỂM hỏi "cuộc thử này có an toàn, có tiến triển không" — cần bảy khối
 *     số liệu.
 *
 * Bảy khối ấy từng nằm TRÊN hàng đợi, nên vai thứ nhất phải cuộn qua toàn bộ công việc của vai
 * thứ hai mới tới được khách đầu tiên. Người ta không đọc chúng — người ta bị chúng chặn đường.
 *
 * Nên chúng chuyển xuống dưới, trong một khối gấp lại. KHÔNG XOÁ: mỗi con số ở đây đều được dựng
 * vì một sự cố có thật, và một chỉ số chỉ đọc được bằng dòng lệnh là một chỉ số không ai đọc.
 *
 * MỘT NGOẠI LỆ, và nó là lý do khối này vẫn nằm cùng trang: thứ gì ĐANG HỎNG phải đi ngược lên
 * đầu màn hình. Bộ nạp chết hay một câu vi phạm lọt ra thì người trả lời khách cần biết NGAY —
 * xem `TinhTrang` trong `page.tsx`. Gấp một cảnh báo lại là cách nó không bao giờ được đọc.
 */
export type PilotPanelProps = {
  mode: AgentMode;
  pages: string[];
  hardLimits: { allowAutoSend: boolean; allowHumanApprovedSend: boolean; allowOrderCreate: boolean };
  sanSang: boolean;
  queueLength: number;
  nap: Awaited<ReturnType<typeof ingestStatus>>;
  kpi: Awaited<ReturnType<typeof copilotKpi>>;
  lanDau: Awaited<ReturnType<typeof firstHumanSend>>;
  pilot: Awaited<ReturnType<typeof pilotStatus>>;
  anToan: Awaited<ReturnType<typeof safetyBoard>>;
};

export function PilotPanel({ mode, pages, hardLimits, sanSang, queueLength, nap, kpi, lanDau, pilot, anToan }: PilotPanelProps) {
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">
        Số liệu thí điểm — an toàn · bộ nạp · chỉ số · tiến độ
        <span className="ml-2 font-normal text-muted-foreground">(mở ra khi cần kiểm, không cần để trả lời khách)</span>
      </summary>
      <div className="space-y-4 border-t border-border p-4">
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
                <span className="text-muted-foreground">hàng đợi: {formatNumber(queueLength)}</span>
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
            <p className={hardLimits.allowAutoSend ? "font-semibold text-rose-600 dark:text-rose-400" : "font-semibold text-emerald-700 dark:text-emerald-300"}>
              {hardLimits.allowAutoSend ? "⛔ ĐANG MỞ" : "CẤM"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">NHÂN VIÊN bấm gửi</p>
            <p className="font-semibold">{hardLimits.allowHumanApprovedSend ? "được phép" : "CẤM (chưa mở công tắc)"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Page thí điểm</p>
            <p className="font-semibold">{pages.length ? pages.join(", ") : "chưa khai — không page nào gửi được"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Tạo đơn</p>
            <p className={hardLimits.allowOrderCreate ? "font-semibold text-rose-600 dark:text-rose-400" : "font-semibold text-emerald-700 dark:text-emerald-300"}>
              {hardLimits.allowOrderCreate ? "⛔ ĐANG MỞ" : "CẤM"}
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

      {/*
        ═══════════════ AN TOÀN — MỘT THẺ, BA TRẠNG THÁI, KHÔNG PHẢI HAI ═══════════════

        Trước thẻ này, tín hiệu an toàn nằm rải ở bốn góc màn hình: băng gửi trùng, dòng "gửi trong
        lúc thiếu dữ liệu", trạng thái hai công tắc, và kết quả kiểm lần gửi đầu. Đủ để phát hiện,
        nhưng phải nhìn bốn chỗ — nên trên thực tế không ai nhìn.

        HAI CỘT TÁCH RỜI. "Đã chặn" là chốt an toàn nổ TRƯỚC khi câu ra khỏi máy; đó là thứ shop
        trả tiền để có, không phải sự cố. "Đã lọt" mới là vi phạm. Cộng chung hai cột thì mỗi lần
        hệ thống làm đúng việc lại thành một báo động đỏ, và sau vài lần không ai đọc thẻ này nữa.

        BA TRẠNG THÁI. Sạch mà CHƯA phủ hết thì nói đúng như thế — `PASS (trong phạm vi đo được)`
        kèm tên những loại chưa ai đo. Gộp nó vào `PASS` là hứa một điều chưa kiểm.
      */}
      <Card
        className={`p-3 ${anToan.verdict === "ALERT" ? "border-rose-500 bg-rose-50/70 dark:border-rose-500/70 dark:bg-rose-950/40" : "border-emerald-500/50 dark:border-emerald-500/40"}`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide">An toàn</p>
          <p className="text-xs">
            {anToan.verdict === "ALERT" ? (
              <span className="font-semibold text-rose-700 dark:text-rose-300">
                ⛔ {formatNumber(anToan.escaped)} VI PHẠM ĐÃ LỌT RA — dừng thí điểm và kiểm tra
              </span>
            ) : (
              <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                ✓ {anToan.verdict === "PASS" ? "ĐẠT" : "ĐẠT (trong phạm vi đo được)"} · 0 vi phạm lọt ra
              </span>
            )}
          </p>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Chốt an toàn đã chặn <strong>{formatNumber(anToan.blocked)}</strong> lần trước khi câu ra khỏi máy — đây là tin tốt, không
          phải sự cố.
          {anToan.unmeasured > 0
            ? ` · ${anToan.unmeasured}/${anToan.rows.length} loại CHƯA CÓ GÌ ĐO ĐƯỢC, nên "0" ở trên chỉ nói về phần nhìn thấy.`
            : ""}
        </p>

        <div className="mt-2 grid gap-x-4 gap-y-0.5 border-t border-border/60 pt-2 text-[11px] sm:grid-cols-2">
          {anToan.rows.map((r) => {
            const spec = SAFETY_KIND_SPEC[r.kind];
            return (
              <div key={r.kind} className="flex items-baseline justify-between gap-2">
                <span className={r.escaped ? "font-semibold text-rose-700 dark:text-rose-300" : "text-muted-foreground"}>
                  {spec.label}
                </span>
                <span className="shrink-0 font-mono">
                  {r.escaped === null ? (
                    <span className="text-amber-700 dark:text-amber-300">CHƯA ĐO ĐƯỢC</span>
                  ) : (
                    <>
                      <span className={r.escaped ? "font-semibold text-rose-700 dark:text-rose-300" : ""}>lọt {r.escaped}</span>
                      {r.blocked ? <span className="text-muted-foreground"> · chặn {r.blocked}</span> : null}
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {/* CÓ VI PHẠM THÌ PHẢI CHỈ RA CHỖ ĐỂ MỞ, không chỉ một con số. */}
        {anToan.rows.some((r) => (r.escaped ?? 0) > 0) ? (
          <div className="mt-2 space-y-0.5 border-t border-rose-300 pt-2 text-[11px] dark:border-rose-800">
            {anToan.rows
              .filter((r) => (r.escaped ?? 0) > 0)
              .map((r) =>
                r.samples.map((v, i) => (
                  <p key={`${r.kind}-${i}`} className="text-rose-800 dark:text-rose-200">
                    <span className="font-semibold">{SAFETY_KIND_SPEC[r.kind].label}</span>
                    {v.conversationId ? (
                      <>
                        {" · "}
                        <Link href={`/ai/review?conversation=${v.conversationId}`} className="underline">
                          hội thoại {v.conversationId.slice(0, 8)}
                        </Link>
                      </>
                    ) : null}
                    {v.runId ? ` · lượt chạy ${v.runId.slice(0, 8)}` : ""} — {v.note}
                  </p>
                )),
              )}
          </div>
        ) : null}

        {/* LOẠI CHƯA ĐO ĐƯỢC PHẢI NÓI THIẾU CHÍNH XÁC CÁI GÌ — một bảng chỉ in con số là bảng không ai mở lần thứ hai. */}
        {anToan.rows.some((r) => r.escaped === null) ? (
          <div className="mt-2 space-y-0.5 border-t border-border/60 pt-2 text-[11px] text-amber-800 dark:text-amber-200">
            {anToan.rows
              .filter((r) => r.escaped === null)
              .map((r) => (
                <p key={r.kind}>
                  <span className="font-semibold">{SAFETY_KIND_SPEC[r.kind].label}: chưa đo được</span> — {SAFETY_KIND_SPEC[r.kind].missingWhat}
                </p>
              ))}
          </div>
        ) : null}
      </Card>
      </div>
    </details>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="text-base font-semibold">{value}</p>
    </div>
  );
}

/** Ghép "n (x%)" — tỷ lệ `null` là CHƯA BIẾT, in dấu gạch chứ không in 0% (luật 42). */
function ghepTyLe(n: number, ty: number | null): string {
  return ty === null ? formatNumber(n) : `${formatNumber(n)} (${ty}%)`;
}
