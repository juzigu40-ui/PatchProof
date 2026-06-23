import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const challenge = JSON.parse(readFileSync(3, "utf8"));
const targetScript =
  "import(" +
  JSON.stringify("./math.js") +
  ").then(({ add }) => process.exit(add(2, 2) === 4 ? 0 : 1));";
const target = spawnSync(process.execPath, ["--input-type=module", "-e", targetScript], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { PATH: process.env.PATH ?? "" }
});
const status = target.status === 0 ? "assertion_passed" : "assertion_failed";

if (status === "assertion_failed") {
  console.error("bug reproduced");
}

writeFileSync(4, `${JSON.stringify({ nonce: challenge.nonce, status })}\n`);
process.exit(status === "assertion_passed" ? 0 : 1);
