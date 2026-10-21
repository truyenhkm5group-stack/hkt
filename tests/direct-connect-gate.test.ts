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
 *  4. ĐƯỜNG GHI cờ (`setDirectConnectOpen`, đóng MM-FU-712 — cửa hàng cho người duyệt Meta App Review): chỉ người vận hành, bắt
 *     buộc lý do, mã cửa hàng phải có thật + đang hoạt động + không phải nhà, có nhật ký `FLAG_SET`; mở cho cửa hàng A KHÔNG mở
 *     cho cửa hàng B.
 *  5. CÂU CHỮ theo cổng (M1, 21/10/2026): ba chỗ từng ghi cứng «sắp mở» (trang giới thiệu, Hướng dẫn, Kênh kết nối) đọc cổng.
 *     Cổng đóng ⇒ câu cũ còn nguyên; chỉ cờ = mọi cửa hàng mới đổi chữ ở trang CÔNG KHAI (cờ danh sách không đổi).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { readDirectConnectOpen, setDirectConnectOpen } from "@/lib/platform/direct-connect-flag";
import { directConnectPublic } from "@/lib/channels/direct-connect";
import { HELP_GUIDES, helpGuideForDirectConnect, helpStepText } from "@/lib/constants/help-guides";
import { DIRECT_CONNECT_MAX_ORGS, DIRECT_CONNECT_OPEN_COPY, DIRECT_CONNECT_OPEN_KEY, DIRECT_CONNECT_SOON_LABEL, directConnectAllowed, directConnectModeOf, parseDirectConnectOpen, parseOrgCodeList } from "@/lib/channels/direct-connect-shared";

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

const DC_ORGS = ["dc-review-demo", "dc-khach-that", "dc-dinh-chi"] as const;

