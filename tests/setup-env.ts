/** Ép kiểm thử dùng CSDL PGlite tạm (không đụng vào DB trong .env). */
import { rmSync } from "node:fs";

// Mỗi tiến trình có CSDL riêng để các lượt kiểm thử song song không xoá dữ liệu của nhau.
const dir = `./data/pglite-test-${process.pid}`;
rmSync(dir, { recursive: true, force: true });
process.env.DATABASE_URL = `pglite://${dir}`;
