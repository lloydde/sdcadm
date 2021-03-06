/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var p = console.log;
var assert = require('assert-plus');
var child_process = require('child_process'),
    exec = child_process.exec,
    execFile = child_process.execFile;
var format = require('util').format;
var fs = require('fs');
var path = require('path');
var tty = require('tty');
var vasync = require('vasync');
var verror = require('verror');

var errors = require('./errors'),
    InternalError = errors.InternalError;
var vmadm = require('./vmadm');


//---- globals

var DEFAULTS_PATH = path.resolve(__dirname, '..', 'etc', 'defaults.json');
var CONFIG_PATH = '/var/sdcadm/sdcadm.conf';

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- exports

/**
 * Load sdcadm config.
 *
 * Dev Notes: We load from /usbkey/config to avoid needing SAPI up to run
 * sdcadm (b/c eventually sdcadm might drive bootstrapping SAPI). This *does*
 * unfortunately perpetuate the split-brain between /usbkey/config and
 * metadata on the SAPI 'sdc' application. This also does limit `sdcadm`
 * usage to the headnode GZ (which is fine for now).
 */
function loadConfig(options, cb) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.func(cb, 'cb');
    var log = options.log;

    var config = {};
    vasync.pipeline({funcs: [
        function loadDefaults(_, next) {
            log.trace({DEFAULTS_PATH: DEFAULTS_PATH}, 'load default config');
            fs.readFile(DEFAULTS_PATH, {encoding: 'utf8'},
                    function (err, data) {
                if (err) {
                    // TODO: InternalError
                    return next(err);
                }
                config = JSON.parse(data);  // presume no parse error
                next();
            });
        },
        function loadConfigPath(_, next) {
            fs.exists(CONFIG_PATH, function (exists) {
                if (!exists) {
                    return next();
                }
                log.trace({CONFIG_PATH: CONFIG_PATH}, 'load config file');
                fs.readFile(CONFIG_PATH, {encoding: 'utf8'},
                        function (err, data) {
                    if (err) {
                        // TODO: ConfigError
                        return next(err);
                    }
                    try {
                        config = objCopy(JSON.parse(data), config);
                    } catch (parseErr) {
                        // TODO: ConfigError
                        return next(parseErr);
                    }
                    next();
                });
            });
        },
        function loadSdcConfig(_, next) {
            var cmd = '/usr/bin/bash /lib/sdc/config.sh -json';
            log.trace({cmd: cmd}, 'load SDC config');
            exec(cmd, function (err, stdout, stderr) {
                if (err) {
                    return next(new InternalError({
                        message:
                            'could not load configuration from /usbkey/config',
                        cmd: cmd,
                        stderr: stderr,
                        cause: err
                    }));
                }
                var sdcConfig;
                try {
                    sdcConfig = JSON.parse(stdout);
                } catch (parseErr) {
                    return next(new InternalError({
                        message: 'unexpected /usbkey/config content',
                        cause: parseErr
                    }));
                }
                config.dns_domain = sdcConfig.dns_domain;
                config.datacenter_name = sdcConfig.datacenter_name;
                config.ufds_admin_uuid = sdcConfig.ufds_admin_uuid;

                // Calculated config.
                var dns = config.datacenter_name + '.' + config.dns_domain;
                config.papi = {
                    url: format('http://papi.%s', dns)
                };
                config.vmapi = {
                    url: format('http://vmapi.%s', dns)
                };
                config.sapi = {
                    url: format('http://sapi.%s', dns)
                };
                config.cnapi = {
                    url: format('http://cnapi.%s', dns)
                };
                config.imgapi = {
                    url: format('http://imgapi.%s', dns)
                };
                config.napi = {
                    url: format('http://napi.%s', dns)
                };
                config.wfapi = {
                    url: format('http://workflow.%s', dns)
                };
                config.ufds = {
                    url: format('ldaps://ufds.%s', dns),
                    bindDN: sdcConfig.ufds_ldap_root_dn,
                    bindPassword: sdcConfig.ufds_ldap_root_pw
                };

                var amqpInfo = sdcConfig.rabbitmq.split(':');
                config.amqp = {
                    login:    amqpInfo[0],
                    password: amqpInfo[1],
                    host:     sdcConfig.rabbitmq_domain,
                    port:     +amqpInfo[3]
                };

                next();
            });
        }
    ]}, function done(err) {
        if (err) {
            return cb(err);
        }
        cb(null, config);
    });
}


function objCopy(obj, target) {
    if (!target) {
        target = {};
    }
    Object.keys(obj).forEach(function (k) {
        target[k] = obj[k];
    });
    return target;
}


function deepObjCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}


function zeroPad(n, width) {
    var s = String(n);
    while (s.length < width) {
        s = '0' + s;
    }
    return s;
}


function cmp(a, b) {
    if (a > b) {
        return 1;
    } else if (a < b) {
        return -1;
    } else {
        return 0;
    }
}


