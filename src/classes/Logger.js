'use strict'

const fs = require('fs')
// const LEVEL_MUTE = 0
const LEVEL_ERROR = 1
const LEVEL_WARN = 2
const LEVEL_INFO = 3
const LEVEL_DEBUG = 4
const DEBUG = ((env = 'false') => env.toLowerCase() === 'true')(process.env.RS_DEBUG)
const LOG_LEVEL = DEBUG ? LEVEL_DEBUG : parseInt(process.env.RS_LOGLEVEL || `${LEVEL_INFO}`)


class Logger {
    static debuglog

    static {
        if (DEBUG) {
            const identifier = process.pid + '-' + process.platform + '-' + process.arch
            try {
                this.debuglog = fs.openSync('./src/webserver/public/debug/Restreamer-' + identifier + '.txt', 'a')
                process.on("exit", () => fs.close(this.debuglog))
                console.log('Enabled logging to ' + identifier)
            } catch (err) {
                this.debuglog = undefined
                console.error(`${err}`)
            }
        }
    }

    /**
     * construct a logger object
     * @param {string} context context of the log message (classname.methodname)
     */
    constructor(context) {
        this.context = context
    }

    /**
     * @param {string} type 
     * @param {string} message 
     * @param {string} context 
     * @returns {string}
     */
    logline(type, message, context = this.context) {
        const time = new Date().toISOString().slice(0, 19)
        return `[${time}] [${type.padEnd(5)}] [${context ? context.padStart(20) : ''}] ${message}\n`
    }

    /**
     * print a message to stdout
     * @param {string} type
     * @param {string} message
     * @param {string} [context]
     */
    stdout(type, message, context) {
        process.stdout.write(this.logline(type, message, context))
    }

    /**
     * print a message to a file
     * @param {string} msd
     * @param {string} ctx
     * @param {string} type
     */
    file(type, msg, ctx) {
        const str = this.logline(type, msg, ctx)
        process.stdout.write(str)

        fs.appendFile(Logger.debuglog, str, 'utf8', (err) => {
            if (!err)
                fs.fsync(Logger.debuglog, () => { })
            return
        })
    }

    info(msg, ctx) { }
    warn(msg, ctx) { }
    debug(msg, ctx) { }
    error(msg, ctx) { }

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
    return function (msg, ctx) { this.file(type, msg, ctx) }
}

const proto = Logger.prototype
const x = [
    { level: LEVEL_INFO, name: 'info', type: 'INFO' },
    { level: LEVEL_WARN, name: 'warn', type: 'WARN' },
    { level: LEVEL_ERROR, name: 'error', type: 'ERROR' },
    { level: LEVEL_DEBUG, name: 'debug', type: 'DEBUG' }
]

if (DEBUG && Logger.debuglog) {
    proto.info = func('INFO')
    proto.warn = func('WARN')
    proto.error = func('ERROR')
    proto.debug = func('DEBUG')
} else {
    for (let e of x)
        if (LOG_LEVEL >= e.level)
            proto[e.name] = function (msg, cxt) { process.stdout.write(this.logline(e.type, msg, cxt)) }
}


module.exports = context => new Logger(context)
