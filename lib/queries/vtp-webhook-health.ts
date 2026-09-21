import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { webhookMatchRate, WEBHOOK_MATCH_MIN_SAMPLE } from "@/lib/constants/webhook-gap";
import { webhookLatencyVerdict, WEBHOOK_LATENCY_BASELINE_MIN_DAYS, type WebhookLatencyVerdict } from "@/lib/constants/webhook-latency";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ SỨC KHOẺ WEBHOOK VIETTEL POST — ĐO ĐƯỢC, KHÔNG PHỎNG ĐOÁN ═══════════
 *
 * 2.138/2.151 vận đơn chỉ nhận webhook (đo 16/09/2026). Webhook rơi là mất tin về hàng nghìn kiện,
 * và ERP không có nguồn thứ hai để tự phát hiện. Nên màn hình này phải trả lời được BỐN câu, và
 * mỗi câu là một loại hỏng khác nhau với một cách sửa khác nhau:
 *
 *  1. CÓ ĐANG NHẬN KHÔNG          → 15 phút · 1 giờ · 24 giờ
 *  2. NHẬN CÓ CÒN KỊP KHÔNG       → độ trễ từ lúc sự việc xảy ra tới lúc ERP nhận
 *  3. NHẬN RỒI CÓ ĐỌC ĐƯỢC KHÔNG  → gói tin hỏng / không ghép được vận đơn
 *  4. NHẬN CÓ ĐÚNG THỨ TỰ KHÔNG   → gói tin tới SAU nhưng mang mốc CŨ HƠN
 *  5. CÓ RƠI GÓI NÀO KHÔNG        → tỷ lệ khớp đo bằng tệp đối chiếu (`vtp_webhook_gaps`)
 *
 * Câu 2 được thêm sau sự cố 21/09/2026: cả ngày hôm ấy gói tin về ĐỦ SỐ nhưng trung vị trễ 28
 * phút (mọi hôm 31–37 giây), và vì `liveness` chỉ đếm SỐ GÓI nên nó báo `HEALTHY` suốt. Xem
 * `lib/constants/webhook-latency.ts`.
 *
 * ─── "MỘT GIỜ KHÔNG CÓ GÓI TIN NÀO" TỰ NÓ KHÔNG NÓI GÌ ───
 *
 * Shop không nhận đơn lúc 3 giờ sáng, nên im lặng lúc 3 giờ sáng là bình thường; im lặng lúc 10
 * giờ sáng thì không. Một ngưỡng phẳng ("cảnh báo nếu < N gói/giờ") sẽ hoặc hét mỗi đêm, hoặc câm
 * cả ngày. Nên NỀN SO SÁNH lấy theo ĐÚNG KHUNG GIỜ ĐÓ trong 14 ngày gần nhất: câu hỏi là "giờ này
 * mọi hôm có bao nhiêu gói tin", không phải "trung bình một giờ có bao nhiêu".
 *
 * Và khi nền chưa đủ dữ liệu, kết luận là CHƯA BIẾT — không phải "khoẻ".
 */

