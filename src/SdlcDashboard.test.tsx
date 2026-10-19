import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SdlcDashboard } from './SdlcDashboard';

beforeEach(() => localStorage.clear());

describe('M2 dashboard', () => {
  it('explains all four SDLC statuses and how evidence is verified', () => {
    render(<SdlcDashboard />);
    const legend = within(screen.getByRole('region', { name: 'What the statuses mean' }));
    const meanings = [
      ['Pending', 'This step is not currently active and has no current valid report.'],
      ['Awaiting human approval', 'A person must authorize the next manual handoff.'],
      ['User-supplied claim', 'A result was reported, but it has not been independently verified.'],
      ['Independently verified', 'Evidence has been checked against an authoritative source.'],
    ];
    for (const [label, explanation] of meanings) {
      const term = legend.getByText(label);
      expect(term.tagName).toBe('DT');
      expect(term.nextElementSibling).toHaveTextContent(explanation);
    }
    expect(legend.getByText('Mission Control does not independently verify evidence automatically.')).toBeInTheDocument();
  });

  it('makes role handoffs visible and requires human approval before report import', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      render(<SdlcDashboard />);
      expect(screen.getByText(/Epic #201/)).toBeInTheDocument();
      expect(screen.getByText(/FICTIONAL LOCAL FIXTURE/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'Approve Epic plan'}));
      expect(screen.getByRole('button',{name:'Import BUILDER report'})).toBeDisabled();
      fireEvent.click(screen.getByRole('button',{name:'Approve BUILDER handoff'}));
      expect(screen.getByRole('button',{name:'Import BUILDER report'})).toBeEnabled();
      expect((screen.getByLabelText('Copy-ready Codex role instructions') as HTMLTextAreaElement).value).toContain('MANUAL BUILDER HANDOFF');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
  it('requires a new approval after browser restoration', () => {
    const first = render(<SdlcDashboard />);
    fireEvent.click(screen.getByRole('button',{name:'Approve Epic plan'}));
    fireEvent.click(screen.getByRole('button',{name:'Approve BUILDER handoff'}));
    first.unmount();
    render(<SdlcDashboard />);
    expect(screen.getByRole('button',{name:'Import BUILDER report'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Approve BUILDER handoff'})).toBeEnabled();
  });
});
