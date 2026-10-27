// @vitest-environment node
/*
 * lib/file-claim.js is the PreToolUse core that stops one session writing a
 * file another live session holds (mantahostels#113), run by
 * scripts/guard-dispatch.js on every `Write`/`Edit`/`NotebookEdit`.
 *
 * It is THIN: every verdict is session-arbiter.js's, and those are covered by
 * session-arbiter.test.ts. What is only testable here is the core's own work —
 * building the arbiter's argv off the hook payload, reading its answer, and
 * choosing which claim rules to hand over — and the host port's, which runs
 * the arbiter as its own process under a bound.
 *
 * Cases run in process through the dispatcher's own merge and injection. The
 * arbiter answers through `runInProcess`, the process harness's owned fake,
 * except in the boundary cases that cross lib/file-claim-host.js for real:
 * the real arbiter denying, one that exits non-zero, and one that hangs.
 *
 * A payload it misreads lets one session clobber another's live edit, and a
 * fault that denies instead of logging wedges every write.
 */

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	SCRIPT as ARBITER,
	freshSandbox,
	gitRepo,
	live,
	store,
} from "./arbiter-testkit";
import { buildHostPorts } from "./file-claim-host.js";
import { writeLatches } from "./guard-entry.js";
import { registrationsOf } from "./hook-wiring";
import { readHookPersistChars, readRuleCap } from "./rule-emission.js";
import { readRuleText } from "./rule-text.js";
import { runInProcess } from "./run-in-process";

/* Required with a cast, not imported (#3145): the adapters handed `dispatch`
 * override kit fields, `fallbackCwd` among them, that its checked `Adapters`
 * type omits, and `output` is read as strings where the JSDoc says unknown.
 * Residual: the cast's types are hand-written, so nothing checks them against
 * the module. */
const { dispatch, hostAdapters, loadCores } =
	require("./guard-dispatch.js") as {
		dispatch: (
			cores: object[],
			env: Record<string, unknown>,
		) => {
			output: Record<string, string> | null;
			latches: {
				latches: { name: string; text: string }[];
				log: (what: string) => void;
			}[];
		};
		hostAdapters: (
			root: string,
			log: (what: string) => void,
		) => Record<string, unknown>;
		loadCores: (event: string) => { name: string }[];
	};

type Answer =
	| { ok: true; stdout: string }
	| { ok: false; why: string; stdout: string };
type ArbiterCheck = (args: string[]) => Answer;

const CORE_SRC = path.join(__dirname, "file-claim.js");

const sb = freshSandbox();

const docMap = () => path.join(sb.repo, "docs/doc-map.md");

/**
 * A deny-tier path that is NOT regioned, so an anchorless write to it takes a
 * plain whole-file claim and draws no anchorless notice (mantahostels#2344),
 * and that no path rule names, so its envelope is the claim cluster alone.
 */
const plainDoc = () => path.join(sb.repo, "docs/plain.md");

/** The real arbiter, run through the process harness. */
const inProcessArbiter: ArbiterCheck = (args) => {
	const r = runInProcess(ARBITER, args, { cwd: sb.repo });
	return r.status === 0
		? { ok: true, stdout: r.stdout }
		: { ok: false, why: `exited ${r.status}`, stdout: r.stdout };
};

/** An arbiter that answers `stdout` and records the argv it was handed. */
const standIn =
	(stdout = "", seen: string[][] = []): ArbiterCheck =>
	(args) => {
		seen.push(args);
		return { ok: true, stdout };
	};

interface Run {
	/** The merged hook output, hookEventName aside; null where silent. */
	output: Record<string, string> | null;
	logs: string[];
	/** The name every log line was filed under. */
	names: string[];
}

/**
 * The core run on `payload` as the dispatcher runs it, its arbiter port
 * `arbiterCheck`. `root` stands in for the host root, `env` for the whole
 * environment the core reads.
 */
const run = (
	payload: Record<string, unknown>,
	{
		arbiterCheck = inProcessArbiter,
		root = sb.repo,
		env = {},
	}: {
		arbiterCheck?: ArbiterCheck;
		root?: string;
		env?: Record<string, string>;
	} = {},
): Run => {
	const logs: string[] = [];
	const names: string[] = [];
	const logFor = (name: string) => (what: string) => {
		names.push(name);
		logs.push(what);
	};
	const cores = loadCores("PreToolUse").filter(
		(c) => c.name === "guard-file-claim",
	);
	expect(cores).toHaveLength(1);
	const { output, latches } = dispatch(
		cores.map((c) => ({ ...c, host: undefined })),
		{
			payload,
			root,
			adapters: {
				...hostAdapters(root, logFor("entry")),
				fallbackCwd: root,
				vars: env,
				env,
				arbiterCheck,
			},
			logFor,
			disabled: () => false,
			persistChars: readHookPersistChars,
		},
	);
	for (const l of latches)
		writeLatches({ root, payload, log: l.log }, l.latches);
	return { output, logs, names };
};

const writePayload = (file: string, extra: Record<string, unknown> = {}) => ({
	session_id: "s",
	// Edit, the commonest of the three the matcher covers. The core reads
	// tool_name for one thing only — whether a Write is creating a guard (#1011).
	tool_name: "Edit",
	tool_input: { file_path: file },
	...extra,
});

/**
 * Allowed, with nothing said beyond the pre-emptive rule injection
 * (mantahostels#1646): an injection is the ONLY thing the output may be.
 */
const expectAllowNoDeny = (r: Run) => {
	if (r.output === null) return;
	expect(Object.keys(r.output)).toEqual(["additionalContext"]);
	expect(typeof r.output.additionalContext).toBe("string");
};

/** The log check-guard-errors.js reads, parsed as it parses it. */
const readFaults = (logPath = store.errorLog()) => {
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [when, where, what] = line.split("\t");
			return { when, where, what };
		});
};

/*
 * The lock registry, read back after a run. `check` takes the claim as well as
 * answering it, so the lock is what proves the arbiter was consulted at all —
 * an allow on its own is indistinguishable from a core that never looked.
 */
interface Lock {
	path: string;
	sessionId: string;
}
const heldPaths = () => (store.listLocks() as Lock[]).map((l) => l.path);
const holderOf = (rel: string) =>
	(store.listLocks() as Lock[]).find((l) => l.path === rel)?.sessionId;

beforeEach(() => {
	// Product code, which the core must ignore; the testkit's sandbox makes
	// docs/ alone.
	fs.mkdirSync(path.join(sb.repo, "app"), { recursive: true });
});

