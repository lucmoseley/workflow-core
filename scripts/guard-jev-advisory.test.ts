// @vitest-environment node
/*
 * guard-jev-advisory.js asks a vendor model whether a turn carrying no round
 * marker puts a real choice to the founder in plain prose, warns where it says
 * yes, logs every turn, and never refuses one — outage, malformed reply and
 * abort included (spec #200, under #199).
 *
 * Driven end-to-end through the CLI, the way its sibling's suite is: a payload
 * on stdin, a transcript on disk, and — for this guard — a JSONL gate log on
 * disk beside whatever it wrote to stdout (#203, #204).
 *
 * `runInProcessAsync` rather than `runInProcess`, because the guard's verdict
 * is a network call and the sync seam returns before an awaited one has done
 * anything (`lib/run-in-process.js`'s own header).
 *
 * Every call path goes to a `node:http` server this file starts on a loopback
 * port, handed to the guard through `WFC_JEV_BASE_URL`.
 *
 * It runs at every `Stop` (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`):
 * break it and an unlettered choice to the founder goes unflagged in the log
 * `check-jev-flags.js` reads at the next session start, and the counts #199's
 * stop condition is judged on go wrong; let it emit a `decision` and a
 * permanently advisory guard starts refusing turns.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyLibs, programLibs } from "./guard-parse-fixture";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process";

const hookBlock = createRequire(__filename)("./lib/hook-block.js");
const guard = createRequire(__filename)("./guard-jev-advisory.js");

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

/** What the guard asked the gateway, as the stub saw it. */
interface Seen {
	url: string;
	method: string;
	body: Record<string, unknown>;
}

/**
 * A marker path inside the sandbox. Spelled out rather than taken from
 * `hook-block.js`'s `counterPath`, which resolves off the WORKER's environment
 * — where `WFC_REPO_ROOT` is unset — and so would mint the fixture in the
 * shared tree instead (mantahostels#1798).
 */
function marker(name: string): string {
	const markers = path.join(dir, ".claude", "tmp", "markers");
	fs.mkdirSync(markers, { recursive: true });
	return path.join(markers, name);
}

/** Every line the guard has logged in this sandbox, oldest first. */
function logLines(): LogLine[] {
	const file = marker(".jev-advisory-log.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

/**
 * Start a stub gateway on a loopback port and return its base URL. `handler`
 * gets the parsed request body; answering is its own business, so a handler
 * that never answers is how the abort ceiling is exercised.
 */
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

/** Answer the guard's one question with `probability`. */
function answerWith(res: ServerResponse, probability: number) {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			answers: { puts_choice: { type: "boolean", probability } },
		}),
	);
}

/** A stub that answers every question with `probability`, recording the ask. */
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

/**
 * Run the guard over `text`. `WFC_REPO_ROOT` points every marker, counter and
 * log at the sandbox; the key and the switch are cleared so no developer's real
 * environment can change which limb a test takes.
 */
