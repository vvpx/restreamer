"use strict"

// express
const express = require("express")
const session = require("express-session")
const cookie = require("cookie")
const cookieParser = require("cookie-parser")
// const bodyParser = require("body-parser")
// const compression = require("compression")

// other
const path = require("path")
const crypto = require("crypto")

// modules
const logger = require("../classes/Logger")("Webserver")
const indexRouter = require("./controllers/index")
const apiV1 = require("./controllers/api/v1")

// middleware
// const expressLogger = require("./middleware/expressLogger");

// socket.io
const { Server } = require("socket.io")


/**Class for the ReStreamer webserver, powered by express.js*/
class RestreamerExpressApp {

    /**constructs a new express app with prod or dev config*/
    constructor() {
        this.v1 = new apiV1()
        this.app = express()
        this.secretKey = crypto.randomBytes(16).toString("hex")
        this.sessionKey = "restreamer-session"
        this.sessionStore = new session.MemoryStore()
        this.server

        if (process.env.RS_NODEJS_ENV === "dev") {
            this.initDev()
        } else {
            this.initProd()
        }
    }

    /**use sessions for the express app*/
    useSessions() {
        this.app.use(
            session({
                resave: false,
                saveUninitialized: false,
                key: this.sessionKey,
                secret: this.secretKey,
                unset: "destroy",
                store: this.sessionStore
            })
        )
    }

    /**add automatic parsers for the body*/
    addParsers() {
        this.app.use(express.json()) // bodyParser.json())
        this.app.use(cookieParser())
    }

    /**add content compression on responses*/
    addCompression() {
        // this.app.use(compression())
    }

    /**add express logger*/
    addExpressLogger() {
        // this.app.use("/", expressLogger)
    }

    /**beautify json response*/
    beautifyJSONResponse() {
        this.app.set("json spaces", 4)
    }

    /**add the restreamer routes*/
    addRoutes() {
        indexRouter(this.app)
        this.app.use("/v1", this.v1.router)
    }

    /**add 404 error handling on pages, that have not been found*/
    // add404ErrorHandling() {
    //     this.app.use((req, res, next) => {
    //         const err = new Error("Not Found " + req.url)
    //         err.status = 404
    //         next(err)
    //     })
    // }

    /**add ability for internal server errors*/
    // add500ErrorHandling() {
    //     this.app.use((err, req, res, next) => {
    //         logger.error(err)
    //         res.status(err.status || 500)
    //         res.send({
    //             message: err.message,
    //             error: {},
    //         });
    //     });
    // }

    /**enable websocket session validation*/
    secureSockets() {
        const val = (handshakeData, accept) => {
            if (handshakeData.headers.cookie) {
                this.sessionStore.get(
                    cookieParser.signedCookie(
                        cookie.parse(handshakeData.headers.cookie)[this.sessionKey],
                        this.secretKey
                    ),
                    (err, s) => {
                        if (!err && s && s.authenticated) {
                            return accept(null, true)
                        }
                    }
                )
            } else {
                return accept(null, false)
            }
        }

        this.app.get("io").use(function (socket, next) {
            val(socket.request, function (err, authorized) {
                if (err) return next(new Error(err))
                if (!authorized) return next(new Error("Not authorized"))
                next()
            })
        })
    }

    /**
     * start the webserver and open the websocket
     * @returns {promise}
     */
    startWebserver(dataSrc) {
        this.v1.setSrcData(dataSrc)
        logger.info("Starting ...")
        this.app.set("port", process.env.RS_NODEJS_PORT)

        return new Promise(resolve => {
            const server = this.server = this.app.listen(this.app.get("port"), '127.0.0.1', () => {
                this.app.set("io", new Server(server, { path: "/socket.io" }))
                this.secureSockets()
                this.app.set("server", server.address())
                logger.inf?.("Running on port " + process.env.RS_NODEJS_PORT)
                resolve()
            })
        })
    }

    /**stuff that have always to be added to the webapp*/
    initAlways() {
        this.useSessions()
        this.addParsers()
        this.addCompression()
        // this.addExpressLogger()
        this.beautifyJSONResponse()
        // this.createPromiseForWebsockets()
        this.addRoutes()
    }

    /**prod config for the express app*/
    initProd() {
        logger.debug("Init webserver with PROD environment")
        this.initAlways()
        this.app.get("/", (_req, res) => {
            res.sendFile(path.join(global.__public, "index.prod.html"))
        })

        // Internal error handling exist in express
        // this.add404ErrorHandling()
        // this.add500ErrorHandling()
    }

    /**dev config for the express app*/
    initDev() {
        logger.debug("Init webserver with DEV environment")
        this.initAlways()
        this.app.get("/", (req, res) => {
            res.sendFile(path.join(global.__public, "index.dev.html"))
        })

        // this.add404ErrorHandling()
        // this.add500ErrorHandling()
    }
}

const restreamerApp = new RestreamerExpressApp
module.exports = restreamerApp
