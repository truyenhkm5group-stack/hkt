import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { rowsOf } from "@/lib/sql-rows";
import { effectiveThresholdFor, FRESHNESS_BY_STAGE, FRESHNESS_DEFAULT } from "@/lib/constants/logistics-freshness";
import { getFreshnessConfig } from "@/lib/queries/logistics-config";
import {
  CARE_SILENCE_HOURS,
  GAP_QUEUE_DAYS,
  RECONCILE_REASON_RANK,
  type ReconcileReason,
} from "@/lib/constants/vtp-reconcile-queue";

/**
 * ═══════════ HÀNG ĐỢI "VTP CẦN ĐỐI CHIẾU" — MỘT TRUY VẤN, KHÔNG MỘT LƯỢT GỌI API ═══════════
 *
 * Lý lẽ đầy đủ ở `lib/constants/vtp-reconcile-queue.ts`. Ở đây chỉ có ba điều đáng nói:
 *
 *  1. MỘT KIỆN CÓ THỂ MANG NHIỀU LÝ DO. Một vận đơn vừa mang trạng thái ERP chưa dịch được, vừa im
 *     lặng quá ngưỡng, là MỘT việc chứ không phải hai — người trực mở viettelpost.vn đúng một lần.
 *     Nên gộp lý do vào một mảng trên cùng một dòng, và xếp hạng theo lý do MẠNH NHẤT.
 *  2. NGƯỠNG IM LẶNG LẤY TỪ CẤU HÌNH ĐANG CHẠY, không gõ lại. Chủ shop sửa ngưỡng ở màn hình cấu
 *     hình thì hàng đợi này đổi theo — hai nơi nói hai con số là cách chắc chắn nhất để không ai
 *     tin con số nào.
 *  3. BA LÝ DO CHỈ CÓ NGHĨA VỚI KIỆN ĐANG CHẠY. Im lặng, care không nhúc nhích và quá ngưỡng chặng
 *     đều vô nghĩa với một kiện đã giao xong — đưa nó vào là bắt người trực tra một thứ không còn
 *     đổi được nữa. Ba lý do còn lại (lỗi đối chiếu, câu chưa dịch được, webhook đã rơi) vẫn là
 *     việc dù kiện đã chốt: chúng nói rằng ERP đang KHÔNG HIỂU, và điều đó không tự hết.
 */

export type ReconcileRow = {
  id: string;
  trackingCode: string | null;
  vtpOrderNumber: string | null;
  stage: string;
  vtpStatusName: string | null;
  vtpRawStatusName: string | null;
  vtpSyncSource: string | null;
  vtpLastError: string | null;
  lastCarrierAt: Date | null;
  hoursSilent: number | null;
  /** Ngưỡng "cũ nghiêm trọng" ĐANG CÓ HIỆU LỰC của chặng này — để màn hình in được "68h / ngưỡng 48h". */
  criticalHours: number;
  codAmount: number | null;
  receiverName: string;
  receiverPhone: string;
  careOpen: boolean;
  reasons: ReconcileReason[];
  /** Lý do MẠNH NHẤT — thứ quyết định chỗ đứng trong hàng đợi. */
  topReason: ReconcileReason;
};

export type ReconcileQueue = {
  rows: ReconcileRow[];
  total: number;
  counts: Record<ReconcileReason, number>;
  /** Số kiện bị cắt khỏi danh sách vì giới hạn — in ra, không giấu. */
  truncated: number;
  /** Trang đang tải (cộng dồn: trang 2 nghĩa là đang có 2 × `pageSize` dòng đầu). */
  page: number;
  pageSize: number;
};

