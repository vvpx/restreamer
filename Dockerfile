# syntax=docker/dockerfile:1

ARG IMAGE=amd64/debian:trixie-slim
ARG SRC="/usr/local"

FROM $IMAGE as builder
WORKDIR /build
ARG SRC

ENV \
LD_LIBRARY_PATH="/usr/local/lib" \
PKG_CONFIG_PATH="/usr/local/lib/pkgconfig"

RUN apt-get update && apt-get install --no-install-recommends --no-install-suggests -y\
    ca-certificates\
    curl\
    g++\
    gcc\
    libpcre2-dev\
    libssl-dev\
    libtool\
    make\
    nasm\
    patch\
    pkg-config\
    zlib1g-dev

RUN apt-get install -y libx264-dev

ARG NGINXRTMP_VERSION=1.2.2
RUN curl -L "https://github.com/arut/nginx-rtmp-module/archive/v${NGINXRTMP_VERSION}.tar.gz" | tar -xz

ARG FFMPEG_VERSION=5.1.4
RUN curl -L "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.gz" | tar -xz


# Build ffmpeg
RUN  cd ffmpeg-${FFMPEG_VERSION}\
    && ./configure\
    --prefix="${SRC}"\
    --pkg-config-flags="--static"\
    --bindir="${SRC}/bin"\
    --extra-cflags="-I${SRC}/include"\
    --extra-ldflags="-L${SRC}/lib"\
    --extra-ldexeflags="-static"\
    --ld="g++"\
    --enable-gpl\
    --enable-version3\
    --enable-libx264\
    --enable-openssl\
    --enable-postproc\
    --enable-small\
    --disable-doc\
    --disable-debug\
    --enable-nonfree\
    && make -j$(nproc)\
    && make install\
    && rm ${SRC}/lib/*.a


# nginx-rtmp
ARG NGINX_VERSION=1.25.3
RUN curl -L "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" | tar -xz\
    && cd nginx-${NGINX_VERSION}\
    && ./configure --prefix=${SRC}/nginx --with-http_ssl_module --with-http_v2_module --add-module="../nginx-rtmp-module-${NGINXRTMP_VERSION}"\
    && make -j$(nproc)\
    && make install


# node.js
ARG NODE_VERSION=21.3.0
RUN --mount=type=tmpfs,target=/build\
    curl -L "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" | tar -xz\
    && cd ./node-v${NODE_VERSION}-linux-x64\
    && cp -R bin lib /usr/local

# install packages
COPY package.json package-lock.json /app/
RUN cd /app\
    && npm config set update-notifier false\
    && npm install --omit=dev --no-fund\
    && npm cache clean --force\
    && rm -rf ${SRC}/lib/node_modules

# patch fluent-ffmpeg
COPY contrib /app/
RUN cd /app && node ./get-ffdata && patch -d /app/node_modules/fluent-ffmpeg/lib <./ff.patch

# copy app config
COPY conf /app/conf/
# copy source files
COPY src /app/src/

# setup config for ffmpeg v5.x.x
RUN cd /app/conf\
    && mv -f ./live-v5.json ./live.json\
    && rm -f live-*.json

# generate vesions.json
COPY <<-EOT /app/versions.json
{
    "ffmpeg": "$FFMPEG_VERSION",
    "nginx": "$NGINX_VERSION",
    "nginx_rtmp": "$NGINXRTMP_VERSION",
    "node": "$NODE_VERSION"
}
EOT


# build final image
FROM $IMAGE
WORKDIR /app
ARG SRC
COPY --from=builder $SRC /usr/local/
RUN apt-get update && apt-get --no-install-recommends --no-install-suggests -y install\
        ca-certificates\
        procps\
        openssl\
    && rm -rf /var/lib/apt/lists/*
COPY --link --from=builder /app /app

EXPOSE 8080 8181
ENTRYPOINT [ "node", "./src/start" ]
