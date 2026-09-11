import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { TEAM_LABEL } from "@/lib/constants/action-queue";
import { DELIVERY_BUCKETS, EXCLUSIVE_BUCKETS, type BucketKey, type BucketSpec } from "@/lib/constants/delivery-tower";
import { classifyFailedReason } from "@/lib/constants/cs";
import { classifyFreshness, thresholdFor, type FreshnessClass } from "@/lib/constants/logistics-freshness";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { rowsOf } from "@/lib/sql-rows";
import type { ShipmentStage } from "@/db/schema";

/**
 * ═══════════ THÁP ĐIỀU KHIỂN GIAO VẬN ═══════════
 *
 * Một câu hỏi duy nhất: **sáng nay phải động vào kiện nào, và vì sao?**
 *
 * ─── VÌ SAO KHÔNG DÙNG LẠI BẢNG VẬN ĐƠN ───
 *
 * Bảng vận đơn trả lời "kiện X đang ở đâu" — tra cứu. Tháp này trả lời "kiện nào đang cần người" —
 * vận hành. Hai câu khác nhau nên cách xếp cũng khác: bảng xếp theo thời gian, tháp xếp theo MỨC
 * CẦN CAN THIỆP rồi mới tới tiền.
 *
 * ─── LÝ DO GIAO HỤT: DÙNG LẠI BỘ PHÂN LOẠI ĐÃ CÓ ───
 *
 * `classifyFailedReason` đã đọc ghi chú bưu tá từ lâu để soạn tin nhắn. Viết lại một bộ regex thứ
 * hai ở đây sẽ tạo ra hai định nghĩa "khách không nghe máy" lệch nhau, và cái lệch đó chỉ lộ ra khi
 * ai đó đối chiếu hai màn hình. Nên gọi lại đúng hàm đó, và ưu tiên MÃ LÝ DO của ĐVVC khi có —
 * mã là chứng từ, ghi chú là văn bản tự do.
 *
 * ─── TIỀN Ở ĐÂY LÀ TIỀN ĐANG TREO, KHÔNG PHẢI TIỀN SẼ VỀ ───
 *
 * Mỗi rổ khai `moneyMeaning` của riêng nó. Rổ "đang chuyển hoàn" có COD nhưng COD đó đã mất —
 * tiền đáng nói ở đó là giá vốn. Gộp hai thứ vào một con số "tiền cứu được" là bịa.
 */

/** Mã lý do ĐVVC nghĩa là KHÔNG LIÊN LẠC ĐƯỢC (bảng webhook 20–47 và bảng V2 cũ). */
const MA_KHONG_LIEN_LAC = new Set([36, 47, 2]);
/** Mã lý do nghĩa là ĐÃ HẸN LẠI — còn cửa giao, khác hẳn khách từ chối. */
const MA_HEN_LAI = new Set([35, 37, 46, 38, 1, 3]);

export type TowerRow = {
  shipmentId: string;
  bucket: BucketKey;
  tracking: string;
  orderId: string | null;
  orderSystemId: number | null;
  customer: string;
  phone: string;
  codAmount: number;
  /** Trạng thái THÔ của Viettel Post — để đối chiếu với trang ĐVVC, không dịch mất chữ. */
  rawStatus: string;
  rawStatusCode: number | null;
  /** Trạng thái CHUẨN HOÁ của ERP. Hai cột đứng cạnh nhau để lệch là thấy ngay. */
  stage: ShipmentStage;
  stageLabel: string;
  /** Giờ kể từ sự kiện ĐVVC gần nhất. `null` = chưa từng có sự kiện nào. */
  lastEventAgeHours: number | null;
  freshness: FreshnessClass;
  /** Số lần bưu tá giao hụt, đếm từ sự kiện — không phải từ trạng thái hiện tại. */
  failedAttempts: number;
  reasonLabel: string;
  team: string;
  /** Việc CSKH đã làm gần nhất cho kiện này. `null` = chưa ai chạm vào. */
  lastCsAction: string | null;
  lastCsActionAt: Date | null;
  nextAction: string;
};

export type TowerBucket = BucketSpec & {
  teamLabel: string;
  count: number;
  money: number;
  /** Bao nhiêu kiện trong rổ chưa ai chạm tới. Đây mới là việc thật sự đang tồn. */
  untouched: number;
  oldestHours: number | null;
  rows: TowerRow[];
};

export type DeliveryTower = {
  buckets: TowerBucket[];
  /** Tổng kiện đang theo dõi (kể cả kiện bình thường không vào rổ nào). */
  tracked: number;
  /** Kiện nằm trong ít nhất một rổ ngoại lệ. */
  exceptions: number;
  /** Kiện đang chạy đúng lịch, không cần ai động vào. Nói ra để con số ngoại lệ có mẫu số. */
  onTrack: number;
  measuredAt: Date;
};