describe("what it pulls out of the hook payload", () => {
	/** The argv the arbiter was handed for `payload`. */
	const argvOf = (
		payload: Record<string, unknown>,
		env: Record<string, string> = {},
	) => {
		const seen: string[][] = [];
		run(payload, { arbiterCheck: standIn("", seen), env });
		expect(seen).toHaveLength(1);
		return seen[0];
	};

	it("hands the arbiter the check subcommand and the file", () => {
		// The fourth and fifth arguments are the edit anchor and its original
		// length (mantahostels#970). A payload carrying no old_string — a Write or a
		// NotebookEdit — sends an empty anchor and a length of 0; the arbiter
		// answers "no anchor" off the empty anchor before it ever reads the length.
		// The sixth is the `### B<n>` ids the write introduces (mantahostels#1424), and a
		// payload with no new_string introduces none.
		expect(argvOf(writePayload(docMap()))).toEqual([
			"check",
			docMap(),
			"s",
			"",
			"0",
			"",
		]);
	});

	it("forwards Edit's old_string as the anchor that places the write (mantahostels#970)", () => {
		// The core forwards it and judges nothing about it: resolving an anchor to
		// its `### B<n>` entry is the arbiter's, per mantahostels#102's one-subsystem rule.
		expect(
			argvOf({
				session_id: "s",
				tool_name: "Edit",
				tool_input: { file_path: docMap(), old_string: "### B42 · A debt" },
			})[3],
		).toBe("### B42 · A debt");
	});

	it("truncates a very long anchor rather than failing the exec", () => {
		// A single argv entry is capped at 128 KB on Linux, and an old_string can
		// exceed it.
		const anchor = "x".repeat(20_000);
		const argv = argvOf({
			session_id: "s",
			tool_name: "Edit",
			tool_input: { file_path: docMap(), old_string: anchor },
		});
		expect(argv[3]).toHaveLength(8000);
		expect(anchor.startsWith(argv[3])).toBe(true);
		// And the ORIGINAL length rides alongside it, because truncation loses the
		// anchor's end — which is the whole of what the spans-regions test reads.
		// Without it the arbiter would silently claim the entry the surviving
		// prefix happens to sit in.
		expect(argv[4]).toBe("20000");
	});

	it("keeps a newline-terminated anchor whole, so it is not read as truncated (mantahostels#1188)", () => {
		// An old_string arriving SHORT of its stated length is read as truncated,
		// and the arbiter falls back to a claim on the whole of docs/doc-map.md,
		// which blocks every other session on it.
		const anchor = "### B42 · A debt\nand its owner\n";
		const argv = argvOf({
			session_id: "s",
			tool_name: "Edit",
			tool_input: { file_path: docMap(), old_string: anchor },
		});
		expect(argv[3]).toBe(anchor);
		expect(argv[4]).toBe(String(anchor.length));
	});

	it("keeps every trailing newline, not just the last (mantahostels#1188)", () => {
		const anchor = "### B42 · A debt\n\n\n\n";
		const argv = argvOf({
			session_id: "s",
			tool_name: "Edit",
			tool_input: { file_path: docMap(), old_string: anchor },
		});
		expect(argv[3]).toBe(anchor);
		expect(argv[4]).toBe(String(anchor.length));
	});

	it("forwards the `### B<n>` ids the write introduces (mantahostels#1424)", () => {
		// Extracted here rather than forwarded as new_string whole: new_string is
		// unbounded, so forwarding it would need the anchor's 8000-character
		// truncation and reintroduce the "did the ids fall off the end?" ambiguity
		// the anchor's length exists to resolve.
		expect(
			argvOf({
				session_id: "s",
				tool_name: "Edit",
				tool_input: {
					file_path: docMap(),
					old_string: "### B7 · The last\n\nBody.",
					new_string:
						"### B7 · The last\n\nBody.\n\n### B8 · New\n\nBody.\n\n### B9 · Newer",
				},
			})[5],
		).toBe("B8,B9");
	});

	it("does not forward a heading the edit only re-types", () => {
		// The subtraction is against the UNTRUNCATED old_string — an Edit that
		// rewrites the body under a heading it quotes introduces nothing.
		expect(
			argvOf({
				session_id: "s",
				tool_name: "Edit",
				tool_input: {
					file_path: docMap(),
					old_string: "### B7 · The last\n\nOld body.",
					new_string: "### B7 · The last\n\nNew body.",
				},
			})[5],
		).toBe("");
	});

	it("ignores a `### B<n>` that is not at the start of a line", () => {
		expect(
			argvOf({
				session_id: "s",
				tool_name: "Edit",
				tool_input: {
					file_path: docMap(),
					new_string: "see also ### B8 · New, which is prose",
				},
			})[5],
		).toBe("");
	});

	it("sends no ids for a Write, which carries content rather than new_string", () => {
		// Left unread deliberately: a whole-file Write claims the file entire, so
		// there is nothing per-entry to say about it.
		expect(
			argvOf({
				session_id: "s",
				tool_name: "Write",
				tool_input: { file_path: docMap(), content: "### B8 · New" },
			})[5],
		).toBe("");
	});

	it("reads notebook_path, which NotebookEdit sends instead of file_path", () => {
		// Reading file_path alone matched the tool and then allowed every write
		// through it unchecked.
		const nb = path.join(sb.repo, "docs/notes.ipynb");
		expect(
			argvOf({
				session_id: "s",
				tool_name: "NotebookEdit",
				tool_input: { notebook_path: nb },
			})[1],
		).toBe(nb);
	});

	it("prefers the payload's session_id over the environment", () => {
		expect(
			argvOf(writePayload(docMap()), { CLAUDE_CODE_SESSION_ID: "from-env" })[2],
		).toBe("s");
	});

	it("falls back to CLAUDE_CODE_SESSION_ID when the payload carries none", () => {
		const argv = argvOf(
			{ tool_name: "Write", tool_input: { file_path: docMap() } },
			{ CLAUDE_CODE_SESSION_ID: "from-env" },
		);
		expect(argv[2]).toBe("from-env");
	});

	it("passes an empty session through rather than inventing one", () => {
		// The arbiter's own answer to an unidentifiable session is to take no
		// claim; a core that substituted a placeholder would mint a lock under a
		// session id nothing can ever release.
		expect(
			argvOf({ tool_name: "Write", tool_input: { file_path: docMap() } })[2],
		).toBe("");
	});
});

