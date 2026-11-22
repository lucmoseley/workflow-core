import { createRequire } from "node:module";

const require_ = createRequire(__filename);
const { buildCitableLineTest } = require_("./qualify-citations.js");
const { requiredGroup }: typeof import("./regex-group.js") =
	require_("./regex-group.js");

const HINT = /npm run ([\w:-]*)/g;

const ADOPTER_DECLARES = new Set([
	"test",
	"test:changed",
	"test:py",
	"gen:test-read-edges",
	"check:sh",
	"check:ci",
]);

const EXEMPT: Record<string, string[]> = {
	"docs/agents/rules/vercel-build-on-push.txt": ["build"],
	"scripts/check-doc-map.js": ["gen:"],
	"scripts/check-tracker-sweep.js": ["check:"],
	"scripts/generate-rule-fragments.js": ["gen:rule-fragments"],
	"scripts/lib/infer-commands.js": [""],
};

export function hintsIn(rel: string, text: string): string[] {
	const comment = buildCitableLineTest(rel);
	return text.split("\n").flatMap((line, i) =>
		comment?.(line)
			? []
			: [...line.matchAll(HINT)]
					.map((m) => requiredGroup(m, 1, HINT))
					.filter((name) => !ADOPTER_DECLARES.has(name))
					.filter((name) => !EXEMPT[rel]?.includes(name))
					.map((name) => `${rel}:${i + 1}: npm run ${name}`),
	);
}
