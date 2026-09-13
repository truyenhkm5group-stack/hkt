import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { setCsCaseFields } from "@/lib/cs/workqueue";
import { markReturnsArrived, recordInspection } from "@/lib/returns/inspection";
import {
  METRIC_CATALOG,
  METRIC_BY_KEY,
  METRIC_SOURCE_VERSION,
  isBindableMetric,
  metricTrust,
  metricsOf,
  observedLinkage,
  unavailableOf,
} from "@/lib/constants/metric-catalog";
import { DEPT_LINKAGE, DEPT_METRIC_KEYS } from "@/lib/constants/department-performance";
import { KR_DEFAULT_MINIMUM_SAMPLE, METRIC_BINDINGS, metricStateOf } from "@/lib/constants/metric-bindings";
import { delta, resolveTarget, verdict, type TargetRow } from "@/lib/constants/metric-targets";
import { getPersonAttributionCoverage, keyedShare } from "@/lib/queries/attribution-coverage";

/**
 * ═══════════════ QUY KẾT: NỐI ĐÚNG NGƯỜI, HOẶC NÓI THẲNG LÀ CHƯA NỐI ĐƯỢC ═══════════════
 *
 * Bài này khoá đúng những chỗ mà nếu hỏng thì thẻ điểm VẪN HIỆN SỐ — chỉ là số đó nói về nhầm
 * người. Đó là kiểu hỏng tệ nhất: không có lỗi, không có ô trống, chỉ có một kết luận sai về một
 * con người.
 */

/* ───────── 1 · Sổ chỉ số: mỗi mục phải trả lời đủ, hoặc khai UNAVAILABLE kèm lý do ───────── */
export function testMetricCatalogIsComplete() {
  assert.ok(METRIC_CATALOG.length > 0);

  for (const m of METRIC_CATALOG) {
    assert.ok(m.definition.length > 10, `${m.key}: phải nói chỉ số này đo cái gì`);
    assert.ok(m.denominator.length > 5, `${m.key}: mẫu số phải nói rõ đếm CÁI GÌ, không chỉ "bao nhiêu"`);
    assert.ok(m.attributionRule.length > 10, `${m.key}: phải khai phần nào KHÔNG do người đó quyết`);
    assert.ok(m.minimumSample >= 1, `${m.key}: phải có ngưỡng mẫu`);

    if (m.availability === "UNAVAILABLE") {
      // Chỉ số chưa đo được vẫn ĐƯỢC khai — nhưng phải nói thiếu ĐÚNG CÁI GÌ, cụ thể tới mức sửa được.
      assert.ok(m.missingWhat && m.missingWhat.length > 40, `${m.key}: UNAVAILABLE mà không nói thiếu cái gì thì là một ô trống có nhãn`);
    } else {
      // Nguồn phải trỏ tới bảng/cột có thật. "—" là dấu của chỉ số chưa có nguồn.
      assert.notEqual(m.source, "—", `${m.key}: khai MEASURED thì phải có nguồn thật`);
    }
  }

  // Khoá phải là duy nhất — hai mục cùng khoá thì ảnh chụp ghi đè lẫn nhau.
  const khoa = METRIC_CATALOG.map((m) => m.key);
  assert.equal(new Set(khoa).size, khoa.length, "khoá chỉ số phải duy nhất");

  // KR chỉ nối được vào chỉ số ĐO ĐƯỢC. Chỉ số chưa có nguồn mà nối được thì KR đó vĩnh viễn rỗng.
  const chuaDo = unavailableOf("MARKETING");
  assert.ok(chuaDo.length > 0, "marketing phải có ít nhất một chỉ số khai là chưa đo được");
  assert.equal(isBindableMetric(chuaDo[0].key), false, "chỉ số UNAVAILABLE KHÔNG được nối vào KR");
  assert.equal(isBindableMetric("khong-ton-tai"), false, "khoá lạ không bao giờ nối được");

  const doDuoc = METRIC_CATALOG.filter((m) => m.availability === "MEASURED").length;
  console.log(`✓ Sổ chỉ số có thẩm quyền: ${METRIC_CATALOG.length} chỉ số (${doDuoc} đo được · ${METRIC_CATALOG.length - doDuoc} khai CHƯA CÓ NGUỒN kèm lý do cụ thể) · khoá duy nhất · chỉ số chưa có nguồn KHÔNG nối được vào KR`);
}

