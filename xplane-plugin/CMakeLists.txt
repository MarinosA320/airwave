# Airwave X-Plane plugin (Airwave.xpl), built on XPMP2.
# Get XPMP2 first with get-xpmp2.sh / get-xpmp2.cmd, then:
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release
# Setup follows TwinFan's XPMP2-Sample.

cmake_minimum_required(VERSION 3.16)
if(APPLE)
    set(CMAKE_OSX_ARCHITECTURES "x86_64;arm64" CACHE STRING "Archs to build")
endif()
project(Airwave VERSION 0.3.0 DESCRIPTION "Airwave X-Plane plugin")

if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/lib/XPMP2/CMakeLists.txt")
    message(FATAL_ERROR "XPMP2 is missing. Run get-xpmp2.sh (Mac/Linux) or get-xpmp2.cmd (Windows) first.")
endif()

if(WIN32)
    add_compile_definitions(_WIN32_WINNT=0x0601)
elseif(APPLE)
    set(CMAKE_OSX_DEPLOYMENT_TARGET 10.15)
    add_compile_options(-mmacosx-version-min=10.15)
    add_link_options(-mmacosx-version-min=10.15)
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_compile_definitions(XPLM200=1 XPLM210=1 XPLM300=1 XPLM301=1 XPLM303=1 XPLM400=1)
add_compile_definitions(APL=$<BOOL:${APPLE}> IBM=$<BOOL:${WIN32}> LIN=$<AND:$<BOOL:${UNIX}>,$<NOT:$<BOOL:${APPLE}>>>)

if(MSVC)
    add_compile_options(/wd4996 /wd4068)
    add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX)
else()
    add_compile_options(-Wall -Wextra -Wno-deprecated-declarations -Wno-unknown-pragmas -fexceptions -fvisibility=hidden -fPIC)
endif()
if(NOT CMAKE_BUILD_TYPE MATCHES "Debug")
    add_compile_definitions(NDEBUG=1)
    if(NOT MSVC)
        add_compile_options(-O2)
    endif()
endif()

add_library(Airwave MODULE AirwaveXP.cpp)
target_include_directories(Airwave PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/lib/XPMP2/lib/SDK/CHeaders/XPLM
    ${CMAKE_CURRENT_SOURCE_DIR}/lib/XPMP2/inc)

if(APPLE)
    list(APPEND CMAKE_FRAMEWORK_PATH "${CMAKE_CURRENT_SOURCE_DIR}/lib/XPMP2/lib/SDK/Libraries/Mac")
else()
    list(APPEND CMAKE_LIBRARY_PATH "${CMAKE_CURRENT_SOURCE_DIR}/lib/XPMP2/lib/SDK/Libraries/Win")
endif()
if(WIN32 OR APPLE)
    find_library(XPLM_LIBRARY XPLM REQUIRED NAMES XPLM_64.lib)
endif()

# MinGW with GCC 13+ has native std::thread/std::future; XPMP2's bundled mingw-std-threads would clash with them.
if(MINGW AND CMAKE_CXX_COMPILER_VERSION VERSION_GREATER_EQUAL 13)
    add_library(mingw_stdthreads INTERFACE)
endif()
add_subdirectory(lib/XPMP2)
add_dependencies(Airwave XPMP2)
target_link_libraries(Airwave XPMP2)

if(WIN32)
    target_link_libraries(Airwave ${XPLM_LIBRARY} wsock32 ws2_32 iphlpapi)
    if(MINGW)
        target_link_options(Airwave PRIVATE -static -static-libgcc -static-libstdc++ -s)
    endif()
elseif(APPLE)
    find_library(IOKIT_LIBRARY IOKit REQUIRED)
    find_library(CORE_FOUNDATION_LIBRARY CoreFoundation REQUIRED)
    target_link_libraries(Airwave ${XPLM_LIBRARY} ${IOKIT_LIBRARY} ${CORE_FOUNDATION_LIBRARY}
        "-exported_symbols_list ${CMAKE_CURRENT_SOURCE_DIR}/AirwaveXP.sym_mac")
else()
    find_library(DL_LIBRARY dl REQUIRED)
    set(THREADS_PREFER_PTHREAD_FLAG TRUE)
    find_package(Threads REQUIRED)
    target_link_libraries(Airwave ${DL_LIBRARY} Threads::Threads)
    target_link_options(Airwave PRIVATE -Wl,--version-script -Wl,${CMAKE_CURRENT_SOURCE_DIR}/AirwaveXP.sym)
endif()

if(WIN32)
    set(ARCH_DIR win_x64)
elseif(APPLE)
    set(ARCH_DIR mac_x64)
else()
    set(ARCH_DIR lin_x64)
endif()
# Every configuration lands in <build>/<arch>/Airwave.xpl, the layout X-Plane expects.
set_target_properties(Airwave PROPERTIES
    PREFIX "" OUTPUT_NAME "Airwave" SUFFIX ".xpl"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/${ARCH_DIR}"
    LIBRARY_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/${ARCH_DIR}"
    LIBRARY_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/${ARCH_DIR}")
