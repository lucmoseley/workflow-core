// @vitest-environment node
/*
 * The census's three counts, asserted on a corpus small enough to read
 * (mantahostels#3287, which landed the instrument).
 *
 * The published figures are NOT asserted here and cannot be: the corpus is
 * machine-local, gitignored and growing, so a test pinned to 877 losses would
 * fail on the next session's transcripts. What is pinned instead is the
 * arithmetic and the classification — that a lost deny is counted once per
 * guard, that a deny is counted once per CALL however many needles it trips,
 * that the denominator counts silent allows, and that a guard whose trigger
 * cannot be read reports unknown rather than a zero rate.
 *
 * `docs/data/lost-deny-*-2026-09-06.csv` is the real fixture: the dumps the
 * published figures were computed from.
 *
 * EVERY CASE RUNS THE SCRIPT END TO END through runInProcess — against a
 * `WFC_LOST_DENY_ROOT` fixture tree (`fixtureRoot` below) or this checkout's
 * own — and reads its `--json` or its text, never a helper behind it (#1369:
 * nothing is exported for its tests; a program is tested by running it).
 *
 * CI's vitest step runs this file; the script itself gates nothing and is run
 * by hand. Breaking it lets a re-run misstate which `PreToolUse` guards fail
 * open and how many real denies escaped, so
 * the lost-deny-recoverability note (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/lost-deny-recoverability.md)'s figures, and the choice of
 * which guard to harden, rest on a miscount.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";
import { buildBashCall } from "./lib/transcript-testkit";

const SCRIPT = path.resolve(__dirname, "lost-deny-rates.js");

/** Every temp dir a case makes, removed once the file is done: afterAll, not
 * afterEach, because `corpusDir` is made once and read by every case. */
