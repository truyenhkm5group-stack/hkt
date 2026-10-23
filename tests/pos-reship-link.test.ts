/**
 * ═══ ops `pos-reship-link` — GẮN MÃ VẬN ĐƠN VTP TẠO LẠI VÀO ĐƠN PANCAKE POS (P0 22/10/2026) ═══
 *
 * Khoá các luật đã duyệt: mặc định CHẠY THỬ · `--apply` bắt buộc kèm `--limit` · thân PUT CHỈ khối partner (không status) · không đè mã
 * lạ · idempotent · đọc lại + so field khác · ghi nhật ký · ops khai đủ bốn chỗ. Không gọi mạng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { lastLinkRecord, linkBody, linkPlan, parseReshipArgs, partnerOf, readPairs, rollbackBody, rollbackPlan, unexpectedChanges } from "../scripts/pos-reship-link";
import { readFileSync as readFixture } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { vanDonDaiDien } from "@/lib/constants/shipment-pick";
import { mapOrder } from "@/lib/integrations/pancake/mapper";
import { upsertOrder } from "@/lib/integrations/pancake/sync";

export function testPosReshipLink() {
  // Đối số: chạy thử mặc định; ghi thì PHẢI có --limit.
  assert.deepEqual(parseReshipArgs([]), { apply: false, limit: 20, pilot: false, order: null, rollback: false });
  assert.deepEqual(parseReshipArgs(["--apply"]), { error: "--apply bắt buộc kèm --limit=N (pilot: --limit=1)" }, "không bao giờ ghi hàng loạt vì quên một cờ");
  assert.deepEqual(parseReshipArgs(["--apply", "--limit=1", "--pilot"]), { apply: true, limit: 1, pilot: true, order: null, rollback: false });
  assert.deepEqual(parseReshipArgs(["--rollback", "--order=1234567"]), { apply: false, limit: 20, pilot: false, order: "1234567", rollback: true });
  assert.ok("error" in parseReshipArgs(["--rollback"]), "gỡ bắt buộc chỉ đích danh MỘT đơn");
  assert.ok("error" in parseReshipArgs(["--rollback", "--order=1", "--apply", "--limit=1"]) && "error" in parseReshipArgs(["--rollback", "--order=1", "--pilot"]), "gỡ không đi cùng ghi hàng loạt");
  assert.ok("error" in parseReshipArgs(["--limit=0"]) && "error" in parseReshipArgs(["--limit=1001"]) && "error" in parseReshipArgs(["--limit=abc"]));
  assert.ok("error" in parseReshipArgs(["--order=1;drop"]), "mã đơn chỉ chữ / số");
  assert.equal((parseReshipArgs(["--order=1234567"]) as { order: string }).order, "1234567");

  // Kế hoạch: đã đúng ⇒ không PUT; trống / mã gốc ⇒ gắn; mã lạ ⇒ không đè.
  const OLD = "PKE111";
  const NEW = "PKE222";
  assert.equal(linkPlan({ extend_code: NEW, order_number_vtp: NEW }, OLD, NEW), "ALREADY", "idempotent");
  // Hình dạng THẬT (chạy thử 23/10/2026, 20/20 đơn): order_number_vtp = mã gốc, extend_code = mã do Pancake cấp ⇒ GẮN, không phải mã lạ.
  assert.equal(linkPlan({ extend_code: "PKE10948632210", order_number_vtp: OLD }, OLD, NEW), "LINK", "extend_code (mã Pancake) không tham gia kế hoạch");
  assert.equal(linkPlan({ extend_code: "PKE10948632210", order_number_vtp: NEW }, OLD, NEW), "ALREADY", "đã gắn mã mới ⇒ không PUT lại, bất kể extend_code");
  assert.equal(linkPlan({ extend_code: OLD, order_number_vtp: OLD }, OLD, NEW), "LINK");
  assert.equal(linkPlan({ extend_code: null, order_number_vtp: null }, OLD, NEW), "LINK", "đơn chưa có mã ⇒ gắn");
  assert.equal(linkPlan({ extend_code: null, order_number_vtp: OLD }, OLD, NEW), "LINK");
  assert.equal(linkPlan({ extend_code: null, order_number_vtp: "GHN999" }, OLD, NEW), "FOREIGN_CODE", "mã ĐVVC khác ⇒ không đè");
  assert.equal(linkPlan({ extend_code: null, order_number_vtp: OLD }, null, NEW), "FOREIGN_CODE", "không đọc được mã gốc ⇒ mã đang có là mã lạ");
  assert.equal(linkPlan({ extend_code: null, order_number_vtp: null }, null, NEW), "LINK", "không đọc được mã gốc, ô trống ⇒ vẫn gắn");
  assert.equal(linkPlan({ extend_code: null, order_number_vtp: "pke111" }, OLD, NEW), "LINK", "mã gốc viết thường không phải mã lạ");
  assert.equal(linkPlan({ extend_code: "pke222", order_number_vtp: " PKE222 " }, OLD, NEW), "ALREADY", "mã mới viết thường ⇒ đã gắn, không PUT lại");
  assert.deepEqual(partnerOf({ partner: { extend_code: " pke222 ", order_number_vtp: "" } }), { extend_code: "PKE222", order_number_vtp: null });
  assert.deepEqual(partnerOf({}), { extend_code: null, order_number_vtp: null });

  // Thân PUT: ĐÚNG khối partner hai mã — không status, không field nào khác.
  assert.deepEqual(linkBody(NEW), { partner: { order_number_vtp: NEW } }, "chỉ mã VTP — không bao giờ ghi extend_code (mã do Pancake cấp)");
  assert.ok(!JSON.stringify(linkBody(NEW)).includes("status"), "không bao giờ đổi trạng thái đơn");

  // Gỡ: chỉ khi POS đang = mã mới script đã ghi; mã khác ⇒ không đè; mã cũ trống ⇒ không gửi null; không có vết ⇒ không làm gì.
  const rec = { oldCode: OLD, newCode: NEW };
  assert.equal(rollbackPlan({ extend_code: "PKE10948632210", order_number_vtp: NEW }, rec), "ROLLBACK");
  assert.equal(rollbackPlan({ extend_code: null, order_number_vtp: OLD }, rec), "ALREADY", "đã gỡ ⇒ không PUT lại");
  assert.equal(rollbackPlan({ extend_code: null, order_number_vtp: "GHN999" }, rec), "FOREIGN_CODE", "người khác đã sửa sau script ⇒ không đè");
  assert.equal(rollbackPlan({ extend_code: null, order_number_vtp: NEW }, { oldCode: null, newCode: NEW }), "NO_OLD_CODE", "mã cũ trống ⇒ không gửi null");
  assert.equal(rollbackPlan({ extend_code: null, order_number_vtp: NEW }, null), "NO_RECORD");
  assert.deepEqual(rollbackBody(OLD), { partner: { order_number_vtp: OLD } });

  // So trước / sau: chỉ hai mã + dấu vết sửa được đổi; field khác đổi ⇒ liệt kê TÊN.
  const before = { status: 2, total_price: 400_000, note: "x", partner: { extend_code: OLD, order_number_vtp: OLD, partner_status: "delivered", total_fee: 30_000 }, updated_at: "a", last_editor: { id: "1" } };
  const ok = { ...before, partner: { ...before.partner, order_number_vtp: NEW }, updated_at: "b", last_editor: { id: "2" } };
  assert.deepEqual(unexpectedChanges(before, ok), [], "chỉ đổi đúng mã VTP ⇒ không báo");
  assert.deepEqual(unexpectedChanges(before, { ...ok, partner: { ...ok.partner, extend_code: null } }), ["partner.extend_code"], "PUT lỡ xoá / đổi extend_code ⇒ báo đúng tên");
  assert.deepEqual(unexpectedChanges(before, { ...ok, status: 3, partner: { ...ok.partner, partner_status: "returned" } }), ["partner.partner_status", "status"], "PUT làm đổi field khác ⇒ báo đúng tên");

  // Mã nguồn: chạy thử chỉ đọc; PUT chỉ trong nhánh --apply + LINK; đọc lại ngay; ghi nhật ký; tóm tắt không mang mã đơn.
  const src = readFileSync("scripts/pos-reship-link.ts", "utf8");
  // MỘT luật ghép ở ERP: ứng viên = lần gửi chính (PRIMARY_ATTEMPT) mang vết `raw.reship` — script không tự ghép theo tham chiếu.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(code, /join "orders" on "orders"\."id" = "shipments"\."order_id" and \$\{PRIMARY_ATTEMPT\}/, "lần gửi chính theo đúng PRIMARY_ATTEMPT");
  assert.match(code, /where "shipments"\."raw" -> 'reship' ->> 'of' is not null/, "chỉ lần gửi kế do luật gắn của ERP tạo / gắn");
  assert.doesNotMatch(code, /order_reference/, "không ghép lại bằng tham chiếu (bản đầu đếm 698, 368 là chặng hoàn)");
  assert.match(code, /!~ '\[0-9\]P\[0-9\]\+\$'/, "mã chặng hoàn …P… không bao giờ lên POS");
  assert.match(src, /if \(CHAY_THANG && !process\.argv\.includes\("--apply"\) && !process\.argv\.includes\("--rollback"\)\) process\.env\.ERP_READ_ONLY = "1";/, "chạy thử ⇒ CSDL chỉ đọc");
  assert.equal((src.match(/pos\("PUT"/g) ?? []).length, 2, "đúng HAI chỗ PUT: gắn và gỡ");
  const putAt = src.indexOf('pos("PUT", p.orderId, linkBody(');
  const undoAt = src.indexOf('pos("PUT", orderId, rollbackBody(');
  assert.ok(undoAt > 0 && src.lastIndexOf('if (plan !== "ROLLBACK" || !rec?.oldCode) return', undoAt) > 0, "PUT gỡ chỉ chạy khi kế hoạch là ROLLBACK");
  assert.ok(src.indexOf('pos("GET", orderId).catch', undoAt) > undoAt, "đọc lại NGAY sau PUT gỡ");
  assert.equal((src.match(/before: \{ partner: asRecord\(before\.partner\) \}/g) ?? []).length, 2, "audit lưu NGUYÊN khối partner trước PUT — cả gắn lẫn gỡ");
  assert.ok(src.lastIndexOf('if (!args.apply || plan !== "LINK") continue;', putAt) > 0, "PUT chỉ chạy khi --apply và kế hoạch là LINK");
  assert.ok(src.indexOf('pos("GET", p.orderId).catch', putAt) > putAt, "đọc lại NGAY sau PUT");
  assert.match(src, /await audit\(\{[\s\S]*?action: "pos\.reship_link"/, "ghi nhật ký ERP");
  assert.match(src, /assertHomeCredentials\("pancake"\)/, "chỉ khoá POS của tổ chức nhà");
  assert.match(src, /maskPancakeKey\(/, "câu lỗi che khoá");
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ""), /tomTat\([^\n]*\$\{p\.(orderId|oldCode|newCode)/, "tóm tắt không mang mã đơn / mã vận đơn");
  assert.doesNotMatch(src, /bill_full_name|bill_phone_number|phone_number/, "không đọc / in tên, SĐT");

  // ops khai đủ bốn chỗ.
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- pos-reship-link\s+#/, "lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bpos-reship-link\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bpos-reship-link\b/, "làn chạy riêng");
  assert.match(ops, /pos-reship-link\)\n[\s\S]*?scripts\/pos-reship-link\.ts ;;/, "nhánh chạy");
  console.log("✓ ops pos-reship-link: ứng viên = lần gửi chính do ERP gắn (không tự ghép) · chạy thử mặc định · --apply bắt buộc --limit · PUT chỉ partner (không status) · không đè mã lạ · idempotent · đọc lại + so field · nhật ký · ops khai đủ");
}

/**
 * Nguồn ứng viên chạy trên CSDL thật (PGlite): chỉ đơn mà LẦN GỬI CHÍNH là lần gửi kế ERP đã gắn (`raw.reship.of`). Chặng hoàn mồ
 * côi `…P…` và vận đơn tạo lại CHƯA gắn (dù tham chiếu trùng mã gốc) không bao giờ ra — đó là 368/698 của bản đầu. Dọn sạch sau bài.
 */
