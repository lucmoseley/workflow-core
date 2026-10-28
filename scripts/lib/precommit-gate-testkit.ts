/*
 * precommit-gate-testkit.ts — what only this checkout's own hook suites use.
 * None of it is an adopter's, so it stays off precommit-gate-harness.js's
 * helper surface (#1367, #1417).
 *
 * The rule every fixture author meets here: supply a missing checker script
 * with `writeCheckerDelegates`, which re-execs the real repo script in a child
 * process, never a bare `require(<real path>)`. A `require`d checker loads and
 * satisfies node's module resolution, but `checker-new-faults.js`'s
 * `require.main === module` guard is then false — the checker's own body never
 * runs, the delegate exits 0, and the gate reads every fault as inherited from
 * HEAD (mantahostels#1998, mantahostels#2019). Prior art for pinning a refusal's actual reason rather
 * than its exit code alone, by file and test: `docs/agents/mutation-testing.md`.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The repository root, for a suite reading a checker it compares the hook against. */
export const ROOT = path.join(__dirname, "..", "..");

export const HOOK = fs.readFileSync(
	path.join(ROOT, ".husky", "pre-commit"),
	"utf8",
);

/** What the hook puts before a core `scripts/…` path: the plugin where an
 * adopter's shim set WFC_PLUGIN_ROOT, else the repo (#1839). */
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
export const CORE_ROOT = '"${WFC_PLUGIN_ROOT:-.}"/';

/** How the hook runs core script `script` with `runner`. */
export const coreCall = (runner: string, script: string) =>
	`${runner} ${CORE_ROOT}${script}`;

/** The lines of the hook from the first starting `first` to the first after it equal to `last`. */
export function cutHookBlock(first: string, last: string): string {
	const lines = HOOK.split("\n");
	const start = lines.findIndex((l) => l.startsWith(first));
	if (start === -1) throw new Error(`no ${first} in .husky/pre-commit`);
	const end = lines.findIndex((l, i) => i > start && l === last);
	if (end === -1) throw new Error(`${first} is unclosed in .husky/pre-commit`);
	return lines.slice(start, end + 1).join("\n");
}

/** How long a holder may take to take an uncontended flock — milliseconds in
 * practice, so only a holder that never ran reaches it. */
const HOLD_DEADLINE_MS = 10_000;

/**
 * Holds a real flock on `lock` from a child shell until `release` is called
 * (#2579). Returns once the lock is held, or throws.
 *
 * Released through a file rather than a signal: the holder's `sleep` children
 * inherit fd 9, so killing the shell alone would leave the lock held.
 */
export function holdLock(lock: string): { release: () => void } {
	const ready = `${lock}.held`;
	const stop = `${lock}.release`;
	const holder = spawn(
		"sh",
		[
			"-c",
			`exec 9>>"${lock}"; flock 9; touch "${ready}"; while [ ! -e "${stop}" ]; do sleep 0.05; done`,
		],
		{ stdio: "ignore" },
	);
	const release = () => {
		fs.writeFileSync(stop, "");
		holder.kill();
	};
	const deadline = Date.now() + HOLD_DEADLINE_MS;
	while (!fs.existsSync(ready) && Date.now() < deadline) {
		execFileSync("sleep", ["0.05"]);
	}
	if (!fs.existsSync(ready)) {
		release();
		throw new Error(`the holder never took ${lock}`);
	}
	return { release };
}

/** `scripts/lib/precommit-gate.sh`, which the hook sources (mantahostels#1793). */
export const LIB = fs.readFileSync(
	path.join(ROOT, "scripts", "lib", "precommit-gate.sh"),
	"utf8",
);

/** The commands LIB's arming read and temp-dir trap shell out to, which a
 * fixture running a gate on a PATH of its own must hold. */
export const LIB_COMMANDS = [
	"git",
	"grep",
	"mktemp",
	"tr",
	"paste",
	"cut",
	"rm",
];

export const POST_COMMIT = fs.readFileSync(
	path.join(ROOT, ".husky", "post-commit"),
	"utf8",
);

/**
 * A `.git/sequencer` in `root` whose `abort-safety` names `rev`: HEAD as a
 * single pick over a leftover leaves it, an older commit as a stopped range
 * finished by hand does (#3298).
 */
export function plantSequencer(root: string, rev: string): void {
	const dir = path.join(root, ".git", "sequencer");
	fs.mkdirSync(dir);
	fs.writeFileSync(
		path.join(dir, "abort-safety"),
		execFileSync("git", ["rev-parse", rev], { cwd: root, encoding: "utf8" }),
	);
}