/**
 * ═══════════ MỘT TRANG, KHÔNG PHẢI MỘT TRẦN ═══════════
 *
 * Bản cũ có `QUEUE_MAX_ROWS = 300` là TRẦN CỨNG: in ra "còn 54 kiện nữa chưa hiện" rồi hết cách.
 * Đo 19/09/2026: 354 kiện cần đối chiếu, 54 kiện KHÔNG có đường nào mở ra được — và đó không phải
 * 54 kiện tuỳ ý, chúng là 54 kiện ĐỨNG CUỐI theo thứ tự ưu tiên, tức nhóm im lặng lâu nhất.
 *
 * Nay 300 là CỠ MỘT TRANG: người trực bấm "Xem thêm" thì máy chủ trả thêm một trang nữa. Vẫn không
 * đổ cả nghìn dòng vào một lượt (truy vấn này quét toàn bộ kiện đang chạy), nhưng không còn dòng
 * nào nằm ngoài tầm với.
 *
 * Trần tuyệt đối vẫn có, để một lỗi ở tầng trên không thành một câu SQL kéo cả bảng về.
 */
const QUEUE_PAGE_ROWS = 300;
export const RECONCILE_PAGE_SIZE = QUEUE_PAGE_ROWS;
const QUEUE_MAX_PAGES = 20;

/** Mốc tin cuối cùng từ ĐVVC. `VTP_POLL` cố ý vắng mặt: nguồn đó chưa từng sinh ra một sự kiện nào. */
const MOC_DVVC = sql`(select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id and e.source in ('VTP_WEBHOOK','PANCAKE','VTP_IMPORT','VTP_UI_MANUAL_VERIFICATION'))`;

/**
 * Vị ngữ "im lặng quá ngưỡng NGHIÊM TRỌNG của chặng", dựng từ bộ ngưỡng ĐANG CHẠY.
 *
 * Dùng ngưỡng `critical` chứ không phải `stale`, cùng lý lẽ với luật cảnh báo im lặng: đo được
 * 11/09/2026 có 182 kiện quá ngưỡng "cũ" nhưng chỉ 18 vượt ngưỡng nghiêm trọng. Đổ cả 182 vào một
 * danh sách người phải làm tay là giết hàng đợi.
 */
function viNguImLang(overrides: Awaited<ReturnType<typeof getFreshnessConfig>>) {
  const nhanh = Object.keys(FRESHNESS_BY_STAGE).map((stage) => {
    const gio = effectiveThresholdFor(stage, overrides).critical;
    return sql`when s.stage::text = ${stage} then ${gio}::int`;
  });
  return sql`(case ${sql.join(nhanh, sql` `)} else ${FRESHNESS_DEFAULT.critical}::int end)`;
}

