// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFakeBin } from "./lib/fake-bin";
import { writePowershell } from "./lib/powershell-fake";
import { systemctlCalls, writeSystemctl } from "./lib/systemctl-fake";
import { writeWslpath } from "./lib/wslpath-fake";

const SCRIPT = path.resolve(__dirname, "install-combining-trial.sh");
const PS1 = path.resolve(__dirname, "win-interop-watchdog/page-combining.ps1");

let dir: string;
const at = (...p: string[]) => path.join(dir, ...p);
const unit = (name: string) => at("config/systemd/user", name);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-combining-trial-"));
	for (const d of ["bin", "diag", "repo/scripts/win-interop-watchdog"])
		fs.mkdirSync(at(d), { recursive: true });
	fs.copyFileSync(SCRIPT, at("repo/scripts/install-combining-trial.sh"));
	fs.copyFileSync(
		PS1,
		at("repo/scripts/win-interop-watchdog/page-combining.ps1"),
	);
	fs.writeFileSync(at("repo/scripts/combining-trial.js"), "");
	spawnSync("git", ["init", "-q", at("repo")]);
	fs.writeFileSync(at("diag/on-bugcheck.ps1"), "");
	writeFakeBin(at("bin"), "gh", "exit 0");
	writeFakeBin(at("bin"), "curl", "exit 0");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const install = (...argv: string[]) => {
	const r = spawnSync(
		"bash",
		[at("repo/scripts/install-combining-trial.sh"), ...argv],
		{
			encoding: "utf8",
			env: {
				PATH: `${at("bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
				HOME: dir,
				XDG_CONFIG_HOME: at("config"),
				WFC_SYSTEMCTL: writeSystemctl(at("systemctl")),
				WFC_POWERSHELL: writePowershell(at("bin")).bin,
				WFC_WSLPATH: writeWslpath(at("bin")),
				WFC_DIAG_DIR: at("diag"),
			},
		},
	);
	return { ...r, systemctl: systemctlCalls(at("systemctl")) };
};

const onCalendar = (file: string) =>
	fs
		.readFileSync(unit(file), "utf8")
		.split("\n")
		.filter((l) => l.startsWith("OnCalendar="));

describe("install-combining-trial", () => {
	it("writes a 23:00 line for each of three nights and a 07:00 line for each morning to 2026-12-04, then enables both timers", () => {
		const r = install("--first-night", "2026-11-28");
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(onCalendar("combining-trial-night.timer")).toEqual([
			"OnCalendar=2026-11-28 23:00",
			"OnCalendar=2026-11-29 23:00",
			"OnCalendar=2026-11-30 23:00",
		]);
		expect(onCalendar("combining-trial-morning.timer")).toEqual([
			"OnCalendar=2026-11-29 07:00",
			"OnCalendar=2026-11-30 07:00",
			"OnCalendar=2026-12-01 07:00",
			"OnCalendar=2026-12-02 07:00",
			"OnCalendar=2026-12-03 07:00",
			"OnCalendar=2026-12-04 07:00",
		]);
		expect(
			fs.readFileSync(unit("combining-trial-morning.service"), "utf8"),
		).toContain(
			`ExecStart=${process.execPath} ${fs.realpathSync(at("repo"))}/scripts/combining-trial.js morning`,
		);
		expect(fs.existsSync(at("diag/page-combining.ps1"))).toBe(true);
		expect(fs.readFileSync(at("bin/powershell-calls"), "utf8")).toBe(
			`-NoProfile -ExecutionPolicy Bypass -File ${at("diag")}\\page-combining.ps1 -Check\n`,
		);
		expect(r.systemctl.join("\n")).toContain(
			"--user enable --now combining-trial-night.timer combining-trial-morning.timer",
		);
	});

	it("takes 2026-12-01 as the last first night, its last night still followed by a morning", () => {
		const r = install("--first-night", "2026-12-01");
		expect(r.status).toBe(0);
		expect(onCalendar("combining-trial-night.timer").at(-1)).toBe(
			"OnCalendar=2026-12-03 23:00",
		);
		expect(onCalendar("combining-trial-morning.timer").at(-1)).toBe(
			"OnCalendar=2026-12-04 07:00",
		);
	});

	it.each(["2026-12-02", "2026-12-10"])(
		"refuses a first night of %s, writing no unit",
		(night) => {
			const r = install("--first-night", night);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("the last morning is 2026-12-04");
			expect(fs.existsSync(at("config"))).toBe(false);
			expect(r.systemctl).toEqual([]);
		},
	);
});