/** 4. Đường ghi cờ — CSDL control plane thật; trả lại nguyên trạng cờ và xoá tổ chức thử trong finally. */
export async function testDirectConnectWrite() {
  // Hàm thuần đọc ô mã cửa hàng.
  assert.deepEqual(parseOrgCodeList(" dc-a, dc-b\ndc-a ;dc-c "), { codes: ["dc-a", "dc-b", "dc-c"], invalid: [] }, "tách dấu phẩy / xuống dòng / chấm phẩy, bỏ trùng");
  assert.deepEqual(parseOrgCodeList("DC-A, a, dc_b").invalid, ["DC-A", "a", "dc_b"], "chữ hoa / quá ngắn / gạch dưới ⇒ không hợp lệ, KHÔNG tự sửa");
  assert.equal(directConnectModeOf(false), "CLOSED");
  assert.equal(directConnectModeOf([]), "CLOSED", "danh sách rỗng là ĐÓNG");
  assert.equal(directConnectModeOf(["x"]), "ORGS");
  assert.equal(directConnectModeOf(true), "ALL");

  const home = await getHomeOrganization();
  const operator: SessionUser = { id: "dc-op", email: "op@nha.local", name: "Vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
  const homeViewer: SessionUser = { ...operator, id: "dc-viewer", email: "xem@nha.local", role: "VIEWER", permissions: ["dashboard:view"] };
  const reviewerAdmin: SessionUser = { ...operator, id: "dc-reviewer", email: "reviewer@demo.local", permissions: ["platform:operate"], organization: { code: "dc-review-demo", name: "Demo", isHome: false } };
  const pdb = await getPlatformDb();
  const truoc = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY) });
  const audits = async () =>
    pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.action, "FLAG_SET"), eq(schema.platformAuditLog.subject, DIRECT_CONNECT_OPEN_KEY))).orderBy(schema.platformAuditLog.at);
  const stored = async () => (await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY) }))?.value;
  const dropOrgs = () => pdb.delete(schema.platformOrganizations).where(inArray(schema.platformOrganizations.code, [...DC_ORGS]));
  try {
    await dropOrgs();
    await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY));
    await pdb.insert(schema.platformOrganizations).values([
      { code: "dc-review-demo", name: "Cửa hàng duyệt Meta" },
      { code: "dc-khach-that", name: "Khách thật" },
      { code: "dc-dinh-chi", name: "Đình chỉ", status: "SUSPENDED" },
    ]);
    const n0 = (await audits()).length;

    // Không phải người vận hành — kể cả quản trị chính cửa hàng duyệt mang khoá platform:operate — không tự mở được cho mình.
    for (const [who, label] of [
      [homeViewer, "người nhà không có platform:operate"],
      [reviewerAdmin, "quản trị cửa hàng duyệt (tổ chức không phải nhà)"],
    ] as const) {
      const r = await setDirectConnectOpen(who, { mode: "ORGS", orgCodes: "dc-review-demo", reason: "tự mở cho mình" });
      assert.ok("error" in r, `${label} ⇒ từ chối`);
    }
    assert.equal(await stored(), undefined, "lượt bị từ chối không ghi cờ");
    assert.equal((await audits()).length, n0, "lượt bị từ chối không ghi nhật ký");

    // Đầu vào sai ⇒ từ chối CẢ lượt, không ghi phần đúng.
    const tooMany = Array.from({ length: DIRECT_CONNECT_MAX_ORGS + 1 }, (_, i) => `dc-x${i}`).join(",");
    for (const [input, why] of [
      [{ mode: "ORGS", orgCodes: "dc-review-demo", reason: "ngắn" }, "lý do < 5 ký tự"],
      [{ mode: "OPEN", orgCodes: "", reason: "chế độ lạ ở đây" }, "chế độ lạ"],
      [{ mode: "ORGS", orgCodes: "", reason: "danh sách rỗng" }, "ORGS không mã nào"],
      [{ mode: "ORGS", orgCodes: "dc-review-demo, DC-KHACH", reason: "có mã gõ hoa" }, "mã không hợp lệ"],
      [{ mode: "ORGS", orgCodes: "dc-review-demo, dc-khong-co", reason: "có mã không tồn tại" }, "mã không tồn tại"],
      [{ mode: "ORGS", orgCodes: "dc-dinh-chi", reason: "cửa hàng đình chỉ" }, "cửa hàng không ACTIVE"],
      [{ mode: "ORGS", orgCodes: home.code, reason: "liệt kê tổ chức nhà" }, "tổ chức nhà"],
      [{ mode: "ORGS", orgCodes: tooMany, reason: "quá trần danh sách" }, "quá trần"],
    ] as const) {
      const r = await setDirectConnectOpen(operator, input);
      assert.ok("error" in r, `${why} ⇒ từ chối`);
    }
    assert.equal(await stored(), undefined, "đầu vào sai không ghi cờ");
    assert.equal((await audits()).length, n0, "đầu vào sai không ghi nhật ký");

    // Mở cho ĐÚNG cửa hàng duyệt: cờ dạng danh sách + một dòng nhật ký có trước / sau / lý do / người.
    const ok = await setDirectConnectOpen(operator, { mode: "ORGS", orgCodes: "dc-review-demo", reason: "Cửa hàng cho người duyệt Meta App Review" });
    assert.deepEqual(ok, { ok: true, changed: true, open: ["dc-review-demo"] });
    assert.equal(await directConnectPublic(), false, "cờ danh sách KHÔNG đổi chữ trên trang công khai");
    assert.deepEqual(await readDirectConnectOpen(), ["dc-review-demo"]);
    const log = (await audits()).slice(n0);
    assert.equal(log.length, 1, "một lượt đổi = một dòng nhật ký");
    assert.equal(log[0].before, null, "trước: chưa từng đặt");
    assert.deepEqual(log[0].after, ["dc-review-demo"]);
    assert.equal(log[0].actorEmail, "op@nha.local");
    assert.match(log[0].reason ?? "", /Meta App Review/);

    // Ranh giới tenant: cửa hàng duyệt thấy nút, khách thật KHÔNG.
    const open = await readDirectConnectOpen();
    assert.equal(directConnectAllowed({ operator: false, open, orgCode: "dc-review-demo" }), true, "cửa hàng duyệt thấy nút thật");
    assert.equal(directConnectAllowed({ operator: false, open, orgCode: "dc-khach-that" }), false, "mở cho cửa hàng duyệt KHÔNG mở cho khách thật");
    assert.equal(directConnectAllowed({ operator: false, open, orgCode: null }), false);

    // Cùng tập mã (khác thứ tự) ⇒ không đổi, không thêm nhật ký.
    await setDirectConnectOpen(operator, { mode: "ORGS", orgCodes: "dc-review-demo, dc-khach-that", reason: "thêm cửa hàng thứ hai" });
    const same = await setDirectConnectOpen(operator, { mode: "ORGS", orgCodes: "dc-khach-that dc-review-demo", reason: "bấm lại cùng danh sách" });
    assert.ok("ok" in same && !same.changed, "cùng tập mã (khác thứ tự) ⇒ không đổi");
    assert.equal((await audits()).length, n0 + 2, "lượt không đổi không ghi nhật ký");

    // Đóng ⇒ cửa hàng duyệt cũng «sắp mở»; ALL ⇒ mọi khách thấy nút.
    const closed = await setDirectConnectOpen(operator, { mode: "CLOSED", orgCodes: "", reason: "Meta trả hồ sơ, đóng lại" });
    assert.deepEqual(closed, { ok: true, changed: true, open: false });
    assert.equal(await directConnectPublic(), false, "cờ đóng ⇒ trang công khai vẫn «sắp mở»");
    assert.equal(directConnectAllowed({ operator: false, open: await readDirectConnectOpen(), orgCode: "dc-review-demo" }), false, "đóng ⇒ cửa hàng duyệt cũng thấy «sắp mở»");
    const all = await setDirectConnectOpen(operator, { mode: "ALL", orgCodes: "dc-bo-qua", reason: "Meta đã duyệt Advanced Access" });
    assert.deepEqual(all, { ok: true, changed: true, open: true }, "ALL bỏ qua ô mã cửa hàng");
    assert.equal(await directConnectPublic(), true, "cờ mọi cửa hàng ⇒ trang công khai đổi sang câu chỉ đường thật");
  } finally {
    await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, DIRECT_CONNECT_OPEN_KEY));
    if (truoc) await pdb.insert(schema.platformSettings).values({ key: truoc.key, value: truoc.value, updatedBy: truoc.updatedBy, updatedByEmail: truoc.updatedByEmail });
    await dropOrgs();
  }
  console.log("  ✓ đường ghi cờ nối thẳng Facebook: chỉ người vận hành · lý do bắt buộc · mã cửa hàng có thật / hoạt động / không phải nhà · nhật ký FLAG_SET · mở cho cửa hàng duyệt không mở cho khách khác");
}

