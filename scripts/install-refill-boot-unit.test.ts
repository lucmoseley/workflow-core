// @vitest-environment node
/*
 * The boot unit's installer (#3878) against a fake systemctl at WFC_SYSTEMCTL
 * (#3970) and a fake loginctl on PATH, its unit written under a sandbox XDG_CONFIG_HOME. Loosen it and a host
 * can believe the loop returns at boot with the unit disabled or linger off,
 * a unit can run the loop without the installer's seat and PATH, can start from
 * a working copy mid-edit, or a failed boot can leave the loop's log silent. And
 * the watch timer (#4139): loosen that and a dead loop stays down until the next
 * boot, or a watch that will not load stays out of the log.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";
import { writeSystemctl } from "./lib/systemctl-fake";
import { copyLibs, readProgramLibs } from "./lib-closure-fixture.js";

const SCRIPT = path.resolve(__dirname, "install-refill-boot-unit.js");
const TEMPLATE = path.resolve(__dirname, "refill-loop-boot.service.template");

let dir: string;
const at = (name: string) => path.join(dir, name);
const unitDir = () => at("config/systemd/user");
const unitFile = () => path.join(unitDir(), "refill-loop-boot.service");
const watchFile = () => path.join(unitDir(), "refill-loop-watch.service");
const timerFile = () => path.join(unitDir(), "refill-loop-watch.timer");
/* Resolving already, so the installer leaves this repo's git alone. */
const bootLink = () => at(".claude/.refill-loop-code.current");
const logFile = () => at(".claude/.refill-loop.log");

function writeFake(name: string, body: string) {
	fs.writeFileSync(
		at(`bin/${name}`),
		`#!/bin/sh\necho ${shellQuote(`${name} `)}"$*" >> ${shellQuote(at("calls"))}\n${body}\n`,
		{ mode: 0o755 },
	);
}

let systemctl: string;

const writeUnitStates = (boot: string, timer = "enabled") => {
	systemctl = writeSystemctl(dir, {
		unitStates: {
			"refill-loop-boot.service": boot,
			"refill-loop-watch.timer": timer,
		},
	});
};

function writeFakes({ enabled = "enabled", linger = "yes" } = {}) {
	writeUnitStates(enabled);
	writeFake(
		"loginctl",
		`case "$*" in show-user*) echo Linger=${linger};; esac`,
	);
}

const buildInstallEnv = (env: NodeJS.ProcessEnv = {}) => ({
	PATH: `${at("bin")}:/usr/bin:/bin`,
	WFC_SYSTEMCTL: systemctl,
	HOME: dir,
	XDG_CONFIG_HOME: at("config"),
	SHELL: "/bin/bash",
	CLAUDE_CONFIG_DIR: "/home/x/.claude3",
	...env,
});

const install = (env: NodeJS.ProcessEnv = {}, ...argv: string[]) =>
	runInProcess(SCRIPT, argv, { cwd: dir, env: buildInstallEnv(env) });

