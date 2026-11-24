const { LOOP_OFF, STALE_MS } = require("./concurrency.js");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// workflow-core#5197 guess
const THIN_HOURS = 10;
// workflow-core#5196 guess: <16, 16–24, 24–32, 32+ on 8 cores
const LOAD_EDGES_PER_CORE = [2, 3, 4];
// workflow-core#5185 guess: its analysis range starts at 5 sessions
const MARGINAL_FROM_SESSIONS = 5;
// workflow-core#5197 guess: the 2.5th and 97.5th percentiles settle to the second figure on a rerun with another seed
const BOOTSTRAP_RESAMPLES = 2000;
const BOOTSTRAP_SEED = 5196;
const LIMBS = /** @type {const} */ ([
	"load",
	"sessions",
	"memory",
	"Windows memory",
	"none",
]);

/**
 * @typedef {import("./concurrency.js").Limb} Limb
 * @typedef {{ t: number, load1: number | null, sessions: number | null }} MinuteRow
 * @typedef {{ t: number, live: number | null, limit: string | null,
 *  limb: Limb | null }} TickRow
 * @typedef {{ repo: string, number: number, closedAt: number,
 *  reason: string }} CloseRow
 * @typedef {{ date: string, state: "read" | "failed" | "truncated",
 *  why?: string }} DayRow
 * @typedef {{ repo: string, sha: string, t: number, seq: number,
 *  subject: string, cites: number[], reverts: string | null,
 *  revertsSubject: string | null }} CommitRow
 * @typedef {{ t: number, bash: number[], hto: number }} TranscriptMinute
 * @typedef {{ id: string, template: string | null, st: number,
 *  en: number }} JobRow
 * @typedef {{ st: number, en: number }} Span
 * @typedef {{ since: number, until: number, cores: number,
 *  eras: { label: string, from: number }[], minutes: MinuteRow[] | null,
 *  ticks: TickRow[] | null, closes: CloseRow[], days: DayRow[],
 *  commits: CommitRow[], logRepos: string[], queue: Span[] | null,
 *  transcripts: TranscriptMinute[] | null, jobs: JobRow[] | null,
 *  dispatched: string[] | null, queueWhy?: string,
 *  transcriptsWhy?: string }} Records
 */

/**
 * @typedef {{ t: number, era: string, load1: number | null,
 *  sessions: number | null, limb: Limb | null, closesRead: boolean,
 *  queuedS: number | null, bash: number[] | null, hto: number | null,
 *  hand: number | null, dispatched: number | null }} Minute
 * @typedef {{ era: string, hour: number, minutes: Minute[],
 *  closes: { counted: number, reverted: number, commits: number,
 *    joined: number } }} Bucket
 */

/** @param {number} t */
const minuteOf = (t) => Math.floor(t / MINUTE_MS) * MINUTE_MS;

/** @param {number} x */
const sessionBand = (x) => Math.round(x);

/** @param {number[]} xs */
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** @param {number[]} xs @returns {number | null} */
function median(xs) {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	const hi = s[mid];
	const lo = s[mid - 1];
	if (hi === undefined) return null;
	if (s.length % 2 || lo === undefined) return hi;
	return (lo + hi) / 2;
}

/** @param {number} a @param {number} b */
const ratio = (a, b) => (b > 0 ? a / b : null);

/** @param {number} seed */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d_2b_79_f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/**
 * @template T
 * @param {T[]} items
 * @param {(xs: T[]) => number | null} stat
 * @returns {[number, number] | null}
 */
function bootstrap(items, stat) {
	const rand = mulberry32(BOOTSTRAP_SEED);
	/** @type {number[]} */
	const out = [];
	for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
		/** @type {T[]} */
		const draw = [];
		for (const _ of items) {
			const pick = items[Math.floor(rand() * items.length)];
			if (pick !== undefined) draw.push(pick);
		}
		const v = stat(draw);
		if (v !== null) out.push(v);
	}
	out.sort((a, b) => a - b);
	const lo = out[Math.floor(0.025 * out.length)];
	const hi = out[Math.min(out.length - 1, Math.floor(0.975 * out.length))];
	return lo === undefined || hi === undefined ? null : [lo, hi];
}

