// @vitest-environment node
/*
 * lib/echo-chain.js holds the echo-chain rules both halves run on
 * (mantahostels#2570): lib/echo-record.js, the PostToolUse recorder, writes
 * the chain after every Bash and Read call, and lib/echo-call.js reads it and
 * refuses on it. The rules are tested here as functions; then the real
 * recorder core, run in process through lib/guard-core-testkit.ts, is read
 * back by the reader's own lookup, so a call the recorder files is one the
 * guard finds. The store lives under TMPDIR, stubbed per case, as its host
 * (lib/echo-record-host.js) reads it.
 *
 * These cross the real clock: the recorder stamps its own records, so each
 * read back uses the clock's reading, and no case measures elapsed time.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chain from "./echo-chain.js";
import host from "./echo-record-host.js";
import { runCore } from "./guard-core-testkit";

let dir: string;
let tmp: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-chain-"));
	tmp = path.join(dir, "tmp");
	fs.mkdirSync(tmp);
	vi.stubEnv("TMPDIR", tmp);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const sha24 = (text: string) =>
	createHash("sha1").update(text).digest("hex").slice(0, 24);

describe("the signature", () => {
	it("is the tool, a unit separator and the input, keys sorted at every depth", () => {
		expect(
			chain.signature("Bash", { b: [1, { d: 1, c: 2 }], a: null }, null),
		).toBe(sha24('Bash\x1f{"a":null,"b":[1,{"c":2,"d":1}]}'));
	});

	/* By UTF-16 units an astral key sorts before U+FFFF; by UTF-8 bytes after. */
	it("sorts keys by their UTF-8 bytes", () => {
		expect(chain.signature("Bash", { "\u{1F600}": 1, "￿": 2 }, null)).toBe(
			sha24('Bash\x1f{"￿":2,"\u{1F600}":1}'),
		);
	});

	it("signs a missing input as an empty one", () => {
		expect(chain.signature("Bash", undefined, null)).toBe(sha24("Bash\x1f{}"));
	});

	it("separates the same bytes under another tool, and a Read's file state", () => {
		const input = { file_path: "/x" };
		const bash = chain.signature("Bash", input, null);
		const read = chain.signature("Read", input, null);
		expect(bash).not.toBe(read);
		expect(chain.signature("Read", input, "1:2:3.000000000:4.000000000")).toBe(
			sha24('Read\x1f{"file_path":"/x"}\x1f1:2:3.000000000:4.000000000'),
		);
	});

	it("states only a Read's file, and only one with a path", () => {
		const asked: string[] = [];
		const state = (f: string) => {
			asked.push(f);
			return "s";
		};
		chain.callSignature("Bash", { command: "ls", file_path: "/b" }, state);
		chain.callSignature("Read", { file_path: 7 }, state);
		expect(asked).toEqual([]);
		expect(chain.callSignature("Read", { file_path: "/r" }, state)).toBe(
			chain.signature("Read", { file_path: "/r" }, "s"),
		);
		expect(asked).toEqual(["/r"]);
	});
});

describe("the file state", () => {
	const fileState = (p: string, logs: string[] = []) =>
		host.buildHostPorts(dir, (w) => logs.push(w)).fileState(p);

	it("states a file through a symlink, alike", () => {
		const file = path.join(dir, "f.txt");
		fs.writeFileSync(file, "v1");
		const link = path.join(dir, "link.txt");
		fs.symlinkSync(file, link);
		expect(fileState(file)).toMatch(/^\d+:2:\d+\.\d{9}:\d+\.\d{9}$/);
		expect(fileState(link)).toBe(fileState(file));
	});

	it("pads a sub-second stamp to nine digits", () => {
		const file = path.join(dir, "f.txt");
		fs.writeFileSync(file, "v1");
		const touched = spawnSync("touch", ["-d", "@1577836800.000000123", file]);
		expect(touched.status).toBe(0);
		expect(fileState(file)).toMatch(/:1577836800\.000000123:/);
	});

	it("is null for a missing file, unlogged", () => {
		const logs: string[] = [];
		expect(fileState(path.join(dir, "absent"), logs)).toBeNull();
		expect(logs).toEqual([]);
	});
});