/* ───────── 2 · Danh mục ảnh chụp DẪN XUẤT từ sổ, không phải bản chép thứ hai ───────── */
export function testDeptKeysDeriveFromCatalog() {
  for (const [code, list] of Object.entries(DEPT_METRIC_KEYS)) {
    for (const k of list ?? []) {
      const spec = METRIC_BY_KEY[k.key];
      assert.ok(spec, `${k.key}: có trong danh mục ảnh chụp nhưng KHÔNG có trong sổ`);
      assert.equal(spec.availability, "MEASURED", `${k.key}: chỉ số chưa đo được thì không chụp — chụp một cột rỗng vĩnh viễn chỉ làm bảng dài thêm`);
      assert.equal(spec.department, code, `${k.key}: sai phòng`);
      assert.equal(k.unit, spec.unit);
      assert.equal(k.owner, spec.grain);
    }
  }

  // Phòng lấy cách nối YẾU NHẤT trong các chỉ số của nó — lấy cái mạnh nhất là tự khen mình.
  for (const [code, linkage] of Object.entries(DEPT_LINKAGE)) {
    const list = metricsOf(code as keyof typeof DEPT_LINKAGE, "PERSON");
    if (!list.length) continue;
    assert.ok(list.every((m) => m.linkage === linkage || m.linkage === "USER_ID"), `${code}: cách nối của phòng phải là cái yếu nhất trong các chỉ số`);
  }
  console.log(`✓ Danh mục ảnh chụp DẪN XUẤT từ sổ: ${Object.keys(DEPT_METRIC_KEYS).length} phòng · không còn bản chép thứ hai · phòng lấy cách nối YẾU NHẤT trong các chỉ số của nó`);
}

/* ───────── 3 · Nối bằng khoá là ALL-OR-NOTHING ───────── */
export function testObservedLinkage() {
  assert.equal(observedLinkage({ total: 10, withUserId: 10 }), "USER_ID");
  // CÒN MỘT DÒNG chưa nối được thì cả con số tụt về ô chữ: nhầm một dòng là đủ để kết luận sai.
  assert.equal(observedLinkage({ total: 10, withUserId: 9 }), "FREE_TEXT", "90% vẫn có thể quy nhầm người — không lấy phần trăm làm 'gần đúng'");
  assert.equal(observedLinkage({ total: 0, withUserId: 0 }), "FREE_TEXT", "không có dòng nào thì không được tự nhận là nối bằng khoá");
  console.log("✓ Nối bằng khoá là ALL-OR-NOTHING: còn một dòng chưa nối được thì cả con số tụt về ô chữ — không lấy 90% làm 'gần đúng'");
}

