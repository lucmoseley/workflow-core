import type { AgentInfo, Register } from "claude-code";
import type { LivenessRecord, LivenessRow } from "../types";

export const register: Register = (on) => {
	// measured, #851
	const versionFloor = [2, 1, 289];
	// #863
	const tickMs = 5000;
	const stallMs = 5 * 60_000;
	// guess, #864
	const descriptionMaxChars = 32;
	const handbackTool = "SubagentHandback";
	const liveStatuses: ReadonlySet<string> = new Set([
		"pending",
		"running",
		"waiting",
	]);
	// #945
	const recordsRef = { plugin: "wfc-liveness", key: "records" } as const;
	const rowsRef = { plugin: "wfc-liveness", key: "rows" } as const;
	const paneId = "liveness";
	const modName = "wfc-liveness";
	const configRelPath = ".claude/workflow-core.json";

	let isLive = false;
	let records: Record<string, LivenessRecord> = {};
	let cancelTick: (() => void) | undefined;
	let saving: Promise<unknown> = Promise.resolve();

	const isAtFloor = (version: string): boolean => {
		const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
		if (!parts) return false;
		for (let i = 0; i < versionFloor.length; i++) {
			const have = parts[i] ?? 0;
			const need = versionFloor[i] ?? 0;
			if (have !== need) return have > need;
		}
		return true;
	};

	const messageOf = (err: unknown) =>
		err instanceof Error ? err.message : String(err);

	const isOnInConfig = (text: string): boolean => {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error("not a JSON object");
		const mods = (parsed as Record<string, unknown>).mods;
		if (mods === undefined) return true;
		const value =
			typeof mods === "object" && mods !== null && !Array.isArray(mods)
				? (mods as Record<string, unknown>)[modName]
				: null;
		if (value === undefined || typeof value === "boolean")
			return value !== false;
		throw new Error(`"mods" is not an object of booleans`);
	};

	const blank = (): LivenessRecord => ({
		firstListedAt: null,
		description: "",
		status: null,
		quietSince: null,
		steps: 0,
		phaseSince: null,
		isStepping: false,
		tools: [],
		isStalled: false,
	});

	const recordOf = (id: string): LivenessRecord => {
		records[id] ??= blank();
		return records[id];
	};

	const save = (
		write: () => Promise<unknown>,
		debug: (text: string) => void,
	) => {
		saving = saving
			.then(write)
			.catch((err: unknown) =>
				debug(`records not saved, kept in memory: ${messageOf(err)}`),
			);
	};

	const phaseOf = (rec: LivenessRecord) => {
		if (rec.isStepping) return "model answering";
		if (rec.tools.length > 0) return `running ${rec.tools.join(", ")}`;
		return "between steps";
	};

	const durationOf = (ms: number) => {
		const minutes = Math.floor(ms / 60_000);
		return minutes < 60
			? `${minutes}m`
			: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	};

	const elapsedOf = (ms: number) => {
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes >= 60) return durationOf(ms);
		return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	};

	const truncate = (text: string) =>
		text.length > descriptionMaxChars
			? `${text.slice(0, descriptionMaxChars - 1)}…`
			: text;

	interface Stall {
		agent: AgentInfo;
		quietMs: number;
		phase: string;
	}

	const stallText = ({ agent, quietMs, phase }: Stall) =>
		`${truncate(agent.description)} (${durationOf(quietMs)} quiet, ${phase})`;

	const statusText = (running: number, stalls: Stall[]) => {
		const count = `${running} subagent${running === 1 ? "" : "s"} running`;
		if (stalls.length === 0) return count;
		const longest = [...stalls].sort((a, b) => b.quietMs - a.quietMs);
		return `${count}; stalled: ${longest.map(stallText).join(", ")}`;
	};

	const refreshRecord = (
		rec: LivenessRecord,
		agent: AgentInfo,
		now: number,
	): boolean => {
		const isBackToRunning =
			agent.status === "running" &&
			rec.status !== null &&
			rec.status !== "running";
		if (isBackToRunning) {
			rec.quietSince = now;
			rec.phaseSince = now;
		} else {
			rec.quietSince ??= now;
			rec.phaseSince ??= now;
		}
		if (
			rec.firstListedAt === null ||
			rec.status !== agent.status ||
			rec.description !== agent.description
		) {
			rec.firstListedAt ??= now;
			rec.status = agent.status;
			rec.description = agent.description;
			return true;
		}
		return false;
	};

	const rowOf = (
		stall: Stall,
		rec: LivenessRecord,
		now: number,
		isStalled: boolean,
	): LivenessRow => {
		const { agent, quietMs } = stall;
		const isRunning = agent.status === "running";
		return {
			id: agent.id,
			description: agent.description,
			type: agent.type,
			status: agent.status,
			steps: rec.steps,
			phase: isRunning
				? `${stall.phase} ${elapsedOf(now - (rec.phaseSince ?? now))}`
				: null,
			stall: isStalled ? `${elapsedOf(quietMs)} quiet` : null,
		};
	};

	on("session.start", { cwd: /./ }, async ($, e, next) => {
		isLive = false;
		const debug = (text: string) =>
			$.ui.log(`${modName}: ${text}`, { to: "debug" });

		const isSwitchedOn = async () => {
			const file = `${e.cwd}/${configRelPath}`;
			try {
				if (!(await $.fs.exists(file))) return true;
				return isOnInConfig(await $.fs.read(file));
			} catch (err) {
				debug(
					`${configRelPath} unreadable or malformed, read as on: ${messageOf(err)}`,
				);
				return true;
			}
		};

		const whyNotStarted = async () => {
			const { version } = await $.session.version();
			if (!isAtFloor(version))
				return `Claude Code ${version} is below ${versionFloor.join(".")}; not started`;
			if (!(await isSwitchedOn()))
				return `switched off by "mods" in ${configRelPath}; not started`;
			if (
				$.plugin.name !== modName &&
				(await $.fs.exists(`${e.cwd}/.claude/skills/${modName}`))
			)
				return `loaded through ${$.plugin.name}, but .claude/skills/${modName} here loads it stand-alone; not started`;
		};

		try {
			const why = await whyNotStarted();
			if (why !== undefined) {
				debug(why);
				return next(e);
			}
			const { value } = await $.state.get(recordsRef);
			records = {};
			for (const [id, rec] of Object.entries(value ?? {}))
				records[id] = { ...blank(), ...JSON.parse(JSON.stringify(rec)) };
			let shown: string | undefined | null = null;
			let shownRows: string | null = null;
			let isBusy = false;

			const dropUnlisted = (ids: Set<string>) => {
				let isChanged = false;
				for (const [id, rec] of Object.entries(records)) {
					if (rec.firstListedAt === null || ids.has(id)) continue;
					if (rec.isStalled)
						debug(
							`stall ended: ${id} ${truncate(rec.description)} (no longer listed)`,
						);
					delete records[id];
					isChanged = true;
				}
				return isChanged;
			};

			const announceStall = (stall: Stall, isStalled: boolean) => {
				const { agent } = stall;
				if (isStalled) {
					debug(`stall began: ${agent.id} ${stallText(stall)}`);
					$.ui.toast(`Subagent stalled: ${stallText(stall)}`);
				} else {
					const endReason =
						agent.status === "running"
							? "stepped again"
							: `now ${agent.status}`;
					debug(
						`stall ended: ${agent.id} ${truncate(agent.description)} (${endReason})`,
					);
				}
			};

			const track = (
				agent: AgentInfo,
				now: number,
				stalls: Stall[],
				rows: LivenessRow[],
			): boolean => {
				const rec = recordOf(agent.id);
				const isChanged = refreshRecord(rec, agent, now);
				const quietMs = now - (rec.quietSince ?? now);
				const isStalled = agent.status === "running" && quietMs >= stallMs;
				const stall = { agent, quietMs, phase: phaseOf(rec) };
				if (isStalled) stalls.push(stall);
				rows.push(rowOf(stall, rec, now, isStalled));
				if (isStalled === rec.isStalled) return isChanged;
				rec.isStalled = isStalled;
				announceStall(stall, isStalled);
				return true;
			};

			const publish = async (
				listed: AgentInfo[],
				stalls: Stall[],
				rows: LivenessRow[],
			) => {
				const text = listed.some((agent) => liveStatuses.has(agent.status))
					? statusText(
							listed.filter((agent) => agent.status === "running").length,
							stalls,
						)
					: undefined;
				if (text !== shown) {
					$.ui.status(text);
					shown = text;
				}
				const drawn = JSON.stringify(rows);
				if (drawn !== shownRows) {
					await $.state.set(rowsRef, rows);
					shownRows = drawn;
				}
			};

			const tick = async () => {
				if (isBusy) return;
				isBusy = true;
				try {
					const listed = (await $.agent.list()).filter(
						(agent) => agent.teammateId === undefined,
					);
					const now = await $.clock.now();
					const ids = new Set(listed.map((agent) => agent.id));
					let isChanged = dropUnlisted(ids);
					const stalls: Stall[] = [];
					const rows: LivenessRow[] = [];
					for (const agent of listed)
						isChanged = track(agent, now, stalls, rows) || isChanged;
					if (isChanged) save(() => $.state.set(recordsRef, records), debug);
					await publish(listed, stalls, rows);
				} catch (err) {
					debug(`tick failed, retried next tick: ${messageOf(err)}`);
				} finally {
					isBusy = false;
				}
			};

			cancelTick?.();
			const timer = $.clock.every(tickMs, tick);
			cancelTick = () => timer.cancel();
			isLive = true;
			try {
				await $.command.register({
					name: "liveness",
					description: "Open or close a pane listing this session's subagents",
					immediate: true,
				});
			} catch (err) {
				debug(`/liveness not registered: ${messageOf(err)}`);
			}
		} catch (err) {
			debug(`not started: ${messageOf(err)}`);
		}
		return next(e);
	});

	on("turn.step", async function* ($, e, next) {
		const id = e.agentId;
		if (!isLive || id === undefined) return yield* next(e);
		const debug = (text: string) =>
			$.ui.log(`${modName}: ${text}`, { to: "debug" });
		try {
			const rec = recordOf(id);
			rec.quietSince = await $.clock.now();
			rec.phaseSince = rec.quietSince;
			rec.steps++;
			rec.isStepping = true;
			rec.tools = [];
			save(() => $.state.set(recordsRef, records), debug);
		} catch (err) {
			debug(`step start not recorded for ${id}: ${messageOf(err)}`);
		}
		let tools: string[] = [];
		try {
			const result = yield* next(e);
			try {
				tools = result.toolUses
					.map((use) => use.name)
					.filter((name) => name !== handbackTool);
			} catch (err) {
				debug(`step tools not recorded for ${id}: ${messageOf(err)}`);
			}
			return result;
		} finally {
			const rec = records[id];
			if (rec) {
				rec.isStepping = false;
				rec.tools = tools;
				try {
					rec.phaseSince = await $.clock.now();
				} catch (err) {
					debug(`step end not timed for ${id}: ${messageOf(err)}`);
				}
				save(() => $.state.set(recordsRef, records), debug);
			}
		}
	});

	on("turn.complete", ($, e, next) => {
		const debug = (text: string) =>
			$.ui.log(`${modName}: ${text}`, { to: "debug" });
		const rec = isLive && e.agentId !== undefined && records[e.agentId];
		if (rec) {
			rec.isStepping = false;
			rec.tools = [];
			save(() => $.state.set(recordsRef, records), debug);
		}
		return next(e);
	});

	on(
		"ui.render",
		{ component: "Pane", requestId: "liveness" },
		async ($, e) => {
			const { Box, Text } = $.ui.resolve(e);
			const { value: rows = [] } = await $.state.get(rowsRef);
			if (rows.length === 0)
				return <Text dimColor={true}>No subagents listed.</Text>;
			return (
				<Box flexDirection="column">
					{rows.map((row) => (
						<Box
							key={`agent:${row.id}`}
							flexDirection="column"
							marginBottom={1}
						>
							<Text bold={true} wrap="truncate-end">
								{row.description}
							</Text>
							<Text dimColor={true}>
								{[
									row.type,
									row.status,
									`${row.steps} step${row.steps === 1 ? "" : "s"}`,
									...(row.phase === null ? [] : [row.phase]),
								].join(" · ")}
							</Text>
							{row.stall !== null && (
								<Text color="warning">{`stalled, ${row.stall}`}</Text>
							)}
						</Box>
					))}
				</Box>
			);
		},
	);

	on("command.run", { command: "liveness" }, async ($) => {
		const debug = (text: string) =>
			$.ui.log(`${modName}: ${text}`, { to: "debug" });
		try {
			if ((await $.ui.panes()).some((pane) => pane.id === paneId)) {
				await $.ui.close({ id: paneId });
				return { text: "Subagents pane closed." };
			}
			const opened = await $.ui.open({ id: paneId, title: "Subagents" });
			return {
				text: opened.isPlaced
					? "Subagents pane opened."
					: `Subagents pane not drawn: ${opened.reason}`,
			};
		} catch (err) {
			debug(`/liveness failed: ${messageOf(err)}`);
			return { text: `Subagents pane: ${messageOf(err)}` };
		}
	});
};
