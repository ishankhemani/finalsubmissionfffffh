/**
 * Smoke tests for the refactored App.
 *
 * These tests verify the component tree renders without crashing and
 * key UI elements are present — without making real network calls.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

// Mock axios before any module-level imports evaluate
jest.mock('axios', () => ({
  get: jest.fn(() => Promise.resolve({ data: [] })),
}));

// Mock react-router-dom — react-scripts Jest cannot transform its ESM output.
// We only need BrowserRouter, Routes, Route, NavLink, useLocation for App.js.
jest.mock('react-router-dom', () => {
  const React = require('react');
  return {
    BrowserRouter: ({ children }) => React.createElement('div', null, children),
    Routes:        ({ children }) => React.createElement('div', null, children),
    Route:         ({ element })  => element,
    NavLink:       ({ children, className }) =>
      React.createElement('a', { className: typeof className === 'function' ? className({ isActive: false }) : className }, children),
    useLocation:   () => ({ pathname: '/' }),
  };
});

test('renders the Forecast Analysis page title', () => {
  render(<App />);
  // Both the sidebar nav link and page h1 contain "Forecast Analysis" — check at least one renders
  const matches = screen.getAllByText(/Forecast/i);
  expect(matches.length).toBeGreaterThan(0);
});

test('renders the Load Data button', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: /Load Data/i })).toBeInTheDocument();
});

test('defaults to the day-ahead decision-time control (D-1, 09:00)', () => {
  render(<App />);
  const time = screen.getByLabelText(/Decision time/i);
  expect(time).toHaveAttribute('type', 'time');
  expect(time).toHaveValue('09:00');
  expect(screen.queryByLabelText(/Forecast horizon in hours/i)).not.toBeInTheDocument();
});

test('switching to fixed lead time shows the horizon slider', () => {
  render(<App />);
  fireEvent.change(screen.getByLabelText(/Forecast basis/i), { target: { value: 'horizon' } });
  const slider = screen.getByLabelText(/Forecast horizon in hours/i);
  expect(slider).toHaveAttribute('type', 'range');
  expect(slider).toHaveAttribute('min', '0');
  expect(slider).toHaveAttribute('max', '48');
});

test('January preset sets the delivery range for January 2026 decisions', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /Jan 2026 decisions/i }));
  expect(screen.getByLabelText(/Start Date/i)).toHaveValue('2026-01-02');
  expect(screen.getByLabelText(/End Date/i)).toHaveValue('2026-02-01');
});
