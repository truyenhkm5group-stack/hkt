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
  `SLOW_MOVING_KEY`, `ORDER_OUTCOME_FAST`, `PRIMARY_ATTEMPT`, `chayKhongJit` — bài kiểm chặn tên mới.

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
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/** Kênh tóm tắt cho ra log tối đa 60 dòng, 300 ký tự mỗi dòng. */
export const COMPARE_MAX_LINES = 60;
export const COMPARE_MAX_CHARS = 300;

export const RISKS: readonly StockRisk[] = ["DEAD", "EXCESS", "SLOW", "HEALTHY"];
const NHAN: Record<StockRisk, string> = { DEAD: "Hàng chết", EXCESS: "Vốn nằm chết", SLOW: "Bán chậm", HEALTHY: "Bình thường" };

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

const tron1 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/**
 * Phép xếp lớp — chép từ vòng lặp `slowMovingUncached` tại f84be840, cộng đúng MỘT nhánh mà định nghĩa
 * mới sinh ra (có gửi đi mà hàng hoàn về bằng hàng đi ⇒ tồn không vơi ⇒ Vốn nằm chết). Vế cũ không
 * bao giờ chạm nhánh ấy (tốc độ ròng > 0 luôn cho số ngày hữu hạn). Bài kiểm so hàm này với
 * `classifyStockRisk` của mã nguồn mới trên cả lưới đầu vào.
 */
export function xepLop(velocity: number, cover: number | null, daysSinceLastSale: number | null, R: SlowMovingRules): StockRisk {
  if (velocity <= 0 && (daysSinceLastSale === null || daysSinceLastSale >= R.deadDays)) return "DEAD";
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
  const [win, last] = await Promise.all([chayKhongJit(db, (tx) => oldWindowSales(tx, windowDays)), chayKhongJit(db, (tx) => lastSold(tx))]);
  const winBy = new Map(win.map((r) => [r.variantId, r]));
  const lastBy = new Map(last.map((r) => [r.variantId, r.lastSoldAt]));

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
    variants.push({
      variantId: r.variantId,
      oldVelocity: v.velocity,
      newVelocity: r.velocity,
      oldCover,
      newCover,
      oldRisk: xepLop(v.velocity, oldCover, daysSinceLastSale, R),
      newRisk: xepLop(r.velocity, newCover, daysSinceLastSale, R),
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
