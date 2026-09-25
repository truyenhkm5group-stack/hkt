import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { DOMAIN_EVENT_BY_NAME, DOMAIN_EVENT_NAME_PATTERN, DOMAIN_EVENTS, MODEL_SUBJECT, type DomainEventName } from "@/lib/constants/domain-events";
import {
  checkModelTransition,
  MODEL_REASON_MIN_LENGTH,
  MODEL_STATES,
  MODEL_TRANSITIONS,
  normalizeModelCode,
  observeModelStage,
  type ModelEvidence,
  type ModelState,
} from "@/lib/constants/model-lifecycle";
import { normalizeProductCode } from "@/lib/constants/workshop-ledger";
import { emitDomainEvent } from "@/lib/events/emit";
import { planModelRegistry, REGISTER_REASON, registerModelCore, setModelOwnerCore, syncModelRegistry, transitionModelCore, type RegistryModel, type RegistryProduct } from "@/lib/models/service";
import { getModelEvidence, getModelTimeline, getModel, previewModelRegistry } from "@/lib/queries/models";

/**
 * ═══════════ COMPANY OS · AGENT A — SỔ MẪU · VÒNG ĐỜI · SỔ SỰ KIỆN ═══════════
 *
 * Hợp đồng: docs/company-os/shared-contracts.md mục 1–2. Năm thứ dễ sai nhất và bài này khoá lại:
 *  1. Bảng cạnh: cạnh "tiến" không cần lý do, mọi thứ khác (kể cả khai lần đầu từ NULL) BẮT BUỘC lý do.
 *  2. Lịch sử vòng đời và sổ sự kiện là APPEND-ONLY — quét mã nguồn, không UPDATE / DELETE ở đâu cả.
 *  3. Sổ khai sự kiện nói thật: tên LIVE trỏ tệp có thật chứa tên đó; không tệp nào phát tên chưa khai.
 *  4. Đồng bộ sổ: hai sản phẩm cùng mã ⇒ AMBIGUOUS (không đoán — luật 35); chạy lại không đẻ dòng mới;
 *     mẫu mới luôn `lifecycle_state = NULL` (không backfill).
 *  5. Một lượt chuyển = UPDATE + lịch sử + sự kiện trong MỘT giao dịch; người làm phải có khoá tài khoản.
 *
 * Không mốc thời gian tuyệt đối nào (luật 50, 65): mọi khẳng định đọc từ chính dữ liệu vừa gieo.
 */

const TAT_CA_CANH = (from: ModelState | null, to: ModelState) => checkModelTransition(from, to);

