import { access } from "node:fs/promises";
import { join } from "node:path";

export interface RepositoryAdapter {
  name: string;
  detect(repoPath: string): Promise<boolean>;
  dependencyFilePatterns: readonly string[];
  publicApiFilePatterns: readonly string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export const nodeAdapter: RepositoryAdapter = {
  name: "node",
  async detect(repoPath: string) {
    return await exists(join(repoPath, "package.json"));
  },
  dependencyFilePatterns: [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock"
  ],
  publicApiFilePatterns: [
    "index.js",
    "index.ts",
    "src/index.js",
    "src/index.ts",
    "lib/index.js",
    "lib/index.ts",
    "**/*.d.ts"
  ]
};
