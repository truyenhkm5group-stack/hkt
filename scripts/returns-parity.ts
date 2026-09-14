/**
 * ═══════════ BA ĐƯỜNG, MỘT CON SỐ: MÀN HÌNH = MÁY TÍNH KẾT QUẢ = SQL ĐỘC LẬP ═══════════
 *
 * Chạy TRONG container app trên production. Ba đường đi tới cùng một câu hỏi, và bài này bắt chúng
 * phải nói cùng một con số:
 *
 *   1. MÀN HÌNH — tải thật `/reports/returns` bằng phiên đăng nhập hợp lệ rồi BÓC SỐ TỪ HTML.
 *      Đây là con số chủ shop nhìn thấy. Mọi phép kiểm khác đều đứng dưới tầng render, nên chúng
 *      không thấy được một khối biến mất sau lớp bắt lỗi — chuyện đã xảy ra thật ngày 14/09: trang
 *      vẫn trả HTTP 200 mà cả khối lý do hoàn không hiện, vì một hàm bị truyền qua ranh giới client.
 *
 *   2. MÁY TÍNH KẾT QUẢ — gọi thẳng `getReturnReasonReport()`, đúng hàm mà trang gọi.
 *
 *   3. SQL ĐỘC LẬP — viết lại luật từ `docs/business-rules/ORDER_OUTCOME.md`, đọc thẳng
 *      `shipment_events`. KHÔNG import một dòng nào của `lib/queries/*`: một bài đối chiếu dùng lại
 *      chính mã đang kiểm thì nó chỉ chứng minh mã đó nhất quán với chính nó.
 *
 * Lệch ⇒ thoát khác 0 và IN RA từng mã hàng lệch bao nhiêu. Không "gần đúng", không ngưỡng dung sai:
 * hai cách đếm cùng một tập đơn phải ra cùng một số nguyên.
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getReturnReasonReport } from "@/lib/queries/return-reason-report";
import { resolvePeriod } from "@/lib/search-params";

const BASE = process.env.SMOKE_URL ?? "http://127.0.0.1:3000";
const MA = (process.env.PARITY_CODES ?? "Q001,Q002,Q003,Q004").split(",").map((s) => s.trim()).filter(Boolean);
const PERIOD = process.env.PARITY_PERIOD ?? "all";

type Dong = { code: string; daGui: number; giao: number; hoan: number; dangChay: number };
const so = (n: number) => n.toLocaleString("vi-VN");

/* ───────────────────── 3 · SQL ĐỘC LẬP, VIẾT TỪ ĐẶC TẢ ───────────────────── */

/**
 * Luật chép từ `docs/business-rules/ORDER_OUTCOME.md` mục 3–6, KHÔNG chép từ `return-rate.ts`.
 *
 * Thứ tự nguồn tin: (1) mã trạng thái cuối kèm cờ chiều → (2) chặng dựng từ hành trình → (3) quy
 * tắc tiền, và chỉ khi vận đơn không có bất kỳ chứng từ nào của ĐVVC. Chứng cứ "hàng đã quay về"
 * (mục 5) xét TRƯỚC mã 501.
 */
