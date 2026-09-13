import { sql } from "drizzle-orm";
import { careEntryFor, LEFT_WAREHOUSE_EVENT_STAGES } from "@/lib/care/entry";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { TEAM_LABEL } from "@/lib/constants/action-queue";
import { CARE_ACTION_LABEL, DELIVERY_BUCKETS, EXCLUSIVE_BUCKETS, type BucketKey, type BucketSpec, type CareActionKind } from "@/lib/constants/delivery-tower";
import { CARRIER_SUBSTATE_LABEL, carrierSubstate, type CarrierSubstate } from "@/lib/constants/carrier-substate";
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
  /**
   * CHIỀU THỨ HAI, ĐỘC LẬP VỚI `stage`: ĐVVC đang làm gì với kiện này.
   *
   * `stage` gộp ba tình huống khác hẳn nhau vào `DELIVERY_FAILED` và hai tình huống vào `PENDING`.
   * Trạng thái con tách chúng ra mà KHÔNG đụng vào enum canonical — xem lib/constants/carrier-substate.ts.
   */
  carrierSubstate: CarrierSubstate;
  carrierSubstateLabel: string;
  /** Kết luận trạng thái con dựa vào đâu: mã ĐVVC, chữ, chặng ERP, hay không rõ. */
  substateBasis: "code" | "text" | "stage" | "unknown";
  /** CHỨNG TỪ nói gói hàng đã rời kho — không suy từ câu chữ. */
  leftWarehouse: boolean;
  /** Giờ kể từ sự kiện ĐVVC gần nhất. `null` = chưa từng có sự kiện nào. */
  lastEventAgeHours: number | null;
  freshness: FreshnessClass;
  /** Số lần bưu tá giao hụt, đếm từ sự kiện — không phải từ trạng thái hiện tại. */
  failedAttempts: number;
  reasonLabel: string;
  team: string;
  /** Việc CSKH đã làm gần nhất cho kiện này. `null` = chưa ai chạm vào. */
  lastCsAction: string | null;
  /** Người ghi hay bot ghi. Bot nhắn một tin KHÔNG thay được một cuộc gọi — hai việc khác nhau. */
  lastCsActionByHuman: boolean;
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
  cs_boi_nguoi: boolean | null;
  event_note: string | null;
  da_roi_kho: boolean | null;
};

/**
 * ═══════════ MỘT KIỆN RƠI VÀO RỔ NÀO ═══════════
 *
 * Xét theo THỨ TỰ, dừng ở rổ đầu tiên khớp. Căn cứ là TRẠNG THÁI CON của ĐVVC, không phải `stage`.
 *
 * ─── VÌ SAO ĐỔI ───
 *
 * `stage` chỉ có mười giá trị. Ba tình huống cần ba cách xử lý khác nhau đang mang cùng một nhãn
 * `DELIVERY_FAILED`, và hai tình huống nữa mang cùng nhãn `PENDING`. Đo production 13/09/2026:
 *
 *   "Chờ phát lại"                       39 vận đơn · 38 đã có bằng chứng lấy hàng
 *   "Tồn - Khách hàng nghỉ, không có nhà" 11 vận đơn · cùng nhãn DELIVERY_FAILED với dòng trên
 *   "Chờ xử lý" / "Đơn hàng chờ xử lý"   225 vận đơn · 56 đã rời kho, nhưng ERP ghi PENDING
 *
 * 56 kiện cuối là gói hàng đã đi khỏi kho, đang nằm chờ ở bưu cục, và **không xuất hiện trong tháp
 * này** — vì `PENDING` không khớp nhánh nào và chưa đủ cũ để vào rổ "quá lâu". Chúng cần người gọi
 * bưu cục, và trước bản này không ai biết chúng tồn tại.
 */
