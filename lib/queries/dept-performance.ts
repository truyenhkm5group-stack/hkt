import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { CASE_SLA_HOURS } from "@/lib/constants/action-queue";
import { CARE_SLA } from "@/lib/constants/care";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { DEPT_PERF } from "@/lib/constants/department-performance";
import { rowsOf } from "@/lib/sql-rows";
import { metricConfidence, rankable, type MetricConfidence, type PersonLinkage } from "@/lib/constants/metric-provenance";

/**
 * ═══════════ HIỆU SUẤT THẬT CỦA TỪNG PHÒNG — ĐỌC TỪ CHỨNG TỪ, KHÔNG ĐẾM TASK ═══════════
 *
 * Thẻ điểm chung (`lib/queries/work-performance.ts`) đo thứ AI CŨNG CÓ: đóng việc đúng hạn không,
 * có phải mở lại không. Tệp này đo thứ CHỈ PHÒNG ĐÓ MỚI CÓ, và đọc thẳng từ bảng nghiệp vụ:
 *
 *   Kinh doanh  ← `cs_cases` (+ `orders.conversation_id` để lần ra đơn sinh từ hội thoại)
 *   Giao vận    ← `care_case_events` (nhật ký chỉ-thêm, có ảnh chụp SLA từng sự kiện)
 *   Kho         ← `return_inspections` (`received_by` / `inspected_by` là email người thật)
 *   Kế toán     ← `audit_logs` (`BANK_CLASSIFY` / `BANK_LINK` có `user_id`) + `bank_transactions`
 *   Marketing   ← KHÔNG CÓ NGUỒN Ở ĐỘ MỊN NGƯỜI. Nói thẳng, không dựng số thay thế.
 *
 * ─── BA LUẬT ───
 *
 * 1. **Không đếm số việc đã xong làm năng suất.** Không hàm nào ở đây trả về "đã làm bao nhiêu
 *    việc" như một điểm số. Số lượng chỉ xuất hiện làm MẪU SỐ của một tỷ lệ, hoặc đứng cạnh tiền.
 *
 * 2. **Vùng kiểm soát.** Chỉ số nào mà kết quả do bên ngoài quyết (ĐVVC giao được hay không,
 *    khách có nhận hàng không) đều mang cờ `shared: true` và giao diện in "kết quả chung" —
 *    chúng là BỐI CẢNH để hiểu con số, không phải điểm chấm người.
 *
 * 3. **`null` là chưa đo được.** Mẫu số bằng 0 thì trả `null`, không trả 0%. Một người chưa xử lý
 *    ca nào trong kỳ không phải là người làm sai 100%.
 */

/** Phần các hàm đo TỰ KHAI. Phần xuất xứ do `hoanThien()` gắn vào — xem bên dưới. */
export type MetricInput = {
  key: string;
  label: string;
  /** `null` = chưa có quan sát nào trong kỳ. KHÔNG BAO GIỜ thay bằng 0. */
  value: number | null;
  unit: "PERCENT" | "COUNT" | "VND" | "HOURS" | "DAYS";
  /** Mẫu số: con số trên đứng trên bao nhiêu quan sát. */
  sample: number;
  /** Kết quả do bên ngoài đồng quyết định — đọc làm bối cảnh, không phải điểm chấm người. */
  shared: boolean;
  /** Nguồn số liệu, để người đọc kiểm chứng được. */
  basis: string;
  /** Mẫu số này ĐẾM CÁI GÌ. "trên 12" vô nghĩa nếu không nói 12 cái gì. */
  denominatorLabel: string;
};

/**
 * Chỉ số đã ĐỦ XUẤT XỨ để một người ngoài đọc và kiểm chứng được.
 *
 * Sáu trường cuối KHÔNG do hàm đo tự điền. Chúng được gắn ở một chỗ duy nhất (`hoanThien`), nên
 * một chỉ số mới thêm vào ngày mai không thể quên khai — nó lấy xuất xứ tự động hoặc không biên
 * dịch được.
 */
