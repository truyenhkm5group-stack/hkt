/**
 * ẢNH CHỤP KPI ĐỂ ĐỐI CHIẾU TRƯỚC / SAU MỖI LẦN DEPLOY.
 *
 * Vì sao cần: chính sách phát hành đòi "deploy không được tự làm đổi sự thật nghiệp vụ". Muốn khẳng
 * định điều đó thì phải có CÙNG MỘT phép đo chạy trước và sau, chứ không phải hai câu SQL gõ tay ở
 * hai thời điểm.
 *
 * NGUYÊN TẮC: script này KHÔNG tự định nghĩa công thức nào. Nó dùng lại `ORDER_OUTCOME` —
 * nguồn sự thật duy nhất của kết quả đơn (docs/business-rules/ORDER_OUTCOME.md). Viết lại điều kiện
 * ở đây là tạo ra một con số thứ hai cho cùng một chỉ số, đúng thứ mà đặc tả cấm.
 *
 * CHỈ ĐỌC. Không ghi bất cứ thứ gì.
 *
 * Dùng qua ops: Actions → "Vận hành ERP trên VPS" → kpi-snapshot
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";

const o = schema.orders;
const s = schema.shipments;

async function main() {
  const db = await getDb();

  /*
   * ── Phân bố kết quả đơn: con số quan trọng nhất, và là con số dễ bị đổi ngầm nhất ──
   *
   * MỖI ĐƠN MỘT DÒNG — `PRIMARY_ATTEMPT`. Nối trần `shipments.order_id = orders.id` sinh MỘT DÒNG
   * MỖI LẦN GỬI, nên một đơn gửi lại rơi vào HAI ô kết quả cùng lúc: `count(distinct o.id)` khử
   * trùng BÊN TRONG từng ô, nhưng không ai khử trùng GIỮA các ô. Tổng các phần khi ấy LỚN HƠN
   * tổng — đúng chiều lệch đã đo trên production 19/09/2026: tổng 3.132 đơn, các ô cộng lại 3.158,
   * thừa 26.
   *
   * 26 đơn ấy đều cùng một hình: hai lần gửi, một lần còn `AWAITING_PICKUP` và một lần đã đi tiếp
   * (11 `DELIVERED` · 14 `IN_TRANSIT` · 1 `RETURNED`). Đo cùng ngày: 31 đơn có nhiều lần gửi, và
   * với `PRIMARY_ATTEMPT` thì 0 đơn còn ra khác một dòng.
   *
   * Đây KHÔNG phải "thiếu một ô kết quả" như lời báo lỗi cũ đoán — xem lại lời báo ở cuối hàm.
   */
  const [outcome] = await db
    .select({
      tong: sql<number>`count(distinct ${o.id})`,
      delivered: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'RETURNED')`,
      returnedByRule: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'RETURNED_BY_RULE')`,
      inTransit: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      // THÊM MỘT KẾT QUẢ MÀ QUÊN THÊM VÀO ĐÂY = ẢNH CHỤP KHÔNG THẤY NÓ.
      //
      // `AWAITING_PICKUP` sinh ra ngày 13/09/2026 và ảnh chụp này không có ô cho nó, nên 106 đơn
      // biến mất khỏi phép cộng: `tong` không còn bằng tổng các phần, và đúng cái lô mà bản phát
      // hành ấy tạo ra để nhìn thấy thì lại vô hình với công cụ dùng để kiểm chứng nó.
      //
      // Bất biến `tong = tổng các phần` được kiểm ngay trong script (xem cuối hàm) — lần sau thêm
      // kết quả mà quên ô thì script BÁO ĐỎ, không phải im lặng đếm thiếu.
      awaitingPickup: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'AWAITING_PICKUP')`,
      unknown: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'UNKNOWN')`,
      notShipped: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'NOT_SHIPPED')`,
      cancelled: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
    })
    .from(o)
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT));

  // ── Ba con số tiền, tách bạch theo đúng luật: lên đơn ≠ giao thành công ≠ thực nhận ──
  const [money] = await db
    .select({
      booked: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`,
      delivered: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      // Tiền CÓ CHỨNG TỪ, không phải COD khai báo.
      cash: sql<number>`coalesce(sum(coalesce(nullif(${s.codCollected}, 0), 0) + coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0)) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      codPending: sql<number>`coalesce(sum(coalesce(${s.codAmount}, 0)) filter (where ${ORDER_OUTCOME} = 'DELIVERED' and coalesce(${s.codCollected}, 0) = 0), 0)`,
    })
    .from(o)
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT));

  // ── Vài con số nền để phát hiện lệch dữ liệu, không phải lệch công thức ──
  const [scale] = await db
    .select({
      orders: sql<number>`(select count(*) from orders)`,
      shipments: sql<number>`(select count(*) from shipments)`,
      shipmentEvents: sql<number>`(select count(*) from shipment_events)`,
      openNotifications: sql<number>`(select count(*) from notifications where resolved_at is null)`,
      returnsPending: sql<number>`(select count(*) from shipments where stage::text = 'RETURNED' and return_received_at is null and order_id is not null)`,
    })
    .from(sql`(select 1) as x`);

  const delivered = Number(outcome?.delivered ?? 0);
  const returnedAll = Number(outcome?.returned ?? 0) + Number(outcome?.returnedByRule ?? 0);
  const settled = delivered + returnedAll;

  /**
   * ─── BẤT BIẾN: TỔNG PHẢI BẰNG TỔNG CÁC PHẦN ───
   *
   * Đây là thứ lẽ ra phải bắt được lỗi thiếu `AWAITING_PICKUP` ngay hôm nó sinh ra. Một ảnh chụp
   * dùng để chứng minh "deploy không làm đổi sự thật nghiệp vụ" mà tự nó đếm thiếu một lô thì
   * chứng minh sai — và không có gì đỏ lên, vì mỗi con số riêng lẻ vẫn đúng.
   *
   * Ném lỗi chứ không cảnh báo: ảnh chụp sai còn tệ hơn không có ảnh chụp nào.
   */
  const cacPhan =
    delivered +
    returnedAll +
    Number(outcome?.inTransit ?? 0) +
    Number(outcome?.awaitingPickup ?? 0) +
    Number(outcome?.unknown ?? 0) +
    Number(outcome?.notShipped ?? 0) +
    Number(outcome?.cancelled ?? 0);
  const tong = Number(outcome?.tong ?? 0);
  if (cacPhan !== tong) {
    /*
     * HAI CHIỀU LỆCH, HAI NGUYÊN NHÂN KHÁC HẲN NHAU — và lời báo phải nói đúng cái nào.
     *
     * Bản đầu chỉ viết cho chiều THIẾU ("thêm ô vào khối ket_qua_don"). Ngày 19/09/2026 nó đỏ với
     * chiều NGƯỢC LẠI (thừa 26) và vẫn khuyên thêm ô — một lời khuyên đẩy người đọc đi đúng hướng
     * sai. Một thông báo lỗi tự tin mà sai còn tốn thời gian hơn không có thông báo nào.
     */
    const thua = cacPhan - tong;
    throw new Error(
      thua > 0
        ? `Ảnh chụp KPI đếm THỪA: tổng ${tong} đơn nhưng các ô cộng lại ${cacPhan} (thừa ${thua}). ` +
          `Một đơn đang rơi vào NHIỀU ô cùng lúc — gần như chắc chắn truy vấn nối orders↔shipments mà thiếu ` +
          `\`PRIMARY_ATTEMPT\`, nên đơn gửi lại nhiều lần sinh nhiều dòng. Kiểm câu SQL, ĐỪNG thêm ô.`
        : `Ảnh chụp KPI đếm THIẾU: tổng ${tong} đơn nhưng các ô cộng lại ${cacPhan} (thiếu ${-thua}). ` +
          `Gần như chắc chắn ORDER_OUTCOME có thêm một kết quả mới mà script này chưa có ô cho nó — thêm ô vào khối "ket_qua_don".`,
    );
  }

  console.log(
    JSON.stringify(
      {
        chup_luc: new Date().toISOString(),
        ket_qua_don: {
          tong: Number(outcome?.tong ?? 0),
          giao_thanh_cong: delivered,
          hoan: Number(outcome?.returned ?? 0),
          hoan_theo_luat: Number(outcome?.returnedByRule ?? 0),
          dang_giao: Number(outcome?.inTransit ?? 0),
          cho_dvvc_lay: Number(outcome?.awaitingPickup ?? 0),
          chua_ro: Number(outcome?.unknown ?? 0),
          chua_gui: Number(outcome?.notShipped ?? 0),
          huy: Number(outcome?.cancelled ?? 0),
        },
        // Mẫu số là đơn ĐÃ KẾT THÚC — không phải tổng đơn.
        gtc_phan_tram: settled > 0 ? Math.round((delivered / settled) * 1000) / 10 : null,
        tien: {
          len_don: Number(money?.booked ?? 0),
          giao_thanh_cong: Number(money?.delivered ?? 0),
          thuc_nhan_co_chung_tu: Number(money?.cash ?? 0),
          cod_dang_cho: Number(money?.codPending ?? 0),
        },
        quy_mo: {
          don: Number(scale?.orders ?? 0),
          van_don: Number(scale?.shipments ?? 0),
          su_kien_van_don: Number(scale?.shipmentEvents ?? 0),
          viec_dang_mo: Number(scale?.openNotifications ?? 0),
          hoan_cho_kiem_dem: Number(scale?.returnsPending ?? 0),
        },
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
