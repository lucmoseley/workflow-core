// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { systemctlCalls, writeSystemctl } from "./lib/systemctl-fake";

const SCRIPT = path.resolve(__dirname, "install-stale-run-timer.js");
const SERVICE_TEMPLATE = path.resolve(
	__dirname,
	"stale-ticket-run.service.template",
);

let dir: string;
const at = (name: string) => path.join(dir, name);
const unitDir = () => at("config/systemd/user");

const install = (enabled = "enabled") => {
	const systemctl = writeSystemctl(dir, {
		units: { "stale-ticket-run.timer": { enabled } },
	});
	return runInProcess(SCRIPT, [], {
		cwd: dir,
		env: {
			PATH: "/usr/bin:/bin",
			WFC_SYSTEMCTL: systemctl,
			HOME: dir,
			XDG_CONFIG_HOME: at("config"),
			CLAUDE_CONFIG_DIR: "/home/x/.claude3",
		},
	});
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-stale-run-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("install-stale-run-timer", () => {
	it("writes the pair, reloads and enables the timer now", () => {
		const r = install();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("stale-ticket-run.timer is-enabled: enabled");
		const calls = systemctlCalls(dir).join("\n");
		expect(calls).toContain("systemctl --user daemon-reload");
		expect(calls).toContain(
			"systemctl --user enable --now stale-ticket-run.timer",
		);
		const timer = fs.readFileSync(
			path.join(unitDir(), "stale-ticket-run.timer"),
			"utf8",
		);
		expect(timer).toContain("OnCalendar=daily");
		expect(timer).toContain("Persistent=true");
		expect(timer).toContain("WantedBy=timers.target");
	});

	it("runs the hub script from a checkout, niced like the sweep timers", () => {
		expect(install().status).toBe(0);
		const service = fs.readFileSync(
			path.join(unitDir(), "stale-ticket-run.service"),
			"utf8",
		);
		expect(service).toMatch(
			/^ExecStart=\/usr\/bin\/env node \S+\/scripts\/stale-ticket-run\.js$/m,
		);
		expect(service).toContain("Nice=10");
		expect(service).toMatch(/^WorkingDirectory=\S+$/m);
		expect(service).toContain(
			'Environment="CLAUDE_CONFIG_DIR=/home/x/.claude3"',
		);
		expect(service).not.toMatch(/@[A-Z]+@/);
		for (const line of fs.readFileSync(SERVICE_TEMPLATE, "utf8").split("\n"))
			if (!line.includes("@")) expect(service).toContain(line);
	});

	it("refreshes an installed pair in place", () => {
		expect(install().status).toBe(0);
		fs.writeFileSync(path.join(unitDir(), "stale-ticket-run.timer"), "stale");
		expect(install().status).toBe(0);
		expect(
			fs.readFileSync(path.join(unitDir(), "stale-ticket-run.timer"), "utf8"),
		).toContain("OnCalendar=daily");
	});

	it("exits 1 where the timer does not read back enabled", () => {
		expect(install("disabled").status).toBe(1);
	});
});
