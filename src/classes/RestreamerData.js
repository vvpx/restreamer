/**
 * @file holds the code for the class EnvVar
 * @link https://github.com/datarhei/restreamer
 * @copyright 2015 datarhei.org
 * @license Apache-2.0
 */

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const Validator = require('jsonschema').Validator;

const logger = require('./Logger')('RestreamerData');

global.__base = global.__base ?? path.join(__dirname, '..', '..');
const dbPath = path.join(global.__base, 'db');
const dbFile = 'v1.json';

const confPath = path.join(global.__base, 'conf');
const schemaFile = 'jsondb_v1_schema.json';

/**
* Update the defaults according to RS_AUDIO
*/
function setDbAudio(dbdata) {
    var audioNode = dbdata.options.audio;

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

    static __checkJSONDb(resolve, _reject) {
        var schemadata = {};
        var dbdata = {};

        logger.info('Checking jsondb file...');

        //readSchema
        fsp.readFile(path.join(confPath, schemaFile))
            .then((s) => {
                schemadata = JSON.parse(s.toString('utf8'));
                return fsp.readFile(path.join(dbPath, dbFile));
            })
            .then((d) => {
                dbdata = JSON.parse(d.toString('utf8'));
                let v = new Validator();
                let schema = schemadata;
                let validateResult = v.validate(dbdata, schema);

                if (validateResult.errors.length > 0) {
                    logger.debug(`Validation error of v1.db: ${JSON.stringify(validateResult.errors)}`);
                    throw new Error(JSON.stringify(validateResult.errors));
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
                        dbdata.options.output = {
                            type: 'rtmp',
                            rtmp: {},
                            hls: {
                                method: 'POST',
                                time: '2',
                                listSize: '10',
                                timeout: '10'
                            }
                        };
                    }

                    if (parseInt(dbdata.options.output.hls.timeout) > 2147) {
                        dbdata.options.output.hls.timeout = '10';
                    }

                    if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);
                    fs.writeFileSync(path.join(dbPath, dbFile), JSON.stringify(dbdata));
                    resolve();
                }
            })
            .catch((error) => {
                logger.debug(`Error reading "v1.db": ${error.toString()}`);
                logger.info('create new "v1.db"');

                var defaultStructure = {
                    addresses: {
                        srcAddress: '',
                        optionalOutputAddress: ''
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
                            codec: 'auto',
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
                        output: {
                            type: 'rtmp',
                            rtmp: {},
                            hls: {
                                method: 'POST',
                                time: '2',
                                listSize: '10',
                                timeout: '10'
                            }
                        }
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
                };

                // Update the defaults according to RS_AUDIO
                setDbAudio(defaultStructure);

                // Set stream source and start streaming on a fresh installation
                if (process.env.RS_INPUTSTREAM != '') {
                    defaultStructure.addresses.srcAddress = process.env.RS_INPUTSTREAM;
                    defaultStructure.states.repeatToLocalNginx.type = 'connected';
                    defaultStructure.userActions.repeatToLocalNginx = 'start';

                    // Set stream destination and start streaming on a fresh installation
                    if (process.env.RS_OUTPUTSTREAM != '') {
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
        .then(() => process.exit(0))
}

module.exports = RestreamerData;
