import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import type { OrderStage } from "@/db/schema";
import { memo } from "@/lib/cache";
import { rowsOf } from "@/lib/sql-rows";
import { getSettingJson } from "@/lib/settings";
import { DEAD_ORDER_STAGES, PRE_SHIP_STAGES } from "@/lib/constants/pancake";
import { toDate } from "@/lib/format";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import {
  assessDuplicate,
  DEFAULT_DUPLICATE_RULE,
  DUPLICATE_SETTING_KEY,
  DUPLICATE_SIGNAL_LABEL,
  DUPLICATE_VERDICT_ACTION,
  orderPair,
  phoneKey,
  type DuplicateCandidate,
  type DuplicateRule,
  type DuplicateSignalKey,
  type DuplicateVerdict,
  type ItemLike,
} from "@/lib/constants/order-duplicate";

/**
 * ═══════════ HÀNG ĐỢI ĐƠN NGHI TRÙNG ═══════════
 *
 * Đặc tả và toàn bộ luật nằm ở `lib/constants/order-duplicate.ts`. Tệp này CHỈ lấy dữ liệu và gọi
 * `assessDuplicate()` — không một điều kiện nghiệp vụ nào được viết lại ở đây.
 *
 * ─── MỘT ĐƠN NGHI TRÙNG SINH ĐÚNG MỘT VIỆC ───
 *
 * Ba đơn giống hệt nhau của một khách có ba cặp, nhưng chỉ có HAI việc phải làm — hai đơn đặt sau.
 * Nên mỗi đơn NGHI (đơn đặt sau) sinh đúng một dòng, trỏ về đơn GIỮ mạnh nhất khớp với nó. Nếu phát
 * một dòng cho mỗi cặp thì hàng đợi phình theo bình phương và người trực phải gọi khách ba lần cho
 * cùng một chuyện — đúng cái mà yêu cầu "không tạo duplicate task" cấm.
 *
 * ─── PHẢI CÒN LÀM ĐƯỢC GÌ ĐÓ ───
 *
 * Chỉ báo khi đơn NGHI còn chưa rời kho. Hai đơn trùng đã giao xong cả hai thì đó là chuyện của
 * báo cáo hoàn, không phải việc của hôm nay — và một hàng đợi đầy việc không làm được nữa là hàng
 * đợi không ai mở lần thứ hai.
 *
 * Đơn GIỮ thì KHÔNG bị giới hạn như vậy: trường hợp nguy hiểm nhất là một đơn đã gửi đi rồi và một
 * đơn y hệt đang chuẩn bị gói.
 */


/** Trần an toàn cho một lượt quét. Vượt trần thì nói ra, không lặng lẽ cắt. */
const MAX_DUPLICATE_SCAN = 4_000;

export type DuplicateOrderRow = {
  /** Đơn ĐẶT SAU — đơn cần người xem. */
  suspectOrderId: string;
  suspectSystemId: number | null;
  suspectStage: OrderStage;
  suspectInsertedAt: Date;
  suspectTotal: number;
  /** Đơn ĐẶT TRƯỚC — theo luật của chủ shop, đây là bản được giữ nếu hoá ra trùng thật. */
  keeperOrderId: string;
  keeperSystemId: number | null;
  keeperStage: OrderStage;
  keeperInsertedAt: Date;
  keeperTotal: number;
  /** Đơn giữ đã rời kho chưa — nếu rồi thì việc này gấp: một gói đang đi, một gói sắp đi. */
  keeperShipped: boolean;
  customer: string;
  phone: string;
  verdict: Exclude<DuplicateVerdict, "DISTINCT">;
  signals: DuplicateSignalKey[];
  signalLabels: string[];
  why: string;
  nextAction: string;
  /** Số giờ giữa hai đơn. Càng gần nhau càng giống một lần bấm hai lần. */
  gapHours: number;
  /** Tiền của đơn NGHI — phần sẽ mất hai chiều cước nếu đúng là trùng mà vẫn gửi đi. */
  atRisk: number;
  /** Link chat Pancake của đơn nghi, nếu có — để gọi khách ngay từ hàng đợi. */
  chatUrl: string | null;
};

