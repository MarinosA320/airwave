/*
 * Airwave X-Plane plugin.
 *
 * Draws Airwave network traffic in X-Plane 12 using XPMP2 (the library behind LiveTraffic and xPilot).
 * Airwave Pilot sends the smoothed state of every nearby aircraft ~20 times a second as UDP to
 * 127.0.0.1:49010. Each line is:
 *     callsign|type|airline|lat|lon|alt_ft|heading|pitch|roll|groundspeed_kt|gear(0/1)|onGround(0/1)|lights
 * XPMP2 picks a CSL model for each aircraft by ICAO type and airline (model matching), shows it on TCAS
 * and on the map, and the plugin reports back to Airwave Pilot which model it chose.
 *
 * In-sim panel: Airwave Pilot also sends "AWPN" packets (frequency, station, last ATC instruction, radio messages,
 * controllers online) once a second. The plugin shows them in a floating window (Plugins > Airwave, or the command
 * airwave/toggle_panel) and sends button presses back as "AWCM <command>" (readback, tune <freq>, connect, disconnect).
 * airwave/readback reads back the last instruction, so it can be bound to a key or joystick button.
 */
// Windows: the network headers must come before anything that pulls in <windows.h> (the X-Plane SDK does).
#if IBM
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #undef min
  #undef max
#endif
#include "XPLMPlugin.h"
#include "XPLMProcessing.h"
#include "XPLMUtilities.h"
#include "XPLMDisplay.h"
#include "XPLMGraphics.h"
#include "XPLMMenus.h"
#include "XPMPMultiplayer.h"
#include "XPMPAircraft.h"

#include <map>
#include <memory>
#include <string>
#include <vector>
#include <sstream>
#include <cstring>
#include <cstdio>
#include <cmath>
#include <algorithm>

#if IBM
  typedef SOCKET sock_t;
  #define CLOSESOCK closesocket
  static bool sockInvalid(sock_t s) { return s == INVALID_SOCKET; }
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <fcntl.h>
  #include <unistd.h>
  #include <dirent.h>
  #include <sys/stat.h>
  typedef int sock_t;
  #define CLOSESOCK close
  static bool sockInvalid(sock_t s) { return s < 0; }
#endif
#if IBM
  #include <filesystem>
#endif

static const int   AIRWAVE_PORT = 49010;
static const float STALE_AFTER  = 5.0f;   // seconds without an update before an aircraft is removed

static sock_t gSock;
static bool gSockOk = false;
static sockaddr_in gPeer;
static bool gHavePeer = false;
static float gLastStatus = 0;
static std::string gResources;

static void Log(const std::string& s) { XPLMDebugString(("Airwave: " + s + "\n").c_str()); }

// One network aircraft. Position is pushed in from the UDP feed; UpdatePosition just applies it.
struct State {
    double lat = 0, lon = 0, alt = 0;
    float hdg = 0, pitch = 0, roll = 0, gs = 0;
    bool gear = true, gnd = false;
    int lights = 0;
};
class AirwaveAircraft : public XPMP2::Aircraft {
public:
    State s;
    float lastUpdate = 0;
    AirwaveAircraft(const std::string& type, const std::string& airline, const std::string& cs)
        : XPMP2::Aircraft(type, airline, "", 0, "", cs) {
        label = cs;
        strncpy(acInfoTexts.tailNum, cs.c_str(), sizeof(acInfoTexts.tailNum) - 1);
        strncpy(acInfoTexts.icaoAcType, type.c_str(), sizeof(acInfoTexts.icaoAcType) - 1);
        strncpy(acInfoTexts.icaoAirline, airline.c_str(), sizeof(acInfoTexts.icaoAirline) - 1);
        strncpy(acInfoTexts.flightNum, cs.c_str(), sizeof(acInfoTexts.flightNum) - 1);
    }
    void UpdatePosition(float, int) override {
        SetLocation(s.lat, s.lon, s.alt, s.gnd);
        bClampToGround = s.gnd;
        SetHeading(s.hdg); SetPitch(s.pitch); SetRoll(s.roll);
        SetGearRatio(s.gear ? 1.0f : 0.0f);
        SetLightsNav(s.lights & 1); SetLightsBeacon(s.lights & 2); SetLightsStrobe(s.lights & 4);
        SetLightsLanding(s.lights & 8); SetLightsTaxi(s.lights & 16);
        SetTireRotRpm(s.gnd ? s.gs * 30.0f : 0.0f);
        SetEngineRotRpm(1200.0f); SetPropRotRpm(1200.0f);
        SetThrustRatio(s.gnd ? 0.1f : 0.6f);
    }
};
static std::map<std::string, std::unique_ptr<AirwaveAircraft>> gPlanes;

