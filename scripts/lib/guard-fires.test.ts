// @vitest-environment node
/*
 * The guarantee under test is ONE thing: a guard's own words counted where the
 * harness recorded a hook speaking them, and NOT counted where a session merely
 * quoted them. The guardKey and registeredGuards cases serve it, keying each
 * hook registration so a fire is attributed to the right guard (mantahostels#1246).
 *
 * In-process on hand-built transcript records and settings files in temp dirs,
 * so each case knows which spans are fires and which are quotes.
 *
 * count-guard-fires.js is what proves a guard reprints a rule before that
 * rule's text leaves the always-loaded pool (`docs/doc-map.md` §Capture and
 * placement, route (e)); a loosened case counts a quote as a fire, so a rule
 * can be shed to a guard that never says it. guard-lost-deny.js and
 * check-hook-liveness.js key hooks through the same functions.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { denyRecord as deniedCall } from "./guard-fires-testkit";

const {
	guardKey,
	guardKeys,
	keyOrigins,
	registeredGuards,
	needleIn,
	fireSpans,
	transcriptFires,
	transcriptMentions,
	tally,
	transcriptFiles,
	sessionKeyFor,
} = require("./guard-fires.js");
const { mergeHooks } = require("./core-hooks.js");

/** One record's fires, read as a one-line transcript. */
const recordFires = (record: unknown, subjects: unknown[]) =>
	transcriptFires(JSON.stringify(record), subjects, "main");

/** One record's mentions, read as a one-line transcript. */
const recordMentions = (record: unknown, subjects: unknown[]) =>
	transcriptMentions(JSON.stringify(record), subjects, "main");

/** The claim guard's deny, as session-arbiter.js emits it. */
const DENY =
	"docs/doc-map.md is held by session 735db33b (pid 762805), which is still running.";

const SUBJECT = {
	id: "guard:guard-file-claim.sh",
	routes: ["hook", "deny"],
	needles: [
		{ id: "held", text: ["is held by session", "which is still running."] },
	],
};

const denyRecord = (text = DENY, isError = true) => deniedCall(text, isError);

/** A hook that produced output: the harness writes its own attachment record. */
const attachment = (over: Record<string, unknown> = {}) => ({
	type: "attachment",
	uuid: "a1",
	timestamp: "2026-08-23T13:44:53.265Z",
	attachment: {
		type: "hook_success",
		hookName: "PreToolUse:Write",
		toolUseID: "toolu_01",
		hookEvent: "PreToolUse",
		content: "",
		stdout: DENY,
		command: '"$CLAUDE_PROJECT_DIR"/scripts/guard-file-claim.sh',
		...over,
	},
});

/* The exec form's own spelling, assembled rather than written whole: biome's
 * noTemplateCurlyInString cannot tell a shell variable from a botched template
 * literal, and every one of these is the shell's. */
const braced = (name: string) => `\${CLAUDE_PROJECT_DIR}/scripts/${name}`;

