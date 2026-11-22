// measured widest row 34 cells, +4 margin, #4104, #3956
const PANEL_COLUMNS = 38;
// measured 44 and 108 columns at 0.3 and 0.7, #3956
const SPLIT_OVERHEAD_COLUMNS = 4;
// measured 160 columns less 4, #3956
const USUAL_VIEW_COLUMNS = 156;
// guess, #3956
const MOST_SHARE = 0.5;
const WINDOWS_TERMINAL = "windows-terminal";
const TMUX = "tmux";
/** @param {Record<string, string | undefined>} env */
const tmuxBin = (env) => env.WFC_TMUX || "tmux";
const WT_IN_THIS_WINDOW = ["/c", "wt.exe", "-w", "0"];
const MOVE_FOCUS_LEFT = ["move-focus", "left"];

/** @param {number|null} viewColumns */
const buildSplitShare = (viewColumns) =>
	Math.min(
		(PANEL_COLUMNS + SPLIT_OVERHEAD_COLUMNS) /
			((viewColumns ?? USUAL_VIEW_COLUMNS) + SPLIT_OVERHEAD_COLUMNS),
		MOST_SHARE,
	);

/**
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
			file: tmuxBin(env),
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
 * @param {string|undefined} route
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
	if (route === TMUX) {
		const env = { ...viewEnv, TMUX_PANE: ownEnv.TMUX_PANE };
		return { file: tmuxBin(env), args: ["select-pane", "-L"], env };
	}
	return null;
}

module.exports = { buildRoutes, buildFocusReturn };