// ------------------------------------------------------------------ UDP
static bool OpenSocket() {
#if IBM
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
    gSock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sockInvalid(gSock)) { Log("could not create socket"); return false; }
    sockaddr_in addr{}; addr.sin_family = AF_INET; addr.sin_port = htons(AIRWAVE_PORT);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(gSock, (sockaddr*)&addr, sizeof(addr)) != 0) { Log("port 49010 is in use, is another copy running?"); CLOSESOCK(gSock); return false; }
#if IBM
    u_long nb = 1; ioctlsocket(gSock, FIONBIO, &nb);
#else
    fcntl(gSock, F_SETFL, fcntl(gSock, F_GETFL, 0) | O_NONBLOCK);
#endif
    return true;
}

static std::vector<std::string> Split(const std::string& s, char sep) {
    std::vector<std::string> out; std::string cur;
    for (char c : s) { if (c == sep) { out.push_back(cur); cur.clear(); } else cur += c; }
    out.push_back(cur);
    return out;
}

static void HandleLine(const std::string& line, float now) {
    auto f = Split(line, '|');
    if (f.size() < 13 || f[0].empty()) return;
    const std::string cs = f[0], type = f[1], airline = f[2];
    auto it = gPlanes.find(cs);
    if (it == gPlanes.end()) {
        try {
            auto p = std::make_unique<AirwaveAircraft>(type.empty() ? "A320" : type, airline, cs);
            it = gPlanes.emplace(cs, std::move(p)).first;
            Log("added " + cs + " " + type + " " + airline + " as " + it->second->GetModelName());
        } catch (const std::exception& e) { Log("could not add " + cs + ": " + e.what()); return; }
    }
    State& s = it->second->s;
    s.lat = atof(f[3].c_str()); s.lon = atof(f[4].c_str()); s.alt = atof(f[5].c_str());
    s.hdg = (float)atof(f[6].c_str()); s.pitch = (float)atof(f[7].c_str()); s.roll = (float)atof(f[8].c_str());
    s.gs = (float)atof(f[9].c_str()); s.gear = f[10] == "1"; s.gnd = f[11] == "1"; s.lights = atoi(f[12].c_str());
    it->second->lastUpdate = now;
}

static void SendStatus() {
    if (!gHavePeer) return;
    std::ostringstream o;
    o << "AWXP {\"models\":" << XPMPGetNumberOfInstalledModels() << ",\"aircraft\":" << gPlanes.size() << ",\"matches\":[";
    bool first = true;
    for (auto& kv : gPlanes) {
        auto& a = *kv.second;
        std::string model = a.GetModelName();
        for (auto& c : model) if (c == '"' || c == '\\') c = '\'';
        o << (first ? "" : ",") << "{\"cs\":\"" << kv.first << "\",\"type\":\"" << a.acIcaoType << "\",\"airline\":\"" << a.acIcaoAirline
          << "\",\"title\":\"" << model << "\",\"livery\":\"\",\"quality\":\"" << (a.GetMatchQuality() <= 1 ? "exact" : a.GetMatchQuality() <= 4 ? "type" : a.GetMatchQuality() <= 9 ? "similar" : "fallback") << "\"}";
        first = false;
    }
    o << "]}";
    std::string msg = o.str();
    sendto(gSock, msg.c_str(), (int)msg.size(), 0, (sockaddr*)&gPeer, sizeof(gPeer));
}

