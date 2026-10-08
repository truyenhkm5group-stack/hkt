/**
 * ═══════════ CÔNG CỤ Ô SOẠN CỦA HỘP THƯ: CÂU MẪU · SẢN PHẨM (P0.2 «Unified Inbox» · lib/sales-chatbot/inbox-composer.ts) ═══════════
 *
 * Khoá:
 *  · THUẦN: lọc câu mẫu bỏ dấu (`foldVi`, gõ dở vẫn ra, khớp ở tên đứng trước) · tồn ⇒ chữ chèn (CHỈ «còn hàng» / «hết hàng»;
 *    bán không kiểm tồn / chưa có phiếu nhập / tồn âm ⇒ im lặng) · dòng chèn (thiếu giá ⇒ không in giá, không bao giờ «0 ₫») ·
 *    chèn vào ô soạn tại con trỏ / thay vùng chọn / nối cuối, đoạn chèn đứng dòng riêng (`insertIntoDraft` của trang).
 *  · CSDL — hai tổ chức THẬT `o-soan-a` / `o-soan-b` (hai CSDL PGlite riêng, tự cấp, tự dọn):
 *    – câu mẫu: chỉ câu ĐANG BẬT; lọc không dấu; câu có ảnh báo số ảnh; chỗ trống điền số ERP LÚC BẤM bằng cấu hình của PAGE của
 *      hội thoại (page đè phí ship); thiếu số (phí ship chưa khai · tồn chưa biết) ⇒ không chèn; câu đã tắt ⇒ không chèn;
 *    – sản phẩm: giá BẰNG giá bot báo (`executeTool("search_products")`, cùng thứ tự); mẫu mã đã gỡ / đang ẩn / sản phẩm đã gỡ
 *      không ra; bấm ⇒ đọc lại giá LÚC BẤM; ẩn sau lúc tìm ⇒ không chèn; `sellWithoutStockCheck` ⇒ không một chữ tồn nào;
 *    – từ khoá rỗng / quá 200 ký tự ⇒ lỗi rõ; hội thoại khung thử / không có ⇒ từ chối;
 *    – QUYỀN = cổng của «Gửi»: so từng ô với `sendStaffReplyCore` trên một ma trận quyền (gồm phiên mang danh sách module thiếu
 *      `ai_sales`); module tắt ở TỔ CHỨC ⇒ từ chối cả người dựng tay không mang danh sách module;
 *    – CÔ LẬP: A không thấy / không chèn được câu mẫu, sản phẩm, hội thoại của B — và ngược lại; đối chứng chính chủ vẫn chạy.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { insertIntoDraft } from "@/app/(dashboard)/ai/sales-chatbot/inbox/composer-tools";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { formatVND } from "@/lib/format";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import type { StockInfo } from "@/lib/sales-chatbot/catalog";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { loadSalesChatbotConfigFor } from "@/lib/sales-chatbot/engine";
import { sendStaffReplyCore } from "@/lib/sales-chatbot/inbox";
import {
  COMPOSER_LIMITS,
  COMPOSER_STOCK_SAY,
  composerProductLine,
  composerProductPick,
  composerProductSearch,
  composerQuickReplies,
  composerQuickReplyText,
  composerStockOf,
  matchComposerQuickReplies,
  type ComposerProduct,
} from "@/lib/sales-chatbot/inbox-composer";
import { PAGE_OVERRIDES_SETTING_KEY } from "@/lib/sales-chatbot/page-config-shared";
import { addQuickReplyImages, saveQuickReply } from "@/lib/sales-chatbot/quick-replies";
import { executeTool } from "@/lib/sales-chatbot/tools";
import { setSettingJson } from "@/lib/settings";

const A = "o-soan-a";
const B = "o-soan-b";
const ORGS = [A, B] as const;
/** Dấu riêng của từng tổ chức — thấy dấu của tổ chức kia trong kết quả là rò rỉ. */
const markOf = (org: string) => `OSOAN-${org.toUpperCase()}-4417`;
const PAGE = "page-o-soan";
const PAGE_2 = "page-o-soan-2";
const NOT_FOUND = "Không có hội thoại này.";

/** Ảnh PNG 1×1 thật (chữ ký + IHDR + IDAT + IEND). */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

// ─────────────────────────── Thuần ───────────────────────────

