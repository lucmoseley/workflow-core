// @vitest-environment node
/*
 * The user manager's restart installer (#3963) against a fake systemctl at
 * WFC_SYSTEMCTL (#3970), its files written under a sandbox --root. Loosen it and a host can believe its
 * manager returns after a kill with no drop-in loaded, or lowering the manager
 * can shield every unit it starts, and the sessions a boot-started loop runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { writeSystemctl } from "./lib/systemctl-fake";

const SCRIPT = path.resolve(__dirname, "install-user-manager-restart.js");
const SHOWN = {
	Restart: "on-failure",
	OOMScoreAdjust: "-500",
	StartLimitIntervalUSec: "10min",
};

let dir: string;
const at = (name: string) => path.join(dir, name);
const dropIn = () =>
	at("root/etc/systemd/system/user@1000.service.d/restart.conf");
const managerConf = () => at("root/etc/systemd/user.conf.d/oom.conf");

let systemctl: string;

const install = (env: NodeJS.ProcessEnv = { SUDO_UID: "1000" }) =>
	runInProcess(SCRIPT, ["--root", at("root")], {
		cwd: dir,
		env: { WFC_SYSTEMCTL: systemctl, SUDO_UID: "", ...env },
	});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-user-manager-"));
	systemctl = writeSystemctl(dir, { properties: SHOWN });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("install-user-manager-restart", () => {
	it("writes a bounded restart and the OOM values for the sudo user, then reloads", () => {
		const r = install();
		expect(r.status).toBe(0);
		const text = fs.readFileSync(dropIn(), "utf8");
		expect(text).toContain("Restart=on-failure");
		expect(text).toContain("StartLimitBurst=5");
		expect(text).toContain("StartLimitIntervalSec=10min");
		expect(text).toContain("OOMScoreAdjust=-500");
		const calls = fs.readFileSync(at("calls"), "utf8");
		expect(calls).toContain("systemctl daemon-reload");
		expect(calls).toContain("systemctl show user@1000.service");
		expect(r.stdout).toContain("Restart=on-failure");
	});

	it("keeps the units that declare no value where a stock manager puts them", () => {
		expect(install().status).toBe(0);
		const conf = fs.readFileSync(managerConf(), "utf8");
		expect(conf).toContain("[Manager]");
		expect(conf).toContain("DefaultOOMScoreAdjust=200");
	});

	it("replaces its own files on a re-run", () => {
		expect(install().status).toBe(0);
		fs.writeFileSync(dropIn(), "stale");
		expect(install().status).toBe(0);
		expect(fs.readFileSync(dropIn(), "utf8")).toContain("Restart=on-failure");
	});

	it("exits 1 where the read-back shows the drop-in did not load", () => {
		systemctl = writeSystemctl(dir, {
			properties: {
				Restart: "no",
				OOMScoreAdjust: "100",
				StartLimitIntervalUSec: "10s",
			},
		});
		const r = install();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("read-back lacks Restart=on-failure");
		expect(r.stderr).toContain("read-back lacks OOMScoreAdjust=-500");
		expect(r.stderr).toContain("read-back lacks StartLimitIntervalUSec=10min");
		expect(r.stderr).toContain('re-run: sudo "$(command -v node)"');
	});

	it("exits 1 where the reload fails", () => {
		systemctl = writeSystemctl(dir, {
			properties: SHOWN,
			fails: { "daemon-reload": { exit: 3 } },
		});
		const r = install();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`${systemctl} daemon-reload exited 3`);
		expect(r.stderr).toContain('re-run: sudo "$(command -v node)"');
	});

	it.each([
		["no sudo", ""],
		["root's own sudo", "0"],
	])("refuses, writing nothing, on %s", (_name, uid) => {
		const r = install({ SUDO_UID: uid });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`SUDO_UID is "${uid}"`);
		expect(r.stderr).toContain('sudo "$(command -v node)"');
		expect(fs.existsSync(at("root"))).toBe(false);
	});
});