const made: string[] = [];
const tempDir = (prefix: string) => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	made.push(d);
	return d;
};
afterAll(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

let corpusDir: string;

beforeAll(() => {
	corpusDir = tempDir("ldr-corpus-");
});

const SETTINGS = {
	hooks: {
		PreToolUse: [
			{
				matcher: "Bash",
				hooks: [{ command: "scripts/denier.sh", if: "Bash(git *)" }],
			},
		],
	},
};

/** SETTINGS with denier.sh's trigger made unreadable. */
const JUNK_SETTINGS = {
	hooks: {
		PreToolUse: [
			{
				matcher: "Bash",
				hooks: [{ command: "scripts/denier.sh", if: "junk" }],
			},
		],
	},
};

const NEEDLES = {
	guards: {
		"denier.sh": {
			needles: [
				{ id: "d1", kind: "deny", text: "REFUSED" },
				{ id: "d2", kind: "deny", text: "not on this branch" },
				{ id: "w1", kind: "warn", text: "you may want to" },
			],
		},
		"warner.sh": { needles: [{ id: "w", kind: "deny", text: "never read" }] },
	},
};

/** A registry whose denier.sh entry carries no `kind: "deny"` needle at all. */
const WARN_ONLY_NEEDLES = {
	guards: { "denier.sh": { needles: [{ id: "w", kind: "warn", text: "x" }] } },
};

/**
 * A `WFC_LOST_DENY_ROOT` tree for a run of the script itself, read as a core:
 * `settings` as `self-plugin/hooks/hooks.json`, four fixture guards under `scripts/` (denier.sh
 * writes a deny verdict; the rest cannot deny), and `needles` as
 * `scripts/guard-fire-needles.json` — omitted where `needles` is null.
 */
function fixtureRoot(settings: unknown, needles: unknown = NEEDLES) {
	const root = tempDir("ldr-fixture-");
	writeSelfPlugin(root, settings);
	mkdirSync(join(root, "scripts"));
	for (const [name, body] of [
		["denier.sh", 'echo \'{"permissionDecision":"deny"}\''],
		["warner.sh", 'echo \'{"additionalContext":"hm"}\''],
		["post.sh", ""],
		["other.sh", ""],
	])
		addGuard(root, name, body);
	if (needles !== null)
		writeFileSync(
			join(root, "scripts", "guard-fire-needles.json"),
			JSON.stringify(needles),
		);
	return root;
}

function writeSelfPlugin(root: string, body: unknown) {
	mkdirSync(join(root, "self-plugin", "hooks"), { recursive: true });
	writeFileSync(
		join(root, "self-plugin", "hooks", "hooks.json"),
		typeof body === "string" ? body : JSON.stringify(body),
	);
}

function addGuard(root: string, name: string, body: string) {
	writeFileSync(join(root, "scripts", name), `#!/bin/bash\n${body}\n`);
}

/** The default fixture: SETTINGS routes denier.sh alone, NEEDLES' needles. */
const ROOT = fixtureRoot(SETTINGS);

/**
 * Run the script against `root` over a one-transcript corpus of `records`. A
 * string record is written as the raw line it is — a malformed line, say.
 */
function cli(root: string, records: unknown[], ...args: string[]) {
	const dir = tempDir("ldr-cli-corpus-");
	writeFileSync(
		join(dir, "t.jsonl"),
		records
			.map(
				(record) =>
					`${typeof record === "string" ? record : JSON.stringify(record)}\n`,
			)
			.join(""),
	);
	const r = runInProcess(SCRIPT, ["--dir", dir, ...args], {
		env: { WFC_LOST_DENY_ROOT: root },
	});
	return { ...r, json: () => JSON.parse(r.stdout) };
}

const rowOf = (
	r: ReturnType<typeof cli>,
	guard: string,
): Record<string, unknown> =>
	r.json().rows.find((row: { guard: string }) => row.guard === guard);

interface Row {
	guard: string;
	lost: number;
	denies: number;
	spoke: number;
	population: number | null;
	unknown: string | null;
	cannotDeny: boolean;
	noDenyNeedle: boolean;
	lossPct: number | null;
	ratePct: number | null;
	rateLowPct: number | null;
	rateHighPct: number | null;
	expected: number | null;
	expectedLow: number | null;
	expectedHigh: number | null;
}

/**
 * A `--json` run over `records` against `root` (ROOT by default), exit 0
 * asserted: its corpus block, its rows, and one guard's row by name
 * (denier.sh by default).
 */
function reportAt(root: string, records: unknown[], ...args: string[]) {
	const r = cli(root, records, "--json", ...args);
	expect(r.status).toBe(0);
	const body = r.json() as { corpus: Record<string, unknown>; rows: Row[] };
	const row = (guard = "denier.sh") => {
		const found = body.rows.find((x) => x.guard === guard);
		if (!found) throw new Error(`no row for ${guard}`);
		return found;
	};
	return { ...body, row };
}

const report = (records: unknown[], ...args: string[]) =>
	reportAt(ROOT, records, ...args);

/** The text report of a run against `root`, exit 0 asserted. */
function text(root: string, records: unknown[], ...args: string[]) {
	const r = cli(root, records, ...args);
	expect(r.status).toBe(0);
	return r.stdout;
}

function lostRecord(guard: string, toolUseID: string, at: string) {
	return {
		type: "user",
		timestamp: at,
		attachment: {
			type: "hook_cancelled",
			hookEvent: "PreToolUse",
			command: `bash scripts/${guard}`,
			toolUseID,
		},
	};
}

/* CARRIES A `tool_use_id` BY DEFAULT (mantahostels#3311) — the path a real transcript takes,
 * the harness naming the call on every `tool_result` it writes. Pass `null`
 * where the uuid fallback IS the subject. */
function denyRecord(
	uuid: string,
	resultText: string,
	at = "2026-09-01T00:00:00.000Z",
	toolUseId: string | null = `tu-${uuid}`,
) {
	return {
		type: "user",
		uuid,
		timestamp: at,
		message: {
			content: [
				{
					type: "tool_result",
					is_error: true,
					...(toolUseId === null ? {} : { tool_use_id: toolUseId }),
					content: resultText,
				},
			],
		},
	};
}

/** A record whose message carries several tool_results — parallel calls, more
 * than one denied — rather than `denyRecord`'s single one. A part with a null
 * `toolUseId` carries none. */
function multiDenyRecord(
	uuid: string,
	parts: Array<{ toolUseId: string | null; text: string }>,
	at = "2026-09-01T00:00:00.000Z",
) {
	return {
		type: "user",
		uuid,
		timestamp: at,
		message: {
			content: parts.map((p) => ({
				type: "tool_result",
				is_error: true,
				...(p.toolUseId === null ? {} : { tool_use_id: p.toolUseId }),
				content: p.text,
			})),
		},
	};
}

const callRecord = (command: string, at = "2026-09-01T00:00:00.000Z") =>
	buildBashCall(command, "t1", { timestamp: at });

describe("the deny rate's Wilson interval, as a row reports it", () => {
	/** `n` routed calls, `hits` denies — each on a call of its own. */
	function sample(hits: number, n: number) {
		const records: unknown[] = [];
		for (let i = 0; i < n; i++) records.push(callRecord(`git log -${i}`));
		for (let i = 0; i < hits; i++) records.push(denyRecord(`u${i}`, "REFUSED"));
		return records;
	}

	it("is null with no observations, never a zero rate", () => {
		expect(report([]).row()).toMatchObject({
			population: 0,
			ratePct: null,
			rateLowPct: null,
			rateHighPct: null,
			expected: null,
		});
	});

	it("puts a zero numerator's interval above zero", () => {
		const row = report(sample(0, 1000)).row();
		expect(row.ratePct).toBe(0);
		expect(row.rateLowPct).toBe(0);
		expect(row.rateHighPct).toBeGreaterThan(0);
	});

	it("reproduces a published census row to two decimals", () => {
		// guard-issue-close.js: 255 denies in 16,057 calls, 1.588% [1.41-1.79].
		const row = report(sample(255, 16_057)).row();
		expect(row).toMatchObject({ denies: 255, population: 16_057 });
		expect(row.ratePct).toBeCloseTo(1.588, 3);
		expect(row.rateLowPct).toBeCloseTo(1.41, 2);
		expect(row.rateHighPct).toBeCloseTo(1.79, 2);
	});

	it("clamps a saturated proportion to 100%", () => {
		const row = report(sample(10, 10)).row();
		expect(row.ratePct).toBe(100);
		expect(row.rateHighPct).toBe(100);
		expect(text(ROOT, sample(10, 10))).toContain("100.0000 [72.25-100.00]");
	});
});

describe("the --since/--until window", () => {
	const root = fixtureRoot(SETTINGS);
	const { timestamp: _dropped, ...undated } = lostRecord(
		"denier.sh",
		"tu1",
		"2026-09-01T00:00:00.000Z",
	);

	it("keeps everything where no window is given, undated included", () => {
		const r = cli(root, [undated], "--json");
		expect(r.status).toBe(0);
		expect(rowOf(r, "denier.sh").lost).toBe(1);
		expect(r.json().corpus.undated).toBe(0);
	});

	it("excludes an undated record from a window rather than guessing", () => {
		const r = cli(
			root,
			[undated],
			"--json",
			"--until",
			"2026-09-05T00:00:00.000Z",
		);
		expect(r.status).toBe(0);
		expect(rowOf(r, "denier.sh").lost).toBe(0);
		expect(r.json().corpus.undated).toBe(1);
	});

	it("cuts at both ends", () => {
		const r = cli(
			root,
			[
				lostRecord("denier.sh", "tu1", "2026-08-14T23:59:59.999Z"),
				lostRecord("denier.sh", "tu2", "2026-08-15T00:00:00.000Z"),
				lostRecord("denier.sh", "tu3", "2026-09-05T00:00:00.001Z"),
			],
			"--json",
			"--since",
			"2026-08-15T00:00:00.000Z",
			"--until",
			"2026-09-05T00:00:00.000Z",
		);
		expect(r.status).toBe(0);
		expect(rowOf(r, "denier.sh").lost).toBe(1);
		expect(r.json().corpus).toMatchObject({
			first: "2026-08-15T00:00:00.000Z",
			last: "2026-08-15T00:00:00.000Z",
		});
	});
});

describe("the needle registry, as a run reads it", () => {
	it("keys on the basename, dropping the arguments guardKey carries", () => {
		const root = fixtureRoot(SETTINGS, {
			guards: {
				"denier.sh stop": {
					needles: [{ id: "a", kind: "deny", text: "REFUSED" }],
				},
			},
		});
		const r = cli(
			root,
			[callRecord("git status"), denyRecord("u1", "REFUSED")],
			"--json",
		);
		expect(r.status).toBe(0);
		expect(rowOf(r, "denier.sh")).toMatchObject({
			denies: 1,
			population: 1,
			ratePct: 100,
		});
	});

	it("gives a guard outside the scope's trigger table no row and no count", () => {
		// NEEDLES carries warner.sh too; SETTINGS routes only denier.sh, so the
		// table is the filter and the needle registry is not (mantahostels#3350).
		const r = cli(
			fixtureRoot(SETTINGS),
			[callRecord("git status"), denyRecord("u1", "never read")],
			"--json",
		);
		expect(r.status).toBe(0);
		expect(r.json().rows.map((row: { guard: string }) => row.guard)).toEqual([
			"denier.sh",
		]);
		expect(rowOf(r, "denier.sh")).toMatchObject({ denies: 0, spoke: 0 });
	});

	it("survives a registry with no guards key", () => {
		const r = cli(
			fixtureRoot(SETTINGS, {}),
			[callRecord("git status")],
			"--json",
		);
		expect(r.status).toBe(0);
		expect(rowOf(r, "denier.sh")).toMatchObject({
			population: 1,
			noDenyNeedle: true,
			ratePct: null,
		});
	});
});

describe("lost denies", () => {
	it("counts one per guard record and dedupes the CALL, not the record", () => {
		const { row, corpus } = report([
			lostRecord("denier.sh", "tu1", "2026-09-01T00:00:00.000Z"),
			lostRecord("denier.sh", "tu1", "2026-09-01T00:00:01.000Z"),
			lostRecord("denier.sh", "tu2", "2026-09-02T00:00:00.000Z"),
		]);
		expect(row().lost).toBe(3);
		expect(corpus.lostCalls).toBe(2);
	});

	it("tracks the loss window's ends", () => {
		const { corpus } = report([
			lostRecord("denier.sh", "tu2", "2026-09-02T00:00:00.000Z"),
			lostRecord("denier.sh", "tu1", "2026-09-01T00:00:00.000Z"),
		]);
		expect(corpus.first).toBe("2026-09-01T00:00:00.000Z");
		expect(corpus.last).toBe("2026-09-02T00:00:00.000Z");
	});

	it("ignores a hook failure on an event that cannot deny", () => {
		const rec = lostRecord("denier.sh", "tu1", "2026-09-01T00:00:00.000Z");
		rec.attachment.hookEvent = "PostToolUse";
		const { row, corpus } = report([rec]);
		expect(row().lost).toBe(0);
		expect(corpus.lostCalls).toBe(0);
	});

	it("ignores a guard with no row — a warn-only hook cannot lose a deny", () => {
		const { rows, corpus } = report([
			lostRecord("warner.sh", "tu1", "2026-09-01T00:00:00.000Z"),
		]);
		expect(rows.map((r) => [r.guard, r.lost])).toEqual([["denier.sh", 0]]);
		expect(corpus.lostCalls).toBe(0);
	});

	it("excludes a loss outside the window", () => {
		const { row } = report(
			[
				lostRecord("denier.sh", "tu1", "2026-09-01T00:00:00.000Z"),
				lostRecord("denier.sh", "tu2", "2026-09-09T00:00:00.000Z"),
			],
			"--until",
			"2026-09-05T00:00:00.000Z",
		);
		expect(row().lost).toBe(1);
	});
});

describe("deny events — one per CALL", () => {
	it("counts one call however many needles it trips", () => {
		const { row } = report([
			denyRecord(
				"u1",
				"REFUSED — not on this branch, and you may want to stop",
			),
		]);
		expect(row()).toMatchObject({ denies: 1, spoke: 1 });
	});

	it("counts two parallel denied calls in one record as two, not one — mantahostels#3307", () => {
		const { row } = report([
			multiDenyRecord("u1", [
				{ toolUseId: "tu1", text: "REFUSED" },
				{ toolUseId: "tu2", text: "not on this branch" },
			]),
		]);
		expect(row().denies).toBe(2);
	});

	it("counts a call the harness named on its tool_result, not the record's uuid — mantahostels#3311", () => {
		// Two deny-route records for one call — a retry, or a split write — carry
		// two uuids and one tool_use_id; a third names a call of its own.
		const { row } = report([
			denyRecord("u1", "REFUSED", "2026-09-01T00:00:00.000Z", "tu1"),
			denyRecord("u2", "REFUSED again", "2026-09-01T00:00:00.000Z", "tu1"),
			denyRecord("u3", "REFUSED", "2026-09-01T00:00:00.000Z", "tu2"),
		]);
		expect(row().denies).toBe(2);
	});

	it("takes a hook attachment's own toolUseID as the call", () => {
		const fire = (uuid: string) => ({
			type: "user",
			uuid,
			timestamp: "2026-09-01T00:00:00.000Z",
			attachment: {
				type: "hook_success",
				command: "bash scripts/denier.sh",
				stdout: "REFUSED",
				toolUseID: "tu1",
			},
		});
		expect(report([fire("u1"), fire("u2")]).row().denies).toBe(1);
	});

	it("still counts a deny whose tool_result carries no id, on the record's uuid", () => {
		const idless = (uuid: string) =>
			denyRecord(uuid, "REFUSED", "2026-09-01T00:00:00.000Z", null);
		expect(report([idless("u1"), idless("u1")]).row().denies).toBe(1);
		expect(report([idless("u1"), idless("u2")]).row().denies).toBe(2);
	});

	it("credits an id-less denied result to every call id its record carries, never only the first — mantahostels#3307", () => {
		// The fallback no span names: the record's own ids, all of them, before
		// its uuid.
		const { row } = report([
			multiDenyRecord("u1", [
				{ toolUseId: "tu1", text: "allowed" },
				{ toolUseId: "tu2", text: "allowed" },
				{ toolUseId: null, text: "REFUSED" },
			]),
		]);
		expect(row().denies).toBe(2);
	});

	it("credits only the parallel call whose own result matched — mantahostels#3311", () => {
		const { row } = report([
			multiDenyRecord("u1", [
				{ toolUseId: "tu1", text: "REFUSED" },
				{ toolUseId: "tu2", text: "allowed, nothing here" },
			]),
		]);
		expect(row()).toMatchObject({ denies: 1, spoke: 1 });
	});

	it("separates a warn-only fire from a deny", () => {
		const { row } = report([denyRecord("u1", "you may want to reconsider")]);
		expect(row()).toMatchObject({ denies: 0, spoke: 1 });
	});

	it("does not read a mention as a fire — a `cat` of the guard is not a deny", () => {
		const { row } = report([
			{
				type: "user",
				timestamp: "2026-09-01T00:00:00.000Z",
				uuid: "u1",
				toolUseResult: {
					stdout:
						'echo \'{"permissionDecision":"deny","permissionDecisionReason":"REFUSED"}\'',
				},
			},
		]);
		expect(row()).toMatchObject({ denies: 0, spoke: 0 });
	});
});

describe("the true population", () => {
	it("counts every routed call, silent allows included", () => {
		const { row } = report([
			callRecord("git status"),
			callRecord("git log"),
			callRecord("ls"),
			{
				type: "assistant",
				timestamp: "2026-09-01T00:00:00.000Z",
				message: {
					content: [
						{
							type: "tool_use",
							name: "Read",
							input: { command: "git status" },
						},
					],
				},
			},
		]);
		expect(row().population).toBe(2);
	});

	it("counts a call the guard was LOST on — the loss is not an absence", () => {
		const { row } = report([
			lostRecord("denier.sh", "tu1", "2026-09-01T00:00:00.000Z"),
			callRecord("git status"),
		]);
		expect(row().population).toBe(1);
	});
});

describe("the rows", () => {
	it("divides denies by the true population, not by the calls spoken on", () => {
		const records: unknown[] = [denyRecord("u1", "REFUSED")];
		for (let i = 0; i < 99; i++)
			records.push(callRecord(`git log -${i}`, "2026-09-01T00:00:00.000Z"));
		records.push(callRecord("git status"));
		const row = report(records).row();
		expect(row.population).toBe(100);
		expect(row.spoke).toBe(1);
		expect(row.ratePct).toBeCloseTo(1, 6);
	});

	it("multiplies losses by the rate to get expected escapes", () => {
		const records: unknown[] = [denyRecord("u1", "REFUSED")];
		for (let i = 0; i < 100; i++)
			records.push(callRecord(`git log -${i}`, "2026-09-01T00:00:00.000Z"));
		for (let i = 0; i < 50; i++)
			records.push(
				lostRecord("denier.sh", `tu${i}`, "2026-09-01T00:00:00.000Z"),
			);
		expect(report(records).row().expected).toBeCloseTo(0.5, 6);
	});

	it("reports a guard whose trigger cannot be read as unknown, never zero", () => {
		const row = reportAt(fixtureRoot(JUNK_SETTINGS), [
			callRecord("git status"),
		]).row();
		expect(row.unknown).toBeTruthy();
		expect(row.population).toBeNull();
		expect(row.ratePct).toBeNull();
		expect(row.expected).toBeNull();
	});

	it("sorts an unknown guard first, so it cannot be read past", () => {
		// aaa-denier.sh has a real expected figure and sorts first by name;
		// denier.sh's unreadable trigger still puts it ahead.
		const root = fixtureRoot(
			{
				hooks: {
					PreToolUse: [
						...JUNK_SETTINGS.hooks.PreToolUse,
						{
							matcher: "Bash",
							hooks: [{ command: "scripts/aaa-denier.sh", if: "Bash(git *)" }],
						},
					],
				},
			},
			{
				guards: {
					"aaa-denier.sh": {
						needles: [{ id: "a", kind: "deny", text: "REFUSED" }],
					},
				},
			},
		);
		addGuard(root, "aaa-denier.sh", 'echo \'{"permissionDecision":"deny"}\'');
		const { rows } = reportAt(root, [
			callRecord("git status"),
			denyRecord("u1", "REFUSED"),
			lostRecord("aaa-denier.sh", "tu9", "2026-09-01T00:00:00.000Z"),
		]);
		expect(rows.map((r) => [r.guard, r.expected === null])).toEqual([
			["denier.sh", true],
			["aaa-denier.sh", false],
		]);
	});

	it("orders two guards with no expected figure alphabetically, never NaN-unspecified", () => {
		// Registered in REVERSE-alphabetical order, deliberately: a comparator
		// that returns NaN for a null/null tie leaves insertion order untouched,
		// which would pass here by accident if the guards were registered
		// alphabetically to begin with.
		const root = fixtureRoot({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ command: "scripts/zzz-denier.sh", if: "junk" }],
					},
					...JUNK_SETTINGS.hooks.PreToolUse,
				],
			},
		});
		addGuard(root, "zzz-denier.sh", 'echo \'{"permissionDecision":"deny"}\'');
		expect(reportAt(root, []).rows.map((r) => r.guard)).toEqual([
			"denier.sh",
			"zzz-denier.sh",
		]);
	});

	it("reads a deny-capable guard with no deny needle registered as unknown, not a measured zero", () => {
		const row = reportAt(fixtureRoot(SETTINGS, WARN_ONLY_NEEDLES), [
			callRecord("git status"),
		]).row();
		expect(row.population).toBe(1);
		expect(row.ratePct).toBeNull();
		expect(row.expected).toBeNull();
		expect(row.noDenyNeedle).toBe(true);
	});
});

