/**
 * ═══════════ TRÌNH DỰNG TRANG KÉO-THẢ — PHÉP BIẾN ĐỔI SCHEMA THUẦN (Phase 5 · hợp đồng §4) ═══════════
 *
 * Trình kéo-thả KHÔNG phải runtime thứ hai (X1): nó chỉ là một cách khác để SINH ra cùng một `PageSchema` mà
 * trình soạn Phase 4, `validatePageSchema` và renderer đang dùng. Mọi thao tác trên khung — chèn từ thư viện, kéo
 * đổi chỗ, sang nhóm / cột khác, đổi độ rộng, nhân bản, xoá — là MỘT hàm thuần `(schema, op) → schema` ở đây.
 * Không đọc CSDL, không import gì chỉ-máy-chủ, không `Date.now()` / `Math.random()`: chạy hai lần ra cùng kết quả,
 * nên bài kiểm chạy được ngoài trình duyệt và hoàn tác / làm lại chỉ là một ngăn xếp các schema.
 *
 * ─── BA ĐIỀU CỐ Ý ───
 *
 *  1. ĐỊA CHỈ LÀ KHOÁ KHỐI, không phải chỉ số. Khoá khối là duy nhất trong trang (kể cả khối con trong cột) —
 *     `validatePageSchema` đã bắt điều đó. Chọn / kéo / lỗi máy chủ đều bám theo khoá, nên một khối vừa bị kéo đi
 *     chỗ khác vẫn giữ nguyên vùng chọn và lỗi của nó. Chỉ số chỉ dùng cho ĐIỂM THẢ (`DropSlot`).
 *  2. TỪ CHỐI THÌ TRẢ NGUYÊN SCHEMA (cùng tham chiếu) — không cắt bớt, không sửa hộ. `checkOp` nói VÌ SAO bằng
 *     tiếng Việt để giao diện hiện lên; `applyOp` gọi đúng `checkOp` đó trước khi làm, nên hai bên không lệch luật.
 *     Trần 20 khối đếm CẢ khối con trong cột (hợp đồng §1) — một cột 6 khối là 7 câu truy vấn, không phải 1.
 *  3. CỘT / HÀNG / BỘ LỌC theo schema 1.1 (`lib/pages/types.ts`): khối `column` mang `children` (một tầng, ≤ 6,
 *     khối con vẫn giữ `span` HỢP LỆ — ghi 12 — dù renderer bỏ qua); section `variant: "plain"` là hàng. Duyệt khối
 *     dùng `flattenBlocks` của runtime, không tự viết phép duyệt thứ hai.
 */
import { BLOCK_ID_PATTERN } from "@/lib/pages/components";
import {
  BLOCK_SPANS,
  COLUMN_MAX_CHILDREN,
  flattenBlocks,
  PAGE_MAX_BLOCKS,
  PAGE_MAX_SECTIONS,
  type BlockConfigByType,
  type BlockSpan,
  type BlockType,
  type PageBlock,
  type PageSchema,
  type PageSection,
  type SectionVariant,
} from "@/lib/pages/types";
import { BLOCK_TYPE_LABEL, checkPageDraft, defaultConfig, formObjects, kanbanObjects, newSectionKey, type PageEditorCatalog, type PagePathError } from "@/lib/platform-ui/page-admin-shared";

// ═══════════ HÌNH DẠNG (tương thích schema 1.0 và 1.1) ═══════════

export const COLUMN_TYPE = "column";
export const FILTER_TYPE = "filter";
export { COLUMN_MAX_CHILDREN };
export type { SectionVariant };

export function isColumn(b: PageBlock): boolean {
  return b.type === COLUMN_TYPE;
}
export function isFilter(b: PageBlock): boolean {
  return b.type === FILTER_TYPE;
}
export function childrenOf(b: PageBlock): PageBlock[] {
  return Array.isArray(b.children) ? b.children : [];
}
export function sectionVariant(s: PageSection): SectionVariant {
  return s.variant === "plain" ? "plain" : "card";
}
function withChildren(b: PageBlock, children: PageBlock[]): PageBlock {
  return { ...b, children };
}