/** @param {{ x: number, y: number }[]} pts */
function slopeOf(pts) {
	const n = pts.length;
	if (n < 2) return null;
	const mx = sum(pts.map((p) => p.x)) / n;
	const my = sum(pts.map((p) => p.y)) / n;
	const sxx = sum(pts.map((p) => (p.x - mx) ** 2));
	if (sxx === 0) return null;
	return sum(pts.map((p) => (p.x - mx) * (p.y - my))) / sxx;
}

/** @param {CommitRow} c */
const isRevert = (c) => c.reverts !== null || c.revertsSubject !== null;

/** @param {CommitRow} c @param {CommitRow[]} commits @returns {string | null} */
function revertTarget(c, commits) {
	if (c.reverts) return c.reverts;
	/** @type {CommitRow | null} */
	let best = null;
	for (const x of commits)
		if (
			x.repo === c.repo &&
			x.sha !== c.sha &&
			x.subject === c.revertsSubject &&
			x.seq < c.seq &&
			(!best || x.seq > best.seq)
		)
			best = x;
	return best?.sha ?? null;
}

/** @param {CommitRow[]} commits @returns {(sha: string) => boolean} */
function standing(commits) {
	/** @type {Map<string, string[]>} */
	const revertedBy = new Map();
	for (const c of commits) {
		const target = isRevert(c) ? revertTarget(c, commits) : null;
		if (target)
			revertedBy.set(target, [...(revertedBy.get(target) ?? []), c.sha]);
	}
	/** @type {Map<string, boolean>} */
	const memo = new Map();
	/** @param {string} sha @returns {boolean} */
	const stands = (sha) => {
		const known = memo.get(sha);
		if (known !== undefined) return known;
		memo.set(sha, true);
		const v = !(revertedBy.get(sha) ?? []).some(stands);
		memo.set(sha, v);
		return v;
	};
	return stands;
}

/** @param {Records} r */
function joinCloses(r) {
	/** @type {Map<string, CloseRow>} */
	const last = new Map();
	for (const c of r.closes) {
		if (c.reason !== "COMPLETED") continue;
		const key = `${c.repo}#${c.number}`;
		const prev = last.get(key);
		if (!prev || c.closedAt > prev.closedAt) last.set(key, c);
	}
	const logged = new Set(r.logRepos);
	const stands = standing(r.commits);
	/** @type {Map<string, CommitRow[]>} */
	const naming = new Map();
	for (const c of r.commits) {
		if (isRevert(c)) continue;
		for (const n of c.cites) {
			const key = `${c.repo}#${n}`;
			naming.set(key, [...(naming.get(key) ?? []), c]);
		}
	}
	return [...last].map(([key, c]) => {
		const named = naming.get(key) ?? [];
		const undone = named.filter((x) => !stands(x.sha));
		const lastUndone = Math.max(...undone.map((x) => x.seq));
		const reverted =
			undone.length > 0 &&
			!named.some((x) => stands(x.sha) && x.seq > lastUndone);
		return {
			...c,
			joined: logged.has(c.repo),
			reverted,
			commits: named.length,
		};
	});
}

/** @template {{ t: number }} T @param {T[]} rows */
function freshAt(rows) {
	let i = 0;
	/** @type {T | null} */
	let held = null;
	/** @param {number} t @returns {T | null} */
	return (t) => {
		for (let row = rows[i]; row !== undefined && row.t <= t; row = rows[i]) {
			held = row;
			i++;
		}
		return held && t - held.t <= STALE_MS ? held : null;
	};
}

/** @param {Span[]} spans @param {Set<number>} covered */
function secondsPerMinute(spans, covered) {
	/** @type {Map<number, number>} */
	const out = new Map();
	for (const s of spans)
		for (let m = minuteOf(s.st); m < s.en; m += MINUTE_MS) {
			if (!covered.has(m)) continue;
			const ms = Math.min(s.en, m + MINUTE_MS) - Math.max(s.st, m);
			if (ms > 0) out.set(m, (out.get(m) ?? 0) + ms / 1000);
		}
	return out;
}

/**
 * @param {TickRow | null} tick
 */
const loopLive = (tick) =>
	tick && tick.limit !== LOOP_OFF && typeof tick.live === "number"
		? tick.live
		: null;

