import next from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";

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
// TypeScript elsewhere — scripts/, the root config files — therefore matches
// no ESLint config at all, deliberately: Biome and tsc cover it.
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
	globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
