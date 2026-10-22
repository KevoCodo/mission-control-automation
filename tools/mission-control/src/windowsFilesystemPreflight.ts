import { win32 } from 'node:path';
import { assessWindowsPath } from './workerIsolation.js';

export interface WindowsFilesystemIdentityClaim {
  workspaceRoot: string;
  candidate: string;
  volumeId: string;
  rootFileId: string;
  candidateFileId: string;
  resolvedRoot: string;
  resolvedCandidate: string;
  components: Array<'ORDINARY' | 'REPARSE' | 'UNKNOWN'>;
}

type Component = WindowsFilesystemIdentityClaim['components'][number];

/** Read own data descriptors only; never call methods supplied by the claim. */
function copyComponents(value: unknown): Component[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = value.length;
  if (length === 0 || Object.getOwnPropertyNames(descriptors).length !== length + 1 ||
    !Object.hasOwn(descriptors, 'length')) return null;
  const copied: Component[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable ||
      (descriptor.value !== 'ORDINARY' && descriptor.value !== 'REPARSE' &&
        descriptor.value !== 'UNKNOWN')) return null;
    copied.push(descriptor.value);
  }
  return copied;
}

/** Lexical consistency of a claimed OS-handle inspection. No OS handles are opened here. */
export function assessWindowsFilesystemIdentity(value: unknown): string[] {
  const malformed = ['MALFORMED_FILESYSTEM_IDENTITY'];
  try { return assessWindowsFilesystemIdentityData(value); } catch { return malformed; }
}

function assessWindowsFilesystemIdentityData(value: unknown): string[] {
  const malformed = ['MALFORMED_FILESYSTEM_IDENTITY'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) return malformed;
  const v = value as Record<string, unknown>;
  const keys = ['workspaceRoot', 'candidate', 'volumeId', 'rootFileId', 'candidateFileId',
    'resolvedRoot', 'resolvedCandidate', 'components'];
  if (Object.keys(v).length !== keys.length || Object.getOwnPropertyNames(v).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(v, key)) ||
    Object.getOwnPropertySymbols(v).length ||
    keys.some((key) => !('value' in (Object.getOwnPropertyDescriptor(v, key) ?? {}))) ||
    !['workspaceRoot', 'candidate', 'volumeId', 'rootFileId', 'candidateFileId', 'resolvedRoot', 'resolvedCandidate']
      .every((key) => typeof v[key] === 'string' && (v[key] as string).length > 0) ||
    !Array.isArray(v.components)) return malformed;
  const components = copyComponents(v.components);
  if (!components) return malformed;
  const claim = v as unknown as WindowsFilesystemIdentityClaim;
  const reasons = assessWindowsPath(claim.workspaceRoot, claim.candidate);
  reasons.push(...assessWindowsPath(claim.resolvedRoot, claim.resolvedCandidate));
  if (win32.parse(claim.workspaceRoot).root.toUpperCase() !== win32.parse(claim.resolvedRoot).root.toUpperCase() ||
    win32.parse(claim.candidate).root.toUpperCase() !== win32.parse(claim.resolvedCandidate).root.toUpperCase())
    reasons.push('DRIVE_BINDING_MISMATCH');
  if (claim.workspaceRoot.toLowerCase() !== claim.resolvedRoot.toLowerCase() ||
    claim.candidate.toLowerCase() !== claim.resolvedCandidate.toLowerCase()) reasons.push('CANONICAL_PATH_MISMATCH');
  if (!/^[A-Za-z0-9-]{8,128}$/.test(claim.volumeId) || !/^[A-Za-z0-9-]{8,128}$/.test(claim.rootFileId) ||
    !/^[A-Za-z0-9-]{8,128}$/.test(claim.candidateFileId)) reasons.push('UNVERIFIABLE_FILESYSTEM_IDENTITY');
  if (claim.resolvedRoot.toLowerCase() === claim.resolvedCandidate.toLowerCase() &&
    claim.rootFileId !== claim.candidateFileId) reasons.push('FILE_IDENTITY_MISMATCH');
  if (components.includes('REPARSE')) reasons.push('REPARSE_POINT_PRESENT');
  if (components.includes('UNKNOWN')) reasons.push('REPARSE_POINT_UNVERIFIED');
  // A matching volume/file ID remains a claim until a trusted native verifier checks live handles.
  return [...new Set(reasons)];
}
