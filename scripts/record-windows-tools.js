#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./lib/caught.js");
const { readSize } = require("./lib/file-size.js");
const scan = require("./lib/pfn-scan.js");
const { diagDir, fetchSymbols, spawnCdb } = require("./lib/pfn-scan-host.js");
const { powershellBin, toWin } = require("./lib/windows-host.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = "usage: record-windows-tools.js cdb|schtasks|powershell|wslpath";
const PROBE_TASK = "workflow-core contract probe";
// guess, workflow-core#5813: a few entries show a whole write and keep the fixture short
const READ_ENTRIES = 4;

/** @param {string} s */
const withoutUserNames = (s) =>
	s
		.replace(/([Cc]:\\Users\\)[^\\\s"']+/g, "$1user")
		.replace(/(\\\\wsl\.localhost\\[^\\]+\\home\\)[^\\\s"']+/g, "$1user")
		.replace(/record-\d+/g, "record");

/**
 * @param {string} file
 * @param {string[]} argv
 * @param {{cwd?: string}} [opts]
 */
function call(file, argv, opts = {}) {
	const r = spawnSync(file, argv, { encoding: "utf8", cwd: opts.cwd });
	if (r.error) throw new Error(`${file}: ${r.error.message}`);
	return {
		argv,
		status: r.status,
		stdout: withoutUserNames(r.stdout),
		stderr: withoutUserNames(r.stderr),
	};
}

function readNewestDump() {
	const dir = path.join(diagDir(), "dumps");
	const dumps = fs
		.readdirSync(dir)
		.filter((n) => n.endsWith(".dmp"))
		.map((n) => path.join(dir, n))
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	if (!dumps[0]) throw new Error(`no .dmp in ${dir} to record cdb against`);
	return dumps[0];
}

function recordCdb() {
	const dump = readNewestDump();
	const work = path.join(diagDir(), `record-${process.pid}`);
	fs.mkdirSync(work, { recursive: true });
	/** @param {string} d @param {string} sym @param {string[]} commands */
	const cdb = (d, sym, commands) => {
		const r = spawnCdb(d, sym, commands, work);
		return {
			commands: commands.map(withoutUserNames),
			status: r.status,
			stdout: withoutUserNames(r.stdout),
			stderr: withoutUserNames(r.stderr),
		};
	};
	/** @param {string} sym @param {bigint} address @param {number} bytes */
	const writemem = (sym, address, bytes) => {
		const file = path.join(work, `${address.toString(16)}.bin`);
		const r = cdb(dump, sym, [
			`.writemem ${toWin(file)} 0x${address.toString(16)} L?0x${bytes.toString(16)}`,
			"q",
		]);
		return { ...r, asked: bytes, written: readSize(file) };
	};
	try {
		const symbols = path.join(diagDir(), "sym");
		const identity = cdb(dump, symbols, scan.IDENTITY_COMMANDS);
		const id = scan.parseIdentity(identity.stdout);
		if ("why" in id) throw new Error(id.why);
		const symbolDir = fetchSymbols(id);
		const layoutAnswer = cdb(dump, symbolDir, scan.LAYOUT_COMMANDS);
		const layout = scan.parseLayout(layoutAnswer.stdout);
		if ("why" in layout) throw new Error(layout.why);
		const first = scan.chunks(layout)[0];
		if (!first) throw new Error("the layout names no PFN run");
		return {
			identity,
			layout: layoutAnswer,
			read: writemem(symbolDir, first.address, READ_ENTRIES * layout.entrySize),
			unread: writemem(symbolDir, BigInt(0), layout.entrySize),
			unopened: cdb(
				path.join(diagDir(), "dumps", "absent.dmp"),
				symbols,
				scan.IDENTITY_COMMANDS,
			),
		};
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

function recordSchtasks() {
	const bin = "/mnt/c/Windows/System32/schtasks.exe";
	const made = call(bin, [
		"/Create",
		"/TN",
		PROBE_TASK,
		"/TR",
		"cmd.exe /c exit 0",
		"/SC",
		"ONCE",
		"/ST",
		"23:59",
		"/F",
	]);
	if (made.status !== 0)
		throw new Error(`schtasks /Create exited ${made.status}: ${made.stderr}`);
	try {
		return {
			run: call(bin, ["/Run", "/TN", PROBE_TASK]),
			missing: call(bin, ["/Run", "/TN", `${PROBE_TASK} absent`]),
		};
	} finally {
		call(bin, ["/Delete", "/TN", PROBE_TASK, "/F"]);
	}
}

function recordPowershell() {
	const ps1 = path.join(diagDir(), "page-combining.ps1");
	if (!fs.existsSync(ps1))
		throw new Error(`${ps1} is absent: run scripts/install-combining-trial.sh`);
	const ps = powershellBin();
	const cwd = diagDir();
	return {
		command: call(
			ps,
			["-NoProfile", "-Command", "& 'cmd.exe' /c 'echo @@probe'"],
			{ cwd },
		),
		failing: call(ps, ["-NoProfile", "-Command", "& 'cmd.exe' /c 'exit 3'"], {
			cwd,
		}),
		check: call(
			ps,
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				toWin(ps1),
				"-Check",
			],
			{ cwd },
		),
	};
}

function recordWslpath() {
	const toWindows = call("wslpath", ["-w", "/mnt/c/diag/5743/dumps/live.dmp"]);
	return {
		roundTrip: [toWindows, call("wslpath", ["-u", toWindows.stdout.trim()])],
	};
}

/** @type {Record<string, () => object>} */
const RECORDERS = {
	cdb: recordCdb,
	schtasks: recordSchtasks,
	powershell: recordPowershell,
	wslpath: recordWslpath,
};

function main() {
	/** @type {string[]} */
	let positionals;
	/** @type {{help?: boolean}} */
	let values;
	try {
		({ positionals, values } = parseArgs({
			options: { help: { type: "boolean" } },
			allowPositionals: true,
		}));
	} catch {
		positionals = [];
		values = {};
	}
	if (values.help) {
		writeFd(1, `${USAGE}\n`);
		return 0;
	}
	const tool = positionals[0] ?? "";
	const record = RECORDERS[tool];
	if (!record || positionals.length !== 1) {
		writeFd(2, `${USAGE}\n`);
		return 2;
	}
	const fixture = path.join(__dirname, "fixtures", `${tool}.json`);
	const recorded = {
		recordedBy: `node scripts/record-windows-tools.js ${tool}`,
		responses: record(),
	};
	fs.writeFileSync(fixture, `${JSON.stringify(recorded, null, "\t")}\n`);
	writeFd(1, `recorded ${fixture}\n`);
	return 0;
}

try {
	process.exitCode = main();
} catch (e) {
	writeFd(2, `${caught(e).message}\n`);
	process.exitCode = 1;
}
