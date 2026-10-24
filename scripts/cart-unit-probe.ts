/*
  ops `cart-unit-probe` — ĐẾM CÁCH KHÁCH GÕ ĐƠN VỊ «k» / «l» TRONG TIN NHẮN CỦA MỘT TỔ CHỨC, N NGÀY (CHỈ ĐỌC).

  Vì sao có (pha 3 trùng đơn, 24/10/2026 — Tech Lead): vụ HSLC Ngọc «1l nước mắm và 1k chả mực». Bộ đọc giỏ của engine
  (`lib/sales-chatbot/cart-commitment.ts`) chỉ hiểu khối lượng (kg · kí · ký · kilo · lạng · g) và gói / cái — KHÔNG hiểu «k» (= ký) và
  «l / lít / ml», nên câu ấy không ghi «khách đã nói đơn vị», và lượt gộp mua thêm ×2,96 bị trần tăng tổng chặn (đúng luật, chuyển người).
  Dạy bộ đọc «k» có rủi ro thật: «k» cũng là NGHÌN ĐỒNG («ship 30k», «giá 150k») — đọc nhầm thành kg là đúng loại lỗi số lượng P0
  #8037F35A. Nên ĐO TRƯỚC: trong tin khách 30 ngày, «<số>k <món bán theo khối lượng>» và «<số> l/lít/ml <món>» chiếm bao nhiêu so với tin
  đặt hàng, và «<số>k» trong ngữ cảnh tiền nhiều cỡ nào. Ngưỡng làm B do Tech Lead đặt (vd ≥ 1% tin đặt hàng).

  Nguồn: `sales_chat_inbound` — dòng CỦA KHÁCH (`sender_kind IS NULL`, `note` không phải PAGE_REPLY / BOT_SENT), cả hộp thư lẫn bình luận.
  «Món bán theo khối lượng» = sản phẩm có mẫu mã mang quy cách khối lượng (size / detail «1kg», «500g», «lạng»); «món thể tích» = quy
  cách «l / lít / ml». «Tin đặt hàng» = tin mà bộ đọc giỏ HIỆN TẠI (`amountsIn`) thấy ít nhất một số lượng gắn được tên món, HOẶC khớp
  mẫu «k» / «l» ở trên — đúng mẫu số Tech Lead hỏi.

  Kênh [ops:tom-tat] CHỈ số đếm + tỷ lệ — không chữ tin nhắn, không SĐT, không mã hội thoại. Ví dụ (đã che số dài) chỉ ở phần MÃ HOÁ.
  Mở CSDL tổ chức bằng getDbForInspection (không migrate, không tạo), kiểm phiên chỉ đọc trước khi đọc. Không ghi gì.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("cart-unit-probe.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDbForInspection, type Db } from "@/db";
import { findOrganization } from "@/lib/platform/organizations";
import { amountsIn } from "@/lib/sales-chatbot/cart-commitment";
import { foldVi } from "@/lib/sales-chatbot/text";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export const UNIT_PROBE_DEFAULT_DAYS = 30;
export const UNIT_PROBE_MAX_DAYS = 90;
export const UNIT_PROBE_MAX_ROWS = 200_000;
/** Ví dụ mỗi nhóm in vào phần mã hoá — đủ để người đọc kiểm bằng mắt, không thành một bản sao hội thoại. */
export const UNIT_PROBE_EXAMPLES = 8;
const USAGE = `<mã tổ chức> [--days=1..${UNIT_PROBE_MAX_DAYS}]`;

export function parseUnitProbeArgs(argv: readonly string[]): { code: string; days: number } | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--days="))?.slice(7);
  const days = raw === undefined ? UNIT_PROBE_DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > UNIT_PROBE_MAX_DAYS) return { error: `--days phải là số nguyên 1..${UNIT_PROBE_MAX_DAYS}` };
  return { code, days };
}

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

const fold = (s: string) => ` ${foldVi(s).replace(/[^a-z0-9,.]+/g, " ").replace(/\s+/g, " ").trim()} `;
const nameKey = (name: string) => foldVi(name.split("·")[0] ?? name).replace(/[^a-z0-9]+/g, " ").trim();

/** Quy cách một mẫu mã: khối lượng · thể tích · khác. HÀM THUẦN. */
export function measureOf(sizeOrDetail: string): "WEIGHT" | "VOLUME" | null {
  const f = foldVi(sizeOrDetail);
  if (/\d\s*(?:kg|kilo|ki|ky|g|gr|gram|lang)(?![a-z])/.test(f)) return "WEIGHT";
  if (/\d\s*(?:l|lit|ml)(?![a-z])/.test(f)) return "VOLUME";
  return null;
}

