// @ts-check

/**
 * @file holds the code for the class Nginx
 * @link https://github.com/datarhei/restreamer
 * @copyright 2016 datarhei.org
 * @license Apache-2.0
 */
'use strict';


//const proc = require('process');
const spawn = require('child_process').spawn;
const _logger = require('./Logger');
//const rp = require('request-promise');
const http = require('http');
const timeout = 256;

/**
 * @param {string} url
 * @param {(arg0: boolean) => void} cb
 */
function isRunning(url, cb) {
    http.get(url, res => cb(res.statusCode === 200))
        .on('error', () => cb(false))
}

/**
 * Class to watch and control the NGINX RTMP server process
 */
class Nginxrtmp {
    logger;
    config;

    /**
     * Constructs the NGINX rtmp with injection of config to use
     * @param config
     */
    constructor(config) {
        this.logger = _logger('NGINX');
        this.config = config.nginx;

        this.process = null;        // Process handler
        this.allowRestart = false;  // Whether to allow restarts. Restarts are not allowed until the first successful start
    }

    /**
     * Start the NGINX server
     * @returns {Promise<boolean>}
     * @param {boolean} useSSL
     */
    async start(useSSL) {
        this.logger.info('Starting ...');
        let running = false;
        let abort = false;

        if (useSSL == false) {
            this.process = spawn(this.config.command, this.config.args);
        }
        else {
            this.logger.info('Enabling HTTPS');
            this.process = spawn(this.config.command, this.config.args_ssl);
        }

        this.process.stdout.on('data', (data) => {
            let lines = data.toString().split(/[\r\n]+/);

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].replace(/^.*\]/, '').trim();
                if (line.length == 0) {
                    continue;
                }

                this.logger.info(line);
            }
        });

        this.process.stderr.on('data', (data) => {
            let lines = data.toString().split(/[\r\n]+/);

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].replace(/^.*\]/, '').trim();
                if (line.length == 0) {
                    continue;
                }

                this.logger.error(line);
            }
        });

        this.process.on('close', (code) => {
            abort = true;

            this.logger.error('Exited with code: ' + code);

            if ((code === null) || (code < 0)) {
                return;
            }

            if (this.allowRestart == true) {
                let self = this;
                setTimeout(() => {
                    self.logger.info('Trying to restart ...');
                    self.start(useSSL);
                }, 4 * timeout);
            }
        });

        this.process.on('error', (err) => {
            this.logger.error('Failed to spawn process: ' + err.name + ': ' + err.message);
        });

        const ping_url = "http://" + this.config.streaming.ip + ":" + this.config.streaming.http_port + this.config.streaming.http_health_path;
        const foo = () => new Promise(r => setTimeout(isRunning, timeout, ping_url, r));

        while (!abort && !(running = await foo())) this.logger.info(`isRunning: ${running}`);

        if (running === false) {
            this.process = null;
            throw new Error('Failed to start');
        }
        else {
            this.allowRestart = true;
            this.logger.info('Successfully started');
        }

        return true;
    }
}

module.exports = (config) => {
    return new Nginxrtmp(config);
};
