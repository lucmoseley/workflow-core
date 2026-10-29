// @vitest-environment node
/*
 * Pins how a capped Stop block goes out: the decision and reason alone
 * (mantahostels#2350), core paths spelled for a plugin install (#1010), the
 * notice on the last block a counter allows, and every counter prefix swept.
 *
 * hook-block.js's counter files are swept by arbiter-markers.js's MARKER_PREFIXES
 * and hidden by .gitignore. Both lists are hand-written, so a guard adding a
 * prefix is invisible until its files pile up untracked at the repo root (mantahostels#1308).
 * Each prefix is put to the real sweep, which must delete a finished session's
 * counter and spare a running one's.
 *
 * mantahostels#1278's own tests restate the author's literal list, so they agree with it by
 * construction. These read the prefixes off the real call sites in scripts/
 * and .claude/skills/ instead, and the repo's own .gitignore.
 *
 * Every capped `Stop` guard blocks through this module, so a loosened case
 * also lets a block carry its correction on a channel that never reaches the
 * model, or stay silent on the last block the cap allows.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sweptMarkers } from "./arbiter-testkit";
import { runInProcess } from "./run-in-process.js";

const REPO = path.join(__dirname, "..", "..");
const HOOK_BLOCK = path.join(__dirname, "hook-block.js");
const hookBlock = require(HOOK_BLOCK);

/*
 * Both Node corpora a guard could call from: scripts/ and the skills' own
 * scripts — never .claude/worktrees, a throwaway copy whose files double-count.
 * hook-block.js itself is skipped: it defines the API rather than calling it.
 */
const CORPORA = [
	path.join(REPO, "scripts"),
	path.join(REPO, ".claude", "skills"),
];

function readSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name !== "node_modules") walk(full);
			} else if (e.name.endsWith(".js") && full !== HOOK_BLOCK) {
				out.push(full);
			}
		}
	};
	for (const c of CORPORA) if (fs.existsSync(c)) walk(c);
	return out;
}

/*
 * Three regexes, narrowing: every way of reaching the function, then the object-
 * literal call this file can read, then the prefix inside it. A caller matching
 * an outer one but not the next is what the counts below catch.
 *
 * `blockStop` AND `charge`: between them they are the two entries that MINT a
 * counter, so they are where an unswept prefix first puts a file at the repo
 * root. `capSpent` reads an existing counter and mints nothing (mantahostels#2383).
 */
