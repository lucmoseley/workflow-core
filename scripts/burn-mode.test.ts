// @vitest-environment node
/*
 * Pins that burn-mode.sh's `on` moves Opus 5.5's effort to high in every plan
 * and never its model, that `off` puts back what `on` found — or, with no
 * record, reverts only a plan still on the burn effort — and that `status`
 * writes nothing (#126, #127, #355).
 *
 * burn-mode.sh is the switch: a marker file the guard and the launcher read,
 * and Opus 5.5's per-model effort in every plan's settings.json. Both writes land in a
 * scratch HOME and a scratch marker here — the real ones are the machine's
 * live default.
 *
 * The burn-mode skill runs it, and lib/dispatch-rewrite.js and
 * dispatch-sessions.sh read its marker: loosen a case and an `off` can leave a
 * plan burning allowance at high effort unannounced, or an `on` can flatten
 * an effort the founder set by hand.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "burn-mode.sh");

let dir: string;
let home: string;
let marker: string;

const settings = (plan: string) => path.join(home, plan, "settings.json");
const read = (plan: string) =>
	JSON.parse(fs.readFileSync(settings(plan), "utf8"));
const effortOf = (plan: string) =>
	read(plan).modelSettings?.["claude-opus-5-5"]?.effortLevel;
const write = (plan: string, json: object) =>
	fs.writeFileSync(settings(plan), JSON.stringify(json));
const withEffort = (effortLevel: string) => ({
	model: "claude-opus-5-5[1m]",
	modelSettings: { "claude-opus-5-5": { effortLevel } },
});

const run = (arg: string, asHome = home) => {
	const r = spawnSync(SCRIPT, [arg], {
		encoding: "utf8",
		env: { ...process.env, HOME: asHome, WFC_BURN_MARKER: marker },
	});
	if (r.status === null) throw new Error(`script did not run: ${r.error}`);
	return r;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-mode-"));
	home = path.join(dir, "home");
	marker = path.join(dir, "burn-mode");
	for (const plan of [".claude", ".claude2"]) {
		fs.mkdirSync(path.join(home, plan), { recursive: true });
		write(plan, {
			model: "claude-opus-5-5[1m]",
			modelSettings: {
				"claude-opus-5": { effortLevel: "medium" },
				"claude-opus-5-5": { effortLevel: "medium" },
			},
			effortLevel: "medium",
			keep: 1,
		});
	}
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("on", () => {
	it("writes the marker and moves every plan's Opus 5.5 effort to high", () => {
		const r = run("on");
		expect(r.status).toBe(0);
		expect(fs.existsSync(marker)).toBe(true);
		expect(effortOf(".claude")).toBe("high");
		expect(effortOf(".claude2")).toBe("high");
	});

	it("touches nothing but Opus 5.5's effort — never the model", () => {
		run("on");
		expect(read(".claude")).toEqual({
			model: "claude-opus-5-5[1m]",
			modelSettings: {
				"claude-opus-5": { effortLevel: "medium" },
				"claude-opus-5-5": { effortLevel: "high" },
			},
			effortLevel: "medium",
			keep: 1,
		});
	});

	// mantahostels#3547
	it("run twice with no off between leaves the first on's record intact", () => {
		write(".claude2", withEffort("low"));
		run("on");
		const r = run("on");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("already on");
		run("off");
		expect(effortOf(".claude")).toBe("medium");
		expect(effortOf(".claude2")).toBe("low");
	});
});

describe("the closing warnings", () => {
	// #568
	it.each(["on", "off"])(
		"%s says a restart is needed and names both stale sessions",
		(mode) => {
			const r = run(mode);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`burn mode: ${mode}`);
			expect(r.stdout).toMatch(/restart/i);
			expect(r.stdout).toContain("bg-spare");
			expect(r.stdout).toMatch(/agents view/);
			expect(r.stdout).toMatch(/launch line/);
			expect(r.stdout).toMatch(/throwaway/);
		},
	);

	it("status prints neither", () => {
		const r = run("status");
		expect(r.stdout).not.toContain("bg-spare");
		expect(r.stdout).not.toMatch(/launch line/);
	});
});

describe("off", () => {
	it("removes the marker and restores medium", () => {
		run("on");
		const r = run("off");
		expect(r.status).toBe(0);
		expect(fs.existsSync(marker)).toBe(false);
		expect(effortOf(".claude")).toBe("medium");
		expect(effortOf(".claude2")).toBe("medium");
	});

	// mantahostels#130: off used to flatten a hand-set plan
	it("restores what on found, not the standing default", () => {
		write(".claude2", withEffort("xhigh"));
		run("on");
		expect(effortOf(".claude2")).toBe("high");
		run("off");
		expect(effortOf(".claude2")).toBe("xhigh");
		expect(effortOf(".claude")).toBe("medium");
	});

	it("touches no settings file when already off", () => {
		write(".claude", withEffort("low"));
		const r = run("off");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("already off");
		expect(effortOf(".claude")).toBe("low");
	});

	/* #126, which this file's four cases below guard. */
	it("restores a plan stranded on high when the marker has gone", () => {
		run("on");
		fs.rmSync(marker);
		const r = run("off");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("no record for");
		expect(effortOf(".claude")).toBe("medium");
		expect(effortOf(".claude2")).toBe("medium");
	});

	it("leaves a plan on some other effort alone when the marker has gone", () => {
		run("on");
		fs.rmSync(marker);
		write(".claude2", withEffort("low"));
		const r = run("off");
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain(".claude2/settings.json — restoring");
		expect(effortOf(".claude")).toBe("medium");
		expect(effortOf(".claude2")).toBe("low");
	});

	it("restores a plan added after on, which the record cannot name", () => {
		run("on");
		fs.mkdirSync(path.join(home, ".claude3"));
		write(".claude3", withEffort("high"));
		const r = run("off");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("no record for .claude3/settings.json");
		expect(effortOf(".claude3")).toBe("medium");
	});

	/* A read-only plan directory is the only fixture that reaches the
	 * self-check: the write renames over the file, which a read-only file
	 * alone does not stop. */
	it("exits 1 naming the plan it could not move off the burn effort", () => {
		run("on");
		fs.rmSync(marker);
		const plan = path.dirname(settings(".claude2"));
		fs.chmodSync(plan, 0o555);
		const r = run("off");
		fs.chmodSync(plan, 0o755);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("still on the burn effort after off");
		expect(r.stderr).toContain(".claude2/settings.json");
		expect(effortOf(".claude2")).toBe("high");
		expect(effortOf(".claude")).toBe("medium");
	});

	it("leaves a plan that was already on high before on there, exiting 0", () => {
		write(".claude2", withEffort("high"));
		run("on");
		const r = run("off");
		expect(r.status).toBe(0);
		expect(effortOf(".claude2")).toBe("high");
		expect(effortOf(".claude")).toBe("medium");
	});

	it("removes the key again from a plan that had none, keeping the rest", () => {
		write(".claude2", { keep: 1 });
		run("on");
		expect(effortOf(".claude2")).toBe("high");
		const r = run("off");
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("no record for");
		expect(read(".claude2")).toEqual({ keep: 1 });
	});

	it("keeps a sibling model's settings when removing the key", () => {
		write(".claude2", {
			modelSettings: { "claude-opus-5": { effortLevel: "medium" } },
		});
		run("on");
		run("off");
		expect(read(".claude2")).toEqual({
			modelSettings: { "claude-opus-5": { effortLevel: "medium" } },
		});
	});

	/* #187: the machine's ~/.claude2 and ~/.claude3 settings.json are symlinks
	 * to ~/.claude's, so three paths are one file. */
	it("treats a plan whose settings.json is a symlink to another's as one file", () => {
		fs.rmSync(settings(".claude2"));
		// Built, not spelt: a literal here would read to the extractor as this
		// test reading the repo's own .claude/settings.json.
		fs.symlinkSync(
			path.relative(path.dirname(settings(".claude2")), settings(".claude")),
			settings(".claude2"),
		);
		const on = run("on");
		expect(on.status).toBe(0);
		// fs.realpathSync, because the scratch HOME is under os.tmpdir(), which
		// is a symlink on some hosts and would not equal the script's resolved
		// key there.
		expect(
			Object.keys(JSON.parse(fs.readFileSync(marker, "utf8")).effort),
		).toEqual([fs.realpathSync(settings(".claude"))]);
		const r = run("off");
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("still on the burn effort");
		expect(effortOf(".claude")).toBe("medium");
		// The alias is gone AND the real file is still listed — a status
		// listing no plan at all would satisfy the negative on its own.
		const listed = run("status").stdout;
		expect(listed).toContain(".claude/settings.json");
		expect(listed).not.toContain(".claude2/settings.json");
	});

	/* A settings.json symlinked to nothing is named and skipped, rather than
	 * emitting an empty path that jq then refuses without naming it. */
	it("names and skips a plan whose settings.json resolves to nothing", () => {
		fs.rmSync(settings(".claude2"));
		fs.symlinkSync("./gone.json", settings(".claude2"));
		const r = run("on");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(".claude2/settings.json");
		expect(effortOf(".claude")).toBe("high");
		expect(run("off").status).toBe(0);
		expect(effortOf(".claude")).toBe("medium");
	});

	it("is idempotent — off when already off still exits 0", () => {
		expect(run("off").status).toBe(0);
	});
});

