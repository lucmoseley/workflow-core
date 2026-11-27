const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { bgLaunchId } = require("./bg-launch-id.js");
const { claudeBin } = require("./claude-bin.js");
const { readText } = require("./file-read.js");
const { docPath, scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");
const { trimEndRun, trimStartRun } = require("./trim-run.js");

const MEMBER_REFUSED_TAIL = "— not launching this member.";
const memberRefused = (/** @type {string} */ prompt) =>
	`REFUSED: ${prompt} ${MEMBER_REFUSED_TAIL}`;
const memberDropped = (/** @type {string} */ prompt) => `dropped: ${prompt}`;

/** @typedef {{model: string, prompt: string}} Member */

/** @param {string[]} words */
function membersOf(words) {
	/** @type {Member[]} */
	const members = [];
	/** @type {string | undefined} */
	let model;
	for (const w of words) {
		if (model === undefined) model = w;
		else {
			members.push({ model, prompt: w });
			model = undefined;
		}
	}
	return members;
}

const SCRIPTS = path.resolve(__dirname, "..");

// guess, #4941
const DEFAULT_CEILINGS = { week: 99, session: 90 };

// 0.68 s plateau measured, lucmoseley/mantahostels#2588
const DEFAULT_STAGGER_SECONDS = 2;

// guess, lucmoseley/mantahostels#3111
const DEFAULT_LAUNCH_TIMEOUT_SECONDS = 120;

const EXITS = new WeakSet();

/**
 * @param {number} code
 * @returns {Error & {exitCode: number}}
 */
function exitAt(code) {
	const e = Object.assign(new Error(`exit ${code}`), { exitCode: code });
	EXITS.add(e);
	return e;
}

/**
 * @typedef {{status: number, stdout: string, stderr: string}} NodeResult
 * @typedef {{
 *   node: (script: string, args: string[], opts: {env: NodeJS.ProcessEnv, cwd: string, stdin?: string}) => NodeResult | Promise<NodeResult>,
 *   interop: (env: NodeJS.ProcessEnv) => {wedged: boolean, recovery: string} | Promise<{wedged: boolean, recovery: string}>,
 *   launch: (argv: string[], opts: {cwd: string, env: NodeJS.ProcessEnv, timeoutS: number}) => Promise<{status: number, timedOut: boolean, output: string}>,
 *   sleep: (seconds: string) => void | Promise<void>,
 *   write?: (fd: 1 | 2, text: string) => void,
 * }} DispatchPorts
 */

const chomp = (/** @type {string} */ text) => trimEndRun(text, "\n");

function prefixLines(/** @type {string} */ text, /** @type {string} */ prefix) {
	if (text === "") return "";
	const ends = text.endsWith("\n");
	const lines = (ends ? text.slice(0, -1) : text).split("\n");
	return lines.map((l) => `${prefix}${l}`).join("\n") + (ends ? "\n" : "");
}

function money(/** @type {string} */ field) {
	const n = Number(field);
	return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

/**
 * @param {unknown} v
 * @param {boolean} interpolated
 */
function jqText(v, interpolated = false) {
	if (v === null || v === undefined) return interpolated ? "null" : "";
	if (typeof v === "string") return v;
	return JSON.stringify(v);
}

/**
 * @param {string} line
 * @param {number} n
 * @returns {string[]}
 */
function readFields(line, n) {
	/** @type {string[]} */
	const out = [];
	let rest = trimStartRun(line, " \t");
	for (let i = 0; i < n - 1; i++) {
		const cut = rest.search(/[ \t]/);
		out.push(cut === -1 ? rest : rest.slice(0, cut));
		rest = cut === -1 ? "" : trimStartRun(rest.slice(cut), " \t");
	}
	out.push(trimEndRun(rest, " \t"));
	return out;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} prefix
 * @returns {string}
 */
function makeTemp(env, prefix) {
	const dir = env.TMPDIR || "/tmp";
	const at = path.join(
		dir,
		`${prefix}.${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
	);
	try {
		fs.closeSync(fs.openSync(at, "wx", 0o600));
		return at;
	} catch {
		return "";
	}
}

function readOrEmpty(/** @type {string} */ file) {
	if (!file) return "";
	const got = readText(file);
	return got.state === "read" ? got.data : "";
}

const SWITCHES = /** @type {const} */ ({
	"--dry-run": ["dryRun", true],
	"--force": ["force", true],
	"--force-memory": ["forceMemory", true],
	"--no-advisor": ["advisor", false],
});

const MODEL_TABLE = "lib/model-table.js";

/**
 * @param {string[]} argv
 * @param {DispatchPorts} ports
 * @param {{env: NodeJS.ProcessEnv, cwd: string}} run
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function dispatch(argv, ports, run) {
	const d = new Dispatch(ports, run);
	try {
		await d.main(argv);
		return { code: 0, stdout: d.stdout, stderr: d.stderr };
	} catch (e) {
		if (EXITS.has(/** @type {object} */ (e)))
			return {
				code: /** @type {{exitCode: number}} */ (e).exitCode,
				stdout: d.stdout,
				stderr: d.stderr,
			};
		throw e;
	} finally {
		for (const f of d.temps) fs.rmSync(f, { force: true });
	}
}

/**
 * @typedef {{fit: string, headroom: string, qUsd: string, running: string,
 *   reserved: string, exhausted: string, until: string, resets: string}} Budget
 */

class Dispatch {
	/**
	 * @param {DispatchPorts} ports
	 * @param {{env: NodeJS.ProcessEnv, cwd: string}} run
	 */
	constructor(ports, run) {
		this.ports = ports;
		this.cwd = run.cwd;
		this.claudeBin = claudeBin(run.env);
		/** @type {NodeJS.ProcessEnv} */
		this.env = { ...run.env, WFC_CLAUDE_BIN: this.claudeBin };
		const e = this.env;
		this.weekCeiling =
			e.WFC_DISPATCH_WEEK_CEILING || `${DEFAULT_CEILINGS.week}`;
		this.sessionCeiling =
			e.WFC_DISPATCH_SESSION_CEILING || `${DEFAULT_CEILINGS.session}`;
		this.staggerSeconds =
			e.WFC_DISPATCH_STAGGER_SECONDS || `${DEFAULT_STAGGER_SECONDS}`;
		this.launchTimeoutSeconds =
			e.WFC_DISPATCH_LAUNCH_TIMEOUT || `${DEFAULT_LAUNCH_TIMEOUT_SECONDS}`;
		this.advisorModel = e.WFC_DISPATCH_ADVISOR || "opus";
		this.seatReason = e.WFC_SEAT_REASON || "own seat";
		this.seatKey = e.WFC_SEAT_KEY || "";
		this.noBuild = e.WFC_DISPATCH_NO_BUILD || "";
		delete e.WFC_SEAT_REASON;
		delete e.WFC_SEAT_KEY;
		delete e.WFC_DISPATCH_NO_BUILD;
		this.seatDir = e.CLAUDE_CONFIG_DIR || `${e.HOME || ""}/.claude`;
		this.seatLabel = "";
		this.overflow = false;
		/** @type {string[]} */
		this.launchEnv = ["env"];

		this.dryRun = false;
		this.force = false;
		this.forceMemory = false;
		this.advisor = true;
		this.into = "";

		this.stdout = "";
		this.stderr = "";
		/** @type {string[]} */
		this.temps = [];
		/** @type {string[]} */
		this.launchedPrompts = [];
		this.remedyPrinted = false;
		this.debugLog = "";
		this.usage = "";
		this.probeRan = false;
	}

	/** @param {string} text */
	out(text) {
		this.stdout += text;
		this.ports.write?.(1, text);
	}

	/** @param {string} text */
	err(text) {
		this.stderr += text;
		this.ports.write?.(2, text);
	}

	/**
	 * @param {string} script
	 * @param {string[]} args
	 * @param {string} [stdin]
	 */
	async run(script, args, stdin) {
		const opts = { env: this.env, cwd: this.cwd };
		return this.ports.node(
			script,
			args,
			stdin === undefined ? opts : { ...opts, stdin },
		);
	}

	/**
	 * @param {string} script
	 * @param {string[]} args
	 */
	async relayed(script, args) {
		const r = await this.run(script, args);
		this.out(r.stdout);
		this.err(r.stderr);
		return r.status;
	}

	/**
	 * @param {string} script
	 * @param {string[]} args
	 */
	async captured(script, args) {
		const r = await this.run(script, args);
		this.err(r.stderr);
		return { status: r.status, text: chomp(r.stdout) };
	}

	/** @param {string[]} argv */
	async main(argv) {
		let members = this.parseArgs(argv);
		await this.refuseIfInteropWedged();
		await this.refuseIfKernelUnhealthy();
		await this.readSeat();
		members = await this.remap(members);
		if (this.overflow) await this.admitOverflowModels(members);
		if (!this.force) members = await this.duplicateGate(members);
		let wantsAdvisor = await this.warnUnknownModels(members);
		await this.probeUsage();
		if (this.overflow) members = await this.overflowBudgetGate(members);
		if (!this.overflow && !this.force) {
			const capped = await this.allowanceGate(members);
			if (capped.length !== members.length)
				wantsAdvisor = await this.anyWantsAdvisor(capped);
			members = capped;
		}
		if (wantsAdvisor) this.reportAdvisor();
		for (const [i, { model, prompt }] of members.entries())
			await this.launchMember(model, prompt, i < members.length - 1);
	}

	/** @param {string[]} argv */
	parseArgs(argv) {
		let args = [...argv];
		for (;;) {
			const [a, operand] = args;
			if (a === undefined) break;
			if (Object.hasOwn(SWITCHES, a))
				this.setSwitch(SWITCHES[/** @type {keyof typeof SWITCHES} */ (a)]);
			else if (a === "--into") {
				this.into = this.intoOperand(operand);
				args = args.slice(1);
			} else if (a === "--") {
				args = args.slice(1);
				break;
			} else if (a.startsWith("-")) this.exitWith(2, `unknown option: ${a}\n`);
			else break;
			args = args.slice(1);
		}
		return this.membersOrUsage(args);
	}

	/** @param {string[]} words */
	membersOrUsage(words) {
		if (words.length === 0 || words.length % 2 !== 0)
			this.exitWith(
				2,
				`usage: ${scriptPath("dispatch-sessions.js", this.env)} [--dry-run] [--force] [--force-memory] [--no-advisor] [--into <worktree>] <model> <prompt> [<model> <prompt> ...]\n`,
			);
		const members = membersOf(words);
		if (this.into !== "" && members.length !== 1)
			this.exitWith(
				2,
				`--into starts one session in one worktree; this set has ${members.length} members\n`,
			);
		return members;
	}

	/** @param {readonly [string, boolean]} sw */
	setSwitch([name, on]) {
		if (name === "advisor") this.advisor = on;
		else if (name === "dryRun") this.dryRun = on;
		else if (name === "force") this.force = on;
		else this.forceMemory = on;
	}

	/** @param {string | undefined} operand */
	intoOperand(operand) {
		if (operand === undefined) this.exitWith(2, "--into names no worktree\n");
		return operand;
	}

	/**
	 * @param {number} code
	 * @param {string} message
	 * @returns {never}
	 */
	exitWith(code, message) {
		this.err(message);
		throw exitAt(code);
	}

	/**
	 * @param {string[]} remedy
	 * @returns {never}
	 */
	exitRefusedNamingLaunched(remedy) {
		if (this.launchedPrompts.length === 0) {
			this.err(
				"  Nothing was recorded as dispatched. Re-run this command after the shutdown.\n",
			);
			throw exitAt(5);
		}
		this.err(
			`  ${this.launchedPrompts.length} member(s) HAD already launched and are recorded as dispatched:\n`,
		);
		for (const p of this.launchedPrompts) this.err(`    ${p}\n`);
		for (const l of remedy) this.err(`  ${l}\n`);
		throw exitAt(5);
	}

	async refuseIfInteropWedged() {
		const probe = await this.ports.interop(this.env);
		if (!probe.wedged) return;
		this.err(
			"REFUSED: the WSL interop bridge is wedged, so `claude` would hang rather than launch.\n",
		);
		this.err(probe.recovery);
		this.exitRefusedNamingLaunched([
			"Re-run with the remaining members only, or --force: re-running the whole",
			"command is refused by the duplicate gate on the ones above.",
		]);
	}

	async refuseIfKernelUnhealthy() {
		const r = await this.run("check-kernel-stall.js", []);
		if (r.status === 0) return;
		if (r.status !== 1) {
			this.err(
				`note: the kernel-stall check could not run (exit ${r.status}), so this launch is unchecked for one.\n`,
			);
			return;
		}
		this.err(
			"REFUSED: the WSL VM is unhealthy; the kernel check names the signal that fired.\n",
		);
		this.err(`${chomp(r.stderr)}\n`);
		this.exitRefusedNamingLaunched([
			"The shutdown ends them too, so re-run with --force: the duplicate gate",
			"refuses the ones above otherwise.",
		]);
	}

	async readSeat() {
		const gates = await this.captured("lib/dispatch-gates.js", [
			"--",
			this.seatDir,
			...(this.seatKey ? [this.seatKey] : []),
		]);
		if (gates.status !== 0) throw exitAt(2);
		const [kindLine = "", unsetLine = "", labelLine = ""] =
			gates.text.split("\n");
		const [seatKind = ""] = readFields(kindLine, 1);
		[this.seatLabel = ""] = readFields(labelLine, 1);
		this.overflow = seatKind === "overflow";
		if (!this.overflow && seatKind !== "plan")
			this.exitWith(
				2,
				`REFUSED: the seat ${this.seatDir} read as ${shellQuote(seatKind)}, neither plan nor overflow.\n`,
			);
		const unset = unsetLine.split(/[ \t]+/).filter(Boolean);
		this.launchEnv = ["env", ...unset.flatMap((v) => ["-u", v])];
	}

	/** @param {Member[]} members */
	async remap(members) {
		/** @type {Member[]} */
		const remapped = [];
		for (const { model, prompt } of members)
			remapped.push({ model: await this.launchModel(model), prompt });
		return remapped;
	}

	/** @param {string} m */
	async launchModel(m) {
		const to = await this.tableLaunch(["launch", m]);
		if (to !== m) this.err(`model table: ${m} -> ${to}\n`);
		return to;
	}

	/** @param {string[]} args */
	async tableLaunch(args) {
		const r = await this.captured(MODEL_TABLE, args);
		if (r.status !== 0)
			this.exitWith(
				2,
				"REFUSED: the model table cannot read the routing file, so no launch model is known.\n",
			);
		return r.text;
	}

	/** @param {Member[]} members */
	async admitOverflowModels(members) {
		for (const { model: m } of members) {
			if ((await this.relayed(MODEL_TABLE, ["admits", m])) !== 0)
				this.exitWith(
					2,
					`REFUSED: ${this.seatLabel} is an overflow seat, which launches Opus alone (#1920); ${shellQuote(m)} is not.\n`,
				);
		}
	}

	/** @param {string} [admissionText] */
	async rosterRemedy(admissionText = "") {
		if (this.remedyPrinted) return;
		this.remedyPrinted = true;
		const shown = admissionText !== "";
		const text = shown ? admissionText : await this.bareAdmission();
		const lines = text.split("\n");
		const from = lines.findIndex((l) => l.startsWith("hung job(s)"));
		if (from === -1) this.ghostRemedy();
		else if (!shown) this.hungRemedy(chomp(lines.slice(from).join("\n")));
		this.err(
			'  Retire one at its roster: workers["<short-id>"] carries pid (the\n',
		);
		this.err(
			"  bg-pty-host) and replPid (the bg-spare). Confirm each against\n",
		);
		this.err(
			"  /proc/<pid>/stat field 22 (procStart/replProcStart) to rule out pid\n",
		);
		this.err("  reuse, then SIGTERM both — the entry leaves the roster and\n");
		this.err(
			"  `claude agents --json` within seconds, with no daemon restart.\n",
		);
		await this.rosterPaths();
	}

	async bareAdmission() {
		const r = await this.run("admission.js", []);
		return chomp(r.stdout + r.stderr);
	}

	/** @param {string} hung */
	hungRemedy(hung) {
		this.err(
			"  A slot or a ledger entry may be held by a job that is alive, listed, and\n",
		);
		this.err("  silent — seen on this machine right now:\n");
		this.err(prefixLines(`${hung}\n`, "  "));
	}

	ghostRemedy() {
		this.err(
			"  No job currently reads as hung (alive, listed, and silent). A slot or\n",
		);
		this.err(
			'  ledger entry may instead be held by a GHOST-JOB — "working" with nothing\n',
		);
		this.err("  behind it, or hung before its first turn. Name one:\n");
		this.err(`    node ${scriptPath("check-ghost-jobs.js", this.env)}\n`);
	}

	async rosterPaths() {
		const home = this.env.HOME || "";
		const r = home === "" ? null : await this.run("lib/plan-dirs.js", [home]);
		if (r?.status !== 0) {
			this.err(
				"    roster: HOME unset or unreadable, so no plan dir was scanned — check:ghost-jobs prints the real path per ghost.\n",
			);
			return;
		}
		const rosters = r.stdout
			.split("\0")
			.filter(Boolean)
			.filter((d) => isFile(path.join(d, "daemon", "roster.json")));
		for (const d of rosters) this.err(`    roster: ${d}/daemon/roster.json\n`);
		if (rosters.length === 0)
			this.err(
				`    roster: none under the plan dirs in ${home} — check:ghost-jobs prints the real path per ghost.\n`,
			);
	}

	/** @param {string} why */
	refuseDispatched(why) {
		this.err(`REFUSED: ${why}\n`);
		if (!this.dryRun) throw exitAt(4);
		this.err(
			"  (--dry-run: reporting only, a real run would have exited 4 here.)\n",
		);
	}

	/**
	 * @param {number} n
	 * @param {Member[]} set
	 */
	keepFirst(n, set) {
		for (const { prompt } of set.slice(n))
			this.err(`  ${memberDropped(prompt)}\n`);
		return set.slice(0, n);
	}

	/** @param {Member[]} members */
	async duplicateGate(members) {
		const prompts = this.checkedPrompts(members);
		const dropFile = this.temp("dispatch-drop");
		const status = await this.relayed("check-duplicate-dispatch.js", [
			"--issues",
			prompts,
			"--drop-index-out",
			dropFile,
		]);
		if (status === 0) return members;
		const dropText = readOrEmpty(dropFile);
		if (dropText === "") {
			this.refuseDispatched(
				"the whole set, because the per-member drop list is unreadable.",
			);
			return members;
		}
		return this.dropMembers(members, dropText);
	}

	/** @param {Member[]} members */
	checkedPrompts(members) {
		let prompts = "";
		for (const { prompt: p } of members) {
			if (p.replace(/\s/g, "") === "")
				this.exitWith(2, "usage: a launch prompt may not be empty.\n");
			if (p.includes("\n"))
				this.exitWith(
					2,
					`usage: a launch prompt may not contain a newline: ${shellQuote(p)}\n`,
				);
			prompts += `${p}\n`;
		}
		return prompts;
	}

	/**
	 * @param {Member[]} members
	 * @param {string} dropText
	 */
	async dropMembers(members, dropText) {
		const drop = new Set(
			dropText
				.split("\n")
				.slice(0, -1)
				.map((l) => l.trim()),
		);
		/** @type {Member[]} */
		const keep = [];
		for (const [i, member] of members.entries()) {
			if (drop.has(`${i}`)) this.err(`  ${memberDropped(member.prompt)}\n`);
			else keep.push(member);
		}
		if (keep.length > 0) {
			this.out(
				`Launching ${keep.length} of ${members.length} set(s); the rest are already dispatched.\n`,
			);
			return keep;
		}
		await this.rosterRemedy();
		this.refuseDispatched("every member of this set is already dispatched.");
		return members;
	}

	/** @param {string} prefix */
	temp(prefix) {
		const at = makeTemp(this.env, prefix);
		if (at) this.temps.push(at);
		return at;
	}

	/** @param {string} model */
	async advisorClass(model) {
		const alias = (await this.captured(MODEL_TABLE, ["alias", model])).text;
		if (alias === "opus" || alias === "fable") return "none";
		return alias === "haiku" ? "advisor" : "unknown";
	}

	/** @param {string} model */
	async wantsAdvisor(model) {
		return this.advisor && (await this.advisorClass(model)) !== "none";
	}

	/** @param {Member[]} members */
	async anyWantsAdvisor(members) {
		let wants = false;
		for (const { model } of members)
			if (await this.wantsAdvisor(model)) wants = true;
		return wants;
	}

	/** @param {Member[]} members */
	async warnUnknownModels(members) {
		if (!this.advisor) return false;
		/** @type {string[]} */
		const unknown = [];
		let wants = false;
		for (const { model: m } of members) {
			const cls = await this.advisorClass(m);
			if (cls !== "none") wants = true;
			if (cls === "unknown") unknown.push(m);
		}
		if (unknown.length === 0) return wants;
		this.err(`WARNING: unrecognised model spelling(s): ${unknown.join(" ")}\n`);
		this.err(
			"  Treating as Haiku-equivalent and attaching an advisor. If it names a\n",
		);
		this.err(
			`  known model, add it to that alias's \`also\` list in ${SCRIPTS}/lib/model-routing.json.\n`,
		);
		this.err("  The advisor already attaches either way.\n");
		return wants;
	}

	async probeUsage() {
		this.debugLog = this.temp("dispatch-sessions-debug");
		if (this.overflow || !this.debugLog) return;
		const r = await this.run("usage-probe.js", [
			"--",
			"--model",
			"haiku",
			"--advisor",
			this.advisorModel,
			"--debug",
			"--debug-file",
			this.debugLog,
		]);
		this.usage = chomp(r.stdout);
		this.probeRan = r.status !== 3;
	}

	/**
	 * @param {string} subject
	 * @returns {Promise<Budget | null>}
	 */
	async readBudget(subject) {
		const r = await this.run("lib/overflow-budget.js", [
			"--json",
			this.seatKey,
		]);
		const text = chomp(r.stdout + r.stderr);
		const json = parseJson(text);
		if (r.status !== 0 || typeof json?.fit !== "number") {
			this.err(
				`REFUSED: ${subject}: the overflow budget of ${this.seatLabel} cannot be read:\n`,
			);
			this.err(prefixLines(`${text || "no output"}\n`, "  "));
			return null;
		}
		return {
			fit: jqText(json.fit),
			headroom: jqText(json.headroomUsd),
			qUsd: jqText(json.qUsd),
			running: jqText(json.running),
			reserved: jqText(json.reservedUsd),
			exhausted: jqText(json.exhausted),
			until: `until ${jqText(json.freeAgain, true)}`,
			resets: `resets at ${jqText(json.freeAgain, true)}`,
		};
	}

	/** @param {Budget} b */
	noFitLine(b) {
		return `overflow seat ${this.seatLabel} fits no session: headroom $${money(b.headroom)} against $${money(b.qUsd)} a session ($${money(b.reserved)} held by ${b.running} running).`;
	}

	/** @param {Member[]} members */
	async overflowBudgetGate(members) {
		const budget = await this.readBudget("the whole set");
		if (!budget) throw exitAt(3);
		const fit = Number(budget.fit);
		if (fit === 0) this.refuseNoFit(budget);
		if (fit < members.length) {
			this.err(
				`CAPPED: launching ${budget.fit} of ${members.length} on the overflow budget of ${this.seatLabel} (headroom $${money(budget.headroom)}, $${money(budget.qUsd)} a session).\n`,
			);
			return this.keepFirst(fit, members);
		}
		this.out(
			`Budget OK: ${this.seatLabel} fits ${budget.fit}; headroom $${money(budget.headroom)}.\n`,
		);
		return members;
	}

	/** @param {Budget} budget @returns {never} */
	refuseNoFit(budget) {
		if (budget.exhausted === "true")
			this.err(
				`REFUSED: overflow seat ${this.seatLabel}: its key is exhausted ${budget.until}, Anthropic having refused it for credit.\n`,
			);
		else this.err(`REFUSED: ${this.noFitLine(budget)}\n`);
		this.exitWith(
			3,
			`  --force does not lift the budget gate; the budget ${budget.resets}.\n`,
		);
	}

	/** @param {Member[]} members */
	async allowanceGate(members) {
		const r = await this.run(
			"allowance.js",
			[
				"--json",
				"--cap",
				`${members.length}`,
				"--session-threshold",
				this.sessionCeiling,
				"--week-threshold",
				this.weekCeiling,
			],
			this.usage,
		);
		const a = readAllowance(chomp(r.stdout));
		this.refuseUntrustworthy(a);
		this.refuseUnsized(a);
		const capLaunch = Number(a.capLaunch);
		if (Number.isNaN(capLaunch) || capLaunch >= members.length) {
			const shown = (/** @type {string} */ trust, /** @type {string} */ pct) =>
				trust === "unreported" ? "not reported" : `${pct}%`;
			this.out(
				`Allowance OK: week ${shown(a.weekTrust, a.weekPct)}, session ${shown(a.sessionTrust, a.sessionPct)}.\n`,
			);
			return members;
		}
		if (capLaunch === 0) this.refuseFullBar(a);
		this.err(
			`CAPPED: launching ${a.capLaunch} of ${members.length} on the ${a.capBar} bar (${a.capReading}% used, ${a.capNRunning} running session(s)\n`,
		);
		this.err(
			`  projected at ${a.capRunning} more points, ~${a.capFigure} a new session).\n`,
		);
		return this.keepFirst(capLaunch, members);
	}

	/** @param {Allowance} a */
	refuseUntrustworthy(a) {
		if (a.trustworthy === "true") return;
		this.err(
			"REFUSED: no trustworthy allowance reading (the usage cache is stale or\n",
		);
		this.err(
			'  absent, and the printed bars from `claude -p "/usage"` were unparseable).\n',
		);
		this.exitWith(3, "  This is likely transient — re-run, or --force.\n");
	}

	/** @param {Allowance} a */
	refuseUnsized(a) {
		const capError =
			a.capError ||
			(a.capLaunch === "" ? "the allowance reader returned no cap" : "");
		if (capError === "") return;
		this.err(
			`REFUSED: the allowance cap cannot be sized (week ${a.weekPct}%, threshold ${this.weekCeiling}%;\n`,
		);
		this.exitWith(
			3,
			`  session ${a.sessionPct}%, threshold ${this.sessionCeiling}%): ${capError}. --force to override.\n`,
		);
	}

	/** @param {Allowance} a @returns {never} */
	refuseFullBar(a) {
		const reset = a.capBar === "session" ? a.sessionReset : a.weekReset;
		this.err(
			`REFUSED: ${a.capBar} allowance ${a.capReading}% used (threshold ${a.capThreshold}%), resets ${reset || "unknown"} — the bar is full.\n`,
		);
		this.exitWith(3, "  --force to override.\n");
	}

	reportAdvisor() {
		const log = readOrEmpty(this.debugLog);
		const lines = (log.endsWith("\n") ? log.slice(0, -1) : log).split("\n");
		if (lines.some((l) => l.includes("[AdvisorTool] Advisor model:"))) {
			this.out(
				`Advisor available: ${this.advisorModel} is live on this machine.\n`,
			);
			return;
		}
		if (!this.probeRan) {
			this.out("Advisor not checked: no /usage probe ran to report it.\n");
			return;
		}
		this.err(
			"WARNING: the advisor is not live here — the sessions below expecting one run\n",
		);
		this.err(
			"  bare, with no escalation path, and nothing in them will say so. Reason, if\n",
		);
		this.err("  the CLI gave one:\n");
		for (const l of lines.filter((x) => x.includes("[AdvisorTool]")))
			this.err(`    ${l}\n`);
		this.err(
			"  Launching anyway. --no-advisor to silence this, or launch opus instead.\n",
		);
	}

	/**
	 * @param {string} model
	 * @param {string} prompt
	 * @param {boolean} more
	 */
	async launchMember(model, prompt, more) {
		if (!this.dryRun && !(await this.admitMember(prompt))) return;
		const budget = this.overflow ? await this.memberBudget(prompt) : null;
		if (this.overflow && !budget) return;
		const { launcher, cmd } = await this.launchCommand(model, prompt, budget);
		if (this.dryRun) {
			this.out(`would launch: ${cmd.map((w) => shellQuote(w)).join(" ")}\n`);
			return;
		}
		await this.refuseIfInteropWedged();
		await this.refuseIfKernelUnhealthy();
		const dir = await this.launchDir(prompt);
		if (dir === null) return;
		const launched = await this.launchAndRecord(model, prompt, {
			launcher,
			cmd,
			dir,
			budget,
		});
		if (launched && more) await this.ports.sleep(this.staggerSeconds);
	}

	/** @param {string} prompt */
	async admitMember(prompt) {
		/** @type {string[]} */
		let admissionArgs = [];
		if (this.forceMemory) admissionArgs = ["--load-only"];
		else if (this.force || this.overflow) admissionArgs = ["--skip-allowance"];
		const r = await this.run("admission.js", admissionArgs);
		const text = chomp(r.stdout + r.stderr);
		const lines = text.split("\n");
		if (r.status !== 0) {
			await this.refuseMember(prompt, text, lines);
			return false;
		}
		const warned = lines.filter((l) =>
			/^(allowance |cpu (load|sessions) +unknown)/.test(l),
		);
		if (warned.length > 0) {
			this.err(`WARNING: ${prompt}\n`);
			for (const l of warned) this.err(`  ${l}\n`);
		}
		return true;
	}

	/**
	 * @param {string} prompt
	 * @param {string} text
	 * @param {string[]} lines
	 */
	async refuseMember(prompt, text, lines) {
		this.err(`${memberRefused(prompt)}\n`);
		this.err(prefixLines(`${text}\n`, "  "));
		this.err("  Re-read immediately before this spawn (mantahostels#2553).\n");
		if (lines.some((l) => l.startsWith("cpu load "))) this.loadRemedy();
		if (lines.some((l) => /^cpu sessions .*so 0 slot/.test(l)))
			this.sessionRemedy();
		if (lines.some((l) => /^cpu (load|sessions) .* the only hold$/.test(l)))
			return;
		if (this.force) {
			this.err(
				"  --force does not cover memory; --force-memory overrides it, at the risk\n",
			);
			this.err("  of freezing the machine.\n");
		} else
			this.err(
				"  --force overrides an allowance refusal; --force-memory overrides a memory one.\n",
			);
		await this.rosterRemedy(text);
	}

	loadRemedy() {
		this.err(
			"  A CPU load hold: re-run this member later with the same command; it holds\n",
		);
		this.err(
			"  on load by itself (rule:load-wait). Neither --force nor --force-memory\n",
		);
		this.err(
			"  lifts it; WFC_LOAD_CEILING=0 or a 0 in ~/.claude/load-ceiling does, at the risk of\n",
		);
		this.err("  freezing WSL (#830).\n");
	}

	sessionRemedy() {
		this.err(
			"  A CPU session hold: wait for a live session to finish, then re-run this\n",
		);
		this.err("  member. Neither --force nor --force-memory lifts it;\n");
		this.err(
			"  WFC_SESSION_CEILING=0 does, at the cost of every session slowing (#2141).\n",
		);
	}

	/** @param {string} prompt */
	async memberBudget(prompt) {
		const budget = await this.readBudget(
			`${prompt} — not launching this member`,
		);
		if (!budget || Number(budget.fit) !== 0) return budget;
		this.err(`${memberRefused(prompt)}\n`);
		this.err(`  ${this.noFitLine(budget)}\n`);
		return null;
	}

	/**
	 * @param {string} model
	 * @param {string} prompt
	 * @param {Budget | null} budget
	 */
	async launchCommand(model, prompt, budget) {
		if (budget)
			return {
				launcher: "the headless launcher",
				cmd: [
					...this.launchEnv,
					"node",
					`${SCRIPTS}/lib/headless-sessions.js`,
					"launch",
					"--key",
					this.seatKey,
					"--cwd",
					".",
					"--budget",
					budget.headroom,
					`--name=${prompt}`,
					"--",
					prompt,
				],
			};
		const flags = ["--bg"];
		if (model !== "opus") flags.push("--model", model);
		if (await this.wantsAdvisor(model))
			flags.push("--advisor", this.advisorModel);
		return {
			launcher: "claude",
			cmd: [...this.launchEnv, this.claudeBin, ...flags, "--", prompt],
		};
	}

	/** @param {string} prompt */
	async launchDir(prompt) {
		const r = await this.run("session-checkout.js", [
			"launch-dir",
			...(this.noBuild === "1" ? ["--no-build"] : []),
			...(this.into === "" ? [] : ["--into", this.into]),
			"--",
			prompt,
		]);
		if (r.status === 0) return chomp(r.stdout);
		this.err(`${memberRefused(prompt)}\n`);
		this.err(prefixLines(r.stderr, "  "));
		return null;
	}

	/**
	 * @param {string} model
	 * @param {string} prompt
	 * @param {{launcher: string, cmd: string[], dir: string, budget: Budget | null}} at
	 */
	async launchAndRecord(model, prompt, { launcher, cmd, dir, budget }) {
		this.out(`${model}  `);
		const launched = await this.ports.launch(cmd, {
			cwd: dir,
			env: this.env,
			timeoutS: Number(this.launchTimeoutSeconds),
		});
		const firstLine = launched.output.match(/^[^\n]*\n?/)?.[0] ?? "";
		this.out(firstLine);
		if (launched.timedOut) {
			this.err(
				`\n  REFUSED: ${launcher} did not return within ${this.launchTimeoutSeconds}s. Killed, and NOT recorded as\n`,
			);
			this.exitWith(
				5,
				`  launched. ${docPath("environment.md", this.env)} §9 has the recovery.\n`,
			);
		}
		if (launched.status !== 0) {
			this.err(
				`  (${launcher} exited ${launched.status}; not recorded as launched.)\n`,
			);
			return false;
		}
		await this.record(model, prompt, bgLaunchId(firstLine), {
			budget,
			output: launched.output,
		});
		this.launchedPrompts.push(prompt);
		return true;
	}

	/**
	 * @param {string} model
	 * @param {string} prompt
	 * @param {string} jobId
	 * @param {{budget: Budget | null, output: string}} launch
	 */
	async record(model, prompt, jobId, { budget, output }) {
		const overflowRecord = budget
			? [
					"--overflow-key",
					this.seatKey,
					"--allowance-usd",
					budget.headroom,
					"--session-id",
					output
						.split("\n")
						.filter((l) => l.startsWith("session "))
						.map((l) => l.slice("session ".length))
						.join("\n"),
				]
			: [];
		await this.relayed("check-duplicate-dispatch.js", [
			"--record",
			"--issues",
			prompt,
			"--model",
			model,
			"--prompt",
			prompt,
			"--job-id",
			jobId,
			"--seat-reason",
			this.seatReason,
			...overflowRecord,
		]);
	}
}

/** @param {string} file */
function isFile(file) {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseJson(text) {
	try {
		const v = JSON.parse(text);
		return v !== null && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
}

/**
 * @typedef {Record<"trustworthy" | "weekPct" | "weekTrust" | "weekReset" |
 *   "sessionPct" | "sessionTrust" | "sessionReset" | "capError" | "capLaunch" |
 *   "capBar" | "capReading" | "capThreshold" | "capRunning" | "capFigure" |
 *   "capNRunning", string>} Allowance
 */

const ALLOWANCE_FIELDS = /** @type {const} */ ({
	weekPct: [["weekly_all", "percent"], "or"],
	weekTrust: [["weekly_all", "trust"], "value"],
	weekReset: [["weekly_all", "resetsAt"], "or"],
	sessionPct: [["session", "percent"], "or"],
	sessionTrust: [["session", "trust"], "value"],
	sessionReset: [["session", "resetsAt"], "or"],
	capError: [["cap", "error"], "or"],
	capLaunch: [["cap", "launch"], "or"],
	capReading: [["cap", "binding", "reading"], "value"],
	capThreshold: [["cap", "binding", "threshold"], "value"],
});

/**
 * @param {string} json
 * @returns {Allowance}
 */
function readAllowance(json) {
	const j = parseJson(json);
	if (j === null) {
		return /** @type {Allowance} */ ({
			...Object.fromEntries(Object.keys(ALLOWANCE_FIELDS).map((k) => [k, ""])),
			trustworthy: "false",
			weekTrust: "absent",
			sessionTrust: "absent",
			capBar: "",
			capRunning: "",
			capFigure: "",
			capNRunning: "",
		});
	}
	const binding = (/** @type {string} */ key) =>
		readAt(j, ["cap", "binding", key], false);
	return /** @type {Allowance} */ ({
		...Object.fromEntries(
			Object.entries(ALLOWANCE_FIELDS).map(([k, [at, kind]]) => [
				k,
				jqString(readAt(j, at, kind === "or")),
			]),
		),
		trustworthy: jqString(j.trustworthy === true),
		capBar: binding("bar") === "session" ? "session" : "weekly",
		capRunning: rounded(binding("runningPoints"), 10),
		capFigure: rounded(binding("perSessionPoints"), 100),
		capNRunning: jqLength(readAt(j, ["cap", "running"], false)),
	});
}

/**
 * @param {unknown} j
 * @param {readonly string[]} at
 * @param {boolean} or
 * @returns {unknown}
 */
function readAt(j, at, or) {
	let v = j;
	for (const k of at) {
		const here = v;
		v =
			here !== null && typeof here === "object"
				? (Object.entries(here).find(([key]) => key === k)?.[1] ?? null)
				: null;
	}
	return or && (v === null || v === false) ? "" : v;
}

/**
 * @param {unknown} x
 * @param {number} k
 */
function rounded(x, k) {
	return typeof x === "number" ? jqString(Math.round(x * k) / k) : "";
}

/** @param {unknown} v */
function jqLength(v) {
	if (v === null || v === undefined) return "0";
	if (typeof v === "string" || Array.isArray(v)) return `${v.length}`;
	return typeof v === "object" ? `${Object.keys(v).length}` : "";
}

/** @param {unknown} v */
function jqString(v) {
	if (typeof v === "string") return v;
	return v === undefined ? "null" : JSON.stringify(v);
}

module.exports = {
	MEMBER_REFUSED_TAIL,
	memberDropped,
	memberRefused,
	DEFAULT_CEILINGS,
	DEFAULT_STAGGER_SECONDS,
	dispatch,
};