// ------------------------------------------------------------------ in-sim panel
struct PanelInstr { int id = 0; bool readBack = false; std::string from, text, contactFreq; };
struct PanelAtc { std::string id, freq, name; };
struct PanelMsg { std::string from, text; bool mine = false; };
struct Panel {
    std::string net = "offline", callsign, netText = "Start Airwave Pilot on this computer", freq = "---.---", station, squawk;
    PanelInstr instr;
    std::vector<PanelAtc> atc;
    std::vector<PanelMsg> msgs;
    float seen = -100;
};
static Panel gPanel;
static XPLMWindowID gWin = nullptr;
static XPLMCommandRef gCmdToggle = nullptr, gCmdReadback = nullptr, gCmdPtt = nullptr;
static int gLastInstrShown = 0;
struct Button { int l, t, r, b; std::string action; };
static std::vector<Button> gButtons;

static void SendCommand(const std::string& c) {
    if (!gSockOk || !gHavePeer) return;
    std::string msg = "AWCM " + c;
    sendto(gSock, msg.c_str(), (int)msg.size(), 0, (sockaddr*)&gPeer, sizeof(gPeer));
}

// AWPN lines: N|net|callsign|text  F|freq|station|squawk  I|id|readBack|from|text|contactFreq  A|id|freq|name  M|from|text|mine
static void HandlePanel(const std::string& body, float now) {
    Panel p; p.seen = now;
    std::istringstream in(body); std::string line;
    while (std::getline(in, line)) {
        auto f = Split(line, '|');
        if (f.empty()) continue;
        if (f[0] == "N" && f.size() >= 4) { p.net = f[1]; p.callsign = f[2]; p.netText = f[3]; }
        else if (f[0] == "F" && f.size() >= 4) { p.freq = f[1]; p.station = f[2]; p.squawk = f[3]; }
        else if (f[0] == "I" && f.size() >= 6) { p.instr.id = atoi(f[1].c_str()); p.instr.readBack = f[2] == "1"; p.instr.from = f[3]; p.instr.text = f[4]; p.instr.contactFreq = f[5]; }
        else if (f[0] == "A" && f.size() >= 4) p.atc.push_back({ f[1], f[2], f[3] });
        else if (f[0] == "M" && f.size() >= 4) p.msgs.push_back({ f[1], f[2], f[3] == "1" });
    }
    // A new ATC instruction opens the panel so it is not missed.
    if (p.instr.id && p.instr.id != gLastInstrShown && !p.instr.readBack) {
        gLastInstrShown = p.instr.id;
        if (gWin && !XPLMGetWindowIsVisible(gWin)) XPLMSetWindowIsVisible(gWin, 1);
    }
    gPanel = p;
}

static const float COL_TEXT[] = { 0.84f, 0.89f, 0.90f }, COL_MUTED[] = { 0.49f, 0.58f, 0.60f }, COL_BLUE[] = { 0.50f, 0.83f, 0.94f },
                   COL_AMBER[] = { 0.94f, 0.75f, 0.31f }, COL_GREEN[] = { 0.45f, 0.83f, 0.62f };
static void Text(const float* c, int x, int y, const std::string& s) { XPLMDrawString(const_cast<float*>(c), x, y, const_cast<char*>(s.c_str()), nullptr, xplmFont_Proportional); }
static int TextWidth(const std::string& s) { return (int)XPLMMeasureString(xplmFont_Proportional, s.c_str(), (int)s.size()); }
// Splits text into lines that fit the width.
static std::vector<std::string> Wrap(const std::string& s, int width) {
    std::vector<std::string> out; std::string line, word; std::istringstream in(s);
    while (in >> word) {
        std::string next = line.empty() ? word : line + " " + word;
        if (!line.empty() && TextWidth(next) > width) { out.push_back(line); line = word; } else line = next;
    }
    if (!line.empty()) out.push_back(line);
    return out;
}
static void DrawButton(int l, int t, const std::string& label, const std::string& action, const float* color, int minW = 0) {
    int w = std::max(minW, TextWidth(label) + 16), h = 20;
    XPLMDrawTranslucentDarkBox(l, t, l + w, t - h);
    Text(color, l + 8, t - 14, label);
    gButtons.push_back({ l, t, l + w, t - h, action });
}

