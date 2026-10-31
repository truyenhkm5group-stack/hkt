/**
 * ═══ OPS `wholesale-b2b-probe` (chương trình AI B2B Sales Agent của HSLC, P1-D 27/10/2026) ═══
 *
 * Khoá: (1) arg `[--org=<mã>]` mặc định hslc-hmt-shop, tham số lạ ⇒ lỗi; (2) dòng tóm tắt ≤ 280 BYTE (ops cắt theo byte) qua bộ dồn dùng
 * chung lib/ops/summary-lines; (3) bảng / cột chưa có ⇒ «chưa có bảng», lỗi khác vẫn NÉM; (4) lead → đơn chỉ đếm đơn SAU mốc chuyển, bỏ đơn huỷ / xoá, lead
 * có khách mà thiếu mốc chuyển đếm riêng và KHÔNG gán đơn — đo bằng hiệu SAU − TRƯỚC trong một giao dịch rồi HUỶ (không để lại dòng);
 * (5) tóm tắt công khai không tên / SĐT / email / URL; (6) script chỉ đọc, tự chứa, khai đủ ở ops-vps / platform-isolation-static;
 * (7) mục «email» (31/10/2026): cấu hình đọc qua mergeSettingJson + parse của từng module, kết nối gws-smtp chỉ trạng thái / mốc kiểm,
 * lý do chờ / chặn quy về MÃ — tóm tắt không địa chỉ thư, tên miền, danh tính người gửi hay câu lý do gốc.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import { SUMMARY_MAX_BYTES } from "@/lib/ops/summary-lines";
import { EMAIL_BLOCK_REASON_LABEL, EMAIL_BLOCK_REASONS, LIVE_EMAIL_ADAPTERS } from "@/lib/wholesale/email-constants";
import {
  B2B_PROBE_MAIL_CONNECTOR,
  countsParts,
  isMissingRelation,
  mailReasonCodes,
  mailReasonCounts,
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

  // Lý do chờ / chặn ⇒ MÃ (chi tiết — tên miền, địa chỉ thư — bị bỏ).
  const L = EMAIL_BLOCK_REASON_LABEL;
  for (const a of EMAIL_BLOCK_REASONS) for (const b of EMAIL_BLOCK_REASONS) if (a !== b) assert.ok(!L[b].startsWith(L[a]), `nhãn ${a} không là tiền tố của ${b} (quy mã theo tiền tố)`);
  assert.deepEqual(mailReasonCodes(`${L.KILL_DOMAIN}: chuoi.vi-du.vn · ${L.LIMIT_DAY}: 100/100`), ["KILL_DOMAIN", "LIMIT_DAY"]);
  assert.deepEqual(mailReasonCodes(`${L.ADDRESS_CHANGED}: lead đang mang a@b.vn`), ["ADDRESS_CHANGED"]);
  assert.deepEqual(mailReasonCodes(`${L.KILL_ORG}: tạm dừng · chờ chủ shop`), ["KILL_ORG"], "chi tiết chứa « · » không đẻ mã lạ");
  assert.deepEqual(mailReasonCodes("Chưa gửi được ở chế độ LIVE: chưa có nhà cung cấp"), ["NO_PROVIDER"]);
  assert.deepEqual(mailReasonCodes("Lần 2: ETIMEDOUT"), ["PROVIDER_RETRY"]);
  assert.deepEqual(mailReasonCodes("câu lạ"), ["OTHER"]);
  assert.deepEqual(mailReasonCodes(null), []);
  assert.deepEqual(mailReasonCounts([`${L.LIMIT_DAY}: 1/1`, `${L.LIMIT_DAY}: 2/1 · ${L.LIMIT_HOUR}: 9/9`, null]), [{ k: "LIMIT_DAY", n: 2 }, { k: "LIMIT_HOUR", n: 1 }]);
  assert.ok(LIVE_EMAIL_ADAPTERS.includes(B2B_PROBE_MAIL_CONNECTOR), "connector đo là adapter gửi thật đang khai");
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
const MAIL_SENDER = "ban-si-probe@vi-du.vn";
const MAIL_COMPANY = "Công ty Thử Probe Email";
const MAIL_DOMAIN = "chuoi-probe.vi-du.vn";
const MAIL_TEST_MSG = "SMTP probe đạt cho ban-si-probe";
const kn = (v: B2bProbeSummary["mailOutbox"], k: string) => (v === MISSING ? -1 : (v.find((r) => r.k === k)?.n ?? 0));

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
      const [lead] = await tx
        .insert(schema.wholesaleLeads)
        .values([
          { source: "STAFF", businessName: TEN, phoneRaw: SDT, normalizedPhone: SDT, email: EMAIL, website: WEB, contactStatus: "WON", leadGrade: "A", customerId: kh!.id, convertedAt: conv },
          // Có khách mà KHÔNG có mốc chuyển ⇒ đếm riêng, không gán đơn dù khách có đơn.
          { source: "STAFF", businessName: `${TEN} 2`, contactStatus: "WON", customerId: kh2!.id },
        ])
        .returning({ id: schema.wholesaleLeads.id });
      // ── Email: cấu hình (ghi đè nếu CSDL kiểm thử đã có dòng — giao dịch huỷ ở cuối) + kết nối + hộp thư đi + sự kiện ──
      const setting = (key: string, value: unknown) =>
        tx.insert(schema.settings).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } });
      await setting("wholesale.email", {
        mode: "LIVE",
        liveEnabledByUserId: "u-probe",
        liveEnabledAt: new Date().toISOString(),
        limits: { perHour: 15, perDay: 80, perRecipientDomainPerDay: 3 },
        allowedCountries: ["VN", "US"],
        blockedDomains: [MAIL_DOMAIN],
        sender: { name: "Bán sỉ", email: MAIL_SENDER, companyName: MAIL_COMPANY, address: "" },
      });
      await setting("wholesale.emailInbound", { enabled: true, aiClassify: true, dailyMaxClassify: 40, dailyCostCapUsd: 1.5 });
      await setting("wholesale.emailInbound.cursor", { uidValidity: "uidv-probe", lastUid: 12 });
      // Bật mà thiếu trần chi phí ⇒ parse của module coi là TẮT (rơi về phía hẹp) — probe phải nói đúng như đường chạy.
      await setting("wholesale.emailAiDraft", { enabled: true, dailyMaxDrafts: 20 });
      await setting("wholesale.emailSequence", { maxFollowups: 2, gapDays: 4, templates: { vi: "Chào {ten}", en: "" } });
      await setting("wholesale.reorder", { afterDays: 30 });
      await setting("wholesale.quotation", { maxDiscountPercent: 10, taxRatePercent: 8 }); // thuế thiếu căn cứ ⇒ CHƯA khai
      await tx
        .insert(schema.orgConnections)
        .values({ orgCode: "b2b-probe-test", connectorKey: B2B_PROBE_MAIL_CONNECTOR, status: "ACTIVE", lastTestOk: true, lastTestAt: new Date(), lastTestMessage: MAIL_TEST_MSG })
        .onConflictDoUpdate({ target: schema.orgConnections.connectorKey, set: { orgCode: "b2b-probe-test", status: "ACTIVE", lastTestOk: true, lastTestAt: new Date(), lastTestMessage: MAIL_TEST_MSG } });
      const L = EMAIL_BLOCK_REASON_LABEL;
      const thu = (key: string, extra: Partial<typeof schema.wholesaleEmailOutbox.$inferInsert>) =>
        ({ leadId: lead!.id, toEmail: EMAIL, recipientDomain: "vi-du.vn", subject: "Chào", bodyText: "Thân", templateKey: "OPENER_D0", idempotencyKey: `b2b-probe:${key}`, preparedBy: "USER", ...extra }) as typeof schema.wholesaleEmailOutbox.$inferInsert;
      const now = new Date();
      const [sent] = await tx
        .insert(schema.wholesaleEmailOutbox)
        .values([
          thu("sent", { status: "SENT", mode: "LIVE", sentAt: now, approvalUsedAt: now }),
          thu("hold", { status: "QUEUED", lastError: `${L.KILL_DOMAIN}: ${MAIL_DOMAIN} · ${L.LIMIT_DAY}: 80/80` }),
          thu("blocked", { status: "BLOCKED", blockedReason: `${L.ADDRESS_CHANGED}: lead đang mang ${MAIL_SENDER}`, approvalUsedAt: now }),
        ])
        .returning({ id: schema.wholesaleEmailOutbox.id });
      await tx.insert(schema.wholesaleEmailEvents).values([
        { leadId: lead!.id, outboxId: sent!.id, kind: "SENT" },
        { leadId: lead!.id, outboxId: sent!.id, kind: "REPLY", providerEventId: "b2b-probe-reply-1" },
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

  // ── Email ──
  if (b.mailConfig === MISSING || b.mailConnection === MISSING || b.mailQueue === MISSING || a.mailQueue === MISSING || b.mailBlocked === MISSING || a.mailBlocked === MISSING) throw new Error("không thể xảy ra");
  const m = b.mailConfig;
  assert.equal(m.saved, true);
  assert.equal(m.mode, "LIVE");
  assert.equal(m.liveOwnerEnabled, true);
  assert.deepEqual(m.limits, { perHour: 15, perDay: 80, perRecipientDomainPerDay: 3 });
  assert.deepEqual(m.countries, ["VN", "US"], "mảng lồng giữ nguyên là mảng (không bị trộn nông thành object)");
  assert.deepEqual(m.senderMissing, ["địa chỉ doanh nghiệp"], "chỉ nói THIẾU trường nào");
  assert.equal(m.blockedDomains, 1);
  assert.deepEqual(m.inbound, { enabled: true, cursor: true, aiClassify: true, maxClassify: 40, classifyCapUsd: 1.5 });
  assert.deepEqual(m.aiDraft, { enabled: false, maxDrafts: 20, capUsd: null }, "bật mà thiếu trần ⇒ TẮT, đúng như getEmailAiSettings");
  assert.deepEqual(m.sequence, { maxFollowups: 2, gapDays: 4, templateVi: true, templateEn: false });
  assert.equal(m.reorderAfterDays, 30);
  assert.deepEqual(m.quote, { saved: true, maxDiscount: true, minMargin: false, tax: false }, "thuế thiếu căn cứ ⇒ chưa khai");
  assert.deepEqual(b.mailConnection && { ...b.mailConnection, lastTestAt: typeof b.mailConnection.lastTestAt }, { status: "ACTIVE", lastTestAt: "string", lastTestOk: true, orgMatch: true });
  assert.equal(kn(b.mailOutbox, "SENT/LIVE") - kn(a.mailOutbox, "SENT/LIVE"), 1);
  assert.equal(kn(b.mailOutbox, "QUEUED") - kn(a.mailOutbox, "QUEUED"), 1);
  assert.equal(kn(b.mailOutbox, "BLOCKED") - kn(a.mailOutbox, "BLOCKED"), 1);
  assert.equal(kn(b.mailEvents, "SENT/LIVE") - kn(a.mailEvents, "SENT/LIVE"), 1);
  assert.equal(kn(b.mailEvents, "REPLY/LIVE") - kn(a.mailEvents, "REPLY/LIVE"), 1);
  assert.equal(b.mailQueue.queued - a.mailQueue.queued, 1);
  assert.equal(kn(b.mailQueue.reasons, "KILL_DOMAIN") - kn(a.mailQueue.reasons, "KILL_DOMAIN"), 1);
  assert.equal(kn(b.mailQueue.reasons, "LIMIT_DAY") - kn(a.mailQueue.reasons, "LIMIT_DAY"), 1);
  assert.equal(kn(b.mailBlocked, "ADDRESS_CHANGED") - kn(a.mailBlocked, "ADDRESS_CHANGED"), 1);

  const summary = printed.filter((l) => l.startsWith("[ops:tom-tat]"));
  assert.ok(summary.length >= 10, "có khối tóm tắt");
  assert.ok(summary.some((l) => l.includes("doanh thu theo đơn, chưa đối chiếu tiền thật")), "ghi rõ doanh thu theo đơn chưa đối chiếu tiền thật");
  const mailText = summary.join("\n");
  for (const want of ["chế độ LIVE", "nước đã rà VN,US", "trạng thái ACTIVE", "mốc UID có", "AI soạn nháp TẮT", "chuỗi nhắc 2 lần cách 4 ngày", "mua lại sỉ sau 30 ngày", "KILL_DOMAIN", "ADDRESS_CHANGED", "SENT/LIVE"]) {
    assert.ok(mailText.includes(want), `tóm tắt email có «${want}»`);
  }
  for (const l of summary) {
    assert.ok(Buffer.byteLength(l.replace("[ops:tom-tat] ", ""), "utf8") <= SUMMARY_MAX_BYTES, `dòng tóm tắt ≤ ${SUMMARY_MAX_BYTES} byte: ${l}`);
    for (const pii of [TEN, SDT, EMAIL, WEB, "b2b-probe-test", "Bảng thử B2B", MAIL_SENDER, MAIL_COMPANY, MAIL_DOMAIN, MAIL_TEST_MSG, "u-probe", "uidv-probe", "Chào {ten}", EMAIL_BLOCK_REASON_LABEL.KILL_DOMAIN]) {
      assert.ok(!l.includes(pii), `tóm tắt không mang «${pii}»: ${l}`);
    }
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
  assert.match(code, /mergeSettingJson\(v, fallback\)/, "cấu hình email đọc bằng luật của getSettingJson, không JSON.parse tay");
  for (const f of ["mergeEmailSettings(", "parseEmailInboundSettings(", "parseInboundCursor(", "parseEmailAiSettings(", "parseEmailSequenceSettings(", "parseWholesaleReorderSettings(", "parseQuotationPolicy("]) {
    assert.ok(code.includes(f), `đọc cấu hình bằng hàm của module: ${f}`);
  }
  assert.ok(!/secrets_enc|secret_hints|last_test_message/.test(code), "không đọc cột bí mật / câu kiểm của kết nối");
  // Hai câu không thuộc cổng mà mailReasonCodes nhận ra phải còn ở đường ghi — đổi chữ bên ấy thì mã rơi về OTHER, bài này đỏ.
  const outbox = readFileSync("lib/wholesale/email-outbox.ts", "utf8");
  assert.ok(outbox.includes("`Chưa gửi được ở chế độ ${settings.mode}") && outbox.includes("lastError: `Lần ${attempts}: "), "câu NO_PROVIDER / PROVIDER_RETRY còn khớp đường ghi");
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
  console.log("  ✓ ops wholesale-b2b-probe: arg --org mặc định hslc-hmt-shop · dòng ≤ 280 byte qua bộ dồn chung · bảng chưa có ⇒ «chưa có bảng», lỗi khác vẫn ném · lead → đơn chỉ đơn SAU mốc chuyển, bỏ huỷ, thiếu mốc không gán · email: cấu hình qua parse của module, gws-smtp chỉ trạng thái, lý do quy MÃ · tóm tắt không tên / SĐT / thư / URL / tên miền · chỉ đọc, khai đủ");
}
