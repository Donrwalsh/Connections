const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "test/**/*.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