describe("the arbiter's verdict reaches the tool", () => {
	it("stays silent on a file nobody holds, having actually looked", () => {
		live(sb, "a");
		expectAllowNoDeny(run(writePayload(docMap(), { session_id: "a" })));
		expect(heldPaths()).toContain("docs/doc-map.md");
	});

	it("denies a file a live session holds, naming the holder", () => {
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" }));
		live(sb, "bob");

		const { output } = run(writePayload(docMap(), { session_id: "bob" }));
		expect(output?.permissionDecision).toBe("deny");
		expect(output?.permissionDecisionReason).toContain("alice");
		// The wait leads, where the block happens (#543).
		expect(output?.permissionDecisionReason.split("\n")[0]).toContain(
			"node scripts/session-arbiter.js wait docs/doc-map.md",
		);
	});

	it("lets the holder keep writing its own file", () => {
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" }));
		expectAllowNoDeny(run(writePayload(docMap(), { session_id: "alice" })));
	});

	it("says nothing about product code", () => {
		// The refusing tier is docs/, .claude/, CLAUDE.md, AGENTS.md — product code
		// is left to git (mantahostels#103).
		live(sb, "a");
		const r = run(
			writePayload(path.join(sb.repo, "app/page.tsx"), { session_id: "a" }),
		);
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([]);
	});

	it("allows a scripts/ file another session holds — detect-only, never refused", () => {
		live(sb, "alice");
		store.acquire("scripts/evidence-audit.py", store.identify("alice"));
		live(sb, "bob");
		expectAllowNoDeny(
			run(
				writePayload(path.join(sb.repo, "scripts/evidence-audit.py"), {
					session_id: "bob",
				}),
			),
		);
	});

	it("denies a held notebook", () => {
		const nb = path.join(sb.repo, "docs/nb.ipynb");
		live(sb, "alice");
		store.acquire("docs/nb.ipynb", store.identify("alice"));
		live(sb, "bob");

		const { output } = run({
			session_id: "bob",
			tool_name: "NotebookEdit",
			tool_input: { notebook_path: nb },
		});
		expect(output?.permissionDecision).toBe("deny");
	});

	it("does not deny on a claim whose holder has died", () => {
		// The verdict is the arbiter's ("a lock recording a pid that is no longer
		// the session's", session-arbiter.test.ts). What only shows here is the
		// end of the chain: the next session's write goes through instead of the
		// file staying wedged for as long as the dead holder's lock sits there.
		store.acquire("docs/doc-map.md", {
			sessionId: "gone",
			pid: 4_194_303, // above pid_max: no process, and none can be recycled onto it
			procStart: "1",
			durable: true,
		});
		live(sb, "bob");
		expectAllowNoDeny(run(writePayload(docMap(), { session_id: "bob" })));
		// The dead holder's lock was broken and re-minted to bob.
		expect(holderOf("docs/doc-map.md")).toBe("bob");
	});

	it("relays a note carrying a field it cannot carry, and names the field dropped (mantahostels#2387)", () => {
		const r = run(writePayload(docMap()), {
			arbiterCheck: standIn(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						additionalContext: "a note",
						someFutureField: 1,
					},
				}),
			),
		});
		expect(r.output).toEqual({ additionalContext: "a note" });
		expect(r.logs).toEqual([
			"arbiter answered fields a dispatcher part cannot carry — dropped: hookSpecificOutput.someFutureField",
		]);
	});

	it("relays a field sitting BESIDE hookSpecificOutput into the log, never in silence", () => {
		// A shape other than the exact note is not unwrapped into the rule
		// envelope: what can be relayed is, alone, and the rest is named
		// (mantahostels#2387).
		const r = run(writePayload(docMap()), {
			arbiterCheck: standIn(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						additionalContext: "a note",
					},
					systemMessage: "beside it",
				}),
			),
		});
		expect(r.output).toEqual({ additionalContext: "a note" });
		expect(r.logs).toEqual([
			"arbiter answered fields a dispatcher part cannot carry — dropped: systemMessage",
		]);
	});

	it("allows, logged, on an answer that is not JSON", () => {
		const r = run(writePayload(docMap()), {
			arbiterCheck: standIn("not json"),
		});
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			"arbiter answered output that is not JSON — write allowed unchecked",
		]);
	});
});

describe("the host runs the arbiter as its own process, bounded", () => {
	/** A script standing in for session-arbiter.js. */
	const fakeArbiter = (body: string) => {
		const at = path.join(
			sb.dir,
			`arbiter-${Math.random().toString(36).slice(2)}.js`,
		);
		fs.writeFileSync(at, body);
		return at;
	};
	const hostRun = (payload: Record<string, unknown>, arbiter?: string) => {
		const logs: string[] = [];
		const { arbiterCheck } = buildHostPorts(
			sb.repo,
			(w) => {
				logs.push(w);
			},
			arbiter ? { arbiter } : {},
		);
		return run(payload, { arbiterCheck });
	};

	it("denies through the real arbiter, the whole chain unstubbed", () => {
		live(sb, "alice");
		hostRun(writePayload(docMap(), { session_id: "alice" }));
		live(sb, "bob");
		const { output } = hostRun(writePayload(docMap(), { session_id: "bob" }));
		expect(output?.permissionDecision).toBe("deny");
		expect(output?.permissionDecisionReason).toContain("alice");
	});

	it("allows an Edit whose old_string holds a NUL, which no process can take as an argument", () => {
		// spawnSync refuses such an argv before any arbiter starts; uncaught, the
		// throw would reach the row's closed policy and refuse the write.
		const r = hostRun(
			writePayload(docMap(), {
				tool_input: { file_path: docMap(), old_string: "a\0b" },
			}),
		);
		expect(r.output?.permissionDecision).toBeUndefined();
		expect(r.logs.join("\n")).toMatch(/null bytes.* — write allowed unchecked/);
	});

	it("logs an arbiter that exits non-zero, and allows the write", () => {
		// The arbiter catches its own exceptions and exits 0, so any non-zero exit
		// is a fault it never saw and never logged itself.
		const r = hostRun(writePayload(docMap()), fakeArbiter("process.exit(3)"));
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			`arbiter exited 3 on ${docMap()} — write allowed unchecked`,
		]);
		// Field 2 of the record is what tells the guards apart in one log.
		expect(r.names).toEqual(["guard-file-claim"]);
	});

	it("kills an arbiter that hangs, inside the hook timeout its registration gives it", () => {
		// Fail-open-on-exception cannot catch a hang; only the port's bound can,
		// and past the registration's budget Claude Code takes over and the core
		// never gets to allow the write. Stub 120 s against the 5 s bound, so a
		// bound that never fired cannot read like a stub that ended on its own.
		const [{ timeout }] = registrationsOf("PreToolUse", "guard-dispatch.js");
		if (typeof timeout !== "number")
			throw new Error("the hook registration no longer carries a timeout");
		const started = Date.now();
		const r = hostRun(
			writePayload(docMap()),
			fakeArbiter("setTimeout(() => {}, 120000);"),
		);
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			`arbiter timed out on ${docMap()} — write allowed unchecked`,
		]);
		expect(Date.now() - started).toBeLessThan(timeout * 1000);
	}, 40_000);
});

