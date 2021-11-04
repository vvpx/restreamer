/**
 * @file holds the code for the class EnvVar
 * @link https://github.com/datarhei/restreamer
 * @copyright 2015 datarhei.org
 * @license Apache-2.0
 */

'use strict';

// import { readFile, existsSync, mkdirSync, writeFileSync } from 'fs';
// //import { readFile, existsSync, mkdirSync, writeFileSync } from 'fs/promises';
// import { defer, nfcall } from 'q';
// import { join } from 'path';
// import { Validator } from 'jsonschema';

const fs = require('fs');
const fsp = require('fs/promises');
const Q = require('q');
const path = require('path');
const Validator = require('jsonschema').Validator;

const logger = require('./Logger')('RestreamerData');

const dbPath = path.join(global.__base, 'db');
const dbFile = 'v1.json';

const confPath = path.join(global.__base, 'conf');
const schemaFile = 'jsondb_v1_schema.json';

// Update the defaults according to RS_AUDIO
function setDbAudio (dbdata) {
    var audioNode = dbdata.options.audio;

    switch(process.env.RS_AUDIO) {
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

    static checkJSONDb () {
        var schemadata = {};
        var dbdata = {};
        var deferred = Q.defer();
        //var readSchema = nfcall(readFile, join(confPath, schemaFile));
       // var readDBFile = nfcall(readFile, join(dbPath, dbFile));

        logger.info('Checking jsondb file...');

        //readSchema
        fsp.readFile(path.join(confPath, schemaFile))
            .then((s) => {
                schemadata = JSON.parse(s.toString('utf8'));
                return fsp.readFile(path.join(dbPath, dbFile)); // readDBFile;
            })
            .then((d) => {
                dbdata = JSON.parse(d.toString('utf8'));
                let v = new Validator();
                let instance = dbdata;
                let schema = schemadata;
                let validateResult = v.validate(instance, schema);

                if (validateResult.errors.length > 0) {
                    logger.debug(`Validation error of v1.db: ${JSON.stringify(validateResult.errors)}`);
                    throw new Error(JSON.stringify(validateResult.errors));
                } else {
                    logger.debug('"v1.db" is valid');

                    // Fill up optional fields if not present
                    if(!('video' in dbdata.options)) {
                        dbdata.options.video = {
                            codec: 'copy',
                            preset: 'ultrafast',
                            bitrate: '4096',
                            fps: '25',
                            profile: 'auto',
                            tune: 'none'
                        };
                    }

                    if(!('audio' in dbdata.options)) {
                        dbdata.options.audio = {
                            codec: 'auto',
                            preset: 'silence',
                            bitrate: '64',
                            channels: 'mono',
                            sampling: '44100'
                        };

                        // Update the defaults according to RS_AUDIO
                        setDbAudio(dbdata);
                    }

                    if(!('player' in dbdata.options)) {
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

                    if(!('output' in dbdata.options)) {
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

                    if(parseInt(dbdata.options.output.hls.timeout) > 2147) {
                        dbdata.options.output.hls.timeout = '10';
                    }

                    if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);
                    fs.writeFileSync(path.join(dbPath, dbFile), JSON.stringify(dbdata));

                    deferred.resolve();
                }
            })
            .catch((error) => {
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
                if(process.env.RS_INPUTSTREAM != '') {
                    defaultStructure.addresses.srcAddress = process.env.RS_INPUTSTREAM;
                    defaultStructure.states.repeatToLocalNginx.type = 'connected';
                    defaultStructure.userActions.repeatToLocalNginx = 'start';

                    // Set stream destination and start streaming on a fresh installation
                    if(process.env.RS_OUTPUTSTREAM != '') {
                        defaultStructure.addresses.optionalOutputAddress = process.env.RS_OUTPUTSTREAM;
                        defaultStructure.states.repeatToOptionalOutput.type = 'connected';
                        defaultStructure.userActions.repeatToOptionalOutput = 'start';
                    }
                }


                logger.debug(`Error reading "v1.db": ${error.toString()}`);

                if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath);
                fs.writeFileSync(path.join(dbPath, dbFile), JSON.stringify(defaultStructure));
                deferred.resolve();
            });

        return deferred.promise;
    }
}

module.exports = RestreamerData;
