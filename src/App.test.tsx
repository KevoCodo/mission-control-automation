import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

beforeEach(() => { localStorage.clear(); });

describe('Mission Control screen', () => {
  function prepareCopy() {
    fireEvent.change(screen.getByLabelText('Local demonstration issue'), { target: { value: '101' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }));
  }

  it('shows fixture provenance, plan approval and manual-only handoff', () => {
    render(<App />);
    expect(screen.getByText(/LOCAL DEMO DATA/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run worker/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Local demonstration issue'), { target: { value: '101' } });
    const plan = within(screen.getByRole('region', { name: 'Implementation plan' }));
    expect(plan.getByLabelText('Scope')).toHaveValue('Create a small, accessible reference panel for the demonstration app.');
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    expect((screen.getByLabelText('Copy-ready Codex instructions') as HTMLTextAreaElement).value).toContain('MANUAL CODEX HANDOFF');
    fireEvent.change(plan.getByLabelText('Scope'), { target: { value: 'Revised scope' } });
    expect(screen.queryByLabelText('Copy-ready Codex instructions')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare handoff' })).toBeDisabled();
  });

  it('copying does not imply execution and cancellation clears handoff', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<App />);
    fireEvent.change(screen.getByLabelText('Local demonstration issue'), { target: { value: '101' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy handoff' }));
    expect(await screen.findByText(/Copied. No worker has been launched/)).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledOnce();
    expect(screen.getByText('awaiting manual execution')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel handoff' }));
    expect(screen.queryByLabelText('Copy-ready Codex instructions')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare handoff' })).toBeDisabled();
  });

  it.each(['edit', 'cancel', 'reset'] as const)('ignores delayed clipboard success after %s', async (change) => {
    let finishCopy!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishCopy = resolve; }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      render(<App />);
      prepareCopy();
      expect(screen.getByText('handoff prepared')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Copy handoff' }));
      expect(writeText).toHaveBeenCalledOnce();
      if (change === 'edit') fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'Revised while copying' } });
      if (change === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel handoff' }));
      if (change === 'reset') fireEvent.click(screen.getByRole('button', { name: 'Reset demo workflow' }));
      await act(async () => { finishCopy(); });
      expect(screen.queryByLabelText('Copy-ready Codex instructions')).not.toBeInTheDocument();
      expect(screen.queryByText('awaiting manual execution')).not.toBeInTheDocument();
      expect(screen.queryByText(/Copied. No worker has been launched/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Prepare handoff' })).toBeDisabled();
      const savedDraft = localStorage.getItem('mission-control-m1-demo-draft-v1');
      if (change === 'reset') expect(savedDraft).toBeNull();
      else expect(JSON.parse(savedDraft!) as { approval?: unknown }).not.toHaveProperty('approval');
      expect(screen.queryByRole('button', { name: /run worker/i })).not.toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it('keeps manual clipboard fallback for a current handoff', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Clipboard blocked')) } });
    render(<App />);
    prepareCopy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy handoff' }));
    expect(await screen.findByText('Clipboard unavailable. Select and copy the text manually.')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy-ready Codex instructions')).toBeInTheDocument();
    expect(screen.getByText('handoff prepared')).toBeInTheDocument();
  });

  it('keeps the existing task board accessible', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Existing task board/ }));
    expect(screen.getByRole('region', { name: 'Task board' })).toBeInTheDocument();
  });
});