describe("faults the core cannot see past", () => {
	it("logs a payload whose shape no longer carries a path", () => {
		// Every matched payload carries a path today, so an empty extraction means
		// the payload shape changed under the core — silent unless logged.
		const r = run({ session_id: "s", tool_name: "Write", tool_input: {} });
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			"no file_path or notebook_path in payload — write allowed unchecked",
		]);
	});

	it("logs, and forwards no ids, where new_string is not a string (mantahostels#1424)", () => {
		// Silence there would be indistinguishable from a write that adds no
		// entries, which is exactly the fail-open the log exists to make visible.
		const seen: string[][] = [];
		const r = run(
			{
				session_id: "s",
				tool_name: "Edit",
				tool_input: { file_path: docMap(), new_string: 42 },
			},
			{ arbiterCheck: standIn("", seen) },
		);
		expect(seen[0][5]).toBe("");
		expect(r.logs[0]).toMatch(/entry ids dropped/);
	});

	// chmod is advisory to root, which reads a 000 directory regardless — under
	// it the store is readable, the arbiter denies, and these would fail for a
	// reason that says nothing about the core.
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

	const sealTheStore = () => {
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" })); // alice takes the lock
		fs.chmodSync(store.paths.locksDir(), 0o000);
		live(sb, "bob");
	};
	// The testkit's afterEach rmSync cannot descend into a 000 directory.
	const unseal = () => fs.chmodSync(store.paths.locksDir(), 0o755);

	it.skipIf(isRoot)(
		"an unreadable lock store allows the write, but says so rather than going quiet (mantahostels#174)",
		() => {
			// The deny is genuinely lost — nothing can read alice's lock — and the
			// write is allowed, because fail-open is house style (mantahostels#103 §6).
			sealTheStore();
			try {
				const { output } = run(writePayload(docMap(), { session_id: "bob" }));
				expect(output?.permissionDecision).toBeUndefined();
				expect(output?.additionalContext).toMatch(/store is unreadable/);
			} finally {
				unseal();
			}
		},
	);

	it.skipIf(isRoot)(
		"records the unreadable store where check-guard-errors.js reads it (mantahostels#174)",
		() => {
			// Filed under `claim`, as the arbiter's fault rather than the core's.
			sealTheStore();
			try {
				run(writePayload(docMap(), { session_id: "bob" }));
				const claim = readFaults().filter((f) => f.where === "claim");
				expect(claim).toHaveLength(1);
				expect(claim[0].what).toMatch(/could not use the lock store/);
			} finally {
				unseal();
			}
		},
	);

	it.skipIf(isRoot)(
		"never accuses a session of an unallocated id it cannot check (mantahostels#1424)",
		() => {
			// readHeldBy answers null for an unreadable store, which is "unknown", never
			// "this session holds nothing" (mantahostels#174). Reading it as the latter would
			// accuse every session that DID run alloc-entry.
			sealTheStore();
			try {
				const { output } = run(
					writePayload(docMap(), {
						session_id: "bob",
						tool_input: {
							file_path: docMap(),
							old_string: "x",
							new_string: "### B8 · New",
						},
					}),
				);
				expect(JSON.stringify(output)).not.toContain("B8");
			} finally {
				unseal();
			}
		},
	);
});

/*
 * PRE-EMPTIVE INJECTION (mantahostels#1646, spec mantahostels#1762) — the claim cluster's
 * rules, handed to a session on the CLEAN branch rather than only in the
 * refusal that follows a mistake.
 *
 * Keyed by fragment id through the accessor, never by quoting the prose here: a
 * test carrying its own copy of the text passes while the store holds something
 * else (mantahostels#1644).
 *
 * The 4,000-byte ceiling cannot carry the cluster in one emission, so these
 * drive successive writes and read the union.
 */
