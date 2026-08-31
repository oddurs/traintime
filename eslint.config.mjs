import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not ours to lint: a Python virtualenv, the MapLibre worker copied in at build time, and
    // recorded data. Linting them buried real findings under thousands of vendored warnings.
    ".venv/**",
    "public/maplibre/**",
    "data/**",
    ".cache/**",
  ]),
]);

export default eslintConfig;