export type DuplicateOrderQueue = {
  rows: DuplicateOrderRow[];
  /** Luật đang áp dụng — màn hình phải in ra, vì một hàng đợi rỗng do TẮT luật khác hẳn hàng đợi sạch. */
  rule: DuplicateRule;
  suspected: number;
  possible: number;
  atRisk: number;
  /** Số đơn đã xét. Mẫu số cho mọi tỷ lệ — không có nó thì con số bắt được vô nghĩa. */
  scanned: number;
  capped: boolean;
  measuredAt: Date;
};

type OrderRaw = {
  id: string;
  system_id: number | null;
  bill_full_name: string;
  bill_phone: string;
  ship_address: string;
  total: string | number | null;
  stage: OrderStage;
  inserted_at: string | Date;
  page_id: string | null;
  conversation_id: string | null;
  left_warehouse: boolean;
};

type ItemRaw = { order_id: string; variant_id: string | null; sku: string; product_name: string; variation_detail: string; quantity: number };

export async function getDuplicateRule(): Promise<DuplicateRule> {
  const stored = await getSettingJson<Partial<DuplicateRule>>(DUPLICATE_SETTING_KEY, {});
  const hours = Number(stored.windowHours);
  return {
    windowHours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_DUPLICATE_RULE.windowHours,
    enabled: stored.enabled === undefined ? DEFAULT_DUPLICATE_RULE.enabled : Boolean(stored.enabled),
  };
}

