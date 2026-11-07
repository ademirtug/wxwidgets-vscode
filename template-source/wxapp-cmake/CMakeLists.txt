cmake_minimum_required(VERSION 3.20)

project(wxapp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(_wxapp_bin_dir "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${_wxapp_bin_dir}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_DEBUG "${_wxapp_bin_dir}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE "${_wxapp_bin_dir}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${_wxapp_bin_dir}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${_wxapp_bin_dir}")

find_package(wxWidgets REQUIRED COMPONENTS core base)
include(${wxWidgets_USE_FILE})

file(GLOB_RECURSE WXAPP_SOURCES CONFIGURE_DEPENDS
  "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/*.cxx"
  "${CMAKE_CURRENT_SOURCE_DIR}/*.cc"
  "${CMAKE_CURRENT_SOURCE_DIR}/*.c"
)

list(FILTER WXAPP_SOURCES EXCLUDE REGEX ".*/build/.*")
list(FILTER WXAPP_SOURCES EXCLUDE REGEX ".*/\\.git/.*")

if(WIN32)
  add_executable(${PROJECT_NAME} WIN32
    ${WXAPP_SOURCES}
    "${CMAKE_CURRENT_SOURCE_DIR}/resources/app.rc"
  )
elseif(APPLE)
  add_executable(${PROJECT_NAME} MACOSX_BUNDLE ${WXAPP_SOURCES})
  set_target_properties(${PROJECT_NAME} PROPERTIES MACOSX_BUNDLE_BUNDLE_NAME "${PROJECT_NAME}")
else()
  add_executable(${PROJECT_NAME}
    ${WXAPP_SOURCES}
  )
endif()

target_link_libraries(${PROJECT_NAME} PRIVATE ${wxWidgets_LIBRARIES})
target_include_directories(${PROJECT_NAME} PRIVATE ${wxWidgets_INCLUDE_DIRS})

if(WIN32)
  target_compile_definitions(${PROJECT_NAME} PRIVATE UNICODE _UNICODE)
endif()
