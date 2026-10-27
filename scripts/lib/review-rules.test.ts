// @vitest-environment node
/*
 * lib/review-rules.js, a PreToolUse dispatcher core (#2792), hands a session
 * the code-review rules at the Skill call that loads code-review
 * (mantahostels#3451). Every case but the adopter's bare name (#1165) asserts
 * `permissionDecision` is absent as well as the text.
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over the
 * production ports (lib/review-rules-host.js) and the real rule store. Each
 * case stands up a temp host holding a local `code-review` skill and a
 * separate temp core (`WFC_SCRIPT_ROOT` in the case's env), so which standards
 * text the host gets is set per case rather than read off this checkout. The
 * hook line and stdin are scripts/guard-dispatch.test.ts's boundary set.
 *
 * It runs on every Skill call: break it and a review runs without the rules
 * on where its findings and deviations go; make it deny and code-review
 * cannot load.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore } from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";

const { readRuleCap } = require("./rule-emission.js") as {
	readRuleCap: () => number;
};
const RULE_CAP = readRuleCap();
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string) => string;
};
const RUN_COST_PREFIX = "RUN COST:";
const { buildFailOpenLine } = require("./run-cost-report.js") as {
	buildFailOpenLine: (error: unknown) => string;
};
const { decide } = require("./review-rules.js") as {
	decide: (skill: string, ctx: Record<string, unknown>) => unknown;
};
const { buildHostPorts } = require("./review-rules-host.js") as {
	buildHostPorts: (root: string) => { installRoot: string };
};

/** This checkout's root, where the installed core sits. */
const ROOT = path.resolve(__dirname, "..", "..");

const IDS = [
	"review-deviations-write",
	"review-dispatch-shape",
	"review-deviations-read",
	"review-finding-destination",
	"review-ultra-axis",
];

/** One per state of the base and the local file (#965); a host gets exactly one. */
const STANDARDS_IDS = [
	"review-standards-axis",
	"review-standards-axis-base",
	"review-standards-axis-local",
	"review-standards-axis-absent",
];

/**
 * The longest workflow-core plugin root on the founder's machine, a dry-run
 * install, as an adopter's base path is named whole (#1882).
 */
const LONGEST_ROOT =
	"/home/lucmo/.claude3/plugins/cache/workflow-core-dryrun/workflow-core/0.0.1";

let dir: string;
/** Stands in for the resolved core root, where the base is looked for. */
let core: string;

/** The core's shape: a project skill that shadows the harness's built-in (#1165). */
const LOCAL_SKILL = [".claude", "skills", "code-review", "SKILL.md"];

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "review-rules-")),
	);
	core = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "review-core-")),
	);
	fs.mkdirSync(path.join(dir, ...LOCAL_SKILL.slice(0, -1)), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(dir, ...LOCAL_SKILL),
		"---\nname: code-review\n---\n",
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(core, { recursive: true, force: true });
});

/** The core's run on a Skill call, refusals included. */
const rawRun = (
	skill: string,
	payload: Record<string, unknown> = { session_id: "abcdef12-3456" },
	{
		root = dir,
		env = { WFC_SCRIPT_ROOT: core },
	}: { root?: string; env?: Record<string, string> } = {},
) =>
	runCore(
		"guard-review-rules",
		{ tool_name: "Skill", tool_input: { skill }, ...payload },
		{ root, env },
	);

/** The hook output for a Skill call, refusals included. Null where it said nothing. */
const rawEmission = (...args: Parameters<typeof rawRun>) =>
	rawRun(...args).output;

/** As rawEmission, asserting the call was not refused. */
const emission = (...args: Parameters<typeof rawRun>) => {
	const parsed = rawEmission(...args);
	expect(parsed?.permissionDecision).toBeUndefined();
	return parsed;
};

/** The context handed over, asserting there was one and no refusal. */
const context = (...args: Parameters<typeof rawRun>) => {
	const out = emission(...args);
	expect(out?.additionalContext).toBeTypeOf("string");
	return out?.additionalContext as string;
};

/** A host carrying its local docs/code-standards.md. */
const withStandards = (root = dir) => {
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(path.join(root, "docs", "code-standards.md"), "standards\n");
};

