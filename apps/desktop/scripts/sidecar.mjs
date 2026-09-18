// Build the berdloop-worker helper and place it where Tauri bundles sidecars.
// Run from apps/desktop: `bun run sidecar [--target <triple>]`.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const at = argv.indexOf("--target");
const target = at >= 0 ? argv[at + 1] : undefined;
if (at >= 0 && !target) {
  console.error("--target needs a triple.");
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

const cargo = [
  "build",
  "--release",
  "--locked",
  "--bin",
  "berdloop-worker",
  "--manifest-path",
  "src-tauri/Cargo.toml",
];
if (target) cargo.push("--target", target);
run("cargo", cargo);

const host = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
const triple =
  target ??
  host.stdout
    .split("\n")
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length)
    .trim();
if (!triple) {
  console.error("Could not read the host triple from rustc -vV.");
  process.exit(1);
}

const extension = triple.includes("windows") ? ".exe" : "";
const built = join(
  "src-tauri",
  "target",
  ...(target ? [target] : []),
  "release",
  `berdloop-worker${extension}`,
);
const destination = join(
  "src-tauri",
  "binaries",
  `berdloop-worker-${triple}${extension}`,
);
mkdirSync(join("src-tauri", "binaries"), { recursive: true });
copyFileSync(built, destination);
if (!extension) chmodSync(destination, 0o755);
console.log(destination);