function testPure() {
  // Thứ tự gốc CỐ Ý để câu chỉ khớp ở câu trả lời («gio») đứng TRƯỚC câu khớp ở tên («bq»): xếp tên-trước phải đảo được chúng.
  const rows = [
    { id: "gio", title: "Giờ mở cửa", triggers: ["mấy giờ"], answer: "Shop mở 8h–21h, hàng đông lạnh nhớ bảo quản ngay ạ." },
    { id: "bq", title: "Bảo quản chả cá", triggers: ["bảo quản thế nào"], answer: "Để ngăn đá được 3 tháng ạ." },
    { id: "ship", title: "Phí ship", triggers: ["ship bao nhiêu"], answer: "Phí ship {{ship}} ạ." },
  ];
  const ids = (q: string) => matchComposerQuickReplies(rows, q).map((r) => r.id);
  assert.deepEqual(ids(""), ["gio", "bq", "ship"], "không gõ gì ⇒ nguyên danh sách, giữ thứ tự gốc");
  assert.deepEqual(ids("bao quan"), ["bq", "gio"], "bỏ dấu; khớp ở TÊN đứng trước khớp ở câu trả lời");
  assert.deepEqual(ids("BẢO QUẢN"), ["bq", "gio"], "hoa / có dấu cùng một kết quả");
  assert.deepEqual(ids("bảo qu"), ["bq", "gio"], "đang gõ dở vẫn ra");
  assert.deepEqual(ids("ship bao nhieu"), ["ship"], "khớp câu khách hay hỏi");
  assert.deepEqual(ids("không có gì"), [], "không khớp ⇒ rỗng, không đoán");

  const known = (available: number | null, stockKnown = true): StockInfo => ({ variantId: "v", stockKnown, onHand: available, available });
  assert.deepEqual(composerStockOf(known(3), false), { state: "IN_STOCK", say: COMPOSER_STOCK_SAY.IN_STOCK, note: null });
  assert.deepEqual(composerStockOf(known(0), false), { state: "OUT_OF_STOCK", say: COMPOSER_STOCK_SAY.OUT_OF_STOCK, note: null });
  for (const [info, state, why] of [
    [known(5, false), "UNKNOWN", "chưa có phiếu nhập"],
    [known(null), "UNKNOWN", "không đọc được số"],
    [undefined, "UNKNOWN", "không có dòng tồn"],
    [known(-2), "NEGATIVE", "tồn âm = sổ kho sai"],
  ] as const) {
    const s = composerStockOf(info, false);
    assert.ok(s.say === null && s.note && s.state === state, `${why} ⇒ không nói gì về tồn với khách (chỉ ghi chú cho nhân viên): ${JSON.stringify(s)}`);
  }
  assert.match(composerStockOf(known(-2), false).note ?? "", /ÂM/);
  const off = composerStockOf(known(9), true);
  assert.ok(off.state === "NOT_CHECKED" && off.say === null && /không cần kiểm tồn/.test(off.note ?? ""), "bán không kiểm tồn ⇒ KHÔNG ÁP DỤNG, không nói còn / hết, kể cả khi đọc được tồn");

  assert.equal(composerProductLine({ name: "Áo thun", variant: "Đỏ · M", price: 199_000 }, "còn hàng"), `Áo thun · Đỏ · M — ${formatVND(199_000)} · còn hàng`);
  assert.equal(composerProductLine({ name: "Áo thun", variant: "", price: 199_000 }, null), `Áo thun — ${formatVND(199_000)}`);
  assert.equal(composerProductLine({ name: "Áo thun", variant: "Đỏ · M", price: null }, "hết hàng"), "Áo thun · Đỏ · M — hết hàng", "chưa có giá ⇒ bỏ vế giá, không in «0 ₫»");
  assert.equal(composerProductLine({ name: "Áo thun", variant: "Đỏ · M", price: null }, null), "Áo thun · Đỏ · M");

  // Chèn vào ô soạn (phía trang): tại con trỏ / thay vùng chọn / nối cuối — đoạn chèn luôn đứng DÒNG RIÊNG, con trỏ ngay sau nó.
  const S = `Áo A — ${formatVND(100_000)}`;
  assert.deepEqual(insertIntoDraft("", 0, 0, S), { text: S, caret: S.length }, "ô trống ⇒ đúng đoạn chèn");
  assert.deepEqual(insertIntoDraft("Dạ chị", 6, 6, S), { text: `Dạ chị\n${S}`, caret: 7 + S.length }, "nối cuối ⇒ xuống dòng trước đoạn chèn");
  assert.deepEqual(insertIntoDraft("Dạ chị\n", 7, 7, S), { text: `Dạ chị\n${S}`, caret: 7 + S.length }, "đã xuống dòng ⇒ không thêm dòng trống");
  assert.deepEqual(insertIntoDraft("Dạ chị ơi", 3, 3, S), { text: `Dạ \n${S}\nchị ơi`, caret: 4 + S.length }, "giữa câu ⇒ đoạn chèn đứng dòng riêng");
  assert.deepEqual(insertIntoDraft("Dạ XYZ ạ", 3, 6, S), { text: `Dạ \n${S}\n ạ`, caret: 4 + S.length }, "thay đúng vùng đang chọn");
  assert.deepEqual(insertIntoDraft("abc", 0, 0, S), { text: `${S}\nabc`, caret: S.length }, "đầu ô ⇒ xuống dòng sau đoạn chèn");
  assert.deepEqual(insertIntoDraft("abc", 99, 99, S), { text: `abc\n${S}`, caret: 4 + S.length }, "vị trí vượt độ dài ⇒ kẹp về cuối");
  assert.deepEqual(insertIntoDraft("abc", 2, 1, S), { text: `ab\n${S}\nc`, caret: 3 + S.length }, "vùng ngược ⇒ coi như con trỏ");
}

