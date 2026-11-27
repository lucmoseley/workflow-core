const { noop } = require("./noop.js");
const { monotonicMs } = require("./clock.js");
const { clampedClause } = require("./suite-ladder.js");
const { scriptPath } = require("./script-path.js");
const { QUEUE_POLL_MS } = require("./queue-poll.js");
const { peakClause } = require("./part-suite-peak.js");
const { describeWindowsHold } = require("./windows-memory.js");

/**
 * @typedef {{ mb?: number, rungMb?: number, climbMb?: number, busy?: number, ladderMb?: number, peak?: import("./part-suite-peak.js").PeakCharge }} MemoryReading
 * @typedef {{ limb: "windows" } & import("./windows-memory.js").WindowsHold} WindowsHold
 * @typedef {{ limb: "count", pids?: (number | null)[], memory?: MemoryReading } | ({ limb: "memory" } & MemoryReading) | WindowsHold} GateDenial
 */
/**
 * @typedef {{ limb: "fifo" | "claim", pids: number[] } | { limb: "admitted" | "peer", holders: { pid: number, queue: string }[] }} TurnHold
 * @typedef {{ pid: number, kind: string, state: "running" | "admitted" | "waiting" }} SessionPlace
 * @typedef {{ limb: "session-cap", places: SessionPlace[] }} SessionCapHold
 */
/** @typedef {Exclude<import("./queue-exit-log.js").QueueExitReason, "killed">} WaitExitReason */
/** @typedef {"run"|"left"|"refused"} WaitOutcome */
/** @typedef {import("./queue-exit-log.js").HeldLimb} HeldLimb */
/**
 * @typedef {{ limb?: HeldLimb, climbMb?: number, peerS?: number, sessionCapS?: number, windowsReleased?: true, admission?: import("./part-suite-peak.js").PartAdmission }} WaitHold
 */
/** @typedef {"admitted"|"behind"|"ahead"} Admission */
const HOLD_STAMPS = /** @type {const} */ ({
	memoryHeld: "onMemoryHeld",
	restHeld: "onRestHeld",
	windowsHeld: "onWindowsHeld",
	climbHeld: "onClimbStamp",
});
/** @typedef {keyof typeof HOLD_STAMPS} HoldStamp */
/** @typedef {{ [K in HoldStamp as (typeof HOLD_STAMPS)[K]]?: (held: boolean) => void }} HoldListeners */

/**
 * @param {(stamp: HoldStamp) => (held: boolean) => void} listen
 * @returns {Required<HoldListeners>}
 */
function buildHoldListeners(listen) {
	return /** @type {Required<HoldListeners>} */ (
		Object.fromEntries(
			Object.entries(HOLD_STAMPS).map(([stamp, option]) => [
				option,
				listen(/** @type {HoldStamp} */ (stamp)),
			]),
		)
	);
}

// workflow-core#5594 measured: in workflow-core#5592's window no session outside the eight largest held more than 2 waits at once in either queue
const SESSION_PLACES = 2;

// workflow-core#5252 measured p99 wait that ended in a run 20.5 min here, 33 min in design-vault
const QUEUE_TIMEOUT_MS = 40 * 60 * 1000;

// workflow-core#4852 guess
const WINDOWS_MAX_HOLD_MS = 10 * 60 * 1000;

/**
 * @param {GateDenial | null} denial
 * @param {TurnHold | undefined} turnHold
 * @returns {Exclude<HeldLimb, "memory" | "windows" | "session-cap">}
 */
function heldLimb(denial, turnHold) {
	if (denial) return "count";
	return turnHold?.limb === "peer" ? "peer" : "turn";
}

const LIMB_NAMES = {
	count: "the count cap",
	memory: "the memory rung",
	windows: "the Windows-memory hold",
	fifo: "the waiters ahead",
	admitted: "a launch admitted and not yet up",
	peer: "an older waiter in the other queue the climb charge holds",
	claim: "an older touched run's first claim on memory",
	turn: "the queue's turn",
	yielded: "yielding to a launch admitted on the same poll",
	"session-cap": "this session's own places in the queue",
};

