'use strict';

const transpiledPath = "transpiled";

const files = {
    //workaround to keep correct order
    transpiledFrontendJs: [
        `${transpiledPath}/webserver/public/scripts/App.js`,
        `${transpiledPath}/webserver/public/scripts/App.Config.js`,

        `${transpiledPath}/webserver/public/scripts/Main/MainModule.js`,
        `${transpiledPath}/webserver/public/scripts/Main/MainController.js`,

        `${transpiledPath}/webserver/public/scripts/Login/LoginModule.js`,
        `${transpiledPath}/webserver/public/scripts/Login/LoginController.js`,

        `${transpiledPath}/webserver/public/scripts/Header/HeaderModule.js`,
        `${transpiledPath}/webserver/public/scripts/Header/HeaderController.js`,
        `${transpiledPath}/webserver/public/scripts/Header/HeaderDirective.js`,

        `${transpiledPath}/webserver/public/scripts/Footer/FooterModule.js`,
        `${transpiledPath}/webserver/public/scripts/Footer/FooterController.js`,
        `${transpiledPath}/webserver/public/scripts/Footer/FooterDirective.js`,

        `${transpiledPath}/webserver/public/scripts/StreamingInterface/StreamingInterfaceModule.js`,
        `${transpiledPath}/webserver/public/scripts/StreamingInterface/StreamingStatusController.js`,
        `${transpiledPath}/webserver/public/scripts/StreamingInterface/StreamingStatusDirective.js`,

        `${transpiledPath}/webserver/public/scripts/Shared/LoggerService.js`,
        `${transpiledPath}/webserver/public/scripts/Shared/WebsocketsService.js`
    ],
    es6Src: [
        'webserver/public/scripts/**/*.js'
    ],
    stylesheets: ['src/webserver/public/css/*.css', '!src/webserver/public/css/restreamer.min.css']
};

module.exports = function (grunt) {

    // Project Configuration
    grunt.initConfig({

        /*
         Config for shell commands
         */
        shell: {
            start: {
                command: 'npm start'
            },
            removeTempTranspilingFolder: {
                command: `rm -Rf ${transpiledPath}`
            },
            createTempTranspilingFolder: {
                command: `mkdir ${transpiledPath}`
            },
            eslint: {
                command: 'eslint src/**.*js'
            },
            ffpatch: {
                // command: (js, append) => `diff -a -u ${js}.js ${js}_patched.js ${append ? '>>' : '>'}${process.cwd()}/ff.patch`,
                command: `diff -wa -u orig . >../../../contrib/ff.patch`,
                cwd: './node_modules/fluent-ffmpeg/lib',
                options: {
                    failOnError: false,
                    stderr: true
                }
            }
        },

        /*
         Config for Babel compiling
         */
        babel: {
            options: {
                sourceMap: true,
                presets: ['@babel/preset-env'],
                plugins: ['angularjs-annotate']
            },
            all: {
                files: [
                    {
                        expand: true,
                        cwd: 'src/',
                        src: '<%= es6Src %>',
                        dest: transpiledPath
                    }
                ]
            }
        },

        concat: {
            options: {
                sourceMap: true
            },
            js: {
                src: ['<%= transpiledFrontendJs %>'],
                dest: 'src/webserver/public/dist/application.js'
            }
        },

        /*
         Config for eslinter
         */
        eslint: {
            all: ['src/**/*.js'],
            options: {
                configFile: '.eslintrc.json'
            }
        },

        /*
         config for css linter
         */
        csslint: {
            options: {
                csslintrc: '.csslintrc'
            },
            all: {
                src: ['src/webserver/public/css/*.css']
            }
        },

        /*
         uglify and minify frontend javascript
         */
        uglify: {
            production: {
                options: {
                    mangle: true,
                    sourceMap: true
                },
                files: {
                    'src/webserver/public/dist/application.min.js': 'src/webserver/public/dist/application.js'
                }
            }
        },

        /*
         minify css files
         */
        cssmin: {
            combine: {
                files: {
                    'src/webserver/public/css/restreamer.min.css': '<%= stylesheets %>'
                }
            }
        },

        /*
         produces one file from all fontend javascript bewaring DI naming of angular
        ngAnnotate: {
            production: {
                files: {
                    'src/webserver/public/dist/application.js': '<%= transpiledFrontendJs %>'
                }
            }
        }
        */
    })

    /*
     Load NPM tasks
     */
    require('load-grunt-tasks')(grunt);
    
    grunt.task.registerTask('loadConfig', 'Task that loads the config into a grunt option.', function () {
        grunt.config.set('es6Src', files.es6Src);
        grunt.config.set('transpiledFrontendJs', files.transpiledFrontendJs);
        grunt.config.set('stylesheets', files.stylesheets);
    });

    grunt.loadNpmTasks('grunt-shell');
    grunt.loadNpmTasks('grunt-babel');
    grunt.loadNpmTasks('grunt-contrib-watch');

    // lint
    grunt.registerTask('lint', ['csslint', 'shell:eslint']);

    // clear old transpile folder and create new one
    grunt.registerTask('clearOldBuild', ['shell:removeTempTranspilingFolder', 'shell:createTempTranspilingFolder']);

    // minify the frontend files
    grunt.registerTask('minifyFrontendFiles', ['cssmin', 'concat', 'uglify']);

    /*
     Build Tasks
     */
    grunt.registerTask('build', ['loadConfig', 'clearOldBuild', 'babel', 'minifyFrontendFiles', 'shell:removeTempTranspilingFolder']);

    /*
     Just Compile
     */
    grunt.registerTask('compile', ['loadConfig', 'clearOldBuild', 'babel', 'minifyFrontendFiles']);

    // Run Tasks
    grunt.registerTask('run', ['shell:start']);

    /**patch fluent */
    grunt.registerTask('ffpatch', 'create fluent-ffmpeg patch', ['shell:ffpatch']); // ['shell:ffpatch:utils', 'shell:ffpatch:processor:true'])
}