// ─────────────────────────── CSDL ───────────────────────────

type Seeded = {
  admin: SessionUser;
  conv: string;
  conv2: string;
  testConv: string;
  qr: { photo: string; price: string; off: string; ship: string; unknownStock: string; mark: string; long: string };
  v: { muc: string; kg: string; norec: string; noprice: string; am: string; removed: string; hidden: string; goneProduct: string; mark: string; jar: string };
};

/** Câu trả lời dài (không chữ số, không chữ «bảo quản» / «chả mực») — để thấy đoạn đầu bị cắt. */
const LONG_ANSWER = "Shop hỗ trợ đổi hàng trong bảy ngày nếu sản phẩm lỗi, còn nguyên tem mác và hoá đơn mua hàng. ".repeat(4).trim();

async function adminOf(org: string): Promise<SessionUser> {
  const u = await withOrganization(org, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) }));
  assert.ok(u, `quản trị của ${org}`);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false } };
}

function staffOf(org: string, id: string, permissions: string[], modules?: string[]): SessionUser {
  return { id, email: `${id}@${org}.local`, name: id, role: "CS", permissions, scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false }, ...(modules ? { modules } : {}) };
}

async function seed(org: string): Promise<Seeded> {
  const admin = await adminOf(org);
  const MARK = markOf(org);
  return withOrganization(org, async () => {
    const db = await getDb();
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG });
    const p = `${org}-p`;
    await db.insert(schema.products).values([
      { id: p, name: "Chả mực Hạ Long" },
      { id: `${p}-go`, name: "Chả mực đã gỡ", isRemoved: true },
      { id: `${p}-mark`, name: `Hàng riêng ${MARK}` },
      { id: `${p}-mam`, name: "Mắm tôm chua" },
      { id: `${p}-bt`, name: "Bánh tráng phơi sương" },
    ]);
    // Field tuỳ biến bot được đọc (`productFields`, mặc định có `package_size`) — tìm «thuy tinh» chỉ ra nhờ field này.
    await db.insert(schema.customValues).values({ objectKey: "product", recordId: `${p}-mam`, values: { package_size: "Hũ thủy tinh 500ml" } });
    // 25 mẫu mã cùng tên ⇒ trần 20 kết quả của ô soạn; bot lấy 8 đầu của CÙNG thứ tự.
    await db.insert(schema.productVariants).values(
      Array.from({ length: 25 }, (_, i) => {
        const n = String(i + 1).padStart(2, "0");
        return { id: `${org}-v-bt-${n}`, productId: `${p}-bt`, sku: `BT-${n}`, detail: `Gói ${n}`, retailPrice: 20_000 + i * 1_000 };
      }),
    );
    const v = {
      muc: `${org}-v-muc`,
      kg: `${org}-v-1kg`,
      norec: `${org}-v-norec`,
      noprice: `${org}-v-noprice`,
      am: `${org}-v-am`,
      removed: `${org}-v-removed`,
      hidden: `${org}-v-hidden`,
      goneProduct: `${org}-v-gone`,
      mark: `${org}-v-mark`,
      jar: `${org}-v-mam`,
    };
    await db.insert(schema.productVariants).values([
      { id: v.muc, productId: p, sku: "OS-MUC", detail: "Hộp 500g", retailPrice: 180_000 },
      { id: v.kg, productId: p, sku: "OS-MUC-1KG", detail: "Hộp 1kg", retailPrice: 350_000 },
      { id: v.norec, productId: p, sku: "OS-NOREC", detail: "Hộp 200g", retailPrice: 120_000 },
      { id: v.noprice, productId: p, sku: "OS-NOPRICE", detail: "Hộp nhỏ", retailPrice: 0 },
      { id: v.am, productId: p, sku: "OS-AM", detail: "Hộp 300g", retailPrice: 90_000 },
      { id: v.removed, productId: p, sku: "OS-REMOVED", detail: "Hộp cũ", retailPrice: 100_000, isRemoved: true },
      { id: v.hidden, productId: p, sku: "OS-HIDDEN", detail: "Hộp thôi bán", retailPrice: 100_000, isHidden: true },
      { id: v.goneProduct, productId: `${p}-go`, sku: "OS-GONE", detail: "Hộp", retailPrice: 100_000 },
      { id: v.mark, productId: `${p}-mark`, sku: `OS-${org.toUpperCase()}`, detail: MARK, retailPrice: 55_000 },
      { id: v.jar, productId: `${p}-mam`, sku: "OS-MAM", detail: "Hũ", retailPrice: 45_000 },
    ]);
    // Sổ kho: dương = vào kho, âm = ra kho. Khả dụng: mực 10 · 1kg 0 (nhập 3, điều chỉnh −3) · nhỏ 5 · 300g −2 (nhập 1, xuất tay 3).
    const slip = async (kind: "RECEIPT" | "ADJUSTMENT" | "ISSUE", variantId: string, quantity: number) => {
      const [r] = await db.insert(schema.stockReceipts).values({ kind, receivedAt: new Date(), reference: `o-soan ${kind}`, totalQuantity: quantity, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
      await db.insert(schema.stockReceiptItems).values({ receiptId: r.id, variantId, quantity });
    };
    await slip("RECEIPT", v.muc, 10);
    await slip("RECEIPT", v.kg, 3);
    await slip("ADJUSTMENT", v.kg, -3);
    await slip("RECEIPT", v.noprice, 5);
    await slip("RECEIPT", v.am, 1);
    await slip("ISSUE", v.am, -3);
    await slip("RECEIPT", v.mark, 4);

    const c = schema.salesChatConversations;
    const [conv] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: `${org}-t1`, pageId: PAGE, threadId: `${org}-t1`, lastCustomerAt: new Date() }).returning({ id: c.id });
    const [conv2] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: `${org}-t2`, pageId: PAGE_2, threadId: `${org}-t2`, lastCustomerAt: new Date() }).returning({ id: c.id });
    const [testConv] = await db.insert(c).values({ channel: "TEST", status: "OPEN", createdBy: admin.email }).returning({ id: c.id });

    const qr = async (title: string, triggers: string[], answer: string, active = true) => {
      const r = await saveQuickReply(admin, { title, triggers, answer, active });
      assert.ok("ok" in r, JSON.stringify(r));
      return r.id;
    };
    const photo = await qr("Bảo quản chả cá", ["bảo quản thế nào"], "Để ngăn đá được 3 tháng ạ.");
    const img = await addQuickReplyImages(admin, photo, [PNG, PNG]);
    assert.ok("ok" in img && img.added === 2, JSON.stringify(img));
    return {
      admin,
      conv: conv.id,
      conv2: conv2.id,
      testConv: testConv.id,
      qr: {
        photo,
        price: await qr("Giá chả mực", ["chả mực giá"], "Chả mực {{giá:OS-MUC}} một hộp ạ."),
        off: await qr("Câu đã tắt", ["đã tắt"], "Câu này đang tắt ạ.", false),
        ship: await qr("Phí ship", ["ship bao nhiêu"], "Phí ship {{ship}} ạ."),
        unknownStock: await qr("Tồn chả mực", ["còn hàng không"], "Còn {{tồn:OS-NOREC}} hộp ạ."),
        mark: await qr(`Câu riêng ${MARK}`, ["câu riêng"], `Nội dung riêng ${MARK}.`),
        long: await qr("Chính sách đổi trả", ["đổi trả thế nào"], LONG_ANSWER),
      },
      v,
    };
  });
}

