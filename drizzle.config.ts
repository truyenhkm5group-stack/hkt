import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL || "postgresql://erp:erp_secret@localhost:5432/erp";
const pglite = url.startsWith("pglite:");

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  ...(pglite
    ? { driver: "pglite", dbCredentials: { url: url.replace(/^pglite:\/\//, "").replace(/^pglite:/, "") || "memory://" } }
    : { dbCredentials: { url } }),
  strict: true,
  verbose: true,
});
