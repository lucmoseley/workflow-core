// @vitest-environment node
/*
 * Pins which files eslint.config.mjs's Next.js and React Hooks presets reach:
 * app/ and lib/ get their rules, scripts/ gets none, and a .tsx parses.
 *
 * It asks ESLint's own calculateConfigForFile for each path rather than
 * linting a fixture, because a preset aimed at the wrong files fails silently:
 * the presets once ran against the Node scripts and no .tsx at all. Only the
 * parser case lints, an inline snippet.
 *
 * Breaking it lets that silence back: the React rules stop running on the
 * pages they were added for (mantahostels#999).
 */

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: import.meta.dirname });

const REACT_SURFACE = [
	"app/page.tsx",
	"app/_components/SiteHeader.tsx",
	"lib/review-strip/strip.ts",
];
const NODE_SURFACE = ["scripts/pick-next.js", "scripts/check-doc-map.test.ts"];

async function severities(file: string): Promise<Record<string, number>> {
	const config = await eslint.calculateConfigForFile(file);
	return Object.fromEntries(
		Object.entries(config?.rules ?? {}).map(([rule, entry]) => [
			rule,
			(entry as [number])[0],
		]),
	);
}

describe("eslint.config.mjs", () => {
	it.each(REACT_SURFACE)(
		"enables the Next.js and React Hooks rules on %s",
		async (file) => {
			const rules = await severities(file);
			expect(rules["@next/next/no-html-link-for-pages"]).toBeGreaterThan(0);
			expect(rules["react-hooks/exhaustive-deps"]).toBeGreaterThan(0);
			// A lower bound, so a preset gaining rules passes and one silently
			// losing them does not.
			expect(Object.keys(rules).length).toBeGreaterThanOrEqual(38);
		},
	);

	it.each(NODE_SURFACE)(
		"applies no React or Next.js rules to the Node script %s",
		async (file) => {
			const rules = Object.keys(await severities(file));
			expect(
				rules.filter(
					(r) => r.startsWith("@next/next/") || r.startsWith("react-hooks/"),
				),
			).toEqual([]);
		},
	);

	it("leaves no-img-element to Biome", async () => {
		expect(
			(await severities("app/page.tsx"))["@next/next/no-img-element"],
		).toBe(0);
	});

	it("parses TSX syntax", async () => {
		const [result] = await eslint.lintText(
			"export const A = (): JSX.Element => <div />;\n",
			{
				filePath: "app/_probe.tsx",
			},
		);
		expect(result.messages.filter((m) => m.fatal)).toEqual([]);
	});
});