export type MetricValue = MetricInput & {
  /** `UNKNOWN` = không có quan sát nào. Cố ý KHÔNG gộp với "kết quả kém". */
  status: "MEASURED" | "UNKNOWN";
  confidence: MetricConfidence;
  /** Con số này nói về MỘT NGƯỜI hay về CẢ PHÒNG. */
  owner: "PERSON" | "DEPARTMENT";
  period: { from: Date; to: Date };
  /** Cách nối dòng dữ liệu về con người — quyết định khả năng nhầm người. */
  linkage: PersonLinkage;
  /** Một câu: phần nào của con số này KHÔNG do người đó quyết được. */
  attribution: string;
  /** Đủ mẫu để xếp hạng người với người chưa. */
  rankable: boolean;
};

export type PersonMetrics = { userId: string; name: string; email: string; metrics: MetricValue[] };

/**
 * Gắn xuất xứ vào một chỉ số thô. MỘT chỗ duy nhất, nên không chỉ số nào thiếu được.
 *
 * `attribution` lấy từ `DEPT_PERF[phòng].notAttributed` — nghĩa là luật "không phạt ai vì thứ họ
 * không quyết được" đi THEO TỪNG CON SỐ tới tận giao diện, chứ không nằm yên trong tài liệu.
 */
function hoanThien(m: MetricInput, ctx: { owner: "PERSON" | "DEPARTMENT"; from: Date; to: Date; linkage: PersonLinkage; attribution: string }): MetricValue {
  const confidence = metricConfidence({ value: m.value, sample: m.sample, linkage: ctx.linkage, shared: m.shared });
  return {
    ...m,
    status: m.value === null ? "UNKNOWN" : "MEASURED",
    confidence,
    owner: ctx.owner,
    period: { from: ctx.from, to: ctx.to },
    linkage: ctx.linkage,
    attribution: ctx.attribution,
    // Chưa đo được thì không xếp hạng; đo được nhưng mẫu bé cũng không.
    rankable: m.value !== null && rankable(m.sample),
  };
}

export type DeptPerformance = {
  department: DepartmentCode;
  label: string;
  /** Chỉ số mức PHÒNG — không quy về cá nhân được, và không nên. */
  team: MetricValue[];
  /** Chỉ số mức NGƯỜI. */
  people: PersonMetrics[];
  /** Chỉ số chủ shop muốn mà ERP chưa đọc được ở độ mịn NGƯỜI — lấy từ sổ khai báo. */
  missing: { label: string; note: string }[];
  /** Câu quy kết của phòng — để chỗ chụp ảnh gắn được vào cả những dòng CHƯA ĐO ĐƯỢC. */
  missingAttribution: string;
  from: Date;
  to: Date;
};

function pct(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : null;
}

/* ═══════════════════ KINH DOANH & CSKH ═══════════════════ */

type SalesRow = { who: string; closed: number; on_time: number; with_conv: number; converted: number; delivered: number; returned: number; revenue: string | number };

/**
 * Một hàng cho mỗi người xử lý case, ghép theo KHOÁ TÀI KHOẢN `cs_cases.assignee_user_id`.
 *
 * ─── VÌ SAO BỎ CÁCH GHÉP CŨ (Ô CHỮ `assignee`) ───
 *
 * Bản trước ghép bằng TÊN đã chuẩn hoá. Đo lại trên production 13/09/2026 thì cách đó không những
 * yếu — nó SAI: `cs_cases` có 785 dòng, và ô phụ trách chỉ chứa ĐÚNG MỘT chuỗi khác rỗng, là
 * `Bot ERP` (187 dòng). Tức là cách ghép cũ đang dựng một "người" tên Bot ERP với 187 case và
 * chấm điểm nó, trong khi số người thật được đo là 0.
 *
 * Nay ghép bằng khoá. Hệ quả trung thực: chừng nào chưa ai giao case cho người thật thì phòng
 * Kinh doanh KHÔNG có chỉ số cá nhân, và màn hình nói đúng như vậy thay vì hiện một cái tên máy.
 *
 * Dòng cũ KHÔNG bị xoá: chúng vẫn còn nguyên trong bảng, vẫn tra được ở màn CSKH, chỉ là không
 * vào thẻ điểm — vì không có gì nối chúng về một con người.
 */
