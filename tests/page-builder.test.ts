/**
 * NỀN TẢNG · TRÌNH DỰNG TRANG KÉO-THẢ (Phase 5 · hợp đồng §4) — `/settings/pages/[id]/builder`.
 *
 * Hai phần:
 *  1. HÀM THUẦN `lib/platform-ui/page-builder-ops.ts` — mọi thao tác trên khung là `(schema, op) → schema`: chèn,
 *     dời (trong nhóm, sang nhóm, vào / ra cột), đổi chỗ nhóm, bắt độ rộng, nhân bản (khoá mới, nhân cả con), xoá,
 *     thêm nhóm / hàng, bọc vào cột; từ chối ⇒ trả NGUYÊN schema; không sửa đầu vào; hoàn tác ≤ 50 bước; lỗi máy
 *     chủ theo `path` đổi sang KHOÁ KHỐI của schema đã gửi.
 *  2. LÕI MÁY CHỦ `lib/platform-ui/page-builder.ts` với `SessionUser` dựng tay (server action đọc cookie nên không
 *     gọi được ngoài request): thiếu quyền bị từ chối TRƯỚC dịch vụ; vòng đời thật trên một tổ chức riêng
 *     (`pb-p5`, tự cấp, tự dọn) — tự lưu, lỗi theo path, xuất bản, thêm vào menu.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema as dbSchema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { MODULE_KEYS } from "@/lib/constants/platform-modules";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { listNavPages } from "@/lib/pages/registry";
import { PAGE_MAX_BLOCKS, PAGE_MAX_SECTIONS, type PageBlock, type PageSchema } from "@/lib/pages/types";
import { adminCreatePage, loadPageEditor } from "@/lib/platform-ui/page-admin";
import { aggregatableFields, blankPageMeta, dateFields, filterBarOps, filterTargetsOf, groupableFields, normalizePageMeta, rowActionOptions, type PageEditorCatalog, type PageObjectOption } from "@/lib/platform-ui/page-admin-shared";
import { buildCatalog, type CatalogField } from "@/lib/platform-ui/metadata-admin-shared";
import { objectDef } from "@/lib/constants/object-registry";
import { PAGE_ACTIONS } from "@/lib/pages/catalog";
import { adminAddPageToMenu, adminLoadBuilderDraft, adminPublishFromBuilder, adminSaveBuilderDraft, loadPageBuilder } from "@/lib/platform-ui/page-builder";
import { MODULE_KEYS as ALL_MODULES } from "@/lib/constants/platform-modules";
import { validatePageSchema } from "@/lib/pages/components";
import {
  applyOp,
  blockEarlyIssue,
  builderEarlyCheck,
  checkOp,
  childrenOf,
  COLUMN_MAX_CHILDREN,
  commit,
  endOfSection,
  errorsByBlock,
  findBlock,
  freshBlockId,
  HISTORY_LIMIT,
  initHistory,
  isColumn,
  LIBRARY,
  libraryRefusal,
  locate,
  newBuilderBlock,
  redo,
  sectionVariant,
  slotOutOfColumn,
  snapSpan,
  spanFromDrag,
  stepSlot,
  totalBlocks,
  undo,
  type BuilderOp,
} from "@/lib/platform-ui/page-builder-ops";

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "pb-user", email: "pb@local", name: "PB", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: "nha", name: "Nhà", isHome: true }, modules: [...MODULE_KEYS], ...over };
}

const text = (id: string, span: PageBlock["span"] = 12): PageBlock => ({ id, type: "text", span, config: { body: id } });
const kpi = (id: string): PageBlock => ({ id, type: "kpi", span: 3, config: { metric: "orders_today" } });

/** s1: kpi_1(3) · text_1 · text_2 ; s2: text_3 */
function fixture(): PageSchema {
  return {
    version: 1,
    sections: [
      { key: "s1", title: "Một", blocks: [kpi("kpi_1"), text("text_1"), text("text_2")] },
      { key: "s2", title: "Hai", blocks: [text("text_3")] },
    ],
  };
}

const ids = (s: PageSchema) => s.sections.map((x) => x.blocks.map((b) => (isColumn(b) ? `${b.id}[${childrenOf(b).map((c) => c.id).join(",")}]` : b.id)).join(" "));

/** Đóng băng sâu: phép biến đổi mà sửa tại chỗ đầu vào sẽ ném ngay trong chế độ nghiêm ngặt của ESM. */
function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object") {
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

const EMPTY_CATALOG: PageEditorCatalog = { metrics: [], series: [], lists: [], timelines: [], actions: [], objects: [], periods: [] };