export async function getVtpReconcileQueue(trang = 1): Promise<ReconcileQueue> {
  const overrides = await getFreshnessConfig();
  // Trang là một con số đến từ đường dẫn: kẹp nó lại NGAY, trước khi nó thành một phần của câu SQL
  // và của khoá đệm. `?dc=999999` không được phép trở thành một lượt quét cả bảng.
  const soTrang = Math.min(QUEUE_MAX_PAGES, Math.max(1, Number.isFinite(trang) ? Math.trunc(trang) : 1));
  const soDong = soTrang * QUEUE_PAGE_ROWS;
  // Cache 60 s: hàng đợi này quét toàn bộ kiện đang chạy và người trực mở nó vài lần một ca. Khoá
  // cache mang bộ ngưỡng VÀ số trang — thiếu số trang thì bấm "Xem thêm" xong vẫn nhận lại đúng
  // trang cũ trong suốt 60 giây, và nút trông như hỏng.
  return memo(`vtp-reconcile-queue:${soDong}:${JSON.stringify(overrides)}`, 60_000, async () => {
    const db = await getDb();
    const nguong = viNguImLang(overrides);
    const rows = await db.execute<{
      id: string;
      tracking_code: string | null;
      vtp_order_number: string | null;
      stage: string;
      vtp_status_name: string | null;
      vtp_raw_status_name: string | null;
      vtp_sync_source: string | null;
      vtp_last_error: string | null;
      last_carrier_at: string | null;
      hours_silent: number | null;
      critical_hours: number;
      cod_amount: string | number | null;
      receiver_name: string;
      receiver_phone: string;
      care_open: boolean;
      r_sync_error: boolean;
      r_unmapped: boolean;
      r_gap: boolean;
      r_contradiction: boolean;
      r_care_silent: boolean;
      r_stale: boolean;
      total: string | number;
    }>(sql`
      with base as (
        select
          s.id,
          s.tracking_code,
          s.vtp_order_number,
          s.stage::text as stage,
          s.vtp_status_name,
          s.vtp_raw_status_name,
          s.vtp_sync_source,
          s.vtp_last_error,
          s.vtp_raw_mapped,
          s.cod_amount,
          s.receiver_name,
          s.receiver_phone,
          s.is_final,
          ${MOC_DVVC} as last_carrier_at,
          ${nguong} as critical_hours,
          -- Ca care ĐANG MỞ, kèm mốc mở: dùng cho lý do "đội đang care mà ĐVVC không nhúc nhích".
          (select max(c.opened_at) from shipment_care c where c.shipment_id = s.id and c.active = true) as care_opened_at,
          exists (select 1 from shipment_care c where c.shipment_id = s.id and c.active = true) as care_open,
          exists (
            select 1 from vtp_webhook_gaps g
            where g.shipment_id = s.id and g.detected_at >= now() - ${`${GAP_QUEUE_DAYS} days`}::interval
          ) as r_gap
        from shipments s
        -- Việc của hàng đợi này là "một người mở viettelpost.vn tra lại mã này". Kiện không có mã
        -- Viettel Post thì không tra được ở đâu cả — nó là lỗ hổng dữ liệu, thuộc hàng đợi care,
        -- không thuộc đây. Lọc theo MÃ chứ không theo tên hãng: tên hãng là một ô chữ do nhiều
        -- đường ghi đặt, còn mã là thứ người trực thật sự dán vào ô tra cứu.
        where s.vtp_order_number is not null and s.vtp_order_number <> ''
      ),
      danh_gia as (
        select
          b.*,
          case when b.last_carrier_at is null then null
               else extract(epoch from (now() - b.last_carrier_at)) / 3600.0 end as hours_silent,
          -- CHẶNG ĐANG CHẠY vs ĐÃ CHỐT. Ba lý do dưới đây chỉ có nghĩa với kiện đang chạy: một kiện
          -- đã giao xong mà "im lặng" là chuyện hoàn toàn bình thường, đưa nó vào hàng đợi là bắt
          -- người trực tra một thứ không còn đổi được nữa.
          (b.stage in ('PENDING','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED','RETURNING')) as dang_chay,
          (b.stage in ('DELIVERED','RETURNED','CANCELLED')) as da_chot,
          /*
            LỖI ĐỐI CHIẾU ≠ PHÁN QUYẾT PHẠM VI TÀI KHOẢN.

            Đo trên production 16/09/2026: cả 18 dòng mang vtp_last_error đều là ĐÚNG một câu —
            "API không thấy vận đơn này" — tức phán quyết PHẠM VI TÀI KHOẢN, một sự thật cố định của
            2.139/2.151 kiện mà ERP đã biết và đã thôi hỏi. Bản đầu của hàng đợi xếp chúng ở HẠNG
            MỘT dưới nhãn "Lỗi đối chiếu": người trực mở ra, thấy 18 dòng, và KHÔNG CÓ GÌ để làm.

            Một hàng đợi mà dòng đầu tiên không làm được gì là hàng đợi không ai mở lần thứ hai.
            Phán quyết ấy đã có nhà riêng ở cột tracking_capability; ở đây nó bị loại ra.
          */
          (b.vtp_last_error is not null and b.vtp_last_error <> '' and b.vtp_last_error not like ${"%không thấy vận đơn này%"}) as r_sync_error,
          (b.vtp_raw_mapped = false) as r_unmapped
        from base b
      ),
      cham as (
        select
          d.*,
          /*
            MÂU THUẪN ĐI CẢ HAI CHIỀU, và đó là điểm dễ bỏ sót nhất:

             · cờ "đã kết thúc" BẬT nhưng chặng vẫn đang chạy;
             · chặng đã chốt (giao xong / hoàn / huỷ) mà cờ "đã kết thúc" vẫn TẮT — kiện nằm mãi ở
               đầu hàng đợi đối chiếu và không bao giờ rời ra (luật 48).

            Cả hai đều là ERP đang giữ hai điều không thể cùng đúng, và ERP KHÔNG tự biết vế nào sai.
          */
          ((d.is_final and d.dang_chay) or (not d.is_final and d.da_chot)) as r_contradiction,
          (
            d.dang_chay
            and d.care_opened_at is not null
            and d.care_opened_at <= now() - ${`${CARE_SILENCE_HOURS} hours`}::interval
            and (d.last_carrier_at is null or d.last_carrier_at <= d.care_opened_at)
          ) as r_care_silent,
          (
            d.dang_chay
            and (d.last_carrier_at is null or extract(epoch from (now() - d.last_carrier_at)) / 3600.0 >= d.critical_hours)
          ) as r_stale
        from danh_gia d
      ),
      loc as (
        select * from cham
        where r_sync_error or r_unmapped or r_gap or r_contradiction or r_care_silent or r_stale
      )
      select
        l.id, l.tracking_code, l.vtp_order_number, l.stage, l.vtp_status_name, l.vtp_raw_status_name,
        l.vtp_sync_source, l.vtp_last_error, l.last_carrier_at, l.hours_silent, l.critical_hours,
        l.cod_amount, l.receiver_name, l.receiver_phone, l.care_open,
        l.r_sync_error, l.r_unmapped, l.r_gap, l.r_contradiction, l.r_care_silent, l.r_stale,
        /*
          ĐẾM TRÊN TOÀN BỘ TẬP, KHÔNG TRÊN TRANG ĐANG HIỆN.

          Hàm cửa sổ chạy TRƯỚC LIMIT, nên sáu con số dưới đây là của cả tập loc. Bản cũ đếm bằng
          cách duyệt các dòng ĐÃ TRẢ VỀ: với 354 kiện mà chỉ trả 300, mọi chip lý do đều thiếu, và
          thiếu KHÔNG ĐỀU — lý do xếp cuối (im lặng) mất nhiều nhất vì nó bị cắt trước. Người trực
          đọc chip rồi kết luận sai về chỗ nào đang hỏng.
        */
        count(*) over () as total,
        count(*) filter (where l.r_sync_error) over () as c_sync_error,
        count(*) filter (where l.r_unmapped) over () as c_unmapped,
        count(*) filter (where l.r_gap) over () as c_gap,
        count(*) filter (where l.r_contradiction) over () as c_contradiction,
        count(*) filter (where l.r_care_silent) over () as c_care_silent,
        count(*) filter (where l.r_stale) over () as c_stale
      from loc l
      order by
        -- Xếp theo LÝ DO MẠNH NHẤT (số nhỏ đứng trước), rồi tới kiện im lặng lâu nhất.
        (case when l.r_sync_error then 1 when l.r_unmapped then 2 when l.r_contradiction then 3
              when l.r_gap then 4 when l.r_care_silent then 5 else 6 end),
        l.last_carrier_at asc nulls first
      limit ${soDong}
    `);

    const list = rowsOf<Record<string, unknown>>(rows);
    const dau = list[0];
    const so = (k: string) => Number(dau?.[k] ?? 0);
    // Bộ đếm đến từ hàm cửa sổ (toàn bộ tập), KHÔNG từ vòng lặp dưới (chỉ trang đang hiện).
    const counts: Record<ReconcileReason, number> = {
      SYNC_ERROR: so("c_sync_error"),
      UNMAPPED_STATUS: so("c_unmapped"),
      CONTRADICTION: so("c_contradiction"),
      WEBHOOK_GAP: so("c_gap"),
      CARE_WITHOUT_MOVEMENT: so("c_care_silent"),
      STALE_NO_NEWS: so("c_stale"),
    };
    const total = so("total");
    const out: ReconcileRow[] = [];
    for (const raw of list) {
      const reasons: ReconcileReason[] = [];
      if (raw.r_sync_error) reasons.push("SYNC_ERROR");
      if (raw.r_unmapped) reasons.push("UNMAPPED_STATUS");
      if (raw.r_contradiction) reasons.push("CONTRADICTION");
      if (raw.r_gap) reasons.push("WEBHOOK_GAP");
      if (raw.r_care_silent) reasons.push("CARE_WITHOUT_MOVEMENT");
      if (raw.r_stale) reasons.push("STALE_NO_NEWS");
      if (!reasons.length) continue;
      reasons.sort((a, b) => RECONCILE_REASON_RANK[a] - RECONCILE_REASON_RANK[b]);
      const gio = raw.hours_silent === null || raw.hours_silent === undefined ? null : Number(raw.hours_silent);
      out.push({
        id: String(raw.id),
        trackingCode: (raw.tracking_code as string | null) ?? null,
        vtpOrderNumber: (raw.vtp_order_number as string | null) ?? null,
        stage: String(raw.stage),
        vtpStatusName: (raw.vtp_status_name as string | null) ?? null,
        vtpRawStatusName: (raw.vtp_raw_status_name as string | null) ?? null,
        vtpSyncSource: (raw.vtp_sync_source as string | null) ?? null,
        vtpLastError: (raw.vtp_last_error as string | null) ?? null,
        lastCarrierAt: raw.last_carrier_at ? new Date(raw.last_carrier_at as string) : null,
        // Số giờ im lặng là CHƯA BIẾT khi chưa có mốc ĐVVC nào — không phải 0 giờ.
        hoursSilent: gio === null || !Number.isFinite(gio) ? null : Math.round(gio),
        criticalHours: Number(raw.critical_hours ?? FRESHNESS_DEFAULT.critical),
        codAmount: raw.cod_amount === null || raw.cod_amount === undefined ? null : Number(raw.cod_amount),
        receiverName: String(raw.receiver_name ?? ""),
        receiverPhone: String(raw.receiver_phone ?? ""),
        careOpen: Boolean(raw.care_open),
        reasons,
        topReason: reasons[0],
      });
    }
    return { rows: out, total, counts, truncated: Math.max(0, total - out.length), page: soTrang, pageSize: QUEUE_PAGE_ROWS };
  });
}

