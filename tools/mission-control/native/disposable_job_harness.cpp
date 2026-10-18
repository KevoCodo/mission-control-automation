// Opt-in, local-only disposable probe. No caller-controlled executable or command line.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <processthreadsapi.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>
#include "disposable_job_probe.cpp"

namespace {
using disposable_probe::Status;
int fail(const char* step, DWORD code) {
  std::fprintf(stderr, "result=FAIL_CLOSED step=%s win32=%lu\n", step,
    static_cast<unsigned long>(code));
  return 1;
}
Status closeHandle(HANDLE& handle) {
  if (!handle) return {"CloseHandle", ERROR_SUCCESS, true};
  HANDLE old = handle;
  handle = nullptr;
  if (!CloseHandle(old)) return {"CloseHandle", GetLastError(), false};
  return {"CloseHandle", ERROR_SUCCESS, true};
}
std::wstring fixturePath() {
  wchar_t path[MAX_PATH]{};
  DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return {};
  std::wstring name(path, n);
  auto slash = name.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return {};
  return name.substr(0, slash + 1) + L"disposable_fixture.exe";
}
}

int runExperiment() {
#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
  return fail("JOB_LIST_UNAVAILABLE_IN_SDK", ERROR_NOT_SUPPORTED);
#else
  const std::wstring fixture = fixturePath();
  if (fixture.empty()) return fail("FIXED_FIXTURE_PATH", ERROR_INVALID_NAME);
  DWORD attributes = GetFileAttributesW(fixture.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES)
    return fail("FIXED_FIXTURE_MISSING", GetLastError());
  if (attributes & FILE_ATTRIBUTE_DIRECTORY)
    return fail("FIXED_FIXTURE_NOT_FILE", ERROR_INVALID_DATA);
  if (attributes & FILE_ATTRIBUTE_REPARSE_POINT)
    return fail("FIXED_FIXTURE_REPARSE_POINT", ERROR_INVALID_DATA);

  disposable_probe::OwnedJob job;
  Status setup = job.create();
  if (!setup.ok) return fail(setup.api, setup.error);
  DWORD flags = 0;
  if (!GetHandleInformation(job.get(), &flags) || (flags & HANDLE_FLAG_INHERIT)) {
    DWORD error = GetLastError();
    Status close = job.close();
    if (!close.ok) return fail(close.api, close.error);
    return fail("JOB_HANDLE_INHERITANCE", error ? error : ERROR_INVALID_DATA);
  }

  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  if (!bytes) {
    DWORD error = GetLastError();
    Status close = job.close();
    return fail(close.ok ? "ATTRIBUTE_SIZE" : close.api, close.ok ? error : close.error);
  }
  std::vector<unsigned char> storage(bytes);
  auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(list, 1, 0, &bytes)) {
    DWORD error = GetLastError(); Status close = job.close();
    return fail(close.ok ? "InitializeProcThreadAttributeList" : close.api, close.ok ? error : close.error);
  }
  HANDLE assignedJob = job.get();
  bool updated = UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    &assignedJob, sizeof(assignedJob), nullptr, nullptr) != FALSE;
  DWORD updateError = updated ? ERROR_SUCCESS : GetLastError();
  if (!updated) {
    DeleteProcThreadAttributeList(list);
    Status close = job.close();
    return fail(close.ok ? "UpdateProcThreadAttribute" : close.api, close.ok ? updateError : close.error);
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = list;
  PROCESS_INFORMATION child{};
  // JOB_LIST assigns during creation. Suspension adds a query barrier; it is not
  // itself the containment guarantee. No handle inheritance or breakaway flag.
  BOOL created = CreateProcessW(fixture.c_str(), nullptr, nullptr, nullptr, FALSE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
    nullptr, nullptr, &startup.StartupInfo, &child);
  DWORD createError = created ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(list);
  if (!created) {
    Status close = job.close();
    return fail(close.ok ? "CreateProcessW_JOB_LIST_UNSUPPORTED_OR_FAILED" : close.api,
      close.ok ? createError : close.error);
  }

  BOOL member = FALSE;
  bool queried = IsProcessInJob(child.hProcess, job.get(), &member) != FALSE;
  DWORD queryError = queried ? ERROR_SUCCESS : GetLastError();
  bool canResume = queried && member;
  DWORD resumeResult = canResume ? ResumeThread(child.hThread) : static_cast<DWORD>(-1);
  DWORD resumeError = resumeResult == static_cast<DWORD>(-1) ? GetLastError() : ERROR_SUCCESS;
  bool running = canResume && resumeResult != static_cast<DWORD>(-1);
  DWORD waitResult = running ? WaitForSingleObject(child.hProcess, 5000) : WAIT_TIMEOUT;
  DWORD waitError = waitResult == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
  DWORD exitCode = STILL_ACTIVE;
  BOOL exitQueried = running && waitResult == WAIT_OBJECT_0 ?
    GetExitCodeProcess(child.hProcess, &exitCode) : FALSE;
  DWORD exitQueryError = running && waitResult == WAIT_OBJECT_0 && !exitQueried ?
    GetLastError() : ERROR_SUCCESS;
  bool observed = exitQueried && exitCode != STILL_ACTIVE;
  bool terminationRequested = false;
  if (!observed) {
    Status termination = job.terminate();
    terminationRequested = termination.ok;
    if (!termination.ok) std::fprintf(stderr, "cleanup_error=%s win32=%lu\n",
      termination.api, static_cast<unsigned long>(termination.error));
    DWORD cleanupWait = WaitForSingleObject(child.hProcess, 5000);
    if (cleanupWait != WAIT_OBJECT_0) std::fprintf(stderr,
      "cleanup_error=WAIT_FOR_EXIT value=%lu\n", static_cast<unsigned long>(cleanupWait));
  }
  Status threadClose = closeHandle(child.hThread);
  Status processClose = closeHandle(child.hProcess);
  Status jobClose = job.close();
  if (!threadClose.ok || !processClose.ok || !jobClose.ok)
    return fail(!threadClose.ok ? threadClose.api : !processClose.ok ? processClose.api : jobClose.api,
      !threadClose.ok ? threadClose.error : !processClose.ok ? processClose.error : jobClose.error);
  if (!canResume) return fail("IsProcessInJob", queried ? ERROR_INVALID_DATA : queryError);
  if (!running) return fail("ResumeThread", resumeError);
  if (exitQueryError) return fail("GetExitCodeProcess", exitQueryError);
  if (!observed) return fail("EXIT_UNVERIFIED", waitError ? waitError : ERROR_TIMEOUT);
  std::printf("result=LOCAL_DISPOSABLE_OBSERVATION pid=%lu exit=%lu job_member=1 termination_requested=%u\n",
    static_cast<unsigned long>(child.dwProcessId), static_cast<unsigned long>(exitCode),
    terminationRequested ? 1u : 0u);
  return exitCode == 0 ? 0 : fail("FIXTURE_EXIT_NONZERO", exitCode);
#endif
}

int wmain(int argc, wchar_t* argv[]) {
  if (argc != 2 || std::wcscmp(argv[1], L"--run-fixed-fixture") != 0)
    return fail("OPT_IN_REQUIRED", ERROR_ACCESS_DENIED);
#ifndef S2B2B2_RUNTIME_EXPERIMENT_ENABLED
  return fail("RUNTIME_EXPERIMENT_NOT_BUILT", ERROR_ACCESS_DENIED);
#else
  return runExperiment();
#endif
}