/** @param {(JobRow & { sent: boolean })[]} jobs @param {number} t */
function jobsAt(jobs, t) {
	const live = jobs.filter((j) => j.st <= t && j.en > t);
	const dispatched = live.filter((j) => j.sent).length;
	return { hand: live.length - dispatched, dispatched };
}

/** @param {Records} r @returns {Minute[]} */
function buildMinutes(r) {
	const eras = [...r.eras].sort((a, b) => a.from - b.from);
	const eraOf = (/** @type {number} */ t) =>
		eras.findLast((e) => t >= e.from)?.label ?? "window start";
	/** @type {Map<number, MinuteRow>} */
	const lines = new Map();
	for (const m of r.minutes ?? [])
		if (m.t >= r.since && m.t < r.until) lines.set(minuteOf(m.t), m);
	const covered = new Set(lines.keys());
	const tickAt = freshAt([...(r.ticks ?? [])].sort((a, b) => a.t - b.t));
	const badDays = new Set(
		r.days.filter((d) => d.state !== "read").map((d) => d.date),
	);
	const queued = r.queue ? secondsPerMinute(r.queue, covered) : null;
	/** @type {Map<number, TranscriptMinute>} */
	const said = new Map((r.transcripts ?? []).map((x) => [minuteOf(x.t), x]));
	const dispatched = new Set(r.dispatched ?? []);
	const jobs = (r.jobs ?? []).map((j) => ({
		...j,
		sent: dispatched.has(j.id) || j.template === "bg",
	}));
	return [...lines]
		.sort((a, b) => a[0] - b[0])
		.map(([t, line]) => {
			const tick = tickAt(t);
			const words = said.get(t);
			return {
				t,
				era: eraOf(t),
				load1: line.load1,
				sessions: loopLive(tick) ?? line.sessions,
				limb: tick?.limb ?? null,
				closesRead: !badDays.has(new Date(t).toISOString().slice(0, 10)),
				queuedS: queued ? (queued.get(t) ?? 0) : null,
				bash: r.transcripts ? (words?.bash ?? []) : null,
				hto: r.transcripts ? (words?.hto ?? 0) : null,
				...(r.jobs && r.dispatched
					? jobsAt(jobs, t)
					: { hand: null, dispatched: null }),
			};
		});
}

/** @param {Minute[]} minutes @param {ReturnType<typeof joinCloses>} closes */
function bucketsOf(minutes, closes) {
	/** @type {Map<string, Bucket>} */
	const out = new Map();
	/** @type {Map<number, Bucket>} */
	const byMinute = new Map();
	for (const m of minutes) {
		const hour = Math.floor(m.t / HOUR_MS) * HOUR_MS;
		const key = `${hour} ${m.era}`;
		let b = out.get(key);
		if (!b) {
			b = {
				era: m.era,
				hour,
				minutes: [],
				closes: { counted: 0, reverted: 0, commits: 0, joined: 0 },
			};
			out.set(key, b);
		}
		b.minutes.push(m);
		if (m.closesRead) byMinute.set(m.t, b);
	}
	for (const c of closes) {
		const b = byMinute.get(minuteOf(c.closedAt));
		if (!b) continue;
		if (c.reverted) b.closes.reverted++;
		else b.closes.counted++;
		if (c.joined) {
			b.closes.joined++;
			b.closes.commits += c.commits;
		}
	}
	return [...out.values()];
}

/** @param {Bucket} b @param {(m: Minute) => number | null} pick */
function meanOf(b, pick) {
	const xs = b.minutes.map(pick).filter((x) => x !== null);
	return xs.length > 0 ? sum(/** @type {number[]} */ (xs)) / xs.length : null;
}

/** @param {Minute[]} ms @param {(m: Minute) => boolean} has */
const hoursWhere = (ms, has) => ms.filter(has).length / 60;

/** @param {Bucket[]} bs */
function closesPerHour(bs) {
	const ms = bs.flatMap((b) => b.minutes);
	return ratio(
		sum(bs.map((b) => b.closes.counted)),
		hoursWhere(ms, (m) => m.closesRead),
	);
}

/**
 * @param {string} era
 * @param {string} band
 * @param {Bucket[]} bs
 */