/** Tổng số khối — ĐẾM CẢ khối con trong cột (trần 20 là trần câu truy vấn, không phải trần ô trên lưới). */
export function totalBlocks(schema: PageSchema): number {
  return flattenBlocks(schema).length;
}

export function allBlockIds(schema: PageSchema): Set<string> {
  return new Set(flattenBlocks(schema).map((f) => f.block.id));
}

/** Vị trí của một khối: nhóm, chỉ số trong nhóm, và chỉ số trong cột (`null` = khối nằm thẳng trong nhóm). */
export type BlockPath = { section: number; index: number; child: number | null };

export function locate(schema: PageSchema, id: string): BlockPath | null {
  for (let si = 0; si < schema.sections.length; si++) {
    const blocks = schema.sections[si].blocks;
    for (let bi = 0; bi < blocks.length; bi++) {
      if (blocks[bi].id === id) return { section: si, index: bi, child: null };
      const kids = childrenOf(blocks[bi]);
      for (let ci = 0; ci < kids.length; ci++) if (kids[ci].id === id) return { section: si, index: bi, child: ci };
    }
  }
  return null;
}

export function blockAt(schema: PageSchema, p: BlockPath): PageBlock | null {
  const top = schema.sections[p.section]?.blocks[p.index];
  if (!top) return null;
  return p.child === null ? top : (childrenOf(top)[p.child] ?? null);
}

export function findBlock(schema: PageSchema, id: string): PageBlock | null {
  const p = locate(schema, id);
  return p ? blockAt(schema, p) : null;
}

/** Khối cột đang chứa khối `id` (`null` nếu khối nằm thẳng trong nhóm). */
export function parentColumnOf(schema: PageSchema, id: string): PageBlock | null {
  const p = locate(schema, id);
  return p && p.child !== null ? (schema.sections[p.section].blocks[p.index] ?? null) : null;
}

/**
 * ĐIỂM THẢ: vào nhóm `section`, hoặc vào cột có khoá `column` (nằm trong nhóm đó), ở vị trí `index` — tính trên
 * danh sách ĐANG HIỆN (còn chứa khối đang kéo). `moveBlock` tự trừ đi chỗ của khối rời đi.
 */
export type DropSlot = { section: number; column: string | null; index: number };

// ═══════════ KHOÁ KHỐI MỚI ═══════════

/** Khoá mới không trùng khối nào (kể cả khối con), khớp `BLOCK_ID_PATTERN`: `<gốc>_<n>` với n nhỏ nhất còn trống. */
export function freshBlockId(used: ReadonlySet<string>, base: string): string {
  let root = base.toLowerCase().replace(/_\d+$/, "").replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z]/.test(root)) root = `k_${root}`;
  root = root.slice(0, 34).replace(/_+$/, "") || "khoi";
  if (root.length < 2) root = `${root}k`;
  for (let i = 1; ; i++) {
    const id = `${root}_${i}`;
    if (!used.has(id)) return id;
  }
}

/** Khối mới của thư viện: khoá không trùng (đếm cả khối con), cấu hình khởi đầu từ sổ, độ rộng mặc định của loại. */
export function newBuilderBlock(type: BlockType, schema: PageSchema, catalog: PageEditorCatalog, defaultSpan: BlockSpan): PageBlock {
  const untitled = type === "kpi" || type === "text" || type === "filter" || type === "column";
  return {
    id: freshBlockId(allBlockIds(schema), type),
    type,
    span: defaultSpan,
    ...(untitled ? {} : { title: BLOCK_TYPE_LABEL[type] }),
    config: defaultConfig(type, catalog),
    ...(type === "column" ? { children: [] } : {}),
  };
}

// ═══════════ ĐỘ RỘNG ═══════════

/** Bắt một độ rộng bất kỳ (tay nắm kéo ra số lẻ) về 3 / 4 / 6 / 8 / 12 gần nhất; hoà thì lấy bên RỘNG hơn. */
export function snapSpan(n: number): BlockSpan {
  if (!Number.isFinite(n)) return 12;
  let best: BlockSpan = BLOCK_SPANS[0];
  for (const s of BLOCK_SPANS) if (Math.abs(s - n) <= Math.abs(best - n)) best = s;
  return best;
}

