/**
 * @file this file is loaded on application start and initializes the application
 * @link https://github.com/datarhei/restreamer
 * @copyright 2015 datarhei.org
 * @license Apache-2.0
 */
'use strict';

const path = require('path');

global.__src = __dirname;
global.__base = path.join(__dirname, '..');
global.__public = path.join(__dirname, 'webserver/public');

const config = require('../conf/live.json');
module.exports.config = config;

const env = require('./classes/EnvVar');

// setup environment vars
env.init(config);

const packageJson = require('../package.json');
const logger = require('./classes/Logger')('start');
const nginxrtmp = require('./classes/Nginxrtmp')(config);
const restreamerApp = require('./webserver/app');
const Restreamer = require('./classes/Restreamer');
// const RestreamerData = require('./classes/RestreamerData');


if (process.env.RS_DEBUG == "true") {
    logger.info('Debugging enabled. Check the /debug path in the web interface.', false);
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

// bail out if there are errors
if (env.hasErrors()) {
    process.exit();
}

// start the app
// RestreamerData.checkJSONDb()
require('child_process').fork('./src/classes/RestreamerData.js')
    .on('exit', () => {
        restreamerApp.startWebserver()
            .then(() => {
                Restreamer.bindWebsocketEvents();
                return nginxrtmp.start(process.env.RS_HTTPS == "true");
            })
            .then(() => {
                Restreamer.restoreProcesses();
            })
            .catch(error => {
                logger.error('Error starting webserver and nginx for application: ' + error);
            })
    });