async function run(text: string, env: NodeJS.ProcessEnv = {}) {
	const base: NodeJS.ProcessEnv = { ...process.env, WFC_REPO_ROOT: dir };
	for (const k of [
		"AI_GATEWAY_API_KEY",
		"WFC_JEV_ADVISORY",
		"WFC_JEV_BASE_URL",
		"WFC_JEV_ABORT_MS",
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

/**
 * A stub standing in for gitleaks at the guard's own `WFC_GITLEAKS` injection
 * point, exiting `code` — 0 for a clean scan, 1 for a finding.
 *
 * WHY MOST TESTS BELOW DO NOT USE THE REAL BINARY: every path that reaches the
 * vendor passes the sweep first. The real rule set is still exercised, by the
 * redaction describe alone, which skips where it is absent.
 */
function gitleaksStub(code: number): string {
	const file = path.join(dir, `gitleaks-exit-${code}`);
	/* It DRAINS STDIN before exiting, as the real binary does: the guard pipes
	 * the message in (#227), and a stub that exits unread takes an EPIPE on any
	 * message past the ~64 KiB pipe buffer — which the sweep would read as "do
	 * not send", misfiling a long turn as unswept. */
	fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nexit ${String(code)}\n`, {
		mode: 0o755,
	});
	return file;
}

/** The environment in which every gate but the vendor's own answer is open. */
function callable(base: string, extra: NodeJS.ProcessEnv = {}) {
	return {
		AI_GATEWAY_API_KEY: "test-key",
		WFC_JEV_BASE_URL: base,
		WFC_GITLEAKS: gitleaksStub(0),
		...extra,
	};
}

/**
 * Is a real gitleaks on this machine? The redaction describe needs one.
 *
 * PATH only, unlike the hooks' `${WFC_GITLEAKS:-gitleaks}` (#239): the
 * redaction describe alone passes `WFC_GITLEAKS: "gitleaks"` explicitly to
 * every case that reaches the vendor, so a var-only machine merely skips
 * that describe rather than falsely passing it. `callable()` itself defaults
 * to a stub, not this literal.
 */
const HAS_GITLEAKS =
	spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0;

/** Run with a stub that answers `probability`, every other gate open. */
async function ask(text: string, probability: number, extra = {}) {
	const { base, asks } = await answering(probability);
	const res = await run(text, callable(base, extra));
	return { res, asks };
}

/**
 * Port 1 is privileged and unbound, so a connection to it is refused rather
 * than left hanging: the unreachable-host path #174 measured.
 */
const UNREACHABLE = "http://127.0.0.1:1";

/** The guard's own abort ceiling, `ABORT_MS` in guard-jev-advisory.js. */
const ABORT_MS = 3000;

/** How many calls a turn makes when every one of them hangs: one and its re-ask (#255). */
const ATTEMPTS = 2;

/**
 * The abort budget every hang case runs on, through `WFC_JEV_ABORT_MS`
 * (#1024). A FIRST GUESS, sized against the stub's answer to a re-ask, measured
 * at ~20 ms on an idle machine: the budget is that answer's whole window.
 */
const SHORT_ABORT_MS = 500;
const SHORT_ABORT = { WFC_JEV_ABORT_MS: String(SHORT_ABORT_MS) };

const neverAnswers = () => {
	/* so every attempt runs to its abort */
};

/** The outcome of the single line this run logged. */
async function outcomeOf(
	text: string,
	env: NodeJS.ProcessEnv = {},
): Promise<string> {
	await run(text, env);
	const lines = logLines();
	expect(lines).toHaveLength(1);
	return lines[0].outcome;
}

/** A `.claude/workflow-core.json` in the sandbox with `disabled` set. */
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

/** What a run wrote on the advisory channel, or "" where it said nothing. */
function saidBy(res: { stdout: string }): string {
	if (!res.stdout) return "";
	const parsed = JSON.parse(res.stdout);
	expect(parsed).not.toHaveProperty("decision");
	return String(parsed.systemMessage ?? "");
}

const PLAIN = "Two ways to take this. Rebuild the index, or leave it stale.";
const ROUND =
	"❓ **Q1** Which way?\n\n(A) Rebuild\nConfidence: 60% (50% - 70%). Cheap.";

/*
 * A fixture secret, spelled so gitleaks' own rule set hits it: random
 * characters behind an AWS access-key-id prefix, authorising nothing. NOT the
 * `AKIAIOSFODNN7EXAMPLE` from AWS's own documentation, which gitleaks
 * allowlists and which would therefore test the opposite of what it looks like.
 *
 * ASSEMBLED FROM TWO HALVES rather than written out, because a fixture that
 * trips the guard under test also trips `.husky/pre-commit`'s own gitleaks scan
 * and this file could not be committed. The halves join at run time, so the
 * string the guard sweeps is the whole key and the string in this repo is not.
 * A `gitleaks:allow` comment would do the same job and is not used: it would
 * silence the whole line, this one and any future one.
 */
const WITH_SECRET = `Two ways to take this, and the key is AKIA${"Z3XQ7LMNB4RTVKWD"} — pick one.`;

describe("the round-marker gate", () => {
	it("skips a message the other guard already owns", async () => {
		expect(await outcomeOf(ROUND)).toBe("skipped-marker");
	});

	it("takes the marker gate first, before every other limb", async () => {
		// Both the marker and the master switch apply; order decides which is
		// logged, and #200 puts the marker first.
		expect(await outcomeOf(ROUND, { WFC_JEV_ADVISORY: "0" })).toBe(
			"skipped-marker",
		);
	});

	it("never calls the vendor on a message carrying a round marker", async () => {
		const { res, asks } = await ask(ROUND, 0.99);
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(logLines()[0].outcome).toBe("skipped-marker");
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
		expect(logLines()[0].outcome).toBe("skipped-disabled");
	});

	/* The script's own basename is honoured inside lib/stop-guard.js, which
	 * returns before this file runs, so that spelling silences the guard AND
	 * its log. */
	it("logs nothing at all when the script basename is disabled instead", async () => {
		configWithDisabled(["guard-jev-advisory.js"]);
		await run(PLAIN);
		expect(logLines()).toEqual([]);
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
		expect(logLines().map((l) => l.outcome)).toEqual(["clear", "clear"]);
	});
});

describe("the vendor gate", () => {
	it("skips because the key is absent, naming which half was missing", async () => {
		await run(PLAIN);
		expect(logLines()[0].why).toBe("key");
	});

	it("skips with no throw where the SDK itself is unreachable", async () => {
		/* THE WORKTREE CASE, which #204's first acceptance criterion names and
		 * which cannot be staged in-process: `require.resolve` answers off the
		 * worker's own module paths, where `ai` IS installed. So the guard and
		 * its seams are copied under a root with no `node_modules` above it and
		 * driven as a real subprocess — the resolve then walks up from /tmp and
		 * fails, exactly as it does in a throwaway worktree. */
		const bin = path.join(dir, "scripts");
		copyLibs(path.join(bin, "lib"), programLibs("guard-jev-advisory.js"));
		fs.copyFileSync(GUARD, path.join(bin, "guard-jev-advisory.js"));

		const res = spawnSync(
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
		expect(logLines()).toHaveLength(1);
		expect(logLines()[0].outcome).toBe("skipped-no-sdk");
		expect(logLines()[0].why).toBe("sdk");
	}, 20_000);

	it("takes the key from a gitignored .env where the environment has none", async () => {
		fs.writeFileSync(
			path.join(dir, ".env"),
			'AI_GATEWAY_API_KEY="from-dotenv"\n',
		);
		const { base, asks } = await answering(0.9);
		await run(PLAIN, { WFC_JEV_BASE_URL: base });
		expect(asks).toHaveLength(1);
		expect(logLines()[0].outcome).toBe("flagged");
	});

	it("prefers the environment over the .env file", async () => {
		fs.writeFileSync(
			path.join(dir, ".env"),
			"AI_GATEWAY_API_KEY=from-dotenv\n",
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

/* The one describe that drives the REAL rule set, so the fixture above is
 * proved to be a secret rather than assumed to be. Skipped rather than red
 * where the binary is absent, as the repo's sibling gitleaks suites are. */
describe.skipIf(!HAS_GITLEAKS)("the redaction sweep", () => {
	it("sends nothing where gitleaks finds a secret in the message", async () => {
		const { res, asks } = await ask(WITH_SECRET, 0.99, {
			WFC_GITLEAKS: "gitleaks",
		});
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(logLines()[0].outcome).toBe("skipped-redaction");
		expect(logLines()[0].why).toBe("finding");
	});

	it("runs the sweep before every egress, not only the first", async () => {
		const { base } = await answering(0.9);
		const env = callable(base, { WFC_GITLEAKS: "gitleaks" });
		await run(PLAIN, env);
		await run(WITH_SECRET, env);
		expect(logLines().map((l) => l.outcome)).toEqual([
			"flagged",
			"skipped-redaction",
		]);
	});

	it("writes the message nowhere on disk, clean or not", async () => {
		/* #227: the message is piped to `gitleaks stdin`, so there is no scratch
		 * file for a kill mid-sweep to strand. */
		const tmp = path.join(dir, ".claude", "tmp");
		fs.mkdirSync(tmp, { recursive: true });
		await ask(PLAIN, 0.9, { WFC_GITLEAKS: "gitleaks" });
		await ask(WITH_SECRET, 0.9, { WFC_GITLEAKS: "gitleaks" });
		/* The message's own bytes, under ANY name: a filename filter would pass
		 * for a scratch file spelled differently. */
		const holding = fs
			.readdirSync(tmp, { withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => fs.readFileSync(path.join(tmp, e.name), "utf8"))
			.filter((text) => text.includes(PLAIN) || text.includes(WITH_SECRET));
		expect(holding).toEqual([]);
	});

	it("passes the message on stdin rather than as a path argument", async () => {
		/* A stub recording its own argv and what arrived on stdin. */
		const seen = path.join(dir, "sweep-argv.txt");
		const stdinSeen = path.join(dir, "sweep-stdin.txt");
		const recorder = path.join(dir, "gitleaks-recorder");
		fs.writeFileSync(
			recorder,
			`#!/bin/sh\nprintf '%s\\n' "$@" > ${seen}\ncat > ${stdinSeen}\nexit 0\n`,
			{ mode: 0o755 },
		);
		await ask(PLAIN, 0.2, { WFC_GITLEAKS: recorder });
		expect(fs.readFileSync(seen, "utf8").trim().split("\n")[0]).toBe("stdin");
		expect(fs.readFileSync(stdinSeen, "utf8")).toBe(PLAIN);
		expect(fs.readFileSync(seen, "utf8")).not.toContain(".claude/tmp");
	});
});

