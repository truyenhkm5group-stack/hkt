/**
 * ═══════════ VIETTEL POST CỦA TỔ CHỨC KHÁCH (webhook theo tổ chức · F2 Fashion COD) ═══════════
 *
 *  1. THUẦN — sổ connector khai PER_ORG / module Giao vận / webhook URL_SECRET; không có hàm kiểm tra (VTP không cấp API).
 *  2. ROUTE — token sai / không dấu chấm ⇒ 401; token đúng của tổ chức CHƯA bật Giao vận ⇒ 409; token của tổ chức này không
 *     mở được tổ chức khác (chữ ký gắn mã tổ chức).
 *  3. LÕI DÙNG CHUNG — gói tin của tổ chức `vp-shop` vào CSDL CỦA tổ chức (vận đơn tạo mới, trạng thái áp), gói lặp chỉ tăng
 *     lần gửi và không đẻ vận đơn thứ hai, mốc ĐVVC cũ hơn không đè trạng thái mới; tổ chức nhà không có dòng nào.
 *
 * Không gọi mạng (luật 65). Mốc ĐVVC dựng từ ĐỒNG HỒ THẬT (luật 50).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { findConnector } from "@/lib/connectors/registry";
import { acceptVtpWebhook, applyAcceptedVtpWebhook, findVtpData } from "@/lib/integrations/viettelpost/webhook-core";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { WEBHOOK_BINDINGS, webhookUrlToken } from "@/lib/platform/webhooks";
import { POST as vtpOrgPost } from "@/app/api/webhooks/viettelpost-org/[token]/route";

const ORG = "vp-shop";
const NO_LOGISTICS = "vp-none";
const CODE = "VPTEST0001";
const ORG_SECRETS_KEY = "khoa-kiem-thu-viettelpost-org-0123456789abcdefghijklmnopqrstuv";

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

/** "dd/MM/yyyy HH:mm:ss" giờ VN — đúng định dạng ORDER_STATUSDATE của webhook Viettel Post. */
function vnStamp(ms: number): string {
  const d = new Date(ms + 7 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function testPure() {
  const spec = findConnector("viettelpost-org");
  assert.ok(spec);
  assert.equal(spec.tenancy, "PER_ORG");
  assert.equal(spec.module, "logistics");
  assert.equal(spec.health, null, "không có API tra cứu ⇒ không có hàm kiểm tra giả vờ");
  assert.equal(spec.webhook?.binding, "VIETTELPOST_ORG");
  assert.equal(WEBHOOK_BINDINGS.VIETTELPOST_ORG.mode, "URL_SECRET");
  // Gói chuyển tiếp bọc nhiều tầng vẫn tìm ra bản ghi hành trình (cùng hàm với route của nhà).
  assert.equal(findVtpData({ payload: { inner: { ORDER_NUMBER: "X1", ORDER_STATUS: 200 } } }).ORDER_NUMBER, "X1");
}

export async function testViettelPostOrg() {
  testPure();
  for (const c of [ORG, NO_LOGISTICS]) await cleanupOrg(c);
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = ORG_SECRETS_KEY;
  try {
    await provisionOrganization({ code: ORG, name: "Thời trang thử VTP", plan: "standard", modules: ["customers", "products", "orders", "logistics"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "ThoiTrang@123" }, source: "TEST", actor: null });
    await provisionOrganization({ code: NO_LOGISTICS, name: "Shop chưa giao vận", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${NO_LOGISTICS}.local`, name: "QT", password: "ThoiTrang@123" }, source: "TEST", actor: null });
    const post = (token: string, body: unknown) =>
      vtpOrgPost(new Request(`http://erp.test/api/webhooks/viettelpost-org/${token}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never, { params: Promise.resolve({ token }) });

    // ── Route: xác thực + cổng module (trả trước khi đọc / ghi gì) ──
    const tok = webhookUrlToken("VIETTELPOST_ORG", ORG);
    const tokNone = webhookUrlToken("VIETTELPOST_ORG", NO_LOGISTICS);
    assert.ok(tok && tokNone);
    assert.equal((await post(`${ORG}.sai-chu-ky`, { DATA: { ORDER_NUMBER: CODE } })).status, 401);
    assert.equal((await post("khongcodaucham", { DATA: { ORDER_NUMBER: CODE } })).status, 401);
    assert.equal((await post(`${NO_LOGISTICS}.${tok.split(".")[1]}`, { DATA: { ORDER_NUMBER: CODE } })).status, 401, "chữ ký của vp-shop không mở được tổ chức khác");
    assert.equal((await post(tokNone, { DATA: { ORDER_NUMBER: CODE } })).status, 409, "tổ chức chưa bật Giao vận ⇒ 409");
    assert.equal(webhookUrlToken("VIETTELPOST_ORG", (await getHomeOrganization()).code) === null, false, "token dựng được cho mọi mã, nhưng nhà bị từ chối khi phân giải");
    await withOrganization(NO_LOGISTICS, async () => assert.equal((await (await getDb()).select().from(schema.webhookEvents)).length, 0, "409 ⇒ không ghi gì"));

    // ── Lõi dùng chung trong ngữ cảnh tổ chức ──
    const NOW = Date.now();
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const goi = (status: number, name: string, ms: number) => ({ DATA: { ORDER_NUMBER: CODE, ORDER_STATUS: status, STATUS_NAME: name, ORDER_STATUSDATE: vnStamp(ms), MONEY_COLLECTION: 350000 } });
      const a1 = await acceptVtpWebhook(goi(200, "Nhận từ bưu tá", NOW - 3_600_000), { userAgent: "vtp", contentType: "application/json" });
      await applyAcceptedVtpWebhook(a1);
      const ships = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, CODE));
      assert.equal(ships.length, 1, "vận đơn mới tạo trong CSDL của tổ chức");
      // Gửi lại y hệt ⇒ cùng một dòng webhook, lần gửi tăng, không vận đơn thứ hai.
      const a2 = await acceptVtpWebhook(goi(200, "Nhận từ bưu tá", NOW - 3_600_000), { userAgent: "vtp", contentType: "application/json" });
      assert.ok(a2.duplicate && a2.eventId === a1.eventId && a2.deliveryCount >= 2, JSON.stringify(a2));
      await applyAcceptedVtpWebhook(a2);
      // Trạng thái mới hơn ⇒ áp; gói cũ hơn đến muộn ⇒ không đè.
      await applyAcceptedVtpWebhook(await acceptVtpWebhook(goi(501, "Phát thành công", NOW - 600_000), { userAgent: "vtp", contentType: "application/json" }));
      await applyAcceptedVtpWebhook(await acceptVtpWebhook(goi(300, "Đang vận chuyển", NOW - 1_800_000), { userAgent: "vtp", contentType: "application/json" }));
      const [s] = await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, CODE));
      assert.equal(String(s.vtpStatus), "501", `mốc ĐVVC mới hơn thắng: ${JSON.stringify({ status: s.vtpStatus, stage: s.stage })}`);
      assert.equal((await db.select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, CODE))).length, 1);
    });
    await withOrganization((await getHomeOrganization()).code, async () => {
      assert.equal((await (await getDb()).select().from(schema.shipments).where(eq(schema.shipments.vtpOrderNumber, CODE))).length, 0, "nhà không có vận đơn của tổ chức khách");
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    for (const c of [ORG, NO_LOGISTICS]) await cleanupOrg(c);
  }
  console.log("  ✓ Viettel Post của tổ chức: PER_ORG module Giao vận, không giả vờ có API; webhook 401 (token sai / chữ ký tổ chức khác) · 409 (chưa bật Giao vận); lõi chung ghi vào CSDL của tổ chức, gói lặp không đẻ vận đơn, mốc ĐVVC mới hơn thắng; nhà không có dòng nào");
}
