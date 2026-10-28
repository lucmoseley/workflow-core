// @vitest-environment node
/*
 * lib/find-start.js, the guard-root-find core (#2801), in process: which
 * `find` commands start at `/` and are refused (#1006), what the refusal
 * hands over, and which pass. The first fire list and the first pass list are
 * #1006's acceptance criteria; do not thin them.
 *
 * The payload's cwd, the plugin root and the core-path rewrite are fakes
 * passed as values; the production adapters are crossed in
 * guard-root-find.test.ts. The refusal is asserted whole, its text written
 * out here rather than read from the core.
 */

import { describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";

const { decide } = require("./find-start.js") as {
	decide: (command: string, ctx: object) => { deny: string } | null;
};

const PROJECT = "/repo";
const ROOT = "/plugin";

interface Over {
	cwd?: string;
	fallbackCwd?: string;
	vars?: Record<string, string>;
	root?: string | null;
	corePaths?: (t: string) => string;
}

function harness({ root = ROOT, ...over }: Over = {}) {
	const logs: string[] = [];
	const ctx = kitContextFake({
		cwd: PROJECT,
		isDir: () => true,
		log: (what: string, detail?: string) =>
			logs.push(detail ? `${what}\t${detail}` : what),
		pluginRoot: () => root,
		...over,
	});
	return { ctx, logs };
}

const judge = (command: string, over: Over = {}) =>
	decide(command, harness(over).ctx);

/** The refusal for `shown` refused under `root`. */
const refusal = (shown: string, root = ROOT) =>
	`Refused: \`${shown}\` starts at \`/\`. A find over the whole disk under WSL2 ran to the 2-minute timeout in about half of 114 measured calls, and neither \`-maxdepth\` nor \`-xdev\` saved it (#1006). Cheapest route first:

1. This plugin's own files: ${root} — its scripts/ and docs/agents/ are there.
2. The repo's scratch, .claude/tmp/, and the repo itself.
3. Named roots: \`find /usr /opt /home -xdev -name …\`. Name /mnt/c only when the Windows disk is meant.

\`~\` and $HOME are cheap (median 5 s) and pass.`;

describe("a find started at / is refused (#1006)", () => {
	it.each([
		["find / -name x", "find / -name x"],
		["find / -maxdepth 6 -name x", "find / -maxdepth 6 -name x"],
		["find /usr / -name x", "find /usr / -name x"],
		["find -L / -name x", "find -L / -name x"],
		['find "/" -name x', 'find "…" -name x'],
		["timeout 120 find / -xdev -name x", "timeout 120 find / -xdev -name x"],
		["cd ~ && find / -name x", "find / -name x"],
		[
			"sudo find / -name x 2>/dev/null | head",
			"sudo find / -name x 2>/dev/null",
		],
		["find // -name x", "find // -name x"],
		["find /tmp/.. -name x", "find /tmp/.. -name x"],
		["cd / && find . -name x", "find . -name x"],
	])("%s", (command, shown) => {
		expect(judge(command)).toEqual({ deny: refusal(shown) });
	});

	it("refuses a bare find from a session standing in /", () => {
		expect(judge("find -name x", { cwd: "/" })).toEqual({
			deny: refusal("find -name x"),
		});
	});

	it.each([
		["/usr/bin/find / -name x", PROJECT],
		["find -H -P / -x", PROJECT],
		["find -D tree / -x", PROJECT],
		["find -O3 / -x", PROJECT],
		["find -- / -x", PROJECT],
		["find . / -x", PROJECT],
		["find /. -x", PROJECT],
		["find '/' -x", PROJECT],
		["find ./.. -x", "/tmp"],
		["find '' -x", "/"],
		["find /usr/.. -x", "/never"],
		["find -D", "/"],
		["find . -x", "/"],
	])("reads the start point of %s from %s", (command, cwd) => {
		expect(judge(command, { cwd })?.deny).toBeDefined();
	});

	it("resolves a relative start against a cd that reads a set variable", () => {
		expect(judge("cd $X && find . -x", { vars: { X: "/" } })).not.toBeNull();
	});

	it("falls back to the hook's own directory where the payload has no cwd", () => {
		expect(judge("find . -x", { cwd: undefined, fallbackCwd: "/" })).toEqual({
			deny: refusal("find . -x"),
		});
		expect(judge("find . -x", { cwd: "relative", fallbackCwd: "/" })).toEqual({
			deny: refusal("find . -x"),
		});
	});

	it("names the first refused segment only", () => {
		expect(judge("find / -a; find // -b")).toEqual({
			deny: refusal("find / -a"),
		});
	});

	it.each(["find / -x   && true", "find / -x\t\t&& true"])(
		"drops the segment's trailing whitespace: %j",
		(command) => {
			expect(judge(command)).toEqual({ deny: refusal("find / -x") });
		},
	);

	it("splices the plugin root and the command literally", () => {
		expect(judge("find / -name $$", { root: "/a$&b" })).toEqual({
			deny: refusal("find / -name $$", "/a$&b"),
		});
	});

	it("rewrites core paths in its own text before the command goes in", () => {
		const corePaths = (t: string) => t.replaceAll("docs/", "/core/docs/");
		expect(judge("find / -name docs/x", { corePaths })).toEqual({
			deny: refusal("find / -name docs/x").replace(
				"docs/agents/",
				"/core/docs/agents/",
			),
		});
	});
});

describe("a plugin root that will not resolve allows, recorded (mantahostels#147)", () => {
	it.each([[null], ["relative/root"]])("root %s", (root) => {
		const { ctx, logs } = harness({ root });
		expect(decide("find / -x", ctx)).toBeNull();
		expect(logs).toEqual([
			"the plugin root did not resolve — a find at / was allowed",
		]);
	});

	it("reads no root and records nothing on a find it passes", () => {
		const { ctx, logs } = harness({ root: null });
		expect(decide("find . -x", ctx)).toBeNull();
		expect(logs).toEqual([]);
	});
});

describe("every other start point passes silently", () => {
	it.each([
		"find ~ -name x",
		"find $HOME -name x",
		"find /home/lucmo -name x",
		"find /usr -name x",
		"find /mnt/c/Users -name x",
		"find . -name x",
		"find scripts -name x",
		'find "$state_dir" -maxdepth 1',
		"find \\( -name a \\)",
		"find -name x",
	])("%s", (command) => {
		const { ctx, logs } = harness();
		expect(decide(command, ctx)).toBeNull();
		expect(logs).toEqual([]);
	});

	it.each([
		["find \\( / \\)", PROJECT],
		["find ! /", PROJECT],
		["find -newer / -x", PROJECT],
		["find /$X -x", PROJECT],
		["find /$X/.. -x", PROJECT],
		["timeout 5", PROJECT],
		['find "$(pwd)" -x', "/"],
		["find `pwd` -x", "/"],
		["find .. -x", "/tmp/a"],
		["fd / -x", PROJECT],
		["xfind / -x", PROJECT],
		["finder / -x", PROJECT],
		["sh -c 'find / -x'", PROJECT],
		["cd - && find . -x", "/"],
		["cd $UNSET && find . -x", PROJECT],
	])("%s from %s", (command, cwd) => {
		expect(judge(command, { cwd })).toBeNull();
	});

	it.each([
		"grep -n 'find /' file",
		'echo "find / -name"',
		"cat <<'EOF'\nfind / -name x\nEOF",
	])("a mention is not a run: %s", (command) => {
		expect(judge(command)).toBeNull();
	});
});
