import { win32 } from 'node:path';
import { EXP00_DISPOSABLE_ROOT } from './windowsHostReadiness.js';

/** Version 1 records are review material, never build or runtime authority. */
export const EXP00_SOURCE_NAMES = [
  'build-disposable.ps1', 'disposable_job_harness.cpp',
  'disposable_job_probe.cpp', 'disposable_fixture.cpp'
] as const;
export const EXP00_BINARY_NAMES = ['disposable_job_harness.exe', 'disposable_fixture.exe'] as const;
export type Exp00SourceName = typeof EXP00_SOURCE_NAMES[number];
export type Exp00BinaryName = typeof EXP00_BINARY_NAMES[number];
export type Exp00SamplePhase = 'PRE_BUILD' | 'POST_BUILD' | 'SEALED';

export interface Exp00FileSample {
  path: string;
  sha256: string;
  size: number;
  volumeId: string;
  fileId: string;
  capturedAtMs: number;
}
export interface Exp00InputEvidence {
  pre: Exp00FileSample;
  post: Exp00FileSample;
}
export interface Exp00ToolEvidence extends Exp00InputEvidence {
  version: string;
  processEventId: string | null;
}
export interface Exp00Command {
  executable: string;
  arguments: string[];
}
export interface Exp00BuildManifest {
  version: 1;
  experiment: 'GATE2B_EXP00_DEFAULT_DENY';
  sourceCommit: string;
  root: string;
  captured: { startedAtMs: number; endedAtMs: number; recordId: string };
  sources: { name: Exp00SourceName; pre: Exp00FileSample; post: Exp00FileSample }[];
  toolchain: {
    cmd: Exp00ToolEvidence; vcvars: Exp00ToolEvidence;
    compiler: Exp00ToolEvidence; linker: Exp00ToolEvidence;
    sdkVersion: string; sdkHeaders: Exp00InputEvidence[]; sdkLibraries: Exp00InputEvidence[];
  };
  invocation: {
    script: string; scriptHost: Exp00Command; cmdHost: Exp00Command;
    compilerCommands: Exp00Command[]; linkerCommands: Exp00Command[];
    workingDirectory: string;
    startedAtMs: number; endedAtMs: number;
    environment: { PATH: string; INCLUDE: string; LIB: string;
      WindowsSdkDir: string; VCToolsInstallDir: string;
      CL: string; _CL_: string; LINK: string; _LINK_: string };
    responseFiles: string[];
    includeOrder: string[]; libraryOrder: string[]; processTraceSha256: string;
  };
  outputs: { name: Exp00BinaryName; built: Exp00FileSample; sealed: Exp00FileSample }[];
}
export interface Exp00BuildProvenanceVerdict {
  status: 'REJECTED' | 'UNVERIFIED';
  reasons: string[];
  locallyConsistent: boolean;
  fileBytes: 'CALLER_SUPPLIED_UNVERIFIED';
  toolResolution: 'UNVERIFIED';
  independentlyVerified: false;
  experiment00: 'NO_GO';
  productionAuthorized: false;
  executable: false;
  manifest: Exp00BuildManifest | null;
}

type Data = Record<string, unknown>;
const sourceDir = win32.join(EXP00_DISPOSABLE_ROOT, 'src', 'tools', 'mission-control', 'native');
const buildDir = win32.join(sourceDir, 'build');
const sealedDir = win32.join(EXP00_DISPOSABLE_ROOT, 'run', 'sealed', 'default-deny');
const expectedVcvars = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';
const expectedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const vsRoot = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\';
const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\';

