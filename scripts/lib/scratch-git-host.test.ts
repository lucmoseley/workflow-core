import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFaultyGit } from "./git-fault-fake";
import { buildHostPorts } from "./scratch-git-host.js";

describe("isTracked", () => {
	let dir: string;
	const isTracked = (abs: string) => buildHostPorts().isTracked(abs);

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-git-host-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("answers true for a tracked script and false for an untracked one", () => {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		fs.writeFileSync(path.join(dir, "a.sh"), "x\n");
		fs.writeFileSync(path.join(dir, "b.sh"), "x\n");
		execFileSync("git", ["add", "a.sh"], { cwd: dir });
		expect(isTracked(path.join(dir, "a.sh"))).toBe(true);
		expect(isTracked(path.join(dir, "b.sh"))).toBe(false);
	});

	it("answers false where git says there is no repository", () => {
		fs.writeFileSync(path.join(dir, "a.sh"), "x\n");
		vi.stubEnv("GIT_CEILING_DIRECTORIES", dir);
		expect(isTracked(path.join(dir, "a.sh"))).toBe(false);
	});

	it("cannot say on any other exit 128", () => {
		vi.stubEnv(
			"WFC_GIT",
			writeFaultyGit(
				{ all: true },
				{ script: "echo 'fatal: unable to read index' >&2\nexit 128" },
				{ under: dir },
			).git,
		);
		expect(isTracked(path.join(dir, "a.sh"))).toBeNull();
	});
});
