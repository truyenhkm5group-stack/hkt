import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { OWNER_DIGEST_CONFIG_KEY } from "@/lib/constants/owner-digest";
import {
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_LINES,
  collectCompanyOsSummary,
  companyOsSummaryLines,
  dem,
  packParts,
  vocabParts,
  type CompanyOsSummary,
  type Doc,
} from "@/scripts/company-os-summary";

/**
 * ═══════════ COMPANY OS · AGENT W · ops `company-os-summary` ═══════════
 *
 *  · Thuần: `null` ⇒ `—`, 0 thật ⇒ `0`; mục KHÔNG đọc được in `—` KÈM lý do (luật 42), không bao giờ 0;
 *    dòng ≤ 300 ký tự, cả lượt ≤ 60 dòng (trần của kênh tóm tắt).
 *  · Mã nguồn: không một câu ghi (INSERT/UPDATE/DELETE…), không đọc cột nào mang dữ liệu của NGƯỜI hay mã
 *    định danh (tên, SĐT, email, địa chỉ, tiêu đề, ghi chú, mã mẫu…), import chỉ tệp `lib/` đã có trên `main`.
 *  · CSDL (PGlite): đo TRƯỚC → gieo một ít dữ liệu mang chuỗi bí mật → đo SAU; khẳng định ĐỘ CHÊNH (không
 *    khẳng định tổng — CSDL kiểm thử dùng chung với mọi bài khác) và không dòng nào lộ chuỗi bí mật.
 */

const P = "cos-w-";
const BI_MAT = "BI-MAT-W";
const SDT = "0912345678";

function rong(): CompanyOsSummary {
  const hong = { ok: false as const, reason: "relation \"x\" does not exist" };
  return {
    at: new Date("2026-09-26T01:02:03Z"),
    models: hong,
    registry: hong,
    runs: hong,
    events: hong,
    topics: hong,
    costSheets: hong,
    samples: hong,
    design: hong,
    recommendations: hong,
    ownerDigest: hong,
    dispositions: hong,
    unidentified: hong,
    approvals: hong,
    receipts: hong,
  };
}

