/*
  ops `velocity-compare` — HAI ĐỊNH NGHĨA TỐC ĐỘ BÁN, ĐO TRƯỚC KHI GỘP (AGENTS.md mục 6.5).

  Chủ shop giao Tech Lead chốt 27/09/2026: bảng Hàng chậm / vốn nằm chết thôi tự tính tốc độ RÒNG và
  đọc số ngày còn đủ hàng của KẾ HOẠCH SX. Đổi định nghĩa là đổi con số báo cáo, nên phải đo trên dữ
  liệu thật TRƯỚC khi deploy: bao nhiêu mẫu mã ở mỗi lớp (Hàng chết · Vốn nằm chết · Bán chậm · Bình
  thường) theo định nghĩa CŨ và MỚI, và bao nhiêu mẫu mã đổi lớp theo từng cặp cũ → mới.

  CHỈ ĐẾM. Không in tên, SKU, mã mẫu mã, mã hàng, tiền. Dòng ra log công khai qua kênh `[ops:tom-tat] `;
  nhánh ops vẫn bọc `ma_hoa_ket_qua` (cùng khuôn `company-os-summary`).

  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` đặt trước lần mở kết nối đầu tiên, `main` hỏi lại rồi dừng
  nếu không phải).

  ─── VÌ SAO SCRIPT TỰ MANG ĐỊNH NGHĨA CŨ ───

  ops lấy script từ `main` nhưng `lib/` từ ẢNH ĐANG CHẠY. Sau khi bản gộp được deploy, `getSlowMoving`
  trên ảnh đã là định nghĩa MỚI — gọi nó làm vế "cũ" thì phép so tự thành 0 thay đổi mà không báo gì.
  Nên vế CŨ là BẢN SAO DUY NHẤT ĐƯỢC PHÉP của câu bán ròng trong cửa sổ + ngày mạnh nhất + phép xếp
  lớp, CHÉP NGUYÊN từ `lib/queries/slow-moving.ts` tại `main` f84be840 (`windowSalesSubquery`,
  `lastSoldSubquery`, vòng xếp loại trong `slowMovingUncached`) — chỉ để ĐO, không màn hình nào đọc nó.

  Vế MỚI KHÔNG chép SQL của Kế hoạch SX mà gọi thẳng `getReplenishmentPlan()` của ảnh đang chạy: đó
  CHÍNH là định nghĩa thắng (tồn khả dụng, tốc độ gửi đi, thang bậc GTC theo mã, độ trễ hoàn đo được,
  tỷ lệ nhập lại được) và nó không đổi trong bản gộp — chép lại cả thang bậc GTC bằng SQL là dựng một
  bản sao thứ hai của đúng thứ đang được gộp về một. `tests/velocity-unify.test.ts` khẳng định vế MỚI
  của script trùng từng mẫu mã với `getSlowMoving()` của mã nguồn mới trên PGlite.

  CHỈ import tệp `lib/` và tên ĐÃ CÓ trên ảnh đang chạy (không một hàm nào của bản gộp):
  `computeVelocity`, `getReplenishmentPlan`, `loadPlanningAssumptions`, `resolveSlowMovingRules`,
  `SLOW_MOVING_KEY`, `ORDER_OUTCOME_FAST`, `PRIMARY_ATTEMPT`, `chayKhongJit`, `RETURNED_OUTCOMES_SQL`
  (có từ 23/09/2026) — bài kiểm chặn tên mới.

  ─── LỚP "HOÀN GẦN HẾT / GỬI ĐI KHÔNG GIAO ĐƯỢC" (`RETURNED_OUT`, chủ shop duyệt 27/09/2026) ───

  Lượt đo đầu (run 36306328239, 28 mẫu mã) cho 1 mẫu đi DEAD → HEALTHY: gửi đi đều nhưng hoàn gần hết,
  tốc độ gửi đi dương nên số ngày phủ ngắn ⇒ "Bình thường". Bản vá thêm lớp `RETURNED_OUT` vào
  `classifyStockRisk` — nhưng hàm ấy CHƯA có trên ảnh đang chạy, nên vế MỚI của script tự xếp lớp này
  bằng `xepLop` (bản sao thuần của `classifyStockRisk`; bài kiểm so hai hàm trên cả lưới) từ: dòng Kế hoạch
  SX của ảnh + câu SQL CHỈ ĐỌC `deadWindowFacts` dưới đây (món gửi đi / món hoàn của đơn lên trong
  `deadDays` ngày — cùng căn cứ luật hàng chết cũ: ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT). Vế CŨ xếp bằng
  `xepLopCu` — nguyên văn f84be840, không có lớp mới.

  arg: không có.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("velocity-compare.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema, type Db } from "@/db";
import { computeVelocity } from "@/lib/constants/planning";
import { SLOW_MOVING_KEY, resolveSlowMovingRules, type SlowMovingRules, type StockRisk } from "@/lib/constants/slow-moving";
import { getReplenishmentPlan, loadPlanningAssumptions } from "@/lib/queries/planning";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/** Kênh tóm tắt cho ra log tối đa 60 dòng, 300 ký tự mỗi dòng. */
export const COMPARE_MAX_LINES = 60;
export const COMPARE_MAX_CHARS = 300;

