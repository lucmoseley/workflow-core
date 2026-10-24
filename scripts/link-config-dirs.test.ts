// @vitest-environment node
/*
 * Pins link-config-dirs.js, which merges each plan's shared Claude config into
 * ~/.claude and symlinks it back: what it unions, what wins a clash, that it
 * never deletes a copy, and its --check lines.
 *
 * Every test runs against a fake home in a temp dir, because the real script
 * moves files in the founder's live config dirs.
 *
 * Breaking it loses a plan's plugins or settings in a merge, or lets the three
 * plans drift apart again (#107).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";
import { run } from "./link-config-dirs.js";

const SCRIPT = path.join(__dirname, "link-config-dirs.js");

let home: string;
let one: string;
let two: string;

const put = (p: string, body: string) => {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
};
const json = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const cli = (...args: string[]) =>
	runInProcess(SCRIPT, ["--home", home, ...args]);

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "link-config-dirs-"));
	one = path.join(home, ".claude");
	two = path.join(home, ".claude2");
	fs.mkdirSync(one);
	fs.mkdirSync(two);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("link-config-dirs (#107)", () => {
	it("links an entry the sibling lacks, relative, like the hand-made links", () => {
		put(path.join(one, "keybindings.json"), "{}\n");
		run({ home });
		expect(fs.readlinkSync(path.join(two, "keybindings.json"))).toBe(
			"../.claude/keybindings.json",
		);
	});

	it("unions a diverged directory: the sibling's extras copied in, ~/.claude's copy winning a clash", () => {
		put(path.join(one, "skills/a/SKILL.md"), "one");
		put(path.join(two, "skills/a/SKILL.md"), "two");
		put(path.join(two, "skills/b/SKILL.md"), "new");
		const { kept } = run({ home });
		expect(fs.readFileSync(path.join(one, "skills/b/SKILL.md"), "utf8")).toBe(
			"new",
		);
		expect(fs.readFileSync(path.join(one, "skills/a/SKILL.md"), "utf8")).toBe(
			"one",
		);
		expect(kept).toEqual([path.join(two, "skills/a/SKILL.md")]);
		// Reachable through the sibling, as a live session there reads it.
		expect(fs.readFileSync(path.join(two, "skills/b/SKILL.md"), "utf8")).toBe(
			"new",
		);
	});

	it("never deletes the sibling's copy: it moves under .pre-link", () => {
		put(path.join(one, "skills/a/SKILL.md"), "one");
		put(path.join(two, "skills/a/SKILL.md"), "two");
		run({ home });
		expect(
			fs.readFileSync(path.join(two, ".pre-link/skills/a/SKILL.md"), "utf8"),
		).toBe("two");
		expect(fs.lstatSync(path.join(two, "skills")).isSymbolicLink()).toBe(true);
	});

	it("moves a sibling-only entry into ~/.claude before linking it", () => {
		put(path.join(two, "statusline.sh"), "echo hi\n");
		run({ home });
		expect(fs.readFileSync(path.join(one, "statusline.sh"), "utf8")).toBe(
			"echo hi\n",
		);
		expect(fs.readlinkSync(path.join(two, "statusline.sh"))).toBe(
			"../.claude/statusline.sh",
		);
	});

	it("merges installed_plugins.json entry by entry, re-homing install paths", () => {
		const reg = "plugins/installed_plugins.json";
		put(
			path.join(one, reg),
			JSON.stringify({
				version: 2,
				plugins: {
					"wc@wc": [
						{
							scope: "project",
							projectPath: "/a",
							version: "1.1.1",
							installPath: path.join(one, "plugins/cache/wc/wc/1.1.1"),
							lastUpdated: "2026-09-01T00:00:00Z",
						},
					],
				},
			}),
		);
		put(
			path.join(two, reg),
			JSON.stringify({
				version: 2,
				plugins: {
					"wc@wc": [
						{
							scope: "project",
							projectPath: "/a",
							version: "1.1.5",
							installPath: path.join(two, "plugins/cache/wc/wc/1.1.5"),
							lastUpdated: "2026-09-18T00:00:00Z",
						},
						{
							scope: "local",
							projectPath: "/b",
							version: "1.1.1",
							installPath: path.join(two, "plugins/cache/wc/wc/1.1.1"),
							lastUpdated: "2026-09-02T00:00:00Z",
						},
					],
				},
			}),
		);
		const { kept } = run({ home });
		const entries = json(path.join(one, reg)).plugins["wc@wc"];
		expect(entries).toHaveLength(2);
		expect(
			entries.find((e: { projectPath: string }) => e.projectPath === "/a"),
		).toMatchObject({
			version: "1.1.5",
			installPath: path.join(one, "plugins/cache/wc/wc/1.1.5"),
		});
		expect(
			entries.find((e: { projectPath: string }) => e.projectPath === "/b")
				.installPath,
		).toBe(path.join(one, "plugins/cache/wc/wc/1.1.1"));
		expect(kept).toEqual([]);
	});

	it("merges known_marketplaces.json, adding what only the sibling knows", () => {
		const reg = "plugins/known_marketplaces.json";
		put(path.join(one, reg), JSON.stringify({ a: { lastUpdated: "1" } }));
		put(
			path.join(two, reg),
			JSON.stringify({
				wc: {
					installLocation: path.join(two, "plugins/marketplaces/wc"),
					lastUpdated: "2",
				},
			}),
		);
		run({ home });
		expect(json(path.join(one, reg))).toEqual({
			a: { lastUpdated: "1" },
			wc: {
				installLocation: path.join(one, "plugins/marketplaces/wc"),
				lastUpdated: "2",
			},
		});
	});

	it("re-points a link aimed elsewhere", () => {
		const three = path.join(home, ".claude3");
		fs.mkdirSync(three);
		put(path.join(one, "settings.json"), "{}\n");
		put(path.join(two, "settings.json"), '{"x":1}\n');
		fs.symlinkSync(
			"../.claude2/settings.json",
			path.join(three, "settings.json"),
		);
		run({ home });
		expect(fs.readlinkSync(path.join(three, "settings.json"))).toBe(
			"../.claude/settings.json",
		);
	});

	it("is idempotent: a second run finds no drift and moves nothing", () => {
		put(path.join(one, "skills/a/SKILL.md"), "one");
		put(path.join(two, "skills/b/SKILL.md"), "two");
		run({ home });
		expect(run({ home }).drift).toEqual([]);
		expect(fs.readdirSync(path.join(two, ".pre-link"))).toEqual(["skills"]);
	});

	it("leaves an entry neither dir has alone, and never touches per-account state", () => {
		put(path.join(two, ".credentials.json"), "secret");
		put(path.join(two, "history.jsonl"), "h");
		run({ home });
		expect(fs.readdirSync(two).sort()).toEqual([
			".credentials.json",
			"history.jsonl",
		]);
	});

	it("keeps ~/.claude's git clone whole rather than splicing the sibling's into it (F1)", () => {
		const m = "plugins/marketplaces/wc";
		put(path.join(one, m, ".git/HEAD"), "one");
		put(path.join(one, m, "a.js"), "one");
		put(path.join(two, m, ".git/HEAD"), "two");
		put(path.join(two, m, "extra.js"), "two");
		const { kept } = run({ home });
		expect(fs.existsSync(path.join(one, m, "extra.js"))).toBe(false);
		expect(fs.readFileSync(path.join(one, m, ".git/HEAD"), "utf8")).toBe("one");
		expect(kept).toEqual([path.join(two, m)]);
		expect(
			fs.readFileSync(path.join(two, ".pre-link", m, "extra.js"), "utf8"),
		).toBe("two");
	});

	it("keeps a cached plugin version whole on a clash, but takes a version only the sibling has", () => {
		put(path.join(one, "plugins/cache/m/p/1.0.0/a.js"), "one");
		put(path.join(two, "plugins/cache/m/p/1.0.0/b.js"), "two");
		put(path.join(two, "plugins/cache/m/p/2.0.0/a.js"), "new");
		run({ home });
		expect(fs.existsSync(path.join(one, "plugins/cache/m/p/1.0.0/b.js"))).toBe(
			false,
		);
		expect(
			fs.readFileSync(path.join(one, "plugins/cache/m/p/2.0.0/a.js"), "utf8"),
		).toBe("new");
	});

	it("takes a misdirected link's target into ~/.claude rather than leaving it dangling (F2)", () => {
		put(path.join(home, "elsewhere/x.md"), "x");
		fs.symlinkSync(path.join(home, "elsewhere"), path.join(two, "agents"));
		run({ home });
		expect(fs.readFileSync(path.join(two, "agents/x.md"), "utf8")).toBe("x");
		expect(run({ home }).drift).toEqual([]);
	});

	it("leaves a misdirected link that resolves nowhere when ~/.claude has nothing to aim it at", () => {
		fs.symlinkSync(path.join(home, "gone"), path.join(two, "agents"));
		run({ home });
		expect(fs.readlinkSync(path.join(two, "agents"))).toBe(
			path.join(home, "gone"),
		);
		expect(fs.existsSync(path.join(two, ".pre-link"))).toBe(false);
	});

	it("re-homes a registry copied whole because ~/.claude had none (F3)", () => {
		const reg = "plugins/installed_plugins.json";
		put(path.join(one, "plugins/other"), "o");
		put(
			path.join(two, reg),
			JSON.stringify({
				version: 2,
				plugins: {
					"wc@wc": [
						{
							scope: "user",
							installPath: path.join(two, "plugins/cache/wc/wc/1.1.5"),
						},
					],
				},
			}),
		);
		run({ home });
		const reg1 = json(path.join(one, reg));
		expect(reg1.version).toBe(2);
		expect(reg1.plugins["wc@wc"][0].installPath).toBe(
			path.join(one, "plugins/cache/wc/wc/1.1.5"),
		);
	});

	it("backs up ~/.claude's own registry before a merge rewrites it (F4)", () => {
		const reg = "plugins/known_marketplaces.json";
		put(path.join(one, reg), '{"a":{"lastUpdated":"1"}}');
		put(path.join(two, reg), '{"b":{"lastUpdated":"2"}}');
		run({ home });
		expect(fs.readFileSync(path.join(one, ".pre-link", reg), "utf8")).toBe(
			'{"a":{"lastUpdated":"1"}}',
		);
	});

	it("never overwrites an earlier backup, however close the runs (F5)", () => {
		for (const body of ["first", "second"]) {
			put(path.join(one, "CLAUDE.md"), "one");
			fs.rmSync(path.join(two, "CLAUDE.md"), { force: true });
			put(path.join(two, "CLAUDE.md"), body);
			run({ home });
		}
		expect(fs.readFileSync(path.join(two, ".pre-link/CLAUDE.md"), "utf8")).toBe(
			"first",
		);
		expect(
			fs.readFileSync(path.join(two, ".pre-link/CLAUDE.md.1"), "utf8"),
		).toBe("second");
	});

	describe("the CLI", () => {
		it("--check reports and exits 1 on drift, changing nothing", () => {
			put(path.join(one, "keybindings.json"), "{}\n");
			const r = cli("--check");
			expect(r.status).toBe(1);
			expect(r.stdout).toContain(
				`missing\t${path.join(two, "keybindings.json")}`,
			);
			expect(r.stdout).toContain(
				`Fix: node ${path.join(__dirname, "link-config-dirs.js")}`,
			);
			expect(fs.existsSync(path.join(two, "keybindings.json"))).toBe(false);
		});

		it("--check exits 0 once linked, on the OK line npm run status folds away", () => {
			put(path.join(one, "keybindings.json"), "{}\n");
			cli();
			const r = cli("--check");
			expect(r.status).toBe(0);
			expect(r.stdout.trim()).toBe(
				"OK: every shared entry is linked to ~/.claude",
			);
		});

		/* `sed -i` through the link leaves the sibling a plain file (#2322). */
		it("links practice-crafts.md, and --check reports it once a plain copy replaces the link", () => {
			put(path.join(one, "practice-crafts.md"), "- a-craft: covers.\n");
			cli();
			expect(fs.readlinkSync(path.join(two, "practice-crafts.md"))).toBe(
				"../.claude/practice-crafts.md",
			);
			fs.rmSync(path.join(two, "practice-crafts.md"));
			put(path.join(two, "practice-crafts.md"), "- a-craft: edited.\n");
			const r = cli("--check");
			expect(r.status).toBe(1);
			expect(r.stdout).toContain(
				`diverged\t${path.join(two, "practice-crafts.md")}`,
			);
			expect(r.stdout).toContain(
				`Fix: node ${path.join(__dirname, "link-config-dirs.js")}`,
			);
		});

		it("refuses an unknown flag, naming it", () => {
			const r = cli("--no-such-flag");
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("unknown flag: --no-such-flag");
		});
	});
	describe("overflow seats (#2605)", () => {
		const api = () => path.join(home, ".claude2-api");
		beforeEach(() => {
			put(
				path.join(one, "refill-seats"),
				"~/.claude2\n~/.claude2-api api key=K grant=200 cycle-day=20\n",
			);
			put(path.join(one, "settings.json"), "{}\n");
			put(path.join(one, "CLAUDE.md"), "rules\n");
			put(path.join(one, "skills/a/SKILL.md"), "a");
			put(path.join(one, "plugins/installed_plugins.json"), "{}\n");
		});

		it("creates a declared overflow dir and links the shared set into it, leaving its .claude.json its own", () => {
			const r = cli();
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`created ${api()}`);
			for (const entry of ["settings.json", "CLAUDE.md", "skills", "plugins"])
				expect(fs.readlinkSync(path.join(api(), entry))).toBe(
					`../.claude/${entry}`,
				);
			expect(fs.existsSync(path.join(api(), ".claude.json"))).toBe(false);
			expect(cli("--check").status).toBe(0);
		});

		it("--check reports an absent overflow dir, creating nothing", () => {
			const r = cli("--check");
			expect(r.status).toBe(1);
			expect(r.stdout).toContain(`missing\t${api()}`);
			expect(fs.existsSync(api())).toBe(false);
		});

		it("--check reports a broken link in an overflow dir", () => {
			cli();
			fs.rmSync(path.join(api(), "skills"));
			fs.symlinkSync("../nowhere/skills", path.join(api(), "skills"));
			const r = cli("--check");
			expect(r.status).toBe(1);
			expect(r.stdout).toContain(`misdirected\t${path.join(api(), "skills")}`);
		});

		it("refuses a malformed seat file, naming the line", () => {
			put(path.join(one, "refill-seats"), "~/.claude2-api api key=K\n");
			const r = cli("--check");
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(
				`${path.join(one, "refill-seats")}:1: missing grant=, cycle-day=`,
			);
		});
	});
});