const USE = /(?:blockStop|charge)\s*\(|["'](?:blockStop|charge)["']/g;
const CALL = /(?:blockStop|charge)\(\s*\{/g;
const CALL_WITH_PREFIX =
	/(?:blockStop|charge)\(\s*\{[^}]*?prefix:\s*"([^"]+)"/g;
/*
 * The other way a prefix reaches a call: a top-level `..._PREFIX` const, for a
 * caller that picks its counter at run time (mantahostels#2544 gave guard-priced-options.js
 * one per bucket-deciding check and blocks them in a loop). Scoped to values
 * ending `-nagged-`, so it reads counter prefixes and nothing else.
 */
const DECLARED_PREFIX = /^const \w*PREFIX\w* = "([^"]*-nagged-)";$/gm;
const declaredIn = (src: string) =>
	[...src.matchAll(DECLARED_PREFIX)].map((m) => m[1]);
/*
 * A caller may declare its prefixes in a library it requires instead —
 * guard-priced-options.js reads all of its off lib/priced-options-limbs.js
 * (#1474), and lib/priced-options-ceiling.js, a lib itself, off its sibling
 * (#1689) — so a required `./lib/` or `./` file's declarations count as its own.
 */
const REQUIRED_LIB = /require\("(\.\/(?:lib\/)?[\w-]+)(?:\.js)?"\)/g;
const declaredInLibs = (f: string, src: string) =>
	[...src.matchAll(REQUIRED_LIB)].flatMap((m) => {
		const lib = path.join(path.dirname(f), `${m[1]}.js`);
		return fs.existsSync(lib) ? declaredIn(fs.readFileSync(lib, "utf8")) : [];
	});

/*
 * Uses and calls are counted only in a file that requires hook-block.js by a
 * literal path: check-swallowed-errors.js defines a `charge` of its own, which
 * the bare names in USE would otherwise count (#1893).
 *
 * Residual: a consumer requiring it any other way — a computed path, a
 * re-exporting wrapper — drops out of uses and calls alike, so the equality
 * below still holds; only the twenty-call count notices.
 */
const REQUIRES_HOOK_BLOCK = /require\("[^"]*\/hook-block(?:\.js)?"\)/;

const scanned = readSources().map((f) => {
	const src = fs.readFileSync(f, "utf8");
	const requiresHookBlock = REQUIRES_HOOK_BLOCK.test(src);
	return {
		file: path.relative(REPO, f),
		uses: requiresHookBlock ? (src.match(USE) ?? []).length : 0,
		calls: requiresHookBlock ? (src.match(CALL) ?? []).length : 0,
		prefixes: [...src.matchAll(CALL_WITH_PREFIX)].map((m) => m[1]),
		declared: [...declaredIn(src), ...declaredInLibs(f, src)],
	};
});

const rows = scanned.flatMap((s) =>
	[...new Set([...s.prefixes, ...s.declared])].map((p) => [s.file, p]),
);
const total = (k: "uses" | "calls") => scanned.reduce((n, s) => n + s[k], 0);

/* Every double-quoted `-nagged-` literal in the corpus. The trailing class is
 * what reaches `.session-ceiling-nagged-hard-`, whose band suffix sits after
 * `-nagged-`. */
const naggedLiterals = [
	...new Set(
		readSources().flatMap((file) =>
			[
				...fs
					.readFileSync(file, "utf8")
					.matchAll(/"(\.[a-z0-9-]*-nagged-[a-z0-9-]*)"/g),
			].map((m) => m[1]),
		),
	),
].sort();

/* Off one sweep over both for every prefix this file reads. */
let sweepOf: (prefix: string) => {
	finishedGone: boolean;
	runningKept: boolean;
};
beforeAll(() => {
	const prefixes = [...new Set([...rows.map(([, p]) => p), ...naggedLiterals])];
	const swept = new Set(
		sweptMarkers(prefixes.flatMap((p) => [`${p}finished`, `${p}running`])),
	);
	sweepOf = (p) => ({
		finishedGone: swept.has(`${p}finished`),
		runningKept: !swept.has(`${p}running`),
	});
});

const gitignore = new Set(
	fs
		.readFileSync(path.join(REPO, ".gitignore"), "utf8")
		.split("\n")
		.map((l) => l.trim()),
);

describe("the counter prefixes, read from hook-block.js's call sites", () => {
	/* Today, counting both minting entries: guard-selection-sum.js twice — the
	 * block and the `charge` for the second stake tier (mantahostels#3431) —
	 * guard-uncommitted-work.js once, guard-priced-options.js three times — the
	 * one block every refusal emits, its green-suite limb's included since
	 * #1474, and the two `charge` calls that spend the non-paying limbs and the
	 * ceiling —
	 * guard-session-ceiling.js three times — the tripwire, the turn band and the
	 * wind-up band (#1199) — guard-lost-deny.js once,
	 * guard-automode-refusal.js once (#860), guard-unpushed-commits.js once (#766), guard-paste-self-match.js once (#921), guard-session-id-prose.js once (#3557), guard-exhausted-map.js once (#3639), guard-inventory.js twice (#988, and its draft-and-act limb's own counter, #989), and
	 * guard-jev-advisory.js three times — the flag's warn, the outage notice and
	 * the malformed-reply notice #226 split off it, on three counters kept
	 * separate. A drop below twenty means a caller went away — deliberately, or
	 * because the scan stopped seeing it. */
	it("still finds the twenty call sites", () => {
		expect(total("calls")).toBe(20);
	});

	/* Every call must be reachable by ONE of the two readers: the literal prefix
	 * in its own object literal, or a `..._PREFIX` const its file declares. A
	 * caller spelled some other way — a spread, a computed key,
	 * `hookBlock["blockStop"](opts)` — mints a prefix this file cannot read.
	 *
	 * RESIDUAL, and it is why the sweep test below was widened to the whole
	 * corpus: this counts per file, not per call, so a file already declaring
	 * more prefixes than it has calls — guard-priced-options.js, fourteen against
	 * three (#1474) — can gain an unreadable one and still pass here. */
	it("reads a prefix for every reachable use", () => {
		expect(total("uses")).toBe(total("calls"));
		for (const s of scanned) {
			if (!s.calls) continue;
			const readable = s.prefixes.length + s.declared.length;
			expect([s.file, readable >= s.calls]).toEqual([s.file, true]);
		}
	});

	it.each(naggedLiterals)(
		"%s's counter path resolves under .claude/tmp/markers",
		(prefix) => {
			const p: string = hookBlock.counterPath(prefix, "sid");
			expect(p.split(path.sep).slice(-3, -1)).toEqual(["tmp", "markers"]);
		},
	);

	it.each(rows)("%s's %s is swept by the marker sweep", (_file, prefix) => {
		expect(sweepOf(prefix)).toEqual({ finishedGone: true, runningKept: true });
	});

	/* The catch-all the two readers above cannot be: every `-nagged-` string in
	 * the corpus, however it reaches `blockStop`. A prefix that is swept is
	 * harmless whatever spelling minted it, and an unswept one leaves a file at
	 * the repo root for ever.
	 *
	 * RESIDUAL: double-quoted literals only, so a template literal, a single-
	 * quoted string or a prefix built at run time is still unread here. */
	it("sweeps every `-nagged-` literal in the corpus", () => {
		expect(
			naggedLiterals.filter((p) => {
				const { finishedGone, runningKept } = sweepOf(p);
				return !(finishedGone && runningKept);
			}),
		).toEqual([]);
	});
});

/* The other half: the concision backstop's markers reach MARKER_PREFIXES from a
 * shell script with no call site to read, but everything on the list must still
 * be hidden. Since F8 (mantahostels#3515, #2) that is true of the whole
 * family at once — every prefix's file lands under `.claude/tmp/markers/`, and
 * `.claude/tmp/` is one ignore line rather than one per prefix — so this no
 * longer greps for a per-prefix root pattern. */
describe("every swept prefix, whatever wrote it", () => {
	it("the marker directory is hidden by .gitignore", () => {
		expect([...gitignore]).toContain(".claude/tmp/");
	});
});

/**
 * Call blockStop `times` over in one throwaway root, pointing its repo root
 * there so the counter file lands in the sandbox and carries between calls,
 * letting the cap be reached. Without the override the real
 * `CLAUDE_PROJECT_DIR` of the session running the suite mints a `.t-s1` in the
 * shared tree (mantahostels#1798).
 *
 * `entry` writes the call into a script of that name and runs it, so
 * `process.argv[1]` is set; without it the call goes through `node -e`, which
 * leaves argv[1] undefined.
 */
function emitRun(
	times: number,
	spec: Record<string, unknown>,
	entry?: string,
): Record<string, string>[] {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hook-block-"));
	try {
		const call = `require(${JSON.stringify(HOOK_BLOCK)}).blockStop(${JSON.stringify({ prefix: ".t-", sessionId: "s1", ...spec })})`;
		const file = entry && path.join(cwd, entry);
		if (file) fs.writeFileSync(file, call);
		const env = { ...process.env, WFC_REPO_ROOT: cwd };
		const out: Record<string, string>[] = [];
		for (let i = 0; i < times; i++) {
			const res = file
				? runInProcess(file, [], { cwd, env })
				: spawnSync("node", ["-e", call], { cwd, encoding: "utf8", env });
			expect(res.status).toBe(0);
			/* Empty stdout is a REFUSED call, which the cap tests below rely on
			 * — so it contributes no entry rather than throwing. A caller
			 * expecting a block must assert on `length`, or go through `emit`. */
			if (res.stdout) out.push(JSON.parse(res.stdout));
		}
		return out;
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

/** One call, one block, so a refusal fails here rather than surfacing as
 * `undefined` downstream. */
function emit(spec: Record<string, unknown>): Record<string, string> {
	const blocks = emitRun(1, spec);
	expect(blocks.length).toBe(1);
	return blocks[0];
}

describe("what it writes to stdout", () => {
	it("emits the decision and the reason, and nothing else", () => {
		expect(emit({ reason: "seen" })).toEqual({
			decision: "block",
			reason: "seen",
		});
	});
});

describe("the reason in a plugin install (#1010)", () => {
	it("spells a core path at the plugin root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-block-root-"));
		fs.mkdirSync(path.join(root, "docs", "agents"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "agents", "t.md"), "");
		process.env.WFC_SCRIPT_ROOT = root;
		try {
			expect(emit({ reason: "see docs/agents/t.md." }).reason).toBe(
				`see ${root}/docs/agents/t.md.`,
			);
		} finally {
			delete process.env.WFC_SCRIPT_ROOT;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

/*
 * mantahostels#2348. Past the cap `blockStop` returns false and writes nothing, so a guard
 * going dark looked to the session exactly like a turn it had got right.
 */
describe("the notice on the last block a counter allows", () => {
	const last = /last Stop block on this check/;

	/* The cap is per PREFIX, so a notice speaking for the whole script is false
	 * on a caller holding two of them. */
	it("speaks for the counter, not the script", () => {
		const reason = emitRun(1, { reason: "seen", max: 1 })[0].reason;
		expect(reason).toContain("`.t-` counter");
		expect(reason).toContain(
			"Other checks in the same guard count on their own",
		);
	});

	it("says nothing on the blocks before the last one", () => {
		const blocks = emitRun(3, { reason: "seen" });
		expect(blocks.length).toBe(3);
		expect(blocks[0].reason).toBe("seen");
		expect(blocks[1].reason).toBe("seen");
	});

	it("appends it to the third block under the default cap of 3", () => {
		const blocks = emitRun(4, { reason: "seen" });
		expect(blocks.length).toBe(3);
		expect(blocks[2].reason).toMatch(last);
		expect(blocks[2].reason).toMatch(/all 3 of the blocks its cap allows/);
		expect(blocks[2].reason.startsWith("seen")).toBe(true);
	});

	it("puts it on the FIRST block of a max:1 caller, which is also its last", () => {
		const blocks = emitRun(1, { reason: "seen", max: 1 });
		expect(blocks[0].reason).toMatch(last);
		expect(blocks[0].reason).toMatch(/the single block its cap allows/);
	});

	it("names the guard by its entry script when there is one", () => {
		const blocks = emitRun(1, { reason: "seen", max: 1 }, "guard-fake.js");
		/* Anchored on `This was`: the fixture's own absolute path ends in
		 * `/guard-fake.js`, so an unanchored match survives dropping the
		 * `path.basename` this case exists to pin. */
		expect(blocks[0].reason).toContain("This was guard-fake.js's last Stop");
	});

	it("falls back to the counter prefix where argv[1] names no script", () => {
		/* `node -e`, as every other case here runs. */
		const blocks = emitRun(1, { reason: "seen", max: 1 });
		expect(blocks[0].reason).toMatch(/\.t-'s last Stop block/);
	});
});

/*
 * mantahostels#2383. In-process, as §X3 asks of a `lib/**` test.
 */
describe("capSpent, the read-only cap query (mantahostels#2383)", () => {
	/** Ask `capSpent` over a throwaway root holding `counter`, and report the
	 * answer beside what the file says afterwards, so a write inside the read
	 * would show. */
	function ask(
		counter: string | null,
		spec: Record<string, unknown> = {},
	): { spent: boolean; after: string | null } {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hook-block-"));
		const file = path.join(cwd, ".claude", "tmp", "markers", ".t-s1");
		const before = process.env.WFC_REPO_ROOT;
		process.env.WFC_REPO_ROOT = cwd;
		try {
			if (counter !== null) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, counter);
			}
			const spent = hookBlock.capSpent({
				prefix: ".t-",
				sessionId: "s1",
				...spec,
			});
			return {
				spent,
				after: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
			};
		} finally {
			if (before === undefined) delete process.env.WFC_REPO_ROOT;
			else process.env.WFC_REPO_ROOT = before;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}

	it("is false below the cap", () => {
		expect(ask("2\n")).toEqual({ spent: false, after: "2\n" });
	});

	it("is true at the cap, and leaves the counter as it found it", () => {
		expect(ask("3\n")).toEqual({ spent: true, after: "3\n" });
	});

	it("honours a caller's own max", () => {
		expect(ask("1\n", { max: 1 }).spent).toBe(true);
	});

	it("is false where no counter exists, and writes none", () => {
		expect(ask(null)).toEqual({ spent: false, after: null });
	});
});

/*
 * mantahostels#2786. The silent spend: `judge` reports several defects in one refusal, so
 * exactly one contributing counter pays through `blockStop` — which owns
 * stdout — and the rest pay here. In-process, as §X3 asks of a `lib/**` test.
 */
describe("charge, the spend that emits nothing (mantahostels#2786)", () => {
	/** Charge a throwaway root's counter and report the answer beside what the
	 * file says afterwards and what reached stdout, which must be nothing. */
	function spend(
		counter: string | null,
		spec: Record<string, unknown> = {},
	): { charged: boolean; after: string | null; said: string } {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hook-block-"));
		const file = path.join(cwd, ".claude", "tmp", "markers", ".t-s1");
		const before = process.env.WFC_REPO_ROOT;
		process.env.WFC_REPO_ROOT = cwd;
		let said = "";
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			said += chunk;
			return true;
		}) as typeof process.stdout.write;
		try {
			if (counter !== null) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, counter);
			}
			const charged = hookBlock.charge({
				prefix: ".t-",
				sessionId: "s1",
				...spec,
			});
			return {
				charged,
				after: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
				said,
			};
		} finally {
			process.stdout.write = write;
			if (before === undefined) delete process.env.WFC_REPO_ROOT;
			else process.env.WFC_REPO_ROOT = before;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}

	it("increments below the cap, and says nothing on stdout", () => {
		expect(spend("2\n")).toEqual({ charged: true, after: "3\n", said: "" });
	});

	it("mints a counter where none exists", () => {
		expect(spend(null)).toEqual({ charged: true, after: "1\n", said: "" });
	});

	/* The branch `judge` cannot reach — it `capSpent`-filters every prefix
	 * before charging it — so nothing but this test pins that `charge` reads
	 * `max` at all. */
	it("refuses at the cap, leaving the counter as it found it", () => {
		expect(spend("3\n")).toEqual({ charged: false, after: "3\n", said: "" });
	});

	it("honours a caller's own max", () => {
		expect(spend("1\n", { max: 1 })).toEqual({
			charged: false,
			after: "1\n",
			said: "",
		});
	});

	it("emits no last-block notice at the cap, unlike blockStop (mantahostels#2348)", () => {
		expect(spend("2\n").said).toBe("");
	});
});