describe("guardKey", () => {
	it("strips the wrappers settings.json puts around a node hook", () => {
		expect(
			guardKey(
				'command -v node >/dev/null 2>&1 && node "$CLAUDE_PROJECT_DIR"/scripts/check-ci-status.js --notify || true',
			),
		).toBe("check-ci-status.js --notify");
	});

	it("keeps the argument that distinguishes two registrations of one script", () => {
		expect(
			guardKey('"$CLAUDE_PROJECT_DIR"/scripts/concision-backstop.sh stop'),
		).toBe("concision-backstop.sh stop");
		expect(
			guardKey('"$CLAUDE_PROJECT_DIR"/scripts/concision-backstop.sh start'),
		).toBe("concision-backstop.sh start");
	});

	it("survives a cd in front of a bare scripts/ path", () => {
		expect(
			guardKey(
				'command -v node >/dev/null 2>&1 && cd "$CLAUDE_PROJECT_DIR" && node scripts/check-manual-freshness.js --notify',
			),
		).toBe("check-manual-freshness.js --notify");
	});

	/* The exec form (mantahostels#2059) moves the argument out of `command` and into `args`.
	 * Reading `command` alone collapses two registrations of one script onto a
	 * single key and merges their fire tallies with no signal (mantahostels#2106). */
	it("keeps two exec-form registrations of one script apart on their args", () => {
		expect(guardKey(braced("concision-backstop.sh"), ["stop"])).toBe(
			"concision-backstop.sh stop",
		);
		expect(guardKey(braced("concision-backstop.sh"), ["start"])).toBe(
			"concision-backstop.sh start",
		);
	});

	it("keys an exec-form entry the same as the shell form it replaces", () => {
		expect(guardKey(braced("guard-branch.sh"), [])).toBe(
			guardKey('"$CLAUDE_PROJECT_DIR"/scripts/guard-branch.sh'),
		);
	});

	it("finds the script where an interpreter puts it in args", () => {
		expect(guardKey("node", [braced("check-ci-status.js"), "--notify"])).toBe(
			"check-ci-status.js --notify",
		);
	});

	/* `"args": "stop"` is malformed against the vendor schema. Reading it as
	 * nothing reproduces the very fault mantahostels#2106 fixed. */
	it("reads a scalar args rather than dropping it", () => {
		expect(guardKey(braced("concision-backstop.sh"), "stop")).toBe(
			"concision-backstop.sh stop",
		);
	});

	it("is empty for a command naming no script in this repo", () => {
		expect(guardKey('bash "$CLAUDE_PLUGIN_ROOT/hooks/check-config.sh"')).toBe(
			"",
		);
	});
});

describe("registeredGuards", () => {
	const settings = {
		hooks: {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [{ command: '"$CLAUDE_PROJECT_DIR"/scripts/guard-branch.sh' }],
				},
			],
			// An event this module has never heard of must still come back, or a
			// hook registered on it reads as unwired (lib/hook-wiring.ts's rule).
			PreCompact: [
				{ hooks: [{ command: '"$CLAUDE_PROJECT_DIR"/scripts/guard-new.sh' }] },
			],
		},
	};

	it("reads the event key off the file rather than a closed list", () => {
		expect(
			registeredGuards(settings).map((r: { event: string; key: string }) => [
				r.event,
				r.key,
			]),
		).toEqual([
			["PreToolUse", "guard-branch.sh"],
			["PreCompact", "guard-new.sh"],
		]);
	});

	/* mantahostels#2106: the exec form moves the distinguishing argument into `args`, so a
	 * key read off `command` alone merges two registrations' fire tallies. */
	it("hands each entry's args to the key, so an exec-form pair does not collapse", () => {
		const execForm = {
			hooks: {
				Stop: [
					{
						hooks: [
							{
								command: braced("concision-backstop.sh"),
								args: ["stop"],
							},
						],
					},
				],
				SessionStart: [
					{
						hooks: [
							{
								command: braced("concision-backstop.sh"),
								args: ["start"],
							},
						],
					},
				],
			},
		};

		expect(
			registeredGuards(execForm).map((r: { key: string }) => r.key),
		).toEqual(["concision-backstop.sh stop", "concision-backstop.sh start"]);
	});

	it("carries the matcher through, so a report can name what the hook watches", () => {
		expect(registeredGuards(settings)[0].matcher).toBe("Bash");
	});

	// `if` holds one permission rule, so it is what tells one narrowing of a
	// guard from another where the event and matcher are identical (mantahostels#2825).
	it("carries each entry's own `if` through, not just the matcher", () => {
		const narrowed = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ command: braced("guard-wide-read.sh"), if: "Bash(*cat *)" },
							{ command: braced("guard-wide-read.sh"), if: "Bash(*sed *)" },
						],
					},
				],
			},
		};
		expect(
			registeredGuards(narrowed).map((r: { if?: string }) => r.if),
		).toEqual(["Bash(*cat *)", "Bash(*sed *)"]);
	});
});

