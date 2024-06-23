# syntax=docker/dockerfile:1

ARG IMAGE=amd64/debian:trixie-slim
ARG SRC="/usr/local"

FROM $IMAGE AS builder
WORKDIR /build
ARG SRC

ENV \
LD_LIBRARY_PATH="/usr/local/lib" \
PKG_CONFIG_PATH="/usr/local/lib/pkgconfig"

RUN apt-get update && apt-get install --no-install-recommends --no-install-suggests -y\
    apt-utils\
    ca-certificates\
    curl\
    g++\
    gcc\
    libpcre2-dev\
    libssl-dev\
    libtool\
    libzstd-dev\
    make\
    nasm\
    patch\
    pkg-config\
    zlib1g-dev

RUN apt-get install -y libx264-dev

# libmp3lame
# ARG LAME_VERSION=3.100
# RUN mkdir -p /dist && cd /dist && \
#     curl -OL "https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz" && \
#     tar -xvz -f lame-${LAME_VERSION}.tar.gz && \
#     cd lame-${LAME_VERSION} && \
#     ./configure --prefix="${SRC}" --bindir="${SRC}/bin" --disable-static --enable-nasm && \
#     make -j$(nproc) && \
#     make install

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
--extra-cflags="-I/usr/include" \
--extra-ldflags="-L${SRC}/lib" \
--extra-libs="-lpthread -lm" \
--extra-ldexeflags="-static" \
--ld="g++" \
--enable-gpl \
# --enable-gnutls \
# --enable-version3 \
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
ARG NGINX_VERSION=1.25.4
RUN curl -L "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" | tar -xz \
&& cd nginx-${NGINX_VERSION} \
&& ./configure --prefix=${SRC}/nginx --with-http_ssl_module --with-http_v2_module --add-module="../nginx-rtmp-module-${NGINXRTMP_VERSION}" \
&& make -j$(nproc) \
&& make install
# --without-pcre2 \

# node.js
# ARG NODE_VERSION=21.5.0
ARG NODE_VERSION=20.11.1
RUN --mount=type=tmpfs,target=/build\
    curl -L "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" | tar -xz\
    && cd ./node-v${NODE_VERSION}-linux-x64\
    && cp -R bin lib /usr/local

# RUN mkdir -p /dist && cd /dist \
# && curl -OL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
# RUN cd /dist && tar -xvJ -f "node-v${NODE_VERSION}-linux-x64.tar.xz"
# RUN cd /dist && rm "node-v${NODE_VERSION}-linux-x64.tar.xz" \
# # ADD arch/node-v${NODE_VERSION}-linux-x64.tar.xz .
# && cd node-v${NODE_VERSION}-linux-x64 \
# && cp -R bin ${SRC} \
# && cp -R lib ${SRC}

COPY package.json package-lock.json /app/
RUN cd /app\
    && npm config set update-notifier false\
    && npm install --omit=dev --no-fund\
    && npm cache clean --force\
    && rm -rf ${SRC}/lib/node_modules

COPY contrib /app/
RUN cd /app && node ./get-ffdata && patch -d /app/node_modules/fluent-ffmpeg/lib <./ff.patch

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
WORKDIR /app
ARG SRC
COPY --from=builder $SRC /usr/local/
RUN --mount=type=tmpfs,target=/var/lib/apt/lists\
    apt-get update && apt-get --no-install-recommends --no-install-suggests -y install\
        ca-certificates\
        procps\
        openssl
COPY --link --from=builder /app /app

EXPOSE 8080 8181
ENTRYPOINT [ "node", "./src/start" ]