function bandOf(era, band, bs) {
	const ms = bs.flatMap((b) => b.minutes);
	const hours = ms.length / 60;
	const read = ms.filter((m) => m.closesRead);
	const counted = sum(bs.map((b) => b.closes.counted));
	const reverted = sum(bs.map((b) => b.closes.reverted));
	const joined = sum(bs.map((b) => b.closes.joined));
	const sessionHours = (/** @type {Minute[]} */ xs) =>
		sum(xs.map((m) => m.sessions ?? 0)) / 60;
	const queued = ms.filter((m) => m.queuedS !== null);
	const said = ms.filter((m) => m.bash !== null);
	const limbed = ms.filter((m) => m.limb !== null);
	const jobbed = ms.filter((m) => m.hand !== null);
	return {
		era,
		band,
		hours,
		thin: hours < THIN_HOURS,
		closes: counted + reverted,
		reverted,
		counted,
		closesPerHour: closesPerHour(bs),
		closesPerHourCi: bootstrap(bs, closesPerHour),
		sessionHours: sessionHours(ms),
		closesPerSessionHour: ratio(counted, sessionHours(read)),
		revertRate: ratio(reverted, counted + reverted),
		commitsPerClose: ratio(sum(bs.map((b) => b.closes.commits)), joined),
		queueShare: ratio(
			sum(queued.map((m) => /** @type {number} */ (m.queuedS))),
			sessionHours(queued) * 3600,
		),
		bashMedianS: median(said.flatMap((m) => m.bash ?? [])),
		refusalsPerHour: ratio(sum(said.map((m) => m.hto ?? 0)), said.length / 60),
		limbShare:
			limbed.length > 0
				? Object.fromEntries(
						LIMBS.map((l) => [
							l,
							limbed.filter((m) => m.limb === l).length / limbed.length,
						]),
					)
				: null,
		handOpenedHours:
			jobbed.length > 0 ? sum(jobbed.map((m) => m.hand ?? 0)) / 60 : null,
		dispatchedHours:
			jobbed.length > 0 ? sum(jobbed.map((m) => m.dispatched ?? 0)) / 60 : null,
	};
}

/** @typedef {ReturnType<typeof bandOf>} Band */

/**
 * @param {Bucket[]} buckets
 * @param {(b: Bucket) => string | null} label
 * @param {(a: string, b: string) => number} order
 */
function banded(buckets, label, order) {
	/** @type {Map<string, Map<string, Bucket[]>>} */
	const byEra = new Map();
	for (const b of buckets) {
		const l = label(b);
		if (l === null) continue;
		const bands = byEra.get(b.era) ?? new Map();
		bands.set(l, [...(bands.get(l) ?? []), b]);
		byEra.set(b.era, bands);
	}
	return [...byEra].flatMap(([era, bands]) =>
		[...bands]
			.sort((a, b) => order(a[0], b[0]))
			.map(([l, bs]) => ({ band: bandOf(era, l, bs), buckets: bs })),
	);
}

/** @param {string} era @param {Bucket[]} buckets */
function marginalOf(era, buckets) {
	const pts = buckets.flatMap((b) => {
		const x = meanOf(b, (m) => m.sessions);
		const q = b.minutes.filter((m) => m.queuedS !== null);
		if (x === null || sessionBand(x) < MARGINAL_FROM_SESSIONS || q.length === 0)
			return [];
		const y = sum(q.map((m) => m.queuedS ?? 0)) / q.length;
		return [{ x, y }];
	});
	const slope = slopeOf(pts);
	if (slope === null)
		return {
			era,
			hours: pts.length,
			thin: pts.length < THIN_HOURS,
			slope: null,
			ci: null,
			none: `${pts.length} hour(s) at ${MARGINAL_FROM_SESSIONS}+ sessions with the queue log read, too few or too alike to fit`,
		};
	return {
		era,
		hours: pts.length,
		thin: pts.length < THIN_HOURS,
		slope,
		ci: bootstrap(pts, slopeOf),
		none: null,
	};
}

/** @param {string} era @param {Band[]} bands */
function plateauOf(era, bands) {
	const read = bands.filter((b) => !b.thin && b.closesPerHour !== null);
	if (read.length === 0)
		return {
			era,
			peak: null,
			from: null,
			none: "every session band is thin or unread",
		};
	const peak = read.reduce((a, b) =>
		/** @type {number} */ (b.closesPerHour) >
		/** @type {number} */ (a.closesPerHour)
			? b
			: a,
	);
	const from = read.find(
		(b) =>
			(b.closesPerHourCi?.[1] ?? Number.NEGATIVE_INFINITY) >=
			/** @type {number} */ (peak.closesPerHour),
	);
	return { era, peak: peak.band, from: from?.band ?? peak.band, none: null };
}

