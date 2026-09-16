#!/usr/bin/env bash
# A narrow LGPL-only decoder for the Python worker. No vendor GPL wheel libs.
set -euo pipefail
: "${VIDEO_BUILD_DIR:?Use the isolated video build directory}"
export MACOSX_DEPLOYMENT_TARGET=14.0
DECODER_DIR="${VIDEO_BUILD_DIR}/decoder"
mkdir -p "${DECODER_DIR}"
ARCHIVE="${DECODER_DIR}/ffmpeg-8.0.3.tar.xz"
if [[ ! -f "${ARCHIVE}" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz --output "${ARCHIVE}"
fi
echo "6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818  ${ARCHIVE}" | shasum -a 256 -c -
if [[ ! -d "${DECODER_DIR}/ffmpeg-8.0.3" ]]; then tar -xJf "${ARCHIVE}" -C "${DECODER_DIR}"; fi
cd "${DECODER_DIR}/ffmpeg-8.0.3"
./configure --prefix="${DECODER_DIR}/installed" --cc=/usr/bin/clang --arch=arm64 --target-os=darwin \
  --extra-cflags=-mmacosx-version-min=14.0 --extra-ldflags=-mmacosx-version-min=14.0 \
  --enable-shared --disable-static --enable-pic --disable-autodetect --disable-gpl --disable-nonfree \
  --disable-network --disable-programs --disable-doc --disable-debug --disable-indevs --disable-outdevs \
  --disable-encoders --enable-encoder=mpeg4 --disable-muxers --enable-muxer=mp4 --disable-filters
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