describe("it hands over the claim rules before the mistake", () => {
	const coreSrc = fs.readFileSync(CORE_SRC, "utf8");

	/*
	 * The docs arm's path-tied rules (#2302), as `[rule, path, ...modules]`
	 * rows: the paths and module gates file-claim.js spells in its skip list.
	 */
	const pathRows: string[][] = [
		["roadmap-edit", "docs/reference-roadmap.html", "roadmap"],
		["manual-sync", "docs/operating-manual.md", "governance", "roadmap"],
	];

	/*
	 * The deny tier's four rules, in the core's own priority order, each with a
	 * NEEDLE from its operative clause.
	 *
	 * `toContain(readRuleText(id))` reads the same file the core reads, so it
	 * holds the WIRING — the id really is injected — and nothing at all about
	 * the text: a fragment gutted of its instruction passes it. The literal is
	 * what fails when the operative clause goes.
	 */
	const denyTier: [string, string[]][] = [
		[
			"file-claim",
			[
				"Writing the file is what takes the claim",
				"detect only",
				"release --force <path>",
			],
		],
		[
			"claim-release",
			[
				"node scripts/session-arbiter.js release <path>",
				"release --park <path>",
			],
		],
		["claim-bash-route", ["file unrefused", "Read the\nclaims yourself"]],
		["denied-edit-debt", ["debt own <path> <issue>", "debt clear <path>"]],
	];

	/**
	 * Everything the core injected across `writes` successive writes of one
	 * file by one session, concatenated.
	 *
	 * Pass a NON-REGIONED path. Every run is then a plain whole-file claim the
	 * arbiter says nothing about, so the injection is the only thing speaking.
	 */
	const injectedOver = (file: string, sessionId: string, writes: number) => {
		let seen = "";
		for (let i = 0; i < writes; i++) {
			const { output } = run(writePayload(file, { session_id: sessionId }));
			if (output === null) continue;
			seen += `${output.additionalContext ?? ""}\n`;
		}
		return seen;
	};

	it.each(denyTier)("emits %s on a write to the deny tier", (id, needles) => {
		live(sb, "a");
		const seen = injectedOver(plainDoc(), "a", denyTier.length);
		expect(seen).toContain(readRuleText(id));
		for (const needle of needles) expect(seen).toContain(needle);
	});

	it("emits script-self-claim on a write under scripts/, where it is the only trigger it has", () => {
		live(sb, "a");
		const seen = injectedOver(
			path.join(sb.repo, "scripts/evidence-audit.py"),
			"a",
			5,
		);
		expect(seen).toContain(readRuleText("script-self-claim"));
		expect(seen).toContain("MUST CLAIM FOR ITSELF");
	});

	/*
	 * THE NEW-GUARD POINTER (#1011). Only a Write creating
	 * `scripts/guard-*.{sh,js}` carries it: an Edit cannot create a file, and a
	 * guard that already exists has already been through its surfaces.
	 */
	const toldGuardAuthoring = (file: string, tool: string) => {
		live(sb, "a");
		const r = run(writePayload(file, { session_id: "a", tool_name: tool }));
		expectAllowNoDeny(r);
		return (r.output?.additionalContext ?? "").includes(
			"A NEW GUARD OWES EIGHT SURFACES",
		);
	};

	it.each(["scripts/guard-new.sh", "scripts/guard-new.js"])(
		"points a Write creating %s at the eight surfaces",
		(rel) => {
			expect(toldGuardAuthoring(path.join(sb.repo, rel), "Write")).toBe(true);
		},
	);

	it("says it once a session, not at the next new guard", () => {
		expect(
			toldGuardAuthoring(path.join(sb.repo, "scripts/guard-one.sh"), "Write"),
		).toBe(true);
		expect(
			toldGuardAuthoring(path.join(sb.repo, "scripts/guard-two.sh"), "Write"),
		).toBe(false);
	});

	it.each([
		["an Edit of an existing guard", "scripts/guard-old.sh", "Edit", true],
		["a Write over an existing guard", "scripts/guard-old.sh", "Write", true],
		["a Write creating a non-guard script", "scripts/foo.js", "Write", false],
		[
			"a Write creating a guard's library",
			"scripts/lib/guard-x.sh",
			"Write",
			false,
		],
		[
			"a Write creating a guard's test",
			"scripts/guard-x.test.ts",
			"Write",
			false,
		],
		["a Write creating a .js test", "scripts/guard-x.test.js", "Write", false],
		[
			"a Write creating a .spec.js test (#3012)",
			"scripts/guard-x.spec.js",
			"Write",
			false,
		],
	])("stays off for %s", (_what, rel, tool, exists) => {
		const file = path.join(sb.repo, rel);
		if (exists) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "#!/usr/bin/env bash\n");
		}
		expect(toldGuardAuthoring(file, tool)).toBe(false);
	});

	it("sets no permissionDecision on the clean branch", () => {
		live(sb, "a");
		const { output } = run(writePayload(plainDoc(), { session_id: "a" }));
		expect(output?.permissionDecision).toBeUndefined();
		expect(output?.additionalContext).toContain(readRuleText("file-claim"));
	});

	it("still speaks when the root carries a trailing slash", () => {
		// The prefix strip is what turns the payload's absolute path into the tier
		// test's subject, and a root spelled with a trailing / made it a no-op.
		live(sb, "a");
		const { output } = run(writePayload(plainDoc(), { session_id: "a" }), {
			root: `${sb.repo}/`,
		});
		expect(output?.additionalContext).toContain(readRuleText("file-claim"));
	});

	/**
	 * The `.rule-injected-*` markers standing under the sandbox repo's marker
	 * directory (`.claude/tmp/markers`, not the root itself — mantahostels#3515 F8,
	 * issue #2).
	 */
	const readLatchedMarkers = () => {
		const dir = path.join(sb.repo, ".claude", "tmp", "markers");
		if (!fs.existsSync(dir)) return [];
		return fs.readdirSync(dir).filter((f) => f.startsWith(".rule-injected-"));
	};

	it("carries an arbiter NOTICE and the cluster in ONE envelope (mantahostels#2369)", () => {
		// mantahostels#2334 gave an anchorless write to a REGIONED path a notice of its own, and
		// under mantahostels#1646 any arbiter output displaced the rules — so on the repo's
		// most-written guarded file the first write got no rule at all, and a
		// session that wrote once got none ever.
		live(sb, "a");
		const first = run(writePayload(docMap(), { session_id: "a" })).output;
		expect(first?.permissionDecision).toBeUndefined();
		const said = first?.additionalContext ?? "";
		expect(said).toContain("claims the WHOLE of");
		// claim-bash-route, not file-claim (mantahostels#2386). The notice spends the same
		// budget, and this arm's first envelope is too short to hold both behind
		// it — so only ONE fits, and it is the unreprinted one that stays.
		expect(said).toContain(readRuleText("claim-bash-route"));
		expect(said).not.toContain(readRuleText("file-claim"));
		// The notice comes FIRST — it is about the write in hand, the rules are not.
		expect(said.indexOf("claims the WHOLE of")).toBeLessThan(
			said.indexOf(readRuleText("claim-bash-route")),
		);
		// Emitted means latched, or the next write would repeat it.
		expect(readLatchedMarkers()).toContain(
			".rule-injected-claim-bash-route-main-a",
		);
		// And the deferral is unlatched, so file-claim is not lost with it.
		expect(readLatchedMarkers()).not.toContain(
			".rule-injected-file-claim-main-a",
		);
		const next = run(writePayload(docMap(), { session_id: "a" })).output;
		expect(next?.additionalContext).toContain(readRuleText("file-claim"));
	});

	/*
	 * A NON-REGIONED trigger, which is what mantahostels#2369 turned on. The unreadable store
	 * carries no rule content of its own and fires on a plain whole-file path.
	 */
	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"rides with a notice carrying no rule content of its own (mantahostels#2369)",
		() => {
			live(sb, "alice");
			run(writePayload(plainDoc(), { session_id: "alice" }));
			fs.chmodSync(store.paths.locksDir(), 0o000);
			live(sb, "bob");
			try {
				const said =
					run(writePayload(plainDoc(), { session_id: "bob" })).output
						?.additionalContext ?? "";
				expect(said).toMatch(/store is unreadable/);
				expect(said).toContain(readRuleText("file-claim"));
			} finally {
				fs.chmodSync(store.paths.locksDir(), 0o755);
			}
		},
	);

	/*
	 * The case above is chmod-based, and chmod is advisory to root, so on a root
	 * runner mantahostels#2369's non-regioned limb is pinned only here (mantahostels#2387).
	 */
	it("rides with the dirty-and-unclaimed notice, root or not (mantahostels#2387)", () => {
		gitRepo(sb);
		// Untracked is dirty to `git status --porcelain`, so no commit is needed.
		fs.writeFileSync(plainDoc(), "an edit nobody claims\n");
		live(sb, "alice");
		const first = run(writePayload(plainDoc(), { session_id: "alice" })).output;
		// An allow, not a refusal: only a denial may displace the cluster.
		expect(first?.permissionDecision).toBeUndefined();
		const said = first?.additionalContext ?? "";
		expect(said).toMatch(/uncommitted changes that no live session claims/);
		expect(said).toContain(readRuleText("claim-bash-route"));
		expect(said.indexOf("uncommitted changes")).toBeLessThan(
			said.indexOf(readRuleText("claim-bash-route")),
		);
		expect(readLatchedMarkers()).toContain(
			".rule-injected-claim-bash-route-main-alice",
		);
	});

	const note = (text: string) =>
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: text,
			},
		});

	it("emits the notice alone, unlatched, where it crowds every rule out", () => {
		// The notice counts against the 4,000-byte ceiling, so a long enough one
		// leaves no room for even the highest-priority fragment. It must then
		// defer UNLATCHED — mantahostels#2261's failure, which no assertion on the output can
		// see — rather than being marked as said and lost for the session's life.
		//
		// A stand-in arbiter, because no real note is anywhere near this long.
		live(sb, "a");
		const huge = "N".repeat(3999);
		const r = run(writePayload(plainDoc(), { session_id: "a" }), {
			arbiterCheck: standIn(note(huge)),
		});
		expect(r.output).toEqual({ additionalContext: huge });
		expect(readLatchedMarkers()).toEqual([]);
		// Not vacuous: the same core, told nothing, latches.
		const quiet = run(writePayload(plainDoc(), { session_id: "a" }));
		expect(quiet.output?.additionalContext).toContain(
			readRuleText("file-claim"),
		);
		expect(readLatchedMarkers()).not.toEqual([]);
	});

	/*
	 * THE ARMS THAT ONLY CARRY THE NOTE, each failing by saying nothing at all
	 * (mantahostels#2369).
	 */
	it.each([
		["outside both tiers", () => path.join(sb.repo, "app/page.tsx"), true],
		[
			"in the sanctioned scratch directory",
			() => path.join(sb.repo, ".claude/tmp/scratch.md"),
			true,
		],
		["after the arbiter died", () => plainDoc(), false],
	])("still says the note on a write %s", (_what, file, ok) => {
		live(sb, "a");
		const stdout = note("a note");
		const r = run(writePayload(file(), { session_id: "a" }), {
			arbiterCheck: () =>
				ok ? { ok: true, stdout } : { ok: false, why: "exited 3", stdout },
		});
		expect(r.output?.additionalContext).toContain("a note");
	});

	/** The rule envelope a fresh session's first write to `rel` carries. */
	const firstEnvelope = (rel: string) => {
		live(sb, "a");
		const r = run(writePayload(path.join(sb.repo, rel), { session_id: "a" }));
		expectAllowNoDeny(r);
		return r.output?.additionalContext ?? "";
	};

	// THE AUTHORITY-CLASS RULE (#2016).
	describe("on a hand edit of a derived or generated-only doc", () => {
		const classed = (classes: Record<string, object>) =>
			fs.writeFileSync(
				path.join(sb.repo, "docs/doc-map-classes.json"),
				JSON.stringify(classes),
			);

		it.each([
			["derived", null],
			["generated-only", null],
			["derived", ""],
			["derived", "  "],
		])(
			"leads the first envelope with the rule on a %s doc, qualifier %j",
			(cls, classQualifier) => {
				classed({ "docs/digest.md": { class: cls, classQualifier } });
				const ctx = firstEnvelope("docs/digest.md");
				expect(ctx.startsWith(readRuleText("doc-authority-class"))).toBe(true);
				expect(ctx).toContain("Edit its source and re-run its generator");
			},
		);

		it.each([
			[
				"a source-of-truth doc",
				{ "docs/digest.md": { class: "source-of-truth" } },
			],
			[
				"a derived doc whose qualifier leaves part of it hand-edited",
				{ "docs/digest.md": { class: "derived", classQualifier: "blocks" } },
			],
			[
				"a doc the register does not list",
				{ "docs/other.md": { class: "derived" } },
			],
		])("stays off on %s", (_what, classes) => {
			classed(classes);
			const ctx = firstEnvelope("docs/digest.md");
			expect(ctx).not.toContain(readRuleText("doc-authority-class"));
			expect(ctx).toContain(readRuleText("claim-bash-route"));
		});

		it("stays off, and logs why, on a register that is not JSON", () => {
			fs.writeFileSync(path.join(sb.repo, "docs/doc-map-classes.json"), "{");
			live(sb, "a");
			const r = run(
				writePayload(path.join(sb.repo, "docs/digest.md"), { session_id: "a" }),
			);
			expect(r.output?.additionalContext).not.toContain(
				readRuleText("doc-authority-class"),
			);
			expect(r.logs).toHaveLength(1);
			expect(r.logs[0]).toMatch(
				/^could not read .*doc-map-classes\.json — authority class of docs\/digest\.md unchecked: .*JSON/,
			);
		});

		it("stays off, and logs nothing, in a host with no register", () => {
			fs.rmSync(path.join(sb.repo, "docs/doc-map-classes.json"), {
				force: true,
			});
			live(sb, "a");
			const r = run(
				writePayload(path.join(sb.repo, "docs/digest.md"), { session_id: "a" }),
			);
			expect(r.output?.additionalContext).not.toContain(
				readRuleText("doc-authority-class"),
			);
			expect(r.logs).toEqual([]);
		});
	});

	// THE ROADMAP-EDIT RULE (#2021) AND THE MANUAL-SYNC RULE (#2233).
	describe.each([
		{
			rule: "roadmap-edit",
			rel: "docs/reference-roadmap.html",
			lead: "THIS FILE IS THE ROADMAP: route every edit",
		},
		{
			rule: "manual-sync",
			rel: "docs/operating-manual.md",
			lead: "THIS FILE IS THE OPERATING MANUAL: write",
		},
	])("on a write to $rel", ({ rule, rel, lead }) => {
		it("leads the first envelope with the rule", () => {
			const ctx = firstEnvelope(rel);
			expect(ctx.startsWith(readRuleText(rule))).toBe(true);
			expect(ctx).toContain(lead);
		});

		it("stays off on any other doc", () => {
			const ctx = firstEnvelope("docs/roadmap-digest.md");
			expect(ctx).not.toContain(readRuleText(rule));
			expect(ctx).toContain(readRuleText("claim-bash-route"));
		});
	});

	it.each(
		// Each module a row names shut in turn, the row's others left on.
		pathRows.flatMap(([rule, rel, ...gates]) =>
			gates.map((shut) => ({
				rule,
				rel,
				modules: gates.filter((m) => m !== shut),
			})),
		),
	)(
		"keeps $rule off where its module gate is shut, modules $modules (#2233, #2301, #2302)",
		({
			rule,
			rel,
			modules,
		}: {
			rule: string;
			rel: string;
			modules: string[];
		}) => {
			// The suite injects its own modules (vitest.setup.ts).
			process.env.WFC_MODULES = modules.join(",");
			const ctx = firstEnvelope(rel);
			expect(ctx).not.toContain(readRuleText(rule));
			expect(ctx).toContain(readRuleText("claim-bash-route"));
		},
	);

	it("spells every path row's gate where lib/rule-emission.js reads it", () => {
		// The budget readers see a core's module gates only as statement-initial
		// `...ruleModule(ctx, "<module>", ["<id>"])` lines (#2785).
		for (const [rule, rel, ...gates] of pathRows) {
			expect(coreSrc).toContain(`rel === "${rel}" ? [] : ["${rule}"]`);
			for (const module of gates)
				expect(coreSrc).toMatch(
					new RegExp(
						`^\\t*\\.\\.\\.ruleModule\\(ctx, "${module}", \\["${rule}"\\]\\),$`,
						"m",
					),
				);
		}
	});

	// THE WRITING-FOR-AGENTS POINTER (#2030).
	describe("on a write to a skill file, a CLAUDE.md or an AGENTS.md", () => {
		it.each([
			".claude/skills/x/SKILL.md",
			"CLAUDE.md",
			"AGENTS.md",
			"docs/sub/CLAUDE.md",
			"scripts/templates/adopter/AGENTS.md",
		])("leads the first envelope with the rule on %s", (rel) => {
			const ctx = firstEnvelope(rel);
			expect(ctx.startsWith(readRuleText("writing-for-agents"))).toBe(true);
			expect(ctx).toContain("load the `writing-for-agents` skill before");
		});

		it.each([".agents/skills/x/SKILL.md", "app/CLAUDE.md"])(
			"says the rule alone outside both tiers, once, on %s",
			(rel) => {
				const ctx = firstEnvelope(rel);
				expect(ctx).toBe(readRuleText("writing-for-agents"));
				expect(
					run(writePayload(path.join(sb.repo, rel), { session_id: "a" }))
						.output,
				).toBeNull();
			},
		);

		it.each([
			"docs/roadmap-digest.md",
			".claude/settings.json",
			"scripts/x.js",
		])("stays off on %s", (rel) => {
			expect(firstEnvelope(rel)).not.toContain(
				readRuleText("writing-for-agents"),
			);
		});
	});

	it("says nothing on a path outside both tiers", () => {
		live(sb, "a");
		expect(
			run(writePayload(path.join(sb.repo, "app/page.tsx"), { session_id: "a" }))
				.output,
		).toBeNull();
	});

	/* The sanctioned scratch directory sits INSIDE `.claude/`, so it reaches the
	 * refusing arm unless the arm above it takes it first (mantahostels#2089, mantahostels#2103). A
	 * session writing throwaway scratch has no claim to release and no debt to
	 * own, so the rules would be four kilobytes it can never act on. */
	it("says nothing on a write to the sanctioned scratch directory", () => {
		live(sb, "a");
		expect(
			run(
				writePayload(path.join(sb.repo, ".claude/tmp/scratch.md"), {
					session_id: "a",
				}),
			).output,
		).toBeNull();
	});

	it("defers the cluster where an arbiter DENIAL spoke", () => {
		// The rules go unlatched, so they arrive whole on this session's next
		// write.
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" }));
		live(sb, "bob");

		const { output } = run(writePayload(docMap(), { session_id: "bob" }));
		expect(output?.permissionDecision).toBe("deny");
		expect(output?.additionalContext).toBeUndefined();
	});

	/*
	 * THE PACKING ARITHMETIC (mantahostels#2386).
	 *
	 * Which ids reach a session's FIRST guarded write is a property of the
	 * fragments' BYTE LENGTHS against the ceiling, not of the call's spelling —
	 * and the injection stops at the first id that does not fit rather than
	 * skipping to a smaller one behind it. So a fragment that merely grows can
	 * silently push claim-bash-route, the id nothing anywhere reprints, off a
	 * one-write session's only envelope.
	 *
	 * Each case below checks the model against what the core really emitted,
	 * never the model alone: were that `break` ever to become a skip to a smaller
	 * id behind, a model would go on agreeing with itself.
	 */
	const cap = readRuleCap();

	/** The ids each `injectRules` array names, in the order it names them. */
	const calls = [...coreSrc.matchAll(/injectRules:\s*\[([^\]]*)\]/g)].map((m) =>
		[...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]),
	);

	/**
	 * The ids the core offers on one kind of write, in its order. On the docs
	 * arm `docs` names the one rule its write's path or class keeps, or null
	 * for none, of doc-authority-class, writing-for-agents and every path row.
	 */
	const orderFor = (
		call:
			| { docs: string | null }
			| "scripts"
			| "scripts-agent-doc"
			| "new-guard",
	) => {
		expect(calls).toHaveLength(4);
		const newGuard = calls.find((ids) => ids.includes("guard-authoring"));
		// Both tiers skip writing-for-agents off a document written for agents.
		const scriptsArm = calls.find(
			(ids) =>
				ids.includes("script-self-claim") && !ids.includes("guard-authoring"),
		);
		// The fourth call, outside both tiers, names no claim rule.
		const docs = calls.find(
			(ids) => ids.includes("file-claim") && !ids.includes("script-self-claim"),
		);
		const pathRules = [
			"doc-authority-class",
			"writing-for-agents",
			...pathRows.map(([rule]) => rule),
		];
		const chosen =
			typeof call === "object"
				? docs?.filter((id) => id === call.docs || !pathRules.includes(id))
				: {
						scripts: scriptsArm?.filter((id) => id !== "writing-for-agents"),
						"scripts-agent-doc": scriptsArm,
						"new-guard": newGuard,
					}[call];
		if (!chosen)
			throw new Error(`no ${JSON.stringify(call)} injectRules in the core`);
		return chosen;
	};

	/** The leading ids whose fragments fit one envelope under the cap. */
	const fillEnvelope = (ids: string[]) => {
		let envelope = "";
		const taken: string[] = [];
		for (const id of ids) {
			const candidate = envelope
				? `${envelope}\n\n${readRuleText(id)}`
				: readRuleText(id);
			if (Buffer.byteLength(candidate) > cap) break;
			envelope = candidate;
			taken.push(id);
		}
		return taken;
	};

	/** The injection's greedy fill, modelled. */
	const modelPacks = (ids: string[]) => {
		const out: string[][] = [];
		let remaining = [...ids];
		while (remaining.length > 0) {
			const taken = fillEnvelope(remaining);
			if (taken.length === 0)
				throw new Error(`${remaining[0]} cannot fit alone`);
			out.push(taken);
			remaining = remaining.slice(taken.length);
		}
		return out;
	};

	/** Every id any call can name — the alphabet emittedPacks reads back. */
	const cluster = [...new Set(calls.flat())];

	/**
	 * What the core really emitted over `writes` successive writes, split back
	 * into the ids each envelope carried; null for a write that said nothing.
	 */
	const emittedPacks = (
		file: string,
		sessionId: string,
		writes: number,
		tool = "Edit",
	) => {
		const out: (string[] | null)[] = [];
		for (let i = 0; i < writes; i++) {
			const { output } = run(
				writePayload(file, { session_id: sessionId, tool_name: tool }),
			);
			if (output === null) {
				out.push(null);
				continue;
			}
			const ctx = output.additionalContext ?? "";
			out.push(
				cluster
					.filter((id) => ctx.includes(readRuleText(id)))
					.sort(
						(a, b) =>
							ctx.indexOf(readRuleText(a)) - ctx.indexOf(readRuleText(b)),
					),
			);
		}
		return out;
	};

	it("delivers claim-bash-route and file-claim on a deny-tier session's FIRST write", () => {
		const expected = modelPacks(orderFor({ docs: null }));
		expect(expected[0]).toEqual(["claim-bash-route", "file-claim"]);
		live(sb, "a");
		expect(emittedPacks(plainDoc(), "a", expected.length)).toEqual(expected);
	});

	it("still delivers claim-bash-route and file-claim on the FIRST write to a derived doc (#2016)", () => {
		const expected = modelPacks(orderFor({ docs: "doc-authority-class" }));
		expect(expected[0]).toEqual([
			"doc-authority-class",
			"claim-bash-route",
			"file-claim",
		]);
		fs.writeFileSync(
			path.join(sb.repo, "docs/doc-map-classes.json"),
			JSON.stringify({ "docs/digest.md": { class: "derived" } }),
		);
		live(sb, "a");
		expect(
			emittedPacks(path.join(sb.repo, "docs/digest.md"), "a", expected.length),
		).toEqual(expected);
	});

	it.each([
		...pathRows.map(([rule, rel]) => ({ rule, rel })),
		{ rule: "writing-for-agents", rel: ".claude/skills/x/SKILL.md" },
	])(
		"still delivers claim-bash-route and file-claim on the FIRST write to $rel (mantahostels#2386, #2302)",
		({ rule, rel }) => {
			const expected = modelPacks(orderFor({ docs: rule }));
			expect(expected[0]).toEqual([rule, "claim-bash-route", "file-claim"]);
			live(sb, "a");
			expect(
				emittedPacks(path.join(sb.repo, rel), "a", expected.length),
			).toEqual(expected);
		},
	);

	it("still delivers claim-bash-route on the FIRST write to an adopter template (#2030)", () => {
		const expected = modelPacks(orderFor("scripts-agent-doc"));
		expect(expected[0]).toEqual([
			"writing-for-agents",
			"script-self-claim",
			"claim-bash-route",
		]);
		live(sb, "a");
		expect(
			emittedPacks(
				path.join(sb.repo, "scripts/templates/adopter/AGENTS.md"),
				"a",
				expected.length,
			),
		).toEqual(expected);
	});

	it("delivers script-self-claim and claim-bash-route on a scripts-tier session's FIRST write", () => {
		// file-claim rode this envelope until mantahostels#3568 qualified its
		// cites; it now opens the second write.
		const expected = modelPacks(orderFor("scripts"));
		expect(expected[0]).toEqual(["script-self-claim", "claim-bash-route"]);
		live(sb, "a");
		expect(
			emittedPacks(
				path.join(sb.repo, "scripts/evidence-audit.py"),
				"a",
				expected.length,
			),
		).toEqual(expected);
	});

	it("leads a NEW guard's first write with guard-authoring (#1011)", () => {
		const expected = modelPacks(orderFor("new-guard"));
		expect(expected[0][0]).toBe("guard-authoring");
		live(sb, "a");
		// Never written, so every Write below is still creating it.
		expect(
			emittedPacks(
				path.join(sb.repo, "scripts/guard-new.sh"),
				"a",
				expected.length,
				"Write",
			),
		).toEqual(expected);
	});

	it("says each rule once per session, however many writes follow", () => {
		live(sb, "a");
		const first = injectedOver(plainDoc(), "a", denyTier.length);
		for (const [id] of denyTier) expect(first).toContain(readRuleText(id));
		// The latch is written on emission.
		expect(injectedOver(plainDoc(), "a", 3)).toBe("");
	});
});