type Raw = {
  id: string;
  order_id: string | null;
  system_id: number | null;
  tracking: string;
  stage: ShipmentStage;
  vtp_status: number | null;
  vtp_status_name: string | null;
  vtp_note: string | null;
  vtp_reason_code: number | null;
  cod_amount: string | number;
  receiver_name: string;
  receiver_phone: string;
  bill_name: string | null;
  bill_phone: string | null;
  tuoi_gio: string | number | null;
  lan_hut: number;
  cs_action: string | null;
  cs_action_at: string | null;
  event_note: string | null;
};

/** Một kiện rơi vào rổ NÀO — xét theo thứ tự, dừng ở rổ đầu tiên khớp. */
function xepRo(r: Raw, tuoi: number | null, tuoiHang: FreshnessClass): { bucket: BucketKey; reason: string } | null {
  const ma = r.vtp_reason_code;
  const chu = [r.vtp_note, r.event_note, r.vtp_status_name];

  if (r.stage === "DELIVERY_FAILED") {
    // Mã lý do của ĐVVC là CHỨNG TỪ, đứng trên ghi chú tự do của bưu tá.
    if (ma !== null && MA_KHONG_LIEN_LAC.has(ma)) return { bucket: "NO_CONTACT", reason: "Không liên lạc được khách (mã ĐVVC)" };
    if (ma !== null && MA_HEN_LAI.has(ma)) return { bucket: "AWAITING_REDELIVERY", reason: "Đã hẹn phát lại (mã ĐVVC)" };
    const ly = classifyFailedReason(chu);
    if (ly === "NO_CONTACT") return { bucket: "NO_CONTACT", reason: "Bưu tá ghi: không liên lạc được" };
    if (ly === "RESCHEDULED") return { bucket: "AWAITING_REDELIVERY", reason: "Bưu tá ghi: hẹn phát lại" };
    return { bucket: "DELIVERY_FAILED", reason: `Giao hụt · ${ly === "OTHER" ? (r.vtp_status_name ?? "chưa rõ lý do") : ly}` };
  }

  if (r.stage === "RETURNED") return { bucket: "RETURN_AT_SHOP", reason: "ĐVVC đã trả hàng về, kho chưa kiểm đếm" };
  if (r.stage === "RETURNING") return { bucket: "RETURNING", reason: "Đang trên đường về shop" };
  if (r.stage === "UNKNOWN" || tuoi === null) return { bucket: "DATA_GAP", reason: tuoi === null ? "Chưa nhận được sự kiện nào từ ĐVVC" : "Trạng thái ĐVVC chưa dịch được" };

  /*
    ═══ CHỈ "CŨ NGHIÊM TRỌNG" MỚI VÀO RỔ VIỆC ═══

    Kiện mới chớm cũ (AGING/STALE) vẫn được ĐO và hiện ở dải độ tươi, nhưng KHÔNG vào rổ — đưa vào
    thì rổ có 182 dòng và không ai mở nó lần thứ hai. Đo được 11/09/2026: 182 kiện quá ngưỡng cũ,
    trong đó chỉ 18 vượt ngưỡng nghiêm trọng. 18 là số người làm được trong một buổi sáng.
  */
  if (tuoiHang === "CRITICAL_STALE") {
    const t = thresholdFor(r.stage);
    return { bucket: "STALE_NO_UPDATE", reason: `Im lặng ${Math.round(tuoi)} giờ · ngưỡng chặng này là ${t.critical} giờ` };
  }
  return null;
}

