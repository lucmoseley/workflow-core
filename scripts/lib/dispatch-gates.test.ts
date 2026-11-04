// @vitest-environment node
/*
 * Pins lib/dispatch-gates.js, dispatch-sessions.sh's seat, burn-mode and
 * launch-auth gates in one node start (#4321). Driven through its CLI against
 * a `claude` stub answering `auth status`.
 *
 * Loosen one and a mistyped overflow line launches as a plan seat, or a plan
 * seat's launch bills per token (#2605, #2236).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAuthStatusBranch } from "./auth-status-fake";
import { runInProcess } from "./run-in-process.js";

const SCRIPT = path.join(__dirname, "dispatch-gates.js");

let home: string;
let bin: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-gates-"));
	fs.mkdirSync(path.join(home, ".claude"));
	bin = path.join(home, "claude");
	fs.writeFileSync(bin, `#!/bin/bash\n${buildAuthStatusBranch()}\nexit 9\n`, {
		mode: 0o755,
	});
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

const file = () => path.join(home, ".claude", "refill-seats");
const seats = (text: string) => fs.writeFileSync(file(), text);
const marker = () => path.join(home, "burn-mode");
/** A bare environment: none of the parent's auth or burn marker leaks in. */
const gates = (identity: string[], extra: Record<string, string> = {}) =>
	runInProcess(SCRIPT, ["--", ...identity], {
		env: {
			PATH: process.env.PATH,
			HOME: home,
			WFC_CLAUDE_BIN: bin,
			WFC_BURN_MARKER: marker(),
			...extra,
		},
		cwd: home,
	});

describe("the seat kind", () => {
	it("refuses a call naming no config dir, or an option", () => {
		expect(gates([]).status).toBe(2);
		const r = runInProcess(SCRIPT, ["--help"], { env: {} });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage:");
	});

	it("prints each declared seat's kind, however its dir is spelt", () => {
		seats("~/.claude2\n~/.claude2-api api key=K grant=200 cycle-day=20\n");
		const overflow = gates([`${path.join(home, ".claude2-api")}/`, "K"]);
		expect(overflow.status).toBe(0);
		expect(overflow.stdout).toBe("overflow off\n");
		const plan = gates([path.join(home, ".claude2")]);
		expect(plan.status).toBe(0);
		expect(plan.stdout).toBe("plan off\n");
	});

	it("takes an undeclared dir as a plan seat", () => {
		seats("~/.claude2-api api key=K grant=200 cycle-day=20\n");
		const r = gates([path.join(home, ".claude")]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("plan off\n");
	});

	it("refuses a malformed seat file, naming the line", () => {
		seats("~/.claude2\n~/.claude2-api api key=K grant=200\n");
		const dir = path.join(home, ".claude2");
		const r = gates([dir]);
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain(`REFUSED: the seat file refuses (seat ${dir}):`);
		expect(r.stderr).toContain(`  ${file()}:2: missing cycle-day=`);
	});

	describe("on a dir a plan and an overflow seat share (#3693)", () => {
		const dir = () => path.join(home, ".claude2");
		beforeEach(() =>
			seats(
				"~/.claude2\n~/.claude2 api key=K2 grant=200 cycle-day=20\n~/.claude3-api api key=K3 grant=100 cycle-day=28\n",
			),
		);

		it("prints each kind", () => {
			const plan = gates([dir()]);
			expect(plan.status).toBe(0);
			expect(plan.stdout).toBe("plan off\n");
			const overflow = gates([dir(), "K2"]);
			expect(overflow.status).toBe(0);
			expect(overflow.stdout).toBe("overflow off\n");
		});

		it("refuses a key no line declares, or one on another dir", () => {
			const none = gates([dir(), "NOPE"]);
			expect(none.status).toBe(2);
			expect(none.stderr).toContain("no overflow seat has key=NOPE");
			const other = gates([dir(), "K3"]);
			expect(other.status).toBe(2);
			expect(other.stderr).toContain(
				`key=K3 is ${path.join(home, ".claude3-api")}'s overflow seat, not ${dir()}'s`,
			);
		});

		it("refuses a keyless launch on a dir only an overflow line declares", () => {
			const r = gates([path.join(home, ".claude3-api")]);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("WFC_SEAT_KEY=K3");
		});
	});
});

describe("burn mode", () => {
	it("reads on while its marker exists", () => {
		fs.writeFileSync(marker(), "");
		expect(gates([path.join(home, ".claude")]).stdout).toBe("plan on\n");
	});

	it("reads off where the marker is not a regular file", () => {
		fs.mkdirSync(marker());
		expect(gates([path.join(home, ".claude")]).stdout).toBe("plan off\n");
	});

	it("reads off, warning, where the marker's path will not resolve", () => {
		// A relative HOME: burn-mode.js refuses it, while the seat read still
		// resolves under the case's cwd, the temp home, never the machine's own.
		const r = gates([path.join(home, ".claude")], {
			WFC_BURN_MARKER: "",
			HOME: "not-absolute",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("plan off\n");
		expect(r.stderr).toContain("WARNING: burn-mode marker path unresolved");
	});
});

describe("launch auth (#2236)", () => {
	it("refuses a plan seat whose launch would bill per token", () => {
		const r = gates([path.join(home, ".claude")], { ANTHROPIC_API_KEY: "k" });
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(/^REFUSED: .*ANTHROPIC_API_KEY is set/);
		expect(r.stderr).toContain("Unset what set it");
	});

	it("is not read where the seat gate has already refused", () => {
		seats("~/.claude2\n~/.claude2-api api key=K grant=200\n");
		const r = gates([path.join(home, ".claude2")], { ANTHROPIC_API_KEY: "k" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("the seat file refuses");
		expect(r.stderr).not.toContain("ANTHROPIC_API_KEY");
	});

	it("leaves an overflow seat's auth to the headless launcher", () => {
		seats("~/.claude2-api api key=K grant=200 cycle-day=20\n");
		const r = gates([path.join(home, ".claude2-api"), "K"], {
			ANTHROPIC_API_KEY: "k",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("overflow off\n");
	});
});