/*
 * THE ENVELOPE BOTH SIDES AGREE ON (mantahostels#2387).
 *
 * mantahostels#2369 made the core unwrap an arbiter NOTE and re-emit its text inside the
 * rule envelope, and the unwrap is shape-exact: the object's key set must be
 * exactly ["hookSpecificOutput"] and that object's exactly ["additionalContext",
 * "hookEventName"]. So the day session-arbiter.js adds a field to that
 * emission, every note silently stops riding with the rules and mantahostels#2369 reverts
 * to the behaviour it fixed.
 */
describe("what the arbiter emits on a note (mantahostels#2387)", () => {
	it("carries exactly the two key sets the core's unwrap requires", () => {
		gitRepo(sb);
		fs.writeFileSync(plainDoc(), "an edit nobody claims\n");
		live(sb, "alice");
		// The core's own argv: check <file> <session> <anchor> <anchor_len> <ids>.
		const r = runInProcess(ARBITER, ["check", plainDoc(), "alice", "", "", ""]);
		expect(r.status).toBe(0);
		const parsed = JSON.parse(r.stdout);
		expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
		expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
			"additionalContext",
			"hookEventName",
		]);
		expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		// Not vacuous: a silent arbiter would satisfy the key sets above by
		// emitting nothing at all.
		expect(parsed.hookSpecificOutput.additionalContext).toMatch(
			/uncommitted changes that no live session claims/,
		);
	});
});

