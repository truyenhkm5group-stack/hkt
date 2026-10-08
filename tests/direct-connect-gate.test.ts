/**
 * ═══════════ CỔNG «NỐI THẲNG FACEBOOK» — KHÁCH KHÔNG THẤY NÚT KHI META CHƯA DUYỆT (lib/channels/direct-connect*.ts) ═══════════
 *
 * Review #706 (09/10/2026): app nền tảng chưa được Meta cấp quyền Page ⇒ khách bấm «Kết nối Facebook» sẽ hỏng ngay. Tech Lead
 * quyết: khách thấy ô tắt «Nối thẳng Facebook — sắp mở», người vận hành nền tảng thấy nút thật, mở bằng MỘT cờ nền tảng
 * `platform_settings['meta.direct-connect.open']` (true = mọi khách · danh sách mã = chỉ các workspace đó · vắng / lạ = đóng).
 * Khoá:
 *  1. Hàm thuần: người vận hành luôn được; cờ true ⇒ mọi khách; danh sách ⇒ đúng workspace; vắng / sai kiểu ⇒ đóng.
 *  2. Đọc cờ ở CSDL control plane thật: không dòng ⇒ đóng; true ⇒ mở; danh sách ⇒ danh sách; giá trị lạ ⇒ đóng.
 *  3. DANH SÁCH ĐÓNG các lối vào giao diện tới `/api/connect/messenger/start` (bỏ chú thích): mỗi lối phải đứng sau cổng, và
 *     trang dựng nó phải lấy giá trị từ `directConnectFor` (máy chủ) — lối vào thứ tư mọc ra mà không qua cổng ⇒ đỏ.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { readDirectConnectOpen } from "@/lib/platform/direct-connect-flag";
import { DIRECT_CONNECT_OPEN_KEY, DIRECT_CONNECT_SOON_LABEL, directConnectAllowed, parseDirectConnectOpen } from "@/lib/channels/direct-connect-shared";

const stripComments = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export async function testDirectConnectGate() {
  // 1. Hàm thuần.
  assert.equal(directConnectAllowed({ operator: true, open: false, orgCode: "a" }), true, "người vận hành nền tảng luôn thấy nút thật");
  assert.equal(directConnectAllowed({ operator: false, open: false, orgCode: "a" }), false, "cờ đóng ⇒ khách không thấy nút");
  assert.equal(directConnectAllowed({ operator: false, open: true, orgCode: "a" }), true, "cờ true ⇒ mọi khách thấy nút");
  assert.equal(directConnectAllowed({ operator: false, open: ["hs-thien-nga-test"], orgCode: "hs-thien-nga-test" }), true, "cờ danh sách ⇒ workspace trong danh sách thấy nút");
  assert.equal(directConnectAllowed({ operator: false, open: ["hs-thien-nga-test"], orgCode: "khach-that" }), false, "cờ danh sách ⇒ workspace ngoài danh sách KHÔNG thấy");
  assert.equal(directConnectAllowed({ operator: false, open: ["x"], orgCode: null }), false, "không biết workspace ⇒ đóng");
  assert.equal(directConnectAllowed({ operator: false, open: [], orgCode: "a" }), false, "danh sách rỗng ⇒ ĐÓNG");
  assert.equal(directConnectAllowed({ operator: false, open: parseDirectConnectOpen([]), orgCode: "a" }), false, "mảng rỗng đọc từ CSDL ⇒ ĐÓNG");
  assert.equal(directConnectAllowed({ operator: false, open: ["hs-thien"], orgCode: "hs-thien-nga-test" }), false, "so khớp mã workspace CHÍNH XÁC, không theo tiền tố");
  assert.equal(directConnectAllowed({ operator: false, open: ["hs-thien-nga-test"], orgCode: "hs-thien" }), false, "mã ngắn hơn không khớp mã dài trong danh sách");
  assert.equal(directConnectAllowed({ operator: false, open: ["HS-THIEN-NGA-TEST"], orgCode: "hs-thien-nga-test" }), false, "khác hoa thường ⇒ không khớp (mã workspace là chữ thường)");
  for (const raw of [undefined, null, "true", 1, {}, { open: true }, false]) assert.equal(parseDirectConnectOpen(raw), false, `giá trị lạ ${JSON.stringify(raw)} ⇒ ĐÓNG`);
  assert.equal(parseDirectConnectOpen(true), true);
  assert.deepEqual(parseDirectConnectOpen(["a", 3, "", "b"]), ["a", "b"], "danh sách chỉ giữ mã chuỗi khác rỗng");

  // 2. Đọc cờ ở control plane thật (dọn lại trong finally).
  const pdb = await getPlatformDb();
  const truoc = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY) });
  try {
    await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY));
    assert.equal(await readDirectConnectOpen(), false, "không có dòng cờ ⇒ ĐÓNG");
    const dat = async (value: unknown) =>
      pdb.insert(schema.platformSettings).values({ key: DIRECT_CONNECT_OPEN_KEY, value }).onConflictDoUpdate({ target: schema.platformSettings.key, set: { value } });
    await dat(true);
    assert.equal(await readDirectConnectOpen(), true, "cờ true ⇒ mở");
    await dat(["hs-thien-nga-test"]);
    assert.deepEqual(await readDirectConnectOpen(), ["hs-thien-nga-test"], "cờ danh sách ⇒ đúng danh sách");
    await dat([]);
    assert.equal(directConnectAllowed({ operator: false, open: await readDirectConnectOpen(), orgCode: "hs-thien-nga-test" }), false, "cờ mảng rỗng trên CSDL ⇒ ĐÓNG");
    await dat("mo");
    assert.equal(await readDirectConnectOpen(), false, "cờ kiểu lạ ⇒ ĐÓNG");
  } finally {
    await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY));
    if (truoc) await pdb.insert(schema.platformSettings).values({ key: truoc.key, value: truoc.value, updatedBy: truoc.updatedBy, updatedByEmail: truoc.updatedByEmail });
  }

  // 3. Danh sách đóng các lối vào giao diện tới luồng nối thẳng.
  const LOI_VAO = ["app/(dashboard)/ai/channels/channels-panel.tsx", "app/(dashboard)/ai/sales-chatbot/messenger/page.tsx", "components/onboarding/go-live-card.tsx"];
  const tep = execFileSync("git", ["ls-files", "app", "components"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".tsx") && !f.startsWith("app/api/"))
    .filter((f) => stripComments(readFileSync(f, "utf8")).includes("/api/connect/messenger/start"));
  assert.deepEqual(tep.sort(), [...LOI_VAO].sort(), `lối vào giao diện tới /api/connect/messenger/start phải đứng sau cổng nối thẳng Facebook: ${tep.join(", ")}`);

  const panel = stripComments(readFileSync(LOI_VAO[0], "utf8"));
  const nut = panel.slice(panel.indexOf("function ConnectButton"), panel.indexOf("function Avatar"));
  assert.ok(nut.indexOf("useContext(DirectConnectContext)") >= 0, "ConnectButton đọc cổng từ ngữ cảnh do máy chủ đặt");
  assert.ok(nut.indexOf("if (!directConnect)") >= 0 && nut.indexOf("if (!directConnect)") < nut.indexOf("onClick={startConnect}"), "cổng đóng ⇒ trả ô «sắp mở» TRƯỚC mọi nút gọi startConnect");
  assert.equal((panel.match(/onClick=\{startConnect\}/g) ?? []).length, (nut.match(/onClick=\{startConnect\}/g) ?? []).length, "startConnect chỉ được gọi bên trong ConnectButton");
  assert.match(panel, /<DirectConnectContext\.Provider value=\{directConnect\}>/, "ChannelsPanel đặt ngữ cảnh cổng");
  assert.match(panel, /directConnect = false/, "panel mặc định ĐÓNG khi trang không truyền giá trị");

  const msg = stripComments(readFileSync(LOI_VAO[1], "utf8"));
  assert.match(msg, /\{directConnect \? \(\s*<a href="\/api\/connect\/messenger\/start"/, "trang Messenger: liên kết nối thẳng chỉ khi cổng mở");
  const golive = stripComments(readFileSync(LOI_VAO[2], "utf8"));
  assert.ok(golive.indexOf("!directConnect ?") >= 0 && golive.indexOf("!directConnect ?") < golive.indexOf('<a href="/api/connect/messenger/start"'), "GoLiveCard: cổng đóng ⇒ ô «sắp mở» trước liên kết nối thẳng");
  assert.match(golive, /directConnect = false/, "GoLiveCard mặc định ĐÓNG");

  // Ba nơi dựng phải lấy cổng từ máy chủ, không tự suy.
  for (const f of ["app/(dashboard)/ai/channels/page.tsx", "app/(dashboard)/ai/sales-chatbot/messenger/page.tsx", "components/onboarding/getting-started.tsx", "app/(dashboard)/ai/sales-chatbot/page.tsx"]) {
    assert.match(readFileSync(f, "utf8"), /directConnectFor\(user\)/, `${f}: cổng phải đọc qua directConnectFor(user) ở máy chủ`);
  }
  assert.ok(DIRECT_CONNECT_SOON_LABEL.includes("sắp mở"));
  console.log("  ✓ cổng nối thẳng Facebook: khách thấy «sắp mở» khi cờ đóng, người vận hành thấy nút thật · cờ true / danh sách workspace / vắng = đóng (CSDL thật) · 3 lối vào giao diện đều sau cổng, đọc từ máy chủ");
}
