/*
 * dispatch-sessions-host.js — the production ports lib/dispatch-sessions.js
 * runs behind (#5145): each helper as its own node process, the interop probe
 * through its one bash library, and the launch in a process group of its own
 * under its ceiling. scripts/dispatch-sessions.js wires them.
 */

const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const SCRIPTS = path.resolve(__dirname, "..");

/* `claude_interop_wedged` is the probe; a library that will not load leaves
 * it undefined, and that reads healthy (mantahostels#3111). Exit 10 is the
 * wedge, its recovery text on stderr. */
const INTEROP_SCRIPT = [
	'source "$1" 2>/dev/null',
	"declare -F claude_interop_wedged >/dev/null || exit 0",
	"claude_interop_wedged || exit 0",
	"claude_interop_recovery_text",
	"exit 10",
].join("\n");

/* Seconds a launch that ignores its TERM gets before the KILL. */
const KILL_GRACE_SECONDS = 5;

/**
 * @param {string} script relative to scripts/
 * @param {string[]} args
 * @param {{env: NodeJS.ProcessEnv, cwd: string, stdin?: string}} opts
 */
function node(script, args, { env, cwd, stdin }) {
	const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
		cwd,
		env,
		input: stdin ?? "",
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		status:
			r.status ?? 128 + (os.constants.signals[r.signal ?? "SIGKILL"] ?? 9),
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? (r.error ? `${r.error.message}\n` : ""),
	};
}

/**
 * The interop probe, run from `library`; anything but its wedge verdict reads
 * healthy.
 * @param {string} [library]
 */
function interopProbe(library = path.join(SCRIPTS, "lib", "interop-probe.sh")) {
	return (/** @type {NodeJS.ProcessEnv} */ env) => {
		const r = spawnSync("bash", ["-c", INTEROP_SCRIPT, "interop", library], {
			env,
			encoding: "utf8",
			stdio: ["ignore", "ignore", "pipe"],
		});
		return {
			wedged: r.status === 10,
			recovery: r.status === 10 ? r.stderr : "",
		};
	};
}

/**
 * One launch, stdout and stderr merged in arrival order. At `timeoutS` the
 * launch's whole process group is sent TERM, and KILL after the grace, as
 * `timeout -k` does; a launch that has exited by then is not a timeout, even
 * where something it left holds its output open.
 * @param {string[]} argv
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeoutS: number}} opts
 * @returns {Promise<{status: number, timedOut: boolean, output: string}>}
 */
function launch(argv, { cwd, env, timeoutS }) {
	return new Promise((resolve) => {
		const [file, ...rest] = argv;
		const child = spawn(/** @type {string} */ (file), rest, {
			cwd,
			env,
			detached: true,
			stdio: ["inherit", "pipe", "pipe"],
		});
		let output = "";
		/** @type {number | null} */
		let status = null;
		let timedOut = false;
		let settled = false;
		const take = (/** @type {Buffer} */ b) => {
			output += b.toString("utf8");
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		const signalGroup = (/** @type {NodeJS.Signals} */ sig) => {
			try {
				if (child.pid) process.kill(-child.pid, sig);
			} catch {
				// The group has already gone.
			}
		};
		/** @type {NodeJS.Timeout | undefined} */
		let grace;
		const finish = (/** @type {number} */ code) => {
			if (settled) return;
			settled = true;
			clearTimeout(ceiling);
			clearTimeout(grace);
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({ status: code, timedOut, output });
		};
		const ceiling = setTimeout(() => {
			if (status !== null) return finish(status);
			timedOut = true;
			signalGroup("SIGTERM");
			grace = setTimeout(
				() => signalGroup("SIGKILL"),
				KILL_GRACE_SECONDS * 1000,
			);
		}, timeoutS * 1000);
		child.on("error", (e) => {
			output += `${e.message}\n`;
			status = 127;
			finish(127);
		});
		child.on("exit", (code, signal) => {
			status = code ?? 128 + (os.constants.signals[signal ?? "SIGKILL"] ?? 9);
			if (timedOut) finish(status);
		});
		child.on("close", () => finish(status ?? 1));
	});
}

/** @param {string} seconds */
function sleep(seconds) {
	return new Promise((resolve) => setTimeout(resolve, Number(seconds) * 1000));
}

/** The ports a real dispatch runs behind. */
function hostPorts() {
	return { node, interop: interopProbe(), launch, sleep };
}

module.exports = { hostPorts, interopProbe, launch, node };