/** A core root carrying the standards base. */
const withBase = (root = core) => {
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(path.join(root, "docs", "code-standards-base.md"), "base\n");
};

/** A host carrying its GLOSSARY.md, for base §G8 (#1373). */
const withGlossary = (root = dir) => {
	fs.writeFileSync(path.join(root, "GLOSSARY.md"), "# Glossary\n");
};

/**
 * The core's decide on a bare `code-review`, over the production host ports
 * and a log that keeps each record's detail, which the testkit's drops.
 */
const decidedLogs = () => {
	const logs: string[] = [];
	decide(
		"code-review",
		kitContextFake({
			...buildHostPorts(dir),
			root: dir,
			session: "abcdef12-3456",
			env: { WFC_SCRIPT_ROOT: core },
			isFile: (p: string) =>
				fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
			log: (what: string, detail?: string) => {
				logs.push(detail === undefined ? what : `${what}\t${detail}`);
			},
		}),
	);
	return logs.join("\n");
};

describe("loading code-review", () => {
	it("hands over the five review rules and one standards rule, and refuses nothing", () => {
		withStandards();
		withBase();
		const ctx = context("code-review");
		for (const id of IDS) expect(ctx).toContain(readRuleText(id));
		expect(ctx).toContain(readRuleText("review-standards-axis"));
	});

	// The deviations record is owed before the dispatch goes out, so it leads.
	it("states the deviations record ahead of the dispatch shape", () => {
		const ctx = context("code-review");
		expect(ctx.indexOf("RECORD WHERE THE BUILD DEPARTED")).toBeLessThan(
			ctx.indexOf("Spawn the review runs"),
		);
	});

	// A subagent's Write expands no environment variable (mantahostels#2088), so the prelude
	// has to carry the literal, session-suffixed paths (mantahostels#2220).
	it("names this session's two Artefact paths", () => {
		const ctx = context("code-review");
		expect(ctx).toContain("`.claude/tmp/review-standards-abcdef12.md`");
		expect(ctx).toContain("`.claude/tmp/review-spec-abcdef12.md`");
	});

	it("gives two sessions two different paths", () => {
		const a = context("code-review", { session_id: "11111111-x" });
		const b = context("code-review", { session_id: "22222222-y" });
		expect(a).toContain("review-spec-11111111.md");
		expect(b).toContain("review-spec-22222222.md");
	});

	// Must match inject-tracker-docs.sh and concision-backstop.sh, which strip
	// before truncating.
	it("sanitises the session id before truncating it", () => {
		expect(context("code-review", { session_id: "ab/cd.efgh-99" })).toContain(
			"review-spec-ab_cd_ef.md",
		);
	});

	it("says nothing the second time in one session", () => {
		expect(emission("code-review")).not.toBeNull();
		expect(emission("code-review")).toBeNull();
	});

	// The kit keys its latch on the agent as well, so a subagent is told on
	// its own account.
	it("tells a subagent under an already-told session", () => {
		expect(emission("code-review")).not.toBeNull();
		const sub = context("code-review", {
			session_id: "abcdef12-3456",
			agent_id: "sub1",
		});
		expect(sub).toContain(readRuleText("review-dispatch-shape"));
	});
});

/*
 * #965: the Standards axis is handed the base at the resolved core root and the
 * host's local file, and a missing one is named in the report's opening line.
 */