/* Outside the describe above, and deliberately: this is the limb a machine
 * WITHOUT gitleaks takes, so skipping it exactly there would be backwards. It
 * needs no real binary. */
describe("a machine with no gitleaks", () => {
	it("treats the absent binary as a finding and sends nothing", async () => {
		/* Pointed at a path that does not exist, through the guard's own named
		 * injection point — `docs/code-standards-base.md` §N7's rule, not a PATH
		 * shadow, which would also hide every other binary the child wants. */
		const { res, asks } = await ask(PLAIN, 0.99, {
			WFC_GITLEAKS: path.join(dir, "no-such-gitleaks"),
		});
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(logLines()[0].outcome).toBe("skipped-redaction");
		expect(logLines()[0].why).toBe("unswept");
	});

	it("treats a sweep that never returns as a finding", async () => {
		const hang = path.join(dir, "gitleaks-hang");
		fs.writeFileSync(hang, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
		const { res, asks } = await ask(PLAIN, 0.99, { WFC_GITLEAKS: hang });
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(logLines()[0].outcome).toBe("skipped-redaction");
		expect(logLines()[0].why).toBe("unswept");
	}, 20_000);
});

/* #227's open question: a gitleaks predating the `stdin` subcommand answers
 * "unknown command" with the same non-zero exit a finding takes. The guard
 * still sends nothing, but the log has to say which. */
describe("a gitleaks too old to carry `stdin`", () => {
	/** A stub exiting non-zero on ANY input, as an unknown subcommand does. */
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
		expect(logLines()[0].outcome).toBe("skipped-redaction");
		expect(logLines()[0].why).toBe("unswept");
	});

	it("still calls a real finding a finding, the probe coming back clean", async () => {
		/* The other half of the same branch, with no real binary needed: non-zero
		 * on the message, zero on the empty probe. */
		const file = path.join(dir, "gitleaks-finds");
		fs.writeFileSync(
			file,
			'#!/bin/sh\nif [ -n "$(cat)" ]; then exit 1; fi\nexit 0\n',
			{ mode: 0o755 },
		);
		const { res, asks } = await ask(PLAIN, 0.99, { WFC_GITLEAKS: file });
		expect(asks).toEqual([]);
		expect(saidBy(res)).toBe("");
		expect(logLines()[0].outcome).toBe("skipped-redaction");
		expect(logLines()[0].why).toBe("finding");
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
	/** A stub whose reply names its model and its final provider hop, as the
	 * live gateway's does. */
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
		expect(logLines()[0]).toMatchObject({
			outcome: "clear",
			model: "typesafe-ai/jev",
			provider: "digitalocean",
		});
		expect(logLines()[0].questionHash).toMatch(/^[0-9a-f]{12}$/);
	});

	it("falls back to the id asked for where the reply names no model", async () => {
		await ask(PLAIN, 0.9);
		const [line] = logLines();
		expect(line.outcome).toBe("flagged");
		expect(line.model).toBe("typesafe-ai/jev");
		expect(line.provider).toBeUndefined();
	});

	it("digests the question set the same way on every turn", async () => {
		await ask(PLAIN, 0.2);
		await ask(`${PLAIN} Again.`, 0.9);
		const [a, b] = logLines();
		expect(a.questionHash).toBe(b.questionHash);
	});

	it("puts the digest and no model on an outage", async () => {
		await run(PLAIN, callable(UNREACHABLE));
		const [line] = logLines();
		expect(line.outcome).toBe("outage");
		expect(line.questionHash).toMatch(/^[0-9a-f]{12}$/);
		expect(line.model).toBeUndefined();
	});

	/* The SDK rejects this reply before `askJev` sees it, so no `MalformedReply`
	 * carries what answered: the guard's own is unreachable from a stub. */
	it("puts the digest and no model on a reply the SDK could not read", async () => {
		await run(PLAIN, callable(await malformedStub()));
		const [line] = logLines();
		expect(line.outcome).toBe("malformed");
		expect(line.questionHash).toMatch(/^[0-9a-f]{12}$/);
		expect(line.model).toBeUndefined();
	});

	it("puts neither on a turn that never reached the vendor", async () => {
		await run(PLAIN);
		const [line] = logLines();
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
		/* The advisory is the ONLY moment the flag can be judged — the message
		 * text is never kept — so the hash in it has to be the one the verdict
		 * store joins on (#253). Read off the log this run wrote rather than
		 * recomputed here, which is what makes a change to either side fail. */
		const { res } = await ask(PLAIN, 0.91);
		const { messageHash } = logLines()[0];

		expect(saidBy(res)).toContain(
			`node scripts/jev-verdict.js ${messageHash} right|wrong`,
		);
	});

	it("logs the confidence to two decimals, as a number", async () => {
		await ask(PLAIN, 0.912_34);
		const [line] = logLines();
		expect(line.outcome).toBe("flagged");
		expect(line.confidence).toBe(0.91);
		expect(typeof line.confidence).toBe("number");
	});

	it("logs the latency as the time the vendor took to answer", async () => {
		/* §X9 (#2102): only `Date` is faked, so the guard's abort timer stays real; the
		 * stub moves the clock while it holds the request, and that move is the
		 * whole of the latency the guard can see. */
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
		expect(logLines()[0].latencyMs).toBe(250);
	});

	it("renders as check-jev-flags.js's p= suffix", async () => {
		/* The reporter is driven over a line this guard actually wrote rather
		 * than a fixture, so renaming the field or writing it as a string fails
		 * here (#204). */
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
		/* Both streams, as check-jev-flags.test.ts's own helper reads them:
		 * `lib/check.js` splits a report across the two and which half a line
		 * lands on is not this test's subject. */
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
		const [line] = logLines();
		expect(line.outcome).toBe("clear");
		expect(line.confidence).toBe(0.12);
	});

	it("reads the answer out at 0.5 before the log rounds it", async () => {
		/* 0.499 logs as 0.5 and must still be clear: the read-out is on the raw
		 * probability, never on the rounded field. */
		await ask(PLAIN, 0.499);
		expect(logLines()[0].outcome).toBe("clear");
		expect(logLines()[0].confidence).toBe(0.5);
	});
});

