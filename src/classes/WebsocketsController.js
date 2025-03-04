//@ts-check
'use strict';

/**@import {Server, Socket} from "socket.io"*/

const logger = require('./Logger')('wsControl');
const app = require("../webserver/app").app;
/**@type {Server} */ var io;
var connections = 0;
var _callback;

/**
 * static class websocket controller, that helps communicating through websockets to different namespaces and ensures
 * that websocket events are bound, if the websocket server has been initialized (through promise made on app start)
 */


/**
 * emit an event to WS
 * @param {string} event name of the event
 * @param {object} data data to emit to the client event listener
 */
function emit(event, data) {
    return io.sockets.emit(event, data);
}


/**
 * add callback on WS connection
 * @param {(arg: Socket) => *} callback
 */
function setConnectCallback(callback) {
    io ??= app.get('io');
    _callback = callback;

    io.on('connection', socket => {
        ++connections;
        logger.inf?.(`Connection from ${socket.handshake.headers['x-forwarded-for']}`);
        socket.once("disconnect", /**@this {Socket}*/ function disconnectCb(reason) {
            logger.inf?.(`${this.handshake?.headers['x-forwarded-for']} disconnected: ${reason} *${--connections}`);
        });
        
        _callback(socket);
    });
}


module.exports = {
    emit,
    emitOnConnections: () => connections > 0 ? emit : null,
    setConnectCallback,
    close: () => io?.close()
};
