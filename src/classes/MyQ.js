'use strict';


class Qdefer {
    #resolve;
    #reject;

    constructor() {
        this.#resolve = null;
        this.#reject = null;

        this.promise = new Promise((resolve, reject) => {
            this.#resolve = resolve;
            this.#reject = reject;
        })
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

    dispose() { this.promise = null; }

    // get promise() { return this.#resolution_promise }
}

module.exports.defer = () => new Qdefer;
