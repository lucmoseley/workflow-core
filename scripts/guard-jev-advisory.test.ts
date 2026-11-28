// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFile } from "./lib/core-path-testkit";
import { keptSpawn } from "./lib/kept-spawn.js";
import { noop } from "./lib/noop.js";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";
import { copyLibs, readProgramLibs } from "./lib-closure-fixture";

const hookBlock = createRequire(__filename)("./lib/hook-block.js");

const GUARD = path.join(__dirname, "guard-jev-advisory.js");
const REPORTER = path.join(__dirname, "check-jev-flags.js");

let dir: string;
let sid: string;
let servers: Server[];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-advisory-"));
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
	servers = [];
});

afterEach(async () => {
	for (const s of servers)
		await new Promise<void>((r) => {
			s.closeAllConnections();
			s.close(() => r());
		});
	fs.rmSync(dir, { recursive: true, force: true });
});

interface LogLine {
	at: string;
	session: string;
	outcome: string;
	why?: string;
	confidence?: number;
	latencyMs?: number;
	retries?: number;
	model?: string;
	provider?: string;
	questionHash?: string;
	messageLen: number;
	messageHash: string;
	messageText?: string;
}

interface Seen {
	url: string;
	method: string;
	body: Record<string, unknown>;
}

// lucmoseley/mantahostels#1798
function marker(name: string): string {
	const markers = path.join(dir, ".claude", "tmp", "markers");
	fs.mkdirSync(markers, { recursive: true });
	return path.join(markers, name);
}

function readLogLines(): LogLine[] {
	const file = marker(".jev-advisory-log.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

async function stub(
	handler: (
		body: Record<string, unknown>,
		res: ServerResponse,
		req: IncomingMessage,
	) => void,
): Promise<string> {
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => handler(JSON.parse(raw || "{}"), res, req));
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const addr = server.address();
	if (typeof addr === "string" || addr === null)
		throw new Error("the stub did not take a port");
	return `http://127.0.0.1:${addr.port}`;
}

function answerWith(res: ServerResponse, probability: number) {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			answers: { puts_choice: { type: "boolean", probability } },
		}),
	);
}

async function answering(probability: number): Promise<{
	base: string;
	asks: Seen[];
}> {
	const asks: Seen[] = [];
	const base = await stub((body, res, req) => {
		asks.push({ url: req.url ?? "", method: req.method ?? "", body });
		answerWith(res, probability);
	});
	return { base, asks };
}

async function run(text: string, env: NodeJS.ProcessEnv = {}) {
	const base: NodeJS.ProcessEnv = {
		...process.env,
		WFC_REPO_ROOT: dir,
		WFC_SECRETS_FILE: path.join(dir, "workflow-core", "secrets.env"),
	};
	for (const k of [
		"AI_GATEWAY_API_KEY",
		"WFC_JEV_ADVISORY",
		"WFC_JEV_BASE_URL",
		"WFC_JEV_ABORT_MS",
		"WFC_JEV_SWEEP_MS",
	])
		delete base[k];
	const res = await runInProcessAsync(GUARD, [], {
		stdin: JSON.stringify({
			hook_event_name: "Stop",
			session_id: sid,
			last_assistant_message: text,
			transcript_path: path.join(dir, "absent.jsonl"),
		}),
		cwd: dir,
		env: { ...base, ...env },
	});
	expect(res.status).toBe(0);
	return res;
}