/**
 * Ngữ cảnh TIỀN của một «<số>k»: một trong HAI từ NGAY TRƯỚC số là từ tiền («ship 30k», «giá là 150k», «tổng 830k»), hoặc ngay sau là
 * «đ / đồng / vnd». Không xét cả mệnh đề: «chả mực GIÃ tay» gập dấu thành «gia» — xét cả mệnh đề là đếm «1k chả mực giã tay» thành tiền.
 */
const MONEY_BEFORE = new Set(["ship", "phi", "gia", "tien", "tong", "coc", "ck", "giam", "sale", "cod", "bill", "la", "con"]);
const MONEY_AFTER = /^ ?(?:d|dong|vnd)(?: |$)/;

export type UnitMentions = {
  /** «<số>k <món bán theo khối lượng>» — đọc như ký. */
  kWeight: boolean;
  /** «<số> l / lít / ml <món>» (món có trong danh mục). */
  volume: boolean;
  /** «<số>k» trong ngữ cảnh tiền («ship 30k», «giá 150k», «150k đ»). */
  kMoney: boolean;
  /** Bộ đọc giỏ HIỆN TẠI thấy ít nhất một số lượng gắn được tên món. */
  readerSees: boolean;
};

/**
 * Phân loại MỘT tin khách. HÀM THUẦN. `weightNames` / `catalogNames` = tên sản phẩm (gốc, bỏ quy cách). Một tin có thể vừa «k ký»
 * vừa «k tiền» («1k chả mực ship 30k») — đếm cả hai: đó là đúng ca bộ đọc phải tách được nếu làm B.
 */
export function classifyUnitMentions(text: string, weightNames: readonly string[], catalogNames: readonly string[]): UnitMentions {
  const clauses = text.split(/[\n;!?]+|, | và | va | với | voi /i).map(fold);
  const wNames = weightNames.map(nameKey).filter(Boolean);
  const cNames = catalogNames.map(nameKey).filter(Boolean);
  let kWeight = false;
  let volume = false;
  let kMoney = false;
  for (const c of clauses) {
    for (const m of c.matchAll(/ (\d+(?:[.,]\d+)?) ?k(?= )/g)) {
      const at = m.index ?? 0;
      const after = c.slice(at + m[0].length);
      // Món bán theo khối lượng ĐỨNG NGAY SAU ⇒ ký, kể cả khi mệnh đề có từ tiền ở chỗ khác.
      if (wNames.some((n) => after.startsWith(` ${n}`))) {
        kWeight = true;
        continue;
      }
      const before = c.slice(0, at).trim().split(" ").slice(-2);
      if (before.some((w) => MONEY_BEFORE.has(w)) || MONEY_AFTER.test(after)) kMoney = true;
    }
    for (const m of c.matchAll(/ (\d+(?:[.,]\d+)?) ?(?:l|lit|ml)(?= )/g)) {
      const after = c.slice((m.index ?? 0) + m[0].length);
      if (cNames.some((n) => after.startsWith(` ${n}`))) volume = true;
    }
  }
  const readerSees = amountsIn(text, catalogNames).some((a) => Boolean(a.label));
  return { kWeight, volume, kMoney, readerSees };
}

export type UnitProbeSummary = {
  messages: number;
  orderMessages: number;
  kWeight: number;
  volume: number;
  kMoney: number;
  kBoth: number;
  /** Tin có «k ký» / «l» mà bộ đọc HIỆN TẠI không thấy số lượng nào — đúng phần B sẽ cứu. */
  readerMisses: number;
  /** Tỷ lệ trên TIN ĐẶT HÀNG; mẫu số 0 ⇒ null (chưa đo được, không phải 0%). */
  kWeightRate: number | null;
  volumeRate: number | null;
};

export function summarizeUnits(rows: readonly UnitMentions[]): UnitProbeSummary {
  const order = rows.filter((r) => r.readerSees || r.kWeight || r.volume);
  const rate = (n: number) => (order.length ? n / order.length : null);
  const kWeight = rows.filter((r) => r.kWeight).length;
  const volume = rows.filter((r) => r.volume).length;
  return {
    messages: rows.length,
    orderMessages: order.length,
    kWeight,
    volume,
    kMoney: rows.filter((r) => r.kMoney).length,
    kBoth: rows.filter((r) => r.kWeight && r.kMoney).length,
    readerMisses: rows.filter((r) => (r.kWeight || r.volume) && !r.readerSees).length,
    kWeightRate: rate(kWeight),
    volumeRate: rate(volume),
  };
}

