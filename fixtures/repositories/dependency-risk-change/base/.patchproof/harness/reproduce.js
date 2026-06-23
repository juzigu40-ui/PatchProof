import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const challenge = JSON.parse(readFileSync(3, "utf8"));
const targetScript =
  "import(" +
  JSON.stringify("./index.js") +
  ").then(({ answer }) => process.exit(answer() === 42 ? 0 : 1));";
const target = spawnSync(process.execPath, ["--input-type=module", "-e", targetScript], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { PATH: process.env.PATH ?? "" }
});
const status = target.status === 0 ? "assertion_passed" : "assertion_failed";

writeFileSync(4, `${JSON.stringify({ nonce: challenge.nonce, status })}\n`);
process.exit(status === "assertion_passed" ? 0 : 1);
