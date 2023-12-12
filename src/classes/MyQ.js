'use strict';

const EventEmitter = require('node:events').EventEmitter;

/**
 * Replace Q.deferred object
 */
// class Qdefer {
//     #__event;
//     #resolution_promise;

//     constructor() {
//         this.#__event = new EventEmitter();

//         this.#resolution_promise = new Promise((resolve, reject) => {
//             this.#__event.once('q', args => (args[0] ? resolve : reject)(args[1]));
//         });
//     }

//     /**
//      * @param {boolean} bResolve - promise resolution
//      */
//      #resolution(bResolve, value) {
//         if (this.#__event) {
//             this.#__event.emit('q', [bResolve, value]);
//             this.#__event = null;
//         }
//     }

//     reject(reason) { this.#resolution(false, reason); }

//     resolve(value) { this.#resolution(true, value); }

//     get promise() { return this.#resolution_promise; }
// };

class Qdefer {
    #resolve;
    #reject;
    #resolution_promise;

    constructor() {
        this.#resolution_promise = new Promise((resolve, reject) => {
            this.#resolve = resolve;
            this.#reject = reject;
        });
    }

    reject(reason) {
        this.#reject?.(reason);
        this.#resolve = null;
        this.#reject = null;
    }

    resolve(value) {
        this.#resolve?.(value);
        this.#resolve = null;
        this.#reject = null;
    }

    dispose() { this.#resolution_promise = null; }
    
    get promise() { return this.#resolution_promise; }
};

module.exports.defer = () => {
    return new Qdefer()
}
