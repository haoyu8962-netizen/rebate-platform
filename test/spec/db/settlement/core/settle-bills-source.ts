// B2-18a: collects the statements of every later migration that ALTER app.settle_bills, built the
// same way kit.ts collects the app.settle_batches ones. The gate only allows pure statement
// insertions into the frozen support file kit.ts, so the logic lives in this file.
export function appendSettleBillsStatements(
  later: string[],
  all: readonly string[],
  core: string,
  strip: (name: string) => string,
): void {
  const alters = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?app\.settle_bills\b/i;
  const touches = /\bapp\.settle_bills\b/i;
  const statements = all
    .filter((name) => name > core)
    .map((name) => strip(name).replace(/"/g, ''))
    .filter((source) => alters.test(source))
    .flatMap((source) => source.split(';').filter((statement) => touches.test(statement)))
    .map((statement) => `${statement.trim()};`);
  later.push(...statements);
}