/** 5. Câu chữ khách đọc đi theo cổng — không còn chỗ nào ghi cứng «sắp mở» ngoài bản của trạng thái đóng. */
export function testDirectConnectCopy() {
  for (const [k, t] of Object.entries(DIRECT_CONNECT_OPEN_COPY)) {
    assert.doesNotMatch(t, /sắp mở|chờ (Meta|Facebook) duyệt/i, `${k}: câu của cổng MỞ không được còn «sắp mở»`);
  }
  assert.match(DIRECT_CONNECT_OPEN_COPY.siteStep, /Pancake/, "trang giới thiệu: Pancake vẫn là một lựa chọn");
  assert.match(DIRECT_CONNECT_OPEN_COPY.siteFaq, /Pancake/, "FAQ: Pancake vẫn là một lựa chọn");

  // Hướng dẫn: cổng đóng ⇒ bài giữ NGUYÊN đối tượng (câu «sắp mở»); mở ⇒ đúng bước đánh dấu đổi câu.
  const marked = HELP_GUIDES.filter((g) => g.steps.some((st) => st.directConnect));
  assert.ok(marked.length >= 1, "có bài Hướng dẫn nhắc nối thẳng Facebook được đánh dấu");
  for (const g of marked) {
    assert.equal(helpGuideForDirectConnect(g, false), g, `${g.key}: cổng đóng ⇒ không đổi gì`);
    const open = helpGuideForDirectConnect(g, true);
    const st = open.steps.find((x) => x.directConnect)!;
    assert.equal(helpStepText(st, true), DIRECT_CONNECT_OPEN_COPY.helpStep, `${g.key}: cổng mở ⇒ câu chỉ đường thật (cả trong vỏ)`);
    assert.ok(g.steps.find((x) => x.directConnect)!.text.includes("sắp mở"), `${g.key}: bản gốc vẫn là câu «sắp mở»`);
  }
  for (const g of HELP_GUIDES) {
    for (const st of g.steps) if (!st.directConnect) assert.doesNotMatch(st.text, /thẳng Facebook[^.]*sắp mở/, `${g.key}: câu «sắp mở» về nối thẳng phải mang cờ directConnect`);
  }

  // Ba nơi dựng đọc cổng ở máy chủ, không tự suy.
  const help = stripComments(readFileSync("app/(dashboard)/help/page.tsx", "utf8"));
  assert.match(help, /directConnectFor\(user\)/, "/help: cổng đọc qua directConnectFor(user)");
  assert.match(help, /helpGuideForDirectConnect\(g, directConnect\)/, "/help: bài Hướng dẫn đi qua helpGuideForDirectConnect");
  const site = stripComments(readFileSync("app/gioi-thieu/page.tsx", "utf8"));
  assert.match(site, /await directConnectPublic\(\)/, "trang giới thiệu: cổng đọc qua directConnectPublic()");
  assert.match(site, /startSteps\(directOpen\)/, "trang giới thiệu: bước kết nối đi theo cổng");
  assert.match(site, /siteFaqs\(chotdon, directOpen\)/, "trang giới thiệu: FAQ đi theo cổng");
  assert.doesNotMatch(site, /\{START_STEPS\.map\(/, "trang giới thiệu: không vẽ thẳng START_STEPS nữa");
  const panel = stripComments(readFileSync("app/(dashboard)/ai/channels/channels-panel.tsx", "utf8"));
  assert.match(panel, /directConnect \? DIRECT_CONNECT_OPEN_COPY\.channelsHint : " Nối thẳng Facebook \(không qua Pancake\) sắp mở\."/, "Kênh kết nối: câu đi theo cổng");
  console.log("  ✓ câu chữ nối thẳng Facebook đi theo cổng: đóng ⇒ «sắp mở» như cũ · cờ danh sách không đổi trang công khai · mở cho mọi cửa hàng ⇒ chỉ đường thật, Pancake vẫn là lựa chọn");
}