function testInsertMove() {
  const base = deepFreeze(fixture());
  // Chèn vào giữa nhóm; khoá trùng / vị trí lạ / nhóm lạ ⇒ từ chối, trả NGUYÊN tham chiếu.
  const ins = applyOp(base, { kind: "insertBlock", block: text("text_9"), at: { section: 0, column: null, index: 1 } });
  assert.deepEqual(ids(ins), ["kpi_1 text_9 text_1 text_2", "text_3"]);
  for (const bad of [
    { kind: "insertBlock", block: text("text_1"), at: { section: 0, column: null, index: 0 } },
    { kind: "insertBlock", block: text("text_9"), at: { section: 0, column: null, index: 4 } },
    { kind: "insertBlock", block: text("text_9"), at: { section: 5, column: null, index: 0 } },
    { kind: "insertBlock", block: text("text_9"), at: { section: 0, column: "khong_co", index: 0 } },
  ] as BuilderOp[]) {
    assert.ok(checkOp(base, bad), `phải từ chối ${JSON.stringify(bad)}`);
    assert.equal(applyOp(base, bad), base, "từ chối ⇒ cùng tham chiếu, không làm một nửa");
  }
  assert.match(checkOp(base, { kind: "insertBlock", block: text("text_1"), at: { section: 0, column: null, index: 0 } }) ?? "", /đã có/);

  // Dời TRONG nhóm: chỉ số thả tính trên danh sách còn chứa khối đang kéo.
  assert.deepEqual(ids(applyOp(base, { kind: "moveBlock", id: "kpi_1", to: { section: 0, column: null, index: 3 } })), ["text_1 text_2 kpi_1", "text_3"], "kéo xuống cuối");
  assert.deepEqual(ids(applyOp(base, { kind: "moveBlock", id: "kpi_1", to: { section: 0, column: null, index: 2 } })), ["text_1 kpi_1 text_2", "text_3"], "thả trước text_2 ⇒ đứng sau text_1");
  assert.deepEqual(ids(applyOp(base, { kind: "moveBlock", id: "text_2", to: { section: 0, column: null, index: 0 } })), ["text_2 kpi_1 text_1", "text_3"], "kéo lên đầu");
  assert.equal(applyOp(base, { kind: "moveBlock", id: "text_1", to: { section: 0, column: null, index: 1 } }), base, "thả ngay trước chính nó ⇒ không đổi");
  assert.equal(applyOp(base, { kind: "moveBlock", id: "text_1", to: { section: 0, column: null, index: 2 } }), base, "thả ngay sau chính nó ⇒ không đổi");
  // Sang nhóm khác: không mất, không nhân đôi, giữ nguyên cấu hình + độ rộng.
  const across = applyOp(base, { kind: "moveBlock", id: "kpi_1", to: { section: 1, column: null, index: 0 } });
  assert.deepEqual(ids(across), ["text_1 text_2", "kpi_1 text_3"]);
  assert.equal(findBlock(across, "kpi_1")?.span, 3);
  assert.equal(totalBlocks(across), totalBlocks(base));
  assert.ok(checkOp(base, { kind: "moveBlock", id: "khong_co", to: endOfSection(base, 0) }));

  // Đổi chỗ nhóm.
  const swapped = applyOp(base, { kind: "moveSection", from: 0, to: 1 });
  assert.deepEqual(swapped.sections.map((s) => s.key), ["s2", "s1"]);
  assert.ok(checkOp(base, { kind: "moveSection", from: 0, to: 2 }));

  // Nút bàn phím: lên / xuống một bậc ⇒ cùng kết quả với kéo; đầu / cuối ⇒ không có chỗ.
  assert.equal(stepSlot(base, "kpi_1", -1), null);
  assert.equal(stepSlot(base, "text_2", 1), null);
  assert.deepEqual(ids(applyOp(base, { kind: "moveBlock", id: "kpi_1", to: stepSlot(base, "kpi_1", 1)! })), ["text_1 kpi_1 text_2", "text_3"]);
  assert.deepEqual(ids(applyOp(base, { kind: "moveBlock", id: "text_2", to: stepSlot(base, "text_2", -1)! })), ["kpi_1 text_2 text_1", "text_3"]);
}

function testSpanDuplicateRemoveSections() {
  const base = deepFreeze(fixture());
  // Bắt độ rộng: gần nhất trong 3/4/6/8/12, hoà ⇒ bên rộng hơn; ngoài biên kẹp lại.
  assert.deepEqual([2, 3, 3.4, 3.6, 5, 7, 9, 10, 11, 100, Number.NaN].map(snapSpan), [3, 3, 3, 4, 6, 8, 8, 12, 12, 12, 12]);
  assert.equal(spanFromDrag(3, 300, 1200), 6, "kéo 1/4 bề ngang = +3 cột ⇒ 1/2");
  assert.equal(spanFromDrag(12, -600, 1200), 6);
  assert.equal(spanFromDrag(6, 50, 0), 6, "chưa đo được bề ngang ⇒ giữ nguyên");
  const wide = applyOp(base, { kind: "setSpan", id: "kpi_1", span: 7 });
  assert.equal(findBlock(wide, "kpi_1")?.span, 8);
  assert.equal(findBlock(base, "kpi_1")?.span, 3, "không sửa đầu vào");

  // Nhân bản: đứng ngay sau bản gốc, khoá mới không trùng, cấu hình là BẢN SAO (không dùng chung object).
  const dup = applyOp(base, { kind: "duplicateBlock", id: "kpi_1" });
  assert.deepEqual(ids(dup), ["kpi_1 kpi_2 text_1 text_2", "text_3"]);
  assert.notEqual(findBlock(dup, "kpi_2")?.config, findBlock(dup, "kpi_1")?.config);
  assert.deepEqual(findBlock(dup, "kpi_2")?.config, findBlock(dup, "kpi_1")?.config);
  const dup2 = applyOp(dup, { kind: "duplicateBlock", id: "kpi_2" });
  const dupIds = dup2.sections.flatMap((s) => s.blocks.map((b) => b.id));
  assert.equal(dupIds.length, 6);
  assert.equal(new Set(dupIds).size, dupIds.length, "nhân bản lần hai vẫn không trùng khoá");
  assert.equal(freshBlockId(new Set(["table_1", "table_2"]), "table_1"), "table_3");
  assert.match(freshBlockId(new Set(), "9x-Lạ"), /^[a-z][a-z0-9_]{1,40}$/, "khoá sinh ra luôn khớp mẫu máy chủ");
  assert.match(freshBlockId(new Set(), "a".repeat(60)), /^[a-z][a-z0-9_]{1,40}$/);

  // Xoá.
  assert.deepEqual(ids(applyOp(base, { kind: "removeBlock", id: "text_1" })), ["kpi_1 text_2", "text_3"]);

  // Nhóm / hàng: thêm đúng chỗ, khoá nhóm không trùng; trần 8 nhóm; không xoá nhóm cuối cùng.
  const withRow = applyOp(base, { kind: "insertSection", variant: "plain", at: 1 });
  assert.equal(withRow.sections.length, 3);
  assert.equal(sectionVariant(withRow.sections[1]), "plain");
  assert.equal(withRow.sections[1].title, undefined, "hàng không có tiêu đề");
  assert.equal(new Set(withRow.sections.map((s) => s.key)).size, 3);
  const withCard = applyOp(base, { kind: "insertSection", variant: "card", at: 2 });
  assert.equal(sectionVariant(withCard.sections[2]), "card");
  assert.equal(withCard.sections[2].title, "Nhóm mới");
  let many: PageSchema = base;
  for (let i = 0; i < 20; i++) many = applyOp(many, { kind: "insertSection", variant: "card", at: many.sections.length });
  assert.equal(many.sections.length, PAGE_MAX_SECTIONS, "trần 8 nhóm");
  const one: PageSchema = { version: 1, sections: [base.sections[0]] };
  assert.equal(applyOp(one, { kind: "removeSection", index: 0 }), one, "trang cần ít nhất một nhóm");
  assert.deepEqual(applyOp(base, { kind: "removeSection", index: 0 }).sections.map((s) => s.key), ["s2"]);
  assert.equal(applyOp(base, { kind: "patchSection", index: 1, title: "" }).sections[1].title, undefined);

  // Sửa khối: đổi khoá sang khoá đã có ⇒ từ chối; bỏ tiêu đề / hiển thị rỗng ⇒ xoá hẳn khoá, không để chuỗi rỗng.
  assert.ok(checkOp(base, { kind: "patchBlock", id: "text_1", patch: { id: "text_2" } }));
  const renamed = applyOp(base, { kind: "patchBlock", id: "text_1", patch: { id: "gioi_thieu", title: "" } });
  assert.ok(findBlock(renamed, "gioi_thieu") && !findBlock(renamed, "text_1"));
  assert.ok(!("title" in findBlock(renamed, "gioi_thieu")!));
  const vis = applyOp(base, { kind: "patchBlock", id: "kpi_1", patch: { visibility: { permission: undefined, module: undefined } } });
  assert.ok(!("visibility" in findBlock(vis, "kpi_1")!));
}

