// @vitest-environment node
/*
 * The check-wsl-currency.js program (#4082), its reads crossed through the
 * WFC_PROC, WFC_WSL_EXE and gh seams, so each exit and print is seen as
 * `npm run status` and the morning review see it. Loosened, a failed read
 * reads as clean, or the commands stop being pasteable. The judging itself is
 * lib/wsl-currency.test.ts's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GH_NOT_FOUND, type GhAnswer } from "./lib/gh-fake";
import { stubGhRoutes } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";
import {
	buildLatestAnswer,
	buildReleasesAnswer,
	WSL_KERNEL,
	type WslBehaviour,
	writeOsrelease,
	writeWsl,
	wslCallLogPath,
} from "./lib/wsl-fake";

const SCRIPT = path.join(__dirname, "check-wsl-currency.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-currency-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const ghLog = () => path.join(dir, "gh-calls");

function run({
	args = ["--json"],
	proc = writeOsrelease(dir, WSL_KERNEL),
	wsl = { version: "2.7.11.0" },
	latest = buildLatestAnswer("3.0.3"),
	releases = buildReleasesAnswer(["3.0.3", "3.0.1"]),
	wslExe,
}: {
	args?: string[];
	proc?: string;
	wsl?: WslBehaviour;
	latest?: GhAnswer;
	releases?: GhAnswer;
	wslExe?: string;
}) {
	const { env } = stubGhRoutes(
		dir,
		{
			"repos/microsoft/WSL/releases/latest": latest,
			"repos/microsoft/WSL/releases?per_page=100": releases,
		},
		{ log: ghLog() },
	);
	return runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			...env,
			GITHUB_ACTIONS: "",
			WFC_PROC: proc,
			WFC_WSL_EXE: wslExe ?? writeWsl(dir, wsl),
		},
	});
}

describe("not WSL", () => {
	it("SKIPs, exit 0, saying why, and reads nothing else", () => {
		const r = run({ proc: writeOsrelease(dir, "6.8.0-45-generic") });
		expect(r.status).toBe(0);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.outcome).toBe("SKIP");
		expect(envelope.summary).toContain("not WSL");
		expect(fs.existsSync(wslCallLogPath(dir))).toBe(false);
		expect(fs.existsSync(ghLog())).toBe(false);
	});

	it("SKIPs where there is no kernel release file at all", () => {
		const r = run({ proc: path.join(dir, "no-proc") });
		expect(r.status).toBe(0);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.outcome).toBe("SKIP");
		expect(envelope.summary).toContain("not WSL");
	});
});

describe("unread", () => {
	it("warns, exit 0, on a kernel release it cannot open", () => {
		const proc = path.join(dir, "proc-unopenable");
		fs.mkdirSync(path.join(proc, "sys/kernel/osrelease"), { recursive: true });
		const r = run({ proc });
		expect(r.status).toBe(0);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.outcome).toBe("WARN");
		expect(envelope.state).toBe("UNREAD");
		expect(envelope.lines.join()).toContain("the kernel release: EISDIR");
	});

	it("warns, exit 0, on a WSL kernel with interop off, wsl.exe not running", () => {
		const r = run({ wslExe: path.join(dir, "no-wsl.exe") });
		expect(r.status).toBe(0);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.outcome).toBe("WARN");
		expect(envelope.lines.join()).toContain("wsl.exe --version: ");
		expect(envelope.lines.join()).toContain("ENOENT");
	});

	it("warns, exit 0, on wsl.exe failing", () => {
		const r = run({ wsl: { exits: 1, says: "E_FAIL" } });
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).lines.join()).toContain(
			"wsl.exe --version: exited 1: E_FAIL",
		);
	});

	it("warns, exit 0, naming each gh read that failed, with gh's reason", () => {
		const r = run({ latest: GH_NOT_FOUND, releases: GH_NOT_FOUND });
		expect(r.status).toBe(0);
		const text = JSON.parse(r.stdout).lines.join();
		expect(text).toContain("the latest release: ");
		expect(text).toContain("the release list: ");
		expect(text).toContain("Not Found");
	});
});

describe("behind", () => {
	it("prints every line and warns, exit 0", () => {
		const r = run({ args: [] });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"WSL 2.7.11.0 is 2 stable releases behind 3.0.3.\n",
		);
		expect(r.stderr).toContain("\nnode scripts/refill-loop.js set --pause\n");
		expect(r.stderr).toContain("\nwsl --update\n");
		expect(r.stderr).toContain("WARN: 1 WSL currency finding(s)");
	});

	it("counts stable releases only, in the singular", () => {
		const r = run({
			args: [],
			releases: buildReleasesAnswer(["3.0.3"], ["3.1.0"]),
		});
		expect(r.stderr).toContain(
			"WSL 2.7.11.0 is 1 stable release behind 3.0.3.\n",
		);
	});
});

describe("current", () => {
	it("is OK, exit 0, naming both versions", () => {
		const r = run({ wsl: { version: "3.0.3.0" } });
		expect(r.status).toBe(0);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.outcome).toBe("OK");
		expect(envelope.summary).toBe(
			"OK: WSL 3.0.3.0 is current: the latest stable release is 3.0.3.",
		);
	});
});

describe("what it runs", () => {
	it("runs only the two version reads: nothing writes, updates or shuts down", () => {
		run({});
		expect(fs.readFileSync(wslCallLogPath(dir), "utf8")).toBe("--version\n");
		expect(fs.readFileSync(ghLog(), "utf8").trim().split("\n").sort()).toEqual([
			"api repos/microsoft/WSL/releases/latest --jq {tag_name}",
			"api repos/microsoft/WSL/releases?per_page=100 --jq [.[] | {tag_name, prerelease, draft}]",
		]);
	});
});

describe("a bad invocation", () => {
	it("is BROKEN, exit 2, on an unknown flag", () => {
		const r = run({ args: ["--bogus"] });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--bogus");
	});
});