function gitleaksStub(code: number): string {
	const file = path.join(dir, `gitleaks-exit-${code}`);
	// #227
	fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nexit ${String(code)}\n`, {
		mode: 0o755,
	});
	return file;
}

function callable(base: string, extra: NodeJS.ProcessEnv = {}) {
	return {
		AI_GATEWAY_API_KEY: "test-key",
		WFC_JEV_BASE_URL: base,
		WFC_GITLEAKS: gitleaksStub(0),
		...extra,
	};
}

// #239
const HAS_GITLEAKS =
	spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0;

async function ask(text: string, probability: number, extra = {}) {
	const { base, asks } = await answering(probability);
	const res = await run(text, callable(base, extra));
	return { res, asks };
}

// #174
const UNREACHABLE = "http://127.0.0.1:1";

const ABORT_MS = 3000;

const ATTEMPTS = 2;

// #1024 guess
const SHORT_ABORT_MS = 500;
const SHORT_ABORT = { WFC_JEV_ABORT_MS: String(SHORT_ABORT_MS) };

const neverAnswers = noop;

async function outcomeOf(
	text: string,
	env: NodeJS.ProcessEnv = {},
): Promise<string> {
	await run(text, env);
	const lines = readLogLines();
	expect(lines).toHaveLength(1);
	return lines[0].outcome;
}

function configWithDisabled(entries: string[]) {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			founder: "A Founder",
			tracker: "owner/repo",
			disabled: entries,
		}),
	);
}

function saidBy(res: { stdout: string }): string {
	if (!res.stdout) return "";
	const parsed = JSON.parse(res.stdout);
	expect(parsed).not.toHaveProperty("decision");
	return String(parsed.systemMessage ?? "");
}

const PLAIN = "Two ways to take this. Rebuild the index, or leave it stale.";
const ROUND =
	"❓ **Q1** Which way?\n\n(A) Rebuild\nConfidence: 60% (50% - 70%). Cheap.";

const WITH_SECRET = `Two ways to take this, and the key is AKIA${"Z3XQ7LMNB4RTVKWD"} — pick one.`;

describe("the round-marker gate", () => {
	it("skips a message the other guard already owns", async () => {
		expect(await outcomeOf(ROUND)).toBe("skipped-marker");
	});

	it("takes the marker gate first, before every other limb", async () => {
		// #200
		expect(await outcomeOf(ROUND, { WFC_JEV_ADVISORY: "0" })).toBe(
			"skipped-marker",
		);
	});

	it("never calls the vendor on a message carrying a round marker", async () => {
		const { res, asks } = await ask(ROUND, 0.99);
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(readLogLines()[0].outcome).toBe("skipped-marker");
	});
});

describe("the master switch", () => {
	it("skips when the check name is in the disabled list", async () => {
		configWithDisabled(["jev-advisory"]);
		expect(await outcomeOf(PLAIN)).toBe("skipped-disabled");
	});

	it.each(["0", "false", "OFF"])(
		"skips on WFC_JEV_ADVISORY=%s",
		async (value) => {
			expect(await outcomeOf(PLAIN, { WFC_JEV_ADVISORY: value })).toBe(
				"skipped-disabled",
			);
		},
	);

	it("runs on an override that does not spell 'off'", async () => {
		expect(await outcomeOf(PLAIN, { WFC_JEV_ADVISORY: "1" })).toBe(
			"skipped-no-sdk",
		);
	});

	it("sends nothing and says nothing while the switch is set", async () => {
		const { res, asks } = await ask(PLAIN, 0.99, { WFC_JEV_ADVISORY: "0" });
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(readLogLines()[0].outcome).toBe("skipped-disabled");
	});

	it("logs nothing at all when the script basename is disabled instead", async () => {
		configWithDisabled(["guard-jev-advisory.js"]);
		await run(PLAIN);
		expect(readLogLines()).toEqual([]);
	});
});

describe("the warn budget", () => {
	it("skips once the session's warns are spent", async () => {
		fs.writeFileSync(
			marker(`.jev-advisory-nagged-${sid}`),
			`${hookBlock.MAX_BLOCKS}\n`,
		);
		expect(await outcomeOf(PLAIN)).toBe("skipped-budget");
	});

	it("runs while the budget is only part spent", async () => {
		fs.writeFileSync(
			marker(`.jev-advisory-nagged-${sid}`),
			`${hookBlock.MAX_BLOCKS - 1}\n`,
		);
		expect(await outcomeOf(PLAIN)).toBe("skipped-no-sdk");
	});

	it("is spent by a flag and by nothing else", async () => {
		const counter = marker(`.jev-advisory-nagged-${sid}`);
		await ask(PLAIN, 0.2);
		expect(fs.existsSync(counter)).toBe(false);
		await ask(PLAIN, 0.9);
		expect(fs.readFileSync(counter, "utf8").trim()).toBe("1");
	});
});

describe("no rate gate (#703)", () => {
	it("checks a second turn straight after the first", async () => {
		const { base, asks } = await answering(0.2);
		const env = callable(base);
		await run(PLAIN, env);
		await run(`${PLAIN} Again.`, env);
		expect(asks).toHaveLength(2);
		expect(readLogLines().map((l) => l.outcome)).toEqual(["clear", "clear"]);
	});
});

describe("the vendor gate", () => {
	it("skips because the key is absent, naming which half was missing", async () => {
		await run(PLAIN);
		expect(readLogLines()[0].why).toBe("key");
	});

	it("skips with no throw where the SDK itself is unreachable", async () => {
		const bin = path.join(dir, "scripts");
		copyLibs(path.join(bin, "lib"), readProgramLibs("guard-jev-advisory.js"));
		fs.copyFileSync(GUARD, path.join(bin, "guard-jev-advisory.js"));

		const res = keptSpawn("boundary").spawnSync(
			process.execPath,
			[path.join(bin, "guard-jev-advisory.js")],
			{
				input: JSON.stringify({
					hook_event_name: "Stop",
					session_id: sid,
					last_assistant_message: PLAIN,
					transcript_path: path.join(dir, "absent.jsonl"),
				}),
				cwd: dir,
				encoding: "utf8",
				env: {
					...process.env,
					WFC_REPO_ROOT: dir,
					AI_GATEWAY_API_KEY: "test-key",
					WFC_GITLEAKS: gitleaksStub(0),
				},
			},
		);
		expect(res.status).toBe(0);
		expect(res.stdout).toBe("");
		expect(res.stderr).toBe("");
		expect(readLogLines()).toHaveLength(1);
		expect(readLogLines()[0].outcome).toBe("skipped-no-sdk");
		expect(readLogLines()[0].why).toBe("sdk");
	}, 20_000);

	it("takes the key from the secrets file where the environment has none", async () => {
		fs.mkdirSync(path.join(dir, "workflow-core"));
		fs.writeFileSync(
			path.join(dir, "workflow-core", "secrets.env"),
			'AI_GATEWAY_API_KEY="from-the-file"\n',
		);
		const { base, asks } = await answering(0.9);
		await run(PLAIN, { WFC_JEV_BASE_URL: base });
		expect(asks).toHaveLength(1);
		expect(readLogLines()[0].outcome).toBe("flagged");
	});

	it("prefers the environment over the secrets file", async () => {
		fs.mkdirSync(path.join(dir, "workflow-core"));
		fs.writeFileSync(
			path.join(dir, "workflow-core", "secrets.env"),
			"AI_GATEWAY_API_KEY=from-the-file\n",
		);
		const { base, asks } = await answering(0.9);
		await run(PLAIN, {
			AI_GATEWAY_API_KEY: "from-the-environment",
			WFC_JEV_BASE_URL: base,
		});
		expect(asks).toHaveLength(1);
	});

	it("writes the key nowhere — not the log, not the advisory line", async () => {
		const { res } = await ask(PLAIN, 0.9, {
			AI_GATEWAY_API_KEY: "sk-a-very-distinctive-key",
		});
		const raw = fs.readFileSync(marker(".jev-advisory-log.jsonl"), "utf8");
		expect(raw).not.toContain("sk-a-very-distinctive-key");
		expect(res.stdout).not.toContain("sk-a-very-distinctive-key");
	});
});

describe.skipIf(!HAS_GITLEAKS)("the redaction sweep", () => {
	it("sends nothing where gitleaks finds a secret in the message", async () => {
		const { res, asks } = await ask(WITH_SECRET, 0.99, {
			WFC_GITLEAKS: "gitleaks",
		});
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(readLogLines()[0].outcome).toBe("skipped-redaction");
		expect(readLogLines()[0].why).toBe("finding");
	});

	it("runs the sweep before every egress, not only the first", async () => {
		const { base } = await answering(0.9);
		const env = callable(base, { WFC_GITLEAKS: "gitleaks" });
		await run(PLAIN, env);
		await run(WITH_SECRET, env);
		expect(readLogLines().map((l) => l.outcome)).toEqual([
			"flagged",
			"skipped-redaction",
		]);
	});

	it("writes the message nowhere on disk, clean or not", async () => {
		const tmp = path.join(dir, ".claude", "tmp");
		fs.mkdirSync(tmp, { recursive: true });
		await ask(PLAIN, 0.9, { WFC_GITLEAKS: "gitleaks" });
		await ask(WITH_SECRET, 0.9, { WFC_GITLEAKS: "gitleaks" });
		const holding = fs
			.readdirSync(tmp, { withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => fs.readFileSync(path.join(tmp, e.name), "utf8"))
			.filter((text) => text.includes(PLAIN) || text.includes(WITH_SECRET));
		expect(holding).toEqual([]);
	});

	it("passes the message on stdin rather than as a path argument", async () => {
		const seen = path.join(dir, "sweep-argv.txt");
		const stdinSeen = path.join(dir, "sweep-stdin.txt");
		const recorder = path.join(dir, "gitleaks-recorder");
		fs.writeFileSync(
			recorder,
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(seen)}\ncat > ${shellQuote(stdinSeen)}\nexit 0\n`,
			{ mode: 0o755 },
		);
		await ask(PLAIN, 0.2, { WFC_GITLEAKS: recorder });
		expect(fs.readFileSync(seen, "utf8").trim().split("\n")[0]).toBe("stdin");
		expect(fs.readFileSync(stdinSeen, "utf8")).toBe(PLAIN);
		expect(fs.readFileSync(seen, "utf8")).not.toContain(".claude/tmp");
	});
});

