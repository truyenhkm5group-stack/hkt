import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CARE_TERMINAL_STAGES } from "@/lib/care/entry";
import { CARRIER_HANDOFF_STAGES } from "@/lib/constants/carrier-handoff";
import { CS_BOT_ASSIGNEES, CS_ESCALATE_KINDS, CS_ESCALATE_WINDOW_HOURS, CS_KIND_LABEL, CS_KINDS, CS_STATUS_LABEL, CS_SURFACE_MODE, type CsKind, type CsStatus } from "@/lib/constants/cs";
import { CS_CUSTOMER_WAITING_KINDS, CS_DUE_SOON_HOURS, CS_KIND_SEVERITY, CS_SLA_BUCKETS, CS_SLA_BUCKET_LABEL, csCasePriority, csDueAt, csSlaBucket, getCustomerNextAction, type CsNextAction, type CsSlaBucket } from "@/lib/constants/cs-next-action";
import { CS_ACTIONABLE_STATUSES, CS_ASSIGNEE_FACET_BOT, CS_ASSIGNEE_FACET_LABEL, CS_ASSIGNEE_FACET_UNLINKED, CS_CASE_SLA_HOURS, CS_DOMAIN_LABEL, CS_DOMAINS, CS_LIFECYCLE_KINDS, CS_LOGISTICS_KINDS, csDomainOf, humanAssignee, type CsDomain } from "@/lib/constants/cs-domain";
import { assessOpenCases } from "@/lib/cs/stale";
import { rowsOf } from "@/lib/sql-rows";
import { decideScope } from "@/lib/auth/scope-guard";
import type { ListParams } from "@/lib/search-params";

export const CS_SORTABLE = ["createdAt", "updatedAt", "status", "kind", "followUpAt"];

/**
 * ═══════════ MỘT PHÉP PHÂN MIỀN, HAI BÀN LÀM VIỆC ĐỌC CHUNG ═══════════
 *
 * Luật nằm ở `lib/constants/cs-domain.ts`; đây là bản dịch sang SQL, và là bản DUY NHẤT. Trang
 * CSKH dùng nó để LOẠI việc giao vận khỏi hàng đợi; hàng đợi care của trang Vận đơn dùng đúng nó
 * để NHẬN việc đó về. Hai câu SQL song song sẽ lệch nhau, và cái lệch chỉ lộ ra khi có người ngồi
 * đối chiếu hai màn hình — tức là không bao giờ.
 *
 * `alias` là bí danh của bảng `cs_cases` trong câu đang viết (drizzle không đặt bí danh nên mặc
 * định là chính tên bảng). Chuỗi này luôn là hằng trong mã nguồn, không đến từ người dùng.
 */
function logisticsBody(kind: SQL | AnyColumn, orderId: SQL | AnyColumn): SQL {
  return sql`(${kind} in ${CS_LOGISTICS_KINDS} or (${kind} in ${CS_LIFECYCLE_KINDS} and ${csRunningHandoffExists(orderId)}))`;
}

/**
 * ═══ ĐƠN ĐÃ GIAO CHO ĐVVC CHƯA — RANH GIỚI CSKH / VẬN ĐƠN (chủ shop chốt 25/09/2026) ═══
 *
 * Áp cho các loại case `BY_SHIPMENT` (sai địa chỉ / SĐT — xem `CS_KIND_DOMAIN`). Đã giao = có một vận
 * đơn ở chặng `CARRIER_HANDOFF_STAGES` hoặc có mốc lấy hàng (AGENTS.md mục 41) — "Chờ lấy hàng",
 * "lấy thất bại", "shop huỷ lấy" là CHƯA. Hai bản dưới (SQL · TypeScript) là CÙNG một mệnh đề;
 * `tests/cs-workqueue.test.ts` chạy cả hai trên cùng dữ liệu.
 */
export function csHandedOffExists(orderId: SQL | AnyColumn): SQL {
  return sql`exists (select 1 from shipments cs_dom_s where cs_dom_s.order_id = ${orderId} and (cs_dom_s.stage::text in ${[...CARRIER_HANDOFF_STAGES]} or cs_dom_s.picked_up_at is not null))`;
}
export function isHandedOffToCarrier(s: { stage: string | null; pickedUpAt?: Date | string | null }): boolean {
  return Boolean(s.pickedUpAt) || (CARRIER_HANDOFF_STAGES as readonly string[]).includes(s.stage ?? "");
}

/**
 * ═══ KIỆN ĐANG TRÊN ĐƯỜNG — RANH GIỚI CSKH / VẬN ĐƠN (chủ shop chốt lại 25/09/2026, chiều) ═══
 *
 * "Đã giao cho ĐVVC" (hai hàm trên) là điều KIỆN CẦN, không còn là đủ: case khách chỉ thuộc Vận đơn
 * khi đơn còn một kiện ĐVVC đã cầm VÀ CHƯA CHỐT. Kiện đã chốt (giao xong · đã hoàn · huỷ, hoặc cờ
 * kết thúc của ĐVVC) thì không còn gì để care vận chuyển — việc còn lại (đổi, trả, khiếu nại) là
 * nói chuyện với khách, nên case về hàng đợi CSKH.
 *
 * Vì sao phải sửa ở LUẬT MIỀN chứ không chỉ ở bàn care: trang CSKH LOẠI mọi case miền Vận đơn. Chỉ
 * bỏ kiện đã chốt khỏi "Cần care" thì những case ấy biến mất ở CẢ HAI nơi. Đo production 25/09/2026:
 * đơn "Đã trả" / "Đã hoàn" đứng mãi ở "Cần care" vì case "trả hàng" tạo SAU khi hoàn (phiếu trả hàng
 * Pancake, thẻ "hoàn hàng", tin nhắn khách) kéo chúng vào, và nhân viên care không có nút nào gỡ được.
 */
export function csRunningHandoffExists(orderId: SQL | AnyColumn): SQL {
  return sql`exists (select 1 from shipments cs_dom_s where cs_dom_s.order_id = ${orderId} and (cs_dom_s.stage::text in ${[...CARRIER_HANDOFF_STAGES]} or cs_dom_s.picked_up_at is not null) and not coalesce(cs_dom_s.is_final, false) and cs_dom_s.stage::text not in ${[...CARE_TERMINAL_STAGES]})`;
}
export function isRunningHandoff(s: { stage: string | null; pickedUpAt?: Date | string | null; isFinal?: boolean | null }): boolean {
  return isHandedOffToCarrier(s) && !s.isFinal && !(CARE_TERMINAL_STAGES as readonly string[]).includes(s.stage ?? "");
}

/**
 * Bản dùng với trình dựng truy vấn của drizzle. PHẢI truyền cột drizzle chứ không phải tên bảng
 * viết tay: truy vấn quan hệ (`db.query.csCases.findMany`) đặt bí danh bảng theo KHOÁ TRONG LƯỢC ĐỒ
 * (`"csCases"`) chứ không theo tên bảng thật (`"cs_cases"`), nên một chuỗi gõ tay sẽ trỏ vào bí
 * danh không tồn tại và câu lệnh hỏng lúc chạy. Cột drizzle thì tự mang đúng bí danh của nơi nó
 * được nhúng vào.
 */
