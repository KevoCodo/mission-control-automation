import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the task dashboard summary and grouped task board', () => {
    render(<App />);

    expect(
      screen.getByRole('heading', { level: 1, name: /ai delivery lab/i })
    ).toBeInTheDocument();
    expect(screen.getByText('Total tasks')).toBeInTheDocument();
    expect(screen.getByText('High priority')).toBeInTheDocument();

    const board = screen.getByRole('region', { name: /task board/i });

    expect(within(board).getByRole('heading', { name: /to do/i })).toBeInTheDocument();
    expect(within(board).getByRole('heading', { name: /in progress/i })).toBeInTheDocument();
    expect(within(board).getByRole('heading', { name: /done/i })).toBeInTheDocument();
    expect(screen.getByText('Define task intake workflow')).toBeInTheDocument();
  });
});

