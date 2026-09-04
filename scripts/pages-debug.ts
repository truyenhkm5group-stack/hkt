/**
 * Dò endpoint Pancake Pages public API với PANCAKE_ACCESS_TOKEN: in mã HTTP + đoạn đầu phản hồi (không in token).
 *   npx tsx scripts/pages-debug.ts
 */
import "dotenv/config";
import { env } from "@/lib/env";

const token = env.pancake.pagesAccessToken;
const variants: { name: string; url: string; method?: string; headers?: Record<string, string> }[] = [
  { name: "public_api/v1/pages (accept json)", url: `https://pages.fm/api/public_api/v1/pages?access_token=${token}`, headers: { accept: "application/json" } },
  { name: "public_api/v1/pages (no accept)", url: `https://pages.fm/api/public_api/v1/pages?access_token=${token}` },
  { name: "public_api/v1/pages (accept */*)", url: `https://pages.fm/api/public_api/v1/pages?access_token=${token}`, headers: { accept: "*/*", "user-agent": "Mozilla/5.0" } },
  { name: "api/v1/pages", url: `https://pages.fm/api/v1/pages?access_token=${token}`, headers: { accept: "*/*" } },
  { name: "pancake.vn public_api/v1/pages", url: `https://pancake.vn/api/public_api/v1/pages?access_token=${token}`, headers: { accept: "*/*" } },
  { name: "public_api/v1/pages POST", url: `https://pages.fm/api/public_api/v1/pages?access_token=${token}`, method: "POST", headers: { accept: "*/*" } },
  { name: "pages.fm/api/v1/pages (header token)", url: `https://pages.fm/api/v1/pages`, headers: { accept: "*/*", authorization: `Bearer ${token}` } },
];

async function main() {
  if (!token) throw new Error("Chưa có PANCAKE_ACCESS_TOKEN");
  console.log(`Token dài ${token.length} ký tự`);
  for (const v of variants) {
    try {
      const res = await fetch(v.url, { method: v.method ?? "GET", headers: v.headers, signal: AbortSignal.timeout(20_000) });
      const text = (await res.text()).replace(new RegExp(token, "g"), "***");
      console.log(`- ${v.name}: HTTP ${res.status} · ${text.slice(0, 220).replace(/\s+/g, " ")}`);
    } catch (e) {
      console.log(`- ${v.name}: lỗi ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
main().then(() => process.exit(0));
