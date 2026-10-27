// @vitest-environment node
/*
 * Pins that check-plugin-gap.js's report names an open adopter-upgrade gap
 * with the exact, paste-safe command that closes it, leaves an install at its
 * pin alone, predicts the #258 ref conflict and surfaces owed steps.
 *
 * The reporter is #243's. The fixture tree comes from
 * `lib/plugin-state-testkit.ts`, shared with the four-record read's own tests
 * (#251 item 13).
 *
 * Every case runs `check-plugin-gap.js --notify` end to end through
 * `runInProcess` and reads the report back out of the hook's
 * `additionalContext`. One pipes the printed commands through `bash -c`,
 * because a paste into bash is the only test of their quoting (#430).
 *
 * It is a SessionStart `--notify` hook whose text reaches the model verbatim:
 * loosen a case and a session in a stale adopter invents its own upgrade
 * sequence, or pastes a command whose quoting runs shell.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { decline } from "./lib/adopter-consent.js";
import { renderHookShim } from "./lib/adopter-skeleton.js";
import { adopterFixtures, writeJson } from "./lib/plugin-state-testkit.js";
import { runInProcess } from "./lib/run-in-process.js";
import { appendStepsOwed, declineStepOwed } from "./lib/steps-owed.js";

const SCRIPT = path.join(__dirname, "check-plugin-gap.js");
const fixture = adopterFixtures("wfc-check-plugin-gap-");

/**
 * The report as the SessionStart hook hands it to the session, or null where
 * `--notify` prints nothing. `pluginRoot` is the session's CLAUDE_PLUGIN_ROOT,
 * absent for a session with none. Every seat the consent store scans is
 * `configDir`, so a decline a case records there is the one the run reads.
 */
function report({
	root,
	pluginRoot,
	configDir,
}: {
	root: string;
	pluginRoot?: string;
	configDir: string;
}): string | null {
	const r = runInProcess(SCRIPT, ["--notify"], {
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: root,
			CLAUDE_PLUGIN_ROOT: pluginRoot,
			CLAUDE_CONFIG_DIR: configDir,
			WORKFLOW_CORE_DIR: undefined,
			WORKFLOW_CORE_CHECKOUT: undefined,
			WFC_CLAUDE_CONFIG_A: configDir,
			WFC_CLAUDE_CONFIG_B: configDir,
			WFC_CLAUDE_CONFIG_C: configDir,
		},
	});
	expect(r.status).toBe(0);
	if (r.stdout === "") return null;
	return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

