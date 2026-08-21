import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Lint config.
 *
 * This exists for one rule in particular. Three separate crashes shipped as a
 * blank window -- `match.team1 is not iterable`, `Cannot read properties of
 * undefined`, `send is not defined` -- and the last of those is exactly what
 * no-undef catches. A bundler will not: an undefined *global* is legal JS right
 * up until it runs, so `npm run build` stayed green while the app was broken.
 */
export default [
  {
    // TypeScript is tsc's job -- it understands types, which a JS parser here
    // would not -- so lint covers the client, where nothing else does.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "reference/**",
      "**/*.ts",
      "**/*.mts",
      "**/*.cts",
    ],
  },

  // Frontend: browser globals, JSX, hook rules.
  {
    files: ["apps/desktop/src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...js.configs.recommended.rules,

      // Only the two classic hook rules. The React Compiler rules the
      // recommended set now pulls in are about optimisability, not
      // correctness, and this codebase is not compiled with it.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // JSX consumes these without a call expression the parser can see.
      "no-unused-vars": [
        "error",
        { varsIgnorePattern: "^[A-Z]", argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],

      // An empty catch is usually deliberate here -- a cosmetic refresh that
      // failed, a socket already closing -- and each one carries a comment.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Config and scripts that are plain JS/ESM run under Node.
  {
    files: ["*.js", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules },
  },
];
