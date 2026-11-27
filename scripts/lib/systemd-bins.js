// guess, workflow-core#4341
const MANAGER_TIMEOUT_MS = 5000;

const systemdRun = () => process.env.WFC_SYSTEMD_RUN || "systemd-run";
const systemctl = () => process.env.WFC_SYSTEMCTL || "systemctl";
const busctl = () => process.env.WFC_BUSCTL || "busctl";
const loginctl = () => process.env.WFC_LOGINCTL || "loginctl";

module.exports = {
	systemdRun,
	systemctl,
	busctl,
	loginctl,
	MANAGER_TIMEOUT_MS,
};