export function csLogisticsCond(): SQL {
  return logisticsBody(schema.csCases.kind, schema.csCases.orderId);
}

/** Phần bù: case thuộc về CSKH. Đúng một phép phủ định của luật trên, không gõ lại luật. */
export function csCustomerCond(): SQL {
  return sql`not ${csLogisticsCond()}`;
}

export function csDomainCond(domain: CsDomain): SQL {
  return domain === "LOGISTICS" ? csLogisticsCond() : csCustomerCond();
}

/**
 * Bản dùng trong SQL thô, nơi bảng có bí danh do người viết đặt (`from cs_cases c`). Cùng một thân
 * luật `logisticsBody` — không có bản luật thứ hai. `alias` luôn là hằng trong mã nguồn.
 */
export function csLogisticsCondRaw(alias: string): SQL {
  const a = sql.raw(`"${alias}"`);
  return logisticsBody(sql`${a}.kind`, sql`${a}.order_id`);
}
export function csCustomerCondRaw(alias: string): SQL {
  return sql`not ${csLogisticsCondRaw(alias)}`;
}

/** Miền đang xem. Không chọn gì = hàng đợi CSKH, đúng thứ người mở tab này cần làm. */
function domainsOf(params: ListParams): CsDomain[] {
  const picked = (params.filters.domain ?? []).filter((d): d is CsDomain => (CS_DOMAINS as readonly string[]).includes(d));
  return picked.length ? picked : ["CUSTOMER"];
}

/** Trạng thái đang xem. Không chọn gì = còn phải làm; case đã đóng là lịch sử, không phải hàng đợi. */
function statusesOf(params: ListParams): string[] {
  return params.filters.status?.length ? params.filters.status : [...CS_ACTIONABLE_STATUSES];
}

/**
 * ═══ LỌC THEO HẠN — CÙNG MỘT ĐỊNH NGHĨA VỚI CHIP TRÊN DÒNG ═══
 *
 * `csSlaBucket` (TypeScript, chạy ở trình duyệt để tô màu) và mệnh đề dưới đây (SQL, chạy để lọc)
 * phải nói CÙNG một điều, nếu không con số trên chip lọc sẽ khác số dòng bảng hiện ra — và người
 * dùng không biết con số nào đúng.
 *
 * Hai bên cùng đọc `CS_CASE_SLA_HOURS` và cùng công thức hạn (`coalesce(hẹn, tạo + SLA)`), nên
 * chúng không thể lệch về ĐỊNH NGHĨA. "Hôm nay" ở SQL tính theo ngày lịch của MÁY CHỦ, ở trình
 * duyệt theo ngày lịch của người dùng — cả hai đều chạy giờ Việt Nam nên trùng nhau; đây là chỗ
 * duy nhất hai bên có thể lệch, và nó lệch nhiều nhất là một dòng quanh nửa đêm.
 */
function slaCond(bucket: string): SQL {
  const han = dueAtSql();
  const soon = sql.raw(String(CS_DUE_SOON_HOURS));
  switch (bucket) {
    case "OVERDUE":
      return sql`${han} <= now()`;
    case "DUE_SOON":
      return sql`${han} > now() and ${han} <= now() + (${soon} * interval '1 hour')`;
    case "DUE_TODAY":
      return sql`${han} > now() + (${soon} * interval '1 hour') and ${han}::date = now()::date`;
    case "NOT_DUE":
      return sql`${han} > now() + (${soon} * interval '1 hour') and ${han}::date > now()::date`;
    default:
      return sql`true`;
  }
}

type FacetKey = "kind" | "status" | "assignee" | "domain" | "sla";

/**
 * Ô LỌC "PHỤ TRÁCH" — giá trị là KHOÁ TÀI KHOẢN, cộng hai rổ đặc biệt (`lib/constants/cs-domain.ts`).
 *
 * Trước bản này ô này lọc theo ô chữ `assignee`: bốn cách gõ tên một người là bốn mục, và "Bot ERP"
 * đứng chung hàng với nhân viên. Mệnh đề dưới và câu đếm facet dùng CÙNG một cách phân rổ
 * (`assigneeBucketExpr`), để con số cạnh mỗi mục đúng bằng số dòng bấm vào thấy.
 */
function assigneeBucketExpr(): SQL<string | null> {
  const c = schema.csCases;
  return sql<string | null>`coalesce(${c.assigneeUserId}, case when ${c.assignee} in ${CS_BOT_ASSIGNEES} then ${CS_ASSIGNEE_FACET_BOT} when ${c.assignee} <> '' then ${CS_ASSIGNEE_FACET_UNLINKED} end)`;
}

function assigneeFilterCond(values: string[]): SQL {
  return sql`${assigneeBucketExpr()} in ${values}`;
}

/**
 * `skip` bỏ đúng một điều kiện để đếm facet của chính nó: đếm "Đã xong" bằng bộ lọc đang có (vốn
 * loại trạng thái đóng) thì con số luôn bằng 0 và người dùng không bao giờ bấm vào được.
 */
/**
 * ═══════════ PHẠM VI DỮ LIỆU, ÁP NGAY TRONG TRUY VẤN ═══════════
 *
 * Trang `/cs` đã từ chối trước khi gọi tới đây khi phạm vi không biểu diễn được. Mệnh đề này là
 * LỚP THỨ HAI, và nó cố ý thừa: một hàm truy vấn phải an toàn dù ai gọi nó từ đâu. Nếu mai có
 * một route mới, một hành động, một lối xuất CSV gọi thẳng `listCsCases` mà quên cổng trang, thì
 * chỗ này vẫn chặn — thay vì lộ toàn bộ case của shop.
 *
 * `NONE` ở đây trả về `false` (không dòng nào), KHÔNG phải `undefined` (mọi dòng). Nhầm hai thứ
 * đó là cách một lá chắn biến thành một cánh cửa.
 */
async function phamViCs(): Promise<SQL | undefined> {
  const quyet = await decideScope("CS");
  if (quyet.allow === "ALL") return undefined;
  if (quyet.allow === "ROWS") return quyet.where;
  return sql`false`;
}

async function whereOf(params: ListParams, skip?: FacetKey) {
  const c = schema.csCases;
  const conds: (SQL | undefined)[] = [];
  if (params.period.from) conds.push(gte(c.createdAt, params.period.from));
  if (params.period.to) conds.push(lte(c.createdAt, params.period.to));
  if (skip !== "domain") {
    const domains = domainsOf(params);
    conds.push(domains.length >= CS_DOMAINS.length ? undefined : csDomainCond(domains[0]));
  }
  if (skip !== "status") conds.push(inArray(c.status, statusesOf(params)));
  if (skip !== "kind" && params.filters.kind?.length) conds.push(inArray(c.kind, params.filters.kind));
  if (skip !== "assignee" && params.filters.assignee?.length) conds.push(assigneeFilterCond(params.filters.assignee));
  if (skip !== "sla" && params.filters.sla?.length) {
    const chon = params.filters.sla.filter((b) => (CS_SLA_BUCKETS as readonly string[]).includes(b));
    if (chon.length) conds.push(or(...chon.map((b) => slaCond(b))));
  }
  const term = params.q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(or(ilike(c.title, like), ilike(c.detail, like), ilike(c.customerName, like), ilike(c.customerPhone, like), ilike(c.assignee, like)));
  }
  conds.push(await phamViCs());
  const defined = conds.filter((x): x is SQL => Boolean(x));
  return defined.length ? and(...defined) : undefined;
}

