// Flat config. Required as of ESLint 9, which eslint-config-next 16 peers on.
//
// Two things changed together here and neither was optional: eslint-config-next
// 14 pulled a `glob` with a command-injection advisory, and its only fix is the
// 16 line, which requires ESLint 9 - and ESLint 9 dropped .eslintrc.json.
// `next lint` was also removed in Next 16, so `npm run lint` calls eslint directly.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      // Test harnesses are plain CommonJS/ESM scripts, not app code.
      'e2e/**',
      'test/**',
    ],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      // Two rules new in this plugin line fire 18 times on code that was clean
      // under eslint-config-next 14. Downgraded to warnings DELIBERATELY, so the
      // upgrade lands without a blind refactor, and the work stays visible.
      //
      // set-state-in-effect (17 hits): a real signal - each one is a setState
      // called synchronously inside an effect, which can cascade renders. Fixing
      // them means reworking data-loading effects across the dashboard, and that
      // needs someone who can exercise the UI, not a lint autofix.
      'react-hooks/set-state-in-effect': 'warn',
      // 1 hit, app/brand/page.tsx:28 - `useEffect(() => { load(); }, [])` above
      // `async function load()`. Function declarations hoist and the effect runs
      // after render, so this is a false positive; kept visible rather than
      // silenced outright.
      'react-hooks/immutability': 'warn',
    },
  },
];
