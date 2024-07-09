//@ts-check
'use strict';

const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs').promises;
const ff = require('fluent-ffmpeg');
const index = require.resolve('fluent-ffmpeg');

const formats = promisify(ff.getAvailableFormats);
const encoders = promisify(ff.getAvailableEncoders);
const cacheFile = 'cache.json';
const data = {
    ffmpegPath: '/usr/local/bin/ffmpeg',
    ffprobePath: '/usr/local/bin/ffprobe'
};

ff.setFfmpegPath(data.ffmpegPath);
ff.setFfprobePath(data.ffprobePath);

async function buildCache() {
    [data.formats, data.encoders] = await Promise.all([formats(), encoders()]);
    return fs.writeFile(path.join(path.dirname(index), 'lib', cacheFile), JSON.stringify(data));
}

buildCache()
    .then(() => console.log(`"${cacheFile}" created succefully`))
    .catch(e => {
        console.error(e);
        process.exit(-1);
    })