describe("a machine with no gitleaks", () => {
	it("treats the absent binary as a finding and sends nothing", async () => {
		const { res, asks } = await ask(PLAIN, 0.99, {
			WFC_GITLEAKS: path.join(dir, "no-such-gitleaks"),
		});
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(readLogLines()[0].outcome).toBe("skipped-redaction");
		expect(readLogLines()[0].why).toBe("unswept");
	});

	it("treats a sweep that never returns as a finding", async () => {
		const hang = path.join(dir, "gitleaks-hang");
		fs.writeFileSync(hang, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
		const { res, asks } = await ask(PLAIN, 0.99, {
			WFC_GITLEAKS: hang,
			WFC_JEV_SWEEP_MS: "500",
		});
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(readLogLines()[0].outcome).toBe("skipped-redaction");
		expect(readLogLines()[0].why).toBe("unswept");
	}, 20_000);
});

// #227
describe("a gitleaks too old to carry `stdin`", () => {
	function refusesEverything(): string {
		const file = path.join(dir, "gitleaks-no-stdin");
		fs.writeFileSync(file, "#!/bin/sh\ncat >/dev/null\nexit 1\n", {
			mode: 0o755,
		});
		return file;
	}

	it("sends nothing and logs the sweep as unswept, not as a finding", async () => {
		const { res, asks } = await ask(PLAIN, 0.99, {
			WFC_GITLEAKS: refusesEverything(),
		});
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(readLogLines()[0].outcome).toBe("skipped-redaction");
		expect(readLogLines()[0].why).toBe("unswept");
	});

	it("still calls a real finding a finding, the probe coming back clean", async () => {
		const file = path.join(dir, "gitleaks-finds");
		fs.writeFileSync(
			file,
			'#!/bin/sh\nif [ -n "$(cat)" ]; then exit 1; fi\nexit 0\n',
			{ mode: 0o755 },
		);
		const { res, asks } = await ask(PLAIN, 0.99, { WFC_GITLEAKS: file });
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(readLogLines()[0].outcome).toBe("skipped-redaction");
		expect(readLogLines()[0].why).toBe("finding");
	});
});

describe("what the vendor is asked", () => {
	it("posts the spike's question, verbatim, to the evaluation endpoint", async () => {
		const { asks } = await ask(PLAIN, 0.9);
		expect(asks).toHaveLength(1);
		expect(asks[0].method).toBe("POST");
		expect(asks[0].url).toBe("/evaluation-model");
		expect(asks[0].body.state).toBe(PLAIN);
	});

	it("asks one boolean question with both criteria spelled out", async () => {
		const { asks } = await ask(PLAIN, 0.9);
		const questions = asks[0].body.questions as Record<
			string,
			{ type: string; instructions: string; criteria: object }
		>;
		const q = questions.puts_choice;
		expect(Object.keys(questions)).toEqual(["puts_choice"]);
		expect(q.type).toBe("boolean");
		expect(q.instructions).toContain(
			"two or more alternative courses of action offered for the founder to pick between",
		);
		expect(Object.keys(q.criteria).sort()).toEqual(["false", "true"]);
	});

	it("sends the message text and nothing else about the session", async () => {
		const { asks } = await ask(PLAIN, 0.9);
		expect(Object.keys(asks[0].body).sort()).toEqual([
			"providerOptions",
			"questions",
			"state",
		]);
		expect(JSON.stringify(asks[0].body)).not.toContain(sid);
	});
});

describe("what answered (#702)", () => {
	async function naming(model: string, provider: string) {
		return stub((_body, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					answers: { puts_choice: { type: "boolean", probability: 0.2 } },
					model,
					providerMetadata: {
						gateway: { routing: { finalProvider: provider } },
					},
				}),
			);
		});
	}

	it("logs the model and provider the reply names, and the question digest", async () => {
		await run(PLAIN, callable(await naming("typesafe-ai/jev", "digitalocean")));
		expect(readLogLines()[0]).toMatchObject({
			outcome: "clear",
			model: "typesafe-ai/jev",
			provider: "digitalocean",
		});
		expect(readLogLines()[0].questionHash).toMatch(/^[0-9a-f]{12}$/);
	});

	it("falls back to the id asked for where the reply names no model", async () => {
		await ask(PLAIN, 0.9);
		const [line] = readLogLines();
		expect(line.outcome).toBe("flagged");
		expect(line.model).toBe("typesafe-ai/jev");
		expect(line.provider).toBeUndefined();
	});

	it("digests the question set the same way on every turn", async () => {
		await ask(PLAIN, 0.2);
		await ask(`${PLAIN} Again.`, 0.9);
		const [a, b] = readLogLines();
		expect(a.questionHash).toBe(b.questionHash);
	});

	it("puts the digest and no model on an outage", async () => {
		await run(PLAIN, callable(UNREACHABLE));
		const [line] = readLogLines();
		expect(line.outcome).toBe("outage");
		expect(line.questionHash).toMatch(/^[0-9a-f]{12}$/);
		expect(line.model).toBeUndefined();
	});

	it("puts the digest and no model on a reply the SDK could not read", async () => {
		await run(PLAIN, callable(await malformedStub()));
		const [line] = readLogLines();
		expect(line.outcome).toBe("malformed");
		expect(line.questionHash).toMatch(/^[0-9a-f]{12}$/);
		expect(line.model).toBeUndefined();
	});

	it("puts neither on a turn that never reached the vendor", async () => {
		await run(PLAIN);
		const [line] = readLogLines();
		expect(line.outcome).toBe("skipped-no-sdk");
		expect(line.questionHash).toBeUndefined();
		expect(line.model).toBeUndefined();
	});
});

