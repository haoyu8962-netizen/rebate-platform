export interface ForwarderOptions {
  webhookFiles: Readonly<Record<'finance' | 'oncall', string>>;
  readWebhookFile: (path: string) => Promise<string>;
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutSignal: (milliseconds: number) => AbortSignal;
}

export async function handleAlertmanagerWebhook(
  request: Request,
  options: ForwarderOptions,
): Promise<Response> {
  void request;
  void options;
  throw new Error('NotImplemented: handleAlertmanagerWebhook');
}
