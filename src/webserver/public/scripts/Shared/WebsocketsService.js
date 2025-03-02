/* eslint no-undef: 0*/
'use strict';

const WebsocketsService = function websocketsService ($rootScope, loggerService) {
    this.$rootScope = $rootScope;
    this.loggerService = loggerService;
    this.socket = null;

    $rootScope.$watch('loggedIn', (loggedIn) => {
        if (loggedIn) {
            // this.socket = io('/', { path: (window.location.pathname + '/socket.io').replace(/\/{2,}/g, "/"), auth: { token: $rootScope.token } });
            this.socket = io({ auth: { token: $rootScope.token } });
            this.loggerService.websocketsNamespace('WS connected');
        } else if (this.socket !== null) {
            this.socket.disconnect();
            this.loggerService.websocketsNamespace('WS disconnected');
        }
    });

    /**
     * emit an event to socket
     * @param event
     * @param data
     * @returns {websocketsService}
     */
    this.emit = (event, data) => {
        if (this.socket) {
            this.loggerService.websocketsOut(`emit event "${event}"`);
            this.socket.emit(event, data);
        }
        return this;
    };

    /**
     * react on an event to socket with callback
     * @param event
     * @param {function} callback
     * @returns {websocketsService}
     */
    this.on = (event, callback) => {
        var self = this;
        if (this.socket) {
            this.loggerService.websocketsIn(`got event "${event}"`);
            this.socket.on(event, function woEvent () {
                var args = arguments;
                self.$rootScope.$apply(function weApply () {
                    callback.apply(null, args);
                });
            });
        }
        return this;
    };

    /**
     * disable an event on socket
     * @param event
     * @param callback
     */
    this.off = (event, callback) => {
        if (this.socket) {
            this.socket.removeListener(event, callback);
        }
    };
};

// connect service to angular.js
window.angular.module('app').factory('ws', ['$rootScope', 'loggerService', ($rootScope, loggerService) => {
    return new WebsocketsService($rootScope, loggerService);
}]);