function testColumns() {
  const base = deepFreeze(fixture());
  // Bọc vào cột: cột mang độ rộng cũ, khối con rộng hết cột; trần khối đếm cả cột.
  const wrapped = applyOp(base, { kind: "wrapInColumn", id: "kpi_1" });
  const col = wrapped.sections[0].blocks[0];
  assert.ok(isColumn(col));
  assert.equal(col.span, 3);
  assert.deepEqual(childrenOf(col).map((c) => [c.id, c.span]), [["kpi_1", 12]]);
  assert.equal(totalBlocks(wrapped), totalBlocks(base) + 1, "trần 20 đếm CẢ cột lẫn khối con");
  assert.deepEqual(locate(wrapped, "kpi_1"), { section: 0, index: 0, child: 0 });
  assert.ok(checkOp(wrapped, { kind: "wrapInColumn", id: "kpi_1" }), "đã trong cột ⇒ không bọc lần hai");
  assert.ok(checkOp(wrapped, { kind: "setSpan", id: "kpi_1", span: 6 }), "khối trong cột không đổi độ rộng riêng");

  // Vào cột (từ nhóm khác), đổi chỗ trong cột, ra khỏi cột.
  const inCol = applyOp(wrapped, { kind: "moveBlock", id: "text_3", to: { section: 0, column: col.id, index: 1 } });
  assert.deepEqual(ids(inCol), [`${col.id}[kpi_1,text_3] text_1 text_2`, ""]);
  assert.equal(findBlock(inCol, "text_3")?.span, 12);
  const reordered = applyOp(inCol, { kind: "moveBlock", id: "kpi_1", to: { section: 0, column: col.id, index: 2 } });
  assert.deepEqual(ids(reordered)[0], `${col.id}[text_3,kpi_1] text_1 text_2`);
  const out = slotOutOfColumn(inCol, "text_3")!;
  assert.deepEqual(ids(applyOp(inCol, { kind: "moveBlock", id: "text_3", to: out })), [`${col.id}[kpi_1] text_3 text_1 text_2`, ""]);
  assert.equal(slotOutOfColumn(inCol, "text_1"), null);

  // Chỉ MỘT tầng lồng: cột vào cột ⇒ từ chối; cột vào chính nó ⇒ từ chối; tối đa 6 khối con.
  const two = applyOp(inCol, { kind: "wrapInColumn", id: "text_1" });
  const col2 = two.sections[0].blocks[1];
  assert.ok(isColumn(col2));
  assert.match(checkOp(two, { kind: "moveBlock", id: col2.id, to: { section: 0, column: col.id, index: 0 } }) ?? "", /cột trong cột/);
  assert.ok(checkOp(two, { kind: "moveBlock", id: col.id, to: { section: 0, column: col.id, index: 0 } }));
  assert.match(checkOp(two, { kind: "insertBlock", block: { ...text("loc_1"), type: "filter" } as unknown as PageBlock, at: { section: 0, column: col.id, index: 0 } }) ?? "", /Bộ lọc/);
  let full = two;
  for (let i = 0; i < 10; i++) full = applyOp(full, { kind: "insertBlock", block: text(`them_${i}`), at: { section: 0, column: col.id, index: 0 } });
  assert.equal(childrenOf(full.sections[0].blocks[0]).length, COLUMN_MAX_CHILDREN, "cột dừng ở 6 khối, không cắt bớt im lặng");
  assert.ok(checkOp(full, { kind: "duplicateBlock", id: "kpi_1" }), "nhân bản trong cột đầy ⇒ từ chối");
  // Dời TRONG cùng một cột đầy vẫn được (không tính chỗ của chính nó).
  assert.equal(checkOp(full, { kind: "moveBlock", id: "kpi_1", to: { section: 0, column: col.id, index: 0 } }), null);

  // Nhân bản cột: khoá mới cho cột VÀ mọi khối con, không trùng khoá nào.
  const dupCol = applyOp(inCol, { kind: "duplicateBlock", id: col.id });
  const allIds = dupCol.sections.flatMap((s) => s.blocks.flatMap((b) => [b.id, ...childrenOf(b).map((c) => c.id)]));
  assert.equal(new Set(allIds).size, allIds.length);
  assert.equal(totalBlocks(dupCol), totalBlocks(inCol) + 3);
  assert.equal(childrenOf(dupCol.sections[0].blocks[1]).length, 2);

  // Khối con cùng gốc khoá (kpi_1, kpi_2 trong một cột) — bản nhân bản vẫn không va nhau.
  const twins = applyOp(applyOp(base, { kind: "duplicateBlock", id: "kpi_1" }), { kind: "wrapInColumn", id: "kpi_1" });
  const twinCol = twins.sections[0].blocks[0];
  const withTwins = applyOp(twins, { kind: "moveBlock", id: "kpi_2", to: { section: 0, column: twinCol.id, index: 1 } });
  assert.deepEqual(childrenOf(withTwins.sections[0].blocks[0]).map((c) => c.id), ["kpi_1", "kpi_2"]);
  const twinDup = applyOp(withTwins, { kind: "duplicateBlock", id: twinCol.id });
  const twinIds = twinDup.sections.flatMap((s) => s.blocks.flatMap((b) => [b.id, ...childrenOf(b).map((c) => c.id)]));
  assert.equal(new Set(twinIds).size, twinIds.length, `nhân bản cột có hai con cùng gốc khoá: ${twinIds.join(",")}`);

  // Chèn thẳng vào cột ⇒ khối rộng hết cột (độ rộng riêng bị bỏ).
  const inserted = applyOp(wrapped, { kind: "insertBlock", block: text("chen_1", 6), at: { section: 0, column: col.id, index: 0 } });
  assert.equal(findBlock(inserted, "chen_1")?.span, 12);

  // Khối con trong cột vẫn mang độ rộng HỢP LỆ (renderer bỏ qua, nhưng kiểm schema vẫn đòi) — máy chủ không báo `.span`.
  const v = validatePageSchema(inCol, { modules: new Set(ALL_MODULES), moduleIssues: "warning" });
  assert.deepEqual(v.errors.filter((e) => e.path.endsWith(".span")), [], JSON.stringify(v.errors));
  assert.ok(v.ok, `cột dựng bằng phép thuần qua được kiểm của máy chủ: ${JSON.stringify(v.errors)}`);

  // Nhóm ⇄ hàng: hàng bỏ tiêu đề (renderer không vẽ), đổi lại nhóm thì bỏ khoá variant.
  const row = applyOp(base, { kind: "setSectionVariant", index: 0, variant: "plain" });
  assert.equal(sectionVariant(row.sections[0]), "plain");
  assert.ok(!("title" in row.sections[0]));
  const card = applyOp(row, { kind: "setSectionVariant", index: 0, variant: "card" });
  assert.ok(!("variant" in card.sections[0]));

  // Xoá cột ⇒ xoá cả con.
  assert.equal(totalBlocks(applyOp(inCol, { kind: "removeBlock", id: col.id })), totalBlocks(inCol) - 3);

  // Trần 20 khối đếm cả khối con: 19 khối + cột 1 con ⇒ không chèn thêm được.
  const nineteen: PageSchema = { version: 1, sections: [{ key: "a", blocks: Array.from({ length: 18 }, (_, i) => text(`t_${i}`)) }] };
  const near = applyOp(nineteen, { kind: "wrapInColumn", id: "t_0" });
  assert.equal(totalBlocks(near), 19);
  assert.ok(checkOp(near, { kind: "duplicateBlock", id: near.sections[0].blocks[0].id }), "nhân bản cột (2 khối) vượt trần 20");
  assert.equal(checkOp(near, { kind: "insertBlock", block: text("cuoi_1"), at: endOfSection(near, 0) }), null);
  const twenty = applyOp(near, { kind: "insertBlock", block: text("cuoi_1"), at: endOfSection(near, 0) });
  assert.match(checkOp(twenty, { kind: "insertBlock", block: text("cuoi_2"), at: endOfSection(twenty, 0) }) ?? "", new RegExp(String(PAGE_MAX_BLOCKS)));
}

