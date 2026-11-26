import { expect, it } from 'vitest';
import { scrubEvent, scrubText } from './scrub.ts';

const TOKEN = 'unitExampleTokenPlaceholder';
const BASIC = 'dW5pdC11c2VyOnVuaXQtcGFzcw==';

it.each([
  [`上游认证失败，Authorization: Bearer ${TOKEN}`],
  [`upstream refused: bearer ${TOKEN}`],
  [`proxy said Proxy-Authorization: Basic ${BASIC}`],
  [`request with Basic ${BASIC} failed`],
  [`{"authorization":"${TOKEN}","status":401}`],
  [`cookie: sid=${TOKEN}; theme=dark`],
  [`x-api-key=${TOKEN}`],
])('[AC-QA-13d#2] scrubText drops the credential in %s', (text: string) => {
  const scrubbed = scrubText(text);
  expect(scrubbed).toContain('[REDACTED]');
  expect(scrubbed).not.toContain(TOKEN);
  expect(scrubbed).not.toContain(BASIC);
});

it('[AC-QA-13d#2] ordinary words around the schemes stay readable', () => {
  expect(scrubText('Basic validation failed')).toBe('Basic validation failed');
  expect(scrubText('cookie parse failed')).toBe('cookie parse failed');
});

it('[AC-QA-13d#2] an exception message with Authorization: Bearer leaves the event without the token', () => {
  const event = scrubEvent({
    exception: {
      values: [{ type: 'Error', value: `上游认证失败，Authorization: Bearer ${TOKEN}` }],
    },
  });
  const value = event.exception?.values?.[0]?.value ?? '';
  expect(value.startsWith('上游认证失败，Authorization: ')).toBe(true);
  expect(JSON.stringify(event)).not.toContain(TOKEN);
});
