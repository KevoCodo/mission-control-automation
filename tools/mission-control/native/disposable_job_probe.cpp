// S2B-2B1 source skeleton. No child creation, command input, or production adapter.
// Build manually with a reviewed Windows SDK compiler; never run from npm or CI.
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
      const DWORD error = GetLastError(); close();
      return {"SetInformationJobObject", error, false};
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION observed{};
    if (!QueryInformationJobObject(handle_, JobObjectExtendedLimitInformation,
        &observed, sizeof(observed), nullptr)) {
      const DWORD error = GetLastError(); close();
      return {"QueryInformationJobObject", error, false};
    }
    constexpr DWORD required = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    if ((observed.BasicLimitInformation.LimitFlags & required) != required ||
        observed.BasicLimitInformation.ActiveProcessLimit != 1) {
      close(); return {"QueryInformationJobObject", ERROR_INVALID_DATA, false};
    }
    return {"QueryInformationJobObject", ERROR_SUCCESS, true};
  }

  // Reserved for a fixed, suspended disposable fixture only after a separately reviewed
  // atomic creation strategy. This translation unit has no call site for assignment.
  Status assignSuspendedFixture(HANDLE process) noexcept {
    if (!handle_ || !process) return {"AssignProcessToJobObject", ERROR_INVALID_HANDLE, false};
    if (!AssignProcessToJobObject(handle_, process))
      return {"AssignProcessToJobObject", GetLastError(), false};
    BOOL member = FALSE;
    if (!IsProcessInJob(process, handle_, &member))
      return {"IsProcessInJob", GetLastError(), false};
    return {"IsProcessInJob", member ? ERROR_SUCCESS : ERROR_INVALID_DATA, member != FALSE};
  }

  Status terminate() noexcept {
    if (!handle_) return {"TerminateJobObject", ERROR_INVALID_HANDLE, false};
    if (!TerminateJobObject(handle_, 1)) return {"TerminateJobObject", GetLastError(), false};
    // Success means termination was requested, not that every process has exited.
    return {"TerminateJobObject", ERROR_SUCCESS, true};
  }

  void close() noexcept { if (handle_) { CloseHandle(handle_); handle_ = nullptr; } }

 private:
  HANDLE handle_ = nullptr;
};
}  // namespace disposable_probe