export const RISKS: readonly StockRisk[] = ["DEAD", "RETURNED_OUT", "EXCESS", "SLOW", "HEALTHY"];
const NHAN: Record<StockRisk, string> = { DEAD: "Hàng chết", RETURNED_OUT: "Hoàn gần hết", EXCESS: "Vốn nằm chết", SLOW: "Bán chậm", HEALTHY: "Bình thường" };

const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;

// ═══════════════════════════ KIỂU ═══════════════════════════

export type VariantCompare = {
  variantId: string;
  oldVelocity: number;
  newVelocity: number;
  oldCover: number | null;
  newCover: number | null;
  oldRisk: StockRisk;
  newRisk: StockRisk;
  /** Món gửi đi / món hoàn của đơn lên trong cửa sổ hàng chết — căn cứ lớp `RETURNED_OUT` (chỉ vế MỚI). */
  shippedInDeadWindow: number;
  returnedInDeadWindow: number;
};

export type VelocityCompare = {
  at: Date;
  windowDays: number;
  rules: SlowMovingRules;
  /** Ô ngưỡng đang lấy từ ghi đè; `ignored` = bộ ghi đè bị bỏ nguyên bộ (kèm lý do). */
  overridden: string[];
  ignored: string | null;
  /** Số Kế hoạch SX đã dùng — để người đọc hiểu vì sao số ngày phủ MỚI khác. */
  vtpReturnLagDays: number | null;
  restockDays: number;
  returnRecoveryRate: number;
  variants: VariantCompare[];
};

// ═══════════════════════════ VẾ CŨ — BẢN SAO ĐO LƯỜNG (main f84be840) ═══════════════════════════

