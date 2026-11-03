/*
 * refill-panel-routes.js — which splits can open the refill-loop panel beside an
 * agents view, and what hands focus back to the view from each, as pure functions of
 * the environment (#3886, #3887, #4065, ruling #3571).
 */

/* The widest row drawn in every state that stays on one line, 34 cells (an unread plan
 * row with a two-digit age), plus the panel's 4 cells of margin (#3956). */
const PANEL_COLUMNS = 38;
/* Windows Terminal's split takes only a share, of the pane's columns plus these: its 0.3
 * and 0.7 shares drew 44 and 108 columns, which fits a share of 160 less 4 (#3956). */
const SPLIT_OVERHEAD_COLUMNS = 4;
/* That window's unsplit width, where the view's own width will not read. */
const USUAL_VIEW_COLUMNS = 156;
/* Untraced, a first guess: a narrow window keeps most of itself for the view. */
const MOST_SHARE = 0.5;
const WINDOWS_TERMINAL = "windows-terminal";
const TMUX = "tmux";
const WT_IN_THIS_WINDOW = ["/c", "wt.exe", "-w", "0"];
const MOVE_FOCUS_LEFT = ["move-focus", "left"];

/** @param {number|null} viewColumns the width of the pane being split, null where it will not read */
const buildSplitShare = (viewColumns) =>
	Math.min(
		(PANEL_COLUMNS + SPLIT_OVERHEAD_COLUMNS) /
			((viewColumns ?? USUAL_VIEW_COLUMNS) + SPLIT_OVERHEAD_COLUMNS),
		MOST_SHARE,
	);

/**
 * The split routes this environment offers, first choice first. Printing the
 * command is what remains where none works.
 * `node` is absolute: `wsl.exe -e` starts no shell, so a node from nvm is not on its PATH.
 * tmux's `-t` names the view's pane, for a by-hand run from another; `-d` leaves focus on the view.
 * Each split tells the panel its route, which its environment cannot: a printed command may be pasted into a pane of either.
 * `wt.exe split-pane` moves focus to the new pane with no flag to stay put (its docs and `AppCommandlineArgs.cpp`),
 * so the same command line moves it back before the panel has started (#4065). Keys typed before that lands still reach the panel,
 * a chained move that fails reports nothing, and keys typed while the view waits on this split are lost (#4080).
 * @param {{ env: Record<string, string | undefined>, isOnPath: (name: string) => boolean, node: string, panel: string, pid: number, viewColumns: number|null }} input
 * @returns {{ name: string, file: string, args: string[] }[]}
 */
function buildRoutes({ env, isOnPath, node, panel, pid, viewColumns }) {
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
				String(buildSplitShare(viewColumns)),
				"--title",
				"refill",
				"wsl.exe",
				"-e",
				...command,
				WINDOWS_TERMINAL,
				";",
				...MOVE_FOCUS_LEFT,
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
				String(PANEL_COLUMNS),
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
			args: [...WT_IN_THIS_WINDOW, ...MOVE_FOCUS_LEFT],
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