function testHistory() {
  let h = initHistory(fixture());
  const first = h.present;
  for (let i = 0; i < 60; i++) h = commit(h, applyOp(h.present, { kind: "patchSection", index: 0, title: `T${i}` }));
  assert.equal(h.past.length, HISTORY_LIMIT, "ngăn hoàn tác tối đa 50 bước");
  let back = h;
  for (let i = 0; i < 100; i++) back = undo(back);
  assert.equal(back.past.length, 0);
  assert.equal(back.present.sections[0].title, "T9", "bước cũ nhất còn giữ là bước 50 trước hiện tại");
  assert.notEqual(back.present, first);
  const redone = redo(redo(back));
  assert.equal(redone.present.sections[0].title, "T11");

  // Gộp: gõ liền một ô (cùng khoá) = MỘT bước; đổi ô ⇒ bước mới; thao tác mới xoá nhánh làm lại.
  let g = initHistory(fixture());
  g = commit(g, applyOp(g.present, { kind: "patchSection", index: 0, title: "A" }), "title:s1");
  g = commit(g, applyOp(g.present, { kind: "patchSection", index: 0, title: "AB" }), "title:s1");
  g = commit(g, applyOp(g.present, { kind: "patchSection", index: 0, title: "ABC" }), "title:s1");
  assert.equal(g.past.length, 1);
  assert.equal(undo(g).present.sections[0].title, "Một");
  g = commit(g, applyOp(g.present, { kind: "setSpan", id: "kpi_1", span: 6 }));
  assert.equal(g.past.length, 2);
  const u = undo(g);
  assert.equal(u.future.length, 1);
  assert.equal(commit(u, applyOp(u.present, { kind: "removeBlock", id: "text_1" })).future.length, 0, "thao tác mới xoá nhánh làm lại");
  assert.equal(commit(g, g.present), g, "cùng tham chiếu (phép bị từ chối) ⇒ không thêm bước");
  assert.equal(undo(initHistory(fixture())).past.length, 0);
}

