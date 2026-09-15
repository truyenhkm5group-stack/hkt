"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setSourceClassification } from "@/lib/actions/fanpage-sales";

type TestChoice = { id: string; testCode: string; name: string };
type SizeChoice = { id: string; name: string };

/**
 * Một dòng = một quảng cáo / bài viết có phát sinh hội thoại.
 *
 * `DEFAULT_WIN` là mặc định và chọn nó sẽ XOÁ luật đi, không ghi thêm một luật WIN: mặc định của
 * fanpage vốn đã là WIN, thêm một dòng thừa chỉ tạo chỗ để hai nơi nói hai điều khác nhau khi page
 * đổi mẫu thắng.
 */
export function SourceRow({
  pancakePageId,
  sourceId,
  sourceKind,
  status,
  testCode,
  adDescription,
  mediaUrl,
  conversations,
  tests,
  sizes,
}: {
  pancakePageId: string;
  sourceId: string;
  sourceKind: string;
  status: "DEFAULT_WIN" | "TEST" | "HUMAN_ONLY";
  testCode: string;
  adDescription: string;
  mediaUrl: string;
  conversations: number;
  tests: TestChoice[];
  sizes: SizeChoice[];
}) {
  const [chon, setChon] = useState<"DEFAULT_WIN" | "TEST" | "HUMAN_ONLY">(status);
  const [tpId, setTpId] = useState("");
  const [ten, setTen] = useState("");
  const [gia, setGia] = useState("");
  const [mau, setMau] = useState("");
  const [chatLieu, setChatLieu] = useState("");
  const [ship, setShip] = useState("");
  const [cod, setCod] = useState("");
  const [sizeId, setSizeId] = useState("");
  const [ghiChu, setGhiChu] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();

  const nhanTrangThai =
    status === "TEST" ? `TEST${testCode ? ` · ${testCode}` : ""}` : status === "HUMAN_ONLY" ? "CHỈ NGƯỜI" : "theo mã WIN";

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row">
      {mediaUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaUrl} alt={`Nguồn ${sourceId}`} loading="lazy" className="h-28 w-28 shrink-0 rounded-md border object-cover" />
      ) : (
        <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-md border border-dashed text-[11px] text-muted-foreground">
          không ảnh
        </div>
      )}

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium">{conversations} hội thoại</span>
          <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">{nhanTrangThai}</span>
          <code className="font-mono text-[11px] text-muted-foreground">{sourceId}</code>
        </div>
        {adDescription ? <p className="line-clamp-2 text-xs text-muted-foreground">{adDescription}</p> : null}

        <div className="flex flex-wrap items-center gap-2">
          <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={chon} onChange={(e) => setChon(e.target.value as typeof chon)}>
            <option value="DEFAULT_WIN">DEFAULT_WIN — dùng mã WIN của page</option>
            <option value="TEST">TEST — mẫu đang thử</option>
            <option value="HUMAN_ONLY">HUMAN_ONLY — AI không xử lý</option>
          </select>
          {chon === "TEST" ? (
            <select className="h-8 min-w-52 rounded-md border border-input bg-background px-2 text-xs" value={tpId} onChange={(e) => setTpId(e.target.value)}>
              <option value="">— tạo hồ sơ mẫu test mới —</option>
              {tests.map((t) => (
                <option key={t.id} value={t.id}>{t.testCode} · {t.name}</option>
              ))}
            </select>
          ) : null}
        </div>

        {chon === "TEST" && !tpId ? (
          <div className="space-y-2 rounded-md border border-dashed p-2">
            <p className="text-[11px] text-muted-foreground">
              Mã tạm sinh tự động. Mẫu test KHÔNG cần mã hàng chính thức. Ô nào bỏ trống thì máy nói “chưa có”, và tuyệt đối không
              mượn dữ liệu của mã WIN.
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <input className="h-8 rounded-md border border-input bg-background px-2 text-xs" placeholder="Tên mẫu test *" value={ten} onChange={(e) => setTen(e.target.value)} />
              <input className="h-8 rounded-md border border-input bg-background px-2 text-xs" placeholder="Giá test (đ) — trống = chưa có" value={gia} onChange={(e) => setGia(e.target.value)} inputMode="numeric" />
              <input className="h-8 rounded-md border border-input bg-background px-2 text-xs" placeholder="Màu (cách dấu phẩy)" value={mau} onChange={(e) => setMau(e.target.value)} />
              <input className="h-8 rounded-md border border-input bg-background px-2 text-xs" placeholder="Chất liệu" value={chatLieu} onChange={(e) => setChatLieu(e.target.value)} />
              <input className="h-8 rounded-md border border-input bg-background px-2 text-xs" placeholder="Phí ship / chính sách ship" value={ship} onChange={(e) => setShip(e.target.value)} />
              <input className="h-8 rounded-md border border-input bg-background px-2 text-xs" placeholder="Kiểm hàng / COD" value={cod} onChange={(e) => setCod(e.target.value)} />
              <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
                <option value="">— chưa có bảng size —</option>
                {sizes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <input className="h-8 rounded-md border border-input bg-background px-2 text-xs sm:col-span-2" placeholder="Ghi chú cho sale" value={ghiChu} onChange={(e) => setGhiChu(e.target.value)} />
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await setSourceClassification({
                  pancakePageId,
                  sourceId,
                  sourceKind,
                  choice: chon,
                  testProductId: tpId || undefined,
                  newTest:
                    chon === "TEST" && !tpId
                      ? {
                          name: ten,
                          price: gia.trim() === "" ? null : Number(gia.replace(/\D/g, "")),
                          colors: mau,
                          material: chatLieu,
                          shippingPolicy: ship,
                          codPolicy: cod,
                          sizeProfileId: sizeId || undefined,
                          note: ghiChu,
                        }
                      : undefined,
                });
                setMsg("error" in r ? r.error : "Đã lưu");
              })
            }
          >
            {pending ? "Đang lưu…" : "Lưu phân loại"}
          </Button>
          {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
        </div>
      </div>
    </div>
  );
}
