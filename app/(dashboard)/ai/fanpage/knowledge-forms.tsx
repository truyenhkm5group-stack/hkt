"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { saveFanpageSalesProfile, saveSizeRule } from "@/lib/actions/fanpage-sales";
import { FACT_CATEGORIES, FACT_CATEGORY_LABEL, type ApprovedFact, type FactCategory } from "@/lib/constants/approved-facts";
import { EMPTY_SALES_POLICY, EXCHANGE_KIND_LABEL, SHIP_PAYERS, SHIP_PAYER_LABEL, type ExchangeBranch, type SalesPolicy, type ShipPayer } from "@/lib/constants/sales-policy";
import { FABRIC_STRETCH, type SizeRow } from "@/lib/constants/size-engine";

const O = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs";

/**
 * BẢNG SỐ ĐO — ghi thẳng vào máy gợi ý size của ERP.
 *
 * Bày sẵn ĐÚNG những size danh mục đang bán, để người khai không phải nhớ và không gõ ra một size
 * shop không có. Ô nào để trống thì chiều đó KHÔNG ràng buộc — khác hẳn với 0.
 */
export function SizeRuleForm({
  productCode,
  scope,
  sizes,
  current,
  currentVersion,
  fabricStretch,
}: {
  productCode: string;
  scope: "PRODUCT" | "FAMILY";
  sizes: string[];
  current: SizeRow[];
  currentVersion: string;
  fabricStretch: string;
}) {
  const [rows, setRows] = useState<SizeRow[]>(
    current.length ? current : sizes.map((size) => ({ size })),
  );
  const [ver, setVer] = useState(currentVersion || `${productCode.toLowerCase()}-${new Date().toISOString().slice(0, 7)}`);
  const [vai, setVai] = useState(fabricStretch || "MEDIUM");
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();

  const doi = (i: number, key: keyof SizeRow, lo: string, hi: string) => {
    setRows((r) => {
      const n = [...r];
      const a = Number(lo);
      const b = Number(hi);
      // Chỉ ghi khoảng khi CẢ HAI đầu là số. Một đầu trống nghĩa là người khai chưa gõ xong, chứ
      // không phải "từ 0" — đọc nó thành [0, x] là dựng ra một luật không ai khai.
      if (Number.isFinite(a) && Number.isFinite(b) && lo !== "" && hi !== "") (n[i] as Record<string, unknown>)[key] = [a, b];
      else delete (n[i] as Record<string, unknown>)[key];
      return n;
    });
  };
  const val = (r: SizeRow, key: keyof SizeRow, idx: 0 | 1) => {
    const v = r[key];
    return Array.isArray(v) ? String(v[idx]) : "";
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Ghi vào máy gợi ý size của ERP (<code className="font-mono">settings[&quot;ai.sizeRules&quot;]</code>) — cùng bảng mà công cụ{" "}
        <code className="font-mono">size.recommend</code> đọc. Ô trống = chiều đó KHÔNG ràng buộc, không phải bằng 0. Máy chỉ tư vấn khi
        ĐÚNG MỘT size khớp; rơi vào hai size thì nó chuyển người chứ không chọn bừa.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Tên phiên bản bảng</span>
          <input className={O} value={ver} onChange={(e) => setVer(e.target.value)} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Độ co giãn của vải</span>
          <select className={O} value={vai} onChange={(e) => setVai(e.target.value)}>
            {FABRIC_STRETCH.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Áp cho</span>
          <input className={`${O} opacity-60`} value={`${scope === "PRODUCT" ? "mã hàng" : "mã test"} ${productCode}`} readOnly />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="p-1">Size</th>
              <th className="p-1">Cao (cm)</th>
              <th className="p-1">Nặng (kg)</th>
              <th className="p-1">Ngực (cm)</th>
              <th className="p-1">Eo (cm)</th>
              <th className="p-1">Mông (cm)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.size || i}>
                <td className="p-1 font-medium">{r.size}</td>
                {(["heightCm", "weightKg", "bustCm", "waistCm", "hipCm"] as const).map((key) => (
                  <td key={key} className="p-1">
                    <div className="flex items-center gap-1">
                      <input
                        className="h-8 w-14 rounded-md border border-input bg-background px-1 text-center text-xs"
                        inputMode="numeric"
                        defaultValue={val(r, key, 0)}
                        placeholder="—"
                        onChange={(e) => doi(i, key, e.target.value, val(rows[i], key, 1) || (document.getElementById(`hi-${i}-${key}`) as HTMLInputElement)?.value || "")}
                      />
                      <span className="text-muted-foreground">–</span>
                      <input
                        id={`hi-${i}-${key}`}
                        className="h-8 w-14 rounded-md border border-input bg-background px-1 text-center text-xs"
                        inputMode="numeric"
                        defaultValue={val(r, key, 1)}
                        placeholder="—"
                        onChange={(e) => doi(i, key, val(rows[i], key, 0) || "", e.target.value)}
                      />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveSizeRule({ key: productCode, scope, version: ver, fabricStretch: vai, rows: rows.filter((x) => x.size) });
              setMsg("error" in r ? r.error : "Đã ghi bảng số đo — máy bắt đầu tư vấn được size cho mẫu này");
            })
          }
        >
          {pending ? "Đang ghi…" : "Lưu bảng số đo"}
        </Button>
        {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
      </div>
    </div>
  );
}

/** CHÍNH SÁCH ĐỔI TRẢ — từng nhánh một, vì khách hỏi từng nhánh một. */
export function PolicyForm({ pancakePageId, current }: { pancakePageId: string; current: SalesPolicy }) {
  const [p, setP] = useState<SalesPolicy>(current ?? EMPTY_SALES_POLICY);
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();

  const nhanh = (b: ExchangeBranch, set: (v: ExchangeBranch) => void, ten: string) => (
    <div className="grid gap-2 rounded-md border p-2 sm:grid-cols-5">
      <div className="text-xs font-medium sm:col-span-5">{ten}</div>
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">Có hỗ trợ?</span>
        <select
          className={O}
          value={b.allowed === null ? "" : b.allowed ? "yes" : "no"}
          onChange={(e) => set({ ...b, allowed: e.target.value === "" ? null : e.target.value === "yes" })}
        >
          <option value="">— chưa khai —</option>
          <option value="yes">Có</option>
          <option value="no">Không hỗ trợ</option>
        </select>
      </label>
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">Số ngày</span>
        <input
          className={O}
          inputMode="numeric"
          value={b.days === null ? "" : String(b.days)}
          onChange={(e) => set({ ...b, days: e.target.value.trim() === "" ? null : Number(e.target.value.replace(/\D/g, "")) })}
        />
      </label>
      <label className="space-y-1 text-xs sm:col-span-2">
        <span className="text-muted-foreground">Điều kiện</span>
        <input className={O} value={b.conditions} onChange={(e) => set({ ...b, conditions: e.target.value })} placeholder="còn nguyên tem, chưa giặt" />
      </label>
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">Phí ship đổi</span>
        <select className={O} value={b.shipPayer} onChange={(e) => set({ ...b, shipPayer: e.target.value as ShipPayer })}>
          {SHIP_PAYERS.map((x) => <option key={x} value={x}>{SHIP_PAYER_LABEL[x]}</option>)}
        </select>
      </label>
    </div>
  );

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Nhánh nào để <span className="font-medium">— chưa khai —</span> thì CHỈ câu hỏi ấy phải chuyển người. Chọn{" "}
        <span className="font-medium">Không hỗ trợ</span> cũng là một câu trả lời đầy đủ — máy nói được &quot;bên em chưa nhận đổi&quot;.
      </p>
      {nhanh(p.exchange.SIZE, (v) => setP({ ...p, exchange: { ...p.exchange, SIZE: v } }), EXCHANGE_KIND_LABEL.SIZE)}
      {nhanh(p.exchange.COLOR, (v) => setP({ ...p, exchange: { ...p.exchange, COLOR: v } }), EXCHANGE_KIND_LABEL.COLOR)}
      {nhanh(p.exchange.PRODUCT, (v) => setP({ ...p, exchange: { ...p.exchange, PRODUCT: v } }), EXCHANGE_KIND_LABEL.PRODUCT)}
      {nhanh(p.shopFault, (v) => setP({ ...p, shopFault: v }), "Hàng lỗi do shop")}
      {nhanh(p.refund, (v) => setP({ ...p, refund: v }), "Trả hàng hoàn tiền")}
      <label className="space-y-1 text-xs">
        <span className="text-muted-foreground">Trường hợp KHÔNG hỗ trợ (mỗi dòng một trường hợp)</span>
        <textarea
          className="min-h-16 w-full rounded-md border border-input bg-background p-2 text-xs"
          value={p.notSupported.join("\n")}
          onChange={(e) => setP({ ...p, notSupported: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })}
          placeholder={"Hàng đã giặt\nHàng đã cắt mác"}
        />
      </label>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveFanpageSalesProfile({ pancakePageId, exchangePolicy: p });
              setMsg("error" in r ? r.error : "Đã lưu — hội thoại MỚI dùng chính sách này, hội thoại cũ giữ bản cũ");
            })
          }
        >
          {pending ? "Đang lưu…" : "Lưu chính sách"}
        </Button>
        {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
      </div>
    </div>
  );
}