/** Độ rộng khi kéo tay nắm: độ rộng lúc bắt đầu + quãng kéo quy ra số cột (lưới 12), rồi bắt về bậc gần nhất. */
export function spanFromDrag(startSpan: number, deltaPx: number, gridWidthPx: number): BlockSpan {
  if (!(gridWidthPx > 0)) return snapSpan(startSpan);
  return snapSpan(startSpan + (deltaPx / gridWidthPx) * 12);
}

// ═══════════ PHÉP BIẾN ĐỔI ═══════════

export type BlockPatch = { id?: string; title?: string | undefined; config?: BlockConfigByType[BlockType]; visibility?: PageBlock["visibility"] };

export type BuilderOp =
  | { kind: "insertBlock"; block: PageBlock; at: DropSlot }
  | { kind: "moveBlock"; id: string; to: DropSlot }
  | { kind: "moveSection"; from: number; to: number }
  | { kind: "setSpan"; id: string; span: number }
  | { kind: "duplicateBlock"; id: string }
  | { kind: "removeBlock"; id: string }
  | { kind: "insertSection"; variant: SectionVariant; at: number; title?: string }
  | { kind: "removeSection"; index: number }
  | { kind: "patchSection"; index: number; title: string | undefined }
  | { kind: "setSectionVariant"; index: number; variant: SectionVariant }
  | { kind: "wrapInColumn"; id: string }
  | { kind: "patchBlock"; id: string; patch: BlockPatch };

const MAX_MSG = `Tối đa ${PAGE_MAX_BLOCKS} khối mỗi trang (đếm cả khối trong cột) — một trang không được thành hàng chục câu truy vấn.`;

/** Khối `b` có được nằm trong một cột không. Cột trong cột: không (chỉ MỘT tầng lồng); bộ lọc: không. */
function columnRefusal(b: PageBlock): string | null {
  if (isColumn(b)) return "Không đặt cột trong cột — chỉ một tầng lồng.";
  if (isFilter(b)) return "Bộ lọc đứng thẳng trong nhóm, không đặt trong cột.";
  return null;
}

/** Vì sao ĐIỂM THẢ không nhận khối `b` (`null` = nhận). `movingId` = khối đang được dời (không tính chỗ nó chiếm). */
function slotRefusal(schema: PageSchema, at: DropSlot, b: PageBlock, movingId: string | null): string | null {
  const section = schema.sections[at.section];
  if (!section) return "Nhóm đích không còn trên trang.";
  if (at.column === null) return at.index < 0 || at.index > section.blocks.length ? "Vị trí thả nằm ngoài nhóm." : null;
  const col = section.blocks.find((x) => x.id === at.column);
  if (!col || !isColumn(col)) return "Cột đích không còn trên trang.";
  if (movingId !== null && movingId === col.id) return "Không kéo một cột vào chính nó.";
  const why = columnRefusal(b);
  if (why) return why;
  const kids = childrenOf(col);
  if (at.index < 0 || at.index > kids.length) return "Vị trí thả nằm ngoài cột.";
  const already = movingId !== null && kids.some((k) => k.id === movingId);
  if (!already && kids.length >= COLUMN_MAX_CHILDREN) return `Một cột chứa tối đa ${COLUMN_MAX_CHILDREN} khối.`;
  return null;
}

/**
 * Vì sao phép này KHÔNG làm được (`null` = làm được). Câu trả lời là tiếng Việt để hiện thẳng lên màn hình.
 * Đây là kiểm CẤU TRÚC (trần, lồng, khoá); kiểm CẤU HÌNH vẫn là `validatePageSchema` ở máy chủ.
 */
