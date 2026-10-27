// @vitest-environment node
/*
 * guard-suite-concurrency.js refuses a test suite launched under the resting
 * headroom docs/environment.md §6 measures, or beside a running whole suite,
 * sending it to the queue (#2305, #2680); warns a build or a queued launch;
 * and hands a quiet launch its rules once a session (mantahostels#1805, #181,
 * #2024, #2237). These are its boundary cases: the
 * payload, the env seams, the host's own files, the rule store, the latch and
 * the stand-down log, end to end (#2795). Which launch draws which verdict and
 * which text is lib/suite-concurrency.test.ts's.
 *
 * The guard runs in process (base §X3) with a fabricated `/proc/meminfo` at
 * WFC_MEMINFO and a stub `ps` at WFC_PS, so no verdict depends on the machine
 * running the suite, save the one case that crosses both for real. One case
 * keeps a spawn, saying so where it stands: the registered hook line, which
 * is a shell command, and node missing from PATH, which only a real process
 * can lack.
 *
 * The guard is a `PreToolUse` Bash hook: break it and a second whole suite, or
 * a launch under the measured headroom, runs unrefused into the 10 GB cap that
 * earlyoom enforces by killing live sessions; make it throw and every launch
 * goes unjudged in silence, its fail-open line the only trace.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import { registrationsOf } from "./lib/hook-wiring";
import {
	buildBashPayload,
	guardDirs,
	guardOutput,
	nodeGuardOutput,
	readHookLines,
	runNodeGuard,
} from "./lib/pretool-guard-testkit";
import { writePsStub } from "./lib/ps-stub";
import { readRuleText } from "./lib/rule-text";

const GUARD = path.resolve(__dirname, "guard-suite-concurrency.js");

/** Well above the three-suite rung, so no headroom warn swallows a verdict. */
const ROOMY_MB = 8000;

const RUNNER = "node /r/node_modules/.bin/vitest run";

let dir: string;
let config: string;
let root: string;
let meminfo: string;
let quietPs: string;

