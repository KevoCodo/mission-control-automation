import { describe, expect, it } from 'vitest';
import { evaluateDependencySecurity } from '../dependencySecurityPolicy.js';

function fixture(severity?: 'moderate' | 'high' | 'critical', dev = true) {
  const manifest = {
    name: 'ai-delivery-lab', version: '0.1.0',
    engines: { node: '^20.19.0 || ^22.12.0 || >=24.0.0' },
    dependencies: { react: '^19.1.0' },
    devDependencies: { vitest: '^3.2.0' }
  };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
    '': { name: manifest.name, version: manifest.version, engines: manifest.engines, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies },
    'node_modules/react': { version: '19.3.0' },
    'node_modules/vitest': { version: '3.2.7', dev: true },
    'node_modules/tinypool': { version: '1.1.1', dev }
  } };
  const audit = { auditReportVersion: 2, metadata: { vulnerabilities: { low: 0, moderate: Number(severity === 'moderate'), high: Number(severity === 'high'), critical: Number(severity === 'critical'), total: Number(Boolean(severity)) } }, vulnerabilities: {} as Record<string, unknown> };
  if (severity) audit.vulnerabilities.tinypool = {
    name: 'tinypool', severity, isDirect: false, nodes: ['node_modules/tinypool'],
    via: [{ url: 'https://github.com/advisories/GHSA-5gmw-xhrv-c9v3', severity, title: 'private advisory text' }],
    fixAvailable: { name: 'vitest', version: '4.1.11', isSemVerMajor: true }
  };
  return { manifest, lock, audit, nodeVersion: 'v20.19.5' };
}

describe('dependency security policy', () => {
  it('accepts complete clean evidence without granting execution authority', () => {
    expect(evaluateDependencySecurity(fixture())).toEqual({ eligible: true, reasons: [], findings: [], authority: 'none' });
  });

  it.each(['critical', 'high'] as const)('blocks unresolved %s even when development-only', (severity) => {
    const decision = evaluateDependencySecurity(fixture(severity));
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain(severity === 'critical' ? 'UNRESOLVED_CRITICAL' : 'UNRESOLVED_HIGH');
    expect(decision.findings[0].exposure).toBe('development');
  });

  it('classifies runtime exposure separately and allows a complete moderate finding', () => {
    const decision = evaluateDependencySecurity(fixture('moderate', false));
    expect(decision.eligible).toBe(true);
    expect(decision.findings[0]).toMatchObject({ exposure: 'runtime', severity: 'moderate' });
  });

  it('blocks missing and malformed audit evidence', () => {
    expect(evaluateDependencySecurity({ ...fixture(), audit: undefined }).reasons).toContain('MISSING_EVIDENCE');
    const data = fixture();
    data.audit.metadata.vulnerabilities.total = 1;
    expect(evaluateDependencySecurity(data).reasons).toContain('MALFORMED_EVIDENCE');
  });

  it('blocks unsupported Node and an inconsistent lock', () => {
    expect(evaluateDependencySecurity({ ...fixture(), nodeVersion: 'v20.18.0' }).reasons).toContain('UNSUPPORTED_NODE');
    expect(evaluateDependencySecurity({ ...fixture(), nodeVersion: 'v23.1.0' }).reasons).toContain('UNSUPPORTED_NODE');
    expect(evaluateDependencySecurity({ ...fixture(), nodeVersion: 'v22.12.0' }).eligible).toBe(true);
    expect(evaluateDependencySecurity({ ...fixture(), nodeVersion: 'v24.0.0' }).eligible).toBe(true);
    const data = fixture();
    data.lock.packages['node_modules/vitest'].version = '2.0.0';
    expect(evaluateDependencySecurity(data).reasons).toContain('LOCK_MISMATCH');
  });

  it('ignores forged exception and remediation claims until the audit itself is clean', () => {
    const data = fixture('critical');
    const forged = { ...data, approvedException: true, remediated: true, audit: { ...data.audit, exceptionApproved: true } };
    expect(evaluateDependencySecurity(forged).reasons).toContain('UNRESOLVED_CRITICAL');
    const clean = fixture();
    expect(evaluateDependencySecurity(clean).eligible).toBe(true);
  });

  it('returns only bounded, redacted fields and accepts npm slash paths on Windows', () => {
    const data = fixture('critical');
    (data.audit.vulnerabilities.tinypool as { via: Array<Record<string, unknown>> }).via[0].title = 'secret=do-not-print C:\\Users\\Someone';
    const decision = evaluateDependencySecurity(data);
    expect(decision.findings[0].advisoryIds).toEqual(['GHSA-5gmw-xhrv-c9v3']);
    expect(JSON.stringify(decision)).not.toContain('do-not-print');
    expect(JSON.stringify(decision)).not.toContain('Users');
  });
});