describe("an outage", () => {
	it("gives up inside the abort ceiling on a stub that never answers", async () => {
		const base = await stub(neverAnswers);
		const t0 = Date.now();
		const res = await run(PLAIN, callable(base, SHORT_ABORT));
		const elapsed = Date.now() - t0;
		expect(logLines()[0].outcome).toBe("outage");
		expect(saidBy(res)).toContain("could not reach its vendor");
		/* The abort fires, the turn re-asks once (#255) and the second attempt
		 * hangs too. The upper bound is what proves the override took: the
		 * real budget could not finish under it. */
		// §X9: a process timeout: the abort fires on a real socket that never answers, which no injected clock reaches.
		expect(elapsed).toBeGreaterThanOrEqual(SHORT_ABORT_MS * ATTEMPTS);
		expect(elapsed).toBeLessThan(ABORT_MS * ATTEMPTS);
	}, 20_000);

	it("hangs the full `ABORT_MS` per attempt where no override is set", async () => {
		const base = await stub(neverAnswers);
		const t0 = Date.now();
		await run(PLAIN, callable(base));
		/* A lower bound only: load lengthens a hang and never shortens one. */
		// §X9: a process timeout, as above; a floor, so load only moves it away from failing.
		expect(Date.now() - t0).toBeGreaterThanOrEqual(ABORT_MS * ATTEMPTS);
		expect(logLines()[0].outcome).toBe("outage");
	}, 20_000);

	it("reads an unreachable host as an outage, and says so", async () => {
		const res = await run(PLAIN, callable(UNREACHABLE));
		expect(logLines()[0].outcome).toBe("outage");
		expect(saidBy(res)).toContain("could not reach its vendor");
	});

	it("treats an error status as an outage rather than an answer", async () => {
		const base = await stub((_body, res) => {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "upstream is unwell" } }));
		});
		await run(PLAIN, callable(base));
		expect(logLines()[0].outcome).toBe("outage");
	});

	it("notices once a session and logs every time after", async () => {
		const env = callable(UNREACHABLE);
		const first = await run(PLAIN, env);
		const second = await run(PLAIN, env);
		expect(saidBy(first)).toContain("could not reach its vendor");
		expect(saidBy(second)).toBe("");
		expect(logLines().map((l) => l.outcome)).toEqual(["outage", "outage"]);
	});

	it("spends its own counter and never the warn budget", async () => {
		await run(PLAIN, callable(UNREACHABLE));
		expect(
			fs.readFileSync(marker(`.jev-advisory-outage-${sid}`), "utf8").trim(),
		).toBe("1");
		expect(fs.existsSync(marker(`.jev-advisory-nagged-${sid}`))).toBe(false);
	});
});

