'use strict';

const EventEmitter = require('events').EventEmitter;

/**
 * Replace Q.deferred object
 */
class Qdefer {
    #__event;
    #resolution_promise;

    constructor() {
        this.#__event = new EventEmitter();

        this.#resolution_promise = new Promise((resolve, reject) => {
            this.#__event.once('q', args => (args[0] ? resolve : reject)(args[1]));
        });
    }
    
    #resolution(bResolve, value) { this.#__event.emit('q', [bResolve, value]) };

    reject(reason) { this.#resolution(false, reason); }

    resolve(value) { this.#resolution(true, value); }

    get promise() { return this.#resolution_promise; }
};

module.exports.defer = () => {
    return new Qdefer()
}
