/**
 * ═══ OPS `wholesale-b2b-probe` (chương trình AI B2B Sales Agent của HSLC, P1-D 27/10/2026) ═══
 *
 * Khoá: (1) arg `[--org=<mã>]` mặc định hslc-hmt-shop, tham số lạ ⇒ lỗi; (2) dòng tóm tắt ≤ 280 BYTE (ops cắt theo byte) qua bộ dồn dùng
 * chung lib/ops/summary-lines; (3) bảng / cột chưa có ⇒ «chưa có bảng», lỗi khác vẫn NÉM; (4) lead → đơn chỉ đếm đơn SAU mốc chuyển, bỏ đơn huỷ / xoá, lead
 * có khách mà thiếu mốc chuyển đếm riêng và KHÔNG gán đơn — đo bằng hiệu SAU − TRƯỚC trong một giao dịch rồi HUỶ (không để lại dòng);
 * (5) tóm tắt công khai không tên / SĐT / email / URL; (6) script chỉ đọc, tự chứa, khai đủ ở ops-vps / platform-isolation-static.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import { SUMMARY_MAX_BYTES } from "@/lib/ops/summary-lines";
import {
  countsParts,
  isMissingRelation,
  mask,
  MISSING,
  parseB2bProbeArgs,
  runWholesaleB2bProbe,
  section,
  usdFromMicros,
  vnd,
  type B2bProbeSummary,
} from "../scripts/wholesale-b2b-probe";

function testPure() {
  assert.deepEqual(parseB2bProbeArgs([]), { org: "hslc-hmt-shop" });
  assert.deepEqual(parseB2bProbeArgs(["--org=vnx"]), { org: "vnx" });
  for (const bad of [["hslc-hmt-shop"], ["--org="], ["--org=HSLC!"], ["--days=3"]]) assert.ok("error" in parseB2bProbeArgs(bad), JSON.stringify(bad));

  assert.equal(vnd(1234567), "1.234.567 ₫");
  assert.equal(vnd(0), "0 ₫", "0 thật ⇒ 0 ₫");
  assert.equal(vnd(null), "—", "chưa biết ⇒ —, không phải 0");
  assert.equal(usdFromMicros(1_250_000), "US$1,25");
  assert.deepEqual(countsParts([]), ["(không dòng nào)"]);
  assert.deepEqual(countsParts([{ k: "B", n: 2 }, { k: null, n: 5 }, { k: "A", n: 2 }]), ["(trống) 5", "A 2", "B 2"]);
  assert.equal(mask("gọi 0901234567 · a@b.vn · https://x.vn/y"), "gọi ###### · <email> · <url>");
  assert.equal(isMissingRelation({ code: "42P01" }), true);
  assert.equal(isMissingRelation({ cause: { code: "42703" } }), true);
  assert.equal(isMissingRelation({ code: "22012" }), false);
}

async function testMissingTable() {
  const db = await getDb();
  assert.equal(await section(() => db.execute(sql`select count(*) from wholesale_bang_khong_ton_tai`)), MISSING, "bảng chưa có ⇒ «chưa có bảng»");
  assert.equal(await section(() => db.execute(sql`select cot_khong_ton_tai from settings limit 1`)), MISSING, "cột chưa có ⇒ «chưa có bảng»");
  await assert.rejects(() => section(() => db.execute(sql`select 1 / 0`)), "lỗi khác vẫn NÉM — không giấu thành «chưa có»");
}

class HuyGiaoDich extends Error {}

const TEN = "Quán Thử B2B Probe";
const SDT = "0901234567";
const EMAIL = "thu-b2b-probe@vi-du.vn";
const WEB = "https://thu-b2b-probe.vi-du.vn";

async function chay(db: Db, printed: string[]): Promise<B2bProbeSummary> {
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    return await runWholesaleB2bProbe({ db, platformDb: db, orgCode: "b2b-probe-test", now: new Date(), label: "kiểm thử", moduleEnabled: true, features: { "wholesale_leads.ai_opener": false } });
  } finally {
    console.log = orig;
  }
}

async function testOnDb() {
  const db = await getDb();
  const printed: string[] = [];
  let truoc: B2bProbeSummary | null = null;
  let sau: B2bProbeSummary | null = null;
  await db
    .transaction(async (tx) => {
      const t = tx as unknown as Db;
      truoc = await chay(t, []);
      const conv = new Date(Date.now() - 10 * 86_400_000);
      const [kh] = await tx.insert(schema.customers).values({ name: TEN }).returning({ id: schema.customers.id });
      const [kh2] = await tx.insert(schema.customers).values({ name: `${TEN} 2` }).returning({ id: schema.customers.id });
      await tx.insert(schema.wholesaleLeads).values([
        { source: "STAFF", businessName: TEN, phoneRaw: SDT, normalizedPhone: SDT, email: EMAIL, website: WEB, contactStatus: "WON", leadGrade: "A", customerId: kh!.id, convertedAt: conv },
        // Có khách mà KHÔNG có mốc chuyển ⇒ đếm riêng, không gán đơn dù khách có đơn.
        { source: "STAFF", businessName: `${TEN} 2`, contactStatus: "WON", customerId: kh2!.id },
      ]);
      const don = (id: string, customerId: string, daysAgo: number, tien: number, stage: "CONFIRMED" | "CANCELLED") =>
        ({ id, customerId, insertedAt: new Date(Date.now() - daysAgo * 86_400_000), totalPrice: tien, totalPriceAfterDiscount: tien, stage });
      await tx.insert(schema.orders).values([
        don("b2b-probe-truoc", kh!.id, 20, 900_000, "CONFIRMED"), // TRƯỚC mốc chuyển ⇒ không tính
        don("b2b-probe-sau-1", kh!.id, 5, 1_200_000, "CONFIRMED"),
        don("b2b-probe-sau-2", kh!.id, 2, 800_000, "CONFIRMED"),
        don("b2b-probe-huy", kh!.id, 1, 5_000_000, "CANCELLED"), // huỷ ⇒ không tính
        don("b2b-probe-khach2", kh2!.id, 1, 700_000, "CONFIRMED"), // lead thiếu mốc chuyển ⇒ không gán
      ]);
      await tx.insert(schema.priceLists).values({ id: "b2b-probe-pl", name: "Bảng thử B2B", active: true });
      sau = await chay(t, printed);
      throw new HuyGiaoDich();
    })
    .catch((e: unknown) => {
      if (!(e instanceof HuyGiaoDich)) throw e;
    });
  const a = truoc as B2bProbeSummary | null;
  const b = sau as B2bProbeSummary | null;
  assert.ok(a && b, "chạy được hai lượt trên lược đồ thật");
  for (const [k, v] of Object.entries(b)) assert.notEqual(v, MISSING, `mục ${k} có bảng ở CSDL kiểm thử`);
  if (a.leadOrders === MISSING || b.leadOrders === MISSING || a.leads === MISSING || b.leads === MISSING || a.pricing === MISSING || b.pricing === MISSING) throw new Error("không thể xảy ra");
  assert.equal(b.leads.total - a.leads.total, 2);
  assert.equal(b.leads.withPhone - a.leads.withPhone, 1);
  assert.equal(b.leads.withEmail - a.leads.withEmail, 1);
  assert.equal(b.leads.withWebsite - a.leads.withWebsite, 1);
  assert.equal(b.leads.won - a.leads.won, 2);
  assert.equal(b.leadOrders.withCustomer - a.leadOrders.withCustomer, 2);
  assert.equal(b.leadOrders.noConvertedAt - a.leadOrders.noConvertedAt, 1, "lead thiếu mốc chuyển đếm riêng");
  assert.equal(b.leadOrders.leadsWithOrder - a.leadOrders.leadsWithOrder, 1, "chỉ lead có mốc chuyển mới được gán đơn");
  assert.equal(b.leadOrders.orders - a.leadOrders.orders, 2, "chỉ đơn SAU mốc chuyển, bỏ đơn huỷ");
  assert.equal(b.leadOrders.revenue - a.leadOrders.revenue, 2_000_000);
  assert.equal(b.pricing.activeLists - a.pricing.activeLists, 1);

  const summary = printed.filter((l) => l.startsWith("[ops:tom-tat]"));
  assert.ok(summary.length >= 10, "có khối tóm tắt");
  assert.ok(summary.some((l) => l.includes("doanh thu theo đơn, chưa đối chiếu tiền thật")), "ghi rõ doanh thu theo đơn chưa đối chiếu tiền thật");
  for (const l of summary) {
    assert.ok(Buffer.byteLength(l.replace("[ops:tom-tat] ", ""), "utf8") <= SUMMARY_MAX_BYTES, `dòng tóm tắt ≤ ${SUMMARY_MAX_BYTES} byte: ${l}`);
    for (const pii of [TEN, SDT, EMAIL, WEB, "b2b-probe-test", "Bảng thử B2B"]) assert.ok(!l.includes(pii), `tóm tắt không mang «${pii}»: ${l}`);
    assert.ok(!/@|https?:|\d{9,}/.test(l), `tóm tắt không thư / URL / dãy số dài: ${l}`);
  }
  const detail = printed.filter((l) => !l.startsWith("[ops:tom-tat]")).join("\n");
  assert.ok(detail.includes(TEN), "mẫu dòng (phần mã hoá) có tên để người đọc kiểm");
  assert.ok(!detail.includes(SDT) && !detail.includes(EMAIL), "phần mã hoá cũng không in SĐT / thư");
  const [con] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from wholesale_leads where business_name like ${`${TEN}%`}`));
  assert.equal(Number(con?.n ?? 0), 0, "giao dịch đã huỷ — bài kiểm không để lại dòng");
}

function testSourceFences() {
  const src = readFileSync("scripts/wholesale-b2b-probe.ts", "utf8").replace(/\r\n/g, "\n");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(src, /if \(CHAY_THANG\) process\.env\.ERP_READ_ONLY = "1";\nimport "dotenv\/config";/, "đặt ERP_READ_ONLY TRƯỚC khi nạp @/db");
  assert.match(code, /packSummaryLines\(/, "tóm tắt đi qua bộ dồn dùng chung (trần BYTE)");
  assert.match(code, /show default_transaction_read_only/, "hỏi lại Postgres phiên chỉ đọc");
  assert.match(code, /getDbForInspection/, "CSDL tổ chức mở bằng handle chỉ đọc");
  assert.ok(!/\bgetDb\(|withOrganization/.test(code), "không gọi getDb() / withOrganization (ngữ cảnh ấy migrate)");
  assert.ok(!/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b|\.insert\(|\.update\(|\.delete\(|setSettingJson|saveLeadHunterConfig/i.test(code), "không ghi gì");
  assert.ok(!/\bfetch\(|https?:\/\/|from "@\/lib\/integrations|from "@\/lib\/wholesale\/(providers|places|outreach)/.test(code), "không gọi API ngoài");
  assert.match(code, /org_code = \$\{orgCode\}/, "sổ AI lọc ĐÚNG org_code");
  for (const m of code.matchAll(/from "@\/([^"]+)"/g)) assert.ok(existsSync(`${m[1]}.ts`) || existsSync(`${m[1]}/index.ts`), `import @/${m[1]} phải có sẵn`);
  assert.ok(!/\(\?<[=!]/.test(code), "không nhìn-ngược");
  assert.match(code, /process\.stdout\.write\("", \(\) => done\(\)\)/, "xả stdout trước khi thoát");
  // Hàm dựng tóm tắt không được chạm cột định danh — chỉ số đếm / tiền / nhãn trạng thái.
  const fn = code.slice(code.indexOf("export function summaryLines"), code.indexOf("async function thoat"));
  assert.ok(fn.length > 200, "tìm thấy summaryLines");
  for (const f of ["business", "phone", "email", "website", "address", "customer", "facebook", "zalo", "chatId", "opener", "\\.name\\b"]) {
    assert.ok(!new RegExp(`\\$\\{[^}]*${f}`).test(fn), `tóm tắt không nội suy trường định danh «${f}»`);
  }
  assert.ok(!/console\.log\(`\[ops:tom-tat\] \$\{(?!line\}|s\}|TAG\})/.test(code), "dòng tóm tắt chỉ đi qua summaryLines");

  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- wholesale-b2b-probe\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bwholesale-b2b-probe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bwholesale-b2b-probe\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+wholesale-b2b-probe\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/wholesale-b2b-probe\.ts ;;/, "nhánh chạy đúng script, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("docs/ops-vps-script-notes.md", "utf8").includes("### `wholesale-b2b-probe)`"), "chú thích ở docs/ops-vps-script-notes.md");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/wholesale-b2b-probe.ts":'), "khai getDbForInspection / getPlatformDb ở platform-isolation-static");
}

export async function testWholesaleB2bProbe() {
  testPure();
  await testMissingTable();
  await testOnDb();
  testSourceFences();
  console.log("  ✓ ops wholesale-b2b-probe: arg --org mặc định hslc-hmt-shop · dòng ≤ 280 byte qua bộ dồn chung · bảng chưa có ⇒ «chưa có bảng», lỗi khác vẫn ném · lead → đơn chỉ đơn SAU mốc chuyển, bỏ huỷ, thiếu mốc không gán · tóm tắt không tên / SĐT / thư / URL · chỉ đọc, khai đủ");
}
