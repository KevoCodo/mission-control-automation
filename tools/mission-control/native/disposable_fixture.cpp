// Fixed repository-owned child. It only waits briefly and exits.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

int wmain(int argc, wchar_t*[]) {
  if (argc != 1) return 2;
  Sleep(250);
  return 0;
}
