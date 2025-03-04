'use strict';

const auth = globalThis.appConfig.auth;
/**@import {Express} from "express*/

module.exports = /**@param {Express} app*/ (app) => {
    /* Handle Login POST */
    app.post('/login', (req, res, next) => {
        const username = process.env.RS_USERNAME || auth.username;
        const password = process.env.RS_PASSWORD || auth.password;
        let success = false;
        let message = '';

        if (req.body.user === username && req.body.pass === password) {
            req.session.authenticated = true;
            success = true;
        } else {
            message = 'login_invalid';
            req.session.destroy();
            success = false;
        }

        res.json({
            'success': success,
            'message': message,
            'auth': success ? req.sessionID : ''
        });
    });

    app.get('/authenticated', (req, res) => {
        let ans = req.session.authenticated === true;
        res.json({ result: ans, auth: (ans ? req.sessionID : '') });
    });

    app.get('/logout', (req, res) => {
        if (req.session.authenticated === true) {
            delete req.session.authenticated;
            req.session.destroy((_err) => {
                res.clearCookie('restreamer-session').end();
            });
            return;
        }
        res.end();
    });

    /* Handle NGINX-RTMP token */
    app.get('/token', (req, res) => {
        const token = process.env.RS_TOKEN || auth.token;
        if (token != '') {
            if (req.query.token == token) {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Authorized');
            } else {
                res.writeHead(401, { 'Content-Type': 'text/plain' });
                res.end('Unauthorized');
            }
        } else {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Authorized');
        }
    });
}
