import { describe, expect, it, vi } from 'vitest';
import { lstat, open } from 'node:fs/promises';
import { win32 } from 'node:path';
import { assessExp00BuildProvenance, captureExp00FileSnapshot, createExp00BuildProvenanceCollector,
  EXP00_BINARY_NAMES, EXP00_SOURCE_NAMES, type Exp00BuildManifest,
  type Exp00FileSample } from '../exp00BuildProvenance.js';
import { EXP00_DISPOSABLE_ROOT } from '../windowsHostReadiness.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(), open: vi.fn() };
});

const root = EXP00_DISPOSABLE_ROOT;
const sourceDir = win32.join(root, 'src', 'tools', 'mission-control', 'native');
const buildDir = win32.join(sourceDir, 'build');
const sealedDir = win32.join(root, 'run', 'sealed', 'default-deny');
const script = win32.join(sourceDir, 'build-disposable.ps1');
const vcvars = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';
const compileArguments = (source: string, output: string): string[] =>
  ['/nologo', '/W4', '/WX', '/EHsc', '/std:c++17', '/DUNICODE', '/D_UNICODE',
    `/Fe:${output}`, source, '/link', '/SUBSYSTEM:CONSOLE'];
const batchSegment = (source: string, output: string): string =>
  `cl /nologo /W4 /WX /EHsc /std:c++17 /DUNICODE /D_UNICODE /Fe:"${output}" "${source}" /link /SUBSYSTEM:CONSOLE`;
const hash = (letter: string) => letter.repeat(64);
const sample = (path: string, id: string, at: number, sha = hash('a')): Exp00FileSample =>
  ({ path, sha256: sha, size: 10, volumeId: 'volume-1', fileId: id, capturedAtMs: at });
const input = (path: string, id: string) =>
  ({ pre: sample(path, id, 110), post: sample(path, id, 410) });

function fixture(): Exp00BuildManifest {
  const fixtureSource = win32.join(sourceDir, 'disposable_fixture.cpp');
  const harnessSource = win32.join(sourceDir, 'disposable_job_harness.cpp');
  const fixtureOutput = win32.join(buildDir, 'disposable_fixture.exe');
  const harnessOutput = win32.join(buildDir, 'disposable_job_harness.exe');
  const batch = `call "${vcvars}" >nul && ` +
    batchSegment(fixtureSource, fixtureOutput) + ' && ' + batchSegment(harnessSource, harnessOutput);
  const sdkHeader = input('C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.19041.0\\um\\Windows.h', 'sdk-h');
  const sdkThreadHeader = input('C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.19041.0\\um\\processthreadsapi.h', 'sdk-t');
  const sdkJobHeader = input('C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.19041.0\\um\\jobapi2.h', 'sdk-j');
  const sdkLibrary = input('C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.19041.0\\um\\x64\\kernel32.lib', 'sdk-l');
  const tool = (path: string, id: string, event: string | null) =>
    ({ ...input(path, id), version: 'reviewed-version', processEventId: event });
  return {
    version: 1, experiment: 'GATE2B_EXP00_DEFAULT_DENY', sourceCommit: 'b'.repeat(40), root,
    captured: { startedAtMs: 100, endedAtMs: 500, recordId: 'fixture-record-1' },
    sources: EXP00_SOURCE_NAMES.map((name, index) => ({
      name, pre: sample(win32.join(sourceDir, name), `source-${index}`, 110),
      post: sample(win32.join(sourceDir, name), `source-${index}`, 410)
    })),
    toolchain: {
      cmd: tool('C:\\Windows\\System32\\cmd.exe', 'cmd', 'event-cmd'),
      vcvars: tool(vcvars, 'vcvars', null),
      compiler: tool('C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC\\14.29.30133\\bin\\Hostx64\\x64\\cl.exe', 'cl', 'event-cl'),
      linker: tool('C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC\\14.29.30133\\bin\\Hostx64\\x64\\link.exe', 'link', 'event-link'),
      sdkVersion: '10.0.19041.0', sdkHeaders: [sdkHeader, sdkThreadHeader, sdkJobHeader], sdkLibraries: [sdkLibrary]
    },
    invocation: {
      script,
      scriptHost: { executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        arguments: ['-NoProfile', '-NonInteractive', '-File', script] },
      cmdHost: { executable: 'C:\\Windows\\System32\\cmd.exe', arguments: ['/d', '/s', '/c', batch] },
      compilerCommands: [
        { executable: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC\\14.29.30133\\bin\\Hostx64\\x64\\cl.exe',
          arguments: compileArguments(fixtureSource, fixtureOutput) },
        { executable: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC\\14.29.30133\\bin\\Hostx64\\x64\\cl.exe',
          arguments: compileArguments(harnessSource, harnessOutput) }
      ],
      linkerCommands: [
        { executable: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC\\14.29.30133\\bin\\Hostx64\\x64\\link.exe',
          arguments: ['/NOLOGO', `/OUT:${fixtureOutput}`, win32.join(buildDir, 'disposable_fixture.obj'), '/SUBSYSTEM:CONSOLE'] },
        { executable: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC\\14.29.30133\\bin\\Hostx64\\x64\\link.exe',
          arguments: ['/NOLOGO', `/OUT:${harnessOutput}`, win32.join(buildDir, 'disposable_job_harness.obj'), '/SUBSYSTEM:CONSOLE'] }
      ],
      workingDirectory: buildDir, startedAtMs: 200, endedAtMs: 400,
      environment: { PATH: 'C:\\Windows\\System32', INCLUDE: 'C:\\SDK\\Include',
        LIB: 'C:\\SDK\\Lib', WindowsSdkDir: 'C:\\Program Files (x86)\\Windows Kits\\10',
        VCToolsInstallDir: 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC\\14.29.30133',
        CL: '', _CL_: '', LINK: '', _LINK_: '' },
      responseFiles: [], includeOrder: [sdkHeader.pre.path, sdkThreadHeader.pre.path, sdkJobHeader.pre.path],
      libraryOrder: [sdkLibrary.pre.path],
      processTraceSha256: hash('c')
    },
    outputs: EXP00_BINARY_NAMES.map((name, index) => ({ name,
      built: sample(win32.join(buildDir, name), `built-${index}`, 420, hash('d')),
      sealed: sample(win32.join(sealedDir, name), `sealed-${index}`, 450, hash('d')) }))
  };
}