/* #940: a plugin's hooks live in its own hooks.json, not the host's settings. */
describe("mergeHooks and keyOrigins", () => {
	const hook = (script: string) => ({
		matcher: "Bash",
		hooks: [{ command: `"\${CLAUDE_PLUGIN_ROOT}"/scripts/${script}` }],
	});
	const sources = [
		{
			file: ".claude/settings.json",
			settings: { hooks: { PreToolUse: [hook("guard-a.sh")] } },
		},
		{
			file: "hooks/hooks.json",
			settings: {
				hooks: {
					PreToolUse: [hook("guard-a.sh"), hook("guard-b.sh")],
					Stop: [hook("guard-c.sh")],
				},
			},
		},
		{ file: "absent.json", settings: null },
	];

	it("registers a hook that only the plugin's file carries", () => {
		expect(guardKeys(mergeHooks(sources))).toEqual([
			"guard-a.sh",
			"guard-b.sh",
			"guard-c.sh",
		]);
	});

	it("names every file a key is registered in", () => {
		const origins = keyOrigins(sources);
		expect(origins.get("guard-a.sh")).toEqual([
			".claude/settings.json",
			"hooks/hooks.json",
		]);
		expect(origins.get("guard-c.sh")).toEqual(["hooks/hooks.json"]);
	});
});

describe("needleIn", () => {
	it("treats an array as an AND across all its members", () => {
		const held = { text: ["is held by session", "which is still running."] };
		expect(needleIn(DENY, held)).toBe(true);
		// session-arbiter's CLI refusal shares the first clause and not the second.
		expect(
			needleIn(
				"session-arbiter: docs/doc-map.md is held by session 735db33b, which `claude agents --json` still lists as live.",
				held,
			),
		).toBe(false);
	});

	/* #1759: guard-branch-publish.sh's force-push deny reprints guard-pull-form.sh's
	 * rewind fragment, so pull-form's needle excludes the frame only publish prints. */
	const needle = {
		text: "NEVER MOVE `main` BACKWARDS",
		unless: ["force-pushes"],
	};

	it("matches a span carrying the text and none of the unless literals", () => {
		expect(
			needleIn("This resets main.\n\nNEVER MOVE `main` BACKWARDS", needle),
		).toBe(true);
	});

	it("refuses a span carrying any unless literal beside the text", () => {
		expect(
			needleIn(
				"This force-pushes `main`.\n\nNEVER MOVE `main` BACKWARDS",
				needle,
			),
		).toBe(false);
	});

	it("still needs the text where no unless literal is present", () => {
		expect(needleIn("force-pushes nothing", { text: "absent" })).toBe(false);
	});
});

describe("fireSpans — a fire is where the HARNESS wrote the words", () => {
	it("reads a hook attachment's stdout", () => {
		expect(fireSpans(attachment())).toEqual([
			{
				route: "hook",
				text: DENY,
				command: expect.stringContaining("guard-file-claim.sh"),
				toolUseID: "toolu_01",
			},
		]);
	});

	it("tags each span with the call the record named it against — mantahostels#3311", () => {
		const spans = fireSpans({
			type: "user",
			uuid: "u1",
			message: {
				content: [
					{
						type: "tool_result",
						is_error: true,
						tool_use_id: "tu1",
						content: "a",
					},
					{
						type: "tool_result",
						is_error: true,
						tool_use_id: "tu2",
						content: "b",
					},
				],
			},
		});
		expect(spans).toEqual([
			{ route: "deny", text: "a", toolUseID: "tu1" },
			{ route: "deny", text: "b", toolUseID: "tu2" },
		]);
	});

	it("leaves toolUseID off a span the record does not name", () => {
		expect(fireSpans(denyRecord())).toEqual([{ route: "deny", text: DENY }]);
		expect(
			fireSpans({ toolUseResult: { stdout: DENY, stderr: "" } })[0].toolUseID,
		).toBeUndefined();
	});

	it("reads hook_additional_context, whose content is an ARRAY", () => {
		const spans = fireSpans(
			attachment({
				type: "hook_additional_context",
				stdout: undefined,
				content: [DENY],
			}),
		);
		expect(spans.map((s: { text: string }) => s.text)).toEqual([DENY]);
	});

	it("reads a Stop block, whose blockingError is an OBJECT wrapping its own string", () => {
		const spans = fireSpans(
			attachment({
				type: "hook_blocking_error",
				stdout: undefined,
				blockingError: {
					blockingError: DENY,
					command: "scripts/concision-backstop.sh stop",
				},
			}),
		);
		expect(spans.map((s: { text: string }) => s.text)).toContain(DENY);
	});

	it("reads a denied tool call's error result", () => {
		expect(fireSpans(denyRecord())).toEqual([{ route: "deny", text: DENY }]);
	});

	it("does NOT read a tool result that succeeded — that is a session quoting the guard", () => {
		expect(fireSpans(denyRecord(DENY, false))).toEqual([]);
	});

	it("tags a Bash stdout `cli`, so a caller can refuse the contaminated route", () => {
		expect(fireSpans({ toolUseResult: { stdout: DENY, stderr: "" } })).toEqual([
			{ route: "cli", text: DENY },
		]);
	});
});

