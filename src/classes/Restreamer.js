'use strict';

const config = globalThis.appConfig;
const RTL = "repeatToLocalNginx";

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const FfmpegCommand = require('fluent-ffmpeg');
const { JsonDB, Config } = require('node-json-db');
const logger = require('./Logger')('Restreamer');
const wsCtrl = require('./WebsocketsController');
const { RaisingTimer: rtimer, Timer } = require('./Timers.js');
// const task_key = Symbol.for('task');

const { timeout_key: probe_tot_key, socket_timeout } = config.ffmpeg.probe;
const restartTimespan = config.ffmpeg.monitor.restart_wait;
const db = new JsonDB(new Config(config.jsondb, true, false));

// FfmpegCommand.setFfmpegPath('/usr/local/bin/ffmpeg');
// FfmpegCommand.setFfprobePath('/usr/local/bin/ffprobe');


// function timeout(ms) {
//     return new Promise(resolve => setTimeout(resolve, ms).unref())
// }

/**@type {StrimingTask} */
let rtl_task = null;

/**
 * class Restreamer (static) creates and manages streams through ffmpeg
 */
class Restreamer {

    /**
     * generate output hls-path from config-file
     * @returns {string}
     */
    static getRTMPStreamUrl() {
        const nginx = config.nginx.streaming;
        const token = process.env.RS_TOKEN || config.auth.token;
        let path = `rtmp://${nginx.ip}:${nginx.rtmp_port}${nginx.rtmp_hls_path}/live.stream`;
        if (token != '')
            path += '?token=' + token;
        return path;
    }

    /**
     * generate output snapshot-path from config-file
     * @returns {string}
     */
    static getSnapshotPath() {
        return path.join(global.__public, 'images', 'live.jpg');
    }

    /**receive snapshot by using first frame of repeated video*/
    static fetchSnapshot() {
        if (Restreamer.data.states.repeatToLocalNginx.type != 'connected') {
            logger.dbg?.('Disabled, because stream is not connected', 'snapshot');
            return;
        }

        let interval = Restreamer.getSnapshotInterval()
        if (interval == 0) {
            logger.info('Disabled', 'snapshot');
            return;
        }

        const startTime = Date.now();
        const fetchSnapshot = function () {
            let elapsed = Date.now() - startTime;
            if (elapsed <= interval) {
                interval -= elapsed;
            }

            Restreamer.setTimeout(RTL, 'snapshot', Restreamer.fetchSnapshot, interval);
        };

        const command = new FfmpegCommand('/tmp/hls/live.stream.m3u8'); // FfmpegCommand(Restreamer.getRTMPStreamUrl())
        // command.output(Restreamer.getSnapshotPath())

        Restreamer.addStreamOptions(command, 'global', null);
        Restreamer.addStreamOptions(command, 'snapshot', null);
        command
            .on('start', commandLine => {
                logger.dbg?.('Spawned: ' + commandLine, 'snapshot');
            })
            .on('error', error => {
                logger.error(error.toString().trim(), 'snapshot');
                fetchSnapshot();
            })
            .on('end', () => {
                logger.inf?.('Updated. Next scheduled update in ' + interval + ' ms.', 'snapshot');
                wsCtrl.emit('snapshot', null);
                fetchSnapshot();
            })
            .save(Restreamer.getSnapshotPath());
    }

    /**
     * 
     * @param {FfmpegCommand.FfmpegCommand} command 
     * @param {string} name 
     * @param {*} replace 
     * @returns 
     */
    static addStreamOptions(command, name, replace) {
        if (!Object.prototype.hasOwnProperty.call(config.ffmpeg.options, name)) {
            logger.dbg?.('Unknown option: ' + name);
            return;
        }

        logger.dbg?.('Adding option: ' + name);

        const options = config.ffmpeg.options[name];

        const replacer = function (options, replace) {
            if (!replace) return options;

            const f = /**@param {String} option*/ option => {
                let o = option;
                for (let r in replace) {
                    const sub = `{${r}}`;
                    if (o.includes(sub)) {
                        logger.dbg?.(`Replacing ${sub} with "${replace[r]}" in: ${o}`);
                        o = o.replace(sub, replace[r]);
                    }
                }
                return o;
            };

            return (options instanceof Array) ? options.map(e => f(e)) : f(options);
        }

        if ('input' in options) {
            command.input(replacer(options.input, replace));
        }

        if ('inputOptions' in options) {
            command.inputOptions(replacer(options.inputOptions, replace));
        }

        if ('outputOptions' in options) {
            command.outputOptions(replacer(options.outputOptions, replace));
        }
    }

    static getSnapshotInterval() {
        const minimalInterval = 10000;    // 10 seconds
        const defaultInterval = 60000;    // 60 seconds
        const parsedInterval = process.env.RS_SNAPSHOT_INTERVAL?.match(/^([0-9]+)(m|s|ms)?$/) ?? null;

        let interval = defaultInterval;

        if (parsedInterval !== null) {
            interval = parseInt(parsedInterval[1]);

            if (parsedInterval.length == 3) {
                switch (parsedInterval[2]) {
                    case 'm':
                        interval *= 1000 * 60;
                        break;

                    case 's':
                        interval *= 1000;
                        break;

                    case 'ms':
                        break;

                    default:
                        break;
                }
            }
        }
        else {
            logger.warn('Invalid value for interval. Using default.', 'snapshot');
        }

        if (interval > 0 && interval < minimalInterval) {
            interval = minimalInterval;
        }

        return interval;
    }

    /**
     * stop stream
     * @param {string} streamType
     */
    static stopStream(streamType) {
        this.updateState(streamType, 'stopped');
        logger.info('Stop streaming', streamType);

        let ffcommand = this.data.processes[streamType];
        if (ffcommand !== null) {
            this.data.processes[streamType] = null;
            ffcommand.kill('SIGKILL');
        }

        if (rtl_task) {
            rtl_task.cancellProbeRetry();
            rtl_task = null;
        }
    }