describe("a flagged turn", () => {
	it("says exactly one systemMessage and carries no decision field", async () => {
		const { res } = await ask(PLAIN, 0.91);
		expect(saidBy(res)).toContain("JEV ADVISORY");
		expect(res.stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(res.stderr).toBe("");
	});

	it("carries the hash the log names it by, and the verdict command", async () => {
		// #253
		const { res } = await ask(PLAIN, 0.91);
		const { messageHash } = readLogLines()[0];

		expect(saidBy(res)).toContain(
			`node ${coreFile("scripts/jev-verdict.js")} ${messageHash} right|wrong`,
		);
	});

	it("logs the confidence to two decimals, as a number", async () => {
		await ask(PLAIN, 0.912_34);
		const [line] = readLogLines();
		expect(line.outcome).toBe("flagged");
		expect(line.confidence).toBe(0.91);
		expect(typeof line.confidence).toBe("number");
	});

	it("logs the latency as the time the vendor took to answer", async () => {
		// #2102
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const base = await stub((_body, res) => {
				vi.setSystemTime(Date.now() + 250);
				answerWith(res, 0.9);
			});
			await run(PLAIN, callable(base));
		} finally {
			vi.useRealTimers();
		}
		expect(readLogLines()[0].latencyMs).toBe(250);
	});

	it("renders as check-jev-flags.js's p= suffix", async () => {
		// #204
		await ask(PLAIN, 0.91);
		const report = runInProcess(REPORTER, ["--root", dir], {
			cwd: dir,
			env: {
				...process.env,
				WFC_REPO_ROOT: dir,
				CLAUDE_PROJECT_DIR: dir,
				WFC_NOTIFY_PERSIST: "",
			},
		});
		expect(`${report.stdout}${report.stderr}`).toContain("p=0.91");
	});
});