export function checkOp(schema: PageSchema, op: BuilderOp): string | null {
  switch (op.kind) {
    case "insertBlock": {
      if (totalBlocks(schema) + 1 + childrenOf(op.block).length > PAGE_MAX_BLOCKS) return MAX_MSG;
      if (allBlockIds(schema).has(op.block.id)) return `Khoá khối «${op.block.id}» đã có trên trang.`;
      if (childrenOf(op.block).some((c) => columnRefusal(c))) return "Cột chỉ chứa khối thường — không cột, không bộ lọc.";
      return slotRefusal(schema, op.at, op.block, null);
    }
    case "moveBlock": {
      const b = findBlock(schema, op.id);
      if (!b) return "Khối không còn trên trang.";
      return slotRefusal(schema, op.to, b, op.id);
    }
    case "moveSection": {
      const n = schema.sections.length;
      if (op.from < 0 || op.from >= n || op.to < 0 || op.to >= n) return "Vị trí nhóm không hợp lệ.";
      return null;
    }
    case "setSpan": {
      const p = locate(schema, op.id);
      if (!p) return "Khối không còn trên trang.";
      if (p.child !== null) return "Khối trong cột luôn rộng hết cột — đổi độ rộng của CỘT.";
      return null;
    }
    case "duplicateBlock": {
      const b = findBlock(schema, op.id);
      if (!b) return "Khối không còn trên trang.";
      if (totalBlocks(schema) + 1 + childrenOf(b).length > PAGE_MAX_BLOCKS) return MAX_MSG;
      const parent = parentColumnOf(schema, op.id);
      if (parent && childrenOf(parent).length >= COLUMN_MAX_CHILDREN) return `Một cột chứa tối đa ${COLUMN_MAX_CHILDREN} khối.`;
      return null;
    }
    case "removeBlock":
      return locate(schema, op.id) ? null : "Khối không còn trên trang.";
    case "insertSection":
      if (schema.sections.length >= PAGE_MAX_SECTIONS) return `Tối đa ${PAGE_MAX_SECTIONS} nhóm mỗi trang.`;
      return op.at < 0 || op.at > schema.sections.length ? "Vị trí nhóm không hợp lệ." : null;
    case "removeSection":
      if (!schema.sections[op.index]) return "Nhóm không còn trên trang.";
      return schema.sections.length <= 1 ? "Trang cần ít nhất một nhóm." : null;
    case "patchSection":
    case "setSectionVariant":
      return schema.sections[op.index] ? null : "Nhóm không còn trên trang.";
    case "wrapInColumn": {
      const p = locate(schema, op.id);
      if (!p) return "Khối không còn trên trang.";
      if (p.child !== null) return "Khối đã nằm trong một cột.";
      const b = blockAt(schema, p)!;
      const why = columnRefusal(b);
      if (why) return why;
      return totalBlocks(schema) + 1 > PAGE_MAX_BLOCKS ? MAX_MSG : null;
    }
    case "patchBlock": {
      if (!locate(schema, op.id)) return "Khối không còn trên trang.";
      const next = op.patch.id;
      // Khoá trùng làm hai khối cùng một địa chỉ: chọn, kéo và nút hành động đều không còn biết là khối nào.
      if (next !== undefined && next !== op.id && allBlockIds(schema).has(next)) return `Khoá khối «${next}» đã có trên trang.`;
      return null;
    }
  }
}

