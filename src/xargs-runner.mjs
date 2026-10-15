#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SAFE_COMMANDS = new Set(["echo", "printf", "wc", "grep", "egrep", "fgrep", "head", "tail"]);
const FILE_COMMANDS = new Set(["wc", "grep", "egrep", "fgrep", "head", "tail"]);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_ARGUMENTS = 100_000;
const MAX_INVOCATIONS = 10_000;
const VCS_DIRECTORIES = new Set([".git", ".hg", ".svn", ".bzr", ".jj", ".sl"]);

function fail(message) {
	process.stderr.write(`xargs: ${message}\n`);
	process.exit(1);
}

function contained(root, candidate) {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function parseArguments(argv) {
	const options = {
		delimiter: undefined,
		eof: undefined,
		replace: undefined,
		maxArgs: undefined,
		maxLines: undefined,
		maxChars: undefined,
		trace: false,
		exitIfTooLarge: false,
	};
	let index = 0;
	for (; index < argv.length; index++) {
		const value = argv[index];
		if (value === "--") {
			index++;
			break;
		}
		if (!value.startsWith("-") || value === "-") break;
		if (["-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-x", "--exit"].includes(value)) {
			if (value === "-0" || value === "--null") options.delimiter = "\0";
			if (value === "-t" || value === "--verbose") options.trace = true;
			if (value === "-x" || value === "--exit") options.exitIfTooLarge = true;
			continue;
		}
		const long = /^(--(?:replace|max-args|max-lines|max-procs|max-chars|eof|delimiter))(?:=(.*))?$/.exec(value);
		if (long) {
			const operand = long[2] ?? argv[++index];
			if (operand === undefined) fail(`missing operand for ${long[1]}`);
			if (long[1] === "--replace") options.replace = operand;
			else if (long[1] === "--max-args") options.maxArgs = Number(operand);
			else if (long[1] === "--max-lines") options.maxLines = Number(operand);
			else if (long[1] === "--max-chars") options.maxChars = Number(operand);
			else if (long[1] === "--eof") options.eof = operand;
			else if (long[1] === "--delimiter") options.delimiter = operand;
			// --max-procs is accepted for parity; execution remains serialized so
			// containment checks and output ordering stay deterministic.
			continue;
		}
		const attached = /^-([InELPsd])(.*)$/.exec(value);
		if (!attached) fail(`unsupported option ${value}`);
		const option = `-${attached[1]}`;
		const operand = attached[2] || argv[++index];
		if (operand === undefined) fail(`missing operand for ${option}`);
		if (option === "-I") options.replace = operand;
		else if (option === "-n") options.maxArgs = Number(operand);
		else if (option === "-L") options.maxLines = Number(operand);
		else if (option === "-s") options.maxChars = Number(operand);
		else if (option === "-E") options.eof = operand;
		else if (option === "-d") options.delimiter = operand;
		else if (option === "-P") {
			if (!Number.isSafeInteger(Number(operand)) || Number(operand) < 1) fail("-P must be greater than zero");
		} else fail(`unsupported option ${option}`);
	}
	return { options, command: argv.slice(index) };
}

function splitWords(input) {
	const words = [];
	let current = "";
	let quote;
	let escaped = false;
	let started = false;
	for (const character of input) {
		if (escaped) {
			current += character;
			escaped = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) words.push(current);
			current = "";
			started = false;
			continue;
		}
		current += character;
		started = true;
	}
	if (escaped || quote) fail("unterminated quote or escape in input");
	if (started) words.push(current);
	return words;
}

function validatePath(value, roots) {
	if (value === "-" || value === "/dev/null") return value;
	let canonical;
	try {
		canonical = realpathSync(resolve(process.cwd(), value));
		const info = statSync(canonical);
		if (!info.isFile() || info.nlink !== 1) fail(`unsafe input path ${value}`);
	} catch {
		fail(`unreadable input path ${value}`);
	}
	if (excludedRoots.some((excluded) => contained(excluded, canonical)))
		fail(`input path is inside an excluded root: ${value}`);
	const root = roots.find((candidate) => contained(candidate, canonical));
	if (!root) fail(`input path is outside allowed roots: ${value}`);
	if (
		relative(root, canonical)
			.split(sep)
			.some((segment) => VCS_DIRECTORIES.has(segment.toLowerCase()))
	)
		fail(`input path is inside version-control metadata: ${value}`);
	return canonical;
}