async function salesMetrics(from: Date, to: Date): Promise<Map<string, MetricInput[]>> {
  const db = await getDb();
  const rows = rowsOf<SalesRow>(
    await db.execute(sql`
      with da_dong as (
        select c.assignee_user_id as who, c.id, c.created_at, c.resolved_at, c.conversation_id
        from cs_cases c
        where c.status = 'DONE' and c.resolved_at between ${from} and ${to} and c.assignee_user_id is not null
      ),
      ghep_don as (
        select d.*, o.id as order_id, coalesce(o.value, 0) as order_value,
               cof.outcome as outcome
        from da_dong d
        -- Đơn sinh từ CHÍNH hội thoại của case: đây là chỗ duy nhất ERP nối được "người trả lời"
        -- với "đơn đã lên". Không có mã hội thoại thì không nối — không đoán theo số điện thoại.
        left join lateral (
          -- CÙNG MỘT CỘT DOANH THU với DELIVERED_REVENUE (lib/queries/metrics.ts): giá sau giảm.
          -- Lấy cột khác ở đây thì hai màn hình nói hai con số về cùng một đơn.
          select o2.id, o2.total_price_after_discount as value
          from orders o2
          where d.conversation_id is not null and o2.conversation_id = d.conversation_id
          order by o2.inserted_at asc
          limit 1
        ) o on true
        /*
          MỘT DÒNG CHO MỖI ĐƠN, KHÔNG PHẢI MỖI VẬN ĐƠN.

          Bảng kết quả đơn có độ mịn (đơn × vận đơn): đơn gửi lại lần hai có hai dòng.
          Nối thẳng theo order_id sẽ đếm case đó hai lần và thổi phồng cả tử lẫn mẫu. Lấy đúng
          một dòng, ưu tiên dòng GIAO THÀNH CÔNG — một đơn có một lần giao được thì nó đã tới tay
          khách, bất kể lần gửi trước đó hoàn.
        */
        left join lateral (
          select c2.outcome
          from canonical_order_outcome c2
          where c2.order_id = o.id
          order by (c2.outcome = 'DELIVERED') desc, (c2.outcome in ('RETURNED','RETURNED_BY_RULE')) desc
          limit 1
        ) cof on true
      )
      select who,
             count(*)::int as closed,
             count(*) filter (where resolved_at <= created_at + (${CASE_SLA_HOURS.CS_CASE ?? 4} || ' hours')::interval)::int as on_time,
             count(*) filter (where conversation_id is not null)::int as with_conv,
             count(*) filter (where order_id is not null)::int as converted,
             count(*) filter (where outcome = 'DELIVERED')::int as delivered,
             count(*) filter (where outcome in ('RETURNED','RETURNED_BY_RULE'))::int as returned,
             coalesce(sum(order_value) filter (where outcome = 'DELIVERED'), 0) as revenue
      from ghep_don
      group by who
    `),
  );

  const out = new Map<string, MetricInput[]>();
  for (const r of rows) {
    const ketThuc = Number(r.delivered) + Number(r.returned);
    out.set(r.who, [
      {
        key: "sales_followup_sla",
        label: "Trả lời / đóng case trong hạn",
        value: pct(Number(r.on_time), Number(r.closed)),
        unit: "PERCENT",
        sample: Number(r.closed),
        shared: false,
        basis: `cs_cases: đóng trong ${CASE_SLA_HOURS.CS_CASE} giờ kể từ lúc case xuất hiện`,
        denominatorLabel: "case CSKH CÓ ĐẶT HẠN mà người này đã đóng trong kỳ",
      },
      {
        key: "sales_conversion",
        label: "Hội thoại ra đơn",
        value: pct(Number(r.converted), Number(r.with_conv)),
        unit: "PERCENT",
        sample: Number(r.with_conv),
        shared: false,
        basis: "cs_cases.conversation_id → orders.conversation_id. Mẫu số chỉ gồm case CÓ mã hội thoại; case không có thì không nối được và rơi khỏi cả tử lẫn mẫu",
        denominatorLabel: "case có mã hội thoại (case không có mã thì không nối được và rơi khỏi cả tử lẫn mẫu)",
      },
      {
        key: "sales_delivered_quality",
        label: "Đơn từ case này giao thành công",
        value: pct(Number(r.delivered), ketThuc),
        unit: "PERCENT",
        sample: ketThuc,
        // KẾT QUẢ CHUNG: người chốt không quyết được bưu tá có giao được không.
        shared: true,
        basis: "ORDER_OUTCOME của đơn sinh từ hội thoại của case, chỉ đơn ĐÃ kết thúc",
        denominatorLabel: "đơn sinh từ hội thoại của case, chỉ tính đơn ĐÃ kết thúc",
      },
      {
        key: "sales_contribution",
        label: "Doanh thu giao thành công từ case",
        value: Number(r.revenue) || 0,
        unit: "VND",
        sample: Number(r.delivered),
        shared: true,
        basis: "Tổng giá trị đơn giao thành công sinh từ hội thoại của case người này đã đóng",
        denominatorLabel: "đơn giao thành công sinh từ case người này đóng",
      },
    ]);
  }
  return out;
}