describe("check-plugin-gap.js's report (#243)", () => {
	it("prints nothing where both gaps are closed", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
		});

		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});

	it("names the gap, the exact command, all three records and the rule id", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain("supply behind pin");
		expect(text).toContain("install behind supply");
		expect(text).toContain(
			"claude plugin marketplace add <url>#v1.1.11 --scope project",
		);
		expect(text).toContain(
			"claude plugin install workflow-core@wc -y --scope project",
		);
		expect(text).toContain(
			"claude plugin update workflow-core@wc --scope project -y",
		);
		expect(text).toContain("pin is v1.1.11, supply is on main, running 1.1.8.");
		expect(text).toContain("THE THREE `claude` CALLS ARE ONE SEQUENCE");
		expect(text).toContain("THE COMMITTED PIN IS THE CONSENT TOKEN");
		// the plugin-rooted absolute path, never a bare `scripts/…` — no
		// adopter repo carries this file (#245's spec-fidelity finding)
		expect(text).toContain(`${pluginRoot}/scripts/adopter-consent.js accept`);
		expect(text).toContain(`${pluginRoot}/scripts/adopter-consent.js decline`);
	});

	it("stays silent for a repo+tag the founder already declined (#245)", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		decline(root, "v1.1.11", { configDir });

		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});

	it("still reports a different tag in the same repo (#245)", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		decline(root, "v1.1.12", { configDir });

		expect(report({ root, pluginRoot, configDir })).not.toBeNull();
	});

	it("gives no report for a directory-sourced adopter", () => {
		const { root, pluginRoot, configDir } = fixture({ pinSource: "directory" });
		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});

	it("--notify prints nothing and exits 0 on a clean adopter", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
		});

		const r = runInProcess(SCRIPT, ["--notify"], {
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: root,
				CLAUDE_PLUGIN_ROOT: pluginRoot,
				CLAUDE_CONFIG_DIR: configDir,
			},
		});
		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("check-plugin-gap.js's corrected reporting (#251)", () => {
	it("names the running version, not the supply's ref, as what install behind supply is behind", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.11",
		});

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain("workflow-core: install behind supply —");
		// the gap list names one gap, so no `marketplace add` for this pin is
		// printed; the fragment below still quotes the template form
		expect(text).not.toContain("marketplace add <url>#v1.1.11");
		// the old line read "pin is v1.1.11, previously v1.1.11" here, and the
		// running version — the real previous — never appeared (#251 item 4)
		expect(text).toContain(
			"pin is v1.1.11, supply is on v1.1.11, running 1.1.8.",
		);
	});

	it("substitutes the pin's real clone url into the marketplace add command", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			pinUrl: "https://example.invalid/wfc.git",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});

		expect(report({ root, pluginRoot, configDir })).toContain(
			"claude plugin marketplace add https://example.invalid/wfc.git#v1.1.11 --scope project",
		);
	});

	it("gives no report for a branch-pinned adopter", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "main",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});

	it("says materialised but not yet live, with no command and no consent question", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.11",
			loadedVersion: "1.1.8",
			supplyTag: "v1.1.11",
		});

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain("materialised but not yet live");
		expect(text).toContain(
			"1.1.11 is installed, this session is running 1.1.8",
		);
		expect(text).not.toContain("claude plugin");
		expect(text).not.toContain("adopter-consent.js");
	});

	it("--notify refuses a bad invocation with usage on stderr and exit 2", () => {
		const r = runInProcess(SCRIPT, []);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			"usage: node scripts/check-plugin-gap.js --notify",
		);
		expect(r.stdout).toBe("");
	});
});

describe("check-plugin-gap.js leaves an install at its pin alone (#747)", () => {
	it("prints nothing over a supply on another adopter's older tag", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.3.2",
			installedVersion: "1.3.2",
			supplyTag: "v1.3.1",
		});
		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});

	it("still names supply behind pin and all three commands where the install is behind too", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.3.2",
			installedVersion: "1.3.1",
			supplyTag: "v1.3.1",
		});
		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain("supply behind pin");
		expect(text).toContain("marketplace add <url>#v1.3.2 --scope project");
		expect(text).toContain("claude plugin install workflow-core@wc");
		expect(text).toContain("claude plugin update workflow-core@wc");
	});
});

