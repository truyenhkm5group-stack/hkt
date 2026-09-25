import assert from "node:assert/strict";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { consumeApprovedRequest, decideApprovalCore, guardSecondApprovalCore, approvalFingerprint, setEnforceGroupCore, readEnforceConfig } from "@/lib/approvals/service";
import { can } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { APPROVAL_ENFORCE_KEY, isEnforced } from "@/lib/constants/approval";
import { maxAdCostPerOrder } from "@/lib/constants/break-even-cpo";
import { DOMAIN_EVENT_LABEL, DOMAIN_EVENTS } from "@/lib/constants/domain-events";
import { MODEL_STATES, type ModelState } from "@/lib/constants/model-lifecycle";
import { buildTopicEvidenceSnapshot, checkSendWithoutDesign, REQUIRE_APPROVED_DESIGN_KEY, type SuggestedCellsSnapshot } from "@/lib/constants/production-os";
import { WORK_SOURCE_SPEC } from "@/lib/constants/work-sources";
import { vnDateKey, vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { deleteStockReceiptCore, type ReceiptDeleteGate } from "@/lib/inventory/receipt-delete";
import { validateProductionLink } from "@/lib/inventory/production-link";
import { mapProduct } from "@/lib/integrations/pancake/mapper";
import { upsertProduct } from "@/lib/integrations/pancake/sync";
import { normalizeTracking } from "@/lib/integrations/viettelpost/client";
import { applyStatementDetailRows } from "@/lib/integrations/viettelpost/statement-db";
import { applyVtpTracking } from "@/lib/integrations/viettelpost/sync";
import { setModelOwnerCore, syncModelRegistry, transitionModelCore } from "@/lib/models/service";
import { createCostSheetCore, finalizeCostSheetCore, updateCostSheetDraftCore } from "@/lib/production/costing";
import { savePoPlanCore } from "@/lib/production/orders";
import { createSampleCore, reviewSampleCore, submitSampleCore } from "@/lib/production/samples";
import { addTopicMessageCore, createTopicCore, setTopicStatusCore } from "@/lib/production/topics";
import { getModelAdsSummary, modelCreativeSummary } from "@/lib/queries/model-ads";
import { getModelEconomics } from "@/lib/queries/model-economics";
import { getModelProductionSummary } from "@/lib/queries/model-production";
import { getModelReturnDispositions } from "@/lib/queries/model-returns";
import { getModelStockStates, type ModelStockStates } from "@/lib/queries/model-stock";
import { domainEventDimension, getModel, getModelEvidence, getModelTimeline } from "@/lib/queries/models";
import { variantMetrics } from "@/lib/queries/creative-loop";
import { buildMatrixForProduct } from "@/lib/queries/production";
import { requireApprovedDesignFlag } from "@/lib/queries/production-os";
import { ORDER_OUTCOME, ORDER_OUTCOME_VERIFIED } from "@/lib/queries/return-rate";
import { adaptProductionTopics, adaptReturnDispositions, adaptSampleReviews, collectWorkItems } from "@/lib/queries/work-adapters";
import { setReturnDispositionCore, type DispositionGate } from "@/lib/returns/disposition";
import { markReturnsArrived, recordItemInspection } from "@/lib/returns/inspection";
import { setSettingJson } from "@/lib/settings";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ COMPANY OS · QA — MỘT MẪU ĐI HẾT VÒNG ĐỜI (E2E trên PGlite) ═══════════
 *
 * Bài này KHÔNG kiểm lại luật của từng agent (mỗi agent đã có bài riêng) — nó kiểm CHỖ NỐI: một mẫu
 * duy nhất `COSQA-01` đi qua mười một bước, và ở mỗi bước con số của miền sau phải khớp với việc miền
 * trước vừa làm. Đường ghi là LÕI DỊCH VỤ THẬT (không phải server action — những hàm đó cần phiên đăng
 * nhập); chỉ những thứ ở production đến từ BÊN NGOÀI mới được chèn thẳng, và khi có hàm nạp chạy được
 * không mạng thì dùng hàm nạp:
 *
 *  · sản phẩm Pancake        → `mapProduct` + `upsertProduct` (đường đồng bộ thật);
 *  · sự kiện Viettel Post     → `normalizeTracking` + `applyVtpTracking` (đường webhook thật);
 *  · bảng kê COD             → `applyStatementDetailRows` (đường nhập bảng kê thật);
 *  · đơn Pancake / chi QC Facebook / mẩu QC / creative đã đăng → chèn thẳng (không có hàm nạp offline
 *    nhận một đơn lẻ mà không kéo theo cả gói tin Pancake).
 *  · Ba thao tác của NGƯỜI không có lõi tách khỏi server action: lập lệnh SX (`saveProductionOrder`),
 *    đổi trạng thái lệnh (`setProductionStatus`), lập phiếu kho (`createStockReceipt`). Bài dựng lại đúng
 *    phần kiểm của chúng bằng CHÍNH các hàm chúng gọi (`checkSendWithoutDesign` + `requireApprovedDesignFlag`,
 *    `validateProductionLink`) rồi ghi như action ghi — và nói ra ở bàn giao QA.
 *
 * ĐỒNG HỒ (luật 50, 65): lõi phát sự kiện miền bằng ĐỒNG HỒ THẬT (`emitDomainEvent` mặc định `new Date()`),
 * nên mọi mốc do bài gieo cũng đi theo đồng hồ thật, lấy TẠI BƯỚC gieo (`tick()` đơn điệu) — không mốc
 * tuyệt đối nào, không cửa sổ "N giờ trước" nào trỏ vào dữ liệu ngày cố định. Kỳ báo cáo dựng từ chính
 * ngày chạy (hôm qua → ngày mai theo giờ VN) nên bao trọn mọi mốc đã gieo.
 *
 * DỌN: mọi dòng mang tiền tố `cosqa-` / mã `COSQA` bị xoá ở `finally`, kể cả bảng append-only
 * (`domain_events`, `product_model_state_history`, `return_dispositions`, `sample_reviews`,
 * `production_topic_messages` — CSDL kiểm thử là dùng một lần; append-only được khoá bằng quét mã nguồn,
 * không bằng trigger). Ngoại lệ đã biết: `vtp_status_registry` là sổ đếm theo (mã, chữ) dùng chung — lượt
 * webhook của bài chỉ cộng thêm số lần quan sát của mã đã có, không có dòng nào mang tiền tố để xoá.
 */

const P = "cosqa-";
const CODE = "COSQA-01";
const PRODUCT = `${P}prod-01`;
const V_M = `${P}var-m`;
const V_L = `${P}var-l`;
const AD = `${P}ad-1`;
const POST = "992300000001";
const PAGE = "992399";
const BANG_KE = `${P}bang-ke.xlsx`;
const TRACK = { o1: "COSQA001", o2: "COSQA002", o3: "COSQA003" } as const;

const U = {
  owner: `${P}owner`,
  mkt: `${P}mkt`,
  lead: `${P}lead`,
  mgr: `${P}mgr`,
  kho: `${P}kho`,
} as const;

const actorOf = (id: string, label: string) => ({ id, label });
const OWNER = actorOf(U.owner, "Chủ shop QA");
const MKT = actorOf(U.mkt, "Marketer QA");
const LEAD = actorOf(U.lead, "Trưởng nhóm SX QA");
const MGR = actorOf(U.mgr, "Quản lý QA");
const KHO = actorOf(U.kho, "Kho QA");

/** Mốc đồng hồ thật, ĐƠN ĐIỆU (không bao giờ trùng mili giây với mốc trước do bài gieo). */
let lastTick = 0;
function tick(): Date {
  const t = Math.max(Date.now(), lastTick + 1);
  lastTick = t;
  return new Date(t);
}

/** "dd/MM/yyyy HH:mm:ss" giờ VN — đúng định dạng ORDER_STATUSDATE của webhook Viettel Post. */
function vnStamp(d: Date): string {
  const v = new Date(d.getTime() + 7 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(v.getUTCDate())}/${p(v.getUTCMonth() + 1)}/${v.getUTCFullYear()} ${p(v.getUTCHours())}:${p(v.getUTCMinutes())}:${p(v.getUTCSeconds())}`;
}

/** Mốc ĐVVC tính theo GIÂY (webhook không mang mili giây): làm tròn LÊN giây kế tiếp + `plusSec`. */
function carrierAt(after: Date, plusSec: number): Date {
  return new Date((Math.floor(after.getTime() / 1000) + 1 + plusSec) * 1000);
}

async function vtpWebhook(code: string, status: number, statusName: string, at: Date, extra: Record<string, unknown> = {}) {
  const record = normalizeTracking({ ORDER_NUMBER: code, ORDER_STATUS: status, STATUS_NAME: statusName, ORDER_STATUSDATE: vnStamp(at), ...extra });
  const r = await applyVtpTracking(record, "VTP_WEBHOOK");
  assert.ok(r, `webhook ${code}/${status} phải ghép được vào vận đơn đã có (đường webhook thật)`);
  return r;
}

async function outcomeOf(db: Db, orderId: string) {
  const [r] = await db
    .select({ v: ORDER_OUTCOME, verified: ORDER_OUTCOME_VERIFIED })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(eq(schema.orders.id, orderId));
  return r;
}

function variantOf(s: ModelStockStates, variantId: string) {
  const v = s.variants.find((x) => x.variantId === variantId);
  assert.ok(v, `tồn theo mẫu phải có dòng cho ${variantId}`);
  return v;
}

/** Bốn ô tồn của MỘT mẫu mã, gọn để so bằng deepEqual. */
function stockCells(s: ModelStockStates, variantId: string) {
  const v = variantOf(s, variantId);
  return { stockKnown: v.stockKnown, actual: v.actualStock, available: v.available, reserved: v.reserved, returning: v.returning, pendingQc: v.pendingQc, damaged: v.damaged };
}

type Saved = { enforce: string | null; requireDesign: string | null };

async function readSetting(db: Db, key: string): Promise<string | null> {
  const [r] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key));
  return r ? r.value : null;
}

async function restoreSetting(db: Db, key: string, value: string | null) {
  await db.delete(schema.settings).where(eq(schema.settings.key, key));
  if (value !== null) await db.insert(schema.settings).values({ key, value });
}

/** Dọn MỌI thứ bài này (và lượt đồng bộ sổ mẫu của nó) sinh ra. `keepModels` = mẫu đã có TRƯỚC bài. */
async function donDep(db: Db, keepModels: Set<string>) {
  const newModels = (await db.select({ id: schema.productModels.id }).from(schema.productModels)).map((r) => r.id).filter((id) => !keepModels.has(id));
  const ourModels = (await db.select({ id: schema.productModels.id }).from(schema.productModels).where(eq(schema.productModels.code, CODE))).map((r) => r.id);
  const models = [...new Set([...newModels, ...ourModels])];

  // Hàng hoàn: sổ kết cục (RESTRICT tới phiếu kiểm / phiếu kho) trước, rồi phiếu kho của lượt nhập lại.
  const shipIds = (await db.select({ id: schema.shipments.id }).from(schema.shipments).where(like(schema.shipments.id, `${P}%`))).map((r) => r.id);
  const insIds = shipIds.length ? (await db.select({ id: schema.returnInspections.id }).from(schema.returnInspections).where(inArray(schema.returnInspections.shipmentId, shipIds))).map((r) => r.id) : [];
  if (insIds.length) await db.delete(schema.returnDispositions).where(inArray(schema.returnDispositions.inspectionId, insIds));

  // Lệnh SX trỏ bản thiết kế (RESTRICT) ⇒ xoá lệnh trước bảng của Agent C.
  await db.delete(schema.productionOrders).where(like(schema.productionOrders.id, `${P}%`));
  const receiptIds = (
    await db
      .select({ id: schema.stockReceiptItems.receiptId })
      .from(schema.stockReceiptItems)
      .where(or(inArray(schema.stockReceiptItems.variantId, [V_M, V_L]), like(schema.stockReceiptItems.shipmentId, `${P}%`)))
  ).map((r) => r.id);
  if (receiptIds.length) {
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, receiptIds));
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, receiptIds));
  }

  if (models.length) {
    await db.delete(schema.designVersions).where(inArray(schema.designVersions.modelId, models));
    const sampleIds = (await db.select({ id: schema.samples.id }).from(schema.samples).where(inArray(schema.samples.modelId, models))).map((r) => r.id);
    if (sampleIds.length) await db.delete(schema.sampleReviews).where(inArray(schema.sampleReviews.sampleId, sampleIds));
    await db.delete(schema.samples).where(inArray(schema.samples.modelId, models));
    const sheetIds = (await db.select({ id: schema.costSheets.id }).from(schema.costSheets).where(inArray(schema.costSheets.modelId, models))).map((r) => r.id);
    if (sheetIds.length) await db.delete(schema.costSheetLines).where(inArray(schema.costSheetLines.costSheetId, sheetIds));
    await db.delete(schema.costSheets).where(inArray(schema.costSheets.modelId, models));
    const topicIds = (await db.select({ id: schema.productionTopics.id }).from(schema.productionTopics).where(inArray(schema.productionTopics.modelId, models))).map((r) => r.id);
    if (topicIds.length) await db.delete(schema.productionTopicMessages).where(inArray(schema.productionTopicMessages.topicId, topicIds));
    await db.delete(schema.productionTopics).where(inArray(schema.productionTopics.modelId, models));
    await db.delete(schema.productModelStateHistory).where(inArray(schema.productModelStateHistory.modelId, models));
    await db.delete(schema.domainEvents).where(inArray(schema.domainEvents.modelId, models));
  }
  if (insIds.length) await db.delete(schema.domainEvents).where(inArray(schema.domainEvents.subjectId, insIds));

  await db.delete(schema.codStatementLines).where(or(eq(schema.codStatementLines.sourceFile, BANG_KE), inArray(schema.codStatementLines.trackingCode, Object.values(TRACK))));
  if (shipIds.length) await db.delete(schema.shipments).where(inArray(schema.shipments.id, shipIds));
  const orderIds = (await db.select({ id: schema.orders.id }).from(schema.orders).where(like(schema.orders.id, `${P}%`))).map((r) => r.id);
  if (orderIds.length) {
    await db.delete(schema.shipments).where(inArray(schema.shipments.orderId, orderIds));
    await db.delete(schema.canonicalOrderOutcome).where(inArray(schema.canonicalOrderOutcome.orderId, orderIds));
    await db.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, orderIds));
  }

  const variantIds = (await db.select({ id: schema.creativeVariants.id }).from(schema.creativeVariants).where(like(schema.creativeVariants.id, `${P}%`))).map((r) => r.id);
  if (variantIds.length) {
    await db.delete(schema.creativeVerdicts).where(inArray(schema.creativeVerdicts.variantId, variantIds));
    await db.delete(schema.creativeVariants).where(inArray(schema.creativeVariants.id, variantIds));
  }
  await db.delete(schema.creativeBatches).where(like(schema.creativeBatches.id, `${P}%`));
  await db.delete(schema.adSpends).where(or(like(schema.adSpends.createdBy, `${P}%`), eq(schema.adSpends.adId, AD)));
  await db.delete(schema.fbAds).where(like(schema.fbAds.id, `${P}%`));

  if (models.length) await db.delete(schema.productModels).where(inArray(schema.productModels.id, models));
  await db.delete(schema.productVariants).where(eq(schema.productVariants.productId, PRODUCT));
  await db.delete(schema.products).where(eq(schema.products.id, PRODUCT));
  await db.delete(schema.suppliers).where(like(schema.suppliers.name, `${P}%`));

  await db.delete(schema.approvalRequests).where(like(schema.approvalRequests.requestedByEmail, `${P}%`));
  await db.delete(schema.auditLogs).where(like(schema.auditLogs.userEmail, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
  clearMemo();
}

/**
 * Khoá mức đơn vị cho hai lỗi bài E2E tìm ra ở dòng thời gian mẫu (không cần CSDL):
 *  1. Mọi sự kiện LIVE phải có nhãn tiếng Việt — `return.disposition_set` (Agent E) đã LIVE mà thiếu nhãn.
 *  2. Chiều của sự kiện đi theo `subjectType` đã khai — trước đây mọi sự kiện bị gán "Vòng đời".
 */
export function testCompanyOsE2ePure() {
  const live = DOMAIN_EVENTS.filter((e) => e.status === "LIVE");
  const thieuNhan = live.filter((e) => !DOMAIN_EVENT_LABEL[e.name]).map((e) => e.name);
  assert.deepEqual(thieuNhan, [], "sự kiện LIVE nào cũng phải có nhãn cho dòng thời gian mẫu");
  const chieu = Object.fromEntries(live.map((e) => [e.name, domainEventDimension(e.name)]));
  for (const e of live) {
    const mongDoi = e.subjectType === "product_model" ? "LIFECYCLE" : e.subjectType === "return_inspection" ? "INVENTORY" : "PRODUCTION";
    assert.equal(chieu[e.name], mongDoi, `${e.name} (${e.subjectType}) phải ở chiều ${mongDoi}`);
  }
  assert.equal(domainEventDimension("khong.co"), "LIFECYCLE", "tên lạ ⇒ chiều Vòng đời như cũ, không ném");
  console.log(`✓ Company OS · QA (thuần): ${live.length} sự kiện LIVE đều có nhãn; chiều dòng thời gian theo subject (Vòng đời / Sản xuất / Kho)`);
}

export async function testCompanyOsE2eLifecycle(db: Db) {
  const keepModels = new Set((await db.select({ id: schema.productModels.id }).from(schema.productModels)).map((r) => r.id));
  const saved: Saved = { enforce: await readSetting(db, APPROVAL_ENFORCE_KEY), requireDesign: await readSetting(db, REQUIRE_APPROVED_DESIGN_KEY) };
  await donDep(db, keepModels);
  // Cờ bắt buộc bản duyệt phải TẮT khi bắt đầu (mặc định của production) — bước 4 tự bật rồi trả lại.
  await db.delete(schema.settings).where(eq(schema.settings.key, REQUIRE_APPROVED_DESIGN_KEY));
  try {
    await chay(db, keepModels);
  } finally {
    await donDep(db, keepModels);
    await restoreSetting(db, APPROVAL_ENFORCE_KEY, saved.enforce);
    await restoreSetting(db, REQUIRE_APPROVED_DESIGN_KEY, saved.requireDesign);
    clearMemo();
  }
  // Dọn xong thì không còn dấu vết nào của mẫu.
  const [{ n: conLai }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.productModels).where(eq(schema.productModels.code, CODE));
  assert.equal(Number(conLai), 0, "dọn xong: mẫu COSQA-01 không còn trong sổ");
}

async function chay(db: Db, keepModels: Set<string>) {
  const T0 = tick();
  const todayKey = vnDateKey(T0);
  const dayMs = 86_400_000;
  const yesterdayKey = vnDateKey(new Date(T0.getTime() - dayMs));
  const tomorrowKey = vnDateKey(new Date(T0.getTime() + dayMs));
  const period: Period = { key: "custom", from: vnStartOfDay(yesterdayKey), to: vnEndOfDay(tomorrowKey), label: `${yesterdayKey} → ${tomorrowKey}`, fromKey: yesterdayKey, toKey: tomorrowKey };

  await db.insert(schema.users).values([
    { id: U.owner, email: `${U.owner}@t.local`, name: OWNER.label, role: "ADMIN", passwordHash: "x", active: true },
    { id: U.mkt, email: `${U.mkt}@t.local`, name: MKT.label, role: "MARKETING", passwordHash: "x", active: true },
    { id: U.lead, email: `${U.lead}@t.local`, name: LEAD.label, role: "LEADER", passwordHash: "x", active: true },
    { id: U.mgr, email: `${U.mgr}@t.local`, name: MGR.label, role: "MANAGER", passwordHash: "x", active: true },
    { id: U.kho, email: `${U.kho}@t.local`, name: KHO.label, role: "WAREHOUSE", passwordHash: "x", active: true },
  ]);
  // Quyền đọc từ CHÍNH bộ tính quyền của ERP — lõi nhận `canApprove` / `canDecide` như action truyền vào.
  const leadCanApprove = can("LEADER", "production:approve");
  const mgrCanApprove = can("MANAGER", "production:approve");
  assert.equal(leadCanApprove, false, "tiền đề: LEADER không có production:approve");
  assert.equal(mgrCanApprove, true, "tiền đề: MANAGER có production:approve");
  assert.equal(can("MANAGER", "approvals:decide"), true, "tiền đề: MANAGER duyệt được yêu cầu hai bước");

  /* ═══════════ BƯỚC 1 · PANCAKE → SỔ MẪU → NGƯỜI KHAI ADS_TESTING ═══════════ */
  const variation = (id: string, sku: string, size: string) => ({
    id,
    product_id: PRODUCT,
    display_id: sku,
    barcode: sku,
    fields: [
      { name: "Màu", value: "Đen" },
      { name: "Size", value: size },
    ],
    images: [],
    retail_price: 350_000,
    retail_price_after_discount: 350_000,
    last_imported_price: 0,
    average_imported_price: 0,
    is_removed: false,
    inserted_at: T0.toISOString().slice(0, 19),
  });
  const mapped = mapProduct({ id: PRODUCT, custom_id: CODE, display_id: 9923, name: "Đầm QA COSQA-01", inserted_at: T0.toISOString().slice(0, 19), variations: [variation(V_M, "COSQA-01-M", "M"), variation(V_L, "COSQA-01-L", "L")] });
  assert.ok(mapped, "sản phẩm Pancake phải map được");
  assert.deepEqual(mapped.variants.map((v) => [v.id, v.color, v.size]), [[V_M, "Đen", "M"], [V_L, "Đen", "L"]], "màu/size đọc từ trường thuộc tính của Pancake");
  await upsertProduct(mapped, db);

  const dong1 = await syncModelRegistry(db, { triggeredBy: `${P}test` });
  assert.deepEqual(dong1.failed, [], "đồng bộ sổ mẫu không lỗi");
  const models = await db.select().from(schema.productModels).where(eq(schema.productModels.code, CODE));
  assert.equal(models.length, 1, "đúng MỘT mẫu cho mã COSQA-01");
  const model = models[0];
  const M = model.id;
  assert.equal(model.productId, PRODUCT, "mẫu nối đúng sản phẩm Pancake");
  assert.equal(model.lifecycleState, null, "mẫu đồng bộ về ở trạng thái CHƯA KHAI (NULL), không backfill");
  assert.equal(model.registeredBy, "SYNC");
  const lan2 = await syncModelRegistry(db, { triggeredBy: `${P}test` });
  assert.equal(lan2.inserted + lan2.linked, 0, "đồng bộ lại không đăng ký / nối thêm gì");

  assert.ok("error" in (await transitionModelCore(db, { modelId: M, to: "ADS_TESTING", reason: "", actor: MKT, actorKind: "USER", source: "ui:/models" })), "khai lần đầu từ NULL mà không lý do ⇒ bị chặn");
  const khai = await transitionModelCore(db, { modelId: M, to: "ADS_TESTING", reason: "Mẫu mới lên kệ, bắt đầu chạy test quảng cáo", actor: MKT, actorKind: "USER", source: "ui:/models" });
  assert.ok("ok" in khai && khai.from === null && khai.to === "ADS_TESTING");
  const doiNguoi = await setModelOwnerCore(db, { modelId: M, ownerUserId: U.mkt, actor: OWNER, actorKind: "USER", source: "ui:/models" });
  assert.ok("ok" in doiNguoi && doiNguoi.changed, "chủ shop giao mẫu cho marketer");
  console.log("  ✓ QA-1 · Pancake → sổ mẫu: một mẫu COSQA-01, CHƯA KHAI, người khai ADS_TESTING có lý do");

  /* ═══════════ BƯỚC 2 · CREATIVE ↔ QUẢNG CÁO ↔ ĐƠN ═══════════ */
  const batchStart = vnStartOfDay(yesterdayKey);
  await db.insert(schema.creativeBatches).values({
    id: `${P}batch`,
    batchDay: yesterdayKey,
    status: "PUBLISHED",
    slotCount: 1,
    startAt: batchStart,
    endAt: vnEndOfDay(tomorrowKey),
    approvalDeadline: new Date(batchStart.getTime() - 1_800_000),
    configSnapshot: {},
    ruleVersion: 1,
    approvedAt: new Date(batchStart.getTime() - 3_600_000),
    approvalDigest: `${P}digest`,
  });
  await db.insert(schema.creativeVariants).values({ id: `${P}cv-1`, batchId: `${P}batch`, slot: 1, mode: "EXPLORE", productId: PRODUCT, status: "LIVE", genes: {}, genesVersion: 1, fbAdId: AD, headline: "Đầm QA" });
  await db.insert(schema.fbAds).values({ id: AD, campaignId: `${P}camp`, adsetId: `${P}adset`, postId: POST });
  // Chi QC Facebook ở hạt MẨU, ghép về mã (đồng bộ Facebook ở production).
  await db.insert(schema.adSpends).values({ platform: "FACEBOOK", campaign: `${P}camp`, campaignId: `${P}camp`, adsetId: `${P}adset`, adId: AD, accountId: `${P}acc`, grain: "AD", spend: 200_000, messages: 8, spendDate: vnStartOfDay(todayKey), productId: PRODUCT, createdBy: `${P}fb-sync` });

  const donHang = (id: string, extra: Partial<typeof schema.orders.$inferInsert>) => {
    const at = tick();
    return { id: `${P}${id}`, stage: "CONFIRMED" as const, status: 1, prepaid: 0, insertedAt: at, updatedAt: at, pageId: PAGE, ...extra };
  };
  const dongHang = (orderId: string, lineId: string, variantId: string, sku: string, quantity = 1) => ({ id: `${P}${lineId}`, orderId: `${P}${orderId}`, variantId, productId: PRODUCT, productName: "Đầm QA COSQA-01", sku, quantity, unitPrice: 350_000, lineTotal: 350_000 * quantity });
  // O1: Pancake gửi kèm ad_id của mẩu. O2: không ad_id, bài viết của ĐÚNG mẩu ấy ⇒ quy về mẩu qua bài viết.
  const o1 = donHang("o1", { adId: AD, postId: `${PAGE}_${POST}`, cod: 350_000, totalPrice: 350_000, totalPriceAfterDiscount: 350_000 });
  await db.insert(schema.orders).values(o1);
  const o2 = donHang("o2", { adId: null, postId: `${PAGE}_${POST}`, cod: 1_050_000, totalPrice: 1_050_000, totalPriceAfterDiscount: 1_050_000 });
  await db.insert(schema.orders).values(o2);
  await db.insert(schema.orderItems).values([dongHang("o1", "oi1", V_M, "COSQA-01-M"), dongHang("o2", "oi2m", V_M, "COSQA-01-M"), dongHang("o2", "oi2l", V_L, "COSQA-01-L", 2)]);

  const creative = await modelCreativeSummary(db, PRODUCT);
  assert.equal(creative.total, 1, "một creative cho mẫu");
  assert.equal(creative.attributedOrders, 2, "creative đếm CẢ đơn mang ad_id LẪN đơn qua bài viết của mẩu");
  assert.equal(creative.ordersViaPost, 1, "đúng một đơn đi đường bài viết");
  assert.equal(creative.spendVnd, 200_000, "chi của creative = dòng chi hạt mẩu");
  assert.equal(creative.cpoVnd, 100_000, "CPO creative = 200.000 / 2 đơn");
  clearMemo();
  const ads = await getModelAdsSummary(PRODUCT, period);
  assert.equal(ads.status, "OK", "mã có đơn và chi đã ghép ⇒ OK");
  assert.equal(ads.spend, 200_000, "chi của mẫu khớp dòng chi QC đã gieo");
  assert.equal(ads.orders, 2, "đơn chốt của mẫu trong kỳ");
  assert.equal(ads.cpo, 100_000, "CPO = chi / đơn chốt, khớp dòng gieo");
  assert.ok(ads.decision !== null, "bảng quyết định có hành động cho mẫu");
  console.log("  ✓ QA-2 · creative ↔ QC ↔ đơn: 2 đơn (ad_id + bài viết), chi 200.000 ₫, CPO 100.000 ₫ ở cả tóm tắt creative lẫn tóm tắt QC của mẫu");

  /* ═══════════ BƯỚC 3 · THẮNG → TOPIC → GIÁ THÀNH → MẪU → BẢN DUYỆT ═══════════ */
  const thang = await transitionModelCore(db, { modelId: M, to: "WINNER", reason: "CPO 100k dưới trần, chủ shop chốt thắng", actor: OWNER, actorKind: "USER", source: "ui:/models" });
  assert.ok("ok" in thang && thang.from === "ADS_TESTING", "chủ shop khai WINNER");
  const [sup] = await db.insert(schema.suppliers).values({ name: `${P}Xưởng may QA` }).returning({ id: schema.suppliers.id });
  const chiTietMau = await getModel(M);
  assert.ok(chiTietMau);
  const evidence = buildTopicEvidenceSnapshot(await getModelEvidence(chiTietMau), PRODUCT, tick());
  assert.equal(evidence.ordersTotal, 2, "ảnh chụp chứng cứ lúc mở topic thấy đúng 2 đơn lên của mẫu");
  assert.equal(evidence.adSpend30d, 200_000, "ảnh chụp thấy chi QC 30 ngày của mẫu");
  const req = { material: "Đũi", colors: ["Đen"], sizes: ["M", "L"], trims: "Cúc gỗ", designNotes: "Cổ V", targetPrice: 130_000, expectedQty: 30, deadline: null };
  const topic = await createTopicCore(db, { modelId: M, title: "Hỏi giá may COSQA-01", requirements: req, supplierId: sup.id, evidence, firstMessage: "Xưởng báo giá giúp shop mẫu đầm đen", actor: LEAD });
  assert.ok("ok" in topic, "mở topic được");
  if (!("ok" in topic)) return;
  assert.equal(topic.lifecycle.moved, true, "WINNER → PRODUCTION_DISCUSSION đi theo khi mở topic");
  const T = topic.topicId;
  const viecTopic = async () => (await adaptProductionTopics(tick())).filter((w) => w.sourceKey === T);
  assert.equal((await viecTopic()).length, 1, "topic mở ⇒ MỘT việc PRODUCTION_TOPIC trên hàng đợi");
  assert.ok("ok" in (await addTopicMessageCore(db, { topicId: T, kind: "QUOTE", body: "Xưởng báo 118k/cái", attachments: [], quotedUnitPrice: 118_000, actor: LEAD })));
  assert.ok("ok" in (await addTopicMessageCore(db, { topicId: T, kind: "OPTION", body: "PA1 đũi Nhật · PA2 đũi TQ", attachments: [], quotedUnitPrice: null, actor: LEAD })));
  assert.ok("ok" in (await setTopicStatusCore(db, { topicId: T, to: "OPTIONS_READY", actor: LEAD })));
  const lapTopic = await setTopicStatusCore(db, { topicId: T, to: "OPTIONS_READY", actor: LEAD });
  assert.ok("ok" in lapTopic && lapTopic.noop, "bấm lại cùng trạng thái topic ⇒ noop (không sự kiện)");

  const dongGia = [
    { kind: "FABRIC" as const, description: "Đũi Nhật", qty: 1.5, unit: "m", unitCost: 50_000 },
    { kind: "LABOR" as const, description: "Công may", qty: 1, unit: "cái", unitCost: 40_000 },
  ];
  const v1 = await createCostSheetCore(db, { modelId: M, topicId: T, lines: dongGia, notes: "Bản đầu", actor: LEAD });
  assert.ok("ok" in v1 && v1.version === 1 && v1.totalUnitCost === 115_000, "giá thành V1 nháp, tổng máy chủ tính = 1,5×50k + 40k");
  if (!("ok" in v1)) return;
  assert.equal(v1.lifecycle.moved, true, "PRODUCTION_DISCUSSION → COSTING");
  const dongGiaV2 = [...dongGia, { kind: "TRIM" as const, description: "Cúc gỗ", qty: 5, unit: "cái", unitCost: 1_000 }];
  const v2 = await createCostSheetCore(db, { modelId: M, topicId: T, lines: dongGiaV2, notes: "Thêm cúc", actor: LEAD });
  assert.ok("ok" in v2 && v2.version === 2 && v2.totalUnitCost === 120_000);
  if (!("ok" in v2)) return;
  assert.ok("error" in (await finalizeCostSheetCore(db, { costSheetId: v2.costSheetId, actor: LEAD, canApprove: leadCanApprove })), "LEADER không chốt được giá thành");
  const chot = await finalizeCostSheetCore(db, { costSheetId: v2.costSheetId, actor: MGR, canApprove: mgrCanApprove });
  assert.ok("ok" in chot && chot.totalUnitCost === 120_000, "MANAGER chốt V2");
  assert.ok("error" in (await updateCostSheetDraftCore(db, { costSheetId: v2.costSheetId, lines: [{ kind: "OTHER", description: "sửa lén", qty: 1, unit: "", unitCost: 1 }], notes: "", actor: LEAD })), "V2 ĐÃ CHỐT không sửa được");
  const sheets = await db.select().from(schema.costSheets).where(eq(schema.costSheets.modelId, M)).orderBy(asc(schema.costSheets.version));
  assert.deepEqual(sheets.map((s) => [s.version, s.status, s.totalUnitCost]), [[1, "DRAFT", 115_000], [2, "FINAL", 120_000]], "V1 nháp còn nguyên, V2 chốt bất biến");
  assert.equal(sheets[1].finalizedByUserId, U.mgr, "người chốt là một users.id");

  const fields = { supplierId: sup.id, costVnd: 200_000, images: ["https://anh.local/qa-mau1.jpg"], notes: "Mẫu đầu", problems: "" };
  const s1 = await createSampleCore(db, { modelId: M, topicId: T, fields, actor: LEAD });
  assert.ok("ok" in s1 && s1.version === 1 && s1.lifecycle.moved, "mẫu V1 ⇒ COSTING → SAMPLING");
  if (!("ok" in s1)) return;
  const g1 = await submitSampleCore(db, { sampleId: s1.sampleId, actor: LEAD });
  assert.ok("ok" in g1 && !g1.noop && g1.lifecycle?.moved, "gửi duyệt ⇒ SAMPLING → SAMPLE_REVIEW");
  const g1b = await submitSampleCore(db, { sampleId: s1.sampleId, actor: LEAD });
  assert.ok("ok" in g1b && g1b.noop, "gửi duyệt lần hai ⇒ noop");
  const viecMau = async (sampleId: string) => (await adaptSampleReviews(tick())).filter((w) => w.sourceKey === sampleId);
  assert.equal((await viecMau(s1.sampleId)).length, 1, "mẫu chờ duyệt ⇒ MỘT việc SAMPLE_REVIEW");
  assert.ok("error" in (await reviewSampleCore(db, { sampleId: s1.sampleId, decision: "REQUEST_CHANGES", note: "", actor: MGR, canApprove: mgrCanApprove })), "yêu cầu sửa mà không ghi sửa gì ⇒ từ chối");
  const r1 = await reviewSampleCore(db, { sampleId: s1.sampleId, decision: "REQUEST_CHANGES", note: "Cổ V sâu thêm 1cm", actor: MGR, canApprove: mgrCanApprove });
  assert.ok("ok" in r1 && r1.status === "CHANGES_REQUESTED" && r1.designVersionId === null && r1.lifecycle?.moved, "yêu cầu sửa ⇒ SAMPLE_REVIEW → SAMPLING, không bản duyệt");
  assert.equal((await viecMau(s1.sampleId)).length, 0, "có phán quyết ⇒ việc tự rời hàng đợi");

  const s2 = await createSampleCore(db, { modelId: M, topicId: T, fields: { ...fields, notes: "Mẫu sửa cổ", costVnd: null }, actor: LEAD });
  assert.ok("ok" in s2 && s2.version === 2, "mẫu V2");
  if (!("ok" in s2)) return;
  assert.ok("ok" in (await submitSampleCore(db, { sampleId: s2.sampleId, actor: LEAD })));
  assert.equal((await viecMau(s2.sampleId)).length, 1, "mẫu V2 chờ duyệt ⇒ việc");
  assert.ok("error" in (await reviewSampleCore(db, { sampleId: s2.sampleId, decision: "APPROVE", note: null, actor: LEAD, canApprove: leadCanApprove })), "LEADER không duyệt được mẫu");
  const r2 = await reviewSampleCore(db, { sampleId: s2.sampleId, decision: "APPROVE", note: null, actor: MGR, canApprove: mgrCanApprove });
  assert.ok("ok" in r2 && r2.status === "APPROVED" && r2.designVersion === 1 && r2.designVersionId, "MANAGER duyệt V2 ⇒ bản thiết kế V1");
  if (!("ok" in r2) || !r2.designVersionId) return;
  assert.equal(r2.lifecycle?.moved, true, "SAMPLE_REVIEW → APPROVED");
  assert.equal((await viecMau(s2.sampleId)).length, 0, "duyệt xong ⇒ việc rời hàng đợi");
  const DV = r2.designVersionId;
  const [dv] = await db.select().from(schema.designVersions).where(eq(schema.designVersions.id, DV));
  assert.equal(dv.sampleId, s2.sampleId);
  assert.equal(dv.costSheetId, v2.costSheetId, "bản duyệt trỏ bảng giá CHỐT (V2), không phải bản nháp");
  assert.equal(dv.approvedByUserId, U.mgr);
  const spec = dv.spec as { sample: { version: number; costVnd: number | null }; costSheet: { totalUnitCost: number; version: number } | null; topic: { requirements: { material: string } } | null };
  assert.deepEqual([spec.sample.version, spec.sample.costVnd, spec.costSheet?.version, spec.costSheet?.totalUnitCost, spec.topic?.requirements.material], [2, null, 2, 120_000, "Đũi"], "ảnh chụp bản duyệt mang mẫu V2 (tiền mẫu chưa biết = null), giá V2, yêu cầu topic");

  // Topic chốt phương án ⇒ việc rời hàng đợi (đóng bằng đúng action của miền, không nút "xong").
  assert.ok("ok" in (await setTopicStatusCore(db, { topicId: T, to: "WAITING_DECISION", actor: LEAD })));
  assert.equal((await viecTopic()).length, 1, "topic chờ quyết vẫn là việc");
  assert.ok("ok" in (await setTopicStatusCore(db, { topicId: T, to: "SELECTED", selectedOption: "PA1 đũi Nhật", note: "Chốt theo giá 120k", actor: OWNER })));
  assert.equal((await viecTopic()).length, 0, "topic đã chốt ⇒ việc tự rời hàng đợi");
  const msgs = await db.select({ kind: schema.productionTopicMessages.kind }).from(schema.productionTopicMessages).where(eq(schema.productionTopicMessages.topicId, T)).orderBy(asc(schema.productionTopicMessages.createdAt));
  assert.deepEqual(msgs.map((m) => m.kind), ["NOTE", "QUOTE", "OPTION", "NOTE", "NOTE", "DECISION"], "luồng trao đổi: mở đầu + báo giá + phương án + 3 lượt đổi trạng thái (lượt noop không ghi)");
  console.log("  ✓ QA-3 · WINNER → topic → giá V1 nháp / V2 chốt bất biến → mẫu V1 yêu cầu sửa → V2 duyệt ⇒ bản thiết kế (ảnh chụp)");

  /* ═══════════ BƯỚC 4 · LỆNH SẢN XUẤT TRỎ BẢN DUYỆT ═══════════ */
  const finalCells = { "Đen|M": 20, "Đen|L": 10 };
  await db.insert(schema.productionOrders).values({ id: `${P}po1`, code: `${P}PO-1`, productId: PRODUCT, productCode: CODE, productName: "Đầm QA COSQA-01", colors: ["Đen"], sizes: ["M", "L"], cells: finalCells, totalQty: 30, unitCost: 120_000, supplier: `${P}Xưởng may QA`, supplierId: sup.id, createdBy: `${U.lead}@t.local` });
  await db.insert(schema.productionOrders).values({ id: `${P}po-nhap`, code: `${P}PO-NHAP`, productId: PRODUCT, productCode: CODE, productName: "Đầm QA COSQA-01", colors: ["Đen"], sizes: ["M"], cells: { "Đen|M": 5 }, totalQty: 5, createdBy: `${U.lead}@t.local` });
  // Gợi ý máy do MÁY CHỦ tính (đúng hàm action gọi), không nhận từ trình duyệt.
  const matrix = await buildMatrixForProduct(PRODUCT, { countIncoming: true });
  assert.ok(matrix, "kế hoạch SX dựng được ma trận cho mẫu");
  const suggestion: SuggestedCellsSnapshot = {
    cells: Object.fromEntries(Object.entries(matrix.cells).filter(([, v]) => v > 0)),
    basis: { source: "buildMatrixForProduct", coverDays: matrix.coverDays, countIncoming: matrix.countIncoming, leadTimeDays: matrix.leadTimeDays },
    computedAt: tick().toISOString(),
  };
  const lech = Object.keys({ ...suggestion.cells, ...finalCells }).filter((k) => (suggestion.cells[k] ?? 0) !== (finalCells[k as keyof typeof finalCells] ?? 0));
  assert.ok(lech.length > 0, `số chốt phải lệch gợi ý máy ở ít nhất một ô (gợi ý: ${JSON.stringify(suggestion.cells)})`);
  const thieuLyDo = await savePoPlanCore(db, { poId: `${P}po1`, designVersionId: DV, suggestion, overrideReason: "", actor: LEAD });
  assert.ok("error" in thieuLyDo && thieuLyDo.diff?.length === lech.length, "lệch gợi ý mà không lý do ⇒ chặn, chỉ ra đúng các ô lệch");
  const lienKet = await savePoPlanCore(db, { poId: `${P}po1`, designVersionId: DV, suggestion, overrideReason: "Đặt theo số test quảng cáo, chờ đủ dữ liệu bán", actor: LEAD });
  assert.ok("ok" in lienKet && lienKet.lifecycle?.moved, "APPROVED → PRODUCTION_PLANNING khi lệnh trỏ bản duyệt");
  const lai = await savePoPlanCore(db, { poId: `${P}po1`, designVersionId: DV, suggestion, overrideReason: "Đặt theo số test quảng cáo, chờ đủ dữ liệu bán", actor: LEAD });
  assert.ok("ok" in lai && lai.lifecycle === null, "lưu lại y hệt ⇒ không sự kiện mới");
  const [po] = await db.select().from(schema.productionOrders).where(eq(schema.productionOrders.id, `${P}po1`));
  assert.equal(po.designVersionId, DV);
  assert.deepEqual(po.suggestedCells?.cells, suggestion.cells, "ảnh chụp gợi ý máy lưu trên lệnh");
  assert.equal(po.suggestedCells?.basis.source, "buildMatrixForProduct");
  assert.equal(po.overrideReason, "Đặt theo số test quảng cáo, chờ đủ dữ liệu bán", "lý do lệch gợi ý lưu trên lệnh");

  // Cờ bắt buộc bản duyệt: TẮT ⇒ lệnh chưa trỏ bản duyệt chỉ cảnh báo; BẬT ⇒ chặn ĐÚNG lượt DRAFT → SENT.
  const guiXuong = async (poId: string) => {
    const [row] = await db.select({ status: schema.productionOrders.status, designVersionId: schema.productionOrders.designVersionId }).from(schema.productionOrders).where(eq(schema.productionOrders.id, poId));
    return checkSendWithoutDesign({ from: row.status, to: "SENT", designVersionId: row.designVersionId, requireApprovedDesign: await requireApprovedDesignFlag() });
  };
  assert.equal(await requireApprovedDesignFlag(), false, "mặc định cờ TẮT");
  assert.deepEqual(await guiXuong(`${P}po-nhap`), { ok: true, warn: true }, "cờ TẮT: lệnh chưa trỏ bản duyệt vẫn gửi được, kèm cảnh báo");
  await setSettingJson(REQUIRE_APPROVED_DESIGN_KEY, true);
  assert.equal(await requireApprovedDesignFlag(), true);
  assert.ok("error" in (await guiXuong(`${P}po-nhap`)), "cờ BẬT: lệnh chưa trỏ bản duyệt bị CHẶN ở lượt gửi xưởng");
  assert.deepEqual(await guiXuong(`${P}po1`), { ok: true, warn: false }, "lệnh đã trỏ bản duyệt gửi được, không cảnh báo");
  // Gửi xưởng như `setProductionStatus` ghi (không có lõi tách riêng).
  await db.update(schema.productionOrders).set({ status: "SENT", sentAt: tick(), updatedAt: new Date() }).where(eq(schema.productionOrders.id, `${P}po1`));
  await db.update(schema.productionOrders).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(schema.productionOrders.id, `${P}po-nhap`));
  await db.delete(schema.settings).where(eq(schema.settings.key, REQUIRE_APPROVED_DESIGN_KEY));
  const sx = await transitionModelCore(db, { modelId: M, to: "IN_PRODUCTION", reason: "Lệnh đã gửi xưởng", actor: LEAD, actorKind: "USER", source: "ui:/models" });
  assert.ok("ok" in sx && sx.from === "PRODUCTION_PLANNING", "người khai IN_PRODUCTION khi lệnh đã gửi");
  console.log("  ✓ QA-4 · lệnh SX trỏ bản duyệt, gợi ý máy + lý do lệch lưu trên lệnh; cờ tắt = cảnh báo, cờ bật = chặn lệnh chưa trỏ bản duyệt");

  /* ═══════════ BƯỚC 5 · PHIẾU NHẬP NỐI LỆNH ⇒ TỒN BIẾT ĐƯỢC ═══════════ */
  clearMemo();
  const truocNhap = await getModelStockStates(PRODUCT);
  assert.deepEqual(stockCells(truocNhap, V_M), { stockKnown: false, actual: null, available: null, reserved: 2, returning: 0, pendingQc: 0, damaged: 0 }, "chưa phiếu nhập ⇒ tồn CHƯA BIẾT (null), không phải 0; đã chốt 2 (O1 + O2)");
  assert.equal(truocNhap.totals.actualStock, null, "tổng tồn của mẫu chưa biết khi không mẫu mã nào biết tồn");
  assert.equal(variantOf(truocNhap, V_M).inProduction, 20, "lệnh đã gửi xưởng ⇒ đang sản xuất M 20");
  assert.equal(variantOf(truocNhap, V_L).inProduction, 10);
  assert.ok("error" in (await validateProductionLink(db, { kind: "RETURN", productionOrderId: `${P}po1` })), "chỉ phiếu Nhập hàng gắn được lệnh SX");
  const noi = await validateProductionLink(db, { kind: "RECEIPT", productionOrderId: `${P}po1` });
  assert.ok("ok" in noi && noi.link.productionOrderId === `${P}po1`, "phiếu nhập gắn được lệnh đã gửi");
  if (!("ok" in noi)) return;
  const nhapAt = tick();
  await db.insert(schema.stockReceipts).values({ id: `${P}rc-po1`, kind: "RECEIPT", receivedAt: nhapAt, reference: `${P}PO-1`, supplier: `${P}Xưởng may QA`, supplierId: sup.id, productionOrderId: noi.link.productionOrderId, totalQuantity: 30, totalCost: 3_600_000, createdBy: KHO.label });
  await db.insert(schema.stockReceiptItems).values([
    { receiptId: `${P}rc-po1`, variantId: V_M, quantity: 20, unitCost: 120_000 },
    { receiptId: `${P}rc-po1`, variantId: V_L, quantity: 10, unitCost: 120_000 },
  ]);
  clearMemo();
  const sauNhap = await getModelStockStates(PRODUCT);
  assert.deepEqual(stockCells(sauNhap, V_M), { stockKnown: true, actual: 20, available: 18, reserved: 2, returning: 0, pendingQc: 0, damaged: 0 }, "M: tồn thực tế = số nhập 20; khả dụng = 20 − 2 đã chốt");
  assert.deepEqual(stockCells(sauNhap, V_L), { stockKnown: true, actual: 10, available: 8, reserved: 2, returning: 0, pendingQc: 0, damaged: 0 }, "L: tồn thực tế = số nhập 10; khả dụng = 10 − 2 (O2 đặt 2 cái)");
  assert.equal(sauNhap.totals.actualStock, 30);
  const tomTatSx = await getModelProductionSummary(M);
  assert.deepEqual(tomTatSx?.openOrders.map((o) => [o.code, o.plannedQty, o.receivedViaLinkedReceipts]), [[`${P}PO-1`, 30, 30]], "tóm tắt SX đọc được số đã nhận qua phiếu nối lệnh (cột của Agent D)");
  // B1 (đã sửa): phiếu NHẬP nối lệnh trừ khỏi "đang sản xuất" ngay — không chờ ai bấm "Đã nhận",
  // nếu không cùng 30 món nằm ở cả tồn thực tế lẫn đang sản xuất.
  assert.equal(variantOf(sauNhap, V_M).inProduction, 0, "M: lệnh đặt 20, đã nhập 20 qua phiếu nối lệnh ⇒ không còn đang sản xuất");
  assert.equal(variantOf(sauNhap, V_L).inProduction, 0, "L: lệnh đặt 10, đã nhập 10 ⇒ 0");
  assert.equal(sauNhap.totals.inProduction, 0, "cùng một món không được nằm ở cả tồn thực tế lẫn đang sản xuất");
  // Người bấm "Đã nhận" trên lệnh (như `setProductionStatus` ghi) ⇒ lệnh rời "đang sản xuất".
  await db.update(schema.productionOrders).set({ status: "RECEIVED", receivedAt: tick(), receivedByUserId: U.kho, receivedBy: KHO.label, updatedAt: new Date() }).where(eq(schema.productionOrders.id, `${P}po1`));
  clearMemo();
  const sauNhanLenh = await getModelStockStates(PRODUCT);
  assert.equal(sauNhanLenh.totals.inProduction, 0, "lệnh đã nhận ⇒ không còn đang sản xuất");
  assert.equal(sauNhanLenh.totals.actualStock, 30, "đổi trạng thái lệnh không đổi tồn — tồn chỉ đổi qua phiếu kho");
  const ban = await transitionModelCore(db, { modelId: M, to: "SELLING", reason: "Hàng về kho, mở bán", actor: OWNER, actorKind: "USER", source: "ui:/models" });
  assert.ok("ok" in ban && ban.from === "IN_PRODUCTION", "người khai SELLING khi hàng về");
  console.log("  ✓ QA-5 · phiếu nhập nối lệnh ⇒ tồn thực tế = số nhập, stockKnown; tóm tắt SX thấy 30/30 đã nhận");

  /* ═══════════ BƯỚC 6 · VẬN ĐƠN VIETTEL POST ⇒ ORDER_OUTCOME ⇒ TỒN ═══════════ */
  const o3 = donHang("o3", { adId: null, postId: null, cod: 350_000, totalPrice: 350_000, totalPriceAfterDiscount: 350_000 });
  await db.insert(schema.orders).values(o3);
  await db.insert(schema.orderItems).values(dongHang("o3", "oi3", V_L, "COSQA-01-L"));
  // Vận đơn do đồng bộ Pancake tạo (mã VTP gắn với đơn); từ đây mọi trạng thái đến bằng webhook VTP.
  await db.insert(schema.shipments).values([
    { id: `${P}s1`, orderId: `${P}o1`, carrier: "Viettel Post", vtpOrderNumber: TRACK.o1, trackingCode: TRACK.o1, codAmount: 350_000 },
    { id: `${P}s2`, orderId: `${P}o2`, carrier: "Viettel Post", vtpOrderNumber: TRACK.o2, trackingCode: TRACK.o2, codAmount: 1_050_000 },
    { id: `${P}s3`, orderId: `${P}o3`, carrier: "Viettel Post", vtpOrderNumber: TRACK.o3, trackingCode: TRACK.o3, codAmount: 350_000 },
  ]);
  const goc = tick();
  await vtpWebhook(TRACK.o3, 100, "Tiếp nhận đơn hàng", carrierAt(goc, 0), { IS_RETURNING: false, MONEY_COLLECTION: 350_000 });
  // Pancake báo "đã gửi hàng" cho cả ba đơn TRƯỚC khi ĐVVC xác nhận lấy — trạng thái Pancake KHÔNG được trừ tồn.
  await db.update(schema.orders).set({ stage: "SHIPPED", updatedAt: tick() }).where(inArray(schema.orders.id, [`${P}o1`, `${P}o2`, `${P}o3`]));
  clearMemo();
  const pancakeBaoGui = await getModelStockStates(PRODUCT);
  assert.deepEqual(
    [variantOf(pancakeBaoGui, V_M).actualStock, variantOf(pancakeBaoGui, V_L).actualStock, variantOf(pancakeBaoGui, V_M).reserved, variantOf(pancakeBaoGui, V_L).reserved],
    [20, 10, 2, 3],
    "Pancake 'đã gửi' mà ĐVVC chưa lấy ⇒ tồn thực tế KHÔNG đổi, hàng vẫn là 'đã chốt chưa xuất'",
  );
  await vtpWebhook(TRACK.o1, 200, "Lấy hàng thành công - nhập bưu cục gốc", carrierAt(goc, 0), { IS_RETURNING: false, MONEY_COLLECTION: 350_000 });
  await vtpWebhook(TRACK.o2, 200, "Lấy hàng thành công - nhập bưu cục gốc", carrierAt(goc, 0), { IS_RETURNING: false, MONEY_COLLECTION: 1_050_000 });
  clearMemo();
  const daXuat = await getModelStockStates(PRODUCT);
  assert.deepEqual(stockCells(daXuat, V_M), { stockKnown: true, actual: 18, available: 18, reserved: 0, returning: 0, pendingQc: 0, damaged: 0 }, "ĐVVC lấy hàng O1 + O2 ⇒ M rời kho 2");
  assert.deepEqual(stockCells(daXuat, V_L), { stockKnown: true, actual: 8, available: 7, reserved: 1, returning: 0, pendingQc: 0, damaged: 0 }, "L rời kho 2 (O2); O3 chờ lấy ⇒ vẫn trong kho, chỉ trừ khả dụng");
  assert.equal((await outcomeOf(db, `${P}o3`))?.v, "AWAITING_PICKUP", "O3 có sự kiện ĐVVC nhưng chưa bàn giao ⇒ chờ lấy, không phải đang giao");
  assert.equal((await outcomeOf(db, `${P}o1`))?.v, "IN_TRANSIT");

  await vtpWebhook(TRACK.o1, 501, "Phát thành công", carrierAt(goc, 2), { IS_RETURNING: false, MONEY_COLLECTION: 350_000 });
  await vtpWebhook(TRACK.o2, 505, "Yêu cầu chuyển hoàn", carrierAt(goc, 2), { IS_RETURNING: false, MONEY_COLLECTION: 1_050_000 });
  const o1TruocBangKe = await outcomeOf(db, `${P}o1`);
  assert.deepEqual([o1TruocBangKe?.v, o1TruocBangKe?.verified], ["DELIVERED", "UNVERIFIED"], "501 chiều đi ⇒ DELIVERED; chưa bảng kê ⇒ tiền CHƯA XÁC MINH, không phải thu 0đ");
  assert.equal((await outcomeOf(db, `${P}o2`))?.v, "RETURNED", "505 đang hoàn ⇒ RETURNED");
  await vtpWebhook(TRACK.o2, 504, "Chuyển hoàn thành công cho người gửi", carrierAt(goc, 4), { IS_RETURNING: true, MONEY_COLLECTION: 1_050_000 });
  const bangKe = await applyStatementDetailRows([{ trackingCode: TRACK.o1, cod: 350_000, fee: 30_000, net: 320_000, raw: "Phát thành công", paidDate: todayKey }], BANG_KE, null);
  assert.equal(bangKe.linked, 1, "dòng bảng kê ghép đúng vận đơn O1");
  const o1Sau = await outcomeOf(db, `${P}o1`);
  assert.deepEqual([o1Sau?.v, o1Sau?.verified], ["DELIVERED", "DELIVERED"], "501 + tiền thực thu 350.000 > 100.000 ⇒ DELIVERED ở cả hai công thức");
  const o2Sau = await outcomeOf(db, `${P}o2`);
  assert.deepEqual([o2Sau?.v, o2Sau?.verified], ["RETURNED", "RETURNED"], "504 ⇒ RETURNED");
  const [s2Row] = await db.select({ stage: schema.shipments.stage, returnReceivedAt: schema.shipments.returnReceivedAt }).from(schema.shipments).where(eq(schema.shipments.id, `${P}s2`));
  assert.deepEqual([s2Row.stage, s2Row.returnReceivedAt], ["RETURNED", null], "ĐVVC báo đã hoàn, kho CHƯA xác nhận nhận");
  clearMemo();
  const daHoan = await getModelStockStates(PRODUCT);
  assert.deepEqual(stockCells(daHoan, V_M), { stockKnown: true, actual: 18, available: 18, reserved: 0, returning: 1, pendingQc: 0, damaged: 0 }, "hàng hoàn KHÔNG tự vào tồn: M vẫn 18, 1 đang hoàn");
  assert.deepEqual(stockCells(daHoan, V_L), { stockKnown: true, actual: 8, available: 7, reserved: 1, returning: 2, pendingQc: 0, damaged: 0 }, "L vẫn 8, 2 đang hoàn");
  // Kết cục đơn chảy NGƯỢC về creative và QC của mẫu — cùng ORDER_OUTCOME, không định nghĩa thứ hai.
  const cvSau = (await variantMetrics(db, [{ id: `${P}cv-1`, fbAdId: AD, startAt: batchStart }])).get(`${P}cv-1`);
  assert.ok(cvSau);
  assert.deepEqual(
    [cvSau.bookedOrders, cvSau.deliveredOrders, cvSau.returnedOrders, cvSau.attribution.direct.delivered, cvSau.attribution.viaPost.returned],
    [2, 1, 1, 1, 1],
    "creative: 2 đơn quy kết (O3 không quảng cáo không vào), O1 (ad_id) giao thành công, O2 (bài viết) hoàn",
  );
  clearMemo();
  const adsSau = await getModelAdsSummary(PRODUCT, period);
  assert.deepEqual([adsSau.orders, adsSau.deliveredOrders, adsSau.spend], [3, 1, 200_000], "QC theo mẫu: 3 đơn chốt (chiều mã hàng gồm cả đơn không quảng cáo), 1 giao thành công");
  console.log("  ✓ QA-6 · webhook VTP + bảng kê ⇒ O1 DELIVERED (tiền đã xác minh), O2 RETURNED, O3 AWAITING_PICKUP; tồn chỉ trừ khi rời kho, hàng hoàn chưa vào tồn");

  /* ═══════════ BƯỚC 7 · KHO NHẬN · KIỂM TỪNG MÓN · KẾT CỤC HÀNG HỎNG ═══════════ */
  const ve = await markReturnsArrived([`${P}s2`], KHO);
  assert.equal(ve.count, 1, "kho ghi nhận kiện đã về");
  clearMemo();
  const choKiem = await getModelStockStates(PRODUCT);
  assert.deepEqual([variantOf(choKiem, V_M).pendingQc, variantOf(choKiem, V_L).pendingQc, variantOf(choKiem, V_M).actualStock], [1, 2, 18], "đã về chờ đếm ⇒ chờ kiểm M 1 + L 2, tồn vẫn chưa đổi");
  const kiem = await recordItemInspection({
    shipmentId: `${P}s2`,
    actor: KHO,
    orderOnlyConfirmed: true,
    items: [
      { expectedVariantId: V_M, expectedSku: "COSQA-01-M", expectedName: "Đầm QA COSQA-01", expectedColor: "Đen", expectedSize: "M", expectedQty: 1, actualVariantId: V_M, actualSku: "COSQA-01-M", actualQty: 1, condition: "OK", note: "" },
      { expectedVariantId: V_L, expectedSku: "COSQA-01-L", expectedName: "Đầm QA COSQA-01", expectedColor: "Đen", expectedSize: "L", expectedQty: 2, actualVariantId: V_L, actualSku: "COSQA-01-L", actualQty: 2, condition: "DAMAGED", note: "bẩn cổ áo, một cái rách nách" },
    ],
  });
  assert.ok("ok" in kiem && kiem.restocked === 1 && kiem.receiptId, "kiểm từng món: 1 món đủ ⇒ đúng 1 món vào phiếu tái nhập");
  if (!("ok" in kiem) || !kiem.receiptId) return;
  const [phieuHoan] = await db.select({ kind: schema.stockReceipts.kind }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, kiem.receiptId));
  assert.equal(phieuHoan.kind, "RETURN", "hàng hoàn vào tồn bằng phiếu RETURN với số đếm thật");
  clearMemo();
  const daKiem = await getModelStockStates(PRODUCT);
  assert.deepEqual(stockCells(daKiem, V_M), { stockKnown: true, actual: 19, available: 19, reserved: 0, returning: 0, pendingQc: 0, damaged: 0 }, "M: món đủ tái nhập ⇒ 18 + 1 = 19");
  assert.deepEqual(stockCells(daKiem, V_L), { stockKnown: true, actual: 8, available: 7, reserved: 1, returning: 0, pendingQc: 0, damaged: 2 }, "L: 2 món hỏng KHÔNG vào tồn, đếm ở ô hỏng");

  const [monHong] = await db.select({ id: schema.returnInspectionItems.id }).from(schema.returnInspectionItems).where(and(eq(schema.returnInspectionItems.shipmentId, `${P}s2`), eq(schema.returnInspectionItems.condition, "DAMAGED")));
  const SUBJECT = `item:${monHong.id}`;
  const viecKetCuc = async () => {
    clearMemo();
    return (await adaptReturnDispositions(tick())).filter((w) => w.sourceKey === SUBJECT);
  };
  assert.equal((await viecKetCuc()).length, 1, "món hỏng chưa quyết ⇒ MỘT việc RETURN_DISPOSITION");
  // Cổng duyệt thật (lõi của lời gọi `guardSecondApproval`) — chỉ lượt huỷ mới đi qua nó.
  const congKho: DispositionGate = (input) => guardSecondApprovalCore(db, { id: U.kho, email: `${U.kho}@t.local` }, input, tick());
  assert.ok("error" in (await setReturnDispositionCore(db, { subjectKey: SUBJECT, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "", actor: KHO, gate: congKho })), "chưa qua sửa ⇒ không nhập lại được");
  const sua = await setReturnDispositionCore(db, { subjectKey: SUBJECT, disposition: "REWORK", qty: null, note: "đem giặt", actor: KHO, gate: congKho });
  assert.ok("ok" in sua && sua.receiptId === null, "đưa đi sửa KHÔNG lập phiếu kho");
  const viecDangSua = await viecKetCuc();
  assert.deepEqual(viecDangSua.map((w) => w.kind), ["REWORK"], "đang sửa vẫn là việc (trạng thái REWORK)");
  clearMemo();
  assert.equal(variantOf(await getModelStockStates(PRODUCT), V_L).damaged, 2, "đang sửa chưa phải kết cục ⇒ hỏng vẫn 2");
  const REQ = `${P}req-rework-1`;
  const nhapLai = await setReturnDispositionCore(db, { subjectKey: SUBJECT, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "giặt sạch", requestKey: REQ, actor: KHO, gate: congKho });
  assert.ok("ok" in nhapLai && nhapLai.receiptId && !nhapLai.replayed, "sửa xong ⇒ nhập lại bằng phiếu tái nhập");
  if (!("ok" in nhapLai) || !nhapLai.receiptId) return;
  const RW = nhapLai.receiptId;
  const lapLai = await setReturnDispositionCore(db, { subjectKey: SUBJECT, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "giặt sạch", requestKey: REQ, actor: KHO, gate: congKho });
  assert.ok("ok" in lapLai && lapLai.replayed && lapLai.receiptId === RW, "gửi lại cùng khoá ⇒ trả lại dòng cũ");
  const phieuTaiNhapL = await db
    .select({ id: schema.stockReceipts.id, qty: schema.stockReceiptItems.quantity })
    .from(schema.stockReceiptItems)
    .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
    .where(and(eq(schema.stockReceiptItems.variantId, V_L), eq(schema.stockReceipts.kind, "RETURN")));
  assert.deepEqual(phieuTaiNhapL, [{ id: RW, qty: 1 }], "đúng MỘT phiếu RETURN cho món L sau sửa (gửi lại không nhân đôi)");
  clearMemo();
  const sauNhapLai = await getModelStockStates(PRODUCT);
  assert.deepEqual([variantOf(sauNhapLai, V_L).actualStock, variantOf(sauNhapLai, V_L).damaged], [9, 1], "nhập lại 1 ⇒ L 8 + 1 = 9; còn 1 món hỏng chờ");
  assert.equal((await viecKetCuc()).length, 1, "còn một món mở ⇒ việc vẫn ở hàng đợi");

  // Món còn lại: huỷ. Cưỡng chế nhóm INVENTORY_WRITE_OFF BẬT (công tắc v2 thật) — giá trị ước tính 120.000 ₫
  // dưới ngưỡng 1.000.000 ₫ ⇒ cổng THẬT cho qua và để lại vết `approval.skip` (E nối đúng vào G).
  const quanTriKho = { id: U.owner, email: `${U.owner}@t.local`, isAdmin: true };
  assert.ok("ok" in (await setEnforceGroupCore(db, quanTriKho, "INVENTORY_WRITE_OFF", true)));
  assert.ok("error" in (await setReturnDispositionCore(db, { subjectKey: SUBJECT, disposition: "WRITE_OFF", qty: 1, note: "", actor: KHO, gate: congKho })), "huỷ thiếu lý do ⇒ từ chối");
  const huy = await setReturnDispositionCore(db, { subjectKey: SUBJECT, disposition: "WRITE_OFF", qty: 1, note: "rách nách, không vá được", actor: KHO, gate: congKho });
  assert.ok("ok" in huy && huy.receiptId === null && huy.valueEstimate === 120_000, "huỷ KHÔNG lập phiếu kho; giá trị ước tính theo phiếu nhập 120.000 ₫");
  const vetCong = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.userEmail, `${U.kho}@t.local`), eq(schema.auditLogs.action, "approval.skip:return.disposition_write_off")));
  assert.equal(vetCong.length, 1, "cổng duyệt thật được hỏi đúng một lần cho lượt huỷ");
  const vet = vetCong[0].detail as { group?: string; amount?: number; lyDo?: string };
  assert.deepEqual([vet.group, vet.amount, vet.lyDo], ["INVENTORY_WRITE_OFF", 120_000, "dưới ngưỡng"], "huỷ đi đúng nhóm, đúng số tiền; dưới ngưỡng thì làm luôn và để vết");
  assert.ok("ok" in (await setEnforceGroupCore(db, quanTriKho, "INVENTORY_WRITE_OFF", false)));
  assert.equal((await viecKetCuc()).length, 0, "toàn bộ số lượng đã có kết cục cuối ⇒ việc tự rời hàng đợi");
  clearMemo();
  const sauSua = await getModelStockStates(PRODUCT);
  assert.deepEqual(stockCells(sauSua, V_L), { stockKnown: true, actual: 9, available: 8, reserved: 1, returning: 0, pendingQc: 0, damaged: 0 }, "L: 1 nhập lại + 1 huỷ ⇒ tồn 9, hỏng còn chờ 0 (không đếm hai lần; huỷ không ghi sổ kho)");
  assert.equal(sauSua.totals.actualStock, 28, "tổng tồn = 30 nhập − 4 rời kho + 2 tái nhập (1 lượt đếm + 1 sau sửa)");
  assert.equal(sauSua.totals.damaged, 0);
  const ketCucMau = await getModelReturnDispositions(PRODUCT);
  assert.deepEqual(
    [ketCucMau.pendingQty, ketCucMau.reworkQty, ketCucMau.restockedAfterReworkQty, ketCucMau.writtenOffQty, ketCucMau.openSubjects, ketCucMau.writeOffValueEstimate],
    [0, 0, 1, 1, 0, 120_000],
    "tóm tắt kết cục hàng hoàn của mẫu khớp sổ: 1 nhập lại sau sửa, 1 huỷ trị giá 120.000 ₫, không còn gì mở",
  );
  // Hai miền đọc tồn cho cùng một mẫu (chứng cứ của sổ mẫu — A; trạng thái tồn — D) phải nói cùng một số.
  const chungCu = await getModelEvidence((await getModel(M))!);
  assert.deepEqual([chungCu.stockKnown, chungCu.stockOnHand], [true, sauSua.totals.actualStock], "chứng cứ sổ mẫu và trạng thái tồn theo mẫu cùng một con số");

  const demNhatKy = async (id: string) => Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(eq(schema.auditLogs.entityId, id)))[0].n);
  const nkTruoc = await demNhatKy(RW);
  const congXoa: ReceiptDeleteGate = (input) => guardSecondApprovalCore(db, { id: U.kho, email: `${U.kho}@t.local` }, input, tick());
  const xoaRw = await deleteStockReceiptCore(db, { id: RW, reason: "lập nhầm phiếu sửa", actor: KHO, actorEmail: `${U.kho}@t.local`, gate: congXoa });
  assert.ok("error" in xoaRw && xoaRw.blocker?.reworkRestocks.length === 1 && /NHẬP LẠI SAU SỬA/.test(xoaRw.error), "phiếu nhập lại sau sửa bị CHẶN xoá, có thông điệp tiếng Việt");
  assert.equal(await demNhatKy(RW), nkTruoc, "lượt xoá bị chặn KHÔNG để lại dòng nhật ký");
  assert.equal((await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, RW))).length, 1, "phiếu còn nguyên");
  const xoaHoan = await deleteStockReceiptCore(db, { id: kiem.receiptId, reason: "lập nhầm phiếu đếm", actor: KHO, actorEmail: `${U.kho}@t.local`, gate: congXoa });
  assert.ok("error" in xoaHoan && xoaHoan.blocker?.inspections.length === 1, "phiếu tái nhập của lượt đếm cũng bị chặn (chứng từ của phiếu kiểm)");
  console.log("  ✓ QA-7 · về kho → kiểm từng món: 1 đủ vào tồn (RETURN), 2 hỏng → sửa → 1 nhập lại đúng một phiếu + 1 huỷ qua cổng duyệt thật; xoá phiếu nhập lại bị chặn, không nhật ký");

  /* ═══════════ BƯỚC 8 · KINH TẾ THEO MẪU: ƯỚC TÍNH CẠNH THỰC ĐẠT ═══════════ */
  clearMemo();
  const kt = await getModelEconomics(PRODUCT, period);
  assert.equal(kt.realizedFound, true, "bảng quyết định có dòng của mẫu");
  assert.equal(kt.estimatedFound, true, "báo cáo danh nghĩa có dòng của mẫu");
  const line = (key: string) => {
    const l = kt.lines.find((x) => x.key === key);
    assert.ok(l, `thiếu dòng ${key}`);
    return l;
  };
  for (const l of kt.lines) {
    assert.deepEqual([l.estimated.basis, l.estimated.label, l.realized.basis, l.realized.label], ["ESTIMATED", "Ước tính", "REALIZED", "Thực đạt"], `${l.key}: ước tính và thực đạt đứng CẠNH nhau, có nhãn`);
  }
  const deliveredValue = await db
    .select({ id: schema.orders.id, v: ORDER_OUTCOME, value: schema.orders.totalPriceAfterDiscount })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(like(schema.orders.id, `${P}%`));
  const giaoThanhCong = deliveredValue.filter((r) => r.v === "DELIVERED");
  assert.deepEqual(giaoThanhCong.map((r) => r.id), [`${P}o1`], "chỉ O1 giao thành công theo ORDER_OUTCOME");
  assert.equal(line("orders").realized.value, 3, "thực đạt: 3 đơn chốt của mẫu");
  assert.equal(line("deliveredRevenue").realized.value, 350_000, "doanh thu thực đạt = đúng giá trị đơn DELIVERED theo ORDER_OUTCOME");
  assert.equal(line("deliveryRate").realized.value, 50, "GTC thực đạt trên đơn đã kết thúc: 1 giao / (1 giao + 1 hoàn)");
  assert.equal(line("adSpend").realized.value, 200_000, "chi QC thực đạt = dòng chi đã gieo");
  const [nominalOrders] = [line("orders").estimated.value];
  assert.equal(nominalOrders, 3, "ước tính: 3 đơn chưa huỷ theo ngày lên đơn");
  clearMemo();
  const { getAdsDecision } = await import("@/lib/queries/ads-decision");
  const d = (await getAdsDecision(period, "product")).rows.find((r) => r.key === PRODUCT);
  assert.ok(d, "dòng quyết định của mẫu");
  assert.equal(line("breakEvenCpoContribution").realized.value, maxAdCostPerOrder({ profitBeforeAds: d.contributionBeforeAds, orders: d.bookedOrders }), "CPO hoà vốn thực đạt = maxAdCostPerOrder trên CÙNG đầu vào (LN góp trước QC, đơn chốt)");
  assert.equal(line("cpo").realized.value, d.costPerOrder, "CPO thực đọc nguyên dòng quyết định");
  assert.equal(line("netProfit").realized.value, null, "LN ròng thực đạt CHƯA đo được ⇒ null, không phải 0");
  assert.equal(line("maxAdCostPerOrderNet").realized.value, null, "trần QC/đơn theo LN ròng thực đạt chưa đo ⇒ null");
  assert.equal(line("netProfitPerOrder").realized.value, null);
  assert.ok(line("netProfit").realized.note, "ô chưa biết phải nói vì sao");
  console.log("  ✓ QA-8 · kinh tế mẫu: ước tính cạnh thực đạt; thực đạt đi theo ORDER_OUTCOME (350.000 ₫, GTC 50%); CPO hoà vốn = maxAdCostPerOrder; LN ròng thực đạt null");

  /* ═══════════ BƯỚC 9 · MẶT PHẲNG ĐIỀU KHIỂN: XOÁ PHIẾU ĐIỀU CHỈNH CẦN NGƯỜI THỨ HAI ═══════════ */
  const quanTri = { id: U.owner, email: `${U.owner}@t.local`, isAdmin: true };
  assert.ok("error" in (await setEnforceGroupCore(db, { ...quanTri, isAdmin: false }, "INVENTORY_ADJUSTMENT", true)), "chỉ ADMIN bật được cưỡng chế");
  assert.ok("ok" in (await setEnforceGroupCore(db, quanTri, "INVENTORY_ADJUSTMENT", true)), "chủ shop bật cưỡng chế nhóm điều chỉnh kho (công tắc v2)");
  assert.equal(isEnforced(await readEnforceConfig(db), "INVENTORY_ADJUSTMENT"), true);
  // Phiếu điều chỉnh kiểm kê (+2 M) lập nhầm — ghi như `createStockReceipt` ghi.
  await db.insert(schema.stockReceipts).values({ id: `${P}rc-adj`, kind: "ADJUSTMENT", receivedAt: tick(), reference: `${P}kiem-ke`, totalQuantity: 2, totalCost: 0, createdBy: KHO.label });
  await db.insert(schema.stockReceiptItems).values({ receiptId: `${P}rc-adj`, variantId: V_M, quantity: 2, unitCost: 0 });
  clearMemo();
  assert.equal(variantOf(await getModelStockStates(PRODUCT), V_M).actualStock, 21, "phiếu điều chỉnh +2 ⇒ M 21");
  const now9 = () => tick();
  const nguoiXin = { id: U.kho, email: `${U.kho}@t.local` };
  const congThat: ReceiptDeleteGate = (input) => guardSecondApprovalCore(db, nguoiXin, input, now9());
  const xoaAdj = () => deleteStockReceiptCore(db, { id: `${P}rc-adj`, reason: "kiểm kê đếm nhầm kệ", actor: KHO, actorEmail: nguoiXin.email, gate: congThat });
  const lan1 = await xoaAdj();
  assert.ok("error" in lan1 && lan1.approval === "NEEDS_APPROVAL", "cưỡng chế bật ⇒ xoá phiếu điều chỉnh phải chờ người thứ hai");
  const cho = await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.requestedBy, U.kho), eq(schema.approvalRequests.status, "PENDING")));
  assert.equal(cho.length, 1, "đúng MỘT yêu cầu PENDING");
  const REQ_ID = cho[0].id;
  assert.equal(cho[0].entityId, `${P}rc-adj`);
  assert.equal((await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, `${P}rc-adj`))).length, 1, "chưa duyệt ⇒ phiếu còn nguyên");
  const lan1b = await xoaAdj();
  assert.ok("error" in lan1b && lan1b.approval === "NEEDS_APPROVAL");
  assert.equal((await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.requestedBy, U.kho), eq(schema.approvalRequests.status, "PENDING")))).length, 1, "bấm lại khi đang chờ KHÔNG đẻ yêu cầu thứ hai");
  const viecDuyet = async () => (await collectWorkItems({ sources: ["APPROVAL"], now: tick() })).items.filter((i) => i.key === `APPROVAL:${REQ_ID}`);
  assert.equal((await viecDuyet()).length, 1, "yêu cầu chờ ⇒ MỘT việc APPROVAL");
  assert.ok("error" in (await decideApprovalCore(db, { id: U.kho, email: nguoiXin.email, canDecide: can("WAREHOUSE", "approvals:decide") }, REQ_ID, true, undefined, tick())), "người xin không tự duyệt được");
  assert.ok("ok" in (await decideApprovalCore(db, { id: U.mgr, email: `${U.mgr}@t.local`, canDecide: can("MANAGER", "approvals:decide") }, REQ_ID, true, undefined, tick())), "MANAGER duyệt");
  assert.equal((await viecDuyet()).length, 0, "đã quyết ⇒ việc APPROVAL tự biến mất");
  const lan2Xoa = await xoaAdj();
  assert.ok("ok" in lan2Xoa, "người xin làm lại ĐÚNG việc ⇒ chạy");
  const [daDung] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, REQ_ID));
  assert.equal(daDung.status, "EXECUTED", "lời duyệt đã TIÊU THỤ");
  assert.ok(daDung.executedAt, "có executed_at");
  assert.equal((await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, `${P}rc-adj`))).length, 0, "phiếu đã xoá");
  clearMemo();
  assert.equal(variantOf(await getModelStockStates(PRODUCT), V_M).actualStock, 19, "xoá phiếu điều chỉnh ⇒ M về 19");
  // Lời duyệt chỉ dùng MỘT lần: cùng việc lần nữa ⇒ yêu cầu MỚI.
  const lai9 = await guardSecondApprovalCore(db, nguoiXin, { group: "INVENTORY_ADJUSTMENT", action: "stock.receipt_delete", entity: "STOCK_RECEIPT", entityId: `${P}rc-adj`, summary: "làm lại", amount: null, payload: { receiptId: `${P}rc-adj`, reason: "kiểm kê đếm nhầm kệ" } }, tick());
  assert.equal(lai9.mode, "NEEDS_APPROVAL", "lời duyệt đã dùng không mở khoá lần hai");
  assert.ok(lai9.requestId && lai9.requestId !== REQ_ID, "lần hai là một yêu cầu MỚI");
  assert.equal(
    await consumeApprovedRequest(db, { requesterId: U.kho, group: "INVENTORY_ADJUSTMENT", action: "stock.receipt_delete", fingerprint: approvalFingerprint({ group: "INVENTORY_ADJUSTMENT", action: "stock.receipt_delete", entity: "STOCK_RECEIPT", entityId: `${P}rc-adj`, payload: { receiptId: `${P}rc-adj`, reason: "kiểm kê đếm nhầm kệ" } }), now: tick() }),
    null,
    "không còn lời duyệt nào để tiêu thụ",
  );
  assert.ok("error" in (await decideApprovalCore(db, { id: U.mgr, email: `${U.mgr}@t.local`, canDecide: true }, lai9.requestId!, false, "  ", tick())), "từ chối phải có lý do");
  assert.ok("ok" in (await decideApprovalCore(db, { id: U.mgr, email: `${U.mgr}@t.local`, canDecide: true }, lai9.requestId!, false, "phiếu đã xoá rồi, không còn gì để xoá", tick())));
  const nk = await db.select().from(schema.auditLogs).where(or(eq(schema.auditLogs.entityId, REQ_ID), eq(schema.auditLogs.entityId, `${P}rc-adj`), eq(schema.auditLogs.entityId, lai9.requestId!)));
  const nkTheoHanhDong = (a: string) => nk.filter((r) => r.action === a);
  assert.equal(nkTheoHanhDong("approval.request:stock.receipt_delete").length, 2, "hai lượt xin (lần đầu + lần làm lại sau khi đã dùng)");
  assert.ok(nkTheoHanhDong("approval.request:stock.receipt_delete").every((r) => r.actorKind === "USER"), "lượt xin là NGƯỜI");
  const exec = nkTheoHanhDong("approval.execute:stock.receipt_delete");
  assert.equal(exec.length, 1, "đúng MỘT lượt tiêu thụ");
  assert.ok(exec[0].actorKind === "USER" && exec[0].reason && exec[0].correlationId === REQ_ID, "lượt tiêu thụ mang actor_kind, lý do, mã yêu cầu");
  const xoaLog = nkTheoHanhDong("STOCK_RECEIPT_DELETE");
  assert.equal(xoaLog.length, 1, "đúng MỘT dòng nhật ký xoá (lượt chờ duyệt không ghi)");
  assert.deepEqual([xoaLog[0].actorKind, xoaLog[0].reason], ["USER", "kiểm kê đếm nhầm kệ"], "nhật ký xoá mang loại tác nhân và lý do");
  const tuChoi = nkTheoHanhDong("approval.reject");
  assert.equal(tuChoi[0]?.reason, "phiếu đã xoá rồi, không còn gì để xoá", "lý do từ chối vào cột reason");
  assert.ok("ok" in (await setEnforceGroupCore(db, quanTri, "INVENTORY_ADJUSTMENT", false)), "tắt lại cưỡng chế");
  console.log("  ✓ QA-9 · cưỡng chế bật ⇒ PENDING → người khác duyệt → làm lại ⇒ EXECUTED đúng một lần → lần sau xin lại; việc APPROVAL hiện rồi biến mất; nhật ký có actor_kind + reason");

  /* ═══════════ BƯỚC 10 · HÀNG ĐỢI: PHÉP CHIẾU, KHÔNG NÚT "XONG" ═══════════ */
  for (const src of ["PRODUCTION_TOPIC", "SAMPLE_REVIEW", "RETURN_DISPOSITION", "APPROVAL"] as const) {
    assert.equal(WORK_SOURCE_SPEC[src].statusAuthority, "SOURCE", `${src}: trạng thái ở miền nguồn`);
    assert.deepEqual(WORK_SOURCE_SPEC[src].actions, ["OPEN_SOURCE"], `${src}: chỉ nút MỞ — không nút đánh dấu xong`);
  }
  const conLai = await collectWorkItems({ sources: ["PRODUCTION_TOPIC", "SAMPLE_REVIEW", "RETURN_DISPOSITION", "APPROVAL"], now: tick() });
  assert.deepEqual(conLai.failed, []);
  const cuaBai = conLai.items.filter((i) => [T, s1.sampleId, s2.sampleId, SUBJECT, `APPROVAL:${REQ_ID}`, `APPROVAL:${lai9.requestId}`].some((k) => i.key.endsWith(k) || i.sourceKey === k));
  assert.deepEqual(cuaBai, [], "mọi việc của mẫu đã đóng bằng hành động của miền ⇒ hàng đợi không còn việc nào của bài");
  const [{ n: workRows }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.workItems).where(or(like(schema.workItems.sourceKey, `%${T}%`), like(schema.workItems.sourceKey, `%${s2.sampleId}%`), like(schema.workItems.sourceKey, `%${monHong.id}%`)));
  assert.equal(Number(workRows), 0, "không một dòng work_items nào được ghi cho các việc chiếu (luật 19)");
  console.log("  ✓ QA-10 · PRODUCTION_TOPIC / SAMPLE_REVIEW / RETURN_DISPOSITION / APPROVAL hiện khi mở, tự rời khi miền đóng; 0 dòng work_items");

  /* ═══════════ LỊCH SỬ VÒNG ĐỜI + SỔ SỰ KIỆN ═══════════ */
  const hist = await db
    .select({ from: schema.productModelStateHistory.fromState, to: schema.productModelStateHistory.toState, actorKind: schema.productModelStateHistory.actorKind, actorId: schema.productModelStateHistory.actorId, reason: schema.productModelStateHistory.reason, ev: schema.domainEvents.name, at: schema.productModelStateHistory.occurredAt })
    .from(schema.productModelStateHistory)
    .leftJoin(schema.domainEvents, eq(schema.domainEvents.id, schema.productModelStateHistory.sourceEventId))
    .where(eq(schema.productModelStateHistory.modelId, M))
    .orderBy(asc(schema.productModelStateHistory.occurredAt), asc(schema.productModelStateHistory.id));
  assert.deepEqual(
    hist.map((h) => `${h.from}>${h.to}@${h.actorKind}${h.ev ? `:${h.ev}` : ""}`),
    [
      "null>ADS_TESTING@USER",
      "ADS_TESTING>WINNER@USER",
      "WINNER>PRODUCTION_DISCUSSION@SYSTEM:production_topic.created",
      "PRODUCTION_DISCUSSION>COSTING@SYSTEM:costing.version_created",
      "COSTING>SAMPLING@SYSTEM:sample.created",
      "SAMPLING>SAMPLE_REVIEW@SYSTEM:sample.submitted",
      "SAMPLE_REVIEW>SAMPLING@SYSTEM:sample.reviewed",
      "SAMPLING>SAMPLE_REVIEW@SYSTEM:sample.submitted",
      "SAMPLE_REVIEW>APPROVED@SYSTEM:sample.approved",
      "APPROVED>PRODUCTION_PLANNING@SYSTEM:production_order.linked_design",
      "PRODUCTION_PLANNING>IN_PRODUCTION@USER",
      "IN_PRODUCTION>SELLING@USER",
    ],
    "lịch sử vòng đời nối đúng chuỗi: người khai / chốt, máy đi theo sự kiện gây ra",
  );
  for (const h of hist) {
    if (h.actorKind === "USER") assert.ok(h.actorId?.startsWith(P), "lượt của người mang khoá tài khoản");
    else assert.equal(h.actorId, null, "lượt của máy không đứng tên người bấm");
  }
  for (let i = 1; i < hist.length; i++) assert.ok(hist[i].from === hist[i - 1].to, `lịch sử liền mạch: ${hist[i - 1].to} → ${hist[i].from}`);
  const [cuoi] = await db.select({ s: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, M));
  assert.equal(cuoi.s, "SELLING");
  assert.ok((MODEL_STATES as readonly ModelState[]).includes(cuoi.s as ModelState));
  // Phát lại sự kiện gây ra: không ghi lượt thứ hai.
  const [evDuyet] = await db.select({ id: schema.domainEvents.id }).from(schema.domainEvents).where(and(eq(schema.domainEvents.modelId, M), eq(schema.domainEvents.name, "sample.approved")));
  const phatLai = await transitionModelCore(db, { modelId: M, to: "APPROVED", actor: { id: null, label: "job:replay" }, actorKind: "SYSTEM", source: "event:sample.approved", sourceEventId: evDuyet.id });
  assert.ok("ok" in phatLai && phatLai.replayed, "phát lại sample.approved ⇒ replayed, không ghi");
  assert.equal((await db.select({ id: schema.productModelStateHistory.id }).from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, M))).length, hist.length, "phát lại không thêm dòng lịch sử");
  // Đồng bộ sổ lần ba sau cả vòng: vẫn không có sự kiện đăng ký thứ hai.
  await syncModelRegistry(db, { triggeredBy: `${P}test` });

  const events = await db
    .select({ name: schema.domainEvents.name, actorKind: schema.domainEvents.actorKind, actorId: schema.domainEvents.actorId, at: schema.domainEvents.occurredAt, dedupeKey: schema.domainEvents.dedupeKey })
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.modelId, M))
    .orderBy(asc(schema.domainEvents.occurredAt), asc(schema.domainEvents.recordedAt));
  const dem = events.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.name]: (acc[e.name] ?? 0) + 1 }), {});
  assert.deepEqual(
    dem,
    {
      "model.registered": 1,
      "model.state_changed": 12,
      "model.owner_changed": 1,
      "production_topic.created": 1,
      "production_topic.message_added": 6,
      "production_topic.status_changed": 3,
      "costing.version_created": 2,
      "costing.finalized": 1,
      "sample.created": 2,
      "sample.submitted": 2,
      "sample.reviewed": 2,
      "sample.approved": 1,
      "design_version.approved": 1,
      "production_order.linked_design": 1,
      "production_plan.overridden": 1,
      "return.disposition_set": 3,
    },
    "sổ sự kiện của mẫu: đúng số lượng từng tên — noop / phát lại / lưu lại / đồng bộ lại / gửi lại cùng khoá KHÔNG đẻ dòng thứ hai",
  );
  const dedupe = events.map((e) => e.dedupeKey).filter((k): k is string => Boolean(k));
  assert.equal(new Set(dedupe).size, dedupe.length, "khoá chống trùng không lặp");
  assert.ok(events.every((e) => e.actorKind !== "USER" || (e.actorId ?? "").startsWith(P)), "sự kiện của người mang khoá tài khoản");
  const lanDau = (name: string) => {
    const e = events.find((x) => x.name === name);
    assert.ok(e, `thiếu sự kiện ${name}`);
    return e.at.getTime();
  };
  const moc = ["model.registered", "production_topic.created", "costing.version_created", "costing.finalized", "sample.created", "sample.approved", "design_version.approved", "production_order.linked_design", "return.disposition_set"];
  for (let i = 1; i < moc.length; i++) assert.ok(lanDau(moc[i - 1]) <= lanDau(moc[i]), `sự kiện theo đúng thứ tự nghiệp vụ: ${moc[i - 1]} trước ${moc[i]}`);
  console.log(`  ✓ QA-3b · lịch sử vòng đời ${hist.length} bước liền mạch (USER khai, SYSTEM đi theo sự kiện); sổ sự kiện ${events.length} dòng, không trùng dù phát lại`);

  /* ═══════════ BƯỚC 11 · DÒNG THỜI GIAN CỦA MẪU ═══════════ */
  const tl = await getModelTimeline(M);
  for (let i = 1; i < tl.length; i++) assert.ok(tl[i - 1].at.getTime() >= tl[i].at.getTime(), "dòng thời gian mới nhất lên trước");
  const tim = (label: string, pred: (e: (typeof tl)[number]) => boolean) => {
    const e = tl.find(pred);
    assert.ok(e, `dòng thời gian thiếu mốc: ${label}`);
    return { label, at: e.at.getTime() };
  };
  const evAt = (name: string) => lanDau(name);
  const mocTl = [
    tim("mẫu vào sổ", (e) => e.dimension === "LIFECYCLE" && e.at.getTime() === evAt("model.registered")),
    tim("đơn đầu tiên", (e) => e.id === `first-order-${P}o1`),
    tim("mở topic sản xuất", (e) => e.at.getTime() === evAt("production_topic.created")),
    tim("giá thành chốt", (e) => e.at.getTime() === evAt("costing.finalized")),
    tim("mẫu được duyệt", (e) => e.at.getTime() === evAt("sample.approved")),
    tim("lệnh SX lập", (e) => e.id === `po-${P}po1`),
    tim("lệnh SX gửi xưởng", (e) => e.id === `po-sent-${P}po1`),
    tim("phiếu nhập hàng", (e) => e.id === `receipt-${P}rc-po1`),
    tim("lệnh SX nhận hàng", (e) => e.id === `po-recv-${P}po1`),
    tim("kết cục hàng hoàn", (e) => e.at.getTime() === evAt("return.disposition_set")),
  ];
  for (let i = 1; i < mocTl.length; i++) assert.ok(mocTl[i - 1].at <= mocTl[i].at, `dòng thời gian theo đúng thứ tự: ${mocTl[i - 1].label} trước ${mocTl[i].label}`);
  const soSuKienTl = tl.filter((e) => e.id.startsWith("event-")).length;
  assert.equal(soSuKienTl, events.length, "mọi sự kiện miền của mẫu đều lên dòng thời gian");
  const suKienTl = tl.filter((e) => e.id.startsWith("event-"));
  const raw = suKienTl.filter((e) => /^[a-z_]+(\.[a-z_]+)+$/.test(e.title));
  assert.deepEqual(raw.map((e) => e.title), [], "mọi sự kiện trên dòng thời gian có nhãn tiếng Việt — không in mã thô (lỗi QA tìm ra: return.disposition_set thiếu nhãn)");
  const theoChieu = (title: string) => [...new Set(suKienTl.filter((e) => e.title === title).map((e) => e.dimension))];
  assert.deepEqual(theoChieu("Đổi trạng thái vòng đời"), ["LIFECYCLE"], "đổi trạng thái vòng đời ở chiều Vòng đời");
  assert.equal(suKienTl.filter((e) => e.title === "Đổi trạng thái vòng đời").length, hist.length, "mọi lượt đổi trạng thái vòng đời có mặt");
  for (const t of ["Mở topic sản xuất", "Chốt giá thành", "Mẫu được duyệt", "Bản thiết kế đã duyệt", "Lệnh SX trỏ bản duyệt"]) {
    assert.deepEqual(theoChieu(t), ["PRODUCTION"], `"${t}" đứng ở chiều Sản xuất (lỗi QA tìm ra: mọi sự kiện bị gán chiều Vòng đời)`);
  }
  assert.deepEqual(theoChieu("Kết cục hàng hoàn không tái nhập"), ["INVENTORY"], "kết cục hàng hoàn đứng ở chiều Kho");
  console.log(`  ✓ QA-11 · dòng thời gian ${tl.length} mốc, đúng thứ tự: vào sổ → đơn đầu → topic → giá chốt → duyệt mẫu → lệnh SX → gửi xưởng → nhập hàng → nhận lệnh → kết cục hàng hoàn`);

  // Mẫu khác do lượt đồng bộ sổ tạo ra (CSDL dùng chung có sản phẩm khác mang mã) bị dọn ở `donDep`.
  const moiNgoaiBai = (await db.select({ id: schema.productModels.id, code: schema.productModels.code }).from(schema.productModels)).filter((m) => !keepModels.has(m.id) && m.code !== CODE);
  if (moiNgoaiBai.length) console.log(`  · đồng bộ sổ mẫu của bài cũng đăng ký ${moiNgoaiBai.length} mã khác của CSDL dùng chung — sẽ dọn ở cuối bài`);
}
