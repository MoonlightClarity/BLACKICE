#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>
#include <set>

static std::string quoted(const std::string & s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        if (c == '\\' || c == '"') { out += '\\'; out += c; }
        else if (c < 32) { char buf[7]; std::snprintf(buf, sizeof(buf), "\\u%04x", c); out += buf; }
        else { out += c; }
    }
    return out + "\"";
}

static void module_file(HANDLE file) {
    if (!file || file == INVALID_HANDLE_VALUE) {
        std::puts("{\"event\":\"module_path_unavailable\"}");
        return;
    }
    char name[32768];
    DWORD size = GetFinalPathNameByHandleA(file, name, sizeof(name), FILE_NAME_NORMALIZED);
    if (!size || size >= sizeof(name)) {
        std::printf("{\"event\":\"module_path_error\",\"code\":%lu}\n", GetLastError());
    } else {
        std::printf("{\"event\":\"module\",\"path\":%s}\n", quoted(std::string(name, size)).c_str());
    }
    CloseHandle(file);
}

int main(int argc, char ** argv) {
    if (argc != 3) { std::fputs("Usage: dll-load-probe <server.exe> <output-directory>\n", stderr); return 2; }
    SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, TRUE };
    std::string out_path = std::string(argv[2]) + "\\device-probe.stdout.log";
    std::string err_path = std::string(argv[2]) + "\\device-probe.stderr.log";
    HANDLE out = CreateFileA(out_path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    HANDLE err = CreateFileA(err_path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (out == INVALID_HANDLE_VALUE || err == INVALID_HANDLE_VALUE) { std::fprintf(stderr, "OUTPUT_CREATE:%lu\n", GetLastError()); return 3; }
    STARTUPINFOA si{}; si.cb = sizeof(si); si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE); si.hStdOutput = out; si.hStdError = err;
    PROCESS_INFORMATION pi{};
    std::string command = "\"" + std::string(argv[1]) + "\" --list-devices";
    if (!CreateProcessA(argv[1], command.data(), nullptr, nullptr, TRUE, DEBUG_ONLY_THIS_PROCESS | CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        std::fprintf(stderr, "PROCESS_CREATE:%lu\n", GetLastError()); CloseHandle(out); CloseHandle(err); return 4;
    }
    CloseHandle(out); CloseHandle(err);
    std::set<HANDLE> handles{pi.hProcess, pi.hThread};
    const ULONGLONG deadline = GetTickCount64() + 30000;
    bool terminating = false, exited = false;
    DWORD exit_code = STILL_ACTIVE;
    while (!exited) {
        if (!terminating && GetTickCount64() > deadline) { TerminateProcess(pi.hProcess, 124); terminating = true; }
        DEBUG_EVENT ev{};
        if (!WaitForDebugEvent(&ev, 1000)) {
            if (GetLastError() != ERROR_SEM_TIMEOUT) { std::fprintf(stderr, "DEBUG_WAIT:%lu\n", GetLastError()); break; }
            continue;
        }
        DWORD status = DBG_CONTINUE;
        switch (ev.dwDebugEventCode) {
            case CREATE_PROCESS_DEBUG_EVENT:
                handles.insert(ev.u.CreateProcessInfo.hProcess);
                handles.insert(ev.u.CreateProcessInfo.hThread);
                std::printf("{\"event\":\"process\",\"pid\":%lu}\n", ev.dwProcessId);
                module_file(ev.u.CreateProcessInfo.hFile);
                break;
            case CREATE_THREAD_DEBUG_EVENT:
                handles.insert(ev.u.CreateThread.hThread);
                break;
            case LOAD_DLL_DEBUG_EVENT:
                module_file(ev.u.LoadDll.hFile);
                break;
            case EXCEPTION_DEBUG_EVENT:
                status = ev.u.Exception.ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT ? DBG_CONTINUE : DBG_EXCEPTION_NOT_HANDLED;
                break;
            case EXIT_PROCESS_DEBUG_EVENT:
                exit_code = ev.u.ExitProcess.dwExitCode;
                exited = true;
                std::printf("{\"event\":\"exit\",\"code\":%lu,\"timedOut\":%s}\n", exit_code, terminating ? "true" : "false");
                break;
            default: break;
        }
        if (!ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status)) { std::fprintf(stderr, "DEBUG_CONTINUE:%lu\n", GetLastError()); break; }
    }
    if (!exited) { TerminateProcess(pi.hProcess, 125); WaitForSingleObject(pi.hProcess, 5000); }
    for (HANDLE h : handles) { if (h && h != INVALID_HANDLE_VALUE) { CloseHandle(h); } }
    return exited && exit_code == 0 && !terminating ? 0 : 1;
}
