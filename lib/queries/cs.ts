import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CS_BOT_ASSIGNEES, CS_ESCALATE_KINDS, CS_ESCALATE_WINDOW_HOURS, CS_KIND_LABEL, CS_STATUS_LABEL, CS_SURFACE_MODE, type CsKind, type CsStatus } from "@/lib/constants/cs";
import { CS_ACTIONABLE_STATUSES, CS_ASSIGNEE_FACET_BOT, CS_ASSIGNEE_FACET_LABEL, CS_ASSIGNEE_FACET_UNLINKED, CS_CASE_SLA_HOURS, CS_DOMAIN_LABEL, CS_DOMAINS, CS_LIFECYCLE_KINDS, CS_LOGISTICS_KINDS, csDomainOf, humanAssignee, type CsDomain } from "@/lib/constants/cs-domain";
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
  return sql`(${kind} in ${CS_LOGISTICS_KINDS} or (${kind} in ${CS_LIFECYCLE_KINDS} and exists (select 1 from shipments cs_dom_s where cs_dom_s.order_id = ${orderId} and cs_dom_s.is_final = false)))`;
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

type FacetKey = "kind" | "status" | "assignee" | "domain";

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

/** Lần gửi ĐANG CHẠY của đơn gắn vào case — căn cứ phân miền, và là đường đi sang care vận đơn. */
async function loadActiveShipments(ids: string[]) {
  const out = new Map<string, { shipmentId: string; tracking: string; stage: string }>();
  if (!ids.length) return out;
  const db = await getDb();
  const rows = rowsOf<{ case_id: string; shipment_id: string | null; tracking: string | null; stage: string | null }>(
    await db.execute(sql`
      select c.id as case_id,
             s.id as shipment_id,
             coalesce(nullif(s.vtp_order_number, ''), nullif(s.tracking_code, ''), s.id) as tracking,
             s.stage::text as stage
        from cs_cases c
        left join lateral (
               select id, vtp_order_number, tracking_code, stage
                 from shipments
                where order_id = c.order_id and is_final = false
                order by created_at desc
                limit 1) s on true
       where c.id in ${ids}`),
  );
  for (const r of rows) if (r.shipment_id) out.set(r.case_id, { shipmentId: r.shipment_id, tracking: r.tracking ?? r.shipment_id, stage: r.stage ?? "UNKNOWN" });
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
  const [notes, shipments] = await Promise.all([loadCaseNotes(ids), loadActiveShipments(ids)]);
  const rows = base.map((r) => {
    const ship = shipments.get(r.id) ?? null;
    return {
      ...r,
      /** Người THẬT đang cầm case — bot chỉ là người tạo, xem `lib/constants/cs-domain.ts`. */
      owner: humanAssignee(r.assignee),
      botTouched: Boolean(r.assignee) && CS_BOT_ASSIGNEES.includes(r.assignee),
      domain: csDomainOf(r.kind, Boolean(ship)),
      shipment: ship,
      note: notes.get(r.id) ?? null,
    };
  });
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}
export type CsCaseRow = Awaited<ReturnType<typeof listCsCases>>["rows"][number];

export async function csFacets(params: ListParams) {
  const db = await getDb();
  const c = schema.csCases;
  const [kinds, statuses, assignees, domains] = await Promise.all([
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
  ]);
  return {
    kinds: kinds.map((k) => ({ value: k.value, label: CS_KIND_LABEL[k.value as CsKind] ?? k.value, count: Number(k.count) })),
    statuses: statuses.map((k) => ({ value: k.value, label: CS_STATUS_LABEL[k.value as CsStatus] ?? k.value, count: Number(k.count) })),
    assignees: assignees
      .filter((k): k is typeof k & { value: string } => k.value !== null)
      .map((k) => ({ value: k.value, label: CS_ASSIGNEE_FACET_LABEL[k.value] ?? k.label ?? k.value, count: Number(k.count) })),
    domains,
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