function data(value: unknown, keys: readonly string[]): Data {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw new Error('MALFORMED_RECORD');
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new Error('MALFORMED_RECORD');
  const result: Data = Object.create(null) as Data;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('MALFORMED_RECORD');
    result[key] = descriptor.value;
  }
  return result;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw new Error('MALFORMED_ARRAY');
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length > 1024 ||
      Object.keys(descriptors).length !== length + 1) throw new Error('MALFORMED_ARRAY');
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const item = descriptors[String(i)];
    if (!item || !item.enumerable || !('value' in item)) throw new Error('MALFORMED_ARRAY');
    result.push(item.value);
  }
  return result;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new Error('MISSING_FIELD');
  return value;
}
function envOption(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('INVALID_ENVIRONMENT');
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('INVALID_HASH');
  return value.toLowerCase();
}
function time(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('INVALID_TIME');
  return value as number;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('INVALID_SIZE');
  return value as number;
}
function path(value: unknown): string {
  const text = label(value);
  if (!/^[A-Za-z]:\\/.test(text) || win32.normalize(text) !== text || text.includes('..\\') ||
      text.includes('\\..') || text.includes(':', 2)) throw new Error('INVALID_PATH');
  return text;
}
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
function sample(value: unknown): Exp00FileSample {
  const v = data(value, ['path', 'sha256', 'size', 'volumeId', 'fileId', 'capturedAtMs']);
  const volumeId = label(v.volumeId);
  const fileId = label(v.fileId);
  if (fileId === '0') throw new Error('UNAVAILABLE_FILE_ID');
  return { path: path(v.path), sha256: digest(v.sha256), size: count(v.size),
    volumeId, fileId, capturedAtMs: time(v.capturedAtMs) };
}
function tool(value: unknown): Exp00ToolEvidence {
  const v = data(value, ['pre', 'post', 'version', 'processEventId']);
  return { pre: sample(v.pre), post: sample(v.post), version: label(v.version),
    processEventId: v.processEventId === null ? null : label(v.processEventId) };
}
function input(value: unknown): Exp00InputEvidence {
  const v = data(value, ['pre', 'post']);
  return { pre: sample(v.pre), post: sample(v.post) };
}
function strings(value: unknown, nonempty: boolean): string[] {
  const result = array(value).map(label);
  if (nonempty && result.length === 0) throw new Error('MISSING_FIELD');
  return result;
}
function command(value: unknown): Exp00Command {
  const v = data(value, ['executable', 'arguments']);
  return { executable: path(v.executable), arguments: strings(v.arguments, false) };
}
function exactNames<T extends string>(entries: { name: T }[], names: readonly T[]): void {
  if (entries.length !== names.length || new Set(entries.map(e => e.name)).size !== names.length ||
      entries.some(e => !names.includes(e.name))) throw new Error('ALLOWLIST_MISMATCH');
}
function parse(value: unknown): Exp00BuildManifest {
  const v = data(value, ['version', 'experiment', 'sourceCommit', 'root', 'captured',
    'sources', 'toolchain', 'invocation', 'outputs']);
  if (v.version !== 1 || v.experiment !== 'GATE2B_EXP00_DEFAULT_DENY' ||
      !same(path(v.root), EXP00_DISPOSABLE_ROOT) ||
      typeof v.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(v.sourceCommit))
    throw new Error('WRONG_BASELINE_OR_SCOPE');
  const c = data(v.captured, ['startedAtMs', 'endedAtMs', 'recordId']);
  const captured = { startedAtMs: time(c.startedAtMs), endedAtMs: time(c.endedAtMs), recordId: label(c.recordId) };
  const sources = array(v.sources).map(item => {
    const s = data(item, ['name', 'pre', 'post']);
    return { name: label(s.name) as Exp00SourceName, pre: sample(s.pre), post: sample(s.post) };
  });
  exactNames(sources, EXP00_SOURCE_NAMES);
  const t = data(v.toolchain, ['cmd', 'vcvars', 'compiler', 'linker', 'sdkVersion', 'sdkHeaders', 'sdkLibraries']);
  const toolchain = { cmd: tool(t.cmd), vcvars: tool(t.vcvars), compiler: tool(t.compiler),
    linker: tool(t.linker), sdkVersion: label(t.sdkVersion),
    sdkHeaders: array(t.sdkHeaders).map(input), sdkLibraries: array(t.sdkLibraries).map(input) };
  if (!toolchain.sdkHeaders.length || !toolchain.sdkLibraries.length) throw new Error('MISSING_SDK_INPUTS');
  const i = data(v.invocation, ['script', 'scriptHost', 'cmdHost', 'compilerCommands', 'linkerCommands',
    'workingDirectory', 'startedAtMs', 'endedAtMs',
    'environment', 'responseFiles', 'includeOrder',
    'libraryOrder', 'processTraceSha256']);
  const e = data(i.environment, ['PATH', 'INCLUDE', 'LIB', 'WindowsSdkDir', 'VCToolsInstallDir',
    'CL', '_CL_', 'LINK', '_LINK_']);
  const invocation = {
    script: path(i.script), scriptHost: command(i.scriptHost), cmdHost: command(i.cmdHost),
    compilerCommands: array(i.compilerCommands).map(command),
    linkerCommands: array(i.linkerCommands).map(command),
    workingDirectory: path(i.workingDirectory),
    startedAtMs: time(i.startedAtMs), endedAtMs: time(i.endedAtMs),
    environment: { PATH: label(e.PATH), INCLUDE: label(e.INCLUDE), LIB: label(e.LIB),
      WindowsSdkDir: path(e.WindowsSdkDir), VCToolsInstallDir: path(e.VCToolsInstallDir),
      CL: envOption(e.CL), _CL_: envOption(e._CL_),
      LINK: envOption(e.LINK), _LINK_: envOption(e._LINK_) },
    responseFiles: strings(i.responseFiles, false), includeOrder: strings(i.includeOrder, true),
    libraryOrder: strings(i.libraryOrder, true), processTraceSha256: digest(i.processTraceSha256)
  };
  const outputs = array(v.outputs).map(item => {
    const o = data(item, ['name', 'built', 'sealed']);
    return { name: label(o.name) as Exp00BinaryName, built: sample(o.built), sealed: sample(o.sealed) };
  });
  exactNames(outputs, EXP00_BINARY_NAMES);
  return { version: 1, experiment: 'GATE2B_EXP00_DEFAULT_DENY',
    sourceCommit: v.sourceCommit.toLowerCase(), root: EXP00_DISPOSABLE_ROOT,
    captured, sources, toolchain, invocation, outputs };
}

