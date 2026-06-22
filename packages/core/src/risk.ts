import { minimatch } from "minimatch";

export interface RepositoryAdapter {
  name: string;
  detect(repoPath: string): Promise<boolean>;
  dependencyFilePatterns: readonly string[];
  publicApiFilePatterns: readonly string[];
}

export interface RiskPatterns {
  dependency: string[];
  publicApi: string[];
  adapters: string[];
}

export async function collectRiskPatterns(
  repoPath: string,
  adapters: readonly RepositoryAdapter[],
  configuredDependencyPatterns: readonly string[],
  configuredPublicApiPatterns: readonly string[]
): Promise<RiskPatterns> {
  const dependency = new Set(configuredDependencyPatterns);
  const publicApi = new Set(configuredPublicApiPatterns);
  const detectedAdapters: string[] = [];

  for (const adapter of adapters) {
    if (await adapter.detect(repoPath)) {
      detectedAdapters.push(adapter.name);
      adapter.dependencyFilePatterns.forEach((pattern) => dependency.add(pattern));
      adapter.publicApiFilePatterns.forEach((pattern) => publicApi.add(pattern));
    }
  }

  return {
    adapters: detectedAdapters,
    dependency: [...dependency],
    publicApi: [...publicApi]
  };
}

export function matchChangedFiles(files: readonly string[], patterns: readonly string[]): string[] {
  return files.filter((file) =>
    patterns.some(
      (pattern) =>
        file === pattern ||
        minimatch(file, pattern, {
          dot: true,
          matchBase: !pattern.includes("/")
        })
    )
  );
}
