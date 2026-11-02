// BLACKICE native Workbench renderer. One child viewport, one decoded surface,
// and one input owner. No stock Windows FreeRDP client or host input injection.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <windowsx.h>
#include <tlhelp32.h>
#include <wincrypt.h>
#include <shobjidl.h>
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/settings.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>
#include <freerdp/input.h>
#include <freerdp/error.h>
#include <freerdp/transport_io.h>
#include <freerdp/event.h>
#include <winpr/wlog.h>
#include <winpr/custom-crypto.h>
#include <cjson/cJSON.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <climits>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <set>
#include <string>
#include <vector>
#include <functional>

namespace {
constexpr UINT REQUEST = WM_APP + 1, FRAME = WM_APP + 2, FINISHED = WM_APP + 3, PARENT_CLOSED = WM_APP + 4, PRESENT = WM_APP + 5;
constexpr size_t MAX_LINE = 65536, MAX_PIXELS = 4096u * 4096u;
struct Input { enum Kind { Mouse, Key, Release, ReleaseMouse } kind; UINT16 flags, x, y; UINT8 code; UINT64 releaseEpoch = 0; };
struct PaintingClip { HWND hwnd, parent; DWORD pid; LONG_PTR added; HANDLE process; };
struct PaintBuffer { HDC dc = nullptr; HBITMAP bitmap = nullptr; HGDIOBJ original = nullptr; void* bits = nullptr; LONG width = 0, height = 0; UINT64 sequence = 0; LONG sourceHeight = 0; bool valid = false; };
enum WorkbenchControl { ControlOwner = 4101, ControlWake, ControlPower, ControlClipboard, ControlFit, ControlBlackice, ControlStatus };
struct State {
  HWND control = nullptr, child = nullptr, parent = nullptr, ownedParent = nullptr;
  HWND launcherAnchor = nullptr;
  HANDLE launcherProcess = nullptr;
  DWORD launcherPid = 0;
  bool detached = false;
  UINT64 windowCloseRevision = 0;
  UINT64 viewportRevision = 0;
  LONG viewportWidth = 0, viewportHeight = 0;
  bool clipboardEnabled = false, suppressPasteKeyUp = false;
  UINT32 pasteRevision = 0, pendingPaste = 0, copyRevision = 0;
  UINT64 clipboardEpoch = 0, pasteEpoch = 0, pasteStartedAt = 0;
  UINT64 copyAt = 0;
  bool pasteRightControl = false;
  UINT32 clipboardTimeouts = 0;
  std::wstring windowTitle;
  HWINEVENTHOOK parentHook = nullptr, presentationHook = nullptr;
  DWORD parentPid = 0;
  HANDLE parentProcess = nullptr;
  std::vector<PaintingClip> paintingClips;
  UINT64 paintCount = 0, successfulPaints = 0, emptyClipPaints = 0, failedPaints = 0, paintedSequence = 0, lastPaintAt = 0, siblingRaiseCount = 0, printCount = 0;
  int lastStretchScanlines = 0, lastClipComplexity = ERROR;
  DWORD lastPaintError = 0, presentationError = 0;
  RECT lastPaintClip{};
  bool hostPaintingProtected = false;
  PaintBuffer presented, composing;
  HICON iconLarge = nullptr, iconSmall = nullptr;
  HWND ownerButton = nullptr, wakeButton = nullptr, powerButton = nullptr, clipboardButton = nullptr, fitButton = nullptr, blackiceButton = nullptr, controlsStatus = nullptr;
  HFONT controlsFont = nullptr; HBRUSH controlsBrush = nullptr;
  bool controlsEnabled = false, controlsBusy = false, controlsClipboard = true, controlsFit = true;
  std::string controlsPower = "unknown", controlsMessage;
  UINT32 controlSequence = 0;
  LONG controlsHeight = 0;
  UINT64 presentationBlits = 0, preservedPaints = 0;
  std::function<void()> beforePresentationProbe;
  bool presentationProbe = false;
  std::atomic<UINT64> probeProduced{0};
  UINT16 capturedButtons = 0;
  HANDLE stop = nullptr, worker = nullptr, inputReady = nullptr, releaseDone = nullptr;
  std::atomic<bool> connected{false}, userInput{false}, stopping{false};
  std::atomic<UINT32> coreError{0};
  std::atomic<UINT32> nlaRequests{0}, deniedAuthRequests{0};
  std::atomic<UINT32> selectedProtocol{0};
  std::atomic<UINT32> refreshRequests{0};
  std::atomic<int> connectionState{CONNECTION_STATE_INITIAL};
  std::atomic<UINT32> stateChanges{0}, preConnectCalls{0}, postConnectCalls{0};
  std::atomic<UINT64> readCalls{0}, readCompletions{0}, readBytes{0}, writeCalls{0}, writeCompletions{0}, writeBytes{0}, lastReadAt{0}, lastWriteAt{0};
  std::atomic<bool> tlsStarted{false}, tlsFinished{false};
  rdpTransportIo originalIo{};
  std::mutex frameMutex, instanceMutex, outputMutex;
  std::timed_mutex inputMutex;
  std::atomic<bool> ownershipTransition{false}, releaseFailed{false};
  std::atomic<UINT64> releasedEpoch{0};
  UINT64 nextReleaseEpoch = 0;
  freerdp* instance = nullptr;
  std::vector<BYTE> pixels;
  UINT32 width = 0, height = 0, stride = 0;
  UINT64 sequence = 0, frameAt = 0, firstFrameAt = 0;
  std::atomic<UINT64> inputSequence{0};
  std::deque<Input> inputs;
  std::set<UINT16> heldKeys;
  UINT16 heldMouse = 0;
  UINT16 lastMouseX = 0, lastMouseY = 0;
  bool lastMouseKnown = false;
  UINT64 wakeRequests = 0;
  std::string fingerprint, connectRequest, closeRequest, vmId, authenticationServer;
  UINT64 deadline = 0, closeDeadline = 0;
  bool visible = false, closing = false;
  std::atomic<bool> certVerified{false};
  bool selfTest = false, allowTestParent = false;
  bool digestReady = false;
  bool perMonitorV2 = false;
  HWND foregroundBefore = nullptr, foregroundLast = nullptr;
  UINT64 foregroundChangeCount = 0;
  UINT64 helperForegroundChangeCount = 0;
} state;
void stopConnection();

std::wstring wide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), (int)s.size(), nullptr, 0);
  if (!n) return {};
  std::wstring r(n, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), (int)s.size(), r.data(), n);
  return r;
}
std::string utf8(const std::wstring& s) {
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0, nullptr, nullptr);
  std::string r(n, '\0');
  if (n) WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), r.data(), n, nullptr, nullptr);
  return r;
}
const cJSON* get(const cJSON* o, const char* key) { return cJSON_GetObjectItemCaseSensitive(o, key); }
std::string str(const cJSON* o, const char* key) {
  const cJSON* v = get(o, key); return cJSON_IsString(v) && v->valuestring ? v->valuestring : "";
}
bool integer(const cJSON* o, const char* key, int minimum, int maximum, int& out, int fallback) {
  const cJSON* v = get(o, key);
  if (!v) { out = fallback; return true; }
  if (!cJSON_IsNumber(v) || v->valuedouble != v->valueint || v->valueint < minimum || v->valueint > maximum) return false;
  out = v->valueint; return true;
}
void boolean(cJSON* o, const char* key, bool v) { cJSON_AddBoolToObject(o, key, v); }
void reply(const std::string& id, cJSON* result, const char* code = nullptr, const char* error = nullptr) {
  cJSON* o = cJSON_CreateObject(); cJSON_AddStringToObject(o, "requestId", id.c_str());
  boolean(o, "ok", !code);
  if (code) { cJSON_AddStringToObject(o, "code", code); cJSON_AddStringToObject(o, "error", error ? error : "Native operation failed."); }
  if (result) cJSON_AddItemToObject(o, "result", result);
  char* json = cJSON_PrintUnformatted(o);
  { std::lock_guard<std::mutex> guard(state.outputMutex); if (json) { std::fputs(json, stdout); std::fputc('\n', stdout); std::fflush(stdout); } }
  cJSON_free(json); cJSON_Delete(o);
}
std::string normalizedFingerprint(const std::string& s) {
  std::string r;
  for (unsigned char ch : s) {
    if (ch == ':') continue;
    if (ch >= 'A' && ch <= 'F') ch += 'a' - 'A';
    if (!((ch >= 'a' && ch <= 'f') || (ch >= '0' && ch <= '9'))) return {};
    r.push_back((char)ch);
  }
  return r.size() == 64 ? r : "";
}
std::string sha256(const BYTE* data, size_t size) {
  BYTE hash[32]; DWORD length = sizeof(hash);
  if (size > MAXDWORD || !CryptHashCertificate2(L"SHA256", 0, nullptr, data, (DWORD)size, hash, &length) || length != 32) return {};
  static const char hex[] = "0123456789abcdef"; std::string r;
  for (BYTE b : hash) { r.push_back(hex[b >> 4]); r.push_back(hex[b & 15]); }
  return r;
}
bool digestPreflight() {
  const BYTE expected[16] = {0x31,0xd6,0xcf,0xe0,0xd1,0x6a,0xe9,0x31,0xb7,0x3c,0x59,0xd7,0xe0,0xc0,0x89,0xc0};
  BYTE observed[16]{};
  return winpr_Digest(WINPR_MD_MD4, "", 0, observed, sizeof(observed)) && !std::memcmp(expected, observed, sizeof(expected));
}
DWORD processParent(DWORD pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); DWORD parent = 0;
  if (Process32FirstW(snapshot, &entry)) do { if (entry.th32ProcessID == pid) { parent = entry.th32ParentProcessID; break; } } while (Process32NextW(snapshot, &entry));
  CloseHandle(snapshot); return parent;
}
bool processAlive(HANDLE process) { return process && WaitForSingleObject(process, 0) == WAIT_TIMEOUT; }
bool verifiedParent() {
  DWORD pid = 0; GetWindowThreadProcessId(state.parent, &pid);
  return state.parent && IsWindow(state.parent) && pid == state.parentPid && processAlive(state.parentProcess) &&
    (!state.detached || processAlive(state.launcherProcess));
}
bool ownedRenderProcess(DWORD pid) {
  if (pid == state.parentPid || (pid == GetCurrentProcessId() && state.ownedParent == state.parent)) return true;
  for (const auto& clip : state.paintingClips) if (clip.pid == pid && processAlive(clip.process)) return true;
  // Chromium renders direct children in its own descendant GPU process. Never
  // alter a reparented window belonging to an unrelated desktop application.
  for (unsigned depth = 0; pid && depth < 16; depth++) { pid = processParent(pid); if (pid == state.parentPid) return true; }
  return false;
}
bool sameClipWindow(const PaintingClip& clip) {
  DWORD pid = 0; GetWindowThreadProcessId(clip.hwnd, &pid);
  return processAlive(clip.process) && IsWindow(clip.hwnd) && pid == clip.pid && GetParent(clip.hwnd) == clip.parent;
}
bool addPaintingClip(HWND hwnd, LONG_PTR flags) {
  DWORD pid = 0; GetWindowThreadProcessId(hwnd, &pid);
  if (!verifiedParent() || !IsWindow(hwnd) || !ownedRenderProcess(pid) || (hwnd != state.parent && GetParent(hwnd) != state.parent)) return false;
  LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE), added = flags & ~style;
  if (!added) return true;
  auto saved = std::find_if(state.paintingClips.begin(), state.paintingClips.end(), [hwnd](const PaintingClip& clip) { return clip.hwnd == hwnd && sameClipWindow(clip); });
  HANDLE process = nullptr;
  if (saved == state.paintingClips.end()) {
    if (state.paintingClips.size() >= 128) return false;
    process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!processAlive(process)) { if (process) CloseHandle(process); return false; }
  }
  SetLastError(0); LONG_PTR previous = SetWindowLongPtrW(hwnd, GWL_STYLE, style | flags); DWORD error = GetLastError();
  if ((!previous && error) || (GetWindowLongPtrW(hwnd, GWL_STYLE) & flags) != flags) {
    state.presentationError = error ? error : ERROR_INVALID_STATE; if (process) CloseHandle(process); return false;
  }
  if (saved == state.paintingClips.end()) state.paintingClips.push_back({hwnd, GetParent(hwnd), pid, added, process});
  else saved->added |= added;
  return true;
}
void restoreHostPainting() {
  for (auto& clip : state.paintingClips) {
    if (sameClipWindow(clip)) {
      LONG_PTR style = GetWindowLongPtrW(clip.hwnd, GWL_STYLE);
      SetWindowLongPtrW(clip.hwnd, GWL_STYLE, style & ~clip.added);
      InvalidateRect(clip.hwnd, nullptr, FALSE);
    }
    if (clip.process) CloseHandle(clip.process);
  }
  state.paintingClips.clear(); state.hostPaintingProtected = false;
}
bool maintainPresentation() {
  DWORD childPid = 0; GetWindowThreadProcessId(state.child, &childPid);
  if (!state.visible || !verifiedParent() || !IsWindow(state.child) || childPid != GetCurrentProcessId() ||
      GetParent(state.child) != state.parent || !(GetWindowLongPtrW(state.child, GWL_STYLE) & WS_CHILD)) return false;
  if (state.detached) {
    // Our own top-level root has one native child and no Chromium compositor.
    // Never lease or alter any BLACKICE launcher/sibling window styles here.
    state.hostPaintingProtected = (GetWindowLongPtrW(state.parent, GWL_STYLE) & WS_CLIPCHILDREN) != 0;
    return state.hostPaintingProtected;
  }
  bool protectedPainting = addPaintingClip(state.parent, WS_CLIPCHILDREN);
  RECT childRect{}; GetWindowRect(state.child, &childRect);
  unsigned siblings = 0;
  for (HWND sibling = GetWindow(state.parent, GW_CHILD); sibling && siblings++ < 128; sibling = GetWindow(sibling, GW_HWNDNEXT)) {
    if (sibling == state.child || !(GetWindowLongPtrW(sibling, GWL_STYLE) & WS_VISIBLE)) continue;
    DWORD pid = 0; GetWindowThreadProcessId(sibling, &pid);
    RECT rect{}, intersection{}; GetWindowRect(sibling, &rect);
    if (ownedRenderProcess(pid) && IntersectRect(&intersection, &childRect, &rect))
      protectedPainting = addPaintingClip(sibling, WS_CLIPSIBLINGS) && protectedPainting;
  }
  state.hostPaintingProtected = protectedPainting;
  // HWND_TOP changes ONLY this verified WS_CHILD's sibling order. It never
  // raises the Electron root among desktop windows and never activates focus.
  if (GetWindow(state.parent, GW_CHILD) != state.child) {
    if (!SetWindowPos(state.child, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)) {
      state.presentationError = GetLastError(); return false;
    }
    state.siblingRaiseCount++; InvalidateRect(state.child, nullptr, FALSE);
  }
  return protectedPainting;
}
cJSON* surface() {
  std::lock_guard<std::mutex> guard(state.frameMutex);
  cJSON* o = cJSON_CreateObject();
  cJSON_AddNumberToObject(o, "sequence", (double)state.sequence);
  cJSON_AddNumberToObject(o, "width", state.width); cJSON_AddNumberToObject(o, "height", state.height);
  cJSON_AddNumberToObject(o, "stride", state.stride); cJSON_AddStringToObject(o, "format", "BGRA32");
  cJSON_AddNumberToObject(o, "frameAtMonotonicMs", (double)state.frameAt);
  cJSON_AddNumberToObject(o, "firstFrameAtMonotonicMs", (double)state.firstFrameAt);
  return o;
}
cJSON* frameHealth() {
  std::lock_guard<std::mutex> guard(state.frameMutex);
  cJSON* o = cJSON_CreateObject(); bool available = !state.pixels.empty() && state.width && state.height && state.sequence;
  boolean(o, "available", available); cJSON_AddNumberToObject(o, "sequence", (double)state.sequence);
  if (!available) { cJSON_AddNullToObject(o, "dark"); cJSON_AddStringToObject(o, "classification", "unknown"); return o; }
  unsigned black = 0, total = 0; std::set<UINT32> colors;
  for (UINT32 row = 0; row < 16; row++) for (UINT32 column = 0; column < 16; column++) {
    UINT32 x = std::min(state.width - 1, (2 * column + 1) * state.width / 32), y = std::min(state.height - 1, (2 * row + 1) * state.height / 32);
    const BYTE* p = state.pixels.data() + (size_t)y * state.stride + x * 4;
    if (std::max({p[0], p[1], p[2]}) < 16) black++;
    colors.insert((UINT32)p[0] | ((UINT32)p[1] << 8) | ((UINT32)p[2] << 16)); total++;
  }
  bool dark = black * 100 >= total * 98;
  boolean(o, "dark", dark); cJSON_AddStringToObject(o, "classification", dark ? "dark" : "not-dark");
  cJSON_AddNumberToObject(o, "sampledPixels", total); cJSON_AddNumberToObject(o, "blackFraction", (double)black / total);
  cJSON_AddNumberToObject(o, "distinctColors", (double)colors.size());
  cJSON_AddNumberToObject(o, "frameAgeMs", (double)(GetTickCount64() - state.frameAt));
  cJSON_AddStringToObject(o, "meaning", "decoded-display-sample-not-vm-power-state"); return o;
}
void updateDetachedTitle() {
  if (!state.detached || !IsWindow(state.ownedParent)) return;
  if (state.presentationProbe) { SetWindowTextW(state.ownedParent, L"BLACKICE display check"); return; }
  std::wstring title = L"BLACKICE Agentic Workbench — "; title += state.userInput ? L"You control" : L"Agent controls";
  if (!state.connected) title += state.worker ? L" — Connecting" : L" — Disconnected";
  else {
    cJSON* health = frameHealth(); const cJSON* colors = get(health, "distinctColors");
    if (cJSON_IsTrue(get(health, "dark"))) title += L" — Display dark; Wake display";
    else if (!cJSON_IsTrue(get(health, "available")) || (cJSON_IsNumber(colors) && colors->valueint <= 4)) title += L" — Display blank; Wake display";
    else title += L" — Connected";
    cJSON_Delete(health);
  }
  if (title != state.windowTitle) { state.windowTitle = title; SetWindowTextW(state.ownedParent, title.c_str()); }
}
void controlText(HWND hwnd, const std::wstring& value) {
  if (!IsWindow(hwnd)) return; wchar_t previous[512]{}; GetWindowTextW(hwnd, previous, 512);
  if (value != previous) SetWindowTextW(hwnd, value.c_str());
}
void controlEnable(HWND hwnd, bool enabled) { if (IsWindow(hwnd) && !!IsWindowEnabled(hwnd) != enabled) EnableWindow(hwnd, enabled); }
void updateWorkbenchControls() {
  if (!IsWindow(state.controlsStatus)) return;
  std::wstring text = state.userInput ? L"You control" : L"Agent controls";
  text += state.connected ? L" · Connected" : state.controlsPower == "off" ? L" · Windows is shut down" : L" · Disconnected";
  if (!state.controlsMessage.empty()) text += L" — " + wide(state.controlsMessage);
  controlText(state.controlsStatus, text); controlText(state.ownerButton, state.userInput ? L"Cede control" : L"Take control");
  controlText(state.powerButton, state.controlsPower == "off" ? L"Start VM" : L"Shut down");
  bool enabled = state.controlsEnabled && !state.controlsBusy && !state.closing;
  controlEnable(state.ownerButton, enabled && state.connected && !state.ownershipTransition);
  controlEnable(state.wakeButton, enabled && state.connected && !state.ownershipTransition);
  controlEnable(state.powerButton, enabled && (state.controlsPower == "running" || state.controlsPower == "off"));
  controlEnable(state.clipboardButton, enabled && state.connected && state.userInput);
  controlEnable(state.fitButton, enabled && state.connected && state.userInput);
  controlEnable(state.blackiceButton, state.controlsEnabled && !state.closing);
  if (SendMessageW(state.clipboardButton, BM_GETCHECK, 0, 0) != (state.controlsClipboard ? BST_CHECKED : BST_UNCHECKED))
    SendMessageW(state.clipboardButton, BM_SETCHECK, state.controlsClipboard ? BST_CHECKED : BST_UNCHECKED, 0);
  if (SendMessageW(state.fitButton, BM_GETCHECK, 0, 0) != (state.controlsFit ? BST_CHECKED : BST_UNCHECKED))
    SendMessageW(state.fitButton, BM_SETCHECK, state.controlsFit ? BST_CHECKED : BST_UNCHECKED, 0);
}
void layoutWorkbenchControls(HWND root) {
  if (!IsWindow(state.controlsStatus)) { state.controlsHeight = 0; return; }
  RECT client{}; GetClientRect(root, &client); UINT dpi = GetDpiForWindow(root); if (!dpi) dpi = 96;
  auto px = [dpi](int value) { return MulDiv(value, dpi, 96); };
  bool narrow = client.right < px(690); state.controlsHeight = px(narrow ? 112 : 78);
  auto move = [&](HWND hwnd, int x, int y, int w, int h) { SetWindowPos(hwnd, nullptr, px(x), px(y), px(w), px(h), SWP_NOZORDER | SWP_NOACTIVATE); };
  int width = MulDiv(client.right, 96, dpi);
  move(state.controlsStatus, 12, 12, std::max(80, width - 154), 22); move(state.blackiceButton, std::max(12, width - 126), 7, 114, 28);
  move(state.ownerButton, 12, 40, 112, 28); move(state.wakeButton, 132, 40, 112, 28); move(state.powerButton, 252, 40, 104, 28);
  move(state.clipboardButton, narrow ? 12 : 372, narrow ? 77 : 40, 142, 28);
  move(state.fitButton, narrow ? 166 : 526, narrow ? 77 : 40, 142, 28);
  RECT strip{0,0,client.right,state.controlsHeight}; InvalidateRect(root, &strip, FALSE);
}
void createWorkbenchControls(HWND root) {
  if (state.presentationProbe) return;
  state.controlsBrush = CreateSolidBrush(RGB(246,248,252)); UINT dpi = GetDpiForWindow(root); if (!dpi) dpi = 96;
  state.controlsFont = CreateFontW(-MulDiv(10, dpi, 72), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  auto create = [&](const wchar_t* cls, const wchar_t* name, int id, DWORD style) {
    HWND hwnd = CreateWindowExW(0, cls, name, WS_CHILD | WS_VISIBLE | style, 0, 0, 1, 1, root, (HMENU)(INT_PTR)id, GetModuleHandleW(nullptr), nullptr);
    if (hwnd) SendMessageW(hwnd, WM_SETFONT, (WPARAM)state.controlsFont, FALSE); return hwnd;
  };
  state.controlsStatus = create(L"STATIC", L"Connecting", ControlStatus, SS_LEFT | SS_ENDELLIPSIS);
  state.ownerButton = create(L"BUTTON", L"Take control", ControlOwner, WS_TABSTOP | BS_PUSHBUTTON);
  state.wakeButton = create(L"BUTTON", L"Wake display", ControlWake, WS_TABSTOP | BS_PUSHBUTTON);
  state.powerButton = create(L"BUTTON", L"Shut down", ControlPower, WS_TABSTOP | BS_PUSHBUTTON);
  state.clipboardButton = create(L"BUTTON", L"Share clipboard", ControlClipboard, WS_TABSTOP | BS_AUTOCHECKBOX);
  state.fitButton = create(L"BUTTON", L"Fit to window", ControlFit, WS_TABSTOP | BS_AUTOCHECKBOX);
  state.blackiceButton = create(L"BUTTON", L"Open BLACKICE", ControlBlackice, WS_TABSTOP | BS_PUSHBUTTON);
  layoutWorkbenchControls(root); updateWorkbenchControls();
}
bool workbenchControlEvent(UINT id, HWND source) {
  if (!state.detached || state.presentationProbe || !state.controlsEnabled || state.closing || !IsWindow(source) ||
      GetParent(source) != state.ownedParent || GetForegroundWindow() != state.ownedParent || !IsWindowEnabled(source) ||
      (state.controlsBusy && id != ControlBlackice)) return false;
  const char* action = nullptr; bool toggle = false, enabled = false;
  if (id == ControlOwner && source == state.ownerButton) action = state.userInput ? "cede" : "take";
  else if (id == ControlWake && source == state.wakeButton) action = "wake";
  else if (id == ControlPower && source == state.powerButton) action = state.controlsPower == "off" ? "start" : "shutdown";
  else if (id == ControlBlackice && source == state.blackiceButton) action = "openBlackice";
  else if (id == ControlClipboard && source == state.clipboardButton) { action = "clipboard"; toggle = true; enabled = SendMessageW(source, BM_GETCHECK, 0, 0) == BST_CHECKED; }
  else if (id == ControlFit && source == state.fitButton) { action = "fit"; toggle = true; enabled = SendMessageW(source, BM_GETCHECK, 0, 0) == BST_CHECKED; }
  if (!action || state.controlSequence >= INT_MAX) return false;
  cJSON* event = cJSON_CreateObject(); cJSON_AddStringToObject(event, "event", "nativeControl"); cJSON_AddStringToObject(event, "action", action);
  cJSON_AddNumberToObject(event, "sequence", ++state.controlSequence);
  cJSON_AddStringToObject(event, "windowHwnd", std::to_string((unsigned long long)(UINT_PTR)state.ownedParent).c_str());
  cJSON_AddStringToObject(event, "inputOwner", state.userInput ? "user" : "agent"); if (toggle) boolean(event, "enabled", enabled);
  char* json = cJSON_PrintUnformatted(event);
  { std::lock_guard<std::mutex> guard(state.outputMutex); if (json) { std::fputs(json, stdout); std::fputc('\n', stdout); std::fflush(stdout); } }
  cJSON_free(json); cJSON_Delete(event); if (id != ControlBlackice) { state.controlsBusy = true; updateWorkbenchControls(); } return true;
}
void fitDetachedChild() {
  if (!state.detached || !IsWindow(state.ownedParent) || !IsWindow(state.child)) return;
  RECT client{}; if (GetClientRect(state.ownedParent, &client)) {
    layoutWorkbenchControls(state.ownedParent); LONG height = std::max(1L, client.bottom - state.controlsHeight);
    if (state.viewportWidth != client.right || state.viewportHeight != height) {
      state.viewportWidth = client.right; state.viewportHeight = height; ++state.viewportRevision;
    }
    SetWindowPos(state.child, nullptr, 0, state.controlsHeight, std::max(1L, client.right), height, SWP_NOZORDER | SWP_NOACTIVATE);
  }
}
bool nativeForeground() { return state.detached && IsWindow(state.ownedParent) && GetForegroundWindow() == state.ownedParent; }
void cancelClipboardPaste() { state.pendingPaste = 0; state.pasteStartedAt = 0; }
void setWorkbenchIcons(HWND hwnd) {
  const UINT dpi = GetDpiForWindow(hwnd);
  HICON large = (HICON)LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(101), IMAGE_ICON, MulDiv(32, dpi ? dpi : 96, 96), MulDiv(32, dpi ? dpi : 96, 96), LR_DEFAULTCOLOR);
  HICON small = (HICON)LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(101), IMAGE_ICON, MulDiv(16, dpi ? dpi : 96, 96), MulDiv(16, dpi ? dpi : 96, 96), LR_DEFAULTCOLOR);
  if (large) { SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)large); if (state.iconLarge) DestroyIcon(state.iconLarge); state.iconLarge = large; }
  if (small) { SendMessageW(hwnd, WM_SETICON, ICON_SMALL, (LPARAM)small); if (state.iconSmall) DestroyIcon(state.iconSmall); state.iconSmall = small; }
}
LRESULT CALLBACK detachedProc(HWND, UINT, WPARAM, LPARAM);
void observeForeground() {
  if (!state.allowTestParent) return;
  HWND current = GetForegroundWindow();
  if (current != state.foregroundLast) {
    state.foregroundChangeCount++; state.foregroundLast = current;
    DWORD pid = 0; if (current) GetWindowThreadProcessId(current, &pid);
    if (pid == GetCurrentProcessId()) state.helperForegroundChangeCount++;
  }
}
cJSON* status() {
  updateDetachedTitle();
  cJSON* o = cJSON_CreateObject();
  boolean(o, "prepared", IsWindow(state.child)); boolean(o, "connected", state.connected);
  boolean(o, "perMonitorV2", state.perMonitorV2);
  boolean(o, "ownershipTransition", state.ownershipTransition);
  cJSON_AddNumberToObject(o, "releasedInputEpoch", (double)state.releasedEpoch.load());
  boolean(o, "visible", state.visible); boolean(o, "certificateVerified", state.certVerified);
  boolean(o, "detached", state.detached);
  boolean(o, "windowVisible", state.detached && IsWindow(state.ownedParent) && IsWindowVisible(state.ownedParent));
  boolean(o, "windowMinimized", state.detached && IsWindow(state.ownedParent) && IsIconic(state.ownedParent));
  boolean(o, "windowForeground", nativeForeground());
  cJSON* controls = cJSON_AddObjectToObject(o, "controls"); boolean(controls, "available", state.detached && IsWindow(state.controlsStatus));
  boolean(controls, "enabled", state.controlsEnabled); boolean(controls, "busy", state.controlsBusy);
  boolean(controls, "clipboardEnabled", state.controlsClipboard); boolean(controls, "fitEnabled", state.controlsFit);
  cJSON_AddStringToObject(controls, "powerState", state.controlsPower.c_str()); cJSON_AddStringToObject(controls, "message", state.controlsMessage.c_str());
  cJSON_AddNumberToObject(controls, "eventSequence", state.controlSequence);
  RECT viewportRect{}; if (IsWindow(state.child)) GetClientRect(state.child, &viewportRect);
  cJSON* viewport = cJSON_CreateObject();
  cJSON_AddNumberToObject(viewport, "width", viewportRect.right);
  cJSON_AddNumberToObject(viewport, "height", viewportRect.bottom);
  cJSON_AddNumberToObject(viewport, "revision", (double)state.viewportRevision);
  cJSON_AddItemToObject(o, "viewport", viewport);
  cJSON* clipboard = cJSON_CreateObject();
  boolean(clipboard, "enabled", state.clipboardEnabled);
  cJSON_AddNumberToObject(clipboard, "pendingPaste", state.pendingPaste);
  cJSON_AddNumberToObject(clipboard, "pasteEpoch", (double)state.pasteEpoch);
  cJSON_AddNumberToObject(clipboard, "copyRevision", state.copyRevision);
  cJSON_AddNumberToObject(clipboard, "copyAgeMs", state.copyAt ? (double)(GetTickCount64() - state.copyAt) : -1);
  cJSON_AddNumberToObject(clipboard, "timeouts", state.clipboardTimeouts);
  cJSON_AddItemToObject(o, "clipboard", clipboard);
  cJSON_AddNumberToObject(o, "windowCloseRevision", (double)state.windowCloseRevision);
  boolean(o, "digestReady", state.digestReady);
  cJSON_AddNumberToObject(o, "nlaAuthRequests", state.nlaRequests);
  cJSON_AddNumberToObject(o, "deniedAuthRequests", state.deniedAuthRequests);
  cJSON_AddStringToObject(o, "credentialMode", "current-logon-native-sspi");
  cJSON_AddStringToObject(o, "authenticationServer", state.authenticationServer.c_str());
  cJSON_AddNumberToObject(o, "selectedProtocol", state.selectedProtocol);
  cJSON_AddStringToObject(o, "graphicsMode", "classic-bitmap");
  cJSON_AddNumberToObject(o, "refreshRequests", state.refreshRequests);
  cJSON* progress = cJSON_CreateObject();
  cJSON_AddStringToObject(progress, "state", freerdp_state_string((CONNECTION_STATE)state.connectionState.load()));
  cJSON_AddNumberToObject(progress, "stateChanges", state.stateChanges);
  cJSON_AddNumberToObject(progress, "preConnectCalls", state.preConnectCalls);
  cJSON_AddNumberToObject(progress, "postConnectCalls", state.postConnectCalls);
  boolean(progress, "tlsStarted", state.tlsStarted); boolean(progress, "tlsFinished", state.tlsFinished);
  cJSON_AddNumberToObject(progress, "readCalls", (double)state.readCalls.load());
  cJSON_AddNumberToObject(progress, "readCompletions", (double)state.readCompletions.load());
  cJSON_AddNumberToObject(progress, "readBytes", (double)state.readBytes.load());
  cJSON_AddNumberToObject(progress, "writeCalls", (double)state.writeCalls.load());
  cJSON_AddNumberToObject(progress, "writeCompletions", (double)state.writeCompletions.load());
  cJSON_AddNumberToObject(progress, "writeBytes", (double)state.writeBytes.load());
  cJSON_AddNumberToObject(progress, "lastReadAtMonotonicMs", (double)state.lastReadAt.load());
  cJSON_AddNumberToObject(progress, "lastWriteAtMonotonicMs", (double)state.lastWriteAt.load());
  cJSON_AddItemToObject(o, "connectionProgress", progress);
  cJSON_AddStringToObject(o, "inputOwner", state.userInput ? "user" : "agent");
  cJSON_AddNumberToObject(o, "coreError", state.coreError);
  cJSON_AddNumberToObject(o, "inputSequence", (double)state.inputSequence);
  cJSON_AddNumberToObject(o, "wakeRequests", (double)state.wakeRequests);
  cJSON_AddStringToObject(o, "renderer", "freerdp-gdi-child");
  cJSON_AddStringToObject(o, "transport", "hyper-v-vmconnect");
  { std::lock_guard<std::mutex> guard(state.frameMutex); cJSON_AddNumberToObject(o, "decodedFrames", (double)state.sequence); }
  char handle[32]; std::snprintf(handle, sizeof(handle), "%llu", (unsigned long long)(UINT_PTR)state.child);
  cJSON_AddStringToObject(o, "childHwnd", handle);
  if (state.detached) {
    std::snprintf(handle, sizeof(handle), "%llu", (unsigned long long)(UINT_PTR)state.ownedParent); cJSON_AddStringToObject(o, "workbenchWindowHwnd", handle);
    boolean(o, "launcherProcessAlive", processAlive(state.launcherProcess));
    boolean(o, "launcherAnchorAlive", IsWindow(state.launcherAnchor));
    cJSON_AddNumberToObject(o, "launcherPid", state.launcherPid);
  }
  boolean(o, "presentationReady", state.visible && IsWindowVisible(state.child) && state.hostPaintingProtected &&
    verifiedParent() && GetWindow(state.parent, GW_CHILD) == state.child && state.successfulPaints > 0 && state.paintedSequence > 0 && state.lastStretchScanlines > 0);
  cJSON* presentation = cJSON_CreateObject();
  boolean(presentation, "childVisible", IsWindow(state.child) && IsWindowVisible(state.child));
  boolean(presentation, "childFirstSibling", verifiedParent() && GetWindow(state.parent, GW_CHILD) == state.child);
  boolean(presentation, "hostPaintingProtected", state.hostPaintingProtected);
  cJSON_AddNumberToObject(presentation, "styleLeaseCount", (double)state.paintingClips.size());
  cJSON_AddNumberToObject(presentation, "siblingRaiseCount", (double)state.siblingRaiseCount);
  cJSON_AddNumberToObject(presentation, "error", state.presentationError);
  cJSON_AddNumberToObject(presentation, "paintCount", (double)state.paintCount);
  cJSON_AddNumberToObject(presentation, "successfulPaints", (double)state.successfulPaints);
  cJSON_AddNumberToObject(presentation, "emptyClipPaints", (double)state.emptyClipPaints);
  cJSON_AddNumberToObject(presentation, "failedPaints", (double)state.failedPaints);
  cJSON_AddNumberToObject(presentation, "paintedSequence", (double)state.paintedSequence);
  cJSON_AddNumberToObject(presentation, "lastPaintAtMonotonicMs", (double)state.lastPaintAt);
  cJSON_AddNumberToObject(presentation, "lastStretchScanlines", state.lastStretchScanlines);
  cJSON_AddNumberToObject(presentation, "lastPaintError", state.lastPaintError);
  cJSON_AddNumberToObject(presentation, "clipComplexity", state.lastClipComplexity);
  cJSON_AddNumberToObject(presentation, "printCount", (double)state.printCount);
  boolean(presentation, "buffered", true);
  cJSON_AddNumberToObject(presentation, "blits", (double)state.presentationBlits);
  cJSON_AddNumberToObject(presentation, "preservedPaints", (double)state.preservedPaints);
  cJSON* clip = cJSON_CreateObject(); cJSON_AddNumberToObject(clip, "left", state.lastPaintClip.left); cJSON_AddNumberToObject(clip, "top", state.lastPaintClip.top);
  cJSON_AddNumberToObject(clip, "right", state.lastPaintClip.right); cJSON_AddNumberToObject(clip, "bottom", state.lastPaintClip.bottom);
  cJSON_AddItemToObject(presentation, "clip", clip); cJSON_AddItemToObject(o, "presentation", presentation);
  if (state.allowTestParent) {
    observeForeground();
    std::snprintf(handle, sizeof(handle), "%llu", (unsigned long long)(UINT_PTR)state.foregroundBefore);
    cJSON_AddStringToObject(o, "foregroundBefore", handle);
    boolean(o, "foregroundUnchanged", state.foregroundChangeCount == 0 && state.foregroundLast == state.foregroundBefore);
    cJSON_AddNumberToObject(o, "foregroundChangeCount", (double)state.foregroundChangeCount);
    cJSON_AddNumberToObject(o, "helperForegroundChangeCount", (double)state.helperForegroundChangeCount);
    boolean(o, "helperEverForeground", state.helperForegroundChangeCount > 0);
  }
  cJSON_AddItemToObject(o, "surface", surface()); cJSON_AddItemToObject(o, "frameHealth", frameHealth()); return o;
}
bool queueWake(const std::string& expectedOwner) {
  if (expectedOwner != "agent" && expectedOwner != "user") return false;
  std::lock_guard<std::timed_mutex> guard(state.inputMutex);
  if (!state.connected || state.stopping || state.ownershipTransition || state.userInput != (expectedOwner == "user") || state.inputs.size() >= 256) return false;
  UINT32 width, height;
  { std::lock_guard<std::mutex> frameGuard(state.frameMutex); width = state.width; height = state.height; }
  if (!width || !height || width > 4096 || height > 4096) return false;
  UINT16 x = (UINT16)(state.lastMouseKnown ? std::min<UINT32>(state.lastMouseX, width - 1) : width / 2);
  UINT16 y = (UINT16)(state.lastMouseKnown ? std::min<UINT32>(state.lastMouseY, height - 1) : height / 2);
  // Explicit, owner-preserving display wake. No key, click, ownership change,
  // focus-in sequence or automatic input; setOwner uses this same queue fence.
  state.inputs.push_back({Input::Mouse, PTR_FLAGS_MOVE, x, y, 0}); state.wakeRequests++;
  if (state.inputReady) SetEvent(state.inputReady);
  return true;
}
bool queueInput(Input input, bool user) {
  std::lock_guard<std::timed_mutex> guard(state.inputMutex);
  if (!state.connected || state.stopping || state.ownershipTransition || state.userInput != user || state.inputs.size() >= 256) return false;
  state.inputs.push_back(input); if (state.inputReady) SetEvent(state.inputReady); return true;
}
bool startClipboardPaste(bool rightControl, bool foreground) {
  if (!state.clipboardEnabled || !state.userInput || !state.connected || state.stopping || state.ownershipTransition || !foreground) return false;
  if (state.pendingPaste) return true;
  state.pasteRevision = state.pasteRevision >= INT_MAX ? 1 : state.pasteRevision + 1;
  state.pendingPaste = state.pasteRevision; state.pasteEpoch = state.clipboardEpoch;
  state.pasteStartedAt = GetTickCount64(); state.pasteRightControl = rightControl; state.suppressPasteKeyUp = true;
  return true;
}
bool finishClipboardPaste(UINT32 id, UINT64 epoch, bool paste, bool foreground, bool controlHeld) {
  if (!id || id != state.pendingPaste || epoch != state.pasteEpoch || epoch != state.clipboardEpoch) return false;
  cancelClipboardPaste();
  if (!paste) return true;
  std::lock_guard<std::timed_mutex> guard(state.inputMutex);
  if (!state.clipboardEnabled || !state.userInput || !state.connected || state.stopping || state.ownershipTransition || !foreground || state.inputs.size() > 250) return false;
  const UINT16 controlFlags = state.pasteRightControl ? KBD_FLAGS_EXTENDED : 0;
  state.inputs.push_back({Input::Key, controlFlags, 0, 0, 0x1d});
  state.inputs.push_back({Input::Key, 0, 0, 0, 0x2f});
  state.inputs.push_back({Input::Key, KBD_FLAGS_RELEASE, 0, 0, 0x2f});
  if (!controlHeld) state.inputs.push_back({Input::Key, (UINT16)(controlFlags | KBD_FLAGS_RELEASE), 0, 0, 0x1d});
  if (state.inputReady) SetEvent(state.inputReady);
  return true;
}
bool setOwner(bool user) {
  ++state.clipboardEpoch; cancelClipboardPaste(); state.suppressPasteKeyUp = false;
  if (!user) state.clipboardEnabled = false;
  state.ownershipTransition = true;
  std::unique_lock<std::timed_mutex> guard(state.inputMutex, std::defer_lock);
  if (!guard.try_lock_for(std::chrono::milliseconds(500))) return false;
  state.inputs.clear();
  if (state.connected && !state.stopping) {
    UINT64 epoch = ++state.nextReleaseEpoch; ResetEvent(state.releaseDone); state.releaseFailed = false;
    state.inputs.push_back({Input::Release, 0, 0, 0, 0, epoch}); SetEvent(state.inputReady);
    guard.unlock();
    if (WaitForSingleObject(state.releaseDone, 1000) != WAIT_OBJECT_0 || state.releasedEpoch != epoch || state.releaseFailed) return false;
    if (!guard.try_lock_for(std::chrono::milliseconds(500))) return false;
  }
  state.userInput = user; state.ownershipTransition = false; guard.unlock();
  if (!user && GetCapture() == state.child) ReleaseCapture();
  if (!user) state.capturedButtons = 0;
  return true;
}
bool setViewerVisible(bool show) {
  if (!show) {
    if (GetCapture() == state.child) ReleaseCapture();
    state.capturedButtons = 0;
    bool released = setOwner(state.userInput);
    state.visible = false; ShowWindow(state.child, SW_HIDE);
    if (state.detached) ShowWindow(state.ownedParent, SW_HIDE);
    restoreHostPainting(); updateDetachedTitle();
    if (!released) stopConnection();
    return released;
  }
  state.visible = true; ShowWindow(state.child, SW_SHOWNOACTIVATE);
  if (state.detached) {
    fitDetachedChild(); ShowWindow(state.ownedParent, SW_SHOWNOACTIVATE);
    SetWindowPos(state.ownedParent, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }
  if (!maintainPresentation()) {
    state.visible = false; ShowWindow(state.child, SW_HIDE); if (state.detached) ShowWindow(state.ownedParent, SW_HIDE); restoreHostPainting(); return false;
  }
  InvalidateRect(state.child, nullptr, FALSE); UpdateWindow(state.child); updateDetachedTitle(); return true;
}
using SendKey = BOOL (*)(rdpInput*, UINT16, UINT8);
using SendMouse = BOOL (*)(rdpInput*, UINT16, UINT16, UINT16);
void dispatchInput(rdpInput* input, SendKey sendKey = freerdp_input_send_keyboard_event, SendMouse sendMouse = freerdp_input_send_mouse_event) {
  // The dispatch fence spans actual guest writes. Ownership changes cannot
  // acknowledge the new owner while previously dequeued input is still sent.
  std::lock_guard<std::timed_mutex> fence(state.inputMutex);
  std::deque<Input> items;
  items.swap(state.inputs);
  for (const auto& item : items) {
    if (item.kind == Input::Release || item.kind == Input::ReleaseMouse) {
      bool released = true;
      if (item.kind == Input::Release) {
        for (UINT16 key : state.heldKeys) released = sendKey(input, (key & 0x100 ? KBD_FLAGS_EXTENDED : 0) | KBD_FLAGS_RELEASE, (UINT8)key) && released;
        state.heldKeys.clear();
      }
      for (UINT16 button : {PTR_FLAGS_BUTTON1, PTR_FLAGS_BUTTON2, PTR_FLAGS_BUTTON3}) if (state.heldMouse & button) released = sendMouse(input, button, state.lastMouseX, state.lastMouseY) && released;
      state.heldMouse = 0;
      if (item.releaseEpoch) { state.releaseFailed = !released; state.releasedEpoch = item.releaseEpoch; SetEvent(state.releaseDone); }
    } else if (item.kind == Input::Key) {
      if (sendKey(input, item.flags, item.code)) {
        UINT16 key = item.code | (item.flags & KBD_FLAGS_EXTENDED ? 0x100 : 0);
        if (item.flags & KBD_FLAGS_RELEASE) state.heldKeys.erase(key); else state.heldKeys.insert(key);
        state.inputSequence++;
      }
    } else if (sendMouse(input, item.flags, item.x, item.y)) {
      state.lastMouseX = item.x; state.lastMouseY = item.y; state.lastMouseKnown = true;
      UINT16 buttons = item.flags & (PTR_FLAGS_BUTTON1 | PTR_FLAGS_BUTTON2 | PTR_FLAGS_BUTTON3);
      if (item.flags & PTR_FLAGS_DOWN) state.heldMouse |= buttons; else state.heldMouse &= ~buttons;
      state.inputSequence++;
    }
  }
}
BOOL authenticate(freerdp* instance, char** username, char** password, char** domain, rdp_auth_reason reason) {
  // No usernames, passwords, prompts, stored secrets, or fallback auth routes.
  // Null identity makes native SSPI use only this process's current logon.
  if (reason == AUTH_NLA && username && password && domain && !*username && !*password && !*domain) {
    state.selectedProtocol = freerdp_settings_get_uint32(instance->context->settings, FreeRDP_SelectedProtocol);
    state.nlaRequests++; return TRUE;
  }
  state.deniedAuthRequests++; return FALSE;
}
int verifyCertificate(freerdp*, const BYTE* pem, size_t length, const char* host, UINT16 port, DWORD) {
  if (!host || (std::strcmp(host, "127.0.0.1") && std::strcmp(host, "localhost") && state.authenticationServer != host) || port != 2179 || length > 1024 * 1024) return 0;
  DWORD derLength = 0;
  if (!CryptStringToBinaryA((const char*)pem, (DWORD)length, CRYPT_STRING_BASE64HEADER, nullptr, &derLength, nullptr, nullptr)) return 0;
  std::vector<BYTE> der(derLength);
  if (!CryptStringToBinaryA((const char*)pem, (DWORD)length, CRYPT_STRING_BASE64HEADER, der.data(), &derLength, nullptr, nullptr)) return 0;
  state.certVerified = sha256(der.data(), derLength) == state.fingerprint;
  return state.certVerified ? 2 : 0;
}
BOOL beginPaint(rdpContext* c) {
  if (c && c->gdi && c->gdi->primary && c->gdi->primary->hdc && c->gdi->primary->hdc->hwnd && c->gdi->primary->hdc->hwnd->invalid)
    c->gdi->primary->hdc->hwnd->invalid->null = TRUE;
  return TRUE;
}
BOOL endPaint(rdpContext* c) {
  if (!c || !c->gdi || !c->gdi->primary_buffer) return FALSE;
  const auto* gdi = c->gdi;
  // Empty update transactions do not prove the server decoded any pixels.
  // Match the upstream Windows renderer's dirty-region acceptance criterion.
  if (!gdi->primary || !gdi->primary->hdc || !gdi->primary->hdc->hwnd || !gdi->primary->hdc->hwnd->invalid) return FALSE;
  const auto* dirty = gdi->primary->hdc->hwnd;
  if (dirty->invalid->null || dirty->ninvalid < 1) return TRUE;
  if (gdi->width <= 0 || gdi->height <= 0 || (size_t)gdi->width * gdi->height > MAX_PIXELS || gdi->stride < (UINT32)gdi->width * 4) return FALSE;
  { std::lock_guard<std::mutex> guard(state.frameMutex);
    state.width = gdi->width; state.height = gdi->height; state.stride = state.width * 4;
    state.pixels.resize((size_t)state.stride * state.height);
    for (UINT32 y = 0; y < state.height; y++) std::memcpy(state.pixels.data() + y * state.stride, gdi->primary_buffer + y * gdi->stride, state.stride);
    state.sequence++; state.frameAt = GetTickCount64(); if (state.sequence == 1) state.firstFrameAt = state.frameAt;
  }
  PostMessageW(state.control, FRAME, 0, 0); return TRUE;
}
BOOL desktopResize(rdpContext* c) {
  UINT32 w = freerdp_settings_get_uint32(c->settings, FreeRDP_DesktopWidth), h = freerdp_settings_get_uint32(c->settings, FreeRDP_DesktopHeight);
  return w && h && (size_t)w * h <= MAX_PIXELS && gdi_resize(c->gdi, w, h);
}
BOOL postConnect(freerdp* instance) {
  state.postConnectCalls++;
  if (!gdi_init(instance, PIXEL_FORMAT_BGRA32)) return FALSE;
  instance->context->update->BeginPaint = beginPaint; instance->context->update->EndPaint = endPaint;
  instance->context->update->DesktopResize = desktopResize; return TRUE;
}
BOOL preConnect(freerdp*) { state.preConnectCalls++; return TRUE; }
void connectionStateChanged(void*, const StateChangedEventArgs* args) {
  if (args) { state.connectionState = args->newState; state.stateChanges++; }
}
int observeRead(rdpTransport* transport, wStream* stream) {
  state.readCalls++; int result = state.originalIo.ReadPdu(transport, stream);
  state.readCompletions++; if (result > 0) state.readBytes += result;
  state.lastReadAt = GetTickCount64(); return result;
}
int observeWrite(rdpTransport* transport, wStream* stream) {
  state.writeCalls++; int result = state.originalIo.WritePdu(transport, stream);
  state.writeCompletions++; if (result > 0) state.writeBytes += result;
  state.lastWriteAt = GetTickCount64(); return result;
}
BOOL observeTls(rdpTransport* transport) {
  state.tlsStarted = true; BOOL result = state.originalIo.TLSConnect(transport);
  state.tlsFinished = true; return result;
}
void stopConnection() {
  state.stopping = true; if (state.stop) SetEvent(state.stop);
  std::lock_guard<std::mutex> guard(state.instanceMutex);
  if (state.instance && state.instance->context) freerdp_abort_connect_context(state.instance->context);
}
DWORD WINAPI connectionThread(void*) {
  freerdp* instance;
  { std::lock_guard<std::mutex> guard(state.instanceMutex); instance = state.instance; }
  bool success = freerdp_connect(instance) == TRUE;
  state.connected = success;
  if (success) {
    // This custom renderer owns no RDPGFX dynamic channel. Request a complete
    // classic bitmap update rather than waiting for incidental desktop damage.
    auto* context = instance->context;
    UINT32 width = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth), height = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    RECTANGLE_16 area{0, 0, (UINT16)(width ? width - 1 : 0), (UINT16)(height ? height - 1 : 0)};
    if (context->update->RefreshRect && context->update->RefreshRect(context, 1, &area)) state.refreshRequests++;
    while (!state.stopping && !freerdp_shall_disconnect_context(instance->context)) {
      HANDLE events[MAXIMUM_WAIT_OBJECTS] = {state.stop, state.inputReady};
      DWORD count = freerdp_get_event_handles(instance->context, events + 2, MAXIMUM_WAIT_OBJECTS - 2);
      if (!count || count > MAXIMUM_WAIT_OBJECTS - 2) break;
      DWORD wait = WaitForMultipleObjects(count + 2, events, FALSE, 50);
      if (wait == WAIT_OBJECT_0 || wait == WAIT_FAILED) break;
      dispatchInput(instance->context->input);
      if (!freerdp_check_event_handles(instance->context)) break;
    }
    { std::lock_guard<std::timed_mutex> guard(state.inputMutex); state.inputs.clear(); state.inputs.push_back({Input::Release, 0, 0, 0, 0}); }
    dispatchInput(instance->context->input);
    freerdp_disconnect(instance);
  }
  state.coreError = freerdp_get_last_error(instance->context); state.connected = false;
  { std::lock_guard<std::mutex> guard(state.instanceMutex);
    if (instance->context->gdi) gdi_free(instance);
    freerdp_context_free(instance); freerdp_free(instance); state.instance = nullptr;
  }
  PostMessageW(state.control, FINISHED, 0, 0); return 0;
}
void settleConnect() {
  if (state.connectRequest.empty()) return;
  bool hasFrame; { std::lock_guard<std::mutex> guard(state.frameMutex); hasFrame = state.sequence > 0; }
  if (state.connected && hasFrame && state.certVerified) {
    reply(state.connectRequest, status()); state.connectRequest.clear();
  }
}
bool bounds(const cJSON* p) {
  int x, y, w, h;
  if (!integer(p, "x", 0, 32767, x, 0) || !integer(p, "y", 0, 32767, y, 0) || !integer(p, "width", 1, 4096, w, 1024) || !integer(p, "height", 1, 4096, h, 768)) return false;
  bool moved = SetWindowPos(state.child, nullptr, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE) != FALSE;
  return moved && (!state.visible || maintainPresentation());
}
bool guid(const std::string& s) {
  if (s.size() != 36) return false;
  for (size_t i = 0; i < s.size(); i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
    else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f') || (s[i] >= 'A' && s[i] <= 'F'))) return false;
  }
  return s != "00000000-0000-0000-0000-000000000000";
}
bool configureVmConnectProtocol(rdpSettings* settings) {
  // Port 2179 does not negotiate an X.224 security protocol. Its console
  // endpoint uses HYBRID. FreeRDP 3.32 defaults HYBRID_EX on, which waits for
  // an Early User Authorization Result this endpoint does not send.
  return freerdp_settings_set_bool(settings, FreeRDP_ExtSecurity, FALSE) && freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity, TRUE);
}
bool configureClassicGraphics(rdpSettings* settings) {
  // Advertise only the update paths implemented by gdi_init. In particular,
  // do not advertise a dynamic RDPGFX channel this client does not load.
  for (auto key : {FreeRDP_SupportGraphicsPipeline, FreeRDP_RemoteFxCodec, FreeRDP_RemoteFxImageCodec, FreeRDP_RemoteFxOnly, FreeRDP_NSCodec, FreeRDP_SurfaceCommandsEnabled, FreeRDP_FrameMarkerCommandEnabled, FreeRDP_SurfaceFrameMarkerEnabled})
    if (!freerdp_settings_set_bool(settings, key, FALSE)) return false;
  return freerdp_settings_set_bool(settings, FreeRDP_SoftwareGdi, TRUE);
}
bool configure(const cJSON* p) {
  std::string vm = str(p, "vmId"), pin = normalizedFingerprint(str(p, "certificateSha256")), host = str(p, "host");
  int port, timeout;
  if (!guid(vm) || pin.empty() || (!host.empty() && host != "127.0.0.1" && host != "localhost") || !integer(p, "port", 2179, 2179, port, 2179) || !integer(p, "timeoutMs", 1000, 30000, timeout, 10000)) return false;
  freerdp* instance = freerdp_new(); if (!instance) return false;
  if (!freerdp_context_new(instance)) { freerdp_free(instance); return false; }
  state.fingerprint = pin; state.vmId = vm; state.certVerified = false; state.coreError = 0;
  wchar_t hostname[256]; DWORD hostnameLength = 256;
  if (!GetComputerNameExW(ComputerNameDnsFullyQualified, hostname, &hostnameLength) || !hostnameLength) {
    hostnameLength = 256;
    if (!GetComputerNameExW(ComputerNameDnsHostname, hostname, &hostnameLength) || !hostnameLength) { freerdp_context_free(instance); freerdp_free(instance); return false; }
  }
  state.authenticationServer = utf8(std::wstring(hostname, hostnameLength));
  state.nlaRequests = 0; state.deniedAuthRequests = 0;
  state.selectedProtocol = 0;
  state.refreshRequests = 0;
  state.connectionState = CONNECTION_STATE_INITIAL; state.stateChanges = state.preConnectCalls = state.postConnectCalls = 0;
  state.readCalls = state.readCompletions = state.readBytes = state.writeCalls = state.writeCompletions = state.writeBytes = state.lastReadAt = state.lastWriteAt = 0;
  state.tlsStarted = state.tlsFinished = false;
  { std::lock_guard<std::mutex> guard(state.frameMutex); state.pixels.clear(); state.sequence = state.width = state.height = state.stride = state.frameAt = state.firstFrameAt = 0; }
  instance->PreConnect = preConnect; instance->PostConnect = postConnect;
  instance->AuthenticateEx = authenticate; instance->VerifyX509Certificate = verifyCertificate;
  PubSub_SubscribeStateChanged(instance->context->pubSub, connectionStateChanged);
  const rdpTransportIo* io = freerdp_get_io_callbacks(instance->context);
  if (!io || !io->ReadPdu || !io->WritePdu || !io->TLSConnect) { freerdp_context_free(instance); freerdp_free(instance); return false; }
  state.originalIo = *io; rdpTransportIo observedIo = *io;
  observedIo.ReadPdu = observeRead; observedIo.WritePdu = observeWrite; observedIo.TLSConnect = observeTls;
  if (!freerdp_set_io_callbacks(instance->context, &observedIo)) { freerdp_context_free(instance); freerdp_free(instance); return false; }
  wchar_t system[MAX_PATH]; UINT length = GetSystemDirectoryW(system, MAX_PATH);
  std::string sspi = length && length < MAX_PATH ? utf8(std::wstring(system, length) + L"\\secur32.dll") : "";
  std::vector<std::string> args = {"blackice-workbench-native", "/v:127.0.0.1:2179", "/vmconnect:" + vm, "/size:1024x768", "/bpp:32", "/log-level:ERROR", "/timeout:" + std::to_string(timeout)};
  std::vector<char*> argv; for (auto& arg : args) argv.push_back(arg.data());
  rdpSettings* settings = instance->context->settings;
  bool ok = !sspi.empty() && freerdp_client_settings_parse_command_line(settings, (int)argv.size(), argv.data(), FALSE) >= 0;
  ok = ok && configureVmConnectProtocol(settings);
  ok = ok && configureClassicGraphics(settings);
  ok = ok && freerdp_settings_set_string(settings, FreeRDP_SspiModule, sspi.c_str());
  // Keep the socket strictly on loopback while native Negotiate authenticates
  // the actual local computer's SPN instead of the IP-literal TERMSRV/127.0.0.1.
  ok = ok && freerdp_settings_set_string(settings, FreeRDP_UserSpecifiedServerName, state.authenticationServer.c_str());
  ok = ok && freerdp_settings_set_bool(settings, FreeRDP_ExternalCertificateManagement, TRUE);
  ok = ok && freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, FALSE);
  ok = ok && freerdp_settings_set_bool(settings, FreeRDP_AutoReconnectionEnabled, FALSE);
  ok = ok && freerdp_settings_set_uint32(settings, FreeRDP_TcpConnectTimeout, timeout);
  // Do not populate account strings: native SSPI must receive null auth identity.
  ok = ok && freerdp_settings_set_string(settings, FreeRDP_Username, nullptr) && freerdp_settings_set_string(settings, FreeRDP_Password, nullptr) && freerdp_settings_set_string(settings, FreeRDP_Domain, nullptr);
  if (!ok) { freerdp_context_free(instance); freerdp_free(instance); return false; }
  { std::lock_guard<std::mutex> guard(state.instanceMutex); state.instance = instance; }
  state.stopping = false; ResetEvent(state.stop); state.deadline = GetTickCount64() + timeout;
  state.worker = CreateThread(nullptr, 0, connectionThread, nullptr, 0, nullptr);
  if (!state.worker) { std::lock_guard<std::mutex> guard(state.instanceMutex); freerdp_context_free(instance); freerdp_free(instance); state.instance = nullptr; return false; }
  return true;
}
bool saveCapture(const std::string& path, cJSON* receipt) {
  std::wstring file = wide(path);
  if (file.size() < 4 || file[1] != L':' || (file[2] != L'\\' && file[2] != L'/')) return false;
  std::lock_guard<std::mutex> guard(state.frameMutex);
  if (state.pixels.empty()) return false;
  cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(receipt, "sequence"), (double)state.sequence);
  cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(receipt, "width"), state.width);
  cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(receipt, "height"), state.height);
  cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(receipt, "stride"), state.stride);
  cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(receipt, "frameAtMonotonicMs"), (double)state.frameAt);
  BITMAPFILEHEADER header{}; BITMAPINFOHEADER info{};
  info.biSize = sizeof(info); info.biWidth = state.width; info.biHeight = -(LONG)state.height;
  info.biPlanes = 1; info.biBitCount = 32; info.biCompression = BI_RGB; info.biSizeImage = (DWORD)state.pixels.size();
  header.bfType = 0x4D42; header.bfOffBits = sizeof(header) + sizeof(info); header.bfSize = header.bfOffBits + info.biSizeImage;
  std::vector<BYTE> bytes(header.bfSize);
  std::memcpy(bytes.data(), &header, sizeof(header)); std::memcpy(bytes.data() + sizeof(header), &info, sizeof(info));
  std::memcpy(bytes.data() + header.bfOffBits, state.pixels.data(), state.pixels.size());
  HANDLE output = CreateFileW(file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (output == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0; bool ok = WriteFile(output, bytes.data(), (DWORD)bytes.size(), &written, nullptr) && written == bytes.size();
  if (ok) ok = FlushFileBuffers(output) != FALSE;
  CloseHandle(output);
  if (!ok) { DeleteFileW(file.c_str()); return false; }
  cJSON_AddStringToObject(receipt, "path", path.c_str()); cJSON_AddNumberToObject(receipt, "bytes", (double)bytes.size());
  cJSON_AddStringToObject(receipt, "sha256", sha256(bytes.data(), bytes.size()).c_str()); return true;
}
cJSON* sampleSurface(const cJSON* parameters) {
  const cJSON* points = get(parameters, "points");
  if (!cJSON_IsArray(points) || cJSON_GetArraySize(points) < 1 || cJSON_GetArraySize(points) > 64) return nullptr;
  std::lock_guard<std::mutex> guard(state.frameMutex);
  if (state.pixels.empty()) return nullptr;
  cJSON* result = cJSON_CreateObject(); cJSON* values = cJSON_AddArrayToObject(result, "points");
  cJSON_AddNumberToObject(result, "sequence", (double)state.sequence);
  cJSON_AddNumberToObject(result, "frameAtMonotonicMs", (double)state.frameAt);
  cJSON_AddNumberToObject(result, "width", state.width); cJSON_AddNumberToObject(result, "height", state.height);
  const cJSON* point;
  cJSON_ArrayForEach(point, points) {
    int x, y;
    if (!cJSON_IsObject(point) || !get(point, "x") || !get(point, "y") || !integer(point, "x", 0, (int)state.width - 1, x, 0) || !integer(point, "y", 0, (int)state.height - 1, y, 0)) { cJSON_Delete(result); return nullptr; }
    const BYTE* pixel = state.pixels.data() + (size_t)y * state.stride + (size_t)x * 4;
    cJSON* value = cJSON_CreateObject(); cJSON_AddNumberToObject(value, "x", x); cJSON_AddNumberToObject(value, "y", y);
    cJSON_AddNumberToObject(value, "r", pixel[2]); cJSON_AddNumberToObject(value, "g", pixel[1]); cJSON_AddNumberToObject(value, "b", pixel[0]);
    cJSON_AddItemToArray(values, value);
  }
  return result;
}
void CALLBACK parentDestroyed(HWINEVENTHOOK, DWORD, HWND hwnd, LONG objectId, LONG childId, DWORD, DWORD) {
  if (hwnd == state.parent && objectId == OBJID_WINDOW && childId == 0) PostMessageW(state.control, PARENT_CLOSED, 0, 0);
}
void CALLBACK parentReordered(HWINEVENTHOOK, DWORD, HWND hwnd, LONG objectId, LONG, DWORD, DWORD) {
  if (state.visible && objectId == OBJID_WINDOW && (hwnd == state.parent || (hwnd && GetParent(hwnd) == state.parent))) PostMessageW(state.control, PRESENT, 0, 0);
}
void handleRequest(cJSON* o) {
  std::string id = str(o, "requestId"), action = str(o, "action");
  const cJSON* p = get(o, "params"); if (!p) p = o;
  if (id.empty() || id.size() > 120 || !cJSON_IsObject(p)) { reply(id, nullptr, "ARGUMENTS", "A bounded requestId and object parameters are required."); return; }
  if (state.closing && action != "status") { reply(id, nullptr, "CLOSING", "The native viewer is closing."); return; }
  if (action == "controls") {
    const char* names[] = {"enabled", "busy", "clipboardEnabled", "fitEnabled"};
    for (const char* name : names) if (!cJSON_IsBool(get(p, name))) { reply(id, nullptr, "ARGUMENTS", "Workbench control flags must be booleans."); return; }
    std::string power = str(p, "powerState"), message = str(p, "message");
    if (!state.detached || !IsWindow(state.controlsStatus) || (power != "running" && power != "off" && power != "unknown") || message.size() > 640 || wide(message).size() > 160 ||
        message.find_first_of("\r\n") != std::string::npos) { reply(id, nullptr, "ARGUMENTS", "Workbench controls need a bounded state for the owned detached window."); return; }
    state.controlsEnabled = cJSON_IsTrue(get(p, "enabled")); state.controlsBusy = cJSON_IsTrue(get(p, "busy"));
    state.controlsClipboard = cJSON_IsTrue(get(p, "clipboardEnabled")); state.controlsFit = cJSON_IsTrue(get(p, "fitEnabled"));
    state.controlsPower = power; state.controlsMessage = message; updateWorkbenchControls(); reply(id, status()); return;
  }
  if ((action == "bounds" || action == "visible" || action == "input" || action == "capture" || action == "sample" || action == "wake" || action == "clipboard") && !IsWindow(state.child)) { reply(id, nullptr, "NOT_PREPARED", "Create the native child viewport first."); return; }
  if (action == "prepare") {
    if (state.child) { reply(id, nullptr, "ALREADY_PREPARED", "The viewport already exists."); return; }
    std::string raw = str(p, "parent"); if (raw.empty()) raw = str(p, "parentHwnd");
    if (state.allowTestParent && raw != "self") { reply(id, nullptr, "PARENT_INVALID", "This test process accepts only its own hidden parent."); return; }
    if (state.allowTestParent) {
      state.ownedParent = CreateWindowExW(WS_EX_NOACTIVATE, L"STATIC", L"BLACKICE isolated native renderer", WS_OVERLAPPED, -20000, -20000, 1024, 768, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
      raw = std::to_string((unsigned long long)(UINT_PTR)state.ownedParent);
    }
    char* end = nullptr; unsigned long long value = std::strtoull(raw.c_str(), &end, 0);
    HWND parent = (HWND)(UINT_PTR)value;
    if (raw.empty() || !end || *end || !IsWindow(parent)) { reply(id, nullptr, "PARENT_INVALID", "A live native parent HWND is required."); return; }
    DWORD anchorPid = 0; GetWindowThreadProcessId(parent, &anchorPid);
    if (!anchorPid || (anchorPid != GetCurrentProcessId() && anchorPid != processParent(GetCurrentProcessId()))) {
      reply(id, nullptr, "PARENT_INVALID", "The viewport anchor must belong to the launching application."); return;
    }
    HANDLE anchorProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, anchorPid);
    if (!processAlive(anchorProcess)) { if (anchorProcess) CloseHandle(anchorProcess);
      reply(id, nullptr, "PARENT_INVALID", "The launching application's process lifetime could not be verified."); return; }
    if (state.detached) {
      state.launcherAnchor = parent; state.launcherPid = anchorPid; state.launcherProcess = anchorProcess;
      MONITORINFO monitor{}; monitor.cbSize = sizeof(monitor); GetMonitorInfoW(MonitorFromWindow(parent, MONITOR_DEFAULTTOPRIMARY), &monitor);
      int availableWidth = std::max(320L, monitor.rcWork.right - monitor.rcWork.left - 80), availableHeight = std::max(240L, monitor.rcWork.bottom - monitor.rcWork.top - 120);
      double scale = std::min({1.25, availableWidth / 1024.0, availableHeight / 768.0});
      RECT rootRect{0, 0, (LONG)(1024 * scale), (LONG)(768 * scale)}; AdjustWindowRectEx(&rootRect, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, FALSE, WS_EX_APPWINDOW);
      state.ownedParent = CreateWindowExW(WS_EX_APPWINDOW, L"BLACKICEDetachedWorkbench", L"BLACKICE Agentic Workbench", WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
        monitor.rcWork.left + 40, monitor.rcWork.top + 40, rootRect.right - rootRect.left, rootRect.bottom - rootRect.top, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
      if (!state.ownedParent) { CloseHandle(state.launcherProcess); state.launcherProcess = nullptr; reply(id, nullptr, "PREPARE_FAILED", "The detached Workbench window could not be created."); return; }
      state.parent = state.ownedParent; state.parentPid = GetCurrentProcessId();
      state.parentProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, state.parentPid);
    } else { state.parent = parent; state.parentPid = anchorPid; state.parentProcess = anchorProcess; }
    state.child = CreateWindowExW(WS_EX_NOACTIVATE, L"BLACKICEFreeRDPChild", L"", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN, 0, 0, 1, 1, state.parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (state.child && state.detached) fitDetachedChild();
    if (!state.child || (!state.detached && !bounds(p))) { if (state.child) DestroyWindow(state.child); state.child = nullptr;
      CloseHandle(state.parentProcess); state.parentProcess = nullptr; state.parent = nullptr;
      if (state.launcherProcess) { CloseHandle(state.launcherProcess); state.launcherProcess = nullptr; }
      if (state.detached && state.ownedParent) { DestroyWindow(state.ownedParent); state.ownedParent = nullptr; }
      reply(id, nullptr, "PREPARE_FAILED", "The child viewport could not be created."); return; }
    if (!state.detached) {
      state.parentHook = SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY, nullptr, parentDestroyed, state.parentPid, 0, WINEVENT_OUTOFCONTEXT);
      state.presentationHook = SetWinEventHook(EVENT_OBJECT_REORDER, EVENT_OBJECT_REORDER, nullptr, parentReordered, 0, 0, WINEVENT_OUTOFCONTEXT);
    }
    reply(id, status());
  } else if (action == "connect") {
    if (!IsWindow(state.child)) { reply(id, nullptr, "NOT_PREPARED", "Create the native child viewport first."); return; }
    if (state.worker || !state.connectRequest.empty()) { reply(id, nullptr, "BUSY", "A connection already owns this viewer."); return; }
    if (!state.digestReady) { reply(id, status(), "RUNTIME_DIGEST_UNAVAILABLE", "The pinned runtime failed its public MD4 test vector; no connection was started."); return; }
    state.connectRequest = id;
    if (!configure(p)) { state.connectRequest.clear(); reply(id, nullptr, "CONNECT_ARGUMENTS", "Connection requires a VM GUID, localhost port 2179, SHA256 certificate pin and bounded timeout."); }
  } else if (action == "bounds") {
    if (!IsWindow(state.child) || (!state.detached && !bounds(p))) reply(id, nullptr, "BOUNDS_INVALID", "Valid child bounds are required."); else reply(id, status());
  } else if (action == "visible") {
    const cJSON* visible = get(p, "visible"); if (!visible) visible = get(p, "enabled");
    if (!IsWindow(state.child) || !cJSON_IsBool(visible)) { reply(id, nullptr, "VISIBILITY_INVALID", "Visibility requires a prepared viewport and a Boolean."); return; }
    bool show = cJSON_IsTrue(visible);
    if (show && state.detached && get(p, "expectedWindowCloseRevision")) {
      int expected = 0;
      if (!integer(p, "expectedWindowCloseRevision", 0, INT_MAX, expected, 0)) { reply(id, nullptr, "VISIBILITY_INVALID", "A valid window-close revision is required."); return; }
      if ((UINT64)expected != state.windowCloseRevision) { cJSON* result = status(); boolean(result, "showSkipped", true); reply(id, result); return; }
    }
    if (!setViewerVisible(show)) { reply(id, status(), show ? "PRESENTATION_FAILED" : "INPUT_RELEASE_FAILED", "The requested native window visibility could not be confirmed."); return; }
    reply(id, status());
  } else if (action == "wake") {
    if (!queueWake(str(p, "expectedOwner"))) { reply(id, status(), "WAKE_REJECTED", "Display wake requires the unchanged current owner and a connected decoded surface."); return; }
    cJSON* result = status(); cJSON* wake = cJSON_CreateObject();
    boolean(wake, "requested", true); boolean(wake, "queued", true); boolean(wake, "desktopAwakeConfirmed", false);
    cJSON_AddItemToObject(result, "wake", wake); reply(id, result);
  } else if (action == "clipboard") {
    const cJSON* enabled = get(p, "enabled");
    if (cJSON_IsBool(enabled)) {
      state.clipboardEnabled = cJSON_IsTrue(enabled) && state.userInput;
      if (!state.clipboardEnabled) cancelClipboardPaste();
      reply(id, status());
    } else {
      int pasteId = 0, epoch = 0; const cJSON* paste = get(p, "paste");
      if (!cJSON_IsBool(paste) || !integer(p, "pasteId", 1, INT_MAX, pasteId, 0) || !integer(p, "epoch", 0, INT_MAX, epoch, -1) ||
          !finishClipboardPaste((UINT32)pasteId, (UINT64)epoch, cJSON_IsTrue(paste), nativeForeground(),
            (GetAsyncKeyState(state.pasteRightControl ? VK_RCONTROL : VK_LCONTROL) & 0x8000) != 0))
        reply(id, nullptr, "CLIPBOARD_STALE", "Clipboard paste no longer belongs to the focused user session.");
      else reply(id, status());
    }
  } else if (action == "input") {
    const cJSON* enabled = get(p, "enabled");
    if (cJSON_IsBool(enabled)) {
      if (!setOwner(cJSON_IsTrue(enabled))) { stopConnection(); reply(id, status(), "INPUT_RELEASE_FAILED", "Held guest input could not be released; ownership was not acknowledged."); }
      else reply(id, status());
    }
    else {
      int x, y, flags, code;
      std::string kind = str(p, "kind"); bool queued = false;
      if (kind == "mouse" && integer(p, "x", 0, 4095, x, 0) && integer(p, "y", 0, 4095, y, 0) && integer(p, "flags", 0, 65535, flags, PTR_FLAGS_MOVE)) queued = queueInput({Input::Mouse, (UINT16)flags, (UINT16)x, (UINT16)y, 0}, false);
      if (kind == "key" && integer(p, "scanCode", 0, 255, code, 0) && integer(p, "flags", 0, KBD_FLAGS_EXTENDED | KBD_FLAGS_RELEASE, flags, 0)) queued = queueInput({Input::Key, (UINT16)flags, 0, 0, (UINT8)code}, false);
      if (!queued) reply(id, nullptr, "INPUT_REJECTED", "Input requires the agent to own a connected session and valid input fields."); else reply(id, status());
    }
  } else if (action == "status") reply(id, status());
  else if (action == "sample") {
    cJSON* result = sampleSurface(p);
    if (!result) reply(id, nullptr, "SAMPLE_INVALID", "Sampling requires a decoded guest surface and 1 to 64 integer pixel coordinates within it.");
    else reply(id, result);
  }
  else if (action == "capture") {
    cJSON* receipt = surface(); std::string path = str(p, "path");
    bool hasFrame; { std::lock_guard<std::mutex> guard(state.frameMutex); hasFrame = !state.pixels.empty(); }
    if (!hasFrame || (!path.empty() && !saveCapture(path, receipt))) { cJSON_Delete(receipt); reply(id, nullptr, "CAPTURE_FAILED", "A decoded surface and a new absolute destination path are required."); }
    else reply(id, receipt);
  } else if (action == "close") {
    state.closeRequest = id; state.closing = true; state.closeDeadline = GetTickCount64() + 3000;
    stopConnection();
    if (!state.worker) { reply(id, status()); PostQuitMessage(0); }
  } else reply(id, nullptr, "ACTION_INVALID", "Unsupported native viewer action.");
}
void freePaintBuffer(PaintBuffer& buffer) {
  if (buffer.dc && buffer.original) SelectObject(buffer.dc, buffer.original);
  if (buffer.bitmap) DeleteObject(buffer.bitmap);
  if (buffer.dc) DeleteDC(buffer.dc);
  buffer = {};
}
bool preparePaintBuffer(PaintBuffer& buffer, LONG width, LONG height) {
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || (UINT64)width * height > MAX_PIXELS) return false;
  if (buffer.dc && buffer.width == width && buffer.height == height) return true;
  PaintBuffer next; next.width = width; next.height = height;
  next.dc = CreateCompatibleDC(nullptr); if (!next.dc) return false;
  BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
  next.bitmap = CreateDIBSection(next.dc, &info, DIB_RGB_COLORS, &next.bits, nullptr, 0);
  if (!next.bitmap || !next.bits) { freePaintBuffer(next); return false; }
  next.original = SelectObject(next.dc, next.bitmap);
  if (!next.original || next.original == HGDI_ERROR) { next.original = nullptr; freePaintBuffer(next); return false; }
  SetICMMode(next.dc, ICM_OFF); SetStretchBltMode(next.dc, COLORONCOLOR);
  freePaintBuffer(buffer); buffer = next; return true;
}
int renderSurface(HDC dc, const RECT& client, bool onscreen) {
  RECT clip{}; int complexity = GetClipBox(dc, &clip), copied = 0; DWORD error = 0; UINT64 sequence = 0;
  if (onscreen) { state.paintCount++; state.lastPaintAt = GetTickCount64(); state.lastClipComplexity = complexity; state.lastPaintClip = clip; }
  else state.printCount++;
  if (complexity == NULLREGION) {
    if (onscreen) { state.emptyClipPaints++; state.lastStretchScanlines = 0; state.lastPaintError = 0; }
    return 0;
  }
  const LONG width = client.right - client.left, height = client.bottom - client.top;
  bool composed = false;
  { std::lock_guard<std::mutex> guard(state.frameMutex);
    if (!state.pixels.empty() && preparePaintBuffer(state.composing, width, height)) { BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth = state.width;
      info.bmiHeader.biHeight = -(LONG)state.height; info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
      SetLastError(0);
      // Never clear or draw a partial update on the visible DC. Frame-lock
      // contention and conversion happen entirely in the private back buffer.
      copied = StretchDIBits(state.composing.dc, 0, 0, width, height, 0, 0, state.width, state.height, state.pixels.data(), &info, DIB_RGB_COLORS, SRCCOPY);
      error = GetLastError(); sequence = state.sequence;
      if (copied > 0) { GdiFlush(); state.composing.valid = true; state.composing.sequence = sequence; state.composing.sourceHeight = copied; composed = true; }
    }
  }
  if (composed) std::swap(state.presented, state.composing);
  if (state.selfTest && state.beforePresentationProbe) state.beforePresentationProbe();
  bool presented = false;
  if (state.presented.valid) {
    // A failed new render retains and re-presents the last complete image.
    if (!composed) ++state.preservedPaints;
    if (state.presented.width == width && state.presented.height == height)
      presented = BitBlt(dc, client.left, client.top, width, height, state.presented.dc, 0, 0, SRCCOPY) != FALSE;
    else { SetStretchBltMode(dc, COLORONCOLOR); presented = StretchBlt(dc, client.left, client.top, width, height,
      state.presented.dc, 0, 0, state.presented.width, state.presented.height, SRCCOPY) != FALSE; }
    if (presented) { ++state.presentationBlits; sequence = state.presented.sequence; }
  }
  if (onscreen) {
    state.lastStretchScanlines = presented ? state.presented.sourceHeight : 0; state.lastPaintError = error;
    if (presented) { state.successfulPaints++; state.paintedSequence = sequence; }
    else if (sequence) state.failedPaints++;
  }
  return presented ? state.presented.sourceHeight : 0;
}
LRESULT CALLBACK childProc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
  if (message == WM_DESTROY) { freePaintBuffer(state.presented); freePaintBuffer(state.composing); }
  if (message == WM_MOUSEACTIVATE) return state.userInput ? MA_ACTIVATE : MA_NOACTIVATE;
  if (message == WM_ERASEBKGND) return 1;
  if (message == WM_PAINT) {
    PAINTSTRUCT ps; HDC dc = BeginPaint(hwnd, &ps); RECT client; GetClientRect(hwnd, &client);
    renderSurface(dc, client, true); EndPaint(hwnd, &ps); return 0;
  }
  if (message == WM_PRINTCLIENT) { RECT client{}; GetClientRect(hwnd, &client); renderSurface((HDC)wp, client, false); return 0; }
  if (message == WM_KILLFOCUS) { cancelClipboardPaste(); std::lock_guard<std::timed_mutex> guard(state.inputMutex); state.inputs.push_back({Input::Release,0,0,0,0}); if (state.inputReady) SetEvent(state.inputReady); }
  if (message == WM_CAPTURECHANGED) {
    state.capturedButtons = 0;
    std::lock_guard<std::timed_mutex> guard(state.inputMutex); state.inputs.push_back({Input::ReleaseMouse,0,0,0,0}); if (state.inputReady) SetEvent(state.inputReady); return 0;
  }
  if (state.userInput && (message == WM_KEYDOWN || message == WM_KEYUP || message == WM_SYSKEYDOWN || message == WM_SYSKEYUP)) {
    const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
    const bool control = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    const bool plainControl = control && !(GetKeyState(VK_SHIFT) & 0x8000) && !(GetKeyState(VK_MENU) & 0x8000) &&
      !(GetKeyState(VK_LWIN) & 0x8000) && !(GetKeyState(VK_RWIN) & 0x8000);
    if (wp == 'V' && !down && state.suppressPasteKeyUp) { state.suppressPasteKeyUp = false; return 0; }
    if (wp == 'V' && down && plainControl && startClipboardPaste((GetKeyState(VK_RCONTROL) & 0x8000) && !(GetKeyState(VK_LCONTROL) & 0x8000), nativeForeground())) return 0;
    if (down && state.pendingPaste && wp != VK_CONTROL && wp != VK_LCONTROL && wp != VK_RCONTROL && wp != 'V') cancelClipboardPaste();
    if (down && state.clipboardEnabled && plainControl && nativeForeground() && (wp == 'C' || wp == 'X')) { state.copyRevision = state.copyRevision >= INT_MAX ? 1 : state.copyRevision + 1; state.copyAt = GetTickCount64(); }
    UINT16 flags = lp & (1L << 24) ? KBD_FLAGS_EXTENDED : 0; if (message == WM_KEYUP || message == WM_SYSKEYUP) flags |= KBD_FLAGS_RELEASE;
    queueInput({Input::Key, flags, 0, 0, (UINT8)((lp >> 16) & 255)}, true); return 0;
  }
  if (state.userInput && (message == WM_MOUSEMOVE || message == WM_LBUTTONDOWN || message == WM_LBUTTONUP || message == WM_RBUTTONDOWN || message == WM_RBUTTONUP || message == WM_MBUTTONDOWN || message == WM_MBUTTONUP)) {
    RECT rect; GetClientRect(hwnd, &rect); UINT32 w, h;
    { std::lock_guard<std::mutex> guard(state.frameMutex); w = state.width; h = state.height; }
    int x = std::clamp(GET_X_LPARAM(lp), 0, (int)std::max(0L, rect.right - 1)), y = std::clamp(GET_Y_LPARAM(lp), 0, (int)std::max(0L, rect.bottom - 1));
    UINT16 flags = PTR_FLAGS_MOVE;
    if (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP) flags = PTR_FLAGS_BUTTON1;
    if (message == WM_RBUTTONDOWN || message == WM_RBUTTONUP) flags = PTR_FLAGS_BUTTON2;
    if (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP) flags = PTR_FLAGS_BUTTON3;
    bool down = message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN;
    if (down) cancelClipboardPaste();
    bool up = message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP;
    if (down) flags |= PTR_FLAGS_DOWN;
    bool queued = queueInput({Input::Mouse, flags, (UINT16)(x * w / std::max(1L, rect.right)), (UINT16)(y * h / std::max(1L, rect.bottom)), 0}, true);
    if (queued && down) { state.capturedButtons |= flags & (PTR_FLAGS_BUTTON1 | PTR_FLAGS_BUTTON2 | PTR_FLAGS_BUTTON3); SetFocus(hwnd); SetCapture(hwnd); }
    if (up) { state.capturedButtons &= ~flags; if (!state.capturedButtons && GetCapture() == hwnd) ReleaseCapture(); }
    return 0;
  }
  return DefWindowProcW(hwnd, message, wp, lp);
}
LRESULT CALLBACK detachedProc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
  if (message == WM_CREATE) { setWorkbenchIcons(hwnd); createWorkbenchControls(hwnd); return 0; }
  if (message == WM_DESTROY) {
    if (state.iconLarge) DestroyIcon(state.iconLarge); if (state.iconSmall) DestroyIcon(state.iconSmall); state.iconLarge = state.iconSmall = nullptr;
    if (state.controlsFont) DeleteObject(state.controlsFont); if (state.controlsBrush) DeleteObject(state.controlsBrush);
    state.controlsFont = nullptr; state.controlsBrush = nullptr; state.controlsHeight = 0;
    state.ownerButton = state.wakeButton = state.powerButton = state.clipboardButton = state.fitButton = state.blackiceButton = state.controlsStatus = nullptr;
  }
  if (message == WM_PAINT && IsWindow(state.controlsStatus)) {
    PAINTSTRUCT paint{}; HDC dc = BeginPaint(hwnd, &paint); RECT strip{}; GetClientRect(hwnd, &strip); strip.bottom = state.controlsHeight;
    FillRect(dc, &strip, state.controlsBrush); EndPaint(hwnd, &paint); return 0;
  }
  if ((message == WM_CTLCOLORSTATIC || message == WM_CTLCOLORBTN) && state.controlsBrush) {
    SetTextColor((HDC)wp, RGB(28,39,55)); SetBkColor((HDC)wp, RGB(246,248,252)); return (LRESULT)state.controlsBrush;
  }
  if (message == WM_COMMAND && HIWORD(wp) == BN_CLICKED) { workbenchControlEvent(LOWORD(wp), (HWND)lp); return 0; }
  if (message == WM_SIZE) { fitDetachedChild(); return 0; }
  if (message == WM_SETFOCUS && state.userInput && IsWindow(state.child)) { SetFocus(state.child); return 0; }
  if (message == WM_CLOSE && !state.closing) {
    state.windowCloseRevision++; setViewerVisible(false); return 0;
  }
  if (message == WM_GETMINMAXINFO) {
    auto* limits = (MINMAXINFO*)lp; UINT dpi = GetDpiForWindow(hwnd); if (!dpi) dpi = 96;
    limits->ptMinTrackSize.x = MulDiv(420, dpi, 96); limits->ptMinTrackSize.y = MulDiv(320, dpi, 96); return 0;
  }
  if (message == WM_DPICHANGED) {
    setWorkbenchIcons(hwnd);
    if (IsWindow(state.controlsStatus)) {
      UINT dpi = HIWORD(wp); HFONT font = CreateFontW(-MulDiv(10, dpi ? dpi : 96, 72), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
      if (font) { HFONT previous = state.controlsFont; state.controlsFont = font;
        for (HWND item : {state.controlsStatus,state.ownerButton,state.wakeButton,state.powerButton,state.clipboardButton,state.fitButton,state.blackiceButton}) SendMessageW(item, WM_SETFONT, (WPARAM)font, TRUE);
        if (previous) DeleteObject(previous);
      }
    }
    const RECT* proposed = (const RECT*)lp;
    SetWindowPos(hwnd, nullptr, proposed->left, proposed->top, proposed->right - proposed->left, proposed->bottom - proposed->top, SWP_NOZORDER | SWP_NOACTIVATE);
    return 0;
  }
  return DefWindowProcW(hwnd, message, wp, lp);
}
LRESULT CALLBACK controlProc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
  if (message == PRESENT) { if (state.visible) maintainPresentation(); return 0; }
  if (message == PARENT_CLOSED) {
    if (!state.closing) { state.closing = true; state.closeRequest = "parent-closed"; state.closeDeadline = GetTickCount64() + 3000; setOwner(false); stopConnection();
      if (!state.worker) { reply(state.closeRequest, status()); PostQuitMessage(0); }
    }
    return 0;
  }
  if (message == REQUEST) { cJSON* o = (cJSON*)lp; handleRequest(o); cJSON_Delete(o); return 0; }
  if (message == FRAME) { updateDetachedTitle(); if (state.visible) maintainPresentation(); if (IsWindow(state.child)) InvalidateRect(state.child, nullptr, FALSE); settleConnect(); return 0; }
  if (message == FINISHED) {
    if (state.worker) { CloseHandle(state.worker); state.worker = nullptr; }
    if (!state.connectRequest.empty()) { reply(state.connectRequest, status(), "CONNECT_FAILED", "The native session ended before a verified guest frame."); state.connectRequest.clear(); }
    if (state.closing) { reply(state.closeRequest, status()); PostQuitMessage(0); } return 0;
  }
  if (message == WM_TIMER) {
    if (state.pendingPaste && (GetTickCount64() - state.pasteStartedAt > 3000 || !nativeForeground())) { ++state.clipboardTimeouts; cancelClipboardPaste(); }
    observeForeground();
    updateDetachedTitle();
    updateWorkbenchControls();
    if (state.visible) maintainPresentation();
    if (state.parent && !state.closing) {
      DWORD pid = 0; GetWindowThreadProcessId(state.parent, &pid);
      if (!verifiedParent() || !IsWindow(state.child) || pid != state.parentPid) PostMessageW(state.control, PARENT_CLOSED, 0, 0);
    }
    settleConnect();
    if (!state.connectRequest.empty() && GetTickCount64() >= state.deadline) { reply(state.connectRequest, status(), "CONNECT_TIMEOUT", "No verified guest frame arrived within the connection deadline."); state.connectRequest.clear(); stopConnection(); }
    if (state.closing && GetTickCount64() >= state.closeDeadline) { reply(state.closeRequest, status(), "CLOSE_TIMEOUT", "The native session did not finish before its shutdown deadline."); PostQuitMessage(2); }
    return 0;
  }
  return DefWindowProcW(hwnd, message, wp, lp);
}
DWORD WINAPI readRequests(void*) {
  std::string line; line.reserve(4096); bool oversize = false;
  for (int ch; (ch = std::fgetc(stdin)) != EOF;) {
    if (ch != '\n') { if (line.size() < MAX_LINE) line.push_back((char)ch); else oversize = true; continue; }
    if (oversize) reply("", nullptr, "REQUEST_TOO_LARGE", "A request exceeded the input bound.");
    else { cJSON* o = cJSON_ParseWithLengthOpts(line.c_str(), line.size() + 1, nullptr, TRUE);
      if (!o || !cJSON_IsObject(o)) { cJSON_Delete(o); reply("", nullptr, "JSON_INVALID", "A request must be one JSON object."); }
      else {
        bool isClose = str(o, "action") == "close";
        if (!PostMessageW(state.control, REQUEST, 0, (LPARAM)o)) cJSON_Delete(o);
        if (isClose) return 0;
      }
    } line.clear(); oversize = false;
  }
  cJSON* close = cJSON_CreateObject(); cJSON_AddStringToObject(close, "action", "close"); cJSON_AddStringToObject(close, "requestId", "stdin-closed");
  if (!PostMessageW(state.control, REQUEST, 0, (LPARAM)close)) cJSON_Delete(close);
  return 0;
}
std::atomic<bool> fixtureReleaseFinished{false}, fixtureReleaseFailed{false}, fixtureReleaseCoordinates{false};
bool fixtureClipVerified = false, fixtureGdiVerified = false, fixtureRestoreVerified = false;
UINT32 fixtureGdiPixel = 0;
UINT32 fixtureRawPixel = 0;
BOOL fixtureReleaseKey(rdpInput*, UINT16 flags, UINT8 code) {
  Sleep(30); return flags == KBD_FLAGS_RELEASE && code == 0x1d;
}
BOOL fixtureReleaseMouse(rdpInput*, UINT16 flags, UINT16 x, UINT16 y) {
  fixtureReleaseCoordinates = flags == PTR_FLAGS_BUTTON1 && x == 123 && y == 456;
  fixtureReleaseFinished = true; return !fixtureReleaseFailed && fixtureReleaseCoordinates;
}
DWORD WINAPI fixtureReleaseWorker(void*) {
  if (WaitForSingleObject(state.inputReady, 1000) == WAIT_OBJECT_0) dispatchInput(nullptr, fixtureReleaseKey, fixtureReleaseMouse);
  return 0;
}
bool testOwnershipReleaseFence() {
  bool success = true;
  for (bool failure : {false, true}) {
    state.connected = true; state.stopping = false; state.userInput = true; state.ownershipTransition = false;
    state.heldKeys = {0x1d}; state.heldMouse = PTR_FLAGS_BUTTON1; state.lastMouseX = 123; state.lastMouseY = 456;
    fixtureReleaseFinished = fixtureReleaseCoordinates = false; fixtureReleaseFailed = failure; ResetEvent(state.inputReady);
    HANDLE worker = CreateThread(nullptr, 0, fixtureReleaseWorker, nullptr, 0, nullptr);
    if (!worker) { success = false; break; }
    bool acknowledged = setOwner(false);
    // This observation is made immediately at acknowledgement, before joining
    // the worker, so a premature acknowledgement cannot pass the fixture.
    bool finishedAtAcknowledgement = fixtureReleaseFinished;
    success = success && finishedAtAcknowledgement && fixtureReleaseCoordinates && (acknowledged == !failure) && (failure ? state.ownershipTransition.load() : !state.userInput.load());
    if (WaitForSingleObject(worker, 1000) != WAIT_OBJECT_0) success = false;
    CloseHandle(worker);
  }
  state.connected = false; state.stopping = false; state.userInput = false; state.ownershipTransition = false;
  state.heldKeys.clear(); state.heldMouse = 0; state.inputs.clear();
  return success;
}
bool testDetachedWindow() {
  HWND originalParent = state.parent, originalChild = state.child, originalOwned = state.ownedParent;
  HANDLE originalProcess = state.parentProcess; DWORD originalPid = state.parentPid;
  HWND before = GetForegroundWindow(); bool originalUser = state.userInput; UINT64 originalRevision = state.windowCloseRevision;
  state.detached = true; state.parentPid = GetCurrentProcessId(); state.launcherPid = GetCurrentProcessId();
  state.launcherProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, GetCurrentProcessId());
  state.launcherAnchor = CreateWindowExW(WS_EX_NOACTIVATE, L"STATIC", L"launcher fixture", WS_OVERLAPPED, -20000, -20000, 10, 10, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  state.parentProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, GetCurrentProcessId());
  state.parent = state.ownedParent = CreateWindowExW(WS_EX_APPWINDOW, L"BLACKICEDetachedWorkbench", L"BLACKICE Agentic Workbench", WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
    -20000, -20000, 640, 480, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  state.child = state.parent ? CreateWindowExW(WS_EX_NOACTIVATE, L"BLACKICEFreeRDPChild", L"", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN, 0, 0, 1, 1, state.parent, nullptr, GetModuleHandleW(nullptr), nullptr) : nullptr;
  bool ok = state.child && verifiedParent() && GetParent(state.parent) == nullptr && GetParent(state.child) == state.parent;
  if (ok) {
    state.visible = true; state.userInput = true; fitDetachedChild();
    SetWindowPos(state.parent, nullptr, -20000, -20000, 900, 700, SWP_NOZORDER | SWP_NOACTIVATE);
    RECT root{}, child{}; GetClientRect(state.parent, &root); GetClientRect(state.child, &child);
    LONG_PTR style = GetWindowLongPtrW(state.parent, GWL_STYLE);
    POINT origin{}; MapWindowPoints(state.child, state.parent, &origin, 1);
    ok = root.right == child.right && root.bottom == child.bottom + state.controlsHeight && origin.x == 0 && origin.y == state.controlsHeight &&
      IsWindow(state.controlsStatus) && IsWindow(state.ownerButton) && !IsWindowEnabled(state.ownerButton) &&
      !workbenchControlEvent(ControlOwner, state.ownerButton) && state.controlSequence == 0 &&
      (style & WS_MAXIMIZEBOX) && (style & WS_THICKFRAME) && maintainPresentation() && state.paintingClips.empty();
    UINT64 sequence = state.sequence; size_t pixels = state.pixels.size();
    SendMessageW(state.parent, WM_CLOSE, 0, 0);
    ok = ok && IsWindow(state.parent) && IsWindow(state.child) && !state.visible && !IsWindowVisible(state.parent) && state.userInput && state.sequence == sequence && state.pixels.size() == pixels && state.windowCloseRevision == originalRevision + 1;
    DestroyWindow(state.launcherAnchor); state.launcherAnchor = nullptr;
    ok = ok && verifiedParent() && processAlive(state.launcherProcess) && GetForegroundWindow() == before;
  }
  state.visible = false; if (state.parent) DestroyWindow(state.parent);
  if (state.launcherAnchor) DestroyWindow(state.launcherAnchor);
  if (state.parentProcess) CloseHandle(state.parentProcess);
  if (state.launcherProcess) CloseHandle(state.launcherProcess);
  state.detached = false; state.parent = originalParent; state.child = originalChild; state.ownedParent = originalOwned;
  state.parentProcess = originalProcess; state.parentPid = originalPid; state.launcherProcess = nullptr; state.launcherAnchor = nullptr; state.launcherPid = 0;
  state.userInput = originalUser; state.windowCloseRevision = originalRevision; state.hostPaintingProtected = false; state.windowTitle.clear(); return ok;
}
bool testWakeFence() {
  state.connected = true; state.stopping = false; state.userInput = false; state.lastMouseKnown = false; state.inputs.clear();
  bool ok = !queueWake("none") && !queueWake("user") && queueWake("agent");
  ok = ok && state.inputs.size() == 1 && state.inputs.front().kind == Input::Mouse && state.inputs.front().flags == PTR_FLAGS_MOVE &&
    state.inputs.front().x == state.width / 2 && state.inputs.front().y == state.height / 2;
  state.inputs.clear(); state.userInput = true; state.lastMouseKnown = true; state.lastMouseX = 3; state.lastMouseY = 7;
  ok = ok && !queueWake("agent") && queueWake("user") && state.userInput && state.inputs.size() == 1 &&
    state.inputs.front().flags == PTR_FLAGS_MOVE && state.inputs.front().x == 3 && state.inputs.front().y == 7;
  state.ownershipTransition = true; ok = ok && !queueWake("user"); state.ownershipTransition = false;
  state.connected = false; ok = ok && !queueWake("user") && setOwner(false) && state.inputs.empty() && !state.userInput;
  return ok;
}
bool testFrameHealth() {
  cJSON* health = frameHealth(); bool ok = cJSON_IsFalse(get(health, "dark")) && cJSON_IsTrue(get(health, "available")); cJSON_Delete(health);
  std::vector<BYTE> original;
  { std::lock_guard<std::mutex> guard(state.frameMutex); original = state.pixels; std::fill(state.pixels.begin(), state.pixels.end(), 0); }
  health = frameHealth(); ok = ok && cJSON_IsTrue(get(health, "dark")) && str(health, "classification") == "dark" &&
    str(health, "meaning") == "decoded-display-sample-not-vm-power-state"; cJSON_Delete(health);
  { std::lock_guard<std::mutex> guard(state.frameMutex); state.pixels.clear(); }
  health = frameHealth(); ok = ok && cJSON_IsNull(get(health, "dark")) && str(health, "classification") == "unknown"; cJSON_Delete(health);
  { std::lock_guard<std::mutex> guard(state.frameMutex); state.pixels = std::move(original); }
  return ok;
}
bool testPresentationFence() {
  HWND before = GetForegroundWindow(); LONG_PTR parentStyle = GetWindowLongPtrW(state.parent, GWL_STYLE);
  HWND sibling = CreateWindowExW(WS_EX_NOACTIVATE, L"STATIC", L"owned sibling", WS_CHILD | WS_VISIBLE, 0, 0, 400, 300, state.parent, nullptr, GetModuleHandleW(nullptr), nullptr);
  HWND unrelated = CreateWindowExW(WS_EX_NOACTIVATE, L"STATIC", L"unrelated window", WS_OVERLAPPED, -20000, -20000, 10, 10, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!sibling || !unrelated) { if (sibling) DestroyWindow(sibling); if (unrelated) DestroyWindow(unrelated); return false; }
  LONG_PTR siblingStyle = GetWindowLongPtrW(sibling, GWL_STYLE), unrelatedStyle = GetWindowLongPtrW(unrelated, GWL_STYLE);
  state.visible = true; ShowWindow(state.child, SW_SHOWNOACTIVATE);
  SetWindowPos(sibling, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  bool ok = maintainPresentation() && GetWindow(state.parent, GW_CHILD) == state.child &&
    (GetWindowLongPtrW(state.parent, GWL_STYLE) & WS_CLIPCHILDREN) && (GetWindowLongPtrW(sibling, GWL_STYLE) & WS_CLIPSIBLINGS) &&
    !addPaintingClip(unrelated, WS_CLIPCHILDREN) && GetWindowLongPtrW(unrelated, GWL_STYLE) == unrelatedStyle;
  fixtureClipVerified = ok;
  // Exercise the exact GDI render path into an owned memory DC. This verifies
  // real StretchDIBits output; it does not claim visible GPU composition.
  SetWindowPos(state.child, nullptr, 0, 0, 16, 16, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  HDC dc = CreateCompatibleDC(nullptr); BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = 16; info.bmiHeader.biHeight = -16; info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32;
  void* bits = nullptr; HBITMAP bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &bits, nullptr, 0); HGDIOBJ original = bitmap ? SelectObject(dc, bitmap) : nullptr;
  if (!dc || !bitmap || !bits) ok = false;
  else {
    SetICMMode(dc, ICM_OFF);
    SendMessageW(state.child, WM_PRINTCLIENT, (WPARAM)dc, PRF_CLIENT); fixtureGdiPixel = GetPixel(dc, 0, 0);
    GdiFlush(); const BYTE* rendered = (const BYTE*)bits; fixtureRawPixel = RGB(rendered[2], rendered[1], rendered[0]);
    fixtureGdiVerified = fixtureRawPixel == RGB(74, 37, 0); ok = ok && fixtureGdiVerified;
  }
  if (original) SelectObject(dc, original);
  if (bitmap) DeleteObject(bitmap);
  if (dc) DeleteDC(dc);
  SetWindowPos(state.child, nullptr, 0, 0, 400, 300, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  // Preserve an unrelated style bit added while our lease was active, while
  // removing only our own additions from the verified original windows.
  SetWindowLongPtrW(state.parent, GWL_STYLE, GetWindowLongPtrW(state.parent, GWL_STYLE) | WS_CLIPSIBLINGS);
  state.visible = false; ShowWindow(state.child, SW_HIDE); restoreHostPainting();
  fixtureRestoreVerified = GetWindowLongPtrW(state.parent, GWL_STYLE) == (parentStyle | WS_CLIPSIBLINGS) &&
    GetWindowLongPtrW(sibling, GWL_STYLE) == siblingStyle && state.paintingClips.empty() && !state.hostPaintingProtected && GetForegroundWindow() == before;
  ok = ok && fixtureRestoreVerified;
  SetWindowLongPtrW(state.parent, GWL_STYLE, parentStyle); DestroyWindow(sibling); DestroyWindow(unrelated); return ok;
}
UINT32 probeCrc32(UINT32 value) {
  UINT32 crc = 0xffffffff;
  for (unsigned byte = 0; byte < 4; ++byte) { crc ^= (value >> (byte * 8)) & 255; for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return crc ^ 0xffffffff;
}
void updateProbePixels(UINT32 counter) {
  auto rectangle = [](int x, int y, int width, int height, BYTE red, BYTE green, BYTE blue) {
    for (int row = y; row < y + height; ++row) for (int column = x; column < x + width; ++column) {
      const size_t at = ((size_t)row * 1920 + column) * 4; state.pixels[at] = blue; state.pixels[at + 1] = green; state.pixels[at + 2] = red; state.pixels[at + 3] = 255;
    }
  };
  if (state.width != 1920 || state.height != 1080 || state.pixels.size() != 1920 * 1080 * 4) {
    state.width = 1920; state.height = 1080; state.stride = 1920 * 4; state.pixels.resize(1920 * 1080 * 4);
    rectangle(0, 0, 1920, 1080, 208, 220, 232);
    rectangle(160, 800, 128, 128, 176, 196, 220); rectangle(640, 800, 128, 128, 220, 180, 144);
    rectangle(1120, 800, 128, 128, 160, 212, 176); rectangle(1600, 800, 128, 128, 204, 168, 220);
  }
  if (counter > 1) rectangle(32 + ((counter - 1) * 17) % 1700, 240, 120, 80, 208, 220, 232);
  rectangle(32 + (counter * 17) % 1700, 240, 120, 80, 32, 192, 224);
  const UINT32 crc = probeCrc32(counter);
  for (int row = 0; row < 2; ++row) for (unsigned bit = 0; bit < 32; ++bit) {
    const bool one = ((row ? crc : counter) >> bit) & 1;
    rectangle(32 + bit * 16, row ? 80 : 32, 16, 32, one ? 240 : 96, one ? 196 : 160, one ? 72 : 216);
  }
  state.sequence = counter; state.frameAt = GetTickCount64(); if (!state.firstFrameAt) state.firstFrameAt = state.frameAt;
  state.probeProduced = counter;
}
int presentationProbe() {
  state.selfTest = true; state.presentationProbe = true; state.detached = true; state.allowTestParent = true;
  state.parentPid = state.launcherPid = GetCurrentProcessId(); state.launcherAnchor = state.control;
  state.parentProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, state.parentPid);
  state.launcherProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, state.parentPid);
  MONITORINFO monitor{}; monitor.cbSize = sizeof(MONITORINFO);
  if (!GetMonitorInfoW(MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY), &monitor)) return 2;
  const int width = std::min(960L, monitor.rcWork.right - monitor.rcWork.left), height = std::min(620L, monitor.rcWork.bottom - monitor.rcWork.top);
  state.parent = state.ownedParent = CreateWindowExW(WS_EX_APPWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST, L"BLACKICEDetachedWorkbench", L"BLACKICE display check", WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
    monitor.rcWork.right - width - 20, monitor.rcWork.bottom - height - 20, width, height, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  state.child = state.parent ? CreateWindowExW(WS_EX_NOACTIVATE, L"BLACKICEFreeRDPChild", L"", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN, 0, 0, 1, 1, state.parent, nullptr, GetModuleHandleW(nullptr), nullptr) : nullptr;
  if (!state.child) return 2;
  { std::lock_guard<std::mutex> guard(state.frameMutex); updateProbePixels(1); }
  state.visible = true; fitDetachedChild(); ShowWindow(state.parent, SW_SHOWNOACTIVATE); ShowWindow(state.child, SW_SHOWNOACTIVATE);
  SetWindowPos(state.parent, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); maintainPresentation(); UpdateWindow(state.child);
  cJSON* start = status(); boolean(start, "networkStarted", false); cJSON_AddNumberToObject(start, "guestInputSent", 0); cJSON_AddNumberToObject(start, "hostInputSent", 0); cJSON_AddNumberToObject(start, "helperPid", GetCurrentProcessId());
  cJSON_AddItemToObject(start, "animation", cJSON_Parse(R"({"width":1920,"height":1080,"background":{"r":208,"g":220,"b":232},"counter":{"x":32,"y":32,"cellWidth":16,"cellHeight":32,"cells":32,"zero":{"r":96,"g":160,"b":216},"one":{"r":240,"g":196,"b":72}},"crcCounter":{"x":32,"y":80,"cellWidth":16,"cellHeight":32,"cells":32,"zero":{"r":96,"g":160,"b":216},"one":{"r":240,"g":196,"b":72}}})"));
  reply("presentation-probe-start", start);
  HANDLE producer = CreateThread(nullptr, 0, +[](LPVOID) -> DWORD {
    UINT32 counter = 1;
    while (WaitForSingleObject(state.stop, 12) == WAIT_TIMEOUT) {
      std::lock_guard<std::mutex> guard(state.frameMutex); updateProbePixels(++counter); PostMessageW(state.control, FRAME, 0, 0);
      // Exercise the real paint path under a bounded producer lock hold. The
      // old visible clear happened before this wait and exposed black frames.
      Sleep(4);
    }
    return 0;
  }, nullptr, 0, nullptr);
  const UINT64 until = GetTickCount64() + 14000; SetTimer(state.control, 1, 50, nullptr);
  MSG message{};
  while (GetTickCount64() < until && IsWindow(state.child) && state.visible) {
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
    MsgWaitForMultipleObjects(0, nullptr, FALSE, 10, QS_ALLINPUT);
  }
  SetEvent(state.stop); if (producer) { WaitForSingleObject(producer, 1000); CloseHandle(producer); }
  cJSON* final = status(); boolean(final, "networkStarted", false); cJSON_AddNumberToObject(final, "guestInputSent", 0); cJSON_AddNumberToObject(final, "hostInputSent", 0); cJSON_AddNumberToObject(final, "framesProduced", (double)state.probeProduced.load());
  reply("presentation-probe-final", final); KillTimer(state.control, 1);
  DestroyWindow(state.parent); if (state.parentProcess) CloseHandle(state.parentProcess); if (state.launcherProcess) CloseHandle(state.launcherProcess);
  state.parentProcess = state.launcherProcess = nullptr; return producer ? 0 : 2;
}
bool testBufferedPresentation() {
  BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth = 16; info.bmiHeader.biHeight = -16;
  info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32;
  HDC target = CreateCompatibleDC(nullptr); void* bits = nullptr;
  HBITMAP bitmap = target ? CreateDIBSection(target, &info, DIB_RGB_COLORS, &bits, nullptr, 0) : nullptr;
  if (!bitmap || !bits) { if (target) DeleteDC(target); return false; }
  HGDIOBJ old = SelectObject(target, bitmap); SetICMMode(target, ICM_OFF);
  BYTE* raw = (BYTE*)bits; for (int i = 0; i < 16 * 16; ++i) { raw[i * 4] = 255; raw[i * 4 + 1] = 0; raw[i * 4 + 2] = 255; raw[i * 4 + 3] = 0; }
  const UINT64 before = state.presentationBlits; bool unchangedBeforeCommit = false;
  state.beforePresentationProbe = [&]() { GdiFlush(); unchangedBeforeCommit = raw[0] == 255 && raw[1] == 0 && raw[2] == 255 && state.presentationBlits == before; };
  RECT rect{0, 0, 16, 16}; bool ok = renderSurface(target, rect, false) > 0; GdiFlush();
  ok = ok && unchangedBeforeCommit && state.presentationBlits == before + 1 && raw[0] == 0 && raw[1] == 37 && raw[2] == 74;
  state.beforePresentationProbe = {};
  std::vector<BYTE> saved; { std::lock_guard<std::mutex> guard(state.frameMutex); saved.swap(state.pixels); }
  const UINT64 preserved = state.preservedPaints;
  ok = ok && renderSurface(target, rect, false) > 0; GdiFlush();
  ok = ok && state.preservedPaints == preserved + 1 && state.presentationBlits == before + 2 && raw[0] == 0 && raw[1] == 37 && raw[2] == 74;
  { std::lock_guard<std::mutex> guard(state.frameMutex); saved.swap(state.pixels); }
  SelectObject(target, old); DeleteObject(bitmap); DeleteDC(target); return ok;
}
bool testClipboardFence() {
  const bool connected = state.connected, user = state.userInput, enabled = state.clipboardEnabled;
  bool ok = !startClipboardPaste(false, true);
  state.connected = true; state.userInput = true; state.clipboardEnabled = true;
  ok = ok && !startClipboardPaste(false, false) && startClipboardPaste(false, true);
  const UINT32 first = state.pendingPaste; const UINT64 epoch = state.pasteEpoch;
  ok = ok && first > 0 && state.suppressPasteKeyUp && !finishClipboardPaste(first + 1, epoch, true, true, false) && state.inputs.empty();
  ok = ok && finishClipboardPaste(first, epoch, true, true, false) && state.inputs.size() == 4 &&
    state.inputs[0].code == 0x1d && state.inputs[1].code == 0x2f && state.inputs[2].flags == KBD_FLAGS_RELEASE && state.inputs[3].flags == KBD_FLAGS_RELEASE;
  state.inputs.clear();
  ok = ok && startClipboardPaste(true, true) && finishClipboardPaste(state.pendingPaste, state.pasteEpoch, true, true, true) &&
    state.inputs.size() == 3 && state.inputs[0].flags == KBD_FLAGS_EXTENDED;
  state.inputs.clear();
  ok = ok && startClipboardPaste(false, true); ++state.clipboardEpoch;
  ok = ok && !finishClipboardPaste(state.pendingPaste, state.pasteEpoch, true, true, false) && state.inputs.empty();
  cancelClipboardPaste();
  ok = ok && startClipboardPaste(false, true) && !finishClipboardPaste(state.pendingPaste, state.pasteEpoch, true, false, false) && state.inputs.empty();
  ok = ok && startClipboardPaste(false, true) && finishClipboardPaste(state.pendingPaste, state.pasteEpoch, false, true, false) && state.inputs.empty();
  state.connected = connected; state.userInput = user; state.clipboardEnabled = enabled; state.suppressPasteKeyUp = false; cancelClipboardPaste();
  return ok;
}
int selfTest() {
  state.selfTest = true; HWND before = GetForegroundWindow();
  HWND parent = CreateWindowExW(WS_EX_NOACTIVATE, L"STATIC", L"BLACKICE native renderer self-test", WS_OVERLAPPED, -20000, -20000, 640, 480, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  state.parent = state.ownedParent = parent; state.parentPid = GetCurrentProcessId();
  state.parentProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, state.parentPid);
  state.child = CreateWindowExW(WS_EX_NOACTIVATE, L"BLACKICEFreeRDPChild", L"", WS_CHILD, 0, 0, 320, 240, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
  freerdp* instance = freerdp_new(); bool ok = parent && state.child && instance && freerdp_context_new(instance);
  bool diagnosticCallbacksVerified = false;
  bool vmConnectProtocolVerified = false;
  bool classicGraphicsVerified = false;
  bool sampleVerified = false;
  bool ownershipReleaseVerified = false;
  bool presentationVerified = false;
  bool wakeVerified = false, frameHealthVerified = false;
  bool detachedVerified = false, clipboardVerified = false, bufferedVerified = false;
  bool contextReady = ok; ok = ok && state.digestReady;
  if (ok) {
    std::vector<std::string> configuration = {"self-test", "/v:127.0.0.1:2179", "/vmconnect:11111111-1111-4111-8111-111111111111", "/log-level:ERROR"};
    std::vector<char*> configurationArgs; for (auto& arg : configuration) configurationArgs.push_back(arg.data());
    rdpSettings* settings = instance->context->settings;
    vmConnectProtocolVerified = freerdp_client_settings_parse_command_line(settings, (int)configurationArgs.size(), configurationArgs.data(), FALSE) >= 0 && configureVmConnectProtocol(settings) && !freerdp_settings_get_bool(settings, FreeRDP_ExtSecurity) && freerdp_settings_get_bool(settings, FreeRDP_NlaSecurity) && !freerdp_settings_get_bool(settings, FreeRDP_NegotiateSecurityLayer) && freerdp_settings_get_uint32(settings, FreeRDP_ServerPort) == 2179;
    classicGraphicsVerified = configureClassicGraphics(settings) && !freerdp_settings_get_bool(settings, FreeRDP_SupportGraphicsPipeline) && !freerdp_settings_get_bool(settings, FreeRDP_RemoteFxCodec) && !freerdp_settings_get_bool(settings, FreeRDP_NSCodec) && !freerdp_settings_get_bool(settings, FreeRDP_SurfaceCommandsEnabled) && freerdp_settings_get_bool(settings, FreeRDP_SoftwareGdi);
    ok = ok && vmConnectProtocolVerified && classicGraphicsVerified;
    // gdi_init depends on caches initialized by the real connection handshake.
    // A synthetic decoded buffer exercises our actual frame/paint callbacks
    // without faking that handshake or opening any network connection.
    rdpGdi decoded{}; gdiBitmap bitmap{}; GDI_DC dc{}; GDI_WND window{}; GDI_RGN dirtyRegion{};
    bitmap.hdc = &dc; dc.hwnd = &window; window.invalid = &dirtyRegion; decoded.primary = &bitmap;
    std::vector<BYTE> testPixels(16 * 16 * 4);
    decoded.width = 16; decoded.height = 16; decoded.stride = 16 * 4; decoded.primary_buffer = testPixels.data();
    instance->context->gdi = &decoded;
    if (ok) {
      for (size_t i = 0; i < 16 * 16 * 4; i++) instance->context->gdi->primary_buffer[i] = (BYTE)(i * 37);
      ok = beginPaint(instance->context) && endPaint(instance->context) && state.sequence == 0;
      dirtyRegion.null = FALSE; window.ninvalid = 1;
      ok = ok && endPaint(instance->context) && state.sequence == 1 && state.width == 16 && state.height == 16;
      cJSON* sampleRequest = cJSON_Parse("{\"points\":[{\"x\":0,\"y\":0},{\"x\":1,\"y\":0}]}");
      cJSON* sampled = sampleSurface(sampleRequest);
      if (sampled) {
        const cJSON* values = get(sampled, "points"); const cJSON* first = cJSON_GetArrayItem(values, 0); const cJSON* second = cJSON_GetArrayItem(values, 1);
        sampleVerified = cJSON_GetArraySize(values) == 2 && get(sampled, "sequence")->valuedouble == 1 && get(first, "b")->valueint == 0 && get(first, "g")->valueint == 37 && get(first, "r")->valueint == 74 && get(second, "b")->valueint == 148 && get(second, "g")->valueint == 185 && get(second, "r")->valueint == 222;
      }
      cJSON_Delete(sampled); cJSON_Delete(sampleRequest);
      sampleRequest = cJSON_Parse("{\"points\":[{\"x\":16,\"y\":0}]}"); sampled = sampleSurface(sampleRequest);
      sampleVerified = sampleVerified && !sampled;
      cJSON_Delete(sampled); cJSON_Delete(sampleRequest);
      sampleRequest = cJSON_CreateObject(); cJSON* tooMany = cJSON_AddArrayToObject(sampleRequest, "points");
      for (int n = 0; n < 65; n++) { cJSON* point = cJSON_CreateObject(); cJSON_AddNumberToObject(point, "x", 0); cJSON_AddNumberToObject(point, "y", 0); cJSON_AddItemToArray(tooMany, point); }
      sampled = sampleSurface(sampleRequest); sampleVerified = sampleVerified && !sampled; cJSON_Delete(sampled); cJSON_Delete(sampleRequest);
      ok = ok && sampleVerified;
      StateChangedEventArgs progress{}; progress.newState = CONNECTION_STATE_NLA;
      connectionStateChanged(nullptr, &progress);
      state.originalIo.ReadPdu = +[](rdpTransport*, wStream*) -> int { return 17; };
      state.originalIo.WritePdu = +[](rdpTransport*, wStream*) -> int { return 23; };
      state.originalIo.TLSConnect = +[](rdpTransport*) -> BOOL { return TRUE; };
      diagnosticCallbacksVerified = state.connectionState == CONNECTION_STATE_NLA && state.stateChanges == 1 && observeRead(nullptr, nullptr) == 17 && observeWrite(nullptr, nullptr) == 23 && observeTls(nullptr) && state.readCalls == 1 && state.readCompletions == 1 && state.readBytes == 17 && state.writeCalls == 1 && state.writeCompletions == 1 && state.writeBytes == 23 && state.tlsFinished;
      ok = ok && diagnosticCallbacksVerified;
      state.originalIo = {}; state.connectionState = CONNECTION_STATE_INITIAL; state.stateChanges = 0;
      state.readCalls = state.readCompletions = state.readBytes = state.writeCalls = state.writeCompletions = state.writeBytes = state.lastReadAt = state.lastWriteAt = 0;
      state.tlsStarted = state.tlsFinished = false;
      ok = ok && SendMessageW(state.child, WM_MOUSEACTIVATE, 0, 0) == MA_NOACTIVATE;
      ShowWindow(state.child, SW_SHOWNOACTIVATE); SetWindowPos(state.child, nullptr, 0, 0, 400, 300, SWP_NOZORDER | SWP_NOACTIVATE);
      UpdateWindow(state.child); setOwner(true); ok = ok && SendMessageW(state.child, WM_MOUSEACTIVATE, 0, 0) == MA_ACTIVATE;
      presentationVerified = testPresentationFence(); ok = ok && presentationVerified;
      setOwner(false); ok = ok && !queueInput({Input::Key,0,0,0,30}, true) && !queueInput({Input::Key,0,0,0,30}, false);
      ownershipReleaseVerified = testOwnershipReleaseFence(); ok = ok && ownershipReleaseVerified;
      wakeVerified = testWakeFence(); frameHealthVerified = testFrameHealth(); ok = ok && wakeVerified && frameHealthVerified;
      detachedVerified = testDetachedWindow(); ok = ok && detachedVerified;
      bufferedVerified = testBufferedPresentation(); ok = ok && bufferedVerified;
      clipboardVerified = testClipboardFence(); ok = ok && clipboardVerified;
      ok = ok && verifyCertificate(instance, (const BYTE*)"invalid", 7, "127.0.0.1", 2179, 0) == 0;
      char* noUsername = nullptr; char* noPassword = nullptr; char* noDomain = nullptr;
      ok = ok && authenticate(instance, &noUsername, &noPassword, &noDomain, AUTH_NLA) && !authenticate(instance, &noUsername, &noPassword, &noDomain, AUTH_TLS);
      ok = ok && GetParent(state.child) == parent && (GetWindowLongPtrW(state.child, GWL_STYLE) & WS_CHILD) && GetForegroundWindow() == before;
    }
    instance->context->gdi = nullptr;
    freerdp_context_free(instance);
  }
  if (instance && contextReady && !ok && instance->context) freerdp_context_free(instance);
  if (instance) freerdp_free(instance);
  cJSON* result = status(); boolean(result, "selfTest", true); boolean(result, "networkStarted", false); boolean(result, "foregroundUnchanged", GetForegroundWindow() == before);
  boolean(result, "diagnosticCallbacksVerified", diagnosticCallbacksVerified);
  boolean(result, "vmConnectProtocolVerified", vmConnectProtocolVerified);
  boolean(result, "classicGraphicsVerified", classicGraphicsVerified);
  boolean(result, "sampleVerified", sampleVerified);
  boolean(result, "ownershipReleaseVerified", ownershipReleaseVerified);
  boolean(result, "presentationVerified", presentationVerified);
  boolean(result, "fixtureClipVerified", fixtureClipVerified); boolean(result, "fixtureGdiVerified", fixtureGdiVerified); boolean(result, "fixtureRestoreVerified", fixtureRestoreVerified);
  cJSON_AddNumberToObject(result, "fixtureGdiPixel", fixtureGdiPixel);
  cJSON_AddNumberToObject(result, "fixtureRawPixel", fixtureRawPixel);
  boolean(result, "wakeVerified", wakeVerified); boolean(result, "frameHealthVerified", frameHealthVerified);
  boolean(result, "detachedVerified", detachedVerified);
  boolean(result, "detachedControlsVerified", detachedVerified);
  boolean(result, "clipboardVerified", clipboardVerified);
  boolean(result, "bufferedPresentationVerified", bufferedVerified);
  HICON resourceIcon = (HICON)LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(101), IMAGE_ICON, 32, 32, LR_DEFAULTCOLOR);
  boolean(result, "iconResourcePresent", FindResourceW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(101), MAKEINTRESOURCEW(14)) && resourceIcon);
  if (resourceIcon) DestroyIcon(resourceIcon);
  reply("self-test", result, ok ? nullptr : "SELF_TEST_FAILED", ok ? nullptr : "Native renderer self-test failed.");
  if (state.child) DestroyWindow(state.child);
  if (state.parentHook) UnhookWinEvent(state.parentHook);
  if (state.presentationHook) UnhookWinEvent(state.presentationHook);
  restoreHostPainting(); if (state.parentProcess) { CloseHandle(state.parentProcess); state.parentProcess = nullptr; }
  if (parent) DestroyWindow(parent);
  return ok ? 0 : 1;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  if (argc != 2 || (std::wcscmp(argv[1], L"--stream") && std::wcscmp(argv[1], L"--stream-detached") && std::wcscmp(argv[1], L"--stream-test-parent") && std::wcscmp(argv[1], L"--self-test") && std::wcscmp(argv[1], L"--presentation-probe"))) return 2;
  state.detached = !std::wcscmp(argv[1], L"--stream-detached");
  state.allowTestParent = !std::wcscmp(argv[1], L"--stream-test-parent");
  state.foregroundBefore = state.foregroundLast = GetForegroundWindow();
  SetCurrentProcessExplicitAppUserModelID(!std::wcscmp(argv[1], L"--presentation-probe") ? L"com.blackice.agenticworkbench.displaycheck" : L"com.blackice.agenticworkbench");
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  state.perMonitorV2 = AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != FALSE;
  WSADATA sockets; if (WSAStartup(MAKEWORD(2, 2), &sockets)) return 2;
  WLog_SetLogLevel(WLog_GetRoot(), WLOG_ERROR);
  WLog_SetLogAppenderType(WLog_GetRoot(), WLOG_APPENDER_CONSOLE);
  WLog_ConfigureAppender(WLog_GetLogAppender(WLog_GetRoot()), "outputstream", (void*)"stderr");
  state.digestReady = digestPreflight();
  WNDCLASSW child{}; child.lpfnWndProc = childProc; child.hInstance = GetModuleHandleW(nullptr); child.lpszClassName = L"BLACKICEFreeRDPChild"; child.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  WNDCLASSW control{}; control.lpfnWndProc = controlProc; control.hInstance = child.hInstance; control.lpszClassName = L"BLACKICEFreeRDPControl";
  WNDCLASSW detached{}; detached.lpfnWndProc = detachedProc; detached.hInstance = child.hInstance; detached.lpszClassName = L"BLACKICEDetachedWorkbench"; detached.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  detached.hIcon = LoadIconW(child.hInstance, MAKEINTRESOURCEW(101));
  if (!RegisterClassW(&child) || !RegisterClassW(&control) || !RegisterClassW(&detached)) return 2;
  state.control = CreateWindowExW(0, control.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, control.hInstance, nullptr);
  state.stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  state.inputReady = CreateEventW(nullptr, FALSE, FALSE, nullptr); state.releaseDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!state.control || !state.stop || !state.inputReady || !state.releaseDone) return 2;
  if (!std::wcscmp(argv[1], L"--presentation-probe")) { int code = presentationProbe(); CloseHandle(state.stop); CloseHandle(state.inputReady); CloseHandle(state.releaseDone); DestroyWindow(state.control); WSACleanup(); return code; }
  if (!std::wcscmp(argv[1], L"--self-test")) { int code = selfTest(); CloseHandle(state.stop); CloseHandle(state.inputReady); CloseHandle(state.releaseDone); DestroyWindow(state.control); WSACleanup(); return code; }
  SetTimer(state.control, 1, 50, nullptr);
  HANDLE reader = CreateThread(nullptr, 0, readRequests, nullptr, 0, nullptr); if (!reader) return 2; CloseHandle(reader);
  MSG message; while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
  state.visible = false; restoreHostPainting();
  if (state.parentHook) UnhookWinEvent(state.parentHook);
  if (state.presentationHook) UnhookWinEvent(state.presentationHook);
  if (state.parentProcess) { CloseHandle(state.parentProcess); state.parentProcess = nullptr; }
  if (state.launcherProcess) { CloseHandle(state.launcherProcess); state.launcherProcess = nullptr; }
  stopConnection();
  if (state.worker && WaitForSingleObject(state.worker, 100) != WAIT_OBJECT_0) ExitProcess((UINT)message.wParam);
  if (state.worker) CloseHandle(state.worker);
  if (state.child) DestroyWindow(state.child);
  if (state.ownedParent) DestroyWindow(state.ownedParent);
  DestroyWindow(state.control); CloseHandle(state.stop); CloseHandle(state.inputReady); CloseHandle(state.releaseDone); WSACleanup();
  return (int)message.wParam;
}
