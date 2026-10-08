/**
 * ═══════════ CÔNG CỤ Ô SOẠN CỦA HỘP THƯ: CÂU MẪU · SẢN PHẨM (P0.2 «Unified Inbox» · lib/sales-chatbot/inbox-composer.ts) ═══════════
 *
 * Khoá:
 *  · THUẦN: lọc câu mẫu bỏ dấu (`foldVi`, gõ dở vẫn ra, khớp ở tên đứng trước) · tồn ⇒ chữ chèn (CHỈ «còn hàng» / «hết hàng»;
 *    bán không kiểm tồn / chưa có phiếu nhập / tồn âm ⇒ im lặng) · dòng chèn (thiếu giá ⇒ không in giá, không bao giờ «0 ₫»; giá
 *    sỉ bật ⇒ «(giá lẻ)» cạnh giá) · chèn vào ô soạn tại con trỏ / thay vùng chọn / nối cuối trên dòng riêng (`insertIntoDraft`).
 *  · MÃ NGUỒN: ô soạn gọi CỔNG CHUNG `replyGate` (cùng «Gửi»), không tự gọi `can(` — bản chép của vị từ trả lời từng trôi khỏi bản
 *    gốc mà bài kiểm vẫn xanh (review PR #661, đột biến D3).
 *  · CSDL — hai tổ chức THẬT `o-soan-a` / `o-soan-b` (hai CSDL PGlite riêng, tự cấp, tự dọn):
 *    – câu mẫu: chỉ câu ĐANG BẬT; lọc không dấu; câu có ảnh báo số ảnh; chỗ trống điền số ERP LÚC BẤM bằng cấu hình của PAGE của
 *      hội thoại (page đè phí ship); thiếu số (phí ship chưa khai · tồn chưa biết · tồn ÂM) ⇒ không chèn; bán không kiểm tồn mà
 *      câu có {{tồn}} ⇒ không chèn; câu đã tắt ⇒ không chèn. Đường bot (`renderQuickAnswer`): tồn âm ⇒ thiếu số; bán không kiểm
 *      tồn ⇒ KHÔNG đổi (quyết định của shop);
 *    – sản phẩm: giá BẰNG giá bot báo (`executeTool("search_products")`, cùng thứ tự, kể cả trần 20 và field tuỳ biến); mẫu mã đã
 *      gỡ / đang ẩn / sản phẩm đã gỡ không ra; lượt TÌM không mang tồn; bấm ⇒ đọc lại ĐÍCH DANH mẫu mã (giá + tồn) lúc bấm; ẩn sau
 *      lúc tìm ⇒ không chèn; `sellWithoutStockCheck` ⇒ không một chữ tồn nào; giá sỉ ⇒ «(giá lẻ)» trong dòng chèn;
 *    – từ khoá: tìm sản phẩm cần ≥ 2 ký tự, tối đa 200; hội thoại khung thử / không có / mã > 100 ký tự / của tổ chức khác ⇒ từ chối;
 *    – QUYỀN ≡ «Gửi»: ma trận 9 ca so với `sendStaffReplyCore` trên hội thoại THẬT (qua cổng rồi dừng ở «Tin trống» — mọi kiểm sau
 *      bước nạp hội thoại đều thấy được), gồm người phạm vi phòng ban (phạm vi không thu hẹp quyền trả lời) và phiên mang danh sách
 *      module thiếu `ai_sales`; module tắt ở TỔ CHỨC ⇒ từ chối như mọi action hộp thư;
 *    – CÔ LẬP: A không thấy / không chèn được câu mẫu, sản phẩm, hội thoại của B — và ngược lại; đối chứng chính chủ vẫn chạy.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
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
  COMPOSER_RETAIL_MARK,
  COMPOSER_STOCK_SAY,
  composerProductLine,
  composerProductPick,
  composerProductSearch,
  composerQuickReplies,
  composerQuickReplyText,
  composerStockOf,
  matchComposerQuickReplies,
  type ComposerProductHit,
} from "@/lib/sales-chatbot/inbox-composer";
import { COMPOSER_QUERY, insertIntoDraft } from "@/lib/sales-chatbot/inbox-composer-shared";
import { PAGE_OVERRIDES_SETTING_KEY } from "@/lib/sales-chatbot/page-config-shared";
import { addQuickReplyImages, renderQuickAnswer, saveQuickReply } from "@/lib/sales-chatbot/quick-replies";
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
/** «Gửi» với chữ rỗng dừng NGAY SAU cổng + bước nạp hội thoại — câu này nghĩa là «qua được cổng», không gửi gì. */
const PASSED_GATE = "Tin trống — gõ chữ hoặc chọn ảnh.";
const DENIED = ["Bạn không có quyền xem hội thoại (ai_sales:view).", "Bạn không có quyền trả lời khách (ai_sales:reply)."];
/** Mã hội thoại 101 ký tự — có THẬT trong CSDL, nhưng cổng chặn mọi mã dài quá 100 trước khi đọc. */
const LONG_CONV_ID = "c".repeat(101);

/** Ảnh PNG 1×1 thật (chữ ký + IHDR + IDAT + IEND). */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

// ─────────────────────────── Thuần + mã nguồn ───────────────────────────

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
  assert.equal(composerProductLine({ name: "Áo thun", variant: "Đỏ · M", price: 199_000 }, "còn hàng", true), `Áo thun · Đỏ · M — ${formatVND(199_000)} ${COMPOSER_RETAIL_MARK} · còn hàng`, "giá sỉ bật ⇒ «(giá lẻ)» NGAY cạnh giá");
  assert.equal(composerProductLine({ name: "Áo thun", variant: "", price: null }, null, true), "Áo thun", "không có giá thì không có gì để ghi «(giá lẻ)»");

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

/** Hai đầu vào của cổng chung, đọc từ MÃ NGUỒN: ô soạn chỉ đi qua `replyGate`, «Gửi» cũng vậy — không chỗ nào chép lại vị từ. */
function testOneGate() {
  const composer = readFileSync("lib/sales-chatbot/inbox-composer.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\bcan\s*\(/.test(composer), "ô soạn KHÔNG tự gọi can( — quyền trả lời chỉ nằm ở replyGate (lib/sales-chatbot/inbox.ts)");
  assert.ok(!/ai_sales:reply|outreach:send|ai_sales:view/.test(composer), "ô soạn không nhắc lại khoá quyền nào — mọi khoá nằm ở cổng chung");
  assert.ok(!/salesChatConversations/.test(composer), "ô soạn không tự nạp hội thoại — bước nạp (mã ≤ 100, không khung thử) nằm ở cổng chung");
  const exported = [...composer.matchAll(/export async function (\w+)\(user: SessionUser, conversationId: unknown/g)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), ["composerProductPick", "composerProductSearch", "composerQuickReplies", "composerQuickReplyText"], "bốn lối của ô soạn đều nhận hội thoại");
  // Thân hàm mở bằng «{» cuối dòng chữ ký — ngoặc của kiểu trả về (`InboxResult<{ … }>`) nằm giữa dòng, không cuối dòng.
  const firstStatement = (src: string, fn: string) => {
    const from = src.indexOf(`export async function ${fn}(`);
    assert.ok(from >= 0, `không thấy hàm ${fn}`);
    const open = src.indexOf("{\n", from);
    return src.slice(open + 2, open + 200).trimStart();
  };
  for (const name of exported) assert.match(firstStatement(composer, name), /^const g = await replyGate\(user, conversationId\);/, `${name}: lệnh đầu tiên là cổng chung`);
  const inbox = readFileSync("lib/sales-chatbot/inbox.ts", "utf8");
  assert.match(firstStatement(inbox, "sendStaffReplyCore"), /^const gate = await replyGate\(user, conversationId\);/, "«Gửi» đi qua ĐÚNG cổng chung");
}

// ─────────────────────────── CSDL ───────────────────────────

type Seeded = {
  admin: SessionUser;
  conv: string;
  conv2: string;
  testConv: string;
  qr: { photo: string; price: string; off: string; ship: string; unknownStock: string; mark: string; long: string; negStock: string; okStock: string };
  v: { muc: string; kg: string; norec: string; noprice: string; am: string; removed: string; hidden: string; goneProduct: string; mark: string; jar: string };
};

/** Câu trả lời dài (không chữ số, không chữ «bảo quản» / «chả mực») — để thấy đoạn đầu bị cắt. */
const LONG_ANSWER = "Shop hỗ trợ đổi hàng trong bảy ngày nếu sản phẩm lỗi, còn nguyên tem mác và hoá đơn mua hàng. ".repeat(4).trim();

async function adminOf(org: string): Promise<SessionUser> {
  const u = await withOrganization(org, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) }));
  assert.ok(u, `quản trị của ${org}`);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false } };
}

function staffOf(org: string, id: string, permissions: string[], opts: { modules?: string[]; scope?: SessionUser["scope"] } = {}): SessionUser {
  const scope = opts.scope ?? "ALL";
  return { id, email: `${id}@${org}.local`, name: id, role: "CS", permissions, scope, departmentCodes: scope === "ALL" ? [] : ["SALES"], positionId: null, organization: { code: org, name: org, isHome: false }, ...(opts.modules ? { modules: opts.modules } : {}) };
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
    await db.insert(c).values({ id: LONG_CONV_ID, channel: "FANPAGE", status: "OPEN", visitorKey: `${org}-t-dai`, pageId: PAGE, threadId: `${org}-t-dai`, lastCustomerAt: new Date() });

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
        negStock: await qr("Tồn hộp 300g", ["hộp 300g còn không"], "Còn {{tồn:OS-AM}} hộp ạ."),
        okStock: await qr("Tồn hộp 500g", ["hộp 500g còn không"], "Còn {{tồn:OS-MUC}} hộp ạ."),
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

/**
 * Quyết định của «Gửi» trên hội thoại THẬT: chữ rỗng ⇒ qua cổng (quyền + nạp hội thoại) rồi dừng ở «Tin trống», không gửi gì. Mọi
 * kiểm «Gửi» thêm SAU bước nạp hội thoại đều hiện ra ở đây (bản cũ gọi trên hội thoại không tồn tại nên không thấy chúng).
 */
async function sendDecision(u: SessionUser, conv: string): Promise<"ALLOW" | "DENY"> {
  const r = await sendStaffReplyCore(u, conv, { text: "", requestKey: "kiem-quyen-o-soan" });
  assert.ok(!r.ok);
  if (r.error === PASSED_GATE) return "ALLOW";
  assert.ok(DENIED.includes(r.error), `«Gửi» trả một câu ngoài dự kiến: ${r.error}`);
  return "DENY";
}

async function composerDecisions(u: SessionUser, s: Seeded): Promise<("ALLOW" | "DENY")[]> {
  const out = [await composerQuickReplies(u, s.conv, ""), await composerQuickReplyText(u, s.conv, s.qr.photo), await composerProductSearch(u, s.conv, "cha muc"), await composerProductPick(u, s.conv, s.v.muc)];
  return out.map((r) => (r.ok ? "ALLOW" : "DENY"));
}

async function testQuickReplies(org: string, s: Seeded) {
  const staff = staffOf(org, "nv-tra-loi", ["ai_sales:view", "ai_sales:reply"]);
  await withOrganization(org, async () => {
    const all = await composerQuickReplies(staff, s.conv, "");
    assert.ok(all.ok, JSON.stringify(all));
    assert.equal(all.total, 8, "chỉ câu ĐANG BẬT (8 bật · 1 tắt)");
    assert.equal(all.items.length, 8);
    assert.ok(!all.items.some((i) => i.id === s.qr.off), "câu đã tắt không có trong danh sách");
    const photo = all.items.find((i) => i.id === s.qr.photo);
    assert.ok(photo && photo.imageCount === 2 && !photo.needsErp && photo.preview === "Để ngăn đá được 3 tháng ạ.", JSON.stringify(photo));
    assert.ok(all.items.find((i) => i.id === s.qr.price)?.needsErp, "câu có chỗ trống ⇒ báo điền số ERP lúc bấm");
    const longQr = all.items.find((i) => i.id === s.qr.long);
    assert.ok(longQr && longQr.preview.endsWith("…") && Array.from(longQr.preview).length <= COMPOSER_LIMITS.previewChars + 1 && LONG_ANSWER.startsWith(longQr.preview.slice(0, -1)), `câu dài ⇒ chỉ hiện đoạn đầu: ${JSON.stringify(longQr?.preview)}`);
    const filtered = await composerQuickReplies(staff, s.conv, "bao quan");
    assert.ok(filtered.ok && filtered.items.length === 1 && filtered.total === 8, "`total` là số câu ĐANG BẬT, không phải số câu khớp — trang phân biệt «chưa có câu nào» với «không câu nào khớp»");

    const ids = async (q: string) => {
      const r = await composerQuickReplies(staff, s.conv, q);
      assert.ok(r.ok, JSON.stringify(r));
      return r.items.map((i) => i.id);
    };
    assert.deepEqual(await ids("bao quan"), [s.qr.photo], "lọc không dấu");
    assert.deepEqual(await ids("BẢO QUẢN"), [s.qr.photo]);
    assert.deepEqual(await ids("bảo qu"), [s.qr.photo], "gõ dở vẫn ra");
    assert.deepEqual((await ids("cha muc")).sort(), [s.qr.price, s.qr.unknownStock].sort());
    const long = await composerQuickReplies(staff, s.conv, "x".repeat(COMPOSER_QUERY.max + 1));
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
    const neg = await composerQuickReplyText(staff, s.conv, s.qr.negStock);
    assert.ok(!neg.ok && /số đọc từ ERP/.test(neg.error), `tồn ÂM ⇒ coi là thiếu số, không chèn «Còn -2 hộp»: ${JSON.stringify(neg)}`);
    const okStock = await composerQuickReplyText(staff, s.conv, s.qr.okStock);
    assert.ok(okStock.ok && okStock.text === "Còn 10 hộp ạ.", JSON.stringify(okStock));
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
    // Shop bán không kiểm tồn ⇒ ô soạn không chèn câu có {{tồn}} (câu không có {{tồn}} vẫn chèn được).
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, sellWithoutStockCheck: true });
    const noCheck = await composerQuickReplyText(staff, s.conv, s.qr.okStock);
    assert.ok(!noCheck.ok && /không cần kiểm tồn/.test(noCheck.error), `bán không kiểm tồn ⇒ không chèn số tồn: ${JSON.stringify(noCheck)}`);
    assert.ok((await composerQuickReplyText(staff, s.conv, s.qr.price)).ok, "câu không có {{tồn}} không bị ảnh hưởng");
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG });

    // Đường BOT gửi khách (`renderQuickAnswer`): tồn ÂM ⇒ thiếu số ⇒ bot không gửi câu mẫu (lỗi có sẵn, vá cùng lượt này);
    // bán không kiểm tồn KHÔNG đổi hành vi bot — đó là quyết định của shop, hàm này không đọc cờ ấy.
    assert.equal(await renderQuickAnswer("Còn {{tồn:OS-AM}} hộp ạ.", { shippingFee: null }), null, "bot không gửi «Còn -2 hộp ạ»");
    assert.equal(await renderQuickAnswer("Còn {{tồn:OS-MUC}} hộp ạ.", { shippingFee: null }), "Còn 10 hộp ạ.");
    assert.equal(await renderQuickAnswer("Còn {{tồn:OS-MUC-1KG}} hộp ạ.", { shippingFee: null }), "Còn 0 hộp ạ.", "tồn 0 THẬT vẫn là một con số (khác tồn âm)");

    for (const [conv, why] of [
      [s.testConv, "hội thoại khung thử"],
      ["khong-co", "hội thoại không có"],
      [123, "mã không phải chữ"],
      [LONG_CONV_ID, "mã dài quá 100 ký tự (có thật trong CSDL)"],
    ] as const) {
      const r = await composerQuickReplyText(staff, conv, s.qr.photo);
      const l = await composerQuickReplies(staff, conv, "");
      assert.ok(!r.ok && r.error === NOT_FOUND && !l.ok && l.error === NOT_FOUND, `${why} ⇒ từ chối`);
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
    assert.ok(r.items.every((i) => !("stockState" in i) && !("stockSay" in i)), "lượt TÌM không mang tồn — tồn chỉ đọc lúc bấm");

    // MỘT nguồn giá: so với đúng công cụ bot gọi để báo giá, cùng cấu hình của page của hội thoại.
    const cfg = await loadSalesChatbotConfigFor(PAGE);
    const botSearch = async (query: string) => {
      const bot = await executeTool("search_products", { query }, { conversationId: s.conv, channel: "FANPAGE", config: cfg, state: {}, lastUserText: "", agent: { name: "Kiểm thử", source: "tests/inbox-composer.test.ts" } });
      assert.ok(!bot.isError, bot.content);
      return (JSON.parse(bot.content) as { results: { variant_id: string; price: number | null; price_text: string }[] }).results;
    };
    const samePrices = (mine: readonly ComposerProductHit[], botRows: Awaited<ReturnType<typeof botSearch>>, why: string) => {
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

    // Dòng của lượt tìm: chưa có vế tồn.
    const hitLine = (id: string) => byId.get(id)?.line;
    assert.equal(hitLine(s.v.muc), `Chả mực Hạ Long · Hộp 500g — ${formatVND(180_000)}`);
    assert.equal(hitLine(s.v.noprice), "Chả mực Hạ Long · Hộp nhỏ", "chưa có giá ⇒ không in giá (không bao giờ «0 ₫»)");
    assert.ok(byId.get(s.v.noprice)?.price === null && byId.get(s.v.noprice)?.priceText === null);
    assert.equal(r.priceNote, null, "shop không bật giá sỉ ⇒ không ghi chú giá");

    // Bấm ⇒ đọc ĐÍCH DANH mẫu mã đó: giá + tồn lúc bấm.
    const picked = async (id: string) => {
      const x = await composerProductPick(staff, s.conv, id);
      assert.ok(x.ok, `bấm ${id}: ${JSON.stringify(x)}`);
      return x.product;
    };
    const order = [s.v.muc, s.v.kg, s.v.norec, s.v.noprice, s.v.am];
    const products = await Promise.all(order.map(picked));
    assert.deepEqual(products.map((p) => p.stockState), ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN", "IN_STOCK", "NEGATIVE"]);
    assert.deepEqual(products.map((p) => p.stockSay), ["còn hàng", "hết hàng", null, "còn hàng", null], "chữ tồn trang hiện = chữ tồn trong dòng chèn");
    assert.deepEqual(
      products.map((p) => p.line),
      [
        `Chả mực Hạ Long · Hộp 500g — ${formatVND(180_000)} · còn hàng`,
        `Chả mực Hạ Long · Hộp 1kg — ${formatVND(350_000)} · hết hàng`,
        `Chả mực Hạ Long · Hộp 200g — ${formatVND(120_000)}`,
        "Chả mực Hạ Long · Hộp nhỏ — còn hàng",
        `Chả mực Hạ Long · Hộp 300g — ${formatVND(90_000)}`,
      ],
      "tồn chưa biết / âm ⇒ không nói tồn; chưa có giá ⇒ không in giá",
    );
    assert.match(products[2].stockNote ?? "", /phiếu nhập/);
    assert.match(products[4].stockNote ?? "", /ÂM/);
    // Giá đổi sau lượt tìm ⇒ dòng chèn mang giá MỚI.
    await db.update(schema.productVariants).set({ retailPrice: 190_000 }).where(eq(schema.productVariants.id, s.v.muc));
    assert.equal((await picked(s.v.muc)).line, `Chả mực Hạ Long · Hộp 500g — ${formatVND(190_000)} · còn hàng`);
    // Ẩn sau lượt tìm ⇒ không chèn; mã đã gỡ / ẩn / không có / sai kiểu / rỗng ⇒ không chèn.
    await db.update(schema.productVariants).set({ isHidden: true }).where(eq(schema.productVariants.id, s.v.kg));
    for (const id of [s.v.kg, s.v.removed, s.v.hidden, s.v.goneProduct, "khong-co", 42, ""]) {
      const x = await composerProductPick(staff, s.conv, id);
      assert.ok(!x.ok && /không còn bán/.test(x.error), `mẫu mã ${String(id)} không chèn được`);
    }
    await db.update(schema.productVariants).set({ isHidden: false }).where(eq(schema.productVariants.id, s.v.kg));

    // Shop bật giá sỉ ⇒ «(giá lẻ)» ngay trong dòng — lúc tìm lẫn lúc bấm (chân bảng không đi theo dòng đã chèn).
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, wholesalePricing: true });
    const ws = await composerProductSearch(staff, s.conv, "cha muc");
    assert.ok(ws.ok && /giá LẺ/i.test(ws.priceNote ?? ""), "bật giá sỉ ⇒ chân bảng nói rõ đây là giá lẻ");
    assert.equal(ws.items.find((i) => i.variantId === s.v.muc)?.line, `Chả mực Hạ Long · Hộp 500g — ${formatVND(190_000)} ${COMPOSER_RETAIL_MARK}`);
    assert.equal(ws.items.find((i) => i.variantId === s.v.noprice)?.line, "Chả mực Hạ Long · Hộp nhỏ", "không có giá ⇒ không có «(giá lẻ)»");
    assert.equal((await picked(s.v.muc)).line, `Chả mực Hạ Long · Hộp 500g — ${formatVND(190_000)} ${COMPOSER_RETAIL_MARK} · còn hàng`);

    // Shop bán không kiểm tồn ⇒ không một chữ tồn nào lúc bấm.
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, sellWithoutStockCheck: true });
    const noCheck = await Promise.all(order.map(picked));
    assert.deepEqual(noCheck.filter((p) => p.stockSay !== null || /còn hàng|hết hàng/.test(p.line)), [], "bán không kiểm tồn ⇒ không «còn hàng» / «hết hàng»");
    assert.ok(noCheck.every((p) => p.stockState === "NOT_CHECKED" && /không cần kiểm tồn/.test(p.stockNote ?? "")), "KHÔNG ÁP DỤNG, không phải CHƯA BIẾT");
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG });

    // Từ khoá: dưới 2 ký tự / chỉ khoảng trắng / quá 200 ký tự ⇒ lỗi rõ; đúng 2 và đúng 200 ký tự vẫn tìm.
    for (const q of ["", "   ", undefined, "a", "  a  "]) {
      const x = await composerProductSearch(staff, s.conv, q);
      assert.ok(!x.ok && /ít nhất 2 ký tự/.test(x.error), `từ khoá ${JSON.stringify(q)}`);
    }
    assert.ok((await composerProductSearch(staff, s.conv, "ch")).ok, `đúng ${COMPOSER_QUERY.productMin} ký tự vẫn tìm`);
    const tooLong = await composerProductSearch(staff, s.conv, "a".repeat(COMPOSER_QUERY.max + 1));
    assert.ok(!tooLong.ok && /tối đa 200 ký tự/.test(tooLong.error));
    assert.ok((await composerProductSearch(staff, s.conv, "a".repeat(COMPOSER_QUERY.max))).ok, "đúng trần vẫn tìm");
    for (const conv of [s.testConv, "khong-co", LONG_CONV_ID]) {
      const x = await composerProductSearch(staff, conv, "cha muc");
      const y = await composerProductPick(staff, conv, s.v.muc);
      assert.ok(!x.ok && x.error === NOT_FOUND && !y.ok && y.error === NOT_FOUND, "hội thoại khung thử / không có / mã quá dài ⇒ từ chối");
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
    // Phạm vi dữ liệu không thu hẹp quyền trả lời (hộp thư chưa có luật phạm vi) — siết luật ở cổng chung phải làm ca này đỏ.
    ["xem + trả lời, phạm vi phòng ban", staffOf(org, "nv-pb", ["ai_sales:view", "ai_sales:reply"], { scope: "DEPARTMENT" }), "ALLOW"],
    ["quản trị", s.admin, "ALLOW"],
    ["phiên thật đủ quyền nhưng module ai_sales tắt trong phiên", staffOf(org, "nv-tat", ["ai_sales:view", "ai_sales:reply"], { modules: withoutAi }), "DENY"],
    ["quản trị, module ai_sales tắt trong phiên", { ...s.admin, modules: withoutAi }, "DENY"],
  ];
  await withOrganization(org, async () => {
    for (const [why, u, expected] of matrix) {
      const send = await sendDecision(u, s.conv);
      assert.equal(send, expected, `«Gửi» với ${why}`);
      assert.deepEqual(await composerDecisions(u, s), [send, send, send, send], `công cụ ô soạn đòi ĐÚNG quyền của «Gửi» — ${why}`);
    }
  });
}

