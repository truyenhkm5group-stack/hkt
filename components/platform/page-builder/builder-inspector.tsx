"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Columns3, Copy, LogOut, Trash2 } from "lucide-react";
import { SELECT_CLASS } from "@/components/platform/metadata/bits";
import { BlockConfigForm } from "@/components/platform/pages/block-config-form";
import { PathErrors } from "@/components/platform/pages/path-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { BLOCK_TYPE_HINT, BLOCK_TYPE_LABEL, SPAN_LABEL, type FilterTargetOption, type PageEditorCatalog, type PageMetaOptions, type PagePathError } from "@/lib/platform-ui/page-admin-shared";
import {
  childrenOf,
  endOfSection,
  inspectorTabsOf,
  isColumn,
  locate,
  sectionVariant,
  slotOutOfColumn,
  stepSlot,
  totalBlocks,
  type BuilderErrors,
  type BuilderOp,
} from "@/lib/platform-ui/page-builder-ops";
import { BLOCK_SPANS, PAGE_MAX_BLOCKS, PAGE_MAX_SECTIONS, type BlockType, type PageBlock, type PageSchema } from "@/lib/pages/types";
import { cn } from "@/lib/utils";
import type { Selection } from "./builder-canvas";

/**
 * ═══════════ KHUNG THUỘC TÍNH (cột phải) ═══════════
 *
 * Ba tab — Dữ liệu · Hành động · Hiển thị — trên MỘT form cấu hình dùng chung với trình soạn bàn phím
 * (`BlockConfigForm`, chia bằng `part`). Mọi thao tác kéo-thả trên khung đều có NÚT tương đương ở đây (lên / xuống /
 * chuyển nhóm / ra khỏi cột / độ rộng / nhân bản / xoá) — dùng được hoàn toàn bằng bàn phím.
 */

type Props = {
  schema: PageSchema;
  catalog: PageEditorCatalog;
  options: PageMetaOptions;
  selection: Selection;
  errors: BuilderErrors;
  /** Lỗi của lượt XEM TRƯỚC khối (đường dẫn tính TỪ KHỐI, vd `config.aggregate.field`). */
  previewIssues: Record<string, PagePathError[]>;
  /** Khối trên trang nhận được bộ lọc — khối Bộ lọc chọn đích trong đó. */
  filterTargets: FilterTargetOption[];
  notes: PagePathError[];
  onOp: (op: BuilderOp, key?: string) => void;
  onSelect: (s: Selection) => void;
};

const LABEL = "grid gap-1 text-xs font-medium text-muted-foreground";

export function BuilderInspector(props: Props) {
  const { schema, selection } = props;
  if (selection?.kind === "block") {
    const p = locate(schema, selection.id);
    const block = p ? (p.child === null ? schema.sections[p.section].blocks[p.index] : childrenOf(schema.sections[p.section].blocks[p.index])[p.child]) : null;
    if (block && p) return <BlockPanel {...props} block={block} section={p.section} inColumn={p.child !== null} />;
  }
  if (selection?.kind === "section") {
    const si = schema.sections.findIndex((s) => s.key === selection.key);
    if (si >= 0) return <SectionPanel {...props} index={si} />;
  }
  return <PagePanel {...props} />;
}