/** Áp một phép. Bị từ chối (`checkOp` ≠ null) ⇒ trả NGUYÊN schema, cùng tham chiếu — không làm một nửa. */
export function applyOp(schema: PageSchema, op: BuilderOp): PageSchema {
  if (checkOp(schema, op) !== null) return schema;
  switch (op.kind) {
    case "insertBlock":
      return insertAt(schema, op.at, op.at.column === null ? op.block : { ...op.block, span: 12 as BlockSpan });
    case "moveBlock":
      return moveBlock(schema, op.id, op.to);
    case "moveSection": {
      if (op.from === op.to) return schema;
      const sections = [...schema.sections];
      const [s] = sections.splice(op.from, 1);
      sections.splice(op.to, 0, s);
      return { ...schema, sections };
    }
    case "setSpan": {
      const span = snapSpan(op.span);
      return mapBlock(schema, op.id, (b) => (b.span === span ? b : { ...b, span }));
    }
    case "duplicateBlock":
      return duplicateBlock(schema, op.id);
    case "removeBlock":
      return removeBlock(schema, op.id).schema;
    case "insertSection": {
      const s: PageSection = { key: newSectionKey(schema), ...(op.variant === "plain" ? { variant: "plain" as const } : { title: op.title ?? "Nhóm mới" }), blocks: [] };
      const sections = [...schema.sections];
      sections.splice(op.at, 0, s);
      return { ...schema, sections };
    }
    case "removeSection":
      return { ...schema, sections: schema.sections.filter((_, i) => i !== op.index) };
    case "patchSection":
      return { ...schema, sections: schema.sections.map((s, i) => (i === op.index ? { ...s, title: op.title || undefined } : s)) };
    case "setSectionVariant":
      return {
        ...schema,
        sections: schema.sections.map((s, i) => {
          if (i !== op.index) return s;
          const { variant: _drop, ...rest } = s;
          void _drop;
          // Hàng không có tiêu đề (renderer không vẽ) — bỏ tiêu đề cũ thay vì giữ một chữ không ai thấy (hoàn tác được).
          if (op.variant === "plain") {
            const { title: _t, ...noTitle } = rest;
            void _t;
            return { ...noTitle, variant: "plain" as const };
          }
          return rest;
        }),
      };
    case "wrapInColumn": {
      const used = allBlockIds(schema);
      return mapBlock(schema, op.id, (b) => {
        const column: PageBlock<"column"> = { id: freshBlockId(used, COLUMN_TYPE), type: "column", span: b.span, config: {}, children: [{ ...b, span: 12 }] };
        return column;
      });
    }
    case "patchBlock":
      return mapBlock(schema, op.id, (b) => {
        const next = { ...b } as PageBlock;
        if (op.patch.id !== undefined) next.id = op.patch.id;
        if ("title" in op.patch) {
          if (op.patch.title) next.title = op.patch.title;
          else delete next.title;
        }
        if (op.patch.config !== undefined) next.config = op.patch.config;
        if ("visibility" in op.patch) {
          const v = op.patch.visibility;
          if (v && (v.permission || v.module)) next.visibility = { ...(v.permission ? { permission: v.permission } : {}), ...(v.module ? { module: v.module } : {}) };
          else delete next.visibility;
        }
        return next;
      });
  }
}

/** Thay một khối (ở bất kỳ tầng nào) bằng `fn(khối)`; không có khối ⇒ trả nguyên schema. */
function mapBlock(schema: PageSchema, id: string, fn: (b: PageBlock) => PageBlock): PageSchema {
  const p = locate(schema, id);
  if (!p) return schema;
  return {
    ...schema,
    sections: schema.sections.map((s, si) =>
      si !== p.section
        ? s
        : {
            ...s,
            blocks: s.blocks.map((b, bi) => {
              if (bi !== p.index) return b;
              if (p.child === null) return fn(b);
              return withChildren(b, childrenOf(b).map((c, ci) => (ci === p.child ? fn(c) : c)));
            }),
          },
    ),
  };
}

function insertAt(schema: PageSchema, at: DropSlot, block: PageBlock): PageSchema {
  return {
    ...schema,
    sections: schema.sections.map((s, si) => {
      if (si !== at.section) return s;
      if (at.column === null) {
        const blocks = [...s.blocks];
        blocks.splice(at.index, 0, block);
        return { ...s, blocks };
      }
      return {
        ...s,
        blocks: s.blocks.map((b) => {
          if (b.id !== at.column) return b;
          const kids = [...childrenOf(b)];
          kids.splice(at.index, 0, block);
          return withChildren(b, kids);
        }),
      };
    }),
  };
}

/** Gỡ một khối (cột thì gỡ cả con). Trả thêm khối vừa gỡ. */
function removeBlock(schema: PageSchema, id: string): { schema: PageSchema; removed: PageBlock | null } {
  const p = locate(schema, id);
  if (!p) return { schema, removed: null };
  const removed = blockAt(schema, p);
  return {
    removed,
    schema: {
      ...schema,
      sections: schema.sections.map((s, si) => {
        if (si !== p.section) return s;
        if (p.child === null) return { ...s, blocks: s.blocks.filter((_, bi) => bi !== p.index) };
        return { ...s, blocks: s.blocks.map((b, bi) => (bi === p.index ? withChildren(b, childrenOf(b).filter((_, ci) => ci !== p.child)) : b)) };
      }),
    },
  };
}