    /**
     * restore the ffmpeg processes from jsondb (called on app start to restore ffmpeg processes
     * after the application has been killed or stuff
     */
    static async restoreProcesses() {
        // let db = new JsonDB(new Config(config.jsondb, true, false))
        const adr = this.data.addresses = await db.getData('/addresses');
        this.data.states = await db.getData('/states');
        this.data.options = await db.getData('/options');
        this.data.userActions = await db.getData('/userActions');
        this.writeToPlayerConfig();

        // check if a stream was repeated locally
        const rtlReconnect = ['connected', 'connecting', 'error'].includes(this.getState(RTL));
        if (rtlReconnect && adr.srcAddress) {
            this.startStreamAsync(new StrimingTask(adr.srcAddress, RTL), true);
        }
        else {
            this.updateState(RTL, 'disconnected');
        }


        // check if the stream was repeated to an output address
        const rtoReconnect = ['connected', 'connecting']
            .includes(this.getState('repeatToOptionalOutput'));
        if (rtoReconnect && adr.optionalOutputAddress) {
            this.startStream(new StrimingTask(adr.optionalOutputAddress, 'repeatToOptionalOutput'), true);
        }
        else {
            this.updateState('repeatToOptionalOutput', 'disconnected');
        }
    }

    /**write JSON file for persistence*/
    static writeToDB() {
        // let db = new JsonDB(new Config(config.jsondb, true, false))
        db.push('/', this.dataForJsonDb());
    }

    /**write player config to public directory*/
    static writeToPlayerConfig() {
        const data = 'var playerConfig = ' + JSON.stringify(this.data.options.player);
        fs.writeFileSync('src/webserver/public/config.js', data, 'utf8');
    }

    /**send websocket event to GUI to update the state of the streams*/
    static updateStreamDataOnGui() {
        wsCtrl.emit('updateStreamData', this.extractDataOfStreams());
    }

    /**send websocket event to GUI to update the state of the streams*/
    static updateProgressOnGui() {
        wsCtrl.emitOnConnections()?.('updateProgress', this.data.progresses);
    }

    /**
     * @typedef Options
     * @type {object}
     * @property {Array.<string>} video
     * @property {Array.<string>} audio
    */

    /**
     * append the ffmpeg options of the config file to an output
     * @param {string[]} probeArgs
     * @param {string} streamType
     * @returns {Promise.<Options, string>} return options on resolve and string on reject
     */
    static probeStream(probeArgs, streamType) {
        return new Promise((resolve, reject) => {
            execFile('ffprobe', probeArgs, { timeout: config.ffmpeg.probe.timeout, killSignal: 'SIGTERM' }, (err, stdout, stderr) => {
                if (err) {
                    if (!err.code && err.killed) {
                        reject("ffprobe timeout");
                        return;
                    }

                    let line = '';
                    for (const l of stderr.split('\n')) line = l || line;
                    reject(line || err.message);
                    return;
                }

                let video = null;
                let audio = null;
                const data = JSON.parse(stdout);

                if ('streams' in data) {
                    for (let s of data.streams) {
                        if (s.codec_type === 'video') {
                            if (video === null) {
                                video = s;
                                continue;
                            }

                            // Select the video stream with the highest number of pixels
                            if ((s.width * s.height) > (video.width * video.height)) {
                                video = s;
                            }
                        }
                        else if (s.codec_type === 'audio') {
                            if (audio === null) {
                                audio = s;
                                continue;
                            }

                            // Select the audio stream with highest number of channels
                            if (s.channels > audio.channels) {
                                audio = s;
                            }
                        }
                    }
                }

                if (video === null) {
                    reject("no video stream detected");
                    return;
                }

                this.data.options.video.id = video.index;
                this.data.options.audio.id = 'a';
                if (audio !== null) {
                    this.data.options.audio.id = audio.index;
                }

                const options = {
                    audio: [],
                    video: []
                };

                if (streamType === RTL) {
                    if (this.data.options.video.codec == 'h264') {
                        options.video.push('video_codec_h264');

                        if (this.data.options.video.profile != 'auto') {
                            options.video.push('video_codec_h264_profile');
                        }

                        if (this.data.options.video.tune != 'none') {
                            options.video.push('video_codec_h264_tune');
                        }
                    }
                    else {
                        if (video.codec_name != 'h264') {
                            reject("video stream must be h264, found " + video.codec_name);
                            return;
                        }

                        options.video.push('video_codec_copy');
                    }

                    if (audio !== null) {
                        if (this.data.options.audio.codec === 'none') {
                            options.audio.push('audio_codec_none');
                        }
                        else if (this.data.options.audio.codec === 'aac' || this.data.options.audio.codec === 'mp3') {
                            if (this.data.options.audio.preset === 'encode') {
                                options.audio.push('audio_preset_copy');
                            }

                            if (this.data.options.audio.codec === 'aac') {
                                options.audio.push('audio_codec_aac');
                            }
                            else {
                                options.audio.push('audio_codec_mp3');
                            }

                            options.audio.push('audio_preset_' + this.data.options.audio.preset);

                            if (this.data.options.audio.channels !== 'inherit' && this.data.options.audio.sampling !== 'inherit') {
                                options.audio.push('audio_filter_all');
                            }
                            else if (this.data.options.audio.channels != 'inherit') {
                                options.audio.push('audio_filter_channels');
                            }
                            else if (this.data.options.audio.sampling != 'inherit') {
                                options.audio.push('audio_filter_sampling');
                            }
                        }
                        else if (this.data.options.audio.codec === 'auto') {
                            options.audio.push('audio_preset_copy');

                            if (audio.codec_name == 'aac') {
                                options.audio.push('audio_codec_copy_aac');
                            } else if (audio.codec_name == 'mp3') {
                                options.audio.push('audio_codec_copy');
                            } else {
                                options.audio.push('audio_codec_aac');
                                options.audio.push('audio_preset_encode');
                            }
                        }
                        else {
                            options.audio.push('audio_preset_copy');

                            switch (audio.codec_name) {  // consider all allowed audio codecs for FLV
                                case 'mp3':
                                case 'pcm_alaw':
                                case 'pcm_mulaw':
                                    options.audio.push('audio_codec_copy');
                                    break;

                                case 'aac':
                                    options.audio.push('audio_codec_copy_aac');
                                    break;

                                default:
                                    if (this.data.options.audio.codec === 'copy') {
                                        reject("can't copy audio stream, found unsupported codec " + audio.codec_name);
                                        return;
                                    }
                                    else {
                                        options.audio.push('audio_codec_aac');
                                        options.audio.push('audio_preset_encode');
                                    }
                            }
                        }
                    }
                    else {
                        if (this.data.options.audio.codec === 'aac' || this.data.options.audio.codec === 'auto') {
                            options.audio.push('audio_codec_aac');
                            options.audio.push('audio_preset_silence');
                            options.audio.push('audio_filter_all');
                        }
                        else if (this.data.options.audio.codec === 'mp3') {
                            options.audio.push('audio_codec_mp3');
                            options.audio.push('audio_preset_silence');
                            options.audio.push('audio_filter_all');
                        }
                        else {
                            options.audio.push('audio_codec_none');
                        }
                    }
                }
                else {
                    options.video.push('video_codec_copy');

                    if (audio !== null) {
                        options.audio.push('audio_preset_copy');

                        if (audio.codec_name == 'aac') {
                            options.audio.push('audio_codec_copy_aac');
                        }
                        else {
                            options.audio.push('audio_codec_copy');
                        }
                    }
                    else {
                        options.audio.push('audio_codec_none');
                    }
                }

                if (streamType === RTL) {
                    this.data.addresses.srcStreams.video = {
                        index: video.index,
                        type: "video",
                        codec: video.codec_name,
                        width: video.width,
                        height: video.height,
                        format: video.pix_fmt
                    };

                    if (audio !== null) {
                        this.data.addresses.srcStreams.audio = {
                            index: audio.index,
                            type: "audio",
                            codec: audio.codec_name,
                            layout: audio.channel_layout,
                            channels: audio.channels,
                            sampling: audio.sample_rate
                        };
                    }

                    this.writeToDB();
                }

                resolve(options);
            });
        });
    }

