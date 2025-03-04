'use strict';

/**@typedef {import("../../../classes/RsData")} rsdata restreamer data*/

const { Router } = require('express');
const replace = /\?token=[^\s]+/;
const version = {
    'version': globalThis.appVersion,
    'update': 'n/a'
};


class apiV1 {
    router;

    /** @type {rsdata} */
    #srcData;

    constructor(srcData = null) {
        this.#srcData = srcData;
        this.router = Router();

        this.router.get('/version', (req, res) => res.json(version));

        // this.router.get('/ip', (req, res) => {
        //     res.end(this.#srcData.publicIp);
        // });

        this.router.get('/states', (req, res) => {
            const states = this.#srcData.states;

            const response = {
                'repeat_to_local_nginx': {
                    type: states.repeatToLocalNginx.type,
                    message: states.repeatToLocalNginx.message.replace(replace, '?token=***')
                },
                'repeat_to_optional_output': {
                    type: states.repeatToOptionalOutput.type,
                    message: states.repeatToOptionalOutput.message.replace(replace, '?token=***')
                }
            };

            res.json(response);
        });

        this.router.get('/process', (req, res) => {
            res.json(process.memoryUsage());
        });

        this.router.get('/progresses', (req, res) => {
            const progresses = this.#srcData.progresses;

            res.json({
                'repeat_to_local_nginx': {
                    'frames': progresses.repeatToLocalNginx.frames,
                    'current_fps': progresses.repeatToLocalNginx.currentFps,
                    'current_kbps': progresses.repeatToLocalNginx.currentKbps,
                    // 'target_size': progresses.repeatToLocalNginx.targetSize,
                    // 'timemark': progresses.repeatToLocalNginx.timemark
                },
                'repeat_to_optional_output': {
                    'frames': progresses.repeatToOptionalOutput.frames,
                    'current_fps': progresses.repeatToOptionalOutput.currentFps,
                    'current_kbps': progresses.repeatToOptionalOutput.currentKbps,
                    // 'target_size': progresses.repeatToOptionalOutput.targetSize,
                    // 'timemark': progresses.repeatToOptionalOutput.timemark
                }
            });
        });
    }

    /**
     * Bind restreamer streams data
     * @param {rsdata} src 
     */
    setSrcData(src) {
        this.#srcData = src;
    }
}

module.exports = apiV1;