/** Ghi chú gần nhất + số ghi chú của từng case — một lượt cho cả trang, không N+1. */
async function loadCaseNotes(ids: string[]) {
  const out = new Map<string, { lastNote: string; lastNoteBy: string; lastNoteAt: Date; noteCount: number }>();
  if (!ids.length) return out;
  const db = await getDb();
  const rows = rowsOf<{ case_id: string; n: number; last_note: string | null; last_by: string | null; last_at: string }>(
    await db.execute(sql`
      select case_id,
             count(*)::int as n,
             (array_agg(note order by created_at desc))[1] as last_note,
             (array_agg(coalesce(nullif(actor_name, ''), actor_email) order by created_at desc))[1] as last_by,
             max(created_at) as last_at
        from cs_case_events
       where action = 'NOTE' and case_id in ${ids}
       group by case_id`),
  );
  for (const r of rows) out.set(r.case_id, { lastNote: r.last_note ?? "", lastNoteBy: r.last_by ?? "", lastNoteAt: new Date(r.last_at), noteCount: Number(r.n) });
  return out;
}

/** Một lần gửi của đơn gắn vào case. `tracking` là MÃ CHUẨN, đúng chuỗi CSKH dán sang trang ĐVVC. */
export type CsCaseShipment = { shipmentId: string; tracking: string; stage: string; isFinal: boolean; handedOff: boolean; running: boolean };

/**
 * ═══════════ MỌI LẦN GỬI CỦA ĐƠN GẮN VÀO CASE, VÀ LẦN ĐANG CHẠY LÀ CÁI NÀO ═══════════
 *
 * Trả về CẢ DANH SÁCH chứ không chỉ một mã, vì hai câu hỏi khác nhau đang dùng chung một chỗ:
 *
 *  · **"Case này thuộc miền vận đơn không?"** — `csDomainOf` hỏi có lần gửi ĐANG CHẠY hay không.
 *    Câu trả lời giữ nguyên nghĩa cũ: lần gửi chưa kết thúc (`is_final = false`) mới nhất.
 *  · **"CSKH cần dán mã nào sang trang Viettel Post?"** — câu này KHÔNG có cùng đáp án. Đo
 *    production 14/09/2026: 598 case có đơn kèm vận đơn, nhưng chỉ 294 case có lần gửi đang
 *    chạy. Hơn 300 case còn lại có mã vận đơn thật mà màn hình không hiện ra một ký tự nào, vì
 *    kiện đã kết thúc (đã giao / đã hoàn) — mà đó chính là những case CSKH phải gọi ĐVVC nhiều
 *    nhất.
 *
 * NÊN: lần gửi đang chạy vẫn là cái ĐỨNG ĐẦU và là cái được hiện mặc định; những lần gửi khác
 * không bị giấu, chúng nằm trong danh sách để giao diện liệt kê kèm trạng thái. Máy KHÔNG âm thầm
 * chọn một mã trong nhiều mã rồi để người dùng tưởng đó là mã duy nhất — chọn im lặng là cách một
 * mã đã huỷ bị dán sang ĐVVC mà không ai biết vì sao tra không ra.
 *
 * VẪN MỘT CÂU TRUY VẤN. Không có `lateral ... limit 1` nữa nên mỗi case có thể ra nhiều dòng; đo
 * production: 598/598 case có đơn đều có ĐÚNG 1 vận đơn, nên số dòng thực tế không đổi.
 */
async function loadCaseShipments(ids: string[]) {
  const out = new Map<string, { active: CsCaseShipment | null; all: CsCaseShipment[] }>();
  if (!ids.length) return out;
  const db = await getDb();
  const rows = rowsOf<{ case_id: string; shipment_id: string; tracking: string | null; stage: string | null; is_final: boolean; picked_up_at: string | null }>(
    await db.execute(sql`
      select c.id as case_id,
             s.id as shipment_id,
             coalesce(nullif(s.vtp_order_number, ''), nullif(s.tracking_code, ''), s.id) as tracking,
             s.stage::text as stage,
             s.is_final as is_final,
             s.picked_up_at as picked_up_at
        from cs_cases c
        join shipments s on s.order_id = c.order_id
       where c.id in ${ids}
       -- Lần gửi ĐANG CHẠY trước, rồi tới lần mới nhất. Thứ tự này CHÍNH LÀ luật chọn "lần gửi
       -- đang quyết định" ở dưới — viết trong ORDER BY để nó ổn định giữa hai lần chạy, thay vì
       -- phụ thuộc thứ tự Postgres trả về.
       order by c.id, s.is_final asc, s.created_at desc`),
  );
  for (const r of rows) {
    const item: CsCaseShipment = { shipmentId: r.shipment_id, tracking: r.tracking ?? r.shipment_id, stage: r.stage ?? "UNKNOWN", isFinal: Boolean(r.is_final), handedOff: isHandedOffToCarrier({ stage: r.stage, pickedUpAt: r.picked_up_at }), running: isRunningHandoff({ stage: r.stage, pickedUpAt: r.picked_up_at, isFinal: r.is_final }) };
    const cur = out.get(r.case_id) ?? { active: null, all: [] };
    cur.all.push(item);
    if (!cur.active && !item.isFinal) cur.active = item;
    out.set(r.case_id, cur);
  }
  return out;
}

/**
 * ═══ CHỨNG TỪ ĐÃ ĐI TIẾP MÀ CASE VẪN MỞ — NÓI RA TRÊN DÒNG ═══
 *
 * Máy đối chiếu (`lib/cs/stale.ts`, 15 phút/lần) tự đóng case mà điều kiện sinh ra nó đã hết —
 * TRỪ case đã có người thật cầm: máy không đóng hộ công của người. Trước bản này, những case ấy nằm
 * lại hàng đợi với đúng trạng thái cũ và không có dấu hiệu gì, nên người trực cứ thấy "Giục giao"
 * của một đơn ĐVVC đã phát xong từ tuần trước. Giờ dòng mang một câu lý do đọc được; người vẫn là
 * người bấm đóng.
 *
 * `autoClose` = chưa ai cầm ⇒ lượt đối chiếu tới sẽ tự đóng (dòng chỉ còn trong tối đa 15 phút).
 * Lỗi khi đánh giá KHÔNG làm sập trang: mất nhãn gợi ý tệ hơn nhiều so với mất cả hàng đợi.
 */
export type CsStaleHint = { reason: string; autoClose: boolean };