    // /**
    //  * append the ffmpeg options of the config file to an output
    //  * @param {string} streamUrl
    //  * @param {string} streamType
    //  * @return {Promise | null}
    //  */
    // static probeStreamPr(streamUrl, streamType) {
    //     const deferred = Q.defer();

    //     const state = Restreamer.getState(streamType);
    //     if (state != 'connecting') {
    //         logger.dbg?.('Skipping "startStream" because state is not "connecting". Current state is "' + state + '".', streamType);
    //         return null;
    //     }

    //     // if (streamType == 'repeatToLocalNginx') {
    //     //     Restreamer.data.addresses.srcStreams = {
    //     //         audio: {},
    //     //         video: {}
    //     //     };
    //     //     Restreamer.writeToDB();
    //     // }

    //     (function doProbe(streamUrl) {
    //         const probeArgs = [
    //             '-of',
    //             'json',
    //             '-v',
    //             'error',
    //             '-show_streams',
    //             '-show_format'
    //         ];

    //         if (streamUrl.startsWith('rtsp') && Restreamer.data.options.rtspTcp === true) {
    //             probeArgs.push('-rtsp_transport', 'tcp');
    //             probeArgs.push(probe_tot_key, socket_timeout);
    //         }

    //         probeArgs.push(streamUrl);

    //         // /**@param {CallableFunction} cb*/
    //         // const wrapper = (...args) => {
    //         //     const cb = args.pop();
    //         //     execFile(...args, (err, stdout, stderr) => {
    //         //         // cb here
    //         //         cb(null, { err, stdout, stderr });
    //         //     });
    //         // }

    //         const efp = util.promisify((...args) => {
    //             const cb = args.pop();
    //             execFile(...args, (err, stdout, stderr) => {
    //                 // cb here
    //                 cb(null, { err, stdout, stderr });
    //             });
    //         });

    //         efp('ffprobe', probeArgs, { timeout: parseInt(config.ffmpeg.probe.timeout), killSignal: 'SIGTERM' })
    //             .then(result => {
    //                 return result;
    //             })

    //         // ef('ffprobe', probeArgs, { timeout: parseInt(config.ffmpeg.probe.timeout), killSignal: 'SIGTERM' })
    //         //     .then((stdout, stderr) => {
    //         //     })
    //         //     .catch(err => {

    //         //     })

    //         execFile('ffprobe', probeArgs, { timeout: parseInt(config.ffmpeg.probe.timeout), killSignal: 'SIGTERM' }, (err, stdout, stderr) => {
    //             if (err) {
    //                 if (!err.code && err.killed) {
    //                     return deferred.reject("ffprobe timeout");
    //                 }

    //                 let lines = stderr.toString().split(/\r\n|\r|\n/);
    //                 lines = lines.filter(function (line) {
    //                     return line.length > 0;
    //                 });

    //                 if (lines.length == 0) {
    //                     return deferred.reject("failed to execute ffprobe: " + err.message);
    //                 }

    //                 return deferred.reject(lines[lines.length - 1]);
    //             }

    //             // console.log(ffprobe);
    //             let video = null;
    //             let audio = null;
    //             let data;

    //             try {
    //                 data = JSON.parse(stdout);
    //             }
    //             catch (e) {
    //                 return deferred.reject("failed to parse probe result: " + e.message);
    //             }

    //             if (!('streams' in data)) {
    //                 data.streams = [];
    //             }

    //             for (let s of data.streams) {
    //                 if (s.codec_type == 'video') {
    //                     if (video === null) {
    //                         video = s;
    //                         continue;
    //                     }

    //                     // Select the video stream with the highest number of pixels
    //                     if ((s.width * s.height) > (video.width * video.height)) {
    //                         video = s;
    //                     }
    //                 }
    //                 else if (s.codec_type == 'audio') {
    //                     if (audio === null) {
    //                         audio = s;
    //                         continue;
    //                     }

    //                     // Select the audio stream with highest number of channels
    //                     if (s.channels > audio.channels) {
    //                         audio = s;
    //                     }
    //                 }
    //             }

    //             if (video === null) {
    //                 return deferred.reject("no video stream detected");
    //             }

    //             Restreamer.data.options.video.id = video.index;
    //             Restreamer.data.options.audio.id = 'a';
    //             if (audio !== null) {
    //                 Restreamer.data.options.audio.id = audio.index;
    //             }

    //             let options = {
    //                 audio: [],
    //                 video: []
    //             };

    //             if (streamType == 'repeatToLocalNginx') {
    //                 if (Restreamer.data.options.video.codec == 'h264') {
    //                     options.video.push('video_codec_h264');