describe("the text report", () => {
	const warnerRoot = () =>
		fixtureRoot(
			{
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [{ command: "scripts/warner.sh", if: "Bash(npm *)" }],
						},
					],
				},
			},
			{},
		);

	it("tells an unreadable trigger apart from a guard nothing called", () => {
		const out = text(fixtureRoot(JUNK_SETTINGS), []);
		expect(out).toContain("unknown (trigger)");
		expect(out).not.toContain("unknown (no calls)");
	});

	it("labels a guard with a readable trigger and no calls as such", () => {
		const out = text(ROOT, []);
		expect(out).toContain("unknown (no calls)");
		expect(out).not.toContain("unknown (trigger)");
	});

	it("labels a guard with a readable trigger, calls, and no deny needle registered", () => {
		const out = text(fixtureRoot(SETTINGS, WARN_ONLY_NEEDLES), [
			callRecord("git status"),
		]);
		expect(out).toContain("unknown (no deny needle)");
		expect(out).not.toContain("unknown (no calls)");
		expect(out).not.toContain("unknown (trigger)");
	});

	it("tells a guard that cannot deny from one whose needle is missing (mantahostels#3350)", () => {
		const out = text(
			warnerRoot(),
			[callRecord("npm test")],
			"--scope",
			"nondeny",
		);
		expect(out).toContain("n/a (cannot deny)");
		expect(out).not.toContain("unknown (no deny needle)");
		// The escaped-deny total is not a floor because of this row.
		expect(out).toContain("cannot deny at all");
		expect(out).not.toContain("have NO RATE");
	});

	it("reports the scope and the guard count it priced (mantahostels#3350)", () => {
		expect(text(ROOT, [])).toContain("SCOPE   deny — 1 PreToolUse guard(s)");
	});

	it("prints a non-deny guard's loss % off its true population (mantahostels#3350)", () => {
		// Four calls reach the guard; one of them lost it.
		const records = [
			...["npm a", "npm b", "npm c", "npm d"].map((c) => callRecord(c)),
			{
				timestamp: "2026-09-01T00:00:00.000Z",
				attachment: {
					type: "hook_cancelled",
					hookEvent: "PreToolUse",
					command: "scripts/warner.sh",
					toolUseID: "tu1",
				},
			},
		];
		const root = warnerRoot();
		expect(
			reportAt(root, records, "--scope", "nondeny").row("warner.sh").lossPct,
		).toBe(25);
		expect(text(root, records, "--scope", "nondeny")).toContain("25.0000");
	});

	it("names a nonzero skipped-line count and stays silent at zero — mantahostels#3307", () => {
		expect(text(ROOT, [callRecord("git status")])).not.toContain(
			"malformed line",
		);
		expect(
			text(ROOT, ["garbage", "{nope", "]", callRecord("git status")]),
		).toContain("3 malformed line(s) skipped");
	});
});

