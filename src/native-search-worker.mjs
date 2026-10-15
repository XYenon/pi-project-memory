import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function contained(root, candidate) {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function checkedPath(path, policy) {
	const canonical = realpathSync(resolve(path));
	if (!policy.roots.some((root) => contained(root, canonical)))
		throw new Error("Search path is outside approved roots");
	if (policy.excludedRoots.some((root) => contained(root, canonical)))
		throw new Error("Search path is inside an excluded transcript root");
	return canonical;
}

function escapeGlob(value) {
	return value.replace(/[\\*?[\]{}]/g, "\\$&");
}

if (process.argv[2] === "--executable") {
	const request = JSON.parse(process.env.PI_MEMORY_SEARCH_POLICY);
	const args = process.argv.slice(3);
	const searchPath = checkedPath(args.at(-1), request.policy);
	const exclusions = request.policy.excludedRoots
		.filter((root) => contained(searchPath, root))
		.map((root) => escapeGlob(relative(searchPath, root).split(sep).join("/")));
	const boundaryArgs =
		request.name === "grep"
			? ["--no-config", "--no-follow", ...exclusions.flatMap((root) => ["--glob", `!${root}/**`])]
			: exclusions.flatMap((root) => ["--exclude", root]);
	// Native factories put patterns and search paths after --. Keep boundary
	// exclusions after caller glob flags, so a positive glob cannot override them.
	const separator = args.indexOf("--");
	if (separator < 0) throw new Error("Unexpected native search arguments");
	const effectiveArgs = [...args.slice(0, separator), ...boundaryArgs, ...args.slice(separator)];
	const result = spawnSync(request.name === "grep" ? "rg" : "fd", effectiveArgs, {
		cwd: statSync(searchPath).isDirectory() ? searchPath : dirname(searchPath),
		stdio: "inherit",
		env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
	});
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}

const request = JSON.parse(readFileSync(0, "utf8"));
const command = request.name === "grep" ? "rg" : "fd";
const bin = join(request.directory, "bin");
await mkdir(bin, { mode: 0o700 });
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
await writeFile(
	join(bin, command),
	`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --executable "$@"\n`,
	{ mode: 0o700 },
);
process.env.PI_MEMORY_SEARCH_POLICY = JSON.stringify(request);
const { createFindTool, createGrepTool } = await import("@earendil-works/pi-coding-agent");
const path = checkedPath(request.params.path, request.policy);
const tool =
	request.name === "grep"
		? createGrepTool(request.policy.cwd, {
				operations: {
					isDirectory: (path) => statSync(checkedPath(path, request.policy)).isDirectory(),
					readFile: (path) => readFileSync(checkedPath(path, request.policy), "utf8"),
				},
			})
		: createFindTool(request.policy.cwd);
const result = await tool.execute("native-search", { ...request.params, path });
process.stdout.write(JSON.stringify(result));