/**
 * A commit in `root` over `.git/sequencer`, `git commit -q -m two` plus `args`.
 * `live` makes it as a `git revert A B` step does, which post-commit reads as
 * `revert-sequence`; otherwise as an ordinary commit over a leftover whose
 * `abort-safety` names HEAD, which a single pick leaves (#3298).
 */
export function commitOverSequencer(
	root: string,
	live: boolean,
	args = ["--allow-empty"],
): void {
	plantSequencer(root, "HEAD");
	const { GIT_REFLOG_ACTION: _, ...env } = process.env;
	execFileSync("git", ["commit", "-q", "-m", "two", ...args], {
		cwd: root,
		env: live ? { ...env, GIT_REFLOG_ACTION: "revert" } : env,
	});
}

/** A `name() { … }` shell function of `hook`, verbatim, to its closing `}` at column zero. */
export function cutShellFunction(name: string, hook = POST_COMMIT): string {
	const lines = hook.split("\n");
	const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
	if (start === -1) throw new Error(`the hook defines no ${name}()`);
	const end = lines.findIndex((l, i) => i > start && l === "}");
	if (end === -1) throw new Error(`the hook's ${name}() is unclosed`);
	return lines.slice(start, end + 1).join("\n");
}

/** post-commit's `in_replay`, behind the source of the route module it calls,
 * which the live hook loads at its top and a cut function would lose. */
export function cutInReplay(): string {
	const lib = path.join(ROOT, "scripts", "lib", "commit-route.sh");
	return `. "${lib}"\n${cutShellFunction("in_replay")}`;
}

/** The line opening the hook's `.husky/pre-commit.local` load block (#437). */
export const LOCAL_GATE_OPEN = "if [ -f .husky/pre-commit.local ]; then";

/**
 * The `.husky/pre-commit.local` load block, from LOCAL_GATE_OPEN to the
 * column-zero `fi` closing it. `hook` is overridden to cut an adopter's
 * rewritten copy.
 */
export function cutLocalGateBlock(hook: string = HOOK): string {
	const lines = hook.split("\n");
	const start = lines.indexOf(LOCAL_GATE_OPEN);
	if (start === -1) throw new Error("no pre-commit.local block in the hook");
	const end = lines.findIndex((l, i) => i > start && l === "fi");
	if (end === -1) throw new Error("the pre-commit.local block is unclosed");
	return lines.slice(start, end + 1).join("\n");
}

/**
 * Write `scripts/<name>.js` in `root` for each name, each a delegate that
 * re-execs the real repo script of that name.
 *
 * This is the required route (mantahostels#2073, mantahostels#2129) — see the file header above for
 * why. A fixture writing deliberate stub content with test-controlled
 * exit/stdout, to drive a gate's verdict without running real checker logic,
 * is a different, legitimate pattern and is not a delegate; nor is copying
 * the real script's bytes wholesale (`check-guard-registry.test.ts`'s
 * `copyFileSync` route) — that checker's entry point needs no re-exec because
 * the copy itself runs as `require.main`, and the libraries it copies
 * alongside are `require`d as libraries either way, delegate or not.
 *
 * A fixture meaning to exercise a real checker needs every script that checker
 * invokes, or the gate dies MODULE_NOT_FOUND, hits its fail-closed limb and
 * exits non-zero — which reads as a refusal and proves nothing (mantahostels#1998).
 *
 * `spawnSync` reports `status: null` when the real checker dies to a signal.
 * The delegate re-exits 128 + the signal number, the shell's own convention
 * (scripts/run-vitest.js's `armSignals`), so a signal-killed checker is never
 * mistaken for one that ran to completion and refused (mantahostels#2128).
 *
 * **Residual:** `r.signal` is `""`, not a name, for the 34 POSIX real-time
 * signals node's `signo_string` has no case for — that death still folds into
 * exit 1.
 */
export function writeCheckerDelegates(root: string, names: string[]): void {
	for (const name of names) {
		fs.mkdirSync(path.dirname(path.join(root, "scripts", name)), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(root, "scripts", name),
			"const { spawnSync } = require('node:child_process');\n" +
				"const os = require('node:os');\n" +
				`const r = spawnSync(process.execPath, [${JSON.stringify(path.join(ROOT, "scripts", name))}, ...process.argv.slice(2)], { stdio: 'inherit' });\n` +
				"process.exit(r.status ?? (r.signal ? 128 + os.constants.signals[r.signal] : 1));\n",
		);
	}
}