describe("the cases a mutant must not survive (#2788)", () => {
	const argvOf = (toolInput: Record<string, unknown>) => {
		const seen: string[][] = [];
		const r = run(
			{ session_id: "s", tool_name: "Edit", tool_input: toolInput },
			{ arbiterCheck: standIn("", seen) },
		);
		return { argv: seen[0], logs: r.logs };
	};

	it("forwards at most 64 new ids", () => {
		const ids = Array.from({ length: 70 }, (_, i) => `B${100 + i}`);
		const { argv } = argvOf({
			file_path: docMap(),
			new_string: ids.map((id) => `### ${id} · x`).join("\n"),
		});
		expect(argv[5].split(",")).toEqual(ids.slice(0, 64));
	});

	it("forwards the new ids sorted and once each", () => {
		const { argv } = argvOf({
			file_path: docMap(),
			new_string: "### B9 · a\n### B8 · b\n### B9 · c",
		});
		expect(argv[5]).toBe("B8,B9");
	});

	it("drops the anchor and the ids, logged, where old_string is not a string", () => {
		const { argv, logs } = argvOf({
			file_path: docMap(),
			old_string: 7,
			new_string: "### B8 · New",
		});
		expect(argv.slice(3)).toEqual(["", "", ""]);
		expect(logs).toEqual([
			`old_string on ${docMap()} is not a string — anchor dropped, whole file claimed`,
			`new_string on ${docMap()} could not be read — entry ids dropped, allocation unchecked`,
		]);
	});

	it("allows, logged, on JSON that is not a hook object", () => {
		const r = run(writePayload(docMap()), { arbiterCheck: standIn("null") });
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			"arbiter answered output that is not a hook object — write allowed unchecked",
		]);
	});

	it("relays a note for another event alone, never riding with the rules", () => {
		live(sb, "a");
		const r = run(writePayload(plainDoc(), { session_id: "a" }), {
			arbiterCheck: standIn(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: "a note",
					},
				}),
			),
		});
		expect(r.output).toEqual({ additionalContext: "a note" });
	});

	it("names the context a denial carries as dropped", () => {
		const r = run(writePayload(docMap()), {
			arbiterCheck: standIn(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: "held",
						additionalContext: "and more",
					},
				}),
			),
		});
		expect(r.output?.permissionDecision).toBe("deny");
		expect(r.output?.permissionDecisionReason).toBe("held");
		expect(r.logs).toEqual([
			"arbiter answered fields a dispatcher part cannot carry — dropped: hookSpecificOutput.additionalContext",
		]);
	});

	it("names a decision other than deny as dropped", () => {
		const r = run(writePayload(docMap()), {
			arbiterCheck: standIn(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "ask",
						permissionDecisionReason: "why",
					},
				}),
			),
		});
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			"arbiter answered fields a dispatcher part cannot carry — dropped: hookSpecificOutput.permissionDecision",
		]);
	});

	it("reads a ./-relative path as the tier it names", () => {
		live(sb, "a");
		const { output } = run(
			writePayload("./docs/plain.md", { session_id: "a" }),
			{
				arbiterCheck: standIn(""),
			},
		);
		expect(output?.additionalContext).toContain(
			readRuleText("claim-bash-route"),
		);
	});

	it("stays off, logged, on a register that is JSON but not an object", () => {
		fs.writeFileSync(path.join(sb.repo, "docs/doc-map-classes.json"), "[]");
		live(sb, "a");
		const r = run(
			writePayload(path.join(sb.repo, "docs/digest.md"), { session_id: "a" }),
		);
		expect(r.logs).toEqual([
			`could not read ${sb.repo}/docs/doc-map-classes.json — authority class of docs/digest.md unchecked: the register is not a JSON object`,
		]);
	});

	it("points only a Write at the new-guard surfaces, never an Edit of an absent guard", () => {
		live(sb, "a");
		const r = run(
			writePayload(path.join(sb.repo, "scripts/guard-new.sh"), {
				session_id: "a",
			}),
		);
		expect(r.output?.additionalContext).not.toContain(
			"A NEW GUARD OWES EIGHT SURFACES",
		);
	});

	it("hands a root CLAUDE.md the claim cluster as well as the agent-doc rule", () => {
		live(sb, "a");
		const { output } = run(
			writePayload(path.join(sb.repo, "CLAUDE.md"), { session_id: "a" }),
		);
		expect(output?.additionalContext).toContain(
			readRuleText("claim-bash-route"),
		);
	});
});