const HELD_LINE = {
	count: "gate still denies on its count cap",
	turn: "turn still closed",
	peer: `turn still closed on ${LIMB_NAMES.peer}`,
};

/**
 * @typedef {GateDenial | TurnHold | SessionCapHold | { limb: "turn" } | { limb: "yielded" }} WaitLimb
 */

/** @param {(number | null)[]} pids */
const pidList = (pids) =>
	pids.length === 0 ? "" : `, PID ${pids.map((p) => p ?? "unread").join(", ")}`;

/** @param {WaitLimb} hold */
function limbHolder(hold) {
	if (hold.limb === "count") return pidList(hold.pids ?? []);
	if (hold.limb === "fifo" || hold.limb === "claim") return pidList(hold.pids);
	if (hold.limb === "admitted" || hold.limb === "peer")
		return `, ${hold.holders.map(({ pid, queue }) => `PID ${pid} in ${queue}`).join(", ")}`;
	if (hold.limb === "session-cap") return `, ${placeList(hold.places)}`;
	return "";
}

/** @param {SessionPlace[]} places */
const placeList = (places) =>
	places
		.map(({ pid, kind, state }) => `PID ${pid} (${kind}, ${state})`)
		.join(", ");

/**
 * @param {string} label
 * @param {number} secs
 * @param {number} timeoutMs
 * @param {SessionCapHold} hold
 * @returns {string}
 */
function sessionCapRefusal(label, secs, timeoutMs, { places }) {
	const n = places.length;
	return `${label}: still behind this session's own ${n} place${n === 1 ? "" : "s"} in the queue after ${secs}s, the queue's ${Math.round(timeoutMs / 60_000)}-minute wait bound — refused, not run: one session holds at most ${SESSION_PLACES} places in each queue, its subagents' runs among them (workflow-core#5595). Its places: ${placeList(places)}. Run it again once one of them finishes.\n`;
}

/** @param {MemoryReading} hold */
const peakOf = ({ peak }) => (peak ? `, the rung of ${peakClause(peak)}` : "");

/**
 * @param {WaitLimb} hold
 * @returns {string}
 */
function describeLimb(hold) {
	if (hold.limb === "windows")
		return `${LIMB_NAMES.windows}, ${describeWindowsHold(hold)}`;
	if (hold.limb !== "memory")
		return `${LIMB_NAMES[hold.limb]}${limbHolder(hold)}`;
	const { mb, rungMb, climbMb, ladderMb } = hold;
	if (mb === undefined) return LIMB_NAMES.memory;
	const climb = climbMb ? `, less ${climbMb} MB yet to draw` : "";
	const rung = rungMb === undefined ? "" : ` against ~${rungMb} MB`;
	return `${LIMB_NAMES.memory}, MemAvailable ${mb} MB${climb}${rung}${clampedClause(ladderMb)}${peakOf(hold)}`;
}

/**
 * @param {GateDenial | null} denial
 * @param {boolean} open
 * @param {() => TurnHold | undefined} turnHold
 * @returns {WaitLimb | null}
 */
function waitLimb(denial, open, turnHold) {
	if (denial) return denial;
	if (open) return null;
	return turnHold() ?? { limb: "turn" };
}

/**
 * @param {GateDenial} denial
 * @param {() => boolean} turn
 * @param {() => TurnHold | undefined} turnHold
 * @returns {WaitLimb[]}
 */
function readAlsoHeld(denial, turn, turnHold) {
	/** @type {WaitLimb[]} */
	const also =
		denial.limb === "count" && denial.memory
			? [{ limb: "memory", ...denial.memory }]
			: [];
	if (!turn()) also.push(turnHold() ?? { limb: "turn" });
	return also;
}

/**
 * @param {[WaitLimb["limb"], number][]} parts
 * @param {number} wholeSecs
 * @returns {[WaitLimb["limb"], number][]}
 */
