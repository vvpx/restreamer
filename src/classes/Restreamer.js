'use strict';

const config = globalThis.appConfig;
const RTL = "repeatToLocalNginx";
const RTO = "repeatToOptionalOutput";

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const Ffmpeg = require('fluent-ffmpeg');
/**@typedef {Ffmpeg.FfmpegCommand} FF*/

const { JsonDB, Config } = require('node-json-db');
const logger = require('./Logger')('Restreamer');
const wsCtrl = require('./WebsocketsController');
const { RaisingTimer: rtimer, Timer } = require('./Timers.js');
const RsData = require("./RsData");
// const task_key = Symbol.for('task');

const defaultWait = config.ffmpeg.monitor.restart_wait;
const { timeout_key: probe_tot_key, socket_timeout } = config.ffmpeg.probe;
const restartTimespan = config.ffmpeg.monitor.restart_wait;
const db = new JsonDB(new Config(config.jsondb, true, false));
const data = new RsData();


/**
 * @typedef Progress
 * @type {object}
 * @property {number} frames
 * @property {number} currentFps
 * @property {number} currentKbps
 */

/**
 * @typedef Options
 * @type {object}
 * @property {Array.<string>} video
 * @property {Array.<string>} audio
*/


/**@type {Map.<string, StrimingTask>} */
const task_map = new Map();


/**
 * generate output hls-path from config-file
 * @returns {string}
 */
