/** Pure assessment of npm audit and the committed package/lock pair. No effects or grants. */
export interface DependencySecurityInput {
  manifest: unknown;
  lock: unknown;
  audit: unknown;
  nodeVersion: string;
}

export type DependencySecurityReason =
  | 'MISSING_EVIDENCE' | 'MALFORMED_EVIDENCE' | 'LOCK_MISMATCH'
  | 'UNSUPPORTED_NODE' | 'UNRESOLVED_HIGH' | 'UNRESOLVED_CRITICAL';

export interface DependencyFinding {
  package: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  exposure: 'runtime' | 'development';
  advisoryIds: string[];
}

export interface DependencySecurityDecision {
  eligible: boolean;
  reasons: DependencySecurityReason[];
  findings: DependencyFinding[];
  authority: 'none';
}

type RecordValue = Record<string, unknown>;
const severities = ['low', 'moderate', 'high', 'critical'] as const;

export function evaluateDependencySecurity(input: DependencySecurityInput): DependencySecurityDecision {
  const reasons: DependencySecurityReason[] = [];
  const deny = (reason: DependencySecurityReason) => { if (!reasons.includes(reason)) reasons.push(reason); };
  const findings: DependencyFinding[] = [];
  if (!input || !isRecord(input.manifest) || !isRecord(input.lock) || !isRecord(input.audit) ||
      typeof input.nodeVersion !== 'string') {
    return { eligible: false, reasons: ['MISSING_EVIDENCE'], findings, authority: 'none' };
  }

  const manifest = input.manifest;
  const lock = input.lock;
  const audit = input.audit;
  const packages = lock.packages;
  const root = isRecord(packages) ? packages[''] : undefined;
  const dependencies = dependencyMap(manifest.dependencies);
  const devDependencies = dependencyMap(manifest.devDependencies);
  if (!isRecord(root) || !isRecord(packages) || !dependencies || !devDependencies ||
      !sameMap(dependencies, dependencyMap(root.dependencies)) ||
      !sameMap(devDependencies, dependencyMap(root.devDependencies)) ||
      !isRecord(manifest.engines) || typeof manifest.engines.node !== 'string' ||
      audit.auditReportVersion !== 2 ||
      !isRecord(audit.metadata) || !isRecord(audit.metadata.vulnerabilities) ||
      !isRecord(audit.vulnerabilities)) {
    deny('MALFORMED_EVIDENCE');
    return { eligible: false, reasons, findings, authority: 'none' };
  }
  if (lock.lockfileVersion !== 3 || lock.name !== manifest.name || lock.version !== manifest.version ||
      root.name !== manifest.name || root.version !== manifest.version ||
      !isRecord(root.engines) || root.engines.node !== manifest.engines.node) deny('LOCK_MISMATCH');
  if (manifest.engines.node !== '^20.19.0 || ^22.12.0 || >=24.0.0' || !supportedNode(input.nodeVersion)) deny('UNSUPPORTED_NODE');

  for (const [name, requested] of Object.entries({ ...dependencies, ...devDependencies })) {
    const entry = packages[`node_modules/${name}`];
    if (!isRecord(entry) || typeof entry.version !== 'string' || !matchesRequested(entry.version, requested)) deny('LOCK_MISMATCH');
  }
  for (const [name, raw] of Object.entries(audit.vulnerabilities)) {
    if (!isRecord(raw) || raw.name !== name || !severities.includes(raw.severity as typeof severities[number]) ||
        typeof raw.isDirect !== 'boolean' || !Array.isArray(raw.via) || !Array.isArray(raw.nodes) ||
        raw.nodes.length === 0 || !raw.nodes.every((node) => typeof node === 'string' && node.startsWith('node_modules/')) ||
        !raw.via.every((via) => typeof via === 'string' || validAdvisory(via))) {
      deny('MALFORMED_EVIDENCE');
      continue;
    }
    if (raw.nodes.some((node) => !isRecord(packages[node]))) deny('LOCK_MISMATCH');
    const ids = raw.via.filter(isRecord).map((via) => advisoryId(via.url as string)).filter((id): id is string => Boolean(id));
    const severity = raw.severity as DependencyFinding['severity'];
    const exposure = raw.nodes.some((node) => isRecord(packages[node]) && packages[node].dev !== true)
      ? 'runtime' : 'development';
    findings.push({ package: name, severity, exposure, advisoryIds: [...new Set(ids)].sort() });
    if (severity === 'critical') deny('UNRESOLVED_CRITICAL');
    if (severity === 'high') deny('UNRESOLVED_HIGH');
  }
  const counts = audit.metadata.vulnerabilities;
  const counted = Object.fromEntries(severities.map((severity) => [severity, findings.filter((f) => f.severity === severity).length]));
  if (severities.some((severity) => counts[severity] !== counted[severity]) ||
      counts.total !== findings.length) deny('MALFORMED_EVIDENCE');
  return { eligible: reasons.length === 0, reasons, findings: findings.sort((a, b) => a.package.localeCompare(b.package)), authority: 'none' };
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dependencyMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || Object.values(value).some((version) => typeof version !== 'string')) return undefined;
  return value as Record<string, string>;
}

function sameMap(left: Record<string, string>, right: Record<string, string> | undefined): boolean {
  return Boolean(right) && Object.keys(left).length === Object.keys(right!).length &&
    Object.entries(left).every(([name, version]) => right![name] === version);
}

function supportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24;
}

function matchesRequested(version: string, requested: string): boolean {
  const installed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const wanted = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(requested);
  if (!installed || !wanted) return false;
  const [major, minor, patch] = installed.slice(1).map(Number);
  const [wantedMajor, wantedMinor, wantedPatch] = wanted.slice(2).map(Number);
  if (major !== wantedMajor || minor < wantedMinor || (minor === wantedMinor && patch < wantedPatch)) return false;
  if (wanted[1] === '~' && minor !== wantedMinor) return false;
  if (!wanted[1] && (minor !== wantedMinor || patch !== wantedPatch)) return false;
  return true;
}

function validAdvisory(value: unknown): value is RecordValue {
  return isRecord(value) && typeof value.url === 'string' && advisoryId(value.url) !== undefined &&
    severities.includes(value.severity as typeof severities[number]);
}

function advisoryId(url: string): string | undefined {
  return /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(url)?.[1];
}