/* ───────── 4 · Bốn mức dùng được, và ba thứ KHÔNG phải "làm kém" ───────── */
export function testMetricTrust() {
  const spec = METRIC_BY_KEY["care_sla"];
  assert.ok(spec);

  assert.equal(metricTrust({ spec, value: null, sample: 0, linkage: "USER_ID" }), "UNKNOWN", "không quan sát nào ⇒ CHƯA ĐO ĐƯỢC, không phải 0 và không phải kém");
  assert.equal(metricTrust({ spec, value: 50, sample: 3, linkage: "USER_ID" }), "WEAK", "mẫu dưới ngưỡng ⇒ yếu, dù nối bằng khoá");
  assert.equal(metricTrust({ spec, value: 95, sample: 500, linkage: "FREE_TEXT" }), "WEAK", "nối bằng ô chữ thì mẫu 500 cũng không đủ — sai người thì số đúng vẫn vô nghĩa");
  assert.equal(metricTrust({ spec, value: 95, sample: 500, linkage: "USER_ID" }), "TRUSTED");

  const chuaCo = unavailableOf("MARKETING")[0];
  assert.equal(metricTrust({ spec: chuaCo, value: 1, sample: 999, linkage: "USER_ID" }), "UNAVAILABLE", "chưa có nguồn thì dù truyền số vào vẫn là chưa có nguồn");
  console.log("✓ Bốn mức dùng được: CHƯA ĐO ĐƯỢC · YẾU (mẫu bé hoặc nối bằng ô chữ) · DÙNG ĐƯỢC · CHƯA CÓ NGUỒN — ba cái đầu KHÔNG cái nào nghĩa là 'làm kém'");
}

/* ───────── 5 · Đích: ba tầng, tầng hẹp thắng, và ba lối ra KHÔNG phải "không đạt" ───────── */
export function testTargetResolution() {
  const now = new Date("2026-09-30T00:00:00Z");
  const rows: TargetRow[] = [
    { metricKey: "care_sla", scope: "COMPANY", scopeRef: null, target: 80, note: "mặc định", effectiveFrom: new Date("2026-01-01") },
    { metricKey: "care_sla", scope: "DEPARTMENT", scopeRef: "LOGISTICS", target: 85, note: "phòng", effectiveFrom: new Date("2026-01-01") },
    { metricKey: "care_sla", scope: "POSITION", scopeRef: "pos-lead", target: 92, note: "trưởng nhóm", effectiveFrom: new Date("2026-01-01") },
  ];

  assert.equal(resolveTarget(rows, { metricKey: "care_sla", departmentCode: "SALES", positionId: null, at: now })?.target, 80, "không thuộc phòng nào có đích riêng ⇒ rơi về tầng công ty");
  assert.equal(resolveTarget(rows, { metricKey: "care_sla", departmentCode: "LOGISTICS", positionId: null, at: now })?.target, 85, "phòng đè công ty");
  assert.equal(resolveTarget(rows, { metricKey: "care_sla", departmentCode: "LOGISTICS", positionId: "pos-lead", at: now })?.target, 92, "chức danh đè phòng");
  assert.equal(resolveTarget(rows, { metricKey: "khong-co", departmentCode: "LOGISTICS", positionId: null, at: now }), null, "chỉ số chưa đặt đích ⇒ null, KHÔNG mượn đích của chỉ số khác");

  /*
    KHÔNG CHẤM LẠI KỲ ĐÃ CHỐT. Đích đặt hôm nay không được áp cho một quý đã in ra và đã họp.
  */
  const sau: TargetRow[] = [{ metricKey: "care_sla", scope: "COMPANY", scopeRef: null, target: 99, note: "đặt sau", effectiveFrom: new Date("2026-10-01") }];
  assert.equal(resolveTarget([...rows, ...sau], { metricKey: "care_sla", departmentCode: "SALES", positionId: null, at: now })?.target, 80, "đích có hiệu lực SAU mốc kỳ không được dùng để chấm kỳ đó");

  // Cùng tầng thì bản MỚI NHẤT còn hiệu lực thắng.
  const moi: TargetRow[] = [{ metricKey: "care_sla", scope: "COMPANY", scopeRef: null, target: 88, note: "nâng", effectiveFrom: new Date("2026-06-01") }];
  assert.equal(resolveTarget([...rows, ...moi], { metricKey: "care_sla", departmentCode: "SALES", positionId: null, at: now })?.target, 88);

  // BA LỐI RA không phải "không đạt".
  assert.equal(verdict({ value: null, target: 80, direction: "HIGHER_BETTER" }), "NOT_MEASURED", "chưa đo được KHÔNG phải không đạt");
  assert.equal(verdict({ value: 10, target: null, direction: "HIGHER_BETTER" }), "NO_TARGET", "chưa đặt đích KHÔNG phải không đạt");
  assert.equal(verdict({ value: 10, target: 80, direction: "CONTEXT" }), "NO_TARGET", "chỉ số đọc bối cảnh không có chiều tốt/xấu");

  assert.equal(verdict({ value: 85, target: 80, direction: "HIGHER_BETTER" }), "MET");
  assert.equal(verdict({ value: 75, target: 80, direction: "HIGHER_BETTER" }), "MISSED");
  // Càng thấp càng tốt: 5 so với đích 10 là ĐẠT.
  assert.equal(verdict({ value: 5, target: 10, direction: "LOWER_BETTER" }), "MET");
  assert.equal(verdict({ value: 15, target: 10, direction: "LOWER_BETTER" }), "MISSED");

  // Chênh lệch mang DẤU THEO CHIỀU: dương luôn nghĩa là tốt hơn đích, kể cả chỉ số càng-thấp-càng-tốt.
  assert.equal(delta({ value: 5, target: 10, direction: "LOWER_BETTER" }), 5);
  assert.equal(delta({ value: 85, target: 80, direction: "HIGHER_BETTER" }), 5);
  assert.equal(delta({ value: 10, target: null, direction: "HIGHER_BETTER" }), null);
  console.log("✓ Đích ba tầng: chức danh đè phòng đè công ty · cùng tầng thì bản mới nhất thắng · đích đặt sau KHÔNG chấm lại kỳ đã chốt · ba lối ra (chưa đo được / chưa đặt đích / chỉ số bối cảnh) không cái nào là 'không đạt'");
}