describe("check-plugin-gap.js predicts the #258 ref conflict (#318)", () => {
	function declareUserScope(
		configDir: string,
		marketplace: string,
		source: Record<string, unknown>,
	) {
		writeJson(path.join(configDir, "settings.json"), {
			extraKnownMarketplaces: { [marketplace]: { source } },
		});
	}

	it("names the conflicting ref and the fix, alongside the ordinary gap report", () => {
		const { root, pluginRoot, configDir, marketplace } = fixture({
			pinRef: "v1.1.11",
			pinUrl: "https://example.invalid/wfc.git",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		declareUserScope(configDir, marketplace, {
			source: "url",
			url: "https://example.invalid/wfc.git",
			ref: "v1.1.8",
		});

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain("supply behind pin");
		expect(text).toContain("This rotation is predicted to be refused");
		expect(text).toContain('already declare "wc" at ref v1.1.8');
		expect(text).toContain("rotating it to v1.1.11 under the same name (#258)");
		expect(text).toContain("reconcile the two declarations by hand first");
	});

	it("names a missing user-scope ref as tracking the default branch", () => {
		const { root, pluginRoot, configDir, marketplace } = fixture({
			pinRef: "v1.1.11",
			pinUrl: "https://example.invalid/wfc.git",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		declareUserScope(configDir, marketplace, {
			source: "url",
			url: "https://example.invalid/wfc.git",
		});

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain(
			"at ref (none — tracks the default branch), and the CLI refuses",
		);
	});

	it("stays silent where user scope and the pin agree", () => {
		const { root, pluginRoot, configDir, marketplace } = fixture({
			pinRef: "v1.1.11",
			pinUrl: "https://example.invalid/wfc.git",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		declareUserScope(configDir, marketplace, {
			source: "url",
			url: "https://example.invalid/wfc.git",
			ref: "v1.1.11",
		});

		expect(report({ root, pluginRoot, configDir })).not.toContain(
			"predicted to be refused",
		);
	});

	it("names the remove step for a user-scope directory declaration (#342)", () => {
		const { root, pluginRoot, configDir, marketplace } = fixture({
			pinRef: "v1.1.11",
			pinUrl: "https://example.invalid/wfc.git",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		declareUserScope(configDir, marketplace, {
			source: "directory",
			path: "/some/dir",
		});

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain("This rotation is predicted to be refused");
		expect(text).toContain(`declare "wc" as a directory source`);
		expect(text).toContain("claude plugin marketplace remove wc");
		expect(text).toContain("then run the commands above");
		expect(text).not.toContain("edit user scope's ref");
	});

	it("stays silent where no gap is open, even with a conflicting user-scope ref", () => {
		const { root, pluginRoot, configDir, marketplace } = fixture({
			pinRef: "v1.1.8",
			pinUrl: "https://example.invalid/wfc.git",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
		});
		declareUserScope(configDir, marketplace, {
			source: "url",
			url: "https://example.invalid/wfc.git",
			ref: "v1.1.0",
		});

		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});
});

describe("check-plugin-gap.js surfaces stepsOwed (#248)", () => {
	it("names an owed step and its clear command even with both gaps closed", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
		});
		appendStepsOwed(root, "v1.1.8", [{ type: "act", text: "do a thing" }]);

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain("1 step owed from a prior walk");
		expect(text).toContain("[act] (v1.1.8) do a thing");
		expect(text).toContain(
			`node ${pluginRoot}/scripts/steps-owed.js clear v1.1.8 act 'do a thing'`,
		);
	});

	it("prints both a decline and a clear command for an undeclined choice", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
		});
		appendStepsOwed(root, "v1.1.8", [{ type: "choice", text: "pick one" }]);

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain(
			`node ${pluginRoot}/scripts/steps-owed.js decline v1.1.8 'pick one'`,
		);
		expect(text).toContain(
			`node ${pluginRoot}/scripts/steps-owed.js clear v1.1.8 choice 'pick one'`,
		);
	});

	it("prints commands whose arguments survive a paste through bash verbatim (#430)", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
		});
		const text =
			"set `worktree.bgIsolation` to $HOME's `true`, then \\ $(exit 1)";
		appendStepsOwed(root, "v1.1.9", [{ type: "choice", text }]);

		const printed = report({ root, pluginRoot, configDir }) ?? "";
		const commands = printed
			.split("\n")
			.filter((l) => l.startsWith("    node "))
			.map((l) => l.trim().slice("node ".length));
		expect(commands).toHaveLength(2);
		const parseShellArgv = (cmd: string) =>
			execFileSync("bash", ["-c", `printf '%s\\0' ${cmd}`], {
				encoding: "utf8",
			})
				.split("\0")
				.slice(0, -1);
		const cli = `${pluginRoot}/scripts/steps-owed.js`;
		expect(parseShellArgv(commands[0])).toEqual([
			cli,
			"decline",
			"v1.1.9",
			text,
		]);
		expect(parseShellArgv(commands[1])).toEqual([
			cli,
			"clear",
			"v1.1.9",
			"choice",
			text,
		]);
	});

	it("never re-surfaces a declined choice", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
		});
		appendStepsOwed(root, "v1.1.8", [{ type: "choice", text: "pick one" }]);
		declineStepOwed(root, { tag: "v1.1.8", text: "pick one" });

		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});

	it("surfaces owed steps even with no open gap and stays paired with the version-gap report", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		appendStepsOwed(root, "v1.1.9", [{ type: "notice", text: "fyi" }]);

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain("supply behind pin");
		expect(text).toContain("[notice] (v1.1.9) fyi");
	});

	it("still surfaces owed steps where the pin's own gap was declined (#245)", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		decline(root, "v1.1.11", { configDir });
		appendStepsOwed(root, "v1.1.9", [{ type: "notice", text: "fyi" }]);

		const text = report({ root, pluginRoot, configDir });
		expect(text).not.toContain("supply behind pin");
		expect(text).toContain("[notice] (v1.1.9) fyi");
	});
});