/* ═══════════════════ GIAO VẬN ═══════════════════ */

type CareRow = { user_id: string; resolved: number; on_time: number; delivered: number; cod: string | number };

/**
 * Đọc từ `care_case_events` — nhật ký CHỈ THÊM, và mỗi sự kiện mang ẢNH CHỤP SLA lúc nó xảy ra.
 *
 * Vì sao không đọc `shipment_care.owner_id`: cột đó là chủ HIỆN TẠI. Một ca đổi tay ba lần thì nó
 * chỉ nhớ người cuối, và người đóng ca có thể không phải người cuối được gán. Nhật ký thì ghi
 * đúng AI BẤM ĐÓNG, và không bị viết lại.
 */
async function logisticsMetrics(from: Date, to: Date): Promise<Map<string, MetricInput[]>> {
  const db = await getDb();
  const rows = rowsOf<CareRow>(
    await db.execute(sql`
      with dong_ca as (
        select e.actor_id as user_id, e.shipment_id, e.created_at,
               (e.sla ->> 'resolveDueAt')::timestamptz as due_at
        from care_case_events e
        where e.actor_id is not null
          and e.action in ('RESOLVE', 'STATUS')
          and e.next_status = 'RESOLVED'
          and e.created_at between ${from} and ${to}
      ),
      kem_don as (
        select d.*, s.order_id, coalesce(nullif(s.cod_collected, 0), s.cod_amount, 0) as cod,
               cof.outcome as outcome
        from dong_ca d
        join shipments s on s.id = d.shipment_id
        -- Nối theo ĐÚNG ĐỘ MỊN của bảng kết quả (đơn × vận đơn): chỉ số này nói về CHÍNH kiện
        -- người đó care, không nói về mọi kiện của đơn.
        left join canonical_order_outcome cof on cof.shipment_id = s.id
      )
      select user_id,
             count(*)::int as resolved,
             -- Ảnh chụp SLA thiếu (sự kiện đời cũ) thì KHÔNG tính là đúng hạn và cũng không tính
             -- là trễ: nó rơi khỏi mẫu số ở dòng dưới.
             count(*) filter (where due_at is not null and created_at <= due_at)::int as on_time,
             count(*) filter (where outcome = 'DELIVERED')::int as delivered,
             coalesce(sum(cod) filter (where outcome = 'DELIVERED'), 0) as cod
      from kem_don
      group by user_id
    `),
  );
  const coSla = rowsOf<{ user_id: string; n: number }>(
    await db.execute(sql`
      select e.actor_id as user_id, count(*)::int as n
      from care_case_events e
      where e.actor_id is not null and e.action in ('RESOLVE','STATUS') and e.next_status = 'RESOLVED'
        and e.created_at between ${from} and ${to} and (e.sla ->> 'resolveDueAt') is not null
      group by e.actor_id
    `),
  );
  const mauSo = new Map(coSla.map((r) => [r.user_id, Number(r.n)]));

  const out = new Map<string, MetricInput[]>();
  for (const r of rows) {
    const n = mauSo.get(r.user_id) ?? 0;
    out.set(r.user_id, [
      {
        key: "care_sla",
        label: "Đóng ca care trong hạn",
        value: pct(Number(r.on_time), n),
        unit: "PERCENT",
        sample: n,
        shared: false,
        basis: `care_case_events: mốc đóng ca ≤ hạn đóng đã chụp lúc đó (${CARE_SLA.resolveHours} giờ kể từ khi ca vào hàng đợi)`,
        denominatorLabel: "ca care người này đã đóng trong kỳ",
      },
      {
        key: "care_recovered",
        label: "Kiện cứu được (giao thành công sau khi care)",
        value: Number(r.delivered),
        unit: "COUNT",
        sample: Number(r.resolved),
        // KẾT QUẢ CHUNG: bưu tá quyết chuyến giao cuối. Người care quyết việc họ làm, đo ở dòng trên.
        shared: true,
        basis: "Ca người này đóng, đối chiếu ORDER_OUTCOME của đơn gắn với kiện đó",
        denominatorLabel: "kiện có ca care do người này đóng, chỉ kiện ĐÃ kết thúc",
      },
      {
        key: "care_cod_recovered",
        label: "Tiền COD về được từ kiện đã care",
        value: Number(r.cod) || 0,
        unit: "VND",
        sample: Number(r.delivered),
        shared: true,
        basis: "Thực thu COD (hoặc COD khai) của kiện giao thành công sau khi người này đóng ca",
        denominatorLabel: "kiện giao thành công sau khi người này đóng ca",
      },
    ]);
  }
  return out;
}