const SQL_DOC_LAP = sql`
with ma as (
  select distinct oi.order_id, p.custom_id as code
    from order_items oi
    join product_variants pv on pv.id = oi.variant_id
    join products p on p.id = pv.product_id
   -- DANH SÁCH TƯỜNG MINH, KHÔNG dùng "= any(tham-số)": Postgres không suy được kiểu của tham số
   -- mảng (lỗi make_scalar_array_op), và lỗi ấy chỉ lộ ra lúc CHẠY THẬT trên máy chủ, không lộ ở tsc.
   where oi.is_bonus = false and p.custom_id in (${sql.join(MA.map((c) => sql`${c}`), sql`, `)})
), kien as (
  select s.id, s.order_id, s.cod_collected,
         (s.picked_up_at is not null or exists (
            select 1 from shipment_events e where e.shipment_id = s.id
              and e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL','VTP_MANUAL_VERIFY','MANUAL')
              and e.normalized_stage::text in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','RETURNING','RETURNED')
         )) as da_ban_giao,
         (select e.status from shipment_events e
           where e.shipment_id = s.id and e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL','VTP_MANUAL_VERIFY','MANUAL')
             and e.status in ('101','107','201','501','503','504')
           order by e.occurred_at desc nulls last limit 1) as ma_cuoi,
         (select e.leg_type::text from shipment_events e
           where e.shipment_id = s.id and e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL','VTP_MANUAL_VERIFY','MANUAL')
             and e.status in ('101','107','201','501','503','504')
           order by e.occurred_at desc nulls last limit 1) as chieu_cuoi,
         (select e.normalized_stage::text from shipment_events e
           where e.shipment_id = s.id and e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL','VTP_MANUAL_VERIFY','MANUAL')
             and e.normalized_stage is not null
           order by e.occurred_at desc nulls last limit 1) as chang_cuoi,
         exists (select 1 from shipment_events e where e.shipment_id = s.id
                   and e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL','VTP_MANUAL_VERIFY','MANUAL')) as co_chung_tu,
         (s.vtp_order_number is not null and exists (
            select 1 from shipments leg where leg.order_reference = s.vtp_order_number and leg.id <> s.id)) as co_chieu_hoan,
         exists (select 1 from shipment_events ev where ev.shipment_id = s.id
                   and ev.status_name like 'Nhập doanh thu%'
                   and ev.occurred_at >= coalesce(s.delivered_at, s.vtp_status_date) - interval '2 minute') as sua_doanh_thu
    from shipments s
   where s.order_id is not null
), chinh as (
  select distinct on (k.order_id) k.* from kien k
   order by k.order_id, (k.ma_cuoi is not null) desc, k.da_ban_giao desc, k.id desc
), ket as (
  select m.code, case
      when not c.da_ban_giao then 'CHUA_BAN_GIAO'
      when c.ma_cuoi in ('101','107','201') then 'HUY'
      when c.ma_cuoi in ('503','504') then 'HOAN'
      when c.ma_cuoi = '501' and c.chieu_cuoi = 'RETURN' then 'HOAN'
      when c.ma_cuoi = '501' and (c.co_chieu_hoan or c.sua_doanh_thu) then 'HOAN'
      when c.ma_cuoi = '501' and coalesce(c.cod_collected,0) > 0 and c.cod_collected < 50000 then 'HOAN'
      when c.ma_cuoi = '501' and coalesce(c.cod_collected,0) >= 50000 and c.cod_collected <= 100000 then 'HOAN'
      when c.ma_cuoi = '501' then 'GIAO'
      when c.chang_cuoi in ('RETURNING','RETURNED') then 'HOAN'
      when c.chang_cuoi = 'CANCELLED' then 'HUY'
      when c.chang_cuoi = 'DELIVERED' and (c.co_chieu_hoan or c.sua_doanh_thu) then 'HOAN'
      when c.chang_cuoi = 'DELIVERED' and coalesce(c.cod_collected,0) > 0 and c.cod_collected <= 100000 then 'HOAN'
      when c.chang_cuoi = 'DELIVERED' then 'GIAO'
      when c.chang_cuoi in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED') then 'DANG_CHAY'
      when not c.co_chung_tu and coalesce(c.cod_collected,0) > 100000 then 'GIAO'
      when not c.co_chung_tu and coalesce(c.cod_collected,0) > 0 and c.cod_collected <= 100000 then 'HOAN'
      else 'DANG_CHAY' end as kq
    from chinh c join ma m on m.order_id = c.order_id
)
select code,
       count(*) filter (where kq in ('GIAO','HOAN','DANG_CHAY'))::int as da_gui,
       count(*) filter (where kq = 'GIAO')::int                        as giao,
       count(*) filter (where kq = 'HOAN')::int                        as hoan,
       count(*) filter (where kq = 'DANG_CHAY')::int                   as dang_chay
  from ket group by code order by code`;

async function tuSql(): Promise<Dong[]> {
  const db = await getDb();
  const r = await db.execute(SQL_DOC_LAP);
  const rows = ((r as unknown as { rows?: Record<string, unknown>[] }).rows ?? (r as unknown as Record<string, unknown>[])) as Record<string, unknown>[];
  return rows.map((x) => ({ code: String(x.code), daGui: Number(x.da_gui), giao: Number(x.giao), hoan: Number(x.hoan), dangChay: Number(x.dang_chay) }));
}

/* ───────────────────── 2 · MÁY TÍNH KẾT QUẢ ───────────────────── */

