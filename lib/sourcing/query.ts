/**
 * ═══ BỘ SINH TỪ KHOÁ TIẾNG TRUNG TỪ CÂU TIẾNG VIỆT (SRC-2 · docs/tech/ai-sourcing.md §3.2) — HÀM THUẦN, CLIENT-SAFE ═══
 *
 * `buildChineseQueries(câu)` không đọc / ghi CSDL, không gọi mạng, không gọi AI: cùng câu ⇒ cùng kết quả, mọi lần.
 *
 *  1. Chuẩn hoá (chữ thường, NFC, bỏ dấu câu) rồi tách âm tiết.
 *  2. Ghép DÀI NHẤT trước với từ điển (`SOURCING_GLOSSARY`): «cho mẹ» thắng «cho», «quần ống rộng» thắng «quần».
 *     Chữ KHÔNG DẤU («dam suong») được đoán theo bản bỏ dấu của từ điển — CHỈ khi bản bỏ dấu ấy thuộc đúng MỘT mục (trùng ⇒ không
 *     đoán) và cụm người gõ thật sự không có dấu (gõ «mè» thì không bao giờ thành «mẹ»). Mục đoán kiểu này mang `viaFold`.
 *  3. Từ nối (`SOURCING_FILLER_WORDS`) bị bỏ và NÓI RA (`ignored`). Phần còn lại không khớp gì vào `unmatched` — gộp các âm tiết
 *     liền nhau thành một cụm để người dùng đọc được («thổ cẩm», không phải «thổ» · «cẩm»). Không nuốt im, không đoán.
 *  4. Truy vấn (tối đa 5), xếp từ CỤ THỂ nhất: đủ mọi ý đã hiểu → cùng ý bằng từ đồng nghĩa → nới dần bằng cách bỏ ý kém quan trọng
 *     nhất (`DROP_ORDER`). Truy vấn rộng nhất là loại hàng trơn; còn một từ mà không phải loại hàng thì dừng.
 */
import { GLOSSARY_ROLES, SOURCING_FILLER_WORDS, SOURCING_GLOSSARY, type GlossaryEntry, type GlossaryRole } from "@/lib/constants/sourcing-glossary";

export const SOURCING_QUERY_MAX = 5;
export const SOURCING_INPUT_MAX = 200;

/** Thứ tự BỎ BỚT khi nới truy vấn — ý ít quyết định «đúng món hàng» bị bỏ trước. Loại hàng không bao giờ bị bỏ. */
export const DROP_ORDER: readonly GlossaryRole[] = ["FEATURE", "STYLE", "PART", "SEASON", "FIT", "MATERIAL", "SIZE", "AUDIENCE"];

export type QueryTerm = { text: string; key: string; label: string; role: GlossaryRole; zh: readonly string[]; viaFold: boolean; note: string | null };
export type QueryKind = "FULL" | "SYNONYM" | "BROADER";
export type ChineseQuery = { zh: string; vi: string; kind: QueryKind };
export type QueryBuild = {
  input: string;
  terms: QueryTerm[];
  /** Cụm từ điển CHƯA hiểu — luôn hiện cho người dùng. */
  unmatched: string[];
  /** Từ nối đã bỏ qua. */
  ignored: string[];
  queries: ChineseQuery[];
  hasProduct: boolean;
  /** Từ điển chưa đủ: còn cụm chưa hiểu, hoặc chưa nhận ra loại hàng. */
  needsAi: boolean;
};

