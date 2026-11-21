import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // 这个项目把 Key / 房间数据放在 localStorage，只能在挂载后的 effect 里读一次
      // 再塞进 state；React Compiler 的新规则会把这种必要写法报成错误。
      // 降为 warning：`npm run lint` 不再因此失败，但仍能在输出里看到。
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