async function tuMayTinh(): Promise<Dong[]> {
  // Đi qua ĐÚNG hàm mà trang dùng để đọc kỳ từ URL — kỳ lệch một ngày là ba con số lệch nhau.
  const period = resolvePeriod({ period: PERIOD }, "all");
  const bc = await getReturnReasonReport({ period, basis: "SHIPPED", codes: MA });
  return bc.products
    .filter((p) => MA.includes(p.code))
    .map((p) => ({ code: p.code, daGui: p.finished, giao: p.delivered, hoan: p.returned, dangChay: 0 }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/* ───────────────────── 1 · MÀN HÌNH THẬT ───────────────────── */

/**
 * Bóc số từ HTML của bảng "Hoàn theo mã hàng". Cố ý đọc CHÍNH tài liệu trình duyệt nhận được, không
 * gọi lại hàm truy vấn: một khối biến mất sau lớp bắt lỗi vẫn trả HTTP 200, và chỉ có HTML mới nói
 * ra điều đó.
 */
function bocSo(html: string, code: string): { giao: number; hoan: number } | null {
  /*
    NEO VÀO ĐÚNG BẢNG TRƯỚC ĐÃ.

    Trang có HAI bảng theo mã hàng, và chúng khác thứ tự cột: "Rủi ro theo mã hàng" (đã gửi · GTC
    thực tế · GTC ước tính · tỷ lệ hoàn) đứng TRƯỚC "Hoàn theo mã hàng" (đơn có kết quả · giao TC ·
    hoàn · tỷ lệ hoàn). Tìm `>Q001<` từ đầu tài liệu sẽ trúng bảng thứ nhất và đọc ra hai con số
    hoàn toàn khác — một phép đối chiếu tự lừa mình.
  */
  const bang = html.indexOf("Hoàn theo mã hàng");
  if (bang < 0) return null;
  // Dòng của mã bắt đầu bằng ô mã hàng; lấy đoạn từ đó tới hết thẻ `</tr>` rồi đọc các ô số.
  const moc = html.indexOf(`>${code}<`, bang);
  if (moc < 0) return null;
  const het = html.indexOf("</tr>", moc);
  const doan = html.slice(moc, het < 0 ? moc + 4000 : het);
  const oSo = [...doan.matchAll(/tabular-nums[^>]*>([\d.,]+)</g)].map((m) => Number(m[1].replace(/[.,]/g, "")));
  // Thứ tự cột của bảng: đơn có kết quả · giao TC · hoàn · tỷ lệ hoàn.
  if (oSo.length < 3) return null;
  return { giao: oSo[1], hoan: oSo[2] };
}

async function tuManHinh(): Promise<Map<string, { giao: number; hoan: number }>> {
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (!secret) throw new Error("Thiếu AUTH_SECRET — không mint được phiên để mở màn hình thật");
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.role, "ADMIN")).limit(1);
  if (!user) throw new Error("Chưa có tài khoản quản trị nào");
  const token = await new SignJWT({ email: user.email, name: user.name, role: "ADMIN" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(secret));

  const url = `${BASE}/reports/returns?period=${encodeURIComponent(PERIOD)}&basis=SHIPPED&${MA.map((c) => `product=${encodeURIComponent(c)}`).join("&")}`;
  const res = await fetch(url, { headers: { cookie: `erp_session=${token}` }, redirect: "manual" });
  const html = await res.text();
  if (res.status !== 200) throw new Error(`Màn hình trả HTTP ${res.status}`);
  // Bị đá về trang đăng nhập vẫn là HTTP 200 — bắt đúng cái bẫy đã làm một lượt QA xanh giả.
  if (/name="password"/.test(html)) throw new Error("Nhận được MÀN ĐĂNG NHẬP chứ không phải báo cáo — phiên không hợp lệ");
  if (/Application error/.test(html)) throw new Error("Màn hình có lỗi runtime");
  const out = new Map<string, { giao: number; hoan: number }>();
  for (const c of MA) {
    const v = bocSo(html, c);
    if (v) out.set(c, v);
  }
  return out;
}

async function main() {
  console.log(`── ĐỐI CHIẾU BÁO CÁO HOÀN · kỳ "${PERIOD}" · mã ${MA.join(", ")} ──\n`);
  const [sqlRows, engineRows, ui] = await Promise.all([tuSql(), tuMayTinh(), tuManHinh()]);
  const theoMaSql = new Map(sqlRows.map((r) => [r.code, r]));
  const theoMaEngine = new Map(engineRows.map((r) => [r.code, r]));

  let lech = 0;
  console.log("mã    | SQL độc lập (giao/hoàn) | máy tính (giao/hoàn) | màn hình (giao/hoàn) | khớp");
  console.log("------+-------------------------+----------------------+----------------------+------");
  for (const c of MA) {
    const s = theoMaSql.get(c);
    const e = theoMaEngine.get(c);
    const u = ui.get(c);
    const dong = [s && `${so(s.giao)}/${so(s.hoan)}`, e && `${so(e.giao)}/${so(e.hoan)}`, u && `${so(u.giao)}/${so(u.hoan)}`];
    const khop = Boolean(s && e && u && s.giao === e.giao && s.hoan === e.hoan && e.giao === u.giao && e.hoan === u.hoan);
    if (!khop) lech += 1;
    console.log(`${c.padEnd(5)} | ${(dong[0] ?? "—").padStart(23)} | ${(dong[1] ?? "—").padStart(20)} | ${(dong[2] ?? "—").padStart(20)} | ${khop ? "✓" : "✗"}`);
  }

  console.log("");
  if (lech) {
    console.error(`✗ ${lech}/${MA.length} mã hàng LỆCH giữa ba đường. Không làm tròn, không bỏ qua — đi tìm nguyên nhân.`);
    process.exit(1);
  }
  console.log(`✓ ${MA.length}/${MA.length} mã hàng: màn hình = máy tính kết quả = SQL viết độc lập từ đặc tả.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