describe("the standards base and local file (#965)", () => {
	it.each([
		{
			state: "both",
			base: true,
			local: true,
			id: "review-standards-axis",
			opening: "`Base unreadable: <path>`",
		},
		{
			state: "base only",
			base: true,
			local: false,
			id: "review-standards-axis-base",
			opening: "`No local standards file: the base applies unchanged.`",
		},
		{
			state: "local only",
			base: false,
			local: true,
			id: "review-standards-axis-local",
			opening: "`No standards base: <path> is absent.`",
		},
		{
			state: "neither",
			base: false,
			local: false,
			id: "review-standards-axis-absent",
			opening:
				"`No standards base or local file: <path> and docs/code-standards.md are absent.`",
		},
	])(
		"$state: hands over its one standards rule",
		({ base, local, id, opening }) => {
			if (base) withBase();
			if (local) withStandards();
			const ctx = context("code-review");
			expect(ctx).toContain(readRuleText(id));
			expect(ctx).toContain(opening);
			for (const other of STANDARDS_IDS.filter((i) => i !== id))
				expect(ctx).not.toContain(readRuleText(other));
			for (const i of IDS) expect(ctx).toContain(readRuleText(i));
			// The fragments are static, so the path rides in the prelude.
			expect(ctx).toContain(
				`Its standards base: \`${path.join(core, "docs", "code-standards-base.md")}\`.`,
			);
		},
	);

	it.each([
		["local only", false, true, true],
		["neither", false, false, true],
		["both", true, true, false],
		["base only", true, false, false],
	])(
		"%s: logs a missing base only where it is missing",
		(_s, base, local, logged) => {
			if (base) withBase();
			if (local) withStandards();
			const log = decidedLogs();
			expect(log.includes("standards base absent")).toBe(logged);
			if (logged)
				expect(log).toContain(
					`standards base absent — Standards axis reviewed without it\t${path.join(core, "docs", "code-standards-base.md")}`,
				);
			else expect(log).toBe("");
		},
	);

	// In an adopter the plugin cache is reached through ~/.claude3 or ~/.claude2,
	// symlinks onto ~/.claude, and #711's Read rule names only the physical path.
	it("names the resolved base path in an adopter, never a symlink spelling", () => {
		const link = path.join(core, "link");
		fs.symlinkSync(path.join(ROOT, "scripts"), link);
		const viaLink = require(path.join(link, "lib", "review-rules-host.js")) as {
			buildHostPorts: (root: string) => { installRoot: string };
		};
		const physical = fs.realpathSync(ROOT);
		expect(viaLink.buildHostPorts(dir).installRoot).toBe(physical);
		const ctx = context("code-review", undefined, { env: {} });
		expect(ctx).toContain(
			`Its standards base: \`${physical}/docs/code-standards-base.md\`.`,
		);
		expect(ctx).not.toContain(link);
	});
});

describe("the host's glossary (#1373)", () => {
	const named = (ctx: string) =>
		ctx.includes("Hand the Standards axis `GLOSSARY.md` too, for base §G8.");

	it("names the host's GLOSSARY.md in the prelude where it exists", () => {
		withBase();
		withGlossary();
		expect(named(context("code-review"))).toBe(true);
	});

	it("names no glossary where the host has none", () => {
		withBase();
		const ctx = context("code-review");
		expect(named(ctx)).toBe(false);
		expect(ctx).not.toContain("GLOSSARY.md");
	});
});

/*
 * Named relative to the host root, the paths cost the same under any
 * checkout, so every rule still fits one envelope (#1729).
 */
describe("the envelope's size under a long checkout path (#1729)", () => {
	/** The core's shape: host and core one root, both standards files and a glossary. */
	const envelopeAt = (root: string) => {
		fs.mkdirSync(path.join(root, ...LOCAL_SKILL.slice(0, -1)), {
			recursive: true,
		});
		fs.copyFileSync(
			path.join(dir, ...LOCAL_SKILL),
			path.join(root, ...LOCAL_SKILL),
		);
		withBase(root);
		withStandards(root);
		withGlossary(root);
		return context("code-review", undefined, {
			root,
			env: { WFC_SCRIPT_ROOT: root },
		});
	};

	it("carries every rule and no root path, at the same size as under a short path", () => {
		const short = path.join(dir, "s");
		// Longer than the envelope's whole spare room, so a path still counted would overflow it.
		const long = path.join(dir, ...new Array(10).fill("a".repeat(30)));
		const atShort = envelopeAt(short);
		const atLong = envelopeAt(long);
		expect(atLong).not.toContain(long);
		for (const id of [...IDS, "review-standards-axis"])
			expect(atLong).toContain(readRuleText(id));
		expect(Buffer.byteLength(atLong)).toBe(Buffer.byteLength(atShort));
		expect(Buffer.byteLength(atLong)).toBeLessThanOrEqual(RULE_CAP);
	});
});

