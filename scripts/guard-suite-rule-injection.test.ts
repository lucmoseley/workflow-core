// @vitest-environment node
/*
 * guard-suite-concurrency.sh's PRE-EMPTIVE LIMBS. The first (mantahostels#1805, spec
 * mantahostels#1762) hands over the suite-tree-dirty rule at a suite launch, before the red
 * result a session would otherwise misread as its own breakage. The second
 * (#181) rides in the same envelope on a plain `--full` over a rendering read graph,
 * where a bare `npm run test` would have met the push gate on its own. The
 * third (#2024) hands over rule:memory-figure, behind the MemAvailable reading,
 * on a build or a whole-suite launch. The fourth (#2237) hands over
 * rule:targeted-runs on an adopter's declared `commands.test` typed bare.
 *
 * Kept apart from guard-suite-concurrency.test.ts on purpose (#2135): its
 * seams and latch sessions are its own, and vitest runs files in parallel.
 *
 * gp_warn exits, so the injection is reachable only when the headroom and the
 * suite count are both fine. Every case drives both seams (WFC_MEMINFO,
 * WFC_PS) to a quiet machine.
 *
 * The guard runs as a `PreToolUse` Bash hook in the core's hooks: break a
 * case here and a session meets a neighbour's half-written red, or the push
 * gate, with no rule handed over first, and misreads it as its own breakage.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registrationsOf } from "./lib/hook-wiring";
import {
	buildBashPayload,
	guardDirs,
	guardOutput,
} from "./lib/pretool-guard-testkit";
import { writePsStub } from "./lib/ps-stub";
/* The store's Node accessor, so a test asks for a rule by id rather than
 * holding a second copy of its text. */
import { ruleText } from "./lib/rule-text";

const GUARD = path.resolve(__dirname, "guard-suite-concurrency.sh");

/**
 * A case's timeout where it spawns the guard more than once. Vitest's 5 s
 * default is one spawn's worth on a loaded machine: this file's 42 cases took
 * 26.7 s at a load of 25 (#2024's run), and a session-latch case spawns three
 * or four times.
 */
const MULTI_SPAWN_MS = 30_000;

/** Well above the three-suite rung, so the headroom warn cannot fire and swallow the injection. */
const ROOMY_KB = 8_000_000;

let dir: string;
let config: string;
let root: string;
let meminfo: string;
let fakePs: string;

