/**
 * @file holds the code for the class Restreamer
 * @link https://github.com/datarhei/restreamer
 * @copyright 2015 datarhei.org
 * @license Apache-2.0
 */
'use strict';

const logger = require('./Logger')('Restreamer');
// logger.debug(`Load ${__filename}`);

const fs = require('fs');
const path = require('path');
const FfmpegCommand = require('fluent-ffmpeg');
const { JsonDB, Config } = require('node-json-db');
const execFile = require('child_process').execFile;
//const https = require('https');

const Q = require('./MyQ.js');
const WebsocketsController = require('./WebsocketsController');
const config = require('../../conf/live.json'); //const {config} = require.main.exports;
/**config.ffmpeg.probe.timeout_key */
const probe_tot_key = config.ffmpeg.probe.timeout_key;
const socket_timeout = config.ffmpeg.probe.socket_timeout;
const db = new JsonDB(new Config(config.jsondb, true, false));


/**
 * Information to start stream
 * @param {string} streamUrl 
 * @param {string} streamType 
 */
function StrimingTask(streamUrl, streamType) {
    const defaultWait = config.ffmpeg.monitor.restart_wait;
    this.streamUrl = streamUrl;
    this.streamType = streamType;
    /**Reconnect period (ms) @type {number}*/
    this.restart_wait = defaultWait;
    this.reset = () => {
        this.restart_wait = defaultWait;
    }
}

/**
 * class Restreamer (fully static) creates and manages streams through ffmpeg
 */
class Restreamer {

    /**
     * generate output hls-path from config-file
     * @returns {string}
     */
    static getRTMPStreamUrl() {
        const nginx = config.nginx.streaming;
        const token = process.env.RS_TOKEN || config.auth.token;
        let path = 'rtmp://' + nginx.ip + ':' + nginx.rtmp_port + nginx.rtmp_hls_path + 'live.stream';

        if (token != '') {
            path += '?token=' + token;
        }

        return path;
    }

    /**
     * generate output snapshot-path from config-file
     * @returns {string}
     */
    static getSnapshotPath() {
        return path.join(global.__public, 'images', 'live.jpg');
    }

    /**
     * receive snapshot by using first frame of repeated video
     */
    static fetchSnapshot() {
        if (Restreamer.data.states.repeatToLocalNginx.type != 'connected') {
            logger.debug('Disabled, because stream is not connected', 'snapshot');
            return;
        }

        let interval = Restreamer.getSnapshotInterval();
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

            Restreamer.setTimeout('repeatToLocalNginx', 'snapshot', Restreamer.fetchSnapshot, interval);
        }

        const command = Ffmpeg('/tmp/hls/live.stream.m3u8'); // FfmpegCommand(Restreamer.getRTMPStreamUrl());
        // command.output(Restreamer.getSnapshotPath());

        Restreamer.addStreamOptions(command, 'global', null);
        Restreamer.addStreamOptions(command, 'snapshot', null);

        command.on('start', (commandLine) => {
            logger.debug('Spawned: ' + commandLine, 'snapshot');
        });

        command.on('error', (error) => {
            logger.error(error.toString().trim(), 'snapshot');
            fetchSnapshot();
        });

        command.on('end', () => {
            logger.info('Updated. Next scheduled update in ' + interval + ' ms.', 'snapshot');
            WebsocketsController.emit('snapshot', null);
            fetchSnapshot();
        });