function moveBlock(schema: PageSchema, id: string, to: DropSlot): PageSchema {
  const from = locate(schema, id);
  if (!from) return schema;
  // Chỉ số thả được tính trên danh sách còn chứa khối đang kéo: cùng danh sách và khối đứng TRƯỚC điểm thả ⇒ lùi 1.
  const sameList = from.section === to.section && (to.column === null ? from.child === null : from.child !== null && schema.sections[from.section].blocks[from.index]?.id === to.column);
  const ownIndex = from.child === null ? from.index : from.child;
  let index = to.index;
  if (sameList && ownIndex < index) index -= 1;
  if (sameList && index === ownIndex) return schema;
  const { schema: without, removed } = removeBlock(schema, id);
  if (!removed) return schema;
  // Vào cột ⇒ rộng hết cột (span bị bỏ qua, ghi 12 cho sạch); ra khỏi cột ⇒ lấy lại độ rộng mặc định cả hàng.
  const block = to.column !== null ? { ...removed, span: 12 as BlockSpan } : removed;
  return insertAt(without, { ...to, index }, block);
}

function duplicateBlock(schema: PageSchema, id: string): PageSchema {
  const p = locate(schema, id);
  const b = p ? blockAt(schema, p) : null;
  if (!p || !b) return schema;
  const used = allBlockIds(schema);
  const copyOne = (x: PageBlock): PageBlock => {
    const nid = freshBlockId(used, x.id);
    used.add(nid);
    return { ...structuredCloneSafe(x), id: nid };
  };
  let copy = copyOne(b);
  if (isColumn(b)) copy = withChildren(copy, childrenOf(b).map(copyOne));
  const column = p.child === null ? null : schema.sections[p.section].blocks[p.index].id;
  return insertAt(schema, { section: p.section, column, index: (p.child ?? p.index) + 1 }, copy);
}

/** Bản sao sâu của dữ liệu JSON thuần (cấu hình khối) — bản nhân bản không được dùng chung mảng với bản gốc. */
function structuredCloneSafe<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

// ═══════════ ĐIỂM THẢ CHO BÀN PHÍM (nút lên / xuống / chuyển nhóm / ra khỏi cột) ═══════════

/** Lên (`-1`) / xuống (`+1`) một bậc trong danh sách đang chứa khối. Đầu / cuối danh sách ⇒ `null`. */
export function stepSlot(schema: PageSchema, id: string, delta: -1 | 1): DropSlot | null {
  const p = locate(schema, id);
  if (!p) return null;
  const column = p.child === null ? null : schema.sections[p.section].blocks[p.index].id;
  const own = p.child ?? p.index;
  const len = p.child === null ? schema.sections[p.section].blocks.length : childrenOf(schema.sections[p.section].blocks[p.index]).length;
  const target = own + delta;
  if (target < 0 || target >= len) return null;
  // Chỉ số tính trên danh sách còn chứa khối: xuống một bậc là thả SAU khối kế tiếp (own + 2).
  return { section: p.section, column, index: delta === 1 ? own + 2 : own - 1 };
}

/** Nối cuối nhóm `section`. */
export function endOfSection(schema: PageSchema, section: number): DropSlot {
  return { section, column: null, index: schema.sections[section]?.blocks.length ?? 0 };
}

/** Ra khỏi cột: đặt ngay SAU cột trong cùng nhóm. Khối không nằm trong cột ⇒ `null`. */
export function slotOutOfColumn(schema: PageSchema, id: string): DropSlot | null {
  const p = locate(schema, id);
  if (!p || p.child === null) return null;
  return { section: p.section, column: null, index: p.index + 1 };
}

// ═══════════ HOÀN TÁC / LÀM LẠI ═══════════

export const HISTORY_LIMIT = 50;

/**
 * Ngăn hoàn tác CHỈ ở trình duyệt: mỗi phần tử là một schema đầy đủ (bất biến — phép biến đổi không sửa tại chỗ),
 * tối đa 50 bước. `lastKey`: các lượt sửa liền nhau CÙNG một ô (gõ tiêu đề từng chữ) gộp thành MỘT bước.
 */
export type BuilderHistory = { past: PageSchema[]; present: PageSchema; future: PageSchema[]; lastKey: string | null };

export function initHistory(schema: PageSchema): BuilderHistory {
  return { past: [], present: schema, future: [], lastKey: null };
}

