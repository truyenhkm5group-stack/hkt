"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Eye, Keyboard, ListPlus, Loader2, Monitor, Redo2, Smartphone, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { PageStateBadge } from "@/components/platform/pages/page-badges";
import { PathErrors } from "@/components/platform/pages/path-errors";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { addPageToMenuAction, loadBuilderDraftAction, publishBuilderPageAction, saveBuilderDraftAction } from "@/lib/actions/page-admin";
import { previewPageBlock } from "@/lib/actions/page-preview";
import { COMPONENT_REGISTRY } from "@/lib/pages/components";
import { flattenBlocks, type BlockIssue, type PageBlock, type PageNav, type PageSchema, type PageStatus, type ResolvedBlock } from "@/lib/pages/types";
import { sameConfig } from "@/lib/platform-ui/metadata-admin-shared";
import { filterTargetsOf, pageHref, type PageEditorCatalog, type PageMetaOptions, type PagePathError } from "@/lib/platform-ui/page-admin-shared";
import {
  applyOp,
  blockEarlyIssue,
  builderEarlyCheck,
  checkOp,
  commit,
  endOfSection,
  errorCount,
  errorsByBlock,
  allBlockIds,
  initHistory,
  LIBRARY,
  locate,
  newBuilderBlock,
  redo,
  undo,
  isColumn,
  type BuilderErrors,
  type BuilderOp,
  type LibraryKind,
} from "@/lib/platform-ui/page-builder-ops";
import { cn } from "@/lib/utils";
import { BuilderCanvas, type Device, type Selection } from "./builder-canvas";
import { BuilderInspector } from "./builder-inspector";
import { BuilderLibrary } from "./builder-library";
import { sameHint, type DragPayload, type DropHint } from "./dnd";

/**
 * ═══════════ TRÌNH DỰNG TRANG KÉO-THẢ (Phase 5) — TRÌNH SOẠN TRỰC QUAN CỦA `PageSchema` ═══════════
 *
 * Không phải runtime thứ hai: trạng thái duy nhất là MỘT `PageSchema` (+ ngăn hoàn tác ≤ 50 bước); mọi thao tác đi
 * qua hàm thuần `applyOp` (`lib/platform-ui/page-builder-ops.ts`); lưu và xuất bản đi qua ĐÚNG dịch vụ trang của
 * Phase 4, nơi `validatePageSchema` là lời cuối.
 *
 * TỰ LƯU: 2 giây sau thao tác cuối, CHỈ khi kiểm sớm đạt, gửi `baseRevision` (revision đang đứng trên). Người khác
 * vừa lưu ⇒ `CONFLICT` ⇒ hộp «tải bản của họ / ghi đè (xác nhận)» — không bao giờ lặng lẽ đè bản của người khác. Lỗi
 * của máy chủ đổi sang KHOÁ KHỐI trên chính schema đã gửi (`errorsByBlock`) và hiện ở đúng khối — không xoá thao tác
 * nào của người dùng, không tự "sửa hộ".
 *
 * XEM TRƯỚC: mỗi khối (khối con của cột riêng từng khối) vẽ bằng kết quả `previewPageBlock` giữ theo NỘI DUNG khối
 * (loại + cấu hình + khoá). Kéo / đổi chỗ / đổi độ rộng không đổi nội dung ⇒ không gọi máy chủ; sửa cấu hình ⇒ gọi lại
 * sau 400 ms không gõ thêm, trong lúc chờ vẫn vẽ kết quả cũ. Khối mới chưa có kết quả ⇒ khung xương của renderer.
 */

const PREVIEW_DEBOUNCE_MS = 400;

/** Nội dung quyết định kết quả xem trước — KHÔNG gồm độ rộng, vị trí, tiêu đề (renderer tự vẽ những thứ đó). */
function previewKey(b: PageBlock): string {
  return JSON.stringify([b.id, b.type, b.config]);
}

const AUTOSAVE_MS = 2000;

type SaveState =
  | { kind: "saved"; at: string | null }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "blocked"; count: number }
  | { kind: "error"; count: number; message?: string }
  | { kind: "conflict" };

const NO_ERRORS: BuilderErrors = { general: [], section: {}, block: {} };

type Props = {
  pageId: string;
  pageName: string;
  slug: string;
  status: PageStatus;
  publishedVersion: number;
  publishedAt: string | null;
  nav: PageNav;
  draft: PageSchema;
  draftRevision: number;
  catalog: PageEditorCatalog;
  options: PageMetaOptions;
};

