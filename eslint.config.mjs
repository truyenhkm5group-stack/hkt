import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Bot chat: dự án Node thuần riêng (ESM, không TS), có bộ selftest riêng — `npm run selftest` trong chatbot/.
      "chatbot/**",
      // Tiện ích Chrome «Lưu mẫu từ 1688» (SRC-6): JS thuần chạy trong trình duyệt (API chrome.*), không qua Next — nạp unpacked,
      // không đóng gói. Bài kiểm tests/sourcing-capture.test.ts đọc mã nguồn của nó (danh sách cho phép, không innerText, không cookie).
      "extensions/**",
    ],
  },
];

export default eslintConfig;