        command.save(Restreamer.getSnapshotPath());
    }

    /**
     * 
     * @param {FfmpegCommand.FfmpegCommand} command 
     * @param {string} name 
     * @param {*} replace 
     * @returns 
     */
    static addStreamOptions(command, name, replace) {
        if (!(name in config.ffmpeg.options)) {
            logger.debug('Unknown option: ' + name);
            return;
        }

        logger.debug('Adding option: ' + name);

        let options = config.ffmpeg.options[name];

        let replacer = function (options, replace) {
            if (replace == null) {
                return options;
            }

            let replaced_options = [];

            if (typeof options != 'string') {
                for (let i = 0; i < options.length; i++) {
                    let option = options[i];
                    for (let r in replace) {
                        if (option.indexOf('{' + r + '}') != -1) {
                            logger.debug('Replacing {' + r + '} with "' + replace[r] + '" in: ' + option);
                            option = option.replace('{' + r + '}', replace[r]);
                        }
                    }
                    replaced_options.push(option);
                }
            }
            else {
                let option = options;
                for (let r in replace) {
                    if (options.indexOf('{' + r + '}') != -1) {
                        logger.debug('Replacing {' + r + '} with "' + replace[r] + '" in: ' + option);
                        option = option.replace('{' + r + '}', replace[r]);
                    }
                }
                replaced_options = option;
            }

            return replaced_options;
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
        let parsedInterval = process.env.RS_SNAPSHOT_INTERVAL?.match(/^([0-9]+)(m|s|ms)?$/) ?? null;

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

        if (interval == 0) {
            return 0;   // disable snapshots
        }
        else if (interval < minimalInterval) {
            interval = minimalInterval;
        }

        return interval;
    }

    /**
     * stop stream
     * @param {string} streamType
     */
    static stopStream(streamType) {
        Restreamer.updateState(streamType, 'stopped');
        logger.info('Stop streaming', streamType);

        if (Restreamer.data.processes[streamType] !== null) {
            Restreamer.data.processes[streamType].kill('SIGKILL');
            Restreamer.data.processes[streamType] = null;
        }
    }

    /**
     * restore the ffmpeg processes from jsondb (called on app start to restore ffmpeg processes
     * after the application has been killed or stuff
     */
    static async restoreProcesses() {
        // let db = new JsonDB(new Config(config.jsondb, true, false));
        Restreamer.data.addresses = await db.getData('/addresses');
        Restreamer.data.states = await db.getData('/states');
        Restreamer.data.options = await db.getData('/options');
        Restreamer.data.userActions = await db.getData('/userActions');

        Restreamer.writeToPlayerConfig();

        let state = Restreamer.getState('repeatToLocalNginx');
        let repeatToLocalNginxReconnecting = (state == 'connected' || state == 'connecting');

        state = Restreamer.getState('repeatToOptionalOutput');
        let repeatToOptionalOutputReconnecting = (state == 'connected' || state == 'connecting');

        // check if a stream was repeated locally
        if (Restreamer.data.addresses.srcAddress && repeatToLocalNginxReconnecting) {
            Restreamer.startStream(
                new StrimingTask(Restreamer.data.addresses.srcAddress, 'repeatToLocalNginx'),
                true
            );
        }
        else {
            Restreamer.updateState('repeatToLocalNginx', 'disconnected')
        }

        // check if the stream was repeated to an output address
        if (Restreamer.data.addresses.optionalOutputAddress && repeatToOptionalOutputReconnecting) {
            Restreamer.startStream(
                new StrimingTask(Restreamer.data.addresses.optionalOutputAddress, 'repeatToOptionalOutput'),
                true
            );
        }
        else {
            Restreamer.updateState('repeatToOptionalOutput', 'disconnected')
        }
    }

    /**
     * write JSON file for persistence
     */
    static writeToDB() {
        // let db = new JsonDB(new Config(config.jsondb, true, false));
        db.push('/', Restreamer.dataForJsonDb());
    }

    /**
     * write player config to public directory
     */
    static writeToPlayerConfig() {
        let data = 'var playerConfig = ' + JSON.stringify(Restreamer.data.options.player);
        fs.writeFileSync('src/webserver/public/config.js', data, 'utf8');
    }

    /**
     * send websocket event to GUI to update the state of the streams
     */
    static updateStreamDataOnGui() {
        WebsocketsController.emit('updateStreamData', Restreamer.extractDataOfStreams());
    }

    /**
     * send websocket event to GUI to update the state of the streams
     */
    static updateProgressOnGui() {
        WebsocketsController.emit('updateProgress', Restreamer.data.progresses);
    }

    /**
     * append the ffmpeg options of the config file to an output
     * @param {string} streamUrl
     * @param {string} streamType
     * @return {Promise | null}
     */
    static probeStream(streamUrl, streamType) {
        let deferred = Q.defer();

        let state = Restreamer.getState(streamType);
        if (state != 'connecting') {
            logger.debug('Skipping "startStream" because state is not "connecting". Current state is "' + state + '".', streamType);
            return null;
        }

        if (streamType == 'repeatToLocalNginx') {
            Restreamer.data.addresses.srcStreams = {
                audio: {},
                video: {}
            };

            Restreamer.writeToDB();
        }

        (function doProbe(streamUrl) {
            const probeArgs = [
                '-of',
                'json',
                '-v',
                'error',
                '-show_streams',
                '-show_format'
            ];

            if (streamUrl.indexOf('rtsp') === 0 && Restreamer.data.options.rtspTcp === true) {
                probeArgs.push('-rtsp_transport', 'tcp');
                probeArgs.push(probe_tot_key, socket_timeout);
            }

            probeArgs.push(streamUrl);

            execFile('ffprobe', probeArgs, { timeout: parseInt(config.ffmpeg.probe.timeout), killSignal: 'SIGTERM' }, (err, stdout, stderr) => {
                if (err) {
                    if (!err.code && err.killed) {
                        return deferred.reject("ffprobe timeout");
                    }

                    let lines = stderr.toString().split(/\r\n|\r|\n/);
                    lines = lines.filter(function (line) {
                        return line.length > 0;
                    });

                    if (lines.length == 0) {
                        return deferred.reject("failed to execute ffprobe: " + err.message);
                    }

                    return deferred.reject(lines[lines.length - 1]);
                }

                // console.log(ffprobe);
                let video = null;
                let audio = null;
                let data;

                try {
                    data = JSON.parse(stdout);
                }
                catch (e) {
                    return deferred.reject("failed to parse probe result: " + e.message);
                }

                if (!('streams' in data)) {
                    data.streams = [];
                }

                for (let s of data.streams) {
                    if (s.codec_type == 'video') {
                        if (video === null) {
                            video = s;
                            continue;
                        }

                        // Select the video stream with the highest number of pixels
                        if ((s.width * s.height) > (video.width * video.height)) {
                            video = s;
                        }
                    }
                    else if (s.codec_type == 'audio') {
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

                if (video === null) {
                    return deferred.reject("no video stream detected");
                }

                Restreamer.data.options.video.id = video.index;
                Restreamer.data.options.audio.id = 'a';
                if (audio !== null) {
                    Restreamer.data.options.audio.id = audio.index;
                }

                let options = {
                    audio: [],
                    video: []
                };

                if (streamType == 'repeatToLocalNginx') {
                    if (Restreamer.data.options.video.codec == 'h264') {
                        options.video.push('video_codec_h264');

                        if (Restreamer.data.options.video.profile != 'auto') {
                            options.video.push('video_codec_h264_profile');
                        }

                        if (Restreamer.data.options.video.tune != 'none') {
                            options.video.push('video_codec_h264_tune');
                        }
                    }
                    else {
                        if (video.codec_name != 'h264') {
                            return deferred.reject("video stream must be h264, found " + video.codec_name);
                        }

                        options.video.push('video_codec_copy');
                    }

                    if (audio !== null) {
                        if (Restreamer.data.options.audio.codec == 'none') {
                            options.audio.push('audio_codec_none');
                        }
                        else if (Restreamer.data.options.audio.codec == 'aac' || Restreamer.data.options.audio.codec == 'mp3') {
                            if (Restreamer.data.options.audio.preset == 'encode') {
                                options.audio.push('audio_preset_copy');
                            }

                            if (Restreamer.data.options.audio.codec == 'aac') {
                                options.audio.push('audio_codec_aac');
                            }
                            else {
                                options.audio.push('audio_codec_mp3');
                            }

                            options.audio.push('audio_preset_' + Restreamer.data.options.audio.preset);

                            if (Restreamer.data.options.audio.channels != 'inherit' && Restreamer.data.options.audio.sampling != 'inherit') {
                                options.audio.push('audio_filter_all');
                            }
                            else if (Restreamer.data.options.audio.channels != 'inherit') {
                                options.audio.push('audio_filter_channels');
                            }
                            else if (Restreamer.data.options.audio.sampling != 'inherit') {
                                options.audio.push('audio_filter_sampling');
                            }
                        }
                        else if (Restreamer.data.options.audio.codec == 'auto') {
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
                                    if (Restreamer.data.options.audio.codec == 'copy') {
                                        return deferred.reject("can't copy audio stream, found unsupported codec " + audio.codec_name);
                                    }
                                    else {
                                        options.audio.push('audio_codec_aac');
                                        options.audio.push('audio_preset_encode');
                                    }
                            }
                        }
                    }
                    else {
                        if (Restreamer.data.options.audio.codec == 'aac' || Restreamer.data.options.audio.codec == 'auto') {
                            options.audio.push('audio_codec_aac');
                            options.audio.push('audio_preset_silence');
                            options.audio.push('audio_filter_all');
                        }
                        else if (Restreamer.data.options.audio.codec == 'mp3') {
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

                if (streamType == 'repeatToLocalNginx') {
                    Restreamer.data.addresses.srcStreams.video = {
                        index: video.index,
                        type: "video",
                        codec: video.codec_name,
                        width: video.width,
                        height: video.height,
                        format: video.pix_fmt
                    };

                    if (audio !== null) {
                        Restreamer.data.addresses.srcStreams.audio = {
                            index: audio.index,
                            type: "audio",
                            codec: audio.codec_name,
                            layout: audio.channel_layout,
                            channels: audio.channels,
                            sampling: audio.sample_rate
                        };
                    }

                    Restreamer.writeToDB();
                }

                return deferred.resolve(options);
            });
        })(streamUrl);

        return deferred.promise;
    }

    /**
     * update the state of the stream
     * @param {string} streamType
     * @param {string} state
     * @param {string | undefined} message
     * @return {string} name of the new state
     */
    static updateState(streamType, state, message = '') {
        const previousState = Restreamer.setState(streamType, state, message);

        if (previousState == state) {
            return state;
        }

        // logger.debug('Update state from "' + previousState + '" to "' + state + '"', streamType);

        if (streamType === 'repeatToLocalNginx' && state === 'connected') {
            Restreamer.fetchSnapshot();
        }

        Restreamer.writeToDB();
        Restreamer.updateStreamDataOnGui();
        return state;
    }

    /**
     * @param {string} streamType
     * @param {string} state
     * @param {string | undefined} message
     */
    static setState(streamType, state, message) {
        const previousState = Restreamer.data.states[streamType].type;

        if (typeof message != 'string') {
            message = '';
        }

        Restreamer.data.states[streamType] = {
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
        let previousAction = Restreamer.data.userActions[streamType];
        Restreamer.data.userActions[streamType] = action;
        return previousAction;
    }

    /**
     * update the last submitted user action (like click on stop stream, click on start stream)
     * @param {string} streamType
     * @param {string} action user action
     * @return {string} name of the new user action
     */
    static updateUserAction(streamType, action) {
        let previousAction = Restreamer.setUserAction(streamType, action);

        if (previousAction == action) {
            return action;
        }

        logger.debug('Set user action from "' + previousAction + '" to "' + action + '"', streamType);

        Restreamer.writeToDB();
        Restreamer.updateStreamDataOnGui();
        return action;
    }

    static updatePlayerOptions(player) {
        Restreamer.data.options.player = player;

        logger.debug('Storing player options', 'Restreamer');

        Restreamer.writeToDB();
        Restreamer.writeToPlayerConfig();
    }

    /**
     * update options
     * @param {Object} options
     */
    static updateOptions(options) {
        Restreamer.data.options = options;
        Restreamer.writeToDB();
        Restreamer.updateStreamDataOnGui();
    }

    /**
     * 
     * @param {StrimingTask} task 
     * @param {boolean} force 
     * @returns 
     */
    static startStream(task, force = false) {
        // remove any running timeouts
        Restreamer.setTimeout(task.streamType, 'retry', null);
        Restreamer.setTimeout(task.streamType, 'stale', null);

        if (!force) {
            // check if there's currently no other stream connected or connecting
            let state = Restreamer.getState(task.streamType);
            if (state == 'connected' || state == 'connecting') {
                logger.debug(`Skipping "startStream" because state is "${state}".`, task.streamType);
                return;
            }
        }

        // check if the user has clicked 'stop' meanwhile, so the startStream process has to be skipped
        if (Restreamer.getUserAction(task.streamType) == 'stop') {
            Restreamer.stopStream(task.streamType);
            logger.debug('Skipping "startStream" because "stop" has been clicked', task.streamType);
            return;
        }

        logger.info('Start streaming', task.streamType);

        // update the state on the frontend
        Restreamer.updateState(task.streamType, 'connecting');

        // var command = null;
        let probePromise = null;
        const rtmpUrl = Restreamer.getRTMPStreamUrl();
        const command = FfmpegCommand(task.streamType == 'repeatToLocalNginx' ? task.streamUrl : rtmpUrl, {
            stdoutLines: 1
        });

        if (task.streamType == 'repeatToLocalNginx') {    // repeat to local nginx server
            Restreamer.addStreamOptions(command, 'global', null);
            Restreamer.addStreamOptions(command, 'video', null);
            Restreamer.addStreamOptions(command, 'local_mpegts', null); //rtmp

            // RTSP options
            if (task.streamUrl.indexOf('rtsp') == 0) {
                Restreamer.addStreamOptions(command, 'rtsp', null);

                if (Restreamer.data.options.rtspTcp) {
                    Restreamer.addStreamOptions(command, 'rtsp-tcp', null);
                }
            }

            // add outputs to the ffmpeg stream
            command.output("/tmp/hls/live.stream.m3u8"); //command.output(rtmpUrl);
            probePromise = Restreamer.probeStream(task.streamUrl, task.streamType)
        }
        else {  // repeat to optional output
            Restreamer.addStreamOptions(command, 'global', null);
            Restreamer.addStreamOptions(command, 'video', null);

            if (Restreamer.data.options.output.type == 'hls') {
                Restreamer.addStreamOptions(command, 'hls', Restreamer.data.options.output.hls);
            }
            else {
                Restreamer.addStreamOptions(command, 'rtmp', null);
            }

            // add outputs to the ffmpeg stream
            command.output(task.streamUrl);
            probePromise = Restreamer.probeStream(rtmpUrl, task.streamType)
        }

        if (probePromise === null) {
            logger.debug('Skipping "startStream" because promise is null', task.streamType);
            return;
        }

        let retry = () => {
            logger.info('Retry to connect to "' + task.streamUrl + '" in ' + task.restart_wait + ' ms', task.streamType);
            Restreamer.setTimeout(task.streamType, 'retry', () => {
                logger.info('Retry to connect to "' + task.streamUrl + '"', task.streamType);

                if (Restreamer.data.userActions[task.streamType] == 'stop') {
                    logger.debug('Skipping retry because "stop" has been clicked', task.streamType);
                    Restreamer.updateState(task.streamType, 'disconnected');
                    return;
                }

                Restreamer.startStream(task);
            }, task.restart_wait);
            task.restart_wait += 100;
        }

        // current number of processed frames for stale detection
        let nFrames = -1;

        // after adding outputs, define events on the new FFmpeg stream
        probePromise.then((options) => {
            let replace_video = {
                videoid: Restreamer.data.options.video.id,
                preset: Restreamer.data.options.video.preset,
                bitrate: Restreamer.data.options.video.bitrate,
                fps: Restreamer.data.options.video.fps,
                gop: (parseInt(Restreamer.data.options.video.fps) * 2) + '',
                profile: Restreamer.data.options.video.profile,
                tune: Restreamer.data.options.video.tune
            }

            for (let o in options.video) {
                if (o.length) Restreamer.addStreamOptions(command, options.video[o], replace_video);
            }

            let replace_audio = {
                audioid: Restreamer.data.options.audio.id,
                bitrate: Restreamer.data.options.audio.bitrate,
                channels: Restreamer.data.options.audio.channels,
                sampling: Restreamer.data.options.audio.sampling
            }

            for (let o in options.audio) {
                if (o.length) Restreamer.addStreamOptions(command, options.audio[o], replace_audio);
            }

            command
                .on('start', (commandLine) => {
                    task.reset();
                    Restreamer.data.processes[task.streamType] = command;

                    if (Restreamer.data.userActions[task.streamType] == 'stop') {
                        Restreamer.stopStream(task.streamType);
                        logger.debug('Skipping on "start" event of FFmpeg command because "stop" has been clicked', task.streamType);
                        return;
                    }

                    logger.debug('Spawned: ' + commandLine, task.streamType);
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
                        logger.debug('Skipping retry because "stop" has been clicked', task.streamType);
                        return;
                    }

                    logger.info(task.streamType + ': ended normally');
                    retry();
                })

                // stream error handler
                .on('error', (error, stdout, stderr) => {
                    Restreamer.data.processes[task.streamType] = null;

                    Restreamer.setTimeout(task.streamType, 'retry', null);
                    Restreamer.setTimeout(task.streamType, 'stale', null);

                    Restreamer.data.progresses[task.streamType].currentFps = 0;
                    Restreamer.data.progresses[task.streamType].currentKbps = 0;

                    if (Restreamer.data.userActions[task.streamType] == 'stop') {
                        Restreamer.updateState(task.streamType, 'disconnected');
                        logger.debug('Skipping retry since "stop" has been clicked', task.streamType);
                        return;
                    }

                    logger.error(error.message, task.streamType);
                    logger.error(error.toString(), task.streamType);
                    Restreamer.updateState(task.streamType, 'error', error.toString());
                    retry();
                })

                // progress handler
                .on('progress', (progress) => {
                    if (Restreamer.data.states[task.streamType].type == 'connecting') {
                        Restreamer.updateState(task.streamType, 'connected');
                    }

                    // compare the current number of frames
                    let nFramesChanged = false;
                    if (nFrames != progress.frames) {
                        nFrames = progress.frames;
                        nFramesChanged = true;
                    }

                    Restreamer.data.progresses[task.streamType] = progress;
                    Restreamer.updateProgressOnGui();

                    // add/reset a stale timeout if the number of frames changed
                    if (nFramesChanged === true) {
                        Restreamer.setTimeout(task.streamType, 'stale', () => {
                            logger.info('Stale connection', task.streamType);
                            Restreamer.stopStream(task.streamType);
                        }, config.ffmpeg.monitor.stale_wait);
                    }
                });

            // logger.info(command._getArguments());
            command.run();
        }).catch((error) => {
            logger.error('Failed to spawn ffmpeg: ' + error.toString(), task.streamType);

            if (Restreamer.data.userActions[task.streamType] == 'stop') {
                Restreamer.updateState(task.streamType, 'disconnected');
                logger.debug('Skipping retry since "stop" has been clicked', task.streamType);
                return;
            }

            Restreamer.updateState(task.streamType, 'error', error.toString());
            retry();
        });
    }

    /**
     * set a timeout
     * @param {string} streamType Either 'repeatToLocalNginx' or 'repeatToOptionalOutput'
     * @param {string} target Kind of timeout, either 'retry' or 'stale'
     * @param {function | null} func Callback function
     * @param {number | undefined} delay Delay for the timeout
     * @return {void}
     */
    static setTimeout(streamType, target, func, delay = undefined) {
        if (!(target in Restreamer.data.timeouts)) {
            logger.error('Unknown target for timeout', streamType);
            return;
        }

        if (!(streamType in Restreamer.data.timeouts[target])) {
            logger.error('Unknown stream type for timeout target "' + target + '"', streamType);
            return;
        }

        clearTimeout(Restreamer.data.timeouts[target][streamType]);

        if (typeof func == 'function') {
            Restreamer.data.timeouts[target][streamType] = setTimeout(func, delay);
        }
    }

    /**
     * bind websocket events on application start
     */
    static bindWebsocketEvents() {
        WebsocketsController.setConnectCallback((socket) => {

            socket.emit('publicIp', Restreamer.data.publicIp);

            socket.on('startStream', (options) => {
                // logger.debug('Got "startStream" event', options.streamType);
                Restreamer.updateUserAction(options.streamType, 'start');
                Restreamer.updateOptions(options.options);

                let streamUrl = '';
                if (options.streamType == 'repeatToLocalNginx') {
                    Restreamer.data.addresses.srcAddress = options.src;
                    streamUrl = options.src;
                }
                else if (options.streamType == 'repeatToOptionalOutput') {
                    Restreamer.data.addresses.optionalOutputAddress = options.optionalOutput;
                    streamUrl = options.optionalOutput;
                }
                else {
                    return;
                }

                Restreamer.startStream(new StrimingTask(streamUrl, options.streamType));
            });

            socket.on('stopStream', (streamType) => {
                // logger.debug('Got "stopStream" event', streamType);
                Restreamer.updateUserAction(streamType, 'stop');
                Restreamer.stopStream(streamType);
            });

            socket.on('checkStates', () => {
                // logger.debug('Got "checkStates" event');
                Restreamer.updateStreamDataOnGui()
            });

            socket.on('playerOptions', (player) => {
                // logger.debug('Got "playerOptions" event');
                Restreamer.updatePlayerOptions(player);
            })
        });
    }

    /**
     * creates an object of available streaming data like states and addresses to be able
     * to write it to filesystem
     * @returns {object}
     */
    static extractDataOfStreams() {
        return {
            'addresses': Restreamer.data.addresses,
            'options': Restreamer.data.options,
            'userActions': Restreamer.data.userActions,
            'states': Restreamer.data.states
        };
    }

    /**
     * create with only the data, that is needed by the jsonDb
     * @return {object}
     */
    static dataForJsonDb() {
        return {
            'addresses': Restreamer.data.addresses,
            'options': Restreamer.data.options,
            'userActions': Restreamer.data.userActions,
            'states': Restreamer.data.states
        };
    }

    /**
     * check for updates
     */
    static checkForUpdates() {
        logger.info('Update checking disabled, skip...');

        // const url = {'host': 'datarhei.com', 'path': '/apps.json'};
        // logger.debug('Checking for updates...', 'checkForUpdates');
        // https.get(url, (response) => {
        //     if (response.statusCode === 200) {
        //         response.on('data', (body) => {
        //             var updateCheck = JSON.parse(body);
        //             var updateAvailable = require('semver').lt(packageJson.version, updateCheck.restreamer.version);
        //             logger.info(`Update checking succeeded. ${updateAvailable ? 'Update' : 'No updates'} available`, 'checkForUpdates');
        //             logger.debug(`local: ${packageJson.version}; remote: ${updateCheck.restreamer.version}`, 'checkForUpdates');
        //             Restreamer.data.updateAvailable = updateAvailable;
        //             WebsocketsController.emit('update', updateAvailable);
        //         });
        //     } else {
        //         logger.warn(`Got ${String(response.statusCode)} status while trying to fetch update info`, 'checkForUpdates');
        //     }
        // }).on('error', () => {
        //     logger.warn('Failed fetching update info', 'checkForUpdates');
        // });
        // setTimeout(Restreamer.checkForUpdates, 12 * 3600 * 1000);
    }

    /**
     * get public ip
     */
    static getPublicIp() {
        logger.info('Retrieving public IP ...', 'publicIP');
        Restreamer.data.publicIp = '127.0.0.1';

        // publicIp().then(ip => {
        //     Restreamer.data.publicIp = ip;
        //     logger.info('Found public IP: ' + ip, 'publicIP');
        // }).catch(err => {
        //     logger.warn('Failed to get public IP', 'publicIP');
        //     Restreamer.data.publicIp = '127.0.0.1';
        // });
    }
}

const RsData = require("./RsData.js");
const Ffmpeg = require('fluent-ffmpeg');
Restreamer.data = new RsData();
module.exports = Restreamer;