describe("the response hash", () => {
	it("is null for a missing response, and a hash for an empty one", () => {
		expect(chain.responseHash(undefined)).toBeNull();
		expect(chain.responseHash(null)).toBeNull();
		expect(chain.responseHash("")).toMatch(/^[0-9a-f]{24}$/);
	});

	it("drops a volatile field by its name, and reads a real change beside one", () => {
		const a = chain.responseHash({ stdout: "ok", durationMs: 11 });
		expect(chain.responseHash({ stdout: "ok", durationMs: 22 })).toBe(a);
		expect(chain.responseHash({ stdout: "ok", elapsed_ms: 1 })).toBe(a);
		expect(chain.responseHash({ stdout: "no", durationMs: 11 })).not.toBe(a);
	});
});

describe("the store", () => {
	const now = 1_800_000_000;

	it("reads tab runs as one delimiter, so a cleared record reads back whole", () => {
		const cleared = chain.storeText([], {
			sig: "s",
			hash: chain.EC_CLEARED,
			run: 0,
			at: now,
			denies: 1,
		});
		expect(cleared).toBe(`s\t-\t0\t${now}\t1\n`);
		expect(chain.lookup(cleared, "s", now)).toEqual({
			sig: "s",
			hash: "-",
			run: 0,
			at: now,
			denies: 1,
		});
		expect(chain.parseRecords(`a\t\th\t\t2\t${now}\t0\n`, now)).toEqual([
			{ sig: "a", hash: "h", run: 2, at: now, denies: 0 },
		]);
	});

	it("reads a record at 3599 s and drops one at 3600 s", () => {
		const text = `old\th\t1\t${now - 3600}\t0\nlive\th\t1\t${now - 3599}\t0\n`;
		expect(chain.parseRecords(text, now).map((r) => r.sig)).toEqual(["live"]);
		expect(chain.lookup(text, "old", now)).toBeNull();
	});

	it("drops a record with a field that is no count", () => {
		const text = `a\th\tx\t${now}\t0\nb\th\t1\t${now}\t-\nc\th\t1\t${now}\t0\n`;
		expect(chain.parseRecords(text, now).map((r) => r.sig)).toEqual(["c"]);
	});

	it("replaces the signature's record and caps the store at 200, the newest kept", () => {
		const records = Array.from({ length: 259 }, (_, i) => ({
			sig: `p${i}`,
			hash: "h",
			run: 1,
			at: now,
			denies: 0,
		}));
		const next = { sig: "p3", hash: "n", run: 2, at: now, denies: 0 };
		const lines = chain.storeText(records, next).trim().split("\n");
		expect(lines).toHaveLength(200);
		expect(lines.at(-1)).toBe(`p3\tn\t2\t${now}\t0`);
		expect(lines.filter((l) => l.startsWith("p3\t"))).toHaveLength(1);
		expect(lines[0]?.startsWith("p60\t")).toBe(true);
	});

	it("names an agent's chain `<session>.<agent>`", () => {
		expect(chain.chainName({ agent: "main", sid: "s_1" })).toBe("s_1.main");
	});
});

describe("the shapes lib/agent-poll.js owns", () => {
	it.each([
		"sleep 5; ls",
		"  sleep 120",
		"true",
		":",
		"exit 0",
		"exit",
		" true ; # x",
	])("leaves %j on Bash", (c) =>
		expect(chain.isNeighbours("Bash", c)).toBe(true),
	);

	it.each(["sleepy 5", "sleep x", "exit 1", "true && ls", "ls; sleep 5"])(
		"judges %j",
		(c) => expect(chain.isNeighbours("Bash", c)).toBe(false),
	);

	it("never leaves a Read", () =>
		expect(chain.isNeighbours("Read", "sleep 5")).toBe(false));
});