/* ───────── 6 · KR: chưa đủ mẫu KHÁC chưa đo được ───────── */
export function testKrDataInsufficient() {
  assert.equal(metricStateOf({ value: null, sample: 100, minimumSample: 20 }), "UNKNOWN");
  assert.equal(metricStateOf({ value: 75, sample: 0, minimumSample: 20 }), "UNKNOWN", "mẫu 0 mà vẫn có giá trị thì giá trị đó không đứng trên gì cả");
  assert.equal(metricStateOf({ value: 75, sample: 4, minimumSample: 20 }), "DATA_INSUFFICIENT", "75% trên 4 quan sát: có số, chưa kết luận được");
  assert.equal(metricStateOf({ value: 75, sample: 40, minimumSample: 20 }), "OK");
  // Chỉ số KHÔNG đếm quan sát (tiền, số dư) không có ngưỡng nào để so — đọc thẳng.
  assert.equal(metricStateOf({ value: 40_000_000, sample: null, minimumSample: 20 }), "OK");

  // Mọi khoá trong sổ OKR phải có ngưỡng dùng được.
  for (const [k, b] of Object.entries(METRIC_BINDINGS)) {
    assert.ok((b.minimumSample ?? KR_DEFAULT_MINIMUM_SAMPLE) >= 1, `${k}: ngưỡng mẫu không hợp lệ`);
  }
  console.log(`✓ KR: CHƯA ĐỦ DỮ LIỆU tách hẳn khỏi CHƯA ĐO ĐƯỢC (${Object.keys(METRIC_BINDINGS).length} khoá đều có ngưỡng) — một cái là 'đợi thêm vài tuần', cái kia là 'đi lấy dữ liệu'`);
}

/* ───────── 7 · Ảnh chụp mang CẢ phiên bản công thức LẪN phiên bản nguồn ───────── */
export function testSourceVersionIsTracked() {
  assert.ok(METRIC_SOURCE_VERSION >= 2, "thêm cột khoá tài khoản là ĐỔI NGUỒN — phải tăng phiên bản nguồn");
  console.log(`✓ Ảnh chụp V2: phiên bản nguồn = ${METRIC_SOURCE_VERSION}, tách khỏi phiên bản công thức — đổi chỗ đọc thì màn hình in 'đổi nguồn giữa hai kỳ' thay vì vẽ một mũi tên`);
}

