"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { saveFanpageSalesProfile, saveSourceRule, deleteSourceRule } from "@/lib/actions/fanpage-sales";
import { FANPAGE_AI_MODES, SOURCE_TYPE_LABEL } from "@/lib/constants/fanpage-sales";

type Choice = { id: string; name: string; code: string };
type TestChoice = { id: string; testCode: string; name: string };

/**
 * Đổi mẫu thắng của một page. Việc HÀNG NGÀY phải làm được dưới một phút, nên bốn ô hay đổi nhất
 * — mẫu · giá · ship · nấc quyền — nằm ngay trên cùng.
 *
 * SỔ DỮ KIỆN nằm trong phần gập lại phía dưới: chính sách và câu đã duyệt gõ một lần rồi để đó
 * hàng tháng. Bày cả mười ô ra cùng lúc thì việc một phút thành việc mười phút, và người vận hành
 * sẽ thôi không mở màn này nữa — đó mới là cách một màn cấu hình chết thật sự.
 */
export function FanpageForm({
  pancakePageId,
  name,
  aiMode,
  activeProductId,
  unitPrice,
  shippingFee,
  colors,
  sizeProfileId,
  material,
  comboPrice,
  comboFreeShip,
  codPolicy,
  inspectionPolicy,
  deliveryEstimate,
  exchangePolicy,
  approvedFacts,
  choices,
  sizes,
}: {
  pancakePageId: string;
  name: string;
  aiMode: string;
  activeProductId: string | null;
  unitPrice: number | null;
  shippingFee: number | null;
  colors: string[];
  sizeProfileId: string | null;
  material: string;
  comboPrice: number | null;
  comboFreeShip: boolean;
  codPolicy: string;
  inspectionPolicy: string;
  deliveryEstimate: string;
  exchangePolicy: string;
  approvedFacts: string[];
  choices: Choice[];
  sizes: { id: string; name: string }[];
}) {
  const [sp, setSp] = useState(activeProductId ?? "");
  const [gia, setGia] = useState(unitPrice === null ? "" : String(unitPrice));
  const [ship, setShip] = useState(shippingFee === null ? "" : String(shippingFee));
  const [mau, setMau] = useState(colors.join(", "));
  const [nac, setNac] = useState(aiMode);
  const [ten, setTen] = useState(name);
  const [bangSize, setBangSize] = useState(sizeProfileId ?? "");
  const [chatLieu, setChatLieu] = useState(material);
  const [combo2, setCombo2] = useState(comboPrice === null ? "" : String(comboPrice));
  const [combo2Ship, setCombo2Ship] = useState(comboFreeShip);
  const [cod, setCod] = useState(codPolicy);
  const [kiem, setKiem] = useState(inspectionPolicy);
  const [giao, setGiao] = useState(deliveryEstimate);
  const [doiTra, setDoiTra] = useState(exchangePolicy);
  const [duKien, setDuKien] = useState(approvedFacts.join("\n"));
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();

  const so = (v: string) => (v.trim() === "" ? null : Number(v.replace(/\D/g, "")));

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Mẫu thắng đang chạy</span>
          <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={sp} onChange={(e) => setSp(e.target.value)}>
            <option value="">— chưa khai (máy sẽ chuyển người) —</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>{c.code ? `${c.code} · ` : ""}{c.name}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Giá bán (đ) — trống = chưa khai</span>
          <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={gia} onChange={(e) => setGia(e.target.value)} inputMode="numeric" placeholder="499000" />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Phí ship (đ)</span>
          <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={ship} onChange={(e) => setShip(e.target.value)} inputMode="numeric" placeholder="25000" />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Nấc quyền hạn</span>
          <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={nac} onChange={(e) => setNac(e.target.value)}>
            {FANPAGE_AI_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs sm:col-span-2">
          <span className="text-muted-foreground">Màu đang có (cách nhau dấu phẩy)</span>
          <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={mau} onChange={(e) => setMau(e.target.value)} placeholder="Đỏ đô, Đen, Nâu" />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Bảng số đo</span>
          <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={bangSize} onChange={(e) => setBangSize(e.target.value)}>
            <option value="">— chưa có (máy chuyển người khi khách hỏi size) —</option>
            {sizes.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Tên page</span>
          <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={ten} onChange={(e) => setTen(e.target.value)} />
        </label>
      </div>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-xs font-medium">Sổ dữ kiện — chất liệu, combo, chính sách, câu đã duyệt</summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Ô nào để trống thì máy KHÔNG trả lời câu hỏi tương ứng — nó chuyển người, chứ không đoán. Đây là danh sách việc phải khai,
          không phải danh sách tuỳ chọn.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Chất liệu</span>
            <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={chatLieu} onChange={(e) => setChatLieu(e.target.value)} placeholder="Rayon co giãn 4 chiều" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Giá combo 2 chiếc (đ)</span>
            <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={combo2} onChange={(e) => setCombo2(e.target.value)} inputMode="numeric" placeholder="849000" />
          </label>
          <label className="flex items-center gap-2 pt-5 text-xs">
            <input type="checkbox" checked={combo2Ship} onChange={(e) => setCombo2Ship(e.target.checked)} />
            <span>Combo 2 được miễn phí ship</span>
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Chính sách COD</span>
            <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={cod} onChange={(e) => setCod(e.target.value)} placeholder="Bên em có ship COD, nhận hàng rồi thanh toán" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Chính sách kiểm hàng</span>
            <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={kiem} onChange={(e) => setKiem(e.target.value)} placeholder="Chị được kiểm hàng trước khi thanh toán" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Thời gian giao dự kiến</span>
            <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={giao} onChange={(e) => setGiao(e.target.value)} placeholder="2–4 ngày" />
          </label>
          <label className="space-y-1 text-xs lg:col-span-2">
            <span className="text-muted-foreground">Chính sách đổi trả</span>
            <input className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={doiTra} onChange={(e) => setDoiTra(e.target.value)} placeholder="để trống nếu chủ shop chưa chốt" />
          </label>
          <label className="space-y-1 text-xs sm:col-span-2 lg:col-span-3">
            <span className="text-muted-foreground">Câu dữ kiện đã duyệt — mỗi dòng một câu. Máy chỉ được nói lại những câu này, không được thêm dữ kiện mới.</span>
            <textarea className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm" value={duKien} onChange={(e) => setDuKien(e.target.value)} placeholder={"Bên em bán hàng có sẵn, không đặt trước\nHàng bên em có video thật, không dùng ảnh mạng"} />
          </label>
        </div>
      </details>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveFanpageSalesProfile({
                pancakePageId,
                name: ten,
                aiMode: nac,
                activeProductId: sp || undefined,
                unitPrice: so(gia),
                shippingFee: so(ship),
                availableColors: mau.split(",").map((x) => x.trim()).filter(Boolean),
                sizeProfileId: bangSize || undefined,
                material: chatLieu,
                comboPricing: so(combo2) === null ? [] : [{ quantity: 2, price: so(combo2) as number, freeShipping: combo2Ship }],
                codPolicy: cod,
                inspectionPolicy: kiem,
                deliveryEstimate: giao,
                exchangePolicy: doiTra,
                approvedFacts: duKien.split("\n").map((x) => x.trim()).filter(Boolean),
              });
              setMsg("error" in r ? r.error : "Đã lưu — hội thoại MỚI dùng cấu hình này, hội thoại cũ giữ nguyên");
            })
          }
        >
          {pending ? "Đang lưu…" : "Lưu hồ sơ page"}
        </Button>
        {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
      </div>
    </div>
  );
}