export function testCompanyOsModelsPure() {
  // ───────── 1. Bảng trạng thái khớp CHECK của CSDL ─────────
  assert.equal(MODEL_STATES.length, 15, "hợp đồng khai đúng 15 trạng thái vòng đời");
  const mig = readFileSync("drizzle/0131_company_os_models.sql", "utf8");
  const checkList = (ten: string) => {
    const m = new RegExp(`"${ten}" CHECK \\(([^\\n]+)\\)`).exec(mig);
    assert.ok(m, `migration 0131 phải có CHECK ${ten}`);
    return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual(checkList("product_models_state_check"), [...MODEL_STATES], "CHECK trạng thái trong migration phải đúng bằng MODEL_STATES — lệch là một trạng thái không lưu được");
  assert.deepEqual(checkList("product_model_state_history_to_check"), [...MODEL_STATES], "CHECK của lịch sử phải đúng bằng MODEL_STATES");
  const schemaSrc = readFileSync("db/schema.ts", "utf8");
  for (const s of MODEL_STATES) assert.ok(schemaSrc.includes(`'${s}'`), `db/schema.ts phải khai trạng thái ${s} trong CHECK`);

  // ───────── 2. Bảng cạnh ─────────
  for (const [from, dens] of Object.entries(MODEL_TRANSITIONS) as [ModelState, readonly ModelState[]][]) {
    for (const to of dens) {
      assert.notEqual(from, to, `cạnh ${from} → ${to} tự trỏ về chính nó`);
      const k = TAT_CA_CANH(from, to);
      assert.ok(k.ok && !k.needsReason, `cạnh tiến ${from} → ${to} không được đòi lý do`);
    }
  }
  const tien: [ModelState, ModelState][] = [
    ["IDEA", "CREATIVE"],
    ["CREATIVE", "ADS_TESTING"],
    ["ADS_TESTING", "WINNER"],
    ["ADS_TESTING", "LOSER"],
    ["WINNER", "PRODUCTION_DISCUSSION"],
    ["PRODUCTION_DISCUSSION", "COSTING"],
    ["COSTING", "SAMPLING"],
    ["SAMPLING", "SAMPLE_REVIEW"],
    ["SAMPLE_REVIEW", "APPROVED"],
    ["SAMPLE_REVIEW", "SAMPLING"], // yêu cầu sửa mẫu
    ["APPROVED", "PRODUCTION_PLANNING"],
    ["PRODUCTION_PLANNING", "IN_PRODUCTION"],
    ["IN_PRODUCTION", "SELLING"],
    ["SELLING", "PRODUCTION_PLANNING"], // tái sản xuất
    ["SELLING", "CLEARANCE"],
    ["CLEARANCE", "DISCONTINUED"],
  ];
  for (const [a, b] of tien) {
    const k = TAT_CA_CANH(a, b);
    assert.ok(k.ok && !k.needsReason, `sơ đồ §3: ${a} → ${b} là cạnh tiến, không cần lý do`);
  }
  assert.equal(Object.values(MODEL_TRANSITIONS).reduce((n, d) => n + d.length, 0), tien.length, "bảng cạnh tiến phải đúng bằng sơ đồ §3 — thêm một cạnh không lý do là mở cửa nhảy cóc im lặng");
  const canLyDo: [ModelState, ModelState][] = [
    ["CREATIVE", "IDEA"],
    ["IDEA", "SELLING"],
    ["LOSER", "CREATIVE"],
    ["DISCONTINUED", "SELLING"],
    ["SELLING", "IDEA"],
    ["WINNER", "LOSER"],
  ];
  for (const [a, b] of canLyDo) {
    const k = TAT_CA_CANH(a, b);
    assert.ok(k.ok && k.needsReason, `${a} → ${b} là lùi bước / nhảy cóc: ĐƯỢC nhưng BẮT BUỘC lý do`);
  }
  for (const s of MODEL_STATES) {
    const k = TAT_CA_CANH(null, s);
    assert.ok(k.ok && k.needsReason, `khai lần đầu (NULL → ${s}) phải đòi lý do`);
    assert.equal(TAT_CA_CANH(s, s).ok, false, `${s} → ${s} là lỗi, không có gì để ghi`);
  }
  assert.equal(checkModelTransition("SELLING", "BOGUS" as ModelState).ok, false, "trạng thái lạ bị từ chối");
  assert.deepEqual(MODEL_TRANSITIONS.DISCONTINUED, [], "DISCONTINUED không có lối ra không lý do");
  // Mọi trạng thái (trừ hai điểm cuối) có đường tiến; từ IDEA đi tiến tới được DISCONTINUED.
  const toi = new Set<ModelState>(["IDEA"]);
  for (let doi = true; doi; ) {
    doi = false;
    for (const s of [...toi]) {
      for (const t of MODEL_TRANSITIONS[s]) {
        if (toi.has(t)) continue;
        toi.add(t);
        doi = true;
      }
    }
  }
  assert.ok(toi.has("DISCONTINUED") && toi.has("LOSER"), "từ IDEA theo cạnh tiến phải tới được cả hai điểm cuối");
  assert.equal(toi.size, MODEL_STATES.length, "mọi trạng thái phải nằm trên sơ đồ tiến từ IDEA");

  // ───────── 3. Mã mẫu dùng lại bộ chuẩn hoá có sẵn ─────────
  assert.equal(normalizeModelCode(" q 002 "), "Q002");
  assert.equal(normalizeModelCode("tk-260925-01"), "TK-260925-01");
  assert.equal(normalizeModelCode("   "), null, "mã rỗng ⇒ null, không đăng ký");
  assert.equal(normalizeModelCode(null), null);
  for (const raw of ["Q001", " x 12 ", "tk-1\t2"]) assert.equal(normalizeModelCode(raw), normalizeProductCode(raw), "một bộ chuẩn hoá cho mọi nơi gọi mã hàng");

  // ───────── 4. Giai đoạn quan sát: ước tính, không đoán khi không có chứng cứ ─────────
  const trong: ModelEvidence = { designStatus: null, productRemoved: null, adSpend30d: null, orders30d: null, ordersTotal: null, draftProductionOrders: null, sentProductionOrders: null, stockKnown: null, stockOnHand: null };
  assert.deepEqual(observeModelStage(trong), { stage: null, reasons: [], basis: "ESTIMATED" }, "không chứng cứ ⇒ không đoán");
  const muaThu = observeModelStage({ ...trong, designStatus: "TESTING" });
  assert.equal(muaThu.stage, "ADS_TESTING");
  const manhThuan = observeModelStage({ ...trong, designStatus: "TESTING", sentProductionOrders: 1, orders30d: 0, adSpend30d: 0, ordersTotal: 0 });
  assert.equal(manhThuan.stage, "IN_PRODUCTION", "chứng cứ đi xa nhất thắng");
  assert.equal(manhThuan.reasons.length, 2, "mọi lý do đều được trả về, kể cả của ứng viên thua");
  assert.equal(observeModelStage({ ...trong, orders30d: 3, ordersTotal: 10 }).stage, "SELLING");
  assert.equal(observeModelStage({ ...trong, ordersTotal: 10, orders30d: 0, stockKnown: false, stockOnHand: null }).stage, null, "tồn CHƯA BIẾT không thành chứng cứ đang bán");
  assert.equal(observeModelStage({ ...trong, productRemoved: true, orders30d: 2 }).stage, "DISCONTINUED");
  for (const e of [trong, { ...trong, designStatus: "WIN" as const }]) assert.equal(observeModelStage(e).basis, "ESTIMATED");

  // ───────── 5. Sổ khai sự kiện ─────────
  const ten = DOMAIN_EVENTS.map((e) => e.name);
  assert.equal(new Set(ten).size, ten.length, "tên sự kiện không được trùng");
  const hopDong = [
    "model.registered", "model.linked", "model.state_changed", "model.owner_changed",
    "production_topic.created", "production_topic.status_changed", "production_topic.message_added",
    "costing.version_created", "costing.finalized",
    "sample.created", "sample.submitted", "sample.reviewed", "sample.approved", "design_version.approved",
    "production_order.linked_design", "production_plan.overridden",
    "stock_receipt.linked_production", "return.disposition_set", "approval.executed", "recommendation.decided",
  ];
  assert.deepEqual([...ten].sort(), [...hopDong].sort(), "sổ khai phải đúng bằng bảng tên đã cấp ở shared-contracts.md mục 2");
  const migName = /"domain_events_name_check" CHECK \("name" ~ '([^']+)'\)/.exec(mig);
  assert.ok(migName && migName[1] === DOMAIN_EVENT_NAME_PATTERN.source, "biểu thức tên trong CHECK phải trùng DOMAIN_EVENT_NAME_PATTERN");
  for (const e of DOMAIN_EVENTS) {
    assert.match(e.name, DOMAIN_EVENT_NAME_PATTERN, `tên ${e.name} sai dạng`);
    assert.ok(e.why.trim().length > 15, `sự kiện ${e.name} phải nói vì sao tồn tại`);
    if (e.status === "LIVE") {
      assert.ok(e.emitter && existsSync(e.emitter), `sự kiện LIVE ${e.name} trỏ tệp phát "${e.emitter}" không tồn tại`);
      const src = readFileSync(e.emitter!, "utf8");
      assert.ok(src.includes(`"${e.name}"`) && src.includes("emitDomainEvent("), `tệp ${e.emitter} không phát ${e.name} — sổ khai đang nói sai`);
    } else {
      assert.equal(e.emitter, null, `sự kiện RESERVED ${e.name} không được khai tệp phát`);
    }
  }

  // ───────── 6. Quét mã nguồn: append-only · một đường ghi · không phát tên chưa khai · không vào webhook ─────────
  const tep = execSync("git ls-files lib app scripts components && git ls-files --others --exclude-standard lib app scripts components", { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx|mjs|js|sql)$/.test(f) && existsSync(f));
  assert.ok(tep.length > 200, `đọc hụt mã nguồn (chỉ thấy ${tep.length} tệp)`);
  const boChuThich = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/^\s*--.*$/gm, "");
  const BANG_BAT_BIEN = { productModelStateHistory: "product_model_state_history", domainEvents: "domain_events" } as const;
  const viPham: string[] = [];
  const ghiTrangThai: string[] = [];
  const phatSai: string[] = [];
  for (const f of tep) {
    const src = boChuThich(readFileSync(f, "utf8"));
    for (const [ts, sqlName] of Object.entries(BANG_BAT_BIEN)) {
      // Tên gọi thẳng + mọi bí danh `const x = schema.<bảng>`.
      const biDanh = [`schema.${ts}`, ...[...src.matchAll(new RegExp(`const (\\w+) = schema\\.${ts}\\b`, "g"))].map((m) => m[1])];
      for (const b of biDanh) {
        const esc = b.replace(/\./g, "\\.");
        if (new RegExp(`\\.(update|delete)\\(\\s*${esc}\\b`).test(src)) viPham.push(`${f}: .update/.delete(${b})`);
      }
      if (new RegExp(`\\b(update|delete\\s+from|truncate)\\s+"?${sqlName}\\b`, "i").test(src)) viPham.push(`${f}: SQL ghi đè ${sqlName}`);
    }
    if (f !== "lib/models/service.ts") {
      const biDanhMau = ["schema\\.productModels", ...[...src.matchAll(/const (\w+) = schema\.productModels\b/g)].map((m) => m[1])];
      if (biDanhMau.some((b) => new RegExp(`\\.(update|delete)\\(\\s*${b}\\b`).test(src)) || /\b(update|delete\s+from)\s+"?product_models\b/i.test(src)) ghiTrangThai.push(f);
    }
    if (/emitDomainEvent\(/.test(src) && !["lib/events/emit.ts"].includes(f)) {
      for (const m of src.matchAll(/name:\s*"([a-z_]+(?:\.[a-z_]+)+)"/g)) {
        const spec = DOMAIN_EVENT_BY_NAME[m[1]];
        if (!spec || spec.status !== "LIVE" || spec.emitter !== f) phatSai.push(`${f}: ${m[1]}`);
      }
    }
  }
  assert.deepEqual(viPham, [], "product_model_state_history và domain_events là APPEND-ONLY — không UPDATE / DELETE ở lib/app/scripts/components");
  assert.deepEqual(ghiTrangThai, [], "chỉ lib/models/service.ts được ghi product_models — mọi lượt đổi trạng thái đi qua transitionModelCore");
  assert.deepEqual(phatSai, [], "tệp phát một tên sự kiện chưa khai LIVE với đúng tệp này — sửa sổ khai lib/constants/domain-events.ts");
  // Q5 / luật 51: không phát sự kiện trong đường webhook / đồng bộ nóng.
  const nong = tep.filter((f) => (f.startsWith("lib/integrations/") || f.startsWith("app/api/webhooks/")) && /emitDomainEvent|@\/lib\/events\/emit/.test(readFileSync(f, "utf8")));
  assert.deepEqual(nong, [], "không phát sự kiện miền trong giao dịch webhook Pancake / Viettel Post hay job đồng bộ nóng (target-architecture Q5)");

  // ───────── 7. Kế hoạch đồng bộ sổ (hàm thuần) ─────────
  const sp = (id: string, customId: string | null, isRemoved = false): RegistryProduct => ({ id, name: `SP ${id}`, customId, isRemoved });
  const products = [sp("p1", "Q1"), sp("p2", "q 2"), sp("p3", " Q2"), sp("p4", "tk-990101-01"), sp("p5", ""), sp("p6", "Q6", true), sp("p7", "Q6"), sp("p8", null)];
  const designs = [{ id: "d1", code: "TK-990101-01" }, { id: "d2", code: "TK-990101-02" }];
  const ke = planModelRegistry({ products, designs, models: [] });
  assert.deepEqual(ke.ambiguous.map((a) => a.code), ["Q2"], "hai sản phẩm đang bán cùng mã Q2 ⇒ AMBIGUOUS");
  assert.deepEqual(ke.ambiguous[0].products.map((p) => p.id), ["p2", "p3"], "danh sách mơ hồ nêu đủ các sản phẩm để người chọn");
  assert.ok(!ke.toInsert.some((m) => m.code === "Q2"), "mã mơ hồ KHÔNG được đăng ký (luật 35)");
  const theoMa = new Map(ke.toInsert.map((m) => [m.code, m]));
  assert.deepEqual(theoMa.get("TK-990101-01"), { code: "TK-990101-01", name: "SP p4", productId: "p4", designConceptId: "d1" }, "thiết kế và sản phẩm cùng mã ⇒ MỘT mẫu nối cả hai");
  assert.deepEqual(theoMa.get("TK-990101-02"), { code: "TK-990101-02", name: "", productId: null, designConceptId: "d2" }, "thiết kế chưa lên Pancake vẫn là một mẫu");
  assert.equal(theoMa.get("Q6")?.productId, "p7", "một sản phẩm đã xoá + một đang bán cùng mã ⇒ nối sản phẩm đang bán, không mơ hồ");
  assert.deepEqual([...theoMa.keys()], ["Q1", "Q6", "TK-990101-01", "TK-990101-02"], "sản phẩm không có mã thì không đăng ký — không bịa mã từ tên");
  // Ổn định: đảo thứ tự đầu vào ra cùng kế hoạch.
  assert.deepEqual(planModelRegistry({ products: [...products].reverse(), designs: [...designs].reverse(), models: [] }), ke, "kế hoạch phải ổn định với thứ tự đầu vào");
  // Chạy lại sau khi áp ⇒ không còn gì.
  const daAp: RegistryModel[] = ke.toInsert.map((m, i) => ({ id: `m${i}`, code: m.code, name: m.name, productId: m.productId, designConceptId: m.designConceptId }));
  const lan2 = planModelRegistry({ products, designs, models: daAp });
  assert.equal(lan2.toInsert.length + lan2.toLink.length, 0, "chạy lại sau khi áp không được đẻ dòng / liên kết mới");
  // Mẫu người gõ trước (chưa có sản phẩm) ⇒ sản phẩm mang đúng mã xuất hiện thì NỐI, không đẻ mẫu thứ hai.
  const tay: RegistryModel = { id: "mu", code: "Q1", name: "", productId: null, designConceptId: null };
  const noi = planModelRegistry({ products: [sp("p1", "Q1")], designs: [], models: [tay] });
  assert.deepEqual(noi.toLink, [{ modelId: "mu", code: "Q1", productId: "p1", designConceptId: null, name: "SP p1" }]);
  assert.equal(noi.toInsert.length, 0);
  // Mẫu đã nối sản phẩm khác ⇒ không đổi liên kết, nêu ra để người xem.
  const lech = planModelRegistry({ products: [sp("p9", "Q1")], designs: [], models: [{ id: "mx", code: "Q1", name: "x", productId: "p-cu", designConceptId: null }] });
  assert.equal(lech.toLink.length, 0, "máy không bao giờ đổi một liên kết đã có");
  assert.equal(lech.ambiguous[0]?.modelId, "mx");

  console.log("✓ Company OS · sổ mẫu (thuần): 15 trạng thái khớp CHECK · cạnh tiến theo sơ đồ §3, lùi / nhảy / khai lần đầu bắt buộc lý do · sổ khai sự kiện nói thật · append-only · mã trùng ⇒ AMBIGUOUS · đồng bộ lũy đẳng");
}

const U = "cos-a-user";
const P = "cos-a-";

async function donDep(db: Db, giuLai: Set<string>) {
  const moi = (await db.select({ id: schema.productModels.id }).from(schema.productModels)).map((r) => r.id).filter((id) => !giuLai.has(id));
  if (moi.length) {
    await db.delete(schema.productModelStateHistory).where(inArray(schema.productModelStateHistory.modelId, moi));
    await db.delete(schema.domainEvents).where(inArray(schema.domainEvents.modelId, moi));
  }
  await db.delete(schema.domainEvents).where(sql`${schema.domainEvents.subjectId} like ${P + "%"} or ${schema.domainEvents.dedupeKey} like ${P + "%"}`);
  if (moi.length) await db.delete(schema.productModels).where(inArray(schema.productModels.id, moi));
  await db.delete(schema.productionOrders).where(sql`${schema.productionOrders.id} like ${P + "%"}`);
  await db.delete(schema.designConcepts).where(sql`${schema.designConcepts.id} like ${P + "%"}`);
  await db.delete(schema.products).where(sql`${schema.products.id} like ${P + "%"}`);
  await db.delete(schema.users).where(eq(schema.users.id, U));
}

export async function testCompanyOsModelsQueries(db: Db) {
  const giuLai = new Set((await db.select({ id: schema.productModels.id }).from(schema.productModels)).map((r) => r.id));
  await donDep(db, giuLai);
  try {
    await db.insert(schema.users).values({ id: U, email: "cos-a@test.local", name: "Người khai Kiểm", passwordHash: "x" });
    await db.insert(schema.products).values([
      { id: `${P}p1`, name: "Đầm COSA1", customId: "COSA1" },
      { id: `${P}p2`, name: "Áo COSA2 bản 1", customId: "COSA2" },
      { id: `${P}p3`, name: "Áo COSA2 bản 2", customId: " cosa2" },
      { id: `${P}p4`, name: "Váy thiết kế", customId: "tk-990101-01" },
    ]);
    await db.insert(schema.designConcepts).values({ id: `${P}d1`, code: "TK-990101-01", dna: {}, dnaVersion: 1, status: "TESTING" });

    // ═══ ĐỒNG BỘ SỔ ═══
    const lan1 = await syncModelRegistry(db, { triggeredBy: "test" });
    assert.deepEqual(lan1.failed, [], "đồng bộ không được lỗi");
    const mau = async (code: string) => (await db.select().from(schema.productModels).where(eq(schema.productModels.code, code)))[0];
    const m1 = await mau("COSA1");
    assert.ok(m1, "COSA1 phải vào sổ");
    assert.equal(m1.productId, `${P}p1`);
    assert.equal(m1.lifecycleState, null, "mẫu đồng bộ về ở trạng thái CHƯA KHAI — không backfill");
    assert.equal(m1.registeredBy, "SYNC");
    assert.equal(await mau("COSA2"), undefined, "hai sản phẩm cùng mã COSA2 ⇒ KHÔNG đăng ký");
    assert.ok(lan1.ambiguous.some((a) => a.code === "COSA2" && a.products.length === 2), "COSA2 phải nằm trong danh sách mơ hồ kèm hai sản phẩm");
    const mTk = await mau("TK-990101-01");
    assert.equal(mTk?.productId, `${P}p4`, "thiết kế + sản phẩm cùng mã ⇒ một mẫu nối sản phẩm");
    assert.equal(mTk?.designConceptId, `${P}d1`, "… và nối thiết kế");
    const ev1 = await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.modelId, m1.id), eq(schema.domainEvents.name, "model.registered")));
    assert.equal(ev1.length, 1, "đăng ký phát đúng một model.registered");
    assert.equal(ev1[0].actorKind, "SYSTEM", "đăng ký theo luật là việc của MÁY");
    assert.equal(ev1[0].dedupeKey, `model.registered:${m1.id}`);

    const demMau = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.productModels))[0].n);
    const demSuKien = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.domainEvents))[0].n);
    const [mauTruoc, suKienTruoc] = [await demMau(), await demSuKien()];
    const lan2 = await syncModelRegistry(db, { triggeredBy: "test" });
    assert.equal(lan2.inserted + lan2.linked, 0, "chạy lại không đăng ký / nối thêm gì");
    assert.equal(await demMau(), mauTruoc, "chạy lại không đẻ mẫu mới");
    assert.equal(await demSuKien(), suKienTruoc, "chạy lại không đẻ sự kiện mới");
    const xem = await previewModelRegistry();
    assert.equal(xem.pendingInsert + xem.pendingLink, 0, "xem trước sau đồng bộ: không còn gì chờ");
    assert.ok(xem.ambiguous.some((a) => a.code === "COSA2"), "mã mơ hồ vẫn hiện ở bản xem trước (tính lúc đọc)");

    // ═══ SỔ SỰ KIỆN ═══
    const khoa = `${P}dedupe-1`;
    const e1 = await emitDomainEvent(db, { name: "model.owner_changed", subjectType: MODEL_SUBJECT, subjectId: m1.id, modelId: m1.id, actorKind: "SYSTEM", source: "test", dedupeKey: khoa });
    const e2 = await emitDomainEvent(db, { name: "model.owner_changed", subjectType: MODEL_SUBJECT, subjectId: m1.id, modelId: m1.id, actorKind: "SYSTEM", source: "test", dedupeKey: khoa });
    assert.ok(e1, "lần phát đầu trả id");
    assert.equal(e2, null, "trùng dedupe_key ⇒ DO NOTHING, trả null");
    assert.equal((await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.dedupeKey, khoa))).length, 1, "trùng khoá chỉ có MỘT dòng");
    await assert.rejects(emitDomainEvent(db, { name: "model.khong_co" as DomainEventName, subjectType: MODEL_SUBJECT, subjectId: m1.id, actorKind: "SYSTEM", source: "test" }), /chưa khai/, "tên chưa khai phải ném lỗi");
    await assert.rejects(emitDomainEvent(db, { name: "model.linked", subjectType: "order", subjectId: m1.id, actorKind: "SYSTEM", source: "test" }), /subject/, "subject khác sổ khai phải ném lỗi");
    await assert.rejects(
      db.insert(schema.domainEvents).values({ name: "model.linked", subjectType: MODEL_SUBJECT, subjectId: m1.id, actorKind: "USER", actorId: null, source: "test", occurredAt: new Date() }),
      "CHECK: sự kiện của người mà không có khoá tài khoản bị CSDL từ chối",
    );
    await assert.rejects(
      db.insert(schema.domainEvents).values({ name: "Model-Linked", subjectType: MODEL_SUBJECT, subjectId: m1.id, actorKind: "SYSTEM", source: "test", occurredAt: new Date() }),
      "CHECK: tên sai dạng bị CSDL từ chối",
    );

    // ═══ CHUYỂN TRẠNG THÁI ═══
    const nguoi = { id: U, label: "Người khai Kiểm" };
    const chuyen = (to: ModelState, reason?: string, extra: Partial<Parameters<typeof transitionModelCore>[1]> = {}) =>
      transitionModelCore(db, { modelId: m1.id, to, reason, actor: nguoi, actorKind: "USER", source: "test", ...extra });
    const khongLyDo = await chuyen("SELLING");
    assert.ok("error" in khongLyDo && khongLyDo.error.includes(String(MODEL_REASON_MIN_LENGTH)), "khai lần đầu mà không lý do ⇒ bị chặn");
    const r1 = await chuyen("SELLING", "Mẫu đang bán ổn định trên Pancake từ trước khi có sổ");
    assert.ok("ok" in r1 && r1.from === null && r1.to === "SELLING");
    const lichSu = await db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, m1.id));
    assert.equal(lichSu.length, 1, "một lượt chuyển = đúng một dòng lịch sử");
    assert.equal(lichSu[0].fromState, null);
    assert.equal(lichSu[0].actorId, U, "lịch sử mang khoá tài khoản (mục 34)");
    const evChuyen = await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.modelId, m1.id), eq(schema.domainEvents.name, "model.state_changed")));
    assert.equal(evChuyen.length, 1, "một lượt chuyển = đúng một model.state_changed");
    assert.equal((evChuyen[0].payload as Record<string, unknown>).historyId, lichSu[0].id, "sự kiện trỏ về dòng lịch sử của chính nó");
    assert.equal((await mau("COSA1")).lifecycleState, "SELLING");
    const r2 = await chuyen("CLEARANCE");
    assert.ok("ok" in r2, "cạnh tiến SELLING → CLEARANCE không cần lý do");
    const lui = await chuyen("SELLING");
    assert.ok("error" in lui, "lùi CLEARANCE → SELLING mà không lý do ⇒ bị chặn");
    assert.ok("ok" in (await chuyen("SELLING", "Khách hỏi lại nhiều, dừng xả tồn")), "có lý do thì lùi được");
    assert.ok("error" in (await chuyen("SELLING", "trùng")), "chuyển sang chính trạng thái hiện tại là lỗi");
    const khongKhoa = await transitionModelCore(db, { modelId: m1.id, to: "CLEARANCE", actor: { id: null, label: "ai đó" }, actorKind: "USER", source: "test" });
    assert.ok("error" in khongKhoa, "người làm mà không có khoá tài khoản ⇒ lõi dịch vụ chặn");
    await assert.rejects(
      db.insert(schema.productModelStateHistory).values({ modelId: m1.id, fromState: null, toState: "IDEA", actorKind: "USER", actorId: null, reason: "x", source: "test" }),
      "CHECK: lịch sử của người mà không có khoá tài khoản bị CSDL từ chối",
    );

    // MỘT giao dịch: dòng lịch sử hỏng (khoá ngoại sự kiện không tồn tại) ⇒ UPDATE trạng thái cũng lùi lại.
    const soLichSu = (await db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, m1.id))).length;
    await assert.rejects(chuyen("CLEARANCE", undefined, { sourceEventId: `${P}khong-ton-tai` }), "khoá ngoại hỏng giữa chừng phải ném");
    assert.equal((await mau("COSA1")).lifecycleState, "SELLING", "UPDATE trạng thái phải lùi cùng giao dịch khi ghi lịch sử hỏng");
    assert.equal((await db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, m1.id))).length, soLichSu, "không dòng lịch sử nào sót lại");

    // Máy chuyển theo một sự kiện gửi lại ⇒ không ghi lượt thứ hai.
    const may = { actor: { id: null, label: "job:test" }, actorKind: "SYSTEM" as const, sourceEventId: e1! };
    const lanA = await chuyen("CLEARANCE", undefined, may);
    const lanB = await chuyen("CLEARANCE", undefined, may);
    assert.ok("ok" in lanA && !lanA.replayed && "ok" in lanB && lanB.replayed, "sự kiện gây ra gửi lại ⇒ lượt thứ hai là phát lại, không ghi");
    assert.equal((await db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.sourceEventId, e1!))).length, 1);

    // ═══ NGƯỜI PHỤ TRÁCH ═══
    const o1 = await setModelOwnerCore(db, { modelId: m1.id, ownerUserId: U, actor: nguoi, actorKind: "USER", source: "test" });
    const o2 = await setModelOwnerCore(db, { modelId: m1.id, ownerUserId: U, actor: nguoi, actorKind: "USER", source: "test" });
    assert.ok("ok" in o1 && o1.changed && "ok" in o2 && !o2.changed, "đặt lại cùng người không ghi gì");
    assert.equal((await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.modelId, m1.id), eq(schema.domainEvents.name, "model.owner_changed"), sql`${schema.domainEvents.dedupeKey} is null`))).length, 1);

    // ═══ MẪU NGƯỜI GÕ ═══
    const reg = await registerModelCore(db, { code: " cosa 9 ", name: "Ý tưởng", actor: nguoi, source: "test" });
    assert.ok("ok" in reg && reg.code === "COSA9");
    const m9 = await mau("COSA9");
    assert.equal(m9.lifecycleState, "IDEA");
    assert.equal(m9.registeredBy, "USER");
    const ls9 = await db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, m9.id));
    assert.deepEqual(ls9.map((h) => [h.fromState, h.toState, h.reason]), [[null, "IDEA", REGISTER_REASON]]);
    assert.ok("error" in (await registerModelCore(db, { code: "COSA9", actor: nguoi, source: "test" })), "mã đã có trong sổ ⇒ từ chối");
    assert.ok("error" in (await registerModelCore(db, { code: "cosa2", actor: nguoi, source: "test" })), "mã đã là sản phẩm Pancake ⇒ chỉ sang nút đồng bộ, không đăng ký tay");
    assert.ok("error" in (await registerModelCore(db, { code: "COSA10", actor: { id: null, label: "máy" }, source: "test" })), "đăng ký tay mà không có khoá tài khoản ⇒ chặn");

    // ═══ DÒNG THỜI GIAN: CHIẾU, KHÔNG CHÉP ═══
    await db.insert(schema.productionOrders).values({ id: `${P}po1`, code: `${P}PO1`, productId: `${P}p1`, status: "SENT", totalQty: 120, sentAt: new Date() });
    const tl = await getModelTimeline(m1.id);
    assert.ok(tl.some((e) => e.dimension === "PRODUCTION" && e.basis === "PROJECTED" && e.title.includes(`${P}PO1`)), "lệnh sản xuất của sản phẩm hiện trên dòng thời gian mẫu");
    assert.ok(tl.some((e) => e.dimension === "LIFECYCLE" && e.basis === "RECORDED"), "sự kiện của sổ mẫu hiện trên dòng thời gian");
    assert.equal((await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.subjectType, "production_order"))).length, 0, "dòng thời gian KHÔNG chép nhật ký miền khác vào domain_events (Q5)");
    for (let i = 1; i < tl.length; i++) assert.ok(tl[i - 1].at.getTime() >= tl[i].at.getTime(), "mới nhất lên trước");

    // ═══ CHỨNG CỨ: chưa có sản phẩm ⇒ CHƯA BIẾT, không phải 0 ═══
    const chiTiet9 = await getModel(m9.id);
    const ck9 = await getModelEvidence(chiTiet9!);
    assert.equal(ck9.orders30d, null, "mẫu chưa có sản phẩm: số đơn là CHƯA BIẾT, không phải 0");
    assert.equal(ck9.adSpend30d, null);
    assert.equal(observeModelStage(ck9).stage, null);
    const ck1 = await getModelEvidence((await getModel(m1.id))!);
    assert.equal(ck1.sentProductionOrders, 1, "lệnh đã gửi xưởng được đếm");
    assert.equal(ck1.stockKnown, false, "sản phẩm chưa có phiếu nhập ⇒ tồn CHƯA BIẾT");
    assert.equal(observeModelStage(ck1).stage, "IN_PRODUCTION");
    const ckTk = await getModelEvidence((await getModel(mTk!.id))!);
    assert.equal(ckTk.designStatus, "TESTING");

    console.log("✓ Company OS · sổ mẫu (CSDL): đồng bộ lũy đẳng, mã trùng không vào sổ · chuyển trạng thái một giao dịch (lịch sử + sự kiện) · lý do bắt buộc · khoá tài khoản chặn ở lõi và CHECK · sự kiện chống trùng · dòng thời gian chiếu, không chép");
  } finally {
    await donDep(db, giuLai);
  }
}