/*
 * The bounded re-ask (#255). The vendor is bimodal — a call answers under 2 s
 * or hangs to the abort — so a turn that timed out is re-asked once.
 */
describe("a turn the abort killed", () => {
	/**
	 * A stub that hangs for the first `hangs` requests and then answers
	 * `probability`, so the re-ask can be told apart from the first attempt by
	 * what the guard logs rather than by timing it.
	 */
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
		expect(logLines()).toHaveLength(1);
		expect(logLines()[0].outcome).toBe("flagged");
		expect(logLines()[0].retries).toBe(1);
		expect(saidBy(res)).toContain("JEV ADVISORY");
	}, 20_000);

	it("counts the re-ask against no outage at all", async () => {
		const { base } = await hangingThenAnswering(1, 0.1);

		await run(PLAIN, callable(base, SHORT_ABORT));

		expect(logLines()[0].outcome).toBe("clear");
		expect(fs.existsSync(marker(`.jev-advisory-outage-${sid}`))).toBe(false);
	}, 20_000);

	it("re-asks no more than once, and says so on the outage", async () => {
		const { base, seen } = await hangingThenAnswering(9, 0.91);

		await run(PLAIN, callable(base, SHORT_ABORT));

		expect(seen.count).toBe(ATTEMPTS);
		expect(logLines()[0].outcome).toBe("outage");
		expect(logLines()[0].retries).toBe(ATTEMPTS - 1);
	}, 20_000);

	it("never re-asks a failure the abort did not cause", async () => {
		/* Port 1 refuses immediately, so no abort fires; a re-ask would show
		 * in `retries`. */
		await run(PLAIN, callable(UNREACHABLE));

		expect(logLines()[0].outcome).toBe("outage");
		expect(logLines()[0].retries).toBeUndefined();
	});

	it("never re-asks a reply it simply could not read", async () => {
		const base = await stub((_body, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({ answers: { puts_choice: { type: "boolean" } } }),
			);
		});

		await run(PLAIN, callable(base));

		expect(logLines()[0].outcome).toBe("malformed");
		expect(logLines()[0].retries).toBeUndefined();
	});
});

