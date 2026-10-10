/*
  ops `org-volume-discount` — CÀI LUẬT «BÁN THEO GÓI ĐƠN VỊ + GIẢM THEO KHỐI LƯỢNG» CHO MỘT TỔ CHỨC KHÁCH (lib/sales-chatbot/volume-discount.ts).

  Vì sao có (10/10/2026): chủ shop HSLC «cài mặc định luôn cho tôi» sau khi #776 lên production (luật mặc định TẮT, bật ở AI bán hàng →
  Cấu hình → «Bán hàng»). Chủ shop chọn: gói 1kg · từ 2kg · giảm 20.000 ₫ · MỖI 2kg giảm thêm (4kg = 1.080.000 ₫, khớp bảng gói 2kg cũ).
  `set-setting` chỉ ghi CSDL nhà — cấu hình bot nằm trong CSDL của tổ chức, nên ghi qua `saveVolumeDiscountAsOperator` (đúng lược đồ của
  màn Cấu hình, chỉ ô `volumeDiscount`, nhật ký `SALES_CHATBOT_CONFIG` mang nhãn người vận hành). Hàm nằm NGAY trong script và chỉ dùng
  thứ đã có trên production (#776): ops lấy script từ `main` nhưng `lib/` từ container — gộp là chạy được, không chờ deploy.

  arg: `<mã tổ chức> [--unit=<kg>] [--min=<kg>] [--amount=<đồng>] [--mode=ONCE|PER_STEP] [--off] [--apply]`
   · thiếu cờ ⇒ giữ giá trị đang lưu của ô đó; `--off` ⇒ tắt luật.
   · KHÔNG `--apply` ⇒ CHẠY THỬ: in trước / sau, không ghi gì.
  Đầu ra chỉ là cấu hình giá (không tên / SĐT khách) ⇒ in thẳng ra log, tóm tắt mang tiền tố [ops:tom-tat].
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-volume-discount.ts"));

import "dotenv/config";
import { audit } from "@/lib/audit";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { SALES_CHATBOT_SETTING_KEY, salesChatbotConfigZ, type SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import type { VolumeDiscountRule } from "@/lib/sales-chatbot/volume-discount";
import { setSettingJson } from "@/lib/settings";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const SCRIPT_LABEL = "script org-volume-discount";

export type VolumeArgs = { code: string; apply: boolean; patch: Partial<VolumeDiscountRule> };

/** Đọc tham số. Cờ lạ / số sai ⇒ lỗi (không đoán). HÀM THUẦN. */
export function parseVolumeArgs(argv: readonly string[]): { ok: true; args: VolumeArgs } | { ok: false; error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { ok: false, error: "thiếu / sai mã tổ chức" };
  const patch: Partial<VolumeDiscountRule> = { enabled: true };
  let apply = false;
  for (const f of argv.filter((a) => a.startsWith("--"))) {
    const [k, v = ""] = f.split("=", 2);
    const kg = () => {
      const n = Number(v.replace(",", "."));
      return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
    };
    if (k === "--apply" && !v) apply = true;
    else if (k === "--off" && !v) patch.enabled = false;
    else if (k === "--unit" && kg() !== null) patch.unitGrams = kg()!;
    else if (k === "--min" && kg() !== null) patch.minWeightGrams = kg()!;
    else if (k === "--amount" && /^\d+$/.test(v)) patch.amount = Number(v);
    else if (k === "--mode" && (v === "ONCE" || v === "PER_STEP")) patch.mode = v;
    else return { ok: false, error: `cờ lạ / giá trị sai: ${f}` };
  }
  return { ok: true, args: { code, apply, patch } };
}

/**
 * Ghi ĐÚNG ô `volumeDiscount` của cấu hình bot trong tổ chức NGỮ CẢNH — kiểm bằng lược đồ của màn Cấu hình, mọi ô khác giữ nguyên, nhật ký
 * người vận hành (`userId = null`). `apply = false` hoặc không đổi gì ⇒ không ghi.
 */
export async function saveVolumeDiscountAsOperator(input: { rule: unknown; operator: { orgCode: string; email: string }; reason: string; apply: boolean }): Promise<{ ok: true; before: SalesChatbotConfig["volumeDiscount"]; after: SalesChatbotConfig["volumeDiscount"]; changed: boolean; written: boolean } | { ok: false; error: string }> {
  const before = await loadSalesChatbotConfig();
  const parsed = salesChatbotConfigZ.safeParse({ ...before, volumeDiscount: input.rule });
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join(" · ") };
  const cfg = parsed.data;
  const changed = JSON.stringify(cfg.volumeDiscount) !== JSON.stringify(before.volumeDiscount);
  if (!input.apply || !changed) return { ok: true, before: before.volumeDiscount, after: cfg.volumeDiscount, changed, written: false };
  await setSettingJson(SALES_CHATBOT_SETTING_KEY, cfg);
  await audit({ userId: null, userEmail: `${input.operator.email} (vận hành nền tảng · ${input.operator.orgCode})`, action: "SALES_CHATBOT_CONFIG", entity: "SETTINGS", entityId: SALES_CHATBOT_SETTING_KEY, before: { volumeDiscount: before.volumeDiscount }, after: { volumeDiscount: cfg.volumeDiscount }, reason: `Người vận hành cài giảm theo khối lượng: ${input.reason}` });
  return { ok: true, before: before.volumeDiscount, after: cfg.volumeDiscount, changed, written: true };
}

const kgText = (g: number) => `${String(g / 1000).replace(".", ",")}kg`;
export function ruleText(r: VolumeDiscountRule): string {
  return `${r.enabled ? "BẬT" : "TẮT"} · gói ${kgText(r.unitGrams)} · từ ${kgText(r.minWeightGrams)} · giảm ${r.amount.toLocaleString("vi-VN")} ₫ · ${r.mode === "PER_STEP" ? "mỗi lần đủ ngưỡng" : "một lần"}`;
}

async function main(): Promise<number> {
  const parsed = parseVolumeArgs(process.argv.slice(2));
  if (!parsed.ok) {
    tomTat(`Cách dùng sai: ${parsed.error} — arg: <mã tổ chức> [--unit=1] [--min=2] [--amount=20000] [--mode=PER_STEP] [--off] [--apply]`);
    return 64;
  }
  const { code, apply, patch } = parsed.args;
  const org = await findOrganization(code);
  if (!org) {
    tomTat(`Không có tổ chức «${code}»`);
    return 64;
  }
  const operator = { orgCode: (await listOrganizations()).find((o) => o.isHome)?.code ?? "home", email: SCRIPT_LABEL };
  const r = await withOrganization(org.code, async () => {
    const current = (await loadSalesChatbotConfig()).volumeDiscount;
    return saveVolumeDiscountAsOperator({ rule: { ...current, ...patch }, operator, reason: "chủ shop yêu cầu cài mặc định 10/10/2026", apply });
  });
  if (!r.ok) {
    tomTat(`KHÔNG GHI ${org.code}: ${r.error}`);
    return 1;
  }
  tomTat(`${org.code} TRƯỚC: ${ruleText(r.before)}`);
  tomTat(`${org.code} SAU:   ${ruleText(r.after)}`);
  tomTat(r.written ? "ĐÃ GHI (nhật ký SALES_CHATBOT_CONFIG · người vận hành)" : r.changed ? "CHẠY THỬ — chưa ghi; thêm --apply để ghi" : "KHÔNG ĐỔI — cấu hình đã đúng như vậy");
  return 0;
}

if (CHAY_THANG) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("org-volume-discount lỗi:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
