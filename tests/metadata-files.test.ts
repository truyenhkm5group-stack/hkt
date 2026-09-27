/**
 * PHASE 3.1 · TẢI TỆP CỦA FIELD `file` (`app/api/metadata/files/[id]/route.ts`).
 *
 * Hai phần:
 *  · THUẦN: `customFileResponseHeaders` — kiểu mở-ngay là danh sách ĐÓNG; html / svg / kiểu lạ ⇒ octet-stream +
 *    attachment; tên tệp không phá được tiêu đề; luôn `nosniff` + `private, no-store`.
 *  · HAI TỔ CHỨC THẬT (`pf-a`, `pf-b` — `provisionOrganization`, tự dọn): gọi thẳng HANDLER route trong phiên thật
 *    (JWT ký bằng bí mật của ứng dụng). Phiên A ⇒ 200 đúng byte + tiêu đề an toàn + một dòng nhật ký tải; phiên B
 *    với id của A ⇒ 404, 0 byte; id rác / id không có / field ARCHIVED / bản ghi đã xoá ⇒ 404 CÙNG MỘT CÂU; tệp
 *    .html ⇒ attachment + octet-stream; module của đối tượng tắt ⇒ 403 MODULE_DISABLED.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { GET as metadataFileGET } from "@/app/api/metadata/files/[id]/route";
import { setRequestPathSourceForTests, type SessionUser } from "@/lib/auth/session";
import { moduleOfPath } from "@/lib/constants/platform-modules";
import { env } from "@/lib/env";
import { archiveCustomField, createCustomField } from "@/lib/metadata/fields";
import { customFileHref, customFileResponseHeaders, safeDownloadName } from "@/lib/metadata/display";
import type { MetadataActor } from "@/lib/metadata/types";
import { customFileNames, saveCustomFile } from "@/lib/metadata/values";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const A = "pf-a";
const B = "pf-b";

function testHeadersPure() {
  const png = customFileResponseHeaders({ filename: "anh.png", mime: "image/png", size: 3 });
  assert.equal(png["content-type"], "image/png");
  assert.match(png["content-disposition"], /^inline;/);
  assert.equal(png["content-security-policy"], "sandbox; default-src 'none'", "ảnh mở-ngay vẫn trong hộp cát");
  const pdf = customFileResponseHeaders({ filename: "hop-dong.pdf", mime: "Application/PDF", size: 3 });
  assert.equal(pdf["content-type"], "application/pdf", "kiểu so không phân biệt hoa thường");
  assert.match(pdf["content-disposition"], /^inline;/);
  for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "text/javascript", "application/octet-stream", "", "khong/hop-le"]) {
    const h = customFileResponseHeaders({ filename: "x", mime, size: 1 });
    assert.equal(h["content-type"], "application/octet-stream", `${mime || "(trống)"} ⇒ octet-stream`);
    assert.match(h["content-disposition"], /^attachment;/, `${mime || "(trống)"} ⇒ attachment`);
  }
  for (const h of [png, pdf]) {
    assert.equal(h["x-content-type-options"], "nosniff");
    assert.equal(h["cache-control"], "private, no-store");
    assert.equal(h["content-length"], "3");
  }
  const bad = customFileResponseHeaders({ filename: 'a"b;\r\nSet-Cookie: x=1\\..\\..\\evil.html', mime: "text/html", size: 1 });
  assert.ok(!/[\r\n]/.test(bad["content-disposition"]), "tên tệp không chèn được dòng tiêu đề mới");
  assert.equal((bad["content-disposition"].match(/"/g) ?? []).length, 2, "đúng một cặp nháy bao tên");
  assert.equal(safeDownloadName("../../hop dong.pdf"), "hop dong.pdf");
  assert.equal(safeDownloadName(""), "tep");
  const vi = customFileResponseHeaders({ filename: "Hợp đồng (bản 2)'.pdf", mime: "application/pdf", size: 1 });
  assert.match(vi["content-disposition"], /filename="H_p __ng \(b_n 2\).pdf"; filename\*=UTF-8''H%E1%BB%A3p%20%C4%91%E1%BB%93ng%20%28b%E1%BA%A3n%202%29.pdf$/, "tên tiếng Việt: bản ASCII + bản RFC 5987 (mã hoá cả ngoặc)");
  assert.equal(customFileHref("abc"), "/api/metadata/files/abc");
  assert.equal(moduleOfPath("/api/metadata/files/x"), "core", "route tải tệp thuộc lõi — module của ĐỐI TƯỢNG do route tự kiểm");
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function adminOf(org: string) {
  return withOrganization(org, async () => {
    const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email };
  });
}

async function tokenOf(org: string, u: { id: string; email: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: u.email, name: "Quản trị", role: "ADMIN", org, lgn: now })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(u.id)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(new TextEncoder().encode(env.authSecret));
}

function sessionOf(u: { id: string; email: string }): SessionUser {
  return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null };
}

async function download(token: string, id: string): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const reqPath = `/api/metadata/files/${id}`;
  setSessionTokenSourceForTests(async () => token);
  setRequestPathSourceForTests(() => reqPath);
  try {
    const res = await metadataFileGET(new Request(`http://erp.local${reqPath}`), { params: Promise.resolve({ id }) });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

export async function testMetadataFiles() {
  testHeadersPure();

  for (const code of [A, B]) {
    await cleanupOrg(code);
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: ["customers"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Files@12345" }, source: "TEST", actor: null });
  }
  try {
    const adminA = await adminOf(A);
    const adminB = await adminOf(B);
    const actorA: MetadataActor = { id: adminA.id, email: adminA.email };
    const viewerA = sessionOf(adminA);
    const PDF = Buffer.from("%PDF-1.4 hợp đồng của A — không được lọt sang B");
    const HTML = Buffer.from("<script>alert(document.cookie)</script>");

    const ids = await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values([
        { id: "pf-a-cus1", name: "Khách A1" },
        { id: "pf-a-cus2", name: "Khách A2 — sẽ bị xoá" },
      ]);
      for (const key of ["contract_file", "page_file", "old_file"]) assert.ok((await createCustomField("customer", { key, label: key, type: "file" }, actorA)).ok, key);
      const pdf = await saveCustomFile("customer", "pf-a-cus1", "contract_file", { filename: "Hợp đồng.pdf", mime: "application/pdf", data: PDF }, viewerA);
      const html = await saveCustomFile("customer", "pf-a-cus1", "page_file", { filename: "trang.html", mime: "text/html", data: HTML }, viewerA);
      const old = await saveCustomFile("customer", "pf-a-cus1", "old_file", { filename: "cu.png", mime: "image/png", data: Buffer.from("PNG-CU") }, viewerA);
      const gone = await saveCustomFile("customer", "pf-a-cus2", "contract_file", { filename: "mat.pdf", mime: "application/pdf", data: Buffer.from("%PDF mat") }, viewerA);
      assert.ok(pdf.ok && html.ok && old.ok && gone.ok, "bốn tệp lưu được");
      assert.ok((await archiveCustomField("customer", "old_file", actorA)).ok, "lưu trữ field old_file");
      await db.delete(schema.customValues).where(and(eq(schema.customValues.objectKey, "customer"), eq(schema.customValues.recordId, "pf-a-cus2")));
      await db.delete(schema.customers).where(eq(schema.customers.id, "pf-a-cus2"));
      const names = await customFileNames("customer", "pf-a-cus1", [pdf.file.id, html.file.id, old.file.id, gone.file.id, "rac"], viewerA);
      assert.deepEqual(names, { [pdf.file.id]: "Hợp đồng.pdf", [html.file.id]: "trang.html" }, "tên tệp: chỉ field tệp đang dùng, chỉ tệp của bản ghi này");
      return { pdf: pdf.file.id, html: html.file.id, old: old.file.id, gone: gone.file.id };
    });

    const tokenA = await tokenOf(A, adminA);
    const tokenB = await tokenOf(B, adminB);

    // ── Phiên A: đúng byte, tiêu đề an toàn ──
    const ok = await download(tokenA, ids.pdf);
    assert.equal(ok.status, 200, "phiên A mở tệp của A ⇒ 200");
    assert.ok(ok.body.equals(PDF), "đúng từng byte");
    assert.equal(ok.headers.get("content-type"), "application/pdf");
    assert.match(ok.headers.get("content-disposition") ?? "", /^inline; filename="H_p __ng.pdf"; filename\*=UTF-8''/);
    assert.equal(ok.headers.get("cache-control"), "private, no-store");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(ok.headers.get("content-length"), String(PDF.length));

    // ── .html: không bao giờ mở như một trang ──
    const html = await download(tokenA, ids.html);
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("content-type"), "application/octet-stream", ".html ⇒ octet-stream");
    assert.match(html.headers.get("content-disposition") ?? "", /^attachment;/, ".html ⇒ attachment");
    assert.ok(html.body.equals(HTML));

    // ── 404 cùng một câu, không một byte ──
    const cau404: string[] = [];
    const cases: [string, string, string][] = [
      ["phiên B mở id của A", tokenB, ids.pdf],
      ["id rác", tokenA, "khong-phai-id"],
      ["id đúng dạng mà không có", tokenA, "00000000-0000-4000-8000-000000000000"],
      ["field đã ARCHIVED", tokenA, ids.old],
      ["bản ghi đã xoá", tokenA, ids.gone],
    ];
    for (const [ten, token, id] of cases) {
      const r = await download(token, id);
      assert.equal(r.status, 404, `${ten} ⇒ 404`);
      assert.ok(!r.body.includes(PDF) && !r.body.includes(Buffer.from("PNG-CU")) && !r.body.includes(Buffer.from("%PDF mat")), `${ten}: 0 byte của tệp`);
      assert.ok(!(r.headers.get("content-type") ?? "").startsWith("application/pdf"), `${ten}: không khai kiểu tệp`);
      cau404.push(r.body.toString("utf8"));
    }
    assert.equal(new Set(cau404).size, 1, `mọi 404 CÙNG MỘT CÂU — không dò được id nào có thật (nhận: ${JSON.stringify([...new Set(cau404)])})`);

    // ── Nhật ký tải: một dòng mỗi lượt 200, không mang nội dung ──
    await withOrganization(A, async () => {
      const rows = await (await getDb()).select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "CUSTOM_FILE"), eq(schema.auditLogs.action, "CUSTOM_FILE_DOWNLOAD")));
      assert.equal(rows.length, 2, "hai lượt tải thành công ⇒ hai dòng nhật ký; lượt 404 không ghi");
      assert.deepEqual(rows.map((r) => r.entityId).sort(), [ids.pdf, ids.html].sort());
      assert.ok(rows.every((r) => r.userId === adminA.id), "nhật ký mang khoá tài khoản người tải (luật 34)");
      assert.ok(rows.every((r) => !JSON.stringify(r.detail).includes("PDF-1.4") && !JSON.stringify(r.detail).includes("<script>")), "nhật ký KHÔNG chứa nội dung tệp");
    });

    // ── Module của đối tượng tắt ⇒ 403 MODULE_DISABLED ──
    const pdb = await getPlatformDb();
    const orgA = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, A) });
    assert.ok(orgA);
    await pdb
      .update(schema.platformOrganizationModules)
      .set({ enabled: false })
      .where(and(eq(schema.platformOrganizationModules.organizationId, orgA.id), eq(schema.platformOrganizationModules.moduleKey, "customers")));
    invalidateCapabilities();
    const off = await download(tokenA, ids.pdf);
    assert.equal(off.status, 403, "module Khách hàng tắt ⇒ 403");
    assert.equal(off.headers.get("x-erp-deny"), "MODULE_DISABLED");
    assert.ok(!off.body.includes(PDF), "403 không mang byte nào");

    console.log(
      "✓ Metadata · tải tệp field `file`: phiên A ⇒ 200 đúng byte + nosniff + private,no-store · .html/.svg/kiểu lạ ⇒ octet-stream + attachment · B với id của A / id rác / id không có / field ARCHIVED / bản ghi đã xoá ⇒ 404 cùng một câu, 0 byte · một dòng nhật ký mỗi lượt tải, không nội dung · module tắt ⇒ 403 MODULE_DISABLED",
    );
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    for (const code of [A, B]) await cleanupOrg(code);
  }
}