/* ═══════════════════ KHO ═══════════════════ */

type WhRow = { who: string; inspected: number; on_time: number; with_issue: number; unsellable: string | number };

/**
 * Ghép theo KHOÁ TÀI KHOẢN `inspected_by_user_id`, không theo email.
 *
 * Email đọc được nhưng không quy kết được: người đổi email là mất dấu toàn bộ phiếu cũ. Phiếu
 * lập trước migration 0073 không có khoá nên không vào thẻ điểm — và đó là câu trả lời đúng, vì
 * không có gì trong dữ liệu nối chúng chắc chắn về một tài khoản.
 */
async function warehouseMetrics(from: Date, to: Date): Promise<Map<string, MetricInput[]>> {
  const db = await getDb();
  const gio = CASE_SLA_HOURS.RETURN_RECEIVED_PENDING_INSPECTION ?? 72;
  const rows = rowsOf<WhRow>(
    await db.execute(sql`
      select i.inspected_by_user_id as who,
             count(*)::int as inspected,
             count(*) filter (where i.inspected_at <= i.received_at + (${gio} || ' hours')::interval)::int as on_time,
             -- LỆCH = kiện không về nguyên vẹn: có hàng không bán lại được, hoặc kết luận khác 'OK'.
             count(*) filter (where i.unsellable_qty > 0 or coalesce(i.condition, 'OK') <> 'OK')::int as with_issue,
             coalesce(sum(i.unsellable_qty), 0) as unsellable
      from return_inspections i
      where i.status = 'INSPECTED' and i.inspected_at between ${from} and ${to}
        and i.inspected_by_user_id is not null
      group by i.inspected_by_user_id
    `),
  );
  const out = new Map<string, MetricInput[]>();
  for (const r of rows) {
    out.set(r.who, [
      {
        key: "inspection_sla",
        label: "Kiểm đếm hàng hoàn trong hạn",
        value: pct(Number(r.on_time), Number(r.inspected)),
        unit: "PERCENT",
        sample: Number(r.inspected),
        shared: false,
        basis: `return_inspections: kiểm xong trong ${gio} giờ kể từ lúc ghi nhận đã về`,
        denominatorLabel: "lượt kiểm hàng hoàn người này thực hiện trong kỳ",
      },
      {
        key: "inspection_discrepancy",
        label: "Kiện có lệch (hàng hỏng / không bán lại được)",
        value: pct(Number(r.with_issue), Number(r.inspected)),
        unit: "PERCENT",
        sample: Number(r.inspected),
        // KẾT QUẢ CHUNG: hàng hỏng trên đường về không phải lỗi người đếm. Con số này nói về DÒNG
        // HÀNG, không nói về người — nhưng phải đọc được theo người để biết ai đang gặp lô xấu.
        shared: true,
        basis: `return_inspections: ${Number(r.unsellable)} món không bán lại được trong kỳ`,
        denominatorLabel: "món hàng hoàn người này đã kiểm trong kỳ",
      },
    ]);
  }
  return out;
}