async function setModule(org: string, key: string, enabled: boolean) {
  const pdb = await getPlatformDb();
  const o = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, org) });
  assert.ok(o);
  const updated = await pdb
    .update(schema.platformOrganizationModules)
    .set({ enabled })
    .where(and(eq(schema.platformOrganizationModules.organizationId, o.id), eq(schema.platformOrganizationModules.moduleKey, key)))
    .returning();
  if (updated.length === 0) await pdb.insert(schema.platformOrganizationModules).values({ organizationId: o.id, moduleKey: key, enabled, features: {} });
  invalidateCapabilities();
}

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

/** Quyết định của «Gửi» cho một người — hội thoại không tồn tại, nên qua được cổng là dừng ở «Không có hội thoại này», không ghi gì. */
async function sendDecision(u: SessionUser): Promise<"ALLOW" | "DENY"> {
  const r = await sendStaffReplyCore(u, "khong-co-hoi-thoai-nay", { text: "Dạ", requestKey: "kiem-quyen-o-soan" });
  assert.ok(!r.ok);
  return r.error === NOT_FOUND ? "ALLOW" : "DENY";
}

async function composerDecisions(u: SessionUser, s: Seeded): Promise<("ALLOW" | "DENY")[]> {
  const out = [await composerQuickReplies(u, ""), await composerQuickReplyText(u, s.conv, s.qr.photo), await composerProductSearch(u, s.conv, "cha muc"), await composerProductPick(u, s.conv, s.v.muc)];
  return out.map((r) => (r.ok ? "ALLOW" : "DENY"));
}

