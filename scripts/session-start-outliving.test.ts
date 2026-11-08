// @vitest-environment node
/*
 * Every child a session start launches to outlive its session goes through
 * the outliving launch (#4706): lib/user-scope.js's spawnOutliving or
 * lib/detach.sh's `outlive`. Detached any other way, it is born in the
 * session's scope under its id, and a short session's end kills it mid-run —
 * or, outside the scope by some other route, it runs unbounded.
 *
 * The walk starts at every script a SessionStart registration names and
 * follows lib/code-edges.js's edges, plus the launcher's `"$here/<script>"`
 * launches. It reads each file lexically, comment lines skipped:
 *   JS — a `detached: true` spawn whose child is `.unref()`ed within
 *     UNREF_REACH lines, the shape of a child nothing waits on;
 *   shell — `setsid`, `nohup`, `disown` or lib/detach.sh's `detach`.
 * Residual: a child left referenced, or spawned without `detached`, is
 * unseen; so is a launch through a path no edge reads.
 *
 * full-sweep-only: reads every script a SessionStart registration reaches,
 * a set no literal here can name.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { flattenHooks } = require("./lib/core-hooks.js");
const { edgesOf } = require("./lib/code-edges.js");

const ROOT = path.join(__dirname, "..");
const REGISTRATIONS = [
	"hooks/hooks.json",
	"self-plugin/hooks/hooks.json",
	".claude/settings.json",
];
const COMMAND_SCRIPT = /(?<![\w.-])(scripts\/[\w./-]+\.(?:[cm]?[jt]s|sh|py))/g;
const HERE_LAUNCH = /"\$here\/([\w./-]+\.(?:sh|js|py))"/g;
const UNREF_REACH = 15;
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|#)/;
const SHELL_DETACH =
	/(?:^|[;&|]\s*|\|\|\s*|then\s+)(?:setsid|nohup|disown|detach)\b/;

/* The primitive's own home. */
const PRIMITIVE = new Set([
	"scripts/lib/detach.sh",
	"scripts/lib/user-scope.js",
]);

/* The one launch left in the session: it moves the session into its scope
 * (#4341), so it must run in the session's own cgroup. */
const IN_SESSION = 'detach node "$here/session-scope.js"';

/*
 * Libraries the walk reaches only because a session-start script shares
 * them, whose detached launch runs from elsewhere: #4706's out-of-scope
 * routes, each either in a session and rightly killed with it, or leaving by
 * its own route.
 */
const NOT_AT_SESSION_START: Record<string, string> = {
	"scripts/lib/refill-repos.js": "the refill loop's own children",
	"scripts/lib/headless-sessions.js": "the headless-session helpers",
	"scripts/lib/guard-entry.js": "a PostToolUse guard's launch",
};

function sessionStartEntries(): string[] {
	const out: string[] = [];
	for (const rel of REGISTRATIONS) {
		const file = path.join(ROOT, rel);
		if (!fs.existsSync(file)) continue;
		const hooks = JSON.parse(fs.readFileSync(file, "utf8"))?.hooks ?? {};
		for (const h of flattenHooks(hooks))
			if (h.event === "SessionStart" && typeof h.command === "string")
				for (const m of h.command.matchAll(COMMAND_SCRIPT))
					out.push(m[1] as string);
	}
	return out;
}

/** Every file under scripts/ a session start runs or loads, repo-relative. */
function sessionStartCode(): string[] {
	const scripts = path.join(ROOT, "scripts") + path.sep;
	const seen = new Set<string>();
	const queue = sessionStartEntries().map((rel) => path.join(ROOT, rel));
	for (let abs = queue.pop(); abs !== undefined; abs = queue.pop()) {
		if (seen.has(abs) || !abs.startsWith(scripts) || !fs.existsSync(abs))
			continue;
		seen.add(abs);
		const text = fs.readFileSync(abs, "utf8");
		queue.push(
			...edgesOf(abs, text, () => {
				/* a foreign Python import is plugin-tree.js's fault to report */
			}),
		);
		if (abs.endsWith(".sh"))
			for (const m of text.matchAll(HERE_LAUNCH))
				queue.push(path.join(path.dirname(abs), m[1] as string));
	}
	return [...seen].map((abs) => path.relative(ROOT, abs)).sort();
}

/** Each launch in `rel` that detaches a child nothing waits on. */
function detachSites(rel: string): string[] {
	const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
	const sites: string[] = [];
	lines.forEach((line, i) => {
		if (COMMENT_LINE.test(line)) return;
		const near = lines.slice(Math.max(0, i - UNREF_REACH), i + UNREF_REACH);
		const detached = rel.endsWith(".sh")
			? SHELL_DETACH.test(line)
			: /\bdetached:\s*true\b/.test(line) &&
				near.some((l) => l.includes(".unref()"));
		if (detached) sites.push(`${rel}:${i + 1}: ${line.trim()}`);
	});
	return sites;
}

describe("a session start's outliving children", () => {
	const code = sessionStartCode();

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
			.flatMap(detachSites)
			.filter((site) => !site.endsWith(IN_SESSION));
		expect(stray).toEqual([]);
	});

	it("keeps the session's own scope job on its plain detach", () => {
		expect(detachSites("scripts/session-start-sweeps.sh")).toEqual([
			expect.stringMatching(/session-scope\.js"$/),
		]);
	});

	/* An entry whose launch has gone, or that a session start no longer
	 * reaches, would hide the next one. */
	it("names in NOT_AT_SESSION_START only libraries reached that still detach", () => {
		for (const rel of Object.keys(NOT_AT_SESSION_START)) {
			expect(code).toContain(rel);
			expect(detachSites(rel)).not.toEqual([]);
		}
	});
});
