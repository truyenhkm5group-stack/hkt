import { matchSite } from "@/lib/platform/site-host";
import { sitemapXml } from "@/lib/site/seo";

export const dynamic = "force-dynamic";

/** sitemap.xml — chỉ ở mặt tiền (lib/site/seo.ts); host phần mềm vẫn 404 như trước. */
export function GET(request: Request) {
  const site = matchSite(request.headers.get("host"), {
    SITE_DOMAIN: process.env.SITE_DOMAIN,
    CHOTDON_DOMAIN: process.env.CHOTDON_DOMAIN,
    APP_URL: process.env.APP_URL,
    CHOTDON_APP_URL: process.env.CHOTDON_APP_URL,
  });
  if (!site) return new Response("Not found", { status: 404 });
  return new Response(sitemapXml(site.domain), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
