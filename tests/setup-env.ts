/** Ép kiểm thử dùng CSDL PGlite tạm (không đụng vào DB trong .env). */
import { rmSync } from "node:fs";

const dir = "./data/pglite-test";
rmSync(dir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dir}`;
