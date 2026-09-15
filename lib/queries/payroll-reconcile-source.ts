/**
 * ═══════════ NGUỒN SỐ VÀ CỔNG AN TOÀN CHO LƯỢT ĐỐI CHIẾU ═══════════
 *
 * Ba việc, tất cả đều CHỈ ĐỌC:
 *
 *  1. `assertReadOnlySession` — chứng minh phiên kết nối thật sự bị ép chỉ đọc, và DỪNG nếu không.
 *  2. `periodActivity` / `findPeriodWithActivity` — kỳ nào có hoạt động thật để đối chiếu.
 *  3. `payrollTableSnapshot` — ảnh đếm các bảng lương, chụp trước và sau để chứng minh không ghi.
 */
import { and, gte, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { getSettingJson } from "@/lib/settings";
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";
import type { PeriodActivity } from "@/lib/payroll/reconcile-gate";
import type { Period } from "@/lib/search-params";

/**
 * ═══ CHỨNG MINH PHIÊN LÀ CHỈ ĐỌC — VÀ DỪNG NẾU KHÔNG ═══
 *
 * FAIL CLOSED. Không có nhánh nào ở đây "cảnh báo rồi chạy tiếp".
 *
 * Vì sao phải hỏi CSDL thay vì tin biến môi trường: `ERP_READ_ONLY` chỉ nói rằng tiến trình ĐỊNH
 * chạy ở chế độ chỉ đọc. Thứ quyết định là máy chủ có thật sự từ chối lệnh ghi hay không — và chỉ
 * có máy chủ trả lời được câu đó. Một biến môi trường đặt đúng nhưng driver bỏ qua tham số thì vẫn
 * là một phiên GHI ĐƯỢC, và mọi lời bảo đảm trong tài liệu đều sai.
 *
 * `transaction_read_only` là giá trị ĐANG CÓ HIỆU LỰC cho giao dịch kế tiếp — đúng thứ cần hỏi.
 * Kiểm cả `default_transaction_read_only` để phân biệt "phiên này tình cờ đang chỉ đọc" với "kết
 * nối được cấu hình chỉ đọc".
 *
 * KHÔNG thử ghi để kiểm. Một phép thử ghi trên production là một lệnh ghi — nếu cổng hỏng thì
 * chính phép thử ấy làm bẩn dữ liệu, và câu trả lời cho "có ghi gì không" thành "có, một lần".
 */
export async function assertReadOnlySession(): Promise<{ transactionReadOnly: string; defaultReadOnly: string }> {
  const db = await getDb();
  const rows = (await db.execute(sql`select current_setting('transaction_read_only') as tro, current_setting('default_transaction_read_only') as dro`)) as unknown as {
    rows?: { tro: string; dro: string }[];
  };
  const r = (Array.isArray(rows) ? (rows as { tro: string; dro: string }[])[0] : rows.rows?.[0]) ?? null;
  if (!r) throw new Error("Không đọc được trạng thái chỉ đọc của phiên — DỪNG. Không chạy đối chiếu trên một phiên không xác minh được.");
  if (r.tro !== "on") {
    throw new Error(
      `Phiên kết nối KHÔNG ở chế độ chỉ đọc (transaction_read_only = "${r.tro}"). DỪNG.\n` +
        "Đối chiếu chạy trên dữ liệu thật thì phải để CHÍNH POSTGRES từ chối lệnh ghi, không phải để mã nguồn tự hứa.\n" +
        "Bật bằng ERP_READ_ONLY=1 (đẩy `-c default_transaction_read_only=on` xuống gói khởi tạo kết nối).",
    );
  }
  return { transactionReadOnly: r.tro, defaultReadOnly: r.dro };
}

/** Các bảng có thể bị lượt đối chiếu làm bẩn nếu ở đâu đó còn một lệnh ghi. */
export const PAYROLL_STATE_TABLES = [
  "salary_policies",
  "salary_policy_versions",
  "salary_policy_components",
  "employment_assignments",
  "employee_policy_assignments",
  "payroll_inputs",
  "payroll_adjustments",
  "payroll_periods",
  "marketer_profit_carryover",
  "audit_logs",
] as const;

/**
 * ẢNH ĐẾM CÁC BẢNG LƯƠNG — chụp TRƯỚC và SAU lượt đối chiếu.
 *
 * Đếm là đủ cho mục đích ở đây: lượt đối chiếu chỉ có thể làm bẩn bằng cách THÊM dòng (nó không
 * biết id của dòng nào để sửa). Băm toàn bộ nội dung sẽ chậm hơn nhiều mà không trả lời thêm câu
 * nào — trừ `audit_logs`, nơi một lượt ghi nhật ký ngoài ý muốn cũng là một dòng THÊM.
 *
 * Bảng chưa tồn tại (migration chưa áp) trả `null`, KHÔNG trả 0: "chưa có bảng" khác hẳn "bảng
 * rỗng", và so 0 với 0 giữa hai lượt chụp sẽ giấu mất việc bảng vừa được tạo ra giữa chừng.
 */
export async function payrollTableSnapshot(): Promise<Record<string, number | null>> {
  const db = await getDb();
  const out: Record<string, number | null> = {};
  for (const bang of PAYROLL_STATE_TABLES) {
    const co = (await db.execute(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = ${bang}`,
    )) as unknown as { rows?: { n: number }[] };
    const coRow = (Array.isArray(co) ? (co as { n: number }[])[0] : co.rows?.[0]) ?? { n: 0 };
    if (!Number(coRow.n)) {
      out[bang] = null;
      continue;
    }
    const r = (await db.execute(sql`select count(*)::int as n from ${sql.identifier(bang)}`)) as unknown as { rows?: { n: number }[] };
    const row = (Array.isArray(r) ? (r as { n: number }[])[0] : r.rows?.[0]) ?? { n: 0 };
    out[bang] = Number(row.n);
  }
  return out;
}

/** So hai ảnh đếm. Trả về danh sách khác biệt — rỗng nghĩa là KHÔNG có gì bị ghi. */
export function diffSnapshots(truoc: Record<string, number | null>, sau: Record<string, number | null>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(truoc)) {
    if (truoc[k] !== sau[k]) out.push(`${k}: ${truoc[k] ?? "(chưa có bảng)"} → ${sau[k] ?? "(chưa có bảng)"}`);
  }
  return out;
}

/**
 * ĐO HOẠT ĐỘNG NGUỒN CỦA MỘT KỲ.
 *
 * Đọc thẳng các bảng nguồn, KHÔNG đi qua máy báo cáo: câu hỏi ở đây là "kỳ này có gì để tính
 * không", và trả lời nó bằng chính máy đang cần kiểm chứng thì vòng lại đúng thứ mình muốn kiểm.
 */
export async function periodActivity(period: Period): Promise<PeriodActivity> {
  const db = await getDb();
  const from = period.from;
  const to = period.to;
  const rong: PeriodActivity = { orders: 0, deliveredOrders: 0, revenue: 0, adSpend: 0, expenses: 0, shipments: 0, fixedSalaryDeclared: 0 };
  if (!from || !to) return rong;

  const o = schema.orders;
  const s = schema.shipments;
  const e = schema.expenses;

  const [donRows, vanDonRows, chiRows, nhanSu] = await Promise.all([
    db
      .select({
        tong: sql<number>`count(*)::int`,
        giao: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')::int`,
        doanhThu: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED'), 0)::bigint`,
      })
      .from(o)
      /*
        `PRIMARY_ATTEMPT` KHÔNG PHẢI MỘT BỘ LỌC TUỲ CHỌN.

        Một đơn gửi lại nhiều lần có NHIỀU dòng `shipments`. Nối trần thì đơn ấy được đếm nhiều
        lần và doanh thu của nó được CỘNG nhiều lần — phép đo "kỳ này có hoạt động không" sẽ thổi
        phồng đúng những kỳ nhiều đơn hoàn nhất. `tests/shipment-join-grain.test.ts` bắt được nhánh
        này ngay khi vừa viết ra.
      */
      .leftJoin(s, sql`${s.orderId} = ${o.id} and ${PRIMARY_ATTEMPT}`)
      .where(and(gte(o.insertedAt, from), lt(o.insertedAt, new Date(to.getTime() + 1)))),
    db.select({ n: sql<number>`count(*)::int` }).from(s).where(and(gte(s.createdAt, from), lt(s.createdAt, new Date(to.getTime() + 1)))),
    db
      .select({
        n: sql<number>`count(*)::int`,
        qc: sql<number>`coalesce(sum(${e.amount}) filter (where ${e.category} = 'ADS'), 0)::bigint`,
      })
      .from(e)
      .where(and(gte(e.occurredAt, from), lt(e.occurredAt, new Date(to.getTime() + 1)))),
    getSettingJson<{ list?: Employee[] }>(PAYROLL_EMPLOYEES_KEY, { list: [] }),
  ]);

  const luongCung = (nhanSu.list ?? []).filter((x) => x.active).reduce((t, x) => t + Math.max(0, Math.round(Number(x.fixed) || 0)), 0);

  return {
    orders: Number(donRows[0]?.tong ?? 0),
    deliveredOrders: Number(donRows[0]?.giao ?? 0),
    revenue: Number(donRows[0]?.doanhThu ?? 0),
    adSpend: Number(chiRows[0]?.qc ?? 0),
    expenses: Number(chiRows[0]?.n ?? 0),
    shipments: Number(vanDonRows[0]?.n ?? 0),
    fixedSalaryDeclared: luongCung,
  };
}