/** CÂU DỮ KIỆN ĐÃ DUYỆT — có nhóm, và người duyệt do MÁY CHỦ ghi (luật 34). */
export function FactsForm({ pancakePageId, current }: { pancakePageId: string; current: ApprovedFact[] }) {
  const [facts, setFacts] = useState<{ category: FactCategory; text: string }[]>(
    current.map((f) => ({ category: f.category, text: f.text })),
  );
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Máy chỉ được <span className="font-medium">diễn đạt lại</span> những câu ở đây — không được thêm một dữ kiện nào. Câu lưu xong sẽ
        mang tên tài khoản của bạn làm người duyệt; tên ấy do máy chủ ghi, không nhận từ màn hình.
      </p>
      {facts.map((f, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <select
            className={`${O} w-auto min-w-52`}
            value={f.category}
            onChange={(e) => setFacts((x) => x.map((y, j) => (j === i ? { ...y, category: e.target.value as FactCategory } : y)))}
          >
            {FACT_CATEGORIES.map((c) => <option key={c} value={c}>{FACT_CATEGORY_LABEL[c]}</option>)}
          </select>
          <input
            className={`${O} min-w-64 flex-1`}
            value={f.text}
            onChange={(e) => setFacts((x) => x.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)))}
            placeholder="Vải dày dặn, mặc không lộ"
          />
          <Button size="sm" variant="ghost" onClick={() => setFacts((x) => x.filter((_, j) => j !== i))}>Xoá</Button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => setFacts((x) => [...x, { category: "FAQ", text: "" }])}>+ Thêm câu</Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveFanpageSalesProfile({ pancakePageId, approvedFacts: facts.filter((f) => f.text.trim()) });
              setMsg("error" in r ? r.error : `Đã duyệt ${facts.filter((f) => f.text.trim()).length} câu`);
            })
          }
        >
          {pending ? "Đang lưu…" : "Lưu câu đã duyệt"}
        </Button>
        {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
      </div>
    </div>
  );
}
