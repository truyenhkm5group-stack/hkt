/**
 * Ghi / gộp cấu hình JSON vào bảng settings (dùng qua ops khi không tiện mở giao diện).
 *   npm run set:setting -- alerts.config '{"larkWebhookUrl":"https://open.larksuite.com/open-apis/bot/v2/hook/..."}'
 *   npm run set:setting -- alerts.config '{}' --test-lark     # gửi tin thử Lark sau khi lưu
 * Giá trị được gộp (shallow merge) vào JSON hiện có của khoá; không in nội dung ra log.
 */
import "dotenv/config";
import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { getSettingJson, setSettingJson } from "@/lib/settings";

async function main() {
  const args = process.argv.slice(2);
  const [key, json] = args.filter((a) => !a.startsWith("--"));
  if (!key) throw new Error("Thiếu khoá settings");
  const patch = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  const current = await getSettingJson<Record<string, unknown>>(key, {});
  const next = { ...current, ...patch };
  await setSettingJson(key, next);
  console.log(`Đã lưu ${key} (${Object.keys(patch).length} trường cập nhật, ${Object.keys(next).length} trường tổng)`);
  if (args.includes("--test-lark")) {
    const cfg = await loadAlertConfig();
    const r = await sendLark(cfg.larkWebhookUrl, cfg.larkSecret, "✅ Shop Control ERP đã kết nối Lark", [[{ text: "Cảnh báo đơn chờ xử lý, giao thất bại chờ phát lại, case CSKH sẽ gửi vào nhóm này. " }, { text: "Mở ERP", href: `${process.env.APP_URL ?? "https://erp.vnxcommerce.com"}/alerts` }]]);
    console.log(r.ok ? "Đã gửi tin thử Lark thành công." : `Lark lỗi: ${r.error}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
