import { Suspense } from "react";
import { CircleAlert, CircleCheck, Sparkles, Target, TriangleAlert } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionCard } from "@/components/ui-bits";
import { MARKETING_DIAGNOSIS } from "@/lib/constants/marketing-diagnosis";
import { MARKETING_BASIS_LABEL } from "@/lib/constants/marketing-daily";
import { CELL_STATUS_LABEL } from "@/lib/metrics/scorecard";
import { baselineOf, diagnose, lossStreakOf, sortFindings, type DiagnoseSnapshot, type MarketingFinding } from "@/lib/marketing/diagnose";
import { explainMarketing } from "@/lib/marketing/ai-explain";
import { evaluateMarketingTargets } from "@/lib/queries/marketing-targets";
import { MISSING_TEXT } from "@/lib/format";
import type { MarketingDaily, MarketingDailyBase } from "@/lib/queries/marketing-daily";

/**
 * ───────────── MÁY PHÂN TÍCH: VẤN ĐỀ + VIỆC PHẢI LÀM ─────────────
 *
 * Khối này KHÔNG gọi thêm truy vấn nào: nó chạy hàm thuần `diagnose()` trên chính dữ liệu bảng vừa
 * đọc. Nhờ vậy con số trong phần chẩn đoán không bao giờ khác con số trong bảng ngay phía trên —
 * chạy một truy vấn thứ hai là mở đường cho hai con số nói về cùng một ngày.
 *
 * Nền so sánh lấy từ CHÍNH những ngày đang hiển thị, trừ ngày cuối. Đó cũng là lý do bảng phải có
 * ít nhất vài ngày trước khi phần này nói gì: một nền dựng trên hai ngày vẫn cho ra kết luận, chỉ
 * là kết luận sai.
 */

function toSnapshot(b: MarketingDailyBase): DiagnoseSnapshot {
  return {
    adSpend: b.adSpend,
    messages: b.messages,
    orders: b.orders,
    posRevenue: b.posRevenue,
    deliveredRevenue: b.deliveredRevenue,
    deliveredOrders: b.deliveredOrders,
    returnedOrders: b.returnedOrders,
    finishedOrders: b.finishedOrders,
    pendingOrders: b.pendingOrders,
    contributionProfit: b.contributionProfit,
  };
}

