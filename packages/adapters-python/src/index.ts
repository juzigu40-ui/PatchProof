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

export const pythonAdapter: RepositoryAdapter = {
  name: "python",
  async detect(repoPath: string) {
    const markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"];
    const checks = await Promise.all(markers.map((marker) => exists(join(repoPath, marker))));
    return checks.some(Boolean);
  },
  dependencyFilePatterns: [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements*.txt",
    "poetry.lock",
    "Pipfile",
    "Pipfile.lock"
  ],
  publicApiFilePatterns: ["**/__init__.py", "src/**/*.pyi", "**/py.typed"]
};