describe("the staleness check against lib/guard-deny-rates.js", () => {
	/** `name` registered alone under `scope`, its source `body`. */
	function unpinnedFor(name: string, body: string, scope: string) {
		const root = fixtureRoot(
			{
				hooks: {
					PreToolUse: [
						{ matcher: "Bash", hooks: [{ command: `scripts/${name}` }] },
					],
				},
			},
			{},
		);
		addGuard(root, name, body);
		const { corpus, rows } = reportAt(root, [], "--scope", scope);
		// The guard is in the table, so a silence below is a verdict on it.
		expect(rows.map((r) => r.guard)).toEqual([name]);
		return corpus.unpinned;
	}

	it("names a deny-capable guard the pinned table has no row for", () => {
		expect(
			unpinnedFor(
				"guard-not-a-real-guard.sh",
				'echo \'{"permissionDecision":"deny"}\'',
				"deny",
			),
		).toEqual(["guard-not-a-real-guard.sh"]);
	});

	it("passes over a guard that cannot deny, which that table never pins", () => {
		expect(
			unpinnedFor(
				"guard-not-a-real-guard.sh",
				'echo \'{"additionalContext":"hm"}\'',
				"nondeny",
			),
		).toEqual([]);
	});

	it("says nothing about a guard the pinned table carries", () => {
		expect(
			unpinnedFor(
				"guard-issue-close.js",
				'echo \'{"permissionDecision":"deny"}\'',
				"deny",
			),
		).toEqual([]);
	});

	it("names the guards the pinned table has no row for in the text", () => {
		const out = text(ROOT, []);
		expect(out).toContain(
			"STALE: lib/guard-deny-rates.js has no row for 1 deny-capable guard(s):",
		);
		expect(out).toContain("      denier.sh");
	});
});

describe("a transcript that throws mid-parse", () => {
	// A JSONL line that parses (it is valid JSON) but is not a record — a field
	// read on a bare `null` throws mid-scan, after the loss before it already
	// reached a fresh per-file accumulator.
	const records = [
		lostRecord("denier.sh", "tu1", "2026-09-01T00:00:00.000Z"),
		"null",
	];

	it("does not count the file as scanned, and discards its partial counts", () => {
		const { corpus, row } = report(records);
		expect(corpus).toMatchObject({ scanned: 0, unreadable: 1, lostCalls: 0 });
		expect(row().lost).toBe(0);
	});

	it("names the file and the parse fault in the text", () => {
		const out = text(ROOT, records);
		expect(out).toContain("0 of 1 transcripts read, 1 unreadable");
		expect(out).toMatch(/t\.jsonl \(parse: /);
	});
});

describe("the needles file, refused in one sentence", () => {
	it("reports a missing file as one sentence, not a thrown stack", () => {
		const root = fixtureRoot(SETTINGS, null);
		const r = cli(root, []);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`cannot read ${join(root, "scripts", "guard-fire-needles.json")}`,
		);
		expect(r.stderr).not.toMatch(/\n\s+at /);
	});

	it("reports malformed JSON as one sentence, not a thrown stack", () => {
		const root = fixtureRoot(SETTINGS);
		writeFileSync(
			join(root, "scripts", "guard-fire-needles.json"),
			"{not json",
		);
		const r = cli(root, []);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("guard-fire-needles.json is not valid JSON");
		expect(r.stderr).not.toMatch(/\n\s+at /);
	});
});

