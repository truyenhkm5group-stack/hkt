/**
 * Mở cổng HTTP cho trạm chuyển tiếp Google Places (logic ở relay.js). Cloud Run đặt biến PORT; RELAY_SECRET đặt lúc deploy.
 *
 * Dựng (Cloud Shell của dự án Google Cloud có thanh toán, ~5 phút):
 *   git clone --depth 1 https://github.com/truyenhkm5group-stack/hkt.git && cd hkt/deploy/places-relay
 *   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
 *   gcloud run deploy places-relay --source . --region asia-southeast1 --allow-unauthenticated \
 *     --set-env-vars RELAY_SECRET=$(openssl rand -hex 24) --max-instances 2 --memory 256Mi
 * Rồi ở ERP: Cài đặt → Kết nối → Google Places → «Địa chỉ trạm» = Service URL, «Mật khẩu trạm» = RELAY_SECRET.
 * Gỡ: để trống «Địa chỉ trạm» ⇒ ERP gọi thẳng places.googleapis.com như cũ.
 */
import http from "node:http";
import { handle, MAX_BODY } from "./relay.js";

const secret = process.env.RELAY_SECRET ?? "";
const port = Number(process.env.PORT) || 8080;

http
  .createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY + 1) chunks.push(c);
    });
    req.on("end", async () => {
      const lower = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
      const out = await handle({ method: req.method ?? "GET", url: req.url ?? "/", headers: lower, body: Buffer.concat(chunks).toString("utf8") }, { secret, fetchImpl: fetch });
      res.writeHead(out.status, { "content-type": out.contentType, "cache-control": "no-store" });
      res.end(out.body);
    });
  })
  .listen(port);
