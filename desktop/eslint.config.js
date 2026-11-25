// CommonJS like the rest of the shell (package.json has no "type": "module").
const js = require("@eslint/js");
const globals = require("globals");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  {
    ignores: [
      "dist/**",
      "build/**",
      "release/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,js}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["eslint.config.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Must stay last: turns off stylistic rules that would fight Prettier.
  prettier
);
