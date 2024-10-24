// @ts-check
'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const logger = require('./Logger')('NGINX');

const { nginx: config } = globalThis.appConfig; // require('../../conf/live.json')
const ping_url = "http://" + config.streaming.ip + ":" + config.streaming.http_port + config.streaming.http_health_path;
const timeout = 256;


/**
 * @param {(arg: boolean) => void} cb callback
 */
function isRunning(cb) {
    http.get(ping_url, res => cb(res.statusCode === 200))
        .on('error', () => cb(false));
}

/**
 * Class to watch and control the NGINX RTMP server process
 */
class Nginxrtmp {

    /**
     * Constructs the NGINX rtmp
     */
    constructor() {
        this.process = null;        // Process handler
        this.allowRestart = false;  // Whether to allow restarts. Restarts are not allowed until the first successful start
    }

    /**
     * Start the NGINX server
     * @returns {Promise<boolean>}
     * @param {boolean} useSSL
     */
    async start(useSSL) {
        logger.info('Starting nginx...');
        let running = false;
        let abort = false;

        if (useSSL) {
            logger.info('Enabling HTTPS')
            this.process = spawn(config.command, config.args_ssl);
        }
        else {
            this.process = spawn(config.command, config.args);
        }

        this.process.stdout.on('data', data => logger.info(data));

        this.process.stderr.on('data', data => logger.error(data, ''));

        this.process.on('close', code => {
            abort = true;
            if (code && code > 0) {
                logger.err?.(`Exited with code: ${code}`);
                if (this.allowRestart) {
                    const self = this;
                    setTimeout(() => {
                        logger.info('Trying to restart...');
                        self.start(useSSL);
                    }, 4 * timeout);
                }
            }

        })

        this.process.on('error', err => {
            logger.error('Failed to spawn process: ' + err.name + ': ' + err.message);
        });

        const foo = () => new Promise(r => setTimeout(isRunning, timeout, r));

        while (!abort && !(running = await foo())) logger.info(`isRunning: ${running}`);

        if (running) {
            this.allowRestart = true;
            logger.info('Successfully started');
        }
        else {
            this.process = null;
            throw new Error('Failed to start');
        }

        return true;
    }

    close() {
        this.allowRestart = false;
        this.process?.kill();
    }
}

module.exports = () => new Nginxrtmp;
