'use strict'

const { Server, Socket } = require("socket.io")

const app = require("../webserver/app").app

/**
 * static class websocket controller, that helps communicating through websockets to different namespaces and ensures
 * that websocket events are bound, if the websocket server has been initialized (through promise made on app start)
 */
class WebsocketsController {

    /**
     * emit an event to WS
     * @param {string} event name of the event
     * @param {object} data data to emit to the client event listener
     */
    static emit(event, data) {
        // app.get('websocketsReady').promise.then((io) => {
        //     // logger.debug('Emitting ' + event)
        //     io.sockets.emit(event, data)
        // })
        
        app.get('io').sockets.emit(event, data)
    }

    /**
     * add callback on WS connection
     * @param {(arg: Socket) => void} callback
     */
    static setConnectCallback(callback) {
        // app.get('websocketsReady').promise.then((io) => {
        //     io.on('connection', (socket) => {
        //         callback(socket)
        //     })
        // })

        /**@type {Server} */
        const io = app.get('io')
        io.on('connection', callback) // (socket) => { callback(socket); })
    }
}

module.exports = WebsocketsController