describe("the envelope at the longest adopter base path (#1882)", () => {
	it("carries every rule, the run-cost line among them, under the cap", () => {
		// Where the temp core is already longer, the case runs at that longer
		// path, which is the stricter test.
		const pad = Math.max(1, LONGEST_ROOT.length - core.length - 1);
		const root = path.join(core, "p".repeat(pad));
		withBase(root);
		withStandards();
		withGlossary();
		const ctx = context("workflow-core:code-review", undefined, {
			env: { WFC_SCRIPT_ROOT: root },
		});
		expect(ctx).toContain(path.join(root, "docs", "code-standards-base.md"));
		for (const id of [...IDS, "review-standards-axis"])
			expect(ctx).toContain(readRuleText(id));
		/* The prefix the fragment names is the one the report prints. */
		expect(buildFailOpenLine("x").startsWith(`${RUN_COST_PREFIX} `)).toBe(true);
		expect(ctx).toContain(
			`every \`${RUN_COST_PREFIX}\` line your last suite run printed`,
		);
		expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(RULE_CAP);
	});
});

describe("any other skill", () => {
	it.each([
		["code-review:code-review", "the plugin's pull-request review"],
		["last30days", "an unrelated skill"],
		["concision-pass", "the pass that follows a review"],
		["", "an empty name"],
	])("%j is told nothing — %s", (skill) => {
		expect(emission(skill)).toBeNull();
	});
});

/*
 * MUTATION ANCHORS. `toContain(readRuleText(id))` reads the file the core reads, so
 * it moves with a cut to a fragment rather than catching it.
 */
describe("the fragments carry what the review needs", () => {
	it.each([
		["review-dispatch-shape", 'model: "opus"` on every one'],
		["review-dispatch-shape", "subagent type named above"],
		["review-dispatch-shape", "SINGLE message"],
		["review-dispatch-shape", "or say there were none, for base §X8 (5)"],
		["review-standards-axis", "`docs/code-standards.md`"],
		["review-standards-axis", "`Base unreadable: <path>`"],
		["review-standards-axis", '"§X2 (base), excepted by local row 2"'],
		["review-standards-axis", "the standards base named above"],
		[
			"review-standards-axis-base",
			"`No local standards file: the base applies unchanged.`",
		],
		["review-standards-axis-base", "`Base unreadable: <path>`"],
		["review-standards-axis-local", "`No standards base: <path> is absent.`"],
		["review-standards-axis-local", "never hand that path"],
		[
			"review-standards-axis-absent",
			"`No standards base or local file: <path> and docs/code-standards.md are absent.`",
		],
		["review-standards-axis-absent", "hand the Standards axis neither path"],
		["review-deviations-read", "## Declared departures"],
		["review-deviations-read", "never suppressed"],
		["review-deviations-write", "No departure, no comment."],
		["review-deviations-write", "**waived:**"],
		["review-finding-destination", "`**Outstanding:**`"],
		["review-ultra-axis", "NEVER START ONE UNASKED."],
	])("%s says %j", (id, clause) => {
		expect(readRuleText(id)).toContain(clause);
	});
});

/* A plugin skill arrives namespaced (#201). */
describe("a namespaced code-review still gets its rules (#201)", () => {
	it.each(["workflow-core:code-review", "my-fork:code-review"])(
		"%s is told, as the bare name is",
		(skill) => {
			expect(emission(skill)).not.toBeNull();
		},
	);

	/* Anthropic's own pull-request plugin takes this name and is a different
	 * skill, which is why the exclusion sits before the namespaced arm. */
	it("still says nothing to Anthropic's own code-review plugin", () => {
		expect(emission("code-review:code-review")).toBeNull();
	});
});

/*
 * #1165: in an adopter a bare `code-review` is the harness's built-in reviewer.
 * Only a project carrying its own skill shadows the built-in.
 */
