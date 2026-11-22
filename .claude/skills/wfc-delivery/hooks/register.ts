import type { Register, Timer } from "claude-code";

export const register: Register = (on) => {
	// measured, #851
	const versionFloor = [2, 1, 289];
	// #849
	const tickMs = 30_000;
	// guess, #849
	const runTimeoutMs = 5000;
	// #849
	const ciIntervalMs = 10 * 60_000;
	// guess, #854
	const ciRunTimeoutMs = 30_000;
	// guess, #854
	const maxOffers = 3;
	const modName = "wfc-delivery";
	const turnRef = { plugin: "wfc-delivery", key: "isTurnRunning" } as const;
	const scriptRelPath = "scripts/deliver-to-session.js";
	const deliveryHeader =
		"Delivered by the wfc-delivery mod: a report this session's own start produced, or a sweep verdict that changed since (#849).";

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

	let loop: { resume: () => Promise<void>; pause: () => void } | undefined;
	let isTurnSeen: boolean | undefined;
	let isStoodDown = false;

	on("session.start", { cwd: /./ }, async ($, e, next) => {
		const debug = (text: string) =>
			$.ui.log(`${modName}: ${text}`, { to: "debug" });

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
			const root = $.plugin.name === modName ? e.cwd : $.plugin.root;
			const script = `${root}/${scriptRelPath}`;
			let store: string | undefined;
			let storeStamp: number | undefined;
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

			const storePath = async (): Promise<string> => {
				const { notifyReports } = JSON.parse(await run(["--paths"]));
				if (typeof notifyReports !== "string")
					throw new Error(`${scriptRelPath} --paths named no notifyReports`);
				return notifyReports;
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
				if (appended.deny !== undefined) {
					debug(`append of ${names} refused, dropped: ${appended.deny}`);
					return;
				}
				debug(`delivered ${names}`);
				if ((await $.session.surfaces()).length > 0)
					$.ui.toast(`${names} delivered to this session`);
			};

			const fetch = async () => {
				store ??= await storePath();
				const stamp = await $.fs.stat(store).then(
					(s) => s.mtimeMs,
					() => -1,
				);
				if (stamp === storeStamp) return;
				const out = (await run(["--reports"])).trim();
				storeStamp = stamp;
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
				ciRanAt = now;
				await run(["--ci"], ciRunTimeoutMs)
					.then((out) => hold(out.trim()))
					.catch((err: unknown) =>
						debug(
							`CI re-check failed, retried next interval: ${messageOf(err)}`,
						),
					);
			};

			const steps = async (isCiChecked: boolean) => {
				if (!timer) return;
				await fetch().catch(failed);
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

	on("turn.start", { turnId: /./ }, async ($, e, next) => {
		if (e.agentId === undefined && !isStoodDown) {
			isTurnSeen = true;
			await $.state.set(turnRef, true).catch((err: unknown) =>
				$.ui.log(`${modName}: turn start not kept: ${messageOf(err)}`, {
					to: "debug",
				}),
			);
			await loop?.resume();
		}
		return next(e);
	});

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