describe("recordFires — the mention/fire split", () => {
	it("counts the deny", () => {
		expect(recordFires(denyRecord(), [SUBJECT])).toHaveLength(1);
	});

	it("does NOT count a `cat` of the guard's source, on a guard subject", () => {
		const catRecord = {
			type: "user",
			uuid: "u2",
			toolUseResult: {
				stdout: `function denyReason(rel, lock) {\n  return \`\${rel} ${DENY}\`;\n}`,
			},
		};
		expect(recordFires(catRecord, [SUBJECT])).toEqual([]);
	});

	it("does count that same Bash result for a subject that allows the cli route", () => {
		const catRecord = {
			type: "user",
			uuid: "u2",
			toolUseResult: { stdout: DENY },
		};
		const candidate = { id: "cand:C6", needles: SUBJECT.needles };
		expect(recordFires(catRecord, [candidate])).toHaveLength(1);
	});

	/*
	 * mantahostels#2118: guard-branch.sh both DENIES a branch move and, on the clean branch,
	 * injects the same rule fragment pre-emptively — and its deny reprints that
	 * fragment in full.
	 */
	describe("a needle that narrows the subject's routes", () => {
		const fragment = "THE SHARED WORKING TREE STAYS ON `main`.";
		const branch = {
			id: "guard:guard-branch.sh",
			routes: ["hook", "deny"],
			needles: [
				{ id: "branch-move", text: "This moves the shared working tree off" },
				{ id: "branch-shared-tree", routes: ["hook"], text: fragment },
			],
		};
		const denyCarryingFragment = () =>
			denyRecord(
				`This moves the shared working tree off its branch: git checkout x\n\n${fragment}\n`,
			);

		it("does not count the deny that reprints the fragment as an injection too", () => {
			const fires = recordFires(denyCarryingFragment(), [branch]);
			expect(fires.map((f: { needle: string }) => f.needle)).toEqual([
				"branch-move",
			]);
		});

		it("counts the same fragment on the hook route", () => {
			const fires = recordFires(
				attachment({ stdout: `${fragment}\n\nNever \`git checkout\` it.` }),
				[branch],
			);
			expect(fires.map((f: { needle: string }) => f.needle)).toEqual([
				"branch-shared-tree",
			]);
		});
	});

	it("does NOT count the guard's own words in an assistant turn", () => {
		expect(
			recordFires(
				{
					type: "assistant",
					uuid: "u3",
					message: { content: [{ type: "text", text: DENY }] },
				},
				[SUBJECT],
			),
		).toEqual([]);
	});
});

