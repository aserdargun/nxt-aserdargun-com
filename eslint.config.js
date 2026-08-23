import js from "@eslint/js";
import tseslint from "typescript-eslint";

const productionTypeScript = ["**/src/**/*.{ts,tsx}"];
const testTypeScript = ["**/test/**/*.{ts,tsx}", "**/*.test.{ts,tsx}"];

export default [
  {
    ignores: [
      "**/dist/**",
      "web/dist/**",
      "api-dist/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: testTypeScript
  })),
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: productionTypeScript
  })),
  {
    files: productionTypeScript,
    languageOptions: {
      parserOptions: {
        projectService: true
      }
    }
  }
];
