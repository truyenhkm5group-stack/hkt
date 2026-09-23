import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { SendCard } from "@/app/(dashboard)/ai/copilot/send-card";
import { SALES_ACTION_LABEL, SALES_STAGE_LABEL, HANDOFF_REASON_LABEL, type HandoffReason, type SalesAction, type SalesStage } from "@/lib/constants/sales-agent";
import { COPILOT_WARNING_LABEL } from "@/lib/constants/sales-copilot";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { getAgent } from "@/lib/ai-workforce/registry";
import { requirePermission } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/auth/session";
import { LIVE_INGEST_HEALTH_LABEL } from "@/lib/constants/live-ingest";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { copilotKpi, copilotPages, copilotQueue, firstHumanSend, ingestStatus, pilotStatus, safetyBoard } from "@/lib/queries/sales-copilot";
import { modeAtLeast } from "@/lib/constants/ai";
import { AutoRefresh } from "@/app/(dashboard)/ai/copilot/auto-refresh";
import { PilotPanel } from "@/app/(dashboard)/ai/copilot/pilot-panel";

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
  const [queue, kpi, nap, lanDau, pilot, anToan] = await Promise.all([
    copilotQueue({ limit: 40, heldByUserId: user?.id ?? null }),
    copilotKpi(7),
    ingestStatus(),
    firstHumanSend(),
    pilotStatus(),
    safetyBoard(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Trả lời khách"
        description="Máy soạn sẵn. Việc của bạn: đọc tin khách, sửa nếu cần, bấm gửi. Máy KHÔNG BAO GIỜ tự gửi."
      />

      {/*
        MỘT DÒNG, VÀ NÓ CHỈ TO TIẾNG KHI CÓ CHUYỆN.

        Bảy khối số liệu từng đứng ở đây và đẩy khách hàng đầu tiên xuống dưới màn hình. Chủ shop mở
        ra rồi nói "không biết cần phải làm gì" — đúng, vì thứ đập vào mắt là công việc của một vai
        KHÁC (người giám sát cuộc thí điểm), không phải của người đang định trả lời khách.

        Chúng chuyển xuống `PilotPanel`, gấp lại. Nhưng thứ ĐANG HỎNG thì không được gấp: bộ nạp
        chết hay một câu vi phạm lọt ra là thứ người trả lời khách phải biết trước khi gõ chữ đầu
        tiên. Nên dòng này im lặng khi mọi thứ chạy, và chặn ngang màn hình khi không.
      */}
      <TinhTrang nap={nap} anToan={anToan} sanSang={sanSang} soViec={queue.length} />

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
          Không có khách nào đang chờ.
          <br />
          Máy vẫn đang canh tin mới — có khách nhắn là thẻ hiện ra ở đây.
        </Card>
      ) : null}

      {queue.map((row) => (
        <Card key={row.conversationId} className="space-y-3 p-4">
          {/*
            HÀNG ĐẦU CHỈ GIỮ THỨ ĐỔI ĐƯỢC VIỆC NGƯỜI ĐỌC SẼ LÀM.

            Trước đây hàng này có bảy nhãn: tên khách, nguồn, nấc hội thoại, tên sản phẩm, số phút
            chờ, mã page, và một liên kết. Năm trong bảy cái ấy là trạng thái nội bộ — chúng không
            đổi câu trả lời, chúng chỉ chiếm chỗ của hai cái có đổi. Chúng xuống khối "Vì sao máy
            soạn thế này" ở cuối thẻ.
          */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-base font-semibold">{row.customerName || "(chưa có tên)"}</span>
            {row.waitedMinutes === null ? null : (
              <Badge tone={row.waitedMinutes > 60 ? "hot" : undefined}>chờ {row.waitedMinutes} phút</Badge>
            )}
            {/*
              MÁY ĐÃ KÊU CỨU — nhãn này đổi cách đọc cả thẻ: máy đọc xong rồi tự nhận là mình không
              xử lý được, nên thẻ này cần một người NHẤT trong cả hàng đợi.
            */}
            {row.machineHandoff ? <Badge tone="hot">AI cần người xử lý</Badge> : null}
            {row.productName ? null : <Badge tone="warn">chưa nhận ra sản phẩm</Badge>}
          </div>

          {/*
            LÝ DO MÁY XIN NGƯỜI VÀO, viết ra thành câu. Một nhãn đỏ không nói người trực phải làm
            gì; lý do thì có — thiếu bảng số đo là việc khác hẳn với khách hỏi một chuyện phức tạp.
          */}
          {row.machineHandoff ? (
            <p className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100">
              <span className="font-semibold">Máy đã rút lui — chưa ai nhận việc này.</span>
              {row.handoffRequestReason ? <> Lý do: {HANDOFF_REASON_LABEL[row.handoffRequestReason as HandoffReason] ?? row.handoffRequestReason}.</> : null}{" "}
              Hai lối ra nằm ngay dưới câu máy soạn.
            </p>
          ) : null}

          {/* ─── 1. KHÁCH NÓI GÌ ─── chiếm hết bề ngang, vì đây là thứ phải đọc trước tiên. */}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Khách nhắn{row.customerMessageAt ? ` · ${formatDateTime(row.customerMessageAt)}` : ""}
            </p>
            <p className="whitespace-pre-wrap rounded-lg bg-muted/60 p-3 text-sm">{row.customerMessage || "(không có nội dung)"}</p>
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

          {/* ─── 2. MÁY SOẠN GÌ, VÀ NÚT GỬI ─── */}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Máy soạn{row.suggestedAt ? ` · ${formatDateTime(row.suggestedAt)}` : ""}
            </p>
            <SendCard
              conversationId={row.conversationId}
              suggestionId={row.suggestionId}
              suggestedReply={row.suggestedReply}
              stale={row.stale}
              humanTakeover={Boolean(row.humanTakeoverAt)}
              canRelease={row.takeoverByUserId === user?.id}
              machineHandoff={row.machineHandoff}
              handoffReasonText={
                row.handoffRequestReason ? HANDOFF_REASON_LABEL[row.handoffRequestReason as HandoffReason] ?? row.handoffRequestReason : ""
              }
            />
          </div>

          {/*
            ─── 3. CON SỐ CÂU ẤY DỰA VÀO ─── ở lại ngoài, KHÔNG gấp vào.

            Đây là ranh giới của lần dọn này, và nó không nằm ở "nhiều chữ hay ít chữ". Con số thì
            người đọc KHÔNG tự kiểm được từ câu chữ — giá 499.000 ₫ đúng hay sai thì nhìn câu không
            biết. Giấu chúng đi là bắt người bấm TIN bản nháp, đúng thứ nấc trợ lý sinh ra để tránh.

            Còn mã ý định, tên hành động, điểm tin cậy, nấc hội thoại, mã page: chúng nói về máy,
            không nói về khách, và không đổi câu trả lời. Chúng xuống khối gấp bên dưới.
          */}
          <FactList facts={row.facts} />

          <details className="text-[11px]">
            <summary className="cursor-pointer text-muted-foreground">Vì sao máy soạn thế này</summary>
            <div className="mt-1 space-y-0.5 border-t border-border/60 pt-1">
              <p>Ý định: {row.intents.length ? row.intents.join(", ") : "—"}</p>
              <p>
                Việc máy chọn: {SALES_ACTION_LABEL[row.action as SalesAction] ?? (row.action || "—")} · tin cậy{" "}
                {row.confidence === null ? "—" : row.confidence}
              </p>
              {row.decisionReason ? <p className="text-muted-foreground">{row.decisionReason}</p> : null}
              {row.missing.length ? <p>Còn thiếu để lên đơn: {row.missing.join(", ")}</p> : null}
              {row.handoffReason ? (
                <p className="font-semibold text-amber-700 dark:text-amber-300">
                  Chuyển người: {HANDOFF_REASON_LABEL[row.handoffReason as HandoffReason] ?? row.handoffReason}
                  {row.handoffReason === "SIZE_DATA_MISSING" ? " — ERP chưa có bảng số đo, máy KHÔNG đoán size" : ""}
                </p>
              ) : null}
              <EntityList entities={row.entities} />
              <p className="text-muted-foreground">
                Nguồn {row.sourceType || "?"} · nấc {SALES_STAGE_LABEL[row.stage as SalesStage] ?? row.stage}
                {row.productName ? ` · ${row.productName}` : ""} · page {row.pageId}
              </p>
              <Link href={`/ai/review?conversation=${row.conversationId}`} className="inline-block underline">
                xem lượt chạy đầy đủ
              </Link>
            </div>
          </details>
        </Card>
      ))}
      {/*
        Bảng giám sát xuống CUỐI và gấp lại. Xem chú thích đầu `pilot-panel.tsx`: không con số nào
        trong đó sai, chúng chỉ trả lời câu hỏi của một vai khác với vai đang mở màn hình này.
      */}
      <PilotPanel
        mode={mode}
        pages={pages}
        hardLimits={settings.hardLimits}
        sanSang={sanSang}
        queueLength={queue.length}
        nap={nap}
        kpi={kpi}
        lanDau={lanDau}
        pilot={pilot}
        anToan={anToan}
      />
    </div>
  );
}

