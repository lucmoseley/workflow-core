/*
 * The sandbox every test of admission.js runs it in (#3340): each limb
 * admission reads off the machine is a fixture under the test's `dir`, so a
 * limb added here reaches every such test and none reads this machine's own
 * state.
 */
import fs from "node:fs";
import path from "node:path";
import {
	loadavgLine,
	statLine,
	writeCwd,
	writeEnviron,
	writeSmapsRollup,
} from "./proc-fake";

export const SELF = "self-session-id";

export interface Lander {
	pid: number;
	chargeMb: number;
}

/* A temp root whose suite queue holds a marker per lander, the root every
 * case's TMPDIR names, so no case reads the machine's own suite queue. */
const tmpRootWithLanders = (dir: string, landers: Lander[]) => {
	const root = path.join(dir, "tmp");
	const q = path.join(root, "wfc-suite-queue");
	fs.mkdirSync(q, { recursive: true });
	for (const { pid, chargeMb } of landers)
		fs.writeFileSync(
			path.join(q, `wfc-suite-queue-${pid}.json`),
			JSON.stringify({ pid, at: 1, role: "lander", chargeMb }),
		);
	return root;
};

/*
 * A fake `/proc` carrying a `smaps_rollup` per pid in `pss` (kB), a `stat`
 * per pid in `parents`, naming its parent, a `cwd` symlink per pid in
 * `cwds`, and an `environ` per pid in `environs`. A pid with no rollup is the
 * unreadable case the scan falls back to RSS for, and one with no `cwd` the
 * unreadable one the spare test reads as claimed. The default is an empty
 * tree, so no test ever reads the real `/proc`.
 */
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
		/* A command name holding a space and a `)`, as a real one may. */
		fs.writeFileSync(
			path.join(root, pid, "stat"),
			statLine(Number(pid), {
				comm: "node (x) y",
				ppid: Number(ppid),
				startTicks: 0,
			}),
		);
	}
	fs.mkdirSync(root, { recursive: true });
	return root;
};

/*
 * A fake reap-finished-sessions.js, so admission tests never touch the real
 * reaper (which would spawn the real oracle, read the real claim store and
 * write the real ~/.claude/wfc-reap-state.json). `reaped` is what it prints
 * under `--dry-run --json`; `fails`/`raw` cover the degraded paths.
 */
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

/* A stand-in /proc/loadavg, so no admission test reads the live machine's load. */
export const writeLoadavg = (dir: string, load1: number | null) => {
	const p = path.join(dir, "loadavg");
	if (load1 === null) return path.join(dir, "no-such-loadavg");
	fs.writeFileSync(p, loadavgLine(load1));
	return p;
};

/* A repo holding `config`, so each listed session sitting in it is charged
 * that draw. */
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

/*
 * The variables that hold a case off this machine's own state — its suite
 * queue, session id, reaper, load, `/proc`, allowance cache and exported
 * ceilings — in one copy, so a new one reaches every case. A case spreads it
 * and overrides what it varies.
 */
export const buildIsolatedEnv = (
	dir: string,
	{
		landers = [],
		configDir = path.join(dir, "no-such-config"),
	}: {
		landers?: Lander[];
		configDir?: string;
	} = {},
) => ({
	TMPDIR: tmpRootWithLanders(dir, landers),
	CLAUDE_CODE_SESSION_ID: SELF,
	// Isolates the allowance re-read (#294) from this machine's real
	// `~/.claude/.claude.json` — a config dir with no cache file at all
	// reads as ABSENT on both bars, which only warns, never refuses.
	CLAUDE_CONFIG_DIR: configDir,
	WFC_REAP_SCRIPT: writeReapScript(dir, []),
	WFC_LOADAVG: writeLoadavg(dir, 0.5),
	WFC_PROC: writeProcRoot(dir),
	// Cleared so a founder's exported override cannot move the ceiling.
	WFC_LOAD_CEILING: "",
	// Set so neither the runner's core count nor an override moves it.
	WFC_SESSION_CEILING: "0",
	// Set, as unset reads `$HOME/.claude/session-floor` (#2501).
	WFC_SESSION_FLOOR: "",
});
