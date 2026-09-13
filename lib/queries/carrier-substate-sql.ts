/**
 * ═══════════ CÙNG MỘT LUẬT, HAI NGÔN NGỮ — VÀ CHỈ MỘT BẢN KHAI ═══════════
 *
 * `lib/constants/carrier-substate.ts` là luật, viết bằng TypeScript, chạy trên từng dòng đã lấy về.
 * Nhưng trang chủ cần ĐẾM theo rổ trên hàng nghìn đơn: kéo hết về rồi đếm bằng JavaScript là sai
 * cách. Nên luật phải chạy được cả trong Postgres.
 *
 * Chỗ này KHÔNG chép lại luật. Nó DỰNG câu SQL từ chính các bảng hằng số kia, nên sửa một mã hay
 * thêm một mẫu chữ thì cả hai phía đổi cùng lúc — không có bản nào tụt lại. `tests/carrier-substate.test.ts`
 * chạy cùng một bộ dữ liệu qua cả hai đường và bắt buộc chúng ra cùng kết quả.
 */
import { sql, type SQL } from "drizzle-orm";
import { SUBSTATE_TEXT_RULES, VTP_CODE_TO_SUBSTATE, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { FULFILLMENT_BUCKETS, type FulfillmentBucket } from "@/lib/constants/fulfillment-bucket";

/**
 * BỎ DẤU TRONG POSTGRES.
 *
 * Không dùng `unaccent`: đó là EXTENSION, phải cài trên máy chủ, và bộ kiểm thử chạy trên PGlite
 * nơi nó không có sẵn. `translate()` là hàm lõi, có ở mọi bản Postgres, và với bảng chữ cái tiếng
 * Việt thì nó cho đúng kết quả như `boDau()` bên TypeScript — cùng 67 ký tự, cùng thứ tự.
 */
const NGUYEN_AM_CO_DAU = "áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ";
const NGUYEN_AM_KHONG_DAU = "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd";

export function boDauSql(bieuThuc: SQL | SQL.Aliased): SQL {
  return sql`translate(lower(coalesce(${bieuThuc}, '')), ${NGUYEN_AM_CO_DAU}, ${NGUYEN_AM_KHONG_DAU})`;
}

/** Escape ký tự đặc biệt của `like` trong một mẫu do hằng số sinh ra. */
function mauLike(m: string): string {
  return `%${m.replace(/([%_\\])/g, "\\$1")}%`;
}

/**
 * TRẠNG THÁI CON CỦA MỘT VẬN ĐƠN, tính trong Postgres.
 *
 * Thứ tự y hệt bản TypeScript: MÃ trước (mạnh nhất, không mơ hồ), CHỮ sau, `stage` chỉ là lưới an
 * toàn cuối cùng, và không rõ thì trả `UNKNOWN` chứ không im lặng quy về "giao hỏng".
 */
export function carrierSubstateSql(ma: SQL | SQL.Aliased, chu: SQL | SQL.Aliased, chang: SQL | SQL.Aliased): SQL {
  const theoMa = Object.entries(VTP_CODE_TO_SUBSTATE).map(([code, s]) => sql`when ${ma} = ${Number(code)} then ${s}`);
  const daBoDau = boDauSql(chu);
  const theoChu = SUBSTATE_TEXT_RULES.map(
    (luat) => sql`when ${sql.join(luat.match.map((m) => sql`${daBoDau} like ${mauLike(m)}`), sql` or `)} then ${luat.substate}`,
  );
  const theoChang: [string, CarrierSubstate][] = [
    ["PENDING", "AWAITING_PICKUP"],
    ["PICKED_UP", "PICKED_UP"],
    ["IN_TRANSIT", "IN_TRANSIT"],
    ["OUT_FOR_DELIVERY", "OUT_FOR_DELIVERY"],
    ["DELIVERED", "DELIVERED"],
    ["DELIVERY_FAILED", "DELIVERY_EXCEPTION"],
    ["RETURNING", "RETURNING"],
    ["RETURNED", "RETURNED"],
    ["CANCELLED", "CANCELLED"],
  ];
  const chang2 = theoChang.map(([st, s]) => sql`when ${chang} = ${st} then ${s}`);

  return sql`case
    ${sql.join(theoMa, sql` `)}
    ${sql.join(theoChu.map((c) => sql`${c}`), sql` `)}
    ${sql.join(chang2, sql` `)}
    else 'UNKNOWN' end`;
}

/**
 * RỔ GIAO VẬN CỦA MỘT DÒNG VẬN ĐƠN ĐÃ CHỌN, tính trong Postgres.
 *
 * `coDauVetDvvc` là vế "có mã vận đơn / mã tra cứu / sự kiện hành trình nào không" — cùng nghĩa với
 * `HAS_CARRIER_LINK` của `lib/queries/return-rate.ts`. Không có nó thì rổ là CHƯA BIẾT, đúng như
 * bản TypeScript, chứ không phải "đang gửi".
 *
 * `changDon` (trạng thái Pancake) CHỈ được dùng cho hai vế cuối: đơn huỷ/xoá, và đơn chưa có vận
 * đơn nào. Không vế nào khác đọc nó.
 *
 * `daRoiKho` là CHỨNG TỪ rời kho (mốc lấy hàng, hoặc sự kiện hành trình sau mốc lấy) — chỉ dùng cho
 * trạng thái con MƠ HỒ, xem `DaCamHang` ở `lib/constants/carrier-substate.ts`.
 */
export function fulfillmentBucketSql(input: { ma: SQL | SQL.Aliased; chu: SQL | SQL.Aliased; chang: SQL | SQL.Aliased; coDauVetDvvc: SQL; coVanDon: SQL; changDon: SQL | SQL.Aliased; daRoiKho: SQL }): SQL {
  const huyTrenPancake = sql`${input.changDon} in ('CANCELLED','DELETED')`;
  const con = carrierSubstateSql(input.ma, input.chu, input.chang);
  return sql`case
    when not ${input.coVanDon} then (case when ${huyTrenPancake} then 'CANCELLED' else 'NOT_SHIPPED' end)
    when not ${input.coDauVetDvvc} then (case when ${huyTrenPancake} then 'CANCELLED' else 'UNKNOWN' end)
    when ${con} in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','WAITING_REDELIVERY','DELIVERY_EXCEPTION') then 'IN_FLIGHT'
    -- MƠ HỒ: "chờ xử lý" nằm ở CẢ HAI phía mốc lấy hàng, nên chứng từ quyết định chứ không phải chữ.
    when ${con} = 'WAITING_PROCESSING' then (case when ${input.daRoiKho} then 'IN_FLIGHT' else 'NOT_SHIPPED' end)
    when ${con} = 'AWAITING_PICKUP' then 'NOT_SHIPPED'
    when ${con} = 'PICKUP_FAILED' then 'PICKUP_FAILED'
    when ${con} = 'DELIVERED' then 'DELIVERED'
    when ${con} = 'RETURNING' then 'RETURNING'
    when ${con} = 'RETURNED' then 'RETURNED'
    when ${con} = 'CANCELLED' then 'CANCELLED'
    else 'UNKNOWN' end`;
}

/** Danh sách rổ, để câu đếm sinh đúng một cột cho mỗi rổ và không rổ nào bị bỏ quên. */
export const BUCKET_KEYS: readonly FulfillmentBucket[] = FULFILLMENT_BUCKETS;