/**
 * Prompt a user for a y/n answer.
 *
 *      cb('y')        user entered in the affirmative
 *      cb('n')        user entered in the negative
 *      cb(false)      user ^C'd
 */
function promptYesNo(opts_, cb) {
    assert.object(opts_, 'opts');
    assert.string(opts_.msg, 'opts.msg');
    assert.optionalString(opts_.default, 'opts.default');
    var opts = objCopy(opts_);

    // Setup stdout and stdin to talk to the controlling terminal if
    // process.stdout or process.stdin is not a TTY.
    var stdout;
    if (opts.stdout) {
        stdout = opts.stdout;
    } else if (process.stdout.isTTY) {
        stdout = process.stdout;
    } else {
        opts.stdout_fd = fs.openSync('/dev/tty', 'r+');
        stdout = opts.stdout = new tty.WriteStream(opts.stdout_fd);
    }
    var stdin;
    if (opts.stdin) {
        stdin = opts.stdin;
    } else if (process.stdin.isTTY) {
        stdin = process.stdin;
    } else {
        opts.stdin_fd = fs.openSync('/dev/tty', 'r+');
        stdin = opts.stdin = new tty.ReadStream(opts.stdin_fd);
    }

    stdout.write(opts.msg);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    var input = '';
    stdin.on('data', onData);

    function postInput() {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.write('\n');
        stdin.removeListener('data', onData);
    }

    function finish(rv) {
        if (opts.stdout_fd !== undefined) {
            stdout.end();
            delete opts.stdout_fd;
        }
        if (opts.stdin_fd !== undefined) {
            stdin.end();
            delete opts.stdin_fd;
        }
        cb(rv);
    }

    function onData(ch) {
        ch = ch + '';

        switch (ch) {
        case '\n':
        case '\r':
        case '\u0004':
            // They've finished typing their answer
            postInput();
            var answer = input.toLowerCase();
            if (answer === '' && opts.default) {
                finish(opts.default);
            } else if (answer === 'yes' || answer === 'y') {
                finish('y');
            } else if (answer === 'no' || answer === 'n') {
                finish('n');
            } else {
                stdout.write('Please enter "y", "yes", "n" or "no".\n');
                return promptYesNo(opts, cb);
            }
            break;
        case '\u0003':
            // Ctrl C
            postInput();
            finish(false);
            break;
        default:
            // More plaintext characters
            stdout.write(ch);
            input += ch;
            break;
        }
    }
}


/* TODO(trentm): drop in favour of one from tabula module */
function sortArrayOfObjects(items, fields) {
    function _cmp(a, b) {
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        var invert = false;
        if (field[0] === '-') {
            invert = true;
            field = field.slice(1);
        }
        assert.ok(field.length, 'zero-length sort field: ' + fields);
        var a_cmp = Number(a[field]);
        var b_cmp = Number(b[field]);
        if (isNaN(a_cmp) || isNaN(b_cmp)) {
            a_cmp = a[field];
            b_cmp = b[field];
        }
        // Comparing < or > to `undefined` with any value always returns false.
        if (a_cmp === undefined && b_cmp === undefined) {
            /* jsl:pass */
            // PEDRO: This shouldn't be here then, it's returning the next
            // block. Consider removing then.
        } else if (a_cmp === undefined) {
            return (invert ? 1 : -1);
        } else if (b_cmp === undefined) {
            return (invert ? -1 : 1);
        } else if (a_cmp < b_cmp) {
            return (invert ? 1 : -1);
        } else if (a_cmp > b_cmp) {
            return (invert ? -1 : 1);
        }
      }
      return 0;
    }
    items.sort(_cmp);
}


function indent(s, indentation) {
    if (!indentation) {
        indentation = '    ';
    }
    var lines = s.split(/\r?\n/g);
    return indentation + lines.join('\n' + indentation);
}


/**
 * A convenience wrapper around `child_process.execFile` to take away some
 * logging and error handling boilerplate.
 *
 * @param args {Object}
 *      - argv {Array} Required.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 * @param cb {Function} `function (err, stdout, stderr)` where `err` here is
 *      an `errors.InternalError` wrapper around the child_process error.
 *
 * TODO: support env or just exec opts in general.
 */
function execFilePlus(args, cb) {
    assert.object(args, 'args');
    assert.arrayOfString(args.argv, 'args.argv');
    assert.object(args.log, 'args.log');
    assert.func(cb);
    var argv = args.argv;

    args.log.trace({exec: true, argv: argv}, 'exec start');
    var execOpts = {};
    if (args.maxBuffer) {
        execOpts.maxBuffer = args.maxBuffer;
    }

    execFile(argv[0], argv.slice(1), execOpts, function (err, stdout, stderr) {
        args.log.trace({exec: true, argv: argv, err: err, stdout: stdout,
            stderr: stderr}, 'exec done');
        if (err) {
            var msg = format(
                'exec error:\n'
                + '\targv: %j\n'
                + '\texit status: %s\n'
                + '\tstdout:\n%s\n'
                + '\tstderr:\n%s',
                argv, err.code, stdout.trim(), stderr.trim());
            cb(new errors.InternalError({message: msg, cause: err}),
               stdout, stderr);
        } else {
            cb(null, stdout, stderr);
        }
    });
}