function getRTMPStreamUrl() {
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
function getSnapshotPath() {
    return path.join(global.__public, 'images', 'live.jpg');
}


function getSnapshotInterval() {
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


/**receive snapshot by using first frame of repeated video*/
function fetchSnapshot() {
    if (data.states.repeatToLocalNginx.type != 'connected') {
        logger.dbg?.('Disabled, because stream is not connected', 'snapshot');
        return;
    }

    let interval = getSnapshotInterval();
    if (interval == 0) {
        logger.info('Disabled', 'snapshot');
        return;
    }

    const startTime = Date.now();
    const _fetchSnapshot = function () {
        let elapsed = Date.now() - startTime;
        if (elapsed <= interval)
            interval -= elapsed;

        rsSetTimeout(RTL, 'snapshot', fetchSnapshot, interval);
    };

    const command = new Ffmpeg('/tmp/hls/live.stream.m3u8'); // FfmpegCommand(getRTMPStreamUrl());
    // command.output(getSnapshotPath());

    addStreamOptions(command, 'global', null);
    addStreamOptions(command, 'snapshot', null);
    command
        .on('start', commandLine => {
            logger.dbg?.('Spawned: ' + commandLine, 'snapshot');
        })
        .on('error', error => {
            logger.error(error.toString().trim(), 'snapshot');
            _fetchSnapshot();
        })
        .on('end', () => {
            logger.inf?.('Updated. Next scheduled update in ' + interval + ' ms.', 'snapshot');
            wsCtrl.emit('snapshot', null);
            _fetchSnapshot();
        })
        .save(getSnapshotPath());
}


/**
 * create with only the data, that is needed by the jsonDb
 * @return {Object}
 */
function dataForJsonDb() {
    return {
        'addresses': data.addresses,
        'options': data.options,
        'userActions': data.userActions,
        'states': data.states
    };
}


/**write JSON file for persistence*/
function writeToDB() {
    db.push('/', dataForJsonDb());
}


/**
 * get the state of the stream
 * @param {string} streamType
 * @return {string} name of the new state
 */
function getState(streamType) {
    return data.states[streamType].type;
}


/**
 * @param {string} streamType
 * @param {string} state
 * @param {string | undefined} message
 */
function setState(streamType, state, message) {
    const previousState = data.states[streamType].type;

    if (typeof message != 'string')
        message = '';

    data.states[streamType] = {
        'type': state,
        'message': message
    };

    return previousState;
}


/**
 * update the state of the stream
 * @param {string} streamType
 * @param {string} state
 * @param {?string} message
 * @return {string} name of the new state
 */
function updateState(streamType, state, message) {
    // logger.dbg?.('Update state from "' + previousState + '" to "' + state + '"', streamType);
    const previousState = setState(streamType, state, message ?? '');

    if (previousState === state)
        return state;

    if (streamType === RTL && state === 'connected')
        fetchSnapshot();

    // writeToDB()
    updateStreamDataOnGui();
    return state;
}


/**
 * get the current user action
 * @param {string} streamType
 * @return {string} name of the user action
 */
function getUserAction(streamType) {
    return data.userActions[streamType];
}


/**
 * set the current user action
 * @param {string} streamType
 * @param {string} action
 * @return {string} name of the previous user action
 */
function setUserAction(streamType, action) {
    let previousAction = data.userActions[streamType];
    logger.dbg?.('Set user action from "' + previousAction + '" to "' + action + '"', streamType);
    data.userActions[streamType] = action;
    return previousAction;
}


/**
 * update the last submitted user action (like click on stop stream, click on start stream)
 * @param {string} streamType
 * @param {string} action user action
 * @return {string} name of the new user action
 */
function updateUserAction(streamType, action) {
    let previousAction = setUserAction(streamType, action);
    if (previousAction === action) return action;

    writeToDB();
    updateStreamDataOnGui();
    return action;
}


/**
 * update options
 * @param {Object} options
 */
function updateOptions(options) {
    data.options = options;
    updateStreamDataOnGui();
    writeToDB();
}


/**send websocket event to GUI to update the state of the streams*/
function updateStreamDataOnGui() {
    wsCtrl.emit('updateStreamData', extractDataOfStreams());
}


/**send websocket event to GUI to update the state of the streams*/
function updateProgressOnGui() {
    wsCtrl.emitOnConnections()?.('updateProgress', data.progresses);
}


/**
 * creates an object of available streaming data like states and addresses to be able
 * to write it to filesystem
 * @returns {object}
 */
function extractDataOfStreams() {
    return {
        'addresses': data.addresses,
        'options': data.options,
        'userActions': data.userActions,
        'states': data.states
    };
}


function updatePlayerOptions(player) {
    data.options.player = player;
    logger.dbg?.('Storing player options', 'Restreamer');
    writeToPlayerConfig();
    writeToDB();
}


/**write player config to public directory*/
function writeToPlayerConfig() {
    const d = 'var playerConfig = ' + JSON.stringify(data.options.player);
    fs.writeFileSync('./src/webserver/public/config.js', d, 'utf8');
}


/**
 * stop stream
 * @param {string} streamType
 */
function stopStream(streamType) {
    updateState(streamType, 'stopped');
    logger.info('Stop streaming', streamType);

    /** @type {FF} */
    let ffcommand = data.processes[streamType];
    if (ffcommand !== null) {
        data.processes[streamType] = null;
        ffcommand.kill('SIGKILL');
    }

    let task = task_map.get(streamType);
    if (task) {
        task.cancellProbeRetry();
        // rtl_task.command.removeAllListeners();
        // rtl_task.command = null;
        // rtl_task = null;
    }
}


/**
 * перезапуск потока
 * @param {StrimingTask} task 
 */
function retry(task) {
    logger.inf?.('Schedule connect to "' + task.streamUrl + '" in ' + restartTimespan + ' ms', task.streamType);

    setTimeoutUnsafe(task, 'retry', (t) => {
        // this.data.timeouts.retry[t.streamType] = null;

        if (data.userActions[t.streamType] === 'stop') {
            logger.dbg?.('Skipping retry because "stop" has been clicked', task.streamType);
            updateState(task.streamType, 'disconnected');
            return;
        }

        logger.inf?.(`Retry connect to "${t.streamUrl}"`, t.streamType);
        startStreamAsync(t);
    }, restartTimespan);
}


/**
 * @param {StrimingTask} task
 * @returns {FF}
*/
function buildCommand(task) {
    const rtmpUrl = getRTMPStreamUrl();
    const command = new Ffmpeg(task.streamType == RTL ? task.streamUrl : rtmpUrl, {
        stdoutLines: 1
    });

    if (task.streamType === RTL) {
        // repeat to local nginx server
        addStreamOptions(command, 'global', null);
        addStreamOptions(command, 'video', null);
        addStreamOptions(command, 'local_mpegts', null); //rtmp

        // RTSP options
        if (task.streamUrl.startsWith('rtsp')) {
            addStreamOptions(command, 'rtsp', null);

            if (data.options.rtspTcp)
                addStreamOptions(command, 'rtsp-tcp', null);
        }

        // add outputs to the ffmpeg stream
        command.output("/tmp/hls/live.stream.m3u8"); //command.output(rtmpUrl)
    }
    else {
        // repeat to optional output - not used cuurently
        addStreamOptions(command, 'global', null);
        addStreamOptions(command, 'video', null);

        if (data.options.output.type == 'hls') {
            addStreamOptions(command, 'hls', data.options.output.hls);
        }
        else {
            addStreamOptions(command, 'rtmp', null);
        }

        // add outputs to the ffmpeg stream
        command.output(task.streamUrl);
    }

    return command;
}


/**
 * перезапуск стрима
 * @param {StrimingTask} task 
 */
async function retryAsync(task) {
    logger.inf?.('Schedule connect to "' + task.streamUrl + '" in ' + restartTimespan + ' ms', task.streamType);
    if (await (task.retryTimer ??= new Timer()).wait(restartTimespan)) {
        logger.inf?.(`Retry connect to "${task.streamUrl}"`, task.streamType);
        startStreamAsync(task);
    }
}


/**
 * set a timeout
 * @param {string} streamType Either ${RTL} or 'repeatToOptionalOutput'
 * @param {string} target Kind of timeout, either 'retry' or 'stale'
 * @param {function | null} func Callback function
 * @param {number | undefined} [delay] Delay for the timeout
 * @return {void}
 */
function rsSetTimeout(streamType, target, func, delay) {
    const tots = data.timeouts;

    if (!Object.prototype.hasOwnProperty.call(tots, target)) {
        logger.error('Unknown target for timeout', streamType);
        return;
    }

    if (!(streamType in tots[target])) {
        logger.error('Unknown stream type for timeout target "' + target + '"', streamType);
        return;
    }

    clearTimeout(tots[target][streamType]);

    if (typeof func == 'function')
        tots[target][streamType] = setTimeout(func, delay);
}


/**
 * set a timeout
 * @param {StrimingTask} task 
 * @param {string} target Kind of timeout, either 'retry', 'stale' or 'snapshot'
 * @param {(arg: StrimingTask) => void} [func] Callback function
 * @param {number | undefined} delay Delay for the timeout
 * @return {void}
 */
function setTimeoutUnsafe(task, target, func, delay) {
    let tos = data.timeouts[target];
    /**@type {NodeJS.Timeout} */
    let to = tos[task.streamType];
    tos[task.streamType] = to?.refresh() ?? setTimeout(func, delay, task);

    // (to ?? false) && clearTimeout(to);
    // tos[task.streamType] = (func ?? false) === false ? null : setTimeout(func, delay, task);
}


/**
 * 
 * @param {FfmpegCommand.FfmpegCommand} command 
 * @param {string} name 
 * @param {*} replace 
 * @returns 
 */
function addStreamOptions(command, name, replace) {
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

    if ('input' in options)
        command.input(replacer(options.input, replace));

    if ('inputOptions' in options)
        command.inputOptions(replacer(options.inputOptions, replace));

    if ('outputOptions' in options)
        command.outputOptions(replacer(options.outputOptions, replace));
}


function checkForUpdates() {
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


function getPublicIp() {
    logger.info('Retrieving public IP ...', 'publicIP');
    data.publicIp = '127.0.0.1';
}


/**
 * restore the ffmpeg processes from jsondb (called on app start to restore ffmpeg processes
 * after the application has been killed or stuff
 */
async function restoreProcesses() {
    // let db = new JsonDB(new Config(config.jsondb, true, false))
    const adr = data.addresses = await db.getData('/addresses');
    data.states = await db.getData('/states');
    data.options = await db.getData('/options');
    data.userActions = await db.getData('/userActions');
    // writeToPlayerConfig();

    // check if a stream was repeated locally
    if (adr.srcAddress && ['connected', 'connecting', 'error'].includes(getState(RTL))) {
        startStreamAsync(new StrimingTask(adr.srcAddress, RTL), true);
    }
    else {
        updateState(RTL, 'disconnected');
    }


    // check if the stream was repeated to an output address
    if (adr.optionalOutputAddress && ['connected', 'connecting'].includes(getState(RTO))) {
        startStream(new StrimingTask(adr.optionalOutputAddress, RTO), true);
    }
    else {
        updateState(RTO, 'disconnected');
    }
}


/**
 * append the ffmpeg options of the config file to an output
 * @param {string[]} probeArgs
 * @param {string} streamType
 * @returns {Promise.<Options, string>} return options on resolve and string on reject
 */
function probeStream(probeArgs, streamType) {
    return new Promise((resolve, reject) => {
        execFile('ffprobe', probeArgs, { timeout: config.ffmpeg.probe.timeout, killSignal: 'SIGTERM' }, (err, stdout, stderr) => {
            if (err) {
                if (!err.code && err.killed) {
                    reject("timeout");
                    return;
                }

                let line = '';
                for (let l of stderr.split('\n')) line = l || line;
                reject(line || err.message);
                return;
            }

            let video = null;
            let audio = { channels: 0 };
            const json = JSON.parse(stdout);

            if ('streams' in json) {
                for (let s of json.streams) {
                    switch (s.codec_type) {
                        case 'video':
                            // Select the video stream with the highest number of pixels
                            if (!video || (s.width * s.height) > (video.width * video.height))
                                video = s;
                            break;

                        case 'audio':
                            if (s.channels > audio.channels) audio = s;
                            break;
                    }
                }
            }

            if (video === null) {
                reject("no video stream detected");
                return;
            }

            data.options.video.id = video.index;
            data.options.audio.id = 'a';
            if (audio.channels) data.options.audio.id = audio.index;

            const options = {
                audio: [],
                video: []
            };

            if (streamType === RTL) {
                if (data.options.video.codec == 'h264') {
                    options.video.push('video_codec_h264');

                    if (data.options.video.profile != 'auto')
                        options.video.push('video_codec_h264_profile');

                    if (data.options.video.tune != 'none')
                        options.video.push('video_codec_h264_tune');
                }
                else {
                    if (video.codec_name != 'h264') {
                        reject("video stream must be h264, found " + video.codec_name);
                        return;
                    }

                    options.video.push('video_codec_copy');
                }

                if (audio.channels) {
                    if (data.options.audio.codec === 'none') {
                        options.audio.push('audio_codec_none');
                    }
                    else if (data.options.audio.codec === 'aac' || data.options.audio.codec === 'mp3') {
                        if (data.options.audio.preset === 'encode')
                            options.audio.push('audio_preset_copy');

                        if (data.options.audio.codec === 'aac') {
                            options.audio.push('audio_codec_aac');
                        }
                        else {
                            options.audio.push('audio_codec_mp3');
                        }

                        options.audio.push('audio_preset_' + data.options.audio.preset);

                        if (data.options.audio.channels !== 'inherit' && data.options.audio.sampling !== 'inherit') {
                            options.audio.push('audio_filter_all');
                        }
                        else if (data.options.audio.channels != 'inherit') {
                            options.audio.push('audio_filter_channels');
                        }
                        else if (data.options.audio.sampling != 'inherit') {
                            options.audio.push('audio_filter_sampling');
                        }
                    }
                    else if (data.options.audio.codec === 'auto') {
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
                                if (data.options.audio.codec === 'copy') {
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
                    if (data.options.audio.codec === 'aac' || data.options.audio.codec === 'auto') {
                        options.audio.push('audio_codec_aac');
                        options.audio.push('audio_preset_silence');
                        options.audio.push('audio_filter_all');
                    }
                    else if (data.options.audio.codec === 'mp3') {
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

                if (audio.channels) {
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
                data.addresses.srcStreams.video = {
                    index: video.index,
                    type: "video",
                    codec: video.codec_name,
                    width: video.width,
                    height: video.height,
                    format: video.pix_fmt
                };

                if (audio.channels) {
                    data.addresses.srcStreams.audio = {
                        index: audio.index,
                        type: "audio",
                        codec: audio.codec_name,
                        layout: audio.channel_layout,
                        channels: audio.channels,
                        sampling: audio.sample_rate
                    };
                }

                writeToDB();
            }

            resolve(options);
        });
    });
}


function stopClicked(streamType) {
    if (data.userActions[streamType] === 'stop') {
        updateState(streamType, 'disconnected');
        // logger.dbg?.('Skipping retry since "stop" has been clicked', task.streamType);
        return true;
    }
    return false;
}


/**
 * @param {StrimingTask} task
*/
async function getOptions(task) {
    let options = null;
    let streamType = task.streamType;
    const url = streamType === RTL ? task.streamUrl : getRTMPStreamUrl();
    const probeArgs = [
        '-of', 'json',
        '-v', 'error',
        '-show_streams',
        '-show_format'
    ];

    if (url.startsWith('rtsp') && data.options.rtspTcp === true) {
        probeArgs.push('-rtsp_transport', 'tcp');
        probeArgs.push(probe_tot_key, socket_timeout);
    }

    probeArgs.push(url);

    while (!options && !stopClicked(streamType)) {
        options = await probeStream(probeArgs, streamType)
            .catch(
                /**@param {string} error reject reason*/
                error => {
                    logger.err?.('probeStream: ' + error, streamType);
                    updateState(streamType, 'error', error);
                    return null;
                });

        if (stopClicked(streamType)) {
            options = null;
            break;
        }

        if (!options) {
            logger.dbg?.(`Try spawn ffprobe in ${task.probeRetryTime()} ms`, streamType);
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
async function startStreamAsync(task, force) {
    logger.inf?.('Start streaming', task.streamType);
    task_map.set(task.streamType, task);

    if (!force) {
        const state = getState(task.streamType);
        if (state == 'connected' || state == 'connecting') {
            logger.dbg?.(`Skipping "startStream" because state is "${state}".`, task.streamType);
            return;
        }
    }

    // update the state on the frontend
    updateState(task.streamType, 'connecting');

    task.connected = false;

    let command = task.command ?? buildCommand(task);

    if (!task.command) {
        command.task = task;
        // options: { audio: [ 'audio_codec_none' ], video: [ 'video_codec_copy' ] }
        let options = await getOptions(task);
        if (null === options) return;

        const replace_video = {
            videoid: data.options.video.id,
            preset: data.options.video.preset,
            bitrate: data.options.video.bitrate,
            fps: data.options.video.fps,
            gop: parseInt(data.options.video.fps) * 2,
            profile: data.options.video.profile,
            tune: data.options.video.tune
        };

        for (let vo of options.video)
            addStreamOptions(command, vo, replace_video);

        const replace_audio = {
            audioid: data.options.audio.id,
            bitrate: data.options.audio.bitrate,
            channels: data.options.audio.channels,
            sampling: data.options.audio.sampling
        };

        for (let ao of options.audio)
            addStreamOptions(command, ao, replace_audio);

        task.command = command;
        command
            .on('start', function (commandLine) {
                let streamType = this.task.streamType;
                data.processes[streamType] ??= this;
                logger.dbg?.('Spawned: ' + commandLine, streamType);

                if (data.userActions[streamType] === 'stop') {
                    logger.dbg?.('Skipping on "start" event of FFmpeg command because "stop" has been clicked', streamType);
                    stopStream(streamType);
                }
            })
            .on('end', function () {
                let t = this.task.reset();
                let streamType = t.streamType;
                data.processes[streamType] = null;
                logger.inf?.(streamType + ': ended normally');

                if (data.userActions[streamType] === 'stop') {
                    logger.dbg?.('Skipping retry because "stop" has been clicked', streamType);
                    updateState(streamType, 'disconnected');
                    return;
                }

                updateState(streamType, 'stopped');
                retryAsync(t);
            })
            .on('error', function (error) {
                let t = this.task.reset();
                data.processes[t.streamType] = null;

                if (data.userActions[t.streamType] === 'stop') {
                    logger.dbg?.('Skipping retry since "stop" has been clicked', t.streamType);
                    updateState(t.streamType, 'disconnected');
                    return;
                }

                logger.error(error.message, t.streamType);
                updateState(t.streamType, 'error', error.message);
                retryAsync(t);
            })
            .on('stderr', /** @this {FF} */ function (str) {
                if (!str.startsWith('frame=')) {
                    logger.wrn?.(`msg: '${str}'`, 'stderr');
                    return;
                }

                /**@type {StrimingTask} */
                let t = this.task;
                let p = t.progress; // data.progresses[t.streamType];
                let n = parseInt(str.slice(6), 10);
                p.currentFps = (n - p.frames) / 2;
                p.frames = t.nFrames = n;
                updateProgressOnGui();
            });
    }

    task.progress.frames = 0;
    task.progress.currentFps = 0;
    task.progress.currentKbps = 0;

    (command.listenerCount('stderr') === 1) && command.once('stderr', /**@this {FF} */ function () {
        /**@type {StrimingTask} */
        let task = this.task;
        logger.inf?.('connected', task.streamType);
        updateState(task.streamType, 'connected');
        task.beginStaleDetection();
        task.connected = true;
    });

    command.run();
}


/**
 * 
 * @param {StrimingTask} task 
 * @param {boolean} [force]
 * @returns 
 */
function startStream(task, force) {
    // remove any running timeouts
    rsSetTimeout(task.streamType, 'retry', null);
    rsSetTimeout(task.streamType, 'stale', null);

    if (!force) {
        // check if there's currently no other stream connected or connecting
        let state = getState(task.streamType);
        if (state == 'connected' || state == 'connecting') {
            logger.dbg?.(`Skipping "startStream" because state is "${state}".`, task.streamType);
            return;
        }
    }

    // check if the user has clicked 'stop' meanwhile, so the startStream process has to be skipped
    if (getUserAction(task.streamType) == 'stop') {
        stopStream(task.streamType);
        logger.dbg?.('Skipping "startStream" because "stop" has been clicked', task.streamType);
        return;
    }

    logger.inf?.('Start streaming', task.streamType);
    updateState(task.streamType, 'connecting');

    const retry = () => {
        logger.inf?.('Schedule connect to "' + task.streamUrl + '" in ' + task.restart_wait + ' ms', task.streamType);
        rsSetTimeout(task.streamType, 'retry', () => {
            if (data.userActions[task.streamType] == 'stop') {
                logger.dbg?.('Skipping retry because "stop" has been clicked', task.streamType);
                updateState(task.streamType, 'disconnected');
                return;
            }

            logger.inf?.('Retry to connect to "' + task.streamUrl + '"', task.streamType);
            startStream(task);
        }, task.restart_wait);
        task.restart_wait += 100;
    };

    getOptions(task).then((options) => {
        if (options === null) return;

        task.connected = false;
        const command = buildCommand(task);

        const replace_video = {
            videoid: data.options.video.id,
            preset: data.options.video.preset,
            bitrate: data.options.video.bitrate,
            fps: data.options.video.fps,
            gop: (parseInt(data.options.video.fps) * 2) + '',
            profile: data.options.video.profile,
            tune: data.options.video.tune
        }

        for (let o in options.video)
            if (o.length) addStreamOptions(command, options.video[o], replace_video);

        const replace_audio = {
            audioid: data.options.audio.id,
            bitrate: data.options.audio.bitrate,
            channels: data.options.audio.channels,
            sampling: data.options.audio.sampling
        }

        for (let o in options.audio)
            if (o.length) addStreamOptions(command, options.audio[o], replace_audio);

        command
            .on('start', (commandLine) => {
                task.reset();
                data.processes[task.streamType] = command;

                if (data.userActions[task.streamType] == 'stop') {
                    stopStream(task.streamType);
                    logger.dbg?.('Skipping on "start" event of FFmpeg command because "stop" has been clicked', task.streamType);
                    return;
                }

                logger.dbg?.('Spawned: ' + commandLine, task.streamType);
            })
            .on('end', () => {
                data.processes[task.streamType] = null;
                rsSetTimeout(task.streamType, 'retry', null);
                rsSetTimeout(task.streamType, 'stale', null);
                data.progresses[task.streamType].currentFps = 0;
                data.progresses[task.streamType].currentKbps = 0;

                updateState(task.streamType, 'stopped');

                if (data.userActions[task.streamType] == 'stop') {
                    updateState(task.streamType, 'disconnected');
                    logger.dbg?.('Skipping retry because "stop" has been clicked', task.streamType);
                    return;
                }

                logger.inf?.(task.streamType + ': ended normally');
                retry();
            })
            .on('error', error => {
                data.processes[task.streamType] = null;
                rsSetTimeout(task.streamType, 'retry', null);
                rsSetTimeout(task.streamType, 'stale', null);
                data.progresses[task.streamType].currentFps = 0;
                data.progresses[task.streamType].currentKbps = 0;

                if (data.userActions[task.streamType] == 'stop') {
                    updateState(task.streamType, 'disconnected');
                    logger.dbg?.('Skipping retry since "stop" has been clicked', task.streamType);
                    return;
                }

                // logger.error(error.message, task.streamType);
                logger.error(error.toString(), task.streamType);
                updateState(task.streamType, 'error', error.toString());
                retry();
            })
            .on('progress', (progress) => {
                if (!task.connected && data.states[task.streamType].type == 'connecting') {
                    updateState(task.streamType, 'connected');
                    task.connected = true;
                }

                // compare the current number of frames
                if (task.nFrames != progress.frames) {
                    task.nFrames = progress.frames;
                    // add/reset a stale timeout if the number of frames changed
                    rsSetTimeout(task.streamType, 'stale', () => {
                        logger.warn('Stale connection', task.streamType);
                        stopStream(task.streamType);
                    }, config.ffmpeg.monitor.stale_wait);
                }

                data.progresses[task.streamType] = progress;
                updateProgressOnGui();
            });

        command.run();
    });
}


/**bind websocket events on application start*/
function bindWebsocketEvents() {
    wsCtrl.setConnectCallback(socket => {
        // logger.dbg?.('ConnectionCallback');
        socket.emit('publicIp', data.publicIp);

        socket.on('startStream', options => {
            // logger.dbg?.('Got "startStream" event', options.streamType)
            updateUserAction(options.streamType, 'start');
            updateOptions(options.options);

            let task = null;
            let streamUrl = null;
            switch (options.streamType) {
                case RTL:
                    streamUrl = options.src;
                    task = task_map.get(RTL);
                    if (streamUrl !== data.addresses.srcAddress) {
                        data.addresses.srcAddress = streamUrl;
                        if (task) {
                            task.command?.removeAllListeners();
                            task.command?.task = undefined;
                            task.command = undefined;
                            task_map.delete(RTL);
                        }
                        task = new StrimingTask(streamUrl, RTL);
                    }
                    break;

                case RTO:
                    streamUrl = data.addresses.optionalOutputAddress = options.optionalOutput;
                    break;

                default:
                    logger.wrn?.(`Uncknown stream type: ${options.streamType}`);
                    break;
            }

            streamUrl && startStreamAsync(task || new StrimingTask(streamUrl, options.streamType));
        });

        socket.on('stopStream', streamType => {
            // logger.dbg?.('Got "stopStream" event', streamType)
            updateUserAction(streamType, 'stop');
            stopStream(streamType);
        });

        socket.on('checkStates', () => {
            // logger.dbg?.('Got "checkStates" event')
            updateStreamDataOnGui();
        });

        socket.on('playerOptions', player => {
            // logger.dbg?.('Got "playerOptions" event')
            updatePlayerOptions(player);
        });

        // socket.on('disconnect', (reason) => logger.inf?.('disconnect: ' + reason))
    });
}


function close() {
    /**@type {FF}*/
    let cmd = data.processes.repeatToLocalNginx;

    setUserAction(RTL, 'stop');
    if (cmd?.ffmpegProc) {
        task_map.get(RTL)?.reset();
        cmd.removeAllListeners('error');
        cmd.on('error', () => { }).kill();
    }
}



/**
 * Information to start stream
 * @param {string} streamUrl 
 * @param {string} streamType 
 */
function StrimingTask(streamUrl, streamType) {
    this.streamUrl = streamUrl;
    this.streamType = streamType;
    /**@type {Progress} */
    this.progress = data.progresses[streamType];

    /** @type {FF} */
    this.command;


    /**@type {boolean} */
    this.connected;
    this.once = false;

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

    this.reset();
}

StrimingTask.prototype.cancellProbeRetry = function () {
    if (this.probeRetryTimer) {
        logger.inf?.('Try cancell probe retry timer', this.streamType);
        this.probeRetryTimer.cancell();
        this.probeRetryTimer = null;
    }
};

StrimingTask.prototype.waitProbeRetry = function () {
    return (this.probeRetryTimer ??= new rtimer(this.restart_wait, 88)).wait();
};

StrimingTask.prototype.beginStaleDetection = function () {
    this.intervalId ??= setInterval(() => {
        logger.dbg?.(`check stale: ${this.prevnFrame} => ${this.nFrames}`, this.streamType);
        if (!this.connected) return;
        if (this.nFrames === this.prevnFrame) {
            stopStream(this.streamType);
            return;
        }
        this.prevnFrame = this.nFrames;
    }, config.ffmpeg.monitor.stale_wait).unref();
};

StrimingTask.prototype.reset = function () {
    this.connected = false;
    this.nFrames = 0;
    this.prevnFrame = 0;
    this.restart_wait = defaultWait;

    if (this.intervalId) {
        logger.dbg?.(`Clear stale interval`, this.streamType);
        clearInterval(this.intervalId);
        this.intervalId = undefined;
    }

    if (this.probeRetryTimer)
        this.probeRetryTimer = null;

    return this;
};

StrimingTask.prototype.probeRetryTime = function () {
    return this.probeRetryTimer?.current ?? this.restart_wait;
};


module.exports = {
    data,
    bindWebsocketEvents,
    restoreProcesses,
    close
};