describe("recordMentions — carries the record's own timestamp for mantahostels#1896's --since", () => {
	it("tags a mention with the record's timestamp", () => {
		const catRecord = {
			type: "user",
			uuid: "u2",
			timestamp: "2026-08-20T10:00:00.000Z",
			toolUseResult: {
				stdout: `function denyReason(rel, lock) {\n  return \`\${rel} ${DENY}\`;\n}`,
			},
		};
		expect(recordMentions(catRecord, [SUBJECT])).toEqual([
			{
				subject: "guard:guard-file-claim.sh",
				needle: "held",
				at: "2026-08-20T10:00:00.000Z",
			},
		]);
	});

	it("tags a mention `at: null` where the record carries no timestamp", () => {
		const catRecord = {
			type: "user",
			uuid: "u2",
			toolUseResult: {
				stdout: `function denyReason(rel, lock) {\n  return \`\${rel} ${DENY}\`;\n}`,
			},
		};
		expect(recordMentions(catRecord, [SUBJECT])[0].at).toBeNull();
	});
});

describe("transcriptMentions", () => {
	it("carries each record's own timestamp through, not the first record's", () => {
		const line = (o: unknown) => JSON.stringify(o);
		const text = [
			line({
				type: "user",
				uuid: "u1",
				timestamp: "2026-08-20T10:00:00.000Z",
				toolUseResult: { stdout: DENY },
			}),
			line({
				type: "user",
				uuid: "u2",
				timestamp: "2026-08-21T10:00:00.000Z",
				toolUseResult: { stdout: DENY },
			}),
		].join("\n");
		const mentions = transcriptMentions(text, [SUBJECT], "main");
		expect(mentions.map((m: { at: string }) => m.at)).toEqual([
			"2026-08-20T10:00:00.000Z",
			"2026-08-21T10:00:00.000Z",
		]);
	});
});

describe("transcriptFires", () => {
	const line = (o: unknown) => JSON.stringify(o);

	it("dedupes the two records one warn writes, which share a toolUseID", () => {
		const text = [
			line(attachment()),
			line(
				attachment({
					type: "hook_additional_context",
					stdout: undefined,
					content: [DENY],
				}),
			),
		].join("\n");
		expect(transcriptFires(text, [SUBJECT], "main")).toHaveLength(1);
	});

	it("counts two fires in two different hook calls", () => {
		const text = [
			line(attachment()),
			line(attachment({ toolUseID: "toolu_02" })),
		].join("\n");
		expect(transcriptFires(text, [SUBJECT], "main")).toHaveLength(2);
	});

	it("skips a sidechain record on tier main — a subagent is not this session", () => {
		const text = line({ ...attachment(), isSidechain: true });
		expect(transcriptFires(text, [SUBJECT], "main")).toEqual([]);
	});

	it("reads a sidechain-marked record on tier subagent — it is that subagent's own chain, mantahostels#1779", () => {
		const text = line({ ...attachment(), isSidechain: true });
		expect(transcriptFires(text, [SUBJECT], "subagent")).toHaveLength(1);
	});

	it("skips a half-written final line rather than reporting an empty corpus", () => {
		const text = `${line(denyRecord())}\n{"type":"user","message":{"cont`;
		expect(transcriptFires(text, [SUBJECT], "main")).toHaveLength(1);
	});
});

describe("tally", () => {
	it("keeps the newest timestamp as the last fire", () => {
		const rolled = tally([
			{
				subject: "g",
				needle: "held",
				route: "deny",
				at: "2026-08-01T00:00:00Z",
			},
			{
				subject: "g",
				needle: "held",
				route: "hook",
				at: "2026-08-20T00:00:00Z",
			},
			{
				subject: "g",
				needle: "held",
				route: "deny",
				at: "2026-08-09T00:00:00Z",
			},
		]);
		expect(rolled.get("g")).toMatchObject({
			total: 3,
			last: "2026-08-20T00:00:00Z",
			byRoute: { deny: 2, hook: 1 },
		});
	});

	// One guard prints several rules, so a subject-wide `last` cannot say when
	// any ONE of them last fired — what docs/doc-map.md §5's test asks (mantahostels#2118).
	it("keeps a last fire per needle, not just per subject", () => {
		const rolled = tally([
			{
				subject: "g",
				needle: "branch-move",
				route: "deny",
				at: "2026-08-07T00:00:00Z",
			},
			{
				subject: "g",
				needle: "branch-shared-tree",
				route: "hook",
				at: "2026-08-29T00:00:00Z",
			},
		]);
		expect(rolled.get("g").lastByNeedle).toEqual({
			"branch-move": "2026-08-07T00:00:00Z",
			"branch-shared-tree": "2026-08-29T00:00:00Z",
		});
	});

	it("leaves a needle out of lastByNeedle where its only fire is undated", () => {
		const rolled = tally([
			{ subject: "g", needle: "branch-move", route: "deny", at: null },
		]);
		expect(rolled.get("g").lastByNeedle).toEqual({});
		expect(rolled.get("g").byNeedle).toEqual({ "branch-move": 1 });
	});
});