const pct = (x: number | null) => (x === null ? "— (không có tin đặt hàng)" : `${(x * 100).toFixed(2).replace(".", ",")}%`);
/** Che dãy số dài (SĐT, mã) trong ví dụ. */
const mask = (s: string) => s.replace(/\d{6,}/g, "######").slice(0, 160);

// ─────────────────────────── ĐỌC CSDL ───────────────────────────

export async function runCartUnitProbe(db: Db, opts: { since: Date; label: string }): Promise<UnitProbeSummary> {
  const products = rowsOf<{ name: string; size: string; detail: string }>(
    await db.execute(sql`select p.name, coalesce(v.size, '') as size, coalesce(v.detail, '') as detail from products p join product_variants v on v.product_id = p.id`),
  );
  const catalog = [...new Set(products.map((p) => p.name).filter(Boolean))];
  const weight = [...new Set(products.filter((p) => measureOf(`${p.size} ${p.detail}`) === "WEIGHT").map((p) => p.name))];
  const msgs = rowsOf<{ text: string }>(
    await db.execute(sql`
      select t.text
        from sales_chat_inbound t
       where t.created_at >= ${opts.since.toISOString()}::timestamptz
         and t.sender_kind is null
         and coalesce(t.note, '') not in ('PAGE_REPLY', 'BOT_SENT')
         and length(t.text) between 2 and 2000
       order by t.created_at desc
       limit ${UNIT_PROBE_MAX_ROWS}
    `),
  );
  const rows = msgs.map((m) => ({ text: m.text, ...classifyUnitMentions(m.text, weight, catalog) }));
  const s = summarizeUnits(rows);
  tomTat(`cart-unit-probe: ${opts.label} · ${s.messages} tin khách · ${s.orderMessages} tin đặt hàng · ${catalog.length} sản phẩm (${weight.length} bán theo khối lượng)`);
  tomTat(`cart-unit-probe: «<số>k <món khối lượng>» ${s.kWeight} tin (${pct(s.kWeightRate)} tin đặt hàng) · «<số> l/lít/ml <món>» ${s.volume} tin (${pct(s.volumeRate)})`);
  tomTat(`cart-unit-probe: «<số>k» ngữ cảnh TIỀN ${s.kMoney} tin · cùng tin có cả «k ký» lẫn «k tiền» ${s.kBoth} · bộ đọc hiện tại bỏ sót (có k/l mà không thấy số lượng) ${s.readerMisses}`);
  if (msgs.length > UNIT_PROBE_MAX_ROWS - 1) tomTat(`cart-unit-probe: CHẠM TRẦN ${UNIT_PROBE_MAX_ROWS} tin — số đếm là của ${UNIT_PROBE_MAX_ROWS} tin mới nhất`);
  // Ví dụ — CHỈ ở phần mã hoá (console.log thường), đã che số dài.
  for (const [label, pick] of [["k ký", (r: (typeof rows)[number]) => r.kWeight], ["l/lít", (r: (typeof rows)[number]) => r.volume], ["k tiền", (r: (typeof rows)[number]) => r.kMoney && !r.kWeight]] as const) {
    console.log(`— Ví dụ «${label}»:`);
    for (const r of rows.filter(pick).slice(0, UNIT_PROBE_EXAMPLES)) console.log(`  · ${mask(r.text)}`);
  }
  return s;
}

async function thoat(code: number): Promise<never> {
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  process.exit(code);
}

async function main() {
  const args = parseUnitProbeArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`cart-unit-probe: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    return thoat(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`cart-unit-probe: DỪNG · không có tổ chức «${args.code}»`);
    return thoat(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("cart-unit-probe: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    return thoat(1);
  }
  const now = new Date();
  await runCartUnitProbe(db, { since: new Date(now.getTime() - args.days * 86_400_000), label: `${args.days} ngày tới ${now.toISOString()}` });
  return thoat(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch(async (e) => {
    console.error("cart-unit-probe lỗi:", e instanceof Error ? e.message : e);
    tomTat("cart-unit-probe: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    await thoat(1);
  });
}
