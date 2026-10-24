// @vitest-environment node
/*
 * lib/atomic-write.sh's guarantee (#2251): <file> is untouched until the
 * rename, and a failed write leaves the old file and no aside behind. Every
 * shell caller relies on this one.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIB = path.join(__dirname, "atomic-write.sh");

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-sh-"));
	file = path.join(dir, "record");
	fs.writeFileSync(file, "old\n");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function run(script: string, input = "") {
	return spawnSync("bash", ["-c", `source "$LIB"; ${script}`], {
		env: { ...process.env, LIB, F: file },
		input,
		encoding: "utf8",
	});
}

const entries = () => fs.readdirSync(dir).sort();

describe("aw_write", () => {
	it("replaces the file with stdin and leaves no aside", () => {
		const r = run('aw_write "$F"', "new\n");
		expect(r.status).toBe(0);
		expect(fs.readFileSync(file, "utf8")).toBe("new\n");
		expect(entries()).toEqual(["record"]);
	});

	it("replaces the file with a command's output, its arguments passed whole", () => {
		const r = run(`aw_write "$F" printf '%s\\n' 'a b' c`);
		expect(r.status).toBe(0);
		expect(fs.readFileSync(file, "utf8")).toBe("a b\nc\n");
	});

	it("leaves the file as it was while the command runs", () => {
		const r = run(`aw_write "$F" sh -c 'printf "new "; cat "$F"'`);
		expect(r.status).toBe(0);
		expect(fs.readFileSync(file, "utf8")).toBe("new old\n");
	});

	it("creates a file that did not exist", () => {
		fs.rmSync(file);
		const r = run('aw_write "$F"', "new\n");
		expect(r.status).toBe(0);
		expect(fs.readFileSync(file, "utf8")).toBe("new\n");
	});

	it("keeps the file's permission bits whatever the umask", () => {
		fs.chmodSync(file, 0o644);
		const r = run('umask 077; aw_write "$F"', "new\n");
		expect(r.status).toBe(0);
		expect(fs.statSync(file).mode & 0o777).toBe(0o644);
	});

	it("writes a symlinked file at its target and keeps the link", () => {
		const target = path.join(dir, "target");
		fs.renameSync(file, target);
		fs.symlinkSync(target, file);
		const r = run('aw_write "$F"', "new\n");
		expect(r.status).toBe(0);
		expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(target, "utf8")).toBe("new\n");
	});

	it("leaves the file and removes the aside when the command fails", () => {
		const r = run(`aw_write "$F" sh -c 'printf partial; exit 3'`);
		expect(r.status).toBe(1);
		expect(fs.readFileSync(file, "utf8")).toBe("old\n");
		expect(entries()).toEqual(["record"]);
	});

	it("removes the aside when the rename is refused", () => {
		fs.rmSync(file);
		fs.mkdirSync(file);
		const r = run('aw_write "$F"', "new\n");
		expect(r.status).toBe(1);
		expect(fs.readdirSync(file)).toEqual([]);
		expect(entries()).toEqual(["record"]);
	});

	it("returns 1 and writes nothing when the aside cannot be created", () => {
		const r = spawnSync("bash", ["-c", 'source "$LIB"; aw_write "$F"'], {
			env: { ...process.env, LIB, F: path.join(dir, "missing", "record") },
			input: "new\n",
			encoding: "utf8",
		});
		expect(r.status).toBe(1);
		expect(entries()).toEqual(["record"]);
	});

	it("returns 1 under set -e without the caller's shell exiting first", () => {
		const r = run(`set -e; aw_write "$F" false || echo refused`);
		expect(r.stdout).toBe("refused\n");
	});
});
