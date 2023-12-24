// @ts-check
'use strict'

const { join } = require('node:path')
const { version } = require('../package.json')
globalThis.appVersion = version
globalThis.__src = __dirname
globalThis.__base = join(__dirname, '..')
globalThis.__public = join(__dirname, 'webserver/public')
const config = globalThis.appConfig = require('../conf/live.json')
const env = require('./classes/EnvVar')
env.init(config)

const logger = require('./classes/Logger')('Start')
const nginxrtmp = require('./classes/Nginxrtmp')()
const app = require('./webserver/app')
const Restreamer = require('./classes/Restreamer')

if (process.env.RS_DEBUG?.toLowerCase() === "true") {
    logger.info('Debugging enabled. Check the /debug path in the web interface.')
}

// show start message
logger.info('     _       _             _           _ ', false)
logger.info('  __| | __ _| |_ __ _ _ __| |___   ___(_)', false)
logger.info(' / _  |/ _  | __/ _  |  __|  _  |/  _ | |', false)
logger.info('| (_| | (_| | || (_| | |  | | | |  __/| |', false)
logger.info('|_____|_____|_||_____|_|  |_| |_|____||_|', false)
logger.info('', false)
logger.info('Restreamer v' + version, false)
logger.info('', false)
logger.info('ENVIRONMENTS', false)
logger.info('More information in our Docs', false)
logger.info('', false)

// list environment variables
env.list(logger)
if (env.hasErrors()) process.exit()
logger.debug(`Unload EnvVar: ${delete require.cache[require.resolve('./classes/EnvVar')]}`)

require('child_process')
.fork('./src/classes/RestreamerData.js')
    .on('close', code => {
        if (code) {
            logger.inf?.(`RestreamerData exit code:${code}`)
            return
        }

        app.startWebserver(Restreamer.data)
            .then(() => {
                Restreamer.bindWebsocketEvents()
                return nginxrtmp.start(process.env.RS_HTTPS === "true")
            })
            .then(() => {
                return Restreamer.restoreProcesses()
            })
            .catch(error => {
                logger.err?.('Error starting webserver and nginx for application: ' + error)
                logger.err?.(`${error.stack}`)
            })
    })
    .on('error', error => {
        logger.err?.(error.message)
    })
  
process.on('SIGTERM', () => {
    logger.info('receive SIGTERM signal')
    nginxrtmp.close()
    Restreamer.close()
    app.server?.close((err) => {
        if (err) return logger.error(err.message, err.name)
        logger.inf?.('server closed succefully')
    })
})
