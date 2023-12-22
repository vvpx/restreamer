# syntax=docker/dockerfile:1

ARG IMAGE=amd64/debian:buster-slim
#ARG IMAGE=amd64/debian:bullseye-slim

FROM $IMAGE as builder
WORKDIR /build

ARG NASM_VERSION=2.14.02
ARG LAME_VERSION=3.100
ARG FFMPEG_VERSION=4.4.4
ARG NGINX_VERSION=1.21.3
ARG NGINXRTMP_VERSION=1.2.2
ARG NODE_VERSION=16.13.2

ENV SRC="/usr/local" \
    LD_LIBRARY_PATH="/usr/local/lib" \
    PKG_CONFIG_PATH="/usr/local/lib/pkgconfig"

RUN apt-get update && apt-get install -y\
    curl\
    gcc\
    libpcre3-dev\
    libtool\
    libssl-dev\
    libasound2-dev \
    # build-essential \
    make \
    patch\
    pkg-config \
    # texinfo \
    zlib1g-dev

# nasm
ARG NASM_VERSION=2.16.01
RUN --mount=type=tmpfs,target=/build \
    curl -L "https://www.nasm.us/pub/nasm/releasebuilds/${NASM_VERSION}/nasm-${NASM_VERSION}.tar.xz" | tar -xJ \
    && cd nasm-${NASM_VERSION} \
    && ./configure \
    && make -j$(nproc) \
    && make install

# x264
RUN --mount=type=tmpfs,target=/build\
    curl -L https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.bz2 | tar -xj\
    && cd x264-stable\
    && ./configure --prefix="${SRC}" --bindir="${SRC}/bin" --enable-shared\
    && make -j$(nproc)\
    && make install

# x265
RUN apt-get install -y libx265-dev

# libmp3lame
RUN --mount=type=tmpfs,target=/build \
    curl -L "https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz" | tar -xz \
    && cd lame-${LAME_VERSION} \
    && ./configure --prefix="${SRC}" --bindir="${SRC}/bin" --disable-static --enable-nasm \
    && make -j$(nproc) \
    && make install

RUN --mount=type=tmpfs,target=/build \
    curl -L "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.gz" | tar -xz \
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
    --enable-libx265 \
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
    curl -L "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" | tar -xz\
    && curl -L "https://github.com/arut/nginx-rtmp-module/archive/v${NGINXRTMP_VERSION}.tar.gz" | tar -xz\
    && sed -i"" -e '/case ESCAPE:/i /* fall through */' nginx-rtmp-module-${NGINXRTMP_VERSION}/ngx_rtmp_eval.c\
    && cd nginx-${NGINX_VERSION}\
    && ./configure --prefix=/usr/local/nginx --with-http_ssl_module --with-http_v2_module --add-module=/build/nginx-rtmp-module-${NGINXRTMP_VERSION}\
    && make -j$(nproc)\
    && make install

# node.js
RUN --mount=type=tmpfs,target=/build \
    curl -L "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ\
    && cd node-v${NODE_VERSION}-linux-x64 \
    && cp -R bin lib /usr/local

# COPY --link package.json package-lock.json gruntfile.js /app/
# RUN cd /app\
#     && npm config set update-notifier false\
#     && npm install -g grunt-cli eslint\
#     && npm install\
#     && grunt build\
#     && npm cache verify\
#     && npm uninstall -g grunt-cli eslint\
#     && npm prune --production

COPY --link package.json package-lock.json /app/
RUN cd /app\
 && npm config set update-notifier false\
 && npm install --omit=dev\
 && npm cache clean --force\
 && rm -rf ${SRC}/lib/node_modules

# fluent-ffmpeg: disable input probing
COPY ff.diff .
RUN patch -d /app/node_modules/fluent-ffmpeg/lib < /build/ff.diff


# COPY package.json package-lock.json gruntfile.js /app/
COPY --link conf /app/conf/
COPY --link src /app/src/

# RUN cp -P /usr/lib/x86_64-linux-gnu/libx265.so* $SRC/lib/
# && cp -P /usr/lib/x86_64-linux-gnu/libnuma.so* $SRC/lib/

# cleanup
RUN \
rm -rf /app/src/webserver/public/scripts &&\
rm -rf ${SRC}/lib/node_modules &&\
rm -rf ${SRC}/lib/*.a &&\
cd ${SRC}/bin && rm -f nasm ndisasm npm npx corepack


FROM scratch as bin-dist
WORKDIR /dist
COPY --from=builder /usr/local/bin bin
COPY --from=builder /usr/local/nginx nginx
COPY --from=builder /usr/local/lib lib


# Build final image
FROM $IMAGE
WORKDIR /app
COPY --from=bin-dist /dist /usr/local
RUN apt-get update && apt-get install --no-install-recommends --no-install-suggests -y\
    alsa-utils\
    ca-certificates\
    procps\
    openssl\
    nano\
    zlib1g\
    # v4l-utils\
    # libv4l-0\
    # libnuma1\
    x265\
    && apt-get clean\
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app /app

EXPOSE 8080 8181
# VOLUME ["/app/db"]
# CMD ["./run.sh"]
ENTRYPOINT [ "node", "./src/start" ]
