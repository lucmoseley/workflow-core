// @vitest-environment node
/*
 * Pins lib/dispatch-gates.js, dispatch-sessions.sh's seat, overflow-key,
 * launch-auth and burn-mode gates in one node start (#4321). Driven through
 * its CLI against a `claude` stub answering `auth status`.
 *
 * Loosen one and a mistyped overflow line launches as a plan seat, an overflow
 * launch runs on no key, or a launch bills other than its seat (#2605, #3701,
 * #2236).
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
let secrets: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-gates-"));
	fs.mkdirSync(path.join(home, ".claude"));
	bin = path.join(home, "claude");
	fs.writeFileSync(bin, `#!/bin/bash\n${buildAuthStatusBranch()}\nexit 9\n`, {
		mode: 0o755,
	});
	secrets = path.join(home, "secrets.env");
	fs.writeFileSync(secrets, "K=sk-fake-overflow\n");
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

const file = () => path.join(home, ".claude", "refill-seats");
const seats = (text: string) => fs.writeFileSync(file(), text);
const marker = () => path.join(home, "burn-mode");
const seat = () => path.join(home, ".claude2");
/**
 * A bare environment: none of the parent's auth or burn marker leaks in. The
 * config dir is the seat's, as dispatch-sessions.sh reads its seat from it.
 */
const gates = (identity: string[], extra: Record<string, string> = {}) =>
	runInProcess(SCRIPT, ["--", ...identity], {
		env: {
			PATH: process.env.PATH,
			HOME: home,
			...(identity[0] ? { CLAUDE_CONFIG_DIR: identity[0] } : {}),
			WFC_CLAUDE_BIN: bin,
			WFC_BURN_MARKER: marker(),
			WFC_SECRETS_FILE: secrets,
			...extra,
		},
		cwd: home,
	});
const overflowLines = () => "ANTHROPIC_API_KEY K CLAUDE_CODE_SESSION_ID\n";

describe("the seat kind", () => {
	it("refuses a call naming no config dir, or an option", () => {
		expect(gates([]).status).toBe(2);
		const r = runInProcess(SCRIPT, ["--help"], { env: {} });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage:");
	});

	it("prints each declared seat's kind, however its dir is spelt", () => {
		seats("~/.claude2\n~/.claude2 api key=K grant=200 cycle-day=20\n");
		const overflow = gates([`${seat()}/`, "K"]);
		expect(overflow.status).toBe(0);
		expect(overflow.stdout).toBe(`overflow off\n${overflowLines()}`);
		const plan = gates([seat()]);
		expect(plan.status).toBe(0);
		expect(plan.stdout).toBe("plan off\n");
	});

	it("takes an undeclared dir as a plan seat", () => {
		seats("~/.claude2\n~/.claude2 api key=K grant=200 cycle-day=20\n");
		const r = gates([path.join(home, ".claude")]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("plan off\n");
	});

	it("refuses a malformed seat file, naming the line", () => {
		seats("~/.claude2\n~/.claude2-api api key=K grant=200\n");
		const r = gates([seat()]);
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain(
			`REFUSED: the seat file refuses (seat ${seat()}):`,
		);
		expect(r.stderr).toContain(`  ${file()}:2: missing cycle-day=`);
	});

	it("refuses an overflow line naming a dir no plan line declares (#3701)", () => {
		seats("~/.claude2\n~/.claude2-api api key=K grant=200 cycle-day=20\n");
		const r = gates([seat()]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("~/.claude2-api has no plan seat line");
	});

	describe("on a dir a plan and an overflow seat share (#3693)", () => {
		const other = () => path.join(home, ".claude3");
		beforeEach(() =>
			seats(
				"~/.claude2\n~/.claude2 api key=K grant=200 cycle-day=20\n~/.claude3\n~/.claude3 api key=K3 grant=100 cycle-day=28\n",
			),
		);

		it("prints each kind", () => {
			const plan = gates([seat()]);
			expect(plan.status).toBe(0);
			expect(plan.stdout).toBe("plan off\n");
			const overflow = gates([seat(), "K"]);
			expect(overflow.status).toBe(0);
			expect(overflow.stdout).toBe(`overflow off\n${overflowLines()}`);
		});

		it("refuses a key no line declares, or one on another dir", () => {
			const none = gates([seat(), "NOPE"]);
			expect(none.status).toBe(2);
			expect(none.stderr).toContain("no overflow seat has key=NOPE");
			const elsewhere = gates([seat(), "K3"]);
			expect(elsewhere.status).toBe(2);
			expect(elsewhere.stderr).toContain(
				`key=K3 is ${other()}'s overflow seat, not ${seat()}'s`,
			);
		});
	});
});

describe("the overflow key (#3701)", () => {
	beforeEach(() =>
		seats("~/.claude2\n~/.claude2 api key=K grant=200 cycle-day=20\n"),
	);

	it("refuses a key the secrets file lacks, naming it and printing no value", () => {
		fs.writeFileSync(secrets, "OTHER=sk-fake-other\n");
		const r = gates([seat(), "K"]);
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain(
			`REFUSED: overflow seat ${seat()}: K is not set in ${secrets}`,
		);
		expect(r.stderr).not.toContain("sk-fake");
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
		const r = gates([seat()], { ANTHROPIC_API_KEY: "k" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("the seat file refuses");
		expect(r.stderr).not.toContain("ANTHROPIC_API_KEY");
	});

	describe("on an overflow seat", () => {
		beforeEach(() =>
			seats("~/.claude2\n~/.claude2 api key=K grant=200 cycle-day=20\n"),
		);

		it("judges the child's environment, which drops the caller's key", () => {
			const r = gates([seat(), "K"], {
				ANTHROPIC_API_KEY: "k",
				K: "sk-fake-in-env",
			});
			expect(r.status).toBe(0);
			expect(r.stdout).toBe(`overflow off\n${overflowLines()}`);
		});

		it("admits a dir with no login of its own, through the key's helper", () => {
			const r = gates([seat(), "K"], { WFC_FAKE_AUTH_NO_LOGIN: "1" });
			expect(r.status).toBe(0);
		});

		it("still refuses a provider set in the shell", () => {
			const r = gates([seat(), "K"], { CLAUDE_CODE_USE_BEDROCK: "1" });
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("CLAUDE_CODE_USE_BEDROCK is set");
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
