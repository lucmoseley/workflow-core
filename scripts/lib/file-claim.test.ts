// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SCRIPT as ARBITER,
	freshSandbox,
	gitRepo,
	live,
	store,
	storeAt,
} from "./arbiter-testkit";
import { recordToolWrite } from "./arbiter-tool-record.js";
import type { FileClaimContext } from "./file-claim.js";
import { buildHostPorts } from "./file-claim-host.js";
import { cutWorktree } from "./git-fixture";
import { loadedCores, runCore, splitCheckout } from "./guard-core-testkit";
import { writeLatches } from "./guard-entry.js";
import { type Adapters, hostAdapters } from "./guard-host-ports.js";
import { dispatch, type Output } from "./guard-judge.js";
import { registrationsOf } from "./hook-wiring";
import { readHookPersistChars, readRuleCap } from "./rule-emission.js";
import { readRuleText } from "./rule-text.js";
import { runInProcess } from "./run-in-process";

type Answer =
	| { ok: true; stdout: string }
	| { ok: false; why: string; stdout: string };
type ArbiterCheck = (args: string[], cwd: string) => Answer;

const CORE_SRC = path.join(__dirname, "file-claim.js");

const sb = freshSandbox();

const docMap = () => path.join(sb.repo, "docs/doc-map.md");

const plainDoc = () => path.join(sb.repo, "docs/plain.md");

const inProcessArbiter: ArbiterCheck = (args, cwd) => {
	const r = runInProcess(ARBITER, args, { cwd });
	return r.status === 0
		? { ok: true, stdout: r.stdout }
		: { ok: false, why: `exited ${r.status}`, stdout: r.stdout };
};

const standIn =
	(stdout = "", seen: string[][] = []): ArbiterCheck =>
	(args) => {
		seen.push(args);
		return { ok: true, stdout };
	};

interface Run {
	output: Output | null;
	logs: string[];
	names: string[];
}

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
	const cores = loadedCores("PreToolUse").filter(
		(c) => c.name === "guard-file-claim",
	);
	expect(cores).toHaveLength(1);
	const adapters: Adapters & Pick<FileClaimContext, "arbiterCheck"> = {
		...hostAdapters(root, logFor("entry")),
		fallbackCwd: root,
		vars: env,
		env,
		arbiterCheck,
	};
	const { output, latches } = dispatch(
		cores.map((c) => ({ ...c, host: undefined })),
		{
			payload,
			root,
			adapters,
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
	tool_name: "Edit",
	tool_input: { file_path: file },
	...extra,
});

const expectAllowNoDeny = (r: Run) => {
	if (r.output === null) return;
	expect(Object.keys(r.output)).toEqual(["additionalContext"]);
	expect(typeof r.output.additionalContext).toBe("string");
};

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

interface Lock {
	path: string;
	sessionId: string;
}
const heldPaths = () => (store.listLocks() as Lock[]).map((l) => l.path);
const holderOf = (rel: string) =>
	(store.listLocks() as Lock[]).find((l) => l.path === rel)?.sessionId;

beforeEach(() => {
	fs.mkdirSync(path.join(sb.repo, "app"), { recursive: true });
});