async function testQuickReplies(org: string, s: Seeded) {
  const staff = staffOf(org, "nv-tra-loi", ["ai_sales:view", "ai_sales:reply"]);
  await withOrganization(org, async () => {
    const all = await composerQuickReplies(staff, "");
    assert.ok(all.ok, JSON.stringify(all));
    assert.equal(all.total, 6, "chỉ câu ĐANG BẬT (6 bật · 1 tắt)");
    assert.equal(all.items.length, 6);
    assert.ok(!all.items.some((i) => i.id === s.qr.off), "câu đã tắt không có trong danh sách");
    const photo = all.items.find((i) => i.id === s.qr.photo);
    assert.ok(photo && photo.imageCount === 2 && !photo.needsErp && photo.preview === "Để ngăn đá được 3 tháng ạ.", JSON.stringify(photo));
    assert.ok(all.items.find((i) => i.id === s.qr.price)?.needsErp, "câu có chỗ trống ⇒ báo điền số ERP lúc bấm");
    const longQr = all.items.find((i) => i.id === s.qr.long);
    assert.ok(longQr && longQr.preview.endsWith("…") && Array.from(longQr.preview).length <= COMPOSER_LIMITS.previewChars + 1 && LONG_ANSWER.startsWith(longQr.preview.slice(0, -1)), `câu dài ⇒ chỉ hiện đoạn đầu: ${JSON.stringify(longQr?.preview)}`);
    const filtered = await composerQuickReplies(staff, "bao quan");
    assert.ok(filtered.ok && filtered.items.length === 1 && filtered.total === 6, "`total` là số câu ĐANG BẬT, không phải số câu khớp — trang phân biệt «chưa có câu nào» với «không câu nào khớp»");

    const ids = async (q: string) => {
      const r = await composerQuickReplies(staff, q);
      assert.ok(r.ok, JSON.stringify(r));
      return r.items.map((i) => i.id);
    };
    assert.deepEqual(await ids("bao quan"), [s.qr.photo], "lọc không dấu");
    assert.deepEqual(await ids("BẢO QUẢN"), [s.qr.photo]);
    assert.deepEqual(await ids("bảo qu"), [s.qr.photo], "gõ dở vẫn ra");
    assert.deepEqual((await ids("cha muc")).sort(), [s.qr.price, s.qr.unknownStock].sort());
    const long = await composerQuickReplies(staff, "x".repeat(COMPOSER_LIMITS.queryChars + 1));
    assert.ok(!long.ok && /tối đa 200 ký tự/.test(long.error), JSON.stringify(long));

    // Chữ chèn — đọc lúc bấm, bằng đúng hàm + cấu hình bot dùng cho hội thoại đó.
    const t = await composerQuickReplyText(staff, s.conv, s.qr.photo);
    assert.ok(t.ok && t.text === "Để ngăn đá được 3 tháng ạ." && t.imageCount === 2, JSON.stringify(t));
    const price = await composerQuickReplyText(staff, s.conv, s.qr.price);
    assert.ok(price.ok && price.text === `Chả mực ${formatVND(180_000)} một hộp ạ.`, JSON.stringify(price));
    const off = await composerQuickReplyText(staff, s.conv, s.qr.off);
    assert.ok(!off.ok && /không còn bật/.test(off.error), "câu đã tắt không chèn được dù biết mã");
    const unknown = await composerQuickReplyText(staff, s.conv, s.qr.unknownStock);
    assert.ok(!unknown.ok && /số đọc từ ERP/.test(unknown.error), "tồn CHƯA BIẾT ⇒ không chèn (không in thành 0)");
    const noShip = await composerQuickReplyText(staff, s.conv, s.qr.ship);
    assert.ok(!noShip.ok && /số đọc từ ERP/.test(noShip.error), "phí ship chưa khai ⇒ không chèn câu có {{ship}}");
    // Phí ship: tổ chức 25.000, page của hội thoại 1 đè 30.000 ⇒ mỗi hội thoại đúng số bot sẽ nói trong hội thoại đó.
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, shippingFee: 25_000 });
    await setSettingJson(PAGE_OVERRIDES_SETTING_KEY, { [PAGE]: { shippingFee: 30_000 } });
    const ship1 = await composerQuickReplyText(staff, s.conv, s.qr.ship);
    const ship2 = await composerQuickReplyText(staff, s.conv2, s.qr.ship);
    assert.ok(ship1.ok && ship1.text === `Phí ship ${formatVND(30_000)} ạ.`, JSON.stringify(ship1));
    assert.ok(ship2.ok && ship2.text === `Phí ship ${formatVND(25_000)} ạ.`, JSON.stringify(ship2));
    await setSettingJson(PAGE_OVERRIDES_SETTING_KEY, {});
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG });

    for (const [conv, why] of [
      [s.testConv, "hội thoại khung thử"],
      ["khong-co", "hội thoại không có"],
      [123, "mã không phải chữ"],
    ] as const) {
      const r = await composerQuickReplyText(staff, conv, s.qr.photo);
      assert.ok(!r.ok && r.error === NOT_FOUND, `${why} ⇒ từ chối`);
    }
  });
}