function check(m: Exp00BuildManifest): string[] {
  const problems: string[] = [];
  const add = (reason: string) => { if (!problems.includes(reason)) problems.push(reason); };
  const { captured: c, invocation: i, toolchain: t } = m;
  if (!(c.startedAtMs <= i.startedAtMs && i.startedAtMs < i.endedAtMs &&
      i.endedAtMs <= c.endedAtMs)) add('CONTRADICTORY_TIME_WINDOW');
  if (!same(i.script, win32.join(sourceDir, 'build-disposable.ps1')) ||
      !same(i.workingDirectory, buildDir)) add('WRONG_BUILD_INVOCATION');
  const fixtureSource = win32.join(sourceDir, 'disposable_fixture.cpp');
  const harnessSource = win32.join(sourceDir, 'disposable_job_harness.cpp');
  const fixtureOutput = win32.join(buildDir, 'disposable_fixture.exe');
  const harnessOutput = win32.join(buildDir, 'disposable_job_harness.exe');
  const commonArguments = ['/nologo', '/W4', '/WX', '/EHsc', '/std:c++17',
    '/DUNICODE', '/D_UNICODE'];
  const expectedCompilerArguments = [
    [...commonArguments, `/Fe:${fixtureOutput}`, fixtureSource, '/link', '/SUBSYSTEM:CONSOLE'],
    [...commonArguments, `/Fe:${harnessOutput}`, harnessSource, '/link', '/SUBSYSTEM:CONSOLE']
  ];
  // Deliberately narrow claimed linker argv. A real build with different argv is NO-GO
  // until the actual observed command is independently reviewed and this contract revised.
  const expectedLinkerArguments = [
    ['/NOLOGO', `/OUT:${fixtureOutput}`, win32.join(buildDir, 'disposable_fixture.obj'), '/SUBSYSTEM:CONSOLE'],
    ['/NOLOGO', `/OUT:${harnessOutput}`, win32.join(buildDir, 'disposable_job_harness.obj'), '/SUBSYSTEM:CONSOLE']
  ];
  const batchSegment = (source: string, output: string): string =>
    `cl /nologo /W4 /WX /EHsc /std:c++17 /DUNICODE /D_UNICODE /Fe:"${output}" "${source}" /link /SUBSYSTEM:CONSOLE`;
  const expectedBatch = `call "${expectedVcvars}" >nul && ` +
    batchSegment(fixtureSource, fixtureOutput) + ' && ' + batchSegment(harnessSource, harnessOutput);
  const equalArguments = (actual: string[], expected: string[]): boolean =>
    actual.length === expected.length && actual.every((arg, index) => arg === expected[index]);
  if (!same(i.scriptHost.executable, expectedPowerShell) ||
      !equalArguments(i.scriptHost.arguments, ['-NoProfile', '-NonInteractive', '-File', i.script]) ||
      !same(i.cmdHost.executable, t.cmd.pre.path) ||
      !equalArguments(i.cmdHost.arguments, ['/d', '/s', '/c', expectedBatch]) ||
      i.compilerCommands.length !== 2 || i.compilerCommands.some((entry, index) =>
        !same(entry.executable, t.compiler.pre.path) ||
        !equalArguments(entry.arguments, expectedCompilerArguments[index]!)) ||
      i.linkerCommands.length !== 2 || i.linkerCommands.some((entry, index) =>
        !same(entry.executable, t.linker.pre.path) ||
        !equalArguments(entry.arguments, expectedLinkerArguments[index]!)))
    add('UNRECOGNIZED_BUILD_INVOCATION');
  const commands = [i.scriptHost.executable, ...i.scriptHost.arguments,
    i.cmdHost.executable, ...i.cmdHost.arguments,
    ...i.compilerCommands.flatMap(entry => [entry.executable, ...entry.arguments]),
    ...i.linkerCommands.flatMap(entry => [entry.executable, ...entry.arguments]),
    i.environment.CL, i.environment._CL_, i.environment.LINK, i.environment._LINK_];
  if (commands.some(s => /EnableRuntimeExperiment|S2B2B2_RUNTIME_EXPERIMENT_ENABLED/i.test(s)))
    add('RUNTIME_BUILD_FORBIDDEN');
  if (i.responseFiles.length > 0 || commands.some(s => s.includes('@')))
    add('RESPONSE_FILE_CONTENTS_UNVERIFIED');
  if ([i.environment.CL, i.environment._CL_, i.environment.LINK, i.environment._LINK_]
    .some(value => value !== '')) add('UNRECOGNIZED_BUILD_OPTIONS');
  const expectedTools = [
    [t.cmd, 'C:\\Windows\\System32\\cmd.exe'], [t.vcvars, expectedVcvars]
  ] as const;
  if (expectedTools.some(([tool, expected]) => !same(tool.pre.path, expected)) ||
      !t.compiler.pre.path.toLowerCase().startsWith(vsRoot.toLowerCase()) ||
      !t.linker.pre.path.toLowerCase().startsWith(vsRoot.toLowerCase()) ||
      !t.compiler.pre.path.toLowerCase().endsWith('\\cl.exe') ||
      !t.linker.pre.path.toLowerCase().endsWith('\\link.exe') ||
      [t.cmd, t.compiler, t.linker].some(tool => tool.processEventId === null) ||
      t.vcvars.processEventId !== null) add('TOOL_RESOLUTION_UNPROVEN');
  const sdkVersionPath = `\\${t.sdkVersion.toLowerCase()}\\`;
  if (t.sdkHeaders.some(f => !f.pre.path.toLowerCase().startsWith(sdkRoot.toLowerCase()) ||
      !f.pre.path.toLowerCase().includes(sdkVersionPath) || !f.pre.path.toLowerCase().endsWith('.h')) ||
      t.sdkLibraries.some(f => !f.pre.path.toLowerCase().startsWith(sdkRoot.toLowerCase()) ||
      !f.pre.path.toLowerCase().includes(sdkVersionPath) || !f.pre.path.toLowerCase().endsWith('.lib')) ||
      !['windows.h', 'processthreadsapi.h', 'jobapi2.h'].every(name =>
        t.sdkHeaders.some(f => f.pre.path.toLowerCase().endsWith(`\\${name}`))) ||
      !t.sdkLibraries.some(f => f.pre.path.toLowerCase().endsWith('\\kernel32.lib')))
    add('WRONG_SDK_INPUT');
  const processIds = [t.cmd.processEventId, t.compiler.processEventId, t.linker.processEventId];
  if (new Set(processIds).size !== processIds.length) add('DUPLICATE_TOOL_PROCESS_ID');
  const usedIds = new Map<string, { path: string; sha256: string }>();
  const usedPaths = new Map<string, { identity: string; sha256: string }>();
  const register = (f: Exp00FileSample) => {
    if (!(c.startedAtMs <= f.capturedAtMs && f.capturedAtMs <= c.endedAtMs)) add('SAMPLE_OUTSIDE_CAPTURE');
    const key = `${f.volumeId}:${f.fileId}`;
    const previous = usedIds.get(key);
    if (previous && (!same(previous.path, f.path) || previous.sha256 !== f.sha256)) add('CONFLICTING_FILE_IDENTITY');
    else usedIds.set(key, { path: f.path, sha256: f.sha256 });
    const pathKey = f.path.toLowerCase();
    const priorPath = usedPaths.get(pathKey);
    if (priorPath && (priorPath.identity !== key || priorPath.sha256 !== f.sha256))
      add('CONFLICTING_PATH_IDENTITY');
    else usedPaths.set(pathKey, { identity: key, sha256: f.sha256 });
  };
  for (const source of m.sources) {
    const expected = win32.join(sourceDir, source.name);
    if (!same(source.pre.path, expected) || !same(source.post.path, expected) ||
        source.pre.sha256 !== source.post.sha256 || source.pre.size !== source.post.size ||
        source.pre.fileId !== source.post.fileId || source.pre.volumeId !== source.post.volumeId ||
        source.pre.capturedAtMs > i.startedAtMs || source.post.capturedAtMs < i.endedAtMs)
      add('SOURCE_INTEGRITY_UNPROVEN');
    register(source.pre); register(source.post);
  }
  for (const input of [t.cmd, t.vcvars, t.compiler, t.linker,
    ...t.sdkHeaders, ...t.sdkLibraries]) {
    if (!same(input.pre.path, input.post.path) || input.pre.sha256 !== input.post.sha256 ||
        input.pre.size !== input.post.size || input.pre.volumeId !== input.post.volumeId ||
        input.pre.fileId !== input.post.fileId || input.pre.capturedAtMs > i.startedAtMs ||
        input.post.capturedAtMs < i.endedAtMs) add('TOOLCHAIN_INPUT_INTEGRITY_UNPROVEN');
    register(input.pre); register(input.post);
  }
  for (const output of m.outputs) {
    if (!same(output.built.path, win32.join(buildDir, output.name)) ||
        !same(output.sealed.path, win32.join(sealedDir, output.name)) ||
        output.built.sha256 !== output.sealed.sha256 || output.built.size !== output.sealed.size ||
        output.built.capturedAtMs < i.endedAtMs ||
        output.sealed.capturedAtMs < output.built.capturedAtMs) add('OUTPUT_IDENTITY_UNPROVEN');
    register(output.built); register(output.sealed);
  }
  const exactResolution = (order: string[], inputs: Exp00InputEvidence[]): boolean => {
    const listed = order.map(p => p.toLowerCase());
    const sampled = inputs.map(input => input.pre.path.toLowerCase());
    return listed.length === sampled.length && new Set(listed).size === listed.length &&
      new Set(sampled).size === sampled.length && listed.every(p => sampled.includes(p));
  };
  if (!exactResolution(i.includeOrder, t.sdkHeaders) ||
      !exactResolution(i.libraryOrder, t.sdkLibraries))
    add('SDK_RESOLUTION_CONTRADICTORY');
  return problems;
}