function roundedSecs(parts, wholeSecs) {
	const whole = parts.map(([, ms]) => Math.floor(ms / 1000));
	const short = wholeSecs - whole.reduce((sum, n) => sum + n, 0);
	const byRemainder = parts
		.map(([, ms], i) => ({ i, rest: ms % 1000 }))
		.sort((x, y) => y.rest - x.rest)
		.slice(0, Math.max(0, short));
	for (const { i } of byRemainder) whole[i] = (whole[i] ?? 0) + 1;
	return parts.map(([limb], i) => [limb, whole[i] ?? 0]);
}

/**
 * @param {WaitLimb[]} limbs
 * @param {number | undefined} lowest
 * @returns {number | undefined}
 */
function lowestReading(limbs, lowest) {
	let low = lowest;
	for (const limb of limbs)
		if (limb.limb === "memory" && limb.mb !== undefined)
			low = Math.min(low ?? limb.mb, limb.mb);
	return low;
}

/**
 * @param {() => number} clock
 * @param {number} started
 */
function limbTrace(clock, started) {
	/** @type {Map<WaitLimb["limb"], number>} */
	const heldMs = new Map();
	/** @type {WaitLimb | null} */
	let current = null;
	let identity = "";
	let since = started;
	let first = true;
	/** @type {number | undefined} */
	let lowestMb;
	const accrue = () => {
		const now = clock();
		if (current)
			heldMs.set(current.limb, (heldMs.get(current.limb) ?? 0) + now - since);
		since = now;
	};
	return {
		/**
		 * @param {WaitLimb | null} hold
		 * @param {WaitLimb[]} [also]
		 * @returns {string | null}
		 */
		see(hold, also = []) {
			if (first) {
				first = false;
				current = hold;
			}
			accrue();
			current = hold;
			if (!hold || hold.limb === "yielded") {
				if (!hold) identity = "";
				return null;
			}
			const held = [hold, ...also];
			lowestMb = lowestReading(held, lowestMb);
			const next = held
				.map((limb) => `${limb.limb}${limbHolder(limb)}`)
				.join(";");
			if (next === identity) return null;
			identity = next;
			return held.map(describeLimb).join("; also on ");
		},
		/**
		 * @param {WaitLimb["limb"]} limb
		 * @returns {number}
		 */
		heldMs(limb) {
			accrue();
			return heldMs.get(limb) ?? 0;
		},
		/** @param {number} wholeSecs */
		breakdown(wholeSecs) {
			accrue();
			const spent = roundedSecs([...heldMs], wholeSecs)
				.map(([limb, secs]) => `${secs}s on ${LIMB_NAMES[limb]}`)
				.join(", ");
			if (!spent || lowestMb === undefined) return spent;
			return `${spent}; MemAvailable at lowest ${lowestMb} MB`;
		},
	};
}

/**
 * @param {string} label
 * @param {number} secs
 * @param {MemoryReading} denial
 * @returns {string}
 */
function memoryRefusal(label, secs, { mb, rungMb, climbMb, ladderMb, peak }) {
	const rung =
		rungMb === undefined
			? ""
			: ` against the ~${rungMb} MB rung${clampedClause(ladderMb)}${peakOf({ peak })}`;
	const climb = climbMb
		? `, less ${climbMb} MB ${peak ? "the queues'" : "the other queue's"} launches have yet to draw${rung ? "," : ""}`
		: "";
	const reading =
		mb === undefined ? "" : ` (MemAvailable ${mb} MB${climb}${rung})`;
	return `${label}: gate still denies on memory after ${secs}s${reading} — refused, not run. Reap finished sessions (\`node ${scriptPath("reap-finished-sessions.js")}\`) and run it again (workflow-core#2421).\n`;
}

/**
 * @param {string} label
 * @param {number} secs
 * @param {WindowsHold} denial
 * @returns {string}
 */