describe("the abort budget's override (#1024)", () => {
	/** Past every budget these cases set, and well inside `ABORT_MS`. */
	const slowMs = 1200;

	/** A stub that answers a clear turn after `slowMs`: `clear` under any budget longer than that, `outage` under one shorter. */
	async function answeringSlowly() {
		return stub((_body, res) => {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						answers: { puts_choice: { type: "boolean", probability: 0.1 } },
					}),
				);
			}, slowMs);
		});
	}

	it.each(["", " ", "0", "-250", "250ms", "2.5", "1e3", "0x10"])(
		"ignores %j and keeps `ABORT_MS`",
		async (raw) => {
			await run(
				PLAIN,
				callable(await answeringSlowly(), { WFC_JEV_ABORT_MS: raw }),
			);
			expect(logLines()[0].outcome).toBe("clear");
		},
	);

	it("takes a positive whole number of milliseconds", async () => {
		await run(
			PLAIN,
			callable(await answeringSlowly(), { WFC_JEV_ABORT_MS: " 250 " }),
		);
		expect(logLines()[0].outcome).toBe("outage");
	});

	it("caps a value above `ABORT_MS` at it", async () => {
		const base = await stub(neverAnswers);
		const t0 = Date.now();
		await run(PLAIN, callable(base, { WFC_JEV_ABORT_MS: "60000" }));
		/* The upper bound is what proves the cap: the 60 s asked for could not
		 * finish under it, even once. */
		// §X9: a process timeout: the cap bounds a real socket that never answers.
		expect(Date.now() - t0).toBeLessThan(15_000);
		expect(logLines()[0].outcome).toBe("outage");
	}, 20_000);
});