export async function getDuplicateOrderQueue(): Promise<DuplicateOrderQueue> {
  return memo("order-duplicate", 90_000, async () => {
    const rule = await getDuplicateRule();
    const now = new Date();
    if (!rule.enabled) {
      return { rows: [], rule, suspected: 0, possible: 0, atRisk: 0, scanned: 0, capped: false, measuredAt: now };
    }

    const db = await getDb();
    const lookback = new Date(now.getTime() - rule.windowHours * 3_600_000);
    const preship = PRE_SHIP_STAGES.map((s) => `'${s}'`).join(",");
    const dead = DEAD_ORDER_STAGES.map((s) => `'${s}'`).join(",");

    /*
      MỘT CÂU LẤY ĐÚNG NHỮNG ĐƠN CÓ THỂ THÀNH CẶP.

      `khoa` = chín số cuối SĐT, dựng NGAY TRONG SQL để phép lọc "SĐT này có từ hai đơn trở lên"
      chạy ở CSDL thay vì kéo cả kỳ về rồi lọc trong Node. Bản TypeScript (`phoneKey`) vẫn là nơi
      duy nhất định nghĩa khoá; biểu thức SQL chỉ tái hiện đúng nó, và kiểm thử khoá hai bên khớp
      nhau trên cùng dữ liệu.

      Điều kiện `co_don_can_xu_ly`: nhóm phải có ít nhất MỘT đơn còn chưa rời kho. Nhóm toàn đơn đã
      đi hết thì không còn việc gì để làm.
    */
    const orders = rowsOf<OrderRaw>(
      await db.execute(sql`
        with nen as (
          select o.id,
                 o.system_id,
                 o.bill_full_name,
                 o.bill_phone,
                 o.ship_address,
                 o.total_price_after_discount as total,
                 o.stage::text as stage,
                 o.inserted_at,
                 o.page_id,
                 o.conversation_id,
                 right(regexp_replace(coalesce(o.bill_phone, ''), '[^0-9]', '', 'g'), 9) as khoa,
                 length(regexp_replace(coalesce(o.bill_phone, ''), '[^0-9]', '', 'g')) as so_chu_so,
                 exists (
                   select 1 from shipments s
                    where s.order_id = o.id
                      and coalesce(s.direction, 'OUTBOUND') <> 'RETURN'
                      and s.stage::text not in ('PENDING','CANCELLED')
                 ) as left_warehouse
            from orders o
           where o.inserted_at >= ${lookback.toISOString()}::timestamptz
             and o.stage::text not in (${sql.raw(dead)})
        ),
        nhom as (
          select khoa
            from nen
           where so_chu_so >= 9
           group by khoa
          having count(*) > 1
             and bool_or(stage in (${sql.raw(preship)}) and not left_warehouse)
        )
        select nen.id, nen.system_id, nen.bill_full_name, nen.bill_phone, nen.ship_address,
               nen.total, nen.stage, nen.inserted_at, nen.page_id, nen.conversation_id, nen.left_warehouse
          from nen join nhom on nhom.khoa = nen.khoa
         order by nen.inserted_at asc
         limit ${MAX_DUPLICATE_SCAN + 1}
      `),
    );

    const capped = orders.length > MAX_DUPLICATE_SCAN;
    const list = capped ? orders.slice(0, MAX_DUPLICATE_SCAN) : orders;
    if (!list.length) {
      return { rows: [], rule, suspected: 0, possible: 0, atRisk: 0, scanned: 0, capped, measuredAt: now };
    }

    const ids = list.map((o) => o.id);
    const items = rowsOf<ItemRaw>(
      await db.execute(sql`
        select i.order_id, i.variant_id, i.sku, i.product_name, i.variation_detail, i.quantity
          from order_items i
         where i.order_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
           -- Hàng TẶNG không nói lên khách đã mua gì: hai đơn khác hẳn nhau có thể cùng kèm một
           -- món quà khuyến mại, và tính nó vào là dựng ra một điểm chung giả.
           and i.is_bonus = false
      `),
    );

    const byOrder = new Map<string, ItemLike[]>();
    for (const it of items) {
      const arr = byOrder.get(it.order_id) ?? [];
      arr.push({
        variantId: it.variant_id,
        sku: it.sku ?? "",
        productName: it.product_name ?? "",
        variationDetail: it.variation_detail ?? "",
        quantity: Number(it.quantity ?? 0) || 0,
      });
      byOrder.set(it.order_id, arr);
    }

    type Full = DuplicateCandidate & OrderRaw & { insertedAt: Date };
    const groups = new Map<string, Full[]>();
    for (const o of list) {
      const key = phoneKey(o.bill_phone);
      if (!key) continue;
      const insertedAt = toDate(o.inserted_at);
      if (!insertedAt) continue;
      const full: Full = {
        ...o,
        orderId: o.id,
        insertedAt,
        phone: o.bill_phone,
        receiverName: o.bill_full_name ?? "",
        address: o.ship_address ?? "",
        total: Number(o.total ?? 0) || 0,
        items: byOrder.get(o.id) ?? [],
      };
      groups.set(key, [...(groups.get(key) ?? []), full]);
    }

    const rows: DuplicateOrderRow[] = [];
    // Mức mạnh hơn thắng khi một đơn nghi khớp nhiều đơn trước đó.
    const manh: Record<DuplicateVerdict, number> = { DUPLICATE_SUSPECTED: 2, POSSIBLE_DUPLICATE: 1, DISTINCT: 0 };

    for (const group of groups.values()) {
      // Ổn định: sắp theo mốc lên đơn, hoà thì theo id. Chạy hai lần phải ra cùng một kết quả.
      const sorted = [...group].sort((a, b) => a.insertedAt.getTime() - b.insertedAt.getTime() || a.orderId.localeCompare(b.orderId));
      for (let i = 1; i < sorted.length; i += 1) {
        const suspect = sorted[i];
        // Đơn nghi phải còn chặn kịp; đơn giữ thì không cần.
        if (!PRE_SHIP_STAGES.includes(suspect.stage) || suspect.left_warehouse) continue;

        let best: { keeper: Full; assessment: ReturnType<typeof assessDuplicate> } | null = null;
        for (let j = 0; j < i; j += 1) {
          const a = assessDuplicate(sorted[j], suspect);
          if (a.verdict === "DISTINCT") continue;
          if (!best || manh[a.verdict] > manh[best.assessment.verdict]) best = { keeper: sorted[j], assessment: a };
        }
        if (!best) continue;

        // `orderPair` là chỗ DUY NHẤT quyết định ai là bản giữ — không gõ lại luật "đặt trước thắng".
        const { keeper, suspect: sau } = orderPair(best.keeper, suspect);
        const verdict = best.assessment.verdict as Exclude<DuplicateVerdict, "DISTINCT">;
        rows.push({
          suspectOrderId: sau.orderId,
          suspectSystemId: sau.system_id,
          suspectStage: sau.stage,
          suspectInsertedAt: sau.insertedAt,
          suspectTotal: sau.total,
          keeperOrderId: keeper.orderId,
          keeperSystemId: keeper.system_id,
          keeperStage: keeper.stage,
          keeperInsertedAt: keeper.insertedAt,
          keeperTotal: keeper.total,
          keeperShipped: keeper.left_warehouse,
          customer: sau.receiverName,
          phone: sau.phone,
          verdict,
          signals: best.assessment.signals,
          signalLabels: best.assessment.signals.map((s) => DUPLICATE_SIGNAL_LABEL[s]),
          why: best.assessment.why,
          nextAction: DUPLICATE_VERDICT_ACTION[verdict],
          gapHours: Math.abs(sau.insertedAt.getTime() - keeper.insertedAt.getTime()) / 3_600_000,
          atRisk: sau.total,
          chatUrl: sau.page_id && sau.conversation_id ? `https://pancake.vn/${sau.page_id}?c_id=${sau.conversation_id}` : null,
        });
      }
    }

    /*
      XẾP: nghi trùng chắc trước; trong cùng mức thì ĐƠN GIỮ ĐÃ GỬI ĐI đứng trên — đó là ca gấp
      nhất (một gói đang trên đường, một gói sắp đi). Rồi tới tiền, rồi tới khoảng cách hai đơn.
    */
    rows.sort((a, b) => {
      if (a.verdict !== b.verdict) return manh[b.verdict] - manh[a.verdict];
      if (a.keeperShipped !== b.keeperShipped) return a.keeperShipped ? -1 : 1;
      if (b.atRisk !== a.atRisk) return b.atRisk - a.atRisk;
      return a.gapHours - b.gapHours;
    });

    return {
      rows,
      rule,
      suspected: rows.filter((r) => r.verdict === "DUPLICATE_SUSPECTED").length,
      possible: rows.filter((r) => r.verdict === "POSSIBLE_DUPLICATE").length,
      atRisk: rows.reduce((t, r) => t + r.atRisk, 0),
      scanned: list.length,
      capped,
      measuredAt: now,
    };
  });
}