describe("main — the CLI surface", () => {
	function run(...args: string[]) {
		const r = runInProcess(SCRIPT, args);
		return { ...r, json: () => JSON.parse(r.stdout) };
	}

	it("refuses an unknown flag, naming it, rather than running the census without it", () => {
		const { status, stderr } = run("--dir", corpusDir, "--jsn");
		expect(status).toBe(2);
		expect(stderr).toContain("unknown flag: --jsn");
	});

	it("prints its usage on --help and exits 0", () => {
		const { status, stdout } = run("--help");
		expect(status).toBe(0);
		expect(stdout).toContain("--scope deny|nondeny|all");
	});

	it("refuses a --dir with no path after it", () => {
		const { status, stderr } = run("--dir");
		expect(status).toBe(2);
		expect(stderr).toContain("--dir needs a value");
	});

	it("refuses a --dir that cannot be read, distinctly from an empty corpus", () => {
		const { status, stderr } = run("--dir", join(corpusDir, "does-not-exist"));
		expect(status).toBe(2);
		expect(stderr).toContain("cannot read the corpus directory");
		expect(stderr).toContain(
			"A wrong --dir reports here, never as an empty corpus.",
		);
	});

	it("refuses a --since with nothing after it", () => {
		const { status, stderr } = run("--dir", corpusDir, "--since");
		expect(status).toBe(2);
		expect(stderr).toContain("--since needs a value");
	});

	it("refuses a --until with nothing after it", () => {
		const { status, stderr } = run("--dir", corpusDir, "--until");
		expect(status).toBe(2);
		expect(stderr).toContain("--until needs a value");
	});

	it("runs clean against an empty corpus and reports it as such", () => {
		const empty = tempDir("ldr-empty-");
		const { status, stdout } = run("--dir", empty);
		expect(status).toBe(0);
		expect(stdout).toContain("whole corpus, no window");
	});

	it("emits parseable JSON under --json", () => {
		const empty = tempDir("ldr-empty-");
		const { status, json } = run("--dir", empty, "--json");
		expect(status).toBe(0);
		const body = json();
		expect(body.corpus.dir).toBe(empty);
		expect(Array.isArray(body.rows)).toBe(true);
	});

	it("carries the skipped-line count through --json — mantahostels#3307", () => {
		const dir = tempDir("ldr-json-skip-");
		writeFileSync(join(dir, "t.jsonl"), "garbage\n");
		const { status, json } = run("--dir", dir, "--json");
		expect(status).toBe(0);
		expect(json().corpus.skipped).toBe(1);
	});

	it("emits the trigger table alone under --triggers, before any needle file is read", () => {
		const { status, json } = run("--triggers");
		expect(status).toBe(0);
		expect(Array.isArray(json())).toBe(true);
	});

	it("refuses a --scope with nothing after it", () => {
		const { status, stderr } = run("--dir", corpusDir, "--scope");
		expect(status).toBe(2);
		expect(stderr).toContain("--scope needs a value");
	});

	it("refuses an unreadable --scope, naming the value, rather than falling back to deny", () => {
		// "warn" is the prose name for this population and NOT the token, which is
		// exactly the typo a silent default would hide (mantahostels#3350).
		const { status, stderr } = run("--dir", corpusDir, "--scope", "warn");
		expect(status).toBe(2);
		expect(stderr).toContain("--scope warn is not one of");
	});

	it("prices a different population under --scope nondeny than under the default", () => {
		const empty = tempDir("ldr-scope-");
		const base = run("--dir", empty, "--json").json();
		const other = run("--dir", empty, "--json", "--scope", "nondeny").json();
		expect(base.corpus.scope).toBe("deny");
		expect(other.corpus.scope).toBe("nondeny");
		// Disjoint by construction, and both non-empty against the core's real
		// self-plugin file — the assertion that the extension reaches guards the
		// census never counted.
		const names = (b: { rows: { guard: string }[] }) =>
			b.rows.map((r) => r.guard);
		expect(names(base).length).toBeGreaterThan(0);
		expect(names(other).length).toBeGreaterThan(0);
		expect(names(other).filter((g) => names(base).includes(g))).toEqual([]);
		expect(other.rows.every((r: { cannotDeny: boolean }) => r.cannotDeny)).toBe(
			true,
		);
	});

	it("unions the two under --scope all", () => {
		const empty = tempDir("ldr-scope-all-");
		const n = (args: string[]) =>
			run("--dir", empty, "--json", ...args).json().rows.length;
		expect(n(["--scope", "all"])).toBe(n([]) + n(["--scope", "nondeny"]));
	});
});

describe("WFC_LOST_DENY_ROOT — readJson's exit-2 branches (mantahostels#3307)", () => {
	function runWithRoot(root: string, ...args: string[]) {
		return runInProcess(SCRIPT, args, {
			env: { WFC_LOST_DENY_ROOT: root },
		});
	}

	it("exits 2 where the self-plugin's hooks file is absent, naming it", () => {
		const root = tempDir("ldr-root-");
		const { status, stderr } = runWithRoot(root, "--dir", corpusDir);
		expect(status).toBe(2);
		expect(stderr).toContain("self-plugin/hooks/hooks.json cannot be read");
	});

	it("exits 2 off a self-plugin hooks file that is not valid JSON", () => {
		const root = tempDir("ldr-root-");
		writeSelfPlugin(root, "not json");
		const { status, stderr } = runWithRoot(root, "--triggers");
		expect(status).toBe(2);
		expect(stderr).toContain("self-plugin/hooks/hooks.json at");
		expect(stderr).toContain("is not valid JSON");
	});

	it("exits 2 off a guard-fire-needles.json that is not valid JSON", () => {
		const root = tempDir("ldr-root-");
		writeSelfPlugin(root, { hooks: {} });
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(join(root, "scripts", "guard-fire-needles.json"), "not json");
		const { status, stderr } = runWithRoot(root, "--dir", corpusDir);
		expect(status).toBe(2);
		expect(stderr).toContain("is not valid JSON");
	});

	it("never reaches needlesRead under --triggers, so a broken needles file there is no fault", () => {
		const root = tempDir("ldr-root-");
		writeSelfPlugin(root, { hooks: {} });
		const { status, stdout } = runWithRoot(root, "--triggers");
		expect(status).toBe(0);
		expect(JSON.parse(stdout)).toEqual([]);
	});
});

/*
 * #954: an adopter's settings register no guard of the plugin's, which come
 * from the plugin's `hooks/hooks.json` beside this script. Read off this
 * checkout's own plugin tree, so these cases break if `guard-pull-form.js` leaves
 * `hooks/hooks.json`.
 */