describe('Experiment 00 build-provenance record', () => {
  it('rejects an invalid snapshot phase before any file read', async () => {
    await expect(captureExp00FileSnapshot('BUILD_AND_RUN' as never)).rejects.toThrow('INVALID_SNAPSHOT_PHASE');
  });
  it('keeps every snapshot phase closed with unresolved reparse ancestors and opens no file', async () => {
    for (const phase of ['PRE_BUILD', 'POST_BUILD', 'SEALED'] as const)
      await expect(captureExp00FileSnapshot(phase)).rejects.toThrow('TRUSTED_PATH_HANDLE_BOUNDARY_UNAVAILABLE');
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it('keeps a complete but caller-supplied record unverified and non-executable', () => {
    const result = assessExp00BuildProvenance(fixture());
    expect(result).toMatchObject({ status: 'UNVERIFIED', locallyConsistent: true,
      independentlyVerified: false, toolResolution: 'UNVERIFIED',
      experiment00: 'NO_GO', productionAuthorized: false, executable: false });
    expect(result.manifest?.sources).toHaveLength(4);
  });
  it('rejects missing and duplicate allowlisted sources', () => {
    const missing = fixture(); missing.sources.pop();
    expect(assessExp00BuildProvenance(missing).status).toBe('REJECTED');
    const duplicate = fixture(); duplicate.sources[1] = duplicate.sources[0]!;
    expect(assessExp00BuildProvenance(duplicate).status).toBe('REJECTED');
  });
  it('rejects changed source bytes or file identity after compilation', () => {
    const changed = fixture(); changed.sources[0]!.post.sha256 = hash('e');
    expect(assessExp00BuildProvenance(changed).reasons).toContain('SOURCE_INTEGRITY_UNPROVEN');
    const swapped = fixture(); swapped.sources[0]!.post.fileId = 'swapped';
    expect(assessExp00BuildProvenance(swapped).status).toBe('REJECTED');
  });
  it('rejects wrong linker resolution and missing process attribution', () => {
    const wrong = fixture(); wrong.toolchain.linker.pre.path = wrong.toolchain.compiler.pre.path;
    expect(assessExp00BuildProvenance(wrong).reasons).toContain('TOOL_RESOLUTION_UNPROVEN');
    const absent = fixture(); absent.toolchain.linker.processEventId = null;
    expect(assessExp00BuildProvenance(absent).status).toBe('REJECTED');
    const changed = fixture(); changed.toolchain.linker.post.sha256 = hash('e');
    expect(assessExp00BuildProvenance(changed).reasons).toContain('TOOLCHAIN_INPUT_INTEGRITY_UNPROVEN');
  });
  it('rejects incomplete SDK inputs and contradictory resolution order', () => {
    const missing = fixture(); missing.toolchain.sdkLibraries = [];
    expect(assessExp00BuildProvenance(missing).status).toBe('REJECTED');
    const omittedDirectHeader = fixture(); omittedDirectHeader.toolchain.sdkHeaders.pop();
    expect(assessExp00BuildProvenance(omittedDirectHeader).reasons).toContain('WRONG_SDK_INPUT');
    const wrong = fixture(); wrong.invocation.includeOrder = ['C:\\other.h'];
    expect(assessExp00BuildProvenance(wrong).reasons).toContain('SDK_RESOLUTION_CONTRADICTORY');
    const omittedSample = fixture(); omittedSample.invocation.includeOrder.pop();
    expect(assessExp00BuildProvenance(omittedSample).reasons).toContain('SDK_RESOLUTION_CONTRADICTORY');
    const omittedLibrary = fixture(); omittedLibrary.invocation.libraryOrder = [];
    expect(assessExp00BuildProvenance(omittedLibrary).status).toBe('REJECTED');
    const duplicate = fixture(); duplicate.invocation.includeOrder[1] = duplicate.invocation.includeOrder[0]!;
    expect(assessExp00BuildProvenance(duplicate).reasons).toContain('SDK_RESOLUTION_CONTRADICTORY');
  });
  it('rejects unrelated or mismatched structured build commands', () => {
    const wrapper = fixture(); wrapper.invocation.scriptHost.executable = 'C:\\other\\powershell.exe';
    expect(assessExp00BuildProvenance(wrapper).reasons).toContain('UNRECOGNIZED_BUILD_INVOCATION');
    const shell = fixture(); shell.invocation.cmdHost.arguments[0] = '/q';
    expect(assessExp00BuildProvenance(shell).reasons).toContain('UNRECOGNIZED_BUILD_INVOCATION');
    const unrelated = fixture(); unrelated.invocation.cmdHost.arguments[3] = 'echo unrelated';
    expect(assessExp00BuildProvenance(unrelated).reasons).toContain('UNRECOGNIZED_BUILD_INVOCATION');
    const extraCompilerArg = fixture(); extraCompilerArg.invocation.compilerCommands[0]!.arguments.push('/DUNREVIEWED');
    expect(assessExp00BuildProvenance(extraCompilerArg).reasons).toContain('UNRECOGNIZED_BUILD_INVOCATION');
    const unrelatedLinker = fixture(); unrelatedLinker.invocation.linkerCommands[1]!.executable = 'C:\\other\\link.exe';
    expect(assessExp00BuildProvenance(unrelatedLinker).reasons).toContain('UNRECOGNIZED_BUILD_INVOCATION');
    const linkerArg = fixture(); linkerArg.invocation.linkerCommands[0]!.arguments[1] = '/OUT:C:\\other.exe';
    expect(assessExp00BuildProvenance(linkerArg).reasons).toContain('UNRECOGNIZED_BUILD_INVOCATION');
    const swappedSource = fixture(); swappedSource.invocation.compilerCommands[0]!.arguments[8] =
      win32.join(sourceDir, 'disposable_job_harness.cpp');
    expect(assessExp00BuildProvenance(swappedSource).reasons).toContain('UNRECOGNIZED_BUILD_INVOCATION');
  });
  it('rejects runtime-enabled commands, concealed response files and wrong output hashes', () => {
    const enabled = fixture(); enabled.invocation.cmdHost.arguments[3] += ' -EnableRuntimeExperiment';
    expect(assessExp00BuildProvenance(enabled).reasons).toContain('RUNTIME_BUILD_FORBIDDEN');
    const envEnabled = fixture(); envEnabled.invocation.environment.CL = '/DS2B2B2_RUNTIME_EXPERIMENT_ENABLED';
    expect(assessExp00BuildProvenance(envEnabled).reasons).toContain('RUNTIME_BUILD_FORBIDDEN');
    const response = fixture(); response.invocation.responseFiles = ['C:\\hidden.rsp'];
    expect(assessExp00BuildProvenance(response).reasons).toContain('RESPONSE_FILE_CONTENTS_UNVERIFIED');
    const hidden = fixture(); hidden.invocation.compilerCommands[0]!.arguments.push('@C:\\hidden.rsp');
    expect(assessExp00BuildProvenance(hidden).reasons).toContain('RESPONSE_FILE_CONTENTS_UNVERIFIED');
    const hiddenLinker = fixture(); hiddenLinker.invocation.linkerCommands[0]!.arguments.push('@C:\\hidden.rsp');
    expect(assessExp00BuildProvenance(hiddenLinker).reasons).toContain('RESPONSE_FILE_CONTENTS_UNVERIFIED');
    const hiddenShell = fixture(); hiddenShell.invocation.cmdHost.arguments[3] += ' @hidden.rsp';
    expect(assessExp00BuildProvenance(hiddenShell).reasons).toContain('RESPONSE_FILE_CONTENTS_UNVERIFIED');
    const output = fixture(); output.outputs[0]!.sealed.sha256 = hash('e');
    expect(assessExp00BuildProvenance(output).reasons).toContain('OUTPUT_IDENTITY_UNPROVEN');
  });
  it('rejects contradictory timestamps and aliased file identities', () => {
    const time = fixture(); time.sources[0]!.post.capturedAtMs = 300;
    expect(assessExp00BuildProvenance(time).status).toBe('REJECTED');
    const alias = fixture(); alias.toolchain.linker.pre.fileId = alias.toolchain.compiler.pre.fileId;
    expect(assessExp00BuildProvenance(alias).reasons).toContain('CONFLICTING_FILE_IDENTITY');
    const eventAlias = fixture(); eventAlias.toolchain.linker.processEventId = eventAlias.toolchain.compiler.processEventId;
    expect(assessExp00BuildProvenance(eventAlias).reasons).toContain('DUPLICATE_TOOL_PROCESS_ID');
    const pathAlias = fixture(); pathAlias.toolchain.sdkHeaders.push({
      pre: { ...pathAlias.toolchain.sdkHeaders[0]!.pre, fileId: 'replacement' },
      post: { ...pathAlias.toolchain.sdkHeaders[0]!.post, fileId: 'replacement' }
    });
    expect(assessExp00BuildProvenance(pathAlias).reasons).toContain('CONFLICTING_PATH_IDENTITY');
  });
  it('rejects a repeated record in one collector instance without claiming durable replay protection', () => {
    const collector = createExp00BuildProvenanceCollector();
    expect(collector.accept(fixture()).status).toBe('UNVERIFIED');
    expect(collector.accept(fixture()).reasons).toContain('REPLAYED_RECORD_ID');
    expect(createExp00BuildProvenanceCollector().accept(fixture()).status).toBe('UNVERIFIED');
  });
  it('rejects malformed nested values, inherited records and accessors', () => {
    const malformed = fixture() as unknown as Record<string, unknown>;
    malformed.claimedVerified = true;
    expect(assessExp00BuildProvenance(malformed).status).toBe('REJECTED');
    expect(assessExp00BuildProvenance(Object.assign(Object.create({ inherited: true }), fixture())).status).toBe('REJECTED');
    const hostile = fixture();
    Object.defineProperty(hostile.sources[0], 'pre', { get() { throw new Error('GETTER_CALLED'); } });
    expect(assessExp00BuildProvenance(hostile).reasons).toEqual(['MALFORMED_RECORD']);
    const sparse = fixture(); delete sparse.sources[0];
    expect(assessExp00BuildProvenance(sparse).status).toBe('REJECTED');
    const missingFileId = fixture(); missingFileId.sources[0]!.pre.fileId = '0';
    expect(assessExp00BuildProvenance(missingFileId).reasons).toEqual(['UNAVAILABLE_FILE_ID']);
  });
});
