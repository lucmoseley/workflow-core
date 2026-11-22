import next from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import regexp from "eslint-plugin-regexp";

const eslintConfig = defineConfig([
	{
		files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
		extends: [
			next.configs["core-web-vitals"],
			reactHooks.configs.flat["recommended-latest"],
		],
		languageOptions: {
			parser: tsParser,
		},
		rules: {
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