describe("in an adopter whose hooks come from the plugin", () => {
	function runInHost(host: string, ...args: string[]) {
		return runInProcess(SCRIPT, args, {
			env: { CLAUDE_PROJECT_DIR: host },
		});
	}
	const guards = (stdout: string) =>
		JSON.parse(stdout).map((r: { guard: string }) => r.guard);

	it("reports a deny-capable guard registered only in hooks.json", () => {
		const host = tempDir("ldr-host-");
		mkdirSync(join(host, ".claude"));
		writeFileSync(join(host, ".claude", "settings.json"), "{}");
		const { status, stdout } = runInHost(host, "--triggers");
		expect(status).toBe(0);
		expect(guards(stdout)).toContain("guard-pull-form.js");
	});

	it("exits 2 off a host settings.json that is not valid JSON", () => {
		const host = tempDir("ldr-host-");
		mkdirSync(join(host, ".claude"));
		writeFileSync(join(host, ".claude", "settings.json"), "not json");
		const { status, stderr } = runInHost(host, "--triggers");
		expect(status).toBe(2);
		expect(stderr).toContain("settings.json is not valid JSON");
	});

	it("still reports them where the host has no settings.json at all", () => {
		const host = tempDir("ldr-host-");
		const { status, stdout, stderr } = runInHost(host, "--triggers");
		expect(status).toBe(0);
		expect(stderr).toContain("settings.json is absent");
		expect(guards(stdout)).toContain("guard-pull-form.js");
	});

	it("reads the needles from the plugin too, so a full run in an empty host counts", () => {
		const host = tempDir("ldr-host-");
		const { status, stdout } = runInHost(host, "--dir", corpusDir, "--json");
		expect(status).toBe(0);
		const rows: { guard: string }[] = JSON.parse(stdout).rows;
		expect(rows.map((r) => r.guard)).toContain("guard-pull-form.js");
	});
});

describe("skipped malformed lines — mantahostels#3307", () => {
	it("reports a nonzero skip count on a transcript with a malformed line", () => {
		const { corpus, row } = report(["garbage line", callRecord("git status")]);
		expect(corpus.skipped).toBe(1);
		// The rest of the file still counts.
		expect(row().population).toBe(1);
	});

	it("reports zero on a transcript with no malformed line", () => {
		expect(report([callRecord("git status")]).corpus.skipped).toBe(0);
	});
});

describe("--event PostToolUse (mantahostels#3356)", () => {
	const gh = {
		matcher: "Bash",
		hooks: [{ command: "scripts/warner.sh", if: "Bash(gh *)" }],
	};
	const postRoot = fixtureRoot({ hooks: { PostToolUse: [gh] } }, {});

	function postLost(guard: string, toolUseID: string) {
		return {
			type: "user",
			timestamp: "2026-09-01T00:00:00.000Z",
			attachment: {
				type: "hook_non_blocking_error",
				hookEvent: "PostToolUse",
				command: `bash scripts/${guard}`,
				toolUseID,
			},
		};
	}

	it("counts a PostToolUse loss the PreToolUse run ignores", () => {
		// warner.sh registered on both events, so each run has its row: the loss
		// belongs to the PostToolUse one alone.
		const root = fixtureRoot(
			{ hooks: { PreToolUse: [gh], PostToolUse: [gh] } },
			{},
		);
		const records = [postLost("warner.sh", "tu1")];
		expect(
			reportAt(root, records, "--event", "PostToolUse").row("warner.sh").lost,
		).toBe(1);
		const pre = reportAt(root, records, "--scope", "all");
		expect(pre.row("warner.sh").lost).toBe(0);
		expect(pre.corpus.lostCalls).toBe(0);
	});

	it("counts the population off tool_use blocks exactly as PreToolUse does", () => {
		const { row } = reportAt(
			postRoot,
			[
				{
					type: "assistant",
					timestamp: "2026-09-01T00:00:00.000Z",
					message: {
						content: [
							{
								type: "tool_use",
								name: "Bash",
								input: { command: "gh issue view 1" },
							},
							{
								type: "tool_use",
								name: "Bash",
								input: { command: "git status" },
							},
						],
					},
				},
			],
			"--event",
			"PostToolUse",
		);
		expect(row("warner.sh").population).toBe(1);
	});

	it("reports every row as unable to deny, so the escaped total is zero not missing", () => {
		const { rows } = reportAt(postRoot, [], "--event", "PostToolUse");
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.cannotDeny)).toBe(true);
		expect(rows.every((r) => r.expected === null)).toBe(true);
		const out = text(postRoot, [], "--event", "PostToolUse");
		expect(out).toContain("TOTAL expected escaped denies: 0.00");
		expect(out).not.toContain("have NO RATE");
	});
});

describe("the --failures split (mantahostels#3356)", () => {
	const root = fixtureRoot({
		hooks: {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{ command: "scripts/denier.sh" },
						{ command: "scripts/warner.sh" },
					],
				},
			],
			PostToolUse: [
				{ matcher: "Bash", hooks: [{ command: "scripts/post.sh" }] },
			],
		},
	});

	const failure = (attachment: Record<string, unknown>) => ({
		type: "user",
		timestamp: "2026-09-01T00:00:00.000Z",
		attachment: { type: "hook_cancelled", ...attachment },
	});

	/** Each bucket's record count, off a `--failures --json` run. */
	function buckets(attachments: Record<string, unknown>[]) {
		const r = cli(root, attachments.map(failure), "--json", "--failures");
		expect(r.status).toBe(0);
		return Object.fromEntries(
			r
				.json()
				.failures.rows.map((row: { bucket: string; records: number }) => [
					row.bucket,
					row.records,
				]),
		);
	}

	it("sorts a PreToolUse record by whether its guard can deny", () => {
		const a = { hookEvent: "PreToolUse", toolUseID: "tu1" };
		expect(
			buckets([
				{ ...a, command: "bash scripts/denier.sh" },
				{ ...a, command: "bash scripts/warner.sh" },
			]),
		).toEqual({ "PreToolUse, deny-capable": 1, "PreToolUse, non-deny": 1 });
	});

	it("calls a guard no PreToolUse registration mentions unregistered", () => {
		expect(
			buckets([
				{
					hookEvent: "PreToolUse",
					toolUseID: "tu1",
					command: "bash scripts/stranger.sh",
				},
			]),
		).toEqual({ "PreToolUse, unregistered": 1 });
	});

	it("calls a record with no guard name or no call id unattributed", () => {
		// Exactly what the LOST count drops.
		expect(
			buckets([
				{ hookEvent: "PreToolUse", toolUseID: "tu1" },
				{ hookEvent: "PreToolUse", command: "bash scripts/denier.sh" },
			]),
		).toEqual({ "PreToolUse, unattributed": 2 });
	});

	it("splits PostToolUse too, rather than crediting the bare event", () => {
		const a = { hookEvent: "PostToolUse", toolUseID: "tu1" };
		expect(
			buckets([
				{ ...a, command: "bash scripts/post.sh" },
				a,
				{ ...a, command: "bash scripts/stranger.sh" },
			]),
		).toEqual({
			"PostToolUse, guard named": 1,
			"PostToolUse, unattributed": 1,
			"PostToolUse, unregistered": 1,
		});
	});

	it("leaves an event that fires on no tool call as its bare name", () => {
		expect(buckets([{ hookEvent: "Stop" }, {}])).toEqual({
			Stop: 1,
			"(no event)": 1,
		});
	});

	const censusRows: [number, Record<string, unknown>][] = [
		[60, { hookEvent: "SessionStart" }],
		[20, { hookEvent: "PreToolUse", command: "bash scripts/denier.sh" }],
		[10, { hookEvent: "PostToolUse", command: "bash scripts/post.sh" }],
		[5, { hookEvent: "PostToolUse" }],
		[5, { hookEvent: "Stop" }],
		[5, { hookEvent: "PreToolUse" }],
	];
	const census = () =>
		censusRows.flatMap(([n, a], k) =>
			Array.from({ length: n }, (_, i) =>
				failure(
					a.hookEvent === "PreToolUse" || a.hookEvent === "PostToolUse"
						? { ...a, toolUseID: `tu${k}-${i}` }
						: a,
				),
			),
		);

	it("counts only the buckets a landed run gave a true denominator", () => {
		// 35 of 105: SessionStart's base is sessions, not tool calls; Stop has no
		// base at all; a PostToolUse record naming no guard has the --union base
		// (mantahostels#3372), and a PreToolUse one still has none.
		const r = cli(root, census(), "--json", "--failures");
		expect(r.status).toBe(0);
		expect(r.json().failures).toMatchObject({
			total: 105,
			covered: 35,
			pct: (35 / 105) * 100,
		});
	});

	it("prints the same figure it computes", () => {
		const r = cli(root, census(), "--failures");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"SHARE on a true tool-call denominator: 33.3% (35 of 105)",
		);
		expect(r.stdout).toContain("#3356");
	});

	it("names no denominator for a bucket no run has landed", () => {
		const records = Array.from({ length: 4 }, () =>
			failure({ hookEvent: "UserPromptSubmit" }),
		);
		const { failures } = cli(root, records, "--json", "--failures").json();
		expect(failures).toMatchObject({ covered: 0, pct: 0 });
		expect(failures.rows).toEqual([
			{ bucket: "UserPromptSubmit", records: 4, pct: 100, ticket: null },
		]);
	});

	it("calls a share of nothing unknown, never zero", () => {
		expect(
			cli(root, [], "--json", "--failures").json().failures.pct,
		).toBeNull();
		expect(cli(root, [], "--failures").stdout).toContain(
			"SHARE on a true tool-call denominator: —% (0 of 0)",
		);
	});
});