static void DrawPanel(XPLMWindowID id, void*) {
    int l, t, r, b; XPLMGetWindowGeometry(id, &l, &t, &r, &b);
    XPLMSetGraphicsState(0, 0, 0, 0, 1, 1, 0);
    gButtons.clear();
    const int pad = 10, width = r - l - 2 * pad, lh = 15;
    int x = l + pad, y = t - 18;
    const bool linked = XPLMGetElapsedTime() - gPanel.seen < 4.0f;
    if (!linked) {
        for (auto& ln : Wrap("Airwave Pilot is not running. Start it from the desktop shortcut and choose X-Plane 12; this window connects by itself.", width)) { Text(COL_MUTED, x, y, ln); y -= lh; }
        return;
    }
    // status line
    Text(gPanel.net == "online" ? COL_GREEN : gPanel.net == "connecting" ? COL_AMBER : COL_MUTED, x, y, gPanel.callsign.empty() ? gPanel.net : gPanel.callsign + "  " + gPanel.net);
    DrawButton(r - pad - 90, y + 14, gPanel.net == "offline" ? "Connect" : "Disconnect", gPanel.net == "offline" ? "connect" : "disconnect", COL_TEXT, 90);
    y -= 26;
    // frequency
    Text(COL_BLUE, x, y, "COM1 " + gPanel.freq);
    Text(COL_TEXT, x + 100, y, gPanel.station);
    if (!gPanel.squawk.empty()) Text(COL_MUTED, r - pad - 60, y, "SQ " + gPanel.squawk);
    y -= 22;
    // last instruction and read back
    if (gPanel.instr.id) {
        Text(COL_AMBER, x, y, gPanel.instr.from); y -= lh;
        for (auto& ln : Wrap(gPanel.instr.text, width)) { Text(COL_TEXT, x, y, ln); y -= lh; }
        y -= 2;
        if (gPanel.instr.readBack) { Text(COL_GREEN, x, y - 13, "Read back"); y -= 26; }
        else {
            DrawButton(x, y, gPanel.instr.contactFreq.empty() ? "Read back" : "Read back and switch to " + gPanel.instr.contactFreq, "readback", COL_AMBER, width);
            y -= 26;
        }
        // Quick replies
        const char* labels[] = { "Wilco", "Unable", "Say again", "Standby" };
        const char* kinds[] = { "wilco", "unable", "sayagain", "standby" };
        const int qw = (width - 3 * 4) / 4;
        for (int q = 0; q < 4; q++) DrawButton(x + q * (qw + 4), y, labels[q], std::string("req ") + kinds[q], COL_TEXT, qw);
        y -= 28;
    }
    // radio messages (newest last)
    Text(COL_MUTED, x, y, "RADIO"); y -= lh;
    std::vector<std::pair<const float*, std::string>> lines;
    for (auto& m : gPanel.msgs) for (auto& ln : Wrap(m.from + ": " + m.text, width)) lines.push_back({ m.mine ? COL_BLUE : COL_TEXT, ln });
    const int atcRows = (int)((gPanel.atc.size() + 1) / 2);
    const int room = std::max(1, (y - b - 30 - atcRows * 24) / lh);
    for (size_t i = lines.size() > (size_t)room ? lines.size() - room : 0; i < lines.size(); i++) { Text(lines[i].first, x, y, lines[i].second); y -= lh; }
    if (lines.empty()) { Text(COL_MUTED, x, y, "Messages on your frequency appear here."); y -= lh; }
    // controllers online: click to tune
    y = b + 10 + atcRows * 24;
    Text(COL_MUTED, x, y, gPanel.atc.empty() ? "No controllers online" : "ATC ONLINE - click to tune"); y -= 6;
    const int colW = (width - 6) / 2;
    for (size_t i = 0; i < gPanel.atc.size(); i++) {
        auto& a = gPanel.atc[i];
        DrawButton(x + (int)(i % 2) * (colW + 6), y - (int)(i / 2) * 24, a.id + "  " + a.freq, "tune " + a.freq, a.freq == gPanel.freq ? COL_BLUE : COL_TEXT, colW);
    }
}
static int ClickPanel(XPLMWindowID, int x, int y, XPLMMouseStatus status, void*) {
    if (status != xplm_MouseDown) return 1;
    for (auto& btn : gButtons) if (x >= btn.l && x <= btn.r && y <= btn.t && y >= btn.b) { SendCommand(btn.action); break; }
    return 1;
}
static void KeyPanel(XPLMWindowID, char, XPLMKeyFlags, char, void*, int) {}
static XPLMCursorStatus CursorPanel(XPLMWindowID, int, int, void*) { return xplm_CursorDefault; }
static int WheelPanel(XPLMWindowID, int, int, int, int, void*) { return 0; }