export type WebhookHealth = {
  last15m: number;
  last1h: number;
  last24h: number;
  /** Số gói tin cùng KHUNG GIỜ này, trung vị của 14 ngày gần nhất. `null` = chưa đủ nền để nói. */
  baseline1h: number | null;
  /** `HEALTHY` · `QUIET` (thấp hơn hẳn nền) · `SILENT` (nền có mà giờ này không gói nào) · `UNKNOWN`. */
  liveness: "HEALTHY" | "QUIET" | "SILENT" | "UNKNOWN";
  livenessNote: string;
  /** Trung vị độ trễ (giây) của 1 giờ qua: từ mốc ĐVVC tới lúc ERP nhận. `null` = chưa đo được. */
  latencyMedianSeconds: number | null;
  /** Cùng khung giờ, trung vị 14 ngày gần nhất. `null` = chưa đủ nền. */
  latencyBaselineSeconds: number | null;
  /** Số gói đã vào phép đo độ trễ của giờ qua — ĐỘ PHỦ luôn đứng cạnh con số. */
  latencySample: number;
  /** `FRESH` · `LAGGING` (vượt nền nhiều lần) · `STALLED` (quá ngưỡng tuyệt đối) · `UNKNOWN`. */
  latency: WebhookLatencyVerdict;
  latencyNote: string;
  /** Gói tin ERP không đọc được (hỏng định dạng / thiếu trường). */
  parseFailed24h: number;
  /** Gói tin đọc được nhưng không ghép được về vận đơn nào — giữ lại để xử lý lại. */
  unmatched24h: number;
  /** Viettel Post gửi lại cùng một gói (tối đa 5 lần) — KHÔNG phải lỗi, nhưng cao bất thường thì là. */
  duplicate24h: number;
  duplicateRate24h: number | null;
  /** Gói tin tới SAU nhưng mang mốc ĐVVC CŨ HƠN gói đã nhận — thứ tự mạng, không phải lỗi dữ liệu. */
  outOfOrder24h: number;
  /** Tỷ lệ webhook nói đúng, đo bằng tệp đối chiếu. `null` = mẫu chưa đủ (< 30 dòng). */
  matchRate: number | null;
  matchSample: number;
  gaps30d: number;
  gapCritical30d: number;
  lastGapAt: Date | null;
};