describe("main — --event and --failures (mantahostels#3356)", () => {
	function run(...args: string[]) {
		const r = runInProcess(SCRIPT, args);
		return { ...r, json: () => JSON.parse(r.stdout) };
	}

	it("refuses a --event with nothing after it", () => {
		const { status, stderr } = run("--dir", corpusDir, "--event");
		expect(status).toBe(2);
		expect(stderr).toContain("--event needs a value");
	});

	it("refuses an event that fires on no tool call, naming it beside the events it accepts", () => {
		const { status, stderr } = run("--dir", corpusDir, "--event", "Stop");
		expect(status).toBe(2);
		expect(stderr).toContain("--event Stop is not one of");
		expect(stderr).toContain("has no tool-call denominator at any scope");
	});

	it("refuses a deny scope on PostToolUse rather than printing an empty table", () => {
		const { status, stderr } = run(
			"--dir",
			corpusDir,
			"--event",
			"PostToolUse",
			"--scope",
			"deny",
		);
		expect(status).toBe(2);
		expect(stderr).toContain("is meaningless with --event PostToolUse");
	});

	it("takes `all` where --event PostToolUse names no scope of its own", () => {
		const { status, json } = run(
			"--dir",
			corpusDir,
			"--event",
			"PostToolUse",
			"--json",
		);
		expect(status).toBe(0);
		expect(json().corpus.scope).toBe("all");
		expect(json().corpus.event).toBe("PostToolUse");
	});

	it("reports no failure census unless --failures asks for one", () => {
		const empty = tempDir("ldr-no-failures-");
		expect(run("--dir", empty, "--json").json().failures).toBeUndefined();
		expect(
			run("--dir", empty, "--json", "--failures").json().failures,
		).toMatchObject({ total: 0, covered: 0, pct: null });
	});

	it("counts the whole failure population, not the scope's share of it", () => {
		const dir = tempDir("ldr-failures-");
		writeFileSync(
			join(dir, "t.jsonl"),
			`${[
				{
					type: "user",
					timestamp: "2026-09-01T00:00:00.000Z",
					attachment: { type: "hook_cancelled", hookEvent: "SessionStart" },
				},
				{
					type: "user",
					timestamp: "2026-09-01T00:00:00.000Z",
					attachment: {
						type: "hook_cancelled",
						hookEvent: "PostToolUse",
						command: "node scripts/guard-dispatch.js",
						toolUseID: "tu1",
					},
				},
			]
				.map((r) => JSON.stringify(r))
				.join("\n")}\n`,
		);
		// A `deny`-scoped run reports neither of these records as lost, and still
		// sees both in the census.
		const { failures } = run("--dir", dir, "--json", "--failures").json();
		expect(
			Object.fromEntries(
				failures.rows.map((r: { bucket: string; records: number }) => [
					r.bucket,
					r.records,
				]),
			),
		).toEqual({ SessionStart: 1, "PostToolUse, guard named": 1 });
	});

	it("reconciles the census's attributed bucket with the table's own losses", () => {
		const dir = tempDir("ldr-reconcile-");
		const post = (command: string | null, toolUseID: string | null) => ({
			type: "user",
			timestamp: "2026-09-01T00:00:00.000Z",
			attachment: {
				type: "hook_cancelled",
				hookEvent: "PostToolUse",
				...(command ? { command } : {}),
				...(toolUseID ? { toolUseID } : {}),
			},
		});
		writeFileSync(
			join(dir, "t.jsonl"),
			`${[
				post("node scripts/guard-dispatch.js", "tu1"),
				post("node scripts/guard-dispatch.js", "tu2"),
				post(null, "tu3"),
				post("bash scripts/nowhere.sh", "tu4"),
			]
				.map((r) => JSON.stringify(r))
				.join("\n")}\n`,
		);
		const out = run(
			"--dir",
			dir,
			"--event",
			"PostToolUse",
			"--json",
			"--failures",
		).json();
		const lost = out.rows.reduce(
			(n: number, r: { lost: number }) => n + r.lost,
			0,
		);
		const named = out.failures.rows.find(
			(r: { bucket: string }) => r.bucket === "PostToolUse, guard named",
		);
		expect(named.records).toBe(2);
		expect(lost).toBe(named.records);
		// The two named records, plus the nameless one --union gives a base (mantahostels#3372).
		expect(out.failures.covered).toBe(3);
	});

	it("prints the census in text mode too, not only under --json", () => {
		const dir = tempDir("ldr-text-failures-");
		writeFileSync(
			join(dir, "t.jsonl"),
			`${JSON.stringify({
				type: "user",
				timestamp: "2026-09-01T00:00:00.000Z",
				attachment: { type: "hook_cancelled", hookEvent: "Stop" },
			})}\n`,
		);
		const { status, stdout } = runInProcess(SCRIPT, [
			"--dir",
			dir,
			"--failures",
		]);
		expect(status).toBe(0);
		expect(stdout).toContain("HOOK FAILURES on this sweep: 1 record(s)");
		expect(stdout).toContain(
			"SHARE on a true tool-call denominator: 0.0% (0 of 1)",
		);
	});
});