export async function testPosReshipLinkDb(db: Db) {
  const s = schema.shipments;
  const donDep = async () => {
    await db.delete(s).where(like(s.id, "pos-rl-%"));
    await db.delete(schema.orders).where(like(schema.orders.id, "pos-rl-%"));
    await db.delete(schema.auditLogs).where(like(schema.auditLogs.entityId, "pos-rl-%"));
  };
  await donDep();
  try {
    const order = (id: string, systemId: number) => db.insert(schema.orders).values({ id, systemId, stage: "CANCELLED", cod: 499000, insertedAt: new Date("2026-10-15T00:00:00Z") });
    const ship = (v: { id: string; orderId: string | null; code: string; stage: "CANCELLED" | "DELIVERED" | "IN_TRANSIT" | "RETURNED"; attemptNo?: number; ref?: string; reshipOf?: string; at: string }) =>
      db.insert(s).values({ id: v.id, orderId: v.orderId, carrier: "Viettel Post", vtpOrderNumber: v.code, trackingCode: v.code, orderReference: v.ref ?? null, stage: v.stage, attemptNo: v.attemptNo ?? null, raw: v.reshipOf ? { reship: { of: v.reshipOf, by: "VTP_WEBHOOK", at: v.at } } : null, createdAt: new Date(v.at) });
    // (1) Gốc huỷ, lần gửi kế đã giao ⇒ ứng viên (nhóm pilot).
    await order("pos-rl-o1", 993001);
    await ship({ id: "pos-rl-s1", orderId: "pos-rl-o1", code: "PKERL0001", stage: "CANCELLED", attemptNo: 1, at: "2026-10-15T01:00:00Z" });
    await ship({ id: "pos-rl-s2", orderId: "pos-rl-o1", code: "823400000001", stage: "DELIVERED", attemptNo: 2, ref: "PKERL0001", reshipOf: "pos-rl-s1", at: "2026-10-16T01:00:00Z" });
    // (2) Lần gửi GỐC đã giao ⇒ lần gửi chính là gốc ⇒ POS đã đúng, không phải ứng viên.
    await order("pos-rl-o2", 993002);
    await ship({ id: "pos-rl-s3", orderId: "pos-rl-o2", code: "PKERL0002", stage: "DELIVERED", attemptNo: 1, at: "2026-10-15T01:00:00Z" });
    await ship({ id: "pos-rl-s4", orderId: "pos-rl-o2", code: "823400000002", stage: "IN_TRANSIT", attemptNo: 2, ref: "PKERL0002", reshipOf: "pos-rl-s3", at: "2026-10-16T01:00:00Z" });
    // (3) Chặng hoàn mồ côi mang tham chiếu = mã gốc, và (4) vận đơn tạo lại CHƯA gắn ⇒ không bao giờ ra.
    await ship({ id: "pos-rl-s5", orderId: null, code: "PKERL0001P1", stage: "RETURNED", ref: "PKERL0001", at: "2026-10-17T01:00:00Z" });
    await order("pos-rl-o3", 993003);
    await ship({ id: "pos-rl-s6", orderId: "pos-rl-o3", code: "PKERL0003", stage: "CANCELLED", attemptNo: 1, at: "2026-10-15T01:00:00Z" });
    await ship({ id: "pos-rl-s7", orderId: null, code: "823400000003", stage: "DELIVERED", ref: "PKERL0003", at: "2026-10-16T01:00:00Z" });

    const { pairs } = await readPairs(db);
    const mine = pairs.filter((p) => p.orderId.startsWith("pos-rl-"));
    assert.deepEqual(mine, [{ orderId: "pos-rl-o1", oldCode: "PKERL0001", newCode: "823400000001", newStage: "DELIVERED", oldStage: "CANCELLED", viaAudit: false }], `chỉ lần gửi chính do ERP gắn: ${JSON.stringify(mine)}`);
    assert.ok(!pairs.some((p) => /P[0-9]+$/.test(p.newCode)), "mã chặng hoàn không bao giờ là ứng viên");
    // Vết để gỡ: dòng audit gần nhất của đơn.
    await db.insert(schema.auditLogs).values([
      { userEmail: "script:pos-reship-link", action: "pos.reship_link", entity: "order", entityId: "pos-rl-o1", detail: { oldCode: "PKERL0001", newCode: "823400000009" }, createdAt: new Date("2026-10-20T00:00:00Z") },
      { userEmail: "script:pos-reship-link", action: "pos.reship_link", entity: "order", entityId: "pos-rl-o1", detail: { oldCode: "PKERL0001", newCode: "823400000001" }, createdAt: new Date("2026-10-21T00:00:00Z") },
    ]);
    assert.deepEqual(await lastLinkRecord(db, "pos-rl-o1"), { oldCode: "PKERL0001", newCode: "823400000001" }, "gỡ theo dòng audit MỚI NHẤT");
    assert.equal(await lastLinkRecord(db, "pos-rl-o2"), null, "không có vết ⇒ null");
    const ids = (await db.select({ id: s.id }).from(s).where(inArray(s.id, ["pos-rl-s5", "pos-rl-s7"]))).length;
    assert.equal(ids, 2, "dòng mồ côi vẫn còn nguyên — script chỉ đọc");
    console.log("  ✓ pos-reship-link (CSDL): lần gửi kế đã gắn + gốc huỷ ⇒ ứng viên · gốc đã giao ⇒ không · chặng hoàn / tạo lại chưa gắn ⇒ không");
  } finally {
    await donDep();
  }
}