async function staleHints(ids: string[]): Promise<Map<string, CsStaleHint>> {
  const out = new Map<string, CsStaleHint>();
  if (!ids.length) return out;
  const danhGia = await assessOpenCases(ids).catch((e: unknown) => {
    console.error("[cs] không đánh giá được điều kiện sống của case:", e instanceof Error ? e.message : e);
    return [];
  });
  for (const a of danhGia) {
    if (a.verdict === "NEEDS_REVIEW" || a.verdict === "AUTO_RESOLVE") out.set(a.id, { reason: a.reason, autoClose: a.verdict === "AUTO_RESOLVE" });
  }
  return out;
}

export async function listCsCases(params: ListParams) {
  const db = await getDb();
  const c = schema.csCases;
  const where = await whereOf(params);
  const sortCol = params.sort === "updatedAt" ? c.updatedAt : params.sort === "status" ? c.status : params.sort === "kind" ? c.kind : params.sort === "followUpAt" ? c.followUpAt : c.createdAt;
  const [base, [{ total }]] = await Promise.all([
    db.query.csCases.findMany({
      where,
      orderBy: [params.dir === "asc" ? asc(sortCol) : desc(sortCol), desc(c.createdAt)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      with: { order: { columns: { id: true, systemId: true, pageId: true, conversationId: true, stage: true, totalPriceAfterDiscount: true, shipAddress: true, billPhone: true } } },
    }),
    db.select({ total: count() }).from(c).where(where),
  ]);
  const ids = base.map((r) => r.id);
  const [notes, shipments, hints] = await Promise.all([loadCaseNotes(ids), loadCaseShipments(ids), staleHints(ids)]);
  const rows = base.map((r) => {
    const kien = shipments.get(r.id) ?? null;
    const ship = kien?.active ?? null;
    return {
      ...r,
      /** Người THẬT đang cầm case — bot chỉ là người tạo, xem `lib/constants/cs-domain.ts`. */
      owner: humanAssignee(r.assignee),
      botTouched: Boolean(r.assignee) && CS_BOT_ASSIGNEES.includes(r.assignee),
      // Miền: có kiện ĐVVC đã cầm VÀ CHƯA CHỐT ⇒ Vận đơn; mọi kiện đã chốt ⇒ CSKH (chủ shop chốt 25/09/2026).
      domain: csDomainOf(r.kind, (kien?.all ?? []).some((k) => k.running)),
      shipment: ship,
      /** MỌI lần gửi của đơn, lần đang chạy đứng đầu — để CSKH thấy đủ mã, không phải một mã do máy chọn. */
      shipments: kien?.all ?? [],
      note: notes.get(r.id) ?? null,
      staleHint: hints.get(r.id) ?? null,
    };
  });
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}
export type CsCaseRow = Awaited<ReturnType<typeof listCsCases>>["rows"][number];

export async function csFacets(params: ListParams) {
  const db = await getDb();
  const c = schema.csCases;
  const [kinds, statuses, assignees, domains, slas] = await Promise.all([
    db.select({ value: c.kind, count: count() }).from(c).where(await whereOf(params, "kind")).groupBy(c.kind),
    db.select({ value: c.status, count: count() }).from(c).where(await whereOf(params, "status")).groupBy(c.status),
    // Gom theo VỊ TRÍ CỘT: lặp lại biểu thức trong `group by` thì drizzle sinh tham số mới và Postgres
    // không nhận ra đó là cùng một biểu thức với cột đang chọn.
    db
      .select({ value: assigneeBucketExpr(), label: schema.users.name, count: count() })
      .from(c)
      .leftJoin(schema.users, eq(schema.users.id, c.assigneeUserId))
      .where(and(await whereOf(params, "assignee"), sql`${assigneeBucketExpr()} is not null`))
      .groupBy(sql`1`, sql`2`),
    Promise.all(
      CS_DOMAINS.map(async (d) => {
        const [row] = await db.select({ n: count() }).from(c).where(and(await whereOf(params, "domain"), csDomainCond(d)));
        return { value: d as string, label: CS_DOMAIN_LABEL[d], count: Number(row?.n ?? 0) };
      }),
    ),
    // Bốn mức hạn: đếm bằng CHÍNH mệnh đề mà bộ lọc dùng, nên "số trên chip = số dòng khi bấm vào".
    (async () => {
      const nen = await whereOf(params, "sla");
      return Promise.all(
        CS_SLA_BUCKETS.map(async (b) => {
          const [row] = await db.select({ n: count() }).from(c).where(and(nen, slaCond(b)));
          return { value: b as string, label: CS_SLA_BUCKET_LABEL[b], count: Number(row?.n ?? 0) };
        }),
      );
    })(),
  ]);
  return {
    kinds: kinds.map((k) => ({ value: k.value, label: CS_KIND_LABEL[k.value as CsKind] ?? k.value, count: Number(k.count) })),
    statuses: statuses.map((k) => ({ value: k.value, label: CS_STATUS_LABEL[k.value as CsStatus] ?? k.value, count: Number(k.count) })),
    assignees: assignees
      .filter((k): k is typeof k & { value: string } => k.value !== null)
      .map((k) => ({ value: k.value, label: CS_ASSIGNEE_FACET_LABEL[k.value] ?? k.label ?? k.value, count: Number(k.count) })),
    domains,
    slas,
  };
}

/**
 * ĐẦU BẢNG CSKH ĐẾM ĐÚNG VIỆC CỦA CSKH.
 *
 * `logistics` KHÔNG cộng vào `open`: đó là số case đã chuyển quyền sở hữu sang Vận đơn & care,
 * hiện ra để người dùng biết chúng còn nguyên và biết đường đi tới — không phải để cộng khối lượng
 * việc của đội CSKH thêm một lần nữa.
 */
export async function csSummary() {
  const db = await getDb();
  const c = schema.csCases;
  // Cả BA truy vấn tổng hợp dưới đây đều phải mang phạm vi: một con số đếm trên toàn shop cũng là
  // rò rỉ — nó nói cho người xem biết có bao nhiêu case họ không được thấy.
  const pv = await phamViCs();
  const rows = await db
    .select({ kind: c.kind, status: c.status, assignee: c.assignee, count: count() })
    .from(c)
    .where(and(isNull(c.resolvedAt), csCustomerCond(), pv))
    .groupBy(c.kind, c.status, c.assignee);
  const open = rows.filter((r) => (CS_ACTIONABLE_STATUSES as readonly string[]).includes(r.status));
  const byKind: Record<string, number> = {};
  for (const r of open) byKind[r.kind] = (byKind[r.kind] ?? 0) + Number(r.count);
  const [logistics] = await db.select({ n: count() }).from(c).where(and(inArray(c.status, [...CS_ACTIONABLE_STATUSES]), csLogisticsCond(), pv));
  const [followUpDue] = await db
    .select({ n: count() })
    .from(c)
    .where(and(inArray(c.status, [...CS_ACTIONABLE_STATUSES]), csCustomerCond(), pv, sql`${c.followUpAt} is not null and ${c.followUpAt} <= now()`));
  return {
    open: open.reduce((a, r) => a + Number(r.count), 0),
    new: rows.filter((r) => r.status === "OPEN").reduce((a, r) => a + Number(r.count), 0),
    /** Chưa ai THẬT nhận: bot là người tạo, không phải người xử lý. */
    unassigned: open.filter((r) => !humanAssignee(r.assignee)).reduce((a, r) => a + Number(r.count), 0),
    byKind,
    /** Case còn phải làm nhưng thuộc miền giao vận — hiện ở Vận đơn & care, không nằm trong hàng đợi này. */
    logistics: Number(logistics?.n ?? 0),
    followUpDue: Number(followUpDue?.n ?? 0),
  };
}

export type BotMessageFailure = { caseId: string; shipmentId: string; orderId: string | null; title: string; detail: string; createdAt: Date };

/**
 * ═══════════ BOT KHÔNG NHẮN ĐƯỢC KHÁCH — THEO TỪNG KIỆN ═══════════
 *
 * `lib/cs/failed-delivery.ts` giữ chỗ một dòng `cs_cases` (loại `DELIVERY_FAILED`, miền GIAO VẬN)
 * cho mỗi lần Viettel Post báo giao hụt, rồi nhắn khách qua Pancake. Nhắn ĐƯỢC thì dòng mang
 * `assignee = 'Bot ERP'` (máy đã làm phần của máy). Nhắn KHÔNG ĐƯỢC (không có hội thoại Pancake,
 * Facebook chặn ngoài 24h, chưa cấu hình token) thì dòng ở `OPEN` với `assignee = ''` và tiêu đề
 * "⛔ Chưa xử lý" — tức là KHÔNG AI, người lẫn máy, đã chạm tới khách. Đo production 13/09/2026:
 * 339 dòng DELIVERY_FAILED còn mở, và kết luận "bot bó tay" chỉ nằm trong chính dòng ẩn đó.
 *
 * Hàng đợi CSKH cố ý không hiện loại này (miền giao vận); bàn care vận đơn là nơi phải thấy nó.
 * Hàm này trả về đúng thông tin ấy theo `shipmentId` để `lib/queries/care-workbench.ts` ghép vào
 * từng ca. Khoá ghép là `dedupe_key` (`failed-delivery:<shipmentId>:<ngày>`) — chính xác tới
 * kiện; dòng không mang khoá dạng đó thì ghép theo đơn, chỉ khi kiện ấy CHƯA kết thúc.
 *
 * KHÔNG hàm tổng hợp nào đếm các dòng này thành việc của người: `csSummary` / `openCsGroups` /
 * `csCasesToSurface` đều lọc `csCustomerCond()`, và `tests/cs-workqueue.test.ts` khoá điều đó.
 */
export async function botMessageFailuresByShipment(shipmentIds: string[]): Promise<Map<string, BotMessageFailure>> {
  const out = new Map<string, BotMessageFailure>();
  if (!shipmentIds.length) return out;
  const db = await getDb();
  const rows = rowsOf<{ case_id: string; shipment_id: string; order_id: string | null; title: string; detail: string; created_at: string }>(
    await db.execute(sql`
      select distinct on (s.id) c.id as case_id, s.id as shipment_id, c.order_id, c.title, c.detail, c.created_at
        from shipments s
        join cs_cases c
          on c.kind = 'DELIVERY_FAILED'
         and c.status = 'OPEN'
         and c.assignee = ''
         and c.title like '⛔%'
         and (c.dedupe_key like 'failed-delivery:' || s.id || ':%' or (coalesce(c.dedupe_key, '') not like 'failed-delivery:%' and c.order_id = s.order_id and s.is_final = false))
       where s.id in ${shipmentIds}
       order by s.id, c.created_at desc`),
  );
  for (const r of rows) out.set(r.shipment_id, { caseId: r.case_id, shipmentId: r.shipment_id, orderId: r.order_id, title: r.title, detail: r.detail, createdAt: new Date(r.created_at) });
  return out;
}

/** Case đang mở (cho cảnh báo) */
export async function openCsCases() {
  const db = await getDb();
  return db.select().from(schema.csCases).where(inArray(schema.csCases.status, ["OPEN"])).orderBy(desc(schema.csCases.createdAt)).limit(500);
}

/** Hạn xử lý của một case CSKH (giờ) — định nghĩa ở `lib/constants/cs-domain.ts`, xuất lại ở đây cho nơi gọi cũ. */
export { CS_CASE_SLA_HOURS };

export type CsCaseForAlert = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  customerName: string;
  customerPhone: string;
  assignee: string;
  orderId: string | null;
  createdAt: Date;
  updatedAt: Date | null;
};