    //                     if (Restreamer.data.options.video.profile != 'auto') {
    //                         options.video.push('video_codec_h264_profile');
    //                     }

    //                     if (Restreamer.data.options.video.tune != 'none') {
    //                         options.video.push('video_codec_h264_tune');
    //                     }
    //                 }
    //                 else {
    //                     if (video.codec_name != 'h264') {
    //                         return deferred.reject("video stream must be h264, found " + video.codec_name);
    //                     }

    //                     options.video.push('video_codec_copy');
    //                 }

    //                 if (audio !== null) {
    //                     if (Restreamer.data.options.audio.codec == 'none') {
    //                         options.audio.push('audio_codec_none');
    //                     }
    //                     else if (Restreamer.data.options.audio.codec == 'aac' || Restreamer.data.options.audio.codec == 'mp3') {
    //                         if (Restreamer.data.options.audio.preset == 'encode') {
    //                             options.audio.push('audio_preset_copy');
    //                         }

    //                         if (Restreamer.data.options.audio.codec == 'aac') {
    //                             options.audio.push('audio_codec_aac');
    //                         }
    //                         else {
    //                             options.audio.push('audio_codec_mp3');
    //                         }

    //                         options.audio.push('audio_preset_' + Restreamer.data.options.audio.preset);

    //                         if (Restreamer.data.options.audio.channels != 'inherit' && Restreamer.data.options.audio.sampling != 'inherit') {
    //                             options.audio.push('audio_filter_all');
    //                         }
    //                         else if (Restreamer.data.options.audio.channels != 'inherit') {
    //                             options.audio.push('audio_filter_channels');
    //                         }
    //                         else if (Restreamer.data.options.audio.sampling != 'inherit') {
    //                             options.audio.push('audio_filter_sampling');
    //                         }
    //                     }
    //                     else if (Restreamer.data.options.audio.codec == 'auto') {
    //                         options.audio.push('audio_preset_copy');

    //                         if (audio.codec_name == 'aac') {
    //                             options.audio.push('audio_codec_copy_aac');
    //                         } else if (audio.codec_name == 'mp3') {
    //                             options.audio.push('audio_codec_copy');
    //                         } else {
    //                             options.audio.push('audio_codec_aac');
    //                             options.audio.push('audio_preset_encode');
    //                         }
    //                     }
    //                     else {
    //                         options.audio.push('audio_preset_copy');

    //                         switch (audio.codec_name) {  // consider all allowed audio codecs for FLV
    //                             case 'mp3':
    //                             case 'pcm_alaw':
    //                             case 'pcm_mulaw':
    //                                 options.audio.push('audio_codec_copy');
    //                                 break;
    //                             case 'aac':
    //                                 options.audio.push('audio_codec_copy_aac');
    //                                 break;
    //                             default:
    //                                 if (Restreamer.data.options.audio.codec == 'copy') {
    //                                     return deferred.reject("can't copy audio stream, found unsupported codec " + audio.codec_name);
    //                                 }
    //                                 else {
    //                                     options.audio.push('audio_codec_aac');
    //                                     options.audio.push('audio_preset_encode');
    //                                 }
    //                         }
    //                     }
    //                 }
    //                 else {
    //                     if (Restreamer.data.options.audio.codec == 'aac' || Restreamer.data.options.audio.codec == 'auto') {
    //                         options.audio.push('audio_codec_aac');
    //                         options.audio.push('audio_preset_silence');
    //                         options.audio.push('audio_filter_all');
    //                     }
    //                     else if (Restreamer.data.options.audio.codec == 'mp3') {
    //                         options.audio.push('audio_codec_mp3');
    //                         options.audio.push('audio_preset_silence');
    //                         options.audio.push('audio_filter_all');
    //                     }
    //                     else {
    //                         options.audio.push('audio_codec_none');
    //                     }
    //                 }
    //             }
    //             else {
    //                 options.video.push('video_codec_copy');

    //                 if (audio !== null) {
    //                     options.audio.push('audio_preset_copy');

    //                     if (audio.codec_name == 'aac') {
    //                         options.audio.push('audio_codec_copy_aac');
    //                     }
    //                     else {
    //                         options.audio.push('audio_codec_copy');
    //                     }
    //                 }
    //                 else {
    //                     options.audio.push('audio_codec_none');
    //                 }
    //             }

    //             if (streamType == 'repeatToLocalNginx') {
    //                 Restreamer.data.addresses.srcStreams.video = {
    //                     index: video.index,
    //                     type: "video",
    //                     codec: video.codec_name,
    //                     width: video.width,
    //                     height: video.height,
    //                     format: video.pix_fmt
    //                 };

    //                 if (audio !== null) {
    //                     Restreamer.data.addresses.srcStreams.audio = {
    //                         index: audio.index,
    //                         type: "audio",
    //                         codec: audio.codec_name,
    //                         layout: audio.channel_layout,
    //                         channels: audio.channels,
    //                         sampling: audio.sample_rate
    //                     };
    //                 }

    //                 Restreamer.writeToDB();
    //             }

    //             return deferred.resolve(options);
    //         });

    //     })(streamUrl);

    //     return deferred.promise;
    // }

    /**
     * update the state of the stream
     * @param {string} streamType
     * @param {string} state
     * @param {string | undefined} message
     * @return {string} name of the new state
     */
    static updateState(streamType, state, message = '') {
        const previousState = this.setState(streamType, state, message);

        if (previousState === state)
            return state;

        // logger.dbg?.('Update state from "' + previousState + '" to "' + state + '"', streamType);

        if (streamType === RTL && state === 'connected') {
            this.fetchSnapshot();
        }

        // this.writeToDB()
        this.updateStreamDataOnGui();
        return state;
    }

    /**
     * @param {string} streamType
     * @param {string} state
     * @param {string | undefined} message
     */
    static setState(streamType, state, message) {
        const previousState = this.data.states[streamType].type;

        if (typeof message != 'string')
            message = '';

        this.data.states[streamType] = {
            'type': state,
            'message': message
        };

        return previousState;
    }

    /**
     * get the state of the stream
     * @param {string} streamType
     * @return {string} name of the new state
     */
    static getState(streamType) {
        return Restreamer.data.states[streamType].type;
    }