describe("status", () => {
	it("reports off and each plan's effort without writing", () => {
		const before = fs.readFileSync(settings(".claude"), "utf8");
		const r = run("status");
		expect(r.stdout).toContain("burn mode: off");
		expect(r.stdout).toContain(".claude/settings.json");
		expect(r.stdout).toContain("claude-opus-5-5 effort=medium");
		expect(fs.readFileSync(settings(".claude"), "utf8")).toBe(before);
	});

	it("reports on, at high in every plan, after on", () => {
		run("on");
		const out = run("status").stdout;
		expect(out).toContain("burn mode: on");
		expect(out.match(/claude-opus-5-5 effort=high\n/g)).toHaveLength(2);
	});

	it("flags a plan whose effort disagrees with the mode", () => {
		write(".claude2", withEffort("high"));
		const out = run("status").stdout;
		expect(out).toMatch(/\.claude2\/settings\.json.*not the standing default/);
		expect(out).not.toMatch(/\.claude\/settings\.json.*not the/);
	});
});

/*
 * #127. These two are the only cases here driven WITHOUT WFC_BURN_MARKER —
 * the resolver's own answer is what is under test, and the scratch HOME is
 * what keeps it out of the machine's real ~/.claude. The two roots are real
 * git repos, so a resolver that quietly started reading git again would fail
 * on the assertion rather than on a missing repo.
 */