/** Chép nguyên `windowSalesSubquery` của `lib/queries/slow-moving.ts` tại f84be840: bán RÒNG + ngày mạnh nhất. */
function oldWindowSales(db: Db, windowDays: number) {
  const daily = db
    .select({
      variantId: oi.variantId,
      day: sql<string>`((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date)`.as("sale_day"),
      qty: sql<number>`coalesce(sum(${oi.quantity}), 0)`.as("day_qty"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(sql`${o.insertedAt} >= now() - (${windowDays} || ' days')::interval and ${oi.isBonus} = false and ${ORDER_OUTCOME_FAST} not in ('CANCELLED','RETURNED','RETURNED_BY_RULE')`)
    .groupBy(oi.variantId, sql`((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date)`)
    .as("sm_daily");
  return db
    .select({
      variantId: daily.variantId,
      sold: sql<number>`coalesce(sum(${daily.qty}), 0)`.as("sm_sold"),
      peak: sql<number>`coalesce(max(${daily.qty}), 0)`.as("sm_peak"),
    })
    .from(daily)
    .groupBy(daily.variantId);
}

/** Chép nguyên `lastSoldSubquery` tại f84be840 — lần cuối THẬT SỰ giao được hàng (cả hai vế dùng chung). */
function lastSold(db: Db) {
  return db
    .select({ variantId: oi.variantId, lastSoldAt: sql<string | null>`max(${o.insertedAt})`.as("sm_last_sold") })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(sql`${ORDER_OUTCOME_FAST} = 'DELIVERED'`)
    .groupBy(oi.variantId);
}

/**
 * Món gửi đi (đơn KHÔNG HUỶ — căn cứ "gộp" của tốc độ gửi đi) và món đã HOÀN của đơn lên trong
 * `deadDays` ngày. CHỈ ĐỌC. Mirror của `deadWindowFactsSubquery` (lib/queries/slow-moving.ts, chưa
 * deploy) viết bằng các tên đã có trên ảnh; bài kiểm so số của hai câu trên PGlite.
 */
function deadWindowFacts(db: Db, deadDays: number) {
  return db
    .select({
      variantId: oi.variantId,
      shipped: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${ORDER_OUTCOME_FAST} <> 'CANCELLED'), 0)`.as("vc_shipped_dead"),
      returned: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(RETURNED_OUTCOMES_SQL)})), 0)`.as("vc_returned_dead"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(sql`${o.insertedAt} >= now() - (${deadDays} || ' days')::interval`)
    .groupBy(oi.variantId);
}

const tron1 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/** Phép xếp lớp CŨ — nguyên văn vòng lặp `slowMovingUncached` tại f84be840. Chỉ vế CŨ dùng. */
export function xepLopCu(velocity: number, cover: number | null, daysSinceLastSale: number | null, R: SlowMovingRules): StockRisk {
  if (velocity <= 0 && (daysSinceLastSale === null || daysSinceLastSale >= R.deadDays)) return "DEAD";
  if (cover !== null && cover > R.excessCoverDays) return "EXCESS";
  if (cover !== null && cover > R.slowCoverDays) return "SLOW";
  return "HEALTHY";
}

/**
 * Phép xếp lớp MỚI — bản sao thuần của `classifyStockRisk` (lib/constants/slow-moving.ts), vì hàm ấy
 * chưa có trên ảnh đang chạy. Bài kiểm so hai hàm trên cả lưới đầu vào, kể cả hai sự kiện cửa sổ.
 */
export function xepLop(
  velocity: number,
  cover: number | null,
  daysSinceLastSale: number | null,
  R: SlowMovingRules,
  shippedInDeadWindow: number,
  returnedInDeadWindow: number,
): StockRisk {
  const noDelivery = daysSinceLastSale === null || daysSinceLastSale >= R.deadDays;
  if (noDelivery && shippedInDeadWindow > 0 && returnedInDeadWindow > 0) return "RETURNED_OUT";
  if (velocity <= 0 && noDelivery) return "DEAD";
  if (velocity > 0 && cover === null) return "EXCESS";
  if (cover !== null && cover > R.excessCoverDays) return "EXCESS";
  if (cover !== null && cover > R.slowCoverDays) return "SLOW";
  return "HEALTHY";
}

// ═══════════════════════════ ĐỌC ═══════════════════════════

async function loadRules(db: Db) {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SLOW_MOVING_KEY));
  if (!row) return resolveSlowMovingRules(null);
  try {
    return resolveSlowMovingRules(JSON.parse(row.value));
  } catch {
    return { ...resolveSlowMovingRules(null), ignored: "Ghi đè không đọc được (không phải JSON)" };
  }
}

export async function collectVelocityCompare(db: Db): Promise<VelocityCompare> {
  const at = new Date();
  const [resolved, a, plan] = await Promise.all([loadRules(db), loadPlanningAssumptions(), getReplenishmentPlan()]);
  const R = resolved.rules;
  const windowDays = Math.max(1, a.velocityWindowDays);
  const [win, last, dead] = await Promise.all([
    chayKhongJit(db, (tx) => oldWindowSales(tx, windowDays)),
    chayKhongJit(db, (tx) => lastSold(tx)),
    chayKhongJit(db, (tx) => deadWindowFacts(tx, R.deadDays)),
  ]);
  const winBy = new Map(win.map((r) => [r.variantId, r]));
  const lastBy = new Map(last.map((r) => [r.variantId, r.lastSoldAt]));
  const deadBy = new Map(dead.map((r) => [r.variantId, r]));

  const variants: VariantCompare[] = [];
  for (const r of plan.rows) {
    // TẬP DÒNG của bảng Hàng chậm (cả cũ lẫn mới): biết tồn và còn hàng.
    if (!r.stockKnown || !(r.available > 0)) continue;
    const w = winBy.get(r.variantId);
    const lastRaw = lastBy.get(r.variantId);
    const daysSinceLastSale = lastRaw ? Math.floor((at.getTime() - new Date(lastRaw).getTime()) / 86_400_000) : null;

    const v = computeVelocity(Number(w?.sold ?? 0), windowDays, Number(w?.peak ?? 0));
    const oldCover = v.velocity > 0 ? tron1(r.available / v.velocity) : null;
    const newCover = tron1(r.daysOfCover);
    const d = deadBy.get(r.variantId);
    const shippedInDeadWindow = Number(d?.shipped ?? 0);
    const returnedInDeadWindow = Number(d?.returned ?? 0);
    variants.push({
      variantId: r.variantId,
      oldVelocity: v.velocity,
      newVelocity: r.velocity,
      oldCover,
      newCover,
      oldRisk: xepLopCu(v.velocity, oldCover, daysSinceLastSale, R),
      newRisk: xepLop(r.velocity, newCover, daysSinceLastSale, R, shippedInDeadWindow, returnedInDeadWindow),
      shippedInDeadWindow,
      returnedInDeadWindow,
    });
  }
  return {
    at,
    windowDays,
    rules: R,
    overridden: resolved.overridden,
    ignored: resolved.ignored,
    vtpReturnLagDays: plan.used.vtpReturnLagDays,
    restockDays: plan.used.restockDays,
    returnRecoveryRate: plan.used.returnRecoveryRate,
    variants,
  };
}

// ═══════════════════════════ IN (thuần) ═══════════════════════════

const dem = (n: number) => n.toLocaleString("vi-VN");
const EPS = 1e-9;

/** Mọi dòng tóm tắt. Hàm THUẦN — bài kiểm gọi thẳng. Chỉ SỐ ĐẾM: không một mã mẫu mã nào ra khỏi hàm này. */
export function velocityCompareLines(c: VelocityCompare): string[] {
  const out: string[] = [];
  const R = c.rules;
  const nguonNguong = c.ignored ? `ghi đè bị BỎ (${c.ignored.slice(0, 60)}) ⇒ mặc định` : c.overridden.length ? `ghi đè: ${c.overridden.join(", ")}` : "mặc định";
  out.push(
    `VELOCITY-COMPARE · đo lúc ${c.at.toISOString().slice(0, 16).replace("T", " ")} UTC · mọi con số là SỐ ĐẾM mẫu mã (không tên, không mã, không tiền) · cửa sổ tốc độ ${dem(c.windowDays)} ngày`,
  );
  out.push(`NGƯỠNG (không đổi, ${nguonNguong}): hàng chết ≥ ${dem(R.deadDays)} ngày không giao được · bán chậm > ${dem(R.slowCoverDays)} ngày · vốn nằm chết > ${dem(R.excessCoverDays)} ngày`);
  const n = c.variants.length;
  out.push(`TẬP DÒNG: ${dem(n)} mẫu mã biết tồn và còn hàng — CÙNG một tập cho vế CŨ và vế MỚI`);
  const theoLop = (f: (v: VariantCompare) => StockRisk) => RISKS.map((k) => `${NHAN[k]} ${dem(c.variants.filter((v) => f(v) === k).length)}`).join(" · ");
  out.push(`CŨ (bán RÒNG: bỏ đơn huỷ/hoàn + hàng tặng; khả dụng ÷ tốc độ): ${theoLop((v) => v.oldRisk)}`);
  out.push(`MỚI (Kế hoạch SX: gửi đi = mọi đơn không huỷ kể cả hoàn + tặng; hàng hoàn trừ sau độ trễ hoàn): ${theoLop((v) => v.newRisk)}`);
  const lag = c.vtpReturnLagDays === null ? "— (chưa đủ mẫu ⇒ không trừ hàng hoàn)" : `${c.vtpReturnLagDays.toLocaleString("vi-VN")} ngày`;
  out.push(`KẾ HOẠCH SX dùng: độ trễ ĐVVC trả hàng hoàn ${lag} + kho tái nhập ${dem(c.restockDays)} ngày · tỷ lệ hàng hoàn nhập lại được ${Math.round(c.returnRecoveryRate * 1000) / 10}%`);

  const doi = c.variants.filter((v) => v.oldRisk !== v.newRisk);
  const cap = new Map<string, number>();
  for (const v of doi) cap.set(`${v.oldRisk}→${v.newRisk}`, (cap.get(`${v.oldRisk}→${v.newRisk}`) ?? 0) + 1);
  const capParts = [...cap.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k, m]) => `${k} ${dem(m)}`);
  out.push(`ĐỔI LỚP: ${dem(doi.length)}/${dem(n)} mẫu mã${capParts.length ? ` — ${capParts.join(" · ")}` : ""}`);
  const hoan = c.variants.filter((v) => v.newRisk === "RETURNED_OUT");
  const tuLop = RISKS.map((k) => [k, hoan.filter((v) => v.oldRisk === k).length] as const).filter(([, m]) => m > 0).map(([k, m]) => `${k} ${dem(m)}`);
  out.push(
    `HOÀN GẦN HẾT (mới — gửi đi trong ${dem(R.deadDays)} ngày, có món hoàn, 0 món giao thành công): ${dem(hoan.length)} mẫu mã${tuLop.length ? ` — lớp CŨ của chúng: ${tuLop.join(" · ")}` : ""} · CŨ Hàng chết → MỚI Bình thường: ${dem(c.variants.filter((v) => v.oldRisk === "DEAD" && v.newRisk === "HEALTHY").length)}`,
  );
  const cungTocDo = doi.filter((v) => Math.abs(v.oldVelocity - v.newVelocity) < EPS).length;
  out.push(`  trong đó đổi lớp mà tốc độ gửi đi = tốc độ ròng cũ: ${dem(cungTocDo)} (chỉ do trừ hàng hoàn sau độ trễ hoàn)`);

  const nhanh = c.variants.filter((v) => v.newVelocity > v.oldVelocity + EPS).length;
  const bang = c.variants.filter((v) => Math.abs(v.newVelocity - v.oldVelocity) < EPS).length;
  out.push(`TỐC ĐỘ: mới > cũ ${dem(nhanh)} · bằng ${dem(bang)} · mới < cũ ${dem(n - nhanh - bang)}`);

  const ca = c.variants.filter((v) => v.oldCover !== null && v.newCover !== null);
  const ngan = ca.filter((v) => (v.newCover as number) < (v.oldCover as number)).length;
  const dai = ca.filter((v) => (v.newCover as number) > (v.oldCover as number)).length;
  const chiCu = c.variants.filter((v) => v.oldCover !== null && v.newCover === null).length;
  const chiMoi = c.variants.filter((v) => v.oldCover === null && v.newCover !== null).length;
  const khong = c.variants.filter((v) => v.oldCover === null && v.newCover === null).length;
  out.push(`SỐ NGÀY PHỦ: cả hai có số ${dem(ca.length)} (mới ngắn hơn ${dem(ngan)} · dài hơn ${dem(dai)} · bằng ${dem(ca.length - ngan - dai)}) · chỉ CŨ có số ${dem(chiCu)} · chỉ MỚI có số ${dem(chiMoi)} · cả hai — ${dem(khong)}`);
  return out.map((l) => l.slice(0, COMPARE_MAX_CHARS)).slice(0, COMPARE_MAX_LINES);
}

async function main() {
  const db = await getDb();
  const [ro] = rowsOf<{ default_transaction_read_only?: string }>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    console.error("velocity-compare: phiên CSDL không ở chế độ chỉ đọc — KHÔNG chạy.");
    process.exit(1);
  }
  for (const line of velocityCompareLines(await collectVelocityCompare(db))) tomTat(line);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("velocity-compare lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