function testErrorsAndEarly() {
  const base = fixture();
  const wrapped = applyOp(base, { kind: "wrapInColumn", id: "kpi_1" });
  const colKey = wrapped.sections[0].blocks[0].id;
  const e = errorsByBlock(
    [
      { path: "sections.0.blocks.0.children.0.config.metric", message: "Nguồn lạ." },
      { path: "sections[0].blocks[1].config.body", message: "Chữ dài." },
      { path: "sections.0.blocks.0.children", message: "Cột trống." },
      { path: "sections.1.title", message: "Tiêu đề dài." },
      { path: "sections.9.blocks.0", message: "lạc" },
      { path: "sections", message: "Tối đa 20 khối." },
      { path: "_", message: "chung" },
    ],
    wrapped,
  );
  assert.deepEqual(e.block.kpi_1?.map((x) => x.message), ["Nguồn lạ."], "lỗi khối con về đúng khối con");
  assert.deepEqual(e.block.text_1?.map((x) => x.message), ["Chữ dài."], "cú pháp ngoặc vuông cũng khớp");
  assert.deepEqual(e.block[colKey]?.map((x) => x.message), ["Cột trống."]);
  assert.deepEqual(e.section.s2?.map((x) => x.message), ["Tiêu đề dài."]);
  assert.deepEqual(e.general.map((x) => x.message), ["lạc", "Tối đa 20 khối.", "chung"], "lỗi không gắn được chỗ nào lên đầu, không biến mất");
  // Lỗi đi theo KHOÁ: kéo khối đi chỗ khác sau khi gửi, lỗi vẫn ở khối đó.
  const moved = applyOp(wrapped, { kind: "moveBlock", id: "text_1", to: endOfSection(wrapped, 1) });
  assert.ok(findBlock(moved, "text_1") && e.block.text_1);

  // Kiểm sớm: dùng lại luật Phase 4 cho khối thường, đường dẫn đúng cả khi có cột đứng trước; cột trống bị báo.
  const bad: PageSchema = {
    version: 1,
    sections: [{ key: "a", blocks: [{ id: "cot_1", type: "column", span: 4, config: {}, children: [{ id: "k_1", type: "kpi", span: 12, config: { metric: "" } }] } as unknown as PageBlock, { id: "k_2", type: "kpi", span: 3, config: { metric: "" } }, { id: "cot_2", type: "column", span: 4, config: {}, children: [] } as unknown as PageBlock] }],
  };
  const early = builderEarlyCheck(bad).map((x) => x.path);
  assert.ok(early.includes("sections.0.blocks.1.config.metric"), `chỉ số khối dịch lại qua cột: ${early.join(" | ")}`);
  assert.ok(early.includes("sections.0.blocks.0.children.0.config.metric"), `khối con thiếu nguồn bị báo đúng ô: ${early.join(" | ")}`);
  assert.ok(early.includes("sections.0.blocks.2.children"), "cột trống bị báo");
  assert.deepEqual(builderEarlyCheck(fixture()), []);
  // Schema 1.1: KPI / biểu đồ TỔNG HỢP không bị đòi «nguồn số liệu» của sổ; thiếu field số thì báo đúng ô.
  const agg: PageSchema = {
    version: 1,
    sections: [
      {
        key: "a",
        blocks: [
          { id: "dem_don", type: "kpi", span: 3, config: { aggregate: { objectKey: "order", fn: "count" } } },
          { id: "tong_so", type: "kpi", span: 3, config: { aggregate: { objectKey: "customer", fn: "sum" } } },
          { id: "theo_tt", type: "chart", span: 6, config: { aggregate: { objectKey: "order", fn: "count" }, kind: "bar", groupBy: { ref: "system:stage" } } },
          { id: "loc_1", type: "filter", span: 12, config: { fields: [], targets: [] } },
          { id: "loc_2", type: "filter", span: 12, config: { period: true, fields: [], targets: [] } },
        ],
      },
    ],
  };
  assert.deepEqual(
    builderEarlyCheck(agg).map((e) => e.path),
    ["sections.0.blocks.1.config.aggregate.field", "sections.0.blocks.3.config.fields"],
    "đếm được ngay; tổng cần field số; bộ lọc cần ô lọc hoặc bộ chọn kỳ",
  );
  assert.equal(blockEarlyIssue(kpi("kpi_1")), null);
  assert.match(blockEarlyIssue({ id: "k_1", type: "kpi", span: 3, config: { metric: "" } }) ?? "", /nguồn/);
}

function testLibrary() {
  const s = fixture();
  const byKind = (k: string) => LIBRARY.find((x) => x.kind === k)!;
  // Schema 1.1: nhóm / hàng / cột / bộ lọc dùng được; mục thiếu nguồn MỜ kèm lý do, không giấu.
  for (const k of ["section", "row", "column", "text"]) assert.equal(libraryRefusal(byKind(k), s, EMPTY_CATALOG), null, `«${k}» dùng được`);
  assert.match(libraryRefusal(byKind("filter"), s, EMPTY_CATALOG) ?? "", /đối tượng/, "không đối tượng nào ⇒ bộ lọc mờ + lý do");
  assert.match(libraryRefusal(byKind("kpi"), s, EMPTY_CATALOG) ?? "", /nguồn chỉ số/, "sổ trống ⇒ mờ + lý do");
  const full: PageSchema = { version: 1, sections: [{ key: "a", blocks: Array.from({ length: PAGE_MAX_BLOCKS }, (_, i) => text(`t_${i}`)) }] };
  assert.match(libraryRefusal(byKind("text"), full, EMPTY_CATALOG) ?? "", /20/);
  assert.equal(new Set(LIBRARY.map((x) => x.label)).size, LIBRARY.length);

  // Khối mới: khoá không trùng kể cả với khối con.
  const withCol = applyOp(s, { kind: "wrapInColumn", id: "kpi_1" });
  assert.equal(newBuilderBlock("kpi", withCol, EMPTY_CATALOG, 3).id, "kpi_2");

}