/**
 * Convenience wrapper around `child_process.exec`, mostly oriented to
 * run commands using pipes w/o having to deal with logging/error handling.
 *
 * @param args {Object}
 *      - cmd {String} Required. The command to run.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 *      - opts {Object} Optional. child_process.exec execution Options.
 * @param cb {Function} `function (err, stdout, stderr)` where `err` here is
 *      an `errors.InternalError` wrapper around the child_process error.
 */
function execPlus(args, cb) {
    assert.object(args, 'args');
    assert.string(args.cmd, 'args.cmd');
    assert.object(args.log, 'args.log');
    assert.optionalObject(args.opts, 'args.opts');
    assert.func(cb);

    var cmd = args.cmd;
    var execOpts = args.opts || {};
    var log = args.log;

    log.trace({exec: true, cmd: cmd}, 'exec start');
    exec(cmd, execOpts, function execPlusCb(err, stdout, stderr) {
        log.trace({exec: true, cmd: cmd, err: err, stdout: stdout,
            stderr: stderr}, 'exec done');
        if (err) {
            var msg = format(
                'exec error:\n'
                + '\tcmd: %s\n'
                + '\texit status: %s\n'
                + '\tstdout:\n%s\n'
                + '\tstderr:\n%s',
                cmd, err.code, stdout.trim(), stderr.trim());
            cb(new errors.InternalError({message: msg, cause: err}),
               stdout, stderr);
        } else {
            cb(null, stdout, stderr);
        }
    });

}


function getZoneIP(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    vmadm.vmGet(opts.uuid, {log: opts.log}, function (err, vm) {
        if (err) {
            return cb(err);
        }

        var ip = vm.nics.filter(function (n) {
            return (n.nic_tag === 'admin');
        })[0].ip;
        return cb(null, ip);
    });
}

function digDomain(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.domain, 'opts.domain');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    var argv = [
        '/usr/sbin/dig',
        opts.domain,
        '+short'
    ];

    execFilePlus({
        argv: argv,
        log: opts.log
    }, function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }

        var ips = stdout.trim().split('\n');
        return cb(null, ips);
    });
}


function waitUntilZoneInDNS(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.alias, 'opts.alias');
    assert.string(opts.domain, 'opts.domain');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    getZoneIP({
        uuid: opts.uuid,
        log: opts.log
    }, function (err, ip) {
        if (err) {
            return cb(err);
        }
        var counter = 0;
        var limit = 60;

        function _checkDNS() {
            digDomain({
                domain: opts.domain,
                log: opts.log
            }, function (err2, ips) {
                if (err2) {
                    return cb(err2);
                }

                if (ips.indexOf(ip) !== -1) {
                    return cb(null);
                }

                counter += 1;

                if (counter < limit) {
                    return setTimeout(_checkDNS, 5000);
                } else {
                    return cb(format(
                        'New %s ($uuid) zone\'s IP %s did not ' +
                        'enter DNS', opts.alias, ip));
                }
            });
        }

        return _checkDNS();
    });

}

function waitUntilZoneOutOfDNS(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.uuid, 'opts.uuid');
    assert.string(opts.alias, 'opts.alias');
    assert.string(opts.domain, 'opts.domain');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'cb');

    getZoneIP({
        uuid: opts.uuid,
        log: opts.log
    }, function (err, ip) {
        if (err) {
            return cb(err);
        }
        var counter = 0;
        var limit = 60;

        function _checkDNS() {
            digDomain({
                domain: opts.domain,
                log: opts.log
            }, function (err2, ips) {
                if (err2) {
                    return cb(err2);
                }

                if (ips.indexOf(ip) === -1) {
                    return cb(null);
                }

                counter += 1;

                if (counter < limit) {
                    return setTimeout(_checkDNS, 5000);
                } else {
                    return cb(format(
                        'New %s ($uuid) zone\'s IP %s did not ' +
                        'leave DNS', opts.alias, ip));
                }
            });
        }

        return _checkDNS();
    });
}


//---- exports

module.exports = {
    UUID_RE: UUID_RE,
    loadConfig: loadConfig,
    cmp: cmp,
    objCopy: objCopy,
    deepObjCopy: deepObjCopy,
    zeroPad: zeroPad,
    promptYesNo: promptYesNo,
    sortArrayOfObjects: sortArrayOfObjects,
    indent: indent,
    execFilePlus: execFilePlus,
    execPlus: execPlus,
    getZoneIP: getZoneIP,
    digDomain: digDomain,
    waitUntilZoneInDNS: waitUntilZoneInDNS,
    waitUntilZoneOutOfDNS: waitUntilZoneOutOfDNS
};
// vim: set softtabstop=4 shiftwidth=4:
