/**
 * ═══════════ SẮP LẠI GIAO DIỆN SĂN KHÁCH + LIÊN HỆ (chủ shop 30/10/2026) — THUẦN + QUÉT NGUỒN ═══════════
 *
 * Không đổi luật / truy vấn nghiệp vụ / quyền — chỉ sắp lại giao diện. Bài này khoá:
 *  1. Thanh tab NĂM bước theo thứ tự công việc + bánh răng; quyền từng tab giữ như cũ; route cũ còn đủ (không 404).
 *  2. Thẻ tiến độ: %, đã xử lý / tổng, dự kiến xong — mẫu số 0 ⇒ «—», chưa có tốc độ ⇒ không bịa giờ xong.
 *  3. Nhật ký CHE SĐT / email («0965 34 ****», «ei***@…»).
 *  4. Dời chức năng, không bỏ: Nhập CSV ⇒ trang Khách tiềm năng; Độ phủ ⇒ tab Hiệu quả; ghi công Google Maps giữ nguyên.
 *  5. Mẫu nội dung: bản cấu hình cũ (chưa có trường) đọc ra danh sách rỗng, không làm hỏng cả cấu hình.
 * Phần CSDL (nhật ký thật không lộ SĐT, lưu mẫu chỉ đổi ba trường chữ) nằm trong tests/wholesale-lead-hunter.test.ts::testDb.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { WHOLESALE_GEAR, WHOLESALE_NAV, wholesaleNavModel, type WholesalePerm } from "@/lib/constants/wholesale-nav";
import { mergeLeadHunterConfig, messageTemplateSchema } from "@/lib/wholesale/config";
import { campaignMarket, formatDuration, maskContact, maskEmail, maskInlineContacts, maskPhone, pctOf, runProgress, shortText } from "@/lib/wholesale/run-progress";

const ALL: WholesalePerm[] = ["wholesale:view", "wholesale:work", "wholesale:scan", "wholesale:config"];
const allow = (perms: WholesalePerm[]) => (p: WholesalePerm) => perms.includes(p);
const read = (f: string) => readFileSync(f, "utf8");

function testNav() {
  const full = wholesaleNavModel(allow(ALL), "hunter");
  assert.deepEqual(full.tabs.map((t) => t.label), ["Săn khách", "Khách tiềm năng", "Liên hệ", "Báo giá", "Hiệu quả"], "năm bước đúng thứ tự công việc");
  assert.equal(full.gear?.href, "/wholesale/settings", "cấu hình là nút bánh răng riêng");
  assert.ok(full.tabs[0]!.active && !full.subTabs.length);
  const outbox = wholesaleNavModel(allow(ALL), "outbox");
  assert.ok(outbox.tabs.find((t) => t.key === "contact")!.active, "Hộp thư đi thuộc bước Liên hệ");
  assert.deepEqual(outbox.subTabs.map((t) => [t.href, t.active]), [["/wholesale/outreach", false], ["/wholesale/outbox", true]], "Liên hệ có hai tab con");
  assert.deepEqual(wholesaleNavModel(allow(ALL), "readiness").subTabs.map((t) => t.key), ["dashboard", "readiness"], "Sẵn sàng bán sỉ là tab con của Hiệu quả");
  assert.ok(wholesaleNavModel(allow(ALL), "settings").gear?.active);
  // Quyền giữ như cũ: chỉ xem ⇒ không Săn khách (scan), không Liên hệ (work), không bánh răng (config).
  const viewer = wholesaleNavModel(allow(["wholesale:view"]), "leads");
  assert.deepEqual(viewer.tabs.map((t) => t.label), ["Khách tiềm năng", "Báo giá", "Hiệu quả"]);
  assert.equal(viewer.gear, null);
  // Mỗi trang cũ vẫn có đúng một chỗ trên thanh tab, với đúng quyền của nó, và vẫn tồn tại (không 404).
  const leaves = [...WHOLESALE_NAV.flatMap((g) => g.children), WHOLESALE_GEAR];
  const legacy: Record<string, WholesalePerm> = {
    "/wholesale/lead-hunter": "wholesale:scan",
    "/wholesale/leads": "wholesale:view",
    "/wholesale/outreach": "wholesale:work",
    "/wholesale/outbox": "wholesale:work",
    "/wholesale/quotations": "wholesale:view",
    "/wholesale/dashboard": "wholesale:view",
    "/wholesale/readiness": "wholesale:view",
    "/wholesale/settings": "wholesale:config",
  };
  assert.deepEqual(leaves.map((l) => l.href).sort(), Object.keys(legacy).sort(), "không trang nào rơi khỏi thanh tab");
  for (const l of leaves) {
    assert.equal(l.perm, legacy[l.href], `${l.href}: quyền tab giữ như trước`);
    assert.ok(existsSync(`app/(dashboard)${l.href}/page.tsx`), `${l.href}: route cũ phải còn`);
  }
}

function testProgress() {
  const p = runProgress({ success: 6, failed: 1, skipped: 3, pending: 10, startedAt: "2026-10-30T02:00:00Z", now: new Date("2026-10-30T03:00:00Z") });
  assert.deepEqual([p.processed, p.total, p.pct], [10, 20, 50]);
  assert.equal(p.elapsedMs, 3_600_000);
  assert.equal(p.etaMs, 3_600_000, "10 việc trong 1 giờ ⇒ 10 việc còn lại ~1 giờ");
  const cells = runProgress({ success: 40, failed: 2, skipped: 90, pending: 5, processed: 15, startedAt: null });
  assert.deepEqual([cells.processed, cells.total, cells.elapsedMs, cells.etaMs], [15, 20, null, null], "chiến dịch quét đếm Ô; chưa biết mốc ⇒ không có giờ xong");
  const empty = runProgress({ success: 0, failed: 0, skipped: 0, pending: 0, startedAt: null });
  assert.equal(empty.pct, null, "lượt rỗng ⇒ «—», không phải 0%");
  assert.equal(runProgress({ success: 3, failed: 0, skipped: 0, pending: 0, startedAt: new Date(Date.now() - 60_000) }).etaMs, 0, "hết việc ⇒ đã xong");
  assert.equal(runProgress({ success: 0, failed: 0, skipped: 0, pending: 4, startedAt: new Date() }).etaMs, null, "chưa xử lý việc nào ⇒ chưa có tốc độ");
  assert.equal(pctOf(1, 0), null);
  assert.equal(pctOf(1, 3), 33.3);
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(30_000), "< 1 phút");
  assert.equal(formatDuration(125 * 60_000), "2 giờ 05 phút");
  assert.equal(campaignMarket([{ label: "Mỹ" }, { label: "Úc" }, { label: "Canada" }, { label: "Đức" }]), "Mỹ · Úc · Canada +1");
  assert.equal(campaignMarket([]), "—");
  assert.equal(shortText("a  b\nc", 10), "a b c");
}

function testMasking() {
  assert.equal(maskPhone("0965341234"), "0965 34 ****");
  assert.equal(maskPhone("+84 965 341 234"), "0965 34 ****", "+84 ⇒ 0…, vẫn che");
  assert.equal(maskPhone("02838234567"), "0283 82 *****");
  assert.equal(maskPhone("123"), "****", "số ngắn ⇒ che hết");
  assert.equal(maskPhone(null), "—");
  assert.equal(maskEmail("einkauf@saigonmarket.de"), "ei***@saigonmarket.de");
  assert.equal(maskEmail("a@b.vn"), "a***@b.vn");
  assert.equal(maskEmail("khong-co-a-cong"), "***");
  assert.equal(maskContact({ phone: "0905123456", email: "x@y.vn", channel: "EMAIL" }), "x***@y.vn", "kênh email ⇒ che email");
  assert.equal(maskContact({ phone: "0905123456", email: "x@y.vn", channel: "ZALO" }), "0905 12 ****");
  assert.equal(maskContact({ phone: null, email: null }), "—");
  assert.equal(maskInlineContacts("Khách hẹn gọi 0905 123 456, mail chu@quana.vn, lấy 120 hộp giá 350000"), "Khách hẹn gọi 0905 12 ****, mail ch***@quana.vn, lấy 120 hộp giá 350000", "ghi chú tự do cũng che; giá / số lượng giữ nguyên");
  for (const raw of ["0965341234", "+84965341234"]) assert.ok(!maskPhone(raw).replace(/\s/g, "").includes("341234"), "không còn đủ 6 số cuối");
}

function testMovesAndSources() {
  const hunter = read("app/(dashboard)/wholesale/lead-hunter/page.tsx");
  assert.doesNotMatch(hunter, /ImportForm|CoverageTable/, "Nhập CSV và Độ phủ đã dời khỏi trang Săn khách");
  assert.match(hunter, /GoogleAttribution/, "ghi công Google Maps giữ nguyên");
  assert.match(hunter, /id="dang-quet"[\s\S]*id="bat-dau"[\s\S]*CampaignTable/, "ba khối đúng thứ tự: Đang quét → Bắt đầu quét mới → Chiến dịch");
  assert.ok(read("app/(dashboard)/wholesale/leads/page.tsx").includes("<ImportForm />"), "Nhập từ tệp nằm ở Khách tiềm năng");
  assert.match(read("app/(dashboard)/wholesale/leads/page.tsx"), /Nhập từ tệp/);
  assert.match(read("app/(dashboard)/wholesale/dashboard/page.tsx"), /CoverageTable/, "Độ phủ nằm ở tab Hiệu quả");
  const form = read("app/(dashboard)/wholesale/lead-hunter/campaign-form.tsx");
  assert.match(form, /title="Chọn khu vực"[\s\S]*title="Xem trước[\s\S]*title="Lưu nháp hoặc bắt đầu quét"[\s\S]*Tuỳ chỉnh nâng cao/, "form ba bước, tuỳ chỉnh gập cuối");
  // Nhật ký: liên hệ chỉ rời máy chủ ở dạng đã che.
  const q = read("lib/queries/wholesale-activity.ts");
  assert.ok((q.match(/contact: maskContact\(/g) ?? []).length >= 2, "mọi dòng nhật ký đi qua maskContact");
  assert.doesNotMatch(read("app/(dashboard)/wholesale/run-widgets.tsx"), /\.phone\b|\.email\b|toEmail/, "khối nhật ký không đọc trường liên hệ thô");
  // Không làm phần trái ràng buộc: không luân phiên tài khoản, không «spin», không trễ ngẫu nhiên để né lọc.
  for (const f of ["app/(dashboard)/wholesale/templates-panel.tsx", "app/(dashboard)/wholesale/outreach/page.tsx", "app/(dashboard)/wholesale/outbox/page.tsx"]) {
    assert.doesNotMatch(read(f), /Math\.random|spintax|rotateAccount|luân phiên tài khoản/i, `${f}: không có xoay vòng / spin / trễ ngẫu nhiên`);
  }
}

function testTemplatesConfig() {
  const old = mergeLeadHunterConfig({ outreach: { shopName: "Hải Sản X" } });
  assert.deepEqual(old.outreach.extraTemplates, [], "bản lưu cũ chưa có trường ⇒ danh sách rỗng");
  assert.equal(old.outreach.shopName, "Hải Sản X", "không làm hỏng phần còn lại của cấu hình");
  assert.ok(messageTemplateSchema.safeParse({ id: "t1", label: "Chào sỉ", body: "Dạ em chào anh/chị", channel: "ZALO" }).success);
  assert.ok(!messageTemplateSchema.safeParse({ id: "t1", label: "x", body: "ngắn", channel: "ZALO" }).success, "nội dung quá ngắn bị chặn");
  assert.ok(!messageTemplateSchema.safeParse({ id: "t1", label: "x", body: "Dạ em chào anh/chị", channel: "SMS_BLAST" }).success, "kênh lạ bị chặn");
}

export async function testWholesaleHunterUx() {
  testNav();
  testProgress();
  testMasking();
  testMovesAndSources();
  testTemplatesConfig();
  console.log("✓ Săn khách + Liên hệ (giao diện): 5 bước + bánh răng, quyền giữ nguyên, route cũ còn · tiến độ không bịa giờ xong · nhật ký che SĐT / email · Nhập CSV → Khách tiềm năng, Độ phủ → Hiệu quả · mẫu nội dung không hỏng cấu hình cũ");
}
