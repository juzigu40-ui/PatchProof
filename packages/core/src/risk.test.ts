import type { RepositoryAdapter } from "./risk.js";
import { collectRiskPatterns, matchChangedFiles } from "./risk.js";

describe("risk", () => {
  it("matches dependency and public API files with glob patterns", () => {
    const files = ["package.json", "src/index.ts", "src/internal.ts", "docs/readme.md"];

    expect(matchChangedFiles(files, ["package.json", "src/index.ts"])).toEqual([
      "package.json",
      "src/index.ts"
    ]);
    expect(matchChangedFiles(files, ["*.md"])).toEqual(["docs/readme.md"]);
  });

  it("collects patterns from detected adapters", async () => {
    const adapter: RepositoryAdapter = {
      name: "demo",
      dependencyFilePatterns: ["lock.file"],
      publicApiFilePatterns: ["api.ts"],
      async detect() {
        return true;
      }
    };

    await expect(collectRiskPatterns("/repo", [adapter], ["custom.lock"], [])).resolves.toEqual({
      adapters: ["demo"],
      dependency: ["custom.lock", "lock.file"],
      publicApi: ["api.ts"]
    });
  });
});
