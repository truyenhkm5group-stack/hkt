/**
 * ═══════════ SỔ PHÁP LÝ CÓ KIỂU — văn bản · bên xử lý phụ · xuyên biên giới · lưu trữ · hệ thống AI · cổng ═══════════
 *
 * Năm sổ ở `lib/constants/` là bản có kiểu của `docs/legal/*`. Bài này khoá bốn điều người đọc tài liệu chỉ có thể TIN:
 *   1. Tài liệu ↔ hằng nói cùng một điều: bộ id trùng; tài liệu ghi UNKNOWN thì hằng không được ghi một giá trị; bảng cổng
 *      theo chiều trong LEGAL_LAUNCH_GATE.md §8 là đúng chuỗi hằng sinh ra.
 *   2. UNKNOWN là một giá trị hiện ra — không chuỗi rỗng, không «?», và `legalRegisterUnknowns()` đếm đủ mọi ô.
 *   3. Cổng không «xanh giả»: LEGAL READY dẫn xuất, không mục nào READY khi một chiều còn PENDING; ✅ ⇔ READY.
 *   4. Mã nguồn không đi trước sổ: hostname / SDK mã gọi mà sổ chưa khai ⇒ ĐỎ; mỗi tệp gọi sổ AI thuộc một hệ thống AI.
 * Băm văn bản: ổn định, đổi khi chữ / liên kết đổi, không đổi khi chỉ đổi lớp CSS; trang dựng ĐÚNG cây mà hàm băm đọc, và
 * HTML trang không đổi một byte so với trước khi tách nội dung (đo 09/10/2026, phiên bản 1.1).
 *
 * Thuần: không CSDL, không mạng. Quét mã nguồn đọc `git ls-files` (tệp đã vào kho — luật 65 / repo-integrity).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import React, { createElement, Fragment, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPolicyPage from "@/app/chinh-sach-bao-mat/page";
import TermsOfServicePage from "@/app/dieu-khoan-su-dung/page";
import { PRIVACY_CONTENT } from "@/components/legal/privacy-content";
import { TERMS_CONTENT } from "@/components/legal/terms-content";
import { AI_USAGE_FEATURES, PLATFORM_WORKLOADS } from "@/lib/ai-usage/types";
import { PLATFORM_GEMINI_DEFAULT_MODEL } from "@/lib/ai-usage/platform-ai";
import { AI_SYSTEM_IDS, AI_SYSTEMS, AI_USAGE_SCAN_EXEMPT_FILES, aiSystemsForFile } from "@/lib/constants/ai-systems";
import { PRIVACY_POLICY, SERVICE_COMMITMENTS, TERMS_OF_SERVICE } from "@/lib/constants/company";
import { hashLegalContent, LEGAL_DOCUMENT_KEYS, LEGAL_DOCUMENTS, legalContentSha256 } from "@/lib/constants/legal-documents";
import {
  formatP0Score,
  GATE_DIMENSIONS,
  GATE_DOC_MARKS,
  LEGAL_GATE_ITEMS,
  LEGAL_GATE_TABLE_BEGIN,
  legalReady,
  renderLegalGateDimensionTable,
  type GateDocMark,
  type LegalGateItem,
} from "@/lib/constants/legal-gate";
import {
  CROSS_BORDER_IDS,
  CROSS_BORDER_TRANSFERS,
  exemptReasonForHost,
  hostMatches,
  legalRegisterUnknowns,
  subprocessorForHost,
  SUBPROCESSORS,
  UNKNOWN,
  VENDOR_SCAN_EXEMPT_HOSTS,
} from "@/lib/constants/legal-registers";
import { deletableAfterDays, RETENTION_CATEGORIES, RETENTION_RULES, subjectEraseAllowed } from "@/lib/constants/retention";

const read = (p: string) => readFileSync(p, "utf8");
const lines = (p: string) => read(p).split(/\r?\n/);
const tracked = (...roots: string[]) =>
  execFileSync("git", ["ls-files", ...roots], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
/** Ô của một dòng bảng markdown (bỏ hai ô rỗng ở hai đầu). */
const cells = (row: string) => row.split("|").slice(1, -1).map((c) => c.trim());