export async function getDeliveryTower(): Promise<DeliveryTower> {
  return memo("delivery-tower", 60_000, async () => {
    const db = await getDb();

    /*
      MỘT CÂU CHO CẢ THÁP.

      `is_final = false` bỏ sót đúng một nhóm cần nhìn: kiện đã hoàn về tới shop mà kho chưa đếm —
      với ĐVVC thì xong, với shop thì chưa. Nên điều kiện mở thêm nhánh đó, và CHỈ nhánh đó.
    */
    const rows = rowsOf<Raw>(
      await db.execute(sql`
        select s.id,
               s.order_id,
               o.system_id,
               coalesce(nullif(s.vtp_order_number, ''), nullif(s.tracking_code, ''), s.id) as tracking,
               s.stage::text as stage,
               s.vtp_status,
               s.vtp_status_name,
               s.vtp_note,
               s.vtp_reason_code,
               s.cod_amount,
               s.receiver_name,
               s.receiver_phone,
               o.bill_full_name as bill_name,
               o.bill_phone,
               extract(epoch from (now() - ev.moc)) / 3600 as tuoi_gio,
               coalesce(ev.lan_hut, 0) as lan_hut,
               ev.ghi_chu as event_note,
               cs.resolution as cs_action,
               cs.updated_at as cs_action_at
          from shipments s
          left join orders o on o.id = s.order_id
          left join lateral (
            select max(e.occurred_at) filter (where e.source in ('VTP_WEBHOOK','PANCAKE','VTP_IMPORT','VTP_UI_MANUAL_VERIFICATION')) as moc,
                   count(*) filter (where e.normalized_stage = 'DELIVERY_FAILED')::int as lan_hut,
                   (array_agg(e.note order by e.occurred_at desc) filter (where e.note <> ''))[1] as ghi_chu
              from shipment_events e
             where e.shipment_id = s.id
          ) ev on true
          left join lateral (
            select c.resolution, c.updated_at
              from cs_cases c
             where c.dedupe_key like 'failed-delivery:' || s.id || ':%'
             order by c.updated_at desc
             limit 1
          ) cs on true
         where s.order_id is not null
           /*
             ═══ AI VÀO THÁP ═══

             1. CHỈ VẬN ĐƠN CÓ GẮN ĐƠN. Vận đơn chiều hoàn là dòng riêng với order_id NULL (luật
                vận đơn số 7): hàng thật, nhưng không có khách để gọi, và đường ống hàng hoàn đã
                đếm chúng theo cách riêng. Vận đơn mồ côi có luật riêng ở trang Chất lượng dữ liệu.

             2. Chặng RETURNED xử lý bằng ĐÚNG MỘT nhánh, không để nhánh "chưa kết thúc" bắt lại một
                phần của nó. Điều kiện của nhánh đó lấy y hệt khâu CARRIER_RETURN_DELIVERED của
                đường ống hàng hoàn — lệch một vế là hai màn hình nói hai con số cho cùng một đống
                hàng, và không lỗi nào phát ra.
           */
           and (
             (s.is_final = false and s.stage <> 'RETURNED')
             or (
               s.stage = 'RETURNED'
               and s.return_received_at is null
               and not exists (select 1 from return_inspections ri where ri.shipment_id = s.id)
             )
           )
      `),
    );

    const gio = new Map<BucketKey, TowerRow[]>();
    let ngoaiLe = 0;

    for (const r of rows) {
      const tuoi = r.tuoi_gio === null || r.tuoi_gio === undefined ? null : Number(r.tuoi_gio);
      const hang = classifyFreshness(tuoi, r.stage);
      const xep = xepRo(r, tuoi, hang);
      if (!xep) continue;
      ngoaiLe += 1;
      const spec = DELIVERY_BUCKETS.find((b) => b.key === xep.bucket)!;
      const row: TowerRow = {
        shipmentId: r.id,
        bucket: xep.bucket,
        tracking: r.tracking,
        orderId: r.order_id,
        orderSystemId: r.system_id === null || r.system_id === undefined ? null : Number(r.system_id),
        customer: r.bill_name || r.receiver_name || "Khách chưa có tên",
        phone: r.bill_phone || r.receiver_phone || "",
        codAmount: Number(r.cod_amount ?? 0),
        rawStatus: r.vtp_status_name || (r.vtp_status === null ? "Chưa có trạng thái" : `Mã ${r.vtp_status}`),
        rawStatusCode: r.vtp_status,
        stage: r.stage,
        stageLabel: SHIPMENT_STAGE_LABEL[r.stage] ?? r.stage,
        lastEventAgeHours: tuoi,
        freshness: hang,
        failedAttempts: Number(r.lan_hut ?? 0),
        reasonLabel: xep.reason,
        team: TEAM_LABEL[spec.team],
        lastCsAction: r.cs_action && r.cs_action.trim() ? r.cs_action.trim() : null,
        lastCsActionAt: r.cs_action_at ? new Date(r.cs_action_at) : null,
        nextAction: spec.nextAction,
      };
      const cur = gio.get(xep.bucket) ?? [];
      cur.push(row);
      gio.set(xep.bucket, cur);
    }

    // Trong một rổ: tiền lớn trước, rồi tới kiện im lâu nhất. Người làm buổi sáng đi từ trên xuống.
    const sapXep = (xs: TowerRow[]) => xs.sort((a, b) => b.codAmount - a.codAmount || (b.lastEventAgeHours ?? 1e9) - (a.lastEventAgeHours ?? 1e9));

    const buckets: TowerBucket[] = DELIVERY_BUCKETS.map((spec) => {
      const rs = spec.rollupOf ? sapXep(spec.rollupOf.flatMap((k) => gio.get(k) ?? []).slice()) : sapXep(gio.get(spec.key) ?? []);
      const tuoiCo = rs.map((r) => r.lastEventAgeHours).filter((h): h is number => h !== null);
      return {
        ...spec,
        teamLabel: TEAM_LABEL[spec.team],
        count: rs.length,
        money: rs.reduce((a, r) => a + r.codAmount, 0),
        untouched: rs.filter((r) => !r.lastCsAction).length,
        oldestHours: tuoiCo.length ? Math.max(...tuoiCo) : null,
        rows: rs,
      };
    });

    return {
      buckets,
      tracked: rows.length,
      exceptions: ngoaiLe,
      onTrack: rows.length - ngoaiLe,
      measuredAt: new Date(),
    };
  });
}

/** Tổng kiểm: các rổ THẬT phải cộng đúng bằng số kiện ngoại lệ. Rổ tổng hợp không được cộng vào. */
export function tongRoThat(t: DeliveryTower): number {
  const keys = new Set(EXCLUSIVE_BUCKETS.map((b) => b.key));
  return t.buckets.filter((b) => keys.has(b.key)).reduce((a, b) => a + b.count, 0);
}