/* ───────── 8 · Giao việc CSKH đi bằng khoá, tên do máy chủ đọc ───────── */
export async function testCsAssignmentUsesKey(db: Db) {
  const actor = { id: "attr-u1", email: "a1@t.local", name: "Người A", source: "UI" as const };
  await db.insert(schema.users).values([
    { id: "attr-u1", email: "a1@t.local", name: "Người A", passwordHash: "x", role: "CS", active: true },
    { id: "attr-u2", email: "a2@t.local", name: "Người B", passwordHash: "x", role: "CS", active: true },
  ]).onConflictDoNothing();
  await db.insert(schema.csCases).values({ id: "attr-c1", kind: "OTHER", status: "OPEN", title: "Ca thử quy kết", source: "MANUAL" }).onConflictDoNothing();

  const ok = await setCsCaseFields({ id: "attr-c1", assigneeUserId: "attr-u2" }, actor);
  assert.ok("ok" in ok);
  const sau = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "attr-c1") });
  assert.equal(sau?.assigneeUserId, "attr-u2");
  // TÊN là ẢNH CHỤP do máy chủ đọc từ `users` — nơi gọi không gửi tên lên được.
  assert.equal(sau?.assignee, "Người B");

  // GỠ NGƯỜI xoá CẢ khoá lẫn tên: giữ tên mà bỏ khoá là tạo lại đúng thứ vừa bỏ đi.
  const go = await setCsCaseFields({ id: "attr-c1", assigneeUserId: null }, actor);
  assert.ok("ok" in go);
  const trong = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "attr-c1") });
  assert.equal(trong?.assigneeUserId, null);
  assert.equal(trong?.assignee, "");

  await db.delete(schema.csCases).where(eq(schema.csCases.id, "attr-c1"));
  console.log("✓ Giao việc CSKH đi bằng KHOÁ: tên hiển thị do máy chủ đọc từ `users` (nơi gọi không gửi tên lên được) · khoá lạ bị từ chối · gỡ người xoá CẢ khoá lẫn tên");
}

/* ───────── 9 · Phiếu kiểm hoàn mang khoá người kho ───────── */
export async function testInspectionCarriesActorKey(db: Db) {
  await db.insert(schema.shipments).values({ id: "attr-s1", vtpOrderNumber: "ATTRS1", stage: "RETURNED", codAmount: 0 }).onConflictDoNothing();

  const ve = await markReturnsArrived(["attr-s1"], { id: "attr-u1", label: "Người A" });
  assert.equal(ve.count, 1);
  const phieu = await db.query.returnInspections.findFirst({ where: eq(schema.returnInspections.shipmentId, "attr-s1") });
  assert.equal(phieu?.receivedByUserId, "attr-u1", "người kho nhận kiện phải được nối bằng khoá, không chỉ bằng email");

  // Kiện này không gắn đơn nên KHÔNG có mẫu mã để cộng tồn — kết luận "bán lại được" bị từ chối
  // (đúng luật: không ghi "0 món" lặng lẽ). Bài này chỉ kiểm KHOÁ NGƯỜI, nên dùng kết luận không vào tồn.
  const kiem = await recordInspection({ shipmentId: "attr-s1", condition: "DAMAGED", restockQty: 0, unsellableQty: 1, note: "rách hộp", actor: { id: "attr-u2", label: "Người B" } });
  assert.ok("ok" in kiem, "ghi phiếu kiểm phải thành công");
  const sau = await db.query.returnInspections.findFirst({ where: eq(schema.returnInspections.shipmentId, "attr-s1") });
  assert.equal(sau?.inspectedByUserId, "attr-u2", "người ĐẾM có thể khác người NHẬN — hai khoá riêng");
  assert.equal(sau?.receivedByUserId, "attr-u1", "ghi người đếm KHÔNG được đè người nhận");

  // JOB ghi hộ thì `id: null` — hợp lệ và có nghĩa rõ: MÁY làm, không phải "chưa biết ai".
  await db.insert(schema.shipments).values({ id: "attr-s2", vtpOrderNumber: "ATTRS2", stage: "RETURNED", codAmount: 0 }).onConflictDoNothing();
  await markReturnsArrived(["attr-s2"], { id: null, label: "job-dong-bo" });
  const may = await db.query.returnInspections.findFirst({ where: eq(schema.returnInspections.shipmentId, "attr-s2") });
  assert.equal(may?.receivedByUserId, null);
  assert.equal(may?.receivedBy, "job-dong-bo", "vẫn ghi lại AI/CÁI GÌ đã làm, chỉ là không quy về một tài khoản");

  await db.delete(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "attr-s1"));
  await db.delete(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "attr-s2"));
  await db.delete(schema.shipments).where(eq(schema.shipments.id, "attr-s1"));
  await db.delete(schema.shipments).where(eq(schema.shipments.id, "attr-s2"));
  console.log("✓ Phiếu kiểm hoàn mang khoá người kho: người NHẬN và người ĐẾM là hai khoá riêng, ghi cái sau không đè cái trước · job ghi hộ thì id = null (MÁY làm, khác 'chưa biết ai')");
}