describe("a clear turn", () => {
	it("says nothing at all", async () => {
		const { res } = await ask(PLAIN, 0.12);
		expect(res.stdout).toBe("");
		expect(res.stderr).toBe("");
	});

	it("still logs the confidence, so the sample is not only the flags", async () => {
		await ask(PLAIN, 0.12);
		const [line] = readLogLines();
		expect(line.outcome).toBe("clear");
		expect(line.confidence).toBe(0.12);
	});

	it("reads the answer out at 0.5 before the log rounds it", async () => {
		await ask(PLAIN, 0.499);
		expect(readLogLines()[0].outcome).toBe("clear");
		expect(readLogLines()[0].confidence).toBe(0.5);
	});
});

describe("an outage", () => {
	it("gives up inside the abort ceiling on a stub that never answers", async () => {
		const base = await stub(neverAnswers);
		const t0 = Date.now();
		const res = await run(PLAIN, callable(base, SHORT_ABORT));
		const elapsed = Date.now() - t0;
		expect(readLogLines()[0].outcome).toBe("outage");
		expect(saidBy(res)).toContain("could not reach its vendor");
		// #1885
		expect(elapsed).toBeGreaterThanOrEqual(SHORT_ABORT_MS * ATTEMPTS);
		expect(elapsed).toBeLessThan(ABORT_MS * ATTEMPTS);
	}, 20_000);

	it("hangs the full `ABORT_MS` per attempt where no override is set", async () => {
		const base = await stub(neverAnswers);
		const t0 = Date.now();
		await run(PLAIN, callable(base));
		// #1885
		expect(Date.now() - t0).toBeGreaterThanOrEqual(ABORT_MS * ATTEMPTS);
		expect(readLogLines()[0].outcome).toBe("outage");
	}, 20_000);

	it("reads an unreachable host as an outage, and says so", async () => {
		const res = await run(PLAIN, callable(UNREACHABLE));
		expect(readLogLines()[0].outcome).toBe("outage");
		expect(saidBy(res)).toContain("could not reach its vendor");
	});

	it("treats an error status as an outage rather than an answer", async () => {
		const base = await stub((_body, res) => {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "upstream is unwell" } }));
		});
		await run(PLAIN, callable(base));
		expect(readLogLines()[0].outcome).toBe("outage");
	});

	it("notices once a session and logs every time after", async () => {
		const env = callable(UNREACHABLE);
		const first = await run(PLAIN, env);
		const second = await run(PLAIN, env);
		expect(saidBy(first)).toContain("could not reach its vendor");
		expect(saidBy(second)).toBe("");
		expect(readLogLines().map((l) => l.outcome)).toEqual(["outage", "outage"]);
	});

	it("spends its own counter and never the warn budget", async () => {
		await run(PLAIN, callable(UNREACHABLE));
		expect(
			fs.readFileSync(marker(`.jev-advisory-outage-${sid}`), "utf8").trim(),
		).toBe("1");
		expect(fs.existsSync(marker(`.jev-advisory-nagged-${sid}`))).toBe(false);
	});
});

