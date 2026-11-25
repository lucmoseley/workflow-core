import fs from "node:fs";
import path from "node:path";
import {
	buildLoadavgLine,
	buildStatLine,
	writeCwd,
	writeEnviron,
	writeSmapsRollup,
} from "./proc-fake";

export const SELF = "self-session-id";

export interface Lander {
	pid: number;
	chargeMb: number;
}

export interface Gate {
	pid: number;
	chargeMb?: number;
	spawned?: boolean;
}

export interface HeldRun {
	pid: number;
	chargeMb?: number;
	rungMb?: number;
}

export interface Typecheck {
	pid: number;
	chargeMb: number;
	spawned?: boolean;
	memoryHeld?: boolean;
}

export const tmpRootWithMarkers = (
	dir: string,
	{
		landers = [],
		gates = [],
		heldRuns = [],
		typechecks = [],
	}: {
		landers?: Lander[];
		gates?: Gate[];
		heldRuns?: HeldRun[];
		typechecks?: Typecheck[];
	},
) => {
	const root = path.join(dir, "tmp");
	const q = path.join(root, "wfc-suite-queue");
	fs.mkdirSync(q, { recursive: true });
	for (const { pid, chargeMb } of landers)
		fs.writeFileSync(
			path.join(q, `wfc-suite-queue-${pid}.json`),
			JSON.stringify({ pid, at: 1, role: "lander", chargeMb }),
		);
	for (const { pid, chargeMb, spawned } of gates)
		fs.writeFileSync(
			path.join(q, `wfc-suite-queue-gate-${pid}.json`),
			JSON.stringify({ pid, at: 1, role: "gate", chargeMb, spawned }),
		);
	for (const { pid, chargeMb, rungMb } of heldRuns)
		fs.writeFileSync(
			path.join(q, `wfc-suite-queue-held-${pid}.json`),
			JSON.stringify({
				pid,
				at: 1,
				chargeMb,
				memoryRungMb: rungMb,
				memoryHeld: true,
			}),
		);
	const tsc = path.join(root, "wfc-tsc-queue");
	fs.mkdirSync(tsc, { recursive: true });
	for (const { pid, ...record } of typechecks)
		fs.writeFileSync(
			path.join(tsc, `wfc-suite-queue-${pid}.json`),
			JSON.stringify({ pid, at: 1, ...record }),
		);
	return root;
};

export const writeProcRoot = (
	dir: string,
	{
		pss = {},
		parents = {},
		cwds = {},
		environs = {},
	}: {
		pss?: Record<string, number>;
		parents?: Record<string, string>;
		cwds?: Record<string, string>;
		environs?: Record<string, string[]>;
	} = {},
) => {
	const root = path.join(dir, "proc");
	for (const [pid, cwd] of Object.entries(cwds)) writeCwd(root, pid, cwd);
	for (const [pid, entries] of Object.entries(environs))
		writeEnviron(root, Number(pid), entries);
	for (const [pid, kb] of Object.entries(pss)) writeSmapsRollup(root, pid, kb);
	for (const [pid, ppid] of Object.entries(parents)) {
		fs.mkdirSync(path.join(root, pid), { recursive: true });
		fs.writeFileSync(
			path.join(root, pid, "stat"),
			buildStatLine(Number(pid), {
				comm: "node (x) y",
				ppid: Number(ppid),
				startTicks: 0,
			}),
		);
	}
	fs.mkdirSync(root, { recursive: true });
	return root;
};

export const writeReapScript = (
	dir: string,
	reaped: Array<{ pss: number | null }> | null,
	{ fails = false, raw }: { fails?: boolean; raw?: string } = {},
) => {
	const p = path.join(dir, "fake-reap.js");
	if (fails) {
		fs.writeFileSync(
			p,
			'process.stderr.write("reap: broken\\n"); process.exit(1);\n',
		);
		return p;
	}
	const body = raw ?? JSON.stringify({ reaped: reaped ?? [], kept: [] });
	fs.writeFileSync(p, `process.stdout.write(${JSON.stringify(body)});\n`);
	return p;
};

export const writeLoadavg = (dir: string, load1: number | null) => {
	const p = path.join(dir, "loadavg");
	if (load1 === null) return path.join(dir, "no-such-loadavg");
	fs.writeFileSync(p, buildLoadavgLine(load1));
	return p;
};

export const writeHostRepo = (dir: string, config: Record<string, unknown>) => {
	const host = path.join(dir, "host");
	fs.mkdirSync(path.join(host, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(host, ".git"), { recursive: true });
	fs.writeFileSync(
		path.join(host, ".claude", "workflow-core.json"),
		JSON.stringify(config),
	);
	return host;
};

export const buildIsolatedEnv = (
	dir: string,
	{
		landers = [],
		gates = [],
		heldRuns = [],
		typechecks = [],
		configDir = path.join(dir, "no-such-config"),
	}: {
		landers?: Lander[];
		gates?: Gate[];
		heldRuns?: HeldRun[];
		typechecks?: Typecheck[];
		configDir?: string;
	} = {},
) => ({
	TMPDIR: tmpRootWithMarkers(dir, { landers, gates, heldRuns, typechecks }),
	CLAUDE_CODE_SESSION_ID: SELF,
	CLAUDE_CONFIG_DIR: configDir,
	WFC_REAP_SCRIPT: writeReapScript(dir, []),
	WFC_LOADAVG: writeLoadavg(dir, 0.5),
	WFC_PROC: writeProcRoot(dir),
	WFC_LOAD_CEILING: "",
	WFC_SESSION_CEILING: "0",
});