function PagePanel({ schema, errors, notes, onSelect }: Props) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">Chọn một khối hoặc một nhóm trên khung để sửa. Mọi khối cũng chọn được từ dàn trang dưới đây (bàn phím).</p>
      <p className="text-xs text-muted-foreground">
        {schema.sections.length}/{PAGE_MAX_SECTIONS} nhóm · {totalBlocks(schema)}/{PAGE_MAX_BLOCKS} khối
      </p>
      <PathErrors errors={errors.general} />
      <PathErrors errors={notes} tone="warning" />
      <ol className="space-y-1.5" aria-label="Dàn trang">
        {schema.sections.map((s, si) => (
          <li key={s.key}>
            <button type="button" className="text-[13px] font-semibold hover:underline" onClick={() => onSelect({ kind: "section", key: s.key })}>
              {sectionVariant(s) === "plain" ? "Hàng" : s.title || `Nhóm ${si + 1}`}
            </button>
            <ul className="ml-3 mt-0.5 space-y-0.5 border-l pl-2">
              {s.blocks.map((b) => (
                <li key={b.id}>
                  <OutlineItem block={b} errors={errors} onSelect={onSelect} />
                  {childrenOf(b).length ? (
                    <ul className="ml-3 border-l pl-2">
                      {childrenOf(b).map((c) => (
                        <li key={c.id}>
                          <OutlineItem block={c} errors={errors} onSelect={onSelect} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function OutlineItem({ block, errors, onSelect }: { block: PageBlock; errors: BuilderErrors; onSelect: (s: Selection) => void }) {
  const n = errors.block[block.id]?.length ?? 0;
  return (
    <button type="button" className="flex w-full items-center gap-1.5 text-left text-xs hover:underline" onClick={() => onSelect({ kind: "block", id: block.id })}>
      <span className="truncate">{block.title || (BLOCK_TYPE_LABEL[block.type as BlockType] ?? "Cột")}</span>
      <code className="font-mono text-[10.5px] text-muted-foreground">{block.id}</code>
      {n ? <span className="ml-auto rounded-full bg-destructive/10 px-1.5 text-[10.5px] font-semibold text-destructive">{n}</span> : null}
    </button>
  );
}

function SectionPanel({ schema, errors, onOp, onSelect, index }: Props & { index: number }) {
  const s = schema.sections[index];
  const plain = sectionVariant(s) === "plain";
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold">{plain ? "Hàng" : "Nhóm"}</p>
        <Button variant="ghost" size="xs" onClick={() => onSelect(null)}>
          Dàn trang
        </Button>
      </div>
      <PathErrors errors={errors.section[s.key] ?? []} />
      <div className="inline-flex rounded-full bg-muted p-0.5 text-xs" role="radiogroup" aria-label="Kiểu nhóm">
        {(["card", "plain"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={sectionVariant(s) === v}
            className={sectionVariant(s) === v ? "rounded-full bg-background px-2.5 py-1 font-medium shadow-sm" : "rounded-full px-2.5 py-1 text-muted-foreground"}
            onClick={() => sectionVariant(s) !== v && onOp({ kind: "setSectionVariant", index, variant: v })}
          >
            {v === "card" ? "Nhóm (có khung, tiêu đề)" : "Hàng (không khung)"}
          </button>
        ))}
      </div>
      {plain ? (
        <p className="text-xs text-muted-foreground">Hàng không có khung và tiêu đề — các khối xếp lưới 12 cột.</p>
      ) : (
        <label className={LABEL}>
          Tiêu đề nhóm
          <Input className="h-8" value={s.title ?? ""} maxLength={80} placeholder={`Nhóm ${index + 1} (không tiêu đề)`} onChange={(e) => onOp({ kind: "patchSection", index, title: e.target.value || undefined }, `section-title:${s.key}`)} />
        </label>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="outline" size="xs" disabled={index === 0} onClick={() => onOp({ kind: "moveSection", from: index, to: index - 1 })}>
          <ArrowUp /> Lên
        </Button>
        <Button variant="outline" size="xs" disabled={index >= schema.sections.length - 1} onClick={() => onOp({ kind: "moveSection", from: index, to: index + 1 })}>
          <ArrowDown /> Xuống
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={schema.sections.length <= 1}
          title={schema.sections.length <= 1 ? "Trang cần ít nhất một nhóm" : "Xoá nhóm và mọi khối trong nhóm (hoàn tác được)"}
          onClick={() => {
            onOp({ kind: "removeSection", index });
            onSelect(null);
          }}
        >
          <Trash2 /> Xoá nhóm
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{s.blocks.length} khối — bấm một mục ở thư viện để thêm vào cuối nhóm này.</p>
    </div>
  );
}

function BlockPanel(props: Props & { block: PageBlock; section: number; inColumn: boolean }) {
  const { schema, catalog, options, block: b, section, inColumn, errors, onOp, onSelect } = props;
  const tabs = inspectorTabsOf(b.type);
  const errs = errors.block[b.id] ?? [];
  const up = stepSlot(schema, b.id, -1);
  const down = stepSlot(schema, b.id, 1);
  const out = slotOutOfColumn(schema, b.id);
  const label = BLOCK_TYPE_LABEL[b.type as BlockType] ?? "Cột";
  const [tab, setTab] = React.useState<string>(tabs.data ? "data" : tabs.actions ? "actions" : "display");
  const current = (tab === "data" && !tabs.data) || (tab === "actions" && !tabs.actions) ? (tabs.data ? "data" : tabs.actions ? "actions" : "display") : tab;

  return (
    <div className="space-y-3 text-sm" data-inspector={b.id}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{label}</p>
          <p className="text-[11.5px] text-muted-foreground" title={BLOCK_TYPE_HINT[b.type as BlockType]}>
            <code className="font-mono">{b.id}</code>
            {inColumn ? " · trong cột" : ""}
          </p>
        </div>
        <Button variant="ghost" size="xs" onClick={() => onSelect(null)}>
          Dàn trang
        </Button>
      </div>
      <PathErrors errors={errs} />
      {props.previewIssues[b.id]?.length ? (
        <div className="rounded-md bg-amber-500/10 p-2 text-xs">
          <p className="font-medium">Xem trước chưa dựng được khối này:</p>
          <PathErrors errors={props.previewIssues[b.id]} tone="warning" />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1" role="group" aria-label="Thao tác với khối">
        <Button variant="outline" size="icon-xs" aria-label="Đưa khối lên" title="Lên" disabled={!up} onClick={() => up && onOp({ kind: "moveBlock", id: b.id, to: up })}>
          <ArrowUp />
        </Button>
        <Button variant="outline" size="icon-xs" aria-label="Đưa khối xuống" title="Xuống" disabled={!down} onClick={() => down && onOp({ kind: "moveBlock", id: b.id, to: down })}>
          <ArrowDown />
        </Button>
        {schema.sections.length > 1 && !inColumn ? (
          <select
            className={cn(SELECT_CLASS, "h-6 text-xs")}
            aria-label="Chuyển sang nhóm"
            value={section}
            onChange={(e) => {
              const target = Number(e.target.value);
              if (target !== section) onOp({ kind: "moveBlock", id: b.id, to: endOfSection(schema, target) });
            }}
          >
            {schema.sections.map((s, i) => (
              <option key={s.key} value={i}>
                {sectionVariant(s) === "plain" ? `Hàng ${i + 1}` : s.title || `Nhóm ${i + 1}`}
              </option>
            ))}
          </select>
        ) : null}
        {out ? (
          <Button variant="outline" size="xs" onClick={() => onOp({ kind: "moveBlock", id: b.id, to: out })}>
            <LogOut /> Ra khỏi cột
          </Button>
        ) : null}
        {!inColumn && !isColumn(b) ? (
          <Button variant="outline" size="xs" title="Bọc khối vào một cột mới (xếp dọc thêm khối khác)" onClick={() => onOp({ kind: "wrapInColumn", id: b.id })}>
            <Columns3 /> Bọc vào cột
          </Button>
        ) : null}
        <Button variant="outline" size="icon-xs" aria-label="Nhân bản khối" title="Nhân bản" onClick={() => onOp({ kind: "duplicateBlock", id: b.id })}>
          <Copy />
        </Button>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Xoá khối"
          title="Xoá (hoàn tác được)"
          onClick={() => {
            onOp({ kind: "removeBlock", id: b.id });
            onSelect(null);
          }}
        >
          <Trash2 />
        </Button>
      </div>

      <Tabs value={current} onValueChange={setTab}>
        <TabsList className="w-full">
          <TabsTrigger value="data" disabled={!tabs.data}>
            Dữ liệu
          </TabsTrigger>
          <TabsTrigger value="actions" disabled={!tabs.actions}>
            Hành động
          </TabsTrigger>
          <TabsTrigger value="display">Hiển thị</TabsTrigger>
        </TabsList>
        <TabsContent value="data" className="pt-2">
          {tabs.data ? <BlockConfigForm part="data" block={b} catalog={catalog} filterTargets={props.filterTargets} onChange={(config) => onOp({ kind: "patchBlock", id: b.id, patch: { config } }, `config:${b.id}`)} /> : null}
        </TabsContent>
        <TabsContent value="actions" className="pt-2">
          {tabs.actions ? <BlockConfigForm part="actions" block={b} catalog={catalog} onChange={(config) => onOp({ kind: "patchBlock", id: b.id, patch: { config } }, `config:${b.id}`)} /> : null}
        </TabsContent>
        <TabsContent value="display" className="space-y-3 pt-2">
          <label className={LABEL}>
            Tiêu đề khối
            <Input className="h-8" value={b.title ?? ""} maxLength={80} placeholder="(không tiêu đề)" onChange={(e) => onOp({ kind: "patchBlock", id: b.id, patch: { title: e.target.value || undefined } }, `title:${b.id}`)} />
          </label>
          <label className={LABEL}>
            Độ rộng
            <select className={SELECT_CLASS} value={b.span} disabled={inColumn} title={inColumn ? "Khối trong cột rộng hết cột" : undefined} onChange={(e) => onOp({ kind: "setSpan", id: b.id, span: Number(e.target.value) })}>
              {BLOCK_SPANS.map((n) => (
                <option key={n} value={n}>
                  {SPAN_LABEL[n]}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Khoá khối (nút thao tác tra lại cấu hình theo khoá này)
            <Input
              className="h-8 font-mono text-[12.5px]"
              value={b.id}
              maxLength={41}
              onChange={(e) => onOp({ kind: "patchBlock", id: b.id, patch: { id: e.target.value.toLowerCase() } })}
            />
          </label>
          <label className={LABEL}>
            Chỉ hiện với người có quyền
            <select
              className={SELECT_CLASS}
              value={b.visibility?.permission ?? ""}
              onChange={(e) => onOp({ kind: "patchBlock", id: b.id, patch: { visibility: { ...b.visibility, permission: e.target.value || undefined } } })}
            >
              <option value="">Mọi người xem được trang</option>
              {options.permissions.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            Chỉ hiện khi module bật
            <select
              className={SELECT_CLASS}
              value={b.visibility?.module ?? ""}
              onChange={(e) => onOp({ kind: "patchBlock", id: b.id, patch: { visibility: { ...b.visibility, module: (e.target.value || undefined) as ModuleKey | undefined } } })}
            >
              <option value="">Luôn hiện</option>
              {options.modules.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[11.5px] text-muted-foreground">Ẩn / hiện chỉ là giao diện — mỗi khối vẫn tự kiểm quyền và module của NGƯỜI XEM khi lấy dữ liệu.</p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
