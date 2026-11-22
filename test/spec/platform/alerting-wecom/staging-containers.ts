import { ENTRIES, services } from '../../infra/staging/kit.ts';

// Compose uses project name couli-staging with one replica per service.
export const CONTAINERS = ENTRIES.map((entry) => `couli-staging-${entry}-1`);

export function configuredContainers(): string[] {
  return Object.keys(services()).map((name) => `couli-staging-${name}-1`);
}
