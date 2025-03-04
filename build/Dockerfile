# syntax=docker/dockerfile:1

ARG IMAGE=amd64/debian:buster-slim
ARG SRC="/usr/local"

FROM $IMAGE AS builder
WORKDIR /build
ARG SRC

ENV \
    LD_LIBRARY_PATH="/usr/local/lib" \
    PKG_CONFIG_PATH="/usr/local/lib/pkgconfig"

RUN apt-get update && apt-get install --no-install-recommends --no-install-suggests -y\
    ca-certificates curl\
    g++ gcc\
    libpcre2-dev libssl-dev libtool\
    make\
    nasm\
    patch pkg-config\
    zlib1g-dev

RUN apt-get install -y libx264-dev

ARG NGINXRTMP_VERSION=1.2.2
RUN curl -L "https://github.com/arut/nginx-rtmp-module/archive/v${NGINXRTMP_VERSION}.tar.gz" | tar -xz

ARG FFMPEG_VERSION=5.1.4
RUN curl -L "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.gz" | tar -xz

# Build ffmpeg
RUN  cd ffmpeg-${FFMPEG_VERSION} \
    && ./configure \
    --prefix="${SRC}" \
    --pkg-config-flags="--static" \
    --bindir="${SRC}/bin" \
    --extra-cflags="-I${SRC}/include" \
    --extra-ldflags="-L${SRC}/lib" \
    --extra-libs="-lpthread -lm" \
    --extra-ldexeflags="-static" \
    --ld="g++" \
    --enable-gpl \
    # --enable-gnutls \
    --enable-version3 \
    # --enable-libmp3lame \
    # --enable-libfreetype \
    --enable-libx264 \
    --enable-openssl \
    --enable-postproc \
    --enable-small \
    # --enable-static \
    # --disable-shared \
    # --disable-encoders \
    # --disable-alsa \
    --disable-doc \
    --disable-debug \
    # --disable-devices \
    # --enable-shared \
    --enable-nonfree \
    && make -j$(nproc) \
    && make install \
    && rm ${SRC}/lib/*.a

# nginx-rtmp
ARG NGINX_VERSION=1.25.5
RUN curl -L "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" | tar -xz \
    && cd nginx-${NGINX_VERSION} \
    && ./configure --prefix=${SRC}/nginx --with-http_ssl_module --with-http_v2_module --add-module="../nginx-rtmp-module-${NGINXRTMP_VERSION}" \
    && make -j$(nproc) \
    && make install
# --without-pcre2 \

# node.js
ARG NODE_VERSION=20.13.1
RUN --mount=type=tmpfs,target=/build\
    curl -L "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" | tar -xz\
    && cd ./node-v${NODE_VERSION}-linux-x64\
    && cp -R bin lib /usr/local

COPY package.json package-lock.json /app/
RUN cd /app\
    && npm config set update-notifier false\
    && npm ci --omit=dev --no-fund --no-audit\
    && npm cache clean --force\
    && rm -rf ${SRC}/lib/node_modules

COPY conf /app/conf/
COPY src /app/src/

RUN cd /app/conf\
    && mv -f ./live-v5.json ./live.json\
    && rm -f live-*.json

COPY <<-EOT /app/versions.json
{
    "ffmpeg": "$FFMPEG_VERSION",
    "nginx": "$NGINX_VERSION",
    "nginx_rtmp": "$NGINXRTMP_VERSION",
    "node": "$NODE_VERSION"
}
EOT

FROM $IMAGE
LABEL org.opencontainers.image.source=https://github.com/vvpx/restreamer
WORKDIR /app
ARG SRC
COPY --from=builder $SRC /usr/local/
RUN --mount=type=tmpfs,target=/var/lib/apt/lists\
    apt-get update && apt-get --no-install-recommends --no-install-suggests -y install\
    ca-certificates\
    libpcre2-8-0\
    openssl\
    procps
COPY --link --from=builder /app /app

EXPOSE 8080 8181
ENTRYPOINT [ "node" ]
CMD [ "--max-old-space-size=12", "./src/start.js" ]
