'use strict';

const fs = require('node:fs');
// const LEVEL_MUTE = 0
const LEVEL_ERROR = 1;
const LEVEL_WARN = 2;
const LEVEL_INFO = 3;
const LEVEL_DEBUG = 4;
const DEBUG = ((env) => env === true || env === 'true')(process.env.RS_DEBUG ?? false);
const LOG_LEVEL = DEBUG ? LEVEL_DEBUG : parseInt(process.env.RS_LOGLEVEL || `${LEVEL_INFO}`);

/**
 * @typedef LoggerMethod
 * @type {(message: string, context?: string) => void}
 */


class Logger {

    /**
     * construct a logger object
     * @param {string} context context of the log message (classname.methodname)
     */
    constructor(context) {
        this.context = context ?? '';
        this.err = LOG_LEVEL >= LEVEL_ERROR ? this.error : null;
        this.wrn = LOG_LEVEL >= LEVEL_WARN ? this.warn : null;
        this.inf = LOG_LEVEL >= LEVEL_INFO ? this.info : null;
        this.dbg = LOG_LEVEL >= LEVEL_DEBUG ? this.debug : null;
    }

    /**
     * @param {string} type 
     * @param {string} message 
     * @param {string} [context]
     * @returns {string}
     */
    format(type, message, context) {
        return `[${new Date().toISOString().slice(0, 19)}] [${type.padEnd(5)}] [${context ?? this.context}] ${message}\n`;
    }

    /**
     * print a message to stdout
     * @param {string} type
     * @param {string} message
     * @param {string} [context]
     */
    stdout(type, message, context) {
        process.stdout.write(this.format(type, message, context));
    }

    /**@type {LoggerMethod} */ info() { }
    /**@type {LoggerMethod} */ warn() { }
    /**@type {LoggerMethod} */ debug() { }
    /**@type {LoggerMethod} */ error() { }
}


let logFile = -1;
(function () {
    const proto = Logger.prototype;
    const x = [
        { level: LEVEL_INFO, name: 'info', type: 'INFO' },
        { level: LEVEL_WARN, name: 'warn', type: 'WARN' },
        { level: LEVEL_ERROR, name: 'error', type: 'ERROR' },
        { level: LEVEL_DEBUG, name: 'debug', type: 'DEBUG' }
    ];

    let stdout = true;

    if (DEBUG) {
        const identifier = process.pid + '-' + process.platform + '-' + process.arch;
        try {
            logFile = fs.openSync('./src/webserver/public/debug/' + identifier + '.log', 'a');
            process.on("exit", () => fs.close(logFile));
            console.log('Enabled logging to', identifier);
            proto.file = function file() {
                const str = this.format(...arguments);
                process.stdout.write(str);
                fs.appendFile(logFile, str, 'utf8', (err) => { !err && fs.fsync(logFile, () => { }); });
            };
            stdout = false;
        } catch (err) {
            console.error(`${err}`);
        }
    }

    let t = type => stdout ?
        `process.stdout.write(this.format('${type}', ...arguments));` :
        `this.file('${type}', ...arguments);`;

    for (let e of x)
        if (LOG_LEVEL >= e.level) proto[e.name] = new Function(t(e.type));
})();

module.exports = context => new Logger(context);