/** Ô chọn của form thuộc tính theo VAI TRÒ field — cùng luật với kiểm schema của máy chủ. */
function testFieldRoles() {
  const obj = (key: string, extra: CatalogField[] = []): PageObjectOption => ({ key, label: key, catalog: [...buildCatalog(objectDef(key)!.fields, []), ...extra], forms: [] });
  const order = obj("order");
  assert.deepEqual(aggregatableFields(order).map((f) => f.ref), [], "tiền của đơn KHÔNG cộng thẳng — doanh thu chỉ qua sổ chỉ số");
  const customer = obj("customer");
  assert.deepEqual(aggregatableFields(customer).map((f) => f.ref), ["system:order_count"], "số khai aggregatable thì được; «Đã mua» (tiền) thì không");
  const customNumber: CatalogField = { ref: "custom:so_lan_goi", label: "Số lần gọi", type: "number", system: false, lockedRequired: false, lockedReadOnly: false, listable: true, filterable: true, options: [] };
  assert.ok(aggregatableFields(obj("order", [customNumber])).some((f) => f.ref === "custom:so_lan_goi"), "field số TUỲ BIẾN tổng hợp được mặc định");
  assert.ok(groupableFields(order).some((f) => f.ref === "system:stage"), "trạng thái đơn nhóm được");
  assert.ok(!groupableFields(order).some((f) => f.ref === "system:customer_name"), "chữ tự do không nhóm được");
  assert.deepEqual(dateFields(order).map((f) => f.ref), ["system:inserted_at"]);
  assert.deepEqual(filterBarOps(order.catalog.find((f) => f.ref === "system:stage")), ["eq", "neq", "in", "empty", "not_empty"]);
  assert.deepEqual(filterBarOps(undefined), []);

  // Hành động theo dòng: chỉ action nhận MỘT bản ghi, và đúng đối tượng nếu action khai đối tượng.
  const cat: PageEditorCatalog = { ...EMPTY_CATALOG, actions: PAGE_ACTIONS.map((a) => ({ ...a })) };
  assert.deepEqual(rowActionOptions(cat, "order").map((a) => a.key), ["open_record", "update_safe_field"]);
  assert.deepEqual(rowActionOptions(cat, "customer").map((a) => a.key), ["open_record", "update_safe_field", "request_approval"]);

  // Đích của bộ lọc: bảng · kanban · KPI / biểu đồ TỔNG HỢP (kể cả trong cột); KPI từ sổ và chính khối lọc thì không.
  const page: PageSchema = {
    version: 1,
    sections: [
      {
        key: "a",
        blocks: [
          { id: "loc_1", type: "filter", span: 12, config: { period: true, fields: [], targets: [] } },
          { id: "bang_don", type: "table", span: 12, title: "Đơn", config: { source: "order", columns: ["system:id"] } },
          { id: "kpi_so", type: "kpi", span: 3, config: { metric: "orders_today" } },
          { id: "cot_1", type: "column", span: 4, config: {}, children: [{ id: "dem_khach", type: "kpi", span: 12, config: { aggregate: { objectKey: "customer", fn: "count" } } }] },
        ],
      },
    ],
  };
  assert.deepEqual(filterTargetsOf(page), [
    { id: "bang_don", label: "Đơn", objectKey: "order" },
    { id: "dem_khach", label: "Chỉ số (KPI)", objectKey: "customer" },
  ]);
}

function testPurity() {
  // Không phép nào sửa đầu vào (đầu vào bị đóng băng sâu); chạy hai lần ra cùng kết quả.
  const base = deepFreeze(applyOp(fixture(), { kind: "wrapInColumn", id: "kpi_1" }));
  const col = base.sections[0].blocks[0].id;
  const ops: BuilderOp[] = [
    { kind: "insertBlock", block: text("moi_1"), at: { section: 0, column: col, index: 0 } },
    { kind: "moveBlock", id: "text_1", to: { section: 0, column: col, index: 1 } },
    { kind: "moveBlock", id: "kpi_1", to: endOfSection(base, 1) },
    { kind: "moveSection", from: 1, to: 0 },
    { kind: "setSpan", id: col, span: 8 },
    { kind: "duplicateBlock", id: col },
    { kind: "removeBlock", id: "text_2" },
    { kind: "insertSection", variant: "plain", at: 0 },
    { kind: "removeSection", index: 1 },
    { kind: "patchSection", index: 0, title: "X" },
    { kind: "wrapInColumn", id: "text_2" },
    { kind: "patchBlock", id: "text_1", patch: { title: "T", config: { heading: "H" } } },
  ];
  for (const op of ops) {
    const a = applyOp(base, op);
    const b = applyOp(base, op);
    assert.deepEqual(a, b, `${op.kind} phải tất định`);
    assert.notEqual(a, base, `${op.kind} phải đổi schema`);
  }
}

// ═══════════ LÕI MÁY CHỦ ═══════════

