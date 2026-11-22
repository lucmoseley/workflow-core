// @vitest-environment node
// full-sweep-only: #4707

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { readHookCode } = require("./lib/hook-code.js");

const ROOT = path.join(__dirname, "..");
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|#)/;
const SHELL_DETACH =
	/(?:^|[;&|]\s*|\|\|\s*|then\s+)(?:setsid|nohup|disown|detach)\b|(?<![&>|])&\s*(?:$|[;)#])/;
const JS_DETACH = /\bdetached:\s*true\b/;
const UNREF_REACH = 15;

const PRIMITIVE = new Set([
	"scripts/lib/detach.sh",
	"scripts/lib/user-scope.js",
]);

const IN_SESSION = 'detach node "$here/session-scope.js"';

const NOT_AT_SESSION_START: Record<string, { why: string; sites: number }> = {
	"scripts/lib/refill-repos.js": {
		why: "startDetachedIn, the refill loop's children",
		sites: 1,
	},
	"scripts/lib/guard-entry.js": {
		why: "startDetached, a PostToolUse guard's launch",
		sites: 1,
	},
};

function readDetachSites(rel: string): string[] {
	const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
	const sites: string[] = [];
	lines.forEach((line, i) => {
		if (COMMENT_LINE.test(line)) return;
		const near = lines.slice(Math.max(0, i - UNREF_REACH), i + UNREF_REACH);
		const detached = rel.endsWith(".sh")
			? SHELL_DETACH.test(line)
			: JS_DETACH.test(line) && near.some((l) => l.includes(".unref()"));
		if (detached) sites.push(`${rel}:${i + 1}: ${line.trim()}`);
	});
	return sites;
}

describe("a session start's outliving children", () => {
	const code = [...readHookCode(ROOT, "SessionStart")].sort();

	it("reaches the launcher's jobs, so the walk is not vacuous", () => {
		expect(code).toEqual(
			expect.arrayContaining([
				"scripts/session-start-sweeps.sh",
				"scripts/repo-checks.js",
				"scripts/check-self-throttling.js",
				"scripts/audit-escape-lines.js",
			]),
		);
	});

	it("detach by no route but the outliving launch, bar the session's own scope", () => {
		const stray = code
			.filter((rel) => !PRIMITIVE.has(rel) && !(rel in NOT_AT_SESSION_START))
			.flatMap(readDetachSites)
			.filter((site) => !site.endsWith(IN_SESSION));
		expect(stray).toEqual([]);
	});

	it("keeps the session's own scope job on its plain detach", () => {
		expect(readDetachSites("scripts/session-start-sweeps.sh")).toEqual([
			expect.stringMatching(/session-scope\.js"$/),
		]);
	});

	it("names in NOT_AT_SESSION_START only libraries reached, at their count of sites", () => {
		for (const [rel, { sites }] of Object.entries(NOT_AT_SESSION_START)) {
			expect(code).toContain(rel);
			expect(readDetachSites(rel)).toHaveLength(sites);
		}
	});
});