/**
 * ĐỒNG BỘ NGƯỢC sau khi POS mang mã MỚI (điều kiện (B) của Tech Lead, 23/10/2026). Đơn có lần 1 gốc (mã VTP cũ, mã tra cứu = mã Pancake)
 * + lần 2 do webhook tạo (mã VTP mới, mã tra cứu = mã mới). Pancake trả `order_number_vtp` = MỚI, `extend_code` = mã Pancake (không đổi).
 * Bản cũ của `cungVanDon` đòi cả hai mã cùng khớp ⇒ INSERT trùng mã VTP (23505) — đo production: 330/330 đơn đúng dạng ấy. Phải: không
 * lỗi · không dòng mới · lần 1 không đổi · lần 2 giữ mã tra cứu của nó · lần 2 vẫn là lần chính. Vế ngược (gỡ về mã cũ) cũng vậy.
 */
const DON_SB = "990588";
const OLD_SB = "PKE990058801";
const NEW_SB = "155990058802";
const PANCAKE_SB = "PKE10999058803";

function donSb(vtp: string, updatedAt: string) {
  const goc = JSON.parse(readFixture(path.join(process.cwd(), "tests/fixtures-pancake-order.json"), "utf8")) as { data: Record<string, unknown> };
  return { ...goc.data, id: Number(DON_SB), system_id: Number(DON_SB), items: [], status: 2, updated_at: updatedAt, partner: { partner_id: 3, partner_name: "Viettel Post", extend_code: PANCAKE_SB, order_number_vtp: vtp, partner_status: "picked_up", total_fee: 30000, cod: 0, updated_at: updatedAt } };
}

