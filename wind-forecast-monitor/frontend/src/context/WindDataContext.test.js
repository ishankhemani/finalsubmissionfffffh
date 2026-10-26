/**
 * Regression tests for WindDataContext request handling.
 *
 * Race condition: if request A is issued and then request B, a slow response
 * for A must not overwrite the (newer) result of B.
 */
import { render, screen, act } from '@testing-library/react';
import axios from 'axios';
import { WindDataProvider, useWindDataContext } from './WindDataContext';

jest.mock('axios', () => ({ get: jest.fn() }));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const body = (n) => ({
  data: {
    records: Array.from({ length: n }, (_, i) => ({
      time: `2026-01-02T00:${String(i).padStart(2, '0')}:00Z`,
      actual: 100,
      forecast: 100,
    })),
    metrics: { mode: 'decision', decisionTime: '09:00', nValid: n, nTotal: n },
  },
});

let api;
function Probe() {
  api = useWindDataContext();
  return (
    <div>
      <span data-testid="status">{api.state.status}</span>
      <span data-testid="err">{api.state.error || ''}</span>
      <span data-testid="rows">{api.state.rawData ? api.state.rawData.length : 'none'}</span>
    </div>
  );
}

test('a slow earlier response does not overwrite a newer one', async () => {
  const a = deferred();
  const b = deferred();
  axios.get.mockReset();
  axios.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

  render(<WindDataProvider><Probe /></WindDataProvider>);

  // Issue request A (range 1) then request B (range 2) before A resolves.
  await act(async () => { api.fetchData('2026-01-02', '2026-01-03', 24, 'decision', '09:00'); });
  await act(async () => { api.fetchData('2026-01-02', '2026-01-04', 24, 'decision', '09:00'); });

  // B (3 rows) resolves first, then the stale A (1 row) arrives late.
  await act(async () => { b.resolve(body(3)); });
  await act(async () => { a.resolve(body(1)); });

  expect(screen.getByTestId('rows')).toHaveTextContent('3');
  expect(screen.getByTestId('status')).toHaveTextContent('success');
});

test('an identical in-flight request is still de-duplicated', async () => {
  const a = deferred();
  axios.get.mockReset();
  axios.get.mockReturnValue(a.promise);

  render(<WindDataProvider><Probe /></WindDataProvider>);

  await act(async () => { api.fetchData('2026-02-02', '2026-02-03', 24, 'decision', '09:00'); });
  await act(async () => { api.fetchData('2026-02-02', '2026-02-03', 24, 'decision', '09:00'); });

  expect(axios.get).toHaveBeenCalledTimes(1);
  await act(async () => { a.resolve(body(2)); });
  expect(screen.getByTestId('rows')).toHaveTextContent('2');
});

test('network failures show a friendly message, not raw client error text', async () => {
  axios.get.mockReset();
  axios.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:8000'));
  render(<WindDataProvider><Probe /></WindDataProvider>);
  await act(async () => { api.fetchData('2026-03-02', '2026-03-03', 24, 'decision', '09:00'); });
  const msg = screen.getByTestId('err').textContent;
  expect(msg).toMatch(/could not reach the server/i);
  expect(msg).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
});

test('the API\'s own error detail is still shown', async () => {
  axios.get.mockReset();
  axios.get.mockRejectedValueOnce({ response: { status: 400, data: { detail: 'start must be on or before end.' } } });
  render(<WindDataProvider><Probe /></WindDataProvider>);
  await act(async () => { api.fetchData('2026-04-02', '2026-04-03', 24, 'decision', '09:00'); });
  expect(screen.getByTestId('err')).toHaveTextContent('start must be on or before end.');
});
