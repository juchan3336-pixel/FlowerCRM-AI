import nextPlugin from "@next/eslint-plugin-next"
import js from "@eslint/js"
import reactPlugin from "eslint-plugin-react"
import reactHooksPlugin from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "coverage/**", "*.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@next/next": nextPlugin,
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": ["error", { "fixStyle": "inline-type-imports" }],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off"
    },
    settings: {
      react: { version: "detect" },
    },
  },
)