/**
 * CASE NÀO LÊN HÀNG ĐỢI RIÊNG — luật ở lib/constants/cs.ts, đây chỉ là chỗ áp dụng.
 *
 * Trả về đúng những case cần một dòng việc riêng: loại `EACH`, xác nhận SĐT mà bot không gửi được,
 * case khách-đang-chờ đã quá hạn và còn trong cửa sổ cứu, hoặc case đã có NGƯỜI nhận mà quá hạn.
 *
 * CHỈ MIỀN CSKH. Case giao vận đã có dòng việc theo chính KIỆN đó (hàng đợi care + thông báo
 * `SHIPMENT_FAILED`); đẻ thêm một dòng `CS_CASE` nữa là hai người cùng được giao một việc.
 */
export async function csCasesToSurface(): Promise<CsCaseForAlert[]> {
  const db = await getDb();
  const c = schema.csCases;
  const rows = await db
    .select({ id: c.id, kind: c.kind, title: c.title, detail: c.detail, customerName: c.customerName, customerPhone: c.customerPhone, assignee: c.assignee, orderId: c.orderId, createdAt: c.createdAt, updatedAt: c.updatedAt })
    .from(c)
    .where(and(eq(c.status, "OPEN"), csCustomerCond()))
    .orderBy(desc(c.createdAt))
    .limit(2000);
  const now = Date.now();
  return rows.filter((r) => {
    const kind = r.kind as CsKind;
    if ((CS_SURFACE_MODE[kind] ?? "GROUP") === "EACH") return true;
    if (kind === "PHONE_VERIFY" && r.title.startsWith("⛔")) return true;
    const ageHours = (now - new Date(r.createdAt).getTime()) / 3_600_000;
    const overdue = ageHours > CS_CASE_SLA_HOURS;
    if (!overdue) return false;
    if (humanAssignee(r.assignee)) return true;
    return CS_ESCALATE_KINDS.includes(kind) && ageHours <= CS_ESCALATE_WINDOW_HOURS;
  });
}

export type CsOpenGroup = {
  kind: string;
  assignee: string;
  count: number;
  overdue: number;
  oldestHours: number;
  withOrder: number;
  /** Tổng giá trị các ĐƠN gắn vào case của nhóm — tiền đang có nguy cơ, nếu xác định được. */
  value: number;
};