/* ═══════════════════ KẾ TOÁN ═══════════════════ */

type FinRow = { user_id: string; actions: number };

async function financeMetrics(from: Date, to: Date): Promise<{ people: Map<string, MetricInput[]>; team: MetricInput[] }> {
  const db = await getDb();
  const [byUser, tong] = await Promise.all([
    db.execute(sql`
      select a.user_id, count(*)::int as actions
      from audit_logs a
      where a.user_id is not null and a.action in ('BANK_CLASSIFY','BANK_LINK')
        and a.created_at between ${from} and ${to}
      group by a.user_id
    `),
    db.execute(sql`
      select count(*)::int as total,
             count(*) filter (where accounting_group <> 'UNCLASSIFIED')::int as classified,
             coalesce(max(extract(epoch from (now() - txn_at)) / 86400) filter (where accounting_group = 'UNCLASSIFIED'), 0) as oldest_days,
             count(*) filter (where accounting_group = 'UNCLASSIFIED')::int as pending
      from bank_transactions
      where txn_at between ${from} and ${to}
    `),
  ]);

  const people = new Map<string, MetricInput[]>();
  for (const r of rowsOf<FinRow>(byUser)) {
    people.set(r.user_id, [
      {
        key: "finance_actions",
        label: "Lượt phân loại / nối chứng từ",
        value: Number(r.actions),
        unit: "COUNT",
        sample: Number(r.actions),
        shared: false,
        // CỐ Ý là số đếm, KHÔNG phải điểm. Nó đứng cạnh độ đầy đủ của cả sổ ở bảng phòng — một
        // mình nó không nói ai làm tốt hơn ai, vì một dòng khó bằng mười dòng dễ.
        basis: "audit_logs: BANK_CLASSIFY + BANK_LINK trong kỳ. Là SỐ LƯỢT, không phải điểm chất lượng",
        denominatorLabel: "lượt phân loại / nối chứng từ ghi trong nhật ký hệ thống",
      },
    ]);
  }

  const t = rowsOf<{ total: number; classified: number; oldest_days: string | number; pending: number }>(tong)[0] ?? {
    total: 0,
    classified: 0,
    oldest_days: 0,
    pending: 0,
  };
  const team: MetricInput[] = [
    {
      key: "reconciliation_completeness",
      label: "Độ đầy đủ đối soát",
      value: pct(Number(t.classified), Number(t.total)),
      unit: "PERCENT",
      sample: Number(t.total),
      shared: false,
      basis: "bank_transactions trong kỳ: đã phân loại ÷ tổng số dòng. Mức SỔ — một dòng có thể do nhiều người chạm nên không quy về cá nhân",
      denominatorLabel: "dòng sao kê trong kỳ (mức SỔ, không quy về cá nhân)",
    },
    {
      key: "unresolved_aging",
      label: "Dòng tiền treo lâu nhất",
      value: Number(t.pending) > 0 ? Math.round(Number(t.oldest_days) * 10) / 10 : null,
      unit: "DAYS",
      sample: Number(t.pending),
      shared: false,
      basis: "Tuổi của dòng tiền CHƯA phân loại cũ nhất trong kỳ. `null` = không còn dòng nào treo",
      denominatorLabel: "dòng sao kê chưa phân loại còn treo",
    },
  ];
  return { people, team };
}

/* ═══════════════════ GOM ═══════════════════ */

export type DeptPerfQuery = { department: DepartmentCode; from: Date; to: Date; people: { id: string; name: string; email: string }[] };