    /**
     * get the current user action
     * @param {string} streamType
     * @return {string} name of the user action
     */
    static getUserAction(streamType) {
        return Restreamer.data.userActions[streamType];
    }

    /**
     * set the current user action
     * @param {string} streamType
     * @param {string} action
     * @return {string} name of the previous user action
     */
    static setUserAction(streamType, action) {
        const previousAction = this.data.userActions[streamType];
        this.data.userActions[streamType] = action;
        return previousAction;
    }

    /**
     * update the last submitted user action (like click on stop stream, click on start stream)
     * @param {string} streamType
     * @param {string} action user action
     * @return {string} name of the new user action
     */
    static updateUserAction(streamType, action) {
        let previousAction = this.setUserAction(streamType, action);

        if (previousAction === action) return action;

        logger.dbg?.('Set user action from "' + previousAction + '" to "' + action + '"', streamType);

        this.writeToDB();
        this.updateStreamDataOnGui();
        return action;
    }

    static updatePlayerOptions(player) {
        this.data.options.player = player;
        logger.dbg?.('Storing player options', 'Restreamer');
        this.writeToPlayerConfig();
        this.writeToDB();
    }

    /**
     * update options
     * @param {Object} options
     */
    static updateOptions(options) {
        this.data.options = options;
        this.writeToDB();
        this.updateStreamDataOnGui();
    }

    /**
     * @param {StrimingTask} task
     * @returns {FfmpegCommand.FfmpegCommand}
    */
    static buildCommand(task) {
        const rtmpUrl = this.getRTMPStreamUrl();
        const command = new FfmpegCommand(task.streamType == RTL ? task.streamUrl : rtmpUrl, {
            stdoutLines: 1
        });

        if (task.streamType === RTL) {
            // repeat to local nginx server
            this.addStreamOptions(command, 'global', null);
            this.addStreamOptions(command, 'video', null);
            this.addStreamOptions(command, 'local_mpegts', null); //rtmp

            // RTSP options
            if (task.streamUrl.startsWith('rtsp')) {
                this.addStreamOptions(command, 'rtsp', null);

                if (this.data.options.rtspTcp)
                    this.addStreamOptions(command, 'rtsp-tcp', null);
            }

            // add outputs to the ffmpeg stream
            command.output("/tmp/hls/live.stream.m3u8"); //command.output(rtmpUrl)
        }
        else {
            // repeat to optional output - not used cuurently
            this.addStreamOptions(command, 'global', null);
            this.addStreamOptions(command, 'video', null);

            if (this.data.options.output.type == 'hls') {
                this.addStreamOptions(command, 'hls', this.data.options.output.hls);
            }
            else {
                this.addStreamOptions(command, 'rtmp', null);
            }

            // add outputs to the ffmpeg stream
            command.output(task.streamUrl);
        }

        return command;
    }

    /**
     * @param {StrimingTask} task
    */
    static async getOptions(task) {
        let options = null;
        const url = task.streamType === RTL ? task.streamUrl : this.getRTMPStreamUrl();
        const probeArgs = [
            '-of',
            'json',
            '-v',
            'error',
            '-show_streams',
            '-show_format'
        ];

        if (url.startsWith('rtsp') && this.data.options.rtspTcp === true) {
            probeArgs.push('-rtsp_transport', 'tcp');
            probeArgs.push(probe_tot_key, socket_timeout);
        }

        probeArgs.push(url);

        const stopClicked = () => {
            if (this.data.userActions[task.streamType] === 'stop') {
                this.updateState(task.streamType, 'disconnected');
                // logger.dbg?.('Skipping retry since "stop" has been clicked', task.streamType);
                return true;
            }
            return false;
        }

        while (!options && !stopClicked()) {
            options = await this.probeStream(probeArgs, task.streamType)
                .catch(
                    /**@param {string} error reject reason*/
                    error => {
                        logger.err?.('Failed to spawn ffprobe: ' + error, task.streamType);
                        this.updateState(task.streamType, 'error', error);
                        return null;
                    });

            if (stopClicked()) {
                options = null;
                break;
            }

            if (!options) {
                logger.dbg?.(`Try spawn ffprobe in ${task.probeRetryTime()} ms`, task.streamType);
                await task.waitProbeRetry();
            }
        }

        return options;
    }

    /**
     * 
     * @param {StrimingTask} task 
     * @param {boolean} [force]
     * @returns 
     */
    static async startStreamAsync(task, force) {
        logger.inf?.('Start streaming', task.streamType);
        if (rtl_task === null) {
            rtl_task = task;
        }

        if (!force) {
            const state = this.getState(task.streamType);
            if (state == 'connected' || state == 'connecting') {
                logger.dbg?.(`Skipping "startStream" because state is "${state}".`, task.streamType);
                return;
            }
        }

        // update the state on the frontend
        this.updateState(task.streamType, 'connecting');
        let options = await this.getOptions(task);
        if (null === options) return;

        // options: { audio: [ 'audio_codec_none' ], video: [ 'video_codec_copy' ] }

        task.connected = false;
        const command = this.buildCommand(task);

        const replace_video = {
            videoid: this.data.options.video.id,
            preset: this.data.options.video.preset,
            bitrate: this.data.options.video.bitrate,
            fps: this.data.options.video.fps,
            gop: parseInt(this.data.options.video.fps) * 2,
            profile: this.data.options.video.profile,
            tune: this.data.options.video.tune
        };

        for (let vo of options.video)
            this.addStreamOptions(command, vo, replace_video);

        const replace_audio = {
            audioid: this.data.options.audio.id,
            bitrate: this.data.options.audio.bitrate,
            channels: this.data.options.audio.channels,
            sampling: this.data.options.audio.sampling
        };

        for (let ao of options.audio)
            this.addStreamOptions(command, ao, replace_audio);

        command
            .on('start', commandLine => {
                task.reset();
                this.data.processes[task.streamType] = command;

                if (this.data.userActions[task.streamType] === 'stop') {
                    this.stopStream(task.streamType);
                    logger.dbg?.('Skipping on "start" event of FFmpeg command because "stop" has been clicked', task.streamType);
                    return;
                }

                logger.dbg?.('Spawned: ' + commandLine, task.streamType);
            })
            .on('end', () => {
                task.reset();
                this.data.processes[task.streamType] = null;
                this.data.progresses[task.streamType].currentFps = 0;
                this.data.progresses[task.streamType].currentKbps = 0;

                if (this.data.userActions[task.streamType] === 'stop') {
                    this.updateState(task.streamType, 'disconnected');
                    logger.dbg?.('Skipping retry because "stop" has been clicked', task.streamType);
                    return;
                }

                logger.inf?.(task.streamType + ': ended normally');
                this.updateState(task.streamType, 'stopped');
                this.retryAsync(task);
            })
            .on('error', error => {
                task.reset();
                this.data.processes[task.streamType] = null;
                this.data.progresses[task.streamType].currentFps = 0;
                this.data.progresses[task.streamType].currentKbps = 0;

                if (this.data.userActions[task.streamType] === 'stop') {
                    this.updateState(task.streamType, 'disconnected');
                    logger.dbg?.('Skipping retry since "stop" has been clicked', task.streamType);
                    return;
                }

                logger.error(error.message, task.streamType);
                this.updateState(task.streamType, 'error', error.message);
                this.retryAsync(task);
            })
            .once('stderr', () => {
                logger.dbg?.('connected', task.streamType);
                this.updateState(task.streamType, 'connected');
                task.beginStaleDetection();
                task.connected = true;
            })
            .on('stderr', (str) => {
                if (!str.startsWith('frame=')) {
                    logger.wrn?.(`msg: '${str}'`, 'stderr');
                    return;
                }

                /**@type {Progress}*/
                const p = this.data.progresses[task.streamType];
                const n = parseInt(str.slice(6), 10);
                p.currentFps = (n - p.frames) / 2;
                p.frames = task.nFrames = n;
                this.updateProgressOnGui();
            });

        this.data.progresses[task.streamType].frames = 0;
        command.run();
    }