async function testCoreGates() {
  const manager = sessionUser({ role: "MANAGER", permissions: ["customers:view", "workflow:manage"] });
  for (const r of [await loadPageBuilder(manager, "p1"), await adminSaveBuilderDraft(manager, "p1", fixture(), null), await adminPublishFromBuilder(manager, "p1"), await adminAddPageToMenu(manager, "p1")]) {
    assert.ok(!r.ok && /quyền/.test(r.errors[0]?.message ?? ""), "thiếu metadata:manage ⇒ từ chối ở lõi, trước dịch vụ");
  }
  const noOrg = sessionUser({ organization: undefined });
  const r = await adminSaveBuilderDraft(noOrg, "p1", fixture(), null);
  assert.ok(!r.ok && /tổ chức/.test(r.errors[0].message), "phiên không mang tổ chức ⇒ từ chối");
  const admin = sessionUser({});
  const shape = await adminSaveBuilderDraft(admin, "p1", { sections: "x" }, 0);
  assert.ok(!shape.ok && !shape.conflict && shape.errors[0].path === "sections");
  assert.ok(!(await adminSaveBuilderDraft(admin, " ", fixture(), 0)).ok, "thiếu mã trang");
  const noBase = await adminSaveBuilderDraft(admin, "p1", fixture(), null);
  assert.ok(!noBase.ok && !noBase.conflict && noBase.errors[0].path === "baseRevision", "trình kéo-thả không gửi revision ⇒ từ chối, không lặng lẽ lưu đè");
  const deniedLoad = await adminLoadBuilderDraft(sessionUser({ role: "MANAGER", permissions: [] }), "p1");
  assert.ok(!deniedLoad.ok && /quyền/.test(deniedLoad.errors[0].message));
}

