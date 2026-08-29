// eslint-config-next 16 ships flat configs directly. The previous FlatCompat shim wrapped the
// old eslintrc-style export and now throws on a circular structure, so the compat layer — and
// its @eslint/eslintrc dependency — are gone rather than worked around.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  // .venv holds vendored Python package assets, including JavaScript that is not ours.
  { ignores: [".next/**", "node_modules/**", ".venv/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescript,
];

export default config;