/**
 * TỒN ĐỌNG CASE THEO (LOẠI · NGƯỜI PHỤ TRÁCH) — nguồn cho việc tổng hợp và cho bảng điều hành.
 *
 * `excludeIds`: case đã có dòng việc riêng thì không đếm vào nhóm nữa (không đếm hai lần).
 * Chỉ miền CSKH, cùng lý do với `csCasesToSurface`.
 */
export async function openCsGroups(excludeIds: string[] = []): Promise<CsOpenGroup[]> {
  const db = await getDb();
  const ex = excludeIds.length ? sql`and c.id not in ${excludeIds}` : sql``;
  const rows = rowsOf<{ kind: string; assignee: string; n: number; overdue: number; oldest: number; with_order: number; value: number }>(
    await db.execute(sql`
      select c.kind, coalesce(c.assignee, '') as assignee,
             count(*)::int as n,
             count(*) filter (where c.created_at < now() - (${CS_CASE_SLA_HOURS} * interval '1 hour'))::int as overdue,
             coalesce(max(extract(epoch from (now() - c.created_at)) / 3600), 0) as oldest,
             count(*) filter (where c.order_id is not null)::int as with_order,
             coalesce(sum(o.total_price_after_discount), 0) as value
        from cs_cases c
        left join orders o on o.id = c.order_id
       where c.status = 'OPEN' and ${csCustomerCondRaw("c")} ${ex}
       group by 1, 2
       order by 3 desc`),
  );
  return rows.map((r) => ({ kind: r.kind, assignee: r.assignee, count: Number(r.n), overdue: Number(r.overdue), oldestHours: Number(r.oldest), withOrder: Number(r.with_order), value: Number(r.value) }));
}

/** Khoá nhóm dùng làm `entity_id` của việc tổng hợp — một chỗ định nghĩa, hai chỗ đọc (cảnh báo và hàng đợi). */
export function csGroupKey(kind: string, assignee: string) {
  return `${kind}|${assignee}`;
}
export function parseCsGroupKey(key: string): { kind: string; assignee: string } {
  const i = key.indexOf("|");
  return i < 0 ? { kind: key, assignee: "" } : { kind: key.slice(0, i), assignee: key.slice(i + 1) };
}

/** Tiền đơn liên quan của từng nhóm case (cho hàng đợi việc). */
export async function csGroupValues(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!keys.length) return out;
  const groups = await openCsGroups();
  for (const g of groups) out.set(csGroupKey(g.kind, g.assignee), g.value);
  return out;
}

/** Lịch sử một case — chỉ thêm, mới nhất trước. Nguồn cho popover ghi chú trên dòng. */
export async function listCsCaseEvents(caseId: string, limit = 30) {
  const db = await getDb();
  return db.select().from(schema.csCaseEvents).where(eq(schema.csCaseEvents.caseId, caseId)).orderBy(desc(schema.csCaseEvents.createdAt)).limit(limit);
}
export type CsCaseEventRow = Awaited<ReturnType<typeof listCsCaseEvents>>[number];

export async function findOrderForCase(term: string) {
  const db = await getDb();
  const o = schema.orders;
  const num = Number(term);
  return db
    .select({ id: o.id, systemId: o.systemId, name: o.billFullName, phone: o.billPhone, customerId: o.customerId, total: o.totalPriceAfterDiscount })
    .from(o)
    .where(or(Number.isInteger(num) ? eq(o.systemId, num) : undefined, eq(o.id, term), ilike(o.billPhone, `%${term}%`)))
    .orderBy(desc(o.insertedAt))
    .limit(8);
}

/* ═══════════════════ MỘT KHÁCH — MỘT DÒNG VIỆC ═══════════════════ */

/**
 * ═══════════ GOM VIỆC THEO KHÁCH, KHÔNG PHẢI THEO CASE ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Hàng đợi CSKH liệt kê theo CASE, nên một khách có ba vấn đề chiếm ba dòng. Người trực gọi cho họ
 * ba lần, hoặc gọi một lần rồi vẫn thấy hai dòng đỏ còn lại và không biết đã xử lý tới đâu.
 *
 * ĐO PRODUCTION 13/09/2026
 *   426 dòng việc đang mở  ·  296 khách duy nhất  ·  228 case thuộc SĐT có từ 2 case trở lên
 *
 * Tức 130 dòng là cùng người với một dòng khác — gần một phần ba hàng đợi.
 *
 * ─── DANH TÍNH CHUẨN ───
 *
 * Ưu tiên `customer_id`; thiếu thì rơi về SĐT. SĐT trong CSDL đã chuẩn hoá ở đường ghi (đo: 0 dòng
 * lệch chuẩn), nên không cần bóc số lúc đọc.
 *
 * Case KHÔNG có cả hai thì đứng RIÊNG một dòng theo chính mã case — KHÔNG gom chúng lại thành một
 * nhóm "không rõ khách". Gộp những người không quen biết vào một dòng là tạo ra một khách hàng
 * không tồn tại.
 *
 * ─── KHÔNG MẤT GÌ ───
 *
 * Không xoá, không sửa, không gộp case. Mỗi case giữ nguyên mã, loại, đơn, nguồn, mốc tạo, trạng
 * thái và nhật ký của nó; dòng gom chỉ là một PHÉP CHIẾU để đọc. Đóng một case không đóng những
 * case còn lại — dòng gom vẫn mở chừng nào còn việc chưa xong.
 *
 * ─── KHÔNG DÙNG ĐỂ GHÉP ĐƠN ─── VỚI ─── VẬN ĐƠN ───
 *
 * Gom theo SĐT chỉ để XẾP MÀN HÌNH. Tuyệt đối không dùng nó làm căn cứ nối đơn với vận đơn: một
 * khách mua nhiều lần sẽ ghép nhầm mà trông vẫn như thật (xem `lib/returns/product-context.ts`).
 */
export type CsCustomerGroup = {
  /** Khoá gom: `c:<customer_id>` · `p:<sđt>` · `x:<mã case>` khi không có định danh nào. */
  key: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  /** Số case ĐANG MỞ của khách này. */
  openCount: number;
  /** Số case đã quá hạn — con số quyết định dòng có đỏ hay không. */
  overdueCount: number;
  /** Loại việc đang mở, đã bỏ trùng — để nhìn một dòng biết cần chuẩn bị gì trước khi gọi. */
  kinds: string[];
  oldestAt: Date;
  latestAt: Date;
  /** Hạn SỚM NHẤT trong các case còn mở. `null` = không case nào còn hạn sống. */
  dueAt: Date | null;
  slaBucket: CsSlaBucket;
  /** Điểm ưu tiên của khách = điểm của case gấp nhất. Chỉ để xếp thứ tự, không phải chỉ số. */
  priority: number;
  /** Đã có ai nhận ÍT NHẤT một case chưa. */
  anyAssigned: boolean;
  /** Người thật đang cầm việc của khách này (bỏ trùng, bỏ bot). */
  owners: string[];
  /** VIỆC NÊN LÀM TIẾP — luật xác định ở `lib/constants/cs-next-action.ts`. */
  nextAction: CsNextAction;
  /** Hội thoại Pancake của khách, nếu lần ra được từ bất kỳ case nào. */
  chatUrl: string | null;
  cases: CsCustomerCase[];
};