export function commit(h: BuilderHistory, next: PageSchema, key: string | null = null): BuilderHistory {
  if (next === h.present) return h;
  if (key !== null && key === h.lastKey && h.past.length > 0) return { past: h.past, present: next, future: [], lastKey: key };
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [], lastKey: key };
}

export function undo(h: BuilderHistory): BuilderHistory {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future].slice(0, HISTORY_LIMIT), lastKey: null };
}

export function redo(h: BuilderHistory): BuilderHistory {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: h.future[0], future: h.future.slice(1), lastKey: null };
}

// ═══════════ LỖI THEO KHOÁ KHỐI ═══════════

/**
 * Lỗi của máy chủ mang `path` theo CHỈ SỐ của schema ĐÃ GỬI (`sections.1.blocks.0.children.2.config.metric`).
 * Người dùng có thể kéo khối đi chỗ khác trong lúc chờ phản hồi, nên đổi ngay sang KHOÁ KHỐI trên chính schema đã
 * gửi: lỗi đi theo khối, không đi theo ô lưới. Lỗi không gắn được khối nào thì gắn nhóm, không nữa thì lên đầu —
 * không lỗi nào bị nuốt.
 */
export type BuilderErrors = { general: PagePathError[]; section: Record<string, PagePathError[]>; block: Record<string, PagePathError[]> };

export function errorsByBlock(errors: readonly PagePathError[], sent: PageSchema): BuilderErrors {
  const out: BuilderErrors = { general: [], section: {}, block: {} };
  for (const e of errors) {
    const path = e.path.replace(/\[(\d+)\]/g, ".$1").replace(/^\.+/, "");
    const m = /^sections\.(\d+)(?:\.blocks\.(\d+)(?:\.children\.(\d+))?)?(?:\.|$)/.exec(path);
    const section = m ? sent.sections[Number(m[1])] : undefined;
    if (!m || !section) {
      out.general.push(e);
      continue;
    }
    const top = m[2] !== undefined ? section.blocks[Number(m[2])] : undefined;
    const target = top && m[3] !== undefined ? (childrenOf(top)[Number(m[3])] ?? top) : top;
    if (target) (out.block[target.id] ??= []).push(e);
    else if (m[2] === undefined) (out.section[section.key] ??= []).push(e);
    else out.general.push(e);
  }
  return out;
}

export function errorCount(e: BuilderErrors): number {
  return e.general.length + Object.values(e.section).reduce((n, x) => n + x.length, 0) + Object.values(e.block).reduce((n, x) => n + x.length, 0);
}

// ═══════════ THƯ VIỆN ═══════════

export type LibraryKind = "section" | "row" | "column" | "kpi" | "table" | "form" | "kanban" | "chart" | "timeline" | "filter" | "button" | "text";
export type LibraryItem = { kind: LibraryKind; label: string; hint: string; blockType: BlockType | null };

export const LIBRARY: readonly LibraryItem[] = [
  { kind: "section", label: "Nhóm", hint: "Một khung có tiêu đề, các khối xếp lưới 12 cột bên trong.", blockType: null },
  { kind: "row", label: "Hàng", hint: "Một hàng không khung, không tiêu đề — các khối xếp lưới 12 cột.", blockType: null },
  { kind: "column", label: "Cột", hint: "Xếp tối đa 6 khối chồng dọc trong một ô (vd hai KPI cạnh một biểu đồ).", blockType: "column" },
  { kind: "kpi", label: "KPI", hint: "Một con số từ sổ chỉ số — cùng công thức với báo cáo.", blockType: "kpi" },
  { kind: "table", label: "Bảng", hint: "Danh sách bản ghi của một đối tượng: cột, lọc, sắp xếp, phân trang.", blockType: "table" },
  { kind: "form", label: "Form", hint: "Form đã xuất bản của một đối tượng (Phase 2).", blockType: "form" },
  { kind: "kanban", label: "Kanban", hint: "Thẻ xếp theo một field trạng thái tuỳ biến.", blockType: "kanban" },
  { kind: "chart", label: "Biểu đồ", hint: "Chuỗi số liệu theo ngày / theo nhóm.", blockType: "chart" },
  { kind: "timeline", label: "Dòng thời gian", hint: "Nhật ký của một bản ghi theo tham số URL.", blockType: "timeline" },
  { kind: "filter", label: "Bộ lọc", hint: "Ô lọc cho người xem, nhắm vào bảng / kanban / KPI / biểu đồ tổng hợp trên trang.", blockType: "filter" },
  { kind: "button", label: "Nút", hint: "Một thao tác trong sổ action.", blockType: "button" },
  { kind: "text", label: "Tiêu đề / Chữ", hint: "Tiêu đề và đoạn giải thích tĩnh.", blockType: "text" },
];