static void CreatePanel() {
    int sl, st, sr, sb; XPLMGetScreenBoundsGlobal(&sl, &st, &sr, &sb);
    XPLMCreateWindow_t w{}; w.structSize = sizeof(w);
    w.left = sr - 400; w.right = sr - 40; w.top = st - 120; w.bottom = st - 560;
    w.visible = 0; w.drawWindowFunc = DrawPanel; w.handleMouseClickFunc = ClickPanel; w.handleRightClickFunc = ClickPanel;
    w.handleKeyFunc = KeyPanel; w.handleCursorFunc = CursorPanel; w.handleMouseWheelFunc = WheelPanel;
    w.decorateAsFloatingWindow = xplm_WindowDecorationRoundRectangle; w.layer = xplm_WindowLayerFloatingWindows;
    gWin = XPLMCreateWindowEx(&w);
    XPLMSetWindowPositioningMode(gWin, xplm_WindowPositionFree, -1);
    XPLMSetWindowResizingLimits(gWin, 300, 300, 800, 1200);
    XPLMSetWindowTitle(gWin, "Airwave");
}
static int OnCommand(XPLMCommandRef cmd, XPLMCommandPhase phase, void*) {
    if (phase != xplm_CommandBegin) return 0;
    if (cmd == gCmdToggle && gWin) XPLMSetWindowIsVisible(gWin, !XPLMGetWindowIsVisible(gWin));
    if (cmd == gCmdReadback && gPanel.instr.id && !gPanel.instr.readBack) SendCommand("readback");
    return 0;
}
// Push-to-talk: held down = transmitting. Airwave Pilot passes it on to its window, which has the microphone.
static int OnPtt(XPLMCommandRef, XPLMCommandPhase phase, void*) {
    if (phase == xplm_CommandBegin) SendCommand("ptt 1");
    else if (phase == xplm_CommandEnd) SendCommand("ptt 0");
    return 0;
}

static float FlightLoop(float, float, int, void*) {
    const float now = XPLMGetElapsedTime();
    if (gSockOk) {
        char buf[65536];
        for (int n = 0; n < 50; n++) {
            sockaddr_in from{}; socklen_t fromLen = sizeof(from);
            int len = (int)recvfrom(gSock, buf, sizeof(buf) - 1, 0, (sockaddr*)&from, &fromLen);
            if (len <= 0) break;
            buf[len] = 0;
            if (len < 5) continue;
            if (strncmp(buf, "AWPN", 4) == 0) { gPeer = from; gHavePeer = true; HandlePanel(std::string(buf + 5, len - 5), now); continue; }
            if (strncmp(buf, "AWTR", 4) != 0) continue;
            gPeer = from; gHavePeer = true;
            std::istringstream in(std::string(buf + 5, len - 5));
            std::string line;
            while (std::getline(in, line)) if (!line.empty()) HandleLine(line, now);
        }
    }
    for (auto it = gPlanes.begin(); it != gPlanes.end();) {
        if (now - it->second->lastUpdate > STALE_AFTER) { Log("removed " + it->first); it = gPlanes.erase(it); }
        else ++it;
    }
    if (now - gLastStatus > 2.0f) { gLastStatus = now; SendStatus(); }
    return -1.0f; // every frame
}

// ------------------------------------------------------------------ CSL packages
static void LoadCSL(const std::string& cslRoot) {
    int before = XPMPGetNumberOfInstalledModels();
#if IBM
    std::error_code ec;
    for (auto& e : std::filesystem::directory_iterator(cslRoot, ec))
        if (e.is_directory()) { const char* err = XPMPLoadCSLPackage(e.path().string().c_str()); if (err && *err) Log(std::string("CSL: ") + err); }
#else
    if (DIR* d = opendir(cslRoot.c_str())) {
        while (dirent* e = readdir(d)) {
            if (e->d_name[0] == '.') continue;
            std::string p = cslRoot + "/" + e->d_name; struct stat st{};
            if (stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) { const char* err = XPMPLoadCSLPackage(p.c_str()); if (err && *err) Log(std::string("CSL: ") + err); }
        }
        closedir(d);
    }
#endif
    Log("loaded " + std::to_string(XPMPGetNumberOfInstalledModels() - before) + " CSL models from " + cslRoot);
}

