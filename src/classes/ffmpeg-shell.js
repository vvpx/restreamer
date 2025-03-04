'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

globalThis.appConfig.ffmpeg.options.local_mpegts.outputOptions.push("-y");


class ffmpegShell extends EventEmitter {
    /**@type {import("node:child_process").ChildProcess} */
    ffmpegProc;
    task;

    /**
     * @param {string} source 
     */
    constructor(source) {
        super();
        // this.ffmpegProc = null;
        this._name = '';
        this._source = source;
        this._oputput = '';
        this._inputOptions = [];
        this._outputOptions = [];
        this.ffmpegProc = null;
    }


    /**@param {string} name*/
    setName(name) {
        this._name = name;
        return this;
    }

    get name() { return this._name; }

    /**@param {string} source  */
    input(source) {
        this._source = source;
    }

    /**@param {Array.<string>} options  */
    inputOptions(options) {
        for (let o of options) {
            this._inputOptions.push(...o.split(' ', 2));
        }
    }

    /**@param {string} output  */
    output(output) {
        this._oputput = output;
    }

    /**@param {Array.<string>} options  */
    outputOptions(options) {
        for (let o of options) {
            this._outputOptions.push(...o.split(' ', 2));
        }
    }

    run() {
        var args = this._inputOptions.concat('-i', this._source, this._outputOptions, this._oputput);
        // console.log('start ffmpeg with args: ', args);

        this.ffmpegProc = spawn('/usr/local/bin/ffmpeg', args)
            .on('spawn', () => this.emit('start', 'ffmpeg ' + args.join(' ')))
            .on('error', (err) => this.emit('error', err))
            .on('close', (code, signal) => {
                signal ?
                    this.emit('error', new Error(`ffmpeg terminated by ${signal}`)) :
                    (code == 0 ? this.emit('end') : this.emit('error', new Error(`ffmpeg exit code: ${code}`)));
                this.ffmpegProc.removeAllListeners();
            });

        this.ffmpegProc.stderr
            .setEncoding('ascii') //utf8
            .on('data', (data) => this.emit('stderr', data));
    }

    isRunning() {
        return (this.ffmpegProc !== null) && (this.ffmpegProc.exitCode === null);
    }

    get exitcode() {
        return this.ffmpegProc?.exitCode;
    }

    abort() {
        return this.kill('SIGTERM');
    }

    kill(signal) {
        return this.isRunning() && this.ffmpegProc.kill(signal);
    }

    reset() {
        this.kill();
        this.dispose();
        return this;
    }

    dispose() {
        this.task = null;
        this.ffmpegProc = null;
        this._inputOptions.length = 0;
        this._outputOptions.length = 0;
        this.removeAllListeners();
    }
}


module.exports = ffmpegShell;