    /**
     * перезапуск потока
     * @param {StrimingTask} task 
     */
    static retry(task) {
        logger.inf?.('Schedule connect to "' + task.streamUrl + '" in ' + restartTimespan + ' ms', task.streamType);

        this.setTimeoutUnsafe(task, 'retry', (t) => {
            // this.data.timeouts.retry[t.streamType] = null;

            if (Restreamer.data.userActions[t.streamType] === 'stop') {
                logger.dbg?.('Skipping retry because "stop" has been clicked', task.streamType);
                this.updateState(task.streamType, 'disconnected');
                return;
            }

            logger.inf?.(`Retry connect to "${t.streamUrl}"`, t.streamType);
            Restreamer.startStreamAsync(t);
        }, restartTimespan);
    }

    /**
     * перезапуск стрима
     * @param {StrimingTask} task 
     */
    static async retryAsync(task) {
        logger.inf?.('Schedule connect to "' + task.streamUrl + '" in ' + restartTimespan + ' ms', task.streamType);
        if (await (task.retryTimer ??= new Timer()).wait(restartTimespan)) {
            logger.inf?.(`Retry connect to "${task.streamUrl}"`, task.streamType);
            this.startStreamAsync(task);
        }
    }

    /**
     * 
     * @param {StrimingTask} task 
     * @param {boolean} force 
     * @returns 
     */
    // static async InitStreaming(task, force = false) {
    //     if (!force) {
    //         // check if there's currently no other stream connected or connecting
    //         const state = this.getState(task.streamType)
    //         if (state == 'connected' || state == 'connecting') {
    //             logger.dbg?.(`Skipping "startStream" because state is "${state}".`, task.streamType)
    //             return
    //         }
    //     }

    //     // check if the user has clicked 'stop' meanwhile, so the startStream process has to be skipped
    //     // if (this.getUserAction(task.streamType) === 'stop') {
    //     //     this.stopStream(task.streamType)
    //     //     logger.dbg?.('Skipping "startStream" because "stop" has been clicked', task.streamType)
    //     //     return
    //     // }

    //     const url = task.streamType === RTL ? task.streamUrl : this.getRTMPStreamUrl()
    //     let options = null
    //     while (!options) {

    //         options = await this.probeStream(url, task.streamType).catch(
    //             /**@param {string} error reject reason*/
    //             error => {
    //                 logger.err?.('Failed to spawn ffprobe: ' + error, task.streamType)
    //                 this.updateState(task.streamType, 'error', error)
    //             })

    //         if (this.data.userActions[task.streamType] === 'stop') {
    //             this.updateState(task.streamType, 'disconnected')
    //             logger.dbg?.('Skipping retry since "stop" has been clicked', task.streamType)
    //             return
    //         }

    //         if (!options) {
    //             logger.dbg?.(`Try spawn ffprobe in ${task.restart_wait} ms`, task.streamType)
    //             await timeout(task.restart_wait += 90)
    //         }
    //     }

    //     return this.startStreamAsync(task, force);
    // }

