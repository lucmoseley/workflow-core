// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { sweptMarkers } from "./arbiter-testkit";
import { localRequires } from "./require-closure-testkit";
import { runInProcess } from "./run-in-process.js";

const REPO = path.join(__dirname, "..", "..");
const HOOK_BLOCK = path.join(__dirname, "hook-block.js");
const hookBlock = require(HOOK_BLOCK);

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

const USE = /(?:blockStop|charge)\s*\(|["'](?:blockStop|charge)["']/g;
const CALL = /(?:blockStop|charge)\(\s*\{/g;
const CALL_WITH_PREFIX =
	/(?:blockStop|charge)\(\s*\{[^}]*?prefix:\s*"([^"]+)"/g;
const DECLARED_PREFIX = /^const \w*PREFIX\w* = "([^"]*-nagged-)";$/gm;
const declaredIn = (src: string) =>
	[...src.matchAll(DECLARED_PREFIX)].map((m) => m[1]);
const REQUIRED_LIB = /^(\.\/(?:lib\/)?[\w-]+)(?:\.js)?$/;
const declaredInLibs = (f: string, src: string) =>
	localRequires(src).flatMap((req) => {
		const name = REQUIRED_LIB.exec(req)?.[1];
		if (name === undefined) return [];
		const lib = path.join(path.dirname(f), `${name}.js`);
		return fs.existsSync(lib) ? declaredIn(fs.readFileSync(lib, "utf8")) : [];
	});

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
	it("still finds the twenty-five call sites", () => {
		expect(total("calls")).toBe(25);
	});

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

	it("sweeps every `-nagged-` literal in the corpus", () => {
		expect(
			naggedLiterals.filter((p) => {
				const { finishedGone, runningKept } = sweepOf(p);
				return !(finishedGone && runningKept);
			}),
		).toEqual([]);
	});
});

describe("every swept prefix, whatever wrote it", () => {
	it("the marker directory is hidden by .gitignore", () => {
		expect([...gitignore]).toContain(".claude/tmp/");
	});
});

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
			if (res.stdout) out.push(JSON.parse(res.stdout));
		}
		return out;
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

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
		vi.stubEnv("WFC_SCRIPT_ROOT", root);
		try {
			expect(emit({ reason: "see docs/agents/t.md." }).reason).toBe(
				`see ${root}/docs/agents/t.md.`,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("the notice on the last block a counter allows", () => {
	const last = /last Stop block on this check/;

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
		expect(blocks[0].reason).toContain("This was guard-fake.js's last Stop");
	});

	it("falls back to the counter prefix where argv[1] names no script", () => {
		const blocks = emitRun(1, { reason: "seen", max: 1 });
		expect(blocks[0].reason).toMatch(/\.t-'s last Stop block/);
	});
});

describe("capSpent, the read-only cap query (mantahostels#2383)", () => {
	function ask(
		counter: string | null,
		spec: Record<string, unknown> = {},
	): { spent: boolean; after: string | null } {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hook-block-"));
		const file = path.join(cwd, ".claude", "tmp", "markers", ".t-s1");
		vi.stubEnv("WFC_REPO_ROOT", cwd);
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

describe("charge, the spend that emits nothing (mantahostels#2786)", () => {
	function spend(
		counter: string | null,
		spec: Record<string, unknown> = {},
	): { charged: boolean; after: string | null; said: string } {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hook-block-"));
		const file = path.join(cwd, ".claude", "tmp", "markers", ".t-s1");
		vi.stubEnv("WFC_REPO_ROOT", cwd);
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
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}

	it("increments below the cap, and says nothing on stdout", () => {
		expect(spend("2\n")).toEqual({ charged: true, after: "3\n", said: "" });
	});

	it("mints a counter where none exists", () => {
		expect(spend(null)).toEqual({ charged: true, after: "1\n", said: "" });
	});

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
