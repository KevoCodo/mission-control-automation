// S2B-2B2 disposable Job Object owner. Included by the single-purpose harness.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <jobapi2.h>
#include <processthreadsapi.h>

namespace disposable_probe {
struct Status { const char* api; DWORD error; bool ok; };
class OwnedJob {
 public:
  OwnedJob() noexcept = default;
  OwnedJob(const OwnedJob&) = delete;
  OwnedJob& operator=(const OwnedJob&) = delete;
  ~OwnedJob() { close(); }

  Status create() noexcept {
    if (handle_) return {"CreateJobObjectW", ERROR_ALREADY_EXISTS, false};
    // Default security attributes prohibit inheritance of the controlling handle.
    handle_ = CreateJobObjectW(nullptr, nullptr);
    if (!handle_) return {"CreateJobObjectW", GetLastError(), false};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    if (!SetInformationJobObject(handle_, JobObjectExtendedLimitInformation,
        &limits, sizeof(limits))) {
      const DWORD error = GetLastError();
      Status cleanup = close();
      if (!cleanup.ok) return cleanup;
      return {"SetInformationJobObject", error, false};
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION observed{};
    if (!QueryInformationJobObject(handle_, JobObjectExtendedLimitInformation,
        &observed, sizeof(observed), nullptr)) {
      const DWORD error = GetLastError();
      Status cleanup = close();
      if (!cleanup.ok) return cleanup;
      return {"QueryInformationJobObject", error, false};
    }
    constexpr DWORD required = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    if ((observed.BasicLimitInformation.LimitFlags & required) != required ||
        observed.BasicLimitInformation.ActiveProcessLimit != 1) {
      Status cleanup = close();
      if (!cleanup.ok) return cleanup;
      return {"QueryInformationJobObject", ERROR_INVALID_DATA, false};
    }
    return {"QueryInformationJobObject", ERROR_SUCCESS, true};
  }

  Status terminate() noexcept {
    if (!handle_) return {"TerminateJobObject", ERROR_INVALID_HANDLE, false};
    if (!TerminateJobObject(handle_, 1)) return {"TerminateJobObject", GetLastError(), false};
    // Success means termination was requested, not that every process has exited.
    return {"TerminateJobObject", ERROR_SUCCESS, true};
  }

  HANDLE get() const noexcept { return handle_; }

  Status close() noexcept {
    if (!handle_) return {"CloseHandle", ERROR_SUCCESS, true};
    HANDLE handle = handle_;
    handle_ = nullptr;
    if (!CloseHandle(handle)) return {"CloseHandle", GetLastError(), false};
    return {"CloseHandle", ERROR_SUCCESS, true};
  }

 private:
  HANDLE handle_ = nullptr;
};
}  // namespace disposable_probe