describe("--union — the nameless records' deduped base (mantahostels#3372)", () => {
	const unionSettings = {
		hooks: {
			PostToolUse: [
				{ matcher: "Bash|Read", hooks: [{ command: "scripts/warner.sh" }] },
				{
					matcher: "Bash",
					hooks: [
						{ command: "scripts/denier.sh", if: "Bash(gh *)" },
						{ command: "scripts/other.sh" },
					],
				},
			],
		},
	};

	// Not transcript-testkit's buildBashCall: these arrays mix Bash with Read
	// and Write calls, and one builder over every tool keeps each a tool list.
	function call(id: string, name: string, command = "") {
		return {
			type: "assistant",
			timestamp: "2026-09-01T00:00:00.000Z",
			message: {
				content: [{ type: "tool_use", id, name, input: { command } }],
			},
		};
	}

	function nameless(
		toolUseID: string | null,
		hookName: string | null = "PostToolUse:Bash",
	) {
		return {
			type: "user",
			timestamp: "2026-09-01T00:00:00.000Z",
			attachment: {
				type: "hook_non_blocking_error",
				hookEvent: "PostToolUse",
				...(hookName === null ? {} : { hookName }),
				...(toolUseID ? { toolUseID } : {}),
			},
		};
	}

	interface UnionRow {
		calls: number;
		blocks: number;
		records: number;
		failedCalls: number;
		inUnion: number;
		outside: number;
		failurePct: number | null;
	}
	interface Union {
		rows: Array<UnionRow & { tool: string }>;
		total: UnionRow;
	}

	const unionRoot = fixtureRoot(unionSettings);

	/** A `--union` run of the script over `records`, as JSON. */
	function unionRun(records: unknown[]) {
		const r = cli(
			unionRoot,
			records,
			"--event",
			"PostToolUse",
			"--union",
			"--json",
		);
		expect(r.status).toBe(0);
		return r.json() as {
			rows: Array<{ population: number | null }>;
			union: Union;
		};
	}
	const unionOf = (records: unknown[]) => unionRun(records).union;

	it("counts a call routed to three guards once, where the per-guard sum counts it three times", () => {
		const out = unionRun([call("b1", "Bash", "gh issue view 1")]);
		const summed = out.rows.reduce((n, r) => n + (r.population ?? 0), 0);
		expect(summed).toBe(3);
		expect(out.union.total.calls).toBe(1);
	});

	it("dedupes a block written twice under one id, and says so in the block count", () => {
		const u = unionOf([call("b1", "Bash"), call("b1", "Bash")]);
		expect(u.total).toMatchObject({ calls: 1, blocks: 2 });
	});

	it("splits the base by tool and leaves an unrouted tool out of it", () => {
		const u = unionOf([
			call("b1", "Bash"),
			call("r1", "Read"),
			call("w1", "Write"),
		]);
		expect(u.rows.map((r) => [r.tool, r.calls])).toEqual([
			["Bash", 1],
			["Read", 1],
		]);
		expect(u.total.calls).toBe(2);
	});

	it("prices a nameless record against its own tool's calls, not every tool's", () => {
		const u = unionOf([
			call("b1", "Bash"),
			call("b2", "Bash"),
			call("r1", "Read"),
			call("r2", "Read"),
			nameless("b1"),
		]);
		expect(u.rows.find((r) => r.tool === "Bash")).toMatchObject({
			records: 1,
			failedCalls: 1,
			inUnion: 1,
			outside: 0,
			failurePct: 50,
		});
		expect(u.total.failurePct).toBe(25);
	});

	it("counts two records on one call as two records and one failed call", () => {
		const u = unionOf([call("b1", "Bash"), nameless("b1"), nameless("b1")]);
		expect(u.total).toMatchObject({ records: 2, failedCalls: 1, inUnion: 1 });
	});

	it("leaves a record naming a registered guard out — that bucket has its own base", () => {
		const named = nameless("b1");
		const u = unionOf([
			call("b1", "Bash"),
			{
				...named,
				attachment: { ...named.attachment, command: "bash scripts/warner.sh" },
			},
		]);
		expect(u.total.records).toBe(0);
	});

	it("keeps a record whose call no registered guard routes out of the rate, not just its own row's", () => {
		const records = [
			call("b1", "Bash"),
			call("w1", "Write"),
			nameless("w1", "PostToolUse:Write"),
		];
		const u = unionOf(records);
		expect(u.rows.find((r) => r.tool === "Write")).toMatchObject({
			records: 1,
			failedCalls: 1,
			inUnion: 0,
			outside: 1,
			calls: 0,
			failurePct: null,
		});
		expect(u.total).toMatchObject({ calls: 1, outside: 1, failurePct: 0 });
		const printed = cli(
			unionRoot,
			records,
			"--event",
			"PostToolUse",
			"--union",
		);
		expect(printed.status).toBe(0);
		expect(printed.stdout).toContain("1 record(s) are outside the base");
	});

	it("puts a record with no call id outside the base, since nothing can place it inside", () => {
		const u = unionOf([call("b1", "Bash"), nameless(null)]);
		expect(u.total).toMatchObject({
			records: 1,
			failedCalls: 0,
			outside: 1,
			failurePct: 0,
		});
	});

	it("reads the tool off hookName, and says when it names none", () => {
		const u = unionOf([
			call("b1", "Bash"),
			nameless("b1", "PostToolUse:Bash"),
			nameless("x1", "PreToolUse:Bash"),
			nameless("x2", "PostToolUse:"),
			nameless("x3", null),
		]);
		expect(u.rows.map((r) => [r.tool, r.records])).toEqual([
			["(no tool)", 3],
			["Bash", 1],
		]);
	});

	it("takes nothing unless asked", () => {
		const records = [call("b1", "Bash"), nameless("b1")];
		const r = cli(unionRoot, records, "--event", "PostToolUse", "--json");
		expect(r.status).toBe(0);
		expect(r.json().union).toBeUndefined();
		expect(text(unionRoot, records, "--event", "PostToolUse")).not.toContain(
			"UNION",
		);
	});

	it("reports the union under --json and in text only with --union", () => {
		const dir = tempDir("ldr-union-");
		writeFileSync(join(dir, "t.jsonl"), `${JSON.stringify(nameless("b9"))}\n`);
		const base = ["--dir", dir, "--event", "PostToolUse"];
		const plain = runInProcess(SCRIPT, [...base, "--json"]);
		expect(plain.status).toBe(0);
		expect(JSON.parse(plain.stdout).union).toBeUndefined();
		const asked = runInProcess(SCRIPT, [...base, "--json", "--union"]);
		expect(asked.status).toBe(0);
		expect(JSON.parse(asked.stdout).union.total).toMatchObject({
			records: 1,
			calls: 0,
			failurePct: null,
		});
		const printed = runInProcess(SCRIPT, [...base, "--union"]);
		expect(printed.status).toBe(0);
		expect(printed.stdout).toContain(
			"UNION — PostToolUse failure records naming no guard",
		);
	});

	it("refuses --union on a scope that unions only part of the event's guards, offering --scope all as the way out", () => {
		const dir = tempDir("ldr-union-scope-");
		const refused = runInProcess(SCRIPT, ["--dir", dir, "--union"]);
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain("--union needs --scope all");
		expect(
			runInProcess(SCRIPT, ["--dir", dir, "--union", "--scope", "all"]).status,
		).toBe(0);
	});
});