/**
 * ═══════════ MỘT DÒNG — VÀ NÓ CHỈ TO TIẾNG KHI CÓ CHUYỆN ═══════════
 *
 * Người trả lời khách cần biết đúng ba điều trước khi gõ chữ đầu tiên, và chỉ khi câu trả lời là
 * XẤU thì điều ấy mới đáng chiếm chỗ trên màn hình:
 *
 *   · có câu nào vi phạm lọt ra khách không  → đỏ, chặn ngang, vì đang có hại thật;
 *   · bộ nạp còn sống không                   → hổ phách, vì màn hình rỗng lúc bộ nạp chết trông
 *                                                y hệt màn hình rỗng lúc vắng khách;
 *   · bấm Gửi có đi được không                → hổ phách, vì bấm rồi mới biết không đi là tệ nhất.
 *
 * Mọi thứ khác — chỉ số, tiến độ, token, đường mô hình — KHÔNG thuộc về đây. Chúng nằm ở
 * `PilotPanel` cuối trang. Một dòng trạng thái mà hôm nào cũng có bảy con số là một dòng không ai
 * đọc, nên hôm nó thật sự đỏ cũng không ai thấy.
 *
 * Mọi thứ bình thường ⇒ một dòng xám nhạt. Đó là trạng thái ĐÚNG của màn hình này hầu hết thời
 * gian, và nó phải trông như vậy.
 */