describe("the marker is one per machine, not one per checkout", () => {
	const repo = (name: string) => {
		const at = path.join(dir, name);
		fs.mkdirSync(at, { recursive: true });
		spawnSync("git", ["init", "-q"], { cwd: at });
		return at;
	};

	/* CLAUDE_PROJECT_DIR is dropped because the resolver reads it first
	 * (lib/host-root.js): inherited, both scratch checkouts would have
	 * resolved to the real repo, and the write would land on the live marker. */
	const runIn = (at: string, arg: string) => {
		const { CLAUDE_PROJECT_DIR: _drop, ...env } = process.env;
		return spawnSync(SCRIPT, [arg], {
			cwd: at,
			encoding: "utf8",
			env: { ...env, HOME: home, WFC_BURN_MARKER: "" },
		});
	};

	it("an on in one checkout is ended by an off in another", () => {
		const a = repo("checkout-a");
		const b = repo("checkout-b");
		expect(runIn(a, "on").status).toBe(0);
		expect(runIn(b, "status").stdout).toContain("burn mode: on");
		expect(runIn(b, "off").status).toBe(0);
		expect(runIn(a, "status").stdout).toContain("burn mode: off");
		expect(effortOf(".claude")).toBe("medium");
	});

	it("writes it beside the settings files it is the record for", () => {
		runIn(repo("checkout-c"), "on");
		expect(fs.existsSync(path.join(home, ".claude", ".burn-mode"))).toBe(true);
	});
});

/* #2532: a `.claude*` dir that is no `.claude<digits>` — the arm-test dirs —
 * is no plan, so burn mode neither moves nor records it. */
describe("the plan dirs", () => {
	it("leaves a non-plan .claude* dir alone through on, status and off", () => {
		fs.rmSync(settings(".claude2"));
		fs.symlinkSync(
			path.relative(path.dirname(settings(".claude2")), settings(".claude")),
			settings(".claude2"),
		);
		fs.mkdirSync(path.join(home, ".claude-exp-a"));
		write(".claude-exp-a", withEffort("medium"));
		expect(run("on").status).toBe(0);
		expect(effortOf(".claude")).toBe("high");
		expect(effortOf(".claude-exp-a")).toBe("medium");
		expect(
			Object.keys(JSON.parse(fs.readFileSync(marker, "utf8")).effort),
		).toEqual([fs.realpathSync(settings(".claude"))]);
		const listed = run("status").stdout;
		expect(listed).toContain(".claude/settings.json");
		expect(listed).not.toContain(".claude-exp-a");
		expect(listed).not.toContain(".claude2/settings.json");
		write(".claude-exp-a", withEffort("high"));
		expect(run("off").status).toBe(0);
		expect(effortOf(".claude")).toBe("medium");
		expect(effortOf(".claude-exp-a")).toBe("high");
	});

	it("finds the plans under a HOME that is itself a symlink", () => {
		const linked = path.join(dir, "linked-home");
		fs.symlinkSync(home, linked);
		expect(run("on", linked).status).toBe(0);
		expect(effortOf(".claude")).toBe("high");
		expect(effortOf(".claude2")).toBe("high");
	});

	it("refuses on, recording nothing, when HOME cannot be read", () => {
		const r = run("on", path.join(dir, "no-such-home"));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("plan-dirs:");
		expect(fs.existsSync(marker)).toBe(false);
	});
});

describe("usage", () => {
	it("refuses an unknown verb, naming the three it takes", () => {
		const r = run("maybe");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("on|off|status");
	});
});