/** Strict, pure local-consistency check. A forged complete record remains UNVERIFIED. */
export function assessExp00BuildProvenance(value: unknown): Exp00BuildProvenanceVerdict {
  let manifest: Exp00BuildManifest | null = null;
  let reasons: string[];
  try {
    manifest = parse(value);
    reasons = check(manifest);
  } catch (error) {
    reasons = [error instanceof Error ? error.message : 'MALFORMED_RECORD'];
  }
  const locallyConsistent = reasons.length === 0;
  return { status: locallyConsistent ? 'UNVERIFIED' : 'REJECTED', reasons,
    locallyConsistent, fileBytes: 'CALLER_SUPPLIED_UNVERIFIED', toolResolution: 'UNVERIFIED',
    independentlyVerified: false, experiment00: 'NO_GO', productionAuthorized: false,
    executable: false, manifest: locallyConsistent ? manifest : null };
}

/** Replay detection is local to this instance; it is not durable or independent authentication. */
export function createExp00BuildProvenanceCollector() {
  const recordIds = new Set<string>();
  return { accept(value: unknown): Exp00BuildProvenanceVerdict {
    const result = assessExp00BuildProvenance(value);
    if (!result.manifest) return result;
    const id = result.manifest.captured.recordId;
    if (recordIds.has(id)) return { ...result, status: 'REJECTED', reasons: ['REPLAYED_RECORD_ID'],
      locallyConsistent: false, manifest: null };
    recordIds.add(id);
    return result;
  } };
}

/** No file read is available until a separately reviewed trusted path/handle boundary exists. */
export async function captureExp00FileSnapshot(phase: Exp00SamplePhase): Promise<never> {
  if (phase !== 'PRE_BUILD' && phase !== 'POST_BUILD' && phase !== 'SEALED')
    throw new Error('INVALID_SNAPSHOT_PHASE');
  throw new Error('TRUSTED_PATH_HANDLE_BOUNDARY_UNAVAILABLE');
}