/* A unit's ExecStopPost= as its shell receives it, systemd's escapes undone. */
function readStopPostCommand(file = unitFile()) {
	const line = fs
		.readFileSync(file, "utf8")
		.split("\n")
		.find((l) => l.startsWith("ExecStopPost=/bin/sh -c '"));
	if (!line) throw new Error("the unit has no ExecStopPost");
	return line
		.slice("ExecStopPost=/bin/sh -c '".length, -1)
		.replaceAll("$$", "$")
		.replaceAll("%%", "%");
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-refill-boot-"));
	fs.mkdirSync(at("bin"));
	fs.mkdirSync(path.join(bootLink(), "scripts"), { recursive: true });
	fs.writeFileSync(path.join(bootLink(), "scripts/refill-loop.js"), "");
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
		expect(calls).not.toMatch(/(start|--now) refill-loop-boot/);
		const unit = fs.readFileSync(unitFile(), "utf8");
		expect(unit).toContain(
			`ExecStart=/bin/bash -lic "exec node ${path.join(bootLink(), "scripts/refill-loop.js")} boot-resume"`,
		);
		expect(unit).toContain('Environment="CLAUDE_CONFIG_DIR=/home/x/.claude3"');
		expect(unit).toContain("WantedBy=default.target");
		expect(unit).toContain('Environment="WFC_CLAUDE_BIN=claude"');
		expect(unit).not.toMatch(/@[A-Z]+@/);
		for (const line of fs.readFileSync(TEMPLATE, "utf8").split("\n"))
			if (!line.includes("@")) expect(unit).toContain(line);
	});

	it("writes the watch units, enables and starts the timer and runs the unit's program", () => {
		const r = install();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("refill-loop-watch.timer is-enabled: enabled");
		expect(fs.readFileSync(at("calls"), "utf8")).toContain(
			"systemctl --user enable --now refill-loop-watch.timer",
		);
		const service = fs.readFileSync(watchFile(), "utf8");
		expect(service).toContain(
			`ExecStart=/usr/bin/env node ${path.join(bootLink(), "scripts/refill-loop.js")} watch`,
		);
		expect(service).toContain(
			'Environment="CLAUDE_CONFIG_DIR=/home/x/.claude3"',
		);
		expect(service).not.toMatch(/@[A-Z]+@/);
		const timer = fs.readFileSync(timerFile(), "utf8");
		expect(timer).toContain("OnActiveSec=");
		expect(timer).toContain("OnUnitInactiveSec=");
		expect(timer).toContain("WantedBy=timers.target");
	});

	it("logs one line for a failed watch unit", () => {
		expect(install().status).toBe(0);
		fs.mkdirSync(path.dirname(logFile()), { recursive: true });
		fs.writeFileSync(logFile(), "");
		const r = spawnSync("/bin/sh", ["-c", readStopPostCommand(watchFile())], {
			env: {
				PATH: "/usr/bin:/bin",
				SERVICE_RESULT: "exit-code",
				EXIT_CODE: "exited",
				EXIT_STATUS: "1",
			},
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		expect(fs.readFileSync(logFile(), "utf8")).toMatch(
			/^\S+ resume watch: the unit failed \(exited 1\); journalctl --user -u refill-loop-watch\.service\n$/,
		);
	});

	it("fails where the watch timer reads back disabled", () => {
		writeUnitStates("enabled", "disabled");
		const r = install();
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("refill-loop-watch.timer is-enabled: disabled");
	});

	it("names a plugin install's own program, it having no worktree", () => {
		fs.rmSync(bootLink(), { recursive: true });
		const plugin = at("plugin/scripts");
		fs.mkdirSync(plugin, { recursive: true });
		copyLibs(
			path.join(plugin, "lib"),
			readProgramLibs("install-refill-boot-unit.js"),
		);
		for (const f of [
			"install-refill-boot-unit.js",
			"refill-loop-boot.service.template",
			"refill-loop-watch.service.template",
			"refill-loop-watch.timer.template",
		])
			fs.copyFileSync(path.resolve(__dirname, f), path.join(plugin, f));
		const r = runInProcess(
			path.join(plugin, "install-refill-boot-unit.js"),
			[],
			{ cwd: dir, env: buildInstallEnv() },
		);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(fs.readFileSync(unitFile(), "utf8")).toContain(
			`exec node ${path.join(plugin, "refill-loop.js")} boot-resume`,
		);
		expect(fs.existsSync(bootLink())).toBe(false);
	});

	const runStopPost = (result: string) => {
		expect(install().status).toBe(0);
		writeFake("journalctl", "echo SyntaxError: boom");
		fs.mkdirSync(path.dirname(logFile()), { recursive: true });
		fs.writeFileSync(logFile(), "");
		const r = spawnSync("/bin/sh", ["-c", readStopPostCommand()], {
			env: {
				PATH: `${at("bin")}:/usr/bin:/bin`,
				SERVICE_RESULT: result,
				EXIT_CODE: "exited",
				EXIT_STATUS: "1",
			},
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		return fs.readFileSync(logFile(), "utf8");
	};

	it("logs a failed unit's exit and last journal lines", () => {
		expect(runStopPost("exit-code")).toMatch(
			/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ boot resume: the unit failed \(exited 1\), its last journal lines follow\nSyntaxError: boom\n$/,
		);
	});

	it("logs nothing for a unit that succeeded", () => {
		expect(runStopPost("success")).toBe("");
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
