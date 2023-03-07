ARG IMAGE=amd64/debian:buster-slim
#ARG IMAGE=amd64/debian:bullseye-slim

FROM $IMAGE as builder
WORKDIR /build

ARG NASM_VERSION=2.14.02
ARG LAME_VERSION=3.100
ARG FFMPEG_VERSION=4.4.1
ARG NGINX_VERSION=1.21.3
ARG NGINXRTMP_VERSION=1.2.2
ARG NODE_VERSION=16.13.0

ENV SRC="/usr/local" \
    LD_LIBRARY_PATH="/usr/local/lib" \
    PKG_CONFIG_PATH="/usr/local/lib/pkgconfig"

RUN apt-get update && apt-get install -y \
curl \
gcc \
libpcre3-dev \
libtool \
libssl-dev \
libasound2-dev \
# build-essential \
make \
pkg-config \
# texinfo \
zlib1g-dev

# nasm
RUN --mount=type=tmpfs,target=/build \
curl -L "https://www.nasm.us/pub/nasm/releasebuilds/${NASM_VERSION}/nasm-${NASM_VERSION}.tar.xz" | tar -xvJ \
&& cd nasm-${NASM_VERSION} \
&& ./configure \
&& make -j$(nproc) \
&& make install

# x264
RUN --mount=type=tmpfs,target=/build \
curl -L https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.bz2 | tar -xvj \
&& cd x264-stable \
&& ./configure --prefix="${SRC}" --bindir="${SRC}/bin" --enable-shared \
&& make -j$(nproc) \
&& make install

# libmp3lame
RUN --mount=type=tmpfs,target=/build \
curl -L "https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz" | tar -xvz \
&& cd lame-${LAME_VERSION} \
&& ./configure --prefix="${SRC}" --bindir="${SRC}/bin" --disable-static --enable-nasm \
&& make -j$(nproc) \
&& make install

# ffmpeg && patch
# COPY ./contrib/ffmpeg /dist/restreamer/contrib/ffmpeg
# patch -p1 < /dist/restreamer/contrib/ffmpeg/bitrate.patch && \

RUN --mount=type=tmpfs,target=/build \
curl -L "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.gz" | tar -xvz \
&& cd ffmpeg-${FFMPEG_VERSION} \
&& ./configure \
    --bindir="${SRC}/bin" \
    --extra-cflags="-I${SRC}/include" \
    --extra-ldflags="-L${SRC}/lib" \
    --prefix="${SRC}" \
    --enable-nonfree \
    --enable-gpl \
    --enable-version3 \
    --enable-libmp3lame \
    --enable-libx264 \
    --enable-openssl \
    --enable-postproc \
    --enable-small \
    --enable-static \
    --disable-debug \
    --disable-doc \
    --disable-shared \
&& make -j$(nproc) \
&& make install

# nginx-rtmp
RUN --mount=type=tmpfs,target=/build \
curl -L "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" | tar -xvz \
&& curl -L "https://github.com/arut/nginx-rtmp-module/archive/v${NGINXRTMP_VERSION}.tar.gz" | tar -xvz \
&& sed -i"" -e '/case ESCAPE:/i /* fall through */' nginx-rtmp-module-${NGINXRTMP_VERSION}/ngx_rtmp_eval.c \
&& cd nginx-${NGINX_VERSION} \
&& ./configure --prefix=/usr/local/nginx --with-http_ssl_module --with-http_v2_module --add-module=/build/nginx-rtmp-module-${NGINXRTMP_VERSION} \
&& make -j$(nproc) \
&& make install

# node.js
RUN --mount=type=tmpfs,target=/build \
curl -L "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xvJ \
&& cd node-v${NODE_VERSION}-linux-x64 \
&& cp -R bin lib /usr/local

COPY run.sh package.json package-lock.json gruntfile.js /restreamer/
COPY conf /restreamer/conf/
COPY src /restreamer/src/

RUN cd /restreamer \
&& npm install -g grunt-cli eslint \
&& npm install \
&& grunt build \
&& npm cache verify \
&& npm uninstall -g grunt-cli eslint \
&& npm prune --production

# cleanup
RUN echo "final cleanup" \
&& rm /restreamer/gruntfile.js \
&& rm -rf /restreamer/src/webserver/public/scripts \
&& rm -rf ${SRC}/lib/node_modules \
&& rm -rf ${SRC}/lib/*.a \
&& cd ${SRC}/bin && rm -f nasm ndisasm npm npx corepack

FROM $IMAGE
WORKDIR /restreamer
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /usr/local/nginx /usr/local/nginx
COPY --from=builder /usr/local/lib /usr/local/lib
COPY --from=builder /restreamer /restreamer

RUN apt-get update && apt-get install --no-install-recommends --no-install-suggests -y \
ca-certificates \
procps \
openssl \
libssl1.1 \
zlib1g \
v4l-utils \
libv4l-0 \
alsa-utils \
&& apt-get clean \
&& rm -rf /var/lib/apt/lists/*

EXPOSE 8080 8181
VOLUME ["/restreamer/db"]
CMD ["./run.sh"]