// #255
describe("a turn the abort killed", () => {
	async function hangingThenAnswering(hangs: number, probability: number) {
		const seen = { count: 0 };
		const base = await stub((_body, res) => {
			seen.count++;
			if (seen.count <= hangs) return;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					answers: { puts_choice: { type: "boolean", probability } },
				}),
			);
		});
		return { base, seen };
	}

	it("re-asks once and logs the answer the second attempt gave", async () => {
		const { base, seen } = await hangingThenAnswering(1, 0.91);

		const res = await run(PLAIN, callable(base, SHORT_ABORT));

		expect(seen.count).toBe(2);
		expect(readLogLines()).toHaveLength(1);
		expect(readLogLines()[0].outcome).toBe("flagged");
		expect(readLogLines()[0].retries).toBe(1);
		expect(saidBy(res)).toContain("JEV ADVISORY");
	}, 20_000);

	it("counts the re-ask against no outage at all", async () => {
		const { base } = await hangingThenAnswering(1, 0.1);

		await run(PLAIN, callable(base, SHORT_ABORT));

		expect(readLogLines()[0].outcome).toBe("clear");
		expect(fs.existsSync(marker(`.jev-advisory-outage-${sid}`))).toBe(false);
	}, 20_000);

	it("re-asks no more than once, and says so on the outage", async () => {
		const { base, seen } = await hangingThenAnswering(9, 0.91);

		await run(PLAIN, callable(base, SHORT_ABORT));

		expect(seen.count).toBe(ATTEMPTS);
		expect(readLogLines()[0].outcome).toBe("outage");
		expect(readLogLines()[0].retries).toBe(ATTEMPTS - 1);
	}, 20_000);

	it("never re-asks a failure the abort did not cause", async () => {
		await run(PLAIN, callable(UNREACHABLE));

		expect(readLogLines()[0].outcome).toBe("outage");
		expect(readLogLines()[0].retries).toBeUndefined();
	});

	it("never re-asks a reply it simply could not read", async () => {
		const base = await stub((_body, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({ answers: { puts_choice: { type: "boolean" } } }),
			);
		});

		await run(PLAIN, callable(base));

		expect(readLogLines()[0].outcome).toBe("malformed");
		expect(readLogLines()[0].retries).toBeUndefined();
	});
});

