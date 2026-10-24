// @vitest-environment node
/*
 * guard-push-rules.sh states the push rules before a push rather than after one
 * (mantahostels#1648, spec mantahostels#1762). It carries four rules — three of them, since
 * #742, only to a host meeting its premise — and none of them has anything to
 * refuse, so it never denies a push. It exits 2 on one fault alone: a fragment
 * it cannot read.
 *
 * The shared deny fixtures (guard-log-fixture, guard-parse-fixture) are NOT
 * used here for that reason: both drive a payload they expect to be denied.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`) and is the only route by which the push rules reach a
 * session before it pushes: break it and a session pushes uncovered or
 * unreviewed commits unwarned; make it deny and every push is wedged.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import { defineTemplate, mkScratchDir, trioTemplate } from "./lib/git-fixture";
import {
	buildBashPayload,
	guardOutput,
	spawnGuard,
} from "./lib/pretool-guard-testkit";
import { shellConst } from "./lib/shell-const-testkit";

const GUARD = path.resolve(__dirname, "guard-push-rules.sh");
const GP_RULE_CAP = shellConst(
	path.resolve(__dirname, "lib", "guard-parse.sh"),
	"GP_RULE_CAP",
);
/* The store's Node accessor, so a test asks for a rule by id rather than holding
 * a second copy of its text. CommonJS, hence the require. */
const { ruleText } = require("./lib/rule-text") as {
	ruleText: (id: string) => string;
};