export async function testPosReshipSyncBack(db: Db) {
  const s = schema.shipments;
  const donDep = async () => {
    await db.delete(s).where(eq(s.orderId, DON_SB));
    await db.delete(schema.orders).where(eq(schema.orders.id, DON_SB));
  };
  await donDep();
  try {
    const g1 = mapOrder(donSb(OLD_SB, "2026-10-15T02:00:00"));
    assert.ok(g1);
    await upsertOrder(g1, { force: true });
    const [lan1] = await db.select().from(s).where(eq(s.orderId, DON_SB));
    assert.ok(lan1 && lan1.vtpOrderNumber === OLD_SB && lan1.trackingCode === PANCAKE_SB, "lần 1: mã VTP cũ, mã tra cứu = mã Pancake");
    // Chứng từ ĐVVC: gốc huỷ; lần gửi kế do webhook tạo rồi được luật gắn (như 330 đơn đã vá).
    await db.update(s).set({ stage: "CANCELLED", vtpStatusDate: new Date("2026-10-15T05:00:00Z"), isFinal: true }).where(eq(s.id, lan1.id));
    await db.insert(s).values({ orderId: DON_SB, carrier: "Viettel Post", vtpOrderNumber: NEW_SB, trackingCode: NEW_SB, attemptNo: 2, direction: "OUTBOUND", stage: "DELIVERED", vtpStatusDate: new Date("2026-10-17T05:00:00Z"), isFinal: true, raw: { reship: { of: lan1.id, by: "VTP_WEBHOOK", at: "2026-10-16T00:00:00Z" } } });
    const snap = async () => (await db.select({ id: s.id, vtp: s.vtpOrderNumber, tracking: s.trackingCode, attemptNo: s.attemptNo, stage: s.stage, isFinal: s.isFinal, orderId: s.orderId, createdAt: s.createdAt, direction: s.direction }).from(s).where(eq(s.orderId, DON_SB))).sort((a, b) => (a.attemptNo ?? 0) - (b.attemptNo ?? 0));
    const truoc = await snap();

    // Sau PUT: Pancake trả mã MỚI.
    const g2 = mapOrder(donSb(NEW_SB, "2026-10-23T09:00:00"));
    assert.ok(g2);
    await upsertOrder(g2, { force: true });
    const sau = await snap();
    assert.equal(sau.length, 2, "không đẻ dòng thứ ba (bản cũ: INSERT trùng mã VTP ⇒ 23505)");
    assert.deepEqual(sau[0], truoc[0], "lần gửi GỐC không đổi một trường nào");
    assert.equal(sau[1].vtp, NEW_SB);
    assert.equal(sau[1].tracking, NEW_SB, "lần 2 GIỮ mã tra cứu của nó — mã Pancake là của vận đơn gốc");
    assert.equal(sau[1].stage, "DELIVERED", "chặng theo chứng từ ĐVVC, Pancake không đè");
    assert.equal(vanDonDaiDien(sau.map((x) => ({ ...x, vtpOrderNumber: x.vtp, trackingCode: x.tracking })))?.id, sau[1].id, "lần 2 vẫn là lần gửi CHÍNH");

    // Gỡ về mã cũ: cập nhật lần gốc, không dòng mới, lần 2 không đổi.
    const g3 = mapOrder(donSb(OLD_SB, "2026-10-23T10:00:00"));
    assert.ok(g3);
    await upsertOrder(g3, { force: true });
    const go = await snap();
    assert.equal(go.length, 2, "gỡ cũng không đẻ dòng mới");
    assert.equal(go[0].vtp, OLD_SB);
    assert.equal(go[0].tracking, PANCAKE_SB);
    assert.equal(go[0].stage, "CANCELLED", "gốc vẫn theo chứng từ ĐVVC");
    assert.deepEqual({ ...go[1] }, { ...sau[1] }, "gỡ không đụng lần 2");
    console.log("  ✓ pos-reship-link (đồng bộ ngược): Pancake trả mã MỚI ⇒ không lỗi · không dòng mới · gốc không đổi · lần 2 giữ mã tra cứu, vẫn là lần chính · gỡ về mã cũ cũng vậy");
  } finally {
    await donDep();
  }
}