const ORG = "pb-p5";

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(dbSchema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(dbSchema.platformOrganizationModules).where(eq(dbSchema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(dbSchema.platformOrganizations).where(eq(dbSchema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function testLifecycleDb() {
  await cleanupOrg(ORG);
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await provisionOrganization({ code: ORG, name: "Tổ chức thử trình kéo-thả", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT Kéo Thả", password: "Page@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const row = await db.query.users.findFirst({ where: eq(dbSchema.users.email, `admin@${ORG}.local`) });
      assert.ok(row);
      const modules = [...(await getEnabledModules(ORG))];
      const admin = sessionUser({ id: row.id, email: row.email, organization: { code: ORG, name: "Kéo thả", isHome: false }, modules });

      const created = await adminCreatePage(admin, normalizePageMeta({ ...blankPageMeta(), name: "Bảng điều khiển đơn", slug: "bang-don", moduleKey: "orders" }));
      assert.ok(created.ok, JSON.stringify(created));
      const id = created.id;
      const opened = await loadPageBuilder(admin, id);
      assert.ok(opened.ok && opened.value.page, JSON.stringify(opened));
      assert.equal(opened.value.draftRevision, 0, "trang mới: bản nháp ở revision 0");
      assert.equal(opened.value.draft.sections.length, 1, "nháp rỗng mở với một nhóm trống");
      const missing = await loadPageBuilder(admin, "khong-co-trang");
      assert.ok(!missing.ok, "trang lạ (hoặc của tổ chức khác) ⇒ không mở được");
      const catalog = opened.value.catalog;

      // Dựng trang như trên khung: kéo KPI, Bảng, Biểu đồ vào nhóm đầu — CHỈ bằng phép thuần, rồi tự lưu.
      let s = opened.value.draft;
      const add = (type: "kpi" | "table" | "chart", span: 3 | 6 | 12) => {
        s = applyOp(s, { kind: "insertBlock", block: newBuilderBlock(type, s, catalog, span), at: endOfSection(s, 0) });
      };
      add("kpi", 3);
      add("table", 12);
      add("chart", 6);
      const tableId = s.sections[0].blocks[1].id;
      s = applyOp(s, { kind: "patchBlock", id: tableId, patch: { config: { source: "order", columns: catalog.objects.find((o) => o.key === "order")!.catalog.filter((c) => c.listable).slice(0, 3).map((c) => c.ref), pageSize: 10, rowLink: true } } });
      assert.deepEqual(builderEarlyCheck(s), [], JSON.stringify(builderEarlyCheck(s)));
      const saved = await adminSaveBuilderDraft(admin, id, s, opened.value.draftRevision);
      assert.ok(saved.ok, JSON.stringify(saved));
      let rev = saved.revision;
      assert.equal(rev, 1, "lưu thành công ⇒ revision + 1");

      // Máy chủ từ chối ⇒ lỗi theo path của schema ĐÃ GỬI, đổi được sang khoá khối; nháp cũ KHÔNG bị ghi đè.
      const kpiId = s.sections[0].blocks[0].id;
      const broken = applyOp(s, { kind: "patchBlock", id: kpiId, patch: { config: { metric: "khong_co_nguon" } } });
      const rejected = await adminSaveBuilderDraft(admin, id, broken, rev);
      assert.ok(!rejected.ok && !rejected.conflict, "nguồn lạ ⇒ không lưu, không phải CONFLICT");
      assert.ok(errorsByBlock(rejected.errors, broken).block[kpiId]?.length, `lỗi về đúng khối ${kpiId}: ${JSON.stringify(rejected.errors)}`);
      const after = await loadPageEditor(admin, id);
      assert.ok(after.ok);
      assert.equal(after.value.draft.sections[0].blocks.length, 3);
      assert.notEqual((after.value.draft.sections[0].blocks[0].config as { metric: string }).metric, "khong_co_nguon", "lượt bị từ chối không ghi nháp");

      // Kéo biểu đồ lên đầu ⇒ lưu ⇒ xuất bản ⇒ phiên bản 1; thêm vào menu ⇒ trang có trên menu.
      const chartId = s.sections[0].blocks[2].id;
      s = applyOp(s, { kind: "moveBlock", id: chartId, to: { section: 0, column: null, index: 0 } });
      const moved = await adminSaveBuilderDraft(admin, id, s, rev);
      assert.ok(moved.ok, JSON.stringify(moved));
      rev = moved.revision;

      // Bộ lọc (trạng thái đơn) nhắm vào bảng + cột bọc KPI — lưu qua ĐÚNG kiểm của máy chủ (đích có thật, cùng đối tượng).
      s = applyOp(s, { kind: "insertBlock", block: { id: "loc_don", type: "filter", span: 12, config: { period: true, fields: [{ objectKey: "order", ref: "system:stage", op: "eq" }], targets: [tableId] } }, at: { section: 0, column: null, index: 0 } });
      s = applyOp(s, { kind: "wrapInColumn", id: kpiId });
      const withFilter = await adminSaveBuilderDraft(admin, id, s, rev);
      assert.ok(withFilter.ok, JSON.stringify(withFilter));
      rev = withFilter.revision;
      const badTarget = applyOp(s, { kind: "patchBlock", id: "loc_don", patch: { config: { fields: [{ objectKey: "order", ref: "system:stage", op: "eq" }], targets: [chartId] } } });
      const noTarget = await adminSaveBuilderDraft(admin, id, badTarget, rev);
      assert.ok(!noTarget.ok && !noTarget.conflict && errorsByBlock(noTarget.errors, badTarget).block.loc_don?.length, `đích không nhận bộ lọc ⇒ lỗi ở khối bộ lọc: ${JSON.stringify(noTarget)}`);

      // ── HAI NGƯỜI CÙNG SOẠN: cả hai đứng trên `rev`; A lưu trước ⇒ B nhận CONFLICT (không ghi), kèm revision hiện tại ──
      const mine = applyOp(s, { kind: "patchSection", index: 0, title: "Bản của A" });
      const theirs = applyOp(s, { kind: "patchSection", index: 0, title: "Bản của B" });
      const a = await adminSaveBuilderDraft(admin, id, mine, rev);
      assert.ok(a.ok, JSON.stringify(a));
      const b = await adminSaveBuilderDraft(admin, id, theirs, rev);
      assert.ok(!b.ok && b.conflict, "người lưu sau đứng trên revision cũ ⇒ CONFLICT");
      assert.equal(!b.ok ? b.currentRevision : null, a.ok ? a.revision : -1, "CONFLICT trả revision HIỆN TẠI để ghi đè có chủ ý");
      const theirsNow = await adminLoadBuilderDraft(admin, id);
      assert.ok(theirsNow.ok && theirsNow.draft.sections[0].title === "Bản của A", "«tải bản của họ» ⇒ đúng bản A đã lưu, B không ghi gì");
      const forced = await adminSaveBuilderDraft(admin, id, theirs, !b.ok ? (b.currentRevision ?? -1) : -1);
      assert.ok(forced.ok, "«ghi đè (xác nhận)» ⇒ lưu trên revision hiện tại");
      rev = forced.ok ? forced.revision : rev;
      s = theirs;
      const pub = await adminPublishFromBuilder(admin, id);
      assert.ok(pub.ok && pub.version === 1, JSON.stringify(pub));
      assert.ok(pub.ok && pub.publishedAt.length > 0);
      assert.equal((await listNavPages()).some((p) => p.id === id), false, "chưa bật menu ⇒ không trên menu");
      const menu = await adminAddPageToMenu(admin, id);
      assert.ok(menu.ok && menu.nav.enabled && menu.nav.label === "Bảng điều khiển đơn", JSON.stringify(menu));
      assert.equal((await listNavPages()).some((p) => p.id === id), true, "thêm vào menu ⇒ trang có trên menu");
      const reopened = await loadPageBuilder(admin, id);
      assert.ok(reopened.ok);
      assert.equal(reopened.value.draftRevision, rev);
      const col = reopened.value.draft.sections[0].blocks[2];
      assert.deepEqual(reopened.value.draft.sections[0].blocks.map((x) => x.id), ["loc_don", chartId, col.id, tableId], "tải lại thấy bố cục mới");
      assert.deepEqual(childrenOf(col).map((x) => x.id), [kpiId], "KPI nằm trong cột sau khi tải lại");
      assert.equal(reopened.value.draft.sections[0].title, "Bản của B");
      assert.equal(reopened.value.page?.publishedVersion, 1);

      // Người cùng tổ chức thiếu quyền: lõi từ chối trước dịch vụ.
      const viewer = sessionUser({ ...admin, role: "VIEWER", permissions: ["orders:read"] });
      assert.ok(!(await adminSaveBuilderDraft(viewer, id, s, rev)).ok);
      assert.ok(!(await adminPublishFromBuilder(viewer, id)).ok);
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

export async function testPageBuilder() {
  testInsertMove();
  testSpanDuplicateRemoveSections();
  testColumns();
  testHistory();
  testErrorsAndEarly();
  testLibrary();
  testFieldRoles();
  testPurity();
  await testCoreGates();
  await testLifecycleDb();
  console.log(
    "✓ Nền tảng · trình dựng trang kéo-thả (Phase 5): chèn / dời trong nhóm · sang nhóm · vào và ra cột / đổi chỗ nhóm / bắt độ rộng 3·4·6·8·12 / nhân bản (khoá mới cả khối con, cấu hình là bản sao) / xoá / nhóm + hàng / bọc vào cột — từ chối ⇒ nguyên schema, không sửa đầu vào, tất định; một tầng lồng, cột ≤ 6, trần 20 đếm cả khối con; hoàn tác ≤ 50 bước + gộp gõ liền; lỗi máy chủ theo path ⇒ khoá khối; thư viện mờ kèm lý do; lõi từ chối người thiếu quyền; vòng đời thật (pb-p5): tự lưu có baseRevision, lỗi đúng khối không ghi, bộ lọc trạng thái đơn nhắm bảng + cột qua kiểm máy chủ (đích sai ⇒ lỗi ở khối lọc), hai người cùng soạn ⇒ người sau CONFLICT kèm revision hiện tại, tải bản của họ / ghi đè, xuất bản phiên bản 1, thêm vào menu, tải lại thấy bố cục mới",
  );
}