describe("the recorder core, read back by the reader", () => {
	const Same = { stdout: "1 passed", stderr: "", interrupted: false };
	const Ls = { command: "ls" };
	let logs: string[];

	beforeEach(() => {
		logs = [];
	});

	/** The real recorder on one payload, as PostToolUse runs it. Its output is
	 * context handed to the session on every Bash and Read call, so it must
	 * say nothing. */
	const run = (
		payload: Record<string, unknown>,
		env: Record<string, string> = {},
	) => {
		const r = runCore("record-tool-echo", payload, {
			root: dir,
			env,
			event: "PostToolUse",
		});
		expect(r.output).toBeNull();
		logs.push(...r.logs);
	};

	/** One completed call recorded. */
	const record = (
		input: Record<string, unknown>,
		response: unknown,
		{
			tool = "Bash",
			env,
		}: { tool?: string; env?: Record<string, string> } = {},
	) =>
		run(
			{
				session_id: "s1",
				tool_name: tool,
				tool_input: input,
				...(response === undefined ? {} : { tool_response: response }),
			},
			env,
		);

	const store = (name = "s1.main") => path.join(tmp, "wfc-echo-chain", name);

	/** The record the reader finds for a call, signed as the guard signs it. */
	const found = (input: Record<string, unknown>, tool = "Bash") => {
		const text = fs.existsSync(store()) ? fs.readFileSync(store(), "utf8") : "";
		const sig = chain.callSignature(
			tool,
			input,
			host.buildHostPorts(dir, (w) => logs.push(w)).fileState,
		);
		return chain.lookup(text, sig, Math.floor(Date.now() / 1000));
	};
	const runOf = (input: Record<string, unknown>, tool = "Bash") =>
		found(input, tool)?.run ?? null;

	/* Real payloads, captured at mantahostels#2616: the short circuit is a
	 * different shape from the real read, `type: "file_unchanged"` and no
	 * `content`. */
	const ReadInput = { file_path: "/repo/.claude/tmp/echo-target.txt" };
	const ReadFirst = {
		type: "text",
		file: {
			filePath: "/repo/.claude/tmp/echo-target.txt",
			content: "alpha\nbeta\ngamma\n",
			numLines: 4,
			startLine: 1,
			totalLines: 4,
		},
	};
	const ReadUnchanged = {
		type: "file_unchanged",
		file: { filePath: "/repo/.claude/tmp/echo-target.txt" },
	};

	it("extends a run on an identical response and resets it on a differing one", () => {
		record(Ls, Same);
		record(Ls, Same);
		expect(runOf(Ls)).toBe(2);
		record(Ls, { stdout: "2 passed" });
		expect(runOf(Ls)).toBe(1);
	});

	/* Keys sorted by UTF-8 bytes where JS sorts by UTF-16 units, a DEL, and
	 * nesting: the recorder files the call where the reader looks it up. */
	it("files an awkward input where the reader looks it up", () => {
		const input = {
			"\u{1F600}": 1,
			"～": [{ z: "\x7f", a: 1.5 }],
			command: "printf '\x7f'",
			B: { y: null, x: true },
		};
		const answer = { stdout: "\x7f é \u{1F600}", nested: { b: 1, a: [2] } };
		record(input, answer);
		record(input, answer);
		expect(runOf(input)).toBe(2);
	});

	it("hashes a plain string response, an empty one included", () => {
		const empty = { command: "empty" };
		for (let i = 0; i < 2; i++) {
			record(Ls, "same text");
			record(empty, "");
		}
		expect([runOf(Ls), runOf(empty)]).toEqual([2, 2]);
	});

	it("treats a missing response as no evidence, writing nothing", () => {
		record(Ls, undefined);
		record(Ls, undefined);
		expect(fs.existsSync(store())).toBe(false);
	});

	it("folds a Read's short circuit into the run, and only a Read's", () => {
		record(ReadInput, ReadFirst, { tool: "Read" });
		record(ReadInput, ReadUnchanged, { tool: "Read" });
		expect(runOf(ReadInput, "Read")).toBe(2);
		record(
			ReadInput,
			{ ...ReadFirst, file: { ...ReadFirst.file, content: "delta\n" } },
			{ tool: "Read" },
		);
		expect(runOf(ReadInput, "Read")).toBe(1);
		record(Ls, ReadFirst);
		record(Ls, ReadUnchanged);
		expect(runOf(Ls)).toBe(1);
	});

	it("folds onto a chain the guard cleared, its denies carried", () => {
		const sig = chain.signature("Read", ReadInput, null);
		const now = Math.floor(Date.now() / 1000);
		fs.mkdirSync(path.dirname(store()), { recursive: true });
		fs.writeFileSync(
			store(),
			chain.storeText([], {
				sig,
				hash: chain.EC_CLEARED,
				run: 0,
				at: now,
				denies: 1,
			}),
		);
		record(ReadInput, ReadUnchanged, { tool: "Read" });
		record(ReadInput, ReadUnchanged, { tool: "Read" });
		expect(found(ReadInput, "Read")).toMatchObject({
			hash: chain.EC_CLEARED,
			run: 2,
			denies: 1,
		});
	});

	it("drops an expired record, so the next identical call starts a run of one", () => {
		record(Ls, Same);
		record(Ls, Same);
		const aged = fs
			.readFileSync(store(), "utf8")
			.replace(
				/\t(\d+)\t(\d+)\n$/,
				(_m, at, d) => `\t${Number(at) - 7200}\t${d}\n`,
			);
		fs.writeFileSync(store(), aged);
		record(Ls, Same);
		expect(runOf(Ls)).toBe(1);
	});

	it("writes the file chainName names, for a session holding a dot and a subagent", () => {
		run({
			session_id: "s.1",
			agent_id: "../x y",
			tool_name: "Bash",
			tool_input: Ls,
			tool_response: Same,
		});
		expect(fs.existsSync(store("s_1.a___x_y"))).toBe(true);
	});

	it("files an empty agent_id's answers under the parent", () => {
		run({
			session_id: "s1",
			agent_id: "",
			tool_name: "Bash",
			tool_input: Ls,
			tool_response: Same,
		});
		expect(runOf(Ls)).toBe(1);
	});

	it("skips the neighbour's shapes, and every tool but Bash and Read", () => {
		record({ command: "sleep 5; ls" }, Same);
		record({ command: "true" }, Same);
		record(Ls, Same, { tool: "ListAgents" });
		expect(fs.existsSync(store())).toBe(false);
	});

	it("trims the store to the newest 200 records, its own kept", () => {
		const now = Math.floor(Date.now() / 1000);
		fs.mkdirSync(path.dirname(store()), { recursive: true });
		fs.writeFileSync(
			store(),
			Array.from(
				{ length: 259 },
				(_, i) => `preseed${i}\thash${i}\t1\t${now}\t0\n`,
			).join(""),
		);
		record(Ls, Same);
		const lines = fs.readFileSync(store(), "utf8").trim().split("\n");
		expect(lines).toHaveLength(200);
		expect(lines.at(-1)?.startsWith("preseed")).toBe(false);
	});

	it("records nothing under WFC_NO_ECHO_CHAIN=1", () => {
		record(Ls, Same, { env: { WFC_NO_ECHO_CHAIN: "1" } });
		expect(fs.existsSync(store())).toBe(false);
	});

	it("records nothing for a payload carrying no session, on the record", () => {
		run({ tool_name: "Bash", tool_input: Ls, tool_response: Same });
		expect(fs.existsSync(path.join(tmp, "wfc-echo-chain"))).toBe(false);
		expect(logs.join("\n")).toContain("echo record allowed unchecked");
	});

	it("takes over a crashed holder's `<file>.dlock` and leaves none", () => {
		record(Ls, Same);
		const lock = `${store()}.dlock`;
		fs.mkdirSync(lock);
		const old = Date.now() / 1000 - 60;
		fs.utimesSync(lock, old, old);
		record(Ls, Same);
		expect(fs.existsSync(lock)).toBe(false);
		expect(runOf(Ls)).toBe(2);
	});

	it.skipIf(process.getuid?.() === 0)(
		"records a write it could not make, on the record",
		() => {
			record(Ls, Same);
			fs.chmodSync(path.dirname(store()), 0o500);
			try {
				record(Ls, Same);
			} finally {
				fs.chmodSync(path.dirname(store()), 0o700);
			}
			expect(logs.join("\n")).toContain("could not write the chain store");
		},
	);

	/* A chain that cannot be read is a broken clock: restarting it at 1 would
	 * disarm the guard, so the record is left as it was. */
	it.skipIf(process.getuid?.() === 0)(
		"leaves an unreadable chain alone, on the record",
		() => {
			record(Ls, Same);
			const before = fs.readFileSync(store(), "utf8");
			fs.chmodSync(store(), 0o000);
			try {
				record(Ls, Same);
			} finally {
				fs.chmodSync(store(), 0o600);
			}
			expect(logs.join("\n")).toContain("could not read the chain store");
			expect(fs.readFileSync(store(), "utf8")).toBe(before);
		},
	);
});