const closed = {
	pinRef: "v1.1.8",
	installedVersion: "1.1.8",
	supplyTag: "v1.1.8",
};

describe("check-plugin-gap.js checks each pre-#1839 hook's WFC_PLUGIN_ROOT (#1168)", () => {
	/** Installs `hooks` in `root` as bootstrap wrote them before #1839,
	 * rooted at `at`. */
	const installHooks = (root: string, at: string, hooks: string[]) => {
		fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
		for (const hook of hooks)
			fs.writeFileSync(
				path.join(root, ".husky", hook),
				`#!/usr/bin/env sh\n# header\nWFC_PLUGIN_ROOT="${at}"\nexport WFC_PLUGIN_ROOT\n`,
			);
	};

	it("FAILs a hook root that no longer exists, naming the hooks and the repoint command", () => {
		const { root, pluginRoot, configDir } = fixture(closed);
		const gone = path.join(path.dirname(pluginRoot), "cache", "1.1.12");
		installHooks(root, gone, ["pre-commit", "pre-push"]);

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain(
			`FAIL: .husky/pre-commit, .husky/pre-push run from ${gone}, which no longer exists`,
		);
		expect(text).toContain("this repo cannot commit");
		expect(text).toContain(
			`node ${pluginRoot}/scripts/upgrade.js --root ${root} --plugin-root ${pluginRoot}`,
		);
		expect(text).not.toContain("WARN:");
	});

	it("WARNs a hook root that exists but is not the running one, naming both versions", () => {
		const { root, pluginRoot, configDir } = fixture(closed);
		const older = path.join(path.dirname(pluginRoot), "cache", "1.1.5");
		writeJson(path.join(older, ".claude-plugin", "plugin.json"), {
			version: "1.1.5",
		});
		installHooks(root, older, ["pre-commit"]);

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain(
			`WARN: .husky/pre-commit run workflow-core 1.1.5 (${older}), this session runs 1.1.8 (${pluginRoot})`,
		);
		expect(text).toContain(`${pluginRoot}/scripts/upgrade.js`);
		expect(text).not.toContain("FAIL:");
	});

	it("prints nothing where every hook names the running root", () => {
		const { root, pluginRoot, configDir } = fixture(closed);
		installHooks(root, pluginRoot, ["pre-commit", "pre-push"]);

		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});

	it("is silent where the hook and the session reach one install through two config dirs symlinking one plugins directory (#1788)", () => {
		const { root, pluginRoot, configDir } = fixture(closed);
		const shared = path.dirname(pluginRoot);
		const seats = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-plugin-seats-"));
		onTestFinished(() => fs.rmSync(seats, { recursive: true, force: true }));
		/** A config dir `name` whose `plugins` links to `shared`, beside it so
		 * no link loops; returns the install as reached through that link. */
		const seat = (name: string) => {
			const dir = path.join(seats, name);
			fs.mkdirSync(dir);
			fs.symlinkSync(shared, path.join(dir, "plugins"));
			return path.join(dir, "plugins", path.basename(pluginRoot));
		};
		const running = seat("seat-a");
		installHooks(root, seat("seat-b"), ["pre-commit"]);

		expect(report({ root, pluginRoot: running, configDir })).toBeNull();
	});

	it("with no running root, FAILs a missing root, naming the hook and offering upgrade.js, and stays silent on an existing one", () => {
		const { root, pluginRoot, configDir } = fixture(closed);
		const gone = path.join(path.dirname(pluginRoot), "cache", "1.1.12");
		installHooks(root, gone, ["pre-commit"]);
		installHooks(root, pluginRoot, ["pre-push"]);

		const text = report({ root, configDir });
		expect(text).toContain(`FAIL: .husky/pre-commit run from ${gone}`);
		expect(text).not.toContain("pre-push");
		expect(text).toContain("node <installed plugin root>/scripts/upgrade.js");
	});

	it("reads a root line with trailing whitespace as its path, not a missing one", () => {
		const { root, pluginRoot, configDir } = fixture(closed);
		fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".husky", "pre-commit"),
			`#!/usr/bin/env sh\nWFC_PLUGIN_ROOT="${pluginRoot}" \n`,
		);

		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});

	it("is silent over workflow-core's own hooks, which carry no WFC_PLUGIN_ROOT line", () => {
		const { root, pluginRoot, configDir } = fixture(closed);
		fs.cpSync(path.join(__dirname, "..", ".husky"), path.join(root, ".husky"), {
			recursive: true,
		});

		expect(report({ root, pluginRoot, configDir })).toBeNull();
	});
});

