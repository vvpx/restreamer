'use strict'

const { EventEmitter } = require('node:events');
const { spawn, ChildProcess } = require('node:child_process');

class ffmpegShell extends EventEmitter {
    /**@type {ChildProcess} */
    ffmpegProc;

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
    }


    /**@param {string} name  */
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
            .on('error', (err) => { this.emit('error', err) })
            .on('close', (err, signal) => { err ? this.emit('error', err) : this.emit('end') });

        this.ffmpegProc.stderr
            .setEncoding('utf8')
            // .once('data'), (data) => this.emit('start')
            .on('data', (data) => this.emit('stderr', data));
        this.emit('start', 'ffmpeg ' + args.join(' '));
    }

    abort() {
        console.log('ffmpegShell::abort', signal);
        return this.ffmpegProc = this.ffmpegProc?.kill() ? null : this.ffmpegProc;
    }

    kill(signal) {
        console.log('ffmpegShell::kill', signal);
        return this.ffmpegProc = this.ffmpegProc?.kill(signal) ? null : this.ffmpegProc;
    }

    dispose() {
        this.ffmpegProc = null;
        this._inputOptions.length = 0;
        this._outputOptions.length = 0;
        for (let name of this.eventNames)
            this.removeAllListeners(name);
    }
}


module.exports = ffmpegShell;