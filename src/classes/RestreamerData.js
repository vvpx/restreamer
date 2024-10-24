'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Validator } = require('jsonschema');
const logger = require('./Logger')('RestreamerData');

if (require.main === module) {
    globalThis.__base = path.join(__dirname, '..', '..');
}

const dbPath = path.join(global.__base, 'db');
const dbFile = 'v1.json';

const confPath = path.join(globalThis.__base, 'conf');
const schemaFile = 'jsondb_v1_schema.json';
const defaulOutput = {
    type: 'rtmp',
    rtmp: {},
    hls: {
        method: 'POST',
        time: '2',
        listSize: '6',
        timeout: '10'
    }
};

/**
* Update the defaults according to RS_AUDIO
*/
function setDbAudio(dbdata) {
    const audioNode = dbdata.options.audio;

    switch (process.env.RS_AUDIO) {

        case 'auto':
            audioNode.codec = 'auto';
            break;

        case 'none':
            audioNode.codec = 'none';
            break;

        case 'silence':
            audioNode.codec = 'aac';
            audioNode.preset = 'silence';
            audioNode.bitrate = '8';
            audioNode.channels = 'mono';
            audioNode.sampling = '44100';
            break;

        case 'aac':
            audioNode.codec = 'aac';
            audioNode.preset = 'encode';
            audioNode.bitrate = '64';
            audioNode.channels = 'inherit';
            audioNode.sampling = 'inherit';
            break;

        case 'mp3':
            audioNode.codec = 'mp3';
            audioNode.preset = 'encode';
            audioNode.bitrate = '64';
            audioNode.channels = 'inherit';
            audioNode.sampling = 'inherit';
            break;

        default:
            break;
    }
}

class RestreamerData {

    static checkJSONDb() {
        return new Promise(this.__checkJSONDb);
    }

    static __checkJSONDb(resolve) {
        let schemadata = {};
        logger.info('Checking jsondb file...');

        //readSchema
        fsp.readFile(path.join(confPath, schemaFile))
            .then(s => {
                schemadata = JSON.parse(s.toString('utf8'));
                return fsp.readFile(path.join(dbPath, dbFile));
            })
            .then(d => {
                const dbdata = JSON.parse(d.toString('utf8'));
                const v = new Validator();
                const schema = schemadata;
                const validateResult = v.validate(dbdata, schema);

                if (validateResult.errors.length > 0) {
                    let errors = JSON.stringify(validateResult.errors);
                    logger.dbg?.(`Validation error of ${dbFile}: ${errors}`);
                    throw new Error(errors);
                } else {
                    // Fill up optional fields if not present
                    if (!('video' in dbdata.options)) {
                        dbdata.options.video = {
                            codec: 'copy',
                            preset: 'ultrafast',
                            bitrate: '4096',
                            fps: '25',
                            profile: 'auto',
                            tune: 'none'
                        };
                    }

                    if (!('audio' in dbdata.options)) {
                        dbdata.options.audio = {
                            codec: 'auto',
                            preset: 'silence',
                            bitrate: '64',
                            channels: 'mono',
                            sampling: '44100'
                        };

                        setDbAudio(dbdata);
                    }

                    if (!('player' in dbdata.options)) {
                        dbdata.options.player = {
                            autoplay: true,
                            mute: true,
                            statistics: false,
                            color: '#3daa48',
                            logo: {
                                image: '',
                                position: 'bottom-right',
                                link: ''
                            }
                        };
                    }

                    if (!('output' in dbdata.options)) {
                        dbdata.options.output = defaulOutput;
                    }

                    if (parseInt(dbdata.options.output.hls.timeout) > 2147) {
                        dbdata.options.output.hls.timeout = '10';
                    }

                    if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);
                    fs.writeFileSync(path.join(dbPath, dbFile), JSON.stringify(dbdata));
                    resolve();
                }
            })
            .catch(error => {
                logger.debug(`Error reading "${dbFile}": ${error.toString()}`);
                logger.info(`Create new "${dbFile}"`);

                let defaultStructure = {
                    addresses: {
                        srcAddress: '',
                        optionalOutputAddress: '',
                        srcStreams: {
                            audio: {},
                            video: {}
                        }
                    },
                    options: {
                        rtspTcp: true,
                        video: {
                            codec: 'copy',
                            preset: 'ultrafast',
                            bitrate: '4096',
                            fps: '25',
                            profile: 'auto',
                            tune: 'none'
                        },
                        audio: {
                            codec: 'none',
                            preset: 'silence',
                            bitrate: '64',
                            channels: 'mono',
                            sampling: '44100'
                        },
                        player: {
                            autoplay: true,
                            mute: true,
                            statistics: false,
                            color: '#3daa48',
                            logo: {
                                image: '',
                                position: 'bottom-right',
                                link: ''
                            }
                        },
                        output: defaulOutput
                    },
                    states: {
                        repeatToLocalNginx: {
                            type: 'stopped'
                        },
                        repeatToOptionalOutput: {
                            type: 'stopped'
                        }
                    },
                    userActions: {
                        repeatToLocalNginx: 'stop',
                        repeatToOptionalOutput: 'stop'
                    }
                }

                // Update the defaults according to RS_AUDIO
                setDbAudio(defaultStructure);

                // Set stream source and start streaming on a fresh installation
                if (process.env.RS_INPUTSTREAM) {
                    defaultStructure.addresses.srcAddress = process.env.RS_INPUTSTREAM;
                    defaultStructure.states.repeatToLocalNginx.type = 'connected';
                    defaultStructure.userActions.repeatToLocalNginx = 'start';

                    // Set stream destination and start streaming on a fresh installation
                    if (process.env.RS_OUTPUTSTREAM) {
                        defaultStructure.addresses.optionalOutputAddress = process.env.RS_OUTPUTSTREAM;
                        defaultStructure.states.repeatToOptionalOutput.type = 'connected';
                        defaultStructure.userActions.repeatToOptionalOutput = 'start';
                    }
                }

                if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);
                fs.writeFileSync(path.join(dbPath, dbFile), JSON.stringify(defaultStructure));
                resolve();
            });
    }
}

if (require.main === module) {
    RestreamerData.checkJSONDb()
        .then(() => { })
        .catch(e => {
            logger.err?.(e);
            process.exit(-1);
        })
}

module.exports = RestreamerData;