export async function vtpWebhookHealth(): Promise<WebhookHealth> {
  return memo("vtp-webhook-health", 60_000, async () => {
    const db = await getDb();
    const [dem] = rowsOf<{ m15: number; h1: number; h24: number; parse_failed: number; unmatched: number; duplicate: number }>(await db.execute(sql`
      select
        count(*) filter (where received_at >= now() - interval '15 minutes')::int as m15,
        count(*) filter (where received_at >= now() - interval '1 hour')::int as h1,
        count(*) filter (where received_at >= now() - interval '24 hours')::int as h24,
        -- ĐỌC KHÔNG ĐƯỢC vs GHÉP KHÔNG ĐƯỢC là hai loại hỏng khác nhau: cái đầu là lỗi định dạng
        -- (phải sửa mã), cái sau là vận đơn chưa về ERP (tự hết khi đơn đồng bộ xong).
        count(*) filter (where received_at >= now() - interval '24 hours' and status = 'FAILED' and coalesce(error,'') not ilike '%không tìm thấy%')::int as parse_failed,
        count(*) filter (where received_at >= now() - interval '24 hours' and coalesce(error,'') ilike '%không tìm thấy%')::int as unmatched,
        -- Viettel Post thử lại tối đa 5 lần nên cùng một sự việc tới nhiều lần. ERP gộp chúng bằng
        -- dedupe_key và đếm ở delivery_count, nên "gửi lại" KHÔNG phải một dòng riêng mang trạng
        -- thái DUPLICATE — đếm theo trạng thái ở đây sẽ luôn ra 0 và màn hình nói dối là không có trùng.
        coalesce(sum(delivery_count - 1) filter (where received_at >= now() - interval '24 hours'), 0)::int as duplicate
      from webhook_events
      where source = 'VIETTELPOST'
    `));

    /*
      GÓI TIN TỚI SAU MÀ MANG MỐC CŨ HƠN.

      Đếm trên `shipment_events` chứ không trên `webhook_events`: chỉ ở đó mới có cả MỐC ĐVVC
      (`occurred_at`) lẫn MỐC ERP NHẬN (`created_at`) để so. Đây KHÔNG phải lỗi — mạng không hứa
      thứ tự, và `materializeShipmentState` đã xử lý đúng (mốc ĐVVC mới nhất thắng). Nhưng tỷ lệ
      cao bất thường nói rằng đường truyền đang dồn ứ, và đó là điềm báo của một đợt rơi.
    */
    const [lech] = rowsOf<{ n: number }>(await db.execute(sql`
      select count(*)::int as n
      from shipment_events e
      where e.source = 'VTP_WEBHOOK'
        and e.created_at >= now() - interval '24 hours'
        and exists (
          select 1 from shipment_events truoc
          where truoc.shipment_id = e.shipment_id
            and truoc.source = 'VTP_WEBHOOK'
            and truoc.created_at < e.created_at
            and truoc.occurred_at > e.occurred_at
        )
    `));

    /*
      NỀN SO SÁNH THEO ĐÚNG KHUNG GIỜ NÀY, 14 NGÀY GẦN NHẤT.

      Trung vị chứ không phải trung bình: một ngày bão đơn hoặc một ngày ĐVVC gửi lại hàng loạt sẽ
      kéo trung bình lên và làm mọi giờ bình thường trông như "đang hụt".

      Giờ tính theo GIỜ VIỆT NAM — nhịp làm việc của shop đi theo múi giờ của shop, không theo UTC.
    */
    const [nen] = rowsOf<{ median: number | null; ngay: number }>(await db.execute(sql`
      with theo_ngay as (
        select date_trunc('day', received_at at time zone 'Asia/Ho_Chi_Minh') as ngay, count(*)::int as n
        from webhook_events
        where source = 'VIETTELPOST'
          and received_at >= now() - interval '14 days'
          and received_at < date_trunc('hour', now())
          and extract(hour from (received_at at time zone 'Asia/Ho_Chi_Minh'))
              = extract(hour from (now() at time zone 'Asia/Ho_Chi_Minh'))
        group by 1
      )
      select percentile_cont(0.5) within group (order by n) as median, count(*)::int as ngay from theo_ngay
    `));

    // Nền chỉ có nghĩa khi có đủ ngày để nói "giờ này mọi hôm". Dưới 5 ngày là CHƯA BIẾT.
    const baseline1h = nen && nen.ngay >= 5 && nen.median !== null ? Math.round(Number(nen.median)) : null;
    const h1 = Number(dem?.h1 ?? 0);
    let liveness: WebhookHealth["liveness"] = "UNKNOWN";
    let livenessNote = "Chưa đủ nền so sánh cho khung giờ này — CHƯA BIẾT, không phải “khoẻ”.";
    if (baseline1h !== null) {
      if (baseline1h === 0) {
        liveness = "HEALTHY";
        livenessNote = "Khung giờ này mọi hôm cũng không có gói tin nào — im lặng ở đây là bình thường.";
      } else if (h1 === 0) {
        liveness = "SILENT";
        livenessNote = `Khung giờ này mọi hôm có khoảng ${baseline1h} gói tin, giờ không có gói nào. Kiểm tra cấu hình chuyển tiếp webhook ở Pancake và Viettel Post.`;
      } else if (h1 * 2 < baseline1h) {
        liveness = "QUIET";
        livenessNote = `Đang nhận ${h1} gói tin, thấp hơn một nửa mức thường thấy của khung giờ này (${baseline1h}).`;
      } else {
        liveness = "HEALTHY";
        livenessNote = `Đang nhận ${h1} gói tin, ngang mức thường thấy của khung giờ này (${baseline1h}).`;
      }
    }

    /*
      ═══ ĐỘ TRỄ: TỪ LÚC SỰ VIỆC XẢY RA TỚI LÚC ERP BIẾT ═══

      `received_at` được ghi NGAY khi request chạm ERP (trong `storeWebhook`, trước mọi xử lý), nên
      hiệu số này đo đúng quãng đường từ Viettel Post tới đây — không lẫn thời gian ERP xử lý.

      `greatest(..., 0)`: lệch đồng hồ giữa hai hệ thống có thể cho ra số âm. Âm nghĩa là hai cái
      đồng hồ không khớp, KHÔNG phải "gói tin tới trước khi sự việc xảy ra"; kẹp về 0 và vẫn tính,
      không loại quan sát ra khỏi mẫu (mục 64).

      Nền lấy TRUNG VỊ CỦA TỪNG NGÀY rồi lấy trung vị các ngày — không gộp tất cả gói của 14 ngày
      vào một rổ, vì ngày nhiều đơn sẽ áp đảo ngày ít đơn và nền thành ra của riêng vài ngày bận.
    */
    const [tre] = rowsOf<{ n: number; median: number | null }>(await db.execute(sql`
      select count(*)::int as n,
             percentile_cont(0.5) within group (order by greatest(extract(epoch from (received_at - occurred_at)), 0)) as median
      from webhook_events
      where source = 'VIETTELPOST' and occurred_at is not null and received_at >= now() - interval '1 hour'
    `));
    const [nenTre] = rowsOf<{ median: number | null; ngay: number }>(await db.execute(sql`
      with theo_ngay as (
        select date_trunc('day', received_at at time zone 'Asia/Ho_Chi_Minh') as ngay,
               percentile_cont(0.5) within group (order by greatest(extract(epoch from (received_at - occurred_at)), 0)) as med
        from webhook_events
        where source = 'VIETTELPOST'
          and occurred_at is not null
          and received_at >= now() - interval '14 days'
          and received_at < date_trunc('hour', now())
          and extract(hour from (received_at at time zone 'Asia/Ho_Chi_Minh'))
              = extract(hour from (now() at time zone 'Asia/Ho_Chi_Minh'))
        group by 1
      )
      select percentile_cont(0.5) within group (order by med) as median, count(*)::int as ngay from theo_ngay
    `));
    const latencySample = Number(tre?.n ?? 0);
    const latencyMedianSeconds = tre?.median === null || tre?.median === undefined ? null : Math.round(Number(tre.median));
    const latencyBaselineSeconds =
      nenTre && nenTre.ngay >= WEBHOOK_LATENCY_BASELINE_MIN_DAYS && nenTre.median !== null ? Math.round(Number(nenTre.median)) : null;
    const doTre = webhookLatencyVerdict({ medianSeconds: latencyMedianSeconds, baselineSeconds: latencyBaselineSeconds, sample: latencySample });

    /*
      TỶ LỆ KHỚP — chỉ đo được bằng TỆP, và chỉ phát biểu khi đủ mẫu.

      Mẫu số là số dòng tệp ghép được về một vận đơn ERP đã biết; tử số là số dòng ERP đã biết
      trước. Dưới 30 dòng thì trả `null`: "1/1 hụt" không phải "webhook rơi 100%".
    */
    const [do30] = rowsOf<{ checked: number; ok: number; gaps: number }>(await db.execute(sql`
      select
        coalesce(sum(checked), 0)::int as checked,
        coalesce(sum(webhook_ok), 0)::int as ok,
        coalesce(sum(webhook_gaps), 0)::int as gaps
      from vtp_import_batches
      where mode = 'APPLY' and created_at >= now() - interval '30 days'
    `));

    const [gap] = rowsOf<{ n: number; nang: number; lan_cuoi: string | null }>(await db.execute(sql`
      select
        count(*)::int as n,
        count(*) filter (where severity = 'CRITICAL')::int as nang,
        max(detected_at) as lan_cuoi
      from vtp_webhook_gaps
      where detected_at >= now() - interval '30 days'
    `));

    const known = Number(do30?.ok ?? 0);
    const gaps = Number(do30?.gaps ?? 0);
    const h24 = Number(dem?.h24 ?? 0);
    const duplicate24h = Number(dem?.duplicate ?? 0);
    return {
      last15m: Number(dem?.m15 ?? 0),
      last1h: h1,
      last24h: h24,
      baseline1h,
      liveness,
      livenessNote,
      latencyMedianSeconds,
      latencyBaselineSeconds,
      latencySample,
      latency: doTre.verdict,
      latencyNote: doTre.note,
      parseFailed24h: Number(dem?.parse_failed ?? 0),
      unmatched24h: Number(dem?.unmatched ?? 0),
      duplicate24h,
      // Mẫu số 0 ⇒ `null`, không phải 0%: chưa nhận gói nào thì tỷ lệ trùng là CHƯA BIẾT.
      duplicateRate24h: h24 > 0 ? duplicate24h / h24 : null,
      outOfOrder24h: Number(lech?.n ?? 0),
      matchRate: webhookMatchRate({ known, gaps }),
      matchSample: known + gaps,
      gaps30d: Number(gap?.n ?? 0),
      gapCritical30d: Number(gap?.nang ?? 0),
      lastGapAt: gap?.lan_cuoi ? new Date(gap.lan_cuoi) : null,
    };
  });
}

export { WEBHOOK_MATCH_MIN_SAMPLE };