/** @param {Records} r @param {Minute[]} minutes */
function lackingOf(r, minutes) {
	const windowH = (r.until - r.since) / HOUR_MS;
	const coveredH = minutes.length / 60;
	/** @type {{ source: string, hours: number, why: string }[]} */
	const out = [];
	const lack = (
		/** @type {string} */ source,
		/** @type {number} */ hours,
		/** @type {string} */ why,
	) => {
		if (hours > 0) out.push({ source, hours, why });
	};
	lack(
		"minute log",
		windowH - coveredH,
		r.minutes
			? "no minute line: the machine was off or restarting, or memwatch was not writing"
			: "the minute log would not read",
	);
	lack(
		"closes",
		hoursWhere(minutes, (m) => !m.closesRead),
		"their UTC day's fetch failed or hit the search cap",
	);
	lack(
		"sessions",
		hoursWhere(minutes, (m) => m.sessions === null),
		"neither a fresh refill tick nor the minute line gave a count",
	);
	lack(
		"binding limb",
		hoursWhere(minutes, (m) => m.limb === null),
		r.ticks
			? "no fresh refill tick, or one that read no admission"
			: "the refill tick record would not read",
	);
	if (!r.queue)
		lack("queue logs", coveredH, r.queueWhy ?? "the queue logs would not read");
	if (!r.transcripts)
		lack(
			"transcripts",
			coveredH,
			r.transcriptsWhy ?? "dense_minute.py gave no per-minute output",
		);
	if (!r.jobs) lack("job records", coveredH, "no job store would read");
	if (!r.dispatched)
		lack("dispatch log", coveredH, "pick-next's dispatch log would not read");
	return out;
}

/**
 * @param {Records} r
 */
function readout(r) {
	const closes = joinCloses(r);
	const minutes = buildMinutes(r);
	const buckets = bucketsOf(minutes, closes);
	const edges = LOAD_EDGES_PER_CORE.map((e) => e * r.cores);
	const loadLabels = [
		...edges.map((e, i) => (i === 0 ? `<${e}` : `${edges[i - 1]}–${e}`)),
		`${edges.at(-1)}+`,
	];
	const sessionsBands = banded(
		buckets,
		(b) => {
			const x = meanOf(b, (m) => m.sessions);
			return x === null ? null : String(sessionBand(x));
		},
		(a, b) => Number(a) - Number(b),
	);
	const loadBands = banded(
		buckets,
		(b) => {
			const x = meanOf(b, (m) => m.load1);
			if (x === null) return null;
			const i = edges.findIndex((e) => x < e);
			return loadLabels[i < 0 ? edges.length : i] ?? null;
		},
		(a, b) => loadLabels.indexOf(a) - loadLabels.indexOf(b),
	);
	const eras = [...new Set(buckets.map((b) => b.era))];
	const unjoined = new Map();
	for (const c of closes)
		if (!c.joined) unjoined.set(c.repo, (unjoined.get(c.repo) ?? 0) + 1);
	return {
		since: new Date(r.since).toISOString(),
		until: new Date(r.until).toISOString(),
		cores: r.cores,
		lacking: lackingOf(r, minutes),
		truncatedDays: r.days
			.filter((d) => d.state === "truncated")
			.map((d) => d.date),
		failedDays: r.days
			.filter((d) => d.state === "failed")
			.map((d) => ({ date: d.date, why: d.why ?? "" })),
		commitsUnread: [...unjoined].map(([repo, n]) => ({ repo, closes: n })),
		sessions: sessionsBands.map((x) => x.band),
		load: loadBands.map((x) => x.band),
		marginalQueueWait: eras.map((era) =>
			marginalOf(
				era,
				buckets.filter((b) => b.era === era),
			),
		),
		plateau: eras.map((era) =>
			plateauOf(
				era,
				sessionsBands.filter((x) => x.band.era === era).map((x) => x.band),
			),
		),
	};
}

/** @typedef {ReturnType<typeof readout>} Readout */

module.exports = { LIMBS, MARGINAL_FROM_SESSIONS, THIN_HOURS, readout };
