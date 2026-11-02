/*
 * refill-panel-routes.js — which splits can open the refill-loop panel beside an
 * agents view, as a pure function of the environment (#3886, ruling #3571).
 */

/* Untraced, listed so by spec #3596. */
const PANEL_SHARE = 0.3;

/**
 * The split routes this environment offers, first choice first. Printing the
 * command is what remains where none works.
 * `node` is absolute: `wsl.exe -e` starts no shell, so a node from nvm is not on its PATH.
 * tmux's `-t` names the view's pane, for a by-hand run from another; `-d` leaves focus on the view.
 * @param {{ env: Record<string, string | undefined>, isOnPath: (name: string) => boolean, node: string, panel: string, pid: number }} input
 * @returns {{ name: string, file: string, args: string[] }[]}
 */
function buildRoutes({ env, isOnPath, node, panel, pid }) {
	const command = [node, panel, String(pid)];
	const routes = [];
	if (env.WSL_INTEROP && isOnPath("cmd.exe") && isOnPath("wt.exe"))
		routes.push({
			name: "windows-terminal",
			file: "cmd.exe",
			args: [
				"/c",
				"wt.exe",
				"-w",
				"0",
				"split-pane",
				"-V",
				"--size",
				String(PANEL_SHARE),
				"--title",
				"refill",
				"wsl.exe",
				"-e",
				...command,
			],
		});
	if (env.TMUX)
		routes.push({
			name: "tmux",
			file: "tmux",
			args: [
				"split-window",
				...(env.TMUX_PANE ? ["-t", env.TMUX_PANE] : []),
				"-h",
				"-d",
				"-l",
				`${PANEL_SHARE * 100}%`,
				...command,
			],
		});
	return routes;
}

module.exports = { buildRoutes };
