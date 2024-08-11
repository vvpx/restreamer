// @ts-check
'use strict';

const { join } = require('node:path');
const { version } = require('../package.json');
globalThis.appVersion = version;
globalThis.__src = __dirname;
globalThis.__base = join(__dirname, '..');
globalThis.__public = join(__dirname, 'webserver/public');
const config = globalThis.appConfig = require('../conf/live.json');
var logger = require('./classes/Logger')('Start');
logger.info('Restreamer v' + version);
logger.info('============');

{
    let env = new (require('./classes/EnvVar'))();
    env.init(config);
    env.list(logger);
    if (env.hasErrors()) process.exit();
    logger.debug(`Unload EnvVar: ${delete require.cache[require.resolve('./classes/EnvVar')]}`);
}

if (process.env.RS_DEBUG?.toString() === "true") {
    logger.info('Debugging enabled. Check the /debug path in the web interface.');
}

const nginxrtmp = require('./classes/Nginxrtmp')();
const app = require('./webserver/app');
const Restreamer = require('./classes/Restreamer');

require('node:child_process')
    .fork(join(__dirname, './classes/RestreamerData.js'))
    .on('close', code => {
        if (code) {
            logger.inf?.(`RestreamerData exit code:${code}`);
            return;
        }

        app.startWebserver(Restreamer.data)
            .then(() => {
                Restreamer.bindWebsocketEvents();
                return nginxrtmp.start(process.env.RS_HTTPS === "true");
            })
            .then(() => {
                return Restreamer.restoreProcesses();
            })
            .catch(error => {
                logger.err?.('Error starting webserver and nginx for application: ' + error);
                logger.err?.(`${error.stack}`);
            });
    })
    .on('error', error => {
        logger.err?.(error.message);
    });

process.on('SIGTERM', () => {
    logger.info('Receive SIGTERM signal');
    Restreamer.close();
    nginxrtmp.close();
    app.server?.close(err => {
        if (err) return logger.error(err.message, err.name);
        logger.stdout('MAIN', 'app closed succefully');
    });
})