describe("the abort budget's override (#1024)", () => {
	const slowMs = 1200;

	async function answeringSlowly(afterMs: number) {
		return stub((_body, res) => {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						answers: { puts_choice: { type: "boolean", probability: 0.1 } },
					}),
				);
			}, afterMs);
		});
	}

	const pastAnyMisread = 500;

	it.each([
		["", pastAnyMisread],
		[" ", pastAnyMisread],
		["0", pastAnyMisread],
		["-250", pastAnyMisread],
		["250ms", pastAnyMisread],
		["2.5", pastAnyMisread],
		["1e3", slowMs],
		["0x10", pastAnyMisread],
	])("ignores %j and keeps `ABORT_MS`", async (raw, answerAfterMs) => {
		await run(
			PLAIN,
			callable(await answeringSlowly(answerAfterMs), {
				WFC_JEV_ABORT_MS: raw,
			}),
		);
		expect(readLogLines()[0].outcome).toBe("clear");
	});

	it("takes a positive whole number of milliseconds", async () => {
		await run(
			PLAIN,
			callable(await answeringSlowly(slowMs), { WFC_JEV_ABORT_MS: " 250 " }),
		);
		expect(readLogLines()[0].outcome).toBe("outage");
	});

	it("caps a value above `ABORT_MS` at it", async () => {
		const pastTheCapMs = ABORT_MS + 1500;
		let asked = 0;
		const base = await stub((_body, res) => {
			asked++;
			setTimeout(() => answerWith(res, 0.1), asked === 1 ? pastTheCapMs : 0);
		});
		// #1885
		await run(PLAIN, callable(base, { WFC_JEV_ABORT_MS: "60000" }));
		expect(asked).toBe(ATTEMPTS);
		expect(readLogLines()[0].outcome).toBe("clear");
		expect(readLogLines()[0].retries).toBe(1);
	}, 20_000);
});

async function refusingStub(status: number): Promise<string> {
	return stub((_body, res) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				error: { message: "Invalid API key", type: "authentication_error" },
			}),
		);
	});
}

describe("a refused key (#4144)", () => {
	it.each([401, 403])(
		"logs a %i as refused and never as an outage",
		async (status) => {
			await run(PLAIN, callable(await refusingStub(status)));
			const outcomes = readLogLines().map((l) => l.outcome);
			expect(outcomes).toEqual(["refused"]);
		},
	);

	it("names the fix rather than an unreachable vendor", async () => {
		const res = await run(PLAIN, callable(await refusingStub(401)));
		expect(saidBy(res)).toContain("refused its key");
		expect(saidBy(res)).toContain("write-secret.js");
		expect(saidBy(res)).not.toContain("could not reach its vendor");
	});

	it("spends its own counter and neither the outage nor the warn budget", async () => {
		await run(PLAIN, callable(await refusingStub(401)));
		expect(
			fs.readFileSync(marker(`.jev-advisory-refused-${sid}`), "utf8").trim(),
		).toBe("1");
		expect(fs.existsSync(marker(`.jev-advisory-outage-${sid}`))).toBe(false);
		expect(fs.existsSync(marker(`.jev-advisory-nagged-${sid}`))).toBe(false);
	});

	it("notices once a session and logs every time after", async () => {
		const env = callable(await refusingStub(401));
		const first = await run(PLAIN, env);
		const second = await run(PLAIN, env);
		expect(saidBy(first)).toContain("refused its key");
		expect(saidBy(second)).toBe("");
		expect(readLogLines().map((l) => l.outcome)).toEqual([
			"refused",
			"refused",
		]);
	});
});

// #226
async function malformedStub(body: unknown = { answers: {} }): Promise<string> {
	return stub((_body, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	});
}