describe("transcriptFiles", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-files-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("walks both tiers — a session's own file and its dispatched subagents — mantahostels#1779", () => {
		fs.writeFileSync(path.join(dir, "s1.jsonl"), "{}\n");
		const subDir = path.join(dir, "s1", "subagents");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, "agent-a.jsonl"), "{}\n");
		fs.writeFileSync(path.join(subDir, "agent-b.jsonl"), "{}\n");

		const files = transcriptFiles(dir);
		expect(files).toHaveLength(3);
		expect(
			files.filter((f: { tier: string }) => f.tier === "main"),
		).toHaveLength(1);
		expect(
			files.filter((f: { tier: string }) => f.tier === "subagent"),
		).toHaveLength(2);
	});

	it("tags a top-level .jsonl by path, not by assumption — --dir pointed straight at a subagents/ dir reads subagent, not main — mantahostels#1779", () => {
		const subDir = path.join(dir, "s1", "subagents");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, "agent-a.jsonl"), "{}\n");

		const files = transcriptFiles(subDir);
		expect(files).toEqual([
			{ file: path.join(subDir, "agent-a.jsonl"), tier: "subagent" },
		]);
	});

	it("skips a session with no subagents/ directory silently — the ordinary case", () => {
		fs.writeFileSync(path.join(dir, "s1.jsonl"), "{}\n");
		fs.mkdirSync(path.join(dir, "s1"));
		expect(transcriptFiles(dir)).toEqual([
			{ file: path.join(dir, "s1.jsonl"), tier: "main" },
		]);
	});

	it("surfaces a subagents/ dir that fails to read for a real reason, not just ENOENT — mantahostels#1779", () => {
		fs.writeFileSync(path.join(dir, "s1.jsonl"), "{}\n");
		const subDir = path.join(dir, "s1", "subagents");
		fs.mkdirSync(subDir, { recursive: true });
		fs.chmodSync(subDir, 0o000);
		try {
			const files = transcriptFiles(dir);
			// EISDIR/EACCES surfaces as an entry pointing at the directory itself,
			// which every caller's own readFileSync attempt reports as unreadable
			// rather than silently dropping that session's whole subagent tier.
			expect(files).toContainEqual({ file: subDir, tier: "subagent" });
		} finally {
			fs.chmodSync(subDir, 0o700);
		}
	});
});

describe("sessionKeyFor", () => {
	it("keys a main file on itself — already unique per session", () => {
		expect(sessionKeyFor("/x/s1.jsonl", "main")).toBe("/x/s1.jsonl");
	});

	it("keys every subagent of one session on the SAME parent, not one key per file — mantahostels#1779", () => {
		const a = sessionKeyFor("/x/s1/subagents/agent-a.jsonl", "subagent");
		const b = sessionKeyFor("/x/s1/subagents/agent-b.jsonl", "subagent");
		expect(a).toBe(b);
		expect(a).toBe(path.join("/x", "s1"));
	});
});

/* The slug `transcriptDir` spells its project directory with is
 * `project-slug.test.ts`'s, which asserts the rule across every caller at once
 * — the fault is divergence, and a per-caller suite cannot see it. */