static int PrefsInt(const char*, const char* item, int def) {
    if (!strcmp(item, XPMP_CFG_ITM_MODELMATCHING)) return 1;   // log model matching decisions
    if (!strcmp(item, XPMP_CFG_ITM_LOGLEVEL)) return 1;         // info
    return def;
}

// ------------------------------------------------------------------ X-Plane entry points
PLUGIN_API int XPluginStart(char* name, char* sig, char* desc) {
    strcpy(name, "Airwave");
    strcpy(sig, "net.airwave.xplane");
    strcpy(desc, "Shows Airwave network traffic (uses XPMP2)");
    XPLMEnableFeature("XPLM_USE_NATIVE_PATHS", 1);
    char path[1024]; XPLMGetPluginInfo(XPLMGetMyID(), nullptr, path, nullptr, nullptr);
    std::string p(path);                              // .../plugins/Airwave/win_x64/Airwave.xpl
    for (int i = 0; i < 2; i++) { auto pos = p.find_last_of("/\\"); if (pos != std::string::npos) p.erase(pos); }
    gResources = p + XPLMGetDirectorySeparator() + "Resources";
    const char* err = XPMPMultiplayerInit("Airwave", gResources.c_str(), PrefsInt, "A320", "AW");
    if (err && *err) { Log(std::string("init failed: ") + err); return 0; }
    LoadCSL(gResources + XPLMGetDirectorySeparator() + "CSL");
    // Panel commands (bindable to keys and joystick buttons) and the Plugins > Airwave menu
    gCmdToggle = XPLMCreateCommand("airwave/toggle_panel", "Airwave: show or hide the ATC panel");
    gCmdReadback = XPLMCreateCommand("airwave/readback", "Airwave: read back the last ATC instruction");
    gCmdPtt = XPLMCreateCommand("airwave/ptt", "Airwave: push to talk (hold)");
    XPLMRegisterCommandHandler(gCmdPtt, OnPtt, 1, nullptr);
    XPLMRegisterCommandHandler(gCmdToggle, OnCommand, 1, nullptr);
    XPLMRegisterCommandHandler(gCmdReadback, OnCommand, 1, nullptr);
    int item = XPLMAppendMenuItem(XPLMFindPluginsMenu(), "Airwave", nullptr, 0);
    XPLMMenuID menu = XPLMCreateMenu("Airwave", XPLMFindPluginsMenu(), item, nullptr, nullptr);
    XPLMAppendMenuItemWithCommand(menu, "Show / hide ATC panel", gCmdToggle);
    XPLMAppendMenuItemWithCommand(menu, "Read back last instruction", gCmdReadback);
    return 1;
}

PLUGIN_API int XPluginEnable() {
    gSockOk = OpenSocket();
    const char* err = XPMPMultiplayerEnable();
    if (err && *err) Log(std::string("TCAS/AI control not available: ") + err);
    XPLMRegisterFlightLoopCallback(FlightLoop, -1.0f, nullptr);
    if (!gWin) CreatePanel();
    Log(gSockOk ? "listening for Airwave Pilot on 127.0.0.1:49010" : "network not available");
    return 1;
}

PLUGIN_API void XPluginDisable() {
    XPLMUnregisterFlightLoopCallback(FlightLoop, nullptr);
    if (gWin) { XPLMDestroyWindow(gWin); gWin = nullptr; }
    gPlanes.clear();
    XPMPMultiplayerDisable();
    if (gSockOk) { CLOSESOCK(gSock); gSockOk = false; }
}

PLUGIN_API void XPluginStop() {
    XPLMUnregisterCommandHandler(gCmdToggle, OnCommand, 1, nullptr);
    XPLMUnregisterCommandHandler(gCmdReadback, OnCommand, 1, nullptr);
    XPLMUnregisterCommandHandler(gCmdPtt, OnPtt, 1, nullptr);
    XPMPMultiplayerCleanup();
}
PLUGIN_API void XPluginReceiveMessage(XPLMPluginID, int, void*) {}
