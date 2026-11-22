export interface ContainerState {
  Running: boolean;
  Health?: { Status: string };
}

export interface ContainerHealthOptions {
  inspect: (name: string) => Promise<ContainerState | null>;
  fetch: typeof fetch;
}

export async function publishContainerHealth(options: ContainerHealthOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: publishContainerHealth');
}