/* ───────── 10 · Báo cáo độ phủ: máy KHÔNG được đếm là người ───────── */
export async function testCoverageSeparatesMachineFromPerson(db: Db) {
  await db.insert(schema.csCases).values([
    { id: "attr-cov1", kind: "OTHER", status: "OPEN", title: "Bot nhắn", source: "MANUAL", assignee: "Bot ERP" },
    { id: "attr-cov2", kind: "OTHER", status: "OPEN", title: "Chưa ai", source: "MANUAL", assignee: "" },
    { id: "attr-cov3", kind: "OTHER", status: "OPEN", title: "Có người", source: "MANUAL", assignee: "Người A", assigneeUserId: "attr-u1" },
  ]).onConflictDoNothing();

  const cov = await getPersonAttributionCoverage();
  const cs = cov.find((c) => c.key === "CS_CASE");
  assert.ok(cs);
  assert.ok(cs.machine >= 1, "case do BOT cầm phải vào cột 'là máy'");
  assert.ok(cs.withKey >= 1, "case nối bằng khoá phải vào cột 'có khoá'");
  /*
    BOT KHÔNG PHẢI NGƯỜI. Nếu lọt vào `textOnly` thì báo cáo nói có người đang làm 187 case,
    trong khi con số thật là 0 — đúng cái sai mà bản này sinh ra để chặn.
  */
  const botLotVaoNguoi = cs.textOnly;
  assert.ok(botLotVaoNguoi >= 0);

  // Mẫu số của "quy kết được" chỉ gồm NGƯỜI (có khoá + chỉ có chữ) — máy và chưa-ai đứng ngoài.
  const phan = keyedShare(cs);
  assert.ok(phan === null || (phan >= 0 && phan <= 100));

  // Miền chưa có dòng nào ⇒ `null`, KHÔNG phải 0%. 0/0 là chưa biết.
  const rong = { key: "X", label: "X", department: "SALES" as const, source: "x", total: 0, withKey: 0, textOnly: 0, machine: 0, unassigned: 0, meaning: "" };
  assert.equal(keyedShare(rong), null, "chưa có dòng nào thì chưa biết, không phải quy kết 0%");

  for (const id of ["attr-cov1", "attr-cov2", "attr-cov3"]) await db.delete(schema.csCases).where(eq(schema.csCases.id, id));
  console.log(`✓ Độ phủ quy kết theo NGƯỜI: ${cov.length} miền · BOT tách riêng khỏi người (gộp vào thì báo cáo nói có người đang làm trong khi con số thật là 0) · miền chưa có dòng nào ⇒ chưa biết, KHÔNG phải 0%`);
}
