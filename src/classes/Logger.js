'use strict'

const fs = require('fs')
// const LEVEL_MUTE = 0
const LEVEL_ERROR = 1
const LEVEL_WARN = 2
const LEVEL_INFO = 3
const LEVEL_DEBUG = 4
const DEBUG = ((env = 'false') => env.toLowerCase() === 'true')(process.env.RS_DEBUG)
const LOG_LEVEL = DEBUG ? LEVEL_DEBUG : parseInt(process.env.RS_LOGLEVEL || LEVEL_INFO)


class Logger {

    /**
     * construct a logger object
     * @param {string} context context of the log message (classname.methodname)
     */
    constructor(context) {
        // console.log('Logger.constructor: %s', context)
        this.context = context
        this.debuglog

        if (DEBUG) {
            const identifier = process.pid + '-' + process.platform + '-' + process.arch
            try {
                this.debuglog = fs.openSync('./src/webserver/public/debug/Restreamer-' + identifier + '.txt', 'a')
            } catch (err) {
                this.debuglog = undefined
                this.stdout('Error opening debug file ' + identifier + ': ' + err, context, 'INFO')
            } finally {
                this.stdout('Enabled logging to ' + identifier, context, 'INFO')
            }
        }
    }

    /**
     * 
     * @param {string} message 
     * @param {string} context 
     * @param {string} type 
     * @returns {string}
     */
    logline(message, context = this.context, type) {
        const time = new Date().toISOString().slice(0, 19)
        return `[${time}] [${type.padEnd(5)}] [${context ? context.padStart(20) : ''}] ${message}\n`
    }

    /**
     * print a message to stdout
     * @param {string} message
     * @param {string} context
     * @param {string} type
     */
    stdout(message, context, type) {
        process.stdout.write(this.logline(message, context, type))
    }

    /**
     * print a message to a file
     * @param {string} msd
     * @param {string} ctx
     * @param {string} type
     */
    file(msd, ctx, type) {
        const str = this.logline(msd, ctx, type)
        process.stdout.write(str)

        if (this.debuglog !== undefined) {
            fs.appendFile(this.debuglog, str, 'utf8', (err) => {
                if (!err)
                    fs.fsync(this.debuglog, () => { })
                return
            })
        }
    }

    info(msg, ctx) { }
    warn(msg, ctx) { }
    debug(msg, ctx) { }
    error(msg, ctx) { }
    // get test() {
    //     return LOG_LEVEL >= LEVEL_DEBUG ? (msg, ctx) => { this.debug(msg, ctx) } : null;
    // }

    err = LOG_LEVEL >= LEVEL_ERROR ? this.error : null
    wrn = LOG_LEVEL >= LEVEL_WARN ? this.warn : null
    inf = LOG_LEVEL >= LEVEL_INFO ? this.info : null
    dbg = LOG_LEVEL >= LEVEL_DEBUG ? this.debug : null
}

// /**
//  * 
//  * @param {Function} f
//  * @param {string} type
//  * @returns {Function}
//  */
// function wrap(f, type) {
//     return function (msg, ctx) {
//         this.file(msg, ctx, type);
//         f.apply(msg, ctx);
//     }
// }

/**
 * 
 * @param {string} type
 * @returns {Function}
 */
function func(type) {
    return function (msg, ctx) {
        this.file(msg, ctx, type)
    }
}

const proto = Logger.prototype
const x = [
    { level: LEVEL_INFO, name: 'info', type: 'INFO' },
    { level: LEVEL_WARN, name: 'warn', type: 'WARN' },
    { level: LEVEL_ERROR, name: 'error', type: 'ERROR' },
    { level: LEVEL_DEBUG, name: 'debug', type: 'DEBUG' },
    { level: 5, name: 'dev', type: 'DEV'}
]

if (DEBUG) {
    proto.info = func('INFO')
    proto.warn = func('WARN')
    proto.error = func('ERROR')
    proto.debug = func('DEBUG')
} else {
    // console.log(`logLevel: ${logLevel}`)

    x.forEach(e => {
        if (LOG_LEVEL >= e.level)
            proto[e.name] = function (msg, cxt) { process.stdout.write(this.logline(msg, cxt, e.type)) }
    })

    // for (let o of x) {
    //     if (logLevel >= o.level) proto[o.name] = function (msg, cxt) { this.stdout(msg, cxt, o.type) }
    // }
    // if (logLevel >= LEVEL_INFO) proto.info = function (msg, cxt) { this.stdout(msg, cxt, 'INFO') }
}


module.exports = context => new Logger(context)
