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
            this.#id = setTimeout(() => this.#end(true), time);
        });
    }

    /**
     * @param {boolean} timer_elpsed 
     */
    #end(timer_elpsed) {
        if (this.#cb) {
            this.#cb(timer_elpsed);
            this.#id = null;
            this.#cb = null;
        }
    }

    cancell() {
        this.#id && clearTimeout(this.#id);
        this.#end(false);
    }
}


class RaisingTimer extends Timer {
    constructor(initialWait, increment) {
        super();
        this.initial = initialWait;
        this.current = 0;
        this.inc = increment;
    }

    reset() {
        this.current = 0;
    }

    wait() {
        this.current += this.current === 0 ? this.initial : this.inc;
        return super.wait(this.current);
    }
}

async function Test() {
    const t = new RaisingTimer(1000, 1000);
    let old = Date.now();
    let cnt = 0;

    while (cnt < 3) {
        let result = await t.wait();
        let now = Date.now();
        console.log(result, now - old);
        old = now;
        cnt += 1;
    }

    let ct = new Timer();
    let p = t.wait();
    await ct.wait(1500);
    t.cancell();
    console.log(await p, Date.now() - old);
    return 'test finished';
}

if (require.main === module) {
    Test().then((result) => console.log(result));
}

module.exports = { Timer, RaisingTimer };