beforeEach(() => {
	({ dir, config } = guardDirs("suite-concurrency-"));
	root = path.join(dir, "root");
	fs.mkdirSync(root);
	meminfo = path.join(dir, "meminfo");
	setMb(ROOMY_MB);
	quietPs = writePsStub(dir, ["sleep 1"], { name: "ps-quiet" });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const setMb = (mb: number) =>
	fs.writeFileSync(meminfo, `MemAvailable:    ${mb * 1024} kB\n`);

const psOf = (lines: string[], name: string) =>
	writePsStub(dir, lines, { name });

const markers = () => path.join(root, ".claude", "tmp", "markers");

const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
};

/** The seams every case pins, the escape and the queue's mark CLEARED, not
 * merely unset: a run from a shell that exported either would otherwise pass
 * against a guard that stood itself down. */
const seams = (over: Record<string, string | undefined> = {}) => ({
	WFC_MEMINFO: meminfo,
	WFC_PS: quietPs,
	WFC_READ_GRAPH_RENDERS: "0",
	WFC_SUITE_CONCURRENT: "",
	...over,
});

/** The hook output for `command`, parsed; null where it said nothing. */
const emission = (
	command: string,
	{
		session = "test",
		env = {},
	}: { session?: string; env?: Record<string, string | undefined> } = {},
) =>
	nodeGuardOutput(GUARD, buildBashPayload(command, session), {
		project: root,
		config,
		cwd: root,
		env: seams(env),
	});

/** The raw run, for a case reading the streams or a malformed payload. */
const raw = (
	payload: unknown,
	env: Record<string, string | undefined> = {},
	stdin?: string,
) =>
	runNodeGuard(GUARD, payload, {
		project: root,
		config,
		cwd: root,
		env: seams(env),
		stdin,
	});

const failOpenLog = () => readFailOpenLog(config, root);

describe("each exit path", () => {
	it("refuses as `permissionDecision` JSON on exit 0, on either limb, in the documented envelope alone", () => {
		const one = psOf([RUNNER], "ps-one");
		for (const [mb, ps] of [
			[ROOMY_MB, one],
			[1000, quietPs],
		] as const) {
			setMb(mb);
			const r = raw(
				{ ...buildBashPayload("npm run test", "test"), cwd: root },
				{ WFC_PS: ps },
			);
			expect(r.status).toBe(0);
			expect(r.stderr).toBe("");
			const out = JSON.parse(r.stdout);
			/* The limb rides for the queue's poll alone (#2421): a session's
			 * envelope carries no key Claude Code does not document. */
			expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
			expect(Object.keys(out.hookSpecificOutput).sort()).toEqual([
				"hookEventName",
				"permissionDecision",
				"permissionDecisionReason",
			]);
			expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
			expect(
				out.hookSpecificOutput.permissionDecisionReason.split("\n")[0],
			).toBe("Run instead: npm run test -- --queue");
		}
	});

	it("warns as additionalContext, refusing nothing", () => {
		setMb(1000);
		const out = emission("npm run build");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toMatch(
			/^MemAvailable is 1000 MB, under the ~2900 MB/,
		);
	});

	it("hands a quiet launch its rule as additionalContext, refusing nothing", () => {
		const out = emission("npm run test");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toBe(readRuleText("suite-tree-dirty"));
	});

	it("says nothing to a command that launches nothing", () => {
		expect(emission("git status")).toBeNull();
	});
});

/*
 * THE LATCH (mantahostels#1805): each rule once a session, under the markers
 * directory of the project root, keyed on the payload's session_id. It lands
 * at CLAUDE_PROJECT_DIR and never the checkout (mantahostels#2025).
 */
describe("once a session, end to end", () => {
	it("says suite-tree-dirty once per session, latched under the project's markers, and again for a different session", () => {
		expect(emission("npm run test", { session: "sess-A" })).not.toBeNull();
		expect(
			fs.existsSync(
				path.join(markers(), ".rule-injected-suite-tree-dirty-main-sess-A"),
			),
		).toBe(true);
		expect(emission("npm run test", { session: "sess-A" })).toBeNull();
		expect(emission("npm run test", { session: "sess-B" })).not.toBeNull();
	});

	it("hands the memory figure with the rule's first telling alone", () => {
		const figure = `BEFORE THIS BUILD RUN, MemAvailable reads ${ROOMY_MB} MB.`;
		expect(
			emission("npm run build", { session: "sess-M" }).additionalContext,
		).toBe(`${figure}\n\n${readRuleText("memory-figure")}`);
		expect(emission("npm run build", { session: "sess-M" })).toBeNull();
		expect(
			emission("npm run test -- --full=rule-edit", { session: "sess-M" })
				.additionalContext,
		).toBe(readRuleText("suite-tree-dirty"));
		expect(
			emission("npm run build", { session: "sess-N" }).additionalContext,
		).toContain(figure);
	});

	it("leaves the rule unspent behind a warning, so the next clean launch still gets it", () => {
		expect(
			emission("npm run test:watch", { session: "sess-W" }).additionalContext,
		).toContain("This opens a WATCHER");
		setMb(100);
		emission("npm run test -- --queue", { session: "sess-W" });
		setMb(ROOMY_MB);
		expect(
			emission("npm run test", { session: "sess-W" }).additionalContext,
		).toBe(readRuleText("suite-tree-dirty"));
	});

	const Limb = "WOULD MEET THE PUSH GATE HERE";
	const limb = (session: string) =>
		emission("npm run test -- --full", {
			session,
			env: { WFC_READ_GRAPH_RENDERS: "1" },
		});

	it("draws the plain-`--full` limb once per session, under a latch of its own, and again for a different session (#181)", () => {
		// A session whose first launch was narrowed has spent the rule's
		// latch; the `--full` it types later is the launch the limb is for.
		expect(emission("npm run test", { session: "sess-L" })).not.toBeNull();
		expect(limb("sess-L").additionalContext).toContain(Limb);
		expect(
			fs.existsSync(
				path.join(
					markers(),
					".rule-injected-warn.full-suite-admissible-main-sess-L",
				),
			),
		).toBe(true);
		expect(limb("sess-L")).toBeNull();
		expect(limb("sess-2").additionalContext).toContain(Limb);
	});

	it("hands an adopter's declared whole-suite launch rule:targeted-runs once per session, off its own config and package.json (#2237)", () => {
		write(
			".claude/workflow-core.json",
			JSON.stringify({ commands: { test: "npm run test" } }),
		);
		write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
		/* WFC_MODULES, not the config's list: vitest.setup.ts sets it to every
		 * module, and it outranks the file. */
		const env = { WFC_MODULES: "suites" };
		const ctx = emission("npm run test", { session: "sess-T", env })
			.additionalContext as string;
		expect(ctx.indexOf(readRuleText("targeted-runs"))).toBe(0);
		expect(ctx).toContain(readRuleText("suite-tree-dirty"));
		expect(emission("npm test", { session: "sess-T", env })).toBeNull();
	});

	it("says nothing and logs where the payload carries no session, a latch having no key", () => {
		const r = raw(buildBashPayload("npm run test", null));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(failOpenLog()).toContain(
			"no session_id in payload — rule injection skipped",
		);
	});
});

/*
 * THE STAND-DOWN LOG (mantahostels#2183): one JSON line per command stood
 * down, at .claude/tmp/markers/.suite-standdowns.jsonl, joined forward by
 * time to the next pass marker.
 */
describe("the escape exported into the hook's environment", () => {
	const log = () => path.join(markers(), ".suite-standdowns.jsonl");

	it("stands the count cap down and appends the stand-down under the markers dir, a parseable ISO stamp on it", () => {
		const out = emission("npm run test", {
			env: { WFC_SUITE_CONCURRENT: "1", WFC_PS: psOf([RUNNER], "ps-one") },
		});
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toMatch(
			/This would be suite 2 on a machine that runs whole suites one at a time/,
		);
		const rows = fs
			.readFileSync(log(), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(rows).toEqual([
			{
				at: expect.stringMatching(
					/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
				),
				session: "test",
				running: 1,
				nth: 2,
				limb: "count",
				command: "npm run test",
			},
		]);
		expect(Number.isFinite(Date.parse(rows[0].at))).toBe(true);
		expect(failOpenLog()).toBe("");
	});

	it("fails open on a log it cannot append to, letting the launch through and recording why", () => {
		fs.mkdirSync(log(), { recursive: true });
		const out = emission("npm run test", {
			env: { WFC_SUITE_CONCURRENT: "1", WFC_PS: psOf([RUNNER], "ps-one") },
		});
		expect(out.permissionDecision).toBeUndefined();
		expect(failOpenLog()).toContain("went uncounted");
	});
});

describe("the seams and the fail-open record (mantahostels#103 §6, mantahostels#147)", () => {
	it("allows unchecked where MemAvailable cannot be read, recording it under CLAUDE_CONFIG_DIR", () => {
		const r = raw(buildBashPayload("npm run test", "test"), {
			WFC_MEMINFO: path.join(dir, "no-such-meminfo"),
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(failOpenLog()).toContain("MemAvailable unreadable");
	});

	it("judges as if no suite ran where `ps` will not run, recording it", () => {
		setMb(1000);
		const out = emission("npm run test", {
			env: { WFC_PS: path.join(dir, "no-such-ps") },
		});
		expect(out.permissionDecisionReason).toMatch(/MemAvailable is 1000 MB/);
		expect(failOpenLog()).toContain("ps unreadable");
	});

	it("allows unchecked, recording it, where the payload is not JSON", () => {
		const r = raw(null, {}, "{not json");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(failOpenLog()).toContain("payload did not parse as JSON");
	});

	/* The paired negative: a run whose reads all land records nothing. */
	it("records nothing where every read lands", () => {
		setMb(1000);
		emission("npm run test -- --queue");
		expect(failOpenLog()).toBe("");
	});
});

describe("the production adapters, crossed for real", () => {
	/* The verdict is the machine's; that both reads landed is the assertion. */
	it("reads the real /proc/meminfo and the real `ps` without faulting", () => {
		const r = raw(buildBashPayload("npm run test -- --queue", "test"), {
			WFC_MEMINFO: undefined,
			WFC_PS: undefined,
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(failOpenLog()).toBe("");
	});

	it("reads package.json's script, sending a plain-vitest `test` through queue-run.js (#1776)", () => {
		write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
		const out = emission("npm run test", {
			env: { WFC_PS: psOf([RUNNER], "ps-one") },
		});
		expect(out.permissionDecisionReason.split("\n")[0]).toBe(
			"Run instead: node scripts/queue-run.js -- npm run test",
		);
	});

	it("offers the flag on a package.json it cannot parse, and logs the fail-open", () => {
		write("package.json", "{");
		const out = emission("npm run test", {
			env: { WFC_PS: psOf([RUNNER], "ps-one") },
		});
		expect(out.permissionDecisionReason.split("\n")[0]).toBe(
			"Run instead: npm run test -- --queue",
		);
		expect(failOpenLog()).toContain("package.json unreadable");
	});

	it("counts the host's declared suiteRunners off its config (#330)", () => {
		write(
			".claude/workflow-core.json",
			JSON.stringify({ suiteRunners: ["scripts/build-site.js"] }),
		);
		const out = emission("npm run test", {
			env: {
				WFC_PS: psOf(["node /home/u/fb/scripts/build-site.js"], "ps-runner"),
			},
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"1 whole suite(s) already running, and the machine runs one at a time",
		);
	});

	it("prints the build rule from the store beside a running `next build` (#1733)", () => {
		const out = emission("npm run build", {
			env: {
				WFC_PS: psOf(["node /r/node_modules/.bin/next build"], "ps-build"),
			},
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			readRuleText("build-concurrency"),
		);
	});

	it("reaches the real read-graph render without faulting", () => {
		// EVERY OTHER CASE DRIVES WFC_READ_GRAPH_RENDERS, so only this one
		// requires lib/read-edges-render.js and calls `render`. A fault
		// there — a renamed export, a wrong repo root — is swallowed into
		// the fail-open log, whose silence is the assertion. The verdict
		// depends on the tree this run reads, so it is not asserted.
		const out = emission("npm run test -- --full", {
			session: "sess-real",
			env: { WFC_READ_GRAPH_RENDERS: undefined },
		});
		expect(out.additionalContext).toContain(readRuleText("suite-tree-dirty"));
		expect(failOpenLog()).toBe("");
	});
});

describe("the entry's header", () => {
	/* The deny is cut to what changes the next call (#519); its reasons live
	 * here. */
	it("keeps the deny's reasons", () => {
		const header = fs.readFileSync(GUARD, "utf8").split("\nconst { run }")[0];
		for (const text of ["#482", "2,113 bytes", "86%", "#2680"])
			expect(header, text).toContain(text);
	});
});

describe("the plugin's wiring (#2303)", () => {
	/* hooks/hooks.json is the wiring an adopter's plugin install runs, so a
	 * declared command no registration there lets through is never told.
	 * Claude Code also tries an `if` on each subcommand of a compound command,
	 * which this does not. */
	const pluginReaches = (command: string) => {
		const manifest = JSON.parse(
			fs.readFileSync(
				path.resolve(__dirname, "..", "hooks", "hooks.json"),
				"utf8",
			),
		);
		return registrationsOf(
			"PreToolUse",
			"scripts/guard-suite-concurrency.js",
			manifest,
		).some((r) => {
			if (
				r.matcher !== undefined &&
				!new RegExp(`^(${r.matcher})$`).test("Bash")
			)
				return false;
			if (r.if === undefined) return true;
			const glob = /^Bash\((.*)\)$/s.exec(r.if)?.[1];
			if (glob === undefined) return false;
			const pattern = glob
				.split("*")
				.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*");
			return new RegExp(`^${pattern}$`, "s").test(command);
		});
	};

	it("is one shell-form line on every narrowing, failing closed, in the plugin and the self-plugin alike", () => {
		const pluginRoot = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");
		for (const [file, hookRoot] of [
			["hooks/hooks.json", `"${pluginRoot}"`],
			["self-plugin/hooks/hooks.json", '"$CLAUDE_PROJECT_DIR"'],
		]) {
			const entries = Object.values(
				JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", file), "utf8"))
					.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>,
			)
				.flat()
				.flatMap((group) => group.hooks)
				.filter((hook) =>
					String(hook.command).includes("guard-suite-concurrency"),
				);
			expect(entries).toHaveLength(12);
			for (const entry of entries) {
				expect(entry).toMatchObject({
					command: `command -v node >/dev/null 2>&1 || exit 0; node ${hookRoot}/scripts/guard-suite-concurrency.js`,
					onFailure: "block",
				});
				// Shell form, so the harness runs it through a shell (mantahostels#2059).
				expect(entry).not.toHaveProperty("args");
			}
		}
	});

	/* A spawn: the line is a shell command, and only a real process can be
	 * missing node. */
	it("runs the self-plugin line through bash as the harness does: refusing, and silent where node is not on PATH", () => {
		const [line] = readHookLines(
			"self-plugin/hooks/hooks.json",
			"scripts/guard-suite-concurrency.js",
		);
		fs.symlinkSync(path.resolve(__dirname), path.join(root, "scripts"));
		const through = (env: Record<string, string>) =>
			guardOutput("/bin/bash", buildBashPayload("npm run test", "s1"), {
				project: root,
				config,
				cwd: root,
				args: ["-c", line],
				env: seams({ WFC_PS: psOf([RUNNER], "ps-line"), ...env }),
			});
		expect(through({}).permissionDecision).toBe("deny");
		expect(through({ PATH: "/nonexistent" })).toBeNull();
	});

	it("lets every common runner's test command through", () => {
		for (const command of [
			"yarn test",
			"npx vitest run",
			"pnpm test",
			"bun test",
			"make test",
			"cargo test",
			"go test ./...",
		])
			expect([command, pluginReaches(command)]).toEqual([command, true]);
		expect(pluginReaches("git status")).toBe(false);
	});
});