let dir: string;
let config: string;
let shared: string;
let worktree: string;
let elsewhere: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2016), not rebuilt per test, via
 * scripts/lib/git-fixture.ts (mantahostels#2068). This guard's `wt` is detached, not on
 * a branch, so it opts into `trioTemplate()`'s detached variant.
 */
const template = defineTemplate(trioTemplate({ worktree: "detach" }));

beforeEach(() => {
	dir = mkScratchDir("push-rules-");
	config = path.join(dir, "config");
	fs.mkdirSync(config);
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The whole hook output for `command`, parsed. Null where it said nothing.
 *  `unset` leaves names out of the guard's env; `stderr` is what the guard
 *  may print there, nothing by default. */
const emission = (
	command: string,
	session = "test",
	cwd = shared,
	{ unset = [], stderr }: { unset?: string[]; stderr?: RegExp } = {},
) =>
	guardOutput(GUARD, buildBashPayload(command, session), {
		project: shared,
		config,
		cwd,
		env: Object.fromEntries(unset.map((name) => [name, undefined])),
		stderr,
	});

/** The fixture host's `.claude/workflow-core.json`. */
const declare = (cfg: object) => {
	fs.mkdirSync(path.join(shared, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(shared, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, ...cfg }),
	);
};

const workflow = (name: string, body: string) => {
	fs.mkdirSync(path.join(shared, ".github", "workflows"), { recursive: true });
	fs.writeFileSync(path.join(shared, ".github", "workflows", name), body);
};

const SWEEP = "on:\n  schedule:\n    - cron: '0 */6 * * *'\n";
const ON_PUSH = "on:\n  push:\n    branches: [main]\n";

/* push-cadence's headline less the command it names, which a fixture host
 * spells as its own or the plugin default (#814). */
const CADENCE = "FINDS EVERY COMMIT BEING PUSHED COVERED";

/** A fragment as a host declaring no `push_check` reads it: the plugin's own
 * script in place of this repo's npm script (#814). */
const undeclared = (text: string) =>
	text.replaceAll(
		"npm run push:check",
		`node ${path.join(__dirname, "push-check.js")}`,
	);

/** A fixture-host package.json whose `npm run test` runs `test` — by default a
 * command that writes the test-pass marker, as this repo's does. */
const npmTest = (test = "node scripts/run-vitest.js") =>
	fs.writeFileSync(
		path.join(shared, "package.json"),
		JSON.stringify({ scripts: { test } }),
	);

describe("a push is handed its rules, and refused nothing", () => {
	// A host meeting every rule's premise (#742); the suite's WFC_MODULES
	// default already switches `suites` on.
	beforeEach(() => {
		declare({
			commands: {
				test: "npm run test",
				typecheck: "npm run typecheck",
				check: "npm run check",
				push_check: "npm run push:check",
			},
			deploy: "vercel",
		});
		npmTest();
		workflow("scheduled-checks.yml", SWEEP);
	});

	it.each([
		["git push origin main", "the spelling the conventions prescribe"],
		["git push", "the bare form"],
		["git push --force origin main", "a force-push is still a push"],
		["git -C . push", "reached through git's own -C"],
		["npm run test && git push origin main", "the tail of a chain"],
	])("%s is handed the rules — %s", (command) => {
		const out = emission(command);
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(ruleText("push-cadence"));
		expect(out.additionalContext).toContain(ruleText("push-green-suite"));
		// Neither is path-scoped: Vercel builds and deploys every push to `main`
		// whatever it touched, and the CI lag is a property of the schedule.
		expect(out.additionalContext).toContain(ruleText("vercel-build-on-push"));
		expect(out.additionalContext).toContain(ruleText("ci-status-lag"));
	});

	it("states the cadence first, the qualification second", () => {
		// gp_rule takes its ids in priority order and concatenates in that order.
		// The cadence carries the run-these-then-push recipe; the green-suite rule
		// qualifies it, and reads as a non-sequitur ahead of it.
		const ctx = emission("git push origin main").additionalContext as string;
		expect(ctx.indexOf(CADENCE)).toBeGreaterThan(-1);
		expect(ctx.indexOf(CADENCE)).toBeLessThan(
			ctx.indexOf("A PUSH WARNS UNLESS"),
		);
	});

	it("a push from a linked worktree is handed them too", () => {
		// A worktree pushes the same `main`, and the green-suite warning fires
		// there as well (mantahostels#1256) — so the walker is the repo-wide one (mantahostels#1213).
		const out = emission("git push origin main", "test", worktree);
		expect(out).not.toBeNull();
		expect(out.additionalContext).toContain(ruleText("push-cadence"));
	});
});

describe("the landing module swaps in the landing route's texts (#2409)", () => {
	const told = (modules: string[]) => {
		declare({
			modules,
			commands: { test: "npm run test", push_check: "npm run push:check" },
		});
		npmTest();
		workflow("scheduled-checks.yml", SWEEP);
		return emission("git push origin main:landing", "test", shared, {
			unset: ["WFC_MODULES"],
		})?.additionalContext as string;
	};
	/* The two green-suite texts share a headline. */
	const textPairs = [
		["PUSH WHEN", "PUSH TO `landing` WHEN"],
		["merge-base(HEAD, origin/main)", "merge-base(HEAD, origin/landing)"],
		["THIS PUSH DOES NOT TRIGGER", "IS TESTED BY THE LANDER"],
	];

	it("hands the -landing twins, and none of today's texts, with it on", () => {
		const ctx = told(["suites", "landing"]);
		for (const [today, twin] of textPairs) {
			expect(ctx).toContain(twin);
			expect(ctx).not.toContain(today);
		}
		expect(ctx).toContain("landing-status.js");
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(GP_RULE_CAP);
	});

	it("hands today's texts, and none of the twins, with it off", () => {
		const ctx = told(["suites"]);
		for (const [today, twin] of textPairs) {
			expect(ctx).toContain(today);
			expect(ctx).not.toContain(twin);
		}
		expect(ctx).not.toContain("landing-status.js");
	});

	it("withholds the green-suite twin where suites is off", () => {
		const ctx = told(["landing"]);
		expect(ctx).toContain("PUSH TO `landing`");
		expect(ctx).not.toContain("WARNS UNLESS");
	});
});

describe("each rule goes only to a host meeting its premise (#742)", () => {
	/** Read off the fixture's own config, not the suite's WFC_MODULES default. */
	const told = (session: string) =>
		emission("git push origin main", session, shared, {
			unset: ["WFC_MODULES"],
		})?.additionalContext as string;
	const headline = (id: string) =>
		id === "push-cadence" ? CADENCE : ruleText(id).split("\n")[0];

	it("a host with no config, package.json, CI or deploy is told of nothing it lacks", () => {
		const ctx = told("bare");
		expect(ctx).toContain(headline("push-cadence"));
		/* No `push_check` declared: the plugin's own script, which runs anywhere (#814). */
		expect(ctx).toContain("/scripts/push-check.js` FINDS");
		expect(ctx).toContain("\n  <the edited file's own checker>\n  git push");
		expect(ctx).not.toMatch(
			/Vercel|next build|sweep|npm run|check:ci|\{command:/,
		);
	});

	it("names the host's declared commands, dropping the line of an undeclared one", () => {
		declare({ commands: { push_check: "make push-check" } });
		expect(told("declared")).toContain(
			"\n  make push-check\n  <the edited file's own checker>\n",
		);
		/* The whole-repo Biome pass reaches the recipe only once declared (#2018). */
		declare({
			commands: { push_check: "make push-check", check: "npm run check" },
		});
		expect(told("declared-check")).toContain(
			"\n  make push-check\n  npm run check\n  <the edited file's own checker>\n",
		);
	});

	it.each([
		[
			"push-green-suite",
			"suites on and an npm test script",
			() => {
				declare({ modules: ["suites"] });
				npmTest();
			},
		],
		[
			"push-green-suite",
			"suites on and no test command declared, which the pre-push check warns on too (#758)",
			() => {
				declare({ modules: ["suites"] });
				fs.writeFileSync(path.join(shared, "package.json"), "{}");
			},
		],
		[
			"vercel-build-on-push",
			"a declared deploy",
			() => declare({ deploy: "vercel" }),
		],
		[
			"ci-status-lag",
			"the scheduled sweep check:ci reads",
			() => workflow("scheduled-checks.yml", SWEEP),
		],
	])("%s goes to a host with %s, and not before", (id, _premise, meet) => {
		expect(told("before")).not.toContain(headline(id));
		meet();
		expect(told("after")).toContain(undeclared(ruleText(id)));
	});

	it.each([
		[
			"a workflow run on push is no sweep",
			"ci-status-lag",
			() => workflow("ci.yml", ON_PUSH),
		],
		[
			"another scheduled workflow is not the sweep",
			"ci-status-lag",
			() => workflow("nightly.yml", SWEEP),
		],
		[
			"suites on with node --test declared is gated at commit (#756)",
			"push-green-suite",
			() => declare({ modules: ["suites"], commands: { test: "node --test" } }),
		],
		[
			"suites on with a jest npm test is gated at commit, though it has an npm test script (#758)",
			"push-green-suite",
			() => {
				declare({ modules: ["suites"], commands: { test: "npm test" } });
				npmTest("jest");
			},
		],
		[
			"a deploy it does not know is none",
			"vercel-build-on-push",
			() => declare({ deploy: "netlify" }),
		],
	])("%s", (_name, id, meet) => {
		meet();
		expect(told("s")).not.toContain(headline(id));
	});

	it("a rule held back stays unlatched, so the session is told once the host meets it", () => {
		expect(told("s")).not.toContain(headline("vercel-build-on-push"));
		declare({ deploy: "vercel" });
		const ctx = told("s");
		expect(ctx).toContain(ruleText("vercel-build-on-push"));
		expect(ctx).not.toContain(headline("push-cadence"));
	});

	it("mantahostels, with push-run CI and no deploy declared, gets the cadence and the green-suite rule", () => {
		declare({
			commands: { test: "npm run test", typecheck: "npm run typecheck" },
			modules: ["roadmap", "governance", "suites"],
		});
		npmTest();
		workflow("ci.yml", ON_PUSH);
		const ctx = told("manta");
		expect(ctx).toContain("push-check.js\n  npm run typecheck\n");
		expect(ctx).toContain(undeclared(ruleText("push-green-suite")));
		expect(ctx).not.toContain(headline("ci-status-lag"));
		expect(ctx).not.toContain(headline("vercel-build-on-push"));
	});
});

/*
 * MUTATION ANCHORS. `toContain(ruleText(<id>))` reads the same file the guard
 * does, so it moves with a mutation to the fragment instead of catching it: cut
 * a clause and both sides lose it together.
 *
 * A row reads the ONE fragment its block names, not the emission, which
 * concatenates all four (mantahostels#2226).
 *
 * The fragments are hard-wrapped at ~80 columns, so a clause straddles a
 * newline whenever a reflow moves it (mantahostels#2226). Collapsing the fragment's
 * whitespace pins the words and never the wrapping — so a wrap CANNOT be
 * pinned here.
 */
const carries = (id: string, clause: string) =>
	expect(ruleText(id).replace(/\s+/g, " ")).toContain(clause);

describe("the injected rules still carry their operative clauses", () => {
	it("a clause no fragment carries fails", () => {
		expect(() =>
			carries("push-cadence", "a clause no fragment carries"),
		).toThrow();
	});

	it.each([
		["EVERY commit on `main`", "whose work a push sends"],
		["never write `result:`", "what a successful push does not license"],
		["says nothing about the suite", "why it does not"],
	])("push-cadence keeps %s — %s", (clause) => {
		carries("push-cadence", clause);
	});

	it("push-cadence keeps its recipe as the host's own commands, in order", () => {
		// Read raw: the accessor expands the placeholders against whichever host
		// runs the suite (#742).
		const raw = fs.readFileSync(
			path.resolve(__dirname, "../docs/agents/rules/push-cadence.txt"),
			"utf8",
		);
		expect(raw.replace(/\s+/g, " ")).toContain(
			"{command:push_check} {command:typecheck} {command:check} <the edited file's own checker> git push origin main",
		);
	});

	it.each([
		["npm run test:py", "the second recorded run"],
		["#1256", "the ticket that stamped a run with its sha"],
		["worktree", "where it also fires"],
		["Never blocks", "what it does not do"],
		["ADMISSIBLE `npm run test` GREEN", "the run the gate now asks for"],
		// Admissibility turns on the argv too (#998).
		["a read graph that renders", "what admissibility turns on"],
		["no full run is owed", "the whole-suite limb #2207 deleted"],
		[
			"Marker keyed to HEAD at run END",
			"why a run over uncommitted work certifies the wrong commit",
		],
		["to the tree it read", "the content key #189 added beside the sha"],
		["attested by tree", "how the push says which key matched"],
		// mantahostels#3210: the merge-base default sees the unpushed commits.
		["merge-base(HEAD, origin/main)", "the base the default diffs against"],
		["#2131", "the hole the gate cannot see, now that it is the only gate"],
		["#2031", "the ticket that ruled a filtered run is not a full one"],
	])("push-green-suite keeps %s — %s", (clause) => {
		carries("push-green-suite", clause);
	});

	it.each([
		["CI RUNS NO `next build`", "the fact the whole rule turns on"],
		["fails PRODUCTION, not CI", "what a build-only breach costs"],
		["warn-only in pre-commit", "why a clean local run is not a clean gate"],
	])("vercel-build-on-push keeps %s — %s", (clause) => {
		carries("vercel-build-on-push", clause);
	});

	it.each([
		["THIS PUSH DOES NOT TRIGGER A SUITE RUN", "the headline"],
		["#910", "the ticket that unkeyed a run from a push"],
		["npm run check:ci", "the command that asks now"],
		["ONCE after every push", "how often"],
		["never rerun it", "why a second read tells nothing new"],
		["only verdict for up to ~12 hours", "what the local checks are meanwhile"],
		["four a day", "how often the suite actually runs, since a push runs none"],
		["the newest sweep", "the run both answers are keyed to, never your sha"],
	])("ci-status-lag keeps %s — %s", (clause) => {
		carries("ci-status-lag", clause);
	});
});

describe("it says it once, and spends no more of the cap than it needs", () => {
	it("is silent on a session's second push, and speaks to a new session", () => {
		expect(emission("git push origin main", "sess-A")).not.toBeNull();
		expect(emission("git push origin main", "sess-A")).toBeNull();
		expect(emission("git push origin main", "sess-B")).not.toBeNull();
	}, 30_000);

	it("requests the four ids this trigger owns and no others", () => {
		// gp_rule's ceiling is per call, so a blanket request here would spend it
		// on whatever the store happened to hold.
		const ctx = emission("git push origin main").additionalContext as string;
		expect(ctx).not.toContain(ruleText("commit-pathspec"));
		expect(ctx).not.toContain(ruleText("branch-shared-tree"));
		expect(ctx).not.toContain(ruleText("suite-tree-dirty"));
		// GP_RULE_CAP is BYTES, and all four fragments are multibyte —
		// guard-parse.sh forces LC_ALL=C on its own length for exactly this reason.
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(GP_RULE_CAP);
	});
});

describe("things that are not a push of this repo", () => {
	it.each([
		["git push --help", "documentation pushes nothing"],
		["git push -h", "the short spelling of it"],
		[
			"git push --dry-run",
			"a rehearsal pushes nothing, and would burn the latch",
		],
		["git push -n origin main", "git push's own short spelling of it"],
		["git status", "not a push at all"],
		["git commit -m 'x' -- a.md", "a commit is #1647's trigger, not this one"],
		["echo 'run git push origin main when green'", "prose about a push"],
		["grep -r 'git push' scripts", "a search for one"],
	])("%s is handed nothing — %s", (command) => {
		expect(emission(command)).toBeNull();
	});

	it("a push in another repo is none of this guard's business", () => {
		expect(emission("git push origin main", "test", elsewhere)).toBeNull();
	});

	it('a rehearsal through an unresolved tree is not handed them either — git -C "$W" push --dry-run', () => {
		expect(emission('git -C "$W" push --dry-run')).toBeNull();
	});
});

describe("a push whose tree it cannot resolve is handed the rules (#319)", () => {
	it('git -C "$W" push, with W unset, is handed them', () => {
		const out = emission('git -C "$W" push origin main');
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(CADENCE);
	});

	it("and nothing is recorded as a fail-open, because nothing was skipped", () => {
		emission('git -C "$W" push origin main');
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});
});

describe("an assignment before the first || is read, so the push's tree is judged (#328)", () => {
	// #319's shape: its only `||` comes after `W=`, so W resolves.
	const shape = (w: string) =>
		`W=${w} && S=m && case "$S" in *) [ -n "$S" ] || exit 1;; esac && git -C $W push origin "$S":main`;

	it("a push from a linked worktree is handed them", () => {
		expect(emission(shape(worktree))?.additionalContext).toContain(CADENCE);
	});

	it("a push from another repo is handed nothing", () => {
		expect(emission(shape(elsewhere))).toBeNull();
	});
});

describe("pushed code no review covers is warned of, never refused (#1163)", () => {
	const arbiter = path.resolve(__dirname, "session-arbiter.js");
	const warn = "no code review covers";
	const me = "review-under-test";
	const markers = () => path.join(shared, ".claude", "tmp", "markers");
	let base: string;

	/** What concision-backstop.sh's `start` records: the session's start point. */
	beforeEach(() => {
		base = git(shared, "rev-parse", "HEAD").trim();
		fs.mkdirSync(markers(), { recursive: true });
		fs.writeFileSync(path.join(markers(), `.concision-base-${me}`), base);
	});

	const code = (lines: number) =>
		Array.from(
			{ length: lines },
			(_, i) => `export const x${i} = ${i};\n`,
		).join("");

	/** Lines past code-signal.sh's review floor. */
	const pastFloor =
		shellConst(
			path.join(__dirname, "lib", "code-signal.sh"),
			"CODE_THRESHOLD",
		) + 1;

	const arbiterEnv = (sid?: string) => ({
		...process.env,
		CLAUDE_PROJECT_DIR: shared,
		CLAUDE_CONFIG_DIR: config,
		...(sid ? { CLAUDE_CODE_SESSION_ID: sid } : {}),
	});

	/** Commit `rel` holding `body` in `tree`. */
	const commitFile = (rel: string, body: string, tree = shared) => {
		const abs = path.join(tree, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
		git(tree, "add", rel);
		git(tree, "commit", "-qm", rel, "--", rel);
	};

	/** Commit `rel` holding `body` in `tree`, credited to `sid`'s write ledger. */
	const commitBy = (rel: string, body: string, sid = me, tree = shared) => {
		commitFile(rel, body, tree);
		execFileSync("node", [arbiter, "record", rel, sid], { env: arbiterEnv() });
	};

	const marker = (body: string) =>
		fs.writeFileSync(path.join(markers(), `.codereview-pass-${me}`), body);

	const told = (cwd = shared) =>
		(emission("git push origin main", me, cwd)?.additionalContext ??
			"") as string;

	const declareRls = () =>
		fs.writeFileSync(
			path.join(shared, ".claude", "workflow-core.json"),
			JSON.stringify({
				sensitivePaths: [
					{
						name: "RLS",
						description: "who may read or write what",
						globs: ["supabase/migrations/**"],
					},
				],
			}),
		);

	it("warns where this session's pushed code has no marker, naming the file and the fixed point, and the push still proceeds", () => {
		commitBy("scripts/mine.ts", code(pastFloor));
		const out = emission("git push origin main", me);
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(warn);
		expect(out.additionalContext).toContain("scripts/mine.ts");
		expect(out.additionalContext).toContain(`fixed point ${base}`);
		// The warn rides ahead of the rules, in the same envelope.
		expect(out.additionalContext).toContain(CADENCE);
	});

	it("is silent where a valid marker covers the session's start point", () => {
		commitBy("scripts/mine.ts", code(pastFloor));
		marker(`base=${base}\nfindings=3\n`);
		expect(told()).not.toContain(warn);
	});

	it("quotes the validator's fault where the marker is rejected", () => {
		commitBy("scripts/mine.ts", code(pastFloor));
		marker("base=main\nfindings=3\n");
		const ctx = told();
		expect(ctx).toContain(warn);
		expect(ctx).toContain("its base= is not a 40-hex sha, 'main'");
	});

	it("quotes the validator's fault where the marker's findings are malformed", () => {
		commitBy("scripts/mine.ts", code(pastFloor));
		marker(`base=${base}\nfindings=several\n`);
		const ctx = told();
		expect(ctx).toContain(warn);
		expect(ctx).toContain("its findings= is not a number, 'several'");
	});

	it("warns on a later push whose rules were already said, in a prelude-only envelope", () => {
		// The common case: an early push spends the rules' latch, then code lands.
		expect(told()).not.toContain(warn);
		commitBy("scripts/mine.ts", code(pastFloor));
		const out = emission("git push origin main", me);
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(warn);
		expect(out.additionalContext).not.toContain(CADENCE);
	});

	it("is silent on a docs-only push", () => {
		commitBy("docs/a.md", "word ".repeat(200));
		expect(told()).not.toContain(warn);
	});

	it("is silent below the backstop's churn floor", () => {
		commitBy("scripts/mine.ts", code(5));
		expect(told()).not.toContain(warn);
	});

	it("is silent on a neighbour's code, which this session did not write", () => {
		// A ledger entry of this session's own, so the attribution filter, and not
		// the empty-ledger exit, is what keeps it silent.
		commitBy("scripts/mine.ts", code(1));
		commitBy("scripts/theirs.ts", code(pastFloor), "parallel-session");
		expect(told()).not.toContain(warn);
	});

	/*
	 * #2390: an edit through an inline interpreter leaves no write-ledger line,
	 * so the commit ledger alone bills the code to this session.
	 */
	it("warns of code this session committed with no write-ledger line, and not of a neighbour's", () => {
		const commitUnwritten = (rel: string, sid: string) => {
			commitFile(rel, code(pastFloor));
			execFileSync(
				"node",
				[arbiter, "record-commit", git(shared, "rev-parse", "HEAD").trim()],
				{ env: arbiterEnv(sid) },
			);
		};
		commitUnwritten("scripts/theirs.ts", "parallel-session");
		expect(told()).not.toContain(warn);
		commitUnwritten("scripts/mine.ts", me);
		const ctx = told();
		expect(ctx).toContain(warn);
		expect(ctx).toContain("scripts/mine.ts");
		expect(ctx).not.toContain("scripts/theirs.ts");
	});

	it("is silent on code this session wrote but has not committed, which no push carries", () => {
		commitBy("scripts/mine.ts", code(1));
		fs.writeFileSync(
			path.join(shared, "scripts", "mine.ts"),
			"export const y = 1;\n".repeat(40),
		);
		expect(told()).not.toContain(warn);
	});

	it("warns once a session", () => {
		commitBy("scripts/mine.ts", code(pastFloor));
		expect(told()).toContain(warn);
		expect(told()).not.toContain(warn);
	});

	it("names the standard tier on code no declared glob covers", () => {
		commitBy("scripts/mine.ts", code(pastFloor));
		expect(told()).toContain("The `standard` review tier is owed.");
	});

	// #1618: a one-line migration is warned of, where code(1) is not.
	it("names the escalated tier and the area for a range touching a declared glob, at any size", () => {
		declareRls();
		commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
		const ctx = told();
		expect(ctx).toContain(warn);
		expect(ctx).toContain("supabase/migrations/001_rls.sql");
		expect(ctx).toContain(
			"The `escalated` review tier is owed: this change touches declared sensitive paths (RLS)",
		);
	});

	// #1696: one latch a tier.
	it("warns again when a range warned of at the standard tier turns escalated, and then no more", () => {
		declareRls();
		commitBy("scripts/mine.ts", code(pastFloor));
		expect(told()).toContain("The `standard` review tier is owed.");
		expect(told()).not.toContain(warn);

		commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
		const ctx = told();
		expect(ctx).toContain("The `escalated` review tier is owed");
		expect(ctx).toContain(
			"record it with --tier escalated (or mission-critical) --areas 'RLS'",
		);
		expect(told()).not.toContain(warn);
	});

	// #1696: a standard review's marker never passes for an escalated one.
	it.each([
		["no tier= line", "", "it has no tier= line"],
		["tier=standard", "tier=standard\nareas=RLS\n", "its tier= is 'standard'"],
		[
			"areas= missing the matched area",
			"tier=escalated\nareas=money\n",
			"its areas= does not name RLS",
		],
	])(
		"keeps warning on a one-line .sql range whose marker has %s, quoting why",
		(_, lines, fault) => {
			declareRls();
			commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
			marker(`base=${base}\nfindings=2\n${lines}`);
			const ctx = told();
			expect(ctx).toContain(warn);
			expect(ctx).toContain(`was rejected — ${fault}`);
		},
	);

	it.each([
		"tier=escalated\nareas=RLS\n",
		"tier=mission-critical\nareas=money, RLS\n",
	])(
		"is silent on a sensitive range once the marker records an upper tier naming every area: %j",
		(lines) => {
			declareRls();
			commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
			marker(`base=${base}\nfindings=2\n${lines}`);
			expect(told()).not.toContain(warn);
		},
	);

	// #1748: the hold skips a worktree commit, so this warn is its only signal.
	it("warns on an escalated range committed and pushed from a worktree, rejecting a standard review's marker", () => {
		const rel = "supabase/migrations/001_rls.sql";
		declareRls();
		commitBy(rel, "create policy p on t;\n", me, worktree);
		marker(`base=${base}\nfindings=2\ntier=standard\nareas=RLS\n`);
		const ctx = told(worktree);
		expect(ctx).toContain(warn);
		expect(ctx).toContain(rel);
		expect(ctx).toContain("The `escalated` review tier is owed");
		expect(ctx).toContain("was rejected — its tier= is 'standard'");
	});

	// #1840 F1: a staged review's base= is newer than the start point, and only
	// its paths= bounds what it vouches for.
	it.each([
		["the shared tree", () => shared],
		["a worktree", () => worktree],
	])(
		"warns, in %s, on a marker whose base= follows a neighbour's commit and that has no paths=, naming both ways to clear it",
		(_, tree) => {
			commitBy("scripts/theirs.ts", code(1), "parallel-session", tree());
			const reviewed = git(tree(), "rev-parse", "HEAD").trim();
			commitBy("scripts/mine.ts", code(pastFloor), me, tree());
			marker(`base=${reviewed}\nfindings=1\n`);
			const ctx = told(tree());
			expect(ctx).toContain(warn);
			expect(ctx).toContain(
				"its base= is ahead of this session's start point and it has no paths= line",
			);
			expect(ctx).toContain("names them in paths=");
			expect(ctx).toContain(`sets base=${base}, its start point`);
		},
	);

	it("is silent on a marker whose base= follows a neighbour's commit once its paths= names the session's code", () => {
		commitBy("scripts/theirs.ts", code(1), "parallel-session");
		const reviewed = git(shared, "rev-parse", "HEAD").trim();
		commitBy("scripts/mine.ts", code(pastFloor));
		marker(`base=${reviewed}\nfindings=1\npaths=scripts/mine.ts\n`);
		expect(told()).not.toContain(warn);
	});

	// #1925: in a worktree the hold is skipped, so a staged review's first-commit
	// marker reaches the push with base= at the start point.
	it("warns on a worktree's first commit whose marker sits at the start point with tree= and no paths=, naming the missing paths= line", () => {
		commitBy("scripts/mine.ts", code(pastFloor), me, worktree);
		const tree = git(worktree, "rev-parse", "HEAD^{tree}").trim();
		marker(`base=${base}\nfindings=0\ntree=${tree}\n`);
		const ctx = told(worktree);
		expect(ctx).toContain(warn);
		expect(ctx).toContain("it has a tree= line and no paths= line");
		expect(ctx).toContain("names every path its diff named in paths=");
	});

	it("is silent on a marker at the start point with neither tree= nor paths=, a whole-session review", () => {
		commitBy("scripts/mine.ts", code(pastFloor), me, worktree);
		marker(`base=${base}\nfindings=0\n`);
		expect(told(worktree)).not.toContain(warn);
	});

	it("warns again at the escalated tier for each rejected marker written after the warn, and not for one unchanged (#1840)", () => {
		declareRls();
		commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
		expect(told()).toContain("The `escalated` review tier is owed");

		marker(`base=${base}\nfindings=2\ntier=standard\nareas=RLS\n`);
		expect(told()).toContain("was rejected — its tier= is 'standard'");
		expect(told()).not.toContain(warn);

		marker(`base=${base}\nfindings=2\ntier=escalated\nareas=money\n`);
		expect(told()).toContain("was rejected — its areas= does not name RLS");
		expect(told()).not.toContain(warn);

		marker(`base=${base}\nfindings=2\ntier=escalated\nareas=RLS\n`);
		expect(told()).not.toContain(warn);
	});

	it("warns again at the standard tier for a rejected marker written after the warn (#1840)", () => {
		commitBy("scripts/mine.ts", code(pastFloor));
		expect(told()).toContain(warn);
		marker("base=main\nfindings=3\n");
		expect(told()).toContain("its base= is not a 40-hex sha, 'main'");
		expect(told()).not.toContain(warn);
	});

	it("reads the same code signal as the Stop backstop, from the one shared helper", () => {
		for (const script of ["concision-backstop.sh", "guard-push-rules.sh"]) {
			const text = fs.readFileSync(path.join(__dirname, script), "utf8");
			expect(text).toMatch(/^\s*source .*\/lib\/code-signal\.sh"/m);
			expect(text).not.toMatch(/^CODE=\(/m);
		}
	});
});

describe("what it cannot resolve, it records and allows", () => {
	it("says nothing and logs when the payload carries no session", () => {
		// gp_rule's payload side keeps the house fail-open (mantahostels#103 §6); only its
		// store side refuses. Without a session id there is no latch key, so an
		// injection would repeat on every call.
		const r = spawnGuard(
			GUARD,
			buildBashPayload("git push origin main", null),
			{
				project: shared,
				config,
				cwd: shared,
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
			/no session_id in payload/,
		);
	});

	it("withholds push-green-suite, on the record naming the contract, where test-gate.js refuses the config (#758)", () => {
		// The shell reader refuses the contract too, reading `suites` off with
		// the refusal on stderr (#1481); test-gate.js's refusal is the record.
		declare({ contract: 99, modules: ["suites"] });
		npmTest();
		const ctx = emission("git push origin main", "s", shared, {
			unset: ["WFC_MODULES"],
			stderr:
				/^\S+ declares contract 99, which this workflow-core does not read/,
		})?.additionalContext as string;
		const headline = (id: string) =>
			id === "push-cadence" ? CADENCE : ruleText(id).split("\n")[0];
		expect(ctx).toContain(headline("push-cadence"));
		expect(ctx).not.toContain(headline("push-green-suite"));
		expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
			/test-gate\.js exit 2, push-green-suite withheld.*contract 99/,
		);
	});

	it("disarms itself, silently and on the record, without the parser", () => {
		// The one fault that stands the guard down entirely (mantahostels#103 §6). It is
		// copied to a scratch directory whose lib/ holds guard-log.sh alone, so
		// the `declare -F gp_begin` gate finds nothing.
		const at = fs.mkdtempSync(path.join(dir, "nolib-"));
		fs.mkdirSync(path.join(at, "lib"));
		fs.copyFileSync(GUARD, path.join(at, "guard-push-rules.sh"));
		// guard-log.sh reads the repo root through gr_root, which lives in
		// guard-root.sh since mantahostels#1905 — without it the fail-open record lands under
		// the wrong slug and this case tests nothing.
		for (const lib of ["guard-log.sh", "guard-root.sh"]) {
			fs.copyFileSync(
				path.resolve(__dirname, "lib", lib),
				path.join(at, "lib", lib),
			);
		}
		const r = spawnGuard(
			path.join(at, "guard-push-rules.sh"),
			buildBashPayload("git push origin main", "test"),
			{ project: shared, config, cwd: shared },
		);
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
			/guard-parse\.sh did not load/,
		);
	});

	it("refuses the call when the fragment cannot be read, exiting 2 and naming the rule", () => {
		// The one place this guard exits non-zero (mantahostels#1762): a rule that cannot be
		// stated is worth a refused tool call.
		const empty = fs.mkdtempSync(path.join(dir, "store-"));
		const r = spawnGuard(
			GUARD,
			buildBashPayload("git push origin main", "test"),
			{
				project: shared,
				config,
				cwd: shared,
				env: { WFC_RULES_DIR: empty },
			},
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("push-cadence");
	});
});

/*
 * The helper (mantahostels#2068) leak-checks every instantiate() call itself, so this
 * file's own beforeEach already throws before any test body ran were the copy
 * still pointing at the template. What is left to assert here is the
 * BEHAVIOURAL isolation a leak would cause: a
 * write made in the instantiated copy must not reach a second, independent
 * instantiation of the same template.
 */
describe("the copied fixture is isolated from its template (mantahostels#2168)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("push-rules-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	// Asserted on the WORKTREE, not `shared`: a worktree shares its parent's
	// object store, so a stale gitdir pointer left by a naive copy writes into
	// the template rather than failing loudly. A plain repo copy has its own
	// objects/ and would pass this assertion even with relinking switched off.
	it("a commit made in the copied worktree leaves the template untouched", () => {
		fs.writeFileSync(path.join(worktree, "c.md"), "c\n");
		git(worktree, "add", "c.md");
		git(worktree, "commit", "-qm", "worktree copy only", "--", "c.md");
		expect(git(worktree, "log", "--oneline")).toContain("worktree copy only");

		const fresh = freshCopy();
		try {
			expect(
				git(path.join(fresh, "shared"), "log", "--all", "--oneline"),
			).not.toContain("worktree copy only");
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
});
