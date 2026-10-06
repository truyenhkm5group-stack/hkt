"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveLeadHunterConfigAction } from "@/lib/actions/wholesale";
import { MESSAGING_CONNECTOR_KEYS, MESSAGING_CONNECTOR_LABEL, MESSAGING_DESTINATION_HINT } from "@/lib/messaging/types";
import { DISCOVERY_TIER_LABEL, DISCOVERY_TIERS, OUTREACH_AUTOMATION_LABEL, OUTREACH_AUTOMATION_LEVELS, PLACES_SKU_LABEL, PLACES_SKUS, SIZE_PROFILE_LABEL, SIZE_PROFILES, type LeadHunterConfig } from "@/lib/wholesale/config";

const lbl = "block text-xs font-medium text-muted-foreground";
const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function NumberField({ label, value, onChange, step }: { label: string; value: number; onChange: (n: number) => void; step?: string }) {
  return (
    <label className={lbl}>
      {label}
      <Input type="number" step={step ?? "1"} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function ConfigForm({ initial, provinces, productImages }: { initial: LeadHunterConfig; provinces: { key: string; label: string }[]; productImages: { name: string; url: string }[] }) {
  const [imageUrl, setImageUrl] = useState("");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [c, setC] = useState<LeadHunterConfig>(initial);
  const [extraAreas, setExtraAreas] = useState(
    Object.entries(initial.serviceAreas)
      .filter(([k]) => !provinces.some((p) => p.key === k))
      .map(([k, v]) => `${k}: ${v === "PRIORITY" ? "ưu tiên" : "giao được"}`)
      .join("\n"),
  );
  // Ô chữ tự do: tách thành danh sách lúc LƯU, không phải lúc gõ (tách khi gõ thì chữ đầu sau dấu phẩy bị nuốt).
  const [brandsText, setBrandsText] = useState(initial.chainFilter.brands.join(", "));
  const cf = initial.competitorFilter;
  const [rivalText, setRivalText] = useState({ products: cf.products.join(", "), homeProvinces: cf.homeProvinces.join(", "), sellerWords: cf.sellerWords.join(", "), dishWords: cf.dishWords.join(", ") });
  const set = <K extends keyof LeadHunterConfig>(k: K, v: LeadHunterConfig[K]) => setC((x) => ({ ...x, [k]: v }));
  const setOut = <K extends keyof LeadHunterConfig["outreach"]>(k: K, v: LeadHunterConfig["outreach"][K]) => setC((x) => ({ ...x, outreach: { ...x.outreach, [k]: v } }));

  const save = () =>
    start(async () => {
      const areas: LeadHunterConfig["serviceAreas"] = {};
      for (const p of provinces) if (c.serviceAreas[p.key]) areas[p.key] = c.serviceAreas[p.key]!;
      for (const line of extraAreas.split(/\r?\n/)) {
        const [k, v] = line.split(":").map((s) => s.trim());
        if (!k) continue;
        const key = k
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/đ/g, "d")
          .toLowerCase()
          .replace(/^(tinh|thanh pho|tp)\s+/, "")
          .replace(/\s+/g, " ");
        areas[key] = /uu tien|ưu tiên|priority/i.test(v ?? "") ? "PRIORITY" : "SERVED";
      }
      const brands = [...new Set(brandsText.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length >= 2))];
      const list = (t: string) => [...new Set(t.split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length >= 2))];
      const competitorFilter = {
        enabled: c.competitorFilter.enabled,
        products: list(rivalText.products),
        homeProvinces: list(rivalText.homeProvinces),
        sellerWords: list(rivalText.sellerWords),
        dishWords: list(rivalText.dishWords),
      };
      const r = await saveLeadHunterConfigAction({ ...c, serviceAreas: areas, chainFilter: { ...c.chainFilter, brands }, competitorFilter });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu cấu hình");
        router.refresh();
      }
    });

  return (
    <div className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Trần chi tiêu (chặn cứng — chạm là tự tạm dừng)</legend>
        <div className="grid gap-3 md:grid-cols-4">
          <NumberField label="Trần NGÀY (US$)" step="0.5" value={c.budget.dailyUsd} onChange={(n) => set("budget", { ...c.budget, dailyUsd: n })} />
          <NumberField label="Trần THÁNG (US$)" step="1" value={c.budget.monthlyUsd} onChange={(n) => set("budget", { ...c.budget, monthlyUsd: n })} />
          <NumberField label="Trần lượt gọi / ngày" value={c.budget.dailyRequestLimit} onChange={(n) => set("budget", { ...c.budget, dailyRequestLimit: n })} />
          <NumberField label="Tỷ giá quy đổi (₫ / US$)" value={c.usdToVnd} onChange={(n) => set("usdToVnd", n)} />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Chế độ chỉ dùng lượt MIỄN PHÍ của Google</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={c.freeTier.enabled} onChange={(e) => set("freeTier", { ...c.freeTier, enabled: e.target.checked })} /> Bật — sắp hết lượt miễn phí của loại lượt sắp gọi thì tự dừng, ngày 1 tháng sau tự chạy tiếp
        </label>
        <p className="text-xs text-muted-foreground">Mặc định theo bảng giá Google từ 03/2025: Text Search Enterprise (có SĐT, ≤ 20 quán / lượt) 1.000 lượt / tháng; Pro 5.000; chỉ-Place-ID không giới hạn. Hạn mức tính chung cho cả tài khoản thanh toán.</p>
        <div className="grid gap-3 md:grid-cols-4">
          <NumberField label="Giữ dự phòng (0–0,5)" step="0.01" value={c.freeTier.safetyPct} onChange={(n) => set("freeTier", { ...c.freeTier, safetyPct: n })} />
          {PLACES_SKUS.filter((k) => k !== "TEXT_SEARCH_IDS").map((k) => (
            <NumberField key={k} label={`Miễn phí / tháng — ${PLACES_SKU_LABEL[k]}`} value={c.freeTier.monthlyCalls[k]} onChange={(n) => set("freeTier", { ...c.freeTier, monthlyCalls: { ...c.freeTier.monthlyCalls, [k]: n } })} />
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Quy mô khách nhắm tới</legend>
        <div className="grid gap-3 md:grid-cols-3">
          <label className={lbl}>
            Hồ sơ quy mô
            <select className={sel} value={c.sizeProfile} onChange={(e) => set("sizeProfile", e.target.value as LeadHunterConfig["sizeProfile"])}>
              {SIZE_PROFILES.map((p) => (
                <option key={p} value={p}>
                  {SIZE_PROFILE_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className={lbl}>
            Lọc nơi có hơn … đánh giá Google (để trống = không lọc)
            <Input inputMode="numeric" value={c.maxReviews == null ? "" : String(c.maxReviews)} onChange={(e) => set("maxReviews", e.target.value.replace(/\D/g, "") ? Number(e.target.value.replace(/\D/g, "")) : null)} />
          </label>
          <NumberField label="Cùng tên ở hơn … địa điểm ⇒ coi là chuỗi" value={c.chainFilter.maxSameName} onChange={(n) => set("chainFilter", { ...c.chainFilter, maxSameName: n })} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={c.chainFilter.enabled} onChange={(e) => set("chainFilter", { ...c.chainFilter, enabled: e.target.checked })} /> Loại chuỗi lớn (thường mua theo hợp đồng, đòi hoá đơn VAT)
        </label>
        <label className={lbl}>
          Thương hiệu chuỗi cần loại — ngăn cách bằng dấu phẩy
          <Textarea rows={3} value={brandsText} onChange={(e) => setBrandsText(e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Loại đối thủ (cơ sở làm / bán buôn cùng mặt hàng)</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={c.competitorFilter.enabled} onChange={(e) => set("competitorFilter", { ...c.competitorFilter, enabled: e.target.checked })} /> Loại nơi có mặt hàng của shop trong tên VÀ (ở tỉnh gốc HOẶC có dấu hiệu sản xuất / bán buôn). Quán dùng hàng làm món vẫn giữ.
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className={lbl}>
            Mặt hàng của shop — ngăn cách bằng dấu phẩy
            <Textarea rows={2} value={rivalText.products} onChange={(e) => setRivalText((x) => ({ ...x, products: e.target.value }))} />
          </label>
          <label className={lbl}>
            Tỉnh gốc (có mặt hàng trong tên là loại)
            <Textarea rows={2} value={rivalText.homeProvinces} onChange={(e) => setRivalText((x) => ({ ...x, homeProvinces: e.target.value }))} />
          </label>
          <label className={lbl}>
            Dấu hiệu sản xuất / bán buôn (loại ở mọi tỉnh)
            <Textarea rows={2} value={rivalText.sellerWords} onChange={(e) => setRivalText((x) => ({ ...x, sellerWords: e.target.value }))} />
          </label>
          <label className={lbl}>
            Tên món ăn (quán dùng hàng ⇒ giữ)
            <Textarea rows={2} value={rivalText.dishWords} onChange={(e) => setRivalText((x) => ({ ...x, dishWords: e.target.value }))} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">Lưu xong, lượt quét kế tiếp áp lại luật lên lead CHƯA ai liên hệ / chưa giao; lead bị loại vẫn xem được ở «Đã loại».</p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Đơn giá Google (US$ / 1.000 lượt) — sửa khi Google đổi giá</legend>
        <div className="grid gap-3 md:grid-cols-4">
          {PLACES_SKUS.map((k) => (
            <NumberField key={k} label={PLACES_SKU_LABEL[k]} step="0.5" value={c.skuPriceUsdPer1000[k]} onChange={(n) => set("skuPriceUsdPer1000", { ...c.skuPriceUsdPer1000, [k]: n })} />
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Quét</legend>
        <div className="grid gap-3 md:grid-cols-3">
          <label className={lbl}>
            Mức dữ liệu mặc định ở bước tìm
            <select className={sel} value={c.discoveryTier} onChange={(e) => set("discoveryTier", e.target.value as LeadHunterConfig["discoveryTier"])}>
              {DISCOVERY_TIERS.map((t) => (
                <option key={t} value={t}>
                  {DISCOVERY_TIER_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="Số trang tối đa / truy vấn (1–3, mỗi trang 20 kết quả)" value={c.maxPagesPerCell} onChange={(n) => set("maxPagesPerCell", n)} />
          <NumberField label="Lấy trang kế khi tỉ lệ địa điểm mới ≥ (0–1)" step="0.05" value={c.minNewRatioForNextPage} onChange={(n) => set("minNewRatioForNextPage", n)} />
          <NumberField label="Ô vừa quét được bỏ qua trong (ngày)" value={c.cellFreshDays} onChange={(n) => set("cellFreshDays", n)} />
          <NumberField label="Giữ dữ liệu Google tối đa (ngày, ≤ 30)" value={c.googleRetentionDays} onChange={(n) => set("googleRetentionDays", n)} />
          <NumberField label="Giãn cách giữa hai lượt gọi (ms)" value={c.requestIntervalMs} onChange={(n) => set("requestIntervalMs", n)} />
          <NumberField label="Hết giờ một lượt gọi (ms)" value={c.timeoutMs} onChange={(n) => set("timeoutMs", n)} />
          <NumberField label="Số lần thử lại (429 / 5xx / mạng)" value={c.maxRetries} onChange={(n) => set("maxRetries", n)} />
          <label className="flex items-center gap-2 pt-5 text-sm">
            <input type="checkbox" checked={c.websiteEnrichment.enabled} onChange={(e) => set("websiteEnrichment", { ...c.websiteEnrichment, enabled: e.target.checked })} /> Đọc trang liên hệ công khai của website
          </label>
        </div>
        <div className="space-y-1">
          <span className={lbl}>Thứ tự quét — tỉnh quét trước (áp khi bấm «Bắt đầu quét»; chiến dịch đang chạy giữ thứ tự cũ)</span>
          <div className="flex flex-wrap gap-2">
            {provinces.map((p) => (
              <label key={p.key} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={c.scanPriority.firstProvinces.includes(p.key)}
                  onChange={(e) =>
                    set("scanPriority", {
                      ...c.scanPriority,
                      firstProvinces: e.target.checked ? [...c.scanPriority.firstProvinces, p.key] : c.scanPriority.firstProvinces.filter((k) => k !== p.key),
                    })
                  }
                />
                {p.label}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.scanPriority.inlandBeforeCoastal} onChange={(e) => set("scanPriority", { ...c.scanPriority, inlandBeforeCoastal: e.target.checked })} /> Sau đó quét vùng KHÔNG có biển trước vùng ven biển (xét theo tỉnh cũ trước sáp nhập)
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Gửi khách cho nhân viên thị trường</legend>
        <p className="text-xs text-muted-foreground">
          Dùng kết nối nhắn tin của tổ chức (Cài đặt → Kết nối). Telegram: tạo bot bằng @BotFather, thêm bot vào nhóm của nhân viên thị trường, dán token ở trang Kết nối rồi bấm «Tìm chat» để lấy Chat ID của nhóm. Mỗi dòng dưới đây là một nơi nhận (vd một nhóm theo khu vực); để trống thì gửi vào chat mặc định của kết nối.
        </p>
        <label className={lbl}>
          Kênh gửi
          <select className={sel} value={c.fieldSales.connectorKey} onChange={(e) => set("fieldSales", { ...c.fieldSales, connectorKey: e.target.value as LeadHunterConfig["fieldSales"]["connectorKey"] })}>
            {MESSAGING_CONNECTOR_KEYS.map((k) => (
              <option key={k} value={k}>
                {MESSAGING_CONNECTOR_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] text-muted-foreground">{MESSAGING_DESTINATION_HINT[c.fieldSales.connectorKey]}</p>
        {c.fieldSales.destinations.map((d, i) => (
          <div key={i} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
            <Input placeholder="Tên nơi nhận (vd NV thị trường Hà Nội)" value={d.label} onChange={(e) => set("fieldSales", { ...c.fieldSales, destinations: c.fieldSales.destinations.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <Input placeholder="Chat ID (vd -1001234567890)" value={d.chatId} onChange={(e) => set("fieldSales", { ...c.fieldSales, destinations: c.fieldSales.destinations.map((x, j) => (j === i ? { ...x, chatId: e.target.value } : x)) })} />
            <Button type="button" size="sm" variant="ghost" onClick={() => set("fieldSales", { ...c.fieldSales, destinations: c.fieldSales.destinations.filter((_, j) => j !== i) })}>
              Xoá
            </Button>
          </div>
        ))}
        {c.fieldSales.destinations.length < 20 ? (
          <Button type="button" size="sm" variant="outline" onClick={() => set("fieldSales", { ...c.fieldSales, destinations: [...c.fieldSales.destinations, { label: "", chatId: "" }] })}>
            Thêm nơi nhận
          </Button>
        ) : null}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Chấm điểm</legend>
        <div className="grid gap-3 md:grid-cols-4">
          <NumberField label="Hạng A từ" value={c.gradeThresholds.A} onChange={(n) => set("gradeThresholds", { ...c.gradeThresholds, A: n })} />
          <NumberField label="Hạng B từ" value={c.gradeThresholds.B} onChange={(n) => set("gradeThresholds", { ...c.gradeThresholds, B: n })} />
          <NumberField label="Hạng C từ" value={c.gradeThresholds.C} onChange={(n) => set("gradeThresholds", { ...c.gradeThresholds, C: n })} />
          <NumberField label="Tự lên «Đủ điều kiện» từ (điểm, cần có SĐT)" value={c.qualifyMinScore} onChange={(n) => set("qualifyMinScore", n)} />
          <NumberField label="Học từ kết quả: số kết cục tối thiểu / nhóm" value={c.learning.minSample} onChange={(n) => set("learning", { ...c.learning, minSample: n })} />
          <NumberField label="Học từ kết quả: điều chỉnh tối đa (±điểm)" value={c.learning.maxAdjust} onChange={(n) => set("learning", { ...c.learning, maxAdjust: n })} />
        </div>
        <div className="space-y-1">
          <span className={lbl}>Vùng phục vụ (điểm vị trí)</span>
          <div className="flex flex-wrap gap-2">
            {provinces.map((p) => (
              <label key={p.key} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm">
                {p.label}
                <select
                  className="h-7 rounded border bg-background px-1 text-xs"
                  value={c.serviceAreas[p.key] ?? ""}
                  onChange={(e) => {
                    const next = { ...c.serviceAreas };
                    if (e.target.value) next[p.key] = e.target.value as "PRIORITY" | "SERVED";
                    else delete next[p.key];
                    set("serviceAreas", next);
                  }}
                >
                  <option value="">ngoài vùng</option>
                  <option value="PRIORITY">ưu tiên</option>
                  <option value="SERVED">giao được</option>
                </select>
              </label>
            ))}
          </div>
          <label className={lbl}>
            Tỉnh khác — mỗi dòng «Tên tỉnh: ưu tiên» hoặc «Tên tỉnh: giao được»
            <Textarea rows={2} value={extraAreas} onChange={(e) => setExtraAreas(e.target.value)} />
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Liên hệ & lời chào</legend>
        <div className="grid gap-3 md:grid-cols-2">
          <label className={lbl}>
            Mức tự động hoá
            <select className={sel} value={c.outreach.automationLevel} onChange={(e) => setOut("automationLevel", e.target.value as LeadHunterConfig["outreach"]["automationLevel"])}>
              {OUTREACH_AUTOMATION_LEVELS.map((t) => (
                <option key={t} value={t} disabled={t === "AUTO_SEND"}>
                  {OUTREACH_AUTOMATION_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pt-5 text-sm">
            <input type="checkbox" checked={c.outreach.useAi} onChange={(e) => setOut("useAi", e.target.checked)} /> Cho phép AI diễn đạt lời chào (người bấm từng lead, tốn credit AI)
          </label>
          {(
            [
              ["shopName", "Tên shop"],
              ["productLine", "Sản phẩm (vd hải sản đóng gói)"],
              ["targetAudience", "Khách mục tiêu (vd nhà hàng, quán ăn)"],
              ["moqNote", "Đơn tối thiểu (MOQ)"],
              ["deliveryNote", "Vùng / cách giao hàng"],
              ["promotionNote", "Khuyến mãi hiện tại"],
              ["catalogNote", "Catalog (link / mô tả)"],
              ["pricingNote", "Bảng giá (link / mô tả)"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className={lbl}>
              {label}
              <Input value={c.outreach[k]} onChange={(e) => setOut(k, e.target.value)} />
            </label>
          ))}
        </div>
        <label className={lbl}>
          Mẫu lời chào — biến: {"{{ten_doanh_nghiep}} {{ten_shop}} {{san_pham}} {{nhom_khach}} {{loai_hinh}} {{khu_vuc}}"}
          <Textarea rows={3} value={c.outreach.openerTemplate} onChange={(e) => setOut("openerTemplate", e.target.value)} />
        </label>
        <label className={lbl}>
          Kịch bản tư vấn qua điện thoại
          <Textarea rows={4} value={c.outreach.callScript} onChange={(e) => setOut("callScript", e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Kịch bản nhắn Zalo chào sỉ (nhắn Zalo trước, gọi sau)</legend>
        <label className={lbl}>
          Tin nhắn — mỗi dòng một đoạn; dòng nào rỗng sau khi điền biến thì tự bỏ. Biến: {"{{ten_doanh_nghiep}} {{ten_nv}} {{ten_shop}} {{san_pham}} {{nhom_khach}} {{loai_hinh}} {{khu_vuc}} {{loi_ich}} {{gui_anh}} {{khuyen_mai}} {{giao_hang}} {{moq}}"}
          <Textarea rows={7} value={c.outreach.zaloTemplate} onChange={(e) => setOut("zaloTemplate", e.target.value)} />
        </label>
        <p className="text-xs text-muted-foreground">
          {"{{ten_nv}}"} = tên gọi của nhân viên đang nhắn · {"{{gui_anh}}"} = câu «em gửi vài hình…» chỉ khi đã chọn ảnh · {"{{loi_ich}}"} = một câu theo nhóm khách (quán ăn: thêm món nhắm; cửa hàng: bán lẻ lại; mẹ &amp; bé: nấu cho bé). Không ghi giá — gửi bảng giá khi khách hỏi.
        </p>
        <div className="space-y-1.5">
          <div className={lbl}>Ảnh gửi kèm ({c.outreach.zaloImages.length}/10) — nhân viên chia sẻ sang Zalo bằng nút chia sẻ của điện thoại</div>
          {c.outreach.zaloImages.length ? (
            <div className="flex flex-wrap gap-2">
              {c.outreach.zaloImages.map((u, i) => (
                <div key={u} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element -- ảnh ngoài miền, chỉ xem trước */}
                  <img src={u} alt={`Ảnh ${i + 1}`} className="h-20 w-20 rounded-md border object-cover" />
                  <button type="button" onClick={() => setOut("zaloImages", c.outreach.zaloImages.filter((x) => x !== u))} className="absolute -right-1.5 -top-1.5 rounded-full border bg-background px-1.5 text-xs" aria-label="Bỏ ảnh">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Chưa chọn ảnh nào — tin Zalo gửi chữ thôi.</p>
          )}
          <div className="flex gap-2">
            <Input placeholder="Dán link ảnh https://…" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
            <Button
              type="button"
              variant="outline"
              disabled={!/^https:\/\/\S+$/.test(imageUrl.trim()) || c.outreach.zaloImages.length >= 10}
              onClick={() => {
                const u = imageUrl.trim();
                if (!c.outreach.zaloImages.includes(u)) setOut("zaloImages", [...c.outreach.zaloImages, u]);
                setImageUrl("");
              }}
            >
              Thêm
            </Button>
          </div>
          {productImages.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Chọn từ ảnh sản phẩm ({productImages.length})</summary>
              <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-8">
                {productImages.map((p) => {
                  const on = c.outreach.zaloImages.includes(p.url);
                  return (
                    <button
                      key={p.url}
                      type="button"
                      title={p.name}
                      disabled={!on && c.outreach.zaloImages.length >= 10}
                      onClick={() => setOut("zaloImages", on ? c.outreach.zaloImages.filter((x) => x !== p.url) : [...c.outreach.zaloImages, p.url])}
                      className={on ? "rounded-md ring-2 ring-primary" : "rounded-md opacity-90 hover:opacity-100 disabled:opacity-40"}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- ảnh sản phẩm từ kho ảnh ngoài */}
                      <img src={p.url} alt={p.name} className="aspect-square w-full rounded-md border object-cover" />
                    </button>
                  );
                })}
              </div>
            </details>
          ) : null}
        </div>
      </fieldset>

      <Button disabled={pending} onClick={save}>
        Lưu cấu hình
      </Button>
    </div>
  );
}
