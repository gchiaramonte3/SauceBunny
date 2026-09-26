#!/usr/bin/env bash
# LGPL-only media libraries for local decoding and Apple's H.264 proxy encoder.
# No vendor GPL wheel libs and no external child encoder to orphan on Stop.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${VIDEO_BUILD_DIR:?Use the isolated video build directory}"
export MACOSX_DEPLOYMENT_TARGET=14.0
DECODER_DIR="${VIDEO_BUILD_DIR}/decoder"
mkdir -p "${DECODER_DIR}"
BUILD_PYTHON="${VIDEO_BUILD_DIR}/venv/bin/python"
"${BUILD_PYTHON}" -m pip install --require-hashes --only-binary=:all: -r "${ROOT_DIR}/video-sidecar/requirements-decoder.txt" -r "${ROOT_DIR}/video-sidecar/requirements-compiler.txt"
export PATH="${VIDEO_BUILD_DIR}/venv/bin:/usr/bin:/bin:/usr/sbin"
export FORCE_PKGCONF_PYPI=1
export PKG_CONFIG_PATH="${DECODER_DIR}/installed/lib/pkgconfig"
DAV1D_ARCHIVE="${DECODER_DIR}/dav1d-1.5.3.tar.xz"
if [[ ! -f "${DAV1D_ARCHIVE}" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 https://downloads.videolan.org/pub/videolan/dav1d/1.5.3/dav1d-1.5.3.tar.xz --output "${DAV1D_ARCHIVE}"
fi
echo "732010aa5ef461fa93355ed2c6c5fedb48ddc4b74e697eaabe8907eaeb943011  ${DAV1D_ARCHIVE}" | shasum -a 256 -c -
if [[ ! -d "${DECODER_DIR}/dav1d-1.5.3" ]]; then tar -xJf "${DAV1D_ARCHIVE}" -C "${DECODER_DIR}"; fi
# BSD decoder, shared so its identity and license remain inspectable. No GPL
# libraries and no changes to PTS, frame cadence, or subprocess ownership.
meson setup --reconfigure "${DECODER_DIR}/dav1d-build" "${DECODER_DIR}/dav1d-1.5.3" \
  --prefix="${DECODER_DIR}/installed" --buildtype=release -Ddefault_library=shared \
  -Denable_tools=false -Denable_tests=false -Dc_args=-mmacosx-version-min=14.0 -Dc_link_args=-mmacosx-version-min=14.0
meson compile -C "${DECODER_DIR}/dav1d-build" -j 8
meson install -C "${DECODER_DIR}/dav1d-build"
ARCHIVE="${DECODER_DIR}/ffmpeg-8.0.3.tar.xz"
if [[ ! -f "${ARCHIVE}" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz --output "${ARCHIVE}"
fi
echo "6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818  ${ARCHIVE}" | shasum -a 256 -c -
if [[ ! -d "${DECODER_DIR}/ffmpeg-8.0.3" ]]; then tar -xJf "${ARCHIVE}" -C "${DECODER_DIR}"; fi
cd "${DECODER_DIR}/ffmpeg-8.0.3"
./configure --prefix="${DECODER_DIR}/installed" --cc=/usr/bin/clang --arch=arm64 --target-os=darwin \
  --extra-cflags="-mmacosx-version-min=14.0 -I${DECODER_DIR}/installed/include" --extra-ldflags="-mmacosx-version-min=14.0 -L${DECODER_DIR}/installed/lib" \
  --enable-shared --disable-static --enable-pic --disable-autodetect --disable-gpl --disable-nonfree \
  --enable-libdav1d \
  --disable-network --disable-programs --disable-doc --disable-debug --disable-indevs --disable-outdevs \
  --disable-encoders --enable-encoder=mpeg4,h264_videotoolbox --enable-videotoolbox \
  --disable-muxers --enable-muxer=mp4 --disable-filters --enable-filter=aformat,aresample,abuffer,abuffersink
# PyAV's AudioResampler uses aformat with auto-inserted aresample. Keep the
# existing in-process decoder owner rather than adding a second audio process.
# Reused scratch directories must not link objects from a newer deployment OS.
make clean
make -j8
make install
mkdir -p "${DECODER_DIR}/notices"
cp COPYING.LGPLv2.1 LICENSE.md "${DECODER_DIR}/notices/"
# The exact source and configure recipe travel with the binary, not a link to
# a moving upstream branch or a promise that a future maintainer will find it.
cp "${ARCHIVE}" "${DECODER_DIR}/notices/"
cp ffbuild/config.log "${DECODER_DIR}/notices/configure.log"
cp "${DAV1D_ARCHIVE}" "${DECODER_DIR}/notices/"
cp "${DECODER_DIR}/dav1d-1.5.3/COPYING" "${DECODER_DIR}/notices/dav1d-COPYING"