    /**
     * 
     * @param {StrimingTask} task 
     * @param {boolean} [force]
     * @returns 
     */
    static startStream(task, force) {
        // remove any running timeouts
        Restreamer.setTimeout(task.streamType, 'retry', null);
        Restreamer.setTimeout(task.streamType, 'stale', null);

        if (!force) {
            // check if there's currently no other stream connected or connecting
            let state = Restreamer.getState(task.streamType);
            if (state == 'connected' || state == 'connecting') {
                logger.dbg?.(`Skipping "startStream" because state is "${state}".`, task.streamType);
                return;
            }
        }

        // check if the user has clicked 'stop' meanwhile, so the startStream process has to be skipped
        if (Restreamer.getUserAction(task.streamType) == 'stop') {
            Restreamer.stopStream(task.streamType);
            logger.dbg?.('Skipping "startStream" because "stop" has been clicked', task.streamType);
            return;
        }

        logger.inf?.('Start streaming', task.streamType);

        // update the state on the frontend
        Restreamer.updateState(task.streamType, 'connecting')
        const probePromise = Restreamer.probeStream(
            task.streamType === RTL ? task.streamUrl : Restreamer.getRTMPStreamUrl(),
            task.streamType
        );

        if (probePromise === null) {
            logger.dbg?.('Skipping "startStream" because promise is null', task.streamType);
            return;
        }

        const retry = () => {
            logger.inf?.('Schedule connect to "' + task.streamUrl + '" in ' + task.restart_wait + ' ms', task.streamType);
            Restreamer.setTimeout(task.streamType, 'retry', () => {
                if (Restreamer.data.userActions[task.streamType] == 'stop') {
                    logger.dbg?.('Skipping retry because "stop" has been clicked', task.streamType);
                    Restreamer.updateState(task.streamType, 'disconnected');
                    return;
                }

                logger.inf?.('Retry to connect to "' + task.streamUrl + '"', task.streamType);
                Restreamer.startStream(task);
            }, task.restart_wait);
            task.restart_wait += 100;
        }

        // after adding outputs, define events on the new FFmpeg stream
        probePromise.then((options) => {
            task.connected = false;
            const command = this.buildCommand(task);

            const replace_video = {
                videoid: this.data.options.video.id,
                preset: this.data.options.video.preset,
                bitrate: this.data.options.video.bitrate,
                fps: this.data.options.video.fps,
                gop: (parseInt(this.data.options.video.fps) * 2) + '',
                profile: this.data.options.video.profile,
                tune: this.data.options.video.tune
            }

            for (let o in options.video) {
                if (o.length) this.addStreamOptions(command, options.video[o], replace_video);
            }

            const replace_audio = {
                audioid: this.data.options.audio.id,
                bitrate: this.data.options.audio.bitrate,
                channels: this.data.options.audio.channels,
                sampling: this.data.options.audio.sampling
            }

            for (let o in options.audio) {
                if (o.length) this.addStreamOptions(command, options.audio[o], replace_audio);
            }

            command
                .on('start', (commandLine) => {
                    task.reset();
                    Restreamer.data.processes[task.streamType] = command;

                    if (Restreamer.data.userActions[task.streamType] == 'stop') {
                        Restreamer.stopStream(task.streamType);
                        logger.dbg?.('Skipping on "start" event of FFmpeg command because "stop" has been clicked', task.streamType);
                        return;
                    }

                    logger.dbg?.('Spawned: ' + commandLine, task.streamType);
                })

                // stream ended
                .on('end', () => {
                    Restreamer.data.processes[task.streamType] = null;
                    Restreamer.setTimeout(task.streamType, 'retry', null);
                    Restreamer.setTimeout(task.streamType, 'stale', null);
                    Restreamer.data.progresses[task.streamType].currentFps = 0;
                    Restreamer.data.progresses[task.streamType].currentKbps = 0;

                    Restreamer.updateState(task.streamType, 'stopped');

                    if (Restreamer.data.userActions[task.streamType] == 'stop') {
                        Restreamer.updateState(task.streamType, 'disconnected');
                        logger.dbg?.('Skipping retry because "stop" has been clicked', task.streamType);
                        return;
                    }

                    logger.inf?.(task.streamType + ': ended normally');
                    retry();
                })

                // stream error handler (error, _stdout, _stderr)
                .on('error', error => {
                    Restreamer.data.processes[task.streamType] = null;
                    Restreamer.setTimeout(task.streamType, 'retry', null);
                    Restreamer.setTimeout(task.streamType, 'stale', null);
                    Restreamer.data.progresses[task.streamType].currentFps = 0;
                    Restreamer.data.progresses[task.streamType].currentKbps = 0;

                    if (Restreamer.data.userActions[task.streamType] == 'stop') {
                        Restreamer.updateState(task.streamType, 'disconnected');
                        logger.dbg?.('Skipping retry since "stop" has been clicked', task.streamType);
                        return;
                    }

                    // logger.error(error.message, task.streamType);
                    logger.error(error.toString(), task.streamType);
                    Restreamer.updateState(task.streamType, 'error', error.toString());
                    retry();
                })

                // progress handler
                .on('progress', (progress) => {
                    if (!task.connected && Restreamer.data.states[task.streamType].type == 'connecting') {
                        Restreamer.updateState(task.streamType, 'connected');
                        task.connected = true;
                    }

                    // compare the current number of frames
                    if (task.nFrames != progress.frames) {
                        task.nFrames = progress.frames;
                        // add/reset a stale timeout if the number of frames changed
                        Restreamer.setTimeout(task.streamType, 'stale', () => {
                            logger.warn('Stale connection', task.streamType);
                            Restreamer.stopStream(task.streamType);
                        }, config.ffmpeg.monitor.stale_wait);
                    }

                    Restreamer.data.progresses[task.streamType] = progress;
                    Restreamer.updateProgressOnGui();
                })

            command.run();
        }).catch((error) => {
            logger.error('Failed to spawn ffprobe: ' + error.toString(), task.streamType);
            if (Restreamer.data.userActions[task.streamType] == 'stop') {
                Restreamer.updateState(task.streamType, 'disconnected');
                logger.dbg?.('Skipping retry since "stop" has been clicked', task.streamType);
                return;
            }

            Restreamer.updateState(task.streamType, 'error', error.toString());
            retry();
        })
    }

    /**
     * set a timeout
     * @param {string} streamType Either ${RTL} or 'repeatToOptionalOutput'
     * @param {string} target Kind of timeout, either 'retry' or 'stale'
     * @param {function | null} func Callback function
     * @param {number | undefined} [delay] Delay for the timeout
     * @return {void}
     */
    static setTimeout(streamType, target, func, delay) {
        const tots = this.data.timeouts;

        if (!Object.prototype.hasOwnProperty.call(tots, target)) {
            logger.error('Unknown target for timeout', streamType);
            return;
        }

        if (!(streamType in tots[target])) {
            logger.error('Unknown stream type for timeout target "' + target + '"', streamType);
            return;
        }

        clearTimeout(tots[target][streamType]);

        if (typeof func == 'function') {
            tots[target][streamType] = setTimeout(func, delay);
        }
    }

    /**
     * set a timeout
     * @param {StrimingTask} task 
     * @param {string} target Kind of timeout, either 'retry', 'stale' or 'snapshot'
     * @param {(arg: StrimingTask) => void} [func] Callback function
     * @param {number | undefined} delay Delay for the timeout
     * @return {void}
     */
    static setTimeoutUnsafe(task, target, func, delay) {
        let tos = this.data.timeouts[target];
        /**@type {NodeJS.Timeout} */
        let to = tos[task.streamType];
        tos[task.streamType] = to?.refresh() ?? setTimeout(func, delay, task);

        // (to ?? false) && clearTimeout(to);
        // tos[task.streamType] = (func ?? false) === false ? null : setTimeout(func, delay, task);
    }

