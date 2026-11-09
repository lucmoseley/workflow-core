import next from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import regexp from "eslint-plugin-regexp";

// Biome is the primary tool: it owns formatting and general linting.
// ESLint is kept ONLY for the gap Biome does not fully cover, and that gap is
// not the classic hooks pair (mantahostels#1537):
// Biome 2.5's react domain auto-enables off the installed dependency and
// already fires correctness/useHookAtTopLevel and useExhaustiveDependencies at
// error on app/**/*.tsx, so rules-of-hooks and exhaustive-deps are Biome's now.
// What survives is 35 rules Biome has no equivalent for: the 20 live
// @next/next framework rules (21 minus no-img-element, off below), and the 15
// React Compiler rules that recommended-latest carries beside those two.
// Dropping the preset would delete those 35, not consolidate 2.
// scripts/tooling-matrix.test.ts pins the counts and a sample of the names.
// No formatting/stylistic rules live here, so the two tools never conflict.
//
// Both presets ship without a `files` key, so on their own they inherit flat
// config's `**/*.js` default (mantahostels#999); the scope below is written for them.
//
// scripts/ carries the second block: eslint-plugin-regexp's two super-linear
// regex rules, the class SonarQube Cloud raises there as S8786 and S5852, so a
// commit refuses one before Sonar opens it (#4642). Together they hit every
// line Sonar raised on main and more. SonarSource's own eslint-plugin-sonarjs
// is not used: from 3.0 it is under the Sonar Source-Available License, whose
// §1(c) excludes use by AI tooling, and this repo is worked by agents (#4642).
// Sonar skips test files for these rules, and so does the block.
// A finding you will not fix takes `// eslint-disable-next-line <rule> --
// <reason>` on the line above, and where Sonar also raises that line, a
// `// NOSONAR <reason>` at its end: neither tool reads the other's comment.
const eslintConfig = defineConfig([
	{
		files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
		extends: [
			next.configs["core-web-vitals"],
			reactHooks.configs.flat["recommended-latest"],
		],
		languageOptions: {
			// Neither preset configures a parser, and espree cannot read type
			// annotations or TSX. No `project` option: every rule here is
			// syntactic, so the slower type-aware setup buys nothing.
			parser: tsParser,
		},
		rules: {
			// Biome's lint/performance/noImgElement is the same rule over the same
			// files, so leaving this on means every deliberate <img> needs two
			// suppression comments.
			"@next/next/no-img-element": "off",
		},
	},
	{
		files: ["scripts/**/*.{js,mjs,cjs,ts}"],
		ignores: ["**/*.test.{js,mjs,cjs,ts}"],
		plugins: { regexp },
		languageOptions: { parser: tsParser },
		linterOptions: { reportUnusedDisableDirectives: "error" },
		rules: {
			"regexp/no-super-linear-backtracking": "error",
			"regexp/no-super-linear-move": "error",
		},
	},
	globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