/**
 * HTML của phần NỘI DUNG (đoạn mở đầu + thân) hai trang, đo NGAY TRƯỚC khi tách câu chữ ra `components/legal/*-content.tsx`
 * (09/10/2026, renderToStaticMarkup của props `intro` + `children` mà trang đưa cho `LegalPage`). Chỉ áp khi phiên bản còn
 * đúng phiên bản đã đo — tăng phiên bản là chủ ý đổi chữ, phép so «không đổi một byte» hết nghĩa.
 */
const HTML_SHA256_BEFORE_EXTRACTION = {
  TERMS: { version: "1.1", sha: "6f2580b39d788f4165c4047d0ce001116573f2a8fd703cfd1b50afb519929eaa" },
  PRIVACY: { version: "1.1", sha: "dcf60dc0ce83e62597b2577d3155adab8c6677c96d47e1e4ecf997c605834f4c" },
} as const;

type LegalPageProps = { title: string; version: string; effective: string; intro: ReactNode; children: ReactNode };

/** Mọi chuỗi trong một giá trị lồng — để bắt chuỗi rỗng / giữ chỗ ở bất kỳ trường nào. */
function strings(v: unknown, at: string, out: { at: string; s: string }[] = []): { at: string; s: string }[] {
  if (typeof v === "string") out.push({ at, s: v });
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${at}[${i}]`, out));
  else if (v && typeof v === "object" && !(v as { $$typeof?: unknown }).$$typeof) for (const [k, x] of Object.entries(v)) strings(x, `${at}.${k}`, out);
  return out;
}

/** Chuỗi giữ chỗ thay cho UNKNOWN — cấm: chưa biết thì viết UNKNOWN, để nó hiện ra và đếm được. */
const PLACEHOLDER = /^(\?+|tbd|todo|n\/?a|unknown|không rõ|chưa rõ|chưa biết|xxx)$/i;

function testLegalDocuments() {
  assert.deepEqual(Object.keys(LEGAL_DOCUMENTS).sort(), [...LEGAL_DOCUMENT_KEYS].sort());
  const terms = LEGAL_DOCUMENTS.TERMS;
  const privacy = LEGAL_DOCUMENTS.PRIVACY;
  const dpa = LEGAL_DOCUMENTS.DPA;
  assert.ok(terms.publication === "PUBLISHED" && privacy.publication === "PUBLISHED");
  // Một chỗ khai phiên bản: sổ đọc từ company.ts (nơi trang và nhật ký ORG_ONBOARDED đã đọc).
  assert.equal(terms.version, TERMS_OF_SERVICE.version);
  assert.equal(terms.effective, TERMS_OF_SERVICE.effective);
  assert.equal(terms.path, TERMS_OF_SERVICE.path);
  assert.equal(privacy.version, PRIVACY_POLICY.version);
  assert.equal(privacy.path, PRIVACY_POLICY.path);
  for (const d of [terms, privacy]) {
    assert.ok(existsSync(d.contentSource), `${d.key}: tệp nội dung ${d.contentSource} phải có`);
    const live = legalContentSha256(d.key, d.version);
    assert.equal(
      live,
      d.contentSha256,
      `${d.key} ${d.version}: nội dung đổi mà ghim băm chưa đổi — sửa câu chữ văn bản đã công bố thì TĂNG phiên bản (lib/constants/company.ts) rồi cập nhật contentSha256 = ${live}`,
    );
    assert.equal(legalContentSha256(d.key, d.version), live, "băm ổn định: gọi lại ra cùng kết quả");
    assert.equal(legalContentSha256(d.key, `${d.version}.cu`), null, "phiên bản không còn nội dung trong mã ⇒ null, không đoán");
    assert.equal(d.counsel, "COUNSEL_PENDING", `${d.key}: chưa văn bản nào được luật sư rà (G-9) — đổi trạng thái phải có văn bản`);
  }
  assert.notEqual(terms.contentSha256, privacy.contentSha256);
  // DPA: chưa có văn bản — không bịa phiên bản, đường dẫn, băm.
  assert.equal(dpa.publication, "NOT_PUBLISHED");
  assert.equal(dpa.counsel, "COUNSEL_PENDING");
  assert.ok(dpa.publication === "NOT_PUBLISHED" && dpa.version === null && dpa.path === null && dpa.blockedBy.length > 0 && dpa.plannedAs.length > 0);
  assert.equal(legalContentSha256("DPA", "1.0"), null);

  // Băm đổi khi CHỮ / LIÊN KẾT đổi; không đổi khi chỉ đổi lớp trình bày.
  const base = hashLegalContent("TERMS", "1.1", "04/10/2026", TERMS_CONTENT);
  assert.equal(base, terms.contentSha256);
  const withText = { ...TERMS_CONTENT, intro: createElement("p", null, "Điều khoản này là thoả thuận khác") };
  assert.notEqual(hashLegalContent("TERMS", "1.1", "04/10/2026", withText), base, "đổi chữ ⇒ đổi băm");
  const linkA = { title: "x", intro: createElement("a", { href: "/a", className: "u" }, "liên kết"), body: null };
  const linkB = { title: "x", intro: createElement("a", { href: "/b", className: "u" }, "liên kết"), body: null };
  const linkA2 = { title: "x", intro: createElement("a", { href: "/a", className: "text-red-500" }, "liên kết"), body: null };
  assert.notEqual(hashLegalContent("TERMS", "9", "d", linkA), hashLegalContent("TERMS", "9", "d", linkB), "đổi đích liên kết ⇒ đổi băm");
  assert.equal(hashLegalContent("TERMS", "9", "d", linkA), hashLegalContent("TERMS", "9", "d", linkA2), "đổi lớp CSS không phải đổi văn bản");
  assert.notEqual(hashLegalContent("TERMS", "9", "d", linkA), hashLegalContent("TERMS", "10", "d", linkA), "phiên bản là một phần của băm");
  assert.throws(() => hashLegalContent("TERMS", "9", "d", { title: "x", intro: createElement(async () => null), body: null }), /BẤT ĐỒNG BỘ/);

  // Trang dựng ĐÚNG cây mà hàm băm đọc, và HTML không đổi so với trước khi tách.
  (globalThis as { React?: typeof React }).React ??= React;
  for (const [key, page, content, version] of [
    ["TERMS", TermsOfServicePage, TERMS_CONTENT, TERMS_OF_SERVICE.version],
    ["PRIVACY", PrivacyPolicyPage, PRIVACY_CONTENT, PRIVACY_POLICY.version],
  ] as const) {
    const el = page() as ReactElement<LegalPageProps>;
    assert.equal(el.props.title, content.title, `${key}: tiêu đề trang = tiêu đề nội dung`);
    assert.equal(el.props.version, version);
    assert.equal(el.props.intro, content.intro, `${key}: trang đưa ĐÚNG đối tượng nội dung (không bản chép)`);
    assert.equal(el.props.children, content.body, `${key}: thân trang là ĐÚNG đối tượng nội dung`);
    const pinned = HTML_SHA256_BEFORE_EXTRACTION[key];
    if (pinned.version === version) {
      const html = renderToStaticMarkup(createElement(Fragment, null, el.props.intro, el.props.children));
      assert.equal(createHash("sha256").update(html, "utf8").digest("hex"), pinned.sha, `${key} ${version}: HTML người đọc thấy phải giữ nguyên từng byte sau khi tách nội dung`);
    }
  }
  console.log("✓ Sổ văn bản pháp lý: phiên bản đọc từ company.ts, băm nội dung ghim + ổn định + đổi khi chữ đổi, DPA chưa công bố, trang dựng đúng cây được băm (HTML không đổi)");
}

function testSubprocessors() {
  const ids = SUBPROCESSORS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "id bên xử lý phụ không trùng");
  for (const { at, s } of strings(SUBPROCESSORS, "SUBPROCESSORS")) {
    assert.ok(s.trim().length > 0, `${at}: chuỗi rỗng — chưa biết thì ghi UNKNOWN`);
    assert.ok(!PLACEHOLDER.test(s.trim()) || s === UNKNOWN, `${at}: «${s}» là chữ giữ chỗ — dùng UNKNOWN`);
  }
  for (const s of SUBPROCESSORS) {
    if (s.usage === "NOT_IN_USE") {
      assert.ok(s.calledFrom.length === 0 && s.hosts.length === 0 && s.sdks.length === 0, `${s.id}: NOT_IN_USE không được khai nơi gọi / hostname / SDK`);
      assert.ok(s.watch && s.watch.hosts.length + s.watch.sdks.length > 0, `${s.id}: NOT_IN_USE phải có danh sách canh gác`);
    } else {
      assert.ok(s.calledFrom.length > 0, `${s.id}: bên đang dùng phải trỏ tệp gọi nó`);
      assert.equal(s.watch, undefined, `${s.id}: canh gác chỉ dành cho NOT_IN_USE`);
    }
    for (const f of s.calledFrom) assert.ok(existsSync(f), `${s.id}: tệp ${f} không tồn tại`);
    assert.ok(s.dpa === UNKNOWN || s.dpa.evidence.trim().length > 0, `${s.id}: DPA khác UNKNOWN phải có bằng chứng`);
  }

  // Tài liệu ↔ hằng: bộ S-id trùng nhau; hằng không «biết» hơn tài liệu.
  const doc = lines("docs/legal/SUBPROCESSOR_REGISTER.md").filter((l) => /^\| S\d+ \|/.test(l));
  const docIds = doc.map((l) => cells(l)[0]);
  assert.deepEqual([...docIds].sort(), ids.filter((i) => /^S\d+$/.test(i)).sort(), "SUBPROCESSOR_REGISTER.md và SUBPROCESSORS phải liệt kê cùng S1…Sn");
  for (const row of doc) {
    const c = cells(row);
    const entry = SUBPROCESSORS.find((s) => s.id === c[0]);
    assert.ok(entry);
    if (/UNKNOWN/.test(c[2])) assert.equal(entry.legalEntity, UNKNOWN, `${entry.id}: tài liệu ghi pháp nhân UNKNOWN thì hằng không được ghi tên`);
    if (entry.dpa !== UNKNOWN) assert.ok(row.includes(entry.dpa.evidence), `${entry.id}: DPA khai trong hằng phải được ghi ở tài liệu trước`);
  }
  console.log(`✓ Sổ bên xử lý phụ: ${ids.length} dòng (${SUBPROCESSORS.filter((s) => s.usage === "NOT_IN_USE").length} KHÔNG dùng có canh gác), khớp S1…S30 của tài liệu, không chuỗi rỗng / giữ chỗ`);
}

function testCrossBorder() {
  assert.deepEqual(CROSS_BORDER_TRANSFERS.map((x) => x.id), [...CROSS_BORDER_IDS]);
  const sIds = new Set(SUBPROCESSORS.map((s) => s.id));
  const compliance = read("docs/legal/VIETNAM_LEGAL_COMPLIANCE.md");
  const xRows = compliance.split(/\r?\n/).filter((l) => /^\| X\d+ \|/.test(l));
  assert.deepEqual(xRows.map((l) => cells(l)[0]), [...CROSS_BORDER_IDS], "VIETNAM_LEGAL_COMPLIANCE.md §7 và CROSS_BORDER_TRANSFERS phải cùng X1…X11");
  assert.ok(compliance.includes("**Chưa hồ sơ nào được nộp. Không được ghi khác đi.**"));
  for (const x of CROSS_BORDER_TRANSFERS) {
    assert.ok(x.processors.length > 0 && x.processors.every((p) => sIds.has(p)), `${x.id}: phải trỏ tới dòng có thật của sổ bên xử lý phụ`);
    const docRegion = cells(xRows.find((l) => cells(l)[0] === x.id) ?? "")[4] ?? "";
    if (x.region !== UNKNOWN) {
      assert.ok(x.region.evidence.trim().length > 0, `${x.id}: vùng xử lý phải kèm bằng chứng`);
      assert.ok(!/UNKNOWN/.test(docRegion), `${x.id}: tài liệu ghi vùng «${docRegion}» (chưa xác minh) — hằng KHÔNG được điền vùng «${x.region.value}»`);
      assert.ok(docRegion.includes(x.region.value), `${x.id}: vùng trong hằng phải là vùng tài liệu đã ghi`);
    }
    if (x.crossBorder === "NO") assert.notEqual(x.region, UNKNOWN, `${x.id}: «không xuyên biên giới» cần vùng đã xác minh`);
    if (x.retentionAtVendor !== UNKNOWN) assert.ok(x.retentionAtVendor.evidence.trim().length > 0);
    if (x.contractEvidence !== UNKNOWN) assert.ok(x.contractEvidence.evidence.trim().length > 0);
    assert.equal(x.transferAssessment, "NOT_FILED", `${x.id}: tài liệu nói chưa hồ sơ nào được nộp`);
  }
  for (const { at, s } of strings(CROSS_BORDER_TRANSFERS, "CROSS_BORDER_TRANSFERS")) {
    assert.ok(s.trim().length > 0, `${at}: chuỗi rỗng`);
    assert.ok(!PLACEHOLDER.test(s.trim()) || s === UNKNOWN, `${at}: «${s}» là chữ giữ chỗ — dùng UNKNOWN`);
  }

  // UNKNOWN phải HIỆN RA: hàm liệt kê đếm đủ mọi ô mang đúng giá trị UNKNOWN của hai sổ.
  const exact = [...strings(SUBPROCESSORS, "S"), ...strings(CROSS_BORDER_TRANSFERS, "X")].filter((x) => x.s === UNKNOWN).length;
  const listed = legalRegisterUnknowns();
  assert.equal(listed.length, exact, "legalRegisterUnknowns() phải liệt kê MỌI ô UNKNOWN — thêm trường mới thì thêm vào hàm");
  assert.ok(listed.includes("X1.region") && listed.includes("X3.region"), "vùng Gemini / Telegram chưa xác minh phải hiện ra");
  console.log(`✓ Sổ xuyên biên giới: X1…X11 khớp tài liệu, 0 vùng điền khi tài liệu ghi UNKNOWN, ${listed.length} ô UNKNOWN đều được liệt kê, chưa hồ sơ nào nộp`);
}

/** Hostname trong mã nguồn đã vào kho (bản tối thiểu: URL http/https viết thẳng). */
function scannedHosts(): Map<string, string> {
  const files = tracked("lib", "app", "components", "chatbot/src", "deploy", "scripts", "middleware.ts", ".github/workflows").filter((f) => /\.(ts|tsx|js|mjs|cjs|sh|ya?ml)$/.test(f));
  const out = new Map<string, string>();
  for (const f of files) {
    for (const m of read(f).matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      const host = m[1].toLowerCase();
      if (!out.has(host)) out.set(host, f);
    }
  }
  return out;
}

function testVendorScan() {
  const hosts = scannedHosts();
  assert.ok(hosts.size > 20, "quét phải thấy hostname — nếu 0 là bộ quét hỏng chứ không phải mã sạch");
  for (const [h, why] of Object.entries(VENDOR_SCAN_EXEMPT_HOSTS)) assert.ok(why.trim().length >= 10, `miễn trừ ${h} phải có lý do`);
  const missing = [...hosts].filter(([h]) => !subprocessorForHost(h) && !exemptReasonForHost(h)).map(([h, f]) => `${h} (${f})`);
  assert.deepEqual(missing, [], `Mã nguồn gọi bên ngoài chưa khai ở lib/constants/legal-registers.ts + SUBPROCESSOR_REGISTER.md: ${missing.join(", ")}`);
  // Mục NOT_IN_USE còn đúng: không hostname canh gác nào xuất hiện, không SDK canh gác nào được cài.
  const pkgs = ["package.json", "chatbot/package.json"].filter(existsSync).map((p) => JSON.parse(read(p)) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> });
  const deps = new Set(pkgs.flatMap((p) => [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})]));
  for (const s of SUBPROCESSORS.filter((x) => x.usage === "NOT_IN_USE")) {
    for (const w of s.watch?.hosts ?? []) {
      const hit = [...hosts].find(([h]) => hostMatches(h, w));
      assert.equal(hit, undefined, `${s.id} khai KHÔNG dùng nhưng mã gọi ${hit?.[0]} (${hit?.[1]}) — khai bên mới (AGENTS §7: hỏi chủ nền tảng)`);
    }
    for (const w of s.watch?.sdks ?? []) assert.ok(!deps.has(w), `${s.id} khai KHÔNG dùng nhưng package.json có ${w}`);
  }
  // SDK của bên ngoài đã cài phải thuộc một dòng đang dùng.
  const declaredSdks = new Set(SUBPROCESSORS.filter((s) => s.usage !== "NOT_IN_USE").flatMap((s) => s.sdks));
  for (const sdk of ["@anthropic-ai/sdk", "openai", "@google/genai", "@google/generative-ai", "googleapis", "@aws-sdk/client-s3"]) {
    if (deps.has(sdk)) assert.ok(declaredSdks.has(sdk), `package.json có ${sdk} nhưng sổ bên xử lý phụ chưa khai`);
  }
  console.log(`✓ Quét mã nguồn: ${hosts.size} hostname, mỗi cái thuộc một bên đã khai hoặc miễn trừ có lý do; mục KHÔNG dùng vẫn không bị gọi`);
}

function testAiSystems() {
  assert.deepEqual(AI_SYSTEMS.map((s) => s.id), [...AI_SYSTEM_IDS]);
  assert.deepEqual(AI_SYSTEMS.filter((s) => s.origin === "SECTION_11").map((s) => s.id), ["AI-01", "AI-02", "AI-03", "AI-04", "AI-05"], "AI-01…AI-05 theo §11");
  for (const s of AI_SYSTEMS) {
    for (const { at, s: v } of strings(s, s.id)) assert.ok(v.trim().length > 0, `${at}: chuỗi rỗng`);
    assert.ok(s.callSites.length > 0 && s.providers.length > 0 && s.humanOversight.length > 0 && s.incidentHandling.length > 0, `${s.id}: thiếu trường bắt buộc`);
    for (const f of [...s.callSites, ...s.humanOversight, ...s.incidentHandling]) assert.ok(existsSync(f), `${s.id}: tệp ${f} không tồn tại`);
    if (s.risk === "UNCLASSIFIED") assert.equal(s.riskEvidence, null, `${s.id}: chưa phân loại thì không có bằng chứng phân loại`);
    else assert.ok(s.riskEvidence && s.riskEvidence.trim().length > 0, `${s.id}: mức ${s.risk} phải kèm bằng chứng phân loại (G-4)`);
  }
  assert.ok(AI_SYSTEMS.every((s) => s.risk === "UNCLASSIFIED"), "chưa có văn bản phân loại nào (G-4) — mọi hệ thống UNCLASSIFIED");
  assert.ok(AI_SYSTEMS[0].model.defaults.includes(PLATFORM_GEMINI_DEFAULT_MODEL), "model mặc định đọc từ hằng cấu hình, không gõ lại");
  for (const f of AI_USAGE_FEATURES) assert.ok(AI_SYSTEMS.some((s) => s.features.includes(f)), `feature «${f}» của sổ dùng AI chưa thuộc hệ thống AI nào`);
  for (const w of PLATFORM_WORKLOADS) assert.ok(AI_SYSTEMS.some((s) => s.workloads.includes(w)), `workload «${w}» chưa thuộc hệ thống AI nào`);

  // Quét: mỗi tệp gọi recordAiUsage( thuộc một hệ thống, và feature / workload viết thẳng trong tệp thuộc hệ thống đó.
  const files = tracked("lib", "app").filter((f) => /\.tsx?$/.test(f) && read(f).includes("recordAiUsage("));
  assert.ok(files.some((f) => f.startsWith("lib/sales-chatbot/")), "quét phải thấy đường gọi AI bán hàng");
  for (const f of files) {
    if (AI_USAGE_SCAN_EXEMPT_FILES[f]) continue;
    const owners = aiSystemsForFile(f);
    assert.ok(owners.length > 0, `${f} ghi sổ dùng AI nhưng không thuộc hệ thống nào ở lib/constants/ai-systems.ts`);
    const src = read(f);
    const features = new Set(owners.flatMap((o) => o.features));
    const workloads = new Set<string>(owners.flatMap((o) => o.workloads));
    for (const m of src.matchAll(/\bfeature: "([a-z_]+)"/g)) assert.ok(features.has(m[1] as (typeof AI_USAGE_FEATURES)[number]), `${f}: feature «${m[1]}» không thuộc ${owners.map((o) => o.id).join("/")}`);
    for (const m of src.matchAll(/\bworkload: "([a-z_]+)"/g)) assert.ok(workloads.has(m[1]), `${f}: workload «${m[1]}» không thuộc ${owners.map((o) => o.id).join("/")}`);
  }
  for (const [f, why] of Object.entries(AI_USAGE_SCAN_EXEMPT_FILES)) assert.ok(existsSync(f) && why.trim().length >= 10, `miễn trừ ${f} phải tồn tại và có lý do`);
  console.log(`✓ Sổ hệ thống AI: AI-01…AI-08, mọi feature / workload có chủ, ${files.length} tệp ghi sổ AI đều thuộc một hệ thống, mức rủi ro UNCLASSIFIED (chờ G-4)`);
}

function testRetention() {
  assert.deepEqual(RETENTION_RULES.map((r) => r.category), [...RETENTION_CATEGORIES]);
  for (const r of RETENTION_RULES) {
    assert.ok(r.label && r.basis && r.currentBehaviour && r.decidedBy.length > 0 && r.stores.length > 0, `${r.category}: thiếu trường`);
    if (r.retentionDays === null) {
      assert.equal(r.status, "UNDECIDED", `${r.category}: null = CHƯA QUYẾT`);
      assert.equal(r.decisionEvidence, null);
      assert.equal(deletableAfterDays(r.category), null, `${r.category}: chưa quyết ⇒ không xoá, không mặc định ngầm`);
    } else {
      assert.equal(r.status, "DECIDED", `${r.category}: có con số thì phải là quyết định`);
      assert.ok(r.decisionEvidence && r.decisionEvidence.trim().length > 0, `${r.category}: con số phải kèm văn bản quyết định của ${r.decidedBy.join(" / ")}`);
      assert.ok(Number.isInteger(r.retentionDays) && r.retentionDays > 0);
      assert.equal(deletableAfterDays(r.category), r.retentionDays);
    }
    assert.ok(r.afterExpiryFloorDays === null || r.afterExpiryFloorDays === SERVICE_COMMITMENTS.retainAfterExpiryDays, `${r.category}: sàn sau hết hạn đọc từ SERVICE_COMMITMENTS`);
    assert.equal(subjectEraseAllowed(r.category), !r.legalHold);
  }
  for (const c of ["ORDERS", "BILLING_INVOICES", "AUDIT"] as const) assert.equal(subjectEraseAllowed(c), false, `${c}: LEGAL HOLD — không xoá theo yêu cầu (DSR_PROCEDURE.md §3.4)`);
  const docHold = read("docs/legal/DSR_PROCEDURE.md");
  assert.ok(docHold.includes("subjectEraseAllowed()") && docHold.includes("lib/constants/retention.ts"), "quy trình DSR trỏ đúng nguồn LEGAL HOLD");
  console.log(`✓ Khung lưu trữ: ${RETENTION_RULES.length} loại, ${RETENTION_RULES.filter((r) => r.retentionDays === null).length} chưa quyết (null ⇒ không xoá), LEGAL HOLD đúng ba loại chứng từ`);
}

const MARK_OF: Record<string, GateDocMark> = Object.fromEntries(Object.entries(GATE_DOC_MARKS).map(([k, v]) => [v, k as GateDocMark]));
function markIn(cell: string): GateDocMark | null {
  for (const ch of Object.values(GATE_DOC_MARKS)) if (cell.includes(ch)) return MARK_OF[ch];
  return null;
}

function testLegalGate() {
  const ids = LEGAL_GATE_ITEMS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const i of LEGAL_GATE_ITEMS) {
    for (const d of GATE_DIMENSIONS) {
      if (i.states[d] === "NOT_NEEDED") assert.ok((i.notNeeded[d] ?? "").trim().length >= 10, `${i.id}.${d}: NOT_NEEDED phải kèm lý do`);
      else assert.equal(i.notNeeded[d], undefined, `${i.id}.${d}: lý do «không cần» cho một chiều không phải NOT_NEEDED`);
    }
    if (i.states.ENGINEERING === "READY") {
      assert.ok(i.engineeringEvidence.length > 0, `${i.id}: ENGINEERING READY phải trỏ bằng chứng`);
      for (const f of i.engineeringEvidence) assert.ok(existsSync(f), `${i.id}: bằng chứng ${f} không tồn tại`);
    }
    const pending = GATE_DIMENSIONS.some((d) => i.states[d] === "PENDING");
    if (pending) assert.equal(legalReady(i), false, `${i.id}: còn chiều PENDING mà LEGAL READY — xanh giả`);
  }
  // LEGAL READY là hàm của năm chiều — một mục giả đủ bốn chiều mà luật sư còn PENDING vẫn KHÔNG ready.
  const allClosed: LegalGateItem = { ...LEGAL_GATE_ITEMS[0], states: { ENGINEERING: "READY", COUNSEL: "ANSWERED", GOVERNMENT_FILING: "FILED", ACCOUNTING: "DONE", OWNER: "DECIDED" }, notNeeded: {} };
  assert.equal(legalReady(allClosed), true);
  for (const d of ["COUNSEL", "GOVERNMENT_FILING", "ACCOUNTING", "OWNER"] as const) {
    assert.equal(legalReady({ ...allClosed, states: { ...allClosed.states, [d]: "PENDING" } }), false, `${d} PENDING ⇒ không LEGAL READY`);
  }
  for (const e of ["WIP", "NOT_STARTED"] as const) assert.equal(legalReady({ ...allClosed, states: { ...allClosed.states, ENGINEERING: e } }), false);

  // Tài liệu ↔ hằng: bộ mục, ký hiệu, tổng điểm, bảng theo chiều.
  const gateDoc = read("docs/legal/LEGAL_LAUNCH_GATE.md");
  const begin = gateDoc.indexOf(LEGAL_GATE_TABLE_BEGIN);
  assert.ok(begin > 0, "LEGAL_LAUNCH_GATE.md phải có bảng theo chiều (§8)");
  // Bảng ký hiệu §2 / §3 nằm TRƯỚC bảng sinh tự động (bảng đó cũng có dòng «| P0-1 |»).
  const rows = gateDoc.slice(0, begin).split(/\r?\n/).filter((l) => /^\| P[01]-\d+ \|/.test(l));
  assert.deepEqual(rows.map((l) => cells(l)[0]), ids, "LEGAL_LAUNCH_GATE.md §2 / §3 và LEGAL_GATE_ITEMS phải cùng bộ mục, cùng thứ tự");
  for (const row of rows) {
    const c = cells(row);
    const item = LEGAL_GATE_ITEMS.find((i) => i.id === c[0]);
    assert.ok(item);
    const mark = markIn(item.tier === "P0" ? c[5] : c[4]);
    assert.equal(mark, item.docMark, `${item.id}: ký hiệu tài liệu (${mark}) ≠ docMark (${item.docMark})`);
    assert.equal(item.docMark === "DONE", legalReady(item), `${item.id}: ✅ ở tài liệu ⇔ LEGAL READY dẫn xuất`);
    if (item.docMark === "PENDING_AUTHORITY") assert.equal(item.states.GOVERNMENT_FILING, "FILED", `${item.id}: ⛔ nghĩa là đã nộp`);
  }
  const totalLine = gateDoc.split(/\r?\n/).find((l) => l.includes("**Tổng P0**"));
  assert.ok(totalLine, "tài liệu phải có dòng Tổng P0");
  assert.equal(cells(totalLine)[6], `**${formatP0Score()}**`, "dòng Tổng P0 = điểm tính từ ký hiệu");
  assert.ok(gateDoc.includes(renderLegalGateDimensionTable()), "LEGAL_LAUNCH_GATE.md §8 phải là ĐÚNG bảng sinh từ lib/constants/legal-gate.ts — chạy renderLegalGateDimensionTable() và chép lại");
  const ready = LEGAL_GATE_ITEMS.filter(legalReady).map((i) => i.id);
  console.log(`✓ Cổng pháp lý: ${ids.length} mục × 5 chiều, LEGAL READY dẫn xuất (${ready.length ? ready.join(", ") : "0 mục"}), không mục nào READY khi còn PENDING; tài liệu khớp (P0 ${formatP0Score()})`);
}

export function testLegalRegisters() {
  testLegalDocuments();
  testSubprocessors();
  testCrossBorder();
  testVendorScan();
  testAiSystems();
  testRetention();
  testLegalGate();
}
