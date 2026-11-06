/*
 * systemd-bins.js — the systemd user-manager binaries, each injected at one
 * named var (§N7): WFC_SYSTEMD_RUN, WFC_SYSTEMCTL and WFC_BUSCTL, each an
 * executable, its bare name where unset. Read at each call, so a test sets
 * the var to a stub.
 *
 * A leaf: it depends on nothing.
 */

/* A guess: a user manager that has not answered in this long is read as none. */
const MANAGER_TIMEOUT_MS = 5000;

const systemdRun = () => process.env.WFC_SYSTEMD_RUN || "systemd-run";
const systemctl = () => process.env.WFC_SYSTEMCTL || "systemctl";
const busctl = () => process.env.WFC_BUSCTL || "busctl";

module.exports = { systemdRun, systemctl, busctl, MANAGER_TIMEOUT_MS };