export async function getDeptPerformance(q: DeptPerfQuery): Promise<DeptPerformance> {
  const spec = DEPT_PERF[q.department];
  const missing = spec.metrics.filter((m) => m.availability === "UNAVAILABLE").map((m) => ({ label: m.label, note: m.note }));
  const base: DeptPerformance = { department: q.department, label: DEPARTMENT_LABEL[q.department], team: [], people: [], missing, missingAttribution: spec.notAttributed, from: q.from, to: q.to };

  /*
    GHÉP NGƯỜI: BỐN PHÒNG, MỘT KIỂU KHOÁ.

    Trước migration 0073 mỗi phòng ghép một kiểu — Kinh doanh theo TÊN GÕ TAY, Kho theo EMAIL,
    Giao vận và Kế toán theo KHOÁ. Ba kiểu khoá nghĩa là ba mức "có thể nhầm người" khác nhau
    trong cùng một bảng, và người đọc không có cách nào biết ô nào đáng tin hơn ô nào.

    Nay cả bốn đi bằng `users.id`. Cái giá là dòng CŨ không có khoá thì không vào thẻ điểm —
    nhưng dòng cũ không có khoá vốn đã không quy kết được; trước đây chúng chỉ TRÔNG như quy kết
    được.
  */

  /*
    ═══ XUẤT XỨ GẮN Ở ĐÚNG MỘT CHỖ ═══

    Từ migration 0073 cả bốn phòng ghép bằng `users.id`, nên `linkage` là `USER_ID` ở khắp nơi.
    Trường này KHÔNG bị bỏ đi: nó vẫn là chỗ khai, và nếu ngày mai có một nguồn mới chỉ nối được
    bằng email hay bằng tên thì nó phải khai đúng như vậy ở đây — chứ không im lặng mượn độ tin
    cậy của những nguồn xung quanh.

    `attribution` lấy thẳng từ `DEPT_PERF[phòng].notAttributed`, nên luật "không phạt ai vì thứ họ
    không quyết được" đi theo từng con số ra tới giao diện thay vì nằm yên trong tài liệu.
  */
  const ctx = (linkage: PersonLinkage, owner: "PERSON" | "DEPARTMENT" = "PERSON") => ({
    owner,
    from: q.from,
    to: q.to,
    linkage,
    attribution: spec.notAttributed,
  });
  const gan = (list: MetricInput[], linkage: PersonLinkage, owner: "PERSON" | "DEPARTMENT" = "PERSON") => list.map((m) => hoanThien(m, ctx(linkage, owner)));

  if (q.department === "SALES") {
    const m = await salesMetrics(q.from, q.to);
    base.people = q.people.map((p) => ({ userId: p.id, name: p.name, email: p.email, metrics: gan(m.get(p.id) ?? [], "USER_ID") }));
  } else if (q.department === "LOGISTICS") {
    const m = await logisticsMetrics(q.from, q.to);
    base.people = q.people.map((p) => ({ userId: p.id, name: p.name, email: p.email, metrics: gan(m.get(p.id) ?? [], "USER_ID") }));
  } else if (q.department === "WAREHOUSE") {
    const m = await warehouseMetrics(q.from, q.to);
    base.people = q.people.map((p) => ({ userId: p.id, name: p.name, email: p.email, metrics: gan(m.get(p.id) ?? [], "USER_ID") }));
  } else if (q.department === "FINANCE") {
    const { people, team } = await financeMetrics(q.from, q.to);
    // Chỉ số mức SỔ: chủ thể là PHÒNG, không phải người — nói rõ thay vì để người đọc tự suy.
    base.team = gan(team, "USER_ID", "DEPARTMENT");
    base.people = q.people.map((p) => ({ userId: p.id, name: p.name, email: p.email, metrics: gan(people.get(p.id) ?? [], "USER_ID") }));
  } else {
    // MARKETING · MANAGEMENT · HR: chưa có nguồn nào ở độ mịn NGƯỜI. Bảng `missing` đã nói vì sao,
    // và để trống ở đây trung thực hơn một cột số dựng từ việc giao tay.
    base.people = q.people.map((p) => ({ userId: p.id, name: p.name, email: p.email, metrics: [] }));
  }

  return base;
}