export type CsCustomerCase = {
  id: string;
  kind: string;
  status: string;
  source: string;
  orderId: string | null;
  orderSystemId: number | null;
  title: string;
  createdAt: Date;
  followUpAt: Date | null;
  assignee: string;
  assigneeUserId: string | null;
  dueAt: Date | null;
  slaBucket: CsSlaBucket;
  /** Đường mở đúng hội thoại Pancake của case. `null` = đơn landing/sheet, không có hội thoại. */
  chatUrl: string | null;
  /** Chứng từ đã đi tiếp mà case vẫn mở — xem `staleHints`. `null` = vẫn còn việc / chưa kết luận được. */
  staleHint: CsStaleHint | null;
};

/**
 * ═══ XẾP HÀNG ĐỢI THEO ĐỘ GẤP, KHÔNG THEO "AI NHIỀU VIỆC NHẤT" ═══
 *
 * Bản trước xếp theo `count(*) desc` — khách có nhiều việc nhất lên đầu. Nghe hợp lý, nhưng nó đẩy
 * một khiếu nại đơn lẻ đã quá hạn ba ngày xuống dưới một khách có bốn case tư vấn size còn mới.
 *
 * Ở đây phép xếp đi theo HẠN và MỨC NGHIÊM TRỌNG, và cả hai lấy từ CHÍNH hằng số mà giao diện
 * dùng: `CS_CASE_SLA_HOURS` và `CS_KIND_SEVERITY` được nội suy vào SQL chứ không gõ lại. Viết
 * lại thang điểm bằng tay ở đây là dựng nguồn thứ hai, và nó sẽ lệch ngay lần đầu ai đó chỉnh một
 * con số.
 *
 * SQL lo THỨ TỰ TRANG (phải phân trang được); `csCasePriority` lo thứ tự CHÍNH XÁC trong trang.
 * Hai lớp cùng đọc một bộ hằng nên chúng không thể mâu thuẫn về hướng.
 */
function severitySql(): SQL<number> {
  const c = schema.csCases;
  const nhanh = (CS_KINDS as readonly string[]).map((k) => sql`when ${c.kind} = ${k} then ${CS_KIND_SEVERITY[k as CsKind] ?? 20}`);
  return sql<number>`(case ${sql.join(nhanh, sql` `)} else 20 end)`;
}

/** Hạn của một case, ĐÚNG định nghĩa `csDueAt`: có hẹn thì hạn là cái hẹn, không thì tạo + SLA. */
function dueAtSql(): SQL<Date> {
  const c = schema.csCases;
  return sql<Date>`coalesce(${c.followUpAt}, ${c.createdAt} + (${CS_CASE_SLA_HOURS} * interval '1 hour'))`;
}

/**
 * Hàng đợi CSKH gom theo khách.
 *
 * Hai lượt truy vấn cố định: một lượt lấy khoá của trang (có phân trang), một lượt lấy TOÀN BỘ case
 * của đúng những khoá đó kèm đơn. Không có truy vấn nào nằm trong vòng lặp dòng — 296 khách vẫn là
 * hai câu lệnh, y như 3 khách.
 */
