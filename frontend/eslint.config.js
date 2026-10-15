import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "playwright-report/**",
      "test-results/**",
      "blob-report/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Classic hooks rules only. The React Compiler rules bundled into the
      // v7 "recommended" preset (set-state-in-effect, refs, ...) target a
      // compiler-first code style this codebase does not use yet.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // Labels here often wrap a styled <span> around the text and a custom
      // Toggle (a button with role="switch") instead of a bare <input>.
      "jsx-a11y/label-has-associated-control": [
        "error",
        { depth: 3, controlComponents: ["Toggle"] },
      ],
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Browser storage goes through src/storage.ts (safe access, validation,
    // versioned migrations); direct use is a lint error everywhere else.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/storage.ts", "src/storage.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "localStorage",
          message: "Use the helpers in src/storage.ts instead.",
        },
        {
          name: "sessionStorage",
          message: "Use the helpers in src/storage.ts instead.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[property.name=/^(localStorage|sessionStorage)$/]",
          message: "Use the helpers in src/storage.ts instead.",
        },
      ],
    },
  },
  {
    // These modules deliberately co-locate a component with its hook/helpers
    // (context providers + useX, filter helpers next to a select, ...). Fast
    // Refresh falls back to a full reload for them, which is acceptable. New
    // files still get the rule; do not add to this list without a reason.
    files: [
      "src/context/*.tsx",
      "src/pages/settings/context.tsx",
      "src/hooks/useFlipMenu.tsx",
      "src/components/HttpsHelp.tsx",
      "src/components/MenuFlyout.tsx",
      "src/components/OfflineDownloadButton.tsx",
      "src/components/ThemedSelect.tsx",
      "src/components/playlistChrome.tsx",
    ],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    files: [
      "e2e/**/*.ts",
      "*.config.{js,ts}",
      "vite-plugin-sw.ts",
      "scripts/**/*.{js,mjs}",
    ],
    languageOptions: { globals: globals.node },
  },
  // Must stay last: turns off stylistic rules that would fight Prettier.
  prettier
);