function windowsRefusal(label, secs, denial) {
	return `${label}: the Windows-memory hold still holds after ${secs}s (${describeWindowsHold(denial)}) — refused, not run. Close what Windows runs beside the VM, or wait for it to free, and run it again (workflow-core#4557).\n`;
}

/**
 * @param {GateDenial | null} denial
 * @returns {number}
 */
function heldOnClimbMb(denial) {
	if (denial?.limb !== "memory" || !denial.climbMb) return 0;
	const { mb, rungMb, climbMb } = denial;
	return mb !== undefined && rungMb !== undefined && mb >= rungMb ? climbMb : 0;
}

/**
 * @param {string | undefined} limb
 * @param {boolean} charged
 * @returns {boolean}
 */
function isClimbKept(limb, charged) {
	return charged && (limb === "memory" || limb === "windows");
}

/**
 * @param {(held: boolean) => void} listener
 * @returns {(held: boolean) => void}
 */
function changesOnly(listener) {
	let last = false;
	return (held) => {
		if (held === last) return;
		last = held;
		listener(held);
	};
}

/**
 * @param {{ pollMs?: number, timeoutMs?: number, gate: (climbMb: number, onAdmission?: (admission: import("./part-suite-peak.js").PartAdmission) => void) => GateDenial | null, climbMb?: () => number, onAdmission?: (admission: import("./part-suite-peak.js").PartAdmission) => void, turn?: () => boolean, leave?: () => string|null, hold?: () => Promise<boolean>, admit: () => Admission, sleepFn?: (ms: number) => Promise<void>, out?: { write: (s: string) => unknown }, label?: string, waiting?: string, cap?: string, part?: boolean, onClimbHeld?: (climbMb: number) => void, onPeerHeld?: (secs: number) => void, sessionCap?: () => SessionCapHold | null, onSessionCapHeld?: (secs: number) => void, onMemoryRung?: (rungMb: number) => void, onExit?: (reason: WaitExitReason, waitMs: number, heldBy?: WaitHold) => void, monoClock?: () => number, traceLimbs?: boolean, turnHold?: () => TurnHold | undefined, waitedMs?: number } & HoldListeners} options
 * @returns {Promise<WaitOutcome>}
 */
