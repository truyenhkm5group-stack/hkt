/**
 * ═══════════ TÌM KIẾM HỘP THƯ — MỘT CHỖ DỰNG ĐIỀU KIỆN (P0 inbox-search, chủ shop 11/10/2026) — CHỈ MÁY CHỦ ═══════════
 *
 * Ca thật (production 11/10): tìm SĐT dạng «09…» ở «Tất cả» ra đúng khách, nhưng cùng số viết «+84…» hoặc «09xx xxx xxx» KHÔNG ra; tên
 * gõ có khoảng trắng không ra tên Messenger viết liền. Nguyên nhân gốc ở điều kiện cũ của `listInbox`: SÁU vế `ilike '%<chuỗi gõ>%'` trên chữ THÔ — không chuẩn hoá
 * SĐT (khoảng trắng / chấm / +84 làm chuỗi con không còn khớp), không bỏ dấu / khoảng trắng của tên, không đọc tin khách, không đọc
 * đơn của hội thoại, không đọc mã đơn. Tệp này thay sáu vế đó bằng BỐN NHÓM, gộp bằng OR:
 *
 *  1. SĐT (ô tìm chỉ gồm chữ số + `+ . - ( )` khoảng trắng, ≥ 6 chữ số): chuẩn hoá về PHẦN LÕI không số 0 / không 84 đầu
 *     (`normalizeVnPhone` của returning.ts — CÙNG hàm job level dùng để ghi `customer_phone`), rồi so «chứa» trên chữ đã bỏ
 *     khoảng trắng / chấm / gạch / ngoặc / dấu cộng của: SĐT hội thoại · SĐT hồ sơ khách · SĐT bot ghi (`state.customer.phone`) ·
 *     SĐT Pancake (`state.pancakePhones`) · SĐT người nhận / người đặt trên ĐƠN của hội thoại (và đơn của hồ sơ khách) · TIN KHÁCH
 *     (Messenger / Zalo / chat web, kể cả tin nhập lịch sử). «0900111222», «+84 900 111 222», «84900111222», «0900.111.222» là MỘT số.
 *  2. TÊN (ô tìm có chữ cái, ≥ 2 ký tự sau khi bỏ dấu): bỏ dấu + bỏ khoảng trắng HAI PHÍA (`foldSearchText` ⇄ `foldSql`) trên tên
 *     hồ sơ khách (CRM) · tên bot ghi · tên Messenger / Pancake mang theo tin (`sales_chat_inbound.customer_name`, MỌI tên đã thấy)
 *     · tên người đặt / người nhận trên đơn của hội thoại.
 *  3. MÃ ĐƠN: mã ngắn «#5E7A9C1B» của đơn ERP (`manualOrderShortCode`) · mã đầy đủ · số hiển thị Pancake (`display_id`).
 *  4. Vế THÔ cũ (`ilike`) giữ nguyên cho tên / SĐT — ô tìm ngắn (vd. 4 chữ số đầu) vẫn ra như trước.
 *
 * HIỆU NĂNG: điều kiện chạy MỘT lần trong một câu riêng ra danh sách mã hội thoại; ba câu của `listInbox` (đếm · đếm level · hàng)
 * lọc theo danh sách đó (`= any(mảng)`), không quét sổ tin ba lần. Quá `RESOLVE_MAX` mã (ô tìm quá rộng) ⇒ trả lại điều kiện
 * nguyên khối (đúng, chậm hơn) thay vì cắt bớt im lặng. Đo trên PGlite: tests/inbox-search.test.ts.
 *
 * PHẠM VI: `getDb()` là CSDL của TỔ CHỨC đang ngữ cảnh — điều kiện không bao giờ đọc CSDL khác (bài kiểm hai tổ chức).
 */
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { MANUAL_ORDER_ID_PREFIX } from "@/lib/constants/manual-orders";
import { NGUYEN_AM_CO_DAU, NGUYEN_AM_KHONG_DAU } from "@/lib/queries/carrier-substate-sql";
import { PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { foldSearchText } from "@/lib/sales-chatbot/inbox-search-shared";
import { normalizeVnPhone } from "@/lib/sales-chatbot/returning";

/** Quá chừng này hội thoại khớp ⇒ không chuyển danh sách mã, dùng điều kiện nguyên khối. */
export const RESOLVE_MAX = 5_000;
/** Ô tìm SĐT: tối thiểu chừng này chữ số mới so theo SĐT chuẩn hoá (ít hơn ⇒ chỉ vế thô cũ). */
export const PHONE_MIN_DIGITS = 6;
/** Ô tìm tên: tối thiểu chừng này ký tự sau khi bỏ dấu / khoảng trắng. */
export const NAME_MIN_CHARS = 2;

export type InboxSearchTerms = {
  /** Chuỗi gõ (đã cắt hai đầu) — cho vế thô cũ. */
  raw: string;
  /** SĐT: phần LÕI (không số 0 / 84 đầu) để so «chứa»; `null` = ô tìm không phải SĐT. */
  phone: string | null;
  /** Ô tìm là MỘT SĐT ĐỦ (chuẩn hoá được): phần lõi để xếp khớp CHÍNH XÁC lên đầu (`inboxSearchRankSql`); `null` = số dở / không phải SĐT. */
  exactPhone: string | null;
  /** Tên đã bỏ dấu + bỏ khoảng trắng; `null` = không có chữ cái / quá ngắn. */
  fold: string | null;
  /** Đơn ERP theo mã ngắn: tiền tố mã đầy đủ (`erp-5e7a9c1b`). */
  orderPrefix: string | null;
  /** Mã đơn đầy đủ (Pancake / ERP) — so bằng. */
  orderId: string | null;
  /** Số hiển thị đơn Pancake. */
  displayId: number | null;
};

const PHONE_CHARS = /^[\d\s.+()-]+$/;

/** Ô tìm ⇒ các vế tìm. Rỗng ⇒ `null`. HÀM THUẦN. */
export function parseInboxSearch(input: string | null | undefined): InboxSearchTerms | null {
  const raw = (input ?? "").normalize("NFC").trim().slice(0, 80);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  let phone: string | null = null;
  let exactPhone: string | null = null;
  if (PHONE_CHARS.test(raw) && digits.length >= PHONE_MIN_DIGITS) {
    const full = normalizeVnPhone(raw);
    if (full) phone = exactPhone = full.slice(1);
    else {
      // Một PHẦN số (vd. 6 số cuối, hoặc «+84 832 106» đang gõ dở): bỏ 84 / 0 đầu để khớp cả dạng 0… lẫn +84….
      let d = digits;
      if (raw.startsWith("+") && d.startsWith("84")) d = d.slice(2);
      if (d.startsWith("0")) d = d.slice(1);
      phone = d.length >= PHONE_MIN_DIGITS - 1 ? d : null;
    }
  }
  const folded = /\p{L}/u.test(raw) ? foldSearchText(raw) : "";
  const fold = folded.length >= NAME_MIN_CHARS ? folded : null;
  const code = raw.replace(/^#\s*/, "");
  const orderPrefix = /^[0-9a-f]{6,8}$/i.test(code) && /\d/.test(code) ? `${MANUAL_ORDER_ID_PREFIX}${code.toLowerCase()}` : null;
  const orderId = /^[A-Za-z0-9_-]{4,64}$/.test(code) && !phone ? (code.toLowerCase().startsWith(MANUAL_ORDER_ID_PREFIX) ? code.toLowerCase() : code) : null;
  const displayId = /^[1-9]\d{0,8}$/.test(code) && !phone ? Number(code) : null;
  return { raw, phone, exactPhone, fold, orderPrefix, orderId, displayId };
}

const UPPER_CO_DAU = NGUYEN_AM_CO_DAU.toUpperCase();

/**
 * Bỏ dấu + hạ chữ + bỏ mọi ký tự không phải [a-z0-9] TRONG POSTGRES — cùng kết quả với `foldSearchText` (bài kiểm so hai bên).
 * Chữ hoa có dấu đổi về chữ thường có dấu TRƯỚC (`lower()` của Postgres không chắc hạ được chữ ngoài ASCII ở mọi locale — «Đỗ»),
 * rồi bảng 67 ký tự của `boDauSql`; dấu kết hợp rời (chuỗi NFD) rơi ở bước bỏ ký tự lạ.
 */
export function foldSql(x: SQL): SQL {
  return sql`regexp_replace(translate(lower(translate(coalesce(${x}, ''), ${UPPER_CO_DAU}, ${NGUYEN_AM_CO_DAU})), ${NGUYEN_AM_CO_DAU}, ${NGUYEN_AM_KHONG_DAU}), '[^a-z0-9]', '', 'g')`;
}

/** Bỏ khoảng trắng / chấm / gạch / ngoặc / dấu cộng — «0900 111 222», «+84.900.111.222» thành một dãy số liền. */
function stripSql(x: SQL): SQL {
  return sql`regexp_replace(coalesce(${x}, ''), '[[:space:].()+-]', '', 'g')`;
}

const C = sql.raw(`"sales_chat_conversations"`);
const CU = sql.raw(`"customers"`);

/** Đơn của hội thoại khớp `match` (vế trên bảng `orders o`): đơn ghi mã hội thoại · đơn / đơn nháp hội thoại trỏ tới. */
function linkedOrder(match: SQL, withCustomer: boolean): SQL {
  const parts = [
    sql`${C}."id" in (select o.sales_conversation_id from "orders" o where o.sales_conversation_id is not null and (${match}))`,
    sql`exists (select 1 from "orders" o where (o.id = ${C}."order_id" or o.id = ${C}."draft_order_id") and (${match}))`,
  ];
  // Đơn của HỒ SƠ khách (cùng tập đơn khung hội thoại hiện ở panel đơn — inbox.ts::loadInboxThread).
  if (withCustomer) parts.push(sql`${C}."customer_id" in (select o.customer_id from "orders" o where o.customer_id is not null and (${match}))`);
  return sql`(${sql.join(parts, sql` or `)})`;
}

/**
 * ĐIỀU KIỆN TÌM trên `sales_chat_conversations` (LEFT JOIN `customers`) — dùng trong câu có đúng hai bảng đó tên gốc. HÀM THUẦN
 * (chỉ dựng SQL).
 */
export function inboxSearchSql(t: InboxSearchTerms): SQL {
  const like = `%${t.raw.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const parts: SQL[] = [
    // 4. Vế thô cũ — giữ hành vi của ô tìm ngắn.
    sql`${CU}."name" ilike ${like}`,
    sql`${CU}."phone" ilike ${like}`,
    sql`${C}."customer_phone" ilike ${like}`,
    sql`${C}."state"->'customer'->>'name' ilike ${like}`,
    sql`${C}."state"->'customer'->>'phone' ilike ${like}`,
  ];
  if (t.phone) {
    const p = `%${t.phone}%`;
    const custSide = sql`coalesce(i.note, '') not in ('BOT_SENT', ${PAGE_REPLY})`;
    parts.push(
      sql`${stripSql(sql`${C}."customer_phone"`)} like ${p}`,
      sql`${stripSql(sql`${CU}."phone"`)} like ${p}`,
      // Hồ sơ khách Pancake có thể mang NHIỀU số (`customers.phones`) — dấu phẩy giữ ranh giới giữa hai số.
      sql`${stripSql(sql`array_to_string(${CU}."phones", ',')`)} like ${p}`,
      sql`${stripSql(sql`${C}."state"->'customer'->>'phone'`)} like ${p}`,
      // Mảng JSON giữ dấu nháy / phẩy giữa các số ⇒ bỏ khoảng trắng không nối hai số thành một.
      sql`${stripSql(sql`(${C}."state"->'pancakePhones')::text`)} like ${p}`,
      linkedOrder(sql`${stripSql(sql`o.bill_phone`)} like ${p} or ${stripSql(sql`o.ship_phone`)} like ${p}`, true),
      // TIN KHÁCH (Messenger / Pancake / Zalo — kể cả tin nhập lịch sử): chỉ dòng có ≥ 3 chữ số liền mới phải bỏ ký tự.
      sql`(${C}."page_id", ${C}."thread_id") in (select i.page_id, i.thread_id from "sales_chat_inbound" i where ${custSide} and i.text ~ '[0-9]{3}' and ${stripSql(sql`i.text`)} like ${p})`,
      // Chat web: tin khách nằm trong khối chữ của `sales_chat_messages`.
      sql`${C}."id" in (select m.conversation_id from "sales_chat_messages" m where m.role = 'user' and ${stripSql(sql`m.content::text`)} like ${p})`,
    );
  }
  if (t.fold) {
    const f = `%${t.fold}%`;
    parts.push(
      sql`${foldSql(sql`${CU}."name"`)} like ${f}`,
      sql`${foldSql(sql`${C}."state"->'customer'->>'name'`)} like ${f}`,
      // MỌI tên kênh đã thấy của luồng (Messenger / Pancake đổi tên ⇒ tên cũ vẫn tìm được). `offset 0`: gộp (luồng, tên) TRƯỚC rồi
      // mới bỏ dấu — mỗi tên một lần, không một lần cho mỗi tin.
      sql`(${C}."page_id", ${C}."thread_id") in (select n.page_id, n.thread_id from (select distinct i.page_id, i.thread_id, i.customer_name from "sales_chat_inbound" i where i.customer_name is not null and i.customer_name <> '' offset 0) n where ${foldSql(sql`n.customer_name`)} like ${f})`,
      linkedOrder(sql`${foldSql(sql`o.bill_full_name`)} like ${f} or ${foldSql(sql`o.ship_full_name`)} like ${f}`, false),
    );
  }
  const orderMatch: SQL[] = [];
  if (t.orderPrefix) orderMatch.push(sql`o.id like ${`${t.orderPrefix}%`}`);
  if (t.orderId) orderMatch.push(sql`o.id = ${t.orderId}`);
  if (t.displayId !== null) orderMatch.push(sql`o.display_id = ${t.displayId}`);
  if (orderMatch.length) parts.push(linkedOrder(sql.join(orderMatch, sql` or `), false));
  return sql`(${sql.join(parts, sql` or `)})`;
}

/**
 * KHỚP SĐT CHÍNH XÁC (P0 inbox-search-global 12/10/2026): ô tìm là một SĐT đủ ⇒ hội thoại mà SĐT GHI NHẬN của khách (SĐT hội thoại ·
 * hồ sơ khách — mọi số · bot ghi · Pancake ghi) BẰNG ĐÚNG số đó (sau khi bỏ khoảng trắng / dấu câu / 0 / 84 đầu) xếp TRƯỚC các hội
 * thoại chỉ «chứa» số (một tin nhắn nhắc tới số, một đơn của người khác…). Chỉ là KHOÁ XẾP — không lọc thêm, không bớt hàng nào.
 * `null` = không xếp hạng (ô tìm không phải SĐT đủ). HÀM THUẦN (chỉ dựng SQL; dùng trong câu có `sales_chat_conversations` +
 * LEFT JOIN `customers` tên gốc).
 */
export function inboxSearchRankSql(q: string | null | undefined): SQL | null {
  const t = parseInboxSearch(q);
  if (!t?.exactPhone || !/^\d+$/.test(t.exactPhone)) return null;
  const re = `^(84|0)?${t.exactPhone}$`;
  const eqPhone = (x: SQL) => sql`${stripSql(x)} ~ ${re}`;
  const pancake = sql`${C}."state"->'pancakePhones'`;
  return sql`(${eqPhone(sql`${C}."customer_phone"`)}
    or ${eqPhone(sql`${CU}."phone"`)}
    or ${eqPhone(sql`${C}."state"->'customer'->>'phone'`)}
    or exists (select 1 from unnest(coalesce(${CU}."phones", '{}'::text[])) as cp(v) where ${eqPhone(sql`cp.v`)})
    or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${pancake}) = 'array' then ${pancake} else '[]'::jsonb end) as pp(v) where ${eqPhone(sql`pp.v`)}))`;
}

/** Mảng chữ của Postgres (`{"a","b"}`) — MỘT tham số cho `= any(...)`, không một tham số cho mỗi mã. */
function pgTextArray(ids: readonly string[]): string {
  return `{${ids.map((id) => `"${id.replace(/["\\]/g, (m) => `\\${m}`)}"`).join(",")}}`;
}

/**
 * ĐIỂM NỐI của `listInbox`: ô tìm ⇒ điều kiện trên hội thoại. Chạy điều kiện MỘT lần ra danh sách mã (CSDL tổ chức ngữ cảnh), trả
 * `id = any(mảng)`; không khớp gì ⇒ `false`; quá `RESOLVE_MAX` ⇒ điều kiện nguyên khối. Ô tìm rỗng ⇒ `undefined` (không lọc).
 */
export async function inboxSearchCondition(q: string | null | undefined): Promise<SQL | undefined> {
  const terms = parseInboxSearch(q);
  if (!terms) return undefined;
  const cond = inboxSearchSql(terms);
  const db = await getDb();
  const c = schema.salesChatConversations;
  const rows = await db
    .select({ id: c.id })
    .from(c)
    .leftJoin(schema.customers, eq(schema.customers.id, c.customerId))
    .where(and(ne(c.channel, "TEST"), cond))
    .limit(RESOLVE_MAX + 1);
  if (rows.length > RESOLVE_MAX) return cond;
  if (!rows.length) return sql`false`;
  return sql`${c.id} = any(${pgTextArray(rows.map((r) => r.id))}::text[])`;
}