/** Một tháng lịch Việt Nam, lùi `back` tháng so với `moc`. */
export function monthPeriod(moc: Date, back: number): Period {
  const vn = new Date(moc.getTime() + 7 * 3_600_000);
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth() - back;
  const dau = new Date(Date.UTC(y, m, 1));
  const cuoi = new Date(Date.UTC(y, m + 1, 0));
  const fromKey = `${dau.getUTCFullYear()}-${String(dau.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const toKey = `${cuoi.getUTCFullYear()}-${String(cuoi.getUTCMonth() + 1).padStart(2, "0")}-${String(cuoi.getUTCDate()).padStart(2, "0")}`;
  return { key: "custom", from: vnStartOfDay(fromKey), to: vnEndOfDay(toKey), fromKey, toKey, label: `${fromKey} → ${toKey}` };
}

export type PeriodPick = { period: Period; activity: PeriodActivity; tried: { label: string; hasActivity: boolean }[] };

/**
 * ═══ TÌM MỘT KỲ CÓ DỮ LIỆU THẬT ═══
 *
 * Thử kỳ được chỉ định trước. Không có hoạt động nào thì lùi dần từng tháng — và GHI LẠI từng kỳ
 * đã thử, vì "đã thử 6 tháng đều rỗng" là một kết luận khác hẳn "chọn đại tháng đầu tiên".
 *
 * KHÔNG ghim cứng một tháng trong mã. Tháng nào có dữ liệu là chuyện của production, không phải
 * một hằng số — ghim cứng là để bài kiểm xanh trên một tháng đã chết từ lâu.
 */
export async function findPeriodWithActivity(uuTien: Period | null, luiToiDa = 6, moc = new Date()): Promise<PeriodPick> {
  const daThu: { label: string; hasActivity: boolean }[] = [];
  const { hasActivity } = await import("@/lib/payroll/reconcile-gate");

  if (uuTien) {
    const a = await periodActivity(uuTien);
    daThu.push({ label: uuTien.label, hasActivity: hasActivity(a) });
    if (hasActivity(a)) return { period: uuTien, activity: a, tried: daThu };
  }
  for (let back = 1; back <= luiToiDa; back += 1) {
    const p = monthPeriod(moc, back);
    if (uuTien && p.fromKey === uuTien.fromKey && p.toKey === uuTien.toKey) continue;
    const a = await periodActivity(p);
    daThu.push({ label: p.label, hasActivity: hasActivity(a) });
    if (hasActivity(a)) return { period: p, activity: a, tried: daThu };
  }
  const cuoi = uuTien ?? monthPeriod(moc, 1);
  return { period: cuoi, activity: await periodActivity(cuoi), tried: daThu };
}