async function testProducts(org: string, s: Seeded) {
  const staff = staffOf(org, "nv-tra-loi", ["ai_sales:view", "ai_sales:reply"]);
  await withOrganization(org, async () => {
    const db = await getDb();
    const r = await composerProductSearch(staff, s.conv, "cha muc");
    assert.ok(r.ok, JSON.stringify(r));
    const byId = new Map(r.items.map((i) => [i.variantId, i]));
    assert.deepEqual([...byId.keys()].sort(), [s.v.muc, s.v.kg, s.v.norec, s.v.noprice, s.v.am].sort(), "chỉ mẫu mã ĐANG BÁN — gỡ / ẩn / sản phẩm đã gỡ không ra");

    // MỘT nguồn giá: so với đúng công cụ bot gọi để báo giá, cùng cấu hình của page của hội thoại.
    const cfg = await loadSalesChatbotConfigFor(PAGE);
    const botSearch = async (query: string) => {
      const bot = await executeTool("search_products", { query }, { conversationId: s.conv, channel: "FANPAGE", config: cfg, state: {}, lastUserText: "", agent: { name: "Kiểm thử", source: "tests/inbox-composer.test.ts" } });
      assert.ok(!bot.isError, bot.content);
      return (JSON.parse(bot.content) as { results: { variant_id: string; price: number | null; price_text: string }[] }).results;
    };
    const samePrices = (mine: readonly ComposerProduct[], botRows: Awaited<ReturnType<typeof botSearch>>, why: string) => {
      assert.ok(botRows.length > 0, `${why}: bot thấy mẫu mã`);
      assert.deepEqual(mine.slice(0, botRows.length).map((i) => i.variantId), botRows.map((x) => x.variant_id), `${why}: cùng thứ tự với bot`);
      for (const [i, x] of botRows.entries()) {
        const m = mine[i];
        assert.ok(m.price === x.price && m.priceText === (x.price === null ? null : x.price_text), `${why} — giá của ${x.variant_id}: ô soạn ${JSON.stringify(m)} · bot ${JSON.stringify(x)}`);
      }
    };
    samePrices(r.items, await botSearch("cha muc"), "«cha muc»");
    // Trần 20 kết quả; bot lấy 8 đầu của CÙNG thứ tự — giá từng dòng trùng.
    const many = await composerProductSearch(staff, s.conv, "banh trang");
    assert.ok(many.ok && many.items.length === COMPOSER_LIMITS.productResults, `trần ${COMPOSER_LIMITS.productResults} kết quả: ${many.ok ? many.items.length : JSON.stringify(many)}`);
    const botMany = await botSearch("banh trang");
    assert.ok(botMany.length < many.items.length, "ô soạn cho xem nhiều hơn bot, cùng thứ tự");
    samePrices(many.items, botMany, "«banh trang»");
    // Field tuỳ biến bot được đọc cũng là căn cứ tìm của ô soạn (cùng `productFields`).
    const byField = await composerProductSearch(staff, s.conv, "thuy tinh");
    assert.ok(byField.ok && byField.items.map((i) => i.variantId).join() === s.v.jar, JSON.stringify(byField));
    samePrices(byField.items, await botSearch("thuy tinh"), "«thuy tinh»");

    const line = (id: string) => byId.get(id)?.line;
    const order = [s.v.muc, s.v.kg, s.v.norec, s.v.noprice, s.v.am];
    assert.deepEqual(order.map((id) => byId.get(id)?.stockState), ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN", "IN_STOCK", "NEGATIVE"]);
    assert.deepEqual(order.map((id) => byId.get(id)?.stockSay), ["còn hàng", "hết hàng", null, "còn hàng", null], "chữ tồn trang hiện = chữ tồn trong dòng chèn");
    assert.equal(line(s.v.muc), `Chả mực Hạ Long · Hộp 500g — ${formatVND(180_000)} · còn hàng`);
    assert.equal(line(s.v.kg), `Chả mực Hạ Long · Hộp 1kg — ${formatVND(350_000)} · hết hàng`);
    assert.equal(line(s.v.norec), `Chả mực Hạ Long · Hộp 200g — ${formatVND(120_000)}`, "chưa có phiếu nhập ⇒ không nói gì về tồn");
    assert.match(byId.get(s.v.norec)?.stockNote ?? "", /phiếu nhập/);
    assert.equal(line(s.v.noprice), "Chả mực Hạ Long · Hộp nhỏ — còn hàng", "chưa có giá ⇒ không in giá (không bao giờ «0 ₫»)");
    assert.ok(byId.get(s.v.noprice)?.price === null && byId.get(s.v.noprice)?.priceText === null);
    assert.equal(line(s.v.am), `Chả mực Hạ Long · Hộp 300g — ${formatVND(90_000)}`, "tồn âm ⇒ không nói tồn");
    assert.match(byId.get(s.v.am)?.stockNote ?? "", /ÂM/);
    assert.equal(r.priceNote, null, "shop không bật giá sỉ ⇒ không ghi chú giá");

    // Bấm ⇒ đọc lại lúc bấm: giá đổi sau lượt tìm thì dòng chèn mang giá MỚI.
    const pick = await composerProductPick(staff, s.conv, s.v.muc);
    assert.ok(pick.ok && pick.product.line === line(s.v.muc), JSON.stringify(pick));
    await db.update(schema.productVariants).set({ retailPrice: 190_000 }).where(eq(schema.productVariants.id, s.v.muc));
    const repriced = await composerProductPick(staff, s.conv, s.v.muc);
    assert.ok(repriced.ok && repriced.product.line === `Chả mực Hạ Long · Hộp 500g — ${formatVND(190_000)} · còn hàng`, JSON.stringify(repriced));
    // Ẩn sau lượt tìm ⇒ không chèn; mã đã gỡ / ẩn / không có / sai kiểu ⇒ không chèn.
    await db.update(schema.productVariants).set({ isHidden: true }).where(eq(schema.productVariants.id, s.v.kg));
    for (const id of [s.v.kg, s.v.removed, s.v.hidden, s.v.goneProduct, "khong-co", 42]) {
      const x = await composerProductPick(staff, s.conv, id);
      assert.ok(!x.ok && /không còn bán/.test(x.error), `mẫu mã ${String(id)} không chèn được`);
    }
    await db.update(schema.productVariants).set({ isHidden: false }).where(eq(schema.productVariants.id, s.v.kg));

    // Shop bán không kiểm tồn ⇒ không một chữ tồn nào, cả lúc tìm lẫn lúc bấm.
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, sellWithoutStockCheck: true, wholesalePricing: true });
    const open = await composerProductSearch(staff, s.conv, "cha muc");
    assert.ok(open.ok && open.items.length === 5, JSON.stringify(open));
    const says = (items: readonly ComposerProduct[]) => items.filter((i) => i.stockSay !== null || /còn hàng|hết hàng/.test(i.line));
    assert.deepEqual(says(open.items), [], "bán không kiểm tồn ⇒ không «còn hàng» / «hết hàng»");
    assert.ok(open.items.every((i) => i.stockState === "NOT_CHECKED" && /không cần kiểm tồn/.test(i.stockNote ?? "")), "KHÔNG ÁP DỤNG, không phải CHƯA BIẾT");
    assert.match(open.priceNote ?? "", /giá LẺ/i, "bật giá sỉ ⇒ nói rõ đây là giá lẻ");
    const pickOpen = await composerProductPick(staff, s.conv, s.v.muc);
    assert.ok(pickOpen.ok && pickOpen.product.stockSay === null && pickOpen.product.stockState === "NOT_CHECKED" && pickOpen.product.line === `Chả mực Hạ Long · Hộp 500g — ${formatVND(190_000)}`, JSON.stringify(pickOpen));
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG });

    // Từ khoá: rỗng / chỉ khoảng trắng / quá 200 ký tự ⇒ lỗi rõ; đúng 200 ký tự vẫn tìm.
    for (const q of ["", "   ", undefined]) {
      const x = await composerProductSearch(staff, s.conv, q);
      assert.ok(!x.ok && /Gõ tên sản phẩm/.test(x.error), `từ khoá ${JSON.stringify(q)}`);
    }
    const tooLong = await composerProductSearch(staff, s.conv, "a".repeat(COMPOSER_LIMITS.queryChars + 1));
    assert.ok(!tooLong.ok && /tối đa 200 ký tự/.test(tooLong.error));
    assert.ok((await composerProductSearch(staff, s.conv, "a".repeat(COMPOSER_LIMITS.queryChars))).ok, "đúng trần vẫn tìm");
    for (const conv of [s.testConv, "khong-co"]) {
      const x = await composerProductSearch(staff, conv, "cha muc");
      const y = await composerProductPick(staff, conv, s.v.muc);
      assert.ok(!x.ok && x.error === NOT_FOUND && !y.ok && y.error === NOT_FOUND, "hội thoại khung thử / không có ⇒ từ chối");
    }
  });
}