function xepRo(r: Raw, tuoi: number | null, tuoiHang: FreshnessClass, con: CarrierSubstate, daRoiKho: boolean): { bucket: BucketKey; reason: string } | null {
  const ma = r.vtp_reason_code;
  const chu = [r.vtp_note, r.event_note, r.vtp_status_name];

  // ĐÃ HẸN PHÁT LẠI — còn cửa giao, và việc của shop là NHẮC KHÁCH, không phải xử lý sự cố.
  if (con === "WAITING_REDELIVERY") return { bucket: "AWAITING_REDELIVERY", reason: `ĐVVC ghi “${r.vtp_status_name || "chờ phát lại"}”` };

  // VƯỚNG KHI ĐANG PHÁT — phân loại tiếp theo lý do, vì mỗi lý do một việc khác nhau.
  if (con === "DELIVERY_EXCEPTION") {
    // Mã lý do của ĐVVC là CHỨNG TỪ, đứng trên ghi chú tự do của bưu tá.
    if (ma !== null && MA_KHONG_LIEN_LAC.has(ma)) return { bucket: "NO_CONTACT", reason: "Không liên lạc được khách (mã ĐVVC)" };
    if (ma !== null && MA_HEN_LAI.has(ma)) return { bucket: "AWAITING_REDELIVERY", reason: "Đã hẹn phát lại (mã ĐVVC)" };
    const ly = classifyFailedReason(chu);
    if (ly === "NO_CONTACT") return { bucket: "NO_CONTACT", reason: "Bưu tá ghi: không liên lạc được" };
    if (ly === "RESCHEDULED") return { bucket: "AWAITING_REDELIVERY", reason: "Bưu tá ghi: hẹn phát lại" };
    return { bucket: "DELIVERY_FAILED", reason: `Giao hụt · ${ly === "OTHER" ? (r.vtp_status_name ?? "chưa rõ lý do") : ly}` };
  }

  if (con === "RETURNED") return { bucket: "RETURN_AT_SHOP", reason: "ĐVVC đã trả hàng về, kho chưa kiểm đếm" };
  if (con === "RETURNING") return { bucket: "RETURNING", reason: "Đang trên đường về shop" };

  /*
    ĐVVC ĐỂ TREO — và chỉ khi CHỨNG TỪ nói gói hàng đã rời kho.

    "Chờ xử lý" xuất hiện ở CẢ HAI phía mốc lấy hàng: 169/225 mang mã 102 (dải tạo đơn / điều phối
    bưu tá — hàng còn trong kho), 56 cái đã có mốc lấy và sự kiện sau đó. Đưa cả 225 vào rổ việc là
    bắt người gọi bưu cục về những gói còn nằm trong chính kho của mình.
  */
  // CÙNG MỘT LUẬT với vòng đời care (`careEntryFor`): tháp và hàng đợi không được nói hai điều khác nhau.
  if (con === "WAITING_PROCESSING" && careEntryFor(con, daRoiKho).enters) return { bucket: "WAITING_CARRIER", reason: `Đã rời kho nhưng ĐVVC ghi “${r.vtp_status_name || "chờ xử lý"}”` };

  if (con === "UNKNOWN" || tuoi === null) return { bucket: "DATA_GAP", reason: tuoi === null ? "Chưa nhận được sự kiện nào từ ĐVVC" : "Trạng thái ĐVVC chưa dịch được" };

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
        /*
          VIỆC CSKH ĐÃ LÀM GOM TRONG MỘT LƯỢT QUÉT, không hỏi lại cho từng kiện.

          Bản đầu dùng lateral với điều kiện 'failed-delivery:' || s.id || ':%'. Vế phải KHÔNG phải
          hằng số lúc lập kế hoạch, nên Postgres không dùng được index tiền tố: mỗi kiện một lần
          quét bảng case. 554 kiện là 554 lượt quét cho một màn hình mở mỗi sáng.

          Nay quét MỘT lần, tách mã vận đơn ra khỏi khoá chống trùng rồi nối bình thường.
        */
        with cham as (
          select sid, nhan, luc from (
            select split_part(c.dedupe_key, ':', 2) as sid,
                   c.resolution as nhan,
                   c.updated_at as luc,
                   row_number() over (partition by split_part(c.dedupe_key, ':', 2) order by c.updated_at desc) as hang
              from cs_cases c
             where c.dedupe_key like 'failed-delivery:%'
          ) t where hang = 1
        ),
        nguoi as (
          -- Việc NGƯỜI ghi đứng trên việc bot ghi: bot nhắn một tin không thay được một cuộc gọi.
          select sid, nhan, luc from (
            select a.shipment_id as sid,
                   a.kind as nhan,
                   a.created_at as luc,
                   row_number() over (partition by a.shipment_id order by a.created_at desc) as hang
              from care_actions a
          ) t where hang = 1
        )
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
               /*
                 CHỨNG TỪ RỜI KHO — hai bậc, cả hai đều là chứng từ của ĐVVC:
                   1. mốc lấy hàng;
                   2. một sự kiện hành trình mang chặng SAU mốc lấy.
                 KHÔNG suy từ câu chữ trạng thái: "chờ xử lý" nằm ở cả hai phía mốc lấy hàng.
               */
               (s.picked_up_at is not null or ev.co_chang_sau_lay) as da_roi_kho,
               ev.ghi_chu as event_note,
               coalesce(nguoi.nhan, cham.nhan) as cs_action,
               coalesce(nguoi.luc, cham.luc) as cs_action_at,
               (nguoi.sid is not null) as cs_boi_nguoi
          from shipments s
          left join orders o on o.id = s.order_id
          left join lateral (
            select max(e.occurred_at) filter (where e.source in ('VTP_WEBHOOK','PANCAKE','VTP_IMPORT','VTP_UI_MANUAL_VERIFICATION')) as moc,
                   count(*) filter (where e.normalized_stage = 'DELIVERY_FAILED')::int as lan_hut,
                   (array_agg(e.note order by e.occurred_at desc) filter (where e.note <> ''))[1] as ghi_chu,
                   bool_or(e.normalized_stage in ${LEFT_WAREHOUSE_EVENT_STAGES}) as co_chang_sau_lay
              from shipment_events e
             where e.shipment_id = s.id
          ) ev on true
          left join cham on cham.sid = s.id
          left join nguoi on nguoi.sid = s.id
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
      const { substate, basis } = carrierSubstate({ code: r.vtp_status, text: r.vtp_status_name, stage: r.stage });
      const daRoiKho = Boolean(r.da_roi_kho);
      const xep = xepRo(r, tuoi, hang, substate, daRoiKho);
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
        carrierSubstate: substate,
        carrierSubstateLabel: CARRIER_SUBSTATE_LABEL[substate],
        substateBasis: basis,
        leftWarehouse: daRoiKho,
        lastEventAgeHours: tuoi,
        freshness: hang,
        failedAttempts: Number(r.lan_hut ?? 0),
        reasonLabel: xep.reason,
        team: TEAM_LABEL[spec.team],
        lastCsAction: r.cs_action && r.cs_action.trim() ? (r.cs_boi_nguoi ? (CARE_ACTION_LABEL[r.cs_action as CareActionKind] ?? r.cs_action) : r.cs_action.trim()) : null,
        lastCsActionByHuman: Boolean(r.cs_boi_nguoi),
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
