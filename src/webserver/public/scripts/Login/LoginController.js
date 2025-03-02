'use strict';

window.angular.module('Login').controller('loginController',
    ['$scope', '$http', '$rootScope', function loginController ($scope, $http, $rootScope) {
        $scope.submit = function submit () {
            $http.post('login', {'user': $scope.user, 'pass': $scope.pass}).then((response) => {
                $scope.message = response.data.message;
                $rootScope.loggedIn = response.data.success;
                $rootScope.token = response.data.auth;
            });
        };
    }]
);