    /**bind websocket events on application start*/
    static bindWebsocketEvents() {
        wsCtrl.setConnectCallback(socket => {
            // logger.dbg?.('ConnectionCallback');
            socket.emit('publicIp', this.data.publicIp);

            socket.on('startStream', options => {
                // logger.dbg?.('Got "startStream" event', options.streamType)
                this.updateUserAction(options.streamType, 'start');
                this.updateOptions(options.options);

                let streamUrl = '';
                if (options.streamType == RTL) {
                    this.data.addresses.srcAddress = options.src;
                    streamUrl = options.src;
                }
                else if (options.streamType === 'repeatToOptionalOutput') {
                    this.data.addresses.optionalOutputAddress = options.optionalOutput;
                    streamUrl = options.optionalOutput;
                }
                else {
                    return;
                }

                this.startStreamAsync(new StrimingTask(streamUrl, options.streamType));
            });

            socket.on('stopStream', streamType => {
                // logger.dbg?.('Got "stopStream" event', streamType)
                this.updateUserAction(streamType, 'stop');
                this.stopStream(streamType);
            });

            socket.on('checkStates', () => {
                // logger.dbg?.('Got "checkStates" event')
                this.updateStreamDataOnGui();
            });

            socket.on('playerOptions', player => {
                // logger.dbg?.('Got "playerOptions" event')
                this.updatePlayerOptions(player);
            });

            // socket.on('disconnect', (reason) => logger.inf?.('disconnect: ' + reason))
        });
    }

    /**
     * creates an object of available streaming data like states and addresses to be able
     * to write it to filesystem
     * @returns {object}
     */
    static extractDataOfStreams() {
        return {
            'addresses': this.data.addresses,
            'options': this.data.options,
            'userActions': this.data.userActions,
            'states': this.data.states
        };
    }

    /**
     * create with only the data, that is needed by the jsonDb
     * @return {object}
     */
    static dataForJsonDb() {
        return {
            'addresses': this.data.addresses,
            'options': this.data.options,
            'userActions': this.data.userActions,
            'states': this.data.states
        };
    }

    static checkForUpdates() {
        logger.info('Update checking disabled, skip...');

        // const url = {'host': 'datarhei.com', 'path': '/apps.json'}
        // logger.dbg?.('Checking for updates...', 'checkForUpdates')
        // https.get(url, (response) => {
        //     if (response.statusCode === 200) {
        //         response.on('data', (body) => {
        //             var updateCheck = JSON.parse(body)
        //             var updateAvailable = require('semver').lt(packageJson.version, updateCheck.restreamer.version)
        //             logger.info(`Update checking succeeded. ${updateAvailable ? 'Update' : 'No updates'} available`, 'checkForUpdates')
        //             logger.dbg?.(`local: ${packageJson.version}; remote: ${updateCheck.restreamer.version}`, 'checkForUpdates')
        //             Restreamer.data.updateAvailable = updateAvailable
        //             WebsocketsController.emit('update', updateAvailable)
        //         })
        //     } else {
        //         logger.warn(`Got ${String(response.statusCode)} status while trying to fetch update info`, 'checkForUpdates')
        //     }
        // }).on('error', () => {
        //     logger.warn('Failed fetching update info', 'checkForUpdates')
        // })
        // setTimeout(Restreamer.checkForUpdates, 12 * 3600 * 1000)
    }

    static getPublicIp() {
        logger.info('Retrieving public IP ...', 'publicIP');
        this.data.publicIp = '127.0.0.1';
    }

    static close() {
        /**@type {FfmpegCommand.FfmpegCommand}*/ let cmd = this.data.processes.repeatToLocalNginx;
        Restreamer.setUserAction(RTL, 'stop');
        if (cmd?.ffmpegProc) {
            rtl_task?.reset();
            cmd.removeAllListeners('error');
            cmd.on('error', () => { }).kill();
        }
    }
}

const RsData = require("./RsData");
Restreamer.data = new RsData;

/**
 * @typedef Progress
 * @type {object}
 * @property {number} frames
 * @property {number} currentFps
 * @property {number} currentKbps
 */

/**
 * Information to start stream
 * @param {string} streamUrl 
 * @param {string} streamType 
 */
function StrimingTask(streamUrl, streamType) {
    const defaultWait = config.ffmpeg.monitor.restart_wait;
    this.streamUrl = streamUrl;
    this.streamType = streamType;
    // this.progress = Restreamer.data.progresses[streamType]

    /**@type {boolean} */
    this.connected;

    /**Current number of processed frames for stale detection @type {number}*/
    this.nFrames;

    /**Reconnect period (ms) @type {number}*/
    this.restart_wait;
    this.intervalId;
    this.prevnFrame;
    /** @type {rtimer} */
    this.probeRetryTimer;
    /** @type {Timer} */
    this.retryTimer;

    this.reset = () => {
        this.connected = false;
        this.nFrames = 0;
        this.prevnFrame = 0;
        this.restart_wait = defaultWait;

        if (this.intervalId) {
            logger.dbg?.(`Clear stale interval`, this.streamType);
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }

        if (this.probeRetryTimer) {
            this.probeRetryTimer = null;
        }
    };

    this.beginStaleDetection = () => {
        this.intervalId = setInterval(() => {
            logger.dbg?.(`check stale, frames: ${this.nFrames}`, this.streamType);
            if (!this.connected) return;
            if (this.nFrames === this.prevnFrame) {
                Restreamer.stopStream(this.streamType);
                return;
            }
            this.prevnFrame = this.nFrames;
        }, config.ffmpeg.monitor.stale_wait).unref();
    };

    this.waitProbeRetry = () => (this.probeRetryTimer ??= new rtimer(this.restart_wait, 88)).wait();

    this.cancellProbeRetry = () => {
        if (this.probeRetryTimer) {
            logger.inf?.('Try cancell probe retry timer', this.streamType);
            this.probeRetryTimer.cancell();
            this.probeRetryTimer = null;
        }
    };

    this.reset();
}

StrimingTask.prototype.probeRetryTime = function () {
    return this.probeRetryTimer?.current ?? this.restart_wait;
}

module.exports = Restreamer;
