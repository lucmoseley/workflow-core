// @vitest-environment node
/*
 * The boot unit's installer (#3878) against fake systemctl and loginctl on
 * PATH, its unit written under a sandbox XDG_CONFIG_HOME. Loosen it and a host
 * can believe the loop returns at boot with the unit disabled or linger off,
 * or a unit can run the loop without the installer's seat and PATH.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "install-refill-boot-unit.js");
const TEMPLATE = path.resolve(__dirname, "refill-loop-boot.service.template");

let dir: string;
const at = (name: string) => path.join(dir, name);
const unitFile = () => at("config/systemd/user/refill-loop-boot.service");

function writeFake(name: string, body: string) {
	fs.writeFileSync(
		at(`bin/${name}`),
		`#!/bin/sh\necho "${name} $*" >> "${at("calls")}"\n${body}\n`,
		{ mode: 0o755 },
	);
}

function writeFakes({ enabled = "enabled", linger = "yes" } = {}) {
	writeFake("systemctl", `case "$*" in *is-enabled*) echo ${enabled};; esac`);
	writeFake(
		"loginctl",
		`case "$*" in show-user*) echo Linger=${linger};; esac`,
	);
}

const install = (env: NodeJS.ProcessEnv = {}, ...argv: string[]) =>
	runInProcess(SCRIPT, argv, {
		cwd: dir,
		env: {
			PATH: `${at("bin")}:/usr/bin:/bin`,
			HOME: dir,
			XDG_CONFIG_HOME: at("config"),
			SHELL: "/bin/bash",
			CLAUDE_CONFIG_DIR: "/home/x/.claude3",
			...env,
		},
	});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-refill-boot-"));
	fs.mkdirSync(at("bin"));
	writeFakes();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("install-refill-boot-unit", () => {
	it("writes the unit, enables it without starting it and turns linger on", () => {
		const r = install();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("is-enabled: enabled");
		expect(r.stdout).toContain("Linger=yes");
		const calls = fs.readFileSync(at("calls"), "utf8");
		expect(calls).toContain("systemctl --user daemon-reload");
		expect(calls).toContain("systemctl --user enable refill-loop-boot.service");
		expect(calls).toContain(`loginctl enable-linger ${os.userInfo().username}`);
		expect(calls).not.toMatch(/ start | --now/);
		const unit = fs.readFileSync(unitFile(), "utf8");
		expect(unit).toContain(
			`ExecStart=/bin/bash -lic "exec node ${path.join(__dirname, "refill-loop.js")} boot-resume"`,
		);
		expect(unit).toContain('Environment="CLAUDE_CONFIG_DIR=/home/x/.claude3"');
		expect(unit).toContain("WantedBy=default.target");
		expect(unit).toContain('Environment="WFC_CLAUDE_BIN=claude"');
		expect(unit).not.toMatch(/@[A-Z]+@/);
		for (const line of fs.readFileSync(TEMPLATE, "utf8").split("\n"))
			if (!line.includes("@")) expect(unit).toContain(line);
	});

	it("escapes the captured values for systemd and carries a listing wrapper", () => {
		const Path = `${at("bin")}:/usr/bin:/bin:/mnt/c/Program Files/a%b$c"d`;
		expect(
			install({ PATH: Path, WFC_CLAUDE_BIN: "/home/x/union" }).status,
		).toBe(0);
		const unit = fs.readFileSync(unitFile(), "utf8");
		expect(unit).toContain(
			`Environment="PATH=${at("bin")}:/usr/bin:/bin:/mnt/c/Program Files/a%%b$$c\\"d"`,
		);
		expect(unit).toContain('Environment="WFC_CLAUDE_BIN=/home/x/union"');
	});

	it.each([
		[
			"the unit reads back disabled",
			{ enabled: "disabled" },
			"is-enabled: disabled",
		],
		["linger reads back off", { linger: "no" }, "Linger=no"],
	])("fails where %s", (_name, fakes, line) => {
		writeFakes(fakes);
		const r = install();
		expect(r.status).toBe(1);
		expect(r.stdout).toContain(line);
	});

	it("fails naming a systemd call that fails", () => {
		writeFake(
			"loginctl",
			'case "$*" in enable-linger*) echo denied >&2; exit 1;; show-user*) echo Linger=yes;; esac',
		);
		const r = install();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("denied");
	});

	it("names a read-back that fails", () => {
		writeFake(
			"loginctl",
			'case "$*" in show-user*) echo gone >&2; exit 1;; esac',
		);
		const r = install();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("gone");
	});

	it("refuses a shell path the unit cannot quote, writing nothing", () => {
		const r = install({ SHELL: "/my shell/bash" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("cannot quote this path: /my shell/bash");
		expect(fs.existsSync(unitFile())).toBe(false);
	});

	it("refuses an unknown flag", () => {
		const r = install({}, "--bogus");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown flag: --bogus");
	});
});