beforeEach(() => {
	({ dir, config } = guardDirs("suite-rule-"));
	root = path.join(dir, "root");
	fs.mkdirSync(root);
	meminfo = path.join(dir, "meminfo");
	fs.writeFileSync(meminfo, `MemAvailable:    ${ROOMY_KB} kB\n`);
	// A `ps` naming no vitest process, so the launch is suite 1 of 3.
	fakePs = writePsStub(dir, ["sleep 1"]);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * The whole hook output for `command`, parsed. Null where it said nothing.
 *
 * `renders` drives WFC_READ_GRAPH_RENDERS, the plain-`--full` limb's seam (#181).
 * It defaults to "0" — not absent — so no case here reaches the real manifest
 * render, which would answer off the repo this test happens to run in rather
 * than off the throwaway root every other seam points at. `null` DOES leave it
 * absent, which is how the one case below reaches that render for real.
 */
const emission = (
	command: string,
	session = "test",
	renders: string | null = "0",
) =>
	guardOutput(GUARD, buildBashPayload(command, session), {
		project: root,
		config,
		cwd: root,
		env: {
			WFC_MEMINFO: meminfo,
			WFC_PS: fakePs,
			...(renders === null ? {} : { WFC_READ_GRAPH_RENDERS: renders }),
		},
	});

describe("a suite launch on a quiet machine is handed the rule", () => {
	it.each([
		["npm run test", "the full suite"],
		["npm test", "the same script without `run`"],
		["npm run test:changed", "the narrowed run reads the same tree"],
	])("%s is handed suite-tree-dirty — %s", (command) => {
		const out = emission(command);
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(ruleText("suite-tree-dirty"));
	});

	it("spends one id and stays far inside the ceiling", () => {
		// Fails once a second cluster fires on `npm run test` and shares the ceiling.
		const ctx = emission("npm run test").additionalContext as string;
		expect(ctx).toBe(ruleText("suite-tree-dirty"));
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(4000);
	});

	it(
		"says it once per session, and again for a different session",
		() => {
			expect(emission("npm run test", "sess-A")).not.toBeNull();
			expect(emission("npm run test", "sess-A")).toBeNull();
			expect(emission("npm run test", "sess-B")).not.toBeNull();
		},
		MULTI_SPAWN_MS,
	);
});

/*
 * MUTATION ANCHORS. `toContain(ruleText(…))` reads the same file the guard
 * does, so it moves with a mutation to the fragment instead of catching it.
 *
 * Reads the fragment directly, not the emission (mantahostels#2230): a row over
 * the emission stops catching a clause moved to a second fragment once one
 * joins this trigger.
 *
 * The fragment is hard-wrapped at ~80 columns, so a clause straddles a newline
 * whenever a reflow moves it. Collapsing the fragment's whitespace pins the
 * words and never the wrapping — so a wrap CANNOT be pinned here.
 */
const carries = (clause: string) =>
	expect(ruleText("suite-tree-dirty").replace(/\s+/g, " ")).toContain(clause);

describe("the injected rule still carries its operative clauses", () => {
	it("a clause no fragment carries fails", () => {
		expect(() => carries("a clause no fragment carries")).toThrow();
	});

	it.each([
		["#273", "the incident, without which the rule is a bare assertion"],
		["globalSetup", "where the two messages come from"],
		["— GONE", "the marker on a claim nobody will release"],
		["re-run before believing the result", "the act it asks for"],
		["a dirty file under no claim at all", "the blind spot"],
	])("suite-tree-dirty keeps %s — %s", (clause) => {
		carries(clause);
	});
});

const FIGURE = (kind: string) =>
	`BEFORE THIS ${kind} RUN, MemAvailable reads ${Math.floor(ROOMY_KB / 1024)} MB.`;

describe("a build or a whole-suite launch is handed the memory figure (#2024)", () => {
	it.each([
		["npm run build", "a build", "BUILD"],
		["next build", "the direct form of one", "BUILD"],
		["npm run test -- --full=rule-edit", "the whole suite", "FULL TEST"],
		["npm run test:py", "the whole pytest suite", "FULL TEST"],
	])("%s is handed the reading and the rule — %s", (command, _why, kind) => {
		const ctx = emission(command, `mem-${command}`).additionalContext as string;
		expect(ctx).toContain(FIGURE(kind));
		expect(ctx).toContain(ruleText("memory-figure"));
		expect(ctx.indexOf(FIGURE(kind))).toBeLessThan(
			ctx.indexOf(ruleText("memory-figure")),
		);
	});

	it("a build is handed no suite-tree-dirty", () => {
		const ctx = emission("npm run build").additionalContext as string;
		expect(ctx).toBe(`${FIGURE("BUILD")}\n\n${ruleText("memory-figure")}`);
	});

	it.each([
		["npm run test", "the diff's selection, not the whole suite"],
		["npm run test:changed", "the explicit narrowed spelling"],
		[
			"npm run test:py -- scripts/lib/test_a.py",
			"a pytest run naming its file",
		],
		["npm run test:watch", "a watcher, which has no end to read after"],
	])("%s is handed no figure — %s", (command) => {
		const ctx: string =
			emission(command, `narrow-${command}`)?.additionalContext ?? "";
		expect(ctx).not.toContain("MemAvailable reads");
		expect(ctx).not.toContain(ruleText("memory-figure"));
	});

	it(
		"says both once per session, and again for a different session",
		() => {
			expect(emission("npm run build", "sess-M")).not.toBeNull();
			expect(emission("npm run build", "sess-M")).toBeNull();
			const later = emission("npm run test -- --full=rule-edit", "sess-M")
				.additionalContext as string;
			expect(later).toBe(ruleText("suite-tree-dirty"));
			expect(emission("npm run build", "sess-N").additionalContext).toContain(
				FIGURE("BUILD"),
			);
		},
		MULTI_SPAWN_MS,
	);

	it("a short machine gets the headroom warn, which names the reading, and no rule", () => {
		fs.writeFileSync(meminfo, "MemAvailable:     100000 kB\n");
		const ctx = emission("npm run build", "sess-MS")
			.additionalContext as string;
		expect(ctx).toContain("MemAvailable is 97 MB");
		expect(ctx).not.toContain(ruleText("memory-figure"));
	});
});

describe("things that are not a suite launch", () => {
	it.each([
		[
			"npm run test:py -- scripts/lib/test_a.py",
			"pytest is off the ladder, and a named file owes no figure",
		],
		["npm run lint", "not a test run"],
		["echo 'npm run test when green'", "prose about a run"],
	])("%s is handed nothing — %s", (command) => {
		expect(emission(command)).toBeNull();
	});
});

describe("a warning outranks the injection, and leaves it unlatched", () => {
	it(
		"a watcher launch is warned about and handed no rule, on any machine",
		() => {
			// THE ONE SUITE LAUNCH THAT NEVER GETS THIS RULE. `npm run test:watch`
			// always draws the watcher warning (mantahostels#1927) — it costs a rung for as long
			// as it is open — and gp_warn exits, so the injection at the foot is
			// unreachable on it however quiet the machine. The rule is not spent: the
			// same session's next one-shot run gets it.
			const out = emission("npm run test:watch", "sess-W");
			expect(out.additionalContext).toContain("This opens a WATCHER");
			expect(out.additionalContext).not.toContain(ruleText("suite-tree-dirty"));
			expect(emission("npm run test", "sess-W").additionalContext).toBe(
				ruleText("suite-tree-dirty"),
			);
		},
		MULTI_SPAWN_MS,
	);

	it("a short machine gets the headroom warn and no rule", () => {
		// gp_warn EXITS, so the injection at the foot is unreachable behind any
		// warning. A `--queue` launch, since a plain one is refused (#2305).
		fs.writeFileSync(meminfo, "MemAvailable:     100000 kB\n");
		const out = emission("npm run test -- --queue", "sess-short");
		expect(out.additionalContext).toContain("MemAvailable is");
		expect(out.additionalContext).not.toContain(ruleText("suite-tree-dirty"));
	});

	it(
		"leaves the rule unspent — the next clean launch still gets it",
		() => {
			fs.writeFileSync(meminfo, "MemAvailable:     100000 kB\n");
			emission("npm run test", "sess-C");
			fs.writeFileSync(meminfo, `MemAvailable:    ${ROOMY_KB} kB\n`);
			expect(emission("npm run test", "sess-C").additionalContext).toBe(
				ruleText("suite-tree-dirty"),
			);
		},
		MULTI_SPAWN_MS,
	);
});

/* WFC_READ_GRAPH_RENDERS stands in for the limb's render half — see
 * `emission`. */
const LIMB = "WOULD MEET THE PUSH GATE HERE";

describe("a plain --full over a tree whose read graph renders is told a bare run would do", () => {
	it.each([
		["npm run test -- --full", "the spelling the rule itself names"],
		["npm test -- --full", "the same script without `run`"],
		["node scripts/run-vitest.js --full", "the wrapper, reached directly"],
		[`npm "run" "test" -- --full`, "quoted words, read as typed (#1528)"],
	])(
		"%s draws the limb — %s",
		(command) => {
			const out = emission(command, `fire-${command}`, "1");
			// A notice, not a refusal: the launch still goes ahead.
			expect(out.permissionDecision).toBeUndefined();
			const ctx = out.additionalContext as string;
			expect(ctx).toContain(LIMB);
			expect(ctx).toContain("no whole-suite run is owed");
			expect(ctx).toContain("not a refusal");
		},
		MULTI_SPAWN_MS,
	);

	it(
		"stays plain under every wrapper flag the launch carries (#188)",
		() => {
			const cmd =
				"npm run test -- --full=rule-edit --queue --isolated --shared";
			expect(emission(cmd, "sess-flags", "1").additionalContext).toContain(
				LIMB,
			);
		},
		MULTI_SPAWN_MS,
	);

	it(
		"still travels once suite-tree-dirty's own latch is spent",
		() => {
			// THE REASON THE LIMB HAS A LATCH OF ITS OWN. A session whose first
			// launch was narrowed has already spent the rule's latch, and the
			// `--full` it types later is exactly the launch this limb is for.
			expect(emission("npm run test", "sess-L", "1")).not.toBeNull();
			const ctx = emission("npm run test -- --full", "sess-L", "1")
				.additionalContext as string;
			expect(ctx).toContain(LIMB);
			expect(ctx).not.toContain(ruleText("suite-tree-dirty"));
		},
		MULTI_SPAWN_MS,
	);

	it(
		"draws the limb once per session, and again for a different session",
		() => {
			expect(
				emission("npm run test -- --full", "sess-1", "1").additionalContext,
			).toContain(LIMB);
			expect(emission("npm run test -- --full", "sess-1", "1")).toBeNull();
			expect(
				emission("npm run test -- --full", "sess-2", "1").additionalContext,
			).toContain(LIMB);
		},
		MULTI_SPAWN_MS,
	);
});

describe("the limb is silent on everything else", () => {
	it.each([
		[
			"npm run test -- --full scripts/guard-suite-rule-injection.test.ts",
			"named test files bound the run past the whole suite",
		],
		["npm run test -- --full -t nope", "a name filter narrows it further"],
		[
			"npm run test -- --full --testNamePattern=nope",
			"the long spelling of the same filter",
		],
		["npm run test -- --full --project unit", "a project filter, likewise"],
		["npm run test -- --full --project=unit", "and its `=` spelling"],
		["npm run test", "no --full at all: this run is already the diff's"],
		["npm run test:changed", "nor is the explicit narrowed spelling one"],
	])("%s draws no limb — %s", (command) => {
		const out = emission(command, `quiet-${command}`, "1");
		expect(out.additionalContext).not.toContain(LIMB);
	});

	it("is silent where the read graph will not render", () => {
		// The one case where `--full` is the right call: a bare run would
		// escalate to it anyway (#998).
		const out = emission("npm run test -- --full", "sess-stale", "0");
		expect(out.additionalContext).not.toContain(LIMB);
		expect(out.additionalContext).toContain(ruleText("suite-tree-dirty"));
	});

	it("a watcher launch draws the watcher warning and no limb", () => {
		const out = emission("npm run test:watch", "sess-WF", "1");
		expect(out.additionalContext).toContain("This opens a WATCHER");
		expect(out.additionalContext).not.toContain(LIMB);
	});
});

describe("the render check itself runs, seam or no seam", () => {
	it(
		"reaches the real read-graph render without faulting",
		() => {
			// EVERY OTHER CASE HERE DRIVES THE SEAM, so only this one executes the
			// branch that requires generate-test-read-edges.js and calls `render`.
			// The guard swallows a fault there — a renamed export, a wrong repo
			// root — into a gl_log line under CLAUDE_CONFIG_DIR, which nothing
			// else here writes; that line's absence is the assertion. The verdict
			// is not asserted: it depends on the tree this run reads.
			const out = emission("npm run test -- --full", "sess-real", null);
			expect(out.additionalContext).toContain(ruleText("suite-tree-dirty"));
			const log = path.join(config, "projects");
			expect(fs.existsSync(log)).toBe(false);
		},
		MULTI_SPAWN_MS,
	);
});

describe("an adopter's whole-suite launch is handed rule:targeted-runs (#2237)", () => {
	const adopter = ({ test = "npm run test", script = "vitest run" } = {}) => {
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify({ commands: { test } }),
		);
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ scripts: { test: script } }),
		);
	};
	/* WFC_MODULES, not the config's list: vitest.setup.ts sets it to every
	 * module, and it outranks the file. */
	const told = (
		command: string,
		session = `s-${command}`,
		modules = "suites",
	) =>
		String(
			guardOutput(GUARD, buildBashPayload(command, session), {
				project: root,
				config,
				cwd: root,
				env: {
					WFC_MEMINFO: meminfo,
					WFC_PS: fakePs,
					WFC_READ_GRAPH_RENDERS: "0",
					WFC_MODULES: modules,
				},
			})?.additionalContext ?? "",
		).includes(ruleText("targeted-runs"));

	it.each([
		["npm run test", "as declared"],
		["npm test", "the same script without `run`"],
		["npm t", "npm's alias for `test`"],
		["npm run-script test", "npm's alias for `run`"],
		["npm run test --", "a lone `--` narrows nothing"],
	])("%s is told — %s", (command) => {
		adopter();
		expect(told(command)).toBe(true);
	});

	it.each([
		["npm run test -- scripts/a.test.ts", "a named file"],
		["npm run test -- -t parses", "a name filter"],
		["npm run test:changed", "another script"],
	])("%s is not — %s", (command) => {
		adopter();
		expect(told(command)).toBe(false);
	});

	it("leads the envelope, ahead of the suite-tree-dirty rule", () => {
		adopter();
		const ctx = emission("npm run test").additionalContext as string;
		expect(ctx.indexOf(ruleText("targeted-runs"))).toBe(0);
		expect(ctx).toContain(ruleText("suite-tree-dirty"));
	});

	it(
		"says it once per session",
		() => {
			adopter();
			expect(told("npm run test", "sess-T")).toBe(true);
			expect(told("npm test", "sess-T")).toBe(false);
		},
		MULTI_SPAWN_MS,
	);

	it("is silent with suites off", () => {
		adopter();
		expect(told("npm run test", "s-off", "roadmap")).toBe(false);
	});

	it("is silent where the declared command runs run-vitest.js, which selects from the diff", () => {
		adopter({ script: "node scripts/run-vitest.js" });
		expect(told("npm run test")).toBe(false);
	});

	it(
		"reads a declared command other than an npm script",
		() => {
			adopter({ test: "node --test" });
			expect(told("node --test")).toBe(true);
			expect(told("node --test a.test.js")).toBe(false);
		},
		MULTI_SPAWN_MS,
	);

	/* hooks/hooks.json is the wiring an adopter's plugin install runs, so a
	 * declared command no registration there lets through is never told. Claude
	 * Code also tries an `if` on each subcommand of a compound command, which
	 * this does not. */
	const pluginReaches = (command: string) => {
		const manifest = JSON.parse(
			fs.readFileSync(
				path.resolve(__dirname, "..", "hooks", "hooks.json"),
				"utf8",
			),
		);
		return registrationsOf(
			"PreToolUse",
			"scripts/guard-suite-concurrency.sh",
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

	it("lets every common runner's test command through the plugin's wiring (#2303)", () => {
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

	it.each(["yarn test", "npx vitest run"])(
		"%s, declared, is told (#2303)",
		(command) => {
			adopter({ test: command });
			expect(told(command)).toBe(true);
		},
	);
});
