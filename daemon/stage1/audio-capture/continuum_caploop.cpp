// continuum_caploop.cpp — PROTOTYPE per-process WASAPI loopback capture for Continuum.
//
// Captures ONE process's render stream at 16k/16-bit/mono and writes raw PCM to stdout. The Python
// supervisor (continuum_calls.py) pipes it, VAD-segments, transcribes, and emits NDJSON. This is the
// "get capture right first" step (see README.md). Productionization note: windows-rs exposes all of
// these APIs, so the shipping helper should be folded into the Rust daemon as one signed binary +
// whisper.cpp, rather than C++ shim + Python runtime — but this validates capture fastest.
//
// Build (Developer Command Prompt):
//   cl /EHsc /std:c++17 continuum_caploop.cpp ole32.lib
// Usage:
//   continuum_caploop.exe <pid>   (writes raw 16k/16-bit/mono PCM to stdout)

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>
#include <wrl/event.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <atomic>

using namespace Microsoft::WRL;

#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"

// Completion handler for the async activation. We just signal an event and
// stash the IAudioClient pointer when activation finishes.
class ActivateHandler :
    public RuntimeClass<RuntimeClassFlags<ClassicCom>,
                        FtmBase,
                        IActivateAudioInterfaceCompletionHandler>
{
public:
    HANDLE doneEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    HRESULT activateResult = E_FAIL;
    ComPtr<IAudioClient> client;

    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override
    {
        HRESULT hrActivate = E_FAIL;
        ComPtr<IUnknown> unk;
        HRESULT hr = op->GetActivateResult(&hrActivate, &unk);
        if (SUCCEEDED(hr)) activateResult = hrActivate;
        if (SUCCEEDED(hr) && SUCCEEDED(hrActivate))
            unk.As(&client);
        SetEvent(doneEvent);
        return S_OK;
    }
};

static std::atomic<bool> g_run{true};
BOOL WINAPI CtrlHandler(DWORD) { g_run = false; return TRUE; }

int wmain(int argc, wchar_t** argv)
{
    if (argc < 2) { fprintf(stderr, "usage: caploop <pid>\n"); return 1; }
    DWORD targetPid = _wtoi(argv[1]);

    // stdout must be binary or Windows will mangle 0x0A bytes.
    _setmode(_fileno(stdout), _O_BINARY);
    SetConsoleCtrlHandler(CtrlHandler, TRUE);

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return 2;

    // Activation params: capture the target PID's process tree (New Teams renders audio in children).
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = targetPid;
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT prop = {};
    prop.vt = VT_BLOB;
    prop.blob.cbSize = sizeof(params);
    prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    auto handler = Make<ActivateHandler>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> asyncOp;
    hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient), &prop, handler.Get(), &asyncOp);
    if (FAILED(hr)) { fprintf(stderr, "activate async failed %lx\n", hr); return 3; }

    WaitForSingleObject(handler->doneEvent, INFINITE);
    if (FAILED(handler->activateResult) || !handler->client) {
        fprintf(stderr, "activation result %lx\n", handler->activateResult); return 4;
    }
    ComPtr<IAudioClient> audio = handler->client;

    // Request Whisper-native format; the loopback client converts for us.
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_PCM;
    fmt.nChannels = 1;
    fmt.nSamplesPerSec = 16000;
    fmt.wBitsPerSample = 16;
    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
    fmt.cbSize = 0;

    // Process loopback MUST use shared mode + the loopback + event-callback flags.
    HANDLE bufEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    hr = audio->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        200 * 10000 /*200ms in 100ns units*/, 0, &fmt, nullptr);
    if (FAILED(hr)) { fprintf(stderr, "Initialize %lx\n", hr); return 5; }

    audio->SetEventHandle(bufEvent);

    ComPtr<IAudioCaptureClient> capture;
    hr = audio->GetService(__uuidof(IAudioCaptureClient), &capture);
    if (FAILED(hr)) return 6;

    hr = audio->Start();
    if (FAILED(hr)) return 7;

    while (g_run) {
        if (WaitForSingleObject(bufEvent, 1000) != WAIT_OBJECT_0) continue;
        BYTE* data; UINT32 frames; DWORD flags;
        while (capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr) == S_OK) {
            if (frames == 0) break;
            size_t bytes = frames * fmt.nBlockAlign;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                // emit zeros so timeline stays aligned
                static BYTE zero[16000];
                size_t left = bytes;
                while (left) { size_t n = left < sizeof(zero) ? left : sizeof(zero);
                               fwrite(zero, 1, n, stdout); left -= n; }
            } else {
                fwrite(data, 1, bytes, stdout);
            }
            fflush(stdout);
            capture->ReleaseBuffer(frames);
        }
    }

    audio->Stop();
    CoUninitialize();
    return 0;
}