async function testPermissions(org: string, s: Seeded) {
  const enabled = [...(await getEnabledModules(org))];
  const withoutAi = enabled.filter((m) => m !== "ai_sales");
  const matrix: [string, SessionUser, "ALLOW" | "DENY"][] = [
    ["không quyền nào", staffOf(org, "nv-0", []), "DENY"],
    ["chỉ xem", staffOf(org, "nv-xem", ["ai_sales:view"]), "DENY"],
    ["chỉ trả lời, không xem", staffOf(org, "nv-tl", ["ai_sales:reply"]), "DENY"],
    ["xem + trả lời", staffOf(org, "nv-xem-tl", ["ai_sales:view", "ai_sales:reply"]), "ALLOW"],
    ["xem + gửi tin chăm sóc", staffOf(org, "nv-xem-cs", ["ai_sales:view", "outreach:send"]), "ALLOW"],
    ["quản trị", s.admin, "ALLOW"],
    ["phiên thật đủ quyền nhưng module ai_sales tắt trong phiên", staffOf(org, "nv-tat", ["ai_sales:view", "ai_sales:reply"], withoutAi), "DENY"],
    ["quản trị, module ai_sales tắt trong phiên", { ...s.admin, modules: withoutAi }, "DENY"],
  ];
  await withOrganization(org, async () => {
    for (const [why, u, expected] of matrix) {
      const send = await sendDecision(u);
      assert.equal(send, expected, `«Gửi» với ${why}`);
      assert.deepEqual(await composerDecisions(u, s), [send, send, send, send], `công cụ ô soạn đòi ĐÚNG quyền của «Gửi» — ${why}`);
    }
  });
}

