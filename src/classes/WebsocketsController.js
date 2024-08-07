//@ts-check
'use strict';

/**
 * @typedef {import("socket.io").Server} Server
 * @typedef {import("socket.io").Socket} Socket
*/

const ctx = 'wsControl';
var logger = require('./Logger')(ctx);
var app = require("../webserver/app").app;
/**@type {Server} */
var io;
let connections = 0;

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
        io.sockets.emit(event, data);
    }

    /**
     * @returns {((event: string, data: object) => void) | null}
     */
    static emitOnConnections() {
        return connections > 0 ? this.emit : null;
    }

    /**
     * add callback on WS connection
     * @param {(arg: Socket) => void} callback
     */
    static setConnectCallback(callback) {
        io ??= app.get('io');
        io.on('connection', socket => {
            ++connections;
            logger.inf?.(`Connection from ${socket.handshake.headers['x-forwarded-for']}`);
            socket.once("disconnect", (reason) => logger.inf?.(`${socket.handshake?.headers['x-forwarded-for']} disconnected: ${reason} *${--connections}`));
            callback(socket);
        });
    }
}

module.exports = WebsocketsController;