/**
 * A reply the gateway delivers whole and the check cannot read: vendor schema
 * drift, which #175's outage limb must not count (#226).
 */
async function malformedStub(body: unknown = { answers: {} }): Promise<string> {
	return stub((_body, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	});
}

describe("a malformed reply", () => {
	/* The three shapes a drifting vendor produces. */
	it.each([
		["answers that match no question", { answers: {} }],
		[
			"a probability of the wrong type",
			{ answers: { puts_choice: { type: "boolean", probability: "0.9" } } },
		],
		["a body with no answers at all", { wat: 1 }],
	])("is its own outcome on %s", async (_name, body) => {
		await run(PLAIN, callable(await malformedStub(body)));
		expect(logLines()[0].outcome).toBe("malformed");
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
		expect(logLines().map((l) => l.outcome)).toEqual([
			"malformed",
			"malformed",
		]);
	});

	/* An unreachable host surfaces as a SYNTHESISED 500. */
	it("never claims an unreachable host answered", async () => {
		await run(PLAIN, callable(UNREACHABLE));
		expect(logLines()[0].outcome).toBe("outage");
		expect(fs.existsSync(marker(`.jev-advisory-malformed-${sid}`))).toBe(false);
	});

	/* A REAL 200, not a synthesised one — the shape that makes the classifier's
	 * second limb necessary. */
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
		expect(logLines()[0].outcome).toBe("outage");
	});

	/* The classifier direct, for the chains no stub here provokes: the guard's
	 * own `MalformedReply`, which the SDK's validation gets to first, and a
	 * gateway error page that would parse-fail under a non-2xx status. */
	it.each([
		["its own rejection", { name: "JevMalformedReply" }],
		["the SDK's answer-set check", { name: "AI_InvalidResponseDataError" }],
		[
			"a 2xx whose body failed to parse",
			{
				name: "GatewayResponseError",
				statusCode: 200,
				cause: { name: "AI_JSONParseError" },
			},
		],
	])("classifies %s as an answer, not an outage", (_name, err) => {
		expect(guard.gateway.isMalformedReply(err)).toBe(true);
	});

	it.each([
		[
			"a 500 whose error page failed to parse",
			{
				name: "GatewayResponseError",
				statusCode: 500,
				cause: { name: "AI_JSONParseError" },
			},
		],
		[
			"a 200 whose socket dropped",
			{
				name: "GatewayResponseError",
				statusCode: 200,
				cause: { name: "AI_APICallError", cause: { name: "SocketError" } },
			},
		],
		["a rate limit", { name: "GatewayInternalServerError", statusCode: 429 }],
		["nothing at all", undefined],
	])("classifies %s as an outage", (_name, err) => {
		expect(guard.gateway.isMalformedReply(err)).toBe(false);
	});

	it("does not hang on an error whose cause chain loops", () => {
		const err: Record<string, unknown> = { name: "GatewayResponseError" };
		err.cause = err;
		expect(guard.gateway.isMalformedReply(err)).toBe(false);
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
		expect(logLines().map((l) => l.outcome)).toEqual([
			"skipped-no-sdk",
			"skipped-no-sdk",
		]);
	});

	it("records a length and a digest on every line", async () => {
		await ask(PLAIN, 0.9);
		const [line] = logLines();
		expect(line.session).toBe(sid);
		expect(line.messageLen).toBe(PLAIN.length);
		expect(line.messageHash).toMatch(/^[0-9a-f]{12}$/);
	});

	it("stores the text on a flagged line, so the flag can be judged later", async () => {
		await ask(PLAIN, 0.9);
		expect(logLines()[0]).toMatchObject({
			outcome: "flagged",
			messageText: PLAIN,
		});
	});

	it("stores no text on any outcome but flagged", async () => {
		await ask(PLAIN, 0.2);
		await run(PLAIN);
		expect(logLines().map((l) => l.outcome)).toEqual([
			"clear",
			"skipped-no-sdk",
		]);
		for (const line of logLines()) expect(line.messageText).toBeUndefined();
		const raw = fs.readFileSync(marker(".jev-advisory-log.jsonl"), "utf8");
		expect(raw).not.toContain("Rebuild the index");
	});

	it("caps the stored text rather than letting one line grow without bound", async () => {
		/* 4000 spelled here rather than read off the guard: an independent pin,
		 * so moving the cap has to be a deliberate edit in two places. */
		const long = `${"choice ".repeat(1000)}(A) one (B) two`;
		await ask(long, 0.9);
		const [line] = logLines();
		expect(line.messageLen).toBe(long.length);
		expect(line.messageText).toBe(long.slice(0, 4000));
	});

	it("rotates the log at the cap rather than losing lines", async () => {
		/* 2 MiB spelled here rather than read off the guard: an independent pin,
		 * so moving the cap has to be a deliberate edit in two places. */
		const live = marker(".jev-advisory-log.jsonl");
		const old = `${JSON.stringify({ outcome: "skipped-no-sdk" })}\n`;
		fs.writeFileSync(live, old.repeat(Math.ceil(2_097_152 / old.length)));
		await run(PLAIN);
		expect(logLines()).toHaveLength(1);
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
		expect(logLines()).toEqual([]);
	});
});
