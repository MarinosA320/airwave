/*
 * Airwave X-Plane plugin.
 *
 * Draws Airwave network traffic in X-Plane 12 using XPMP2 (the library behind LiveTraffic and xPilot).
 * Airwave Pilot sends the smoothed state of every nearby aircraft ~20 times a second as UDP to
 * 127.0.0.1:49010. Each line is:
 *     callsign|type|airline|lat|lon|alt_ft|heading|pitch|roll|groundspeed_kt|gear(0/1)|onGround(0/1)|lights
 * XPMP2 picks a CSL model for each aircraft by ICAO type and airline (model matching), shows it on TCAS
 * and on the map, and the plugin reports back to Airwave Pilot which model it chose.
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

static float FlightLoop(float, float, int, void*) {
    const float now = XPLMGetElapsedTime();
    if (gSockOk) {
        char buf[65536];
        for (int n = 0; n < 50; n++) {
            sockaddr_in from{}; socklen_t fromLen = sizeof(from);
            int len = (int)recvfrom(gSock, buf, sizeof(buf) - 1, 0, (sockaddr*)&from, &fromLen);
            if (len <= 0) break;
            buf[len] = 0;
            if (len < 5 || strncmp(buf, "AWTR", 4) != 0) continue;
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
    return 1;
}

PLUGIN_API int XPluginEnable() {
    gSockOk = OpenSocket();
    const char* err = XPMPMultiplayerEnable();
    if (err && *err) Log(std::string("TCAS/AI control not available: ") + err);
    XPLMRegisterFlightLoopCallback(FlightLoop, -1.0f, nullptr);
    Log(gSockOk ? "listening for Airwave Pilot on 127.0.0.1:49010" : "network not available");
    return 1;
}

PLUGIN_API void XPluginDisable() {
    XPLMUnregisterFlightLoopCallback(FlightLoop, nullptr);
    gPlanes.clear();
    XPMPMultiplayerDisable();
    if (gSockOk) { CLOSESOCK(gSock); gSockOk = false; }
}

PLUGIN_API void XPluginStop() { XPMPMultiplayerCleanup(); }
PLUGIN_API void XPluginReceiveMessage(XPLMPluginID, int, void*) {}