/** Module AI bán hàng tắt ở TỔ CHỨC ⇒ phiên dựng lại (danh sách module không còn `ai_sales`) bị từ chối ở «Gửi» lẫn ô soạn. */
async function testModuleOff(org: string, s: Seeded) {
  await setModule(org, "ai_sales", false);
  try {
    await withOrganization(org, async () => {
      const enabled = [...(await getEnabledModules(org))];
      assert.ok(!enabled.includes("ai_sales"));
      const session = { ...s.admin, modules: enabled };
      assert.equal(await sendDecision(session, s.conv), "DENY", "«Gửi» từ chối khi module tắt");
      assert.deepEqual(await composerDecisions(session, s), ["DENY", "DENY", "DENY", "DENY"], "module tắt ⇒ mọi công cụ ô soạn từ chối, như mọi action hộp thư");
      // Người dựng tay KHÔNG mang danh sách module (chỉ có ở kiểm thử / script): ô soạn quyết y như «Gửi» — một cổng, một đáp án.
      const bare = await sendDecision(s.admin, s.conv);
      assert.deepEqual(await composerDecisions(s.admin, s), [bare, bare, bare, bare], "người dựng tay: ô soạn ≡ «Gửi»");
    });
  } finally {
    await setModule(org, "ai_sales", true);
  }
}

