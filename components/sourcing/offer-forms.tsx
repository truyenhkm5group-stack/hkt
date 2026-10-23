"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addSourcingSnapshotAction,
  createSourcingOfferAction,
  setSourcingOfferArchivedAction,
  updateSourcingOfferAction,
  updateSourcingSupplierAction,
  type SourcingOfferResult,
} from "@/lib/actions/sourcing-offers";
import { SOURCING_PLATFORM_LABEL, SOURCING_PRICE_TIERS_MAX } from "@/lib/constants/sourcing";
import { parseOfferUrl } from "@/lib/sourcing/offer-url";
import { formatCny, parseCnyInput } from "@/lib/sourcing/price";

type TierRow = { fromQty: string; price: string };

function useAction() {
  const [pending, start] = useTransition();
  const [duplicateOfId, setDuplicateOfId] = useState<string | null>(null);
  const run = (fn: () => Promise<SourcingOfferResult>, onOk?: (r: Extract<SourcingOfferResult, { ok: true }>) => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setDuplicateOfId(null);
        toast.success(r.message);
        onOk?.(r);
      } else {
        setDuplicateOfId(r.duplicateOfId ?? null);
        toast.error(r.errors[0]?.message ?? "Không lưu được.");
      }
    });
  return { pending, run, duplicateOfId };
}

/** Ô số nguyên: trống / sai ⇒ `null`, không bao giờ 0. */
function intOrNull(raw: string): number | null {
  const v = raw.trim();
  return /^\d{1,8}$/.test(v) ? Number(v) : null;
}