const { options, command } = parseArguments(process.argv.slice(2));
const name = command[0];
if (!name || !SAFE_COMMANDS.has(name)) fail("nested command is not allowed");
let roots;
let excludedRoots;
try {
	roots = JSON.parse(process.env.PI_MEMORY_XARGS_ROOTS ?? "[]");
	excludedRoots = JSON.parse(process.env.PI_MEMORY_XARGS_EXCLUDED_ROOTS ?? "[]");
	if (![roots, excludedRoots].every((items) => Array.isArray(items) && items.every((root) => typeof root === "string")))
		throw new Error();
} catch {
	fail("allowed roots are unavailable");
}
const input = await new Promise((resolveInput, reject) => {
	const chunks = [];
	let bytes = 0;
	process.stdin.on("data", (chunk) => {
		const buffer = Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_INPUT_BYTES) {
			process.stdin.destroy();
			reject(new Error(`stdin exceeds ${MAX_INPUT_BYTES} bytes`));
			return;
		}
		chunks.push(buffer);
	});
	process.stdin.on("end", () => resolveInput(Buffer.concat(chunks).toString("utf8")));
	process.stdin.on("error", reject);
}).catch((error) => fail(error instanceof Error ? error.message : String(error)));
let values;
if (options.delimiter !== undefined) values = input.split(options.delimiter).filter((value) => value.length > 0);
else if (options.maxLines !== undefined)
	values = input
		.split(/\r?\n/)
		.filter((value) => value.length > 0)
		.flatMap((line) => splitWords(line));
else values = splitWords(input);
if (options.eof !== undefined) {
	const eofIndex = values.indexOf(options.eof);
	if (eofIndex >= 0) values = values.slice(0, eofIndex);
}
if (values.length === 0) process.exit(0);
if (values.length > MAX_ARGUMENTS) fail(`input expands to more than ${MAX_ARGUMENTS} arguments`);
if (options.maxArgs !== undefined && options.maxArgs < 1) fail("-n must be greater than zero");
if (options.maxLines !== undefined && options.maxLines < 1) fail("-L must be greater than zero");
if (options.maxChars !== undefined && options.maxChars < 1) fail("-s must be greater than zero");
const size = options.maxArgs ?? options.maxLines ?? (options.replace ? 1 : values.length);
if (Math.ceil(values.length / size) > MAX_INVOCATIONS) fail(`input requires more than ${MAX_INVOCATIONS} invocations`);
const operands = command.slice(1);
for (let offset = 0; offset < values.length; offset += size) {
	const batch = values.slice(offset, offset + size);
	// Pass checked absolute paths to the command, so a filename beginning with
	// '-' cannot become a new option after xargs expands stdin.
	const operandsFromInput = FILE_COMMANDS.has(name) ? batch.map((value) => validatePath(value, roots)) : batch;
	let args;
	if (options.replace) {
		const replacement = batch.join(" ");
		args = operands.map((value) => value.split(options.replace).join(replacement));
	} else args = [...operands, ...operandsFromInput];
	if (options.maxChars !== undefined) {
		const chars = [name, ...args].join(" ").length;
		if (chars > options.maxChars) {
			if (options.exitIfTooLarge || batch.length === 1) fail(`command exceeds ${options.maxChars} characters`);
			fail("max-chars requires a smaller -n or -L batch");
		}
	}
	if (options.trace) process.stderr.write(`${[name, ...args].join(" ")}\n`);
	const result = spawnSync(name, args, { stdio: "inherit", env: process.env });
	if (result.error) fail(result.error.message);
	if (result.status !== 0) process.exit(result.status ?? 1);
}