/** Vì sao một mục thư viện đang MỜ (`null` = dùng được). Hiện nguyên câu cạnh mục đó. */
export function libraryRefusal(item: LibraryItem, schema: PageSchema, catalog: PageEditorCatalog): string | null {
  if (item.kind === "section") return schema.sections.length >= PAGE_MAX_SECTIONS ? `Đã đủ ${PAGE_MAX_SECTIONS} nhóm.` : null;
  if (item.kind === "row") return schema.sections.length >= PAGE_MAX_SECTIONS ? `Đã đủ ${PAGE_MAX_SECTIONS} nhóm.` : null;
  if (totalBlocks(schema) >= PAGE_MAX_BLOCKS) return `Đã đủ ${PAGE_MAX_BLOCKS} khối (đếm cả khối trong cột).`;
  switch (item.kind) {
    case "filter":
      return catalog.lists.length ? null : "Chưa có đối tượng nào để lọc với module đang bật.";
    case "kpi":
      return catalog.metrics.length ? null : "Chưa có nguồn chỉ số nào bạn xem được với module đang bật.";
    case "table":
      return catalog.lists.length ? null : "Chưa có đối tượng nào làm được bảng với module đang bật.";
    case "chart":
      return catalog.series.length ? null : "Chưa có chuỗi số liệu nào bạn xem được với module đang bật.";
    case "kanban":
      return kanbanObjects(catalog).length ? null : "Chưa có đối tượng nào có field trạng thái TUỲ BIẾN — tạo ở Mô hình dữ liệu.";
    case "timeline":
      return catalog.timelines.length ? null : "Chưa có nguồn nhật ký nào với module đang bật.";
    case "form":
      return formObjects(catalog).length ? null : "Chưa có đối tượng nào có form đã khai.";
    case "button":
      return catalog.actions.length ? null : "Chưa có thao tác nào trong sổ action bạn dùng được.";
    default:
      return null;
  }
}

/** Tab của khung thuộc tính mà một loại khối có nội dung. */
export function inspectorTabsOf(type: string): { data: boolean; actions: boolean } {
  if (type === "button") return { data: false, actions: true };
  if (type === "table") return { data: true, actions: true };
  if (type === COLUMN_TYPE) return { data: false, actions: false };
  return { data: true, actions: false };
}

/**
 * Câu kiểm sớm của MỘT khối (chưa chọn nguồn, khoá sai dạng…) — dùng lại đúng `checkPageDraft` của Phase 4 trên
 * một trang một-khối, không viết luật thứ hai. `null` = khối đủ để vẽ minh hoạ.
 */
export function blockEarlyIssue(block: PageBlock): string | null {
  if (isColumn(block)) return null;
  const errs = checkPageDraft({ version: 1, sections: [{ key: "k", blocks: [block] }] });
  return errs[0]?.message ?? null;
}

/**
 * Kiểm sớm cả trang trước khi TỰ LƯU: luật Phase 4 (`checkPageDraft`, nay duyệt phẳng CẢ khối con của cột) + cột
 * trống. Chỉ điều chắc chắn sai — lời cuối vẫn là `validatePageSchema` ở máy chủ.
 */
export function builderEarlyCheck(schema: PageSchema): PagePathError[] {
  const errors = checkPageDraft(schema);
  for (const { block, path } of flattenBlocks(schema)) {
    if (isColumn(block) && childrenOf(block).length === 0) errors.push({ path: `${path}.children`, message: "Cột trống — kéo khối vào hoặc xoá cột." });
  }
  return errors;
}

/** Khoá khối hợp lệ theo đúng mẫu máy chủ dùng. */
export function isValidBlockId(id: string): boolean {
  return BLOCK_ID_PATTERN.test(id);
}