export function normalizeVi(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function foldVi(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").normalize("NFC");
}

type Index = { exact: Map<string, GlossaryEntry>; folded: Map<string, GlossaryEntry | null>; maxLen: number; fillers: Set<string>; foldedFillers: Set<string> };

function buildIndex(entries: readonly GlossaryEntry[]): Index {
  const exact = new Map<string, GlossaryEntry>();
  const folded = new Map<string, GlossaryEntry | null>();
  let maxLen = 1;
  for (const e of entries) {
    for (const raw of e.vi) {
      const v = normalizeVi(raw);
      exact.set(v, e);
      const f = foldVi(v);
      const seen = folded.get(f);
      // Hai mục khác nhau cùng một bản bỏ dấu ⇒ KHÔNG đoán (null), thay vì để mục khai sau thắng.
      folded.set(f, seen === undefined || seen?.key === e.key ? e : null);
      maxLen = Math.max(maxLen, v.split(" ").length);
    }
  }
  const fillers = new Set(SOURCING_FILLER_WORDS.map(normalizeVi));
  return { exact, folded, maxLen, fillers, foldedFillers: new Set([...fillers].map(foldVi)) };
}

const INDEX = buildIndex(SOURCING_GLOSSARY);

function lookup(idx: Index, phrase: string): { entry: GlossaryEntry; viaFold: boolean } | null {
  const hit = idx.exact.get(phrase);
  if (hit) return { entry: hit, viaFold: false };
  if (foldVi(phrase) !== phrase) return null;
  const f = idx.folded.get(phrase);
  return f ? { entry: f, viaFold: true } : null;
}

function isFiller(idx: Index, word: string): boolean {
  return idx.fillers.has(word) || (foldVi(word) === word && idx.foldedFillers.has(word));
}

const ROLE_RANK = new Map(GLOSSARY_ROLES.map((r, i) => [r, i]));

function compose(terms: readonly QueryTerm[], pick: (t: QueryTerm) => string): string {
  const ordered = [...terms].map((t, i) => ({ t, i })).sort((a, b) => ROLE_RANK.get(a.t.role)! - ROLE_RANK.get(b.t.role)! || a.i - b.i);
  const parts: string[] = [];
  for (const { t } of ordered) {
    const w = pick(t);
    if (!parts.includes(w)) parts.push(w);
  }
  return parts.join(" ");
}

function describe(terms: readonly QueryTerm[]): string {
  return [...terms]
    .sort((a, b) => ROLE_RANK.get(a.role)! - ROLE_RANK.get(b.role)!)
    .map((t) => t.label)
    .filter((l, i, all) => all.indexOf(l) === i)
    .join(" · ");
}

export function buildChineseQueries(input: string, entries: readonly GlossaryEntry[] = SOURCING_GLOSSARY): QueryBuild {
  const idx = entries === SOURCING_GLOSSARY ? INDEX : buildIndex(entries);
  const words = normalizeVi(input.slice(0, SOURCING_INPUT_MAX)).split(" ").filter(Boolean);
  const terms: QueryTerm[] = [];
  const unmatched: string[] = [];
  const ignored: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) unmatched.push(run.join(" "));
    run = [];
  };
  for (let i = 0; i < words.length; ) {
    let matched = false;
    for (let len = Math.min(idx.maxLen, words.length - i); len >= 1; len--) {
      const phrase = words.slice(i, i + len).join(" ");
      const hit = lookup(idx, phrase);
      if (!hit) continue;
      flush();
      terms.push({ text: phrase, key: hit.entry.key, label: hit.entry.label, role: hit.entry.role, zh: hit.entry.zh, viaFold: hit.viaFold, note: hit.entry.note ?? null });
      i += len;
      matched = true;
      break;
    }
    if (matched) continue;
    if (isFiller(idx, words[i])) {
      flush();
      ignored.push(words[i]);
    } else run.push(words[i]);
    i++;
  }
  flush();

  // Cùng một mục nói hai lần («mẹ … cho mẹ») là MỘT ý.
  const unique = terms.filter((t, i) => terms.findIndex((x) => x.key === t.key) === i);
  const hasProduct = unique.some((t) => t.role === "PRODUCT");
  const queries: ChineseQuery[] = [];
  const push = (q: ChineseQuery) => {
    if (q.zh && !queries.some((x) => x.zh === q.zh) && queries.length < SOURCING_QUERY_MAX) queries.push(q);
  };
  if (hasProduct || unique.length >= 2) {
    push({ zh: compose(unique, (t) => t.zh[0]), vi: `Đủ mọi ý: ${describe(unique)}`, kind: "FULL" });
    if (unique.some((t) => t.zh.length > 1)) push({ zh: compose(unique, (t) => t.zh[1] ?? t.zh[0]), vi: `Cùng ý, từ đồng nghĩa: ${describe(unique)}`, kind: "SYNONYM" });
    let rest = [...unique];
    for (const role of DROP_ORDER) {
      const dropped = rest.filter((t) => t.role === role);
      if (!dropped.length) continue;
      const next = rest.filter((t) => t.role !== role);
      // Còn một từ mà không phải loại hàng («妈妈装» trơn) thì không còn là truy vấn tìm hàng — dừng.
      if (!next.length || (next.length === 1 && next[0].role !== "PRODUCT")) break;
      rest = next;
      push({ zh: compose(rest, (t) => t.zh[0]), vi: `Nới rộng (bỏ ${dropped.map((t) => t.label).join(", ")}): ${describe(rest)}`, kind: "BROADER" });
    }
  }
  return { input, terms: unique, unmatched, ignored, queries, hasProduct, needsAi: unmatched.length > 0 || !hasProduct };
}
