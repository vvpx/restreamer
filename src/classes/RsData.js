// @ts-check
'use strict'

/**
 * Define data structure for Restreamer.data
 */
function RsData() {

    this.timeouts = {
        retry: {
            repeatToLocalNginx: null,
            repeatToOptionalOutput: null
        },
        stale: {
            repeatToLocalNginx: null,
            repeatToOptionalOutput: null
        },
        snapshot: {
            repeatToLocalNginx: null
        }
    }

    this.options = {
        rtspTcp: false,
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
            autoplay: false,
            mute: false,
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
    }

    this.states = {
        repeatToLocalNginx: {
            type: 'disconnected',
            message: ''
        },
        repeatToOptionalOutput: {
            type: 'disconnected',
            message: ''
        }
    }

    this.userActions = {
        repeatToLocalNginx: 'start',
        repeatToOptionalOutput: 'start'
    }

    this.processes = {
        repeatToLocalNginx: null,
        repeatToOptionalOutput: null
    }

    this.progresses = {
        repeatToLocalNginx: {
            frames: 0,
            currentFps: 0,
            currentKbps: 0
        },
        repeatToOptionalOutput: {}
    }

    this.addresses = {
        srcAddress: '',
        optionalOutputAddress: '',
        srcStreams: {
            audio: {},
            video: {}
        }
    }

    this.updateAvailable = false
    this.publicIp = '127.0.0.1'
}

module.exports = RsData;