function waitForGate({
	pollMs = QUEUE_POLL_MS,
	timeoutMs = QUEUE_TIMEOUT_MS,
	onAdmission = noop,
	gate,
	climbMb = () => 0,
	turn = () => true,
	leave = () => null,
	hold,
	admit,
	sleepFn = (/** @type {number} */ ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
	out = process.stderr,
	label = "--queue",
	waiting = "a suite is already running; waiting for it",
	cap = "one whole suite runs at a time (workflow-core#2714)",
	part = false,
	onClimbHeld = noop,
	onPeerHeld = noop,
	sessionCap = () => null,
	onSessionCapHeld = noop,
	onMemoryRung = noop,
	onExit = noop,
	monoClock: clock = monotonicMs,
	traceLimbs = false,
	turnHold = () => undefined,
	waitedMs = 0,
	...holdOptions
}) {
	if (typeof admit !== "function")
		throw new TypeError("waitForGate: `admit` is required (workflow-core#2742)");
	if (typeof gate !== "function")
		throw new TypeError("waitForGate: `gate` is required");
	/** @type {import("./part-suite-peak.js").PartAdmission | undefined} */
	let heard;
	const hearAdmission = (
		/** @type {import("./part-suite-peak.js").PartAdmission} */ a,
	) => {
		heard = a;
		onAdmission(a);
	};
	const started = clock() - waitedMs;
	const secs = () => Math.round((clock() - started) / 1000);
	let announced = false;
	let held = false;
	const hear = buildHoldListeners((stamp) =>
		changesOnly(holdOptions[HOLD_STAMPS[stamp]] ?? noop),
	);
	let climbKept = false;
	let climbHeldMb = 0;
	/** @type {number | undefined} */
	let rungHeardMb;
	/** @param {number} rungMb */
	const hearRung = (rungMb) => {
		if (rungMb === rungHeardMb) return;
		rungHeardMb = rungMb;
		onMemoryRung(rungMb);
	};
	/** @type {number | undefined} */
	let windowsSince;
	let spellReleased = false;
	let windowsReleased = false;
	/** @param {GateDenial | null} denial */
	const releaseWindows = (denial) => {
		if (denial?.limb !== "windows") {
			windowsSince = undefined;
			spellReleased = false;
			return denial;
		}
		windowsSince ??= clock();
		if (clock() - windowsSince < WINDOWS_MAX_HOLD_MS) return denial;
		if (!spellReleased)
			out.write(
				`${label}: the Windows-memory hold released this wait after ${secs()}s, its ${WINDOWS_MAX_HOLD_MS / 60_000}-minute maximum (${describeWindowsHold(denial)}) (workflow-core#4850)\n`,
			);
		spellReleased = true;
		windowsReleased = true;
		return null;
	};
	const trace = limbTrace(clock, started);
	const peerHeldS = () => Math.round(trace.heldMs("peer") / 1000);
	const capHeldS = () => Math.round(trace.heldMs("session-cap") / 1000);
	const breakdown = () => (traceLimbs ? trace.breakdown(secs()) : "");
	const sayBreakdown = () => {
		const spent = breakdown();
		if (spent) out.write(`${label}: held ${spent}\n`);
	};
	/** @param {WaitExitReason} reason @param {WaitOutcome} outcome @param {HeldLimb} [limb] */
	const exit = (reason, outcome, limb) => {
		const peerS = peerHeldS();
		const sessionCapS = capHeldS();
		const heldBy = {
			...(limb ? { limb } : {}),
			...(climbHeldMb > 0 ? { climbMb: climbHeldMb } : {}),
			...(peerS > 0 ? { peerS } : {}),
			...(sessionCapS > 0 ? { sessionCapS } : {}),
			...(windowsReleased
				? { windowsReleased: /** @type {const} */ (true) }
				: {}),
			...(heard ? { admission: heard } : {}),
		};
		onExit(
			reason,
			clock() - started,
			...(Object.keys(heldBy).length > 0 ? [heldBy] : []),
		);
		return Promise.resolve(outcome);
	};
	const announce = () => {
		if (announced) return;
		announced = true;
		out.write(`${label}: ${waiting}\n`);
	};
	/** @returns {Promise<WaitOutcome>} */
	const wait = () => {
		announce();
		held = false;
		return sleepFn(pollMs).then(step);
	};
	/** @param {WaitLimb | null} limb @param {WaitLimb[]} also */
	const report = (limb, also) => {
		const line = trace.see(limb, also);
		onPeerHeld(peerHeldS());
		onSessionCapHeld(capHeldS());
		if (!traceLimbs || !line) return;
		announce();
		out.write(`${label}: after ${secs()}s, held on ${line}\n`);
	};
	/** @param {GateDenial | null} denial @param {boolean} open */
	const see = (denial, open) => {
		const also =
			traceLimbs && denial ? readAlsoHeld(denial, turn, turnHold) : [];
		report(waitLimb(denial, open, turnHold), also);
	};
	/**
	 * @param {() => Promise<WaitOutcome>} launch
	 * @param {boolean} atOnce
	 * @returns {Promise<WaitOutcome>}
	 */
	const admitOrYield = (launch, atOnce) => {
		const admission = admit();
		if (admission === "admitted") return launch();
		trace.see({ limb: "yielded" });
		out.write(
			`${label}: another launch was admitted on the same poll — yielding to it (workflow-core#2622)\n`,
		);
		return admission === "ahead" && atOnce ? step() : wait();
	};
	/** @param {GateDenial | null} denial @returns {Promise<WaitOutcome>} */
	const refuse = (denial) => {
		sayBreakdown();
		if (denial?.limb === "memory") {
			out.write(memoryRefusal(label, secs(), denial));
			return exit("refused", "refused", "memory");
		}
		if (denial?.limb === "windows") {
			out.write(windowsRefusal(label, secs(), denial));
			return exit("refused", "refused", "windows");
		}
		const limb = heldLimb(denial, turnHold());
		out.write(
			`${label}: ${HELD_LINE[limb]} after ${secs()}s, the queue's ${Math.round(timeoutMs / 60_000)}-minute wait bound — refused, not run: ${cap}.\n`,
		);
		return exit("refused", "refused", limb);
	};
	/** @param {GateDenial | null} denial @returns {Promise<WaitOutcome>} */
	const runAnyway = (denial) =>
		admitOrYield(() => {
			sayBreakdown();
			out.write(
				`${label}: gate still closed after ${secs()}s — running anyway\n`,
			);
			return exit("timeout", "run", heldLimb(denial, turnHold()));
		}, false);
	/**
	 * @param {GateDenial | null} denial
	 * @param {boolean} open
	 * @returns {Promise<WaitOutcome>}
	 */
	const proceed = (denial, open) => {
		if (hold && !held) {
			held = true;
			return hold().then((go) => (go ? step() : exit("refused", "refused")));
		}
		if (!open)
			return denial?.limb === "memory" || denial?.limb === "windows"
				? refuse(denial)
				: runAnyway(denial);
		return admitOrYield(() => {
			const spent = breakdown();
			if (announced)
				out.write(
					`${label}: gate opened after ${secs()}s${spent ? ` — held ${spent}` : ""}\n`,
				);
			return exit("opened", "run");
		}, true);
	};
	/**
	 * @param {GateDenial | null} denial
	 * @param {number} charged
	 */
	const stampDenial = (denial, charged) => {
		const heldOn = heldOnClimbMb(denial);
		if (heldOn > climbHeldMb) {
			climbHeldMb = heldOn;
			onClimbHeld(heldOn);
		}
		hear.onMemoryHeld(denial?.limb === "memory");
		if (denial?.limb === "memory" && denial.rungMb !== undefined)
			hearRung(denial.rungMb);
		hear.onRestHeld(
			denial?.limb === "memory" && denial.busy === 0 && !denial.climbMb,
		);
		hear.onWindowsHeld(denial?.limb === "windows");
		climbKept =
			heldOn > 0 || (climbKept && isClimbKept(denial?.limb, charged > 0));
		hear.onClimbStamp(climbKept);
	};
	/** @returns {Promise<WaitOutcome>} */
	const leaveOrWait = () => {
		const emptied = leave();
		if (emptied !== null) {
			out.write(
				`${label}: after ${secs()}s ${emptied} reaches no test file, so this run leaves the queue (workflow-core#1158).\n`,
			);
			return exit("left", "left");
		}
		return wait();
	};
	/** @param {SessionCapHold} capHold @returns {Promise<WaitOutcome>} */
	const heldOnCap = (capHold) => {
		report(capHold, []);
		if (clock() - started < timeoutMs) return leaveOrWait();
		sayBreakdown();
		out.write(sessionCapRefusal(label, secs(), timeoutMs, capHold));
		return exit("refused", "refused", "session-cap");
	};
	/** @returns {Promise<WaitOutcome>} */
	const step = () => {
		const capHold = sessionCap();
		if (capHold) return heldOnCap(capHold);
		const charged = climbMb();
		const denial = releaseWindows(gate(charged, hearAdmission));
		stampDenial(denial, charged);
		const open = !denial && turn();
		see(denial, open);
		if (!open && clock() - started >= timeoutMs)
			return part ? proceed(denial, false) : refuse(denial);
		if (open) return proceed(denial, true);
		return leaveOrWait();
	};
	return step();
}

module.exports = {
	HOLD_STAMPS,
	QUEUE_TIMEOUT_MS,
	SESSION_PLACES,
	WINDOWS_MAX_HOLD_MS,
	buildHoldListeners,
	isClimbKept,
	waitForGate,
};