export async function MarketingFindings({ data }: { data: MarketingDaily }) {
  const rows = data.rows;
  const last = rows.at(-1);
  if (!last) return null;

  const baselineRows = rows.slice(Math.max(0, rows.length - 1 - MARKETING_DIAGNOSIS.baselineDays), rows.length - 1);
  const baseline = baselineOf(baselineRows.map(toSnapshot), 3);
  const findings = sortFindings(
    diagnose({
      day: last.day,
      current: toSnapshot(last),
      baseline,
      lossStreak: lossStreakOf(rows),
      staleSources: data.freshness.filter((f) => f.stale).map((f) => f.label),
    }),
  );

  /*
    ĐÍCH VÀ AI ĐỌC SONG SONG, VÀ CẢ HAI ĐỀU ĐƯỢC PHÉP KHÔNG CÓ GÌ.

    Chưa ai đặt đích ⇒ khối đích không hiện (không có ngưỡng mặc định — AGENTS.md mục 38).
    Chưa cấu hình AI ⇒ khối diễn giải không hiện, và lý do vẫn in ra để không ai tưởng nó im lặng
    vì "mọi thứ đều ổn".
  */
  const targets = await evaluateMarketingTargets(data.totals, data.period, data.previousTotals);

  return (
    <SectionCard
      title={`Chẩn đoán ngày ${last.day}`}
      description={baseline ? `So với trung bình ${baselineRows.length} ngày liền trước` : "Chưa đủ ngày để dựng nền so sánh — chỉ hiện những phát hiện không cần nền"}
      hint="Mỗi phát hiện là một TỔ HỢP chỉ số, không phải một chỉ số riêng lẻ: 'CPA tăng' một mình không nói được phải sửa ở khâu quảng cáo hay khâu chốt đơn. Ngưỡng lên tiếng nằm ở lib/constants/marketing-diagnosis.ts và không đụng tới một công thức tiền nào."
    >
      {findings.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
          Không có bất thường nào vượt ngưỡng. {baseline ? "" : "(Chưa đủ nền so sánh — phần lớn quy tắc chưa chạy được.)"}
        </div>
      ) : (
        <ul className="space-y-3">
          {findings.map((f) => (
            <li key={`${f.kind}:${f.scope}`} className="rounded-lg border p-3">
              <div className="flex items-start gap-2">
                {f.severity === "CRITICAL" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />}
                <div className="min-w-0 space-y-1.5">
                  <p className="text-sm font-medium">{f.title}</p>
                  {/* BẰNG CHỨNG TRƯỚC, VIỆC PHẢI LÀM SAU: một khuyến nghị không kèm số của chính nó thì không kiểm chứng được. */}
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {f.evidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                  <ul className="space-y-0.5 text-xs">
                    {f.actions.map((a) => (
                      <li key={a}>→ {a}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {targets.length ? (
        <div className="mt-4 border-t pt-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
            <Target className="size-3.5" /> So với đích đã đặt
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {targets.map((t) => (
              <div key={t.cellKey} className="rounded-lg border p-2 text-xs">
                <p className="text-muted-foreground">{t.label}</p>
                <p className="font-medium">
                  {t.cell.value === null ? MISSING_TEXT : t.cell.value}
                  {t.cell.target ? <span className="text-muted-foreground"> / đích {t.cell.target.target}</span> : null}
                </p>
                {/* canConclude = false ⇒ hiện thực tế, KHÔNG tô màu, KHÔNG gắn nhãn đạt/không đạt. */}
                <p className="text-muted-foreground">{t.cell.canConclude ? CELL_STATUS_LABEL[t.status] : (t.cell.reason ?? "Chưa kết luận được")}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
          Chưa ai đặt đích cho CPQC/đơn, ROAS, tỷ lệ chốt hay margin. ERP cố ý KHÔNG tự nghĩ ra một ngưỡng — đặt đích ở màn hình Mục tiêu (ba tầng: công ty → phòng ban → chức danh), rồi mỗi ô ở đây sẽ
          tự chấm theo đích đó.
        </p>
      )}

      {/*
        DIỄN GIẢI BẰNG AI NẰM SAU RANH GIỚI `Suspense` RIÊNG — và đó là một bản vá cho lỗi của chính
        khối này.

        ĐO TRÊN PRODUCTION 19/09/2026: `/ads/daily` mất 4,7 giây ở lượt đo đầu rồi 20,3 giây ở lượt
        sau, KHÔNG có thay đổi nào ở tầng truy vấn giữa hai lượt. Nguyên nhân: lượt đầu máy phân
        tích không tìm thấy bất thường nào nên `explainMarketing` trả về ngay; lượt sau có phát
        hiện, và lời gọi mô hình (bậc `analysis`) chạy NGAY TRONG lượt dựng trang.

        Một trang chủ shop mở hằng ngày không được phép chờ một nhà cung cấp bên ngoài. Bảng số,
        chẩn đoán và đích là dữ liệu của chính ERP — chúng phải hiện ngay; đoạn văn diễn giải điền
        vào sau. Nếu mô hình chậm hay chết thì phần còn lại của trang không hề biết.

        ĐO LẠI SAU KHI SỬA, cùng phép đo, máy đang rảnh (76/76 màn hình đạt, 0 lỗi):

            /ads/daily  20,3s → 9,5s        (/ads cùng lượt: 21,4s)

        Phần còn lại (~9,5s) là giá thật của việc quét 30 ngày `orders ⋈ shipments` kèm
        ORDER_OUTCOME hai lượt — bảng theo ngày và bảng bóc tách — cùng họ với `/ads` và các trang
        `/reports/*`. Đó là việc của một lượt tối ưu truy vấn riêng, không phải của khối này.
      */}
      <Suspense fallback={<Skeleton className="mt-4 h-16 rounded-lg" />}>
        <AiExplanation data={data} baseline={baseline} findings={findings} />
      </Suspense>
    </SectionCard>
  );
}

async function AiExplanation({ data, baseline, findings }: { data: MarketingDaily; baseline: DiagnoseSnapshot | null; findings: MarketingFinding[] }) {
  if (!findings.length) return null;
  const ai = await explainMarketing({
    scopeLabel: "Toàn shop",
    periodLabel: data.period.label,
    basisLabel: MARKETING_BASIS_LABEL[data.basis],
    totals: data.totals,
    baseline,
    findings,
    warnings: data.warnings,
  });
  if (ai.explanation) {
    return (
      <div className="mt-4 rounded-lg border border-dashed p-3">
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
          <Sparkles className="size-3.5" /> Diễn giải
          {/* Nói rõ AI chỉ DIỄN GIẢI: mọi con số phía trên do máy chủ tính, không phải do mô hình. */}
          <span className="font-normal text-muted-foreground">— viết bởi AI từ chính các con số trên, không tự tính thêm số nào</span>
        </p>
        <p className="whitespace-pre-line text-xs">{ai.explanation.text}</p>
      </div>
    );
  }
  // Nói ra lý do thay vì im lặng: im lặng sẽ bị đọc thành "không có gì để nói".
  return <p className="mt-4 text-xs text-muted-foreground">Phần diễn giải bằng AI không chạy: {ai.skipped}.</p>;
}