/* ═══════════════════ CỜ «NGHI TRÙNG ĐƠN» TRÊN /orders (P0 HSLC 24/10/2026) ═══════════════════ */

/**
 * Cặp #D2A8DE9B / #A5CC67E2 (cùng SĐT, cùng món, cách 83 giây) KHÔNG lộ ra ở nơi nhân viên làm đơn: hàng đợi trên chỉ hiện ở /work và
 * /operations/preship, còn trang Đơn hàng — nơi kho in đơn và nhân viên gọi khách — không có một chữ nào. Cờ ở đây đọc CHÍNH
 * `assessDuplicate` + `orderPair` (không luật thứ hai), cùng cửa sổ `orders.duplicate-rule`; luật tắt ⇒ không cờ. Một đơn có nhiều cặp
 * ⇒ trả đủ (chi tiết đơn in hết; danh sách lấy cặp mạnh nhất). Không giới hạn «chưa rời kho» như hàng đợi: trang đơn là nơi tra lại,
 * cặp đã giao vẫn là thông tin đúng. Không tự huỷ / gộp gì.
 */
export type DuplicateFlag = {
  otherId: string;
  otherCode: string;
  otherStage: OrderStage;
  otherInsertedAt: Date;
  verdict: Exclude<DuplicateVerdict, "DISTINCT">;
  /** `SUSPECT` = đơn này là đơn ĐẶT SAU (bản nghi); `KEEPER` = đơn này đặt trước (bản giữ). */
  role: "SUSPECT" | "KEEPER";
  why: string;
  gapHours: number;
};

/** Trần số đơn đọc thêm cho một trang — vượt trần thì cờ thiếu một phần, không làm chậm trang (trang 50 đơn thực tế đọc vài chục). */
const MAX_FLAG_SCAN = 2_000;

const STRENGTH: Record<DuplicateVerdict, number> = { DUPLICATE_SUSPECTED: 2, POSSIBLE_DUPLICATE: 1, DISTINCT: 0 };

/** Cặp mạnh nhất của một đơn (danh sách). HÀM THUẦN. */
export function strongestFlag(flags: readonly DuplicateFlag[] | undefined): DuplicateFlag | null {
  if (!flags?.length) return null;
  return [...flags].sort((a, b) => STRENGTH[b.verdict] - STRENGTH[a.verdict] || a.gapHours - b.gapHours)[0];
}