async function testModuleOff(org: string, s: Seeded) {
  await setModule(org, "ai_sales", false);
  try {
    await withOrganization(org, async () => {
      const enabled = [...(await getEnabledModules(org))];
      assert.ok(!enabled.includes("ai_sales"));
      const session = { ...s.admin, modules: enabled };
      assert.equal(await sendDecision(session), "DENY", "«Gửi» từ chối khi module tắt");
      for (const u of [session, s.admin]) {
        const r = await composerQuickReplies(u, "");
        assert.ok(!r.ok && /Module AI bán hàng chưa bật/.test(r.error), JSON.stringify(r));
        assert.deepEqual(await composerDecisions(u, s), ["DENY", "DENY", "DENY", "DENY"], "module tắt ⇒ mọi công cụ ô soạn từ chối, kể cả người dựng tay không mang danh sách module");
      }
    });
  } finally {
    await setModule(org, "ai_sales", true);
  }
}

async function attack(attacker: string, admin: SessionUser, own: Seeded, victimCode: string, victim: Seeded): Promise<string[]> {
  const leaks: string[] = [];
  const victimMark = markOf(victimCode);
  await withOrganization(attacker, async () => {
    const list = await composerQuickReplies(admin, "");
    if (!list.ok || JSON.stringify(list).includes(victimMark)) leaks.push("danh sách câu mẫu lẫn của tổ chức khác");
    if ((await composerQuickReplies(admin, "cau rieng")).ok === false) leaks.push("lọc câu mẫu hỏng");
    if ((await composerQuickReplyText(admin, own.conv, victim.qr.mark)).ok) leaks.push("chèn được câu mẫu của tổ chức khác");
    if ((await composerQuickReplyText(admin, victim.conv, own.qr.photo)).ok) leaks.push("dùng được hội thoại của tổ chức khác (câu mẫu)");
    const search = await composerProductSearch(admin, own.conv, "hang rieng");
    if (!search.ok || JSON.stringify(search).includes(victimMark)) leaks.push("tìm sản phẩm lẫn của tổ chức khác");
    if ((await composerProductSearch(admin, victim.conv, "cha muc")).ok) leaks.push("dùng được hội thoại của tổ chức khác (tìm sản phẩm)");
    if ((await composerProductPick(admin, own.conv, victim.v.mark)).ok) leaks.push("chèn được mẫu mã của tổ chức khác");
    // Đối chứng: cùng lời gọi trên dữ liệu CỦA CHÍNH MÌNH thì chạy — bài không xanh vì mọi thứ đều hỏng.
    assert.ok(list.ok && list.items.some((i) => i.id === own.qr.mark), `${attacker} thấy câu mẫu của chính mình`);
    assert.ok(search.ok && search.items.some((i) => i.variantId === own.v.mark), `${attacker} tìm thấy sản phẩm của chính mình`);
    assert.ok((await composerProductPick(admin, own.conv, own.v.mark)).ok, `${attacker} chèn được mẫu mã của chính mình`);
  });
  return leaks;
}

export async function testInboxComposer() {
  testPure();
  await cleanup();
  for (const code of ORGS) {
    await provisionOrganization({ code, name: `Tổ chức ${code}`, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "OSoan@123456" }, source: "TEST", actor: null });
  }
  try {
    const a = await seed(A);
    const b = await seed(B);
    await testPermissions(A, a);
    await testQuickReplies(A, a);
    await testProducts(A, a);
    await testModuleOff(B, b);
    for (const [attacker, own, victimCode, victim] of [
      [A, a, B, b],
      [B, b, A, a],
    ] as const) {
      assert.deepEqual(await attack(attacker, own.admin, own, victimCode, victim), [], `${attacker} → ${victimCode}: phải bị từ chối / rỗng mọi đòn`);
    }
    console.log(
      "  ✓ Ô soạn hộp thư: chèn tại con trỏ / nối cuối trên dòng riêng · câu mẫu ĐANG BẬT, lọc không dấu, số ảnh báo rõ (ảnh không kèm), chỗ trống điền số ERP lúc bấm theo cấu hình page (thiếu số ⇒ không chèn) · sản phẩm cùng giá + thứ tự với bot, gỡ / ẩn không ra, giá đọc lại lúc bấm, tồn chỉ «còn / hết» khi đọc được và không bật bán không kiểm tồn · từ khoá rỗng / quá dài ⇒ lỗi · quyền ≡ «Gửi» trên 8 ca, module tắt ⇒ từ chối · cô lập 2 chiều",
    );
  } finally {
    await cleanup();
  }
}