function TinhTrang({
  nap,
  anToan,
  sanSang,
  soViec,
}: {
  nap: Awaited<ReturnType<typeof ingestStatus>>;
  anToan: Awaited<ReturnType<typeof safetyBoard>>;
  sanSang: boolean;
  soViec: number;
}) {
  const napHong = nap.filter((n) => n.health !== "LIVE");
  const viPham = anToan.verdict === "ALERT";

  return (
    <div className="space-y-2">
      {viPham ? (
        <Card className="border-rose-500 bg-rose-50/70 p-3 dark:border-rose-500/70 dark:bg-rose-950/40">
          <p className="text-sm font-semibold text-rose-700 dark:text-rose-300">
            ⛔ {formatNumber(anToan.escaped)} câu vi phạm ĐÃ LỌT RA KHÁCH — dừng bấm gửi và mở “Số liệu thí điểm” ở cuối trang để xem từng câu.
          </p>
        </Card>
      ) : null}

      {napHong.length ? (
        <Card className="border-amber-500/70 bg-amber-50/70 p-3 dark:border-amber-500/50 dark:bg-amber-950/30">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            Bộ nạp tin không chạy ({napHong.map((n) => `${n.pageId}: ${LIVE_INGEST_HEALTH_LABEL[n.health]}`).join(" · ")}).
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Hàng đợi trống lúc này KHÔNG có nghĩa là vắng khách — máy đang không đọc tin mới.
          </p>
        </Card>
      ) : null}

      {!sanSang ? (
        <Card className="border-amber-500/70 bg-amber-50/70 p-3 dark:border-amber-500/50 dark:bg-amber-950/30">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Cổng gửi đang ĐÓNG — đọc và chấm được, nhưng bấm Gửi sẽ bị từ chối.</p>
          <p className="text-xs text-amber-700 dark:text-amber-300">Xem “Số liệu thí điểm” ở cuối trang để biết thiếu điều kiện nào.</p>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {soViec === 0 ? "Không có khách nào đang chờ" : `${formatNumber(soViec)} khách đang chờ bạn`}
          {" · "}máy đang canh tin mới{" · "}
          <span className="font-medium text-foreground">máy không tự gửi tin cho ai</span>
        </span>
        <AutoRefresh seconds={20} />
      </div>
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