/**
 * ═══════════ "CHÉP TOÀN BỘ" PHẢI HỎI LẠI CSDL, KHÔNG ĐƯỢC CHÉP CÁI ĐANG HIỆN ═══════════
 *
 * Nút chép trên màn hình chỉ thấy những dòng đã tải. Người trực bấm "chép toàn bộ" là đang nói
 * *"tôi sẽ dán TẤT CẢ mã này sang viettelpost.vn"* — trả về 300 mã trong khi tập thật có 354 thì
 * 54 kiện không bao giờ được tra, và không ai biết, vì con số trên nút vẫn trông hợp lý.
 *
 * Nên hàm này chạy LẠI đúng phép lọc, không `limit`, và chỉ lấy MỘT cột. Lọc theo lý do làm ở máy
 * chủ để "toàn bộ" của nút khớp với "toàn bộ" của chip đang chọn.
 */
export async function getVtpReconcileCodes(reason?: ReconcileReason | "all"): Promise<string[]> {
  const queue = await getVtpReconcileQueue(QUEUE_MAX_PAGES);
  const rows = reason && reason !== "all" ? queue.rows.filter((r) => r.reasons.includes(reason)) : queue.rows;
  return rows.map((r) => r.vtpOrderNumber ?? r.trackingCode ?? "").filter(Boolean);
}