async function attack(attacker: string, admin: SessionUser, own: Seeded, victimCode: string, victim: Seeded): Promise<string[]> {
  const leaks: string[] = [];
  const victimMark = markOf(victimCode);
  await withOrganization(attacker, async () => {
    const list = await composerQuickReplies(admin, own.conv, "");
    if (!list.ok || JSON.stringify(list).includes(victimMark)) leaks.push("danh sách câu mẫu lẫn của tổ chức khác");
    if ((await composerQuickReplies(admin, own.conv, "cau rieng")).ok === false) leaks.push("lọc câu mẫu hỏng");
    if ((await composerQuickReplies(admin, victim.conv, "")).ok) leaks.push("dùng được hội thoại của tổ chức khác (danh sách câu mẫu)");
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
  testOneGate();
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
      "  ✓ Ô soạn hộp thư: MỘT cổng với «Gửi» (mã nguồn + ma trận 9 ca trên hội thoại thật, gồm phạm vi phòng ban) · chèn tại con trỏ / nối cuối trên dòng riêng · câu mẫu ĐANG BẬT, lọc không dấu, ảnh không kèm, chỗ trống điền số ERP lúc bấm theo page (thiếu số / tồn âm / bán không kiểm tồn ⇒ không chèn; bot không gửi tồn âm) · sản phẩm cùng giá + thứ tự với bot, tìm ≥ 2 ký tự không đọc tồn, bấm đọc đích danh giá + tồn, «(giá lẻ)» khi bật giá sỉ · mã hội thoại > 100 / khung thử ⇒ từ chối · module tắt ⇒ từ chối · cô lập 2 chiều",
    );
  } finally {
    await cleanup();
  }
}
