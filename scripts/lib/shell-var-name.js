/*
 * shell-var-name.js — POSIX's shell variable name, which dotenv and every
 * shell accept: the argument write-secret.js takes, and the one
 * secret-ask.js's route line must carry (#2612).
 */

const SHELL_VAR_NAME = "[A-Za-z_][A-Za-z0-9_]*";

module.exports = { SHELL_VAR_NAME };
