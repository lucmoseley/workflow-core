// @vitest-environment node
/*
 * guard-file-claim.sh is the PreToolUse deny that stops one session writing a
 * file another live session holds (mantahostels#113).
 *
 * It is THIN: every verdict is session-arbiter.js's, and those are covered by
 * session-arbiter.test.ts. What is only testable here is the shell's own work —
 * pulling a path and a session out of the hook payload, passing the arbiter's
 * output through untouched, and, on every fault, allowing the write while
 * leaving a line in the error log.
 *
 * It takes lib/guard-parse.sh for the payload seam and the verdict envelope
 * (mantahostels#187) but neither walker, so it cannot use guard-parse-fixture.ts — that
 * fixture drives every case through a `command`, and this guard judges a JSON
 * tool payload. The fail-open record the guard once owned outright now lives in
 * lib/guard-log.sh (mantahostels#147), and the tests below are what pin it to the path and
 * the shape check-guard-errors.js reads.
 *
 * It runs on every `Write`/`Edit`/`NotebookEdit` as a `PreToolUse` hook
 * (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`) and is the only refusal
 * of a tool-route write to a claimed file: a payload it misreads lets one
 * session clobber another's live edit, and a fault that denies instead of
 * logging wedges every write.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
// The store alone: since mantahostels#159 the arbiter is two modules, and this suite reaches
// only the one owning the locks.
import { sourcedLibs } from "./guard-parse-fixture";
import {
	SCRIPT as ARBITER,
	freshSandbox,
	gitRepo,
	live,
	store,
} from "./lib/arbiter-testkit";
import { registrationsOf } from "./lib/hook-wiring";
import { runInProcess } from "./lib/run-in-process";
import { shellConst } from "./lib/shell-const-testkit";

const GUARD = path.resolve(__dirname, "guard-file-claim.sh");

const sb = freshSandbox();

const docMap = () => path.join(sb.repo, "docs/doc-map.md");

/**
 * A deny-tier path that is NOT regioned, so an anchorless write to it takes a
 * plain whole-file claim and draws no anchorless notice (mantahostels#2344),
 * and that no path rule names, so its envelope is the claim cluster alone.
 */
const plainDoc = () => path.join(sb.repo, "docs/plain.md");

/** Runs the guard on a hook payload, as Claude Code would. */
const run = (
	payload: unknown,
	opts: {
		guard?: string;
		env?: Record<string, string | undefined>;
		cwd?: string;
	} = {},
) => {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries({
		...process.env,
		...(opts.env ?? {}),
	})) {
		if (v !== undefined) env[k] = v;
	}
	const r = spawnSync(opts.guard ?? GUARD, [], {
		cwd: opts.cwd ?? sb.repo,
		encoding: "utf8",
		input: typeof payload === "string" ? payload : JSON.stringify(payload),
		// Cast: next-env.d.ts makes NODE_ENV required on ProcessEnv, and these
		// cases exist precisely to hand the guard an environment missing things.
		env: env as NodeJS.ProcessEnv,
		// A net against a guard that never gives up, not a deadline (mantahostels#175). Do not
		// tighten it: it is sized for a contended box, and "it is wired" below is
		// what holds the guard to a bound.
		timeout: 30_000,
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	return r;
};

const writePayload = (file: string, extra: Record<string, unknown> = {}) => ({
	session_id: "s",
	// Edit, the commonest of the three the matcher covers. The guard reads
	// tool_name for one thing only — whether a Write is creating a guard (#1011).
	tool_name: "Edit",
	tool_input: { file_path: file },
	...extra,
});

/**
 * A guard that CRASHED also emits no verdict, so "no deny" alone would pass
 * whether it allowed deliberately or died on line 1. Exit code and a silent
 * stderr are what separate the two.
 */
const expectSilentAllow = (r: ReturnType<typeof run>) => {
	expect(r.stderr ?? "").toBe("");
	expect(r.stdout ?? "").toBe("");
	expect(r.status).toBe(0);
};

/**
 * Allowed, with nothing said beyond the pre-emptive rule injection (mantahostels#1646).
 *
 * On the guarded tiers silence no longer separates an allow from a crash: the
 * guard hands over the claim cluster's rules on the clean branch, so stdout
 * carries an additionalContext object on the writes that trigger one.
 */
const expectAllowNoDeny = (r: ReturnType<typeof run>) => {
	expect(r.stderr ?? "").toBe("");
	expect(r.status).toBe(0);
	const out = (r.stdout ?? "").trim();
	if (out === "") return;
	// One object, and an injection is the ONLY thing it may be: keys, not just
	// the absence of a permissionDecision, or this would pass anything the
	// arbiter said that happened not to be a refusal.
	expect(out.split("\n")).toHaveLength(1);
	const parsed = JSON.parse(out);
	expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
	expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
		"additionalContext",
		"hookEventName",
	]);
	expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
	expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
};