describe("a malformed reply", () => {
	it.each([
		["answers that match no question", { answers: {} }],
		[
			"a probability of the wrong type",
			{ answers: { puts_choice: { type: "boolean", probability: "0.9" } } },
		],
		["a body with no answers at all", { wat: 1 }],
	])("is its own outcome on %s", async (_name, body) => {
		await run(PLAIN, callable(await malformedStub(body)));
		expect(readLogLines()[0].outcome).toBe("malformed");
	});

	it("says it is a repo fix rather than an outage", async () => {
		const res = await run(PLAIN, callable(await malformedStub()));
		expect(saidBy(res)).toContain("cannot read");
		expect(saidBy(res)).not.toContain("could not reach its vendor");
	});

	it("spends neither the warn budget nor the outage counter", async () => {
		await run(PLAIN, callable(await malformedStub()));
		expect(
			fs.readFileSync(marker(`.jev-advisory-malformed-${sid}`), "utf8").trim(),
		).toBe("1");
		expect(fs.existsSync(marker(`.jev-advisory-outage-${sid}`))).toBe(false);
		expect(fs.existsSync(marker(`.jev-advisory-nagged-${sid}`))).toBe(false);
	});

	it("notices once a session and logs every time after", async () => {
		const env = callable(await malformedStub());
		const first = await run(PLAIN, env);
		const second = await run(PLAIN, env);
		expect(saidBy(first)).toContain("cannot read");
		expect(saidBy(second)).toBe("");
		expect(readLogLines().map((l) => l.outcome)).toEqual([
			"malformed",
			"malformed",
		]);
	});

	it("never claims an unreachable host answered", async () => {
		await run(PLAIN, callable(UNREACHABLE));
		expect(readLogLines()[0].outcome).toBe("outage");
		expect(fs.existsSync(marker(`.jev-advisory-malformed-${sid}`))).toBe(false);
	});

	it("calls a socket dropped mid-answer an outage", async () => {
		const base = await stub((_body, res) => {
			res.writeHead(200, {
				"content-type": "application/json",
				"transfer-encoding": "chunked",
			});
			res.write('{"answers":');
			setTimeout(() => res.socket?.destroy(), 40);
		});
		await run(PLAIN, callable(base));
		expect(readLogLines()[0].outcome).toBe("outage");
	});
});

describe("what the guard emits", () => {
	it("writes nothing to stdout or stderr on any skip path", async () => {
		for (const text of [ROUND, PLAIN]) {
			const res = await run(text);
			expect(res.stdout).toBe("");
			expect(res.stderr).toBe("");
		}
	});

	it("appends rather than overwriting, one line per turn", async () => {
		await run(PLAIN);
		await run("A different message entirely.");
		expect(readLogLines().map((l) => l.outcome)).toEqual([
			"skipped-no-sdk",
			"skipped-no-sdk",
		]);
	});

	it("records a length and a digest on every line", async () => {
		await ask(PLAIN, 0.9);
		const [line] = readLogLines();
		expect(line.session).toBe(sid);
		expect(line.messageLen).toBe(PLAIN.length);
		expect(line.messageHash).toMatch(/^[0-9a-f]{12}$/);
	});

	it("stores the text on a flagged line, so the flag can be judged later", async () => {
		await ask(PLAIN, 0.9);
		expect(readLogLines()[0]).toMatchObject({
			outcome: "flagged",
			messageText: PLAIN,
		});
	});

	it("stores no text on any outcome but flagged", async () => {
		await ask(PLAIN, 0.2);
		await run(PLAIN);
		expect(readLogLines().map((l) => l.outcome)).toEqual([
			"clear",
			"skipped-no-sdk",
		]);
		for (const line of readLogLines()) expect(line.messageText).toBeUndefined();
		const raw = fs.readFileSync(marker(".jev-advisory-log.jsonl"), "utf8");
		expect(raw).not.toContain("Rebuild the index");
	});

	it("caps the stored text rather than letting one line grow without bound", async () => {
		const long = `${"choice ".repeat(1000)}(A) one (B) two`;
		await ask(long, 0.9);
		const [line] = readLogLines();
		expect(line.messageLen).toBe(long.length);
		expect(line.messageText).toBe(long.slice(0, 4000));
	});

	it("rotates the log at the cap rather than losing lines", async () => {
		const live = marker(".jev-advisory-log.jsonl");
		const old = `${JSON.stringify({ outcome: "skipped-no-sdk" })}\n`;
		fs.writeFileSync(live, old.repeat(Math.ceil(2_097_152 / old.length)));
		await run(PLAIN);
		expect(readLogLines()).toHaveLength(1);
		expect(
			fs.statSync(marker(".jev-advisory-log.1.jsonl")).size,
		).toBeGreaterThanOrEqual(2_097_152);
	});

	it("does not throw or emit on a payload with no message at all", async () => {
		const res = await runInProcessAsync(GUARD, [], {
			stdin: JSON.stringify({ hook_event_name: "Stop", session_id: sid }),
			cwd: dir,
			env: { ...process.env, WFC_REPO_ROOT: dir },
		});
		expect(res.status).toBe(0);
		expect(res.stdout).toBe("");
		expect(readLogLines()).toEqual([]);
	});
});