function clock(): string {
  return new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function PageBuilder(props: Props) {
  const { pageId, pageName, slug, catalog, options } = props;
  const [hist, setHist] = React.useState(() => initHistory(props.draft));
  const schema = hist.present;
  const [selection, setSelection] = React.useState<Selection>(null);
  const [device, setDevice] = React.useState<Device>("desktop");
  const [errors, setErrors] = React.useState<BuilderErrors>(NO_ERRORS);
  const [notes, setNotes] = React.useState<PagePathError[]>([]);
  const [save, setSave] = React.useState<SaveState>({ kind: "saved", at: null });
  const [meta, setMeta] = React.useState({ publishedVersion: props.publishedVersion, publishedAt: props.publishedAt, nav: props.nav });
  const [confirmPublish, setConfirmPublish] = React.useState(false);
  const [busy, setBusy] = React.useState<"publish" | "menu" | null>(null);
  const [hint, setHintState] = React.useState<DropHint | null>(null);
  const hintRef = React.useRef<DropHint | null>(null);
  const drag = React.useRef<DragPayload | null>(null);

  // ─── Thao tác: MỘT cửa cho mọi phép biến đổi (kéo-thả, nút, bàn phím, form thuộc tính) ───
  const run = React.useCallback(
    (op: BuilderOp, key?: string): boolean => {
      const why = checkOp(schema, op);
      if (why) {
        toast.error(why);
        return false;
      }
      const next = applyOp(schema, op);
      setHist((h) => commit(h, next, key ?? null));
      if (op.kind === "patchBlock" && op.patch.id !== undefined && op.patch.id !== op.id) setSelection({ kind: "block", id: op.patch.id });
      if (op.kind === "insertBlock") setSelection({ kind: "block", id: op.block.id });
      if (op.kind === "duplicateBlock") {
        const before = allBlockIds(schema);
        const nested = locate(next, op.id)?.child !== null;
        const created = [...allBlockIds(next)].find((id) => !before.has(id) && (locate(next, id)?.child !== null) === nested);
        if (created) setSelection({ kind: "block", id: created });
      }
      if (op.kind === "insertSection") setSelection({ kind: "section", key: next.sections[op.at].key });
      return true;
    },
    [schema],
  );

  const addFromLibrary = React.useCallback(
    (kind: LibraryKind, at?: DropHint) => {
      if (kind === "section" || kind === "row") {
        const index = at?.kind === "section" ? at.index : selection?.kind === "section" ? schema.sections.findIndex((s) => s.key === selection.key) + 1 : schema.sections.length;
        run({ kind: "insertSection", variant: kind === "row" ? "plain" : "card", at: index });
        return;
      }
      let slot = at?.kind === "block" ? at.slot : null;
      if (!slot) {
        const sel = selection?.kind === "block" ? locate(schema, selection.id)?.section : selection?.kind === "section" ? schema.sections.findIndex((s) => s.key === selection.key) : -1;
        const si = sel !== undefined && sel >= 0 ? sel : schema.sections.length - 1;
        if (si < 0) {
          toast.error("Trang chưa có nhóm nào — thêm «Nhóm» trước.");
          return;
        }
        slot = endOfSection(schema, si);
      }
      const item = LIBRARY.find((x) => x.kind === kind);
      if (!item?.blockType) return;
      run({ kind: "insertBlock", block: newBuilderBlock(item.blockType, schema, catalog, COMPONENT_REGISTRY[item.blockType].defaultSpan), at: slot });
    },
    [catalog, run, schema, selection],
  );

  // ─── Kéo-thả ───
  const setHint = React.useCallback((h: DropHint | null) => {
    if (sameHint(hintRef.current, h)) return;
    hintRef.current = h;
    setHintState(h);
  }, []);
  const endDrag = React.useCallback(() => {
    drag.current = null;
    hintRef.current = null;
    setHintState(null);
  }, []);
  const onDrop = React.useCallback(() => {
    const p = drag.current;
    const h = hintRef.current;
    endDrag();
    if (!p || !h) return;
    if (p.kind === "new") addFromLibrary(p.item, h);
    else if (p.kind === "block" && h.kind === "block") run({ kind: "moveBlock", id: p.id, to: h.slot });
    else if (p.kind === "section" && h.kind === "section") {
      const to = h.index > p.index ? h.index - 1 : h.index;
      if (to !== p.index) run({ kind: "moveSection", from: p.index, to });
    }
  }, [addFromLibrary, endDrag, run]);

  // ─── Hoàn tác / làm lại (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) — ô đang gõ giữ phím tắt gốc của trình duyệt ───
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) setHist(undo);
      else if ((k === "z" && e.shiftKey) || k === "y") setHist(redo);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ─── Tự lưu ───
  const savedRef = React.useRef<PageSchema>(props.draft);
  const revisionRef = React.useRef<number>(props.draftRevision);
  const [conflict, setConflict] = React.useState<{ current: number | null; overwrite: boolean } | null>(null);
  const conflictRef = React.useRef(false);
  conflictRef.current = conflict !== null;
  const latestRef = React.useRef<PageSchema>(schema);
  const inflight = React.useRef(false);
  const queued = React.useRef(false);
  latestRef.current = schema;

  const flush = React.useCallback(async (): Promise<void> => {
    if (conflictRef.current) return; // đang chờ người soạn quyết «tải bản của họ / ghi đè»
    const s = latestRef.current;
    if (sameConfig(s, savedRef.current)) {
      setSave((x) => (x.kind === "saved" ? x : { kind: "saved", at: clock() }));
      return;
    }
    const early = builderEarlyCheck(s);
    if (early.length) {
      setErrors(errorsByBlock(early, s));
      setSave({ kind: "blocked", count: early.length });
      return;
    }
    if (inflight.current) {
      queued.current = true;
      return;
    }
    inflight.current = true;
    setSave({ kind: "saving" });
    try {
      const r = await saveBuilderDraftAction(pageId, s, revisionRef.current);
      if (r.ok) {
        savedRef.current = s;
        revisionRef.current = r.revision;
        setErrors(NO_ERRORS);
        setNotes(r.notes);
        setSave(sameConfig(latestRef.current, s) ? { kind: "saved", at: clock() } : { kind: "dirty" });
      } else if (r.conflict) {
        conflictRef.current = true;
        setConflict({ current: r.currentRevision ?? null, overwrite: false });
        setSave({ kind: "conflict" });
      } else {
        const e = errorsByBlock(r.errors, s);
        setErrors(e);
        setSave({ kind: "error", count: errorCount(e) });
      }
    } catch {
      setSave({ kind: "error", count: 0, message: "Mất kết nối tới máy chủ — thao tác vẫn còn, sẽ lưu lại ở lần sửa kế tiếp." });
    } finally {
      inflight.current = false;
      if (queued.current) {
        queued.current = false;
        void flush();
      }
    }
  }, [pageId]);

  React.useEffect(() => {
    if (sameConfig(schema, savedRef.current) || conflictRef.current) return;
    setSave({ kind: "dirty" });
    const t = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [schema, flush]);

  const dirty = !sameConfig(schema, savedRef.current) || save.kind === "saving";
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ─── CONFLICT: tải bản của họ, hoặc ghi đè có xác nhận ───
  const [resolving, setResolving] = React.useState(false);
  const loadTheirs = async () => {
    setResolving(true);
    try {
      const r = await loadBuilderDraftAction(pageId);
      if (!r.ok) {
        toast.error(r.errors[0]?.message ?? "Không tải được bản nháp.");
        return;
      }
      savedRef.current = r.draft;
      revisionRef.current = r.draftRevision;
      conflictRef.current = false;
      setConflict(null);
      setHist(initHistory(r.draft));
      setSelection(null);
      setErrors(NO_ERRORS);
      setSave({ kind: "saved", at: clock() });
      toast.success("Đã tải bản nháp mới nhất — thay đổi chưa lưu của bạn đã bỏ.");
    } catch {
      toast.error("Không tải được bản nháp — thử lại.");
    } finally {
      setResolving(false);
    }
  };
  const overwrite = () => {
    if (conflict?.current !== null && conflict?.current !== undefined) revisionRef.current = conflict.current;
    conflictRef.current = false;
    setConflict(null);
    void flush();
  };

  // ─── Xem trước từng khối (theo nội dung, chống dội 400 ms) ───
  const previews = React.useRef(new Map<string, ResolvedBlock | Promise<ResolvedBlock>>());
  const resolvers = React.useRef(new Map<string, (r: ResolvedBlock) => void>());
  const lastById = React.useRef(new Map<string, ResolvedBlock>());
  const inflightPreview = React.useRef(new Set<string>());
  const previewTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [previewIssues, setPreviewIssues] = React.useState<Record<string, PagePathError[]>>({});
  const [, bump] = React.useReducer((x: number) => x + 1, 0);

  const resultOf = React.useCallback((b: PageBlock): ResolvedBlock | Promise<ResolvedBlock> => {
    const early = blockEarlyIssue(b);
    if (early) return { ok: false, block: b, issue: { blockId: b.id, code: "INVALID_CONFIG", message: early } };
    const key = previewKey(b);
    const hit = previews.current.get(key);
    if (hit && !(hit instanceof Promise)) return { ...hit, block: b } as ResolvedBlock;
    const stale = lastById.current.get(b.id);
    if (stale) return { ...stale, block: b } as ResolvedBlock;
    if (hit) return hit;
    // Khối mới chưa có kết quả nào: một Promise ỔN ĐỊNH (giữ trong bộ đệm) ⇒ renderer hiện khung xương của nó.
    const pending = new Promise<ResolvedBlock>((resolve) => resolvers.current.set(key, resolve));
    previews.current.set(key, pending);
    return pending;
  }, []);

  const fetchPreview = React.useCallback(
    async (b: PageBlock, key: string) => {
      inflightPreview.current.add(key);
      let r: ResolvedBlock;
      let cache = true;
      try {
        const res = await previewPageBlock(pageId, b);
        if (res.ok) {
          r = res.resolved;
          setPreviewIssues((x) => {
            if (!x[b.id]) return x;
            const next = { ...x };
            delete next[b.id];
            return next;
          });
        } else {
          const code: BlockIssue["code"] = res.code === "FORBIDDEN" ? "FORBIDDEN" : res.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_CONFIG";
          r = { ok: false, block: b, issue: { blockId: b.id, code, message: res.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join(" · ") } };
          setPreviewIssues((x) => ({ ...x, [b.id]: res.errors }));
        }
      } catch {
        cache = false;
        r = { ok: false, block: b, issue: { blockId: b.id, code: "DATA_ERROR", message: "Không xem trước được lúc này — sửa khối để thử lại." } };
      }
      if (cache) previews.current.set(key, r);
      else previews.current.delete(key);
      lastById.current.set(b.id, r);
      resolvers.current.get(key)?.(r);
      resolvers.current.delete(key);
      inflightPreview.current.delete(key);
      bump();
    },
    [pageId],
  );

  React.useEffect(() => {
    for (const { block: b } of flattenBlocks(schema)) {
      if (isColumn(b) || blockEarlyIssue(b)) continue;
      const key = previewKey(b);
      const hit = previews.current.get(key);
      if ((hit && !(hit instanceof Promise)) || inflightPreview.current.has(key)) continue;
      const timers = previewTimers.current;
      const old = timers.get(b.id);
      if (old) clearTimeout(old);
      const wait = lastById.current.has(b.id) ? PREVIEW_DEBOUNCE_MS : 0;
      timers.set(
        b.id,
        setTimeout(() => {
          timers.delete(b.id);
          void fetchPreview(b, key);
        }, wait),
      );
    }
  }, [schema, fetchPreview]);
  React.useEffect(() => {
    const timers = previewTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  const filterTargets = React.useMemo(() => filterTargetsOf(schema), [schema]);

  // Khung chỉ vẽ ở TRÌNH DUYỆT: kết quả xem trước là Promise chờ lượt gọi máy chủ khởi từ effect — dựng ở máy chủ thì
  // Promise ấy không bao giờ xong và luồng HTML treo (trang không bao giờ «load»).
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // ─── Xuất bản / menu ───
  const publish = async () => {
    setBusy("publish");
    try {
      const r = await publishBuilderPageAction(pageId);
      setConfirmPublish(false);
      if (r.ok) {
        setMeta((m) => ({ ...m, publishedVersion: r.version, publishedAt: r.publishedAt }));
        toast.success(`Đã xuất bản phiên bản ${r.version} — người dùng thấy ở lần tải kế tiếp.`);
      } else {
        setErrors(errorsByBlock(r.errors, savedRef.current));
        toast.error("Chưa xuất bản được — xem lỗi ở từng khối.");
      }
    } catch {
      setConfirmPublish(false);
      toast.error("Không xuất bản được — thử lại.");
    } finally {
      setBusy(null);
    }
  };
  const addToMenu = async () => {
    setBusy("menu");
    try {
      const r = await addPageToMenuAction(pageId);
      if (r.ok) {
        setMeta((m) => ({ ...m, nav: r.nav }));
        toast.success(meta.publishedVersion > 0 ? `Đã thêm «${r.nav.label}» vào menu.` : `Đã bật menu — «${r.nav.label}» hiện trên menu từ lần xuất bản đầu.`);
      } else toast.error(r.errors[0]?.message ?? "Không bật được menu.");
    } catch {
      toast.error("Không bật được menu — thử lại.");
    } finally {
      setBusy(null);
    }
  };

  const publishBlocked = save.kind !== "saved" ? "Đợi tự lưu xong (và hết lỗi) rồi mới xuất bản — xuất bản thứ chưa lưu là xuất bản thứ không có trong CSDL." : null;

  return (
    <div className="space-y-3" data-page-builder={pageId}>
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card px-3 py-2 shadow-[var(--shadow-card)]" role="toolbar" aria-label="Thanh công cụ trình dựng trang">
        <PageStateBadge status={props.status} publishedVersion={meta.publishedVersion} />
        <span className="text-xs text-muted-foreground" data-builder-version>
          {meta.publishedVersion > 0 ? `Phiên bản ${meta.publishedVersion} đang chạy${meta.publishedAt ? ` · ${meta.publishedAt}` : ""}` : "Chưa xuất bản lần nào"}
        </span>
        <SaveStatus state={save} />
        <span className="mx-1 h-5 w-px bg-hairline" aria-hidden />
        <Button variant="ghost" size="icon-sm" aria-label="Hoàn tác (Ctrl+Z)" title="Hoàn tác (Ctrl+Z)" disabled={hist.past.length === 0} onClick={() => setHist(undo)}>
          <Undo2 />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Làm lại (Ctrl+Shift+Z)" title="Làm lại (Ctrl+Shift+Z)" disabled={hist.future.length === 0} onClick={() => setHist(redo)}>
          <Redo2 />
        </Button>
        <div className="inline-flex rounded-full bg-muted p-0.5" role="group" aria-label="Xem khung như">
          <Button variant={device === "desktop" ? "secondary" : "ghost"} size="xs" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}>
            <Monitor /> Máy tính
          </Button>
          <Button variant={device === "phone" ? "secondary" : "ghost"} size="xs" aria-pressed={device === "phone"} onClick={() => setDevice("phone")}>
            <Smartphone /> Điện thoại
          </Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm" title="Trình soạn bằng ô chọn và nút — dùng hoàn toàn bằng bàn phím">
            <Link href={`/settings/pages/${encodeURIComponent(pageId)}`}>
              <Keyboard /> Chế độ bàn phím
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" title="Bản nháp ĐÃ LƯU với số thật, ở tab mới">
            <a href={`/settings/pages/${encodeURIComponent(pageId)}/preview`} target="_blank" rel="noreferrer">
              <Eye /> Xem trước
            </a>
          </Button>
          {meta.nav.enabled ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={meta.publishedVersion > 0 ? "Trang đang có mục trên menu" : "Mục menu hiện từ lần xuất bản đầu"}>
              <CheckCircle2 className="size-3.5 text-emerald-600" /> Trên menu: {meta.nav.label}
            </span>
          ) : (
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={addToMenu}>
              <ListPlus /> Thêm vào menu
            </Button>
          )}
          <Button size="sm" disabled={busy !== null || publishBlocked !== null || props.status === "ARCHIVED"} title={publishBlocked ?? undefined} onClick={() => setConfirmPublish(true)}>
            Xuất bản
          </Button>
        </div>
      </div>
      {save.kind === "error" && save.message ? <PathErrors errors={[{ path: "_", message: save.message }]} /> : null}

      <div className="grid gap-3 lg:h-[calc(100dvh-15rem)] lg:min-h-[560px] lg:grid-cols-[208px_minmax(0,1fr)_340px]">
        <aside className="min-h-0 overflow-y-auto rounded-2xl border bg-surface p-2">
          <BuilderLibrary schema={schema} catalog={catalog} drag={drag} onAdd={(k) => addFromLibrary(k)} onDragEnd={endDrag} />
        </aside>
        <div className="min-h-0 overflow-auto rounded-2xl bg-surface-sunken/40 p-3" onClick={() => setSelection(null)} data-builder-canvas>
          {mounted ? (
          <BuilderCanvas
            schema={schema}
            resultOf={resultOf}
            device={device}
            selection={selection}
            errors={errors}
            drag={drag}
            hint={hint}
            onHint={setHint}
            onDrop={onDrop}
            onDragEnd={endDrag}
            onSelect={setSelection}
            onSpan={(id, span) => run({ kind: "setSpan", id, span })}
            onDuplicate={(id) => run({ kind: "duplicateBlock", id })}
            onRemove={(id) => {
              if (run({ kind: "removeBlock", id })) setSelection(null);
            }}
          />
          ) : (
            <div className="space-y-3" aria-busy>
              <Skeleton className="h-[140px] w-full rounded-2xl" />
              <Skeleton className="h-[280px] w-full rounded-2xl" />
            </div>
          )}
        </div>
        <aside className="min-h-0 overflow-y-auto rounded-2xl border bg-card p-3" aria-label="Thuộc tính">
          <BuilderInspector
            schema={schema}
            catalog={catalog}
            options={options}
            selection={selection}
            errors={errors}
            previewIssues={previewIssues}
            filterTargets={filterTargets}
            notes={notes}
            onOp={run}
            onSelect={setSelection}
          />
        </aside>
      </div>

      <AlertDialog open={conflict !== null}>
        <AlertDialogContent data-builder-conflict>
          <AlertDialogHeader>
            <AlertDialogTitle>{conflict?.overwrite ? "Ghi đè bản của người kia?" : "Người khác vừa lưu bản nháp này"}</AlertDialogTitle>
            <AlertDialogDescription>
              {conflict?.overwrite
                ? "Bản nháp của bạn sẽ thay bản người kia vừa lưu. Bản của họ vẫn còn trong nhật ký thay đổi, nhưng không còn là bản nháp. Chỉ ghi đè khi đã chắc."
                : "Thay đổi của bạn CHƯA được lưu — trang đang có một bản nháp mới hơn do người khác lưu. Tải bản của họ (bỏ thay đổi của bạn) hoặc ghi đè bằng bản của bạn."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {conflict?.overwrite ? (
              <>
                <AlertDialogCancel onClick={() => setConflict((c) => (c ? { ...c, overwrite: false } : c))}>Quay lại</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    overwrite();
                  }}
                >
                  Ghi đè
                </AlertDialogAction>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={resolving} onClick={() => setConflict((c) => (c ? { ...c, overwrite: true } : c))}>
                  Ghi đè bằng bản của tôi…
                </Button>
                <AlertDialogAction
                  disabled={resolving}
                  onClick={(e) => {
                    e.preventDefault();
                    void loadTheirs();
                  }}
                >
                  {resolving ? "Đang tải…" : "Tải bản của họ"}
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmPublish} onOpenChange={(o) => busy === null && setConfirmPublish(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xuất bản «{pageName}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Người dùng thấy bản này ở LẦN TẢI KẾ TIẾP của {pageHref(slug)} — không cần deploy. {meta.publishedVersion > 0 ? `Bản đang xuất bản (phiên bản ${meta.publishedVersion}) được giữ trong lịch sử phiên bản.` : "Đây là lần xuất bản đầu tiên — sau lần này đường dẫn bị khoá."} Máy chủ kiểm lại cấu hình; có lỗi thì không xuất bản gì.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy !== null}
              onClick={(e) => {
                e.preventDefault();
                void publish();
              }}
            >
              {busy === "publish" ? "Đang xuất bản…" : "Xuất bản"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  const text =
    state.kind === "saved"
      ? state.at
        ? `Đã lưu nháp · ${state.at}`
        : "Nháp đã lưu"
      : state.kind === "dirty"
        ? "Chưa lưu — tự lưu sau 2 giây"
        : state.kind === "saving"
          ? "Đang lưu…"
          : state.kind === "conflict"
            ? "Chưa lưu — người khác vừa lưu bản nháp"
          : state.kind === "blocked"
            ? `Chưa lưu: ${state.count} chỗ cần sửa`
            : state.count
              ? `Máy chủ từ chối: ${state.count} lỗi`
              : "Lưu không thành công";
  return (
    <span
      role="status"
      aria-live="polite"
      data-save-state={state.kind}
      className={cn("inline-flex items-center gap-1 text-xs", state.kind === "blocked" || state.kind === "error" || state.kind === "conflict" ? "font-medium text-destructive" : state.kind === "dirty" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}
    >
      {state.kind === "saving" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {text}
    </span>
  );
}
