/*
 * register.ts, the wfc-delivery mod — brings a report this session's own start produced into the
 * session while it runs, rather than at the next session start (#849, #854),
 * a release request against a file it holds at its next turn rather than
 * its next write to that file (#855), and a sweep verdict that changes while
 * it runs within about ten minutes (#856).
 *
 * A thin loop over scripts/deliver-to-session.js, which owns every rule of
 * what is due: owner, allow-list, once per session, the arbiter's wording.
 *
 * Hooks `session.start`, and `turn.start` and `turn.complete` to run its
 * loop only while a main-loop turn runs (#3247). Whether one runs is kept in
 * `$.state`, so the fresh load that follows a lost hooks worker mid-turn
 * resumes the loop at its `session.start` (#3251). Never calls
 * `$.prompt.submit`: it can neither skip a guard nor wake an idle session
 * (#849 §Guard safety).
 *
 * EVERYTHING LIVES INSIDE `register`. The tests stand for the load through
 * the workflow-core plugin by loading `register` again as an inline plugin,
 * which carries the function's own text and nothing around it (#944).
 */

import type { Register, Timer } from "claude-code";

export const register: Register = (on) => {
	/* The build #851's go checks passed on; below it the mod is unproven and
	 * starts nothing (#849 user story 19). */
	const versionFloor = [2, 1, 289];
	// #849 §Guard safety.
	const tickMs = 30_000;
	/* "A few seconds" (#849 §Guard safety), a guess never measured: `--reports`
	 * reads files, and `--requests` bounds its arbiter run at 4 s. */
	const runTimeoutMs = 5000;
	/* #849 §CI re-check mid-session. The first run is 10 minutes in: the
	 * session-start check covers the minutes before. Counted from the last run,
	 * so the first tick of a turn after a longer wait runs it. */
	const ciIntervalMs = 10 * 60_000;
	/* Above the script's own bounds, 8 s on its gate and 15 s on the check, with
	 * room for two node starts; a guess. */
	const ciRunTimeoutMs = 30_000;
	// A guess: enough to ride out a transient rejection, never measured.
	const maxOffers = 3;
	const modName = "wfc-delivery";
	const turnRef = { plugin: "wfc-delivery", key: "isTurnRunning" } as const;
	const scriptRelPath = "scripts/deliver-to-session.js";
	const deliveryHeader =
		"Delivered by the wfc-delivery mod: a report this session's own start produced, a release request against a file it holds, or a sweep verdict that changed since (#849).";

	/* The claim store's directory changes whenever any session takes or gives up
	 * a claim, this one's among them; its claims are read only then (#855). */
	const sources = [
		{ flag: "--reports", watch: ["notifyReports"] },
		{ flag: "--requests", watch: ["requests", "locks"] },
	] as const;
	type Paths = Record<(typeof sources)[number]["watch"][number], string>;

	/* The helpers COPIED names in scripts/wfc-mods-copies.test.ts are copied in
	 * the liveness mod, not shared: the tests' inline load, standing for the
	 * plugin's, carries `register`'s own text alone (#944), and the engine
	 * follows `$` across no import (#903 F3). That test fails where the copies
	 * differ; a helper copied later is held only once it joins COPIED. */

	/** True when `version` is at or above versionFloor; an unparseable one is below. */
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

	// Set by the session.start that started this load.
	let loop: { resume: () => Promise<void>; pause: () => void } | undefined;
	/* What this load's own turn hooks last saw, undefined until one runs. It
	 * outranks `turnRef`, whose read may predate a turn hook's write (#3251). */
	let isTurnSeen: boolean | undefined;
	// A load its floor or double-load guard stands down keeps nothing either.
	let isStoodDown = false;

	// Matches every cwd, so one module may hook `session.start` twice (#903 F2).
	on("session.start", { cwd: /./ }, async ($, e, next) => {
		/* Closures over `$`, never helpers taking it: the engine follows `$`
		 * into a function declared at the top of the file alone. */
		const debug = (text: string) =>
			$.ui.log(`${modName}: ${text}`, { to: "debug" });

		/** Why this load starts nothing — the floor, then the double-load guard
		 * (#944) — or undefined where it starts. The guard reads the folder
		 * alone, so a repo that also loads the plugin and turns the stand-alone
		 * copy off in its settings runs neither load. No repo-wide switch, since
		 * the mod tells the model what it must act on (#1467); an adopter's seat
		 * stops the hosted load only with an empty .claude/skills/wfc-delivery/. */
		const whyNotStarted = async () => {
			const { version } = await $.session.version();
			if (!isAtFloor(version))
				return `Claude Code ${version} is below ${versionFloor.join(".")}; not started`;
			if (
				$.plugin.name !== modName &&
				(await $.fs.exists(`${e.cwd}/.claude/skills/${modName}`))
			)
				return `loaded through ${$.plugin.name}, but .claude/skills/${modName} here loads it stand-alone; not started`;
		};

		try {
			const why = await whyNotStarted();
			if (why !== undefined) {
				isStoodDown = true;
				debug(why);
				return next(e);
			}
			// Hosted, the script is the one the host plugin ships (#933).
			const root = $.plugin.name === modName ? e.cwd : $.plugin.root;
			const script = `${root}/${scriptRelPath}`;
			let paths: Paths | undefined;
			// Per source, absent until its first stat, so the first tick forks each.
			const stamps = new Map<string, string>();
			/* Printed text not yet appended. The script's ledger already holds it,
			 * so it is offered from here, never printed again; dropped after
			 * maxOffers rejections, or lost to a reload or the session's end. A
			 * report is shown again by the next session start's replay (#854); a
			 * release request only once its said-once marker is swept, about an
			 * hour on; a CI re-check never this session (#891). */
			let pending = "";
			let offers = 0;
			let isBusy = false;
			let ciRanAt = await $.clock.now();
			let timer: Timer | undefined;

			const run = async (args: string[], timeoutMs = runTimeoutMs) => {
				const ran = await $.process.run(["node", script, ...args], {
					cwd: e.cwd,
					env: { CLAUDE_CODE_SESSION_ID: await $.session.id() },
					timeoutMs,
				});
				if (ran.exitCode !== 0)
					throw new Error(
						`${scriptRelPath} ${args.join(" ")} exited ${ran.exitCode}: ${ran.stderr.trim()}`,
					);
				return ran.stdout;
			};

			const storePaths = async (): Promise<Paths> => {
				const printed = JSON.parse(await run(["--paths"]));
				for (const { watch } of sources)
					for (const key of watch)
						if (typeof printed[key] !== "string")
							throw new Error(`${scriptRelPath} --paths named no ${key}`);
				return printed;
			};

			const deliver = async () => {
				const names = (
					pending.match(/^▸ \S+/gm)?.map((n) => n.slice(2)) ?? ["a report"]
				).join(", ");
				offers++;
				const appended = await $.session
					.append({
						message: {
							type: "user",
							content: [
								{ type: "text", text: `${deliveryHeader}\n\n${pending}` },
							],
						},
					})
					.catch((err: unknown) => {
						if (offers >= maxOffers) pending = "";
						throw new Error(
							`append of ${names} rejected (offer ${offers} of ${maxOffers}): ${messageOf(err)}`,
						);
					});
				pending = "";
				/* A plugin above refused the row: a ruling, so it is dropped rather
				 * than offered again (#854). */
				if (appended.deny !== undefined) {
					debug(`append of ${names} refused, dropped: ${appended.deny}`);
					return;
				}
				debug(`delivered ${names}`);
				if ((await $.session.surfaces()).length > 0)
					$.ui.toast(`${names} delivered to this session`);
			};

			// A held row never stops a newer report being fetched.
			const fetch = async ({ flag, watch }: (typeof sources)[number]) => {
				paths ??= await storePaths();
				const known = paths;
				// -1 for a missing directory: nothing has written there yet.
				const stamp = (
					await Promise.all(
						watch.map((key) =>
							$.fs.stat(known[key]).then(
								(s) => s.mtimeMs,
								() => -1,
							),
						),
					)
				).join();
				if (stamp === stamps.get(flag)) return;
				const out = (await run([flag])).trim();
				stamps.set(flag, stamp);
				hold(out);
			};

			const hold = (out: string) => {
				if (!out) return;
				pending = pending ? `${pending}\n\n${out}` : out;
				offers = 0;
			};

			const failed = (err: unknown) =>
				debug(`tick failed, retried next tick: ${messageOf(err)}`);

			const recheckCi = async () => {
				const now = await $.clock.now();
				if (now - ciRanAt < ciIntervalMs) return;
				/* Stamped first: a failed or timed-out run delivers nothing and waits
				 * for the next interval (#856). */
				ciRanAt = now;
				await run(["--ci"], ciRunTimeoutMs)
					.then((out) => hold(out.trim()))
					.catch((err: unknown) =>
						debug(
							`CI re-check failed, retried next interval: ${messageOf(err)}`,
						),
					);
			};

			/* Each step asks whether the loop still runs, so a tick a turn's end
			 * overtakes forks and appends nothing more. */
			const steps = async (isCiChecked: boolean) => {
				// One source failing never starves the other.
				for (const source of sources) {
					if (!timer) return;
					await fetch(source).catch(failed);
				}
				if (isCiChecked && timer) await recheckCi().catch(failed);
				if (pending && timer) await deliver().catch(failed);
			};

			const tick = async (isCiChecked = true) => {
				if (isBusy) return;
				isBusy = true;
				try {
					await steps(isCiChecked);
				} finally {
					isBusy = false;
				}
			};

			/* A turn's first tick is awaited, so a row lands before the turn's
			 * first model request, and skips the CI re-check, whose 30 s bound
			 * would hold the turn up; the next tick runs it. What lands between
			 * turns waits for the next main-loop turn (#3247). */
			// `tick` catches its own failures, so nothing it returns is dropped.
			loop = {
				resume: async () => {
					if (timer) return;
					timer = $.clock.every(tickMs, tick);
					await tick(false);
				},
				pause: () => {
					timer?.cancel();
					timer = undefined;
				},
			};
			const { value: isKept } = await $.state.get(turnRef);
			if (isTurnSeen ?? isKept)
				loop
					.resume()
					.catch((err: unknown) => debug(`not resumed: ${messageOf(err)}`));
		} catch (err) {
			debug(`not started: ${messageOf(err)}`);
		}
		return next(e);
	});

	/* A subagent's turn neither starts nor stops the loop. Each matcher matches
	 * every turn, so one module may hook the event twice (#903 F2). */
	on("turn.start", { turnId: /./ }, async ($, e, next) => {
		if (e.agentId === undefined && !isStoodDown) {
			isTurnSeen = true;
			/* Residual: a failed write is logged and dropped, so a fresh load
			 * after it reads the turn's state as it stood before. */
			await $.state.set(turnRef, true).catch((err: unknown) =>
				$.ui.log(`${modName}: turn start not kept: ${messageOf(err)}`, {
					to: "debug",
				}),
			);
			await loop?.resume();
		}
		return next(e);
	});

	// Paused first, so a tick the write outlasts forks nothing more.
	on("turn.complete", { turnId: /./ }, async ($, e, next) => {
		if (e.agentId === undefined && !isStoodDown) {
			isTurnSeen = false;
			loop?.pause();
			await $.state.set(turnRef, false).catch((err: unknown) =>
				$.ui.log(`${modName}: turn end not kept: ${messageOf(err)}`, {
					to: "debug",
				}),
			);
		}
		return next(e);
	});
};