describe("what it pulls out of the hook payload", () => {
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
		expect(
			argvOf({
				session_id: "s",
				tool_name: "Edit",
				tool_input: { file_path: docMap(), old_string: "### B42 · A debt" },
			})[3],
		).toBe("### B42 · A debt");
	});

	it("truncates a very long anchor rather than failing the exec", () => {
		const anchor = "x".repeat(20_000);
		const argv = argvOf({
			session_id: "s",
			tool_name: "Edit",
			tool_input: { file_path: docMap(), old_string: anchor },
		});
		expect(argv[3]).toHaveLength(8000);
		expect(anchor.startsWith(argv[3])).toBe(true);
		expect(argv[4]).toBe("20000");
	});

	it("keeps a newline-terminated anchor whole, so it is not read as truncated (mantahostels#1188)", () => {
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
		expect(
			argvOf({
				session_id: "s",
				tool_name: "Write",
				tool_input: { file_path: docMap(), content: "### B8 · New" },
			})[5],
		).toBe("");
	});

	it("reads notebook_path, which NotebookEdit sends instead of file_path", () => {
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

	it("lets a write to a file a live session holds through, warning of the merge conflict and naming the holder (#4249)", () => {
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" }));
		live(sb, "bob");

		const { output } = run(writePayload(docMap(), { session_id: "bob" }));
		expect(output?.permissionDecision).toBeUndefined();
		expect(output?.additionalContext).toContain(
			"docs/doc-map.md is also held by session alice",
		);
		expect(output?.additionalContext).toContain("merge conflict");
	});

	it("lets the holder keep writing its own file", () => {
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" }));
		expectAllowNoDeny(run(writePayload(docMap(), { session_id: "alice" })));
	});

	it("says nothing about product code", () => {
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

	it("warns on a held notebook", () => {
		const nb = path.join(sb.repo, "docs/nb.ipynb");
		live(sb, "alice");
		store.acquire("docs/nb.ipynb", store.identify("alice"));
		live(sb, "bob");

		const { output } = run({
			session_id: "bob",
			tool_name: "NotebookEdit",
			tool_input: { notebook_path: nb },
		});
		expect(output?.permissionDecision).toBeUndefined();
		expect(output?.additionalContext).toContain(
			"docs/nb.ipynb is also held by session alice",
		);
	});

	it("does not deny on a claim whose holder has died", () => {
		store.acquire("docs/doc-map.md", {
			sessionId: "gone",
			pid: 4_194_303,
			procStart: "1",
			durable: true,
		});
		live(sb, "bob");
		expectAllowNoDeny(run(writePayload(docMap(), { session_id: "bob" })));
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
	const fakeArbiter = (body: string) => {
		const at = path.join(
			sb.dir,
			`arbiter-${Math.random().toString(36).slice(2)}.js`,
		);
		fs.writeFileSync(at, body);
		return at;
	};
	const hostRun = (payload: Record<string, unknown>, arbiter?: string) => {
		const { arbiterCheck } = buildHostPorts(
			{ root: sb.repo },
			arbiter ? { arbiter } : {},
		);
		return run(payload, { arbiterCheck });
	};

	it("warns through the real arbiter, the whole chain unstubbed", () => {
		live(sb, "alice");
		hostRun(writePayload(docMap(), { session_id: "alice" }));
		live(sb, "bob");
		const { output } = hostRun(writePayload(docMap(), { session_id: "bob" }));
		expect(output?.permissionDecision).toBeUndefined();
		expect(output?.additionalContext).toContain("also held by session alice");
	});

	it("allows an Edit whose old_string holds a NUL, which no process can take as an argument", () => {
		const r = hostRun(
			writePayload(docMap(), {
				tool_input: { file_path: docMap(), old_string: "a\0b" },
			}),
		);
		expect(r.output?.permissionDecision).toBeUndefined();
		expect(r.logs.join("\n")).toMatch(/null bytes.* — write allowed unchecked/);
	});

	it("logs an arbiter that exits non-zero, and allows the write", () => {
		const r = hostRun(writePayload(docMap()), fakeArbiter("process.exit(3)"));
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			`arbiter exited 3 on ${docMap()} — write allowed unchecked`,
		]);
		expect(r.names).toEqual(["guard-file-claim"]);
	});

	it("kills an arbiter that hangs, inside the hook timeout its registration gives it", () => {
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
		const r = run({ session_id: "s", tool_name: "Write", tool_input: {} });
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			"no file_path or notebook_path in payload — write allowed unchecked",
		]);
	});

	it("logs, and forwards no ids, where new_string is not a string (mantahostels#1424)", () => {
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

	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

	const sealTheStore = () => {
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" }));
		fs.chmodSync(store.paths.locksDir(), 0o000);
		live(sb, "bob");
	};
	const unseal = () => fs.chmodSync(store.paths.locksDir(), 0o755);

	it.skipIf(isRoot)(
		"an unreadable lock store allows the write, but says so rather than going quiet (mantahostels#174)",
		() => {
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

describe("it hands over the claim rules before the mistake", () => {
	const coreSrc = fs.readFileSync(CORE_SRC, "utf8");

	const pathRows: string[][] = [
		["roadmap-edit", "docs/reference-roadmap.html", "roadmap"],
		["manual-sync", "docs/operating-manual.md", "governance", "roadmap"],
	];

	const claimTier: [string, string[]][] = [
		[
			"file-claim",
			[
				"Writing the file is what takes the claim",
				"detect only",
				"likely meet a merge conflict",
			],
		],
		["claim-release", ["node scripts/session-arbiter.js release <path>"]],
		["claim-bash-route", ["file unrefused", "Read the\nclaims yourself"]],
	];

	const injectedOver = (file: string, sessionId: string, writes: number) => {
		let seen = "";
		for (let i = 0; i < writes; i++) {
			const { output } = run(writePayload(file, { session_id: sessionId }));
			if (output === null) continue;
			seen += `${output.additionalContext ?? ""}\n`;
		}
		return seen;
	};

	it.each(claimTier)("emits %s on a write to the claim tier", (id, needles) => {
		live(sb, "a");
		const seen = injectedOver(plainDoc(), "a", claimTier.length);
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
		live(sb, "a");
		const { output } = run(writePayload(plainDoc(), { session_id: "a" }), {
			root: `${sb.repo}/`,
		});
		expect(output?.additionalContext).toContain(readRuleText("file-claim"));
	});

	const readLatchedMarkers = () => {
		const dir = path.join(sb.repo, ".claude", "tmp", "markers");
		if (!fs.existsSync(dir)) return [];
		return fs.readdirSync(dir).filter((f) => f.startsWith(".rule-injected-"));
	};

	it("carries an arbiter NOTICE and the cluster in ONE envelope (mantahostels#2369)", () => {
		live(sb, "a");
		const first = run(writePayload(docMap(), { session_id: "a" })).output;
		expect(first?.permissionDecision).toBeUndefined();
		const said = first?.additionalContext ?? "";
		expect(said).toContain("claims the WHOLE of");
		expect(said).toContain(readRuleText("claim-bash-route"));
		expect(said).toContain(readRuleText("file-claim"));
		expect(said.indexOf("claims the WHOLE of")).toBeLessThan(
			said.indexOf(readRuleText("claim-bash-route")),
		);
		expect(readLatchedMarkers()).toEqual(
			expect.arrayContaining([
				".rule-injected-claim-bash-route-main-a",
				".rule-injected-file-claim-main-a",
			]),
		);
	});

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

	it("rides with the dirty-and-unclaimed notice, root or not (mantahostels#2387)", () => {
		gitRepo(sb);
		fs.writeFileSync(plainDoc(), "an edit nobody claims\n");
		live(sb, "alice");
		const first = run(writePayload(plainDoc(), { session_id: "alice" })).output;
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
		live(sb, "a");
		const huge = "N".repeat(3999);
		const r = run(writePayload(plainDoc(), { session_id: "a" }), {
			arbiterCheck: standIn(note(huge)),
		});
		expect(r.output).toEqual({ additionalContext: huge });
		expect(readLatchedMarkers()).toEqual([]);
		const quiet = run(writePayload(plainDoc(), { session_id: "a" }));
		expect(quiet.output?.additionalContext).toContain(
			readRuleText("file-claim"),
		);
		expect(readLatchedMarkers()).not.toEqual([]);
	});

	it.each([
		["outside both tiers", () => path.join(sb.repo, "app/page.tsx"), true],
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

	const firstEnvelope = (rel: string) => {
		live(sb, "a");
		const r = run(writePayload(path.join(sb.repo, rel), { session_id: "a" }));
		expectAllowNoDeny(r);
		return r.output?.additionalContext ?? "";
	};

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
			vi.stubEnv("WFC_MODULES", modules.join(","));
			const ctx = firstEnvelope(rel);
			expect(ctx).not.toContain(readRuleText(rule));
			expect(ctx).toContain(readRuleText("claim-bash-route"));
		},
	);

	it("spells every path row's gate where lib/rule-emission.js reads it", () => {
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

	it("carries the held-file warning ahead of the cluster (#4249)", () => {
		live(sb, "alice");
		run(writePayload(docMap(), { session_id: "alice" }));
		live(sb, "bob");

		const { output } = run(writePayload(docMap(), { session_id: "bob" }));
		expect(output?.permissionDecision).toBeUndefined();
		const said = output?.additionalContext ?? "";
		expect(said).toContain("also held by session");
		expect(said.indexOf("also held by session")).toBeLessThan(
			said.indexOf(readRuleText("claim-bash-route")),
		);
	});

	const cap = readRuleCap();

	const calls = [...coreSrc.matchAll(/injectRules:\s*\[([^\]]*)\]/g)].map((m) =>
		[...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]),
	);

	const orderFor = (
		call:
			| { docs: string | null }
			| "scripts"
			| "scripts-agent-doc"
			| "new-guard",
	) => {
		expect(calls).toHaveLength(4);
		const newGuard = calls.find((ids) => ids.includes("guard-authoring"));
		const scriptsArm = calls.find(
			(ids) =>
				ids.includes("script-self-claim") && !ids.includes("guard-authoring"),
		);
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

	const cluster = [...new Set(calls.flat())];

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
			"file-claim",
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

	it("delivers script-self-claim, claim-bash-route and file-claim on a scripts-tier session's FIRST write", () => {
		const expected = modelPacks(orderFor("scripts"));
		expect(expected[0]).toEqual([
			"script-self-claim",
			"claim-bash-route",
			"file-claim",
		]);
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
		const first = injectedOver(plainDoc(), "a", claimTier.length);
		for (const [id] of claimTier) expect(first).toContain(readRuleText(id));
		expect(injectedOver(plainDoc(), "a", 3)).toBe("");
	});
});

describe("what the arbiter emits on a note (mantahostels#2387)", () => {
	it("carries exactly the two key sets the core's unwrap requires", () => {
		gitRepo(sb);
		fs.writeFileSync(plainDoc(), "an edit nobody claims\n");
		live(sb, "alice");
		const r = runInProcess(ARBITER, ["check", plainDoc(), "alice", "", "", ""]);
		expect(r.status).toBe(0);
		const parsed = JSON.parse(r.stdout);
		expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
		expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
			"additionalContext",
			"hookEventName",
		]);
		expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
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

	it("carries the context and names a permission decision as dropped", () => {
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
		expect(r.output?.permissionDecision).toBeUndefined();
		expect(r.output?.additionalContext).toBe("and more");
		expect(r.logs).toEqual([
			"arbiter answered fields a dispatcher part cannot carry — dropped: hookSpecificOutput.permissionDecision, hookSpecificOutput.permissionDecisionReason",
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

describe("a write from a session in its own worktree (#4242)", () => {
	let at: { main: string; worktree: string };
	const split = freshSandbox((fresh) => {
		at = splitCheckout(path.join(fresh.dir, "split"));
	});

	const classed = (root: string) => {
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "docs/doc-map-classes.json"),
			JSON.stringify({ "docs/digest.md": { class: "derived" } }),
		);
	};

	const envelope = () =>
		run(
			writePayload(path.join(at.worktree, "docs/digest.md"), {
				session_id: "a",
				cwd: at.worktree,
			}),
			{ root: at.main, arbiterCheck: standIn() },
		).output?.additionalContext ?? "";

	it("leads with the authority-class rule on a doc the worktree's register lists", () => {
		classed(at.worktree);
		expect(envelope().startsWith(readRuleText("doc-authority-class"))).toBe(
			true,
		);
	});

	it("hands the docs cluster without it where only the main checkout's register lists the doc", () => {
		classed(at.main);
		const said = envelope();
		expect(said).toContain(readRuleText("file-claim"));
		expect(said).not.toContain(readRuleText("doc-authority-class"));
	});

	const aliceHoldsIn = (root: string) => {
		storeAt(root);
		store.acquire("docs/plain.md", live(split, "alice"));
	};
	const writeFrom = (tree: string, session: string, rel = "docs/plain.md") => {
		storeAt(at.main);
		live(split, session);
		return runCore(
			"guard-file-claim",
			writePayload(path.join(tree, rel), { session_id: session }),
			{ root: at.main, worktree: tree },
		);
	};

	it("warns of the file a session holds in the host's claim store, keyed by its path in the tree (#4397)", () => {
		aliceHoldsIn(at.main);
		const warned = writeFrom(at.worktree, "bob").output;
		expect(warned?.permissionDecision).toBeUndefined();
		expect(warned?.additionalContext).toContain("also held by session alice");
	});

	it("takes no claim on a main-checkout file written from a worktree", () => {
		storeAt(at.main);
		live(split, "bob");
		const r = runCore(
			"guard-file-claim",
			writePayload(path.join(at.main, "docs/plain.md"), { session_id: "bob" }),
			{ root: at.main, worktree: at.worktree },
		);
		expect(r.output?.permissionDecision).toBeUndefined();
		expect(store.listLocks()).toEqual([]);
	});

	it("warns when two sessions in two worktrees write one doc (#4397)", () => {
		const first = cutWorktree(at.main, "s1");
		const second = cutWorktree(at.main, "s2");
		writeFrom(first, "alice");
		const warned = writeFrom(second, "bob").output;
		expect(warned?.additionalContext).toContain("also held by session alice");
		expect(
			(store.listLocks() as Lock[]).map((l) => [l.sessionId, l.path]),
		).toEqual([["alice", "docs/plain.md"]]);
	});

	it("pins the worktree's copy, not the main checkout's (#4397)", () => {
		const wt = cutWorktree(at.main);
		const hashOf = (tree: string, body: string) => {
			const file = path.join(tree, "docs/plain.md");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
			return spawnSync("git", ["hash-object", file], {
				encoding: "utf8",
			}).stdout.trim();
		};
		hashOf(at.main, "main copy\n");
		const mine = hashOf(wt, "worktree copy\n");
		writeFrom(wt, "bob");
		const back = process.cwd();
		process.chdir(wt);
		try {
			recordToolWrite(path.join(wt, "docs/plain.md"), "bob");
		} finally {
			process.chdir(back);
		}
		const [lock] = store.listLocks() as (Lock & {
			blob?: string;
			preBlob?: string;
		})[];
		expect([lock?.blob, lock?.preBlob]).toEqual([mine, mine]);
	});

	it("takes no claim on the worktree's own .claude/tmp/", () => {
		const nested = cutWorktree(at.main);
		expect(
			writeFrom(nested, "bob", ".claude/tmp/scratch.md").output,
		).toBeNull();
		expect(store.listLocks()).toEqual([]);
	});

	it("takes the claim on the same worktree's doc by its path there", () => {
		writeFrom(cutWorktree(at.main), "bob");
		expect(heldPaths()).toEqual(["docs/plain.md"]);
	});
});