export function testCompanyOsSummaryPure() {
  assert.equal(dem(null), "—");
  assert.equal(dem(undefined), "—");
  assert.equal(dem(Number.NaN), "—");
  assert.equal(dem(0), "0", "0 thật in 0");
  assert.equal(dem(1234), "1.234");

  // Mục không đọc được ⇒ "—" + lý do; không có số 0 nào đứng thay.
  const hong = companyOsSummaryLines(rong());
  const moiMucHong = hong.slice(1);
  assert.equal(moiMucHong.length, 14, "mỗi mục hỏng in đúng MỘT dòng");
  for (const l of moiMucHong) {
    assert.match(l, /: — \(không đọc được: relation "x" does not exist\)$/, l);
    assert.doesNotMatch(l, /\b0\b/, `mục hỏng không được in 0: ${l}`);
  }

  // Bộ từ vựng: khoá không có dòng = 0 thật (câu đọc đã chạy); khoá lạ vẫn hiện; khoá NULL có nhãn riêng.
  assert.deepEqual(vocabParts([{ key: "A", n: 2 }, { key: null, n: 3 }, { key: "Z", n: 1 }], ["A", "B"], "chưa khai"), ["chưa khai 3", "A 2", "B 0", "Z (lạ) 1"]);

  // Gói dòng: không mẩu nào mất, không dòng nào quá trần.
  const parts = Array.from({ length: 80 }, (_, i) => `sự_kiện.thứ_${i} ${i}/${i * 3}`);
  const goi = packParts("SỰ KIỆN — ", parts);
  assert.ok(goi.length > 1 && goi.every((l) => l.length <= SUMMARY_MAX_CHARS));
  assert.equal(goi.join(" · ").split(" · ").length, parts.length, "mọi mẩu đều có mặt");
  assert.deepEqual(packParts("X — ", []), ["X — (không có dòng nào)"]);

  // Đầy đủ: số lớn, nhiều sự kiện, nhiều cặp loại × phản ứng — vẫn lọt 60 dòng × 300 ký tự.
  const day: CompanyOsSummary = {
    at: new Date("2026-09-26T01:02:03Z"),
    models: { ok: true, data: { byState: [{ key: null, n: 1200 }, { key: "WINNER", n: 7 }], withProduct: 1100, designOnly: 50, bare: 57, byUser: 3 } },
    registry: { ok: true, data: { pendingInsert: 4, pendingLink: 0, ambiguous: 2 } },
    runs: { ok: true, data: { registryLastAt: null, registryLastStatus: null, registryRuns7: 0, warmLastAt: new Date("2026-09-26T00:00:00Z"), warmLastStatus: "SUCCESS", warmFailed: 0, warmModelSignalsMs: null } },
    events: { ok: true, data: Array.from({ length: 40 }, (_, i) => ({ name: `mien_${i}.su_kien_dai_ten_${i}`, n7: i, n: i * 10 })) },
    topics: { ok: true, data: { byStatus: [{ key: "WAITING_QUOTE", n: 2 }], early: 1, promisingAtOpen: 1, noContext: 0 } },
    costSheets: { ok: true, data: [] },
    samples: { ok: true, data: [{ key: "SUBMITTED", n: 1 }] },
    design: { ok: true, data: { versions: 0, firstApprovedAt: null, orders: 12, ordersLinked: 0, ordersSince: null, ordersSinceLinked: null } },
    recommendations: { ok: true, data: Array.from({ length: 36 }, (_, i) => ({ kind: `KIND_${i}`, decision: ["ACCEPTED", "DISMISSED", "SNOOZED"][i % 3], n7: i, n: i })) },
    ownerDigest: { ok: true, data: { configured: false, enabled: null, ledgerDay: null, lastSentAt: null, seenToday: 0 } },
    dispositions: { ok: true, data: [{ key: "WRITE_OFF", n: 3, qty: 5, unidentified: 1 }] },
    unidentified: { ok: true, data: [{ status: "PENDING_IDENTIFICATION", withVariant: 1, withoutVariant: 4 }] },
    approvals: { ok: true, data: [{ status: "EXECUTED", n7: 2, n: 9, err7: 0, err: 1 }] },
    receipts: { ok: true, data: { receipts: 10, withOrder: 2, withBatch: 1, linked: 3, receipts30: 4, linked30: 1 } },
  };
  const lines = companyOsSummaryLines(day);
  assert.ok(lines.length <= SUMMARY_MAX_LINES && lines.every((l) => l.length <= SUMMARY_MAX_CHARS), `≤ ${SUMMARY_MAX_LINES} dòng × ${SUMMARY_MAX_CHARS} ký tự`);
  const all = lines.join("\n");
  assert.ok(all.includes("PHIẾU NHẬP"), "mục CUỐI vẫn lọt trần 60 dòng khi sự kiện / phản ứng dài");
  assert.match(all, /vòng đời — chưa khai 1\.200 · IDEA 0/, "chưa khai đứng đầu, trạng thái không có mẫu = 0 thật");
  assert.match(all, /JOB model-registry: lượt cuối — · chưa chạy lần nào · 0 lượt\/7 ngày/);
  assert.match(all, /tín hiệu mẫu — \(lượt cuối chưa làm ấm buồng lái\)/, "chưa có số đo ⇒ —, không 0 ms");
  assert.match(all, /lệnh SX lập SAU bản thiết kế đầu tiên: — \(chưa có bản thiết kế nào/, "không có mốc ⇒ —, không 0/12");
  assert.match(all, /chưa khai \(mặc định TẮT\)/);
  assert.match(all, /GIÁ THÀNH \(phiên bản\): tổng 0 — DRAFT 0 · FINAL 0/, "bảng đọc được mà rỗng ⇒ 0 thật");
  assert.match(all, /sự kiện approval\.executed 0\/0/, "sổ sự kiện đọc được, không có tên ấy ⇒ 0 thật");
  const saiSoSuKien = companyOsSummaryLines({ ...day, events: { ok: false, reason: "hết giờ" } }).join("\n");
  assert.match(saiSoSuKien, /sự kiện approval\.executed — \(không đọc được sổ sự kiện\)/, "sổ sự kiện hỏng ⇒ —, không 0/0");
  assert.match(companyOsSummaryLines({ ...day, ownerDigest: { ok: true, data: { configured: true, enabled: null, ledgerDay: null, lastSentAt: null, seenToday: 0 } } }).join("\n"), /— \(giá trị lưu không đọc được\)/);

  // ── Mã nguồn ──
  const src = readFileSync(path.join(process.cwd(), "scripts/company-os-summary.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const sqlText = [...code.matchAll(/sql`([^`]*)`/g)].map((m) => m[1]).join("\n");
  assert.ok(sqlText.length > 500, "đọc được các câu SQL của script");
  assert.doesNotMatch(sqlText, /\b(insert|update|delete|truncate|alter|drop|create|grant|merge|copy|nextval|setval|set_config|pg_advisory)\b/i, "script CHỈ ĐỌC — không một câu ghi");
  assert.doesNotMatch(code, /\.(insert|update|delete)\(/, "script không gọi đường ghi của drizzle");
  // Cột mang dữ liệu của NGƯỜI hoặc mã định danh: không được đọc. `name` duy nhất được phép là tên SỰ KIỆN.
  const PII = /\b(phone|[a-z_]+_phone|email|[a-z_]+_email|address|[a-z_]+_address|customer[a-z_]*|receiver[a-z_]*|full_name|[a-z_]+_name|created_by|decided_by|approved_by|finalized_by|requested_by|received_by|actor_id|note|notes|summary|title|body|reason|payload|snapshot|code|reference|supplier|subject_id|source_key|custom_id|dedupe_key)\b/i;
  assert.doesNotMatch(sqlText, PII, `script đọc một cột mang dữ liệu người / mã định danh: ${sqlText.match(PII)?.[0]}`);
  assert.equal(sqlText.replace(/select name as ev/g, "").match(/\bname\b/g), null, "cột `name` chỉ được đọc ở domain_events (tên sự kiện)");
  // Sổ kết cục hàng hoàn: chỉ đếm dòng + số món — không đọc giá trị huỷ ước tính (tests/company-os-returns.test.ts cho phép đọc sổ vì điều này).
  assert.doesNotMatch(sqlText, /value_estimate|unit_cost_estimate|cost_basis|total_cost|unit_cost|amount/i, "script không đọc cột tiền nào");
  // Mã mơ hồ của sổ mẫu: chỉ ĐẾM.
  assert.ok(code.includes("p.ambiguous.length") && !/ambiguous\.(map|join|slice)|ambiguous\[/.test(code), "mã mẫu mơ hồ chỉ được đếm, không in");
  // Chỉ đọc do Postgres ép + tiền tố kênh tóm tắt đúng từng ký tự.
  // Chuỗi dựng từ mảnh: bài kiểm này QUÉT mã nguồn, không đọc môi trường (test-hygiene gác chuỗi liền).
  const datChiDoc = ["process", "env", "ERP_READ_ONLY"].join(".") + ' = "1"';
  assert.ok(src.includes(datChiDoc) && src.indexOf(datChiDoc) < src.indexOf('from "@/db"'), "ERP_READ_ONLY đặt TRƯỚC khi nạp @/db");
  assert.ok(code.includes("show default_transaction_read_only"), "main hỏi lại chế độ chỉ đọc rồi mới chạy");
  // Chỉ import tệp đã có trên main (ops lấy script từ main, lib từ ảnh đang chạy).
  for (const m of code.matchAll(/from "@\/([^"]+)"/g)) {
    const rel = m[1];
    const tonTai = [".ts", ".tsx", "/index.ts"].some((ext) => {
      try {
        readFileSync(path.join(process.cwd(), rel + ext));
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(tonTai, `script import @/${rel} — không có tệp`);
  }
  // Nhánh ops: đúng khuôn stock-wait-summary (mã hoá + làn đọc nặng + trong options).
  const yml = readFileSync(path.join(process.cwd(), ".github/workflows/ops-vps.yml"), "utf8");
  assert.match(yml, /^\s+- company-os-summary\s+#/m, "có trong options");
  assert.match(yml, /OPS_THAO_TAC_MA_HOA: "[^"]*\bcompany-os-summary\b/, "cùng lớp mã hoá với stock-wait-summary");
  assert.match(yml, /DOC_NANG="[^"]*\bcompany-os-summary\b/, "làn đọc nặng như stock-wait-summary (DOC_NHE cấm npx tsx)");
  assert.match(yml, /ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/company-os-summary\.ts/);
  console.log("✓ Company OS · W: company-os-summary — null/hỏng in —, 0 thật in 0, ≤ 60 × 300, chỉ đọc, không cột dữ liệu người");
}

async function donDep(db: Db) {
  await db.delete(schema.stockReceipts).where(like(schema.stockReceipts.id, `${P}%`));
  await db.delete(schema.productionOrders).where(like(schema.productionOrders.id, `${P}%`));
  await db.delete(schema.approvalRequests).where(like(schema.approvalRequests.id, `${P}%`));
  await db.delete(schema.domainEvents).where(like(schema.domainEvents.subjectId, `${P}%`));
  await db.delete(schema.productionTopics).where(like(schema.productionTopics.id, `${P}%`));
  await db.delete(schema.productModels).where(like(schema.productModels.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

function ok<T>(d: Doc<T>, ten: string): T {
  if (!d.ok) assert.fail(`${ten} không đọc được trên CSDL kiểm thử: ${d.reason}`);
  return d.data;
}

export async function testCompanyOsSummaryDb(db: Db) {
  await donDep(db);
  const [cfgCu] = await db.select().from(schema.settings).where(eq(schema.settings.key, OWNER_DIGEST_CONFIG_KEY));
  try {
    const truoc = await collectCompanyOsSummary(db);
    for (const [k, v] of Object.entries(truoc)) if (k !== "at") ok(v as Doc<unknown>, k);

    const now = new Date();
    await db.insert(schema.products).values({ id: `${P}p1`, name: `${BI_MAT} sản phẩm`, customId: `COSW-A` });
    await db.insert(schema.productModels).values([
      { id: `${P}m1`, code: "COSW-A", name: `${BI_MAT} mẫu A`, productId: `${P}p1`, lifecycleState: "WINNER", registeredBy: "SYNC" },
      { id: `${P}m2`, code: "COSW-B", name: `${BI_MAT} mẫu B`, lifecycleState: null, registeredBy: "USER" },
      { id: `${P}m3`, code: "COSW-C", name: `${BI_MAT} mẫu C`, lifecycleState: "IDEA", registeredBy: "USER" },
    ]);
    await db.insert(schema.productionTopics).values({
      id: `${P}t1`,
      modelId: `${P}m2`,
      title: `${BI_MAT} topic ${SDT}`,
      createdBy: BI_MAT,
      evidenceSnapshot: { basis: "test", capturedAt: now.toISOString(), lifecycleAtOpen: null, signalAtOpen: { signal: "PROMISING", decidedBy: "ADS", reasons: [] } },
    });
    await db.insert(schema.domainEvents).values({ name: "model.registered", subjectType: "product_model", subjectId: `${P}ev1`, actorKind: "SYSTEM", source: "test", occurredAt: now, payload: { ghiChu: BI_MAT } });
    await db.insert(schema.approvalRequests).values({ id: `${P}a1`, group: "stock", action: "stock.adjustment", summary: `${BI_MAT} ${SDT}`, requestedByEmail: "bi-mat-w@shop.vn", executionError: `${BI_MAT} lỗi` });
    await db.insert(schema.productionOrders).values({ id: `${P}po1`, code: "COSW-PO1", productName: BI_MAT, supplier: BI_MAT, note: SDT });
    await db.insert(schema.stockReceipts).values({ id: `${P}r1`, kind: "RECEIPT", receivedAt: now, reference: BI_MAT, supplier: BI_MAT, note: SDT, productionOrderId: `${P}po1`, createdBy: BI_MAT });
    await db.insert(schema.settings).values({ key: OWNER_DIGEST_CONFIG_KEY, value: JSON.stringify({ enabled: true }) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ enabled: true }) } });

    const sau = await collectCompanyOsSummary(db);
    const cheo = <T>(ten: keyof CompanyOsSummary, f: (x: T) => number) => f(ok(sau[ten] as unknown as Doc<T>, ten)) - f(ok(truoc[ten] as unknown as Doc<T>, ten));
    type M = { byState: { key: string | null; n: number }[]; withProduct: number; bare: number; byUser: number };
    const trangThai = (k: string | null) => (x: M) => x.byState.filter((r) => r.key === k).reduce((t, r) => t + r.n, 0);
    assert.equal(cheo<M>("models", (x) => x.byState.reduce((t, r) => t + r.n, 0)), 3, "tổng mẫu +3");
    assert.equal(cheo<M>("models", trangThai("WINNER")), 1);
    assert.equal(cheo<M>("models", trangThai("IDEA")), 1);
    assert.equal(cheo<M>("models", trangThai(null)), 1, "mẫu chưa khai đếm ở nhóm riêng");
    assert.equal(cheo<M>("models", (x) => x.withProduct), 1);
    assert.equal(cheo<M>("models", (x) => x.bare), 2);
    assert.equal(cheo<M>("models", (x) => x.byUser), 2);
    type T = { byStatus: { key: string | null; n: number }[]; early: number; promisingAtOpen: number };
    assert.equal(cheo<T>("topics", (x) => x.byStatus.filter((r) => r.key === "WAITING_QUOTE").reduce((t, r) => t + r.n, 0)), 1);
    assert.equal(cheo<T>("topics", (x) => x.early), 1, "topic mở SỚM đếm bằng CHÍNH describeTopicOpenContext");
    assert.equal(cheo<T>("topics", (x) => x.promisingAtOpen), 1);
    type E = { name: string; n7: number; n: number }[];
    assert.equal(cheo<E>("events", (x) => x.find((e) => e.name === "model.registered")?.n7 ?? 0), 1);
    assert.equal(cheo<E>("events", (x) => x.find((e) => e.name === "model.registered")?.n ?? 0), 1);
    type A = { status: string; n7: number; err7: number }[];
    assert.equal(cheo<A>("approvals", (x) => x.find((a) => a.status === "PENDING")?.n7 ?? 0), 1);
    assert.equal(cheo<A>("approvals", (x) => x.reduce((t, a) => t + a.err7, 0)), 1);
    type D = { orders: number; ordersLinked: number };
    assert.equal(cheo<D>("design", (x) => x.orders), 1);
    assert.equal(cheo<D>("design", (x) => x.ordersLinked), 0, "lệnh không trỏ bản thiết kế");
    type Rc = { receipts: number; withOrder: number; linked: number; receipts30: number; linked30: number };
    for (const k of ["receipts", "withOrder", "linked", "receipts30", "linked30"] as const) assert.equal(cheo<Rc>("receipts", (x) => x[k]), 1, `phiếu nhập ${k} +1`);
    const od = ok(sau.ownerDigest, "ownerDigest");
    assert.equal(od.configured, true);
    assert.equal(od.enabled, true);

    const lines = companyOsSummaryLines(sau);
    const all = lines.join("\n");
    assert.ok(lines.length <= SUMMARY_MAX_LINES && lines.every((l) => l.length <= SUMMARY_MAX_CHARS));
    assert.doesNotMatch(all, /— \(không đọc được/, `mọi mục đọc được trên CSDL kiểm thử:\n${all}`);
    for (const bi of [BI_MAT, SDT, "COSW", "bi-mat-w@", P]) assert.ok(!all.includes(bi), `dòng tóm tắt lộ "${bi}":\n${all}`);
    assert.match(all, /TIN LARK "Cần anh quyết" \(owner\.digest\): BẬT/);

    // Giá trị lưu hỏng ⇒ "—", không phải TẮT.
    await db.update(schema.settings).set({ value: "{" }).where(eq(schema.settings.key, OWNER_DIGEST_CONFIG_KEY));
    const hong = ok((await collectCompanyOsSummary(db)).ownerDigest, "ownerDigest");
    assert.equal(hong.enabled, null);
    console.log(`✓ Company OS · W: company-os-summary trên PGlite — ${lines.length} dòng, độ chênh đúng sau khi gieo, 0 chuỗi bí mật lọt ra`);
  } finally {
    if (cfgCu) await db.update(schema.settings).set({ value: cfgCu.value }).where(eq(schema.settings.key, OWNER_DIGEST_CONFIG_KEY));
    else await db.delete(schema.settings).where(inArray(schema.settings.key, [OWNER_DIGEST_CONFIG_KEY]));
    await donDep(db);
  }
}
