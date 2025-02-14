'use strict';


class Timer {
    /**@type {NodeJS.Timeout} id таймера*/ #id;
    #cb;

    /**
     * Запуск таймера
     * @param {number} time время (ms)
     * @returns {Promise<boolean>} true - таймер сработал, false - отмена
     */
    wait(time) {
        return new Promise(resolve => {
            this.#cb = resolve;
            this.#id = this.#id?.refresh() ?? setTimeout(() => this.#end(true), time);
        });
    }

    /**
     * @param {boolean} timer_elpsed 
     */
    #end(timer_elpsed) {
        if (this.#cb) {
            this.#cb(timer_elpsed);
            this.#cb = undefined;
        }
    }

    cancell() {
        if (this.#cb) {
            this.#id && clearTimeout(this.#id);
            this.#end(false);
        }
    }
}


class RaisingTimer extends Timer {
    constructor(initialWait, increment) {
        super();
        this.initial = initialWait;
        this.inc = increment;
        this._time = 0;
    }

    get current() {
        return this._time === 0 ? this.initial : this._time + this.inc;
    }

    reset() {
        this._time = 0;
    }

    wait() {
        // this.current += this.current === 0 ? this.initial : this.inc;
        return super.wait(this._time = this.current);
    }
}

// async function Test() {
//     const t = new RaisingTimer(1000, 1000);
//     let old = Date.now();
//     let cnt = 0;

//     while (cnt < 3) {
//         let result = await t.wait();
//         let now = Date.now();
//         console.log(result, now - old);
//         old = now;
//         cnt += 1;
//     }

//     let ct = new Timer();
//     let p = t.wait();
//     await ct.wait(1500);
//     t.cancell();
//     console.log(await p, Date.now() - old);
//     return 'test finished';
// }

// if (require.main === module) {
//     Test().then((result) => console.log(result));
// }

module.exports = { Timer, RaisingTimer };