/** Khai một NGOẠI LỆ nguồn: quảng cáo này KHÔNG bán mẫu thắng của page. */
export function SourceRuleForm({
  pancakePageId,
  sourceId,
  adDescription,
  conversations,
  mediaUrl,
  choices,
  tests,
}: {
  pancakePageId: string;
  sourceId: string;
  adDescription: string;
  conversations: number;
  mediaUrl: string;
  choices: Choice[];
  tests: TestChoice[];
}) {
  const [loai, setLoai] = useState<"WIN" | "TEST" | "HUMAN_ONLY">("TEST");
  const [sp, setSp] = useState("");
  const [tp, setTp] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row">
      {mediaUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaUrl} alt={`Quảng cáo ${sourceId}`} loading="lazy" className="h-24 w-24 shrink-0 rounded-md border object-cover" />
      ) : (
        <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-md border border-dashed text-[11px] text-muted-foreground">không ảnh</div>
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">{conversations} hội thoại</p>
        {adDescription ? <p className="line-clamp-2 text-xs text-muted-foreground">{adDescription}</p> : null}
        <code className="font-mono text-[11px] text-muted-foreground">{sourceId}</code>
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={loai} onChange={(e) => setLoai(e.target.value as typeof loai)}>
            <option value="TEST">{SOURCE_TYPE_LABEL.TEST}</option>
            <option value="WIN">{SOURCE_TYPE_LABEL.WIN}</option>
            <option value="HUMAN_ONLY">{SOURCE_TYPE_LABEL.HUMAN_ONLY}</option>
          </select>
          {loai === "WIN" ? (
            <select className="h-8 min-w-48 rounded-md border border-input bg-background px-2 text-xs" value={sp} onChange={(e) => setSp(e.target.value)}>
              <option value="">— dùng mẫu thắng mặc định —</option>
              {choices.map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} · ` : ""}{c.name}</option>)}
            </select>
          ) : null}
          {loai === "TEST" ? (
            <select className="h-8 min-w-48 rounded-md border border-input bg-background px-2 text-xs" value={tp} onChange={(e) => setTp(e.target.value)}>
              <option value="">— chọn hồ sơ mẫu test —</option>
              {tests.map((t) => <option key={t.id} value={t.id}>{t.testCode} · {t.name}</option>)}
            </select>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await saveSourceRule({ pancakePageId, sourceId, sourceKind: "AD", sourceType: loai, productId: sp || undefined, testProductId: tp || undefined });
                setMsg("error" in r ? r.error : "Đã khai ngoại lệ");
              })
            }
          >
            {pending ? "…" : "Khai ngoại lệ"}
          </Button>
          {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function DeleteRuleButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => {
        const r = await deleteSourceRule({ id });
        setMsg("error" in r ? r.error : "đã xoá");
      })}>Xoá</Button>
      {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
    </span>
  );
}
