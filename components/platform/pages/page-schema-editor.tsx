"use client";

import { useState, useTransition } from "react";
import { Archive, ChevronDown, ChevronRight, ExternalLink, Eye, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { MoveButtons, SELECT_CLASS } from "@/components/platform/metadata/bits";
import { BlockConfigForm } from "@/components/platform/pages/block-config-form";
import { PageStateBadge } from "@/components/platform/pages/page-badges";
import { PathErrors } from "@/components/platform/pages/path-errors";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { archivePageAction, publishPageAction, savePageDraftAction } from "@/lib/actions/page-admin";
import { moveItem, sameConfig } from "@/lib/platform-ui/metadata-admin-shared";
import {
  BLOCK_TYPE_HINT,
  BLOCK_TYPE_LABEL,
  blockCount,
  blockSummary,
  checkPageDraft,
  filterTargetsOf,
  isBlockSpan,
  moveBlockToSection,
  newBlock,
  newSectionKey,
  pageHref,
  SPAN_LABEL,
  splitPageErrors,
  type PageEditorCatalog,
  type PagePathError,
  type PageWriteResult,
} from "@/lib/platform-ui/page-admin-shared";
import { BLOCK_SPANS, BLOCK_TYPES, PAGE_MAX_BLOCKS, PAGE_MAX_SECTIONS, type BlockType, type PageBlock, type PageSchema, type PageStatus } from "@/lib/pages/types";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TRÌNH SOẠN NỘI DUNG TRANG — NHÁP → XEM TRƯỚC → XUẤT BẢN ═══════════
 *
 * CẤU HÌNH, không canvas kéo-thả: nhóm (thêm / đổi tên / xoá / lên / xuống), khối trong nhóm (thêm theo loại, độ
 * rộng, tiêu đề, lên / xuống, chuyển nhóm, xoá) + form cấu hình theo loại. Người dùng CHỈ thấy bản đã xuất bản.
 *
 * «Xuất bản» chỉ bấm được khi nháp đã lưu — xuất bản thứ đang thấy trên màn hình mà chưa lưu là xuất bản một thứ
 * không có trong CSDL. Lỗi của `validatePageSchema` (lưu nháp VÀ xuất bản) hiện NGUYÊN VĂN theo `path`, dưới đúng
 * khối / nhóm; lỗi không gắn được chỗ nào hiện ở đầu.
 */

type Props = {
  pageId: string;
  pageName: string;
  slug: string;
  status: PageStatus;
  publishedVersion: number;
  publishedAt: string | null;
  publishedBy: string | null;
  draft: PageSchema;
  /** Bản ĐÃ XUẤT BẢN — so với nháp để bật cờ «nháp khác bản đã xuất bản». */
  published: PageSchema | null;
  catalog: PageEditorCatalog;
};

export function PageSchemaEditor({ pageId, pageName, slug, status, publishedVersion, publishedAt, publishedBy, draft, published, catalog }: Props) {
  const [schema, setSchema] = useState<PageSchema>(draft);
  const [errors, setErrors] = useState<PagePathError[]>([]);
  const [notes, setNotes] = useState<PagePathError[]>([]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<"publish" | "archive" | null>(null);
  const [pending, startTransition] = useTransition();
  const archived = status === "ARCHIVED";
  const dirty = !sameConfig(schema, draft);
  const draftDiffers = publishedVersion > 0 && published !== null && !sameConfig(draft, published);
  const total = blockCount(schema);
  const split = splitPageErrors(errors, schema);

  const setSections = (fn: (s: PageSchema["sections"]) => PageSchema["sections"]) => setSchema((p) => ({ ...p, sections: fn(p.sections) }));
  const patchBlock = (si: number, bi: number, patch: Partial<PageBlock>) =>
    setSections((ss) => ss.map((s, i) => (i === si ? { ...s, blocks: s.blocks.map((b, j) => (j === bi ? ({ ...b, ...patch } as PageBlock) : b)) } : s)));
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const addBlock = (si: number, type: BlockType) => {
    const b = newBlock(type, schema, catalog);
    setSections((ss) => ss.map((s, i) => (i === si ? { ...s, blocks: [...s.blocks, b] } : s)));
    setOpen((o) => new Set(o).add(b.id));
  };

  const run = (fn: () => Promise<PageWriteResult>, success: string) =>
    startTransition(async () => {
      try {
        const r = await fn();
        setConfirm(null);
        if (r.ok) {
          setErrors([]);
          setNotes(r.notes);
          toast.success(success);
        } else {
          setNotes([]);
          setErrors(r.errors);
        }
      } catch {
        setConfirm(null);
        setErrors([{ path: "_", message: "Không thực hiện được — thử lại." }]);
      }
    });

  const save = () => {
    const early = checkPageDraft(schema);
    setErrors(early);
    if (early.length) return;
    run(() => savePageDraftAction(pageId, schema), "Đã lưu nháp — người dùng chưa thấy gì cho tới khi xuất bản.");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <PageStateBadge status={status} publishedVersion={publishedVersion} />
          {publishedVersion > 0 ? (
            <span className="text-muted-foreground">
              Đang xuất bản: <b className="text-foreground">phiên bản {publishedVersion}</b>
              {publishedAt ? ` · ${publishedAt}` : ""}
              {publishedBy ? ` · bởi ${publishedBy}` : ""}
            </span>
          ) : (
            <span className="text-muted-foreground">Chưa xuất bản lần nào — người dùng chưa thấy trang này.</span>
          )}
          {draftDiffers ? <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">Nháp khác bản đã xuất bản</span> : null}
          {publishedVersion > 0 && !archived ? (
            <a href={pageHref(slug)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
              <ExternalLink className="size-3.5" /> Mở trang
            </a>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dirty ? <span className="text-xs text-amber-700 dark:text-amber-400">Có thay đổi chưa lưu</span> : null}
          <Button variant="outline" size="sm" onClick={() => setSchema(draft)} disabled={!dirty || pending}>
            Bỏ thay đổi
          </Button>
          <Button variant="outline" size="sm" onClick={save} disabled={!dirty || pending || archived}>
            Lưu nháp
          </Button>
          <Button asChild variant="outline" size="sm" title={dirty ? "Xem trước hiện bản nháp ĐÃ LƯU — lưu trước để thấy thay đổi" : "Mở bản nháp đã lưu ở tab mới"}>
            <a href={`/settings/pages/${encodeURIComponent(pageId)}/preview`} target="_blank" rel="noreferrer">
              <Eye /> Xem trước
            </a>
          </Button>
          <Button size="sm" onClick={() => setConfirm("publish")} disabled={pending || dirty || archived} title={dirty ? "Lưu nháp trước khi xuất bản" : undefined}>
            Xuất bản
          </Button>
          {archived ? null : (
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirm("archive")}>
              <Archive /> Lưu trữ
            </Button>
          )}
        </div>
      </div>
      <PathErrors errors={split.general} />
      <PathErrors errors={notes} tone="warning" />

      <div className={cn("space-y-3", pending && "opacity-70")}>
        {schema.sections.map((s, si) => (
          <section key={s.key} className="rounded-xl border bg-surface">
            <header className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
              <Input
                className="h-8 max-w-xs font-semibold"
                value={s.title ?? ""}
                placeholder={`Nhóm ${si + 1} (không tiêu đề)`}
                maxLength={80}
                aria-label="Tiêu đề nhóm"
                disabled={archived}
                onChange={(e) => setSections((ss) => ss.map((x, i) => (i === si ? { ...x, title: e.target.value || undefined } : x)))}
              />
              <MoveButtons index={si} count={schema.sections.length} label={`nhóm ${s.title ?? si + 1}`} disabled={archived} onMove={(d) => setSections((ss) => moveItem(ss, si, d))} />
              <span className="text-xs text-muted-foreground">{s.blocks.length} khối</span>
              <select
                className={cn(SELECT_CLASS, "ml-auto")}
                value=""
                aria-label={`Thêm khối vào nhóm ${si + 1}`}
                disabled={archived || total >= PAGE_MAX_BLOCKS}
                title={total >= PAGE_MAX_BLOCKS ? `Tối đa ${PAGE_MAX_BLOCKS} khối mỗi trang` : undefined}
                onChange={(e) => e.target.value && addBlock(si, e.target.value as BlockType)}
              >
                <option value="">+ Thêm khối…</option>
                {BLOCK_TYPES.map((t) => (
                  <option key={t} value={t} title={BLOCK_TYPE_HINT[t]}>
                    {BLOCK_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="xs"
                disabled={archived || schema.sections.length <= 1}
                title={schema.sections.length <= 1 ? "Trang cần ít nhất một nhóm" : "Xoá nhóm và mọi khối trong nhóm"}
                onClick={() => setSections((ss) => ss.filter((_, i) => i !== si))}
              >
                <Trash2 /> Xoá nhóm
              </Button>
              <PathErrors errors={split.section[si] ?? []} className="basis-full" />
            </header>
            {s.blocks.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">Chưa có khối nào trong nhóm này — chọn «+ Thêm khối…».</p>
            ) : (
              <ul className="divide-y divide-hairline">
                {s.blocks.map((b, bi) => {
                  const expanded = open.has(b.id);
                  const blockErrors = split.block[si]?.[bi] ?? [];
                  return (
                    <li key={`${si}-${bi}`} className={cn("px-3 py-2", blockErrors.length && "bg-destructive/5")}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="ghost" size="icon-xs" aria-label={expanded ? "Thu gọn cấu hình" : "Mở cấu hình"} aria-expanded={expanded} onClick={() => toggle(b.id)}>
                          {expanded ? <ChevronDown /> : <ChevronRight />}
                        </Button>
                        <span className="whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium" title={BLOCK_TYPE_HINT[b.type]}>
                          {BLOCK_TYPE_LABEL[b.type]}
                        </span>
                        <Input className="h-8 w-44" value={b.title ?? ""} placeholder="Tiêu đề khối" maxLength={80} aria-label="Tiêu đề khối" disabled={archived} onChange={(e) => patchBlock(si, bi, { title: e.target.value || undefined })} />
                        <select className={SELECT_CLASS} aria-label="Độ rộng" value={b.span} disabled={archived} onChange={(e) => { const n = Number(e.target.value); if (isBlockSpan(n)) patchBlock(si, bi, { span: n }); }}>
                          {BLOCK_SPANS.map((n) => (
                            <option key={n} value={n}>
                              {SPAN_LABEL[n]}
                            </option>
                          ))}
                        </select>
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={blockSummary(b, catalog)}>
                          {blockSummary(b, catalog)}
                        </span>
                        <MoveButtons index={bi} count={s.blocks.length} label={b.title ?? b.id} disabled={archived} onMove={(d) => setSections((ss) => ss.map((x, i) => (i === si ? { ...x, blocks: moveItem(x.blocks, bi, d) } : x)))} />
                        {schema.sections.length > 1 ? (
                          <select className={SELECT_CLASS} value={si} aria-label="Chuyển sang nhóm" disabled={archived} onChange={(e) => setSchema((p) => moveBlockToSection(p, si, bi, Number(e.target.value)))}>
                            {schema.sections.map((x, i) => (
                              <option key={x.key} value={i}>
                                {x.title || `Nhóm ${i + 1}`}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <Button variant="ghost" size="icon-xs" aria-label="Xoá khối" title="Xoá khối" disabled={archived} onClick={() => setSections((ss) => ss.map((x, i) => (i === si ? { ...x, blocks: x.blocks.filter((_, j) => j !== bi) } : x)))}>
                          <Trash2 />
                        </Button>
                      </div>
                      <PathErrors errors={blockErrors} />
                      {expanded ? (
                        <div className="mt-2 space-y-2 rounded-lg border border-dashed p-3">
                          <label className="grid w-fit gap-1 text-xs font-medium text-muted-foreground">
                            Khoá khối (nút thao tác tra lại cấu hình theo khoá này)
                            <Input className="h-8 w-48 font-mono text-[12.5px]" value={b.id} maxLength={41} disabled={archived} onChange={(e) => {
                              const id = e.target.value.toLowerCase();
                              setOpen((o) => new Set([...o].map((x) => (x === b.id ? id : x))));
                              patchBlock(si, bi, { id });
                            }} />
                          </label>
                          <BlockConfigForm block={b} catalog={catalog} disabled={archived} filterTargets={filterTargetsOf(schema)} onChange={(config) => patchBlock(si, bi, { config })} />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={archived || schema.sections.length >= PAGE_MAX_SECTIONS}
            onClick={() => setSchema((p) => ({ ...p, sections: [...p.sections, { key: newSectionKey(p), title: "Nhóm mới", blocks: [] }] }))}
          >
            <Plus /> Thêm nhóm
          </Button>
          <span className="text-xs text-muted-foreground">
            {schema.sections.length}/{PAGE_MAX_SECTIONS} nhóm · {total}/{PAGE_MAX_BLOCKS} khối
          </span>
        </div>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !pending && !o && setConfirm(null)}>
        <AlertDialogContent>
          {confirm === "archive" ? (
            <AlertDialogHeader>
              <AlertDialogTitle>Lưu trữ «{pageName}»?</AlertDialogTitle>
              <AlertDialogDescription>Trang rời menu và không mở được ở {pageHref(slug)} từ lần tải kế tiếp. Nội dung và lịch sử phiên bản được giữ lại.</AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <AlertDialogHeader>
              <AlertDialogTitle>Xuất bản «{pageName}»?</AlertDialogTitle>
              <AlertDialogDescription>
                Người dùng thấy bản này ở LẦN TẢI KẾ TIẾP của {pageHref(slug)} — không cần deploy. {publishedVersion > 0 ? `Bản đang xuất bản (phiên bản ${publishedVersion}) được giữ trong lịch sử phiên bản.` : "Đây là lần xuất bản đầu tiên — sau lần này đường dẫn bị khoá."} Máy chủ kiểm lại cấu hình; có lỗi thì không xuất bản gì.
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                if (confirm === "archive") run(() => archivePageAction(pageId), `Đã lưu trữ «${pageName}».`);
                else run(() => publishPageAction(pageId), `Đã xuất bản «${pageName}» — người dùng thấy ở lần tải kế tiếp.`);
              }}
            >
              {confirm === "archive" ? "Lưu trữ" : "Xuất bản"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
