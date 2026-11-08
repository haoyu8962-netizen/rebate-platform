import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AsyncImage } from './AsyncImage.tsx';
import { Card } from './Card.tsx';

afterEach(cleanup);

it('a disabled clickable card keeps its button name, is aria-disabled and ignores presses', () => {
  const onClick = vi.fn();
  render(
    <Card aria-label="poster" onClick={onClick} disabled>
      text
    </Card>,
  );
  const card = screen.getByRole('button', { name: 'poster' });
  expect(card.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(card);
  fireEvent.keyDown(card, { key: 'Enter' });
  fireEvent.keyUp(card, { key: ' ' });
  expect(onClick).not.toHaveBeenCalled();
});

it('an enabled clickable card has no aria-disabled and calls onClick', () => {
  const onClick = vi.fn();
  render(
    <Card aria-label="poster" onClick={onClick}>
      text
    </Card>,
  );
  const card = screen.getByRole('button', { name: 'poster' });
  expect(card.hasAttribute('aria-disabled')).toBe(false);
  fireEvent.click(card);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('AsyncImage reports the failed url through onError', () => {
  const onError = vi.fn();
  const view = render(<AsyncImage src="https://x.test/a.png" alt="" onError={onError} />);
  fireEvent.error(view.container.querySelector('img')!);
  expect(onError).toHaveBeenCalledWith('https://x.test/a.png');
  expect(view.container.querySelector('[data-state="error"]')).not.toBeNull();
});