describe("check-plugin-gap.js checks that the hook shims resolve a core (#1839)", () => {
	const installShims = (root: string, hooks: string[]) => {
		fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
		for (const hook of hooks)
			fs.writeFileSync(path.join(root, ".husky", hook), renderHookShim(hook));
	};

	it("is silent where the install record resolves, whatever this session runs", () => {
		const { root, configDir } = fixture(closed);
		installShims(root, ["pre-commit", "pre-push"]);

		expect(report({ root, pluginRoot: "/elsewhere", configDir })).toBeNull();
	});

	it("is silent in a linked worktree, which resolves through the main checkout's install record", () => {
		const { root, configDir } = fixture(closed);
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				["-c", "user.name=t", "-c", "user.email=t@t", ...args],
				{ cwd: root, stdio: "pipe" },
			);
		git("init", "-q", "-b", "main");
		git("add", "-A");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "seed");
		const linked = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "wfc-gap-linked-")),
		);
		onTestFinished(() => fs.rmSync(linked, { recursive: true, force: true }));
		git("worktree", "add", "-q", "--detach", path.join(linked, "wt"));
		installShims(path.join(linked, "wt"), ["pre-commit"]);

		expect(
			report({
				root: path.join(linked, "wt"),
				pluginRoot: "/elsewhere",
				configDir,
			}),
		).toBeNull();
	});

	it("FAILs every shim where no core resolves, with resolve-core's reason and both fixes", () => {
		const { root, pluginRoot, configDir } = fixture(closed);
		installShims(root, ["pre-commit", "pre-push"]);
		writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
			plugins: {},
		});

		const text = report({ root, pluginRoot, configDir });
		expect(text).toContain(
			"FAIL: .husky/pre-commit, .husky/pre-push find no workflow-core to run",
		);
		expect(text).toContain(
			`no workflow-core directory for pin v1.1.8 — WORKFLOW_CORE_DIR and WORKFLOW_CORE_CHECKOUT are unset, and ${path.join(configDir, "plugins", "installed_plugins.json")} records no workflow-core@wc install for ${root}`,
		);
		expect(text).toContain("set WORKFLOW_CORE_DIR");
		expect(text).not.toContain("upgrade.js --root");
	});
});