export async function duplicateFlagsFor(orders: readonly { id: string; insertedAt: Date; billPhone: string | null }[]): Promise<Map<string, DuplicateFlag[]>> {
  const out = new Map<string, DuplicateFlag[]>();
  const keyed = orders.filter((o) => phoneKey(o.billPhone));
  if (!keyed.length) return out;
  const rule = await getDuplicateRule();
  if (!rule.enabled) return out;
  const win = rule.windowHours * 3_600_000;
  const times = keyed.map((o) => o.insertedAt.getTime());
  const from = new Date(Math.min(...times) - win);
  const to = new Date(Math.max(...times) + win);
  const keys = [...new Set(keyed.map((o) => phoneKey(o.billPhone)!))];
  const dead = DEAD_ORDER_STAGES.map((s) => `'${s}'`).join(",");
  const db = await getDb();
  const rows = rowsOf<OrderRaw>(
    await db.execute(sql`
      select o.id, o.system_id, o.bill_full_name, o.bill_phone, o.ship_address, o.total_price_after_discount as total,
             o.stage::text as stage, o.inserted_at, o.page_id, o.conversation_id, false as left_warehouse
        from orders o
       where o.inserted_at between ${from.toISOString()}::timestamptz and ${to.toISOString()}::timestamptz
         and o.stage::text not in (${sql.raw(dead)})
         and right(regexp_replace(coalesce(o.bill_phone, ''), '[^0-9]', '', 'g'), 9) in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
       -- Đơn của CHÍNH trang đứng đầu: vượt trần thì cắt phần đọc thêm, không cắt đơn đang hiện.
       order by (o.id in (${sql.join(keyed.map((k) => sql`${k.id}`), sql`, `)})) desc, o.inserted_at desc
       limit ${MAX_FLAG_SCAN}
    `),
  );
  if (rows.length < 2) return out;
  const items = rowsOf<ItemRaw>(
    await db.execute(sql`
      select i.order_id, i.variant_id, i.sku, i.product_name, i.variation_detail, i.quantity
        from order_items i
       where i.order_id in (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)}) and i.is_bonus = false
    `),
  );
  const byOrder = new Map<string, ItemLike[]>();
  for (const it of items) byOrder.set(it.order_id, [...(byOrder.get(it.order_id) ?? []), { variantId: it.variant_id, sku: it.sku ?? "", productName: it.product_name ?? "", variationDetail: it.variation_detail ?? "", quantity: Number(it.quantity ?? 0) || 0 }]);
  type Full = DuplicateCandidate & { stage: OrderStage; code: string };
  const full = new Map<string, Full>();
  for (const r of rows) {
    const insertedAt = toDate(r.inserted_at);
    if (!insertedAt) continue;
    full.set(r.id, { orderId: r.id, insertedAt, phone: r.bill_phone, receiverName: r.bill_full_name ?? "", address: r.ship_address ?? "", total: Number(r.total ?? 0) || 0, items: byOrder.get(r.id) ?? [], stage: r.stage, code: r.system_id !== null && r.system_id !== undefined ? String(r.system_id) : manualOrderShortCode(r.id) });
  }
  for (const o of keyed) {
    const me = full.get(o.id);
    if (!me) continue;
    const flags: DuplicateFlag[] = [];
    for (const other of full.values()) {
      if (other.orderId === me.orderId || phoneKey(other.phone) !== phoneKey(me.phone)) continue;
      const gap = Math.abs(other.insertedAt.getTime() - me.insertedAt.getTime());
      if (gap > win) continue;
      const a = assessDuplicate(me, other);
      if (a.verdict === "DISTINCT") continue;
      const pair = orderPair(me, other);
      flags.push({ otherId: other.orderId, otherCode: other.code, otherStage: other.stage, otherInsertedAt: other.insertedAt, verdict: a.verdict, role: pair.suspect.orderId === me.orderId ? "SUSPECT" : "KEEPER", why: a.why, gapHours: gap / 3_600_000 });
    }
    if (flags.length) out.set(o.id, flags.sort((x, y) => STRENGTH[y.verdict] - STRENGTH[x.verdict] || x.gapHours - y.gapHours));
  }
  return out;
}