/** The log check-guard-errors.js reads, parsed as it parses it. */
const faults = (logPath = store.errorLog()) => {
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

/** A copy of the guard beside a stand-in arbiter, so faults are producible. */
const detachedGuard = (arbiterBody: string) => {
	const at = fs.mkdtempSync(path.join(sb.dir, "detached-"));
	const guard = path.join(at, "guard-file-claim.sh");
	fs.copyFileSync(GUARD, guard);
	fs.chmodSync(guard, 0o755);
	fs.writeFileSync(path.join(at, "session-arbiter.js"), arbiterBody);
	// The copy needs EVERY library beside it. Without lib/guard-log.sh it logs
	// nothing — since mantahostels#147 the record lives there rather than inside the guard —
	// and the fault cases below would pass a guard that allowed the write in
	// silence. Without lib/guard-parse.sh it disarms at its load gate (mantahostels#187).
	// lib/rule-text.sh joins them since mantahostels#1646: gp_rule sources it lazily at its
	// first call, and a copy without it EXITS 2 and refuses the write — the store
	// side fails closed by design, so its absence would look like a deny.
	//
	// DERIVED, not listed (mantahostels#1905). The list was hand-written and went stale the
	// moment a library gained one of its own: lib/guard-root.sh is sourced by
	// guard-log.sh and guard-parse.sh, named by no guard, and its absence here
	// cost the record its directory in silence.
	fs.mkdirSync(path.join(at, "lib"), { recursive: true });
	for (const lib of sourcedLibs(GUARD)) {
		fs.copyFileSync(
			path.resolve(__dirname, "lib", lib),
			path.join(at, "lib", lib),
		);
	}
	return guard;
};

/**
 * A PATH holding everything the guard reaches for except one tool. The
 * missing-binary branches are unreachable any other way: jq, node and timeout
 * are all installed on every machine that runs this suite.
 */
const pathWithout = (missing: string) => {
	const at = fs.mkdtempSync(path.join(sb.dir, `bin-no-${missing}-`));
	for (const tool of [
		// bash first: the shebang is `#!/usr/bin/env bash`, so without it on PATH
		// the guard never starts and the case under test never runs.
		"bash",
		"cat",
		"date",
		"mkdir",
		"dirname",
		"git",
		"timeout",
		"jq",
		"node",
	]) {
		if (tool === missing) continue;
		try {
			const real = execFileSync("bash", ["-c", `command -v ${tool}`], {
				encoding: "utf8",
			}).trim();
			if (real) fs.symlinkSync(real, path.join(at, tool));
		} catch {
			// Absent from this machine too, which is the state the test wants.
		}
	}
	return at;
};

/*
 * The lock registry, read back after a run. `check` takes the claim as well as
 * answering it, so the lock is what proves the arbiter was consulted at all —
 * an allow on its own is indistinguishable from a guard that never looked.
 */
interface Lock {
	path: string;
	sessionId: string;
}
const heldPaths = () => (store.listLocks() as Lock[]).map((l) => l.path);
const holderOf = (rel: string) =>
	(store.listLocks() as Lock[]).find((l) => l.path === rel)?.sessionId;

beforeEach(() => {
	// Product code, which the guard must ignore; the testkit's sandbox makes
	// docs/ alone.
	fs.mkdirSync(path.join(sb.repo, "app"), { recursive: true });
	// Inherited from the session actually running the suite, and the fallback
	// under test below; left set, it makes the payload-vs-env cases agree by
	// accident.
	delete process.env.CLAUDE_CODE_SESSION_ID;
});

describe("what it pulls out of the hook payload", () => {
	// The stub records what it was called with, so these assert the extraction
	// and nothing about the verdict.
	const capture = `require("fs").writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));`;
	const argvOf = (
		payload: unknown,
		env: Record<string, string | undefined> = {},
	) => {
		const out = path.join(sb.dir, "argv.json");
		run(payload, {
			guard: detachedGuard(capture),
			env: { ARGV_OUT: out, ...env },
		});
		return JSON.parse(fs.readFileSync(out, "utf8")) as string[];
	};

	it("hands the arbiter the check subcommand and the file", () => {
		// The fourth and fifth arguments are the edit anchor and its original
		// length (mantahostels#970). A payload carrying no old_string — a Write or a
		// NotebookEdit — sends an empty anchor and jq's length of null, 0; the
		// arbiter answers "no anchor" off the empty anchor before it ever reads
		// the length.
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
		// The guard forwards it and judges nothing about it: resolving an anchor to
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
		// Command substitution strips every trailing newline, while the length is
		// jq's over the untouched string. An old_string ending in one therefore
		// arrived SHORT of its stated length, and claimSubject reads
		// anchorLength > anchor.length as truncation — falling back to a claim on
		// the whole of docs/doc-map.md, which blocks every other session on it.
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
		// Bash strips the whole run, so an anchor ending in a blank line lost four
		// characters where the single-newline case above lost one.
		const anchor = "### B42 · A debt\n\n\n\n";
		const argv = argvOf({
			session_id: "s",
			tool_name: "Edit",
			tool_input: { file_path: docMap(), old_string: anchor },
		});
		expect(argv[3]).toBe(anchor);
		expect(argv[4]).toBe(String(anchor.length));
	});

	it("strips only the sentinel from an anchor that itself ends in X (mantahostels#1188)", () => {
		// The newline fix appends an X inside the substitution and removes one
		// afterwards. An anchor whose own last character is X must survive intact.
		const anchor = "### B42 · MAX";
		expect(
			argvOf({
				session_id: "s",
				tool_name: "Edit",
				tool_input: { file_path: docMap(), old_string: anchor },
			})[3],
		).toBe(anchor);
	});

	it("forwards the `### B<n>` ids the write introduces (mantahostels#1424)", () => {
		// Extracted in jq rather than forwarded as new_string whole: new_string is
		// unbounded, so forwarding it would need the anchor's 8000-character
		// truncation and reintroduce the "did the ids fall off the end?" ambiguity
		// anchor_len exists to resolve.
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
		// The subtraction is jq's, against the UNTRUNCATED old_string — an Edit
		// that rewrites the body under a heading it quotes introduces nothing.
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
		// claim; a guard that substituted a placeholder would mint a lock under a
		// session id nothing can ever release.
		expect(
			argvOf({ tool_name: "Write", tool_input: { file_path: docMap() } })[2],
		).toBe("");
	});
});

describe("the arbiter's verdict reaches the tool untouched", () => {
	it("stays silent on a file nobody holds, having actually looked", () => {
		live(sb, "a");
		expectAllowNoDeny(run(writePayload(docMap(), { session_id: "a" })));
		expect(heldPaths()).toContain("docs/doc-map.md");
	});

	it("denies a file a live session holds, naming the holder", () => {
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" }));
		live(sb, "bob");

		const r = run(writePayload(docMap(), { session_id: "bob" }));
		expect(r.status).toBe(0); // the deny rides in the JSON, never the exit code
		const out = JSON.parse(r.stdout);
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("alice");
		// The wait leads, where the block happens (#543).
		expect(
			out.hookSpecificOutput.permissionDecisionReason.split("\n")[0],
		).toContain("node scripts/session-arbiter.js wait docs/doc-map.md");
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
		expectSilentAllow(
			run(
				writePayload(path.join(sb.repo, "app/page.tsx"), { session_id: "a" }),
			),
		);
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

	it("denies a held notebook, the whole chain unstubbed", () => {
		const nb = path.join(sb.repo, "docs/nb.ipynb");
		live(sb, "alice");
		store.acquire("docs/nb.ipynb", store.identify("alice"));
		live(sb, "bob");

		const r = run({
			session_id: "bob",
			tool_name: "NotebookEdit",
			tool_input: { notebook_path: nb },
		});
		expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(
			"deny",
		);
	});

	it("does not deny on a claim whose holder has died", () => {
		// The verdict is the arbiter's ("a lock recording a pid that is no longer
		// the session's", session-arbiter.test.ts). What only shows here is the
		// end of the chain: the guard
		// emits nothing, so the next session's write goes through instead of the
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

	it("relays stdout byte for byte, so a future arbiter field is not dropped", () => {
		const body = `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"a note",someFutureField:1}}) + "\\n");`;
		const r = run(writePayload(docMap()), { guard: detachedGuard(body) });
		expect(JSON.parse(r.stdout)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: "a note",
				someFutureField: 1,
			},
		});
		expect(faults()).toEqual([]); // output is not a fault
	});

	it("relays a field sitting BESIDE hookSpecificOutput, not just one inside it", () => {
		// Without this the guard unwraps such an envelope and re-emits
		// additionalContext alone, dropping whatever the arbiter said beside it
		// (mantahostels#2387).
		const body = `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"a note"},systemMessage:"beside it"}) + "\\n");`;
		const r = run(writePayload(docMap()), { guard: detachedGuard(body) });
		expect(JSON.parse(r.stdout)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: "a note",
			},
			systemMessage: "beside it",
		});
		expect(faults()).toEqual([]);
	});
});

describe("every fault allows the write and leaves a line in the error log", () => {
	const expectLoggedAllow = (r: ReturnType<typeof run>, match: RegExp) => {
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe(""); // no verdict: the guard checked nothing
		const logged = faults();
		expect(logged).toHaveLength(1);
		expect(logged[0].where).toBe("guard-file-claim.sh");
		expect(logged[0].what).toMatch(match);
	};

	it("logs a missing jq", () => {
		expectLoggedAllow(
			run(writePayload(docMap()), { env: { PATH: pathWithout("jq") } }),
			/jq not found/,
		);
	});

	it("logs a missing node", () => {
		expectLoggedAllow(
			run(writePayload(docMap()), { env: { PATH: pathWithout("node") } }),
			/node not found/,
		);
	});

	it("logs a payload that is not JSON", () => {
		expectLoggedAllow(run("not json at all"), /did not parse/);
	});

	it("logs a payload whose shape no longer carries a path", () => {
		// Every matched payload carries a path today, so an empty extraction means
		// the payload shape changed under the guard — silent unless logged.
		expectLoggedAllow(
			run({ session_id: "s", tool_name: "Write", tool_input: {} }),
			/no file path/,
		);
	});

	it("logs an arbiter that exits non-zero", () => {
		// The arbiter catches its own exceptions and exits 0, so any non-zero exit
		// is a fault it never saw and never logged itself.
		expectLoggedAllow(
			run(writePayload(docMap()), { guard: detachedGuard("process.exit(3)") }),
			/arbiter exited 3/,
		);
	});

	it("kills an arbiter that hangs, rather than stalling the write", () => {
		// Fail-open-on-exception cannot catch a hang; only the `timeout` can.
		//
		// Stub 120s against the 30s spawn cap in `run`, so the two cannot race: at
		// equal values a bound that never fired reads exactly like a stub that
		// ended on its own. Bound 5s, cap 30s, stub 120s — and the stub is the one
		// to keep smallest, because a broken bound orphans it for its full life on
		// a memory-capped box with an earlyoom.
		expectLoggedAllow(
			run(writePayload(docMap()), {
				guard: detachedGuard("setTimeout(() => {}, 120000);"),
			}),
			/timed out/,
		);
	}, 40_000);

	it("names itself in the record, even with the PATH stripped of basename", () => {
		// Field 2 is what tells the guards apart in one log, and it is derived from
		// $0 rather than written by hand so a renamed guard cannot keep logging under
		// its old name. Derived with parameter expansion, NOT basename: the faults
		// most worth recording are the missing-binary ones, and a PATH without jq
		// generally has no basename either — through it every such record filed
		// itself under a guard that does not exist.
		run(writePayload(docMap()), { env: { PATH: pathWithout("jq") } });
		expect(faults()[0].where).toBe("guard-file-claim.sh");
	});

	it("still allows the write when guard-log.sh itself is missing", () => {
		// The one fail-open no guard can record: with the logger gone the guard must
		// degrade to a silent allow, never crash. check-guard-errors.js closes this
		// from the other end by probing the library's readability.
		//
		// guard-log.sh ONLY: taking the whole lib/ would disarm the guard at its
		// guard-parse.sh gate instead, and this case would pass without the arbiter
		// ever being reached.
		const guard = detachedGuard("process.exit(3)");
		fs.rmSync(path.join(path.dirname(guard), "lib", "guard-log.sh"));
		expectSilentAllow(run(writePayload(docMap()), { guard }));
		expect(faults()).toEqual([]);
	});

	it("logs an arbiter that exits non-zero with no `timeout` binary either", () => {
		// The else branch: no timeout on PATH, so the guard runs node bare and has
		// only the exit code to go on. A hang is undefended there by construction.
		expectLoggedAllow(
			run(writePayload(docMap()), {
				guard: detachedGuard("process.exit(3)"),
				env: { PATH: pathWithout("timeout") },
			}),
			/arbiter exited 3/,
		);
	});
});

describe("the shared library (mantahostels#187)", () => {
	// The stub records that it ran at all, which is what separates a guard that
	// stayed armed from one that fell silent at its load gate.
	const ran = `require("fs").writeFileSync(process.env.ARGV_OUT, "ran");`;
	const armed = (guard: string) => {
		// Beside the copy, so each detached guard gets its own marker.
		const out = path.join(path.dirname(guard), "ran");
		run(writePayload(docMap()), { guard, env: { ARGV_OUT: out } });
		return fs.existsSync(out);
	};
	const libOf = (guard: string) =>
		path.join(path.dirname(guard), "lib", "guard-parse.sh");

	it("the detached copy still reaches the arbiter — the control for the cases below", () => {
		expect(armed(detachedGuard(ran))).toBe(true);
	});

	it("allows the write when the library is missing, and records it", () => {
		// Fail open (mantahostels#103 §6): a guard that cannot load its library must not wedge
		// every write in the session. But an unrecorded fail-open here is
		// indistinguishable from a guard finding nothing wrong, so it is logged.
		const guard = detachedGuard(ran);
		fs.rmSync(libOf(guard));
		expect(armed(guard)).toBe(false);
		expect(faults()[0]?.what).toMatch(/guard-parse\.sh did not load/);
	});

	it("allows the write when the library is unreadable, and records it", () => {
		const guard = detachedGuard(ran);
		fs.chmodSync(libOf(guard), 0o000);
		expect(armed(guard)).toBe(false);
		expect(faults()[0]?.what).toMatch(/guard-parse\.sh did not load/);
	});

	it("stays armed when the library's last statement returns non-zero", () => {
		// `source` reports the status of the library's LAST STATEMENT, so gating on
		// it would disarm the guard over a top-level probe that merely answered no —
		// with the whole library correctly loaded. The gate is `declare -F`.
		const guard = detachedGuard(ran);
		fs.appendFileSync(libOf(guard), "\nfalse\n");
		expect(armed(guard)).toBe(true);
	});

	it.each(["gp_deny()", "_gp_split_segments()", "gp_walk_commands()"])(
		"disarms when the library is truncated at %s",
		(marker) => {
			// A half-parsed library defines some functions and not others, which would
			// otherwise crash the guard mid-run rather than failing open. The
			// single-name gate holds only because gp_begin is the LAST function
			// defined (mantahostels#157) — these three cut before, between and after the parser
			// internals this guard never calls.
			const guard = detachedGuard(ran);
			const whole = fs.readFileSync(libOf(guard), "utf8");
			const head = whole.split(marker)[0];
			expect(head).not.toBe(whole); // the marker exists
			fs.writeFileSync(libOf(guard), head);
			expect(armed(guard)).toBe(false);
		},
	);

	it("resolves the library from the guard's own path, not the cwd", () => {
		// A hook runs with whatever cwd the session is in, which is not generally
		// the directory the guard lives in; a cwd-relative source would leave the
		// guard silently disarmed on most calls.
		const guard = detachedGuard(ran);
		const out = path.join(sb.dir, "ran-elsewhere");
		run(writePayload(docMap()), {
			guard,
			cwd: os.tmpdir(),
			env: { ARGV_OUT: out },
		});
		expect(fs.existsSync(out)).toBe(true);
	});
});

/*
 * PRE-EMPTIVE INJECTION (mantahostels#1646, spec mantahostels#1762) — the claim cluster's five rules,
 * handed to a session on the CLEAN branch rather than only in the refusal that
 * follows a mistake.
 *
 * Keyed by fragment id through the accessor, never by quoting the prose here: a
 * test carrying its own copy of the text passes while the store holds something
 * else (mantahostels#1644).
 *
 * gp_rule's 4,000-byte ceiling cannot carry the cluster in one emission, so
 * these drive successive writes and read the union.
 */
describe("it hands over the claim rules before the mistake", () => {
	const { ruleText } = require("./lib/rule-text") as {
		ruleText: (id: string) => string;
	};
	const { expandRuleTables, ruleTableRows } = require("./lib/rule-table") as {
		expandRuleTables: (text: string) => string;
		ruleTableRows: (text: string) => string[][];
	};
	const guardSrc = fs.readFileSync(
		path.join(__dirname, "guard-file-claim.sh"),
		"utf8",
	);
	/** The docs arm's path_rules table (#2302), as `[rule, path, ...modules]` rows. */
	const pathRows = ruleTableRows(guardSrc);

	/*
	 * The deny tier's four rules, in the guard's own priority order, each with a
	 * NEEDLE from its operative clause.
	 *
	 * `toContain(ruleText(id))` reads the same
	 * file the guard reads, so it holds the WIRING — the id really is in the
	 * gp_rule call — and nothing at all about the text: a fragment gutted of its
	 * instruction passes it. The literal is what fails when the operative clause
	 * goes.
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
	 * Everything the guard injected across `writes` successive writes of one
	 * file by one session, concatenated.
	 *
	 * Pass a NON-REGIONED path. Every run is then a plain whole-file claim the
	 * arbiter says nothing about, so the emitter is the only thing speaking.
	 */
	const injectedOver = (file: string, sessionId: string, writes: number) => {
		let seen = "";
		for (let i = 0; i < writes; i++) {
			const r = run(writePayload(file, { session_id: sessionId }));
			expect(r.status).toBe(0);
			const out = (r.stdout ?? "").trim();
			if (out === "") continue;
			const parsed = JSON.parse(out);
			seen += `${parsed.hookSpecificOutput.additionalContext ?? ""}\n`;
		}
		return seen;
	};

	// Each case drives four guard runs, and one run spawns node twice.
	const slow = 30_000;

	it.each(denyTier)(
		"emits %s on a write to the deny tier",
		(id, needles) => {
			live(sb, "a");
			const seen = injectedOver(plainDoc(), "a", denyTier.length);
			expect(seen).toContain(ruleText(id));
			for (const needle of needles) expect(seen).toContain(needle);
		},
		slow,
	);

	it(
		"emits script-self-claim on a write under scripts/, where it is the only trigger it has",
		() => {
			live(sb, "a");
			const seen = injectedOver(
				path.join(sb.repo, "scripts/evidence-audit.py"),
				"a",
				5,
			);
			expect(seen).toContain(ruleText("script-self-claim"));
			expect(seen).toContain("MUST CLAIM FOR ITSELF");
		},
		slow,
	);

	/*
	 * THE NEW-GUARD POINTER (#1011). Only a Write creating
	 * `scripts/guard-*.{sh,js}` carries it: an Edit cannot create a file, and a
	 * guard that already exists has already been through its surfaces.
	 */
	const toldGuardAuthoring = (file: string, tool: string) => {
		live(sb, "a");
		const r = run(writePayload(file, { session_id: "a", tool_name: tool }));
		expectAllowNoDeny(r);
		return r.stdout.includes("A NEW GUARD OWES EIGHT SURFACES");
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
		const r = run(writePayload(plainDoc(), { session_id: "a" }));
		const parsed = JSON.parse(r.stdout);
		expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(parsed.hookSpecificOutput.additionalContext).toContain(
			ruleText("file-claim"),
		);
	});

	it("still speaks when CLAUDE_PROJECT_DIR carries a trailing slash", () => {
		// The prefix strip is what turns the payload's absolute path into the tier
		// test's subject, and a root spelled with a trailing / made it a no-op.
		live(sb, "a");
		const r = run(writePayload(plainDoc(), { session_id: "a" }), {
			env: { CLAUDE_PROJECT_DIR: `${sb.repo}/` },
		});
		expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain(
			ruleText("file-claim"),
		);
	});

	/**
	 * The `.rule-injected-*` markers standing under the sandbox repo's marker
	 * directory (`.claude/tmp/markers`, not the root itself — mantahostels#3515 F8,
	 * issue #2).
	 */
	const latched = () => {
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
		const r = run(writePayload(docMap(), { session_id: "a" }));
		expect(r.stderr ?? "").toBe("");
		expect(r.status).toBe(0);
		// ONE object: Claude Code reads a single hook output.
		expect(r.stdout.trim().split("\n")).toHaveLength(1);
		const first = JSON.parse(r.stdout).hookSpecificOutput;
		expect(first.permissionDecision).toBeUndefined();
		expect(first.additionalContext).toContain("claims the WHOLE of");
		// claim-bash-route, not file-claim (mantahostels#2386). The notice spends the same
		// budget, and this arm's first envelope is too short to hold both behind
		// it — so only ONE fits, and it is the unreprinted one that stays.
		expect(first.additionalContext).toContain(ruleText("claim-bash-route"));
		expect(first.additionalContext).not.toContain(ruleText("file-claim"));
		// The notice comes FIRST — it is about the write in hand, the rules are not.
		expect(first.additionalContext.indexOf("claims the WHOLE of")).toBeLessThan(
			first.additionalContext.indexOf(ruleText("claim-bash-route")),
		);
		// Emitted means latched, or the next write would repeat it.
		expect(latched()).toContain(".rule-injected-claim-bash-route-main-a");
		// And the deferral is unlatched, so file-claim is not lost with it.
		expect(latched()).not.toContain(".rule-injected-file-claim-main-a");
		const next = JSON.parse(
			run(writePayload(docMap(), { session_id: "a" })).stdout,
		).hookSpecificOutput;
		expect(next.additionalContext).toContain(ruleText("file-claim"));
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
				const r = run(writePayload(plainDoc(), { session_id: "bob" }));
				expect(r.status).toBe(0);
				expect(r.stdout.trim().split("\n")).toHaveLength(1);
				const said = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
				expect(said).toMatch(/store is unreadable/);
				expect(said).toContain(ruleText("file-claim"));
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
		const r = run(writePayload(plainDoc(), { session_id: "alice" }));
		expect(r.stderr ?? "").toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout.trim().split("\n")).toHaveLength(1);
		const first = JSON.parse(r.stdout).hookSpecificOutput;
		// An allow, not a refusal: only a denial may displace the cluster.
		expect(first.permissionDecision).toBeUndefined();
		expect(first.additionalContext).toMatch(
			/uncommitted changes that no live session claims/,
		);
		expect(first.additionalContext).toContain(ruleText("claim-bash-route"));
		expect(first.additionalContext.indexOf("uncommitted changes")).toBeLessThan(
			first.additionalContext.indexOf(ruleText("claim-bash-route")),
		);
		expect(latched()).toContain(".rule-injected-claim-bash-route-main-alice");
	});

	it("emits the notice alone, unlatched, where it crowds every rule out", () => {
		// The notice counts against gp_rule's 4,000-byte ceiling, so a long enough
		// one leaves no room for even the highest-priority fragment. It must then
		// defer UNLATCHED — mantahostels#2261's failure, which no assertion on stdout can see —
		// rather than being marked as said and lost for the session's whole life.
		//
		// A stand-in arbiter, because no real note is anywhere near this long.
		live(sb, "a");
		const huge = "N".repeat(3999);
		const r = run(writePayload(plainDoc(), { session_id: "a" }), {
			guard: detachedGuard(
				`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: ${JSON.stringify(huge)} } }) + "\\n");`,
			),
			// The detached copy resolves the fragment store two levels up from its own
			// lib/, which is a temp directory: without this gp_rule exits 2 on an
			// unreadable store and never reaches the cap at all.
			env: { WFC_RULES_DIR: path.resolve(__dirname, "../docs/agents/rules") },
		});
		expect(r.stderr ?? "").toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout.trim().split("\n")).toHaveLength(1);
		const said = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
		expect(said).toBe(huge);
		expect(latched()).toEqual([]);
		// Not vacuous: the same guard, told nothing, latches.
		const quiet = run(writePayload(plainDoc(), { session_id: "a" }));
		expect(
			JSON.parse(quiet.stdout).hookSpecificOutput.additionalContext,
		).toContain(ruleText("file-claim"));
		expect(latched()).not.toEqual([]);
	});

	/*
	 * THE ARMS THAT ONLY CARRY THE NOTE, each failing by saying nothing at all
	 * (mantahostels#2369).
	 */
	const noteGuard = () =>
		detachedGuard(
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "a note" } }) + "\\n");
			 process.exit(Number(process.env.ARB_EXIT ?? 0));`,
		);

	it.each([
		["outside both tiers", () => path.join(sb.repo, "app/page.tsx"), "0"],
		[
			"in the sanctioned scratch directory",
			() => path.join(sb.repo, ".claude/tmp/scratch.md"),
			"0",
		],
		["after the arbiter died", () => plainDoc(), "3"],
	])("still says the note on a write %s", (_what, file, exit) => {
		live(sb, "a");
		const r = run(writePayload(file(), { session_id: "a" }), {
			guard: noteGuard(),
			env: {
				ARB_EXIT: exit,
				WFC_RULES_DIR: path.resolve(__dirname, "../docs/agents/rules"),
			},
		});
		expect(r.status).toBe(0);
		// The FIRST line: these arms print the arbiter's own object and then fall to
		// gp_allow, which emits a second the harness ignores.
		expect(
			JSON.parse(r.stdout.trim().split("\n")[0]).hookSpecificOutput
				.additionalContext,
		).toContain("a note");
	});

	/** The rule envelope a fresh session's first write to `rel` carries. */
	const firstEnvelope = (rel: string) => {
		live(sb, "a");
		const r = run(writePayload(path.join(sb.repo, rel), { session_id: "a" }));
		expectAllowNoDeny(r);
		return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
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
				expect(ctx.startsWith(ruleText("doc-authority-class"))).toBe(true);
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
			expect(ctx).not.toContain(ruleText("doc-authority-class"));
			expect(ctx).toContain(ruleText("claim-bash-route"));
		});

		it("stays off, and logs jq's reason, on a register that is not JSON", () => {
			fs.writeFileSync(path.join(sb.repo, "docs/doc-map-classes.json"), "{");
			expect(firstEnvelope("docs/digest.md")).not.toContain(
				ruleText("doc-authority-class"),
			);
			const logged = faults().map((f) => f.what);
			expect(logged).toHaveLength(1);
			expect(logged[0]).toMatch(
				/^jq could not read .*doc-map-classes\.json — authority class of docs\/digest\.md unchecked: jq: .*error/,
			);
		});

		it("stays off, and logs nothing, in a host with no register", () => {
			fs.rmSync(path.join(sb.repo, "docs/doc-map-classes.json"), {
				force: true,
			});
			expect(firstEnvelope("docs/digest.md")).not.toContain(
				ruleText("doc-authority-class"),
			);
			expect(faults()).toEqual([]);
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
			expect(ctx.startsWith(ruleText(rule))).toBe(true);
			expect(ctx).toContain(lead);
		});

		it("stays off on any other doc", () => {
			const ctx = firstEnvelope("docs/roadmap-digest.md");
			expect(ctx).not.toContain(ruleText(rule));
			expect(ctx).toContain(ruleText("claim-bash-route"));
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
			expect(ctx).not.toContain(ruleText(rule));
			expect(ctx).toContain(ruleText("claim-bash-route"));
		},
	);

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
			expect(ctx.startsWith(ruleText("writing-for-agents"))).toBe(true);
			expect(ctx).toContain("load the `writing-for-agents` skill before");
		});

		it.each([".agents/skills/x/SKILL.md", "app/CLAUDE.md"])(
			"says the rule alone outside both tiers, once, on %s",
			(rel) => {
				const ctx = firstEnvelope(rel);
				expect(ctx).toBe(ruleText("writing-for-agents"));
				expectSilentAllow(
					run(writePayload(path.join(sb.repo, rel), { session_id: "a" })),
				);
			},
			slow,
		);

		it.each([
			"docs/roadmap-digest.md",
			".claude/settings.json",
			"scripts/x.js",
		])("stays off on %s", (rel) => {
			expect(firstEnvelope(rel)).not.toContain(ruleText("writing-for-agents"));
		});
	});

	it("says nothing on a path outside both tiers", () => {
		live(sb, "a");
		expectSilentAllow(
			run(
				writePayload(path.join(sb.repo, "app/page.tsx"), { session_id: "a" }),
			),
		);
	});

	/* The sanctioned scratch directory sits INSIDE `.claude/`, so it reaches the
	 * refusing arm unless the arm above it takes it first (mantahostels#2089, mantahostels#2103). A
	 * session writing throwaway scratch has no claim to release and no debt to
	 * own, so the rules would be four kilobytes it can never act on. */
	it("says nothing on a write to the sanctioned scratch directory", () => {
		live(sb, "a");
		expectSilentAllow(
			run(
				writePayload(path.join(sb.repo, ".claude/tmp/scratch.md"), {
					session_id: "a",
				}),
			),
		);
	});

	it("defers the cluster where an arbiter DENIAL spoke", () => {
		// The rules go unlatched, so they arrive whole on this session's next
		// write.
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" }));
		live(sb, "bob");

		const r = run(writePayload(docMap(), { session_id: "bob" }));
		const parsed = JSON.parse(r.stdout);
		expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
		// One object, not two: Claude Code reads a single hook output.
		expect(r.stdout.trim().split("\n")).toHaveLength(1);
	});

	/*
	 * THE PACKING ARITHMETIC (mantahostels#2386).
	 *
	 * Which ids reach a session's FIRST guarded write is a property of the
	 * fragments' BYTE LENGTHS against GP_RULE_CAP, not of the gp_rule call's
	 * spelling — and gp_rule stops at the first id that does not fit rather than
	 * skipping to a smaller one behind it. So a fragment that merely grows can
	 * silently push claim-bash-route, the id nothing anywhere reprints, off a
	 * one-write session's only envelope.
	 *
	 * Each case below checks the model against what the guard really emitted,
	 * never the model alone: were that `break` ever to become a skip to a smaller
	 * id behind, a model would go on agreeing with itself.
	 */
	const cap = shellConst(
		path.join(__dirname, "lib/guard-parse.sh"),
		"GP_RULE_CAP",
	);

	/**
	 * The ids each gp_rule call names — a tier's, or the new-guard branch's —
	 * in the order it names them, the path_rules table expanded in place.
	 *
	 * The space after `gp_rule` keeps `gp_rule_skip` out.
	 */
	const calls = [
		...expandRuleTables(guardSrc).matchAll(/^\s*gp_rule ((?:[a-z-]+ ?)+)$/gm),
	].map((m) => m[1].trim().split(/\s+/));

	/**
	 * The ids the guard offers on one kind of write, in its order. On the docs
	 * arm `docs` names the one rule its write's path or class keeps, or null
	 * for none, of doc-authority-class, writing-for-agents and every path_rules
	 * row.
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
			throw new Error(`no ${JSON.stringify(call)} gp_rule call in the guard`);
		return chosen;
	};

	/** The leading ids whose fragments fit one envelope under the cap. */
	const fillEnvelope = (ids: string[]) => {
		let envelope = "";
		const taken: string[] = [];
		for (const id of ids) {
			const candidate = envelope
				? `${envelope}\n\n${ruleText(id)}`
				: ruleText(id);
			if (Buffer.byteLength(candidate) > cap) break;
			envelope = candidate;
			taken.push(id);
		}
		return taken;
	};

	/** gp_rule's greedy fill, modelled. */
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

	/** Every id any gp_rule call can name — the alphabet emittedPacks reads back. */
	const cluster = [...new Set(calls.flat())];

	/**
	 * What the guard really emitted over `writes` successive writes, split back
	 * into the ids each envelope carried.
	 *
	 * `null` for a write that said nothing at all, which is distinct from one
	 * that carried an envelope holding no fragment.
	 */
	const emittedPacks = (
		file: string,
		sessionId: string,
		writes: number,
		tool = "Edit",
	) => {
		const out: (string[] | null)[] = [];
		for (let i = 0; i < writes; i++) {
			const r = run(
				writePayload(file, { session_id: sessionId, tool_name: tool }),
			);
			expect(r.status).toBe(0);
			const said = (r.stdout ?? "").trim();
			if (said === "") {
				out.push(null);
				continue;
			}
			const ctx = JSON.parse(said).hookSpecificOutput.additionalContext ?? "";
			out.push(
				cluster
					.filter((id) => ctx.includes(ruleText(id)))
					.sort((a, b) => ctx.indexOf(ruleText(a)) - ctx.indexOf(ruleText(b))),
			);
		}
		return out;
	};

	it(
		"delivers claim-bash-route and file-claim on a deny-tier session's FIRST write",
		() => {
			const expected = modelPacks(orderFor({ docs: null }));
			expect(expected[0]).toEqual(["claim-bash-route", "file-claim"]);
			live(sb, "a");
			expect(emittedPacks(plainDoc(), "a", expected.length)).toEqual(expected);
		},
		slow,
	);

	it(
		"still delivers claim-bash-route and file-claim on the FIRST write to a derived doc (#2016)",
		() => {
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
				emittedPacks(
					path.join(sb.repo, "docs/digest.md"),
					"a",
					expected.length,
				),
			).toEqual(expected);
		},
		slow,
	);

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
		slow,
	);

	it(
		"still delivers claim-bash-route on the FIRST write to an adopter template (#2030)",
		() => {
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
		},
		slow,
	);

	it(
		"delivers script-self-claim and claim-bash-route on a scripts-tier session's FIRST write",
		() => {
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
		},
		slow,
	);

	it(
		"leads a NEW guard's first write with guard-authoring (#1011)",
		() => {
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
		},
		slow,
	);

	it(
		"says each rule once per session, however many writes follow",
		() => {
			live(sb, "a");
			const first = injectedOver(plainDoc(), "a", denyTier.length);
			for (const [id] of denyTier) expect(first).toContain(ruleText(id));
			// The latch is written on emission.
			expect(injectedOver(plainDoc(), "a", 3)).toBe("");
		},
		slow,
	);
});

describe("it is wired", () => {
	it("bounds the arbiter below the hook timeout its registration gives it", () => {
		// What makes the kill worth having: past the registration's budget Claude Code
		// takes over and the guard never gets to allow the write. This compares two
		// CONSTANTS, so it reads them from the two files rather than timing a run
		// (mantahostels#175) — a stopwatch passes a 9s bound on an idle box and fails a 5s one
		// under load, for identical code.
		//
		// Anchored to the line, not the first match anywhere: the prose above the
		// command already discusses the bound, so an unanchored match would let a
		// future comment become the authority.
		// The call is captured into `arb` since mantahostels#1646, so the anchor allows that
		// one assignment prefix and nothing looser.
		const bound = /^\s*arb="\$\(timeout ([0-9]+) node /m.exec(
			fs.readFileSync(GUARD, "utf8"),
		);
		if (!bound) throw new Error("guard no longer bounds the arbiter");

		const wired = registrationsOf("PreToolUse", "guard-file-claim.sh");
		// One registration, or the budget below is whichever happened to sort first.
		expect(wired).toHaveLength(1);
		// Explicit, and a throw rather than an expect: an entry that dropped its
		// timeout would otherwise compare against undefined and fail as a type
		// confusion rather than as the unbounded hook it is.
		const { timeout } = wired[0];
		if (typeof timeout !== "number")
			throw new Error("the hook registration no longer carries a timeout");

		expect(Number(bound[1])).toBeLessThan(timeout);
	});
});

describe("faults the guard cannot see", () => {
	// chmod is advisory to root, which reads a 000 directory regardless — under
	// it the store is readable, the guard denies, and this test would fail for a
	// reason that says nothing about the guard.
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
				const r = run(writePayload(docMap(), { session_id: "bob" }));
				expect(r.status).toBe(0);
				const json = JSON.parse(r.stdout);
				expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
				expect(json.hookSpecificOutput.additionalContext).toMatch(
					/store is unreadable/,
				);
			} finally {
				unseal();
			}
		},
	);

	it.skipIf(isRoot)(
		"records the unreadable store where check-guard-errors.js reads it (mantahostels#174)",
		() => {
			// Filed under `claim`, as the arbiter's fault rather than the guard's.
			sealTheStore();
			try {
				run(writePayload(docMap(), { session_id: "bob" }));
				const claim = faults().filter((f) => f.where === "claim");
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
			// heldBy answers null for an unreadable store, which is "unknown", never
			// "this session holds nothing" (mantahostels#174). Reading it as the latter would
			// accuse every session that DID run alloc-entry.
			sealTheStore();
			try {
				const r = run(
					writePayload(docMap(), {
						session_id: "bob",
						tool_input: {
							file_path: docMap(),
							old_string: "x",
							new_string: "### B8 · New",
						},
					}),
				);
				expect(r.stdout).not.toContain("B8");
			} finally {
				unseal();
			}
		},
	);

	it("logs, and forwards no ids, when jq cannot read new_string (mantahostels#1424)", () => {
		// A new_string that is not a string fails the split. Silence there would be
		// indistinguishable from a write that adds no entries, which is exactly the
		// fail-open the log exists to make visible.
		const out = path.join(sb.dir, "argv-fault.json");
		run(
			{
				session_id: "s",
				tool_name: "Edit",
				tool_input: { file_path: docMap(), new_string: 42 },
			},
			{
				guard: detachedGuard(
					`require("fs").writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));`,
				),
				env: { ARGV_OUT: out },
			},
		);
		expect(JSON.parse(fs.readFileSync(out, "utf8"))[5]).toBe("");
		expect(faults()[0].what).toMatch(/entry ids dropped/);
	});

	it("treats an empty payload as nothing to check, not a fault", () => {
		expectSilentAllow(run(""));
		expect(faults()).toEqual([]);
	});
});

describe("where the log lands — the silence it exists to break", () => {
	it("writes to the exact path check-guard-errors.js reads", () => {
		// The guard derives the project slug in bash and the reader derives it in
		// node. Drift between them puts every fail-open in a directory nothing
		// reports on, which reads as a guard finding nothing wrong.
		//
		// Run from a SUBDIRECTORY: a hook inherits the session's cwd, which is not
		// generally the repo root, and with the two equal a guard that logged
		// under $PWD would pass this by coincidence.
		run(writePayload(docMap()), {
			cwd: path.join(sb.repo, "docs"),
			env: { PATH: pathWithout("jq") },
		});
		expect(fs.existsSync(store.errorLog())).toBe(true);
		expect(faults()[0].what).toMatch(/jq not found/);
	});

	it("falls back to the git top level when CLAUDE_PROJECT_DIR is unset", () => {
		// A hook invoked outside Claude Code's own env still has to log somewhere
		// the reader will look.
		const git = path.join(sb.dir, "gitrepo");
		fs.mkdirSync(path.join(git, "docs"), { recursive: true });
		execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: git });

		run(writePayload(path.join(git, "docs/doc-map.md")), {
			// The subdirectory again, so the top level is something git had to
			// resolve rather than the cwd handed straight back.
			cwd: path.join(git, "docs"),
			env: { CLAUDE_PROJECT_DIR: undefined, PATH: pathWithout("jq") },
		});

		const expected = path.join(
			sb.home,
			"projects",
			// realpath: on macOS and in some WSL layouts /tmp is a symlink, and git
			// reports the resolved path.
			fs.realpathSync(git).replace(/[^a-zA-Z0-9]/g, "-"),
			"guard-errors.log",
		);
		expect(faults(expected)[0]?.what).toMatch(/jq not found/);
	});

	it("collapses tabs and newlines in the reason, so one fault is one line", () => {
		// A reason routinely carries a path straight off the tool payload, and tabs
		// and newlines are this record's own delimiters. Unescaped, a file named
		// with a newline appends a second, forged record — and one with a tab shifts
		// every field, so check-guard-errors.js reads the message as the guard name.
		const cfg = path.join(sb.dir, "cfg");
		const log = path.join(cfg, "projects", "sanitise", "guard-errors.log");
		execFileSync(
			"bash",
			[
				"-c",
				`source "${path.resolve(__dirname, "lib/guard-log.sh")}"; ` +
					`gl_log "$(printf 'timed out on a\\tb\\nc — write allowed unchecked')"`,
			],
			{
				env: {
					...process.env,
					CLAUDE_CONFIG_DIR: cfg,
					CLAUDE_PROJECT_DIR: "sanitise",
				},
			},
		);
		const written = fs.readFileSync(log, "utf8").trimEnd();
		expect(written.split("\n")).toHaveLength(1);
		expect(written.split("\t")).toHaveLength(3);
		expect(written.split("\t")[2]).toBe(
			"timed out on a b c — write allowed unchecked",
		);
	});

	it("writes three tab-separated fields with a parseable timestamp", () => {
		// check-guard-errors.js splits on \t and calls Date.parse on field 1; a
		// line it cannot parse is reported as torn and its message never shown.
		run(writePayload(docMap()), { env: { PATH: pathWithout("jq") } });
		const line = fs.readFileSync(store.errorLog(), "utf8").trimEnd();
		expect(line.split("\t")).toHaveLength(3);
		expect(Number.isFinite(Date.parse(line.split("\t")[0]))).toBe(true);
	});

	it("appends, so an earlier fault is never overwritten", () => {
		run(writePayload(docMap()), { env: { PATH: pathWithout("jq") } });
		run("not json at all");
		expect(faults().map((f) => f.what)).toEqual([
			expect.stringMatching(/jq not found/),
			expect.stringMatching(/did not parse/),
		]);
	});
});

/*
 * THE ENVELOPE BOTH SIDES AGREE ON (mantahostels#2387).
 *
 * mantahostels#2369 made the guard unwrap an arbiter NOTE and re-emit its text inside the
 * rule envelope, and the unwrap is shape-exact: the object's key set must be
 * exactly ["hookSpecificOutput"] and that object's exactly ["additionalContext",
 * "hookEventName"]. Anything else relays byte for byte. So the day
 * session-arbiter.js adds a field to that emission, every note silently stops
 * riding with the rules and mantahostels#2369 reverts to the behaviour it fixed.
 */
describe("what the arbiter emits on a note (mantahostels#2387)", () => {
	it("carries exactly the two key sets the guard's unwrap requires", () => {
		gitRepo(sb);
		fs.writeFileSync(plainDoc(), "an edit nobody claims\n");
		live(sb, "alice");
		// The guard's own argv: check <file> <session> <anchor> <anchor_len> <ids>.
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
