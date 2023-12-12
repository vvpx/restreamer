/**
 * @file this file is loaded on application start and initializes the application
 * @link https://github.com/datarhei/restreamer
 * @copyright 2015 datarhei.org
 * @license Apache-2.0
 */
'use strict';

const { join } = require('path');

global.__src = __dirname;
global.__base = join(__dirname, '..');
global.__public = join(__dirname, 'webserver/public');

const config = require('../conf/live.json');
module.exports.config = config;

let env = require('./classes/EnvVar');
env.init(config);

const packageJson = require('../package.json');
const logger = require('./classes/Logger')('Start');
const nginxrtmp = require('./classes/Nginxrtmp')(config);
const restreamerApp = require('./webserver/app');
const Restreamer = require('./classes/Restreamer');


if (process.env.RS_DEBUG == "true") {
    logger.info('Debugging enabled. Check the /debug path in the web interface.');
}

// show start message
logger.info('     _       _             _           _ ', false);
logger.info('  __| | __ _| |_ __ _ _ __| |___   ___(_)', false);
logger.info(' / _  |/ _  | __/ _  |  __|  _  |/  _ | |', false);
logger.info('| (_| | (_| | || (_| | |  | | | |  __/| |', false);
logger.info('|_____|_____|_||_____|_|  |_| |_|____||_|', false);
logger.info('', false);
logger.info('Restreamer v' + packageJson.version, false);
logger.info('', false);
logger.info('ENVIRONMENTS', false);
logger.info('More information in our Docs', false);
logger.info('', false);

// list environment variables
env.list(logger);
env.reset();

// bail out if there are errors
if (env.hasErrors()) {
    process.exit();
}

env = undefined;
if (delete require.cache[require.resolve('./classes/EnvVar')] === false) logger.error('Can`t unload EnvVar');
//logger.debug(`Unload EnvVar: ${delete require.cache[require.resolve('./classes/EnvVar')]}`);

// {
//     const RestreamerData = require('./classes/RestreamerData');
//     RestreamerData.checkJSONDb()
// }

// start the app
require('child_process').fork('./src/classes/RestreamerData.js')
    .on('close', (code) => {
        if (code) {
            logger.inf?.(`RestreamerData exit code:${code}`);
            return;
        }

        restreamerApp.startWebserver(Restreamer.data)
            .then(() => {
                Restreamer.bindWebsocketEvents();
                return nginxrtmp.start(process.env.RS_HTTPS == "true");
            })
            .then(() => {
                return Restreamer.restoreProcesses();
            })
            .catch(error => {
                logger.err?.('Error starting webserver and nginx for application: ' + error);
                logger.err?.(`${error.stack}`)
            })
    })
    .on('error', (error) => {
        logger.err?.(error.message)
    });
