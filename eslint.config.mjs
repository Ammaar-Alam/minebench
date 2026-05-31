import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const baseDirectory = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory });

const eslintConfig = [
  {
    ignores: ["node_modules/**", ".next/**", "graphify-out/**", ".agents/worktrees/**"],
  },
  ...compat.extends("next/core-web-vitals"),
];

export default eslintConfig;
