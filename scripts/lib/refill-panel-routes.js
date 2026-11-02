/*
 * refill-panel-routes.js — which splits can open the refill-loop panel beside an
 * agents view, and what hands focus back to the view from each, as pure functions of
 * the environment (#3886, #3887, ruling #3571).
 */

/* Untraced, listed so by spec #3596. */
const PANEL_SHARE = 0.3;
const WINDOWS_TERMINAL = "windows-terminal";
const TMUX = "tmux";
const WT_IN_THIS_WINDOW = ["/c", "wt.exe", "-w", "0"];

/**
 * The split routes this environment offers, first choice first. Printing the
 * command is what remains where none works.
 * `node` is absolute: `wsl.exe -e` starts no shell, so a node from nvm is not on its PATH.
 * tmux's `-t` names the view's pane, for a by-hand run from another; `-d` leaves focus on the view.
 * Each split tells the panel its route, which its environment cannot: a printed command may be pasted into a pane of either.
 * @param {{ env: Record<string, string | undefined>, isOnPath: (name: string) => boolean, node: string, panel: string, pid: number }} input
 * @returns {{ name: string, file: string, args: string[] }[]}
 */
function buildRoutes({ env, isOnPath, node, panel, pid }) {
	const command = [node, panel, String(pid)];
	const routes = [];
	if (env.WSL_INTEROP && isOnPath("cmd.exe") && isOnPath("wt.exe"))
		routes.push({
			name: WINDOWS_TERMINAL,
			file: "cmd.exe",
			args: [
				...WT_IN_THIS_WINDOW,
				"split-pane",
				"-V",
				"--size",
				String(PANEL_SHARE),
				"--title",
				"refill",
				"wsl.exe",
				"-e",
				...command,
				WINDOWS_TERMINAL,
			],
		});
	if (env.TMUX)
		routes.push({
			name: TMUX,
			file: "tmux",
			args: [
				"split-window",
				...(env.TMUX_PANE ? ["-t", env.TMUX_PANE] : []),
				"-h",
				"-d",
				"-l",
				`${PANEL_SHARE * 100}%`,
				...command,
				TMUX,
			],
		});
	return routes;
}

/**
 * What hands focus back to the agents pane, which each split puts on the panel's left.
 * `select-pane -L` counts from the pane TMUX_PANE names: the panel's, not the view's.
 * @param {string|undefined} route the split that opened the panel; none where it was run by hand
 * @param {Record<string, string | undefined>} viewEnv
 * @param {Record<string, string | undefined>} ownEnv
 * @returns {{ file: string, args: string[], env: Record<string, string | undefined> }|null}
 */
function buildFocusReturn(route, viewEnv, ownEnv) {
	if (route === WINDOWS_TERMINAL)
		return {
			file: "cmd.exe",
			args: [...WT_IN_THIS_WINDOW, "move-focus", "left"],
			env: viewEnv,
		};
	if (route === TMUX)
		return {
			file: "tmux",
			args: ["select-pane", "-L"],
			env: { ...viewEnv, TMUX_PANE: ownEnv.TMUX_PANE },
		};
	return null;
}

module.exports = { buildRoutes, buildFocusReturn };