function TierEditor({ rows, setRows }: { rows: TierRow[]; setRows: (r: TierRow[]) => void }) {
  const set = (i: number, patch: Partial<TierRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2" data-tier-editor>
      <Label>Bậc giá (mua từ … cái trở lên thì mỗi cái …)</Label>
      {rows.map((r, i) => {
        const fen = r.price.trim() ? parseCnyInput(r.price) : null;
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Từ</span>
            <Input className="w-24" inputMode="numeric" aria-label={`Bậc ${i + 1}: số lượng từ`} value={r.fromQty} onChange={(e) => set(i, { fromQty: e.target.value })} />
            <span className="text-xs text-muted-foreground">cái · giá ¥</span>
            <Input className="w-28" inputMode="decimal" aria-label={`Bậc ${i + 1}: giá tệ`} placeholder="12.30" value={r.price} onChange={(e) => set(i, { price: e.target.value })} />
            <span className="w-20 text-xs tabular-nums text-muted-foreground">{r.price.trim() ? (fen === null ? "không đọc được" : formatCny(fen)) : ""}</span>
            {rows.length > 1 ? (
              <Button type="button" size="icon" variant="ghost" aria-label={`Xoá bậc ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
        );
      })}
      {rows.length < SOURCING_PRICE_TIERS_MAX ? (
        <Button type="button" size="sm" variant="outline" onClick={() => setRows([...rows, { fromQty: "", price: "" }])}>
          <Plus className="size-4" />
          Thêm bậc
        </Button>
      ) : null}
    </div>
  );
}

function SnapshotFields({ tiers, setTiers, moq, setMoq, colors, setColors, sizes, setSizes }: { tiers: TierRow[]; setTiers: (r: TierRow[]) => void; moq: string; setMoq: (v: string) => void; colors: string; setColors: (v: string) => void; sizes: string; setSizes: (v: string) => void }) {
  return (
    <div className="space-y-3">
      <TierEditor rows={tiers} setRows={setTiers} />
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="src-moq">MOQ (số lượng tối thiểu)</Label>
          <Input id="src-moq" inputMode="numeric" placeholder="chưa khai" value={moq} onChange={(e) => setMoq(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="src-colors">Màu (cách nhau bằng dấu phẩy)</Label>
          <Input id="src-colors" placeholder="黑色 / đen, 白色 / trắng" value={colors} onChange={(e) => setColors(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="src-sizes">Cỡ</Label>
          <Input id="src-sizes" placeholder="M, L, XL, 2XL" value={sizes} onChange={(e) => setSizes(e.target.value)} />
        </div>
      </div>
    </div>
  );
}

const snapshotPayload = (tiers: TierRow[], moq: string, colors: string, sizes: string) => ({
  // Số lượng trống / sai ⇒ 0 để máy chủ báo đúng bậc sai (≥ 1), không âm thầm bỏ bậc.
  tiers: tiers.map((t) => ({ fromQty: intOrNull(t.fromQty) ?? 0, price: t.price })),
  moq: intOrNull(moq),
  colors,
  sizes,
});

export function CreateOfferForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [titleVi, setTitleVi] = useState("");
  const [titleZh, setTitleZh] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [shopUrl, setShopUrl] = useState("");
  const [shopName, setShopName] = useState("");
  const [tiers, setTiers] = useState<TierRow[]>([{ fromQty: "", price: "" }]);
  const [moq, setMoq] = useState("");
  const [colors, setColors] = useState("");
  const [sizes, setSizes] = useState("");
  const { pending, run, duplicateOfId } = useAction();
  const link = useMemo(() => (url.trim() ? parseOfferUrl(url) : null), [url]);
  const save = () =>
    run(
      () => createSourcingOfferAction({ url, titleVi, titleZh, imageUrl, supplierShopUrl: shopUrl, supplierName: shopName, ...snapshotPayload(tiers, moq, colors, sizes) }),
      (r) => router.push(`/sourcing/offers/${r.id}`),
    );
  return (
    <div className="space-y-4 text-sm" data-create-offer-form>
      <div className="space-y-1">
        <Label htmlFor="src-url">Link sản phẩm *</Label>
        <Input id="src-url" placeholder="https://detail.1688.com/offer/….html" value={url} onChange={(e) => setUrl(e.target.value)} />
        <p className="text-xs text-muted-foreground" data-link-preview>
          {!url.trim()
            ? "ERP chỉ ĐỌC chữ của link (nền tảng, mã sản phẩm) — không mở link, không lấy dữ liệu từ trang."
            : link
              ? `${SOURCING_PLATFORM_LABEL[link.platform]} · ${link.offerId ? `mã ${link.offerId}` : "không đọc ra mã — chống trùng theo link"} · ${link.canonicalUrl}`
              : "Link không đọc được — cần link http(s)."}
        </p>
        {duplicateOfId ? (
          <p className="text-xs">
            <Link className="font-medium text-primary underline" href={`/sourcing/offers/${duplicateOfId}`}>
              Mở mẫu đã có
            </Link>
          </p>
        ) : null}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="src-title-vi">Tên tiếng Việt *</Label>
          <Input id="src-title-vi" value={titleVi} maxLength={200} onChange={(e) => setTitleVi(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="src-title-zh">Tên trên trang nguồn (tiếng Trung)</Label>
          <Input id="src-title-zh" lang="zh-CN" value={titleZh} maxLength={300} onChange={(e) => setTitleZh(e.target.value)} />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="src-image">Link ảnh (chuột phải vào ảnh ⇒ chép địa chỉ ảnh)</Label>
          <Input id="src-image" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="src-shop">Link shop nhà cung cấp</Label>
          <Input id="src-shop" placeholder="https://<shop>.1688.com" value={shopUrl} onChange={(e) => setShopUrl(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="src-shop-name">Tên nhà cung cấp</Label>
          <Input id="src-shop-name" value={shopName} maxLength={200} onChange={(e) => setShopName(e.target.value)} />
        </div>
      </div>
      <SnapshotFields tiers={tiers} setTiers={setTiers} moq={moq} setMoq={setMoq} colors={colors} setColors={setColors} sizes={sizes} setSizes={setSizes} />
      <Button disabled={pending || !link} onClick={save}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Lưu vào kho mẫu
      </Button>
    </div>
  );
}

export function AddSnapshotForm({ offerId, initial }: { offerId: string; initial: { tiers: TierRow[]; moq: string; colors: string; sizes: string } }) {
  const [tiers, setTiers] = useState<TierRow[]>(initial.tiers.length ? initial.tiers : [{ fromQty: "", price: "" }]);
  const [moq, setMoq] = useState(initial.moq);
  const [colors, setColors] = useState(initial.colors);
  const [sizes, setSizes] = useState(initial.sizes);
  const { pending, run } = useAction();
  return (
    <div className="space-y-3 text-sm" data-add-snapshot-form>
      <p className="text-xs text-muted-foreground">Điền sẵn theo lần chụp gần nhất — sửa cho đúng trang nguồn HÔM NAY rồi lưu. Lần chụp cũ giữ nguyên trong lịch sử.</p>
      <SnapshotFields tiers={tiers} setTiers={setTiers} moq={moq} setMoq={setMoq} colors={colors} setColors={setColors} sizes={sizes} setSizes={setSizes} />
      <Button disabled={pending} onClick={() => run(() => addSourcingSnapshotAction({ offerId, ...snapshotPayload(tiers, moq, colors, sizes) }))}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Lưu lần chụp giá mới
      </Button>
    </div>
  );
}

export function EditOfferForm({ offerId, initial }: { offerId: string; initial: { titleVi: string; titleZh: string; imageUrl: string; shopUrl: string; shopName: string } }) {
  const [v, setV] = useState(initial);
  const { pending, run } = useAction();
  const field = (k: keyof typeof v, label: string, extra: { lang?: string; placeholder?: string } = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`src-edit-${k}`}>{label}</Label>
      <Input id={`src-edit-${k}`} {...extra} value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} />
    </div>
  );
  return (
    <div className="space-y-3 text-sm" data-edit-offer-form>
      <div className="grid gap-3 md:grid-cols-2">
        {field("titleVi", "Tên tiếng Việt *")}
        {field("titleZh", "Tên tiếng Trung", { lang: "zh-CN" })}
        {field("imageUrl", "Link ảnh")}
        {field("shopUrl", "Link shop nhà cung cấp", { placeholder: "https://<shop>.1688.com" })}
        {field("shopName", "Tên nhà cung cấp")}
      </div>
      <Button
        disabled={pending}
        onClick={() => run(() => updateSourcingOfferAction({ offerId, titleVi: v.titleVi, titleZh: v.titleZh, imageUrl: v.imageUrl, supplierShopUrl: v.shopUrl, supplierName: v.shopName }))}
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Lưu thay đổi
      </Button>
    </div>
  );
}

export function SupplierFactsForm({
  offerId,
  supplierId,
  initial,
}: {
  offerId: string;
  supplierId: string;
  initial: { name: string; years: string; rating: string; responseRate: string; verified: "" | "yes" | "no"; shipFrom: string; factsAsOf: string };
}) {
  const [v, setV] = useState(initial);
  const { pending, run } = useAction();
  const text = (k: Exclude<keyof typeof v, "verified">, label: string, extra: { placeholder?: string; type?: string; inputMode?: "numeric" | "decimal" } = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`src-sup-${k}`}>{label}</Label>
      <Input id={`src-sup-${k}`} placeholder="chưa khai" {...extra} value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} />
    </div>
  );
  return (
    <div className="space-y-3 text-sm" data-supplier-facts-form>
      <div className="grid gap-3 md:grid-cols-3">
        {text("name", "Tên nhà cung cấp", { placeholder: "" })}
        {text("years", "Số năm trên nền tảng", { inputMode: "numeric" })}
        {text("rating", "Điểm đánh giá (0–5)", { inputMode: "decimal" })}
        {text("responseRate", "Tỷ lệ phản hồi (%)", { inputMode: "decimal" })}
        <div className="space-y-1">
          <Label htmlFor="src-sup-verified">Đã xác minh</Label>
          <select
            id="src-sup-verified"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={v.verified}
            onChange={(e) => setV((x) => ({ ...x, verified: e.target.value as "" | "yes" | "no" }))}
          >
            <option value="">chưa khai</option>
            <option value="yes">có</option>
            <option value="no">không</option>
          </select>
        </div>
        {text("shipFrom", "Gửi hàng từ")}
        {text("factsAsOf", "Ngày xem số liệu", { type: "date" })}
      </div>
      <p className="text-xs text-muted-foreground">Ô trống là CHƯA KHAI — khác 0. Ngày xem trống ⇒ hôm nay; quá ngưỡng thì số được gắn nhãn «cũ».</p>
      <Button
        disabled={pending}
        onClick={() =>
          run(
            () =>
              updateSourcingSupplierAction({
                supplierId,
                offerId,
                name: v.name,
                yearsOnPlatform: intOrNull(v.years),
                rating: v.rating,
                responseRate: v.responseRate,
                verified: v.verified === "" ? null : v.verified === "yes",
                shipFrom: v.shipFrom,
                factsAsOf: v.factsAsOf,
              }),
          )
        }
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Lưu thông tin nhà cung cấp
      </Button>
    </div>
  );
}

export function ArchiveOfferForm({ offerId, archived }: { offerId: string; archived: boolean }) {
  const [reason, setReason] = useState("");
  const { pending, run } = useAction();
  return (
    <div className="grid gap-3 text-sm md:grid-cols-[1fr_auto] md:items-end" data-archive-offer-form>
      <div className="space-y-1">
        <Label htmlFor="src-archive-reason">Lý do *</Label>
        <Input id="src-archive-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button variant={archived ? "default" : "outline"} disabled={pending} onClick={() => run(() => setSourcingOfferArchivedAction({ offerId, archived: !archived, reason }))}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {archived ? "Khôi phục mẫu" : "Lưu trữ mẫu"}
      </Button>
    </div>
  );
}