describe("a bare code-review in an adopter (#1165)", () => {
	const makeAdopter = () =>
		fs.rmSync(path.join(dir, ...LOCAL_SKILL.slice(0, -2)), {
			recursive: true,
			force: true,
		});

	it("is refused, naming the plugin's skill", () => {
		makeAdopter();
		const out = rawEmission("code-review");
		expect(out?.permissionDecision).toBe("deny");
		expect(out?.permissionDecisionReason).toBe(
			"A bare `code-review` here is the harness's built-in reviewer, not workflow-core's: this project carries no code-review skill of its own (no `SKILL.md` under `.claude/skills/code-review/`). The built-in diffs only `@{upstream}...HEAD`, never your fixed point, and writes neither review-axis Artefact. Call the Skill tool with `workflow-core:code-review` instead, same fixed point (#1165).",
		);
		expect(out?.additionalContext).toBeUndefined();
	});

	// Refused before the latch, so the namespaced retry is still told.
	it("leaves the rules for the namespaced retry", () => {
		makeAdopter();
		rawEmission("code-review");
		expect(context("workflow-core:code-review")).toContain(
			readRuleText("review-dispatch-shape"),
		);
	});

	it.each(["workflow-core:code-review", "my-fork:code-review"])(
		"never refuses %s",
		(skill) => {
			makeAdopter();
			expect(emission(skill)).not.toBeNull();
		},
	);

	it("still says nothing to Anthropic's own code-review plugin", () => {
		makeAdopter();
		expect(emission("code-review:code-review")).toBeNull();
	});

	// The skill directory without its SKILL.md loads nothing, so it shadows nothing.
	it("is refused where the skill directory holds no SKILL.md", () => {
		fs.rmSync(path.join(dir, ...LOCAL_SKILL));
		expect(rawEmission("code-review")?.permissionDecision).toBe("deny");
	});
});

describe("the cases a mutant must not survive (#2792)", () => {
	it("passes a skill whose name only ends in code-review", () => {
		expect(emission("mycode-review")).toBeNull();
	});

	it("words the prelude exactly, and names the host's own reviewer where it has one", () => {
		withBase();
		withGlossary();
		fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude", "agents", "code-reviewer.md"),
			"x\n",
		);
		expect(
			context("code-review").startsWith(
				`Rules for the code-review you are loading. This session's review subagent type: \`code-reviewer\`. Its two review-axis Artefact paths: \`.claude/tmp/review-standards-abcdef12.md\` and \`.claude/tmp/review-spec-abcdef12.md\`. Its standards base: \`${core}/docs/code-standards-base.md\`. Hand the Standards axis \`GLOSSARY.md\` too, for base §G8.\n\n`,
			),
		).toBe(true);
	});

	it("names the plugin's reviewer where the host has none", () => {
		expect(context("code-review")).toContain(
			"This session's review subagent type: `workflow-core:code-reviewer`.",
		);
	});

	// mantahostels#2220's collision, taken in that one case rather than
	// injecting nothing.
	it("leaves the bare names where the payload carries no session id", () => {
		const { output, logs } = rawRun("code-review", {});
		expect(output?.permissionDecision).toBeUndefined();
		expect(output?.additionalContext).toContain(
			"`.claude/tmp/review-standards.md` and `.claude/tmp/review-spec.md`",
		);
		expect(logs).toContain("no session_id in payload — rule injection skipped");
	});

	it.each([
		["both", true, true, "review-standards-axis"],
		["base only", true, false, "review-standards-axis-base"],
		["local only", false, true, "review-standards-axis-local"],
		["neither", false, false, "review-standards-axis-absent"],
	])(
		"%s: hands the six fragments over in priority order",
		(_s, base, local, standardsId) => {
			if (base) withBase();
			if (local) withStandards();
			const ctx = context("code-review");
			const order = [
				"review-deviations-write",
				"review-dispatch-shape",
				standardsId,
				"review-deviations-read",
				"review-finding-destination",
				"review-ultra-axis",
			].map((id) => ctx.indexOf(readRuleText(id)));
			expect(order.every((at) => at > 0)).toBe(true);
			expect([...order].sort((a, b) => a - b)).toEqual(order);
		},
	);

	it("logs a missing base once, inside the prelude's latch", () => {
		const logs: string[] = [];
		decide(
			"code-review",
			kitContextFake({
				...buildHostPorts(dir),
				root: dir,
				session: "abcdef12-3456",
				env: { WFC_SCRIPT_ROOT: core },
				isFile: () => true,
				told: () => true,
				log: (what: string) => {
					logs.push(what);
				},
			}),
		);
		expect(logs).toEqual([]);
	});
});