export async function listCsCustomerQueue(params: ListParams, now = new Date()): Promise<{ rows: CsCustomerGroup[]; total: number; pageCount: number }> {
  const db = await getDb();
  const c = schema.csCases;
  const where = await whereOf(params);

  // Khoá gom — CÙNG biểu thức ở cả hai lượt, nếu không trang hai sẽ gom khác trang một.
  const KHOA = sql<string>`case
    when ${c.customerId} is not null then 'c:' || ${c.customerId}
    when ${c.customerPhone} <> '' then 'p:' || ${c.customerPhone}
    else 'x:' || ${c.id}
  end`;

  const HAN = dueAtSql();
  const [keys, [{ total }]] = await Promise.all([
    db
      .select({
        key: KHOA.as("k"),
        openCount: sql<number>`count(*)`,
        oldestAt: sql<Date>`min(${c.createdAt})`,
        latestAt: sql<Date>`max(${c.createdAt})`,
        // Khoá xếp của TRANG: quá hạn trước, rồi tới mức nghiêm trọng cao nhất, rồi hạn sớm nhất.
        overdue: sql<number>`count(*) filter (where ${HAN} <= now())`,
        severity: sql<number>`max(${severitySql()})`,
        dueAt: sql<Date>`min(${HAN})`,
      })
      .from(c)
      .where(where)
      .groupBy(KHOA)
      .orderBy(sql`count(*) filter (where ${HAN} <= now()) desc`, sql`max(${severitySql()}) desc`, sql`min(${HAN}) asc`)
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize),
    db.select({ total: sql<number>`count(distinct ${KHOA})` }).from(c).where(where),
  ]);

  if (!keys.length) return { rows: [], total: Number(total), pageCount: 1 };

  const danhSachKhoa = keys.map((k) => k.key);
  const o = schema.orders;
  const cases = await db
    .select({
      key: KHOA.as("k"),
      id: c.id,
      kind: c.kind,
      status: c.status,
      source: c.source,
      orderId: c.orderId,
      title: c.title,
      createdAt: c.createdAt,
      followUpAt: c.followUpAt,
      assignee: c.assignee,
      assigneeUserId: c.assigneeUserId,
      chatUrl: c.chatUrl,
      conversationId: c.conversationId,
      customerId: c.customerId,
      customerName: c.customerName,
      customerPhone: c.customerPhone,
      orderSystemId: o.systemId,
      orderPageId: o.pageId,
      orderConversationId: o.conversationId,
    })
    .from(c)
    .leftJoin(o, eq(o.id, c.orderId))
    .where(and(where, sql`${KHOA} in ${danhSachKhoa}`))
    .orderBy(desc(c.createdAt));

  const hints = await staleHints(cases.map((x) => x.id));
  const theoKhoa = new Map<string, typeof cases>();
  for (const r of cases) {
    const list = theoKhoa.get(r.key) ?? [];
    list.push(r);
    theoKhoa.set(r.key, list);
  }

  /**
   * Đường mở hội thoại Pancake. `chat_url` do máy quét ghi sẵn là chắc nhất; thiếu thì dựng từ
   * (page · conversation) của đơn — ĐÚNG cách bảng theo-case dựng, không phải một cách thứ hai.
   * Không có cả hai ⇒ `null`, và giao diện KHÔNG vẽ nút: một nút bấm vào không đi đâu làm người
   * dùng mất tin vào cả hàng nút còn lại.
   */
  const chatCua = (r: (typeof cases)[number]): string | null =>
    r.chatUrl || (r.orderPageId && r.orderConversationId ? `https://pancake.vn/${r.orderPageId}?c_id=${r.orderConversationId}` : null);

  const rows: CsCustomerGroup[] = keys.map((k) => {
    const list = theoKhoa.get(k.key) ?? [];
    const dau = list[0];
    const chiTiet: CsCustomerCase[] = list.map((x) => {
      const dueAt = csDueAt({ kind: x.kind, status: x.status, createdAt: x.createdAt, followUpAt: x.followUpAt, assignee: x.assignee });
      return {
        id: x.id,
        kind: x.kind,
        status: x.status,
        source: x.source,
        orderId: x.orderId,
        orderSystemId: x.orderSystemId ?? null,
        title: x.title,
        createdAt: x.createdAt,
        followUpAt: x.followUpAt,
        assignee: x.assignee,
        assigneeUserId: x.assigneeUserId,
        dueAt,
        slaBucket: csSlaBucket(dueAt, now),
        chatUrl: chatCua(x),
        staleHint: hints.get(x.id) ?? null,
      };
    });
    const dangMo = chiTiet.filter((x) => (CS_ACTIONABLE_STATUSES as readonly string[]).includes(x.status));
    const hanSom = dangMo.map((x) => x.dueAt).filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    return {
      key: k.key,
      customerId: dau?.customerId ?? null,
      // Tên có thể trống ở vài case; lấy tên ĐẦU TIÊN khác rỗng thay vì để trống cả dòng.
      customerName: list.find((x) => x.customerName)?.customerName ?? "",
      customerPhone: list.find((x) => x.customerPhone)?.customerPhone ?? "",
      openCount: Number(k.openCount),
      overdueCount: dangMo.filter((x) => x.slaBucket === "OVERDUE").length,
      kinds: [...new Set(list.map((x) => x.kind))],
      oldestAt: new Date(k.oldestAt),
      latestAt: new Date(k.latestAt),
      dueAt: hanSom,
      slaBucket: csSlaBucket(hanSom, now),
      priority: Math.max(0, ...list.map((x) => csCasePriority({ kind: x.kind, status: x.status, createdAt: x.createdAt, followUpAt: x.followUpAt, assignee: x.assignee }, now))),
      anyAssigned: list.some((x) => Boolean(humanAssignee(x.assignee))),
      owners: [...new Set(list.map((x) => humanAssignee(x.assignee)).filter(Boolean))],
      nextAction: getCustomerNextAction(
        list.map((x) => ({ id: x.id, kind: x.kind, status: x.status, createdAt: x.createdAt, followUpAt: x.followUpAt, assignee: x.assignee })),
        now,
      ),
      chatUrl: list.map(chatCua).find(Boolean) ?? null,
      cases: chiTiet,
    };
  });

  /*
    XẾP CHÍNH XÁC TRONG TRANG bằng đúng hàm mà giao diện dùng để tô màu. SQL đã đưa đúng tập dòng
    của trang này lên (theo cùng bộ hằng), việc còn lại là xếp lại cho khớp tới từng điểm.
  */
  rows.sort((a, b) => b.priority - a.priority || (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || a.key.localeCompare(b.key));

  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

/**
 * ═══════════ KHỐI LƯỢNG VIỆC THEO NGƯỜI — ĐỂ ĐIỀU PHỐI, KHÔNG ĐỂ CHẤM ĐIỂM ═══════════
 *
 * Trưởng ca cần biết ai đang gánh bao nhiêu để chia lại việc trong ca. Đó là toàn bộ mục đích.
 *
 * KHÔNG dùng để thưởng/phạt (AGENTS.md mục 24, 27): "đã đóng hôm nay" phụ thuộc loại case rơi vào
 * tay ai, và "thời gian xử lý" phụ thuộc khách có bắt máy hay không — hai thứ người trực không
 * quyết được. Bảng này cố ý KHÔNG có cột xếp hạng và KHÔNG có điểm tổng.
 *
 * Gom theo KHOÁ TÀI KHOẢN (AGENTS.md mục 34): dòng chỉ có tên gõ tay đứng riêng ở nhóm "chưa nối
 * tài khoản", và bot đứng ở nhóm "máy" — gộp chúng vào người là báo cáo nói có người làm trong khi
 * thực tế chưa ai nhận.
 */
export type CsOwnerLoad = {
  /** `users.id`, hoặc rổ đặc biệt `__BOT__` / `__UNLINKED__` / `__NONE__`. */
  key: string;
  label: string;
  open: number;
  overdue: number;
  waitingCustomer: number;
  completedToday: number;
  /** Trung vị thời gian từ lúc mở tới lúc đóng, tính bằng GIỜ, trên các case đã đóng 30 ngày qua. `null` = chưa đủ mẫu. */
  medianResolutionHours: number | null;
};

export async function csOwnerLoad(now = new Date()): Promise<CsOwnerLoad[]> {
  const db = await getDb();
  const c = schema.csCases;
  const pv = await phamViCs();
  const ro = sql<string>`coalesce(${c.assigneeUserId}, case when ${c.assignee} in ${CS_BOT_ASSIGNEES} then ${CS_ASSIGNEE_FACET_BOT} when ${c.assignee} <> '' then ${CS_ASSIGNEE_FACET_UNLINKED} else '__NONE__' end)`;
  const rows = await db
    .select({
      key: ro.as("ro"),
      label: schema.users.name,
      email: schema.users.email,
      open: sql<number>`count(*) filter (where ${c.status} in ('OPEN','IN_PROGRESS'))`,
      overdue: sql<number>`count(*) filter (where ${c.status} in ('OPEN','IN_PROGRESS') and ${dueAtSql()} <= now())`,
      waiting: sql<number>`count(*) filter (where ${c.status} in ('OPEN','IN_PROGRESS') and ${c.kind} in ${CS_CUSTOMER_WAITING_KINDS})`,
      completedToday: sql<number>`count(*) filter (where ${c.status} = 'DONE' and ${c.resolvedAt} >= date_trunc('day', now()))`,
      medianHours: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${c.resolvedAt} - ${c.createdAt})) / 3600) filter (where ${c.status} = 'DONE' and ${c.resolvedAt} >= now() - interval '30 days')`,
    })
    .from(c)
    .leftJoin(schema.users, eq(schema.users.id, c.assigneeUserId))
    .where(and(csCustomerCond(), pv))
    .groupBy(sql`1`, sql`2`, sql`3`);

  void now;
  return rows
    .map((r) => ({
      key: r.key,
      label: CS_ASSIGNEE_FACET_LABEL[r.key] ?? (r.key === "__NONE__" ? "Chưa ai nhận" : r.label || r.email || r.key),
      open: Number(r.open),
      overdue: Number(r.overdue),
      waitingCustomer: Number(r.waiting),
      completedToday: Number(r.completedToday),
      /*
        TRUNG VỊ CHƯA ĐỦ MẪU LÀ `null`, KHÔNG PHẢI 0 (AGENTS.md mục 42).

        Một người đóng đúng hai case trong 30 ngày thì trung vị của họ không nói lên điều gì; in ra
        "0,5 giờ" cạnh tên một người khác có 40 case là mời người đọc so hai thứ không so được.
      */
      medianResolutionHours: r.medianHours === null || Number(r.completedToday) + Number(r.open) === 0 ? null : Number(r.medianHours),
    }))
    .filter((r) => r.open > 0 || r.completedToday > 0)
    .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.label.localeCompare(b.label, "vi"));
}
