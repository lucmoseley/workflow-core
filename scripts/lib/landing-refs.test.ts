// @vitest-environment node
/*
 * Pins the one choice of which remote ref the "what has been pushed" readers
 * read (#2408): `origin/landing` with the `landing` module on, `origin/main`
 * with it off or on a config that will not read. Every pushed reader calls it,
 * so a wrong answer moves push attestation, the unpushed count and changed-file
 * selection onto a branch the repo does not push to.
 *
 * A throwaway host per test, never this one, since this checkout's own config
 * is what the answer turns on.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./run-in-process";

const { pushedRef, readUnpushedRef } =
	createRequire(__filename)("./landing-refs.js");
const SCRIPT = path.join(__dirname, "landing-refs.js");

let root: string;

/** A host declaring `modules` in its config, or `raw` as the file's bytes. */
function host(modules: string[] | null, raw?: string) {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude/workflow-core.json"),
		raw ?? JSON.stringify({ contract: 1, modules }),
	);
}

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "landing-")));
	vi.stubEnv("WFC_MODULES", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("pushedRef", () => {
	it("is origin/landing where the host turns the landing module on", () => {
		host(["suites", "landing"]);
		expect(pushedRef({ root })).toBe("origin/landing");
	});

	it("is origin/main where the module is off", () => {
		host(["suites"]);
		expect(pushedRef({ root })).toBe("origin/main");
	});

	it("is origin/main where the config will not read", () => {
		host(null, "{ not json");
		expect(pushedRef({ root })).toBe("origin/main");
	});
});

describe("readUnpushedRef", () => {
	/** A checkout at `root` on `branch`, whose upstream is `upstream` if any. */
	function checkout(branch: string, upstream?: string) {
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git("init", "-q", "-b", branch);
		git(
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"c",
		);
		if (!upstream) return;
		git("remote", "add", "origin", root);
		git("update-ref", `refs/remotes/${upstream}`, "HEAD");
		git("config", `branch.${branch}.remote`, "origin");
		git(
			"config",
			`branch.${branch}.merge`,
			`refs/heads/${upstream.slice("origin/".length)}`,
		);
	}

	it("is a spike branch's own upstream, whatever the module", () => {
		host(["landing"]);
		checkout("spike/x", "origin/spike/x");
		expect(readUnpushedRef({ root })).toBe("origin/spike/x");
	});

	it("is the pushed ref on main, though main tracks origin/main", () => {
		host(["landing"]);
		checkout("main", "origin/main");
		expect(readUnpushedRef({ root })).toBe("origin/landing");
	});

	it("is the pushed ref on a branch with no upstream", () => {
		host(["suites"]);
		checkout("wip");
		expect(readUnpushedRef({ root })).toBe("origin/main");
	});
});

describe("the CLI", () => {
	const cli = (args: string[]) =>
		runInProcess(SCRIPT, args, { cwd: root, env: { ...process.env } });

	it("prints the pushed ref for the host it is named", () => {
		host(["landing"]);
		const r = cli(["pushed", root]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("origin/landing\n");
	});

	it("refuses anything else with its usage", () => {
		const r = cli(["verified"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			"usage: landing-refs.js pushed|unpushed [<root>]",
		);
	});
});
