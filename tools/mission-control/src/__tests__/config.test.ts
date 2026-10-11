import { describe, expect, it } from 'vitest';
import { ConfigError, defaultConfig, validateConfig } from '../config.js';
import type { ControllerConfig } from '../types.js';

describe('controller config validation', () => {
  it('keeps safe dry-run defaults', () => {
    const config = validateConfig(defaultConfig);

    expect(config.executionMode).toBe('dry-run');
    expect(config.deploy).toBe(false);
    expect(config.limits.maxBuilders).toBeLessThanOrEqual(2);
    expect(config.limits.correctionAttempts).toBeLessThanOrEqual(2);
  });

  it('rejects malformed config', () => {
    expect(() => validateConfig({ repository: 'bad' })).toThrow(ConfigError);
  });

  it('rejects concurrency greater than two', () => {
    expect(() => validateConfig(withConfig({ limits: { ...defaultConfig.limits, maxBuilders: 3 } }))).toThrow(
      /maxBuilders/
    );
  });

  it('rejects correction attempts greater than two', () => {
    expect(() => validateConfig(withConfig({ limits: { ...defaultConfig.limits, correctionAttempts: 3 } }))).toThrow(
      /correctionAttempts/
    );
  });

  it('rejects non-E drive worktree roots', () => {
    expect(() => validateConfig(withConfig({ worktreeRoot: 'C:\\tmp\\worktrees' }))).toThrow(/E: drive/);
  });

  it('rejects main, master, and default branches', () => {
    expect(() =>
      validateConfig(
        withConfig({
          identities: {
            ...defaultConfig.identities,
            sessions: [{ ...defaultConfig.identities.sessions[0], branch: 'main' }]
          }
        })
      )
    ).toThrow(/feature branch/);
  });

  it('rejects unsupported execution modes', () => {
    expect(() => validateConfig(withConfig({ executionMode: 'live' }))).toThrow(/dry-run/);
  });

  it('rejects credential-bearing config keys', () => {
    expect(() => validateConfig(withConfig({ githubToken: 'ghp_should-not-be-here' }))).toThrow(/Credential/);
  });
});

function withConfig(override: Record<string, unknown>): ControllerConfig {
  return {
    ...defaultConfig,
    ...override
  } as ControllerConfig;
}
